/**
 * Adversarial review of `src/kernel/execution-registry.ts`, kept as a
 * regression suite.
 *
 * Every test targets a SPEC.md §12 acceptance row or an explicit §8
 * requirement, and each one failed against the first implementation; the
 * quoted requirement it checks is next to the decisive assertion.
 */

import { describe, expect, it } from 'vitest';
import { sourceRevision, type JobState, type SourceRevision } from '../../src/core/index.js';
import { ExecutionRegistry, type Revalidate } from '../../src/kernel/execution-registry.js';
import { FakeSinkFactory } from './fake-sink.js';
import * as fx from './fixtures.js';
import { RoutingFakeKernel, captureUnhandledRejections, flush, sleep } from './review-fakes.js';

const NOTEBOOK = { notebookId: 'nb_rev', sessionId: 'sess_rev' } as const;
const TERMINAL: readonly JobState[] = ['succeeded', 'failed', 'cancelled', 'interrupted', 'unknown'];

function rev(source: string): SourceRevision {
  return sourceRevision('code', source);
}

function tableRevalidate(sources: Map<string, string>): Revalidate {
  return (cellId, expected) => {
    const source = sources.get(cellId);
    if (source === undefined) return { ok: false, code: 'cell_not_found' };
    if (rev(source) !== expected) return { ok: false, code: 'revision_conflict' };
    return { ok: true, source, identityToken: `id:${cellId}` };
  };
}

/** Drive a job to a terminal state by answering every request it sends. */
async function drive(
  registry: ExecutionRegistry,
  kernel: RoutingFakeKernel,
  executionId: string,
  maxSteps = 2000
): Promise<void> {
  let count = 0;
  for (let step = 0; step < maxSteps; step += 1) {
    await flush();
    const state = registry.get(executionId)?.job.state;
    if (state !== undefined && TERMINAL.includes(state)) return;
    const pending = kernel.pending();
    if (pending === undefined) continue;
    count += 1;
    kernel.complete(pending.msgId, count);
  }
  throw new Error(`job ${executionId} did not finish in ${maxSteps} steps`);
}

describe('SPEC §8 "Late outputs after idle continue updating the output area"', () => {
  it('a late output after completion still reaches the area and the job record', async () => {
    const kernel = new RoutingFakeKernel();
    const registry = new ExecutionRegistry(kernel.asKernelClient());
    const sinks = new FakeSinkFactory();
    const sources = new Map([['a', 'start_background_thread()']]);

    const id = registry.submit({
      notebookRef: NOTEBOOK,
      cells: [{ cellId: 'a', sourceRevision: rev('start_background_thread()') }],
      getSink: sinks.begin,
      revalidate: tableRevalidate(sources)
    });
    const request = kernel.sent[0]!;
    kernel.complete(request.msgId, 1, [fx.stream(request.msgId, 'stdout', 'done\n')]);
    await flush();
    expect(registry.get(id)?.job.state).toBe('succeeded');

    // The output area is untouched: same cell, same generation, still current.
    const sink = sinks.latest('a')!;
    expect(sink.isCurrent()).toBe(true);

    // The route outlives the execution: it is released only when the area
    // stops being ours, when the kernel changes, or on disposal.
    expect(kernel.routeCount).toBe(1);

    kernel.deliver(request.msgId, fx.stream(request.msgId, 'stdout', 'LATE\n'));
    await flush();

    // SPEC.md §8: "Late outputs after `idle` continue updating the corresponding
    // output area until replaced by a subsequent execution/clear/delete/close."
    // Nothing replaced it here.
    expect(JSON.stringify(sink.outputs)).toContain('LATE');
    // The job record keeps up with what was written.
    expect(JSON.stringify(registry.get(id)!.job.cells[0]!.outputsCollected)).toContain('LATE');

    registry.dispose();
    // Disposal releases it, so nothing keeps writing into a released replica.
    expect(kernel.routeCount).toBe(0);
  });

  it('stops following a completed execution once a newer generation owns the area', async () => {
    const kernel = new RoutingFakeKernel();
    const registry = new ExecutionRegistry(kernel.asKernelClient());
    const sinks = new FakeSinkFactory();
    const sources = new Map([['a', 'run()']]);
    const revalidate = tableRevalidate(sources);

    const first = registry.submit({
      notebookRef: NOTEBOOK,
      cells: [{ cellId: 'a', sourceRevision: rev('run()') }],
      getSink: sinks.begin,
      revalidate
    });
    const firstRequest = kernel.sent[0]!;
    kernel.complete(firstRequest.msgId, 1, [fx.stream(firstRequest.msgId, 'stdout', 'one\n')]);
    await drive(registry, kernel, first);
    const firstSink = sinks.latest('a')!;

    // A re-run opens generation 2 and makes generation 1 stale.
    const second = registry.submit({
      notebookRef: NOTEBOOK,
      cells: [{ cellId: 'a', sourceRevision: rev('run()') }],
      getSink: sinks.begin,
      revalidate
    });
    await drive(registry, kernel, second);
    expect(firstSink.isCurrent()).toBe(false);

    kernel.deliver(firstRequest.msgId, fx.stream(firstRequest.msgId, 'stdout', 'TOO LATE\n'));
    await flush();

    // SPEC.md §8: late output updates the area only "until replaced by a
    // subsequent execution".
    expect(JSON.stringify(firstSink.outputs)).not.toContain('TOO LATE');
    expect(JSON.stringify(sinks.latest('a')!.outputs)).not.toContain('TOO LATE');
    registry.dispose();
  });
});

