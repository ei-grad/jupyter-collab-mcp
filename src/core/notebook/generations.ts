/**
 * Output-area generations and the {@link OutputSink} implementation
 * (SPEC.md §8 "Races, interruption, and connection loss").
 *
 * Every execution owns a *generation* of one cell's output area. Exactly one
 * writer exists per generation, and a stale writer must never touch the
 * outputs, `execution_count` or `execution_state` of a newer one - not after a
 * late IOPub message, not after a reconnect. A generation stops being current
 * when
 *
 *   - a newer generation started on that cell (our own next execution), or
 *   - the cell's outputs / `execution_count` / `execution_state` were changed
 *     by anyone else, including the browser (SPEC.md §8), or
 *   - the cell was deleted, or its `Y.Map` was replaced under the same id, or
 *     its id changed (SPEC.md §6 "External file changes"), or
 *   - the model was disposed.
 *
 * @module
 */

import type { YCodeCell, YNotebook } from '@jupyter/ydoc';
import type * as Y from 'yjs';

import type { NbOutput, OutputSink, SharedExecutionState } from '../types.js';
import type { CellIndex } from './cell-index.js';
import type { ChangeJournal } from './journal.js';
import { isCodeCell, resolveCell } from './read.js';

/** What a generation needs from the model to read and write its cell. */
export interface GenerationHost {
  /**
   * The code cell this generation still owns, or `null` once it is stale.
   * Checks cell existence, unique id, unchanged identity token and that no
   * newer generation was started.
   */
  cellFor(generation: OutputGeneration): YCodeCell | null;
  /**
   * Run `fn` inside one `ydoc.transact(..., origin)` attributed to this
   * generation, so the model's own observer does not mistake the write for a
   * foreign one and invalidate the generation it just performed.
   * Returns `false` and writes nothing when the generation is stale.
   */
  write(generation: OutputGeneration, fn: (cell: YCodeCell) => void): boolean;
}

/**
 * One output-area generation, and the single writer allowed to fill it
 * (SPEC.md §8).
 */
export class OutputGeneration implements OutputSink {
  readonly cellId: string;
  readonly generation: number;
  /** Identity token of the `Y.Map` this generation was opened against. */
  readonly identityToken: string;
  /** Set by the model when something superseded this generation. */
  invalidated = false;

  readonly #host: GenerationHost;

  constructor(host: GenerationHost, cellId: string, identityToken: string, generation: number) {
    this.#host = host;
    this.cellId = cellId;
    this.identityToken = identityToken;
    this.generation = generation;
  }

  /** Does this sink still own the cell's output area? (SPEC.md §8) */
  isCurrent(): boolean {
    return this.#host.cellFor(this) !== null;
  }

  /** Current outputs, or `[]` once the sink is stale. */
  getOutputs(): NbOutput[] {
    const cell = this.#host.cellFor(this);
    return cell === null ? [] : (cell.getOutputs() as unknown as NbOutput[]);
  }

  /** Replace the whole output area. */
  setOutputs(outputs: NbOutput[]): boolean {
    const normalised = outputs.map(normalizeOutput);
    return this.#host.write(this, (cell) => {
      cell.setOutputs(normalised as unknown as Parameters<YCodeCell['setOutputs']>[0]);
    });
  }

  /** Append one output. */
  appendOutput(output: NbOutput): boolean {
    const normalised = normalizeOutput(output);
    return this.#host.write(this, (cell) => {
      const at = cell.youtputs.length;
      cell.updateOutputs(at, at, [normalised] as unknown as Parameters<
        YCodeCell['updateOutputs']
      >[2]);
    });
  }

  /**
   * Replace the output at `index` - `update_display_data` and `stream`
   * coalescing. An index outside the current range is not applied.
   */
  updateOutput(index: number, output: NbOutput): boolean {
    const cell = this.#host.cellFor(this);
    if (cell === null) return false;
    if (!Number.isInteger(index) || index < 0 || index >= cell.youtputs.length) return false;
    const normalised = normalizeOutput(output);
    return this.#host.write(this, (live) => {
      live.updateOutputs(index, index + 1, [normalised] as unknown as Parameters<
        YCodeCell['updateOutputs']
      >[2]);
    });
  }

  /** `clear_output`. */
  clearOutputs(): boolean {
    return this.#host.write(this, (cell) => {
      cell.clearOutputs();
    });
  }

  /**
   * Write `execution_count`.
   *
   * SPEC.md §8 and the browser check: publishing a non-null count while
   * `execution_state` is still `running` makes JupyterLab write `idle` back
   * into the shared model within ~10 ms and drops the `[*]` prompt. The count
   * therefore belongs in the final transaction only - see
   * {@link NotebookModel.finishExecution}.
   */
  setExecutionCount(count: number | null): boolean {
    return this.#host.write(this, (cell) => {
      cell.setExecutionCount(count);
    });
  }

  /** Write the shared `execution_state`; `idle` only at completion. */
  setExecutionState(state: SharedExecutionState): boolean {
    return this.#host.write(this, (cell) => {
      cell.executionState = state;
    });
  }
}

