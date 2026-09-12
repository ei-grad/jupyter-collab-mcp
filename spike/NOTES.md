# RTC spike — results (Step 1 of SPEC.md §13)

A disposable check of the hypotheses in sections 5, 6, 8, and §6 “Delivery
and persistence.” Script: [`rtc-spike.ts`](./rtc-spike.ts). Usage:

```sh
pnpm tsx spike/rtc-spike.ts            # starts its own server on PORT (default 8898) and stops it
PORT=8901 pnpm tsx spike/rtc-spike.ts  # different port
JUPYTER_URL=http://127.0.0.1:8899 JUPYTER_TOKEN=devtoken pnpm tsx spike/rtc-spike.ts  # reuse a live server
```

Run result against the `dev/jupyter` environment (JupyterLab 4.6.3,
jupyter-collaboration 5.0.2, jupyter-server-ydoc 3.0.2, jupyter-ydoc 4.1.1,
@jupyter/ydoc 4.1.1, y-websocket 3.1.0, yjs 13.6.32, Node v24.14.0):
**14/14 PASS, exit 0**. The notebook was never written through
`PUT /api/contents`; all file contents on disk came from the RTC room.

## 1. Exact handshake

Everything below uses the `Authorization: token <TOKEN>` header; the token is
placed in the query string only where no alternative exists (WebSocket).

### 1.1 Notebook creation (newUntitled)

```
POST <base>/api/contents/            body: {"type":"notebook"}
-> 201, model.path == "Untitled.ipynb"
```

POST targets the **directory**, and the server chooses the path. `PUT` to a
desired path is forbidden (§6).

### 1.2 Document session

The semantics come from
`jupyter-collaboration@5.0.2 packages/docprovider/src/requests.ts` and were
confirmed against the server code
(`jupyter_server_ydoc/handlers.py:DocSessionHandler`, route
`r"/api/collaboration/session/(.*)"`).

```
PUT <base>/api/collaboration/session/<encodeURIComponent(path)>
body: {"format":"json","type":"notebook"}
-> 201 (file indexed for the first time) or 200 (already indexed)
-> {"format":"json","type":"notebook","fileId":"<uuid>","sessionId":"<uuid>"}
```

The encoding is specifically `encodeURIComponent`, not `encodeURI`: `/`
becomes `%2F`, and Tornado decodes it back into a path. This was verified
with a nested path containing spaces and non-ASCII Unicode, which produced a
percent-encoded segment and `%2FUntitled.ipynb`, then HTTP 201. Spaces,
Unicode characters, and nesting work.

**A 201 response does not prove that the file exists.** `DocSessionHandler`
calls `file_id_manager.index(path)` and responds with 404 only if that call
returns `None`. By default, `jupyter_server_fileid` uses
`ArbitraryFileIdManager`, whose `index()` merely creates a SQLite record
and never checks the file (`jupyter_server_fileid/manager.py:325`). A missing
path therefore receives a fresh `fileId` and HTTP **201**. The same applies to
a previously indexed path whose file was later deleted: `get_id()` returns
the old ID and HTTP 200. The failure appears later: room
`json:notebook:<fileId>` closes with code **4404**. Existence must be checked
separately with `GET /api/contents/<path>?content=0` and/or by interpreting
4404 as `NOTEBOOK_NOT_FOUND` (SPEC.md §6).

### 1.3 Room WebSocket

```
ws://<host>/api/collaboration/room/json:notebook:<fileId>?sessionId=<sessionId>&token=<TOKEN>
```

- The room name is `<format>:<type>:<fileId>`, specifically
  `json:notebook:<uuid>`. The y-websocket `url` getter does **not** encode
  the room name; it simply concatenates `serverUrl + '/' + roomname`. Colons
  are legal in a path segment, and the room name must remain **raw**. A
  `%3A` variant is not equivalent: `YDocWebSocketHandler` calls
  `room_id_from_encoded_path(self.request.path)`, which is
  `encoded_path.split("/")[-1]` on the **undecoded** path
  (`jupyter_server_ydoc/utils.py:85`). The room ID therefore becomes
  `json%3Anotebook%3A<uuid>`, the `room_id.count(":") >= 2` check fails,
  and the document is not loaded; instead, a **different, empty** room opens.
  There is no error or 4404: the encoding failure looks like “the notebook
  suddenly became empty.”
