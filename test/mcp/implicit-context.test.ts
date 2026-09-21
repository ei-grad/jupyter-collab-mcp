import { afterEach, describe, expect, it } from 'vitest';

import { randomUUID } from 'node:crypto';

import { createCollabService } from '../../src/service/index.js';
import type { CollabService } from '../../src/core/index.js';
import { jsonByteSize, toWire } from '../../src/mcp/index.js';
import type { NotebookHandle } from '../../src/service/index.js';
import { makeFakeHandle, makeFakeServer } from '../service/helpers.js';
import { connect, metaError, type Harness } from './harness.js';

const services: CollabService[] = [];
const connections: Harness[] = [];
afterEach(async () => {
  await Promise.all(connections.splice(0).map((connection) => connection.close()));
  await Promise.all(services.splice(0).map((service) => service.shutdown('client_request')));
});

async function rig(ids = ['one'], source?: Record<string, unknown>) {
  const servers = ids.map(() => makeFakeServer({ files: [{ path: 'a.ipynb', type: 'notebook' }] }));
  const handles: NotebookHandle[] = [];
  const service = createCollabService({ servers: ids.map((id, index) => ({
    id, kind: 'standalone', apiBaseUrl: `http://127.0.0.1:${9000 + index}`, credentialRef: 'literal:synthetic'
  })) }, {
    guardStdout: false,
    fetchImpl: (input, init) => {
      const url = new URL(String(input));
      return servers[Number(url.port) - 9000]!.fetchImpl(input, init);
    },
    openHandle: async (init) => {
      const handle = makeFakeHandle(init).handle;
      if (source !== undefined) handle.notebook.setSource(source as never);
      handles.push(handle);
      return handle;
    }
  });
  services.push(service);
  const connection = await connect({ service });
  connections.push(connection);
  return { service, connection, servers, handles };
}

