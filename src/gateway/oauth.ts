import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual
} from 'node:crypto';

import type { AuthInfo } from '@modelcontextprotocol/server';
import * as oidc from 'openid-client';

import type { GatewayConfig } from './config.js';
import { isRedirectAllowed } from './config.js';
import { EncryptedStore } from './crypto-store.js';
import { AccessIdentity, IdentityVerifier, identityFailureReason } from './identity.js';

const OAUTH_SCOPES = ['openid', 'email'] as const;
const TRANSACTION_TTL_SECONDS = 600;
const CODE_TTL_SECONDS = 300;
const MAX_REQUEST_BYTES = 1024 * 1024;

class UpstreamGrantError extends Error {
  constructor(readonly reason: 'missing_id_token' | 'unexpected_refresh_token') {
    super('upstream token response is not a bounded ID-token grant');
  }
}

function upstreamFailureReason(error: unknown): string {
  if (error instanceof UpstreamGrantError) {
    switch (error.reason) {
      case 'missing_id_token': return 'missing_id_token';
      case 'unexpected_refresh_token': return 'unexpected_refresh_token';
    }
  }
  if (error instanceof oidc.ResponseBodyError) {
    switch (error.error) {
      case 'invalid_client': return 'invalid_client';
      case 'invalid_grant': return 'invalid_grant';
      case 'invalid_request': return 'invalid_request';
      default: return 'oauth_response_error';
    }
  }
  if (error instanceof oidc.AuthorizationResponseError) return 'authorization_response_error';
  if (error instanceof oidc.WWWAuthenticateChallengeError) return 'authentication_challenge';
  if (error instanceof oidc.ClientError) {
    switch (error.code) {
      case 'OAUTH_TIMEOUT': return 'timeout';
      case 'OAUTH_ABORT': return 'aborted';
      case 'OAUTH_RESPONSE_IS_NOT_CONFORM': return 'unexpected_http_status';
      case 'OAUTH_RESPONSE_IS_NOT_JSON': return 'unexpected_content_type';
      case 'OAUTH_PARSE_ERROR': return 'parse_error';
      case 'OAUTH_INVALID_RESPONSE': {
        // The SDK can reject an absent ID token before our grant check runs.
        const cause = error.cause instanceof Error ? error.cause.cause : undefined;
        const body = typeof cause === 'object' && cause !== null && 'body' in cause ? cause.body : undefined;
        if (typeof body === 'object' && body !== null && 'access_token' in body && !('id_token' in body)) {
          return 'missing_id_token';
        }
        return 'invalid_response';
      }
      case 'OAUTH_JWT_CLAIM_COMPARISON_FAILED': {
        // openid-client wraps oauth4webapi's error; inspect only its claim name,
        // never the expected value or the token claims carried alongside it.
        const cause = error.cause instanceof Error ? error.cause.cause : undefined;
        const claim = typeof cause === 'object' && cause !== null && 'claim' in cause
          ? cause.claim : undefined;
        switch (claim) {
          case 'nonce': return 'nonce_mismatch';
          case 'iss': return 'issuer_mismatch';
          case 'aud': return 'audience_mismatch';
          default: return 'jwt_claim_comparison';
        }
      }
      case 'OAUTH_JWT_TIMESTAMP_CHECK_FAILED': return 'jwt_timestamp';
      case 'OAUTH_JSON_ATTRIBUTE_COMPARISON_FAILED': return 'response_attribute_comparison';
    }
  }
  return 'unknown';
}

interface ClientRecord {
  readonly clientId: string;
  readonly redirectUris: readonly string[];
  readonly tokenEndpointAuthMethod: 'none' | 'client_secret_basic' | 'client_secret_post';
  readonly secretDigest?: string;
  readonly clientName?: string;
}

interface TransactionRecord {
  readonly clientId: string;
  readonly redirectUri: string;
  readonly downstreamState?: string;
  readonly downstreamCodeChallenge: string;
  readonly upstreamCodeVerifier: string;
  readonly upstreamNonce: string;
}

interface AuthorizationCodeRecord {
  readonly clientId: string;
  readonly redirectUri: string;
  readonly codeChallenge: string;
  readonly assertion: string;
}

interface AccessTokenRecord {
  readonly clientId: string;
  readonly assertion: string;
}

