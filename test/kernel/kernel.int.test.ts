/**
 * Integration tests of `src/kernel` against a real Python kernel on the
 * disposable stand (port 8889).
 *
 * They cover what only a kernel can prove (SPEC.md §12 "Outputs", "Execution
 * completion", "Interruption", "Shared kernel", "Limits"): stream merging,
 * stderr, `execute_result`, `display_data`, `update_display_data` across
 * cells, `clear_output(wait=True)`, a traceback stored once, a real PNG,
 * `stop_on_error`, cancelling unsent cells, an interrupt, `allow_stdin=false`
 * with `input()`, and a foreign execution on the same kernel.
 *
 * The notebook model is replaced by `FakeSink`: `src/kernel` never touches Yjs,
 * so this is the whole seam it writes through.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { KernelAPI, ServerConnection } from '@jupyterlab/services';
import { sourceRevision, type JobState, type SourceRevision } from '../../src/core/index.js';
import { KernelClient } from '../../src/kernel/kernel-client.js';
import { ExecutionRegistry, type Revalidate } from '../../src/kernel/execution-registry.js';
import { createExecutionReducer, type ExecutionReducer } from '../../src/kernel/output-reducer.js';
import type { JobSnapshot } from '../../src/kernel/job-record.js';
import { startStand, type Stand } from '../helpers/stand.js';
import { FakeSinkFactory, type FakeSink } from './fake-sink.js';

const PORT = 8889;
const NOTEBOOK = { notebookId: 'nb_int', sessionId: 'sess_int' } as const;
const TERMINAL: readonly JobState[] = ['succeeded', 'failed', 'cancelled', 'interrupted', 'unknown'];

let stand: Stand;
let settings: ServerConnection.ISettings;
let kernelId: string;
let kernel: KernelClient;
let registry: ExecutionRegistry;
let sinks: FakeSinkFactory;
let sources: Map<string, string>;
let cellCounter = 0;
let restoreConsole: () => void;

/**
 * `@jupyterlab/services` writes `console.debug("Starting WebSocket: ...")` to
 * **stdout** (spike/NOTES.md §3.4). The real guard lives in `src/jupyter`; the
 * tests install their own so the reporter stays readable.
 */
function interceptConsole(): () => void {
  const original = { log: console.log, info: console.info, debug: console.debug };
  const toStderr = (...args: unknown[]): void => {
    process.stderr.write(`${args.map((a) => String(a)).join(' ')}\n`);
  };
  console.log = toStderr;
  console.info = toStderr;
  console.debug = toStderr;
  return () => {
    console.log = original.log;
    console.info = original.info;
    console.debug = original.debug;
  };
}

const revalidate: Revalidate = (cellId, expected) => {
  const source = sources.get(cellId);
  if (source === undefined) return { ok: false, code: 'cell_not_found' };
  if (sourceRevision('code', source) !== expected) return { ok: false, code: 'revision_conflict' };
  return { ok: true, source, identityToken: `id:${cellId}` };
};

/** Register a cell source and return its `{cellId, sourceRevision}` pair. */
function cell(source: string): { cellId: string; sourceRevision: SourceRevision } {
  cellCounter += 1;
  const cellId = `cell_${cellCounter}`;
  sources.set(cellId, source);
  return { cellId, sourceRevision: sourceRevision('code', source) };
}

async function waitForJob(executionId: string, timeoutMs = 45_000): Promise<JobSnapshot> {
  const deadline = Date.now() + timeoutMs;
  let cursor = -1;
  for (;;) {
    const snapshot = await registry.waitForChange(executionId, cursor, 500);
    cursor = snapshot.cursor;
    if (TERMINAL.includes(snapshot.job.state)) return snapshot;
    if (Date.now() > deadline) {
      throw new Error(`job ${executionId} stuck in ${snapshot.job.state}`);
    }
  }
}

