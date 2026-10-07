/**
 * Line-level three-way merge for `replace_source` (SPEC.md §7).
 *
 * A source replacement states the text the caller wants, derived from the
 * source it observed. When the cell changed since that observation - a
 * collaborator typed, or an earlier operation of the same batch edited it -
 * the caller's changes (base → requested) are merged into the current text
 * (base → current) instead of overwriting it. Only changes that touch the same
 * base lines, or insert different text at the same point, are a conflict.
 *
 * The merged result is applied as several minimal `Y.Text` edits, one per
 * changed region, so text between the regions keeps its CRDT identity and a
 * concurrent remote edit there still merges.
 *
 * @module
 */

import { minimalReplace } from './text.js';
import type { TextEdit } from './text.js';

/** `a[aStart, aEnd)` is replaced by `b[bStart, bEnd)`. */
interface Hunk {
  readonly aStart: number;
  readonly aEnd: number;
  readonly bStart: number;
  readonly bEnd: number;
}

/** One region both sides changed differently, in base line numbers. */
export interface MergeConflict {
  /** First base line (0-based) of the conflicting region. */
  readonly baseLine: number;
  /** Number of base lines the region spans; 0 for competing insertions. */
  readonly baseLines: number;
}

export type MergeResult =
  | { readonly kind: 'merged'; readonly text: string }
  | { readonly kind: 'conflict'; readonly conflicts: readonly MergeConflict[] };

/**
 * Myers searches beyond this many differences fall back to replacing the
 * whole differing middle: correct, only coarser, and it bounds the work for a
 * pathological cell.
 */
const MAX_EDIT_DISTANCE = 4096;

/** Split into lines that keep their terminator, so joining restores the text. */
export function splitLines(text: string): string[] {
  if (text.length === 0) return [];
  const lines: string[] = [];
  let start = 0;
  for (;;) {
    const newline = text.indexOf('\n', start);
    if (newline < 0) {
      if (start < text.length) lines.push(text.slice(start));
      return lines;
    }
    lines.push(text.slice(start, newline + 1));
    start = newline + 1;
  }
}

/** Minimal line diff of `a` → `b` as ordered, disjoint hunks. */
export function diffLines(a: readonly string[], b: readonly string[]): Hunk[] {
  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++;
  let suffix = 0;
  while (
    suffix < a.length - prefix &&
    suffix < b.length - prefix &&
    a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
  ) {
    suffix++;
  }
  const n = a.length - prefix - suffix;
  const m = b.length - prefix - suffix;
  if (n === 0 && m === 0) return [];
  if (n === 0 || m === 0) {
    return [{ aStart: prefix, aEnd: prefix + n, bStart: prefix, bEnd: prefix + m }];
  }
  const pairs = myersMatches(a, b, prefix, n, m);
  if (pairs === null) {
    return [{ aStart: prefix, aEnd: prefix + n, bStart: prefix, bEnd: prefix + m }];
  }
  const hunks: Hunk[] = [];
  let ai = prefix;
  let bi = prefix;
  for (const [ax, bx] of [...pairs, [prefix + n, prefix + m] as const]) {
    if (ax > ai || bx > bi) hunks.push({ aStart: ai, aEnd: ax, bStart: bi, bEnd: bx });
    ai = ax + 1;
    bi = bx + 1;
  }
  return hunks;
}

/**
 * Matched line pairs of the middle ranges `a[off, off+n)` / `b[off, off+m)`,
 * in increasing order, from Myers' O(ND) algorithm; `null` past
 * {@link MAX_EDIT_DISTANCE}.
 */
function myersMatches(
  a: readonly string[],
  b: readonly string[],
  off: number,
  n: number,
  m: number
): Array<readonly [number, number]> | null {
  const max = Math.min(n + m, MAX_EDIT_DISTANCE);
  const width = 2 * max + 1;
  let v = new Int32Array(width + 2);
  const trace: Int32Array[] = [];
  let found = -1;
  for (let d = 0; d <= max && found < 0; d++) {
    trace.push(v.slice());
    const next = v.slice();
    for (let k = -d; k <= d; k += 2) {
      const at = k + max;
      let x =
        k === -d || (k !== d && v[at - 1]! < v[at + 1]!) ? v[at + 1]! : v[at - 1]! + 1;
      let y = x - k;
      while (x < n && y < m && a[off + x] === b[off + y]) {
        x++;
        y++;
      }
      next[at] = x;
      if (x >= n && y >= m) {
        found = d;
        break;
      }
    }
    v = next;
  }
  if (found < 0) return null;

  const pairs: Array<readonly [number, number]> = [];
  let x = n;
  let y = m;
  for (let d = found; d > 0; d--) {
    const prev = trace[d]!;
    const k = x - y;
    const at = k + max;
    const down = k === -d || (k !== d && prev[at - 1]! < prev[at + 1]!);
    const prevK = down ? k + 1 : k - 1;
    const prevX = prev[prevK + max]!;
    const prevY = prevX - prevK;
    const startX = down ? prevX : prevX + 1;
    const startY = startX - k;
    while (x > startX && y > startY) {
      x--;
      y--;
      pairs.push([off + x, off + y]);
    }
    x = prevX;
    y = prevY;
  }
  while (x > 0 && y > 0) {
    x--;
    y--;
    pairs.push([off + x, off + y]);
  }
  return pairs.reverse();
}

