/**
 * REST client for one Jupyter Server (SPEC.md §6, §11).
 *
 * Built from a {@link ResolvedServer}: the `base_url` prefix (`/user/name/`
 * and friends) is preserved, the token stays in the `Authorization` header and
 * never appears in a message, `toString()` or `toJSON()`.
 *
 * Only the calls the first version needs are here: server status, listing a
 * directory, checking existence without downloading content, allocating an
 * untitled notebook, and the collaboration document session. Normal editing
 * goes through RTC; the Contents API is never used to write an open `.ipynb`
 * (SPEC.md §6).
 *
 * @module
 */

import { ServerConnection } from '@jupyterlab/services';
import WebSocket from 'ws';
import { authenticatedWebSocket } from './ws-auth.js';

import { coreError, type ErrorCode, type ResolvedServer } from '../core/index.js';
import { httpRequest, parseJsonBody } from './http.js';
import {
  ROOM_FORMAT,
  ROOM_TYPE,
  encodeContentsPath,
  encodeSessionPath,
  joinUrl,
  normalizeBaseUrl,
  normalizeContentsPath
} from './paths.js';

/** `GET /api/status` (SPEC.md §5: presence of the API, distinct from 401/404). */
export interface ServerStatus {
  readonly started?: string;
  readonly last_activity?: string;
  readonly connections?: number;
  readonly kernels?: number;
  readonly version?: string;
}

/** Contents entry we keep: notebooks and directories only (SPEC.md §9). */
export interface DirectoryEntry {
  readonly name: string;
  readonly path: string;
  readonly type: 'notebook' | 'directory';
  readonly lastModified: string | null;
  readonly size: number | null;
}

/** Result of {@link ServerClient.listDirectory}. */
export interface DirectoryListing {
  /** Normalised directory path; `''` is the Jupyter root. */
  readonly path: string;
  readonly entries: readonly DirectoryEntry[];
}

/** Minimal Contents model fields this module reads. */
export interface ContentsStat {
  readonly path: string;
  readonly name: string;
  readonly type: string;
  readonly lastModified: string | null;
  readonly size: number | null;
}

/**
 * One `/api/sessions` entry, reduced to the facts the kernel binding needs
 * (SPEC.md §8: the kernel is bound to a notebook *path* through the Sessions
 * API, and an ambiguous binding is an error, never a guess).
 */
export interface JupyterSessionInfo {
  /** Jupyter kernel-session id - not a working session and not a room. */
  readonly id: string;
  readonly path: string;
  readonly name: string;
  readonly type: string;
  readonly kernelId: string | null;
  readonly kernelName: string | null;
  /** Server-reported execution state; `null` when the server omitted it. */
  readonly executionState: string | null;
  readonly lastActivity: string | null;
  readonly connections: number | null;
}

/** One kernelspec offered by `GET /api/kernelspecs`. */
export interface KernelSpecEntry {
  readonly name: string;
  readonly displayName: string;
  readonly language: string;
}

/** Answer of {@link ServerClient.kernelSpecs}. */
export interface KernelSpecList {
  readonly defaultName: string | null;
  readonly specs: readonly KernelSpecEntry[];
}

/** One entry of `GET /api/kernels`. */
export interface RunningKernelEntry {
  readonly id: string;
  readonly name: string;
  readonly lastActivity: string | null;
  readonly connections: number | null;
  readonly executionState: string | null;
}

/** Arguments of {@link ServerClient.startSession}. */
export interface StartSessionRequest {
  /** Notebook path the kernel is bound to. */
  readonly path: string;
  /** Defaults to `path`. */
  readonly name?: string;
  /** Defaults to `notebook`. */
  readonly type?: string;
  /** Omitted, the server picks its default kernelspec. */
  readonly kernelName?: string;
}

/**
 * `PUT /api/collaboration/session/<path>` result (SPEC.md §6 items 3-4).
 *
 * `sessionId` is the server-wide `SERVER_SESSION` of the Jupyter process, not a
 * per-document value: it is identical for every document and only changes when
 * the server restarts (spike/NOTES.md §3.7). Cache it per server.
 */