describe('implicit MCP working context', () => {
  it('bootstraps without session tools and hides internal session ownership', async () => {
    const { connection } = await rig();
    const tools = (await connection.client.listTools()).tools;
    expect(tools.map((tool) => tool.name)).not.toContain('session_open');
    expect(tools.map((tool) => tool.name)).not.toContain('session_close');
    for (const tool of tools) expect(JSON.stringify(tool.inputSchema)).not.toContain('"session_id"');
    expect((await connection.call('server_list')).structuredContent?.['next_request_id']).toBe('1');
    const opened = await connection.call('notebook_open', { path: 'a.ipynb' });
    expect(opened.isError).not.toBe(true);
    const notebook = opened.structuredContent?.['notebook'] as Record<string, unknown>;
    expect(notebook).not.toHaveProperty('session_id');
    expect(notebook['lifetime']).toMatchObject({ released_by: ['notebook_close', 'connection_close', 'process_exit'] });
    expect((await connection.call('kernel_list')).isError).not.toBe(true);
    expect(metaError(await connection.call('notebook_create', {
      session_id: 'legacy-session', request_id: '1', directory: ''
    }))['code']).toBe('INVALID_ARGUMENT');
  });

  it('uses one sequence across servers, conflicts on changed server and replays exact retries', async () => {
    const { connection, servers } = await rig(['one', 'two']);
    const create = { server_id: 'one', request_id: '1', directory: '', name: 'new.ipynb' };
    const first = await connection.call('notebook_create', create);
    expect(first.isError).not.toBe(true);
    expect(first.structuredContent?.['next_request_id']).toBe('2');
    const retry = await connection.call('notebook_create', create);
    expect(retry.structuredContent).toMatchObject({ replayed: true, next_request_id: '2', notebook: first.structuredContent?.['notebook'] });
    const conflict = await connection.call('notebook_create', { ...create, server_id: 'two' });
    expect(metaError(conflict)).toMatchObject({ code: 'REQUEST_ID_CONFLICT', next_request_id: '2' });
    expect(servers.map((server) => server.untitledCounter)).toEqual([1, 0]);
    const second = await connection.call('notebook_create', { ...create, server_id: 'two', request_id: '2' });
    expect(second.structuredContent?.['next_request_id']).toBe('3');
    expect((await connection.call('server_list')).structuredContent?.['next_request_id']).toBe('3');
    expect((await connection.call('kernel_list', { server_id: 'one' })).structuredContent?.['next_request_id']).toBe('3');
    for (const result of [first, second]) {
      const notebook = result.structuredContent?.['notebook'] as Record<string, unknown>;
      await connection.call('notebook_close', { notebook_id: notebook['notebook_id'] });
    }
    expect((await connection.call('notebook_create', create)).structuredContent).toMatchObject({ replayed: true, next_request_id: '3' });
    expect(servers.map((server) => server.untitledCounter)).toEqual([1, 1]);
  });

  it('coalesces first calls and deduplicates simultaneous creation', async () => {
    const { connection, servers } = await rig();
    const args = { directory: '', name: 'race.ipynb', request_id: '1' };
    const [a, b] = await Promise.all([connection.call('notebook_create', args), connection.call('notebook_create', args)]);
    expect(a.isError).not.toBe(true);
    expect(b.isError).not.toBe(true);
    expect(a.structuredContent?.['notebook']).toEqual(b.structuredContent?.['notebook']);
    expect(servers[0]!.untitledCounter).toBe(1);
    expect(servers[0]!.calls.filter((call) => call === 'GET /api/status')).toHaveLength(1);
  });

  it('requires server selection and keeps handles bound to their server', async () => {
    const { connection } = await rig(['one', 'two']);
    expect(metaError(await connection.call('notebook_open', { path: 'a.ipynb' }))).toMatchObject({
      code: 'SERVER_SELECTION_REQUIRED', next_request_id: '1', request_accepted: false
    });
    const first = await connection.call('notebook_open', { server_id: 'one', path: 'a.ipynb' });
    const second = await connection.call('notebook_open', { server_id: 'two', path: 'a.ipynb' });
    const firstId = (first.structuredContent?.['notebook'] as Record<string, unknown>)['notebook_id'];
    const secondId = (second.structuredContent?.['notebook'] as Record<string, unknown>)['notebook_id'];
    expect(firstId).not.toBe(secondId);
    const reopened = await connection.call('notebook_open', { server_id: 'one', path: 'a.ipynb' });
    expect(reopened.structuredContent).toMatchObject({ reused: true, notebook: { notebook_id: firstId } });
    expect((await connection.call('notebook_read', { notebook_id: firstId, view: 'summary' })).isError).not.toBe(true);
    const other = await rig();
    expect(metaError(await other.connection.call('notebook_read', { notebook_id: firstId, view: 'summary' }))['code']).toBe('HANDLE_EXPIRED');
  });

  it('round-trips typed aliases without reusing a closed notebook reference', async () => {
    const { connection, handles } = await rig();
    const opened = await connection.call('notebook_open', { path: 'a.ipynb' });
    const notebook = opened.structuredContent?.['notebook'] as Record<string, unknown>;
    const summary = opened.structuredContent?.['summary'] as Record<string, unknown>;
    const notebookId = String(notebook['notebook_id']);
    const cell = (summary['cells'] as Record<string, unknown>[])[0]!;
    const cellId = String(cell['cell_id']);
    const revision = String(cell['source_revision']);

    expect(notebookId).toMatch(/^@[A-Za-z0-9_-]+\.[1-9a-z][0-9a-z]*\.n1$/u);
    expect(cellId).toMatch(/^@[A-Za-z0-9_-]+\.[1-9a-z][0-9a-z]*\.c1$/u);
    expect(revision).toMatch(/^@[A-Za-z0-9_-]+\.[1-9a-z][0-9a-z]*\.r1$/u);
    expect((await connection.call('notebook_read', {
      notebook_id: notebookId,
      view: 'cells',
      cell_ids: [cellId]
    })).isError).not.toBe(true);
    expect((await connection.call('notebook_read', {
      notebook_id: handles[0]!.notebookId,
      view: 'summary'
    })).isError).not.toBe(true);

    const applied = await connection.call('notebook_apply', {
      notebook_id: notebookId,
      request_id: '1',
      operations: [{
        op: 'replace_source',
        cell_id: cellId,
        expected_source_revision: revision,
        source: 'changed through aliases'
      }]
    });
    expect(applied.isError).not.toBe(true);
    expect(String(((applied.structuredContent?.['results'] as Record<string, unknown>[])[0]!)['source_revision'])).toMatch(
      /^@[A-Za-z0-9_-]+\.[1-9a-z][0-9a-z]*\.r[1-9][0-9]*$/u
    );

    await connection.call('notebook_close', { notebook_id: notebookId });
    const reopened = await connection.call('notebook_open', { path: 'a.ipynb' });
    expect((reopened.structuredContent?.['notebook'] as Record<string, unknown>)['notebook_id']).toMatch(
      /^@[A-Za-z0-9_-]+\.[1-9a-z][0-9a-z]*\.n2$/u
    );
    expect(metaError(await connection.call('notebook_read', {
      notebook_id: notebookId,
      view: 'summary'
    }))['code']).toBe('HANDLE_EXPIRED');
    expect(metaError(await connection.call('notebook_read', {
      notebook_id: handles[0]!.notebookId,
      view: 'summary'
    }))['code']).toBe('HANDLE_EXPIRED');
  });

  it('rejects a stale destructive alias from another populated connection', async () => {
    const { connection: first } = await rig();
    const { connection: second } = await rig();
    const firstOpen = await first.call('notebook_open', { path: 'a.ipynb' });
    const secondOpen = await second.call('notebook_open', { path: 'a.ipynb' });
    const firstId = String((firstOpen.structuredContent?.['notebook'] as Record<string, unknown>)['notebook_id']);
    const secondId = String((secondOpen.structuredContent?.['notebook'] as Record<string, unknown>)['notebook_id']);
    expect(firstId).not.toBe(secondId);

    expect((await first.call('notebook_close', { notebook_id: firstId })).isError).not.toBe(true);
    expect(metaError(await second.call('notebook_close', { notebook_id: firstId }))['code']).toBe('HANDLE_EXPIRED');
    expect((await second.call('notebook_read', {
      notebook_id: secondId,
      view: 'summary'
    })).isError).not.toBe(true);
  });

  it('addresses reserved-looking raw cell ids only through the literal grammar', async () => {
    const aliasLike = '@foreign.1.c1';
    const decodesToOtherId = 'raw:YQ';
    const malformedRaw = 'raw:not-base64!';
    const { connection } = await rig(['one'], {
      nbformat: 4,
      nbformat_minor: 5,
      metadata: {},
      cells: [
        { id: 'a', cell_type: 'code', source: 'same source', metadata: {}, outputs: [], execution_count: null },
        { id: decodesToOtherId, cell_type: 'code', source: 'same source', metadata: {}, outputs: [], execution_count: null },
        { id: malformedRaw, cell_type: 'code', source: 'malformed raw id', metadata: {}, outputs: [], execution_count: null },
        { id: aliasLike, cell_type: 'code', source: 'alias-like raw id', metadata: {}, outputs: [], execution_count: null }
      ]
    });
    const opened = await connection.call('notebook_open', { path: 'a.ipynb' });
    const notebookId = String((opened.structuredContent?.['notebook'] as Record<string, unknown>)['notebook_id']);
    const literal = `raw:${Buffer.from(aliasLike, 'utf8').toString('base64url')}`;
    const escapedDecodingId = `raw:${Buffer.from(decodesToOtherId, 'utf8').toString('base64url')}`;
    const escapedMalformedRaw = `raw:${Buffer.from(malformedRaw, 'utf8').toString('base64url')}`;

    const read = await connection.call('notebook_read', {
      notebook_id: notebookId,
      view: 'cells',
      cell_ids: [escapedDecodingId, escapedMalformedRaw, literal]
    });
    expect(read.isError).not.toBe(true);
    expect((read.structuredContent?.['cells'] as Record<string, unknown>[]).map((cell) => cell['source'])).toEqual([
      'same source',
      'malformed raw id',
      'alias-like raw id'
    ]);
    expect(metaError(await connection.call('notebook_read', {
      notebook_id: notebookId,
      view: 'cells',
      cell_ids: [aliasLike]
    }))['code']).toBe('HANDLE_EXPIRED');
    expect(metaError(await connection.call('notebook_read', {
      notebook_id: notebookId,
      view: 'cells',
      cell_ids: [decodesToOtherId]
    }))['code']).toBe('INVALID_ARGUMENT');
    expect(metaError(await connection.call('notebook_read', {
      notebook_id: notebookId,
      view: 'cells',
      cell_ids: [malformedRaw]
    }))['code']).toBe('INVALID_ARGUMENT');

    const sourceRevision = String((read.structuredContent?.['cells'] as Record<string, unknown>[])[0]!['source_revision']);
    expect((await connection.call('notebook_apply', {
      notebook_id: notebookId,
      request_id: '1',
      operations: [{
        op: 'replace_source',
        cell_id: escapedDecodingId,
        expected_source_revision: sourceRevision,
        source: 'changed raw-prefixed id'
      }]
    })).isError).not.toBe(true);
    const after = await connection.call('notebook_read', {
      notebook_id: notebookId,
      view: 'cells',
      cell_ids: [escapedDecodingId, 'a']
    });
    expect((after.structuredContent?.['cells'] as Record<string, unknown>[]).map((cell) => cell['source'])).toEqual([
      'changed raw-prefixed id',
      'same source'
    ]);
  });

  it('scopes cell and revision aliases to one notebook handle generation', async () => {
    const { connection } = await rig(['one'], {
      nbformat: 4,
      nbformat_minor: 5,
      metadata: {},
      cells: [{ id: 'durable-cell', cell_type: 'code', source: 'same source', metadata: {}, outputs: [], execution_count: null }]
    });
    const first = await connection.call('notebook_open', { path: 'a.ipynb' });
    const firstNotebookId = String((first.structuredContent?.['notebook'] as Record<string, unknown>)['notebook_id']);
    const firstCell = ((first.structuredContent?.['summary'] as Record<string, unknown>)['cells'] as Record<string, unknown>[])[0]!;
    const firstCellId = String(firstCell['cell_id']);
    const firstRevision = String(firstCell['source_revision']);
    await connection.call('notebook_close', { notebook_id: firstNotebookId });

    const reopened = await connection.call('notebook_open', { path: 'a.ipynb' });
    const reopenedNotebookId = String((reopened.structuredContent?.['notebook'] as Record<string, unknown>)['notebook_id']);
    const reopenedCell = ((reopened.structuredContent?.['summary'] as Record<string, unknown>)['cells'] as Record<string, unknown>[])[0]!;
    const reopenedCellId = String(reopenedCell['cell_id']);
    const reopenedRevision = String(reopenedCell['source_revision']);
    expect(reopenedCellId).not.toBe(firstCellId);
    expect(reopenedRevision).not.toBe(firstRevision);

    expect(metaError(await connection.call('notebook_read', {
      notebook_id: reopenedNotebookId,
      view: 'cells',
      cell_ids: [firstCellId]
    }))['code']).toBe('HANDLE_EXPIRED');
    expect(metaError(await connection.call('notebook_apply', {
      notebook_id: reopenedNotebookId,
      request_id: '1',
      operations: [{
        op: 'replace_source',
        cell_id: reopenedCellId,
        expected_source_revision: firstRevision,
        source: 'must not run'
      }]
    }))['code']).toBe('HANDLE_EXPIRED');

    const request = {
      notebook_id: reopenedNotebookId,
      request_id: '1',
      operations: [{
        op: 'replace_source',
        cell_id: reopenedCellId,
        expected_source_revision: reopenedRevision,
        source: 'valid replacement'
      }]
    };
    const applied = await connection.call('notebook_apply', request);
    expect(applied.isError).not.toBe(true);
    const replay = await connection.call('notebook_apply', request);
    expect(replay.isError).not.toBe(true);
    expect(replay.structuredContent).toMatchObject({ replayed: true, next_request_id: '2' });
  });

  it('losslessly pages adversarial source text within the MCP response budget', async () => {
    const source = `${'\\'.repeat(100_000)}\"\u0000\u0001\t\r\n${'界🙂'.repeat(2_000)}`;
    const { connection } = await rig(['one'], {
      nbformat: 4,
      nbformat_minor: 5,
      metadata: {},
      cells: [{ id: 'adversarial', cell_type: 'code', source, metadata: {}, outputs: [], execution_count: null }]
    });
    const opened = await connection.call('notebook_open', { path: 'a.ipynb' });
    const notebookId = String((opened.structuredContent?.['notebook'] as Record<string, unknown>)['notebook_id']);
    const cellId = String((((opened.structuredContent?.['summary'] as Record<string, unknown>)['cells'] as Record<string, unknown>[])[0]!)['cell_id']);
    const chunks: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await connection.call('notebook_read', {
        notebook_id: notebookId,
        view: 'cells',
        ...(cursor === undefined ? { cell_ids: [cellId] } : { cursor })
      });
      expect(page.isError).not.toBe(true);
      expect(jsonByteSize(page.structuredContent)).toBeLessThanOrEqual(64 * 1024);
      chunks.push(...(page.structuredContent?.['cells'] as Record<string, unknown>[]).map((cell) => String(cell['source'])));
      cursor = page.structuredContent?.['next_cursor'] as string | undefined;
    } while (cursor !== undefined);
    expect(chunks.join('')).toBe(source);
  });

  it('bounds and redacts a real invalid-revision error without losing recovery facts', async () => {
    const { connection } = await rig();
    const opened = await connection.call('notebook_open', { path: 'a.ipynb' });
    const notebookId = String((opened.structuredContent?.['notebook'] as Record<string, unknown>)['notebook_id']);
    const cellId = String((((opened.structuredContent?.['summary'] as Record<string, unknown>)['cells'] as Record<string, unknown>[])[0]!)['cell_id']);
    const invalidRevision = `s1_${'x'.repeat(50_000)}?token=should-redact&continuation=${'y'.repeat(50_000)}`;

    const answer = await connection.call('notebook_apply', {
      notebook_id: notebookId,
      request_id: '1',
      operations: [{
        op: 'replace_source',
        cell_id: cellId,
        expected_source_revision: invalidRevision,
        source: 'must not run'
      }]
    });
    const text = answer.content.find((block) => block.type === 'text')?.text ?? '';
    const error = metaError(answer);
    expect(answer.isError).toBe(true);
    expect(jsonByteSize(answer._meta)).toBeLessThanOrEqual(64 * 1024);
    expect(jsonByteSize(text)).toBeLessThanOrEqual(64 * 1024);
    expect(`${text}\n${JSON.stringify(error)}`).not.toContain('should-redact');
    expect(error).toMatchObject({
      code: 'INVALID_ARGUMENT',
      retryable: false,
      side_effects: 'none',
      next_request_id: '1',
      request_accepted: false
    });
    expect(text).toContain('next_request_id=1');
    expect(text).toContain('request_accepted=false');
  });

  it('reduces a 100-cell UUID-and-revision summary without changing identities', async () => {
    const { service, connection, handles } = await rig();
    const opened = await connection.call('notebook_open', { path: 'a.ipynb' });
    const notebookId = String((opened.structuredContent?.['notebook'] as Record<string, unknown>)['notebook_id']);
    handles[0]!.notebook.setSource({
      nbformat: 4,
      nbformat_minor: 5,
      metadata: {},
      cells: Array.from({ length: 100 }, (_unused, index) => ({
        id: randomUUID(),
        cell_type: 'code',
        source: `x_${String(index)} = ${String(index)}`,
        metadata: {},
        outputs: [],
        execution_count: null
      }))
    } as never);

    const compact = await connection.call('notebook_read', { notebook_id: notebookId, view: 'summary' });
    const full = await service.notebookRead({ notebookId: handles[0]!.notebookId, view: 'summary' });
    const compactSummary = compact.structuredContent?.['summary'] as Record<string, unknown>;
    const compactCells = compactSummary['cells'] as Record<string, unknown>[];
    const fullCells = ((toWire(full) as Record<string, unknown>)['summary'] as Record<string, unknown>)['cells'] as Record<string, unknown>[];

    expect(fullCells).toHaveLength(100);
    expect(fullCells.every((cell) => String(cell['cell_id']).length === 36)).toBe(true);
    expect(fullCells.every((cell) => String(cell['source_revision']).length === 46 && String(cell['cell_revision']).length === 46 && String(cell['outputs_revision']).length === 46)).toBe(true);
    expect(compactCells.every((cell) => /^@[A-Za-z0-9_-]+\.[1-9a-z][0-9a-z]*\.c[1-9][0-9]*$/u.test(String(cell['cell_id'])))).toBe(true);
    expect(compactCells.every((cell) => /^@[A-Za-z0-9_-]+\.[1-9a-z][0-9a-z]*\.r[1-9][0-9]*$/u.test(String(cell['source_revision'])))).toBe(true);
    expect(jsonByteSize(compact.structuredContent)).toBeLessThan(jsonByteSize(toWire(full)));
  });

  it('retries failed initialization without replacing a live context', async () => {
    const server = makeFakeServer();
    let statusCalls = 0;
    const service = createCollabService({ servers: [{ id: 'one', kind: 'standalone', apiBaseUrl: 'http://127.0.0.1:9000', credentialRef: 'literal:synthetic' }] }, {
      guardStdout: false,
      fetchImpl: (input, init) => {
        if (String(input).endsWith('/api/status') && statusCalls++ === 0) return Promise.resolve(new Response('', { status: 503 }));
        return server.fetchImpl(input, init);
      }
    });
    services.push(service);
    await expect(service.notebookList({ directory: '' })).rejects.toMatchObject({ details: { next_request_id: '1' } });
    expect((await service.notebookList({ directory: '' })).nextRequestId).toBe('1');
    expect(statusCalls).toBe(2);
    await service.notebookList({ directory: '' });
    expect(statusCalls).toBe(2);
  });

  it('does not resurrect a context when shutdown races its first server request', async () => {
    const server = makeFakeServer();
    let entered!: () => void;
    let release!: () => void;
    const reached = new Promise<void>((resolve) => { entered = resolve; });
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const service = createCollabService({ servers: [{ id: 'one', kind: 'standalone', apiBaseUrl: 'http://127.0.0.1:9000', credentialRef: 'literal:synthetic' }] }, {
      guardStdout: false,
      fetchImpl: async (input, init) => {
        if (String(input).endsWith('/api/status')) { entered(); await blocked; }
        return server.fetchImpl(input, init);
      }
    });
    services.push(service);
    const pending = service.notebookList({ directory: '' });
    await reached;
    await service.shutdown('client_request');
    const rejected = expect(pending).rejects.toMatchObject({ code: 'HANDLE_EXPIRED' });
    release();
    await rejected;
    expect(server.calls).toEqual(['GET /api/status']);
  });

  it('rejects a cross-server create queued behind an in-flight create after shutdown', async () => {
    const servers = [makeFakeServer(), makeFakeServer()];
    let entered!: () => void;
    let release!: () => void;
    const reached = new Promise<void>((resolve) => { entered = resolve; });
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const service = createCollabService({ servers: ['one', 'two'].map((id, index) => ({
      id, kind: 'standalone', apiBaseUrl: `http://127.0.0.1:${9000 + index}`, credentialRef: 'literal:synthetic'
    })) }, {
      guardStdout: false,
      fetchImpl: async (input, init) => {
        const url = new URL(String(input));
        if (url.port === '9000' && init?.method === 'POST') { entered(); await blocked; }
        return servers[Number(url.port) - 9000]!.fetchImpl(input, init);
      },
      openHandle: async (init) => makeFakeHandle(init).handle
    });
    services.push(service);
    await service.notebookList({ serverId: 'two', directory: '' });
    const first = service.notebookCreate({ serverId: 'one', directory: '', requestId: '1' });
    const firstRejected = expect(first).rejects.toMatchObject({ code: 'HANDLE_EXPIRED' });
    await reached;
    const queued = service.notebookCreate({ serverId: 'two', directory: '', name: 'must-not-exist.ipynb', requestId: '2' });
    const queuedRejected = expect(queued).rejects.toMatchObject({
      code: 'HANDLE_EXPIRED', details: { request_accepted: false }
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    await service.shutdown('client_request');
    release();
    await Promise.all([firstRejected, queuedRejected]);
    expect(servers[1]!.calls.every((call) => !/^(POST|PATCH) /u.test(call))).toBe(true);
    expect(servers[1]!.files.size).toBe(0);
  });
});
