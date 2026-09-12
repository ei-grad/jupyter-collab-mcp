/**
 * Adversarial review of `src/kernel/output-reducer.ts`, kept as a regression
 * suite: the routing guard and the cost of the stream-merge rule.
 */

import { describe, expect, it } from 'vitest';
import { DisplayRegistry } from '../../src/kernel/display-registry.js';
import type { JupyterMessage } from '../../src/kernel/messages.js';
import { createExecutionReducer } from '../../src/kernel/output-reducer.js';

const AREA = { notebookId: 'nb_rev', cellId: 'c1', generation: 1 } as const;

function reducer(maxOutputBytes?: number): ReturnType<typeof createExecutionReducer> {
  return createExecutionReducer({
    area: AREA,
    msgId: 'REQ',
    displays: new DisplayRegistry(),
    ...(maxOutputBytes === undefined ? {} : { maxOutputBytes })
  });
}

/** A message with NO parent header, exactly as a kernel-wide status has. */
function unparented(msgType: string, content: Record<string, unknown>): JupyterMessage {
  return {
    header: { msg_id: `x_${msgType}`, msg_type: msgType },
    parent_header: {},
    content,
    channel: 'iopub'
  };
}

function streamMsg(parent: string, text: string): JupyterMessage {
  return {
    header: { msg_id: 'm', msg_type: 'stream' },
    parent_header: { msg_id: parent },
    content: { name: 'stdout', text },
    channel: 'iopub'
  };
}

describe('routing guard', () => {
  it('an unparented message cannot complete the execution', () => {
    const r = reducer();
    // `ExecutionReducerOptions.msgId` is documented as "used to double-check
    // routing" (src/kernel/output-reducer.ts). A broadcast kernel status and a
    // reply that belong to nobody must not be able to finish our execution.
    r.feed(unparented('status', { execution_state: 'idle' }));
    const effects = r.feed(
      unparented('execute_reply', { status: 'ok', execution_count: 7 })
    );

    expect(r.state.completed).toBe(false);
    expect(effects).toEqual([]);
  });

  it('an unparented stream is never written into our output area', () => {
    const r = reducer();
    const effects = r.feed(unparented('stream', { name: 'stdout', text: 'not ours\n' }));
    expect(effects).toEqual([]);
    expect(r.state.outputs).toEqual([]);
  });
});

describe('stream merge cost (SPEC §8 "One long computation does not block ...")', () => {
  it('merging consecutive stream chunks stays linear in the output size', () => {
    const chunk = `${'x'.repeat(80)}\n`;
    const run = (n: number): number => {
      const r = reducer();
      const msg = streamMsg('REQ', chunk);
      const started = performance.now();
      for (let i = 0; i < n; i += 1) r.feed(msg);
      return performance.now() - started;
    };

    run(200); // warm up the JIT
    const small = run(1500);
    const large = run(3000);

    // Doubling the number of chunks must not quadruple the work. The original
    // `handleStream` re-serialised the whole accumulated text twice per
    // message (`sizeOf(merged) - sizeOf(last)`), which cost O(bytes^2):
    // measured on this machine, 1000 chunks 66ms, 2000 283ms, 4000 1.2s,
    // 8000 4.9s, 16000 19.4s - for only 1.3 MB of stdout, far below
    // DEFAULT_MAX_OUTPUT_BYTES (4 MiB). Only the new chunk is measured now.
    expect(large / Math.max(small, 0.001)).toBeLessThan(3);
  }, 30_000);
});
