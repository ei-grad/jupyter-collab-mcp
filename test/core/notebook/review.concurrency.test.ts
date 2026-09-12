/**
 * Adversarial review: SPEC.md §12 "Concurrent edits" and "Document data".
 *
 * The point of interest is not convergence - Yjs guarantees that - but whether
 * an operation touches more of the shared document than SPEC.md §7 says it
 * does: "Untouched keys are preserved."
 */

import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';

import type { DeleteNotebookMetadataOperation, SetNotebookMetadataOperation } from '../../../src/core/types.js';
import { Wire, reviewBook, reviewCode, reviewPeer, typeInto } from './review.helpers.js';

/**
 * Both replicas already agree; then the browser changes metadata key `keepme`
 * while we delete the unrelated key `doomed`. `YNotebook.deleteMetadata` is
 * implemented as `metadata = {...}; delete metadata[key]; setMetadata(metadata)`
 * and the object form of `setMetadata` does `ymetadata.clear()` followed by a
 * `set` of every surviving key, so our delete rewrites keys we never named.
 */
function raceNotebookMetadata(localClientId: number, remoteClientId: number): {
  merged: Record<string, unknown>;
} {
  const local = reviewPeer(
    localClientId,
    reviewBook([reviewCode('c1', 'x')], {
      kernelspec: { name: 'python3' },
      keepme: { deep: 1 },
      doomed: true
    })
  );
  const remote = reviewPeer(remoteClientId);
  const wire = new Wire(local.notebook.ydoc, remote.notebook.ydoc);

  // Divergence window: neither side sees the other.
  remote.notebook.ydoc.transact(() => {
    remote.notebook.setMetadata('keepme', { deep: 42 });
  });
  const operation: DeleteNotebookMetadataOperation = {
    op: 'delete_notebook_metadata',
    key: 'doomed',
    expectedNotebookMetadataRevision: local.model.summary().notebookMetadataRevision
  };
  local.model.apply([operation]);

  wire.deliver();
  const merged = local.notebook.getMetadata() as Record<string, unknown>;
  expect(merged).toEqual(remote.notebook.getMetadata());
  wire.dispose();
  local.dispose();
  remote.dispose();
  return { merged };
}

describe('review: delete_notebook_metadata rewrites keys it was not asked to touch', () => {
  it('reverts a concurrent remote edit of an unrelated key when we hold the higher client id', () => {
    const { merged } = raceNotebookMetadata(999, 1);
    // The browser wrote {deep: 42}; our delete of an unrelated key put {deep: 1}
    // back over it and both replicas converged on the stale value.
    expect(merged['doomed']).toBeUndefined();
    expect(merged['keepme']).toEqual({ deep: 42 });
  });

  it('keeps the concurrent edit when the client ids happen to fall the other way', () => {
    const { merged } = raceNotebookMetadata(1, 999);
    expect(merged['keepme']).toEqual({ deep: 42 });
  });

  it('a per-key delete of the same key would not have touched the concurrent edit', () => {
    // Counterfactual with identical client ids and timing, deleting the key
    // straight out of the metadata Y.Map instead of through the model.
    const local = reviewPeer(
      999,
      reviewBook([reviewCode('c1', 'x')], { keepme: { deep: 1 }, doomed: true })
    );
    const remote = reviewPeer(1);
    const wire = new Wire(local.notebook.ydoc, remote.notebook.ydoc);
    remote.notebook.ydoc.transact(() => {
      remote.notebook.setMetadata('keepme', { deep: 42 });
    });
    local.notebook.ydoc.transact(() => {
      (local.notebook.ymeta.get('metadata') as Y.Map<unknown>).delete('doomed');
    });
    wire.deliver();
    expect(local.notebook.getMetadata()).toEqual({ keepme: { deep: 42 } });
    wire.dispose();
    local.dispose();
    remote.dispose();
  });

  it('set_notebook_metadata is per-key and does not have the problem', () => {
    const local = reviewPeer(
      999,
      reviewBook([reviewCode('c1', 'x')], { keepme: { deep: 1 }, doomed: true })
    );
    const remote = reviewPeer(1);
    const wire = new Wire(local.notebook.ydoc, remote.notebook.ydoc);
    remote.notebook.ydoc.transact(() => {
      remote.notebook.setMetadata('keepme', { deep: 42 });
    });
    const operation: SetNotebookMetadataOperation = {
      op: 'set_notebook_metadata',
      key: 'added',
      value: 7,
      expectedNotebookMetadataRevision: local.model.summary().notebookMetadataRevision
    };
    local.model.apply([operation]);
    wire.deliver();
    expect(local.notebook.getMetadata()).toEqual({
      keepme: { deep: 42 },
      doomed: true,
      added: 7
    });
    wire.dispose();
    local.dispose();
    remote.dispose();
  });
});

