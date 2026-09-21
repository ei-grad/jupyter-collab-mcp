# Implementation status

Release snapshot: v0.2.0, 2026-09-21. The verified integration stack is JupyterLab
4.6.3, jupyter-server 2.21.0, jupyter-collaboration 5.0.2,
jupyter-server-ydoc 3.0.2, jupyter-ydoc 4.1.1, Node.js 24,
`@jupyter/ydoc` 4.1.1, and `@jupyterlab/services` 7.6.3.

The TypeScript package is implemented end to end: the RTC transport, notebook
model, kernel execution layer, stateful service, and MCP adapter are connected
through the production CLI. The optional authenticated HTTP host is the same
executable's `--http` mode.

Release verification runs `pnpm typecheck`, `pnpm test:unit`, `pnpm test:int`,
`pnpm build`, `pnpm acceptance`, and `pnpm smoke`; recorded test counts and
timings are intentionally omitted because they become stale as coverage grows.

## 1. Implementation by SPEC.md section

| Section | Module | Status |
| --- | --- | --- |
| §5 headless stack, RAW type 2 | `src/jupyter` | done (+ `scripts/check-headless.ts`) |
| §6 handshake, room, close codes, reconnect, save | `src/jupyter` | done; `revision_persistence` = `unknown` |
| §6 notebook creation and rename | `src/jupyter`, `src/service` | done |
| §7 cells, revisions, batch, metadata; §8 output generations; §10 journal | `src/core/notebook` | done |
| §8 job queue, reducer, routing | `src/kernel` | done |
| §8 kernel binding through Sessions API | `src/service` | done |
| §9 MCP tools, resources, limits, and deduplication | `src/mcp`, `src/service` | done |
| §9 optional Hub singleuser lifecycle | `src/jupyter`, `src/service`, `src/mcp` | explicit status/start, Hub 5/6 token auth and optional adapter |
| §11 stdout guard, token redaction | `src/jupyter`, `src/core` | done |
| §4 server/session/notebook/kernel registries | `src/service` | done |

## 2. Coverage by §12 row

| Area | Status | Coverage / missing work |
| --- | --- | --- |
| Stateful lifecycle | done | 100 edits, one `Y.Doc` and socket (`review.transport.int`) |
| Reopen, different conversations | done | handle reuse in one session and independent replicas across sessions |
| Bidirectional RTC | done | `roundtrip`, `concurrent`, `transport.int`, smoke step 9 |
| Concurrent edits | done | `concurrent.test.ts`, `review.concurrency.test.ts` |
| Identity, ranges, external write | done | identity and range tests plus real independent RTC replacement fixture |
| Outputs | done | kernel integration covers output types; independent observer covers stream+PNG |
| Execution completion | done | `execution-registry`, `kernel.int`, `review.late-output.int` |
| Interrupt | done | explicit interrupt, graceful shutdown evidence, timeout, and cancellation semantics |
| Shared kernel | done | shared hub/queue, foreign busy state, and multiple handle leases |
| Network, restart, session compatibility | partial | 1003/4400/4404/4500 budget and reconnect exist; server restart with replica is missing |
| RAW and eviction | partial | conflict and a single handler use a fixture; no real eviction |
| Shared execution | done | `dev/browser/shared-execution.ts` (16/16) + generations |
| External kernel | partial | shutdown/death and binding changes are covered; an external in-place restart has no reliable server signal |
| Retries, Retry limit, Replay | done | ledger, service, MCP, and acceptance tests |
| Headless and save | done | `pnpm smoke`, steps 1–10 |
| Save uncertainty, Autosave | partial | `timeout`/`skipped`/`OPERATION_UNCERTAIN` and `{autosave:true}` exist; update/save race and debounce do not |
| Document data | done | `roundtrip.test.ts` |
| Tool coverage | done | all 18 tools have schemas, dispatch, and adapter tests |
| Create name | done | rename, `ALREADY_EXISTS`, and retained untitled result are covered |
| Cursors and outputs | done | change/page/execution/output cursors, `output_read`, and resources |
| Limits, cleanup, and credentials | done | service budgets, bounded receipts/snapshots, stdout isolation, redaction, and disposal tests |
| Benchmark with 100/1,000/10,000 cells | not started | — |

## 3. Known deviations

1. The room WS token is sent in the `Authorization` header (verified: 101 vs 403);
   §6 item 4 retains the query form as `tokenTransport:'query'`, but the profile
   has no field for selecting it.
2. `sessionId` is the Jupyter process's `SERVER_SESSION`, shared by all documents:
   it is cached per server, not per notebook.
3. Readiness is `synced` && `nbformat !== undefined`: a new file already has one
   server-created empty cell, so the presence of cells proves nothing.
4. Origin is set only through `ydoc.transact(fn, origin)`: `@jupyter/ydoc` loses it
   in `cell.transact`/`notebook.transact` (§10).
