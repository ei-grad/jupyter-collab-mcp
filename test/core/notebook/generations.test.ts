import { afterEach, describe, expect, it, vi } from 'vitest';

import type { NbOutput } from '../../../src/core/index.js';
import {
  codeCell,
  codeCellAt,
  makeLinkedPeers,
  makePeer,
  markdownCell,
  notebookWith,
  replaceCellExternally
} from './helpers.js';

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
});

const stdout = (text: string): NbOutput => ({ output_type: 'stream', name: 'stdout', text });

describe('output generations (SPEC.md §8)', () => {
  it('opens a generation with one transaction: clear, count null, no timing, running', () => {
    const peer = makePeer(
      notebookWith([
        codeCell('a', 'x', {
          outputs: [{ output_type: 'stream', name: 'stdout', text: 'old' }],
          execution_count: 7,
          metadata: { execution: { 'iopub.status.busy': '2020' }, tags: ['keep'] }
        })
      ])
    );
    cleanups.push(() => peer.dispose());
    let updates = 0;
    const onUpdate = (): void => {
      updates++;
    };
    peer.notebook.ydoc.on('update', onUpdate);
    const sink = peer.model.beginExecutionGeneration('a');
    peer.notebook.ydoc.off('update', onUpdate);

    expect(sink).not.toBeNull();
    expect(updates).toBe(1);
    const cell = codeCellAt(peer.notebook, 0);
    expect(cell.getOutputs()).toEqual([]);
    expect(cell.execution_count).toBeNull();
    expect(cell.executionState).toBe('running');
    const summary = peer.model.readCells({ cellIds: ['a'] }).cells[0]!;
    expect(summary.metadata).toEqual({ tags: ['keep'] });
  });

  it('refuses a markdown cell, an unknown id and a duplicated id', () => {
    const peer = makePeer(
      notebookWith([markdownCell('m', '# t'), codeCell('dup', 'x'), codeCell('dup', 'y')])
    );
    cleanups.push(() => peer.dispose());
    expect(peer.model.beginExecutionGeneration('m')).toBeNull();
    expect(peer.model.beginExecutionGeneration('missing')).toBeNull();
    expect(peer.model.beginExecutionGeneration('dup')).toBeNull();
  });

  it('a newer generation supersedes the older sink, whose writes do nothing', () => {
    const peer = makePeer(notebookWith([codeCell('a', 'x')]));
    cleanups.push(() => peer.dispose());
    const first = peer.model.beginExecutionGeneration('a')!;
    expect(first.appendOutput(stdout('from first'))).toBe(true);

    const second = peer.model.beginExecutionGeneration('a')!;
    expect(first.isCurrent()).toBe(false);
    expect(second.isCurrent()).toBe(true);

    expect(first.appendOutput(stdout('late'))).toBe(false);
    expect(first.setOutputs([stdout('late')])).toBe(false);
    expect(first.setExecutionCount(9)).toBe(false);
    expect(first.setExecutionState('idle')).toBe(false);
    expect(first.clearOutputs()).toBe(false);
    expect(first.getOutputs()).toEqual([]);

    const cell = codeCellAt(peer.notebook, 0);
    expect(cell.getOutputs()).toEqual([]);
    expect(cell.execution_count).toBeNull();
    expect(cell.executionState).toBe('running');
  });

  it('an observed foreign write to the output area invalidates the generation', () => {
    const linked = makeLinkedPeers(notebookWith([codeCell('a', 'x')]));
    cleanups.push(() => linked.dispose());
    const sink = linked.a.model.beginExecutionGeneration('a')!;
    expect(sink.appendOutput(stdout('ours'))).toBe(true);

    // The browser writes its own outputs into the same cell.
    codeCellAt(linked.b.notebook, 0).setOutputs([
      { output_type: 'stream', name: 'stdout', text: 'theirs' }
    ]);

    expect(sink.isCurrent()).toBe(false);
    expect(sink.appendOutput(stdout('stale'))).toBe(false);
    expect(linked.a.model.readOutputs(['a']).cells[0]!.outputs).toHaveLength(1);
    expect(linked.a.model.sinkFor('a')).toBeNull();
  });

  it('a foreign execution_state change invalidates the generation', () => {
    const linked = makeLinkedPeers(notebookWith([codeCell('a', 'x')]));
    cleanups.push(() => linked.dispose());
    const sink = linked.a.model.beginExecutionGeneration('a')!;
    codeCellAt(linked.b.notebook, 0).executionState = 'idle';
    expect(sink.isCurrent()).toBe(false);
  });

  it('a Y.Map replacement under the same id invalidates the generation', () => {
    const linked = makeLinkedPeers(notebookWith([codeCell('a', 'x'), codeCell('b', 'y')]));
    cleanups.push(() => linked.dispose());
    const sink = linked.a.model.beginExecutionGeneration('a')!;
    replaceCellExternally(linked.b.notebook, 'a', {
      cell_type: 'code',
      source: 'rewritten by an external tool',
      metadata: {},
      outputs: [],
      execution_count: null
    });
    expect(sink.isCurrent()).toBe(false);
    expect(sink.appendOutput(stdout('stale'))).toBe(false);
    expect(linked.a.model.readOutputs(['a']).cells[0]!.outputs).toHaveLength(0);
  });

  it('a deleted cell is not recreated for its outputs', () => {
    const peer = makePeer(notebookWith([codeCell('a', 'x'), codeCell('b', 'y')]));
    cleanups.push(() => peer.dispose());
    const sink = peer.model.beginExecutionGeneration('a')!;
    peer.model.apply([
      {
        op: 'delete_cell',
        cellId: 'a',
        expectedCellRevision: peer.model.summary().cells[0]!.cellRevision
      }
    ]);
    expect(sink.isCurrent()).toBe(false);
    expect(sink.appendOutput(stdout('late'))).toBe(false);
    expect(peer.model.summary().cells.map((cell) => cell.cellId)).toEqual(['b']);
  });

  it('never writes into another cell', () => {
    const peer = makePeer(notebookWith([codeCell('a', 'x'), codeCell('b', 'y')]));
    cleanups.push(() => peer.dispose());
    const sink = peer.model.beginExecutionGeneration('a')!;
    sink.setOutputs([stdout('only a')]);
    expect(peer.model.readOutputs(['b']).cells[0]!.outputs).toHaveLength(0);
    expect(peer.model.summary().cells[1]!.executionState).toBe('idle');
  });

  it('updateOutput replaces in place and rejects an index out of range', () => {
    const peer = makePeer(notebookWith([codeCell('a', 'x')]));
    cleanups.push(() => peer.dispose());
    const sink = peer.model.beginExecutionGeneration('a')!;
    sink.setOutputs([stdout('one'), stdout('two')]);
    expect(sink.updateOutput(1, stdout('TWO'))).toBe(true);
    expect(sink.updateOutput(5, stdout('nope'))).toBe(false);
    expect(sink.updateOutput(-1, stdout('nope'))).toBe(false);
    const outputs = sink.getOutputs() as { text: string }[];
    expect(outputs.map((output) => output.text)).toEqual(['one', 'TWO']);
  });

  it('extends a stream through its existing Y.Text instead of replacing the output', () => {
    const peer = makePeer(notebookWith([codeCell('a', 'x')]));
    cleanups.push(() => peer.dispose());
    const sink = peer.model.beginExecutionGeneration('a')!;
    sink.appendOutput(stdout('line 1\n'));
    const cell = codeCellAt(peer.notebook, 0);
    const sharedOutput = cell.youtputs.get(0);
    const sharedText = sharedOutput.get('text');

    expect(sink.appendStream(0, 'line 2\n')).toBe(true);
    expect(cell.youtputs.get(0)).toBe(sharedOutput);
    expect(cell.youtputs.get(0).get('text')).toBe(sharedText);
    expect(sharedText.toString()).toBe('line 1\nline 2\n');
  });

  it('does not materialise the full output for each coalesced stream delta', () => {
    const peer = makePeer(
      notebookWith([codeCell('a', 'x')]),
      { outputsCoalesceMs: 60_000 }
    );
    cleanups.push(() => peer.dispose());
    const sink = peer.model.beginExecutionGeneration('a')!;
    sink.appendOutput(stdout(''));
    const cell = codeCellAt(peer.notebook, 0);
    const getOutputs = vi.spyOn(cell, 'getOutputs');

    for (let index = 0; index < 2_000; index += 1) {
      expect(sink.appendStream(0, 'x')).toBe(true);
    }

    expect(getOutputs).not.toHaveBeenCalled();
  });

  it('finishExecution writes the count and idle together, and only while current', () => {
    const peer = makePeer(notebookWith([codeCell('a', 'x')]));
    cleanups.push(() => peer.dispose());
    const sink = peer.model.beginExecutionGeneration('a')!;
    sink.appendOutput(stdout('42'));

    // Still running: the prompt must stay `[*]`, so no count yet.
    expect(peer.model.summary().cells[0]!.executionCount).toBeNull();
    expect(peer.model.summary().cells[0]!.executionState).toBe('running');

    let updates = 0;
    const onUpdate = (): void => {
      updates++;
    };
    peer.notebook.ydoc.on('update', onUpdate);
    expect(peer.model.finishExecution(sink, { count: 3 })).toBe(true);
    peer.notebook.ydoc.off('update', onUpdate);
    expect(updates).toBe(1);

    const row = peer.model.summary().cells[0]!;
    expect(row.executionCount).toBe(3);
    expect(row.executionState).toBe('idle');

    // A superseded sink cannot finish anything.
    const next = peer.model.beginExecutionGeneration('a')!;
    expect(peer.model.finishExecution(sink, { count: 99 })).toBe(false);
    expect(peer.model.summary().cells[0]!.executionCount).toBeNull();
    expect(next.isCurrent()).toBe(true);
  });

  it('late outputs after idle still reach the same output area (SPEC.md §8)', () => {
    const peer = makePeer(notebookWith([codeCell('a', 'x')]));
    cleanups.push(() => peer.dispose());
    const sink = peer.model.beginExecutionGeneration('a')!;
    peer.model.finishExecution(sink, { count: 1 });
    expect(sink.appendOutput(stdout('late but ours'))).toBe(true);
    expect(peer.model.readOutputs(['a']).cells[0]!.outputs).toHaveLength(1);
  });

  it('sinkFor returns the live generation and null once it is gone', () => {
    const peer = makePeer(notebookWith([codeCell('a', 'x')]));
    cleanups.push(() => peer.dispose());
    expect(peer.model.sinkFor('a')).toBeNull();
    const sink = peer.model.beginExecutionGeneration('a')!;
    expect(peer.model.sinkFor('a')).toBe(sink);
    peer.model.dispose();
    expect(peer.model.sinkFor('a')).toBeNull();
  });

  it('the generation writes are journalled as local, foreign ones as remote', () => {
    const linked = makeLinkedPeers(notebookWith([codeCell('a', 'x')]), { outputsCoalesceMs: 0 });
    cleanups.push(() => linked.dispose());
    const cursor = linked.a.model.changesCursor;
    const sink = linked.a.model.beginExecutionGeneration('a')!;
    sink.appendOutput(stdout('ours'));
    const events = linked.a.model.changesSince(cursor).events;
    expect(events.every((event) => event.kind === 'outputs_changed')).toBe(true);
    expect(events.every((event) => event.origin === 'local')).toBe(true);
  });
});
