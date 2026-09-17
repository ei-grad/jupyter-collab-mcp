/**
 * Pure reducer from Jupyter protocol messages to output-area commands.
 *
 * One reducer instance serves exactly one `execute_request` (SPEC.md §8:
 * "Each local execution has exactly one writer"). It never touches the
 * shared model: it emits {@link ReducerEffect}s shaped like `OutputSink` calls,
 * and `ExecutionRegistry` decides whether the sink still owns the output area.
 *
 * Input is the set of messages already routed to this execution by
 * `parent_header.msg_id`: the shell `execute_reply` and the IOPub
 * `execute_input`, `stream`, `execute_result`, `display_data`,
 * `update_display_data`, `error`, `clear_output` and `status`.
 *
 * Rules implemented here, all from SPEC.md §8 unless noted:
 *
 * - consecutive `stream` outputs with the same `name` are merged into one
 *   nbformat output, as JupyterLab's `OutputAreaModel` does, so a `print` loop
 *   does not produce one output per line;
 * - `clear_output(wait=false)` clears immediately; `wait=true` defers the clear
 *   until the next output arrives and is then applied together with it, as one
 *   `replace`, so the cell never flickers empty;
 * - `update_display_data` writes into every output registered under that
 *   `display_id`, including outputs of earlier executions and other cells; the
 *   effect carries the full target (cell + generation + index);
 * - `transient.display_id` is routing data and is stripped from what is stored;
 * - the `error` output is stored exactly once - an `execute_reply` with
 *   `status: "error"` never duplicates the IOPub `error`;
 * - completion requires **both** `execute_reply` and IOPub `status: idle`, in
 *   either order;
 * - `execution_count` is taken from `execute_input` when present, otherwise
 *   from the reply, and is emitted only at completion, together with
 *   `execution_state: idle`: publishing it earlier makes JupyterLab 4.6.3 write
 *   `execution_state: 'idle'` back into the shared document and drop `[*]`;
 * - once the collected bytes pass the budget the reducer stops storing output
 *   but keeps tracking completion, and marks `outputIncomplete` (SPEC.md §9).
 *
 * Late outputs after `idle` keep updating the area: SPEC.md §8 requires it, and
 * staleness is the sink's decision, not the reducer's.
 *
 * @module
 */

import type { NbErrorOutput, NbOutput, NbStreamOutput, SharedExecutionState } from '../core/types.js';
import {
  sameOutputArea,
  type DisplayRegistry,
  type DisplayTarget,
  type OutputAreaRef
} from './display-registry.js';
import {
  contentBoolean,
  contentNumber,
  contentString,
  contentWithoutTransient,
  joinText,
  parentMsgId,
  transientDisplayId,
  type JupyterMessage
} from './messages.js';

/** Terminal classification of one execution (SPEC.md §8). */
export type ReducerStatus = 'running' | 'ok' | 'error' | 'aborted';

/** Commands for an `OutputSink`, produced by {@link ExecutionReducer.feed}. */
export type ReducerEffect =
  | { readonly kind: 'append'; readonly target: OutputAreaRef; readonly output: NbOutput }
  | { readonly kind: 'appendStream'; readonly target: DisplayTarget; readonly text: string }
  | { readonly kind: 'update'; readonly target: DisplayTarget; readonly output: NbOutput }
  | { readonly kind: 'replace'; readonly target: OutputAreaRef; readonly outputs: readonly NbOutput[] }
  | { readonly kind: 'clear'; readonly target: OutputAreaRef }
  | {
      readonly kind: 'setCount';
      readonly target: OutputAreaRef;
      readonly executionCount: number | null;
    }
  | {
      readonly kind: 'setState';
      readonly target: OutputAreaRef;
      readonly state: SharedExecutionState;
    }
  | {
      readonly kind: 'complete';
      readonly target: OutputAreaRef;
      readonly status: Exclude<ReducerStatus, 'running'>;
      readonly executionCount: number | null;
      /** `ename` of the stored error output, when there was one. */
      readonly errorName?: string;
    };

