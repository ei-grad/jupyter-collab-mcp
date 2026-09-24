import { afterAll, beforeAll, expect, it } from 'vitest';
import type { CollabService } from '../../src/core/index.js';
import { createCollabService } from '../../src/service/index.js';
import { startStand, type Stand } from '../helpers/stand.js';

let stand: Stand;
let service: CollabService;
let notebookId: string;
let kernelId: string | null = null;
const posts: unknown[] = [];

beforeAll(async () => {
  stand = await startStand({ port: 8926 });
  service = createCollabService({ servers: [{ id: 'stand', kind: 'standalone', apiBaseUrl: stand.baseUrl, credentialRef: `literal:${stand.token}` }] }, {
    guardStdout: false,
    fetchImpl: async (input, init) => {
      const url = String(input);
      if (url.endsWith('/api/sessions') && init?.method === 'POST') posts.push(JSON.parse(String(init.body)));
      const response = await fetch(input, init);
      if (url.endsWith('/api/kernelspecs') && response.ok) {
        const actual = await response.json() as { kernelspecs: Record<string, unknown> };
        expect(actual.kernelspecs['python3']).toBeDefined();
        return Response.json({ default: 'unavailable-advertised-default', kernelspecs: { python3: actual.kernelspecs['python3'] } });
      }
      return response;
    }
  });
  const created = await service.notebookCreate({ requestId: '1', directory: '', name: `kernel-default-${Date.now()}.ipynb` });
  notebookId = created.notebook.notebookId;
});

afterAll(async () => {
  if (kernelId !== null) await service.kernelControl({ notebookId, requestId: (await service.serverList()).nextRequestId!, action: 'shutdown', expectedKernelId: kernelId });
  await service?.shutdown('client_request');
  await stand?.stop();
});

it('rejects an explicit bad name then starts the sole real kernel through HTTP with the same request ID', async () => {
  const requestId = (await service.serverList()).nextRequestId!;
  await expect(service.kernelControl({ notebookId, requestId, action: 'start', expectedKernelId: null, kernelName: 'unavailable-advertised-default' })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
  expect(posts).toEqual([]);
  const result = await service.kernelControl({ notebookId, requestId, action: 'start', expectedKernelId: null });
  kernelId = result.kernelId;
  expect(kernelId).not.toBeNull();
  expect(result.kernelName).toBe('python3');
  expect(posts).toHaveLength(1);
  expect(posts[0]).toMatchObject({ type: 'notebook', kernel: { name: 'python3' } });
  const replay = await service.kernelControl({ notebookId, requestId, action: 'start', expectedKernelId: null });
  expect(replay.replayed).toBe(true);
  expect(replay.kernelId).toBe(kernelId);
  expect(posts).toHaveLength(1);
});
