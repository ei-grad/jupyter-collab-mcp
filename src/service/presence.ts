/**
 * Agent presence of one working context and its server bindings
 * (SPEC.md §10 "Presence").
 *
 * {@link ContextPresence} holds what the agent declared about itself and is
 * shared by every server binding of one connection context.
 * {@link ServerPresence} belongs to one binding: it knows the owner on that
 * server, the open notebook paths in most-recently-used order, and the
 * global awareness room that exists exactly while at least one of them is
 * open.
 *
 * Everything here is best-effort and isolated from notebook operations: no
 * method throws into its caller, and nothing waits for the presence socket.
 *
 * @module
 */

import { randomBytes } from 'node:crypto';

import {
  presenceUser,
  type AwarenessUser,
  type PresenceClientInfo,
  type PresenceDeclaration,
  type PresenceOwner,
  type PresenceOwnerSource,
  type PresenceUser
} from '../core/index.js';

/** The part of an awareness room presence drives; `AwarenessRoom` in production. */
export interface PresenceRoom {
  readonly state: 'connecting' | 'connected' | 'reconnecting' | 'closed';
  readonly lastCloseCode: number | null;
  connect(): void;
  setLocalState(state: Readonly<Record<string, unknown>>): void;
  dispose(): void;
}

export type PresenceRoomFactory = (localState: Readonly<Record<string, unknown>>) => PresenceRoom;

/** Owner name used when neither configuration nor the server names one. */
export const PROCESS_PRESENCE_OWNER = `mcp-${randomBytes(4).toString('hex')}`;

/** Short random tag distinguishing one connection context (SPEC.md §10). */
export function newPresenceTag(): string {
  return randomBytes(4).toString('hex');
}

/** Presence diagnostics of one server binding. */
export interface ServerPresenceStatus {
  readonly serverId: string;
  readonly user: PresenceUser;
  readonly ownerSource: PresenceOwnerSource;
  readonly openDocuments: number;
  readonly globalPresence: 'inactive' | 'connecting' | 'connected' | 'reconnecting' | 'closed';
  readonly lastCloseCode: number | null;
}

/** Self-declared display identity of one connection context. */
export class ContextPresence {
  readonly tag: string;
  readonly #fallback: AwarenessUser;
  readonly #useClientInfo: boolean;
  readonly #servers = new Set<ServerPresence>();
  #declaration: PresenceDeclaration | null = null;
  #clientInfo: PresenceClientInfo | null = null;

  constructor(init: { readonly fallback: AwarenessUser; readonly useClientInfo: boolean; readonly tag?: string }) {
    this.tag = init.tag ?? newPresenceTag();
    this.#fallback = init.fallback;
    this.#useClientInfo = init.useClientInfo;
  }

  get declaration(): PresenceDeclaration | null {
    return this.#declaration;
  }

