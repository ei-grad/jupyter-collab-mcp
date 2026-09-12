/**
 * One RTC room connection: y-websocket plus the jupyter-collaboration
 * handshake (SPEC.md §5, §6).
 *
 * Deliberately independent of `@jupyter/ydoc`: it takes a bare `Y.Doc`, so the
 * state machine can be tested against a fake room server and the notebook
 * layer stays free to wrap the same doc in a `YNotebook`.
 *
 * What it owns:
 *   - the room URL (`<ws base>/api/collaboration/room/json:notebook:<fileId>`
 *     with the room name left **unencoded**) and the `sessionId` query. The
 *     token travels in the handshake header by default, so it appears neither
 *     in `provider.url` nor in `provider.params` (SPEC.md §11, `ws-auth.ts`);
 *   - `provider.messageHandlers[2]`, replaced with a RAW dispatcher because
 *     Jupyter's `MessageType.RAW` collides with y-websocket's `messageAuth`
 *     (spike/NOTES.md §3.1). The array is per provider, so exactly one handler
 *     exists no matter how many sockets the provider goes through;
 *   - the SPEC.md §6 transition table for close codes, including switching
 *     y-websocket's auto-reconnect off before it can retry with a stale
 *     `sessionId`;
 *   - reconnect scheduling: y-websocket's own backoff is deterministic
 *     (`2^n * 100` capped by `maxBackoffTime`), and SPEC.md §6 requires jitter,
 *     so its timer is neutralised and this class schedules the retry itself.
 *     That is also where the optional `fileId` re-check lives;
 *   - the awareness state `{user: {name, color}, autosave: true}` that keeps
 *     server-side autosave enabled (SPEC.md §6 "Delivery and persistence").
 *
 * What it does *not* own: readiness of the notebook structure (`nbformat`
 * defined - SPEC.md §6 item 5), the change journal, and obtaining a fresh
 * document session (the notebook layer supplies {@link
 * RtcConnectionOptions.revalidateFileId} for that).
 *
 * @module
 */

import type * as decoding from 'lib0/decoding';
import type { Awareness } from 'y-protocols/awareness';
import { WebsocketProvider } from 'y-websocket';
import WebSocketImpl from 'ws';
import type * as Y from 'yjs';

import {
  coreError,
  redactCredentials,
  toCoreError,
  type ConnectionState,
  type CoreError,
  type SaveStatus
} from '../core/index.js';
import { classifyClose, type SessionRejection } from './close-codes.js';
import { Emitter } from './emitter.js';
import { ROOM_FORMAT, ROOM_TYPE, joinUrl, normalizeBaseUrl, roomName } from './paths.js';
import { MESSAGE_RAW, encodeRawSaveRequest, readRawMessage } from './raw-protocol.js';
import { SaveRequests } from './save-requests.js';
import { authenticatedWebSocket } from './ws-auth.js';

/** `WebSocket.OPEN`, spelled out to avoid the DOM/ws typing mismatch. */
const WS_OPEN = 1;

/**
 * Delay before reconnect attempt `attempt` (1-based), in ms.
 *
 * Exponential backoff `2^attempt * 100` capped by `ceilingMs`, then jittered
 * over the top half of that window: SPEC.md §6 requires "bounded exponential
 * backoff with jitter", and y-websocket's own delay is the same
 * formula *without* jitter, so replicas that lose one server retry in lockstep.
 * Half the window is kept deterministic so a small ceiling still backs off.
 *
 * Exported for its own unit test; `random` is the seam that makes it testable.
 */
export function reconnectDelayMs(
  attempt: number,
  ceilingMs: number,
  random: () => number = Math.random
): number {
  const ceiling = Math.min(2 ** Math.max(attempt, 1) * 100, ceilingMs);
  return ceiling / 2 + random() * (ceiling / 2);
}

/** Presence published in Yjs awareness (SPEC.md §10). */
export interface AwarenessUser {
  readonly name: string;
  readonly color: string;
}

/**
 * How the Jupyter token reaches the room socket.
 *
 * `header` (default) sends `Authorization: token <t>` on the handshake and
 * keeps the credential out of every URL. `query` reproduces the browser
 * docprovider's `?token=` for a deployment whose proxy drops the header - at
 * the cost of the credential being visible in `provider.url`/`provider.params`.
 */
