/**
 * Unit tests of the pure output reducer (SPEC.md §8, §12 "Outputs" and
 * "Execution completion"). No kernel, no shared model: everything is driven by
 * hand-written protocol fixtures from `./fixtures.ts`.
 */

import { describe, expect, it } from 'vitest';
import { DisplayRegistry, type OutputAreaRef } from '../../src/kernel/display-registry.js';
import {
  createExecutionReducer,
  type ExecutionReducer,
  type ReducerEffect
} from '../../src/kernel/output-reducer.js';
import type { JupyterMessage } from '../../src/kernel/messages.js';
import * as fx from './fixtures.js';

const AREA: OutputAreaRef = { notebookId: 'nb_1', cellId: 'cell_a', generation: 1 };

function reducerFor(
  msgId: string,
  options: { displays?: DisplayRegistry; area?: OutputAreaRef; maxOutputBytes?: number } = {}
): ExecutionReducer {
  return createExecutionReducer({
    area: options.area ?? AREA,
    msgId,
    displays: options.displays ?? new DisplayRegistry(),
    ...(options.maxOutputBytes === undefined ? {} : { maxOutputBytes: options.maxOutputBytes })
  });
}

function feedAll(reducer: ExecutionReducer, messages: readonly JupyterMessage[]): ReducerEffect[] {
  return messages.flatMap((msg) => reducer.feed(msg));
}

describe('createExecutionReducer: single message types', () => {
  it('takes execution_count from execute_input but publishes nothing while running', () => {
    const parent = fx.nextMsgId('req');
    const reducer = reducerFor(parent);
    const effects = reducer.feed(fx.executeInput(parent, 'print(1)', 7));
    expect(effects).toEqual([]);
    expect(reducer.state.executionCount).toBe(7);
    expect(reducer.state.completed).toBe(false);
  });

  it('appends a stream output', () => {
    const parent = fx.nextMsgId('req');
    const reducer = reducerFor(parent);
    const effects = reducer.feed(fx.stream(parent, 'stdout', 'hello\n'));
    expect(effects).toEqual([
      { kind: 'append', target: AREA, output: { output_type: 'stream', name: 'stdout', text: 'hello\n' } }
    ]);
  });

  it('merges consecutive same-name stream outputs into one output', () => {
    const parent = fx.nextMsgId('req');
    const reducer = reducerFor(parent);
    const effects = feedAll(reducer, [
      fx.stream(parent, 'stdout', 'a\n'),
      fx.stream(parent, 'stdout', 'b\n'),
      fx.stream(parent, 'stdout', 'c\n')
    ]);
    expect(effects.map((e) => e.kind)).toEqual(['append', 'update', 'update']);
    expect(reducer.state.outputs).toEqual([
      { output_type: 'stream', name: 'stdout', text: 'a\nb\nc\n' }
    ]);
  });

  it('does not merge across stream names', () => {
    const parent = fx.nextMsgId('req');
    const reducer = reducerFor(parent);
    feedAll(reducer, [
      fx.stream(parent, 'stdout', 'out'),
      fx.stream(parent, 'stderr', 'err'),
      fx.stream(parent, 'stdout', 'out2')
    ]);
    expect(reducer.state.outputs).toEqual([
      { output_type: 'stream', name: 'stdout', text: 'out' },
      { output_type: 'stream', name: 'stderr', text: 'err' },
      { output_type: 'stream', name: 'stdout', text: 'out2' }
    ]);
  });

  it('accepts nbformat list-of-lines text', () => {
    const parent = fx.nextMsgId('req');
    const reducer = reducerFor(parent);
    const msg: JupyterMessage = {
      header: { msg_id: 'm', msg_type: 'stream' },
      parent_header: { msg_id: parent },
      content: { name: 'stdout', text: ['a\n', 'b\n'] }
    };
    reducer.feed(msg);
    expect(reducer.state.outputs).toEqual([
      { output_type: 'stream', name: 'stdout', text: 'a\nb\n' }
    ]);
  });

  it('stores execute_result without transient', () => {
    const parent = fx.nextMsgId('req');
    const reducer = reducerFor(parent);
    reducer.feed(fx.executeResult(parent, { 'text/plain': '42' }, 3, 'd1'));
    expect(reducer.state.outputs).toEqual([
      { output_type: 'execute_result', data: { 'text/plain': '42' }, metadata: {}, execution_count: 3 }
    ]);
    expect(JSON.stringify(reducer.state.outputs)).not.toContain('transient');
  });

  it('stores display_data with metadata and without transient', () => {
    const parent = fx.nextMsgId('req');
    const reducer = reducerFor(parent);
    reducer.feed(
      fx.displayData(parent, { 'image/png': 'AAA' }, 'd1', { 'image/png': { width: 10 } })
    );
    expect(reducer.state.outputs).toEqual([
      {
        output_type: 'display_data',
        data: { 'image/png': 'AAA' },
        metadata: { 'image/png': { width: 10 } }
      }
    ]);
  });

  it('ignores comm and other unknown message types', () => {
    const parent = fx.nextMsgId('req');
    const reducer = reducerFor(parent);
    expect(reducer.feed(fx.commOpen(parent))).toEqual([]);
    expect(reducer.state.outputs).toEqual([]);
  });

  it('ignores a message routed to another execution', () => {
    const parent = fx.nextMsgId('req');
    const reducer = reducerFor(parent);
    expect(reducer.feed(fx.stream(fx.nextMsgId('other'), 'stdout', 'x'))).toEqual([]);
    expect(reducer.state.outputs).toEqual([]);
  });
});

