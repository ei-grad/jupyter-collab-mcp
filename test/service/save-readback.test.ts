import { createServer } from 'node:http';
import { afterEach, expect, it } from 'vitest';
import type { CollabService } from '../../src/core/index.js';
import { captureNotebookPersistence, notebookPersistenceDigest } from '../../src/core/notebook/persistence.js';
import { createCollabService, type NotebookHandle } from '../../src/service/index.js';
import { makeFakeHandle, makeFakeServer, type FakeHandleControls } from './helpers.js';

const services: CollabService[] = [];
afterEach(async () => { await Promise.all(services.splice(0).map(s => s.shutdown('client_request'))); });
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function rig() {
  const fake = makeFakeServer({ files: [{ path: 'a.ipynb', type: 'notebook' }] });
  let handle!: NotebookHandle;
  let controls!: FakeHandleControls;
  let reads = 0;
  let read: (init?: RequestInit) => Promise<Response> = async () => Response.json({ type: 'notebook', content: handle.notebook.toJSON() });
  const service = createCollabService({ servers: [{ id: 'test', kind: 'standalone', apiBaseUrl: 'http://127.0.0.1:1', credentialRef: 'literal:fixture' }] }, {
    guardStdout: false,
    openHandle: async init => { const result = makeFakeHandle(init); handle = result.handle; controls = result.controls; return handle; },
    fetchImpl: async (input, init) => {
      if (String(input).includes('content=1&type=notebook')) {
        reads++;
        expect(init?.cache).toBe('no-store');
        expect(new Headers(init?.headers).get('cache-control')).toBe('no-cache, no-store');
        return read(init);
      }
      return fake.fetchImpl(input, init);
    }
  });
  services.push(service);
  const opened = await service.notebookOpen({ path: 'a.ipynb' });
  reads = 0;
  return { service, handle, controls, notebookId: opened.notebook.notebookId, get reads() { return reads; }, setRead: (next: typeof read) => { read = next; } };
}

it('confirms the immutable full snapshot and leaves the request ledger unchanged', async () => {
  const r = await rig();
  const digest = captureNotebookPersistence(r.handle.notebook);
  const answer = await r.service.notebookSave({ notebookId: r.notebookId, timeoutMs: 300 });
  expect(answer).toMatchObject({ saveStatus: 'success', revisionPersistence: 'confirmed', nextRequestId: '1', persistenceConfirmation: { method: 'contents-api-readback', snapshotDigest: digest } });
  expect(Date.parse(answer.persistenceConfirmation!.observedAt)).toBeGreaterThanOrEqual(Date.parse(answer.requestedAt));
});

it('reports a changed Contents snapshot that a confirmed save replaced', async () => {
  const r = await rig();
  const original = r.handle.notebook.toJSON();
  const external = structuredClone(original);
  external.cells[0]!.source = 'external disk edit';
  r.setRead(async () => Response.json({
    type: 'notebook', content: r.reads === 1 ? external : original
  }));
  const saved = await r.service.notebookSave({ notebookId: r.notebookId, timeoutMs: 500 });
  expect(saved).toMatchObject({
    saveStatus: 'success',
    revisionPersistence: 'confirmed',
    externalChangeDetected: true,
    overwroteExternalChange: true
  });
});

it('does not switch its target to a concurrent RTC edit and does not hold the mutation lock', async () => {
  const r = await rig();
  const original = r.handle.notebook.toJSON();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let entered!: () => void;
  const reading = new Promise<void>(resolve => { entered = resolve; });
  r.setRead(async () => { entered(); await gate; return Response.json({ type: 'notebook', content: original }); });
  const saving = r.service.notebookSave({ notebookId: r.notebookId, timeoutMs: 1000 });
  await reading;
  const applied = await r.service.notebookApply({ notebookId: r.notebookId, requestId: '1', operations: [{ op: 'add_cell', cellType: 'markdown', source: 'concurrent', position: 'end' }] });
  expect(applied.nextRequestId).toBe('2');
  release();
  const saved = await saving;
  expect(saved.revisionPersistence).toBe('confirmed');
  expect(saved.persistenceConfirmation!.snapshotDigest).toBe(notebookPersistenceDigest(original));
  expect(saved.persistenceConfirmation!.snapshotDigest).not.toBe(captureNotebookPersistence(r.handle.notebook));
});