  /** Server bindings currently registered with this context. */
  servers(): readonly ServerPresence[] {
    return [...this.#servers];
  }

  /** Replace the declaration and republish it in every room of this context. */
  identify(declaration: PresenceDeclaration): void {
    this.#declaration = declaration;
    for (const server of this.#servers) server.refreshUser();
  }

  /** Record MCP `clientInfo`; it only matters while nothing was declared. */
  observeClientInfo(info: PresenceClientInfo): void {
    if (!this.#useClientInfo) return;
    const next: PresenceClientInfo = {
      ...(typeof info.name === 'string' ? { name: info.name } : {}),
      ...(typeof info.title === 'string' ? { title: info.title } : {}),
      ...(typeof info.version === 'string' ? { version: info.version } : {})
    };
    const previous = this.#clientInfo;
    if (previous !== null && previous.name === next.name && previous.title === next.title && previous.version === next.version) {
      return;
    }
    this.#clientInfo = next;
    for (const server of this.#servers) server.refreshUser();
  }

  userFor(owner: PresenceOwner): PresenceUser {
    return presenceUser({
      owner,
      contextTag: this.tag,
      declaration: this.#declaration,
      clientInfo: this.#clientInfo,
      fallback: this.#fallback
    });
  }

  /** @internal */
  register(server: ServerPresence): void {
    this.#servers.add(server);
  }

  /** @internal */
  unregister(server: ServerPresence): void {
    this.#servers.delete(server);
  }
}

/** Construction arguments of {@link ServerPresence}. */
export interface ServerPresenceInit {
  readonly serverId: string;
  readonly context: ContextPresence;
  /** Owner known without contacting the server. */
  readonly owner: PresenceOwner;
  /** Looks the owner up on the server; `null` keeps {@link owner}. */
  readonly resolveOwner?: () => Promise<PresenceOwner | null>;
  readonly openRoom: PresenceRoomFactory;
  /** Republish the user in the binding's document rooms. */
  readonly onUserChanged: (user: PresenceUser) => void;
}

/** Presence of one server binding of a context. */
export class ServerPresence {
  readonly serverId: string;
  readonly context: ContextPresence;
  readonly #openRoom: PresenceRoomFactory;
  readonly #onUserChanged: (user: PresenceUser) => void;
  readonly #ownerSettled: Promise<void>;
  /** Open notebook paths, least recently used first. */
  readonly #documents: string[] = [];
  #owner: PresenceOwner;
  #user: PresenceUser;
  #room: PresenceRoom | null = null;
  #roomPending = false;
  #disposed = false;

  constructor(init: ServerPresenceInit) {
    this.serverId = init.serverId;
    this.context = init.context;
    this.#openRoom = init.openRoom;
    this.#onUserChanged = init.onUserChanged;
    this.#owner = init.owner;
    this.#user = init.context.userFor(init.owner);
    init.context.register(this);
    const resolve = init.resolveOwner;
    this.#ownerSettled = resolve === undefined
      ? Promise.resolve()
      : (async () => {
          try {
            const owner = await resolve();
            if (owner !== null && !this.#disposed) {
              this.#owner = owner;
              this.refreshUser();
            }
          } catch {
            // The provisional owner stays; presence never fails an operation.
          }
        })();
  }

  get user(): PresenceUser {
    return this.#user;
  }

  get owner(): PresenceOwner {
    return this.#owner;
  }

  /** Resolves once the owner lookup finished, successfully or not. */
  get ownerSettled(): Promise<void> {
    return this.#ownerSettled;
  }

  status(): ServerPresenceStatus {
    return {
      serverId: this.serverId,
      user: this.#user,
      ownerSource: this.#owner.source,
      openDocuments: this.#documents.length,
      globalPresence: this.#room?.state ?? 'inactive',
      lastCloseCode: this.#room?.lastCloseCode ?? null
    };
  }

  /** A notebook handle for `path` was registered. */
  opened(path: string): void {
    if (this.#disposed) return;
    this.#moveToFront(path);
    this.#publish();
    this.#ensureRoom();
  }

  /** The agent read, edited or executed `path`. */
  touched(path: string): void {
    if (this.#disposed || this.#documents.at(-1) === path || !this.#documents.includes(path)) return;
    this.#moveToFront(path);
    this.#publish();
  }

  /** The handle for `path` was released; the last one leaves the room. */
  closed(path: string): void {
    if (this.#disposed) return;
    const index = this.#documents.indexOf(path);
    if (index < 0) return;
    this.#documents.splice(index, 1);
    if (this.#documents.length === 0) this.#closeRoom();
    else this.#publish();
  }

  /** Recompute the user after an owner or declaration change. */
  refreshUser(): void {
    if (this.#disposed) return;
    const next = this.context.userFor(this.#owner);
    if (JSON.stringify(next) === JSON.stringify(this.#user)) return;
    this.#user = next;
    try {
      this.#onUserChanged(next);
    } catch {
      // A document room that cannot take the update keeps its previous state.
    }
    this.#publish();
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#documents.length = 0;
    this.#closeRoom();
    this.context.unregister(this);
  }

  #moveToFront(path: string): void {
    const index = this.#documents.indexOf(path);
    if (index >= 0) this.#documents.splice(index, 1);
    this.#documents.push(path);
  }

  #localState(): Record<string, unknown> {
    const current = this.#documents.at(-1);
    return {
      user: { ...this.#user },
      current: current === undefined ? null : `notebook:${current}`,
      documents: [...this.#documents]
    };
  }

  #publish(): void {
    try {
      this.#room?.setLocalState(this.#localState());
    } catch {
      // Best-effort: the next change or reconnect republishes.
    }
  }

  /**
   * Join the global room once the owner lookup settled, so the first state
   * other clients see already carries the final `username`.
   */
  #ensureRoom(): void {
    if (this.#room !== null || this.#roomPending) return;
    this.#roomPending = true;
    void this.#ownerSettled.then(() => {
      this.#roomPending = false;
      if (this.#disposed || this.#room !== null || this.#documents.length === 0) return;
      try {
        const room = this.#openRoom(this.#localState());
        this.#room = room;
        room.connect();
      } catch {
        // No presence room on this server; notebook work is unaffected.
        this.#closeRoom();
      }
    });
  }

  #closeRoom(): void {
    const room = this.#room;
    this.#room = null;
    if (room === null) return;
    try {
      room.dispose();
    } catch {
      // Leaving is best-effort; the server times the state out regardless.
    }
  }
}
