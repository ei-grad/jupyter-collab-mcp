/**
 * Types the notebook model adds on top of the shared contracts in
 * `src/core/types.ts`.
 *
 * Everything here is *model scoped*: the model owns the shared document and
 * nothing else. Facts that belong to the connection - `notebook_id`, the
 * Contents `path`, `fileId`, `document_id`, the RTC {@link ConnectionState}
 * and therefore the `stale` flag of SPEC.md §6 - are added by the layer above,
 * which is why {@link NotebookModelSummary} is `NotebookSummary` minus exactly
 * those fields and {@link withIdentity} puts them back.
 *
 * @module
 */

import type {
  ApplyResult,
  CellSummary,
  CellType,
  ConnectionState,
  NbOutput,
  NotebookSummary,
  OperationResult,
  PageCursor,
  SourceCursor,
  SetCellMetadataOperation,
  DeleteCellMetadataOperation,
  SetNotebookMetadataOperation,
  DeleteNotebookMetadataOperation,
  Operation,
  SharedExecutionState
} from '../types.js';
import type {
  CellRevision,
  OutputsRevision,
  SourceRevision,
  StructureRevision
} from '../revision.js';
import type { CoreError } from '../errors.js';

/**
 * A metadata key path. SPEC.md §7 speaks of metadata operations "by key";
 * an array addresses a nested key, e.g. `['jupyter', 'source_hidden']`.
 * A plain string is the single-segment form used by the shared contract.
 */
export type MetadataKeyPath = string | readonly string[];

/** {@link SetCellMetadataOperation} widened to a nested key path. */
export type SetCellMetadataOp = Omit<SetCellMetadataOperation, 'key'> & {
  readonly key: MetadataKeyPath;
};
/** {@link DeleteCellMetadataOperation} widened to a nested key path. */
export type DeleteCellMetadataOp = Omit<DeleteCellMetadataOperation, 'key'> & {
  readonly key: MetadataKeyPath;
};
/** {@link SetNotebookMetadataOperation} widened to a nested key path. */
export type SetNotebookMetadataOp = Omit<SetNotebookMetadataOperation, 'key'> & {
  readonly key: MetadataKeyPath;
};
/** {@link DeleteNotebookMetadataOperation} widened to a nested key path. */
export type DeleteNotebookMetadataOp = Omit<DeleteNotebookMetadataOperation, 'key'> & {
  readonly key: MetadataKeyPath;
};

/**
 * The operation set {@link NotebookModel.apply} accepts.
 *
 * Every {@link Operation} of the shared contract is assignable to it: the only
 * difference is that the four metadata operations also accept a nested key
 * path.
 */
export type ModelOperation =
  | Exclude<
      Operation,
      | SetCellMetadataOperation
      | DeleteCellMetadataOperation
      | SetNotebookMetadataOperation
      | DeleteNotebookMetadataOperation
    >
  | SetCellMetadataOp
  | DeleteCellMetadataOp
  | SetNotebookMetadataOp
  | DeleteNotebookMetadataOp;

/**
 * Result of one `apply()` batch.
 *
 * `delivery` and `persistence` are deliberately absent: the model applies to
 * the local replica, and only the RTC connection knows whether the update left
 * the socket or reached the file (SPEC.md §6 "Delivery and persistence").
 */
export interface ModelApplyResult extends Omit<ApplyResult, 'delivery' | 'persistence'> {
  readonly results: readonly OperationResult[];
  /**
   * Set when an unexpected failure happened *after* the first mutation.
   * SPEC.md §7: a Yjs transaction is not a database transaction with rollback,
   * so the answer says the batch may be partially applied and names the
   * operation that failed; the caller must re-read the affected cells.
   */
  readonly partial?: boolean;
  /** The failure behind {@link partial}; never present on a clean batch. */
  readonly partialError?: CoreError;
  /** Index of the operation that failed, when {@link partial} is set. */
  readonly partialAtOperation?: number;
}

/** Summary limits (SPEC.md §9: 100 cells by default). */
export interface SummaryLimits {
  readonly maxCells?: number;
  readonly previewChars?: number;
  /** Continue a paged summary; must match the current structural revision. */
  readonly cursor?: PageCursor;
}

/** `NotebookSummary` minus the fields only the connection layer knows. */
export type NotebookModelSummary = Omit<
  NotebookSummary,
  'notebookId' | 'path' | 'fileId' | 'documentId' | 'connectionState' | 'stale'
