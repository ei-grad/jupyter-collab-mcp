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
