import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { ServerConnection } from '@jupyterlab/services';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket, { WebSocketServer } from 'ws';

import { KernelClient } from '../../src/kernel/kernel-client.js';
import { KernelHub } from '../../src/service/kernel-hub.js';
import { captureUnhandledRejections } from './review-fakes.js';

interface KernelStub {
  readonly http: Server;
  readonly sockets: WebSocketServer;
  readonly settings: ServerConnection.ISettings;
  readonly requests: string[];
}

const stubs: KernelStub[] = [];

afterEach(async () => {
  for (const stub of stubs.splice(0).reverse()) {
    for (const socket of stub.sockets.clients) socket.terminate();
    await new Promise<void>((resolve) => stub.sockets.close(() => resolve()));
    stub.http.closeAllConnections();
    await new Promise<void>((resolve) => stub.http.close(() => resolve()));
  }
});

async function kernelStub(): Promise<KernelStub> {
  const requests: string[] = [];
  const http = createServer((request, response) => {
    requests.push(`${request.method ?? ''} ${request.url ?? ''}`);
    const pathname = new URL(request.url ?? '/', 'http://localhost').pathname;
    if (request.method === 'POST' && pathname === '/api/kernels/kernel-1/restart') {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ id: 'kernel-1', name: 'python3' }));
      return;
    }
    response.writeHead(404, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ message: 'not found' }));
  });
  const sockets = new WebSocketServer({ server: http });
  http.listen(0, '127.0.0.1');
  await once(http, 'listening');
  const baseUrl = `http://127.0.0.1:${(http.address() as AddressInfo).port}/`;
  const settings = ServerConnection.makeSettings({
    baseUrl,
    wsUrl: baseUrl.replace(/^http/u, 'ws'),
    token: '',
    appendToken: false,
    WebSocket: WebSocket as unknown as typeof globalThis.WebSocket,
    fetch: fetch as unknown as ServerConnection.ISettings['fetch']
  });
  const stub = { http, sockets, settings, requests };
  stubs.push(stub);
  return stub;
}

async function waitForKernelInfo(stub: KernelStub): Promise<void> {
  const [socket] = (await once(stub.sockets, 'connection')) as [WebSocket];
  await once(socket, 'message');
}

describe('KernelClient lifecycle', () => {
  it('restarts through REST without rejecting an unanswered automatic kernel-info request', async () => {
    const stub = await kernelStub();
    const connected = waitForKernelInfo(stub);
    const client = new KernelClient({ serverSettings: stub.settings, kernelId: 'kernel-1' });
    const changes: string[] = [];
    client.onKernelChanged((event) => changes.push(event.reason));

    try {
      await connected;
      const unhandled = await captureUnhandledRejections(async () => {
        await client.restart();
      });

      expect(unhandled).toEqual([]);
      expect(changes).toContain('restarting');
      expect(
        stub.requests.some((request) =>
          request.startsWith('POST /api/kernels/kernel-1/restart')
        )
      ).toBe(true);
    } finally {
      client.dispose();
    }
  });
});

describe('KernelHub invalidation', () => {
  it('keeps a replacement entry when stale leases are released', async () => {
    const stub = await kernelStub();
    const hub = new KernelHub();
    const first = hub.acquire('server-1', stub.settings, 'kernel-1');
    const second = hub.acquire('server-1', stub.settings, 'kernel-1');

    expect(second.client).toBe(first.client);
    expect(hub.invalidate('server-1', 'kernel-1')).toBe(true);
    expect(hub.size).toBe(0);

    const replacement = hub.acquire('server-1', stub.settings, 'kernel-1');
    expect(replacement.client).not.toBe(first.client);
    expect(hub.size).toBe(1);

    first.release();
    second.release();

    expect(hub.size).toBe(1);
    expect(hub.peek('server-1', 'kernel-1')?.client).toBe(replacement.client);
    expect(replacement.client.isDisposed).toBe(false);

    replacement.release();
    expect(hub.size).toBe(0);
  });
});
