# Service facade and MCP SDK selection

This document describes two things: the `CollabService` contract
(`src/core/service.ts`) implemented by the registry layer and consumed by the
MCP adapter, and the MCP SDK choice for a stdio server using protocol revision
`2026-07-28`.

Behavior is defined by [SPEC.md](../SPEC.md) §4, §6, §8, §9, §10, and §11;
server profiles are defined by [CONNECTIONS.md](CONNECTIONS.md) §9. This
document only describes who expresses each part and how it is represented in types.

## 1. File layout

| File | Contents |
| --- | --- |
| `src/core/service.ts` | `CollabService` — one method per §9 tool plus `readOutputResource`, `listOutputResources`, and `shutdown`; all request/response types use camelCase |
| `src/core/config.ts` | `ServiceLimits` + `DEFAULT_SERVICE_LIMITS` (§9 defaults), `ServiceConfig`/`ServiceConfigInput`, `AwarenessUser`, `withDefaults()` |
| `src/core/index.ts` | Re-exports: import from `src/core/index.js`, not individual files |

The facade depends only on `./types.js`, `./revision.js`, `./errors.js`,
and `./config.js`. It has no Yjs, `@jupyterlab/services`, or MCP SDK:
`src/core` remains interface-independent (SPEC §1), while the adapter is the
only place where camelCase is converted to the §9 wire format's snake_case.

## 2. Responsibility boundaries

```
MCP adapter (src/mcp)          CollabService (src/core/registry)
─────────────────────          ────────────────────────────────
input/output JSON Schema       working sessions, handles, request_id registry
snake_case ↔ camelCase         replicas (Y.Doc + WS), journal, cursors
response limits, image/resource jobs, output snapshots, kernel binding
CoreError → isError + code     throws CoreError with a §9 code
```

The adapter contains no business logic: it does not decide whether a request
number is consumed, select a server, or semantically truncate outputs (the
facade already returns `truncated`, `byteSize`, `mimeTypes`, and
`outputId`). It only distributes the prepared result among content blocks
and `structuredContent`.

## 3. Session envelope and request numbers

`SessionEnvelope` is mixed into the result of **every** session-scoped call
(`WithEnvelope<T> = T & SessionEnvelope`) and into the `details` of a
`CoreError` thrown by such a call:

| Field | Meaning |
| --- | --- |
| `nextRequestId` | `H + 1` at response time; `null` means the session is closed or the range is exhausted |
| `requestAccepted` | `true`: the number was consumed (the receipt was created before the first effect); `false`: rejected before acceptance; `null`: the receipt expired; absent for calls that are not deduplicated |
| `replayed` | response came from a receipt rather than being executed again; this does not imply operation success |
| `firstAcceptedAt` | RFC 3339 UTC timestamp of the first acceptance; replay does not change it |

Exactly four methods are deduplicated: `notebookCreate`, `notebookApply`,
`notebookExecute`, and `kernelControl`; only they accept `requestId`.
Checks under the session lock are ordered as follows (§9):

1. the number is in the registry and the payload matches → replay
   (`replayed: true`, original `firstAcceptedAt`); a different payload →
   `REQUEST_ID_CONFLICT`;
2. the number is absent and is `<= H` → `REQUEST_ID_EXPIRED`; nothing executes;
3. the number is `> H + 1` → `REQUEST_OUT_OF_ORDER`;
4. the number is `H + 1` → check preconditions and reserve memory, then create
   the receipt and advance `H` **before the first effect**.

This yields the JSDoc rule for every mutating method: anything checked before
step 4 (arguments, handle, limits, server selection, kernel binding) does not
consume the number; anything afterward does, even on an error or uncertain outcome.

Read calls (`notebookRead`, `kernelList`, `notebookChanges`, …) do not
touch the number and provide a way to recover the counter after context loss
(§10 item 3).

## 4. Handles and lifetimes

`SessionId`, `NotebookId`, `ExecutionId`, and `OutputId` are opaque
strings bound to the process lifetime. `HandleLifetime` in creation-tool
responses reports `scope` (`until_close_or_process_exit` for sessions and
notebooks, `until_session_close` for jobs and output snapshots),
`releasedBy`, and `processScoped: true`. After restart, the result is
`HANDLE_EXPIRED`; code is not re-executed.

