/**
 * The single set of document observers of one replica (SPEC.md §6, §10).
 *
 * Two deep observers - one on the shared cells array, one on `ymeta` - are
 * installed once for the life of the model and removed on dispose. SPEC.md §6
 * requires exactly that: a reconnect must not accumulate observers.
 *
 * The observers do three things, in this order, inside every transaction:
 *
 * 1. rebuild the id index and publish the structural events (adds, deletes,
 *    `Y.Map` replacements under a retained id, server-side id renames), after
 *    flushing the pending output records - a structural boundary is one of the
 *    points SPEC.md §10 names;
 * 2. classify the per-cell events into source / metadata / outputs and publish
 *    them, flushing the coalesced outputs record of a cell before its own
 *    source or metadata event;
 * 3. invalidate the output-area generation of any cell whose outputs,
 *    `execution_count` or `execution_state` changed without our sink writing
 *    them - the "observable external execution/clear" rule of SPEC.md §8.
 *
 * Local and remote are told apart by `transaction.origin === origin`, backed by
 * {@link ObserverHost.isLocalTransaction} for the case where a caller opened
 * the surrounding transaction and Yjs therefore dropped our origin. Both are
 * only meaningful because every local write goes through
 * `ydoc.transact(fn, origin)` (spike/NOTES.md §3.2).
 *
 * @module
 */

import type { YNotebook } from '@jupyter/ydoc';
import type * as Y from 'yjs';

import { cellRevision, outputsRevision, sourceRevision } from '../revision.js';
import type { ChangeKind, ChangeRevisions } from '../types.js';
import type { CellEntry, CellIndex, StructureDiff } from './cell-index.js';
import type { GenerationRegistry } from './generations.js';
import type { ChangeJournal } from './journal.js';
import {
  cellJson,
  cellTypeOf,
  metadataRevisionOf,
  outputsOf,
  resolveCell,
  structureRevisionOf
} from './read.js';

/** What the observers need from the model. */
export interface ObserverHost {
  readonly notebook: YNotebook;
  readonly ycells: Y.Array<Y.Map<unknown>>;
  readonly ymeta: Y.Map<unknown>;
  readonly origin: object;
  readonly index: CellIndex;
  readonly journal: ChangeJournal;
  readonly generations: GenerationRegistry;
  isDisposed(): boolean;
  /**
   * Was this transaction opened - or joined - by our own writes? `tr.origin`
   * alone is not enough: Yjs ignores the origin of a nested `transact`, so a
   * caller that wraps `apply()` or an {@link OutputSink} write in its own
   * transaction would otherwise make our writes look remote.
   */
  isLocalTransaction(transaction: Y.Transaction): boolean;
}

/** Which child of a cell an event came through. */
type Aspect = 'model' | 'source' | 'metadata' | 'outputs' | 'other';

interface CellTouch {
  source: boolean;
  metadata: boolean;
  outputs: boolean;
  streamTextOnly: boolean;
  streamText: string;
}

/** The document observers of one {@link NotebookModel}. */
export class NotebookObserver {
  readonly #host: ObserverHost;

  constructor(host: ObserverHost) {
    this.#host = host;
  }

  /** Install both deep observers. Call once, from the constructor. */
  attach(): void {
    this.#host.ycells.observeDeep(this.onCells);
    this.#host.ymeta.observeDeep(this.onMeta);
  }

  /** Remove both deep observers. Idempotent in practice. */
  detach(): void {
    this.#host.ycells.unobserveDeep(this.onCells);
    this.#host.ymeta.unobserveDeep(this.onMeta);
  }

