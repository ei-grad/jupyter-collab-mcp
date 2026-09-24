/**
 * Acceptance: the whole product through the MCP protocol (SPEC.md §12).
 *
 * The system under test is the real CLI process (`tsx src/mcp/cli.ts`) with
 * `JUPYTER_URL` / `JUPYTER_TOKEN` pointing at a disposable JupyterLab on port
 * 8878, spoken to over line-delimited JSON-RPC by the official MCP client
 * pinned to protocol revision 2026-07-28. Nothing in this file imports
 * `CollabService`, `src/service` or `src/mcp/server.ts`: every fact is
 * established through `tools/call`, `tools/list`, `resources/list` and
 * `resources/read`, exactly as an agent would.
 *
 * The one exception is the second RTC client (`openRemote`), which SPEC.md
 * §12 requires: an independent writer/observer on the same room, so "the MCP
 * process sees a person's edit" is a fact about the shared document and not
 * about our own replica.
 *
 * Port 8878 belongs to this file alone.
 */

import { rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { apiFetchOk } from '../helpers/fetch.js';
import { restartStand, type Stand } from '../helpers/stand.js';
import {
  Counter,
  openRemote,
  settle,
  startMcp,
  until,
  type McpChild
} from './harness.js';

const PORT = 8878;
/** Distinctive on purpose: the credential scan must not match a common word. */
const TOKEN = `acc-tok-${Math.random().toString(36).slice(2, 10)}`;
const RUN = Date.now().toString(36);
const nb = (label: string): string => `acc-${RUN}-${label}.ipynb`;

let stand: Stand;
let mcp: McpChild;
const extraClients: McpChild[] = [];
/** Kernels started during the run; deleted in afterAll, never by the product. */
const startedKernels = new Set<string>();

function str(value: unknown): string {
  return String(value);
}
function obj(value: unknown): Record<string, unknown> {
  return (value ?? {}) as Record<string, unknown>;
}
function list(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? (value as Record<string, unknown>[]) : [];
}

beforeAll(async () => {
  // Always a fresh process: the run-specific token must be the one the
  // server actually accepts, and a reused stand would still hold the old one.
  stand = await restartStand({ port: PORT, token: TOKEN });
  mcp = await startMcp(stand);
}, 180_000);

afterAll(async () => {
  await Promise.all(extraClients.map((client) => client.close()));
  await mcp?.close();
  const target = { baseUrl: stand.baseUrl, token: stand.token };
  try {
    for (const kernelId of startedKernels) {
      await apiFetchOk(target, `/api/kernels/${kernelId}`, { method: 'DELETE' }, [204, 404]);
    }
    const listing = await apiFetchOk(target, '/api/contents/?content=1');
    for (const entry of listing.json<{ content?: Array<{ path: string }> }>().content ?? []) {
      if (!entry.path.startsWith(`acc-${RUN}-`) && !entry.path.startsWith('Untitled')) continue;
      await apiFetchOk(target, `/api/contents/${entry.path}`, { method: 'DELETE' }, [204, 404]);
    }
  } catch {
    // Cleaning the stand is best effort; the run itself already reported.
  }
  await stand.stop();
}, 120_000);

// ---------------------------------------------------------------------------
// state shared by the ordered scenarios below
// ---------------------------------------------------------------------------

interface Context {
  readonly client: McpChild;
  readonly counter: Counter;
}

let main: Context;
let docPath: string;
let docId: string;
let docCursor: string;

async function openContext(client?: McpChild): Promise<Context> {
  if (client === undefined) {
    client = await startMcp(stand);
    extraClients.push(client);
  }
  const answer = await client.call('server_list');
  const counter = new Counter();
  counter.take(answer);
  return { client, counter };
}

// ---------------------------------------------------------------------------

describe('protocol surface', () => {
  it('initialize pins 2026-07-28 and tools/list publishes all 18 tools with schemas', async () => {
    // `client.connect` already completed the pinned handshake in beforeAll.
    expect(mcp.client.getServerVersion()?.name).toBe('jupyter-collab-mcp');
    expect(mcp.client.getServerCapabilities()?.tools).toBeDefined();
    expect(mcp.client.getServerCapabilities()?.resources).toBeDefined();

    const tools = (await mcp.client.listTools()).tools;
    expect(tools).toHaveLength(18);
    expect(tools.map((tool) => tool.name).sort()).toEqual(
      [
        'execution_cancel',
        'execution_get',
        'kernel_control',
        'kernel_list',
        'kernel_status',
        'notebook_apply',
        'notebook_changes',
        'notebook_close',
        'notebook_create',
        'notebook_execute',
        'notebook_list',
        'notebook_open',
        'notebook_read',
        'notebook_save',
        'output_read',
        'server_list', 'server_status', 'server_start'
      ].sort()
    );
    for (const tool of tools) {
      expect(tool.inputSchema, `${tool.name} inputSchema`).toBeDefined();
      expect(tool.inputSchema.type, tool.name).toBe('object');
      expect(tool.inputSchema.properties, tool.name).toBeDefined();
      for (const keyword of ['oneOf', 'anyOf', 'allOf']) {
        expect(tool.inputSchema, tool.name).not.toHaveProperty(keyword);
      }
      expect(tool.outputSchema, `${tool.name} outputSchema`).toBeDefined();
      expect(String(tool.description ?? '').length).toBeGreaterThan(40);
    }
    // Every deduplicated mutation takes a request_id.
    const takesRequestId = (schema: unknown): boolean => {
      const node = obj(schema);
      return 'request_id' in obj(node['properties']);
    };
    const withRequestId = tools
      .filter((tool) => takesRequestId(tool.inputSchema))
      .map((tool) => tool.name)
      .sort();
    expect(withRequestId).toEqual(['kernel_control', 'notebook_apply', 'notebook_create', 'notebook_execute', 'server_start']);
  });

  it('server_list shows the configured stand and no credential', async () => {
    const answer = await mcp.call('server_list');
    const servers = list(answer['servers']);
    expect(servers).toHaveLength(1);
    expect(obj(servers[0]?.['descriptor'])['id']).toBe('default');
    expect(servers[0]?.['default_choice']).toBe(true);
    expect(answer['selection_required']).toBe(false);
    expect(JSON.stringify(answer)).not.toContain(TOKEN);
  });

  it('the implicit context exposes next_request_id without starting a kernel', async () => {
    main = await openContext(mcp);
    expect(main.counter.value).toBe('1');
    const kernels = await mcp.call('kernel_list', {});
    expect(list(kernels['kernelspecs']).length).toBeGreaterThan(0);
  });
});

describe('Create name (SPEC §12)', () => {
  it('creates an untitled notebook, a named one, and keeps the untitled file on ALREADY_EXISTS', async () => {
    // -- no name: the server-chosen untitled name is kept -------------------
    const untitled = await mcp.call('notebook_create', {
      request_id: main.counter.value,
      directory: ''
    });
    main.counter.take(untitled);
    expect(untitled['renamed']).toBe(false);
    expect(str(obj(untitled['notebook'])['path'])).toMatch(/^Untitled/u);
    expect(untitled['request_accepted']).toBe(true);
    await mcp.call('notebook_close', { notebook_id: obj(untitled['notebook'])['notebook_id'] });

    // -- with a name: newUntitled -> Contents PATCH -> room ------------------
    docPath = nb('doc');
    const created = await mcp.call('notebook_create', {
      request_id: main.counter.value,
      directory: '',
      name: docPath
    });
    main.counter.take(created);
    expect(created['renamed']).toBe(true);
    expect(str(created['untitled_path'])).toMatch(/^Untitled/u);
    const handle = obj(created['notebook']);
    expect(handle['path']).toBe(docPath);
    expect(handle['connection_state']).toBe('ready');
    expect(obj(created['summary'])['nbformat']).toBe(4);
    docId = str(handle['notebook_id']);
    docCursor = str(created['changes_cursor']);

    // -- the same name again: ALREADY_EXISTS, untitled file stays -----------
    const error = await mcp.fail('notebook_create', {
      request_id: main.counter.value,
      directory: '',
      name: docPath
    });
    expect(error.code).toBe('ALREADY_EXISTS');
    expect(error.side_effects).toBe('applied');
    expect(error.request_accepted).toBe(true);
    const details = obj(error.details);
    expect(str(details['untitled_path'])).toMatch(/^Untitled/u);
    expect(details['room_opened']).toBe(false);
    main.counter.take(error as unknown as Record<string, unknown>);

    const stat = await apiFetchOk(
      { baseUrl: stand.baseUrl, token: stand.token },
      `/api/contents/${str(details['untitled_path'])}?content=0`
    );
    expect(stat.status).toBe(200);
  }, 120_000);

  it('removes the pristine server placeholder from a fresh notebook', async () => {
    const created = await mcp.call('notebook_create', {
      request_id: main.counter.value,
      directory: '',
      name: nb('placeholder')
    });
    main.counter.take(created);
    expect(obj(created['summary'])['cell_count']).toBe(0);
  });
});

describe('Reopening / Separate conversations (SPEC §12)', () => {
  it('reopening reuses a handle while an independent client gets its own', async () => {
    const first = await mcp.call('notebook_open', { path: docPath });
    expect(obj(first['notebook'])['notebook_id']).toBe(docId);
    expect(first['reused']).toBe(true);

    // Concurrent opens coalesce onto the one replica.
    const [a, b] = await Promise.all([
      mcp.call('notebook_open', { path: docPath }),
      mcp.call('notebook_open', { path: docPath })
    ]);
    expect(obj(a['notebook'])['notebook_id']).toBe(docId);
    expect(obj(b['notebook'])['notebook_id']).toBe(docId);

    // An independent MCP client owns a different replica of the same file.
    const other = await openContext();
    const mirror = await other.client.call('notebook_open', { path: docPath });
    const mirrorHandle = obj(mirror['notebook']);
    expect(mirrorHandle['notebook_id']).not.toBe(docId);
    expect(mirrorHandle['file_id']).toBe(obj(first['notebook'])['file_id']);
    expect(mirror['next_request_id']).toBe('1');
    await other.client.close();
  }, 60_000);
});

describe('Tool coverage / Concurrent edits (SPEC §12)', () => {
  let codeCellRef: string;

  it('applies add / replace_text / replace_source / metadata / delete and refuses a stale revision', async () => {
    const added = await mcp.call('notebook_apply', {
      notebook_id: docId,
      request_id: main.counter.value,
      operations: [
        { op: 'add_cell', cell_type: 'code', source: 'print("one")', position: 'end' },
        { op: 'add_cell', cell_type: 'markdown', source: '# heading', position: 'end' },
        { op: 'add_cell', cell_type: 'code', source: 'x = 1', position: 'end' }
      ]
    });
    main.counter.take(added);
    expect(added['applied_locally']).toBe(true);
    expect(added['delivery']).toBe('sent');
    expect(added['persistence']).toBe('unconfirmed');
    const results = list(added['results']);
    expect(results).toHaveLength(3);
    expect(results.every((entry) => !('cell_id' in entry) && !('source_revision' in entry) && !('cell_revision' in entry))).toBe(true);
    codeCellRef = str(results[0]?.['cell_ref']);
    // Kept on purpose: after the next edit this is a known stale observation,
    // which is the shape SPEC §12 "Concurrent edits" asks about.
    const staleRef = codeCellRef;
    const doomedRef = str(results[2]?.['cell_ref']);

    // -- replace_text with the right revision -------------------------------
    const replaced = await mcp.call('notebook_apply', {
      notebook_id: docId,
      request_id: main.counter.value,
      operations: [
        {
          op: 'replace_text',
          cell_ref: codeCellRef,
          old_text: 'one',
          new_text: 'two'
        }
      ]
    });
    main.counter.take(replaced);
    codeCellRef = str(list(replaced['results'])[0]?.['cell_ref']);

    // -- a stale revision changes nothing (no distributed CAS promised) -----
    const conflict = await mcp.fail('notebook_apply', {
      notebook_id: docId,
      request_id: main.counter.value,
      operations: [
        {
          op: 'replace_source',
          cell_ref: staleRef,
          source: 'print("clobbered")'
        }
      ]
    });
    expect(conflict.code).toBe('REVISION_CONFLICT');
    expect(conflict.side_effects).toBe('none');
    // Rejected before acceptance: the number was not consumed.
    expect(conflict.request_accepted).toBe(false);
    expect(conflict.current_cell_ref).toMatch(/^@/u);
    const stillThere = await mcp.call('notebook_read', {
      notebook_id: docId,
      view: 'cells',
      cell_refs: [codeCellRef]
    });
    expect(stillThere['notebook_ref']).toMatch(/^@/u);
    expect(list(stillThere['cells'])[0]?.['source']).toBe('print("two")');

    // -- replace_source, metadata and delete in one batch --------------------
    const refreshedCellRef = str(list(stillThere['cells'])[0]?.['cell_ref']);
    expect(refreshedCellRef).toBe(conflict.current_cell_ref);
    const notebookRef = str(stillThere['notebook_ref']);
    const batch = await mcp.call('notebook_apply', {
      notebook_id: docId,
      request_id: main.counter.value,
      operations: [
        {
          op: 'set_cell_metadata',
          cell_ref: refreshedCellRef,
          key: 'acceptance',
          value: { run: RUN }
        },
        {
          op: 'replace_source',
          cell_ref: refreshedCellRef,
          source: 'print("hello from the kernel")'
        },
        {
          op: 'set_notebook_metadata',
          notebook_ref: notebookRef,
          key: 'acceptance_run',
          value: RUN
        },
        { op: 'delete_cell', cell_ref: doomedRef }
      ]
    });
    main.counter.take(batch);
    expect(list(batch['results'])).toHaveLength(4);
    const batchResults = list(batch['results']);
    expect(batchResults[0]?.['cell_ref']).toBe(batchResults[1]?.['cell_ref']);
    expect(batchResults[2]?.['notebook_ref']).toBeTypeOf('string');
    expect(batchResults[3]).not.toHaveProperty('cell_ref');
    codeCellRef = str(batchResults[1]?.['cell_ref']);

    const after = await mcp.call('notebook_read', {
      notebook_id: docId,
      view: 'cells',
      cell_refs: [codeCellRef]
    });
    const cell = list(after['cells'])[0];
    expect(cell?.['source']).toBe('print("hello from the kernel")');
    // Unknown/user metadata survives the round trip verbatim (SPEC §12).
    expect(obj(cell?.['metadata'])['acceptance']).toEqual({ run: RUN });
    expect(obj(after['notebook_metadata'])['acceptance_run']).toBe(RUN);
    // The deleted cell is gone.
    const gone = await mcp.fail('notebook_read', {
      notebook_id: docId,
      view: 'cells',
      cell_refs: [doomedRef]
    });
    expect(gone.code).toBe('CELL_NOT_FOUND');
  }, 120_000);

  it('summary / cells / outputs views page, and a structural change expires the page cursor', async () => {
    const page = await mcp.call('notebook_read', {
      notebook_id: docId,
      view: 'summary',
      limits: { max_cells: 1 }
    });
    const summary = obj(page['summary']);
    expect(list(summary['cells'])).toHaveLength(1);
    expect(summary['truncated']).toBe(true);
    expect(Number(summary['cell_count'])).toBeGreaterThanOrEqual(2);
    const cursor = str(page['next_cursor']);
    expect(cursor.length).toBeGreaterThan(0);

    const second = await mcp.call('notebook_read', {
      notebook_id: docId,
      view: 'summary',
      cursor,
      limits: { max_cells: 1 }
    });
    const secondCells = list(obj(second['summary'])['cells']);
    expect(secondCells).toHaveLength(1);
    expect(secondCells[0]?.['cell_ref']).not.toBe(list(summary['cells'])[0]?.['cell_ref']);

    // The outputs view answers for every cell, with nothing run yet.
    const outputs = await mcp.call('notebook_read', { notebook_id: docId, view: 'outputs' });
    expect(list(outputs['cells']).length).toBeGreaterThan(0);
    expect(list(outputs['cells']).every((entry) => list(entry['outputs']).length === 0)).toBe(true);

    // A structural change invalidates the page cursor (SPEC §9).
    const structural = await mcp.call('notebook_apply', {
      notebook_id: docId,
      request_id: main.counter.value,
      operations: [{ op: 'add_cell', cell_type: 'raw', source: 'structural', position: 'end' }]
    });
    main.counter.take(structural);
    const expired = await mcp.fail('notebook_read', {
      notebook_id: docId,
      view: 'summary',
      cursor,
      limits: { max_cells: 1 }
    });
    expect(expired.code).toBe('CURSOR_EXPIRED');
  }, 120_000);

  it('continues a large source through the live RTC document before later cells', async () => {
    const source = `${'\\'.repeat(100_000)}\"\u0000\u0001\t\r\n${`界🙂-${RUN}\n`.repeat(2_000)}`;
    const added = await mcp.call('notebook_apply', {
      notebook_id: docId,
      request_id: main.counter.value,
      operations: [{ op: 'add_cell', cell_type: 'code', source, position: 'end' }]
    });
    main.counter.take(added);
    const cellRef = str(list(added['results'])[0]?.['cell_ref']);

    const chunks: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await mcp.call('notebook_read', {
        notebook_id: docId,
        view: 'cells',
        ...(cursor === undefined ? { cell_refs: [cellRef] } : { cursor }),
        limits: { max_bytes: 16_384 }
      });
      chunks.push(...list(page['cells'])
        .filter((cell) => cell['cell_ref'] !== undefined)
        .map((cell) => str(cell['source'])));
      cursor = page['next_cursor'] as string | undefined;
    } while (cursor !== undefined);
    expect(chunks.join('')).toBe(source);
  }, 120_000);

  it('exposes the code cell the execution scenarios use', () => {
    expect(codeCellRef).toBeTypeOf('string');
    executionTarget = { cellRef: codeCellRef };
  });
});

