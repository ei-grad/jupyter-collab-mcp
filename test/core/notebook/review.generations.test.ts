/**
 * Output-area generation and shared-execution coverage.
 *
 * Two boundaries:
 *
 * 1. the self-attribution of a generation's own writes. Yjs runs deep
 *    observers when the OUTERMOST transaction ends, so a caller that groups
 *    several sink writes into one transaction of its own used to make the
 *    observer see them as foreign and revoke the generation. The claim is
 *    therefore keyed on the transaction object, not on a transient flag;
 * 2. what a sink actually stores, given that the shared contract's
 *    `NbStreamOutput.text` is `string | readonly string[]` and
 *    `YCodeCell.createOutputs` joins a list with `text.join()` - commas
 *    included - unless the value is normalised on the way in.
 */

import { describe, expect, it } from 'vitest';

import type { NbOutput } from '../../../src/core/types.js';
import type { OutputSink } from '../../../src/core/types.js';
import { Wire, reviewBook, reviewCode, reviewPeer, typeInto, writeOutputs } from './review.helpers.js';

const stream = (text: string | readonly string[]): NbOutput =>
  ({ output_type: 'stream', name: 'stdout', text }) as NbOutput;

describe('review: a generation attributes its own writes inside a caller transaction', () => {
  it('beginExecutionGeneration inside a caller transaction hands out a live sink', () => {
    const peer = reviewPeer(11, reviewBook([reviewCode('c1', 'print(1)')]));
    let sink: OutputSink | null = null;
    // A caller that groups "clear the area and note the start" into one Yjs
    // transaction of its own. The registry's clear then lands in an outer
    // transaction whose observers run only at its end - after any transient
    // "currently writing" flag would have been restored - so the generation
    // must be claimed per transaction to survive this.
    peer.notebook.ydoc.transact(() => {
      sink = peer.model.beginExecutionGeneration('c1');
    });
    expect(sink).not.toBeNull();
    // The sink was handed out as the single writer of a fresh generation.
    expect(sink!.isCurrent()).toBe(true);
    expect(sink!.appendOutput(stream('hello'))).toBe(true);
    // ...and the write really reached the shared document, so `true` is not a
    // bookkeeping artefact.
    const stored = peer.model.readOutputs(['c1']).cells[0]!;
    expect(stored.outputs).toHaveLength(1);
    expect((stored.outputs[0]!.output as { text: string }).text).toBe('hello');
    expect(stored.executionState).toBe('running');
    // The generation can still terminate normally (SPEC.md §8).
    expect(peer.model.finishExecution(sink!, { count: 3 })).toBe(true);
    const finished = peer.model.readOutputs(['c1']).cells[0]!;
    expect(finished.executionCount).toBe(3);
    expect(finished.executionState).toBe('idle');
    peer.dispose();
  });

  it('an OutputSink write nested in a caller transaction does not revoke its own generation', () => {
    const peer = reviewPeer(11, reviewBook([reviewCode('c1', 'print(1)')]));
    const sink = peer.model.beginExecutionGeneration('c1')!;
    expect(sink.isCurrent()).toBe(true);
    peer.notebook.ydoc.transact(() => {
      sink.appendOutput(stream('first'));
    });
    // Nothing foreign happened - the only writer was this very sink.
    expect(sink.isCurrent()).toBe(true);
    expect(sink.appendOutput(stream('second'))).toBe(true);
    const texts = peer.model
      .readOutputs(['c1'])
      .cells[0]!.outputs.map((output) => (output.output as { text: string }).text);
    expect(texts).toEqual(['first', 'second']);
    peer.dispose();
  });

  it('a foreign write inside the same caller transaction still revokes it', () => {
    // The claim is per transaction *and* per cell, not a blanket amnesty: a
    // second generation opened on the same cell in the same transaction is the
    // newer writer, and the first sink is dead (SPEC.md §8).
    const peer = reviewPeer(11, reviewBook([reviewCode('c1', 'x')]));
    const first = peer.model.beginExecutionGeneration('c1')!;
    let second: OutputSink | null = null;
    peer.notebook.ydoc.transact(() => {
      first.appendOutput(stream('old'));
      second = peer.model.beginExecutionGeneration('c1');
    });
    expect(first.isCurrent()).toBe(false);
    expect(first.appendOutput(stream('late'))).toBe(false);
    expect(second!.isCurrent()).toBe(true);
    peer.dispose();
  });
});

