import { afterEach, describe, expect, it } from 'vitest';

import { isCoreError } from '../../../src/core/index.js';
import { ChangeJournal } from '../../../src/core/notebook/index.js';
import { codeCell, makeLinkedPeers, makePeer, notebookWith } from './helpers.js';

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
});

function codeOf(error: unknown): string {
  expect(isCoreError(error)).toBe(true);
  return (error as { code: string }).code;
}

describe('ChangeJournal ring and cursors (SPEC.md §9, §10)', () => {
  it('assigns contiguous monotonic sequences', () => {
    const journal = new ChangeJournal({ limit: 4 });
    cleanups.push(() => journal.dispose());
    const first = journal.publish({ kind: 'cell_added', revisions: {}, origin: 'local' });
    const second = journal.publish({ kind: 'cell_deleted', revisions: {}, origin: 'remote' });
    expect([first.sequence, second.sequence]).toEqual([1, 2]);
    expect(journal.cursor).toBe('chg_2');
  });

  it('returns events after a cursor and a usable next cursor', () => {
    const journal = new ChangeJournal({ limit: 10 });
    cleanups.push(() => journal.dispose());
    for (let i = 0; i < 5; i++) {
      journal.publish({ kind: 'cell_added', revisions: {}, origin: 'local' });
    }
    const page = journal.since('chg_2', 2);
    expect(page.events.map((event) => event.sequence)).toEqual([3, 4]);
    expect(page.nextCursor).toBe('chg_4');
    expect(journal.since(page.nextCursor).events.map((event) => event.sequence)).toEqual([5]);
  });

  it('expires a cursor that fell out of the ring', () => {
    const journal = new ChangeJournal({ limit: 3 });
    cleanups.push(() => journal.dispose());
    for (let i = 0; i < 6; i++) {
      journal.publish({ kind: 'cell_added', revisions: {}, origin: 'local' });
    }
    // Retains 4..6; a cursor at 3 is still the boundary, 2 is gone.
    expect(journal.since('chg_3').events.map((event) => event.sequence)).toEqual([4, 5, 6]);
    try {
      journal.since('chg_2');
      expect.unreachable();
    } catch (error) {
      expect(codeOf(error)).toBe('CURSOR_EXPIRED');
    }
  });

  it('rejects a malformed cursor and one from the future', () => {
    const journal = new ChangeJournal({ limit: 3 });
    cleanups.push(() => journal.dispose());
    try {
      journal.since('pg_x1_abc.0');
      expect.unreachable();
    } catch (error) {
      expect(codeOf(error)).toBe('INVALID_ARGUMENT');
    }
    try {
      journal.since('chg_99');
      expect.unreachable();
    } catch (error) {
      expect(codeOf(error)).toBe('INVALID_ARGUMENT');
    }
  });

  it('coalesces outputs per cell inside the window and publishes once', () => {
    let now = 1_000;
    const journal = new ChangeJournal({ limit: 100, coalesceMs: 100, now: () => now });
    cleanups.push(() => journal.dispose());
    journal.recordOutputs('a', { outputsRevision: 'o1_1' as never }, 'local');
    expect(journal.lastSequence).toBe(1); // first one goes out immediately

    now = 1_010;
    journal.recordOutputs('a', { outputsRevision: 'o1_2' as never }, 'local');
    journal.recordOutputs('a', { outputsRevision: 'o1_3' as never }, 'local');
    expect(journal.lastSequence).toBe(1);
    expect(journal.hasPending).toBe(true);

    journal.flush();
    expect(journal.lastSequence).toBe(2);
    const published = journal.since('chg_1').events;
    expect(published).toHaveLength(1);
    // Only the newest revision survives coalescing (SPEC.md §10).
    expect(published[0]!.revisions.outputsRevision).toBe('o1_3');
  });

  it('materialises only the newest pending output revisions', () => {
    let now = 1_000;
    let materialised = 0;
    const journal = new ChangeJournal({ limit: 100, coalesceMs: 100, now: () => now });
    cleanups.push(() => journal.dispose());
    journal.recordOutputs('a', () => {
      materialised += 1;
      return { outputsRevision: 'o1_1' as never };
    }, 'local');
    expect(materialised).toBe(1);

    now = 1_010;
    journal.recordOutputs('a', () => {
      materialised += 1;
      return { outputsRevision: 'o1_2' as never };
    }, 'local');
    journal.recordOutputs('a', () => {
      materialised += 1;
      return { outputsRevision: 'o1_3' as never };
    }, 'local');
    expect(materialised).toBe(1);

    journal.flush();
    expect(materialised).toBe(2);
    expect(journal.since('chg_1').events[0]!.revisions.outputsRevision).toBe('o1_3');
  });

  it('coalesces per cell, not globally', () => {
    let now = 0;
    const journal = new ChangeJournal({ limit: 100, coalesceMs: 100, now: () => now });
    cleanups.push(() => journal.dispose());
    journal.recordOutputs('a', {}, 'local');
    journal.recordOutputs('b', {}, 'local');
    expect(journal.lastSequence).toBe(2);
    now = 10;
    journal.recordOutputs('a', {}, 'local');
    journal.recordOutputs('b', {}, 'local');
    expect(journal.lastSequence).toBe(2);
    journal.flushCell('a');
    expect(journal.lastSequence).toBe(3);
    expect(journal.hasPending).toBe(true);
  });

  it('publishes pending records with the timer, without holding the event loop', async () => {
    const journal = new ChangeJournal({ limit: 100, coalesceMs: 5 });
    cleanups.push(() => journal.dispose());
    journal.recordOutputs('a', {}, 'local');
    journal.recordOutputs('a', {}, 'local');
    expect(journal.hasPending).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(journal.hasPending).toBe(false);
    expect(journal.lastSequence).toBe(2);
  });
});

