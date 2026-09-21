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

import { randomBytes } from 'node:crypto';

import { coreError } from '../core/index.js';
import { OPAQUE_KEYS } from './wire.js';
import type { WireObject, WireValue } from './wire.js';

type ReferenceKind = 'notebook' | 'cell' | 'execution' | 'output' | 'revision';

const PREFIX: Readonly<Record<ReferenceKind, string>> = {
  notebook: 'n',
  cell: 'c',
  execution: 'e',
  output: 'o',
  revision: 'r'
};

const PROCESS_EPOCH = randomBytes(12).toString('base64url');
const LITERAL_PREFIX = 'raw:';
let nextConnectionScope = 1;

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
  current_notebook_metadata_revision: 'revision'
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
  readonly #notebookOwner = new Map<string, string>();
  readonly #next = new Map<ReferenceKind, number>();
  readonly #scope = (nextConnectionScope++).toString(36);

  constructor() {
    for (const kind of Object.keys(PREFIX) as ReferenceKind[]) {
      this.#byFull.set(kind, new Map());
      this.#byAlias.set(kind, new Map());
      this.#next.set(kind, 1);
    }
  }

  /** Present a full service reference without shortening arbitrary payload text. */
  present(kind: ReferenceKind, full: string, notebook?: string): string {
    const existing = this.#byFull.get(kind)!.get(full);
    if (existing !== undefined) return existing;
    const number = this.#next.get(kind)!;
    const alias = `@${PROCESS_EPOCH}.${this.#scope}.${PREFIX[kind]}${String(number)}`;
    this.#next.set(kind, number + 1);
    this.#byFull.get(kind)!.set(full, alias);
    this.#byAlias.get(kind)!.set(alias, full);
    if (notebook !== undefined && (kind === 'cell' || kind === 'revision')) {
      this.#notebookOwner.set(`${kind}\u0000${alias}`, notebook);
    }
    return alias;
  }

  /**
   * Preserve literal compatibility while keeping references connection-scoped.
   * A custom value beginning with `@` must use `raw:<base64url(UTF-8)>` so it
   * cannot be mistaken for an alias from this connection.
   */
  resolve(kind: ReferenceKind, value: string, notebook?: string): string {
    if (value.startsWith(LITERAL_PREFIX)) return decodeLiteral(value);
    const resolved = this.#byAlias.get(kind)!.get(value);
    if (resolved !== undefined) {
      const owner = this.#notebookOwner.get(`${kind}\u0000${value}`);
      if (owner !== undefined && owner !== notebook) {
        throw coreError('HANDLE_EXPIRED', 'the reference belongs to a closed or different notebook handle');
      }
      return resolved;
    }
    if (value.startsWith('@')) {
      throw coreError('HANDLE_EXPIRED', 'the reference was not issued by this connection', {
        details: { reference: value }
      });
    }
    return value;
  }

  presentValue(value: WireValue): WireValue {
    return this.#map(value, (kind, reference, notebook) => this.present(kind, reference, notebook), undefined, true);
  }

  resolveValue(value: WireValue): WireValue {
    return this.#map(value, (kind, reference, notebook) => this.resolve(kind, reference, notebook));
  }

  #map(value: WireValue, transform: (kind: ReferenceKind, reference: string, notebook?: string) => string, inheritedNotebook?: string, rawNotebook = false): WireValue {
    if (Array.isArray(value)) return value.map((entry) => this.#map(entry, transform, inheritedNotebook, rawNotebook));
    if (!isObject(value)) return value;
    const ownNotebook = typeof value['notebook_id'] === 'string'
      ? rawNotebook ? value['notebook_id'] : transform('notebook', value['notebook_id'], inheritedNotebook)
      : inheritedNotebook;
    const mapped: WireObject = {};
    for (const [key, child] of Object.entries(value)) {
      if (OPAQUE_KEYS.has(key)) {
        mapped[key] = child;
        continue;
      }
      const singular = SINGULAR[key];
      if (singular !== undefined && typeof child === 'string') {
        mapped[key] = transform(singular, child, ownNotebook);
        continue;
      }
      const plural = PLURAL[key];
      if (plural !== undefined && Array.isArray(child)) {
        mapped[key] = child.map((entry) =>
          typeof entry === 'string' ? transform(plural, entry, ownNotebook) : this.#map(entry, transform, ownNotebook, rawNotebook)
        );
        continue;
      }
      mapped[key] = this.#map(child, transform, ownNotebook, rawNotebook);
    }
    return mapped;
  }
}

function decodeLiteral(value: string): string {
  const encoded = value.slice(LITERAL_PREFIX.length);
  if (encoded.length === 0) {
    throw coreError('INVALID_ARGUMENT', 'raw: must contain a base64url UTF-8 value');
  }
  const bytes = Buffer.from(encoded, 'base64url');
  if (bytes.toString('base64url') !== encoded) {
    throw coreError('INVALID_ARGUMENT', 'raw: must contain canonical base64url UTF-8');
  }
  return bytes.toString('utf8');
}