export interface UpstreamAuthorizationClient {
  authorizationUrl(input: {
    readonly redirectUri: string;
    readonly state: string;
    readonly nonce: string;
    readonly codeChallenge: string;
  }): URL;
  exchange(input: {
    readonly callbackUrl: URL;
    readonly redirectUri: string;
    readonly state: string;
    readonly nonce: string;
    readonly codeVerifier: string;
  }): Promise<string>;
  close?(): Promise<void>;
}

export interface VerifiedBearer {
  readonly authInfo: AuthInfo;
  readonly identity: AccessIdentity;
}

export interface GatewayOAuthOptions {
  readonly config: GatewayConfig;
  readonly store: EncryptedStore;
  readonly identityVerifier: IdentityVerifier;
  readonly upstream: UpstreamAuthorizationClient;
  readonly now?: () => number;
  readonly randomToken?: () => string;
}

interface OidcDiscovery {
  readonly issuer: string;
  readonly authorization_endpoint: string;
  readonly token_endpoint: string;
  readonly jwks_uri: string;
}

function randomToken(): string {
  return randomBytes(32).toString('base64url');
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.byteLength === b.byteLength && timingSafeEqual(a, b);
}

function jsonResponse(
  value: unknown,
  status = 200,
  extraHeaders: Headers | Record<string, string> = {}
): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      'Cache-Control': 'no-store',
      'Content-Type': 'application/json',
      ...Object.fromEntries(new Headers(extraHeaders))
    }
  });
}

function oauthError(error: string, description: string, status = 400): Response {
  return jsonResponse({ error, error_description: description }, status);
}

function withCors(response: Response, methods: string, headers: string): Response {
  response.headers.set('Access-Control-Allow-Origin', '*');
  response.headers.set('Access-Control-Allow-Methods', methods);
  response.headers.set('Access-Control-Allow-Headers', headers);
  return response;
}

function basePath(publicUrl: URL): string {
  return publicUrl.pathname === '/' ? '' : publicUrl.pathname.replace(/\/$/, '');
}

function endpoint(publicUrl: URL, suffix: string): URL {
  return new URL(`${basePath(publicUrl)}${suffix}`, publicUrl.origin);
}

function protectedResourceMetadataUrl(publicUrl: URL): URL {
  return new URL(
    `/.well-known/oauth-protected-resource${basePath(publicUrl)}/mcp`,
    publicUrl.origin
  );
}

function authorizationMetadataPaths(publicUrl: URL): ReadonlySet<string> {
  const suffix = basePath(publicUrl);
  return new Set([
    `/.well-known/oauth-authorization-server${suffix}`,
    `/.well-known/openid-configuration${suffix}`,
    '/.well-known/openid-configuration'
  ]);
}

function resourceUrl(publicUrl: URL): URL {
  return endpoint(publicUrl, '/mcp');
}

function digestOpaque(value: string, signingKey: string): string {
  return createHmac('sha256', signingKey).update(value).digest('base64url');
}

function pkceChallenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

function validPkceValue(value: string): boolean {
  return /^[A-Za-z0-9._~-]{43,128}$/.test(value);
}

async function requestBody(request: Request, form: boolean): Promise<Record<string, unknown>> {
  const contentLength = Number(request.headers.get('content-length') ?? '0');
  if (Number.isFinite(contentLength) && contentLength > MAX_REQUEST_BYTES) {
    throw new Error('request body is too large');
  }
  const text = await request.text();
  if (Buffer.byteLength(text) > MAX_REQUEST_BYTES) throw new Error('request body is too large');
  if (form) return Object.fromEntries(new URLSearchParams(text));
  const parsed: unknown = JSON.parse(text);
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('request body must be an object');
  }
  return parsed as Record<string, unknown>;
}

function hasContentType(request: Request, expected: string): boolean {
  return request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() === expected;
}

function asStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.some((entry) => typeof entry !== 'string')) {
    return null;
  }
  return value as string[];
}

function validClientRecord(value: ClientRecord | null): value is ClientRecord {
  return value !== null &&
    typeof value.clientId === 'string' &&
    Array.isArray(value.redirectUris) &&
    value.redirectUris.every((uri) => typeof uri === 'string') &&
    ['none', 'client_secret_basic', 'client_secret_post'].includes(value.tokenEndpointAuthMethod);
}

function clientRedirect(record: TransactionRecord, parameters: Record<string, string>): Response {
  const target = new URL(record.redirectUri);
  for (const [name, value] of Object.entries(parameters)) target.searchParams.set(name, value);
  if (record.downstreamState !== undefined) target.searchParams.set('state', record.downstreamState);
  return Response.redirect(target, 303);
}

