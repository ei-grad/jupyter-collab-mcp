/**
 * Unit tests of the job queue (SPEC.md §8 "Jobs" and "Races, interruption,
 * and connection loss"), driven by a scripted fake kernel: no Python process is
 * needed to prove the queue rules, only the protocol.
 */

import { describe, expect, it } from 'vitest';
import { sourceRevision, type SourceRevision } from '../../src/core/index.js';
import { ExecutionRegistry, type Revalidate } from '../../src/kernel/execution-registry.js';
import { FakeKernelClient } from './fake-kernel.js';
import { FakeSinkFactory } from './fake-sink.js';
import * as fx from './fixtures.js';

const NOTEBOOK = { notebookId: 'nb_1', sessionId: 'sess_1' } as const;

function rev(source: string): SourceRevision {
  return sourceRevision('code', source);
}

/** Revalidation over a mutable source table. */
function tableRevalidate(sources: Map<string, string>): Revalidate {
  return (cellId, expected) => {
    const source = sources.get(cellId);
    if (source === undefined) return { ok: false, code: 'cell_not_found' };
    if (rev(source) !== expected) return { ok: false, code: 'revision_conflict' };
    return { ok: true, source, identityToken: `id:${cellId}` };
  };
}

/** Let the queue's microtasks and timers run. */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe('ExecutionRegistry: sequential sending', () => {
  it('sends the next cell only after the previous reply and idle', async () => {
    const kernel = new FakeKernelClient();
    const registry = new ExecutionRegistry(kernel.asKernelClient());
    const sinks = new FakeSinkFactory();
    const sources = new Map([
      ['a', 'print(1)'],
      ['b', 'print(2)']
    ]);

    const id = registry.submit({
      notebookRef: NOTEBOOK,
      cells: [
        { cellId: 'a', sourceRevision: rev('print(1)') },
        { cellId: 'b', sourceRevision: rev('print(2)') }
      ],
      getSink: sinks.begin,
      revalidate: tableRevalidate(sources)
    });

    expect(kernel.sent).toHaveLength(1);
    expect(kernel.sent[0]?.code).toBe('print(1)');
    expect(kernel.sent[0]?.cellId).toBe('a');

    kernel.completeLast(1, [fx.stream(kernel.sent[0]!.msgId, 'stdout', '1\n')]);
    await flush();

    expect(kernel.sent).toHaveLength(2);
    expect(kernel.sent[1]?.code).toBe('print(2)');
    kernel.completeLast(2);
    await flush();

    const snapshot = registry.get(id);
    expect(snapshot?.job.state).toBe('succeeded');
    expect(snapshot?.job.cells.map((c) => c.state)).toEqual(['succeeded', 'succeeded']);
    expect(sinks.latest('a')?.outputs).toEqual([
      { output_type: 'stream', name: 'stdout', text: '1\n' }
    ]);
    registry.dispose();
  });

  it('writes execution_count and idle only at completion', async () => {
    const kernel = new FakeKernelClient();
    const registry = new ExecutionRegistry(kernel.asKernelClient());
    const sinks = new FakeSinkFactory();
    const sources = new Map([['a', 'x']]);

    registry.submit({
      notebookRef: NOTEBOOK,
      cells: [{ cellId: 'a', sourceRevision: rev('x') }],
      getSink: sinks.begin,
      revalidate: tableRevalidate(sources)
    });
    const request = kernel.sent[0]!;
    request.deliver(fx.executeInput(request.msgId, 'x', 11));
    request.deliver(fx.stream(request.msgId, 'stdout', 'partial'));
    await flush();

    const sink = sinks.latest('a')!;
    expect(sink.executionCount).toBeNull();
    expect(sink.calls.some((c) => c.method === 'setExecutionCount')).toBe(false);

    kernel.completeLast(11);
    await flush();
    expect(sink.executionCount).toBe(11);
    expect(sink.executionState).toBe('idle');
    expect(sink.calls.at(-2)).toEqual({ method: 'setExecutionCount', executionCount: 11 });
    expect(sink.calls.at(-1)).toEqual({ method: 'setExecutionState', state: 'idle' });
    registry.dispose();
  });
});

