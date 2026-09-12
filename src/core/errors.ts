/**
 * Error contract shared by every module of the client.
 *
 * The code list is the union of
 *   - the error table in SPEC.md §9 ("Retries, errors, and response size"),
 *   - the RTC transition table in SPEC.md §6 (`RTC_*`, `FILE_ID_CHANGED`,
 *     `NOTEBOOK_NOT_FOUND`, `NOT_READY`, `HANDLE_EXPIRED`),
 *   - the execution codes named in SPEC.md §8 (`KERNEL_NOT_BOUND`,
 *     `KERNEL_SELECTION_REQUIRED`, `KERNEL_CHANGED`,
 *     `UNSUPPORTED_EXECUTION_MODE`, `INVALID_ARGUMENT`).
 *
 * The MCP adapter maps `CoreError` onto `isError: true` plus the structured
 * fields `code`, `message`, `retryable`, `side_effects` (SPEC.md §9). Nothing
 * else in the codebase invents ad-hoc error strings: an unexpected failure is
 * `INTERNAL_ERROR`.
 *
 * @module
 */

/**
 * Every error code the service may return.
 *
 * Ordered as in the SPEC.md §9 table so the two can be diffed by eye.
 *
 * Deliberately absent:
 *   - `NAMED_CREATE_UNSUPPORTED` — removed from SPEC.md by commit 696d775;
 *     `notebook_create` now performs untitled-allocate + Contents `PATCH`
 *     rename on the standard manager (SPEC.md §6 "External file changes"),
 *     so a named create fails with `ALREADY_EXISTS` / `PERMISSION_DENIED` /
 *     `OPERATION_UNCERTAIN` instead.
 *   - `SERVER_NOT_RUNNING` — belongs to the optional JupyterHub lifecycle
 *     adapter (docs/CONNECTIONS.md §7), which is explicitly outside the first
 *     version. Add it here together with that adapter.
 */
export type ErrorCode =
  // --- arguments and unsupported operations (SPEC §9) -----------------------
  | 'INVALID_ARGUMENT'
  | 'UNSUPPORTED_OPERATION'
  // --- server selection (SPEC §6 item 1, §9) -------------------------------
  | 'SERVER_NOT_FOUND'
  | 'SERVER_SELECTION_REQUIRED'
  // --- authentication (SPEC §9, §11) ---------------------------------------
  | 'AUTH_REQUIRED'
  | 'PERMISSION_DENIED'
  // --- handle lifetime (SPEC §4, §9) ---------------------------------------
  | 'HANDLE_EXPIRED'
  // --- RTC readiness and terminal RTC states (SPEC §6) ----------------------
  | 'NOT_READY'
  | 'RTC_SESSION_REJECTED'
  | 'RTC_CONFLICT'
  | 'FILE_ID_CHANGED'
  | 'RTC_BAD_REQUEST'
  | 'RTC_INITIALIZATION_FAILED'
  // --- addressing documents and cells (SPEC §6, §7) -------------------------
  | 'NOTEBOOK_NOT_FOUND'
  | 'CELL_NOT_FOUND'
  | 'CELL_ID_AMBIGUOUS'
  | 'CELL_REPLACED'
  // --- optimistic concurrency on cell content (SPEC §7) ---------------------
  | 'REVISION_CONFLICT'
  | 'MATCH_NOT_FOUND'
  | 'MATCH_NOT_UNIQUE'
  // --- paging and change cursors (SPEC §9, §10) ----------------------------
  | 'CURSOR_EXPIRED'
  // --- creation (SPEC §6 "External file changes") --------------------------
  | 'ALREADY_EXISTS'
  // --- execution mode and kernel binding (SPEC §8) --------------------------
  | 'UNSUPPORTED_EXECUTION_MODE'
  | 'KERNEL_NOT_BOUND'
  | 'KERNEL_SELECTION_REQUIRED'
  | 'KERNEL_CHANGED'
  | 'EXECUTION_ACTIVE'
  // --- request_id ledger (SPEC §9 "Retries") -------------------------------
  | 'REQUEST_ID_CONFLICT'
  | 'REQUEST_OUT_OF_ORDER'
  | 'REQUEST_ID_EXPIRED'
  // --- budgets (SPEC §9) ----------------------------------------------------
  | 'RESOURCE_LIMIT'
  | 'DOCUMENT_TOO_LARGE'
  // --- transport and uncertainty (SPEC §6, §9) -----------------------------
  | 'NETWORK_ERROR'
  | 'OPERATION_UNCERTAIN'
  | 'SAVE_FAILED'
  | 'INTERNAL_ERROR';

