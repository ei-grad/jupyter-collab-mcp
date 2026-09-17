/**
 * Job bookkeeping above `src/kernel` (SPEC.md §8, §9).
 *
 * `ExecutionRegistry` runs the queue and collects outputs but deliberately
 * never touches Yjs: it does not write the terminal `execution_count` and
 * `execution_state: 'idle'`. That is this module's job, and it is the reason
 * for the watcher below: JupyterLab 4.6.3 renders `[*]` from the shared
 * `execution_state`, and it reacts to a remote non-null `execution_count` by
 * writing `idle` back, so the count may be published **only** in the final
 * transaction of a cell (spike / dev/browser notes, SPEC.md §8).
 *
 * The module also owns the `execution_get` cursor. A job's cell list is fixed
 * at submission, so the cursor is simply the registry change counter plus the
 * output-state version and the number of entries delivered from that version.
 * A mutable stream, display update or clear starts a new version; pagination
 * within an unchanged version still never retransmits an entry.
 *
 * @module
 */

import {
  coreError,
  type CellRunState,
  type ExecutionCellView,
  type ExecutionCursor,
  type ExecutionView,
  type JobState,
  type NbOutput,
  type OutputEntry,
  type ResponseLimits,
  type ServiceLimits
} from '../core/index.js';
import type { ExecutionRegistry, JobSnapshot, KernelCellRecord } from '../kernel/index.js';
import type { NotebookHandle } from './notebook-handle.js';
import { HANDLE_LIFETIME } from './notebook-handle.js';
import {
  SNAPSHOT_LIFETIME,
  mimeTypesOf,
  nbText,
  outputByteSize,
  type OutputStore
} from './outputs.js';

/** Job states that no longer change by themselves (SPEC.md §8). */
export const TERMINAL_JOB_STATES: ReadonlySet<JobState> = new Set<JobState>([
  'succeeded',
  'failed',
  'cancelled',
  'interrupted',
  'unknown'
]);

/** Cell states that mean the kernel is done with this cell. */
const FINISHED_CELL_STATES: ReadonlySet<CellRunState> = new Set<CellRunState>([
  'succeeded',
  'failed',
  'aborted',
  'unknown'
]);

/** What the working session keeps about one accepted job. */
export interface ExecutionRecord {
  readonly executionId: string;
  readonly sessionId: string;
  readonly notebookId: string;
  /** Kernel identity captured at acceptance; a change invalidates the job. */
  readonly kernelId: string | null;
  readonly registry: ExecutionRegistry;
  readonly handle: NotebookHandle;
  readonly createdAt: string;
  /** `cellId -> generation` already closed with `finishExecution`. */
  readonly finished: Map<string, number>;
  /** Set once an observed kernel change invalidated the job (SPEC.md §8). */
  invalidated: boolean;
  /** Stops the completion watcher; idempotent. */
  stop(): void;
}

/** `true` while the job may still change on its own. */
export function isActive(record: ExecutionRecord): boolean {
  const snapshot = record.registry.get(record.executionId);
  if (snapshot === undefined) return false;
  return !TERMINAL_JOB_STATES.has(snapshot.job.state);
}

/**
 * Write the terminal `execution_count` + `idle` of every cell the kernel has
 * finished, while this generation still owns the output area (SPEC.md §8).
 *
 * Called from the watcher on every job change, so `[*]` disappears as soon as
 * the cell completes and not only when the whole job ends.
 */
export function finishCompletedCells(record: ExecutionRecord, snapshot: JobSnapshot): void {
  for (const cell of snapshot.job.cells) {
    if (!FINISHED_CELL_STATES.has(cell.state)) continue;
    if (cell.generation === undefined) continue;
    if (record.finished.get(cell.cellId) === cell.generation) continue;
    record.finished.set(cell.cellId, cell.generation);
    if (record.handle.closed) continue;
    try {
      const sink = record.handle.model.sinkFor(cell.cellId);
      if (sink === null || sink.generation !== cell.generation) continue;
      record.handle.model.finishExecution(sink, { count: cell.executionCount ?? null });
    } catch {
      // The replica was released, or the area is no longer ours. The result
      // stays on the job; nothing is recreated for it (SPEC.md §8).
    }
  }
}

/**
 * Follow a job until it reaches a terminal state, closing each cell's output
 * generation as it completes.
 *
 * Never rejects: an unhandled rejection here would take the whole MCP process
 * - and every live replica - down with it.
 */
export function watchJob(record: ExecutionRecord, stopped: () => boolean): void {
  void (async (): Promise<void> => {
    let cursor = -1;
    for (;;) {
      if (stopped()) return;
      let snapshot: JobSnapshot;
      try {
        snapshot = await record.registry.waitForChange(record.executionId, cursor, 250);
      } catch {
        return;
      }
      cursor = snapshot.cursor;
      finishCompletedCells(record, snapshot);
      if (TERMINAL_JOB_STATES.has(snapshot.job.state)) return;
    }
  })().catch(() => undefined);
}

