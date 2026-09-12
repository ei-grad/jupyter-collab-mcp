/**
 * `CollabService` against the real stand (SPEC.md §4, §6-§10).
 *
 * Everything here is a real JupyterLab 4.6.3 with `jupyter-collaboration`
 * 5.0.2: real Contents calls, a real collaboration room over a WebSocket, a
 * real `python3` kernel bound through the Sessions API. The unit tests fake
 * the socket; this file is the only proof that the composition works.
 *
 * Port 8879 belongs to this file alone.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { isCoreError, type CollabService, type ExecutionView } from '../../src/core/index.js';
import { createCollabService } from '../../src/service/index.js';
import { apiFetchOk } from '../helpers/fetch.js';
import { startStand, type Stand } from '../helpers/stand.js';

const PORT = 8879;
const TERMINAL = new Set(['succeeded', 'failed', 'cancelled', 'interrupted', 'unknown']);
/**
 * The stand keeps its contents root between runs, so every file this suite
 * creates is namespaced. The `Untitled*.ipynb` leftovers of `newUntitled` are
 * removed in `afterAll` - SPEC.md §6 says the service must not delete them.
 */
const RUN = Date.now().toString(36);
const nb = (label: string): string => `svc-${RUN}-${label}.ipynb`;

let stand: Stand;
let service: CollabService;

/** Per-session request counter; the client takes it from the last answer. */
class Counter {
  #next = '1';
  get value(): string {
    return this.#next;
  }
  take(next: string | null): void {
    if (next !== null) this.#next = next;
  }
}

async function codeOf(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
  } catch (error) {
    return isCoreError(error) ? error.code : `other:${String(error)}`;
  }
  return 'no-error';
}

async function settle(executionId: string, timeoutMs = 60_000): Promise<ExecutionView> {
  const deadline = Date.now() + timeoutMs;
  let cursor: string | undefined;
  for (;;) {
    const view = await service.executionGet({
      executionId,
      waitMs: 1000,
      ...(cursor === undefined ? {} : { cursor })
    });
    cursor = view.cursor;
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
  try {
    const target = { baseUrl: stand.baseUrl, token: stand.token };
    const listing = await apiFetchOk(target, '/api/contents/?content=1');
    const entries = listing.json<{ content?: Array<{ path: string }> }>().content ?? [];
    for (const entry of entries) {
      if (!entry.path.startsWith(`svc-${RUN}-`) && !entry.path.startsWith('Untitled')) continue;
      await apiFetchOk(target, `/api/contents/${entry.path}`, { method: 'DELETE' }, [204, 404]);
    }
  } catch {
    // Cleaning the stand is best effort; the run itself already reported.
  }
  await stand.stop();
}, 60_000);

describe('server and session lifecycle', () => {
  it('server_list returns a credential-free descriptor and auto-selects it', async () => {
    const list = await service.serverList();
    expect(list.servers).toHaveLength(1);
    expect(list.servers[0]?.defaultChoice).toBe(true);
    expect(JSON.stringify(list)).not.toContain(stand.token);

    const session = await service.sessionOpen({ label: 'int' });
    expect(session.nextRequestId).toBe('1');
    expect(session.kernelStarted).toBe(false);
    await service.sessionClose({ sessionId: session.sessionId });
  });
});

