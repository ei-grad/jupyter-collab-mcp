/**
 * `src/service` - the registry layer of SPEC.md §4.
 *
 * It implements `CollabService` (`src/core/service.ts`) on top of the three
 * lower modules: `src/jupyter` (REST + RTC), `src/core/notebook` (the live
 * replica) and `src/kernel` (kernel protocol and execution queue). Everything
 * stateful the service owns lives here - servers, working sessions, notebook
 * handles, jobs, output snapshots and the `request_id` ledger - and nothing
 * here knows about MCP.
 *
 * @module
 */

export { createCollabService, DEFAULT_OUTPUT_STORE_BYTES } from './service.js';
export type { CollabServiceOptions } from './service.js';

export { ServerRegistry, describeServer } from './server-registry.js';
export type { ServerEntry, ServerRegistryOptions } from './server-registry.js';

export { resolveCredential, resolveServer } from './credentials.js';
export type { CredentialSources } from './credentials.js';

export { discoverLocalServers, jupyterRuntimeDir, runtimeDirCandidates } from './discovery.js';
export type { DiscoveredServer, DiscoveryEnvironment } from './discovery.js';

export { MAX_REQUEST_ID, RequestLedger, parseRequestId, payloadDigest } from './ledger.js';
export type {
  BeginRequest,
  DedupTool,
  LedgerDecision,
  LedgerLimits,
  Receipt,
  ReplayPayload
} from './ledger.js';

export { Mutex } from './mutex.js';

export { SessionRegistry, WorkingSession } from './session.js';
export type { KernelBinding, WorkingSessionInit } from './session.js';

export { HANDLE_LIFETIME, NotebookHandle, SESSION_LIFETIME } from './notebook-handle.js';
export type { NotebookHandleInit } from './notebook-handle.js';

export { KernelHub } from './kernel-hub.js';
export type { KernelLease } from './kernel-hub.js';

export {
  OUTPUT_URI_SCHEME,
  OutputStore,
  SNAPSHOT_LIFETIME,
  mimeTypesOf,
  nbText,
  outputByteSize,
  outputUri,
  parseOutputUri
} from './outputs.js';
export type { OutputAddress, OutputSnapshot } from './outputs.js';

export {
  TERMINAL_JOB_STATES,
  buildExecutionView,
  effectiveLimits,
  finishCompletedCells,
  isActive,
  makeExecutionCursor,
  parseExecutionCursor,
  toOutputEntry,
  watchJob
} from './execution.js';
export type { ExecutionRecord, ExecutionViewOptions, ParsedExecutionCursor } from './execution.js';
