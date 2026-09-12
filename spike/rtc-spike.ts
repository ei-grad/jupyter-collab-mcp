/**
 * Throwaway RTC spike — SPEC.md §13 step 1.
 *
 * Proves (or disproves) end to end, headless, with no browser and without ever
 * writing the notebook through `PUT /api/contents`:
 *
 *   1. create a notebook with `POST /api/contents` (newUntitled semantics)
 *   2. `PUT /api/collaboration/session/<encodeURIComponent(path)>`
 *   3. client A: YNotebook + y-websocket provider -> initial sync
 *   4. client A inserts a code cell inside a transaction with a custom origin
 *   5. client B: a second, independent YNotebook + provider sees the cell,
 *      edits it, and client A observes the edit through the shared model
 *   6. a python3 kernel executes the cell through @jupyterlab/services and the
 *      outputs are written into the shared model; client B observes them
 *   7. the file on disk is checked, first for the server's 1s autosave, then
 *      through the RAW `save` request that jupyter-collaboration's docprovider
 *      sends over the room socket
 *   8. everything is torn down: providers, notebooks, kernel session, server
 *
 * Run:  pnpm tsx spike/rtc-spike.ts
 *
 * Env:
 *   PORT           port for the server this script starts (default 8898)
 *   JUPYTER_URL    reuse an already running server instead of starting one
 *   JUPYTER_TOKEN  token for that server (default 'devtoken')
 *   KEEP_SERVER=1  do not stop a server this script started (debugging)
 *
 * Exit code 0 only if every step passed.
 */

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import { YNotebook, type YCodeCell, type CellChange } from '@jupyter/ydoc';
import { WebsocketProvider } from 'y-websocket';
import WebSocket from 'ws';
import {
  ServerConnection,
  KernelManager,
  SessionManager,
  type Session
} from '@jupyterlab/services';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const JUPYTER_DIR = path.join(REPO, 'dev', 'jupyter');

const PORT = process.env['PORT'] ?? '8898';
const TOKEN = process.env['JUPYTER_TOKEN'] ?? 'devtoken';
const KEEP_SERVER = process.env['KEEP_SERVER'] === '1';

/** jupyter_server_ydoc/utils.py: MessageType.RAW. Collides with y-websocket's messageAuth. */
const MESSAGE_RAW = 2;

const ORIGIN_A = 'spike-client-A';
const ORIGIN_B = 'spike-client-B';
const ORIGIN_KERNEL = 'spike-kernel-writer';

const CELL_SOURCE = 'x = 40 + 2\nx';
const B_SUFFIX = '\n# from B';

// ---------------------------------------------------------------------------
// tiny result table
// ---------------------------------------------------------------------------

interface Step {
  name: string;
  ok: boolean;
  detail: string;
}
const steps: Step[] = [];

function record(name: string, ok: boolean, detail: string): boolean {
  steps.push({ name, ok, detail });
  log(`${ok ? 'ok  ' : 'FAIL'} ${name} — ${detail}`);
  return ok;
}

/** stdout is the report; everything chatty goes to stderr. */
function log(msg: string): void {
  process.stderr.write(`${msg}\n`);
}

