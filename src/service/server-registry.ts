/**
 * `ServerRegistry` (SPEC.md §4): the checked set of upstream servers, with
 * credentials kept out of every answer (SPEC.md §11).
 *
 * It owns three things:
 *
 * - the profiles: configured ones in preference order, plus - only when
 *   nothing was configured - the locally discovered ones. SPEC.md §11 forbids
 *   replacing an explicit configuration with a random local server, so
 *   discovery is a *fallback*, never a supplement;
 * - one {@link ServerClient} per server, built lazily so `server_list` still
 *   works when a credential file is missing;
 * - the per-server cache of the collaboration `sessionId`. It is the Jupyter
 *   process's `SERVER_SESSION`, identical for every document and changed only
 *   by a server restart (spike/NOTES.md §3.7), so it is cached per server and
 *   re-fetched when the room rejects it.
 *
 * @module
 */

import {
  coreError,
  type ServiceConfig,
  type ServerDescriptor,
  type ServerListEntry,
  type ServerListResult,
  type ServerOrigin,
  type ServerProfile
} from '../core/index.js';
import { ServerClient } from '../jupyter/server-client.js';
import { resolveServer, type CredentialSources } from './credentials.js';
import { discoverLocalServers, type DiscoveryEnvironment } from './discovery.js';

/** One known server. The credential is resolved on first use, not on listing. */
export interface ServerEntry {
  readonly id: string;
  readonly profile: ServerProfile;
  readonly origin: ServerOrigin;
  readonly descriptor: ServerDescriptor;
}

/** Injection points of {@link ServerRegistry}. */
export interface ServerRegistryOptions {
  readonly fetchImpl?: typeof fetch;
  readonly credentials?: CredentialSources;
  readonly discovery?: DiscoveryEnvironment;
  /** Replaces the whole discovery step; used by tests. */
  readonly discover?: () => Promise<readonly ServerProfile[]>;
}

/** Credential-free view of a profile (SPEC.md §9, §11). */
export function describeServer(profile: ServerProfile): ServerDescriptor {
  return {
    id: profile.id,
    kind: profile.kind,
    apiBaseUrl: profile.apiBaseUrl,
    ...(profile.browserBaseUrl === undefined ? {} : { browserBaseUrl: profile.browserBaseUrl }),
    ...(profile.hubUser === undefined ? {} : { hubUser: profile.hubUser }),
    ...(profile.hubServerName === undefined ? {} : { hubServerName: profile.hubServerName })
  };
}

/** The registry of one process. */
export class ServerRegistry {
  readonly #config: ServiceConfig;
  readonly #options: ServerRegistryOptions;
  readonly #clients = new Map<string, ServerClient>();
  readonly #collabSessionIds = new Map<string, string>();
  #entries: ServerEntry[] | null = null;
  #loading: Promise<ServerEntry[]> | null = null;

  constructor(config: ServiceConfig, options: ServerRegistryOptions = {}) {
    this.#config = config;
    this.#options = options;
  }

  /**
   * `true` when local runtime discovery would actually be consulted: the flag
   * is on *and* no profile was configured (SPEC.md §11).
   */
  get discoveryEnabled(): boolean {
    return this.#config.discovery && this.#config.servers.length === 0;
  }

