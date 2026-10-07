/**
 * What stood behind the revisions this replica handed out (SPEC.md §7).
 *
 * Revisions are content digests, so the value one names can be kept by digest
 * alone: whichever cell or read produced it, the same revision is the same
 * content. A guarded operation uses it as the base of what the caller saw -
 * `replace_source` merges against the observed source, a keyed metadata write
 * compares only the key it writes. A revision that was evicted, or never handed
 * out by this replica, has no base and falls back to an exact revision match.
 *
 * @module
 */

import type { MetadataObject } from './metadata.js';
import type { CellType } from '../types.js';

export interface RevisionHistoryLimits {
  /** Upper bound on retained content, in the units of the history's size function. */
  readonly maxSize?: number;
  /** Upper bound on retained revisions. */
  readonly maxEntries?: number;
}

const DEFAULT_MAX_SIZE = 8 * 1024 * 1024;
const DEFAULT_MAX_ENTRIES = 4096;

/** Bounded least-recently-used map from a revision to the value behind it. */
export class RevisionHistory<T> {
  readonly #sizeOf: (value: T) => number;
  readonly #maxSize: number;
  readonly #maxEntries: number;
  /** Insertion order is recency order: a hit is re-inserted at the end. */
  readonly #byRevision = new Map<string, { readonly value: T; readonly size: number }>();
  #size = 0;

  constructor(sizeOf: (value: T) => number, limits: RevisionHistoryLimits = {}) {
    this.#sizeOf = sizeOf;
    this.#maxSize = limits.maxSize ?? DEFAULT_MAX_SIZE;
    this.#maxEntries = limits.maxEntries ?? DEFAULT_MAX_ENTRIES;
  }

  has(revision: string): boolean {
    return this.#byRevision.has(revision);
  }

  /**
   * Remember the value behind a revision computed from it. `value` is called
   * only for a revision not held yet.
   */
  remember(revision: string, value: () => T): void {
    const known = this.#byRevision.get(revision);
    if (known !== undefined) {
      this.#byRevision.delete(revision);
      this.#byRevision.set(revision, known);
      return;
    }
    const content = value();
    const size = this.#sizeOf(content);
    if (size > this.#maxSize) return;
    this.#byRevision.set(revision, { value: content, size });
    this.#size += size;
    while (this.#size > this.#maxSize || this.#byRevision.size > this.#maxEntries) {
      const oldest = this.#byRevision.entries().next();
      if (oldest.done === true) break;
      this.#size -= oldest.value[1].size;
      this.#byRevision.delete(oldest.value[0]);
    }
  }

  get(revision: string): T | undefined {
    return this.#byRevision.get(revision)?.value;
  }

  get size(): number {
    return this.#byRevision.size;
  }
}

/** The text and cell type a source revision was computed from. */
export interface ObservedSource {
  readonly type: CellType;
  readonly source: string;
}

/** Bases a batch can be planned against. */
export interface ObservationHistory {
  /** By source revision. */
  readonly sources: RevisionHistory<ObservedSource>;
  /** Cell metadata by full-cell revision. */
  readonly cellMetadata: RevisionHistory<MetadataObject>;
  /** Notebook metadata by notebook metadata revision. */
  readonly notebookMetadata: RevisionHistory<MetadataObject>;
}

const jsonSize = (value: unknown): number => JSON.stringify(value)?.length ?? 0;

export function createObservationHistory(limits: RevisionHistoryLimits = {}): ObservationHistory {
  return {
    sources: new RevisionHistory<ObservedSource>((value) => value.source.length, limits),
    cellMetadata: new RevisionHistory<MetadataObject>(jsonSize, limits),
    notebookMetadata: new RevisionHistory<MetadataObject>(jsonSize, limits)
  };
}
