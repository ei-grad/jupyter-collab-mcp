import { generateKeyPair, exportJWK, SignJWT, createLocalJWKSet } from 'jose';
import { beforeAll, describe, expect, it } from 'vitest';

import { IdentityVerifier } from '../../src/gateway/identity.js';

const NOW = 1_800_000_000;
let privateKey: CryptoKey;
let verifier: IdentityVerifier;

async function issue(changes: Record<string, unknown> = {}): Promise<string> {
  const claims = {
    iss: 'https://issuer.example',
    aud: 'gateway-client',
    sub: 'alice-id',
    email: 'alice.person@example.invalid',
    email_verified: true,
    exp: NOW + 120,
    ...changes
  };
  return new SignJWT(claims)
    .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
    .sign(privateKey);
}

beforeAll(async () => {
  const pair = await generateKeyPair('RS256', { extractable: true });
  privateKey = pair.privateKey;
  const jwk = await exportJWK(pair.publicKey);
  verifier = new IdentityVerifier({
    issuer: 'https://issuer.example',
    audience: 'gateway-client',
    jwksUri: new URL('https://issuer.example/jwks'),
    emailDomain: 'example.invalid',
    usernameMode: 'email-localpart-dashes',
    allowedUsers: new Set(['alice-person']),
    now: () => NOW,
    getKey: createLocalJWKSet({ keys: [{ ...jwk, kid: 'test-key', alg: 'RS256' }] })
  });
});

describe('OIDC access identity', () => {
  it('retains the exact assertion outside serialization and maps its verified email', async () => {
    const assertion = await issue();
    const identity = await verifier.verify(assertion);
    expect(identity.principal()).toEqual(['https://issuer.example', 'alice-id']);
    expect(identity.username).toBe('alice-person');
    expect(identity.assertion()).toBe(assertion);
    expect(JSON.stringify(identity)).not.toContain(assertion);
    expect(identity.assertionDigest()).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it.each([
    { exp: NOW - 1 },
    { exp: null },
    { nbf: NOW + 1 },
    { iss: 'https://other.example' },
    { aud: 'other-client' },
    { sub: '' },
    { email: 'alice.person@other.invalid' },
    { email: 'unknown@example.invalid' },
    { email: 'Alice.Person@example.invalid' },
    { email_verified: false },
    { email_verified: 'true' },
    { email_verified: 1 }
  ])('rejects an invalid signed identity %#', async (changes) => {
    await expect(verifier.verify(await issue(changes))).rejects.toThrow(
      'access ID token is missing or invalid'
    );
  });

  it('requires the email_verified claim to be present', async () => {
    const token = await new SignJWT({
      iss: 'https://issuer.example',
      aud: 'gateway-client',
      sub: 'alice-id',
      email: 'alice.person@example.invalid',
      exp: NOW + 120
    })
      .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
      .sign(privateKey);
    await expect(verifier.verify(token)).rejects.toThrow('access ID token is missing or invalid');
  });
});
