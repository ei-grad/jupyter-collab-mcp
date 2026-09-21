/**
 * The service facade: one method per SPEC.md §9 tool, plus the two MCP
 * resource entry points and process shutdown.
 *
 * This is the seam between the registry layer (working sessions, notebook
 * handles, the `request_id` ledger, jobs) and the MCP adapter. The registry
 * *implements* {@link CollabService}; the adapter *consumes* it and does
 * nothing else: it validates JSON Schema arguments, renames camelCase fields
 * to the snake_case wire form of SPEC.md §9, applies the response-size limits
 * and turns a {@link CoreError} into `isError: true` plus
 * `code` / `message` / `retryable` / `side_effects`.
 *
 * Three rules hold for every method here:
 *
 * 1. **Errors are thrown, never returned.** Every rejection is a
 *    {@link CoreError} with a SPEC.md §9 code. A Python error, an `aborted`
 *    cell, an `interrupted` or `unknown` job and `save_status: skipped` are
 *    *results*, not errors (SPEC.md §9).
 * 2. **Every response of a session-scoped call carries {@link SessionEnvelope}.**
 *    Even a replay and even an error path report the current
 *    `nextRequestId = H + 1`, so an agent that lost its counter recovers it
 *    with any read-only call (SPEC.md §10 item 3).
 * 3. **Handles are opaque and process-scoped.** After a restart every old
 *    handle is `HANDLE_EXPIRED` (SPEC.md §4); nothing is re-executed
 *    automatically.
 *
 * Ownership note for a future HTTP adapter (SPEC.md §4): handles are not an
 * authorisation boundary here. A shared transport must bind every handle -
 * including {@link CollabService.readOutputResource} - to an authenticated
 * owner and check it on every call. The MCP transport session and `clientInfo`
 * are not an owner identity.
 *
 * @module
 */

import type { CoreError } from './errors.js';
import type {
  AbortedReason,
  CellRunState,
  CellSummary,
  CellType,
  ChangeEvent,
  ChangesCursor,
  ConnectionState,
  DeliveryState,
  JobState,
  KernelChannelState,
  KernelExecutionStatus,
  NbOutput,
  NotSentReason,
  NotebookSummary,
  Operation,
  OperationResult,
  PageCursor,
  PersistenceState,
  ReadView,
  SaveStatus,
  ServerDescriptor,
  SharedExecutionState
} from './types.js';
import type {
  CellRevision,
  NotebookMetadataRevision,
  OutputsRevision,
  SourceRevision,
  StructureRevision
} from './revision.js';

// ---------------------------------------------------------------------------
// handles, request numbers, lifetimes (SPEC.md §4, §9)
// ---------------------------------------------------------------------------

/**
 * Handle of a working session (`session_id`). Opaque: the agent stores it and
 * passes it back, and must never parse or construct one.
 */
export type SessionId = string;

/**
 * Handle of one open notebook replica (`notebook_id`). It determines the
 * server and the working session on its own; there is no "current notebook"
 * (SPEC.md §4).
 */
export type NotebookId = string;

/** Handle of one execution job (`execution_id`). */
export type ExecutionId = string;

/**
 * Handle of one immutable output snapshot (`output_id`). The matching MCP
 * resource URI is `jupyter-output:<output_id>`; neither contains credentials
 * (SPEC.md §9).
 */
export type OutputId = string;

/**
 * `request_id`: the canonical decimal form of a positive 64-bit number,
 * increasing by one inside one working session, starting at `"1"`
 * (SPEC.md §9).
 *
 * The client takes the number from the last response of that session. It never
 * increments on its own and never reconstructs one from memory: after losing
 * context it makes a read-only call and reads `nextRequestId` from the answer.
 */
export type RequestId = string;

/** Opaque cursor into the outputs of one job. Not a {@link PageCursor}. */
export type ExecutionCursor = string;

/** Opaque cursor into the bytes of one output snapshot. */
export type OutputCursor = string;

/** Opaque cursor into a Contents directory listing. */
export type DirectoryCursor = string;

/** What releases a handle (SPEC.md §4 "Creation tool descriptions ... specify the lifetime"). */
export type LifetimeScope =
  /** Session and notebook handles: an explicit close, or the process exiting. */
  | 'until_close_or_process_exit'
  /** Jobs and their output snapshots: they die with their working session. */
  | 'until_session_close';

/** Events that release a handle. `process_exit` is always among them. */
export type HandleRelease =
  | 'session_close'
  | 'notebook_close'
  | 'execution_cancel'
  | 'process_exit';

/**
 * Lifetime a creation tool reports for the handle it just issued
 * (SPEC.md §4, §9).
 *
 * `processScoped` is always `true` in the first version: after a restart the
 * handle is `HANDLE_EXPIRED` and the agent explicitly opens the document
 * again. Unfinished code is never replayed.
 */
export interface HandleLifetime {
  readonly scope: LifetimeScope;
  /** What releases it, e.g. `['notebook_close', 'session_close']`. */
  readonly releasedBy: readonly HandleRelease[];
  /** Always `true` here; kept explicit because the wire schema states it. */
  readonly processScoped: boolean;
}

/**
 * Fields every response of a session-scoped call carries (SPEC.md §9
 * "Retries, errors, and response size").
 *
 * They are merged into the result of every method that takes a `sessionId`,
 * a `notebookId` or an `executionId`, and they are also attached to the
 * `details` of a {@link CoreError} thrown by such a call.
 */
export interface SessionEnvelope {
  /**
   * `H + 1` at the moment of the answer - the number the next mutating call of
   * this session must use. `null` when the session can accept no further
   * mutations: the 64-bit range is exhausted, or the session is gone
   * (`session_close`).
   *
   * A replay also returns the *current* number, not the one stored in the old
   * receipt.
   */
  readonly nextRequestId: RequestId | null;
  /**
   * Whether this call consumed its `request_id`.
   *
   * - `true` - the receipt was created and `H` bumped before the first effect;
   *   the number is spent even if the operation then failed or ended unknown;
   * - `false` - rejected before acceptance, so the same number may be reused
   *   with a corrected payload;
   * - `null` - the receipt expired and payload equality can no longer be
   *   established (`REQUEST_ID_EXPIRED`);
   * - absent - the call is not one of the four deduplicated mutations.
   */
  readonly requestAccepted?: boolean | null;
  /**
   * `true` when the answer comes from a stored receipt rather than a fresh
   * execution. It reports reuse of the receipt, not success of the operation:
   * an agent must not announce a new cell or a new run on a replayed receipt
   * (SPEC.md §9).
   */
  readonly replayed?: boolean;
  /**
   * RFC 3339 UTC time this `request_id` was *first* accepted. A replay never
   * updates it. Absent when there is no receipt (a rejection before
   * acceptance, or a non-deduplicated call).
   */
  readonly firstAcceptedAt?: string;
}

/** A result plus the session envelope. */
export type WithEnvelope<T> = T & SessionEnvelope;

// ---------------------------------------------------------------------------
// shared request fragments (SPEC.md §9 "limits", "wait_ms", cursors)
// ---------------------------------------------------------------------------

/**
 * Per-call overrides of the configured response budgets
 * (`ServiceLimits` in `./config.js`).
 *
 * A caller may only ask for *less*: a value above the configured budget is
 * clamped, never granted. Whatever the limits, the answer always states
 * `truncated`, the available MIME types, the full sizes and how to read the
 * rest (SPEC.md §9).
 */
export interface ResponseLimits {
  /** Cells in this answer; default `summaryMaxCells` (100). */
  readonly maxCells?: number;
  /** UTF-8 budget of this answer; default `responseMaxBytes` (64 KiB). */
  readonly maxBytes?: number;
  /** Length of the source excerpt in a summary row. */
  readonly previewChars?: number;
  /**
   * Budget for inlined output payloads. A payload above it is never inlined:
   * the entry keeps its MIME list, its size and an `outputId` to read it with
   * (SPEC.md §9 - a full base64 image is not repeated in every text answer).
   */
  readonly maxOutputBytes?: number;
}

/**
 * How long a call may wait before answering.
 *
 * Clamped to `ServiceLimits.maxWaitMs` (30 s). The wait ending says nothing
 * about the computation: it keeps running, no kernel is interrupted and no
 * code is re-sent (SPEC.md §8, §12 "Interruption").
 */
export interface WaitOptions {
  readonly waitMs?: number;
}

