/**
 * In-memory test rig for `src/core/notebook`.
 *
 * Two `YNotebook`s wired through `Y.applyUpdate` behave exactly like two RTC
 * clients in one room: that is what makes "remote edit", "concurrent edit" and
 * the `aset`-style external rewrite of SPEC.md §6 testable without a server.
 * The bridge is manual by default so a test can hold updates back and create a
 * genuine concurrent divergence.
 */

import { YNotebook } from '@jupyter/ydoc';
import type { YCodeCell } from '@jupyter/ydoc';
import * as Y from 'yjs';

import { NotebookModel } from '../../../src/core/notebook/index.js';
import type { NotebookModelOptions } from '../../../src/core/notebook/index.js';

/** Origin used when an update is replayed into the peer document. */
export const REMOTE_ORIGIN = 'test-remote';

export interface Peer {
  readonly notebook: YNotebook;
  readonly model: NotebookModel;
  readonly origin: object;
  dispose(): void;
}

/** A notebook seeded with `content`, plus a model observing it. */
export function makePeer(
  content?: Record<string, unknown>,
  options: Partial<NotebookModelOptions> = {}
): Peer {
  const notebook = new YNotebook();
  if (content !== undefined) {
    notebook.setSource(content as never);
  }
  const origin = options.origin ?? { peer: Symbol('peer') };
  const model = new NotebookModel(notebook, { ...options, origin });
  return {
    notebook,
    model,
    origin,
    dispose(): void {
      model.dispose();
      notebook.dispose();
    }
  };
}

/** Manual two-way update bridge between two documents. */
export class Bridge {
  readonly #a: Y.Doc;
  readonly #b: Y.Doc;
  readonly #toB: Uint8Array[] = [];
  readonly #toA: Uint8Array[] = [];
  #auto = false;

  constructor(a: Y.Doc, b: Y.Doc) {
    this.#a = a;
    this.#b = b;
    a.on('update', this.#onA);
    b.on('update', this.#onB);
  }

  /** Exchange full state both ways, like the initial Yjs sync. */
  syncInitial(): void {
    Y.applyUpdate(this.#b, Y.encodeStateAsUpdate(this.#a), REMOTE_ORIGIN);
    Y.applyUpdate(this.#a, Y.encodeStateAsUpdate(this.#b), REMOTE_ORIGIN);
    this.#toA.length = 0;
    this.#toB.length = 0;
  }

  /** Deliver every update immediately, like a healthy connection. */
  setAuto(auto: boolean): void {
    this.#auto = auto;
    if (auto) this.flush();
  }

  /** Deliver everything queued in both directions until both sides are quiet. */
  flush(): void {
    while (this.#toA.length > 0 || this.#toB.length > 0) {
      this.deliverToB();
      this.deliverToA();
    }
  }

  deliverToB(): void {
    const queued = this.#toB.splice(0, this.#toB.length);
    for (const update of queued) Y.applyUpdate(this.#b, update, REMOTE_ORIGIN);
  }

  deliverToA(): void {
    const queued = this.#toA.splice(0, this.#toA.length);
    for (const update of queued) Y.applyUpdate(this.#a, update, REMOTE_ORIGIN);
  }

  dispose(): void {
    this.#a.off('update', this.#onA);
    this.#b.off('update', this.#onB);
  }

  readonly #onA = (update: Uint8Array, origin: unknown): void => {
    if (origin === REMOTE_ORIGIN) return;
    this.#toB.push(update);
    if (this.#auto) this.deliverToB();
  };

  readonly #onB = (update: Uint8Array, origin: unknown): void => {
    if (origin === REMOTE_ORIGIN) return;
    this.#toA.push(update);
    if (this.#auto) this.deliverToA();
  };
}

/** Two linked peers sharing one notebook, with an auto-delivering bridge. */
export function makeLinkedPeers(
  content?: Record<string, unknown>,
  options: Partial<NotebookModelOptions> = {}
): { a: Peer; b: Peer; bridge: Bridge; dispose(): void } {
  const a = makePeer(content, options);
  const b = makePeer(undefined, options);
  const bridge = new Bridge(a.notebook.ydoc, b.notebook.ydoc);
  // Seed B from A's full state, then keep them in step.
  bridge.syncInitial();
  bridge.setAuto(true);
  return {
    a,
    b,
    bridge,
    dispose(): void {
      bridge.dispose();
      a.dispose();
      b.dispose();
    }
  };
}

/** The code cell at `index`, typed, for assertions on the shared fields. */
export function codeCellAt(notebook: YNotebook, index: number): YCodeCell {
  const cell = notebook.getCell(index);
  if (cell.cell_type !== 'code') throw new Error(`cell ${index} is not a code cell`);
  return cell as YCodeCell;
}

/** Minimal valid notebook with the given code cells. */
export function notebookWith(
  cells: readonly Record<string, unknown>[],
  metadata: Record<string, unknown> = {}
): Record<string, unknown> {
  return { cells, metadata, nbformat: 4, nbformat_minor: 5 };
}

/** A code cell fixture. */
export function codeCell(
  id: string,
  source: string,
  extra: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    id,
    cell_type: 'code',
    source,
    metadata: {},
    outputs: [],
    execution_count: null,
    ...extra
  };
}

/** A markdown cell fixture. */
export function markdownCell(
  id: string,
  source: string,
  extra: Record<string, unknown> = {}
): Record<string, unknown> {
  return { id, cell_type: 'markdown', source, metadata: {}, ...extra };
}

/**
 * Replace a cell the way an external file write does: the `Y.Map` is swapped
 * while the `cell_id` stays (SPEC.md §6 "External file changes"). Performed
 * on the *peer* document so the local model sees it as a remote change.
 */
export function replaceCellExternally(
  notebook: YNotebook,
  cellId: string,
  replacement: Record<string, unknown>
): void {
  const ycells = notebook.ydoc.getArray<Y.Map<unknown>>('cells');
  let at = -1;
  ycells.toArray().forEach((ymodel, index) => {
    if (ymodel.get('id') === cellId) at = index;
  });
  if (at < 0) throw new Error(`no cell ${cellId}`);
  notebook.ydoc.transact(() => {
    notebook.deleteCell(at);
    notebook.insertCell(at, { id: cellId, ...replacement } as never);
  });
}

/** Rename a cell in place, as `jupyter_ydoc` does when it de-duplicates ids. */
export function renameCellExternally(notebook: YNotebook, from: string, to: string): void {
  const ycells = notebook.ydoc.getArray<Y.Map<unknown>>('cells');
  const target = ycells.toArray().find((ymodel) => ymodel.get('id') === from);
  if (target === undefined) throw new Error(`no cell ${from}`);
  notebook.ydoc.transact(() => {
    target.set('id', to);
  });
}
