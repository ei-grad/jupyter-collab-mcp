/**
 * SPEC.md §9 "Retries, errors, and response size", rule order 1-4: the request
 * receipt is resolved **before** any mutable precondition is rechecked.
 *
 * The four deduplicated mutations all change the very state their own
 * preconditions inspect, so an exact resend of an accepted call whose answer
 * the agent lost must replay the receipt instead of being rejected by the
 * state the first call created:
 *
 *   - `notebook_create` - the file and the replica now exist;
 *   - `notebook_apply`  - the revision the batch expects has moved
 *     (`REVISION_CONFLICT`);
 *   - `kernel_control`  - the binding the action expects has changed
 *     (`KERNEL_CHANGED` after `start`, `KERNEL_NOT_BOUND` after `shutdown`);
 *   - `notebook_execute` - the job the first call submitted is still active
 *     (`EXECUTION_ACTIVE`).
 *
 * The same ordering is what makes two simultaneous calls of one number produce
 * a single job rather than two kernel executions, checked here against a real
 * kernel.
 *
 * Unit rigs cannot cover the kernel half of this: `notebook_execute` and
 * `kernel_control` need a real Sessions API and a real kernel websocket, so
 * this file runs against the stand. Port 8868 belongs to this file alone.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { CollabService, ExecutionView } from '../../src/core/index.js';
import { createCollabService } from '../../src/service/index.js';
import { apiFetchOk } from '../helpers/fetch.js';
import { startStand, type Stand } from '../helpers/stand.js';

const PORT = 8868;
const TERMINAL = new Set(['succeeded', 'failed', 'cancelled', 'interrupted', 'unknown']);
/** The stand keeps its contents root between runs, so namespace every file. */
const RUN = Date.now().toString(36);
const nb = (label: string): string => `f2-${RUN}-${label}.ipynb`;

let stand: Stand;
let service: CollabService;
const startedKernels = new Set<string>();

/** Per-session request counter; the client only ever copies the last answer. */
class Counter {
  #next = '1';
  get value(): string {
    return this.#next;
  }
  take(next: string | null): void {
    if (next !== null) this.#next = next;
  }
}

/**
 * Wait until the freshly started kernel reports `idle`.
 *
 * A cold stand spends seconds spawning the first `python3`; sending the first
 * `execute_request` into a kernel that has not finished starting is a test
 * flake, not the behaviour under test here.
 */
