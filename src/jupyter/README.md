# `src/jupyter` — transport layer

Implements the Jupyter connection portions of SPEC.md §5, §6, and §11: an HTTP
client for one server, one RTC room, and stdout protection. State above the
"one server / one room" level (session registries, the notebook replica, and
the change journal) does not belong here.

## Modules

| File | Purpose |
| --- | --- |
| `stdout-guard.ts` | `installStdoutGuard()` redirects all console methods that write to stdout (`log`, `info`, `debug`, as well as `dir` and `dirxml`, which bypass `console.log`) to stderr with a prefix and redacts tokens. It is idempotent and returns `restore()`. `console.error/warn/trace` are untouched. |
| `paths.ts` | Normalizes paths relative to the Jupyter root (forbidding `..`), implements two distinct encodings (Contents per segment and the entire collaboration session via `encodeURIComponent`), constructs the room name `json:notebook:<fileId>` **without** encoding, and handles a `base_url` prefix such as `/user/name/`. |
| `http.ts` | Authenticated `fetch`: sets the `Authorization` header, reads the body once, prevents credentials from crossing redirects to another origin, and maps statuses to SPEC.md §9 error codes. The body fragment in `details` always passes through `redactCredentials()`, both in `mapHttpStatus()` and `parseJsonBody()` (a 2xx response with a non-JSON body may be a proxy login page containing `?token=` links). |
| `server-client.ts` | `ServerClient`: `status()`, `listDirectory()`, `contentsExists()` (`content=0`), `newUntitledNotebook()`, `collaborationSession()`, and `serverSettings()` for `@jupyterlab/services` (passing the same injected `fetch` used for REST). The token exists only in a private field; `toString()`/`toJSON()`/`util.inspect` do not expose it. |
| `close-codes.ts` | SPEC.md §6 signal table: 1003 (JSON `unknown_session`/`version_mismatch`/`initialization_error`/unparseable payload), 4400, 4404, 4500; all other codes are recoverable. |
| `raw-protocol.ts` | Encodes and parses Jupyter RAW (type 2): save request, save reply, and conflict. |
| `save-requests.ts` | Registry of pending RAW saves: matches by ID, times out requests, and rejects all requests on disconnection. |
| `rtc-connection.ts` | `RtcConnection`, one room over `y-websocket`, with its own jittered reconnect logic and `reconnectDelayMs()`. |
| `ws-auth.ts` | `authenticatedWebSocket(token, base)`, a WebSocket constructor that sends `Authorization: token …` in the handshake; the token exists only in the closure. |
| `emitter.ts` | Small typed emitter (`state`, `conflict`, `synced`). |

## `RtcConnection`

```ts
const connection = new RtcConnection({
  wsBaseUrl, token, fileId, sessionId,
  ydoc,                                  // a regular Y.Doc, not YNotebook
  awareness,                             // optional: for example, notebook.awareness
  awarenessUser: { name, color }
});
await connection.connect(20_000);        // connecting → syncing → ready
const status = await connection.save();  // 'success' | 'skipped' | 'failed' | 'timeout'
connection.dispose();
```

Properties: `state`, `lastError`, `terminalError`, `synced`, `roomName`,
`fileId`, `url` (with the token already redacted), `rawHandlerInstalls`,
`socketGeneration`, and `provider` (for diagnostics and tests only; with the
default token transport it contains no credentials).

States: `connecting → syncing → ready`; `reconnecting` after a disconnect;
`conflict` (transient and used only for a RAW conflict) → `failed`; `closed`
after `dispose()`.

Key decisions:

- `provider.messageHandlers[2]` is replaced once on the provider, not once per
  socket: Jupyter RAW = 2 conflicts with y-websocket's `messageAuth`. Exactly
  one handler remains after any number of reconnects (verified by tests).
- Terminal closes disable `provider.shouldConnect` so y-websocket does not
  reconnect with an expired `sessionId` (its `defaultShouldReconnect` stops
  only for 4400–4499). Code 4500 is retried within `initRetryBudget` (3 by
  default), then becomes `RTC_INITIALIZATION_FAILED`.
- RAW conflict: emit `conflict`, enter the `conflict` state, immediately close
  the socket, then enter `failed` / `RTC_CONFLICT`; all subsequent calls reject
  with the stored error. `conflict` is transient: because it appears in the
  SPEC.md §6 state list, a consumer exhaustively handling `ConnectionState`
  has no unreachable branch.
