---
name: jupyter-collab
description: Work inside a live JupyterLab notebook through the jupyter-collab-mcp server - open a notebook over RTC, read the summary and cells by ID and revision, apply edits, run cells so the user sees them run, read plots and errors, follow the user's own changes, and control the kernel. Use whenever the user wants a real notebook edited, executed or inspected instead of a script.
---

# Jupyter collaboration (RTC)

The notebook is a shared document. Every edit appears in the user's open
JupyterLab immediately, and the user edits the same document at the same time.
Work from IDs and revisions, never from remembered line numbers.

## 1. Server and notebook

1. `server_list` returns safe server descriptors and `next_request_id`.
   If selection is ambiguous, choose the intended configured `server_id`.
   `server_status {server_id?}` reads readiness and start profiles. If a Hub
   server is stopped and starting it is authorized, use
   `server_start {server_id?, request_id, profile_id?, wait_ms?}`. Alternatively
   pass `user_options` instead of `profile_id`. Take profile IDs from status;
   never guess a deployment profile. A timeout means keep observing with
   `server_status`, not resend under a new request number. A conflicting profile
   never permits restarting the existing server. This starts the singleuser
   server; notebook kernel start remains a separate `kernel_control` operation.
2. `notebook_list {server_id?, directory}` finds a file, then
   `notebook_open {server_id?, path}` returns `notebook_id`, `summary`,
   `changes_cursor`, and the current `next_request_id`. Reopening the same file
   on the same server reuses its handle (`reused: true`).
3. `notebook_create {server_id?, request_id, directory, name?}` creates a file.
   The working context is automatic. All servers in this connection share
   one mutation counter.
   Handles bind their server; subsequent handle-based calls need no server ID.

## 2. Summary, IDs, revisions

`notebook_read {notebook_id, view}` with `view`:

- `summary` - cell IDs, types, source previews, `execution_count`, revisions.
- `cells` - full source, metadata, attachments (`cell_ids` or a `cursor`).
- `outputs` - output entries with `mime_types`, `byte_size`, `truncated`,
  `output_id`.

Every guarded operation needs the revision from the answer you just read:
`source_revision` (text), `cell_revision` (whole cell), `outputs_revision`,
`notebook_metadata_revision`, `structure_revision`. Page cursors and
`changes_cursor` are different types and are not interchangeable.

## 3. Edits and visible execution

`notebook_apply {notebook_id, request_id, operations[]}`, operations:
`add_cell`, `replace_source`, `replace_text`, `delete_cell`, `clear_outputs`,
`set_cell_metadata`, `delete_cell_metadata`, `set_notebook_metadata`,
`delete_notebook_metadata`. Prefer `replace_text` (exact, unique substring)
over rewriting a whole cell. The answer gives new revisions,
`delivery` and `persistence`: an applied edit is not a saved file.

`notebook_execute {notebook_id, request_id, cells[{cell_id,
expected_source_revision}], wait_ms?}` runs the cells in the notebook, so the
user sees `[*]`, outputs and the final `execution_count`. Then
`execution_get {execution_id, cursor?, wait_ms?}` until `state` is terminal.
Never run notebook code with a shell tool instead: it would be invisible.

**request_id discipline.** `notebook_create`, `notebook_apply`,
`notebook_execute` and `kernel_control` are deduplicated per connection context.

- Take the number from the `next_request_id` of the last answer of *this*
  session. Never invent, increment or remember it yourself.
- Send these calls one at a time: the next one only after the previous answer.
- If you lost the counter (compaction, restart of your context), make a
  read-only call in the same session first - `notebook_read` or `kernel_list` -
  and use the `next_request_id` it returns.
- If the answer to a mutation was lost, resend the *same* `request_id` with the
  *same* payload to learn what happened. `replayed: true` plus
  `first_accepted_at` means the operation was accepted earlier: do not report
  it as a fresh insertion or a fresh run.
- Never re-issue an unknown effect under a new number. A genuinely new,
  identical operation needs a fresh number and is a new operation.
- Errors: `REQUEST_ID_CONFLICT` (same number, different payload),
  `REQUEST_OUT_OF_ORDER` (jumped ahead), `REQUEST_ID_EXPIRED` (receipt gone -
  check the document or the job, never blindly retry).

## 4. Plots, errors, the user's changes

- Images arrive as MCP image content when small enough; larger outputs come as
  `output_id` / `resource_link`. Read them with `output_read {output_id,
  cursor?}` (or the resource, if the host reads resources). Do not ask for full
  base64 in text.
- A Python error is a *result*, not a tool error: the job is `failed` with a
  reason and the traceback is in the cell outputs.
- `notebook_changes {notebook_id, cursor, wait_ms?, limit?}` reports adds,
  deletes, source/metadata/outputs edits, reordering, kernel changes and
  connection state - not a full IOPub transcript, and output updates are
  coalesced. A background update does not mean you have seen it: before any
  edit that depends on current content, read changes or re-read the cell.
