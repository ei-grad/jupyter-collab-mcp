import { afterEach, describe, expect, it } from 'vitest';

import { isCoreError } from '../../../src/core/index.js';
import { codeCell, makeLinkedPeers, notebookWith } from './helpers.js';

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
});

function codeOf(error: unknown): string {
  expect(isCoreError(error)).toBe(true);
  return (error as { code: string }).code;
}

describe('concurrent edits (SPEC.md §7, §12 "Concurrent edits")', () => {
  it('two concurrent edits of one cell converge on both replicas', () => {
    const linked = makeLinkedPeers(
      notebookWith([codeCell('a', 'def f():\n    pass\n\ndef g():\n    pass\n')])
    );
    cleanups.push(() => linked.dispose());
    linked.bridge.setAuto(false);

    const revA = linked.a.model.summary().cells[0]!.sourceRevision;
    const revB = linked.b.model.summary().cells[0]!.sourceRevision;
    expect(revA).toBe(revB);

    // Both sides edit a different function body without seeing each other.
    linked.a.model.apply([
      {
        op: 'replace_text',
        cellId: 'a',
        expectedSourceRevision: revA,
        oldText: 'def f():\n    pass',
        newText: 'def f():\n    return 1'
      }
    ]);
    linked.b.model.apply([
      {
        op: 'replace_text',
        cellId: 'a',
        expectedSourceRevision: revB,
        oldText: 'def g():\n    pass',
        newText: 'def g():\n    return 2'
      }
    ]);
    expect(linked.a.notebook.getCell(0).getSource()).not.toBe(
      linked.b.notebook.getCell(0).getSource()
    );

    linked.bridge.flush();

    const merged = linked.a.notebook.getCell(0).getSource();
    expect(linked.b.notebook.getCell(0).getSource()).toBe(merged);
    expect(merged).toContain('return 1');
    expect(merged).toContain('return 2');
    // Both replicas agree on the revision after convergence.
    expect(linked.a.model.summary().cells[0]!.sourceRevision).toBe(
      linked.b.model.summary().cells[0]!.sourceRevision
    );
  });

  it('a known stale revision changes nothing (no distributed CAS is claimed)', () => {
    const linked = makeLinkedPeers(notebookWith([codeCell('a', 'original')]));
    cleanups.push(() => linked.dispose());
    const stale = linked.a.model.summary().cells[0]!.sourceRevision;

    linked.b.model.apply([
      { op: 'replace_source', cellId: 'a', expectedSourceRevision: stale, source: 'from b' }
    ]);
    // A now sees B's edit, so its own remembered revision is stale.
    expect(linked.a.notebook.getCell(0).getSource()).toBe('from b');
    try {
      linked.a.model.apply([
        { op: 'replace_source', cellId: 'a', expectedSourceRevision: stale, source: 'from a' }
      ]);
      expect.unreachable();
    } catch (error) {
      expect(codeOf(error)).toBe('REVISION_CONFLICT');
    }
    expect(linked.a.notebook.getCell(0).getSource()).toBe('from b');
    expect(linked.b.notebook.getCell(0).getSource()).toBe('from b');
  });

  it('a concurrent insert and edit both survive and the order converges', () => {
    const linked = makeLinkedPeers(notebookWith([codeCell('a', 'one'), codeCell('b', 'two')]));
    cleanups.push(() => linked.dispose());
    linked.bridge.setAuto(false);

    linked.a.model.apply([
      { op: 'add_cell', cellType: 'code', source: 'from a', afterCellId: 'a' }
    ]);
    linked.b.model.apply([
      {
        op: 'replace_source',
        cellId: 'b',
        expectedSourceRevision: linked.b.model.summary().cells[1]!.sourceRevision,
        source: 'two edited'
      }
    ]);
    linked.bridge.flush();

    const idsA = linked.a.model.summary().cells.map((cell) => cell.cellId);
    const idsB = linked.b.model.summary().cells.map((cell) => cell.cellId);
    expect(idsA).toEqual(idsB);
    expect(idsA).toHaveLength(3);
    expect(linked.a.model.structureRevision).toBe(linked.b.model.structureRevision);
    expect(linked.a.notebook.getCell(2).getSource()).toBe('two edited');
  });

  it('a delete that races an edit converges on the deletion', () => {
    const linked = makeLinkedPeers(notebookWith([codeCell('a', 'one'), codeCell('b', 'two')]));
    cleanups.push(() => linked.dispose());
    linked.bridge.setAuto(false);

    linked.a.model.apply([
      {
        op: 'delete_cell',
        cellId: 'b',
        expectedCellRevision: linked.a.model.summary().cells[1]!.cellRevision
      }
    ]);
    linked.b.model.apply([
      {
        op: 'replace_source',
        cellId: 'b',
        expectedSourceRevision: linked.b.model.summary().cells[1]!.sourceRevision,
        source: 'edited while being deleted'
      }
    ]);
    linked.bridge.flush();

    expect(linked.a.model.summary().cells.map((cell) => cell.cellId)).toEqual(['a']);
    expect(linked.b.model.summary().cells.map((cell) => cell.cellId)).toEqual(['a']);
    try {
      linked.b.model.cellRef('b');
      expect.unreachable();
    } catch (error) {
      expect(codeOf(error)).toBe('CELL_NOT_FOUND');
    }
  });

  it('the peer sees add, edit, delete, metadata and outputs without a reload', () => {
    const linked = makeLinkedPeers(notebookWith([codeCell('a', 'one')]), {
      outputsCoalesceMs: 0
    });
    cleanups.push(() => linked.dispose());
    const cursor = linked.b.model.changesCursor;

    const added = linked.a.model.apply([
      { op: 'add_cell', cellType: 'markdown', source: '# doc', position: 'end' }
    ]);
    const newId = added.results[0]!.cellId!;
    linked.a.model.apply([
      {
        op: 'set_cell_metadata',
        cellId: 'a',
        expectedCellRevision: linked.a.model.summary().cells[0]!.cellRevision,
        key: 'tags',
        value: ['x']
      }
    ]);
    const sink = linked.a.model.beginExecutionGeneration('a')!;
    sink.appendOutput({ output_type: 'stream', name: 'stdout', text: 'hi' });
    linked.a.model.finishExecution(sink, { count: 1 });
    linked.a.model.apply([
      {
        op: 'delete_cell',
        cellId: newId,
        expectedCellRevision: linked.a.model.summary().cells[1]!.cellRevision
      }
    ]);

    const kinds = new Set(linked.b.model.changesSince(cursor).events.map((event) => event.kind));
    expect(kinds).toContain('cell_added');
    expect(kinds).toContain('metadata_changed');
    expect(kinds).toContain('outputs_changed');
    expect(kinds).toContain('cell_deleted');
    expect(linked.b.model.summary().cells[0]!.executionCount).toBe(1);
    expect(linked.b.model.readOutputs(['a']).cells[0]!.outputs).toHaveLength(1);
  });

  it('a remote notebook metadata change is journalled', () => {
    const linked = makeLinkedPeers(notebookWith([codeCell('a', 'one')], { kernelspec: {} }));
    cleanups.push(() => linked.dispose());
    const cursor = linked.a.model.changesCursor;
    linked.b.model.apply([
      {
        op: 'set_notebook_metadata',
        expectedNotebookMetadataRevision: linked.b.model.summary().notebookMetadataRevision,
        key: 'title',
        value: 'from the browser'
      }
    ]);
    const events = linked.a.model.changesSince(cursor).events;
    expect(events.map((event) => event.kind)).toContain('notebook_metadata_changed');
    expect(events[0]!.origin).toBe('remote');
    expect(events[0]!.revisions.notebookMetadataRevision).toBe(
      linked.a.model.summary().notebookMetadataRevision
    );
  });
});
