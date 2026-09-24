/**
 * A `CollabService` that touches nothing and records every call.
 *
 * It is the whole world the adapter tests run against: no Jupyter server, no
 * Yjs document, no kernel. Every method returns a plausible, fully populated
 * answer so the adapter's renaming, size bounding and content-block decisions
 * have something realistic to chew on, and `calls` lets a test assert the
 * camelCase request the adapter built.
 *
 * It also exports `createService`, which is the module shape
 * `JUPYTER_COLLAB_MCP_SERVICE_MODULE` expects, so the same fake can be loaded
 * by a real `cli.ts` child process.
 */

import { coreError } from '../../src/core/index.js';
// `NotebookReadResultFor` is not re-exported from `src/core/index.ts`; the
// facade file is the public source for it.
import type { NotebookReadResultFor } from '../../src/core/service.js';
import type {
  CellRevision,
  ChangesCursor,
  CollabService,
  ExecutionCancelRequest,
  ExecutionCancelResult,
  ExecutionGetRequest,
  ExecutionView,
  HandleLifetime,
  KernelControlRequest,
  KernelControlResult,
  KernelListRequest,
  KernelListResult,
  KernelStatusRequest,
  KernelStatusResult,
  ListOutputResourcesResult,
  NotebookApplyRequest,
  NotebookApplyResult,
  NotebookChangesRequest,
  NotebookChangesResult,
  NotebookCloseRequest,
  NotebookCloseResult,
  NotebookCreateRequest,
  NotebookCreateResult,
  NotebookExecuteRequest,
  NotebookHandleInfo,
  NotebookListRequest,
  NotebookListResult,
  NotebookMetadataRevision,
  NotebookOpenRequest,
  NotebookOpenResult,
  NotebookReadRequest,
  NotebookReadResult,
  NotebookSaveRequest,
  NotebookSaveResult,
  NotebookSummary,
  OutputReadRequest,
  OutputReadResult,
  OutputResourceContents,
  OutputsRevision,
  PageCursor,
  ServerListResult,
  ServerStatusRequest,
  ServerStatusResult,
  ServerStartRequest,
  SessionCloseRequest,
  SessionCloseResult,
  SessionOpenRequest,
  SessionOpenResult,
  ShutdownReason,
  SourceRevision,
  StructureRevision,
  WithEnvelope
} from '../../src/core/index.js';

/** Cast a plain string into one of the branded revision/cursor types. */
const brand = <T>(value: string): T => value as unknown as T;

const SRC: SourceRevision = brand('s1_aaaaaaaaaaaaaaaa');
const CELL: CellRevision = brand('c1_bbbbbbbbbbbbbbbb');
const OUT: OutputsRevision = brand('o1_cccccccccccccccc');
const OUT_AFTER_EXECUTION: OutputsRevision = brand('o1_ffffffffffffffff');
const NBMETA: NotebookMetadataRevision = brand('m1_dddddddddddddddd');
const STRUCT: StructureRevision = brand('x1_eeeeeeeeeeeeeeee');
const CURSOR: ChangesCursor = brand('chg_7');
const PAGE: PageCursor = brand('pg_x1_eeeeeeeeeeeeeeee.100');

/** 1x1 transparent PNG - small enough to be inlined as image content. */
export const TINY_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

/** Big enough to exceed the adapter's inline-image budget in the tests. */
export const BIG_PNG = `${TINY_PNG}${'A'.repeat(400_000)}`;

const LIFETIME_NOTEBOOK: HandleLifetime = {
  scope: 'until_close_or_process_exit',
  releasedBy: ['notebook_close', 'session_close', 'process_exit'],
  processScoped: true
};
const LIFETIME_JOB: HandleLifetime = {
  scope: 'until_session_close',
  releasedBy: ['session_close', 'process_exit'],
  processScoped: true
};

const NOTEBOOK: NotebookHandleInfo = {
  notebookId: 'nb_1',
  sessionId: 'ses_1',
  path: 'work/analysis.ipynb',
  fileId: 'file-1',
  documentId: 'json:notebook:file-1',
  connectionState: 'ready',
  stale: false,
  lifetime: LIFETIME_NOTEBOOK
};