/** Submit one cell and wait for the job to finish. */
async function run(source: string): Promise<{ snapshot: JobSnapshot; sink: FakeSink; cellId: string }> {
  const target = cell(source);
  const executionId = registry.submit({
    notebookRef: NOTEBOOK,
    cells: [target],
    getSink: sinks.begin,
    revalidate
  });
  const snapshot = await waitForJob(executionId);
  const sink = sinks.latest(target.cellId);
  if (sink === undefined) throw new Error(`no sink for ${target.cellId}`);
  return { snapshot, sink, cellId: target.cellId };
}

beforeAll(async () => {
  restoreConsole = interceptConsole();
  stand = await startStand({ port: PORT });
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
  sources = new Map();
  // Warm the kernel up so the first assertion is not about start-up timing.
  await run('1');
}, 180_000);

afterAll(async () => {
  registry?.dispose();
  kernel?.dispose();
  try {
    if (kernelId !== undefined) await KernelAPI.shutdownKernel(kernelId, settings);
  } catch {
    // The kernel may already be gone; the stand is stopped either way.
  }
  await stand?.stop();
  restoreConsole?.();
}, 120_000);

describe('output types', () => {
  it('merges a print loop into one stream output', async () => {
    const { snapshot, sink } = await run('for i in range(3):\n    print("line", i)');
    expect(snapshot.job.state).toBe('succeeded');
    expect(sink.outputs).toEqual([
      { output_type: 'stream', name: 'stdout', text: 'line 0\nline 1\nline 2\n' }
    ]);
    // One append plus updates: never one output per line.
    expect(sink.calls.filter((c) => c.method === 'appendOutput')).toHaveLength(1);
  });

  it('keeps stderr separate from stdout', async () => {
    const { sink } = await run(
      [
        'import sys',
        'print("out")',
        'sys.stdout.flush()',
        'sys.stderr.write("err\\n")',
        'sys.stderr.flush()'
      ].join('\n')
    );
    // ipykernel flushes the two streams independently, so only the split into
    // two named outputs is asserted, not their relative order.
    expect(sink.outputs).toHaveLength(2);
    expect(sink.outputs).toEqual(
      expect.arrayContaining([
        { output_type: 'stream', name: 'stdout', text: 'out\n' },
        { output_type: 'stream', name: 'stderr', text: 'err\n' }
      ])
    );
  });

  it('stores execute_result with its execution_count', async () => {
    const { snapshot, sink } = await run('40 + 2');
    const output = sink.outputs[0] as { output_type: string; data: Record<string, string> };
    expect(output.output_type).toBe('execute_result');
    expect(output.data['text/plain']).toBe('42');
    expect(sink.executionCount).toBe(snapshot.job.cells[0]?.executionCount);
    expect(sink.executionState).toBe('idle');
  });

  it('stores display_data without the transient display_id', async () => {
    const { sink } = await run('from IPython.display import display\ndisplay({"text/plain": "hi"}, raw=True)');
    expect(sink.outputs).toHaveLength(1);
    expect(sink.outputs[0]).toMatchObject({ output_type: 'display_data' });
    expect(JSON.stringify(sink.outputs)).not.toContain('transient');
  });

  it('routes update_display_data from a later cell into the earlier cell', async () => {
    const first = await run(
      'from IPython.display import display\nhandle = display("v1", display_id=True)'
    );
    expect(first.sink.outputs).toHaveLength(1);
    expect(JSON.stringify(first.sink.outputs)).toContain('v1');

    const second = await run('handle.update("v2")');
    expect(second.snapshot.job.state).toBe('succeeded');
    expect(first.sink.outputs).toHaveLength(1);
    expect(JSON.stringify(first.sink.outputs)).toContain('v2');
    // The updating cell writes nothing of its own.
    expect(second.sink.outputs).toEqual([]);
  });

  it('applies clear_output(wait=True) together with the next output', async () => {
    const { sink } = await run(
      [
        'from IPython.display import clear_output',
        'print("before")',
        'clear_output(wait=True)',
        'import time; time.sleep(0.2)',
        'print("after")'
      ].join('\n')
    );
    expect(sink.outputs).toEqual([
      { output_type: 'stream', name: 'stdout', text: 'after\n' }
    ]);
    expect(sink.calls.some((c) => c.method === 'setOutputs')).toBe(true);
  });

  it('stores a traceback exactly once', async () => {
    const { snapshot, sink } = await run('raise RuntimeError("kaboom")');
    expect(snapshot.job.state).toBe('failed');
    expect(snapshot.job.cells[0]?.state).toBe('failed');
    const errors = sink.outputs.filter((o) => o.output_type === 'error');
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ ename: 'RuntimeError', evalue: 'kaboom' });
    expect(Array.isArray((errors[0] as { traceback: unknown }).traceback)).toBe(true);
  });

  it('carries a real PNG through as base64 image/png data', async () => {
    const code = [
      'import struct, zlib',
      'from IPython.display import Image, display',
      'def _chunk(tag, data):',
      '    body = tag + data',
      '    return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body) & 0xffffffff)',
      'w = h = 4',
      'raw = b"".join(b"\\x00" + bytes([255, 0, 0]) * w for _ in range(h))',
      'png = (b"\\x89PNG\\r\\n\\x1a\\n"',
      '    + _chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0))',
      '    + _chunk(b"IDAT", zlib.compress(raw))',
      '    + _chunk(b"IEND", b""))',
      'display(Image(data=png, format="png"))'
    ].join('\n');
    const { snapshot, sink } = await run(code);
    expect(snapshot.job.state).toBe('succeeded');
    const output = sink.outputs[0] as { output_type: string; data: Record<string, string> };
    expect(output.output_type).toBe('display_data');
    const encoded = output.data['image/png'];
    expect(typeof encoded).toBe('string');
    expect(Buffer.from(encoded ?? '', 'base64').subarray(0, 8)).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    );
  });
});