describe('review: OutputSink and nbformat stream text (SPEC.md §12 "Outputs")', () => {
  it('keeps a multi-line stream output whose text arrives as a list of lines', () => {
    const peer = reviewPeer(11, reviewBook([reviewCode('c1', 'print(1)')]));
    const sink = peer.model.beginExecutionGeneration('c1')!;
    // `NbStreamOutput.text` is `string | readonly string[]` in the shared
    // contract, and this is the shape nbformat itself uses on disk.
    expect(sink.setOutputs([stream(['line1\n', 'line2\n'])])).toBe(true);
    const stored = peer.model.readOutputs(['c1']).cells[0]!.outputs[0]!.output as {
      text: string;
    };
    expect(stored.text).toBe('line1\nline2\n');
    peer.dispose();
  });

  it('appendOutput normalises a list-of-lines stream text too', () => {
    const peer = reviewPeer(11, reviewBook([reviewCode('c1', 'print(1)')]));
    const sink = peer.model.beginExecutionGeneration('c1')!;
    expect(sink.appendOutput(stream(['a\n', 'b\n']))).toBe(true);
    const stored = peer.model.readOutputs(['c1']).cells[0]!.outputs[0]!.output as {
      text: string;
    };
    expect(stored.text).toBe('a\nb\n');
    peer.dispose();
  });

  it('updateOutput normalises a list-of-lines stream text as well', () => {
    const peer = reviewPeer(11, reviewBook([reviewCode('c1', 'print(1)')]));
    const sink = peer.model.beginExecutionGeneration('c1')!;
    sink.appendOutput(stream('first'));
    expect(sink.updateOutput(0, stream(['a\n', 'b\n']))).toBe(true);
    const stored = peer.model.readOutputs(['c1']).cells[0]!.outputs[0]!.output as { text: string };
    expect(stored.text).toBe('a\nb\n');
    peer.dispose();
  });

  it('a plain string stream output is stored verbatim (control)', () => {
    const peer = reviewPeer(11, reviewBook([reviewCode('c1', 'print(1)')]));
    const sink = peer.model.beginExecutionGeneration('c1')!;
    sink.setOutputs([stream('line1\nline2\n')]);
    const stored = peer.model.readOutputs(['c1']).cells[0]!.outputs[0]!.output as {
      text: string;
    };
    expect(stored.text).toBe('line1\nline2\n');
    peer.dispose();
  });
});

