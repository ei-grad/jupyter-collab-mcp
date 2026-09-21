import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

import { createGatewayProxyHandler } from '../../src/gateway/proxy-server.js';
import {
  TEST_AUTH,
  TEST_IDENTITY,
  createProxyFixture,
  decodeRpcResponse
} from './helpers.js';

let closeFixture: (() => Promise<void>) | undefined;

afterEach(async () => {
  await closeFixture?.();
  closeFixture = undefined;
});

async function call(method: string, params: Record<string, unknown> = {}) {
  const fixture = await createProxyFixture();
  closeFixture = fixture.close;
  const handler = createGatewayProxyHandler(fixture.registry, (authInfo) => {
    if (authInfo !== TEST_AUTH) throw new Error('wrong authentication object');
    return TEST_IDENTITY;
  });
  const response = await handler.fetch(
    new Request('http://gateway.invalid/mcp', {
      method: 'POST',
      headers: {
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
        'mcp-protocol-version': '2025-11-25'
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })
    }),
    { authInfo: TEST_AUTH }
  );
  return decodeRpcResponse(response);
}

describe('gateway MCP proxy', () => {
  it('reports the package version during HTTP initialization', async () => {
    const version = (JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string }).version;
    const initialized = await call('initialize', {
      protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'release-test', version: '1' }
    });
    expect('result' in initialized && initialized.result).toMatchObject({ serverInfo: { version } });
  });
  it('preserves tool definitions, content, structured output, metadata and errors', async () => {
    const listed = await call('tools/list');
    expect('result' in listed && listed.result).toEqual({
      tools: [
        {
          name: 'payload',
          description: 'Returns exact protocol content.',
          inputSchema: { type: 'object' },
          annotations: { readOnlyHint: true },
          _meta: { owner: 'alice' }
        }
      ],
      _meta: { list_owner: 'alice' }
    });

    await closeFixture?.();
    closeFixture = undefined;
    const called = await call('tools/call', {
      name: 'payload',
      arguments: { fail: true, opaque: ['unchanged'] }
    });
    expect('result' in called && called.result).toEqual({
      content: [
        { type: 'text', text: 'alice' },
        { type: 'image', mimeType: 'image/png', data: 'aW1hZ2U=' }
      ],
      structuredContent: {
        owner: 'alice',
        arguments: { fail: true, opaque: ['unchanged'] }
      },
      isError: true,
      _meta: { exact: ['opaque', 1, true] }
    });
  });

  it('preserves owner-specific resource listing and contents', async () => {
    const listed = await call('resources/list');
    expect('result' in listed && listed.result).toEqual({
      resources: [
        {
          uri: 'fixture://alice/output',
          name: 'private output',
          mimeType: 'text/plain'
        }
      ]
    });
    await closeFixture?.();
    closeFixture = undefined;
    const read = await call('resources/read', { uri: 'fixture://alice/output' });
    expect('result' in read && read.result).toEqual({
      contents: [
        {
          uri: 'fixture://alice/output',
          mimeType: 'text/plain',
          text: 'alice-private-output'
        }
      ],
      _meta: { exact_resource_meta: true }
    });
  });

  it('preserves upstream protocol error code, message and data', async () => {
    const failed = await call('resources/read', { uri: 'fixture://forbidden' });
    expect('error' in failed && failed.error).toEqual({
      code: -32603,
      message: 'fixture protocol failure',
      data: { opaque: ['unchanged', 7] }
    });
  });
});
