/**
 * Tool schemas of SPEC.md §9: the wire contract of the 18 MCP tools.
 *
 * Input schemas are zod (`z.object`), because the adapter validates arguments
 * itself and turns a failure into an `INVALID_ARGUMENT` error with the same
 * shape as every other error (`code` / `message` / `retryable` /
 * `side_effects`). Output schemas are plain JSON Schema, published as
 * `outputSchema` so a host can type the `structuredContent`.
 *
 * Both are snake_case; `src/mcp/wire.ts` renames to and from the camelCase of
 * `CollabService`.
 *
 * The descriptions are the agent's only documentation. Each one states what
 * the call *does* (including what it deliberately does not do), the lifetime
 * of any handle it returns, and — for the four deduplicated mutations — the
 * sequential `request_id` rule. Nothing here describes an internal.
 *
 * @module
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// JSON Schema helpers
// ---------------------------------------------------------------------------

/** One JSON Schema node. Deliberately untyped: it is data, not a contract. */
export type JsonSchema = Record<string, unknown>;

const str = (description?: string): JsonSchema =>
  description === undefined ? { type: 'string' } : { type: 'string', description };
const nullableStr = (description?: string): JsonSchema => ({
  type: ['string', 'null'],
  ...(description === undefined ? {} : { description })
});
const bool = (description?: string): JsonSchema => ({
  type: 'boolean',
  ...(description === undefined ? {} : { description })
});
const num = (description?: string): JsonSchema => ({
  type: 'number',
  ...(description === undefined ? {} : { description })
});
const nullableNum = (description?: string): JsonSchema => ({
  type: ['number', 'null'],
  ...(description === undefined ? {} : { description })
});
const arr = (items: JsonSchema, description?: string): JsonSchema => ({
  type: 'array',
  items,
  ...(description === undefined ? {} : { description })
});
const anyObject = (description?: string): JsonSchema => ({
  type: 'object',
  ...(description === undefined ? {} : { description })
});
const obj = (properties: Record<string, JsonSchema>, required: readonly string[] = []): JsonSchema => ({
  type: 'object',
  properties,
  // An empty `required` is legal JSON Schema but noise on the wire; omit it.
  ...(required.length === 0 ? {} : { required: [...required] })
});

/**
 * Fields every response carries beyond the tool's own result.
 *
 * The session envelope (SPEC.md §9) plus the two adapter-owned flags that
 * report a response cut down to the byte budget.
 */
const ENVELOPE: Record<string, JsonSchema> = {
  next_request_id: nullableStr(
    'request_id the next deduplicated mutation of this connection must use. null when the context accepts no further mutations.'
  ),
  request_accepted: {
    type: ['boolean', 'null'],
    description:
      'true: the request_id was consumed before the first effect. false: rejected before acceptance, the same number may be reused. null: the receipt expired. Absent on calls that take no request_id.'
  },
  replayed: bool('true when the answer came from a stored receipt. It reports receipt reuse, not success: do not announce a new cell or a new run.'),
  first_accepted_at: str('RFC 3339 UTC time this request_id was first accepted. A replay never moves it.'),
  response_truncated: bool('true when the adapter cut the answer to the byte budget; read_more says what to call.'),
  read_more: str('How to read what was omitted.')
};

/** Result object of a tool: its own fields plus {@link ENVELOPE}. */
const result = (properties: Record<string, JsonSchema>, required: readonly string[] = []): JsonSchema =>
  obj({ ...properties, ...ENVELOPE }, required);

const LIFETIME = obj(
  {
    scope: str('until_close_or_process_exit | until_connection_close'),
    released_by: arr(str()),
    process_scoped: bool('Always true: after a restart the handle is HANDLE_EXPIRED.')
  },
  ['scope', 'released_by', 'process_scoped']
);

const SERVER_DESCRIPTOR = obj(
  {
    id: str(),
    kind: str('standalone | jupyterhub'),
    api_base_url: str(),
    browser_base_url: str(),
    hub_user: str(),
    hub_server_name: str()
  },
  ['id', 'kind', 'api_base_url']
);

const CELL_SUMMARY = obj(
  {
    cell_id: str(),
    index: num(),
    cell_type: str('code | markdown | raw'),
    source_revision: str(),
    cell_revision: str(),
    outputs_revision: nullableStr(),
    execution_count: nullableNum(),
    execution_state: str('running | idle'),
    preview: str('Short excerpt, never the whole source.'),
    duplicate_id: bool()
  },
  ['cell_id', 'index', 'cell_type', 'source_revision', 'cell_revision', 'preview']
);

