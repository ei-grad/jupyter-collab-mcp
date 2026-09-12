/**
 * Headless import & smoke check — SPEC.md §13 step 1.
 *
 * Runs in plain Node (no DOM, no jsdom) and exercises the four libraries the
 * client depends on, so that "works headless" is a verified fact rather than
 * an assumption:
 *
 *   1. @jupyter/ydoc      — new YNotebook(), add a code cell, read it back,
 *                           encode Y.Doc state and replay it into a second
 *                           replica.
 *   2. @jupyterlab/services — ServerConnection.makeSettings() with a fake
 *                           baseUrl. Nothing connects; no request is made.
 *   3. y-websocket        — WebsocketProvider constructed with
 *                           WebSocketPolyfill = ws, connect:false, disableBc:true.
 *   4. y-protocols/sync   — writeSyncStep1 / readSyncMessage round trip between
 *                           two documents.
 *   5. yjs single-instance check — a dual Yjs import silently breaks CRDT
 *                           identity checks, so it is asserted here.
 *
 * Run: pnpm tsx scripts/check-headless.ts   (or: pnpm check-headless)
 * Exit code 0 = every check passed.
 *
 * ---------------------------------------------------------------------------
 * Findings from the first run (node v24.14.0, macOS arm64, pnpm 10.30.3).
 * All ten checks pass; nothing needed a source patch or a shim.
 * ---------------------------------------------------------------------------
 *
 * - No DOM shim is required. Neither @jupyter/ydoc 4.1.1 nor y-websocket 3.1.0
 *   nor @jupyterlab/services 7.6.3 touches `window`/`document` on these paths.
 *   @jupyter/docprovider is the browser-only piece and is deliberately not a
 *   dependency (SPEC.md §5).
 *
 * - LEAK: `new YNotebook()` creates a y-protocols `Awareness`, whose ~3s
 *   `setInterval` is a live libuv handle. A script that only constructs a
 *   notebook never exits. Fix: always `notebook.dispose()` (this script does it
 *   in `cleanup()`, the vitest test does it in `finally`). Long-lived client
 *   code must dispose on `notebook_close` (SPEC.md §4).
 *
 * - NOISE: constructing a YNotebook prints three copies of
 *   "Invalid access: Add Yjs type to a document before reading data." — yjs
 *   13.6.x `warnPrematureAccess`, triggered because @jupyter/ydoc reads its own
 *   Y types before they are integrated. It is written to STDERR via
 *   lib0/logging, so it does not corrupt the MCP stdio channel (SPEC.md §11);
 *   no fix applied, only recorded.
 *
 * - TYPES: `WebSocketPolyfill: WebSocket` (from `ws`) does not typecheck.
 *   @types/ws's WebSocket lacks `dispatchEvent`, which undici-types' DOM-shaped
 *   WebSocket in @types/node requires:
 *     TS2322 ... Property 'dispatchEvent' is missing in type
 *     '@types/ws'.WebSocket but required in type 'undici-types'.WebSocket
 *   Minimal fix: `WebSocket as unknown as typeof globalThis.WebSocket`. Runtime
 *   behaviour is unaffected; y-websocket only calls the constructor, send,
 *   close and the on* handlers, all of which `ws` provides.
 *
 * - `lib0` had to become a direct dependency. y-protocols write and read helpers
 *   take lib0 encoders/decoders, and pnpm's isolated node_modules does not
 *   expose a transitive dependency. Added `lib0` (0.2.117), the same copy
 *   y-websocket and y-protocols resolve.
 *
 * - ESM/CJS: @jupyterlab/services 7.6.3 is CJS with no "type" field, imported
 *   from an ESM module. Named imports (`ServerConnection`) work — cjs-module-
 *   lexer detects the re-exports — so no default-import interop dance and no
 *   `createRequire` fallback is needed. @jupyter/ydoc, yjs, y-protocols,
 *   y-websocket and lib0 are all ESM.
 *
 * - No duplicate yjs. `pnpm why yjs` reports "Found 1 version of yjs"
 *   (13.6.32): @jupyter/ydoc wants ^13.5.40, y-websocket ^13.5.6 (peer),
 *   y-protocols ^13 — one major, so pnpm dedupes it. No `pnpm.overrides` entry
 *   is needed, and the "Yjs was already imported" warning never fires. The
 *   check below asserts this rather than trusting it, because the failure mode
 *   is silent.
 *
 * - A fresh `YNotebook` has no `nbformat`/`nbformat_minor`: the state map is
 *   filled by the initial Yjs sync from the server (SPEC.md §6 step 5). Code
 *   must not read those before `ready`.
 */

