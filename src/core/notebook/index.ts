/**
 * `src/core/notebook` - the live CRDT replica of one notebook.
 *
 * Implements SPEC.md §7 (cells, revisions, concurrent edits), the document
 * side of §8 (output-area generations), §9 (bounded reads and cursors) and
 * §10 (the change journal), over `@jupyter/ydoc`'s `YNotebook`. No network,
 * no Jupyter Server, no MCP.
 *
 * @module
 */

export { NotebookModel } from './model.js';
export type { NotebookModelOptions } from './model.js';

export { CellIndex } from './cell-index.js';
export type { CellEntry, IdentifiedCellRef, StructureDiff } from './cell-index.js';
export { isEmptyDiff } from './cell-index.js';

export { ChangeJournal, DEFAULT_COALESCE_MS, DEFAULT_JOURNAL_LIMIT } from './journal.js';
export type { ChangeDraft, ChangeJournalOptions, ChangesPage } from './journal.js';

export { GenerationRegistry, OutputGeneration } from './generations.js';
export type { GenerationHost, GenerationRegistryHost } from './generations.js';

export { NotebookObserver } from './observer.js';
export type { ObserverHost } from './observer.js';

export {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_CELLS,
  DEFAULT_PREVIEW_CHARS,
  cellTypeOf,
  isCodeCell
} from './read.js';

export { withIdentity } from './types.js';
export type {
  CellOutputsRead,
  CellRead,
  CellSelector,
  CellsRead,
  DeleteCellMetadataOp,
  DeleteNotebookMetadataOp,
  MetadataKeyPath,
  ModelApplyResult,
  ModelOperation,
  NotebookIdentity,
  NotebookModelSummary,
  OutputRead,
  OutputsRead,
  ReadLimits,
  SetCellMetadataOp,
  SetNotebookMetadataOp,
  SummaryLimits
} from './types.js';

export { deleteAtPath, getAtPath, normalizePath, setAtPath } from './metadata.js';
export type { MetadataObject } from './metadata.js';

export { findSingleOccurrence, minimalReplace, previewOf, truncateUtf8, utf8Length } from './text.js';
export type { OccurrenceResult, TextEdit } from './text.js';
