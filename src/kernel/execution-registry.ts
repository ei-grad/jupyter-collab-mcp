/**
 * Execution jobs for one kernel (SPEC.md §4 `ExecutionRegistry`, §8 "Jobs").
 *
 * A job is an ordered list of cells. Cells are sent **sequentially**: the next
 * one goes out only after the previous `execute_reply` *and* IOPub `idle`, and
 * only after its own target is re-checked (SPEC.md §8: "The first version
 * sends cells sequentially ... Pipelining is not used"). Jobs of
 * one kernel run one after another for the same reason.
 *
 * The registry owns the difference between "provably did not run" and "may
 * have run": a cell that never reached the kernel is `not_sent` with a reason,
 * a cell whose evidence was lost is `unknown`, and nothing is ever re-sent
 * automatically (SPEC.md §8 "Races, interruption, and connection loss").
 *
 * Three lifetimes are deliberately different:
 *
 * - the **in-flight window** of a cell ends at `reply` + `idle`, or earlier at
 *   a lifecycle event or a channel that stops being `connected`;
 * - its **route** outlives that window, so output produced by a background
 *   thread after `idle` still reaches the cell (SPEC.md §8: "Late outputs after
 *   `idle` continue updating the corresponding output area"). It is
 *   released when the area stops being ours, when the kernel changes, on
 *   disposal, or when {@link LATE_ROUTE_LIMIT} newer executions have finished;
 * - the **output area** we opened stays reachable while `isCurrent()` holds,
 *   because a later `update_display_data` from another cell must find it
 *   (SPEC.md §8: "Display IDs must also be routed across different executions
 *   by this client").
 *
 * @module
 */

import { randomUUID } from 'node:crypto';
import type {
  BeginExecutionGeneration,
  JobState,
  NotSentReason,
  OutputSink,
  SourceRevision
} from '../core/index.js';
import { coreError } from '../core/errors.js';
import type { OutputAreaRef } from './display-registry.js';
import { sameOutputArea } from './display-registry.js';
import type { KernelChangedEvent, KernelClient } from './kernel-client.js';
import type { JobRecord, JobSnapshot, MutableCell } from './job-record.js';
import { finalState, markRest, newCell, snapshotJob } from './job-record.js';
import type { JupyterMessage } from './messages.js';
import {
  createExecutionReducer,
  type ExecutionReducer,
  type ReducerEffect
} from './output-reducer.js';

/** Which notebook replica a job belongs to (SPEC.md §4). */
export interface NotebookRef {
  readonly notebookId: string;
  /** MCP working session that owns the job. */
  readonly sessionId: string;
}
/** One requested cell, addressed by id and pinned to a revision (§8). */
export interface ExecutionCellRequest {
  readonly cellId: string;
  readonly sourceRevision: SourceRevision;
}

/**
 * Answer of the just-before-send re-check (SPEC.md §8: "Immediately before
 * sending each cell, its existence and revision are checked again").
 *
 * `identityToken` identifies the CRDT object, not the string id: an external
 * write can replace the `Y.Map` while keeping `cell_id` (SPEC.md §6).
 */
export type RevalidateResult =
  | { readonly ok: true; readonly source: string; readonly identityToken: string }
  | { readonly ok: false; readonly code: NotSentReason };

/** Provided by the notebook model; must not await inside. */
export type Revalidate = (cellId: string, expected: SourceRevision) => RevalidateResult;

/** One accepted `notebook_execute` job (SPEC.md §8 "Jobs"). */
export interface SubmitRequest {
  readonly notebookRef: NotebookRef;
  readonly cells: readonly ExecutionCellRequest[];
  /**
   * Begins a new output-area generation and returns its sink, in one shared
   * model transaction (SPEC.md §8). `null` means the cell is gone.
   */
  readonly getSink: BeginExecutionGeneration;
  readonly revalidate: Revalidate;
  /** Default `true`: an error stops our queue too (SPEC.md §8). */
  readonly stopOnError?: boolean;
  /** Per-cell output budget; see `DEFAULT_MAX_OUTPUT_BYTES`. */
  readonly maxOutputBytes?: number;
}

