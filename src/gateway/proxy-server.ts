import type { AuthInfo, ServerContext } from '@modelcontextprotocol/server';
import {
  Server,
  createMcpHandler,
  specTypeSchemas,
  type McpHttpHandler
} from '@modelcontextprotocol/server';

import type { GatewayIdentity } from './worker.js';
import type { WorkerRegistry } from './worker-registry.js';

export type IdentityResolver = (
  authInfo: AuthInfo | undefined
) => GatewayIdentity | Promise<GatewayIdentity>;

export interface GatewayProxyOptions {
  readonly name?: string;
  readonly version?: string;
  readonly instructions?: string;
  readonly onerror?: (error: Error) => void;
}

function requestOptions(registry: WorkerRegistry, context: ServerContext) {
  return {
    signal: context.mcpReq.signal,
    timeout: registry.settings.requestTimeoutMs,
    maxTotalTimeout: registry.settings.requestTimeoutMs,
    allowInputRequired: true
  } as const;
}

export function createGatewayProxyHandler(
  registry: WorkerRegistry,
  resolveIdentity: IdentityResolver,
  options: GatewayProxyOptions = {}
): McpHttpHandler {
  return createMcpHandler(
    async ({ authInfo }) => {
      const identity = registry.validate(await resolveIdentity(authInfo));
      return createGatewayProxyServer(registry, () => identity, options);
    },
    {
      responseMode: 'json',
      ...(options.onerror === undefined ? {} : { onerror: options.onerror })
    }
  );
}

export function createGatewayProxyServer(
  registry: WorkerRegistry,
  resolveIdentity: (context: ServerContext) => GatewayIdentity,
  options: GatewayProxyOptions = {}
): Server {
  const server = new Server(
    {
      name: options.name ?? 'jupyter-collab-mcp-http',
      version: options.version ?? '0.1.0'
    },
    {
      capabilities: { tools: {}, resources: {} },
      instructions:
        options.instructions ??
        'Live Jupyter notebooks for the authenticated account. Use server_list for server selection and the current next_request_id, then notebook_open or notebook_create to obtain a notebook handle. One automatic working context owns this connection.'
    }
  );

  server.setRequestHandler('tools/list', (request, context) =>
    registry.withClient(resolveIdentity(context), context.mcpReq.signal, (client) =>
      client.request(
        request,
        specTypeSchemas.ListToolsResult,
        requestOptions(registry, context)
      )
    )
  );
  server.setRequestHandler('tools/call', (request, context) =>
    registry.withClient(resolveIdentity(context), context.mcpReq.signal, (client) =>
      client.request(
        request,
        specTypeSchemas.CallToolResult,
        requestOptions(registry, context)
      )
    )
  );
  server.setRequestHandler('resources/list', (request, context) =>
    registry.withClient(resolveIdentity(context), context.mcpReq.signal, (client) =>
      client.request(
        request,
        specTypeSchemas.ListResourcesResult,
        requestOptions(registry, context)
      )
    )
  );
  server.setRequestHandler('resources/templates/list', (request, context) =>
    registry.withClient(resolveIdentity(context), context.mcpReq.signal, (client) =>
      client.request(
        request,
        specTypeSchemas.ListResourceTemplatesResult,
        requestOptions(registry, context)
      )
    )
  );
  server.setRequestHandler('resources/read', (request, context) =>
    registry.withClient(resolveIdentity(context), context.mcpReq.signal, (client) =>
      client.request(
        request,
        specTypeSchemas.ReadResourceResult,
        requestOptions(registry, context)
      )
    )
  );
  return server;
}