/** What the registry needs from the model to open and police generations. */
export interface GenerationRegistryHost {
  readonly notebook: YNotebook;
  readonly ydoc: Y.Doc;
  readonly origin: object;
  readonly index: CellIndex;
  readonly journal: ChangeJournal;
  isDisposed(): boolean;
  /**
   * Remember that this transaction carries our own writes. A caller may have
   * opened it, in which case Yjs ignores the origin of the nested
   * `transact` - see {@link GenerationRegistry} for why that matters.
   */
  markLocalTransaction(transaction: Y.Transaction): void;
}

/**
 * The set of live output-area generations of one replica (SPEC.md §8).
 *
 * At most one generation per cell is current. Everything that supersedes a
 * generation goes through {@link GenerationRegistry.invalidate}, which the
 * document observer calls for a foreign output write, a replaced or renamed
 * cell and a deleted one.
 */
export class GenerationRegistry implements GenerationHost {
  readonly #host: GenerationRegistryHost;
  readonly #active = new Map<string, OutputGeneration>();
  readonly #counter = new Map<string, number>();
  /**
   * Which generation wrote which cell inside a given Yjs transaction.
   *
   * A transient "currently writing" flag cannot be used: Yjs runs deep
   * observers when the **outermost** transaction ends, which is after the flag
   * would have been restored if the caller opened that transaction itself. The
   * observer would then see the generation's own clear/append as a foreign
   * write and revoke the generation (SPEC.md §8) - silently killing an
   * execution that grouped its IOPub writes to cut RTC traffic. Keying the
   * claim on the transaction object survives until the observers run, and the
   * `WeakMap` needs no cleanup because a transaction is short-lived.
   */
  readonly #claims = new WeakMap<Y.Transaction, Map<string, OutputGeneration>>();

  constructor(host: GenerationRegistryHost) {
    this.#host = host;
  }

  /**
   * Did the still-current generation of `cellId` write it in this transaction?
   *
   * The observer uses it to tell "our own sink wrote" from "somebody took the
   * output area over", which is the difference between keeping and dropping
   * the generation (SPEC.md §8).
   */
  wroteIn(transaction: Y.Transaction, cellId: string): boolean {
    const claimed = this.#claims.get(transaction)?.get(cellId);
    return claimed !== undefined && this.#active.get(cellId) === claimed;
  }

