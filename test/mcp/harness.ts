/**
 * One in-memory MCP connection: the real `createMcpServer` behind the real
 * SDK client, wired through `serveStdio` so the tests run on the same
 * protocol era the CLI serves (docs/SERVICE-DESIGN.md §7.5 item 1 - only
 * `serveStdio` yields 2026-07-28, and the client pins it, so a successful
 * handshake is proof of the era).
 */

import { InMemoryTransport } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { Client } from '@modelcontextprotocol/client';

import type { CollabService } from '../../src/core/index.js';
import { createMcpServer } from '../../src/mcp/index.js';
import type { McpServerOptions } from '../../src/mcp/index.js';
import { FakeCollabService } from './fake-service.js';
import type { FakeOptions } from './fake-service.js';

/** Shape of a `tools/call` answer, as far as the tests care. */
export interface ToolAnswer {
  content: { type: string; text?: string; data?: string; mimeType?: string; uri?: string; name?: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
  _meta?: Record<string, unknown>;
}

export interface Harness {
  readonly client: Client;
  readonly fake: FakeCollabService;
  call(name: string, args?: Record<string, unknown>): Promise<ToolAnswer>;
  close(): Promise<void>;
}

export async function connect(
  options: { fake?: FakeOptions; server?: McpServerOptions; service?: CollabService } = {}
): Promise<Harness> {
  const fake = new FakeCollabService(options.fake ?? {});
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const handle = serveStdio(
    () => createMcpServer(options.service ?? fake, options.server ?? {}),
    { transport: serverTransport }
  );
  const client = new Client(
    { name: 'jupyter-collab-mcp-tests', version: '0.0.0' },
    { versionNegotiation: { mode: { pin: '2026-07-28' } } }
  );
  await client.connect(clientTransport);
  return {
    client,
    fake,
    async call(name, args = {}) {
      return (await client.callTool({ name, arguments: args })) as unknown as ToolAnswer;
    },
    async close() {
      await client.close();
      await handle.close();
    }
  };
}

/** The structured error the adapter puts into `_meta`. */
export function metaError(answer: ToolAnswer): Record<string, unknown> {
  const meta = answer._meta ?? {};
  return (meta['jupyter-collab/error'] ?? {}) as Record<string, unknown>;
}
