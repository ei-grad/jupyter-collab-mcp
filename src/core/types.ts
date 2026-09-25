/**
 * Shared contracts every module of the client implements against.
 *
 * Nothing here executes: these are the types that `src/jupyter` (transport),
 * `src/core/notebook` (shared model), `src/kernel` (execution) and `src/mcp`
 * (adapter) all agree on. Field names are camelCase inside the process; the
 * MCP adapter is the only place that renames them to the snake_case wire form
 * shown in SPEC.md §9.
 *
 * nbformat output types are declared here on purpose rather than imported from
 * `@jupyterlab/nbformat`: the core must stay dependency-free (SPEC.md §4, the
 * core is independent of MCP and of the transport libraries).
 *
 * @module
 */

import type {
  CellRevision,
  NotebookMetadataRevision,
  OutputsRevision,
  SourceRevision,
  StructureRevision
} from './revision.js';

// ---------------------------------------------------------------------------
// connection (SPEC.md §6)
// ---------------------------------------------------------------------------

/**
 * RTC connection state of one notebook replica (SPEC.md §6).
 *
 * - `connecting`   - the room socket is being opened;
 * - `syncing`      - socket open, initial or post-reconnect sync in flight;
 * - `ready`        - `provider.synced` and `nbformat` is defined. The spike
 *   showed that "at least one cell exists" is not a readiness signal: a fresh
 *   notebook arrives with one server-created empty code cell while `nbformat`
 *   is still `undefined` (spike/NOTES.md §4);
 * - `reconnecting` - transport lost without a terminal signal; the replica is
 *   kept and the same `fileId` re-checked before it goes back to `syncing`;
 * - `conflict`     - a RAW `{"type":"conflict"}` frame arrived; sending updates
 *   and writing outputs stops immediately, then the handle goes to `failed`;
 * - `closed`       - released by `notebook_close` / `session_close`;
 * - `failed`       - terminal; the stored RTC error code is returned by every
 *   further write.
 *
 * Reads before readiness are served from the current snapshot and marked
 * `stale`; writes and executions return `NOT_READY` while recoverable, or the
 * stored terminal RTC code once `failed`.
 */
export type ConnectionState =
  | 'connecting'
  | 'syncing'
  | 'ready'
  | 'reconnecting'
  | 'conflict'
  | 'closed'
  | 'failed';

// ---------------------------------------------------------------------------
// server profile (docs/CONNECTIONS.md §9)
// ---------------------------------------------------------------------------

/**
 * Reference to a secret, never the secret itself (docs/CONNECTIONS.md §9,
 * SPEC.md §11).
 *
 * - `env:NAME`   - read from `process.env.NAME` at resolution time;
 * - `file:PATH`  - read from a file, trimmed of trailing newline;
 * - `literal:..` - **tests only**. Never accept it from a config file that a
 *   tool argument could influence, and never log a profile that carries one.
 */
export type CredentialRef = `env:${string}` | `file:${string}` | `literal:${string}`;

/** `standalone` Jupyter Server, or a JupyterHub-managed user server. */
export type ServerKind = 'standalone' | 'jupyterhub';

/** Operator-controlled authentication, never accepted as tool input. */
export interface UpstreamAuth {
  readonly credentialRef: CredentialRef;
  readonly auth?: { readonly type: 'token' } | { readonly type: 'header'; readonly name: string };
  readonly credentialRefresh?: 'request';
  readonly credentialExpiry?: 'jwt';
  readonly credentialExpiresAt?: number;
}

export interface ServerStartProfile {
  readonly id: string;
  readonly title: string;
  readonly description?: string;
  readonly default?: boolean;
  readonly userOptions: Readonly<Record<string, unknown>>;
}

/** Optional control plane. Adapter URLs name the complete lifecycle endpoint. */
export interface HubLifecycleConfig extends UpstreamAuth {
  readonly apiBaseUrl: string;
  readonly protocol?: 'jupyterhub' | 'adapter-v1';
  readonly startProfiles?: readonly ServerStartProfile[];
}

/**
 * Operator-supplied upstream profile (docs/CONNECTIONS.md §9).
 *
 * Tools only ever choose an allowed `id`; they never pass URLs or credentials
 * (SPEC.md §11). `server_list` returns a redacted view of this - see
 * {@link ServerDescriptor}.
 */
