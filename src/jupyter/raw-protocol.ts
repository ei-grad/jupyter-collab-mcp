/**
 * jupyter-collaboration RAW frames on the room socket (SPEC.md §5, §6).
 *
 * `jupyter_server_ydoc` adds a message type `2` (`MessageType.RAW`) to the Yjs
 * protocol. y-websocket already uses `2` for `messageAuth`, so the two collide
 * and the auth decoder silently misparses a save reply. The fix is to replace
 * `provider.messageHandlers[2]`; this module owns the wire format so both the
 * client and the test double encode it the same way.
 *
 * Wire format (docprovider `yprovider.ts` `requestDocumentSave`,
 * `handlers.py on_message`; confirmed in spike/NOTES.md §1.4):
 *
 * ```text
 * request : varUint(2) varString("save") varUint(<id>)
 * reply   : varUint(2) varString(JSON {"type":"save","responseTo":<id>,
 *                                      "status":"success"|"skipped"|"failed"})
 * conflict: varUint(2) varString(JSON {"type":"conflict"})
 * ```
 *
 * @module
 */

import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';

import type { SaveStatus } from '../core/index.js';

/** `MessageType.RAW` of `jupyter_server_ydoc`; collides with `messageAuth`. */
export const MESSAGE_RAW = 2;

/** Statuses the server may report for a RAW save (SPEC.md §6). */
export type RawSaveStatus = Exclude<SaveStatus, 'timeout'>;

/** Decoded RAW payload. */
export type RawMessage =
  | { readonly kind: 'save-reply'; readonly responseTo: number; readonly status: RawSaveStatus }
  | { readonly kind: 'conflict'; readonly payload: unknown }
  | { readonly kind: 'unknown'; readonly payload: unknown }
  | { readonly kind: 'unparsable'; readonly text: string };

/** Encode a RAW `save` request for `id` (docprovider `requestDocumentSave`). */
export function encodeRawSaveRequest(id: number): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MESSAGE_RAW);
  encoding.writeVarString(encoder, 'save');
  encoding.writeVarUint(encoder, id);
  return encoding.toUint8Array(encoder);
}

/** Encode a RAW reply carrying `payload` as JSON (used by the test server). */
export function encodeRawJson(payload: unknown): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MESSAGE_RAW);
  encoding.writeVarString(encoder, JSON.stringify(payload));
  return encoding.toUint8Array(encoder);
}

function isSaveStatus(value: unknown): value is RawSaveStatus {
  return value === 'success' || value === 'skipped' || value === 'failed';
}

/** Classify an already-decoded RAW var-string. */
export function parseRawPayload(text: string): RawMessage {
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    return { kind: 'unparsable', text };
  }
  if (typeof payload !== 'object' || payload === null) {
    return { kind: 'unknown', payload };
  }
  const record = payload as Record<string, unknown>;
  if (record['type'] === 'conflict') return { kind: 'conflict', payload };
  if (
    record['type'] === 'save' &&
    typeof record['responseTo'] === 'number' &&
    isSaveStatus(record['status'])
  ) {
    return { kind: 'save-reply', responseTo: record['responseTo'], status: record['status'] };
  }
  return { kind: 'unknown', payload };
}

/**
 * Read a RAW frame from a decoder positioned just after the message type.
 *
 * This is the shape `provider.messageHandlers[2]` receives.
 */
export function readRawMessage(decoder: decoding.Decoder): RawMessage {
  let text: string;
  try {
    text = decoding.readVarString(decoder);
  } catch {
    return { kind: 'unparsable', text: '' };
  }
  return parseRawPayload(text);
}

/** Read a whole RAW frame, message type included. Used by the test server. */
export function readRawFrame(data: Uint8Array): { type: number; decoder: decoding.Decoder } {
  const decoder = decoding.createDecoder(data);
  const type = decoding.readVarUint(decoder);
  return { type, decoder };
}