const NOTEBOOK_SUMMARY = obj(
  {
    notebook_id: str(),
    path: str(),
    file_id: str(),
    document_id: str(),
    connection_state: str('connecting | syncing | ready | reconnecting | conflict | closed | failed'),
    stale: bool(),
    nbformat: nullableNum(),
    nbformat_minor: nullableNum(),
    cell_count: num('Total cells, even when the list was truncated.'),
    cells: arr(CELL_SUMMARY),
    truncated: bool(),
    structure_revision: str(),
    notebook_metadata_revision: str(),
    duplicate_cell_ids: arr(str()),
    changes_cursor: str(),
    page_cursor: str()
  },
  ['notebook_id', 'path', 'file_id', 'connection_state', 'stale', 'cell_count', 'cells', 'truncated', 'changes_cursor']
);

const NOTEBOOK_HANDLE = obj(
  {
    notebook_id: str(),
    path: str(),
    file_id: str(),
    document_id: str(),
    connection_state: str(),
    stale: bool(),
    lifetime: LIFETIME
  },
  ['notebook_id', 'path', 'file_id', 'connection_state', 'stale', 'lifetime']
);

const SNAPSHOT_REF = obj(
  {
    output_id: str(),
    uri: str('jupyter-output:<output_id>. Read it as an MCP resource, or with output_read.'),
    mime_types: arr(str()),
    byte_size: num(),
    inline_image_advised: bool(),
    lifetime: LIFETIME
  },
  ['output_id', 'uri', 'mime_types', 'byte_size']
);

const OUTPUT_ENTRY = obj(
  {
    index: num(),
    output_type: str('stream | execute_result | display_data | error'),
    mime_types: arr(str()),
    byte_size: num('Full size, even when the payload was not inlined.'),
    truncated: bool(),
    output: anyObject('The nbformat output, present only when it fit the budget.'),
    text_preview: str(),
    snapshot: SNAPSHOT_REF,
    delivered_as: str('Set to "image" when this output was returned as MCP image content instead of being inlined here.')
  },
  ['index', 'output_type', 'mime_types', 'byte_size', 'truncated']
);

const EXECUTION_CELL = obj(
  {
    cell_id: str(),
    state: str('queued | sent | succeeded | failed | aborted | not_sent | unknown'),
    source_revision: str('Revision of the text actually sent.'),
    msg_id: str(),
    execution_count: nullableNum(),
    not_sent_reason: str('The cell provably never reached the kernel.'),
    aborted_reason: str('kernel_aborted | interrupted — the kernel answered the request we sent.'),
    source_changed: bool(),
    cell_deleted: bool(),
    output_incomplete: bool('Output budget hit; the kernel was NOT interrupted.'),
    outputs: arr(OUTPUT_ENTRY),
    outputs_reset: bool('true when outputs replace the state represented by the request cursor, including an empty clear.'),
    outputs_truncated: bool()
  },
  ['cell_id', 'state', 'source_revision', 'source_changed', 'cell_deleted', 'output_incomplete', 'outputs', 'outputs_reset', 'outputs_truncated']
);

const EXECUTION_VIEW: Record<string, JsonSchema> = {
  execution_id: str(),
  notebook_id: str(),
  kernel_id: nullableStr(),
  state: str('queued | running | succeeded | failed | cancelled | interrupted | unknown — a Python error is failed, not a tool error.'),
  stop_on_error: bool(),
  cells: arr(EXECUTION_CELL),
  created_at: str(),
  finished_at: str(),
  reason: str(),
  cursor: str('Pass to execution_get; already delivered output is never repeated.'),
  wait_timed_out: bool('true when wait_ms elapsed. The job keeps running; nothing was interrupted.'),
  lifetime: LIFETIME
};

const KERNEL_STATUS: Record<string, JsonSchema> = {
  notebook_id: str(),
  kernel_id: nullableStr('null means nothing is bound; reading never starts a kernel.'),
  kernel_name: nullableStr(),
  jupyter_session_id: nullableStr(),
  channel_state: str('connecting | connected | disconnected'),
  execution_status: str('unknown | starting | idle | busy | terminating | restarting | autorestarting | dead'),
  observed_at: str(),
  active_execution_ids: arr(str())
};

