/**
 * `NotebookModel` - the live CRDT replica of one notebook (SPEC.md §4, §6-§10).
 *
 * It owns everything that is a function of the shared document and nothing
 * else: the id index, revisions, the change journal, `notebook_apply` and the
 * output-area generations. It performs no I/O, so every rule of SPEC.md §7,
 * §8 and §10 is testable by linking two `YNotebook`s in memory.
 *
 * Two invariants shape the class:
 *
 * 1. **Every local write goes through `ynotebook.ydoc.transact(fn, origin)`.**
 *    `@jupyter/ydoc` drops custom origins in `cell.transact` and
 *    `notebook.transact` when `disableDocumentWideUndoRedo` is false, which is
 *    the default (spike/NOTES.md §3.2). Nested transactions inherit the outer
 *    origin, so wrapping the library calls is what makes
 *    `transaction.origin === origin` a reliable "this change is mine" test -
 *    the mechanism SPEC.md §10 relies on.
 * 2. **One set of observers for the life of the model**, installed in the
 *    constructor and removed in {@link NotebookModel.dispose}. Reconnects must
 *    not accumulate observers (SPEC.md §6).
 *
 * @module
 */

import type { YNotebook } from '@jupyter/ydoc';
import type * as Y from 'yjs';

import { coreError, toCoreError } from '../errors.js';
import type { CoreError } from '../errors.js';
import type { StructureRevision } from '../revision.js';
import { cellRevision, outputsRevision, sourceRevision } from '../revision.js';
import type {
  ChangeEvent,
  ChangesCursor,
  ConnectionState,
  OperationResult,
  OutputSink,
  OutputSinkFactory
} from '../types.js';
import { makePageCursor } from '../types.js';
import { CellIndex } from './cell-index.js';
import type { IdentifiedCellRef } from './cell-index.js';
import { ChangeJournal } from './journal.js';
import type { ChangesPage } from './journal.js';
import { GenerationRegistry } from './generations.js';
import { NotebookObserver } from './observer.js';
import { executeOne } from './execute.js';
import type { CreatedCells } from './execute.js';
import { planOperations } from './plan.js';
import {
  DEFAULT_MAX_CELLS,
  DEFAULT_PREVIEW_CHARS,
  cellJson,
  cellTypeOf,
  isCodeCell,
  metadataRevisionOf,
  offsetFromCursor,
  outputsOf,
  pageBindingOf,
  readCells,
  readOutputs,
  resolveCell,
  structureRevisionOf,
  summaryRow
} from './read.js';
import type {
  CellSelector,
  CellsRead,
  ModelApplyResult,
  ModelOperation,
  NotebookModelSummary,
  OutputsRead,
  ReadLimits,
  SummaryLimits
} from './types.js';

/** Construction options. */
export interface NotebookModelOptions {
  /**
   * The transaction origin marking this connection's own writes. Any object
   * works; it must be unique per model instance and is never sent over the
   * wire (SPEC.md §10).
   */
  readonly origin: object;
  /** Change journal capacity. SPEC.md §9 default: 10 000. */
  readonly journalLimit?: number;
  /** Output coalescing window. SPEC.md §10 default: 100 ms. */
  readonly outputsCoalesceMs?: number;
  /** Preview length of a summary row. Default 80 characters. */
  readonly previewChars?: number;
  /** Injectable clock for tests. */
  readonly now?: () => number;
}

/** The live replica of one notebook (SPEC.md §4). */
export class NotebookModel {
  readonly notebook: YNotebook;
  readonly ydoc: Y.Doc;
  readonly ycells: Y.Array<Y.Map<unknown>>;
  readonly ymeta: Y.Map<unknown>;
  readonly origin: object;
  readonly index: CellIndex;
  readonly journal: ChangeJournal;
  readonly generations: GenerationRegistry;

