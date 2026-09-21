/**
 * `createCollabService` - the registry layer that implements
 * {@link CollabService} (SPEC.md §4, §6-§11).
 *
 * It is the only place that composes the three modules:
 *
 * - `src/jupyter` for REST and the collaboration room,
 * - `src/core/notebook` for the live replica, its journal and its output
 *   generations,
 * - `src/kernel` for the kernel socket and the execution queue,
 *
 * and the only place that owns the state SPEC.md §4 names: servers, working
 * sessions, notebook handles, jobs, output snapshots and the `request_id`
 * ledger. Everything above it (the MCP adapter) does schema work and nothing
 * else; everything below it stays free of MCP.
 *
 * Three invariants are worth stating once, because they shape most methods:
 *
 * 1. **Errors are thrown, never returned.** Every rejection is a `CoreError`
 *    with a SPEC.md §9 code, and every session-scoped rejection carries the
 *    session envelope in `details` so an agent that lost its counter can read
 *    `next_request_id` off the error.
 * 2. **A number is consumed only after the receipt exists.** Everything a
 *    mutating method checks before {@link RequestLedger.begin} - arguments,
 *    handles, budgets, kernel binding, cell targets - leaves the number unused.
 * 3. **Closing never shuts a kernel down** (SPEC.md §4), and neither does
 *    {@link CollabServiceImpl.shutdown}.
 *
 * @module
 */

import { randomUUID } from 'node:crypto';

import {
  coreError,
  isCoreError,
  parseChangesCursor,
  sourceRevision,
  toCoreError,
  withDefaults,
  type CellContent,
  type CellOutputsView,
  type CollabService,
  type CoreError,
  type DirectoryCursor,
  type ExecutionCancelRequest,
  type ExecutionCancelResult,
  type ExecutionGetRequest,
  type ExecutionView,
  type KernelControlEffects,
  type KernelControlRequest,
  type KernelControlResult,
  type KernelListRequest,
  type KernelListResult,
  type KernelStatusRequest,
  type KernelStatusResult,
  type ListOutputResourcesResult,
  type NbOutput,
  type NotebookApplyRequest,
  type NotebookApplyResult,
  type NotebookCellsReadResult,
  type NotebookChangesRequest,
  type NotebookChangesResult,
  type NotebookCloseRequest,
  type NotebookCloseResult,
  type NotebookCreateRequest,
  type NotebookCreateResult,
  type NotebookExecuteRequest,
  type NotebookListEntry,
  type NotebookListRequest,
  type NotebookListResult,
  type NotebookOpenRequest,
  type NotebookOpenResult,
  type NotebookOutputsReadResult,
  type NotebookReadRequest,
  type NotebookSaveRequest,
  type NotebookSaveResult,
  type NotebookSummaryReadResult,
  type OutputEntry,
  type OutputReadRequest,
  type OutputReadResult,
  type OutputResourceContents,
  type OutputResourceDescriptor,
  type PageCursor,
  type ResponseLimits,
  type ServerListResult,
  type ServerStatusRequest,
  type ServerStatusResult,
  type ServerStartRequest,
  type ServiceConfigInput,
  type SessionCloseRequest,
  type SessionCloseResult,
  type SessionEnvelope,
  type SessionOpenRequest,
  type SessionOpenResult,
  type ShutdownReason,
  type WithEnvelope
} from '../core/index.js';
import type { NotebookReadResultFor } from '../core/service.js';
import { cellTypeOf, isCodeCell } from '../core/notebook/index.js';
import { planOperations } from '../core/notebook/plan.js';
import { metadataRevisionOf, resolveCell } from '../core/notebook/read.js';
import { withIdentity } from '../core/notebook/types.js';
import { normalizeContentsPath, validateNotebookName } from '../jupyter/paths.js';
import { installStdoutGuard, isStdoutGuardInstalled } from '../jupyter/stdout-guard.js';
import type {
  JupyterSessionInfo,
  KernelSpecEntry,
  ServerClient
} from '../jupyter/server-client.js';
import type { ExecutionCellRequest, Revalidate, RevalidateResult } from '../kernel/index.js';
import {
  buildExecutionView,
  effectiveLimits,
  parseExecutionCursor,
  toOutputEntry,
  watchJob,
  TERMINAL_JOB_STATES,
  type ExecutionRecord
} from './execution.js';
import { KernelHub } from './kernel-hub.js';
import { NotebookHandle, SESSION_LIFETIME } from './notebook-handle.js';
import type { NotebookHandleInit } from './notebook-handle.js';
import {
  SNAPSHOT_LIFETIME,
  parseOutputUri,
  type OutputSnapshot
} from './outputs.js';
import { RequestLedger, type DedupTool, type Receipt } from './ledger.js';
import { ServerRegistry, type ServerEntry, type ServerRegistryOptions } from './server-registry.js';
import { SessionRegistry, type WorkingSession } from './session.js';
import { Mutex } from './mutex.js';

/**
 * Snapshot memory of one working session.
 *
 * SPEC.md §9 requires a separate budget for output buffers but does not
 * quantify it; 32 MiB is a project default with no measured-capacity claim.
 */
export const DEFAULT_OUTPUT_STORE_BYTES = 32 * 1024 * 1024;

/** Construction options of {@link createCollabService}. */
export interface CollabServiceOptions extends ServerRegistryOptions {
  /** Snapshot memory per working session. */
  readonly outputStoreMaxBytes?: number;
  /**
   * Install the stdout guard before the first `@jupyterlab/services` object
   * exists (SPEC.md §11). Default `true`; the guard is a no-op when another
   * entry point already installed it.
   */
  readonly guardStdout?: boolean;
  /** Budget of one `notebook_open` / `notebook_create`. Default 30 s. */
  readonly openTimeoutMs?: number;
  /** Injected clock, for deterministic tests. */
  readonly now?: () => Date;
  /**
   * Replaces {@link NotebookHandle.open}.
   *
   * The one seam a unit test needs: everything else in this layer is driven
   * through `fetchImpl`, but opening a replica means opening a real
   * WebSocket. Production never passes it.
   */
  readonly openHandle?: (init: NotebookHandleInit) => Promise<NotebookHandle>;
}

const DIRECTORY_CURSOR_PREFIX = 'dir_';
const OUTPUT_CURSOR_PREFIX = 'oc_';

/** How often the kernel watchdog checks that a busy kernel still exists. */
const KERNEL_WATCH_MS = 2000;

/** How long a long-poll sleeps between journal checks. */
const POLL_INTERVAL_MS = 50;
/** Reserve wire framing and common JSON escaping around a cells source chunk. */
const CELL_READ_RESPONSE_OVERHEAD_BYTES = 8 * 1024;

/**
 * Receipt reservation of one `notebook_apply` batch (SPEC.md §9).
 *
 * The stored answer is one `OperationResult` per operation - the operation
 * name, a cell id, an index and up to three revision digests - plus the fixed
 * head of the result. Both terms are serialisation ceilings, not measurements:
 * they only have to bound the receipt before the batch runs.
 */
const APPLY_RECEIPT_BASE_BYTES = 512;
const APPLY_RECEIPT_BYTES_PER_OPERATION = 384;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

/** Add the session envelope to the `details` of a thrown error (SPEC.md §9). */
function withEnvelopeDetails(error: unknown, envelope: SessionEnvelope): CoreError {
  const core = toCoreError(error);
  const details: Record<string, unknown> = {
    ...(core.details ?? {}),
    next_request_id: envelope.nextRequestId,
    ...(envelope.requestAccepted === undefined
      ? {}
      : { request_accepted: envelope.requestAccepted }),
    ...(envelope.firstAcceptedAt === undefined
      ? {}
      : { first_accepted_at: envelope.firstAcceptedAt })
  };
  return coreError(core.code, core.message, {
    retryable: core.retryable,
    sideEffects: core.sideEffects,
    details,
    cause: core
  });
}

/** The registry layer. Constructed through {@link createCollabService}. */
class CollabServiceImpl implements CollabService {
  readonly #config: ReturnType<typeof withDefaults>;
  readonly #servers: ServerRegistry;
  readonly #sessions: SessionRegistry;
  readonly #implicitSessions = new Map<string, Promise<WorkingSession>>();
  readonly #implicitLedger: RequestLedger;
  readonly #implicitLock = new Mutex();
  readonly #kernels = new KernelHub();
  readonly #openTimeoutMs: number;
  readonly #openReplica: (init: NotebookHandleInit) => Promise<NotebookHandle>;
  readonly #now: () => Date;
  readonly #restoreConsole: (() => void) | null;
  /** `notebook_id` -> owning session; handles address their session alone. */
  readonly #notebookOwner = new Map<string, WorkingSession>();
  /** `execution_id` -> owning session. */
  readonly #executionOwner = new Map<string, WorkingSession>();
  /** Bounded tombstone so a second `notebook_close` stays idempotent. */
  readonly #closedNotebooks = new Set<string>();
  #shuttingDown = false;
  /** Polls for a kernel that vanished while one of our jobs was running. */
  #kernelWatch: NodeJS.Timeout | null = null;