describe('create, open, read, apply, save', () => {
  it('runs the whole document lifecycle on the real room', async () => {
    const session = await service.sessionOpen({});
    const counter = new Counter();

    // -- create with a chosen name: newUntitled -> Contents PATCH -> open ----
    const created = await service.notebookCreate({
      sessionId: session.sessionId,
      requestId: counter.value,
      directory: '',
      name: nb('int')
    });
    counter.take(created.nextRequestId);
    expect(created.renamed).toBe(true);
    expect(created.notebook.path).toBe(nb('int'));
    expect(created.untitledPath).toMatch(/^Untitled/);
    expect(created.notebook.connectionState).toBe('ready');
    expect(created.notebook.stale).toBe(false);
    expect(created.notebook.documentId).toBe(`json:notebook:${created.notebook.fileId}`);
    expect(created.summary.nbformat).toBe(4);
    const notebookId = created.notebook.notebookId;

    // -- a second create of the same name keeps the untitled file -----------
    const conflictRequestId = counter.value;
    try {
      await service.notebookCreate({
        sessionId: session.sessionId,
        requestId: conflictRequestId,
        directory: '',
        name: nb('int')
      });
      throw new Error('expected ALREADY_EXISTS');
    } catch (error) {
      if (!isCoreError(error)) throw error;
      expect(error.code).toBe('ALREADY_EXISTS');
      expect(error.sideEffects).toBe('applied');
      const details = (error.details ?? {}) as Record<string, unknown>;
      expect(String(details['untitled_path'])).toMatch(/^Untitled/);
      expect(details['room_opened']).toBe(false);
      expect(details['request_accepted']).toBe(true);
      counter.take(details['next_request_id'] as string);
      // The untitled file really stayed on the server.
      const stat = await apiFetchOk(
        { baseUrl: stand.baseUrl, token: stand.token },
        `/api/contents/${String(details['untitled_path'])}?content=0`
      );
      expect(stat.status).toBe(200);
    }

    // -- reopening the same path returns the same handle --------------------
    const reopened = await service.notebookOpen({
      sessionId: session.sessionId,
      path: nb('int')
    });
    expect(reopened.reused).toBe(true);
    expect(reopened.notebook.notebookId).toBe(notebookId);

    // -- apply -------------------------------------------------------------
    const applied = await service.notebookApply({
      notebookId,
      requestId: counter.value,
      operations: [
        { op: 'add_cell', cellType: 'code', source: 'print("service-int")', position: 'end' },
        { op: 'add_cell', cellType: 'markdown', source: '# heading', position: 'end' }
      ]
    });
    counter.take(applied.nextRequestId);
    expect(applied.appliedLocally).toBe(true);
    expect(applied.delivery).toBe('sent');
    expect(applied.persistence).toBe('unconfirmed');
    const codeCellId = applied.results[0]?.cellId;
    expect(codeCellId).toBeTypeOf('string');

    // -- read: three views --------------------------------------------------
    const summary = await service.notebookRead({ notebookId, view: 'summary' });
    expect(summary.summary.cellCount).toBeGreaterThanOrEqual(3);
    expect(summary.changesCursor).toBe(summary.summary.changesCursor);

    const cells = await service.notebookRead({ notebookId, view: 'cells', cellIds: [codeCellId!] });
    expect(cells.cells[0]?.source).toBe('print("service-int")');

    const outputs = await service.notebookRead({ notebookId, view: 'outputs' });
    expect(outputs.cells.length).toBeGreaterThan(0);

    // -- changes ------------------------------------------------------------
    const changes = await service.notebookChanges({
      notebookId,
      cursor: created.changesCursor
    });
    expect(changes.events.some((event) => event.kind === 'cell_added')).toBe(true);

    // -- save ---------------------------------------------------------------
    const saved = await service.notebookSave({ notebookId, timeoutMs: 20_000 });
    expect(saved.saveStatus).toBe('success');
    expect(saved.revisionPersistence).toBe('unknown');
    expect(saved.autosaveEnabled).toBe(true);

    // -- a second working session on the same notebook is a second replica --
    const other = await service.sessionOpen({});
    const mirror = await service.notebookOpen({
      sessionId: other.sessionId,
      path: nb('int')
    });
    expect(mirror.notebook.notebookId).not.toBe(notebookId);
    expect(mirror.notebook.fileId).toBe(created.notebook.fileId);
    const mirrored = await service.notebookRead({
      notebookId: mirror.notebook.notebookId,
      view: 'cells',
      cellIds: [codeCellId!]
    });
    expect(mirrored.cells[0]?.source).toBe('print("service-int")');
    expect(mirror.nextRequestId).toBe('1');

    await service.sessionClose({ sessionId: other.sessionId });
    await service.sessionClose({ sessionId: session.sessionId });
  }, 120_000);
});