export interface ServerProfile {
  /** Stable name used as `server_id` in tool arguments. */
  readonly id: string;
  readonly kind: ServerKind;
  /**
   * Final server API base including any prefix such as `/user/name/`, with no
   * trailing `/api`. This is the origin credentials may be sent to.
   */
  readonly apiBaseUrl?: string;
  /** Explicit allowed WS base; normally derived from {@link apiBaseUrl}. */
  readonly wsBaseUrl?: string;
  /**
   * The same server as the human reaches it. Display only - never used for API
   * requests, and never substituted for {@link apiBaseUrl}.
   */
  readonly browserBaseUrl?: string;
  readonly credentialRef?: CredentialRef;
  /** Re-read a file assertion for each new request or handshake. */
  readonly credentialRefresh?: 'request';
  /** Reject expired assertions and close sockets at their JWT expiry. */
  readonly credentialExpiry?: 'jwt';
  /** Optional absolute grant deadline, in epoch seconds. */
  readonly credentialExpiresAt?: number;
  /** Omitted means Jupyter token authentication. Header values are raw. */
  readonly auth?: { readonly type: 'token' } | { readonly type: 'header'; readonly name: string };
  /** Separate Hub control API, only for explicitly allowed lifecycle calls. */
  readonly hubApiBaseUrl?: string;
  readonly hubUser?: string;
  readonly hubServerName?: string;
  readonly hubCredentialRef?: CredentialRef;
  readonly hub?: HubLifecycleConfig;
  /** Explicit trust configuration. Never a switch that disables TLS checks. */
  readonly tlsCaRef?: string;
  readonly proxyAuthRef?: string;
}

/** Credential-free descriptor returned by `server_list` (SPEC.md §9, §11). */
export interface ServerDescriptor {
  readonly id: string;
  readonly kind: ServerKind;
  readonly apiBaseUrl?: string;
  readonly browserBaseUrl?: string;
  readonly hubUser?: string;
  readonly hubServerName?: string;
  readonly supportsStart?: boolean;
}

/**
 * A profile with its credential resolved, ready for the transport layer.
 *
 * `token` lives only inside the process. It must not reach stdout, log lines,
 * exception messages, resource URIs or MCP responses (SPEC.md §11); when a
 * WebSocket URL has to carry it in the query string, that URL is redacted
 * before logging.
 */
export interface ResolvedServer {
  readonly profile: ServerProfile;
  /** Normalised, no trailing slash. */
  readonly apiBaseUrl: string;
  /** Normalised `ws://` / `wss://` base, no trailing slash. */
  readonly wsBaseUrl: string;
  readonly token: string;
  /** External assertion header; token is empty in this mode. */
  readonly authHeaders?: Readonly<Record<string, string>>;
  readonly resolveAuthHeaders?: () => Readonly<Record<string, string>>;
}

// ---------------------------------------------------------------------------
// cells (SPEC.md §7)
// ---------------------------------------------------------------------------

/** Cell types the first version can create. Type changes are deferred. */
export type CellType = 'code' | 'markdown' | 'raw';

/**
 * Shared execution state carried in the cell's `execution_state` field
 * (`@jupyter/ydoc` `YCodeCell`). JupyterLab 4.6.3 renders `[*]` from it, so it
 * is written by the owner of the current output generation only (SPEC.md §8).
 */
export type SharedExecutionState = 'running' | 'idle';

/**
 * A cell address. `cellId` is the durable one; `index` is for display and for
 * building ordered lists, and must not be stored as a long-lived reference
 * (SPEC.md §7).
 */
export interface CellRef {
  readonly cellId: string;
  readonly index: number;
}

