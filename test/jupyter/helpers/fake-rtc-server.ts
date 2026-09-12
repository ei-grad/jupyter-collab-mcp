/**
 * Minimal stand-in for a jupyter-collaboration room server (SPEC.md §13 step 1:
 * "specific close-code fixtures").
 *
 * Implements just enough to drive {@link RtcConnection}: the Yjs sync protocol,
 * awareness pass-through and the Jupyter RAW `save` reply, plus knobs for the
 * failure modes the SPEC.md §6 table names - 1003 with a JSON reason, 4400,
 * 4404, N times 4500 then accept, a RAW conflict frame and an abrupt socket
 * drop (1006).
 *
 * It is *not* a Jupyter server: no auth, no file identity, no persistence.
 * Everything that depends on real server behaviour is covered by the
 * integration tests instead.
 */

import type { AddressInfo } from 'node:net';

import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import * as syncProtocol from 'y-protocols/sync';
import * as Y from 'yjs';

import { MESSAGE_RAW, encodeRawJson } from '../../../src/jupyter/raw-protocol.js';

const MESSAGE_SYNC = 0;
const MESSAGE_AWARENESS = 1;

/** Close instruction applied to the next incoming connection. */
export interface PlannedClose {
  readonly code: number;
  /** Sent as the close reason; for 1003 the server sends JSON here. */
  readonly reason: string;
  /** How many further connections get the same treatment. Default 1. */
  readonly times?: number;
}

export interface FakeRtcServerOptions {
  /** 0 (default) picks a free port. */
  readonly port?: number;
  /** Status returned for a RAW save. Default `success`. */
  readonly saveStatus?: 'success' | 'skipped' | 'failed';
}

interface RoomState {
  readonly doc: Y.Doc;
  readonly sockets: Set<WebSocket>;
}

/** A fake room server; one `Y.Doc` per room name. */
export class FakeRtcServer {
  readonly #wss: WebSocketServer;
  readonly #rooms = new Map<string, RoomState>();
  #plannedCloses: PlannedClose[] = [];
  #saveStatus: 'success' | 'skipped' | 'failed';
  #replyToSave = true;

  /** Room names of every connection attempt, in order. */
  readonly seenRooms: string[] = [];
  /** Query strings of every connection attempt, in order. */
  readonly seenQueries: string[] = [];
  /**
   * `Authorization` header of every connection attempt, in order (`null` when
   * the client sent none). The real server answers 403 without a credential;
   * this fixture only records it.
   */
  readonly seenAuthorizations: Array<string | null> = [];
  /** Save request ids received, in order. */
  readonly saveRequests: number[] = [];
  /** Accepted (not immediately closed) connections. */
  readonly accepted: WebSocket[] = [];

