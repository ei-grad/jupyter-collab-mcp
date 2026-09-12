import { afterEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';

import { isCoreError } from '../../../src/core/index.js';
import type { ModelOperation } from '../../../src/core/notebook/index.js';
import { codeCell, makePeer, markdownCell, notebookWith } from './helpers.js';
import type { Peer } from './helpers.js';

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
});

function peerWith(cells: readonly Record<string, unknown>[], metadata = {}): Peer {
  const peer = makePeer(notebookWith(cells, metadata));
  cleanups.push(() => peer.dispose());
  return peer;
}

function codeOf(error: unknown): string {
  expect(isCoreError(error)).toBe(true);
  return (error as { code: string }).code;
}

function expectThrows(fn: () => unknown, code: string): void {
  try {
    fn();
    expect.unreachable(`expected ${code}`);
  } catch (error) {
    expect(codeOf(error)).toBe(code);
  }
}

describe('apply: add_cell (SPEC.md §7)', () => {
  it('inserts before, after and at the end and returns the new id', () => {
    const peer = peerWith([codeCell('a', 'one'), codeCell('b', 'two')]);
    const result = peer.model.apply([
      { op: 'add_cell', cellType: 'markdown', source: '# head', beforeCellId: 'a' },
      { op: 'add_cell', cellType: 'code', source: 'mid', afterCellId: 'a' },
      { op: 'add_cell', cellType: 'raw', source: 'tail', position: 'end' }
    ]);
    expect(result.results).toHaveLength(3);
    const ids = result.results.map((entry) => entry.cellId!);
    expect(peer.model.summary().cells.map((cell) => cell.cellId)).toEqual([
      ids[0],
      'a',
      ids[1],
      'b',
      ids[2]
    ]);
    expect(peer.model.summary().cells.map((cell) => cell.cellType)).toEqual([
      'markdown',
      'code',
      'code',
      'code',
      'raw'
    ]);
    expect(result.appliedLocally).toBe(true);
    expect(result.partial).toBeUndefined();
  });

  it('requires exactly one anchor', () => {
    const peer = peerWith([codeCell('a', 'one')]);
    expectThrows(
      () =>
        peer.model.apply([
          {
            op: 'add_cell',
            cellType: 'code',
            source: '',
            beforeCellId: 'a',
            afterCellId: 'a'
          } as unknown as ModelOperation
        ]),
      'INVALID_ARGUMENT'
    );
    expectThrows(
      () =>
        peer.model.apply([
          { op: 'add_cell', cellType: 'code', source: '' } as unknown as ModelOperation
        ]),
      'INVALID_ARGUMENT'
    );
    expect(peer.model.summary().cellCount).toBe(1);
  });

  it('a vanished anchor is CELL_NOT_FOUND with no insert', () => {
    const peer = peerWith([codeCell('a', 'one')]);
    expectThrows(
      () => peer.model.apply([{ op: 'add_cell', cellType: 'code', source: '', afterCellId: 'gone' }]),
      'CELL_NOT_FOUND'
    );
    expect(peer.model.summary().cellCount).toBe(1);
  });

  it('a duplicated anchor is CELL_ID_AMBIGUOUS and rejects the whole batch', () => {
    const peer = peerWith([codeCell('dup', 'one'), codeCell('ok', 'two'), codeCell('dup', 'three')]);
    expectThrows(
      () =>
        peer.model.apply([
          { op: 'add_cell', cellType: 'code', source: 'first', afterCellId: 'ok' },
          { op: 'add_cell', cellType: 'code', source: 'second', afterCellId: 'dup' }
        ]),
      'CELL_ID_AMBIGUOUS'
    );
    expect(peer.model.summary().cellCount).toBe(3);
  });

  it('an anchor added earlier in the same batch is usable', () => {
    const peer = peerWith([codeCell('a', 'one')]);
    const first = peer.model.apply([
      { op: 'add_cell', cellType: 'code', source: 'x', position: 'end' }
    ]);
    const newId = first.results[0]!.cellId!;
    peer.model.apply([{ op: 'add_cell', cellType: 'code', source: 'y', beforeCellId: newId }]);
    expect(peer.model.summary().cells.map((cell) => cell.cellType)).toHaveLength(3);
  });
});