>;

/** Identity of the open document, supplied by the connection layer. */
export interface NotebookIdentity {
  readonly notebookId: string;
  readonly path: string;
  readonly fileId: string;
  /** `json:notebook:<fileId>` - the room name (SPEC.md §6 item 5). */
  readonly documentId: string;
  readonly connectionState: ConnectionState;
  /** SPEC.md §6: a read before readiness is served but marked stale. */
  readonly stale: boolean;
}

/** Complete a model summary into the `notebook_read` shape of SPEC.md §9. */
export function withIdentity(
  summary: NotebookModelSummary,
  identity: NotebookIdentity
): NotebookSummary {
  return { ...identity, ...summary };
}

/** Byte/count budget of a content read (SPEC.md §9). */
export interface ReadLimits {
  readonly maxCells?: number;
  /** UTF-8 budget for the whole answer. Default 64 KiB (SPEC.md §9). */
  readonly maxBytes?: number;
  /** Per-output UTF-8 inline payload budget; the aggregate maxBytes still applies. */
  readonly maxOutputBytes?: number;
}

/** Which cells to read; exactly one form, like the MCP arguments. */
export type CellSelector =
  | { readonly cellIds: readonly string[]; readonly cursor?: never }
  | { readonly cellIds?: never; readonly cursor?: PageCursor | SourceCursor };

/** One cell of `notebook_read(view: 'cells')` (SPEC.md §9). */
export interface CellRead {
  readonly cellId: string;
  /** Internal identity of the live Y.Map; retained through the service layer. */
  readonly identityToken?: string;
  readonly index: number;
  readonly cellType: CellType;
  /** Possibly truncated; see {@link sourceTruncated} and {@link sourceBytes}. */
  readonly source: string;
  readonly sourceTruncated: boolean;
  /** Full UTF-8 size of the source, even when truncated. */
  readonly sourceBytes: number;
  readonly metadata: Readonly<Record<string, unknown>>;
  /** Present for markdown/raw cells that carry attachments; read-only in v1. */
  readonly attachments?: Readonly<Record<string, unknown>>;
  readonly sourceRevision: SourceRevision;
  readonly cellRevision: CellRevision;
  readonly outputsRevision: OutputsRevision | null;
  readonly executionCount: number | null;
  readonly executionState?: SharedExecutionState;
}

/** Answer of {@link NotebookModel.readCells}. */
export interface CellsRead {
  readonly cells: readonly CellRead[];
  /** `true` when a limit stopped the read before the selection was exhausted. */
  readonly truncated: boolean;
  readonly structureRevision: StructureRevision;
  /** Present when source or later cells remain; bound to their current identity and revision. */
  readonly nextCursor?: PageCursor | SourceCursor;
}

/**
 * One output of `notebook_read(view: 'outputs')` (SPEC.md §9).
 *
 * A payload that does not fit the byte budget is **not** inlined: the entry
 * keeps its MIME list and total size and sets {@link truncated}, so a large
 * PNG never lands in a text answer.
 */
export interface OutputRead {
  readonly index: number;
  readonly outputType: string;
  /** MIME types present in the bundle; empty for `stream` and `error`. */
  readonly mimeTypes: readonly string[];
  /** Full UTF-8 size of the serialised output. */
  readonly byteSize: number;
  readonly truncated: boolean;
  /** The output itself, only when it fit the budget. */
  readonly output?: NbOutput;
  /** Short text excerpt of a truncated textual output, within the budget. */
  readonly textPreview?: string;
}

/** Outputs of one cell. */
export interface CellOutputsRead {
  readonly cellId: string;
  /** Internal identity of the live Y.Map; retained through the service layer. */
  readonly identityToken?: string;
  readonly index: number;
  readonly cellType: CellType;
  readonly sourceRevision: SourceRevision;
  readonly cellRevision: CellRevision;
  /** `null` for markdown and raw cells, which have no output area. */
  readonly outputsRevision: OutputsRevision | null;
  readonly outputs: readonly OutputRead[];
  readonly executionCount: number | null;
  readonly executionState?: SharedExecutionState;
  readonly truncated: boolean;
}

/** Answer of {@link NotebookModel.readOutputs}. */
export interface OutputsRead {
  readonly cells: readonly CellOutputsRead[];
  readonly truncated: boolean;
}

/** Row of the model summary; identical to the shared contract. */
export type { CellSummary };
