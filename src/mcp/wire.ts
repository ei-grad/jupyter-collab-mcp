/**
 * The wire layer of the MCP adapter (SPEC.md §9).
 *
 * Three jobs, and nothing else:
 *
 * 1. **Naming.** `CollabService` speaks camelCase (`src/core/service.ts`); the
 *    tool schemas of SPEC.md §9 speak snake_case. {@link toWire} and
 *    {@link fromWire} are the only place the two meet.
 * 2. **JSON hygiene.** `undefined` never reaches the wire: an absent optional
 *    field is an absent key, not `"key": null`. `exactOptionalPropertyTypes`
 *    makes the difference meaningful on the way back in, too.
 * 3. **Response size.** SPEC.md §9 bounds one answer to 64 KiB of text by
 *    default. When a payload does not fit, it is reduced in a defined order
 *    and the answer *says so*: `response_truncated: true` plus `read_more`,
 *    which names the tool that serves the rest. A truncated answer never
 *    pretends to be complete.
 *
 * No business logic lives here. The service has already decided what is
 * `truncated`, which `output_id` reads the rest and how large a payload is;
 * this module only refuses to exceed the transport budget.
 *
 * @module
 */

import { utf8Length } from '../core/notebook/index.js';

/** SPEC.md §9 default: 64 KiB of text in one tool response. */
export const DEFAULT_RESPONSE_MAX_BYTES = 64 * 1024;

/** JSON value shape used throughout the adapter (`JsonValue` of `src/core` is
 * the revision-digest one; this is the wire one). */
export type WireValue = null | boolean | number | string | WireValue[] | { [key: string]: WireValue };

/** A JSON object: the shape of every `structuredContent`. */
export type WireObject = { [key: string]: WireValue };

// ---------------------------------------------------------------------------
// key naming
// ---------------------------------------------------------------------------

/**
 * Keys whose *value* is user data, not a structure of ours, and is therefore
 * copied verbatim in both directions.
 *
 * - `metadata`, `notebook_metadata`, `attachments` - notebook/cell metadata and
 *   markdown attachments: arbitrary keys chosen by the document (SPEC.md §7);
 * - `value` - the payload of `set_cell_metadata` / `set_notebook_metadata`;
 * - `output` - one nbformat output. nbformat is already snake_case
 *   (`output_type`, `execution_count`) and MIME bundle keys such as
 *   `image/png` must survive untouched (SPEC.md §8);
 * - `details` - the structured diagnostics of a `CoreError`, written in the
 *   wire form by the thrower.
 */
export const OPAQUE_KEYS: ReadonlySet<string> = new Set([
  'userOptions',
  'user_options',
  'metadata',
  'notebookMetadata',
  'notebook_metadata',
  'attachments',
  'value',
  'output',
  'details'
]);

/** `camelCase` -> `snake_case`. Digits stay attached to the word before them. */
export function snakeKey(key: string): string {
  return key.replace(/[A-Z]/gu, (letter) => `_${letter.toLowerCase()}`);
}

/** `snake_case` -> `camelCase`. Inverse of {@link snakeKey} for our keys. */
export function camelKey(key: string): string {
  return key.replace(/_([a-z0-9])/gu, (_match, letter: string) => letter.toUpperCase());
}

function convert(value: unknown, rename: (key: string) => string): unknown {
  if (Array.isArray(value)) return value.map((item) => convert(item, rename));
  if (value === null || typeof value !== 'object') return value;
  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (child === undefined) continue;
    const renamed = rename(key);
    result[renamed] = OPAQUE_KEYS.has(key) ? child : convert(child, rename);
  }
  return result;
}

/**
 * Service result -> wire object: camelCase keys become snake_case, `undefined`
 * members disappear, {@link OPAQUE_KEYS} values are copied as they are.
 */
export function toWire(value: unknown): WireValue {
  return convert(value, snakeKey) as WireValue;
}

/**
 * Wire arguments -> service request: snake_case keys become camelCase.
 *
 * Applied *after* the arguments were validated against the tool's zod schema,
 * so the shape is already known-good; this only renames.
 */
export function fromWire(value: unknown): unknown {
  return convert(value, camelKey);
}

// ---------------------------------------------------------------------------
// size bounding (SPEC.md §9)
// ---------------------------------------------------------------------------

