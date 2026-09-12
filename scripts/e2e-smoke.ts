/**
 * End-to-end smoke test: `src/jupyter` + `src/core/notebook` + `src/kernel`
 * composed exactly as the future registry / MCP adapter will compose them.
 *
 * Nothing here is a fake. The stand in `dev/jupyter/` is a real JupyterLab
 * 4.6.3 with `jupyter-collaboration` 5.0.2; the document is a real
 * collaboration room; the kernel is a real `python3`. The script proves the
 * seam between the three modules, which no per-module test can:
 *
 *   1. `ServerClient.newUntitledNotebook` + `collaborationSession`  (SPEC §6)
 *   2. `RtcConnection` -> `YNotebook` -> `NotebookModel`            (SPEC §6)
 *   3. `NotebookModel.apply(add_cell)`                              (SPEC §7)
 *   4. `ExecutionRegistry.submit` with `model.beginExecutionGeneration`
 *      as `getSink` and the model as `revalidate`                   (SPEC §8)
 *   5. `NotebookModel.finishExecution` -> final count + `idle`      (SPEC §8)
 *   6. `NotebookModel.readOutputs`: stream text and a PNG bundle    (SPEC §9)
 *   7. a SECOND independent `RtcConnection` + `NotebookModel` sees the same
 *      cell, the same `outputs_revision`, the same `execution_count` and
 *      `execution_state: 'idle'`                                   (SPEC §12
 *      "Bidirectional RTC", "Outputs", "Shared execution")
 *   8. `RtcConnection.save()` -> `success`, then the `.ipynb` is read straight
 *      off the stand's contents root and must contain the cell and its
 *      outputs                                                     (SPEC §12
 *      "Headless operation and persistence")
 *
 * Everything is disposed and the stand is stopped before the process leaves;
 * exit code 0 means every step above held.
 *
 * Run: `pnpm smoke` (or `PORT=8893 pnpm tsx scripts/e2e-smoke.ts`).
 */

// The guard must be installed before any `@jupyterlab/services` object writes
// `console.debug("Starting WebSocket: ...")` to STDOUT (spike/NOTES.md §3.4).
import { installStdoutGuard } from '../src/jupyter/stdout-guard.js';

import { readFile } from 'node:fs/promises';
import { resolve as resolvePath } from 'node:path';

import { YNotebook } from '@jupyter/ydoc';
import { SessionAPI } from '@jupyterlab/services';

import type { NbOutput, ResolvedServer, SourceRevision } from '../src/core/index.js';
import { NotebookModel } from '../src/core/notebook/index.js';
import { RtcConnection, ServerClient } from '../src/jupyter/index.js';
import {
  ExecutionRegistry,
  KernelClient,
  type JobSnapshot,
  type Revalidate
} from '../src/kernel/index.js';
import { startStand, type Stand } from '../test/helpers/stand.js';

const restoreConsole = installStdoutGuard();

const PORT = Number(process.env['PORT'] ?? 8893);
const STREAM_MARKER = 'e2e-smoke: hello from the kernel';

/**
 * One 1x1 transparent PNG through `IPython.display`, plus a `print`, so the
 * run produces both a `stream` and a `display_data` with an `image/png`
 * bundle - the two output shapes SPEC.md §12 «Outputs» names explicitly.
 */
const CELL_SOURCE = [
  'import base64',
  'from IPython.display import display, Image',
  `print(${JSON.stringify(STREAM_MARKER)})`,
  'png = base64.b64decode(',
  '    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAA"',
  '    "DUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="',
  ')',
  'display(Image(data=png, format="png"))'
].join('\n');

/** Terminal job states of SPEC.md §8. */
const TERMINAL = new Set(['succeeded', 'failed', 'cancelled', 'interrupted', 'unknown']);

const cleanups: Array<{ label: string; run: () => void | Promise<void> }> = [];
let step = 0;

function note(text: string): void {
  process.stdout.write(`${text}\n`);
}

function begin(title: string): void {
  step += 1;
  note(`\n[${step}] ${title}`);
}

function ok(text: string): void {
  note(`    ok  ${text}`);
}

function check(condition: boolean, text: string): void {
  if (!condition) throw new Error(`FAILED: ${text}`);
  ok(text);
}

function onCleanup(label: string, run: () => void | Promise<void>): void {
  cleanups.push({ label, run });
}

