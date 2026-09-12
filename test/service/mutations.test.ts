/**
 * The deduplicated mutations that need no kernel: `notebook_create` and
 * `notebook_apply` (SPEC.md §6 "notebook creation", §7, §9 "Retries").
 *
 * The point of the file is the request number: which rejection consumes it,
 * what a replay returns, and that a replay never produces a second notebook or
 * a second cell.
 */

import { afterEach, describe, expect, it } from 'vitest';

import {
  isCoreError,
  type CellRevision,
  type CollabService,
  type ServerProfile,
  type SourceRevision
} from '../../src/core/index.js';
import { createCollabService } from '../../src/service/index.js';
import { makeFakeHandle, makeFakeServer, type FakeServer } from './helpers.js';

const PROFILE: ServerProfile = {
  id: 'main',
  kind: 'standalone',
  apiBaseUrl: 'http://127.0.0.1:8888',
  credentialRef: 'literal:tok'
};

interface Rig {
  readonly service: CollabService;
  readonly server: FakeServer;
  readonly opens: string[];
}

const rigs: Rig[] = [];

function rigFor(files: readonly string[] = ['a.ipynb']): Rig {
  const server = makeFakeServer({
    files: files.map((path) => ({ path, type: 'notebook' as const }))
  });
  const opens: string[] = [];
  const rig: Rig = {
    server,
    opens,
    service: createCollabService(
      { servers: [PROFILE] },
      {
        fetchImpl: server.fetchImpl,
        guardStdout: false,
        openHandle: async (init) => {
          opens.push(init.path);
          return makeFakeHandle(init).handle;
        }
      }
    )
  };
  rigs.push(rig);
  return rig;
}

afterEach(async () => {
  for (const rig of rigs.splice(0)) await rig.service.shutdown('client_request');
});

async function failure(fn: () => Promise<unknown>): Promise<{
  code: string;
  sideEffects: string;
  details: Record<string, unknown>;
}> {
  try {
    await fn();
  } catch (error) {
    if (!isCoreError(error)) throw error;
    return {
      code: error.code,
      sideEffects: error.sideEffects,
      details: (error.details ?? {}) as Record<string, unknown>
    };
  }
  throw new Error('expected a CoreError');
}

describe('notebook_create', () => {
  it('keeps the server-chosen name when none is asked for', async () => {
    const rig = rigFor([]);
    const session = await rig.service.sessionOpen({});
    const created = await rig.service.notebookCreate({
      sessionId: session.sessionId,
      requestId: '1',
      directory: ''
    });
    expect(created.untitledPath).toBe('Untitled.ipynb');
    expect(created.renamed).toBe(false);
    expect(created.notebook.path).toBe('Untitled.ipynb');
    expect(created.requestAccepted).toBe(true);
    expect(created.replayed).toBe(false);
    expect(created.firstAcceptedAt).toBeTypeOf('string');
    expect(created.nextRequestId).toBe('2');
  });

  it('renames through Contents PATCH before opening the room', async () => {
    const rig = rigFor([]);
    const session = await rig.service.sessionOpen({});
    const created = await rig.service.notebookCreate({
      sessionId: session.sessionId,
      requestId: '1',
      directory: '',
      name: 'analysis.ipynb'
    });
    expect(created.renamed).toBe(true);
    expect(created.untitledPath).toBe('Untitled.ipynb');
    expect(created.notebook.path).toBe('analysis.ipynb');
    expect(rig.opens).toEqual(['analysis.ipynb']);
    expect(rig.server.calls).toContain('PATCH /api/contents/Untitled.ipynb');
  });

  it('409 is ALREADY_EXISTS: the untitled file stays, the room is not opened', async () => {
    const rig = rigFor(['analysis.ipynb']);
    const session = await rig.service.sessionOpen({});
    const error = await failure(() =>
      rig.service.notebookCreate({
        sessionId: session.sessionId,
        requestId: '1',
        directory: '',
        name: 'analysis.ipynb'
      })
    );
    expect(error.code).toBe('ALREADY_EXISTS');
    expect(error.sideEffects).toBe('applied');
    expect(error.details['untitled_path']).toBe('Untitled.ipynb');
    expect(error.details['intended_path']).toBe('analysis.ipynb');
    expect(error.details['room_opened']).toBe(false);
    // The number is spent: the receipt existed before the file was allocated.
    expect(error.details['request_accepted']).toBe(true);
    expect(error.details['next_request_id']).toBe('2');
    expect(rig.server.files.has('Untitled.ipynb')).toBe(true);
    expect(rig.opens).toEqual([]);
  });

  it('an invalid name is rejected before the number is consumed', async () => {
    const rig = rigFor([]);
    const session = await rig.service.sessionOpen({});
    const error = await failure(() =>
      rig.service.notebookCreate({
        sessionId: session.sessionId,
        requestId: '1',
        directory: '',
        name: 'nested/analysis.ipynb'
      })
    );
    expect(error.code).toBe('INVALID_ARGUMENT');
    expect(error.details['request_accepted']).toBe(false);
    expect(error.details['next_request_id']).toBe('1');
    expect(rig.server.calls.some((call) => call.startsWith('POST /api/contents'))).toBe(false);
  });

  it('a replay returns the same notebook and creates no second file', async () => {
    const rig = rigFor([]);
    const session = await rig.service.sessionOpen({});
    const args = { sessionId: session.sessionId, requestId: '1', directory: '' } as const;
    const first = await rig.service.notebookCreate(args);
    const second = await rig.service.notebookCreate(args);
    expect(second.replayed).toBe(true);
    expect(second.firstAcceptedAt).toBe(first.firstAcceptedAt);
    expect(second.notebook.notebookId).toBe(first.notebook.notebookId);
    expect(rig.server.untitledCounter).toBe(1);
    expect(rig.opens).toHaveLength(1);
    expect(second.nextRequestId).toBe('2');
  });

  it('the same number with a different payload conflicts', async () => {
    const rig = rigFor([]);
    const session = await rig.service.sessionOpen({});
    await rig.service.notebookCreate({ sessionId: session.sessionId, requestId: '1', directory: '' });
    const error = await failure(() =>
      rig.service.notebookCreate({
        sessionId: session.sessionId,
        requestId: '1',
        directory: 'sub'
      })
    );
    expect(error.code).toBe('REQUEST_ID_CONFLICT');
    expect(error.details['request_accepted']).toBe(false);
  });

  it('a skipped number is REQUEST_OUT_OF_ORDER and runs nothing', async () => {
    const rig = rigFor([]);
    const session = await rig.service.sessionOpen({});
    const error = await failure(() =>
      rig.service.notebookCreate({ sessionId: session.sessionId, requestId: '2', directory: '' })
    );
    expect(error.code).toBe('REQUEST_OUT_OF_ORDER');
    expect(error.details['next_request_id']).toBe('1');
    expect(rig.server.untitledCounter).toBe(0);
  });
});

