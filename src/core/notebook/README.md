# src/core/notebook — live notebook replica

`NotebookModel` wraps `YNotebook` from `@jupyter/ydoc`. It implements every
operation that is a function of the shared document: the `cell_id` index,
revisions, change journal, `notebook_apply`, and output-area generations.
There is no network, Jupyter Server, or MCP code here: the module is tested
entirely with two `YNotebook` instances connected through `Y.applyUpdate` (see
`test/core/notebook/helpers.ts`).

Relevant SPEC.md sections: §7 (cells, revisions, and concurrent edits), the
document portion of §8 (output generations), §9 (read limits and cursors), and
§10 (journal).

## Three invariants

1. **All local writes go through `ynotebook.ydoc.transact(fn, origin)`.**
   `@jupyter/ydoc` loses a custom origin in `cell.transact`/`notebook.transact`
   when `disableDocumentWideUndoRedo === false` (the default; see
   `spike/NOTES.md` §3.2). Nested transactions inherit the outer origin, so
   wrapping library calls is the only way to distinguish a local change from a
   remote one (`transaction.origin === origin`, SPEC.md §10).
2. **One observer set exists for the model's entire lifetime.** It is installed
   in the constructor and removed in `dispose()`. Reconnection must not
   accumulate observers (SPEC.md §6).
3. **A local write is identified by the transaction object, not a flag.** Yjs
   calls deep observers at the end of the *outer* transaction. If the caller
   opened `ydoc.transact` itself (for example, to group multiple IOPub writes
   into one RTC update), Yjs ignores the nested `transact` origin. The model
   therefore marks the transaction itself (`markLocalTransaction`), and
   `GenerationRegistry` additionally records which generation wrote which cell
   in that transaction. Otherwise a generation would revoke itself and its own
   edits would enter the journal as `remote`. Model calls may be nested inside
   another transaction; mixing local and foreign writes to the same cell in
   that transaction is not allowed.

## API

Constructor: `new NotebookModel(ynotebook, { origin, journalLimit?,
outputsCoalesceMs?, previewChars?, now? })`. `origin` is a connection marker
object.

### Addressing

- `isReady()` means `nbformat` is defined (readiness follows
  `spike/NOTES.md` §4; "contains at least one cell" is not a readiness signal).
- `cellRef(cellId)` → `{cellId, index, identityToken}`; `CELL_NOT_FOUND` /
  `CELL_ID_AMBIGUOUS`.
- `resolveRef(ref)` revalidates a previously returned reference and produces
  `CELL_REPLACED` if the cell's `Y.Map` was replaced under the same ID.
- `duplicateCellIds`, `structureRevision`, and `index` (`CellIndex`).

### Reading

- `summary(limits?)` → `NotebookModelSummary`, which is `NotebookSummary`
  without connection fields: `notebookId`, `path`, `fileId`, `documentId`,
  `connectionState`, and `stale`. The connection layer adds them through
  `withIdentity(summary, identity)`.
- `snapshotWithCursor(limits?)` → `{summary, changesCursor}` atomically, with
  no `await` between reading the model and recording the journal boundary
  (SPEC.md §9).
- `readCells(selector?, limits?)` returns source text, metadata, attachments,
  and truncation flags; `selector` is either `{cellIds}` or `{cursor}` (a page
  cursor).
- `readOutputs(cellIds, limits?)` returns outputs with a MIME list and per-item
  size. Data that does not fit the budget is not inlined; it has
  `truncated: true`, `byteSize`, and, for text, a short `textPreview`.

Defaults are 100 cells, 64 KiB, and an 80-character preview (SPEC.md §9).

A page cursor is bound to cell **identity**, not only to the ordering of cell
IDs (`pageBindingOf` in `read.ts`). The digest includes each cell's
`identityToken` plus `cell_id`. Public `structure_revision` remains a digest of
ordered IDs (the `structureRevision(orderedCellIds)` contract), so an external
write (`aset`) that replaces a `Y.Map` under the previous ID does not change
that revision—but it must invalidate the associated cursor (SPEC.md §12,
"External writes"). An ordinary cell-source edit does not invalidate the
cursor. The binding value is opaque and appears externally only inside the
`pg_` cursor.