describe('journal over the model (SPEC.md §10)', () => {
  it('classifies local and remote by transaction origin', () => {
    const linked = makeLinkedPeers(notebookWith([codeCell('a', 'one')]));
    cleanups.push(() => linked.dispose());
    const cursor = linked.a.model.changesCursor;

    linked.a.model.apply([{ op: 'add_cell', cellType: 'code', source: 'local', position: 'end' }]);
    linked.b.model.apply([{ op: 'add_cell', cellType: 'code', source: 'remote', position: 'end' }]);

    const events = linked.a.model.changesSince(cursor).events;
    const origins = events.filter((event) => event.kind === 'cell_added').map((e) => e.origin);
    expect(origins).toEqual(['local', 'remote']);
  });

  it('a write that bypasses the model origin is reported as remote', () => {
    const peer = makePeer(notebookWith([codeCell('a', 'one')]));
    cleanups.push(() => peer.dispose());
    const cursor = peer.model.changesCursor;
    peer.notebook.getCell(0).setSource('changed by the library API');
    const events = peer.model.changesSince(cursor).events;
    expect(events.map((event) => event.kind)).toContain('source_changed');
    expect(events[0]!.origin).toBe('remote');
  });

  it('flushes the pending outputs record before a source event of the same cell', () => {
    let now = 0;
    const peer = makePeer(notebookWith([codeCell('a', 'one')]), {
      outputsCoalesceMs: 100,
      now: () => now
    });
    cleanups.push(() => peer.dispose());
    const sink = peer.model.beginExecutionGeneration('a')!;
    const cursor = peer.model.changesCursor;

    now = 5;
    sink.appendOutput({ output_type: 'stream', name: 'stdout', text: 'a' });
    now = 10;
    sink.appendOutput({ output_type: 'stream', name: 'stdout', text: 'b' });
    // Both are still pending: only one publication per 100 ms window.
    expect(peer.model.changesSince(cursor).events).toHaveLength(0);

    peer.notebook.getCell(0).setSource('edited while running');
    const kinds = peer.model.changesSince(cursor).events.map((event) => event.kind);
    expect(kinds[0]).toBe('outputs_changed');
    expect(kinds).toContain('source_changed');
  });

  it('snapshotWithCursor flushes first, so no change hides behind the cursor', () => {
    let now = 0;
    const peer = makePeer(notebookWith([codeCell('a', 'one')]), {
      outputsCoalesceMs: 100,
      now: () => now
    });
    cleanups.push(() => peer.dispose());
    const sink = peer.model.beginExecutionGeneration('a')!;
    now = 1;
    sink.appendOutput({ output_type: 'stream', name: 'stdout', text: 'x' });
    now = 2;
    sink.appendOutput({ output_type: 'stream', name: 'stdout', text: 'y' });

    const snapshot = peer.model.snapshotWithCursor();
    expect(snapshot.changesCursor).toBe(snapshot.summary.changesCursor);
    // Everything before the cursor is published; nothing is pending behind it.
    expect(peer.model.changesSince(snapshot.changesCursor).events).toHaveLength(0);
    const outputs = peer.model.readOutputs(['a']).cells[0]!.outputs;
    expect(outputs).toHaveLength(2);
  });

  it('published sequences are never rewritten', () => {
    const peer = makePeer(notebookWith([codeCell('a', 'one')]), { outputsCoalesceMs: 0 });
    cleanups.push(() => peer.dispose());
    const cursor = peer.model.changesCursor;
    peer.model.apply([{ op: 'add_cell', cellType: 'code', source: 'x', position: 'end' }]);
    const first = peer.model.changesSince(cursor).events.map((event) => event.sequence);
    peer.model.apply([{ op: 'add_cell', cellType: 'code', source: 'y', position: 'end' }]);
    const again = peer.model.changesSince(cursor).events.slice(0, first.length);
    expect(again.map((event) => event.sequence)).toEqual(first);
  });

  it('records connection state and kernel binding events', () => {
    const peer = makePeer(notebookWith([codeCell('a', '')]));
    cleanups.push(() => peer.dispose());
    const cursor = peer.model.changesCursor;
    peer.model.recordConnectionState('reconnecting');
    peer.model.recordKernelChange('kernel-1');
    const events = peer.model.changesSince(cursor).events;
    expect(events.map((event) => event.kind)).toEqual(['connection_state', 'kernel_changed']);
    expect(events[0]!.connectionState).toBe('reconnecting');
    expect(events[1]!.kernelId).toBe('kernel-1');
  });

  it('a small ring expires an old cursor over the model', () => {
    const peer = makePeer(notebookWith([codeCell('a', 'one')]), { journalLimit: 2 });
    cleanups.push(() => peer.dispose());
    const cursor = peer.model.changesCursor;
    for (let i = 0; i < 5; i++) {
      peer.model.apply([{ op: 'add_cell', cellType: 'code', source: `c${i}`, position: 'end' }]);
    }
    try {
      peer.model.changesSince(cursor);
      expect.unreachable();
    } catch (error) {
      expect(codeOf(error)).toBe('CURSOR_EXPIRED');
    }
  });

  it('a new cell is announced once, without a separate source event', () => {
    const peer = makePeer(notebookWith([codeCell('a', 'one')]), { outputsCoalesceMs: 0 });
    cleanups.push(() => peer.dispose());
    const cursor = peer.model.changesCursor;
    const added = peer.model.apply([
      { op: 'add_cell', cellType: 'code', source: 'brand new', position: 'end' }
    ]);
    const newId = added.results[0]!.cellId!;
    const events = peer.model.changesSince(cursor).events;
    expect(events.filter((event) => event.cellId === newId).map((event) => event.kind)).toEqual([
      'cell_added'
    ]);
  });
});
