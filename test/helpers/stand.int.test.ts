/**
 * Proves the stand helper itself: start, talk to the server, stop.
 *
 * Assigned port: 8893. Never reuse another file's port.
 */

import { YNotebook } from '@jupyter/ydoc';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { ResolvedServer } from '../../src/core/index.js';
import { RtcConnection } from '../../src/jupyter/rtc-connection.js';
import { ServerClient } from '../../src/jupyter/server-client.js';
import { apiFetch } from './fetch.js';
import { REPO_ROOT, startStand, type Stand } from './stand.js';

const PORT = 8893;
const PARALLEL_PORT = 8895;

let stand: Stand | undefined;

function live(): Stand {
  if (stand === undefined) throw new Error('stand was not started');
  return stand;
}

beforeAll(async () => {
  stand = await startStand({ port: PORT });
}, 120_000);

afterAll(async () => {
  await stand?.stop();
}, 120_000);

describe('startStand', () => {
  it('reports a usable base URL, ws URL, token and root', () => {
    const s = live();
    expect(s.baseUrl).toBe(`http://127.0.0.1:${PORT}`);
    expect(s.wsUrl).toBe(`ws://127.0.0.1:${PORT}`);
    expect(s.token).toBe('devtoken');
    expect(s.root).toMatch(/dev\/jupyter\/\.runtime\/8893\/root$/);
  });

  it('serves an authenticated GET /api/status', async () => {
    const response = await apiFetch(live(), '/api/status');
    expect(response.status).toBe(200);
    // jupyter_server's APIStatusHandler answers
    // {started, last_activity, connections, kernels}.
    const status = response.json<{ started: string; kernels: number }>();
    expect(typeof status.started).toBe('string');
    expect(Number.isFinite(status.kernels)).toBe(true);
  });

  it('has the collaboration endpoints mounted', async () => {
    // Only PUT is defined on the session route, so a 405 is the healthy
    // answer; a 404 would mean jupyter_server_ydoc is not loaded at all.
    const response = await apiFetch(live(), '/api/collaboration/session/nope.ipynb');
    expect(response.status).not.toBe(404);
  });

  it('isolates RTC persistence between simultaneous stands', async () => {
    const second = await startStand({ port: PARALLEL_PORT });
    const firstStore = resolve(
      REPO_ROOT,
      'dev',
      'jupyter',
      '.runtime',
      String(PORT),
      '.jupyter_ystore.db'
    );
    const secondStore = resolve(
      REPO_ROOT,
      'dev',
      'jupyter',
      '.runtime',
      String(PARALLEL_PORT),
      '.jupyter_ystore.db'
    );
    const before = (filename: string): Buffer | null =>
      existsSync(filename) ? readFileSync(filename) : null;
    const firstBefore = before(firstStore);
    const secondBefore = before(secondStore);
    const replicas: Array<{ notebook: YNotebook; connection: RtcConnection }> = [];

    const openRoom = async (target: Stand, id: string): Promise<void> => {
      const resolved: ResolvedServer = {
        profile: {
          id,
          kind: 'standalone',
          apiBaseUrl: target.baseUrl,
          credentialRef: `literal:${target.token}`
        },
        apiBaseUrl: target.baseUrl,
        wsBaseUrl: target.wsUrl,
        token: target.token
      };
      const client = new ServerClient(resolved);
      const created = await client.newUntitledNotebook('');
      const collaboration = await client.collaborationSession(created.path);
      const notebook = new YNotebook();
      const connection = new RtcConnection({
        wsBaseUrl: target.wsUrl,
        token: target.token,
        fileId: collaboration.fileId,
        sessionId: collaboration.sessionId,
        ydoc: notebook.ydoc,
        awareness: notebook.awareness,
        awarenessUser: { name: `${id}-test`, color: '#2e7d32' }
      });
      replicas.push({ notebook, connection });
      await connection.connect(30_000);
      expect(connection.state).toBe('ready');
    };

    try {
      await Promise.all([openRoom(live(), 'first'), openRoom(second, 'second')]);
      expect(existsSync(firstStore)).toBe(true);
      expect(existsSync(secondStore)).toBe(true);
      expect(readFileSync(firstStore).equals(firstBefore ?? Buffer.alloc(0))).toBe(false);
      expect(readFileSync(secondStore).equals(secondBefore ?? Buffer.alloc(0))).toBe(false);
    } finally {
      for (const replica of replicas) {
        replica.connection.dispose();
        replica.notebook.dispose();
      }
      await second.stop();
    }
  }, 120_000);
});
