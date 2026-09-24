/**
 * Validation and planning of a `notebook_apply` batch (SPEC.md §7, §9).
 *
 * SPEC.md §7: "A notebook_apply batch is first validated in full against the
 * current replica, then applied in one synchronous Yjs transaction, without
 * `await` between validation and writing. ... All expected errors must be
 * detected before the first mutation."
 *
 * This module is the "before the first mutation" half. It walks the batch
 * against a **simulation** of the replica - the current cells plus the effect
 * of the earlier operations of the same batch - so that an anchor added by
 * operation 1 exists for operation 2 and an index recorded for operation 3 is
 * the index the document will really have. Nothing here touches Yjs.
 *
 * @module
 */

import { randomUUID } from 'node:crypto';

import type { YNotebook } from '@jupyter/ydoc';

import { coreError, redactCredentials } from '../errors.js';
import type { JsonValue } from '../revision.js';
import {
  cellRevision,
  isRevisionOfKind,
  notebookMetadataRevision,
  outputsRevision,
  sourceRevision
} from '../revision.js';
import type { CellType, NbOutput, OperationKind } from '../types.js';
import type { CellEntry, CellIndex } from './cell-index.js';
import { cellJson, resolveCell } from './read.js';
import { deleteAtPath, normalizePath, setAtPath } from './metadata.js';
import type { MetadataObject } from './metadata.js';
import type { ModelOperation } from './types.js';
import { findSingleOccurrence, minimalReplace, previewOf } from './text.js';
import type { TextEdit } from './text.js';

/** Mutable nbformat cell JSON used by the simulation. */
export type CellJsonObject = Record<string, unknown>;

/** One cell of the simulated document. */
export interface SimCell {
  readonly id: string;
  /** `null` for a cell this batch creates; the executor then uses its handle. */
  readonly entry: CellEntry | null;
  /** Current simulated state, including the effect of earlier operations. */
  json: CellJsonObject;
  /**
   * State at the start of the batch. A revision guard accepts either this or
   * the current simulated value: SPEC.md §7 validates a batch "against the
   * current replica", and a later operation on a cell an earlier one already changed
   * cannot possibly quote a revision this batch has not produced yet.
   */
  readonly original: CellJsonObject;
  /**
   * How many operations of this batch already changed the source.
   *
   * The leniency above exists for *chained* edits; it must not extend to a
   * whole-source overwrite of a value the same batch already replaced, which
   * would drop the earlier text with no error and no way for the caller to
   * notice - see {@link Simulation.guard}.
   */
  sourceEdits: number;
}

/** Bound and redact a conflict preview (SPEC.md §7, §11). */
const CONFLICT_PREVIEW_CHARS = 120;
function boundedPreview(text: string): string {
  return previewOf(redactCredentials(text), CONFLICT_PREVIEW_CHARS);
}

/** Preview of an output area: shape only, never a payload (SPEC.md §9). */
function outputsPreview(outputs: readonly NbOutput[]): string {
  if (outputs.length === 0) return 'no outputs';
  const kinds = outputs.slice(0, 8).map((output) => output.output_type);
  const more = outputs.length > kinds.length ? ', …' : '';
  return `${outputs.length} output(s): ${kinds.join(', ')}${more}`;
}

/** Preview of a metadata object: its keys, never their values (SPEC.md §11). */
function metadataPreview(metadata: MetadataObject): string {
  const keys = Object.keys(metadata).sort();
  if (keys.length === 0) return 'no metadata keys';
  return boundedPreview(`keys: ${keys.join(', ')}`);
}

/** A concrete instruction for the executor; all addressing already resolved. */
export type PlannedOp =
  | { readonly kind: 'insert'; readonly op: OperationKind; readonly at: number; readonly cell: SimCell }
  | { readonly kind: 'text'; readonly op: OperationKind; readonly target: SimCell; readonly edit: TextEdit }
  | { readonly kind: 'delete'; readonly op: OperationKind; readonly at: number; readonly target: SimCell }
  | { readonly kind: 'clear'; readonly op: OperationKind; readonly target: SimCell }
  | {
      readonly kind: 'cell_meta';
      readonly op: OperationKind;
      readonly target: SimCell;
      readonly topKey: string;
      readonly removeTop: boolean;
      readonly value: unknown;
    }
  | {
      readonly kind: 'nb_meta';
      readonly op: OperationKind;
      readonly topKey: string;
      readonly removeTop: boolean;
      readonly value: unknown;
    }
  | { readonly kind: 'noop'; readonly op: OperationKind; readonly target: SimCell | null };

