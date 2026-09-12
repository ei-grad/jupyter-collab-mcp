/**
 * `cell_id` index over the shared cells array (SPEC.md §7, §6 "External file
 * changes").
 *
 * Three facts the rest of the module depends on:
 *
 * 1. `cell_id` is the durable address; the index is for display and for
 *    building ordered lists (SPEC.md §7).
 * 2. An id may legitimately appear twice. The duplicate blocks only the
 *    operations that address it or use it as an anchor
 *    (`CELL_ID_AMBIGUOUS`); every other cell keeps working. The client never
 *    rewrites ids to resolve the ambiguity.
 * 3. A string id is **not** proof that the CRDT object survived. An external
 *    write (`aset` from the server after a file change) can replace a cell's
 *    `Y.Map` while keeping its id; JupyterLab's own `moveCells` does the same.
 *    Every cell therefore carries an *identity token* bound to the `Y.Map`
 *    object, and a token change is what turns an old reference into
 *    `CELL_REPLACED`.
 *
 * @module
 */

import { randomUUID } from 'node:crypto';

import type * as Y from 'yjs';

import { coreError } from '../errors.js';
import type { CellRef } from '../types.js';

/** A cell reference that also pins the CRDT object identity (SPEC.md §6). */
export interface IdentifiedCellRef extends CellRef {
  /**
   * Opaque token of the underlying `Y.Map`. Stable while the object lives;
   * a different token for the same `cell_id` means the cell was replaced.
   */
  readonly identityToken: string;
}

/** One entry of the index. */
export interface CellEntry extends IdentifiedCellRef {
  readonly ymodel: Y.Map<unknown>;
}

/** What a structural rebuild found, for the journal (SPEC.md §10). */
export interface StructureDiff {
  /** Ids whose cell object is new and had no predecessor under that id. */
  readonly added: readonly string[];
  /** Ids that disappeared and were not replaced under the same id. */
  readonly deleted: readonly string[];
  /**
   * Ids whose `Y.Map` object was swapped while the id stayed - the case that
   * invalidates references, subscriptions and output generations even though
   * the string id is unchanged (SPEC.md §6).
   */
  readonly replaced: readonly string[];
  /**
   * Cells whose `Y.Map` survived but whose `cell_id` changed. SPEC.md §7: when
   * `jupyter_ydoc` serialises a document with duplicated ids it assigns one of
   * them a fresh UUID and writes it into the live shared model, so the client
   * must follow the rename, update the index and invalidate the old targets.
   */
  readonly renamed: readonly { readonly from: string; readonly to: string }[];
  /** True when the same set of objects is present in a different order. */
  readonly reordered: boolean;
  /**
   * Identity tokens of the cell objects this rebuild reported as new - the
   * `added` and `replaced` ones plus the renamed cells, whose id is new.
   *
   * The journal skips content events for those cells, because an added cell is
   * announced by `cell_added` alone (SPEC.md §10). Tokens, not ids: with a
   * duplicated `cell_id` one of the two objects can be fresh while the other
   * is an old cell whose edits must still be journalled - SPEC.md §7:
   * "other unambiguously addressable cells continue to work."
   */
  readonly freshTokens: readonly string[];
}

const EMPTY_DIFF: StructureDiff = Object.freeze({
  added: Object.freeze([]),
  deleted: Object.freeze([]),
  replaced: Object.freeze([]),
  renamed: Object.freeze([]),
  reordered: false,
  freshTokens: Object.freeze([])
});

/**
 * Ordered id index with object identity tracking (SPEC.md §7).
 *
 * `rebuild()` is called on every structural change and on an observed `id`
 * key change; it returns the diff the journal publishes.
 */
export class CellIndex {
  readonly #ycells: Y.Array<Y.Map<unknown>>;
  readonly #tokens = new WeakMap<Y.Map<unknown>, string>();
  #entries: CellEntry[] = [];
  #byId = new Map<string, CellEntry[]>();
  #byModel = new WeakMap<Y.Map<unknown>, CellEntry>();

  constructor(ycells: Y.Array<Y.Map<unknown>>) {
    this.#ycells = ycells;
    this.rebuild();
  }

  /** Current ordered entries. */
  get entries(): readonly CellEntry[] {
    return this.#entries;
  }

  /** Ordered `cell_id` list; the pre-image of the structural revision. */
  get orderedIds(): string[] {
    return this.#entries.map((entry) => entry.cellId);
  }

