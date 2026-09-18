/**
 * `SessionRegistry` and one working session (SPEC.md §4, §9).
 *
 * A working session picks one server, may open several notebooks, and owns
 * everything scoped to a conversation: the notebook handles and their
 * replicas, the jobs, the output snapshots, the kernel bindings it observed,
 * the `request_id` ledger and the lock that serialises its four mutating
 * tools. Two sessions never share any of that, even on the same document
 * (SPEC.md §4: "Replicas and cursors are independent across working sessions").
 *
 * Closing is idempotent by handle, so a bounded tombstone of recently closed
 * ids is kept: a second `session_close` / `notebook_close` answers
 * `alreadyClosed: true` instead of `HANDLE_EXPIRED` (SPEC.md §9).
 *
 * @module
 */

import { randomUUID } from 'node:crypto';

import {
  coreError,
  type ExecutionId,
  type NotebookId,
  type SessionEnvelope,
  type ServiceLimits
} from '../core/index.js';
import type { ExecutionRecord } from './execution.js';
import { isActive } from './execution.js';
import type { KernelLease } from './kernel-hub.js';
import { Mutex } from './mutex.js';
import type { NotebookHandle } from './notebook-handle.js';
import { OutputStore } from './outputs.js';
import { RequestLedger } from './ledger.js';
import type { ServerEntry } from './server-registry.js';

/** The kernel binding a notebook handle currently holds (SPEC.md §8). */
export interface KernelBinding {
  /** Jupyter Sessions API session id, not a working session. */
  readonly jupyterSessionId: string;
  readonly kernelId: string;
  readonly kernelName: string;
  readonly lease: KernelLease;
  /** Unsubscribes the kernel lifecycle listener. */
  readonly off: () => void;
}

/** Construction arguments of {@link WorkingSession}. */
export interface WorkingSessionInit {
  readonly id: string;
  readonly server: ServerEntry;
  readonly label?: string;
  readonly limits: ServiceLimits;
  readonly outputStoreMaxBytes: number;
  readonly now?: () => Date;
  /** Implicit server bindings share one connection-wide mutation sequence. */
  readonly mutationContext?: { readonly ledger: RequestLedger; readonly lock: Mutex };
}

/** One working session (SPEC.md §4). */
export class WorkingSession {
  readonly id: string;
  readonly server: ServerEntry;
  readonly label: string | undefined;
  readonly openedAt: string;
  readonly ledger: RequestLedger;
  readonly lock: Mutex;
  readonly outputs: OutputStore;
  readonly notebooks = new Map<NotebookId, NotebookHandle>();
  /** Concurrent opens of one document coalesce here (SPEC.md §4). */
  readonly opening = new Map<string, Promise<{ handle: NotebookHandle; reused: boolean }>>();
  readonly executions = new Map<ExecutionId, ExecutionRecord>();
  readonly bindings = new Map<NotebookId, KernelBinding>();
  /** Recently closed notebook handles, so a second close stays idempotent. */
  readonly closedNotebooks = new Set<NotebookId>();
  closed = false;

  constructor(init: WorkingSessionInit) {
    const now = init.now ?? ((): Date => new Date());
    this.id = init.id;
    this.server = init.server;
    this.label = init.label;
    this.openedAt = now().toISOString();
    this.lock = init.mutationContext?.lock ?? new Mutex();
    this.ledger = init.mutationContext?.ledger ?? new RequestLedger(
      {
        maxReceipts: init.limits.maxReceiptsPerSession,
        requestMaxBytes: init.limits.requestMaxBytes,
        receiptMaxBytes: init.limits.receiptMaxBytes
      },
      now
    );
    this.outputs = new OutputStore(init.id, init.outputStoreMaxBytes);
  }

  /**
   * The fields every session-scoped answer carries (SPEC.md §9).
   *
   * A closed session reports `nextRequestId: null`: it accepts nothing more.
   */
  envelope(extra: Omit<SessionEnvelope, 'nextRequestId'> = {}): SessionEnvelope {
    return {
      nextRequestId: this.closed ? null : this.ledger.nextRequestId,
      ...extra
    };
  }

