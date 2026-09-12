import { afterEach, describe, expect, it } from 'vitest';

import { makePeer } from './helpers.js';
import type { Peer } from './helpers.js';

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
});

/**
 * A deliberately rich notebook: unknown metadata keys at both levels, a raw
 * cell, a markdown cell with attachments, and outputs with per-output metadata
 * and several MIME types. SPEC.md §12 "Document data" requires read/edit not
 * to lose any of it.
 */
function richNotebook(): Record<string, unknown> {
  return {
    nbformat: 4,
    nbformat_minor: 5,
    metadata: {
      kernelspec: { display_name: 'Python 3', language: 'python', name: 'python3' },
      language_info: { name: 'python', version: '3.12.0' },
      vendor_unknown: { deep: { list: [1, 2, { k: 'v' }] } }
    },
    cells: [
      {
        id: 'raw1',
        cell_type: 'raw',
        source: 'raw body\nsecond line',
        metadata: { format: 'text/latex', vendorZ: [1, 2] }
      },
      {
        id: 'md1',
        cell_type: 'markdown',
        source: '![i](attachment:x.png)\n\ntext',
        metadata: { unknown_md: { a: 1 } },
        attachments: { 'x.png': { 'image/png': 'iVBORw0KGgo=' } }
      },
      {
        id: 'plot',
        cell_type: 'code',
        source: 'plot()',
        execution_count: 12,
        metadata: {
          unknown_code: { x: [true, null] },
          execution: { 'iopub.execute_input': '2026-09-06T10:00:00Z' }
        },
        outputs: [
          { output_type: 'stream', name: 'stdout', text: 'line a\nline b\n' },
          {
            output_type: 'execute_result',
            data: { 'text/plain': '42', 'application/json': { a: 1 } },
            metadata: { foo: 'bar' },
            execution_count: 12
          },
          {
            output_type: 'display_data',
            data: { 'image/png': 'AAAA', 'text/html': '<b>x</b>' },
            metadata: { 'image/png': { width: 10, height: 20 } }
          },
          {
            output_type: 'error',
            ename: 'ValueError',
            evalue: 'boom',
            traceback: ['Traceback', '  line', 'ValueError: boom']
          }
        ]
      },
      {
        id: 'target',
        cell_type: 'code',
        source: 'x = 1',
        execution_count: null,
        metadata: {},
        outputs: []
      }
    ]
  };
}

function loaded(): { peer: Peer; baseline: Record<string, unknown> } {
  const peer = makePeer(richNotebook());
  cleanups.push(() => peer.dispose());
  return { peer, baseline: peer.notebook.toJSON() as unknown as Record<string, unknown> };
}

function cellsOf(json: Record<string, unknown>): Record<string, unknown>[] {
  return json['cells'] as Record<string, unknown>[];
}

