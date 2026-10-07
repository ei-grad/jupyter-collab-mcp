/** Three-way source merge and region edits (SPEC.md §7). */

import { describe, expect, it } from 'vitest';

import { diffLines, mergeSources, regionEdits, splitLines } from '../../../src/core/notebook/merge.js';

function applyEdits(text: string, edits: ReturnType<typeof regionEdits>): string {
  let out = text;
  for (const { index, deleteCount, insert } of edits) {
    out = out.slice(0, index) + insert + out.slice(index + deleteCount);
  }
  return out;
}

/** Deterministic pseudo-random generator, so a failure reproduces. */
function rng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

function randomLines(next: () => number, count: number): string[] {
  const words = ['a', 'b', 'c', 'x = 1', 'print(x)', '', 'return y', 'import os'];
  return Array.from({ length: count }, () => `${words[Math.floor(next() * words.length)]!}\n`);
}

describe('merge: splitLines', () => {
  it('keeps terminators so joining restores the text', () => {
    for (const text of ['', 'a', 'a\n', 'a\nb', '\n\n', 'a\r\nb\n']) {
      expect(splitLines(text).join('')).toBe(text);
    }
  });
});

describe('merge: diffLines', () => {
  it('describes a minimal edit as disjoint hunks', () => {
    const a = splitLines('1\n2\n3\n4\n');
    const b = splitLines('1\nX\n3\n4\nY\n');
    expect(diffLines(a, b)).toEqual([
      { aStart: 1, aEnd: 2, bStart: 1, bEnd: 2 },
      { aStart: 4, aEnd: 4, bStart: 4, bEnd: 5 }
    ]);
  });

  it('reconstructs b from a for random inputs', () => {
    const next = rng(7);
    for (let round = 0; round < 300; round++) {
      const a = randomLines(next, Math.floor(next() * 12));
      const b = randomLines(next, Math.floor(next() * 12));
      const out: string[] = [];
      let at = 0;
      for (const hunk of diffLines(a, b)) {
        out.push(...a.slice(at, hunk.aStart), ...b.slice(hunk.bStart, hunk.bEnd));
        at = hunk.aEnd;
      }
      out.push(...a.slice(at));
      expect(out.join('')).toBe(b.join(''));
    }
  });
});

describe('merge: mergeSources', () => {
  it('takes the requested text when nothing else changed', () => {
    expect(mergeSources('a\n', 'a\n', 'b\n')).toEqual({ kind: 'merged', text: 'b\n' });
  });

  it('keeps the other side when the request changes nothing', () => {
    expect(mergeSources('a\n', 'b\n', 'a\n')).toEqual({ kind: 'merged', text: 'b\n' });
  });

  it('combines edits of different lines', () => {
    expect(mergeSources('1\n2\n3\n', '1\n2\nC\n', 'A\n2\n3\n')).toEqual({
      kind: 'merged',
      text: 'A\n2\nC\n'
    });
  });

  it('accepts the same change made on both sides once', () => {
    expect(mergeSources('1\n2\n', '1\nX\n', '1\nX\n')).toEqual({ kind: 'merged', text: '1\nX\n' });
    expect(mergeSources('1\n2\n3\n', 'Z\n2\nX\n', '1\n2\nX\n')).toEqual({
      kind: 'merged',
      text: 'Z\n2\nX\n'
    });
  });

  it('orders an insertion before the range replaced at the same point', () => {
    expect(mergeSources('1\n2\n', 'I\n1\n2\n', 'R\n2\n')).toEqual({ kind: 'merged', text: 'I\nR\n2\n' });
  });

  it('conflicts on different changes of the same line', () => {
    expect(mergeSources('1\n2\n3\n', '1\nX\n3\n', '1\nY\n3\n')).toEqual({
      kind: 'conflict',
      conflicts: [{ baseLine: 1, baseLines: 1 }]
    });
  });

  it('conflicts on different insertions at the same point', () => {
    expect(mergeSources('1\n2\n', '1\nX\n2\n', '1\nY\n2\n')).toMatchObject({ kind: 'conflict' });
  });

  it('conflicts on an insertion inside a replaced range', () => {
    expect(mergeSources('1\n2\n3\n', '1\n2\nI\n3\n', 'R\n')).toMatchObject({ kind: 'conflict' });
  });

  it('merges random edits of disjoint line blocks', () => {
    // Distinct lines, so the alignment of each side against the base is unique.
    const next = rng(42);
    let serial = 0;
    const fresh = (count: number): string[] =>
      Array.from({ length: count }, () => `line ${serial++}\n`);
    for (let round = 0; round < 200; round++) {
      const base = fresh(8);
      const theirs = [...base];
      const ours = [...base];
      theirs.splice(1, 2, ...fresh(Math.floor(next() * 3)));
      ours.splice(5, 2, ...fresh(Math.floor(next() * 3)));
      const result = mergeSources(base.join(''), theirs.join(''), ours.join(''));
      const expected = [...theirs.slice(0, theirs.length - 3), ...ours.slice(5)];
      expect(result).toEqual({ kind: 'merged', text: expected.join('') });
    }
  });
});

describe('merge: regionEdits', () => {
  it('produces one edit per changed region, untouched text between them', () => {
    const current = 'keep 1\nchange me\nkeep 2\nkeep 3\nand me\n';
    const next = 'keep 1\nchanged\nkeep 2\nkeep 3\nand you\n';
    const edits = regionEdits(current, next);
    expect(edits).toHaveLength(2);
    expect(edits[0]!.index).toBeGreaterThan(edits[1]!.index);
    expect(applyEdits(current, edits)).toBe(next);
  });

  it('turns any text into any other text', () => {
    const next = rng(3);
    for (let round = 0; round < 300; round++) {
      const current = randomLines(next, Math.floor(next() * 10)).join('');
      const target = randomLines(next, Math.floor(next() * 10)).join('');
      expect(applyEdits(current, regionEdits(current, target))).toBe(target);
    }
  });

  it('is empty for equal texts', () => {
    expect(regionEdits('a\nb', 'a\nb')).toEqual([]);
  });
});
