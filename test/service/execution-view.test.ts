/**
 * The `execution_get` cursor and the bounded `ExecutionView` (SPEC.md §8, §9).
 *
 * The registry is a plain snapshot object here: the point of the file is the
 * mapping - which outputs are inlined, which become snapshots, and that a
 * continuation never resends what was already delivered.
 */

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_SERVICE_LIMITS,
  isCoreError,
  type NbOutput,
  type SourceRevision
} from '../../src/core/index.js';
import type { JobSnapshot } from '../../src/kernel/index.js';
import {
  OutputStore,
  buildExecutionView,
  effectiveLimits,
  makeExecutionCursor,
  parseExecutionCursor,
  type ExecutionRecord
} from '../../src/service/index.js';

const REVISION = `s1_${'A'.repeat(43)}` as SourceRevision;

const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

function outputs(count: number): NbOutput[] {
  const list: NbOutput[] = [];
  for (let n = 0; n < count; n += 1) {
    list.push({ output_type: 'stream', name: 'stdout', text: `line ${n}\n` });
  }
  return list;
}

function snapshotOf(collected: NbOutput[], state = 'succeeded', outputVersion = 0): JobSnapshot {
  return {
    cursor: 7,
    job: {
      executionId: 'exec_1',
      notebookId: 'nb_1',
      sessionId: 'sess_1',
      kernelId: 'kern_1',
      state: state as JobSnapshot['job']['state'],
      stopOnError: true,
      createdAt: '2026-01-01T00:00:00.000Z',
      cells: [
        {
          cellId: 'c1',
          sourceSnapshot: 'print(1)',
          sourceRevision: REVISION,
          msgId: 'msg-1',
          state: 'succeeded',
          outputsCollected: collected,
          sourceChanged: false,
          cellDeleted: false,
          outputIncomplete: false,
          outputAreaLost: false,
          outputVersion,
          executionCount: 3
        }
      ]
    }
  };
}

function recordFor(store: OutputStore): ExecutionRecord {
  return {
    executionId: 'exec_1',
    sessionId: 'sess_1',
    notebookId: 'nb_1',
    kernelId: 'kern_1',
    registry: { get: () => undefined } as unknown as ExecutionRecord['registry'],
    handle: { closed: false } as unknown as ExecutionRecord['handle'],
    createdAt: '2026-01-01T00:00:00.000Z',
    finished: new Map(),
    invalidated: false,
    stop: () => undefined
  };
}

describe('the execution cursor', () => {
  it('round-trips the registry position and the delivered counts', () => {
    const positions = [
      { version: 4, delivered: 3 },
      { version: 0, delivered: 0 },
      { version: 9, delivered: 7 }
    ];
    const cursor = makeExecutionCursor(12, positions);
    expect(parseExecutionCursor(cursor, 3)).toEqual({ registryCursor: 12, positions });
  });

  it('handles a job with no cells', () => {
    expect(parseExecutionCursor(makeExecutionCursor(1, []), 0)).toEqual({
      registryCursor: 1,
      positions: []
    });
  });

  it('CURSOR_EXPIRED for a foreign cursor or the wrong cell count', () => {
    const code = (value: string, cells: number): string => {
      try {
        parseExecutionCursor(value, cells);
      } catch (error) {
        return isCoreError(error) ? error.code : 'other';
      }
      return 'no-error';
    };
    expect(code('pg_x.0', 1)).toBe('CURSOR_EXPIRED');
    expect(
      code(
        makeExecutionCursor(1, [
          { version: 0, delivered: 0 },
          { version: 0, delivered: 0 }
        ]),
        1
      )
    ).toBe('CURSOR_EXPIRED');
    expect(code('exc_x.0', 1)).toBe('CURSOR_EXPIRED');
    expect(code('exc_1.a', 1)).toBe('CURSOR_EXPIRED');
    expect(code('exc_9007199254740992.0:0', 1)).toBe('CURSOR_EXPIRED');
  });
});

describe('effectiveLimits', () => {
  it('a caller may only ask for less than the configured budget', () => {
    const low = effectiveLimits(DEFAULT_SERVICE_LIMITS, { maxCells: 5, maxBytes: 100 });
    expect(low.maxCells).toBe(5);
    expect(low.maxBytes).toBe(100);

    const high = effectiveLimits(DEFAULT_SERVICE_LIMITS, { maxCells: 10_000, maxBytes: 1 << 30 });
    expect(high.maxCells).toBe(DEFAULT_SERVICE_LIMITS.summaryMaxCells);
    expect(high.maxBytes).toBe(DEFAULT_SERVICE_LIMITS.responseMaxBytes);
  });

  it('a missing or nonsensical value falls back to the configured budget', () => {
    const fallback = effectiveLimits(DEFAULT_SERVICE_LIMITS, { maxCells: -1 });
    expect(fallback.maxCells).toBe(DEFAULT_SERVICE_LIMITS.summaryMaxCells);
    expect(effectiveLimits(DEFAULT_SERVICE_LIMITS).maxBytes).toBe(
      DEFAULT_SERVICE_LIMITS.responseMaxBytes
    );
  });
});

