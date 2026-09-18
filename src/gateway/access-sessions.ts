import {
  WebStandardStreamableHTTPServerTransport,
  type AuthInfo,
  type McpHttpHandler,
  type Server
} from '@modelcontextprotocol/server';

import { createGatewayProxyServer, type GatewayProxyOptions, type IdentityResolver } from './proxy-server.js';
import type { WorkerRegistry, WorkerSession } from './worker-registry.js';
import type { GatewayIdentity } from './worker.js';

interface Session {
  readonly id: string;
  readonly principal: string;
  readonly lifetime: WorkerSession;
  readonly server: Server;
  readonly transport: WebStandardStreamableHTTPServerTransport;
  timer?: ReturnType<typeof setTimeout>;
  idleDeadline: number;
  inFlight: number;
  generation: number;
}

function principal(identity: GatewayIdentity): string {
  return JSON.stringify([identity.issuer, identity.subject, identity.username]);
}

function failure(status: number, message: string): Response {
  return Response.json({ jsonrpc: '2.0', error: { code: -32000, message }, id: null }, {
    status, headers: { 'cache-control': 'no-store' }
  });
}

/** A transport session partitions agents; fresh verified identity authorizes every request. */
export function createAccessSessionHandler(
  registry: WorkerRegistry,
  resolveIdentity: IdentityResolver,
  ttlSeconds: number,
  idleSeconds: number,
  options: GatewayProxyOptions = {}
): Pick<McpHttpHandler, 'fetch' | 'close'> {
  const sessions = new Map<string, Session>();
  const identities = new WeakMap<AuthInfo, GatewayIdentity>();
  let closed = false;

  async function remove(session: Session): Promise<void> {
    if (sessions.get(session.id) !== session) return;
    sessions.delete(session.id);
    clearTimeout(session.timer);
    await Promise.all([
      session.server.close(),
      registry.retireSession(session.lifetime)
    ]);
  }

  function expired(session: Session, now: number): boolean {
    return (session.lifetime.expiresAt !== undefined && session.lifetime.expiresAt <= now) ||
      (session.inFlight === 0 && session.idleDeadline <= now);
  }

  function schedule(session: Session): void {
    clearTimeout(session.timer);
    if (sessions.get(session.id) !== session) return;
    const now = Date.now() / 1000;
    const idleCheck = session.inFlight > 0 ? now + idleSeconds : session.idleDeadline;
    const nextCheck = session.lifetime.expiresAt === undefined
      ? idleCheck : Math.min(session.lifetime.expiresAt, idleCheck);
    session.timer = setTimeout(() => {
      if (expired(session, Date.now() / 1000)) {
        void remove(session).catch((error: unknown) => {
          options.onerror?.(error instanceof Error ? error : new Error('Session cleanup failed'));
        });
      } else schedule(session);
    }, Math.max(1, (nextCheck - now) * 1000));
    session.timer.unref();
  }

  return {
    async fetch(request, requestOptions) {
      if (closed) return failure(503, 'Gateway is closing');
      const identity = registry.validate(await resolveIdentity(requestOptions?.authInfo));
      const authInfo = requestOptions?.authInfo;
      if (authInfo === undefined) return failure(401, 'Authentication required');
      const sessionId = request.headers.get('mcp-session-id');
      let session: Session | undefined;
      if (sessionId !== null) {
        session = sessions.get(sessionId);
        if (session === undefined || session.principal !== principal(identity)) {
          return failure(404, 'Unknown session; initialize a new connection');
        }
        if (expired(session, Date.now() / 1000)) {
          await remove(session);
          return failure(404, 'Session expired; initialize a new connection');
        }
      } else {
        if (request.method !== 'POST') return failure(400, 'Initialize a connection first');
        await Promise.all([...sessions.values()].filter((value) => expired(value, Date.now() / 1000)).map(remove));
        if (sessions.size >= registry.settings.maxWorkers ||
            [...sessions.values()].filter((value) => value.principal === principal(identity)).length >=
              registry.settings.maxWorkersPerPrincipal) {
          return failure(429, 'Session capacity reached; close an existing connection');
        }
        const lifetime = registry.createSession(identity, ttlSeconds === 0 ? undefined : Date.now() / 1000 + ttlSeconds);
        const id = lifetime.id;
        const server = createGatewayProxyServer(registry, (context) => {
          const info = context.http?.authInfo;
          const current = info === undefined ? undefined : identities.get(info);
          if (current === undefined) throw new Error('Authenticated request identity required');
          return current;
        }, options);
        const transport = new WebStandardStreamableHTTPServerTransport({
          sessionIdGenerator: () => id,
          enableJsonResponse: true,
          onsessionclosed: async () => { if (session !== undefined) await remove(session); }
        });
        session = { id, lifetime, principal: principal(identity), server, transport,
          idleDeadline: Date.now() / 1000 + idleSeconds, inFlight: 0, generation: 0 };
        sessions.set(id, session);
        schedule(session);
        try {
          await server.connect(transport);
        } catch (error) {
          await remove(session);
          throw error;
        }
      }
      session.inFlight++;
      schedule(session);
      identities.set(authInfo, {
        issuer: identity.issuer, subject: identity.subject, username: identity.username,
        expiresAt: identity.expiresAt, requestExpiresAt: identity.expiresAt,
        session: session.lifetime,
        grantGeneration: ++session.generation,
        assertion: () => identity.assertion()
      });
      try {
        const response = await session.transport.handleRequest(request, { ...requestOptions, authInfo });
        // The SDK only creates a session after validating an initialize request.
        if (session.transport.sessionId === undefined) await remove(session);
        return response;
      } catch (error) {
        if (sessionId === null) await remove(session);
        throw error;
      } finally {
        identities.delete(authInfo);
        session.inFlight--;
        session.idleDeadline = Date.now() / 1000 + idleSeconds;
        schedule(session);
      }
    },
    async close() {
      closed = true;
      await Promise.all([...sessions.values()].map(remove));
    }
  };
}
