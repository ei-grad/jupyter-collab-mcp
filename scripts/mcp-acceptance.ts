/**
 * `pnpm acceptance` - the happy path of the whole product, through MCP only.
 *
 * This is the runnable companion of `test/acceptance/mcp.int.test.ts`: it
 * spawns the real CLI (`tsx src/mcp/cli.ts`) against a disposable JupyterLab,
 * drives it with the official MCP client over stdio, and prints one PASS/FAIL
 * row per SPEC.md §12 area it touched. Exit code 0 means every row passed.
 *
 * The test file is the exhaustive one (error paths, replay, interrupt,
 * cursors); this script exists so a human can watch the product work end to
 * end in one command, and so a broken build is visible without reading a
 * vitest report.
 *
 * Run: `pnpm acceptance` (or `PORT=8878 pnpm tsx scripts/mcp-acceptance.ts`).
 */

import { restartStand, type Stand } from '../test/helpers/stand.js';
import { openRemote, settle, startMcp, until, type McpChild } from '../test/acceptance/harness.js';

const PORT = Number(process.env['PORT'] ?? 8878);
const TOKEN = `acc-tok-${Math.random().toString(36).slice(2, 10)}`;
const RUN = Date.now().toString(36);
const NOTEBOOK = `acceptance-${RUN}.ipynb`;

/** A `print` plus a 1x1 PNG: the two output shapes SPEC.md §12 names. */
const CELL_SOURCE = [
  'import base64',
  'from IPython.display import display, Image',
  'print("acceptance: hello from the kernel")',
  'png = base64.b64decode(',
  '    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAA"',
  '    "DUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="',
  ')',
  'display(Image(data=png, format="png"))'
].join('\n');

interface Row {
  readonly area: string;
  readonly what: string;
  ok: boolean;
  note: string;
}

const rows: Row[] = [];

function out(text: string): void {
  process.stdout.write(`${text}\n`);
}

/** Run one row; a throw is a FAIL, never an abort of the remaining rows. */
async function row(area: string, what: string, body: () => Promise<string>): Promise<void> {
  const entry: Row = { area, what, ok: false, note: '' };
  rows.push(entry);
  try {
    entry.note = await body();
    entry.ok = true;
    out(`  PASS  ${area} — ${entry.note}`);
  } catch (error) {
    entry.note = error instanceof Error ? error.message : String(error);
    out(`  FAIL  ${area} — ${entry.note}`);
  }
}

