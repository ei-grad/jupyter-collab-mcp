/**
 * Kernel routing, output reduction and execution jobs (SPEC.md §4, §8).
 *
 * Three layers, deliberately separable:
 *
 * 1. {@link createExecutionReducer} - pure protocol to output-area commands;
 * 2. {@link KernelClient} - one WebSocket and one receiver per kernel;
 * 3. {@link ExecutionRegistry} - sequential jobs, targets re-checked before
 *    every send, and the `not_sent` / `unknown` distinction.
 *
 * Nothing here touches Yjs or the MCP SDK: outputs leave through the
 * `OutputSink` seam declared in `src/core`.
 *
 * @module
 */

export {
  DEFAULT_MAX_DISPLAY_IDS,
  DEFAULT_MAX_TARGETS_PER_ID,
  DisplayRegistry,
  sameOutputArea
} from './display-registry.js';
export type { DisplayRegistryOptions, DisplayTarget, OutputAreaRef } from './display-registry.js';

export {
  contentBoolean,
  contentNumber,
  contentRecord,
  contentString,
  contentWithoutTransient,
  fromKernelMessage,
  joinText,
  parentMsgId,
  transientDisplayId
} from './messages.js';
export type { JupyterHeader, JupyterMessage, OutputMsgType } from './messages.js';

export { DEFAULT_MAX_OUTPUT_BYTES, createExecutionReducer } from './output-reducer.js';
export type {
  ExecutionReducer,
  ExecutionReducerOptions,
  ReducerEffect,
  ReducerState,
  ReducerStatus
} from './output-reducer.js';

export { KernelClient } from './kernel-client.js';
export type {
  ExecutionRoute,
  KernelChangeReason,
  KernelChangedEvent,
  KernelClientOptions,
  KernelObservedStatus,
  RequestExecuteOptions,
  RequestExecuteResult,
  Unsubscribe
} from './kernel-client.js';

export { ExecutionRegistry } from './execution-registry.js';
export type {
  ExecutionCellRequest,
  NotebookRef,
  Revalidate,
  RevalidateResult,
  SubmitRequest
} from './execution-registry.js';

export { finalState, markRest, newCell, snapshotCell, snapshotJob } from './job-record.js';
export type {
  JobRecord,
  JobSnapshot,
  KernelCellRecord,
  KernelExecutionJob,
  MutableCell
} from './job-record.js';
