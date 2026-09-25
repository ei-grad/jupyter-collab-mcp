/**
 * An output snapshot belongs to the working context that produced it
 * (SPEC.md §4, §9).
 *
 * One MCP connection is one implicit working context. A second context in the
 * same process - here a library session opened through the embedding API -
 * keeps its own replicas, jobs, snapshots and request ledger. Its `output_id`
 * and its `jupyter-output:` URI are therefore not addressable from the
 * connection, are not advertised to it by `resources/list`, and the
 * connection's envelope never carries the owning context's `next_request_id`.
 */

import { afterEach, describe, expect, it } from 'vitest';

import type { CollabService } from '../../src/core/index.js';
import { jsonByteSize } from '../../src/mcp/index.js';
import { createCollabService } from '../../src/service/index.js';
import type { NotebookHandle } from '../../src/service/index.js';
import { makeFakeHandle, makeFakeServer } from '../service/helpers.js';
import { connect, metaError, type Harness } from './harness.js';

const SECRET_OUTPUT = 'private to the library session\n';

const services: CollabService[] = [];
const connections: Harness[] = [];

function textOf(answer: Awaited<ReturnType<Harness['call']>>): string {
  return answer.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text ?? '')
    .join('');
}

function textField(text: string, name: string): string | undefined {
  return new RegExp(`^${name}=([^\\s]+)$`, 'mu').exec(text)?.[1];
}

afterEach(async () => {
  await Promise.all(connections.splice(0).map((connection) => connection.close()));
  await Promise.all(services.splice(0).map((service) => service.shutdown('client_request')));
});

/** One service over a fake Jupyter, plus one MCP connection to it. */
async function rig(options: { readonly outputStoreMaxBytes?: number } = {}): Promise<{
  service: CollabService;
  connection: Harness;
  handles: NotebookHandle[];
}> {
  const server = makeFakeServer({ files: [{ path: 'a.ipynb', type: 'notebook' }] });
  const handles: NotebookHandle[] = [];
  const service = createCollabService(
    {
      servers: [
        {
          id: 'one',
          kind: 'standalone',
          apiBaseUrl: 'http://127.0.0.1:9000',
          credentialRef: 'literal:synthetic'
        }
      ]
    },
    {
      guardStdout: false,
      ...(options.outputStoreMaxBytes === undefined ? {} : { outputStoreMaxBytes: options.outputStoreMaxBytes }),
      fetchImpl: server.fetchImpl,
      openHandle: async (init) => {
        const handle = makeFakeHandle(init).handle;
        handles.push(handle);
        return handle;
      }
    }
  );
  services.push(service);
  const connection = await connect({ service });
  connections.push(connection);
  return { service, connection, handles };
}

/** Intern one output snapshot inside a library session of `service`. */
async function snapshotOfAnotherContext(
  service: CollabService,
  handles: readonly NotebookHandle[]
): Promise<{ outputId: string; uri: string; nextRequestId: string }> {
  const session = await service.sessionOpen({});
  const opened = await service.notebookOpen({ sessionId: session.sessionId, path: 'a.ipynb' });
  const cellId = opened.summary.cells[0]!.cellId;
  const cell = handles[0]!.notebook.getCell(0) as unknown as {
    setOutputs(outputs: unknown[]): void;
  };
  cell.setOutputs([{ output_type: 'stream', name: 'stdout', text: SECRET_OUTPUT }]);
  // Advance the library ledger past the connection's, so a borrowed envelope
  // is visible instead of accidentally equal.
  const applied = await service.notebookApply({
    notebookId: opened.notebook.notebookId,
    requestId: '1',
    operations: [{ op: 'add_cell', cellType: 'markdown', source: '# library', position: 'end' }]
  });
  const read = await service.notebookRead({
    notebookId: opened.notebook.notebookId,
    view: 'outputs',
    cellIds: [cellId],
    limits: { maxBytes: 1 }
  });
  const snapshot = read.cells[0]!.outputs[0]!.snapshot!;
  return { outputId: snapshot.outputId, uri: snapshot.uri, nextRequestId: applied.nextRequestId! };
}