describe('buildExecutionView', () => {
  it('inlines what fits and reports the job state as a result', () => {
    const store = new OutputStore('sess_1', 1024 * 1024);
    const view = buildExecutionView(recordFor(store), snapshotOf(outputs(3)), {
      limits: DEFAULT_SERVICE_LIMITS,
      waitTimedOut: false,
      outputs: store
    });
    expect(view.state).toBe('succeeded');
    expect(view.cells[0]?.outputs).toHaveLength(3);
    expect(view.cells[0]?.outputs.every((entry) => entry.truncated === false)).toBe(true);
    expect(view.cells[0]?.executionCount).toBe(3);
    expect(view.lifetime.releasedBy).toContain('session_close');
    expect(store.size).toBe(3);
  });

  it('a payload above the budget becomes a snapshot, never inline base64', () => {
    const store = new OutputStore('sess_1', 1024 * 1024);
    const png: NbOutput = {
      output_type: 'display_data',
      data: { 'image/png': PNG_BASE64, 'text/plain': '<Figure>' },
      metadata: {}
    };
    const view = buildExecutionView(recordFor(store), snapshotOf([png]), {
      limits: DEFAULT_SERVICE_LIMITS,
      requested: { maxOutputBytes: 16 },
      waitTimedOut: false,
      outputs: store
    });
    const entry = view.cells[0]!.outputs[0]!;
    expect(entry.truncated).toBe(true);
    expect(entry.output).toBeUndefined();
    expect(entry.mimeTypes).toEqual(['image/png', 'text/plain']);
    expect(entry.snapshot?.inlineImageAdvised).toBe(true);
    expect(entry.snapshot?.uri.startsWith('jupyter-output://sess_1/')).toBe(true);
    expect(store.size).toBe(1);
  });

  it('the same output read twice reuses one snapshot', () => {
    const store = new OutputStore('sess_1', 1024 * 1024);
    const png: NbOutput = {
      output_type: 'display_data',
      data: { 'image/png': PNG_BASE64 },
      metadata: {}
    };
    const options = {
      limits: DEFAULT_SERVICE_LIMITS,
      requested: { maxOutputBytes: 8 },
      waitTimedOut: false,
      outputs: store
    };
    const first = buildExecutionView(recordFor(store), snapshotOf([png]), options);
    const second = buildExecutionView(recordFor(store), snapshotOf([png]), options);
    expect(second.cells[0]!.outputs[0]!.snapshot?.outputId).toBe(
      first.cells[0]!.outputs[0]!.snapshot?.outputId
    );
    expect(store.size).toBe(1);
  });

  it('publishes an execution view only after retaining every advertised snapshot', () => {
    const store = new OutputStore('sess_1', 1500);
    const view = buildExecutionView(recordFor(store), snapshotOf([
      { output_type: 'stream', name: 'stdout', text: 'x'.repeat(700) },
      { output_type: 'stream', name: 'stdout', text: 'y'.repeat(700) }
    ]), {
      limits: DEFAULT_SERVICE_LIMITS,
      requested: { maxOutputBytes: 1 },
      waitTimedOut: false,
      outputs: store
    });
    const entries = view.cells[0]!.outputs;
    expect(entries).toHaveLength(2);
    expect(entries.map((entry) => store.require(entry.snapshot!.outputId).bytes.toString('utf8'))).toEqual([
      'x'.repeat(700),
      'y'.repeat(700)
    ]);
  });

  it('rejects an execution view whose complete snapshot set cannot be retained', () => {
    const store = new OutputStore('sess_1', 1000);
    expect(() => buildExecutionView(recordFor(store), snapshotOf([
      { output_type: 'stream', name: 'stdout', text: 'x'.repeat(700) },
      { output_type: 'stream', name: 'stdout', text: 'y'.repeat(700) }
    ]), {
      limits: DEFAULT_SERVICE_LIMITS,
      requested: { maxOutputBytes: 1 },
      waitTimedOut: false,
      outputs: store
    })).toThrowError(expect.objectContaining({ code: 'RESOURCE_LIMIT' }));
    expect(store.size).toBe(0);
  });

  it('rejects one execution snapshot larger than the whole store', () => {
    const store = new OutputStore('sess_1', 1000);
    expect(() => buildExecutionView(recordFor(store), snapshotOf([
      { output_type: 'stream', name: 'stdout', text: 'x'.repeat(1001) }
    ]), {
      limits: DEFAULT_SERVICE_LIMITS,
      requested: { maxOutputBytes: 1 },
      waitTimedOut: false,
      outputs: store
    })).toThrowError(expect.objectContaining({ code: 'RESOURCE_LIMIT' }));
    expect(store.size).toBe(0);
  });

  it('a cursor skips the outputs already delivered', () => {
    const store = new OutputStore('sess_1', 1024 * 1024);
    const snapshot = snapshotOf(outputs(5));
    const full = buildExecutionView(recordFor(store), snapshot, {
      limits: DEFAULT_SERVICE_LIMITS,
      waitTimedOut: false,
      outputs: store
    });
    expect(full.cells[0]?.outputs.map((entry) => entry.index)).toEqual([0, 1, 2, 3, 4]);

    const parsed = parseExecutionCursor(full.cursor, 1);
    expect(parsed.positions).toEqual([{ version: 0, delivered: 5 }]);

    const next = buildExecutionView(recordFor(store), snapshot, {
      limits: DEFAULT_SERVICE_LIMITS,
      positions: parsed.positions,
      waitTimedOut: false,
      outputs: store
    });
    expect(next.cells[0]?.outputs).toHaveLength(0);
    expect(parseExecutionCursor(next.cursor, 1).positions).toEqual([
      { version: 0, delivered: 5 }
    ]);
  });

  it('rejects a delivered position past the current output version', () => {
    const store = new OutputStore('sess_1', 1024 * 1024);
    expect(() =>
      buildExecutionView(recordFor(store), snapshotOf(outputs(1), 'succeeded', 3), {
        limits: DEFAULT_SERVICE_LIMITS,
        positions: [{ version: 3, delivered: 2 }],
        waitTimedOut: false,
        outputs: store
      })
    ).toThrowError(/past the current output state/u);
  });

  it('the byte budget cuts the list and says so', () => {
    const store = new OutputStore('sess_1', 1024 * 1024);
    const view = buildExecutionView(recordFor(store), snapshotOf(outputs(20)), {
      limits: DEFAULT_SERVICE_LIMITS,
      requested: { maxBytes: 120 },
      waitTimedOut: false,
      outputs: store
    });
    const cell = view.cells[0]!;
    expect(cell.outputs.length).toBeLessThan(20);
    expect(cell.outputsTruncated).toBe(true);
    // The cursor stops where the answer stopped, so nothing is skipped.
    expect(parseExecutionCursor(view.cursor, 1).positions).toEqual([
      { version: 0, delivered: cell.outputs.length }
    ]);
  });

  it('returns a mutable output again as a replacement after its version changes', () => {
    const store = new OutputStore('sess_1', 1024 * 1024);
    const first = buildExecutionView(recordFor(store), snapshotOf(outputs(1), 'succeeded', 1), {
      limits: DEFAULT_SERVICE_LIMITS,
      waitTimedOut: false,
      outputs: store
    });
    const appended: NbOutput[] = [
      { output_type: 'stream', name: 'stdout', text: 'line 0\nsecond\n' }
    ];
    const next = buildExecutionView(recordFor(store), snapshotOf(appended, 'succeeded', 2), {
      limits: DEFAULT_SERVICE_LIMITS,
      positions: parseExecutionCursor(first.cursor, 1).positions,
      waitTimedOut: false,
      outputs: store
    });
    expect(next.cells[0]?.outputsReset).toBe(true);
    expect(next.cells[0]?.outputs.map((entry) => entry.output)).toEqual(appended);
  });

  it('reports an empty replacement when a later clear removes delivered outputs', () => {
    const store = new OutputStore('sess_1', 1024 * 1024);
    const first = buildExecutionView(recordFor(store), snapshotOf(outputs(2), 'succeeded', 1), {
      limits: DEFAULT_SERVICE_LIMITS,
      waitTimedOut: false,
      outputs: store
    });
    const cleared = buildExecutionView(recordFor(store), snapshotOf([], 'succeeded', 2), {
      limits: DEFAULT_SERVICE_LIMITS,
      positions: parseExecutionCursor(first.cursor, 1).positions,
      waitTimedOut: false,
      outputs: store
    });
    expect(cleared.cells[0]?.outputs).toEqual([]);
    expect(cleared.cells[0]?.outputsReset).toBe(true);
  });
});