  /** Ids that currently appear more than once (SPEC.md §7 diagnostics). */
  get duplicateIds(): string[] {
    const out: string[] = [];
    for (const [id, entries] of this.#byId) if (entries.length > 1) out.push(id);
    return out;
  }

  /** Number of cells. */
  get size(): number {
    return this.#entries.length;
  }

  /** Entry at a position, or `undefined`. */
  at(index: number): CellEntry | undefined {
    return this.#entries[index];
  }

  /** All entries carrying this id (0, 1 or - for a duplicate - more). */
  all(cellId: string): readonly CellEntry[] {
    return this.#byId.get(cellId) ?? [];
  }

  /** True when the id currently addresses exactly one cell. */
  isUnique(cellId: string): boolean {
    return (this.#byId.get(cellId) ?? []).length === 1;
  }

  /** Identity token of a `Y.Map`, if the index has seen it. */
  tokenOf(ymodel: Y.Map<unknown>): string | undefined {
    return this.#tokens.get(ymodel);
  }

  /** Entry of a shared cell object, or `undefined` once it left the document. */
  entryOf(ymodel: Y.Map<unknown>): CellEntry | undefined {
    return this.#byModel.get(ymodel);
  }

  /**
   * Resolve an id to its single entry.
   *
   * @throws CoreError `CELL_NOT_FOUND` when nothing carries the id,
   * `CELL_ID_AMBIGUOUS` when more than one cell does (SPEC.md §7: the client
   * must not silently pick the first object).
   */
  require(cellId: string): CellEntry {
    const entries = this.#byId.get(cellId) ?? [];
    if (entries.length === 0) {
      throw coreError('CELL_NOT_FOUND', `no cell with id ${JSON.stringify(cellId)}`, {
        details: { cell_id: cellId }
      });
    }
    if (entries.length > 1) {
      throw coreError(
        'CELL_ID_AMBIGUOUS',
        `cell id ${JSON.stringify(cellId)} addresses ${entries.length} cells`,
        { details: { cell_id: cellId, indices: entries.map((entry) => entry.index) } }
      );
    }
    return entries[0]!;
  }

  /**
   * Resolve a previously handed out reference.
   *
   * @throws CoreError `CELL_REPLACED` when the id still exists but its CRDT
   * object was swapped - the case an execution target must not survive
   * (SPEC.md §6, §7).
   */
  requireSame(ref: IdentifiedCellRef): CellEntry {
    const entry = this.require(ref.cellId);
    if (entry.identityToken !== ref.identityToken) {
      throw coreError(
        'CELL_REPLACED',
        `cell ${JSON.stringify(ref.cellId)} was replaced by a different shared object`,
        { details: { cell_id: ref.cellId } }
      );
    }
    return entry;
  }

  /**
   * Recompute the index from the shared array and report what changed.
   *
   * Cheap enough to run on every structural transaction: one pass over the
   * cells array, no cell content is read apart from the `id` key.
   */
  rebuild(): StructureDiff {
    const previous = this.#entries;
    const models = this.#ycells.toArray();
    const entries: CellEntry[] = [];
    const byId = new Map<string, CellEntry[]>();
    const byModel = new WeakMap<Y.Map<unknown>, CellEntry>();
    for (let index = 0; index < models.length; index++) {
      const ymodel = models[index]!;
      let identityToken = this.#tokens.get(ymodel);
      if (identityToken === undefined) {
        identityToken = `cid_${randomUUID()}`;
        this.#tokens.set(ymodel, identityToken);
      }
      const rawId = ymodel.get('id');
      const cellId = typeof rawId === 'string' ? rawId : '';
      const entry: CellEntry = { cellId, index, identityToken, ymodel };
      entries.push(entry);
      byModel.set(ymodel, entry);
      const bucket = byId.get(cellId);
      if (bucket) bucket.push(entry);
      else byId.set(cellId, [entry]);
    }
    this.#entries = entries;
    this.#byId = byId;
    this.#byModel = byModel;
    return diff(previous, entries);
  }
}

function diff(before: readonly CellEntry[], after: readonly CellEntry[]): StructureDiff {
  const beforeByToken = new Map(before.map((entry) => [entry.identityToken, entry] as const));
  const beforeTokens = new Set(before.map((entry) => entry.identityToken));
  const afterTokens = new Set(after.map((entry) => entry.identityToken));

  const goneIds = new Map<string, number>();
  for (const entry of before) {
    if (!afterTokens.has(entry.identityToken)) {
      goneIds.set(entry.cellId, (goneIds.get(entry.cellId) ?? 0) + 1);
    }
  }
  const added: string[] = [];
  const replaced: string[] = [];
  const renamed: { from: string; to: string }[] = [];
  const freshTokens: string[] = [];
  for (const entry of after) {
    if (beforeTokens.has(entry.identityToken)) {
      const was = beforeByToken.get(entry.identityToken);
      if (was !== undefined && was.cellId !== entry.cellId) {
        renamed.push({ from: was.cellId, to: entry.cellId });
        freshTokens.push(entry.identityToken);
      }
      continue;
    }
    freshTokens.push(entry.identityToken);
    const pendingGone = goneIds.get(entry.cellId) ?? 0;
    if (pendingGone > 0) {
      goneIds.set(entry.cellId, pendingGone - 1);
      replaced.push(entry.cellId);
    } else {
      added.push(entry.cellId);
    }
  }
  const deleted: string[] = [];
  for (const [cellId, count] of goneIds) {
    for (let i = 0; i < count; i++) deleted.push(cellId);
  }

  let reordered = false;
  if (added.length === 0 && deleted.length === 0 && replaced.length === 0) {
    reordered =
      before.length !== after.length ||
      before.some((entry, index) => entry.identityToken !== after[index]?.identityToken);
  }
  const result: StructureDiff = { added, deleted, replaced, renamed, reordered, freshTokens };
  return isEmptyDiff(result) ? EMPTY_DIFF : result;
}

/** True when the diff reports no structural change at all. */
export function isEmptyDiff(diffResult: StructureDiff): boolean {
  return (
    diffResult.added.length === 0 &&
    diffResult.deleted.length === 0 &&
    diffResult.replaced.length === 0 &&
    diffResult.renamed.length === 0 &&
    !diffResult.reordered
  );
}
