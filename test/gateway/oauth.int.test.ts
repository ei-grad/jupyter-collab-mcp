import { createHash } from 'node:crypto';

import { exchangeAuthorization, registerClient, resolveClientMetadata } from '@modelcontextprotocol/client';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import * as oidc from 'openid-client';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { loadGatewayConfig } from '../../src/gateway/config.js';
import { EncryptedStore, MemoryKeyValueBackend } from '../../src/gateway/crypto-store.js';
import { IdentityVerifier } from '../../src/gateway/identity.js';
import {
  createGatewayOAuth,
  GatewayOAuth,
  type UpstreamAuthorizationClient
} from '../../src/gateway/oauth.js';

const NOW = 1_800_000_000;
const REDIRECT_URI = 'https://client.example/callback';
let privateKey: CryptoKey;
let localJwks: ReturnType<typeof createLocalJWKSet>;
let publicJwk: Awaited<ReturnType<typeof exportJWK>>;

afterEach(() => vi.restoreAllMocks());

function config() {
  return loadGatewayConfig({
    JUPYTER_MCP_PUBLIC_URL: 'https://mcp.example',
    JUPYTER_MCP_OIDC_CONFIG_URL: 'https://issuer.example/.well-known/openid-configuration',
    JUPYTER_MCP_OIDC_CLIENT_ID: 'gateway-client',
    JUPYTER_MCP_OIDC_CLIENT_SECRET: 'synthetic-client-secret',
    JUPYTER_MCP_REDIS_URL: 'rediss://redis.example',
    JUPYTER_MCP_STORAGE_KEY: Buffer.alloc(32, 9).toString('base64url') + '=',
    JUPYTER_MCP_SIGNING_KEY: 'g'.repeat(32),
    JUPYTER_MCP_REDIRECT_URIS: REDIRECT_URI,
    JUPYTER_MCP_USERNAME_EMAIL_DOMAIN: 'example.invalid',
    JUPYTER_MCP_USERNAME_MODE: 'email-localpart-dashes',
    JUPYTER_MCP_ALLOWED_USERS: 'alice-person',
    JUPYTER_MCP_API_BASE_URL: 'http://jupyter:8000'
  });
}

async function assertion(emailVerified: unknown = true, changes: Record<string, unknown> = {}): Promise<string> {
  return new SignJWT({
    iss: 'https://issuer.example',
    aud: 'gateway-client',
    sub: 'alice-id',
    email: 'alice.person@example.invalid',
    email_verified: emailVerified,
    exp: NOW + 120,
    ...changes
  })
    .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
    .sign(privateKey);
}

class FakeUpstream implements UpstreamAuthorizationClient {
  lastAuthorization:
    | {
        readonly redirectUri: string;
        readonly state: string;
        readonly nonce: string;
        readonly codeChallenge: string;
      }
    | undefined;
  assertion = '';

  authorizationUrl(input: NonNullable<FakeUpstream['lastAuthorization']>): URL {
    this.lastAuthorization = input;
    const url = new URL('https://issuer.example/authorize');
    url.searchParams.set('state', input.state);
    url.searchParams.set('redirect_uri', input.redirectUri);
    url.searchParams.set('nonce', input.nonce);
    url.searchParams.set('code_challenge', input.codeChallenge);
    return url;
  }

  async exchange(input: {
    readonly callbackUrl: URL;
    readonly redirectUri: string;
    readonly state: string;
    readonly nonce: string;
    readonly codeVerifier: string;
  }): Promise<string> {
    expect(input.callbackUrl.searchParams.get('code')).toBe('upstream-code');
    expect(input.state).toBe(this.lastAuthorization?.state);
    expect(input.nonce).toBe(this.lastAuthorization?.nonce);
    expect(createHash('sha256').update(input.codeVerifier).digest('base64url')).toBe(
      this.lastAuthorization?.codeChallenge
    );
    expect(input.redirectUri).toBe('https://mcp.example/auth/callback');
    return this.assertion;
  }
}

