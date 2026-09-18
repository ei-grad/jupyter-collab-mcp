import { createHmac } from 'node:crypto';

import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import { EncryptedStore, MemoryKeyValueBackend } from '../../src/gateway/crypto-store.js';
import { IdentityVerifier } from '../../src/gateway/identity.js';
import { RefreshGrants, type GrantAccessRecord, type UpstreamTokenSet } from '../../src/gateway/refresh-grants.js';

const START = 1_800_000_000;
const SIGNING_KEY = 's'.repeat(32);
let privateKey: CryptoKey;
let otherKey: CryptoKey;
let getKey: ReturnType<typeof createLocalJWKSet>;

beforeAll(async () => {
  const pair = await generateKeyPair('RS256', { extractable: true });
  privateKey = pair.privateKey;
  otherKey = (await generateKeyPair('RS256')).privateKey;
  getKey = createLocalJWKSet({ keys: [{ ...await exportJWK(pair.publicKey), kid: 'fixture', alg: 'RS256' }] });
});

async function fixture() {
  let now = START;
  let sequence = 0;
  const backend = new MemoryKeyValueBackend(() => now * 1000);
  const store = new EncryptedStore(backend, Buffer.alloc(32, 7), () => now * 1000);
  const verifier = new IdentityVerifier({
    issuer: 'https://issuer.example', audience: 'client', jwksUri: new URL('https://issuer.example/jwks'),
    emailDomain: 'example.invalid', usernameMode: 'email-localpart', allowedUsers: new Set(['alice', 'bob']),
    now: () => now, getKey
  });
  const issue = (changes: Record<string, unknown> = {}, key = privateKey) => new SignJWT({
    iss: 'https://issuer.example', aud: 'client', sub: 'alice-id', email: 'alice@example.invalid',
    email_verified: true, exp: now + 300, nonce: 'private-original-nonce', auth_time: START - 10,
    ...changes
  }).setProtectedHeader({ alg: 'RS256', kid: 'fixture' }).sign(key);
  const refresh = vi.fn(async (_token: string): Promise<UpstreamTokenSet> => ({
    assertion: await issue(), refreshToken: `upstream-rotated-${sequence}`
  }));
  const onRevoked = vi.fn(async () => undefined);
  const options = {
    store, signingKey: SIGNING_KEY, now: () => now,
    randomToken: () => `opaque-${++sequence}-${'x'.repeat(40)}`,
    verify: (assertion: string, expected?: Parameters<IdentityVerifier['verify']>[1]) => verifier.verify(assertion, expected),
    refresh, onRevoked
  };
  const grants = new RefreshGrants(options);
  const initial = await grants.create('downstream-client', await verifier.verify(await issue()), 'upstream-original', now + 28800);
  const digest = (token: string) => createHmac('sha256', SIGNING_KEY).update(token).digest('base64url');
  const accessRecord = async (token: unknown) => store.get<GrantAccessRecord>('access-tokens', digest(String(token)));
  return { grants, store, backend, options, initial, issue, verifier, refresh, onRevoked,
    accessRecord, setNow: (value: number) => { now = value; } };
}