describe('job control', () => {
  it('stops the queue after an error and never sends the next cell', async () => {
    const failing = cell('raise ValueError("stop here")');
    const next = cell('print("must not run")');
    const executionId = registry.submit({
      notebookRef: NOTEBOOK,
      cells: [failing, next],
      getSink: sinks.begin,
      revalidate
    });
    const { job } = await waitForJob(executionId);

    expect(job.state).toBe('failed');
    expect(job.cells[0]?.state).toBe('failed');
    expect(job.cells[1]).toMatchObject({ state: 'not_sent', notSentReason: 'stop_on_error' });
    expect(job.cells[1]?.msgId).toBeUndefined();
    expect(sinks.latest(next.cellId)).toBeUndefined();
  });

  it('a pipelined request after an error is really aborted by the kernel', async () => {
    // The registry never pipelines (SPEC.md §8), so `aborted` - a real kernel
    // answer, as opposed to `not_sent` - is produced here through the client.
    const reducers: ExecutionReducer[] = [];
    const completions: Array<Promise<void>> = [];
    const releases: Array<() => void> = [];
    for (const [index, code] of ['raise ValueError("first")', 'print("second")'].entries()) {
      const sent = kernel.requestExecute(code, { cellId: `pipelined_${index}` });
      const reducer = createExecutionReducer({
        area: {
          notebookId: NOTEBOOK.notebookId,
          cellId: `pipelined_${index}`,
          identityToken: `id:pipelined_${index}`,
          generation: 1
        },
        msgId: sent.msgId,
        displays: kernel.displays
      });
      reducers.push(reducer);
      completions.push(
        new Promise<void>((resolve) => {
          releases.push(
            kernel.registerExecution(sent.msgId, (msg) => {
              for (const effect of reducer.feed(msg)) {
                if (effect.kind === 'complete') resolve();
              }
            })
          );
        })
      );
    }
    await Promise.all(completions);
    for (const release of releases) release();

    expect(reducers[0]?.state.status).toBe('error');
    expect(reducers[1]?.state.status).toBe('aborted');
    expect(reducers[1]?.state.outputs).toEqual([]);
  }, 60_000);

  it('cancel drops the cells that were not sent yet', async () => {
    const slow = cell('import time\ntime.sleep(1.5)\nprint("slow done")');
    const skipped = cell('print("cancelled")');
    const executionId = registry.submit({
      notebookRef: NOTEBOOK,
      cells: [slow, skipped],
      getSink: sinks.begin,
      revalidate
    });
    const cancelled = registry.cancel(executionId);
    expect(cancelled.job.cells[0]?.state).toBe('sent');
    expect(cancelled.job.cells[1]).toMatchObject({
      state: 'not_sent',
      notSentReason: 'cancelled'
    });

    const { job } = await waitForJob(executionId);
    expect(job.state).toBe('cancelled');
    // The already sent cell was never called cancelled; it really ran.
    expect(job.cells[0]?.state).toBe('succeeded');
    expect(sinks.latest(slow.cellId)?.outputs).toEqual([
      { output_type: 'stream', name: 'stdout', text: 'slow done\n' }
    ]);
    expect(sinks.latest(skipped.cellId)).toBeUndefined();
  });

  it('an explicit interrupt ends a long sleep as interrupted', async () => {
    const target = cell('import time\ntime.sleep(30)');
    const executionId = registry.submit({
      notebookRef: NOTEBOOK,
      cells: [target],
      getSink: sinks.begin,
      revalidate
    });
    // Wait until the request is actually in flight, then interrupt the kernel.
    for (let i = 0; i < 100; i += 1) {
      if (registry.get(executionId)?.job.cells[0]?.state === 'sent') break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
    await kernel.interrupt();

    const { job } = await waitForJob(executionId);
    expect(job.state).toBe('interrupted');
    expect(job.cells[0]).toMatchObject({ state: 'aborted', abortedReason: 'interrupted' });
    const outputs = sinks.latest(target.cellId)?.outputs ?? [];
    expect(outputs.filter((o) => o.output_type === 'error')).toHaveLength(1);
    expect(outputs[0]).toMatchObject({ ename: 'KeyboardInterrupt' });
  }, 60_000);

  it('input() fails cleanly with allow_stdin=false instead of hanging', async () => {
    const { snapshot, sink } = await run('value = input("name? ")');
    expect(snapshot.job.state).toBe('failed');
    expect(snapshot.job.cells[0]?.state).toBe('failed');
    const errors = sink.outputs.filter((o) => o.output_type === 'error');
    expect(errors).toHaveLength(1);
    expect((errors[0] as { ename: string }).ename).toContain('StdinNotImplementedError');
  });
});

describe('shared kernel', () => {
  it('a foreign execution moves the status but writes no outputs of ours', async () => {
    // Sent through the same client without registering a route: this is what a
    // browser's execute_request looks like to us (SPEC.md §8).
    kernel.requestExecute('import time\ntime.sleep(0.6)\nprint("foreign")', {
      cellId: 'not-ours'
    });

    let sawBusy = false;
    for (let i = 0; i < 60; i += 1) {
      if (kernel.kernelStatus().execution === 'busy') {
        sawBusy = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(sawBusy).toBe(true);
    expect(kernel.kernelStatus().channel).toBe('connected');

    const { snapshot, sink } = await run('print("mine")');
    expect(snapshot.job.state).toBe('succeeded');
    expect(sink.outputs).toEqual([{ output_type: 'stream', name: 'stdout', text: 'mine\n' }]);
    expect(JSON.stringify(sink.outputs)).not.toContain('foreign');
    for (const record of snapshot.job.cells) {
      expect(JSON.stringify(record.outputsCollected)).not.toContain('foreign');
    }
  }, 60_000);
});