  readonly #observer: NotebookObserver;
  readonly #previewChars: number;
  /**
   * Transactions this model wrote in. Yjs ignores the origin of a nested
   * `transact`, so a caller that wraps `apply()` or an {@link OutputSink}
   * write in its own transaction would otherwise make the observer classify
   * our own changes as remote (SPEC.md §10 origin, SPEC.md §8 generations).
   * A `WeakSet` needs no cleanup: a transaction object is short-lived.
   */
  readonly #localTransactions = new WeakSet<Y.Transaction>();
  #disposed = false;

  constructor(notebook: YNotebook, options: NotebookModelOptions) {
    this.notebook = notebook;
    this.ydoc = notebook.ydoc;
    this.ycells = this.ydoc.getArray<Y.Map<unknown>>('cells');
    this.ymeta = notebook.ymeta as Y.Map<unknown>;
    this.origin = options.origin;
    this.#previewChars = options.previewChars ?? DEFAULT_PREVIEW_CHARS;
    this.index = new CellIndex(this.ycells);
    this.journal = new ChangeJournal({
      ...(options.journalLimit === undefined ? {} : { limit: options.journalLimit }),
      ...(options.outputsCoalesceMs === undefined ? {} : { coalesceMs: options.outputsCoalesceMs }),
      ...(options.now === undefined ? {} : { now: options.now })
    });
    this.generations = new GenerationRegistry(this);
    this.#observer = new NotebookObserver(this);
    this.#observer.attach();
  }

  /** `true` once the model was released. */
  isDisposed(): boolean {
    return this.#disposed;
  }

  /** {@link GenerationRegistryHost}: remember one of our own transactions. */
  markLocalTransaction(transaction: Y.Transaction): void {
    this.#localTransactions.add(transaction);
  }

  /** {@link ObserverHost}: did this transaction carry our own writes? */
  isLocalTransaction(transaction: Y.Transaction): boolean {
    return this.#localTransactions.has(transaction);
  }

  /**
   * Readiness predicate of SPEC.md §6 as corrected by the spike: the local
   * `nbformat` is `undefined` until the first sync, and "at least one cell
   * exists" proves nothing, because a fresh notebook arrives with one
   * server-created empty code cell (spike/NOTES.md §4).
   */
  isReady(): boolean {
    return typeof this.notebook.nbformat === 'number';
  }

  // -------------------------------------------------------------------------
  // addressing (SPEC.md §7)
  // -------------------------------------------------------------------------

  /**
   * Resolve a `cell_id` into a reference that also pins the CRDT object.
   *
   * @throws CoreError `CELL_NOT_FOUND` / `CELL_ID_AMBIGUOUS`.
   */
  cellRef(cellId: string): IdentifiedCellRef {
    this.#assertLive();
    const entry = this.index.require(cellId);
    return { cellId: entry.cellId, index: entry.index, identityToken: entry.identityToken };
  }

  /**
   * Re-resolve a reference handed out earlier - the check an execution queue
   * runs immediately before sending a cell (SPEC.md §8).
   *
   * @throws CoreError `CELL_NOT_FOUND`, `CELL_ID_AMBIGUOUS` or `CELL_REPLACED`.
   */
  resolveRef(ref: IdentifiedCellRef): IdentifiedCellRef {
    this.#assertLive();
    const entry = this.index.requireSame(ref);
    return { cellId: entry.cellId, index: entry.index, identityToken: entry.identityToken };
  }

  /** Ids that currently address more than one cell (SPEC.md §7). */
  get duplicateCellIds(): readonly string[] {
    return this.index.duplicateIds;
  }

  /** Current structural revision (SPEC.md §7). */
  get structureRevision(): StructureRevision {
    return structureRevisionOf(this.index);
  }

  // -------------------------------------------------------------------------
  // reads (SPEC.md §7, §9)
  // -------------------------------------------------------------------------

