# Live MCP agent UX observations, 2026-09-24

Source: user-supplied review of the deployed jupyter-eks server through public
MCP responses. The reviewer used tmp/mcp-ux-review-2026-09-24.ipynb, stopped
the kernel, closed the handle, and left the file in tmp/. The deployed revision
was not identified. These observations describe that live server, not necessarily
the source revision in this repository.

1. notebook_changes cell events report cell_id, while notebook_read only exposed
   cell_ref and index; passing an event's cell_id to cell_refs returned
   HANDLE_EXPIRED. In cell_added, neither index nor ref was present.
2. An execution result reported the current ref for edited source x = 5 with
   output from x = 2, while source_changed was false. In that run the cell
   completed before the edit; the observed defect is the misleading result.
3. Error traceback previews and text snapshots contained ANSI sequences.
   ename and evalue were absent outside the truncated output payload.
4. A DataFrame snapshot containing text/plain and text/html defaulted to HTML
   in output_read, and callers could not choose a MIME representation.
5. A source continuation omitted the byte offset; its final page said
   source_truncated:false even though that page was only the tail.
6. Receipt replay returned a current next_request_id alongside historical
   cell refs, index, structure revision, and change cursor.
7. A one-operation stale-ref conflict claimed an earlier operation in the same
   batch. Execution conflict diagnostics used a raw nbformat ID and lacked a
   preview. Starting a kernel could make notebook_ref stale without returning
   a replacement.
8. notebook_read outputs reported top-level truncated:true with all cells
   present and no next_cursor. A complete text preview could still be marked
   truncated because serialized JSON exceeded the text budget.
9. max_bytes was described as an entire-answer budget while limiting payload
   bytes. preview_chars did not constrain execute previews. Output and snapshot
   byte sizes had different meanings without an explanation; stream MIME lists
   differed. Small outputs received resource links and repeated lifetime blocks.
   Summary repeated notebook ID, cursor, structure revision, and notebook ref.
10. A six-second flushing stream yielded around ten outputs_changed events for
    one cell in a response, including duplicate-looking entries, despite the
    per-cell coalescing description.
11. notebook_close after kernel shutdown reported kernel_left_running:true.
    KERNEL_NOT_BOUND gave no recovery action. The read input called the paging
    argument page_cursor while the response called it next_cursor.
    Summary showed an errored cell as ordinary idle with no error indicator.
12. A kernel-side direct edit to the .ipynb file produced no change event
    within 30 seconds. A later confirmed save replaced that disk content with
    the RTC source. The reviewer did not determine whether the file watcher or
    MCP caused the missing event.

Observed ref invalidation: source_changed invalidated the source guard;
outputs_changed did not invalidate it for editing; structural changes moved
indices and invalidated page cursors but retained refs of surviving cells;
notebook metadata changes invalidated notebook_ref; local mutation responses
already carried fresh refs for their targets.
