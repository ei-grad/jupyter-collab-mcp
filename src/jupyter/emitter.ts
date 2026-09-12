/**
 * Minimal typed event emitter used by the transport layer.
 *
 * `node:events` types poorly under `exactOptionalPropertyTypes` and lib0's
 * `ObservableV2` is untyped for our event map, so the transport carries its
 * own 40-line emitter. Listener errors are swallowed on purpose: a broken
 * subscriber must not take down an RTC state transition (SPEC.md §6).
 *
 * @module
 */

/** Map of event name to listener signature. */
export type EventMap = Record<string, (...args: never[]) => void>;

/** Small synchronous emitter with `on` / `once` / `off` / `emit`. */
export class Emitter<T extends EventMap> {
  readonly #listeners = new Map<keyof T, Set<(...args: never[]) => void>>();

  /** Subscribe; returns an unsubscribe function. */
  on<K extends keyof T>(event: K, listener: T[K]): () => void {
    let set = this.#listeners.get(event);
    if (set === undefined) {
      set = new Set();
      this.#listeners.set(event, set);
    }
    set.add(listener);
    return () => this.off(event, listener);
  }

  /** Subscribe for one emission. */
  once<K extends keyof T>(event: K, listener: T[K]): () => void {
    const wrapper = ((...args: never[]) => {
      off();
      (listener as (...a: never[]) => void)(...args);
    }) as T[K];
    const off = this.on(event, wrapper);
    return off;
  }

  off<K extends keyof T>(event: K, listener: T[K]): void {
    this.#listeners.get(event)?.delete(listener);
  }

  /** Emit to a snapshot of the listeners, so `off` during dispatch is safe. */
  emit<K extends keyof T>(event: K, ...args: Parameters<T[K]>): void {
    const set = this.#listeners.get(event);
    if (set === undefined) return;
    for (const listener of [...set]) {
      try {
        (listener as (...a: unknown[]) => void)(...args);
      } catch {
        // A subscriber must not break the state machine.
      }
    }
  }

  /** Drop every listener (called from `dispose`). */
  removeAll(): void {
    this.#listeners.clear();
  }

  /** Listener count, for leak assertions in tests. */
  count(event: keyof T): number {
    return this.#listeners.get(event)?.size ?? 0;
  }
}