  /**
   * `notebook_read(view: 'summary')` without the connection-level fields;
   * {@link withIdentity} completes it.
   *
   * Pending coalesced output events are flushed first, so the `changes_cursor`
   * returned with the snapshot cannot hide a change already visible in it
   * (SPEC.md §10).
   */
  summary(limits: SummaryLimits = {}): NotebookModelSummary {
    this.#assertLive();
    this.journal.flush();
    const structure = structureRevisionOf(this.index);
    const maxCells = limits.maxCells ?? DEFAULT_MAX_CELLS;
    const previewChars = limits.previewChars ?? this.#previewChars;
    // The page cursor is bound to cell identity, not only to the id order:
    // an external `aset` can swap a cell's `Y.Map` under the same id, and the
    // rest of a page must not be served from a document the caller has not
    // seen (SPEC.md §12 "External writes"). See `pageBindingOf`.
    const binding = pageBindingOf(this.index);
    const offset = limits.cursor === undefined ? 0 : offsetFromCursor(limits.cursor, binding);
    const slice = this.index.entries.slice(offset, offset + maxCells);
    const end = offset + slice.length;
    const more = end < this.index.size;
    const nbformat = this.notebook.nbformat;
    const nbformatMinor = this.notebook.nbformat_minor;
    return {
      nbformat: typeof nbformat === 'number' ? nbformat : null,
      nbformatMinor: typeof nbformatMinor === 'number' ? nbformatMinor : null,
      cellCount: this.index.size,
      cells: slice.map((entry) => summaryRow(this.notebook, entry, this.index, previewChars)),
      truncated: more,
      structureRevision: structure,
      notebookMetadataRevision: metadataRevisionOf(this.notebook),
      duplicateCellIds: this.index.duplicateIds,
      changesCursor: this.journal.cursor,
      ...(more ? { pageCursor: makePageCursor(binding, end) } : {})
    };
  }

  /**
   * Summary and journal boundary taken together, with no `await` between them
   * (SPEC.md §9: "The summary snapshot and `changes_cursor` are captured consistently").
   */
  snapshotWithCursor(limits: SummaryLimits = {}): {
    summary: NotebookModelSummary;
    changesCursor: ChangesCursor;
  } {
    const summary = this.summary(limits);
    return { summary, changesCursor: summary.changesCursor };
  }

  /** `notebook_read(view: 'cells')` (SPEC.md §9). */
  readCells(selector?: CellSelector, limits?: ReadLimits): CellsRead {
    this.#assertLive();
    return readCells(this.notebook, this.index, selector, limits);
  }

  /** `notebook_read(view: 'outputs')` (SPEC.md §9). */
  readOutputs(cellIds: readonly string[], limits?: ReadLimits): OutputsRead {
    this.#assertLive();
    return readOutputs(this.notebook, this.index, cellIds, limits);
  }

  // -------------------------------------------------------------------------
  // mutations (SPEC.md §7)
  // -------------------------------------------------------------------------