  /**
   * Open a new generation immediately before an `execute_request`
   * (SPEC.md §8): in one transaction clear the outputs, set `execution_count`
   * to `null`, delete the previous timing metadata `execution` and set
   * `execution_state` to `running`; then bump the counter and hand out the
   * single writer.
   *
   * `null` when the cell does not exist, its id is ambiguous, or it is not a
   * code cell - the queue must then stop before sending anything.
   */
  begin(cellId: string): OutputSink | null {
    if (this.#host.isDisposed()) return null;
    const entries = this.#host.index.all(cellId);
    if (entries.length !== 1) return null;
    const entry = entries[0]!;
    const cell = resolveCell(this.#host.notebook, entry);
    if (!isCodeCell(cell)) return null;

    this.invalidate(cellId);
    const generation = (this.#counter.get(cellId) ?? 0) + 1;
    this.#counter.set(cellId, generation);
    const sink = new OutputGeneration(this, cellId, entry.identityToken, generation);
    this.#active.set(cellId, sink);

    // A generation boundary is one of the points SPEC.md §10 requires the
    // pending outputs record of that cell to be published at.
    this.#host.journal.flushCell(cellId);
    this.#transact(sink, () => {
      cell.clearOutputs();
      cell.setExecutionCount(null);
      cell.deleteMetadata('execution');
      cell.executionState = 'running';
    });
    return sink;
  }

  /** {@link OutputSinkFactory}: the live sink of a cell, or `null`. */
  sinkFor(cellId: string): OutputSink | null {
    const sink = this.#active.get(cellId);
    if (sink === undefined) return null;
    return this.cellFor(sink) === null ? null : sink;
  }

  /**
   * Terminal write of an execution (SPEC.md §8): the final `execution_count`
   * and `execution_state: 'idle'` in one transaction. Writing the count
   * earlier extinguishes `[*]` in JupyterLab, which then writes `idle` back
   * into the shared document.
   */
  finish(sink: OutputSink, options: { count?: number | null } = {}): boolean {
    const generation = sink as OutputGeneration;
    const cell = this.cellFor(generation);
    if (cell === null) return false;
    this.#transact(generation, () => {
      if (options.count !== undefined) cell.setExecutionCount(options.count);
      cell.executionState = 'idle';
    });
    return true;
  }

  /**
   * Forget the generation counter of an id that left the document.
   *
   * Called by the observer on a delete or a server-side id rename, so a
   * long-lived replica does not accumulate one counter entry per id it has
   * ever seen. A later cell reusing the id simply starts at generation 1;
   * generations are policed by object identity, not by the number.
   */
  forget(cellId: string): void {
    this.invalidate(cellId);
    this.#counter.delete(cellId);
  }

  /** Drop the generation of a cell, if any; its sink stops writing at once. */
  invalidate(cellId: string): void {
    const generation = this.#active.get(cellId);
    if (generation === undefined) return;
    generation.invalidated = true;
    this.#active.delete(cellId);
  }

  /** Invalidate everything; called from `NotebookModel.dispose`. */
  invalidateAll(): void {
    for (const generation of this.#active.values()) generation.invalidated = true;
    this.#active.clear();
  }

  cellFor(generation: OutputGeneration): YCodeCell | null {
    if (this.#host.isDisposed() || generation.invalidated) return null;
    if (this.#active.get(generation.cellId) !== generation) return null;
    const entries = this.#host.index.all(generation.cellId);
    if (entries.length !== 1) return null;
    const entry = entries[0]!;
    if (entry.identityToken !== generation.identityToken) return null;
    const cell = resolveCell(this.#host.notebook, entry);
    return isCodeCell(cell) ? cell : null;
  }

  write(generation: OutputGeneration, fn: (cell: YCodeCell) => void): boolean {
    const cell = this.cellFor(generation);
    if (cell === null) return false;
    this.#transact(generation, () => fn(cell));
    return true;
  }

  /** One transaction with the connection's origin, attributed to `generation`. */
  #transact(generation: OutputGeneration, fn: () => void): void {
    this.#host.ydoc.transact((transaction) => {
      this.#host.markLocalTransaction(transaction);
      const claimed = this.#claims.get(transaction);
      if (claimed === undefined) {
        this.#claims.set(transaction, new Map([[generation.cellId, generation]]));
      } else {
        claimed.set(generation.cellId, generation);
      }
      fn();
    }, this.#host.origin);
  }
}

/**
 * nbformat allows a `stream` output's `text` to be a list of lines, and the
 * shared contract types it as `string | readonly string[]`. `@jupyter/ydoc`
 * turns such a list into a `Y.Text` with `text.join()`
 * (node_modules/@jupyter/ydoc/lib/ycell.js:672-683) - the **default** join,
 * which inserts a comma between the lines and corrupts the output. Joining
 * with the empty string first is the nbformat-correct reading and makes the
 * two input shapes equivalent (SPEC.md §12 "Outputs": an independent observer
 * must see the same result).
 */
function normalizeOutput(output: NbOutput): NbOutput {
  if (output.output_type !== 'stream') return output;
  const { text } = output;
  if (typeof text === 'string') return output;
  return { ...output, text: text.join('') };
}