// ---------------------------------------------------------------------------
// server_list
// ---------------------------------------------------------------------------

/** How a profile reached the process (SPEC.md §11). */
export type ServerOrigin = 'configured' | 'discovered';

/** One row of `server_list`; credential-free by construction. */
export interface ServerListEntry {
  readonly descriptor: ServerDescriptor;
  readonly origin: ServerOrigin;
  /**
   * `true` when a `session_open` without `server_id` would pick this profile.
   * Exactly one entry may have it; none has it when the choice is ambiguous.
   */
  readonly defaultChoice: boolean;
}

/** Result of `server_list` (SPEC.md §9). */
export interface ServerListResult {
  /** Next mutation number for the implicit connection context. */
  readonly nextRequestId?: RequestId | null;
  readonly servers: readonly ServerListEntry[];
  /** Whether local runtime discovery is enabled for this process. */
  readonly discoveryEnabled: boolean;
  /**
   * `true` when `session_open` without an explicit `server_id` would fail with
   * `SERVER_SELECTION_REQUIRED`.
   */
  readonly selectionRequired: boolean;
}

// ---------------------------------------------------------------------------
// session_open / session_close
// ---------------------------------------------------------------------------

export interface ServerStatusRequest {
  readonly serverId?: string;
}

export interface ServerStartRequest extends ServerStatusRequest, WaitOptions {
  readonly requestId: RequestId;
  readonly profileId?: string;
  readonly userOptions?: Readonly<Record<string, unknown>>;
}

export interface ServerStatusResult {
  readonly serverId: string;
  readonly state: 'ready' | 'stopped' | 'starting' | 'stopping' | 'failed' | 'unknown';
  readonly supportsStart: boolean;
  readonly hubUser?: string;
  readonly hubServerName?: string;
  readonly userOptions?: Readonly<Record<string, unknown>>;
  readonly startOptions?: { readonly profiles: readonly import('./types.js').ServerStartProfile[] };
  readonly nextRequestId?: RequestId | null;
}

/** Arguments of `session_open` (SPEC.md §9). */
export interface SessionOpenRequest {
  /** Omitted only when exactly one server is available (SPEC.md §6 item 1). */
  readonly serverId?: string;
  /** Free-form label for diagnostics. Never a credential. */
  readonly label?: string;
}

/** Result of `session_open`. */
export interface SessionOpenResult {
  readonly sessionId: SessionId;
  readonly server: ServerDescriptor;
  readonly label?: string;
  readonly lifetime: HandleLifetime;
  /** RFC 3339 UTC. */
  readonly openedAt: string;
  /**
   * Always `false` for the first version: opening a session starts no kernel
   * and touches no document (SPEC.md §9).
   */
  readonly kernelStarted: boolean;
}

/** Arguments of `session_close`. */
export interface SessionCloseRequest {
  readonly sessionId: SessionId;
  /**
   * Close even though a job of this session is still active. The abandoned
   * job becomes `unknown`; the kernel keeps running, because closing never
   * shuts a kernel down (SPEC.md §4). Default `false`, which gives
   * `EXECUTION_ACTIVE` instead.
   */
  readonly force?: boolean;
}

/** Result of `session_close`. */
export interface SessionCloseResult {
  readonly sessionId: SessionId;
  /** Notebook handles released by this call. */
  readonly closedNotebookIds: readonly NotebookId[];
  /** Jobs and output snapshots dropped with the session. */
  readonly droppedExecutionIds: readonly ExecutionId[];
  /** `true` when the session was already closed; the call stays idempotent. */
  readonly alreadyClosed: boolean;
  /**
   * Always `true`: an ordinary MCP close shuts down neither kernels nor the
   * Jupyter server (SPEC.md §4).
   */
  readonly kernelsLeftRunning: boolean;
}

// ---------------------------------------------------------------------------
// notebook_list
// ---------------------------------------------------------------------------

/** Jupyter Sessions API binding visible for a listed file (SPEC.md §8, §9). */
export interface NotebookSessionInfo {
  /** Jupyter *kernel session* id - not a working session, not a room. */
  readonly jupyterSessionId: string;
  readonly kernelId: string | null;
  readonly kernelName: string | null;
  /** Last observed execution status, when the process happens to know one. */
  readonly executionStatus?: KernelExecutionStatus;
}

/** One entry of `notebook_list`. */
export interface NotebookListEntry {
  readonly name: string;
  /** Path in the server Contents, relative to the Jupyter root. */
  readonly path: string;
  readonly type: 'notebook' | 'directory';
  /** RFC 3339, as the server reports it. */
  readonly lastModified: string | null;
  readonly size: number | null;
  /** Present when a Jupyter kernel session is bound to this path. */
  readonly session?: NotebookSessionInfo;
  /** Set when this working session already has the file open. */
  readonly openNotebookId?: NotebookId;
}

/** Arguments of `notebook_list`. */
export interface NotebookListRequest {
  /** Library-only explicit session; MCP callers select serverId instead. */
  readonly sessionId?: SessionId;
  readonly serverId?: string;
  /** `''` is the Jupyter root. `..` segments are rejected (SPEC.md §11). */
  readonly directory: string;
  readonly cursor?: DirectoryCursor;
  readonly limits?: ResponseLimits;
}

/** Result of `notebook_list`. */
export interface NotebookListResult {
  readonly directory: string;
  readonly entries: readonly NotebookListEntry[];
  readonly truncated: boolean;
  readonly nextCursor?: DirectoryCursor;
  /** `false` when the server reported no session information at all. */
  readonly sessionsIncluded: boolean;
}

// ---------------------------------------------------------------------------
// notebook_create / notebook_open / notebook_close
// ---------------------------------------------------------------------------

/** Identity and connection status of one open replica. */
export interface NotebookHandleInfo {
  readonly notebookId: NotebookId;
  readonly sessionId: SessionId;
  /** The final Contents path; for a create, the path after the rename. */
  readonly path: string;
  readonly fileId: string;
  /** `json:notebook:<fileId>`, stored as `state.document_id` (SPEC.md §6 item 5). */
  readonly documentId: string;
  readonly connectionState: ConnectionState;
  /** `true` while the replica is not (or no longer) `ready` (SPEC.md §6). */
  readonly stale: boolean;
  readonly lifetime: HandleLifetime;
}

/** Arguments of `notebook_create` (SPEC.md §6 "notebook creation", §9). */
export interface NotebookCreateRequest {
  readonly sessionId?: SessionId;
  readonly serverId?: string;
  readonly requestId: RequestId;
  /** Directory the untitled file is allocated in. `''` is the Jupyter root. */
  readonly directory: string;
  /**
   * Exactly one file name ending in `.ipynb`, inside `directory`; no `/`, `\`
   * or other path separator. Omitted, the server-chosen untitled name is kept
   * (SPEC.md §6).
   */
  readonly name?: string;
}

/** Result of `notebook_create`. */
export interface NotebookCreateResult {
  readonly notebook: NotebookHandleInfo;
  /** The path the server allocated before any rename. */
  readonly untitledPath: string;
  /**
   * `false` when no rename was needed - either no `name` was asked for, or the
   * server had already chosen exactly that name (SPEC.md §6).
   */
  readonly renamed: boolean;
  /** Snapshot taken together with {@link changesCursor}, without an await. */
  readonly summary: NotebookSummary;
  readonly changesCursor: ChangesCursor;
}

/** Arguments of `notebook_open`. */
export interface NotebookOpenRequest {
  readonly sessionId?: SessionId;
  readonly serverId?: string;
  readonly path: string;
  readonly limits?: ResponseLimits;
}

/** Result of `notebook_open`. */
export interface NotebookOpenResult {
  readonly notebook: NotebookHandleInfo;
  /**
   * `true` when a live handle for the same `fileId` in this session was
   * returned instead of a second `Y.Doc`/WebSocket. Concurrent opens of one
   * document coalesce into a single operation (SPEC.md §4).
   */
  readonly reused: boolean;
  readonly summary: NotebookSummary;
  readonly changesCursor: ChangesCursor;
}

/** Arguments of `notebook_close`. */
export interface NotebookCloseRequest {
  readonly notebookId: NotebookId;
  /** As in {@link SessionCloseRequest.force}. Default `false`. */
  readonly force?: boolean;
}

