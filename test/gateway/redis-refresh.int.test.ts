import { execFile } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { expect, it } from 'vitest';

import { createEncryptedRedisStore, type EncryptedStore } from '../../src/gateway/crypto-store.js';
import { AccessIdentity } from '../../src/gateway/identity.js';
import { RefreshGrants, type GrantAccessRecord } from '../../src/gateway/refresh-grants.js';

const dockerImage = process.env['JUPYTER_MCP_TEST_REDIS_IMAGE'];
const exec = promisify(execFile);

// Explicit opt-in: a disposable local container, never an existing Redis store.
it.skipIf(dockerImage === undefined)('persists atomic grant rotation and replay receipts through an abrupt Redis restart', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mcp-refresh-redis-'));
  const data = join(root, 'data');
  await mkdir(data, { mode: 0o700 });
  let container: string | undefined;
  const stores: EncryptedStore[] = [];
  const docker = async (...args: string[]): Promise<string> =>
    (await exec('docker', args, { timeout: 30_000 })).stdout.trim();
  const connect = async (generation: number): Promise<EncryptedStore> => {
    const socketDirectory = join(root, `socket-${generation}`);
    await mkdir(socketDirectory, { mode: 0o700 });
    container = await docker('run', '--detach', '--rm', '--pull=never', '--network=none', '--read-only',
      '--user', `${process.getuid!()}:${process.getgid!()}`,
      '--mount', `type=bind,src=${data},dst=/data`, '--mount', `type=bind,src=${socketDirectory},dst=/socket`,
      dockerImage!, 'redis-server', '--port', '0', '--unixsocket', '/socket/redis.sock',
      '--unixsocketperm', '600', '--save', '', '--appendonly', 'yes', '--appendfsync', 'always', '--dir', '/data');
    const socket = join(socketDirectory, 'redis.sock');
    for (let attempt = 0; ; attempt++) {
      try { await access(socket); break; }
      catch {
        if (attempt > 100) throw new Error('local Redis did not start');
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
    const store = await createEncryptedRedisStore(new URL(`unix://${socket}`), Buffer.alloc(32, 42));
    stores.push(store);
    return store;
  };
  const stop = async (): Promise<void> => {
    for (const store of stores.splice(0)) await store.close();
    if (container !== undefined) {
      await docker('kill', '--signal=KILL', container);
      container = undefined;
    }
  };
  try {
    let now = Math.floor(Date.now() / 1000);
    let count = 0;
    let refreshes = 0;
    const deadline = now + 28800;
    const signingKey = 's'.repeat(32);
    const identity = (assertion: string) => new AccessIdentity({
      issuer: 'https://fixture.invalid', subject: 'alice-id', username: 'alice', expiresAt: now + 300, assertion
    });
    const manager = (store: EncryptedStore) => new RefreshGrants({
      store, signingKey, now: () => now, randomToken: () => `synthetic-opaque-${++count}`,
      verify: async (assertion) => identity(assertion),
      refresh: async () => {
        refreshes++;
        await new Promise((resolve) => setTimeout(resolve, 30));
        return { assertion: 'synthetic-refreshed-assertion', refreshToken: 'synthetic-refreshed-upstream-token' };
      }
    });
    let store = await connect(0);
    const original = await manager(store).create('client', identity('synthetic-original-assertion'), 'synthetic-original-upstream-token', deadline);
    const [first, duplicate] = await Promise.all([
      manager(store).refresh('client', String(original.refresh_token)),
      manager(store).refresh('client', String(original.refresh_token))
    ]);
    expect(first).toEqual(duplicate);
    expect(refreshes).toBe(1);
    await stop();
    store = await connect(1);
    now += 2;
    const restored = await manager(store).refresh('client', String(original.refresh_token));
    expect(restored.access_token).toBe(first.access_token);
    expect(restored.refresh_token).toBe(first.refresh_token);
    expect(restored.expires_in).toBe(Number(first.expires_in) - 2);
    expect(refreshes).toBe(1);
    const digest = createHmac('sha256', signingKey).update(String(first.access_token)).digest('base64url');
    const record = (await store.get<GrantAccessRecord>('access-tokens', digest))!;
    expect(await manager(store).identity(record)).not.toBeNull();
    now += 8;
    await expect(manager(store).refresh('client', String(original.refresh_token))).rejects.toThrow();
    expect(await manager(store).identity(record)).toBeNull();
    await stop();
    store = await connect(2);
    expect(await manager(store).identity(record)).toBeNull();
    const check = async (directory: string): Promise<void> => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const filename = join(directory, entry.name);
        if (entry.isDirectory()) await check(filename);
        else {
          const content = await readFile(filename, 'utf8');
          for (const secret of [original.refresh_token, first.access_token, first.refresh_token, 'synthetic-original-upstream-token']) {
            expect(content).not.toContain(secret);
          }
        }
      }
    };
    await check(data);
  } finally {
    await stop();
    await rm(root, { recursive: true, force: true });
  }
});