describe('apply: replace_source and replace_text (SPEC.md §7)', () => {
  it('a stale revision changes nothing and reports the current one', () => {
    const peer = peerWith([codeCell('a', 'print(1)')]);
    const stale = peer.model.summary().cells[0]!.sourceRevision;
    peer.notebook.getCell(0).setSource('print(2)');
    try {
      peer.model.apply([
        { op: 'replace_source', cellId: 'a', expectedSourceRevision: stale, source: 'print(3)' }
      ]);
      expect.unreachable();
    } catch (error) {
      expect(codeOf(error)).toBe('REVISION_CONFLICT');
      const details = (error as { details?: Record<string, unknown> }).details ?? {};
      expect(details['current']).toBe(peer.model.summary().cells[0]!.sourceRevision);
    }
    expect(peer.notebook.getCell(0).getSource()).toBe('print(2)');
  });

  it('rejects a revision of the wrong kind before touching anything', () => {
    const peer = peerWith([codeCell('a', 'x')]);
    const cellRev = peer.model.summary().cells[0]!.cellRevision;
    expectThrows(
      () =>
        peer.model.apply([
          {
            op: 'replace_source',
            cellId: 'a',
            expectedSourceRevision: cellRev as unknown as never,
            source: 'y'
          }
        ]),
      'INVALID_ARGUMENT'
    );
  });

  it('replaces the whole source as a minimal Y.Text edit, not a full rewrite', () => {
    const before = 'line one\nline two\nline three\n';
    const peer = peerWith([codeCell('a', before)]);
    const ysource = peer.notebook.getCell(0).ysource;
    const deltas: unknown[][] = [];
    const observer = (event: Y.YTextEvent): void => {
      deltas.push(event.changes.delta as unknown[]);
    };
    ysource.observe(observer);

    peer.model.apply([
      {
        op: 'replace_source',
        cellId: 'a',
        expectedSourceRevision: peer.model.summary().cells[0]!.sourceRevision,
        source: 'line one\nline TWO\nline three\n'
      }
    ]);
    ysource.unobserve(observer);

    expect(peer.notebook.getCell(0).getSource()).toBe('line one\nline TWO\nline three\n');
    expect(deltas).toHaveLength(1);
    const deleted = (deltas[0] as { delete?: number }[]).reduce(
      (sum, part) => sum + (part.delete ?? 0),
      0
    );
    const inserted = (deltas[0] as { insert?: string }[]).reduce(
      (sum, part) => sum + (part.insert?.length ?? 0),
      0
    );
    // "two" -> "TWO": three characters out, three in. A delete+reinsert of the
    // whole cell would be 28 (SPEC.md §7).
    expect(deleted).toBe(3);
    expect(inserted).toBe(3);
    expect(deleted).toBeLessThan(before.length);
  });

  it('an idempotent replace_source produces no update at all', () => {
    const peer = peerWith([codeCell('a', 'same')]);
    let updates = 0;
    const onUpdate = (): void => {
      updates++;
    };
    peer.notebook.ydoc.on('update', onUpdate);
    peer.model.apply([
      {
        op: 'replace_source',
        cellId: 'a',
        expectedSourceRevision: peer.model.summary().cells[0]!.sourceRevision,
        source: 'same'
      }
    ]);
    peer.notebook.ydoc.off('update', onUpdate);
    expect(updates).toBe(0);
  });

  it('replace_text requires exactly one occurrence', () => {
    const peer = peerWith([codeCell('a', 'df.head()\ndf.head()')]);
    const rev = peer.model.summary().cells[0]!.sourceRevision;
    expectThrows(
      () =>
        peer.model.apply([
          {
            op: 'replace_text',
            cellId: 'a',
            expectedSourceRevision: rev,
            oldText: 'df.head()',
            newText: 'df.head(20)'
          }
        ]),
      'MATCH_NOT_UNIQUE'
    );
    expectThrows(
      () =>
        peer.model.apply([
          {
            op: 'replace_text',
            cellId: 'a',
            expectedSourceRevision: rev,
            oldText: 'nope',
            newText: 'x'
          }
        ]),
      'MATCH_NOT_FOUND'
    );
    expect(peer.notebook.getCell(0).getSource()).toBe('df.head()\ndf.head()');
  });

  it('replace_text applies the single occurrence', () => {
    const peer = peerWith([codeCell('a', 'x = 1\ndf.head()\n')]);
    const result = peer.model.apply([
      {
        op: 'replace_text',
        cellId: 'a',
        expectedSourceRevision: peer.model.summary().cells[0]!.sourceRevision,
        oldText: 'df.head()',
        newText: 'df.head(20)'
      }
    ]);
    expect(peer.notebook.getCell(0).getSource()).toBe('x = 1\ndf.head(20)\n');
    expect(result.results[0]!.sourceRevision).toBe(peer.model.summary().cells[0]!.sourceRevision);
  });
});