  /** Every known server, discovery performed at most once. */
  async entries(): Promise<readonly ServerEntry[]> {
    if (this.#entries !== null) return this.#entries;
    this.#loading ??= this.#load();
    this.#entries = await this.#loading;
    return this.#entries;
  }

  /** `server_list` (SPEC.md §9): descriptors only, never a credential. */
  async list(): Promise<ServerListResult> {
    const entries = await this.entries();
    const single = entries.length === 1;
    const servers: ServerListEntry[] = entries.map((entry) => ({
      descriptor: entry.descriptor,
      origin: entry.origin,
      defaultChoice: single
    }));
    return {
      servers,
      discoveryEnabled: this.discoveryEnabled,
      selectionRequired: entries.length > 1
    };
  }

  /**
   * Pick the server of a `session_open` (SPEC.md §6 item 1).
   *
   * @throws CoreError `SERVER_NOT_FOUND` - unknown id, or nothing configured.
   * @throws CoreError `SERVER_SELECTION_REQUIRED` - no id and more than one
   * candidate; the process never guesses.
   */
  async select(serverId?: string): Promise<ServerEntry> {
    const entries = await this.entries();
    if (serverId !== undefined) {
      const found = entries.find((entry) => entry.id === serverId);
      if (found === undefined) {
        throw coreError('SERVER_NOT_FOUND', `no server profile with id "${serverId}"`, {
          details: { known: entries.map((entry) => entry.id) }
        });
      }
      return found;
    }
    if (entries.length === 0) {
      throw coreError(
        'SERVER_NOT_FOUND',
        'no Jupyter server is configured and none was discovered',
        { details: { discovery_enabled: this.discoveryEnabled } }
      );
    }
    if (entries.length > 1) {
      throw coreError(
        'SERVER_SELECTION_REQUIRED',
        'more than one server is available; pass an explicit server_id',
        { details: { candidates: entries.map((entry) => entry.id) } }
      );
    }
    return entries[0]!;
  }

  /**
   * The authenticated REST client of a server, created once.
   *
   * @throws CoreError `AUTH_REQUIRED` / `INVALID_ARGUMENT` from credential
   * resolution.
   */
  clientFor(entry: ServerEntry): ServerClient {
    const existing = this.#clients.get(entry.id);
    if (existing !== undefined) return existing;
    const resolved = resolveServer(entry.profile, this.#options.credentials);
    const client = new ServerClient(resolved, {
      ...(this.#options.fetchImpl === undefined ? {} : { fetchImpl: this.#options.fetchImpl })
    });
    this.#clients.set(entry.id, client);
    return client;
  }

  /** The resolved credential of a server; internal use only (SPEC.md §11). */
  tokenFor(entry: ServerEntry): string {
    return resolveServer(entry.profile, this.#options.credentials).token;
  }

  /**
   * `PUT /api/collaboration/session/<path>` with the server-wide `sessionId`
   * cached (spike/NOTES.md §3.7).
   *
   * `fileId` is per document and always taken from the answer; only the
   * `sessionId` is reused. `refresh: true` forces a new one, which is what a
   * room rejecting the session needs.
   */
  async collaborationSession(
    entry: ServerEntry,
    path: string,
    options: { readonly refresh?: boolean } = {}
  ): Promise<{ fileId: string; sessionId: string }> {
    const client = this.clientFor(entry);
    const session = await client.collaborationSession(path);
    if (options.refresh === true || !this.#collabSessionIds.has(entry.id)) {
      this.#collabSessionIds.set(entry.id, session.sessionId);
    }
    return {
      fileId: session.fileId,
      sessionId: this.#collabSessionIds.get(entry.id) ?? session.sessionId
    };
  }

  /** Cached `SERVER_SESSION` of a server, if one was seen. */
  cachedSessionId(entry: ServerEntry): string | null {
    return this.#collabSessionIds.get(entry.id) ?? null;
  }

  /** Forget the cached `SERVER_SESSION` - the server was restarted. */
  invalidateSessionId(entry: ServerEntry): void {
    this.#collabSessionIds.delete(entry.id);
  }

  async #load(): Promise<ServerEntry[]> {
    const configured = this.#config.servers.map((profile) => ({
      id: profile.id,
      profile,
      origin: 'configured' as ServerOrigin,
      descriptor: describeServer(profile)
    }));
    if (configured.length > 0) {
      const seen = new Set<string>();
      for (const entry of configured) {
        if (seen.has(entry.id)) {
          throw coreError('INVALID_ARGUMENT', `duplicate server profile id "${entry.id}"`);
        }
        seen.add(entry.id);
      }
      return configured;
    }
    if (!this.#config.discovery) return [];
    const profiles =
      this.#options.discover !== undefined
        ? await this.#options.discover()
        : (await discoverLocalServers(this.#options.discovery ?? {})).map(
            (found) => found.profile
          );
    return profiles.map((profile) => ({
      id: profile.id,
      profile,
      origin: 'discovered' as ServerOrigin,
      descriptor: describeServer(profile)
    }));
  }
}
