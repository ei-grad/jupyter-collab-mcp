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
  type ResolvedServer,
  type ServerProfile
} from '../core/index.js';
import { deriveWsBaseUrl, normalizeBaseUrl } from '../jupyter/paths.js';

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

/** Profile plus its resolved credential, ready for `src/jupyter`. */
export function resolveServer(
  profile: ServerProfile,
  sources: CredentialSources = {}
): ResolvedServer {
  const apiBaseUrl = normalizeBaseUrl(profile.apiBaseUrl);
  const wsBaseUrl = normalizeBaseUrl(profile.wsBaseUrl ?? deriveWsBaseUrl(apiBaseUrl));
  return {
    profile,
    apiBaseUrl,
    wsBaseUrl,
    token: resolveCredential(profile.credentialRef, sources)
  };
}
