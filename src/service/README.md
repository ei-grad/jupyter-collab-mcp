# `src/service` — registry layer

Implements `CollabService` (`src/core/service.ts`) over the three lower-level
modules. This is the only place where they are connected and the only place
that owns the state from SPEC.md §4: servers, working sessions, notebook
handles, jobs, output snapshots, and the `request_id` registry. Nothing here
knows about MCP.

```
src/mcp (later)        →  CollabService                    ← this module
                          ├── ServerRegistry               profiles, credentials, discovery
                          ├── SessionRegistry              working sessions, limits
                          │   └── WorkingSession            ledger + lock + outputs + handles
                          ├── NotebookHandle               YNotebook + RtcConnection + NotebookModel
                          ├── KernelHub                     KernelClient + ExecutionRegistry per kernel
                          └── OutputStore                   immutable snapshots, output_read/resources
```

There is one entry point: `createCollabService(config, options?)`. Everything
else is exported for tests and for a future HTTP adapter.

## Files

| File | Purpose |
| --- | --- |
| `service.ts` | `CollabServiceImpl`: one method per §9 tool, session envelope, and validation order. |
| `server-registry.ts` | Profiles in preference order, lazy `ServerClient`, and `SERVER_SESSION` cache. |
| `credentials.ts` | `env:` / `file:` / `literal:` → in-process token. |
| `discovery.ts` | Reads `jpserver-*.json` from runtime directories and returns a URL and safe ID. |
| `session.ts` | `WorkingSession` (ledger, lock, replicas, jobs, and bindings) and `SessionRegistry`. |
| `ledger.ts` | `H` plus up to 4096 receipts, the six §9 outcomes, eviction, and payload digest. |
| `mutex.ts` | Per-session lock: the four mutating tools are strictly sequential. |
| `notebook-handle.ts` | One replica: RTC room + `YNotebook` + `NotebookModel`, readiness, and `stale`. |
| `kernel-hub.ts` | One `KernelClient` + `ExecutionRegistry` per `server_id + kernel_id`, with refcounting. |
| `execution.ts` | Generation completion (`finishExecution`), `execution_get` cursor, and `ExecutionView`. |
| `outputs.ts` | Snapshot interning, `jupyter-output://<session>/<output_id>` URIs, and chunking. |

## Validation order for a mutating call (§9)

Everything runs under the session lock, in this order:

1. validate arguments, handle, limits, kernel binding, and cell targets
   **before** creating a receipt; the number is not consumed
   (`request_accepted: false`);
2. `RequestLedger.begin`: if the number is in the registry and the payload
   matches, replay; a different payload gives `REQUEST_ID_CONFLICT`; if the
   number is absent and `<= H`, return `REQUEST_ID_EXPIRED`; if it is
   `> H + 1`, return `REQUEST_OUT_OF_ORDER`;
3. for number `H + 1`, validate request size and reserve receipt space, then
   create the receipt and increment `H` **before the first effect**;
4. perform the effect. Any error after step 3 returns
   `request_accepted: true`.

`SessionEnvelope` is mixed into both successful responses and the `details` of
a thrown `CoreError` (`next_request_id`, `request_accepted`,
`first_accepted_at`), so a read-only call always restores the counter (§10
item 3).

For `notebook_apply`, the operation batch is planned twice: once before the
receipt (`planOperations` is pure and changes nothing), so `CELL_NOT_FOUND`,
`REVISION_CONFLICT`, and `MATCH_NOT_*` do not consume a number, and once inside
`NotebookModel.apply`.

For `notebook_execute`, the receipt stores **a reference to the job**, not its
result; outputs are not copied into the replay registry (§9). If a stored result
from another tool exceeds `receiptMaxBytes`, the receipt is removed entirely:
`H` continues to prohibit reuse, so replay returns `REQUEST_ID_EXPIRED` rather
than executing again.

## Handles

`sess_*`, `nb_*`, `exec_*`, and `out_*` are opaque strings scoped to the
process run. Opening the same `fileId` through `notebook_open` in one session
returns the existing handle; concurrent opens are coalesced through
`WorkingSession.opening`. Two sessions for one notebook intentionally use two
`Y.Doc` instances and two sockets, both counted against the replica budget.
`notebook_close`/`session_close` are idempotent for their own handle (bounded
tombstone), reject with `EXECUTION_ACTIVE` by default, and **never** shut down
the kernel. `force` abandons the job, which becomes `unknown`.