function assert(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(message);
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function redact(url: string): string {
  return url.replace(/token=[^&]+/, 'token=***');
}

/** Resolve when `subscribe` fires, reject on timeout. `subscribe` returns an unsubscribe fn. */
function waitFor<T>(
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

interface Stand {
  baseUrl: string; // no trailing slash
  wsBaseUrl: string;
  ownsServer: boolean;
}

function startStand(): Stand {
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
    // start.sh refuses to start a second server on a live port; reuse it and
    // leave it running, because we did not start it.
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

function stopStand(stand: Stand): void {
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

async function api(
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
async function createNotebook(stand: Stand, directory = ''): Promise<string> {
  const res = await api(stand, `/api/contents/${directory}`, {
    method: 'POST',
    body: JSON.stringify({ type: 'notebook' })
  });
  const text = await res.text();
  assert(res.status === 201, `POST /api/contents -> ${res.status} ${text}`);
  const model = JSON.parse(text) as { path: string };
  return model.path;
}

interface DocSession {
  format: string;
  type: string;
  fileId: string;
  sessionId: string;
}

/**
 * jupyter-collaboration v5 packages/docprovider/src/requests.ts:
 *   URLExt.join(baseUrl, 'api/collaboration/session', encodeURIComponent(path))
 * with a PUT body of {format, type}. encodeURIComponent (not encodeURI) is the
 * load-bearing detail: it percent-encodes '/' as %2F for nested paths.
 */
async function requestDocSession(
  stand: Stand,
  format: string,
  type: string,
  filePath: string
): Promise<{ session: DocSession; status: number }> {
  const res = await api(stand, `/api/collaboration/session/${encodeURIComponent(filePath)}`, {
    method: 'PUT',
    body: JSON.stringify({ format, type })
  });
  const text = await res.text();
  assert(
    res.status === 200 || res.status === 201,
    `PUT /api/collaboration/session -> ${res.status} ${text}`
  );
  return { session: JSON.parse(text) as DocSession, status: res.status };
}

async function readNotebookFromDisk(
  stand: Stand,
  filePath: string
): Promise<{ cells: Array<Record<string, unknown>> }> {
  const res = await api(
    stand,
    `/api/contents/${filePath.split('/').map(encodeURIComponent).join('/')}?content=1`
  );
  const text = await res.text();
  assert(res.ok, `GET /api/contents -> ${res.status} ${text}`);
  const model = JSON.parse(text) as { content: { cells: Array<Record<string, unknown>> } };
  return model.content;
}

// ---------------------------------------------------------------------------
// RTC client
// ---------------------------------------------------------------------------

interface RtcClient {
  label: string;
  notebook: YNotebook;
  provider: WebsocketProvider;
  /** Send the docprovider RAW save request and wait for the reply. */
  requestSave(timeoutMs: number): Promise<{ type: string; responseTo: number; status: string }>;
  destroy(): void;
}

let saveRequestCounter = 0;

async function connect(stand: Stand, label: string, session: DocSession): Promise<RtcClient> {
  const notebook = new YNotebook();
  const roomName = `${session.format}:${session.type}:${session.fileId}`;
  const provider = new WebsocketProvider(
    `${stand.wsBaseUrl}/api/collaboration/room`,
    roomName,
    notebook.ydoc,
    {
      connect: false,
      disableBc: true, // SPEC.md §6 step 6: WS is the only exchange source in Node
      WebSocketPolyfill: WebSocket as unknown as typeof globalThis.WebSocket,
      params: { sessionId: session.sessionId, token: TOKEN }
    }
  );

  // jupyter_server_ydoc uses MessageType.RAW = 2 for the save request/reply.
  // y-websocket's slot 2 is y-protocols/auth, which would misparse it. The
  // provider exposes `messageHandlers` as a plain array, so a handler can be
  // swapped in without vendoring the provider.
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
    const waiter = reply && typeof reply.responseTo === 'number'
      ? rawWaiters.get(reply.responseTo)
      : undefined;
    if (waiter) {
      rawWaiters.delete(reply.responseTo);
      waiter(reply);
    }
  };

  provider.on('connection-error', (event) => {
    log(`${label}: connection-error ${String((event as unknown as { message?: string })?.message ?? '')}`);
  });
  provider.on('closed', (event) => {
    log(`${label}: closed ${event.code} ${event.reason}`);
  });

  log(`${label}: connecting ${redact(provider.url)}`);
  const synced = waitFor<boolean>(`${label} initial sync`, 20_000, (resolve) => {
    const handler = (isSynced: boolean): void => {
      if (isSynced) resolve(true);
    };
    provider.on('sync', handler);
    return () => provider.off('sync', handler);
  });
  provider.connect();
  await synced;

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
      // docprovider yprovider.ts requestDocumentSave():
      //   writeVarUint(RAW) ; writeVarString('save') ; writeVarUint(<id>)
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
      // YNotebook holds a y-protocols Awareness with a ~3s setInterval; without
      // dispose() the process never exits.
      notebook.dispose();
    }
  };
}

interface RawSaveReply {
  type: string;
  responseTo: number;
  status: string;
}

/**
 * @jupyter/ydoc drops a custom origin: YBaseCell.transact() forwards to
 * YNotebook.transact(f, undoable) without it, and YDocument.transact() only
 * honours `origin` when `undoable === false`. Going through the Y.Doc directly
 * keeps the origin, and nested YNotebook/YCell transactions merge into it.
 */
function transactAs<T>(notebook: YNotebook, origin: unknown, fn: () => T): T {
  let out!: T;
  notebook.ydoc.transact(() => {
    out = fn();
  }, origin);
  return out;
}

function findCell(notebook: YNotebook, id: string): YCodeCell | undefined {
  return notebook.cells.find((c) => c.getId() === id) as YCodeCell | undefined;
}

/** Wait until `predicate` holds, driven by the notebook's `changed` signal. */
function waitForNotebook(
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

interface ExecutionResult {
  outputs: Array<Record<string, unknown>>;
  outputTypes: string[];
  executionCount: number | null;
  replyStatus: string;
}

async function executeInKernel(
  session: Session.ISessionConnection,
  code: string
): Promise<ExecutionResult> {
  const kernel = session.kernel;
  assert(kernel, 'session has no kernel');

  const outputs: Array<Record<string, unknown>> = [];
  const outputTypes: string[] = [];
  let executionCount: number | null = null;

  const future = kernel.requestExecute(
    { code, allow_stdin: false, stop_on_error: true, silent: false, store_history: true },
    /* disposeOnDone */ true
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
      // nbformat output = {output_type: <msg_type>, ...content} minus `transient`
      const { transient: _transient, ...rest } = content;
      outputs.push({ output_type: msgType, ...rest });
    } else {
      outputTypes.push(`(${msgType})`);
    }
    if (msgType === 'execute_input') {
      const count = (msg.content as { execution_count?: number }).execution_count;
      if (typeof count === 'number') executionCount = count;
    }
  };

  const reply = await future.done;
  const replyStatus = reply.content.status;
  if (reply.content.status === 'ok') {
    executionCount = reply.content.execution_count;
  }
  return { outputs, outputTypes, executionCount, replyStatus };
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const stand = startStand();
  const cleanups: Array<() => void | Promise<void>> = [];
  let clientA: RtcClient | undefined;
  let clientB: RtcClient | undefined;

  try {
    // -- 1. create a notebook -------------------------------------------------
    const notebookPath = await createNotebook(stand);
    record('1 POST /api/contents (newUntitled)', true, `path=${notebookPath}`);

    // -- 2. collaboration document session ------------------------------------
    const { session: sessionA, status: statusA } = await requestDocSession(
      stand,
      'json',
      'notebook',
      notebookPath
    );
    record(
      '2 PUT /api/collaboration/session',
      Boolean(sessionA.fileId && sessionA.sessionId),
      `HTTP ${statusA}, fileId=${sessionA.fileId}, sessionId=${sessionA.sessionId}, keys=[${Object.keys(sessionA).sort().join(',')}]`
    );

    // -- 2b. path encoding: nested directory, space, non-ASCII ----------------
    // SPEC.md §6 requires the encoding to survive Unicode, spaces and nested
    // directories. encodeURIComponent turns '/' into %2F; Tornado's
    // `/api/collaboration/session/(.*)` route unescapes it back into the path.
    try {
      const dirModel = await api(stand, '/api/contents/', {
        method: 'POST',
        body: JSON.stringify({ type: 'directory' })
      });
      const created = (await dirModel.json()) as { path: string };
      const dirName = `Unicode test directory café ${Date.now()}`;
      const renamed = await api(stand, `/api/contents/${encodeURIComponent(created.path)}`, {
        method: 'PATCH',
        body: JSON.stringify({ path: dirName })
      });
      assert(renamed.ok, `PATCH rename -> ${renamed.status}`);
      const nestedPath = await createNotebook(stand, encodeURIComponent(dirName));
      const nested = await requestDocSession(stand, 'json', 'notebook', nestedPath);
      record(
        '2b session PUT for a nested Unicode path with a space',
        Boolean(nested.session.fileId) && nested.session.fileId !== sessionA.fileId,
        `path=${JSON.stringify(nestedPath)} -> ${encodeURIComponent(nestedPath)} -> HTTP ${nested.status}, fileId=${nested.session.fileId}`
      );
    } catch (err) {
      record('2b session PUT for a nested Unicode path with a space', false, String(err));
    }

    // -- 3. client A connects and syncs ---------------------------------------
    clientA = await connect(stand, 'A', sessionA);
    cleanups.push(() => clientA?.destroy());
    const nbA = clientA.notebook;
    const initialCells = nbA.cells.length;
    const initialStructureOk =
      Array.isArray(nbA.cells) &&
      nbA.nbformat === 4 &&
      typeof nbA.nbformat_minor === 'number' &&
      typeof nbA.getMetadata() === 'object';
    record(
      '3 client A initial sync',
      initialStructureOk,
      `cells=${initialCells} (auto-created empty code cell), nbformat=${nbA.nbformat}.${nbA.nbformat_minor}, metadata keys=[${Object.keys(nbA.getMetadata() ?? {}).sort().join(',')}]`
    );

    // -- 4. client A inserts a code cell --------------------------------------
    const insertedId = transactAs(nbA, ORIGIN_A, () => {
      const cell = nbA.addCell({ cell_type: 'code', source: CELL_SOURCE });
      return cell.getId();
    });
    const cellA = findCell(nbA, insertedId);
    record(
      '4 client A inserts a code cell (custom origin)',
      Boolean(cellA) && cellA?.getSource() === CELL_SOURCE,
      `id=${insertedId}, cells=${nbA.cells.length}, origin=${ORIGIN_A}`
    );
    assert(cellA, 'inserted cell is missing on A');

    // -- 5a. client B: reuse the same document session ------------------------
    const { session: sessionB, status: statusB } = await requestDocSession(
      stand,
      'json',
      'notebook',
      notebookPath
    );
    const sessionReusable =
      sessionB.fileId === sessionA.fileId && sessionB.sessionId === sessionA.sessionId;
    record(
      '5a second PUT session returns the same identity',
      sessionReusable,
      `HTTP ${statusB} (200 = already indexed); sessionId is the server-wide SERVER_SESSION, so a second PUT is optional`
    );

    // B reuses A's session values; the PUT above only proves the call is idempotent.
    clientB = await connect(stand, 'B', sessionA);
    cleanups.push(() => clientB?.destroy());
    const nbB = clientB.notebook;

    // -- 5b. B sees A's cell --------------------------------------------------
    await waitForNotebook("B sees A's cell", nbB, 15_000, () => Boolean(findCell(nbB, insertedId)));
    const cellB = findCell(nbB, insertedId);
    assert(cellB, "B never received A's cell");
    const bSeesCell = cellB.getSource() === CELL_SOURCE && cellB.cell_type === 'code';
    record(
      '5b client B sees A\'s cell (same id + source)',
      bSeesCell,
      `id=${cellB.getId()}, source=${JSON.stringify(cellB.getSource())}`
    );

    // -- 5c. B edits, A observes through the shared model ---------------------
    const expectedSource = CELL_SOURCE + B_SUFFIX;
    const aObservesEdit = waitFor<CellChange>("A observes B's source edit", 15_000, (resolve) => {
      const handler = (_sender: unknown, change: CellChange): void => {
        if (change.sourceChange && cellA.getSource() === expectedSource) resolve(change);
      };
      cellA.changed.connect(handler);
      return () => cellA.changed.disconnect(handler);
    });
    transactAs(nbB, ORIGIN_B, () => {
      // append, not replace: this must arrive as a Y.Text delta
      cellB.updateSource(cellB.getSource().length, cellB.getSource().length, B_SUFFIX);
    });
    const change = await aObservesEdit;
    record(
      "5c client A observes B's edit via cell.changed",
      cellA.getSource() === expectedSource,
      `sourceChange delta=${JSON.stringify(change.sourceChange)}, A source=${JSON.stringify(cellA.getSource())}`
    );

    // -- 6. kernel ------------------------------------------------------------
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
    cleanups.push(() => {
      sessionManager.dispose();
      kernelManager.dispose();
    });

    const kernelSession = await sessionManager.startNew({
      path: notebookPath,
      type: 'notebook',
      name: notebookPath,
      kernel: { name: 'python3' }
    });
    cleanups.push(async () => {
      try {
        await kernelSession.shutdown();
      } catch (err) {
        log(`kernel shutdown failed: ${String(err)}`);
      }
      kernelSession.dispose();
    });
    await kernelSession.kernel?.info;

    const exec = await executeInKernel(kernelSession, cellA.getSource());
    const execOk = exec.replyStatus === 'ok' && exec.outputs.length > 0;
    record(
      '6a kernel execute (allow_stdin=false)',
      execOk,
      `reply.status=${exec.replyStatus}, execution_count=${exec.executionCount}, iopub=[${exec.outputTypes.join(', ')}], nbformat outputs=[${exec.outputs.map((o) => String(o['output_type'])).join(', ')}]`
    );

    // write outputs into the shared model — one writer per execution (SPEC.md §8)
    const bSeesOutputs = waitFor<CellChange>('B observes outputs', 15_000, (resolve) => {
      const handler = (_sender: unknown, ch: CellChange): void => {
        if (ch.outputsChange && cellB.getOutputs().length > 0) resolve(ch);
      };
      cellB.changed.connect(handler);
      return () => cellB.changed.disconnect(handler);
    });
    transactAs(nbA, ORIGIN_KERNEL, () => {
      cellA.setOutputs(exec.outputs as never);
      cellA.execution_count = exec.executionCount;
      cellA.executionState = 'idle';
    });
    await bSeesOutputs;
    const bOutputs = cellB.getOutputs();
    record(
      '6b client B observes the outputs',
      bOutputs.length === exec.outputs.length,
      `B outputs=${JSON.stringify(bOutputs)}, B execution_count=${cellB.execution_count}`
    );

    // -- 7a. autosave ---------------------------------------------------------
    await sleep(2500); // jupyter_server_ydoc document_save_delay defaults to 1.0s
    const afterAutosave = await readNotebookFromDisk(stand, notebookPath);
    const autosaveCell = afterAutosave.cells.find((c) => c['id'] === insertedId);
    const autosaveOk =
      Boolean(autosaveCell) &&
      autosaveCell?.['source'] === expectedSource &&
      Array.isArray(autosaveCell?.['outputs']) &&
      (autosaveCell?.['outputs'] as unknown[]).length === exec.outputs.length;
    record(
      '7a autosave landed on disk (no PUT /api/contents)',
      autosaveOk,
      autosaveCell
        ? `source=${JSON.stringify(autosaveCell['source'])}, outputs=${JSON.stringify(autosaveCell['outputs'])}`
        : `cell ${insertedId} not on disk; cells=${afterAutosave.cells.length}`
    );

    // -- 7b. explicit RAW save ------------------------------------------------
    const saveReply = await clientA.requestSave(20_000);
    record(
      '7b RAW save request over the room socket',
      typeof saveReply.status === 'string',
      `reply=${JSON.stringify(saveReply)} (status is 'success' | 'skipped' | 'failed'; 'skipped' means a save was already running)`
    );

    const onDisk = await readNotebookFromDisk(stand, notebookPath);
    const diskCell = onDisk.cells.find((c) => c['id'] === insertedId);
    const diskOutputs = (diskCell?.['outputs'] as Array<Record<string, unknown>> | undefined) ?? [];
    const diskOk =
      Boolean(diskCell) &&
      diskCell?.['source'] === expectedSource &&
      diskOutputs.length === exec.outputs.length;
    record(
      '7c on-disk JSON has the cell, B\'s edit and the outputs',
      diskOk,
      diskCell
        ? `id=${String(diskCell['id'])}, source=${JSON.stringify(diskCell['source'])}, execution_count=${String(diskCell['execution_count'])}, outputs=${JSON.stringify(diskOutputs)}`
        : `cell ${insertedId} not found on disk`
    );

    // -- 8. clean teardown ----------------------------------------------------
    // (done in the finally block; recorded there)
  } finally {
    for (const fn of cleanups.reverse()) {
      try {
        await fn();
      } catch (err) {
        log(`cleanup error: ${String(err)}`);
      }
    }
    const noSockets =
      (clientA === undefined || clientA.provider.ws === null) &&
      (clientB === undefined || clientB.provider.ws === null);
    record('8 providers + kernel session torn down', noSockets, `sockets closed=${noSockets}`);
    stopStand(stand);
  }
}

// ---------------------------------------------------------------------------

let exitCode = 0;
try {
  await main();
} catch (err) {
  const e = err as Error;
  record('unexpected error', false, `${e.name}: ${e.message}`);
  log(e.stack ?? '');
  exitCode = 1;
}

const width = Math.max(...steps.map((s) => s.name.length));
process.stdout.write('\n');
for (const s of steps) {
  process.stdout.write(`${s.ok ? 'PASS' : 'FAIL'}  ${s.name.padEnd(width)}  ${s.detail}\n`);
}
const failed = steps.filter((s) => !s.ok).length;
process.stdout.write(`\n${steps.length - failed}/${steps.length} passed\n`);
if (failed > 0) exitCode = 1;

process.exitCode = exitCode;
// Everything above is disposed, so the loop should drain on its own. If some
// library still holds a handle, do not hang the run.
setTimeout(() => process.exit(exitCode), 5000).unref();