  /**
   * `notebook_apply`: validate the whole batch, then apply it in one
   * synchronous transaction (SPEC.md §7).
   *
   * Every expected error - `CELL_NOT_FOUND`, `CELL_ID_AMBIGUOUS`,
   * `REVISION_CONFLICT`, `MATCH_NOT_FOUND`, `MATCH_NOT_UNIQUE`,
   * `INVALID_ARGUMENT` - is thrown by the planner before the first mutation,
   * so a rejected batch changes nothing. An *unexpected* failure after the
   * first mutation cannot be rolled back (a Yjs transaction is not a database
   * transaction): the batch stops there and the result carries
   * `partial: true`, `partialAtOperation` and `partialError`, which is the
   * "reread the affected cells" case of SPEC.md §7.
   */
  apply(operations: readonly ModelOperation[]): ModelApplyResult {
    this.#assertLive();
    const plan = planOperations(this.notebook, this.index, operations);
    const created: CreatedCells = new Map();
    const failure: { at: number | null; error: CoreError | null } = { at: null, error: null };

    this.ydoc.transact((transaction) => {
      this.markLocalTransaction(transaction);
      for (let position = 0; position < plan.ops.length; position++) {
        try {
          executeOne(this.notebook, plan.ops[position]!, created);
        } catch (error) {
          failure.at = position;
          failure.error = toCoreError(error, 'notebook_apply failed mid-transaction');
          break;
        }
      }
    }, this.origin);

    this.journal.flush();
    const results: OperationResult[] = [];
    const applied = failure.at === null ? plan.ops.length : failure.at;
    for (let position = 0; position < applied; position++) {
      results.push(this.#resultOf(operations[position]!.op, plan.targets[position] ?? null));
    }
    return {
      results,
      appliedLocally: failure.error === null,
      structureRevision: structureRevisionOf(this.index),
      changesCursor: this.journal.cursor,
      ...(failure.error === null
        ? {}
        : { partial: true, partialError: failure.error, partialAtOperation: failure.at ?? 0 })
    };
  }

  /**
   * Remove the initial cell allocated by Jupyter for a newly created file.
   *
   * The caller establishes provenance by invoking this only for the file it
   * just allocated. The state check is intentionally exact so a browser edit
   * observed before this transaction is never mistaken for the placeholder.
   */
  removePristineServerPlaceholder(): boolean {
    this.#assertLive();
    if (this.index.size !== 1) return false;
    const entry = this.index.entries[0]!;
    const cell = resolveCell(this.notebook, entry);
    if (!isCodeCell(cell)) return false;
    const allowed = new Set([
      'id',
      'cell_type',
      'source',
      'metadata',
      'outputs',
      'execution_count',
      'execution_state'
    ]);
    if ([...cell.ymodel.keys()].some((key) => !allowed.has(key))) return false;
    if (cell.getSource() !== '') return false;
    const metadata = cell.getMetadata() as Record<string, unknown>;
    const metadataKeys = Object.keys(metadata);
    if (
      metadataKeys.length !== 0 &&
      !(metadataKeys.length === 1 && metadataKeys[0] === 'trusted' && metadata['trusted'] === true)
    ) {
      return false;
    }
    if (cell.getOutputs().length !== 0) return false;
    if (cell.execution_count !== null) return false;
    const executionState = cell.ymodel.get('execution_state');
    if (executionState !== undefined && executionState !== 'idle') return false;

    this.ydoc.transact((transaction) => {
      this.markLocalTransaction(transaction);
      this.notebook.deleteCell(0);
    }, this.origin);
    this.journal.flush();
    return true;
  }

  /** Persist the selected server kernelspec in shared notebook metadata. */
  setKernelSpecMetadata(spec: {
    readonly name: string;
    readonly displayName: string;
    readonly language: string;
  }): void {
    this.#assertLive();
    const metadata = this.ymeta.get('metadata') as Y.Map<unknown> | undefined;
    if (metadata === undefined) {
      throw coreError('INTERNAL_ERROR', 'the notebook has no shared metadata map');
    }
    this.ydoc.transact((transaction) => {
      this.markLocalTransaction(transaction);
      metadata.set('kernelspec', {
        name: spec.name,
        display_name: spec.displayName,
        language: spec.language
      });
    }, this.origin);
    this.journal.flush();
  }

  #resultOf(op: OperationResult['op'], cellId: string | null): OperationResult {
    if (op === 'set_notebook_metadata' || op === 'delete_notebook_metadata') {
      return { op, notebookMetadataRevision: metadataRevisionOf(this.notebook) };
    }
    if (cellId === null) return { op };
    if (op === 'delete_cell' || !this.index.isUnique(cellId)) return { op, cellId };
    const entry = this.index.require(cellId);
    const cell = resolveCell(this.notebook, entry);
    const type = cellTypeOf(cell);
    return {
      op,
      cellId,
      index: entry.index,
      sourceRevision: sourceRevision(type, cell.getSource()),
      cellRevision: cellRevision(cellJson(cell)),
      ...(isCodeCell(cell) ? { outputsRevision: outputsRevision(outputsOf(cell)) } : {})
    };
  }