/** Outcome of planning: instructions plus the ids each operation reports. */
export interface Plan {
  readonly ops: readonly PlannedOp[];
  /** Target cell id per operation, aligned with the input array. */
  readonly targets: readonly (string | null)[];
}

function asObject(value: unknown): MetadataObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? ({ ...(value as MetadataObject) } as MetadataObject)
    : {};
}

function cellTypeOfJson(json: CellJsonObject): CellType {
  const raw = json['cell_type'];
  return raw === 'code' || raw === 'markdown' || raw === 'raw' ? raw : 'raw';
}

function sourceOfJson(json: CellJsonObject): string {
  const raw = json['source'];
  if (typeof raw === 'string') return raw;
  return Array.isArray(raw) ? raw.join('') : '';
}

function outputsOfJson(json: CellJsonObject): NbOutput[] {
  const raw = json['outputs'];
  return Array.isArray(raw) ? (raw as NbOutput[]) : [];
}

function observationDetails(cell: SimCell): Record<string, unknown> {
  if (cell.entry === null) return { cell_id: cell.id };
  // Planning is all-or-nothing: on a validation error none of the simulated
  // earlier operations are applied, so the refresh ref must describe the
  // actual pre-batch object rather than an unreachable simulated state.
  const type = cellTypeOfJson(cell.original);
  return {
    cell_id: cell.id,
    identity_token: cell.entry.identityToken,
    source_revision: sourceRevision(type, sourceOfJson(cell.original)),
    cell_revision: cellRevision(cell.original as JsonValue),
    outputs_revision: type === 'code' ? outputsRevision(outputsOfJson(cell.original)) : null
  };
}

function requireTargetIdentity(cell: SimCell, expected: string | undefined): void {
  if (expected === undefined) return;
  if (cell.entry === null || cell.entry.identityToken !== expected) {
    throw coreError('CELL_REPLACED', `cell ${JSON.stringify(cell.id)} was replaced`, {
      details: { cell_id: cell.id }
    });
  }
}

/** The simulated document a batch is validated against. */
class Simulation {
  readonly order: SimCell[];
  #metadata: MetadataObject;
  #originalMetadata: MetadataObject = {};

  constructor(notebook: YNotebook, index: CellIndex) {
    this.order = index.entries.map((entry) => {
      const json = cellJson(resolveCell(notebook, entry)) as CellJsonObject;
      // A shallow copy is enough: every mutation below replaces a top-level
      // property with a freshly built value and never edits one in place.
      return { id: entry.cellId, entry, json, original: { ...json }, sourceEdits: 0 };
    });
    this.#metadata = asObject(notebook.getMetadata());
    this.#originalMetadata = this.#metadata;
  }

  get metadata(): MetadataObject {
    return this.#metadata;
  }

  /** Notebook metadata as it stood before the batch started. */
  get originalMetadata(): MetadataObject {
    return this.#originalMetadata;
  }

  set metadata(value: MetadataObject) {
    this.#metadata = value;
  }

  find(cellId: string): { cell: SimCell; at: number } {
    const hits: { cell: SimCell; at: number }[] = [];
    for (let at = 0; at < this.order.length; at++) {
      const cell = this.order[at]!;
      if (cell.id === cellId) hits.push({ cell, at });
    }
    if (hits.length === 0) {
      throw coreError('CELL_NOT_FOUND', `no cell with id ${JSON.stringify(cellId)}`, {
        details: { cell_id: cellId }
      });
    }
    if (hits.length > 1) {
      throw coreError(
        'CELL_ID_AMBIGUOUS',
        `cell id ${JSON.stringify(cellId)} addresses ${hits.length} cells`,
        { details: { cell_id: cellId, indices: hits.map((hit) => hit.at) } }
      );
    }
    return hits[0]!;
  }