export type TokenTransport = 'header' | 'query';

/** Events emitted by {@link RtcConnection}. */
export interface RtcConnectionEvents extends Record<string, (...args: never[]) => void> {
  /** Every state change, with the terminal error when the state is `failed`. */
  state: (state: ConnectionState, error: CoreError | null) => void;
  /** RAW `{"type":"conflict"}` arrived; sending stops immediately. */
  conflict: (payload: unknown) => void;
  /** Sync flag; `false` on every socket loss, before the state event. */
  synced: (synced: boolean) => void;
}

/** Constructor options of {@link RtcConnection} (SPEC.md §6). */
export interface RtcConnectionOptions {
  /** WS base with any prefix, e.g. `ws://127.0.0.1:8888` or `.../user/n`. */
  readonly wsBaseUrl: string;
  readonly token: string;
  readonly fileId: string;
  /** Server-wide `SERVER_SESSION` from the document session handshake. */
  readonly sessionId: string;
  readonly ydoc: Y.Doc;
  readonly awarenessUser: AwarenessUser;
  /** Defaults to `json` / `notebook`. */
  readonly format?: string;
  readonly type?: string;
  /** Room route below the base. Default `/api/collaboration/room`. */
  readonly roomRoute?: string;
  /** Default timeout of {@link RtcConnection.save}. Default 20000 ms. */
  readonly saveTimeoutMs?: number;
  /** How many 4500 closes are retried before `RTC_INITIALIZATION_FAILED`. */
  readonly initRetryBudget?: number;
  /** Backoff ceiling for the jittered reconnect delay. Default 2500 ms. */
  readonly maxBackoffTime?: number;
  /** Awareness to reuse (e.g. a `YNotebook`'s). One is created otherwise. */
  readonly awareness?: Awareness;
  /** WebSocket implementation; defaults to the `ws` package. */
  readonly webSocketPolyfill?: typeof globalThis.WebSocket;
  /** Where the token goes. Default `header` (SPEC.md §11). */
  readonly tokenTransport?: TokenTransport;
  /**
   * Re-check file identity before each reconnect (SPEC.md §6 signal table:
   * "preserve the replica, verify the same fileId, and wait for a new sync").
   *
   * Supplied by the notebook layer, which owns the document session: normally
   * `() => serverClient.collaborationSession(path).then(s => s.fileId)`. A
   * different id fails the handle with `FILE_ID_CHANGED`; a rejection is
   * treated as one more unsuccessful attempt and the backoff continues.
   */
  readonly revalidateFileId?: () => Promise<string>;
}

/**
 * A live connection to one collaboration room (SPEC.md §6).
 *
 * States follow SPEC.md §6: `connecting → syncing → ready`, `reconnecting` on
 * transport loss, `conflict` for the RAW conflict signal on its way to
 * `failed`, `failed` with a stored terminal error, `closed` after
 * {@link dispose}.
 */
export class RtcConnection {
  readonly #events = new Emitter<RtcConnectionEvents>();
  readonly #provider: WebsocketProvider;
  readonly #ownsAwareness: boolean;
  readonly #saveTimeoutMs: number;
  readonly #initRetryBudget: number;
  readonly #saves = new SaveRequests();
  readonly #roomName: string;
  readonly #fileId: string;
  readonly #maxBackoffMs: number;
  readonly #revalidateFileId: (() => Promise<string>) | null;

  #state: ConnectionState = 'connecting';
  #terminal: CoreError | null = null;
  #lastError: CoreError | null = null;
  #disposed = false;
  #initRetries = 0;
  #rawHandlerInstalls = 0;
  #socketGeneration = 0;
  #synced = false;
  #reconnectAttempts = 0;
  #reconnectTimer: NodeJS.Timeout | null = null;