- The server sends the first frame itself: SYNC / SyncStep1. For a fresh
  (not yet loaded) room it is `00 00 01 00`, an empty state vector. For a
  room that has already loaded the document, the state vector is nonempty and
  the frame is longer. An empty first frame does not indicate a successful
  connection, and exact bytes identify a protocol version; frames must not be
  matched against a sample and instead must be parsed by `y-protocols/sync`.
  y-websocket also sends its own SyncStep1 immediately in `onopen`, so order
  is irrelevant.
- `provider.on('sync', true)` occurs after SyncStep2 from the server. Before
  that, `nbformat`/`nbformat_minor` on the local `YNotebook` are
  `undefined`.

### 1.4 RAW save (`yprovider.ts requestDocumentSave` / `handlers.py on_message`)

The request is a binary frame sent over the same room socket:

```
varUint(2 = MessageType.RAW) ; varString("save") ; varUint(<save_id>)
```

The response is a frame of the same type:

```
varUint(2) ; varString(JSON)
JSON = {"type":"save","responseTo":<save_id>,"status":"success"|"skipped"|"failed"}
```

Observed: `{"type":"save","responseTo":1,"status":"success"}`. Script step
7b checks less than this observation: it asserts only that `status` is a
string, so it would also pass for `skipped`/`failed`. The run's
`success` result is recorded in the output, not by the assertion.

### 1.5 Kernel

`@jupyterlab/services` with
`ServerConnection.makeSettings({baseUrl, wsUrl, token, appendToken: true,
WebSocket: ws, fetch})`, followed by
`SessionManager.startNew({path, type:'notebook', name: path,
kernel:{name:'python3'}})` and
`kernel.requestExecute({code, allow_stdin:false, stop_on_error:true})`.
The token is sent in the kernel WS query parameter (`appendToken`), as expected.

For `x = 40 + 2\nx`, IOPub delivered `status(busy)`, `execute_input`,
`execute_result`, and `status(idle)`; `execute_reply.status == "ok"`,
`execution_count == 1`. One output was written to the shared model:

```json
{"output_type":"execute_result","data":{"text/plain":"42"},"metadata":{},"execution_count":1}
```

The spike checked **only** the `execute_result` output type. `stream`,
`display_data`, `error`, `clear_output(wait)`, and
`update_display_data` were never executed; the rule
`{output_type: msg.header.msg_type, ...msg.content}` for them is derived from
the protocol, not observed (see §6).

## 2. Provider selection

**Use y-websocket as is, plus about ten lines of adaptation.** A custom provider
is unnecessary:

1. Replace `provider.messageHandlers[2]` with a RAW handler (the array is
   public; the constructor uses `messageHandlers.slice()`).
2. Use `provider.ws.send(...)` to send RAW save.
3. Set `disableBc: true`, `WebSocketPolyfill: ws`, and
   `params: {sessionId, token}`.

Everything else (SyncStep1/2, incremental updates, awareness, backoff, and the
watchdog) works unchanged.

## 3. Pitfalls

1. **`MessageType.RAW == 2` conflicts with y-websocket's
   `messageAuth == 2`.** This is the primary incompatibility. Without
   replacing `provider.messageHandlers[2]`, a save response reaches
   `y-protocols/auth.readAuthMessage`, where it is parsed as a permission
   message. This is silent corruption, not an error. The handler is mandatory
   even if save is unused because the server may send RAW itself.

2. **`@jupyter/ydoc` loses a custom origin.**
   With `disableDocumentWideUndoRedo == false` (the default),
   `YBaseCell.transact(f, undoable, origin)` calls
   `notebook.transact(f, undoable)`, discarding the origin.
   `YDocument.transact(f, undoable, origin)` calls
   `ydoc.transact(f, undoable ? this : origin)`, so the origin is used only
   when `undoable === false`. The working technique is to wrap API calls in
   `notebook.ydoc.transact(fn, MY_ORIGIN)`; nested Yjs transactions merge
   into the outer transaction and inherit its origin. Without this, §10
   (“local transaction origin distinguishes a local change from a remote
   one”) is not satisfied.

3. **`new YNotebook()` keeps the event loop alive.** Internally it contains
   `y-protocols` `Awareness` with an approximately three-second
   `setInterval`. Without `notebook.dispose()`, the process does not exit.
   This confirms the §4 requirement to release the replica in
   `notebook_close`.

