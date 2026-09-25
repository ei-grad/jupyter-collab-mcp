/**
 * Reads over the shared model: summary, cells and outputs (SPEC.md §7, §9).
 *
 * All three are pure functions of the replica plus a limit set. They never
 * mutate, never await, and never inline a payload larger than the byte budget:
 * SPEC.md §9 requires the answer to report `truncated`, the available MIME
 * types and the total size instead of pasting a full base64 image into every
 * text answer.
 *
 * @module
 */

import type { YCellType, YCodeCell, YNotebook } from '@jupyter/ydoc';

import { coreError } from '../errors.js';
import { stripAnsi } from '../ansi.js';
import type { JsonValue } from '../revision.js';
import {
  cellRevision,
  notebookMetadataRevision,
  outputsRevision,
  sourceRevision,
  structureRevision
} from '../revision.js';
import type { NotebookMetadataRevision, StructureRevision } from '../revision.js';
import type {
  CellSummary,
  CellType,
  NbOutput,
  PageCursor,
  SharedExecutionState,
  SourceCursor
} from '../types.js';
import { makePageCursor, parsePageCursor } from '../types.js';
import type { CellEntry, CellIndex } from './cell-index.js';
import type {
  CellOutputsRead,
  CellRead,
  CellSelector,
  CellsRead,
  OutputRead,
  OutputsRead,
  ReadLimits
} from './types.js';
import { previewOf, truncateUtf8, utf8Length } from './text.js';

/** SPEC.md §9: "100 cells in the summary." */
export const DEFAULT_MAX_CELLS = 100;
/** SPEC.md §9: "64 KiB of text in the response." */
export const DEFAULT_MAX_BYTES = 64 * 1024;
/** Length of the single-line preview in a summary row (SPEC.md §7). */
export const DEFAULT_PREVIEW_CHARS = 80;

/** Cell type of a shared cell, narrowed to the three types of the first version. */
export function cellTypeOf(cell: YCellType): CellType {
  const raw = cell.cell_type;
  return raw === 'code' || raw === 'markdown' || raw === 'raw' ? raw : 'raw';
}

/** `true` for a code cell, the only kind with an output area (SPEC.md §8). */
export function isCodeCell(cell: YCellType): cell is YCodeCell {
  return cell.cell_type === 'code';
}

/**
 * The shared cell behind an index entry.
 *
 * `YNotebook.cells` and the index are both derived from the same `Y.Array`, so
 * they normally agree; the identity check guards against reading a different
 * cell if they ever do not.
 */
export function resolveCell(notebook: YNotebook, entry: CellEntry): YCellType {
  const byIndex = notebook.cells[entry.index];
  if (byIndex !== undefined && byIndex.ymodel === entry.ymodel) return byIndex;
  const found = notebook.cells.find((cell) => cell.ymodel === entry.ymodel);
  if (found !== undefined) return found;
  throw coreError('INTERNAL_ERROR', 'cell index is out of step with the shared model', {
    details: { cell_id: entry.cellId, index: entry.index }
  });
}

/** Full nbformat JSON of a cell - the pre-image of `cell_revision`. */
export function cellJson(cell: YCellType): JsonValue {
  return cell.toJSON() as unknown as JsonValue;
}

/** Outputs of a cell, or `[]` for markdown and raw cells. */
export function outputsOf(cell: YCellType): NbOutput[] {
  return isCodeCell(cell) ? (cell.getOutputs() as unknown as NbOutput[]) : [];
}

/** Shared `execution_state`, only meaningful for code cells (SPEC.md §8). */
export function executionStateOf(cell: YCellType): SharedExecutionState | undefined {
  if (!isCodeCell(cell)) return undefined;
  return cell.executionState === 'running' ? 'running' : 'idle';
}

/** Notebook metadata revision (SPEC.md §7); transient state is not included. */
export function metadataRevisionOf(notebook: YNotebook): NotebookMetadataRevision {
  const metadata = (notebook.getMetadata() ?? {}) as Record<string, JsonValue | undefined>;
  return notebookMetadataRevision(metadata);
}

/** Structural revision of the current cell order (SPEC.md §7). */
export function structureRevisionOf(index: CellIndex): StructureRevision {
  return structureRevision(index.orderedIds);
}