// ---------------------------------------------------------------------------
// the execution cursor
// ---------------------------------------------------------------------------

const CURSOR_PREFIX = 'exc_';

/** One cell position encoded in an execution cursor. */
export interface ExecutionOutputPosition {
  readonly version: number;
  readonly delivered: number;
}

/** Build the cursor of an answer: registry position plus per-cell positions. */
export function makeExecutionCursor(
  registryCursor: number,
  positions: readonly ExecutionOutputPosition[]
): ExecutionCursor {
  return `${CURSOR_PREFIX}${registryCursor}.${positions
    .map(({ version, delivered }) => `${version}:${delivered}`)
    .join('-')}` as ExecutionCursor;
}

/** What one parsed execution cursor says. */
export interface ParsedExecutionCursor {
  /** Registry change counter the previous answer was taken at. */
  readonly registryCursor: number;
  /** Output version and entries already delivered, per cell, in job order. */
  readonly positions: readonly ExecutionOutputPosition[];
}

/**
 * Parse one.
 *
 * @throws CoreError `CURSOR_EXPIRED` - not one of ours, or it describes a
 * different number of cells than the job has, so the caller must re-read the
 * job without a cursor.
 */
export function parseExecutionCursor(value: string, cellCount: number): ParsedExecutionCursor {
  const fail = (): never => {
    throw coreError('CURSOR_EXPIRED', 'this execution cursor does not match the job', {
      details: { cursor: value }
    });
  };
  if (!value.startsWith(CURSOR_PREFIX)) return fail();
  const body = value.slice(CURSOR_PREFIX.length);
  const dot = body.indexOf('.');
  if (dot < 0) return fail();
  const head = body.slice(0, dot);
  if (!/^(0|[1-9][0-9]*)$/.test(head)) return fail();
  const registryCursor = Number(head);
  if (!Number.isSafeInteger(registryCursor)) return fail();
  const counts = body.slice(dot + 1);
  const parts = counts === '' ? [] : counts.split('-');
  if (parts.length !== cellCount) return fail();
  const positions: ExecutionOutputPosition[] = [];
  for (const part of parts) {
    const match = /^(0|[1-9][0-9]*):(0|[1-9][0-9]*)$/.exec(part);
    if (match === null) return fail();
    const version = Number(match[1]);
    const delivered = Number(match[2]);
    if (!Number.isSafeInteger(version) || !Number.isSafeInteger(delivered)) return fail();
    positions.push({ version, delivered });
  }
  return { registryCursor, positions };
}

// ---------------------------------------------------------------------------
// the view
// ---------------------------------------------------------------------------

/** Options of {@link buildExecutionView}. */
export interface ExecutionViewOptions {
  readonly limits: ServiceLimits;
  readonly requested?: ResponseLimits | undefined;
  /** Output version and delivered position per cell; `null` returns everything. */
  readonly positions?: readonly ExecutionOutputPosition[] | null;
  readonly waitTimedOut: boolean;
  readonly outputs: OutputStore;
}

/** Effective per-answer budgets: a caller may only ask for less (SPEC.md §9). */
export function effectiveLimits(
  limits: ServiceLimits,
  requested?: ResponseLimits
): { maxCells: number; maxBytes: number; previewChars: number; maxOutputBytes: number } {
  const clamp = (value: number | undefined, ceiling: number): number =>
    value === undefined || !Number.isFinite(value) || value <= 0
      ? ceiling
      : Math.min(Math.floor(value), ceiling);
  return {
    maxCells: clamp(requested?.maxCells, limits.summaryMaxCells),
    maxBytes: clamp(requested?.maxBytes, limits.responseMaxBytes),
    previewChars: clamp(requested?.previewChars, 4096),
    maxOutputBytes: clamp(requested?.maxOutputBytes, limits.responseMaxBytes)
  };
}

/** Short textual excerpt of an output that did not fit (SPEC.md §9). */
function previewOf(output: NbOutput, budget: number): string | undefined {
  if (budget <= 0) return undefined;
  let text: string | null = null;
  if (output.output_type === 'stream') text = nbText(output.text);
  else if (output.output_type === 'error') text = `${output.ename}: ${output.evalue}`;
  else {
    const plain = (output.data as Record<string, unknown> | undefined)?.['text/plain'];
    if (plain !== undefined) text = nbText(plain);
  }
  if (text === null || text === '') return undefined;
  return text.length > budget ? text.slice(0, budget) : text;
}

/**
 * Bound one output for a response (SPEC.md §9).
 *
 * The payload is inlined only when it fits, and every entry reports its MIME
 * types, full size and - whenever the bytes can be read separately - the
 * snapshot reference that reads them. A full base64 image is never repeated in
 * a text answer.
 */