4. **`@jupyterlab/services` writes to STDOUT.**
   `kernel/default.js:80` calls
   `console.debug("Starting WebSocket: <url>")`. In Node, `console.debug`
   writes to stdout and therefore directly into the MCP channel (§11). The
   token is not printed in this line (it is added to the URL later), but any
   output is unacceptable. Intercept `console` for the process lifetime
   (redirect `console.debug/log/info` to stderr) before creating a
   `KernelConnection`.

5. **Yjs noise on stderr.** `warnPrematureAccess` (“Invalid access: Add Yjs
   type to a document before reading data.”) is printed for every `addCell`.
   It does not break MCP because it is stderr, but it pollutes logs.

6. **`ws` types.** Neither `WebSocketPolyfill: WebSocket` nor
   `settings.WebSocket` type-checks: `@types/ws` lacks the `dispatchEvent`
   required by the DOM-like `WebSocket` from `@types/node`. Use
   `WebSocket as unknown as typeof globalThis.WebSocket`. Runtime behavior
   is unaffected.

7. **`sessionId` is server-scoped, not document-scoped.** It is the module
   constant `SERVER_SESSION = str(uuid4())` in
   `jupyter_server_ydoc/utils.py` (not `handlers.py`; `handlers.py`
   imports it), created once per Jupyter Server process and identical for all
   documents. A second `PUT` for the same file is idempotent (200 rather than
   201, same `fileId`/`sessionId`), and client B can simply reuse client
   A's values. If the sessionId **differs** after a server restart, `open()`
   calls `check_session_compatibility` and may close the socket with code
   **1003** and payload
   `{"reason":…,"sessionId":…,"reloadable":true}`.

8. **Close codes.** The server uses 4404 (file not found), 4400 (bad request),
   and 4500 (internal). y-websocket's `defaultShouldReconnect` treats the
   4400–4499 range as terminal: 4404 and 4400 stop reconnection and emit a
   `closed` event, while 4500 and 1003 do not. For 1003, y-websocket
   reconnects forever with the same stale sessionId. A custom
   `shouldReconnect` or a `connection-close` handler must request a new
   document session.

9. **An empty notebook arrives with one cell.**
   `jupyter_ydoc/ynotebook.py:_set` inserts an automatically created empty
   code cell if `value["cells"]` is empty. After first synchronization:
   `cells.length == 1`, `nbformat == 4`, `nbformat_minor == 5`, and
   `metadata` contains `kernelspec` and `language_info` (also added by the
   server through `setdefault`). This cell is not our edit and cannot serve
   as proof of a successful write.

10. **Autosave is enabled by default.** `DocumentRoom._on_document_change`
    reads `autosave` from client awareness states; a missing key defaults to
    `True`, and one client with `autosave` is enough to enable persistence.
    The debounce interval is `document_save_delay`, which defaults to 1.0 s.
    In the run, the file on disk contained B's edit and outputs **before** the
    explicit save (step 7a). The subsequent explicit RAW save returned
    `success`.

11. **`skipped` does not mean success.** `status: "skipped"` occurs **only**
    while `self._update_lock` is held: the server does not write to disk and
    responds immediately. An already running save task does not cause
    `skipped`: `_maybe_save_document` itself calls
    `saving_document.cancel()` for an unfinished previous task and supersedes
    it, so the prior save simply does not complete. §6 is correct on the main
    point: `skipped` does not confirm a write.

12. **A `Response` can be read only once.** A pattern such as
    `assert(res.ok, `... ${await res.text()}`)` evaluates the body even
    when the response is successful; a later `res.json()` fails with
    `TypeError: Body is unusable`. Read `text()` once and parse it manually.

13. **nbformat output from IOPub.** The
    `{output_type: msg.header.msg_type, ...msg.content}` rule works for
    `stream`/`execute_result`/`display_data`/`error`, but `transient`
    (including `display_id`) must be removed, as §8 already requires.

14. **BroadcastChannel.** Node 22+ provides `BroadcastChannel` globally, and
    y-websocket uses it by default. Two clients in one process without
    `disableBc: true` would begin synchronizing directly through BC, bypassing
    the server; the “two independent clients” test would become a false
    positive. `disableBc: true` is mandatory both as a §6 requirement and
    for test validity.

## 4. Deviations from SPEC.md

