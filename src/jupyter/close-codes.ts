/**
 * Room-socket close codes and the state transitions they cause
 * (SPEC.md §6, signal table).
 *
 * | Signal | Transition |
 * | --- | --- |
 * | transport loss, no terminal signal | `ready → reconnecting → syncing → ready` |
 * | 1003 `unknown_session` / `version_mismatch` | `failed`, `RTC_SESSION_REJECTED` |
 * | 1003 `initialization_error` / unparsable | `failed`, `RTC_INITIALIZATION_FAILED` |
 * | 4400 / 4404 | `failed`, `RTC_BAD_REQUEST` / `NOTEBOOK_NOT_FOUND` |
 * | 4500 | bounded retries, then `failed`, `RTC_INITIALIZATION_FAILED` |
 *
 * y-websocket's own `defaultShouldReconnect` only stops on 4400-4499, so 1003
 * would otherwise reconnect forever with a stale `sessionId`
 * (spike/NOTES.md §3.8). This module is the single place that decides.
 *
 * @module
 */

import type { ErrorCode } from '../core/index.js';

/** Parsed body of a 1003 close (`jupyter_server_ydoc` sends JSON). */
export interface SessionRejection {
  readonly reason: 'unknown_session' | 'version_mismatch' | 'initialization_error';
  readonly sessionId?: string;
  readonly reloadable?: boolean;
}

/** What the connection must do after a close frame. */
export type CloseDisposition =
  | {
      readonly kind: 'terminal';
      readonly errorCode: ErrorCode;
      readonly message: string;
      readonly rejection?: SessionRejection;
    }
  /** 4500: retry within the initialization budget, then become terminal. */
  | { readonly kind: 'init-retry'; readonly message: string }
  /** Anything else: keep the replica and let the provider reconnect. */
  | { readonly kind: 'transient'; readonly message: string };

/** Close code used by `jupyter_server_ydoc` for a rejected server session. */
export const CLOSE_UNSUPPORTED_DATA = 1003;
/** Bad request (room name / parameters). */
export const CLOSE_BAD_REQUEST = 4400;
/** The `fileId` has no file behind it (SPEC.md §6: `NOTEBOOK_NOT_FOUND`). */
export const CLOSE_NOT_FOUND = 4404;
/** Server-side initialization error; retried within a budget. */
export const CLOSE_INTERNAL = 4500;

/** Parse only recognized fields from the JSON body of a 1003 close. */
export function parseSessionRejection(reason: string): SessionRejection | null {
  if (reason.length === 0) return null;
  let payload: unknown;
  try {
    payload = JSON.parse(reason);
  } catch {
    return null;
  }
  if (typeof payload !== 'object' || payload === null) return null;
  const record = payload as Record<string, unknown>;
  if (
    record['reason'] !== 'unknown_session' &&
    record['reason'] !== 'version_mismatch' &&
    record['reason'] !== 'initialization_error'
  ) return null;
  const rejection: {
    reason: SessionRejection['reason'];
    sessionId?: string;
    reloadable?: boolean;
  } = { reason: record['reason'] };
  if (typeof record['sessionId'] === 'string') rejection.sessionId = record['sessionId'];
  if (typeof record['reloadable'] === 'boolean') rejection.reloadable = record['reloadable'];
  return rejection;
}

/**
 * Map a close frame onto the SPEC.md §6 transition table.
 *
 * `reason` is the raw close reason; for 1003 it carries JSON. Only the fixed
 * protocol reason names above may reach diagnostics; arbitrary server text is
 * treated as unparseable and never reflected.
 */
export function classifyClose(code: number, reason: string): CloseDisposition {
  if (code === CLOSE_UNSUPPORTED_DATA) {
    const rejection = parseSessionRejection(reason);
    if (rejection === null) {
      return {
        kind: 'terminal',
        errorCode: 'RTC_INITIALIZATION_FAILED',
        message: 'room closed with 1003 and an unparsable reason'
      };
    }
    if (rejection.reason === 'unknown_session' || rejection.reason === 'version_mismatch') {
      return {
        kind: 'terminal',
        errorCode: 'RTC_SESSION_REJECTED',
        message: `room rejected the server session (${rejection.reason})`,
        rejection
      };
    }
    return {
      kind: 'terminal',
      errorCode: 'RTC_INITIALIZATION_FAILED',
      message: `room closed with 1003 (${rejection.reason})`,
      rejection
    };
  }
  if (code === CLOSE_NOT_FOUND) {
    return {
      kind: 'terminal',
      errorCode: 'NOTEBOOK_NOT_FOUND',
      message: 'room closed with 4404: the file behind this fileId does not exist'
    };
  }
  if (code === CLOSE_BAD_REQUEST) {
    return {
      kind: 'terminal',
      errorCode: 'RTC_BAD_REQUEST',
      message: 'room closed with 4400: bad request'
    };
  }
  if (code === CLOSE_INTERNAL) {
    return { kind: 'init-retry', message: 'room closed with 4500: server initialization error' };
  }
  // RFC 6455 reserves 4000-4999 for private use; jupyter-collaboration and
  // y-websocket both treat 4400-4499 as "reconnecting cannot help".
  if (code >= 4400 && code < 4500) {
    return {
      kind: 'terminal',
      errorCode: 'RTC_BAD_REQUEST',
      message: `room closed with ${code}: permanent refusal`
    };
  }
  return { kind: 'transient', message: `room closed with ${code}` };
}