  constructor(input: ServiceConfigInput, options: CollabServiceOptions = {}) {
    this.#config = withDefaults(input);
    // SPEC.md §11: stdout belongs to MCP; `@jupyterlab/services` logs
    // "Starting WebSocket: ..." on `console.debug` the moment it builds a
    // connection, so the guard must exist before the first client does.
    this.#restoreConsole =
      options.guardStdout === false || isStdoutGuardInstalled() ? null : installStdoutGuard();
    this.#servers = new ServerRegistry(this.#config, options);
    this.#now = options.now ?? ((): Date => new Date());
    this.#implicitLedger = new RequestLedger({
      maxReceipts: this.#config.limits.maxReceiptsPerSession,
      requestMaxBytes: this.#config.limits.requestMaxBytes,
      receiptMaxBytes: this.#config.limits.receiptMaxBytes
    }, this.#now);
    this.#sessions = new SessionRegistry(
      this.#config.limits,
      options.outputStoreMaxBytes ?? DEFAULT_OUTPUT_STORE_BYTES,
      this.#now
    );
    this.#openTimeoutMs = options.openTimeoutMs ?? 30_000;
    this.#openReplica = options.openHandle ?? ((init) => NotebookHandle.open(init));
  }

  // -------------------------------------------------------------------------
  // servers and working sessions
  // -------------------------------------------------------------------------

  async serverList(): Promise<ServerListResult> {
    this.#assertRunning();
    return { ...await this.#servers.list(), nextRequestId: this.#implicitLedger.nextRequestId };
  }

  async serverStatus(request: ServerStatusRequest): Promise<ServerStatusResult> {
    this.#assertRunning();
    const server = await this.#servers.select(request.serverId);
    const hub = this.#servers.hubFor(server);
    if (hub !== undefined) return { ...await hub.status(), nextRequestId: this.#implicitLedger.nextRequestId };
    await this.#servers.clientFor(server).status();
    return { serverId: server.id, state: 'ready', supportsStart: false, nextRequestId: this.#implicitLedger.nextRequestId };
  }

  async serverStart(request: ServerStartRequest): Promise<WithEnvelope<ServerStatusResult>> {
    this.#assertRunning();
    let accepted: Receipt | undefined;
    let replayed = false;
    const envelope = () => ({
      nextRequestId: this.#implicitLedger.nextRequestId,
      requestAccepted: accepted !== undefined,
      ...(accepted === undefined ? {} : { replayed, firstAcceptedAt: accepted.firstAcceptedAt })
    });
    let result: WithEnvelope<ServerStatusResult>;
    try {
      result = await this.#implicitLock.run(async () => {
        this.#assertRunning();
        const server = await this.#servers.select(request.serverId);
        const { requestId, waitMs: _waitMs, ...payload } = request;
        const input = { tool: 'server_start' as const, requestId, target: server.id, payload };
        const previous = this.#implicitLedger.preflight(input);
        if (previous !== null) {
          accepted = previous.receipt;
          replayed = true;
          if (accepted.failure !== null) throw accepted.failure;
          if (accepted.replay?.kind !== 'value') throw coreError('REQUEST_ID_EXPIRED', 'start receipt is no longer available');
          return { ...accepted.replay.value as ServerStatusResult, ...envelope() };
        }
        const hub = this.#servers.hubFor(server);
        if (hub === undefined) throw coreError('UNSUPPORTED_OPERATION', 'server_start requires explicitly configured Hub lifecycle support');
        if (request.profileId !== undefined && request.userOptions !== undefined) throw coreError('INVALID_ARGUMENT', 'choose profile_id or user_options');
        if (request.userOptions !== undefined && (request.userOptions === null || typeof request.userOptions !== 'object' || Array.isArray(request.userOptions))) {
          throw coreError('INVALID_ARGUMENT', 'user_options must be a JSON object');
        }
        if (request.waitMs !== undefined && (!Number.isFinite(request.waitMs) || request.waitMs < 0)) throw coreError('INVALID_ARGUMENT', 'wait_ms must be nonnegative');
        const current = await hub.status();
        let options = request.userOptions;
        if (request.profileId !== undefined) {
          const selected = current.startOptions?.profiles.find((entry) => entry.id === request.profileId);
          if (selected === undefined) throw coreError('INVALID_ARGUMENT', 'unknown start profile; read server_status for available profiles');
          options = selected.userOptions;
        }
        const { startOptions: _catalog, userOptions: _options, ...compactCurrent } = current;
        const reserveBytes = Buffer.byteLength(JSON.stringify(compactCurrent), 'utf8') + 512;
        const decision = this.#implicitLedger.begin({ ...input, reserveBytes });
        accepted = decision.receipt;
        try {
          const status = await hub.start(options);
          // Catalogs are discoverable through status and need not occupy every receipt.
          const { startOptions: _catalog, userOptions: _options, ...compact } = status;
          this.#implicitLedger.complete(accepted, { kind: 'value', value: compact }, 'applied');
          return { ...compact, ...envelope() };
        } catch (error) {
          const core = toCoreError(error);
          this.#implicitLedger.fail(accepted, core, core.sideEffects);
          throw core;
        }
      });
    } catch (error) {
      throw withEnvelopeDetails(error, {
        ...envelope(),
        ...(isCoreError(error) && error.code === 'REQUEST_ID_EXPIRED' ? { requestAccepted: null } : {})
      });
    }
    // The receipt is complete before polling, so a cancelled wait neither
    // blocks other mutations nor leaves an accepted start eligible for resend.
    const deadline = Date.now() + Math.min(request.waitMs ?? 0, this.#config.limits.maxWaitMs);
    while (!replayed && result.state === 'starting' && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, Math.min(250, deadline - Date.now())));
      if (Date.now() >= deadline) break;
      this.#assertRunning();
      const hub = this.#servers.hubFor(await this.#servers.select(result.serverId))!;
      const signal = AbortSignal.timeout(Math.max(1, deadline - Date.now()));
      try { result = { ...await hub.status(signal), ...envelope() }; }
      catch (error) {
        if (signal.aborted) break;
        throw withEnvelopeDetails(error, envelope());
      }
    }
    return { ...result, ...envelope() };
  }

  /** Resolve a library session or lazily bind a server to this MCP connection. */
  async #sessionFor(request: { readonly sessionId?: string; readonly serverId?: string }): Promise<WorkingSession> {
    if (request.sessionId !== undefined) {
      if (request.serverId !== undefined) throw coreError('INVALID_ARGUMENT', 'choose sessionId or serverId, not both');
      return this.#sessions.require(request.sessionId);
    }
    try {
      const server = await this.#servers.select(request.serverId);
      let pending = this.#implicitSessions.get(server.id);
      if (pending === undefined) {
        pending = (async () => {
          await this.#servers.prepare(server);
          this.#assertRunning();
          return this.#sessions.open(server, undefined, { ledger: this.#implicitLedger, lock: this.#implicitLock });
        })();
        this.#implicitSessions.set(server.id, pending);
        // Only initialization failures are retryable; a live context and its
        // high-water mark are never replaced after a document closes.
        void pending.catch(() => {
          if (this.#implicitSessions.get(server.id) === pending) this.#implicitSessions.delete(server.id);
        });
      }
      return await pending;
    } catch (error) {
      throw withEnvelopeDetails(error, { nextRequestId: this.#implicitLedger.nextRequestId, requestAccepted: false });
    }
  }

  async sessionOpen(request: SessionOpenRequest): Promise<WithEnvelope<SessionOpenResult>> {
    this.#assertRunning();
    const server = await this.#servers.select(request.serverId);
    // Reaching the server here turns a bad credential or an unreachable host
    // into `AUTH_REQUIRED` / `NETWORK_ERROR` now, rather than into a confusing
    // failure of the first document call.
    await this.#servers.prepare(server);
    this.#assertRunning();
    const session = this.#sessions.open(server, request.label);
    return {
      sessionId: session.id,
      server: server.descriptor,
      ...(session.label === undefined ? {} : { label: session.label }),
      lifetime: SESSION_LIFETIME,
      openedAt: session.openedAt,
      kernelStarted: false,
      ...session.envelope()
    };
  }

  async sessionClose(request: SessionCloseRequest): Promise<WithEnvelope<SessionCloseResult>> {
    const session = this.#sessions.get(request.sessionId);
    if (session === undefined || session.closed) {
      if (this.#sessions.wasClosed(request.sessionId) || session?.closed === true) {
        return {
          sessionId: request.sessionId,
          closedNotebookIds: [],
          droppedExecutionIds: [],
          alreadyClosed: true,
          kernelsLeftRunning: true,
          nextRequestId: null
        };
      }
      throw coreError('HANDLE_EXPIRED', `unknown working session ${request.sessionId}`, {
        details: { session_id: request.sessionId, next_request_id: null }
      });
    }

    const active = session.activeExecutions();
    if (active.length > 0 && request.force !== true) {
      throw withEnvelopeDetails(
        coreError('EXECUTION_ACTIVE', 'this working session still has an active execution', {
          details: { execution_ids: active.map((record) => record.executionId) }
        }),
        session.envelope()
      );
    }

    const closedNotebookIds = [...session.notebooks.keys()];
    const droppedExecutionIds = [...session.executions.keys()];
    this.#teardownSession(session);
    return {
      sessionId: session.id,
      closedNotebookIds,
      droppedExecutionIds,
      alreadyClosed: false,
      kernelsLeftRunning: true,
      nextRequestId: null
    };
  }

  // -------------------------------------------------------------------------
  // documents
  // -------------------------------------------------------------------------

  async notebookList(request: NotebookListRequest): Promise<WithEnvelope<NotebookListResult>> {
    this.#assertRunning();
    const session = await this.#sessionFor(request);
    try {
      const directory = normalizeContentsPath(request.directory);
      const client = this.#servers.clientFor(session.server);
      const listing = await client.listDirectory(directory);
      const { sessions, included } = await this.#sessionsByPath(client);

      const sorted = [...listing.entries].sort((a, b) => {
        if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
      const limits = effectiveLimits(this.#config.limits, request.limits);
      const offset = request.cursor === undefined ? 0 : parseDirectoryCursor(request.cursor);
      const page = sorted.slice(offset, offset + limits.maxCells);
      const end = offset + page.length;

      const entries: NotebookListEntry[] = page.map((entry) => {
        const info = sessions.get(entry.path);
        const open = [...session.notebooks.values()].find(
          (handle) => !handle.closed && handle.path === entry.path
        );
        return {
          name: entry.name,
          path: entry.path,
          type: entry.type,
          lastModified: entry.lastModified,
          size: entry.size,
          ...(info === undefined ? {} : { session: toNotebookSessionInfo(info) }),
          ...(open === undefined ? {} : { openNotebookId: open.notebookId })
        };
      });
      return {
        directory: listing.path,
        entries,
        truncated: end < sorted.length,
        ...(end < sorted.length ? { nextCursor: makeDirectoryCursor(end) } : {}),
        sessionsIncluded: included,
        ...session.envelope()
      };
    } catch (error) {
      throw withEnvelopeDetails(error, session.envelope());
    }
  }

  async notebookCreate(
    request: NotebookCreateRequest
  ): Promise<WithEnvelope<NotebookCreateResult>> {
    this.#assertRunning();
    const session = await this.#sessionFor(request);
    return session.lock.run(async () => {
      try {
        this.#assertRunning();
        this.#assertSessionOpen(session);
      } catch (error) {
        throw withEnvelopeDetails(error, session.envelope({ requestAccepted: false }));
      }
      const { directory, name } = this.#validateCreate(session, request);
      const payload = {
        serverId: session.server.id,
        directory,
        name: name ?? null
      };
      const replay = this.#preflight(session, 'notebook_create', null, request.requestId, payload);
      if (replay !== null) return this.#replayValue<NotebookCreateResult>(session, replay);
      this.#assertReplicaBudget();
      const decision = this.#begin(session, 'notebook_create', null, request.requestId, payload);
      if (decision.kind === 'replay') {
        return this.#replayValue<NotebookCreateResult>(session, decision.receipt);
      }
      const receipt = decision.receipt;
      return this.#runAccepted(session, receipt, async () => {
        const client = this.#servers.clientFor(session.server);
        const untitled = await client.newUntitledNotebook(directory);
        let path = untitled.path;
        let renamed = false;
        if (name !== undefined && baseName(untitled.path) !== name) {
          const target = directory === '' ? name : `${directory}/${name}`;
          try {
            const moved = await client.rename(untitled.path, target);
            path = moved.path;
            renamed = true;
          } catch (error) {
            // SPEC.md §6: after the untitled file exists, 409/403 report its
            // actual path with `side_effects: applied`; the file is not
            // deleted and the room is not opened.
            throw renameFailure(error, untitled.path, target);
          }
        }
        const { handle } = await this.#openHandle(session, path);
        handle.model.removePristineServerPlaceholder();
        const snapshot = handle.model.snapshotWithCursor({
          maxCells: this.#config.limits.summaryMaxCells
        });
        const result: NotebookCreateResult = {
          notebook: handle.info(),
          untitledPath: untitled.path,
          renamed,
          summary: withIdentity(snapshot.summary, identityOf(handle)),
          changesCursor: snapshot.changesCursor
        };
        return { result, replay: { kind: 'value', value: result } };
      });
    });
  }

  async notebookOpen(request: NotebookOpenRequest): Promise<WithEnvelope<NotebookOpenResult>> {
    this.#assertRunning();
    const session = await this.#sessionFor(request);
    try {
      const path = normalizeContentsPath(request.path);
      const live = [...session.notebooks.values()].find(
        (handle) => !handle.closed && handle.path === path
      );
      if (live !== undefined) return this.#openResult(session, live, true, request.limits);

      // SPEC.md §4: concurrent opens of one document coalesce into a single
      // operation, so a second caller waits for the first `Y.Doc` instead of
      // building a second replica and a second socket.
      let created = false;
      let pending = session.opening.get(path);
      if (pending === undefined) {
        created = true;
        pending = this.#openHandle(session, path);
        session.opening.set(path, pending);
        void pending
          .finally(() => {
            if (session.opening.get(path) === pending) session.opening.delete(path);
          })
          // The awaiting callers own the rejection; this bookkeeping tail must
          // not surface as an unhandled one and kill the process.
          .catch(() => undefined);
      }
      const opened = await pending;
      return this.#openResult(session, opened.handle, !created || opened.reused, request.limits);
    } catch (error) {
      throw withEnvelopeDetails(error, session.envelope());
    }
  }

  async notebookClose(request: NotebookCloseRequest): Promise<WithEnvelope<NotebookCloseResult>> {
    const session = this.#notebookOwner.get(request.notebookId);
    const handle = session?.notebooks.get(request.notebookId);
    if (session === undefined || handle === undefined || handle.closed) {
      if (this.#closedNotebooks.has(request.notebookId)) {
        return {
          notebookId: request.notebookId,
          alreadyClosed: true,
          droppedExecutionIds: [],
          kernelLeftRunning: true,
          nextRequestId: session === undefined || session.closed ? null : session.ledger.nextRequestId
        };
      }
      throw coreError('HANDLE_EXPIRED', `unknown notebook handle ${request.notebookId}`, {
        details: { notebook_id: request.notebookId, next_request_id: null }
      });
    }

    const active = session.activeExecutions(request.notebookId);
    if (active.length > 0 && request.force !== true) {
      throw withEnvelopeDetails(
        coreError('EXECUTION_ACTIVE', 'this notebook still has an active execution', {
          details: { execution_ids: active.map((record) => record.executionId) }
        }),
        session.envelope()
      );
    }
    const dropped = [...handle.executionIds];
    this.#closeNotebook(session, handle);
    return {
      notebookId: request.notebookId,
      alreadyClosed: false,
      droppedExecutionIds: dropped,
      kernelLeftRunning: true,
      ...session.envelope()
    };
  }

  async notebookRead<R extends NotebookReadRequest>(
    request: R
  ): Promise<WithEnvelope<NotebookReadResultFor<R>>> {
    this.#assertRunning();
    const { session, handle } = this.#locate(request.notebookId);
    try {
      const limits = effectiveLimits(this.#config.limits, request.limits);
      const common = {
        notebookId: handle.notebookId,
        connectionState: handle.connectionState,
        stale: handle.stale
      };
      if (request.view === 'summary') {
        const snapshot = handle.model.snapshotWithCursor({
          maxCells: limits.maxCells,
          previewChars: limits.previewChars,
          ...(request.cursor === undefined ? {} : { cursor: request.cursor })
        });
        const summary = withIdentity(snapshot.summary, identityOf(handle));
        const result: NotebookSummaryReadResult = {
          ...common,
          view: 'summary',
          structureRevision: summary.structureRevision,
          changesCursor: snapshot.changesCursor,
          summary,
          ...(summary.pageCursor === undefined ? {} : { nextCursor: summary.pageCursor })
        };
        return { ...(result as NotebookReadResultFor<R>), ...session.envelope() };
      }
      if (request.view === 'cells') {
        if (request.cellIds !== undefined && request.cursor !== undefined) {
          throw coreError('INVALID_ARGUMENT', 'cell_ids and cursor are mutually exclusive');
        }
        const changesCursor = handle.model.changesCursor;
        const read = handle.model.readCells(
          request.cellIds === undefined
            ? request.cursor === undefined
              ? {}
              : { cursor: request.cursor }
            : { cellIds: request.cellIds },
          {
            maxCells: limits.maxCells,
            maxBytes: Math.max(1, limits.maxBytes - CELL_READ_RESPONSE_OVERHEAD_BYTES)
          }
        );
        const duplicates = new Set(handle.model.duplicateCellIds);
        const cells: CellContent[] = read.cells.map((cell) => ({
          ...cell,
          ...(duplicates.has(cell.cellId) ? { duplicateId: true } : {})
        }));
        const metadata = notebookMetadata(handle);
        const result: NotebookCellsReadResult = {
          ...common,
          view: 'cells',
          structureRevision: read.structureRevision,
          changesCursor,
          cells,
          truncated: read.truncated,
          ...(read.nextCursor === undefined ? {} : { nextCursor: read.nextCursor }),
          ...(metadata === null ? {} : { notebookMetadata: metadata }),
          notebookMetadataRevision: metadataRevisionOf(handle.notebook)
        };
        return { ...(result as NotebookReadResultFor<R>), ...session.envelope() };
      }
      if (request.cellIds !== undefined && request.cursor !== undefined) {
        throw coreError('INVALID_ARGUMENT', 'cell_ids and cursor are mutually exclusive');
      }
      const changesCursor = handle.model.changesCursor;
      let cellIds: readonly string[];
      let nextCursor: PageCursor | undefined;
      let structure;
      if (request.cellIds !== undefined) {
        cellIds = request.cellIds;
        structure = handle.model.structureRevision;
      } else {
        const page = handle.model.summary({
          maxCells: limits.maxCells,
          previewChars: 1,
          ...(request.cursor === undefined ? {} : { cursor: request.cursor })
        });
        cellIds = page.cells.map((cell) => cell.cellId);
        nextCursor = page.pageCursor;
        structure = page.structureRevision;
      }
      const read = handle.model.readOutputs(cellIds, {
        maxCells: limits.maxCells,
        maxBytes: limits.maxBytes,
        maxOutputBytes: limits.maxOutputBytes
      });
      const cells: CellOutputsView[] = read.cells.map((cell) => ({
        ...cell,
        outputs: this.#outputEntries(session, handle, cell)
      }));
      const result: NotebookOutputsReadResult = {
        ...common,
        view: 'outputs',
        structureRevision: structure,
        changesCursor,
        cells,
        truncated: read.truncated,
        ...(nextCursor === undefined ? {} : { nextCursor })
      };
      return { ...(result as NotebookReadResultFor<R>), ...session.envelope() };
    } catch (error) {
      throw withEnvelopeDetails(error, session.envelope());
    }
  }

  async notebookApply(request: NotebookApplyRequest): Promise<WithEnvelope<NotebookApplyResult>> {
    this.#assertRunning();
    const { session, handle } = this.#locate(request.notebookId);
    return session.lock.run(async () => {
      const payload = { operations: request.operations };
      const replay = this.#preflight(
        session,
        'notebook_apply',
        handle.notebookId,
        request.requestId,
        payload
      );
      if (replay !== null) return this.#replayValue<NotebookApplyResult>(session, replay);
      try {
        handle.assertWritable();
        if (request.operations.length === 0) {
          throw coreError('INVALID_ARGUMENT', 'notebook_apply requires a non-empty operation list');
        }
        // Plan the batch before the receipt exists: SPEC.md §7 requires every
        // expected error to be raised before the first mutation, and SPEC.md §9
        // requires such a rejection to leave the request number unused. The
        // planner is pure, so running it twice costs a walk of the batch.
        planOperations(handle.notebook, handle.model.index, request.operations);
      } catch (error) {
        throw withEnvelopeDetails(error, session.envelope({ requestAccepted: false }));
      }

      const decision = this.#begin(
        session,
        'notebook_apply',
        handle.notebookId,
        request.requestId,
        payload,
        APPLY_RECEIPT_BASE_BYTES + request.operations.length * APPLY_RECEIPT_BYTES_PER_OPERATION
      );
      if (decision.kind === 'replay') {
        return this.#replayValue<NotebookApplyResult>(session, decision.receipt);
      }
      return this.#runAccepted(session, decision.receipt, async () => {
        const applied = handle.model.apply(request.operations);
        const result: NotebookApplyResult = {
          notebookId: handle.notebookId,
          results: applied.results,
          appliedLocally: applied.appliedLocally,
          delivery: handle.delivery(),
          // SPEC.md §6: only `notebook_save` may ever say more than this.
          persistence: 'unconfirmed',
          structureRevision: applied.structureRevision,
          changesCursor: applied.changesCursor,
          ...(applied.partial === true
            ? { partial: true, partialAtOperation: applied.partialAtOperation ?? 0 }
            : {})
        };
        return {
          result,
          replay: { kind: 'value', value: result },
          effects: applied.partial === true ? 'unknown' : 'applied'
        };
      });
    });
  }

  // -------------------------------------------------------------------------
  // execution
  // -------------------------------------------------------------------------

  async notebookExecute(request: NotebookExecuteRequest): Promise<WithEnvelope<ExecutionView>> {
    this.#assertRunning();
    const { session, handle } = this.#locate(request.notebookId);
    const submitted = await session.lock.run(async () => {
      const payload = {
        cells: request.cells,
        stopOnError: request.stopOnError ?? true
      };
      const replay = this.#preflight(
        session,
        'notebook_execute',
        handle.notebookId,
        request.requestId,
        payload
      );
      if (replay !== null) {
        return this.#replayExecution(session, replay, request);
      }
      let binding;
      const acceptedCells: ExecutionCellRequest[] = [];
      try {
        handle.assertWritable();
        if (request.cells.length === 0) {
          throw coreError('INVALID_ARGUMENT', 'notebook_execute requires a non-empty cell list');
        }
        // Every target is checked before acceptance: a non-code cell and a
        // stale revision are `INVALID_ARGUMENT` / `REVISION_CONFLICT` before
        // any output area is touched (SPEC.md §8).
        for (const target of request.cells) {
          const entry = handle.model.index.require(target.cellId);
          const cell = resolveCell(handle.notebook, entry);
          if (!isCodeCell(cell)) {
            throw coreError('INVALID_ARGUMENT', `cell ${target.cellId} is not a code cell`, {
              details: { cell_id: target.cellId, cell_type: cellTypeOf(cell) }
            });
          }
          const current = sourceRevision('code', cell.getSource());
          if (current !== target.expectedSourceRevision) {
            throw coreError('REVISION_CONFLICT', `cell ${target.cellId} changed since the read`, {
              details: {
                cell_id: target.cellId,
                expected_source_revision: target.expectedSourceRevision,
                source_revision: current
              }
            });
          }
          acceptedCells.push({
            cellId: target.cellId,
            sourceRevision: target.expectedSourceRevision,
            identityToken: entry.identityToken
          });
        }
        const active = session.activeExecutions(handle.notebookId);
        if (active.length > 0) {
          throw coreError('EXECUTION_ACTIVE', 'this notebook already has an active execution', {
            details: { execution_ids: active.map((record) => record.executionId) }
          });
        }
        // SPEC.md §8: no binding means `KERNEL_NOT_BOUND` before outputs are
        // cleared and before any code is sent.
        binding = await this.#requireBinding(session, handle);
      } catch (error) {
        throw withEnvelopeDetails(error, session.envelope({ requestAccepted: false }));
      }

      const decision = this.#begin(
        session,
        'notebook_execute',
        handle.notebookId,
        request.requestId,
        payload
      );
      if (decision.kind === 'replay') {
        return this.#replayExecution(session, decision.receipt, request);
      }

      return this.#runAccepted(session, decision.receipt, async () => {
        const executionId = binding.registry.submit({
          notebookRef: { notebookId: handle.notebookId, sessionId: session.id },
          cells: acceptedCells,
          getSink: (cellId: string, identityToken: string) =>
            handle.model.beginExecutionGeneration(cellId, identityToken),
          revalidate: this.#revalidate(handle),
          stopOnError: request.stopOnError ?? true,
          maxOutputBytes: this.#config.limits.executionOutputMaxBytes
        });
        let stopped = false;
        const record: ExecutionRecord = {
          executionId,
          sessionId: session.id,
          notebookId: handle.notebookId,
          kernelId: binding.kernelId,
          registry: binding.registry,
          handle,
          createdAt: this.#now().toISOString(),
          finished: new Map(),
          invalidated: false,
          stop: () => {
            stopped = true;
          }
        };
        session.executions.set(executionId, record);
        this.#executionOwner.set(executionId, session);
        handle.executionIds.add(executionId);
        watchJob(record, () => stopped);
        this.#startKernelWatch();

        const view = await this.#executionView(session, record, {
          waitMs: 0,
          ...(request.limits === undefined ? {} : { limits: request.limits })
        });
        return { result: view, replay: { kind: 'execution', executionId } };
      });
    });
    if (this.#clampWait(request.waitMs) === 0 || TERMINAL_JOB_STATES.has(submitted.state)) {
      return { ...submitted, ...session.envelope() };
    }
    try {
      const { record } = this.#locateExecution(submitted.executionId);
      const view = await this.#executionView(session, record, {
        waitMs: request.waitMs ?? 0,
        untilTerminal: true,
        ...(request.limits === undefined ? {} : { limits: request.limits })
      });
      return { ...submitted, ...view, ...session.envelope() };
    } catch (error) {
      // Submission is already receipted. Observation failure cannot make a
      // retry eligible to send code again or change the accepted outcome.
      throw withEnvelopeDetails(error, { ...submitted, ...session.envelope() });
    }
  }

  async executionGet(request: ExecutionGetRequest): Promise<WithEnvelope<ExecutionView>> {
    this.#assertRunning();
    const { session, record } = this.#locateExecution(request.executionId);
    try {
      const view = await this.#executionView(session, record, {
        waitMs: request.waitMs ?? 0,
        ...(request.cursor === undefined ? {} : { cursor: request.cursor }),
        ...(request.limits === undefined ? {} : { limits: request.limits })
      });
      return { ...view, ...session.envelope() };
    } catch (error) {
      throw withEnvelopeDetails(error, session.envelope());
    }
  }

  async executionCancel(
    request: ExecutionCancelRequest
  ): Promise<WithEnvelope<ExecutionCancelResult>> {
    const { session, record } = this.#locateExecution(request.executionId);
    try {
      const snapshot = record.registry.cancel(request.executionId);
      const cancelled: string[] = [];
      const alreadySent: string[] = [];
      for (const cell of snapshot.job.cells) {
        if (cell.state === 'not_sent' && cell.notSentReason === 'cancelled') {
          cancelled.push(cell.cellId);
        } else if (cell.msgId !== undefined) {
          alreadySent.push(cell.cellId);
        }
      }
      return {
        executionId: request.executionId,
        state: snapshot.job.state,
        cancelledCellIds: cancelled,
        alreadySentCellIds: alreadySent,
        // SPEC.md §8: cancelling never interrupts the kernel.
        kernelInterrupted: false,
        ...session.envelope()
      };
    } catch (error) {
      throw withEnvelopeDetails(error, session.envelope());
    }
  }

  async outputRead(request: OutputReadRequest): Promise<WithEnvelope<OutputReadResult>> {
    const context = this.#callerContext(request.sessionId);
    const snapshot = this.#findSnapshot(request.outputId, context.sessions);
    if (snapshot === null) {
      // A snapshot of another context is indistinguishable from an expired one.
      throw withEnvelopeDetails(
        coreError('HANDLE_EXPIRED', `output snapshot ${request.outputId} is gone`, {
          details: { output_id: request.outputId }
        }),
        context.envelope()
      );
    }
    try {
      const limits = effectiveLimits(this.#config.limits, request.limits);
      const offset = request.cursor === undefined ? 0 : parseOutputCursor(request.cursor);
      if (offset > snapshot.byteSize) {
        throw coreError('CURSOR_EXPIRED', 'the output cursor is past the end of the snapshot', {
          details: { output_id: snapshot.outputId, byte_size: snapshot.byteSize }
        });
      }
      const envelope = context.envelope();
      let budget = limits.maxBytes;
      while (budget > 0) {
        const chunk = sliceSnapshot(snapshot, offset, budget);
        const end = offset + chunk.byteLength;
        const result: WithEnvelope<OutputReadResult> = {
          outputId: snapshot.outputId,
          uri: snapshot.uri,
          outputType: snapshot.outputType,
          mimeTypes: snapshot.mimeTypes,
          mimeType: snapshot.mimeType,
          encoding: snapshot.encoding,
          data: chunk.toString(snapshot.encoding === 'base64' ? 'base64' : 'utf8'),
          byteOffset: offset,
          byteSize: snapshot.byteSize,
          truncated: end < snapshot.byteSize,
          ...(end < snapshot.byteSize ? { nextCursor: makeOutputCursor(end) } : {}),
          lifetime: SNAPSHOT_LIFETIME,
          ...envelope
        };
        if (wireOutputReadByteSize(result) <= this.#config.limits.responseMaxBytes) return result;
        const nextBudget = Math.floor(budget / 2);
        if (nextBudget === budget) break;
        budget = nextBudget;
      }
      throw coreError('RESOURCE_LIMIT', 'output_read cannot fit one recoverable chunk in the response budget', {
        details: { output_id: snapshot.outputId, max_bytes: limits.maxBytes }
      });
    } catch (error) {
      throw withEnvelopeDetails(error, context.envelope());
    }
  }

  // -------------------------------------------------------------------------
  // observation and saving
  // -------------------------------------------------------------------------

  async notebookChanges(
    request: NotebookChangesRequest
  ): Promise<WithEnvelope<NotebookChangesResult>> {
    this.#assertRunning();
    const { session, handle } = this.#locate(request.notebookId);
    try {
      const waitMs = this.#clampWait(request.waitMs);
      const limit = request.limit ?? this.#config.limits.journalMaxEvents;
      const deadline = Date.now() + waitMs;
      let page = handle.model.changesSince(request.cursor, limit);
      let timedOut = false;
      while (page.events.length === 0 && Date.now() < deadline) {
        await sleep(POLL_INTERVAL_MS);
        if (handle.closed) break;
        page = handle.model.changesSince(request.cursor, limit);
      }
      // Only a wait that used its whole budget timed out; an answer produced
      // earlier - including one cut short by a closing handle - did not.
      if (page.events.length === 0 && waitMs > 0 && Date.now() >= deadline) timedOut = true;
      const lastSequence = handle.model.journal.lastSequence;
      const delivered = parseChangesCursor(page.nextCursor) ?? lastSequence;
      return {
        notebookId: handle.notebookId,
        events: page.events,
        nextCursor: page.nextCursor,
        truncated: delivered < lastSequence,
        connectionState: handle.connectionState,
        stale: handle.stale,
        waitTimedOut: timedOut,
        ...session.envelope()
      };
    } catch (error) {
      throw withEnvelopeDetails(error, session.envelope());
    }
  }

  async notebookSave(request: NotebookSaveRequest): Promise<WithEnvelope<NotebookSaveResult>> {
    this.#assertRunning();
    const { session, handle } = this.#locate(request.notebookId);
    try {
      handle.assertWritable();
      const structureRevision = handle.model.structureRevision;
      const requestedAt = this.#now().toISOString();
      const status = await handle.connection.save(this.#clampWait(request.timeoutMs, 20_000));
      if (status === 'failed') {
        throw coreError('SAVE_FAILED', 'the server reported a failed save', {
          details: { notebook_id: handle.notebookId, save_status: status }
        });
      }
      return {
        notebookId: handle.notebookId,
        saveStatus: status,
        // SPEC.md §6: without a verified ordering of updates against the save,
        // no specific revision may be called persisted.
        revisionPersistence: 'unknown',
        structureRevision,
        requestedAt,
        autosaveEnabled: true,
        ...session.envelope()
      };
    } catch (error) {
      throw withEnvelopeDetails(error, session.envelope());
    }
  }

  // -------------------------------------------------------------------------
  // kernels
  // -------------------------------------------------------------------------

  async kernelList(request: KernelListRequest): Promise<WithEnvelope<KernelListResult>> {
    this.#assertRunning();
    const session = await this.#sessionFor(request);
    try {
      const client = this.#servers.clientFor(session.server);
      const [specs, kernels, sessions] = await Promise.all([
        client.kernelSpecs(),
        client.listKernels(),
        client.listSessions()
      ]);
      const paths = new Map<string, string[]>();
      for (const entry of sessions) {
        if (entry.kernelId === null) continue;
        const list = paths.get(entry.kernelId) ?? [];
        list.push(entry.path);
        paths.set(entry.kernelId, list);
      }
      return {
        kernelspecs: specs.specs,
        defaultKernelName: specs.defaultName,
        running: kernels.map((kernel) => ({
          kernelId: kernel.id,
          kernelName: kernel.name,
          lastActivity: kernel.lastActivity,
          connections: kernel.connections,
          executionStatus: toExecutionStatus(kernel.executionState),
          boundPaths: paths.get(kernel.id) ?? []
        })),
        ...session.envelope()
      };
    } catch (error) {
      throw withEnvelopeDetails(error, session.envelope());
    }
  }

  async kernelStatus(request: KernelStatusRequest): Promise<WithEnvelope<KernelStatusResult>> {
    this.#assertRunning();
    const { session, handle } = this.#locate(request.notebookId);
    try {
      const status = await this.#kernelStatus(session, handle);
      return { ...status, ...session.envelope() };
    } catch (error) {
      throw withEnvelopeDetails(error, session.envelope());
    }
  }

  async kernelControl(request: KernelControlRequest): Promise<WithEnvelope<KernelControlResult>> {
    this.#assertRunning();
    const { session, handle } = this.#locate(request.notebookId);
    return session.lock.run(async () => {
      const payload = {
        action: request.action,
        expectedKernelId: request.expectedKernelId ?? null,
        kernelName: 'kernelName' in request ? (request.kernelName ?? null) : null
      };
      const replay = this.#preflight(
        session,
        'kernel_control',
        handle.notebookId,
        request.requestId,
        payload
      );
      if (replay !== null) return this.#replayValue<KernelControlResult>(session, replay);
      let bound: JupyterSessionInfo | null;
      let selectedSpec: KernelSpecEntry | null = null;
      try {
        // The binding check runs before the receipt: `KERNEL_CHANGED` and
        // `KERNEL_SELECTION_REQUIRED` never consume a number (SPEC.md §9).
        bound = await this.#lookupBinding(session, handle);
        const currentKernelId = bound?.kernelId ?? null;
        const expected = request.expectedKernelId ?? null;
        if (request.action !== 'start' && request.action !== 'switch' && bound === null) {
          throw coreError('KERNEL_NOT_BOUND', 'no kernel is bound to this notebook', {
            details: { notebook_id: handle.notebookId, path: handle.path }
          });
        }
        if (currentKernelId !== expected) {
          throw coreError('KERNEL_CHANGED', 'the kernel binding differs from expected_kernel_id', {
            details: {
              notebook_id: handle.notebookId,
              expected_kernel_id: expected,
              kernel_id: currentKernelId
            }
          });
        }
        if (request.action === 'start' || request.action === 'switch') {
          const available = await this.#servers.clientFor(session.server).kernelSpecs();
          const selectedName =
            request.action === 'switch'
              ? request.kernelName
              : (bound?.kernelName ?? request.kernelName ?? available.defaultName);
          selectedSpec = available.specs.find((spec) => spec.name === selectedName) ?? null;
          if (selectedSpec === null) {
            throw coreError('INVALID_ARGUMENT', 'the selected kernelspec is not available', {
              details: { kernel_name: selectedName }
            });
          }
        }
      } catch (error) {
        throw withEnvelopeDetails(error, session.envelope({ requestAccepted: false }));
      }

      const decision = this.#begin(
        session,
        'kernel_control',
        handle.notebookId,
        request.requestId,
        payload
      );
      if (decision.kind === 'replay') {
        return this.#replayValue<KernelControlResult>(session, decision.receipt);
      }
      return this.#runAccepted(session, decision.receipt, async () => {
        const result = await this.#applyKernelAction(
          session,
          handle,
          request,
          bound,
          selectedSpec
        );
        return { result, replay: { kind: 'value', value: result } };
      });
    });
  }

  // -------------------------------------------------------------------------
  // MCP resources
  // -------------------------------------------------------------------------

  async readOutputResource(uri: string, sessionId?: string): Promise<OutputResourceContents> {
    const parsed = parseOutputUri(uri);
    if (parsed === null) {
      throw coreError('INVALID_ARGUMENT', 'not a jupyter-output URI issued by this process', {
        details: { uri }
      });
    }
    const context = this.#callerContext(sessionId);
    // The long form names a session: it resolves only inside the caller's own
    // context, exactly like the short form.
    const scope =
      parsed.sessionId === null
        ? context.sessions
        : context.sessions.filter((entry) => entry.id === parsed.sessionId);
    const snapshot = this.#findSnapshot(parsed.outputId, scope);
    if (snapshot === null) {
      throw coreError('HANDLE_EXPIRED', 'this output snapshot is no longer available', {
        details: { uri }
      });
    }
    const budget = this.#config.limits.resourceReadMaxBytes;
    if (snapshot.byteSize > budget) {
      // SPEC.md §9: no partial blob is invented here; the caller pages through
      // `output_read` under the ordinary response limit.
      return {
        uri: snapshot.uri,
        outputId: snapshot.outputId,
        mimeType: snapshot.mimeType,
        byteSize: snapshot.byteSize,
        truncated: true,
        continueWith: { tool: 'output_read', outputId: snapshot.outputId },
        lifetime: SNAPSHOT_LIFETIME
      };
    }
    return {
      uri: snapshot.uri,
      outputId: snapshot.outputId,
      mimeType: snapshot.mimeType,
      ...(snapshot.encoding === 'base64'
        ? { blob: snapshot.bytes.toString('base64') }
        : { text: snapshot.bytes.toString('utf8') }),
      byteSize: snapshot.byteSize,
      truncated: false,
      lifetime: SNAPSHOT_LIFETIME
    };
  }

  async listOutputResources(
    cursor?: string,
    sessionId?: string
  ): Promise<ListOutputResourcesResult> {
    const all: OutputResourceDescriptor[] = [];
    for (const session of this.#callerContext(sessionId).sessions) {
      for (const snapshot of session.outputs.list()) {
        all.push({
          uri: snapshot.uri,
          outputId: snapshot.outputId,
          name: snapshot.name,
          mimeType: snapshot.mimeType,
          byteSize: snapshot.byteSize,
          executionId: snapshot.executionId,
          notebookId: snapshot.notebookId,
          lifetime: SNAPSHOT_LIFETIME
        });
      }
    }
    const offset = cursor === undefined ? 0 : parseDirectoryCursor(cursor);
    const page = all.slice(offset, offset + 100);
    const end = offset + page.length;
    return {
      resources: page,
      ...(end < all.length ? { nextCursor: makeDirectoryCursor(end) } : {})
    };
  }

  // -------------------------------------------------------------------------
  // process
  // -------------------------------------------------------------------------

  async shutdown(_reason: ShutdownReason): Promise<void> {
    if (this.#shuttingDown) return;
    this.#shuttingDown = true;
    // SPEC.md §4: stop accepting work, try to flush pending updates within a
    // short deadline, then release everything. Kernels keep running.
    const deadline = Date.now() + 2000;
    for (const session of this.#sessions.all()) {
      for (const handle of session.notebooks.values()) {
        while (Date.now() < deadline && handle.delivery() === 'pending') {
          await sleep(POLL_INTERVAL_MS);
        }
      }
    }
    for (const session of this.#sessions.all()) {
      try {
        this.#teardownSession(session);
      } catch {
        // Shutdown problems go to stderr through the caller; stdout is MCP's.
      }
    }
    this.#implicitLedger.clear();
    this.#implicitSessions.clear();
    if (this.#kernelWatch !== null) {
      clearInterval(this.#kernelWatch);
      this.#kernelWatch = null;
    }
    this.#kernels.dispose();
    this.#restoreConsole?.();
  }

  // -------------------------------------------------------------------------
  // internals
  // -------------------------------------------------------------------------

  #assertRunning(): void {
    if (this.#shuttingDown) {
      throw coreError('HANDLE_EXPIRED', 'the service is shutting down and accepts no new work');
    }
  }

  #clampWait(waitMs: number | undefined, fallback = 0): number {
    const max = this.#config.limits.maxWaitMs;
    if (waitMs === undefined) return Math.min(fallback, max);
    if (!Number.isFinite(waitMs) || waitMs < 0) return 0;
    return Math.min(Math.floor(waitMs), max);
  }

  /** Resolve a notebook handle and its owning session. */
  #locate(notebookId: string): { session: WorkingSession; handle: NotebookHandle } {
    const session = this.#notebookOwner.get(notebookId);
    if (session === undefined || session.closed) {
      throw coreError('HANDLE_EXPIRED', `unknown notebook handle ${notebookId}`, {
        details: { notebook_id: notebookId, next_request_id: null }
      });
    }
    return { session, handle: session.requireNotebook(notebookId) };
  }

  #locateExecution(executionId: string): { session: WorkingSession; record: ExecutionRecord } {
    const session = this.#executionOwner.get(executionId);
    const record = session?.executions.get(executionId);
    if (session === undefined || session.closed || record === undefined) {
      throw coreError('HANDLE_EXPIRED', `unknown execution ${executionId}`, {
        details: { execution_id: executionId, next_request_id: null }
      });
    }
    return { session, record };
  }

  /**
   * The working context of one caller: the sessions it may address and the
   * envelope its answers carry (SPEC.md §4).
   *
   * An MCP connection names no session and addresses its implicit context -
   * every session bound to the connection-wide ledger. A library caller names
   * its own session. Nothing of another context is reachable either way.
   *
   * @throws CoreError `HANDLE_EXPIRED` - unknown or closed session.
   */
  #callerContext(sessionId?: string | null): {
    sessions: readonly WorkingSession[];
    envelope: (extra?: Omit<SessionEnvelope, 'nextRequestId'>) => SessionEnvelope;
  } {
    if (sessionId !== undefined && sessionId !== null) {
      const session = this.#sessions.require(sessionId);
      return { sessions: [session], envelope: (extra = {}) => session.envelope(extra) };
    }
    return {
      sessions: this.#sessions.all().filter((entry) => entry.ledger === this.#implicitLedger),
      envelope: (extra = {}) => ({
        nextRequestId: this.#implicitLedger.nextRequestId,
        ...extra
      })
    };
  }

  /** The snapshot, if one of the caller's sessions owns it. */
  #findSnapshot(outputId: string, scope: readonly WorkingSession[]): OutputSnapshot | null {
    for (const session of scope) {
      const snapshot = session.outputs.peek(outputId);
      if (snapshot !== undefined) return snapshot;
    }
    return null;
  }

  // -- the request ledger ----------------------------------------------------

  #preflight(
    session: WorkingSession,
    tool: DedupTool,
    target: string | null,
    requestId: string,
    payload: unknown
  ): Receipt | null {
    try {
      const decision = session.ledger.preflight({ requestId, tool, target, payload });
      return decision?.receipt ?? null;
    } catch (error) {
      const accepted = isCoreError(error) && error.code === 'REQUEST_ID_EXPIRED' ? null : false;
      throw withEnvelopeDetails(error, session.envelope({ requestAccepted: accepted }));
    }
  }

  #begin(
    session: WorkingSession,
    tool: DedupTool,
    target: string | null,
    requestId: string,
    payload: unknown,
    reserveBytes?: number
  ): ReturnType<RequestLedger['begin']> {
    try {
      return session.ledger.begin({
        requestId,
        tool,
        target,
        payload,
        ...(reserveBytes === undefined ? {} : { reserveBytes })
      });
    } catch (error) {
      const accepted = isCoreError(error) && error.code === 'REQUEST_ID_EXPIRED' ? null : false;
      throw withEnvelopeDetails(error, session.envelope({ requestAccepted: accepted }));
    }
  }

  /** Replay a stored value receipt (SPEC.md §9). */
  #replayValue<T>(session: WorkingSession, receipt: Receipt): WithEnvelope<T> {
    const envelope = session.envelope({
      requestAccepted: true,
      replayed: true,
      firstAcceptedAt: receipt.firstAcceptedAt
    });
    if (receipt.failure !== null) throw withEnvelopeDetails(receipt.failure, envelope);
    if (receipt.replay?.kind !== 'value') {
      throw withEnvelopeDetails(
        coreError('REQUEST_ID_EXPIRED', 'the stored result of this request_id is gone'),
        session.envelope({ requestAccepted: null })
      );
    }
    return { ...(receipt.replay.value as T), ...envelope };
  }

  async #replayExecution(
    session: WorkingSession,
    receipt: Receipt,
    request: NotebookExecuteRequest
  ): Promise<WithEnvelope<ExecutionView>> {
    if (receipt.failure !== null) {
      throw withEnvelopeDetails(
        receipt.failure,
        session.envelope({
          requestAccepted: true,
          replayed: true,
          firstAcceptedAt: receipt.firstAcceptedAt
        })
      );
    }
    if (receipt.replay?.kind === 'execution') {
      const record = session.executions.get(receipt.replay.executionId);
      if (record !== undefined) {
        const view = await this.#executionView(session, record, {
          waitMs: 0,
          ...(request.limits === undefined ? {} : { limits: request.limits })
        });
        return {
          ...view,
          ...session.envelope({
            requestAccepted: true,
            replayed: true,
            firstAcceptedAt: receipt.firstAcceptedAt
          })
        };
      }
    }
    throw withEnvelopeDetails(
      coreError('REQUEST_ID_EXPIRED', 'the job of this request_id is no longer retained'),
      session.envelope({ requestAccepted: null })
    );
  }

  /** Run the effect of an accepted request and record its outcome. */
  async #runAccepted<T>(
    session: WorkingSession,
    receipt: Receipt,
    effect: () => Promise<{
      result: T;
      replay: Parameters<RequestLedger['complete']>[1];
      effects?: Parameters<RequestLedger['complete']>[2];
    }>
  ): Promise<WithEnvelope<T>> {
    try {
      const outcome = await effect();
      session.ledger.complete(receipt, outcome.replay, outcome.effects ?? 'applied');
      return {
        ...outcome.result,
        ...session.envelope({
          requestAccepted: true,
          replayed: false,
          firstAcceptedAt: receipt.firstAcceptedAt
        })
      };
    } catch (error) {
      const core = toCoreError(error);
      session.ledger.fail(receipt, core, core.sideEffects);
      throw withEnvelopeDetails(
        core,
        session.envelope({
          requestAccepted: true,
          replayed: false,
          firstAcceptedAt: receipt.firstAcceptedAt
        })
      );
    }
  }

  // -- notebooks -------------------------------------------------------------

  #validateCreate(
    session: WorkingSession,
    request: NotebookCreateRequest
  ): { directory: string; name: string | undefined } {
    try {
      const directory = normalizeContentsPath(request.directory);
      const name = request.name === undefined ? undefined : validateNotebookName(request.name);
      return { directory, name };
    } catch (error) {
      throw withEnvelopeDetails(error, session.envelope({ requestAccepted: false }));
    }
  }

  #assertReplicaBudget(): void {
    if (this.#sessions.openNotebookCount() >= this.#config.limits.maxOpenNotebooks) {
      throw coreError('RESOURCE_LIMIT', 'the open-replica budget of this process is exhausted', {
        details: {
          open_notebooks: this.#sessions.openNotebookCount(),
          limit: this.#config.limits.maxOpenNotebooks
        }
      });
    }
  }

  /** Open the room of `path` in `session` and register the handle. */
  async #openHandle(
    session: WorkingSession,
    path: string
  ): Promise<{ handle: NotebookHandle; reused: boolean }> {
    this.#assertSessionOpen(session);
    this.#assertReplicaBudget();
    const server = session.server;
    const client = this.#servers.clientFor(server);
    // A `PUT` on the collaboration session mints an id even for a missing
    // path; the room then closes with 4404 (spike/NOTES.md §1.2), so existence
    // is checked separately and answered as `NOTEBOOK_NOT_FOUND`.
    const stat = await client.contentsExists(path);
    this.#assertSessionOpen(session);
    if (stat === null) {
      throw coreError('NOTEBOOK_NOT_FOUND', `no notebook at "${path}"`, { details: { path } });
    }
    if (stat.type !== 'notebook') {
      throw coreError('INVALID_ARGUMENT', `"${path}" is not a notebook`, {
        details: { path, type: stat.type }
      });
    }
    const document = await this.#servers.collaborationSession(server, path);
    this.#assertSessionOpen(session);
    const alreadyOpen = session.findByFileId(document.fileId);
    if (alreadyOpen !== null) return { handle: alreadyOpen, reused: true };

    const handle = await this.#openReplica({
      notebookId: `nb_${randomUUID()}`,
      sessionId: session.id,
      path,
      fileId: document.fileId,
      collaborationSessionId: document.sessionId,
      wsBaseUrl: client.wsBaseUrl,
      ...client.connectionAuth(),
      awarenessUser: this.#config.awarenessUser,
      journalLimit: this.#config.limits.journalMaxEvents,
      revalidateFileId: async () =>
        (await this.#servers.collaborationSession(server, path)).fileId,
      openTimeoutMs: this.#openTimeoutMs
    });
    if (session.closed) {
      handle.dispose();
      this.#assertSessionOpen(session);
    }
    session.notebooks.set(handle.notebookId, handle);
    this.#notebookOwner.set(handle.notebookId, session);
    return { handle, reused: false };
  }

  #openResult(
    session: WorkingSession,
    handle: NotebookHandle,
    reused: boolean,
    limits?: ResponseLimits
  ): WithEnvelope<NotebookOpenResult> {
    const effective = effectiveLimits(this.#config.limits, limits);
    const snapshot = handle.model.snapshotWithCursor({
      maxCells: effective.maxCells,
      previewChars: effective.previewChars
    });
    return {
      notebook: handle.info(),
      reused,
      summary: withIdentity(snapshot.summary, identityOf(handle)),
      changesCursor: snapshot.changesCursor,
      ...session.envelope()
    };
  }

  /** Release one replica, its binding and its jobs. Kernels keep running. */
  #closeNotebook(session: WorkingSession, handle: NotebookHandle): void {
    for (const executionId of handle.executionIds) {
      const record = session.executions.get(executionId);
      record?.stop();
      session.executions.delete(executionId);
      this.#executionOwner.delete(executionId);
    }
    handle.executionIds.clear();
    const binding = session.bindings.get(handle.notebookId);
    if (binding !== undefined) {
      binding.off();
      binding.lease.release();
      session.bindings.delete(handle.notebookId);
    }
    handle.dispose();
    session.notebooks.delete(handle.notebookId);
    this.#notebookOwner.delete(handle.notebookId);
    this.#closedNotebooks.add(handle.notebookId);
    if (this.#closedNotebooks.size > 256) {
      const oldest = this.#closedNotebooks.values().next();
      if (!oldest.done) this.#closedNotebooks.delete(oldest.value);
    }
  }

  #teardownSession(session: WorkingSession): void {
    session.closed = true;
    session.opening.clear();
    for (const handle of [...session.notebooks.values()]) this.#closeNotebook(session, handle);
    for (const executionId of session.executions.keys()) {
      this.#executionOwner.delete(executionId);
    }
    session.executions.clear();
    session.outputs.clear();
    if (session.ledger !== this.#implicitLedger) session.ledger.clear();
    this.#sessions.forget(session.id);
  }

  #assertSessionOpen(session: WorkingSession): void {
    if (session.closed) {
      throw coreError('HANDLE_EXPIRED', 'working context was closed', {
        details: { next_request_id: null }
      });
    }
  }

  // -- outputs ---------------------------------------------------------------

  /**
   * Bound the outputs of one cell for a `notebook_read(view: 'outputs')`
   * answer (SPEC.md §9).
   *
   * The model already decided what fits the byte budget. Whatever did not is
   * interned once, so the caller gets an `output_id`, the MIME types and the
   * full size instead of a base64 blob in a text answer. The full outputs of
   * the cell are read at most once, and only when something was cut.
   */
  #outputEntries(
    session: WorkingSession,
    handle: NotebookHandle,
    cell: {
      readonly cellId: string;
      readonly outputs: readonly {
        readonly index: number;
        readonly outputType: string;
        readonly mimeTypes: readonly string[];
        readonly byteSize: number;
        readonly truncated: boolean;
        readonly output?: NbOutput;
        readonly textPreview?: string;
      }[];
    }
  ): OutputEntry[] {
    const anyTruncated = cell.outputs.some((output) => output.truncated);
    const full = anyTruncated
      ? (handle.model.readOutputs([cell.cellId], { maxBytes: Number.MAX_SAFE_INTEGER }).cells[0]
          ?.outputs ?? [])
      : [];
    return cell.outputs.map((read) => {
      if (!read.truncated && read.output !== undefined) {
        return {
          index: read.index,
          outputType: read.outputType,
          mimeTypes: read.mimeTypes,
          byteSize: read.byteSize,
          truncated: false,
          output: read.output
        };
      }
      const payload = full.find((entry) => entry.index === read.index)?.output;
      if (payload === undefined) {
        return {
          index: read.index,
          outputType: read.outputType,
          mimeTypes: read.mimeTypes,
          byteSize: read.byteSize,
          truncated: true,
          ...(read.textPreview === undefined ? {} : { textPreview: read.textPreview })
        };
      }
      const entry = toOutputEntry(
        payload,
        read.index,
        { remaining: 0, maxOutputBytes: 0 },
        { notebookId: handle.notebookId, executionId: 'read', cellId: cell.cellId },
        session.outputs
      );
      return {
        ...entry,
        ...(read.textPreview === undefined ? {} : { textPreview: read.textPreview })
      };
    });
  }

  // -- execution -------------------------------------------------------------

  /**
   * The pre-send re-check of SPEC.md §8, on the cheap path: resolve the id,
   * confirm the CRDT object and compare the source revision without building a
   * whole `notebook_read` answer.
   */
  #revalidate(handle: NotebookHandle): Revalidate {
    return (cellId, expected, expectedIdentityToken): RevalidateResult => {
      try {
        const entry = handle.model.index.require(cellId);
        if (entry.identityToken !== expectedIdentityToken) {
          return { ok: false, code: 'cell_replaced' };
        }
        const cell = resolveCell(handle.notebook, entry);
        const type = cellTypeOf(cell);
        const source = cell.getSource();
        if (sourceRevision(type, source) !== expected) {
          return { ok: false, code: 'revision_conflict' };
        }
        return { ok: true, source, identityToken: entry.identityToken };
      } catch (error) {
        const code = isCoreError(error) ? error.code : 'INTERNAL_ERROR';
        if (code === 'CELL_ID_AMBIGUOUS') return { ok: false, code: 'cell_id_ambiguous' };
        if (code === 'CELL_REPLACED') return { ok: false, code: 'cell_replaced' };
        return { ok: false, code: 'cell_not_found' };
      }
    };
  }

  async #executionView(
    session: WorkingSession,
    record: ExecutionRecord,
    options: { waitMs: number; cursor?: string; limits?: ResponseLimits; untilTerminal?: boolean }
  ): Promise<ExecutionView> {
    const first = record.registry.get(record.executionId);
    if (first === undefined) {
      throw coreError('HANDLE_EXPIRED', `unknown execution ${record.executionId}`, {
        details: { execution_id: record.executionId }
      });
    }
    const parsed =
      options.cursor === undefined
        ? null
        : parseExecutionCursor(options.cursor, first.job.cells.length);
    if (parsed !== null && parsed.registryCursor > first.cursor) {
      throw coreError('CURSOR_EXPIRED', 'the execution cursor is ahead of the job state', {
        details: { cursor: options.cursor }
      });
    }
    const waitMs = this.#clampWait(options.waitMs);
    // Without a cursor the caller asked for "the next change", so the wait is
    // measured from the state it is being handed right now (SPEC.md §8).
    const since = parsed?.registryCursor ?? first.cursor;
    let snapshot = first;
    // Nothing to wait for when undelivered changes are already there, and
    // nothing can arrive for a terminal job: both answer at once, so neither
    // reports a timeout (SPEC.md §8).
    const settled = (!options.untilTerminal && first.cursor > since) || TERMINAL_JOB_STATES.has(first.job.state);
    let waitTimedOut = false;
    if (waitMs > 0 && !settled) {
      const deadline = Date.now() + waitMs;
      for (;;) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) {
          waitTimedOut = true;
          break;
        }
        snapshot = await record.registry.waitForChange(record.executionId,
          options.untilTerminal ? snapshot.cursor : since, remaining);
        if (TERMINAL_JOB_STATES.has(snapshot.job.state) || (!options.untilTerminal && snapshot.cursor > since)) break;
      }
    }
    if (session.closed || record.handle.closed) {
      throw coreError('HANDLE_EXPIRED', 'the execution context was closed while waiting', {
        details: { execution_id: record.executionId }
      });
    }
    // The watcher normally does this, but a caller that waited should never
    // see a finished cell whose `[*]` is still on screen (SPEC.md §8).
    return buildExecutionView(record, snapshot, {
      limits: this.#config.limits,
      requested: options.limits,
      positions: parsed?.positions ?? null,
      waitTimedOut,
      outputs: session.outputs
    });
  }

  // -- kernels ---------------------------------------------------------------

  /**
   * Notice a kernel that disappeared while one of our jobs was running
   * (SPEC.md §8: an observed shutdown / dead kernel invalidates unfinished
   * work, and sent work without proof becomes `unknown`).
   *
   * Only the provable case is acted on: the kernel is no longer in
   * `GET /api/kernels`. An in-place restart from another client keeps the
   * kernel id and, on jupyter-server 2.21.0, reaches this process through no
   * signal at all - measured, see `src/service/README.md`.
   */
  #startKernelWatch(): void {
    if (this.#kernelWatch !== null) return;
    const timer = setInterval(() => void this.#pollKernels(), KERNEL_WATCH_MS);
    timer.unref?.();
    this.#kernelWatch = timer;
  }

  async #pollKernels(): Promise<void> {
    if (this.#shuttingDown) return;
    const watched = new Map<string, { server: ServerEntry; kernelIds: Set<string> }>();
    for (const session of this.#sessions.all()) {
      for (const record of session.activeExecutions()) {
        if (record.kernelId === null) continue;
        const bucket = watched.get(session.server.id) ?? {
          server: session.server,
          kernelIds: new Set<string>()
        };
        bucket.kernelIds.add(record.kernelId);
        watched.set(session.server.id, bucket);
      }
    }
    if (watched.size === 0) {
      if (this.#kernelWatch !== null) {
        clearInterval(this.#kernelWatch);
        this.#kernelWatch = null;
      }
      return;
    }
    for (const bucket of watched.values()) {
      let alive: Set<string>;
      try {
        alive = new Set((await this.#servers.clientFor(bucket.server).listKernels()).map((k) => k.id));
      } catch {
        // A transport failure proves nothing about the kernel (SPEC.md §8).
        continue;
      }
      for (const kernelId of bucket.kernelIds) {
        if (alive.has(kernelId)) continue;
        this.#kernels.invalidate(bucket.server.id, kernelId);
        for (const session of this.#sessions.all()) {
          if (session.server.id !== bucket.server.id) continue;
          for (const [notebookId, binding] of [...session.bindings]) {
            if (binding.kernelId !== kernelId) continue;
            binding.off();
            binding.lease.release();
            session.bindings.delete(notebookId);
            session.notebooks.get(notebookId)?.recordKernelChange(null);
          }
          for (const record of session.executions.values()) {
            if (record.kernelId === kernelId) record.invalidated = true;
          }
        }
      }
    }
  }

  async #sessionsByPath(
    client: ServerClient
  ): Promise<{ sessions: Map<string, JupyterSessionInfo>; included: boolean }> {
    try {
      const list = await client.listSessions();
      const map = new Map<string, JupyterSessionInfo>();
      for (const entry of list) map.set(entry.path, entry);
      return { sessions: map, included: true };
    } catch {
      return { sessions: new Map(), included: false };
    }
  }

  /**
   * The Sessions API binding of one notebook path (SPEC.md §8).
   *
   * @throws CoreError `KERNEL_SELECTION_REQUIRED` - several sessions claim the
   * path, so no single binding can be chosen.
   */
  async #lookupBinding(
    session: WorkingSession,
    handle: NotebookHandle
  ): Promise<JupyterSessionInfo | null> {
    const client = this.#servers.clientFor(session.server);
    const all = await client.listSessions();
    const matches = all.filter((entry) => entry.path === handle.path && entry.kernelId !== null);
    if (matches.length === 0) return null;
    if (matches.length > 1) {
      throw coreError(
        'KERNEL_SELECTION_REQUIRED',
        'several Jupyter sessions are bound to this notebook path',
        {
          details: {
            path: handle.path,
            jupyter_session_ids: matches.map((entry) => entry.id)
          }
        }
      );
    }
    return matches[0]!;
  }

  /**
   * Ensure a live {@link KernelLease} for the notebook's current binding.
   *
   * @throws CoreError `KERNEL_NOT_BOUND` when nothing is bound: reading or
   * opening a notebook never starts a kernel (SPEC.md §8).
   */
  async #requireBinding(
    session: WorkingSession,
    handle: NotebookHandle
  ): Promise<{ kernelId: string; registry: ExecutionRecord['registry'] }> {
    const info = await this.#lookupBinding(session, handle);
    if (info === null || info.kernelId === null) {
      throw coreError('KERNEL_NOT_BOUND', 'no kernel is bound to this notebook', {
        details: { notebook_id: handle.notebookId, path: handle.path }
      });
    }
    const bound = this.#bind(session, handle, info);
    return { kernelId: bound.kernelId, registry: bound.lease.registry };
  }

  /** Attach (or re-attach) the shared kernel connection to a handle. */
  #bind(
    session: WorkingSession,
    handle: NotebookHandle,
    info: JupyterSessionInfo
  ): { kernelId: string; lease: ReturnType<KernelHub['acquire']> } {
    const kernelId = info.kernelId!;
    const existing = session.bindings.get(handle.notebookId);
    if (
      existing !== undefined &&
      existing.kernelId === kernelId &&
      !existing.lease.client.isDisposed
    ) {
      return { kernelId, lease: existing.lease };
    }
    if (existing !== undefined) {
      existing.off();
      existing.lease.release();
      session.bindings.delete(handle.notebookId);
    }
    const client = this.#servers.clientFor(session.server);
    const lease = this.#kernels.acquire(
      session.server.id,
      client.serverSettings(),
      kernelId,
      info.kernelName ?? undefined
    );
    // SPEC.md §8: an observed restart / shutdown / rebinding - including one a
    // browser triggered - invalidates unfinished jobs and is journalled.
    const off = lease.client.onKernelChanged(() => {
      handle.recordKernelChange(kernelId);
      for (const record of session.executions.values()) {
        if (record.notebookId === handle.notebookId) record.invalidated = true;
      }
    });
    session.bindings.set(handle.notebookId, {
      jupyterSessionId: info.id,
      kernelId,
      kernelName: info.kernelName ?? '',
      lease,
      off
    });
    handle.recordKernelChange(kernelId);
    return { kernelId, lease };
  }

  async #kernelStatus(
    session: WorkingSession,
    handle: NotebookHandle
  ): Promise<KernelStatusResult> {
    const info = await this.#lookupBinding(session, handle);
    const active = session.activeExecutions(handle.notebookId).map((record) => record.executionId);
    if (info === null || info.kernelId === null) {
      return {
        notebookId: handle.notebookId,
        kernelId: null,
        kernelName: null,
        jupyterSessionId: null,
        channelState: 'disconnected',
        executionStatus: 'unknown',
        observedAt: this.#now().toISOString(),
        activeExecutionIds: active
      };
    }
    const lease = this.#kernels.peek(session.server.id, info.kernelId);
    const observed = lease?.client.kernelStatus() ?? null;
    return {
      notebookId: handle.notebookId,
      kernelId: info.kernelId,
      kernelName: info.kernelName,
      jupyterSessionId: info.id,
      channelState: observed?.channel ?? 'disconnected',
      // Our own observation wins when we hold a socket; otherwise the server's
      // last reported state, which may be somebody else's `busy` (SPEC.md §8).
      executionStatus: observed?.execution ?? toExecutionStatus(info.executionState),
      observedAt: observed?.observedAt ?? this.#now().toISOString(),
      activeExecutionIds: active
    };
  }

  async #applyKernelAction(
    session: WorkingSession,
    handle: NotebookHandle,
    request: KernelControlRequest,
    bound: JupyterSessionInfo | null,
    selectedSpec: KernelSpecEntry | null
  ): Promise<KernelControlResult> {
    const client = this.#servers.clientFor(session.server);
    const previousKernelId = bound?.kernelId ?? null;
    const invalidated = session
      .activeExecutions(handle.notebookId)
      .map((record) => record.executionId);
    const effects: {
      kernelStarted: boolean;
      kernelInterrupted: boolean;
      kernelRestarted: boolean;
      kernelShutDown: boolean;
      bindingChanged: boolean;
    } = {
      kernelStarted: false,
      kernelInterrupted: false,
      kernelRestarted: false,
      kernelShutDown: false,
      bindingChanged: false
    };
    let after: JupyterSessionInfo | null = bound;

    switch (request.action) {
      case 'start': {
        if (bound !== null) break; // An existing session is reused (SPEC.md §8).
        after = await client.startSession({
          path: handle.path,
          ...(request.kernelName === undefined ? {} : { kernelName: request.kernelName })
        });
        effects.kernelStarted = true;
        effects.bindingChanged = true;
        break;
      }
      case 'interrupt': {
        // Through the kernel connection when we hold one: that is the same
        // request the browser sends, and our own client observes its effect.
        const lease = this.#kernels.peek(session.server.id, previousKernelId!);
        if (lease === null) await client.interruptKernel(previousKernelId!);
        else await lease.client.interrupt();
        effects.kernelInterrupted = true;
        break;
      }
      case 'restart': {
        const lease = this.#kernels.peek(session.server.id, previousKernelId!);
        if (lease === null) await client.restartKernel(previousKernelId!);
        else await lease.client.restart();
        effects.kernelRestarted = true;
        // The kernel keeps its id but is a different process: everything we
        // sent to the old one loses its evidence (SPEC.md §8).
        this.#kernels.invalidate(session.server.id, previousKernelId!);
        break;
      }
      case 'shutdown': {
        await client.deleteSession(bound!.id);
        effects.kernelShutDown = true;
        effects.bindingChanged = true;
        this.#kernels.invalidate(session.server.id, previousKernelId!);
        after = null;
        break;
      }
      case 'switch': {
        after =
          bound === null
            ? await client.startSession({ path: handle.path, kernelName: request.kernelName })
            : await client.patchSessionKernel(bound.id, request.kernelName);
        effects.kernelStarted = bound === null;
        effects.bindingChanged = after.kernelId !== previousKernelId;
        if (effects.bindingChanged && previousKernelId !== null) {
          this.#kernels.invalidate(session.server.id, previousKernelId);
        }
        break;
      }
      default: {
        throw coreError('INVALID_ARGUMENT', 'unknown kernel_control action');
      }
    }

    if (effects.bindingChanged || effects.kernelRestarted) {
      for (const record of session.executions.values()) {
        if (record.notebookId === handle.notebookId) record.invalidated = true;
      }
    }
    if (effects.kernelRestarted || effects.bindingChanged) {
      // The lease points at a connection that no longer exists; drop it so the
      // next call builds a fresh one.
      const stale = session.bindings.get(handle.notebookId);
      if (stale !== undefined) {
        stale.off();
        stale.lease.release();
        session.bindings.delete(handle.notebookId);
      }
    }
    if (after === null || after.kernelId === null) {
      handle.recordKernelChange(null);
    } else {
      this.#bind(session, handle, after);
    }
    if ((request.action === 'start' || request.action === 'switch') && selectedSpec !== null) {
      handle.model.setKernelSpecMetadata(selectedSpec);
    }

    const status = await this.#kernelStatus(session, handle);
    const controlEffects: KernelControlEffects = {
      ...effects,
      invalidatedExecutionIds: effects.bindingChanged || effects.kernelRestarted ? invalidated : [],
      // SPEC.md §8: no kernel action clears outputs.
      outputsCleared: false
    };
    return {
      notebookId: handle.notebookId,
      action: request.action,
      previousKernelId,
      kernelId: after?.kernelId ?? null,
      kernelName: after?.kernelName ?? null,
      jupyterSessionId: after?.id ?? null,
      effects: controlEffects,
      status
    };
  }
}

