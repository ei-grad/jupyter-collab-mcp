import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { AuthInfo } from '@modelcontextprotocol/server';
import { afterEach, describe, expect, it } from 'vitest';

import { createGatewayHttpRuntime, type GatewayHttpRuntime } from '../../src/gateway/http.js';
import { loadGatewayConfig } from '../../src/gateway/config.js';
import type { GatewayIdentity } from '../../src/gateway/worker.js';
import { WorkerRegistry } from '../../src/gateway/worker-registry.js';
import { decodeRpcResponse } from './helpers.js';

let runtime: GatewayHttpRuntime | undefined;
let upstream: HttpServer | undefined;
let temporaryRoot: string | undefined;

afterEach(async () => {
  await runtime?.close();
  runtime = undefined;
  if (upstream?.listening === true) {
    await new Promise<void>((resolve, reject) => {
      upstream?.close((error) => (error === undefined ? resolve() : reject(error)));
    });
  }
  upstream = undefined;
  if (temporaryRoot !== undefined) {
    await rm(temporaryRoot, { recursive: true, force: true });
    temporaryRoot = undefined;
  }
});

function identity(assertion: string): GatewayIdentity {
  return {
    issuer: 'https://issuer.example',
    subject: 'alice-subject',
    username: 'alice',
    expiresAt: Date.now() / 1000 + 300,
    assertion: () => assertion
  };
}

function auth(token: string): AuthInfo {
  return {
    token,
    clientId: 'integration-client',
    scopes: ['openid', 'email'],
    expiresAt: Date.now() / 1000 + 300
  };
}

async function rpc(
  baseUrl: string,
  token: string,
  method: string,
  params: Record<string, unknown> = {}
): Promise<Record<string, unknown>> {
  const response = await fetch(`${baseUrl}/mcp`, {
    method: 'POST',
    headers: {
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      'mcp-protocol-version': '2025-11-25'
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })
  });
  expect(response.status).toBe(200);
  const decoded = await decodeRpcResponse(response);
  if (!('result' in decoded)) throw new Error(`unexpected RPC error ${JSON.stringify(decoded)}`);
  return decoded.result as Record<string, unknown>;
}

async function call(
  baseUrl: string,
  token: string,
  name: string,
  args: Record<string, unknown> = {}
): Promise<Record<string, unknown>> {
  return rpc(baseUrl, token, 'tools/call', { name, arguments: args });
}

