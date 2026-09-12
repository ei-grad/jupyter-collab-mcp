/**
 * Headless Jupyter RTC helpers for the browser integration checks.
 *
 * This is a deliberate copy of the parts of `spike/rtc-spike.ts` that the
 * browser check needs (stand lifecycle, REST, document session, room provider,
 * transaction origin, kernel execution). The spike stays frozen as the record
 * of SPEC.md §13 step 1, so nothing here imports from it.
 */

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import { YNotebook, type YCodeCell } from '@jupyter/ydoc';
import { WebsocketProvider } from 'y-websocket';
import WebSocket from 'ws';
import {
  ServerConnection,
  KernelManager,
  SessionManager,
  type Session
} from '@jupyterlab/services';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO = path.resolve(HERE, '..', '..');
const JUPYTER_DIR = path.join(REPO, 'dev', 'jupyter');

export const PORT = process.env['PORT'] ?? '8894';
export const TOKEN = process.env['JUPYTER_TOKEN'] ?? 'devtoken';
const KEEP_SERVER = process.env['KEEP_SERVER'] === '1';

/** jupyter_server_ydoc/utils.py: MessageType.RAW. Collides with y-websocket's messageAuth. */
const MESSAGE_RAW = 2;

export function log(msg: string): void {
  process.stderr.write(`${msg}\n`);
}

export function assert(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(message);
}

export const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

export function redact(url: string): string {
  return url.replace(/token=[^&]+/, 'token=***');
}

/** Resolve when `subscribe` fires, reject on timeout. `subscribe` returns an unsubscribe fn. */
export function waitFor<T>(
  what: string,
  timeoutMs: number,
  subscribe: (resolve: (value: T) => void) => () => void
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      unsubscribe();
      reject(new Error(`timeout after ${timeoutMs}ms waiting for ${what}`));
    }, timeoutMs);
    const unsubscribe = subscribe((value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      unsubscribe();
      resolve(value);
    });
  });
}

// ---------------------------------------------------------------------------
// server lifecycle
// ---------------------------------------------------------------------------

export interface Stand {
  baseUrl: string; // no trailing slash
  wsBaseUrl: string;
  ownsServer: boolean;
}

export function startStand(): Stand {
  const external = process.env['JUPYTER_URL'];
  if (external) {
    const baseUrl = external.replace(/\/+$/, '');
    log(`reusing server at ${baseUrl}`);
    return { baseUrl, wsBaseUrl: baseUrl.replace(/^http/, 'ws'), ownsServer: false };
  }
  const baseUrl = `http://127.0.0.1:${PORT}`;
  log(`starting server on port ${PORT} (dev/jupyter/start.sh)`);
  const res = spawnSync('./start.sh', [], {
    cwd: JUPYTER_DIR,
    env: { ...process.env, PORT, TOKEN },
    encoding: 'utf8'
  });
  if (res.status === 3) {
    log(`start.sh: a server is already live on port ${PORT}; reusing, will not stop it`);
    return { baseUrl, wsBaseUrl: baseUrl.replace(/^http/, 'ws'), ownsServer: false };
  }
  if (res.status !== 0) {
    throw new Error(
      `start.sh failed (status ${res.status}):\n${res.stdout ?? ''}\n${res.stderr ?? ''}`
    );
  }
  return { baseUrl, wsBaseUrl: baseUrl.replace(/^http/, 'ws'), ownsServer: true };
}

export function stopStand(stand: Stand): void {
  if (!stand.ownsServer || KEEP_SERVER) {
    log(`leaving server at ${stand.baseUrl} running (ownsServer=${stand.ownsServer})`);
    return;
  }
  const res = spawnSync('./stop.sh', [], {
    cwd: JUPYTER_DIR,
    env: { ...process.env, PORT },
    encoding: 'utf8'
  });
  log(`stop.sh exited ${res.status}`);
}

// ---------------------------------------------------------------------------
// REST
// ---------------------------------------------------------------------------

export async function api(
  stand: Stand,
  route: string,
  init: RequestInit = {}
): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set('Authorization', `token ${TOKEN}`);
  if (init.body !== undefined) headers.set('Content-Type', 'application/json');
  return fetch(`${stand.baseUrl}${route}`, { ...init, headers });
}

/** newUntitled: POST to the *directory*, never PUT to a chosen path (SPEC.md §6). */
export async function createNotebook(stand: Stand, directory = ''): Promise<string> {
  const res = await api(stand, `/api/contents/${directory}`, {
    method: 'POST',
    body: JSON.stringify({ type: 'notebook' })
  });
  const text = await res.text();
  assert(res.status === 201, `POST /api/contents -> ${res.status} ${text}`);
  const model = JSON.parse(text) as { path: string };
  return model.path;
}

