/**
 * Resolving a {@link CredentialRef} into the token the transport uses
 * (SPEC.md §11, docs/CONNECTIONS.md §9).
 *
 * A profile carries a *reference*, never the secret. The resolved value stays
 * inside the process: it goes into {@link ResolvedServer.token} and from there
 * into an `Authorization` header, and it must never reach a message, a log
 * line, a resource URI or a tool response.
 *
 * @module
 */

import { readFileSync } from 'node:fs';

import {
  coreError,
  type CredentialRef,
  type HubLifecycleConfig,
  type ResolvedServer,
  type ServerProfile
} from '../core/index.js';
import { assertionDeadline } from '../jupyter/auth-expiry.js';
import { deriveWsBaseUrl, validateBaseUrl } from '../jupyter/paths.js';

/** Everything the resolver may read; injected so tests need no real files. */
export interface CredentialSources {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly readFile?: (path: string) => string;
}

/**
 * Resolve one credential reference.
 *
 * @throws CoreError `INVALID_ARGUMENT` - the reference has no known scheme.
 * @throws CoreError `AUTH_REQUIRED` - the variable is unset or the file is
 * unreadable. Neither message repeats the value it failed to read.
 */
export function resolveCredential(ref: CredentialRef, sources: CredentialSources = {}): string {
  const env = sources.env ?? process.env;
  const read = sources.readFile ?? ((path: string) => readFileSync(path, 'utf8'));

  if (ref.startsWith('env:')) {
    const name = ref.slice('env:'.length);
    const value = env[name];
    if (value === undefined || value === '') {
      throw coreError('AUTH_REQUIRED', `environment variable ${name} holds no credential`, {
        details: { credential_ref: `env:${name}` }
      });
    }
    return value;
  }
  if (ref.startsWith('file:')) {
    const path = ref.slice('file:'.length);
    let text: string;
    try {
      text = read(path);
    } catch (error) {
      throw coreError('AUTH_REQUIRED', `credential file ${path} could not be read`, {
        details: { credential_ref: `file:${path}` },
        cause: error
      });
    }
    const value = text.replace(/\r?\n$/, '');
    if (value === '') {
      throw coreError('AUTH_REQUIRED', `credential file ${path} is empty`, {
        details: { credential_ref: `file:${path}` }
      });
    }
    return value;
  }
  if (ref.startsWith('literal:')) {
    // Tests and local development only; a config file that a tool argument
    // could influence must never carry one (src/core/types.ts).
    return ref.slice('literal:'.length);
  }
  throw coreError(
    'INVALID_ARGUMENT',
    'credential_ref must start with "env:", "file:" or "literal:"',
    { details: { scheme: ref.slice(0, Math.max(0, ref.indexOf(':'))) } }
  );
}

/** Validate and normalize every externally supplied URL on a server profile. */
export function validateServerProfile(
  profile: ServerProfile
): ServerProfile {
  const hub = hubConfig(profile);
  if (profile.kind !== 'standalone' && profile.kind !== 'jupyterhub') {
    throw coreError('INVALID_ARGUMENT', 'unknown server kind');
  }
  if (profile.apiBaseUrl === undefined && hub === undefined) {
    throw coreError('INVALID_ARGUMENT', 'an API base URL or Hub lifecycle configuration is required');
  }
  const apiBaseUrl = profile.apiBaseUrl === undefined ? undefined : validateBaseUrl(profile.apiBaseUrl, 'http', 'API base URL');
  const wsInput = profile.wsBaseUrl ?? (apiBaseUrl === undefined ? undefined : deriveWsBaseUrl(apiBaseUrl));
  const wsBaseUrl = wsInput === undefined ? undefined : validateBaseUrl(
    wsInput,
    'websocket',
    'WebSocket base URL'
  );
  const browserBaseUrl =
    profile.browserBaseUrl === undefined
      ? undefined
      : validateBaseUrl(profile.browserBaseUrl, 'http', 'browser base URL');
  return {
    ...profile,
    ...(apiBaseUrl === undefined ? {} : { apiBaseUrl }),
    ...(wsBaseUrl === undefined ? {} : { wsBaseUrl }),
    ...(profile.hub === undefined ? {} : { hub: hub! }),
    ...(browserBaseUrl === undefined ? {} : { browserBaseUrl })
  };
}

