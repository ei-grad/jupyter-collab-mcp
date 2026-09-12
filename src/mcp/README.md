# src/mcp

MCP stdio adapter over `CollabService` (SPEC.md §9). The module contains no
business logic: it validates arguments, renames snake_case ↔ camelCase, lays
results out as content blocks, and converts `CoreError` to `isError: true`.
The registry layer behind the facade decides what consumes a `request_id`,
which server to select, and what counts as `truncated`.

The SDK is `@modelcontextprotocol/server` 2.0.0, using protocol revision
`2026-07-28` (rationale and pitfalls: [docs/SERVICE-DESIGN.md](../../docs/SERVICE-DESIGN.md)
§7).

## Layers

| File | Purpose |
| --- | --- |
| `schemas.ts` | The 18 §9 tools: Zod input schemas, JSON Schema outputs, and descriptions. The only place that defines the wire format. |
| `wire.ts` | camelCase ↔ snake_case, omission of `undefined`, and the response budget (64 KiB) with truthful `response_truncated` / `read_more`. |
| `server.ts` | `createMcpServer(service, options)`: tool and `jupyter-output:` resource registration, output conversion to `image` / `resource_link`, and error mapping. |
| `cli.ts` | `jupyter-collab-mcp` entry point: stdout guard → configuration → service → `serveStdio`. |

## Tools

All 18 tools from the §9 table are registered with `inputSchema` and
`outputSchema`. Each description documents for an agent what the call does,
what it intentionally does not do, and the lifetime of the returned handle.
The following points are explicit:

- `notebook_create`, `notebook_apply`, `notebook_execute`, and `kernel_control`
  follow the sequential `request_id` rule: send the next such call only after
  the previous response, using its `next_request_id`; an error before
  acceptance does not consume the number (`request_accepted: false`), while an
  error after acceptance consumes it even when the operation fails;
- for `notebook_execute` and `execution_get`, a Python error, `aborted`,
  `interrupted`, or `unknown` is a job state rather than a tool error;
- `kernel_control` is a discriminated union on `action`
  (`start`/`interrupt`/`restart`/`shutdown`/`switch`), with branch-specific
  required fields; `expected_kernel_id` is always required;
- `notebook_read` is a discriminated union on `view`
  (`summary`/`cells`/`outputs`).

### Session envelope

Every session-scoped response adds `next_request_id`, `request_accepted`,
`replayed`, and `first_accepted_at` to `structuredContent`, exactly as returned
by the facade. A read call such as `notebook_read` is the cheapest way to
restore the counter after losing context.

### Errors

`CoreError` → `isError: true`, with a text block in the form `CODE: message`
and a structured record in `_meta["jupyter-collab/error"]`:

```json
{"code":"KERNEL_NOT_BOUND","message":"…","retryable":false,"side_effects":"none",
 "next_request_id":"4","request_accepted":false,"execution_id":"exe_9","revision":"s1_…"}
```

`next_request_id`, `request_accepted`, `execution_id`, and `revision` come from
the thrown error's `details`. Everything sent to the agent passes through
`redactCredentials` (SPEC §11). Errors do not include `structuredContent`;
this is permitted and does not conflict with the declared `outputSchema`
(docs/SERVICE-DESIGN.md §7.5 item 5).

**The adapter itself validates input.** If the SDK validated arguments first,
it would respond with the text `Input validation error` without
`code`/`retryable`/`side_effects`. The Zod schema is therefore passed to
`registerTool` only to publish JSON Schema (`~standard.jsonSchema`), while
`validate` is replaced with a pass-through implementation. Validation occurs
inside the handler, and invalid arguments produce the ordinary
`INVALID_ARGUMENT` error.

### Outputs, image, and resource_link

For every output, the adapter decides as follows (SPEC §9):

1. if a complete `image/png` or `image/jpeg` fits and does not exceed
   `imageMaxBytes` (128 KiB by default), return MCP `image` content; remove the
   payload from `structuredContent` and mark it `delivered_as: "image"` so the
   base64 is not duplicated;
2. if a `snapshot` exists, return a `resource_link` to
   `jupyter-output:<output_id>`;
