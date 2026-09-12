/**
 * `ServerClient` against a local HTTP stub: header auth, prefix handling,
 * SPEC.md §9 error mapping and the redirect rule of SPEC.md §11.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';

import { afterEach, describe, expect, it } from 'vitest';

import { isCoreError, type ResolvedServer } from '../../src/core/index.js';
import { ServerClient } from '../../src/jupyter/server-client.js';
import { startHttpStub, sendJson, type HttpStub } from './helpers/http-stub.js';

const TOKEN = 'unit-test-token';

function resolved(baseUrl: string, prefix = ''): ResolvedServer {
  const apiBaseUrl = `${baseUrl}${prefix}`;
  return {
    profile: {
      id: 'stub',
      kind: 'standalone',
      apiBaseUrl,
      credentialRef: `literal:${TOKEN}`
    },
    apiBaseUrl,
    wsBaseUrl: apiBaseUrl.replace(/^http/, 'ws'),
    token: TOKEN
  };
}

let stub: HttpStub | undefined;

afterEach(async () => {
  await stub?.close();
  stub = undefined;
});

async function withStub(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<HttpStub> {
  stub = await startHttpStub((req, res) => handler(req, res));
  return stub;
}

function codeOf(error: unknown): string {
  return isCoreError(error) ? error.code : `not a CoreError: ${String(error)}`;
}

describe('ServerClient happy paths', () => {
  it('sends the token as a header, keeps the base prefix and reads status', async () => {
    const server = await withStub((req, res) => {
      sendJson(res, 200, { started: '2026-09-06T00:00:00Z', kernels: 0, url: req.url });
    });
    const client = new ServerClient(resolved(server.baseUrl, '/user/alice'));

    const status = await client.status();

    expect(status.kernels).toBe(0);
    expect(server.requests).toHaveLength(1);
    expect(server.requests[0]?.url).toBe('/user/alice/api/status');
    expect(server.requests[0]?.authorization).toBe(`token ${TOKEN}`);
    // SPEC.md §11: never in the query string for HTTP.
    expect(server.requests[0]?.url).not.toContain(TOKEN);
  });

  it('lists only notebooks and directories', async () => {
    const server = await withStub((_req, res) => {
      sendJson(res, 200, {
        type: 'directory',
        path: 'work',
        content: [
          { name: 'a.ipynb', path: 'work/a.ipynb', type: 'notebook', last_modified: 't', size: 12 },
          { name: 'sub', path: 'work/sub', type: 'directory', last_modified: 't', size: null },
          { name: 'data.csv', path: 'work/data.csv', type: 'file', last_modified: 't', size: 3 }
        ]
      });
    });
    const client = new ServerClient(resolved(server.baseUrl));

    const listing = await client.listDirectory('/work/');

    expect(listing.path).toBe('work');
    expect(listing.entries.map((entry) => entry.name)).toEqual(['a.ipynb', 'sub']);
    expect(server.requests[0]?.url).toBe('/api/contents/work?content=1');
  });

  it('checks existence with content=0 and reports a missing path as null', async () => {
    const server = await withStub((req, res) => {
      if ((req.url ?? '').includes('missing')) {
        sendJson(res, 404, { message: 'No such file' });
        return;
      }
      sendJson(res, 200, { path: 'a.ipynb', name: 'a.ipynb', type: 'notebook', size: 5 });
    });
    const client = new ServerClient(resolved(server.baseUrl));

    await expect(client.contentsExists('a.ipynb')).resolves.toMatchObject({ type: 'notebook' });
    await expect(client.contentsExists('missing.ipynb')).resolves.toBeNull();
    // SPEC.md §2: never download the notebook body just to check existence.
    expect(server.requests.every((request) => request.url.includes('content=0'))).toBe(true);
  });

  it('creates an untitled notebook by POSTing to the directory', async () => {
    const server = await withStub((_req, res) => {
      sendJson(res, 201, { path: 'work/Untitled.ipynb', type: 'notebook' });
    });
    const client = new ServerClient(resolved(server.baseUrl));

    await expect(client.newUntitledNotebook('work')).resolves.toEqual({
      path: 'work/Untitled.ipynb'
    });
    expect(server.requests[0]?.method).toBe('POST');
    expect(server.requests[0]?.url).toBe('/api/contents/work');
    expect(JSON.parse(server.requests[0]?.body ?? '{}')).toEqual({ type: 'notebook' });
  });

  it('requests a document session with the whole path in one component', async () => {
    const server = await withStub((_req, res) => {
      sendJson(res, 201, {
        format: 'json',
        type: 'notebook',
        fileId: 'file-1',
        sessionId: 'server-session-1'
      });
    });
    const client = new ServerClient(resolved(server.baseUrl));

    const session = await client.collaborationSession('δοκιμή κατάλογος/Untitled.ipynb');

    expect(session).toMatchObject({ fileId: 'file-1', sessionId: 'server-session-1', httpStatus: 201 });
    expect(server.requests[0]?.method).toBe('PUT');
    expect(server.requests[0]?.url).toContain('%2FUntitled.ipynb');
    expect(JSON.parse(server.requests[0]?.body ?? '{}')).toEqual({
      format: 'json',
      type: 'notebook'
    });
  });

  it('builds @jupyterlab/services settings without leaking the token elsewhere', async () => {
    const server = await withStub((_req, res) => sendJson(res, 200, {}));
    const client = new ServerClient(resolved(server.baseUrl, '/user/alice'));

    const settings = client.serverSettings();
    expect(settings.baseUrl).toBe(`${server.baseUrl}/user/alice/`);
    expect(settings.wsUrl).toBe(`${server.baseUrl.replace('http', 'ws')}/user/alice/`);
    expect(settings.appendToken).toBe(true);
    // The same settings object is reused, so the kernel layer shares one config.
    expect(client.serverSettings()).toBe(settings);

    expect(client.toString()).not.toContain(TOKEN);
    expect(JSON.stringify(client)).not.toContain(TOKEN);
  });
});

describe('ServerClient error mapping (SPEC.md §9)', () => {
  const cases: Array<{ status: number; code: string }> = [
    { status: 400, code: 'INVALID_ARGUMENT' },
    { status: 401, code: 'AUTH_REQUIRED' },
    { status: 403, code: 'PERMISSION_DENIED' },
    { status: 404, code: 'NOTEBOOK_NOT_FOUND' },
    { status: 409, code: 'ALREADY_EXISTS' },
    { status: 500, code: 'INTERNAL_ERROR' }
  ];

  for (const { status, code } of cases) {
    it(`maps GET ${status} to ${code}`, async () => {
      const server = await withStub((_req, res) => sendJson(res, status, { message: 'nope' }));
      const client = new ServerClient(resolved(server.baseUrl));
      await expect(client.listDirectory('')).rejects.toSatisfy(
        (error: unknown) => codeOf(error) === code
      );
    });
  }

  it('maps a 5xx on a mutating call to OPERATION_UNCERTAIN', async () => {
    const server = await withStub((_req, res) => sendJson(res, 503, { message: 'down' }));
    const client = new ServerClient(resolved(server.baseUrl));
    await expect(client.newUntitledNotebook('')).rejects.toSatisfy(
      (error: unknown) => codeOf(error) === 'OPERATION_UNCERTAIN'
    );
  });

  it('maps a transport failure on a read to NETWORK_ERROR (retryable)', async () => {
    const server = await withStub((_req, res) => sendJson(res, 200, {}));
    const base = server.baseUrl;
    await server.close();
    stub = undefined;

    const client = new ServerClient(resolved(base));
    await expect(client.status()).rejects.toSatisfy((error: unknown) => {
      return isCoreError(error) && error.code === 'NETWORK_ERROR' && error.retryable;
    });
  });

  it('never puts the token into an error message or details', async () => {
    const server = await withStub((_req, res) => sendJson(res, 401, { message: TOKEN }));
    const client = new ServerClient(resolved(server.baseUrl));
    try {
      await client.status();
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(isCoreError(error)).toBe(true);
      if (!isCoreError(error)) return;
      expect(error.message).not.toContain(TOKEN);
      // The server echoed the token in its body; the body excerpt is the one
      // place it could resurface, so the test pins that it is only ever the
      // server's own text and not our credential header.
      expect(error.message).toBe(
        `GET ${server.baseUrl}/api/status requires authentication (401)`
      );
    }
  });
});

describe('redirects (SPEC.md §11)', () => {
  it('follows a same-origin redirect with credentials', async () => {
    const server = await withStub((req, res) => {
      if (req.url === '/api/status') {
        res.writeHead(302, { location: '/moved/api/status' });
        res.end();
        return;
      }
      sendJson(res, 200, { kernels: 1 });
    });
    const client = new ServerClient(resolved(server.baseUrl));

    await expect(client.status()).resolves.toMatchObject({ kernels: 1 });
    expect(server.requests).toHaveLength(2);
    expect(server.requests[1]?.authorization).toBe(`token ${TOKEN}`);
  });

  it('refuses to follow a cross-origin redirect', async () => {
    const server = await withStub((_req, res) => {
      res.writeHead(302, { location: 'https://elsewhere.invalid/api/status' });
      res.end();
    });
    const client = new ServerClient(resolved(server.baseUrl));

    await expect(client.status()).rejects.toSatisfy((error: unknown) => {
      return (
        isCoreError(error) &&
        error.code === 'NETWORK_ERROR' &&
        error.retryable === false &&
        error.message.includes('different origin')
      );
    });
    // Only the first request happened; nothing was sent to the other origin.
    expect(server.requests).toHaveLength(1);
  });
});