/** One row of `notebook_read(view: 'summary')` (SPEC.md §7). */
export interface CellSummary {
  readonly cellId: string;
  /** Internal identity of the live Y.Map; MCP turns this into a cell_ref. */
  readonly identityToken?: string;
  /** Position at the moment the summary was taken. */
  readonly index: number;
  readonly cellType: CellType;
  readonly sourceRevision: SourceRevision;
  readonly cellRevision: CellRevision;
  /** `null` for markdown/raw cells, which have no output area. */
  readonly outputsRevision: OutputsRevision | null;
  /** `null` for a never-run or freshly cleared code cell, and for non-code. */
  readonly executionCount: number | null;
  /** An error output is currently present in this cell. */
  readonly hasError: boolean;
  /** Present only when the shared model carries one. */
  readonly executionState?: SharedExecutionState;
  /** Short, length-limited excerpt of the source. Never the whole text. */
  readonly preview: string;
  /**
   * `true` when another cell in this notebook currently has the same id.
   * Operations addressing it, or using it as an anchor, fail with
   * `CELL_ID_AMBIGUOUS`; other cells keep working (SPEC.md §7).
   */
  readonly duplicateId?: boolean;
}

/** Complete immutable observation used to mint one public `cell_ref`. */
export interface CellObservation {
  readonly cellId: string;
  readonly identityToken: string;
  readonly sourceRevision: SourceRevision;
  readonly cellRevision: CellRevision;
  readonly outputsRevision: OutputsRevision | null;
}

/**
 * Consistent snapshot of a notebook: taken together with `changesCursor` and
 * with no `await` between reading the model and fixing the journal boundary
 * (SPEC.md §9).
 */
export interface NotebookSummary {
  readonly notebookId: string;
  /** Path in the server Contents, not a local path (docs/CONNECTIONS.md §9). */
  readonly path: string;
  readonly fileId: string;
  /** `json:notebook:<fileId>`, stored as `state.document_id` (SPEC.md §6 item 5). */
  readonly documentId: string;
  readonly connectionState: ConnectionState;
  /** `true` when the replica is not yet, or no longer, `ready` (SPEC.md §6). */
  readonly stale: boolean;
  /** `null` until the first sync completes (spike/NOTES.md §4). */
  readonly nbformat: number | null;
  readonly nbformatMinor: number | null;
  /** Total number of cells, even when `cells` was truncated. */
  readonly cellCount: number;
  readonly cells: readonly CellSummary[];
  /** `true` when the cell list hit the summary limit (SPEC.md §9). */
  readonly truncated: boolean;
  readonly structureRevision: StructureRevision;
  readonly notebookMetadataRevision: NotebookMetadataRevision;
  /** Ids that currently appear more than once, for diagnostics (SPEC.md §7). */
  readonly duplicateCellIds: readonly string[];
  readonly changesCursor: ChangesCursor;
  /** Present when the caller must page through the remaining cells. */
  readonly pageCursor?: PageCursor;
}

/** `notebook_read.view` (SPEC.md §9). */
export type ReadView = 'summary' | 'cells' | 'outputs';

// ---------------------------------------------------------------------------
// nbformat outputs (SPEC.md §8)
// ---------------------------------------------------------------------------

/**
 * MIME bundle. Values are whatever nbformat allows for that type: a string, a
 * list of string lines, or arbitrary JSON for `application/json`. Bundles are
 * preserved verbatim, including MIME types this client does not render.
 */
export type MimeBundle = Readonly<Record<string, unknown>>;

/** Per-output metadata, preserved verbatim (SPEC.md §8). */
export type OutputMetadata = Readonly<Record<string, unknown>>;

/** `stream` output. `text` may be a string or nbformat's list of lines. */
export interface NbStreamOutput {
  readonly output_type: 'stream';
  readonly name: 'stdout' | 'stderr';
  readonly text: string | readonly string[];
}

/** `execute_result` output. The only type the RTC spike exercised. */
export interface NbExecuteResultOutput {
  readonly output_type: 'execute_result';
  readonly data: MimeBundle;
  readonly metadata: OutputMetadata;
  readonly execution_count: number | null;
}

/**
 * `display_data` output. `transient.display_id` is kept by the router and is
 * never written here as an ordinary nbformat field (SPEC.md §8).
 */
export interface NbDisplayDataOutput {
  readonly output_type: 'display_data';
  readonly data: MimeBundle;
  readonly metadata: OutputMetadata;
}

/** `error` output. Written exactly once per failure (SPEC.md §12). */
export interface NbErrorOutput {
  readonly output_type: 'error';
  readonly ename: string;
  readonly evalue: string;
  readonly traceback: readonly string[];
}

