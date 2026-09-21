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

It also introduces context-scoped typed aliases for notebook, execution,
output, durable cell, and revision values. Aliases resolve only to values that
were issued in the current connection, are never substituted into user data,
and are never reused after a close or a new connection. Full service values
remain the authoritative identities and comparison inputs.

Acceptance criteria:

- A paged source read reassembles every UTF-8 byte exactly; a changed or
  replaced cell invalidates its source continuation.
- Every successful `output_read` response, including escaped text and base64,
  fits its configured MCP budget and paged chunks reassemble exactly.
- Sanitized recovery details that are needed to continue are visible in error
  text as well as structured metadata.
- Text content alone exposes valid aliases/cursors plus cell source and
  revisions, output data, and execution recovery references.
- Full IDs and revision hashes remain accepted for compatibility. IDs beginning
  with `@` or `raw:` use the documented `raw:<base64url(UTF-8)>` escape.
  Aliases only apply to typed protocol fields and cannot select a new object
  after closure or process restart.

The existing distinct revision guards remain unchanged: source for edit/run,
cell for delete, outputs for clearing, notebook metadata for metadata, and
structure for cursor validity. This work does not redesign their conflict
scope.