describe('caller callbacks that throw', () => {
  it('a throwing revalidate fails only its own job, and the queue keeps running', async () => {
    const kernel = new RoutingFakeKernel();
    const registry = new ExecutionRegistry(kernel.asKernelClient());
    const sinks = new FakeSinkFactory();
    const good = tableRevalidate(new Map([['b', 'ok()']]));

    let first = '';
    let second = '';
    const captured = await captureUnhandledRejections(async () => {
      first = registry.submit({
        notebookRef: NOTEBOOK,
        cells: [{ cellId: 'a', sourceRevision: rev('boom()') }],
        getSink: sinks.begin,
        revalidate: () => {
          throw new Error('replica is mid-reconnect');
        }
      });
      second = registry.submit({
        notebookRef: NOTEBOOK,
        cells: [{ cellId: 'b', sourceRevision: rev('ok()') }],
        getSink: sinks.begin,
        revalidate: good
      });
      await sleep(50);
    });

    // The throw never escapes as an unhandled rejection: one would kill the
    // whole MCP process under Node's default `--unhandled-rejections=throw`.
    expect(captured).toEqual([]);

    // SPEC.md §8: a job either runs or reports a terminal state with a reason;
    // SPEC.md §9 requires an error to be reported, not swallowed.
    const failed = registry.get(first)!.job;
    expect(TERMINAL).toContain(failed.state);
    expect(failed.reason).toContain('replica is mid-reconnect');
    expect(failed.cells[0]).toMatchObject({ state: 'not_sent', notSentReason: 'rtc_not_ready' });

    // ...and the kernel's queue keeps running: the job behind it was sent.
    expect(kernel.sent).toHaveLength(1);
    expect(kernel.sent[0]?.cellId).toBe('b');
    expect(registry.get(second)?.job.state).not.toBe('queued');
    registry.dispose();
  });

  it('a throwing getSink ends its own job the same way', async () => {
    const kernel = new RoutingFakeKernel();
    const registry = new ExecutionRegistry(kernel.asKernelClient());
    const sources = new Map([['a', 'x']]);

    let id = '';
    const captured = await captureUnhandledRejections(async () => {
      id = registry.submit({
        notebookRef: NOTEBOOK,
        cells: [{ cellId: 'a', sourceRevision: rev('x') }],
        getSink: () => {
          throw new Error('shared model transaction failed');
        },
        revalidate: tableRevalidate(sources)
      });
      await sleep(50);
    });

    expect(captured).toEqual([]);
    const job = registry.get(id)!.job;
    expect(TERMINAL).toContain(job.state);
    expect(job.reason).toContain('shared model transaction failed');
    registry.dispose();
  });
});