class OpenIdClient implements UpstreamAuthorizationClient {
  readonly #configuration: oidc.Configuration;

  constructor(configuration: oidc.Configuration) {
    this.#configuration = configuration;
  }

  authorizationUrl(input: {
    readonly redirectUri: string;
    readonly state: string;
    readonly nonce: string;
    readonly codeChallenge: string;
  }): URL {
    return oidc.buildAuthorizationUrl(this.#configuration, {
      response_type: 'code',
      redirect_uri: input.redirectUri,
      scope: OAUTH_SCOPES.join(' '),
      state: input.state,
      nonce: input.nonce,
      code_challenge: input.codeChallenge,
      code_challenge_method: 'S256'
    });
  }

  async exchange(input: {
    readonly callbackUrl: URL;
    readonly redirectUri: string;
    readonly state: string;
    readonly nonce: string;
    readonly codeVerifier: string;
  }): Promise<string> {
    // The Node listener sees HTTP behind TLS termination. openid-client derives
    // the token request's redirect_uri from this URL, not additional parameters.
    const callbackUrl = new URL(input.redirectUri);
    callbackUrl.search = input.callbackUrl.search;
    const tokens = await oidc.authorizationCodeGrant(
      this.#configuration,
      callbackUrl,
      {
        expectedState: input.state,
        expectedNonce: input.nonce,
        pkceCodeVerifier: input.codeVerifier,
        idTokenExpected: true
      }
    );
    if (typeof tokens.id_token !== 'string' || tokens.id_token === '') throw new UpstreamGrantError('missing_id_token');
    if (tokens.refresh_token) throw new UpstreamGrantError('unexpected_refresh_token');
    return tokens.id_token;
  }
}

export class GatewayOAuth {
  readonly #config: GatewayConfig;
  readonly #store: EncryptedStore;
  readonly #identityVerifier: IdentityVerifier;
  readonly #upstream: UpstreamAuthorizationClient;
  readonly #now: () => number;
  readonly #randomToken: () => string;
  #closing: Promise<void> | undefined;

  constructor(options: GatewayOAuthOptions) {
    this.#config = options.config;
    this.#store = options.store;
    this.#identityVerifier = options.identityVerifier;
    this.#upstream = options.upstream;
    this.#now = options.now ?? (() => Date.now() / 1000);
    this.#randomToken = options.randomToken ?? randomToken;
  }

