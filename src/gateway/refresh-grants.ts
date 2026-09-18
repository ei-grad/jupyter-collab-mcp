import { createHmac } from 'node:crypto';

import { EncryptedStore } from './crypto-store.js';
import { AccessIdentity, type IdentityBinding } from './identity.js';

const RECEIPT_SECONDS = 10;
const INFLIGHT_SECONDS = 45;

export interface UpstreamTokenSet {
  readonly assertion: string;
  readonly refreshToken?: string;
  readonly refreshExpiresIn?: number;
}

export interface GrantAccessRecord {
  readonly clientId: string;
  readonly grantId: string;
  readonly generation: number;
  readonly expiresAt: number;
}

interface RefreshReference {
  readonly clientId: string;
  readonly grantId: string;
  readonly generation: number;
}

interface TokenPair {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly accessExpiresAt: number;
}

interface GrantFamily {
  readonly clientId: string;
  readonly binding: IdentityBinding;
  readonly expiresAt: number;
  readonly generation: number;
  readonly status: 'active' | 'refreshing' | 'revoked';
  readonly assertion: string;
  readonly upstreamRefreshToken: string;
  readonly refreshDigest: string;
  readonly refreshingSince?: number;
  readonly receipt?: {
    readonly digest: string;
    readonly expiresAt: number;
    readonly pair: TokenPair;
  };
}

export class RefreshGrantError extends Error {
  constructor(readonly reason: 'invalid_grant' | 'inflight') {
    super('refresh grant is unavailable');
  }
}

export interface RefreshGrantOptions {
  readonly store: EncryptedStore;
  readonly signingKey: string;
  readonly now: () => number;
  readonly randomToken: () => string;
  readonly refresh: (token: string) => Promise<UpstreamTokenSet>;
  readonly verify: (assertion: string, expected?: IdentityBinding) => Promise<AccessIdentity>;
  readonly onRevoked?: (grantId: string, grantExpiresAt: number) => Promise<void>;
}

/** Rotating grant families. Redis CAS is the authority, never a process-local lock. */
export class RefreshGrants {
  constructor(readonly options: RefreshGrantOptions) {}

