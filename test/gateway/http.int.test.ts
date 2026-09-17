import type { AddressInfo } from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';

import { createGatewayHttpRuntime, type GatewayHttpRuntime } from '../../src/gateway/http.js';
import {
  TEST_AUTH,
  TEST_IDENTITY,
  createProxyFixture,
  decodeRpcResponse
} from './helpers.js';

let runtime: GatewayHttpRuntime | undefined;
let closeFixture: (() => Promise<void>) | undefined;

afterEach(async () => {
  await runtime?.close();
  runtime = undefined;
  await closeFixture?.();
  closeFixture = undefined;
});

describe('gateway HTTP integration', () => {
  it('serves the framework-neutral OAuth handler on the same listener', async () => {
    const fixture = await createProxyFixture();
    closeFixture = fixture.close;
    runtime = createGatewayHttpRuntime({
      registry: fixture.registry,
      allowedHostnames: ['127.0.0.1'],
      allowedOriginHostnames: [],
      authenticate: () => new Response(null, { status: 401 }),
      oauthHandler: async (request) =>
        new URL(request.url).pathname === '/oauth-metadata'
          ? Response.json({ issuer: 'https://mcp.example' })
          : null
    });
    await runtime.listen(0, '127.0.0.1');
    const address = runtime.server.address() as AddressInfo;
    const response = await fetch(
      `http://127.0.0.1:${String(address.port)}/oauth-metadata`
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ issuer: 'https://mcp.example' });
  });

  it('authenticates MCP, validates browser origins and shuts down owned workers', async () => {
    const fixture = await createProxyFixture();
    closeFixture = fixture.close;
    runtime = createGatewayHttpRuntime({
      registry: fixture.registry,
      allowedHostnames: ['127.0.0.1'],
      allowedOriginHostnames: ['client.example'],
      authenticate: (request) =>
        request.headers.get('authorization') === 'Bearer accepted'
          ? { authInfo: TEST_AUTH, identity: TEST_IDENTITY }
          : new Response(JSON.stringify({ error: 'invalid_token' }), {
              status: 401,
              headers: {
                'content-type': 'application/json',
                'www-authenticate': 'Bearer'
              }
            })
    });
    await runtime.listen(0, '127.0.0.1');
    const address = runtime.server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${String(address.port)}`;

    expect(await (await fetch(`${baseUrl}/healthcheck`)).json()).toEqual({ status: 'ok' });
    const preflight = await fetch(`${baseUrl}/mcp`, {
      method: 'OPTIONS',
      headers: {
        origin: 'https://client.example',
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'authorization, mcp-protocol-version'
      }
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('access-control-allow-origin')).toBe(
      'https://client.example'
    );
    expect(preflight.headers.get('access-control-allow-methods')).toContain('POST');
    expect(preflight.headers.get('access-control-allow-headers')).toContain(
      'mcp-protocol-version'
    );

    const denied = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        origin: 'https://client.example',
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json'
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })
    });
    expect(denied.status).toBe(401);
    expect(denied.headers.get('www-authenticate')).toBe('Bearer');
    expect(denied.headers.get('access-control-allow-origin')).toBe(
      'https://client.example'
    );

    const rejectedOrigin = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        origin: 'https://attacker.invalid',
        authorization: 'Bearer accepted',
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json'
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })
    });
    expect(rejectedOrigin.status).toBe(403);
    expect(rejectedOrigin.headers.has('access-control-allow-origin')).toBe(false);

    const accepted = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        origin: 'https://client.example',
        authorization: 'Bearer accepted',
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
        'mcp-protocol-version': '2025-11-25'
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })
    });
    expect(accepted.status).toBe(200);
    expect(accepted.headers.get('access-control-allow-origin')).toBe(
      'https://client.example'
    );
    const response = await decodeRpcResponse(accepted);
    expect('result' in response && response.result.tools).toHaveLength(1);

    await runtime.close();
    expect(fixture.registry.closed).toBe(true);
    expect(fixture.registry.size).toBe(0);
    runtime = undefined;
    closeFixture = undefined;
  });

  it('does not expose one principal resource through another principal worker', async () => {
    const fixture = await createProxyFixture();
    closeFixture = fixture.close;
    const bobIdentity = {
      ...TEST_IDENTITY,
      subject: 'bob-subject',
      username: 'bob',
      assertion: () => 'bob-assertion'
    };
    const bobAuth = {
      ...TEST_AUTH,
      token: 'bob-downstream-token',
      expiresAt: bobIdentity.expiresAt
    };
    runtime = createGatewayHttpRuntime({
      registry: fixture.registry,
      allowedHostnames: ['127.0.0.1'],
      allowedOriginHostnames: [],
      authenticate: (request) =>
        request.headers.get('authorization') === 'Bearer alice'
          ? { authInfo: TEST_AUTH, identity: TEST_IDENTITY }
          : { authInfo: bobAuth, identity: bobIdentity }
    });
    await runtime.listen(0, '127.0.0.1');
    const address = runtime.server.address() as AddressInfo;
    const endpoint = `http://127.0.0.1:${String(address.port)}/mcp`;
    let requestId = 0;
    const rpc = async (
      bearer: 'alice' | 'bob',
      method: string,
      params: Record<string, unknown>
    ) => decodeRpcResponse(await fetch(endpoint, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${bearer}`,
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
        'mcp-protocol-version': '2025-11-25'
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++requestId, method, params })
    }));

    const aliceResources = await rpc('alice', 'resources/list', {});
    const bobResources = await rpc('bob', 'resources/list', {});
    expect(JSON.stringify(aliceResources)).toContain('fixture://alice/output');
    expect(JSON.stringify(aliceResources)).not.toContain('fixture://bob/output');
    expect(JSON.stringify(bobResources)).toContain('fixture://bob/output');
    expect(JSON.stringify(bobResources)).not.toContain('fixture://alice/output');

    const crossPrincipal = await rpc('bob', 'resources/read', {
      uri: 'fixture://alice/output'
    });
    expect(crossPrincipal).toHaveProperty('error');
    expect(JSON.stringify(crossPrincipal)).not.toContain('alice-private-output');
  });
});
