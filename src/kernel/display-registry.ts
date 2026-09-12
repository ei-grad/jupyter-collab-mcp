/**
 * `display_id` routing table for one kernel.
 *
 * SPEC.md §8: "Display IDs must also be routed across different executions by
 * this client." An `update_display_data` produced by a later
 * execution can therefore target an output that an *earlier* execution wrote
 * into a *different* cell, so the table lives per kernel and outlives any one
 * execution or output generation.
 *
 * The table stores only coordinates - notebook, cell, output-area generation
 * and index. Whether the target is still writable is decided by the
 * `OutputSink` (`isCurrent()`), never here.
 *
 * @module
 */

/**
 * One output area of one cell, pinned to the generation that owns it
 * (SPEC.md §8: "The output-area generation is tracked for each cell").
 */
export interface OutputAreaRef {
  /** Notebook handle that owns the cell; display ids never cross notebooks. */
  readonly notebookId: string;
  readonly cellId: string;
  /** Output-area generation the reference was taken for. */
  readonly generation: number;
}

/** Where one `display_id` currently lives (SPEC.md §8). */
export interface DisplayTarget extends OutputAreaRef {
  /** Index inside that output area. */
  readonly index: number;
}

/** True when two references name the same output area. */
export function sameOutputArea(a: OutputAreaRef, b: OutputAreaRef): boolean {
  return a.notebookId === b.notebookId && a.cellId === b.cellId && a.generation === b.generation;
}

/** Default cap on distinct display ids kept per kernel (SPEC.md §9 limits). */
export const DEFAULT_MAX_DISPLAY_IDS = 1024;
/** Default cap on targets stored for one display id. */
export const DEFAULT_MAX_TARGETS_PER_ID = 64;

/** Bounds of the table; see SPEC.md §9 on configurable limits. */
export interface DisplayRegistryOptions {
  readonly maxDisplayIds?: number;
  readonly maxTargetsPerId?: number;
}

/**
 * Bounded `display_id -> targets` map shared by every execution of one kernel
 * (SPEC.md §8). Insertion order is the eviction order.
 */
export class DisplayRegistry {
  readonly #targets = new Map<string, DisplayTarget[]>();
  readonly #maxIds: number;
  readonly #maxPerId: number;

  constructor(options: DisplayRegistryOptions = {}) {
    this.#maxIds = options.maxDisplayIds ?? DEFAULT_MAX_DISPLAY_IDS;
    this.#maxPerId = options.maxTargetsPerId ?? DEFAULT_MAX_TARGETS_PER_ID;
  }

  /** Number of display ids currently tracked. */
  get size(): number {
    return this.#targets.size;
  }

  /**
   * Record that `displayId` is rendered by the output at `target`.
   *
   * A repeated `display_data` with the same id adds another target: IPython
   * updates every place the display was shown.
   */
  register(displayId: string, target: DisplayTarget): void {
    let list = this.#targets.get(displayId);
    if (list === undefined) {
      if (this.#targets.size >= this.#maxIds) {
        const oldest = this.#targets.keys().next();
        if (!oldest.done) this.#targets.delete(oldest.value);
      }
      list = [];
      this.#targets.set(displayId, list);
    }
    const known = list.some((t) => sameOutputArea(t, target) && t.index === target.index);
    if (known) return;
    if (list.length >= this.#maxPerId) list.shift();
    list.push(target);
  }

  /** Every place `displayId` is currently shown. Empty when unknown. */
  resolve(displayId: string): readonly DisplayTarget[] {
    return this.#targets.get(displayId) ?? [];
  }

  /**
   * Drop every target of one output-area generation.
   *
   * Called when that generation is replaced or cleared: the indices it
   * recorded no longer mean anything (SPEC.md §8, output-area generations).
   */
  forgetGeneration(notebookId: string, cellId: string, generation: number): void {
    const area: OutputAreaRef = { notebookId, cellId, generation };
    for (const [displayId, list] of this.#targets) {
      const kept = list.filter((t) => !sameOutputArea(t, area));
      if (kept.length === list.length) continue;
      if (kept.length === 0) this.#targets.delete(displayId);
      else this.#targets.set(displayId, kept);
    }
  }

  /** Drop everything; used when the kernel restarts or the handle closes. */
  clear(): void {
    this.#targets.clear();
  }
}