describe('review: concurrent cell edits still converge (SPEC.md §12)', () => {
  it('two concurrent replace_source on different cells converge with equal revisions', () => {
    const a = reviewPeer(11, reviewBook([reviewCode('c1', 'aaa'), reviewCode('c2', 'bbb')]));
    const b = reviewPeer(22);
    const wire = new Wire(a.notebook.ydoc, b.notebook.ydoc);
    const sa = a.model.summary();
    const sb = b.model.summary();
    a.model.apply([
      {
        op: 'replace_source',
        cellId: 'c1',
        expectedSourceRevision: sa.cells[0]!.sourceRevision,
        source: 'from a'
      }
    ]);
    b.model.apply([
      {
        op: 'replace_source',
        cellId: 'c2',
        expectedSourceRevision: sb.cells[1]!.sourceRevision,
        source: 'from b'
      }
    ]);
    wire.deliver();
    const finalA = a.model.summary().cells.map((cell) => [cell.cellId, cell.sourceRevision]);
    const finalB = b.model.summary().cells.map((cell) => [cell.cellId, cell.sourceRevision]);
    expect(finalA).toEqual(finalB);
    expect(a.notebook.getCell(0).getSource()).toBe('from a');
    expect(a.notebook.getCell(1).getSource()).toBe('from b');
    wire.dispose();
    a.dispose();
    b.dispose();
  });

  it('a concurrent delete of the same cell on both peers converges without a double event', () => {
    const a = reviewPeer(11, reviewBook([reviewCode('c1', 'x'), reviewCode('c2', 'y')]));
    const b = reviewPeer(22);
    const wire = new Wire(a.notebook.ydoc, b.notebook.ydoc);
    const cursorA = a.model.changesCursor;
    const revA = a.model.summary().cells[0]!.cellRevision;
    const revB = b.model.summary().cells[0]!.cellRevision;
    a.model.apply([{ op: 'delete_cell', cellId: 'c1', expectedCellRevision: revA }]);
    b.model.apply([{ op: 'delete_cell', cellId: 'c1', expectedCellRevision: revB }]);
    wire.deliver();
    expect(a.model.summary().cells.map((cell) => cell.cellId)).toEqual(['c2']);
    expect(b.model.summary().cells.map((cell) => cell.cellId)).toEqual(['c2']);
    const deletions = a.model
      .changesSince(cursorA)
      .events.filter((event) => event.kind === 'cell_deleted');
    expect(deletions).toHaveLength(1);
    wire.dispose();
    a.dispose();
    b.dispose();
  });

  it('a browser edit racing our replace_source merges instead of clobbering the Y.Text', () => {
    const a = reviewPeer(11, reviewBook([reviewCode('c1', 'header\nbody\nfooter')]));
    const b = reviewPeer(22);
    const wire = new Wire(a.notebook.ydoc, b.notebook.ydoc);
    const rev = a.model.summary().cells[0]!.sourceRevision;
    // The browser appends a line while we rewrite the middle line only.
    typeInto(b.notebook, 0, 'header\nbody\nfooter\nuser');
    a.model.apply([
      {
        op: 'replace_source',
        cellId: 'c1',
        expectedSourceRevision: rev,
        source: 'header\nBODY\nfooter'
      }
    ]);
    wire.deliver();
    expect(a.notebook.getCell(0).getSource()).toBe(b.notebook.getCell(0).getSource());
    // A minimal edit keeps the user's appended line; a delete-all/reinsert
    // would have dropped it.
    expect(a.notebook.getCell(0).getSource()).toContain('user');
    expect(a.notebook.getCell(0).getSource()).toContain('BODY');
    wire.dispose();
    a.dispose();
    b.dispose();
  });
});