let executionTarget: { cellRef: string };

describe('Retries / Replay and call ordering (SPEC §12)', () => {
  it('replays the same id+payload, conflicts on a different payload and rejects a skipped number', async () => {
    const requestId = main.counter.value;
    const payload = {
      notebook_id: docId,
      request_id: requestId,
      operations: [{ op: 'add_cell', cell_type: 'code', source: 'print("replay probe")', position: 'end' }]
    };

    const before = obj(await mcp.call('notebook_read', { notebook_id: docId, view: 'summary' }));
    const countBefore = Number(obj(before['summary'])['cell_count']);

    const first = await mcp.call('notebook_apply', payload);
    expect(first['replayed']).not.toBe(true);
    expect(first['request_accepted']).toBe(true);
    const firstAcceptedAt = first['first_accepted_at'];
    const newCellRef = str(list(first['results'])[0]?.['cell_ref']);

    // -- the same number with the same payload replays the stored receipt ---
    const replay = await mcp.call('notebook_apply', payload);
    expect(replay['replayed']).toBe(true);
    expect(replay['first_accepted_at']).toBe(firstAcceptedAt);
    expect(str(list(replay['results'])[0]?.['cell_ref'])).toBe(newCellRef);
    expect(replay['next_request_id']).toBe(first['next_request_id']);

    const after = obj(await mcp.call('notebook_read', { notebook_id: docId, view: 'summary' }));
    // Exactly one cell was created by the two calls.
    expect(Number(obj(after['summary'])['cell_count'])).toBe(countBefore + 1);

    // -- the same number with a different payload is a conflict -------------
    const conflict = await mcp.fail('notebook_apply', {
      notebook_id: docId,
      request_id: requestId,
      operations: [{ op: 'add_cell', cell_type: 'code', source: 'print("other payload")', position: 'end' }]
    });
    expect(conflict.code).toBe('REQUEST_ID_CONFLICT');
    expect(conflict.side_effects).toBe('none');
    // Even a rejection reports the current counter (SPEC §9).
    expect(conflict.next_request_id).toBe(first['next_request_id']);

    main.counter.take(first);

    // -- a skipped number is refused without an effect ----------------------
    const skipped = String(Number(main.counter.value) + 1);
    const outOfOrder = await mcp.fail('notebook_apply', {
      notebook_id: docId,
      request_id: skipped,
      operations: [{ op: 'add_cell', cell_type: 'code', source: 'print("skipped")', position: 'end' }]
    });
    expect(outOfOrder.code).toBe('REQUEST_OUT_OF_ORDER');
    expect(outOfOrder.next_request_id).toBe(main.counter.value);

    // -- a read-only call recovers the counter after losing it (SPEC §12) ---
    const recovered = await mcp.call('notebook_read', { notebook_id: docId, view: 'summary' });
    expect(recovered['next_request_id']).toBe(main.counter.value);
    expect(recovered['request_accepted']).toBeUndefined();

    // -- the same operation under a fresh number runs once more -------------
    const again = await mcp.call('notebook_apply', {
      notebook_id: docId,
      request_id: main.counter.value,
      operations: [{ op: 'add_cell', cell_type: 'code', source: 'print("replay probe")', position: 'end' }]
    });
    main.counter.take(again);
    expect(again['replayed']).not.toBe(true);
    expect(str(list(again['results'])[0]?.['cell_ref'])).not.toBe(newCellRef);

    // Clean the probes up so the later reads stay small.
    const summaryNow = obj(
      obj(await mcp.call('notebook_read', { notebook_id: docId, view: 'summary' }))['summary']
    );
    const probes = list(summaryNow['cells']).filter((entry) =>
      str(entry['preview']).includes('replay probe')
    );
    if (probes.length > 0) {
      const cleanup = await mcp.call('notebook_apply', {
        notebook_id: docId,
        request_id: main.counter.value,
        operations: probes.map((entry) => ({
          op: 'delete_cell',
          cell_ref: entry['cell_ref']
        }))
      });
      main.counter.take(cleanup);
    }
  }, 120_000);
});

