import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Client } from '@modelcontextprotocol/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  startNodeWorker,
  type GatewayIdentity,
  type GatewayWorker
} from '../../src/gateway/worker.js';
import {
  WorkerRegistry,
  workerKey,
  type WorkerRegistrySettings
} from '../../src/gateway/worker-registry.js';

const FIXTURE = join(
  dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'stdio-server.mjs'
);
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function identity(
  username = 'alice',
  assertion = 'synthetic-assertion',
  expiresAt = Date.now() / 1000 + 120
): GatewayIdentity {
  return {
    issuer: 'https://issuer.example',
    subject: `${username}-subject`,
    username,
    expiresAt,
    assertion: () => assertion
  };
}

async function settings(overrides: Partial<WorkerRegistrySettings> = {}): Promise<WorkerRegistrySettings> {
  const root = await mkdtemp(join(tmpdir(), 'gateway-workers-test-'));
  roots.push(root);
  return {
    allowedUsers: new Set(['alice', 'bob']),
    apiBaseUrl: 'http://jupyter.internal',
    browserBaseUrl: 'https://jupyter.example',
    assertionHeader: 'X-Jupyter-Access-Token',
    nodeCommand: process.execPath,
    upstreamCli: FIXTURE,
    runtimeDir: join(root, 'runtime'),
    maxWorkers: 3,
    maxWorkersPerPrincipal: 2,
    requestTimeoutMs: 1_000,
    expiryPollMs: 10,
    ...overrides
  };
}

interface FakeWorker extends GatewayWorker {
  close: ReturnType<typeof vi.fn<() => Promise<void>>>;
}

function fakeFactory() {
  const workers: FakeWorker[] = [];
  const factory = vi.fn(async (actor: GatewayIdentity, digest: string) => {
    const worker: FakeWorker = {
      client: {} as Client,
      directory: `/synthetic/${String(workers.length)}`,
      username: actor.username,
      credentialDigest: digest,
      expiresAt: actor.expiresAt,
      close: vi.fn(async () => undefined)
    };
    workers.push(worker);
    return worker;
  });
  return { workers, factory };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}

function delayedFakeFactory(options: { firstCleanupFails?: boolean } = {}) {
  const entered = deferred<void>();
  const proceed = deferred<void>();
  const workers: FakeWorker[] = [];
  const factory = vi.fn(async (actor: GatewayIdentity, digest: string) => {
    entered.resolve();
    await proceed.promise;
    const worker: FakeWorker = {
      client: {} as Client,
      directory: '/synthetic/delayed',
      username: actor.username,
      credentialDigest: digest,
      expiresAt: actor.expiresAt,
      close: vi.fn(async () => undefined)
    };
    if (options.firstCleanupFails === true && workers.length === 0) {
      worker.close.mockRejectedValueOnce(new Error('synthetic cleanup failure'));
    }
    workers.push(worker);
    return worker;
  });
  return { entered: entered.promise, proceed: proceed.resolve, workers, factory };
}

