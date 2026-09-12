/**
 * Text helpers used by `replace_source` / `replace_text` (SPEC.md §7).
 *
 * SPEC.md §7 requires a full source replacement to be applied as **minimal
 * changes to the existing `Y.Text`**, keeping the cell object alive, so that a
 * concurrent remote edit merges instead of being clobbered by a
 * delete-everything/insert-everything rewrite.
 *
 * @module
 */

/** One minimal edit of a `Y.Text`: delete `deleteCount` at `index`, insert `insert`. */
export interface TextEdit {
  /** UTF-16 offset, the unit `Y.Text` itself uses. */
  readonly index: number;
  readonly deleteCount: number;
  readonly insert: string;
}

const isHighSurrogate = (code: number): boolean => code >= 0xd800 && code <= 0xdbff;
const isLowSurrogate = (code: number): boolean => code >= 0xdc00 && code <= 0xdfff;

/**
 * Smallest single-range edit turning `current` into `next` (SPEC.md §7).
 *
 * Computed as "common prefix / common suffix"; the shared middle is never
 * touched, so editing one word of a long cell produces an update proportional
 * to that word rather than to the whole cell. A surrogate pair is never split:
 * the boundary is pulled back one code unit if it would land inside one.
 *
 * Returns `null` when the texts are already equal - the caller must then not
 * touch the `Y.Text` at all, so an idempotent `replace_source` produces no
 * update and no journal event.
 */
export function minimalReplace(current: string, next: string): TextEdit | null {
  if (current === next) return null;
  const max = Math.min(current.length, next.length);
  let prefix = 0;
  while (prefix < max && current.charCodeAt(prefix) === next.charCodeAt(prefix)) prefix++;
  if (prefix > 0 && isHighSurrogate(current.charCodeAt(prefix - 1))) prefix--;

  let suffix = 0;
  const maxSuffix = max - prefix;
  while (
    suffix < maxSuffix &&
    current.charCodeAt(current.length - 1 - suffix) === next.charCodeAt(next.length - 1 - suffix)
  ) {
    suffix++;
  }
  if (suffix > 0 && isLowSurrogate(current.charCodeAt(current.length - suffix))) suffix--;

  return {
    index: prefix,
    deleteCount: current.length - prefix - suffix,
    insert: next.slice(prefix, next.length - suffix)
  };
}

/** Outcome of looking for the single occurrence required by `replace_text`. */
export type OccurrenceResult =
  | { readonly kind: 'unique'; readonly index: number }
  | { readonly kind: 'not_found' }
  | { readonly kind: 'not_unique'; readonly count: number };

/**
 * Locate the one occurrence of `needle` (SPEC.md §7: exactly one match,
 * otherwise `MATCH_NOT_FOUND` / `MATCH_NOT_UNIQUE`).
 *
 * Occurrences are counted non-overlapping, left to right; an empty `needle` is
 * reported as `not_unique` so it can never be applied.
 */
export function findSingleOccurrence(haystack: string, needle: string): OccurrenceResult {
  if (needle.length === 0) return { kind: 'not_unique', count: haystack.length + 1 };
  const first = haystack.indexOf(needle);
  if (first < 0) return { kind: 'not_found' };
  let count = 1;
  let from = first + needle.length;
  for (;;) {
    const next = haystack.indexOf(needle, from);
    if (next < 0) break;
    count++;
    from = next + needle.length;
  }
  return count === 1 ? { kind: 'unique', index: first } : { kind: 'not_unique', count };
}

/**
 * Single-line, length-limited excerpt for {@link CellSummary.preview}
 * (SPEC.md §7: "short preview", never the whole text).
 *
 * All whitespace runs - newlines included - collapse to one space, so a
 * summary row stays one line whatever the cell contains. An ellipsis marks a
 * cut, and is not part of the budget.
 */
export function previewOf(source: string, maxChars: number): string {
  const flat = source.replace(/\s+/gu, ' ').trim();
  if (flat.length <= maxChars) return flat;
  return `${flat.slice(0, maxChars)}…`;
}

/** UTF-8 byte length, the unit every read limit in SPEC.md §9 is expressed in. */
export function utf8Length(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

/**
 * Cut `text` to at most `maxBytes` UTF-8 bytes without splitting a code point.
 * Returns the kept prefix and the total size, so a truncated read can still
 * report how much there is (SPEC.md §9).
 */
export function truncateUtf8(text: string, maxBytes: number): { text: string; totalBytes: number } {
  const totalBytes = utf8Length(text);
  if (totalBytes <= maxBytes) return { text, totalBytes };
  if (maxBytes <= 0) return { text: '', totalBytes };
  const buffer = Buffer.from(text, 'utf8');
  let end = maxBytes;
  // Walk back over UTF-8 continuation bytes (0b10xxxxxx) to a code point start.
  while (end > 0) {
    const byte = buffer[end];
    if (byte === undefined || (byte & 0xc0) !== 0x80) break;
    end--;
  }
  return { text: buffer.subarray(0, end).toString('utf8'), totalBytes };
}
