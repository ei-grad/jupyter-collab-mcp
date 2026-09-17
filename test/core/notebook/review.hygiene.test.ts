/** Revision-conflict, response-limit, and credential-redaction coverage. */

import { describe, expect, it } from 'vitest';

import type { CoreError } from '../../../src/core/errors.js';
import { Wire, reviewBook, reviewCode, reviewPeer, typeInto } from './review.helpers.js';

describe('review: credential redaction (SPEC.md §7, §11)', () => {
  it('never echoes cell text or metadata values into a thrown error (SPEC.md §11)', () => {
    const secret = 'token=SUPERSECRET-9f3a';
    const peer = reviewPeer(
      11,
      reviewBook(
        [reviewCode('c1', `url = "http://h/?${secret}"\nurl2 = "http://h/?${secret}"`, {
          metadata: { creds: secret, scalar: 1 }
        })],
        { creds: secret }
      )
    );
    const summary = peer.model.summary();
    const cell = summary.cells[0]!;
    const realSource = cell.sourceRevision;
    // Well-formed but wrong, so the revision guard fails and the answer carries
    // the bounded preview SPEC.md §7 asks for. The preview is document text by
    // construction, so it must pass through `redactCredentials` (SPEC.md §11).
    const staleSource = (realSource.slice(0, -1) +
      (realSource.endsWith('A') ? 'B' : 'A')) as typeof realSource;
    const attempts: (() => unknown)[] = [
      () => peer.model.apply([{ op: 'replace_source', cellId: 'c1', expectedSourceRevision: staleSource, source: 'x' }]),
      () => peer.model.apply([{ op: 'replace_source', cellId: 'c1', expectedSourceRevision: cell.sourceRevision, source: 'x' }, { op: 'replace_source', cellId: 'nope', expectedSourceRevision: cell.sourceRevision, source: 'y' }]),
      () => peer.model.apply([{ op: 'replace_text', cellId: 'c1', expectedSourceRevision: cell.sourceRevision, oldText: secret, newText: 'z' }]),
      () => peer.model.apply([{ op: 'replace_text', cellId: 'c1', expectedSourceRevision: cell.sourceRevision, oldText: 'absent', newText: 'z' }]),
      () => peer.model.apply([{ op: 'set_cell_metadata', cellId: 'c1', expectedCellRevision: cell.cellRevision, key: ['scalar', 'deeper'], value: secret }]),
      () => peer.model.apply([{ op: 'set_cell_metadata', cellId: 'c1', expectedCellRevision: 'c1_wrongrevision' as never, key: 'creds', value: secret }]),
      () => peer.model.apply([{ op: 'set_notebook_metadata', key: 'creds', value: secret, expectedNotebookMetadataRevision: 'm1_wrong' as never }]),
      () => peer.model.readCells({ cellIds: ['missing'] })
    ];
    let raised = 0;
    for (const attempt of attempts) {
      try {
        attempt();
      } catch (error) {
        raised++;
        const dump = JSON.stringify((error as CoreError).toJSON?.() ?? error);
        expect(dump).not.toContain('SUPERSECRET');
        expect(String((error as Error).message)).not.toContain('SUPERSECRET');
      }
    }
    expect(raised).toBeGreaterThanOrEqual(6);
    peer.dispose();
  });
});

describe('review: REVISION_CONFLICT payload (SPEC.md §7)', () => {
  it('carries the current revision and a bounded preview', () => {
    // SPEC.md §7: "On mismatch, return `REVISION_CONFLICT` with the current
    // revision and a bounded preview, without changing anything."
    const peer = reviewPeer(11, reviewBook([reviewCode('c1', 'the current text of the cell')]));
    const real = peer.model.summary().cells[0]!.sourceRevision;
    // Well-formed but wrong: flip the last character so the revision passes the
    // shape check and fails the comparison.
    const stale = (real.slice(0, -1) + (real.endsWith('A') ? 'B' : 'A')) as typeof real;
    let caught: CoreError | null = null;
    try {
      peer.model.apply([
        { op: 'replace_source', cellId: 'c1', expectedSourceRevision: stale, source: 'new' }
      ]);
    } catch (error) {
      caught = error as CoreError;
    }
    expect(caught?.code).toBe('REVISION_CONFLICT');
    const details = (caught?.details ?? {}) as Record<string, unknown>;
    expect(details['current']).toBe(real);
    expect(details['expected']).toBe(stale);
    expect(Object.keys(details)).toContain('preview');
    // The preview shows the value the agent has to reconcile against, and is
    // bounded - it is a preview, not the cell.
    expect(details['preview']).toBe('the current text of the cell');
    // SPEC.md §7: "do not change anything."
    expect(peer.notebook.getCell(0).getSource()).toBe('the current text of the cell');
    peer.dispose();
  });

  it('the conflict preview of a huge cell stays bounded and single-line', () => {
    const peer = reviewPeer(
      11,
      reviewBook([reviewCode('c1', `${'x'.repeat(50_000)}\nsecond line`)])
    );
    const real = peer.model.summary().cells[0]!.sourceRevision;
    const stale = (real.slice(0, -1) + (real.endsWith('A') ? 'B' : 'A')) as typeof real;
    let preview = '';
    try {
      peer.model.apply([
        { op: 'replace_source', cellId: 'c1', expectedSourceRevision: stale, source: 'new' }
      ]);
    } catch (error) {
      preview = String(((error as CoreError).details ?? {})['preview']);
    }
    expect(preview.length).toBeLessThanOrEqual(200);
    expect(preview).not.toContain('\n');
    peer.dispose();
  });
});

