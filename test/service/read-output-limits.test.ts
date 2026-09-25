import { afterEach, expect, it } from 'vitest';
import { isCoreError, type CollabService, type NotebookOutputsReadResult } from '../../src/core/index.js';
import { createCollabService, type NotebookHandle } from '../../src/service/index.js';
import { makeFakeHandle, makeFakeServer } from './helpers.js';

const services: CollabService[] = [];
afterEach(async () => { await Promise.all(services.splice(0).map((service) => service.shutdown('client_request'))); });

async function rig(options: {
  readonly outputStoreMaxBytes?: number;
  readonly outputTexts?: readonly string[];
  readonly cellCount?: number;
} = {}) {
  const fake = makeFakeServer({ files: [{ path: 'limits.ipynb', type: 'notebook' }] });
  let handle: NotebookHandle | undefined;
  const service = createCollabService({ servers: [{ id: 'test', kind: 'standalone', apiBaseUrl: 'http://fixture.invalid', credentialRef: 'literal:synthetic' }] }, {
    guardStdout: false,
    fetchImpl: fake.fetchImpl,
    ...(options.outputStoreMaxBytes === undefined ? {} : { outputStoreMaxBytes: options.outputStoreMaxBytes }),
    openHandle: async (init) => {
      handle = makeFakeHandle(init).handle;
      const outputs = (options.outputTexts ?? ['x'.repeat(75)]).map((text) => ({
        output_type: 'stream', name: 'stdout', text
      }));
      const ids = ['one', 'two'].slice(0, options.cellCount ?? 2);
      handle.notebook.setSource({ nbformat: 4, nbformat_minor: 5, metadata: {}, cells: ids.map((id) => ({
        id, cell_type: 'code', source: 'print(1)', metadata: {}, outputs, execution_count: 1
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

it('distinguishes complete text previews from unread outputs and cell pages', async () => {
  const { service, notebook, ids } = await rig({ outputTexts: ['x'.repeat(298)] });
  const completeText = await service.notebookRead({
    notebookId: notebook.notebookId,
    view: 'outputs', cellIds: [ids[0]!], limits: { maxBytes: 300 }
  });
  expect(completeText).toMatchObject({
    truncated: false, cellsTruncated: false, outputsTruncated: false
  });
  expect(completeText.nextCursor).toBeUndefined();
  expect(completeText.cells[0]!.outputs[0]).toMatchObject({
    truncated: false, outputInlined: false, textPreview: 'x'.repeat(298)
  });
  expect(completeText.cells[0]!.outputs[0]!.snapshot).toBeUndefined();

  const page = await service.notebookRead({
    notebookId: notebook.notebookId,
    view: 'outputs', limits: { maxCells: 1, maxBytes: 300 }
  });
  expect(page).toMatchObject({ truncated: true, cellsTruncated: true, outputsTruncated: false });
  expect(page.nextCursor).toBeDefined();
});

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

it('advertises only a complete retainable set of notebook output snapshots', async () => {
  const outputTexts = [`a${'x'.repeat(699)}`, `b${'y'.repeat(699)}`];
  const { service, notebook, ids } = await rig({ outputStoreMaxBytes: 1500, outputTexts, cellCount: 1 });
  const read = await service.notebookRead({
    notebookId: notebook.notebookId,
    view: 'outputs',
    cellIds: ids,
    limits: { maxBytes: 1 }
  });
  const entries = read.cells[0]!.outputs;
  expect(entries).toHaveLength(2);
  for (let index = 0; index < entries.length; index += 1) {
    const outputId = entries[index]!.snapshot!.outputId;
    expect((await service.outputRead({ outputId })).data).toBe(outputTexts[index]);
  }
});

it('rejects a notebook output response whose advertised snapshot set cannot be retained', async () => {
  const { service, notebook, ids } = await rig({
    outputStoreMaxBytes: 1000,
    outputTexts: ['x'.repeat(700), 'y'.repeat(700)],
    cellCount: 1
  });
  await expect(service.notebookRead({
    notebookId: notebook.notebookId,
    view: 'outputs',
    cellIds: ids,
    limits: { maxBytes: 1 }
  })).rejects.toSatisfy((error: unknown) => isCoreError(error) && error.code === 'RESOURCE_LIMIT');
});

it('rejects one notebook output snapshot larger than the whole store', async () => {
  const { service, notebook, ids } = await rig({
    outputStoreMaxBytes: 1000,
    outputTexts: ['x'.repeat(1001)],
    cellCount: 1
  });
  await expect(service.notebookRead({
    notebookId: notebook.notebookId,
    view: 'outputs',
    cellIds: ids,
    limits: { maxBytes: 1 }
  })).rejects.toSatisfy((error: unknown) => isCoreError(error) && error.code === 'RESOURCE_LIMIT');
});