With a small `maxBytes`, `readCells` may truncate cell source
(`sourceTruncated`, with the full size in `sourceBytes`) and returns a source
cursor. Continue it until that source is complete; it remains on the same cell
and expires when the source, cell identity, or structure changes.

### Editing

`apply(operations)` → `ModelApplyResult`. The full batch is first validated by
`plan.ts` against a simulation of the current replica, then applied in one
synchronous `ydoc.transact` by `execute.ts`. Operations come from
`src/core/types.ts`: `add_cell`, `replace_source`, `replace_text`,
`delete_cell`, `clear_outputs`, `set/delete_cell_metadata`, and
`set/delete_notebook_metadata`.

- `replace_source` applies the smallest edit to the existing `Y.Text` (shared
  prefix/suffix), preserving the cell object; an idempotent replacement emits
  no update at all.
- `replace_text` requires exactly one match (`MATCH_NOT_FOUND` /
  `MATCH_NOT_UNIQUE`).
- A metadata key may be a string or an array path such as
  `['jupyter','x']`. All other keys are preserved—literally: writes go
  **directly to the metadata `Y.Map`** (`execute.ts`, `writeMetadataKey`), not
  through `@jupyter/ydoc` helpers. `YNotebook.deleteMetadata` is implemented as
  `metadata = {...}; delete metadata[key]; setMetadata(metadata)`, while the
  object form of `setMetadata` calls `ymetadata.clear()` and then `set` for
  every remaining key. All untouched keys thus become concurrent writes, and
  Yjs resolves a conflict with a simultaneous browser edit by client ID; in
  other words, deleting an unrelated key could revert a user's edit. Cells
  have the same problem plus mirroring: `deleteMetadata('jupyter')` also
  deletes `collapsed`, and `setMetadata('collapsed', v)` writes
  `jupyter.outputs_hidden`. Direct per-key writes match the batch simulation,
  so a revision cited by the next operation in the same batch remains valid.
- A revision check accepts the value from before the batch or from after
  earlier operations in that batch; otherwise a batch could not touch one cell
  twice. The exception is a **repeated full replacement**: a second
  `replace_source` for the same cell that cites the pre-batch revision is
  rejected with `REVISION_CONFLICT` before the first mutation. Otherwise the
  first operation's text would disappear with neither an error nor an
  indication in the response. A `replace_text` chain remains allowed because
  it is bound to a substring that must exist.
- `REVISION_CONFLICT` contains `expected`, `current`, and a bounded `preview`
  (SPEC.md §7). The preview is a single line of at most 120 characters and
  passes through `redactCredentials` (SPEC.md §11). For outputs it describes
  the output area ("2 output(s): stream, error"); for metadata it lists keys
  without values.
- An unexpected error after the first mutation is not rolled back (a Yjs
  transaction is not a database transaction): the response contains
  `partial: true`, `partialAtOperation`, and `partialError`; the caller must
  reread affected cells (SPEC.md §7).
- The result contains no `delivery` or `persistence`: the model applies the
  edit to the local replica, while only the RTC connection layer knows about
  delivery and persistence.

### Journal (SPEC.md §10)

`changesSince(cursor, limit?)` → `{events, nextCursor}` or `CURSOR_EXPIRED`.
`changesCursor`, `flush()`, `recordConnectionState(state)`, and
`recordKernelChange(kernelId)`.

- The ring contains `journalLimit` events (10,000 by default); sequence numbers
  are monotonic and contiguous starting at 1, and published sequence numbers
  are never rewritten.
- `outputs_changed` is coalesced per cell to at most once per 100 ms and is
  published before a structural event, before source/metadata for that cell,
  at an execution-generation boundary, and before returning a snapshot/cursor.
- `changesSince` intentionally does **not** flush: polling must not bypass
  coalescing. Nothing is lost; a pending record receives a larger sequence
  number and arrives in the next call.
- Changes to `execution_count`/`execution_state` are classified as
  `outputs_changed` because they belong to the output area and its prompt.
- A newly added or replaced cell produces one `cell_added`/`cell_replaced`
  event; its initial content is not published as a separate event.
- A server-side ID rename (deduplication in `jupyter_ydoc`) is published as
  `cell_deleted(old)` + `cell_added(new)` and invalidates old targets.