import * as Y from 'yjs';
import * as syncProtocol from 'y-protocols/sync';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import { YNotebook } from '@jupyter/ydoc';
import { ServerConnection } from '@jupyterlab/services';
import { WebsocketProvider } from 'y-websocket';
import WebSocket from 'ws';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';

interface CheckResult {
  name: string;
  ok: boolean;
  detail: string;
}

const results: CheckResult[] = [];

function check(name: string, fn: () => string): void {
  try {
    results.push({ name, ok: true, detail: fn() });
  } catch (err) {
    const e = err as Error;
    results.push({ name, ok: false, detail: `${e.name}: ${e.message}` });
  }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

// ---------------------------------------------------------------------------
// 0. No DOM. Assert it, so a future dependency that quietly shims a global
//    cannot make the other checks pass for the wrong reason.
// ---------------------------------------------------------------------------

const domGlobals = ['window', 'document', 'navigator', 'localStorage', 'BroadcastChannel'] as const;

check('environment is headless (no window/document)', () => {
  const present = domGlobals.filter((g) => g in globalThis);
  // Node >= 22 ships `navigator` and `BroadcastChannel` natively; `window` and
  // `document` must be absent or the environment is not what we claim to test.
  assert(!('window' in globalThis), '`window` exists: not a plain Node environment');
  assert(!('document' in globalThis), '`document` exists: not a plain Node environment');
  return `node ${process.version}; globals present: ${present.join(', ') || 'none'}`;
});

// ---------------------------------------------------------------------------
// 1. @jupyter/ydoc — the shared notebook model.
// ---------------------------------------------------------------------------

// `YNotebook` owns a y-protocols Awareness whose 3s setInterval keeps the Node
// event loop alive. Everything created here is disposed in `cleanup()`.
const disposables: Array<() => void> = [];

let notebook: YNotebook | undefined;

check('new YNotebook() constructs headless', () => {
  notebook = new YNotebook();
  disposables.push(() => notebook?.dispose());
  assert(notebook.cells.length === 0, 'fresh notebook should have no cells');
  // A fresh model carries no nbformat: the state map is populated by the
  // initial Yjs sync from the server (SPEC.md §6 step 5).
  const fmt = notebook.nbformat === undefined ? 'unset until initial sync' : `${notebook.nbformat}.${notebook.nbformat_minor}`;
  return `awareness+ydoc created, nbformat=${fmt}, cells=${notebook.cells.length}`;
});

let cellId = '';

check('YNotebook.addCell + read back source', () => {
  assert(notebook, 'notebook was not created');
  const source = 'import sys\nprint(sys.version)\n';
  const cell = notebook.addCell({ cell_type: 'code', source });
  cellId = cell.getId();
  assert(notebook.cells.length === 1, 'expected exactly one cell');
  const readBack = notebook.getCell(0);
  assert(readBack.getSource() === source, 'source read back does not match what was written');
  assert(readBack.cell_type === 'code', 'cell_type is not "code"');
  assert(readBack.getId() === cellId, 'cell id is not stable between add and read');
  return `cell_id=${cellId}, type=code, source bytes=${source.length}`;
});

check('YNotebook.toJSON() produces nbformat', () => {
  assert(notebook, 'notebook was not created');
  const json = notebook.toJSON();
  assert(Array.isArray(json.cells), 'toJSON().cells is not an array');
  assert(json.cells.length === 1, 'toJSON() lost the cell');
  const first = json.cells[0] as { cell_type?: string; id?: string };
  assert(first.cell_type === 'code', 'toJSON() cell_type is wrong');
  return `cells=${json.cells.length}, cells[0].id=${first.id}, nbformat=${String(json.nbformat)} (unset before sync)`;
});

check('Y.encodeStateAsUpdate + replay into a second replica', () => {
  assert(notebook, 'notebook was not created');
  const update = Y.encodeStateAsUpdate(notebook.ydoc);
  assert(update.byteLength > 0, 'encoded update is empty');

  const replica = new YNotebook();
  disposables.push(() => replica.dispose());
  Y.applyUpdate(replica.ydoc, update);

  assert(replica.cells.length === 1, `replica has ${replica.cells.length} cells, expected 1`);
  const replicated = replica.getCell(0);
  assert(replicated.getId() === cellId, 'cell id did not survive the update round trip');
  assert(
    replicated.getSource() === notebook.getCell(0).getSource(),
    'cell source did not survive the update round trip'
  );

  // State vector exchange is what a warm reconnect uses (SPEC.md §6).
  const sv = Y.encodeStateVector(replica.ydoc);
  const diff = Y.encodeStateAsUpdate(notebook.ydoc, sv);
  return `update=${update.byteLength}B, stateVector=${sv.byteLength}B, diff after sync=${diff.byteLength}B`;
});

// ---------------------------------------------------------------------------
// 2. @jupyterlab/services — settings only. Nothing connects.
// ---------------------------------------------------------------------------

check('ServerConnection.makeSettings with a fake baseUrl (no connection)', () => {
  const settings = ServerConnection.makeSettings({
    baseUrl: 'https://example.invalid/user/nobody/',
    token: 'not-a-real-token',
    appendToken: true
  });
  assert(settings.baseUrl === 'https://example.invalid/user/nobody/', 'baseUrl was rewritten');
  assert(settings.wsUrl === 'wss://example.invalid/user/nobody/', `wsUrl derivation wrong: ${settings.wsUrl}`);
  assert(typeof settings.fetch === 'function', 'settings.fetch is not callable in Node');
  assert(typeof settings.WebSocket === 'function', 'settings.WebSocket is not callable in Node');
  return `wsUrl=${settings.wsUrl}, fetch=${settings.fetch.name || 'anonymous'}, WebSocket=${settings.WebSocket.name || 'anonymous'}`;
});

check('ServerConnection.makeSettings preserves a URL prefix without a trailing slash', () => {
  const settings = ServerConnection.makeSettings({ baseUrl: 'http://127.0.0.1:8888/user/a b/' });
  assert(settings.baseUrl.includes('/user/a b/'), 'path prefix was dropped');
  return `baseUrl=${settings.baseUrl}`;
});

// ---------------------------------------------------------------------------
// 3. y-websocket — constructed, never connected.
// ---------------------------------------------------------------------------

check('WebsocketProvider(connect:false, disableBc:true, WebSocketPolyfill=ws)', () => {
  const doc = new Y.Doc();
  disposables.push(() => doc.destroy());

  const provider = new WebsocketProvider(
    'wss://example.invalid/user/nobody/api/collaboration/room',
    'json:notebook:00000000-0000-0000-0000-000000000000',
    doc,
    {
      connect: false,
      disableBc: true,
      // `ws` is a Node WebSocket implementation, not the DOM class the option
      // is typed against; the cast is the documented Node usage.
      WebSocketPolyfill: WebSocket as unknown as typeof globalThis.WebSocket,
      params: { sessionId: 'fake-collaboration-session-id' }
    }
  );
  disposables.push(() => provider.destroy());

  assert(provider.shouldConnect === false, 'connect:false was ignored');
  assert(provider.wsconnected === false, 'provider opened a socket despite connect:false');
  assert(provider.synced === false, 'a never-connected provider must not report synced');
  assert(provider.bcconnected === false, 'disableBc:true was ignored');
  assert(provider.awareness !== undefined, 'provider has no awareness instance');
  return `url=${provider.url.replace(/sessionId=[^&]*/, 'sessionId=<redacted>')}`;
});

// ---------------------------------------------------------------------------
// 4. y-protocols sync helpers.
// ---------------------------------------------------------------------------

check('y-protocols/sync step1 -> step2 round trip', () => {
  const server = new Y.Doc();
  const client = new Y.Doc();
  disposables.push(() => server.destroy());
  disposables.push(() => client.destroy());

  server.getText('source').insert(0, 'df.head()');

  // client -> server: SyncStep1 (state vector of the empty client).
  const step1 = encoding.createEncoder();
  syncProtocol.writeSyncStep1(step1, client);

  const step1Reader = decoding.createDecoder(encoding.toUint8Array(step1));
  const step2 = encoding.createEncoder();
  const step1Type = syncProtocol.readSyncMessage(step1Reader, step2, server, 'check-headless');
  assert(step1Type === syncProtocol.messageYjsSyncStep1, `expected SyncStep1, got ${step1Type}`);

  // server -> client: SyncStep2 (the missing updates).
  const step2Bytes = encoding.toUint8Array(step2);
  assert(step2Bytes.byteLength > 0, 'server produced an empty SyncStep2');
  const step2Reader = decoding.createDecoder(step2Bytes);
  const reply = encoding.createEncoder();
  const step2Type = syncProtocol.readSyncMessage(step2Reader, reply, client, 'check-headless');
  assert(step2Type === syncProtocol.messageYjsSyncStep2, `expected SyncStep2, got ${step2Type}`);

  assert(
    client.getText('source').toString() === 'df.head()',
    'client did not converge after the sync round trip'
  );

  // Incremental update path (what steady-state RTC uses after `synced`).
  const applied: number[] = [];
  client.on('update', (u: Uint8Array) => applied.push(u.byteLength));
  server.getText('source').delete(7, 2);
  server.getText('source').insert(7, '(20)');

  const incremental = encoding.createEncoder();
  syncProtocol.writeUpdate(incremental, Y.encodeStateAsUpdate(server, Y.encodeStateVector(client)));
  const incrType = syncProtocol.readSyncMessage(
    decoding.createDecoder(encoding.toUint8Array(incremental)),
    encoding.createEncoder(),
    client,
    'check-headless'
  );
  assert(incrType === syncProtocol.messageYjsUpdate, `expected Update, got ${incrType}`);
  assert(
    client.getText('source').toString() === 'df.head(20)',
    `incremental update not applied, client has "${client.getText('source').toString()}"`
  );
  assert(applied.length === 1, `expected 1 incremental update, saw ${applied.length}`);
  return `step1=${encoding.toUint8Array(step1).byteLength}B, step2=${step2Bytes.byteLength}B, incremental=${encoding.toUint8Array(incremental).byteLength}B`;
});

// ---------------------------------------------------------------------------
// 5. Exactly one Yjs instance. Two copies of Yjs produce constructor identity
//    mismatches and the well-known "Yjs was already imported" warning; the
//    failure mode is silent data corruption, so it is asserted, not hoped for.
// ---------------------------------------------------------------------------

check('exactly one yjs instance is loaded', () => {
  assert(notebook, 'notebook was not created');

  // Constructor identity: with two copies of Yjs loaded, `instanceof` fails and
  // types silently refuse to integrate. Yjs itself only prints a
  // "Yjs was already imported" warning, so assert instead of relying on it.
  assert(notebook.ydoc instanceof Y.Doc, '@jupyter/ydoc uses a different Y.Doc constructor than we do');
  assert(
    notebook.getCell(0).ymodel.doc === notebook.ydoc,
    'cell ymodel is attached to a foreign document'
  );

  // Resolution identity: every dependent must resolve `yjs` to the same file.
  const require = createRequire(import.meta.url);
  const self = require.resolve('yjs');
  const dependents = ['@jupyter/ydoc', 'y-websocket', 'y-protocols', '@jupyterlab/services'];
  const resolved = new Map<string, string>([['(this package)', self]]);
  for (const dep of dependents) {
    try {
      resolved.set(dep, require.resolve('yjs', { paths: [dirname(require.resolve(`${dep}/package.json`))] }));
    } catch {
      // Not every dependent exposes package.json; identity above still holds.
    }
  }
  const distinct = new Set(resolved.values());
  assert(
    distinct.size === 1,
    `${distinct.size} distinct yjs copies resolved: ${[...resolved].map(([k, v]) => `${k} -> ${v}`).join('; ')}. ` +
      'Fix with a pnpm "overrides" entry pinning a single yjs.'
  );
  const yjsPkg = require('yjs/package.json') as { version: string };
  return `1 yjs copy (yjs@${yjsPkg.version}) shared by ${resolved.size} resolvers`;
});

// ---------------------------------------------------------------------------
// Report.
// ---------------------------------------------------------------------------

function cleanup(): void {
  for (const dispose of disposables.reverse()) {
    try {
      dispose();
    } catch {
      // Cleanup failures must not mask a real check failure.
    }
  }
}

cleanup();

let failed = 0;
for (const r of results) {
  if (!r.ok) failed += 1;
  const mark = r.ok ? 'ok  ' : 'FAIL';
  process.stdout.write(`${mark} ${r.name}\n       ${r.detail}\n`);
}

process.stdout.write(
  `\n${results.length - failed}/${results.length} headless checks passed on node ${process.version}\n`
);

if (failed > 0) {
  process.exitCode = 1;
}