- `CURSOR_EXPIRED` -> take a fresh snapshot (`notebook_read`) and continue from
  its `changes_cursor`.

## 5. Conflicts, reconnect, uncertain execution

- `REVISION_CONFLICT`, `MATCH_NOT_FOUND`, `MATCH_NOT_UNIQUE`, `CELL_REPLACED`:
  the user (or another agent) changed the cell. Re-read, decide again, then
  re-apply with the new revision. Do not force the old text back.
- `NOT_READY` is retryable; `RTC_SESSION_REJECTED`, `RTC_CONFLICT`,
  `FILE_ID_CHANGED` mean this replica is dead. Do not call `notebook_open`
  immediately: the same session would reuse the terminal handle. First let
  every execution on that handle reach a terminal state with `execution_get`,
  then call `notebook_close`; do not force-close or interrupt active work merely
  to recover. Open the notebook again only after the close, require a new
  `notebook_id` in `ready` state, and start from a fresh read. If the old handle
  is already expired, skip its close. `HANDLE_EXPIRED` after a server restart:
  open a new session/notebook, never replay code.
- Job state `unknown` or `OPERATION_UNCERTAIN`: the request was sent and the
  confirmation was lost. Check the notebook and the kernel (`kernel_status`,
  `notebook_read view: outputs`) and tell the user what you found. Do not
  re-run the cell on your own.
- `notebook_save {notebook_id}` returns `save_status` and
  `revision_persistence`; `skipped` and `timeout` are not success. Every open
  MCP replica advertises `autosave: true`, which keeps Jupyter collaboration
  autosave enabled even when another participant advertises `autosave: false`.
  Keep the handle open until the requested save or autosave opportunity has
  completed, and never present autosave as confirmation of a particular
  revision.

## 6. Closing vs interrupting vs restarting vs shutting down

- `notebook_close` and connection teardown release *our* handles only. The kernel
  keeps running and the user's JupyterLab is untouched.
- `execution_cancel {execution_id}` drops cells we have not sent yet. Cells
  already handed to the kernel keep running.
- `kernel_control {action: "interrupt", expected_kernel_id, request_id}` stops
  the whole kernel's current work, possibly someone else's. Only on request.
- `restart` clears no outputs and re-runs nothing; variables are gone.
- `shutdown` stops the kernel. Never do it as cleanup, and never touch a kernel
  the user did not ask you about.

## 7. Never bypass RTC

Never write, patch or `git checkout` the open `.ipynb` on disk, and never use a
shell/Python tool to edit it: the shared document would overwrite you or the
file would silently diverge. All content goes through `notebook_apply`.

Environment checks and dependency installs are notebook work too, and only on
the user's explicit request: add a **visible cell** and execute it
(`!pip install ...`, `%pip install ...`, `import sys; sys.executable`,
`!uv pip list`), following the project's own tooling. Do not auto-install after
an `ImportError`, do not run hidden service code, and do not stop a kernel that
is not yours.

## 8. Starting JupyterLab (external, on request only)

The MCP server never starts Jupyter. If no server is configured and the user
asks for one, first check the project's own environment and command
(`Makefile`, `justfile`, `docker compose`, `uv`/`poetry` scripts). Only if the
project has none, run in Bash (versions below are the verified stack; the
`uvx` invocation itself is not integration-tested):

```bash
uvx --from 'jupyterlab==4.6.3' --with 'jupyter-collaboration==5.0.2' \
  --with 'jupyter-server==2.21.0' --with 'jupyter-server-ydoc==3.0.2' \
  --with 'jupyter-ydoc==4.1.1' jupyter lab --no-browser \
  --ServerApp.ip=127.0.0.1 --ServerApp.root_dir=/absolute/project
```

Keep Jupyter's standard authentication. The URL and token in the startup log
are credentials: never copy them into an answer, a commit or a tool argument.
Tell the user the server is up and let them configure the token themselves.

## Example

```jsonc
// 1. server_list {} -> servers, next_request_id "1"
// 2. notebook_open {"path":"analysis.ipynb"}
//    -> notebook_id "nb_A", summary, changes_cursor "c7"
// 3. notebook_apply
{"notebook_id":"nb_A","request_id":"1","operations":[
  {"op":"replace_text","cell_id":"cell_B","expected_source_revision":"rev_1",
   "old_text":"df.head()","new_text":"df.head(20)"}]}
// -> results[0].source_revision "rev_2", next_request_id "2"
// 4. notebook_execute
{"notebook_id":"nb_A","request_id":"2",
 "cells":[{"cell_id":"cell_B","expected_source_revision":"rev_2"}],
 "wait_ms":2000}
// -> execution_id "ex_1", state "running", next_request_id "3"
// 5. execution_get {"execution_id":"ex_1","cursor":"...","wait_ms":5000}
//    -> state "succeeded" | "failed", outputs, output_id for the plot
// 6. notebook_changes {"notebook_id":"nb_A","cursor":"c7"} to see what the
//    user did meanwhile; notebook_save {"notebook_id":"nb_A"} if asked.
```