/**
 * What a page cursor is bound to. SPEC.md §12 "External writes": "disappeared
 * IDs, replacement Y.Maps with the same ID, and reordering invalidate the corresponding
 * targets/cursors/output generations».
 *
 * Deliberately **not** {@link structureRevisionOf}: the public structural
 * revision digests the ordered `cell_id`s, and an `aset`-style external write
 * can swap a cell's `Y.Map` while keeping its id, leaving that digest
 * unchanged. A second page served against such a cursor would come from a
 * document whose content the caller has never seen. Digesting the identity
 * token of every cell alongside its id catches exactly that case, while a
 * pure content edit - which does not move a cell - still leaves cursors valid.
 *
 * The value is opaque and never leaves the module except inside a `pg_`
 * cursor; the revision reported to the agent stays {@link structureRevisionOf}.
 */
export function pageBindingOf(index: CellIndex): StructureRevision {
  return structureRevision(
    index.entries.map((entry) => `${entry.identityToken}\u0000${entry.cellId}`)
  );
}

/** One summary row (SPEC.md §7). */
export function summaryRow(
  notebook: YNotebook,
  entry: CellEntry,
  index: CellIndex,
  previewChars: number
): CellSummary {
  const cell = resolveCell(notebook, entry);
  const type = cellTypeOf(cell);
  const source = cell.getSource();
  const code = isCodeCell(cell);
  const duplicate = !index.isUnique(entry.cellId);
  const state = executionStateOf(cell);
  return {
    cellId: entry.cellId,
    identityToken: entry.identityToken,
    index: entry.index,
    cellType: type,
    sourceRevision: sourceRevision(type, source),
    cellRevision: cellRevision(cellJson(cell)),
    outputsRevision: code ? outputsRevision(outputsOf(cell)) : null,
    executionCount: code ? cell.execution_count : null,
    hasError: code && outputsOf(cell).some((output) => output.output_type === 'error'),
    ...(state === undefined ? {} : { executionState: state }),
    preview: previewOf(source, previewChars),
    ...(duplicate ? { duplicateId: true } : {})
  };
}

/**
 * Offset a page cursor points at, checked against the current structure.
 *
 * @throws CoreError `CURSOR_EXPIRED` when the document changed structurally
 * since the cursor was issued (SPEC.md §9: no skipped and no repeated cells),
 * `INVALID_ARGUMENT` when the string is not a `pg_` cursor.
 */
export function offsetFromCursor(cursor: PageCursor | string, binding: StructureRevision): number {
  const parsed = parsePageCursor(cursor);
  if (parsed === null) {
    throw coreError('INVALID_ARGUMENT', 'not a page cursor; expected the "pg_<rev>.<n>" form', {
      details: { cursor }
    });
  }
  if (parsed.structureRevision !== binding) {
    throw coreError('CURSOR_EXPIRED', 'the notebook structure changed since this page cursor', {
      details: { cursor }
    });
  }
  return parsed.offset;
}

interface ParsedSourceCursor {
  readonly binding: StructureRevision;
  readonly identityToken: string;
  readonly sourceRevision: string;
  readonly byteOffset: number;
}

function makeSourceCursor(
  binding: StructureRevision,
  entry: CellEntry,
  revision: string,
  byteOffset: number
): SourceCursor {
  return `src_${binding}.${entry.identityToken}.${revision}.${String(byteOffset)}` as SourceCursor;
}

function parseSourceCursor(cursor: string): ParsedSourceCursor | null {
  const match = /^src_(x1_[A-Za-z0-9_-]{43})\.(cid_[A-Za-z0-9-]+)\.(s1_[A-Za-z0-9_-]{43})\.(0|[1-9][0-9]*)$/u.exec(cursor);
  if (match === null) return null;
  return {
    binding: match[1]! as StructureRevision,
    identityToken: match[2]!,
    sourceRevision: match[3]!,
    byteOffset: Number(match[4]!)
  };
}

function sourceFromOffset(source: string, byteOffset: number, cellId: string): string {
  const bytes = Buffer.from(source, 'utf8');
  if (byteOffset >= bytes.length || (bytes[byteOffset]! & 0xc0) === 0x80) {
    throw coreError('CURSOR_EXPIRED', 'the source cursor is not on an unread UTF-8 boundary', {
      details: { cell_id: cellId, byte_offset: byteOffset }
    });
  }
  return bytes.subarray(byteOffset).toString('utf8');
}