beforeAll(async () => {
  const pair = await generateKeyPair('RS256', { extractable: true });
  privateKey = pair.privateKey;
  const jwk = await exportJWK(pair.publicKey);
  publicJwk = { ...jwk, kid: 'test-key', alg: 'RS256' };
  localJwks = createLocalJWKSet({ keys: [{ ...jwk, kid: 'test-key', alg: 'RS256' }] });
});

async function gateway(emailVerified: unknown = true) {
  const gatewayConfig = config();
  const backend = new MemoryKeyValueBackend(() => NOW * 1000);
  const store = new EncryptedStore(backend, gatewayConfig.storageKey, () => NOW * 1000);
  const upstream = new FakeUpstream();
  upstream.assertion = await assertion(emailVerified);
  const verifier = new IdentityVerifier({
    issuer: 'https://issuer.example',
    audience: 'gateway-client',
    jwksUri: new URL('https://issuer.example/jwks'),
    emailDomain: gatewayConfig.usernameEmailDomain,
    usernameMode: gatewayConfig.usernameMode,
    allowedUsers: gatewayConfig.allowedUsers,
    now: () => NOW,
    getKey: localJwks
  });
  let sequence = 0;
  const oauth = new GatewayOAuth({
    config: gatewayConfig,
    store,
    identityVerifier: verifier,
    upstream,
    now: () => NOW,
    randomToken: () => `${String(++sequence).padStart(2, '0')}${'x'.repeat(41)}`
  });
  return { oauth, upstream, backend, store, verifier, gatewayConfig };
}

async function register(oauth: GatewayOAuth): Promise<string> {
  const response = await oauth.handle(new Request('https://mcp.example/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      redirect_uris: [REDIRECT_URI],
      grant_types: ['authorization_code'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none'
    })
  }));
  expect(response?.status).toBe(201);
  return String((await response!.json() as { client_id: string }).client_id);
}

async function issueDownstreamCode(
  oauth: GatewayOAuth,
  upstream: FakeUpstream,
  clientId: string,
  verifier: string,
  redirectUri = REDIRECT_URI
): Promise<string> {
  const authorizeUrl = new URL('https://mcp.example/authorize');
  authorizeUrl.search = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: 'openid email',
    state: 'client-state',
    code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    code_challenge_method: 'S256'
  }).toString();
  const authorize = await oauth.handle(new Request(authorizeUrl));
  expect(authorize?.status).toBe(303);
  const callback = new URL('https://mcp.example/auth/callback');
  callback.searchParams.set('state', upstream.lastAuthorization!.state);
  callback.searchParams.set('code', 'upstream-code');
  const callbackResponse = await oauth.handle(new Request(callback));
  expect(callbackResponse?.status).toBe(303);
  const clientCallback = new URL(callbackResponse!.headers.get('location')!);
  expect(clientCallback.origin + clientCallback.pathname).toBe(redirectUri);
  expect(clientCallback.searchParams.get('state')).toBe('client-state');
  return clientCallback.searchParams.get('code')!;
}

async function issueBearer(oauth: GatewayOAuth, upstream: FakeUpstream): Promise<string> {
  const clientId = await register(oauth);
  const verifier = 'v'.repeat(64);
  const code = await issueDownstreamCode(oauth, upstream, clientId, verifier);
  const response = await oauth.handle(new Request('https://mcp.example/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: clientId,
      code,
      redirect_uri: REDIRECT_URI,
      code_verifier: verifier
    })
  }));
  expect(response?.status).toBe(200);
  const token = await response!.json() as { access_token: string };
  return token.access_token;
}