describe('createExecutionReducer: clear_output', () => {
  it('clears immediately when wait is false', () => {
    const parent = fx.nextMsgId('req');
    const reducer = reducerFor(parent);
    reducer.feed(fx.stream(parent, 'stdout', 'old'));
    const effects = reducer.feed(fx.clearOutput(parent, false));
    expect(effects).toEqual([{ kind: 'clear', target: AREA }]);
    expect(reducer.state.outputs).toEqual([]);
  });

  it('defers a wait=true clear until the next output, then replaces in one step', () => {
    const parent = fx.nextMsgId('req');
    const reducer = reducerFor(parent);
    reducer.feed(fx.stream(parent, 'stdout', 'old'));
    expect(reducer.feed(fx.clearOutput(parent, true))).toEqual([]);
    expect(reducer.state.outputs).toHaveLength(1);
    expect(reducer.state.clearPending).toBe(true);

    const effects = reducer.feed(fx.stream(parent, 'stdout', 'new'));
    expect(effects).toEqual([
      {
        kind: 'replace',
        target: AREA,
        outputs: [{ output_type: 'stream', name: 'stdout', text: 'new' }]
      }
    ]);
    expect(reducer.state.outputs).toEqual([
      { output_type: 'stream', name: 'stdout', text: 'new' }
    ]);
    expect(reducer.state.clearPending).toBe(false);
  });

  it('does not merge a stream across a pending clear', () => {
    const parent = fx.nextMsgId('req');
    const reducer = reducerFor(parent);
    reducer.feed(fx.stream(parent, 'stdout', 'a'));
    reducer.feed(fx.clearOutput(parent, true));
    reducer.feed(fx.stream(parent, 'stdout', 'b'));
    expect(reducer.state.outputs).toEqual([{ output_type: 'stream', name: 'stdout', text: 'b' }]);
  });

  it('a pending clear that never fires leaves the outputs alone', () => {
    const parent = fx.nextMsgId('req');
    const reducer = reducerFor(parent);
    reducer.feed(fx.stream(parent, 'stdout', 'a'));
    reducer.feed(fx.clearOutput(parent, true));
    reducer.feed(fx.executeReplyOk(parent, 1));
    reducer.feed(fx.status(parent, 'idle'));
    expect(reducer.state.outputs).toHaveLength(1);
  });
});