/**
 * Whether the caller may retry the *same* call unchanged.
 *
 * SPEC.md §9: `retryable: true` never authorises re-sending code under a new
 * `request_id`; it only says the call itself had no effect and the condition is
 * transient.
 */
export type Retryable = boolean;

/**
 * What the failed call did to the document, the file or the kernel
 * (SPEC.md §9: "`side_effects` applies to the document/file/kernel").
 *
 * - `none`    — provably nothing changed;
 * - `applied` — the effect happened even though the call reports an error;
 * - `unknown` — the effect cannot be established; the caller must re-read
 *   state and must not re-issue the operation on its own.
 *
 * Consuming the `request_id` is *not* a side effect: that is reported
 * separately as `request_accepted`.
 */
export type SideEffects = 'none' | 'applied' | 'unknown';

/** Default `retryable` / `side_effects` pair for a code (SPEC.md §9 table). */
export interface ErrorDefaults {
  readonly retryable: Retryable;
  readonly sideEffects: SideEffects;
}

/**
 * The SPEC.md §9 table, transcribed row by row.
 *
 * A call site overrides a default only when it *knows* more than the table:
 * e.g. `ALREADY_EXISTS` after the untitled file was already allocated becomes
 * `sideEffects: 'applied'` and carries the actual path (SPEC.md §6).
 */
export const DEFAULTS: Readonly<Record<ErrorCode, ErrorDefaults>> = Object.freeze({
  INVALID_ARGUMENT: { retryable: false, sideEffects: 'none' },
  UNSUPPORTED_OPERATION: { retryable: false, sideEffects: 'none' },
  SERVER_NOT_FOUND: { retryable: false, sideEffects: 'none' },
  SERVER_SELECTION_REQUIRED: { retryable: false, sideEffects: 'none' },
  AUTH_REQUIRED: { retryable: false, sideEffects: 'none' },
  PERMISSION_DENIED: { retryable: false, sideEffects: 'none' },
  HANDLE_EXPIRED: { retryable: false, sideEffects: 'none' },
  NOT_READY: { retryable: true, sideEffects: 'none' },
  RTC_SESSION_REJECTED: { retryable: false, sideEffects: 'unknown' },
  RTC_CONFLICT: { retryable: false, sideEffects: 'unknown' },
  FILE_ID_CHANGED: { retryable: false, sideEffects: 'unknown' },
  RTC_BAD_REQUEST: { retryable: false, sideEffects: 'none' },
  RTC_INITIALIZATION_FAILED: { retryable: false, sideEffects: 'none' },
  NOTEBOOK_NOT_FOUND: { retryable: false, sideEffects: 'none' },
  CELL_NOT_FOUND: { retryable: false, sideEffects: 'none' },
  CELL_ID_AMBIGUOUS: { retryable: false, sideEffects: 'none' },
  CELL_REPLACED: { retryable: false, sideEffects: 'none' },
  REVISION_CONFLICT: { retryable: false, sideEffects: 'none' },
  MATCH_NOT_FOUND: { retryable: false, sideEffects: 'none' },
  MATCH_NOT_UNIQUE: { retryable: false, sideEffects: 'none' },
  CURSOR_EXPIRED: { retryable: false, sideEffects: 'none' },
  ALREADY_EXISTS: { retryable: false, sideEffects: 'none' },
  UNSUPPORTED_EXECUTION_MODE: { retryable: false, sideEffects: 'none' },
  KERNEL_NOT_BOUND: { retryable: false, sideEffects: 'none' },
  KERNEL_SELECTION_REQUIRED: { retryable: false, sideEffects: 'none' },
  KERNEL_CHANGED: { retryable: false, sideEffects: 'none' },
  EXECUTION_ACTIVE: { retryable: false, sideEffects: 'none' },
  REQUEST_ID_CONFLICT: { retryable: false, sideEffects: 'none' },
  REQUEST_OUT_OF_ORDER: { retryable: false, sideEffects: 'none' },
  REQUEST_ID_EXPIRED: { retryable: false, sideEffects: 'unknown' },
  RESOURCE_LIMIT: { retryable: false, sideEffects: 'none' },
  DOCUMENT_TOO_LARGE: { retryable: false, sideEffects: 'none' },
  NETWORK_ERROR: { retryable: true, sideEffects: 'none' },
  OPERATION_UNCERTAIN: { retryable: false, sideEffects: 'unknown' },
  SAVE_FAILED: { retryable: false, sideEffects: 'unknown' },
  INTERNAL_ERROR: { retryable: false, sideEffects: 'unknown' }
});

