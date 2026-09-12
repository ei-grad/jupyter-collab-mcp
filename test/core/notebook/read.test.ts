import { afterEach, describe, expect, it } from 'vitest';

import { isCoreError } from '../../../src/core/index.js';
import { withIdentity } from '../../../src/core/notebook/index.js';
import { codeCell, makePeer, markdownCell, notebookWith } from './helpers.js';

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
});

function codeOf(error: unknown): string {
  expect(isCoreError(error)).toBe(true);
  return (error as { code: string }).code;
}

const bigPng = 'A'.repeat(200_000);

describe('summary (SPEC.md §7, §9)', () => {
  it('carries revisions, a one-line preview and the execution state', () => {
    const peer = makePeer(
      notebookWith([
        codeCell('a', 'import pandas as pd\ndf = pd.read_csv("x")\n', {
          outputs: [{ output_type: 'stream', name: 'stdout', text: 'ok' }],
          execution_count: 4
        }),
        markdownCell('m', '# heading\n\ntext')
      ])
    );
    cleanups.push(() => peer.dispose());
    const summary = peer.model.summary();
    expect(summary.cellCount).toBe(2);
    expect(summary.nbformat).toBe(4);
    expect(summary.nbformatMinor).toBe(5);
    expect(summary.cells[0]!.preview).toBe('import pandas as pd df = pd.read_csv("x")');
    expect(summary.cells[0]!.preview).not.toContain('\n');
    expect(summary.cells[0]!.sourceRevision.startsWith('s1_')).toBe(true);
    expect(summary.cells[0]!.cellRevision.startsWith('c1_')).toBe(true);
    expect(summary.cells[0]!.outputsRevision!.startsWith('o1_')).toBe(true);
    expect(summary.cells[0]!.executionCount).toBe(4);
    expect(summary.cells[0]!.executionState).toBe('idle');
    // Markdown has no output area (SPEC.md §7).
    expect(summary.cells[1]!.outputsRevision).toBeNull();
    expect(summary.cells[1]!.executionCount).toBeNull();
    expect(summary.structureRevision.startsWith('x1_')).toBe(true);
    expect(summary.notebookMetadataRevision.startsWith('m1_')).toBe(true);
    expect(summary.changesCursor.startsWith('chg_')).toBe(true);
  });

  it('an outputs change does not move source_revision, and the reverse', () => {
    const peer = makePeer(notebookWith([codeCell('a', 'print(1)')]));
    cleanups.push(() => peer.dispose());
    const before = peer.model.summary().cells[0]!;
    const sink = peer.model.beginExecutionGeneration('a')!;
    sink.appendOutput({ output_type: 'stream', name: 'stdout', text: '1' });
    const after = peer.model.summary().cells[0]!;
    expect(after.sourceRevision).toBe(before.sourceRevision);
    expect(after.outputsRevision).not.toBe(before.outputsRevision);
    expect(after.cellRevision).not.toBe(before.cellRevision);

    peer.model.apply([
      {
        op: 'replace_source',
        cellId: 'a',
        expectedSourceRevision: after.sourceRevision,
        source: 'print(2)'
      }
    ]);
    const edited = peer.model.summary().cells[0]!;
    expect(edited.sourceRevision).not.toBe(after.sourceRevision);
    expect(edited.outputsRevision).toBe(after.outputsRevision);
  });

  it('pages with a cursor bound to the structural revision', () => {
    const peer = makePeer(
      notebookWith(Array.from({ length: 5 }, (_, i) => codeCell(`c${i}`, `cell ${i}`)))
    );
    cleanups.push(() => peer.dispose());
    const first = peer.model.summary({ maxCells: 2 });
    expect(first.cells.map((cell) => cell.cellId)).toEqual(['c0', 'c1']);
    expect(first.truncated).toBe(true);
    expect(first.pageCursor).toBeDefined();
    expect(first.cellCount).toBe(5);

    const second = peer.model.summary({ maxCells: 2, cursor: first.pageCursor! });
    expect(second.cells.map((cell) => cell.cellId)).toEqual(['c2', 'c3']);
    const third = peer.model.summary({ maxCells: 2, cursor: second.pageCursor! });
    expect(third.cells.map((cell) => cell.cellId)).toEqual(['c4']);
    expect(third.truncated).toBe(false);
    expect(third.pageCursor).toBeUndefined();
  });

  it('expires a page cursor when the structure changes between pages', () => {
    const peer = makePeer(
      notebookWith(Array.from({ length: 4 }, (_, i) => codeCell(`c${i}`, `cell ${i}`)))
    );
    cleanups.push(() => peer.dispose());
    const first = peer.model.summary({ maxCells: 2 });
    peer.model.apply([{ op: 'add_cell', cellType: 'code', source: 'new', position: 'end' }]);
    try {
      peer.model.summary({ maxCells: 2, cursor: first.pageCursor! });
      expect.unreachable();
    } catch (error) {
      expect(codeOf(error)).toBe('CURSOR_EXPIRED');
    }
  });

  it('rejects a changes cursor used as a page cursor', () => {
    const peer = makePeer(notebookWith([codeCell('a', 'x')]));
    cleanups.push(() => peer.dispose());
    try {
      peer.model.summary({ cursor: 'chg_1' as never });
      expect.unreachable();
    } catch (error) {
      expect(codeOf(error)).toBe('INVALID_ARGUMENT');
    }
  });
});

