/**
 * URL and path encoding for the Jupyter REST and collaboration APIs
 * (SPEC.md §6, §11).
 *
 * Two encodings are deliberately different and must not be merged:
 *
 *   - **Contents API** — the path is a sequence of URL segments, so each
 *     segment is `encodeURIComponent`-ed and joined with a literal `/`.
 *   - **Collaboration session** — jupyter-collaboration's `requests.ts` builds
 *     `api/collaboration/session/<encodeURIComponent(path)>`, i.e. the whole
 *     path is one component and `/` becomes `%2F`. Tornado's `(.*)` route
 *     unescapes it back (spike/NOTES.md §1.2).
 *   - **Room name** — `json:notebook:<fileId>` must stay *unencoded*. The
 *     server takes `request.path.split('/')[-1]` from the raw path, so a
 *     `%3A`-escaped name opens a different, empty room with no error at all
 *     (spike/NOTES.md §1.3).
 *
 * @module
 */

import { coreError } from '../core/index.js';

/** Room format used for notebooks. */
export const ROOM_FORMAT = 'json';
/** Room document type used for notebooks. */
export const ROOM_TYPE = 'notebook';

/**
 * Normalise a Contents path relative to the Jupyter root (SPEC.md §11).
 *
 * Strips leading/trailing and repeated `/`, drops `.` segments and rejects
 * anything that could escape the root. Returns `''` for the root directory.
 *
 * @throws {@link CoreError} `INVALID_ARGUMENT` on `..`, backslashes, NUL or a
 * Windows-style drive prefix.
 */
export function normalizeContentsPath(input: string): string {
  if (input.includes('\0')) {
    throw coreError('INVALID_ARGUMENT', 'path contains a NUL byte');
  }
  if (input.includes('\\')) {
    throw coreError('INVALID_ARGUMENT', 'path contains a backslash; use "/" separators');
  }
  if (/^[a-zA-Z]:/.test(input)) {
    throw coreError('INVALID_ARGUMENT', 'path looks like a local drive path, not a Jupyter path');
  }
  const segments: string[] = [];
  for (const segment of input.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      throw coreError('INVALID_ARGUMENT', 'path escapes the Jupyter root ("..")');
    }
    segments.push(segment);
  }
  return segments.join('/');
}

/**
 * Single file name inside a directory, as accepted by `notebook_create.name`
 * (SPEC.md §6): exactly one `.ipynb` name, no separators.
 *
 * @throws {@link CoreError} `INVALID_ARGUMENT`.
 */
export function validateNotebookName(name: string): string {
  if (name.length === 0) throw coreError('INVALID_ARGUMENT', 'name is empty');
  if (/[/\\\0]/.test(name)) {
    throw coreError('INVALID_ARGUMENT', 'name must not contain path separators');
  }
  if (name === '.' || name === '..') throw coreError('INVALID_ARGUMENT', 'name is not a file name');
  if (!name.endsWith('.ipynb')) {
    throw coreError('INVALID_ARGUMENT', 'name must end with ".ipynb"');
  }
  return name;
}

/** Contents-API encoding: per segment, joined with `/` (SPEC.md §6). */
export function encodeContentsPath(path: string): string {
  const normalized = normalizeContentsPath(path);
  if (normalized === '') return '';
  return normalized.split('/').map(encodeURIComponent).join('/');
}

/**
 * Collaboration-session encoding: the whole path as one component, so `/`
 * becomes `%2F` (jupyter-collaboration `requests.ts`, spike/NOTES.md §1.2).
 */
export function encodeSessionPath(path: string): string {
  return encodeURIComponent(normalizeContentsPath(path));
}

/**
 * Room name `<format>:<type>:<fileId>` (SPEC.md §6 item 4).
 *
 * Returned raw on purpose: y-websocket concatenates it into the URL without
 * encoding, and it must stay that way.
 */
export function roomName(fileId: string, format = ROOM_FORMAT, type = ROOM_TYPE): string {
  return `${format}:${type}:${fileId}`;
}

/** Drop trailing slashes; keep any `/user/name` prefix (SPEC.md §6 item 2). */
export function normalizeBaseUrl(url: string): string {
  return url.replace(/\/+$/, '');
}

export type BaseUrlRole = 'http' | 'websocket';

/**
 * Validate an operator- or discovery-supplied base URL without reflecting it
 * in an error. Base URLs are routing data, never a second credential channel.
 */
export function validateBaseUrl(
  input: string,
  role: BaseUrlRole,
  label = role === 'http' ? 'HTTP base URL' : 'WebSocket base URL'
): string {
  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    throw coreError('INVALID_ARGUMENT', `${label} must be an absolute URL`);
  }
  const allowed = role === 'http' ? ['http:', 'https:'] : ['ws:', 'wss:'];
  if (!allowed.includes(parsed.protocol) || parsed.hostname === '') {
    throw coreError('INVALID_ARGUMENT', `${label} uses an unsupported protocol or host`);
  }
  if (parsed.username !== '' || parsed.password !== '') {
    throw coreError('INVALID_ARGUMENT', `${label} must not contain user information`);
  }
  if (parsed.search !== '' || parsed.hash !== '') {
    throw coreError('INVALID_ARGUMENT', `${label} must not contain a query or fragment`);
  }
  return normalizeBaseUrl(parsed.toString());
}

/**
 * WebSocket base for an API base: same origin, same prefix, `http`→`ws`.
 *
 * Only used when the profile does not pin `ws_base_url`
 * (docs/CONNECTIONS.md §9).
 */
export function deriveWsBaseUrl(apiBaseUrl: string): string {
  const parsed = new URL(validateBaseUrl(apiBaseUrl, 'http', 'API base URL'));
  parsed.protocol = parsed.protocol === 'https:' ? 'wss:' : 'ws:';
  return normalizeBaseUrl(parsed.toString());
}

/** Join a normalised base with a route that starts with `/`. */
export function joinUrl(base: string, route: string): string {
  const left = normalizeBaseUrl(base);
  return route.startsWith('/') ? `${left}${route}` : `${left}/${route}`;
}

/** `true` when both URLs have the same scheme, host and port. */
export function isSameOrigin(a: string, b: string): boolean {
  try {
    const left = new URL(a);
    const right = new URL(b);
    return left.protocol === right.protocol && left.host === right.host;
  } catch {
    return false;
  }
}