  constructor(options: RtcConnectionOptions) {
    const format = options.format ?? ROOM_FORMAT;
    const type = options.type ?? ROOM_TYPE;
    this.#roomName = roomName(options.fileId, format, type);
    this.#fileId = options.fileId;
    this.#saveTimeoutMs = options.saveTimeoutMs ?? 20_000;
    this.#initRetryBudget = options.initRetryBudget ?? 3;
    this.#ownsAwareness = options.awareness === undefined;
    this.#maxBackoffMs = options.maxBackoffTime ?? 2500;
    this.#revalidateFileId = options.revalidateFileId ?? null;

    const serverUrl = normalizeBaseUrl(
      joinUrl(options.wsBaseUrl, options.roomRoute ?? '/api/collaboration/room')
    );

    // SPEC.md §11: by default the credential is not part of the URL at all, so
    // `provider.url` and `provider.params` are safe to print.
    const transport: TokenTransport = options.tokenTransport ?? 'header';
    const params: Record<string, string> =
      transport === 'query'
        ? { sessionId: options.sessionId, token: options.token }
        : { sessionId: options.sessionId };
    const baseSocket =
      options.webSocketPolyfill ?? (WebSocketImpl as unknown as typeof globalThis.WebSocket);
    const socketCtor =
      transport === 'header' ? authenticatedWebSocket(options.token, baseSocket) : baseSocket;

    this.#provider = new WebsocketProvider(serverUrl, this.#roomName, options.ydoc, {
      connect: false,
      // Node 22+ has a global BroadcastChannel; without this, two connections
      // in one process would sync directly and bypass the server entirely
      // (spike/NOTES.md §3.14, SPEC.md §6 item 6).
      disableBc: true,
      WebSocketPolyfill: socketCtor,
      params,
      maxBackoffTime: this.#maxBackoffMs,
      ...(options.awareness === undefined ? {} : { awareness: options.awareness })
    });

    this.#installRawHandler();

    // SPEC.md §6: publishing `autosave: true` keeps the server's debounced save
    // enabled even when a browser in the same room published `false`.
    this.#provider.awareness.setLocalState({
      user: { name: options.awarenessUser.name, color: options.awarenessUser.color },
      autosave: true
    });

    this.#provider.on('status', this.#onStatus);
    this.#provider.on('sync', this.#onSync);
    this.#provider.on('connection-close', this.#onConnectionClose);
  }

  /** Room name `json:notebook:<fileId>`; also `state.document_id` (SPEC.md §6). */
  get roomName(): string {
    return this.#roomName;
  }

  /** `fileId` this room was opened for (SPEC.md §6 item 4). */
  get fileId(): string {
    return this.#fileId;
  }

  /** Current state (SPEC.md §6). */
  get state(): ConnectionState {
    return this.#state;
  }

  /** Last error observed, terminal or not. */
  get lastError(): CoreError | null {
    return this.#lastError;
  }

  /**
   * Stored terminal RTC error; every write must fail with it (SPEC.md §6).
   * `null` while the connection is recoverable.
   */
  get terminalError(): CoreError | null {
    return this.#terminal;
  }

  /**
   * Whether the replica is in sync with the room right now.
   *
   * Not a straight delegation to `provider.synced`: y-websocket emits
   * `connection-close` *before* it clears that flag, so a consumer that
   * recomputes readiness inside the `state` callback - the natural place, and
   * what SPEC.md §6 item 5 asks for - would read a stale `true`. This flag is
   * cleared first, so `synced` is already `false` when `state` reports
   * `reconnecting` or `failed` (SPEC.md §6: reconnecting "does not leave the
   * previous `synced` flag true").
   */
  get synced(): boolean {
    return this.#synced && this.#provider.synced;
  }

  /** Room URL with the token redacted (SPEC.md §11). Never log `provider.url`. */
  get url(): string {
    return redactCredentials(this.#provider.url);
  }

  /**
   * How many times the RAW handler was installed. Stays `1` for the lifetime of
   * the connection: `messageHandlers` belongs to the provider, not the socket
   * (SPEC.md §12 "RAW and eviction").
   */
  get rawHandlerInstalls(): number {
    return this.#rawHandlerInstalls;
  }

  /** Number of sockets that reached `connected`; 1 + reconnect count. */
  get socketGeneration(): number {
    return this.#socketGeneration;
  }

  /**
   * The underlying provider. Exposed for diagnostics and tests (forcing a
   * socket close); the state machine owns it, so do not reconfigure it. With
   * the default `header` token transport it holds no credential.
   */
  get provider(): WebsocketProvider {
    return this.#provider;
  }

  /** Subscribe to {@link RtcConnectionEvents}; returns an unsubscribe. */
  on<K extends keyof RtcConnectionEvents>(event: K, listener: RtcConnectionEvents[K]): () => void {
    return this.#events.on(event, listener);
  }

  /** Unsubscribe a listener registered with {@link on}. */
  off<K extends keyof RtcConnectionEvents>(event: K, listener: RtcConnectionEvents[K]): void {
    this.#events.off(event, listener);
  }

  /**
   * Open the socket and wait for the first sync (SPEC.md §6 item 5).
   *
   * @throws {@link CoreError} the terminal RTC code on a rejected room, or
   * `NOT_READY` when `timeoutMs` elapses first.
   */
  async connect(timeoutMs = 30_000): Promise<void> {
    if (this.#disposed) {
      throw coreError('HANDLE_EXPIRED', 'this RTC connection was disposed');
    }
    if (this.#terminal !== null) throw this.#terminal;
    if (this.#state === 'ready') return;
    this.#provider.connect();
    await this.waitForReady(timeoutMs);
  }

  /** Wait until the state is `ready`, or fail like {@link connect}. */
  waitForReady(timeoutMs = 30_000): Promise<void> {
    if (this.#state === 'ready') return Promise.resolve();
    if (this.#terminal !== null) return Promise.reject(this.#terminal);
    if (this.#disposed) {
      return Promise.reject(coreError('HANDLE_EXPIRED', 'this RTC connection was disposed'));
    }
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        unsubscribe();
        reject(
          coreError('NOT_READY', `RTC room did not become ready within ${timeoutMs}ms`, {
            details: { room: this.#roomName, state: this.#state }
          })
        );
      }, timeoutMs);
      timer.unref?.();
      const unsubscribe = this.#events.on('state', (state, error) => {
        if (state === 'ready') {
          clearTimeout(timer);
          unsubscribe();
          resolve();
          return;
        }
        if (state === 'failed' || state === 'closed') {
          clearTimeout(timer);
          unsubscribe();
          reject(
            error ??
              this.#terminal ??
              coreError('HANDLE_EXPIRED', 'this RTC connection was closed while waiting for sync')
          );
        }
      });
    });
  }

  /**
   * Send the RAW `save` request and wait for the matching reply (SPEC.md §6
   * "Delivery and persistence").
   *
   * The returned status is reported as-is: `skipped` is **not** a success (the
   * server only skips while its `_update_lock` is held) and `timeout` is not a
   * failure - the write may still have happened (spike/NOTES.md §3.11). A save
   * whose socket dies without a terminal signal also resolves `'timeout'`, and
   * does so at once: the reply can only ever arrive on the socket that carried
   * the request, so waiting out the budget would add delay and no information.
   *
   * @throws {@link CoreError} `NOT_READY` when the room is not ready, the
   * stored terminal error once the handle failed, or `OPERATION_UNCERTAIN` when
   * the room fails between send and reply.
   */
  save(timeoutMs = this.#saveTimeoutMs): Promise<SaveStatus> {
    if (this.#terminal !== null) return Promise.reject(this.#terminal);
    if (this.#disposed) {
      return Promise.reject(coreError('HANDLE_EXPIRED', 'this RTC connection was disposed'));
    }
    const socket = this.#provider.ws;
    if (this.#state !== 'ready' || socket === null || socket.readyState !== WS_OPEN) {
      return Promise.reject(
        coreError('NOT_READY', 'RTC room is not ready; save was not sent', {
          details: { room: this.#roomName, state: this.#state }
        })
      );
    }

    const { id, result } = this.#saves.create(timeoutMs);
    try {
      socket.send(encodeRawSaveRequest(id));
    } catch (error) {
      this.#saves.cancel(id);
      return Promise.reject(
        coreError('OPERATION_UNCERTAIN', 'save request could not be sent', { cause: error })
      );
    }
    return result;
  }

  /**
   * Release the connection (SPEC.md §4 `notebook_close`).
   *
   * Destroys the provider (which clears its watchdog interval and its `exit`
   * handler), destroys the awareness it created - `y-protocols` keeps a ~3 s
   * interval that otherwise holds the event loop open (spike/NOTES.md §3.3) -
   * clears the reconnect timer and drops every listener. The `Y.Doc` belongs to
   * the caller.
   */
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#clearReconnectTimer();
    this.#synced = false;
    this.#provider.off('status', this.#onStatus);
    this.#provider.off('sync', this.#onSync);
    this.#provider.off('connection-close', this.#onConnectionClose);
    this.#saves.rejectAll(
      coreError('HANDLE_EXPIRED', 'RTC connection closed before the save reply arrived')
    );
    this.#provider.shouldConnect = false;
    try {
      this.#provider.destroy();
    } catch {
      // destroy() closes an already closed socket in some paths; not fatal.
    }
    if (this.#ownsAwareness) this.#provider.awareness.destroy();
    this.#setState('closed', null);
    this.#events.removeAll();
  }

  // -- internals ------------------------------------------------------------

  #installRawHandler(): void {
    this.#rawHandlerInstalls += 1;
    // One handler per provider, not per socket: it survives every reconnect,
    // which is exactly what SPEC.md §5 asks for.
    this.#provider.messageHandlers[MESSAGE_RAW] = (
      _encoder: unknown,
      decoder: decoding.Decoder
    ): void => {
      this.#onRawMessage(decoder);
    };
  }

  #onRawMessage(decoder: decoding.Decoder): void {
    const message = readRawMessage(decoder);
    switch (message.kind) {
      case 'save-reply':
        // `false` means the request already timed out; the late reply is dropped.
        this.#saves.settle(message.responseTo, message.status);
        return;
      case 'conflict': {
        this.#events.emit('conflict', message.payload);
        // SPEC.md §6 lists `conflict` among the connection states and its
        // signal table reads "A conflict event, then failed": the state is
        // passed through so a consumer switching on ConnectionState can tell a
        // rejected update from any other terminal failure.
        this.#setState('conflict', null);
        this.#fail(
          coreError(
            'RTC_CONFLICT',
            'the server rejected an update for this room (RAW conflict); ' +
              'this replica must not send anything else',
            { details: { room: this.#roomName } }
          ),
          /* closeNow */ true
        );
        return;
      }
      default:
        // Unknown RAW payloads are ignored on purpose: an unrecognised
        // message must not break the sync stream (SPEC.md §8).
        return;
    }
  }

  readonly #onStatus = (event: { status: 'connected' | 'disconnected' | 'connecting' }): void => {
    if (this.#disposed || this.#terminal !== null) return;
    if (event.status === 'connecting') {
      if (this.#state !== 'reconnecting') this.#setState('connecting', null);
      return;
    }
    if (event.status === 'connected') {
      this.#socketGeneration += 1;
      this.#setState('syncing', null);
    }
  };

  readonly #onSync = (synced: boolean): void => {
    this.#synced = synced;
    this.#events.emit('synced', synced);
    if (this.#disposed || this.#terminal !== null) return;
    if (synced) {
      // A completed sync means the room accepted this session: both the 4500
      // budget and the reconnect backoff start over (SPEC.md §6).
      this.#initRetries = 0;
      this.#reconnectAttempts = 0;
      this.#setState('ready', null);
    }
  };

  readonly #onConnectionClose = (event: CloseEvent | null): void => {
    if (this.#disposed || this.#terminal !== null) return;
    // y-websocket clears `provider.synced` only after this event; readiness
    // must already be false for every listener of the state change below.
    this.#synced = false;

    if (event === null) {
      // Local close: `disconnect()` or y-websocket's "no message" watchdog.
      // Not a server signal, so the replica is kept and we reconnect.
      this.#enterReconnecting();
      return;
    }
    const disposition = classifyClose(event.code, event.reason ?? '');
    if (disposition.kind === 'terminal') {
      const details: Record<string, unknown> = { room: this.#roomName, closeCode: event.code };
      const rejection: SessionRejection | undefined = disposition.rejection;
      if (rejection !== undefined) {
        details['reason'] = rejection.reason;
        details['reloadable'] = rejection.reloadable ?? null;
      }
      this.#fail(coreError(disposition.errorCode, disposition.message, { details }));
      return;
    }
    if (disposition.kind === 'init-retry') {
      this.#initRetries += 1;
      if (this.#initRetries > this.#initRetryBudget) {
        this.#fail(
          coreError(
            'RTC_INITIALIZATION_FAILED',
            `room kept closing with 4500; the retry budget of ${this.#initRetryBudget} is spent`,
            { details: { room: this.#roomName, attempts: this.#initRetries } }
          )
        );
        return;
      }
      this.#lastError = coreError('NOT_READY', disposition.message);
      this.#enterReconnecting();
      return;
    }
    this.#enterReconnecting();
  };

  /**
   * Common non-terminal close handling: settle what the dead socket can no
   * longer answer, announce `reconnecting`, and schedule our own retry.
   */
  #enterReconnecting(): void {
    // A save reply is bound to the socket that carried the request, so a lost
    // socket means "unknown", not "still waiting" (SPEC.md §6: "a timeout does
    // not mean the write failed").
    this.#saves.settleAll('timeout');
    this.#suspendProviderReconnect();
    this.#setState('reconnecting', null);
    this.#scheduleReconnect();
  }

  /**
   * Turn y-websocket's already-scheduled `setupWS` into a no-op.
   *
   * Its delay is `min(2^n * 100, maxBackoffTime)` with no jitter, so several
   * replicas that lose one server retry in lockstep. `shouldConnect = false`
   * disarms it (the timer checks the flag) and leaves reconnect timing to
   * {@link #scheduleReconnect}. Called from within `connection-close`, i.e.
   * before y-websocket schedules that timer.
   */
  #suspendProviderReconnect(): void {
    this.#provider.shouldConnect = false;
  }

  /** Exponential backoff with jitter over the top half of the window. */
  #scheduleReconnect(): void {
    if (this.#disposed || this.#terminal !== null) return;
    if (this.#reconnectTimer !== null) return;
    this.#reconnectAttempts += 1;
    const delay = reconnectDelayMs(this.#reconnectAttempts, this.#maxBackoffMs);
    const timer = setTimeout(() => {
      this.#reconnectTimer = null;
      void this.#reconnectNow();
    }, delay);
    timer.unref?.();
    this.#reconnectTimer = timer;
  }

  #clearReconnectTimer(): void {
    if (this.#reconnectTimer === null) return;
    clearTimeout(this.#reconnectTimer);
    this.#reconnectTimer = null;
  }

  /**
   * One reconnect attempt: re-check file identity when the notebook layer
   * supplied a hook, then reopen the socket (SPEC.md §6 signal table row 1).
   */
  async #reconnectNow(): Promise<void> {
    if (this.#disposed || this.#terminal !== null) return;
    const revalidate = this.#revalidateFileId;
    if (revalidate !== null) {
      let fileId: string;
      try {
        fileId = await revalidate();
      } catch (error) {
        // The server is not answering yet; that is one more failed attempt,
        // not proof that the document changed.
        this.#lastError = toCoreError(error);
        if (this.#disposed || this.#terminal !== null) return;
        this.#scheduleReconnect();
        return;
      }
      if (this.#disposed || this.#terminal !== null) return;
      if (fileId !== this.#fileId) {
        this.#fail(
          coreError(
            'FILE_ID_CHANGED',
            'the document behind this path has a different fileId; this handle is stale',
            { details: { room: this.#roomName, expected: this.#fileId, actual: fileId } }
          )
        );
        return;
      }
    }
    if (this.#disposed || this.#terminal !== null) return;
    this.#provider.connect();
  }

  /**
   * Enter the terminal state: stop reconnecting with a stale `sessionId` and
   * fail every pending save (SPEC.md §6).
   */
  #fail(error: CoreError, closeNow = false): void {
    if (this.#terminal !== null) return;
    this.#terminal = error;
    this.#lastError = error;
    this.#synced = false;
    this.#clearReconnectTimer();
    // `shouldConnect = false` turns the reconnect timer y-websocket already
    // scheduled into a no-op without destroying the provider, so diagnostics
    // stay available until `dispose()` (SPEC.md §4).
    this.#provider.shouldConnect = false;
    if (closeNow && this.#provider.ws !== null) {
      // A conflict must stop outgoing updates immediately, not on a timer.
      try {
        this.#provider.disconnect();
      } catch {
        // already closing
      }
    }
    this.#saves.rejectAll(
      coreError('OPERATION_UNCERTAIN', 'RTC room failed before the save reply arrived', {
        details: { room: this.#roomName, cause_code: error.code }
      })
    );
    this.#setState('failed', error);
  }

  #setState(next: ConnectionState, error: CoreError | null): void {
    if (this.#state === next) return;
    this.#state = next;
    if (error !== null) this.#lastError = error;
    this.#events.emit('state', next, error);
  }
}