/** All codes, in declaration order. Handy for exhaustiveness tests. */
export const ERROR_CODES: readonly ErrorCode[] = Object.freeze(
  Object.keys(DEFAULTS) as ErrorCode[]
);

/** Type guard for values coming back from JSON / other processes. */
export function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(DEFAULTS, value);
}

/** Optional per-call overrides of the SPEC.md §9 defaults. */
export interface CoreErrorOverrides {
  readonly retryable?: Retryable;
  readonly sideEffects?: SideEffects;
  /**
   * Structured diagnostics for the agent: current revisions, actual path,
   * close code, `execution_id`, and so on.
   *
   * MUST NOT contain credentials. SPEC.md §11 forbids tokens in messages, logs
   * and links; a WebSocket URL that carries `token=` in its query has to be
   * redacted before it reaches `details` (see {@link redactCredentials}).
   */
  readonly details?: Readonly<Record<string, unknown>>;
  /** Underlying error, kept for local logging only. Never serialised to MCP. */
  readonly cause?: unknown;
}

/**
 * The single error type crossing module boundaries inside the client.
 *
 * `message` is written for the agent, not for a log grep: it says what was
 * rejected and what to do next. It must never embed a token — see SPEC.md §11.
 */
export class CoreError extends Error {
  readonly code: ErrorCode;
  readonly retryable: Retryable;
  readonly sideEffects: SideEffects;
  readonly details?: Readonly<Record<string, unknown>>;

  constructor(code: ErrorCode, message: string, overrides: CoreErrorOverrides = {}) {
    super(message, overrides.cause === undefined ? undefined : { cause: overrides.cause });
    const defaults = DEFAULTS[code];
    this.name = 'CoreError';
    this.code = code;
    this.retryable = overrides.retryable ?? defaults.retryable;
    this.sideEffects = overrides.sideEffects ?? defaults.sideEffects;
    if (overrides.details !== undefined) this.details = overrides.details;
  }

  /** Wire shape for the MCP adapter (SPEC.md §9). */
  toJSON(): {
    code: ErrorCode;
    message: string;
    retryable: Retryable;
    side_effects: SideEffects;
    details?: Readonly<Record<string, unknown>>;
  } {
    return {
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      side_effects: this.sideEffects,
      ...(this.details === undefined ? {} : { details: this.details })
    };
  }
}

/**
 * Construct a {@link CoreError} with the SPEC.md §9 defaults for `code`.
 *
 * @example
 * throw coreError('REVISION_CONFLICT', 'cell source changed since the read', {
 *   details: { cell_id: id, current_source_revision: rev }
 * });
 */
export function coreError(
  code: ErrorCode,
  message: string,
  overrides?: CoreErrorOverrides
): CoreError {
  return new CoreError(code, message, overrides);
}

/** Narrowing helper: is this thrown value one of ours? */
export function isCoreError(value: unknown): value is CoreError {
  return value instanceof CoreError;
}

/**
 * Turn any thrown value into a `CoreError`.
 *
 * Unknown failures become `INTERNAL_ERROR` with `side_effects: unknown`, which
 * is the honest answer required by SPEC.md §9: we do not know whether the
 * document, the file or the kernel changed.
 */
export function toCoreError(value: unknown, fallbackMessage = 'unexpected error'): CoreError {
  if (isCoreError(value)) return value;
  const message = value instanceof Error ? value.message : fallbackMessage;
  return new CoreError('INTERNAL_ERROR', redactCredentials(message), { cause: value });
}

/**
 * Remove obvious credentials from free-form text before it is put into a
 * message or `details` (SPEC.md §11: "If WS compatibility requires a token
 * in the query, that URL is also redacted before logging").
 *
 * This is a last line of defence, not a licence to pass secrets around: the
 * caller is still responsible for never building the string in the first place.
 */
export function redactCredentials(text: string): string {
  return text
    .replace(/([?&](?:token|access_token|api_key)=)[^&\s"']+/gi, '$1<redacted>')
    .replace(/\b(Authorization:\s*(?:token|Bearer)\s+)\S+/gi, '$1<redacted>');
}
