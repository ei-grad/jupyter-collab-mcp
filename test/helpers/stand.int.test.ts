/**
 * Proves the stand helper itself: start, talk to the server, stop.
 *
 * Assigned port: 8893. Never reuse another file's port.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { apiFetch } from './fetch.js';
import { startStand, type Stand } from './stand.js';

const PORT = 8893;

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
});
