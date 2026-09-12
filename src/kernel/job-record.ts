/**
 * Mutable bookkeeping behind an {@link ExecutionJob} (SPEC.md §8 "Jobs").
 *
 * `src/core` declares the immutable shapes the rest of the process reads.
 * The registry needs a mutable twin plus a change cursor, so this module holds
 * the internal record and the pure functions that convert it back into the
 * shared contract. Nothing here performs I/O.
 *
 * @module
 */

import type {
  CellExecutionRecord,
  ExecutionJob,
  JobState,
  NbOutput,
  NotSentReason,
  SourceRevision
} from '../core/index.js';

/**
 * A job's cell record. Extends the shared contract with the one fact only the
 * registry can know: the output area stopped being ours mid-flight, so the
 * results live on the job alone (SPEC.md §8: "the result is retained by the
 * job, and writing to the shared output area stops").
 */
export interface KernelCellRecord extends CellExecutionRecord {
  readonly outputAreaLost: boolean;
  /** CRDT identity captured at send time, from the pre-send re-check. */
  readonly identityToken?: string;
}

/**
 * An {@link ExecutionJob} whose cells carry the registry's extra fields. It is
 * assignable to `ExecutionJob`, so the MCP adapter can keep the core type.
 */
export interface KernelExecutionJob extends Omit<ExecutionJob, 'cells'> {
  readonly cells: readonly KernelCellRecord[];
}

/** Snapshot of a job plus its change cursor (SPEC.md §8 `execution_get`). */
export interface JobSnapshot {
  readonly job: KernelExecutionJob;
  /** Monotonic counter of record changes; the cursor of `waitForChange`. */
  readonly cursor: number;
}

/** Mutable twin of {@link KernelCellRecord}. */
export interface MutableCell {
  cellId: string;
  sourceSnapshot: string;
  sourceRevision: SourceRevision;
  msgId?: string;
  state: CellExecutionRecord['state'];
  outputsCollected: NbOutput[];
  sourceChanged: boolean;
  cellDeleted: boolean;
  outputIncomplete: boolean;
  outputAreaLost: boolean;
  generation?: number;
  executionCount?: number | null;
  notSentReason?: NotSentReason;
  abortedReason?: CellExecutionRecord['abortedReason'];
  identityToken?: string;
}

/** Mutable twin of {@link ExecutionJob}, plus queue and waiter state. */
export interface JobRecord<TRequest> {
  readonly executionId: string;
  readonly request: TRequest;
  readonly notebookId: string;
  readonly sessionId: string;
  readonly kernelId: string | null;
  /** Kernel identity generation at acceptance; a change invalidates the job. */
  readonly kernelEpoch: number;
  readonly stopOnError: boolean;
  readonly createdAt: string;
  state: JobState;
  finishedAt?: string;
  reason?: string;
  cells: MutableCell[];
  cursor: number;
  cancelRequested: boolean;
  waiters: Set<() => void>;
}

/** A queued cell record, before anything is known about it. */
export function newCell(cellId: string, sourceRevision: SourceRevision): MutableCell {
  return {
    cellId,
    sourceSnapshot: '',
    sourceRevision,
    state: 'queued',
    outputsCollected: [],
    sourceChanged: false,
    cellDeleted: false,
    outputIncomplete: false,
    outputAreaLost: false
  };
}

/** Convert one mutable cell into the immutable contract shape. */
export function snapshotCell(cell: MutableCell): KernelCellRecord {
  return {
    cellId: cell.cellId,
    sourceSnapshot: cell.sourceSnapshot,
    sourceRevision: cell.sourceRevision,
    state: cell.state,
    outputsCollected: [...cell.outputsCollected],
    sourceChanged: cell.sourceChanged,
    cellDeleted: cell.cellDeleted,
    outputIncomplete: cell.outputIncomplete,
    outputAreaLost: cell.outputAreaLost,
    ...(cell.msgId === undefined ? {} : { msgId: cell.msgId }),
    ...(cell.generation === undefined ? {} : { generation: cell.generation }),
    ...(cell.executionCount === undefined ? {} : { executionCount: cell.executionCount }),
    ...(cell.notSentReason === undefined ? {} : { notSentReason: cell.notSentReason }),
    ...(cell.abortedReason === undefined ? {} : { abortedReason: cell.abortedReason }),
    ...(cell.identityToken === undefined ? {} : { identityToken: cell.identityToken })
  };
}

/** Convert one job record into an {@link ExecutionJob} plus its cursor. */
export function snapshotJob<T>(job: JobRecord<T>): JobSnapshot {
  const snapshot: KernelExecutionJob = {
    executionId: job.executionId,
    notebookId: job.notebookId,
    sessionId: job.sessionId,
    kernelId: job.kernelId,
    state: job.state,
    stopOnError: job.stopOnError,
    cells: job.cells.map(snapshotCell),
    createdAt: job.createdAt,
    ...(job.finishedAt === undefined ? {} : { finishedAt: job.finishedAt }),
    ...(job.reason === undefined ? {} : { reason: job.reason })
  };
  return { job: snapshot, cursor: job.cursor };
}

/**
 * Mark every still-queued cell from `fromIndex` as `not_sent` with `reason`
 * (SPEC.md §8: "skipped cells are marked `not_sent`").
 */
export function markRest<T>(job: JobRecord<T>, fromIndex: number, reason: NotSentReason): void {
  for (let i = fromIndex; i < job.cells.length; i += 1) {
    const cell = job.cells[i];
    if (cell === undefined || cell.state !== 'queued') continue;
    cell.state = 'not_sent';
    cell.notSentReason = reason;
  }
}

/**
 * Terminal job state derived from its cells (SPEC.md §8). Uncertainty wins
 * over failure, and an interrupt is reported as its own outcome.
 */
export function finalState<T>(job: JobRecord<T>): JobState {
  const cells = job.cells;
  if (cells.some((c) => c.state === 'unknown')) return 'unknown';
  if (cells.some((c) => c.abortedReason === 'interrupted')) return 'interrupted';
  if (cells.some((c) => c.state === 'failed' || c.state === 'aborted')) return 'failed';
  if (cells.some((c) => c.state === 'not_sent' && c.notSentReason === 'cancelled')) {
    return 'cancelled';
  }
  if (cells.some((c) => c.state === 'not_sent')) return 'failed';
  return 'succeeded';
}