5. The `conflict` state (§6) is transient: a `conflict` event is followed by
   `failed`. Metadata is written by key directly into `Y.Map` (otherwise untouched
   §7 keys become concurrent writes); there is no `dirty` flag or
   `collapsed` ↔ `outputs_hidden` mirroring.
6. `execution_state` is not exclusively ours: JupyterLab writes `idle` in response
   to a remote `execution_count`, so the count is published only in the final transaction.
7. An in-flight save resolves to `'timeout'` immediately when the socket is lost; a
   terminal failure is `OPERATION_UNCERTAIN`. `provider.shouldConnect === false`
   is also true during normal backoff (which has its own jitter); `state`/`terminalError`
   indicate a terminal failure.
8. `FILE_ID_CHANGED` occurs only when `revalidateFileId` is supplied by the service.
9. `ExecutionRegistry` does not touch Yjs directly; the service watcher applies
   `finishExecution` to the current notebook generation.
10. `ChangeEvent` addresses only `cell_id`: with a duplicate ID, two objects produce
    events with the same address.
11. `AREA_CACHE_LIMIT = 1024` and `LATE_ROUTE_LIMIT = 128` are internal
    `src/kernel` constants outside §9's configurable limits.
12. A `notebook_apply` receipt is reserved at acceptance from the operation
    count (512 B plus 384 B per operation, serialisation ceilings), so a batch
    whose receipt would not fit `receiptMaxBytes` is refused with
    `RESOURCE_LIMIT` before the first mutation and with its number unused.
    `receiptMaxBytes` defaults to 64 KiB - one response-sized answer - and the
    ledger is still bounded only by `maxReceiptsPerSession` x `receiptMaxBytes`;
    there is no per-session receipt byte budget with eviction.
13. Output snapshots are addressable only from the working context that made
    them. A library embedder must name its session on `outputRead`,
    `readOutputResource`, and `listOutputResources`; omitting it addresses the
    implicit per-connection context, which is what the MCP adapter wants.
## 4. Public API

Complete lists are in each module's `index.ts`. The package root exports the
supported programmatic surface, including `createCollabService(config,
options?)`, `CollabService`, and `CollabServiceOptions`.

**`src/core`** (no dependencies): `CoreError`/`coreError`/`toCoreError`/`isCoreError`/
`ERROR_CODES`/`DEFAULTS`/`redactCredentials`; `sourceRevision`, `cellRevision`,
`outputsRevision`, `notebookMetadataRevision`, `structureRevision`, `isRevisionOfKind`;
`make*`/`parse*` for cursors; types `ResolvedServer`, `Operation`, `ApplyResult`,
`ChangeEvent`, `ExecutionJob`, `OutputSink`, `BeginExecutionGeneration`, `ConnectionState`.

**`src/jupyter`**: `installStdoutGuard()` (before `@jupyterlab/services` objects);
`ServerClient(server)` → `status`, `listDirectory`, `contentsExists`, `newUntitledNotebook`,
`collaborationSession`, `serverSettings`; `RtcConnection(options)` → `connect`,
`waitForReady`, `save`, `dispose`, `on`, `state`/`synced`/`lastError`/`terminalError`/
`roomName`/`fileId`/`url`/`socketGeneration`/`provider`; options `tokenTransport`,
`revalidateFileId`, `initRetryBudget`, `maxBackoffTime`, `saveTimeoutMs`.

**`src/core/notebook`**: `NotebookModel(ynotebook,{origin,…})` → `isReady`, `cellRef`,
`resolveRef`, `duplicateCellIds`, `structureRevision`, `summary`, `snapshotWithCursor`,
`readCells`, `readOutputs`, `apply`, `changesCursor`, `changesSince`, `flush`,
`recordConnectionState`, `recordKernelChange`, `beginExecutionGeneration`, `sinkFor`,
`finishExecution`, `dispose`; plus `withIdentity`, `CellIndex`, `ChangeJournal`,
`GenerationRegistry`.

**`src/kernel`**: `KernelClient({serverSettings, kernelId, kernelName?})` → `kernelStatus`,
`requestExecute(code,{cellId, route?, stopOnError?})`, `registerExecution`,
`onKernelChanged`, `onStatusChanged`, `interrupt`, `restart`, `shutdown`, `displays`,
`dispose`; `ExecutionRegistry(kernel)` → `submit({notebookRef, cells, getSink, revalidate,
stopOnError?, maxOutputBytes?})`, `get`, `cancel`, `waitForChange`, `dispose`.

**`src/service`**: `createCollabService` composes server/session/notebook
registries, kernel binding, execution completion, output snapshots/resources,
and the sequential `request_id` ledger.

**`src/mcp`**: `createMcpServer` exposes all 16 tools and output resources;
`runCli` owns the stdout-safe stdio lifecycle. CLI help and version text go to
stderr because stdout is reserved for MCP frames.