- **A duplicate `cell_id` does not silence the journal.** Observation is keyed
  by the cell object (`identityToken`), not its ID: source/metadata/output
  changes to both cells are published normally and advance `changes_cursor`.
  Only *addressing* remains ambiguous (`CELL_ID_AMBIGUOUS` in
  `cellRef`/`apply`). Output coalescing remains keyed by ID, so two duplicates
  share one pending record; addressing still requires a reread.
- After `dispose()`, `flush()`, `recordConnectionState`, and
  `recordKernelChange` return `HANDLE_EXPIRED`, as do reads and `apply`
  (SPEC.md §6).
- Deleting a cell (or a server-side rename) clears per-cell structures through
  `journal.forgetCell` and `generations.forget`, so a long-lived replica does
  not retain a record for every ID it has ever observed.

### Output generations (SPEC.md §8)

- `beginExecutionGeneration(cellId)` performs one transaction: `outputs = []`,
  `execution_count = null`, deletion of `metadata.execution`, and
  `execution_state = 'running'`; it increments the generation counter and
  returns the sole writer (`OutputSink`). It returns `null` when the cell is
  missing, its ID is ambiguous, or it is not a code cell.
- `sinkFor(cellId)` (`OutputSinkFactory`) returns a live sink or `null`.
- `finishExecution(sink, {count})` writes the final `execution_count` and
  `idle` in one transaction. Writing the count early clears `[*]` in
  JupyterLab, which then writes `idle` back to the shared document itself.
- A generation stops being current after a newer local generation; any foreign
  write to that cell's `outputs`/`execution_count`/`execution_state`; deletion,
  replacement of the cell's `Y.Map`, or cell-ID change; or `dispose()`. A stale
  sink returns `false` and writes nothing.
- Local writes are identified by the pair "transaction + cell" (invariant 3),
  so `beginExecutionGeneration` and sink writes may be nested in the caller's
  transaction without causing the generation to revoke itself.
- `stream.text` received as an array of strings (the contract permits
  `string | readonly string[]`) is normalized with `join('')` before writing.
  Otherwise `YCodeCell.createOutputs` would join the strings using `join()`,
  inserting **commas**.

`dispose()` removes observers, cancels the coalescing timer, and invalidates
generations. The owner—the connection layer—calls `YNotebook.dispose()`;
without it, the awareness interval prevents the process from exiting
(`spike/NOTES.md` §3.3).

## Not implemented in this module

- **Network and RTC.** Provider, document session, RAW save, close codes,
  reconnect, `ConnectionState`, `stale`, `delivery`, and `persistence` are not
  here. The model exposes `recordConnectionState` for the journal.
- **Changing an existing cell's type and writing attachments** are deferred by
  SPEC.md §7; attachments are read and preserved only.
- **Moving cells** is deferred (SPEC.md §7). Observing a foreign reorder works:
  `moveCells` in `@jupyter/ydoc` clones cells, so it arrives as
  `cell_replaced`, correctly invalidating references.
- **`output_id` / resource links / continued snapshot reads** (`output_read`,
  `resources/read`) belong to the MCP layer; only limits and truncation flags
  are implemented here.
- **`request_id` deduplication, process memory limits, and `RESOURCE_LIMIT`**
  belong to the session layer.
- **`@jupyter/ydoc` metadata mirrors.** The module intentionally does not
  reproduce them: an operation changes exactly the named key (SPEC.md §7), so
  `set_cell_metadata('collapsed', …)` does not write
  `jupyter.outputs_hidden`, and `delete_cell_metadata('jupyter')` does not
  delete `collapsed`. The simulation in `plan.ts` and the document after the
  write remain identical. One side effect of direct writes is that the `dirty`
  flag on `YNotebook`/`YBaseCell` is not set. This does not affect RTC, which
  exchanges Yjs updates, but callers must not rely on that flag.
- **`@jupyter/ydoc` normalization during loading.** `fromJSON` moves
  `execution_count` to the end of a code cell and removes `orig_nbformat`;
  `stream.text` supplied as an array of strings is joined with `join()` (and
  therefore a comma). The write path through `OutputSink` corrects this with
  normalization, but documents loaded by the library retain its behavior;
  round-trip tests compare the state *after loading*, not the original file.