/** Resolve a selector to the entries to read, in document order. */
export function selectEntries(
  notebook: YNotebook,
  index: CellIndex,
  selector: CellSelector | undefined,
  binding: StructureRevision
): { entries: CellEntry[]; offset: number; paged: boolean; sourceOffset: number } {
  if (selector?.cellIds !== undefined) {
    return { entries: selector.cellIds.map((id) => index.require(id)), offset: 0, paged: false, sourceOffset: 0 };
  }
  if (selector?.cursor?.startsWith('src_') === true) {
    const parsed = parseSourceCursor(selector.cursor);
    if (parsed === null) {
      throw coreError('INVALID_ARGUMENT', 'not a source cursor issued by this process', {
        details: { cursor: selector.cursor }
      });
    }
    if (parsed.binding !== binding) {
      throw coreError('CURSOR_EXPIRED', 'the notebook structure changed since this source cursor', {
        details: { cursor: selector.cursor }
      });
    }
    const entry = [...index.entries].find((candidate) => candidate.identityToken === parsed.identityToken);
    if (entry === undefined) {
      throw coreError('CURSOR_EXPIRED', 'the cell changed since this source cursor', {
        details: { cursor: selector.cursor }
      });
    }
    const cell = resolveCell(notebook, entry);
    const revision = sourceRevision(cellTypeOf(cell), cell.getSource());
    if (revision !== parsed.sourceRevision) {
      throw coreError('CURSOR_EXPIRED', 'the cell source changed since this source cursor', {
        details: { cursor: selector.cursor }
      });
    }
    return {
      entries: [...index.entries].slice(entry.index),
      offset: entry.index,
      paged: true,
      sourceOffset: parsed.byteOffset
    };
  }
  const offset = selector?.cursor === undefined ? 0 : offsetFromCursor(selector.cursor, binding);
  return { entries: [...index.entries].slice(offset), offset, paged: true, sourceOffset: 0 };
}

/** `notebook_read(view: 'cells')` (SPEC.md §9). */
export function readCells(
  notebook: YNotebook,
  index: CellIndex,
  selector?: CellSelector,
  limits: ReadLimits = {}
): CellsRead {
  const structure = structureRevisionOf(index);
  const binding = pageBindingOf(index);
  const maxCells = limits.maxCells ?? DEFAULT_MAX_CELLS;
  const maxBytes = limits.maxBytes ?? DEFAULT_MAX_BYTES;
  const { entries, offset, paged, sourceOffset } = selectEntries(notebook, index, selector, binding);

  const cells: CellRead[] = [];
  let used = 0;
  let truncated = false;
  let taken = 0;
  for (const [position, entry] of entries.entries()) {
    if (cells.length >= maxCells) {
      truncated = true;
      break;
    }
    if (used >= maxBytes && cells.length > 0) {
      truncated = true;
      break;
    }
    const cell = resolveCell(notebook, entry);
    const type = cellTypeOf(cell);
    const full = cell.getSource();
    const remainder = position === 0 && sourceOffset > 0
      ? sourceFromOffset(full, sourceOffset, entry.cellId)
      : full;
    const cut = truncateUtf8(remainder, Math.max(0, maxBytes - used));
    if (cut.text.length === 0 && remainder.length > 0) {
      const first = Buffer.from(remainder, 'utf8');
      let requiredBytes = 1;
      while (requiredBytes < first.length && (first[requiredBytes]! & 0xc0) === 0x80) requiredBytes++;
      throw coreError('RESOURCE_LIMIT', 'the next UTF-8 code point exceeds the cell-read byte budget', {
        details: { cell_id: entry.cellId, required_bytes: requiredBytes, max_bytes: maxBytes - used }
      });
    }
    used += utf8Length(cut.text);
    const attachments =
      type === 'code' ? undefined : (cell as { getAttachments?: () => unknown }).getAttachments?.();
    const state = executionStateOf(cell);
    cells.push({
      cellId: entry.cellId,
      identityToken: entry.identityToken,
      index: entry.index,
      cellType: type,
      source: cut.text,
      sourceTruncated: cut.text.length !== remainder.length,
      sourceOffset: position === 0 ? sourceOffset : 0,
      sourceComplete: (position !== 0 || sourceOffset === 0) && cut.text.length === remainder.length,
      sourceBytes: utf8Length(full),
      metadata: (cell.getMetadata() ?? {}) as Record<string, unknown>,
      ...(attachments === undefined || attachments === null
        ? {}
        : { attachments: attachments as Record<string, unknown> }),
      sourceRevision: sourceRevision(type, full),
      cellRevision: cellRevision(cellJson(cell)),
      outputsRevision: isCodeCell(cell) ? outputsRevision(outputsOf(cell)) : null,
      executionCount: isCodeCell(cell) ? cell.execution_count : null,
      ...(state === undefined ? {} : { executionState: state })
    });
    taken++;
    if (cut.text.length !== remainder.length) {
      truncated = true;
      const consumed = sourceOffset + utf8Length(cut.text);
      return {
        cells,
        truncated: true,
        structureRevision: structure,
        nextCursor: makeSourceCursor(binding, entry, sourceRevision(type, full), consumed)
      };
    }
  }

  const more = paged && offset + taken < index.size;
  return {
    cells,
    truncated: truncated || more,
    structureRevision: structure,
    ...(more ? { nextCursor: makePageCursor(binding, offset + taken) } : {})
  };
}

