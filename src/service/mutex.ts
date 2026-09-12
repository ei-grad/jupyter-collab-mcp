/**
 * The per-session lock of SPEC.md §9.
 *
 * The four deduplicated mutations of one working session - `notebook_create`,
 * `notebook_apply`, `notebook_execute`, `kernel_control` - are serialised by
 * it, so two concurrent calls carrying the same `request_id` produce exactly
 * one effect: the second one waits, finds the receipt and replays it. Reads,
 * waits and calls of *other* sessions never take this lock (SPEC.md §9:
 * "Reads, observation, cancellation of waits, and operations in different
 * working sessions may run concurrently").
 *
 * @module
 */

/** A FIFO async mutex. One instance per working session. */
export class Mutex {
  #tail: Promise<unknown> = Promise.resolve();

  /**
   * Run `fn` once every earlier holder has finished.
   *
   * A rejection is passed to the caller and does not poison the queue: the
   * chain is continued with a settled promise on purpose, so one failed
   * mutation cannot deadlock the session.
   */
  run<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.#tail.then(fn, fn);
    this.#tail = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }
}
