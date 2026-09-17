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
  readonly reachedGate: Promise<void>;
}

function makeRig(
  options: {
    files?: readonly string[];
    limits?: Record<string, number>;
    slowStage?: 'status' | 'contents' | 'collaboration' | 'replica';
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
  let markReached: (() => void) | null = null;
  const reachedGate = new Promise<void>((resolve) => {
    markReached = resolve;
  });
  const waitAtGate = async (): Promise<void> => {
    markReached?.();
    await new Promise<void>((resolve) => {
      rig.gate = resolve;
    });
  };
  const rig: Rig = {
    server,
    opens,
    handles,
    gate: null,
    reachedGate,
    service: createCollabService(
      { servers: [PROFILE], ...(options.limits === undefined ? {} : { limits: options.limits }) },
      {
        fetchImpl: async (input, init) => {
          const url = new URL(typeof input === 'string' ? input : input.toString());
          const method = (init?.method ?? 'GET').toUpperCase();
          if (options.slowStage === 'status' && method === 'GET' && url.pathname === '/api/status') {
            await waitAtGate();
          }
          if (
            options.slowStage === 'contents' &&
            method === 'GET' &&
            url.pathname === '/api/contents/a.ipynb'
          ) {
            await waitAtGate();
          }
          if (
            options.slowStage === 'collaboration' &&
            method === 'PUT' &&
            url.pathname === '/api/collaboration/session/a.ipynb'
          ) {
            await waitAtGate();
          }
          return server.fetchImpl(input, init);
        },
        guardStdout: false,
        openHandle: async (init) => {
          opens.push(init);
          if (options.slowStage === 'replica') await waitAtGate();
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

  it('shutdown fences session_open while server status is pending', async () => {
    const rig = rigFor({ slowStage: 'status' });
    const pending = rig.service.sessionOpen({});
    await rig.reachedGate;

    await rig.service.shutdown('client_request');
    rig.gate?.();

    expect(await codeOf(() => pending)).toBe('HANDLE_EXPIRED');
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
    const rig = rigFor({ slowStage: 'replica' });
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

  for (const stage of ['contents', 'collaboration', 'replica'] as const) {
    it(`session_close fences an open paused in the ${stage} stage`, async () => {
      const rig = rigFor({ limits: { maxOpenNotebooks: 1 }, slowStage: stage });
      const session = await rig.service.sessionOpen({});
      const pending = rig.service.notebookOpen({ sessionId: session.sessionId, path: 'a.ipynb' });
      await rig.reachedGate;

      await rig.service.sessionClose({ sessionId: session.sessionId });
      rig.gate?.();

      expect(await codeOf(() => pending)).toBe('HANDLE_EXPIRED');
      expect(rig.handles.every((handle) => handle.closed)).toBe(true);
    });

    it(`shutdown fences an open paused in the ${stage} stage`, async () => {
      const rig = rigFor({ slowStage: stage });
      const session = await rig.service.sessionOpen({});
      const pending = rig.service.notebookOpen({ sessionId: session.sessionId, path: 'a.ipynb' });
      await rig.reachedGate;

      await rig.service.shutdown('client_request');
      rig.gate?.();

      expect(await codeOf(() => pending)).toBe('HANDLE_EXPIRED');
      expect(rig.handles.every((handle) => handle.closed)).toBe(true);
    });
  }

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

describe('output snapshots', () => {
  it('pages text only on UTF-8 boundaries and rejects an insufficient budget without advancing', async () => {
    const rig = rigFor();
    const session = await rig.service.sessionOpen({});
    const opened = await rig.service.notebookOpen({
      sessionId: session.sessionId,
      path: 'a.ipynb'
    });
    const text = '😀¢€😀';
    const cellId = opened.summary.cells[0]!.cellId;
    const cell = rig.handles[0]!.notebook.getCell(0) as unknown as {
      setOutputs(outputs: unknown[]): void;
    };
    cell.setOutputs([{ output_type: 'stream', name: 'stdout', text }]);
    const outputs = await rig.service.notebookRead({
      notebookId: opened.notebook.notebookId,
      view: 'outputs',
      cellIds: [cellId],
      limits: { maxBytes: 1 }
    });
    const snapshot = outputs.cells[0]!.outputs[0]!.snapshot!;

    let insufficient: unknown;
    try {
      await rig.service.outputRead({ outputId: snapshot.outputId, limits: { maxBytes: 1 } });
    } catch (error) {
      insufficient = error;
    }
    expect(isCoreError(insufficient) && insufficient.code).toBe('RESOURCE_LIMIT');
    expect(isCoreError(insufficient) ? insufficient.details : undefined).toMatchObject({
      byte_offset: 0,
      required_bytes: 4,
      max_bytes: 1
    });
    expect(
      await codeOf(() =>
        rig.service.outputRead({
          outputId: snapshot.outputId,
          cursor: 'oc_1' as never,
          limits: { maxBytes: 4 }
        })
      )
    ).toBe('CURSOR_EXPIRED');

    const chunks: string[] = [];
    const byteLengths: number[] = [];
    let deliveredBytes = 0;
    let cursor: string | undefined;
    do {
      const chunk = await rig.service.outputRead({
        outputId: snapshot.outputId,
        ...(cursor === undefined ? {} : { cursor: cursor as never }),
        limits: { maxBytes: 4 }
      });
      expect(chunk.byteOffset).toBe(deliveredBytes);
      expect(chunk.data).not.toContain('�');
      chunks.push(chunk.data);
      const chunkBytes = Buffer.byteLength(chunk.data, 'utf8');
      byteLengths.push(chunkBytes);
      deliveredBytes += chunkBytes;
      cursor = chunk.nextCursor;
    } while (cursor !== undefined);

    expect(chunks.join('')).toBe(text);
    expect(byteLengths).toEqual([4, 2, 3, 4]);
    expect(deliveredBytes).toBe(Buffer.byteLength(text, 'utf8'));
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