describe('review: races around a live generation (SPEC.md §8)', () => {
  it('a remote source and metadata edit during execution does not steal the output area', () => {
    const local = reviewPeer(11, reviewBook([reviewCode('c1', 'sleep(3)')]));
    const remote = reviewPeer(22);
    const wire = new Wire(local.notebook.ydoc, remote.notebook.ydoc);
    wire.setAuto(true);
    const sink = local.model.beginExecutionGeneration('c1')!;
    typeInto(remote.notebook, 0, 'the user is typing');
    remote.notebook.ydoc.transact(() => {
      remote.notebook.getCell(0).setMetadata('tags', ['x']);
    });
    expect(sink.isCurrent()).toBe(true);
    expect(sink.appendOutput(stream('ours'))).toBe(true);
    wire.dispose();
    local.dispose();
    remote.dispose();
  });

  it('a peer reserialising the same output state does not steal the generation', () => {
    const local = reviewPeer(11, reviewBook([reviewCode('c1', 'print(1)')]));
    const remote = reviewPeer(22);
    const wire = new Wire(local.notebook.ydoc, remote.notebook.ydoc);
    wire.setAuto(true);
    const sink = local.model.beginExecutionGeneration('c1')!;
    expect(sink.appendOutput(stream('line 1\n'))).toBe(true);

    const remoteCell = remote.notebook.getCell(0) as unknown as { getOutputs(): unknown[] };
    writeOutputs(remote.notebook, 0, remoteCell.getOutputs());

    expect(sink.isCurrent()).toBe(true);
    expect(sink.updateOutput(0, stream('line 1\nline 2\n'))).toBe(true);
    expect(local.model.finishExecution(sink, { count: 1 })).toBe(true);
    const finished = local.model.readOutputs(['c1']).cells[0]!;
    expect((finished.outputs[0]!.output as { text: string }).text).toBe('line 1\nline 2\n');
    expect(finished.executionCount).toBe(1);
    expect(finished.executionState).toBe('idle');
    wire.dispose();
    local.dispose();
    remote.dispose();
  });

  it('a clear sharing an outer transaction with a sink write still revokes it', () => {
    const peer = reviewPeer(11, reviewBook([reviewCode('c1', 'print(1)')]));
    const sink = peer.model.beginExecutionGeneration('c1')!;
    expect(sink.appendOutput(stream('line 1\n'))).toBe(true);

    peer.notebook.ydoc.transact(() => {
      expect(sink.appendStream(0, 'line 2\n')).toBe(true);
      const revision = peer.model.summary().cells[0]!.outputsRevision!;
      peer.model.apply([{ op: 'clear_outputs', cellId: 'c1', expectedOutputsRevision: revision }]);
    });

    expect(sink.isCurrent()).toBe(false);
    expect(sink.appendOutput(stream('late'))).toBe(false);
    expect(peer.model.finishExecution(sink, { count: 1 })).toBe(false);
    expect(peer.model.readOutputs(['c1']).cells[0]!.outputs).toHaveLength(0);
    peer.dispose();
  });

  it('an unclaimed stream append in the sink transaction revokes it', () => {
    const peer = reviewPeer(11, reviewBook([reviewCode('c1', 'print(1)')]));
    const sink = peer.model.beginExecutionGeneration('c1')!;
    expect(sink.appendOutput(stream('a'))).toBe(true);
    const cell = peer.notebook.getCell(0) as unknown as {
      youtputs: { get(index: number): { get(key: string): { insert(index: number, text: string): void; length: number } } };
    };

    peer.notebook.ydoc.transact(() => {
      expect(sink.appendStream(0, 'b')).toBe(true);
      const sharedText = cell.youtputs.get(0).get('text');
      sharedText.insert(sharedText.length, 'FOREIGN');
    });

    expect(sink.isCurrent()).toBe(false);
    expect(sink.appendOutput(stream('late'))).toBe(false);
    expect(peer.model.finishExecution(sink, { count: 1 })).toBe(false);
    peer.dispose();
  });

  it('a queued remote stream delta delivered in the sink transaction revokes it', () => {
    const local = reviewPeer(11, reviewBook([reviewCode('c1', 'print(1)')]));
    const remote = reviewPeer(22);
    const wire = new Wire(local.notebook.ydoc, remote.notebook.ydoc);
    const sink = local.model.beginExecutionGeneration('c1')!;
    expect(sink.appendOutput(stream('line 1\n'))).toBe(true);
    wire.deliver();

    const remoteCell = remote.notebook.getCell(0) as unknown as {
      youtputs: {
        get(index: number): {
          get(key: string): { insert(index: number, text: string): void; length: number };
        };
      };
    };
    const remoteText = remoteCell.youtputs.get(0).get('text');
    remoteText.insert(remoteText.length, 'foreign\n');

    local.notebook.ydoc.transact(() => {
      expect(sink.appendStream(0, 'line 2\n')).toBe(true);
      wire.deliver();
    });

    expect(sink.isCurrent()).toBe(false);
    expect(sink.appendOutput(stream('late'))).toBe(false);
    expect(local.model.finishExecution(sink, { count: 1 })).toBe(false);
    wire.dispose();
    local.dispose();
    remote.dispose();
  });

  it('a reconnect-style merged resync carrying a foreign output write revokes the generation', () => {
    const local = reviewPeer(11, reviewBook([reviewCode('c1', 'x')]));
    const remote = reviewPeer(22);
    const wire = new Wire(local.notebook.ydoc, remote.notebook.ydoc);
    const sink = local.model.beginExecutionGeneration('c1')!;
    wire.deliver();
    // Disconnection window: the browser edits and runs the same cell.
    typeInto(remote.notebook, 0, 'typed');
    writeOutputs(remote.notebook, 0, [{ output_type: 'stream', name: 'stdout', text: 'theirs' }]);
    // The whole backlog arrives as ONE update, the way an RTC resync does.
    wire.deliverMergedToA();
    expect(sink.isCurrent()).toBe(false);
    expect(sink.appendOutput(stream('ours'))).toBe(false);
    expect(local.model.finishExecution(sink, { count: 7 })).toBe(false);
    // SPEC.md §12 "External writes": external outputs are not overwritten.
    const outputs = local.model.readOutputs(['c1']).cells[0]!.outputs;
    expect(outputs).toHaveLength(1);
    expect((outputs[0]!.output as { text: string }).text).toBe('theirs');
    expect(local.notebook.getCell(0).getSource()).toBe('typed');
    wire.dispose();
    local.dispose();
    remote.dispose();
  });

  it('our own clear_outputs through apply() revokes a live generation', () => {
    const peer = reviewPeer(11, reviewBook([reviewCode('c1', 'x')]));
    const sink = peer.model.beginExecutionGeneration('c1')!;
    sink.appendOutput(stream('partial'));
    const rev = peer.model.summary().cells[0]!.outputsRevision!;
    peer.model.apply([{ op: 'clear_outputs', cellId: 'c1', expectedOutputsRevision: rev }]);
    expect(sink.isCurrent()).toBe(false);
    expect(sink.appendOutput(stream('late'))).toBe(false);
    expect(peer.model.readOutputs(['c1']).cells[0]!.outputs).toHaveLength(0);
    peer.dispose();
  });

  it('a second beginExecutionGeneration on the same cell kills the first sink', () => {
    const peer = reviewPeer(11, reviewBook([reviewCode('c1', 'x')]));
    const first = peer.model.beginExecutionGeneration('c1')!;
    first.appendOutput(stream('old'));
    const second = peer.model.beginExecutionGeneration('c1')!;
    expect(first.isCurrent()).toBe(false);
    expect(first.setExecutionCount(1)).toBe(false);
    expect(first.setExecutionState('idle')).toBe(false);
    expect(second.isCurrent()).toBe(true);
    expect(peer.model.readOutputs(['c1']).cells[0]!.outputs).toHaveLength(0);
    peer.dispose();
  });
});
