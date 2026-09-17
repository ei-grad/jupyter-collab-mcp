import { describe, expect, it } from 'vitest';

import {
  isRedirectAllowed,
  loadGatewayConfig,
  validateAssertionHeader
} from '../../src/gateway/config.js';

function environment(changes: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    JUPYTER_MCP_PUBLIC_URL: 'https://mcp.example.invalid',
    JUPYTER_MCP_OIDC_CONFIG_URL: 'https://issuer.example/.well-known/openid-configuration',
    JUPYTER_MCP_OIDC_CLIENT_ID: 'gateway-client',
    JUPYTER_MCP_OIDC_CLIENT_SECRET: 'synthetic-client-secret',
    JUPYTER_MCP_REDIS_URL: 'unix:///run/redis/redis.sock?db=1',
    JUPYTER_MCP_STORAGE_KEY: Buffer.alloc(32, 7).toString('base64url') + '=',
    JUPYTER_MCP_SIGNING_KEY: 's'.repeat(32),
    JUPYTER_MCP_REDIRECT_URIS: [
      'https://claude.ai/api/mcp/auth_callback',
      'https://chatgpt.com/connector/oauth/*',
      'http://localhost:*',
      'http://127.0.0.1:*'
    ].join(' '),
    JUPYTER_MCP_USERNAME_EMAIL_DOMAIN: 'example.invalid',
    JUPYTER_MCP_ALLOWED_USERS: 'alice-person bob',
    JUPYTER_MCP_API_BASE_URL: 'http://jupyter:8000/base',
    ...changes
  };
}

describe('gateway configuration', () => {
  it('loads the explicit operator boundary and source-runtime defaults', () => {
    const config = loadGatewayConfig(environment());
    expect(config.publicUrl.href).toBe('https://mcp.example.invalid/');
    expect(config.redisUrl.protocol).toBe('unix:');
    expect(config.storageKey).toHaveLength(32);
    expect(config.allowedUsers).toEqual(new Set(['alice-person', 'bob']));
    expect(config.browserBaseUrl.href).toBe(config.apiBaseUrl.href);
    expect(config.assertionHeader).toBe('X-Jupyter-Access-Token');
    expect(config.maxWorkers).toBe(16);
    expect(config.maxWorkersPerPrincipal).toBe(4);
    expect(config.requestTimeoutMs).toBe(120_000);
    expect(config.connectTimeoutMs).toBe(10_000);
    expect(config.expiryPollMs).toBe(5_000);
    expect(config.nodeCommand).toMatch(/\/node_modules\/\.bin\/tsx$/);
    expect(config.upstreamCli).toMatch(/\/src\/mcp\/cli\.ts$/);
    expect(config.runtimeDir).toBe('/run/mcp');
  });

  it.each([
    ['JUPYTER_MCP_PUBLIC_URL', 'http://mcp.example.invalid'],
    ['JUPYTER_MCP_PUBLIC_URL', 'https://user:password@mcp.example.invalid'],
    ['JUPYTER_MCP_OIDC_CONFIG_URL', 'https://issuer.example/config?tenant=other'],
    ['JUPYTER_MCP_REDIS_URL', 'redis://remote.example.invalid'],
    ['JUPYTER_MCP_REDIS_URL', 'unix:///run/redis/redis.sock?db=not-a-number'],
    ['JUPYTER_MCP_API_BASE_URL', 'http://user:password@jupyter.invalid'],
    ['JUPYTER_MCP_ALLOWED_USERS', '../alice'],
    ['JUPYTER_MCP_USERNAME_EMAIL_DOMAIN', 'Example.Invalid'],
    ['JUPYTER_MCP_STORAGE_KEY', 'not-a-fernet-key'],
    ['JUPYTER_MCP_SIGNING_KEY', 'short'],
    ['JUPYTER_MCP_MAX_WORKERS', '0'],
    ['JUPYTER_MCP_MAX_WORKERS_PER_PRINCIPAL', '1.5'],
    ['JUPYTER_MCP_REQUEST_TIMEOUT', 'NaN']
  ])('rejects unsafe %s configuration', (name, value) => {
    expect(() => loadGatewayConfig(environment({ [name]: value }))).toThrow();
  });

  it.each([
    'Authorization',
    'Proxy-Authorization',
    'Cookie',
    'Host',
    'Connection',
    'Upgrade',
    'Content-Type',
    'Transfer-Encoding',
    'Sec-WebSocket-Protocol',
    'x\r\ny'
  ])('rejects assertion header %s', (name) => {
    expect(() => validateAssertionHeader(name)).toThrow('invalid assertion header');
  });

  it('accepts a legal non-routing assertion header', () => {
    expect(validateAssertionHeader('X_Jupyter.Access+Token')).toBe('X_Jupyter.Access+Token');
  });
});

describe('redirect policy', () => {
  const patterns = loadGatewayConfig(environment()).redirectUris;

  it.each([
    'https://claude.ai/api/mcp/auth_callback',
    'https://chatgpt.com/connector/oauth/callback',
    'http://localhost:49152/callback',
    'http://127.0.0.1:54321/auth/callback'
  ])('allows a bounded callback %s', (uri) => {
    expect(isRedirectAllowed(uri, patterns)).toBe(true);
  });

  it.each([
    'https://claude.ai/api/mcp/auth_callback/other',
    'https://chatgpt.com.evil.invalid/connector/oauth/callback',
    'https://chatgpt.com/connector/other',
    'https://chatgpt.com/connector/oauth/../../steal',
    'https://chatgpt.com/connector/oauth/%2e%2e/%2e%2e/steal',
    'https://chatgpt.com/connector/oauth/callback?next=https://evil.invalid',
    'http://localhost.evil.invalid:49152/callback',
    'http://localhost:49152@evil.invalid/callback'
  ])('rejects a redirect escape %s', (uri) => {
    expect(isRedirectAllowed(uri, patterns)).toBe(false);
  });

  it.each([
    '*',
    'https://*.example.invalid/*',
    'https://example.invalid/*',
    'http://remote.invalid:*',
    'https://example.invalid/'
  ])('rejects an overbroad configured pattern %s', (pattern) => {
    expect(() => loadGatewayConfig(environment({ JUPYTER_MCP_REDIRECT_URIS: pattern }))).toThrow();
  });
});