// ---------------------------------------------------------------------------
// shared zod fragments
// ---------------------------------------------------------------------------

const serverId = z.string().min(1).optional().describe('Jupyter server profile. Omit only when exactly one server is available; otherwise SERVER_SELECTION_REQUIRED.');
const notebookId = z.string().min(1).describe('notebook_id from notebook_open or notebook_create.');
const executionId = z.string().min(1).describe('execution_id from notebook_execute.');
const outputId = z.string().min(1).describe('output_id from an outputs read or an execution result.');

const requestId = z
  .string()
  .regex(/^[1-9][0-9]{0,18}$/u, 'request_id must be a canonical decimal number without leading zeros')
  .describe(
    'Canonical decimal request number of this connection, starting at "1" and growing by one. Always take it from next_request_id of the previous answer; never invent or reconstruct one. A repeat with the same payload replays the stored result; a different payload is REQUEST_ID_CONFLICT.'
  );

const revision = (what: string) => z.string().min(1).describe(`Expected ${what} revision, taken from a previous read. A mismatch is REVISION_CONFLICT and nothing is applied.`);

const limits = z
  .object({
    max_cells: z.number().int().positive().optional().describe('Cells in this answer. Clamped to the configured budget (default 100).'),
    max_bytes: z.number().int().positive().optional().describe('UTF-8 budget of this answer. Clamped to the configured budget (default 64 KiB).'),
    preview_chars: z.number().int().positive().optional(),
    max_output_bytes: z.number().int().positive().optional().describe('Budget for inlined output payloads; larger ones come back as an output_id only.')
  })
  .optional()
  .describe('Per-call response budgets. You may only ask for less than the configured limit.');

const waitMs = z
  .number()
  .int()
  .nonnegative()
  .optional()
  .describe('How long this call may wait, clamped to 30 s. The wait ending interrupts nothing: the computation keeps running.');

const directory = z
  .string()
  .describe('Directory in the Jupyter Contents root. "" is the root itself; ".." segments are rejected.');

// ---------------------------------------------------------------------------
// notebook_apply operations (SPEC.md §7)
// ---------------------------------------------------------------------------

