import { describe, expect, it } from 'vitest';

import {
  WireBudgetError,
  boundPayload,
  boundText,
  camelKey,
  fromWire,
  jsonByteSize,
  snakeKey,
  toWire
} from '../../src/mcp/index.js';
import type { WireObject } from '../../src/mcp/wire.js';

describe('key naming', () => {
  const pairs: [string, string][] = [
    ['notebookId', 'notebook_id'],
    ['cellRef', 'cell_ref'],
    ['nbformatMinor', 'nbformat_minor'],
    ['jupyterSessionId', 'jupyter_session_id'],
    ['waitMs', 'wait_ms'],
    ['uri', 'uri']
  ];
  for (const [camel, snake] of pairs) {
    it(`${camel} <-> ${snake}`, () => {
      expect(snakeKey(camel)).toBe(snake);
      expect(camelKey(snake)).toBe(camel);
    });
  }
});

describe('toWire / fromWire', () => {
  it('renames nested keys and drops undefined members', () => {
    expect(
      toWire({ notebookId: 'nb', summary: { cellCount: 2, pageCursor: undefined, cells: [{ cellRef: '@c' }] } })
    ).toEqual({ notebook_id: 'nb', summary: { cell_count: 2, cells: [{ cell_ref: '@c' }] } });
  });

  it('leaves metadata, value, output and details untouched', () => {
    const value = {
      metadata: { 'user/Weird Key': { nestedCamel: 1 } },
      value: { alsoCamel: [1] },
      output: { output_type: 'display_data', data: { 'image/png': 'AAA' }, metadata: {} },
      details: { current_cell_ref: '@cell-ref' }
    };
    expect(toWire(value)).toEqual(value);
    expect(fromWire(value)).toEqual(value);
  });

  it('is the inverse of itself for our own keys', () => {
    const camel = { notebookId: 'nb', cells: [{ cellRef: '@cell-ref' }] };
    expect(fromWire(toWire(camel))).toEqual(camel);
  });
});

describe('boundText', () => {
  it('keeps short text as it is', () => {
    expect(boundText('hello', 100)).toEqual({ text: 'hello', truncated: false });
  });

  it('cuts long text on a code point boundary and says so', () => {
    const result = boundText('界'.repeat(200), 64);
    expect(result.truncated).toBe(true);
    expect(jsonByteSize(result.text)).toBeLessThanOrEqual(64 + 2);
    expect(result.text).toContain('text truncated');
    expect(result.text).not.toContain('�');
  });
});

describe('boundPayload', () => {
  it('returns a fitting payload unchanged', () => {
    const payload = { a: 1 } as unknown as WireObject;
    expect(boundPayload(payload, 1024)).toEqual({ payload, truncated: false });
  });

  it('drops an inlined output that has an output_id, and says how to read it', () => {
    const payload = {
      cells: [
        {
          outputs: [
            {
              index: 0,
              output_type: 'display_data',
              mime_types: ['image/png'],
              byte_size: 5000,
              truncated: false,
              output: { output_type: 'display_data', data: { 'image/png': 'A'.repeat(5000) }, metadata: {} },
              snapshot: { output_id: 'out_1', uri: 'jupyter-output:out_1' }
            }
          ]
        }
      ]
    } as unknown as WireObject;
    const bounded = boundPayload(payload, 512);
    expect(bounded.truncated).toBe(true);
    expect(jsonByteSize(bounded.payload)).toBeLessThanOrEqual(512);
    const entry = (bounded.payload as unknown as { cells: { outputs: Record<string, unknown>[] }[] }).cells[0]
      ?.outputs[0];
    expect(entry?.['output']).toBeUndefined();
    expect(entry?.['truncated']).toBe(true);
    expect(entry?.['snapshot']).toEqual({ output_id: 'out_1', uri: 'jupyter-output:out_1' });
    expect(bounded.readMore).toContain('output_read');
  });

  it('refuses to slice a list whose omitted records have no usable cursor', () => {
    const payload = {
      entries: Array.from({ length: 200 }, (_unused, index) => ({ path: `f${String(index)}`, note: 'x'.repeat(100) }))
    } as unknown as WireObject;
    expect(() => boundPayload(payload, 2048)).toThrow(WireBudgetError);
  });

  it('never mutates the payload it was given', () => {
    const payload = { entries: Array.from({ length: 100 }, () => ({ note: 'x'.repeat(100) })) } as unknown as WireObject;
    const before = JSON.stringify(payload);
    expect(() => boundPayload(payload, 512)).toThrow(WireBudgetError);
    expect(JSON.stringify(payload)).toBe(before);
  });

  it('never treats arrays inside notebook metadata as pageable protocol fields', () => {
    const payload = {
      notebook_metadata: {
        events: Array.from({ length: 50 }, (_unused, sequence) => ({ sequence, note: 'x'.repeat(30) }))
      },
      next_cursor: 'chg_50'
    } as unknown as WireObject;
    const before = JSON.stringify(payload);
    expect(() => boundPayload(payload, 600)).toThrow(WireBudgetError);
    expect(JSON.stringify(payload)).toBe(before);
  });
});