describe('createExecutionReducer: display ids', () => {
  it('update_display_data rewrites the registered output of the same cell', () => {
    const displays = new DisplayRegistry();
    const parent = fx.nextMsgId('req');
    const reducer = reducerFor(parent, { displays });
    reducer.feed(fx.stream(parent, 'stdout', 'noise'));
    reducer.feed(fx.displayData(parent, { 'text/plain': 'v1' }, 'd42'));
    const effects = reducer.feed(fx.updateDisplayData(parent, { 'text/plain': 'v2' }, 'd42'));

    expect(effects).toEqual([
      {
        kind: 'update',
        target: { ...AREA, index: 1 },
        output: { output_type: 'display_data', data: { 'text/plain': 'v2' }, metadata: {} }
      }
    ]);
    expect(reducer.state.outputs[1]).toEqual({
      output_type: 'display_data',
      data: { 'text/plain': 'v2' },
      metadata: {}
    });
  });

  it('routes an update from a later execution to an earlier cell', () => {
    const displays = new DisplayRegistry();
    const firstArea: OutputAreaRef = { notebookId: 'nb_1', cellId: 'cell_a', generation: 1 };
    const secondArea: OutputAreaRef = { notebookId: 'nb_1', cellId: 'cell_b', generation: 1 };

    const first = fx.nextMsgId('req');
    const firstReducer = createExecutionReducer({ area: firstArea, msgId: first, displays });
    firstReducer.feed(fx.displayData(first, { 'text/plain': 'v1' }, 'shared'));

    const second = fx.nextMsgId('req');
    const secondReducer = createExecutionReducer({ area: secondArea, msgId: second, displays });
    const effects = secondReducer.feed(fx.updateDisplayData(second, { 'text/plain': 'v2' }, 'shared'));

    expect(effects).toEqual([
      {
        kind: 'update',
        target: { ...firstArea, index: 0 },
        output: { output_type: 'display_data', data: { 'text/plain': 'v2' }, metadata: {} }
      }
    ]);
    // The other cell's local copy is not this reducer's business.
    expect(secondReducer.state.outputs).toEqual([]);
  });

  it('updates every place one display id was shown', () => {
    const displays = new DisplayRegistry();
    const parent = fx.nextMsgId('req');
    const reducer = reducerFor(parent, { displays });
    reducer.feed(fx.displayData(parent, { 'text/plain': 'v1' }, 'dup'));
    reducer.feed(fx.displayData(parent, { 'text/plain': 'v1' }, 'dup'));
    const effects = reducer.feed(fx.updateDisplayData(parent, { 'text/plain': 'v2' }, 'dup'));
    expect(effects).toHaveLength(2);
    expect(reducer.state.outputs.every((o) => JSON.stringify(o).includes('v2'))).toBe(true);
  });

  it('an unknown display id produces no effect', () => {
    const parent = fx.nextMsgId('req');
    const reducer = reducerFor(parent);
    expect(reducer.feed(fx.updateDisplayData(parent, { 'text/plain': 'x' }, 'nope'))).toEqual([]);
  });

  it('a clear forgets the display targets of that generation', () => {
    const displays = new DisplayRegistry();
    const parent = fx.nextMsgId('req');
    const reducer = reducerFor(parent, { displays });
    reducer.feed(fx.displayData(parent, { 'text/plain': 'v1' }, 'gone'));
    reducer.feed(fx.clearOutput(parent, false));
    expect(displays.resolve('gone')).toEqual([]);
  });
});

describe('createExecutionReducer: errors and completion', () => {
  it('stores the traceback exactly once when reply and IOPub both report it', () => {
    const parent = fx.nextMsgId('req');
    const reducer = reducerFor(parent);
    feedAll(reducer, [
      fx.errorMsg(parent, 'ValueError', 'boom'),
      fx.executeReplyError(parent, 4),
      fx.status(parent, 'idle')
    ]);
    const errors = reducer.state.outputs.filter((o) => o.output_type === 'error');
    expect(errors).toHaveLength(1);
    expect(errors[0]).toEqual({
      output_type: 'error',
      ename: 'ValueError',
      evalue: 'boom',
      traceback: ['Traceback (most recent call last):', 'ValueError: boom']
    });
    expect(reducer.state.status).toBe('error');
  });

  it('stores the reply traceback when IOPub never sent an error', () => {
    const parent = fx.nextMsgId('req');
    const reducer = reducerFor(parent);
    feedAll(reducer, [fx.executeReplyError(parent, 4), fx.status(parent, 'idle')]);
    expect(reducer.state.outputs).toEqual([
      {
        output_type: 'error',
        ename: 'ValueError',
        evalue: 'boom',
        traceback: ['Traceback', 'ValueError: boom']
      }
    ]);
  });

  it('reports aborted for an aborted reply', () => {
    const parent = fx.nextMsgId('req');
    const reducer = reducerFor(parent);
    feedAll(reducer, [fx.executeReplyAborted(parent, 0), fx.status(parent, 'idle')]);
    expect(reducer.state.status).toBe('aborted');
    expect(reducer.state.outputs).toEqual([]);
  });

  it('needs both reply and idle, and then publishes count and idle together', () => {
    const parent = fx.nextMsgId('req');
    const reducer = reducerFor(parent);
    reducer.feed(fx.executeInput(parent, 'x', 9));
    expect(reducer.feed(fx.status(parent, 'busy'))).toEqual([]);
    expect(reducer.feed(fx.stream(parent, 'stdout', 'x')).map((e) => e.kind)).toEqual(['append']);
    expect(reducer.feed(fx.executeReplyOk(parent, 9))).toEqual([]);
    expect(reducer.state.completed).toBe(false);

    const effects = reducer.feed(fx.status(parent, 'idle'));
    expect(effects).toEqual([
      { kind: 'setCount', target: AREA, executionCount: 9 },
      { kind: 'setState', target: AREA, state: 'idle' },
      { kind: 'complete', target: AREA, status: 'ok', executionCount: 9 }
    ]);
    expect(reducer.state.completed).toBe(true);
  });

  it('completes only once even if idle repeats', () => {
    const parent = fx.nextMsgId('req');
    const reducer = reducerFor(parent);
    feedAll(reducer, [fx.executeReplyOk(parent, 1), fx.status(parent, 'idle')]);
    expect(reducer.feed(fx.status(parent, 'idle'))).toEqual([]);
  });

  it('keeps applying late outputs after idle', () => {
    const parent = fx.nextMsgId('req');
    const reducer = reducerFor(parent);
    feedAll(reducer, [fx.executeReplyOk(parent, 1), fx.status(parent, 'idle')]);
    const late = reducer.feed(fx.stream(parent, 'stdout', 'from a thread'));
    expect(late.map((e) => e.kind)).toEqual(['append']);
    expect(reducer.state.outputs).toHaveLength(1);
  });

  it('carries the error name into the complete effect', () => {
    const parent = fx.nextMsgId('req');
    const reducer = reducerFor(parent);
    const effects = feedAll(reducer, [
      fx.errorMsg(parent, 'KeyboardInterrupt', ''),
      fx.executeReplyError(parent, 2, 'KeyboardInterrupt', ''),
      fx.status(parent, 'idle')
    ]);
    const complete = effects.find((e) => e.kind === 'complete');
    expect(complete).toMatchObject({ status: 'error', errorName: 'KeyboardInterrupt' });
  });
});

