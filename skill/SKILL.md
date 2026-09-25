---
name: jupyter-collab
description: Work inside a live JupyterLab notebook through the jupyter-collab-mcp server - open a notebook over RTC, read observed cell refs, apply edits, run cells so the user sees them run, read plots and errors, follow concurrent changes, and control the kernel. Use whenever the user wants a real notebook edited, executed or inspected instead of a script.
---

# Jupyter collaboration (RTC)

The notebook is a shared document. Every edit appears in the user's open
JupyterLab immediately, and the user edits the same document at the same time.
Work from `cell_ref` and `notebook_ref` observations, never from remembered
line numbers or reconstructed identifiers.

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

## 2. Summary and observed refs

`notebook_read {notebook_id, view}` with `view`:

- `summary` - `cell_ref`, `cell_id`, types, source previews, and `execution_count`.
- `cells` - full source, metadata, attachments (`cell_refs` or a `cursor`).
- `outputs` - output entries with `mime_types`, `byte_size`, `truncated`,
  `output_id`.

Each `cell_ref` is one immutable observation of the cell object plus all guards
needed by edit, delete, clear-output, metadata, and execution operations. Each
read also returns a `notebook_ref` for notebook metadata. Pass refs back exactly
as returned; they are scoped to this connection and notebook handle. A read by
`cell_refs` refreshes the observation only while the same cell object remains
live. A deleted or replacement object fails instead of redirecting the ref to a
new cell with the same internal ID. A source page gives `source_offset` and
`source_complete`; assemble all pages before using `replace_source`. If a cells
read reports a source cursor, continue it before acting on the incomplete source. Page cursors and
`changes_cursor` are different types and are not interchangeable.

Match change events to read rows by `cell_id`. `cell_refs` in a cells or outputs
read also accepts a `cell_id` from this connection and returns a fresh
`cell_ref` for the current cell. A `cell_id` cannot target an edit or run.
After `source_changed`, re-read that cell before editing or executing it;
`outputs_changed` leaves its `cell_ref` valid for source edits and execution.
After `cell_deleted`, discard its ref. A local mutation response already gives
current refs for surviving targets. Change events do not issue observed refs.

## 3. Edits and visible execution

`notebook_apply {notebook_id, request_id, operations[]}`, operations:
`add_cell`, `replace_source`, `replace_text`, `delete_cell`, `clear_outputs`,
`set_cell_metadata`, `delete_cell_metadata`, `set_notebook_metadata`,
`delete_notebook_metadata`. Cell operations use `cell_ref`; notebook metadata
operations use `notebook_ref`; add-cell anchors are `before_cell_ref` or
`after_cell_ref`. Prefer `replace_text` (exact, unique substring) over rewriting
a whole cell. The answer gives final refs for surviving targets,
`delivery` and `persistence`: an applied edit is not a saved file.

`notebook_execute {notebook_id, request_id, cells[{cell_ref}], wait_ms?}` runs
the cells in the notebook, so the
user sees `[*]`, outputs and the final `execution_count`. A positive `wait_ms`
waits for completion or the deadline, without holding the mutation lock.
Intermediate updates do not return early. If `wait_timed_out` is true, continue
with `execution_get {execution_id, cursor?, wait_ms?}` until `state` is terminal;
that read-only tool still waits for the next update rather than completion.
Never run notebook code with a shell tool instead: it would be invisible.
An execution view's `cell_ref` is a fresh observation of current live state for
the same cell object, not a claim that its source is the code already sent. If
the object was deleted or replaced, the view says `cell_ref_unavailable`.
`notebook_execute` accepts code cells only. `cell_ref "<ref>" is not a code
cell` means select a code cell; this rejected request leaves its `request_id`
unspent, so use the unchanged `next_request_id` for the corrected request.

Before the first execution, call `kernel_status {notebook_id}`. If it returns
`kernel_id: null`, bind/start the notebook kernel with `kernel_control {action:
"start", expected_kernel_id: null, notebook_id, request_id}` using the returned
`next_request_id`. If a kernel is already bound, use it; do not start or switch
one speculatively. Never guess `expected_kernel_id`.
When starting without `kernel_name`, an available advertised default is used;
if it is unavailable, the sole installed kernelspec is used. Multiple available
specs with no valid default require an explicit choice from `kernel_list`.
An explicitly requested unavailable name is an error, not a fallback.

