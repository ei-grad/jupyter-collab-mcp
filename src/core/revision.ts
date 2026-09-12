/**
 * Revision digests (SPEC.md §7).
 *
 * `notebook_read` returns, per cell, `source_revision`, `cell_revision` and
 * `outputs_revision`, plus a document-wide `notebook_metadata_revision`; every
 * mutating operation carries the matching `expected_*` value. A revision is an
 * **opaque digest**: the agent compares it, never parses it.
 *
 * Guarantees this module provides:
 *
 * 1. *Deterministic* - the same logical value always yields the same string,
 *    inside one API version. Key order in the input object is irrelevant.
 * 2. *Kind-tagged* - the kind is both a visible prefix (`s1_`, `o1_`, `c1_`,
 *    `m1_`, `x1_`) and part of the hashed pre-image, so a source digest can
 *    never be mistaken for, or collide with, an outputs digest.
 * 3. *Independent* - `source_revision` covers only the cell type and its exact
 *    text, so changing outputs does not change it (SPEC.md §7: an outputs
 *    change must not move `source_revision`). Changing the cell type does.
 * 4. *Full length* - sha-256 encoded as base64url, 43 characters, never
 *    shortened. SPEC.md §7 forbids using a short display hash as the guard
 *    against stale edits.
 *
 * The only dependency is `node:crypto`.
 *
 * @module
 */

import { createHash } from 'node:crypto';

import type { CellType, NbOutput } from './types.js';

/** JSON value accepted by the canonical serialiser. */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue | undefined };

/**
 * Digest of `{cell_type, source}` (SPEC.md §7).
 * Prefix `s1_`. Invalidated by an edit or a type change, not by outputs.
 */
export type SourceRevision = string & { readonly __revision: 'source' };

/** Digest of the cell's `outputs` array only (SPEC.md §7). Prefix `o1_`. */
export type OutputsRevision = string & { readonly __revision: 'outputs' };

/**
 * Digest of the whole nbformat cell JSON - type, source, metadata,
 * attachments, execution_count and outputs (SPEC.md §7). Prefix `c1_`.
 * Required as `expected_cell_revision` by `delete_cell` and by the cell
 * metadata operations.
 */
export type CellRevision = string & { readonly __revision: 'cell' };

/**
 * Digest of notebook-level `metadata` (SPEC.md §7). Prefix `m1_`.
 * Transient state/awareness is not part of it.
 */
export type NotebookMetadataRevision = string & { readonly __revision: 'notebookMetadata' };

/**
 * Digest of the ordered list of cell ids (the "structural revision" of
 * SPEC.md §6/§7). Prefix `x1_`. Page cursors are bound to it: any add, delete
 * or reorder expires them with `CURSOR_EXPIRED`.
 */
export type StructureRevision = string & { readonly __revision: 'structure' };

/** Any of the five digests. */
export type Revision =
  | SourceRevision
  | OutputsRevision
  | CellRevision
  | NotebookMetadataRevision
  | StructureRevision;

/** Kind tag; selects the three-character prefix. */
export type RevisionKind = 'source' | 'outputs' | 'cell' | 'notebookMetadata' | 'structure';

const PREFIX: Readonly<Record<RevisionKind, string>> = Object.freeze({
  source: 's1_',
  outputs: 'o1_',
  cell: 'c1_',
  notebookMetadata: 'm1_',
  structure: 'x1_'
});

/** Public view of the prefixes, e.g. for tests and diagnostics. */
export const REVISION_PREFIX = PREFIX;

/** Length of the base64url sha-256 body, without the kind prefix. */
export const REVISION_BODY_LENGTH = 43;

/**
 * Canonical JSON serialisation: object keys sorted by code unit, no
 * insignificant whitespace, `undefined` properties dropped (as
 * `JSON.stringify` does), `undefined` array elements encoded as `null`.
 *
 * Non-finite numbers become `null`, matching `JSON.stringify`, so a value that
 * cannot survive a round trip through the shared model cannot silently produce
 * two different digests either.
 *
 * The result is not meant to be re-parsed; it exists only as a stable hash
 * pre-image.
 */
export function canonicalJson(value: JsonValue | undefined): string {
  return encode(value);
}