/** How one in-flight cell ended. */
type CellOutcome = 'completed' | 'kernel_changed' | 'disconnected' | 'disposed';

/**
 * Output areas kept reachable at once. Stale ones are dropped first, so the
 * cap is only reached by a notebook with that many cells whose latest output
 * generation is still live.
 */
const AREA_CACHE_LIMIT = 1024;

/** Finished executions still listening for late output (SPEC.md §8). */
const LATE_ROUTE_LIMIT = 128;

/** An output area we opened, together with the job record that owns it. */
interface OwnedArea {
  readonly sink: OutputSink;
  readonly job: JobRecord<SubmitRequest>;
  readonly cell: MutableCell;
}

/** A route kept alive after completion, for output from background threads. */
interface LateRoute {
  readonly sink: OutputSink;
  /** Idempotent; also removes the entry from the registry's set. */
  readonly release: () => void;
}

function areaKey(area: OutputAreaRef): string {
  return `${area.notebookId} ${area.cellId} ${area.generation}`;
}

/** Why a cell stopped without completion evidence (SPEC.md §8). */
const REASON_OF: Readonly<Record<Exclude<CellOutcome, 'completed'>, string>> = {
  disconnected: 'kernel channel was lost after the request was sent',
  kernel_changed: 'kernel lifecycle event invalidated the job',
  disposed: 'the kernel connection was released while the request was in flight'
};