  #digest(token: string): string {
    return createHmac('sha256', this.options.signingKey).update(token).digest('base64url');
  }

  #response(pair: TokenPair, grantExpiresAt: number): Record<string, unknown> {
    return {
      access_token: pair.accessToken,
      refresh_token: pair.refreshToken,
      token_type: 'Bearer',
      expires_in: Math.max(0, Math.floor(pair.accessExpiresAt - this.options.now())),
      refresh_token_expires_in: Math.max(0, Math.floor(grantExpiresAt - this.options.now())),
      scope: 'openid email'
    };
  }

  async #preparePair(grantId: string, family: GrantFamily, identity: AccessIdentity): Promise<TokenPair> {
    const pair: TokenPair = {
      accessToken: this.options.randomToken(),
      refreshToken: this.options.randomToken(),
      accessExpiresAt: Math.min(identity.expiresAt, family.expiresAt)
    };
    const ttl = pair.accessExpiresAt - this.options.now();
    if (ttl < 1) throw new RefreshGrantError('invalid_grant');
    await this.options.store.put('access-tokens', this.#digest(pair.accessToken), {
      clientId: family.clientId, grantId, generation: family.generation,
      expiresAt: pair.accessExpiresAt
    } satisfies GrantAccessRecord, ttl);
    // Old references remain as encrypted replay markers until the absolute
    // family deadline. They contain no upstream credential or usable token.
    await this.options.store.put('refresh-tokens', this.#digest(pair.refreshToken), {
      clientId: family.clientId, grantId, generation: family.generation
    } satisfies RefreshReference, family.expiresAt - this.options.now());
    return pair;
  }

  async create(clientId: string, identity: AccessIdentity, upstreamRefreshToken: string, expiresAt: number): Promise<Record<string, unknown>> {
    if (!upstreamRefreshToken || expiresAt <= this.options.now()) throw new RefreshGrantError('invalid_grant');
    const grantId = this.options.randomToken();
    const family: GrantFamily = {
      clientId, binding: identity.binding(), expiresAt, generation: 0, status: 'active',
      assertion: identity.assertion(), upstreamRefreshToken, refreshDigest: ''
    };
    const pair = await this.#preparePair(grantId, family, identity);
    const committed = await this.options.store.compareAndSwap('grant-families', grantId, null, {
      ...family, refreshDigest: this.#digest(pair.refreshToken)
    }, expiresAt - this.options.now());
    if (!committed) throw new RefreshGrantError('invalid_grant');
    return this.#response(pair, expiresAt);
  }

  async identity(record: GrantAccessRecord): Promise<AccessIdentity | null> {
    if (!Number.isFinite(record.expiresAt) || record.expiresAt <= this.options.now() ||
        !Number.isSafeInteger(record.generation) || record.generation < 0) return null;
    const family = await this.options.store.get<GrantFamily>('grant-families', record.grantId);
    if (family === null || family.clientId !== record.clientId || family.status === 'revoked' ||
        family.expiresAt <= this.options.now() || record.generation > family.generation) return null;
    try {
      const identity = await this.options.verify(family.assertion, family.binding);
      if (Math.min(record.expiresAt, family.expiresAt, identity.expiresAt) <= this.options.now()) return null;
      return identity.forGrant(record.grantId, family.expiresAt, family.generation, record.expiresAt);
    } catch {
      return null;
    }
  }

  async revoke(grantId: string, clientId: string): Promise<void> {
    for (let attempt = 0; attempt < 8; attempt++) {
      const current = await this.options.store.readVersion<GrantFamily>('grant-families', grantId);
      if (current === null || current.value.clientId !== clientId || current.value.expiresAt <= this.options.now()) return;
      if (current.value.status === 'revoked' || await this.options.store.compareAndSwap(
        'grant-families', grantId, current.version,
        { ...current.value, status: 'revoked', upstreamRefreshToken: '', assertion: '', receipt: undefined },
        current.value.expiresAt - this.options.now()
      )) {
        try {
          await this.options.onRevoked?.(grantId, current.value.expiresAt);
        } catch {
          process.stderr.write('oauth_grant_cleanup_failed\n');
        }
        return;
      }
    }
    throw new RefreshGrantError('invalid_grant');
  }

  async refresh(clientId: string, token: string): Promise<Record<string, unknown>> {
    const digest = this.#digest(token);
    const reference = await this.options.store.get<RefreshReference>('refresh-tokens', digest);
    // An unrelated or incorrectly authenticated client may not claim, consume,
    // or revoke another client's token, even when it knows the token value.
    if (reference === null || reference.clientId !== clientId) throw new RefreshGrantError('invalid_grant');
    const waitUntil = Date.now() + INFLIGHT_SECONDS * 1000;
    for (;;) {
      const current = await this.options.store.readVersion<GrantFamily>('grant-families', reference.grantId);
      if (current === null || current.value.clientId !== clientId || current.value.expiresAt <= this.options.now() || current.value.status === 'revoked') {
        throw new RefreshGrantError('invalid_grant');
      }
      const family = current.value;
      if (family.receipt?.digest === digest && family.receipt.expiresAt > this.options.now() &&
          family.receipt.pair.accessExpiresAt > this.options.now()) {
        return this.#response(family.receipt.pair, family.expiresAt);
      }
      if (family.refreshDigest !== digest || family.generation !== reference.generation) {
        await this.revoke(reference.grantId, clientId);
        throw new RefreshGrantError('invalid_grant');
      }
      if (family.status === 'refreshing') {
        if (family.refreshingSince === undefined || family.refreshingSince + INFLIGHT_SECONDS <= this.options.now()) {
          await this.revoke(reference.grantId, clientId);
          throw new RefreshGrantError('invalid_grant');
        }
        if (Date.now() >= waitUntil) throw new RefreshGrantError('inflight');
        await new Promise((resolve) => setTimeout(resolve, 25));
        continue;
      }
      const claimed = { ...family, status: 'refreshing' as const, refreshingSince: this.options.now() };
      if (!await this.options.store.compareAndSwap(
        'grant-families', reference.grantId, current.version, claimed, family.expiresAt - this.options.now()
      )) continue;
      return this.#renew(reference.grantId, clientId, digest, claimed);
    }
  }

  async #renew(grantId: string, clientId: string, digest: string, claimed: GrantFamily): Promise<Record<string, unknown>> {
    try {
      const tokens = await this.options.refresh(claimed.upstreamRefreshToken);
      const identity = await this.options.verify(tokens.assertion, claimed.binding);
      const expiresAt = claimed.expiresAt;
      if (!Number.isFinite(expiresAt) || expiresAt <= this.options.now()) throw new RefreshGrantError('invalid_grant');
      const next: GrantFamily = {
        clientId, binding: claimed.binding, expiresAt, generation: claimed.generation + 1,
        status: 'active', assertion: tokens.assertion,
        upstreamRefreshToken: tokens.refreshToken ?? claimed.upstreamRefreshToken,
        refreshDigest: ''
      };
      if (!next.upstreamRefreshToken) throw new RefreshGrantError('invalid_grant');
      const pair = await this.#preparePair(grantId, next, identity);
      const current = await this.options.store.readVersion<GrantFamily>('grant-families', grantId);
      if (current === null || current.value.status !== 'refreshing' || current.value.generation !== claimed.generation ||
          current.value.refreshDigest !== digest) throw new RefreshGrantError('invalid_grant');
      const committed = await this.options.store.compareAndSwap('grant-families', grantId, current.version, {
        ...next, refreshDigest: this.#digest(pair.refreshToken),
        receipt: { digest, expiresAt: Math.min(this.options.now() + RECEIPT_SECONDS, pair.accessExpiresAt), pair }
      }, expiresAt - this.options.now());
      if (!committed) throw new RefreshGrantError('invalid_grant');
      return this.#response(pair, expiresAt);
    } catch {
      // Once an upstream request may have consumed a rotating token, retrying
      // it is unsafe. Persist revocation rather than inventing a valid grant.
      await this.revoke(grantId, clientId);
      process.stderr.write('oauth_refresh_failed reason=renewal_rejected\n');
      throw new RefreshGrantError('invalid_grant');
    }
  }
}
