import { afterEach, describe, expect, it } from 'vitest';
import type { CollabService, ServerProfile } from '../../src/core/index.js';
import { createCollabService, ServerRegistry } from '../../src/service/index.js';
import { withDefaults } from '../../src/core/index.js';
import { makeFakeHandle, makeFakeServer } from './helpers.js';
import { fromWire, toWire } from '../../src/mcp/wire.js';

const services: CollabService[] = [];
afterEach(async () => { await Promise.all(services.splice(0).map((service) => service.shutdown('client_request'))); });

function rig(adapter = false, overrides: Partial<ServerProfile> = {}) {
  let state = 'stopped';
  let user = 'alice';
  let options: Record<string, unknown> = {};
  let url = '/base/user/alice/';
  let failPost = false;
  let failed = false;
  let posts = 0;
  const calls: Array<{ route: string; method: string; headers: Headers; body: unknown }> = [];
  const fake = makeFakeServer({ files: [{ path: 'a.ipynb', type: 'notebook' }] });
  const profile: ServerProfile = {
    id: 'default', kind: 'jupyterhub',
    hub: { apiBaseUrl: `http://hub/base/hub/api${adapter ? '/faceapp/server' : ''}`, credentialRef: 'literal:hub-token',
      ...(adapter ? { protocol: 'adapter-v1', auth: { type: 'header', name: 'X-Jupyter-Access-Token' } } as const : {}) },
    ...overrides
  };
  const fetchImpl: typeof fetch = async (input, init) => {
    const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const parsed = new URL(href);
    const route = parsed.pathname + parsed.search;
    const method = init?.method ?? 'GET';
    const body: unknown = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ route, method, headers: new Headers(init?.headers), body });
    if (route.startsWith('/base/user/alice/')) {
      return fake.fetchImpl(`http://hub${route.slice('/base/user/alice'.length)}`, init);
    }
    if (route.endsWith('/progress')) return new Response(failed ? 'data: {"failed":true}\n\n' : '', { status: failed ? 200 : 400 });
    if (method === 'POST') {
      posts += 1;
      if (failPost) throw new Error('connection closed after sending hub-token');
      options = adapter ? (body as { user_options?: Record<string, unknown> })?.user_options ?? options : body as Record<string, unknown> ?? options;
      state = 'starting';
      return new Response('', { status: 202 });
    }
    if (adapter) return Response.json({ state, user, server_name: '', server_url: url, user_options: options,
      start_options: { profiles: [{ id: 'gpu', title: 'GPU', user_options: { profile: 'gpu' } }] } });
    if (route === '/base/hub/api') return Response.json({ version: '5.5.2' });
    if (route === '/base/hub/api/user?include_stopped_servers=1') return Response.json({ kind: 'user', name: user,
      servers: { '': { ready: state === 'ready', stopped: state === 'stopped', pending: state === 'starting' ? 'spawn' : state === 'stopping' ? 'stop' : null, url, user_options: options } } });
    return new Response('', { status: 404 });
  };
  const service = createCollabService({ servers: [profile], limits: { maxWaitMs: 1000 } }, { guardStdout: false, fetchImpl, openHandle: async (init) => makeFakeHandle(init).handle });
  services.push(service);
  return { service, profile, fetchImpl, calls, get posts() { return posts; },
    setState: (value: string) => { state = value; }, setOptions: (value: Record<string, unknown>) => { options = value; },
    setUser: (value: string) => { user = value; }, setUrl: (value: string) => { url = value; },
    failPost: () => { failPost = true; }, failSpawn: () => { state = 'stopped'; failed = true; } };
}