describe('ExecutionRegistry: targets re-checked before sending', () => {
  it('stops the queue when the source moved on, without sending anything', async () => {
    const kernel = new FakeKernelClient();
    const registry = new ExecutionRegistry(kernel.asKernelClient());
    const sinks = new FakeSinkFactory();
    const sources = new Map([
      ['a', 'edited by the user'],
      ['b', 'print(2)']
    ]);

    const id = registry.submit({
      notebookRef: NOTEBOOK,
      cells: [
        { cellId: 'a', sourceRevision: rev('what the agent read') },
        { cellId: 'b', sourceRevision: rev('print(2)') }
      ],
      getSink: sinks.begin,
      revalidate: tableRevalidate(sources)
    });
    await flush();

    expect(kernel.sent).toHaveLength(0);
    const job = registry.get(id)!.job;
    expect(job.state).toBe('failed');
    expect(job.cells[0]).toMatchObject({ state: 'not_sent', notSentReason: 'revision_conflict' });
    expect(job.cells[1]).toMatchObject({ state: 'not_sent', notSentReason: 'stop_on_error' });
    expect(job.reason).toContain('revision_conflict');
    // No output generation was opened for a cell that was never sent.
    expect(sinks.all('a')).toHaveLength(0);
    registry.dispose();
  });

  it('reports a deleted output area as not_sent and cell_deleted', async () => {
    const kernel = new FakeKernelClient();
    const registry = new ExecutionRegistry(kernel.asKernelClient());
    const sinks = new FakeSinkFactory();
    sinks.missing.add('a');

    const id = registry.submit({
      notebookRef: NOTEBOOK,
      cells: [{ cellId: 'a', sourceRevision: rev('x') }],
      getSink: sinks.begin,
      revalidate: tableRevalidate(new Map([['a', 'x']]))
    });
    await flush();

    expect(kernel.sent).toHaveLength(0);
    expect(registry.get(id)?.job.cells[0]).toMatchObject({
      state: 'not_sent',
      notSentReason: 'cell_not_found',
      cellDeleted: true
    });
    registry.dispose();
  });

  it('marks source_changed when the text moved on during the run', async () => {
    const kernel = new FakeKernelClient();
    const registry = new ExecutionRegistry(kernel.asKernelClient());
    const sinks = new FakeSinkFactory();
    const sources = new Map([['a', 'original']]);

    const id = registry.submit({
      notebookRef: NOTEBOOK,
      cells: [{ cellId: 'a', sourceRevision: rev('original') }],
      getSink: sinks.begin,
      revalidate: tableRevalidate(sources)
    });
    sources.set('a', 'the user typed something else');
    kernel.completeLast(1);
    await flush();

    const cell = registry.get(id)!.job.cells[0]!;
    expect(cell.state).toBe('succeeded');
    expect(cell.sourceSnapshot).toBe('original');
    expect(cell.sourceChanged).toBe(true);
    registry.dispose();
  });
});