- **§6 item 4** says “Connect to the room … and pass sessionId. This is not a
  Jupyter kernel session or an MCP working session.” This is correct, but the
  wording implies a document session. It is actually the **server process**
  identifier, shared by all documents and clients and changed only when
  Jupyter restarts. It can be cached at server rather than notebook scope; a
  mismatch means “the server restarted,” not “the document session expired.”

- **§6 item 5** says “Create an empty shared model, receive the initial Yjs
  synchronization, and check notebook structure availability.” A qualification
  is needed: a new file already contains one server-created empty cell, and
  `nbformat` appears only after synchronization. Readiness must mean
  “`sync` arrived and `nbformat` is defined,” not “there is at least one cell.”

- **§10** says “Local transaction origin distinguishes a local change from a
  remote one.” This is not achieved through the public `@jupyter/ydoc` API
  (pitfall 2). Direct use of `ydoc.transact` is required and must be recorded
  in the architecture; otherwise the §10 change journal treats local edits as
  foreign.

- **§5** says “A small Jupyter document-session negotiation module for
  `y-websocket` is required.” This is confirmed and refined: the module
  consists of URL/encoding logic, replacing `messageHandlers[2]`, and sending
  RAW save. A custom provider or sync-protocol implementation is unnecessary.

- **§11** says “With stdio, stdout is reserved for MCP; diagnostics go to
  stderr.” A dependency, not our code, violates this (pitfall 4). The
  implementation must explicitly intercept `console.*` at process startup.

- **§6 “Delivery and persistence”** assumes persistence is an explicit
  operation. On the tested server, autosave with a one-second debounce updates
  the file without a request. This does not eliminate `notebook_save`, but it
  means “the file on disk lags behind” is a transient state lasting about one
  second, not a permanent one.

## 5. Recommendations for the client core

1. **Build `NotebookConnection` around `Y.Doc`, not `YNotebook`.** Perform
   every mutation through `ydoc.transact(fn, origin)`, where `origin` is a
   marker object for this connection. Calls to the `YNotebook`/`YCodeCell`
   API are safe inside the transaction. An update with `origin === provider`
   is considered remote.

2. **Use a thin wrapper around `WebsocketProvider`** (for example,
   `JupyterRoomProvider`): construct the URL, set `disableBc: true`, replace
   `messageHandlers[MessageType.RAW]`, maintain a
   `Map<saveId, resolver>`, expose
   `requestSave(): Promise<'success'|'skipped'|'failed'>`, and use a custom
   `shouldReconnect` that stops for 4400/4404 and raises “request a new
   document session” on a 1003 close.

3. **Cache document sessions per server, not per document.** `fileId` belongs
   to a document; `sessionId` belongs to a server. A changed `sessionId`
   invalidates all open replicas for that server (§6: “a stale replica must
   not be sent into a new document”).

4. **Readiness = `sync` && `nbformat !== undefined`.** Until then, reads are
   `stale` and writes return `NOT_READY`, as required by §6.

5. **`dispose()` is mandatory** for every `YNotebook`, and `destroy()`
   for every provider; otherwise the process does not exit and awareness
   timers accumulate.

6. **Intercept `console` at startup**: route
   `console.debug/log/info/warn` to stderr before creating any
   `@jupyterlab/services` objects. Also redact `token=…` from URLs in all
   application logs.

7. **`notebook_save` returns `save_status` unchanged**
   (`success`/`skipped`/`failed`/`timeout`) and separately returns
   `revision_persistence: unknown` until ordering of “our update was applied
   before save” is proven. A direct `GET /api/contents?content=1` check is a
   spike debugging tool; it is an unnecessary full download in production (§2).

8. **A single output writer per execution** was shown to work: write
   `setOutputs` + `execution_count` + `executionState` in one transaction
   with the execution origin; an observer on another client receives one
   `outputsChange`.

9. Keep **path-encoding tests** (§6) as a separate suite: nesting, spaces, and
   non-ASCII Unicode were verified here; add `#`, `?`, `+`, and a URL
   prefix such as `/user/name/`.

## 6. Not yet verified

- A real JupyterLab browser as the second client (§12 requires this separately).
- Reconnection with a retained replica and state-vector exchange.
- Behavior on 1003/incompatible `sessionId`: read from source but not reproduced.
- `clear_output(wait)`, `update_display_data`, large PNGs, and stream outputs.
- RAW save `status: "skipped"`: not reproduced, only inferred from code.