  readonly onCells = (events: Y.YEvent<Y.AbstractType<unknown>>[], tr: Y.Transaction): void => {
    if (this.#host.isDisposed()) return;
    const origin = this.#originOf(tr);

    // Locate every event once: which cell it belongs to and through which
    // child of that cell. `#locate` walks the CRDT parent chain, so it is valid
    // both before and after the index is rebuilt.
    const located = events.map((event) =>
      event.target === this.#host.ycells ? null : this.#locate(event.target)
    );
    const structural = events.some((event) => event.target === this.#host.ycells);
    const idKeyChanged = events.some(
      (event, position) => located[position]?.aspect === 'model' && keysOf(event)?.has('id') === true
    );

    const fresh = new Set<string>();
    if (structural || idKeyChanged) {
      this.#host.journal.flush();
      const diff = this.#host.index.rebuild();
      for (const token of diff.freshTokens) fresh.add(token);
      this.#publishStructure(diff, origin);
    }

    // Keyed by identity token, not by `cell_id`: a duplicated id addresses two
    // live cells, and both must keep producing journal events (SPEC.md §7,
    // §10). Only *addressing* is ambiguous, not observation.
    const touched = new Map<string, { entry: CellEntry; record: CellTouch }>();
    for (let position = 0; position < events.length; position++) {
      const place = located[position];
      if (place == null) continue;
      const entry = this.#host.index.entryOf(place.ymodel);
      if (entry === undefined) continue; // deleted in this very transaction
      // A cell announced as added or replaced is reported by that event alone;
      // its initial content is not a separate change (SPEC.md §10).
      if (fresh.has(entry.identityToken)) continue;
      const aspect = aspectFor(events[position]!, place.aspect);
      if (aspect === null) continue;
      const existing = touched.get(entry.identityToken);
      const record = existing?.record ?? {
        source: false,
        metadata: false,
        outputs: false,
        streamTextOnly: true,
        streamText: ''
      };
      if (aspect === 'source') record.source = true;
      else if (aspect === 'metadata') record.metadata = true;
      else if (aspect === 'outputs') record.outputs = true;
      if (aspect === 'outputs') {
        const streamText = insertedStreamText(events[position]!);
        if (streamText === null) record.streamTextOnly = false;
        else record.streamText += streamText;
      }
      touched.set(entry.identityToken, { entry, record });
    }

    for (const { entry, record } of touched.values()) {
      this.#publishCell(entry, record, origin, tr);
    }
  };

  readonly onMeta = (events: Y.YEvent<Y.AbstractType<unknown>>[], tr: Y.Transaction): void => {
    if (this.#host.isDisposed()) return;
    const metadata = this.#host.ymeta.get('metadata');
    const touched = events.some(
      (event) =>
        event.target === metadata ||
        (event.target === this.#host.ymeta && keysOf(event)?.has('metadata') === true)
    );
    if (!touched) return;
    this.#emit('notebook_metadata_changed', null, this.#originOf(tr), {
      notebookMetadataRevision: metadataRevisionOf(this.#host.notebook)
    });
  };

  #originOf(tr: Y.Transaction): 'local' | 'remote' {
    if (tr.origin === this.#host.origin) return 'local';
    return this.#host.isLocalTransaction(tr) ? 'local' : 'remote';
  }

  #publishCell(
    entry: CellEntry,
    record: CellTouch,
    origin: 'local' | 'remote',
    tr: Y.Transaction
  ): void {
    const cellId = entry.cellId;
    const cell = resolveCell(this.#host.notebook, entry);
    if (record.source) {
      this.#host.journal.flushCell(cellId);
      this.#emit('source_changed', cellId, origin, {
        sourceRevision: sourceRevision(cellTypeOf(cell), cell.getSource()),
        cellRevision: cellRevision(cellJson(cell))
      });
    }
    if (record.metadata) {
      this.#host.journal.flushCell(cellId);
      this.#emit('metadata_changed', cellId, origin, {
        cellRevision: cellRevision(cellJson(cell))
      });
    }
    if (record.outputs) {
      // A claimed stream-text transaction is the hot path and contains only
      // the sink's delta. Every other transaction must leave the exact state
      // remembered by the sink, including mixed writes in one outer transact.
      const claimedStreamDelta =
        record.streamTextOnly &&
        this.#host.generations.claimedStreamDeltaMatches(tr, cellId, record.streamText);
      if (!claimedStreamDelta && !this.#host.generations.matchesCurrentState(cellId)) {
        this.#host.generations.invalidate(cellId);
      }
      this.#host.journal.recordOutputs(
        cellId,
        () => ({
          outputsRevision: outputsRevision(outputsOf(cell)),
          cellRevision: cellRevision(cellJson(cell))
        }),
        origin
      );
    }
  }

  #publishStructure(diff: StructureDiff, origin: 'local' | 'remote'): void {
    const structureRevision = structureRevisionOf(this.#host.index);
    for (const cellId of diff.replaced) {
      this.#host.generations.invalidate(cellId);
      this.#emit('cell_replaced', cellId, origin, { structureRevision });
    }
    for (const rename of diff.renamed) {
      // The `Y.Map` survived but the address changed: old targets are dead and
      // the new id is a new address (SPEC.md §7 deduplication).
      this.#forgetIfGone(rename.from);
      this.#emit('cell_deleted', rename.from, origin, { structureRevision });
      this.#emit('cell_added', rename.to, origin, { structureRevision });
    }
    for (const cellId of diff.deleted) {
      this.#forgetIfGone(cellId);
      this.#emit('cell_deleted', cellId, origin, { structureRevision });
    }
    for (const cellId of diff.added) {
      this.#emit('cell_added', cellId, origin, { structureRevision });
    }
    if (diff.reordered) this.#emit('order_changed', null, origin, { structureRevision });
  }

  /**
   * Drop the per-cell bookkeeping of an id that left the document, so a
   * long-lived replica does not grow one journal timestamp and one generation
   * counter per id it has ever seen. An id that still addresses a live cell -
   * one half of a duplicate pair - only loses its generation.
   */
  #forgetIfGone(cellId: string): void {
    if (this.#host.index.all(cellId).length > 0) {
      this.#host.generations.invalidate(cellId);
      return;
    }
    this.#host.generations.forget(cellId);
    this.#host.journal.forgetCell(cellId);
  }

  #emit(
    kind: ChangeKind,
    cellId: string | null,
    origin: 'local' | 'remote',
    revisions: ChangeRevisions
  ): void {
    this.#host.journal.publish({
      kind,
      ...(cellId === null ? {} : { cellId }),
      revisions,
      origin
    });
  }

  /** Which cell a deep event belongs to, and through which child of it. */
  #locate(target: Y.AbstractType<unknown>): { ymodel: Y.Map<unknown>; aspect: Aspect } | null {
    let node: Y.AbstractType<unknown> | null = target;
    let child: Y.AbstractType<unknown> | null = null;
    while (node !== null) {
      const parent: Y.AbstractType<unknown> | null = node.parent;
      if (parent === this.#host.ycells) {
        const ymodel = node as Y.Map<unknown>;
        if (child === null) return { ymodel, aspect: 'model' };
        if (child === ymodel.get('source')) return { ymodel, aspect: 'source' };
        if (child === ymodel.get('metadata')) return { ymodel, aspect: 'metadata' };
        if (child === ymodel.get('outputs')) return { ymodel, aspect: 'outputs' };
        return { ymodel, aspect: 'other' };
      }
      child = node;
      node = parent;
    }
    return null;
  }
}