export interface CollaborationSession {
  readonly fileId: string;
  readonly sessionId: string;
  readonly format: string;
  readonly type: string;
  /** 201 when the file was indexed by this call, 200 when it already was. */
  readonly httpStatus: number;
}

/** Options of {@link ServerClient}. */
export interface ServerClientOptions {
  /** Injected in tests; defaults to the global `fetch`. */
  readonly fetchImpl?: typeof fetch;
}

interface ContentsModel {
  name?: string;
  path?: string;
  type?: string;
  last_modified?: string | null;
  size?: number | null;
  content?: unknown;
}

interface SessionModel {
  id?: string;
  path?: string;
  name?: string;
  type?: string;
  kernel?: {
    id?: string;
    name?: string;
    execution_state?: string;
    last_activity?: string | null;
    connections?: number;
  } | null;
}

/** `/api/sessions` model to {@link JupyterSessionInfo}; tolerates missing fields. */
function sessionInfo(model: SessionModel): JupyterSessionInfo {
  const kernel = model.kernel ?? null;
  return {
    id: model.id ?? '',
    path: model.path ?? '',
    name: model.name ?? '',
    type: model.type ?? '',
    kernelId: typeof kernel?.id === 'string' ? kernel.id : null,
    kernelName: typeof kernel?.name === 'string' ? kernel.name : null,
    executionState: typeof kernel?.execution_state === 'string' ? kernel.execution_state : null,
    lastActivity: typeof kernel?.last_activity === 'string' ? kernel.last_activity : null,
    connections: typeof kernel?.connections === 'number' ? kernel.connections : null
  };
}

/**
 * Authenticated REST access to one server (SPEC.md §6).
 *
 * Every method throws a {@link CoreError} with a SPEC.md §9 code; no method
 * ever puts the token into that error.
 */
export class ServerClient {
  /** Normalised API base including any prefix, no trailing slash. */
  readonly apiBaseUrl: string;
  /** Normalised WS base matching {@link apiBaseUrl}. */
  readonly wsBaseUrl: string;
  /** `server_id` of the profile this client was built from. */
  readonly serverId: string;

  readonly #token: string;
  readonly #authHeaders: Readonly<Record<string, string>> | undefined;
  readonly #credentialExpiresAt: number | undefined;
  readonly #credentialExpiry: 'jwt' | undefined;
  readonly #resolveAuthHeaders: (() => Readonly<Record<string, string>>) | undefined;
  readonly #fetch: typeof fetch;
  #settings: ServerConnection.ISettings | null = null;

  constructor(server: ResolvedServer, options: ServerClientOptions = {}) {
    this.apiBaseUrl = normalizeBaseUrl(server.apiBaseUrl);
    this.wsBaseUrl = normalizeBaseUrl(server.wsBaseUrl);
    this.serverId = server.profile.id;
    this.#token = server.token;
    this.#authHeaders = server.authHeaders === undefined ? undefined : Object.freeze({ ...server.authHeaders });
    this.#resolveAuthHeaders = server.resolveAuthHeaders;
    this.#credentialExpiry = server.profile.credentialExpiry;
    this.#credentialExpiresAt = server.profile.credentialExpiresAt;
    this.#fetch = options.fetchImpl ?? fetch;
  }

  /** `GET /api/status`. Distinguishes "API present" from 401/403/404. */
  async status(): Promise<ServerStatus> {
    const route = '/api/status';
    const response = await this.#request(route, { method: 'GET' });
    return parseJsonBody<ServerStatus>(response, route);
  }

