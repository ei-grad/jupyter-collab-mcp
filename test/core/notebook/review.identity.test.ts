/** Identity, external-write, cursor, and change-journal coverage. */

import { describe, expect, it } from 'vitest';
import type * as Y from 'yjs';

import { Wire, reviewBook, reviewCode, reviewPeer, typeInto, writeOutputs } from './review.helpers.js';

/** An `aset`-style rewrite: the Y.Map is swapped, the string id is kept. */
function replaceUnderSameId(
  peer: { notebook: import('@jupyter/ydoc').YNotebook },
  cellId: string,
  replacement: Record<string, unknown>
): void {
  const array = peer.notebook.ydoc.getArray<Y.Map<unknown>>('cells');
  let at = -1;
  array.toArray().forEach((ymodel, index) => {
    if (ymodel.get('id') === cellId) at = index;
  });
  if (at < 0) throw new Error(`no cell ${cellId}`);
  peer.notebook.ydoc.transact(() => {
    peer.notebook.deleteCell(at);
    peer.notebook.insertCell(at, { id: cellId, ...replacement } as never);
  });
}

describe('review: page cursors and a replaced Y.Map (SPEC.md §12 "External writes")', () => {
  it('a page cursor issued before an aset-style replacement is rejected', () => {
    const local = reviewPeer(
      11,
      reviewBook([reviewCode('c1', 'one'), reviewCode('c2', 'two'), reviewCode('c3', 'three')])
    );
    const remote = reviewPeer(22);
    const wire = new Wire(local.notebook.ydoc, remote.notebook.ydoc);
    wire.setAuto(true);

    const page1 = local.model.summary({ maxCells: 1 });
    const cursor = page1.pageCursor!;
    expect(cursor).toBeDefined();
    const structureBefore = local.model.structureRevision;

    replaceUnderSameId(remote, 'c2', { cell_type: 'code', source: 'REWRITTEN', metadata: {} });

    // The replacement is observed as such...
    expect(local.model.summary().cells[1]!.preview).toBe('REWRITTEN');
    // ...and the public structural revision, a digest of the ordered ids only,
    // is unchanged - the id did not move. The page cursor is nevertheless
    // bound to cell identity, so it expires: the rest of the page would come
    // from a document whose content the caller has never seen.
    expect(local.model.structureRevision).toBe(structureBefore);
    expect(() => local.model.summary({ maxCells: 1, cursor })).toThrowError(
      expect.objectContaining({ code: 'CURSOR_EXPIRED' })
    );

    wire.dispose();
    local.dispose();
    remote.dispose();
  });

  it('a pure content edit does NOT expire a page cursor (control)', () => {
    const local = reviewPeer(
      11,
      reviewBook([reviewCode('c1', 'one'), reviewCode('c2', 'two'), reviewCode('c3', 'three')])
    );
    const remote = reviewPeer(22);
    const wire = new Wire(local.notebook.ydoc, remote.notebook.ydoc);
    wire.setAuto(true);
    const cursor = local.model.summary({ maxCells: 1 }).pageCursor!;
    typeInto(remote.notebook, 1, 'edited but not moved');
    const page2 = local.model.summary({ maxCells: 1, cursor });
    expect(page2.cells.map((cell) => cell.cellId)).toEqual(['c2']);
    expect(page2.cells[0]!.preview).toBe('edited but not moved');
    wire.dispose();
    local.dispose();
    remote.dispose();
  });

  it('a real structural change does expire the cursor (control)', () => {
    const local = reviewPeer(11, reviewBook([reviewCode('c1', 'one'), reviewCode('c2', 'two')]));
    const remote = reviewPeer(22);
    const wire = new Wire(local.notebook.ydoc, remote.notebook.ydoc);
    wire.setAuto(true);
    const cursor = local.model.summary({ maxCells: 1 }).pageCursor!;
    remote.notebook.ydoc.transact(() => {
      remote.notebook.insertCell(0, { id: 'c0', cell_type: 'code', source: 'new' } as never);
    });
    expect(() => local.model.summary({ maxCells: 1, cursor })).toThrowError(
      expect.objectContaining({ code: 'CURSOR_EXPIRED' })
    );
    wire.dispose();
    local.dispose();
    remote.dispose();
  });
});