const SUMMARY: NotebookSummary = {
  notebookId: 'nb_1',
  path: 'work/analysis.ipynb',
  fileId: 'file-1',
  documentId: 'json:notebook:file-1',
  connectionState: 'ready',
  stale: false,
  nbformat: 4,
  nbformatMinor: 5,
  cellCount: 2,
  cells: [
    {
      cellId: 'cell_a',
      identityToken: 'identity-cell-a',
      index: 0,
      cellType: 'code',
      sourceRevision: SRC,
      cellRevision: CELL,
      outputsRevision: OUT,
      executionCount: 3,
      executionState: 'idle',
      preview: 'df.head()'
    },
    {
      cellId: 'cell_b',
      identityToken: 'identity-cell-b',
      index: 1,
      cellType: 'markdown',
      sourceRevision: SRC,
      cellRevision: CELL,
      outputsRevision: null,
      executionCount: null,
      preview: '# Notes'
    }
  ],
  truncated: false,
  structureRevision: STRUCT,
  notebookMetadataRevision: NBMETA,
  duplicateCellIds: [],
  changesCursor: CURSOR
};

/** One recorded call. */
export interface RecordedCall {
  readonly method: string;
  readonly request: unknown;
}

/** Behaviour a test can switch on. */
export interface FakeOptions {
  /** Throw this from the next call of the named method. */
  readonly failWith?: { readonly method: string; readonly error: unknown };
  /** Return the oversized PNG instead of the tiny one. */
  readonly bigImage?: boolean;
  /** Emit this many summary cells, to exercise the response budget. */
  readonly bulkCells?: number;
  /** Mutable opaque preview used to verify reference-shaped user text. */
  readonly refLikePreview?: { value: string };
  readonly oversizedMetadata?: boolean;
  readonly oversizedMetadataSwitch?: { value: boolean };
  /** Put output-shaped user values in metadata and attachments. */
  readonly outputShapedOpaqueData?: boolean;
  /** Return a completed execution whose kernel result is failed. */
  readonly executionFailed?: boolean;
  /** Return an execution cell whose original Y.Map no longer exists. */
  readonly executionCellUnavailable?: boolean;
  /** Return a live execution observation that needs a newly issued ref. */
  readonly executionObservationChanged?: boolean;
  /** Return cancellation counts for accepted cells whose Y.Map no longer exists. */
  readonly cancelCellsUnavailable?: boolean;
  /** Make `readOutputResource` answer "too large for one read". */
  readonly resourceTooLarge?: boolean;
  /** Number of resource descriptors exposed through paginated listing. */
  readonly resourceCount?: number;
}

const envelope = { nextRequestId: '5' } as const;

/** The recording fake. */
export class FakeCollabService implements CollabService {
  readonly calls: RecordedCall[] = [];
  shutdownReasons: ShutdownReason[] = [];

  constructor(private readonly options: FakeOptions = {}) {}

  private record<T>(method: string, request: unknown, result: T): T {
    this.calls.push({ method, request });
    const failure = this.options.failWith;
    if (failure !== undefined && failure.method === method) throw failure.error;
    return result;
  }

  /** The last request the adapter built, for the named method. */
  lastRequest(method: string): unknown {
    for (let index = this.calls.length - 1; index >= 0; index--) {
      const call = this.calls[index];
      if (call !== undefined && call.method === method) return call.request;
    }
    return undefined;
  }

  async serverList(): Promise<ServerListResult> {
    return this.record('serverList', undefined, {
      servers: [
        {
          descriptor: { id: 'default', kind: 'standalone' as const, apiBaseUrl: 'http://127.0.0.1:8888' },
          origin: 'configured' as const,
          defaultChoice: true
        }
      ],
      discoveryEnabled: false,
      selectionRequired: false
    });
  }

  async serverStatus(request: ServerStatusRequest): Promise<ServerStatusResult> {
    return this.record('serverStatus', request, { serverId: 'default', state: 'ready', supportsStart: true, nextRequestId: '5' });
  }

  async serverStart(request: ServerStartRequest): Promise<WithEnvelope<ServerStatusResult>> {
    return this.record('serverStart', request, { serverId: 'default', state: 'ready', supportsStart: true, nextRequestId: '5', requestAccepted: true });
  }

  async sessionOpen(request: SessionOpenRequest): Promise<WithEnvelope<SessionOpenResult>> {
    return this.record('sessionOpen', request, {
      sessionId: 'ses_1',
      server: { id: 'default', kind: 'standalone' as const, apiBaseUrl: 'http://127.0.0.1:8888' },
      ...(request.label === undefined ? {} : { label: request.label }),
      lifetime: {
        scope: 'until_close_or_process_exit' as const,
        releasedBy: ['session_close' as const, 'process_exit' as const],
        processScoped: true
      },
      openedAt: '2026-09-06T10:00:00Z',
      kernelStarted: false,
      nextRequestId: '1'
    });
  }