function insertedStreamText(event: Y.YEvent<Y.AbstractType<unknown>>): string | null {
  if (event.path[event.path.length - 1] !== 'text') return null;
  const delta = (event as { changes?: { delta?: Array<Record<string, unknown>> } }).changes?.delta;
  if (!Array.isArray(delta)) return null;
  let text = '';
  for (const part of delta) {
    if ('delete' in part || 'attributes' in part) return null;
    if ('insert' in part) {
      if (typeof part['insert'] !== 'string') return null;
      text += part['insert'];
    }
  }
  return text;
}

/** `keysChanged` of a `Y.YMapEvent`, or `undefined` for other event types. */
function keysOf(event: Y.YEvent<Y.AbstractType<unknown>>): Set<unknown> | undefined {
  return (event as { keysChanged?: Set<unknown> }).keysChanged;
}

/**
 * Journal aspect of one event; `null` when it carries nothing we publish.
 *
 * `execution_count` and `execution_state` are reported as an outputs change:
 * they belong to the output area and its prompt, and coalescing them with the
 * outputs is what keeps a long stream from flooding the journal (SPEC.md §10).
 */
function aspectFor(
  event: Y.YEvent<Y.AbstractType<unknown>>,
  aspect: Aspect
): keyof CellTouch | null {
  if (aspect === 'source') return 'source';
  if (aspect === 'metadata') return 'metadata';
  if (aspect === 'outputs') return 'outputs';
  if (aspect === 'other') return null;
  const keys = keysOf(event);
  if (keys === undefined) return null;
  if (keys.has('source') || keys.has('cell_type')) return 'source';
  if (keys.has('outputs') || keys.has('execution_count') || keys.has('execution_state')) {
    return 'outputs';
  }
  if (keys.has('metadata') || keys.has('attachments')) return 'metadata';
  return null;
}