  private constructor(wss: WebSocketServer, options: FakeRtcServerOptions) {
    this.#wss = wss;
    this.#saveStatus = options.saveStatus ?? 'success';
    this.#wss.on('connection', (socket, request) => {
      this.#onConnection(socket, request.url ?? '/', request.headers.authorization ?? null);
    });
  }

  /** Start listening. Await the returned promise before connecting. */
  static start(options: FakeRtcServerOptions = {}): Promise<FakeRtcServer> {
    return new Promise((resolve, reject) => {
      const wss = new WebSocketServer({ host: '127.0.0.1', port: options.port ?? 0 });
      wss.once('error', reject);
      wss.once('listening', () => {
        wss.off('error', reject);
        resolve(new FakeRtcServer(wss, options));
      });
    });
  }

  /** Base URL to hand to `RtcConnection` as `wsBaseUrl`. */
  get baseUrl(): string {
    const address = this.#wss.address() as AddressInfo;
    return `ws://127.0.0.1:${address.port}`;
  }

  /** Number of currently open accepted sockets. */
  get openSockets(): number {
    return this.accepted.filter((socket) => socket.readyState === WebSocket.OPEN).length;
  }

  /** Close the next `times` connections with `code`/`reason` (SPEC.md §6). */
  planClose(close: PlannedClose): void {
    const times = close.times ?? 1;
    for (let i = 0; i < times; i += 1) this.#plannedCloses.push(close);
  }

  /** Status the next RAW save replies with. */
  setSaveStatus(status: 'success' | 'skipped' | 'failed'): void {
    this.#saveStatus = status;
  }

  /** Stop answering save requests, so the client hits its own timeout. */
  setReplyToSave(reply: boolean): void {
    this.#replyToSave = reply;
  }

  /**
   * Send a RAW `{"type":"conflict"}` (SPEC.md §6).
   *
   * The real server answers only the channel whose update it rejected
   * (`jupyter_server_ydoc/rooms.py` `_handle_sync_message_error`), so pass a
   * socket to reproduce that; with no argument every open socket gets it.
   */
  sendConflict(target?: WebSocket): void {
    const frame = encodeRawJson({ type: 'conflict' });
    const sockets = target === undefined ? this.accepted : [target];
    for (const socket of sockets) {
      if (socket.readyState === WebSocket.OPEN) socket.send(frame);
    }
  }

  /** Kill every open socket without a close frame - the client sees 1006. */
  dropAll(): void {
    for (const socket of this.accepted) {
      if (socket.readyState === WebSocket.OPEN) socket.terminate();
    }
  }

  /** Content of a room's document, for assertions. */
  room(name: string): Y.Doc | undefined {
    return this.#rooms.get(name)?.doc;
  }

  /** Stop the server and every socket. */
  close(): Promise<void> {
    for (const socket of this.accepted) socket.terminate();
    for (const state of this.#rooms.values()) state.doc.destroy();
    this.#rooms.clear();
    return new Promise((resolve, reject) => {
      this.#wss.close((error) => (error ? reject(error) : resolve()));
    });
  }

  #onConnection(socket: WebSocket, url: string, authorization: string | null): void {
    const [rawPath = '/', query = ''] = url.split('?');
    // y-websocket appends the room name verbatim; keep it unencoded here too so
    // a %3A-escaped name shows up as a *different* room (spike/NOTES.md §1.3).
    const name = rawPath.slice(rawPath.lastIndexOf('/') + 1);
    this.seenRooms.push(name);
    this.seenQueries.push(query);
    this.seenAuthorizations.push(authorization);

    const planned = this.#plannedCloses.shift();
    if (planned !== undefined) {
      socket.close(planned.code, planned.reason);
      return;
    }

    this.accepted.push(socket);
    const state = this.#room(name);
    state.sockets.add(socket);

    const onUpdate = (update: Uint8Array, origin: unknown): void => {
      if (origin === socket) return;
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MESSAGE_SYNC);
      syncProtocol.writeUpdate(encoder, update);
      if (socket.readyState === WebSocket.OPEN) socket.send(encoding.toUint8Array(encoder));
    };
    state.doc.on('update', onUpdate);

    socket.on('message', (data: RawData) => {
      this.#onMessage(socket, state, toUint8Array(data));
    });
    socket.on('close', () => {
      state.doc.off('update', onUpdate);
      state.sockets.delete(socket);
    });
    socket.on('error', () => {
      /* a terminated socket must not throw here */
    });

    // The server sends SyncStep1 first (spike/NOTES.md §1.3).
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_SYNC);
    syncProtocol.writeSyncStep1(encoder, state.doc);
    socket.send(encoding.toUint8Array(encoder));
  }

  #onMessage(socket: WebSocket, state: RoomState, data: Uint8Array): void {
    const decoder = decoding.createDecoder(data);
    const messageType = decoding.readVarUint(decoder);
    if (messageType === MESSAGE_SYNC) {
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MESSAGE_SYNC);
      syncProtocol.readSyncMessage(decoder, encoder, state.doc, socket);
      if (encoding.length(encoder) > 1 && socket.readyState === WebSocket.OPEN) {
        socket.send(encoding.toUint8Array(encoder));
      }
      return;
    }
    if (messageType === MESSAGE_AWARENESS) {
      for (const peer of state.sockets) {
        if (peer !== socket && peer.readyState === WebSocket.OPEN) peer.send(data);
      }
      return;
    }
    if (messageType === MESSAGE_RAW) {
      const verb = decoding.readVarString(decoder);
      if (verb !== 'save') return;
      const id = decoding.readVarUint(decoder);
      this.saveRequests.push(id);
      if (!this.#replyToSave || socket.readyState !== WebSocket.OPEN) return;
      socket.send(encodeRawJson({ type: 'save', responseTo: id, status: this.#saveStatus }));
    }
  }

  #room(name: string): RoomState {
    let state = this.#rooms.get(name);
    if (state === undefined) {
      state = { doc: new Y.Doc(), sockets: new Set() };
      this.#rooms.set(name, state);
    }
    return state;
  }
}

function toUint8Array(data: RawData): Uint8Array {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (Array.isArray(data)) return new Uint8Array(Buffer.concat(data));
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}