  /** Read the storage provider's notebook representation independently of RTC. */
  async readNotebookContents(path: string, signal: AbortSignal, maxResponseBytes: number): Promise<unknown> {
    const route = `/api/contents/${encodeContentsPath(normalizeContentsPath(path))}?content=1&type=notebook`;
    const response = await this.#request(route, { method: 'GET', signal, noCache: true, maxResponseBytes });
    const model = parseJsonBody<ContentsModel>(response, route);
    if (model.type !== 'notebook') throw coreError('INVALID_ARGUMENT', 'Contents readback is not a notebook');
    return model.content;
  }

  /**
   * `GET /api/contents/<dir>?content=1`, filtered to notebooks and directories
   * (SPEC.md §9 `notebook_list`).
   */
  async listDirectory(path = ''): Promise<DirectoryListing> {
    const normalized = normalizeContentsPath(path);
    const route = `/api/contents/${encodeContentsPath(normalized)}?content=1`;
    const response = await this.#request(route, { method: 'GET' });
    const model = parseJsonBody<ContentsModel>(response, route);
    if (model.type !== 'directory') {
      throw coreError('INVALID_ARGUMENT', `"${normalized}" is not a directory`, {
        details: { path: normalized, type: model.type ?? null }
      });
    }
    const raw = Array.isArray(model.content) ? (model.content as ContentsModel[]) : [];
    const entries: DirectoryEntry[] = [];
    for (const item of raw) {
      if (item.type !== 'notebook' && item.type !== 'directory') continue;
      entries.push({
        name: item.name ?? '',
        path: item.path ?? '',
        type: item.type,
        lastModified: item.last_modified ?? null,
        size: typeof item.size === 'number' ? item.size : null
      });
    }
    return { path: normalized, entries };
  }

  /**
   * `GET /api/contents/<path>?content=0` (SPEC.md §6 item 2).
   *
   * `content=0` is the point: the notebook body must not be downloaded before
   * the same document is fetched over RTC (SPEC.md §2). Returns `null` when the
   * path does not exist - a missing file is an answer here, not an error.
   */
  async contentsExists(path: string): Promise<ContentsStat | null> {
    const normalized = normalizeContentsPath(path);
    const route = `/api/contents/${encodeContentsPath(normalized)}?content=0`;
    const response = await this.#request(route, { method: 'GET', allowStatus: [404] });
    if (response.status === 404) return null;
    const model = parseJsonBody<ContentsModel>(response, route);
    return {
      path: model.path ?? normalized,
      name: model.name ?? '',
      type: model.type ?? 'file',
      lastModified: model.last_modified ?? null,
      size: typeof model.size === 'number' ? model.size : null
    };
  }