describe('output snapshots stay inside their working context', () => {
  it('output_read serves neither another context snapshot nor its next_request_id', async () => {
    const { service, connection, handles } = await rig();
    const owned = await snapshotOfAnotherContext(service, handles);
    expect(owned.nextRequestId).toBe('2');
    expect((await connection.call('server_list')).structuredContent?.['next_request_id']).toBe('1');

    const answer = await connection.call('output_read', { output_id: owned.outputId });

    expect.soft(JSON.stringify(answer.structuredContent ?? {})).not.toContain(SECRET_OUTPUT.trim());
    expect.soft(answer.structuredContent?.['next_request_id']).not.toBe(owned.nextRequestId);
    expect(metaError(answer)['code']).toBe('HANDLE_EXPIRED');
  });

  it('resources/list and resources/read stay inside the connection context', async () => {
    const { service, connection, handles } = await rig();
    const owned = await snapshotOfAnotherContext(service, handles);

    const listed = await connection.client.listResources();
    expect.soft(listed.resources.map((resource) => resource.uri)).toEqual([]);

    await expect
      .soft(connection.client.readResource({ uri: owned.uri }))
      .rejects.toThrow(/HANDLE_EXPIRED/u);
    await expect(
      connection.client.readResource({ uri: `jupyter-output:${owned.outputId}` })
    ).rejects.toThrow(/HANDLE_EXPIRED/u);
  });

  it('keeps default output_read chunks within the MCP budget and losslessly pages text', async () => {
    const { connection, handles } = await rig();
    const opened = await connection.call('notebook_open', { path: 'a.ipynb' });
    const notebookId = String((opened.structuredContent?.['notebook'] as Record<string, unknown>)['notebook_id']);
    const cellRef = String(((opened.structuredContent?.['summary'] as Record<string, unknown>)['cells'] as Record<string, unknown>[])[0]!['cell_ref']);
    const output = 'x'.repeat(100_000);
    const cell = handles[0]!.notebook.getCell(0) as unknown as { setOutputs(outputs: unknown[]): void };
    cell.setOutputs([{ output_type: 'stream', name: 'stdout', text: output }]);
    const outputs = await connection.call('notebook_read', {
      notebook_id: notebookId,
      view: 'outputs',
      cell_refs: [cellRef],
      limits: { max_bytes: 1 }
    });
    const outputId = String(((((outputs.structuredContent?.['cells'] as Record<string, unknown>[])[0]!['outputs'] as Record<string, unknown>[])[0]!['snapshot'] as Record<string, unknown>)['output_id']));

    const chunks: string[] = [];
    let cursor: string | undefined;
    do {
      const answer = await connection.call('output_read', {
        output_id: outputId,
        ...(cursor === undefined ? {} : { cursor })
      });
      expect(answer.isError).not.toBe(true);
      expect(jsonByteSize(answer.structuredContent)).toBeLessThanOrEqual(64 * 1024);
      chunks.push(String(answer.structuredContent?.['data']));
      cursor = answer.structuredContent?.['next_cursor'] as string | undefined;
    } while (cursor !== undefined);
    expect(chunks.join('')).toBe(output);
  });

  it('gives text-only hosts an output_id for an otherwise inline output', async () => {
    const { connection, handles } = await rig();
    const opened = await connection.call('notebook_open', { path: 'a.ipynb' });
    const notebookId = String((opened.structuredContent?.['notebook'] as Record<string, unknown>)['notebook_id']);
    const cellRef = String(((opened.structuredContent?.['summary'] as Record<string, unknown>)['cells'] as Record<string, unknown>[])[0]!['cell_ref']);
    const output = 'text-only recovery\n'.repeat(512);
    const cell = handles[0]!.notebook.getCell(0) as unknown as { setOutputs(outputs: unknown[]): void };
    cell.setOutputs([{ output_type: 'stream', name: 'stdout', text: output }]);

    const answer = await connection.call('notebook_read', {
      notebook_id: notebookId,
      view: 'outputs',
      cell_refs: [cellRef]
    });
    const entry = ((((answer.structuredContent?.['cells'] as Record<string, unknown>[])[0]!['outputs'] as Record<string, unknown>[])[0]!));
    expect(entry['truncated']).toBe(false);
    const outputId = String((entry['snapshot'] as Record<string, unknown>)['output_id']);
    const text = answer.content.find((block) => block.type === 'text')?.text ?? '';
    expect(text).toContain(`output_id=${outputId}`);

    const recovered = await connection.call('output_read', { output_id: outputId });
    expect(recovered.structuredContent?.['data']).toBe(output);
  });

  it('returns a bounded RESOURCE_LIMIT instead of advertising an evicted output id', async () => {
    const { connection, handles } = await rig({ outputStoreMaxBytes: 1000 });
    const opened = await connection.call('notebook_open', { path: 'a.ipynb' });
    const notebookId = String((opened.structuredContent?.['notebook'] as Record<string, unknown>)['notebook_id']);
    const cellRef = String(((opened.structuredContent?.['summary'] as Record<string, unknown>)['cells'] as Record<string, unknown>[])[0]!['cell_ref']);
    const cell = handles[0]!.notebook.getCell(0) as unknown as { setOutputs(outputs: unknown[]): void };
    cell.setOutputs([
      { output_type: 'stream', name: 'stdout', text: 'x'.repeat(700) },
      { output_type: 'stream', name: 'stdout', text: 'y'.repeat(700) }
    ]);

    const answer = await connection.call('notebook_read', {
      notebook_id: notebookId,
      view: 'outputs',
      cell_refs: [cellRef],
      limits: { max_bytes: 1 }
    });
    expect(answer.isError).toBe(true);
    expect(answer.structuredContent).toBeUndefined();
    expect(metaError(answer)).toMatchObject({ code: 'RESOURCE_LIMIT' });
    expect(jsonByteSize(answer._meta)).toBeLessThanOrEqual(64 * 1024);
    expect(jsonByteSize(textOf(answer))).toBeLessThanOrEqual(64 * 1024);
  });

  it('lets a text-only host recover every rendered record, source byte and output byte', async () => {
    const { connection, handles } = await rig();
    const opened = await connection.call('notebook_open', { path: 'a.ipynb' });
    const openText = textOf(opened);
    const notebookId = /notebook (\S+) /u.exec(openText)?.[1];
    expect(notebookId).toBeDefined();

    const largeSource = 'source continuation line\n'.repeat(5_000);
    const outputs = Array.from({ length: 12 }, (_unused, index) => {
      const text = index === 0
        ? 'i'.repeat(1_024)
        : index === 10
          ? 'large-output-line\n'.repeat(8_000)
          : `output-${String(index)}`;
      return { output_type: 'stream', name: 'stdout', text };
    });
    handles[0]!.notebook.setSource({
      nbformat: 4,
      nbformat_minor: 5,
      metadata: {},
      cells: Array.from({ length: 25 }, (_unused, index) => ({
        id: `text-cell-${String(index)}`,
        cell_type: 'code',
        source: index === 0 ? largeSource : `source-${String(index)}`,
        metadata: {},
        outputs: index === 0 ? outputs : [],
        execution_count: null
      }))
    } as never);

    const summaryText = textOf(await connection.call('notebook_read', {
      notebook_id: notebookId,
      view: 'summary'
    }));
    expect(summaryText).toContain('index=24 ');
    const firstCellRef = /^\s*index=0 cell_id=\S+ cell_ref=(\S+)/mu.exec(summaryText)?.[1];
    expect(firstCellRef).toBeDefined();

    const recoveredSources: string[] = [];
    let sourceCursor: string | undefined;
    do {
      const text = textOf(await connection.call('notebook_read', {
        notebook_id: notebookId,
        view: 'cells',
        ...(sourceCursor === undefined ? {} : { cursor: sourceCursor })
      }));
      for (const match of text.matchAll(/^\s*source_offset=\d+ source_complete=(?:true|false) source=(".*")$/gmu)) {
        recoveredSources.push(JSON.parse(match[1]!) as string);
      }
      sourceCursor = textField(text, 'next_cursor');
    } while (sourceCursor !== undefined);
    expect(recoveredSources.join('')).toBe(
      largeSource + Array.from({ length: 24 }, (_unused, index) => `source-${String(index + 1)}`).join('')
    );

    const outputText = textOf(await connection.call('notebook_read', {
      notebook_id: notebookId,
      view: 'outputs',
      cell_refs: [firstCellRef]
    }));
    const outputIds = [...outputText.matchAll(/output_id=(\S+) — call output_read/gmu)].map((match) => match[1]!);
    expect(outputIds).toHaveLength(12);
    expect(new Set(outputIds).size).toBe(12);

    for (let index = 0; index < outputIds.length; index += 1) {
      const chunks: string[] = [];
      let cursor: string | undefined;
      do {
        const text = textOf(await connection.call('output_read', {
          output_id: outputIds[index],
          ...(cursor === undefined ? {} : { cursor })
        }));
        const data = /^data=(".*")$/mu.exec(text)?.[1];
        expect(data).toBeDefined();
        chunks.push(JSON.parse(data!) as string);
        cursor = textField(text, 'next_cursor');
      } while (cursor !== undefined);
      expect(chunks.join('')).toBe((outputs[index] as { text: string }).text);
    }

    const applyText = textOf(await connection.call('notebook_apply', {
      notebook_id: notebookId,
      request_id: '1',
      operations: Array.from({ length: 31 }, (_unused, index) => ({
        op: 'add_cell',
        cell_type: 'raw',
        source: `added-${String(index)}`,
        position: 'end'
      }))
    }));
    expect(applyText.match(/^\s*add_cell /gmu)).toHaveLength(31);
  });
});