describe('Retries: observed-ref operations', () => {
  it('resending an identical observed-ref apply replays instead of conflicting', async () => {
    const session = await openContext();
    const mcp = session.client;
    const created = await mcp.call('notebook_create', {
      request_id: session.counter.value,
      directory: '',
      name: nb('replay-defect')
    });
    session.counter.take(created);
    const notebookId = str(obj(created['notebook'])['notebook_id']);
    const added = await mcp.call('notebook_apply', {
      notebook_id: notebookId,
      request_id: session.counter.value,
      operations: [{ op: 'add_cell', cell_type: 'raw', source: 'delete me', position: 'end' }]
    });
    session.counter.take(added);
    const target = obj(list(added['results'])[0]);
    const payload = {
      notebook_id: notebookId,
      request_id: session.counter.value,
      operations: [
        {
          op: 'delete_cell',
          cell_ref: str(target['cell_ref'])
        }
      ]
    };
    const deleted = await mcp.call('notebook_apply', payload);
    session.counter.take(deleted);
    const intervening = await mcp.call('notebook_apply', {
      notebook_id: notebookId,
      request_id: session.counter.value,
      operations: [{ op: 'add_cell', cell_type: 'raw', source: 'later edit', position: 'end' }]
    });
    session.counter.take(intervening);
    try {
      // The agent lost the answer and resends the same accepted request after
      // deletion and a later live edit. Receipt replay precedes ref validation.
      const replay = await mcp.call('notebook_apply', payload);
      expect(replay['replayed']).toBe(true);
      expect(replay['next_request_id']).toBe(session.counter.value);
    } finally {
      await mcp.close();
    }
  }, 120_000);
});

