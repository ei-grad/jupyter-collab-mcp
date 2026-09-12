import { describe, expect, it } from 'vitest';

import {
  findSingleOccurrence,
  minimalReplace,
  previewOf,
  truncateUtf8,
  utf8Length
} from '../../../src/core/notebook/index.js';

describe('minimalReplace (SPEC.md §7: full replacement as a minimal edit)', () => {
  it('returns null for an unchanged text', () => {
    expect(minimalReplace('same', 'same')).toBeNull();
  });

  it('touches only the changed middle, not the whole text', () => {
    const before = 'import pandas as pd\ndf.head()\nprint(df)';
    const after = 'import pandas as pd\ndf.head(20)\nprint(df)';
    const edit = minimalReplace(before, after);
    expect(edit).not.toBeNull();
    expect(edit!.deleteCount).toBe(0);
    expect(edit!.insert).toBe('20');
    expect(before.slice(0, edit!.index)).toBe('import pandas as pd\ndf.head(');
  });

  it('handles a pure deletion in the middle', () => {
    const edit = minimalReplace('abcdef', 'abef');
    expect(edit).toEqual({ index: 2, deleteCount: 2, insert: '' });
  });

  it('handles append and prepend without rewriting the rest', () => {
    expect(minimalReplace('abc', 'abcd')).toEqual({ index: 3, deleteCount: 0, insert: 'd' });
    expect(minimalReplace('abc', 'zabc')).toEqual({ index: 0, deleteCount: 0, insert: 'z' });
  });

  it('never splits a surrogate pair', () => {
    const edit = minimalReplace('a😀b', 'a😁b');
    expect(edit).not.toBeNull();
    const rebuilt =
      'a😀b'.slice(0, edit!.index) + edit!.insert + 'a😀b'.slice(edit!.index + edit!.deleteCount);
    expect(rebuilt).toBe('a😁b');
    expect(edit!.index).toBe(1);
  });

  it('produces an edit that reconstructs the target for random pairs', () => {
    const samples: [string, string][] = [
      ['', 'hello'],
      ['hello', ''],
      ['aaaa', 'aa'],
      ['x = 1\ny = 2\n', 'x = 1\ny = 3\nz = 4\n'],
      ['ααα', 'αβα']
    ];
    for (const [before, after] of samples) {
      const edit = minimalReplace(before, after);
      const applied =
        edit === null
          ? before
          : before.slice(0, edit.index) + edit.insert + before.slice(edit.index + edit.deleteCount);
      expect(applied).toBe(after);
    }
  });
});

describe('findSingleOccurrence (SPEC.md §7: exactly one match)', () => {
  it('finds a unique match', () => {
    expect(findSingleOccurrence('a b c', 'b')).toEqual({ kind: 'unique', index: 2 });
  });

  it('reports a missing match', () => {
    expect(findSingleOccurrence('a b c', 'z')).toEqual({ kind: 'not_found' });
  });

  it('counts repeated matches', () => {
    expect(findSingleOccurrence('bbb', 'b')).toEqual({ kind: 'not_unique', count: 3 });
  });

  it('refuses an empty needle', () => {
    expect(findSingleOccurrence('abc', '').kind).toBe('not_unique');
  });
});

describe('previewOf (SPEC.md §7: short single-line preview)', () => {
  it('collapses newlines into one line', () => {
    expect(previewOf('a\n\nb\tc', 80)).toBe('a b c');
  });

  it('cuts to the budget and marks the cut', () => {
    const preview = previewOf('x'.repeat(200), 80);
    expect(preview).toHaveLength(81);
    expect(preview.endsWith('…')).toBe(true);
  });
});

describe('truncateUtf8', () => {
  it('reports the full size even when it cuts', () => {
    const { text, totalBytes } = truncateUtf8('こんにちは', 5);
    expect(totalBytes).toBe(utf8Length('こんにちは'));
    expect(utf8Length(text)).toBeLessThanOrEqual(5);
    expect(text).toBe('こ');
  });

  it('returns the text untouched when it fits', () => {
    expect(truncateUtf8('abc', 10)).toEqual({ text: 'abc', totalBytes: 3 });
  });
});