`sessionClose`/`notebookClose` are idempotent for their own handle
(`alreadyClosed: true`), reject with `EXECUTION_ACTIVE` by default, and
have an explicit `force`; `kernelsLeftRunning`/`kernelLeftRunning`
record that closing never shuts down a kernel (§4).

## 5. Errors

Methods do not return errors; they throw `CoreError` (`src/core/errors.ts`):
a §9 code, `retryable`, `side_effects`, and `details`. The following
remain results rather than errors: Python errors (`state: 'failed'` with a
reason), `aborted`, `interrupted`, `unknown`, `not_sent` with a reason,
and `save_status: skipped|timeout`. `save_status: failed` is the only save
outcome promoted to a `SAVE_FAILED` error, so the field type in
`NotebookSaveResult` is narrowed to `Exclude<SaveStatus, 'failed'>`.

`notebookCreate` JSDoc separately specifies: 409 → `ALREADY_EXISTS`, 403 →
`PERMISSION_DENIED`; in either case an already allocated untitled file remains
on the server, its actual path is returned in `details`, and `side_effects`
is `applied`. A timeout/disconnect after sending rename yields
`OPERATION_UNCERTAIN`. There is no `NAMED_CREATE_UNSUPPORTED` code.

## 6. Configuration and limits

`ServiceConfig` consists of server profiles (CONNECTIONS §9: `id`, `kind`,
`apiBaseUrl`, `wsBaseUrl?`, `browserBaseUrl?`, `credentialRef`,
`tlsCaRef?`/`proxyAuthRef?`; the `ServerProfile` type already lives in
`src/core/types.ts`), the `discovery` flag, `limits`, and
`awarenessUser {name, color}`. Tokens do not come from tool arguments and
are not included in responses (§11); `credentialRef` references a secret.
`autosave: true` in awareness is a §6 requirement, not a setting, so
`AwarenessUser` has no field for it.

`DEFAULT_SERVICE_LIMITS` contains the §9 defaults: 100 cells in a summary,
64 KiB of text in a response, a 30-second per-call wait, 10,000 journal events,
32 replicas, 64 sessions, 4,096 receipts per session, plus separate budgets
for a request, a receipt, job output collection (750 KiB, the value used by
the current execution path), and a `resources/read` response. All are
checked **before** an effect: exhaustion yields `RESOURCE_LIMIT` without
consuming a number; active handles and jobs are not evicted.

`ResponseLimits` arguments can request only lower limits. A value above the
configured budget is clamped rather than rejected.

## 7. MCP SDK decision

**Decision: `@modelcontextprotocol/server` 2.0.0 (plus transitive
`@modelcontextprotocol/core` 2.0.0), with `@modelcontextprotocol/client`
2.0.0 as a runtime dependency for hosted worker connections.** The legacy
`@modelcontextprotocol/sdk` 1.30.0 is unsuitable for one blocking reason and is
not a dependency of this package.

### 7.1 Why not 1.30.0

```
node_modules/@modelcontextprotocol/sdk/dist/esm/types.js:
  LATEST_PROTOCOL_VERSION = '2025-11-25'
  SUPPORTED_PROTOCOL_VERSIONS = ['2025-11-25','2025-06-18','2025-03-26','2024-11-05','2024-10-07']
```

`2026-07-28` is not in this list, and this is not a forward-looking list:
revision 2026-07-28 opens the connection with `server/discover`, not
`initialize`, and 1.30.0 has no `server/discover` at all. A direct run
confirmed this (`.scratch/facade/probe-legacy.mts`, server on 1.30.0, client
2.0.0 with `mode: {pin: '2026-07-28'}`):

```
SdkError: Version negotiation failed: the server did not offer pinned protocol
version 2026-07-28 via server/discover (no fallback in pin mode)
```

Version 1.30.0 supports every other requirement (tools with input/output
schemas, `isError`, `structuredContent`, `resource_link`, resources
without subscriptions, image content, and zod 3 or 4). Only the protocol
revision is blocking.

### 7.2 What 2.0.0 provides

`@modelcontextprotocol/core@2.0.0` contains both codecs:
`FIRST_MODERN_PROTOCOL_VERSION = '2026-07-28'`, `MODERN_WIRE_REVISION`,
`isModernProtocolVersion()`, and `codecForVersion()`.
`SUPPORTED_PROTOCOL_VERSIONS` remains a list for the legacy era and
deliberately excludes the modern revision so it does not leak into the
2025-era handshake. The **entry point**, not the server, selects the era:
`serveStdio(factory)` determines it from the first message, pins one
`McpServer` instance to the connection, and then simply forwards messages.

