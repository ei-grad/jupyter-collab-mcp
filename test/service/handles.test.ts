/**
 * Handle lifecycle and budgets of the registry layer (SPEC.md §4, §9).
 *
 * The socket is the only thing faked here: opens go through
 * {@link CollabServiceOptions.openHandle}, everything else - session registry,
 * coalescing, the `EXECUTION_ACTIVE` guard, the ledger envelope, the replica
 * and session budgets - is production code driven through a fake Jupyter REST
 * surface.
 */

import { afterEach, describe, expect, it } from 'vitest';

import { isCoreError, type CollabService, type ServerProfile } from '../../src/core/index.js';
import { createCollabService } from '../../src/service/index.js';
import type { NotebookHandle, NotebookHandleInit } from '../../src/service/index.js';
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
  readonly opens: NotebookHandleInit[];
  readonly handles: NotebookHandle[];
  /** Resolves the next open only when the test says so. */
  gate: (() => void) | null;
}

function makeRig(
  options: {
    files?: readonly string[];
    limits?: Record<string, number>;
    slowOpen?: boolean;
  } = {}
): Rig {
  const server = makeFakeServer({
    files: (options.files ?? ['a.ipynb', 'b.ipynb']).map((path) => ({
      path,
      type: 'notebook' as const
    }))
  });
  const opens: NotebookHandleInit[] = [];
  const handles: NotebookHandle[] = [];
  const rig: Rig = {
    server,
    opens,
    handles,
    gate: null,
    service: createCollabService(
      { servers: [PROFILE], ...(options.limits === undefined ? {} : { limits: options.limits }) },
      {
        fetchImpl: server.fetchImpl,
        guardStdout: false,
        openHandle: async (init) => {
          opens.push(init);
          if (options.slowOpen === true) {
            await new Promise<void>((resolve) => {
              rig.gate = resolve;
            });
          }
          const { handle } = makeFakeHandle(init);
          handles.push(handle);
          return handle;
        }
      }
    )
  };
  return rig;
}

async function codeOf(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
  } catch (error) {
    return isCoreError(error) ? error.code : `other:${String(error)}`;
  }
  return 'no-error';
}

let open: Rig[] = [];

afterEach(async () => {
  for (const rig of open) await rig.service.shutdown('client_request');
  open = [];
});

function rigFor(options?: Parameters<typeof makeRig>[0]): Rig {
  const rig = makeRig(options);
  open.push(rig);
  return rig;
}

describe('working sessions', () => {
  it('session_open answers next_request_id "1" and starts no kernel', async () => {
    const rig = rigFor();
    const session = await rig.service.sessionOpen({ label: 'chat' });
    expect(session.sessionId).toMatch(/^sess_/);
    expect(session.nextRequestId).toBe('1');
    expect(session.kernelStarted).toBe(false);
    expect(session.label).toBe('chat');
    expect(session.lifetime.processScoped).toBe(true);
    expect(rig.server.calls).toContain('GET /api/status');
  });

  it('two sessions on one notebook get two replicas and two ids (SPEC.md §4)', async () => {
    const rig = rigFor();
    const first = await rig.service.sessionOpen({});
    const second = await rig.service.sessionOpen({});
    const a = await rig.service.notebookOpen({ sessionId: first.sessionId, path: 'a.ipynb' });
    const b = await rig.service.notebookOpen({ sessionId: second.sessionId, path: 'a.ipynb' });
    expect(a.notebook.notebookId).not.toBe(b.notebook.notebookId);
    expect(a.notebook.fileId).toBe(b.notebook.fileId);
    expect(rig.opens).toHaveLength(2);
    expect(a.reused).toBe(false);
    expect(b.reused).toBe(false);
  });

  it('session_close is idempotent and never shuts a kernel down', async () => {
    const rig = rigFor();
    const session = await rig.service.sessionOpen({});
    await rig.service.notebookOpen({ sessionId: session.sessionId, path: 'a.ipynb' });
    const closed = await rig.service.sessionClose({ sessionId: session.sessionId });
    expect(closed.alreadyClosed).toBe(false);
    expect(closed.closedNotebookIds).toHaveLength(1);
    expect(closed.kernelsLeftRunning).toBe(true);
    expect(closed.nextRequestId).toBeNull();

    const again = await rig.service.sessionClose({ sessionId: session.sessionId });
    expect(again.alreadyClosed).toBe(true);
    expect(again.nextRequestId).toBeNull();
  });

  it('a closed session answers HANDLE_EXPIRED elsewhere', async () => {
    const rig = rigFor();
    const session = await rig.service.sessionOpen({});
    const notebook = await rig.service.notebookOpen({
      sessionId: session.sessionId,
      path: 'a.ipynb'
    });
    await rig.service.sessionClose({ sessionId: session.sessionId });
    expect(await codeOf(() => rig.service.notebookList({ sessionId: session.sessionId, directory: '' }))).toBe(
      'HANDLE_EXPIRED'
    );
    expect(
      await codeOf(() =>
        rig.service.notebookRead({ notebookId: notebook.notebook.notebookId, view: 'summary' })
      )
    ).toBe('HANDLE_EXPIRED');
  });

  it('RESOURCE_LIMIT when the session budget is exhausted', async () => {
    const rig = rigFor({ limits: { maxSessions: 1 } });
    await rig.service.sessionOpen({});
    expect(await codeOf(() => rig.service.sessionOpen({}))).toBe('RESOURCE_LIMIT');
  });
});

