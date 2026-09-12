/**
 * Hand-written Jupyter protocol fixtures for the pure reducer tests.
 *
 * They are written by hand on purpose: the reducer must be provable without a
 * kernel, and both legal orders of `execute_reply` / IOPub `idle` have to be
 * expressible (SPEC.md §8, SPEC.md §12 "Execution completion").
 */

import type { JupyterMessage } from '../../src/kernel/messages.js';

let counter = 0;

/** Unique message id, so a fixture never collides with another. */
export function nextMsgId(prefix = 'msg'): string {
  counter += 1;
  return `${prefix}_${counter}`;
}

function make(
  msgType: string,
  parentMsgId: string,
  content: Record<string, unknown>,
  channel: string
): JupyterMessage {
  return {
    header: { msg_id: nextMsgId(msgType), msg_type: msgType, session: 'sess', version: '5.3' },
    parent_header: { msg_id: parentMsgId, msg_type: 'execute_request' },
    metadata: {},
    content,
    channel
  };
}

export function executeInput(parent: string, code: string, executionCount: number): JupyterMessage {
  return make('execute_input', parent, { code, execution_count: executionCount }, 'iopub');
}

export function stream(parent: string, name: 'stdout' | 'stderr', text: string): JupyterMessage {
  return make('stream', parent, { name, text }, 'iopub');
}

export function executeResult(
  parent: string,
  data: Record<string, unknown>,
  executionCount: number,
  displayId?: string
): JupyterMessage {
  return make(
    'execute_result',
    parent,
    {
      data,
      metadata: {},
      execution_count: executionCount,
      ...(displayId === undefined ? {} : { transient: { display_id: displayId } })
    },
    'iopub'
  );
}

export function displayData(
  parent: string,
  data: Record<string, unknown>,
  displayId?: string,
  metadata: Record<string, unknown> = {}
): JupyterMessage {
  return make(
    'display_data',
    parent,
    {
      data,
      metadata,
      ...(displayId === undefined ? {} : { transient: { display_id: displayId } })
    },
    'iopub'
  );
}

export function updateDisplayData(
  parent: string,
  data: Record<string, unknown>,
  displayId: string
): JupyterMessage {
  return make(
    'update_display_data',
    parent,
    { data, metadata: {}, transient: { display_id: displayId } },
    'iopub'
  );
}

export function errorMsg(
  parent: string,
  ename: string,
  evalue: string,
  traceback: string[] = ['Traceback (most recent call last):', `${ename}: ${evalue}`]
): JupyterMessage {
  return make('error', parent, { ename, evalue, traceback }, 'iopub');
}

export function clearOutput(parent: string, wait: boolean): JupyterMessage {
  return make('clear_output', parent, { wait }, 'iopub');
}

export function status(
  parent: string,
  state: 'busy' | 'idle' | 'starting'
): JupyterMessage {
  return make('status', parent, { execution_state: state }, 'iopub');
}

export function executeReplyOk(parent: string, executionCount: number): JupyterMessage {
  return make(
    'execute_reply',
    parent,
    { status: 'ok', execution_count: executionCount, user_expressions: {}, payload: [] },
    'shell'
  );
}

export function executeReplyError(
  parent: string,
  executionCount: number,
  ename = 'ValueError',
  evalue = 'boom',
  traceback: string[] = ['Traceback', `${ename}: ${evalue}`]
): JupyterMessage {
  return make(
    'execute_reply',
    parent,
    { status: 'error', execution_count: executionCount, ename, evalue, traceback },
    'shell'
  );
}

export function executeReplyAborted(parent: string, executionCount: number): JupyterMessage {
  return make('execute_reply', parent, { status: 'aborted', execution_count: executionCount }, 'shell');
}

/** A comm message: it must not break the stream (SPEC.md §8). */
export function commOpen(parent: string): JupyterMessage {
  return make('comm_open', parent, { comm_id: 'c1', target_name: 'x', data: {} }, 'iopub');
}