/** Observable state of one execution (SPEC.md §8). */
export interface ReducerState {
  readonly area: OutputAreaRef;
  /** `execute_request` header id this reducer is routed by. */
  readonly msgId: string;
  /** Outputs as this client believes the area should look. */
  readonly outputs: readonly NbOutput[];
  readonly executionCount: number | null;
  readonly replySeen: boolean;
  readonly idleSeen: boolean;
  /** `replySeen && idleSeen` has happened at least once. */
  readonly completed: boolean;
  readonly status: ReducerStatus;
  /** An `error` output is already stored; the reply must not duplicate it. */
  readonly errorSeen: boolean;
  readonly errorName?: string;
  /** A `clear_output(wait=true)` is waiting for the next output. */
  readonly clearPending: boolean;
  /** Collection hit {@link ExecutionReducerOptions.maxOutputBytes}. */
  readonly outputIncomplete: boolean;
  /** Approximate stored size, in bytes of canonical JSON. */
  readonly outputBytes: number;
}

/** Default output budget of one execution (SPEC.md §9: "output_incomplete"). */
export const DEFAULT_MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

/** Construction arguments of one execution reducer (SPEC.md §8). */
export interface ExecutionReducerOptions {
  /** The output area this execution owns. */
  readonly area: OutputAreaRef;
  /**
   * `execute_request` header id. Every fed message must name it as its
   * `parent_header.msg_id`; anything else is ignored (defence in depth behind
   * `KernelClient`'s own routing).
   */
  readonly msgId: string;
  /** Per-kernel display routing table, shared across executions and cells. */
  readonly displays: DisplayRegistry;
  /** Byte budget; default {@link DEFAULT_MAX_OUTPUT_BYTES}. */
  readonly maxOutputBytes?: number;
}

/** What {@link createExecutionReducer} returns. */
export interface ExecutionReducer {
  /** Consume one routed message and return the resulting sink commands. */
  feed(msg: JupyterMessage): ReducerEffect[];
  /** Keep the owner's cache aligned with a cross-execution display update. */
  replaceOutput(index: number, output: NbOutput): boolean;
  /** Current state snapshot. */
  readonly state: ReducerState;
}

function sizeOf(output: NbOutput): number {
  try {
    return JSON.stringify(output)?.length ?? 0;
  } catch {
    return 0;
  }
}

/**
 * How much longer the JSON of a string gets when `text` is appended to it.
 *
 * JSON string escaping is per code unit, so the encoded lengths of two strings
 * add up: `|JSON(a + b)| === |JSON(a)| + |JSON(b)| - 2` (the two quotes are
 * counted once). That identity is what keeps the stream-merge rule linear: the
 * accumulated text is never re-serialised, only the new chunk is (SPEC.md §8,
 * "One long computation does not block reads, RTC updates, or kernel
 * control"). The only inexact case is a surrogate pair split across two chunks,
 * where the estimate is 10 characters high; the value is a budget estimate,
 * not a wire size.
 */
function appendedJsonLength(text: string): number {
  try {
    return (JSON.stringify(text)?.length ?? 2) - 2;
  } catch {
    return 0;
  }
}

function isStream(output: NbOutput | undefined): output is NbStreamOutput {
  return output !== undefined && output.output_type === 'stream';
}

/**
 * Create a reducer for one execution (SPEC.md §8). The instance is pure with
 * respect to the outside world apart from the shared {@link DisplayRegistry},
 * which is by design: display routing spans executions.
 */
