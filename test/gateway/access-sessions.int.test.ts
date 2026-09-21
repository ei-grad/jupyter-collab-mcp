import type { AddressInfo } from 'node:net';

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { InMemoryTransport, Server } from '@modelcontextprotocol/server';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { afterEach, expect, it, vi } from 'vitest';

import { createCloudflareAccessGate } from '../../src/gateway/access.js';
import { loadCloudflareAccessConfig } from '../../src/gateway/config.js';
import { createGatewayHttpRuntime, type GatewayHttpRuntime } from '../../src/gateway/http.js';
import { WorkerRegistry } from '../../src/gateway/worker-registry.js';
import { credentialDigest, type GatewayWorker } from '../../src/gateway/worker.js';

let runtime: GatewayHttpRuntime | undefined;
const clients: Client[] = [];

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(clients.splice(0).map((client) => client.close()));
  await runtime?.close();
  runtime = undefined;
});

it.each([0, 3600])('binds SDK sessions to verified principals, isolates agents and renews exact assertions (TTL=%s)', async (ttl) => {
  const keys = await generateKeyPair('RS256', { extractable: true });
  const config = loadCloudflareAccessConfig({
    JUPYTER_MCP_PUBLIC_URL: 'https://mcp.example.invalid',
    JUPYTER_MCP_ACCESS_ISSUER: 'https://team.cloudflareaccess.com',
    JUPYTER_MCP_ACCESS_AUDIENCE: 'aud', JUPYTER_MCP_USERNAME_EMAIL_DOMAIN: 'example.invalid',
    JUPYTER_MCP_ALLOWED_USERS: 'alice bob', JUPYTER_MCP_API_BASE_URL: 'http://jupyter.internal',
    JUPYTER_MCP_ALLOW_MISSING_EMAIL_VERIFIED: 'true'
  });
  const gate = createCloudflareAccessGate(config, {
    getKey: createLocalJWKSet({ keys: [{ ...await exportJWK(keys.publicKey), kid: 'key', alg: 'RS256' }] })
  });
  const issue = (user: string, expired = false) => new SignJWT({ email: `${user}@example.invalid` })
    .setProtectedHeader({ alg: 'RS256', kid: 'key' }).setIssuer(config.accessIssuer)
    .setAudience('aud').setSubject(`${user}-sub`).setJti(crypto.randomUUID())
    .setExpirationTime(Math.floor(Date.now() / 1000) + (expired ? -10 : 300)).sign(keys.privateKey);
  const assertions: string[] = [];
  const { hubAdapterUrl, ...workerConfig } = config;
  const registry = new WorkerRegistry({ ...workerConfig, ...(hubAdapterUrl === undefined ? {} : { hubAdapterUrl: hubAdapterUrl.href }), apiBaseUrl: config.apiBaseUrl.href,
    browserBaseUrl: config.browserBaseUrl.href, maxWorkers: 3, maxWorkersPerPrincipal: 2
  }, async (identity, digest) => {
    assertions.push(identity.assertion());
    const upstream = new Server({ name: 'fixture', version: '1' }, { capabilities: { tools: {} } });
    upstream.setRequestHandler('tools/list', async () => ({ tools: [{ name: identity.username, inputSchema: { type: 'object' } }] }));
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await upstream.connect(serverTransport);
    const client = new Client({ name: 'fixture', version: '1' }, { versionNegotiation: { mode: 'legacy' } });
    await client.connect(clientTransport);
    const worker: GatewayWorker = {
      client, directory: '/unused', username: identity.username, credentialDigest: digest, expiresAt: identity.expiresAt,
      renew: async (fresh) => {
        assertions.push(fresh.assertion());
        Object.assign(worker, { credentialDigest: credentialDigest(fresh.assertion()), expiresAt: fresh.expiresAt });
      },
      close: async () => { await client.close(); await upstream.close(); }
    };
    return worker;
  });
  runtime = createGatewayHttpRuntime({ registry, authenticate: gate, allowedHostnames: ['127.0.0.1'],
    allowedOriginHostnames: [], accessSessionTtlSeconds: ttl, accessSessionIdleSeconds: 7200 });
  await runtime.listen(0, '127.0.0.1');
  const url = new URL(`http://127.0.0.1:${String((runtime.server.address() as AddressInfo).port)}/mcp`);
  let aliceToken = await issue('alice');
  const bobToken = await issue('bob');
  const firstToken = aliceToken;
  const raw = (token: string, session?: string) => fetch(url, {
    method: 'POST', headers: { 'cf-access-jwt-assertion': token, accept: 'application/json, text/event-stream',
      'content-type': 'application/json', 'mcp-protocol-version': '2025-11-25',
      ...(session === undefined ? {} : { 'mcp-session-id': session }) },
    body: JSON.stringify({ jsonrpc: '2.0', id: 99, method: 'tools/list' })
  });
  // Invalid headerless requests must not consume a connection slot.
  for (let i = 0; i < 4; i++) expect((await raw(aliceToken)).status).toBe(400);
  async function connect() {
    const transport = new StreamableHTTPClientTransport(url, { fetch: async (input, init) => {
      const headers = new Headers(init?.headers);
      headers.set('cf-access-jwt-assertion', aliceToken);
      return fetch(input, { ...init, headers });
    } });
    const client = new Client({ name: 'agent', version: '1' }, { versionNegotiation: { mode: 'legacy' } });
    clients.push(client);
    await client.connect(transport);
    return { client, transport };
  }
  const first = await connect();
  expect((await first.client.listTools()).tools[0]?.name).toBe('alice');
  const session = first.transport.sessionId!;
  expect(session).toBeTruthy();
  expect((await raw(bobToken, session)).status).toBe(404);
  expect((await raw('', session)).status).toBe(401);
  expect((await raw(await issue('alice', true), session)).status).toBe(401);
  expect((await raw(aliceToken, 'unknown')).status).toBe(404);
  aliceToken = await issue('alice');
  await first.client.listTools();
  expect(registry.size).toBe(1);
  expect(assertions).toEqual([firstToken, aliceToken]);
  if (ttl === 0) {
    // Only the clock is mocked: real SDK requests, signatures and transports remain active.
    vi.useFakeTimers({ toFake: ['Date'] });
    for (let hour = 0; hour < 9; hour++) {
      vi.setSystemTime(Date.now() + 60 * 60 * 1000);
      expect((await raw(aliceToken, session)).status).toBe(401);
      await registry.expire();
      expect(registry.size).toBe(1);
      aliceToken = await issue('alice');
      expect((await first.client.listTools()).tools[0]?.name).toBe('alice');
      expect(first.transport.sessionId).toBe(session);
      expect(registry.size).toBe(1);
    }
  }
  const second = await connect();
  expect(second.transport.sessionId).not.toBe(session);
  await second.client.listTools();
  expect(registry.size).toBe(2);
  expect((await raw(aliceToken)).status).toBe(429);
  await first.transport.terminateSession();
  expect((await raw(aliceToken, session)).status).toBe(404);
  expect(registry.size).toBe(1);
  expect((await fetch(new URL('/register', url))).status).toBe(404);
});

