import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import type { CollabService } from '../../src/core/index.js';
import { notebookPersistenceDigest, captureNotebookPersistence } from '../../src/core/notebook/persistence.js';
import { createCollabService, NotebookHandle } from '../../src/service/index.js';
import { startStand, type Stand } from '../helpers/stand.js';

let stand: Stand;
let service: CollabService;
let handle: NotebookHandle;
const name = `save-readback-${Date.now()}.ipynb`;

beforeAll(async () => {
  stand = await startStand({ port: 8927 });
  await writeFile(join(stand.root, name), JSON.stringify({ nbformat: 4, nbformat_minor: 5,
    metadata: { custom: { owner: 'fixture', labels: ['a', 'b'] } }, cells: [
      { id: 'code', cell_type: 'code', source: ['π = 1\n', 'print(π)'], metadata: { custom: 'preserve' }, execution_count: 1,
        outputs: [{ output_type: 'stream', name: 'stdout', text: ['π\n', '🙂\n'] },
          { output_type: 'display_data', metadata: {}, data: { 'text/plain': ['first\n', 'second'], 'application/json': ['a', 'b'] } }] },
      { id: 'markdown', cell_type: 'markdown', source: '![x](attachment:x.png)', metadata: {}, attachments: { 'x.png': { 'image/png': 'YWJjZA==' } } }
    ] }));
  service = createCollabService({ servers: [{ id: 'stand', kind: 'standalone', apiBaseUrl: stand.baseUrl, credentialRef: `literal:${stand.token}` }] }, {
    guardStdout: false, openHandle: async init => { handle = await NotebookHandle.open(init); return handle; }
  });
});
afterAll(async () => { await service?.shutdown('client_request'); await stand?.stop(); });

it('confirms a source edit with metadata, attachments and outputs against the actual saved file', async () => {
  const opened = await service.notebookOpen({ path: name });
  const cell = handle!.notebook.cells[0]!;
  cell.setSource('π = 2\nprint(π)');
  cell.ymodel.set('__proto__', { cell_field: 'preserved' });
  cell.ymodel.get('metadata').set('__proto__', { cell_metadata: 'preserved' });
  handle!.notebook.ymeta.get('metadata').set('__proto__', { notebook_metadata: 'preserved' });
  const captured = captureNotebookPersistence(handle!.notebook);
  const saved = await service.notebookSave({ notebookId: opened.notebook.notebookId, timeoutMs: 10000 });
  expect(saved).toMatchObject({ saveStatus: 'success', revisionPersistence: 'confirmed', persistenceConfirmation: { method: 'contents-api-readback', snapshotDigest: captured } });
  const file = JSON.parse(await readFile(join(stand.root, name), 'utf8'));
  expect(notebookPersistenceDigest(file)).toBe(captured);
  expect(file.metadata.custom).toEqual({ owner: 'fixture', labels: ['a', 'b'] });
  expect(file.cells[0].source.join('')).toBe('π = 2\nprint(π)');
  expect(file.cells[0].outputs[1].data['application/json']).toEqual(['a', 'b']);
  expect(file.cells[1].attachments['x.png']['image/png']).toBe('YWJjZA==');
  expect(Object.hasOwn(file.cells[0], '__proto__')).toBe(true);
  expect(file.cells[0]['__proto__']).toEqual({ cell_field: 'preserved' });
  expect(file.cells[0].metadata['__proto__']).toEqual({ cell_metadata: 'preserved' });
  expect(file.metadata['__proto__']).toEqual({ notebook_metadata: 'preserved' });
});

it('detects a direct disk edit without claiming an unconfirmed overwrite', async () => {
  const opened = await service.notebookOpen({ path: name });
  const target = captureNotebookPersistence(handle.notebook);
  const disk = JSON.parse(await readFile(join(stand.root, name), 'utf8'));
  disk.cells[0].source = ['external disk edit'];
  await writeFile(join(stand.root, name), JSON.stringify(disk));

  const saved = await service.notebookSave({ notebookId: opened.notebook.notebookId, timeoutMs: 10000 });
  expect(saved).toMatchObject({ saveStatus: 'success', externalChangeDetected: true });
  if (saved.revisionPersistence === 'confirmed') {
    expect(saved.overwroteExternalChange).toBe(true);
    expect(notebookPersistenceDigest(JSON.parse(await readFile(join(stand.root, name), 'utf8')))).toBe(target);
  } else {
    expect(saved.overwroteExternalChange).toBeNull();
  }
});