  async sessionClose(request: SessionCloseRequest): Promise<WithEnvelope<SessionCloseResult>> {
    return this.record('sessionClose', request, {
      sessionId: request.sessionId,
      closedNotebookIds: ['nb_1'],
      droppedExecutionIds: [],
      alreadyClosed: false,
      kernelsLeftRunning: true,
      nextRequestId: null
    });
  }

  async notebookList(request: NotebookListRequest): Promise<WithEnvelope<NotebookListResult>> {
    return this.record('notebookList', request, {
      directory: request.directory,
      entries: [
        {
          name: 'analysis.ipynb',
          path: 'work/analysis.ipynb',
          type: 'notebook' as const,
          lastModified: '2026-09-06T09:00:00Z',
          size: 4096,
          session: {
            jupyterSessionId: 'jses_1',
            kernelId: 'k_1',
            kernelName: 'python3',
            executionStatus: 'idle' as const
          },
          openNotebookId: 'nb_1'
        }
      ],
      truncated: false,
      sessionsIncluded: true,
      ...envelope
    });
  }

  async notebookCreate(request: NotebookCreateRequest): Promise<WithEnvelope<NotebookCreateResult>> {
    return this.record('notebookCreate', request, {
      notebook: NOTEBOOK,
      untitledPath: `${request.directory}/Untitled.ipynb`,
      renamed: request.name !== undefined,
      summary: SUMMARY,
      changesCursor: CURSOR,
      nextRequestId: String(Number(request.requestId) + 1),
      requestAccepted: true,
      replayed: false,
      firstAcceptedAt: '2026-09-06T10:01:00Z'
    });
  }

  async notebookOpen(request: NotebookOpenRequest): Promise<WithEnvelope<NotebookOpenResult>> {
    return this.record('notebookOpen', request, {
      notebook: NOTEBOOK,
      reused: false,
      summary: this.summary(),
      changesCursor: CURSOR,
      ...envelope
    });
  }

  private summary(): NotebookSummary {
    const bulk = this.options.bulkCells;
    if (bulk === undefined) return SUMMARY;
    return {
      ...SUMMARY,
      cellCount: bulk,
      truncated: true,
      pageCursor: PAGE,
      cells: Array.from({ length: bulk }, (_unused, index) => ({
        cellId: `cell_${String(index)}`,
        identityToken: `identity-cell-${String(index)}`,
        index,
        cellType: 'code' as const,
        sourceRevision: SRC,
        cellRevision: CELL,
        outputsRevision: OUT,
        executionCount: null,
        preview: index === 0 && this.options.refLikePreview?.value !== undefined
          ? this.options.refLikePreview.value
          : `# a fairly long preview line number ${String(index)} ${'x'.repeat(200)}`
      }))
    };
  }

  async notebookClose(request: NotebookCloseRequest): Promise<WithEnvelope<NotebookCloseResult>> {
    return this.record('notebookClose', request, {
      notebookId: request.notebookId,
      alreadyClosed: false,
      droppedExecutionIds: [],
      kernelLeftRunning: true,
      ...envelope
    });
  }