const MAX_TEXT_PREVIEW_BYTES = 2048;

function mimeTypesOf(output: NbOutput): string[] {
  if (output.output_type === 'stream' || output.output_type === 'error') return ['text/plain'];
  const data = (output as { data?: Record<string, unknown> }).data;
  return data === undefined || data === null ? [] : Object.keys(data).sort();
}

function textOf(output: NbOutput): string | null {
  if (output.output_type === 'stream') {
    return typeof output.text === 'string' ? output.text : output.text.join('');
  }
  if (output.output_type === 'error') {
    return stripAnsi([output.ename + ': ' + output.evalue, ...output.traceback].join('\n'));
  }
  const plain = (output as { data?: Record<string, unknown> }).data?.['text/plain'];
  if (typeof plain === 'string') return plain;
  if (Array.isArray(plain)) return plain.join('');
  return null;
}

/** `notebook_read(view: 'outputs')` (SPEC.md §9). */
export function readOutputs(
  notebook: YNotebook,
  index: CellIndex,
  cellIds: readonly string[],
  limits: ReadLimits = {}
): OutputsRead {
  const maxBytes = limits.maxBytes ?? DEFAULT_MAX_BYTES;
  const maxOutputBytes = limits.maxOutputBytes ?? maxBytes;
  const maxCells = limits.maxCells ?? DEFAULT_MAX_CELLS;
  let used = 0;
  let anyTruncated = false;
  const cells: CellOutputsRead[] = [];

  for (const cellId of cellIds.slice(0, maxCells)) {
    const entry = index.require(cellId);
    const cell = resolveCell(notebook, entry);
    const code = isCodeCell(cell);
    const outputs = outputsOf(cell);
    const reads: OutputRead[] = [];
    let cellTruncated = false;
    for (let position = 0; position < outputs.length; position++) {
      const output = outputs[position]!;
      const serialised = JSON.stringify(output) ?? '';
      const byteSize = utf8Length(serialised);
      const remaining = Math.max(0, maxBytes - used);
      if (byteSize <= Math.min(remaining, maxOutputBytes)) {
        used += byteSize;
        reads.push({
          index: position,
          outputType: output.output_type,
          mimeTypes: mimeTypesOf(output),
          byteSize,
          truncated: false,
          ...(output.output_type === 'error'
            ? { ename: output.ename, evalue: output.evalue }
            : {}),
          output
        });
        continue;
      }
      const text = textOf(output);
      const previewBudget = Math.min(remaining, maxOutputBytes, MAX_TEXT_PREVIEW_BYTES);
      const preview =
        text === null || previewBudget <= 0
          ? undefined
          : truncateUtf8(text.slice(0, limits.previewChars ?? 512), previewBudget).text;
      const textTruncated = text === null || preview !== text ||
        mimeTypesOf(output).some((mime) => mime !== 'text/plain');
      cellTruncated ||= textTruncated;
      anyTruncated ||= textTruncated;
      if (preview !== undefined) used += utf8Length(preview);
      reads.push({
        index: position,
        outputType: output.output_type,
        mimeTypes: mimeTypesOf(output),
        byteSize,
        truncated: textTruncated,
        ...(output.output_type === 'error'
          ? { ename: output.ename, evalue: output.evalue }
          : {}),
        ...(preview === undefined || preview === '' ? {} : { textPreview: preview })
      });
    }
    const state = executionStateOf(cell);
    cells.push({
      cellId: entry.cellId,
      identityToken: entry.identityToken,
      index: entry.index,
      cellType: cellTypeOf(cell),
      sourceRevision: sourceRevision(cellTypeOf(cell), cell.getSource()),
      cellRevision: cellRevision(cellJson(cell)),
      outputsRevision: code ? outputsRevision(outputs) : null,
      outputs: reads,
      executionCount: code ? cell.execution_count : null,
      ...(state === undefined ? {} : { executionState: state }),
      truncated: cellTruncated
    });
  }

  return { cells, truncated: anyTruncated || cellIds.length > maxCells };
}
