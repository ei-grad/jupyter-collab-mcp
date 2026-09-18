import { createHash, createHmac } from 'node:crypto';

import { exchangeAuthorization, refreshAuthorization, registerClient, resolveClientMetadata } from '@modelcontextprotocol/client';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { beforeAll, describe, expect, it } from 'vitest';

import { loadGatewayConfig } from '../../src/gateway/config.js';
import { EncryptedStore, MemoryKeyValueBackend } from '../../src/gateway/crypto-store.js';
import { createGatewayOAuth } from '../../src/gateway/oauth.js';

const PUBLIC = 'https://mcp.example';
const CALLBACK = 'http://localhost:12345/callback';
let privateKey: CryptoKey;
let jwk: Awaited<ReturnType<typeof exportJWK>>;

beforeAll(async () => {
  const pair = await generateKeyPair('RS256', { extractable: true });
  privateKey = pair.privateKey;
  jwk = { ...await exportJWK(pair.publicKey), kid: 'fixture', alg: 'RS256' };
});

async function fixture(mode = 'rotate') {
  const config = loadGatewayConfig({
    JUPYTER_MCP_PUBLIC_URL: PUBLIC,
    JUPYTER_MCP_OIDC_CONFIG_URL: 'https://issuer.example/.well-known/openid-configuration',
    JUPYTER_MCP_OIDC_CLIENT_ID: 'gateway-client', JUPYTER_MCP_OIDC_CLIENT_SECRET: 'synthetic-client-secret',
    JUPYTER_MCP_REDIS_URL: 'unix:///run/redis/redis.sock',
    JUPYTER_MCP_STORAGE_KEY: Buffer.alloc(32, 4).toString('base64url') + '=',
    JUPYTER_MCP_SIGNING_KEY: 's'.repeat(32), JUPYTER_MCP_REDIRECT_URIS: 'http://localhost:*',
    JUPYTER_MCP_USERNAME_EMAIL_DOMAIN: 'example.invalid', JUPYTER_MCP_ALLOWED_USERS: 'alice bob',
    JUPYTER_MCP_API_BASE_URL: 'http://jupyter:8000',
    JUPYTER_MCP_ENABLE_REFRESH: 'true', JUPYTER_MCP_REFRESH_GRANT_TTL_SECONDS: '28800'
  });
  const store = new EncryptedStore(new MemoryKeyValueBackend(), config.storageKey);
  let nonce = '';
  const requests: URLSearchParams[] = [];
  let upstreamRefresh = 'upstream-original';
  let refreshCount = 0;
  const issue = (subject = 'alice-id') => new SignJWT({
    email: 'alice@example.invalid', email_verified: true, nonce
  }).setProtectedHeader({ alg: 'RS256', kid: 'fixture' })
    .setIssuer('https://issuer.example').setAudience('gateway-client').setSubject(subject)
    .setIssuedAt().setExpirationTime('5m').setJti(`generation-${refreshCount}`).sign(privateKey);
  const upstreamFetch: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    expect(url.protocol).toBe('https:');
    expect(init?.redirect).toBe('manual');
    if (url.pathname === '/.well-known/openid-configuration') return Response.json({
      issuer: 'https://issuer.example', authorization_endpoint: 'https://issuer.example/authorize',
      token_endpoint: 'https://issuer.example/token', jwks_uri: 'https://issuer.example/jwks',
      grant_types_supported: ['authorization_code', 'refresh_token'], scopes_supported: ['openid', 'email', 'offline_access']
    });
    if (url.pathname === '/jwks') return Response.json({ keys: [jwk] });
    if (url.pathname !== '/token') throw new Error('unexpected upstream request');
    expect(new Headers(init?.headers).get('authorization')).toMatch(/^Basic /);
    const body = new URLSearchParams(String(init?.body));
    requests.push(body);
    const refreshing = body.get('grant_type') === 'refresh_token';
    if (refreshing) {
      expect(body.get('refresh_token')).toBe(upstreamRefresh);
      refreshCount++;
      if (mode === 'redirect') return new Response(null, { status: 302, headers: { location: 'https://attacker.example/token' } });
      if (mode !== 'retain') upstreamRefresh = `upstream-rotated-${refreshCount}`;
    } else {
      expect(body.get('grant_type')).toBe('authorization_code');
      expect(body.get('redirect_uri')).toBe(`${PUBLIC}/auth/callback`);
      expect(body.get('code_verifier')).toMatch(/^[A-Za-z0-9_-]{86}$/);
    }
    return Response.json({
      access_token: 'upstream-opaque', token_type: 'Bearer', expires_in: 300,
      ...(refreshing && mode === 'missing-id' ? {} : { id_token: await issue(refreshing && mode === 'changed-sub' ? 'bob-id' : 'alice-id') }),
      ...(refreshing && mode === 'retain' ? {} : { refresh_token: upstreamRefresh }),
      refresh_token_expires_in: 28800
    });
  };
  let oauth = await createGatewayOAuth(config, store, upstreamFetch);
  const fetchFn: typeof fetch = async (input, init) => {
    const response = await oauth.handle(new Request(input, init));
    if (response === null) throw new Error('unexpected gateway route');
    return response;
  };
  const clientInformation = await registerClient(PUBLIC, {
    clientMetadata: resolveClientMetadata({ redirectUrl: CALLBACK, clientMetadata: {
      redirect_uris: [CALLBACK], response_types: ['code'], token_endpoint_auth_method: 'none'
    } }), fetchFn
  });
  const verifier = 'v'.repeat(64);
  const authorize = new URL(`${PUBLIC}/authorize`);
  authorize.search = new URLSearchParams({
    client_id: clientInformation.client_id, redirect_uri: CALLBACK, response_type: 'code',
    scope: 'openid email', state: 'downstream-state', code_challenge_method: 'S256',
    code_challenge: createHash('sha256').update(verifier).digest('base64url')
  }).toString();
  const authorization = await fetchFn(authorize);
  expect(authorization.status).toBe(303);
  const upstream = new URL(authorization.headers.get('location')!);
  expect(upstream.searchParams.get('scope')).toBe('openid email offline_access');
  nonce = upstream.searchParams.get('nonce')!;
  const callback = new URL(`${PUBLIC}/auth/callback`);
  callback.searchParams.set('state', upstream.searchParams.get('state')!);
  callback.searchParams.set('code', 'upstream-code');
  const finished = await fetchFn(callback);
  const code = new URL(finished.headers.get('location')!).searchParams.get('code')!;
  expect(code).not.toBeNull();
  const tokens = await exchangeAuthorization(PUBLIC, {
    clientInformation, authorizationCode: code, codeVerifier: verifier, redirectUri: CALLBACK, fetchFn
  });
  return {
    config, store, tokens, requests, clientInformation, fetchFn, issue,
    verify: (token: string) => oauth.verifyBearer(`Bearer ${token}`),
    restart: async () => { oauth = await createGatewayOAuth(config, store, upstreamFetch); }
  };
}