/** Result of `notebook_close`. */
export interface NotebookCloseResult {
  readonly notebookId: NotebookId;
  readonly alreadyClosed: boolean;
  /** Jobs of this notebook that were abandoned by a forced close. */
  readonly droppedExecutionIds: readonly ExecutionId[];
  /** Always `true`: closing a replica never shuts a kernel down. */
  readonly kernelLeftRunning: boolean;
}

// ---------------------------------------------------------------------------
// notebook_read
// ---------------------------------------------------------------------------

/** Fields every `notebook_read` answer carries. */
export interface NotebookReadCommon {
  readonly notebookId: NotebookId;
  readonly view: ReadView;
  readonly connectionState: ConnectionState;
  /** SPEC.md §6: a read before readiness is served, but marked stale. */
  readonly stale: boolean;
  readonly structureRevision: StructureRevision;
  /**
   * Journal boundary matching this snapshot exactly: no change can be lost
   * between the snapshot and the cursor (SPEC.md §9, §10).
   *
   * The summary view repeats it inside `summary`; both come from the same
   * snapshot, so the two values are equal.
   */
  readonly changesCursor: ChangesCursor;
}

/** `notebook_read(view: 'summary')`. */
export interface NotebookSummaryReadRequest {
  readonly notebookId: NotebookId;
  readonly view: 'summary';
  readonly cursor?: PageCursor;
  readonly limits?: ResponseLimits;
}

/** Answer of the summary view. */
export interface NotebookSummaryReadResult extends NotebookReadCommon {
  readonly view: 'summary';
  readonly summary: NotebookSummary;
  /** Present when cells remain; bound to {@link structureRevision}. */
  readonly nextCursor?: PageCursor;
}

/** `notebook_read(view: 'cells')`. */
export interface NotebookCellsReadRequest {
  readonly notebookId: NotebookId;
  readonly view: 'cells';
  /** Explicit selection; mutually exclusive with {@link cursor}. */
  readonly cellIds?: readonly string[];
  readonly cursor?: PageCursor;
  readonly limits?: ResponseLimits;
}

/** One cell of the `cells` view: text, metadata and attachments. */
export interface CellContent {
  readonly cellId: string;
  readonly index: number;
  readonly cellType: CellType;
  /** May be cut to the byte budget; see {@link sourceTruncated}. */
  readonly source: string;
  readonly sourceTruncated: boolean;
  /** Full UTF-8 size of the source even when truncated. */
  readonly sourceBytes: number;
  readonly metadata: Readonly<Record<string, unknown>>;
  /** Markdown/raw attachments. Read-only in the first version (SPEC.md §9). */
  readonly attachments?: Readonly<Record<string, unknown>>;
  readonly sourceRevision: SourceRevision;
  readonly cellRevision: CellRevision;
  readonly outputsRevision: OutputsRevision | null;
  readonly executionCount: number | null;
  readonly executionState?: SharedExecutionState;
  /** `true` when another cell currently has the same id (SPEC.md §7). */
  readonly duplicateId?: boolean;
}

/** Answer of the cells view. */
export interface NotebookCellsReadResult extends NotebookReadCommon {
  readonly view: 'cells';
  readonly cells: readonly CellContent[];
  readonly truncated: boolean;
  readonly nextCursor?: PageCursor;
  readonly notebookMetadata?: Readonly<Record<string, unknown>>;
  readonly notebookMetadataRevision: NotebookMetadataRevision;
}

/** `notebook_read(view: 'outputs')`. */
export interface NotebookOutputsReadRequest {
  readonly notebookId: NotebookId;
  readonly view: 'outputs';
  readonly cellIds?: readonly string[];
  readonly cursor?: PageCursor;
  readonly limits?: ResponseLimits;
}

/**
 * One output, bounded (SPEC.md §9).
 *
 * The payload is inlined only when it fits the byte budget. Otherwise the
 * entry still reports every MIME type, the full size and an {@link outputId}
 * with which the bytes are read - through the MCP resource, or through
 * `output_read` for hosts that do not read resources.
 */
export interface OutputEntry {
  /** Position inside the cell's output area at snapshot time. */
  readonly index: number;
  /** nbformat `output_type`: `stream`, `execute_result`, … */
  readonly outputType: string;
  /** MIME types present in the bundle; empty for `stream` and `error`. */
  readonly mimeTypes: readonly string[];
  /** Full UTF-8 size of the serialised output. */
  readonly byteSize: number;
  readonly truncated: boolean;
  /** The output itself, only when it fit the budget. */
  readonly output?: NbOutput;
  /** Short excerpt of a truncated textual output, within the budget. */
  readonly textPreview?: string;
  /** Present whenever the payload can be read separately. */
  readonly snapshot?: OutputSnapshotRef;
}

/**
 * Reference to an immutable output snapshot (SPEC.md §9).
 *
 * The same snapshot is not recreated on every read. When it expires, reading
 * it gives `HANDLE_EXPIRED`; the absence of resource support in a host never
 * makes the result unreachable, because `output_read` serves the same bytes.
 */
export interface OutputSnapshotRef {
  readonly outputId: OutputId;
  /** `jupyter-output:<output_id>`. Contains no credentials (SPEC.md §9, §11). */
  readonly uri: string;
  readonly mimeTypes: readonly string[];
  readonly byteSize: number;
  /**
   * `true` when the adapter should emit this snapshot as MCP `image` content
   * (PNG/JPEG within the budget) rather than as a link (SPEC.md §9).
   */
  readonly inlineImageAdvised: boolean;
  readonly lifetime: HandleLifetime;
}

/** Outputs of one cell. */
export interface CellOutputsView {
  readonly cellId: string;
  readonly index: number;
  readonly cellType: CellType;
  /** `null` for markdown and raw cells, which have no output area. */
  readonly outputsRevision: OutputsRevision | null;
  readonly outputs: readonly OutputEntry[];
  readonly executionCount: number | null;
  readonly executionState?: SharedExecutionState;
  readonly truncated: boolean;
}

/** Answer of the outputs view. */
export interface NotebookOutputsReadResult extends NotebookReadCommon {
  readonly view: 'outputs';
  readonly cells: readonly CellOutputsView[];
  readonly truncated: boolean;
  readonly nextCursor?: PageCursor;
}

/** Union of the three `notebook_read` argument shapes. */
export type NotebookReadRequest =
  | NotebookSummaryReadRequest
  | NotebookCellsReadRequest
  | NotebookOutputsReadRequest;

/** Union of the three `notebook_read` answers, discriminated by `view`. */
export type NotebookReadResult =
  | NotebookSummaryReadResult
  | NotebookCellsReadResult
  | NotebookOutputsReadResult;

/**
 * The answer belonging to one request shape.
 *
 * Keeps {@link CollabService.notebookRead} a *single* signature - an
 * implementation writes one method - while a caller passing a literal
 * `view: 'outputs'` still gets {@link NotebookOutputsReadResult} back instead
 * of the union.
 */
export type NotebookReadResultFor<R extends NotebookReadRequest> = Extract<
  NotebookReadResult,
  { readonly view: R['view'] }
>;

// ---------------------------------------------------------------------------
// notebook_apply
// ---------------------------------------------------------------------------

/** Arguments of `notebook_apply` (SPEC.md §7, §9). */
export interface NotebookApplyRequest {
  readonly notebookId: NotebookId;
  readonly requestId: RequestId;
  /** Non-empty. Validated in full before the first mutation (SPEC.md §7). */
  readonly operations: readonly Operation[];
}

/**
 * Result of `notebook_apply`.
 *
 * `appliedLocally` / `delivery` / `persistence` are three separate facts
 * (SPEC.md §6 "Delivery and persistence"): a returned `ws.send`,
 * `bufferedAmount === 0` and an earlier `synced` prove neither that the server
 * applied the edit nor that the file was written.
 */
export interface NotebookApplyResult {
  readonly notebookId: NotebookId;
  readonly results: readonly OperationResult[];
  readonly appliedLocally: boolean;
  readonly delivery: DeliveryState;
  /** `unconfirmed` by default; `notebook_save` is what may confirm anything. */
  readonly persistence: PersistenceState;
  readonly structureRevision: StructureRevision;
  readonly changesCursor: ChangesCursor;
  /**
   * Set when an unexpected failure happened after the first mutation: the
   * batch may be partially applied and the caller must re-read the affected
   * cells (SPEC.md §7 - a Yjs transaction has no rollback).
   */
  readonly partial?: boolean;
  /** Index of the failed operation, when {@link partial} is set. */
  readonly partialAtOperation?: number;
}