A check (`.scratch/facade/server.mts` + `probe.mts`, client with
`versionNegotiation.mode = {pin:'2026-07-28'}`) produced the following.
Pin mode has no fallback, so a successful response proves the revision:

```
tools: [{"n":"notebook_read","out":true,"inp":true}]
call:  {"content":[{"type":"text",...},{"type":"image","data":"…","mimeType":"image/png"},
        {"name":"out","uri":"jupyter-output:o1","mimeType":"image/png","type":"resource_link"}],
        "structuredContent":{"next_request_id":"1"},"isError":false}
resources: {"resources":[{"name":"out","uri":"jupyter-output:o1","mimeType":"image/png"}]}
read:      {"contents":[{"uri":"jupyter-output:o1","mimeType":"image/png","blob":"…"}]}
```

A second run (`server2.mts` + `probe2.mts`) confirmed two additional facts
we need: a result with `isError: true` passes **without**
`structuredContent` even when the tool declares an `outputSchema`, and
`resources/list` may be empty when the capability is declared.

### 7.3 API entry points

```ts
import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod';

serveStdio(() => {
  const server = new McpServer(
    { name: 'jupyter-collab-mcp', version: '…' },
    { capabilities: { tools: {}, resources: {} } }   // no subscribe: there are no subscriptions (§9)
  );

  server.registerTool(
    'notebook_apply',
    {
      title: '…',
      description: '…',
      inputSchema: z.object({ notebook_id: z.string(), request_id: z.string(), /* … */ }),
      outputSchema: z.object({ next_request_id: z.string().nullable(), /* … */ })
    },
    async (args, ctx) => ({ content: [...], structuredContent: {...}, isError: false })
  );

  server.registerResource(
    'output',
    'jupyter-output:…',                       // or ResourceTemplate for dynamic URIs
    { mimeType: 'image/png' },
    async (uri) => ({ contents: [{ uri: uri.href, mimeType: 'image/png', blob: '…' }] })
  );

  return server;
});
```

- `serveStdio(factory, {legacy: 'serve' | 'reject'})` is the stdio entry
  point; `legacy` defaults to `'serve'` (a 2025-era client is served by the
  same factory-created server). It returns a handle with `close()`.
- `StdioServerTransport` from the same subpath remains available for manual
  wiring, but `server.connect(new StdioServerTransport())` pins the
  **legacy** era; it cannot produce the modern revision. This was verified
  with `.scratch/facade/probe3.mts`: the same client with
  `pin: '2026-07-28'` gets the same negotiation error as with the 1.30.0
  server. `serveStdio` is required for 2026-07-28.
- `McpServer.server` is the low-level `Server` for notifications.
- Test client: `new Client(info, {versionNegotiation: {mode: {pin: '2026-07-28'}}})`
  plus `StdioClientTransport` from `@modelcontextprotocol/client/stdio`.
  The default `mode` is **`'legacy'`**: a test without explicit
  `pin`/`'auto'` exercises the wrong era.

### 7.4 zod and versions

| Package | Requirement | Our version |
| --- | --- | --- |
| `@modelcontextprotocol/server` 2.0.0 | `zod ^4.2.0`, Node `>=20` | zod 4.5.4, Node 24 |
| `@modelcontextprotocol/core` 2.0.0 | `zod ^4.2.0` | one instance in `node_modules/.pnpm` (`zod@4.5.4`) |
| `@modelcontextprotocol/sdk` 1.30.0 | `zod ^3.25 || ^4.0` | — |

The new SDK no longer supports zod 3; we already use zod 4, and pnpm did not
create a duplicate package. Schemas are written as `z.object({...})`: the
raw-shape form (`{field: z.string()}`) in `registerTool` is marked
`@deprecated`.

### 7.5 Pitfalls

1. **The entry point selects the era.** `serveStdio` works; manual
   `connect(transport)` does not. This is easy to get wrong: the code compiles
   and runs, but uses the 2025 revision.
2. **stdout belongs to MCP (§11).** `installStdoutGuard()` from `src/jupyter`
   must be called before creating any `@jupyterlab/services` objects and
   before starting the transport; all diagnostics go to stderr.
