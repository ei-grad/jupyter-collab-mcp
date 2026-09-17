/**
 * `NotebookConnection` of SPEC.md §4: one open replica of one notebook inside
 * one working session.
 *
 * It is the place where the three modules meet, and it owns exactly the seam:
 *
 * ```
 * ServerClient.collaborationSession  ->  fileId + SERVER_SESSION
 *          |
 *          v
 *   YNotebook (Y.Doc + awareness)  <->  RtcConnection (room WebSocket)
 *          |
 *          v
 *      NotebookModel (index, revisions, journal, generations)
 * ```
 *
 * Readiness is `synced && nbformat !== undefined` (spike/NOTES.md §4): the
 * room being `ready` is not enough, because a fresh notebook arrives with one
 * server-created empty cell while `nbformat` is still undefined. Reads before
 * readiness are served and marked `stale`; writes get `NOT_READY` while the
 * connection is recoverable and the stored terminal RTC error once it failed
 * (SPEC.md §6).
 *
 * Two working sessions on the same notebook deliberately get two handles, two
 * `Y.Doc`s and two sockets; each counts against the replica budget
 * (SPEC.md §4).
 *
 * @module
 */

import { YNotebook } from '@jupyter/ydoc';

import {
  coreError,
  type ConnectionState,
  type CoreError,
  type DeliveryState,
  type HandleLifetime,
  type NotebookHandleInfo
} from '../core/index.js';
import { NotebookModel } from '../core/notebook/index.js';
import { RtcConnection } from '../jupyter/rtc-connection.js';
import { roomName } from '../jupyter/paths.js';

/** Handles of sessions and notebooks live until an explicit close (SPEC.md §4). */
export const HANDLE_LIFETIME: HandleLifetime = Object.freeze({
  scope: 'until_close_or_process_exit',
  releasedBy: Object.freeze(['notebook_close', 'session_close', 'process_exit']) as readonly [
    'notebook_close',
    'session_close',
    'process_exit'
  ],
  processScoped: true
});

/** Session handles are released by `session_close` alone. */
export const SESSION_LIFETIME: HandleLifetime = Object.freeze({
  scope: 'until_close_or_process_exit',
  releasedBy: Object.freeze(['session_close', 'process_exit']) as readonly [
    'session_close',
    'process_exit'
  ],
  processScoped: true
});

/** Everything {@link NotebookHandle.open} needs; no registry types here. */
export interface NotebookHandleInit {
  readonly notebookId: string;
  readonly sessionId: string;
  readonly path: string;
  readonly fileId: string;
  /** Server-wide `SERVER_SESSION` of the collaboration handshake. */
  readonly collaborationSessionId: string;
  readonly wsBaseUrl: string;
  readonly token: string;
  readonly authHeaders?: Readonly<Record<string, string>>;
  readonly awarenessUser: { readonly name: string; readonly color: string };
  readonly journalLimit: number;
  readonly previewChars?: number;
  /** SPEC.md §6: the identity re-check the transport runs before a reconnect. */
  readonly revalidateFileId: () => Promise<string>;
  /** Budget for `connecting -> ready -> nbformat`. Default 30 s. */
  readonly openTimeoutMs?: number;
}

/** `WS_OPEN`, spelled out: the DOM and `ws` typings do not line up. */
const WS_OPEN = 1;

/** One live replica (SPEC.md §4 `NotebookConnection`). */
export class NotebookHandle {
  readonly notebookId: string;
  readonly sessionId: string;
  readonly fileId: string;
  readonly documentId: string;
  readonly notebook: YNotebook;
  readonly connection: RtcConnection;
  readonly model: NotebookModel;
  /** Contents path; it is the path the room was opened for. */
  readonly path: string;
  /** Jobs of this notebook, by `execution_id`; the session owns their records. */
  readonly executionIds = new Set<string>();

  #closed = false;
  #offState: (() => void) | null = null;

  private constructor(init: NotebookHandleInit, notebook: YNotebook, connection: RtcConnection, model: NotebookModel) {
    this.notebookId = init.notebookId;
    this.sessionId = init.sessionId;
    this.path = init.path;
    this.fileId = init.fileId;
    this.documentId = roomName(init.fileId);
    this.notebook = notebook;
    this.connection = connection;
    this.model = model;
  }

  /**
   * Open the room, build the model and wait for readiness.
   *
   * Everything created here is released again if any step fails, so a failed
   * open leaves neither a socket nor an awareness interval behind
   * (spike/NOTES.md §3.3).
   *
   * @throws CoreError the terminal RTC codes, `NOT_READY` on timeout,
   * `NOTEBOOK_NOT_FOUND` when the room answers 4404.
   */
  static async open(init: NotebookHandleInit): Promise<NotebookHandle> {
    const notebook = new YNotebook();
    const connection = new RtcConnection({
      wsBaseUrl: init.wsBaseUrl,
      token: init.token,
      ...(init.authHeaders === undefined ? {} : { authHeaders: init.authHeaders }),
      fileId: init.fileId,
      sessionId: init.collaborationSessionId,
      ydoc: notebook.ydoc,
      awareness: notebook.awareness,
      awarenessUser: init.awarenessUser,
      revalidateFileId: init.revalidateFileId
    });
    const model = new NotebookModel(notebook, {
      origin: { notebookId: init.notebookId },
      journalLimit: init.journalLimit,
      ...(init.previewChars === undefined ? {} : { previewChars: init.previewChars })
    });
    const handle = new NotebookHandle(init, notebook, connection, model);

    // Subscribed before `connect`, so the journal records the whole lifecycle
    // of this replica (SPEC.md §10).
    handle.#offState = connection.on('state', (state) => {
      if (handle.#closed) return;
      try {
        model.recordConnectionState(state);
      } catch {
        // The model was released concurrently; the journal is gone with it.
      }
    });

