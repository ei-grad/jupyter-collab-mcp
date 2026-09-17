import type { RunningGateway } from './cli.js';
import { runGateway } from './cli.js';
import type { GatewayConfig } from './config.js';
import { loadGatewayConfig } from './config.js';
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

function workerSettings(config: GatewayConfig): WorkerRegistrySettings {
  return {
    allowedUsers: config.allowedUsers,
    apiBaseUrl: config.apiBaseUrl.href,
    browserBaseUrl: config.browserBaseUrl.href,
    assertionHeader: config.assertionHeader,
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
  const config = loadGatewayConfig(options.env ?? process.env);
  const store = await createEncryptedRedisStore(config.redisUrl, config.storageKey);
  let oauth;
  try {
    oauth = await createGatewayOAuth(config, store, options.fetchImpl ?? fetch);
  } catch (error) {
    await store.close().catch(() => undefined);
    throw error;
  }

  const registry = new WorkerRegistry(workerSettings(config));
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