  /**
   * Check one `expected_*` revision (SPEC.md §7).
   *
   * Accepts the value the replica had when the batch started as well as the
   * simulated value after the earlier operations of the same batch, so a batch
   * may touch one cell twice while still refusing a genuinely stale revision.
   *
   * `strict` switches that leniency off for a *destructive* repeat: a second
   * full `replace_source` of one cell quoting the pre-batch revision would
   * silently discard what the first one wrote, and the caller could not tell -
   * `applied_locally` would be `true` and both results would report the final
   * revision. A chained `replace_text` is anchored on text that must still be
   * there, so it stays lenient.
   *
   * The error carries the current revision **and** a bounded preview, which is
   * what SPEC.md §7 asks for: "return `REVISION_CONFLICT` with the current
   * revision and a bounded preview, without changing anything." The preview passes through
   * {@link redactCredentials} (SPEC.md §11).
   */
  guard(
    expected: string,
    current: string,
    original: string,
    details: Record<string, unknown>,
    preview: () => string,
    strict = false
  ): void {
    if (expected === current) return;
    if (!strict && expected === original) return;
    throw coreError(
      'REVISION_CONFLICT',
      strict
        ? 'the expected revision predates an earlier operation of this batch'
        : 'the expected revision does not match the replica',
      { details: { ...details, expected, current, preview: preview() } }
    );
  }
}

function requireKind(value: string, kind: Parameters<typeof isRevisionOfKind>[1], what: string): void {
  if (!isRevisionOfKind(value, kind)) {
    throw coreError('INVALID_ARGUMENT', `${what} is not a ${kind} revision`, {
      details: { value }
    });
  }
}

function anchorIndex(sim: Simulation, operation: Extract<ModelOperation, { op: 'add_cell' }>): number {
  // Read the anchors as plain values: narrowing the union would make the
  // "not exactly one anchor" branch unreachable at the type level, while the
  // operation can still arrive as arbitrary JSON.
  const anchored = operation as {
    beforeCellId?: unknown;
    beforeCellIdentityToken?: unknown;
    afterCellId?: unknown;
    afterCellIdentityToken?: unknown;
    position?: unknown;
  };
  const anchors = [
    anchored.beforeCellId === undefined ? null : 'before_cell_id',
    anchored.afterCellId === undefined ? null : 'after_cell_id',
    anchored.position === undefined ? null : 'position'
  ].filter((value) => value !== null);
  if (anchors.length !== 1) {
    throw coreError(
      'INVALID_ARGUMENT',
      'add_cell needs exactly one of before_cell_id, after_cell_id or position:"end"',
      { details: { anchors } }
    );
  }
  if (anchored.position !== undefined) {
    if (anchored.position !== 'end') {
      throw coreError('INVALID_ARGUMENT', 'add_cell position must be "end"', {
        details: { position: anchored.position }
      });
    }
    return sim.order.length;
  }
  if (typeof anchored.beforeCellId === 'string') {
    const anchor = sim.find(anchored.beforeCellId);
    requireAnchorIdentity(anchor.cell.entry, anchored.beforeCellIdentityToken, anchored.beforeCellId);
    return anchor.at;
  }
  if (typeof anchored.afterCellId === 'string') {
    const anchor = sim.find(anchored.afterCellId);
    requireAnchorIdentity(anchor.cell.entry, anchored.afterCellIdentityToken, anchored.afterCellId);
    return anchor.at + 1;
  }
  throw coreError('INVALID_ARGUMENT', 'add_cell anchor must be a cell id string');
}

function requireAnchorIdentity(entry: CellEntry | null, expected: unknown, cellId: string): void {
  if (expected === undefined) return;
  if (typeof expected !== 'string' || entry === null || entry.identityToken !== expected) {
    throw coreError('CELL_REPLACED', `anchor ${JSON.stringify(cellId)} was replaced`, {
      details: { cell_id: cellId }
    });
  }
}

/**
 * Validate the whole batch and produce the executor's instructions.
 *
 * @throws CoreError before any mutation - `CELL_NOT_FOUND`,
 * `CELL_ID_AMBIGUOUS`, `CELL_REPLACED`, `REVISION_CONFLICT`,
 * `MATCH_NOT_FOUND`, `MATCH_NOT_UNIQUE`, `INVALID_ARGUMENT` or
 * `UNSUPPORTED_OPERATION` (SPEC.md §7, §9).
 */