describe('document data survives read/edit (SPEC.md §12 "Document data")', () => {
  it('the load itself keeps unknown metadata, attachments and output metadata', () => {
    const { baseline } = loaded();
    const cells = cellsOf(baseline);
    expect(baseline['metadata']).toEqual(richNotebook()['metadata']);
    expect(cells[0]).toEqual(cellsOf(richNotebook())[0]);
    expect(cells[1]).toEqual(cellsOf(richNotebook())[1]);
    // `@jupyter/ydoc` reorders `execution_count` to the end of a code cell; the
    // content is unchanged.
    expect(cells[2]).toEqual(cellsOf(richNotebook())[2]);
  });

  it('edits to one cell leave every other cell byte-identical', () => {
    const { peer, baseline } = loaded();
    const before = cellsOf(baseline);

    peer.model.apply([
      {
        op: 'replace_source',
        cellId: 'target',
        expectedSourceRevision: peer.model.summary().cells[3]!.sourceRevision,
        source: 'x = 2'
      },
      { op: 'add_cell', cellType: 'code', source: 'appended', position: 'end' },
      {
        op: 'set_cell_metadata',
        cellId: 'target',
        expectedCellRevision: peer.model.summary().cells[3]!.cellRevision,
        key: 'tags',
        value: ['edited']
      },
      {
        op: 'set_notebook_metadata',
        expectedNotebookMetadataRevision: peer.model.summary().notebookMetadataRevision,
        key: 'authors',
        value: [{ name: 'agent' }]
      }
    ]);

    const after = cellsOf(peer.notebook.toJSON() as unknown as Record<string, unknown>);
    for (const index of [0, 1, 2]) {
      expect(JSON.stringify(after[index])).toBe(JSON.stringify(before[index]));
    }
    // The edited cell changed exactly where it was told to.
    expect(after[3]).toMatchObject({ source: 'x = 2', metadata: { tags: ['edited'] } });
    expect(after).toHaveLength(5);

    const metadata = (peer.notebook.toJSON() as unknown as Record<string, unknown>)['metadata'];
    expect(metadata).toMatchObject({
      vendor_unknown: { deep: { list: [1, 2, { k: 'v' }] } },
      kernelspec: { name: 'python3' },
      authors: [{ name: 'agent' }]
    });
  });

  it('a full source replacement keeps the cell object, its outputs and metadata', () => {
    const { peer, baseline } = loaded();
    const before = cellsOf(baseline)[2]!;
    const ref = peer.model.cellRef('plot');

    peer.model.apply([
      {
        op: 'replace_source',
        cellId: 'plot',
        expectedSourceRevision: peer.model.summary().cells[2]!.sourceRevision,
        source: 'plot(figsize=(8, 6))'
      }
    ]);

    const after = cellsOf(peer.notebook.toJSON() as unknown as Record<string, unknown>)[2]!;
    expect(after['source']).toBe('plot(figsize=(8, 6))');
    expect(JSON.stringify(after['outputs'])).toBe(JSON.stringify(before['outputs']));
    expect(JSON.stringify(after['metadata'])).toBe(JSON.stringify(before['metadata']));
    expect(after['execution_count']).toBe(12);
    // The CRDT object survived: the reference is still valid (SPEC.md §7).
    expect(peer.model.resolveRef(ref).identityToken).toBe(ref.identityToken);
  });

  it('reading everything does not modify the document', () => {
    const { peer, baseline } = loaded();
    peer.model.summary();
    peer.model.readCells();
    peer.model.readOutputs(['plot', 'target']);
    peer.model.snapshotWithCursor();
    expect(JSON.stringify(peer.notebook.toJSON())).toBe(JSON.stringify(baseline));
  });

  it('deleting one cell leaves the others byte-identical', () => {
    const { peer, baseline } = loaded();
    const before = cellsOf(baseline);
    peer.model.apply([
      {
        op: 'delete_cell',
        cellId: 'md1',
        expectedCellRevision: peer.model.summary().cells[1]!.cellRevision
      }
    ]);
    const after = cellsOf(peer.notebook.toJSON() as unknown as Record<string, unknown>);
    expect(after.map((cell) => cell['id'])).toEqual(['raw1', 'plot', 'target']);
    expect(JSON.stringify(after[0])).toBe(JSON.stringify(before[0]));
    expect(JSON.stringify(after[1])).toBe(JSON.stringify(before[2]));
    expect(JSON.stringify(after[2])).toBe(JSON.stringify(before[3]));
  });

  it('clearing one output area does not touch the neighbour cells', () => {
    const { peer, baseline } = loaded();
    const before = cellsOf(baseline);
    peer.model.apply([
      {
        op: 'clear_outputs',
        cellId: 'plot',
        expectedOutputsRevision: peer.model.summary().cells[2]!.outputsRevision!
      }
    ]);
    const after = cellsOf(peer.notebook.toJSON() as unknown as Record<string, unknown>);
    expect(after[2]!['outputs']).toEqual([]);
    expect(JSON.stringify(after[2]!['metadata'])).toBe(JSON.stringify(before[2]!['metadata']));
    expect(JSON.stringify(after[0])).toBe(JSON.stringify(before[0]));
    expect(JSON.stringify(after[1])).toBe(JSON.stringify(before[1]));
    expect(JSON.stringify(after[3])).toBe(JSON.stringify(before[3]));
  });
});