/** UTF-8 size of a value as it will be serialised. */
export function jsonByteSize(value: unknown): number {
  return utf8Length(JSON.stringify(value) ?? '');
}

/** Cut a rendered text block to `maxBytes`, marking the cut. */
export function boundText(text: string, maxBytes: number): { text: string; truncated: boolean } {
  if (utf8Length(text) <= maxBytes) return { text, truncated: false };
  const marker = '\n… (text truncated)';
  const room = Math.max(0, maxBytes - utf8Length(marker));
  const buffer = Buffer.from(text, 'utf8');
  let end = Math.min(room, buffer.length);
  while (end > 0) {
    const byte = buffer[end];
    if (byte === undefined || (byte & 0xc0) !== 0x80) break;
    end--;
  }
  return { text: `${buffer.subarray(0, end).toString('utf8')}${marker}`, truncated: true };
}

/** Outcome of {@link boundPayload}. */
export interface BoundedPayload {
  readonly payload: WireObject;
  /** `true` when anything at all was removed to make the answer fit. */
  readonly truncated: boolean;
  /** Human-readable instruction naming how to read what was dropped. */
  readonly readMore?: string;
}

/** A payload cannot be reduced without losing data that has no continuation. */
export class WireBudgetError extends Error {
  readonly byteSize: number;
  readonly maxBytes: number;

  constructor(byteSize: number, maxBytes: number) {
    super(`the structured response is ${byteSize} bytes, above the ${maxBytes}-byte response budget`);
    this.name = 'WireBudgetError';
    this.byteSize = byteSize;
    this.maxBytes = maxBytes;
  }
}

function isObject(value: WireValue): value is WireObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Drop inlined output payloads that can be read separately.
 *
 * An entry keeps everything an agent needs to find the data again -
 * `mime_types`, `byte_size`, `snapshot.output_id` - and is marked
 * `truncated: true` (SPEC.md §9: the answer always states how to read the
 * rest). Entries without a snapshot are left alone: dropping them would make
 * the result unreachable.
 */
function dropInlinedOutputs(value: WireValue): { value: WireValue; dropped: number } {
  let dropped = 0;
  const walk = (node: WireValue): WireValue => {
    if (Array.isArray(node)) return node.map(walk);
    if (!isObject(node)) return node;
    const next: WireObject = {};
    for (const [key, child] of Object.entries(node)) {
      next[key] = OPAQUE_KEYS.has(key) ? child : walk(child);
    }
    const hasSnapshot = isObject(next['snapshot'] ?? null) || typeof next['output_id'] === 'string';
    if (hasSnapshot && (next['output'] !== undefined || next['text_preview'] !== undefined)) {
      delete next['output'];
      delete next['text_preview'];
      next['output_inlined'] = false;
      next['truncated'] = true;
      dropped++;
    }
    if (Array.isArray(next['outputs']) && next['outputs'].some((entry) =>
      isObject(entry) && entry['truncated'] === true && entry['delivered_as'] !== 'image'
    )) next['outputs_truncated'] = true;
    return next;
  };
  return { value: walk(value), dropped };
}

/**
 * Shorten only pages whose continuation can be moved to the last item kept:
 * journal sequences, indexed notebook cells, and offset-based directory or
 * resource pages. Other arrays are deliberately not shortened here because
 * their opaque cursor may already point past the whole page.
 */
