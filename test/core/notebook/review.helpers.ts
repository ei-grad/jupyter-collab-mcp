/**
 * Rig for the adversarial review of `src/core/notebook`.
 *
 * Separate from `helpers.ts` on purpose: the review needs deterministic Yjs
 * client ids (concurrent Y.Map key writes are resolved by client id, so a
 * "who wins" assertion is only stable when the ids are fixed) and a bridge
 * that can deliver a whole disconnection window as ONE merged update, the way
 * an RTC resync after a reconnect does.
 */

import { YNotebook } from '@jupyter/ydoc';
import * as Y from 'yjs';

import { NotebookModel } from '../../../src/core/notebook/index.js';
import type { NotebookModelOptions } from '../../../src/core/notebook/index.js';

export const WIRE = 'review-wire';

export interface ReviewPeer {
  readonly notebook: YNotebook;
  readonly model: NotebookModel;
  readonly origin: object;
  dispose(): void;
}

/** A peer with a fixed Yjs client id, so merge outcomes are reproducible. */
export function reviewPeer(
  clientId: number,
  content?: Record<string, unknown>,
  options: Partial<NotebookModelOptions> = {}
): ReviewPeer {
  const notebook = new YNotebook();
  notebook.ydoc.clientID = clientId;
  if (content !== undefined) notebook.setSource(content as never);
  const origin = options.origin ?? { peer: Symbol(`peer-${clientId}`) };
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

/** Two-way link that can hold updates back and replay them merged. */
export class Wire {
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
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a), WIRE);
    Y.applyUpdate(a, Y.encodeStateAsUpdate(b), WIRE);
    this.#toA.length = 0;
    this.#toB.length = 0;
  }

  setAuto(auto: boolean): void {
    this.#auto = auto;
    if (auto) this.deliver();
  }

  /** Deliver everything queued, one update at a time. */
  deliver(): void {
    while (this.#toA.length > 0 || this.#toB.length > 0) {
      for (const update of this.#toB.splice(0, this.#toB.length)) {
        Y.applyUpdate(this.#b, update, WIRE);
      }
      for (const update of this.#toA.splice(0, this.#toA.length)) {
        Y.applyUpdate(this.#a, update, WIRE);
      }
    }
  }

  /** Deliver the whole backlog to A as one merged update, like a resync. */
  deliverMergedToA(): void {
    if (this.#toA.length === 0) return;
    Y.applyUpdate(this.#a, Y.mergeUpdates(this.#toA.splice(0, this.#toA.length)), WIRE);
  }

  dispose(): void {
    this.#a.off('update', this.#onA);
    this.#b.off('update', this.#onB);
  }

  readonly #onA = (update: Uint8Array, origin: unknown): void => {
    if (origin === WIRE) return;
    this.#toB.push(update);
    if (this.#auto) this.deliver();
  };

  readonly #onB = (update: Uint8Array, origin: unknown): void => {
    if (origin === WIRE) return;
    this.#toA.push(update);
    if (this.#auto) this.deliver();
  };
}

/** nbformat fixtures. */
export const reviewCode = (
  id: string,
  source: string,
  extra: Record<string, unknown> = {}
): Record<string, unknown> => ({
  id,
  cell_type: 'code',
  source,
  metadata: {},
  outputs: [],
  execution_count: null,
  ...extra
});

export const reviewMarkdown = (
  id: string,
  source: string,
  extra: Record<string, unknown> = {}
): Record<string, unknown> => ({ id, cell_type: 'markdown', source, metadata: {}, ...extra });

export const reviewBook = (
  cells: readonly Record<string, unknown>[],
  metadata: Record<string, unknown> = {}
): Record<string, unknown> => ({ cells, metadata, nbformat: 4, nbformat_minor: 5 });

/** Set a cell's source directly on a peer document (a "browser" edit). */
export function typeInto(notebook: YNotebook, index: number, source: string): void {
  notebook.ydoc.transact(() => {
    (notebook.getCell(index) as unknown as { setSource(value: string): void }).setSource(source);
  });
}

/** Write outputs directly on a peer document (a foreign executor). */
export function writeOutputs(notebook: YNotebook, index: number, outputs: unknown[]): void {
  notebook.ydoc.transact(() => {
    (notebook.getCell(index) as unknown as { setOutputs(value: unknown[]): void }).setOutputs(
      outputs
    );
  });
}
