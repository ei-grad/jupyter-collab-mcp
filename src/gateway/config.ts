import { fileURLToPath } from 'node:url';

const PREFIX = 'JUPYTER_MCP_';

export type UsernameMode = 'email-localpart' | 'email-localpart-dashes';

export interface GatewayConfig {
  readonly publicUrl: URL;
  readonly oidcConfigUrl: URL;
  readonly oidcClientId: string;
  readonly oidcClientSecret: string;
  readonly redisUrl: URL;
  readonly storageKey: Uint8Array;
  readonly signingKey: string;
  readonly redirectUris: readonly string[];
  readonly usernameEmailDomain: string;
  readonly usernameMode: UsernameMode;
  readonly allowMissingEmailVerified: boolean;
  readonly refreshEnabled: boolean;
  readonly refreshGrantTtlSeconds: number;
  readonly allowedUsers: ReadonlySet<string>;
  readonly apiBaseUrl: URL;
  readonly browserBaseUrl: URL;
  readonly assertionHeader: string;
  readonly nodeCommand: string;
  readonly upstreamCli: string;
  readonly runtimeDir: string;
  readonly maxWorkers: number;
  readonly maxWorkersPerPrincipal: number;
  readonly requestTimeoutMs: number;
  readonly connectTimeoutMs: number;
  readonly expiryPollMs: number;
}

export type GatewayCommonConfig = Omit<GatewayConfig,
  'oidcConfigUrl' | 'oidcClientId' | 'oidcClientSecret' | 'redisUrl' |
  'storageKey' | 'signingKey' | 'redirectUris' | 'refreshEnabled' | 'refreshGrantTtlSeconds'>;

export interface CloudflareAccessConfig extends GatewayCommonConfig {
  readonly accessIssuer: string;
  readonly accessAudience: string;
  readonly sessionTtlSeconds: number;
  readonly sessionIdleSeconds: number;
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[`${PREFIX}${name}`];
  if (value === undefined || value === '') {
    throw new Error(`${PREFIX}${name} is required`);
  }
  return value;
}

function parseBoolean(env: NodeJS.ProcessEnv, name: string): boolean {
  const value = env[`${PREFIX}${name}`] ?? 'false';
  if (value !== 'true' && value !== 'false') throw new Error(`${PREFIX}${name} must be true or false`);
  return value === 'true';
}

function parseUrl(value: string, name: string): URL {
  try {
    return new URL(value);
  } catch {
    throw new Error(`${name} is not a valid URL`);
  }
}

function validatePublicUrl(value: string, name: string): URL {
  const url = parseUrl(value, name);
  if (
    url.protocol !== 'https:' ||
    url.hostname === '' ||
    url.username !== '' ||
    url.password !== '' ||
    url.search !== '' ||
    url.hash !== ''
  ) {
    throw new Error(`${name} requires an explicit HTTPS origin or path`);
  }
  return url;
}

function validateJupyterUrl(value: string, name: string): URL {
  const url = parseUrl(value, name);
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.hostname === '' ||
    url.username !== '' ||
    url.password !== '' ||
    url.search !== '' ||
    url.hash !== ''
  ) {
    throw new Error(`invalid operator ${name}`);
  }
  return url;
}

function validateRedisUrl(value: string): URL {
  const url = parseUrl(value, 'REDIS_URL');
  if (url.protocol === 'rediss:' && url.hostname !== '') return url;
  const database = url.searchParams.get('db');
  if (
    url.protocol === 'unix:' &&
    url.hostname === '' &&
    url.pathname.startsWith('/') &&
    url.username === '' &&
    url.password === '' &&
    url.hash === '' &&
    [...url.searchParams.keys()].every((name) => name === 'db') &&
    (database === null || /^(?:0|[1-9][0-9]*)$/.test(database))
  ) {
    return url;
  }
  throw new Error('REDIS_URL requires rediss or an absolute unix socket');
}

function decodeStorageKey(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]{43}=$/.test(value)) {
    throw new Error('STORAGE_KEY must be a URL-safe base64-encoded 32-byte key');
  }
  const decoded = Buffer.from(value.replaceAll('-', '+').replaceAll('_', '/'), 'base64');
  if (decoded.byteLength !== 32) {
    throw new Error('STORAGE_KEY must be a URL-safe base64-encoded 32-byte key');
  }
  return new Uint8Array(decoded);
}

