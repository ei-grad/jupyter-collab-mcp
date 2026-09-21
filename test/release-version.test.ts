import { readFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { expect, it } from 'vitest';
import { createGatewayProxyServer } from '../src/gateway/proxy-server.js';
import type { WorkerRegistry } from '../src/gateway/worker-registry.js';
import { connect } from './mcp/harness.js';

const declaredVersion = (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }).version;

it.each([undefined, 'embedding-version'])('uses package metadata or an explicit library version %s', async (version) => {
  const harness = await connect({ server: version === undefined ? {} : { version } });
  try { expect(harness.client.getServerVersion()?.version).toBe(version ?? declaredVersion); }
  finally { await harness.close(); }
});

it.each([undefined, 'embedding-version'])('uses package metadata or an explicit gateway version %s', async (version) => {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createGatewayProxyServer({} as WorkerRegistry,
    () => { throw new Error('initialization must not acquire a worker'); }, version === undefined ? {} : { version });
  const client = new Client({ name: 'release-test', version: '1' }, { versionNegotiation: { mode: 'legacy' } });
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    expect(client.getServerVersion()?.version).toBe(version ?? declaredVersion);
  } finally { await client.close(); await server.close(); }
});