export function createExecutionReducer(options: ExecutionReducerOptions): ExecutionReducer {
  const area = options.area;
  const displays = options.displays;
  const maxBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;

  let outputs: NbOutput[] = [];
  let executionCount: number | null = null;
  let replySeen = false;
  let idleSeen = false;
  let completed = false;
  let status: ReducerStatus = 'running';
  let errorSeen = false;
  let errorName: string | undefined;
  let clearPending = false;
  let outputIncomplete = false;
  let outputBytes = 0;

  /** Apply a deferred `clear_output(wait=true)`, if one is armed. */
  function takeDeferredClear(): boolean {
    if (!clearPending) return false;
    clearPending = false;
    outputs = [];
    outputBytes = 0;
    displays.forgetGeneration(
      area.notebookId,
      area.cellId,
      area.identityToken,
      area.generation
    );
    return true;
  }

  function budgetExceeded(extra: number): boolean {
    if (outputBytes + extra <= maxBytes) return false;
    outputIncomplete = true;
    return true;
  }

  /** Append one output, honouring a pending clear and the byte budget. */
  function addOutput(output: NbOutput, displayId: string | undefined): ReducerEffect[] {
    const cleared = takeDeferredClear();
    const extra = sizeOf(output);
    if (budgetExceeded(extra)) {
      // Still emit the pending clear: dropping it would leave the previous
      // generation's output on screen forever.
      return cleared ? [{ kind: 'clear', target: area }] : [];
    }
    outputs.push(output);
    outputBytes += extra;
    if (displayId !== undefined) {
      displays.register(displayId, { ...area, index: outputs.length - 1 });
    }
    if (cleared) return [{ kind: 'replace', target: area, outputs: [...outputs] }];
    return [{ kind: 'append', target: area, output }];
  }

  function handleStream(msg: JupyterMessage): ReducerEffect[] {
    const name = contentString(msg, 'name') === 'stderr' ? 'stderr' : 'stdout';
    const text = joinText(msg.content['text']);
    const last = outputs[outputs.length - 1];
    // Merge only when no clear is pending: a pending clear ends the run.
    if (!clearPending && isStream(last) && last.name === name) {
      // Only the new chunk is measured: re-serialising the accumulated text
      // here would make a `print` loop quadratic in its own output.
      const delta = appendedJsonLength(text);
      if (budgetExceeded(delta)) return [];
      const merged: NbStreamOutput = { output_type: 'stream', name, text: joinText(last.text) + text };
      outputs[outputs.length - 1] = merged;
      outputBytes += delta;
      return [{ kind: 'appendStream', target: { ...area, index: outputs.length - 1 }, text }];
    }
    return addOutput({ output_type: 'stream', name, text }, undefined);
  }

  function handleDisplayLike(msg: JupyterMessage, type: 'execute_result' | 'display_data'): ReducerEffect[] {
    const body = contentWithoutTransient(msg);
    const output = { output_type: type, ...body } as unknown as NbOutput;
    return addOutput(output, transientDisplayId(msg));
  }

  function handleUpdateDisplay(msg: JupyterMessage): ReducerEffect[] {
    const displayId = transientDisplayId(msg);
    if (displayId === undefined) return [];
    const body = contentWithoutTransient(msg);
    const output = { output_type: 'display_data', ...body } as unknown as NbOutput;
    const effects: ReducerEffect[] = [];
    for (const target of displays.resolve(displayId)) {
      if (sameOutputArea(target, area)) {
        const previous = outputs[target.index];
        if (previous === undefined) continue;
        const delta = sizeOf(output) - sizeOf(previous);
        if (budgetExceeded(delta)) continue;
        outputs[target.index] = output;
        outputBytes += delta;
      }
      effects.push({ kind: 'update', target, output });
    }
    return effects;
  }

  function handleError(msg: JupyterMessage): ReducerEffect[] {
    status = 'error';
    if (errorSeen) return [];
    const traceback = Array.isArray(msg.content['traceback'])
      ? (msg.content['traceback'] as unknown[]).map((line) => String(line))
      : [];
    const output: NbErrorOutput = {
      output_type: 'error',
      ename: contentString(msg, 'ename') ?? 'Error',
      evalue: contentString(msg, 'evalue') ?? '',
      traceback
    };
    errorSeen = true;
    errorName = output.ename;
    return addOutput(output, undefined);
  }

  function handleClearOutput(msg: JupyterMessage): ReducerEffect[] {
    if (contentBoolean(msg, 'wait') === true) {
      clearPending = true;
      return [];
    }
    clearPending = false;
    outputs = [];
    outputBytes = 0;
    outputIncomplete = false;
    displays.forgetGeneration(
      area.notebookId,
      area.cellId,
      area.identityToken,
      area.generation
    );
    return [{ kind: 'clear', target: area }];
  }

  function handleReply(msg: JupyterMessage): ReducerEffect[] {
    replySeen = true;
    const replyStatus = contentString(msg, 'status');
    const count = contentNumber(msg, 'execution_count');
    if (count !== undefined && executionCount === null) executionCount = count;
    if (replyStatus === 'aborted') {
      status = 'aborted';
      return maybeComplete();
    }
    if (replyStatus === 'error') {
      status = 'error';
      // The traceback is stored exactly once: only when IOPub never sent one.
      if (!errorSeen) {
        const effects = handleError(msg);
        return [...effects, ...maybeComplete()];
      }
      return maybeComplete();
    }
    if (status === 'running') status = 'ok';
    return maybeComplete();
  }

  function maybeComplete(): ReducerEffect[] {
    if (completed || !replySeen || !idleSeen) return [];
    completed = true;
    const finalStatus: Exclude<ReducerStatus, 'running'> = status === 'running' ? 'ok' : status;
    status = finalStatus;
    const complete: ReducerEffect =
      errorName === undefined
        ? { kind: 'complete', target: area, status: finalStatus, executionCount }
        : { kind: 'complete', target: area, status: finalStatus, executionCount, errorName };
    return [
      { kind: 'setCount', target: area, executionCount },
      { kind: 'setState', target: area, state: 'idle' satisfies SharedExecutionState },
      complete
    ];
  }

  function feed(msg: JupyterMessage): ReducerEffect[] {
    // Routing guard: only a message that names our `execute_request` as its
    // parent may touch this execution. An unparented message - a kernel-wide
    // broadcast `status`, for instance - is not ours either, so it can neither
    // complete the execution nor write into the output area (SPEC.md §4,
    // "routing by `parent_header.msg_id`"; §12 "Shared kernel").
    if (parentMsgId(msg) !== options.msgId) return [];
    switch (msg.header.msg_type) {
      case 'execute_input': {
        const count = contentNumber(msg, 'execution_count');
        // Preferred source of the count, but never published while running.
        if (count !== undefined) executionCount = count;
        return [];
      }
      case 'stream':
        return handleStream(msg);
      case 'execute_result':
        return handleDisplayLike(msg, 'execute_result');
      case 'display_data':
        return handleDisplayLike(msg, 'display_data');
      case 'update_display_data':
        return handleUpdateDisplay(msg);
      case 'error':
        return handleError(msg);
      case 'clear_output':
        return handleClearOutput(msg);
      case 'status': {
        if (contentString(msg, 'execution_state') !== 'idle') return [];
        idleSeen = true;
        return maybeComplete();
      }
      case 'execute_reply':
        return handleReply(msg);
      default:
        // comm_open/comm_msg and anything else must not break the stream.
        return [];
    }
  }

  return {
    feed,
    replaceOutput(index: number, output: NbOutput): boolean {
      const previous = outputs[index];
      if (previous === undefined) return false;
      outputs[index] = output;
      outputBytes += sizeOf(output) - sizeOf(previous);
      return true;
    },
    get state(): ReducerState {
      const base = {
        area,
        msgId: options.msgId,
        outputs: [...outputs],
        executionCount,
        replySeen,
        idleSeen,
        completed,
        status,
        errorSeen,
        clearPending,
        outputIncomplete,
        outputBytes
      };
      return errorName === undefined ? base : { ...base, errorName };
    }
  };
}
