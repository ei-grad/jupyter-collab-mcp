/**
 * Immutable output snapshots and the `output_read` / `resources/read` paths
 * (SPEC.md §9).
 *
 * An output that does not fit the response budget is never inlined. Instead it
 * is *interned* here once - "an unchanged snapshot is not recreated on every
 * read" - and the answer carries an `output_id`, its MIME types, its full
 * size and the URI that reads it. The same output read twice returns the same
 * id, because interning is keyed by the content digest and the address of the
 * output, not by the call.
 *
 * The store belongs to a working session: `session_close` drops every snapshot
 * with it, and a dropped or evicted snapshot answers `HANDLE_EXPIRED`
 * (SPEC.md §9). The URI carries the session, so a future shared HTTP adapter
 * can bind it to its authenticated owner (SPEC.md §4); it carries no
 * credential (SPEC.md §11).
 *
 * @module
 */

import { createHash, randomUUID } from 'node:crypto';

import { coreError, type HandleLifetime, type NbOutput } from '../core/index.js';

/** URI scheme of our own snapshots. */
export const OUTPUT_URI_SCHEME = 'jupyter-output';

/** Snapshots and their jobs die with the working session (SPEC.md §4). */
export const SNAPSHOT_LIFETIME: HandleLifetime = Object.freeze({
  scope: 'until_session_close',
  releasedBy: Object.freeze(['session_close', 'process_exit']) as readonly [
    'session_close',
    'process_exit'
  ],
  processScoped: true
});

/** One interned snapshot. `bytes` is the payload of {@link mimeType} alone. */
export interface OutputSnapshot {
  readonly outputId: string;
  readonly uri: string;
  readonly sessionId: string;
  readonly notebookId: string;
  readonly executionId: string;
  readonly cellId: string;
  readonly index: number;
  readonly outputType: string;
  /** Every MIME type the original bundle carried. */
  readonly mimeTypes: readonly string[];
  /** The MIME type {@link bytes} holds. */
  readonly mimeType: string;
  readonly encoding: 'text' | 'base64';
  readonly bytes: Buffer;
  readonly byteSize: number;
  /** Short human-readable name, e.g. `cell 3 (image/png)`. */
  readonly name: string;
  /** `true` when the adapter should emit MCP `image` content for it. */
  readonly inlineImageAdvised: boolean;
}

/** Where an output sits, so re-reading it returns the same snapshot. */
export interface OutputAddress {
  readonly notebookId: string;
  readonly executionId: string;
  readonly cellId: string;
  readonly index: number;
}

/** A destination that assigns stable snapshots while a response is built. */
export interface OutputSnapshotWriter {
  intern(address: OutputAddress, output: NbOutput): OutputSnapshot;
}

/** A response-scoped snapshot writer that publishes all entries atomically. */
export interface OutputSnapshotTransaction extends OutputSnapshotWriter {
  commit(): void;
}

/** MIME types a host can render as image content (SPEC.md §9). */
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg']);

/** Preference order when one bundle carries several representations. */
const MIME_PREFERENCE = [
  'image/png',
  'image/jpeg',
  'image/svg+xml',
  'text/html',
  'application/json',
  'text/markdown',
  'text/plain'
];

/** nbformat stores multi-line text either as a string or as a list of lines. */
export function nbText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value.map((line) => (typeof line === 'string' ? line : '')).join('');
  }
  return '';
}

/** MIME types present in one output; empty for `stream` and `error`. */
export function mimeTypesOf(output: NbOutput): readonly string[] {
  if (output.output_type === 'execute_result' || output.output_type === 'display_data') {
    return Object.keys(output.data ?? {});
  }
  return [];
}

/** UTF-8 size of the serialised output - what a text answer would cost. */
export function outputByteSize(output: NbOutput): number {
  return Buffer.byteLength(JSON.stringify(output) ?? 'null', 'utf8');
}

function isBinary(mimeType: string): boolean {
  if (mimeType === 'image/svg+xml') return false;
  if (mimeType.startsWith('image/')) return true;
  return mimeType === 'application/pdf' || mimeType === 'application/octet-stream';
}

function pickMime(types: readonly string[]): string {
  for (const candidate of MIME_PREFERENCE) {
    if (types.includes(candidate)) return candidate;
  }
  return types[0] ?? 'text/plain';
}