3. **Responses carry `_meta.io.modelcontextprotocol/serverInfo`**, and
   resource responses also carry `ttlMs`/`cacheScope` (default `private`,
   `0`). Our snapshots are immutable but live only until the working session
   closes, so `cacheHint` in `registerResource` must use the same lifetime.
4. **`resource_link` is a regular content block** and requires no capability;
   we need `resources: {}` because the same server serves the data (§9).
   We neither declare nor implement subscriptions.
5. **`outputSchema` + `isError: true`** is a valid response without
   `structuredContent` (verified). For §9 error responses, put
   `code`/`message`/`retryable`/`side_effects` in text and `_meta`,
   not in `structuredContent`, to avoid conflicting with the output schema.
6. **`@modelcontextprotocol/sdk` 1.30.0 is not installed.** `src/mcp` uses the
   2.0 server API, so retaining the legacy SDK would add unused runtime code
   and a second protocol implementation.
7. `@modelcontextprotocol/client` is a runtime dependency of authenticated HTTP
   mode: each owner-bound worker connects to the canonical stdio server with it.

## 8. `notebook_execute` data flow through the facade

1. **Adapter**: validates arguments (`notebook_id`, `request_id`,
   `cells[]`, `wait_ms?`, `stop_on_error?`) and calls
   `CollabService.notebookExecute(request)` in camelCase. It makes no other
   decisions.
2. **Registry, under the session lock**: applies the §9 `requestId` rules.
   Argument errors, `HANDLE_EXPIRED`, `RESOURCE_LIMIT`, missing kernel
   binding (`KERNEL_NOT_BOUND`), a non-code cell (`INVALID_ARGUMENT`), and
   an acceptance-time revision mismatch (`REVISION_CONFLICT`) all occur
   before receipt creation; the number is not consumed and outputs are untouched.
3. **Acceptance**: creates the receipt, increments `H`, and sets
   `requestAccepted: true`. Any later error returns an envelope with a
   consumed number.
4. **Job**: `ExecutionRegistry.submit({notebookRef, cells, getSink,
   revalidate, stopOnError, maxOutputBytes})`. `getSink` is
   `NotebookModel.beginExecutionGeneration(cellId)`: one transaction clears
   outputs, sets `execution_count = null`, removes `execution` metadata,
   sets `execution_state = 'running'`, and increments the generation.
5. **Send**: `KernelClient.requestExecute(source, {cellId, route,
   stopOnError})` with `allow_stdin: false`. The next cell is sent only
   after `execute_reply` + `idle` and target revalidation; a mismatch at
   this point is not a call error but `not_sent` with a reason.
6. **Collection**: IOPub → reducer → `OutputSink`. A stale sink returns
   `false`, and outputs remain on the job record (`outputsCollected`).
7. **Completion**: the registry layer (not `ExecutionRegistry`) calls
   `NotebookModel.finishExecution(sink, {count})`, writing final
   `execution_count` and `execution_state = 'idle'` in one transaction and
   only while the generation is ours. Publishing the count early clears `[*]`
   in JupyterLab 4.6.3.
8. **Response**: `ExecutionView` includes `state`; per-cell
   `CellRunState` with `notSentReason`/`abortedReason`, `sourceChanged`,
   `cellDeleted`, and `outputIncomplete`; limited `OutputEntry` values
   (with `mimeTypes`, `byteSize`, `truncated`, and `OutputSnapshotRef`
   for large values); a `cursor` for the next `executionGet`;
   `waitTimedOut`; and the session envelope.
9. **Adapter again**: a text summary plus `image` content for small PNG/JPEG
   values and a `resource_link` to `jupyter-output:<output_id>` for large
   values, with the complete body in snake_case `structuredContent`. An
   expired `wait_ms` is a normal response: execution continues,
   `execution_get` reads the remainder, and the kernel is not interrupted.

## 9. Open questions

- `ExecutionCursor`, `OutputCursor`, and `DirectoryCursor` are declared
  as opaque strings without a format. The registry implementation will choose
  their format (`ChangesCursor` and `PageCursor` are already fixed in
  `src/core/types.ts`).
- `executionOutputMaxBytes` (750 KiB) and `resourceReadMaxBytes` (1 MiB)
  are values absent from §9; they need confirmation through measurement.
- Kernel binding through Sessions API does not yet belong to any module:
  `kernelStatus`/`kernelControl`/`notebookExecute` are described in the
  facade, while the registry layer must implement this step.