// ---------------------------------------------------------------------------
// notebook_execute / execution_get / execution_cancel
// ---------------------------------------------------------------------------

/** One target of `notebook_execute` (SPEC.md §8 "Jobs"). */
export interface ExecuteTarget {
  readonly cellId: string;
  /**
   * Checked at acceptance and re-checked immediately before the cell is sent.
   * A mismatch stops the queue before that cell runs; the remaining cells get
   * `not_sent` with reason `revision_conflict`.
   */
  readonly expectedSourceRevision: SourceRevision;
}

/** Arguments of `notebook_execute`. */
export interface NotebookExecuteRequest extends WaitOptions {
  readonly notebookId: NotebookId;
  readonly requestId: RequestId;
  /**
   * Non-empty and ordered. Code cells only: an explicit target of another type
   * is `INVALID_ARGUMENT` *before* the job is accepted (SPEC.md §8).
   */
  readonly cells: readonly ExecuteTarget[];
  /**
   * Passed to the kernel and, by default, stops our own queue as well.
   * Default `true` (SPEC.md §8).
   */
  readonly stopOnError?: boolean;
  readonly limits?: ResponseLimits;
}

/** Per-cell view of a job. */
export interface ExecutionCellView {
  readonly cellId: string;
  readonly state: CellRunState;
  /** Revision of the text actually sent; later edits do not change it. */
  readonly sourceRevision: SourceRevision;
  /** `execute_request` header id; absent while the cell is still queued. */
  readonly msgId?: string;
  /** Final count, written to the shared model at completion only. */
  readonly executionCount?: number | null;
  /** Set on `not_sent`: this cell provably never reached the kernel. */
  readonly notSentReason?: NotSentReason;
  /** Set on `aborted`: the kernel really answered the request we sent. */
  readonly abortedReason?: AbortedReason;
  /** The cell text differs from the snapshot that was sent (SPEC.md §8). */
  readonly sourceChanged: boolean;
  /** The cell was deleted while running; it is not recreated for outputs. */
  readonly cellDeleted: boolean;
  /** Collection hit the budget; the kernel was *not* interrupted. */
  readonly outputIncomplete: boolean;
  /** Bounded outputs collected for this cell, in order. */
  readonly outputs: readonly OutputEntry[];
  /**
   * `true` when these entries replace the output state represented by the
   * request cursor. This also reports a clear as an empty replacement.
   */
  readonly outputsReset: boolean;
  /** `true` when {@link outputs} was cut by the response budget. */
  readonly outputsTruncated: boolean;
}

/**
 * The state of one job, as `notebook_execute` and `execution_get` return it.
 *
 * `state` and the per-cell states are results, never errors: a Python error is
 * `failed` with a reason, an interrupt is `interrupted`, a lost kernel without
 * sufficient evidence is `unknown` (SPEC.md §8, §9).
 */
export interface ExecutionView {
  readonly executionId: ExecutionId;
  readonly notebookId: NotebookId;
  readonly sessionId: SessionId;
  /** Kernel identity captured at acceptance; a change invalidates the job. */
  readonly kernelId: string | null;
  readonly state: JobState;
  readonly stopOnError: boolean;
  readonly cells: readonly ExecutionCellView[];
  /** RFC 3339 UTC. */
  readonly createdAt: string;
  readonly finishedAt?: string;
  /** Terminal reason for `failed` / `cancelled` / `interrupted` / `unknown`. */
  readonly reason?: string;
  /** Cursor for the next `execution_get`; it never repeats delivered output. */
  readonly cursor: ExecutionCursor;
  /** `true` when the answer came back because `wait_ms` elapsed. */
  readonly waitTimedOut: boolean;
  readonly lifetime: HandleLifetime;
}

/** Arguments of `execution_get`. */
export interface ExecutionGetRequest extends WaitOptions {
  readonly executionId: ExecutionId;
  /** Continue after this cursor; omitted, the whole current state is returned. */
  readonly cursor?: ExecutionCursor;
  readonly limits?: ResponseLimits;
}

/** Arguments of `execution_cancel`. */
export interface ExecutionCancelRequest {
  readonly executionId: ExecutionId;
}

/**
 * Result of `execution_cancel` (SPEC.md §8).
 *
 * Cancelling removes cells that were not sent yet. A cell already handed to
 * the kernel may be in its queue and is **not** safely cancelled; stopping it
 * needs an explicit `kernel_control` interrupt, which affects the whole
 * kernel, possibly another participant's code.
 */
export interface ExecutionCancelResult {
  readonly executionId: ExecutionId;
  readonly state: JobState;
  /** Cells removed from the queue, now `not_sent` with reason `cancelled`. */
  readonly cancelledCellIds: readonly string[];
  /** Cells already sent; their outcome stays whatever the kernel reports. */
  readonly alreadySentCellIds: readonly string[];
  /** Always `false`: cancelling never interrupts the kernel (SPEC.md §8). */
  readonly kernelInterrupted: boolean;
}

// ---------------------------------------------------------------------------
// output_read (SPEC.md §9)
// ---------------------------------------------------------------------------

/** Arguments of `output_read`. */
export interface OutputReadRequest {
  readonly outputId: OutputId;
  /**
   * The working context the caller reads from. A library caller names its own
   * session; an MCP connection omits it and addresses its implicit context. A
   * snapshot of any other context is not visible (SPEC.md §4).
   */
  readonly sessionId?: SessionId;
  /** Continue an earlier read; already delivered parts are not resent. */
  readonly cursor?: OutputCursor;
  readonly limits?: ResponseLimits;
}

/** One chunk of an output snapshot. */
export interface OutputReadResult {
  readonly outputId: OutputId;
  readonly uri: string;
  readonly outputType: string;
  /** MIME types of the whole snapshot, even when one part is returned. */
  readonly mimeTypes: readonly string[];
  /** MIME type of {@link data}. */
  readonly mimeType: string;
  /** `text` for textual MIME types, `base64` for binary ones. */
  readonly encoding: 'text' | 'base64';
  /** The part itself, within the response budget. */
  readonly data: string;
  /** Byte offset of this part inside the full snapshot. */
  readonly byteOffset: number;
  /** Full size of the snapshot in bytes. */
  readonly byteSize: number;
  readonly truncated: boolean;
  /** Present while unread bytes remain. */
  readonly nextCursor?: OutputCursor;
  readonly lifetime: HandleLifetime;
}

// ---------------------------------------------------------------------------
// notebook_changes (SPEC.md §10)
// ---------------------------------------------------------------------------

/** Arguments of `notebook_changes`. */
export interface NotebookChangesRequest extends WaitOptions {
  readonly notebookId: NotebookId;
  /** From an open/create/read answer, or from the previous changes answer. */
  readonly cursor: ChangesCursor;
  readonly limit?: number;
}

/** Result of `notebook_changes`. */
export interface NotebookChangesResult {
  readonly notebookId: NotebookId;
  /**
   * Events after the cursor, in journal order. Published `sequence` values are
   * never rewritten; frequent output updates arrive coalesced per cell
   * (SPEC.md §10).
   */
  readonly events: readonly ChangeEvent[];
  readonly nextCursor: ChangesCursor;
  /** `true` when the limit stopped the answer before the journal end. */
  readonly truncated: boolean;
  readonly connectionState: ConnectionState;
  readonly stale: boolean;
  /** `true` when the answer came back because `wait_ms` elapsed. */
  readonly waitTimedOut: boolean;
}

// ---------------------------------------------------------------------------
// notebook_save (SPEC.md §6 "Delivery and persistence")
// ---------------------------------------------------------------------------

/** Arguments of `notebook_save`. */
export interface NotebookSaveRequest {
  readonly notebookId: NotebookId;
  /** Clamped to `ServiceLimits.maxWaitMs`. */
  readonly timeoutMs?: number;
}

/**
 * Result of `notebook_save`.
 *
 * The two facts are deliberately separate: `saveStatus` reports what the
 * server said about *its* save operation. `revisionPersistence` is confirmed
 * only when a subsequent Contents API read matches the normalized snapshot
 * captured at request entry. This is point-in-time storage-provider evidence,
 * not a filesystem durability guarantee or proof of an earlier caller read.
 */
