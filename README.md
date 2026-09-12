# jupyter-collab-mcp

An MCP server that works **inside a running JupyterLab notebook** over
real-time collaboration (Yjs/RTC), instead of rewriting `.ipynb` files behind
the user's back.

The agent joins the same shared document the user has open: it reads the
notebook by cell ID and revision, applies edits that appear instantly in the
browser, runs cells so the user sees `[*]`, the outputs and the execution
count, reads plots and tracebacks, and follows what the user changed
meanwhile. One long-lived process holds the sessions, the replicas and the
kernel bindings; every tool call is an ordinary request/response.

Status: the RTC client, the notebook model and the execution layer are
implemented and covered by unit, integration and end-to-end tests; the MCP
adapter is being assembled on top of them. See [SPEC.md](SPEC.md) and
[docs/STATUS.md](docs/STATUS.md).

## Requirements

- Node.js >= 22
- A reachable Jupyter server with **real-time collaboration enabled**:
  `jupyter-collaboration` 5.x (`jupyter-server-ydoc` 3.x, `jupyter-ydoc` 4.x).
  Verified stack: JupyterLab 4.6.3, jupyter-server 2.21.0,
  jupyter-collaboration 5.0.2, jupyter-server-ydoc 3.0.2, jupyter-ydoc 4.1.1.
- A Jupyter token. The server never starts Jupyter for you.

Without `jupyter-collaboration` there is no shared document and this server
cannot work.

## Install and configure

Claude Code (stdio):

```sh
claude mcp add --transport stdio jupyter \
  --env JUPYTER_URL=http://127.0.0.1:8888/ \
  --env JUPYTER_TOKEN=... \
  -- npx -y jupyter-collab-mcp
```

Codex (`~/.codex/config.toml`), passing env var *names*, not values:

```toml
[mcp_servers.jupyter]
command = "npx"
args = ["-y", "jupyter-collab-mcp"]
env_vars = ["JUPYTER_URL", "JUPYTER_TOKEN"]
startup_timeout_sec = 30
tool_timeout_sec = 45
```

Tokens are never passed as tool arguments and never appear in responses,
resource URIs or logs. On stdio, stdout carries MCP only; diagnostics go to
stderr. For multi-server, JupyterHub and remote setups see
[docs/CONNECTIONS.md](docs/CONNECTIONS.md).

Install the agent skill as well - it is what teaches the model the workflow:
see [skill/README.md](skill/README.md).

## Tools

| Tool | Purpose |
| --- | --- |
| `server_list` | Configured/discovered servers, credential-free descriptors |
| `session_open` | Open a working session; returns `session_id`, `next_request_id` |
| `session_close` | Release the session; never shuts a kernel down |
| `notebook_list` | List notebooks in a directory, with kernel session info |
| `notebook_create` | Untitled -> optional rename -> open; returns the real path |
| `notebook_open` | Join the shared document; reusable handle + summary |
| `notebook_close` | Release one replica |
| `notebook_read` | `summary`, `cells` or `outputs` view with revisions and cursors |
| `notebook_apply` | Guarded edits: add/replace/delete cells, metadata, clear outputs |
| `notebook_execute` | Run cells visibly in the notebook; returns `execution_id` |
| `execution_get` | Job state and new outputs since a cursor |
| `execution_cancel` | Drop cells not sent yet; never interrupts the kernel |
| `output_read` | Page through one output snapshot (MIME, size, next cursor) |
| `notebook_changes` | Journal of document changes after a cursor |
| `notebook_save` | Ask the server to save; reports skipped/timeout honestly |
| `kernel_list` | Kernelspecs and running kernels; executes nothing |
| `kernel_status` | Binding, channel state, observed execution status |
| `kernel_control` | `start` / `interrupt` / `restart` / `shutdown` / `switch` |

Output snapshots are also exposed as `jupyter-output:` MCP resources
(`resources/list`, `resources/read`); hosts that do not read resources use
`output_read` instead.

## Guarantees and non-guarantees

- **Delivery is not persistence.** `notebook_apply` reports `delivery` and
  `persistence` separately: a sent update proves neither that the server
  applied it nor that the file was written. Only `notebook_save` speaks about
  the file, and `skipped`/`timeout` are not success.
- **Deduplication is per working session.** `notebook_create`,
  `notebook_apply`, `notebook_execute` and `kernel_control` take a
  `request_id` - a decimal counter that starts at `"1"` and is always taken
  from the previous response's `next_request_id`. Resending the same number
  with the same payload replays the stored receipt (`replayed: true`); a
  different payload is `REQUEST_ID_CONFLICT`. Exactly-once across a process
  restart, a new session or a lost Jupyter connection is **not** promised.
- **No distributed CAS.** Revisions guard an edit inside our own replica; the
  CRDT has no cross-client compare-and-swap. A concurrent remote edit can land
  between the check and the write, which is why reads before dependent edits
  are part of the workflow.
- **Handles are process-scoped.** After a restart they are `HANDLE_EXPIRED`;
  code is never replayed to recover them.
- **Errors are structured**: `code`, `message`, `retryable`,
  `side_effects: none|applied|unknown`. A Python error is not a tool error -
  it is a job in state `failed`.
- **Closing never stops a kernel**, and cancelling a job never interrupts one.
- Limits are configurable defaults, not measured capacities: 100 cells per
  summary, 64 KiB of text per response, 30 s of wait per call, 10 000 journal
  events, 32 replicas and 64 sessions per process.

## Development

```sh
pnpm install
pnpm typecheck
pnpm test:unit          # unit project
pnpm test:int           # integration project (starts local stands)
dev/jupyter/start.sh    # PORT/TOKEN, local JupyterLab stand
pnpm smoke              # end-to-end: create -> edit -> execute -> save
dev/jupyter/stop.sh
pnpm build              # tsc -p tsconfig.build.json -> dist/
```

## Documentation

- [SPEC.md](SPEC.md) - the specification this implementation follows
- [docs/STATUS.md](docs/STATUS.md) - what exists, verified versions, deviations
- [docs/CORE-DESIGN.md](docs/CORE-DESIGN.md), [docs/SERVICE-DESIGN.md](docs/SERVICE-DESIGN.md)
- [docs/CONNECTIONS.md](docs/CONNECTIONS.md) - transports, hosts, JupyterHub
- [docs/PUBLISHING.md](docs/PUBLISHING.md) - release process
- [skill/SKILL.md](skill/SKILL.md) - the agent skill

MIT © 2026 Lilia Grigoreva