  async handle(request: Request): Promise<Response | null> {
    const url = new URL(request.url);
    const prefix = basePath(this.#config.publicUrl);
    if (authorizationMetadataPaths(this.#config.publicUrl).has(url.pathname)) {
      if (!['GET', 'OPTIONS'].includes(request.method)) return new Response(null, { status: 405 });
      if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: { 'Access-Control-Allow-Origin': '*' } });
      return jsonResponse(this.#authorizationMetadata(), 200, { 'Access-Control-Allow-Origin': '*' });
    }
    if (url.pathname === protectedResourceMetadataUrl(this.#config.publicUrl).pathname) {
      if (!['GET', 'OPTIONS'].includes(request.method)) return new Response(null, { status: 405 });
      if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: { 'Access-Control-Allow-Origin': '*' } });
      return jsonResponse(this.#protectedResourceMetadata(), 200, { 'Access-Control-Allow-Origin': '*' });
    }
    if (url.pathname === `${prefix}/register`) {
      return withCors(await this.#register(request), 'POST, OPTIONS', 'Content-Type');
    }
    if (url.pathname === `${prefix}/authorize`) return this.#authorize(request);
    if (url.pathname === `${prefix}/auth/callback`) return this.#callback(request);
    if (url.pathname === `${prefix}/token`) {
      return withCors(
        await this.#token(request),
        'POST, OPTIONS',
        'Authorization, Content-Type'
      );
    }
    return null;
  }

  async verifyBearer(authorizationHeader: string | null | undefined): Promise<VerifiedBearer | Response> {
    const match = authorizationHeader?.match(/^Bearer ([^\s]+)$/i);
    if (match == null) return this.#bearerFailure();
    const token = match[1]!;
    const record = await this.#store.get<AccessTokenRecord>(
      'access-tokens',
      digestOpaque(token, this.#config.signingKey)
    );
    if (record === null || typeof record.clientId !== 'string' || typeof record.assertion !== 'string') {
      return this.#bearerFailure();
    }
    let identity: AccessIdentity;
    try {
      identity = await this.#identityVerifier.verify(record.assertion);
    } catch {
      return this.#bearerFailure();
    }
    return {
      identity,
      authInfo: {
        token,
        clientId: record.clientId,
        scopes: [...identity.scopes],
        expiresAt: identity.expiresAt,
        resource: resourceUrl(this.#config.publicUrl),
        extra: {
          issuer: identity.issuer,
          subject: identity.subject,
          username: identity.username
        }
      }
    };
  }

  async close(): Promise<void> {
    if (this.#closing !== undefined) return this.#closing;
    this.#closing = this.#close().catch((error: unknown) => {
      this.#closing = undefined;
      throw error;
    });
    return this.#closing;
  }

  async #close(): Promise<void> {
    const failures: unknown[] = [];
    try {
      await this.#upstream.close?.();
    } catch (error) {
      failures.push(error);
    }
    try {
      await this.#store.close();
    } catch (error) {
      failures.push(error);
    }
    if (failures.length > 0) throw new AggregateError(failures, 'OAuth shutdown failed');
  }

  #authorizationMetadata(): Record<string, unknown> {
    return {
      issuer: this.#config.publicUrl.href.replace(/\/$/, ''),
      authorization_endpoint: endpoint(this.#config.publicUrl, '/authorize').href,
      token_endpoint: endpoint(this.#config.publicUrl, '/token').href,
      registration_endpoint: endpoint(this.#config.publicUrl, '/register').href,
      scopes_supported: [...OAUTH_SCOPES],
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code'],
      token_endpoint_auth_methods_supported: ['none', 'client_secret_basic', 'client_secret_post'],
      code_challenge_methods_supported: ['S256']
    };
  }

  #protectedResourceMetadata(): Record<string, unknown> {
    return {
      resource: resourceUrl(this.#config.publicUrl).href,
      authorization_servers: [this.#config.publicUrl.href.replace(/\/$/, '')],
      scopes_supported: [...OAUTH_SCOPES],
      bearer_methods_supported: ['header']
    };
  }

  #bearerFailure(): Response {
    return jsonResponse(
      { error: 'invalid_token', error_description: 'Bearer token is missing or invalid' },
      401,
      {
        'WWW-Authenticate': `Bearer resource_metadata="${protectedResourceMetadataUrl(this.#config.publicUrl).href}"`
      }
    );
  }

  async #register(request: Request): Promise<Response> {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: { 'Access-Control-Allow-Origin': '*' } });
    if (request.method !== 'POST') return new Response(null, { status: 405 });
    if (!hasContentType(request, 'application/json')) {
      return oauthError('invalid_request', 'registration requires application/json');
    }
    let input: Record<string, unknown>;
    try {
      input = await requestBody(request, false);
    } catch {
      return oauthError('invalid_client_metadata', 'invalid registration document');
    }
    const redirectUris = asStringArray(input['redirect_uris']);
    if (
      redirectUris === null ||
      redirectUris.some((uri) => !isRedirectAllowed(uri, this.#config.redirectUris))
    ) {
      return oauthError('invalid_redirect_uri', 'redirect URI is not permitted');
    }
    const grantTypes = asStringArray(
      input['grant_types'] === undefined ? ['authorization_code'] : input['grant_types']
    );
    const responseTypes = input['response_types'] ?? ['code'];
    if (
      grantTypes === null ||
      grantTypes.some((grant) => grant.length === 0) ||
      !grantTypes.includes('authorization_code') ||
      !Array.isArray(responseTypes) ||
      responseTypes.length !== 1 ||
      responseTypes[0] !== 'code'
    ) {
      return oauthError('invalid_client_metadata', 'only the authorization code grant is supported');
    }
    const authMethod = input['token_endpoint_auth_method'] ?? 'client_secret_post';
    if (!['none', 'client_secret_basic', 'client_secret_post'].includes(String(authMethod))) {
      return oauthError('invalid_client_metadata', 'unsupported token endpoint authentication method');
    }
    const clientId = this.#randomToken();
    const clientSecret = authMethod === 'none' ? undefined : this.#randomToken();
    const record: ClientRecord = {
      clientId,
      redirectUris: Object.freeze([...new Set(redirectUris)]),
      tokenEndpointAuthMethod: authMethod as ClientRecord['tokenEndpointAuthMethod'],
      ...(clientSecret === undefined
        ? {}
        : { secretDigest: digestOpaque(clientSecret, this.#config.signingKey) }),
      ...(typeof input['client_name'] === 'string' ? { clientName: input['client_name'] } : {})
    };
    await this.#store.put('clients', clientId, record);
    return jsonResponse({
      client_id: clientId,
      client_id_issued_at: Math.floor(this.#now()),
      redirect_uris: record.redirectUris,
      grant_types: ['authorization_code'],
      response_types: ['code'],
      token_endpoint_auth_method: record.tokenEndpointAuthMethod,
      ...(clientSecret === undefined
        ? {}
        : { client_secret: clientSecret, client_secret_expires_at: 0 }),
      ...(record.clientName === undefined ? {} : { client_name: record.clientName })
    }, 201, { 'Access-Control-Allow-Origin': '*' });
  }

  async #authorize(request: Request): Promise<Response> {
    if (!['GET', 'POST'].includes(request.method)) return new Response(null, { status: 405 });
    if (request.method === 'POST' && !hasContentType(request, 'application/x-www-form-urlencoded')) {
      return oauthError('invalid_request', 'authorization POST requires form encoding');
    }
    let parameters: Record<string, unknown>;
    try {
      parameters = request.method === 'GET'
        ? Object.fromEntries(new URL(request.url).searchParams)
        : await requestBody(request, true);
    } catch {
      return oauthError('invalid_request', 'invalid authorization request');
    }
    const clientId = parameters['client_id'];
    const redirectUri = parameters['redirect_uri'];
    const challenge = parameters['code_challenge'];
    if (typeof clientId !== 'string' || typeof redirectUri !== 'string') {
      return oauthError('invalid_request', 'client_id and redirect_uri are required');
    }
    const client = await this.#store.get<ClientRecord>('clients', clientId);
    if (
      !validClientRecord(client) ||
      !client.redirectUris.includes(redirectUri) ||
      !isRedirectAllowed(redirectUri, this.#config.redirectUris)
    ) {
      return oauthError('invalid_request', 'unknown client or redirect URI');
    }
    if (
      parameters['response_type'] !== 'code' ||
      parameters['code_challenge_method'] !== 'S256' ||
      typeof challenge !== 'string' ||
      !validPkceValue(challenge)
    ) {
      return clientRedirect(
        {
          clientId,
          redirectUri,
          downstreamCodeChallenge: '',
          upstreamCodeVerifier: '',
          upstreamNonce: '',
          ...(typeof parameters['state'] === 'string' ? { downstreamState: parameters['state'] } : {})
        },
        { error: 'invalid_request' }
      );
    }
    const scopes = typeof parameters['scope'] === 'string'
      ? parameters['scope'].split(/\s+/).filter(Boolean)
      : [];
    if (scopes.length !== OAUTH_SCOPES.length || OAUTH_SCOPES.some((scope) => !scopes.includes(scope))) {
      return clientRedirect(
        {
          clientId,
          redirectUri,
          downstreamCodeChallenge: challenge,
          upstreamCodeVerifier: '',
          upstreamNonce: '',
          ...(typeof parameters['state'] === 'string' ? { downstreamState: parameters['state'] } : {})
        },
        { error: 'invalid_scope' }
      );
    }
    const transactionId = this.#randomToken();
    const upstreamCodeVerifier = this.#randomToken() + this.#randomToken();
    const upstreamNonce = this.#randomToken();
    const record: TransactionRecord = {
      clientId,
      redirectUri,
      downstreamCodeChallenge: challenge,
      upstreamCodeVerifier,
      upstreamNonce,
      ...(typeof parameters['state'] === 'string' ? { downstreamState: parameters['state'] } : {})
    };
    await this.#store.put(
      'transactions',
      digestOpaque(transactionId, this.#config.signingKey),
      record,
      TRANSACTION_TTL_SECONDS
    );
    const upstream = this.#upstream.authorizationUrl({
      redirectUri: endpoint(this.#config.publicUrl, '/auth/callback').href,
      state: transactionId,
      nonce: upstreamNonce,
      codeChallenge: pkceChallenge(upstreamCodeVerifier)
    });
    return Response.redirect(upstream, 303);
  }

  async #callback(request: Request): Promise<Response> {
    if (request.method !== 'GET') return new Response(null, { status: 405 });
    const callbackUrl = new URL(request.url);
    const state = callbackUrl.searchParams.get('state');
    if (state === null) return oauthError('invalid_request', 'authorization state is missing');
    const record = await this.#store.take<TransactionRecord>(
      'transactions',
      digestOpaque(state, this.#config.signingKey)
    );
    if (record === null) return oauthError('invalid_request', 'authorization state is invalid');
    if (!isRedirectAllowed(record.redirectUri, this.#config.redirectUris)) {
      return oauthError('invalid_request', 'redirect URI is no longer permitted');
    }
    if (callbackUrl.searchParams.has('error')) {
      return clientRedirect(record, { error: 'access_denied' });
    }
    let assertion: string;
    try {
      assertion = await this.#upstream.exchange({
        callbackUrl,
        redirectUri: endpoint(this.#config.publicUrl, '/auth/callback').href,
        state,
        nonce: record.upstreamNonce,
        codeVerifier: record.upstreamCodeVerifier
      });
    } catch (error) {
      process.stderr.write(`oauth_callback_failed stage=upstream_exchange reason=${upstreamFailureReason(error)}\n`);
      return clientRedirect(record, { error: 'server_error' });
    }
    let identity: AccessIdentity;
    try {
      identity = await this.#identityVerifier.verify(assertion);
    } catch (error) {
      process.stderr.write(`oauth_callback_failed stage=identity_verification reason=${identityFailureReason(error)}\n`);
      return clientRedirect(record, { error: 'server_error' });
    }
    const remaining = identity.expiresAt - this.#now();
    if (remaining <= 0) return clientRedirect(record, { error: 'access_denied' });
    const code = this.#randomToken();
    await this.#store.put(
      'authorization-codes',
      digestOpaque(code, this.#config.signingKey),
      {
        clientId: record.clientId,
        redirectUri: record.redirectUri,
        codeChallenge: record.downstreamCodeChallenge,
        assertion: identity.assertion()
      } satisfies AuthorizationCodeRecord,
      Math.min(CODE_TTL_SECONDS, remaining)
    );
    return clientRedirect(record, { code });
  }

  async #token(request: Request): Promise<Response> {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: { 'Access-Control-Allow-Origin': '*' } });
    if (request.method !== 'POST') return new Response(null, { status: 405 });
    if (!hasContentType(request, 'application/x-www-form-urlencoded')) {
      return oauthError('invalid_request', 'token request requires form encoding');
    }
    let parameters: Record<string, unknown>;
    try {
      parameters = await requestBody(request, true);
    } catch {
      return oauthError('invalid_request', 'invalid token request');
    }
    if (parameters['grant_type'] !== 'authorization_code') {
      return oauthError('unsupported_grant_type', 'only authorization_code is supported');
    }
    const authenticated = await this.#authenticateClient(request, parameters);
    if (authenticated instanceof Response) return authenticated;
    const code = parameters['code'];
    const redirectUri = parameters['redirect_uri'];
    const verifier = parameters['code_verifier'];
    if (typeof code !== 'string' || typeof redirectUri !== 'string' || typeof verifier !== 'string') {
      return oauthError('invalid_grant', 'authorization code, redirect URI and PKCE verifier are required');
    }
    const record = await this.#store.take<AuthorizationCodeRecord>(
      'authorization-codes',
      digestOpaque(code, this.#config.signingKey)
    );
    if (
      record === null ||
      record.clientId !== authenticated.clientId ||
      record.redirectUri !== redirectUri ||
      !validPkceValue(verifier) ||
      !safeEqual(pkceChallenge(verifier), record.codeChallenge)
    ) {
      return oauthError('invalid_grant', 'authorization grant is invalid');
    }
    let identity: AccessIdentity;
    try {
      identity = await this.#identityVerifier.verify(record.assertion);
    } catch {
      return oauthError('invalid_grant', 'authorization grant is invalid');
    }
    const expiresIn = Math.floor(identity.expiresAt - this.#now());
    if (expiresIn < 1) return oauthError('invalid_grant', 'authorization grant is expired');
    const accessToken = this.#randomToken();
    await this.#store.put(
      'access-tokens',
      digestOpaque(accessToken, this.#config.signingKey),
      { clientId: authenticated.clientId, assertion: identity.assertion() } satisfies AccessTokenRecord,
      expiresIn
    );
    return jsonResponse({
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: expiresIn,
      scope: OAUTH_SCOPES.join(' ')
    }, 200, { 'Access-Control-Allow-Origin': '*' });
  }

  async #authenticateClient(
    request: Request,
    parameters: Record<string, unknown>
  ): Promise<ClientRecord | Response> {
    let clientId = typeof parameters['client_id'] === 'string' ? parameters['client_id'] : undefined;
    let clientSecret = typeof parameters['client_secret'] === 'string' ? parameters['client_secret'] : undefined;
    const authorization = request.headers.get('authorization');
    if (authorization !== null) {
      const match = authorization.match(/^Basic ([A-Za-z0-9+/=]+)$/);
      if (match === null) return oauthError('invalid_client', 'client authentication failed', 401);
      const decoded = Buffer.from(match[1]!, 'base64').toString('utf8');
      const separator = decoded.indexOf(':');
      if (separator < 0) return oauthError('invalid_client', 'client authentication failed', 401);
      try {
        clientId = decodeURIComponent(decoded.slice(0, separator));
        clientSecret = decodeURIComponent(decoded.slice(separator + 1));
      } catch {
        return oauthError('invalid_client', 'client authentication failed', 401);
      }
    }
    if (clientId === undefined) return oauthError('invalid_client', 'client authentication failed', 401);
    const client = await this.#store.get<ClientRecord>('clients', clientId);
    if (!validClientRecord(client)) return oauthError('invalid_client', 'client authentication failed', 401);
    if (client.tokenEndpointAuthMethod === 'none') {
      if (authorization !== null || clientSecret !== undefined) {
        return oauthError('invalid_client', 'client authentication failed', 401);
      }
      return client;
    }
    const expectedMethod = authorization === null ? 'client_secret_post' : 'client_secret_basic';
    if (
      client.tokenEndpointAuthMethod !== expectedMethod ||
      clientSecret === undefined ||
      client.secretDigest === undefined ||
      !safeEqual(digestOpaque(clientSecret, this.#config.signingKey), client.secretDigest)
    ) {
      return oauthError('invalid_client', 'client authentication failed', 401);
    }
    return client;
  }
}

export async function createGatewayOAuth(
  config: GatewayConfig,
  store: EncryptedStore,
  fetchImpl: typeof fetch = fetch
): Promise<GatewayOAuth> {
  const noRedirectFetch: typeof fetch = (input, init) =>
    fetchImpl(input, { ...init, redirect: 'manual' });
  const response = await noRedirectFetch(config.oidcConfigUrl, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(10_000)
  });
  if (!response.ok) throw new Error('OIDC discovery failed');
  const discovery = await response.json() as Partial<OidcDiscovery>;
  const endpoints = [
    discovery.issuer,
    discovery.authorization_endpoint,
    discovery.token_endpoint,
    discovery.jwks_uri
  ];
  if (endpoints.some((value) => typeof value !== 'string')) {
    throw new Error('OIDC discovery is missing required endpoints');
  }
  for (const value of endpoints as string[]) {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new Error('OIDC discovery returned an invalid endpoint');
    }
    if (
      url.protocol !== 'https:' ||
      url.hostname === '' ||
      url.username !== '' ||
      url.password !== '' ||
      url.hash !== ''
    ) {
      throw new Error('OIDC discovery requires HTTPS endpoints');
    }
  }
  const metadata = discovery as oidc.ServerMetadata;
  const configuration = new oidc.Configuration(
    metadata,
    config.oidcClientId,
    { client_secret: config.oidcClientSecret },
    oidc.ClientSecretBasic(config.oidcClientSecret)
  );
  configuration[oidc.customFetch] = async (url, options) => noRedirectFetch(url, {
    method: options.method,
    headers: options.headers,
    ...(options.body === undefined
      ? {}
      : { body: options.body as Exclude<RequestInit['body'], undefined> }),
    ...(options.signal === undefined ? {} : { signal: options.signal })
  });
  const identityVerifier = new IdentityVerifier({
    issuer: discovery.issuer!,
    audience: config.oidcClientId,
    jwksUri: new URL(discovery.jwks_uri!),
    emailDomain: config.usernameEmailDomain,
    usernameMode: config.usernameMode,
    allowedUsers: config.allowedUsers,
    fetchImpl: noRedirectFetch
  });
  return new GatewayOAuth({
    config,
    store,
    identityVerifier,
    upstream: new OpenIdClient(configuration)
  });
}