export interface NotebookSaveResult {
  readonly notebookId: NotebookId;
  /** `failed` never appears here: it is thrown as `SAVE_FAILED`. */
  readonly saveStatus: Exclude<SaveStatus, 'failed'>;
  readonly revisionPersistence: PersistenceState;
  readonly persistenceConfirmation: {
    readonly method: 'contents-api-readback';
    /** SHA-256 of the normalized snapshot captured at requestedAt, not raw file bytes. */
    readonly snapshotDigest: string;
    readonly observedAt: string;
  } | null;
  /** Structural revision at the moment the save was requested. */
  readonly structureRevision: StructureRevision;
  /** RFC 3339 UTC time the immutable target snapshot was captured. */
  readonly requestedAt: string;
  /**
   * `true` when the server may also have saved by its own `document_save_delay`
   * debounce. Autosave is not a confirmation of a specific revision either
   * (SPEC.md §6).
   */
  readonly autosaveEnabled: boolean;
}

// ---------------------------------------------------------------------------
// kernel_list / kernel_status / kernel_control (SPEC.md §8)
// ---------------------------------------------------------------------------

/** One kernelspec offered by the server. */
export interface KernelSpecInfo {
  readonly name: string;
  readonly displayName: string;
  readonly language: string;
}

/** One kernel currently running on the server. */
export interface RunningKernelInfo {
  readonly kernelId: string;
  readonly kernelName: string;
  /** Last activity as the server reports it; RFC 3339 or `null`. */
  readonly lastActivity: string | null;
  /** Connections the server counts, ours included. */
  readonly connections: number | null;
  /** Server-reported execution state; not our own observation. */
  readonly executionStatus: KernelExecutionStatus;
  /** Notebook paths bound to this kernel through the Sessions API. */
  readonly boundPaths: readonly string[];
}

/** Arguments of `kernel_list`. */
export interface KernelListRequest {
  readonly sessionId?: SessionId;
  readonly serverId?: string;
}

/** Result of `kernel_list`. Listing never executes code (SPEC.md §8). */
export interface KernelListResult {
  readonly kernelspecs: readonly KernelSpecInfo[];
  readonly defaultKernelName: string | null;
  readonly running: readonly RunningKernelInfo[];
}

/** Arguments of `kernel_status`. */
export interface KernelStatusRequest {
  readonly notebookId: NotebookId;
}

/**
 * Result of `kernel_status` (SPEC.md §8).
 *
 * The channel state and the execution status are separate facts, and the
 * execution status carries the time it was observed. A `busy` caused by
 * somebody else's request is reported although none of its outputs are written
 * by us. Losing the transport does not by itself prove `dead`.
 */
export interface KernelStatusResult {
  readonly notebookId: NotebookId;
  /** `null` when nothing is bound - reading or opening starts no kernel. */
  readonly kernelId: string | null;
  readonly kernelName: string | null;
  /** Jupyter Sessions API session bound to this notebook path, if any. */
  readonly jupyterSessionId: string | null;
  readonly channelState: KernelChannelState;
  readonly executionStatus: KernelExecutionStatus;
  /** RFC 3339 UTC time the execution status was observed. */
  readonly observedAt: string;
  /** Jobs of this notebook that are still active. */
  readonly activeExecutionIds: readonly ExecutionId[];
}

/**
 * `kernel_control` actions (SPEC.md §8, §9). Each action is its own branch of
 * the input schema.
 */
export type KernelAction = 'start' | 'interrupt' | 'restart' | 'shutdown' | 'switch';

/** Fields shared by every `kernel_control` branch. */
interface KernelControlBase {
  readonly notebookId: NotebookId;
  readonly requestId: RequestId;
}

/**
 * Bind a kernel to the notebook path through the Sessions API: reuse the
 * single existing session, or start one. `expectedKernelId: null` is the
 * verified statement "nothing is bound"; a different binding gives
 * `KERNEL_CHANGED`, and several ambiguous bindings give
 * `KERNEL_SELECTION_REQUIRED`.
 */
export interface KernelStartRequest extends KernelControlBase {
  readonly action: 'start';
  readonly expectedKernelId: string | null;
  /** Omitted, the server default kernelspec is used. */
  readonly kernelName?: string;
}

/**
 * Interrupt the bound kernel. This is an operation on the whole kernel and may
 * affect another participant's code (SPEC.md §8); neither an MCP timeout nor a
 * cancelled wait ever triggers it.
 */
export interface KernelInterruptRequest extends KernelControlBase {
  readonly action: 'interrupt';
  readonly expectedKernelId: string;
}

/**
 * Restart the bound kernel. It clears no outputs and re-runs no cells
 * (SPEC.md §8); unfinished jobs are invalidated.
 */
export interface KernelRestartRequest extends KernelControlBase {
  readonly action: 'restart';
  readonly expectedKernelId: string;
}

/** Shut the bound kernel down. Never implied by any close (SPEC.md §4). */
export interface KernelShutdownRequest extends KernelControlBase {
  readonly action: 'shutdown';
  readonly expectedKernelId: string;
}

/** Rebind the notebook to a kernel of another kernelspec. */
export interface KernelSwitchRequest extends KernelControlBase {
  readonly action: 'switch';
  /** `null` only when the notebook is verified to have no binding. */
  readonly expectedKernelId: string | null;
  readonly kernelName: string;
}

/** Discriminated union of the `kernel_control` branches. */
export type KernelControlRequest =
  | KernelStartRequest
  | KernelInterruptRequest
  | KernelRestartRequest
  | KernelShutdownRequest
  | KernelSwitchRequest;

/** What a `kernel_control` call actually did (SPEC.md §9: explicit effects). */
export interface KernelControlEffects {
  readonly kernelStarted: boolean;
  readonly kernelInterrupted: boolean;
  readonly kernelRestarted: boolean;
  readonly kernelShutDown: boolean;
  /** The notebook is now bound to a different kernel than before. */
  readonly bindingChanged: boolean;
  /** Jobs invalidated by this action; their sent work becomes `unknown`. */
  readonly invalidatedExecutionIds: readonly ExecutionId[];
  /** Always `false`: no kernel action clears outputs (SPEC.md §8). */
  readonly outputsCleared: boolean;
}

/** Result of `kernel_control`. */
export interface KernelControlResult {
  readonly notebookId: NotebookId;
  readonly action: KernelAction;
  readonly previousKernelId: string | null;
  /** `null` after a shutdown. */
  readonly kernelId: string | null;
  readonly kernelName: string | null;
  readonly jupyterSessionId: string | null;
  readonly effects: KernelControlEffects;
  /** Status observed right after the action; `starting` is a normal answer. */
  readonly status: KernelStatusResult;
}

// ---------------------------------------------------------------------------
// MCP resources (SPEC.md §9 "For custom `jupyter-output:` URIs")
// ---------------------------------------------------------------------------

/** One row of `resources/list`; the list may legitimately be empty. */
export interface OutputResourceDescriptor {
  readonly uri: string;
  readonly outputId: OutputId;
  /** Short human-readable name, e.g. `cell 3 · image/png`. */
  readonly name: string;
  readonly mimeType: string;
  readonly byteSize: number;
  readonly executionId: ExecutionId;
  readonly notebookId: NotebookId;
  readonly lifetime: HandleLifetime;
}

/** Result of `listOutputResources`. */
export interface ListOutputResourcesResult {
  readonly resources: readonly OutputResourceDescriptor[];
  readonly nextCursor?: string;
}

/**
 * A `resources/read` answer for one `jupyter-output:` URI.
 *
 * `resources/read` has its own budget (`ServiceLimits.resourceReadMaxBytes`).
 * When the snapshot does not fit, no partial blob is invented: `truncated` is
 * `true`, the payload is omitted and {@link continueWith} names the
 * `output_read` call that pages through it under the response limit
 * (SPEC.md §9).
 */
export interface OutputResourceContents {
  readonly uri: string;
  readonly outputId: OutputId;
  readonly mimeType: string;
  /** Present for textual MIME types within the budget. */
  readonly text?: string;
  /** Base64 payload for binary MIME types within the budget. */
  readonly blob?: string;
  readonly byteSize: number;
  readonly truncated: boolean;
  /** Set when the caller must fall back to the tool. */
  readonly continueWith?: {
    readonly tool: 'output_read';
    readonly outputId: OutputId;
    readonly cursor?: OutputCursor;
  };
  readonly lifetime: HandleLifetime;
}

/** Why the process is shutting down; used for diagnostics on stderr only. */
export type ShutdownReason = 'eof' | 'signal' | 'client_request' | 'fatal_error';