describe('createExecutionReducer: completion order is irrelevant', () => {
  /** The full message set of one execution, minus the two completion signals. */
  function body(parent: string): JupyterMessage[] {
    return [
      fx.status(parent, 'busy'),
      fx.executeInput(parent, 'code', 5),
      fx.stream(parent, 'stdout', 'a\n'),
      fx.stream(parent, 'stdout', 'b\n'),
      fx.displayData(parent, { 'text/plain': 'v1' }, 'p1'),
      fx.updateDisplayData(parent, { 'text/plain': 'v2' }, 'p1'),
      fx.stream(parent, 'stderr', 'warn\n'),
      fx.executeResult(parent, { 'text/plain': '42' }, 5)
    ];
  }

  function run(order: 'reply-first' | 'idle-first'): ReducerEffect[] {
    const parent = 'req_fixed';
    const reducer = reducerFor(parent, { displays: new DisplayRegistry() });
    const tail =
      order === 'reply-first'
        ? [fx.executeReplyOk(parent, 5), fx.status(parent, 'idle')]
        : [fx.status(parent, 'idle'), fx.executeReplyOk(parent, 5)];
    const effects = feedAll(reducer, [...body(parent), ...tail]);
    // Attach the final state to the assertion by returning both.
    lastState = reducer.state.outputs;
    return effects;
  }

  let lastState: unknown = null;

  it('produces identical outputs and identical completion effects', () => {
    const replyFirst = run('reply-first');
    const replyFirstOutputs = lastState;
    const idleFirst = run('idle-first');
    const idleFirstOutputs = lastState;

    expect(idleFirstOutputs).toEqual(replyFirstOutputs);
    expect(replyFirstOutputs).toEqual([
      { output_type: 'stream', name: 'stdout', text: 'a\nb\n' },
      { output_type: 'display_data', data: { 'text/plain': 'v2' }, metadata: {} },
      { output_type: 'stream', name: 'stderr', text: 'warn\n' },
      { output_type: 'execute_result', data: { 'text/plain': '42' }, metadata: {}, execution_count: 5 }
    ]);

    const completion = (effects: ReducerEffect[]): ReducerEffect[] =>
      effects.filter((e) => e.kind === 'setCount' || e.kind === 'setState' || e.kind === 'complete');
    expect(completion(idleFirst)).toEqual(completion(replyFirst));
    // The whole effect stream is identical too: only the trailing pair moves.
    expect(idleFirst).toEqual(replyFirst);
  });
});

describe('createExecutionReducer: output budget', () => {
  it('marks output_incomplete, stops storing and still completes', () => {
    const parent = fx.nextMsgId('req');
    const reducer = reducerFor(parent, { maxOutputBytes: 200 });
    const effects = feedAll(reducer, [
      fx.stream(parent, 'stdout', 'x'.repeat(80)),
      fx.displayData(parent, { 'image/png': 'y'.repeat(4096) }),
      fx.stream(parent, 'stderr', 'z'.repeat(4096))
    ]);
    expect(effects.map((e) => e.kind)).toEqual(['append']);
    expect(reducer.state.outputIncomplete).toBe(true);
    expect(reducer.state.outputs).toHaveLength(1);

    const done = feedAll(reducer, [fx.executeReplyOk(parent, 1), fx.status(parent, 'idle')]);
    expect(done.map((e) => e.kind)).toEqual(['setCount', 'setState', 'complete']);
    expect(reducer.state.completed).toBe(true);
  });
});