/** An nbformat output cell entry. */
export type NbOutput =
  | NbStreamOutput
  | NbExecuteResultOutput
  | NbDisplayDataOutput
  | NbErrorOutput;

// ---------------------------------------------------------------------------
// notebook_apply operations (SPEC.md §7, §9)
// ---------------------------------------------------------------------------

/**
 * Exactly one anchor per `add_cell` (SPEC.md §7): `before_cell_id`,
 * `after_cell_id`, or `position: "end"`. The `?: never` members make the three
 * shapes mutually exclusive at compile time; the runtime validator must repeat
 * the check, because operations also arrive as JSON.
 *
 * A vanished anchor is `CELL_NOT_FOUND` - never an insert at some other place.
 * A duplicated anchor id is `CELL_ID_AMBIGUOUS`, and the whole batch is
 * rejected before any mutation.
 */
export type AddCellAnchor =
  | { readonly beforeCellId: string; readonly beforeCellIdentityToken?: string; readonly afterCellId?: never; readonly position?: never }
  | { readonly beforeCellId?: never; readonly afterCellId: string; readonly afterCellIdentityToken?: string; readonly position?: never }
  | { readonly beforeCellId?: never; readonly afterCellId?: never; readonly position: 'end' };

/** Create a cell of a chosen type (SPEC.md §7). */
export type AddCellOperation = {
  readonly op: 'add_cell';
  readonly cellType: CellType;
  readonly source: string;
  /** Optional initial cell metadata. Unknown keys are stored as given. */
  readonly metadata?: Readonly<Record<string, unknown>>;
} & AddCellAnchor;

/**
 * Replace the whole source. Applied as a minimal diff against the existing
 * `Y.Text`, keeping the cell object alive, so concurrent remote edits merge
 * instead of clobbering the CRDT history (SPEC.md §7).
 */
export interface ReplaceSourceOperation {
  readonly op: 'replace_source';
  readonly cellId: string;
  /** Internal object-identity guard expanded from a public `cell_ref`. */
  readonly expectedCellIdentityToken?: string;
  readonly expectedSourceRevision: SourceRevision;
  readonly source: string;
}

/**
 * Exact substring replacement. Requires exactly one match, otherwise
 * `MATCH_NOT_FOUND` / `MATCH_NOT_UNIQUE` (SPEC.md §7).
 */
export interface ReplaceTextOperation {
  readonly op: 'replace_text';
  readonly cellId: string;
  readonly expectedCellIdentityToken?: string;
  readonly expectedSourceRevision: SourceRevision;
  readonly oldText: string;
  readonly newText: string;
}

/** Delete a cell. Guarded by the full cell revision (SPEC.md §7). */
export interface DeleteCellOperation {
  readonly op: 'delete_cell';
  readonly cellId: string;
  readonly expectedCellIdentityToken?: string;
  readonly expectedCellRevision: CellRevision;
}

/**
 * Clear the output area. Guarded by `expected_outputs_revision`; changes
 * `outputs_revision` only if the outputs really changed (SPEC.md §7, §8).
 */
export interface ClearOutputsOperation {
  readonly op: 'clear_outputs';
  readonly cellId: string;
  readonly expectedCellIdentityToken?: string;
  readonly expectedOutputsRevision: OutputsRevision;
}

/** Set one cell metadata key, leaving the others untouched (SPEC.md §7). */
export interface SetCellMetadataOperation {
  readonly op: 'set_cell_metadata';
  readonly cellId: string;
  readonly expectedCellIdentityToken?: string;
  readonly expectedCellRevision: CellRevision;
  readonly key: string;
  readonly value: unknown;
}

/** Delete one cell metadata key (SPEC.md §7). */
export interface DeleteCellMetadataOperation {
  readonly op: 'delete_cell_metadata';
  readonly cellId: string;
  readonly expectedCellIdentityToken?: string;
  readonly expectedCellRevision: CellRevision;
  readonly key: string;
}

/** Set one notebook metadata key (SPEC.md §7). */
export interface SetNotebookMetadataOperation {
  readonly op: 'set_notebook_metadata';
  /** Internal marker that the guard came from an immutable `notebook_ref`. */
  readonly expectedNotebookObserved?: boolean;
  readonly expectedNotebookMetadataRevision: NotebookMetadataRevision;
  readonly key: string;
  readonly value: unknown;
}

