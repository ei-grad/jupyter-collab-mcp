import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { once } from 'node:events';
import { inspect } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocketServer } from 'ws';
import * as Y from 'yjs';
import { KernelAPI, KernelConnection, ServerConnection } from '@jupyterlab/services';
import { resolveServer } from '../../src/service/credentials.js';
import { ServerRegistry } from '../../src/service/server-registry.js';
import { ServerClient } from '../../src/jupyter/server-client.js';
import { RtcConnection } from '../../src/jupyter/rtc-connection.js';
import { parseJsonBody } from '../../src/jupyter/http.js';
import type { ServerProfile } from '../../src/core/index.js';
import { withDefaults } from '../../src/core/index.js';

const secret = 'synthetic-assertion-not-a-real-credential';
const header = 'X-Jupyter-Access-Token';
const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.reverse()) await close();
  cleanup.length = 0;
});
function profile(base: string): ServerProfile {
  return { id: 'test', kind: 'standalone', apiBaseUrl: base,
    credentialRef: 'env:ASSERTION', auth: { type: 'header', name: header } };
}
function client(base: string) {
  return new ServerClient(resolveServer(profile(base), { env: { ASSERTION: secret } }));
}
async function fixture() {
  const seen: IncomingMessage[] = [];
  const server = createServer((req, res) => {
    seen.push(req);
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ kernels: 0 }));
  });
  const ws = new WebSocketServer({ server });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  cleanup.push(async () => {
    for (const socket of ws.clients) socket.terminate();
    await new Promise<void>((resolve) => ws.close(() => resolve()));
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return { server, ws, seen, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}
function assertHeader(req: IncomingMessage) {
  expect(req.headers[header.toLowerCase()]).toBe(secret);
  expect(req.headers.authorization).toBeUndefined();
  expect(req.url).not.toContain(secret);
  expect(req.url).not.toContain('token=');
}

describe('external assertion header', () => {
  it('authenticates normal REST and JupyterLab services REST', async () => {
    const f = await fixture();
    const c = client(f.base);
    await c.status();
    const settings = c.serverSettings();
    expect(settings.token).toBe('');
    expect(settings.appendToken).toBe(false);
    await ServerConnection.makeRequest(`${f.base}/api/status`, {}, settings);
    expect(f.seen).toHaveLength(2);
    f.seen.forEach(assertHeader);
    expect(JSON.stringify(c)).not.toContain(secret);
    expect(JSON.stringify(settings)).not.toContain(secret);
  });

  it('authenticates kernel WebSocket construction', async () => {
    const f = await fixture();
    const settings = client(f.base).serverSettings();
    const incoming = once(f.ws, 'connection');
    const socket = new settings.WebSocket(`${f.base.replace('http', 'ws')}/api/kernels/example/channels`);
    const opened = new Promise<void>((resolve) => socket.addEventListener('open', () => resolve()));
    cleanup.push(() => socket.close());
    const [, req] = await incoming;
    assertHeader(req as IncomingMessage);
    await opened;
  });

  it('authenticates RTC even when legacy query mode is requested', async () => {
    const f = await fixture();
    const c = client(f.base);
    const ydoc = new Y.Doc();
    const incoming = once(f.ws, 'connection');
    const rtc = new RtcConnection({
      wsBaseUrl: f.base.replace('http', 'ws'), ...c.connectionAuth(), tokenTransport: 'query',
      fileId: 'example', sessionId: 'session', ydoc,
      awarenessUser: { name: 'test', color: '#123456' }
    });
    cleanup.push(() => { rtc.dispose(); ydoc.destroy(); });
    rtc.provider.connect();
    const [, req] = await incoming;
    assertHeader(req as IncomingMessage);
    await new Promise<void>((resolve) => rtc.provider.ws!.addEventListener('open', () => resolve()));
  });

  it('refuses cross-origin REST and kernel redirects without a second request', async () => {
    const target = await fixture();
    const source = await fixture();
    source.server.removeAllListeners('request');
    source.server.on('request', (_req, res) => {
      res.writeHead(302, { Location: `${target.base}/api/status` });
      res.end();
    });
    const c = client(source.base);
    await expect(c.status()).rejects.toMatchObject({ code: 'NETWORK_ERROR' });
    await expect(ServerConnection.makeRequest(`${source.base}/api/status`, {}, c.serverSettings())).rejects.toThrow();
    expect(target.seen).toHaveLength(0);
  });

  it('refuses WebSocket redirects', async () => {
    const target = await fixture();
    const source = await fixture();
    source.server.removeAllListeners('upgrade');
    source.server.on('upgrade', (_req, socket) => {
      socket.end(`HTTP/1.1 302 Found\r\nLocation: ${target.base.replace('http', 'ws')}/channels\r\nContent-Length: 0\r\n\r\n`);
    });
    let targetConnections = 0;
    target.ws.on('connection', () => { targetConnections++; });
    const socket = new (client(source.base).serverSettings().WebSocket)(`${source.base.replace('http', 'ws')}/channels`);
    const error = await new Promise<Event>((resolve) => socket.addEventListener('error', resolve));
    expect(error).toBeDefined();
    expect(targetConnections).toBe(0);
  });

  it.each(['Authorization', 'Cookie', 'Host', 'Content-Length', 'bad\r\nname', ''])('rejects unsafe header %j', (name) => {
    expect(() => resolveServer({ ...profile('http://localhost'), auth: { type: 'header', name } },
      { env: { ASSERTION: secret } })).toThrow();
  });

  it('rejects malformed credentials without echoing them', () => {
    const malformed = `${secret}\r\ninjected`;
    try {
      resolveServer(profile('http://localhost'), { env: { ASSERTION: malformed } });
      expect.fail('accepted malformed credential');
    } catch (error) {
      expect(error).toMatchObject({ code: 'AUTH_REQUIRED' });
      expect(String(error)).not.toContain(secret);
    }
  });

  it('keeps one credential snapshot after the source rotates', async () => {
    const f = await fixture();
    const env = { ASSERTION: secret };
    const registry = new ServerRegistry(withDefaults({ servers: [profile(f.base)] }), { credentials: { env } });
    const entry = await registry.select('test');
    const c = registry.clientFor(entry);
    env.ASSERTION = 'rotated';
    await c.status();
    assertHeader(f.seen[0]!);
    expect(registry.clientFor(entry).connectionAuth()).toEqual(c.connectionAuth());
  });

  it.each([200, 403])('redacts a reflected credential from diagnostic bodies (%i)', async (status) => {
    const f = await fixture();
    f.server.removeAllListeners('request');
    f.server.on('request', (_req, res) => { res.writeHead(status); res.end(secret); });
    try {
      await client(f.base).status();
      expect.fail('expected an error');
    } catch (error) {
      expect(error).toMatchObject({ code: status === 200 ? 'INTERNAL_ERROR' : 'PERMISSION_DENIED' });
      expect(JSON.stringify(error)).not.toContain(secret);
      expect(String(error)).not.toContain(secret);
      expect(inspect(error)).not.toContain(secret);
    }
    if (status === 403) {
      const response = await client(f.base).serverSettings().fetch(`${f.base}/api/status`);
      expect(await response.text()).not.toContain(secret);
    }
  });

  it.each(['short-assertion', 'eyJhbGciOiJSUzI1NiJ9.' + 'jwt-payload'.repeat(100)])(
    'does not retain parser exceptions containing assertion fragments', (credential) => {
      try {
        parseJsonBody({ status: 200, ok: true, headers: new Headers(), text: credential,
          redactDiagnostic: (text) => text.replaceAll(credential, '<redacted>') }, '/api/status');
        expect.fail('expected parser error');
      } catch (error) {
        expect(error).toMatchObject({ code: 'INTERNAL_ERROR' });
        expect(inspect(error)).not.toContain(credential.slice(0, 20));
      }
    }
  );

  it.each(['short-assertion', 'eyJhbGciOiJSUzI1NiJ9.' + 'jwt-payload'.repeat(100)])(
    'redacts parser exceptions in the kernel library', async (credential) => {
      const c = new ServerClient(resolveServer(profile('http://localhost'), {
        env: { ASSERTION: credential }
      }), { fetchImpl: async () => new Response(credential, { status: 200 }) });
      try {
        await KernelAPI.getKernelModel('example', c.serverSettings());
        expect.fail('expected parser error');
      } catch (error) {
        expect(error).toMatchObject({ code: 'INTERNAL_ERROR' });
        expect(inspect(error)).not.toContain(credential.slice(0, 20));
      }
    }
  );
});


describe('request credential renewal', () => {
  function assertion(exp: number): string {
    return `e30.${Buffer.from(JSON.stringify({ exp })).toString('base64url')}.synthetic`;
  }

  it('refreshes REST, cached kernel settings, and an existing RTC reconnect', async () => {
    const f = await fixture();
    let credential = assertion(Date.now() / 1000 + 30);
    const first = credential;
    const c = new ServerClient(resolveServer({ ...profile(f.base), credentialRef: 'file:/private/assertion',
      credentialRefresh: 'request', credentialExpiry: 'jwt' }, { readFile: () => credential }));
    const settings = c.serverSettings();
    await c.status();
    const ydoc = new Y.Doc();
    const rtc = new RtcConnection({ wsBaseUrl: f.base.replace('http', 'ws'), ...c.connectionAuth(),
      fileId: 'example', sessionId: 'session', ydoc, awarenessUser: { name: 'test', color: '#123456' } });
    cleanup.push(() => { rtc.dispose(); ydoc.destroy(); });
    const initial = once(f.ws, 'connection');
    rtc.provider.connect();
    const [, initialRequest] = await initial;
    expect((initialRequest as IncomingMessage).headers[header.toLowerCase()]).toBe(first);
    await new Promise<void>((resolve) => rtc.provider.ws!.addEventListener('open', () => resolve()));
    credential = assertion(Date.now() / 1000 + 300);
    await c.status();
    await ServerConnection.makeRequest(`${f.base}/api/status`, {}, settings);
    const reconnected = once(f.ws, 'connection');
    rtc.provider.disconnect();
    rtc.provider.connect();
    const [, reconnectRequest] = await reconnected;
    expect((reconnectRequest as IncomingMessage).headers[header.toLowerCase()]).toBe(credential);
    const kernelConnection = once(f.ws, 'connection');
    const socket = new settings.WebSocket(`${f.base.replace('http', 'ws')}/api/kernels/example/channels`);
    cleanup.push(() => socket.close());
    const [, kernelRequest] = await kernelConnection;
    expect((kernelRequest as IncomingMessage).headers[header.toLowerCase()]).toBe(credential);
    await new Promise<void>((resolve) => socket.addEventListener('open', () => resolve()));
    expect(f.seen.map((req) => req.headers[header.toLowerCase()])).toEqual([first, credential, credential]);
    for (const req of [initialRequest, reconnectRequest, kernelRequest] as IncomingMessage[]) {
      expect(req.headers.authorization).toBeUndefined();
      expect(req.url).not.toContain('token=');
    }
  });

  it.each(['rotate', 'expire'])('revalidates credentials on each same-origin redirect (%s)', async (mode) => {
    const now = Date.now();
    const first = assertion(now / 1000 + 5);
    const second = assertion(now / 1000 + 300);
    let credential = first;
    const seen: Headers[] = [];
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
    try {
      const c = new ServerClient(resolveServer({ ...profile('http://localhost'), credentialRef: 'file:/private/assertion',
        credentialRefresh: 'request', credentialExpiry: 'jwt' }, { readFile: () => credential }), {
        fetchImpl: async (_input, init) => {
          seen.push(new Headers(init?.headers));
          if (seen.length === 1) {
            clock.mockReturnValue(now + 10_000);
            if (mode === 'rotate') credential = second;
            return new Response('', { status: 302, headers: { Location: '/redirected' } });
          }
          return Response.json({ kernels: 0 });
        }
      });
      if (mode === 'rotate') await expect(c.status()).resolves.toMatchObject({ kernels: 0 });
      else await expect(c.status()).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
      expect(seen.map((headers) => headers.get(header))).toEqual(mode === 'rotate' ? [first, second] : [first]);
      expect(seen.every((headers) => !headers.has('Authorization'))).toBe(true);
    } finally {
      clock.mockRestore();
    }
  });

  it('redacts every credential used across redirect hops', async () => {
    let credential = 'first-redirect-secret';
    let requests = 0;
    const c = new ServerClient(resolveServer({ ...profile('http://localhost'), credentialRef: 'file:/private/assertion',
      credentialRefresh: 'request' }, { readFile: () => credential }), {
      fetchImpl: async () => {
        requests++;
        if (requests === 1) {
          credential = 'second-redirect-secret';
          return new Response('', { status: 302, headers: { Location: '/redirected' } });
        }
        return new Response('first-redirect-secret second-redirect-secret', { status: 403 });
      }
    });
    try {
      await c.status();
      expect.fail('expected rejected response');
    } catch (error) {
      expect(error).toMatchObject({ code: 'PERMISSION_DENIED' });
      expect(inspect(error)).not.toContain('first-redirect-secret');
      expect(inspect(error)).not.toContain('second-redirect-secret');
    }
  });

  it('reports an uncertain mutation if credentials expire after its first redirect response', async () => {
    const now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
    let requests = 0;
    try {
      const c = new ServerClient(resolveServer({ ...profile('http://localhost'), credentialRef: 'file:/private/assertion',
        credentialRefresh: 'request', credentialExpiry: 'jwt' }, { readFile: () => assertion(now / 1000 + 5) }), {
        fetchImpl: async () => {
          requests++;
          clock.mockReturnValue(now + 10_000);
          return new Response('', { status: 307, headers: { Location: '/redirected' } });
        }
      });
      await expect(c.newUntitledNotebook()).rejects.toMatchObject({ code: 'OPERATION_UNCERTAIN' });
      expect(requests).toBe(1);
    } finally {
      clock.mockRestore();
    }
  });

  it('keeps the real kernel SDK connection reusable after assertion expiry', async () => {
    const f = await fixture();
    let credential = assertion(Date.now() / 1000 + 0.4);
    const c = new ServerClient(resolveServer({ ...profile(f.base), credentialRef: 'file:/private/assertion',
      credentialRefresh: 'request', credentialExpiry: 'jwt' }, { readFile: () => credential }));
    const initial = once(f.ws, 'connection');
    const kernel = new KernelConnection({ model: { id: 'example', name: 'python3' }, serverSettings: c.serverSettings() });
    cleanup.push(() => kernel.dispose());
    await initial;
    credential = assertion(Date.now() / 1000 + 300);
    const [, req] = await once(f.ws, 'connection');
    expect((req as IncomingMessage).headers[header.toLowerCase()]).toBe(credential);
    expect(kernel.id).toBe('example');
    expect(kernel.isDisposed).toBe(false);
  });

  it.each(['assertion', 'grant'])('closes sockets at %s expiry and makes no expired requests during a gap', async (deadlineKind) => {
    const deadline = Date.now() / 1000 + 0.4;
    const f = await fixture();
    let credential = assertion(deadlineKind === 'assertion' ? deadline : deadline + 300);
    const c = new ServerClient(resolveServer({ ...profile(f.base), credentialRef: 'file:/private/assertion',
      credentialRefresh: 'request', credentialExpiry: 'jwt',
      ...(deadlineKind === 'grant' ? { credentialExpiresAt: deadline } : {}) }, { readFile: () => credential }));
    let connections = 0;
    f.ws.on('connection', () => { connections++; });
    const settings = c.serverSettings();
    const socket = new settings.WebSocket(`${f.base.replace('http', 'ws')}/channels`);
    const closed = new Promise<CloseEvent>((resolve) => socket.addEventListener('close', resolve));
    expect((await closed).code).toBe(4000);
    await expect(c.status()).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
    const denied = new settings.WebSocket(`${f.base.replace('http', 'ws')}/channels`);
    expect((await new Promise<CloseEvent>((resolve) => denied.addEventListener('close', resolve))).code).toBe(1006);
    expect(connections).toBe(1);
    expect(f.seen).toHaveLength(0);
    credential = assertion(Date.now() / 1000 + 300);
    if (deadlineKind === 'grant') {
      await expect(c.status()).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
      return;
    }
    await c.status();
    const renewed = new settings.WebSocket(`${f.base.replace('http', 'ws')}/channels`);
    cleanup.push(() => renewed.close());
    await new Promise<void>((resolve) => renewed.addEventListener('open', () => resolve()));
    expect(connections).toBe(2);
  });

  it('rejects malformed refreshed values without leaking them or using the previous value', async () => {
    const f = await fixture();
    let value = secret;
    const c = new ServerClient(resolveServer({ ...profile(f.base), credentialRef: 'file:/private/assertion',
      credentialRefresh: 'request' }, { readFile: () => value }));
    value = secret + '\r\ninjected';
    await expect(c.status()).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
    expect(f.seen).toHaveLength(0);
  });
});


it.each([
  { credentialRefresh: 'request', credentialRef: 'env:ASSERTION' },
  { credentialRefresh: 'request', credentialRef: 'file:/private/assertion', auth: { type: 'token' } },
  { credentialExpiry: 'jwt' },
  { credentialExpiresAt: 1000 }
])('rejects unsupported refresh configuration %j', (overrides) => {
  expect(() => resolveServer({ ...profile('http://localhost'), ...overrides } as ServerProfile,
    { env: { ASSERTION: secret }, readFile: () => secret })).toThrow();
});