/** Legacy flat control fields remain accepted; the nested form separates auth. */
export function hubConfig(profile: ServerProfile): HubLifecycleConfig | undefined {
  if (profile.hub !== undefined && (profile.hubApiBaseUrl !== undefined || profile.hubCredentialRef !== undefined)) {
    throw coreError('INVALID_ARGUMENT', 'choose nested or flat Hub configuration');
  }
  const input = profile.hub ?? (profile.hubApiBaseUrl === undefined ? undefined : {
    apiBaseUrl: profile.hubApiBaseUrl,
    credentialRef: profile.hubCredentialRef ?? profile.credentialRef!
  });
  if (input === undefined) return undefined;
  if (profile.kind !== 'jupyterhub' || typeof input.credentialRef !== 'string') {
    throw coreError('INVALID_ARGUMENT', 'Hub lifecycle requires a jupyterhub profile and credential reference');
  }
  if (input.protocol !== undefined && input.protocol !== 'jupyterhub' && input.protocol !== 'adapter-v1') {
    throw coreError('INVALID_ARGUMENT', 'unsupported Hub lifecycle protocol');
  }
  const apiBaseUrl = validateBaseUrl(input.apiBaseUrl, 'http', 'Hub API base URL');
  if (input.protocol !== 'adapter-v1' && !new URL(apiBaseUrl).pathname.endsWith('/hub/api')) {
    throw coreError('INVALID_ARGUMENT', 'Hub API base URL must end in /hub/api');
  }
  if (profile.hubUser !== undefined && (typeof profile.hubUser !== 'string' || !profile.hubUser || /[/\\\0]/u.test(profile.hubUser))) {
    throw coreError('INVALID_ARGUMENT', 'invalid configured Hub user');
  }
  if (profile.hubServerName !== undefined && (typeof profile.hubServerName !== 'string' || /[/\\\0]/u.test(profile.hubServerName) || ['.', '..'].includes(profile.hubServerName))) {
    throw coreError('INVALID_ARGUMENT', 'invalid configured Hub server name');
  }
  if (input.protocol === 'adapter-v1' && profile.hubServerName) {
    throw coreError('UNSUPPORTED_OPERATION', 'this adapter manages the default server only');
  }
  return { ...input, apiBaseUrl };
}

/** Profile plus its resolved credential, ready for `src/jupyter`. */
export function resolveServer(
  profile: ServerProfile,
  sources: CredentialSources = {}
): ResolvedServer {
  const validated = validateServerProfile(profile);
  const apiBaseUrl = validated.apiBaseUrl;
  if (apiBaseUrl === undefined) throw coreError('NOT_READY', 'Hub data-plane URL has not been resolved');
  const wsBaseUrl = validated.wsBaseUrl ?? deriveWsBaseUrl(apiBaseUrl);
  const inherited = validated.credentialRef === undefined ? hubConfig(validated) : undefined;
  if (inherited !== undefined && new URL(inherited.apiBaseUrl).origin !== new URL(apiBaseUrl).origin) {
    throw coreError('INVALID_ARGUMENT', 'a different data-plane origin requires its own explicit credential');
  }
  const authentication = inherited ?? validated;
  const credentialRef = authentication.credentialRef;
  if (credentialRef === undefined) throw coreError('AUTH_REQUIRED', 'a data-plane credential reference is required');
  const auth = authentication.auth;
  if (auth !== undefined && (auth === null || !['token', 'header'].includes(auth.type))) {
    throw coreError('INVALID_ARGUMENT', 'unsupported authentication type');
  }
  if (auth?.type === 'header' &&
      (typeof auth.name !== 'string' || !/^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/.test(auth.name) ||
       /^(authorization|proxy-authorization|cookie|host|connection|upgrade|content-.*|transfer-encoding|sec-websocket-.*)$/i.test(auth.name))) {
    throw coreError('INVALID_ARGUMENT', 'invalid authentication header name');
  }
  if (authentication.credentialRefresh !== undefined &&
      (authentication.credentialRefresh !== 'request' || auth?.type !== 'header' ||
       !credentialRef.startsWith('file:'))) {
    throw coreError('INVALID_ARGUMENT', 'request credential refresh requires file header authentication');
  }
  if (authentication.credentialExpiry !== undefined &&
      (authentication.credentialExpiry !== 'jwt' || authentication.credentialRefresh !== 'request')) {
    throw coreError('INVALID_ARGUMENT', 'JWT credential expiry requires request credential refresh');
  }
  if (authentication.credentialExpiresAt !== undefined &&
      (!Number.isFinite(authentication.credentialExpiresAt) || authentication.credentialExpiry !== 'jwt')) {
    throw coreError('INVALID_ARGUMENT', 'credential deadline requires JWT credential expiry');
  }
  const readCredential = (): string => {
    const credential = resolveCredential(credentialRef, sources);
    if ((auth?.type === 'header' && !credential) || /[^\x20-\x7e]/.test(credential)) {
      throw coreError('AUTH_REQUIRED', 'credential is not a valid authentication header value');
    }
    if (authentication.credentialExpiry === 'jwt') assertionDeadline(credential, authentication.credentialExpiresAt);
    return credential;
  };
  const credential = readCredential();
  return {
    profile: { ...validated, ...authentication, apiBaseUrl },
    apiBaseUrl,
    wsBaseUrl,
    token: auth?.type === 'header' ? '' : credential,
    ...(auth?.type === 'header' ? { authHeaders: { [auth.name]: credential } } : {}),
    ...(authentication.credentialRefresh === 'request' && auth?.type === 'header'
      ? { resolveAuthHeaders: () => ({ [auth.name]: readCredential() }) } : {})
  };
}