describe('review: batch revision guards (SPEC.md §7)', () => {
  it('refuses the second full replacement of one cell that quotes the pre-batch revision', () => {
    const peer = reviewPeer(11, reviewBook([reviewCode('c1', 'original')]));
    const rev = peer.model.summary().cells[0]!.sourceRevision;
    // Both operations quote the same, now-stale revision. Accepting both would
    // make the first one's text disappear with no error - a lost update the
    // caller cannot notice, because `appliedLocally` would be true and both
    // results would report the final revision. The whole batch is refused
    // before the first mutation instead (SPEC.md §7).
    expect(() =>
      peer.model.apply([
        { op: 'replace_source', cellId: 'c1', expectedSourceRevision: rev, source: 'FIRST' },
        { op: 'replace_source', cellId: 'c1', expectedSourceRevision: rev, source: 'SECOND' }
      ])
    ).toThrowError(expect.objectContaining({ code: 'REVISION_CONFLICT' }));
    expect(peer.notebook.getCell(0).getSource()).toBe('original');
    peer.dispose();
  });

  it('chained replace_text in one batch still works (this must keep passing)', () => {
    const peer = reviewPeer(11, reviewBook([reviewCode('c1', 'alpha')]));
    const rev = peer.model.summary().cells[0]!.sourceRevision;
    peer.model.apply([
      { op: 'replace_text', cellId: 'c1', expectedSourceRevision: rev, oldText: 'alpha', newText: 'beta' },
      { op: 'replace_text', cellId: 'c1', expectedSourceRevision: rev, oldText: 'beta', newText: 'gamma' }
    ]);
    expect(peer.notebook.getCell(0).getSource()).toBe('gamma');
    peer.dispose();
  });
});

describe('review: metadata operations touch only the named key (SPEC.md §7)', () => {
  it('delete_cell_metadata("jupyter") keeps the unrelated "collapsed" key', () => {
    // `YBaseCell.deleteMetadata('jupyter')` mirrors the deletion onto
    // `collapsed`; the module writes the named key straight into the metadata
    // `Y.Map` so that only that key changes (SPEC.md §7).
    const peer = reviewPeer(
      11,
      reviewBook([
        reviewCode('c1', 'x', {
          metadata: { collapsed: true, jupyter: { outputs_hidden: true }, mine: 1 }
        })
      ])
    );
    const rev = peer.model.summary().cells[0]!.cellRevision;
    peer.model.apply([
      { op: 'delete_cell_metadata', cellId: 'c1', key: 'jupyter', expectedCellRevision: rev }
    ]);
    const after = peer.notebook.getCell(0).getMetadata() as Record<string, unknown>;
    expect(after['mine']).toBe(1);
    expect(after['jupyter']).toBeUndefined();
    expect(after['collapsed']).toBe(true);
    peer.dispose();
  });

  it('set_cell_metadata("collapsed") does not invent a "jupyter" key either', () => {
    // The other half of the same mirroring in `YBaseCell.setMetadata`. The
    // simulation that validated the batch predicted one key; the document must
    // agree, or the `cell_revision` a later operation quotes would be wrong.
    const peer = reviewPeer(11, reviewBook([reviewCode('c1', 'x', { metadata: { mine: 1 } })]));
    const rev = peer.model.summary().cells[0]!.cellRevision;
    const result = peer.model.apply([
      { op: 'set_cell_metadata', cellId: 'c1', key: 'collapsed', value: true, expectedCellRevision: rev }
    ]);
    expect(peer.notebook.getCell(0).getMetadata()).toEqual({ mine: 1, collapsed: true });
    // The revision reported back is the one the document really has.
    expect(result.results[0]!.cellRevision).toBe(peer.model.summary().cells[0]!.cellRevision);
    peer.dispose();
  });

  it('delete_notebook_metadata leaves every other notebook key in place', () => {
    const peer = reviewPeer(
      11,
      reviewBook([reviewCode('c1', 'x')], {
        kernelspec: { name: 'python3' },
        language_info: { name: 'python' },
        doomed: true
      })
    );
    const rev = peer.model.summary().notebookMetadataRevision;
    peer.model.apply([
      { op: 'delete_notebook_metadata', key: 'doomed', expectedNotebookMetadataRevision: rev }
    ]);
    expect(peer.notebook.getMetadata()).toEqual({
      kernelspec: { name: 'python3' },
      language_info: { name: 'python' }
    });
    peer.dispose();
  });
});