**request_id discipline.** `server_start`, `notebook_create`, `notebook_apply`,
`notebook_execute` and `kernel_control` are deduplicated per connection context.

- Take the number from the `next_request_id` of the last answer of *this*
  session. Never invent, increment or remember it yourself.
- Send these calls one at a time: the next one only after the previous answer.
- If you lost the counter (compaction, restart of your context), make a
  read-only call in the same session first - `server_list`, `notebook_read` or
  `kernel_list` - and use the `next_request_id` it returns.
- If the answer to a mutation was lost, resend the *same* `request_id` with the
  *same* payload to learn what happened. `replayed: true` plus
  `first_accepted_at` means the operation was accepted earlier: do not report
  it as a fresh insertion or a fresh run. Only `next_request_id` is current;
  refs, indices, revisions and cursors in the replayed result may be stale.
  Re-read before dependent work.
- Never re-issue an unknown effect under a new number. A genuinely new,
  identical operation needs a fresh number and is a new operation.
- Errors: `REQUEST_ID_CONFLICT` (same number, different payload),
  `REQUEST_OUT_OF_ORDER` (jumped ahead), `REQUEST_ID_EXPIRED` (receipt gone -
  check the document or the job, never blindly retry).

## 4. Plots, errors, concurrent changes

- `execution_get` returns updates after its cursor. If a cell has
  `outputs_reset: true`, replace its previous output state with the returned
  snapshot; do not append it. Coalesced streams and updated displays can repeat
  a previously delivered prefix, including after execution completes.
- Images arrive as MCP image content when small enough; larger outputs come as
  `output_id` / `resource_link`. Read them with `output_read {output_id,
  cursor?}` (or the resource, if the host reads resources). Do not ask for full
  base64 in text. `output_read` pages its encoded payload within the response
  budget; keep following `next_cursor` until `truncated:false`.
- Every `output_id` in a successful result is readable when returned. A
  `RESOURCE_LIMIT` can mean the server could not retain that complete output
  set; after an accepted execution, keep its returned `execution_id` and
  `request_accepted` state and continue observation rather than resubmitting.
- A Python error is a *result*, not a tool error: the job is `failed` with a
  reason and the traceback is in the cell outputs.
- `notebook_changes {notebook_id, cursor, wait_ms?, limit?}` reports adds,
  deletes, source/metadata/outputs edits, reordering, kernel changes and
  connection state - not a full IOPub transcript, and output updates are
  coalesced. `origin: remote` means another participant, not a known person. A
  background update does not mean you have seen it. Before a dependent edit,
  refresh the target: if you retained its earlier `cell_ref`, call
  `notebook_read` with that ref; otherwise read the summary to obtain a current
  ref, then read the cell when the decision depends on its source, metadata or
  outputs. A notebook-metadata event likewise requires a fresh `notebook_ref`
  from `notebook_read`. Do not use the event's `cell_id` or revisions as a
  mutation target.
- `CURSOR_EXPIRED` -> take a fresh snapshot (`notebook_read`) and continue from
  its `changes_cursor`.

## 5. Conflicts, reconnect, uncertain execution

- `CELL_NOT_FOUND`, `CELL_ID_AMBIGUOUS`, `REVISION_CONFLICT`,
  `MATCH_NOT_FOUND`, `MATCH_NOT_UNIQUE`, `CELL_REPLACED`:
  use `current_cell_ref` or `current_notebook_ref` when supplied; it is the
  fresh observation of the same live object. `cell_ref "<ref>" no longer
  identifies a live cell` means deletion or replacement: re-read the summary.
  `cell_ref "<ref>" does not identify a unique live cell` (or `a supplied cell
  reference ...`) means re-read the summary and select a uniquely addressable
  cell; do not guess among duplicates.
  `cell_ref "<ref>" is stale because the cell changed since it was read` means
  inspect the current content and decide again. `cell_ref "<ref>" was
  invalidated by an earlier operation in this batch` means the batch reused one
  observed ref after changing its guarded scope; split the work or re-read
  between operations. Apply the same recovery to `before_cell_ref` and
  `after_cell_ref`; do not force the old text back.
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
  `revision_persistence`. It captures the full normalized snapshot at
  `requested_at`, saves via RTC, and reads back through the Contents API within
  one `timeout_ms` budget. `confirmed` includes `persistence_confirmation`
  with `method: "contents-api-readback"`, `snapshot_digest` and `observed_at`.
  This confirms that captured snapshot was observed through the storage API;
  it does not verify an earlier read or execution you checked, the latest RTC
  state, filesystem durability, or future persistence. Custom Contents managers
  may cache internally. `structure_revision` covers structure only; there is
  no `expected_revision` save input. On mismatch, unsupported readback or timeout,
  confirmation is null and persistence is `unknown`; do not report that as a
  verified save of your checked content. `skipped` and `timeout` are not success.
  Capture and each readback have a 16 MiB byte cap; exceeding it also leaves
  persistence `unknown` even if the server reported save success.
  Every open
  MCP replica advertises `autosave: true`, which keeps Jupyter collaboration
  autosave enabled even when another participant advertises `autosave: false`.
  Keep the handle open until the requested save or autosave opportunity has
  completed, and never present autosave as confirmation of a particular
  revision.