/** Delete one notebook metadata key (SPEC.md §7). */
export interface DeleteNotebookMetadataOperation {
  readonly op: 'delete_notebook_metadata';
  readonly expectedNotebookObserved?: boolean;
  readonly expectedNotebookMetadataRevision: NotebookMetadataRevision;
  readonly key: string;
}

/**
 * The complete `notebook_apply.operations` set of the first version
 * (SPEC.md §9). Changing the type of an existing cell and writing attachments
 * are deferred and deliberately have no operation here.
 *
 * A batch is validated in full against the current replica, then applied in a
 * single synchronous `ydoc.transact(fn, origin)` with no `await` in between
 * (SPEC.md §7). A Yjs transaction groups changes for observers; it is not a
 * database transaction with rollback, so every expected error must be found
 * before the first mutation.
 */
export type Operation =
  | AddCellOperation
  | ReplaceSourceOperation
  | ReplaceTextOperation
  | DeleteCellOperation
  | ClearOutputsOperation
  | SetCellMetadataOperation
  | DeleteCellMetadataOperation
  | SetNotebookMetadataOperation
  | DeleteNotebookMetadataOperation;

/** Discriminant values of {@link Operation}. */
export type OperationKind = Operation['op'];

/** Per-operation outcome; revisions are the values after the transaction. */
export interface OperationResult {
  readonly op: OperationKind;
  /** Target cell, or the id assigned to a newly added one. */
  readonly cellId?: string;
  /** Internal identity used with the revisions to mint a public `cell_ref`. */
  readonly identityToken?: string;
  /** Index right after the transaction. Display only (SPEC.md §7). */
  readonly index?: number;
  readonly sourceRevision?: SourceRevision;
  readonly cellRevision?: CellRevision;
  readonly outputsRevision?: OutputsRevision | null;
  readonly notebookMetadataRevision?: NotebookMetadataRevision;
}

/**
 * How far a local change is known to have travelled (SPEC.md §6 "Delivery and
 * persistence"). `ws.send` returning, `bufferedAmount === 0` and an earlier
 * `synced` prove none of the stronger states.
 */
export type DeliveryState = 'sent' | 'pending' | 'unknown';

/** Whether a specific revision is known to be on disk (SPEC.md §6). */
export type PersistenceState = 'unconfirmed' | 'confirmed' | 'unknown';

/** RAW save reply status, plus our own local timeout (SPEC.md §6). */
export type SaveStatus = 'success' | 'skipped' | 'failed' | 'timeout';

/** Result of one `notebook_apply` batch. */
export interface ApplyResult {
  readonly results: readonly OperationResult[];
  readonly appliedLocally: boolean;
  readonly delivery: DeliveryState;
  readonly persistence: PersistenceState;
  readonly structureRevision: StructureRevision;
  readonly changesCursor: ChangesCursor;
  /**
   * Set when an unexpected failure happened after the first mutation: the
   * caller must re-read the affected cells (SPEC.md §7).
   */
  readonly partial?: boolean;
}

// ---------------------------------------------------------------------------
// change journal (SPEC.md §10)
// ---------------------------------------------------------------------------

/** Event kinds of the bounded change journal (SPEC.md §10). */
export type ChangeKind =
  | 'cell_added'
  | 'cell_deleted'
  | 'source_changed'
  | 'metadata_changed'
  | 'outputs_changed'
  | 'order_changed'
  | 'cell_replaced'
  | 'notebook_metadata_changed'
  | 'kernel_changed'
  | 'connection_state';

/** Revisions carried by a change event; only the relevant ones are present. */
export interface ChangeRevisions {
  readonly sourceRevision?: SourceRevision;
  readonly cellRevision?: CellRevision;
  readonly outputsRevision?: OutputsRevision;
  readonly notebookMetadataRevision?: NotebookMetadataRevision;
  readonly structureRevision?: StructureRevision;
}

/**
 * One journal entry (SPEC.md §10).
 *
 * Source text and base64 payloads are never copied into the journal; the agent
 * re-reads them. Frequent output updates are coalesced per cell, published at
 * most every 100 ms and always flushed before a snapshot, before a source or
 * structure event, and at an execution generation boundary - published
 * `sequence` values are never rewritten afterwards.
 */
