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
import { createCollabService } from '../../src/service/index.js';
import type { NotebookHandle } from '../../src/service/index.js';
import { makeFakeHandle, makeFakeServer } from '../service/helpers.js';
import { connect, metaError, type Harness } from './harness.js';

const SECRET_OUTPUT = 'private to the library session\n';

const services: CollabService[] = [];
const connections: Harness[] = [];

afterEach(async () => {
  await Promise.all(connections.splice(0).map((connection) => connection.close()));
  await Promise.all(services.splice(0).map((service) => service.shutdown('client_request')));
});

/** One service over a fake Jupyter, plus one MCP connection to it. */
async function rig(): Promise<{
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
});