/** Poll a predicate; the RTC round trip is milliseconds, not seconds. */
async function until(
  what: string,
  predicate: () => boolean,
  timeoutMs = 20_000,
  intervalMs = 50
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) return;
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${what}`);
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

interface OpenNotebook {
  readonly label: string;
  readonly notebook: YNotebook;
  readonly connection: RtcConnection;
  readonly model: NotebookModel;
}

/**
 * The composition under test: one room, one `Y.Doc`, one `YNotebook`, one
 * `NotebookModel`. Readiness is `synced && nbformat !== undefined`
 * (spike/NOTES.md §4), not "the connection said ready".
 */
async function openNotebook(
  label: string,
  stand: Stand,
  client: ServerClient,
  path: string,
  fileId: string,
  sessionId: string
): Promise<OpenNotebook> {
  const notebook = new YNotebook();
  const connection = new RtcConnection({
    wsBaseUrl: stand.wsUrl,
    token: stand.token,
    fileId,
    sessionId,
    ydoc: notebook.ydoc,
    awareness: notebook.awareness,
    awarenessUser: { name: `mcp-smoke-${label}`, color: '#2e7d32' },
    // The notebook layer owns the document session, so it supplies the
    // re-check the transport runs before every reconnect (SPEC.md §6
    // `FILE_ID_CHANGED`).
    revalidateFileId: async () => (await client.collaborationSession(path)).fileId
  });
  const model = new NotebookModel(notebook, { origin: { connection: label } });

  onCleanup(`dispose ${label}`, () => {
    model.dispose();
    connection.dispose();
    notebook.dispose();
  });

  await connection.connect(30_000);
  await until(`${label}: nbformat after sync`, () => model.isReady());
  return { label, notebook, connection, model };
}

/** Outputs of one cell as the model sees them, with a budget big enough for a PNG. */
function outputsOf(
  model: NotebookModel,
  cellId: string
): {
  readonly outputs: readonly NbOutput[];
  readonly outputsRevision: string | null;
  readonly executionCount: number | null;
  readonly executionState: string | undefined;
} {
  const read = model.readOutputs([cellId], { maxBytes: 4 * 1024 * 1024 });
  const cell = read.cells[0];
  if (cell === undefined) {
    return { outputs: [], outputsRevision: null, executionCount: null, executionState: undefined };
  }
  const outputs: NbOutput[] = [];
  for (const entry of cell.outputs) if (entry.output !== undefined) outputs.push(entry.output);
  return {
    outputs,
    outputsRevision: cell.outputsRevision,
    executionCount: cell.executionCount,
    executionState: cell.executionState
  };
}

/**
 * nbformat allows a multi-line string to be stored either as one string or as
 * a list of lines. The shared model keeps a string; the serialised `.ipynb`
 * on disk keeps the list, so both readings have to be accepted.
 */
function nbText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map((line) => (typeof line === 'string' ? line : '')).join('');
  return '';
}

function streamText(outputs: readonly NbOutput[]): string {
  let text = '';
  for (const output of outputs) {
    if (output.output_type !== 'stream') continue;
    text += nbText(output.text);
  }
  return text;
}

function hasPng(outputs: readonly NbOutput[]): boolean {
  for (const output of outputs) {
    if (output.output_type !== 'display_data' && output.output_type !== 'execute_result') continue;
    const data = (output as { data?: Record<string, unknown> }).data;
    if (data !== undefined && nbText(data['image/png']).length > 0) return true;
  }
  return false;
}

async function main(): Promise<void> {
  begin(`start the Jupyter stand on port ${PORT}`);
  const stand = await startStand({ port: PORT });
  if (stand.owned) onCleanup('stop the stand', () => stand.stop());
  else note('    !!  reusing a server this script did not start; it will not be stopped');
  ok(`stand at ${stand.baseUrl}, contents root ${stand.root}`);

  const server: ResolvedServer = {
    profile: {
      id: 'smoke',
      kind: 'standalone',
      apiBaseUrl: stand.baseUrl,
      credentialRef: `literal:${stand.token}`
    },
    apiBaseUrl: stand.baseUrl,
    wsBaseUrl: stand.wsUrl,
    token: stand.token
  };
  const client = new ServerClient(server);

  begin('create a notebook and get its document session (SPEC §6)');
  const status = await client.status();
  check(typeof status.started === 'string', `GET /api/status answers (version ${status.version ?? '?'})`);
  const created = await client.newUntitledNotebook('');
  check(created.path.endsWith('.ipynb'), `newUntitled created ${created.path}`);
  const session = await client.collaborationSession(created.path);
  check(session.fileId.length > 0 && session.sessionId.length > 0, 'document session returned fileId and sessionId');

  begin('open the notebook over RTC and build the model (SPEC §6 item 5)');
  const a = await openNotebook('A', stand, client, created.path, session.fileId, session.sessionId);
  check(a.connection.state === 'ready', `connection A is ${a.connection.state}`);
  check(a.connection.roomName === `json:notebook:${session.fileId}`, `room ${a.connection.roomName}`);
  check(a.connection.url.includes('token') === false, 'the room URL carries no credential');
  check(a.model.isReady(), `nbformat ${a.notebook.nbformat} is defined after sync`);
  const initialCells = a.model.summary().cellCount;
  ok(`the fresh notebook arrived with ${initialCells} server-created cell(s)`);

  begin('add a code cell through the model (SPEC §7)');
  const applied = a.model.apply([
    { op: 'add_cell', cellType: 'code', source: CELL_SOURCE, position: 'end' }
  ]);
  check(applied.appliedLocally, 'the batch applied locally');
  const result = applied.results[0];
  const cellId = result?.cellId;
  const cellRevision = result?.sourceRevision;
  if (cellId === undefined || cellRevision === undefined) throw new Error('add_cell returned no cell id / revision');
  check(a.model.summary().cellCount === initialCells + 1, `cell ${cellId} added at index ${result?.index}`);

  begin('bind a kernel to the notebook path (SPEC §8)');
  const settings = client.serverSettings();
  const kernelSession = await SessionAPI.startSession(
    { path: created.path, type: 'notebook', name: created.path, kernel: { name: 'python3' } },
    settings
  );
  const kernelModel = kernelSession.kernel;
  if (kernelModel === null || kernelModel === undefined) throw new Error('the session started without a kernel');
  onCleanup('shut the kernel session down', () => SessionAPI.shutdownSession(kernelSession.id, settings));
  const kernel = new KernelClient({
    serverSettings: settings,
    kernelId: kernelModel.id,
    kernelName: kernelModel.name
  });
  onCleanup('dispose the kernel client', () => kernel.dispose());
  const registry = new ExecutionRegistry(kernel);
  onCleanup('dispose the execution registry', () => registry.dispose());
  check(kernel.kernelId === kernelModel.id, `kernel ${kernelModel.name} ${kernelModel.id} bound to ${created.path}`);

  begin('execute the cell through the registry with the model as its sink (SPEC §8)');
  // This is the whole seam between `src/kernel` and `src/core/notebook`: the
  // registry never touches Yjs, the model never speaks the kernel protocol.
  const revalidate: Revalidate = (id, expected) => {
    try {
      const ref = a.model.cellRef(id);
      const read = a.model.readCells({ cellIds: [id] }, { maxBytes: 1024 * 1024 });
      const cell = read.cells[0];
      if (cell === undefined || cell.sourceTruncated) return { ok: false, code: 'cell_not_found' };
      if (cell.sourceRevision !== expected) return { ok: false, code: 'revision_conflict' };
      return { ok: true, source: cell.source, identityToken: ref.identityToken };
    } catch {
      return { ok: false, code: 'cell_not_found' };
    }
  };

  const executionId = registry.submit({
    notebookRef: { notebookId: 'nb_smoke', sessionId: 'sess_smoke' },
    cells: [{ cellId, sourceRevision: cellRevision as SourceRevision }],
    getSink: (id) => a.model.beginExecutionGeneration(id),
    revalidate
  });
  ok(`execution ${executionId} submitted`);

  // While it runs, the shared document must already show `running` and no
  // count - that is what keeps `[*]` in JupyterLab (dev/browser/NOTES.md).
  let sawRunning = false;
  let snapshot: JobSnapshot;
  let cursor = -1;
  const deadline = Date.now() + 60_000;
  for (;;) {
    snapshot = await registry.waitForChange(executionId, cursor, 500);
    cursor = snapshot.cursor;
    if (!sawRunning) {
      const live = outputsOf(a.model, cellId);
      if (live.executionState === 'running' && live.executionCount === null) sawRunning = true;
    }
    if (TERMINAL.has(snapshot.job.state)) break;
    if (Date.now() > deadline) throw new Error(`job stuck in ${snapshot.job.state}`);
  }
  check(snapshot.job.state === 'succeeded', `job finished ${snapshot.job.state}`);
  check(sawRunning, "the shared document showed execution_state 'running' with a null count during the run");

  const record = snapshot.job.cells[0];
  if (record === undefined) throw new Error('the job kept no cell record');
  check(record.state === 'succeeded', `cell record is ${record.state}`);
  check(record.sourceChanged === false && record.cellDeleted === false, 'the target cell was unchanged while it ran');

  begin('write the terminal count and idle through the model (SPEC §8)');
  // The registry deliberately does not do this: only the notebook model may
  // write `execution_count` + `execution_state` and only at completion.
  const sink = a.model.sinkFor(cellId);
  if (sink === null) throw new Error('the output generation was already superseded');
  check(
    a.model.finishExecution(sink, { count: record.executionCount ?? null }),
    `execution_count ${String(record.executionCount)} and execution_state 'idle' written`
  );

  begin('read the outputs back through NotebookModel.readOutputs (SPEC §9)');
  const mine = outputsOf(a.model, cellId);
  check(mine.outputs.length >= 2, `${mine.outputs.length} outputs in the shared model`);
  check(streamText(mine.outputs).includes(STREAM_MARKER), 'the stdout stream carries the marker');
  check(hasPng(mine.outputs), 'a display_data output carries an image/png bundle');
  check(mine.executionCount === 1, `execution_count is ${String(mine.executionCount)}`);
  check(mine.executionState === 'idle', `execution_state is ${String(mine.executionState)}`);

  begin('a SECOND independent client sees the same document (SPEC §12 "Bidirectional RTC")');
  const b = await openNotebook('B', stand, client, created.path, session.fileId, session.sessionId);
  check(b.connection.socketGeneration >= 1, 'connection B opened its own socket into the same room');
  check(b.model.ydoc !== a.model.ydoc, 'B is a separate Y.Doc, not a shared reference');

  await until('B to see the cell', () => {
    try {
      b.model.cellRef(cellId);
      return true;
    } catch {
      return false;
    }
  });
  await until(
    'B to see the finished outputs',
    () => outputsOf(b.model, cellId).outputsRevision === mine.outputsRevision
  );
  const theirs = outputsOf(b.model, cellId);
  const theirSource = b.model.readCells({ cellIds: [cellId] }, { maxBytes: 1024 * 1024 }).cells[0];
  check(theirSource?.source === CELL_SOURCE, 'B reads the same cell source');
  check(theirSource?.sourceRevision === cellRevision, 'B computes the same source_revision');
  check(theirs.outputsRevision === mine.outputsRevision, `B computes the same outputs_revision ${String(theirs.outputsRevision)}`);
  check(streamText(theirs.outputs).includes(STREAM_MARKER), 'B sees the stdout stream');
  check(hasPng(theirs.outputs), 'B sees the image/png bundle');
  check(theirs.executionCount === mine.executionCount, `B sees execution_count ${String(theirs.executionCount)}`);
  check(theirs.executionState === 'idle', `B sees execution_state ${String(theirs.executionState)}`);

  begin('save through RTC and read the .ipynb off disk (SPEC §12 "Headless operation and persistence")');
  const saveStatus = await a.connection.save(30_000);
  check(saveStatus === 'success', `RAW save answered ${saveStatus}`);

  const filePath = resolvePath(stand.root, created.path);
  const onDisk = JSON.parse(await readFile(filePath, 'utf8')) as {
    cells?: Array<{ id?: string; source?: unknown; outputs?: NbOutput[]; execution_count?: number | null }>;
  };
  const diskCell = (onDisk.cells ?? []).find((entry) => entry.id === cellId);
  if (diskCell === undefined) throw new Error(`${filePath} has no cell ${cellId}`);
  const diskSource = Array.isArray(diskCell.source) ? diskCell.source.join('') : String(diskCell.source ?? '');
  check(diskSource === CELL_SOURCE, `${created.path} on disk contains the cell source`);
  const diskOutputs = diskCell.outputs ?? [];
  check(diskOutputs.length === mine.outputs.length, `${diskOutputs.length} outputs persisted`);
  check(streamText(diskOutputs).includes(STREAM_MARKER), 'the persisted file contains the stdout stream');
  check(hasPng(diskOutputs), 'the persisted file contains the image/png bundle');
  check(diskCell.execution_count === mine.executionCount, `the persisted execution_count is ${String(diskCell.execution_count)}`);

  begin('release everything');
}

async function runCleanups(): Promise<void> {
  for (const entry of cleanups.reverse()) {
    try {
      await entry.run();
      ok(entry.label);
    } catch (error) {
      note(`    !!  ${entry.label} failed: ${String(error)}`);
    }
  }
}

let code = 0;
try {
  await main();
  note('\nSMOKE OK - the three modules compose end to end.');
} catch (error) {
  code = 1;
  note(`\nSMOKE FAILED: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
} finally {
  await runCleanups();
  restoreConsole();
}

process.exitCode = code;
// The process must leave on its own once every notebook, provider, kernel and
// socket is disposed; a hang would be a leak, so it is reported rather than
// hidden. An unref'd timer cannot itself keep the loop alive.
const watchdog = setTimeout(() => {
  note('    !!  something is still holding the event loop; forcing exit');
  process.exit(code);
}, 5_000);
watchdog.unref();