export interface DocSession {
  format: string;
  type: string;
  fileId: string;
  sessionId: string;
}

export async function requestDocSession(
  stand: Stand,
  format: string,
  type: string,
  filePath: string
): Promise<DocSession> {
  const res = await api(stand, `/api/collaboration/session/${encodeURIComponent(filePath)}`, {
    method: 'PUT',
    body: JSON.stringify({ format, type })
  });
  const text = await res.text();
  assert(
    res.status === 200 || res.status === 201,
    `PUT /api/collaboration/session -> ${res.status} ${text}`
  );
  return JSON.parse(text) as DocSession;
}

// ---------------------------------------------------------------------------
// RTC client
// ---------------------------------------------------------------------------

interface RawSaveReply {
  type: string;
  responseTo: number;
  status: string;
}

export interface RtcClient {
  label: string;
  notebook: YNotebook;
  provider: WebsocketProvider;
  requestSave(timeoutMs: number): Promise<RawSaveReply>;
  destroy(): void;
}

let saveRequestCounter = 0;

export async function connect(
  stand: Stand,
  label: string,
  session: DocSession
): Promise<RtcClient> {
  const notebook = new YNotebook();
  // The room name must stay UNENCODED: a %3A-encoded name opens a different,
  // empty room. y-websocket concatenates serverUrl + '/' + roomname verbatim.
  const roomName = `${session.format}:${session.type}:${session.fileId}`;
  const provider = new WebsocketProvider(
    `${stand.wsBaseUrl}/api/collaboration/room`,
    roomName,
    notebook.ydoc,
    {
      connect: false,
      disableBc: true, // mandatory in Node: BroadcastChannel would bypass the server
      WebSocketPolyfill: WebSocket as unknown as typeof globalThis.WebSocket,
      params: { sessionId: session.sessionId, token: TOKEN }
    }
  );

  // Jupyter MessageType.RAW == 2 collides with y-websocket's messageAuth == 2.
  const rawWaiters = new Map<number, (reply: RawSaveReply) => void>();
  provider.messageHandlers[MESSAGE_RAW] = (_encoder, decoder) => {
    let payload: unknown;
    try {
      payload = JSON.parse(decoding.readVarString(decoder));
    } catch (err) {
      log(`${label}: unparsable RAW message: ${String(err)}`);
      return;
    }
    const reply = payload as RawSaveReply;
    log(`${label}: RAW <- ${JSON.stringify(reply)}`);
    const waiter =
      reply && typeof reply.responseTo === 'number' ? rawWaiters.get(reply.responseTo) : undefined;
    if (waiter) {
      rawWaiters.delete(reply.responseTo);
      waiter(reply);
    }
  };

  provider.on('connection-error', (event) => {
    log(
      `${label}: connection-error ${String(
        (event as unknown as { message?: string })?.message ?? ''
      )}`
    );
  });
  provider.on('closed', (event) => {
    log(`${label}: closed ${event.code} ${event.reason}`);
  });

  log(`${label}: connecting ${redact(provider.url)}`);
  const synced = waitFor<boolean>(`${label} initial sync`, 30_000, (resolve) => {
    const handler = (isSynced: boolean): void => {
      if (isSynced) resolve(true);
    };
    provider.on('sync', handler);
    return () => provider.off('sync', handler);
  });
  provider.connect();
  await synced;
  // Readiness = synced AND nbformat defined (a fresh room has neither until sync).
  await waitForNotebook(
    `${label} nbformat`,
    notebook,
    15_000,
    () => notebook.nbformat !== undefined
  );

  // SPEC.md §6: publish our awareness state so server-side autosave stays on.
  notebook.awareness.setLocalStateField('user', {
    name: `headless-${label}`,
    color: '#1f77b4'
  });
  notebook.awareness.setLocalStateField('autosave', true);

  return {
    label,
    notebook,
    provider,
    async requestSave(timeoutMs: number) {
      const id = ++saveRequestCounter;
      const ws = provider.ws;
      assert(ws && ws.readyState === ws.OPEN, `${label}: socket is not open`);
      const reply = waitFor<RawSaveReply>(`${label} save reply #${id}`, timeoutMs, (resolve) => {
        rawWaiters.set(id, resolve);
        return () => rawWaiters.delete(id);
      });
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MESSAGE_RAW);
      encoding.writeVarString(encoder, 'save');
      encoding.writeVarUint(encoder, id);
      ws.send(encoding.toUint8Array(encoder));
      log(`${label}: RAW -> save #${id}`);
      return reply;
    },
    destroy() {
      provider.disconnect();
      provider.destroy();
      notebook.dispose();
    }
  };
}