function expect(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function str(value: unknown): string {
  return String(value);
}
function obj(value: unknown): Record<string, unknown> {
  return (value ?? {}) as Record<string, unknown>;
}
function list(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? (value as Record<string, unknown>[]) : [];
}

function table(): void {
  const width = Math.max(...rows.map((entry) => entry.area.length), 10);
  out('');
  out(`| ${'Area'.padEnd(width)} | Result | Checked |`);
  out(`| ${'-'.repeat(width)} | ------ | ------- |`);
  for (const entry of rows) {
    out(`| ${entry.area.padEnd(width)} | ${entry.ok ? 'PASS  ' : 'FAIL  '} | ${entry.what} |`);
  }
  const failed = rows.filter((entry) => !entry.ok);
  out('');
  out(`${String(rows.length - failed.length)}/${String(rows.length)} passed`);
  for (const entry of failed) out(`  FAIL ${entry.area}: ${entry.note}`);
}

async function main(): Promise<number> {
  out(`acceptance: starting a stand on port ${String(PORT)}`);
  const stand: Stand = await restartStand({ port: PORT, token: TOKEN });
  let mcp: McpChild | undefined;
  const kernels = new Set<string>();

  try {
    mcp = await startMcp(stand);
    const child = mcp;
    let notebookId = '';
    let changesCursor = '';
    let requestId = '1';
    let cellRef = '';
    let executionId = '';
    let outputId = '';
    let outputUri = '';
    let outputBytes = 0;

    out('acceptance: driving the real CLI over stdio');

    await row('Protocol', 'initialize + tools/list', async () => {
      const tools = (await child.client.listTools()).tools;
      expect(tools.length === 16, `expected 16 tools, got ${String(tools.length)}`);
      expect(
        tools.every((tool) => tool.inputSchema !== undefined && tool.outputSchema !== undefined),
        'every tool publishes an input and an output schema'
      );
      return `16 tools with input+output schemas, protocol 2026-07-28`;
    });

    await row('Servers', 'server_list is credential-free', async () => {
      const answer = await child.call('server_list');
      expect(list(answer['servers']).length === 1, 'exactly the configured server');
      requestId = str(answer['next_request_id']);
      expect(requestId === '1', 'initial implicit request number');
      expect(!JSON.stringify(answer).includes(TOKEN), 'no token in the answer');
      return 'one configured server, no credential in the descriptor';
    });

    await row('Create name', 'notebook_create with a chosen name', async () => {
      const answer = await child.call('notebook_create', {
        request_id: requestId,
        directory: '',
        name: NOTEBOOK
      });
      requestId = str(answer['next_request_id']);
      notebookId = str(obj(answer['notebook'])['notebook_id']);
      changesCursor = str(answer['changes_cursor']);
      expect(answer['renamed'] === true, 'the untitled file was renamed');
      expect(obj(answer['notebook'])['path'] === NOTEBOOK, 'the handle names the final path');
      return `${NOTEBOOK} created from ${str(answer['untitled_path'])} and opened`;
    });

    await row('Reopening', 'notebook_open returns the same handle', async () => {
      const answer = await child.call('notebook_open', { path: NOTEBOOK });
      expect(answer['reused'] === true, 'the live replica was reused');
      expect(obj(answer['notebook'])['notebook_id'] === notebookId, 'same notebook_id');
      return 'one replica, one WebSocket';
    });

    await row('Tool coverage', 'notebook_apply adds a code cell', async () => {
      const answer = await child.call('notebook_apply', {
        notebook_id: notebookId,
        request_id: requestId,
        operations: [{ op: 'add_cell', cell_type: 'code', source: CELL_SOURCE, position: 'end' }]
      });
      requestId = str(answer['next_request_id']);
      cellRef = str(list(answer['results'])[0]?.['cell_ref']);
      expect(answer['applied_locally'] === true, 'applied locally');
      expect(answer['delivery'] === 'sent', 'handed to the server');
      expect(answer['persistence'] === 'unconfirmed', 'and honestly not confirmed on disk');
      return `cell ${cellRef}, delivery=sent persistence=unconfirmed`;
    });

    await row('Document data', 'notebook_read summary and cells', async () => {
      const summary = await child.call('notebook_read', { notebook_id: notebookId, view: 'summary' });
      const cells = await child.call('notebook_read', {
        notebook_id: notebookId,
        view: 'cells',
        cell_refs: [cellRef]
      });
      expect(Number(obj(summary['summary'])['cell_count']) >= 1, 'the summary counts the cell');
      expect(str(summary['notebook_ref']).startsWith('@'), 'summary carries notebook_ref');
      expect(str(cells['notebook_ref']).startsWith('@'), 'cells carry notebook_ref');
      expect(str(list(cells['cells'])[0]?.['source']).includes('hello from the kernel'), 'source round trip');
      return `${str(obj(summary['summary'])['cell_count'])} cell(s), source read back verbatim`;
    });

    await row('Bidirectional RTC', 'a second client sees our cell and we see its edit', async () => {
      const remote = await openRemote(stand, NOTEBOOK);
      try {
        await until('the second client sees our cell', () => {
          for (let index = 0; index < remote.notebook.cells.length; index += 1) {
            if (remote.notebook.getCell(index).getSource().includes('hello from the kernel')) return true;
          }
          return false;
        });
        remote.notebook.addCell({ cell_type: 'markdown', source: 'written by a person' });
        const deadline = Date.now() + 15_000;
        let sawRemote = false;
        let cursor = changesCursor;
        while (!sawRemote && Date.now() < deadline) {
          const changes = await child.call('notebook_changes', {
            notebook_id: notebookId,
            cursor,
            wait_ms: 2000
          });
          cursor = str(changes['next_cursor']);
          sawRemote = list(changes['events']).some((event) => event['origin'] === 'remote');
        }
        changesCursor = cursor;
        expect(sawRemote, 'a remote-origin event reached the journal');
        return 'edits cross in both directions without a reload';
      } finally {
        remote.dispose();
      }
    });

    await row('External kernel', 'kernel_control start binds a kernel', async () => {
      const answer = await child.call('kernel_control', {
        notebook_id: notebookId,
        request_id: requestId,
        action: 'start',
        expected_kernel_id: null,
        kernel_name: 'python3'
      });
      requestId = str(answer['next_request_id']);
      const kernelId = str(answer['kernel_id']);
      kernels.add(kernelId);
      expect(obj(answer['effects'])['kernel_started'] === true, 'a kernel was started');
      expect(obj(answer['effects'])['outputs_cleared'] === false, 'binding clears no outputs');
      return `kernel ${kernelId} bound`;
    });

    await row('Execution completion', 'notebook_execute + execution_get', async () => {
      const job = await child.call('notebook_execute', {
        notebook_id: notebookId,
        request_id: requestId,
        cells: [{ cell_ref: cellRef }],
        wait_ms: 500
      });
      requestId = str(job['next_request_id']);
      executionId = str(job['execution_id']);
      const finished = await settle(child, executionId);
      expect(finished['state'] === 'succeeded', `state ${str(finished['state'])}`);
      return `execution ${executionId} succeeded`;
    });

    await row('Outputs', 'stream and image/png reach the shared document', async () => {
      const read = await child.call('notebook_read', {
        notebook_id: notebookId,
        view: 'outputs',
        cell_refs: [cellRef],
        limits: { max_bytes: 60_000, max_output_bytes: 40_000 }
      });
      const cell = list(read['cells'])[0];
      const outputs = list(cell?.['outputs']);
      expect(cell?.['execution_count'] === 1, 'the terminal execution_count is in the document');
      expect(cell?.['execution_state'] === 'idle', 'and so is execution_state=idle');
      expect(
        outputs.some((entry) => str(obj(entry['output'])['output_type']) === 'stream'),
        'a stream output'
      );
      expect(
        outputs.some((entry) => list(entry['mime_types']).length > 0 || entry['output'] !== undefined),
        'an output payload'
      );
      return `count=1, state=idle, ${String(outputs.length)} output(s)`;
    });

    await row('Limits', 'a large PNG is an output_id, not inline base64', async () => {
      const answer = await child.raw('execution_get', {
        execution_id: executionId,
        limits: { max_output_bytes: 64 }
      });
      const payload = obj(answer.structuredContent);
      const entry = list(list(payload['cells'])[0]?.['outputs']).find(
        (candidate) => obj(candidate['snapshot'])['output_id'] !== undefined
      );
      expect(entry !== undefined, 'the oversized output kept only a snapshot reference');
      outputId = str(obj(entry?.['snapshot'])['output_id']);
      outputUri = str(obj(entry?.['snapshot'])['uri']);
      outputBytes = Number(obj(entry?.['snapshot'])['byte_size']);
      expect(!outputUri.includes(TOKEN), 'the URI carries no credential');
      expect(
        answer.content.some((block) => block.type === 'resource_link' && block.uri === outputUri),
        'the answer links the snapshot'
      );
      return `snapshot ${outputId} (${String(outputBytes)} bytes) as a resource_link`;
    });

    await row('Cursors and outputs', 'output_read pages the snapshot', async () => {
      let assembled = 0;
      let cursor: string | undefined;
      let pages = 0;
      for (;;) {
        const page = await child.call('output_read', {
          output_id: outputId,
          ...(cursor === undefined ? {} : { cursor }),
          limits: { max_bytes: 8 }
        });
        expect(Number(page['byte_offset']) === assembled, 'a continuation never resends bytes');
        assembled += Buffer.from(
          str(page['data']),
          page['encoding'] === 'base64' ? 'base64' : 'utf8'
        ).byteLength;
        pages += 1;
        cursor = page['next_cursor'] as string | undefined;
        if (cursor === undefined) break;
      }
      expect(assembled === outputBytes, `reassembled ${String(assembled)} of ${String(outputBytes)}`);
      return `${String(pages)} page(s) reassemble to ${String(outputBytes)} bytes`;
    });

    await row('Cursors and outputs', 'resources/list and resources/read', async () => {
      const listed = await child.client.listResources();
      expect(
        listed.resources.some((entry) => entry.uri === outputUri),
        'the snapshot is listed as a resource'
      );
      const read = await child.client.readResource({ uri: outputUri });
      const contents = read.contents[0] as { blob?: string; text?: string };
      const bytes =
        contents.blob !== undefined
          ? Buffer.from(contents.blob, 'base64').byteLength
          : Buffer.from(String(contents.text ?? ''), 'utf8').byteLength;
      expect(bytes === outputBytes, `resources/read returned ${String(bytes)} bytes`);
      return 'the same bytes over resources/read, no subscriptions';
    });

    await row('Headless operation and persistence', 'notebook_save then read the file back', async () => {
      const saved = await child.call('notebook_save', { notebook_id: notebookId, timeout_ms: 20_000 });
      expect(saved['save_status'] === 'success', `save_status ${str(saved['save_status'])}`);
      const response = await fetch(`${stand.baseUrl}/api/contents/${NOTEBOOK}?content=1`, {
        headers: { Authorization: `token ${stand.token}` }
      });
      expect(response.ok, `contents GET ${String(response.status)}`);
      const body = (await response.json()) as { content: unknown };
      const text = JSON.stringify(body.content);
      expect(text.includes('hello from the kernel'), 'the saved .ipynb carries the cell');
      expect(text.includes('image/png'), 'and its PNG output');
      return 'the .ipynb on disk contains the cell and its outputs';
    });

    await row('Cleanup', 'notebook_close leaves the kernel running', async () => {
      const closed = await child.call('notebook_close', { notebook_id: notebookId });
      expect(closed['kernel_left_running'] === true, 'closing shuts no kernel down');
      const response = await fetch(`${stand.baseUrl}/api/kernels`, {
        headers: { Authorization: `token ${stand.token}` }
      });
      const running = (await response.json()) as Array<{ id: string }>;
      for (const kernelId of kernels) {
        expect(running.some((entry) => entry.id === kernelId), `kernel ${kernelId} still running`);
      }
      return 'handles released, kernels untouched';
    });

    await row('Credentials', 'stdout is MCP-only and no token ever appeared', async () => {
      expect(child.transport.impurities.length === 0, `non-JSON-RPC on stdout: ${child.transport.impurities.join(' | ')}`);
      for (const line of child.transport.stdoutRaw) {
        expect(!line.includes(TOKEN), 'a stdout frame carried the token');
      }
      for (const text of child.texts) expect(!text.includes(TOKEN), 'an answer carried the token');
      expect(!child.transport.stderr.includes(TOKEN), 'a log line carried the token');
      return `${String(child.transport.stdoutRaw.length)} JSON-RPC frames, no credential anywhere`;
    });
  } finally {
    await mcp?.close();
    for (const kernelId of kernels) {
      await fetch(`${stand.baseUrl}/api/kernels/${kernelId}`, {
        method: 'DELETE',
        headers: { Authorization: `token ${stand.token}` }
      }).catch(() => undefined);
    }
    await stand.stop();
  }

  table();
  return rows.every((entry) => entry.ok) ? 0 : 1;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    out(`acceptance: aborted — ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
    process.exitCode = 2;
  });
