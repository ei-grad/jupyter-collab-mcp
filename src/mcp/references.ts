/**
 * Per-connection aliases for long protocol identities (SPEC.md §9).
 *
 * The service continues to receive and return full opaque identities. This
 * adapter-local table only presents short references at typed protocol fields,
 * then expands a known reference before dispatch. It never traverses notebook
 * source, metadata, attachments or nbformat output payloads.
 *
 * @module
 */

import { OPAQUE_KEYS } from './wire.js';
import type { WireObject, WireValue } from './wire.js';

type ReferenceKind = 'notebook' | 'cell' | 'execution' | 'output' | 'revision';

const PREFIX: Readonly<Record<ReferenceKind, string>> = {
  notebook: 'nb',
  cell: 'cell',
  execution: 'exec',
  output: 'out',
  revision: 'rev'
};

const SINGULAR: Readonly<Record<string, ReferenceKind>> = {
  notebook_id: 'notebook',
  open_notebook_id: 'notebook',
  execution_id: 'execution',
  output_id: 'output',
  cell_id: 'cell',
  before_cell_id: 'cell',
  after_cell_id: 'cell',
  revision: 'revision',
  source_revision: 'revision',
  cell_revision: 'revision',
  outputs_revision: 'revision',
  notebook_metadata_revision: 'revision',
  structure_revision: 'revision',
  expected_source_revision: 'revision',
  expected_cell_revision: 'revision',
  expected_outputs_revision: 'revision',
  expected_notebook_metadata_revision: 'revision',
  current_source_revision: 'revision',
  current_cell_revision: 'revision',
  current_outputs_revision: 'revision',
  current_notebook_metadata_revision: 'revision',
  expected: 'revision',
  current: 'revision'
};

const PLURAL: Readonly<Record<string, ReferenceKind>> = {
  cell_ids: 'cell',
  duplicate_cell_ids: 'cell',
  cancelled_cell_ids: 'cell',
  already_sent_cell_ids: 'cell',
  active_execution_ids: 'execution',
  invalidated_execution_ids: 'execution',
  dropped_execution_ids: 'execution',
  execution_ids: 'execution'
};

function isObject(value: WireValue): value is WireObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Maps aliases only inside fields that are defined protocol references. */
export class ReferenceAliases {
  readonly #byFull = new Map<ReferenceKind, Map<string, string>>();
  readonly #byAlias = new Map<ReferenceKind, Map<string, string>>();
  readonly #next = new Map<ReferenceKind, number>();

  constructor() {
    for (const kind of Object.keys(PREFIX) as ReferenceKind[]) {
      this.#byFull.set(kind, new Map());
      this.#byAlias.set(kind, new Map());
      this.#next.set(kind, 1);
    }
  }

  /** Present a full service reference without shortening arbitrary payload text. */
  present(kind: ReferenceKind, full: string): string {
    const existing = this.#byFull.get(kind)!.get(full);
    if (existing !== undefined) return existing;
    const number = this.#next.get(kind)!;
    const alias = `${PREFIX[kind]}_${String(number)}`;
    this.#next.set(kind, number + 1);
    this.#byFull.get(kind)!.set(full, alias);
    this.#byAlias.get(kind)!.set(alias, full);
    return alias;
  }

  /** Preserve full compatibility; only an alias issued by this connection expands. */
  resolve(kind: ReferenceKind, value: string): string {
    return this.#byAlias.get(kind)!.get(value) ?? value;
  }

  presentValue(value: WireValue): WireValue {
    return this.#map(value, (kind, reference) => this.present(kind, reference));
  }

  resolveValue(value: WireValue): WireValue {
    return this.#map(value, (kind, reference) => this.resolve(kind, reference));
  }

  #map(value: WireValue, transform: (kind: ReferenceKind, reference: string) => string): WireValue {
    if (Array.isArray(value)) return value.map((entry) => this.#map(entry, transform));
    if (!isObject(value)) return value;
    const mapped: WireObject = {};
    for (const [key, child] of Object.entries(value)) {
      if (OPAQUE_KEYS.has(key)) {
        mapped[key] = child;
        continue;
      }
      const singular = SINGULAR[key];
      if (singular !== undefined && typeof child === 'string') {
        mapped[key] = transform(singular, child);
        continue;
      }
      const plural = PLURAL[key];
      if (plural !== undefined && Array.isArray(child)) {
        mapped[key] = child.map((entry) =>
          typeof entry === 'string' ? transform(plural, entry) : this.#map(entry, transform)
        );
        continue;
      }
      mapped[key] = this.#map(child, transform);
    }
    return mapped;
  }
}