describe('Bidirectional RTC / Cursors (SPEC §12)', () => {
  it('notebook_changes from the open cursor sees our own edits and a second client\'s', async () => {
    const remote = await openRemote(stand, docPath);
    try {
      // Our own edits since the create cursor are already journalled.
      const own = await mcp.call('notebook_changes', { notebook_id: docId, cursor: docCursor });
      const ownEvents = list(own['events']);
      expect(ownEvents.length).toBeGreaterThan(0);
      expect(ownEvents.some((event) => event['kind'] === 'cell_added')).toBe(true);
      expect(ownEvents.every((event) => event['origin'] === 'local')).toBe(true);
      // Published sequence numbers never change.
      const sequences = ownEvents.map((event) => Number(event['sequence']));
      expect([...sequences].sort((a, b) => a - b)).toEqual(sequences);
      const cursor = str(own['next_cursor']);

      // Nothing new: the long poll times out and delivers nothing twice.
      const quiet = await mcp.call('notebook_changes', { notebook_id: docId, cursor, wait_ms: 300 });
      expect(list(quiet['events'])).toHaveLength(0);
      expect(quiet['wait_timed_out']).toBe(true);
      expect(quiet['next_cursor']).toBe(cursor);

      // A person types in JupyterLab: an independent client writes the doc.
      const waiting = mcp.call('notebook_changes', { notebook_id: docId, cursor, wait_ms: 15_000 });
      await new Promise((r) => setTimeout(r, 200));
      remote.notebook.addCell({ cell_type: 'markdown', source: 'written by a person' });

      const seen = await waiting;
      const remoteEvents = list(seen['events']);
      expect(remoteEvents.length).toBeGreaterThan(0);
      expect(remoteEvents.some((event) => event['origin'] === 'remote')).toBe(true);
      expect(remoteEvents.some((event) => event['kind'] === 'cell_added')).toBe(true);

      // And the replica really carries the person's cell.
      const summary = obj(
        obj(await mcp.call('notebook_read', { notebook_id: docId, view: 'summary' }))['summary']
      );
      expect(list(summary['cells']).some((cell) => str(cell['preview']).includes('written by a person'))).toBe(
        true
      );

      // The other direction: our edit reaches the independent client.
      const applied = await mcp.call('notebook_apply', {
        notebook_id: docId,
        request_id: main.counter.value,
        operations: [{ op: 'add_cell', cell_type: 'markdown', source: 'written by the agent', position: 'end' }]
      });
      main.counter.take(applied);
      await until('the second client sees our cell', () => {
        for (let index = 0; index < remote.notebook.cells.length; index += 1) {
          if (remote.notebook.getCell(index).getSource().includes('written by the agent')) return true;
        }
        return false;
      });
    } finally {
      remote.dispose();
    }
  }, 120_000);

  it('a changes cursor the journal moved past is CURSOR_EXPIRED, not silently skipped', async () => {
    // The journal ring is a configured limit (§9 default 10 000), so this
    // needs its own process with a tiny one - which also exercises --config.
    const configPath = join(tmpdir(), `jcm-acceptance-${RUN}.json`);
    writeFileSync(configPath, JSON.stringify({ limits: { journalMaxEvents: 4 } }));
    const small = await startMcp(stand, {}, ['--config', configPath]);
    try {
      const opened = await small.call('notebook_open', { path: docPath });
      const notebookId = str(obj(opened['notebook'])['notebook_id']);
      const cursor = str(opened['changes_cursor']);
      let requestId = str(opened['next_request_id']);

      // Push more events through the ring than it can hold.
      for (let index = 0; index < 8; index += 1) {
        const applied = await small.call('notebook_apply', {
          notebook_id: notebookId,
          request_id: requestId,
          operations: [
            { op: 'add_cell', cell_type: 'raw', source: `ring ${String(index)}`, position: 'end' }
          ]
        });
        requestId = str(applied['next_request_id']);
      }

      const expired = await small.fail('notebook_changes', { notebook_id: notebookId, cursor });
      expect(expired.code).toBe('CURSOR_EXPIRED');
      // The answer says how to recover: take a fresh snapshot.
      const fresh = await small.call('notebook_read', { notebook_id: notebookId, view: 'summary' });
      const resumed = await small.call('notebook_changes', {
        notebook_id: notebookId,
        cursor: str(fresh['changes_cursor'])
      });
      expect(list(resumed['events'])).toHaveLength(0);
    } finally {
      await small.close();
      rmSync(configPath, { force: true });
    }
  }, 120_000);
});

