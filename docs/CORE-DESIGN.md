# Core module map

Implementation module breakdown, type ownership, and end-to-end data flow.
Behavior is defined by [SPEC.md](../SPEC.md); this document only states which component implements what.
Verified protocol facts are in [spike/NOTES.md](../spike/NOTES.md).

## Modules

| Module | Responsibility | Does not do |
| --- | --- | --- |
| `src/core` | Contracts: error codes, revisions, operation/event/job types, `OutputSink` | Does not open sockets or know about Yjs and MCP |
| `src/jupyter` | Transport: REST, document session, RTC connection, stdout guard | Does not interpret notebook contents |
| `src/core/notebook` | Live notebook model over `YNotebook` | Does not send kernel messages |
| `src/kernel` | Kernel protocol: output reducer, routing, job queue | Does not write directly to `Y.Doc` |
| `src/service` | Sessions, handles, kernel bindings, outputs, and `request_id` registry | Does not parse JSON Schema |
| `src/mcp` | Adapter: tool schemas, snake_case, resources, and response limits | Contains no business logic |

### `src/core` (this module)

Owns: `ErrorCode`, `CoreError`, `DEFAULTS` (§9); `SourceRevision`,
`OutputsRevision`, `CellRevision`, `NotebookMetadataRevision`,
`StructureRevision` and their calculation functions (§7); `ConnectionState`,
`ServerProfile`/`ResolvedServer`, `CellSummary`/`NotebookSummary`,
`Operation`/`OperationResult`, `ChangeEvent`, `ChangesCursor`/`PageCursor`,
`JobState`/`CellRunState`/`ExecutionJob`/`CellExecutionRecord`,
`KernelChannelState`/`KernelExecutionStatus`, `NbOutput`, `OutputSink`.
Its sole dependency is `node:crypto`. This lets the core remain independent
of MCP (§1) and allows revisions to be tested without a server.

### `src/jupyter` — transport

- `ServerClient`: REST with an `Authorization: token …` header. `newUntitled`
  (POST to a directory), `PATCH` rename, listing, `content=0`. An existing
  `.ipynb` is never overwritten (§6).
- `CollaborationSession`: `PUT /api/collaboration/session/<encodeURIComponent(path)>`.
  Cached by **server**, not by document: `sessionId` is the Jupyter process's
  `SERVER_SESSION`, while `fileId` belongs to the document. A 201 response does
  not prove the file exists; a missing path produces 4404 only when joining the room.
- `RtcConnection`: a thin wrapper around `WebsocketProvider`. The room name
  `json:notebook:<fileId>` is passed **raw** (`%3A` opens a different, empty
  room), with `disableBc: true`, `WebSocketPolyfill: ws`, and
  `params: {sessionId, token}`. It replaces `messageHandlers[2]` because
  Jupyter RAW == y-websocket `messageAuth` == 2; maintains a
  `Map<saveId, resolver>` for RAW saves; and recognizes RAW
  `{"type":"conflict"}`. It has a custom `shouldReconnect`: 4400/4404 are
  terminal, 1003 is parsed as JSON and does not reconnect with a stale
  `sessionId`, and 4500 gets a limited retry budget. It owns the
  `ConnectionState` state machine and publishes awareness
  `{user:{name,color}, autosave:true}` (§6).
- `stdout guard`: redirects `console.debug/log/info` to stderr before creating
  any `@jupyterlab/services` objects; otherwise `Starting WebSocket: …` goes
  directly into the MCP channel (§11).

### `src/core/notebook` — notebook model

`NotebookModel` is built around `Y.Doc`, not around `YNotebook`, and owns:

- **ID index**: `cell_id → Y.Map` plus the local identity of the CRDT object.
  Replacing a `Y.Map` while retaining the same ID yields `CELL_REPLACED`; a
  duplicate ID yields `CELL_ID_AMBIGUOUS` for operations that address it (§7).
- **Revisions**: recomputed from actual observer changes, not on every read.
  Outputs do not advance `sourceRevision`; this ensures that
  `notebook_execute` on a running cell does not conflict with itself.
- **Reads**: limited `summary`/`cells`/`outputs`; `page_cursor` is tied to
  `structureRevision`, and a structural change between pages yields
  `CURSOR_EXPIRED`. The snapshot and `changes_cursor` are obtained without an
  `await` between them.
- **Mutations**: first validate the entire batch against the current replica,
  then perform one synchronous `notebook.ydoc.transact(fn, ORIGIN)`. Calling
  `ydoc.transact` directly is required: `@jupyter/ydoc` loses a custom origin
  in `cell.transact` and `notebook.transact`; without an origin, the §10 journal
  treats local edits as foreign.
- **Change journal**: `ChangeEvent` with per-cell output coalescing (at most
  once every 100 ms), flushed before a snapshot, before a source/structure
  event, and at a generation boundary. Published `sequence` values are never
  rewritten.
- **Output generations**: implementation of `OutputSink` and
  `beginExecutionGeneration`. One transaction clears outputs, sets
  `execution_count = null`, removes `execution` metadata, sets
  `execution_state = 'running'`, and increments the generation. Every mutator
  on a stale sink returns `false` and changes nothing.

### `src/kernel` — execution

- **Pure output reducer**: IOPub message → `NbOutput`. It has no Yjs and no
  network dependencies, so `reply`/`idle` ordering, `clear_output(wait)`,
  `update_display_data`, and late outputs are covered by unit tests.
  `transient.display_id` lives in the router, not in the nbformat output.
- **`KernelClient`**: one receiver per kernel connection, routing by
  `parent_header.msg_id`; foreign IOPub affects status but is not written to
  our cells.
- **`ExecutionRegistry`**: sequential queue. The next cell is sent after
  `execute_reply` + `idle` and revalidation of the target (existence,
  `sourceRevision`, and object identity). It records `CellExecutionRecord`;
  `not_sent` and `aborted` are strictly distinguished.

### `src/service` and `src/mcp`

`service` holds working sessions, notebook/job handles, and the `request_id`
registry (`H`, up to 4096 receipts, `replayed`, `first_accepted_at`).
`mcp` converts camelCase to the §9 schemas' snake_case, truncates responses to
their limits, and converts `CoreError` into `isError: true` plus
`code/message/retryable/side_effects`.

## `notebook_execute` data flow

1. `mcp` validates arguments, `registry` accepts `request_id` (H+1), and
   creates a receipt before the first effect.
2. `ExecutionRegistry` creates an `ExecutionJob` with one `CellExecutionRecord`
   per target; the kernel identity is fixed. If there is no binding,
   `KERNEL_NOT_BOUND` is returned before any output change.
3. For each queued cell, `NotebookModel` rechecks existence and
   `expected_source_revision`; a mismatch stops the queue and the remaining
   cells receive `not_sent`.
4. `NotebookModel.beginExecutionGeneration(cellId)` clears the output area in
   one transaction and returns a new-generation `OutputSink`.
5. `KernelClient` sends `execute_request` (`allow_stdin:false`,
   `stop_on_error`, metadata `cellId`) and records the `msg_id`.
6. IOPub messages pass through the reducer and go to the `sink`. A stale sink
   returns `false`; outputs remain in the job's `outputsCollected`.
7. After `execute_reply` + `idle`, final `execution_count` and
   `execution_state = 'idle'` are written only if the generation is still ours.
8. An RTC observer sees one `outputsChange`; `notebook_changes` returns
   coalesced `outputs_changed`, while `execution_get` returns job status.