  async notebookRead<R extends NotebookReadRequest>(
    request: R
  ): Promise<WithEnvelope<NotebookReadResultFor<R>>> {
    const common = {
      notebookId: request.notebookId,
      connectionState: 'ready' as const,
      stale: false,
      structureRevision: STRUCT,
      changesCursor: CURSOR,
      ...envelope
    };
    let result: NotebookReadResult;
    if (request.view === 'summary') {
      const summary = this.summary();
      result = {
        ...common,
        view: 'summary',
        summary,
        ...(summary.pageCursor === undefined ? {} : { nextCursor: summary.pageCursor })
      };
    } else if (request.view === 'cells') {
      const cursorOffset = request.cursor === undefined
        ? undefined
        : Number(String(request.cursor).slice(String(request.cursor).lastIndexOf('.') + 1));
      const selected = request.observedCells?.[0];
      const selectedCellId = selected?.cellId ??
        (this.options.bulkCells !== undefined && cursorOffset !== undefined ? `cell_${String(cursorOffset)}` : 'cell_a');
      const selectedIdentity = selected?.identityToken ??
        (this.options.bulkCells !== undefined && cursorOffset !== undefined ? `identity-cell-${String(cursorOffset)}` : 'identity-cell-a');
      const outputShapedValue = {
        output_type: 'display_data',
        index: 91,
        output: { output_type: 'display_data', data: { 'image/png': TINY_PNG }, metadata: {} }
      };
      result = {
        ...common,
        view: 'cells',
        cells: [
          {
            cellId: selectedCellId,
            identityToken: selectedIdentity,
            index: 0,
            cellType: 'code',
            source: selectedCellId === 'cell_a' ? 'df.head()' : `source for ${selectedCellId}`,
            sourceTruncated: false,
            sourceBytes: 9,
            metadata:
              this.options.oversizedMetadata === true || this.options.oversizedMetadataSwitch?.value === true
                ? { payload: 'x'.repeat(100_000) }
                : this.options.outputShapedOpaqueData === true
                  ? { 'user/Weird Key': outputShapedValue, value: ['kept', { exactlyAsGiven: true }] }
                  : { tags: ['keep'], 'user/Weird Key': 1 },
            ...(this.options.outputShapedOpaqueData === true
              ? { attachments: { 'opaque.png': { 'image/png': TINY_PNG }, nested: outputShapedValue } }
              : {}),
            sourceRevision: SRC,
            cellRevision: CELL,
            outputsRevision: OUT,
            executionCount: 3
          }
        ],
        truncated: false,
        notebookMetadata: { kernelspec: { name: 'python3' } },
        notebookMetadataRevision: NBMETA
      };
    } else {
      result = {
        ...common,
        view: 'outputs',
        cells: [
          {
            cellId: 'cell_a',
            identityToken: 'identity-cell-a',
            index: 0,
            cellType: 'code',
            sourceRevision: SRC,
            cellRevision: CELL,
            outputsRevision: OUT,
            outputs: this.outputs(),
            executionCount: 3,
            truncated: false
          }
        ],
        notebookMetadataRevision: NBMETA,
        truncated: false
      };
    }
    this.record('notebookRead', request, undefined);
    return result as WithEnvelope<NotebookReadResultFor<R>>;
  }

  private outputs(): ExecutionView['cells'][number]['outputs'] {
    const png = this.options.bigImage === true ? BIG_PNG : TINY_PNG;
    return [
      {
        index: 0,
        outputType: 'stream',
        mimeTypes: [],
        byteSize: 12,
        truncated: false,
        output: { output_type: 'stream', name: 'stdout', text: 'hello world\n' }
      },
      {
        index: 1,
        outputType: 'display_data',
        mimeTypes: ['image/png'],
        byteSize: png.length,
        truncated: false,
        output: { output_type: 'display_data', data: { 'image/png': png }, metadata: {} },
        snapshot: {
          outputId: 'out_1',
          uri: 'jupyter-output:out_1',
          mimeTypes: ['image/png'],
          byteSize: png.length,
          inlineImageAdvised: this.options.bigImage !== true,
          lifetime: LIFETIME_JOB
        }
      }
    ];
  }

  async notebookApply(request: NotebookApplyRequest): Promise<WithEnvelope<NotebookApplyResult>> {
    return this.record('notebookApply', request, {
      notebookId: request.notebookId,
      results: request.operations.map((operation) => ({
        op: operation.op,
        cellId: 'cell_a',
        identityToken: 'identity-cell-a',
        index: 0,
        sourceRevision: SRC,
        cellRevision: CELL,
        outputsRevision: OUT
      })),
      appliedLocally: true,
      delivery: 'sent' as const,
      persistence: 'unconfirmed' as const,
      structureRevision: STRUCT,
      changesCursor: CURSOR,
      nextRequestId: String(Number(request.requestId) + 1),
      requestAccepted: true,
      replayed: false,
      firstAcceptedAt: '2026-09-06T10:02:00Z'
    });
  }