describe('readCells (SPEC.md §9)', () => {
  it('returns source, metadata and attachments and preserves unknown keys', () => {
    const peer = makePeer(
      notebookWith([
        markdownCell('m', '![img](attachment:a.png)', {
          metadata: { vendorX: { deep: [1, 2] } },
          attachments: { 'a.png': { 'image/png': 'AAAA' } }
        })
      ])
    );
    cleanups.push(() => peer.dispose());
    const read = peer.model.readCells({ cellIds: ['m'] }).cells[0]!;
    expect(read.cellType).toBe('markdown');
    expect(read.source).toBe('![img](attachment:a.png)');
    expect(read.metadata).toEqual({ vendorX: { deep: [1, 2] } });
    expect(read.attachments).toEqual({ 'a.png': { 'image/png': 'AAAA' } });
    expect(read.outputsRevision).toBeNull();
  });

  it('truncates a long source to the byte budget and reports the full size', () => {
    const long = 'x'.repeat(5000);
    const peer = makePeer(notebookWith([codeCell('a', long)]));
    cleanups.push(() => peer.dispose());
    const read = peer.model.readCells({ cellIds: ['a'] }, { maxBytes: 100 }).cells[0]!;
    expect(read.source).toHaveLength(100);
    expect(read.sourceTruncated).toBe(true);
    expect(read.sourceBytes).toBe(5000);
  });

  it('stops at maxCells and hands out a page cursor', () => {
    const peer = makePeer(
      notebookWith(Array.from({ length: 4 }, (_, i) => codeCell(`c${i}`, `cell ${i}`)))
    );
    cleanups.push(() => peer.dispose());
    const page = peer.model.readCells(undefined, { maxCells: 2 });
    expect(page.cells.map((cell) => cell.cellId)).toEqual(['c0', 'c1']);
    expect(page.truncated).toBe(true);
    const next = peer.model.readCells({ cursor: page.nextCursor! }, { maxCells: 2 });
    expect(next.cells.map((cell) => cell.cellId)).toEqual(['c2', 'c3']);
    expect(next.nextCursor).toBeUndefined();
  });

  it('reports CELL_NOT_FOUND and CELL_ID_AMBIGUOUS for explicit ids', () => {
    const peer = makePeer(notebookWith([codeCell('dup', 'x'), codeCell('dup', 'y')]));
    cleanups.push(() => peer.dispose());
    try {
      peer.model.readCells({ cellIds: ['nope'] });
      expect.unreachable();
    } catch (error) {
      expect(codeOf(error)).toBe('CELL_NOT_FOUND');
    }
    try {
      peer.model.readCells({ cellIds: ['dup'] });
      expect.unreachable();
    } catch (error) {
      expect(codeOf(error)).toBe('CELL_ID_AMBIGUOUS');
    }
  });
});

