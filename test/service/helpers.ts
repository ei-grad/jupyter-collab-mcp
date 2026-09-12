/**
 * In-memory rig for the `src/service` unit tests.
 *
 * Two fakes, and no more: a `fetch` that answers the Jupyter REST routes the
 * registry layer uses, and a notebook handle backed by a real `YNotebook` and
 * a real {@link NotebookModel} but no socket. Everything else under test - the
 * ledger, the session registry, the handle bookkeeping, the budgets - is the
 * production code.
 */

import { YNotebook } from '@jupyter/ydoc';

import type { ConnectionState, NotebookHandleInfo, SaveStatus } from '../../src/core/index.js';
import { NotebookModel } from '../../src/core/notebook/index.js';
import {
  HANDLE_LIFETIME,
  type NotebookHandle,
  type NotebookHandleInit
} from '../../src/service/index.js';

// ---------------------------------------------------------------------------
// a tiny virtual Jupyter Server
// ---------------------------------------------------------------------------

/** One file the fake server knows about. */
export interface FakeFile {
  readonly path: string;
  readonly type: 'notebook' | 'directory';
}

/** One `/api/sessions` row the fake server reports. */
export interface FakeSession {
  readonly id: string;
  readonly path: string;
  readonly kernelId: string;
  readonly kernelName: string;
}

export interface FakeServerOptions {
  readonly files?: readonly FakeFile[];
  readonly sessions?: readonly FakeSession[];
  /** Status the collaboration handshake reports. */
  readonly fileIds?: Readonly<Record<string, string>>;
  /** Force a status for one route, e.g. `{'PATCH /api/contents/a.ipynb': 409}`. */
  readonly failures?: Readonly<Record<string, number>>;
}

/** State of the fake, so a test can inspect what the service did. */
export interface FakeServer {
  readonly fetchImpl: typeof fetch;
  readonly files: Map<string, FakeFile>;
  readonly sessions: Map<string, FakeSession>;
  readonly calls: string[];
  untitledCounter: number;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

/** Build a `fetch` that answers the routes `ServerClient` issues. */
export function makeFakeServer(options: FakeServerOptions = {}): FakeServer {
  const files = new Map<string, FakeFile>();
  for (const file of options.files ?? []) files.set(file.path, file);
  const sessions = new Map<string, FakeSession>();
  for (const session of options.sessions ?? []) sessions.set(session.id, session);
  const calls: string[] = [];
  const failures = options.failures ?? {};
  const state: FakeServer = {
    fetchImpl: (() => undefined) as unknown as typeof fetch,
    files,
    sessions,
    calls,
    untitledCounter: 0
  };

  const impl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === 'string' ? input : input.toString());
    const method = (init?.method ?? 'GET').toUpperCase();
    const route = url.pathname;
    const key = `${method} ${decodeURIComponent(route)}`;
    calls.push(key);
    const forced = failures[key];
    if (forced !== undefined) return json({ message: 'forced' }, forced);