describe('External kernel / Outputs / Limits (SPEC §12)', () => {
  let kernelId: string;
  let executionId: string;
  let snapshotOutputId: string;
  let snapshotUri: string;
  let snapshotBytes: number;

  it('kernel_status before binding is an answer, and executing without a kernel is KERNEL_NOT_BOUND', async () => {
    const status = await mcp.call('kernel_status', { notebook_id: docId });
    expect(status['kernel_id']).toBeNull();
    expect(list(status['active_execution_ids'])).toHaveLength(0);

    const before = await mcp.call('notebook_read', {
      notebook_id: docId,
      view: 'outputs',
      cell_refs: [executionTarget.cellRef]
    });
    const outputsBefore = list(list(before['cells'])[0]?.['outputs']);

    const error = await mcp.fail('notebook_execute', {
      notebook_id: docId,
      request_id: main.counter.value,
      cells: [
        { cell_ref: executionTarget.cellRef }
      ]
    });
    expect(error.code).toBe('KERNEL_NOT_BOUND');
    expect(error.side_effects).toBe('none');
    expect(error.request_accepted).toBe(false);

    // Nothing was cleared: the failure happened before any output was touched.
    const after = await mcp.call('notebook_read', {
      notebook_id: docId,
      view: 'outputs',
      cell_refs: [executionTarget.cellRef]
    });
    expect(list(list(after['cells'])[0]?.['outputs'])).toHaveLength(outputsBefore.length);
    const cellAfter = list(after['cells'])[0];
    expect(cellAfter?.['execution_count']).toBeNull();
  }, 60_000);

  it('kernel_control start binds a kernel', async () => {
    const payload = {
      notebook_id: docId,
      request_id: main.counter.value,
      action: 'start',
      expected_kernel_id: null,
      kernel_name: 'python3'
    };
    const started = await mcp.call('kernel_control', payload);
    const replay = await mcp.call('kernel_control', payload);
    expect(replay['replayed']).toBe(true);
    expect(replay['kernel_id']).toBe(started['kernel_id']);
    main.counter.take(started);
    const effects = obj(started['effects']);
    expect(effects['kernel_started']).toBe(true);
    expect(effects['outputs_cleared']).toBe(false);
    kernelId = str(started['kernel_id']);
    startedKernels.add(kernelId);

    // An action aimed at a kernel that is not bound is refused, unspent.
    const wrong = await mcp.fail('kernel_control', {
      notebook_id: docId,
      request_id: main.counter.value,
      action: 'interrupt',
      expected_kernel_id: 'not-this-kernel'
    });
    expect(wrong.code).toBe('KERNEL_CHANGED');
    expect(wrong.next_request_id).toBe(main.counter.value);

    const status = await mcp.call('kernel_status', { notebook_id: docId });
    expect(status['kernel_id']).toBe(kernelId);
    // The websocket to the kernel is opened lazily; it is connected by the
    // time the first run finishes (asserted in the execution scenario).
    expect(['connecting', 'connected']).toContain(str(status['channel_state']));
  }, 60_000);

  it('replays switch and shutdown after each action changes the binding', async () => {
    const session = await openContext();
    const mcp = session.client;
    const created = await mcp.call('notebook_create', {
      request_id: session.counter.value,
      directory: '',
      name: nb('kernel-replay')
    });
    session.counter.take(created);
    const notebookId = str(obj(created['notebook'])['notebook_id']);
    const started = await mcp.call('kernel_control', {
      notebook_id: notebookId,
      request_id: session.counter.value,
      action: 'start',
      expected_kernel_id: null,
      kernel_name: 'python3'
    });
    session.counter.take(started);
    startedKernels.add(str(started['kernel_id']));

    const switchPayload = {
      notebook_id: notebookId,
      request_id: session.counter.value,
      action: 'switch',
      expected_kernel_id: started['kernel_id'],
      kernel_name: 'python3'
    };
    const switched = await mcp.call('kernel_control', switchPayload);
    const switchReplay = await mcp.call('kernel_control', switchPayload);
    expect(switchReplay['replayed']).toBe(true);
    expect(switchReplay['kernel_id']).toBe(switched['kernel_id']);
    session.counter.take(switched);
    startedKernels.add(str(switched['kernel_id']));

    const shutdownPayload = {
      notebook_id: notebookId,
      request_id: session.counter.value,
      action: 'shutdown',
      expected_kernel_id: switched['kernel_id']
    };
    const stopped = await mcp.call('kernel_control', shutdownPayload);
    const shutdownReplay = await mcp.call('kernel_control', { ...shutdownPayload, kernel_name: 'ignored' });
    expect(stopped['kernel_id']).toBeNull();
    expect(shutdownReplay['replayed']).toBe(true);
    expect(shutdownReplay['kernel_id']).toBeNull();
    await mcp.close();
  }, 120_000);

  it('persists the selected kernelspec in notebook metadata', async () => {
    const live = await mcp.call('notebook_read', { notebook_id: docId, view: 'cells' });
    expect(obj(obj(live['notebook_metadata'])['kernelspec'])['name']).toBe('python3');

    const saved = await mcp.call('notebook_save', { notebook_id: docId, timeout_ms: 20_000 });
    expect(saved['save_status']).toBe('success');
    const stored = await apiFetchOk(
      { baseUrl: stand.baseUrl, token: stand.token },
      `/api/contents/${docPath}?content=1`
    );
    const content = obj(stored.json<{ content?: unknown }>().content);
    expect(obj(obj(content['metadata'])['kernelspec'])['name']).toBe('python3');
  }, 60_000);

  it('runs a printing + PNG cell, waits for succeeded and delivers the image out of band', async () => {
    const png = [
      'import base64',
      'from IPython.display import display, Image',
      'print("hello from the kernel")',
      'png = base64.b64decode(',
      '    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAA"',
      '    "DUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="',
      ')',
      'display(Image(data=png, format="png"))'
    ].join('\n');
    const rewrite = await mcp.call('notebook_apply', {
      notebook_id: docId,
      request_id: main.counter.value,
      operations: [
        {
          op: 'replace_source',
          cell_ref: executionTarget.cellRef,
          source: png
        }
      ]
    });
    main.counter.take(rewrite);
    executionTarget.cellRef = str(list(rewrite['results'])[0]?.['cell_ref']);

    const job = await mcp.call('notebook_execute', {
      notebook_id: docId,
      request_id: main.counter.value,
      cells: [{ cell_ref: executionTarget.cellRef }],
      wait_ms: 500
    });
    main.counter.take(job);
    expect(job['request_accepted']).toBe(true);
    expect(job['kernel_id']).toBe(kernelId);
    executionId = str(job['execution_id']);

    const finished = await settle(mcp, executionId);
    expect(finished['state']).toBe('succeeded');
    expect(list(finished['cells'])[0]?.['state']).toBe('succeeded');
    const finishedRef = str(list(finished['cells'])[0]?.['cell_ref']);
    expect(finishedRef).toMatch(/^@/u);
    expect(finishedRef).not.toBe(executionTarget.cellRef);
    executionTarget.cellRef = finishedRef;

    const afterRun = await mcp.call('kernel_status', { notebook_id: docId });
    expect(afterRun['channel_state']).toBe('connected');
    expect(afterRun['execution_status']).toBe('idle');
    expect(list(afterRun['active_execution_ids'])).toHaveLength(0);

    // The shared document carries the terminal count and idle (SPEC §8).
    const read = await mcp.call('notebook_read', {
      notebook_id: docId,
      view: 'outputs',
      cell_refs: [executionTarget.cellRef],
      limits: { max_bytes: 60_000, max_output_bytes: 40_000 }
    });
    const cell = list(read['cells'])[0];
    expect(cell?.['execution_count']).toBe(1);
    expect(cell?.['execution_state']).toBe('idle');
    const outputs = list(cell?.['outputs']);
    expect(outputs.length).toBeGreaterThanOrEqual(2);
    expect(
      outputs.some((entry) => str(obj(entry['output'])['output_type']) === 'stream')
    ).toBe(true);

    // The PNG never comes back as base64 inside structuredContent: it is
    // either MCP image content or an output_id (SPEC §9 "Limits").
    const answer = await mcp.raw('execution_get', {
      execution_id: executionId,
      limits: { max_output_bytes: 64 }
    });
    const payload = obj(answer.structuredContent);
    const entries = list(list(payload['cells'])[0]?.['outputs']);
    const snapshotEntry = entries.find((entry) => obj(entry['snapshot'])['output_id'] !== undefined);
    expect(snapshotEntry, 'a large output keeps only an output_id').toBeDefined();
    const snapshot = obj(snapshotEntry?.['snapshot']);
    snapshotOutputId = str(snapshot['output_id']);
    snapshotUri = str(snapshot['uri']);
    snapshotBytes = Number(snapshot['byte_size']);
    expect(snapshotUri).not.toContain(TOKEN);
    expect(JSON.stringify(payload)).not.toContain('iVBORw0KGgoAAAANSUhEUg');
    // …and the answer points at the snapshot as a resource_link.
    expect(answer.content.some((block) => block.type === 'resource_link' && block.uri === snapshotUri)).toBe(
      true
    );
  }, 180_000);

  it('output_read pages the PNG snapshot without ever resending a byte', async () => {
    const first = await mcp.call('output_read', {
      output_id: snapshotOutputId,
      limits: { max_bytes: 8 }
    });
    expect(first['byte_offset']).toBe(0);
    expect(first['byte_size']).toBe(snapshotBytes);
    expect(first['truncated']).toBe(true);
    let assembled = Buffer.from(
      str(first['data']),
      first['encoding'] === 'base64' ? 'base64' : 'utf8'
    );
    let cursor = first['next_cursor'] as string | undefined;
    let pages = 1;
    while (cursor !== undefined) {
      const next = await mcp.call('output_read', {
        output_id: snapshotOutputId,
        cursor,
        limits: { max_bytes: 8 }
      });
      expect(next['byte_offset']).toBe(assembled.byteLength);
      assembled = Buffer.concat([
        assembled,
        Buffer.from(str(next['data']), next['encoding'] === 'base64' ? 'base64' : 'utf8')
      ]);
      cursor = next['next_cursor'] as string | undefined;
      pages += 1;
    }
    expect(pages).toBeGreaterThan(1);
    expect(assembled.byteLength).toBe(snapshotBytes);
  }, 60_000);

  it('serves the same snapshot through resources/list and resources/read', async () => {
    const listed = await mcp.client.listResources();
    expect(listed.resources.some((entry) => entry.uri === snapshotUri)).toBe(true);

    const read = await mcp.client.readResource({ uri: snapshotUri });
    const contents = read.contents[0] as { uri: string; mimeType?: string; blob?: string; text?: string };
    expect(contents.uri).toBe(snapshotUri);
    const bytes =
      contents.blob !== undefined
        ? Buffer.from(contents.blob, 'base64')
        : Buffer.from(String(contents.text ?? ''), 'utf8');
    expect(bytes.byteLength).toBe(snapshotBytes);
  }, 60_000);

  it('execution_get with the job cursor delivers nothing twice', async () => {
    const whole = await mcp.call('execution_get', { execution_id: executionId });
    const again = await mcp.call('execution_get', {
      execution_id: executionId,
      cursor: str(whole['cursor'])
    });
    expect(list(list(again['cells'])[0]?.['outputs'])).toHaveLength(0);
  }, 60_000);

  it('notebook_save reports success and the file on disk carries the run', async () => {
    const saved = await mcp.call('notebook_save', { notebook_id: docId, timeout_ms: 20_000 });
    expect(saved['save_status']).toBe('success');
    expect(saved['revision_persistence']).toBe('confirmed');
    expect(saved['persistence_confirmation']).toMatchObject({ method: 'contents-api-readback' });
    expect(saved['autosave_enabled']).toBe(true);

    const file = await apiFetchOk(
      { baseUrl: stand.baseUrl, token: stand.token },
      `/api/contents/${docPath}?content=1`
    );
    const body = file.json<{ content: { cells: Array<Record<string, unknown>> } }>();
    const text = JSON.stringify(body.content);
    expect(text).toContain('hello from the kernel');
    expect(text).toContain('written by a person');
  }, 60_000);
});

