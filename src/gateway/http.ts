import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'node:http';

import { toNodeHandler, hostHeaderValidation, originValidation } from '@modelcontextprotocol/node';
import type { AuthInfo, McpHttpHandler } from '@modelcontextprotocol/server';

import { createGatewayProxyHandler, type GatewayProxyOptions } from './proxy-server.js';
import type { GatewayIdentity } from './worker.js';
import type { WorkerRegistry } from './worker-registry.js';

export interface GatewayAuthentication {
  readonly authInfo: AuthInfo;
  readonly identity: GatewayIdentity;
}

export type GatewayAuthGate = (
  request: Request
) => GatewayAuthentication | Response | Promise<GatewayAuthentication | Response>;

export type GatewayNodeHandler = (
  request: IncomingMessage,
  response: ServerResponse
) => void | Promise<void>;

export type GatewayOAuthHandler = (request: Request) => Promise<Response | null>;

export interface GatewayHttpOptions {
  readonly registry: WorkerRegistry;
  readonly authenticate: GatewayAuthGate;
  readonly allowedHostnames: readonly string[];
  readonly allowedOriginHostnames: readonly string[];
  readonly mcpPath?: string;
  readonly oauthHandler?: GatewayOAuthHandler;
  readonly closeAuth?: () => Promise<void>;
  readonly isReady?: () => boolean | Promise<boolean>;
  readonly proxy?: GatewayProxyOptions;
  readonly onerror?: (error: Error) => void;
}

export interface GatewayHttpRuntime {
  readonly server: HttpServer;
  readonly proxy: McpHttpHandler;
  listen(port: number, host: string): Promise<void>;
  close(): Promise<void>;
}

function respondJson(
  response: ServerResponse,
  status: number,
  body: Readonly<Record<string, unknown>>
): void {
  response.writeHead(status, {
    'content-type': 'application/json',
    'cache-control': 'no-store'
  });
  response.end(JSON.stringify(body));
}

function closeHttpServer(server: HttpServer): Promise<void> {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
}

function exposeMcpCors(request: IncomingMessage, response: ServerResponse): void {
  const origin = request.headers.origin;
  if (origin === undefined) return;
  response.setHeader('access-control-allow-origin', origin);
  response.setHeader('vary', 'Origin');
}

function respondMcpPreflight(response: ServerResponse): void {
  response.writeHead(204, {
    'access-control-allow-methods': 'POST, DELETE, OPTIONS',
    'access-control-allow-headers': [
      'authorization',
      'content-type',
      'accept',
      'mcp-protocol-version',
      'mcp-session-id',
      'last-event-id'
    ].join(', ')
  });
  response.end();
}

export function createGatewayHttpRuntime(options: GatewayHttpOptions): GatewayHttpRuntime {
  const identities = new WeakMap<AuthInfo, GatewayIdentity>();
  const proxy = createGatewayProxyHandler(
    options.registry,
    (authInfo) => {
      if (authInfo === undefined) throw new Error('Authenticated identity required');
      const identity = identities.get(authInfo);
      if (identity === undefined) throw new Error('Authenticated identity required');
      return identity;
    },
    {
      ...options.proxy,
      ...((options.proxy?.onerror ?? options.onerror) === undefined
        ? {}
        : { onerror: options.proxy?.onerror ?? options.onerror })
    }
  );
  const nodeMcp = toNodeHandler(
    {
      fetch: async (request, handlerOptions) => {
        const authentication = await options.authenticate(request);
        if (authentication instanceof Response) return authentication;
        identities.set(authentication.authInfo, authentication.identity);
        try {
          return await proxy.fetch(request, {
            ...handlerOptions,
            authInfo: authentication.authInfo
          });
        } finally {
          identities.delete(authentication.authInfo);
        }
      }
    },
    { ...(options.onerror === undefined ? {} : { onerror: options.onerror }) }
  );
  const nodeOAuth =
    options.oauthHandler === undefined
      ? undefined
      : toNodeHandler(
          {
            fetch: async (request) =>
              (await options.oauthHandler?.(request)) ??
              new Response(JSON.stringify({ error: 'not_found' }), {
                status: 404,
                headers: {
                  'cache-control': 'no-store',
                  'content-type': 'application/json'
                }
              })
          },
          { ...(options.onerror === undefined ? {} : { onerror: options.onerror }) }
        );
  const validateHost = hostHeaderValidation([...options.allowedHostnames]);
  const validateOrigin = originValidation([...options.allowedOriginHostnames]);
  const sweepAbort = new AbortController();
  const sweep = options.registry.sweep(sweepAbort.signal).catch((error: unknown) => {
    options.onerror?.(error instanceof Error ? error : new Error(String(error)));
  });
  let closing: Promise<void> | undefined;

  const server = createServer((request, response) => {
    void (async () => {
      if (!validateHost(request, response) || !validateOrigin(request, response)) return;
      const url = new URL(request.url ?? '/', 'http://gateway.invalid');
      if (url.pathname === '/healthcheck') {
        if (request.method !== 'GET') {
          response.writeHead(405, { allow: 'GET' });
          response.end();
          return;
        }
        const ready =
          !options.registry.closed &&
          (options.isReady === undefined || (await options.isReady()));
        respondJson(response, ready ? 200 : 503, { status: ready ? 'ok' : 'closing' });
        return;
      }
      if (url.pathname === (options.mcpPath ?? '/mcp')) {
        exposeMcpCors(request, response);
        if (request.method === 'OPTIONS') {
          respondMcpPreflight(response);
          return;
        }
        await nodeMcp(request as Parameters<typeof nodeMcp>[0], response);
        return;
      }
      if (nodeOAuth !== undefined) {
        await nodeOAuth(request as Parameters<typeof nodeOAuth>[0], response);
        return;
      }
      respondJson(response, 404, { error: 'not_found' });
    })().catch((error: unknown) => {
      options.onerror?.(error instanceof Error ? error : new Error(String(error)));
      if (!response.headersSent) respondJson(response, 500, { error: 'internal_error' });
      else response.destroy();
    });
  });

  return {
    server,
    proxy,
    listen: (port, host) =>
      new Promise<void>((resolve, reject) => {
        const onError = (error: Error): void => {
          server.off('listening', onListening);
          reject(error);
        };
        const onListening = (): void => {
          server.off('error', onError);
          resolve();
        };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(port, host);
      }),
    close: async (): Promise<void> => {
      closing ??= (async () => {
        sweepAbort.abort();
        const failures: unknown[] = [];
        try {
          await closeHttpServer(server);
        } catch (error) {
          failures.push(error);
        }
        const results = await Promise.allSettled([
          proxy.close(),
          options.registry.close(),
          ...(options.closeAuth === undefined ? [] : [options.closeAuth()]),
          sweep
        ]);
        failures.push(
          ...results.flatMap((result) =>
            result.status === 'rejected' ? [result.reason] : []
          )
        );
        if (failures.length > 0) {
          throw new AggregateError(failures, 'Gateway shutdown failed');
        }
      })();
      return closing;
    }
  };
}
