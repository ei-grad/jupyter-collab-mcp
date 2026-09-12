/**
 * Minimal authenticated fetch for the Jupyter REST API in integration tests.
 *
 * Two things it exists for:
 *
 * 1. The `Authorization: token <TOKEN>` header, so the token never has to go
 *    into a query string (SPEC.md §11 allows the query form only where the
 *    protocol leaves no choice, i.e. WebSockets).
 * 2. Reading the body **once**. A `Response` body is single-use, so the
 *    familiar `assert(res.ok, await res.text())` pattern makes a later
 *    `res.json()` throw `TypeError: Body is unusable` (spike/NOTES.md §3.12).
 *    {@link apiFetch} reads the text eagerly and hands back a plain object.
 */

export interface ApiTarget {
  /** Base URL with no trailing slash, e.g. `http://127.0.0.1:8893`. */
  readonly baseUrl: string;
  readonly token: string;
}

export interface ApiResponse {
  readonly status: number;
  readonly ok: boolean;
  readonly headers: Headers;
  /** Body, already read. Empty string when there was none. */
  readonly text: string;
  /** Parse {@link text} as JSON. Throws with the raw body on malformed JSON. */
  json<T = unknown>(): T;
}

/**
 * `fetch` against `target.baseUrl + route` with the auth header set.
 *
 * `route` must start with `/`. A JSON body is sent by passing `json`; do not
 * set `body` and `json` at the same time.
 */
export async function apiFetch(
  target: ApiTarget,
  route: string,
  init: RequestInit & { readonly json?: unknown } = {}
): Promise<ApiResponse> {
  const { json, ...rest } = init;
  const headers = new Headers(rest.headers);
  headers.set('Authorization', `token ${target.token}`);

  const requestInit: RequestInit = { ...rest, headers };
  if (json !== undefined) {
    headers.set('Content-Type', 'application/json');
    requestInit.body = JSON.stringify(json);
  }

  const response = await fetch(`${target.baseUrl}${route}`, requestInit);
  const text = await response.text();

  return {
    status: response.status,
    ok: response.ok,
    headers: response.headers,
    text,
    json<T = unknown>(): T {
      try {
        return JSON.parse(text) as T;
      } catch (error) {
        throw new Error(
          `expected JSON from ${route} (status ${response.status}), got: ${text.slice(0, 500)}`,
          { cause: error }
        );
      }
    }
  };
}

/** `apiFetch` that throws unless the status is in `expected` (default: 2xx). */
export async function apiFetchOk(
  target: ApiTarget,
  route: string,
  init: RequestInit & { readonly json?: unknown } = {},
  expected?: readonly number[]
): Promise<ApiResponse> {
  const response = await apiFetch(target, route, init);
  const accepted =
    expected === undefined ? response.ok : expected.includes(response.status);
  if (!accepted) {
    throw new Error(
      `${init.method ?? 'GET'} ${route} -> ${response.status}: ${response.text.slice(0, 500)}`
    );
  }
  return response;
}