describe('Interruption and cancellation (SPEC §12)', () => {
  it('cancels queued cells, refuses to close while the job is active and interrupts the running one', async () => {
    const session = await openContext();
    const mcp = session.client;
    const created = await mcp.call('notebook_create', {
      request_id: session.counter.value,
      directory: '',
      name: nb('interrupt')
    });
    session.counter.take(created);
    const notebookId = str(obj(created['notebook'])['notebook_id']);

    const applied = await mcp.call('notebook_apply', {
      notebook_id: notebookId,
      request_id: session.counter.value,
      operations: [
        {
          op: 'add_cell',
          cell_type: 'code',
          // The marker makes the interrupt deterministic: a SIGINT that
          // arrives before the kernel enters user code is swallowed by
          // ipykernel (see the reproducer in the report).
          source: 'import time\nprint("running", flush=True)\ntime.sleep(120)',
          position: 'end'
        },
        { op: 'add_cell', cell_type: 'code', source: 'print("never")', position: 'end' }
      ]
    });
    session.counter.take(applied);
    const cells = list(applied['results']).map((result) => ({ cell_ref: str(result['cell_ref']) }));

    const started = await mcp.call('kernel_control', {
      notebook_id: notebookId,
      request_id: session.counter.value,
      action: 'start',
      expected_kernel_id: null,
      kernel_name: 'python3'
    });
    session.counter.take(started);
    const kernelId = str(started['kernel_id']);
    startedKernels.add(kernelId);

    const executionPayload = {
      notebook_id: notebookId,
      request_id: session.counter.value,
      cells,
      stop_on_error: false,
      wait_ms: 100
    };
    const submittedAt = Date.now();
    const job = await mcp.call('notebook_execute', executionPayload);
    expect(Date.now() - submittedAt).toBeGreaterThanOrEqual(90);
    expect(job['wait_timed_out']).toBe(true);
    const replay = await mcp.call('notebook_execute', { ...executionPayload, wait_ms: 0 });
    expect(replay['replayed']).toBe(true);
    expect(replay['execution_id']).toBe(job['execution_id']);
    session.counter.take(job);
    const executionId = str(job['execution_id']);
    // The deadline returns a still-running job without interrupting it.
    expect(job['state']).toBe('running');

    // The wait ending killed nothing: the kernel is still busy with our cell.
    const busy = await mcp.call('kernel_status', { notebook_id: notebookId });
    expect(list(busy['active_execution_ids'])).toContain(executionId);

    // Wait until the first cell is provably running user code.
    let sawMarker = false;
    const markerDeadline = Date.now() + 30_000;
    while (!sawMarker && Date.now() < markerDeadline) {
      const view = await mcp.call('execution_get', { execution_id: executionId, wait_ms: 500 });
      sawMarker = JSON.stringify(list(list(view['cells'])[0]?.['outputs'])).includes('running');
    }
    expect(sawMarker, 'the long cell started printing').toBe(true);

    let quiet = await mcp.call('execution_get', { execution_id: executionId });
    const quietDeadline = Date.now() + 10_000;
    while (quiet['wait_timed_out'] !== true && Date.now() < quietDeadline) {
      const waitingAt = Date.now();
      quiet = await mcp.call('execution_get', {
        execution_id: executionId,
        cursor: quiet['cursor'],
        wait_ms: 300
      });
      if (quiet['wait_timed_out'] === true) expect(Date.now() - waitingAt).toBeGreaterThanOrEqual(280);
    }
    expect(quiet['state']).toBe('running');
    expect(quiet['wait_timed_out']).toBe(true);

    // -- execution_cancel drops what was not sent, and interrupts nothing ---
    const cancelled = await mcp.call('execution_cancel', { execution_id: executionId });
    expect(cancelled['kernel_interrupted']).toBe(false);
    expect(list(cancelled['cancelled_cell_refs']) as unknown as string[]).toContain(cells[1]!.cell_ref);
    const alreadySentRef = str(list(cancelled['already_sent_cell_refs'])[0]);
    expect(alreadySentRef).toMatch(/^@/u);
    expect(alreadySentRef).not.toBe(cells[0]!.cell_ref);
    expect(cancelled['unavailable_cancelled_cells']).toBe(0);
    expect(cancelled['unavailable_already_sent_cells']).toBe(0);
    const runningCell = await mcp.call('notebook_read', {
      notebook_id: notebookId,
      view: 'cells',
      cell_refs: [alreadySentRef]
    });
    expect(str(list(runningCell['cells'])[0]?.['cell_ref'])).toBe(alreadySentRef);
    expect(str(list(runningCell['cells'])[0]?.['source'])).toContain('print("running"');

    // -- a close while a job is active is refused (SPEC §4) -----------------
    const closeError = await mcp.fail('notebook_close', { notebook_id: notebookId });
    expect(closeError.code).toBe('EXECUTION_ACTIVE');

    // -- an explicit interrupt is available during the long job -------------
    const interrupted = await mcp.call('kernel_control', {
      notebook_id: notebookId,
      request_id: session.counter.value,
      action: 'interrupt',
      expected_kernel_id: kernelId
    });
    session.counter.take(interrupted);
    expect(obj(interrupted['effects'])['kernel_interrupted']).toBe(true);
    expect(obj(interrupted['effects'])['outputs_cleared']).toBe(false);

    const finished = await settle(mcp, executionId, 60_000);
    expect(finished['state']).toBe('interrupted');
    const first = list(finished['cells'])[0];
    expect(first?.['state']).toBe('aborted');
    expect(first?.['aborted_reason']).toBe('interrupted');
    const second = list(finished['cells'])[1];
    expect(second?.['state']).toBe('not_sent');
    expect(second?.['not_sent_reason']).toBe('cancelled');

    // The kernel survived every one of those (SPEC §4).
    const kernels = await mcp.call('kernel_list', {});
    expect(list(kernels['running']).some((entry) => entry['kernel_id'] === kernelId)).toBe(true);

    const closed = await mcp.call('notebook_close', { notebook_id: notebookId });
    expect(closed['kernel_left_running']).toBe(true);
    expect(closed['already_closed']).toBe(false);

    // Handles of a closed session are gone.
    const expired = await mcp.fail('notebook_read', { notebook_id: notebookId, view: 'summary' });
    expect(expired.code).toBe('HANDLE_EXPIRED');
  }, 240_000);
});