  private view(executionId: string, notebookId: string): ExecutionView {
    const failed = this.options.executionFailed === true;
    return {
      executionId,
      notebookId,
      sessionId: 'ses_1',
      kernelId: 'k_1',
      state: failed ? 'failed' : 'succeeded',
      stopOnError: true,
      cells: [
        {
          cellId: 'cell_a',
          state: failed ? 'failed' : 'succeeded',
          sourceRevision: SRC,
          ...(this.options.executionCellUnavailable === true
            ? {}
            : {
                currentObservation: {
                  cellId: 'cell_a',
                  identityToken: 'identity-cell-a',
                  sourceRevision: SRC,
                  cellRevision: CELL,
                  outputsRevision: this.options.executionObservationChanged === true ? OUT_AFTER_EXECUTION : OUT
                }
              }),
          msgId: 'msg_1',
          executionCount: 4,
          sourceChanged: false,
          cellDeleted: false,
          outputIncomplete: false,
          outputs: this.outputs(),
          outputsReset: false,
          outputsTruncated: false
        }
      ],
      createdAt: '2026-09-06T10:03:00Z',
      finishedAt: '2026-09-06T10:03:02Z',
      ...(failed ? { reason: 'ValueError: boom' } : {}),
      cursor: 'exe_7',
      waitTimedOut: false,
      lifetime: LIFETIME_JOB
    };
  }

  async notebookExecute(request: NotebookExecuteRequest): Promise<WithEnvelope<ExecutionView>> {
    return this.record('notebookExecute', request, {
      ...this.view('exe_1', request.notebookId),
      nextRequestId: String(Number(request.requestId) + 1),
      requestAccepted: true,
      replayed: false,
      firstAcceptedAt: '2026-09-06T10:03:00Z'
    });
  }

  async executionGet(request: ExecutionGetRequest): Promise<WithEnvelope<ExecutionView>> {
    return this.record('executionGet', request, {
      ...this.view(request.executionId, 'nb_1'),
      ...envelope
    });
  }

  async executionCancel(request: ExecutionCancelRequest): Promise<WithEnvelope<ExecutionCancelResult>> {
    const unavailable = this.options.cancelCellsUnavailable === true;
    return this.record('executionCancel', request, {
      executionId: request.executionId,
      notebookId: 'nb_1',
      state: 'cancelled' as const,
      cancelledCells: unavailable ? [] : [{
        cellId: 'cell_b', identityToken: 'identity-cell-b', sourceRevision: SRC, cellRevision: CELL, outputsRevision: null
      }],
      unavailableCancelledCells: unavailable ? 1 : 0,
      alreadySentCells: unavailable ? [] : [{
        cellId: 'cell_a', identityToken: 'identity-cell-a', sourceRevision: SRC, cellRevision: CELL, outputsRevision: OUT
      }],
      unavailableAlreadySentCells: unavailable ? 1 : 0,
      kernelInterrupted: false,
      ...envelope
    });
  }

  async outputRead(request: OutputReadRequest): Promise<WithEnvelope<OutputReadResult>> {
    return this.record('outputRead', request, {
      outputId: request.outputId,
      uri: `jupyter-output:${request.outputId}`,
      outputType: 'display_data',
      mimeTypes: ['image/png'],
      mimeType: 'image/png',
      encoding: 'base64' as const,
      data: TINY_PNG,
      byteOffset: 0,
      byteSize: TINY_PNG.length,
      truncated: false,
      lifetime: LIFETIME_JOB,
      ...envelope
    });
  }

  async notebookChanges(request: NotebookChangesRequest): Promise<WithEnvelope<NotebookChangesResult>> {
    return this.record('notebookChanges', request, {
      notebookId: request.notebookId,
      events: [
        {
          sequence: 8,
          kind: 'source_changed' as const,
          cellId: 'cell_a',
          revisions: { sourceRevision: SRC, cellRevision: CELL },
          origin: 'remote' as const
        }
      ],
      nextCursor: brand<ChangesCursor>('chg_8'),
      truncated: false,
      connectionState: 'ready' as const,
      stale: false,
      waitTimedOut: false,
      ...envelope
    });
  }

  async notebookSave(request: NotebookSaveRequest): Promise<WithEnvelope<NotebookSaveResult>> {
    return this.record('notebookSave', request, {
      notebookId: request.notebookId,
      saveStatus: 'skipped' as const,
      revisionPersistence: 'unknown' as const,
      structureRevision: STRUCT,
      requestedAt: '2026-09-06T10:04:00Z',
      autosaveEnabled: true,
      ...envelope
    });
  }

  async kernelList(request: KernelListRequest): Promise<WithEnvelope<KernelListResult>> {
    return this.record('kernelList', request, {
      kernelspecs: [{ name: 'python3', displayName: 'Python 3', language: 'python' }],
      defaultKernelName: 'python3',
      running: [
        {
          kernelId: 'k_1',
          kernelName: 'python3',
          lastActivity: '2026-09-06T10:00:00Z',
          connections: 2,
          executionStatus: 'idle' as const,
          boundPaths: ['work/analysis.ipynb']
        }
      ],
      ...envelope
    });
  }