/** The payload one snapshot serves, chosen from the output's richest part. */
function payloadOf(output: NbOutput): {
  mimeType: string;
  encoding: 'text' | 'base64';
  bytes: Buffer;
} {
  if (output.output_type === 'stream') {
    return {
      mimeType: 'text/plain',
      encoding: 'text',
      bytes: Buffer.from(nbText(output.text), 'utf8')
    };
  }
  if (output.output_type === 'error') {
    const text = [`${output.ename}: ${output.evalue}`, ...output.traceback].join('\n');
    return { mimeType: 'text/plain', encoding: 'text', bytes: Buffer.from(text, 'utf8') };
  }
  const bundle = (output.data ?? {}) as Record<string, unknown>;
  const mimeType = pickMime(Object.keys(bundle));
  const raw = bundle[mimeType];
  if (isBinary(mimeType)) {
    // nbformat keeps binary bundles base64-encoded already.
    const base64 = nbText(raw).replace(/\s+/g, '');
    return { mimeType, encoding: 'base64', bytes: Buffer.from(base64, 'base64') };
  }
  const text = mimeType === 'application/json' ? (JSON.stringify(raw) ?? 'null') : nbText(raw);
  return { mimeType, encoding: 'text', bytes: Buffer.from(text, 'utf8') };
}

/** Build the URI of a snapshot: `jupyter-output://<session>/<output_id>`. */
export function outputUri(sessionId: string, outputId: string): string {
  return `${OUTPUT_URI_SCHEME}://${encodeURIComponent(sessionId)}/${encodeURIComponent(outputId)}`;
}

/**
 * Parse one of our URIs. Also accepts the shorter `jupyter-output:<id>` form,
 * so a host that stored an id alone still resolves.
 */
export function parseOutputUri(uri: string): { sessionId: string | null; outputId: string } | null {
  if (!uri.startsWith(`${OUTPUT_URI_SCHEME}:`)) return null;
  const rest = uri.slice(OUTPUT_URI_SCHEME.length + 1);
  if (rest.startsWith('//')) {
    const parts = rest.slice(2).split('/');
    if (parts.length !== 2 || parts[0] === '' || parts[1] === '') return null;
    return { sessionId: decodeURIComponent(parts[0]!), outputId: decodeURIComponent(parts[1]!) };
  }
  if (rest === '') return null;
  return { sessionId: null, outputId: decodeURIComponent(rest) };
}

/** The snapshot store of one working session. */
export class OutputStore {
  readonly #sessionId: string;
  readonly #maxBytes: number;
  readonly #byId = new Map<string, OutputSnapshot>();
  readonly #byKey = new Map<string, string>();
  #used = 0;

  constructor(sessionId: string, maxBytes: number) {
    this.#sessionId = sessionId;
    this.#maxBytes = maxBytes;
  }

  /** Bytes currently held. */
  get usedBytes(): number {
    return this.#used;
  }

  /** Snapshots currently retained. */
  get size(): number {
    return this.#byId.size;
  }

  /**
   * Intern one output. Called twice for the same content at the same address,
   * it returns the same snapshot rather than a second copy.
   */
  intern(address: OutputAddress, output: NbOutput): OutputSnapshot {
    const transaction = this.begin();
    const snapshot = transaction.intern(address, output);
    transaction.commit();
    return snapshot;
  }

  /** Build a response's snapshots before publishing any of their IDs. */
  begin(): OutputSnapshotTransaction {
    const candidates = new Map<string, OutputSnapshot>();
    let committed = false;
    return {
      intern: (address, output) => {
        if (committed) throw new Error('an output snapshot transaction is already committed');
        const candidate = this.#candidate(address, output);
        const known = candidates.get(candidate.key);
        if (known !== undefined) return known;
        const existing = this.#snapshotForKey(candidate.key);
        const snapshot = existing ?? candidate.snapshot;
        candidates.set(candidate.key, snapshot);
        return snapshot;
      },
      commit: () => {
        if (committed) return;
        this.#commit(candidates);
        committed = true;
      }
    };
  }