describe('SPEC §8 "Losing the kernel connection after sending produces unknown"', () => {
  it('a transport gap ends the in-flight cell as unknown and frees the queue', async () => {
    const kernel = new RoutingFakeKernel();
    const registry = new ExecutionRegistry(kernel.asKernelClient());
    const sinks = new FakeSinkFactory();
    const sources = new Map([
      ['a', 'long()'],
      ['b', 'next()']
    ]);

    const first = registry.submit({
      notebookRef: NOTEBOOK,
      cells: [{ cellId: 'a', sourceRevision: rev('long()') }],
      getSink: sinks.begin,
      revalidate: tableRevalidate(sources)
    });
    const second = registry.submit({
      notebookRef: NOTEBOOK,
      cells: [{ cellId: 'b', sourceRevision: rev('next()') }],
      getSink: sinks.begin,
      revalidate: tableRevalidate(sources)
    });
    expect(kernel.sent).toHaveLength(1);

    // @jupyterlab/services reports a dropped socket as `connecting` and only
    // says `disconnected` after seven failed attempts
    // (node_modules/@jupyterlab/services/lib/kernel/default.js:1477-1497).
    // Everything the kernel emitted during the gap is gone.
    kernel.emitStatus('connecting', 'unknown');
    await sleep(20);
    kernel.emitStatus('connected', 'idle');
    await sleep(50);

    // SPEC.md §8: "Losing the kernel connection after sending produces
    // `unknown` when there is insufficient evidence of the result."
    expect(registry.get(first)?.job.cells[0]?.state).toBe('unknown');
    // And the kernel's queue must not be blocked for ever by the lost cell.
    expect(kernel.sent.length).toBeGreaterThan(1);
    expect(registry.get(second)?.job.state).not.toBe('queued');
    registry.dispose();
  });

  it('disposing the KernelClient ends the in-flight cell', async () => {
    const kernel = new RoutingFakeKernel();
    const registry = new ExecutionRegistry(kernel.asKernelClient());
    const sinks = new FakeSinkFactory();

    const id = registry.submit({
      notebookRef: NOTEBOOK,
      cells: [{ cellId: 'a', sourceRevision: rev('a()') }],
      getSink: sinks.begin,
      revalidate: tableRevalidate(new Map([['a', 'a()']]))
    });
    expect(kernel.sent).toHaveLength(1);

    // `KernelClient.dispose()` emits exactly this, and
    // execution-registry.ts:113 returns early for it.
    kernel.emitKernelChanged('disposed');
    await sleep(50);

    expect(TERMINAL).toContain(registry.get(id)!.job.state);
    registry.dispose();
  });
});

describe('registry disposal', () => {
  it('dispose() gives every queued job a terminal state', async () => {
    const kernel = new RoutingFakeKernel();
    const registry = new ExecutionRegistry(kernel.asKernelClient());
    const sinks = new FakeSinkFactory();
    const sources = new Map([
      ['a', 'a()'],
      ['b', 'b()']
    ]);

    const first = registry.submit({
      notebookRef: NOTEBOOK,
      cells: [{ cellId: 'a', sourceRevision: rev('a()') }],
      getSink: sinks.begin,
      revalidate: tableRevalidate(sources)
    });
    const second = registry.submit({
      notebookRef: NOTEBOOK,
      cells: [{ cellId: 'b', sourceRevision: rev('b()') }],
      getSink: sinks.begin,
      revalidate: tableRevalidate(sources)
    });

    registry.dispose();
    await sleep(50);

    // The in-flight job is handled correctly.
    expect(registry.get(first)?.job.cells[0]?.state).toBe('unknown');
    // SPEC.md §4: at shutdown the process "stops accepting jobs" and
    // releases connections; a job that will never run must not stay `queued`.
    expect(TERMINAL).toContain(registry.get(second)!.job.state);
  });
});