describe('Node worker credential custody', () => {
  it('pins optional control auth to the same private assertion and verified principal', async () => {
    const config = await settings({ hubAdapterUrl: 'http://jupyter.internal/hub/api/faceapp/server' });
    const actor = { ...identity(), grantId: 'grant', grantExpiresAt: Math.floor(Date.now() / 1000) + 120 };
    const worker = await startNodeWorker(config, actor);
    try {
      const profile = JSON.parse(await readFile(join(worker.directory, 'profile.json'), 'utf8')) as {
        servers: Array<{ hubUser: string; credentialRef: string; hub: Record<string, unknown> }>
      };
      expect(profile.servers[0]).toMatchObject({ hubUser: 'alice', hub: {
        apiBaseUrl: config.hubAdapterUrl, protocol: 'adapter-v1',
        credentialRef: profile.servers[0]?.credentialRef,
        auth: { type: 'header', name: 'X-Jupyter-Access-Token' },
        credentialRefresh: 'request', credentialExpiry: 'jwt', credentialExpiresAt: actor.grantExpiresAt
      } });
      expect(JSON.stringify(profile)).not.toContain(actor.assertion());
    } finally { await worker.close(); }
  });
  it('uses private files and passes no assertion through argv or env', async () => {
    const config = await settings();
    const worker = await startNodeWorker(config, identity('alice', 'grant-secret'));
    const directory = worker.directory;
    try {
      expect((await stat(directory)).mode & 0o777).toBe(0o700);
      expect((await stat(join(directory, 'assertion'))).mode & 0o777).toBe(0o600);
      expect((await stat(join(directory, 'profile.json'))).mode & 0o777).toBe(0o600);
      expect(await readFile(join(directory, 'assertion'), 'utf8')).toBe('grant-secret');
      const result = await worker.client.callTool({ name: 'custody', arguments: {} });
      expect(result.structuredContent).toEqual({
        argv_contains_assertion: false,
        env_contains_assertion: false,
        api_base_url: 'http://jupyter.internal/user/alice/'
      });
    } finally {
      await worker.close();
    }
    await expect(stat(directory)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('WorkerRegistry', () => {
  it('masks startup details and releases a failed reservation', async () => {
    const config = await settings();
    const registry = new WorkerRegistry(config, async () => {
      throw new Error('/private/runtime/assertion: synthetic failure');
    });
    await expect(registry.acquire(identity())).rejects.toThrow(
      'Jupyter worker failed to start'
    );
    await expect(registry.acquire(identity())).rejects.not.toThrow('/private/runtime');
    expect(registry.size).toBe(0);
    await registry.close();
  });

  it('reuses one exact grant and isolates owners and rotations', async () => {
    const fake = fakeFactory();
    const registry = new WorkerRegistry(await settings(), fake.factory);
    const alice = identity();
    const first = await registry.acquire(alice);
    await first.release();
    const again = await registry.acquire(alice);
    expect(again.worker).toBe(first.worker);
    await again.release();
    const rotated = await registry.acquire(identity('alice', 'rotated'));
    const bob = await registry.acquire(identity('bob'));
    expect(rotated.worker).not.toBe(first.worker);
    expect(bob.worker).not.toBe(first.worker);
    await rotated.release();
    await bob.release();
    expect(fake.factory).toHaveBeenCalledTimes(3);
    expect(workerKey(alice)).not.toBe(workerKey(identity('alice', 'rotated')));
    await registry.close();
  });

  it('serializes a grant and removes an aborted waiter', async () => {
    const fake = fakeFactory();
    const registry = new WorkerRegistry(await settings(), fake.factory);
    const first = await registry.acquire(identity());
    const abort = new AbortController();
    const waiting = registry.acquire(identity(), abort.signal);
    abort.abort(new Error('client disconnected'));
    await expect(waiting).rejects.toThrow('client disconnected');
    await first.release();
    const next = await registry.acquire(identity());
    await next.release();
    expect(fake.factory).toHaveBeenCalledTimes(1);
    await registry.close();
  });

  it('enforces global and per-principal capacity without eviction', async () => {
    const fake = fakeFactory();
    const registry = new WorkerRegistry(
      await settings({ maxWorkers: 2, maxWorkersPerPrincipal: 1 }),
      fake.factory
    );
    const alice = await registry.acquire(identity());
    await alice.release();
    await expect(registry.acquire(identity('alice', 'rotated'))).rejects.toThrow(
      'for this principal'
    );
    const bob = await registry.acquire(identity('bob'));
    await bob.release();
    await expect(
      registry.acquire({ ...identity('bob', 'other'), subject: 'another-subject' })
    ).rejects.toThrow('capacity reached');
    expect(fake.workers[0]?.close).not.toHaveBeenCalled();
    await registry.close();
  });

  it('attempts every cleanup and retains failed ownership for retry', async () => {
    const fake = fakeFactory();
    const registry = new WorkerRegistry(await settings(), fake.factory);
    const alice = await registry.acquire(identity());
    const bob = await registry.acquire(identity('bob'));
    await alice.release();
    await bob.release();
    fake.workers[0]?.close.mockRejectedValueOnce(new Error('close failed'));
    await expect(registry.close()).rejects.toBeInstanceOf(AggregateError);
    expect(fake.workers[0]?.close).toHaveBeenCalledTimes(1);
    expect(fake.workers[1]?.close).toHaveBeenCalledTimes(1);
    expect(registry.size).toBe(1);
    await registry.close();
    expect(fake.workers[0]?.close).toHaveBeenCalledTimes(2);
    expect(registry.size).toBe(0);
  });

  it('rejects new work after shutdown', async () => {
    const registry = new WorkerRegistry(await settings(), fakeFactory().factory);
    await registry.close();
    await expect(registry.acquire(identity())).rejects.toThrow('shutting down');
  });

  it('closes a worker whose identity expires while startup is pending', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2030-01-01T00:00:00Z'));
      const delayed = delayedFakeFactory();
      const registry = new WorkerRegistry(await settings(), delayed.factory);
      const pending = registry.acquire(
        identity('alice', 'short-lived', Date.now() / 1000 + 10)
      );
      await delayed.entered;
      vi.setSystemTime(new Date('2030-01-01T00:00:20Z'));
      delayed.proceed();

      await expect(pending).rejects.toThrow('expired or not permitted');
      expect(delayed.workers[0]?.close).toHaveBeenCalledOnce();
      expect(registry.size).toBe(0);
      await registry.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it('closes a late worker when shutdown begins during startup', async () => {
    const delayed = delayedFakeFactory();
    const registry = new WorkerRegistry(await settings(), delayed.factory);
    const pending = registry.acquire(identity());
    await delayed.entered;
    const closing = registry.close();
    delayed.proceed();

    await expect(pending).rejects.toThrow('shutting down');
    await closing;
    expect(delayed.workers[0]?.close).toHaveBeenCalledOnce();
    expect(registry.size).toBe(0);
  });

  it('closes a late worker when its startup request is cancelled', async () => {
    const delayed = delayedFakeFactory();
    const registry = new WorkerRegistry(await settings(), delayed.factory);
    const abort = new AbortController();
    const pending = registry.acquire(identity(), abort.signal);
    await delayed.entered;
    abort.abort(new Error('client disconnected'));
    delayed.proceed();

    await expect(pending).rejects.toThrow('client disconnected');
    expect(delayed.workers[0]?.close).toHaveBeenCalledOnce();
    expect(registry.size).toBe(0);
    await registry.close();
  });

  it('quarantines failed late-worker cleanup and replaces it only after retry', async () => {
    const delayed = delayedFakeFactory({ firstCleanupFails: true });
    const registry = new WorkerRegistry(await settings(), delayed.factory);
    const abort = new AbortController();
    const pending = registry.acquire(identity(), abort.signal);
    await delayed.entered;
    abort.abort(new Error('client disconnected'));
    delayed.proceed();

    await expect(pending).rejects.toBeInstanceOf(AggregateError);
    expect(registry.size).toBe(1);
    expect(delayed.workers[0]?.close).toHaveBeenCalledOnce();

    const replacement = await registry.acquire(identity());
    expect(delayed.workers[0]?.close).toHaveBeenCalledTimes(2);
    expect(replacement.worker).not.toBe(delayed.workers[0]);
    expect(delayed.factory).toHaveBeenCalledTimes(2);
    await replacement.release();
    await registry.close();
  });

  it('removes each sweep abort listener after its timer completes', async () => {
    vi.useFakeTimers();
    try {
      const registry = new WorkerRegistry(
        await settings({ expiryPollMs: 10 }),
        fakeFactory().factory
      );
      const abort = new AbortController();
      const added = vi.spyOn(abort.signal, 'addEventListener');
      const removed = vi.spyOn(abort.signal, 'removeEventListener');
      const sweeping = registry.sweep(abort.signal);
      await vi.advanceTimersByTimeAsync(50);
      abort.abort();
      await sweeping;

      expect(added.mock.calls.length).toBeGreaterThanOrEqual(5);
      expect(removed.mock.calls).toHaveLength(added.mock.calls.length);
      await registry.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it('retires only idle expired grants and retries failed expiry cleanup', async () => {
    const fake = fakeFactory();
    const registry = new WorkerRegistry(await settings(), fake.factory);
    const lease = await registry.acquire(identity('alice', 'old', Date.now() / 1000 + 1));
    await registry.expire(Date.now() / 1000 + 10);
    expect(lease.worker.close).not.toHaveBeenCalled();
    await lease.release();
    fake.workers[0]?.close.mockRejectedValueOnce(new Error('close failed'));
    await expect(registry.expire(Date.now() / 1000 + 10)).rejects.toBeInstanceOf(
      AggregateError
    );
    expect(registry.size).toBe(1);
    await registry.expire(Date.now() / 1000 + 10);
    expect(registry.size).toBe(0);
  });
});


describe('refresh grant worker ownership', () => {
  it('renews the same worker and retains it across assertion expiry gaps', async () => {
    const options = await settings();
    const registry = new WorkerRegistry(options);
    const first = { ...identity('alice', 'first'), grantId: 'login-one', grantExpiresAt: Date.now() / 1000 + 3600 };
    try {
      const a = await registry.acquire(first);
      const worker = a.worker;
      await a.release();
      await registry.expire(first.expiresAt + 1);
      expect(registry.size).toBe(1);
      const b = await registry.acquire({ ...first, assertion: () => 'second', grantGeneration: 1, expiresAt: first.expiresAt + 300 });
      expect(b.worker).toBe(worker);
      expect(b.client).toBe(a.client);
      expect(await readFile(join(worker.directory, 'assertion'), 'utf8')).toBe('second');
      expect((await stat(join(worker.directory, 'assertion'))).mode & 0o777).toBe(0o600);
      await b.release();
      const independent = await registry.acquire({ ...first, grantId: 'login-two' });
      expect(independent.worker).not.toBe(worker);
      await independent.release();
      await registry.retireGrant('login-one', first.grantExpiresAt);
      expect(registry.size).toBe(1);
      await registry.expire(first.grantExpiresAt + 1);
      expect(registry.size).toBe(0);
    } finally {
      await registry.close();
    }
  });

  it('rejects expired JWTs even while a grant worker is retained', async () => {
    const { factory } = fakeFactory();
    const registry = new WorkerRegistry(await settings(), factory);
    const actor = { ...identity(), grantId: 'login', grantExpiresAt: Date.now() / 1000 + 3600 };
    const lease = await registry.acquire(actor);
    await lease.release();
    await expect(registry.acquire({ ...actor, expiresAt: 1 })).rejects.toThrow('expired');
    expect(factory).toHaveBeenCalledTimes(1);
    await registry.close();
  });

  it('serializes credential replacement behind active requests', async () => {
    const registry = new WorkerRegistry(await settings());
    const actor = { ...identity('alice', 'first'), grantId: 'login', grantExpiresAt: Date.now() / 1000 + 3600 };
    const first = await registry.acquire(actor);
    const next = registry.acquire({ ...actor, assertion: () => 'next', grantGeneration: 1 });
    await Promise.resolve();
    expect(await readFile(join(first.worker.directory, 'assertion'), 'utf8')).toBe('first');
    await first.release();
    const renewed = await next;
    expect(await readFile(join(first.worker.directory, 'assertion'), 'utf8')).toBe('next');
    const stale = registry.acquire(actor);
    await renewed.release();
    const older = await stale;
    expect(older.worker).toBe(first.worker);
    expect(await readFile(join(first.worker.directory, 'assertion'), 'utf8')).toBe('next');
    await older.release();
    await expect(registry.acquire({ ...actor, grantGeneration: 1, assertion: () => 'conflict' }))
      .rejects.toThrow('without a new generation');
    await registry.close();
  });
});

describe('transport session worker ownership', () => {
  it('retains handles without an age bound but keeps downstream JWT expiry enabled', async () => {
    const registry = new WorkerRegistry(await settings());
    const actor = identity('alice', 'first');
    const session = registry.createSession(actor);
    try {
      const initial = await registry.acquire({ ...actor, session, grantGeneration: 1 });
      await initial.release();
      await registry.expire(actor.expiresAt + 10 * 60 * 60);
      expect(registry.size).toBe(1);
      const profile = JSON.parse(await readFile(join(initial.worker.directory, 'profile.json'), 'utf8'));
      expect(profile.servers[0]).toMatchObject({ credentialRefresh: 'request', credentialExpiry: 'jwt' });
      expect(profile.servers[0]).not.toHaveProperty('credentialExpiresAt');
      await expect(registry.acquire({ ...actor, session, expiresAt: 1 })).rejects.toThrow('expired');
      const renewed = await registry.acquire({ ...actor, session, grantGeneration: 2,
        assertion: () => 'second', expiresAt: actor.expiresAt + 300 });
      expect(renewed.worker).toBe(initial.worker);
      expect(await readFile(join(initial.worker.directory, 'assertion'), 'utf8')).toBe('second');
      await renewed.release();
      await registry.retireSession(session);
      expect(registry.size).toBe(0);
      await expect(registry.acquire({ ...actor, session })).rejects.toThrow('closed');
    } finally {
      await registry.close();
    }
  });

  it('enforces finite deadlines and rejects forged or cross-principal session owners', async () => {
    const fake = fakeFactory();
    const registry = new WorkerRegistry(await settings(), fake.factory);
    const actor = identity();
    const session = registry.createSession(actor, actor.expiresAt + 10);
    const lease = await registry.acquire({ ...actor, session });
    await lease.release();
    for (const invalid of [
      { ...identity('bob'), session },
      { ...actor, username: 'bob', session },
      { ...actor, session: { ...session } },
      { ...actor, session, grantId: 'oauth', grantExpiresAt: actor.expiresAt }
    ]) await expect(registry.acquire(invalid)).rejects.toThrow('not permitted');
    await registry.expire(session.expiresAt! + 1);
    expect(registry.size).toBe(0);
    await registry.close();
  });

  it('cannot resurrect a closed session before its first acquisition', async () => {
    const fake = fakeFactory();
    const registry = new WorkerRegistry(await settings(), fake.factory);
    const actor = identity();
    const session = registry.createSession(actor);
    await registry.retireSession(session);
    await expect(registry.acquire({ ...actor, session })).rejects.toThrow('closed');
    expect(fake.factory).not.toHaveBeenCalled();
    expect(registry.size).toBe(0);
    await registry.close();
  });

  it('closes late startup workers and rejects queued identities after session retirement', async () => {
    const delayed = delayedFakeFactory();
    const registry = new WorkerRegistry(await settings(), delayed.factory);
    const actor = identity();
    const session = registry.createSession(actor);
    const pending = registry.acquire({ ...actor, session });
    const rejected = expect(pending).rejects.toThrow('closed');
    await delayed.entered;
    const queued = registry.acquire({ ...actor, session });
    const queuedRejected = expect(queued).rejects.toThrow('closed');
    const closing = registry.retireSession(session);
    delayed.proceed();
    await Promise.all([rejected, queuedRejected, closing]);
    expect(delayed.workers[0]?.close).toHaveBeenCalledOnce();
    expect(registry.size).toBe(0);
    await expect(registry.acquire({ ...actor, session })).rejects.toThrow('closed');
    await registry.close();
  });

  it('retries failed session cleanup through the normal sweep', async () => {
    const fake = fakeFactory();
    const registry = new WorkerRegistry(await settings(), fake.factory);
    const actor = identity();
    const session = registry.createSession(actor);
    const lease = await registry.acquire({ ...actor, session });
    await lease.release();
    fake.workers[0]!.close.mockRejectedValueOnce(new Error('cleanup failed'));
    await expect(registry.retireSession(session)).rejects.toBeInstanceOf(AggregateError);
    expect(registry.size).toBe(1);
    await expect(registry.acquire({ ...actor, session })).rejects.toThrow('closed');
    await registry.expire();
    expect(registry.size).toBe(0);
    await registry.close();
  });
});


it('does not resurrect a grant revoked before its first worker started', async () => {
  const { factory } = fakeFactory();
  const registry = new WorkerRegistry(await settings(), factory);
  const actor = { ...identity(), grantId: 'revoked', grantExpiresAt: Date.now() / 1000 + 3600 };
  await registry.retireGrant(actor.grantId, actor.grantExpiresAt);
  await expect(registry.acquire(actor)).rejects.toThrow('revoked');
  expect(factory).not.toHaveBeenCalled();
  await registry.close();
});


it('revalidates the request bearer deadline after waiting for a newer grant worker', async () => {
  const { factory } = fakeFactory();
  const registry = new WorkerRegistry(await settings(), factory);
  const actor = { ...identity(), grantId: 'grant', grantExpiresAt: Date.now() / 1000 + 3600 };
  const held = await registry.acquire(actor);
  const requestExpiresAt = Date.now() / 1000 + 0.02;
  const queued = registry.acquire({ ...actor, requestExpiresAt });
  const rejected = expect(queued).rejects.toThrow('expired');
  await new Promise((resolve) => setTimeout(resolve, 30));
  await held.release();
  await rejected;
  expect(factory).toHaveBeenCalledTimes(1);
  await registry.close();
});