async function waitIdle(notebookId: string, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const status = await service.kernelStatus({ notebookId });
    if (status.executionStatus === 'idle') return;
    if (Date.now() > deadline) throw new Error(`kernel stuck in ${status.executionStatus}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function settle(executionId: string, timeoutMs = 60_000): Promise<ExecutionView> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const view = await service.executionGet({ executionId, waitMs: 1000 });
    if (TERMINAL.has(view.state)) return view;
    if (Date.now() > deadline) throw new Error(`job stuck in ${view.state}`);
  }
}

beforeAll(async () => {
  stand = await startStand({ port: PORT });
  service = createCollabService({
    servers: [
      {
        id: 'stand',
        kind: 'standalone',
        apiBaseUrl: stand.baseUrl,
        wsBaseUrl: stand.wsUrl,
        credentialRef: `literal:${stand.token}`
      }
    ]
  });
}, 120_000);

afterAll(async () => {
  await service.shutdown('client_request');
  const target = { baseUrl: stand.baseUrl, token: stand.token };
  try {
    for (const kernelId of startedKernels) {
      await apiFetchOk(target, `/api/kernels/${kernelId}`, { method: 'DELETE' }, [204, 404]);
    }
    const listing = await apiFetchOk(target, '/api/contents/?content=1');
    const entries = listing.json<{ content?: Array<{ path: string }> }>().content ?? [];
    for (const entry of entries) {
      if (!entry.path.startsWith(`f2-${RUN}-`) && !entry.path.startsWith('Untitled')) continue;
      await apiFetchOk(target, `/api/contents/${entry.path}`, { method: 'DELETE' }, [204, 404]);
    }
  } catch {
    // Cleaning the stand is best effort; the run itself already reported.
  }
  await stand.stop();
}, 60_000);

describe('the receipt is resolved before mutable preconditions (SPEC.md §9)', () => {
  it('replays every deduplicated mutation resent after its own effect changed the state', async () => {
    const session = await service.sessionOpen({ label: 'f2' });
    const counter = new Counter();

    // -- notebook_create: the second call must not create a second file -----
    const createArgs = {
      sessionId: session.sessionId,
      requestId: counter.value,
      directory: '',
      name: nb('replay')
    } as const;
    const created = await service.notebookCreate(createArgs);
    const createReplay = await service.notebookCreate(createArgs);
    expect(createReplay.replayed).toBe(true);
    expect(createReplay.firstAcceptedAt).toBe(created.firstAcceptedAt);
    expect(createReplay.notebook.notebookId).toBe(created.notebook.notebookId);
    counter.take(created.nextRequestId);
    const notebookId = created.notebook.notebookId;

    const seeded = await service.notebookApply({
      notebookId,
      requestId: counter.value,
      operations: [
        { op: 'add_cell', cellType: 'code', source: 'x = 0', position: 'end' },
        { op: 'add_cell', cellType: 'code', source: 'import time; time.sleep(3)', position: 'end' }
      ]
    });
    counter.take(seeded.nextRequestId);
    const target = seeded.results[0]!;
    const sleeper = seeded.results[1]!;

    // -- notebook_apply: the expected revision has moved on -----------------
    const applyArgs = {
      notebookId,
      requestId: counter.value,
      operations: [
        {
          op: 'replace_source' as const,
          cellId: target.cellId!,
          expectedSourceRevision: target.sourceRevision!,
          source: 'x = 1'
        }
      ]
    };
    const applied = await service.notebookApply(applyArgs);
    const applyReplay = await service.notebookApply(applyArgs);
    expect(applyReplay.replayed).toBe(true);
    expect(applyReplay.firstAcceptedAt).toBe(applied.firstAcceptedAt);
    expect(applyReplay.results).toEqual(applied.results);
    counter.take(applied.nextRequestId);

    // The cell was edited once: a replay is not a second application.
    const afterApply = await service.notebookRead({ notebookId, view: 'cells' });
    expect(afterApply.cells.filter((cell) => cell.source === 'x = 1')).toHaveLength(1);

    // -- kernel_control start: the binding the resend expects is gone -------
    const startArgs = {
      notebookId,
      requestId: counter.value,
      action: 'start' as const,
      expectedKernelId: null,
      kernelName: 'python3'
    };
    const started = await service.kernelControl(startArgs);
    const startReplay = await service.kernelControl(startArgs);
    expect(startReplay.replayed).toBe(true);
    expect(startReplay.firstAcceptedAt).toBe(started.firstAcceptedAt);
    expect(startReplay.kernelId).toBe(started.kernelId);
    counter.take(started.nextRequestId);
    const kernelId = started.kernelId!;
    startedKernels.add(kernelId);

    // Exactly one kernel was started for this notebook.
    const kernels = await apiFetchOk(
      { baseUrl: stand.baseUrl, token: stand.token },
      '/api/sessions'
    );
    expect(
      kernels
        .json<Array<{ path: string; kernel: { id: string } | null }>>()
        .filter((entry) => entry.path === created.notebook.path)
    ).toHaveLength(1);

    await waitIdle(notebookId);

    // -- notebook_execute: the first job is still active --------------------
    const executeArgs = {
      notebookId,
      requestId: counter.value,
      cells: [{ cellId: sleeper.cellId!, expectedSourceRevision: sleeper.sourceRevision! }],
      waitMs: 0
    };
    const job = await service.notebookExecute(executeArgs);
    // The precondition the resend would fail: this notebook has an active job.
    expect(TERMINAL.has(job.state)).toBe(false);
    const executeReplay = await service.notebookExecute(executeArgs);
    expect(executeReplay.replayed).toBe(true);
    expect(executeReplay.firstAcceptedAt).toBe(job.firstAcceptedAt);
    expect(executeReplay.executionId).toBe(job.executionId);
    counter.take(job.nextRequestId);
    expect((await settle(job.executionId)).state).toBe('succeeded');

    // -- kernel_control shutdown: nothing is bound any more -----------------
    const shutdownArgs = {
      notebookId,
      requestId: counter.value,
      action: 'shutdown' as const,
      expectedKernelId: kernelId
    };
    const stopped = await service.kernelControl(shutdownArgs);
    const shutdownReplay = await service.kernelControl(shutdownArgs);
    expect(stopped.kernelId).toBeNull();
    expect(shutdownReplay.replayed).toBe(true);
    expect(shutdownReplay.firstAcceptedAt).toBe(stopped.firstAcceptedAt);
    expect(shutdownReplay.kernelId).toBeNull();
    counter.take(stopped.nextRequestId);

    await service.sessionClose({ sessionId: session.sessionId });
  }, 180_000);

  it('two simultaneous notebook_execute calls of one number run the cell once', async () => {
    const session = await service.sessionOpen({ label: 'f2-race' });
    const counter = new Counter();
    const created = await service.notebookCreate({
      sessionId: session.sessionId,
      requestId: counter.value,
      directory: '',
      name: nb('race')
    });
    counter.take(created.nextRequestId);
    const notebookId = created.notebook.notebookId;

    const seeded = await service.notebookApply({
      notebookId,
      requestId: counter.value,
      operations: [
        { op: 'add_cell', cellType: 'code', source: 'print("once")', position: 'end' }
      ]
    });
    counter.take(seeded.nextRequestId);
    const cell = seeded.results[0]!;

    const started = await service.kernelControl({
      notebookId,
      requestId: counter.value,
      action: 'start',
      expectedKernelId: null,
      kernelName: 'python3'
    });
    counter.take(started.nextRequestId);
    startedKernels.add(started.kernelId!);

    await waitIdle(notebookId);

    const args = {
      notebookId,
      requestId: counter.value,
      cells: [{ cellId: cell.cellId!, expectedSourceRevision: cell.sourceRevision! }],
      waitMs: 0
    };
    const [left, right] = await Promise.all([
      service.notebookExecute(args),
      service.notebookExecute(args)
    ]);
    // One acceptance, one replay, one job.
    expect(left.executionId).toBe(right.executionId);
    expect([left.replayed, right.replayed].filter((flag) => flag === true)).toHaveLength(1);
    expect(left.firstAcceptedAt).toBe(right.firstAcceptedAt);
    counter.take(left.nextRequestId);

    expect((await settle(left.executionId)).state).toBe('succeeded');

    // The kernel ran the cell exactly once: one execution count, one marker.
    const outputs = await service.notebookRead({
      notebookId,
      view: 'outputs',
      cellIds: [cell.cellId!]
    });
    const view = outputs.cells[0]!;
    expect(view.executionCount).toBe(1);
    const streamed = view.outputs
      .map((entry) => entry.output)
      .filter((output) => output?.output_type === 'stream')
      .map((output) => (typeof output!.text === 'string' ? output!.text : output!.text.join('')))
      .join('');
    expect(streamed.match(/once/g) ?? []).toHaveLength(1);

    const stopped = await service.kernelControl({
      notebookId,
      requestId: counter.value,
      action: 'shutdown',
      expectedKernelId: started.kernelId!
    });
    counter.take(stopped.nextRequestId);
    await service.sessionClose({ sessionId: session.sessionId });
  }, 180_000);
});