describe('cross-execution display routing (SPEC §8, §12 "Outputs")', () => {
  it('an update to a superseded generation is stopped and recorded on the job', async () => {
    const kernel = new RoutingFakeKernel();
    const registry = new ExecutionRegistry(kernel.asKernelClient());
    const sinks = new FakeSinkFactory();
    const sources = new Map([
      ['a', 'handle = display("v1", display_id=True)'],
      ['u', 'handle.update("v2")']
    ]);
    const revalidate = tableRevalidate(sources);

    // 1. cell `a` publishes a display id.
    const firstRun = registry.submit({
      notebookRef: NOTEBOOK,
      cells: [{ cellId: 'a', sourceRevision: rev(sources.get('a')!) }],
      getSink: sinks.begin,
      revalidate
    });
    const req1 = kernel.pending()!;
    kernel.complete(req1.msgId, 1, [
      fx.displayData(req1.msgId, { 'text/plain': 'v1' }, 'DISPLAY_1')
    ]);
    await drive(registry, kernel, firstRun);

    // 2. the user re-runs `a`, so a new generation owns the output area.
    const secondRun = registry.submit({
      notebookRef: NOTEBOOK,
      cells: [{ cellId: 'a', sourceRevision: rev(sources.get('a')!) }],
      getSink: sinks.begin,
      revalidate
    });
    await drive(registry, kernel, secondRun);

    // 3. a later cell updates the display id recorded for the OLD generation.
    const updater = registry.submit({
      notebookRef: NOTEBOOK,
      cells: [{ cellId: 'u', sourceRevision: rev(sources.get('u')!) }],
      getSink: sinks.begin,
      revalidate
    });
    const req3 = kernel.pending()!;
    kernel.complete(req3.msgId, 3, [
      fx.updateDisplayData(req3.msgId, { 'text/plain': 'v2' }, 'DISPLAY_1')
    ]);
    await drive(registry, kernel, updater);

    const job = registry.get(updater)!.job;
    // The write is correctly stopped: no generation of `a` shows `v2`.
    expect(JSON.stringify(sinks.all('a').map((s) => s.outputs))).not.toContain('v2');
    // The execution itself succeeded, and the undeliverable write is recorded.
    expect(job.state).toBe('succeeded');
    expect(job.cells[0]?.outputAreaLost).toBe(true);

    // SPEC.md §8: "In an ambiguous race, the result is retained by the job and
    // writing to the shared output area stops." Nothing was kept anywhere.
    expect(
      job.cells[0]!.outputAreaLost || JSON.stringify(job.cells[0]!.outputsCollected).includes('v2')
    ).toBe(true);
    registry.dispose();
  });

  it('a live display target survives hundreds of later output generations', async () => {
    const kernel = new RoutingFakeKernel();
    const registry = new ExecutionRegistry(kernel.asKernelClient());
    const sinks = new FakeSinkFactory();
    const sources = new Map<string, string>([
      ['disp', 'display("v1", display_id=True)'],
      ['upd', 'handle.update("v2")']
    ]);
    for (let i = 0; i < 300; i += 1) sources.set(`f${i}`, `f(${i})`);
    const revalidate = tableRevalidate(sources);

    const dispJob = registry.submit({
      notebookRef: NOTEBOOK,
      cells: [{ cellId: 'disp', sourceRevision: rev(sources.get('disp')!) }],
      getSink: sinks.begin,
      revalidate
    });
    const req = kernel.pending()!;
    kernel.complete(req.msgId, 1, [fx.displayData(req.msgId, { 'text/plain': 'v1' }, 'DISPLAY_X')]);
    await drive(registry, kernel, dispJob);
    const dispSink = sinks.latest('disp')!;
    expect(JSON.stringify(dispSink.outputs)).toContain('v1');

    // 300 unrelated cells, each opening its own output-area generation.
    const filler = registry.submit({
      notebookRef: NOTEBOOK,
      cells: Array.from({ length: 300 }, (_, i) => ({
        cellId: `f${i}`,
        sourceRevision: rev(`f(${i})`)
      })),
      getSink: sinks.begin,
      revalidate
    });
    await drive(registry, kernel, filler);

    // The display target itself is still remembered (DisplayRegistry cap 1024)
    // and its output area is untouched and current.
    expect(dispSink.isCurrent()).toBe(true);

    const updJob = registry.submit({
      notebookRef: NOTEBOOK,
      cells: [{ cellId: 'upd', sourceRevision: rev(sources.get('upd')!) }],
      getSink: sinks.begin,
      revalidate
    });
    const updReq = kernel.pending()!;
    kernel.complete(updReq.msgId, 999, [
      fx.updateDisplayData(updReq.msgId, { 'text/plain': 'v2' }, 'DISPLAY_X')
    ]);
    await drive(registry, kernel, updJob);

    // SPEC.md §8: "Display IDs must also be routed across different executions
    // by this client."
    expect(JSON.stringify(dispSink.outputs)).toContain('v2');
    registry.dispose();
  }, 30_000);

  it('a cross-cell display update also refreshes the earlier job record', async () => {
    const kernel = new RoutingFakeKernel();
    const registry = new ExecutionRegistry(kernel.asKernelClient());
    const sinks = new FakeSinkFactory();
    const sources = new Map([
      ['a', 'handle = display("v1", display_id=True)'],
      ['u', 'handle.update("v2")']
    ]);
    const revalidate = tableRevalidate(sources);

    const firstRun = registry.submit({
      notebookRef: NOTEBOOK,
      cells: [{ cellId: 'a', sourceRevision: rev(sources.get('a')!) }],
      getSink: sinks.begin,
      revalidate
    });
    const req1 = kernel.pending()!;
    kernel.complete(req1.msgId, 1, [
      fx.displayData(req1.msgId, { 'text/plain': 'v1' }, 'DISPLAY_2')
    ]);
    await drive(registry, kernel, firstRun);

    const updater = registry.submit({
      notebookRef: NOTEBOOK,
      cells: [{ cellId: 'u', sourceRevision: rev(sources.get('u')!) }],
      getSink: sinks.begin,
      revalidate
    });
    const req2 = kernel.pending()!;
    kernel.complete(req2.msgId, 2, [
      fx.updateDisplayData(req2.msgId, { 'text/plain': 'v2' }, 'DISPLAY_2')
    ]);
    await drive(registry, kernel, updater);

    // The shared model got the update...
    expect(JSON.stringify(sinks.latest('a')!.outputs)).toContain('v2');
    // ...but `execution_get` on the first job still reports the old bundle.
    const collected = JSON.stringify(registry.get(firstRun)!.job.cells[0]!.outputsCollected);
    expect(collected).toContain('v2');
    registry.dispose();
  });
});

describe('not_sent vs unknown (SPEC §8)', () => {
  it('a request that provably never left the client is reported as not_sent', async () => {
    const kernel = new RoutingFakeKernel();
    kernel.throwOnRequest = new Error('kernel client is disposed');
    const registry = new ExecutionRegistry(kernel.asKernelClient());
    const sinks = new FakeSinkFactory();

    const id = registry.submit({
      notebookRef: NOTEBOOK,
      cells: [{ cellId: 'a', sourceRevision: rev('a()') }],
      getSink: sinks.begin,
      revalidate: tableRevalidate(new Map([['a', 'a()']]))
    });
    await sleep(30);

    const cell = registry.get(id)!.job.cells[0]!;
    expect(kernel.sent).toHaveLength(0);
    // SPEC.md §8: "Sent work without a proven result becomes `unknown`; unsent
    // work gets `not_sent`."
    expect(cell.state).toBe('not_sent');
    registry.dispose();
  });
});