  // -------------------------------------------------------------------------
  // change journal (SPEC.md §10)
  // -------------------------------------------------------------------------

  /** Cursor at the current end of the journal. */
  get changesCursor(): ChangesCursor {
    return this.journal.cursor;
  }

  /**
   * `notebook_changes` (SPEC.md §9).
   *
   * Deliberately does *not* flush the pending output record: a poll must not
   * defeat the 100 ms coalescing of SPEC.md §10. Nothing is lost - the pending
   * record is published with a later sequence and arrives on the next call.
   *
   * @throws CoreError `CURSOR_EXPIRED` when the sequence left the ring.
   */
  changesSince(cursor: ChangesCursor | string, limit?: number): ChangesPage {
    this.#assertLive();
    return limit === undefined ? this.journal.since(cursor) : this.journal.since(cursor, limit);
  }

  /**
   * Publish every pending coalesced output record now (SPEC.md §10).
   *
   * @throws CoreError `HANDLE_EXPIRED` once the replica was released - a
   * closed handle answers nothing else either (SPEC.md §6).
   */
  flush(): void {
    this.#assertLive();
    this.journal.flush();
  }

  /**
   * Record an RTC state transition in the journal (SPEC.md §10).
   *
   * @throws CoreError `HANDLE_EXPIRED` once the replica was released: the
   * observers are gone, so an event appended after that would advance the
   * cursor of a journal that no longer reports anything (SPEC.md §6).
   */
  recordConnectionState(state: ConnectionState): ChangeEvent {
    this.#assertLive();
    return this.journal.publish({
      kind: 'connection_state',
      revisions: {},
      origin: 'local',
      connectionState: state
    });
  }

  /**
   * Record a kernel binding change in the journal (SPEC.md §10).
   *
   * @throws CoreError `HANDLE_EXPIRED` once the replica was released.
   */
  recordKernelChange(kernelId: string | null): ChangeEvent {
    this.#assertLive();
    return this.journal.publish({
      kind: 'kernel_changed',
      revisions: {},
      origin: 'local',
      kernelId
    });
  }

  // -------------------------------------------------------------------------
  // output generations (SPEC.md §8)
  // -------------------------------------------------------------------------

  /**
   * Open a new output-area generation immediately before an `execute_request`
   * (SPEC.md §8). See {@link GenerationRegistry.begin}.
   */
  beginExecutionGeneration(cellId: string, expectedIdentityToken?: string): OutputSink | null {
    return this.generations.begin(cellId, expectedIdentityToken);
  }

  /**
   * {@link OutputSinkFactory}: the live sink of a cell, or `null` when there is
   * no current generation - the cell was deleted, replaced, renamed, or its
   * output area was taken over by somebody else (SPEC.md §8).
   */
  readonly sinkFor: OutputSinkFactory = (cellId: string): OutputSink | null =>
    this.generations.sinkFor(cellId);

  /**
   * Terminal write of an execution (SPEC.md §8): the final `execution_count`
   * and `execution_state: 'idle'` in one transaction. `false` when the
   * generation is no longer current, in which case nothing is written and the
   * result stays on the job.
   */
  finishExecution(sink: OutputSink, options: { count?: number | null } = {}): boolean {
    return this.generations.finish(sink, options);
  }

  /**
   * Release observers and timers. The shared model itself belongs to the
   * connection, which calls `YNotebook.dispose()` - without it the awareness
   * interval keeps the process alive (spike/NOTES.md §3.3).
   */
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#observer.detach();
    this.generations.invalidateAll();
    this.journal.dispose();
  }

  #assertLive(): void {
    if (this.#disposed) {
      throw coreError('HANDLE_EXPIRED', 'this notebook replica was released');
    }
  }
}
