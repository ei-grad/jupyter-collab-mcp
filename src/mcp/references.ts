/**
 * Per-connection opaque handles and observed-version refs (SPEC.md §9).
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

interface ObservedCell {
  readonly notebook: string;
  readonly cellId: string;
  readonly identityToken: string;
  readonly sourceRevision: string;
  readonly cellRevision: string;
  readonly outputsRevision: string | null;
}

interface ObservedNotebook {
  readonly notebook: string;
  readonly metadataRevision: string;
}

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

export interface StagedReferences {
  readonly value: WireValue;
  commit(): void;
  commitPublished(value: WireValue): void;
  rollback(): void;
}

interface SubmittedCellReference {
  readonly field: 'cell_ref' | 'before_cell_ref' | 'after_cell_ref';
  readonly value: string;
}

interface ReferenceCheckpoint {
  readonly byFull: Map<ReferenceKind, Map<string, string>>;
  readonly byAlias: Map<ReferenceKind, Map<string, string>>;
  readonly notebookOwner: Map<string, string>;
  readonly observedByRef: Map<string, ObservedCell>;
  readonly observedByValue: Map<string, string>;
  readonly observedNotebookByRef: Map<string, ObservedNotebook>;
  readonly observedNotebookByValue: Map<string, string>;
  readonly next: Map<ReferenceKind, number>;
  readonly nextObserved: number;
}

/** Maps aliases only inside fields that are defined protocol references. */
export class ReferenceAliases {
  readonly #byFull = new Map<ReferenceKind, Map<string, string>>();
  readonly #byAlias = new Map<ReferenceKind, Map<string, string>>();
  readonly #notebookOwner = new Map<string, string>();
  readonly #observedByRef = new Map<string, ObservedCell>();
  readonly #observedByValue = new Map<string, string>();
  readonly #observedNotebookByRef = new Map<string, ObservedNotebook>();
  readonly #observedNotebookByValue = new Map<string, string>();
  readonly #observedMaxEntries: number;
  #speculative = false;
  #nextObserved = 1;
  readonly #next = new Map<ReferenceKind, number>();
  readonly #scope = (nextConnectionScope++).toString(36);

  constructor(observedMaxEntries = 4096) {
    if (!Number.isSafeInteger(observedMaxEntries) || observedMaxEntries < 1) {
      throw new Error('observedMaxEntries must be a positive safe integer');
    }
    this.#observedMaxEntries = observedMaxEntries;
    for (const kind of Object.keys(PREFIX) as ReferenceKind[]) {
      this.#byFull.set(kind, new Map());
      this.#byAlias.set(kind, new Map());
      this.#next.set(kind, 1);
    }
  }

  /** Present a full service reference without shortening arbitrary payload text. */
  present(kind: ReferenceKind, full: string, notebook?: string): string {
    // A cell or its revision is meaningful only with its notebook handle. Do
    // not create a portable alias when a legacy result omitted that context.
    if ((kind === 'cell' || kind === 'revision') && notebook === undefined) {
      return literalValue(full);
    }
    const fullKey = referenceKey(kind, full, notebook);
    const existing = this.#byFull.get(kind)!.get(fullKey);
    if (existing !== undefined) return existing;
    const number = this.#next.get(kind)!;
    const alias = `@${PROCESS_EPOCH}.${this.#scope}.${PREFIX[kind]}${String(number)}`;
    this.#next.set(kind, number + 1);
    this.#byFull.get(kind)!.set(fullKey, alias);
    this.#byAlias.get(kind)!.set(alias, full);
    if (notebook !== undefined && (kind === 'cell' || kind === 'revision')) {
      this.#notebookOwner.set(`${kind}\u0000${alias}`, notebook);
    }
    return alias;
  }

