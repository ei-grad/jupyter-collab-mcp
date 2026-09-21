import { afterEach, expect, it } from 'vitest';
import type { CollabService, NotebookOutputsReadResult } from '../../src/core/index.js';
import { createCollabService, type NotebookHandle } from '../../src/service/index.js';
import { makeFakeHandle, makeFakeServer } from './helpers.js';

const services: CollabService[] = [];
afterEach(async () => { await Promise.all(services.splice(0).map((service) => service.shutdown('client_request'))); });

async function rig() {
  const fake = makeFakeServer({ files: [{ path: 'limits.ipynb', type: 'notebook' }] });
  let handle: NotebookHandle | undefined;
  const service = createCollabService({ servers: [{ id: 'test', kind: 'standalone', apiBaseUrl: 'http://fixture.invalid', credentialRef: 'literal:synthetic' }] }, {
    guardStdout: false, fetchImpl: fake.fetchImpl, openHandle: async (init) => {
      handle = makeFakeHandle(init).handle;
      const output = { output_type: 'stream', name: 'stdout', text: 'x'.repeat(75) };
      handle.notebook.setSource({ nbformat: 4, nbformat_minor: 5, metadata: {}, cells: ['one', 'two'].map((id) => ({
        id, cell_type: 'code', source: 'print(1)', metadata: {}, outputs: [output], execution_count: 1
      })) } as never);
      return handle;
    }
  });
  services.push(service);
  const opened = await service.notebookOpen({ path: 'limits.ipynb' });
  return { service, notebook: opened.notebook, ids: opened.summary.cells.map((cell) => cell.cellId) };
}

function assertBounded(result: NotebookOutputsReadResult) {
  expect(result.truncated).toBe(true);
  for (const cell of result.cells) {
    expect(cell.truncated).toBe(true);
    expect(cell.outputs).toHaveLength(1);
    expect(cell.outputs[0]!.byteSize).toBeGreaterThan(40);
    expect(cell.outputs[0]!.truncated).toBe(true);
    expect(cell.outputs[0]!.output).toBeUndefined();
    expect(cell.outputs[0]!.snapshot?.outputId).toBeDefined();
    expect(Buffer.byteLength(cell.outputs[0]!.textPreview ?? '')).toBeLessThanOrEqual(40);
  }
}

it.each(['explicit', 'implicit', 'cursor'] as const)('bounds notebook outputs for %s selection and preserves snapshot retrieval', async (selection) => {
  const { service, notebook, ids } = await rig();
  const first = await service.notebookRead({ notebookId: notebook.notebookId, view: 'outputs',
    ...(selection === 'explicit' ? { cellIds: ids } : {}),
    limits: { maxOutputBytes: 40, ...(selection === 'cursor' ? { maxCells: 1 } : {}) }
  });
  assertBounded(first);
  const result = selection === 'cursor' ? await service.notebookRead({ notebookId: notebook.notebookId, view: 'outputs', cursor: first.nextCursor!, limits: { maxCells: 1, maxOutputBytes: 40 } }) : first;
  assertBounded(result);
  const entry = result.cells[0]!.outputs[0]!;
  const recovered = await service.outputRead({ outputId: entry.snapshot!.outputId });
  expect(recovered.data).toBe('x'.repeat(75));
  const again = await service.notebookRead({ notebookId: notebook.notebookId, view: 'outputs', cellIds: [result.cells[0]!.cellId], limits: { maxOutputBytes: 40 } });
  expect(again.cells[0]!.outputs[0]!.snapshot!.outputId).toBe(entry.snapshot!.outputId);
});