export interface ChangeEvent {
  /** Monotonic within one notebook handle. */
  readonly sequence: number;
  readonly kind: ChangeKind;
  /** Absent for notebook-wide events. */
  readonly cellId?: string;
  readonly revisions: ChangeRevisions;
  /**
   * `local` when the Yjs transaction origin is this connection's marker.
   * `@jupyter/ydoc` drops custom origins in `cell.transact` / `notebook.transact`,
   * so mutations must go through `notebook.ydoc.transact(fn, ORIGIN)`; this is
   * the only way to tell own changes from remote ones (spike/NOTES.md §3.2).
   * It does not identify which person made a remote edit.
   */
  readonly origin: 'local' | 'remote';
  /** Present on `connection_state` events. */
  readonly connectionState?: ConnectionState;
  /** Present on `kernel_changed` events; `null` means "unbound". */
  readonly kernelId?: string | null;
}

// ---------------------------------------------------------------------------
// cursors (SPEC.md §9: "page_cursor and changes_cursor have different types")
// ---------------------------------------------------------------------------

/**
 * Cursor into the change journal. Shape: `chg_<sequence>`.
 *
 * Stays valid while that sequence is still in the journal; otherwise
 * `notebook_changes` returns `CURSOR_EXPIRED` and the agent takes a new
 * snapshot (SPEC.md §10).
 */
export type ChangesCursor = string & { readonly __cursor: 'changes' };

/**
 * Cursor into a paged read. Shape: `pg_<structureRevision>.<offset>`.
 *
 * Bound to the structural revision: any structural change between pages gives
 * `CURSOR_EXPIRED` rather than skipped or duplicated cells (SPEC.md §9).
 * Deliberately a different shape from {@link ChangesCursor} so the two cannot
 * be swapped by accident.
 */
export type PageCursor = string & { readonly __cursor: 'page' };

/** Opaque continuation for source text that did not fit one cells read. */
export type SourceCursor = string & { readonly __cursor: 'source' };

const CHANGES_CURSOR_PREFIX = 'chg_';
const PAGE_CURSOR_PREFIX = 'pg_';

/** Build a `changes_cursor` for a journal sequence. */
export function makeChangesCursor(sequence: number): ChangesCursor {
  return `${CHANGES_CURSOR_PREFIX}${sequence}` as ChangesCursor;
}

/** Parse a `changes_cursor`; `null` when it is not one (`INVALID_ARGUMENT`). */
export function parseChangesCursor(value: string): number | null {
  if (!value.startsWith(CHANGES_CURSOR_PREFIX)) return null;
  const raw = value.slice(CHANGES_CURSOR_PREFIX.length);
  if (!/^(0|[1-9][0-9]*)$/.test(raw)) return null;
  return Number(raw);
}

/** Build a `page_cursor` bound to a structural revision. */
export function makePageCursor(structure: StructureRevision, offset: number): PageCursor {
  return `${PAGE_CURSOR_PREFIX}${structure}.${offset}` as PageCursor;
}

/** Parse a `page_cursor`; `null` when it is not one (`INVALID_ARGUMENT`). */
export function parsePageCursor(
  value: string
): { structureRevision: StructureRevision; offset: number } | null {
  if (!value.startsWith(PAGE_CURSOR_PREFIX)) return null;
  const body = value.slice(PAGE_CURSOR_PREFIX.length);
  const dot = body.lastIndexOf('.');
  if (dot <= 0) return null;
  const offsetRaw = body.slice(dot + 1);
  if (!/^(0|[1-9][0-9]*)$/.test(offsetRaw)) return null;
  return {
    structureRevision: body.slice(0, dot) as StructureRevision,
    offset: Number(offsetRaw)
  };
}

// ---------------------------------------------------------------------------
// kernel (SPEC.md §8)
// ---------------------------------------------------------------------------

/** Transport state of our kernel WebSocket (SPEC.md §8). */
export type KernelChannelState = 'connecting' | 'connected' | 'disconnected';

/**
 * Observed kernel execution status, reported separately from the channel state
 * and stamped with the time of observation (SPEC.md §8). A `busy` caused by
 * somebody else's request is reported even though we write none of its
 * outputs. Losing the transport does not by itself prove `dead`.
 */