const addCell = z.object({
  op: z.literal('add_cell'),
  cell_type: z.enum(['code', 'markdown', 'raw']),
  source: z.string(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  before_cell_id: z.string().optional(),
  after_cell_id: z.string().optional(),
  position: z.literal('end').optional()
});

const OPERATION = z.discriminatedUnion('op', [
  addCell,
  z.object({
    op: z.literal('replace_source'),
    cell_id: z.string(),
    expected_source_revision: revision('source'),
    source: z.string()
  }),
  z.object({
    op: z.literal('replace_text'),
    cell_id: z.string(),
    expected_source_revision: revision('source'),
    old_text: z.string().min(1).describe('Must occur exactly once, otherwise MATCH_NOT_FOUND / MATCH_NOT_UNIQUE.'),
    new_text: z.string()
  }),
  z.object({
    op: z.literal('delete_cell'),
    cell_id: z.string(),
    expected_cell_revision: revision('cell')
  }),
  z.object({
    op: z.literal('clear_outputs'),
    cell_id: z.string(),
    expected_outputs_revision: revision('outputs')
  }),
  z.object({
    op: z.literal('set_cell_metadata'),
    cell_id: z.string(),
    expected_cell_revision: revision('cell'),
    key: z.string().describe('One key. Other keys of the cell are left untouched.'),
    value: z.unknown()
  }),
  z.object({
    op: z.literal('delete_cell_metadata'),
    cell_id: z.string(),
    expected_cell_revision: revision('cell'),
    key: z.string()
  }),
  z.object({
    op: z.literal('set_notebook_metadata'),
    expected_notebook_metadata_revision: revision('notebook metadata'),
    key: z.string(),
    value: z.unknown()
  }),
  z.object({
    op: z.literal('delete_notebook_metadata'),
    expected_notebook_metadata_revision: revision('notebook metadata'),
    key: z.string()
  })
]);

// ---------------------------------------------------------------------------
// the tool table
// ---------------------------------------------------------------------------

/** Everything `createMcpServer` needs to register one tool. */
export interface ToolSpec {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly input: z.ZodType;
  readonly output: JsonSchema;
  /** `true` when the tool changes no document, file or kernel state. */
  readonly readOnly: boolean;
  /** `true` for the four tools that take a `request_id` (SPEC.md §9). */
  readonly deduplicated: boolean;
}

const SEQUENTIAL =
  'Deduplicated and sequential: send it only after the previous mutation of this connection answered, with request_id = that answer\'s next_request_id. An error before acceptance leaves the number unused (request_accepted:false); after acceptance the number is spent even if the operation failed.';

const NOT_A_TOOL_ERROR =
  'A Python error, an aborted or interrupted run and a lost kernel are job results (state failed / aborted / interrupted / unknown), never tool errors.';

/** The 16 tools of SPEC.md §9, in the order of the table there. */
export const TOOL_SPECS: readonly ToolSpec[] = [
  {
    name: 'server_list',
    title: 'List Jupyter servers',
    description:
      'Configured and (if enabled) discovered Jupyter servers, as credential-free descriptors. Contacts nothing and starts nothing. Use it to pick server_id for notebook_list/open/create or kernel_list when more than one is available.',
    input: z.object({}),
    output: obj(
      {
        servers: arr(
          obj(
            {
              descriptor: SERVER_DESCRIPTOR,
              origin: str('configured | discovered'),
              default_choice: bool('true when a server-scoped tool without server_id would pick this one.')
            },
            ['descriptor', 'origin', 'default_choice']
          )
        ),
        discovery_enabled: bool(),
        selection_required: bool('true when a server-scoped tool without server_id fails with SERVER_SELECTION_REQUIRED.'),
        next_request_id: ENVELOPE['next_request_id'] as JsonSchema,
        response_truncated: ENVELOPE['response_truncated'] as JsonSchema,
        read_more: ENVELOPE['read_more'] as JsonSchema
      },
      ['servers', 'discovery_enabled', 'selection_required']
    ),
    readOnly: true,
    deduplicated: false
  },
  {
    name: 'notebook_list',
    title: 'List notebooks',
    description:
      'Notebooks and directories under directory, with whatever Jupyter kernel-session information the server reports. Reads no file bodies and opens no document.',
    input: z.strictObject({
      server_id: serverId,
      directory,
      cursor: z.string().optional().describe('Continue a previous listing.'),
      limits
    }),
    output: result(
      {
        directory: str(),
        entries: arr(
          obj(
            {
              name: str(),
              path: str(),
              type: str('notebook | directory'),
              last_modified: nullableStr(),
              size: nullableNum(),
              session: obj(
                {
                  jupyter_session_id: str(),
                  kernel_id: nullableStr(),
                  kernel_name: nullableStr(),
                  execution_status: str()
                },
                ['jupyter_session_id']
              ),
              open_notebook_id: str('Set when this connection already has the file open.')
            },
            ['name', 'path', 'type']
          )
        ),
        truncated: bool(),
        next_cursor: str(),
        sessions_included: bool()
      },
      ['directory', 'entries', 'truncated', 'sessions_included']
    ),
    readOnly: true,
    deduplicated: false
  },
  {
    name: 'notebook_create',
    title: 'Create and open a notebook',
    description:
      `Allocate an untitled notebook in directory, rename it to name through Contents when one is given, then open its RTC room. ${SEQUENTIAL} The number is consumed before the file is allocated, so any failure after that reports request_accepted:true. On ALREADY_EXISTS (name taken) and PERMISSION_DENIED the untitled file stays on the server and the error names its path with side_effects:applied; a lost rename confirmation is OPERATION_UNCERTAIN and is never retried automatically. The notebook handle lives until notebook_close, connection close or process exit.`,
    input: z.strictObject({
      server_id: serverId,
      request_id: requestId,
      directory,
      name: z
        .string()
        .min(1)
        .optional()
        .describe('One file name ending in .ipynb, inside directory. No "/" or "\\". Omitted, the server-chosen untitled name is kept.')
    }),
    output: result(
      {
        notebook: NOTEBOOK_HANDLE,
        untitled_path: str('Path the server allocated before any rename.'),
        renamed: bool(),
        summary: NOTEBOOK_SUMMARY,
        changes_cursor: str('Start observing with notebook_changes from here.')
      },
      ['notebook', 'untitled_path', 'renamed', 'summary', 'changes_cursor']
    ),
    readOnly: false,
    deduplicated: true
  },
  {
    name: 'notebook_open',
    title: 'Open a notebook',
    description:
      'Open a notebook by path and return a reusable handle plus a consistent summary and changes_cursor. Opening the same file again on this connection and server returns the same handle (reused:true) — one replica, one WebSocket; a different connection gets its own replica. Starts no kernel. Takes no request_id. The handle lives until notebook_close, connection close or process exit.',
    input: z.strictObject({
      server_id: serverId,
      path: z.string().min(1).describe('Path of the .ipynb in the Jupyter Contents root.'),
      limits
    }),
    output: result(
      {
        notebook: NOTEBOOK_HANDLE,
        reused: bool('true when a live handle for the same file was returned.'),
        summary: NOTEBOOK_SUMMARY,
        changes_cursor: str()
      },
      ['notebook', 'reused', 'summary', 'changes_cursor']
    ),
    readOnly: false,
    deduplicated: false
  },
  {
    name: 'notebook_close',
    title: 'Close a notebook',
    description:
      'Release one replica: socket, observers, journal and page cursors. The kernel keeps running and the file is not deleted. Idempotent by handle. Refuses with EXECUTION_ACTIVE while a job of this notebook is active; force:true abandons it.',
    input: z.object({
      notebook_id: notebookId,
      force: z.boolean().optional().describe('Close despite an active job. Default false.')
    }),
    output: result(
      {
        notebook_id: str(),
        already_closed: bool(),
        dropped_execution_ids: arr(str()),
        kernel_left_running: bool('Always true.')
      },
      ['notebook_id', 'already_closed', 'dropped_execution_ids', 'kernel_left_running']
    ),
    readOnly: false,
    deduplicated: false
  },
  {
    name: 'notebook_read',
    title: 'Read a notebook',
    description:
      'Read the live replica: view "summary" (one row per cell with revisions and a preview), "cells" (source, metadata, attachments) or "outputs" (bounded outputs with an output_id for anything large). The snapshot and changes_cursor are taken together, so nothing can slip between them. Before readiness the current snapshot is served and marked stale. Read-only, takes no request_id — and the cheapest way to recover next_request_id after losing your counter.',
    input: z.discriminatedUnion('view', [
      z.object({
        notebook_id: notebookId,
        view: z.literal('summary'),
        cursor: z.string().optional().describe('page_cursor from a previous page. Bound to the structural revision: a structural change gives CURSOR_EXPIRED.'),
        limits
      }),
      z.object({
        notebook_id: notebookId,
        view: z.literal('cells'),
        cell_ids: z.array(z.string()).optional().describe('Explicit selection. Mutually exclusive with cursor.'),
        cursor: z.string().optional(),
        limits
      }),
      z.object({
        notebook_id: notebookId,
        view: z.literal('outputs'),
        cell_ids: z.array(z.string()).optional(),
        cursor: z.string().optional(),
        limits
      })
    ]),
    output: result(
      {
        notebook_id: str(),
        view: str('summary | cells | outputs'),
        connection_state: str(),
        stale: bool(),
        structure_revision: str(),
        changes_cursor: str(),
        summary: NOTEBOOK_SUMMARY,
        cells: arr(
          obj({
            cell_id: str(),
            index: num(),
            cell_type: str(),
            source: str(),
            source_truncated: bool(),
            source_bytes: num(),
            metadata: anyObject(),
            attachments: anyObject(),
            source_revision: str(),
            cell_revision: str(),
            outputs_revision: nullableStr(),
            execution_count: nullableNum(),
            execution_state: str(),
            duplicate_id: bool(),
            outputs: arr(OUTPUT_ENTRY),
            truncated: bool()
          })
        ),
        notebook_metadata: anyObject(),
        notebook_metadata_revision: str(),
        truncated: bool(),
        next_cursor: str()
      },
      ['notebook_id', 'view', 'connection_state', 'stale', 'structure_revision', 'changes_cursor']
    ),
    readOnly: true,
    deduplicated: false
  },
  {
    name: 'notebook_apply',
    title: 'Edit cells',
    description:
      `Apply an ordered batch of edits to the shared document. The whole batch is validated against the current replica first, then applied in one transaction, so an expected error (REVISION_CONFLICT, CELL_NOT_FOUND, MATCH_NOT_UNIQUE, …) happens before the first mutation. partial:true means an unexpected failure hit mid-batch — re-read the affected cells. ${SEQUENTIAL} applied_locally, delivery and persistence are three separate facts: only notebook_save can confirm anything on disk.`,
    input: z.object({
      notebook_id: notebookId,
      request_id: requestId,
      operations: z.array(OPERATION).min(1).describe('Non-empty, applied in order. add_cell needs exactly one anchor: before_cell_id, after_cell_id or position:"end".')
    }),
    output: result(
      {
        notebook_id: str(),
        results: arr(
          obj(
            {
              op: str(),
              cell_id: str('Target, or the id assigned to a new cell.'),
              index: num(),
              source_revision: str(),
              cell_revision: str(),
              outputs_revision: str(),
              notebook_metadata_revision: str()
            },
            ['op']
          )
        ),
        applied_locally: bool(),
        delivery: str('sent | pending | unknown'),
        persistence: str('unconfirmed | confirmed | unknown'),
        structure_revision: str(),
        changes_cursor: str(),
        partial: bool(),
        partial_at_operation: num()
      },
      ['notebook_id', 'results', 'applied_locally', 'delivery', 'persistence', 'structure_revision', 'changes_cursor']
    ),
    readOnly: false,
    deduplicated: true
  },
  {
    name: 'notebook_execute',
    title: 'Run cells',
    description:
      `Queue code cells on the notebook's bound kernel, in order, one at a time. Before each cell its outputs are cleared and execution_state is set to running; the final execution_count and idle are written when it completes. ${SEQUENTIAL} wait_ms bounds the answer only — when it elapses the job keeps running and execution_get reads the rest; nothing is interrupted and nothing is re-sent. ${NOT_A_TOOL_ERROR} Requires a bound kernel (kernel_control action:"start"), otherwise KERNEL_NOT_BOUND before any output is touched. The execution handle lives until notebook_close or connection close; output snapshots remain available until bounded-store eviction or connection close.`,
    input: z.object({
      notebook_id: notebookId,
      request_id: requestId,
      cells: z
        .array(
          z.object({
            cell_id: z.string().min(1),
            expected_source_revision: revision('source')
          })
        )
        .min(1)
        .describe('Ordered, code cells only. A non-code target is INVALID_ARGUMENT before the job is accepted. Each revision is re-checked immediately before its cell is sent; a late mismatch makes that cell and the rest not_sent.'),
      stop_on_error: z.boolean().optional().describe('Stop the queue on the first failure. Default true.'),
      wait_ms: waitMs,
      limits
    }),
    output: result(EXECUTION_VIEW, ['execution_id', 'notebook_id', 'state', 'stop_on_error', 'cells', 'created_at', 'cursor', 'wait_timed_out']),
    readOnly: false,
    deduplicated: true
  },
  {
    name: 'execution_get',
    title: 'Read a run',
    description:
      `State of a job plus the outputs after cursor; with wait_ms it waits for the next change instead of polling. Delivered output is never repeated. ${NOT_A_TOOL_ERROR} Takes no request_id.`,
    input: z.object({
      execution_id: executionId,
      cursor: z.string().optional().describe('cursor from the previous answer. Omitted, the whole current state comes back.'),
      wait_ms: waitMs,
      limits
    }),
    output: result(EXECUTION_VIEW, ['execution_id', 'notebook_id', 'state', 'stop_on_error', 'cells', 'created_at', 'cursor', 'wait_timed_out']),
    readOnly: true,
    deduplicated: false
  },
  {
    name: 'output_read',
    title: 'Read an output',
    description:
      'Read one part of an immutable output snapshot by output_id — for hosts that do not read MCP resources, and for payloads too large for one answer. Continuing with cursor never resends delivered bytes. An expired snapshot is HANDLE_EXPIRED.',
    input: z.object({
      output_id: outputId,
      cursor: z.string().optional(),
      limits
    }),
    output: result(
      {
        output_id: str(),
        uri: str(),
        output_type: str(),
        mime_types: arr(str()),
        mime_type: str('MIME type of data in this part.'),
        encoding: str('text | base64'),
        data: str(),
        byte_offset: num(),
        byte_size: num('Full size of the snapshot.'),
        truncated: bool(),
        next_cursor: str(),
        lifetime: LIFETIME
      },
      ['output_id', 'uri', 'output_type', 'mime_types', 'mime_type', 'encoding', 'data', 'byte_offset', 'byte_size', 'truncated']
    ),
    readOnly: true,
    deduplicated: false
  },
  {
    name: 'execution_cancel',
    title: 'Cancel queued cells',
    description:
      'Drop the cells of a job that have not been sent yet. Sends nothing to the kernel: a cell already handed over may be in the kernel queue and is not safely cancelled — stopping it needs kernel_control action:"interrupt", which affects the whole kernel and possibly another person\'s code. Idempotent by handle, takes no request_id.',
    input: z.object({ execution_id: executionId }),
    output: result(
      {
        execution_id: str(),
        state: str(),
        cancelled_cell_ids: arr(str(), 'Removed from the queue; now not_sent with reason cancelled.'),
        already_sent_cell_ids: arr(str(), 'Already handed to the kernel; their outcome is whatever the kernel reports.'),
        kernel_interrupted: bool('Always false.')
      },
      ['execution_id', 'state', 'cancelled_cell_ids', 'already_sent_cell_ids', 'kernel_interrupted']
    ),
    readOnly: false,
    deduplicated: false
  },
  {
    name: 'notebook_changes',
    title: 'Observe changes',
    description:
      'Journal events after cursor — cells added or deleted, source, metadata, outputs, order, kernel and connection changes — including edits made by a person in JupyterLab. Output updates arrive coalesced per cell; published sequence numbers never change. With wait_ms it waits for the next event. CURSOR_EXPIRED means the journal moved past that point: take a new snapshot with notebook_read and observe from its changes_cursor.',
    input: z.object({
      notebook_id: notebookId,
      cursor: z.string().min(1).describe('changes_cursor from an open/create/read answer or from the previous changes answer.'),
      wait_ms: waitMs,
      limit: z.number().int().positive().optional().describe('Maximum events in this answer.')
    }),
    output: result(
      {
        notebook_id: str(),
        events: arr(
          obj(
            {
              sequence: num(),
              kind: str('cell_added | cell_deleted | source_changed | metadata_changed | outputs_changed | order_changed | cell_replaced | notebook_metadata_changed | kernel_changed | connection_state'),
              cell_id: str(),
              revisions: anyObject('Only the revisions relevant to this event.'),
              origin: str('local (this client) | remote (anybody else). It does not identify a person.'),
              connection_state: str(),
              kernel_id: nullableStr()
            },
            ['sequence', 'kind', 'origin']
          )
        ),
        next_cursor: str(),
        truncated: bool(),
        connection_state: str(),
        stale: bool(),
        wait_timed_out: bool()
      },
      ['notebook_id', 'events', 'next_cursor', 'truncated', 'connection_state', 'stale', 'wait_timed_out']
    ),
    readOnly: true,
    deduplicated: false
  },
  {
    name: 'notebook_save',
    title: 'Save the notebook',
    description:
      'Ask the collaborative server to write the .ipynb and report what it said. save_status "skipped" and "timeout" are honest non-confirmations, not success; only revision_persistence:"confirmed" proves a revision reached disk. Not deduplicated: a repeat may store newer state. A server-reported failure is SAVE_FAILED; a lost connection with the save in flight is OPERATION_UNCERTAIN.',
    input: z.object({
      notebook_id: notebookId,
      timeout_ms: z.number().int().positive().optional().describe('Clamped to 30 s.')
    }),
    output: result(
      {
        notebook_id: str(),
        save_status: str('success | skipped | timeout'),
        revision_persistence: str('unconfirmed | confirmed | unknown'),
        structure_revision: str(),
        requested_at: str(),
        autosave_enabled: bool('The server may also save on its own debounce; that confirms no specific revision either.')
      },
      ['notebook_id', 'save_status', 'revision_persistence', 'structure_revision', 'requested_at', 'autosave_enabled']
    ),
    readOnly: false,
    deduplicated: false
  },
  {
    name: 'kernel_list',
    title: 'List kernels',
    description: 'Kernelspecs and running kernels of the selected server. Executes no code and starts nothing. Takes no request_id.',
    input: z.strictObject({ server_id: serverId }),
    output: result(
      {
        kernelspecs: arr(obj({ name: str(), display_name: str(), language: str() }, ['name', 'display_name', 'language'])),
        default_kernel_name: nullableStr(),
        running: arr(
          obj(
            {
              kernel_id: str(),
              kernel_name: str(),
              last_activity: nullableStr(),
              connections: nullableNum(),
              execution_status: str(),
              bound_paths: arr(str())
            },
            ['kernel_id', 'kernel_name', 'execution_status', 'bound_paths']
          )
        )
      },
      ['kernelspecs', 'default_kernel_name', 'running']
    ),
    readOnly: true,
    deduplicated: false
  },
  {
    name: 'kernel_status',
    title: 'Kernel status',
    description:
      'Binding and observed kernel status of one notebook. Never starts a kernel: an unbound notebook answers kernel_id:null. The channel state and the execution status are separate facts, and a busy caused by somebody else is reported as such. Takes no request_id.',
    input: z.object({ notebook_id: notebookId }),
    output: result(KERNEL_STATUS, ['notebook_id', 'kernel_id', 'channel_state', 'execution_status', 'observed_at', 'active_execution_ids']),
    readOnly: true,
    deduplicated: false
  },
  {
    name: 'kernel_control',
    title: 'Control the kernel',
    description:
      `Bind or act on the notebook's kernel. "start" reuses the single existing Jupyter session for this path or creates one; "interrupt", "restart" and "shutdown" act on the whole kernel and may hit another participant's code; "switch" rebinds to another kernelspec. Restart clears no outputs and re-runs no cells. Every action requires expected_kernel_id so it cannot land on a kernel you did not mean — a mismatch is KERNEL_CHANGED. ${SEQUENTIAL} A lost confirmation is OPERATION_UNCERTAIN and the effect is never re-issued.`,
    input: z.discriminatedUnion('action', [
      z.object({
        notebook_id: notebookId,
        request_id: requestId,
        action: z.literal('start'),
        expected_kernel_id: z.union([z.string().min(1), z.null()]).describe('null is the verified statement "nothing is bound".'),
        kernel_name: z.string().min(1).optional().describe('Omitted, the server default kernelspec is used.')
      }),
      z.object({
        notebook_id: notebookId,
        request_id: requestId,
        action: z.literal('interrupt'),
        expected_kernel_id: z.string().min(1)
      }),
      z.object({
        notebook_id: notebookId,
        request_id: requestId,
        action: z.literal('restart'),
        expected_kernel_id: z.string().min(1)
      }),
      z.object({
        notebook_id: notebookId,
        request_id: requestId,
        action: z.literal('shutdown'),
        expected_kernel_id: z.string().min(1)
      }),
      z.object({
        notebook_id: notebookId,
        request_id: requestId,
        action: z.literal('switch'),
        expected_kernel_id: z.union([z.string().min(1), z.null()]),
        kernel_name: z.string().min(1)
      })
    ]),
    output: result(
      {
        notebook_id: str(),
        action: str(),
        previous_kernel_id: nullableStr(),
        kernel_id: nullableStr('null after a shutdown.'),
        kernel_name: nullableStr(),
        jupyter_session_id: nullableStr(),
        effects: obj(
          {
            kernel_started: bool(),
            kernel_interrupted: bool(),
            kernel_restarted: bool(),
            kernel_shut_down: bool(),
            binding_changed: bool(),
            invalidated_execution_ids: arr(str()),
            outputs_cleared: bool('Always false.')
          },
          ['kernel_started', 'kernel_interrupted', 'kernel_restarted', 'kernel_shut_down', 'binding_changed', 'invalidated_execution_ids', 'outputs_cleared']
        ),
        status: obj(KERNEL_STATUS, ['notebook_id', 'kernel_id', 'channel_state', 'execution_status', 'observed_at'])
      },
      ['notebook_id', 'action', 'previous_kernel_id', 'kernel_id', 'effects', 'status']
    ),
    readOnly: false,
    deduplicated: true
  }
];

/** Tool specs by name. */
export const TOOL_SPECS_BY_NAME: ReadonlyMap<string, ToolSpec> = new Map(
  TOOL_SPECS.map((spec) => [spec.name, spec])
);

/** The names of the four deduplicated mutations (SPEC.md §9). */
export const DEDUPLICATED_TOOLS: readonly string[] = TOOL_SPECS.filter((s) => s.deduplicated).map((s) => s.name);