## 6. Closing vs interrupting vs restarting vs shutting down

- `notebook_close` and connection teardown release *our* handles only. The kernel
  keeps running and the user's JupyterLab is untouched.
- `execution_cancel {execution_id}` drops cells we have not sent yet and returns
  the owning `notebook_id`, available `cancelled_cell_refs` and
  `already_sent_cell_refs`, and unavailable counts for deleted/replaced cells.
  Cells already handed to the kernel keep running.
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

## Output and save checks

After execution, compare sent_cell_ref with the current cell_ref and check
source_changed before treating output as the result of current code.
kernel_control returns a new notebook_ref when its action changes metadata.

Error entries expose ename and evalue even if traceback text is cut.
Traceback previews and text/plain snapshots omit ANSI escapes; summary rows
use has_error to flag an error output. output_read selects text/plain by
default; pass mime_type for another retained representation and keep that
selection while paging. The output entry's byte_size counts nbformat JSON,
while snapshot.byte_size counts the default MIME payload. output_lifetime
applies to every snapshot in the answer.

If the snapshot budget drops alternate MIME data, snapshot.mime_types lists
only representations still readable with output_read.

For notebook_read outputs, cells_truncated means continue with next_cursor.
outputs_truncated means some output data remains out of line. A complete
text_preview can have truncated:false while output_inlined:false. Resource
links appear only for outputs left out of line.

notebook_changes collapses repeated output updates within an answer; its
cursor still advances past every underlying event. After notebook_save, inspect
external_change_detected for pre-save disk divergence, then
overwrote_external_change for a readback-confirmed replacement of that disk
content. A null overwrite flag means persistence was not confirmed; do not
infer a successful overwrite from save_status alone. notebook_close reports
whether a kernel was still bound through kernel_left_running; null means the
Jupyter Sessions lookup failed.

## Example

```jsonc
// 1. server_list {} -> servers, next_request_id "1"
// 2. notebook_open {"path":"analysis.ipynb"}
//    -> notebook_id "nb_A", summary, changes_cursor "c7"
// 3. kernel_status {"notebook_id":"nb_A"}
//    -> kernel_id null, next_request_id "1"
// 4. kernel_control (skip when kernel_id is already non-null)
{"notebook_id":"nb_A","action":"start","expected_kernel_id":null,
 "request_id":"1"}
// -> kernel_id "k_1", next_request_id "2"
// 5. notebook_apply
{"notebook_id":"nb_A","request_id":"2","operations":[
  {"op":"replace_text","cell_ref":"@observed_cell_before",
   "old_text":"df.head()","new_text":"df.head(20)"}]}
// -> results[0].cell_ref "@observed_cell_after", next_request_id "3"
// 6. notebook_execute
{"notebook_id":"nb_A","request_id":"3",
 "cells":[{"cell_ref":"@observed_cell_after"}],
 "wait_ms":2000}
// -> execution_id "ex_1", terminal state or wait_timed_out true,
//    cursor "...", next_request_id "4"
// 7. If wait_timed_out: execution_get
{"execution_id":"ex_1","cursor":"...","wait_ms":5000}
//    -> state "succeeded" | "failed", outputs, output_id for the plot
// 8. notebook_changes {"notebook_id":"nb_A","cursor":"c7"} to see what
//    changed meanwhile. Before an edit that depends on an event, notebook_read
//    refreshes a cell_ref (and notebook_ref); event cell_id can select a fresh
//    read but cannot target a mutation. notebook_save {"notebook_id":"nb_A"} if asked.
```
