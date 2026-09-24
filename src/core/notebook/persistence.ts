/** Canonical persisted notebook projection; not an RTC revision or raw-file hash. */
import { createHash } from 'node:crypto';
import type { YNotebook } from '@jupyter/ydoc';
import * as Y from 'yjs';
import { canonicalJson, type JsonValue } from '../revision.js';

type ObjectValue = Record<string, unknown>;
export const SAVE_CONFIRMATION_MAX_BYTES = 16 * 1024 * 1024;
const object = (value: unknown): value is ObjectValue =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

function multiline(value: unknown): unknown {
  return Array.isArray(value) && value.every(part => typeof part === 'string')
    ? value.join('') : value;
}

function mimeBundle(value: unknown): void {
  if (!object(value)) return;
  for (const key of Object.keys(value)) {
    // JSON MIME values can be genuine arrays of strings, not multiline text.
    if (key === 'application/json' || key.endsWith('+json')) continue;
    value[key] = multiline(value[key]);
  }
}

/** Capture all persisted cell fields, including fields absent from cell.toJSON(). */
export function captureNotebookPersistence(notebook: YNotebook, maxBytes = SAVE_CONFIRMATION_MAX_BYTES): string | null {
  return notebookPersistenceDigest({
    nbformat: notebook.nbformat,
    nbformat_minor: notebook.nbformat_minor,
    metadata: notebook.ymeta.get('metadata'),
    cells: notebook.ydoc.getArray('cells')
  }, maxBytes);
}

/** Invalid/unsupported representations cannot confirm persistence. */
export function notebookPersistenceDigest(value: unknown, maxBytes = SAVE_CONFIRMATION_MAX_BYTES): string | null {
  const notebook = boundedJsonCopy(value, maxBytes);
  if (!object(notebook) || notebook['nbformat'] !== 4 ||
      !Number.isInteger(notebook['nbformat_minor']) || Number(notebook['nbformat_minor']) < 0 ||
      !object(notebook['metadata']) || !Array.isArray(notebook['cells'])) return null;
  for (const entry of notebook['cells'] as unknown[]) {
    if (!object(entry) || !['code', 'raw', 'markdown'].includes(String(entry['cell_type'])) ||
        !object(entry['metadata'])) return null;
    const source = multiline(entry['source']);
    if (typeof source !== 'string') return null;
    entry['source'] = source;
    delete entry['execution_state'];
    delete entry['metadata']['trusted'];
    // These omissions match the collaboration server's notebook serializer.
    if (Number(notebook['nbformat_minor']) <= 4) delete entry['id'];
    if (entry['cell_type'] === 'raw' || entry['cell_type'] === 'markdown') {
      if (object(entry['attachments']) && Object.keys(entry['attachments']).length === 0) {
        delete entry['attachments'];
      }
    }
    if (object(entry['attachments'])) {
      for (const bundle of Object.values(entry['attachments'])) mimeBundle(bundle);
    }
    if (Array.isArray(entry['outputs'])) {
      for (const output of entry['outputs']) {
        if (!object(output)) return null;
        if (output['output_type'] === 'stream') output['text'] = multiline(output['text']);
        mimeBundle(output['data']);
      }
    }
  }
  return `sha256:${createHash('sha256').update(canonicalJson(notebook as JsonValue)).digest('hex')}`;
}

/** Copy raw Y types and JSON incrementally; no complete cell/metadata materialization. */
function boundedJsonCopy(value: unknown, limit: number): unknown {
  let bytes = 0;
  let unsupported = false;
  const addString = (text: string): void => {
    bytes += 2 + Buffer.byteLength(text);
    if (bytes > limit) return;
    for (let i = 0; i < text.length; i++) {
      const code = text.charCodeAt(i);
      if (code === 34 || code === 92 || [8, 9, 10, 12, 13].includes(code)) bytes++;
      else if (code < 32) bytes += 5;
      else if (code >= 0xd800 && code <= 0xdfff) {
        const paired = code <= 0xdbff
          ? text.charCodeAt(i + 1) >= 0xdc00 && text.charCodeAt(i + 1) <= 0xdfff
          : text.charCodeAt(i - 1) >= 0xd800 && text.charCodeAt(i - 1) <= 0xdbff;
        if (!paired) bytes += 3;
      }
      if (bytes > limit) return;
    }
  };
  const visit = (entry: unknown): unknown => {
    if (bytes > limit || unsupported) return null;
    if (entry instanceof Y.Text) {
      // UTF-16 length is a lower bound on UTF-8 JSON bytes. Reject an oversized
      // shared string before toString builds it from its CRDT fragments.
      if (entry.length + 2 > limit - bytes) { bytes = limit + 1; return null; }
      return visit(entry.toString());
    }
    if (typeof entry === 'string') { addString(entry); return entry; }
    if (entry === null || entry === undefined) { bytes += 4; return null; }
    if (typeof entry === 'number' || typeof entry === 'boolean') {
      const scalar = typeof entry === 'number' && !Number.isFinite(entry) ? null : entry;
      bytes += JSON.stringify(scalar).length;
      return scalar;
    }
    if (Array.isArray(entry) || entry instanceof Y.Array) {
      bytes += 2 + Math.max(0, entry.length - 1);
      if (bytes > limit) return null;
      const result: unknown[] = [];
      for (const child of entry) {
        result.push(visit(child));
        if (bytes > limit || unsupported) return null;
      }
      return result;
    }
    if (object(entry) && (entry instanceof Y.Map ||
        Object.getPrototypeOf(entry) === Object.prototype || Object.getPrototypeOf(entry) === null)) {
      bytes += 2;
      if (bytes > limit) return null;
      // Own-property dictionaries preserve keys such as __proto__ through
      // normalization and canonical hashing, without invoking legacy setters.
      const result: ObjectValue = Object.create(null) as ObjectValue;
      let first = true;
      const copyEntry = (key: string, child: unknown): void => {
        if (child === undefined) return;
        bytes += first ? 1 : 2; first = false;
        addString(key);
        if (bytes <= limit) result[key] = visit(child);
      };
      if (entry instanceof Y.Map) {
        for (const [key, child] of entry) {
          copyEntry(key, child);
          if (bytes > limit || unsupported) return null;
        }
      } else {
        for (const key in entry) {
          if (!Object.hasOwn(entry, key)) continue;
          copyEntry(key, entry[key]);
          if (bytes > limit || unsupported) return null;
        }
      }
      return result;
    }
    unsupported = true;
    return null;
  };
  try {
    const copy = visit(value);
    return bytes > limit || unsupported ? null : copy;
  } catch (error) {
    // Extremely deep JSON cannot be safely projected by the recursive
    // normalizer/canonical encoder; it supplies no confirmation evidence.
    if (error instanceof RangeError) return null;
    throw error;
  }
}