describe('notebook handles', () => {
  it('reopening the same path returns the same handle without a second replica', async () => {
    const rig = rigFor();
    const session = await rig.service.sessionOpen({});
    const first = await rig.service.notebookOpen({ sessionId: session.sessionId, path: 'a.ipynb' });
    const second = await rig.service.notebookOpen({ sessionId: session.sessionId, path: 'a.ipynb' });
    expect(second.notebook.notebookId).toBe(first.notebook.notebookId);
    expect(second.reused).toBe(true);
    expect(rig.opens).toHaveLength(1);
  });

  it('concurrent opens of one document coalesce into one operation', async () => {
    const rig = rigFor({ slowOpen: true });
    const session = await rig.service.sessionOpen({});
    const a = rig.service.notebookOpen({ sessionId: session.sessionId, path: 'a.ipynb' });
    const b = rig.service.notebookOpen({ sessionId: session.sessionId, path: 'a.ipynb' });
    // Let both calls reach the gate before releasing it.
    await new Promise((resolve) => setTimeout(resolve, 10));
    rig.gate?.();
    const [first, second] = await Promise.all([a, b]);
    expect(rig.opens).toHaveLength(1);
    expect(first.notebook.notebookId).toBe(second.notebook.notebookId);
    expect([first.reused, second.reused].filter(Boolean)).toHaveLength(1);
  });

  it('NOTEBOOK_NOT_FOUND for a path the server does not have', async () => {
    const rig = rigFor();
    const session = await rig.service.sessionOpen({});
    expect(
      await codeOf(() => rig.service.notebookOpen({ sessionId: session.sessionId, path: 'gone.ipynb' }))
    ).toBe('NOTEBOOK_NOT_FOUND');
    expect(rig.opens).toHaveLength(0);
  });

  it('INVALID_ARGUMENT for a path escaping the Jupyter root', async () => {
    const rig = rigFor();
    const session = await rig.service.sessionOpen({});
    expect(
      await codeOf(() =>
        rig.service.notebookOpen({ sessionId: session.sessionId, path: '../etc/passwd' })
      )
    ).toBe('INVALID_ARGUMENT');
  });

  it('RESOURCE_LIMIT when the replica budget is exhausted', async () => {
    const rig = rigFor({ limits: { maxOpenNotebooks: 1 } });
    const session = await rig.service.sessionOpen({});
    await rig.service.notebookOpen({ sessionId: session.sessionId, path: 'a.ipynb' });
    expect(
      await codeOf(() => rig.service.notebookOpen({ sessionId: session.sessionId, path: 'b.ipynb' }))
    ).toBe('RESOURCE_LIMIT');
  });

  it('notebook_close is idempotent, leaves the kernel and expires the handle', async () => {
    const rig = rigFor();
    const session = await rig.service.sessionOpen({});
    const opened = await rig.service.notebookOpen({ sessionId: session.sessionId, path: 'a.ipynb' });
    const id = opened.notebook.notebookId;

    const closed = await rig.service.notebookClose({ notebookId: id });
    expect(closed.alreadyClosed).toBe(false);
    expect(closed.kernelLeftRunning).toBe(true);
    expect(rig.handles[0]?.closed).toBe(true);

    const again = await rig.service.notebookClose({ notebookId: id });
    expect(again.alreadyClosed).toBe(true);
    expect(await codeOf(() => rig.service.notebookRead({ notebookId: id, view: 'summary' }))).toBe(
      'HANDLE_EXPIRED'
    );
  });

  it('an unknown notebook handle is HANDLE_EXPIRED, not a crash', async () => {
    const rig = rigFor();
    expect(await codeOf(() => rig.service.notebookClose({ notebookId: 'nb_nope' }))).toBe(
      'HANDLE_EXPIRED'
    );
  });

  it('a reopened notebook after close is a new replica', async () => {
    const rig = rigFor();
    const session = await rig.service.sessionOpen({});
    const first = await rig.service.notebookOpen({ sessionId: session.sessionId, path: 'a.ipynb' });
    await rig.service.notebookClose({ notebookId: first.notebook.notebookId });
    const second = await rig.service.notebookOpen({ sessionId: session.sessionId, path: 'a.ipynb' });
    expect(second.notebook.notebookId).not.toBe(first.notebook.notebookId);
    expect(second.reused).toBe(false);
    expect(rig.opens).toHaveLength(2);
  });
});

