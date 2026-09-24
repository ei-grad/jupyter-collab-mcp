import { afterEach, describe, expect, it } from 'vitest';

import { randomUUID } from 'node:crypto';

import { createCollabService } from '../../src/service/index.js';
import type { CollabService } from '../../src/core/index.js';
import { jsonByteSize, toWire, type McpServerOptions } from '../../src/mcp/index.js';
import type { NotebookHandle } from '../../src/service/index.js';
import { makeFakeHandle, makeFakeServer } from '../service/helpers.js';
import { connect, metaError, type Harness } from './harness.js';

const services: CollabService[] = [];
const connections: Harness[] = [];
afterEach(async () => {
  await Promise.all(connections.splice(0).map((connection) => connection.close()));
  await Promise.all(services.splice(0).map((service) => service.shutdown('client_request')));
});

async function rig(ids = ['one'], source?: Record<string, unknown>, server?: McpServerOptions) {
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
  const connection = await connect({ service, ...(server === undefined ? {} : { server }) });
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

  it('round-trips observed refs without reusing a closed notebook reference', async () => {
    const { connection, handles } = await rig();
    const opened = await connection.call('notebook_open', { path: 'a.ipynb' });
    const notebook = opened.structuredContent?.['notebook'] as Record<string, unknown>;
    const summary = opened.structuredContent?.['summary'] as Record<string, unknown>;
    const notebookId = String(notebook['notebook_id']);
    const cell = (summary['cells'] as Record<string, unknown>[])[0]!;
    const cellRef = String(cell['cell_ref']);

    expect(notebookId).toMatch(/^@[A-Za-z0-9_-]+\.[1-9a-z][0-9a-z]*\.n1$/u);
    expect(cellRef).toMatch(/^@/u);
    expect(cell).not.toHaveProperty('cell_id');
    expect(cell).not.toHaveProperty('source_revision');
    expect(cell).not.toHaveProperty('cell_revision');
    expect(cell).not.toHaveProperty('outputs_revision');
    expect((await connection.call('notebook_read', {
      notebook_id: notebookId,
      view: 'cells',
      cell_refs: [cellRef]
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
        cell_ref: cellRef,
        source: 'changed through aliases'
      }]
    });
    expect(applied.isError).not.toBe(true);
    const changedRef = String(((applied.structuredContent?.['results'] as Record<string, unknown>[])[0]!)['cell_ref']);
    expect(changedRef).toMatch(/^@/u);
    expect(changedRef).not.toBe(cellRef);
    expect((await connection.call('notebook_read', {
      notebook_id: notebookId,
      view: 'cells',
      cell_refs: [changedRef]
    })).isError).not.toBe(true);

    await connection.call('notebook_close', { notebook_id: notebookId });
    const reopened = await connection.call('notebook_open', { path: 'a.ipynb' });
    const reopenedCellRef = String((((reopened.structuredContent?.['summary'] as Record<string, unknown>)['cells'] as Record<string, unknown>[])[0]!)['cell_ref']);
    expect((reopened.structuredContent?.['notebook'] as Record<string, unknown>)['notebook_id']).toMatch(
      /^@[A-Za-z0-9_-]+\.[1-9a-z][0-9a-z]*\.n2$/u
    );
    expect(reopenedCellRef).not.toBe(changedRef);
    expect(metaError(await connection.call('notebook_read', {
      notebook_id: notebookId,
      view: 'summary'
    }))['code']).toBe('HANDLE_EXPIRED');
    expect(metaError(await connection.call('notebook_read', {
      notebook_id: handles[0]!.notebookId,
      view: 'summary'
    }))['code']).toBe('HANDLE_EXPIRED');
    expect(metaError(await connection.call('notebook_read', {
      notebook_id: (reopened.structuredContent?.['notebook'] as Record<string, unknown>)['notebook_id'],
      view: 'cells',
      cell_refs: [changedRef]
    }))['code']).toBe('HANDLE_EXPIRED');
  });

  it('rejects a stale destructive alias from another populated connection', async () => {
    const { connection: first } = await rig();
    const { connection: second } = await rig();
    const firstOpen = await first.call('notebook_open', { path: 'a.ipynb' });
    const secondOpen = await second.call('notebook_open', { path: 'a.ipynb' });
    const firstId = String((firstOpen.structuredContent?.['notebook'] as Record<string, unknown>)['notebook_id']);
    const secondId = String((secondOpen.structuredContent?.['notebook'] as Record<string, unknown>)['notebook_id']);
    const firstCellRef = String((((firstOpen.structuredContent?.['summary'] as Record<string, unknown>)['cells'] as Record<string, unknown>[])[0]!)['cell_ref']);
    expect(firstId).not.toBe(secondId);

    expect((await first.call('notebook_close', { notebook_id: firstId })).isError).not.toBe(true);
    expect(metaError(await second.call('notebook_close', { notebook_id: firstId }))['code']).toBe('HANDLE_EXPIRED');
    expect((await second.call('notebook_read', {
      notebook_id: secondId,
      view: 'summary'
    })).isError).not.toBe(true);
    expect(metaError(await second.call('notebook_apply', {
      notebook_id: secondId,
      request_id: '1',
      operations: [{ op: 'replace_source', cell_ref: firstCellRef, source: 'must not cross contexts' }]
    }))['code']).toBe('HANDLE_EXPIRED');
  });

  it('hides reserved-looking durable ids behind issued observed refs', async () => {
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
    const refs = ((opened.structuredContent?.['summary'] as Record<string, unknown>)['cells'] as Record<string, unknown>[])
      .map((cell) => String(cell['cell_ref']));
    expect(new Set(refs).size).toBe(4);

    const read = await connection.call('notebook_read', {
      notebook_id: notebookId,
      view: 'cells',
      cell_refs: [refs[1], refs[2], refs[3]]
    });
    expect(read.isError).not.toBe(true);
    expect((read.structuredContent?.['cells'] as Record<string, unknown>[]).map((cell) => cell['source'])).toEqual([
      'same source',
      'malformed raw id',
      'alias-like raw id'
    ]);
    for (const unissued of [aliasLike, decodesToOtherId, malformedRaw]) {
      expect(metaError(await connection.call('notebook_read', {
        notebook_id: notebookId,
        view: 'cells',
        cell_refs: [unissued]
      }))['code']).toBe('HANDLE_EXPIRED');
    }
    for (const invalidLiteral of ['raw:YQ', 'raw:_w', 'raw:QP8']) {
      expect(metaError(await connection.call('notebook_read', {
        notebook_id: invalidLiteral,
        view: 'summary'
      }))['code']).toBe('INVALID_ARGUMENT');
    }

    const applied = await connection.call('notebook_apply', {
      notebook_id: notebookId,
      request_id: '1',
      operations: [{
        op: 'replace_source',
        cell_ref: refs[1],
        source: 'changed raw-prefixed id'
      }]
    });
    expect(applied.isError).not.toBe(true);
    const changedRef = String(((applied.structuredContent?.['results'] as Record<string, unknown>[])[0]!)['cell_ref']);
    const after = await connection.call('notebook_read', {
      notebook_id: notebookId,
      view: 'cells',
      cell_refs: [changedRef, refs[0]]
    });
    expect((after.structuredContent?.['cells'] as Record<string, unknown>[]).map((cell) => cell['source'])).toEqual([
      'changed raw-prefixed id',
      'same source'
    ]);
  });

  it('scopes observed refs to one notebook handle generation', async () => {
    const { connection } = await rig(['one'], {
      nbformat: 4,
      nbformat_minor: 5,
      metadata: {},
      cells: [{ id: 'durable-cell', cell_type: 'code', source: 'same source', metadata: {}, outputs: [], execution_count: null }]
    });
    const first = await connection.call('notebook_open', { path: 'a.ipynb' });
    const firstNotebookId = String((first.structuredContent?.['notebook'] as Record<string, unknown>)['notebook_id']);
    const firstCell = ((first.structuredContent?.['summary'] as Record<string, unknown>)['cells'] as Record<string, unknown>[])[0]!;
    const firstRef = String(firstCell['cell_ref']);
    await connection.call('notebook_close', { notebook_id: firstNotebookId });

    const reopened = await connection.call('notebook_open', { path: 'a.ipynb' });
    const reopenedNotebookId = String((reopened.structuredContent?.['notebook'] as Record<string, unknown>)['notebook_id']);
    const reopenedCell = ((reopened.structuredContent?.['summary'] as Record<string, unknown>)['cells'] as Record<string, unknown>[])[0]!;
    const reopenedRef = String(reopenedCell['cell_ref']);
    expect(reopenedRef).not.toBe(firstRef);

    expect(metaError(await connection.call('notebook_read', {
      notebook_id: reopenedNotebookId,
      view: 'cells',
      cell_refs: [firstRef]
    }))['code']).toBe('HANDLE_EXPIRED');
    expect(metaError(await connection.call('notebook_apply', {
      notebook_id: reopenedNotebookId,
      request_id: '1',
      operations: [{
        op: 'replace_source',
        cell_ref: firstRef,
        source: 'must not run'
      }]
    }))['code']).toBe('HANDLE_EXPIRED');

    const request = {
      notebook_id: reopenedNotebookId,
      request_id: '1',
      operations: [{
        op: 'replace_source',
        cell_ref: reopenedRef,
        source: 'valid replacement'
      }]
    };
    const applied = await connection.call('notebook_apply', request);
    expect(applied.isError).not.toBe(true);
    const replay = await connection.call('notebook_apply', request);
    expect(replay.isError).not.toBe(true);
    expect(replay.structuredContent).toMatchObject({ replayed: true, next_request_id: '2' });
  });

  it('uses the operation-specific guard recorded in one observed ref', async () => {
    const { connection, handles } = await rig();
    const opened = await connection.call('notebook_open', { path: 'a.ipynb' });
    const notebookId = String((opened.structuredContent?.['notebook'] as Record<string, unknown>)['notebook_id']);
    const observed = String((((opened.structuredContent?.['summary'] as Record<string, unknown>)['cells'] as Record<string, unknown>[])[0]!)['cell_ref']);
    const cell = handles[0]!.notebook.getCell(0) as unknown as {
      setOutputs(outputs: unknown[]): void;
    };
    cell.setOutputs([{ output_type: 'stream', name: 'stdout', text: 'remote output' }]);

    const sourceEdit = await connection.call('notebook_apply', {
      notebook_id: notebookId,
      request_id: '1',
      operations: [{ op: 'replace_source', cell_ref: observed, source: 'source guard ignores output-only change' }]
    });
    expect(sourceEdit.isError).not.toBe(true);
    const currentRef = String(((sourceEdit.structuredContent?.['results'] as Record<string, unknown>[])[0]!)['cell_ref']);
    expect(currentRef).not.toBe(observed);

    const staleFullCell = await connection.call('notebook_apply', {
      notebook_id: notebookId,
      request_id: '2',
      operations: [{ op: 'set_cell_metadata', cell_ref: observed, key: 'probe', value: true }]
    });
    const conflict = metaError(staleFullCell);
    expect(conflict).toMatchObject({
      code: 'REVISION_CONFLICT',
      next_request_id: '2',
      request_accepted: false,
      current_cell_ref: currentRef
    });
    expect((conflict['details'] as Record<string, unknown>)['preview']).toBeTypeOf('string');
    expect(conflict['details']).not.toHaveProperty('expected');
    expect(conflict['details']).not.toHaveProperty('current');
    const text = staleFullCell.content.find((block) => block.type === 'text')?.text ?? '';
    expect(text).toContain(`current_cell_ref=${currentRef}`);
    expect(text).not.toMatch(/"(?:expected|current)":/u);
  });

  it('keeps strict same-ref batch conflicts recoverable without exposing revision hashes', async () => {
    const { connection, handles } = await rig();
    const opened = await connection.call('notebook_open', { path: 'a.ipynb' });
    const notebookId = String((opened.structuredContent?.['notebook'] as Record<string, unknown>)['notebook_id']);
    const observed = String((((opened.structuredContent?.['summary'] as Record<string, unknown>)['cells'] as Record<string, unknown>[])[0]!)['cell_ref']);
    const original = handles[0]!.notebook.getCell(0).getSource();
    const attempted = 'first simulated replacement';

    const answer = await connection.call('notebook_apply', {
      notebook_id: notebookId,
      request_id: '1',
      operations: [
        { op: 'replace_source', cell_ref: observed, source: attempted },
        { op: 'replace_source', cell_ref: observed, source: 'must not apply' }
      ]
    });
    const conflict = metaError(answer);
    expect(conflict).toMatchObject({
      code: 'REVISION_CONFLICT',
      message: `cell_ref "${observed}" was invalidated by an earlier operation in this batch`,
      next_request_id: '1',
      request_accepted: false,
      current_cell_ref: observed,
      details: { preview: attempted }
    });
    expect(conflict['details']).not.toHaveProperty('expected');
    expect(conflict['details']).not.toHaveProperty('current');
    const text = answer.content.find((block) => block.type === 'text')?.text ?? '';
    expect(text).toContain(`cell_ref "${observed}" was invalidated by an earlier operation in this batch`);
    expect(text).toContain(`current_cell_ref=${observed}`);
    expect(text).toContain(attempted);
    expect(text).not.toMatch(/"(?:expected|current)":/u);
    expect(handles[0]!.notebook.getCell(0).getSource()).toBe(original);
  });

  it('lets a source-only change keep the observed outputs guard usable', async () => {
    const { connection, handles } = await rig();
    const opened = await connection.call('notebook_open', { path: 'a.ipynb' });
    const notebookId = String((opened.structuredContent?.['notebook'] as Record<string, unknown>)['notebook_id']);
    const observed = String((((opened.structuredContent?.['summary'] as Record<string, unknown>)['cells'] as Record<string, unknown>[])[0]!)['cell_ref']);
    const cell = handles[0]!.notebook.getCell(0) as unknown as { setSource(source: string): void };
    cell.setSource('remote source change');

    const cleared = await connection.call('notebook_apply', {
      notebook_id: notebookId,
      request_id: '1',
      operations: [{ op: 'clear_outputs', cell_ref: observed }]
    });
    expect(cleared.isError).not.toBe(true);
    expect(String(((cleared.structuredContent?.['results'] as Record<string, unknown>[])[0]!)['cell_ref'])).not.toBe(observed);

    const staleSource = await connection.call('notebook_execute', {
      notebook_id: notebookId,
      request_id: '2',
      cells: [{ cell_ref: observed }]
    });
    const conflict = metaError(staleSource);
    expect(conflict).toMatchObject({
      code: 'REVISION_CONFLICT',
      message: `cell_ref "${observed}" is stale because the cell changed since it was read`,
      next_request_id: '2',
      request_accepted: false,
      current_cell_ref: expect.stringMatching(/^@/u)
    });
    expect(conflict['current_cell_ref']).not.toBe(observed);
    const text = staleSource.content.find((block) => block.type === 'text')?.text ?? '';
    expect(`${JSON.stringify(conflict)}\n${text}`).not.toContain('cell one');
  });

  it('refreshes a stale live ref on read and guards notebook metadata with notebook_ref', async () => {
    const { connection, handles } = await rig();
    const opened = await connection.call('notebook_open', { path: 'a.ipynb' });
    const notebookId = String((opened.structuredContent?.['notebook'] as Record<string, unknown>)['notebook_id']);
    const initial = await connection.call('notebook_read', { notebook_id: notebookId, view: 'cells' });
    const observed = String((initial.structuredContent?.['cells'] as Record<string, unknown>[])[0]!['cell_ref']);
    const notebookRef = String(initial.structuredContent?.['notebook_ref']);
    const cell = handles[0]!.notebook.getCell(0) as unknown as { setSource(source: string): void };
    cell.setSource('changed after observation');
    handles[0]!.notebook.setMetadata('remote', true);

    const refreshed = await connection.call('notebook_read', {
      notebook_id: notebookId,
      view: 'cells',
      cell_refs: [observed]
    });
    expect(refreshed.isError).not.toBe(true);
    const refreshedRef = String((refreshed.structuredContent?.['cells'] as Record<string, unknown>[])[0]!['cell_ref']);
    expect(refreshedRef).not.toBe(observed);
    expect(refreshed.structuredContent?.['notebook_ref']).not.toBe(notebookRef);

    const staleMetadata = await connection.call('notebook_apply', {
      notebook_id: notebookId,
      request_id: '1',
      operations: [{ op: 'set_notebook_metadata', notebook_ref: notebookRef, key: 'agent', value: true }]
    });
    expect(metaError(staleMetadata)).toMatchObject({
      code: 'REVISION_CONFLICT',
      request_accepted: false,
      current_notebook_ref: refreshed.structuredContent?.['notebook_ref']
    });
  });

  it('replays an accepted observed-ref request after the target object is replaced', async () => {
    const { connection, handles } = await rig(['one'], {
      nbformat: 4,
      nbformat_minor: 5,
      metadata: {},
      cells: [{ id: 'durable', cell_type: 'code', source: 'original', metadata: {}, outputs: [], execution_count: null }]
    });
    const opened = await connection.call('notebook_open', { path: 'a.ipynb' });
    const notebookId = String((opened.structuredContent?.['notebook'] as Record<string, unknown>)['notebook_id']);
    const observed = String((((opened.structuredContent?.['summary'] as Record<string, unknown>)['cells'] as Record<string, unknown>[])[0]!)['cell_ref']);
    const request = {
      notebook_id: notebookId,
      request_id: '1',
      operations: [{ op: 'replace_source', cell_ref: observed, source: 'accepted once' }]
    };
    const first = await connection.call('notebook_apply', request);
    expect(first.isError).not.toBe(true);

    handles[0]!.notebook.setSource({
      nbformat: 4,
      nbformat_minor: 5,
      metadata: {},
      cells: [{ id: 'durable', cell_type: 'code', source: 'replacement object', metadata: {}, outputs: [], execution_count: null }]
    } as never);
    const replay = await connection.call('notebook_apply', request);
    expect(replay.isError).not.toBe(true);
    expect(replay.structuredContent).toMatchObject({ replayed: true, next_request_id: '2' });
    expect(handles[0]!.notebook.getCell(0).getSource()).toBe('replacement object');

    const freshNumber = await connection.call('notebook_apply', { ...request, request_id: '2' });
    expect(metaError(freshNumber)).toMatchObject({ code: 'CELL_REPLACED', request_accepted: false });
  });

  it('anchors add_cell by observed object identity rather than cell content', async () => {
    const { connection, handles } = await rig(['one'], {
      nbformat: 4,
      nbformat_minor: 5,
      metadata: {},
      cells: [{ id: 'anchor', cell_type: 'code', source: 'before', metadata: {}, outputs: [], execution_count: null }]
    });
    const opened = await connection.call('notebook_open', { path: 'a.ipynb' });
    const notebookId = String((opened.structuredContent?.['notebook'] as Record<string, unknown>)['notebook_id']);
    const anchorRef = String((((opened.structuredContent?.['summary'] as Record<string, unknown>)['cells'] as Record<string, unknown>[])[0]!)['cell_ref']);
    handles[0]!.notebook.getCell(0).setSource('content changed');

    const added = await connection.call('notebook_apply', {
      notebook_id: notebookId,
      request_id: '1',
      operations: [{ op: 'add_cell', cell_type: 'raw', source: 'after live anchor', after_cell_ref: anchorRef }]
    });
    expect(added.isError).not.toBe(true);
    expect(handles[0]!.notebook.getCell(1).getSource()).toBe('after live anchor');

    handles[0]!.notebook.setSource({
      nbformat: 4,
      nbformat_minor: 5,
      metadata: {},
      cells: [{ id: 'anchor', cell_type: 'code', source: 'replacement', metadata: {}, outputs: [], execution_count: null }]
    } as never);
    const replaced = await connection.call('notebook_apply', {
      notebook_id: notebookId,
      request_id: '2',
      operations: [{ op: 'add_cell', cell_type: 'raw', source: 'must not add', after_cell_ref: anchorRef }]
    });
    expect(metaError(replaced)).toMatchObject({ code: 'CELL_REPLACED', request_accepted: false });
    expect(handles[0]!.notebook.cells).toHaveLength(1);
  });

  it('keeps accepted effects replayable when observed-ref issuance is exhausted', async () => {
    const { connection, handles } = await rig(['one'], undefined, { observedRefMaxEntries: 2 });
    const opened = await connection.call('notebook_open', { path: 'a.ipynb' });
    const notebookId = String((opened.structuredContent?.['notebook'] as Record<string, unknown>)['notebook_id']);
    const firstRef = String((((opened.structuredContent?.['summary'] as Record<string, unknown>)['cells'] as Record<string, unknown>[])[0]!)['cell_ref']);
    const request = {
      notebook_id: notebookId,
      request_id: '1',
      operations: [{ op: 'add_cell', cell_type: 'raw', source: 'accepted without publishable ref', position: 'end' }]
    };

    const first = await connection.call('notebook_apply', request);
    const firstError = metaError(first);
    expect(first.isError).toBe(true);
    expect(firstError).toMatchObject({
      code: 'RESOURCE_LIMIT',
      side_effects: 'applied',
      next_request_id: '2',
      request_accepted: true,
      replayed: false
    });
    expect(firstError['first_accepted_at']).toBeTypeOf('string');
    expect(handles[0]!.notebook.cells).toHaveLength(2);

    const replay = await connection.call('notebook_apply', request);
    expect(metaError(replay)).toMatchObject({
      code: 'RESOURCE_LIMIT',
      side_effects: 'applied',
      next_request_id: '2',
      request_accepted: true,
      replayed: true,
      first_accepted_at: firstError['first_accepted_at']
    });
    expect(handles[0]!.notebook.cells).toHaveLength(2);

    const existing = await connection.call('notebook_read', {
      notebook_id: notebookId,
      view: 'cells',
      cell_refs: [firstRef]
    });
    expect(existing.isError).not.toBe(true);
    expect((existing.structuredContent?.['cells'] as Record<string, unknown>[])[0]?.['cell_ref']).toBe(firstRef);
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
    const cellRef = String((((opened.structuredContent?.['summary'] as Record<string, unknown>)['cells'] as Record<string, unknown>[])[0]!)['cell_ref']);
    const chunks: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await connection.call('notebook_read', {
        notebook_id: notebookId,
        view: 'cells',
        ...(cursor === undefined ? { cell_refs: [cellRef] } : { cursor })
      });
      expect(page.isError).not.toBe(true);
      expect(jsonByteSize(page.structuredContent)).toBeLessThanOrEqual(64 * 1024);
      chunks.push(...(page.structuredContent?.['cells'] as Record<string, unknown>[]).map((cell) => String(cell['source'])));
      cursor = page.structuredContent?.['next_cursor'] as string | undefined;
    } while (cursor !== undefined);
    expect(chunks.join('')).toBe(source);
  });

  it('bounds and redacts a real unissued observed-ref error', async () => {
    const { connection } = await rig();
    const opened = await connection.call('notebook_open', { path: 'a.ipynb' });
    const notebookId = String((opened.structuredContent?.['notebook'] as Record<string, unknown>)['notebook_id']);
    const invalidRef = `@${'x'.repeat(50_000)}?token=should-redact&continuation=${'y'.repeat(50_000)}`;

    const answer = await connection.call('notebook_apply', {
      notebook_id: notebookId,
      request_id: '1',
      operations: [{
        op: 'replace_source',
        cell_ref: invalidRef,
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
      code: 'HANDLE_EXPIRED',
      retryable: false,
      side_effects: 'none'
    });
  });

  it('reduces a 100-cell internal summary to one public observed ref per cell', async () => {
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
    expect(compactCells.every((cell) => String(cell['cell_ref']).startsWith('@'))).toBe(true);
    expect(new Set(compactCells.map((cell) => cell['cell_ref'])).size).toBe(100);
    expect(compactCells.every((cell) => !('cell_id' in cell) && !('source_revision' in cell) && !('cell_revision' in cell) && !('outputs_revision' in cell))).toBe(true);
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
