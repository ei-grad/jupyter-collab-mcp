import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { beforeAll, describe, expect, it } from 'vitest';

import { createCloudflareAccessGate } from '../../src/gateway/access.js';
import { loadCloudflareAccessConfig } from '../../src/gateway/config.js';
import type { GatewayAuthGate } from '../../src/gateway/http.js';

const NOW = 1_800_000_000;
export const accessEnvironment = {
  JUPYTER_MCP_PUBLIC_URL: 'https://mcp.example.invalid',
  JUPYTER_MCP_ACCESS_ISSUER: 'https://team.cloudflareaccess.com',
  JUPYTER_MCP_ACCESS_AUDIENCE: 'app-audience',
  JUPYTER_MCP_USERNAME_EMAIL_DOMAIN: 'example.invalid',
  JUPYTER_MCP_ALLOWED_USERS: 'alice bob',
  JUPYTER_MCP_API_BASE_URL: 'http://jupyter:8000',
  JUPYTER_MCP_ALLOW_MISSING_EMAIL_VERIFIED: 'true'
};
let privateKey: CryptoKey;
let gate: GatewayAuthGate;

async function assertion(changes: Record<string, unknown> = {}) {
  return new SignJWT({ iss: 'https://team.cloudflareaccess.com', aud: ['app-audience'],
    sub: 'alice-sub', email: 'alice@example.invalid', exp: NOW + 300, ...changes })
    .setProtectedHeader({ alg: 'RS256', kid: 'test' }).sign(privateKey);
}

beforeAll(async () => {
  const keys = await generateKeyPair('RS256', { extractable: true });
  privateKey = keys.privateKey;
  gate = createCloudflareAccessGate(loadCloudflareAccessConfig(accessEnvironment), {
    now: () => NOW,
    getKey: createLocalJWKSet({ keys: [{ ...await exportJWK(keys.publicKey), kid: 'test', alg: 'RS256' }] })
  });
});

describe('Cloudflare Access assertion mode', () => {
  it('needs no local OAuth secrets, registration configuration or Redis', () => {
    const config = loadCloudflareAccessConfig(accessEnvironment);
    expect(config.accessIssuer).toBe('https://team.cloudflareaccess.com');
    expect(config.sessionTtlSeconds).toBe(28800);
    expect(config).not.toHaveProperty('redisUrl');
    expect(config).not.toHaveProperty('oidcClientSecret');
  });

  it('allows idle-only session retention without extending credential validity', () => {
    const config = loadCloudflareAccessConfig({ ...accessEnvironment,
      JUPYTER_MCP_ACCESS_SESSION_TTL_SECONDS: '0',
      JUPYTER_MCP_ACCESS_SESSION_IDLE_SECONDS: '7200'
    });
    expect(config.sessionTtlSeconds).toBe(0);
    expect(config.sessionIdleSeconds).toBe(7200);
  });

  it.each(['-1', '0.5', 'Infinity', '2147484'])(
    'rejects unsupported Access retention durations %s', (value) => {
      for (const name of ['TTL', 'IDLE']) {
        expect(() => loadCloudflareAccessConfig({ ...accessEnvironment,
          [`JUPYTER_MCP_ACCESS_SESSION_${name}_SECONDS`]: value
        })).toThrow();
      }
    }
  );

  it.each(['http://team.cloudflareaccess.com', 'https://issuer.example', 'https://team.cloudflareaccess.com/path'])('rejects an invalid issuer %s', (issuer) => {
    expect(() => loadCloudflareAccessConfig({ ...accessEnvironment, JUPYTER_MCP_ACCESS_ISSUER: issuer })).toThrow();
  });

  it('verifies identity and passes only the exact signed assertion to Jupyter', async () => {
    const token = await assertion();
    const result = await gate(new Request('https://mcp.example.invalid/mcp', { headers: {
      'cf-access-jwt-assertion': token,
      'cf-access-authenticated-user-email': 'bob@example.invalid',
      authorization: 'Bearer oauth:opaque-client-token'
    } }));
    expect(result).not.toBeInstanceOf(Response);
    if (result instanceof Response) throw new Error('authentication failed');
    expect(result.identity.username).toBe('alice');
    expect(result.identity.assertion()).toBe(token);
  });

  it.each([
    { iss: 'https://other.cloudflareaccess.com' }, { aud: ['another-app'] },
    { exp: NOW }, { exp: undefined }, { nbf: NOW + 1 }, { sub: '' },
    { email: 'alice@other.invalid' }, { email: 'unprovisioned@example.invalid' },
    { email_verified: false }, { email_verified: null }
  ])('rejects an invalid signed claim set %#', async (changes) => {
    const result = await gate(new Request('https://mcp.example.invalid/mcp', {
      headers: { 'cf-access-jwt-assertion': await assertion(changes) }
    }));
    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(401);
  });

  it('rejects bearer-only, forged, missing and duplicate assertions', async () => {
    const valid = await assertion();
    for (const headers of [
      { authorization: `Bearer ${valid}` }, {},
      { 'cf-access-jwt-assertion': `${valid}, ${valid}` },
      { 'cf-access-jwt-assertion': valid.slice(0, -20) + 'aaaaaaaaaaaaaaaaaaaa' }
    ]) {
      const result = await gate(new Request('https://mcp.example.invalid/mcp', { headers }));
      expect((result as Response).status).toBe(401);
    }
  });
});