function shortenRecoverableArray(payload: WireObject): boolean {
  const candidate = payload['events'];
  if (Array.isArray(candidate) && candidate.length > 1) {
    const kept = candidate.slice(0, Math.max(1, Math.floor(candidate.length / 2)));
    const last = kept[kept.length - 1];
    if (last !== undefined && isObject(last) && Number.isSafeInteger(last['sequence'])) {
      payload['events'] = kept;
      payload['next_cursor'] = `chg_${String(last['sequence'])}`;
      payload['truncated'] = true;
      return true;
    }
  }

  const cells = payload['cells'];
  const pageCursorKey =
    typeof payload['page_cursor'] === 'string'
      ? 'page_cursor'
      : typeof payload['next_cursor'] === 'string'
        ? 'next_cursor'
        : undefined;
  if (Array.isArray(cells) && cells.length > 1 && pageCursorKey !== undefined) {
    const kept = cells.slice(0, Math.max(1, Math.floor(cells.length / 2)));
    const last = kept[kept.length - 1];
    const cursor = payload[pageCursorKey];
    if (last !== undefined && isObject(last) && Number.isSafeInteger(last['index']) && typeof cursor === 'string') {
      const dot = cursor.lastIndexOf('.');
      if (cursor.startsWith('pg_') && dot > 3) {
        payload['cells'] = kept;
        payload[pageCursorKey] = `${cursor.slice(0, dot + 1)}${String(Number(last['index']) + 1)}`;
        payload['truncated'] = true;
        if (payload['view'] === 'outputs') payload['cells_truncated'] = true;
        return true;
      }
    }
  }

  for (const key of ['entries', 'resources']) {
    const array = payload[key];
    const cursor = payload['next_cursor'];
    if (!Array.isArray(array) || array.length <= 1 || typeof cursor !== 'string') continue;
    const match = /^dir_(0|[1-9][0-9]*)$/.exec(cursor);
    if (match === null) continue;
    const kept = array.slice(0, Math.max(1, Math.floor(array.length / 2)));
    const pageEnd = Number(match[1]);
    payload[key] = kept;
    payload['next_cursor'] = `dir_${String(pageEnd - array.length + kept.length)}`;
    payload['truncated'] = true;
    return true;
  }

  for (const [key, child] of Object.entries(payload)) {
    if (OPAQUE_KEYS.has(key)) continue;
    if (!isObject(child)) continue;
    const previousChildCursor =
      typeof child['page_cursor'] === 'string'
        ? child['page_cursor']
        : typeof child['next_cursor'] === 'string'
          ? child['next_cursor']
          : undefined;
    if (!shortenRecoverableArray(child)) continue;
    const childCursor =
      typeof child['page_cursor'] === 'string'
        ? child['page_cursor']
        : typeof child['next_cursor'] === 'string'
          ? child['next_cursor']
          : undefined;
    if (
      previousChildCursor !== undefined &&
      payload['next_cursor'] === previousChildCursor &&
      childCursor !== undefined
    ) {
      payload['next_cursor'] = childCursor;
    }
    return true;
  }
  return false;
}

/**
 * Fit a wire payload into `maxBytes`, in a defined order (SPEC.md §9).
 *
 * 1. inlined output payloads that have an `output_id` are dropped - they are
 *    read with `output_read` or the matching `jupyter-output:` resource;
 * 2. a recognized journal, notebook-cell, directory, or resource page is
 *    halved and its cursor is moved to the last item actually retained;
 * 3. whatever survives is marked `response_truncated` with a `read_more` note.
 *
 * Arrays without a continuation known to this layer are never sliced. If
 * dropping recoverable outputs and safely paging journal events is not enough,
 * {@link WireBudgetError} makes the tool return a bounded `RESOURCE_LIMIT`
 * error instead of silently losing records or exceeding the advertised cap.
 */
export function boundPayload(payload: WireObject, maxBytes: number): BoundedPayload {
  if (jsonByteSize(payload) <= maxBytes) return { payload, truncated: false };

  const reasons: string[] = [];
  const stripped = dropInlinedOutputs(payload) as { value: WireObject; dropped: number };
  let current = stripped.value;
  if (stripped.dropped > 0) {
    reasons.push(`${stripped.dropped} output payload(s) omitted — read them with output_read(output_id) or the jupyter-output: resource`);
  }

  if (stripped.dropped > 0) {
    current['response_truncated'] = true;
    current['read_more'] = reasons.join('; ');
    if (current['view'] === 'outputs') {
      current['truncated'] = true;
      current['outputs_truncated'] = true;
    }
  }

  let guard = 64;
  while (jsonByteSize(current) > maxBytes && guard-- > 0) {
    if (!shortenRecoverableArray(current)) break;
    if (!reasons.includes('page shortened — continue with the returned cursor')) {
      reasons.push('page shortened — continue with the returned cursor');
    }
    current['response_truncated'] = true;
    current['read_more'] = reasons.join('; ');
  }

  const byteSize = jsonByteSize(current);
  if (byteSize > maxBytes) throw new WireBudgetError(byteSize, maxBytes);
  const readMore = reasons.join('; ');
  return { payload: current, truncated: true, readMore };
}
