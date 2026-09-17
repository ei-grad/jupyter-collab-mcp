/**
 * In-memory `OutputSink` for kernel tests.
 *
 * It stands in for the notebook model: `src/kernel` never touches Yjs, so a
 * recording sink is enough to prove what would have been written into the
 * shared document (SPEC.md §8, the single-writer rule).
 */

import type { NbOutput, OutputSink, SharedExecutionState } from '../../src/core/index.js';

export type SinkCall =
  | { readonly method: 'setOutputs'; readonly outputs: NbOutput[] }
  | { readonly method: 'appendOutput'; readonly output: NbOutput }
  | { readonly method: 'appendStream'; readonly index: number; readonly text: string }
  | { readonly method: 'updateOutput'; readonly index: number; readonly output: NbOutput }
  | { readonly method: 'clearOutputs' }
  | { readonly method: 'setExecutionCount'; readonly executionCount: number | null }
  | { readonly method: 'setExecutionState'; readonly state: SharedExecutionState };

/** Recording sink; flip {@link FakeSink.current} to simulate a lost area. */
export class FakeSink implements OutputSink {
  readonly calls: SinkCall[] = [];
  outputs: NbOutput[] = [];
  executionCount: number | null = null;
  executionState: SharedExecutionState | null = null;
  current = true;

  constructor(
    readonly cellId: string,
    readonly generation: number,
    readonly identityToken: string = `id:${cellId}`
  ) {}

  isCurrent(): boolean {
    return this.current;
  }

  getOutputs(): NbOutput[] {
    return this.current ? [...this.outputs] : [];
  }

  setOutputs(outputs: NbOutput[]): boolean {
    if (!this.current) return false;
    this.outputs = [...outputs];
    this.calls.push({ method: 'setOutputs', outputs: [...outputs] });
    return true;
  }

  appendOutput(output: NbOutput): boolean {
    if (!this.current) return false;
    this.outputs.push(output);
    this.calls.push({ method: 'appendOutput', output });
    return true;
  }

  appendStream(index: number, text: string): boolean {
    if (!this.current) return false;
    const output = this.outputs[index];
    if (output?.output_type !== 'stream') return false;
    const previous = typeof output.text === 'string' ? output.text : output.text.join('');
    this.outputs[index] = { ...output, text: previous + text };
    this.calls.push({ method: 'appendStream', index, text });
    return true;
  }

  updateOutput(index: number, output: NbOutput): boolean {
    if (!this.current) return false;
    if (index < 0 || index >= this.outputs.length) return false;
    this.outputs[index] = output;
    this.calls.push({ method: 'updateOutput', index, output });
    return true;
  }

  clearOutputs(): boolean {
    if (!this.current) return false;
    this.outputs = [];
    this.calls.push({ method: 'clearOutputs' });
    return true;
  }

  setExecutionCount(executionCount: number | null): boolean {
    if (!this.current) return false;
    this.executionCount = executionCount;
    this.calls.push({ method: 'setExecutionCount', executionCount });
    return true;
  }

  setExecutionState(state: SharedExecutionState): boolean {
    if (!this.current) return false;
    this.executionState = state;
    this.calls.push({ method: 'setExecutionState', state });
    return true;
  }
}

/**
 * A `BeginExecutionGeneration` over {@link FakeSink}s: every call bumps the
 * cell's generation and marks the previous sink stale, exactly as the real
 * five-step transaction does (SPEC.md §8).
 */
export class FakeSinkFactory {
  readonly sinks = new Map<string, FakeSink[]>();
  readonly identities = new Map<string, string>();
  /** Cells that "no longer exist"; the factory returns `null` for them. */
  readonly missing = new Set<string>();

  begin = (cellId: string, expectedIdentityToken?: string): FakeSink | null => {
    if (this.missing.has(cellId)) return null;
    const identityToken = this.identities.get(cellId) ?? `id:${cellId}`;
    this.identities.set(cellId, identityToken);
    if (expectedIdentityToken !== undefined && expectedIdentityToken !== identityToken) return null;
    const history = this.sinks.get(cellId) ?? [];
    for (const previous of history) previous.current = false;
    const generation = history.filter((entry) => entry.identityToken === identityToken).length + 1;
    const sink = new FakeSink(cellId, generation, identityToken);
    history.push(sink);
    this.sinks.set(cellId, history);
    return sink;
  };

  /** Replace or reuse an id with a distinct shared-cell identity. */
  replace(cellId: string, identityToken: string): void {
    for (const previous of this.sinks.get(cellId) ?? []) previous.current = false;
    this.identities.set(cellId, identityToken);
  }

  /** Most recent sink of a cell. */
  latest(cellId: string): FakeSink | undefined {
    const history = this.sinks.get(cellId);
    return history?.[history.length - 1];
  }

  /** Every sink ever created for a cell, oldest first. */
  all(cellId: string): readonly FakeSink[] {
    return this.sinks.get(cellId) ?? [];
  }
}