  /**
   * @throws CoreError `HANDLE_EXPIRED` for an unknown or closed notebook.
   */
  requireNotebook(notebookId: NotebookId): NotebookHandle {
    const handle = this.notebooks.get(notebookId);
    if (handle === undefined || handle.closed) {
      throw coreError('HANDLE_EXPIRED', `unknown notebook handle ${notebookId}`, {
        details: { notebook_id: notebookId }
      });
    }
    return handle;
  }

  /** The live handle of a `fileId`, if this session already has one. */
  findByFileId(fileId: string): NotebookHandle | null {
    for (const handle of this.notebooks.values()) {
      if (!handle.closed && handle.fileId === fileId) return handle;
    }
    return null;
  }

  /** Jobs that may still change; optionally narrowed to one notebook. */
  activeExecutions(notebookId?: NotebookId): readonly ExecutionRecord[] {
    const active: ExecutionRecord[] = [];
    for (const record of this.executions.values()) {
      if (notebookId !== undefined && record.notebookId !== notebookId) continue;
      if (isActive(record)) active.push(record);
    }
    return active;
  }
}

/** The per-process registry of working sessions (SPEC.md §9: 64 by default). */
export class SessionRegistry {
  readonly #limits: ServiceLimits;
  readonly #outputStoreMaxBytes: number;
  readonly #sessions = new Map<string, WorkingSession>();
  readonly #tombstones = new Set<string>();
  readonly #now: () => Date;

  constructor(limits: ServiceLimits, outputStoreMaxBytes: number, now?: () => Date) {
    this.#limits = limits;
    this.#outputStoreMaxBytes = outputStoreMaxBytes;
    this.#now = now ?? ((): Date => new Date());
  }

  /** Live sessions. */
  get size(): number {
    return this.#sessions.size;
  }

  /** Every live session. */
  all(): readonly WorkingSession[] {
    return [...this.#sessions.values()];
  }

  /** Open replicas across every session; the SPEC.md §9 budget of 32. */
  openNotebookCount(): number {
    let total = 0;
    for (const session of this.#sessions.values()) {
      for (const handle of session.notebooks.values()) if (!handle.closed) total += 1;
    }
    return total;
  }

  /**
   * @throws CoreError `RESOURCE_LIMIT` - `maxSessions` reached; a live session
   * is never evicted to make room (SPEC.md §9).
   */
  open(server: ServerEntry, label?: string, mutationContext?: WorkingSessionInit['mutationContext']): WorkingSession {
    if (this.#sessions.size >= this.#limits.maxSessions) {
      throw coreError('RESOURCE_LIMIT', 'the working-session budget of this process is exhausted', {
        details: { sessions: this.#sessions.size, limit: this.#limits.maxSessions }
      });
    }
    const session = new WorkingSession({
      id: `sess_${randomUUID()}`,
      server,
      ...(label === undefined ? {} : { label }),
      limits: this.#limits,
      outputStoreMaxBytes: this.#outputStoreMaxBytes,
      now: this.#now,
      ...(mutationContext === undefined ? {} : { mutationContext })
    });
    this.#sessions.set(session.id, session);
    return session;
  }

  /**
   * @throws CoreError `HANDLE_EXPIRED` - unknown or already closed session.
   */
  require(sessionId: string): WorkingSession {
    const session = this.#sessions.get(sessionId);
    if (session === undefined || session.closed) {
      throw coreError('HANDLE_EXPIRED', `unknown working session ${sessionId}`, {
        details: { session_id: sessionId }
      });
    }
    return session;
  }

  /** Live session, or `undefined`. Used by the idempotent close path. */
  get(sessionId: string): WorkingSession | undefined {
    return this.#sessions.get(sessionId);
  }

  /** `true` when this process closed that session earlier. */
  wasClosed(sessionId: string): boolean {
    return this.#tombstones.has(sessionId);
  }

  /** Forget a closed session, keeping a bounded tombstone for idempotency. */
  forget(sessionId: string): void {
    this.#sessions.delete(sessionId);
    this.#tombstones.add(sessionId);
    if (this.#tombstones.size > this.#limits.maxSessions) {
      const oldest = this.#tombstones.values().next();
      if (!oldest.done) this.#tombstones.delete(oldest.value);
    }
  }
}