- By default, the token is sent in the handshake header
  (`tokenTransport: 'header'`, `ws-auth.ts`), not in the query. Consequently,
  `provider.params` and `provider.url` contain no credentials, and dumping the
  provider is safe (SPEC.md §11). The test environment confirms header → 101
  and no credentials → 403. `tokenTransport: 'query'` mirrors the browser
  docprovider and leaves the token in the URL; it is only for deployments
  whose proxy strips the header.
- `RtcConnection` schedules reconnects itself: the y-websocket timer is
  neutralized (`shouldConnect = false` inside `connection-close`), and the
  delay is computed by `reconnectDelayMs(attempt, maxBackoffTime)`, using an
  exponential delay with jitter in the upper half of the window (SPEC.md §6).
  This scheduler is also where file identity is checked. As a consequence,
  `shouldConnect` is now `false` during ordinary backoff as well, so
  `state`/`terminalError`, not the provider flag, indicates terminal failure.
- Optional `revalidateFileId` runs before every reconnect attempt: a different
  `fileId` becomes terminal `FILE_ID_CHANGED`, while a request error counts as
  another failed attempt. This layer does not request a document session; the
  notebook layer supplies the callback.
- `synced` is maintained locally rather than proxying `provider.synced`:
  y-websocket emits `connection-close` before resetting its flag, so a `state`
  subscriber would otherwise observe a stale `true`.
- `save()` returns the status unchanged: `skipped` is not success and `timeout`
  does not prove failure. When the room fails terminally, a pending save rejects
  with `OPERATION_UNCERTAIN`; on an ordinary socket loss, it immediately
  resolves to `'timeout'`. The reply can arrive only on the socket that carried
  the request, so waiting for the entire budget would serve no purpose.
- Awareness publishes `{user: {name, color}, autosave: true}` to keep server
  autosave enabled.
- `disableBc: true` is mandatory; otherwise two connections in the same process
  would synchronize directly and bypass the server.

## Not provided here

- Notebook readiness (`nbformat !== undefined`), the replica, revisions, the
  change journal, and distinguishing local from foreign transactions belong to
  `src/core/notebook`. `RtcConnection` knows only whether Yjs has synchronized:
  `ready` here does not yet mean notebook readiness under SPEC.md §6 item 5.
- Fetching a fresh document session: the room is fixed in the constructor.
  `fileId` comparison exists (`revalidateFileId` → `FILE_ID_CHANGED`), but the
  calling layer must provide the callback; this module does not make an HTTP
  request from the reconnect state.
- A per-server document-session cache (`sessionId` is the Jupyter process-wide
  `SERVER_SESSION`) and server-restart detection.
- `notebook_create`: rename via Contents `PATCH`, `ALREADY_EXISTS`, and
  `OPERATION_UNCERTAIN` (`ServerClient` only allocates an untitled file;
  `validateNotebookName()` is prepared).
- Kernel/session REST and WebSocket: `serverSettings()` returns the settings;
  everything else belongs to `src/kernel`.
- JupyterHub (`hub_api_base_url`), cookie/XSRF authentication, `tls_ca_ref`, and
  `proxy_auth_ref` from docs/CONNECTIONS.md §9 are not implemented. Jupyter
  tokens and an operator assertion header are supported through
  `auth: {type: "header", name: "X-Jupyter-Access-Token"}` and `credentialRef`.
  The server validates the assertion; MCP sends it in REST, RTC, and kernel
  headers. The value is captured when the client is created; rotating the
  credential requires an MCP restart.
- RTC-level document-size enforcement (`DOCUMENT_TOO_LARGE`).

## Tests

```sh
pnpm vitest run test/jupyter          # unit + integration
pnpm vitest run --project unit test/jupyter
pnpm vitest run test/transport        # review tests for the same module
```

The integration tests (`test/jupyter/transport.int.test.ts`) start the
`dev/jupyter` environment on port **8896** and stop it themselves; the review
tests (`test/transport/review.transport.int.test.ts`) use port **8892**. Unit
tests use `test/jupyter/helpers/fake-rtc-server.ts`, a minimal room server with
close-code fixtures (SPEC.md §13, step 1). It records `seenAuthorizations`, and
`sendConflict(socket?)` can reply to one channel, as the real server does.
