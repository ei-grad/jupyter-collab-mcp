import { afterAll, beforeAll, expect, it } from 'vitest';
import type { CollabService } from '../../src/core/index.js';
import { createCollabService } from '../../src/service/index.js';
import { startStand, type Stand } from '../helpers/stand.js';
import { startHttpStub, sendJson, type HttpStub } from '../jupyter/helpers/http-stub.js';

let stand: Stand;
let hub: HttpStub;
let service: CollabService;
let observer: CollabService;
let ready = false;
let starts = 0;

beforeAll(async () => {
  stand = await startStand({ port: 8908 });
  hub = await startHttpStub((request, response) => {
    if (request.method === 'POST') {
      starts += 1;
      ready = true;
      response.writeHead(201).end();
      return;
    }
    sendJson(response, 200, { state: ready ? 'ready' : 'stopped', user: 'alice', server_name: '',
      server_url: '/user/alice/', user_options: {}, start_options: { profiles: [] } });
  });
  service = createCollabService({ servers: [{
    id: 'hub', kind: 'jupyterhub', apiBaseUrl: stand.baseUrl, credentialRef: `literal:${stand.token}`,
    hub: { apiBaseUrl: `${hub.baseUrl}/hub/api/faceapp/server`, protocol: 'adapter-v1', credentialRef: 'literal:fixture-control-token' }
  }] }, { guardStdout: false });
  observer = createCollabService({ servers: [{ id: 'standalone', kind: 'standalone', apiBaseUrl: stand.baseUrl, credentialRef: `literal:${stand.token}` }] }, { guardStdout: false });
}, 120_000);

afterAll(async () => {
  await Promise.all([service?.shutdown('client_request'), observer?.shutdown('client_request')]);
  await hub?.close();
  await stand?.stop();
}, 120_000);

it('keeps standalone usable and gates real RTC notebook access on explicit singleuser start', async () => {
  expect(await observer.serverStatus({})).toMatchObject({ state: 'ready', supportsStart: false });
  await expect(observer.serverStart({ requestId: '1' })).rejects.toMatchObject({ code: 'UNSUPPORTED_OPERATION' });
  await expect(service.notebookList({ directory: '' })).rejects.toMatchObject({ code: 'SERVER_NOT_RUNNING' });
  expect(starts).toBe(0);
  expect(await service.serverStart({ requestId: '1' })).toMatchObject({ state: 'ready', nextRequestId: '2' });
  const name = `lifecycle-${Date.now()}.ipynb`;
  const created = await service.notebookCreate({ requestId: '2', directory: '', name });
  expect(created.nextRequestId).toBe('3');
  await service.notebookApply({ notebookId: created.notebook.notebookId, requestId: '3', operations: [
    { op: 'add_cell', cellType: 'markdown', source: '# Explicit lifecycle', position: 'end' }
  ] });
  const independent = await observer.notebookOpen({ path: name });
  expect(independent.summary.cells.some((cell) => cell.preview.includes('Explicit lifecycle'))).toBe(true);
  expect((await service.kernelList({})).running).toEqual([]);
  expect(starts).toBe(1);
  ready = false;
  expect(await service.serverStart({ requestId: '1' })).toMatchObject({ replayed: true, nextRequestId: '4' });
  expect(starts).toBe(1);
});