export function toOutputEntry(
  output: NbOutput,
  index: number,
  budget: { remaining: number; maxOutputBytes: number },
  address: { notebookId: string; executionId: string; cellId: string },
  store: OutputStore
): OutputEntry {
  const byteSize = outputByteSize(output);
  const mimeTypes = mimeTypesOf(output);
  const fits = byteSize <= Math.min(budget.remaining, budget.maxOutputBytes);
  if (fits) {
    budget.remaining -= byteSize;
    return { index, outputType: output.output_type, mimeTypes, byteSize, truncated: false, output };
  }
  const snapshot = store.intern({ ...address, index }, output);
  const preview = previewOf(output, Math.min(budget.remaining, 512));
  if (preview !== undefined) budget.remaining = Math.max(0, budget.remaining - preview.length);
  return {
    index,
    outputType: output.output_type,
    mimeTypes: mimeTypes.length > 0 ? mimeTypes : snapshot.mimeTypes,
    byteSize,
    truncated: true,
    ...(preview === undefined ? {} : { textPreview: preview }),
    snapshot: {
      outputId: snapshot.outputId,
      uri: snapshot.uri,
      mimeTypes: snapshot.mimeTypes,
      byteSize: snapshot.byteSize,
      inlineImageAdvised: snapshot.inlineImageAdvised,
      lifetime: SNAPSHOT_LIFETIME
    }
  };
}

function cellView(
  cell: KernelCellRecord,
  from: number,
  outputsReset: boolean,
  budget: { remaining: number; maxOutputBytes: number },
  address: { notebookId: string; executionId: string },
  store: OutputStore
): ExecutionCellView {
  const entries: OutputEntry[] = [];
  let truncated = false;
  for (let index = from; index < cell.outputsCollected.length; index += 1) {
    if (budget.remaining <= 0) {
      truncated = true;
      break;
    }
    entries.push(
      toOutputEntry(
        cell.outputsCollected[index]!,
        index,
        budget,
        { ...address, cellId: cell.cellId },
        store
      )
    );
  }
  return {
    cellId: cell.cellId,
    state: cell.state,
    sourceRevision: cell.sourceRevision,
    ...(cell.msgId === undefined ? {} : { msgId: cell.msgId }),
    ...(cell.executionCount === undefined ? {} : { executionCount: cell.executionCount }),
    ...(cell.notSentReason === undefined ? {} : { notSentReason: cell.notSentReason }),
    ...(cell.abortedReason === undefined ? {} : { abortedReason: cell.abortedReason }),
    sourceChanged: cell.sourceChanged,
    cellDeleted: cell.cellDeleted,
    outputIncomplete: cell.outputIncomplete,
    outputs: entries,
    outputsReset,
    outputsTruncated: truncated
  };
}

/** Turn a registry snapshot into the `ExecutionView` of SPEC.md §9. */
export function buildExecutionView(
  record: ExecutionRecord,
  snapshot: JobSnapshot,
  options: ExecutionViewOptions
): ExecutionView {
  const limits = effectiveLimits(options.limits, options.requested);
  const budget = { remaining: limits.maxBytes, maxOutputBytes: limits.maxOutputBytes };
  const address = { notebookId: record.notebookId, executionId: record.executionId };
  const cells: ExecutionCellView[] = [];
  const positions: ExecutionOutputPosition[] = [];
  snapshot.job.cells.forEach((cell, position) => {
    const previous = options.positions?.[position];
    const sameVersion = previous?.version === cell.outputVersion;
    if (sameVersion && previous.delivered > cell.outputsCollected.length) {
      throw coreError('CURSOR_EXPIRED', 'the execution cursor is past the current output state', {
        details: { cell_id: cell.cellId }
      });
    }
    const from = sameVersion ? previous.delivered : 0;
    const view = cellView(
      cell,
      Math.min(from, cell.outputsCollected.length),
      previous !== undefined && !sameVersion,
      budget,
      address,
      options.outputs
    );
    cells.push(view);
    const last = view.outputs.length === 0 ? from : view.outputs[view.outputs.length - 1]!.index + 1;
    positions.push({ version: cell.outputVersion, delivered: Math.max(from, last) });
  });
  return {
    executionId: record.executionId,
    notebookId: record.notebookId,
    sessionId: record.sessionId,
    kernelId: snapshot.job.kernelId,
    state: snapshot.job.state,
    stopOnError: snapshot.job.stopOnError,
    cells,
    createdAt: snapshot.job.createdAt,
    ...(snapshot.job.finishedAt === undefined ? {} : { finishedAt: snapshot.job.finishedAt }),
    ...(snapshot.job.reason === undefined ? {} : { reason: snapshot.job.reason }),
    cursor: makeExecutionCursor(snapshot.cursor, positions),
    waitTimedOut: options.waitTimedOut,
    lifetime: {
      scope: 'until_session_close',
      releasedBy: ['execution_cancel', 'session_close', 'process_exit'],
      processScoped: HANDLE_LIFETIME.processScoped
    }
  };
}