describe('notebook_apply', () => {
  it('applies a batch and reports delivery separately from persistence', async () => {
    const rig = rigFor();
    const session = await rig.service.sessionOpen({});
    const opened = await rig.service.notebookOpen({ sessionId: session.sessionId, path: 'a.ipynb' });
    const applied = await rig.service.notebookApply({
      notebookId: opened.notebook.notebookId,
      requestId: '1',
      operations: [{ op: 'add_cell', cellType: 'markdown', source: '# title', position: 'end' }]
    });
    expect(applied.appliedLocally).toBe(true);
    expect(applied.results[0]?.cellId).toBeTypeOf('string');
    expect(applied.delivery).toBe('sent');
    expect(applied.persistence).toBe('unconfirmed');
    expect(applied.requestAccepted).toBe(true);
    expect(applied.nextRequestId).toBe('2');

    const summary = await rig.service.notebookRead({
      notebookId: opened.notebook.notebookId,
      view: 'summary'
    });
    expect(summary.summary.cellCount).toBe(2);
  });

  it('a replay returns the stored result and adds no second cell', async () => {
    const rig = rigFor();
    const session = await rig.service.sessionOpen({});
    const opened = await rig.service.notebookOpen({ sessionId: session.sessionId, path: 'a.ipynb' });
    const args = {
      notebookId: opened.notebook.notebookId,
      requestId: '1',
      operations: [{ op: 'add_cell' as const, cellType: 'code' as const, source: 'x=1', position: 'end' as const }]
    };
    const first = await rig.service.notebookApply(args);
    const second = await rig.service.notebookApply(args);
    expect(second.replayed).toBe(true);
    expect(second.firstAcceptedAt).toBe(first.firstAcceptedAt);
    expect(second.results[0]?.cellId).toBe(first.results[0]?.cellId);
    const summary = await rig.service.notebookRead({
      notebookId: opened.notebook.notebookId,
      view: 'summary'
    });
    expect(summary.summary.cellCount).toBe(2);
  });

  it('a stale revision is REVISION_CONFLICT before the number is consumed', async () => {
    const rig = rigFor();
    const session = await rig.service.sessionOpen({});
    const opened = await rig.service.notebookOpen({ sessionId: session.sessionId, path: 'a.ipynb' });
    const cells = await rig.service.notebookRead({
      notebookId: opened.notebook.notebookId,
      view: 'cells'
    });
    const cell = cells.cells[0]!;
    const error = await failure(() =>
      rig.service.notebookApply({
        notebookId: opened.notebook.notebookId,
        requestId: '1',
        operations: [
          {
            op: 'replace_source',
            cellId: cell.cellId,
            expectedSourceRevision: `s1_${'A'.repeat(43)}` as SourceRevision,
            source: 'y=2'
          }
        ]
      })
    );
    expect(error.code).toBe('REVISION_CONFLICT');
    expect(error.details['request_accepted']).toBe(false);
    expect(error.details['next_request_id']).toBe('1');

    // The number is still usable with a corrected payload.
    const fixed = await rig.service.notebookApply({
      notebookId: opened.notebook.notebookId,
      requestId: '1',
      operations: [
        {
          op: 'replace_source',
          cellId: cell.cellId,
          expectedSourceRevision: cell.sourceRevision,
          source: 'y=2'
        }
      ]
    });
    expect(fixed.appliedLocally).toBe(true);
    expect(fixed.requestAccepted).toBe(true);
  });

  it('an empty batch is INVALID_ARGUMENT and consumes nothing', async () => {
    const rig = rigFor();
    const session = await rig.service.sessionOpen({});
    const opened = await rig.service.notebookOpen({ sessionId: session.sessionId, path: 'a.ipynb' });
    const error = await failure(() =>
      rig.service.notebookApply({
        notebookId: opened.notebook.notebookId,
        requestId: '1',
        operations: []
      })
    );
    expect(error.code).toBe('INVALID_ARGUMENT');
    expect(error.details['request_accepted']).toBe(false);
  });

  it('a missing cell is CELL_NOT_FOUND before acceptance', async () => {
    const rig = rigFor();
    const session = await rig.service.sessionOpen({});
    const opened = await rig.service.notebookOpen({ sessionId: session.sessionId, path: 'a.ipynb' });
    const error = await failure(() =>
      rig.service.notebookApply({
        notebookId: opened.notebook.notebookId,
        requestId: '1',
        operations: [
          { op: 'delete_cell', cellId: 'nope', expectedCellRevision: `c1_${'A'.repeat(43)}` as CellRevision }
        ]
      })
    );
    expect(error.code).toBe('CELL_NOT_FOUND');
    expect(error.details['request_accepted']).toBe(false);
  });

  it('two sessions keep independent request counters (SPEC.md §12 "Separate conversations")', async () => {
    const rig = rigFor();
    const one = await rig.service.sessionOpen({});
    const two = await rig.service.sessionOpen({});
    const a = await rig.service.notebookOpen({ sessionId: one.sessionId, path: 'a.ipynb' });
    const b = await rig.service.notebookOpen({ sessionId: two.sessionId, path: 'a.ipynb' });
    await rig.service.notebookApply({
      notebookId: a.notebook.notebookId,
      requestId: '1',
      operations: [{ op: 'add_cell', cellType: 'raw', source: 'one', position: 'end' }]
    });
    const second = await rig.service.notebookApply({
      notebookId: b.notebook.notebookId,
      requestId: '1',
      operations: [{ op: 'add_cell', cellType: 'raw', source: 'two', position: 'end' }]
    });
    expect(second.requestAccepted).toBe(true);
    expect(second.nextRequestId).toBe('2');
  });

  it('notebook_changes reports the events of the batch', async () => {
    const rig = rigFor();
    const session = await rig.service.sessionOpen({});
    const opened = await rig.service.notebookOpen({ sessionId: session.sessionId, path: 'a.ipynb' });
    const before = opened.changesCursor;
    await rig.service.notebookApply({
      notebookId: opened.notebook.notebookId,
      requestId: '1',
      operations: [{ op: 'add_cell', cellType: 'code', source: 'z=3', position: 'end' }]
    });
    const changes = await rig.service.notebookChanges({
      notebookId: opened.notebook.notebookId,
      cursor: before
    });
    expect(changes.events.some((event) => event.kind === 'cell_added')).toBe(true);
    expect(changes.events.every((event) => event.origin === 'local')).toBe(true);
    expect(changes.waitTimedOut).toBe(false);
    expect(changes.truncated).toBe(false);
  });

  it('a long-poll on an idle journal times out without events', async () => {
    const rig = rigFor();
    const session = await rig.service.sessionOpen({});
    const opened = await rig.service.notebookOpen({ sessionId: session.sessionId, path: 'a.ipynb' });
    const changes = await rig.service.notebookChanges({
      notebookId: opened.notebook.notebookId,
      cursor: opened.changesCursor,
      waitMs: 120
    });
    expect(changes.events).toHaveLength(0);
    expect(changes.waitTimedOut).toBe(true);
    expect(changes.nextCursor).toBe(opened.changesCursor);
  });
});