describe('reads and the session envelope', () => {
  it('every session-scoped answer reports next_request_id', async () => {
    const rig = rigFor();
    const session = await rig.service.sessionOpen({});
    const opened = await rig.service.notebookOpen({ sessionId: session.sessionId, path: 'a.ipynb' });
    const summary = await rig.service.notebookRead({
      notebookId: opened.notebook.notebookId,
      view: 'summary'
    });
    expect(summary.nextRequestId).toBe('1');
    expect(summary.view).toBe('summary');
    expect(summary.summary.cellCount).toBe(1);
    expect(summary.changesCursor).toBe(summary.summary.changesCursor);
    expect(summary.requestAccepted).toBeUndefined();
  });

  it('the cells view carries revisions, notebook metadata and the cursor', async () => {
    const rig = rigFor();
    const session = await rig.service.sessionOpen({});
    const opened = await rig.service.notebookOpen({ sessionId: session.sessionId, path: 'a.ipynb' });
    const cells = await rig.service.notebookRead({
      notebookId: opened.notebook.notebookId,
      view: 'cells'
    });
    expect(cells.cells).toHaveLength(1);
    expect(cells.cells[0]?.source).toBe('print(1)');
    expect(cells.cells[0]?.sourceRevision).toMatch(/^s1_/);
    expect(cells.notebookMetadata).toMatchObject({ kernelspec: { name: 'python3' } });
    expect(cells.notebookMetadataRevision).toMatch(/^m1_/);
  });

  it('cell_ids together with a cursor is INVALID_ARGUMENT', async () => {
    const rig = rigFor();
    const session = await rig.service.sessionOpen({});
    const opened = await rig.service.notebookOpen({ sessionId: session.sessionId, path: 'a.ipynb' });
    expect(
      await codeOf(() =>
        rig.service.notebookRead({
          notebookId: opened.notebook.notebookId,
          view: 'cells',
          cellIds: ['x'],
          cursor: 'pg_x.0' as never
        })
      )
    ).toBe('INVALID_ARGUMENT');
  });

  it('notebook_list pages and reports the open handle of the session', async () => {
    const rig = rigFor({ files: ['a.ipynb', 'b.ipynb', 'c.ipynb'] });
    const session = await rig.service.sessionOpen({});
    const opened = await rig.service.notebookOpen({ sessionId: session.sessionId, path: 'b.ipynb' });
    const page = await rig.service.notebookList({
      sessionId: session.sessionId,
      directory: '',
      limits: { maxCells: 2 }
    });
    expect(page.entries.map((entry) => entry.path)).toEqual(['a.ipynb', 'b.ipynb']);
    expect(page.truncated).toBe(true);
    expect(page.entries[1]?.openNotebookId).toBe(opened.notebook.notebookId);
    const rest = await rig.service.notebookList({
      sessionId: session.sessionId,
      directory: '',
      cursor: page.nextCursor!
    });
    expect(rest.entries.map((entry) => entry.path)).toEqual(['c.ipynb']);
    expect(rest.truncated).toBe(false);
  });
});