describe('Retry limit (SPEC §12)', () => {
  it('evicts the oldest receipts and answers REQUEST_ID_EXPIRED without an effect', async () => {
    // The receipt registry holds 4 096 entries (SPEC §9), so the number "1"
    // is only forgotten after 4 096 further acceptances. Repeatedly clearing
    // already-empty outputs consumes receipts while preserving one observed
    // cell state and therefore one stable cell_ref.
    const session = await openContext();
    const mcp = session.client;
    const created = await mcp.call('notebook_create', {
      request_id: session.counter.value,
      directory: '',
      name: nb('receipts')
    });
    session.counter.take(created);
    const notebookId = str(obj(created['notebook'])['notebook_id']);

    // The first request is an `add_cell`: it has no expected revision, so
    // when it is resent after eviction the only thing that can refuse it is
    // the receipt registry itself.
    const firstPayload = {
      notebook_id: notebookId,
      request_id: session.counter.value,
      operations: [
        { op: 'add_cell', cell_type: 'code', source: 'receipt probe', position: 'end' }
      ]
    };
    const first = await mcp.call('notebook_apply', firstPayload);
    session.counter.take(first);
    let receiptCellRef = str(list(first['results'])[0]?.['cell_ref']);
    const afterFirst = await mcp.call('notebook_read', { notebook_id: notebookId, view: 'summary' });
    const cellsAfterFirst = Number(obj(afterFirst['summary'])['cell_count']);

    // Fill the registry past its 4 096 receipts.
    const started = Date.now();
    for (let remaining = 4_096; remaining > 0; remaining -= 1) {
      const answer = await mcp.call('notebook_apply', {
        notebook_id: notebookId,
        request_id: session.counter.value,
        operations: [
          {
            op: 'clear_outputs',
            cell_ref: receiptCellRef
          }
        ]
      });
      session.counter.take(answer);
      receiptCellRef = str(list(answer['results'])[0]?.['cell_ref']);
    }
    const elapsed = Date.now() - started;
    expect(Number(session.counter.value)).toBeGreaterThan(4_096);

    // The very first number is gone: it is refused, and nothing runs again.
    const expired = await mcp.fail('notebook_apply', firstPayload);
    expect(expired.code, `after ${String(elapsed)} ms of receipts`).toBe('REQUEST_ID_EXPIRED');
    // SPEC §9 error table: the receipt is gone, so the effect of that number
    // can no longer be proven either way - the agent must check, not resend.
    expect(expired.side_effects).toBe('unknown');
    expect(expired.request_accepted).toBeNull();
    expect(expired.next_request_id).toBe(session.counter.value);
    // Nothing ran again: no second cell, and the stable observation still
    // addresses the original probe cell.
    const read = await mcp.call('notebook_read', { notebook_id: notebookId, view: 'summary' });
    expect(Number(obj(read['summary'])['cell_count'])).toBe(cellsAfterFirst);
    const receiptCell = await mcp.call('notebook_read', {
      notebook_id: notebookId,
      view: 'cells',
      cell_refs: [receiptCellRef]
    });
    expect(str(list(receiptCell['cells'])[0]?.['source'])).toBe('receipt probe');

    // Two concurrent calls with one number produce a single effect. The
    // payload is an `add_cell` on purpose: it has no expected revision, so
    // the two calls differ only in who wins the session lock.
    const concurrentPayload = {
      notebook_id: notebookId,
      request_id: session.counter.value,
      operations: [
        { op: 'add_cell', cell_type: 'raw', source: 'concurrent probe', position: 'end' }
      ]
    };
    const [left, right] = await Promise.all([
      mcp.call('notebook_apply', concurrentPayload),
      mcp.call('notebook_apply', concurrentPayload)
    ]);
    session.counter.take(left);
    expect([left['replayed'], right['replayed']].filter((flag) => flag === true)).toHaveLength(1);
    expect(left['first_accepted_at']).toBe(right['first_accepted_at']);
    expect(str(list(left['results'])[0]?.['cell_ref'])).toBe(str(list(right['results'])[0]?.['cell_ref']));
    const afterConcurrent = await mcp.call('notebook_read', {
      notebook_id: notebookId,
      view: 'summary'
    });
    // Exactly one cell was added by the two calls.
    expect(Number(obj(afterConcurrent['summary'])['cell_count'])).toBe(cellsAfterFirst + 1);

    await mcp.close();
  }, 300_000);
});

describe('Cleanup and credentials (SPEC §12)', () => {
  it('closing the connection releases its handles and leaves kernels running', async () => {
    await mcp.close();
    const kernels = await apiFetchOk({ baseUrl: stand.baseUrl, token: stand.token }, '/api/kernels');
    const running = kernels.json<Array<{ id: string }>>();
    expect(running.some((kernel) => startedKernels.has(kernel.id))).toBe(true);
  }, 60_000);

  it('the child wrote nothing but JSON-RPC to stdout', () => {
    expect(mcp.transport.impurities).toEqual([]);
    expect(mcp.transport.stdoutRaw.length).toBeGreaterThan(20);
    for (const line of mcp.transport.stdoutRaw) {
      expect(JSON.parse(line)).toMatchObject({ jsonrpc: '2.0' });
    }
  });

  it('no answer, log line or URI ever carried the token', () => {
    for (const line of mcp.transport.stdoutRaw) expect(line).not.toContain(TOKEN);
    for (const text of mcp.texts) expect(text).not.toContain(TOKEN);
    expect(mcp.transport.stderr).not.toContain(TOKEN);
    // The diagnostics did run, so the absence above is not vacuous.
    expect(mcp.transport.stderr).toContain('[info]');
  });
});
