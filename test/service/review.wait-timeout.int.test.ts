/**
 * `wait_timed_out` describes the wait that actually happened (SPEC.md §8).
 *
 * The published contract of the field is "true when wait_ms elapsed. The job
 * keeps running; nothing was interrupted" (`src/mcp/schemas.ts`
 * `EXECUTION_VIEW.wait_timed_out`, mirrored by `ExecutionView.waitTimedOut` in
 * `src/core/service.ts`). A job that is already terminal can produce no further
 * change, so `execution_get` with `wait_ms` answers from it at once and reports
 * `wait_timed_out: false` - with and without a cursor.
 *
 * A real kernel is used deliberately: the flag is only reachable through a job
 * that ran on a kernel and reached a terminal state (SPEC.md §8, AGENTS.md).
 *
 * Port 8865 (this module's assigned port).
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { CollabService, ExecutionView } from '../../src/core/index.js';
import { createCollabService } from '../../src/service/index.js';
import { apiFetchOk } from '../helpers/fetch.js';
import { startStand, type Stand } from '../helpers/stand.js';

const PORT = 8865;
const WAIT_MS = 1000;
const TERMINAL = new Set(['succeeded', 'failed', 'cancelled', 'interrupted', 'unknown']);
const RUN = Date.now().toString(36);
const NAME = `f9-${RUN}-wait.ipynb`;

let stand: Stand;
let service: CollabService;

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
  try {
    const target = { baseUrl: stand.baseUrl, token: stand.token };
    const listing = await apiFetchOk(target, '/api/contents/?content=1');
    const entries = listing.json<{ content?: Array<{ path: string }> }>().content ?? [];
    for (const entry of entries) {
      if (!entry.path.startsWith(`f9-${RUN}-`) && !entry.path.startsWith('Untitled')) continue;
      await apiFetchOk(target, `/api/contents/${entry.path}`, { method: 'DELETE' }, [204, 404]);
    }
  } catch {
    // Cleaning the stand is best effort; the run itself already reported.
  }
  await stand.stop();
}, 60_000);

describe('wait_timed_out reports the wait that happened', () => {
  it('answers a terminal job immediately with wait_timed_out false', async () => {
    const session = await service.sessionOpen({});
    let requestId = '1';

    const created = await service.notebookCreate({
      sessionId: session.sessionId,
      requestId,
      directory: '',
      name: NAME
    });
    requestId = created.nextRequestId ?? requestId;
    const notebookId = created.notebook.notebookId;

    const applied = await service.notebookApply({
      notebookId,
      requestId,
      operations: [{ op: 'add_cell', cellType: 'code', source: 'print("f9")', position: 'end' }]
    });
    requestId = applied.nextRequestId ?? requestId;
    const target = applied.results[0]!;

    const started = await service.kernelControl({
      notebookId,
      requestId,
      action: 'start',
      expectedKernelId: null,
      kernelName: 'python3'
    });
    requestId = started.nextRequestId ?? requestId;

    const job = await service.notebookExecute({
      notebookId,
      requestId,
      cells: [{ cellId: target.cellId!, expectedSourceRevision: target.sourceRevision! }],
      waitMs: 200
    });

    // Follow the job to its terminal state; from here nothing can change it.
    let view: ExecutionView = job;
    const deadline = Date.now() + 45_000;
    while (!TERMINAL.has(view.state)) {
      if (Date.now() > deadline) throw new Error(`job stuck in ${view.state}`);
      view = await service.executionGet({
        executionId: job.executionId,
        waitMs: 1000,
        cursor: view.cursor
      });
    }
    expect(view.state).toBe('succeeded');

    const startedAt = Date.now();
    const answered = await service.executionGet({ executionId: job.executionId, waitMs: WAIT_MS });
    const elapsed = Date.now() - startedAt;

    // The call did not wait: it was answered from the finished job at once.
    expect(answered.state).toBe('succeeded');
    expect(elapsed).toBeLessThan(WAIT_MS);
    // So the documented meaning of the flag - "wait_ms elapsed, the job keeps
    // running" - must not be asserted.
    expect(answered.waitTimedOut).toBe(false);

    // The same holds for a cursored read of the finished job: no change can
    // arrive, so the budget is not burned either.
    const cursored = Date.now();
    const again = await service.executionGet({
      executionId: job.executionId,
      waitMs: WAIT_MS,
      cursor: answered.cursor
    });
    expect(Date.now() - cursored).toBeLessThan(WAIT_MS);
    expect(again.state).toBe('succeeded');
    expect(again.waitTimedOut).toBe(false);
  }, 120_000);
});
