/**
 * Exercise the real REST -> RTC -> kernel boundary against a disposable fixture.
 * Usage: pnpm exec tsx scripts/header-auth-smoke.ts <base-url> <credential-file>
 * The fixture owns server and kernel teardown. Never target a user workspace.
 */
import assert from 'node:assert/strict';
import { createCollabService } from '../src/service/index.js';

const [apiBaseUrl, credentialFile] = process.argv.slice(2);
if (!apiBaseUrl || !credentialFile) {
  throw new Error('usage: header-auth-smoke.ts <base-url> <credential-file>');
}
const service = createCollabService({
  servers: [{
    id: 'fixture', kind: 'jupyterhub', apiBaseUrl,
    auth: { type: 'header', name: 'X-Jupyter-Access-Token' },
    credentialRef: `file:${credentialFile}`
  }]
});

try {
  const session = await service.sessionOpen({});
  const created = await service.notebookCreate({
    sessionId: session.sessionId, requestId: '1', directory: '',
    name: `assertion-${Date.now()}.ipynb`
  });
  assert.equal(created.notebook.connectionState, 'ready');
  const notebookId = created.notebook.notebookId;
  const applied = await service.notebookApply({
    notebookId, requestId: created.nextRequestId!,
    operations: [{ op: 'add_cell', cellType: 'code', source: 'print(6 * 7)', position: 'end' }]
  });
  const cell = applied.results[0]!;
  const started = await service.kernelControl({
    notebookId, requestId: applied.nextRequestId!, action: 'start',
    expectedKernelId: null, kernelName: 'python3'
  });
  assert.ok(started.kernelId);
  const job = await service.notebookExecute({
    notebookId, requestId: started.nextRequestId!, waitMs: 1000,
    cells: [{ cellId: cell.cellId!, expectedSourceRevision: cell.sourceRevision! }]
  });
  const deadline = Date.now() + 30_000;
  const terminal = new Set(['succeeded', 'failed', 'cancelled', 'interrupted', 'unknown']);
  let view = await service.executionGet({ executionId: job.executionId, waitMs: 1000 });
  while (!terminal.has(view.state) && Date.now() < deadline) {
    view = await service.executionGet({ executionId: job.executionId, waitMs: 1000 });
  }
  assert.equal(view.state, 'succeeded');
  const outputs = await service.notebookRead({ notebookId, view: 'outputs', cellIds: [cell.cellId!] });
  assert.ok(outputs.cells[0]!.outputs.some((entry) => {
    const output = entry.output;
    return output?.output_type === 'stream' &&
      (typeof output.text === 'string' ? output.text : output.text.join('')).includes('42');
  }));
  const saved = await service.notebookSave({ notebookId, timeoutMs: 20_000 });
  assert.equal(saved.saveStatus, 'success');
  process.stdout.write('header-auth smoke passed: REST, RTC, kernel execution, output sync, save\n');
} catch {
  process.stderr.write('header-auth smoke failed\n');
  process.exitCode = 1;
} finally {
  await service.shutdown('client_request');
}