/**
 * @jupyter/ydoc drops a custom origin inside cell.transact()/notebook.transact().
 * Going through the Y.Doc directly keeps it; nested transactions inherit it.
 */
export function transactAs<T>(notebook: YNotebook, origin: unknown, fn: () => T): T {
  let out!: T;
  notebook.ydoc.transact(() => {
    out = fn();
  }, origin);
  return out;
}

export function findCell(notebook: YNotebook, id: string): YCodeCell | undefined {
  return notebook.cells.find((c) => c.getId() === id) as YCodeCell | undefined;
}

export function waitForNotebook(
  what: string,
  notebook: YNotebook,
  timeoutMs: number,
  predicate: () => boolean
): Promise<void> {
  if (predicate()) return Promise.resolve();
  return waitFor<void>(what, timeoutMs, (resolve) => {
    const handler = (): void => {
      if (predicate()) resolve();
    };
    notebook.changed.connect(handler);
    return () => notebook.changed.disconnect(handler);
  });
}

// ---------------------------------------------------------------------------
// kernel
// ---------------------------------------------------------------------------

export interface KernelStack {
  sessionManager: SessionManager;
  kernelManager: KernelManager;
  session: Session.ISessionConnection;
  dispose(): Promise<void>;
}

export async function startKernelSession(
  stand: Stand,
  notebookPath: string
): Promise<KernelStack> {
  const serverSettings = ServerConnection.makeSettings({
    baseUrl: `${stand.baseUrl}/`,
    wsUrl: `${stand.wsBaseUrl}/`,
    token: TOKEN,
    appendToken: true,
    WebSocket: WebSocket as unknown as typeof globalThis.WebSocket,
    fetch: fetch as unknown as ServerConnection.ISettings['fetch']
  });
  const kernelManager = new KernelManager({ serverSettings });
  const sessionManager = new SessionManager({ kernelManager, serverSettings });
  const session = await sessionManager.startNew({
    path: notebookPath,
    type: 'notebook',
    name: notebookPath,
    kernel: { name: 'python3' }
  });
  await session.kernel?.info;
  return {
    sessionManager,
    kernelManager,
    session,
    async dispose() {
      try {
        await session.shutdown();
      } catch (err) {
        log(`kernel shutdown failed: ${String(err)}`);
      }
      session.dispose();
      sessionManager.dispose();
      kernelManager.dispose();
    }
  };
}

export interface ExecutionResult {
  outputs: Array<Record<string, unknown>>;
  outputTypes: string[];
  executionCount: number | null;
  replyStatus: string;
}

/**
 * Send `code` and collect nbformat outputs. `onExecuteInput` fires as soon as
 * the kernel echoes execute_input, which is where the real execution_count
 * comes from (the reply arrives only after the code finished).
 */
export async function executeInKernel(
  session: Session.ISessionConnection,
  code: string,
  hooks: {
    onExecuteInput?: (count: number) => void;
    onOutput?: (output: Record<string, unknown>) => void;
  } = {}
): Promise<ExecutionResult> {
  const kernel = session.kernel;
  assert(kernel, 'session has no kernel');

  const outputs: Array<Record<string, unknown>> = [];
  const outputTypes: string[] = [];
  let executionCount: number | null = null;

  const future = kernel.requestExecute(
    { code, allow_stdin: false, stop_on_error: true, silent: false, store_history: true },
    true
  );

  future.onIOPub = (msg) => {
    const msgType = msg.header.msg_type;
    if (
      msgType === 'stream' ||
      msgType === 'execute_result' ||
      msgType === 'display_data' ||
      msgType === 'error' ||
      msgType === 'update_display_data'
    ) {
      outputTypes.push(msgType);
      const content = msg.content as Record<string, unknown>;
      const { transient: _transient, ...rest } = content;
      const output = { output_type: msgType, ...rest };
      outputs.push(output);
      hooks.onOutput?.(output);
    } else {
      outputTypes.push(`(${msgType})`);
    }
    if (msgType === 'execute_input') {
      const count = (msg.content as { execution_count?: number }).execution_count;
      if (typeof count === 'number') {
        executionCount = count;
        hooks.onExecuteInput?.(count);
      }
    }
  };

  const reply = await future.done;
  const replyStatus = reply.content.status;
  if (reply.content.status === 'ok') {
    executionCount = reply.content.execution_count;
  }
  return { outputs, outputTypes, executionCount, replyStatus };
}
