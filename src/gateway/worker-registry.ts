import { randomUUID } from 'node:crypto';

import type { Client } from '@modelcontextprotocol/client';

import {
  credentialDigest,
  startNodeWorker,
  type GatewayIdentity,
  type GatewayWorker,
  type WorkerFactory,
  type WorkerProcessSettings
} from './worker.js';

export interface WorkerRegistrySettings extends WorkerProcessSettings {
  readonly allowedUsers: ReadonlySet<string>;
  readonly maxWorkers: number;
  readonly maxWorkersPerPrincipal: number;
  readonly requestTimeoutMs: number;
  readonly expiryPollMs: number;
}

interface Waiter {
  readonly resolve: (release: () => void) => void;
  readonly reject: (error: unknown) => void;
  readonly signal?: AbortSignal;
  readonly abort?: () => void;
}

class AsyncLock {
  #locked = false;
  readonly #waiters: Waiter[] = [];

  acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted === true) return Promise.reject(signal.reason);
    if (!this.#locked) {
      this.#locked = true;
      return Promise.resolve(this.#releaseOnce());
    }
    return new Promise<() => void>((resolve, reject) => {
      const waiter: Waiter = { resolve, reject, ...(signal === undefined ? {} : { signal }) };
      if (signal !== undefined) {
        const abort = (): void => {
          const index = this.#waiters.indexOf(waiter);
          if (index >= 0) this.#waiters.splice(index, 1);
          reject(signal.reason);
        };
        Object.assign(waiter, { abort });
        signal.addEventListener('abort', abort, { once: true });
      }
      this.#waiters.push(waiter);
    });
  }

  #releaseOnce(): () => void {
    let released = false;
    return (): void => {
      if (released) return;
      released = true;
      this.#advance();
    };
  }

  #advance(): void {
    const waiter = this.#waiters.shift();
    if (waiter === undefined) {
      this.#locked = false;
      return;
    }
    if (waiter.signal !== undefined && waiter.abort !== undefined) {
      waiter.signal.removeEventListener('abort', waiter.abort);
    }
    waiter.resolve(this.#releaseOnce());
  }
}

interface Slot {
  readonly key: string;
  readonly principal: string;
  readonly lock: AsyncLock;
  readonly grantId?: string;
  readonly grantExpiresAt?: number;
  readonly session?: WorkerSession;
  grantGeneration: number;
  references: number;
  retiring: boolean;
  worker?: GatewayWorker;
}

/** A registry-owned lifetime, independent of the current request's credential. */
export interface WorkerSession {
  readonly id: string;
  readonly expiresAt?: number;
}

export interface WorkerLease {
  readonly client: Client;
  readonly worker: GatewayWorker;
  release(): Promise<void>;
}

function principalKey(identity: GatewayIdentity): string {
  return JSON.stringify([identity.issuer, identity.subject]);
}

export function workerKey(identity: GatewayIdentity): string {
  return JSON.stringify([
    identity.issuer,
    identity.subject,
    ...(identity.session !== undefined
      ? ['session', identity.username, identity.session.id]
      : identity.grantId === undefined
      ? [credentialDigest(identity.assertion())]
      : ['grant', identity.username, identity.grantId])
  ]);
}

function waitForDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (): void => {
      if (timer !== undefined) clearTimeout(timer);
      signal.removeEventListener('abort', finish);
      resolve();
    };
    timer = setTimeout(finish, milliseconds);
    signal.addEventListener('abort', finish, { once: true });
    if (signal.aborted) finish();
  });
}

export class WorkerRegistry {
  readonly #slots = new Map<string, Slot>();
  readonly #retiredGrants = new Map<string, number>();
  readonly #sessions = new WeakMap<WorkerSession, { principal: string; closed: boolean }>();
  readonly #factory: WorkerFactory;
  #closed = false;

  constructor(
    readonly settings: WorkerRegistrySettings,
    factory: WorkerFactory = (identity, digest, signal) =>
      startNodeWorker(settings, identity, digest, signal)
  ) {
    this.#factory = factory;
  }

  get closed(): boolean {
    return this.#closed;
  }

  get size(): number {
    return this.#slots.size;
  }