export function planOperations(
  notebook: YNotebook,
  index: CellIndex,
  operations: readonly ModelOperation[]
): Plan {
  const sim = new Simulation(notebook, index);
  const ops: PlannedOp[] = [];
  const targets: (string | null)[] = [];

  for (const operation of operations) {
    switch (operation.op) {
      case 'add_cell': {
        const at = anchorIndex(sim, operation);
        if (
          operation.cellType !== 'code' &&
          operation.cellType !== 'markdown' &&
          operation.cellType !== 'raw'
        ) {
          throw coreError('INVALID_ARGUMENT', 'add_cell cell_type must be code, markdown or raw', {
            details: { cell_type: operation.cellType }
          });
        }
        const id = randomUUID();
        const metadata = asObject(operation.metadata);
        const json: CellJsonObject = {
          id,
          cell_type: operation.cellType,
          source: operation.source,
          metadata,
          ...(operation.cellType === 'code' ? { outputs: [], execution_count: null } : {})
        };
        const cell: SimCell = { id, entry: null, json, original: { ...json }, sourceEdits: 0 };
        sim.order.splice(at, 0, cell);
        ops.push({ kind: 'insert', op: 'add_cell', at, cell });
        targets.push(id);
        break;
      }
      case 'replace_source': {
        requireKind(operation.expectedSourceRevision, 'source', 'expected_source_revision');
        const { cell } = sim.find(operation.cellId);
        requireTargetIdentity(cell, operation.expectedCellIdentityToken);
        const type = cellTypeOfJson(cell.json);
        const current = sourceOfJson(cell.json);
        sim.guard(
          operation.expectedSourceRevision,
          sourceRevision(type, current),
          sourceRevision(cellTypeOfJson(cell.original), sourceOfJson(cell.original)),
          observationDetails(cell),
          () => boundedPreview(current),
          // A full overwrite of a source this batch already rewrote must quote
          // the value it is overwriting, not the pre-batch one.
          operation.expectedCellIdentityToken !== undefined || cell.sourceEdits > 0
        );
        const edit = minimalReplace(current, operation.source);
        cell.json['source'] = operation.source;
        cell.sourceEdits++;
        ops.push(
          edit === null
            ? { kind: 'noop', op: 'replace_source', target: cell }
            : { kind: 'text', op: 'replace_source', target: cell, edit }
        );
        targets.push(cell.id);
        break;
      }
      case 'replace_text': {
        requireKind(operation.expectedSourceRevision, 'source', 'expected_source_revision');
        const { cell } = sim.find(operation.cellId);
        requireTargetIdentity(cell, operation.expectedCellIdentityToken);
        const type = cellTypeOfJson(cell.json);
        const current = sourceOfJson(cell.json);
        sim.guard(
          operation.expectedSourceRevision,
          sourceRevision(type, current),
          sourceRevision(cellTypeOfJson(cell.original), sourceOfJson(cell.original)),
          observationDetails(cell),
          () => boundedPreview(current),
          operation.expectedCellIdentityToken !== undefined
        );
        const found = findSingleOccurrence(current, operation.oldText);
        if (found.kind === 'not_found') {
          throw coreError('MATCH_NOT_FOUND', 'old_text does not occur in the cell source', {
            details: observationDetails(cell)
          });
        }
        if (found.kind === 'not_unique') {
          throw coreError('MATCH_NOT_UNIQUE', 'old_text occurs more than once in the cell source', {
            details: { ...observationDetails(cell), occurrences: found.count }
          });
        }
        const edit: TextEdit = {
          index: found.index,
          deleteCount: operation.oldText.length,
          insert: operation.newText
        };
        cell.json['source'] =
          current.slice(0, found.index) +
          operation.newText +
          current.slice(found.index + operation.oldText.length);
        cell.sourceEdits++;
        ops.push(
          edit.deleteCount === 0 && edit.insert.length === 0
            ? { kind: 'noop', op: 'replace_text', target: cell }
            : { kind: 'text', op: 'replace_text', target: cell, edit }
        );
        targets.push(cell.id);
        break;
      }
      case 'delete_cell': {
        requireKind(operation.expectedCellRevision, 'cell', 'expected_cell_revision');
        const { cell, at } = sim.find(operation.cellId);
        requireTargetIdentity(cell, operation.expectedCellIdentityToken);
        sim.guard(
          operation.expectedCellRevision,
          cellRevision(cell.json as JsonValue),
          cellRevision(cell.original as JsonValue),
          observationDetails(cell),
          () => boundedPreview(sourceOfJson(cell.json)),
          operation.expectedCellIdentityToken !== undefined
        );
        sim.order.splice(at, 1);
        ops.push({ kind: 'delete', op: 'delete_cell', at, target: cell });
        targets.push(cell.id);
        break;
      }
      case 'clear_outputs': {
        requireKind(operation.expectedOutputsRevision, 'outputs', 'expected_outputs_revision');
        const { cell } = sim.find(operation.cellId);
        requireTargetIdentity(cell, operation.expectedCellIdentityToken);
        if (cellTypeOfJson(cell.json) !== 'code') {
          throw coreError('INVALID_ARGUMENT', 'clear_outputs targets a cell with no output area', {
            details: { cell_id: operation.cellId, cell_type: cellTypeOfJson(cell.json) }
          });
        }
        const outputs = outputsOfJson(cell.json);
        sim.guard(
          operation.expectedOutputsRevision,
          outputsRevision(outputs),
          outputsRevision(outputsOfJson(cell.original)),
          observationDetails(cell),
          () => outputsPreview(outputs),
          operation.expectedCellIdentityToken !== undefined
        );
        cell.json['outputs'] = [];
        ops.push(
          outputs.length === 0
            ? { kind: 'noop', op: 'clear_outputs', target: cell }
            : { kind: 'clear', op: 'clear_outputs', target: cell }
        );
        targets.push(cell.id);
        break;
      }
      case 'set_cell_metadata':
      case 'delete_cell_metadata': {
        requireKind(operation.expectedCellRevision, 'cell', 'expected_cell_revision');
        const remove = operation.op === 'delete_cell_metadata';
        if (!remove && operation.value === undefined) {
          throw coreError('INVALID_ARGUMENT', 'set_cell_metadata value must not be undefined');
        }
        const path = normalizePath(operation.key);
        const { cell } = sim.find(operation.cellId);
        requireTargetIdentity(cell, operation.expectedCellIdentityToken);
        sim.guard(
          operation.expectedCellRevision,
          cellRevision(cell.json as JsonValue),
          cellRevision(cell.original as JsonValue),
          observationDetails(cell),
          () => metadataPreview(asObject(cell.json['metadata'])),
          operation.expectedCellIdentityToken !== undefined
        );
        const before = asObject(cell.json['metadata']);
        const after = remove ? deleteAtPath(before, path) : setAtPath(before, path, operation.value);
        cell.json['metadata'] = after;
        const topKey = path[0]!;
        ops.push({
          kind: 'cell_meta',
          op: operation.op,
          target: cell,
          topKey,
          removeTop: !(topKey in after),
          value: after[topKey]
        });
        targets.push(cell.id);
        break;
      }
      case 'set_notebook_metadata':
      case 'delete_notebook_metadata': {
        requireKind(
          operation.expectedNotebookMetadataRevision,
          'notebookMetadata',
          'expected_notebook_metadata_revision'
        );
        const remove = operation.op === 'delete_notebook_metadata';
        if (!remove && operation.value === undefined) {
          throw coreError('INVALID_ARGUMENT', 'set_notebook_metadata value must not be undefined');
        }
        const path = normalizePath(operation.key);
        const currentMetadataRevision = notebookMetadataRevision(
          sim.metadata as Record<string, JsonValue | undefined>
        );
        const liveMetadataRevision = notebookMetadataRevision(
          sim.originalMetadata as Record<string, JsonValue | undefined>
        );
        sim.guard(
          operation.expectedNotebookMetadataRevision,
          currentMetadataRevision,
          liveMetadataRevision,
          { notebook_metadata_revision: liveMetadataRevision },
          () => metadataPreview(sim.metadata),
          operation.expectedNotebookObserved === true
        );
        const after = remove
          ? deleteAtPath(sim.metadata, path)
          : setAtPath(sim.metadata, path, operation.value);
        sim.metadata = after;
        const topKey = path[0]!;
        ops.push({
          kind: 'nb_meta',
          op: operation.op,
          topKey,
          removeTop: !(topKey in after),
          value: after[topKey]
        });
        targets.push(null);
        break;
      }
      default: {
        const unsupported = operation as { op: string };
        throw coreError('UNSUPPORTED_OPERATION', `unknown operation ${unsupported.op}`, {
          details: { op: unsupported.op }
        });
      }
    }
  }

  return { ops, targets };
}
