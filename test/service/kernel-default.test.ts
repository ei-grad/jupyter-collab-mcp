import { afterEach, expect, it } from 'vitest';
import type { CollabService } from '../../src/core/index.js';
import { createCollabService } from '../../src/service/index.js';
import { makeFakeHandle, makeFakeServer } from './helpers.js';

const services: CollabService[] = [];
afterEach(async () => { await Promise.all(services.splice(0).map(s => s.shutdown('client_request'))); });

async function rig(defaultName: string, names: string[]) {
  const fake = makeFakeServer({ files: [{ path: 'a.ipynb', type: 'notebook' }] });
  const posts: unknown[] = [];
  const service = createCollabService({ servers: [{ id: 'test', kind: 'standalone', apiBaseUrl: 'http://127.0.0.1:1', credentialRef: 'literal:test-token' }] }, {
    guardStdout: false, openHandle: async init => makeFakeHandle(init).handle,
    fetchImpl: async (input, init) => {
      const url = String(input);
      if (url.endsWith('/api/kernelspecs')) return Response.json({ default: defaultName, kernelspecs: Object.fromEntries(names.map(name => [name, { name, spec: { display_name: name, language: 'python', argv: [] }, resources: {} }])) });
      if (url.endsWith('/api/sessions') && init?.method === 'POST') {
        posts.push(JSON.parse(String(init.body)));
        return Response.json({ message: 'fixture stops before starting a kernel' }, { status: 503 });
      }
      return fake.fetchImpl(input, init);
    }
  });
  services.push(service);
  const opened = await service.notebookOpen({ path: 'a.ipynb' });
  return { service, posts, notebookId: opened.notebook.notebookId };
}

it.each([
  ['missing', ['custom'], undefined, 'custom'],
  ['preferred', ['preferred', 'other'], undefined, 'preferred'],
  ['preferred', ['preferred', 'other'], 'other', 'other']
] as const)('sends resolved kernel in POST (default %s)', async (defaultName, names, kernelName, expected) => {
  const r = await rig(defaultName, [...names]);
  await expect(r.service.kernelControl({ notebookId: r.notebookId, requestId: '1', action: 'start', expectedKernelId: null, ...(kernelName === undefined ? {} : { kernelName }) })).rejects.toBeDefined();
  expect(r.posts).toEqual([{ path: 'a.ipynb', name: 'a.ipynb', type: 'notebook', kernel: { name: expected } }]);
});

it.each([
  [[], undefined], [['one', 'two'], undefined], [['one'], 'missing']
] as const)('rejects unavailable/ambiguous selections without consuming request ID (%j)', async (names, kernelName) => {
  const r = await rig('missing', [...names]);
  await expect(r.service.kernelControl({ notebookId: r.notebookId, requestId: '1', action: 'start', expectedKernelId: null, ...(kernelName === undefined ? {} : { kernelName }) })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT', details: { next_request_id: '1', request_accepted: false } });
  expect(r.posts).toEqual([]);
});