// ---------------------------------------------------------------------------
// the facade
// ---------------------------------------------------------------------------

/**
 * Everything the MCP adapter is allowed to call.
 *
 * Concurrency (SPEC.md §9): reads, waits, cancellations of a wait and calls of
 * *different* working sessions may run in parallel. The four deduplicated
 * mutations of one session - {@link CollabService.notebookCreate},
 * {@link CollabService.notebookApply}, {@link CollabService.notebookExecute},
 * {@link CollabService.kernelControl} - are serialised by the session lock and
 * expect the caller to send the next one only after the previous answer.
 *
 * Request numbers (SPEC.md §9, checked under that lock, in this order):
 *
 * 1. the number is in the receipt registry - same payload digest replays the
 *    stored result with `replayed: true` and the original `firstAcceptedAt`;
 *    a different payload is `REQUEST_ID_CONFLICT`;
 * 2. the number is missing but `<= H` - `REQUEST_ID_EXPIRED`, nothing runs;
 * 3. the number is `> H + 1` - `REQUEST_OUT_OF_ORDER`;
 * 4. the number is `H + 1` - preconditions and the memory reserve are checked,
 *    then the receipt is created and `H` bumped **before the first effect**.
 *
 * An error raised before step 4 completes does not consume the number
 * (`requestAccepted: false`); after it, the number is spent even when the
 * operation fails or ends unknown (`requestAccepted: true`).
 */
export interface CollabService {
  // -- servers and working sessions ----------------------------------------

  /**
   * Safe descriptors of every configured and (if enabled) discovered server.
   * Never returns a credential, and never a token-carrying URL (SPEC.md §11).
   *
   * Not session-scoped: no envelope, no request number.
   *
   * @throws {CoreError} `INTERNAL_ERROR` - unexpected failure while building
   * the list. A server being unreachable is not an error here: it is simply a
   * descriptor whose reachability is unknown.
   */
  serverList(): Promise<ServerListResult>;
  serverStatus(request: ServerStatusRequest): Promise<ServerStatusResult>;
  serverStart(request: ServerStartRequest): Promise<WithEnvelope<ServerStatusResult>>;

  /**
   * Open a working session on one server. Starts no kernel and opens no
   * document (SPEC.md §9).
   *
   * The answer is the first place `nextRequestId` appears, and it is `"1"`.
   * Repeating `session_open` creates a *separate* working session; it is not
   * deduplicated and takes no `request_id`.
   *
   * @throws {CoreError} `SERVER_SELECTION_REQUIRED` - no `serverId` and more
   * than one server is available.
   * @throws {CoreError} `SERVER_NOT_FOUND` - the id is not configured.
   * @throws {CoreError} `AUTH_REQUIRED` / `PERMISSION_DENIED` - the credential
   * is missing or rejected by that server.
   * @throws {CoreError} `NETWORK_ERROR` - the server could not be reached; the
   * call had no effect and may be retried.
   * @throws {CoreError} `RESOURCE_LIMIT` - `maxSessions` reached; active
   * sessions are never evicted for a new one.
   * @throws {CoreError} `INVALID_ARGUMENT`, `INTERNAL_ERROR`.
   */
  sessionOpen(request: SessionOpenRequest): Promise<WithEnvelope<SessionOpenResult>>;

  /**
   * Close a working session: its notebooks, replicas, journals, jobs and
   * output snapshots. Kernels and the Jupyter server keep running
   * (SPEC.md §4).
   *
   * Repeatable by handle and not deduplicated: a second call on a handle this
   * process still remembers returns `alreadyClosed: true`. The envelope of the
   * answer carries `nextRequestId: null` - the session accepts nothing more.
   *
   * @throws {CoreError} `EXECUTION_ACTIVE` - a job of this session is still
   * active and `force` was not set; finish it or interrupt it explicitly.
   * @throws {CoreError} `HANDLE_EXPIRED` - a handle this process never issued
   * (for example after a restart).
   * @throws {CoreError} `INTERNAL_ERROR`.
   */
  sessionClose(request: SessionCloseRequest): Promise<WithEnvelope<SessionCloseResult>>;

  // -- documents ------------------------------------------------------------

  /**
   * List notebooks and directories under `directory`, together with whatever
   * Jupyter session information the server reports. Contents are listed
   * without loading file bodies (SPEC.md §6 item 2).
   *
   * Read-only: no request number, `requestAccepted` absent.
   *
   * @throws {CoreError} `HANDLE_EXPIRED` - unknown or closed session.
   * @throws {CoreError} `INVALID_ARGUMENT` - a path escaping the Jupyter root
   * (`..`) or an otherwise malformed directory (SPEC.md §11).
   * @throws {CoreError} `NOTEBOOK_NOT_FOUND` - the directory does not exist.
   * @throws {CoreError} `PERMISSION_DENIED`, `AUTH_REQUIRED`,
   * `NETWORK_ERROR`, `CURSOR_EXPIRED`, `INTERNAL_ERROR`.
   */
  notebookList(request: NotebookListRequest): Promise<WithEnvelope<NotebookListResult>>;

  /**
   * Create a notebook and open it (SPEC.md §6 "notebook creation"):
   * allocate an untitled file in `directory`, rename it through Contents
   * `PATCH` when `name` was given, and only then open the RTC room of the
   * final path.
   *
   * Deduplicated. The number is consumed the moment the receipt is created,
   * which happens **before** the untitled file is allocated. Therefore:
   *
   * - a rejection during argument validation, session/limit checks or server
   *   selection leaves the number unused (`requestAccepted: false`);
   * - every failure after that reports `requestAccepted: true`, and the error
   *   carries the actual untitled path when a file was already created.
   *
   * @throws {CoreError} `ALREADY_EXISTS` - the rename target exists (Contents
   * 409). The untitled file stays on the server, is not deleted, and the error
   * details carry its path with `side_effects: applied`; the room is not
   * opened.
   * @throws {CoreError} `PERMISSION_DENIED` - Contents 403. Same reporting as
   * `ALREADY_EXISTS` when the untitled file was already allocated; plain
   * `none` when the refusal happened before the allocation.
   * @throws {CoreError} `OPERATION_UNCERTAIN` - the rename was sent but its
   * confirmation was lost. Both the old and the intended path are reported for
   * inspection; nothing is re-sent and no state is guessed.
   * @throws {CoreError} `INVALID_ARGUMENT` - `name` contains a path separator,
   * lacks `.ipynb`, or `directory` escapes the root.
   * @throws {CoreError} `REQUEST_ID_CONFLICT`, `REQUEST_OUT_OF_ORDER`,
   * `REQUEST_ID_EXPIRED` - the ledger rules; none of them executes anything.
   * @throws {CoreError} `RESOURCE_LIMIT` - `maxOpenNotebooks`, or no room for
   * a receipt, checked before any effect.
   * @throws {CoreError} `HANDLE_EXPIRED`, `AUTH_REQUIRED`, `NETWORK_ERROR`,
   * `NOTEBOOK_NOT_FOUND` (directory), the terminal RTC codes
   * (`RTC_SESSION_REJECTED`, `RTC_BAD_REQUEST`, `RTC_INITIALIZATION_FAILED`,
   * `RTC_CONFLICT`), `DOCUMENT_TOO_LARGE`, `INTERNAL_ERROR`.
   */
  notebookCreate(request: NotebookCreateRequest): Promise<WithEnvelope<NotebookCreateResult>>;

  /**
   * Open a notebook by path and return a reusable handle (SPEC.md §6).
   *
   * A live handle for the same `fileId` in this session is returned as is -
   * no second `Y.Doc` and no second WebSocket - and concurrent opens of the
   * same document coalesce into one operation (SPEC.md §4). Two *different*
   * working sessions deliberately get two replicas.
   *
   * Read-only with respect to the ledger: not deduplicated, no request number.
   *
   * @throws {CoreError} `NOTEBOOK_NOT_FOUND` - the path does not exist, or the
   * room answered 4404.
   * @throws {CoreError} `RTC_SESSION_REJECTED` - 1003 with `unknown_session`
   * or `version_mismatch`; this `Y.Doc` is never synchronised again.
   * @throws {CoreError} `RTC_BAD_REQUEST` - close code 4400.
   * @throws {CoreError} `RTC_INITIALIZATION_FAILED` - 1003 with
   * `initialization_error`, an unparseable reason, or the 4500 retry budget
   * exhausted.
   * @throws {CoreError} `RTC_CONFLICT` - a RAW `{"type":"conflict"}` frame
   * arrived during the initial sync.
   * @throws {CoreError} `NOT_READY` - readiness (`synced` and `nbformat`
   * defined) was not reached within the wait; retryable.
   * @throws {CoreError} `RESOURCE_LIMIT` - `maxOpenNotebooks` reached.
   * @throws {CoreError} `HANDLE_EXPIRED`, `INVALID_ARGUMENT`,
   * `PERMISSION_DENIED`, `AUTH_REQUIRED`, `NETWORK_ERROR`,
   * `DOCUMENT_TOO_LARGE`, `INTERNAL_ERROR`.
   */
  notebookOpen(request: NotebookOpenRequest): Promise<WithEnvelope<NotebookOpenResult>>;