  #candidate(address: OutputAddress, output: NbOutput): { key: string; snapshot: OutputSnapshot } {
    const payload = payloadOf(output);
    const digest = createHash('sha256').update(payload.bytes).digest('hex').slice(0, 32);
    const key = [
      address.notebookId,
      address.cellId,
      String(address.index),
      payload.mimeType,
      digest
    ].join(' ');
    const outputId = `out_${randomUUID()}`;
    const mimeTypes = mimeTypesOf(output);
    const snapshot: OutputSnapshot = {
      outputId,
      uri: outputUri(this.#sessionId, outputId),
      sessionId: this.#sessionId,
      notebookId: address.notebookId,
      executionId: address.executionId,
      cellId: address.cellId,
      index: address.index,
      outputType: output.output_type,
      mimeTypes: mimeTypes.length > 0 ? mimeTypes : [payload.mimeType],
      mimeType: payload.mimeType,
      encoding: payload.encoding,
      bytes: payload.bytes,
      byteSize: payload.bytes.byteLength,
      name: `cell ${address.cellId} (${payload.mimeType})`,
      inlineImageAdvised: IMAGE_TYPES.has(payload.mimeType)
    };
    return { key, snapshot };
  }

  /**
   * Look one up.
   *
   * @throws CoreError `HANDLE_EXPIRED` - the snapshot expired or its working
   * session was closed (SPEC.md §9).
   */
  require(outputId: string): OutputSnapshot {
    const snapshot = this.#byId.get(outputId);
    if (snapshot === undefined) {
      throw coreError('HANDLE_EXPIRED', `output snapshot ${outputId} is no longer available`, {
        details: { output_id: outputId }
      });
    }
    return snapshot;
  }

  /** Look one up without throwing. */
  peek(outputId: string): OutputSnapshot | undefined {
    return this.#byId.get(outputId);
  }

  /** Everything retained, oldest first. */
  list(): readonly OutputSnapshot[] {
    return [...this.#byId.values()];
  }

  /** Drop everything; called by `session_close` and `shutdown`. */
  clear(): void {
    this.#byId.clear();
    this.#byKey.clear();
    this.#used = 0;
  }

  #snapshotForKey(key: string): OutputSnapshot | undefined {
    const outputId = this.#byKey.get(key);
    if (outputId === undefined) return undefined;
    const snapshot = this.#byId.get(outputId);
    if (snapshot !== undefined) return snapshot;
    this.#byKey.delete(key);
    return undefined;
  }

  #commit(candidates: ReadonlyMap<string, OutputSnapshot>): void {
    const snapshots = [...candidates.values()];
    const retainedBytes = snapshots.reduce((total, snapshot) => total + snapshot.byteSize, 0);
    if (retainedBytes > this.#maxBytes) {
      throw coreError('RESOURCE_LIMIT', 'output snapshots for one response exceed the retained-output budget', {
        details: { output_bytes: retainedBytes, output_store_max_bytes: this.#maxBytes }
      });
    }
    const retainedIds = new Set(snapshots
      .filter((snapshot) => this.#byId.get(snapshot.outputId) === snapshot)
      .map((snapshot) => snapshot.outputId));
    const additions = snapshots.filter((snapshot) => !retainedIds.has(snapshot.outputId));
    const additionalBytes = additions.reduce((total, snapshot) => total + snapshot.byteSize, 0);
    this.#evictFor(additionalBytes, retainedIds);
    for (const [key, snapshot] of candidates) {
      if (retainedIds.has(snapshot.outputId)) continue;
      this.#byId.set(snapshot.outputId, snapshot);
      this.#byKey.set(key, snapshot.outputId);
      this.#used += snapshot.byteSize;
    }
  }

  /** Evict oldest unrequested snapshots until the response can be retained. */
  #evictFor(additionalBytes: number, retainedIds: ReadonlySet<string>): void {
    for (const [id, snapshot] of this.#byId) {
      if (this.#used + additionalBytes <= this.#maxBytes) return;
      if (retainedIds.has(id)) continue;
      this.#drop(id, snapshot);
    }
    if (this.#used + additionalBytes > this.#maxBytes) {
      throw coreError('RESOURCE_LIMIT', 'output snapshots for one response exceed the retained-output budget', {
        details: { output_store_max_bytes: this.#maxBytes }
      });
    }
  }

  #drop(id: string, snapshot: OutputSnapshot): void {
    this.#byId.delete(id);
    this.#used -= snapshot.byteSize;
    for (const [key, value] of this.#byKey) {
      if (value === id) this.#byKey.delete(key);
    }
  }
}