    if (route === '/api/status') {
      return json({ started: '2026-01-01T00:00:00Z', version: '2.21.0' });
    }
    if (route === '/api/sessions' && method === 'GET') {
      return json(
        [...sessions.values()].map((session) => ({
          id: session.id,
          path: session.path,
          name: session.path,
          type: 'notebook',
          kernel: { id: session.kernelId, name: session.kernelName, execution_state: 'idle' }
        }))
      );
    }
    if (route === '/api/sessions' && method === 'POST') {
      const body = JSON.parse(String(init?.body ?? '{}')) as {
        path: string;
        kernel?: { name?: string };
      };
      const created: FakeSession = {
        id: `jsess_${sessions.size + 1}`,
        path: body.path,
        kernelId: `kern_${sessions.size + 1}`,
        kernelName: body.kernel?.name ?? 'python3'
      };
      sessions.set(created.id, created);
      return json({
        id: created.id,
        path: created.path,
        name: created.path,
        type: 'notebook',
        kernel: { id: created.kernelId, name: created.kernelName, execution_state: 'starting' }
      });
    }
    if (route.startsWith('/api/sessions/') && method === 'DELETE') {
      sessions.delete(decodeURIComponent(route.slice('/api/sessions/'.length)));
      return new Response(null, { status: 204 });
    }
    if (route.startsWith('/api/collaboration/session/') && method === 'PUT') {
      const path = decodeURIComponent(route.slice('/api/collaboration/session/'.length));
      const fileId = options.fileIds?.[path] ?? `file-${path}`;
      return json({ fileId, sessionId: 'SERVER_SESSION', format: 'json', type: 'notebook' }, 200);
    }
    if (route.startsWith('/api/contents')) {
      const path = decodeURIComponent(route.slice('/api/contents/'.length));
      if (method === 'POST') {
        state.untitledCounter += 1;
        const name = `Untitled${state.untitledCounter === 1 ? '' : state.untitledCounter - 1}.ipynb`;
        const created = path === '' ? name : `${path}/${name}`;
        files.set(created, { path: created, type: 'notebook' });
        return json({ path: created, name, type: 'notebook' });
      }
      if (method === 'PATCH') {
        const body = JSON.parse(String(init?.body ?? '{}')) as { path: string };
        if (files.has(body.path)) return json({ message: 'exists' }, 409);
        files.delete(path);
        files.set(body.path, { path: body.path, type: 'notebook' });
        return json({ path: body.path, name: body.path, type: 'notebook' });
      }
      const file = path === '' ? { path: '', type: 'directory' as const } : files.get(path);
      if (file === undefined) return json({ message: 'not found' }, 404);
      if (url.searchParams.get('content') === '1') {
        const prefix = path === '' ? '' : `${path}/`;
        const content = [...files.values()].filter(
          (entry) =>
            entry.path.startsWith(prefix) && !entry.path.slice(prefix.length).includes('/')
        );
        return json({
          path,
          type: 'directory',
          content: content.map((entry) => ({
            name: entry.path.slice(prefix.length),
            path: entry.path,
            type: entry.type,
            last_modified: '2026-01-01T00:00:00Z',
            size: 10
          }))
        });
      }
      return json({
        path: file.path,
        name: file.path,
        type: file.type,
        last_modified: '2026-01-01T00:00:00Z',
        size: 10
      });
    }
    if (route === '/api/kernelspecs') {
      return json({
        default: 'python3',
        kernelspecs: { python3: { name: 'python3', spec: { display_name: 'Python 3', language: 'python' } } }
      });
    }
    if (route === '/api/kernels') {
      return json(
        [...sessions.values()].map((session) => ({
          id: session.kernelId,
          name: session.kernelName,
          last_activity: '2026-01-01T00:00:00Z',
          connections: 1,
          execution_state: 'idle'
        }))
      );
    }
    return json({ message: `unhandled ${key}` }, 404);
  };

  (state as { fetchImpl: typeof fetch }).fetchImpl = impl as unknown as typeof fetch;
  return state;
}

// ---------------------------------------------------------------------------
// a notebook handle without a socket
// ---------------------------------------------------------------------------

/** Knobs a test uses to steer one fake replica. */
export interface FakeHandleControls {
  connectionState: ConnectionState;
  saveStatus: SaveStatus;
  saveError: Error | null;
  disposed: boolean;
  kernelChanges: (string | null)[];
}

/** A live-looking replica over a real model, with no network underneath. */
export function makeFakeHandle(init: NotebookHandleInit): {
  handle: NotebookHandle;
  controls: FakeHandleControls;
} {
  const notebook = new YNotebook();
  notebook.setSource({
    cells: [{ cell_type: 'code', source: 'print(1)', metadata: {}, outputs: [], execution_count: null }],
    metadata: { kernelspec: { name: 'python3', display_name: 'Python 3' } },
    nbformat: 4,
    nbformat_minor: 5
  } as never);
  const model = new NotebookModel(notebook, { origin: { notebookId: init.notebookId } });
  const controls: FakeHandleControls = {
    connectionState: 'ready',
    saveStatus: 'success',
    saveError: null,
    disposed: false,
    kernelChanges: []
  };

  const handle = {
    notebookId: init.notebookId,
    sessionId: init.sessionId,
    path: init.path,
    fileId: init.fileId,
    documentId: `json:notebook:${init.fileId}`,
    notebook,
    model,
    executionIds: new Set<string>(),
    connection: {
      save: async (): Promise<SaveStatus> => {
        if (controls.saveError !== null) throw controls.saveError;
        return controls.saveStatus;
      }
    },
    get closed(): boolean {
      return controls.disposed;
    },
    get connectionState(): ConnectionState {
      return controls.disposed ? 'closed' : controls.connectionState;
    },
    get stale(): boolean {
      return handle.connectionState !== 'ready';
    },
    info(): NotebookHandleInfo {
      return {
        notebookId: init.notebookId,
        sessionId: init.sessionId,
        path: init.path,
        fileId: init.fileId,
        documentId: handle.documentId,
        connectionState: handle.connectionState,
        stale: handle.stale,
        lifetime: HANDLE_LIFETIME
      };
    },
    assertOpen(): void {
      if (controls.disposed) throw new Error('closed');
    },
    assertWritable(): void {
      handle.assertOpen();
    },
    delivery(): 'sent' | 'pending' | 'unknown' {
      return handle.connectionState === 'ready' ? 'sent' : 'unknown';
    },
    recordKernelChange(kernelId: string | null): void {
      controls.kernelChanges.push(kernelId);
      if (!controls.disposed) model.recordKernelChange(kernelId);
    },
    dispose(): void {
      if (controls.disposed) return;
      controls.disposed = true;
      model.dispose();
      notebook.dispose();
    }
  };

  return { handle: handle as unknown as NotebookHandle, controls };
}
