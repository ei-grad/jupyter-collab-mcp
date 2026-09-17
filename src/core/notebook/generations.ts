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

import { outputsRevision } from '../revision.js';
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
  /** Append a stream delta and attribute its exact text to the Yjs transaction. */
  appendStream(generation: OutputGeneration, index: number, text: string): boolean;
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
  #rememberedState = false;
  #expectedOutputs: NbOutput[] = [];
  #executionCount: number | null = null;
  #executionState: SharedExecutionState = 'idle';

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
    return this.#writeOutputs(normalised, (cell) => {
      cell.setOutputs(normalised as unknown as Parameters<YCodeCell['setOutputs']>[0]);
    });
  }

  /** Append one output. */
  appendOutput(output: NbOutput): boolean {
    const normalised = normalizeOutput(output);
    return this.#writeOutputs([...this.#expectedOutputs, normalised], (cell) => {
      const at = cell.youtputs.length;
      cell.updateOutputs(at, at, [normalised] as unknown as Parameters<
        YCodeCell['updateOutputs']
      >[2]);
    });
  }

  /** Append a kernel stream delta to the existing shared Y.Text. */
  appendStream(index: number, text: string): boolean {
    const cell = this.#host.cellFor(this);
    if (cell === null) return false;
    if (!Number.isInteger(index) || index < 0 || index >= cell.youtputs.length) return false;
    const current = this.#expectedOutputs[index];
    if (current === undefined) return false;
    const stream = streamValue(current);
    if (stream === null) return false;
    const expected = [...this.#expectedOutputs];
    expected[index] = {
      output_type: 'stream',
      name: stream.name === 'stderr' ? 'stderr' : 'stdout',
      text: stream.text + text
    };
    const previous = this.#expectedOutputs;
    this.#expectedOutputs = expected;
    const applied = this.#host.appendStream(this, index, text);
    if (!applied) this.#expectedOutputs = previous;
    return applied;
  }

  /** Replace one output, primarily for `update_display_data`. */
  updateOutput(index: number, output: NbOutput): boolean {
    const cell = this.#host.cellFor(this);
    if (cell === null) return false;
    if (!Number.isInteger(index) || index < 0 || index >= cell.youtputs.length) return false;
    const normalised = normalizeOutput(output);
    const expected = [...this.#expectedOutputs];
    expected[index] = normalised;
    return this.#writeOutputs(expected, (live) => {
      live.updateOutputs(index, index + 1, [normalised] as unknown as Parameters<
        YCodeCell['updateOutputs']
      >[2]);
    });
  }

  /** Remember the exact output/prompt state produced by this generation. */
  rememberState(cell: YCodeCell): void {
    this.#rememberedState = true;
    this.#executionCount = cell.execution_count;
    this.#executionState = cell.executionState;
  }

  /** Whether a foreign transaction left the generation's state unchanged. */
  matchesRememberedState(cell: YCodeCell): boolean {
    return (
      this.#rememberedState &&
      outputsRevision(this.#expectedOutputs) ===
        outputsRevision(cell.getOutputs() as unknown as NbOutput[]) &&
      this.#executionCount === cell.execution_count &&
      this.#executionState === cell.executionState
    );
  }

  #writeOutputs(outputs: NbOutput[], fn: (cell: YCodeCell) => void): boolean {
    const previous = this.#expectedOutputs;
    this.#expectedOutputs = outputs;
    const applied = this.#host.write(this, fn);
    if (!applied) this.#expectedOutputs = previous;
    return applied;
  }

  /** `clear_output`. */
  clearOutputs(): boolean {
    return this.#writeOutputs([], (cell) => {
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
  /** Exact stream text appended by sinks inside each transaction and cell. */
  readonly #streamClaims = new WeakMap<Y.Transaction, Map<string, string>>();
  constructor(host: GenerationRegistryHost) {
    this.#host = host;
  }

  /** Whether the transaction's complete stream delta is exactly sink-owned. */
  claimedStreamDeltaMatches(transaction: Y.Transaction, cellId: string, text: string): boolean {
    return this.#streamClaims.get(transaction)?.get(cellId) === text;
  }

  /** True when a peer only reserialised the state last written by our sink. */
  matchesCurrentState(cellId: string): boolean {
    const generation = this.#active.get(cellId);
    if (generation === undefined) return false;
    const cell = this.cellFor(generation);
    return cell !== null && generation.matchesRememberedState(cell);
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
  begin(cellId: string, expectedIdentityToken?: string): OutputSink | null {
    if (this.#host.isDisposed()) return null;
    const entries = this.#host.index.all(cellId);
    if (entries.length !== 1) return null;
    const entry = entries[0]!;
    if (expectedIdentityToken !== undefined && entry.identityToken !== expectedIdentityToken) {
      return null;
    }
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

  appendStream(
    generation: OutputGeneration,
    index: number,
    text: string
  ): boolean {
    const cell = this.cellFor(generation);
    if (cell === null) return false;
    this.#host.ydoc.transact((transaction) => {
      this.#host.markLocalTransaction(transaction);
      const claims = this.#streamClaims.get(transaction);
      if (claims === undefined) {
        this.#streamClaims.set(transaction, new Map([[generation.cellId, text]]));
      } else {
        claims.set(generation.cellId, (claims.get(generation.cellId) ?? '') + text);
      }
      cell.appendStreamOutput(index, text);
      const live = this.cellFor(generation);
      if (live !== null) generation.rememberState(live);
    }, this.#host.origin);
    return true;
  }

  /** One transaction with the connection's origin, attributed to `generation`. */
  #transact(generation: OutputGeneration, fn: () => void): void {
    this.#host.ydoc.transact((transaction) => {
      this.#host.markLocalTransaction(transaction);
      fn();
      const cell = this.cellFor(generation);
      if (cell !== null) generation.rememberState(cell);
    }, this.#host.origin);
  }
}

function streamValue(output: NbOutput): { name: string; text: string } | null {
  if (output.output_type !== 'stream') return null;
  return {
    name: output.name,
    text: typeof output.text === 'string' ? output.text : output.text.join('')
  };
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