## Kernel

The binding is looked up through the Sessions API by notebook path on every
call: zero sessions → `KERNEL_NOT_BOUND`, more than one →
`KERNEL_SELECTION_REQUIRED`, one →
`KernelHub.acquire(server_id, kernel_id)`. There is one `KernelClient` and one
`ExecutionRegistry` per kernel, so all process handles share a queue (§4).

`kernel_control` requires `expected_kernel_id` and checks it **before** the
receipt. A mismatch gives `KERNEL_CHANGED` without consuming a number.
`interrupt`/`restart` use the kernel connection when one is available (the same
request sent by the browser, whose effect our client observes); `shutdown`
deletes the Jupyter session; `switch` applies a session `PATCH`. After
restart/shutdown/switch, the `KernelHub` entry is invalidated: unfinished jobs
become `unknown`, unsent work becomes `not_sent`, and nothing is resent.

**Measured limitation.** An external (not initiated by this service)
`POST /api/kernels/<id>/restart` against jupyter-server 2.21.0 produces no
signal for other kernel clients: `kernel_id` is unchanged, the WebSocket stays
open, `statusChanged` does not emit `restarting`, and
`GET /api/kernels/<id>` reports `idle` in under 200 ms (measured with a one-off
script against the environment on port 8879). Therefore the watchdog timer
(`KERNEL_WATCH_MS`, 2 seconds) reacts only to the provable case in which the
kernel disappears from `GET /api/kernels`. The service's own
`kernel_control restart` always invalidates the job.

## Outputs and resources

Output that does not fit the response budget is not embedded. It is interned
once in the working session's `OutputStore` (keyed by address plus content
digest, so rereading does not create a new snapshot) and returned as an
`output_id`, MIME list, full size, and URI. `output_read` splits text payloads
on UTF-8 boundaries and base64 payloads on three-byte boundaries, so joining
the parts reproduces the original bytes; parts already returned are not sent
again. `resources/read` has a separate budget: if a snapshot does not fit, the
response is marked `truncated` and points to `output_read`. An expired or
evicted snapshot gives `HANDLE_EXPIRED`.

The URI is `jupyter-output://<session_id>/<output_id>`; the short form
`jupyter-output:<output_id>` is also accepted. Neither form contains
credentials.

## Budgets

`ServiceLimits` (§9) defines 100 cells in a summary, 64 KiB per response, a
30-second wait, 10,000 journal events, 32 replicas, 64 sessions, and 4096
receipts. The module additionally defines `DEFAULT_OUTPUT_STORE_BYTES` (32 MiB
per working session), a separate output-buffer budget required but not
quantified by §9. `ResponseLimits` arguments may request only lower limits.

## Configuration and credentials

`ServiceConfig.servers` contains profiles in preference order. Discovery is
fallback-only: when the profile list is nonempty, local servers are not read at
all (§11: "Explicit configuration must not be replaced by a random local
server"), and `server_list.discovery_enabled` exposes this state. A token from
`jpserver-*.json` appears in neither descriptors nor responses; it remains an
in-process `literal:` reference. `createCollabService` installs
`installStdoutGuard()` before creating the first `@jupyterlab/services` object
(disabled with `guardStdout: false`).

## Tests

- `test/service/ledger.test.ts`: the six §9 outcomes, eviction, more than 4096
  operations, and two concurrent identical numbers.
- `test/service/outputs.test.ts`: interning, MIME, URI, and expiration.
- `test/service/execution-view.test.ts`: `execution_get` cursor, limits, and a
  snapshot instead of inline base64.
- `test/service/servers.test.ts`: credentials, discovery, and server selection.
- `test/service/handles.test.ts` and `test/service/mutations.test.ts`: the
  complete service over fake REST (`fetchImpl`) and a fake replica
  (`openHandle`); the model, registries, and ledger are real.
- `test/service/service.int.test.ts`: live environment on port **8879**:
  create (untitled and named, with `ALREADY_EXISTS` leaving the untitled file),
  open/read/apply/execute/execution_get/output_read/changes/save,
  `kernel_control`, two sessions for one notebook, and job invalidation after a
  restart or kernel disappearance.

`openHandle` in `CollabServiceOptions` is the only testing seam; all other unit
tests exercise the real code.