  /**
   * Release one replica: its socket, observers, journal and page cursors. The
   * kernel is left running (SPEC.md §4).
   *
   * Repeatable by handle, not deduplicated.
   *
   * @throws {CoreError} `EXECUTION_ACTIVE` - a job of this notebook is active
   * and `force` was not set.
   * @throws {CoreError} `HANDLE_EXPIRED` - unknown handle.
   * @throws {CoreError} `INTERNAL_ERROR`.
   */
  notebookClose(request: NotebookCloseRequest): Promise<WithEnvelope<NotebookCloseResult>>;

  /**
   * Read the notebook: `summary`, `cells` or `outputs` (SPEC.md §9).
   *
   * The snapshot and `changesCursor` are taken together, with no `await`
   * between reading the model and fixing the journal boundary, so nothing can
   * be lost in between. Before readiness the existing snapshot is still
   * served, marked `stale`.
   *
   * Read-only, and the cheapest way for an agent to recover `nextRequestId`
   * after losing its counter (SPEC.md §10 item 3).
   *
   * @throws {CoreError} `HANDLE_EXPIRED` - unknown or closed handle.
   * @throws {CoreError} `CURSOR_EXPIRED` - the page cursor does not match the
   * current structural revision; take a new snapshot.
   * @throws {CoreError} `CELL_NOT_FOUND` - an explicitly requested id is gone.
   * @throws {CoreError} `CELL_ID_AMBIGUOUS` - a requested id currently
   * addresses more than one cell.
   * @throws {CoreError} `INVALID_ARGUMENT` - `cellIds` together with `cursor`,
   * or a limit that is not a positive number.
   * @throws {CoreError} `DOCUMENT_TOO_LARGE` - the document exceeds the
   * configured budget; the shared model is never truncated to fit.
   * @throws {CoreError} `INTERNAL_ERROR`.
   */
  notebookRead<R extends NotebookReadRequest>(
    request: R
  ): Promise<WithEnvelope<NotebookReadResultFor<R>>>;

  /**
   * Apply a batch of operations to the shared model (SPEC.md §7, §9).
   *
   * The whole batch is validated against the current replica first, then
   * applied in one synchronous transaction with this connection's origin. Any
   * expected error is therefore raised before the first mutation; an
   * unexpected failure in the middle is reported with `partial: true` and the
   * caller re-reads the affected cells.
   *
   * Deduplicated. The receipt is created and `H` bumped before the
   * transaction; validation errors listed below happen *before* acceptance and
   * leave the number unused, except where noted.
   *
   * @throws {CoreError} `NOT_READY` - the replica is not ready and the RTC
   * state is recoverable; retryable, nothing was written.
   * @throws {CoreError} `RTC_SESSION_REJECTED`, `RTC_CONFLICT`,
   * `FILE_ID_CHANGED`, `RTC_INITIALIZATION_FAILED` - the handle is terminally
   * unusable; open the document again explicitly.
   * @throws {CoreError} `CELL_NOT_FOUND`, `CELL_ID_AMBIGUOUS`,
   * `CELL_REPLACED` - the target or an anchor vanished, is duplicated, or is a
   * different CRDT object than the revision refers to.
   * @throws {CoreError} `REVISION_CONFLICT` - an `expected_*` revision does not
   * match; nothing in the batch was applied.
   * @throws {CoreError} `MATCH_NOT_FOUND`, `MATCH_NOT_UNIQUE` - `replace_text`
   * found no match, or more than one.
   * @throws {CoreError} `INVALID_ARGUMENT` - an empty batch, a revision digest
   * of the wrong kind, an `add_cell` without exactly one anchor.
   * @throws {CoreError} `UNSUPPORTED_OPERATION` - changing a cell type or
   * writing attachments; both are deliberately out of the first version.
   * @throws {CoreError} `REQUEST_ID_CONFLICT`, `REQUEST_OUT_OF_ORDER`,
   * `REQUEST_ID_EXPIRED`, `RESOURCE_LIMIT` - ledger and budget checks, all
   * before any effect.
   * @throws {CoreError} `HANDLE_EXPIRED`, `DOCUMENT_TOO_LARGE`,
   * `INTERNAL_ERROR` (`side_effects: unknown` once the transaction started).
   */
  notebookApply(request: NotebookApplyRequest): Promise<WithEnvelope<NotebookApplyResult>>;

  // -- execution ------------------------------------------------------------

  /**
   * Queue an ordered list of code cells on the bound kernel (SPEC.md §8).
   *
   * Cells are sent one at a time: the next one goes out after `execute_reply`
   * plus `idle` of the previous one and a fresh check of the target. Right
   * before a cell is sent, a single shared-model transaction clears its
   * outputs, sets `execution_count` to `null`, drops the previous `execution`
   * timing metadata and sets `execution_state` to `running`; the final count
   * and `idle` are written only at completion, and only while this generation
   * still owns the output area.
   *
   * `waitMs` waits for terminal completion or the bounded deadline. Intermediate
   * updates do not end this wait. A timed-out job continues and is read with
   * {@link executionGet}. Waiting holds no mutation lock and never resends code.
   *
   * Deduplicated. The receipt is created before the first output-area
   * generation is started, so a replay never runs the cells twice.
   *
   * @throws {CoreError} `KERNEL_NOT_BOUND` - no kernel is bound; raised before
   * any output is cleared and before any code is sent.
   * @throws {CoreError} `KERNEL_SELECTION_REQUIRED` - several ambiguous
   * Sessions API bindings for this path.
   * @throws {CoreError} `INVALID_ARGUMENT` - an empty list, or a target that
   * is not a code cell; raised before the job is accepted.
   * @throws {CoreError} `CELL_NOT_FOUND`, `CELL_ID_AMBIGUOUS`,
   * `CELL_REPLACED`, `REVISION_CONFLICT` - the target check at acceptance
   * failed. A mismatch discovered *later*, just before a cell is sent, is not
   * an error: that cell and the rest become `not_sent`.
   * @throws {CoreError} `NOT_READY` - the replica is not ready; no code is
   * sent while outputs cannot be written.
   * @throws {CoreError} `UNSUPPORTED_EXECUTION_MODE` - the configured
   * execution mode is not the one this version implements; raised before the
   * launch, and the client never silently switches modes.
   * @throws {CoreError} `EXECUTION_ACTIVE` - this notebook already has an
   * active job.
   * @throws {CoreError} `REQUEST_ID_CONFLICT`, `REQUEST_OUT_OF_ORDER`,
   * `REQUEST_ID_EXPIRED`, `RESOURCE_LIMIT` - before any effect.
   * @throws {CoreError} `HANDLE_EXPIRED`, the terminal RTC codes,
   * `INTERNAL_ERROR`.
   */
  notebookExecute(request: NotebookExecuteRequest): Promise<WithEnvelope<ExecutionView>>;

  /**
   * Read a job: status, new outputs since `cursor` and references for reading
   * payloads. With `waitMs` it waits for the next change instead of polling; a
   * long computation blocks neither reads, nor RTC updates, nor kernel
   * control (SPEC.md §8).
   *
   * Not deduplicated, no request number.
   *
   * @throws {CoreError} `HANDLE_EXPIRED` - unknown job, or its session closed.
   * @throws {CoreError} `CURSOR_EXPIRED` - the execution cursor is no longer
   * in the buffer; re-read the job without a cursor.
   * @throws {CoreError} `INVALID_ARGUMENT`, `INTERNAL_ERROR`.
   */
  executionGet(request: ExecutionGetRequest): Promise<WithEnvelope<ExecutionView>>;