describe('apply: delete_cell and clear_outputs (SPEC.md §7)', () => {
  it('delete_cell is guarded by the full cell revision', () => {
    const peer = peerWith([codeCell('a', 'one'), codeCell('b', 'two')]);
    const stale = peer.model.summary().cells[1]!.cellRevision;
    peer.notebook.getCell(1).setSource('two changed');
    expectThrows(
      () => peer.model.apply([{ op: 'delete_cell', cellId: 'b', expectedCellRevision: stale }]),
      'REVISION_CONFLICT'
    );
    expect(peer.model.summary().cellCount).toBe(2);

    peer.model.apply([
      {
        op: 'delete_cell',
        cellId: 'b',
        expectedCellRevision: peer.model.summary().cells[1]!.cellRevision
      }
    ]);
    expect(peer.model.summary().cells.map((cell) => cell.cellId)).toEqual(['a']);
  });

  it('clear_outputs is guarded and rejects a cell with no output area', () => {
    const peer = peerWith([
      codeCell('a', 'x', {
        outputs: [{ output_type: 'stream', name: 'stdout', text: 'hi' }],
        execution_count: 3
      }),
      markdownCell('m', '# title')
    ]);
    const outputsRev = peer.model.summary().cells[0]!.outputsRevision!;
    expectThrows(
      () =>
        peer.model.apply([
          {
            op: 'clear_outputs',
            cellId: 'm',
            expectedOutputsRevision: outputsRev
          }
        ]),
      'INVALID_ARGUMENT'
    );
    peer.model.apply([
      { op: 'clear_outputs', cellId: 'a', expectedOutputsRevision: outputsRev }
    ]);
    expect(peer.model.readOutputs(['a']).cells[0]!.outputs).toHaveLength(0);
    // clear_outputs does not touch execution_count (SPEC.md §7/§8).
    expect(peer.model.summary().cells[0]!.executionCount).toBe(3);
  });
});

