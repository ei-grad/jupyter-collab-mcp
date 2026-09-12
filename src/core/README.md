# `src/core` — shared contracts

Dependency-free (except `node:crypto`) types and helpers that every other
module implements against. Nothing here opens a socket, touches Yjs or knows
about MCP. See [`docs/CORE-DESIGN.md`](../../docs/CORE-DESIGN.md) for the
module map and ownership, and `SPEC.md` for the behaviour these types encode.

| File | Contents |
| --- | --- |
| `errors.ts` | `ErrorCode`, `CoreError`, `DEFAULTS`, `coreError()`, `redactCredentials()` |
| `revision.ts` | Branded revision digests and the canonical JSON serialiser |
| `types.ts` | Connection, server, cell, operation, change, cursor, kernel, job and `OutputSink` contracts |
| `index.ts` | Re-exports; import from `src/core/index.js`, not from the files |

## Rules that are easy to break

- **Errors never carry credentials.** `CoreError.message` and `details` go
  straight into an MCP response (SPEC §9, §11). A WebSocket URL with `token=`
  in the query must pass through `redactCredentials()` first — better, must
  never be built into a message at all.
- **`side_effects` is about the document, the file or the kernel**, not about
  consuming a `request_id`. When the effect cannot be established the answer is
  `unknown`, even for a normally harmless failure.
- **Revisions are opaque and full length.** 43 base64url characters after a
  three-character kind tag. Never truncate one for display and then compare it.
  Use `isRevisionOfKind()` before comparing a caller-supplied `expected_*`
  value: a digest of the wrong kind is `INVALID_ARGUMENT`, not
  `REVISION_CONFLICT`.
- **`sourceRevision` covers type and text only.** An outputs change must not
  move it, otherwise a `notebook_execute` targeting a running cell would always
  conflict.
- **`ChangesCursor` and `PageCursor` are different shapes on purpose**
  (`chg_…` / `pg_…`, SPEC §9). Build them with `makeChangesCursor()` /
  `makePageCursor()` and never pass one where the other is expected.
- **`add_cell` takes exactly one anchor.** The `?: never` members of
  `AddCellAnchor` enforce it at compile time; the runtime validator must repeat
  the check, because operations also arrive as JSON.
- **`OutputSink` mutators return `applied: boolean`.** A stale generation
  returns `false` and changes nothing. `src/kernel` must check the flag rather
  than assume the write landed; the outputs stay on the job record.

## Codes deliberately absent from `ErrorCode`

- `NAMED_CREATE_UNSUPPORTED` — removed from `SPEC.md` in commit 696d775.
  `notebook_create` now does untitled-allocate plus Contents `PATCH` rename on
  the standard manager, so a named create fails with `ALREADY_EXISTS`,
  `PERMISSION_DENIED` or `OPERATION_UNCERTAIN`.
- `SERVER_NOT_RUNNING` — belongs to the optional JupyterHub lifecycle adapter
  (`docs/CONNECTIONS.md` §7), which is outside the first version. Add it when
  that adapter lands.