  /**
   * Preserve literal compatibility while keeping references connection-scoped.
   * A custom value beginning with `@` or `raw:` must use a single
   * `raw:<base64url(UTF-8)>` escape so it cannot be mistaken for syntax.
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
    const staged = this.stageValue(value);
    staged.commit();
    return staged.value;
  }

  /** Stage every alias/ref in one response; commit only after publication succeeds. */
  stageValue(value: WireValue): StagedReferences {
    const checkpoint = this.#checkpoint();
    let active = true;
    try {
      this.#speculative = true;
      const mapped = this.#map(
        value,
        (kind, reference, notebook) => this.present(kind, reference, notebook),
        undefined,
        true
      );
      this.#speculative = false;
      const commitPublished = (published: WireValue): void => {
        if (!active) return;
        const refs = collectPublishedObservedRefs(published);
        this.#pruneUnpublished(checkpoint, refs);
        if (
          this.#observedByRef.size + this.#observedNotebookByRef.size >
          this.#observedMaxEntries
        ) {
          active = false;
          this.#restore(checkpoint);
          throw coreError('RESOURCE_LIMIT', 'the connection observed-reference budget is exhausted');
        }
        active = false;
      };
      return {
        value: mapped,
        commit: (): void => commitPublished(mapped),
        commitPublished,
        rollback: (): void => {
          if (!active) return;
          active = false;
          this.#restore(checkpoint);
        }
      };
    } catch (error) {
      this.#speculative = false;
      this.#restore(checkpoint);
      throw error;
    }
  }

  resolveValue(value: WireValue): WireValue {
    return this.#map(value, (kind, reference, notebook) => this.resolve(kind, reference, notebook));
  }

  /** Expand public observed fields before the service performs receipt replay. */
  resolveTool(tool: string, value: WireValue): WireValue {
    const resolved = this.resolveValue(value) as WireObject;
    if (
      tool === 'notebook_read' &&
      resolved['view'] !== 'summary' &&
      Array.isArray(resolved['cell_refs'])
    ) {
      const notebook = String(resolved['notebook_id']);
      const { cell_refs: _refs, ...rest } = resolved;
      const selectors = resolved['cell_refs'].map((ref) => {
        const value = String(ref);
        if (this.#byAlias.get('cell')!.has(value)) {
          return { cellId: this.resolve('cell', value, notebook) };
        }
        if (/^@[^\s]+\.c[0-9]+$/u.test(value)) {
          throw coreError('INVALID_ARGUMENT', 'cell_id was not issued for this notebook connection');
        }
        const observed = this.#observed(value, notebook);
        return { cellId: observed.cellId, identityToken: observed.identityToken };
      });
      return {
        ...rest,
        cell_ids: selectors.map((selector) => selector.cellId),
        observed_cells: selectors
          .filter((selector) => selector.identityToken !== undefined)
          .map((selector) => ({ cell_id: selector.cellId, identity_token: selector.identityToken }))
      };
    }
    if (tool === 'notebook_execute' && Array.isArray(resolved['cells'])) {
      const notebook = String(resolved['notebook_id']);
      return {
        ...resolved,
        cells: resolved['cells'].map((item) => {
          const observed = this.#observed(String((item as WireObject)['cell_ref']), notebook);
          return {
            cell_id: observed.cellId,
            expected_identity_token: observed.identityToken,
            expected_source_revision: observed.sourceRevision
          };
        })
      };
    }
    if (tool !== 'notebook_apply' || !Array.isArray(resolved['operations'])) return resolved;
    const notebook = String(resolved['notebook_id']);
    return {
      ...resolved,
      operations: resolved['operations'].map((entry) => this.#operation(entry as WireObject, notebook))
    };
  }

  /**
   * Correlate one internal cell id with a public ref in the submitted request.
   *
   * Errors retain internal diagnostics until the MCP boundary. Projection must
   * name a caller-supplied ref only when both its value and input role are
   * unambiguous; otherwise the public error uses a generic cell-reference
   * description instead of guessing.
   */
  submittedCellReference(
    tool: string,
    value: WireValue,
    cellId: string
  ): SubmittedCellReference | null {
    if (!isObject(value) || typeof value['notebook_id'] !== 'string') return null;
    let notebook: string;
    try {
      notebook = this.resolve('notebook', value['notebook_id']);
    } catch {
      return null;
    }

    const candidates = new Map<string, SubmittedCellReference>();
    const consider = (field: SubmittedCellReference['field'], ref: unknown): void => {
      if (typeof ref !== 'string') return;
      const observed = this.#observedByRef.get(ref);
      if (observed === undefined || observed.notebook !== notebook || observed.cellId !== cellId) return;
      candidates.set(`${field}\u0000${ref}`, { field, value: ref });
    };

    if (tool === 'notebook_read' && Array.isArray(value['cell_refs'])) {
      for (const ref of value['cell_refs']) consider('cell_ref', ref);
    } else if (tool === 'notebook_execute' && Array.isArray(value['cells'])) {
      for (const cell of value['cells']) {
        if (isObject(cell)) consider('cell_ref', cell['cell_ref']);
      }
    } else if (tool === 'notebook_apply' && Array.isArray(value['operations'])) {
      for (const operation of value['operations']) {
        if (!isObject(operation)) continue;
        consider('cell_ref', operation['cell_ref']);
        consider('before_cell_ref', operation['before_cell_ref']);
        consider('after_cell_ref', operation['after_cell_ref']);
      }
    }

    return candidates.size === 1 ? [...candidates.values()][0]! : null;
  }

  #map(value: WireValue, transform: (kind: ReferenceKind, reference: string, notebook?: string) => string, inheritedNotebook?: string, rawNotebook = false): WireValue {
    if (Array.isArray(value)) return value.map((entry) => this.#map(entry, transform, inheritedNotebook, rawNotebook));
    if (!isObject(value)) return value;
    const ownNotebook = typeof value['notebook_id'] === 'string'
      ? rawNotebook ? value['notebook_id'] : transform('notebook', value['notebook_id'], inheritedNotebook)
      : inheritedNotebook;
    const observedCell = rawNotebook && ownNotebook !== undefined && isObservedCell(value);
    const observedNotebook = rawNotebook && ownNotebook !== undefined && isObservedNotebook(value);
    const mapped: WireObject = {};
    for (const [key, child] of Object.entries(value)) {
      if (OPAQUE_KEYS.has(key)) {
        mapped[key] = child;
        continue;
      }
      if (
        (observedCell && ['cell_id', 'identity_token', 'source_revision', 'cell_revision', 'outputs_revision'].includes(key)) ||
        (observedNotebook && key === 'notebook_metadata_revision')
      ) {
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
    if (observedCell) {
      const ref = this.#presentObserved({
        notebook: ownNotebook,
        cellId: value['cell_id'] as string,
        identityToken: value['identity_token'] as string,
        sourceRevision: value['source_revision'] as string,
        cellRevision: value['cell_revision'] as string,
        outputsRevision: typeof value['outputs_revision'] === 'string' ? value['outputs_revision'] : null
      });
      mapped['cell_ref'] = ref;
      if (typeof value['cell_type'] === 'string' && typeof value['index'] === 'number') {
        mapped['cell_id'] = transform('cell', value['cell_id'] as string, ownNotebook);
      } else {
        delete mapped['cell_id'];
      }
      for (const key of ['identity_token', 'source_revision', 'cell_revision', 'outputs_revision']) delete mapped[key];
    } else if (observedNotebook) {
      mapped['notebook_ref'] = this.#presentObservedNotebook({
        notebook: ownNotebook,
        metadataRevision: value['notebook_metadata_revision'] as string
      });
      delete mapped['notebook_metadata_revision'];
    }
    return mapped;
  }

  #presentObserved(observed: ObservedCell): string {
    const key = [observed.notebook, observed.cellId, observed.identityToken, observed.sourceRevision, observed.cellRevision, observed.outputsRevision ?? ''].join('\u0000');
    const existing = this.#observedByValue.get(key);
    if (existing !== undefined) return existing;
    if (
      !this.#speculative &&
      this.#observedByRef.size + this.#observedNotebookByRef.size >= this.#observedMaxEntries
    ) {
      throw coreError('RESOURCE_LIMIT', 'the connection observed-reference budget is exhausted');
    }
    const ref = `@${PROCESS_EPOCH}.${this.#scope}.v${String(this.#nextObserved++)}`;
    this.#observedByValue.set(key, ref);
    this.#observedByRef.set(ref, observed);
    return ref;
  }

  #presentObservedNotebook(observed: ObservedNotebook): string {
    const key = `${observed.notebook}\u0000${observed.metadataRevision}`;
    const existing = this.#observedNotebookByValue.get(key);
    if (existing !== undefined) return existing;
    if (
      !this.#speculative &&
      this.#observedByRef.size + this.#observedNotebookByRef.size >= this.#observedMaxEntries
    ) {
      throw coreError('RESOURCE_LIMIT', 'the connection observed-reference budget is exhausted');
    }
    const ref = `@${PROCESS_EPOCH}.${this.#scope}.v${String(this.#nextObserved++)}`;
    this.#observedNotebookByValue.set(key, ref);
    this.#observedNotebookByRef.set(ref, observed);
    return ref;
  }

  #observed(ref: string, notebook: string): ObservedCell {
    const observed = this.#observedByRef.get(ref);
    if (observed === undefined || observed.notebook !== notebook) {
      throw coreError('HANDLE_EXPIRED', 'the observed reference was not issued for this notebook connection');
    }
    return observed;
  }

  #operation(operation: WireObject, notebook: string): WireObject {
    const op = operation['op'];
    if (op === 'add_cell') {
      const before = typeof operation['before_cell_ref'] === 'string' ? this.#observed(operation['before_cell_ref'], notebook) : undefined;
      const after = typeof operation['after_cell_ref'] === 'string' ? this.#observed(operation['after_cell_ref'], notebook) : undefined;
      const { before_cell_ref: _before, after_cell_ref: _after, ...rest } = operation;
      return { ...rest,
        ...(before === undefined ? {} : { before_cell_id: before.cellId, before_cell_identity_token: before.identityToken }),
        ...(after === undefined ? {} : { after_cell_id: after.cellId, after_cell_identity_token: after.identityToken })
      };
    }
    if (op === 'set_notebook_metadata' || op === 'delete_notebook_metadata') {
      const observed = this.#observedNotebook(String(operation['notebook_ref']), notebook);
      const { notebook_ref: _ref, ...rest } = operation;
      return {
        ...rest,
        expected_notebook_metadata_revision: observed.metadataRevision,
        expected_notebook_observed: true
      };
    }
    if (typeof operation['cell_ref'] !== 'string') return operation;
    const observed = this.#observed(operation['cell_ref'], notebook);
    const { cell_ref: _ref, ...rest } = operation;
    const base = {
      ...rest,
      cell_id: observed.cellId,
      expected_cell_identity_token: observed.identityToken
    };
    if (op === 'replace_source' || op === 'replace_text') return { ...base, expected_source_revision: observed.sourceRevision };
    if (op === 'clear_outputs') return { ...base, expected_outputs_revision: observed.outputsRevision };
    return { ...base, expected_cell_revision: observed.cellRevision };
  }


  #observedNotebook(ref: string, notebook: string): ObservedNotebook {
    const observed = this.#observedNotebookByRef.get(ref);
    if (observed === undefined || observed.notebook !== notebook) {
      throw coreError('HANDLE_EXPIRED', 'the notebook reference was not issued for this notebook connection');
    }
    return observed;
  }

  #checkpoint(): ReferenceCheckpoint {
    const cloneNested = (
      source: Map<ReferenceKind, Map<string, string>>
    ): Map<ReferenceKind, Map<string, string>> =>
      new Map([...source].map(([kind, entries]) => [kind, new Map(entries)]));
    return {
      byFull: cloneNested(this.#byFull),
      byAlias: cloneNested(this.#byAlias),
      notebookOwner: new Map(this.#notebookOwner),
      observedByRef: new Map(this.#observedByRef),
      observedByValue: new Map(this.#observedByValue),
      observedNotebookByRef: new Map(this.#observedNotebookByRef),
      observedNotebookByValue: new Map(this.#observedNotebookByValue),
      next: new Map(this.#next),
      nextObserved: this.#nextObserved
    };
  }

  #restore(checkpoint: ReferenceCheckpoint): void {
    const restoreMap = <K, V>(target: Map<K, V>, source: Map<K, V>): void => {
      target.clear();
      for (const [key, value] of source) target.set(key, value);
    };
    for (const kind of Object.keys(PREFIX) as ReferenceKind[]) {
      restoreMap(this.#byFull.get(kind)!, checkpoint.byFull.get(kind)!);
      restoreMap(this.#byAlias.get(kind)!, checkpoint.byAlias.get(kind)!);
    }
    restoreMap(this.#notebookOwner, checkpoint.notebookOwner);
    restoreMap(this.#observedByRef, checkpoint.observedByRef);
    restoreMap(this.#observedByValue, checkpoint.observedByValue);
    restoreMap(this.#observedNotebookByRef, checkpoint.observedNotebookByRef);
    restoreMap(this.#observedNotebookByValue, checkpoint.observedNotebookByValue);
    restoreMap(this.#next, checkpoint.next);
    this.#nextObserved = checkpoint.nextObserved;
  }

  #pruneUnpublished(checkpoint: ReferenceCheckpoint, published: ReadonlySet<string>): void {
    for (const [ref, observed] of this.#observedByRef) {
      if (checkpoint.observedByRef.has(ref) || published.has(ref)) continue;
      this.#observedByRef.delete(ref);
      const key = [
        observed.notebook,
        observed.cellId,
        observed.identityToken,
        observed.sourceRevision,
        observed.cellRevision,
        observed.outputsRevision ?? ''
      ].join('\u0000');
      if (this.#observedByValue.get(key) === ref) this.#observedByValue.delete(key);
    }
    for (const [ref, observed] of this.#observedNotebookByRef) {
      if (checkpoint.observedNotebookByRef.has(ref) || published.has(ref)) continue;
      this.#observedNotebookByRef.delete(ref);
      const key = `${observed.notebook}\u0000${observed.metadataRevision}`;
      if (this.#observedNotebookByValue.get(key) === ref) {
        this.#observedNotebookByValue.delete(key);
      }
    }
  }
}

const OBSERVED_SINGULAR_FIELDS = new Set([
  'cell_ref',
  'notebook_ref',
  'current_cell_ref',
  'current_notebook_ref'
]);
const OBSERVED_PLURAL_FIELDS = new Set([
  'cell_refs',
  'cancelled_cell_refs',
  'already_sent_cell_refs'
]);

function collectPublishedObservedRefs(value: WireValue): Set<string> {
  const refs = new Set<string>();
  const visit = (current: WireValue): void => {
    if (Array.isArray(current)) {
      for (const entry of current) visit(entry);
      return;
    }
    if (!isObject(current)) return;
    for (const [key, child] of Object.entries(current)) {
      if (OPAQUE_KEYS.has(key)) continue;
      if (OBSERVED_SINGULAR_FIELDS.has(key) && typeof child === 'string') {
        refs.add(child);
        continue;
      }
      if (OBSERVED_PLURAL_FIELDS.has(key) && Array.isArray(child)) {
        for (const entry of child) if (typeof entry === 'string') refs.add(entry);
        continue;
      }
      visit(child);
    }
  };
  visit(value);
  return refs;
}

function isObservedCell(value: WireObject): boolean {
  return typeof value['cell_id'] === 'string' && typeof value['identity_token'] === 'string' &&
    typeof value['source_revision'] === 'string' && typeof value['cell_revision'] === 'string' &&
    (typeof value['outputs_revision'] === 'string' || value['outputs_revision'] === null);
}

function isObservedNotebook(value: WireObject): boolean {
  return typeof value['notebook_metadata_revision'] === 'string';
}

function referenceKey(kind: ReferenceKind, full: string, notebook?: string): string {
  return kind === 'cell' || kind === 'revision'
    ? `${notebook ?? ''}\u0000${full}`
    : full;
}

function decodeLiteral(value: string): string {
  const encoded = value.slice(LITERAL_PREFIX.length);
  if (encoded.length === 0) {
    throw coreError('INVALID_ARGUMENT', 'raw: must contain a base64url UTF-8 value');
  }
  const bytes = Buffer.from(encoded, 'base64url');
  const decoded = bytes.toString('utf8');
  if (Buffer.from(decoded, 'utf8').toString('base64url') !== encoded) {
    throw coreError('INVALID_ARGUMENT', 'raw: must contain canonical base64url UTF-8');
  }
  if (!needsLiteralEscaping(decoded)) {
    throw coreError('INVALID_ARGUMENT', 'raw: must encode a value beginning with @ or raw:');
  }
  return decoded;
}

function literalValue(value: string): string {
  return needsLiteralEscaping(value)
    ? `${LITERAL_PREFIX}${Buffer.from(value, 'utf8').toString('base64url')}`
    : value;
}

function needsLiteralEscaping(value: string): boolean {
  return value.startsWith('@') || value.startsWith(LITERAL_PREFIX);
}
