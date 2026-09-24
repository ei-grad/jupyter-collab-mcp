/**
 * Public surface of the client core.
 *
 * Everything re-exported here is dependency-free apart from `node:crypto`:
 * no Yjs, no `@jupyterlab/services`, no MCP SDK. The transport
 * (`src/jupyter`), the notebook model (`src/core/notebook`), the kernel
 * (`src/kernel`) and the MCP adapter (`src/mcp`) all implement against these
 * types, which keeps the core independent of MCP as required by SPEC.md §1.
 *
 * @module
 */

export {
  CoreError,
  DEFAULTS,
  ERROR_CODES,
  coreError,
  isCoreError,
  isErrorCode,
  redactCredentials,
  toCoreError
} from './errors.js';
export type {
  CoreErrorOverrides,
  ErrorCode,
  ErrorDefaults,
  Retryable,
  SideEffects
} from './errors.js';

export {
  REVISION_BODY_LENGTH,
  REVISION_PREFIX,
  canonicalJson,
  cellRevision,
  isRevisionOfKind,
  notebookMetadataRevision,
  outputsRevision,
  revisionKind,
  sourceRevision,
  structureRevision
} from './revision.js';
export type {
  CellRevision,
  JsonValue,
  NotebookMetadataRevision,
  OutputsRevision,
  Revision,
  RevisionKind,
  SourceRevision,
  StructureRevision
} from './revision.js';

export {
  makeChangesCursor,
  makePageCursor,
  parseChangesCursor,
  parsePageCursor
} from './types.js';
export type {
  AbortedReason,
  AddCellAnchor,
  AddCellOperation,
  ApplyResult,
  BeginExecutionGeneration,
  CellExecutionRecord,
  CellRef,
  CellRunState,
  CellSummary,
  CellType,
  CellObservation,
  ChangeEvent,
  ChangeKind,
  ChangeRevisions,
  ChangesCursor,
  ClearOutputsOperation,
  ConnectionState,
  CredentialRef,
  DeleteCellMetadataOperation,
  DeleteCellOperation,
  DeleteNotebookMetadataOperation,
  DeliveryState,
  ExecutionJob,
  JobState,
  KernelChannelState,
  KernelExecutionStatus,
  KernelStatus,
  MimeBundle,
  NbDisplayDataOutput,
  NbErrorOutput,
  NbExecuteResultOutput,
  NbOutput,
  NbStreamOutput,
  NotSentReason,
  NotebookSummary,
  Operation,
  OperationKind,
  OperationResult,
  OutputMetadata,
  OutputSink,
  OutputSinkFactory,
  PageCursor,
  SourceCursor,
  PersistenceState,
  ReadView,
  ReplaceSourceOperation,
  ReplaceTextOperation,
  ResolvedServer,
  SaveStatus,
  ServerDescriptor,
  ServerKind,
  ServerProfile,
  HubLifecycleConfig,
  UpstreamAuth,
  ServerStartProfile,
  SetCellMetadataOperation,
  SetNotebookMetadataOperation,
  SharedExecutionState
} from './types.js';

export {
  DEFAULT_AWARENESS_USER,
  DEFAULT_SERVICE_LIMITS,
  withDefaults
} from './config.js';
export type {
  AwarenessUser,
  DiscoveryMode,
  ServiceConfig,
  ServiceConfigInput,
  ServiceLimits
} from './config.js';

export type {
  CellContent,
  CellOutputsView,
  CollabService,
  ServerStatusRequest,
  ServerStatusResult,
  ServerStartRequest,
  DirectoryCursor,
  ExecuteTarget,
  ExecutionCancelRequest,
  ExecutionCancelResult,
  ExecutionCellView,
  ExecutionCursor,
  ExecutionGetRequest,
  ExecutionId,
  ExecutionView,
  HandleLifetime,
  HandleRelease,
  KernelAction,
  KernelControlEffects,
  KernelControlRequest,
  KernelControlResult,
  KernelInterruptRequest,
  KernelListRequest,
  KernelListResult,
  KernelRestartRequest,
  KernelShutdownRequest,
  KernelSpecInfo,
  KernelStartRequest,
  KernelStatusRequest,
  KernelStatusResult,
  KernelSwitchRequest,
  LifetimeScope,
  ListOutputResourcesResult,
  NotebookApplyRequest,
  NotebookApplyResult,
  NotebookCellsReadRequest,
  NotebookCellsReadResult,
  NotebookChangesRequest,
  NotebookChangesResult,
  NotebookCloseRequest,
  NotebookCloseResult,
  NotebookCreateRequest,
  NotebookCreateResult,
  NotebookExecuteRequest,
  NotebookHandleInfo,
  NotebookId,
  NotebookListEntry,
  NotebookListRequest,
  NotebookListResult,
  NotebookOpenRequest,
  NotebookOpenResult,
  NotebookOutputsReadRequest,
  NotebookOutputsReadResult,
  NotebookReadCommon,
  NotebookReadRequest,
  NotebookReadResult,
  NotebookSaveRequest,
  NotebookSaveResult,
  NotebookSessionInfo,
  NotebookSummaryReadRequest,
  NotebookSummaryReadResult,
  OutputCursor,
  OutputEntry,
  OutputId,
  OutputReadRequest,
  OutputReadResult,
  OutputResourceContents,
  OutputResourceDescriptor,
  OutputSnapshotRef,
  RequestId,
  ResponseLimits,
  RunningKernelInfo,
  ServerListEntry,
  ServerListResult,
  ServerOrigin,
  SessionCloseRequest,
  SessionCloseResult,
  SessionEnvelope,
  SessionId,
  SessionOpenRequest,
  SessionOpenResult,
  ShutdownReason,
  WaitOptions,
  WithEnvelope
} from './service.js';