  /**
   * Drop the cells of a job that have not been sent yet (SPEC.md §8).
   *
   * Repeatable by handle and not deduplicated. It sends nothing to the kernel:
   * a cell already in the kernel's queue is not safely cancelled, and stopping
   * it requires an explicit interrupt.
   *
   * @throws {CoreError} `HANDLE_EXPIRED` - unknown job.
   * @throws {CoreError} `INTERNAL_ERROR`.
   */
  executionCancel(request: ExecutionCancelRequest): Promise<WithEnvelope<ExecutionCancelResult>>;

  /**
   * Read one part of an immutable output snapshot for hosts that do not read
   * MCP resources - and for payloads too large for a single answer
   * (SPEC.md §9). Continuing with `cursor` never resends delivered parts.
   *
   * Not deduplicated. Scoped to the caller's working context: an `output_id`
   * produced by another context is not readable here.
   *
   * @throws {CoreError} `HANDLE_EXPIRED` - the snapshot expired, its session
   * closed, or it belongs to another working context.
   * @throws {CoreError} `CURSOR_EXPIRED` - unusable output cursor.
   * @throws {CoreError} `INVALID_ARGUMENT`, `INTERNAL_ERROR`.
   */
  outputRead(request: OutputReadRequest): Promise<WithEnvelope<OutputReadResult>>;

  // -- observation and saving ----------------------------------------------

  /**
   * Journal events after `cursor` (SPEC.md §10). Output updates arrive
   * coalesced per cell; source, structure and generation boundaries are never
   * lost to that coalescing, and published `sequence` values never change.
   *
   * Not deduplicated.
   *
   * @throws {CoreError} `CURSOR_EXPIRED` - that sequence is no longer in the
   * journal (overflow, or a reconnect that reset it); take a new snapshot and
   * observe from its cursor.
   * @throws {CoreError} `HANDLE_EXPIRED`, `INVALID_ARGUMENT`,
   * `INTERNAL_ERROR`.
   */
  notebookChanges(request: NotebookChangesRequest): Promise<WithEnvelope<NotebookChangesResult>>;

  /**
   * Ask the collaborative provider to save, and report what the server said
   * (SPEC.md §6 "Delivery and persistence").
   *
   * Not deduplicated on purpose: repeating a save may store a newer state, so
   * it is never announced as a replay. `skipped` and `timeout` come back as
   * results - neither is presented as success, and a timeout does not mean the
   * write failed.
   *
   * @throws {CoreError} `SAVE_FAILED` - the server answered `failed`;
   * `side_effects: unknown`, check the document state and the reason.
   * @throws {CoreError} `OPERATION_UNCERTAIN` - the connection ended
   * terminally with the save in flight.
   * @throws {CoreError} `NOT_READY` - the replica is not ready; retryable.
   * @throws {CoreError} `RTC_CONFLICT`, `RTC_SESSION_REJECTED`,
   * `FILE_ID_CHANGED` - the handle is unusable, the document must be reopened.
   * @throws {CoreError} `HANDLE_EXPIRED`, `INTERNAL_ERROR`.
   */
  notebookSave(request: NotebookSaveRequest): Promise<WithEnvelope<NotebookSaveResult>>;

  // -- kernels --------------------------------------------------------------

  /**
   * Kernelspecs and running kernels of the session's server. Executes no code
   * and starts nothing (SPEC.md §8).
   *
   * Read-only; a convenient way to recover `nextRequestId`.
   *
   * @throws {CoreError} `HANDLE_EXPIRED`, `AUTH_REQUIRED`,
   * `PERMISSION_DENIED`, `NETWORK_ERROR`, `INTERNAL_ERROR`.
   */
  kernelList(request: KernelListRequest): Promise<WithEnvelope<KernelListResult>>;

  /**
   * Binding and observed kernel status of one notebook (SPEC.md §8).
   * Never starts a kernel: an unbound notebook answers with `kernelId: null`
   * rather than an error.
   *
   * @throws {CoreError} `HANDLE_EXPIRED` - unknown or closed notebook handle.
   * @throws {CoreError} `KERNEL_SELECTION_REQUIRED` - several ambiguous
   * Sessions API bindings exist for this path, so no single status can be
   * reported.
   * @throws {CoreError} `AUTH_REQUIRED`, `PERMISSION_DENIED`,
   * `NETWORK_ERROR`, `INTERNAL_ERROR`.
   */
  kernelStatus(request: KernelStatusRequest): Promise<WithEnvelope<KernelStatusResult>>;

  /**
   * Start, interrupt, restart, shut down or switch the notebook's kernel
   * (SPEC.md §8, §9). Every branch requires `expectedKernelId`, so an action
   * cannot land on a kernel the agent did not mean.
   *
   * Deduplicated. The receipt is created after the binding check and before
   * the request reaches the server, so a replay never restarts or shuts down a
   * kernel twice.
   *
   * @throws {CoreError} `KERNEL_CHANGED` - the binding differs from
   * `expectedKernelId`, including a change made from the browser.
   * @throws {CoreError} `KERNEL_NOT_BOUND` - `interrupt` / `restart` /
   * `shutdown` on a notebook with no binding.
   * @throws {CoreError} `KERNEL_SELECTION_REQUIRED` - several ambiguous
   * bindings for this path; choose explicitly.
   * @throws {CoreError} `INVALID_ARGUMENT` - an unknown kernelspec name, or
   * `expectedKernelId: null` on an action that requires a bound kernel.
   * @throws {CoreError} `OPERATION_UNCERTAIN` - the command was sent and its
   * confirmation was lost; the effect is not re-issued and the state is not
   * guessed.
   * @throws {CoreError} `REQUEST_ID_CONFLICT`, `REQUEST_OUT_OF_ORDER`,
   * `REQUEST_ID_EXPIRED`, `RESOURCE_LIMIT` - before any effect.
   * @throws {CoreError} `HANDLE_EXPIRED`, `AUTH_REQUIRED`,
   * `PERMISSION_DENIED`, `NETWORK_ERROR`, `INTERNAL_ERROR`.
   */
  kernelControl(request: KernelControlRequest): Promise<WithEnvelope<KernelControlResult>>;

  // -- MCP resources --------------------------------------------------------

  /**
   * Serve one `jupyter-output:` URI for `resources/read` (SPEC.md §9).
   *
   * The snapshot is immutable and is not recreated on every read. A payload
   * above `ServiceLimits.resourceReadMaxBytes` is not inlined: the answer is
   * marked `truncated` and points at `output_read`.
   *
   * Resolved inside one working context, in either URI form: a library caller
   * names its session, an MCP connection omits it and reads its implicit
   * context. A URI of another context resolves to nothing. No envelope: the
   * answer is the snapshot alone (SPEC.md §4).
   *
   * @throws {CoreError} `HANDLE_EXPIRED` - the snapshot expired, its working
   * session was closed, or it belongs to another working context.
   * @throws {CoreError} `INVALID_ARGUMENT` - the URI is not a
   * `jupyter-output:` URI this process issued.
   * @throws {CoreError} `INTERNAL_ERROR`.
   */
  readOutputResource(uri: string, sessionId?: SessionId): Promise<OutputResourceContents>;

  /**
   * List the live output snapshots of one working context for `resources/list`
   * - the caller's session, or the implicit context when none is named. May
   * legitimately be empty; snapshots handed out as tool `resource_link`s need
   * not appear here (SPEC.md §9). Subscriptions are not implemented.
   *
   * @throws {CoreError} `HANDLE_EXPIRED` - unknown or closed session.
   * @throws {CoreError} `INVALID_ARGUMENT` - unusable cursor.
   * @throws {CoreError} `INTERNAL_ERROR`.
   */
  listOutputResources(cursor?: string, sessionId?: SessionId): Promise<ListOutputResourcesResult>;

  // -- process --------------------------------------------------------------

  /**
   * Stop accepting work, try to flush pending updates within a short deadline
   * and release every connection (SPEC.md §4).
   *
   * Kernels and the Jupyter server are left running. Never throws: shutdown
   * problems are reported on stderr, because stdout belongs to MCP alone
   * (SPEC.md §11). An abrupt process end guarantees neither the delivery of
   * unsent changes nor the collection of further outputs.
   */
  shutdown(reason: ShutdownReason): Promise<void>;
}

/**
 * Re-exported so an implementation file needs one import for the whole
 * contract. `CellSummary` is the row type inside {@link NotebookSummary}.
 */
export type { CellSummary, NotebookSummary, CoreError };
