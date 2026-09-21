import { afterAll, afterEach, beforeAll, expect, it } from 'vitest';
import { isCoreError, type CollabService, type ExecutionView, type NotebookExecuteRequest } from '../../src/core/index.js';
import { createCollabService } from '../../src/service/index.js';
import { startStand, type Stand } from '../helpers/stand.js';

let stand: Stand;
let service: CollabService;
const opened: Array<{ owner: CollabService; notebookId: string; kernelId: string }> = [];
const extraServices: CollabService[] = [];
const terminal = new Set(['succeeded', 'failed', 'cancelled', 'interrupted', 'unknown']);

beforeAll(async () => {
  stand = await startStand({ port: 8920 });
  service = createCollabService({ servers: [{ id: 'stand', kind: 'standalone', apiBaseUrl: stand.baseUrl, credentialRef: `literal:${stand.token}` }] }, { guardStdout: false });
}, 120_000);

afterEach(async () => {
  for (const entry of opened.splice(0)) {
    await entry.owner.kernelControl({ notebookId: entry.notebookId, requestId: (await entry.owner.serverList()).nextRequestId!, action: 'shutdown', expectedKernelId: entry.kernelId });
    await entry.owner.notebookClose({ notebookId: entry.notebookId, force: true });
  }
  await Promise.all(extraServices.splice(0).map((entry) => entry.shutdown('client_request')));
});

afterAll(async () => { await service?.shutdown('client_request'); await stand?.stop(); }, 120_000);

async function prepare(sources: string[], owner = service): Promise<NotebookExecuteRequest> {
  const created = await owner.notebookCreate({ requestId: (await owner.serverList()).nextRequestId!, directory: '', name: `completion-${Date.now()}-${Math.random().toString(36).slice(2)}.ipynb` });
  const applied = await owner.notebookApply({ notebookId: created.notebook.notebookId, requestId: created.nextRequestId!,
    operations: sources.map((source) => ({ op: 'add_cell', cellType: 'code', source, position: 'end' })) });
  const started = await owner.kernelControl({ notebookId: created.notebook.notebookId, requestId: applied.nextRequestId!, action: 'start', expectedKernelId: null, kernelName: 'python3' });
  opened.push({ owner, notebookId: created.notebook.notebookId, kernelId: started.kernelId! });
  return { notebookId: created.notebook.notebookId, requestId: started.nextRequestId!, cells: applied.results.map((entry) => ({ cellId: entry.cellId!, expectedSourceRevision: entry.sourceRevision! })) };
}

async function active(notebookId: string): Promise<string> {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const status = await service.kernelStatus({ notebookId });
    if (status.activeExecutionIds[0] !== undefined) return status.activeExecutionIds[0];
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('execution was not accepted');
}

async function marker(executionId: string, text: string): Promise<ExecutionView> {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const view = await service.executionGet({ executionId });
    if (JSON.stringify(view.cells).includes(text)) return view;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('kernel did not reach the marker');
}

it('waits for quick success, replays once, and bounds persisted notebook outputs', async () => {
  const request = await prepare(['print("x" * 75)']);
  const result = await service.notebookExecute({ ...request, waitMs: 5000 });
  expect(result.state).toBe('succeeded');
  expect(result.waitTimedOut).toBe(false);
  const replay = await service.notebookExecute({ ...request, waitMs: 5000 });
  expect(replay).toMatchObject({ state: 'succeeded', replayed: true, executionId: result.executionId, waitTimedOut: false });
  expect(replay.cells[0]!.executionCount).toBe(result.cells[0]!.executionCount);
  const outputs = await service.notebookRead({ notebookId: request.notebookId, view: 'outputs', cellIds: [request.cells[0]!.cellId], limits: { maxOutputBytes: 40 } });
  const entry = outputs.cells[0]!.outputs[0]!;
  expect(outputs.truncated).toBe(true);
  expect(entry.truncated).toBe(true);
  expect(entry.output).toBeUndefined();
  expect(entry.byteSize).toBeGreaterThan(40);
  expect((await service.outputRead({ outputId: entry.snapshot!.outputId })).data).toBe(`${'x'.repeat(75)}\n`);
});

it('preserves accepted execution recovery when its output snapshot set cannot fit', async () => {
  const limited = createCollabService({
    servers: [{ id: 'stand', kind: 'standalone', apiBaseUrl: stand.baseUrl, credentialRef: `literal:${stand.token}` }]
  }, { guardStdout: false, outputStoreMaxBytes: 1000 });
  extraServices.push(limited);
  const request = await prepare([
    'from IPython.display import display\nretention_runs = globals().get("retention_runs", 0) + 1\ndisplay("x" * 700)\ndisplay("y" * 700)'
  ], limited);
  const execute = { ...request, waitMs: 5000, limits: { maxOutputBytes: 1 } };

  let firstError: unknown;
  try {
    await limited.notebookExecute(execute);
  } catch (error) {
    firstError = error;
  }
  expect(isCoreError(firstError) && firstError.code).toBe('RESOURCE_LIMIT');
  expect(isCoreError(firstError) && firstError.sideEffects).toBe('applied');
  const firstDetails = isCoreError(firstError) ? firstError.details ?? {} : {};
  expect(firstDetails).toMatchObject({ request_accepted: true, replayed: false });
  expect(firstDetails['execution_id']).toBeTypeOf('string');
  expect(firstDetails['next_request_id']).toBeTypeOf('string');
  expect(firstDetails['first_accepted_at']).toBeTypeOf('string');
  const executionId = String(firstDetails['execution_id']);
  const nextRequestId = String(firstDetails['next_request_id']);
  const firstAcceptedAt = String(firstDetails['first_accepted_at']);

  await expect(limited.executionGet({ executionId, limits: { maxOutputBytes: 1 } })).rejects.toSatisfy(
    (error: unknown) => isCoreError(error) && error.code === 'RESOURCE_LIMIT'
  );

  let replayError: unknown;
  try {
    await limited.notebookExecute(execute);
  } catch (error) {
    replayError = error;
  }
  expect(isCoreError(replayError) && replayError.code).toBe('RESOURCE_LIMIT');
  expect(isCoreError(replayError) && replayError.sideEffects).toBe('applied');
  expect(isCoreError(replayError) ? replayError.details : {}).toMatchObject({
    execution_id: executionId,
    next_request_id: nextRequestId,
    request_accepted: true,
    replayed: true,
    first_accepted_at: firstAcceptedAt
  });

  const probeCell = await limited.notebookApply({
    notebookId: request.notebookId,
    requestId: nextRequestId,
    operations: [{ op: 'add_cell', cellType: 'code', source: 'assert retention_runs == 1', position: 'end' }]
  });
  const probe = await limited.notebookExecute({
    notebookId: request.notebookId,
    requestId: probeCell.nextRequestId!,
    cells: [{ cellId: probeCell.results[0]!.cellId!, expectedSourceRevision: probeCell.results[0]!.sourceRevision! }],
    waitMs: 5000
  });
  expect(probe.state).toBe('succeeded');
});