export type KernelExecutionStatus =
  | 'unknown'
  | 'starting'
  | 'idle'
  | 'busy'
  | 'terminating'
  | 'restarting'
  | 'autorestarting'
  | 'dead';

/** What `kernel_status` reports (SPEC.md §8). */
export interface KernelStatus {
  readonly kernelId: string | null;
  readonly kernelName: string | null;
  /** Jupyter Sessions API session bound to the notebook path, if any. */
  readonly sessionId: string | null;
  readonly channelState: KernelChannelState;
  readonly executionStatus: KernelExecutionStatus;
  /** RFC 3339 UTC time the execution status was observed. */
  readonly observedAt: string;
}

// ---------------------------------------------------------------------------
// execution jobs (SPEC.md §8)
// ---------------------------------------------------------------------------

/** Job states (SPEC.md §8 "Jobs"). */
export type JobState =
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'interrupted'
  | 'unknown';

/**
 * Per-cell state inside a job.
 *
 * `aborted` means the kernel actually answered a request we sent;
 * `not_sent` means the cell never reached the kernel. The distinction is
 * required by SPEC.md §8 and is the difference between "may have run" and
 * "provably did not run".
 */
export type CellRunState =
  | 'queued'
  | 'sent'
  | 'succeeded'
  | 'failed'
  | 'aborted'
  | 'not_sent'
  | 'unknown';

/**
 * Why a cell was never sent (SPEC.md §8). `stop_on_error` and `cancelled` are
 * our own queue decisions; `kernel_changed` / `kernel_dead` come from an
 * observed lifecycle event, possibly triggered by the browser; the target
 * reasons come from the re-check performed immediately before sending.
 */
export type NotSentReason =
  | 'stop_on_error'
  | 'cancelled'
  | 'kernel_changed'
  | 'kernel_dead'
  | 'revision_conflict'
  | 'cell_not_found'
  | 'cell_replaced'
  | 'cell_id_ambiguous'
  | 'rtc_not_ready';

/**
 * Why a sent cell ended as `aborted` (SPEC.md §8). Both are real kernel
 * answers: `aborted` from a `stop_on_error` chain in the kernel's own queue,
 * or a reply that followed an explicit interrupt.
 */
export type AbortedReason = 'kernel_aborted' | 'interrupted';

/** One cell inside a job (SPEC.md §8 "Races, interruption, and connection loss"). */
export interface CellExecutionRecord {
  readonly cellId: string;
  /** The exact text sent to the kernel; later edits do not change it. */
  readonly sourceSnapshot: string;
  /** Revision of {@link sourceSnapshot}, re-checked just before sending. */
  readonly sourceRevision: SourceRevision;
  /** `execute_request` header id; absent while the cell is still queued. */
  readonly msgId?: string;
  readonly state: CellRunState;
  /** Outputs collected by the reducer, whether or not they reached the model. */
  readonly outputsCollected: readonly NbOutput[];
  /** The cell text differs from {@link sourceSnapshot} now. */
  readonly sourceChanged: boolean;
  /** The cell was deleted while running; it is not recreated for outputs. */
  readonly cellDeleted: boolean;
  /** Collection hit a budget; the kernel was not interrupted (SPEC.md §9). */
  readonly outputIncomplete: boolean;
  /** Output-area generation this record owns; see {@link OutputSink}. */
  readonly generation?: number;
  /** Final `execution_count`, written at completion only (SPEC.md §8). */
  readonly executionCount?: number | null;
  readonly notSentReason?: NotSentReason;
  readonly abortedReason?: AbortedReason;
}

/** A `notebook_execute` job (SPEC.md §8). */
export interface ExecutionJob {
  readonly executionId: string;
  readonly notebookId: string;
  /** The MCP working session that owns this job (SPEC.md §4). */
  readonly sessionId: string;
  /** Kernel identity captured at acceptance; a change invalidates the job. */
  readonly kernelId: string | null;
  readonly state: JobState;
  /** Passed to the kernel and, by default, stops our own queue too. */
  readonly stopOnError: boolean;
  readonly cells: readonly CellExecutionRecord[];
  /** RFC 3339 UTC. */
  readonly createdAt: string;
  readonly finishedAt?: string;
  /**
   * Terminal reason for `failed` / `cancelled` / `interrupted` / `unknown`.
   * A Python error is a job outcome, not a transport error (SPEC.md §9).
   */
  readonly reason?: string;
}

