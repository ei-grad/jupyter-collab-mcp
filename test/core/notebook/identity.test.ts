import { afterEach, describe, expect, it } from 'vitest';

import { isCoreError } from '../../../src/core/index.js';
import {
  Bridge,
  codeCell,
  makeLinkedPeers,
  makePeer,
  notebookWith,
  renameCellExternally,
  replaceCellExternally
} from './helpers.js';

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
});

function expectCode(error: unknown, code: string): void {
  expect(isCoreError(error)).toBe(true);
  expect((error as { code: string }).code).toBe(code);
}

describe('cell index and identity (SPEC.md §7, §6 "External file changes")', () => {
  it('addresses cells by id and reports their current index', () => {
    const peer = makePeer(notebookWith([codeCell('a', 'one'), codeCell('b', 'two')]));
    cleanups.push(() => peer.dispose());
    expect(peer.model.cellRef('b').index).toBe(1);
    expect(peer.model.summary().cells.map((cell) => cell.cellId)).toEqual(['a', 'b']);
  });

  it('is not ready before nbformat exists, ready afterwards (spike/NOTES.md §4)', () => {
    const empty = makePeer();
    cleanups.push(() => empty.dispose());
    expect(empty.model.isReady()).toBe(false);
    empty.notebook.setSource(notebookWith([codeCell('a', '')]) as never);
    expect(empty.model.isReady()).toBe(true);
  });

  it('reports a duplicate id, blocks only the operations addressing it', () => {
    const peer = makePeer(
      notebookWith([codeCell('dup', 'one'), codeCell('ok', 'two'), codeCell('dup', 'three')])
    );
    cleanups.push(() => peer.dispose());
    const summary = peer.model.summary();
    expect(summary.duplicateCellIds).toEqual(['dup']);
    expect(summary.cells.filter((cell) => cell.duplicateId === true)).toHaveLength(2);
    expect(summary.cells.find((cell) => cell.cellId === 'ok')?.duplicateId).toBeUndefined();

    expect(() => peer.model.cellRef('dup')).toThrowError();
    try {
      peer.model.cellRef('dup');
    } catch (error) {
      expectCode(error, 'CELL_ID_AMBIGUOUS');
    }
    // The unambiguous neighbour keeps working.
    expect(peer.model.cellRef('ok').index).toBe(1);
  });

  it('an unknown id is CELL_NOT_FOUND', () => {
    const peer = makePeer(notebookWith([codeCell('a', '')]));
    cleanups.push(() => peer.dispose());
    try {
      peer.model.cellRef('missing');
      expect.unreachable();
    } catch (error) {
      expectCode(error, 'CELL_NOT_FOUND');
    }
  });

  it('detects a Y.Map replacement under a retained id and kills old references', () => {
    const linked = makeLinkedPeers(notebookWith([codeCell('a', 'one'), codeCell('b', 'two')]));
    cleanups.push(() => linked.dispose());
    const ref = linked.a.model.cellRef('b');
    const before = linked.a.model.changesCursor;

    replaceCellExternally(linked.b.notebook, 'b', {
      cell_type: 'code',
      source: 'rewritten',
      metadata: {},
      outputs: [],
      execution_count: null
    });

    const events = linked.a.model.changesSince(before).events;
    expect(events.map((event) => event.kind)).toContain('cell_replaced');
    expect(events.find((event) => event.kind === 'cell_replaced')?.cellId).toBe('b');
    expect(events.every((event) => event.origin === 'remote')).toBe(true);

    // The string id still resolves, the old reference does not (SPEC.md §7).
    expect(linked.a.model.cellRef('b').identityToken).not.toBe(ref.identityToken);
    try {
      linked.a.model.resolveRef(ref);
      expect.unreachable();
    } catch (error) {
      expectCode(error, 'CELL_REPLACED');
    }
  });

  it('follows a server-side id rename: old address dies, new one appears', () => {
    const linked = makeLinkedPeers(notebookWith([codeCell('dup', 'one')]));
    cleanups.push(() => linked.dispose());
    const before = linked.a.model.changesCursor;
    renameCellExternally(linked.b.notebook, 'dup', 'fresh');

    const kinds = linked.a.model.changesSince(before).events.map((event) => event.kind);
    expect(kinds).toEqual(expect.arrayContaining(['cell_deleted', 'cell_added']));
    expect(linked.a.model.cellRef('fresh').index).toBe(0);
    try {
      linked.a.model.cellRef('dup');
      expect.unreachable();
    } catch (error) {
      expectCode(error, 'CELL_NOT_FOUND');
    }
  });

  it('sees a remote insert and reorder without losing the other cells', () => {
    const linked = makeLinkedPeers(notebookWith([codeCell('a', 'one'), codeCell('b', 'two')]));
    cleanups.push(() => linked.dispose());
    linked.b.notebook.insertCell(1, { id: 'c', cell_type: 'code', source: 'mid' } as never);
    expect(linked.a.model.summary().cells.map((cell) => cell.cellId)).toEqual(['a', 'c', 'b']);
    expect(linked.a.model.cellRef('b').index).toBe(2);
  });

  it('a held-back update is applied on delivery, one Bridge, no duplicate observers', () => {
    const a = makePeer(notebookWith([codeCell('a', 'one')]));
    const b = makePeer();
    const bridge = new Bridge(a.notebook.ydoc, b.notebook.ydoc);
    cleanups.push(() => {
      bridge.dispose();
      a.dispose();
      b.dispose();
    });
    bridge.syncInitial();
    expect(b.model.summary().cellCount).toBe(1);

    b.notebook.getCell(0).setSource('changed remotely');
    expect(a.model.summary().cells[0]?.preview).toBe('one');
    bridge.flush();
    expect(a.model.summary().cells[0]?.preview).toBe('changed remotely');
  });
});