describe('readOutputs (SPEC.md §9: no full base64 in every answer)', () => {
  it('inlines small outputs with their MIME list and size', () => {
    const peer = makePeer(
      notebookWith([
        codeCell('a', 'plot()', {
          outputs: [
            { output_type: 'stream', name: 'stdout', text: 'hello\n' },
            {
              output_type: 'execute_result',
              data: { 'text/plain': '42', 'text/html': '<b>42</b>' },
              metadata: {},
              execution_count: 1
            }
          ],
          execution_count: 1
        })
      ])
    );
    cleanups.push(() => peer.dispose());
    const cell = peer.model.readOutputs(['a']).cells[0]!;
    expect(cell.outputs).toHaveLength(2);
    expect(cell.outputs[0]!.truncated).toBe(false);
    expect(cell.outputs[0]!.output).toMatchObject({ output_type: 'stream', text: 'hello\n' });
    expect(cell.outputs[1]!.mimeTypes).toEqual(['text/html', 'text/plain']);
    expect(cell.outputs[1]!.byteSize).toBeGreaterThan(0);
    expect(cell.truncated).toBe(false);
    expect(cell.outputsRevision).not.toBeNull();
  });

  it('never inlines a payload past the byte limit, but reports its size', () => {
    const peer = makePeer(
      notebookWith([
        codeCell('a', 'plot()', {
          outputs: [
            {
              output_type: 'display_data',
              data: { 'image/png': bigPng, 'text/plain': '<Figure>' },
              metadata: { 'image/png': { width: 640 } }
            }
          ]
        })
      ])
    );
    cleanups.push(() => peer.dispose());
    const cell = peer.model.readOutputs(['a'], { maxBytes: 4096 }).cells[0]!;
    const output = cell.outputs[0]!;
    expect(output.truncated).toBe(true);
    expect(output.output).toBeUndefined();
    expect(output.byteSize).toBeGreaterThan(200_000);
    expect(output.mimeTypes).toEqual(['image/png', 'text/plain']);
    expect(output.textPreview).toBe('<Figure>');
    expect(cell.truncated).toBe(true);
    expect(JSON.stringify(cell).length).toBeLessThan(4096);
  });

  it('gives a text excerpt of a stream output that does not fit', () => {
    const peer = makePeer(
      notebookWith([
        codeCell('a', 'loop()', {
          outputs: [{ output_type: 'stream', name: 'stdout', text: 'y'.repeat(50_000) }]
        })
      ])
    );
    cleanups.push(() => peer.dispose());
    const output = peer.model.readOutputs(['a'], { maxBytes: 512 }).cells[0]!.outputs[0]!;
    expect(output.truncated).toBe(true);
    expect(output.textPreview!.length).toBeLessThanOrEqual(512);
    expect(output.byteSize).toBeGreaterThan(50_000);
  });

  it('markdown cells have no output area', () => {
    const peer = makePeer(notebookWith([markdownCell('m', '# t')]));
    cleanups.push(() => peer.dispose());
    const cell = peer.model.readOutputs(['m']).cells[0]!;
    expect(cell.outputsRevision).toBeNull();
    expect(cell.outputs).toEqual([]);
    expect(cell.executionCount).toBeNull();
  });

  it('withIdentity completes a model summary into the notebook_read shape', () => {
    const peer = makePeer(notebookWith([codeCell('a', 'x')]));
    cleanups.push(() => peer.dispose());
    const full = withIdentity(peer.model.summary(), {
      notebookId: 'nb_A',
      path: 'work/notebook.ipynb',
      fileId: 'f-1',
      documentId: 'json:notebook:f-1',
      connectionState: 'ready',
      stale: false
    });
    expect(full.notebookId).toBe('nb_A');
    expect(full.documentId).toBe('json:notebook:f-1');
    expect(full.stale).toBe(false);
    expect(full.cells).toHaveLength(1);
  });
});