3. otherwise retain `mime_types`, `byte_size`, and `output_id`, to be read via
   `output_read`.

The `resources` capability is declared without subscriptions:
`resources/list` returns live snapshots, and `resources/read` delegates to
`service.readOutputResource`. If a snapshot does not fit one `resources/read`,
the response is JSON containing `read_more` that points to `output_read`, not
an invented partial payload. Hosts without resource support can use the same
`output_read` as an ordinary tool.

### Response size

The budget is 64 KiB per response (`ServiceLimits.responseMaxBytes`). If the
payload does not fit, `boundPayload` reduces it in a fixed order: first remove
inline payloads that have an `output_id`, then halve the longest list. The
result is always marked `response_truncated: true` and includes `read_more`
instructions. The text block is truncated on a code-point boundary.

## CLI

```
jupyter-collab-mcp [--config <file.json>] [--discover]
                   [--user-name <name>] [--user-color <#rrggbb>]
                   [--log-level silent|error|warn|info|debug]
```

The order in `runCli()` is fixed: call `installStdoutGuard()` **first**, before
creating any `@jupyterlab/services` object and before the transport; then load
configuration, create the service, and call `serveStdio`. Only `serveStdio`
provides revision 2026-07-28—`server.connect(new StdioServerTransport())` pins
the legacy era. stdout carries MCP only; all diagnostics go to stderr.

`JUPYTER_URL` plus `JUPYTER_TOKEN` (or `JUPYTER_TOKEN_FILE`) define an implicit
`default` profile. `--config` accepts `ServiceConfigInput`
(`{servers, discovery, limits, awarenessUser}`). Tokens never appear in tool
arguments, responses, or resource URIs; profiles store only `credentialRef`.

`service.shutdown(reason)` is called on `SIGINT`, `SIGTERM`, and stdin EOF. If
it misses the five-second deadline, the process exits anyway. Kernels are never
shut down in this path (SPEC §4).

`JUPYTER_COLLAB_MCP_SERVICE_MODULE` replaces the service factory with a module
that exports `createService(config)`. This is a testing seam used by
`test/mcp/cli.test.ts` to run the real CLI against a fake service.

### Claude Code

`.mcp.json` in the project root (or `~/.claude.json` for user scope):

```json
{
  "mcpServers": {
    "jupyter-collab": {
      "command": "npx",
      "args": ["-y", "jupyter-collab-mcp"],
      "env": {
        "JUPYTER_URL": "http://127.0.0.1:8888",
        "JUPYTER_TOKEN": "devtoken"
      }
    }
  }
}
```

The equivalent single command is:

```sh
claude mcp add jupyter-collab \
  --env JUPYTER_URL=http://127.0.0.1:8888 \
  --env JUPYTER_TOKEN=devtoken \
  -- npx -y jupyter-collab-mcp
```

### Codex

`~/.codex/config.toml`:

```toml
[mcp_servers.jupyter-collab]
command = "npx"
args = ["-y", "jupyter-collab-mcp"]
env = { JUPYTER_URL = "http://127.0.0.1:8888", JUPYTER_TOKEN = "devtoken" }
```

Prefer not to store the token in the configuration file. Put it in a separate
file and set `JUPYTER_TOKEN_FILE`, or pass `JUPYTER_TOKEN` through the
environment.

### Running locally from source

```sh
JUPYTER_URL=http://127.0.0.1:8888 JUPYTER_TOKEN=devtoken pnpm start --log-level debug
```

## Tests

`test/mcp/` contains unit tests only and requires no Jupyter server.
`FakeCollabService` records calls; the SDK client communicates over an
`InMemoryTransport` created by the same `serveStdio` with
`pin: '2026-07-28'` (a successful connection proves the revision). Coverage
includes round trips for all 18 tools, `tools/list` with schemas and
descriptions, schema rejection as `INVALID_ARGUMENT`, error mapping and token
redaction, response budgeting, `image` versus `resource_link` selection,
`resources/list`, `resources/read`, and stdout cleanliness: a real `cli.ts`
child process with JSON-RPC on stdout and diagnostics on stderr.