describe('apply: metadata operations (SPEC.md §7, §12 "Tool coverage")', () => {
  it('sets and deletes one cell key and keeps the others', () => {
    const peer = peerWith([
      codeCell('a', 'x', { metadata: { tags: ['keep'], vendor: { unknown: 1 } } })
    ]);
    const rev = () => peer.model.summary().cells[0]!.cellRevision;
    peer.model.apply([
      { op: 'set_cell_metadata', cellId: 'a', expectedCellRevision: rev(), key: 'scrolled', value: true }
    ]);
    let metadata = peer.model.readCells({ cellIds: ['a'] }).cells[0]!.metadata;
    expect(metadata).toEqual({ tags: ['keep'], vendor: { unknown: 1 }, scrolled: true });

    peer.model.apply([
      { op: 'delete_cell_metadata', cellId: 'a', expectedCellRevision: rev(), key: 'scrolled' }
    ]);
    metadata = peer.model.readCells({ cellIds: ['a'] }).cells[0]!.metadata;
    expect(metadata).toEqual({ tags: ['keep'], vendor: { unknown: 1 } });
  });

  it('addresses a nested key by path without dropping its siblings', () => {
    const peer = peerWith([
      codeCell('a', 'x', { metadata: { vendor: { keep: 1, drop: 2 } } })
    ]);
    const rev = () => peer.model.summary().cells[0]!.cellRevision;
    peer.model.apply([
      {
        op: 'set_cell_metadata',
        cellId: 'a',
        expectedCellRevision: rev(),
        key: ['vendor', 'added'],
        value: 'yes'
      }
    ]);
    expect(peer.model.readCells({ cellIds: ['a'] }).cells[0]!.metadata).toEqual({
      vendor: { keep: 1, drop: 2, added: 'yes' }
    });
    peer.model.apply([
      {
        op: 'delete_cell_metadata',
        cellId: 'a',
        expectedCellRevision: rev(),
        key: ['vendor', 'drop']
      }
    ]);
    expect(peer.model.readCells({ cellIds: ['a'] }).cells[0]!.metadata).toEqual({
      vendor: { keep: 1, added: 'yes' }
    });
  });

  it('guards notebook metadata and keeps unrelated keys', () => {
    const peer = peerWith([codeCell('a', 'x')], {
      kernelspec: { name: 'python3' },
      language_info: { name: 'python' }
    });
    const stale = peer.model.summary().notebookMetadataRevision;
    peer.notebook.setMetadata('touched_elsewhere', true);
    expectThrows(
      () =>
        peer.model.apply([
          {
            op: 'set_notebook_metadata',
            expectedNotebookMetadataRevision: stale,
            key: 'authors',
            value: [{ name: 'agent' }]
          }
        ]),
      'REVISION_CONFLICT'
    );

    const result = peer.model.apply([
      {
        op: 'set_notebook_metadata',
        expectedNotebookMetadataRevision: peer.model.summary().notebookMetadataRevision,
        key: 'authors',
        value: [{ name: 'agent' }]
      }
    ]);
    expect(result.results[0]!.notebookMetadataRevision).toBe(
      peer.model.summary().notebookMetadataRevision
    );
    expect(peer.notebook.getMetadata()).toMatchObject({
      kernelspec: { name: 'python3' },
      language_info: { name: 'python' },
      touched_elsewhere: true,
      authors: [{ name: 'agent' }]
    });

    peer.model.apply([
      {
        op: 'delete_notebook_metadata',
        expectedNotebookMetadataRevision: peer.model.summary().notebookMetadataRevision,
        key: 'authors'
      }
    ]);
    expect(peer.notebook.getMetadata()['authors']).toBeUndefined();
    expect(peer.notebook.getMetadata()['kernelspec']).toEqual({ name: 'python3' });
  });
});