function sameReplacement(
  left: Hunk,
  leftLines: readonly string[],
  right: Hunk,
  rightLines: readonly string[]
): boolean {
  if (left.aStart !== right.aStart || left.aEnd !== right.aEnd) return false;
  if (left.bEnd - left.bStart !== right.bEnd - right.bStart) return false;
  for (let i = 0; i < left.bEnd - left.bStart; i++) {
    if (leftLines[left.bStart + i] !== rightLines[right.bStart + i]) return false;
  }
  return true;
}

/**
 * Two hunks over the same base collide when their base ranges overlap, when
 * both insert at the same point (the order would be a guess), or when one
 * inserts strictly inside the range the other replaces.
 */
function collide(left: Hunk, right: Hunk): boolean {
  if (Math.max(left.aStart, right.aStart) < Math.min(left.aEnd, right.aEnd)) return true;
  const leftInsert = left.aStart === left.aEnd;
  const rightInsert = right.aStart === right.aEnd;
  if (leftInsert && rightInsert) return left.aStart === right.aStart;
  if (leftInsert) return right.aStart < left.aStart && left.aStart < right.aEnd;
  if (rightInsert) return left.aStart < right.aStart && right.aStart < left.aEnd;
  return false;
}

/**
 * Merge `requested` (the caller's edit of `base`) into `current` (whatever
 * `base` became meanwhile).
 */
export function mergeSources(base: string, current: string, requested: string): MergeResult {
  if (current === base || current === requested) return { kind: 'merged', text: requested };
  if (requested === base) return { kind: 'merged', text: current };

  const baseLines = splitLines(base);
  const theirLines = splitLines(current);
  const ourLines = splitLines(requested);
  const theirs = diffLines(baseLines, theirLines);
  const ours = diffLines(baseLines, ourLines);

  const conflicts: MergeConflict[] = [];
  for (const mine of ours) {
    for (const other of theirs) {
      if (other.aStart > mine.aEnd) break;
      if (!collide(mine, other)) continue;
      if (sameReplacement(mine, ourLines, other, theirLines)) continue;
      const start = Math.min(mine.aStart, other.aStart);
      conflicts.push({
        baseLine: start,
        baseLines: Math.max(mine.aEnd, other.aEnd) - start
      });
    }
  }
  if (conflicts.length > 0) return { kind: 'conflict', conflicts };

  type Tagged = { readonly hunk: Hunk; readonly lines: readonly string[] };
  const tagged: Tagged[] = [
    ...theirs.map((hunk) => ({ hunk, lines: theirLines })),
    ...ours
      .filter((hunk) => !theirs.some((other) => sameReplacement(hunk, ourLines, other, theirLines)))
      .map((hunk) => ({ hunk, lines: ourLines }))
  ].sort(
    (left, right) =>
      left.hunk.aStart - right.hunk.aStart ||
      // At a shared start an insertion goes before the range replaced there.
      (left.hunk.aEnd - left.hunk.aStart) - (right.hunk.aEnd - right.hunk.aStart)
  );

  const out: string[] = [];
  let at = 0;
  for (const { hunk, lines } of tagged) {
    for (; at < hunk.aStart; at++) out.push(baseLines[at]!);
    for (let i = hunk.bStart; i < hunk.bEnd; i++) out.push(lines[i]!);
    at = Math.max(at, hunk.aEnd);
  }
  for (; at < baseLines.length; at++) out.push(baseLines[at]!);
  return { kind: 'merged', text: out.join('') };
}

/**
 * Edits turning `current` into `next`, one per changed line region, each
 * narrowed to its differing characters. Ordered by descending index, so they
 * can be applied one after another without shifting each other.
 */
export function regionEdits(current: string, next: string): TextEdit[] {
  if (current === next) return [];
  const from = splitLines(current);
  const to = splitLines(next);
  const offsets: number[] = [0];
  for (const line of from) offsets.push(offsets[offsets.length - 1]! + line.length);
  const edits: TextEdit[] = [];
  for (const hunk of diffLines(from, to)) {
    const start = offsets[hunk.aStart]!;
    const before = current.slice(start, offsets[hunk.aEnd]!);
    const after = to.slice(hunk.bStart, hunk.bEnd).join('');
    const edit = minimalReplace(before, after);
    if (edit !== null) edits.push({ ...edit, index: start + edit.index });
  }
  return edits.reverse();
}