    const timeoutMs = init.openTimeoutMs ?? 30_000;
    const deadline = Date.now() + timeoutMs;
    try {
      await connection.connect(timeoutMs);
      await waitForNbformat(model, connection, deadline);
    } catch (error) {
      handle.dispose();
      throw error;
    }
    return handle;
  }

  /** `true` once {@link dispose} ran. */
  get closed(): boolean {
    return this.#closed;
  }

  /** RTC state of the replica (SPEC.md §6). */
  get connectionState(): ConnectionState {
    return this.#closed ? 'closed' : this.connection.state;
  }

  /** SPEC.md §6: not (or no longer) ready, so a read is served but marked. */
  get stale(): boolean {
    return this.connectionState !== 'ready' || !this.model.isReady();
  }

  /** Identity block every notebook answer carries. */
  info(): NotebookHandleInfo {
    return {
      notebookId: this.notebookId,
      sessionId: this.sessionId,
      path: this.path,
      fileId: this.fileId,
      documentId: this.documentId,
      connectionState: this.connectionState,
      stale: this.stale,
      lifetime: HANDLE_LIFETIME
    };
  }

  /**
   * @throws CoreError `HANDLE_EXPIRED` when the replica was released.
   */
  assertOpen(): void {
    if (this.#closed) {
      throw coreError('HANDLE_EXPIRED', `notebook handle ${this.notebookId} was closed`, {
        details: { notebook_id: this.notebookId }
      });
    }
  }

  /**
   * The check every write and every execution runs first (SPEC.md §6).
   *
   * @throws CoreError `HANDLE_EXPIRED`, the stored terminal RTC error
   * (`RTC_SESSION_REJECTED`, `RTC_CONFLICT`, `FILE_ID_CHANGED`,
   * `RTC_BAD_REQUEST`, `RTC_INITIALIZATION_FAILED`) or `NOT_READY` while the
   * connection is still recoverable.
   */
  assertWritable(): void {
    this.assertOpen();
    const terminal: CoreError | null = this.connection.terminalError;
    if (terminal !== null) throw terminal;
    if (this.connectionState !== 'ready' || !this.model.isReady()) {
      throw coreError('NOT_READY', 'the notebook replica is not synchronised right now', {
        details: {
          notebook_id: this.notebookId,
          connection_state: this.connectionState,
          nbformat_known: this.model.isReady()
        }
      });
    }
  }

  /**
   * How far a local change is known to have travelled (SPEC.md §6 "Delivery
   * and persistence").
   *
   * `sent` means the update left this process on an open socket with an empty
   * send buffer. It is deliberately not a claim that the server applied it -
   * that is what `persistence` and `notebook_save` are for.
   */
  delivery(): DeliveryState {
    if (this.#closed || this.connectionState !== 'ready') return 'unknown';
    const socket = this.connection.provider.ws;
    if (socket === null || socket.readyState !== WS_OPEN) return 'unknown';
    return socket.bufferedAmount === 0 ? 'sent' : 'pending';
  }

  /** Journal an observed kernel binding change (SPEC.md §10). */
  recordKernelChange(kernelId: string | null): void {
    if (this.#closed) return;
    try {
      this.model.recordKernelChange(kernelId);
    } catch {
      // Released concurrently; nothing reads that journal any more.
    }
  }

  /**
   * Release the replica: observers, socket, awareness and journal timers. The
   * kernel is never touched (SPEC.md §4).
   */
  dispose(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#offState?.();
    this.#offState = null;
    this.model.dispose();
    this.connection.dispose();
    this.notebook.dispose();
  }
}

/**
 * Wait until the shared structure carries `nbformat` (SPEC.md §6 item 5).
 *
 * `RtcConnection.connect` only proves the room synced; `nbformat` arrives with
 * the document state and is the readiness signal the spike established.
 */
async function waitForNbformat(
  model: NotebookModel,
  connection: RtcConnection,
  deadline: number
): Promise<void> {
  for (;;) {
    if (model.isReady()) return;
    const terminal = connection.terminalError;
    if (terminal !== null) throw terminal;
    if (Date.now() >= deadline) {
      throw coreError('NOT_READY', 'the notebook structure did not arrive within the open budget', {
        details: { room: connection.roomName, state: connection.state }
      });
    }
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 25);
      timer.unref?.();
    });
  }
}