describe('kernels and execution', () => {
  it('binds a kernel, executes, pages outputs and reads a snapshot', async () => {
    const session = await service.sessionOpen({});
    const counter = new Counter();
    const created = await service.notebookCreate({
      sessionId: session.sessionId,
      requestId: counter.value,
      directory: '',
      name: nb('exec')
    });
    counter.take(created.nextRequestId);
    const notebookId = created.notebook.notebookId;

    // -- executing without a binding never touches outputs ------------------
    const applied = await service.notebookApply({
      notebookId,
      requestId: counter.value,
      operations: [
        {
          op: 'add_cell',
          cellType: 'code',
          source: [
            'import base64',
            'from IPython.display import display, Image',
            'print("hello from the kernel")',
            'png = base64.b64decode(',
            '    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAA"',
            '    "DUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="',
            ')',
            'display(Image(data=png, format="png"))'
          ].join('\n'),
          position: 'end'
        }
      ]
    });
    counter.take(applied.nextRequestId);
    const cellId = applied.results[0]!.cellId!;
    const revision = applied.results[0]!.sourceRevision!;

    expect(
      await codeOf(() =>
        service.notebookExecute({
          notebookId,
          requestId: counter.value,
          cells: [{ cellId, expectedSourceRevision: revision }]
        })
      )
    ).toBe('KERNEL_NOT_BOUND');

    // -- kernel_status without a binding is an answer, not an error ---------
    const before = await service.kernelStatus({ notebookId });
    expect(before.kernelId).toBeNull();
    expect(before.executionStatus).toBe('unknown');

    // -- start ---------------------------------------------------------------
    const started = await service.kernelControl({
      notebookId,
      requestId: counter.value,
      action: 'start',
      expectedKernelId: null,
      kernelName: 'python3'
    });
    counter.take(started.nextRequestId);
    expect(started.effects.kernelStarted).toBe(true);
    expect(started.effects.outputsCleared).toBe(false);
    expect(started.kernelId).toBeTypeOf('string');
    const kernelId = started.kernelId!;

    // -- an action on the wrong kernel is refused before the number is spent -
    const wrongCode = await codeOf(() =>
      service.kernelControl({
        notebookId,
        requestId: counter.value,
        action: 'interrupt',
        expectedKernelId: 'not-this-kernel'
      })
    );
    expect(wrongCode).toBe('KERNEL_CHANGED');

    // -- a non-code target is rejected before the job is accepted -----------
    const markdown = await service.notebookApply({
      notebookId,
      requestId: counter.value,
      operations: [{ op: 'add_cell', cellType: 'markdown', source: 'note', position: 'end' }]
    });
    counter.take(markdown.nextRequestId);
    expect(
      await codeOf(() =>
        service.notebookExecute({
          notebookId,
          requestId: counter.value,
          cells: [
            {
              cellId: markdown.results[0]!.cellId!,
              expectedSourceRevision: markdown.results[0]!.sourceRevision!
            }
          ]
        })
      )
    ).toBe('INVALID_ARGUMENT');

    // -- execute -------------------------------------------------------------
    const job = await service.notebookExecute({
      notebookId,
      requestId: counter.value,
      cells: [{ cellId, expectedSourceRevision: revision }],
      waitMs: 1000,
      limits: { maxOutputBytes: 64 }
    });
    counter.take(job.nextRequestId);
    expect(job.requestAccepted).toBe(true);
    expect(job.kernelId).toBe(kernelId);

    const finished = await settle(job.executionId);
    expect(finished.state).toBe('succeeded');
    const cell = finished.cells[0]!;
    expect(cell.state).toBe('succeeded');
    expect(cell.sourceChanged).toBe(false);
    expect(cell.cellDeleted).toBe(false);

    // -- the shared document carries the terminal count and idle ------------
    const readOutputs = await service.notebookRead({
      notebookId,
      view: 'outputs',
      cellIds: [cellId],
      limits: { maxBytes: 4 * 1024 * 1024 }
    });
    const view = readOutputs.cells[0]!;
    expect(view.executionCount).toBe(1);
    expect(view.executionState).toBe('idle');
    expect(view.outputs.length).toBeGreaterThanOrEqual(2);
    const streamed = view.outputs
      .map((entry) => entry.output)
      .filter((output) => output?.output_type === 'stream')
      .map((output) => (typeof output.text === 'string' ? output.text : output.text.join('')))
      .join('');
    expect(streamed).toContain('hello from the kernel');
    expect(
      view.outputs.some(
        (entry) =>
          entry.output?.output_type === 'display_data' &&
          Object.keys(entry.output.data).includes('image/png')
      )
    ).toBe(true);

    // -- a small byte budget turns the PNG into a snapshot, not inline base64
    const bounded = await service.executionGet({
      executionId: job.executionId,
      limits: { maxOutputBytes: 64 }
    });
    const snapshotEntry = bounded.cells[0]!.outputs.find((entry) => entry.snapshot !== undefined);
    expect(snapshotEntry).toBeDefined();
    const snapshot = snapshotEntry!.snapshot!;
    expect(snapshot.uri.startsWith('jupyter-output://')).toBe(true);
    expect(snapshot.uri).not.toContain(stand.token);

    const firstChunk = await service.outputRead({
      outputId: snapshot.outputId,
      limits: { maxBytes: 8 }
    });
    expect(firstChunk.byteOffset).toBe(0);
    expect(firstChunk.byteSize).toBe(snapshot.byteSize);
    let assembled = Buffer.from(
      firstChunk.data,
      firstChunk.encoding === 'base64' ? 'base64' : 'utf8'
    );
    let cursor = firstChunk.nextCursor;
    while (cursor !== undefined) {
      const next = await service.outputRead({
        outputId: snapshot.outputId,
        cursor,
        limits: { maxBytes: 8 }
      });
      // A continuation never resends what was already delivered.
      expect(next.byteOffset).toBe(assembled.byteLength);
      assembled = Buffer.concat([
        assembled,
        Buffer.from(next.data, next.encoding === 'base64' ? 'base64' : 'utf8')
      ]);
      cursor = next.nextCursor;
    }
    expect(assembled.byteLength).toBe(snapshot.byteSize);

    // -- the same snapshot serves resources/read and resources/list ---------
    const resource = await service.readOutputResource(snapshot.uri);
    expect(resource.outputId).toBe(snapshot.outputId);
    expect(resource.truncated).toBe(false);
    const resources = await service.listOutputResources();
    expect(resources.resources.some((entry) => entry.outputId === snapshot.outputId)).toBe(true);

    // -- execution_get with the job cursor delivers nothing twice -----------
    const again = await service.executionGet({
      executionId: job.executionId,
      cursor: finished.cursor
    });
    expect(again.cells[0]?.outputs).toHaveLength(0);

    // -- a closed handle with a finished job is allowed ---------------------
    await service.notebookClose({ notebookId });
    await service.sessionClose({ sessionId: session.sessionId });
    expect(await codeOf(() => service.executionGet({ executionId: job.executionId }))).toBe(
      'HANDLE_EXPIRED'
    );
    expect(await codeOf(() => service.outputRead({ outputId: snapshot.outputId }))).toBe(
      'HANDLE_EXPIRED'
    );

    // The kernel outlives every close (SPEC.md §4).
    const kernels = await apiFetchOk({ baseUrl: stand.baseUrl, token: stand.token }, '/api/kernels');
    expect(kernels.json<Array<{ id: string }>>().some((entry) => entry.id === kernelId)).toBe(true);
    await apiFetchOk(
      { baseUrl: stand.baseUrl, token: stand.token },
      `/api/kernels/${kernelId}`,
      { method: 'DELETE' },
      [204, 404]
    );
  }, 180_000);

  it('our own restart invalidates the running job and stops the queue', async () => {
    const session = await service.sessionOpen({});
    const counter = new Counter();
    const created = await service.notebookCreate({
      sessionId: session.sessionId,
      requestId: counter.value,
      directory: '',
      name: nb('restart')
    });
    counter.take(created.nextRequestId);
    const notebookId = created.notebook.notebookId;

    const applied = await service.notebookApply({
      notebookId,
      requestId: counter.value,
      operations: [
        { op: 'add_cell', cellType: 'code', source: 'import time; time.sleep(30)', position: 'end' },
        { op: 'add_cell', cellType: 'code', source: 'print("never")', position: 'end' }
      ]
    });
    counter.take(applied.nextRequestId);

    const started = await service.kernelControl({
      notebookId,
      requestId: counter.value,
      action: 'start',
      expectedKernelId: null,
      kernelName: 'python3'
    });
    counter.take(started.nextRequestId);
    const kernelId = started.kernelId!;

    const job = await service.notebookExecute({
      notebookId,
      requestId: counter.value,
      cells: applied.results.map((result) => ({
        cellId: result.cellId!,
        expectedSourceRevision: result.sourceRevision!
      })),
      waitMs: 500
    });
    counter.take(job.nextRequestId);
    expect(job.state).toBe('running');

    // A close while the job runs is refused (SPEC.md §4).
    expect(await codeOf(() => service.notebookClose({ notebookId }))).toBe('EXECUTION_ACTIVE');
    expect(await codeOf(() => service.sessionClose({ sessionId: session.sessionId }))).toBe(
      'EXECUTION_ACTIVE'
    );

    const restarted = await service.kernelControl({
      notebookId,
      requestId: counter.value,
      action: 'restart',
      expectedKernelId: kernelId
    });
    counter.take(restarted.nextRequestId);
    expect(restarted.effects.kernelRestarted).toBe(true);
    expect(restarted.effects.outputsCleared).toBe(false);
    expect(restarted.effects.invalidatedExecutionIds).toContain(job.executionId);

    const finished = await settle(job.executionId, 30_000);
    expect(['unknown', 'failed', 'interrupted']).toContain(finished.state);
    const first = finished.cells[0]!;
    const second = finished.cells[1]!;
    // The sent cell has no proven result; the queued one provably never ran.
    expect(['unknown', 'aborted', 'failed']).toContain(first.state);
    expect(second.state).toBe('not_sent');
    expect(['kernel_changed', 'kernel_dead', 'stop_on_error', 'cancelled']).toContain(
      second.notSentReason
    );

    const closed = await service.sessionClose({ sessionId: session.sessionId });
    expect(closed.kernelsLeftRunning).toBe(true);
    const kernels = await apiFetchOk({ baseUrl: stand.baseUrl, token: stand.token }, '/api/kernels');
    expect(kernels.json<Array<{ id: string }>>().some((entry) => entry.id === kernelId)).toBe(true);
    await apiFetchOk(
      { baseUrl: stand.baseUrl, token: stand.token },
      `/api/kernels/${kernelId}`,
      { method: 'DELETE' },
      [204, 404]
    );
  }, 180_000);

  it('a kernel that disappears from the server ends the job as unknown', async () => {
    const session = await service.sessionOpen({});
    const counter = new Counter();
    const created = await service.notebookCreate({
      sessionId: session.sessionId,
      requestId: counter.value,
      directory: '',
      name: nb('gone')
    });
    counter.take(created.nextRequestId);
    const notebookId = created.notebook.notebookId;

    const applied = await service.notebookApply({
      notebookId,
      requestId: counter.value,
      operations: [
        { op: 'add_cell', cellType: 'code', source: 'import time; time.sleep(30)', position: 'end' }
      ]
    });
    counter.take(applied.nextRequestId);

    const started = await service.kernelControl({
      notebookId,
      requestId: counter.value,
      action: 'start',
      expectedKernelId: null,
      kernelName: 'python3'
    });
    counter.take(started.nextRequestId);
    const kernelId = started.kernelId!;

    const job = await service.notebookExecute({
      notebookId,
      requestId: counter.value,
      cells: [
        {
          cellId: applied.results[0]!.cellId!,
          expectedSourceRevision: applied.results[0]!.sourceRevision!
        }
      ],
      waitMs: 500
    });
    counter.take(job.nextRequestId);

    // Somebody else kills the kernel; the watchdog notices it is gone.
    await apiFetchOk(
      { baseUrl: stand.baseUrl, token: stand.token },
      `/api/kernels/${kernelId}`,
      { method: 'DELETE' },
      [204, 404]
    );

    const finished = await settle(job.executionId, 30_000);
    expect(['unknown', 'failed']).toContain(finished.state);
    expect(['unknown', 'aborted', 'failed']).toContain(finished.cells[0]!.state);

    const status = await service.kernelStatus({ notebookId });
    expect(status.activeExecutionIds).toHaveLength(0);
    await service.sessionClose({ sessionId: session.sessionId });
  }, 180_000);
});