describe('hosted OAuth authorization flow', () => {
  it('registers the real MCP SDK interactive defaults with only the supported grant', async () => {
    const { oauth, upstream } = await gateway();
    const fetchFn: typeof fetch = async (input, init) => {
      const response = await oauth.handle(new Request(input, init));
      if (response === null) throw new Error('unexpected OAuth route');
      return response;
    };
    const clientMetadata = resolveClientMetadata({
      redirectUrl: REDIRECT_URI,
      clientMetadata: {
        redirect_uris: [REDIRECT_URI],
        response_types: ['code'],
        token_endpoint_auth_method: 'none'
      }
    });
    expect(clientMetadata.grant_types).toEqual(['authorization_code', 'refresh_token']);
    const clientInformation = await registerClient('https://mcp.example', {
      clientMetadata,
      fetchFn
    });
    expect(clientInformation.grant_types).toEqual(['authorization_code']);
    const codeVerifier = 'v'.repeat(64);
    const authorizationCode = await issueDownstreamCode(
      oauth, upstream, clientInformation.client_id, codeVerifier
    );
    const token = await exchangeAuthorization('https://mcp.example', {
      clientInformation, authorizationCode, codeVerifier, redirectUri: REDIRECT_URI, fetchFn
    });
    expect(token).not.toHaveProperty('refresh_token');
    const verified = await oauth.verifyBearer(`Bearer ${token.access_token}`);
    expect(verified).not.toBeInstanceOf(Response);
    if (verified instanceof Response) throw new Error('bearer unexpectedly rejected');
    expect(verified.identity.assertion()).toBe(upstream.assertion);
    expect(verified.identity.username).toBe('alice-person');
    const refresh = await fetchFn('https://mcp.example/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token', client_id: clientInformation.client_id, refresh_token: 'synthetic'
      })
    });
    expect(refresh.status).toBe(400);
    expect(await refresh.json()).toMatchObject({ error: 'unsupported_grant_type' });
  });

  it.each([
    [], ['refresh_token'], ['client_credentials'], 'authorization_code', null,
    ['authorization_code', null], ['authorization_code', 1], ['authorization_code', '']
  ].map((grantTypes) => ({ grantTypes })))(
    'rejects unsupported-only or malformed registration grant metadata: $grantTypes',
    async ({ grantTypes }) => {
      const { oauth } = await gateway();
      const response = await oauth.handle(new Request('https://mcp.example/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          redirect_uris: [REDIRECT_URI], grant_types: grantTypes, token_endpoint_auth_method: 'none'
        })
      }));
      expect(response?.status).toBe(400);
      expect(await response?.json()).toMatchObject({ error: 'invalid_client_metadata' });
    }
  );

  it.each(['success', 'nonce_mismatch', 'unexpected_refresh_token', 'missing_id_token'])(
    'uses the real openid-client exchange: %s', async (mode) => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const gatewayConfig = config();
    const store = new EncryptedStore(
      new MemoryKeyValueBackend(),
      gatewayConfig.storageKey
    );
    let authorizationNonce = '';
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.href === gatewayConfig.oidcConfigUrl.href) {
        return Response.json({
          issuer: 'https://issuer.example',
          authorization_endpoint: 'https://issuer.example/authorize',
          token_endpoint: 'https://issuer.example/token',
          jwks_uri: 'https://issuer.example/jwks'
        });
      }
      if (url.pathname === '/jwks') {
        return Response.json({ keys: [publicJwk] });
      }
      if (url.pathname === '/token') {
        const headers = new Headers(init?.headers);
        expect(headers.get('authorization')).toMatch(/^Basic /u);
        const body = new URLSearchParams(String(init?.body));
        expect(body.get('grant_type')).toBe('authorization_code');
        expect(body.get('code_verifier')).toMatch(/^[A-Za-z0-9_-]{86}$/u);
        const now = Math.floor(Date.now() / 1000);
        const idToken = await new SignJWT({
          email: 'alice.person@example.invalid',
          email_verified: true,
          nonce: mode === 'nonce_mismatch' ? 'sensitive-wrong-nonce' : authorizationNonce
        })
          .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
          .setIssuer('https://issuer.example')
          .setAudience('gateway-client')
          .setSubject('alice-id')
          .setIssuedAt(now)
          .setExpirationTime(now + 120)
          .sign(privateKey);
        return Response.json({
          access_token: 'upstream-opaque',
          token_type: 'Bearer',
          expires_in: 120,
          ...(mode === 'missing_id_token' ? {} : { id_token: idToken }),
          ...(mode === 'unexpected_refresh_token' ? { refresh_token: 'sensitive-refresh-token' } : {})
        });
      }
      throw new Error(`unexpected upstream request ${url.href}`);
    };

    const oauth = await createGatewayOAuth(gatewayConfig, store, fetchImpl);
    const clientId = await register(oauth);
    const verifier = 'r'.repeat(64);
    const authorizeUrl = new URL('https://mcp.example/authorize');
    authorizeUrl.search = new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: REDIRECT_URI,
      scope: 'openid email',
      state: 'client-state',
      code_challenge: createHash('sha256').update(verifier).digest('base64url'),
      code_challenge_method: 'S256'
    }).toString();
    const authorize = await oauth.handle(new Request(authorizeUrl));
    expect(authorize?.status).toBe(303);
    const upstream = new URL(authorize!.headers.get('location')!);
    authorizationNonce = upstream.searchParams.get('nonce')!;
    expect(authorizationNonce).not.toBe('');
    expect(upstream.searchParams.get('code_challenge_method')).toBe('S256');

    const callback = new URL('https://mcp.example/auth/callback');
    callback.searchParams.set('state', upstream.searchParams.get('state')!);
    callback.searchParams.set('code', 'upstream-code');
    const completed = await oauth.handle(new Request(callback));
    expect(completed?.status).toBe(303);
    const clientCallback = new URL(completed!.headers.get('location')!);
    if (mode === 'success') {
      expect(clientCallback.searchParams.get('code')).not.toBeNull();
      expect(stderr).not.toHaveBeenCalled();
    } else {
      expect(clientCallback.searchParams.get('error')).toBe('server_error');
      expect(clientCallback.searchParams.has('code')).toBe(false);
      expect(stderr.mock.calls.map(([text]) => text)).toEqual([
        `oauth_callback_failed stage=upstream_exchange reason=${mode}\n`
      ]);
    }
    expect(clientCallback.searchParams.get('state')).toBe('client-state');
    await oauth.close();
  });

  it('does not follow a redirect from upstream OIDC discovery', async () => {
    const gatewayConfig = config();
    const store = new EncryptedStore(
      new MemoryKeyValueBackend(),
      gatewayConfig.storageKey
    );
    let plaintextRequests = 0;
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.protocol === 'http:') {
        plaintextRequests += 1;
        return Response.json({});
      }
      expect(init?.redirect).toBe('manual');
      return new Response(null, {
        status: 302,
        headers: { location: 'http://issuer.example/openid-configuration' }
      });
    };

    await expect(createGatewayOAuth(gatewayConfig, store, fetchImpl)).rejects.toThrow(
      'OIDC discovery failed'
    );
    expect(plaintextRequests).toBe(0);
  });

  it('publishes path-correct discovery metadata', async () => {
    const { oauth } = await gateway();
    const authorization = await oauth.handle(
      new Request('https://mcp.example/.well-known/oauth-authorization-server')
    );
    const metadata = await authorization?.json() as Record<string, unknown>;
    expect(metadata).toMatchObject({
      issuer: 'https://mcp.example',
      authorization_endpoint: 'https://mcp.example/authorize',
      token_endpoint: 'https://mcp.example/token',
      registration_endpoint: 'https://mcp.example/register',
      grant_types_supported: ['authorization_code'],
      code_challenge_methods_supported: ['S256']
    });
    expect(metadata['grant_types_supported']).not.toContain('refresh_token');
    expect(metadata['token_endpoint_auth_methods_supported']).not.toContain('private_key_jwt');
    expect(metadata).not.toHaveProperty('client_id_metadata_document_supported');
    const resource = await oauth.handle(
      new Request('https://mcp.example/.well-known/oauth-protected-resource/mcp')
    );
    expect(await resource?.json()).toMatchObject({
      resource: 'https://mcp.example/mcp',
      authorization_servers: ['https://mcp.example']
    });
    expect(await oauth.handle(new Request('https://mcp.example/healthcheck'))).toBeNull();
  });

  it('binds DCR, both PKCE legs, the exact assertion and bearer identity', async () => {
    const { oauth, upstream, backend } = await gateway();
    const clientId = await register(oauth);
    const verifier = 'v'.repeat(64);
    const code = await issueDownstreamCode(oauth, upstream, clientId, verifier);

    const tokenRequest = (): Request => new Request('https://mcp.example/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: clientId,
        code,
        redirect_uri: REDIRECT_URI,
        code_verifier: verifier
      })
    });
    const tokenResponse = await oauth.handle(tokenRequest());
    expect(tokenResponse?.status).toBe(200);
    const token = await tokenResponse!.json() as Record<string, unknown>;
    expect(token).toMatchObject({ token_type: 'Bearer', expires_in: 120, scope: 'openid email' });
    expect(token).not.toHaveProperty('refresh_token');

    const verified = await oauth.verifyBearer(`Bearer ${String(token['access_token'])}`);
    expect(verified).not.toBeInstanceOf(Response);
    if (verified instanceof Response) throw new Error('bearer unexpectedly rejected');
    expect(verified.identity.username).toBe('alice-person');
    expect(verified.identity.assertion()).toBe(upstream.assertion);
    expect(verified.authInfo.extra).toEqual({
      issuer: 'https://issuer.example',
      subject: 'alice-id',
      username: 'alice-person'
    });
    expect(JSON.stringify([...backend.values.values()])).not.toContain(upstream.assertion);

    const replay = await oauth.handle(tokenRequest());
    expect(replay?.status).toBe(400);
    expect(await replay?.json()).toMatchObject({ error: 'invalid_grant' });
  });

  it('retains a live bearer grant after a transient identity-verifier failure', async () => {
    const { oauth, upstream, verifier } = await gateway();
    const bearer = await issueBearer(oauth, upstream);
    const verification = vi.spyOn(verifier, 'verify').mockRejectedValueOnce(
      new Error('JWKS is temporarily unavailable')
    );

    const unavailable = await oauth.verifyBearer(`Bearer ${bearer}`);
    expect(unavailable).toBeInstanceOf(Response);
    if (!(unavailable instanceof Response)) throw new Error('bearer unexpectedly accepted');
    expect(unavailable.status).toBe(401);

    verification.mockRestore();
    const recovered = await oauth.verifyBearer(`Bearer ${bearer}`);
    expect(recovered).not.toBeInstanceOf(Response);
  });

  it('rejects redirect lookalikes during dynamic registration', async () => {
    const { oauth } = await gateway();
    const response = await oauth.handle(new Request('https://mcp.example/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        redirect_uris: ['https://client.example.evil.invalid/callback'],
        token_endpoint_auth_method: 'none'
      })
    }));
    expect(response?.status).toBe(400);
    expect(await response?.json()).toMatchObject({ error: 'invalid_redirect_uri' });
  });

  it('provides browser-safe CORS for DCR and token responses', async () => {
    const { oauth } = await gateway();
    for (const entry of [
      { route: 'register', headers: 'content-type' },
      { route: 'token', headers: 'authorization, content-type' }
    ]) {
      const response = await oauth.handle(new Request(`https://mcp.example/${entry.route}`, {
        method: 'OPTIONS',
        headers: {
          Origin: 'https://client.example',
          'Access-Control-Request-Method': 'POST',
          'Access-Control-Request-Headers': entry.headers
        }
      }));
      expect(response?.status).toBe(204);
      expect(response?.headers.get('access-control-allow-origin')).toBe('*');
      expect(response?.headers.get('access-control-allow-methods')).toContain('POST');
      for (const header of entry.headers.split(', ')) {
        expect(response?.headers.get('access-control-allow-headers')?.toLowerCase()).toContain(header);
      }
    }
  });

  it('rechecks persisted client redirects against the current operator policy', async () => {
    const { oauth, upstream, store, verifier, gatewayConfig } = await gateway();
    const clientId = await register(oauth);
    const restarted = new GatewayOAuth({
      config: { ...gatewayConfig, redirectUris: ['https://other.example/callback'] },
      store,
      identityVerifier: verifier,
      upstream,
      now: () => NOW
    });
    const authorize = new URL('https://mcp.example/authorize');
    authorize.search = new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: REDIRECT_URI,
      scope: 'openid email',
      code_challenge: 'c'.repeat(64),
      code_challenge_method: 'S256'
    }).toString();
    const response = await restarted.handle(new Request(authorize));
    expect(response?.status).toBe(400);
    expect(response?.headers.has('location')).toBe(false);
  });

  it.each([
    { grant_types: ['refresh_token'] },
    { response_types: ['token'] },
    { token_endpoint_auth_method: 'private_key_jwt' }
  ])('rejects unsupported dynamic registration metadata %#', async (metadata) => {
    const { oauth } = await gateway();
    const response = await oauth.handle(new Request('https://mcp.example/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ redirect_uris: [REDIRECT_URI], ...metadata })
    }));
    expect(response?.status).toBe(400);
  });

  it('never redirects an unknown client or unregistered redirect URI', async () => {
    const { oauth } = await gateway();
    const clientId = await register(oauth);
    for (const values of [
      { client_id: 'unknown', redirect_uri: REDIRECT_URI },
      { client_id: clientId, redirect_uri: 'https://evil.invalid/callback' }
    ]) {
      const url = new URL('https://mcp.example/authorize');
      url.search = new URLSearchParams({
        response_type: 'code',
        scope: 'openid email',
        code_challenge: 'c'.repeat(64),
        code_challenge_method: 'S256',
        ...values
      }).toString();
      const response = await oauth.handle(new Request(url));
      expect(response?.status).toBe(400);
      expect(response?.headers.has('location')).toBe(false);
    }
  });

  it('requires S256 and rejects unsupported grants before token lookup', async () => {
    const { oauth } = await gateway();
    const clientId = await register(oauth);
    const authorize = new URL('https://mcp.example/authorize');
    authorize.search = new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: REDIRECT_URI,
      scope: 'openid email',
      state: 'safe-state',
      code_challenge: 'plain-verifier',
      code_challenge_method: 'plain'
    }).toString();
    const authorizeResponse = await oauth.handle(new Request(authorize));
    expect(authorizeResponse?.status).toBe(303);
    const safeRedirect = new URL(authorizeResponse!.headers.get('location')!);
    expect(safeRedirect.origin + safeRedirect.pathname).toBe(REDIRECT_URI);
    expect(safeRedirect.searchParams.get('error')).toBe('invalid_request');

    const token = await oauth.handle(new Request('https://mcp.example/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: 'synthetic' })
    }));
    expect(await token?.json()).toMatchObject({ error: 'unsupported_grant_type' });
  });

  it('burns a one-time code after a wrong PKCE attempt', async () => {
    const { oauth, upstream } = await gateway();
    const clientId = await register(oauth);
    const verifier = 'v'.repeat(64);
    const code = await issueDownstreamCode(oauth, upstream, clientId, verifier);
    const exchange = async (codeVerifier: string): Promise<Response> => {
      const response = await oauth.handle(new Request('https://mcp.example/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          client_id: clientId,
          code,
          redirect_uri: REDIRECT_URI,
          code_verifier: codeVerifier
        })
      }));
      return response!;
    };
    expect(await (await exchange('w'.repeat(64))).json()).toMatchObject({ error: 'invalid_grant' });
    expect(await (await exchange(verifier)).json()).toMatchObject({ error: 'invalid_grant' });
  });

  it('supports confidential DCR clients without storing their plaintext secret', async () => {
    const { oauth, upstream, backend } = await gateway();
    const registration = await oauth.handle(new Request('https://mcp.example/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        redirect_uris: [REDIRECT_URI],
        token_endpoint_auth_method: 'client_secret_basic'
      })
    }));
    const client = await registration!.json() as { client_id: string; client_secret: string };
    expect(JSON.stringify([...backend.values.values()])).not.toContain(client.client_secret);
    const verifier = 'v'.repeat(64);
    const code = await issueDownstreamCode(oauth, upstream, client.client_id, verifier);
    const credentials = Buffer.from(`${client.client_id}:${client.client_secret}`).toString('base64');
    const token = await oauth.handle(new Request('https://mcp.example/token', {
      method: 'POST',
      headers: {
        Authorization: `Basic ${credentials}`,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: REDIRECT_URI,
        code_verifier: verifier
      })
    }));
    expect(token?.status).toBe(200);
  });

  it.each([
    [{ email_verified: false }, 'email_not_verified'],
    [{ email_verified: undefined }, 'email_verified_missing'],
    [{ email_verified: 'secret-claim\nforged-log' }, 'email_not_verified'],
    [{ email: 'sensitive.person@other.invalid' }, 'email_domain'],
    [{ email: 'sensitive.person@example.invalid' }, 'user_not_allowed']
  ] as const)('diagnoses a rejected identity without its sensitive claims: %s', async (changes, reason) => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const { oauth, upstream } = await gateway();
    upstream.assertion = await assertion(true, changes);
    const clientId = await register(oauth);
    const verifier = 'v'.repeat(64);
    const authorizeUrl = new URL('https://mcp.example/authorize');
    authorizeUrl.search = new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: REDIRECT_URI,
      scope: 'openid email',
      state: 'client-state',
      code_challenge: createHash('sha256').update(verifier).digest('base64url'),
      code_challenge_method: 'S256'
    }).toString();
    await oauth.handle(new Request(authorizeUrl));
    const callback = new URL('https://mcp.example/auth/callback');
    callback.searchParams.set('state', upstream.lastAuthorization!.state);
    callback.searchParams.set('code', 'upstream-code');
    const response = await oauth.handle(new Request(callback));
    const clientCallback = new URL(response!.headers.get('location')!);
    expect(clientCallback.searchParams.get('error')).toBe('server_error');
    expect(clientCallback.searchParams.has('code')).toBe(false);
    expect(stderr.mock.calls.map(([text]) => text)).toEqual([
      `oauth_callback_failed stage=identity_verification reason=${reason}\n`
    ]);
    expect(stdout).not.toHaveBeenCalled();
  });

  it.each([
    ['unknown', () => Object.assign(new Error('secret-error\nforged-log'), { code: 'OAUTH_TIMEOUT', reason: 'secret-reason' })],
    ['unknown', () => Object.assign(new oidc.ClientError('secret-error'), { code: 'secret-code\nforged-log' })],
    ['timeout', () => Object.assign(new oidc.ClientError('secret-error'), { code: 'OAUTH_TIMEOUT' })],
    ...['invalid_client', 'invalid_grant', 'invalid_request'].map((reason) => [reason, () => new oidc.ResponseBodyError('secret-error', {
      cause: { error: reason, error_description: 'secret-description' }, response: new Response(null, { status: 400 })
    })] as const),
    ['oauth_response_error', () => new oidc.ResponseBodyError('secret-error', {
      cause: { error: 'secret-error-code\nforged-log', error_description: 'secret-description' }, response: new Response(null, { status: 400 })
    })]
  ] as const)('emits only a fixed upstream reason: %s', async (reason, failure) => {
    const { oauth, upstream } = await gateway();
    vi.spyOn(upstream, 'exchange').mockRejectedValue(failure());
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const clientId = await register(oauth);
    const authorize = new URL('https://mcp.example/authorize');
    authorize.search = new URLSearchParams({
      response_type: 'code', client_id: clientId, redirect_uri: REDIRECT_URI,
      scope: 'openid email', code_challenge: createHash('sha256').update('v'.repeat(64)).digest('base64url'),
      code_challenge_method: 'S256'
    }).toString();
    await oauth.handle(new Request(authorize));
    const callback = new URL('https://mcp.example/auth/callback');
    callback.searchParams.set('state', upstream.lastAuthorization!.state);
    callback.searchParams.set('code', 'sensitive-authorization-code');
    const result = await oauth.handle(new Request(callback));
    const location = new URL(result!.headers.get('location')!);
    expect(location.searchParams.get('error')).toBe('server_error');
    expect(location.searchParams.has('code')).toBe(false);
    expect(stderr.mock.calls.map(([text]) => text)).toEqual([
      `oauth_callback_failed stage=upstream_exchange reason=${reason}\n`
    ]);
    expect(stdout).not.toHaveBeenCalled();
  });

  it('challenges invalid bearer tokens with protected-resource discovery', async () => {
    const { oauth } = await gateway();
    const response = await oauth.verifyBearer('Bearer invalid');
    expect(response).toBeInstanceOf(Response);
    if (!(response instanceof Response)) throw new Error('bearer unexpectedly accepted');
    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toContain(
      'https://mcp.example/.well-known/oauth-protected-resource/mcp'
    );
  });
});