  createSession(identity: GatewayIdentity, expiresAt?: number): WorkerSession {
    this.validate(identity);
    if (this.#closed) throw new Error('Jupyter MCP is shutting down');
    if (expiresAt !== undefined && (!Number.isFinite(expiresAt) || expiresAt <= Date.now() / 1000)) {
      throw new Error('Invalid worker session deadline');
    }
    const session = Object.freeze({ id: randomUUID(), ...(expiresAt === undefined ? {} : { expiresAt }) });
    this.#sessions.set(session, { principal: JSON.stringify([principalKey(identity), identity.username]), closed: false });
    return session;
  }

  async retireSession(session: WorkerSession): Promise<void> {
    const state = this.#sessions.get(session);
    if (state === undefined) throw new Error('Unknown worker session');
    // In-flight identities retain this closed object; no global tombstone is needed.
    state.closed = true;
    const slots = [...this.#slots.values()].filter((slot) => slot.session === session);
    for (const slot of slots) slot.retiring = true;
    await this.#retireAll(slots, 'Failed to retire session workers');
  }

  validate(identity: GatewayIdentity): GatewayIdentity {
    if (identity.session !== undefined) {
      const state = this.#sessions.get(identity.session);
      if (state === undefined || state.closed ||
          state.principal !== JSON.stringify([principalKey(identity), identity.username]) ||
          (identity.session.expiresAt !== undefined && identity.session.expiresAt <= Date.now() / 1000) ||
          identity.grantId !== undefined || identity.grantExpiresAt !== undefined) {
        throw new Error('Jupyter worker session is closed or not permitted');
      }
    }
    if (identity.grantId !== undefined && this.#retiredGrants.has(identity.grantId)) {
      throw new Error('Jupyter authorization grant is revoked');
    }
    if (
      identity.issuer.length === 0 ||
      identity.subject.length === 0 ||
      identity.username.length === 0 ||
      identity.assertion().length === 0 ||
      !Number.isFinite(identity.expiresAt) ||
      identity.expiresAt <= Date.now() / 1000 ||
      (identity.requestExpiresAt !== undefined &&
        (!Number.isFinite(identity.requestExpiresAt) || identity.requestExpiresAt <= Date.now() / 1000)) ||
      !this.settings.allowedUsers.has(identity.username) ||
      (identity.grantGeneration !== undefined && (!Number.isSafeInteger(identity.grantGeneration) || identity.grantGeneration < 0)) ||
      (identity.grantId !== undefined &&
        (identity.grantId.length === 0 || identity.grantExpiresAt === undefined ||
         !Number.isFinite(identity.grantExpiresAt) || identity.grantExpiresAt <= Date.now() / 1000)) ||
      (identity.grantId === undefined && identity.grantExpiresAt !== undefined)
    ) {
      throw new Error('Jupyter identity is expired or not permitted');
    }
    return identity;
  }

  async acquire(identity: GatewayIdentity, signal?: AbortSignal): Promise<WorkerLease> {
    this.#pruneRetiredGrants(Date.now() / 1000);
    this.validate(identity);
    if (this.#closed) throw new Error('Jupyter MCP is shutting down');

    const key = workerKey(identity);
    const principal = principalKey(identity);
    let slot = this.#slots.get(key);
    if (slot?.retiring === true) {
      if (slot.references > 0) {
        throw new Error('Jupyter worker is retiring; retry later');
      }
      try {
        await this.#retire(slot);
      } catch (error) {
        throw new Error('Jupyter worker cleanup failed; retry later', { cause: error });
      }
      slot = this.#slots.get(key);
      if (slot?.retiring === true) {
        throw new Error('Jupyter worker is retiring; retry later');
      }
    }
    if (slot === undefined) {
      if (this.#slots.size >= this.settings.maxWorkers) {
        throw new Error('Jupyter worker capacity reached; retry later');
      }
      const principalWorkers = [...this.#slots.values()].filter(
        (existing) => existing.principal === principal
      ).length;
      if (principalWorkers >= this.settings.maxWorkersPerPrincipal) {
        throw new Error('Jupyter worker capacity for this principal reached; retry later');
      }
      slot = {
        key, principal, lock: new AsyncLock(), references: 0, retiring: false,
        grantGeneration: identity.grantGeneration ?? 0,
        ...(identity.session === undefined ? {} : { session: identity.session }),
        ...(identity.grantId === undefined ? {} : {
          grantId: identity.grantId, grantExpiresAt: identity.grantExpiresAt!
        })
      };
      this.#slots.set(key, slot);
    }
    slot.references += 1;

    let releaseLock: (() => void) | undefined;
    try {
      releaseLock = await slot.lock.acquire(signal);
      signal?.throwIfAborted();
      this.validate(identity);
      if (this.#closed) throw new Error('Jupyter MCP is shutting down');
      if (slot.retiring) throw new Error('Jupyter worker is retiring; retry later');
      if (slot.grantExpiresAt !== identity.grantExpiresAt) throw new Error('Jupyter grant deadline changed');
      if (slot.session !== identity.session) throw new Error('Jupyter worker session changed');
      if (slot.worker !== undefined && slot.worker.username !== identity.username) {
        throw new Error('Jupyter worker identity does not match its owner');
      }
      if (slot.worker === undefined) {
        let started: GatewayWorker;
        try {
          started = await this.#factory(
            identity,
            credentialDigest(identity.assertion()),
            signal
          );
        } catch (error) {
          if (signal?.aborted === true) throw error;
          throw new Error('Jupyter worker failed to start', { cause: error });
        }
        slot.worker = started;
        slot.grantGeneration = identity.grantGeneration ?? 0;
        try {
          signal?.throwIfAborted();
          this.validate(identity);
          if (this.#closed) throw new Error('Jupyter MCP is shutting down');
          if (slot.retiring) throw new Error('Jupyter worker is retiring; retry later');
          if (started.username !== identity.username) {
            throw new Error('Jupyter worker identity does not match its owner');
          }
        } catch (error) {
          slot.retiring = true;
          try {
            await started.close();
            delete slot.worker;
          } catch (cleanupError) {
            throw new AggregateError(
              [error, cleanupError],
              'Jupyter worker became unusable during startup and cleanup failed'
            );
          }
          throw error;
        }
      }
      const worker = slot.worker;
      if (identity.grantId !== undefined || identity.session !== undefined) {
        const generation = identity.grantGeneration ?? 0;
        const changed = worker.credentialDigest !== credentialDigest(identity.assertion());
        if (generation === slot.grantGeneration && changed) {
          throw new Error('Jupyter grant credential changed without a new generation');
        }
        if (generation > slot.grantGeneration) {
          if (changed) {
            if (worker.renew === undefined) throw new Error('Jupyter worker cannot renew its credential');
            await worker.renew(identity);
          }
          slot.grantGeneration = generation;
          signal?.throwIfAborted();
          this.validate(identity);
        }
      }
      let released = false;
      return {
        client: worker.client,
        worker,
        release: async (): Promise<void> => {
          if (released) return;
          released = true;
          releaseLock?.();
          await this.#dropReference(slot);
        }
      };
    } catch (error) {
      releaseLock?.();
      await this.#dropReference(slot);
      throw error;
    }
  }

  async withClient<T>(
    identity: GatewayIdentity,
    signal: AbortSignal | undefined,
    operation: (client: Client) => Promise<T>
  ): Promise<T> {
    const lease = await this.acquire(identity, signal);
    try {
      return await operation(lease.client);
    } finally {
      await lease.release();
    }
  }

  async #dropReference(slot: Slot): Promise<void> {
    slot.references -= 1;
    if (slot.references === 0 && slot.worker === undefined) {
      this.#slots.delete(slot.key);
    }
  }

  #pruneRetiredGrants(now: number): void {
    for (const [grantId, deadline] of this.#retiredGrants) {
      if (deadline <= now) this.#retiredGrants.delete(grantId);
    }
  }

  async expire(now = Date.now() / 1000): Promise<void> {
    this.#pruneRetiredGrants(now);
    const expired = [...this.#slots.values()].filter(
      (slot) =>
        slot.references === 0 &&
        slot.worker !== undefined &&
        (slot.retiring || (slot.session === undefined
          ? (slot.grantExpiresAt ?? slot.worker.expiresAt) <= now
          : slot.session.expiresAt !== undefined && slot.session.expiresAt <= now))
    );
    for (const slot of expired) slot.retiring = true;
    await this.#retireAll(expired, 'Failed to retire expired workers');
  }

  async retireGrant(grantId: string, grantExpiresAt: number): Promise<void> {
    if (!Number.isFinite(grantExpiresAt)) throw new Error('Invalid revoked grant deadline');
    this.#retiredGrants.set(grantId, Math.max(this.#retiredGrants.get(grantId) ?? 0, grantExpiresAt));
    const slots = [...this.#slots.values()].filter((slot) => slot.grantId === grantId);
    for (const slot of slots) slot.retiring = true;
    await this.#retireAll(slots, 'Failed to retire revoked grant workers');
  }

  async sweep(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      await waitForDelay(this.settings.expiryPollMs, signal);
      if (signal.aborted) return;
      try {
        await this.expire();
      } catch (error) {
        if (!(error instanceof AggregateError)) throw error;
      }
    }
  }

  async close(): Promise<void> {
    this.#closed = true;
    const slots = [...this.#slots.values()];
    for (const slot of slots) slot.retiring = true;
    await this.#retireAll(slots, 'Failed to close workers');
  }

  async #retireAll(slots: readonly Slot[], message: string): Promise<void> {
    const results = await Promise.allSettled(slots.map((slot) => this.#retire(slot)));
    const failures = results.flatMap((result) =>
      result.status === 'rejected' ? [result.reason] : []
    );
    if (failures.length > 0) throw new AggregateError(failures, message);
  }

  async #retire(slot: Slot): Promise<void> {
    const release = await slot.lock.acquire();
    try {
      if (slot.worker !== undefined) {
        await slot.worker.close();
        delete slot.worker;
      }
    } finally {
      release();
    }
    if (slot.references === 0 && slot.worker === undefined) {
      this.#slots.delete(slot.key);
    }
  }
}
