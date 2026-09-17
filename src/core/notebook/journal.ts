/**
 * Bounded change journal of one notebook replica (SPEC.md §10).
 *
 * The journal is a fixed-size ring of {@link ChangeEvent}. Sequences are
 * contiguous and monotonic from 1, so a `chg_<seq>` cursor is valid exactly
 * while the ring still holds every event after it; otherwise `notebook_changes`
 * must answer `CURSOR_EXPIRED` and the agent takes a fresh snapshot.
 *
 * Output updates are coalesced per cell: a mutable pending record collects the
 * latest `outputs_revision` and is published at most once per
 * `coalesceMs` (100 ms by default). Published sequences are never rewritten.
 * Source, structure and generation boundaries flush the pending record of the
 * affected cell first, so a coalesced output update can never appear after the
 * event that superseded it (SPEC.md §10).
 *
 * Source text and base64 payloads are never copied here - only revisions.
 *
 * @module
 */

import { coreError } from '../errors.js';
import type { ChangeEvent, ChangeKind, ChangeRevisions, ChangesCursor } from '../types.js';
import { makeChangesCursor, parseChangesCursor } from '../types.js';

/** Everything but the sequence, which the journal assigns. */
export type ChangeDraft = Omit<ChangeEvent, 'sequence'>;

/** Journal construction options; all have SPEC.md §9 defaults. */
export interface ChangeJournalOptions {
  /** Ring capacity. SPEC.md §9 default: 10 000 events per notebook. */
  readonly limit?: number;
  /** Per-cell coalescing window for `outputs_changed`. SPEC.md §10: 100 ms. */
  readonly coalesceMs?: number;
  /** Injectable clock, for deterministic tests. */
  readonly now?: () => number;
}

/** Page of the journal returned by `notebook_changes` (SPEC.md §9). */
export interface ChangesPage {
  readonly events: readonly ChangeEvent[];
  readonly nextCursor: ChangesCursor;
}

interface Pending {
  readonly cellId: string;
  revisions: ChangeRevisionsSource;
  origin: 'local' | 'remote';
  dueAt: number;
}

type ChangeRevisionsSource = ChangeRevisions | (() => ChangeRevisions);

/** Default ring size (SPEC.md §9: "10,000 events in the notebook journal"). */
export const DEFAULT_JOURNAL_LIMIT = 10_000;
/** Default coalescing window (SPEC.md §10: "no more than once per 100 ms"). */
export const DEFAULT_COALESCE_MS = 100;

/**
 * Ring journal with per-cell output coalescing (SPEC.md §10).
 *
 * Not aware of Yjs: the model classifies changes and calls
 * {@link ChangeJournal.publish} / {@link ChangeJournal.recordOutputs}.
 */
export class ChangeJournal {
  readonly #limit: number;
  readonly #coalesceMs: number;
  readonly #now: () => number;
  readonly #ring: (ChangeEvent | undefined)[];
  readonly #pending = new Map<string, Pending>();
  readonly #lastPublished = new Map<string, number>();
  #last = 0;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #disposed = false;

  constructor(options: ChangeJournalOptions = {}) {
    this.#limit = Math.max(1, options.limit ?? DEFAULT_JOURNAL_LIMIT);
    this.#coalesceMs = Math.max(0, options.coalesceMs ?? DEFAULT_COALESCE_MS);
    this.#now = options.now ?? Date.now;
    this.#ring = new Array<ChangeEvent | undefined>(this.#limit);
  }

  /** Highest published sequence; `0` before anything happened. */
  get lastSequence(): number {
    return this.#last;
  }

