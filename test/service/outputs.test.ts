/**
 * Output snapshots: interning, URIs, paging boundaries and expiry
 * (SPEC.md §9).
 */

import { describe, expect, it } from 'vitest';

import { isCoreError, type NbOutput } from '../../src/core/index.js';
import { OutputStore, outputUri, parseOutputUri } from '../../src/service/index.js';

const ADDRESS = { notebookId: 'nb_1', executionId: 'exec_1', cellId: 'c1', index: 0 };

const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const stream: NbOutput = { output_type: 'stream', name: 'stdout', text: 'hello world\n' };
const png: NbOutput = {
  output_type: 'display_data',
  data: { 'image/png': PNG_BASE64, 'text/plain': '<Figure>' },
  metadata: {}
};

describe('OutputStore', () => {
  it('interns the same output once and reuses its id', () => {
    const store = new OutputStore('sess_1', 1024 * 1024);
    const a = store.intern(ADDRESS, stream);
    const b = store.intern(ADDRESS, stream);
    expect(b.outputId).toBe(a.outputId);
    expect(store.size).toBe(1);
  });

  it('a changed payload at the same address becomes a new snapshot', () => {
    const store = new OutputStore('sess_1', 1024 * 1024);
    const a = store.intern(ADDRESS, stream);
    const b = store.intern(ADDRESS, { ...stream, text: 'different\n' } as NbOutput);
    expect(b.outputId).not.toBe(a.outputId);
  });

  it('picks the richest MIME type and decodes a base64 image', () => {
    const store = new OutputStore('sess_1', 1024 * 1024);
    const snapshot = store.intern(ADDRESS, png);
    expect(snapshot.mimeType).toBe('image/png');
    expect(snapshot.encoding).toBe('base64');
    expect(snapshot.inlineImageAdvised).toBe(true);
    expect(snapshot.mimeTypes).toEqual(['image/png', 'text/plain']);
    expect(snapshot.bytes.toString('base64')).toBe(PNG_BASE64);
  });

  it('a stream snapshot is text and keeps the exact bytes', () => {
    const store = new OutputStore('sess_1', 1024 * 1024);
    const snapshot = store.intern(ADDRESS, stream);
    expect(snapshot.encoding).toBe('text');
    expect(snapshot.mimeType).toBe('text/plain');
    expect(snapshot.bytes.toString('utf8')).toBe('hello world\n');
    expect(snapshot.inlineImageAdvised).toBe(false);
  });

  it('an error snapshot carries ename, evalue and the traceback', () => {
    const store = new OutputStore('sess_1', 1024 * 1024);
    const snapshot = store.intern(ADDRESS, {
      output_type: 'error',
      ename: 'ValueError',
      evalue: 'boom',
      traceback: ['line one', 'line two']
    });
    const text = snapshot.bytes.toString('utf8');
    expect(text).toContain('ValueError: boom');
    expect(text).toContain('line two');
  });

  it('the URI carries no credential and round-trips', () => {
    const store = new OutputStore('sess_secret', 1024 * 1024);
    const snapshot = store.intern(ADDRESS, stream);
    expect(snapshot.uri).toBe(outputUri('sess_secret', snapshot.outputId));
    expect(snapshot.uri).not.toContain('token');
    expect(parseOutputUri(snapshot.uri)).toEqual({
      sessionId: 'sess_secret',
      outputId: snapshot.outputId
    });
  });

  it('also accepts the short jupyter-output:<id> form and rejects others', () => {
    expect(parseOutputUri('jupyter-output:out_9')).toEqual({ sessionId: null, outputId: 'out_9' });
    expect(parseOutputUri('https://example.org/out_9')).toBeNull();
    expect(parseOutputUri('jupyter-output:')).toBeNull();
  });

  it('an evicted snapshot answers HANDLE_EXPIRED', () => {
    const store = new OutputStore('sess_1', 16);
    const first = store.intern(ADDRESS, { ...stream, text: 'a'.repeat(64) } as NbOutput);
    store.intern({ ...ADDRESS, index: 1 }, { ...stream, text: 'b'.repeat(64) } as NbOutput);
    let code = 'no-error';
    try {
      store.require(first.outputId);
    } catch (error) {
      code = isCoreError(error) ? error.code : 'other';
    }
    expect(code).toBe('HANDLE_EXPIRED');
  });

  it('clear() drops everything, as session_close does', () => {
    const store = new OutputStore('sess_1', 1024 * 1024);
    store.intern(ADDRESS, stream);
    store.clear();
    expect(store.size).toBe(0);
    expect(store.usedBytes).toBe(0);
    expect(store.peek('anything')).toBeUndefined();
  });
});