describe('ExecutionRegistry: stop_on_error, cancel and kernel changes', () => {
  it('stops the queue after a Python error', async () => {
    const kernel = new FakeKernelClient();
    const registry = new ExecutionRegistry(kernel.asKernelClient());
    const sinks = new FakeSinkFactory();
    const sources = new Map([
      ['a', 'raise ValueError()'],
      ['b', 'print(2)']
    ]);

    const id = registry.submit({
      notebookRef: NOTEBOOK,
      cells: [
        { cellId: 'a', sourceRevision: rev('raise ValueError()') },
        { cellId: 'b', sourceRevision: rev('print(2)') }
      ],
      getSink: sinks.begin,
      revalidate: tableRevalidate(sources)
    });
    kernel.failLast(1);
    await flush();

    expect(kernel.sent).toHaveLength(1);
    const job = registry.get(id)!.job;
    expect(job.state).toBe('failed');
    expect(job.cells[0]?.state).toBe('failed');
    expect(job.cells[1]).toMatchObject({ state: 'not_sent', notSentReason: 'stop_on_error' });
    expect(job.cells[0]?.outputsCollected).toHaveLength(1);
    registry.dispose();
  });

  it('cancel removes unsent cells only', async () => {
    const kernel = new FakeKernelClient();
    const registry = new ExecutionRegistry(kernel.asKernelClient());
    const sinks = new FakeSinkFactory();
    const sources = new Map([
      ['a', 'slow()'],
      ['b', 'never()']
    ]);

    const id = registry.submit({
      notebookRef: NOTEBOOK,
      cells: [
        { cellId: 'a', sourceRevision: rev('slow()') },
        { cellId: 'b', sourceRevision: rev('never()') }
      ],
      getSink: sinks.begin,
      revalidate: tableRevalidate(sources)
    });
    expect(kernel.sent).toHaveLength(1);

    const afterCancel = registry.cancel(id);
    expect(afterCancel.job.cells[0]?.state).toBe('sent');
    expect(afterCancel.job.cells[1]).toMatchObject({
      state: 'not_sent',
      notSentReason: 'cancelled'
    });

    kernel.completeLast(1);
    await flush();
    expect(kernel.sent).toHaveLength(1);
    expect(registry.get(id)?.job.state).toBe('cancelled');
    registry.dispose();
  });

  it('cancel before the job starts marks every cell not_sent', async () => {
    const kernel = new FakeKernelClient();
    const registry = new ExecutionRegistry(kernel.asKernelClient());
    const sinks = new FakeSinkFactory();
    const sources = new Map([
      ['a', 'first()'],
      ['b', 'second()']
    ]);
    const revalidate = tableRevalidate(sources);

    const first = registry.submit({
      notebookRef: NOTEBOOK,
      cells: [{ cellId: 'a', sourceRevision: rev('first()') }],
      getSink: sinks.begin,
      revalidate
    });
    const second = registry.submit({
      notebookRef: NOTEBOOK,
      cells: [{ cellId: 'b', sourceRevision: rev('second()') }],
      getSink: sinks.begin,
      revalidate
    });

    const cancelled = registry.cancel(second);
    expect(cancelled.job.state).toBe('cancelled');
    expect(cancelled.job.cells[0]).toMatchObject({
      state: 'not_sent',
      notSentReason: 'cancelled'
    });

    kernel.completeLast(1);
    await flush();
    expect(kernel.sent).toHaveLength(1);
    expect(registry.get(first)?.job.state).toBe('succeeded');
    registry.dispose();
  });

  it('a kernel lifecycle event makes sent work unknown and unsent work not_sent', async () => {
    const kernel = new FakeKernelClient();
    const registry = new ExecutionRegistry(kernel.asKernelClient());
    const sinks = new FakeSinkFactory();
    const sources = new Map([
      ['a', 'a()'],
      ['b', 'b()']
    ]);

    const id = registry.submit({
      notebookRef: NOTEBOOK,
      cells: [
        { cellId: 'a', sourceRevision: rev('a()') },
        { cellId: 'b', sourceRevision: rev('b()') }
      ],
      getSink: sinks.begin,
      revalidate: tableRevalidate(sources)
    });
    kernel.emitKernelChanged('restarting');
    await flush();

    const job = registry.get(id)!.job;
    expect(job.state).toBe('unknown');
    expect(job.cells[0]?.state).toBe('unknown');
    expect(job.cells[1]).toMatchObject({ state: 'not_sent', notSentReason: 'kernel_changed' });
    expect(kernel.sent).toHaveLength(1);
    registry.dispose();
  });

  it('a lost channel after sending makes the cell unknown, not failed', async () => {
    const kernel = new FakeKernelClient();
    const registry = new ExecutionRegistry(kernel.asKernelClient());
    const sinks = new FakeSinkFactory();

    const id = registry.submit({
      notebookRef: NOTEBOOK,
      cells: [{ cellId: 'a', sourceRevision: rev('a()') }],
      getSink: sinks.begin,
      revalidate: tableRevalidate(new Map([['a', 'a()']]))
    });
    kernel.emitDisconnected();
    await flush();

    const job = registry.get(id)!.job;
    expect(job.state).toBe('unknown');
    expect(job.cells[0]?.state).toBe('unknown');
    expect(job.reason).toContain('channel');
    registry.dispose();
  });
});

