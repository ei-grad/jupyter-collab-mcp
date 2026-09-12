/**
 * Pending RAW `save` requests, matched by id (SPEC.md §5, §6).
 *
 * The docprovider protocol answers a save with `{"responseTo": <id>}`, so
 * replies must be correlated, not assumed to arrive in order. A request that
 * times out stays unmatched: SPEC.md §6 is explicit that a timeout is not proof
 * the file was not written, so the late reply is simply dropped.
 *
 * @module
 */

import type { CoreError, SaveStatus } from '../core/index.js';
import type { RawSaveStatus } from './raw-protocol.js';

interface Pending {
  readonly resolve: (status: SaveStatus) => void;
  readonly reject: (error: CoreError) => void;
  readonly timer: NodeJS.Timeout;
}

/** Registry of in-flight save requests for one connection. */
export class SaveRequests {
  readonly #pending = new Map<number, Pending>();
  #counter = 0;

  /** In-flight request count (used by tests and diagnostics). */
  get size(): number {
    return this.#pending.size;
  }

  /**
   * Allocate an id and a promise that settles on the reply, or resolves with
   * `'timeout'` after `timeoutMs`.
   */
  create(timeoutMs: number): { id: number; result: Promise<SaveStatus> } {
    const id = (this.#counter += 1);
    const result = new Promise<SaveStatus>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        resolve('timeout');
      }, timeoutMs);
      timer.unref?.();
      this.#pending.set(id, { resolve, reject, timer });
    });
    return { id, result };
  }

  /** Resolve the request `id`. `false` when it already timed out. */
  settle(id: number, status: RawSaveStatus): boolean {
    const pending = this.#pending.get(id);
    if (pending === undefined) return false;
    clearTimeout(pending.timer);
    this.#pending.delete(id);
    pending.resolve(status);
    return true;
  }

  /**
   * Resolve everything in flight with one status - used when the socket that
   * carried the requests died, so no reply can ever arrive for them.
   */
  settleAll(status: SaveStatus): void {
    for (const [id, pending] of [...this.#pending]) {
      clearTimeout(pending.timer);
      this.#pending.delete(id);
      pending.resolve(status);
    }
  }

  /** Drop request `id` without settling it (the send itself failed). */
  cancel(id: number): void {
    const pending = this.#pending.get(id);
    if (pending === undefined) return;
    clearTimeout(pending.timer);
    this.#pending.delete(id);
  }

  /** Reject everything in flight - the connection failed or was disposed. */
  rejectAll(error: CoreError): void {
    for (const [id, pending] of [...this.#pending]) {
      clearTimeout(pending.timer);
      this.#pending.delete(id);
      pending.reject(error);
    }
  }
}