/** Exact JSON shape used by the adapter for one output_read result. */
function wireOutputReadByteSize(result: WithEnvelope<OutputReadResult>): number {
  return Buffer.byteLength(
    JSON.stringify({
      output_id: result.outputId,
      uri: result.uri,
      output_type: result.outputType,
      mime_types: result.mimeTypes,
      mime_type: result.mimeType,
      encoding: result.encoding,
      data: result.data,
      byte_offset: result.byteOffset,
      byte_size: result.byteSize,
      truncated: result.truncated,
      ...(result.nextCursor === undefined ? {} : { next_cursor: result.nextCursor }),
      lifetime: {
        scope: result.lifetime.scope,
        released_by: result.lifetime.releasedBy,
        process_scoped: result.lifetime.processScoped
      },
      ...(result.nextRequestId === undefined ? {} : { next_request_id: result.nextRequestId })
    }),
    'utf8'
  );
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function identityOf(handle: NotebookHandle): {
  notebookId: string;
  path: string;
  fileId: string;
  documentId: string;
  connectionState: NotebookHandle['connectionState'];
  stale: boolean;
} {
  return {
    notebookId: handle.notebookId,
    path: handle.path,
    fileId: handle.fileId,
    documentId: handle.documentId,
    connectionState: handle.connectionState,
    stale: handle.stale
  };
}

function notebookMetadata(handle: NotebookHandle): Readonly<Record<string, unknown>> | null {
  try {
    const metadata = handle.notebook.getMetadata() as unknown;
    if (metadata === null || typeof metadata !== 'object') return null;
    const size = Buffer.byteLength(JSON.stringify(metadata) ?? 'null', 'utf8');
    return size > 8 * 1024 ? null : (metadata as Readonly<Record<string, unknown>>);
  } catch {
    return null;
  }
}

function baseName(path: string): string {
  const at = path.lastIndexOf('/');
  return at < 0 ? path : path.slice(at + 1);
}

/**
 * Re-report a failed rename with the untitled file that already exists
 * (SPEC.md §6 "notebook creation").
 */
function renameFailure(error: unknown, untitledPath: string, target: string): CoreError {
  const core = toCoreError(error);
  return coreError(core.code, core.message, {
    retryable: core.retryable,
    // The untitled file stays on the server and is not deleted.
    sideEffects: 'applied',
    details: {
      ...(core.details ?? {}),
      untitled_path: untitledPath,
      intended_path: target,
      room_opened: false
    },
    cause: core
  });
}

function toNotebookSessionInfo(info: JupyterSessionInfo): {
  jupyterSessionId: string;
  kernelId: string | null;
  kernelName: string | null;
  executionStatus?: ReturnType<typeof toExecutionStatus>;
} {
  return {
    jupyterSessionId: info.id,
    kernelId: info.kernelId,
    kernelName: info.kernelName,
    ...(info.executionState === null
      ? {}
      : { executionStatus: toExecutionStatus(info.executionState) })
  };
}

const EXECUTION_STATES = new Set([
  'unknown',
  'starting',
  'idle',
  'busy',
  'terminating',
  'restarting',
  'autorestarting',
  'dead'
]);

function toExecutionStatus(
  value: string | null
): 'unknown' | 'starting' | 'idle' | 'busy' | 'terminating' | 'restarting' | 'autorestarting' | 'dead' {
  if (value !== null && EXECUTION_STATES.has(value)) {
    return value as 'unknown' | 'starting' | 'idle' | 'busy';
  }
  return 'unknown';
}

function makeDirectoryCursor(offset: number): DirectoryCursor {
  return `${DIRECTORY_CURSOR_PREFIX}${offset}`;
}

function parseDirectoryCursor(value: string): number {
  if (!value.startsWith(DIRECTORY_CURSOR_PREFIX)) {
    throw coreError('CURSOR_EXPIRED', 'not a directory cursor issued by this process', {
      details: { cursor: value }
    });
  }
  const raw = value.slice(DIRECTORY_CURSOR_PREFIX.length);
  if (!/^(0|[1-9][0-9]*)$/.test(raw)) {
    throw coreError('CURSOR_EXPIRED', 'malformed directory cursor', { details: { cursor: value } });
  }
  return Number(raw);
}

function makeOutputCursor(offset: number): string {
  return `${OUTPUT_CURSOR_PREFIX}${offset}`;
}

function parseOutputCursor(value: string): number {
  if (!value.startsWith(OUTPUT_CURSOR_PREFIX)) {
    throw coreError('CURSOR_EXPIRED', 'not an output cursor issued by this process', {
      details: { cursor: value }
    });
  }
  const raw = value.slice(OUTPUT_CURSOR_PREFIX.length);
  if (!/^(0|[1-9][0-9]*)$/.test(raw)) {
    throw coreError('CURSOR_EXPIRED', 'malformed output cursor', { details: { cursor: value } });
  }
  return Number(raw);
}

/**
 * One chunk of a snapshot.
 *
 * Base64 chunks are aligned to three raw bytes and text chunks to a UTF-8
 * boundary, so concatenating the parts of a paged read reproduces the payload
 * exactly (SPEC.md §9).
 */
function sliceSnapshot(snapshot: OutputSnapshot, offset: number, maxBytes: number): Buffer {
  const budget = Math.max(1, maxBytes);
  if (
    snapshot.encoding === 'text' &&
    offset < snapshot.byteSize &&
    (snapshot.bytes[offset]! & 0xc0) === 0x80
  ) {
    throw coreError('CURSOR_EXPIRED', 'the output cursor is not on a UTF-8 boundary', {
      details: { output_id: snapshot.outputId, byte_offset: offset }
    });
  }
  let end = Math.min(snapshot.byteSize, offset + budget);
  if (end >= snapshot.byteSize) return snapshot.bytes.subarray(offset, snapshot.byteSize);
  if (snapshot.encoding === 'base64') {
    end = offset + Math.max(3, Math.floor((end - offset) / 3) * 3);
    return snapshot.bytes.subarray(offset, Math.min(end, snapshot.byteSize));
  }
  // Walk back off a UTF-8 continuation byte so no code point is split.
  while (end > offset && (snapshot.bytes[end]! & 0xc0) === 0x80) end -= 1;
  if (end === offset) {
    let requiredEnd = offset + 1;
    while (
      requiredEnd < snapshot.byteSize &&
      (snapshot.bytes[requiredEnd]! & 0xc0) === 0x80
    ) {
      requiredEnd += 1;
    }
    throw coreError('RESOURCE_LIMIT', 'the next UTF-8 code point exceeds the output byte budget', {
      details: {
        output_id: snapshot.outputId,
        byte_offset: offset,
        required_bytes: requiredEnd - offset,
        max_bytes: budget
      }
    });
  }
  return snapshot.bytes.subarray(offset, end);
}

/**
 * Build the service (SPEC.md §4).
 *
 * The returned object is the whole public surface of the registry layer: the
 * MCP adapter is expected to hold exactly one of these and to call nothing
 * else.
 */
export function createCollabService(
  config: ServiceConfigInput,
  options: CollabServiceOptions = {}
): CollabService {
  return new CollabServiceImpl(config, options);
}