  private status(notebookId: string): KernelStatusResult {
    return {
      notebookId,
      kernelId: 'k_1',
      kernelName: 'python3',
      jupyterSessionId: 'jses_1',
      channelState: 'connected',
      executionStatus: 'idle',
      observedAt: '2026-09-06T10:05:00Z',
      activeExecutionIds: []
    };
  }

  async kernelStatus(request: KernelStatusRequest): Promise<WithEnvelope<KernelStatusResult>> {
    return this.record('kernelStatus', request, { ...this.status(request.notebookId), ...envelope });
  }

  async kernelControl(request: KernelControlRequest): Promise<WithEnvelope<KernelControlResult>> {
    return this.record('kernelControl', request, {
      notebookId: request.notebookId,
      action: request.action,
      previousKernelId: null,
      kernelId: 'k_1',
      kernelName: 'python3',
      jupyterSessionId: 'jses_1',
      effects: {
        kernelStarted: request.action === 'start',
        kernelInterrupted: request.action === 'interrupt',
        kernelRestarted: request.action === 'restart',
        kernelShutDown: request.action === 'shutdown',
        bindingChanged: request.action === 'start' || request.action === 'switch',
        invalidatedExecutionIds: [],
        outputsCleared: false
      },
      status: this.status(request.notebookId),
      nextRequestId: String(Number(request.requestId) + 1),
      requestAccepted: true,
      replayed: false,
      firstAcceptedAt: '2026-09-06T10:06:00Z'
    });
  }

  async readOutputResource(uri: string): Promise<OutputResourceContents> {
    this.calls.push({ method: 'readOutputResource', request: uri });
    const failure = this.options.failWith;
    if (failure !== undefined && failure.method === 'readOutputResource') throw failure.error;
    if (!uri.startsWith('jupyter-output:')) {
      throw coreError('INVALID_ARGUMENT', `not one of our URIs: ${uri}`);
    }
    const outputId = uri.slice('jupyter-output:'.length);
    if (outputId === 'gone') throw coreError('HANDLE_EXPIRED', 'the output snapshot expired with its session');
    if (this.options.resourceTooLarge === true) {
      return {
        uri,
        outputId,
        mimeType: 'image/png',
        byteSize: 5_000_000,
        truncated: true,
        continueWith: { tool: 'output_read', outputId },
        lifetime: LIFETIME_JOB
      };
    }
    return {
      uri,
      outputId,
      mimeType: 'image/png',
      blob: TINY_PNG,
      byteSize: TINY_PNG.length,
      truncated: false,
      lifetime: LIFETIME_JOB
    };
  }

  async listOutputResources(cursor?: string): Promise<ListOutputResourcesResult> {
    this.calls.push({ method: 'listOutputResources', request: cursor });
    const count = this.options.resourceCount ?? 1;
    const offset = cursor === undefined ? 0 : Number(cursor.slice('res_'.length));
    const end = Math.min(offset + 100, count);
    return {
      resources: Array.from({ length: end - offset }, (_, index) => {
        const number = offset + index + 1;
        return {
          uri: `jupyter-output:out_${String(number)}`,
          outputId: `out_${String(number)}`,
          name: `cell ${String(number - 1)} · image/png`,
          mimeType: 'image/png',
          byteSize: TINY_PNG.length,
          executionId: 'exe_1',
          notebookId: 'nb_1',
          lifetime: LIFETIME_JOB
        };
      }),
      ...(end < count ? { nextCursor: `res_${String(end)}` } : {})
    };
  }

  async shutdown(reason: ShutdownReason): Promise<void> {
    this.shutdownReasons.push(reason);
  }
}

/**
 * Module seam used by `cli.ts` through `JUPYTER_COLLAB_MCP_SERVICE_MODULE`.
 *
 * The child-process test needs two things the in-process fake must not do:
 * a `console.log` from "a dependency", which proves the stdout guard is
 * already installed when the service is built, and an audible shutdown.
 */
export function createService(): CollabService {
  console.log('noise a dependency writes to stdout');
  return new (class extends FakeCollabService {
    override async shutdown(reason: ShutdownReason): Promise<void> {
      await super.shutdown(reason);
      process.stderr.write(`[fake] shutdown ${reason}\n`);
    }
  })();
}