describe('ExecutionRegistry: output area ownership and waiting', () => {
  it('keeps results on the job when the output area is no longer ours', async () => {
    const kernel = new FakeKernelClient();
    const registry = new ExecutionRegistry(kernel.asKernelClient());
    const sinks = new FakeSinkFactory();

    const id = registry.submit({
      notebookRef: NOTEBOOK,
      cells: [{ cellId: 'a', sourceRevision: rev('a()') }],
      getSink: sinks.begin,
      revalidate: tableRevalidate(new Map([['a', 'a()']]))
    });
    const request = kernel.sent[0]!;
    const sink = sinks.latest('a')!;
    request.deliver(fx.stream(request.msgId, 'stdout', 'before\n'));
    sink.current = false; // a newer generation, a clear, or a deletion
    request.deliver(fx.stream(request.msgId, 'stdout', 'after\n'));
    kernel.completeLast(1);
    await flush();

    const cell = registry.get(id)!.job.cells[0]!;
    expect(cell.outputAreaLost).toBe(true);
    expect(cell.outputsCollected).toEqual([
      { output_type: 'stream', name: 'stdout', text: 'before\nafter\n' }
    ]);
    expect(sink.outputs).toEqual([{ output_type: 'stream', name: 'stdout', text: 'before\n' }]);
    registry.dispose();
  });

  it('waitForChange returns at once when the cursor is behind, and wakes on change', async () => {
    const kernel = new FakeKernelClient();
    const registry = new ExecutionRegistry(kernel.asKernelClient());
    const sinks = new FakeSinkFactory();

    const id = registry.submit({
      notebookRef: NOTEBOOK,
      cells: [{ cellId: 'a', sourceRevision: rev('a()') }],
      getSink: sinks.begin,
      revalidate: tableRevalidate(new Map([['a', 'a()']]))
    });

    const immediate = await registry.waitForChange(id, 0, 5_000);
    expect(immediate.cursor).toBeGreaterThan(0);

    const pending = registry.waitForChange(id, immediate.cursor, 5_000);
    const request = kernel.sent[0]!;
    request.deliver(fx.stream(request.msgId, 'stdout', 'tick'));
    const woken = await pending;
    expect(woken.cursor).toBeGreaterThan(immediate.cursor);
    expect(woken.job.cells[0]?.outputsCollected).toHaveLength(1);
    expect(woken.job.cells[0]?.outputVersion).toBe(1);

    request.deliver(fx.stream(request.msgId, 'stdout', ' tock'));
    const appended = registry.get(id)!;
    expect(appended.job.cells[0]?.outputsCollected).toEqual([
      { output_type: 'stream', name: 'stdout', text: 'tick tock' }
    ]);
    expect(appended.job.cells[0]?.outputVersion).toBe(2);

    kernel.completeLast(1);
    await flush();
    registry.dispose();
  });

  it('waitForChange times out without blocking other jobs', async () => {
    const kernel = new FakeKernelClient();
    const registry = new ExecutionRegistry(kernel.asKernelClient());
    const sinks = new FakeSinkFactory();

    const id = registry.submit({
      notebookRef: NOTEBOOK,
      cells: [{ cellId: 'a', sourceRevision: rev('a()') }],
      getSink: sinks.begin,
      revalidate: tableRevalidate(new Map([['a', 'a()']]))
    });
    const start = registry.get(id)!.cursor;
    const started = Date.now();
    const snapshot = await registry.waitForChange(id, start, 30);
    expect(Date.now() - started).toBeGreaterThanOrEqual(20);
    expect(snapshot.cursor).toBe(start);

    kernel.completeLast(1);
    await flush();
    expect(registry.get(id)?.job.state).toBe('succeeded');
    registry.dispose();
  });
});