it('returns a quick Python failure as a terminal result without a timeout', async () => {
  const request = await prepare(['raise ValueError("expected-failure")']);
  const result = await service.notebookExecute({ ...request, waitMs: 5000 });
  expect(result.state).toBe('failed');
  expect(result.waitTimedOut).toBe(false);
  expect(JSON.stringify(result.cells)).toContain('expected-failure');
});

it('ignores intermediate output until completion', async () => {
  const request = await prepare(['import time\nprint("intermediate", flush=True)\ntime.sleep(0.3)\nprint("completed", flush=True)']);
  const started = Date.now();
  const result = await service.notebookExecute({ ...request, waitMs: 5000 });
  expect(Date.now() - started).toBeGreaterThanOrEqual(280);
  expect(result).toMatchObject({ state: 'succeeded', waitTimedOut: false });
  expect(JSON.stringify(result.cells)).toContain('completed');
});

it('returns at the deadline and lets a replay wait on the same execution', async () => {
  const request = await prepare(['import time\nprint("started", flush=True)\ntime.sleep(0.5)\nprint("done", flush=True)']);
  const started = Date.now();
  const first = await service.notebookExecute({ ...request, waitMs: 80 });
  expect(Date.now() - started).toBeGreaterThanOrEqual(70);
  expect(terminal.has(first.state)).toBe(false);
  expect(first.waitTimedOut).toBe(true);
  const replay = await service.notebookExecute({ ...request, waitMs: 3000 });
  expect(replay).toMatchObject({ executionId: first.executionId, state: 'succeeded', replayed: true, waitTimedOut: false });
  expect(replay.cells[0]!.executionCount).toBe(1);
});

it('keeps execution_get as a next-update wait', async () => {
  const request = await prepare(['import time\nprint("first", flush=True)\ntime.sleep(0.2)\nprint("second", flush=True)\ntime.sleep(0.5)']);
  const first = await service.notebookExecute({ ...request, waitMs: 0 });
  expect(first.waitTimedOut).toBe(false);
  const update = await service.executionGet({ executionId: first.executionId, cursor: first.cursor, waitMs: 3000 });
  expect(update.state).toBe('running');
  expect(update.waitTimedOut).toBe(false);
  expect(update.cursor).not.toBe(first.cursor);
  expect(await service.notebookExecute({ ...request, waitMs: 3000 })).toMatchObject({ state: 'succeeded', replayed: true });
});

it('releases the mutation lock so an explicit interrupt completes the wait', async () => {
  const request = await prepare(['import time\nprint("interrupt-ready", flush=True)\ntime.sleep(120)']);
  let answered = false;
  const waiting = service.notebookExecute({ ...request, waitMs: 5000 }).then((result) => { answered = true; return result; });
  const executionId = await active(request.notebookId);
  await marker(executionId, 'interrupt-ready');
  expect(answered).toBe(false);
  const status = await service.kernelStatus({ notebookId: request.notebookId });
  const before = Date.now();
  const interrupt = await service.kernelControl({ notebookId: request.notebookId, requestId: status.nextRequestId!, action: 'interrupt', expectedKernelId: status.kernelId! });
  expect(Date.now() - before).toBeLessThan(2500);
  expect(interrupt.effects.kernelInterrupted).toBe(true);
  const result = await waiting;
  expect(result.state).toBe('interrupted');
  expect(result.waitTimedOut).toBe(false);
  expect(result.nextRequestId).toBe(interrupt.nextRequestId);
});

it('cancels unsent cells without interrupting the cell whose completion is awaited', async () => {
  const request = await prepare(['import time\nprint("cancel-ready", flush=True)\ntime.sleep(0.4)', 'print("must-not-run")']);
  let answered = false;
  const waiting = service.notebookExecute({ ...request, waitMs: 3000 }).then((result) => { answered = true; return result; });
  const executionId = await active(request.notebookId);
  await marker(executionId, 'cancel-ready');
  const cancelled = await service.executionCancel({ executionId });
  expect(cancelled.kernelInterrupted).toBe(false);
  expect(cancelled.cancelledCellIds).toEqual([request.cells[1]!.cellId]);
  expect(answered).toBe(false);
  const result = await waiting;
  expect(result.state).toBe('cancelled');
  expect(result.waitTimedOut).toBe(false);
  expect(result.cells[0]!.state).toBe('succeeded');
  expect(result.cells[1]!.state).toBe('not_sent');
});
