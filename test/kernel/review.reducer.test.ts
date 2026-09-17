/** Output routing and stream-merge resource-limit coverage. */

import { describe, expect, it } from 'vitest';
import { DisplayRegistry } from '../../src/kernel/display-registry.js';
import type { JupyterMessage } from '../../src/kernel/messages.js';
import { createExecutionReducer } from '../../src/kernel/output-reducer.js';

const AREA = {
  notebookId: 'nb_rev',
  cellId: 'c1',
  identityToken: 'id:c1',
  generation: 1
} as const;

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
  it('emits only delta-sized effects while the accumulated output grows', () => {
    const chunk = `${'x'.repeat(80)}\n`;
    const count = 3_000;
    const r = reducer();
    const msg = streamMsg('REQ', chunk);
    let deliveredTextBytes = 0;
    for (let index = 0; index < count; index += 1) {
      const effects = r.feed(msg);
      expect(effects).toHaveLength(1);
      const effect = effects[0]!;
      if (effect.kind === 'append') {
        expect(effect.output.output_type).toBe('stream');
        deliveredTextBytes += chunk.length;
      } else {
        expect(effect.kind).toBe('appendStream');
        if (effect.kind === 'appendStream') deliveredTextBytes += effect.text.length;
      }
    }

    expect(deliveredTextBytes).toBe(count * chunk.length);
    const output = r.state.outputs[0];
    expect(output?.output_type).toBe('stream');
    if (output?.output_type === 'stream') {
      const text = typeof output.text === 'string' ? output.text : output.text.join('');
      expect(text.length).toBe(count * chunk.length);
    }
  });
});
