# Disposable Jupyter RTC environment (Step 0)

A local environment for testing hypotheses from [SPEC.md](../../SPEC.md), sections 5, 6,
and 13: document session handshake, room WebSocket, and compatible package versions.
The environment is disposable: all state resides in `.runtime/<PORT>/` and is not committed.

## Contents

| File | Purpose |
| --- | --- |
| `pyproject.toml`, `uv.lock` | uv project with exact versions, CPython 3.12 |
| `start.sh` | starts JupyterLab with RTC enabled and waits for `/api/status` |
| `stop.sh` | stops the server using its PID file and removes a stale PID |
| `probe.py` | checks REST, collaboration session, and the room WebSocket |
| `.runtime/<PORT>/` | PID file, log, `base_url`, SQLite YStore, and the `root/` working directory |

## Installation

```sh
cd dev/jupyter
uv sync
```

`uv` obtains CPython 3.12 automatically (pinned in `.python-version`).
A global Jupyter installation is neither required nor used.

## Starting

```sh
PORT=8899 TOKEN=devtoken ./start.sh
```

Environment variables:

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `8888` | server port; also the directory name under `.runtime/` |
| `TOKEN` | `devtoken` | fixed development token (`ServerApp.token`, `IdentityProvider.token`) |
| `ROOT` | `.runtime/<PORT>/root` | contents root directory; created at startup |
| `RESTART` | `0` | `1` stops a live server on this port before starting |

The server listens only on `127.0.0.1`; no browser is opened
(`--no-browser`, `ServerApp.open_browser=False`). Update checks and the
JupyterLab news feed are disabled
(`LabApp.check_for_updates_class=…NeverCheckForUpdate`, `LabApp.news_url=None`).
Each server runs with `.runtime/<PORT>/` as its working directory, which keeps
the current-directory-relative SQLite YStore isolated from stands on other
ports.

`start.sh` waits up to 90 seconds for `GET /api/status` to return 200 with the
token, prints the `jupyter_server_ydoc` extension lines from
`jupyter server extension list`, and prints the base URL on the final line.

### Idempotency

The selected behavior is **fail**: if the PID file exists and the process is alive,
`start.sh` prints the already-running URL and exits with code `3`; it does not
start a second server. A stale PID file (no corresponding process) is removed
silently and startup continues. Restart explicitly with `RESTART=1 ./start.sh`
or run `./stop.sh` before `./start.sh`.

The `ROOT` directory is not cleared on restart; accumulated `Untitled*.ipynb`
files are removed together with `.runtime/`.

## Verification

```sh
PORT=8899 TOKEN=devtoken uv run python probe.py
```

`probe.py` performs these checks in order:

1. `GET /api/status` → 200;
2. `POST /api/contents` with `{"type":"notebook"}` → 201 and a new `Untitled*.ipynb`;
3. `PUT /api/collaboration/session/<path>` with `{"format":"json","type":"notebook"}`
   → JSON containing `fileId` and `sessionId`;
4. WebSocket connection to
   `/api/collaboration/room/json:notebook:<fileId>?sessionId=…&token=…`
   → connection established and the first frame received.

The script prints the raw JSON session response and the first 32 bytes of the first
WebSocket frame in hex. It exits with a nonzero status on any failure.

If the server does not send a frame on its own, the probe sends Yjs SyncStep1 with
an empty state vector (`00 00 01 00`) and waits for a response. This is only a
fallback; normally the server initiates the first frame.

## Stopping

```sh
PORT=8899 ./stop.sh
```

The script sends `SIGTERM`, waits up to 30 seconds, and uses `SIGKILL` if needed;
it removes the PID file and `base_url`. If the PID file is absent or the process
is already dead, the script removes the remnants and exits with code 0.

**Always stop the server after use**: it holds the port and writes to
`.runtime/<PORT>/jupyter.log`.

## Verified versions

Pinned by `uv.lock`, CPython 3.12.13 (macOS arm64):

| Package | Version |
| --- | --- |
| jupyterlab | 4.6.3 |
| jupyter-server | 2.21.0 |
| jupyter-collaboration | 5.0.2 |
| jupyter-server-ydoc | 3.0.2 |
| jupyter-ydoc | 4.1.1 |
| jupyter-server-fileid | 0.9.3 |
| pycrdt | 0.14.4 |
| pycrdt-websocket | 0.16.4 |
| ipykernel | 7.3.0 |
| jupyter-client | 8.10.0 |
| httpx | 0.28.1 |
| websockets | 17.1 |

Enabled server extensions: `jupyter_server_ydoc 3.0.2` and
`jupyter_server_fileid 0.9.3`. Lab extensions:
`@jupyter/collaboration-extension 5.0.2` and `@jupyter/docprovider-extension 5.0.2`.
There is no separate server extension named `jupyter_collaboration` in version 5.x:
`jupyter-collaboration` is a metapackage, and `jupyter_server_ydoc` provides the
server-side component.

## Observations

The response from `PUT /api/collaboration/session/<path>` is a flat object with
four strings:

```json
{"fileId": "<uuid>", "format": "json", "sessionId": "<uuid>", "type": "notebook"}
```

The first room WebSocket frame for a newly created empty notebook is four bytes,
`00 00 01 00`: Yjs sync (`0x00`), SyncStep1 (`0x00`), payload length 1, empty
state vector. The server sends it without a client request.