it.each([0, 3600])('reclaims abandoned sessions after idle expiry without evicting an active request (TTL=%s)', async (ttl) => {
  const { TEST_AUTH, TEST_IDENTITY, createProxyFixture } = await import('./helpers.js');
  const fixture = await createProxyFixture();
  runtime = createGatewayHttpRuntime({ registry: fixture.registry,
    authenticate: () => ({ authInfo: { ...TEST_AUTH }, identity: TEST_IDENTITY }),
    allowedHostnames: ['127.0.0.1'], allowedOriginHostnames: [],
    accessSessionTtlSeconds: ttl, accessSessionIdleSeconds: 0.1 });
  await runtime.listen(0, '127.0.0.1');
  const url = new URL(`http://127.0.0.1:${String((runtime.server.address() as AddressInfo).port)}/mcp`);
  const initialize = () => fetch(url, {
    method: 'POST', headers: { accept: 'application/json, text/event-stream', 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {
      protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'abandoned', version: '1' }
    } })
  });
  for (let cycle = 0; cycle < 2; cycle++) {
    for (let i = 0; i < 2; i++) {
      const response = await initialize();
      expect(response.status).toBe(200);
      await response.arrayBuffer();
    }
    expect((await initialize()).status).toBe(429);
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  const response = await initialize();
  expect(response.status).toBe(200);
  const session = response.headers.get('mcp-session-id')!;
  await response.arrayBuffer();
  const acquire = fixture.registry.acquire.bind(fixture.registry);
  vi.spyOn(fixture.registry, 'acquire').mockImplementationOnce(async (...args) => {
    await new Promise((resolve) => setTimeout(resolve, 250));
    return acquire(...args);
  });
  const tools = () => fetch(url, { method: 'POST', headers: {
    accept: 'application/json, text/event-stream', 'content-type': 'application/json',
    'mcp-protocol-version': '2025-11-25', 'mcp-session-id': session
  }, body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) });
  const active = await tools();
  expect(active.status).toBe(200);
  expect(await active.json()).toHaveProperty('result.tools');
  expect(fixture.registry.size).toBe(1);
  await new Promise((resolve) => setTimeout(resolve, 150));
  expect((await tools()).status).toBe(404);
  expect(fixture.registry.size).toBe(0);
  await fixture.close();
});
