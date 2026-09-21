import type { IncomingMessage, ServerResponse } from 'node:http';

import { afterEach, describe, expect, it } from 'vitest';

import type { CollabService, ServerProfile } from '../../src/core/index.js';
import { createCollabService } from '../../src/service/index.js';
import { sendJson, startHttpStub, type HttpStub } from './helpers/http-stub.js';

const services: CollabService[] = [];
const stubs: HttpStub[] = [];
const API = '/prefix/hub/api';

afterEach(async () => {
  await Promise.all(services.splice(0).map(service => service.shutdown('client_request')));
  await Promise.all(stubs.splice(0).map(stub => stub.close()));
});

type State = 'stopped' | 'starting' | 'ready';
type Options = Record<string, unknown>;
type PostHandler = (request: IncomingMessage, response: ServerResponse, body: string) => void;
interface UserAccess {
  selectedVisible: boolean;
  scopes?: readonly string[];
  groups?: readonly string[];
  otherServers?: Record<string, unknown>;
}

async function fixture(version = '5.5.2', name = '') {
  let state: State = 'stopped';
  let options: Options = {};
  let failed = false;
  let modelStatus = 200;
  let access: UserAccess = { selectedVisible: true };
  let returnedUrl = `/prefix/user/alice/${name ? `${name}/` : ''}`;
  const startRoute = `${API}/users/alice/${name ? `servers/${name}` : 'server'}`;
  let postHandler: PostHandler = (_request, response, body) => {
    const parsed = body ? JSON.parse(body) as Options : undefined;
    if (parsed !== undefined) options = version.startsWith('6.') ? parsed['user_options'] as Options : parsed;
    state = 'starting';
    response.writeHead(202).end();
  };
  const stub = await startHttpStub((request, response, body) => {
    if (request.url === API && request.method === 'GET') {
      sendJson(response, 200, { version });
    } else if (request.url === `${API}/user?include_stopped_servers=1` && request.method === 'GET') {
      sendJson(response, modelStatus, {
        kind: 'user', name: 'alice',
        ...(access.scopes === undefined ? {} : { scopes: access.scopes }),
        ...(access.groups === undefined ? {} : { groups: access.groups }),
        servers: { ...access.otherServers, ...(access.selectedVisible ? {
          [name]: {
            ready: state === 'ready', stopped: state === 'stopped',
            pending: state === 'starting' ? 'spawn' : null,
            url: returnedUrl, user_options: options
          }
        } : {}) }
      });
    } else if (request.url === `${startRoute}/progress` && request.method === 'GET') {
      response.writeHead(failed ? 200 : 400, { 'content-type': 'text/event-stream' });
      response.end(failed ? 'data: {"failed":true,"message":"spawn failed"}\n\n' : '');
    } else if (request.url === startRoute && request.method === 'POST') {
      postHandler(request, response, body);
    } else {
      sendJson(response, 404, { message: 'Unknown fixture route' });
    }
  });
  stubs.push(stub);
  const create = (overrides: Partial<ServerProfile> = {}) => {
    const service = createCollabService({ servers: [{
      id: 'hub', kind: 'jupyterhub',
      hub: { apiBaseUrl: `${stub.baseUrl}${API}`, credentialRef: 'literal:test' },
      ...(name ? { hubServerName: name } : {}), ...overrides
    }] }, { guardStdout: false });
    services.push(service);
    return service;
  };
  return {
    stub, startRoute, create,
    get posts() { return stub.requests.filter(request => request.method === 'POST'); },
    setState(value: State, userOptions: Options = options) { state = value; options = userOptions; },
    setPost(handler: PostHandler) { postHandler = handler; },
    setModelStatus(status: number) { modelStatus = status; },
    setAccess(value: UserAccess) { access = value; },
    setUrl(url: string) { returnedUrl = url; },
    failSpawn() { failed = true; state = 'stopped'; }
  };
}