describe('review: a duplicated cell id does not silence the change journal (SPEC.md §10)', () => {
  it('remote source and outputs edits of a duplicated id must still be journalled', () => {
    const local = reviewPeer(11, reviewBook([reviewCode('c1', 'one'), reviewCode('c2', 'two')]));
    const remote = reviewPeer(22);
    const wire = new Wire(local.notebook.ydoc, remote.notebook.ydoc);
    wire.setAuto(true);

    // The browser makes the first cell carry the second cell's id - the
    // duplicated-id situation SPEC.md §7 requires the client to survive.
    remote.notebook.ydoc.transact(() => {
      remote.notebook.ydoc.getArray<Y.Map<unknown>>('cells').get(0).set('id', 'c2');
    });
    expect(local.model.duplicateCellIds).toEqual(['c2']);

    const cursor = local.model.changesCursor;
    typeInto(remote.notebook, 0, 'EDITED IN THE BROWSER');
    writeOutputs(remote.notebook, 1, [{ output_type: 'stream', name: 'stdout', text: 'hi' }]);
    local.model.flush();

    // The document really changed on our replica...
    expect(local.notebook.getCell(0).getSource()).toBe('EDITED IN THE BROWSER');
    // ...so SPEC.md §10 requires the journal to report a source change and an
    // outputs change. Observation is keyed on the cell object, not on the
    // ambiguous id: only *addressing* the id is refused (CELL_ID_AMBIGUOUS).
    const events = local.model.changesSince(cursor).events;
    const kinds = events.map((event) => event.kind);
    expect(kinds).toContain('source_changed');
    expect(kinds).toContain('outputs_changed');
    // Both events name the (duplicated) id and carry usable revisions, so the
    // agent can see which address became stale.
    for (const event of events) expect(event.cellId).toBe('c2');
    const sourceEvent = events.find((event) => event.kind === 'source_changed')!;
    expect(sourceEvent.revisions.sourceRevision).toBe(
      local.model.summary().cells[0]!.sourceRevision
    );
    expect(sourceEvent.origin).toBe('remote');
    // Addressing the ambiguous id is still refused (SPEC.md §7).
    expect(() => local.model.cellRef('c2')).toThrowError(
      expect.objectContaining({ code: 'CELL_ID_AMBIGUOUS' })
    );

    wire.dispose();
    local.dispose();
    remote.dispose();
  });

  it('announces cell_deleted for an id that still addresses a live cell', () => {
    const local = reviewPeer(
      11,
      reviewBook([reviewCode('dup', 'one'), reviewCode('dup', 'two'), reviewCode('c3', 'three')])
    );
    const remote = reviewPeer(22);
    const wire = new Wire(local.notebook.ydoc, remote.notebook.ydoc);
    wire.setAuto(true);
    const cursor = local.model.changesCursor;
    remote.notebook.ydoc.transact(() => {
      remote.notebook.deleteCell(1);
    });
    local.model.flush();
    const events = local.model.changesSince(cursor).events;
    expect(events.map((event) => [event.kind, event.cellId])).toEqual([['cell_deleted', 'dup']]);
    // The id is now unambiguous again and addresses a live cell, but the only
    // journal event says it was deleted.
    expect(local.model.index.all('dup')).toHaveLength(1);
    expect(local.model.cellRef('dup').index).toBe(0);
    wire.dispose();
    local.dispose();
    remote.dispose();
  });
});

describe('review: identity survives browser inserts (SPEC.md §12 "Identity and ranges")', () => {
  it('a remote insert shifts the index but keeps the planned execution target', () => {
    const local = reviewPeer(11, reviewBook([reviewCode('c1', 'a'), reviewCode('target', 'b')]));
    const remote = reviewPeer(22);
    const wire = new Wire(local.notebook.ydoc, remote.notebook.ydoc);
    wire.setAuto(true);
    const planned = local.model.cellRef('target');
    expect(planned.index).toBe(1);
    remote.notebook.ydoc.transact(() => {
      remote.notebook.insertCell(0, { id: 'c0', cell_type: 'code', source: 'inserted' } as never);
    });
    const resolved = local.model.resolveRef(planned);
    expect(resolved.index).toBe(2);
    expect(resolved.identityToken).toBe(planned.identityToken);
    expect(local.notebook.getCell(resolved.index).getSource()).toBe('b');
    wire.dispose();
    local.dispose();
    remote.dispose();
  });

  it('a deleted target stops the queue with CELL_NOT_FOUND', () => {
    const local = reviewPeer(11, reviewBook([reviewCode('c1', 'a'), reviewCode('target', 'b')]));
    const remote = reviewPeer(22);
    const wire = new Wire(local.notebook.ydoc, remote.notebook.ydoc);
    wire.setAuto(true);
    const planned = local.model.cellRef('target');
    remote.notebook.ydoc.transact(() => {
      remote.notebook.deleteCell(1);
    });
    expect(() => local.model.resolveRef(planned)).toThrowError(
      expect.objectContaining({ code: 'CELL_NOT_FOUND' })
    );
    wire.dispose();
    local.dispose();
    remote.dispose();
  });

  it('unchanged neighbours keep their revisions and identity across an external rewrite', () => {
    const local = reviewPeer(
      11,
      reviewBook([reviewCode('c1', 'one'), reviewCode('c2', 'two'), reviewCode('c3', 'three')])
    );
    const remote = reviewPeer(22);
    const wire = new Wire(local.notebook.ydoc, remote.notebook.ydoc);
    wire.setAuto(true);
    const before = local.model.summary().cells.map((cell) => cell.cellRevision);
    const tokenC1 = local.model.cellRef('c1').identityToken;
    const tokenC3 = local.model.cellRef('c3').identityToken;

    replaceUnderSameId(remote, 'c2', { cell_type: 'code', source: 'rewritten', metadata: {} });

    const after = local.model.summary().cells.map((cell) => cell.cellRevision);
    expect(after[0]).toBe(before[0]);
    expect(after[2]).toBe(before[2]);
    expect(after[1]).not.toBe(before[1]);
    expect(local.model.cellRef('c1').identityToken).toBe(tokenC1);
    expect(local.model.cellRef('c3').identityToken).toBe(tokenC3);
    expect(() =>
      local.model.resolveRef({ cellId: 'c2', index: 1, identityToken: 'stale-token' })
    ).toThrowError(expect.objectContaining({ code: 'CELL_REPLACED' }));

    wire.dispose();
    local.dispose();
    remote.dispose();
  });
});