function now(): string {
  return new Date().toISOString();
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Sequential job runner for one {@link KernelClient} (SPEC.md §4, §8). */
export class ExecutionRegistry {
  readonly #kernel: KernelClient;
  readonly #jobs = new Map<string, JobRecord<SubmitRequest>>();
  readonly #queue: Array<JobRecord<SubmitRequest>> = [];
  /** Output areas we opened, so cross-execution display updates find them. */
  readonly #areas = new Map<string, OwnedArea>();
  /** Routes of finished executions, still open for late output (SPEC.md §8). */
  readonly #lateRoutes = new Set<LateRoute>();
  readonly #unsubscribe: Array<() => void> = [];
  #kernelEpoch = 0;
  #running = false;
  #disposed = false;
  /** Set while one cell is in flight; used to end it early. */
  #inFlight: ((outcome: CellOutcome) => void) | null = null;

  constructor(kernel: KernelClient) {
    this.#kernel = kernel;
    this.#unsubscribe.push(
      kernel.onKernelChanged((event: KernelChangedEvent) => {
        // Every reason invalidates in-flight work, `disposed` included: the
        // socket that would carry the evidence is gone (SPEC.md §8).
        this.#kernelEpoch += 1;
        this.#releaseLateRoutes();
        this.#areas.clear();
        this.#inFlight?.(event.reason === 'disposed' ? 'disposed' : 'kernel_changed');
      })
    );
    this.#unsubscribe.push(
      kernel.onStatusChanged((status) => {
        // A dropped socket is reported as `connecting` first;
        // `@jupyterlab/services` reaches `disconnected` only after seven
        // backoff attempts, and everything the kernel sent meanwhile is lost.
        // Waiting for `disconnected` would leave the cell - and the whole
        // queue behind it - in flight for ever, so any state that is not
        // `connected` ends the evidence (SPEC.md §8: "Losing the kernel
        // connection after sending produces `unknown`").
        if (status.channel !== 'connected') this.#inFlight?.('disconnected');
      })
    );
  }

  /**
   * Accept a job and return its `execution_id` (SPEC.md §9 `notebook_execute`).
   * The list must be non-empty; the caller has already rejected non-code cells.
   */
  submit(request: SubmitRequest): string {
    if (this.#disposed) throw coreError('HANDLE_EXPIRED', 'execution registry is disposed');
    if (request.cells.length === 0) {
      throw coreError('INVALID_ARGUMENT', 'notebook_execute requires a non-empty cell list');
    }
    const executionId = `exec_${randomUUID()}`;
    const job: JobRecord<SubmitRequest> = {
      executionId,
      request,
      notebookId: request.notebookRef.notebookId,
      sessionId: request.notebookRef.sessionId,
      kernelId: this.#kernel.kernelId,
      kernelEpoch: this.#kernelEpoch,
      stopOnError: request.stopOnError ?? true,
      createdAt: now(),
      state: 'queued',
      cells: request.cells.map((cell) => newCell(cell.cellId, cell.sourceRevision)),
      cursor: 0,
      cancelRequested: false,
      waiters: new Set()
    };
    this.#jobs.set(executionId, job);
    this.#queue.push(job);
    this.#start();
    return executionId;
  }

  /** Current snapshot of a job, or `undefined` for an unknown id. */
  get(executionId: string): JobSnapshot | undefined {
    const job = this.#jobs.get(executionId);
    return job === undefined ? undefined : snapshotJob(job);
  }

  /**
   * Drop the cells that were not sent yet (SPEC.md §8: "execution_cancel
   * removes job cells that have not yet been sent"). A cell already handed to the
   * kernel is never called cancelled - interrupting is a separate, kernel-wide
   * operation.
   */
  cancel(executionId: string): JobSnapshot {
    const job = this.#jobs.get(executionId);
    if (job === undefined) throw coreError('HANDLE_EXPIRED', 'unknown execution_id');
    job.cancelRequested = true;
    for (const cell of job.cells) {
      if (cell.state !== 'queued') continue;
      cell.state = 'not_sent';
      cell.notSentReason = 'cancelled';
    }
    const queueIndex = this.#queue.indexOf(job);
    if (queueIndex >= 0) this.#queue.splice(queueIndex, 1);
    if (job.state === 'queued') this.#finish(job, 'cancelled', 'cancelled before any cell was sent');
    else this.#bump(job);
    return snapshotJob(job);
  }

  /**
   * Wait until the job changes (SPEC.md §8 `execution_get`): a new state, a new
   * record or new outputs. Returns at once when `sinceCursor` is already
   * behind. Waiting never blocks other jobs - it is a promise, not a lock.
   */
  async waitForChange(
    executionId: string,
    sinceCursor: number,
    waitMs: number
  ): Promise<JobSnapshot> {
    const job = this.#jobs.get(executionId);
    if (job === undefined) throw coreError('HANDLE_EXPIRED', 'unknown execution_id');
    if (job.cursor > sinceCursor || waitMs <= 0) return snapshotJob(job);
    await new Promise<void>((resolve) => {
      let done = false;
      const settle = (): void => {
        if (done) return;
        done = true;
        job.waiters.delete(settle);
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(settle, waitMs);
      timer.unref?.();
      job.waiters.add(settle);
    });
    return snapshotJob(job);
  }

  /**
   * Release listeners and routes. Running work becomes `unknown`, work that
   * was never sent becomes `not_sent`/`cancelled`; nothing is ever re-sent.
   * No job is left waiting for an answer that can no longer arrive
   * (SPEC.md §4: "stops accepting jobs ... and releases connections").
   */
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const off of this.#unsubscribe.splice(0)) off();
    this.#inFlight?.('disposed');
    this.#releaseLateRoutes();
    this.#areas.clear();
    for (const job of this.#queue.splice(0)) {
      markRest(job, 0, 'cancelled');
      this.#finish(job, finalState(job), 'registry disposed before the job started');
    }
  }

  // -- internals ------------------------------------------------------------

  /**
   * Start the pump without ever producing an unhandled rejection: one would
   * kill the whole MCP process, taking every live replica with it. Per-job
   * failures are recorded on the job inside {@link ExecutionRegistry.#pump}.
   */
  #start(): void {
    void this.#pump().catch(() => undefined);
  }

  #bump(job: JobRecord<SubmitRequest>): void {
    job.cursor += 1;
    for (const waiter of [...job.waiters]) waiter();
  }

  #finish(job: JobRecord<SubmitRequest>, state: JobState, reason?: string): void {
    job.state = state;
    job.finishedAt = now();
    if (reason !== undefined && job.reason === undefined) job.reason = reason;
    this.#bump(job);
  }

  async #pump(): Promise<void> {
    if (this.#running) return;
    this.#running = true;
    try {
      for (;;) {
        const job = this.#queue.shift();
        if (job === undefined) break;
        try {
          await this.#runJob(job);
        } catch (error) {
          // Only a caller-supplied callback (`revalidate` / `getSink`) can get
          // here. The job must still reach a terminal state, and the queue of
          // this kernel must keep running (SPEC.md §8, §9).
          this.#abandon(job, error);
        }
      }
    } finally {
      this.#running = false;
    }
  }

  /** Terminal state for a job whose own callbacks threw. */
  #abandon(job: JobRecord<SubmitRequest>, error: unknown): void {
    for (const cell of job.cells) {
      if (cell.state === 'queued') {
        cell.state = 'not_sent';
        // The notebook replica could not answer, so nothing was ever sent.
        cell.notSentReason = 'rtc_not_ready';
      } else if (cell.state === 'sent') {
        cell.state = 'unknown';
      }
    }
    job.reason ??= `job aborted by an internal error: ${describe(error)}`;
    if (job.state !== 'queued' && job.state !== 'running') {
      this.#bump(job);
      return;
    }
    this.#finish(job, finalState(job));
  }

  async #runJob(job: JobRecord<SubmitRequest>): Promise<void> {
    if (this.#disposed) {
      markRest(job, 0, 'cancelled');
      this.#finish(job, finalState(job), 'registry disposed before the job started');
      return;
    }
    job.state = 'running';
    this.#bump(job);

    for (let index = 0; index < job.cells.length; index += 1) {
      const cell = job.cells[index];
      if (cell === undefined) continue;
      if (job.cancelRequested) {
        markRest(job, index, 'cancelled');
        break;
      }
      if (job.kernelEpoch !== this.#kernelEpoch) {
        markRest(job, index, 'kernel_changed');
        job.reason ??= 'kernel restarted, shut down or died before this cell was sent';
        break;
      }
      const check = job.request.revalidate(cell.cellId, cell.sourceRevision);
      if (!check.ok) {
        cell.state = 'not_sent';
        cell.notSentReason = check.code;
        markRest(job, index + 1, 'stop_on_error');
        job.reason = `target check failed for ${cell.cellId}: ${check.code}`;
        break;
      }
      cell.sourceSnapshot = check.source;
      cell.identityToken = check.identityToken;

      const sink = job.request.getSink(cell.cellId);
      if (sink === null) {
        cell.state = 'not_sent';
        cell.notSentReason = 'cell_not_found';
        cell.cellDeleted = true;
        markRest(job, index + 1, 'stop_on_error');
        job.reason = `output area of ${cell.cellId} could not be opened`;
        break;
      }
      this.#rememberArea(
        { notebookId: job.notebookId, cellId: cell.cellId, generation: sink.generation },
        { sink, job, cell }
      );

      const outcome = await this.#runCell(job, cell, sink);
      this.#bump(job);
      if (outcome !== 'completed') {
        markRest(job, index + 1, 'kernel_changed');
        job.reason ??= REASON_OF[outcome];
        break;
      }
      if (job.stopOnError && (cell.state === 'failed' || cell.state === 'aborted')) {
        markRest(job, index + 1, 'stop_on_error');
        break;
      }
    }

    if (job.state === 'running') this.#finish(job, finalState(job));
    else this.#bump(job);
  }

  /**
   * Keep the sink of a live output-area generation reachable.
   *
   * The lifetime is the generation's, not a fixed number of executions: a
   * `update_display_data` sent much later must still find the area that shows
   * that `display_id` (SPEC.md §8). Stale generations are dropped first, so
   * the table holds at most one live area per cell. A superseded generation is
   * deliberately *not* removed from the kernel's `DisplayRegistry`: keeping the
   * target resolvable is what turns a write into a reported, rather than
   * silent, loss in {@link ExecutionRegistry.#applyEffect}.
   */
  #rememberArea(area: OutputAreaRef, owned: OwnedArea): void {
    for (const [key, entry] of [...this.#areas]) {
      if (!entry.sink.isCurrent()) this.#areas.delete(key);
    }
    while (this.#areas.size >= AREA_CACHE_LIMIT) {
      const oldest = this.#areas.keys().next();
      if (oldest.done) break;
      this.#areas.delete(oldest.value);
    }
    this.#areas.set(areaKey(area), owned);
  }

  /** Keep a finished execution's route open for late output (SPEC.md §8). */
  #keepLateRoute(route: LateRoute): void {
    for (const entry of [...this.#lateRoutes]) {
      if (!entry.sink.isCurrent()) entry.release();
    }
    while (this.#lateRoutes.size >= LATE_ROUTE_LIMIT) {
      const oldest = this.#lateRoutes.values().next();
      if (oldest.done) break;
      oldest.value.release();
    }
    this.#lateRoutes.add(route);
  }

  #releaseLateRoutes(): void {
    for (const entry of [...this.#lateRoutes]) entry.release();
    this.#lateRoutes.clear();
  }

  /** Send one cell and wait for its completion evidence (SPEC.md §8). */
  async #runCell(job: JobRecord<SubmitRequest>, cell: MutableCell, sink: OutputSink): Promise<CellOutcome> {
    const area: OutputAreaRef = {
      notebookId: job.notebookId,
      cellId: cell.cellId,
      generation: sink.generation
    };
    cell.generation = sink.generation;

    let reducer: ExecutionReducer | null = null;
    const buffered: JupyterMessage[] = [];
    let settle: ((outcome: CellOutcome) => void) | null = null;
    const finished = new Promise<CellOutcome>((resolve) => {
      settle = (outcome: CellOutcome): void => {
        settle = null;
        resolve(outcome);
      };
    });
    this.#inFlight = (outcome) => settle?.(outcome);

    let release: () => void = () => undefined;
    let completed = false;
    let released = false;
    const late: LateRoute = {
      sink,
      release: () => {
        this.#lateRoutes.delete(late);
        if (released) return;
        released = true;
        release();
      }
    };

    const consume = (msg: JupyterMessage): void => {
      if (reducer === null) {
        buffered.push(msg);
        return;
      }
      for (const effect of reducer.feed(msg)) {
        this.#applyEffect(effect, cell, area);
        if (effect.kind === 'complete') {
          completed = true;
          settle?.('completed');
        }
      }
      cell.outputsCollected = [...reducer.state.outputs];
      cell.outputIncomplete = reducer.state.outputIncomplete;
      this.#bump(job);
      // After completion the route lives only for as long as the area it
      // writes into is still ours (SPEC.md §8: "until replaced by a subsequent
      // execution/clear/delete/close").
      if (completed && !sink.isCurrent()) late.release();
    };

    try {
      const sent = this.#kernel.requestExecute(cell.sourceSnapshot, {
        cellId: cell.cellId,
        route: consume,
        stopOnError: job.stopOnError
      });
      release = sent.release;
      cell.msgId = sent.msgId;
      cell.state = 'sent';
      reducer = createExecutionReducer({
        area,
        msgId: sent.msgId,
        displays: this.#kernel.displays,
        ...(job.request.maxOutputBytes === undefined
          ? {}
          : { maxOutputBytes: job.request.maxOutputBytes })
      });
      this.#bump(job);
      for (const msg of buffered.splice(0)) consume(msg);

      const outcome = await finished;
      this.#recordOutcome(job, cell, reducer, outcome);
      return outcome;
    } catch (error) {
      // `KernelClient.requestExecute` throws only before anything reaches the
      // socket, so a cell without a `msg_id` provably never ran; anything
      // later may have run (SPEC.md §8: "Sent work without a proven result
      // becomes `unknown`; unsent work gets `not_sent`").
      if (cell.msgId === undefined) {
        cell.state = 'not_sent';
        cell.notSentReason = 'kernel_dead';
      } else {
        cell.state = 'unknown';
      }
      job.reason = `execute_request failed: ${describe(error)}`;
      return 'kernel_changed';
    } finally {
      this.#inFlight = null;
      if (completed && !released && sink.isCurrent()) this.#keepLateRoute(late);
      else late.release();
    }
  }

  #recordOutcome(
    job: JobRecord<SubmitRequest>,
    cell: MutableCell,
    reducer: ExecutionReducer,
    outcome: CellOutcome
  ): void {
    const state = reducer.state;
    cell.outputsCollected = [...state.outputs];
    cell.outputIncomplete = state.outputIncomplete;
    cell.executionCount = state.executionCount;

    if (outcome !== 'completed') {
      // Transport or lifecycle evidence was lost: "may have run" (SPEC.md §8).
      cell.state = 'unknown';
      return;
    }
    if (state.status === 'aborted') {
      cell.state = 'aborted';
      cell.abortedReason = 'kernel_aborted';
    } else if (state.status === 'error') {
      if (state.errorName === 'KeyboardInterrupt') {
        cell.state = 'aborted';
        cell.abortedReason = 'interrupted';
      } else {
        cell.state = 'failed';
      }
    } else {
      cell.state = 'succeeded';
    }

    // The snapshot that was sent never changes; the flag says the cell text has
    // moved on since (SPEC.md §8: "the result is marked source_changed").
    // A throwing `revalidate` must not undo a decided outcome.
    let after: RevalidateResult;
    try {
      after = job.request.revalidate(cell.cellId, cell.sourceRevision);
    } catch {
      return;
    }
    if (!after.ok) {
      if (after.code === 'revision_conflict') cell.sourceChanged = true;
      if (after.code === 'cell_not_found' || after.code === 'cell_replaced') cell.cellDeleted = true;
    }
  }

  /**
   * Apply one reducer effect, but only while the target area is still live.
   *
   * A write that cannot be applied - our own area was taken over, or a
   * `display_id` points at a generation that a newer execution replaced -
   * stops there and is recorded on the job that produced it (SPEC.md §8: "In
   * an ambiguous race, the result is retained by the job and writing to the
   * shared output area stops").
   */
  #applyEffect(effect: ReducerEffect, cell: MutableCell, own: OutputAreaRef): void {
    if (effect.kind === 'complete') return;
    const key = areaKey(effect.target);
    const entry = this.#areas.get(key);
    if (entry === undefined || !entry.sink.isCurrent()) {
      if (entry !== undefined) this.#areas.delete(key);
      cell.outputAreaLost = true;
      return;
    }
    const sink = entry.sink;
    let applied = false;
    switch (effect.kind) {
      case 'append':
        applied = sink.appendOutput(effect.output);
        break;
      case 'update':
        applied = sink.updateOutput(effect.target.index, effect.output);
        break;
      case 'replace':
        applied = sink.setOutputs([...effect.outputs]);
        break;
      case 'clear':
        applied = sink.clearOutputs();
        break;
      case 'setCount':
        applied = sink.setExecutionCount(effect.executionCount);
        break;
      case 'setState':
        applied = sink.setExecutionState(effect.state);
        break;
    }
    if (!applied) {
      cell.outputAreaLost = true;
      return;
    }
    // A cross-cell `update_display_data` also changes what the *owning* job
    // should report: `execution_get` on it must not keep answering with the
    // superseded MIME bundle (SPEC.md §12 "Outputs").
    if (!sameOutputArea(effect.target, own) && entry.cell !== cell) {
      entry.cell.outputsCollected = sink.getOutputs();
      this.#bump(entry.job);
    }
  }
}
