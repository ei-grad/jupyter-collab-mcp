/**
 * Output snapshots: interning, URIs, paging boundaries and expiry
 * (SPEC.md §9).
 */

import { describe, expect, it } from 'vitest';

import { isCoreError, type NbOutput } from '../../src/core/index.js';
import { OutputStore, outputUri, parseOutputUri, toOutputEntry } from '../../src/service/index.js';

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

  it('keeps an empty display bundle readable as empty text', () => {
    const store = new OutputStore('sess_1', 1024 * 1024);
    const snapshot = store.intern(ADDRESS, {
      output_type: 'display_data', data: {}, metadata: {}
    });
    expect(snapshot.mimeTypes).toEqual(['text/plain']);
    expect(snapshot.bytes.byteLength).toBe(0);
  });

  it('defaults to plain text and retains the image representation', () => {
    const store = new OutputStore('sess_1', 1024 * 1024);
    const snapshot = store.intern(ADDRESS, png);
    expect(snapshot.mimeType).toBe('text/plain');
    expect(snapshot.encoding).toBe('text');
    expect(snapshot.inlineImageAdvised).toBe(true);
    expect(snapshot.mimeTypes).toEqual(['image/png', 'text/plain']);
    expect(snapshot.bytes.toString('utf8')).toBe('<Figure>');
    expect(snapshot.representations.get('image/png')?.bytes.toString('base64')).toBe(PNG_BASE64);
  });

  it('keeps the default payload when another MIME variant exceeds the store budget', () => {
    const store = new OutputStore('sess_1', 64);
    const snapshot = store.intern(ADDRESS, {
      output_type: 'display_data',
      data: { 'text/plain': 'plain', 'text/html': 'x'.repeat(80) },
      metadata: {}
    });
    expect(snapshot.mimeTypes).toEqual(['text/plain']);
    expect(store.require(snapshot.outputId).bytes.toString()).toBe('plain');
    expect(store.usedBytes).toBe(5);
  });

  it('keeps each default payload when combined MIME variants exceed the budget', () => {
    const store = new OutputStore('sess_1', 24);
    const tx = store.begin();
    const output = (plain: string): NbOutput => ({
      output_type: 'display_data',
      data: { 'text/plain': plain, 'text/html': 'h'.repeat(12) },
      metadata: {}
    });
    const first = tx.intern(ADDRESS, output('first'));
    const second = tx.intern({ ...ADDRESS, index: 1 }, output('second'));
    tx.commit();
    expect(store.require(first.outputId).bytes.toString()).toBe('first');
    expect(store.require(second.outputId).bytes.toString()).toBe('second');
    expect(first.mimeTypes).toEqual(['text/plain']);
    expect(second.mimeTypes).toEqual(['text/plain', 'text/html']);
    expect(store.usedBytes).toBeLessThanOrEqual(24);
  });

  it('replaces a reused snapshot when its alternate MIME blocks a response', () => {
    const store = new OutputStore('sess_1', 24);
    const firstOutput: NbOutput = {
      output_type: 'display_data',
      data: { 'text/plain': 'first', 'text/html': 'h'.repeat(18) },
      metadata: {}
    };
    const original = store.intern(ADDRESS, firstOutput);
    const tx = store.begin();
    const first = tx.intern(ADDRESS, firstOutput);
    const entry = toOutputEntry(firstOutput, 0, { remaining: 0, maxOutputBytes: 0 }, ADDRESS, tx);
    const second = tx.intern({ ...ADDRESS, index: 1 }, {
      output_type: 'display_data',
      data: { 'text/plain': 'second', 'text/html': 'h' },
      metadata: {}
    });
    tx.commit();

    expect(first.outputId).not.toBe(original.outputId);
    expect(first.mimeTypes).toEqual(['text/plain']);
    expect(entry.mimeTypes).toEqual(['text/plain']);
    expect(entry.snapshot?.outputId).toBe(first.outputId);
    expect(store.peek(original.outputId)).toBeUndefined();
    expect(store.require(first.outputId).bytes.toString()).toBe('first');
    expect(store.require(second.outputId).bytes.toString()).toBe('second');
  });

  it('output entries advertise only retained MIME and image advice after commit', () => {
    const store = new OutputStore('sess_1', 10);
    const tx = store.begin();
    const entry = toOutputEntry(png, 0, { remaining: 0, maxOutputBytes: 0 }, ADDRESS, tx);
    tx.commit();
    expect(entry.snapshot?.mimeTypes).toEqual(['text/plain']);
    expect(entry.snapshot?.inlineImageAdvised).toBe(false);
    expect(entry.snapshot?.outputId).toBeTypeOf('string');
    expect(store.require(entry.snapshot!.outputId).bytes.toString()).toBe('<Figure>');
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
      traceback: ['\u001b[31mline one\u001b[0m', 'line two']
    });
    const text = snapshot.bytes.toString('utf8');
    expect(text).toContain('ValueError: boom');
    expect(text).toContain('line two');
    expect(text).not.toContain('\u001b');
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
    const store = new OutputStore('sess_1', 64);
    const first = store.intern(ADDRESS, { ...stream, text: 'a'.repeat(64) } as NbOutput);
    const second = store.intern({ ...ADDRESS, index: 1 }, { ...stream, text: 'b'.repeat(64) } as NbOutput);
    let code = 'no-error';
    try {
      store.require(first.outputId);
    } catch (error) {
      code = isCoreError(error) ? error.code : 'other';
    }
    expect(code).toBe('HANDLE_EXPIRED');
    expect(store.require(second.outputId).bytes.toString('utf8')).toBe('b'.repeat(64));
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
