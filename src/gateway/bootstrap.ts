import type { RunningGateway } from './cli.js';
import { runGateway } from './cli.js';
import type { GatewayCommonConfig, GatewayConfig } from './config.js';
import { loadCloudflareAccessConfig, loadGatewayConfig } from './config.js';
import { createCloudflareAccessGate } from './access.js';
import { createEncryptedRedisStore } from './crypto-store.js';
import { createGatewayOAuth } from './oauth.js';
import { WorkerRegistry, type WorkerRegistrySettings } from './worker-registry.js';

export interface GatewayBootstrapOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly fetchImpl?: typeof fetch;
  readonly host?: string;
  readonly port?: number;
  readonly installSignalHandlers?: boolean;
  readonly onerror?: (error: Error) => void;
}

function basePath(url: URL): string {
  return url.pathname === '/' ? '' : url.pathname.replace(/\/$/u, '');
}

function allowedOriginHostnames(config: GatewayConfig): string[] {
  const names = new Set([config.publicUrl.hostname]);
  for (const pattern of config.redirectUris) {
    try {
      names.add(new URL(pattern.replace('*', '49152')).hostname);
    } catch {
      // Configuration validation already rejects malformed patterns.
    }
  }
  return [...names];
}

function workerSettings(config: GatewayCommonConfig): WorkerRegistrySettings {
  return {
    allowedUsers: config.allowedUsers,
    apiBaseUrl: config.apiBaseUrl.href,
    browserBaseUrl: config.browserBaseUrl.href,
    assertionHeader: config.assertionHeader,
    ...(config.hubAdapterUrl === undefined ? {} : { hubAdapterUrl: config.hubAdapterUrl.href }),
    nodeCommand: config.nodeCommand,
    upstreamCli: config.upstreamCli,
    runtimeDir: config.runtimeDir,
    connectTimeoutMs: config.connectTimeoutMs,
    maxWorkers: config.maxWorkers,
    maxWorkersPerPrincipal: config.maxWorkersPerPrincipal,
    requestTimeoutMs: config.requestTimeoutMs,
    expiryPollMs: config.expiryPollMs
  };
}

/** Start the authenticated HTTP mode of the main `jupyter-collab-mcp` binary. */
export async function runGatewayFromEnv(
  options: GatewayBootstrapOptions = {}
): Promise<RunningGateway> {
  const env = options.env ?? process.env;
  const mode = env.JUPYTER_MCP_AUTH_MODE ?? 'oauth';
  if (mode === 'cloudflare-access') {
    const config = loadCloudflareAccessConfig(env);
    const registry = new WorkerRegistry(workerSettings(config));
    try {
      return await runGateway({
        registry,
        authenticate: createCloudflareAccessGate(config, { fetchImpl: options.fetchImpl ?? fetch }),
        allowedHostnames: [config.publicUrl.hostname],
        allowedOriginHostnames: [config.publicUrl.hostname],
        mcpPath: `${basePath(config.publicUrl)}/mcp`,
        accessSessionTtlSeconds: config.sessionTtlSeconds,
        accessSessionIdleSeconds: config.sessionIdleSeconds,
        ...(options.host === undefined ? {} : { host: options.host }),
        ...(options.port === undefined ? {} : { port: options.port }),
        ...(options.installSignalHandlers === undefined ? {} : { installSignalHandlers: options.installSignalHandlers }),
        ...(options.onerror === undefined ? {} : { onerror: options.onerror })
      });
    } catch (error) {
      await registry.close();
      throw error;
    }
  }
  if (mode !== 'oauth') throw new Error('JUPYTER_MCP_AUTH_MODE must be oauth or cloudflare-access');
  const config = loadGatewayConfig(env);
  const store = await createEncryptedRedisStore(config.redisUrl, config.storageKey);
  const registry = new WorkerRegistry(workerSettings(config));
  let oauth;
  try {
    oauth = await createGatewayOAuth(config, store, options.fetchImpl ?? fetch,
      (grantId, grantExpiresAt) => registry.retireGrant(grantId, grantExpiresAt));
  } catch (error) {
    await store.close().catch(() => undefined);
    throw error;
  }

  try {
    return await runGateway({
      registry,
      authenticate: (request) => oauth.verifyBearer(request.headers.get('authorization')),
      allowedHostnames: [config.publicUrl.hostname],
      allowedOriginHostnames: allowedOriginHostnames(config),
      mcpPath: `${basePath(config.publicUrl)}/mcp`,
      oauthHandler: (request) => oauth.handle(request),
      closeAuth: () => oauth.close(),
      ...(options.host === undefined ? {} : { host: options.host }),
      ...(options.port === undefined ? {} : { port: options.port }),
      ...(options.installSignalHandlers === undefined
        ? {}
        : { installSignalHandlers: options.installSignalHandlers }),
      ...(options.onerror === undefined ? {} : { onerror: options.onerror })
    });
  } catch (error) {
    const cleanup = await Promise.allSettled([registry.close(), oauth.close()]);
    const failures = cleanup.flatMap((result) =>
      result.status === 'rejected' ? [result.reason] : []
    );
    if (failures.length > 0) {
      throw new AggregateError([error, ...failures], 'Gateway startup failed');
    }
    throw error;
  }
}
