/** Transport credential-redaction and injected-policy coverage. */
import { afterEach, describe, expect, it } from 'vitest';

import { isCoreError, type ResolvedServer } from '../../src/core/index.js';
import { httpRequest } from '../../src/jupyter/http.js';
import { ServerClient } from '../../src/jupyter/server-client.js';
import { startHttpStub, sendJson, type HttpStub } from '../jupyter/helpers/http-stub.js';

const TOKEN = 'SUPERSECRET-TOKEN-9f3a';

let stub: HttpStub | undefined;

afterEach(async () => {
  await stub?.close();
  stub = undefined;
});

function resolved(baseUrl: string): ResolvedServer {
  return {
    profile: { id: 'stub', kind: 'standalone', apiBaseUrl: baseUrl, credentialRef: `literal:${TOKEN}` },
    apiBaseUrl: baseUrl,
    wsBaseUrl: baseUrl.replace(/^http/, 'ws'),
    token: TOKEN
  };
}

/** Serialise a CoreError exactly as the MCP adapter would (SPEC.md §9). */
function wire(error: unknown): string {
  if (!isCoreError(error)) return `not a CoreError: ${String(error)}`;
  return JSON.stringify(error.toJSON());
}

describe('parseJsonBody credential redaction', () => {
  it('SPEC.md §11: credentials must not reach exception messages', async () => {
    // A 200 with a non-JSON body is the one path that reaches `parseJsonBody`
    // instead of `mapHttpStatus`. A proxy or a Jupyter login page in front of
    // the server answers exactly like this, and such pages carry `?token=` in
    // their `next=` links.
    stub = await startHttpStub((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(
        `<html><body>login required ` +
          `<a href="/login?next=%2Fapi%2Fstatus&token=${TOKEN}">continue</a></body></html>`
      );
    });
    const client = new ServerClient(resolved(stub.baseUrl));

    const error = await client.status().then(
      () => new Error('should have thrown'),
      (reason: unknown) => reason
    );

    expect(isCoreError(error) && error.code).toBe('INTERNAL_ERROR');
    expect(wire(error)).not.toContain(TOKEN);
  });

  it('redacts a response body behind an error status', async () => {
    stub = await startHttpStub((_req, res) => {
      res.writeHead(500, { 'content-type': 'text/html' });
      res.end(`<html>oops <a href="/x?token=${TOKEN}">t</a></html>`);
    });
    const client = new ServerClient(resolved(stub.baseUrl));

    const error = await client.status().then(
      () => new Error('should have thrown'),
      (reason: unknown) => reason
    );
    expect(wire(error)).not.toContain(TOKEN);
    expect(wire(error)).toContain('token=<redacted>');
  });
});

describe('serverSettings injected fetch implementation', () => {
  it('uses the transport policy configured for REST', async () => {
    stub = await startHttpStub((_req, res) => sendJson(res, 200, {}));
    const calls: string[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      calls.push(String(input));
      return fetch(input as Parameters<typeof fetch>[0], init);
    };
    const client = new ServerClient(resolved(stub.baseUrl), { fetchImpl });

    await client.status();
    expect(calls).toHaveLength(1);

    await client.serverSettings().fetch(`${stub.baseUrl}/api/status`);
    expect(calls).toHaveLength(2);
  });
});

describe('SPEC.md §11: credentials survive neither a redirect nor an error path', () => {
  it('a token already present in a URL is redacted in every error field', async () => {
    stub = await startHttpStub((_req, res) => sendJson(res, 500, { message: 'boom' }));
    const url = `${stub.baseUrl}/api/status?token=${TOKEN}`;

    const error = await httpRequest(url, TOKEN, { method: 'GET' }).then(
      () => new Error('should have thrown'),
      (reason: unknown) => reason
    );
    expect(wire(error)).not.toContain(TOKEN);
  });

  it('a cross-origin redirect is refused before a second request is made', async () => {
    stub = await startHttpStub((_req, res) => {
      res.writeHead(302, { location: 'https://attacker.invalid/api/status' });
      res.end();
    });
    const client = new ServerClient(resolved(stub.baseUrl));

    await expect(client.status()).rejects.toSatisfy(
      (error: unknown) => isCoreError(error) && error.retryable === false
    );
    expect(stub.requests).toHaveLength(1);
    expect(stub.requests[0]?.authorization).toBe(`token ${TOKEN}`);
  });

  it('a protocol-relative redirect is treated as cross-origin', async () => {
    stub = await startHttpStub((_req, res) => {
      res.writeHead(302, { location: '//attacker.invalid/api/status' });
      res.end();
    });
    const client = new ServerClient(resolved(stub.baseUrl));

    await expect(client.status()).rejects.toSatisfy((error: unknown) =>
      isCoreError(error) && error.message.includes('different origin')
    );
    expect(stub.requests).toHaveLength(1);
  });
});

describe('SPEC.md §9: mutating calls never claim "nothing happened"', () => {
  it('a transport failure on POST is OPERATION_UNCERTAIN with side_effects unknown', async () => {
    stub = await startHttpStub((_req, res) => sendJson(res, 200, {}));
    const base = stub.baseUrl;
    await stub.close();
    stub = undefined;

    const client = new ServerClient(resolved(base));
    await expect(client.newUntitledNotebook('')).rejects.toSatisfy(
      (error: unknown) =>
        isCoreError(error) &&
        error.code === 'OPERATION_UNCERTAIN' &&
        error.sideEffects === 'unknown' &&
        error.retryable === false
    );
  });

  it('a truncated response body on a mutating call is not reported as success', async () => {
    stub = await startHttpStub((_req, res) => {
      res.writeHead(201, { 'content-type': 'application/json' });
      // A body the server never finished writing.
      res.end('{"path": "work/Untitl');
    });
    const client = new ServerClient(resolved(stub.baseUrl));

    await expect(client.newUntitledNotebook('work')).rejects.toSatisfy(
      (error: unknown) => isCoreError(error) && error.code === 'INTERNAL_ERROR'
    );
  });
});