describe('explicit user-server lifecycle', () => {
  it('lists a Hub-only profile without contacting it or exposing control credentials', async () => {
    const r = rig();
    expect(await r.service.serverList()).toMatchObject({ servers: [{ descriptor: { supportsStart: true } }], nextRequestId: '1' });
    expect(r.calls).toEqual([]);
    expect(JSON.stringify(await r.service.serverList())).not.toContain('hub-token');
  });

  it.each([false, true])('starts explicitly and replay never resurrects a culled server (adapter=%s)', async (adapter) => {
    const r = rig(adapter);
    expect(await r.service.serverStatus({})).toMatchObject({ state: 'stopped', nextRequestId: '1' });
    await expect(r.service.notebookList({ directory: '' })).rejects.toMatchObject({ code: 'SERVER_NOT_RUNNING' });
    expect(r.posts).toBe(0);
    const first = await r.service.serverStart({ requestId: '1', userOptions: { profile: 'gpu' } });
    expect(first).toMatchObject({ state: 'starting', requestAccepted: true, nextRequestId: '2', replayed: false });
    r.setState('stopped');
    const count = r.calls.length;
    expect(await r.service.serverStart({ requestId: '1', userOptions: { profile: 'gpu' }, waitMs: 500 })).toMatchObject({ replayed: true, state: 'starting' });
    expect(r.calls).toHaveLength(count);
    expect(r.posts).toBe(1);
  });

  it('shares the same ledger before and after a notebook context is opened', async () => {
    const r = rig();
    await r.service.serverStart({ requestId: '1' });
    r.setState('ready');
    const opened = await r.service.notebookOpen({ path: 'a.ipynb' });
    expect(opened.nextRequestId).toBe('2');
    await r.service.notebookApply({ notebookId: opened.notebook.notebookId, requestId: '2', operations: [{ op: 'add_cell', cellType: 'markdown', source: '# lifecycle', position: 'end' }] });
    expect((await r.service.serverStatus({})).nextRequestId).toBe('3');
    expect(await r.service.serverStart({ requestId: '3' })).toMatchObject({ nextRequestId: '4' });
    expect(r.posts).toBe(1);
  });

  it('serializes repeated calls and joins matching starts from another process', async () => {
    const r = rig();
    const results = await Promise.all([1, 2].map(() => r.service.serverStart({ requestId: '1', userOptions: { profile: 'cpu' } })));
    expect(results.map((result) => result.replayed)).toEqual([false, true]);
    const other = createCollabService({ servers: [r.profile] }, { guardStdout: false, fetchImpl: r.fetchImpl });
    services.push(other);
    expect(await other.serverStart({ requestId: '1', userOptions: { profile: 'cpu' } })).toMatchObject({ state: 'starting' });
    await expect(other.serverStart({ requestId: '2', userOptions: { profile: 'gpu' } })).rejects.toMatchObject({ code: 'SERVER_OPTIONS_CONFLICT' });
    expect(r.posts).toBe(1);
  });

  it('retains an uncertain POST receipt and never retries it', async () => {
    const r = rig(); r.failPost();
    for (let attempt = 0; attempt < 2; attempt++) {
      await expect(r.service.serverStart({ requestId: '1' })).rejects.toMatchObject({ code: 'OPERATION_UNCERTAIN', details: { next_request_id: '2', request_accepted: true } });
    }
    expect(r.posts).toBe(1);
  });

  it('releases the mutation lock before waiting and wait timeout does not repost', async () => {
    const r = rig();
    const pending = r.service.serverStart({ requestId: '1', waitMs: 800 });
    while (r.posts === 0) await new Promise((resolve) => setTimeout(resolve, 1));
    const second = await r.service.serverStart({ requestId: '2' });
    expect(second).toMatchObject({ state: 'starting', nextRequestId: '3' });
    expect(await pending).toMatchObject({ state: 'starting', nextRequestId: '3' });
    expect(r.posts).toBe(1);
  });

  it.each([false, true])('fixes the verified identity across requests (adapter=%s)', async (adapter) => {
    const r = rig(adapter); await r.service.serverStatus({});
    r.setUser('bob'); r.setUrl('/base/user/bob/');
    await expect(r.service.serverStatus({})).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    expect(r.posts).toBe(0);
  });

  it.each(['http://evil/base/user/alice/', '/base/user/bob/', '/user/alice/', '/base/user/alice/?token=oops'])('rejects untrusted model URLs: %s', async (url) => {
    const r = rig(); r.setUrl(url);
    await expect(r.service.serverStatus({})).rejects.toHaveProperty('code');
    expect(r.calls.every((call) => !call.route.startsWith('/base/user/'))).toBe(true);
  });

  it.each([
    ['alice@example.com', '', '/base/user/alice@example.com/', '/users/alice@example.com/server'],
    ['alice@example.com', 'research', '/base/user/alice%40example.com/research/', '/users/alice@example.com/servers/research'],
    ["alice!()*'", "work!()", '/base/user/alice%21%28%29%2A%27/work%21%28%29/', '/users/alice%21%28%29%2A%27/servers/work%21%28%29']
  ])('uses Hub escaping for own user %s and server %s', async (user, name, url, controlRoute) => {
    const calls: string[] = [];
    let ready = true;
    const registry = new ServerRegistry(withDefaults({ servers: [{ id: 'hub', kind: 'jupyterhub', hubServerName: name,
      hub: { apiBaseUrl: 'https://hub/base/hub/api', credentialRef: 'literal:token' }
    }] }), { fetchImpl: async (input, init) => {
      const route = String(input); calls.push(route);
      if (route.endsWith('/api/status')) return Response.json({ kernels: 0 });
      if (route.endsWith('/hub/api')) return Response.json({ version: '5.5.2' });
      if (route.endsWith('/progress')) return new Response('', { status: 400 });
      if (init?.method === 'POST') { ready = true; return new Response('', { status: 201 }); }
      return Response.json({ kind: 'user', name: user, servers: { [name]: { ready, pending: null, stopped: !ready, url, user_options: {} } } });
    } });
    const entry = await registry.select();
    await registry.prepare(entry);
    expect(registry.clientFor(entry).apiBaseUrl).toBe(`https://hub${url.replace(/\/$/u, '')}`);
    expect(calls.at(-1)).toBe(`https://hub${url}api/status`);
    ready = false;
    await registry.hubFor(entry)!.start(undefined);
    expect(calls).toContain(`https://hub/base/hub/api${controlRoute}`);
  });

  it.each(['/base/user/alice%2Fresearch/', '/base/user/alice%5Cresearch/', '/base/user/alice%00/', '/base/user/%2e%2e/alice/', '/base/user/alice%252Fresearch/'])('rejects encoded separator or traversal route %s', async (url) => {
    const r = rig(); r.setUrl(url);
    await expect(r.service.serverStatus({})).rejects.toHaveProperty('code');
    expect(r.posts).toBe(0);
  });

  it('discovers adapter profiles and preserves arbitrary spawner keys', async () => {
    const r = rig(true);
    expect(await r.service.serverStatus({})).toMatchObject({ startOptions: { profiles: [{ id: 'gpu', userOptions: { profile: 'gpu' } }] } });
    await r.service.serverStart({ requestId: '1', profileId: 'gpu' });
    expect(r.calls.find((call) => call.method === 'POST')?.body).toEqual({ user_options: { profile: 'gpu' } });
    const options = { custom_snake: { customCamel: true } };
    expect(fromWire({ user_options: options })).toEqual({ userOptions: options });
    expect(toWire({ userOptions: options })).toEqual({ user_options: options });
  });

  it('reports a failed spawn from the completed progress event, never autostarts it', async () => {
    const r = rig(); r.failSpawn();
    expect(await r.service.serverStatus({})).toMatchObject({ state: 'failed' });
    expect(r.posts).toBe(0);
  });

  it('does not consume a number for unsupported standalone start or unknown profile', async () => {
    const r = rig(true);
    await expect(r.service.serverStart({ requestId: '1', profileId: 'missing' })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT', details: { request_accepted: false, next_request_id: '1' } });
    const standalone = createCollabService({ servers: [{ id: 'local', kind: 'standalone', apiBaseUrl: 'http://local', credentialRef: 'literal:local-token' }] }, { guardStdout: false });
    services.push(standalone);
    await expect(standalone.serverStart({ requestId: '1' })).rejects.toMatchObject({ code: 'UNSUPPORTED_OPERATION', details: { next_request_id: '1' } });
  });

  it('uses one request counter across server IDs and includes the target in replay identity', async () => {
    const r = rig();
    const service = createCollabService({ servers: [r.profile, { ...r.profile, id: 'second' }] }, { fetchImpl: r.fetchImpl, guardStdout: false });
    services.push(service);
    await service.serverStart({ serverId: 'default', requestId: '1' });
    await expect(service.serverStart({ serverId: 'second', requestId: '1' })).rejects.toMatchObject({ code: 'REQUEST_ID_CONFLICT' });
    expect(await service.serverStart({ serverId: 'second', requestId: '2' })).toMatchObject({ serverId: 'second', nextRequestId: '3' });
    expect((await service.serverList()).nextRequestId).toBe('3');
    expect(r.posts).toBe(1);
  });

  it('checks compact receipt capacity before accepting or sending a start', async () => {
    const r = rig();
    const service = createCollabService({ servers: [r.profile], limits: { receiptMaxBytes: 64 } }, { guardStdout: false, fetchImpl: r.fetchImpl });
    services.push(service);
    await expect(service.serverStart({ requestId: '1' })).rejects.toMatchObject({ code: 'RESOURCE_LIMIT', details: { request_accepted: false, next_request_id: '1' } });
    expect(r.posts).toBe(0);
    expect((await service.serverList()).nextRequestId).toBe('1');
  });

  it('renews control header credentials and refuses an expired assertion before sending it', async () => {
    const assertion = (expires: number) => `${Buffer.from('{}').toString('base64url')}.${Buffer.from(JSON.stringify({ exp: expires })).toString('base64url')}.signature`;
    let credential = assertion(Date.now() / 1000 + 60);
    const seen: string[] = [];
    const service = createCollabService({ servers: [{ id: 'hub', kind: 'jupyterhub', hubUser: 'alice', hub: {
      protocol: 'adapter-v1', apiBaseUrl: 'https://hub/hub/api/adapter/server', credentialRef: 'file:/fixture/assertion',
      auth: { type: 'header', name: 'X-Assertion' }, credentialRefresh: 'request', credentialExpiry: 'jwt'
    } }] }, { guardStdout: false, credentials: { readFile: () => credential }, fetchImpl: async (_input, init) => {
      seen.push(new Headers(init?.headers).get('X-Assertion')!);
      return Response.json({ state: 'stopped', user: 'alice', server_name: '', server_url: '/user/alice/', user_options: {}, start_options: { profiles: [] } });
    } });
    services.push(service);
    await service.serverStatus({});
    credential = assertion(Date.now() / 1000 + 120);
    await service.serverStatus({});
    expect(seen).toHaveLength(2);
    expect(seen[0]).not.toEqual(seen[1]);
    credential = assertion(Date.now() / 1000 - 1);
    await expect(service.serverStart({ requestId: '1' })).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
    expect(seen).toHaveLength(2);
  });
});