describe('HTTP mode with the canonical stdio CLI', () => {
  it.each([false, true])('preserves tools and grant-scoped handles (refresh=%s)', async (refresh) => {
    const assertions = ['grant-one', 'grant-two'].map((label) => refresh
      ? `e30.${Buffer.from(JSON.stringify({ exp: Date.now() / 1000 + 300, label })).toString('base64url')}.synthetic`
      : label);
    const grantExpiresAt = Date.now() / 1000 + 3600;
    const actor = (assertion: string, grantId = 'login-one'): GatewayIdentity => ({
      ...identity(assertion),
      ...(refresh ? { grantId, grantExpiresAt, grantGeneration: assertion === assertions[0] ? 0 : 1 } : {})
    });
    const seenAssertions: string[] = [];
    upstream = createServer((request, response) => {
      seenAssertions.push(String(request.headers['x-jupyter-access-token'] ?? ''));
      const body = JSON.stringify(request.url?.includes('/api/contents/')
        ? { type: 'directory', content: [] } : { kernels: 0, connections: 0 });
      response.writeHead(200, {
        'content-length': Buffer.byteLength(body),
        'content-type': 'application/json'
      });
      response.end(body);
    });
    await new Promise<void>((resolve, reject) => {
      upstream?.once('error', reject);
      upstream?.listen(0, '127.0.0.1', resolve);
    });
    const upstreamAddress = upstream.address() as AddressInfo;
    const defaults = loadGatewayConfig({
      JUPYTER_MCP_PUBLIC_URL: 'https://mcp.example',
      JUPYTER_MCP_OIDC_CONFIG_URL:
        'https://issuer.example/.well-known/openid-configuration',
      JUPYTER_MCP_OIDC_CLIENT_ID: 'gateway-client',
      JUPYTER_MCP_OIDC_CLIENT_SECRET: 'synthetic-client-secret',
      JUPYTER_MCP_REDIS_URL: 'rediss://redis.example',
      JUPYTER_MCP_STORAGE_KEY: `${Buffer.alloc(32, 9).toString('base64url')}=`,
      JUPYTER_MCP_SIGNING_KEY: 'g'.repeat(32),
      JUPYTER_MCP_REDIRECT_URIS: 'https://client.example/callback',
      JUPYTER_MCP_USERNAME_EMAIL_DOMAIN: 'example.invalid',
      JUPYTER_MCP_ALLOWED_USERS: 'alice',
      JUPYTER_MCP_API_BASE_URL: `http://127.0.0.1:${String(upstreamAddress.port)}`
    });
    temporaryRoot = await mkdtemp(join(tmpdir(), 'gateway-real-cli-'));
    const workerRoot = join(temporaryRoot, 'workers');
    const registry = new WorkerRegistry({
      allowedUsers: new Set(['alice']),
      apiBaseUrl: `http://127.0.0.1:${String(upstreamAddress.port)}`,
      browserBaseUrl: 'https://jupyter.example',
      assertionHeader: 'X-Jupyter-Access-Token',
      nodeCommand: defaults.nodeCommand,
      upstreamCli: defaults.upstreamCli,
      runtimeDir: workerRoot,
      connectTimeoutMs: 10_000,
      maxWorkers: 2,
      maxWorkersPerPrincipal: 2,
      requestTimeoutMs: 5_000,
      expiryPollMs: 60_000
    });
    runtime = createGatewayHttpRuntime({
      registry,
      allowedHostnames: ['127.0.0.1'],
      allowedOriginHostnames: [],
      authenticate: (request) => {
        const token = request.headers.get('authorization')?.replace(/^Bearer /u, '');
        if (token === 'first') return { authInfo: auth(token), identity: actor(assertions[0]!) };
        if (token === 'rotated') {
          return { authInfo: auth(token), identity: actor(assertions[1]!) };
        }
        if (token === 'independent') return { authInfo: auth(token), identity: actor(assertions[1]!, 'login-two') };
        return new Response(null, { status: 401 });
      }
    });
    await runtime.listen(0, '127.0.0.1');
    const gatewayAddress = runtime.server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${String(gatewayAddress.port)}`;

    const tools = await rpc(baseUrl, 'first', 'tools/list');
    expect(tools['tools']).toHaveLength(18);
    const first = await call(baseUrl, 'first', 'session_open');
    const sessionId = (first['structuredContent'] as Record<string, unknown>)['session_id'];
    expect(typeof sessionId).toBe('string');

    if (refresh) {
      const listed = await call(baseUrl, 'rotated', 'notebook_list', { session_id: sessionId, directory: '' });
      expect(listed['isError'] ?? false, JSON.stringify(listed)).toBe(false);
      expect(registry.size).toBe(1);
    }
    const foreign = await call(baseUrl, refresh ? 'independent' : 'rotated', 'session_close', {
      session_id: sessionId
    });
    expect(foreign['isError']).toBe(true);
    expect(JSON.stringify(foreign)).toContain('HANDLE_EXPIRED');

    const rotated = await call(baseUrl, 'rotated', 'session_open');
    const rotatedSessionId = (rotated['structuredContent'] as Record<string, unknown>)[
      'session_id'
    ];
    await call(baseUrl, 'rotated', 'session_close', { session_id: rotatedSessionId });

    const own = await call(baseUrl, refresh ? 'rotated' : 'first', 'session_close', { session_id: sessionId });
    expect(own['isError'] ?? false).toBe(false);
    expect(seenAssertions).toEqual(refresh
      ? [assertions[0], assertions[1], assertions[1], assertions[1]] : assertions);

    await runtime.close();
    runtime = undefined;
    expect(await readdir(workerRoot)).toEqual([]);
  }, 30_000);
});
