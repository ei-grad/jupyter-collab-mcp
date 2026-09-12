/**
 * Authenticated HTTP against one Jupyter Server (SPEC.md §6, §9, §11).
 *
 * Rules encoded here:
 *   - the token travels in the `Authorization: token …` header, never in a
 *     query string and never in an error message (SPEC.md §11);
 *   - the body is read exactly once - `await res.text()` inside an assertion
 *     makes a later `res.json()` throw `Body is unusable`
 *     (spike/NOTES.md §3.12);
 *   - redirects are followed manually and only within the same origin, so a
 *     redirect can never move credentials to another host (SPEC.md §11);
 *   - HTTP status is mapped onto the SPEC.md §9 error table, with 5xx and
 *     transport failures distinguishing safe from mutating methods.
 *
 * @module
 */

import { coreError, redactCredentials, type ErrorCode } from '../core/index.js';
import { isSameOrigin } from './paths.js';

/** One already-read HTTP response. */
export interface HttpResponse {
  readonly status: number;
  readonly ok: boolean;
  readonly headers: Headers;
  /** Body text; `''` when there was none. */
  readonly text: string;
}

/** Options of {@link httpRequest}. */
export interface HttpRequestOptions {
  readonly method?: string;
  /** Serialised as JSON with `Content-Type: application/json`. */
  readonly json?: unknown;
  /** Error code used for a 404. Defaults to `NOTEBOOK_NOT_FOUND`. */
  readonly notFoundCode?: ErrorCode;
  /** Statuses that must not be turned into an error (e.g. `[404]`). */
  readonly allowStatus?: readonly number[];
  readonly signal?: AbortSignal;
  /** Injected in tests; defaults to the global `fetch`. */
  readonly fetchImpl?: typeof fetch;
  /** Maximum same-origin redirects to follow. Default 5. */
  readonly maxRedirects?: number;
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** HTTP methods that may have changed server state if they failed midway. */
export function isSafeMethod(method: string): boolean {
  return SAFE_METHODS.has(method.toUpperCase());
}

/**
 * Map an HTTP status onto the SPEC.md §9 error table.
 *
 * `route` is included for diagnostics; it never carries the token, and is run
 * through {@link redactCredentials} anyway.
 */
export function mapHttpStatus(
  status: number,
  method: string,
  route: string,
  bodyText: string,
  notFoundCode: ErrorCode = 'NOTEBOOK_NOT_FOUND'
): ReturnType<typeof coreError> {
  const safe = isSafeMethod(method);
  const where = `${method.toUpperCase()} ${redactCredentials(route)}`;
  const details = {
    status,
    route: redactCredentials(route),
    method: method.toUpperCase(),
    // Server error pages can be long; the first line is the useful part.
    body: redactCredentials(bodyText).slice(0, 500)
  };

  if (status === 400) {
    return coreError('INVALID_ARGUMENT', `${where} rejected the request (400)`, { details });
  }
  if (status === 401) {
    return coreError('AUTH_REQUIRED', `${where} requires authentication (401)`, { details });
  }
  if (status === 403) {
    return coreError('PERMISSION_DENIED', `${where} is not permitted (403)`, { details });
  }
  if (status === 404) {
    return coreError(notFoundCode, `${where} not found (404)`, { details });
  }
  if (status === 409) {
    return coreError('ALREADY_EXISTS', `${where} conflicts with an existing file (409)`, {
      details
    });
  }
  if (status === 413) {
    return coreError('DOCUMENT_TOO_LARGE', `${where} payload is too large (413)`, { details });
  }
  if (status >= 500) {
    // A 5xx on a mutating call is not proof that nothing happened: the write
    // may have been applied before the failure (SPEC.md §9 OPERATION_UNCERTAIN).
    return safe
      ? coreError('INTERNAL_ERROR', `${where} failed with ${status}`, {
          sideEffects: 'none',
          details
        })
      : coreError('OPERATION_UNCERTAIN', `${where} failed with ${status}; effect unknown`, {
          details
        });
  }
  return coreError('INTERNAL_ERROR', `${where} returned an unexpected ${status}`, {
    sideEffects: safe ? 'none' : 'unknown',
    details
  });
}

/** Map a transport-level failure (`fetch` rejection) onto SPEC.md §9. */
export function mapTransportError(
  error: unknown,
  method: string,
  route: string
): ReturnType<typeof coreError> {
  const where = `${method.toUpperCase()} ${redactCredentials(route)}`;
  const reason = error instanceof Error ? redactCredentials(error.message) : 'transport failure';
  if (isSafeMethod(method)) {
    return coreError('NETWORK_ERROR', `${where} failed: ${reason}`, {
      details: { route: redactCredentials(route), method: method.toUpperCase() },
      cause: error
    });
  }
  return coreError('OPERATION_UNCERTAIN', `${where} failed: ${reason}; effect unknown`, {
    details: { route: redactCredentials(route), method: method.toUpperCase() },
    cause: error
  });
}

/**
 * Perform one authenticated request and read its body.
 *
 * @throws {@link CoreError} for a transport failure, a cross-origin redirect
 * or a status that is neither 2xx nor listed in `allowStatus`.
 */
export async function httpRequest(
  url: string,
  token: string,
  options: HttpRequestOptions = {}
): Promise<HttpResponse> {
  const method = (options.method ?? 'GET').toUpperCase();
  const fetchImpl = options.fetchImpl ?? fetch;
  const maxRedirects = options.maxRedirects ?? 5;
  const body = options.json === undefined ? undefined : JSON.stringify(options.json);

  let current = url;
  let response: Response;
  for (let hop = 0; ; hop += 1) {
    const headers = new Headers();
    headers.set('Authorization', `token ${token}`);
    if (body !== undefined) headers.set('Content-Type', 'application/json');

    const init: RequestInit = { method, headers, redirect: 'manual' };
    if (body !== undefined) init.body = body;
    if (options.signal !== undefined) init.signal = options.signal;

    try {
      response = await fetchImpl(current, init);
    } catch (error) {
      throw mapTransportError(error, method, current);
    }

    const location = response.headers.get('location');
    const isRedirect = response.status >= 300 && response.status < 400 && location !== null;
    if (!isRedirect) break;

    // Read (and discard) the body so the connection can be reused.
    await response.text();
    const target = new URL(location, current).toString();
    if (!isSameOrigin(target, current)) {
      // SPEC.md §11: credentials are never carried to another origin, and a
      // browser-style redirect does not widen that permission.
      throw coreError(
        'NETWORK_ERROR',
        `${method} ${redactCredentials(current)} redirected to a different origin; ` +
          'credentials are not forwarded',
        {
          retryable: false,
          details: { from: redactCredentials(current), to: new URL(target).origin }
        }
      );
    }
    if (hop >= maxRedirects) {
      throw coreError('NETWORK_ERROR', `${method} ${redactCredentials(url)} redirected too often`, {
        retryable: false
      });
    }
    current = target;
  }

  let text: string;
  try {
    text = await response.text();
  } catch (error) {
    throw mapTransportError(error, method, current);
  }

  const allowed = options.allowStatus ?? [];
  if (!response.ok && !allowed.includes(response.status)) {
    throw mapHttpStatus(response.status, method, current, text, options.notFoundCode);
  }

  return { status: response.status, ok: response.ok, headers: response.headers, text };
}

/**
 * Parse a body that must be JSON, without leaking it into the message.
 *
 * The body excerpt is redacted exactly like {@link mapHttpStatus} does it: a
 * 2xx with a non-JSON body is what a login page or an authenticating proxy in
 * front of Jupyter returns, and such a page carries `?token=` in its links
 * (SPEC.md §11).
 */
export function parseJsonBody<T>(response: HttpResponse, route: string): T {
  try {
    return JSON.parse(response.text) as T;
  } catch (error) {
    throw coreError(
      'INTERNAL_ERROR',
      `${redactCredentials(route)} returned a non-JSON body (status ${response.status})`,
      {
        sideEffects: 'none',
        details: { body: redactCredentials(response.text).slice(0, 200) },
        cause: error
      }
    );
  }
}
