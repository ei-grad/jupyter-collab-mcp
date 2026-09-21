import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, lstat, rm, chmod, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';

import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

import type { WorkerSession } from './worker-registry.js';
import { packageVersion } from '../version.js';

export interface GatewayIdentity {
  readonly issuer: string;
  readonly subject: string;
  readonly username: string;
  readonly expiresAt: number;
  readonly requestExpiresAt?: number;
  readonly grantId?: string;
  readonly grantGeneration?: number;
  readonly grantExpiresAt?: number;
  readonly session?: WorkerSession;
  assertion(): string;
}

export interface WorkerProcessSettings {
  readonly apiBaseUrl: string;
  readonly browserBaseUrl: string;
  readonly assertionHeader: string;
  readonly hubAdapterUrl?: string;
  readonly nodeCommand: string;
  readonly upstreamCli: string;
  readonly runtimeDir: string;
  readonly connectTimeoutMs?: number;
}

export interface GatewayWorker {
  readonly client: Client;
  readonly directory: string;
  readonly username: string;
  readonly credentialDigest: string;
  readonly expiresAt: number;
  renew?(identity: GatewayIdentity): Promise<void>;
  close(): Promise<void>;
}

export type WorkerFactory = (
  identity: GatewayIdentity,
  credentialDigest: string,
  signal?: AbortSignal
) => Promise<GatewayWorker>;

export function credentialDigest(assertion: string): string {
  return createHash('sha256').update(assertion, 'utf8').digest('hex');
}

function userBaseUrl(baseUrl: string, username: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/user/${encodeURIComponent(username)}/`;
}

async function verifyPrivateDirectory(directory: string): Promise<void> {
  const info = await lstat(directory);
  const processUid = process.getuid?.();
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    (processUid !== undefined && info.uid !== processUid) ||
    (info.mode & 0o077) !== 0
  ) {
    throw new Error('Worker runtime directory must be private to the service UID');
  }
}

export class NodeGatewayWorker implements GatewayWorker {
  #closed = false;

  constructor(
    readonly client: Client,
    readonly directory: string,
    readonly username: string,
    public credentialDigest: string,
    public expiresAt: number
  ) {}

  async renew(identity: GatewayIdentity): Promise<void> {
    if (this.#closed || identity.username !== this.username || identity.expiresAt <= Date.now() / 1000) {
      throw new Error('Jupyter worker credential cannot be renewed');
    }
    const temporary = join(this.directory, 'assertion.next');
    await writeFile(temporary, identity.assertion(), { encoding: 'utf8', mode: 0o600 });
    await rename(temporary, join(this.directory, 'assertion'));
    this.credentialDigest = credentialDigest(identity.assertion());
    this.expiresAt = identity.expiresAt;
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    const failures: unknown[] = [];
    try {
      await this.client.close();
    } catch (error) {
      failures.push(error);
    }
    try {
      await rm(this.directory, { recursive: true, force: true });
    } catch (error) {
      failures.push(error);
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, 'Failed to close Jupyter worker');
    }
    this.#closed = true;
  }
}

export async function startNodeWorker(
  settings: WorkerProcessSettings,
  identity: GatewayIdentity,
  digest = credentialDigest(identity.assertion()),
  signal?: AbortSignal
): Promise<GatewayWorker> {
  signal?.throwIfAborted();
  await mkdir(settings.runtimeDir, { recursive: true, mode: 0o700 });
  await verifyPrivateDirectory(settings.runtimeDir);

  const directory = await mkdtemp(join(settings.runtimeDir, 'worker-'));
  await chmod(directory, 0o700);
  const assertionFile = join(directory, 'assertion');
  const profileFile = join(directory, 'profile.json');
  const profile = {
    servers: [
      {
        id: 'jupyter',
        kind: 'jupyterhub',
        apiBaseUrl: userBaseUrl(settings.apiBaseUrl, identity.username),
        browserBaseUrl: userBaseUrl(settings.browserBaseUrl, identity.username),
        credentialRef: `file:${assertionFile}`,
        auth: { type: 'header', name: settings.assertionHeader },
        ...(settings.hubAdapterUrl === undefined ? {} : {
          hubUser: identity.username,
          hub: {
            apiBaseUrl: settings.hubAdapterUrl,
            protocol: 'adapter-v1', credentialRef: `file:${assertionFile}`,
            auth: { type: 'header', name: settings.assertionHeader },
            ...(identity.grantId === undefined && identity.session === undefined ? {} : {
              credentialRefresh: 'request', credentialExpiry: 'jwt',
              credentialExpiresAt: identity.session?.expiresAt ?? identity.grantExpiresAt
            })
          }
        }),
        ...(identity.grantId === undefined && identity.session === undefined ? {} : {
          credentialRefresh: 'request', credentialExpiry: 'jwt',
          credentialExpiresAt: identity.session?.expiresAt ?? identity.grantExpiresAt
        })
      }
    ]
  };

  let client: Client | undefined;
  try {
    await writeFile(assertionFile, identity.assertion(), {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600
    });
    await writeFile(profileFile, JSON.stringify(profile), {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600
    });

    const transport = new StdioClientTransport({
      command: settings.nodeCommand,
      args: [settings.upstreamCli, '--config', profileFile, '--log-level', 'silent'],
      cwd: directory,
      env: { NODE_ENV: 'production', HOME: directory },
      stderr: 'ignore'
    });
    client = new Client(
      { name: 'jupyter-collab-mcp-gateway', version: packageVersion() },
      { versionNegotiation: { mode: 'legacy' } }
    );
    await client.connect(transport, {
      ...(settings.connectTimeoutMs === undefined
        ? {}
        : { timeout: settings.connectTimeoutMs }),
      ...(signal === undefined ? {} : { signal })
    });
    return new NodeGatewayWorker(
      client,
      directory,
      identity.username,
      digest,
      identity.expiresAt
    );
  } catch (error) {
    const cleanup = await Promise.allSettled([
      ...(client === undefined ? [] : [client.close()]),
      rm(directory, { recursive: true, force: true })
    ]);
    const cleanupFailures = cleanup.flatMap((result) =>
      result.status === 'rejected' ? [result.reason] : []
    );
    if (cleanupFailures.length > 0) {
      throw new AggregateError([error, ...cleanupFailures], 'Jupyter worker startup failed');
    }
    throw error;
  }
}
