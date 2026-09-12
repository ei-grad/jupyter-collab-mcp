/**
 * Adversarial integration review of `src/kernel` against a real Python kernel.
 *
 * Port 8889 (this module's assigned port). Two SPEC.md §12 rows are checked:
 *
 *   "Execution completion | ... late output ..."
 *   "Cleanup and credentials | ... startup/reconnect/error do not expose tokens"
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { KernelAPI, ServerConnection } from '@jupyterlab/services';
import { sourceRevision, type JobState, type SourceRevision } from '../../src/core/index.js';
import { KernelClient } from '../../src/kernel/kernel-client.js';
import { ExecutionRegistry, type Revalidate } from '../../src/kernel/execution-registry.js';
import type { JupyterMessage } from '../../src/kernel/messages.js';
import { startStand, type Stand } from '../helpers/stand.js';
import { FakeSinkFactory } from './fake-sink.js';

const PORT = 8889;
const TOKEN = 'review-secret-token-8889';
const NOTEBOOK = { notebookId: 'nb_rev_int', sessionId: 'sess_rev_int' } as const;
const TERMINAL: readonly JobState[] = ['succeeded', 'failed', 'cancelled', 'interrupted', 'unknown'];

let stand: Stand;
let settings: ServerConnection.ISettings;
let kernelId: string;
let kernel: KernelClient;
let registry: ExecutionRegistry;
let sinks: FakeSinkFactory;
const sources = new Map<string, string>();

/** Everything the process tried to print while the client was running. */
const captured: string[] = [];
let restoreConsole: () => void = () => undefined;

function captureConsole(): () => void {
  const original = { log: console.log, info: console.info, debug: console.debug, error: console.error };
  const record = (...args: unknown[]): void => {
    captured.push(args.map((a) => String(a)).join(' '));
  };
  console.log = record;
  console.info = record;
  console.debug = record;
  console.error = record;
  return () => {
    console.log = original.log;
    console.info = original.info;
    console.debug = original.debug;
    console.error = original.error;
  };
}

const revalidate: Revalidate = (cellId, expected) => {
  const source = sources.get(cellId);
  if (source === undefined) return { ok: false, code: 'cell_not_found' };
  if (sourceRevision('code', source) !== expected) return { ok: false, code: 'revision_conflict' };
  return { ok: true, source, identityToken: `id:${cellId}` };
};

let counter = 0;
function cell(source: string): { cellId: string; sourceRevision: SourceRevision } {
  counter += 1;
  const cellId = `rev_cell_${counter}`;
  sources.set(cellId, source);
  return { cellId, sourceRevision: sourceRevision('code', source) };
}

async function waitForJob(executionId: string, timeoutMs = 45_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let cursor = -1;
  for (;;) {
    const snapshot = await registry.waitForChange(executionId, cursor, 300);
    cursor = snapshot.cursor;
    if (TERMINAL.includes(snapshot.job.state)) return;
    if (Date.now() > deadline) throw new Error(`job stuck in ${snapshot.job.state}`);
  }
}

beforeAll(async () => {
  restoreConsole = captureConsole();
  stand = await startStand({ port: PORT, token: TOKEN });
  settings = ServerConnection.makeSettings({
    baseUrl: `${stand.baseUrl}/`,
    wsUrl: `${stand.wsUrl}/`,
    token: stand.token,
    appendToken: true,
    WebSocket: WebSocket as unknown as typeof globalThis.WebSocket,
    fetch: fetch as unknown as ServerConnection.ISettings['fetch']
  });
  const model = await KernelAPI.startNew({ name: 'python3' }, settings);
  kernelId = model.id;
  kernel = new KernelClient({ serverSettings: settings, kernelId, kernelName: model.name });
  registry = new ExecutionRegistry(kernel);
  sinks = new FakeSinkFactory();
}, 180_000);

afterAll(async () => {
  registry?.dispose();
  kernel?.dispose();
  try {
    if (kernelId !== undefined) await KernelAPI.shutdownKernel(kernelId, settings);
  } catch {
    // already gone
  }
  await stand?.stop();
  restoreConsole();
  // Surface what the client printed, with the token blanked out.
  process.stderr.write(
    `captured console lines: ${captured.length}\n${captured
      .map((line) => line.split(TOKEN).join('<TOKEN>'))
      .join('\n')}\n`
  );
}, 120_000);

describe('SPEC §12 "Execution completion ... late output"', () => {
  it('output produced by a background thread after idle still reaches the cell', async () => {
    const target = cell(
      [
        'import threading',
        'def _late():',
        '    print("LATE-BACKGROUND-OUTPUT")',
        'threading.Timer(1.5, _late).start()',
        'print("done")'
      ].join('\n')
    );
    const executionId = registry.submit({
      notebookRef: NOTEBOOK,
      cells: [target],
      getSink: sinks.begin,
      revalidate
    });
    await waitForJob(executionId);

    const record = registry.get(executionId)!.job.cells[0]!;
    expect(record.state).toBe('succeeded');
    const msgId = record.msgId!;
    const sink = sinks.latest(target.cellId)!;
    expect(sink.isCurrent()).toBe(true);
    expect(JSON.stringify(sink.outputs)).toContain('done');

    // Attach a spy on the SAME parent msg_id. Routes are additive, so this
    // observes what the kernel really sends after `idle` without displacing
    // the registry's own route, which stays open for exactly this reason.
    const seen: JupyterMessage[] = [];
    const release = kernel.registerExecution(msgId, (msg) => seen.push(msg));
    await new Promise((resolve) => setTimeout(resolve, 4_000));
    release();

    const arrivedWithOurParent = seen.some(
      (m) => m.header.msg_type === 'stream' && String(m.content['text']).includes('LATE')
    );
    const writtenToTheOutputArea = JSON.stringify(sink.outputs).includes('LATE');
    const keptOnTheJob = JSON.stringify(
      registry.get(executionId)!.job.cells[0]!.outputsCollected
    ).includes('LATE');

    // SPEC.md §8: "Late outputs after `idle` continue updating the corresponding
    // output area until replaced by a subsequent execution/clear/delete/close."
    expect({ arrivedWithOurParent, writtenToTheOutputArea, keptOnTheJob }).toEqual({
      arrivedWithOurParent: true,
      writtenToTheOutputArea: true,
      keptOnTheJob: true
    });
  }, 60_000);
});

describe('SPEC §12 "Cleanup and credentials"', () => {
  it('never prints the server token', async () => {
    const target = cell('print("token check")');
    const executionId = registry.submit({
      notebookRef: NOTEBOOK,
      cells: [target],
      getSink: sinks.begin,
      revalidate
    });
    await waitForJob(executionId);
    expect(captured.length).toBeGreaterThan(0);
    expect(captured.join('\n')).not.toContain(TOKEN);
  }, 60_000);
});