describe('persistent rotating refresh families', () => {
  it('renews a real signed identity without extending an old access token or absolute grant', async () => {
    const f = await fixture();
    const old = (await f.accessRecord(f.initial.access_token))!;
    const originalIdentity = await f.grants.identity(old);
    f.setNow(START + 290);
    const next = await f.grants.refresh('downstream-client', String(f.initial.refresh_token));
    const current = (await f.accessRecord(next.access_token))!;
    expect(next.expires_in).toBe(300);
    expect(next.refresh_token_expires_in).toBe(28800 - 290);
    expect(f.refresh).toHaveBeenCalledWith('upstream-original');
    expect((await f.grants.identity(current))?.grantId).toBe(originalIdentity?.grantId);
    expect((await f.grants.identity(old))?.assertion()).toBe((await f.grants.identity(current))?.assertion());
    f.setNow(START + 300);
    expect(await f.grants.identity(old)).toBeNull();
    expect(await f.grants.identity(current)).not.toBeNull();
    f.setNow(START + 28800);
    expect(await f.grants.identity(current)).toBeNull();
    await expect(f.grants.refresh('downstream-client', String(next.refresh_token))).rejects.toMatchObject({ reason: 'invalid_grant' });
  });

  it('shares one persisted rotation receipt for concurrent and immediate duplicate requests', async () => {
    const f = await fixture();
    let resume!: () => void;
    const barrier = new Promise<void>((resolve) => { resume = resolve; });
    f.refresh.mockImplementation(async () => {
      await barrier;
      return { assertion: await f.issue(), refreshToken: 'upstream-rotated' };
    });
    const winner = f.grants.refresh('downstream-client', String(f.initial.refresh_token));
    const loser = new RefreshGrants(f.options).refresh('downstream-client', String(f.initial.refresh_token));
    await vi.waitFor(() => expect(f.refresh).toHaveBeenCalledTimes(1));
    resume();
    const pair = await winner;
    expect(await loser).toEqual(pair);
    f.setNow(START + 5);
    const repeated = await new RefreshGrants(f.options).refresh('downstream-client', String(f.initial.refresh_token));
    expect(repeated.access_token).toBe(pair.access_token);
    expect(repeated.refresh_token).toBe(pair.refresh_token);
    expect(repeated.expires_in).toBe(Number(pair.expires_in) - 5);
    expect(f.refresh).toHaveBeenCalledTimes(1);
    expect(f.onRevoked).not.toHaveBeenCalled();
  });

  it('revokes the family on replay after ten seconds while preserving an independent grant', async () => {
    const f = await fixture();
    const independent = await f.grants.create('downstream-client', await f.verifier.verify(await f.issue()), 'separate-upstream', START + 28800);
    const pair = await f.grants.refresh('downstream-client', String(f.initial.refresh_token));
    const access = (await f.accessRecord(pair.access_token))!;
    f.setNow(START + 10);
    await expect(f.grants.refresh('downstream-client', String(f.initial.refresh_token))).rejects.toMatchObject({ reason: 'invalid_grant' });
    expect(await f.grants.identity(access)).toBeNull();
    expect(await f.grants.identity((await f.accessRecord(independent.access_token))!)).not.toBeNull();
    expect(f.onRevoked).toHaveBeenCalledWith(access.grantId, START + 28800);
  });

  it('checks the client before any consumption or revocation', async () => {
    const f = await fixture();
    await expect(f.grants.refresh('foreign-client', String(f.initial.refresh_token))).rejects.toMatchObject({ reason: 'invalid_grant' });
    expect(f.refresh).not.toHaveBeenCalled();
    expect(f.onRevoked).not.toHaveBeenCalled();
    expect(await f.grants.refresh('downstream-client', String(f.initial.refresh_token))).toHaveProperty('refresh_token');
  });

  it.each([
    { iss: 'https://attacker.invalid' }, { aud: 'wrong' }, { sub: 'bob-id' },
    { email: 'bob@example.invalid' }, { email: 'alice@other.invalid' },
    { email_verified: false }, { exp: START - 1 },
    { nonce: 'different-private-nonce' }, { auth_time: START }
  ])('rejects changed or invalid refreshed identity %#', async (claims) => {
    const f = await fixture();
    f.refresh.mockResolvedValue({ assertion: await f.issue(claims), refreshToken: 'next-upstream' });
    await expect(f.grants.refresh('downstream-client', String(f.initial.refresh_token))).rejects.toMatchObject({ reason: 'invalid_grant' });
    expect(await f.grants.identity((await f.accessRecord(f.initial.access_token))!)).toBeNull();
  });

  it('rejects a forged refreshed signature and never prints error credentials', async () => {
    const f = await fixture();
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      f.refresh.mockResolvedValue({ assertion: await f.issue({}, otherKey) });
      await expect(f.grants.refresh('downstream-client', String(f.initial.refresh_token))).rejects.toThrow('refresh grant is unavailable');
      expect(stderr.mock.calls).toEqual([['oauth_refresh_failed reason=renewal_rejected\n']]);
    } finally { stderr.mockRestore(); }
  });

  it('revokes after an ambiguous upstream timeout without retrying the consumed credential', async () => {
    const f = await fixture();
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      f.refresh.mockRejectedValue(new Error('secret-upstream-refresh-token\nforged-log'));
      await expect(f.grants.refresh('downstream-client', String(f.initial.refresh_token))).rejects.toThrow();
      await expect(f.grants.refresh('downstream-client', String(f.initial.refresh_token))).rejects.toThrow();
      expect(f.refresh).toHaveBeenCalledTimes(1);
      expect(stderr.mock.calls).toEqual([['oauth_refresh_failed reason=renewal_rejected\n']]);
    } finally { stderr.mockRestore(); }
  });

  it('keeps all upstream tokens and idempotency responses encrypted', async () => {
    const f = await fixture();
    const pair = await f.grants.refresh('downstream-client', String(f.initial.refresh_token));
    const stored = JSON.stringify([...f.backend.values]);
    for (const secret of [f.initial.refresh_token, pair.access_token, pair.refresh_token, 'upstream-original']) {
      expect(stored).not.toContain(secret);
    }
  });

  it('requires login after a crashed process leaves an abandoned upstream exchange', async () => {
    const f = await fixture();
    const access = (await f.accessRecord(f.initial.access_token))!;
    const family = await f.store.get<Record<string, unknown>>('grant-families', access.grantId);
    await f.store.put('grant-families', access.grantId, {
      ...family, status: 'refreshing', refreshingSince: START
    }, 28800);
    f.setNow(START + 46);
    await expect(new RefreshGrants(f.options).refresh('downstream-client', String(f.initial.refresh_token))).rejects.toMatchObject({ reason: 'invalid_grant' });
    expect(f.refresh).not.toHaveBeenCalled();
    expect(await f.grants.identity(access)).toBeNull();
  });

  it('does not issue usable tokens when final persistence fails after upstream renewal', async () => {
    const f = await fixture();
    const compareAndSwap = f.store.compareAndSwap.bind(f.store);
    let calls = 0;
    vi.spyOn(f.store, 'compareAndSwap').mockImplementation((...args) => {
      if (++calls === 2) throw new Error('synthetic persistence failure');
      return compareAndSwap(...args);
    });
    await expect(f.grants.refresh('downstream-client', String(f.initial.refresh_token))).rejects.toThrow();
    await expect(f.grants.refresh('downstream-client', String(f.initial.refresh_token))).rejects.toThrow();
    expect(f.refresh).toHaveBeenCalledTimes(1);
    expect(await f.grants.identity((await f.accessRecord(f.initial.access_token))!)).toBeNull();
  });
});