describe('review: cleanup after dispose (SPEC.md §6, §12 "Cleanup and credentials")', () => {
  it('removes its observers and stops journalling remote work', () => {
    const local = reviewPeer(11, reviewBook([reviewCode('c1', 'x')]));
    const remote = reviewPeer(22);
    const wire = new Wire(local.notebook.ydoc, remote.notebook.ydoc);
    wire.setAuto(true);
    local.model.dispose();
    const frozen = local.model.changesCursor;
    typeInto(remote.notebook, 0, 'after dispose');
    expect(local.notebook.getCell(0).getSource()).toBe('after dispose');
    expect(local.model.changesCursor).toBe(frozen);
    local.model.dispose(); // idempotent
    wire.dispose();
    local.notebook.dispose();
    remote.dispose();
  });

  it('a released handle refuses journal writes too', () => {
    // SPEC.md §6: "A closed handle returns `HANDLE_EXPIRED`." Reads and
    // apply() do; the two journal recorders keep appending to the ring of a
    // model that no longer observes anything.
    const peer = reviewPeer(11, reviewBook([reviewCode('c1', 'x')]));
    peer.model.dispose();
    expect(() => peer.model.changesSince('chg_0')).toThrowError(
      expect.objectContaining({ code: 'HANDLE_EXPIRED' })
    );
    expect(() => peer.model.recordConnectionState('closed')).toThrowError(
      expect.objectContaining({ code: 'HANDLE_EXPIRED' })
    );
    peer.notebook.dispose();
  });
});

describe('review: read limits (SPEC.md §9)', () => {
  it('keeps a 750 KB output area out of the answer', () => {
    const outputs = [
      {
        output_type: 'display_data',
        data: { 'image/png': 'i'.repeat(400_000), 'text/plain': 'x'.repeat(50_000) },
        metadata: {}
      },
      { output_type: 'stream', name: 'stdout', text: 'z'.repeat(300_000) }
    ];
    const peer = reviewPeer(11, reviewBook([reviewCode('c1', 'plot()', { outputs })]));
    const read = peer.model.readOutputs(['c1']);
    expect(Buffer.byteLength(JSON.stringify(read), 'utf8')).toBeLessThan(8 * 1024);
    expect(read.truncated).toBe(true);
    expect(read.cells[0]!.outputs.map((output) => output.truncated)).toEqual([true, true]);
    expect(read.cells[0]!.outputs[0]!.mimeTypes).toEqual(['image/png', 'text/plain']);
    expect(read.cells[0]!.outputs[0]!.byteSize).toBeGreaterThan(400_000);
    peer.dispose();
  });

  it('a page cursor advances past a cell whose source did not fit the budget', () => {
    const peer = reviewPeer(
      11,
      reviewBook([reviewCode('big', 'x'.repeat(100_000)), reviewCode('small', 'y')])
    );
    const page = peer.model.readCells(undefined, { maxBytes: 16 });
    expect(page.cells).toHaveLength(1);
    expect(page.cells[0]!.sourceTruncated).toBe(true);
    expect(page.cells[0]!.sourceBytes).toBe(100_000);
    // The cursor points at the *next* cell: the remaining 99 984 bytes of
    // `big` are not reachable by paging, only by raising maxBytes.
    const next = peer.model.readCells({ cursor: page.nextCursor! }, { maxBytes: 64 * 1024 });
    expect(next.cells.map((cell) => cell.cellId)).toEqual(['small']);
    peer.dispose();
  });

  it('a journal cursor that just fell out of the ring is CURSOR_EXPIRED, the next one is not', () => {
    const peer = reviewPeer(11, reviewBook([reviewCode('c1', 'x')]), { journalLimit: 3 });
    for (let i = 0; i < 5; i++) peer.model.recordKernelChange(`k${i}`);
    expect(() => peer.model.changesSince('chg_1')).toThrowError(
      expect.objectContaining({ code: 'CURSOR_EXPIRED' })
    );
    const page = peer.model.changesSince('chg_2');
    expect(page.events.map((event) => event.sequence)).toEqual([3, 4, 5]);
    expect(page.nextCursor).toBe('chg_5');
    peer.dispose();
  });
});
