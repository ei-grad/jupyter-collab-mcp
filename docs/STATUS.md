# Implementation status

As of 2026-09-06. Test environment `dev/jupyter/`: JupyterLab 4.6.3, jupyter-server 2.21.0,
jupyter-collaboration 5.0.2 / jupyter_server_ydoc 3.0.2, jupyter-ydoc 4.1.1;
Node 24.14, yjs 13.6.32, y-websocket 3.1.0, @jupyter/ydoc 4.1.1, services 7.6.3.

| Check | Command | Result |
| --- | --- | --- |
| Types | `pnpm typecheck` | clean, 0 errors |
| Unit | `pnpm test:unit` | 26 files, 300 tests, 5.2 s |
| Integration | `pnpm test:int` | 5 files, 29 tests, 32.4 s (environments 8889/8892/8896) |
| E2E | `pnpm smoke` | 11 steps, exit 0, 5.6 s (environment 8893) |

`scripts/e2e-smoke.ts` composes the three modules against a live server: create → open
(RTC + model) → `add_cell` → execute through `ExecutionRegistry` with the model's sink →
`finishExecution` → `readOutputs` (stream + `image/png`) → a second client sees the same
cell, `outputs_revision`, `execution_count`, and `idle` → RAW save → read the `.ipynb`.

## 1. Implementation by SPEC.md section

| Section | Module | Status |
| --- | --- | --- |
| §5 headless stack, RAW type 2 | `src/jupyter` | done (+ `scripts/check-headless.ts`) |
| §6 handshake, room, close codes, reconnect, save | `src/jupyter` | done; `revision_persistence` = `unknown` |
| §6 notebook creation | `src/jupyter` | partial: `newUntitled` only, without rename |
| §7 cells, revisions, batch, metadata; §8 output generations; §10 journal | `src/core/notebook` | done |
| §8 job queue, reducer, routing | `src/kernel` | done |
| §8 kernel binding through Sessions API | — | missing; smoke calls `SessionAPI` directly |
| §9 MCP tools, deduplication | `src/mcp` | not started (file is empty) |
| §11 stdout guard, token redaction | `src/jupyter`, `src/core` | done |
| §4 server/session/notebook registries | — | not started |

## 2. Coverage by §12 row

| Area | Status | Coverage / missing work |
| --- | --- | --- |
| Stateful lifecycle | done | 100 edits, one `Y.Doc` and socket (`review.transport.int`) |
| Reopen, Different conversations | not started | no handle layer or `SessionRegistry` |
| Bidirectional RTC | done | `roundtrip`, `concurrent`, `transport.int`, smoke step 9 |
| Concurrent edits | done | `concurrent.test.ts`, `review.concurrency.test.ts` |
| Identity, ranges, external write | partial | `aset`-like replacement and queue in unit tests; no real external writer |
| Outputs | partial | `kernel.int` covers all types; independent observer covers stream+PNG |
| Execution completion | done | `execution-registry`, `kernel.int`, `review.late-output.int` |
| Interrupt | partial | interrupt and timeout exist; MCP-request cancellation does not |
| Shared kernel | partial | foreign busy state without writing to our cells; handle layer for two kernel handles is missing |
| Network, restart, session compatibility | partial | 1003/4400/4404/4500 budget and reconnect exist; server restart with replica is missing |
| RAW and eviction | partial | conflict and a single handler use a fixture; no real eviction |
| Shared execution | done | `dev/browser/shared-execution.ts` (16/16) + generations |
| External kernel | partial | invalidation exists; browser restart and `KERNEL_NOT_BOUND` are missing |
| Retries, Retry limit, Replay | not started | §9, MCP layer |
| Headless and save | done | `pnpm smoke`, steps 1–10 |
| Save uncertainty, Autosave | partial | `timeout`/`skipped`/`OPERATION_UNCERTAIN` and `{autosave:true}` exist; update/save race and debounce do not |
| Document data | done | `roundtrip.test.ts` |
| Tool coverage | partial | model operations are complete; MCP tools are missing |
| Create name | not started | rename/`ALREADY_EXISTS`/403 are not implemented |
| Cursors and outputs | partial | changes/page cursors exist; `output_read`/resources do not |
| Limits, Cleanup, and credentials | done | 750 KiB budget, `output_incomplete`, non-blocking `input()`; `review.stdout`, `lifecycle-silence`, dispose tests |
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
8. `FILE_ID_CHANGED` occurs only when `revalidateFileId` is supplied.
9. The caller writes final `execution_count` + `idle`: `ExecutionRegistry` does not
   touch Yjs or call `finishExecution` (smoke does this explicitly).
10. `ChangeEvent` addresses only `cell_id`: with a duplicate ID, two objects produce
    events with the same address.
11. `AREA_CACHE_LIMIT = 1024` and `LATE_ROUTE_LIMIT = 128` are internal
    `src/kernel` constants outside §9's configurable limits.
12. `dev/browser/out/*.png` appears in `git status`: it is absent from `.gitignore`
    even though the browser-step report stated otherwise.

## 4. Public API for the next step

Complete lists are in each module's `index.ts`; the entries below are the foundation
for the registry and MCP layers.

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

Still missing for §9: the handle layer (`ServerRegistry`, `SessionRegistry`,
`NotebookConnection` over the three modules), kernel binding through Sessions API,
calling `finishExecution` from that layer, `output_read`/resources, and the
`request_id` registry.