function parsePositiveNumber(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  integer: boolean
): number {
  const raw = env[`${PREFIX}${name}`];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0 || (integer && !Number.isSafeInteger(value))) {
    throw new Error(`${PREFIX}${name} must be a positive ${integer ? 'integer' : 'number'}`);
  }
  return value;
}

function hasUnsafePathEncoding(pathname: string): boolean {
  return /%(?:2e|2f|5c|00)/i.test(pathname);
}

function validateRedirectPattern(value: string): string {
  if (hasUnsafePathEncoding(value)) throw new Error('OAuth redirect pattern has unsafe path encoding');
  const wildcardCount = [...value].filter((character) => character === '*').length;
  const candidate = value.replace('*', '49152');
  const url = parseUrl(candidate, 'REDIRECT_URIS');
  const loopback = url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (
    url.hostname === '' ||
    url.username !== '' ||
    url.password !== '' ||
    url.search !== '' ||
    url.hash !== '' ||
    (!loopback && url.protocol !== 'https:')
  ) {
    throw new Error('OAuth redirect pattern must name an explicit HTTPS or loopback host');
  }
  if (wildcardCount > 0) {
    const loopbackPort = wildcardCount === 1 && loopback && value.endsWith(':*');
    const boundedHttpsPath =
      wildcardCount === 1 &&
      url.protocol === 'https:' &&
      value.endsWith('/*') &&
      new URL(value.slice(0, -1)).pathname !== '/';
    if (!loopbackPort && !boundedHttpsPath) {
      throw new Error('OAuth wildcard must be a loopback port or bounded callback path');
    }
  }
  if (!loopback && (url.pathname === '' || url.pathname === '/')) {
    throw new Error('OAuth callback requires an explicit path');
  }
  return value;
}

export function isRedirectAllowed(value: string, patterns: readonly string[]): boolean {
  if (hasUnsafePathEncoding(value)) return false;
  let actual: URL;
  try {
    actual = new URL(value);
  } catch {
    return false;
  }
  if (
    actual.username !== '' ||
    actual.password !== '' ||
    actual.search !== '' ||
    actual.hash !== ''
  ) {
    return false;
  }
  for (const pattern of patterns) {
    const wildcard = pattern.indexOf('*');
    if (wildcard === -1) {
      if (actual.href === new URL(pattern).href) return true;
      continue;
    }
    if (pattern.endsWith(':*')) {
      const expected = new URL(pattern.slice(0, -1) + '49152');
      if (
        actual.protocol === 'http:' &&
        actual.hostname === expected.hostname &&
        actual.port !== ''
      ) {
        return true;
      }
      continue;
    }
    const expected = new URL(pattern.slice(0, -1) + 'placeholder');
    const prefix = expected.pathname.slice(0, -'placeholder'.length);
    if (
      actual.protocol === 'https:' &&
      actual.origin === expected.origin &&
      actual.pathname.startsWith(prefix) &&
      actual.pathname.length > prefix.length
    ) {
      return true;
    }
  }
  return false;
}

export function validateAssertionHeader(name: string): string {
  if (
    !/^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/.test(name) ||
    /^(authorization|proxy-authorization|cookie|host|connection|upgrade|content-.*|transfer-encoding|sec-websocket-.*)$/i.test(name)
  ) {
    throw new Error('invalid assertion header');
  }
  return name;
}