  /** Oldest sequence still retrievable. */
  get oldestSequence(): number {
    return Math.max(1, this.#last - this.#limit + 1);
  }

  /** Cursor pointing at the current end of the journal (SPEC.md §9). */
  get cursor(): ChangesCursor {
    return makeChangesCursor(this.#last);
  }

  /** Append one event and return it with its assigned sequence. */
  publish(draft: ChangeDraft): ChangeEvent {
    const event: ChangeEvent = { ...draft, sequence: ++this.#last };
    this.#ring[(event.sequence - 1) % this.#limit] = event;
    return event;
  }

  /**
   * Record an `outputs_changed` for a cell, coalescing it (SPEC.md §10).
   *
   * Published immediately when the cell has not published within the window,
   * otherwise merged into the pending record and published by the timer.
   */
  recordOutputs(
    cellId: string,
    revisions: ChangeRevisionsSource,
    origin: 'local' | 'remote'
  ): void {
    const now = this.#now();
    const last = this.#lastPublished.get(cellId);
    const existing = this.#pending.get(cellId);
    if (existing) {
      existing.revisions = revisions;
      existing.origin = origin;
      this.#rearm();
      return;
    }
    if (last === undefined || now - last >= this.#coalesceMs) {
      this.#emitOutputs(cellId, revisions, origin, now);
      return;
    }
    this.#pending.set(cellId, { cellId, revisions, origin, dueAt: last + this.#coalesceMs });
    this.#rearm();
  }

  /** Publish the pending output record of one cell, if any (SPEC.md §10). */
  flushCell(cellId: string): void {
    const pending = this.#pending.get(cellId);
    if (!pending) return;
    this.#pending.delete(cellId);
    this.#emitOutputs(pending.cellId, pending.revisions, pending.origin, this.#now());
    this.#rearm();
  }

  /**
   * Forget the coalescing bookkeeping of an id that left the document.
   *
   * Any pending record is published first, so nothing is lost: a deletion
   * event must not be preceded by a silently dropped output update
   * (SPEC.md §10). Without this the per-cell timestamp map would grow with
   * every id a long-lived replica has ever seen.
   */
  forgetCell(cellId: string): void {
    this.flushCell(cellId);
    this.#lastPublished.delete(cellId);
  }

  /**
   * Publish every pending output record. Called before a snapshot, before a
   * structural event and at an execution generation boundary, so that a
   * `changes_cursor` handed out with a snapshot never hides an older change.
   */
  flush(): void {
    if (this.#pending.size === 0) return;
    const now = this.#now();
    const pendings = [...this.#pending.values()];
    this.#pending.clear();
    for (const pending of pendings) {
      this.#emitOutputs(pending.cellId, pending.revisions, pending.origin, now);
    }
    this.#rearm();
  }

  /** Is there anything waiting to be published? */
  get hasPending(): boolean {
    return this.#pending.size > 0;
  }

  /**
   * Events strictly after `cursor` (SPEC.md §9).
   *
   * @throws CoreError `CURSOR_EXPIRED` when the sequence fell out of the ring,
   * `INVALID_ARGUMENT` when the string is not a `chg_` cursor or points past
   * the end of the journal.
   */
  since(cursor: ChangesCursor | string, limit = this.#limit): ChangesPage {
    const from = parseChangesCursor(cursor);
    if (from === null) {
      throw coreError('INVALID_ARGUMENT', 'not a changes cursor; expected the "chg_<n>" form', {
        details: { cursor }
      });
    }
    if (from > this.#last) {
      throw coreError('INVALID_ARGUMENT', 'changes cursor is ahead of the journal', {
        details: { cursor, next_cursor: this.cursor }
      });
    }
    if (this.#last > 0 && from < this.oldestSequence - 1) {
      throw coreError('CURSOR_EXPIRED', 'change events after this cursor are no longer retained', {
        details: { cursor, oldest_sequence: this.oldestSequence, next_cursor: this.cursor }
      });
    }
    const take = Math.max(0, Math.min(limit, this.#last - from));
    const events: ChangeEvent[] = [];
    for (let sequence = from + 1; sequence <= from + take; sequence++) {
      const event = this.#ring[(sequence - 1) % this.#limit];
      if (event !== undefined) events.push(event);
    }
    const lastReturned = events.length > 0 ? events[events.length - 1]!.sequence : from;
    return { events, nextCursor: makeChangesCursor(lastReturned) };
  }

  /** Drop the coalescing timer. Idempotent; required so the process can exit. */
  dispose(): void {
    this.#disposed = true;
    this.#pending.clear();
    if (this.#timer !== null) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
  }

  #emitOutputs(
    cellId: string,
    revisions: ChangeRevisionsSource,
    origin: 'local' | 'remote',
    at: number
  ): void {
    const kind: ChangeKind = 'outputs_changed';
    this.publish({
      kind,
      cellId,
      revisions: typeof revisions === 'function' ? revisions() : revisions,
      origin
    });
    this.#lastPublished.set(cellId, at);
  }

  #rearm(): void {
    if (this.#timer !== null) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
    if (this.#disposed || this.#pending.size === 0) return;
    let earliest = Number.POSITIVE_INFINITY;
    for (const pending of this.#pending.values()) earliest = Math.min(earliest, pending.dueAt);
    const delay = Math.max(0, earliest - this.#now());
    this.#timer = setTimeout(() => {
      this.#timer = null;
      this.#onTimer();
    }, delay);
    // Never hold the event loop open: SPEC.md §4 requires the process to be
    // able to exit, and the spike showed a stray interval is enough to hang it.
    this.#timer.unref?.();
  }

  #onTimer(): void {
    if (this.#disposed) return;
    const now = this.#now();
    for (const pending of [...this.#pending.values()]) {
      if (pending.dueAt <= now) {
        this.#pending.delete(pending.cellId);
        this.#emitOutputs(pending.cellId, pending.revisions, pending.origin, now);
      }
    }
    this.#rearm();
  }
}