  /**
   * `POST /api/contents/<dir>` with `{"type":"notebook"}` - newUntitled
   * (SPEC.md §6: never `PUT` a chosen path).
   *
   * The server picks the file name and returns the actual path.
   */
  async newUntitledNotebook(directory = ''): Promise<{ path: string }> {
    const normalized = normalizeContentsPath(directory);
    const route = `/api/contents/${encodeContentsPath(normalized)}`;
    const response = await this.#request(route, {
      method: 'POST',
      json: { type: 'notebook' },
      notFoundCode: 'NOTEBOOK_NOT_FOUND'
    });
    const model = parseJsonBody<ContentsModel>(response, route);
    if (typeof model.path !== 'string' || model.path.length === 0) {
      throw coreError('INTERNAL_ERROR', `${route} returned no path for the new notebook`);
    }
    return { path: model.path };
  }

  /**
   * `PUT /api/collaboration/session/<encodeURIComponent(path)>` (SPEC.md §6 item 3).
   *
   * **201 does not prove the file exists.** `ArbitraryFileIdManager.index()`
   * mints an id for a missing path; the room then closes with 4404
   * (spike/NOTES.md §1.2). Check existence separately with
   * {@link contentsExists}, or treat 4404 as `NOTEBOOK_NOT_FOUND`.
   */
  async collaborationSession(
    path: string,
    format: string = ROOM_FORMAT,
    type: string = ROOM_TYPE
  ): Promise<CollaborationSession> {
    const route = `/api/collaboration/session/${encodeSessionPath(path)}`;
    const response = await this.#request(route, { method: 'PUT', json: { format, type } });
    const model = parseJsonBody<Partial<CollaborationSession>>(response, route);
    if (typeof model.fileId !== 'string' || typeof model.sessionId !== 'string') {
      throw coreError('INTERNAL_ERROR', `${route} returned no fileId/sessionId`, {
        sideEffects: 'none'
      });
    }
    return {
      fileId: model.fileId,
      sessionId: model.sessionId,
      format: model.format ?? format,
      type: model.type ?? type,
      httpStatus: response.status
    };
  }

  /**
   * `@jupyterlab/services` settings for the kernel layer (SPEC.md §8).
   *
   * Credentials stay in handshake headers, including kernel reconnects.
   */
  serverSettings(): ServerConnection.ISettings {
    if (this.#settings === null) {
      this.#settings = ServerConnection.makeSettings({
        baseUrl: `${this.apiBaseUrl}/`,
        wsUrl: `${this.wsBaseUrl}/`,
        token: '',
        appendToken: false,
        WebSocket: authenticatedWebSocket(
          this.#token,
          WebSocket as unknown as typeof globalThis.WebSocket,
          this.#authHeaders,
          this.#resolveAuthHeaders,
          this.#credentialExpiry,
          this.#credentialExpiresAt
        ),
        // The injected implementation, not the global one: whatever transport
        // policy a profile needs (docs/CONNECTIONS.md §9 `tls_ca_ref`,
        // `proxy_auth_ref`) must cover the kernel layer as well as REST.
        fetch: this.#authenticatedFetch as unknown as ServerConnection.ISettings['fetch']
      });
    }
    return this.#settings;
  }

  /** Internal authentication configuration shared by RTC and kernel connections. Never log. */
  connectionAuth(): {
    token: string;
    authHeaders?: Readonly<Record<string, string>>;
    resolveAuthHeaders?: () => Readonly<Record<string, string>>;
    credentialExpiry?: 'jwt';
    credentialExpiresAt?: number;
  } {
    return {
      token: this.#token,
      ...(this.#authHeaders === undefined ? {} : { authHeaders: this.#authHeaders }),
      ...(this.#resolveAuthHeaders === undefined ? {} : { resolveAuthHeaders: this.#resolveAuthHeaders }),
      ...(this.#credentialExpiry === undefined ? {} : { credentialExpiry: this.#credentialExpiry }),
      ...(this.#credentialExpiresAt === undefined ? {} : { credentialExpiresAt: this.#credentialExpiresAt })
    };
  }

  readonly #authenticatedFetch: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    if (new URL(request.url).origin !== new URL(this.apiBaseUrl).origin) {
      throw coreError('NETWORK_ERROR', 'kernel request targets a different origin');
    }
    const authHeaders = this.#resolveAuthHeaders?.() ?? this.#authHeaders;
    const headers = new Headers(request.headers);
    headers.delete('Authorization');
    for (const [name, value] of Object.entries(authHeaders ?? { Authorization: `token ${this.#token}` })) {
      headers.set(name, value);
    }
    // Refuse redirects before the underlying fetch can forward custom headers.
    const scrub = (text: string): string =>
      Object.values(authHeaders ?? { token: this.#token }).reduce(
        (value, secret) => secret ? value.replaceAll(secret, '<redacted>') : value, text
      );
    let response: Response;
    try {
      response = await this.#fetch(new Request(request, { headers, redirect: 'error' }));
    } catch (error) {
      throw new Error(scrub(error instanceof Error ? error.message : 'kernel request failed'));
    }
    if (!response.ok) {
      return new Response(scrub(await response.text()), {
        status: response.status, statusText: scrub(response.statusText), headers: response.headers
      });
    }
    // JSON.parse embeds input fragments in SyntaxError messages. The kernel
    // library consumes response.json() directly, outside our REST error mapper.
    const parseJson = response.json.bind(response);
    Object.defineProperty(response, 'json', {
      value: async () => {
        try {
          return await parseJson();
        } catch {
          throw coreError('INTERNAL_ERROR', 'kernel server returned an unreadable JSON response');
        }
      }
    });
    return response;
  };

  /**
   * `PATCH /api/contents/<from>` with `{"path": "<to>"}` - the rename step of
   * `notebook_create` (SPEC.md §6 "notebook creation").
   *
   * The room of the final path is opened only after this succeeds. 409 becomes
   * `ALREADY_EXISTS` and 403 `PERMISSION_DENIED` through {@link mapHttpStatus};
   * a lost confirmation of a sent `PATCH` becomes `OPERATION_UNCERTAIN`,
   * because `PATCH` is not a safe method. The caller adds the untitled path and
   * `side_effects: applied` to those errors - only it knows a file was
   * allocated first.
   */
  async rename(fromPath: string, toPath: string): Promise<{ path: string }> {
    const from = normalizeContentsPath(fromPath);
    const to = normalizeContentsPath(toPath);
    const route = `/api/contents/${encodeContentsPath(from)}`;
    const response = await this.#request(route, { method: 'PATCH', json: { path: to } });
    const model = parseJsonBody<ContentsModel>(response, route);
    return { path: typeof model.path === 'string' && model.path.length > 0 ? model.path : to };
  }

  /** `GET /api/sessions` (SPEC.md §8: the kernel binding lives here). */
  async listSessions(): Promise<readonly JupyterSessionInfo[]> {
    const route = '/api/sessions';
    const response = await this.#request(route, { method: 'GET' });
    const raw = parseJsonBody<unknown>(response, route);
    if (!Array.isArray(raw)) return [];
    return raw.map((entry) => sessionInfo(entry as SessionModel));
  }

  /**
   * `POST /api/sessions` - bind a kernel to a notebook path (SPEC.md §8).
   *
   * Only `kernel_control(action: 'start' | 'switch')` calls this: reading or
   * opening a notebook never starts a kernel.
   */
  async startSession(request: StartSessionRequest): Promise<JupyterSessionInfo> {
    const path = normalizeContentsPath(request.path);
    const route = '/api/sessions';
    const body: Record<string, unknown> = {
      path,
      name: request.name ?? path,
      type: request.type ?? 'notebook',
      ...(request.kernelName === undefined ? {} : { kernel: { name: request.kernelName } })
    };
    const response = await this.#request(route, { method: 'POST', json: body });
    return sessionInfo(parseJsonBody<SessionModel>(response, route));
  }

  /** `PATCH /api/sessions/<id>` with a new kernelspec - `kernel_control switch`. */
  async patchSessionKernel(sessionId: string, kernelName: string): Promise<JupyterSessionInfo> {
    const route = `/api/sessions/${encodeURIComponent(sessionId)}`;
    const response = await this.#request(route, {
      method: 'PATCH',
      json: { kernel: { name: kernelName } },
      notFoundCode: 'KERNEL_NOT_BOUND'
    });
    return sessionInfo(parseJsonBody<SessionModel>(response, route));
  }

  /**
   * `DELETE /api/sessions/<id>` - `kernel_control(action: 'shutdown')`.
   *
   * This is the only place the client shuts a kernel down: no close, no
   * disposal and no process exit does it (SPEC.md §4). A 404 is success, the
   * session is already gone.
   */
  async deleteSession(sessionId: string): Promise<void> {
    const route = `/api/sessions/${encodeURIComponent(sessionId)}`;
    await this.#request(route, { method: 'DELETE', allowStatus: [404] });
  }

  /** `GET /api/kernelspecs`. Lists only; starts nothing (SPEC.md §8). */
  async kernelSpecs(): Promise<KernelSpecList> {
    const route = '/api/kernelspecs';
    const response = await this.#request(route, { method: 'GET' });
    const model = parseJsonBody<{
      default?: string;
      kernelspecs?: Record<string, { name?: string; spec?: { display_name?: string; language?: string } }>;
    }>(response, route);
    const specs: KernelSpecEntry[] = [];
    for (const [key, value] of Object.entries(model.kernelspecs ?? {})) {
      specs.push({
        name: value.name ?? key,
        displayName: value.spec?.display_name ?? key,
        language: value.spec?.language ?? ''
      });
    }
    return { defaultName: typeof model.default === 'string' ? model.default : null, specs };
  }

  /** `GET /api/kernels` - running kernels of the whole server (SPEC.md §8). */
  async listKernels(): Promise<readonly RunningKernelEntry[]> {
    const route = '/api/kernels';
    const response = await this.#request(route, { method: 'GET' });
    const raw = parseJsonBody<unknown>(response, route);
    if (!Array.isArray(raw)) return [];
    const kernels: RunningKernelEntry[] = [];
    for (const item of raw as Array<Record<string, unknown>>) {
      if (typeof item['id'] !== 'string') continue;
      kernels.push({
        id: item['id'],
        name: typeof item['name'] === 'string' ? item['name'] : '',
        lastActivity: typeof item['last_activity'] === 'string' ? item['last_activity'] : null,
        connections: typeof item['connections'] === 'number' ? item['connections'] : null,
        executionState: typeof item['execution_state'] === 'string' ? item['execution_state'] : null
      });
    }
    return kernels;
  }

  /**
   * `POST /api/kernels/<id>/interrupt` (SPEC.md §8).
   *
   * An operation on the whole kernel: it may stop code another participant
   * started. Never triggered by a timeout or by a cancelled wait.
   */
  async interruptKernel(kernelId: string): Promise<void> {
    const route = `/api/kernels/${encodeURIComponent(kernelId)}/interrupt`;
    await this.#request(route, { method: 'POST', notFoundCode: 'KERNEL_NOT_BOUND' });
  }

  /** `POST /api/kernels/<id>/restart`. Clears no outputs and re-runs nothing. */
  async restartKernel(kernelId: string): Promise<void> {
    const route = `/api/kernels/${encodeURIComponent(kernelId)}/restart`;
    await this.#request(route, { method: 'POST', notFoundCode: 'KERNEL_NOT_BOUND' });
  }

  /** Credential-free description (SPEC.md §11). */
  toString(): string {
    return `ServerClient(${this.serverId} ${this.apiBaseUrl})`;
  }

  /** Credential-free description; `JSON.stringify` cannot leak the token. */
  toJSON(): { serverId: string; apiBaseUrl: string; wsBaseUrl: string } {
    return { serverId: this.serverId, apiBaseUrl: this.apiBaseUrl, wsBaseUrl: this.wsBaseUrl };
  }

  /** `util.inspect` / `console.log` must not print the token either. */
  [Symbol.for('nodejs.util.inspect.custom')](): string {
    return this.toString();
  }

  #request(
    route: string,
    options: {
      method: string;
      json?: unknown;
      allowStatus?: readonly number[];
      notFoundCode?: ErrorCode;
      signal?: AbortSignal;
      noCache?: boolean;
      maxResponseBytes?: number;
    }
  ): ReturnType<typeof httpRequest> {
    return httpRequest(joinUrl(this.apiBaseUrl, route), this.#token, {
      method: options.method,
      fetchImpl: this.#fetch,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(options.noCache === undefined ? {} : { noCache: options.noCache }),
      ...(options.maxResponseBytes === undefined ? {} : { maxResponseBytes: options.maxResponseBytes }),
      ...(this.#authHeaders === undefined ? {} : { authHeaders: this.#authHeaders }),
      ...(this.#resolveAuthHeaders === undefined ? {} : { resolveAuthHeaders: this.#resolveAuthHeaders }),
      ...(options.json === undefined ? {} : { json: options.json }),
      ...(options.allowStatus === undefined ? {} : { allowStatus: options.allowStatus }),
      ...(options.notFoundCode === undefined ? {} : { notFoundCode: options.notFoundCode })
    });
  }
}
