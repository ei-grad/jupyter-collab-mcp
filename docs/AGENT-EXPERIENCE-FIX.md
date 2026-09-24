# Agent-facing read and reference fixes

This candidate addresses four observed MCP usability defects:

1. A source larger than a cell-read byte budget could not be fully retrieved
   through the returned cursor.
2. `output_read` sized raw bytes as though they were its JSON/base64 response,
   so a default read could exceed the adapter budget.
3. Recoverable error details were not consistently available to text-only
   clients.
4. Text rendering omitted source, revisions, and output data needed by hosts
   that do not consume structured content.

It also replaces the public durable-cell-ID plus revision pairs with one
connection-scoped observed version. `cell_ref` stores the full notebook handle,
cell identity, and every operation-specific guard. `notebook_ref` stores the
notebook handle and metadata guard. These refs are never substituted into user
metadata, source, attachments, or outputs.

Acceptance criteria:

- A paged source read reassembles every UTF-8 byte exactly; a changed or
  replaced cell invalidates its source continuation.
- Every successful `output_read` response, including escaped text and base64,
  fits its configured MCP budget and paged chunks reassemble exactly.
- Every output reference advertised by a successful read or execution result is
  immediately readable; a response that cannot retain its complete snapshot
  set reports `RESOURCE_LIMIT` instead.
- Sanitized recovery details that are needed to continue are visible in error
  text as well as structured metadata.
- Text content alone exposes valid refs/cursors plus cell source, output data,
  and execution recovery references.
- Public tool inputs use `cell_ref`, `cell_refs`, `before_cell_ref`,
  `after_cell_ref`, and `notebook_ref`. `notebook_id`, `request_id`, and
  `expected_kernel_id` remain explicit.
- Reads refresh a ref only for the same live cell object. Deletion,
  replacement, closure, another connection, or process restart cannot retarget
  it. Change events tell the agent to refresh; they do not mint mutable refs.

The distinct internal guard scopes remain unchanged: source for edit/run, full
cell for delete and cell metadata, outputs for clearing, notebook metadata for
metadata, and structure for cursor validity. The adapter expands these saved
preconditions before receipt deduplication. A later operation in one batch does
not advance an earlier ref implicitly.

## Selected observed-version contract

The agent uses one immutable `cell_ref` from a read instead of a durable cell
identifier plus an operation-specific expected revision. The server expands
that reference to the stored full identity and matching guard before mutation;
it never replaces a stale observation with current state. `notebook_ref` does
the same for notebook metadata. Reads refresh a live same-object observation;
mutations and anchors reject a deleted or replaced object.

Successful apply results issue refs for final surviving cell states; delete has
no usable result ref. Execution views issue a current-live same-object ref, not
a ref to the code snapshot sent to the kernel. Replacement/deletion reports the
ref unavailable. Cancellation returns available refs and unavailable counts.

The observed-ref table is process-, connection-, and full-handle-scoped,
immutable, non-evicting, and bounded to 4,096 entries by default. Projection
assigns tokens speculatively; response bounding commits only refs present in the
final structured payload, preserving their assigned values. Paged-away rows
consume no capacity, and an unpublishable response consumes none. When accepted
effects cannot publish because the table is full,
`RESOURCE_LIMIT` retains `side_effects: applied`, the request counter,
acceptance/replay/time fields, and the execution ID when applicable. Exact
receipt replay never repeats the effect even after deletion or replacement.
