/**
 * Structural view of the Jupyter messaging protocol, used by `src/kernel`.
 *
 * The reducer must stay pure and testable from hand-written fixtures, so it
 * does not import `@jupyterlab/services` types: those are interfaces without
 * index signatures and are not assignable to plain records. `KernelClient` is
 * the single place that converts a library message into this shape
 * ({@link fromKernelMessage}).
 *
 * Message semantics follow the Jupyter messaging spec referenced by
 * SPEC.md §8 ("The output handler must support stream, execute_result,
 * display_data, error, clear_output(wait), and update_display_data").
 *
 * @module
 */

/** Jupyter message header (SPEC.md §8). */
export interface JupyterHeader {
  readonly msg_id: string;
  readonly msg_type: string;
  readonly session?: string;
  readonly username?: string;
  readonly date?: string;
  readonly version?: string;
}

/**
 * One Jupyter message. `parent_header` is what routes an IOPub or shell
 * message to a single execution (SPEC.md §4: "routing by
 * `parent_header.msg_id`").
 */
export interface JupyterMessage {
  readonly header: JupyterHeader;
  readonly parent_header?: Partial<JupyterHeader> | Record<string, never>;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly content: Readonly<Record<string, unknown>>;
  readonly channel?: string;
  readonly buffers?: readonly unknown[];
}

/** Message types the output reducer understands (SPEC.md §8). */
export type OutputMsgType =
  | 'execute_input'
  | 'stream'
  | 'execute_result'
  | 'display_data'
  | 'update_display_data'
  | 'error'
  | 'clear_output'
  | 'status'
  | 'execute_reply';

/** `parent_header.msg_id`, or `undefined` for an unparented message. */
export function parentMsgId(msg: JupyterMessage): string | undefined {
  const parent = msg.parent_header as Partial<JupyterHeader> | undefined;
  const id = parent?.msg_id;
  return typeof id === 'string' && id.length > 0 ? id : undefined;
}

/**
 * Reinterpret a `@jupyterlab/services` message as a {@link JupyterMessage}.
 *
 * The cast is safe by construction (the wire format is the same JSON) and is
 * deliberately confined to this one function so that nothing else in
 * `src/kernel` depends on the library's type shapes.
 */
export function fromKernelMessage(msg: unknown): JupyterMessage {
  return msg as JupyterMessage;
}

/** Read a string field of `content`, or `undefined`. */
export function contentString(msg: JupyterMessage, key: string): string | undefined {
  const value = msg.content[key];
  return typeof value === 'string' ? value : undefined;
}

/** Read a finite number field of `content`, or `undefined`. */
export function contentNumber(msg: JupyterMessage, key: string): number | undefined {
  const value = msg.content[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** Read a boolean field of `content`; `undefined` when absent or not boolean. */
export function contentBoolean(msg: JupyterMessage, key: string): boolean | undefined {
  const value = msg.content[key];
  return typeof value === 'boolean' ? value : undefined;
}

/** Read an object field of `content` as a plain record, or `undefined`. */
export function contentRecord(
  msg: JupyterMessage,
  key: string
): Readonly<Record<string, unknown>> | undefined {
  const value = msg.content[key];
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return value as Readonly<Record<string, unknown>>;
}

/**
 * `content.transient.display_id`, which is routing information and must never
 * be stored as an ordinary nbformat field (SPEC.md §8).
 */
export function transientDisplayId(msg: JupyterMessage): string | undefined {
  const transient = contentRecord(msg, 'transient');
  const id = transient?.['display_id'];
  return typeof id === 'string' && id.length > 0 ? id : undefined;
}

/** `content` without `transient`, i.e. the nbformat body of an output. */
export function contentWithoutTransient(msg: JupyterMessage): Record<string, unknown> {
  const { transient: _transient, ...rest } = msg.content as Record<string, unknown>;
  return rest;
}

/** nbformat `stream.text` may be a string or a list of lines; join it. */
export function joinText(text: unknown): string {
  if (typeof text === 'string') return text;
  if (Array.isArray(text)) return text.map((part) => (typeof part === 'string' ? part : '')).join('');
  return '';
}
