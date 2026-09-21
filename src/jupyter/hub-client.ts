import { coreError, canonicalJson, isCoreError, type ResolvedServer, type JsonValue, type ServerProfile, type ServerStartProfile, type ServerStatusResult, type HubLifecycleConfig } from '../core/index.js';
import { httpRequest, parseJsonBody, type HttpRequestOptions } from './http.js';
import { validateBaseUrl } from './paths.js';

type Model = Record<string, unknown>;

function object(value: unknown): value is Model {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function invalid(): never {
  throw coreError('NETWORK_ERROR', 'Hub returned an invalid lifecycle response', { retryable: false });
}

/** Matches JupyterHub's quote(value, safe='@~') for a single URL segment. */
function hubSegment(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/gu, (character) =>
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`).replace(/%40/gu, '@');
}

/** Canonicalize individual segments without letting escapes create separators. */
function ownRoute(pathname: string): string {
  try {
    return pathname.replace(/\/$/u, '').split('/').map((segment) => {
      const decoded = decodeURIComponent(segment);
      if (/[/\\\0]/u.test(decoded) || decoded === '.' || decoded === '..') return invalid();
      return hubSegment(decoded);
    }).join('/');
  } catch { return invalid(); }
}

/** Missing model entries can mean either absent servers or scope filtering. */
function canReadAbsentServer(user: Model, name: string): boolean {
  if (!Array.isArray(user.scopes) || typeof user.name !== 'string') return false;
  const groups = Array.isArray(user.groups) ? user.groups.filter((group): group is string => typeof group === 'string') : [];
  return user.scopes.some((scope: unknown) => typeof scope === 'string' && (
    scope === 'read:servers' || scope === `read:servers!user=${user.name}` ||
    scope === `read:servers!server=${user.name}/${name}` ||
    groups.some((group) => scope === `read:servers!group=${group}`)
  ));
}

export function startProfiles(value: unknown): readonly ServerStartProfile[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 256) return invalid();
  const ids = new Set<string>();
  return value.map((raw: unknown) => {
    if (!object(raw) || typeof raw.id !== 'string' || !raw.id || typeof raw.title !== 'string' ||
        !object(raw.user_options ?? raw.userOptions) || ids.has(raw.id)) return invalid();
    ids.add(raw.id);
    return {
      id: raw.id, title: raw.title,
      ...(typeof raw.description === 'string' ? { description: raw.description } : {}),
      ...(typeof raw.default === 'boolean' ? { default: raw.default } : {}),
      userOptions: (raw.user_options ?? raw.userOptions) as Model
    };
  });
}

/** Compare the explicit requested options, allowing Hub-added defaults. */
export function optionsMatch(actual: Readonly<Model> | undefined, requested: Readonly<Model> | undefined): boolean {
  if (requested === undefined) return true;
  if (actual === undefined) return false;
  if (Object.keys(requested).length === 0) return true;
  return Object.entries(requested).every(([key, value]) => Object.hasOwn(actual, key) &&
    canonicalJson(actual[key] as JsonValue) === canonicalJson(value as JsonValue));
}

/** Only this client sends Hub control requests. There is deliberately no stop method. */
export class HubClient {
  readonly #profile: ServerProfile;
  readonly #config: HubLifecycleConfig;
  readonly #fetch: typeof fetch;
  readonly #resolveAuth: () => ResolvedServer;
  #user: string | undefined;
  #dataUrl: string | undefined;
  #major: number | undefined;

  constructor(profile: ServerProfile, config: HubLifecycleConfig, resolveAuth: () => ResolvedServer, fetchImpl: typeof fetch = fetch) {
    this.#profile = profile;
    this.#config = config;
    this.#fetch = fetchImpl;
    this.#resolveAuth = resolveAuth;
    this.#user = profile.hubUser;
  }

  get dataUrl(): string | undefined { return this.#dataUrl; }

  #auth(): Pick<HttpRequestOptions, 'authHeaders' | 'resolveAuthHeaders'> & { token: string } {
    const resolved = this.#resolveAuth();
    return {
      token: resolved.token,
      ...(resolved.authHeaders === undefined ? {} : { authHeaders: resolved.authHeaders }),
      ...(resolved.resolveAuthHeaders === undefined ? {} : { resolveAuthHeaders: resolved.resolveAuthHeaders })
    };
  }

  async #request(route: string, options: HttpRequestOptions = {}) {
    const { token, ...authentication } = this.#auth();
    try {
      return await httpRequest(`${this.#config.apiBaseUrl}${route}`, token, {
        ...options, ...authentication, fetchImpl: this.#fetch, maxRedirects: 0,
        signal: options.signal ?? AbortSignal.timeout(30_000), notFoundCode: 'SERVER_NOT_FOUND'
      });
    } catch (error) {
      if (options.method === 'POST' && isCoreError(error) && error.code === 'NETWORK_ERROR') {
        throw coreError('OPERATION_UNCERTAIN', 'Hub start response could not be verified; inspect server_status');
      }
      throw error;
    }
  }

  #bindIdentity(user: unknown, serverName: unknown, returnedUrl?: unknown): void {
    if (typeof user !== 'string' || !user || /[/\\\0]/u.test(user) || ['.', '..'].includes(user)) return invalid();
    if (this.#user !== undefined && this.#user !== user) {
      throw coreError('PERMISSION_DENIED', 'Hub identity does not match the configured principal');
    }
    if (serverName !== (this.#profile.hubServerName ?? '')) return invalid();
    this.#user = user;
    const hub = new URL(this.#config.apiBaseUrl);
    const marker = hub.pathname.lastIndexOf('/hub/api');
    if (marker < 0) throw coreError('INVALID_ARGUMENT', 'Hub URL must contain its /hub/api deployment prefix');
    const expectedPath = `${hub.pathname.slice(0, marker)}/user/${hubSegment(user)}${serverName ? `/${hubSegment(String(serverName))}` : ''}`;
    const fallback = `${hub.origin}${expectedPath}`;
    let dataUrl = fallback;
    if (returnedUrl !== undefined && returnedUrl !== null) {
      if (typeof returnedUrl !== 'string') return invalid();
      let returned: string;
      try { returned = validateBaseUrl(new URL(returnedUrl, `${hub.origin}/`).href, 'http'); }
      catch { return invalid(); }
      const parsed = new URL(returned);
      if (parsed.origin !== hub.origin || ownRoute(parsed.pathname) !== ownRoute(expectedPath)) {
        throw coreError('PERMISSION_DENIED', 'Hub server URL does not match the verified own-user route');
      }
      dataUrl = returned;
    }
    this.#dataUrl = this.#profile.apiBaseUrl ?? dataUrl;
  }

  async status(signal?: AbortSignal): Promise<ServerStatusResult> {
    const requestOptions = signal === undefined ? {} : { signal };
    if (this.#config.protocol === 'adapter-v1') {
      const model: unknown = parseJsonBody(await this.#request('', requestOptions), 'Hub lifecycle');
      if (!object(model) || !['ready', 'stopped', 'starting', 'stopping', 'failed', 'unknown'].includes(String(model.state))) return invalid();
      this.#bindIdentity(model.user, model.server_name, model.server_url);
      if (!object(model.user_options) || !object(model.start_options)) return invalid();
      return {
        serverId: this.#profile.id, state: model.state as ServerStatusResult['state'], supportsStart: true,
        hubUser: this.#user!, hubServerName: '', userOptions: model.user_options,
        startOptions: { profiles: startProfiles(model.start_options.profiles) }
      };
    }
    const user: unknown = parseJsonBody(await this.#request('/user?include_stopped_servers=1', requestOptions), 'Hub user');
    if (!object(user) || user.kind !== 'user' || !object(user.servers)) {
      throw coreError('PERMISSION_DENIED', 'Hub token must identify a user and allow reading its server model');
    }
    const name = this.#profile.hubServerName ?? '';
    const raw = user.servers[name];
    if (raw !== undefined && !object(raw)) return invalid();
    const model = raw as Model | undefined;
    this.#bindIdentity(user.name, name, model?.url);
    if (model === undefined && !canReadAbsentServer(user, name)) {
      throw coreError('PERMISSION_DENIED', 'Hub token does not establish read access to the selected server');
    }
    let state: ServerStatusResult['state'] = model === undefined || model.stopped === true ? 'stopped'
      : model.pending === 'spawn' ? 'starting' : model.pending === 'stop' ? 'stopping'
        : model.ready === true ? 'ready' : 'unknown';
    if (model?.pending === 'spawn') state = 'starting';
    if (model?.pending === 'stop') state = 'stopping';
    if (state === 'stopped' && model !== undefined && await this.#failedProgress(signal)) state = 'failed';
    return {
      serverId: this.#profile.id, state, supportsStart: true, hubUser: this.#user!, hubServerName: name,
      ...(object(model?.user_options) ? { userOptions: model.user_options } : {}),
      startOptions: { profiles: startProfiles(this.#config.startProfiles) }
    };
  }

  #route(): string {
    if (this.#user === undefined) throw coreError('NOT_READY', 'Hub identity has not been verified');
    const name = this.#profile.hubServerName;
    return `/users/${hubSegment(this.#user)}${name ? `/servers/${hubSegment(name)}` : '/server'}`;
  }

  async #failedProgress(outerSignal?: AbortSignal): Promise<boolean> {
    // A stopped model alone cannot distinguish a failed spawn. The completed
    // progress stream can; never wait indefinitely or reuse its returned URL.
    const { token, ...auth } = this.#auth();
    const headers = auth.resolveAuthHeaders?.() ?? auth.authHeaders ?? { Authorization: `token ${token}` };
    const timeout = AbortSignal.timeout(1000);
    const signal = outerSignal === undefined ? timeout : AbortSignal.any([timeout, outerSignal]);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const response = await this.#fetch(`${this.#config.apiBaseUrl}${this.#route()}/progress`, { headers, redirect: 'error', signal });
      if (!response.ok || response.body === null) return false;
      reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      while (buffer.length < 64 * 1024) {
        const part = await reader.read();
        if (part.done) break;
        buffer += decoder.decode(part.value, { stream: true });
        for (const line of buffer.split('\n')) {
          if (!line.startsWith('data:')) continue;
          try { if ((JSON.parse(line.slice(5)) as Model).failed === true) return true; }
          catch { /* A partial SSE line is completed by the next chunk. */ }
        }
      }
      return false;
    } catch { return false; }
    finally { await reader?.cancel().catch(() => undefined); }
  }

  async start(options: Readonly<Model> | undefined): Promise<ServerStatusResult> {
    const current = await this.status();
    if (current.state === 'ready' || current.state === 'starting') {
      if (!optionsMatch(current.userOptions, options)) throw coreError('SERVER_OPTIONS_CONFLICT', 'the existing server uses different or unknown start options');
      return current;
    }
    if (current.state === 'stopping' || current.state === 'unknown') throw coreError('NOT_READY', 'server lifecycle is not ready for a start request');
    if (this.#config.protocol !== 'adapter-v1' && this.#major === undefined) {
      const info: unknown = parseJsonBody(await this.#request(''), 'Hub API version');
      if (!object(info) || typeof info.version !== 'string' || !/^[56]\./u.test(info.version)) {
        throw coreError('UNSUPPORTED_OPERATION', 'Hub lifecycle supports JupyterHub 5 and 6');
      }
      this.#major = Number(info.version.split('.')[0]);
    }
    const adapter = this.#config.protocol === 'adapter-v1';
    const body = options === undefined ? undefined : adapter || this.#major === 6 ? { user_options: options } : options;
    const response = await this.#request(adapter ? '' : this.#route(), {
      method: 'POST', ...(body === undefined ? {} : { json: body }), allowStatus: [400, 409]
    });
    if (response.status === 400 || response.status === 409) {
      const observed = await this.status();
      if ((observed.state === 'ready' || observed.state === 'starting') && optionsMatch(observed.userOptions, options)) return observed;
      if (response.status === 409 || observed.state === 'ready' || observed.state === 'starting') {
        throw coreError('SERVER_OPTIONS_CONFLICT', 'server state or start options conflict with this request');
      }
      throw coreError('INVALID_ARGUMENT', 'Hub rejected the start options or server state');
    }
    try {
      const observed = await this.status();
      if ((observed.state === 'ready' || observed.state === 'starting') && !optionsMatch(observed.userOptions, options)) {
        throw coreError('SERVER_OPTIONS_CONFLICT', 'another start selected different options', { sideEffects: 'unknown' });
      }
      return observed;
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'SERVER_OPTIONS_CONFLICT') throw error;
      throw coreError('OPERATION_UNCERTAIN', 'Hub accepted the start but its resulting state could not be read');
    }
  }
}