describe('native SDK refresh through real openid-client', () => {
  it.each(['rotate', 'retain'])('renews with upstream token policy %s and survives gateway reconstruction', async (mode) => {
    const f = await fixture(mode);
    expect(f.clientInformation.grant_types).toEqual(['authorization_code', 'refresh_token']);
    expect(f.tokens.refresh_token).toBeTypeOf('string');
    expect(f.tokens.expires_in).toBeGreaterThan(0);
    expect(f.tokens.expires_in).toBeLessThanOrEqual(300);
    const original = await f.verify(f.tokens.access_token);
    if (original instanceof Response) throw new Error('initial token denied');
    await f.restart();
    const refresh = () => refreshAuthorization(PUBLIC, {
      clientInformation: f.clientInformation, refreshToken: f.tokens.refresh_token!, fetchFn: f.fetchFn
    });
    const [a, b] = await Promise.all([refresh(), refresh()]);
    expect(a.access_token).toBe(b.access_token);
    expect(a.refresh_token).toBe(b.refresh_token);
    expect(a.access_token).not.toBe(f.tokens.access_token);
    expect(a.refresh_token).not.toBe(f.tokens.refresh_token);
    expect(f.requests.filter((request) => request.get('grant_type') === 'refresh_token')).toHaveLength(1);
    const renewed = await f.verify(a.access_token);
    if (renewed instanceof Response) throw new Error('renewed token denied');
    expect(renewed.identity.grantId).toBe(original.identity.grantId);
    expect(renewed.identity.username).toBe('alice');
    expect(renewed.identity.assertion()).not.toBe(original.identity.assertion());
    expect(renewed.identity.grantGeneration).toBe(1);
    await f.restart();
    const next = await refreshAuthorization(PUBLIC, {
      clientInformation: f.clientInformation, refreshToken: a.refresh_token!, fetchFn: f.fetchFn
    });
    expect(await f.verify(next.access_token)).not.toBeInstanceOf(Response);
    expect(f.requests.filter((request) => request.get('grant_type') === 'refresh_token')).toHaveLength(2);
  });

  it.each(['missing-id', 'changed-sub', 'redirect'])('denies upstream renewal failure %s without keeping the family usable', async (mode) => {
    const f = await fixture(mode);
    await expect(refreshAuthorization(PUBLIC, {
      clientInformation: f.clientInformation, refreshToken: f.tokens.refresh_token!, fetchFn: f.fetchFn
    })).rejects.toThrow();
    expect(await f.verify(f.tokens.access_token)).toBeInstanceOf(Response);
  });

  it('accepts existing registrations and unexpired legacy access records without granting refresh', async () => {
    const f = await fixture();
    await f.store.put('clients', 'legacy-client', {
      clientId: 'legacy-client', redirectUris: [CALLBACK], tokenEndpointAuthMethod: 'none'
    });
    const access = 'legacy-opaque-token';
    await f.store.put('access-tokens', createHmac('sha256', f.config.signingKey).update(access).digest('base64url'), {
      clientId: 'legacy-client', assertion: await f.issue()
    }, 300);
    await f.restart();
    expect(await f.verify(access)).not.toBeInstanceOf(Response);
    const refresh = await f.fetchFn(`${PUBLIC}/token`, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', client_id: 'legacy-client', refresh_token: 'invented' })
    });
    expect(refresh.status).toBe(400);
    expect(await refresh.json()).toMatchObject({ error: 'invalid_grant' });
    expect(await f.store.get('clients', 'legacy-client')).not.toBeNull();
  });

  it('rejects a registered foreign client without consuming the owner refresh grant', async () => {
    const f = await fixture();
    const foreign = await registerClient(PUBLIC, {
      clientMetadata: {
        redirect_uris: [CALLBACK], grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'], token_endpoint_auth_method: 'none'
      }, fetchFn: f.fetchFn
    });
    await expect(refreshAuthorization(PUBLIC, {
      clientInformation: foreign, refreshToken: f.tokens.refresh_token!, fetchFn: f.fetchFn
    })).rejects.toThrow();
    expect(f.requests.filter((request) => request.get('grant_type') === 'refresh_token')).toHaveLength(0);
    const renewed = await refreshAuthorization(PUBLIC, {
      clientInformation: f.clientInformation, refreshToken: f.tokens.refresh_token!, fetchFn: f.fetchFn
    });
    expect(await f.verify(renewed.access_token)).not.toBeInstanceOf(Response);
  });

  it('accepts the same scope set in any order and rejects widening before renewal', async () => {
    const f = await fixture();
    const request = (scope: string) => f.fetchFn(`${PUBLIC}/token`, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', client_id: f.clientInformation.client_id,
        refresh_token: f.tokens.refresh_token!, scope })
    });
    expect((await request('openid email offline_access')).status).toBe(400);
    expect(f.requests.filter((entry) => entry.get('grant_type') === 'refresh_token')).toHaveLength(0);
    const response = await request('email openid');
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ scope: 'openid email' });
  });
});