function loadCommonConfig(env: NodeJS.ProcessEnv): GatewayCommonConfig {
  const usernameEmailDomain = required(env, 'USERNAME_EMAIL_DOMAIN');
  if (!/^[a-z0-9.-]+$/.test(usernameEmailDomain)) {
    throw new Error('an explicit lowercase email domain is required');
  }
  const usernameMode = env[`${PREFIX}USERNAME_MODE`] ?? 'email-localpart';
  if (usernameMode !== 'email-localpart' && usernameMode !== 'email-localpart-dashes') {
    throw new Error('unsupported username mapping mode');
  }
  const allowedUsers = new Set(required(env, 'ALLOWED_USERS').split(/\s+/).filter(Boolean));
  if (
    allowedUsers.size === 0 ||
    [...allowedUsers].some((user) => !/^[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(user))
  ) {
    throw new Error('explicit provisioned Hub user names are required');
  }
  const apiBaseUrl = validateJupyterUrl(required(env, 'API_BASE_URL'), 'API_BASE_URL');
  const sourceRuntime = fileURLToPath(import.meta.url).endsWith('.ts');

  return Object.freeze({
    publicUrl: validatePublicUrl(required(env, 'PUBLIC_URL'), 'PUBLIC_URL'),
    usernameEmailDomain,
    usernameMode,
    allowMissingEmailVerified: parseBoolean(env, 'ALLOW_MISSING_EMAIL_VERIFIED'),
    allowedUsers,
    apiBaseUrl,
    browserBaseUrl: validateJupyterUrl(
      env[`${PREFIX}BROWSER_BASE_URL`] ?? apiBaseUrl.href,
      'BROWSER_BASE_URL'
    ),
    assertionHeader: validateAssertionHeader(
      env[`${PREFIX}ASSERTION_HEADER`] ?? 'X-Jupyter-Access-Token'
    ),
    nodeCommand:
      env[`${PREFIX}NODE_COMMAND`] ??
      (sourceRuntime
        ? fileURLToPath(new URL('../../node_modules/.bin/tsx', import.meta.url))
        : process.execPath),
    upstreamCli:
      env[`${PREFIX}UPSTREAM_CLI`] ??
      fileURLToPath(new URL(sourceRuntime ? '../mcp/cli.ts' : '../mcp/cli.js', import.meta.url)),
    runtimeDir: env[`${PREFIX}RUNTIME_DIR`] ?? '/run/mcp',
    maxWorkers: parsePositiveNumber(env, 'MAX_WORKERS', 16, true),
    maxWorkersPerPrincipal: parsePositiveNumber(env, 'MAX_WORKERS_PER_PRINCIPAL', 4, true),
    requestTimeoutMs: parsePositiveNumber(env, 'REQUEST_TIMEOUT', 120, false) * 1000,
    connectTimeoutMs: parsePositiveNumber(env, 'CONNECT_TIMEOUT', 10, false) * 1000,
    expiryPollMs: parsePositiveNumber(env, 'EXPIRY_POLL_SECONDS', 5, false) * 1000
  });
}

export function loadGatewayConfig(env: NodeJS.ProcessEnv = process.env): GatewayConfig {
  const common = loadCommonConfig(env);
  const signingKey = required(env, 'SIGNING_KEY');
  if (signingKey.length < 32) throw new Error('SIGNING_KEY requires at least 32 characters');
  const redirectUris = required(env, 'REDIRECT_URIS').split(/\s+/).filter(Boolean).map(validateRedirectPattern);
  if (redirectUris.length === 0) throw new Error('explicit OAuth redirect URIs are required');
  return Object.freeze({
    ...common,
    oidcConfigUrl: validatePublicUrl(required(env, 'OIDC_CONFIG_URL'), 'OIDC_CONFIG_URL'),
    oidcClientId: required(env, 'OIDC_CLIENT_ID'),
    oidcClientSecret: required(env, 'OIDC_CLIENT_SECRET'),
    redisUrl: validateRedisUrl(required(env, 'REDIS_URL')),
    storageKey: decodeStorageKey(required(env, 'STORAGE_KEY')),
    signingKey,
    redirectUris: Object.freeze(redirectUris),
    refreshEnabled: parseBoolean(env, 'ENABLE_REFRESH'),
    refreshGrantTtlSeconds: parsePositiveNumber(env, 'REFRESH_GRANT_TTL_SECONDS', 8 * 60 * 60, true)
  });
}

export function loadCloudflareAccessConfig(env: NodeJS.ProcessEnv = process.env): CloudflareAccessConfig {
  const issuer = validatePublicUrl(required(env, 'ACCESS_ISSUER'), 'ACCESS_ISSUER');
  if (issuer.pathname !== '/' || !/^[a-z0-9-]+\.cloudflareaccess\.com$/.test(issuer.hostname)) {
    throw new Error('ACCESS_ISSUER must be a Cloudflare Access team origin');
  }
  const sessionTtlSeconds = parsePositiveNumber(env, 'ACCESS_SESSION_TTL_SECONDS', 8 * 60 * 60, true);
  if (sessionTtlSeconds > Math.floor((2 ** 31 - 1) / 1000)) {
    throw new Error('ACCESS_SESSION_TTL_SECONDS exceeds the supported timer duration');
  }
  return Object.freeze({
    ...loadCommonConfig(env),
    accessIssuer: issuer.origin,
    accessAudience: required(env, 'ACCESS_AUDIENCE'),
    sessionTtlSeconds,
    sessionIdleSeconds: parsePositiveNumber(env, 'ACCESS_SESSION_IDLE_SECONDS', 15 * 60, true)
  });
}