function encode(value: JsonValue | undefined): string {
  if (value === undefined || value === null) return 'null';
  switch (typeof value) {
    case 'string':
      return JSON.stringify(value);
    case 'number':
      return Number.isFinite(value) ? JSON.stringify(value) : 'null';
    case 'boolean':
      return value ? 'true' : 'false';
    default:
      break;
  }
  if (Array.isArray(value)) {
    const items: string[] = [];
    for (const item of value as readonly JsonValue[]) items.push(encode(item));
    return `[${items.join(',')}]`;
  }
  const record = value as { readonly [key: string]: JsonValue | undefined };
  const keys = Object.keys(record).sort();
  const parts: string[] = [];
  for (const key of keys) {
    const entry = record[key];
    if (entry === undefined) continue;
    parts.push(`${JSON.stringify(key)}:${encode(entry)}`);
  }
  return `{${parts.join(',')}}`;
}

/**
 * sha-256 over `<kind> <canonical json>`, base64url, full 43 characters,
 * prefixed by the kind tag. The kind is inside the pre-image as well, so two
 * kinds can never produce the same body for the same payload.
 */
function digest(kind: RevisionKind, payload: JsonValue): string {
  const hash = createHash('sha256');
  hash.update(kind, 'utf8');
  hash.update(' ', 'utf8');
  hash.update(encode(payload), 'utf8');
  return PREFIX[kind] + hash.digest('base64url');
}

/**
 * `source_revision`: the exact text plus the cell type (SPEC.md §7).
 *
 * Outputs, metadata, attachments and `execution_count` are deliberately
 * excluded, so a running cell whose outputs are being rewritten keeps a stable
 * `expected_source_revision` for `notebook_execute` (SPEC.md §8).
 */
export function sourceRevision(cellType: CellType, source: string): SourceRevision {
  return digest('source', { cell_type: cellType, source }) as SourceRevision;
}

/**
 * `outputs_revision`: the nbformat `outputs` array as it stands in the shared
 * model. Markdown and raw cells have no output area; pass `[]` only when a
 * code cell genuinely has an empty one.
 */
export function outputsRevision(outputs: readonly NbOutput[]): OutputsRevision {
  return digest('outputs', outputs as unknown as readonly JsonValue[]) as OutputsRevision;
}

/**
 * `cell_revision`: the full nbformat cell object, exactly as it would be
 * serialised - including keys this client does not understand, because
 * SPEC.md §12 requires unknown metadata and attachments to survive a
 * read/edit round trip.
 */
export function cellRevision(fullCellJson: JsonValue): CellRevision {
  return digest('cell', fullCellJson) as CellRevision;
}

/** `notebook_metadata_revision`: notebook-level metadata only (SPEC.md §7). */
export function notebookMetadataRevision(metadata: {
  readonly [key: string]: JsonValue | undefined;
}): NotebookMetadataRevision {
  return digest('notebookMetadata', metadata) as NotebookMetadataRevision;
}

/**
 * Structural revision over the ordered cell ids.
 *
 * Duplicated ids are kept as they are: a document with a duplicate genuinely
 * has a different structure from one without, and the client never rewrites
 * ids itself (SPEC.md §7).
 */
export function structureRevision(orderedCellIds: readonly string[]): StructureRevision {
  return digest('structure', orderedCellIds as readonly JsonValue[]) as StructureRevision;
}

/** Which kind a digest claims to be, or `null` if it is not one of ours. */
export function revisionKind(value: string): RevisionKind | null {
  for (const kind of Object.keys(PREFIX) as RevisionKind[]) {
    if (value.startsWith(PREFIX[kind])) return kind;
  }
  return null;
}

/**
 * Shape check to run before comparing a caller-supplied `expected_*` value:
 * a digest of the wrong kind is an `INVALID_ARGUMENT`, not a
 * `REVISION_CONFLICT`.
 */
export function isRevisionOfKind(value: unknown, kind: RevisionKind): boolean {
  return (
    typeof value === 'string' &&
    value.startsWith(PREFIX[kind]) &&
    value.length === PREFIX[kind].length + REVISION_BODY_LENGTH
  );
}
