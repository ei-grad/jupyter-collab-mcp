/**
 * An awareness-only collaboration room: JupyterLab's global presence room
 * `JupyterLab:globalAwareness` (SPEC.md §10 "Presence").
 *
 * jupyter-collaboration serves every room name without a `<format>:<type>:`
 * prefix as a transient room: no document session, no `sessionId` query, no
 * file, no RAW messages. Its browser client is a plain y-websocket provider at
 * `<ws base>/api/collaboration/room/JupyterLab:globalAwareness` over an empty
 * `Y.Doc`, publishing `{user, current}` in awareness. The collaborators panel
 * lists exactly the states of that room.
 *
 * This connection is best-effort: it never throws after construction, retries
 * every close with the jittered backoff of {@link reconnectDelayMs} and the
 * same handshake authentication as the document rooms, and on dispose
 * publishes a null local state before the socket closes, so the entry leaves
 * other clients at once instead of after the awareness timeout.
 *
 * @module
 */

import { Awareness } from 'y-protocols/awareness';
import { WebsocketProvider } from 'y-websocket';
import WebSocketImpl from 'ws';
import * as Y from 'yjs';

import { joinUrl, normalizeBaseUrl } from './paths.js';
import { reconnectDelayMs } from './rtc-connection.js';
import { authenticatedWebSocket } from './ws-auth.js';

/** Room name of JupyterLab's global awareness. */
export const GLOBAL_AWARENESS_ROOM = 'JupyterLab:globalAwareness';

/** Connection state of an {@link AwarenessRoom}. */
export type AwarenessRoomState = 'connecting' | 'connected' | 'reconnecting' | 'closed';

/** Constructor options of {@link AwarenessRoom}. */
export interface AwarenessRoomOptions {
  readonly wsBaseUrl: string;
  readonly token: string;
  readonly authHeaders?: Readonly<Record<string, string>>;
  readonly resolveAuthHeaders?: () => Readonly<Record<string, string>>;
  readonly credentialExpiry?: 'jwt';
  readonly credentialExpiresAt?: number;
  /** Default {@link GLOBAL_AWARENESS_ROOM}. */
  readonly roomName?: string;
  /** Room route below the base. Default `/api/collaboration/room`. */
  readonly roomRoute?: string;
  /** Backoff ceiling of the jittered reconnect delay. Default 30000 ms. */
  readonly maxBackoffTime?: number;
  readonly webSocketPolyfill?: typeof globalThis.WebSocket;
}

/** One awareness-only room connection. */
export class AwarenessRoom {
  readonly #doc = new Y.Doc();
  readonly #awareness: Awareness;
  readonly #provider: WebsocketProvider;
  readonly #maxBackoffMs: number;
  #state: AwarenessRoomState = 'connecting';
  #disposed = false;
  #reconnectAttempts = 0;
  #reconnectTimer: NodeJS.Timeout | null = null;
  #lastCloseCode: number | null = null;

  constructor(options: AwarenessRoomOptions, localState: Readonly<Record<string, unknown>>) {
    this.#maxBackoffMs = options.maxBackoffTime ?? 30_000;
    this.#awareness = new Awareness(this.#doc);
    this.#awareness.setLocalState({ ...localState });
    const base = options.webSocketPolyfill ?? (WebSocketImpl as unknown as typeof globalThis.WebSocket);
    this.#provider = new WebsocketProvider(
      normalizeBaseUrl(joinUrl(options.wsBaseUrl, options.roomRoute ?? '/api/collaboration/room')),
      options.roomName ?? GLOBAL_AWARENESS_ROOM,
      this.#doc,
      {
        connect: false,
        disableBc: true,
        awareness: this.#awareness,
        WebSocketPolyfill: authenticatedWebSocket(
          options.token,
          base,
          options.authHeaders,
          options.resolveAuthHeaders,
          options.credentialExpiry,
          options.credentialExpiresAt
        ),
        maxBackoffTime: this.#maxBackoffMs
      }
    );
    this.#provider.on('status', this.#onStatus);
    this.#provider.on('sync', this.#onSync);
    this.#provider.on('connection-close', this.#onConnectionClose);
  }

  get state(): AwarenessRoomState {
    return this.#state;
  }

  /** Close code of the last server close; `null` for none or a local close. */
  get lastCloseCode(): number | null {
    return this.#lastCloseCode;
  }

  /** Exposed for tests; the connection owns it. */
  get provider(): WebsocketProvider {
    return this.#provider;
  }

  /** Start connecting; never waits and never throws. */
  connect(): void {
    if (this.#disposed) return;
    this.#provider.connect();
  }

  /** Replace the whole local awareness state. */
  setLocalState(state: Readonly<Record<string, unknown>>): void {
    if (this.#disposed) return;
    this.#awareness.setLocalState({ ...state });
  }

  /** Leave the room: publish a null state, close the socket, free timers. */
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#clearReconnectTimer();
    this.#provider.off('status', this.#onStatus);
    this.#provider.off('sync', this.#onSync);
    this.#provider.off('connection-close', this.#onConnectionClose);
    try {
      this.#awareness.setLocalState(null);
    } catch {
      // A socket failing mid-send is closed below anyway.
    }
    this.#provider.shouldConnect = false;
    try {
      this.#provider.destroy();
    } catch {
      // Closing an already closed socket; not fatal.
    }
    this.#awareness.destroy();
    this.#doc.destroy();
    this.#state = 'closed';
  }

  readonly #onStatus = (event: { status: 'connected' | 'disconnected' | 'connecting' }): void => {
    if (this.#disposed) return;
    if (event.status === 'connected') this.#state = 'connected';
  };

  readonly #onSync = (synced: boolean): void => {
    if (synced) this.#reconnectAttempts = 0;
  };

  readonly #onConnectionClose = (event: CloseEvent | null): void => {
    if (this.#disposed) return;
    this.#lastCloseCode = event === null ? null : event.code;
    // y-websocket's own retry has no jitter and stops on 44xx; this class
    // schedules every retry itself (SPEC.md §6 reconnect convention).
    this.#provider.shouldConnect = false;
    this.#state = 'reconnecting';
    if (this.#reconnectTimer !== null) return;
    this.#reconnectAttempts += 1;
    const timer = setTimeout(() => {
      this.#reconnectTimer = null;
      if (!this.#disposed) this.#provider.connect();
    }, reconnectDelayMs(this.#reconnectAttempts, this.#maxBackoffMs));
    timer.unref?.();
    this.#reconnectTimer = timer;
  };

  #clearReconnectTimer(): void {
    if (this.#reconnectTimer === null) return;
    clearTimeout(this.#reconnectTimer);
    this.#reconnectTimer = null;
  }
}