describe('standard Hub lifecycle over real HTTP', () => {
  it('does not infer a hidden default server is stopped from a research-only SelfAPI response', async () => {
    const f = await fixture();
    f.setState('starting');
    f.setAccess({ selectedVisible: false, scopes: ['read:servers!server=alice/research'], otherServers: {
      research: { ready: true, stopped: false, pending: null, url: '/prefix/user/alice/research/', user_options: {} }
    } });
    const service = f.create();
    await expect(service.serverStatus({})).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    await expect(service.serverStart({ requestId: '1' })).rejects.toMatchObject({
      code: 'PERMISSION_DENIED', details: { request_accepted: false, next_request_id: '1' }
    });
    expect(await service.serverList()).toMatchObject({ nextRequestId: '1' });
    expect(f.posts).toHaveLength(0);
    expect(f.stub.requests.every(request => request.url === `${API}/user?include_stopped_servers=1`)).toBe(true);
  });

  it.each(['', 'research'])('permits a genuinely absent own server %s with authoritative read scopes', async name => {
    for (const scope of ['read:servers', 'read:servers!user=alice', `read:servers!server=alice/${name}`]) {
      const f = await fixture('5.5.2', name);
      f.setAccess({ selectedVisible: false, scopes: [scope] });
      const service = f.create();
      expect(await service.serverStatus({})).toMatchObject({ state: 'stopped', hubUser: 'alice', hubServerName: name });
      f.setPost((_request, response) => {
        f.setAccess({ selectedVisible: true, scopes: [scope] });
        f.setState('starting');
        response.writeHead(202).end();
      });
      expect(await service.serverStart({ requestId: '1' })).toMatchObject({ state: 'starting', requestAccepted: true });
      expect(f.posts).toHaveLength(1);
      expect(f.posts[0]?.url).toBe(f.startRoute);
    }
  });

  it.each([
    undefined, [], ['servers!user=alice'], ['read:users!user=alice'],
    ['read:servers!user=bob'], ['read:servers!server=bob/research'],
    ['read:servers!server=alice/other'], ['read:servers!server=alice/']
  ])('denies an absent research server when scopes do not prove visibility: %j', async scopes => {
    const f = await fixture('5.5.2', 'research');
    f.setAccess({ selectedVisible: false, ...(scopes === undefined ? {} : { scopes }) });
    const service = f.create();
    await expect(service.serverStatus({})).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    await expect(service.serverStart({ requestId: '1' })).rejects.toMatchObject({
      code: 'PERMISSION_DENIED', details: { request_accepted: false, next_request_id: '1' }
    });
    expect(await service.serverList()).toMatchObject({ nextRequestId: '1' });
    expect(f.posts).toHaveLength(0);
  });

  it.each([undefined, [], ['other-team'], ['researchers']])('requires verified own membership for a group read scope: %j', async groups => {
    const f = await fixture('5.5.2', 'research');
    const access: UserAccess = {
      selectedVisible: false, scopes: ['read:servers!group=researchers'],
      ...(groups === undefined ? {} : { groups })
    };
    f.setAccess(access);
    const service = f.create();
    if (!groups?.includes('researchers')) {
      await expect(service.serverStatus({})).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
      await expect(service.serverStart({ requestId: '1' })).rejects.toMatchObject({
        code: 'PERMISSION_DENIED', details: { request_accepted: false, next_request_id: '1' }
      });
      expect(f.posts).toHaveLength(0);
    } else {
      expect(await service.serverStatus({})).toMatchObject({ state: 'stopped' });
      f.setPost((_request, response) => {
        f.setAccess({ ...access, selectedVisible: true });
        f.setState('starting');
        response.writeHead(202).end();
      });
      expect(await service.serverStart({ requestId: '1' })).toMatchObject({ state: 'starting' });
      expect(f.posts).toHaveLength(1);
    }
  });

  it.each([
    ['5.5.2', ''], ['5.5.2', 'research'], ['6.0.0', ''], ['6.0.0', 'research']
  ])('uses Hub %s option encoding and own-server route %s', async (version, name) => {
    const f = await fixture(version, name);
    const service = f.create();
    expect(await service.serverList()).toMatchObject({ nextRequestId: '1' });
    expect(f.stub.requests).toHaveLength(0);
    expect(await service.serverStatus({})).toMatchObject({
      state: 'stopped', hubUser: 'alice', hubServerName: name, nextRequestId: '1'
    });
    const userOptions = { profile: 'gpu', custom_snake: { customCamel: true }, values: [1, 'two', null] };
    expect(await service.serverStart({ requestId: '1', userOptions })).toMatchObject({
      state: 'starting', nextRequestId: '2', requestAccepted: true
    });
    expect(await service.serverList()).toMatchObject({ nextRequestId: '2' });
    expect(f.posts).toHaveLength(1);
    expect(f.posts[0]?.url).toBe(f.startRoute);
    expect(JSON.parse(f.posts[0]!.body)).toEqual(version.startsWith('6.') ? { user_options: userOptions } : userOptions);
    expect(f.stub.requests.some(request => request.url === API)).toBe(true);
    expect(f.stub.requests.every(request => request.authorization === 'token test')).toBe(true);
    expect(f.stub.requests.every(request => request.url.startsWith(API) && !request.url.includes('token='))).toBe(true);
    expect(await service.serverStatus({})).toMatchObject({ userOptions });
  });

  it.each(['5.5.2', '6.0.0'])('preserves omitted options separately from an explicit empty object on Hub %s', async version => {
    const f = await fixture(version);
    const service = f.create();
    await service.serverStart({ requestId: '1' });
    expect(f.posts[0]?.body).toBe('');
    f.setState('stopped');
    await service.serverStart({ requestId: '2', userOptions: {} });
    expect(JSON.parse(f.posts[1]!.body)).toEqual(version.startsWith('6.') ? { user_options: {} } : {});
  });

  it.each(['ready', 'starting'] as const)('joins an existing %s server without a version lookup or POST', async state => {
    const f = await fixture();
    f.setState(state, { profile: 'cpu', hub_default: true });
    const service = f.create();
    expect(await service.serverStart({ requestId: '1' })).toMatchObject({ state });
    expect(await service.serverStart({ requestId: '2', userOptions: { profile: 'cpu' } })).toMatchObject({ state });
    await expect(service.serverStart({ requestId: '3', userOptions: { profile: 'gpu' } }))
      .rejects.toMatchObject({ code: 'SERVER_OPTIONS_CONFLICT' });
    expect(f.posts).toHaveLength(0);
    expect(f.stub.requests.every(request => request.url === `${API}/user?include_stopped_servers=1`)).toBe(true);
  });

  it.each(['ready', 'starting'] as const)('rereads a concurrent start after HTTP 400 and joins matching %s state', async state => {
    const f = await fixture();
    const service = f.create();
    f.setPost((_request, response) => {
      f.setState(state, { profile: 'cpu' });
      sendJson(response, 400, { message: 'Server is already running or pending' });
    });
    expect(await service.serverStart({ requestId: '1', userOptions: { profile: 'cpu' } }))
      .toMatchObject({ state, nextRequestId: '2' });
    expect(f.posts).toHaveLength(1);
    expect(f.stub.requests.at(-1)?.url).toBe(`${API}/user?include_stopped_servers=1`);
  });

  it('retains the HTTP 400 rejection when the concurrently started profile differs', async () => {
    const f = await fixture();
    const service = f.create();
    f.setPost((_request, response) => {
      f.setState('starting', { profile: 'gpu' });
      sendJson(response, 400, { message: 'Spawn pending' });
    });
    for (let attempt = 0; attempt < 2; attempt++) {
      await expect(service.serverStart({ requestId: '1', userOptions: { profile: 'cpu' } }))
        .rejects.toMatchObject({ code: 'SERVER_OPTIONS_CONFLICT' });
    }
    expect(f.posts).toHaveLength(1);
  });

  it('returns HTTP 202 pending at the wait deadline and never resends its accepted receipt', async () => {
    const f = await fixture('6.0.0');
    const service = f.create();
    expect(await service.serverStart({ requestId: '1', waitMs: 30 })).toMatchObject({ state: 'starting' });
    f.setState('stopped');
    const requests = f.stub.requests.length;
    expect(await service.serverStart({ requestId: '1', waitMs: 500 })).toMatchObject({ state: 'starting', replayed: true });
    expect(f.stub.requests).toHaveLength(requests);
    expect(f.posts).toHaveLength(1);
  });

  it('reports a failed progress event after accepted spawn without automatically starting again', async () => {
    const f = await fixture();
    const service = f.create();
    f.setPost((_request, response) => { f.failSpawn(); response.writeHead(202).end(); });
    expect(await service.serverStart({ requestId: '1' })).toMatchObject({ state: 'failed' });
    expect(await service.serverStatus({})).toMatchObject({ state: 'failed' });
    expect(await service.serverStart({ requestId: '1' })).toMatchObject({ state: 'failed', replayed: true });
    expect(f.posts).toHaveLength(1);
  });

  it.each(['connection_loss', 'status_unavailable'] as const)('does not repeat an uncertain POST after %s', async failure => {
    const f = await fixture();
    const service = f.create();
    f.setPost((request, response) => {
      if (failure === 'connection_loss') request.socket.destroy();
      else { f.setModelStatus(503); response.writeHead(202).end(); }
    });
    for (let attempt = 0; attempt < 2; attempt++) {
      await expect(service.serverStart({ requestId: '1' })).rejects.toMatchObject({
        code: 'OPERATION_UNCERTAIN', details: { request_accepted: true, next_request_id: '2' }
      });
    }
    expect(f.posts).toHaveLength(1);
  });

  it('does not follow authenticated Hub redirects to another origin', async () => {
    const target = await startHttpStub((_request, response) => sendJson(response, 200, {}));
    stubs.push(target);
    const f = await fixture();
    f.stub.setHandler((_request, response) => response.writeHead(302, { location: `${target.baseUrl}/stolen` }).end());
    await expect(f.create().serverStatus({})).rejects.toHaveProperty('code');
    expect(target.requests).toHaveLength(0);
    expect(f.stub.requests).toHaveLength(1);
  });

  it('rejects a foreign server model URL without sending credentials there', async () => {
    const target = await startHttpStub((_request, response) => sendJson(response, 200, {}));
    stubs.push(target);
    const f = await fixture();
    f.setState('ready');
    f.setUrl(`${target.baseUrl}/prefix/user/alice/`);
    await expect(f.create().serverStart({ requestId: '1' })).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    expect(target.requests).toHaveLength(0);
    expect(f.posts).toHaveLength(0);
  });

  it('keeps control-plane credentials off a separately configured notebook origin', async () => {
    const data = await startHttpStub((request, response) => {
      if (request.url === '/notebook/api/status') sendJson(response, 200, { kernels: 0 });
      else if (request.url?.startsWith('/notebook/api/contents')) sendJson(response, 200, { type: 'directory', path: '', content: [] });
      else if (request.url === '/notebook/api/sessions') sendJson(response, 200, []);
      else sendJson(response, 404, {});
    });
    stubs.push(data);
    const f = await fixture();
    f.setState('ready');
    const service = f.create({ apiBaseUrl: `${data.baseUrl}/notebook`, credentialRef: 'literal:data-test' });
    expect(await service.notebookList({ directory: '' })).toMatchObject({ entries: [] });
    expect(data.requests.length).toBeGreaterThan(0);
    expect(data.requests.every(request => request.authorization === 'token data-test' && request.url.startsWith('/notebook/api/'))).toBe(true);
    expect(f.stub.requests.every(request => request.authorization === 'token test' && request.url.startsWith(API))).toBe(true);
    expect(f.posts).toHaveLength(0);
  });
});