it('keeps unknown for a source-only mismatch without busy polling', async () => {
  const r = await rig();
  const disk = r.handle.notebook.toJSON();
  disk.cells[0]!.source = 'a different source';
  r.setRead(async () => Response.json({ type: 'notebook', content: disk }));
  const began = Date.now();
  const saved = await r.service.notebookSave({ notebookId: r.notebookId, timeoutMs: 140 });
  expect(saved).toMatchObject({ saveStatus: 'success', revisionPersistence: 'unknown', persistenceConfirmation: null });
  expect(Date.now() - began).toBeGreaterThanOrEqual(120);
  expect(r.reads).toBeGreaterThanOrEqual(2);
});

it('confirms when a later independent read matches the original snapshot', async () => {
  const r = await rig();
  const original = r.handle.notebook.toJSON();
  const old = structuredClone(original);
  old.cells[0]!.source = 'older';
  r.setRead(async () => Response.json({ type: 'notebook', content: r.reads === 1 ? old : original }));
  expect((await r.service.notebookSave({ notebookId: r.notebookId, timeoutMs: 500 })).revisionPersistence).toBe('confirmed');
  expect(r.reads).toBe(2);
});

it.each(['skipped', 'timeout', 'failed'] as const)('never read-confirms RAW %s', async status => {
  const r = await rig(); r.controls.saveStatus = status;
  const saving = r.service.notebookSave({ notebookId: r.notebookId, timeoutMs: 100 });
  if (status === 'failed') await expect(saving).rejects.toMatchObject({ code: 'SAVE_FAILED' });
  else expect(await saving).toMatchObject({ saveStatus: status, revisionPersistence: 'unknown', persistenceConfirmation: null });
  expect(r.reads).toBe(1);
});

it.each([403, 404, 500])('preserves RAW success when readback returns HTTP %s', async status => {
  const r = await rig(); r.setRead(async () => new Response('', { status }));
  expect(await r.service.notebookSave({ notebookId: r.notebookId, timeoutMs: 200 })).toMatchObject({ saveStatus: 'success', revisionPersistence: 'unknown', persistenceConfirmation: null });
  expect(r.reads).toBe(2);
});

it('treats unsupported malformed notebook content as unknown', async () => {
  const r = await rig(); r.setRead(async () => Response.json({ type: 'notebook', content: 'unsupported' }));
  expect((await r.service.notebookSave({ notebookId: r.notebookId, timeoutMs: 200 })).revisionPersistence).toBe('unknown');
  expect(r.reads).toBe(2);
});

it('shares one deadline across RAW save and a stalled HTTP response body', async () => {
  const r = await rig();
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.write('{"type":"notebook","content":');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as { port: number };
  r.setRead(async init => fetch(`http://127.0.0.1:${address.port}`, init));
  (r.handle.connection as unknown as { save: () => Promise<'success'> }).save = async () => { await delay(90); return 'success'; };
  const began = Date.now();
  try {
    expect(await r.service.notebookSave({ notebookId: r.notebookId, timeoutMs: 160 })).toMatchObject({ saveStatus: 'success', revisionPersistence: 'unknown', persistenceConfirmation: null });
    expect(Date.now() - began).toBeLessThan(240);
    expect(r.reads).toBe(2);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

it('preserves RAW success but skips readback for a snapshot over 16 MiB', async () => {
  const r = await rig();
  r.handle.notebook.cells[0]!.setSource('x'.repeat(16 * 1024 * 1024));
  expect(await r.service.notebookSave({ notebookId: r.notebookId, timeoutMs: 300 })).toMatchObject({ saveStatus: 'success', revisionPersistence: 'unknown', persistenceConfirmation: null });
  expect(r.reads).toBe(0);
});

it.each([true, false])('bounds readback bytes regardless of Content-Length (declared=%s)', async declared => {
  const r = await rig();
  let cancelled = false;
  r.setRead(async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(16 * 1024 * 1024 + 1)); },
    cancel() { cancelled = true; }
  }), { headers: declared ? { 'Content-Length': String(16 * 1024 * 1024 + 1) } : {} }));
  expect(await r.service.notebookSave({ notebookId: r.notebookId, timeoutMs: 300 })).toMatchObject({ saveStatus: 'success', revisionPersistence: 'unknown', persistenceConfirmation: null });
  expect(cancelled).toBe(true);
  expect(r.reads).toBe(2);
});
