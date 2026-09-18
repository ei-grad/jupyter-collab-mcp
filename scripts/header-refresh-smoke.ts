/**
 * Renew a grant through the canonical Node worker against a disposable Jupyter.
 * The fixture provides two signed assertions, the first expiring in ~15 seconds.
 * Usage: tsx scripts/header-refresh-smoke.ts <base-url> <first-file> <renewed-file>
 */
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { WorkerRegistry } from '../src/gateway/worker-registry.js';
import type { GatewayIdentity } from '../src/gateway/worker.js';

const [baseUrl, firstFile, renewedFile] = process.argv.slice(2);
if (!baseUrl || !firstFile || !renewedFile) {
  throw new Error('usage: header-refresh-smoke.ts <base-url> <first-file> <renewed-file>');
}
const endpoint = new URL(baseUrl);
assert.equal(endpoint.hostname, '127.0.0.1', 'only a disposable local fixture is permitted');
assert.equal(endpoint.pathname, '/user/alice/');
const root = await mkdtemp(join(tmpdir(), 'header-refresh-smoke-'));
const grantExpiresAt = Date.now() / 1000 + 600;
const identity = async (file: string, generation: number): Promise<GatewayIdentity> => {
  const assertion = (await readFile(file, 'utf8')).trim();
  const payload = JSON.parse(Buffer.from(assertion.split('.')[1]!, 'base64url').toString('utf8')) as {
    iss: string; sub: string; exp: number;
  };
  return {
    issuer: payload.iss, subject: payload.sub, expiresAt: payload.exp,
    username: 'alice', grantId: 'fixture-login', grantGeneration: generation,
    grantExpiresAt, assertion: () => assertion
  };
};
const first = await identity(firstFile, 0);
const renewed = await identity(renewedFile, 1);
const registry = new WorkerRegistry({
  allowedUsers: new Set(['alice']), apiBaseUrl: endpoint.origin,
  browserBaseUrl: baseUrl, assertionHeader: 'X-Jupyter-Access-Token',
  nodeCommand: process.execPath,
  upstreamCli: join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'mcp', 'cli.js'),
  runtimeDir: join(root, 'workers'), connectTimeoutMs: 10_000,
  maxWorkers: 2, maxWorkersPerPrincipal: 2, requestTimeoutMs: 15_000, expiryPollMs: 60_000
});
type Result = Record<string, unknown>;
const call = async (actor: GatewayIdentity, name: string, args: Result = {}): Promise<Result> => {
  const result = await registry.withClient(actor, undefined, (client) =>
    client.callTool({ name, arguments: args }));
  assert.notEqual(result.isError, true, `${name} failed`);
  assert.ok(result.structuredContent, `${name} returned no structured content`);
  return result.structuredContent as Result;
};
const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

try {
  const session = await call(first, 'session_open');
  const sessionId = session['session_id'];
  const created = await call(first, 'notebook_create', {
    session_id: sessionId, request_id: '1', directory: '', name: `refresh-${Date.now()}.ipynb`
  });
  const notebookId = (created['notebook'] as Result)['notebook_id'];
  const applied = await call(first, 'notebook_apply', {
    notebook_id: notebookId, request_id: created['next_request_id'], operations: [{
      op: 'add_cell', cell_type: 'code', position: 'end',
      source: "import time\nrefresh_count = globals().get('refresh_count', 0) + 1\ntime.sleep(20)\nprint(refresh_count)"
    }]
  });
  const cell = (applied['results'] as Result[])[0]!;
  const kernel = await call(first, 'kernel_control', {
    notebook_id: notebookId, request_id: applied['next_request_id'], action: 'start',
    expected_kernel_id: null, kernel_name: 'python3'
  });
  const job = await call(first, 'notebook_execute', {
    notebook_id: notebookId, request_id: kernel['next_request_id'], wait_ms: 0,
    cells: [{ cell_id: cell['cell_id'], expected_source_revision: cell['source_revision'] }]
  });
  assert.equal(job['state'], 'running');
  const held = await registry.acquire(first);
  const worker = held.worker;
  await held.release();
  const rotated = await registry.acquire(renewed);
  assert.equal(rotated.worker, worker);
  await rotated.release();
  await call(renewed, 'notebook_list', { session_id: sessionId, directory: '' });
  process.stdout.write('renewed assertion; original notebook and execution handles retained\n');

  await wait(Math.max(0, first.expiresAt * 1000 - Date.now()) + 500);
  await registry.expire();
  assert.equal(registry.size, 1);
  await assert.rejects(registry.acquire(first), /expired/);
  const expiresBy = Date.now() + 35_000;
  let ready = false;
  while (Date.now() < expiresBy) {
    const notebook = await call(renewed, 'notebook_read', { notebook_id: notebookId, view: 'summary' });
    const status = await call(renewed, 'kernel_status', { notebook_id: notebookId });
    assert.equal(status['kernel_id'], kernel['kernel_id']);
    const summary = notebook['summary'] as Result;
    if (summary['connection_state'] === 'ready' && status['channel_state'] === 'connected') {
      ready = true;
      break;
    }
    await wait(250);
  }
  assert.ok(ready, 'original notebook and kernel did not reconnect after assertion expiry');
  const previous = await call(renewed, 'execution_get', { execution_id: job['execution_id'], wait_ms: 0 });
  assert.equal(previous['notebook_id'], notebookId);
  assert.equal(previous['kernel_id'], kernel['kernel_id']);
  assert.ok(['running', 'succeeded', 'unknown'].includes(String(previous['state'])));
  const read = await call(renewed, 'notebook_read', { notebook_id: notebookId, view: 'summary' });
  const check = await call(renewed, 'notebook_apply', {
    notebook_id: notebookId, request_id: read['next_request_id'], operations: [{
      op: 'add_cell', cell_type: 'code', position: 'end', source: 'assert refresh_count == 1\nprint(42)'
    }]
  });
  const checkCell = (check['results'] as Result[])[0]!;
  const checked = await call(renewed, 'notebook_execute', {
    notebook_id: notebookId, request_id: check['next_request_id'], wait_ms: 0,
    cells: [{ cell_id: checkCell['cell_id'], expected_source_revision: checkCell['source_revision'] }]
  });
  let complete: Result = checked;
  const finishedBy = Date.now() + 35_000;
  while (['running', 'queued'].includes(String(complete['state'])) && Date.now() < finishedBy) {
    complete = await call(renewed, 'execution_get', { execution_id: checked['execution_id'], wait_ms: 1000 });
  }
  assert.equal(complete['state'], 'succeeded', 'execution after renewal did not succeed exactly once');
  const saved = await call(renewed, 'notebook_save', { notebook_id: notebookId, timeout_ms: 20_000 });
  assert.equal(saved['save_status'], 'success');
  const foreign = await registry.withClient({ ...renewed, grantId: 'independent-login' }, undefined,
    (client) => client.callTool({ name: 'notebook_read', arguments: { notebook_id: notebookId, view: 'summary' } }));
  assert.equal(foreign.isError, true);
  assert.ok(JSON.stringify(foreign).includes('HANDLE_EXPIRED'));
  process.stdout.write('refresh smoke passed: same worker/notebook/kernel, expiry reconnect, no replay, save, login isolation\n');
} catch (error) {
  process.stderr.write(error instanceof assert.AssertionError ? `${error.message}\n` : 'refresh smoke failed\n');
  process.exitCode = 1;
} finally {
  await registry.close();
  await rm(root, { recursive: true, force: true });
}
