/**
 * SPEC.md §6: "Paths and parameters must be encoded according to this protocol,
 * with tests for Unicode, spaces, nested directories, and URL prefixes",
 * and SPEC.md §11: "traversal through `..` is not allowed".
 */
import { describe, expect, it } from 'vitest';

import { isCoreError } from '../../src/core/index.js';
import {
  deriveWsBaseUrl,
  encodeContentsPath,
  encodeSessionPath,
  isSameOrigin,
  joinUrl,
  normalizeBaseUrl,
  normalizeContentsPath,
  roomName,
  validateNotebookName
} from '../../src/jupyter/paths.js';

describe('normalizeContentsPath', () => {
  it('normalises separators and keeps the path relative to the root', () => {
    expect(normalizeContentsPath('')).toBe('');
    expect(normalizeContentsPath('/')).toBe('');
    expect(normalizeContentsPath('/a/b/')).toBe('a/b');
    expect(normalizeContentsPath('a//b/./c')).toBe('a/b/c');
    expect(normalizeContentsPath('δοκιμή κατάλογος/Untitled.ipynb')).toBe(
      'δοκιμή κατάλογος/Untitled.ipynb'
    );
  });

  it('rejects traversal, backslashes, NUL and drive letters', () => {
    for (const bad of ['../etc', 'a/../../b', 'a\\b', 'C:/x', 'a\0b']) {
      expect(() => normalizeContentsPath(bad), bad).toThrowError();
      try {
        normalizeContentsPath(bad);
      } catch (error) {
        expect(isCoreError(error) && error.code).toBe('INVALID_ARGUMENT');
      }
    }
  });
});

describe('encodeContentsPath', () => {
  it('encodes each segment but keeps the slashes', () => {
    expect(encodeContentsPath('dir with space/Untitled.ipynb')).toBe(
      'dir%20with%20space/Untitled.ipynb'
    );
    expect(encodeContentsPath('δοκιμή/x.ipynb')).toBe(
      `${encodeURIComponent('δοκιμή')}/x.ipynb`
    );
    // Characters that would otherwise change the URL structure.
    expect(encodeContentsPath('a#b/c?d/e+f')).toBe('a%23b/c%3Fd/e%2Bf');
  });
});

describe('encodeSessionPath', () => {
  it('encodes the whole path as one component, slashes included', () => {
    // jupyter-collaboration requests.ts uses encodeURIComponent(path);
    // Tornado's (.*) route unescapes %2F back into the path.
    expect(encodeSessionPath('dir/Untitled.ipynb')).toBe('dir%2FUntitled.ipynb');
    expect(encodeSessionPath('δοκιμή κατάλογος/Untitled.ipynb')).toContain('%2F');
    expect(encodeSessionPath('/leading/x.ipynb')).toBe('leading%2Fx.ipynb');
  });
});

describe('roomName', () => {
  it('is <format>:<type>:<fileId> with raw colons', () => {
    const name = roomName('11111111-2222-3333-4444-555555555555');
    expect(name).toBe('json:notebook:11111111-2222-3333-4444-555555555555');
    // Encoding it would silently open a different, empty room.
    expect(name).not.toContain('%3A');
  });
});

describe('base URLs', () => {
  it('keeps a /user/name prefix and drops trailing slashes', () => {
    expect(normalizeBaseUrl('https://h.example/jhub/user/alice/')).toBe(
      'https://h.example/jhub/user/alice'
    );
    expect(deriveWsBaseUrl('https://h.example/jhub/user/alice/')).toBe(
      'wss://h.example/jhub/user/alice'
    );
    expect(deriveWsBaseUrl('http://127.0.0.1:8896')).toBe('ws://127.0.0.1:8896');
    expect(joinUrl('http://127.0.0.1:8896/user/a/', '/api/status')).toBe(
      'http://127.0.0.1:8896/user/a/api/status'
    );
  });

  it('compares origins, not paths', () => {
    expect(isSameOrigin('http://h/a', 'http://h/b')).toBe(true);
    expect(isSameOrigin('http://h:1/a', 'http://h:2/a')).toBe(false);
    expect(isSameOrigin('http://h/a', 'https://h/a')).toBe(false);
    expect(isSameOrigin('not a url', 'http://h/a')).toBe(false);
  });
});

describe('validateNotebookName', () => {
  it('accepts one .ipynb name and rejects separators', () => {
    expect(validateNotebookName('analysis.ipynb')).toBe('analysis.ipynb');
    for (const bad of ['', 'a/b.ipynb', 'a\\b.ipynb', 'plain.txt', '..']) {
      expect(() => validateNotebookName(bad), bad).toThrowError();
    }
  });
});
