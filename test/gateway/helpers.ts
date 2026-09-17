import { Client } from '@modelcontextprotocol/client';
import {
  InMemoryTransport,
  ProtocolError,
  Server,
  type AuthInfo,
  type JSONRPCResponse
} from '@modelcontextprotocol/server';

import type { GatewayIdentity, GatewayWorker } from '../../src/gateway/worker.js';
import {
  WorkerRegistry,
  type WorkerRegistrySettings
} from '../../src/gateway/worker-registry.js';

export const TEST_IDENTITY: GatewayIdentity = {
  issuer: 'https://issuer.example',
  subject: 'alice-subject',
  username: 'alice',
  expiresAt: Date.now() / 1000 + 3_600,
  assertion: () => 'alice-assertion'
};

export const TEST_AUTH: AuthInfo = {
  token: 'downstream-access-token',
  clientId: 'test-client',
  scopes: ['openid'],
  expiresAt: TEST_IDENTITY.expiresAt
};

export async function createProxyFixture(): Promise<{
  registry: WorkerRegistry;
  close(): Promise<void>;
}> {
  const settings: WorkerRegistrySettings = {
    allowedUsers: new Set(['alice', 'bob']),
    apiBaseUrl: 'http://jupyter.internal',
    browserBaseUrl: 'https://jupyter.example',
    assertionHeader: 'X-Jupyter-Access-Token',
    nodeCommand: process.execPath,
    upstreamCli: '/unused',
    runtimeDir: '/unused',
    maxWorkers: 2,
    maxWorkersPerPrincipal: 2,
    requestTimeoutMs: 2_000,
    expiryPollMs: 60_000
  };
  const upstreamServers: Server[] = [];
  const registry = new WorkerRegistry(settings, async (identity, digest) => {
    const upstream = new Server(
      { name: 'upstream-fixture', version: '0.0.0' },
      { capabilities: { tools: {}, resources: {} } }
    );
    upstream.setRequestHandler('tools/list', async () => ({
      tools: [
        {
          name: 'payload',
          description: 'Returns exact protocol content.',
          inputSchema: { type: 'object' },
          annotations: { readOnlyHint: true },
          _meta: { owner: identity.username }
        }
      ],
      _meta: { list_owner: identity.username }
    }));
    upstream.setRequestHandler('tools/call', async (request) => ({
      content: [
        { type: 'text', text: identity.username },
        { type: 'image', mimeType: 'image/png', data: 'aW1hZ2U=' }
      ],
      structuredContent: {
        owner: identity.username,
        arguments: request.params.arguments ?? null
      },
      isError: request.params.arguments?.['fail'] === true,
      _meta: { exact: ['opaque', 1, true] }
    }));
    upstream.setRequestHandler('resources/list', async () => ({
      resources: [
        {
          uri: `fixture://${identity.username}/output`,
          name: 'private output',
          mimeType: 'text/plain'
        }
      ]
    }));
    upstream.setRequestHandler('resources/templates/list', async () => ({
      resourceTemplates: []
    }));
    upstream.setRequestHandler('resources/read', async (request) => {
      if (request.params.uri === 'fixture://forbidden') {
        throw new ProtocolError(-32603, 'fixture protocol failure', {
          opaque: ['unchanged', 7]
        });
      }
      if (request.params.uri !== `fixture://${identity.username}/output`) {
        throw new ProtocolError(-32602, 'resource does not belong to this identity');
      }
      return {
        contents: [
          {
            uri: request.params.uri,
            mimeType: 'text/plain',
            text: `${identity.username}-private-output`
          }
        ],
        _meta: { exact_resource_meta: true }
      };
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    upstreamServers.push(upstream);
    await upstream.connect(serverTransport);
    const client = new Client(
      { name: 'gateway-proxy-tests', version: '0.0.0' },
      { versionNegotiation: { mode: 'legacy' } }
    );
    await client.connect(clientTransport);
    const worker: GatewayWorker = {
      client,
      directory: '/synthetic',
      username: identity.username,
      credentialDigest: digest,
      expiresAt: identity.expiresAt,
      close: async () => {
        await client.close();
        await upstream.close();
      }
    };
    return worker;
  });
  return {
    registry,
    close: async () => {
      await registry.close();
      await Promise.allSettled(upstreamServers.map((server) => server.close()));
    }
  };
}

export function decodeRpcResponse(response: Response): Promise<JSONRPCResponse> {
  return response.text().then((text) => {
    if (response.headers.get('content-type')?.includes('text/event-stream') === true) {
      const data = text
        .split('\n')
        .find((line) => line.startsWith('data: '))
        ?.slice('data: '.length);
      if (data === undefined) throw new Error(`Missing SSE data: ${text}`);
      return JSON.parse(data) as JSONRPCResponse;
    }
    return JSON.parse(text) as JSONRPCResponse;
  });
}