describe('apply: batch semantics (SPEC.md §7)', () => {
  it('validates the whole batch before the first mutation', () => {
    const peer = peerWith([codeCell('a', 'one'), codeCell('b', 'two')]);
    const rev = peer.model.summary().cells[0]!.sourceRevision;
    expectThrows(
      () =>
        peer.model.apply([
          { op: 'replace_source', cellId: 'a', expectedSourceRevision: rev, source: 'changed' },
          { op: 'delete_cell', cellId: 'missing', expectedCellRevision: 'c1_x' as never }
        ]),
      'INVALID_ARGUMENT'
    );
    expect(peer.notebook.getCell(0).getSource()).toBe('one');
    expect(peer.model.summary().cellCount).toBe(2);
  });

  it('applies the whole batch in a single Yjs transaction', () => {
    const peer = peerWith([codeCell('a', 'one')]);
    let transactions = 0;
    let updates = 0;
    const onAfter = (transaction: Y.Transaction): void => {
      // `@jupyter/ydoc` opens its own empty transactions while it computes a
      // Y.Text delta for its observers; only ours carry this model's origin.
      if (transaction.origin === peer.origin) transactions++;
    };
    const onUpdate = (): void => {
      updates++;
    };
    peer.notebook.ydoc.on('update', onUpdate);
    peer.notebook.ydoc.on('afterTransaction', onAfter);
    peer.model.apply([
      { op: 'add_cell', cellType: 'code', source: 'x', position: 'end' },
      { op: 'add_cell', cellType: 'code', source: 'y', position: 'end' },
      {
        op: 'replace_source',
        cellId: 'a',
        expectedSourceRevision: peer.model.summary().cells[0]!.sourceRevision,
        source: 'one edited'
      }
    ]);
    peer.notebook.ydoc.off('afterTransaction', onAfter);
    peer.notebook.ydoc.off('update', onUpdate);
    expect(transactions).toBe(1);
    expect(updates).toBe(1);
    expect(peer.model.summary().cellCount).toBe(3);
  });

  it('marks the local writes as local in the journal (SPEC.md §10)', () => {
    const peer = peerWith([codeCell('a', 'one')]);
    const before = peer.model.changesCursor;
    peer.model.apply([{ op: 'add_cell', cellType: 'code', source: 'x', position: 'end' }]);
    const events = peer.model.changesSince(before).events;
    expect(events).not.toHaveLength(0);
    expect(events.every((event) => event.origin === 'local')).toBe(true);
  });

  it('lets one batch touch the same cell twice with the pre-batch revisions', () => {
    const peer = peerWith([codeCell('a', 'one')]);
    const sourceRev = peer.model.summary().cells[0]!.sourceRevision;
    const cellRev = peer.model.summary().cells[0]!.cellRevision;
    peer.model.apply([
      { op: 'replace_source', cellId: 'a', expectedSourceRevision: sourceRev, source: 'one edited' },
      { op: 'set_cell_metadata', cellId: 'a', expectedCellRevision: cellRev, key: 'tags', value: ['t'] }
    ]);
    const read = peer.model.readCells({ cellIds: ['a'] }).cells[0]!;
    expect(read.source).toBe('one edited');
    expect(read.metadata).toEqual({ tags: ['t'] });
  });

  it('a genuinely stale revision is still refused inside a multi-op batch', () => {
    const peer = peerWith([codeCell('a', 'one')]);
    const stale = peer.model.summary().cells[0]!.sourceRevision;
    peer.notebook.getCell(0).setSource('changed remotely');
    expectThrows(
      () =>
        peer.model.apply([
          { op: 'add_cell', cellType: 'code', source: 'x', position: 'end' },
          { op: 'replace_source', cellId: 'a', expectedSourceRevision: stale, source: 'mine' }
        ]),
      'REVISION_CONFLICT'
    );
    expect(peer.model.summary().cellCount).toBe(1);
  });

  it('reports a partial batch when a write fails after the first mutation', () => {
    const peer = peerWith([codeCell('a', 'one')]);
    const result = peer.model.apply([
      { op: 'add_cell', cellType: 'code', source: 'added', position: 'end' },
      {
        op: 'set_cell_metadata',
        cellId: 'a',
        expectedCellRevision: peer.model.summary().cells[0]!.cellRevision,
        key: 'bad',
        // A value Yjs cannot store: the planner cannot know, so the failure
        // happens mid-transaction (SPEC.md §7).
        value: (): number => 1
      }
    ]);
    expect(result.partial).toBe(true);
    expect(result.partialAtOperation).toBe(1);
    expect(result.partialError?.code).toBe('INTERNAL_ERROR');
    expect(result.appliedLocally).toBe(false);
    // The operations before the failure are applied and reported.
    expect(result.results).toHaveLength(1);
    expect(peer.model.summary().cellCount).toBe(2);
  });

  it('a released model refuses further work with HANDLE_EXPIRED', () => {
    const peer = peerWith([codeCell('a', 'one')]);
    peer.model.dispose();
    expectThrows(() => peer.model.summary(), 'HANDLE_EXPIRED');
    expectThrows(
      () => peer.model.apply([{ op: 'add_cell', cellType: 'code', source: 'x', position: 'end' }]),
      'HANDLE_EXPIRED'
    );
    expect(peer.model.isDisposed()).toBe(true);
    // Disposing twice is safe and stops observing.
    peer.model.dispose();
    peer.notebook.getCell(0).setSource('after dispose');
    expect(peer.notebook.getCell(0).getSource()).toBe('after dispose');
  });
});