// ---------------------------------------------------------------------------
// output sink: the seam between src/kernel and the notebook model (SPEC.md §8)
// ---------------------------------------------------------------------------

/**
 * A single-writer view of one cell's output area, valid for one execution
 * generation (SPEC.md §8: "output-area generation").
 *
 * `src/kernel` never touches the shared model directly. It reduces IOPub
 * messages into nbformat outputs and hands them to a sink; the notebook model
 * performs the actual `ydoc.transact(fn, ORIGIN)` write. That keeps the
 * "exactly one writer per execution" rule of SPEC.md §8 and keeps the kernel
 * module free of Yjs.
 *
 * Every mutator returns `applied: boolean`. It returns `false` and changes
 * nothing when {@link isCurrent} is false - that is, when a newer own
 * execution, an observed foreign execution, a clear, a cell deletion, a cell
 * replacement (a new `Y.Map` under the same id) or the handle closing has
 * already superseded this generation. A stale stream must never modify the
 * outputs, `execution_count` or `execution_state` of the new generation; the
 * results stay available on the job instead.
 */
export interface OutputSink {
  readonly cellId: string;
  /** Immutable identity of the shared cell object this sink owns. */
  readonly identityToken: string;
  /** Monotonic per cell. Bumped by {@link BeginExecutionGeneration}. */
  readonly generation: number;
  /**
   * `true` while this sink still owns the cell's output area: the cell exists,
   * is the same CRDT object, and no newer generation has started.
   */
  isCurrent(): boolean;
  /** Current outputs of the cell, or `[]` once the sink is stale. */
  getOutputs(): NbOutput[];
  /** Replace the whole output area. Returns whether it was applied. */
  setOutputs(outputs: NbOutput[]): boolean;
  /** Append one output. Returns whether it was applied. */
  appendOutput(o: NbOutput): boolean;
  /** Append one delta to an existing stream output without replacing its shared Y.Text. */
  appendStream(index: number, text: string): boolean;
  /**
   * Replace the output at `index` - used by `update_display_data`.
   * Out-of-range indices are not applied.
   */
  updateOutput(index: number, o: NbOutput): boolean;
  /** `clear_output`. Returns whether it was applied. */
  clearOutputs(): boolean;
  /**
   * Write the final `execution_count`. Writing it early can extinguish `[*]`
   * in JupyterLab, so it is written at completion only (SPEC.md §8).
   */
  setExecutionCount(n: number | null): boolean;
  /** Write the shared `execution_state`; `idle` only at completion. */
  setExecutionState(s: SharedExecutionState): boolean;
}

/**
 * Look up the sink for a cell. Returns `null` when the cell is gone - deleted,
 * or replaced by a different `Y.Map` (SPEC.md §6 "External file changes").
 * A `null` here is what turns a running record into `cellDeleted` /
 * `CELL_REPLACED` rather than recreating the cell.
 */
export type OutputSinkFactory = (cellId: string) => OutputSink | null;

/**
 * Start a new output-area generation for a cell, immediately before the
 * `execute_request` is sent (SPEC.md §8).
 *
 * In **one** shared-model transaction, with this connection's origin:
 *
 * 1. clear `outputs`;
 * 2. set `execution_count` to `null`;
 * 3. delete the previous timing metadata `execution`;
 * 4. set `execution_state` to `running`;
 * 5. bump the cell's generation counter and return a sink bound to it.
 *
 * This mirrors the parts of JupyterLab's `clearExecution` + execute path that
 * a headless client still owes the browser: JupyterLab 4.6.3 renders `[*]`
 * from the shared `execution_state`. Clearing moves `outputs_revision` only if
 * the outputs actually changed. Any sink from an earlier generation becomes
 * stale at once, so its late writes are dropped.
 *
 * Returns `null` when the cell no longer exists, in which case the queue stops
 * before sending anything to the kernel.
 */
export type BeginExecutionGeneration = (
  cellId: string,
  expectedIdentityToken: string
) => OutputSink | null;
