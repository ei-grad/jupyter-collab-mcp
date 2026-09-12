/**
 * Key-path helpers for the metadata operations of SPEC.md §7.
 *
 * `set_cell_metadata` / `delete_cell_metadata` and their notebook-level twins
 * address **one key**; every other key must survive untouched (SPEC.md §7,
 * SPEC.md §12 "Document data"). A key path addresses a nested key without
 * making the caller rewrite the whole parent object by hand.
 *
 * All functions are pure: they return a new plain object and never mutate the
 * input, so a value read out of the shared model is never aliased into it.
 *
 * @module
 */

import { coreError } from '../errors.js';
import type { MetadataKeyPath } from './types.js';

/** A JSON object as it appears in cell/notebook metadata. */
export type MetadataObject = Record<string, unknown>;

/**
 * Normalise a key or key path.
 *
 * @throws CoreError `INVALID_ARGUMENT` for an empty path or an empty segment -
 * neither addresses a key, and both would silently rewrite a parent object.
 */
export function normalizePath(key: MetadataKeyPath): string[] {
  const path = typeof key === 'string' ? [key] : [...key];
  if (path.length === 0) {
    throw coreError('INVALID_ARGUMENT', 'metadata key path must have at least one segment');
  }
  for (const segment of path) {
    if (typeof segment !== 'string' || segment.length === 0) {
      throw coreError('INVALID_ARGUMENT', 'metadata key path segments must be non-empty strings', {
        details: { key_path: path }
      });
    }
  }
  return path;
}

function isPlainObject(value: unknown): value is MetadataObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Value at a key path, or `undefined` when any segment is missing. */
export function getAtPath(root: MetadataObject, path: readonly string[]): unknown {
  let current: unknown = root;
  for (const segment of path) {
    if (!isPlainObject(current)) return undefined;
    current = current[segment];
  }
  return current;
}

/**
 * Copy of `root` with `value` at `path`, creating missing intermediate objects.
 *
 * @throws CoreError `INVALID_ARGUMENT` when an intermediate segment exists but
 * is not an object: overwriting it would destroy data the caller did not name.
 */
export function setAtPath(
  root: MetadataObject,
  path: readonly string[],
  value: unknown
): MetadataObject {
  const [head, ...rest] = path;
  if (head === undefined) throw coreError('INVALID_ARGUMENT', 'empty metadata key path');
  const copy: MetadataObject = { ...root };
  if (rest.length === 0) {
    copy[head] = value;
    return copy;
  }
  const child = copy[head];
  if (child !== undefined && !isPlainObject(child)) {
    throw coreError(
      'INVALID_ARGUMENT',
      `metadata key ${JSON.stringify(head)} is not an object; refusing to overwrite it`,
      { details: { key_path: [...path] } }
    );
  }
  copy[head] = setAtPath(isPlainObject(child) ? child : {}, rest, value);
  return copy;
}

/**
 * Copy of `root` with the key at `path` removed. Missing keys are a no-op, so
 * a repeated `delete_cell_metadata` is idempotent; the revision guard, not this
 * function, is what protects against a concurrent change.
 *
 * An emptied parent object is kept: SPEC.md §7 deletes the named key only.
 */
export function deleteAtPath(root: MetadataObject, path: readonly string[]): MetadataObject {
  const [head, ...rest] = path;
  if (head === undefined) throw coreError('INVALID_ARGUMENT', 'empty metadata key path');
  if (!(head in root)) return { ...root };
  const copy: MetadataObject = { ...root };
  if (rest.length === 0) {
    delete copy[head];
    return copy;
  }
  const child = copy[head];
  if (!isPlainObject(child)) return copy;
  copy[head] = deleteAtPath(child, rest);
  return copy;
}
