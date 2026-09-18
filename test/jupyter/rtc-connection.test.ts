/**
 * `RtcConnection` state machine against the fake room server.
 *
 * These are the close-code fixtures SPEC.md §13 step 1 asks for, plus the
 * "one RAW handler per provider after several reconnects" requirement of
 * SPEC.md §12 ("RAW and eviction").
 */
import { afterEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';

import { isCoreError, type ConnectionState, type CoreError } from '../../src/core/index.js';
import { MESSAGE_RAW } from '../../src/jupyter/raw-protocol.js';
import {
  RtcConnection,
  reconnectDelayMs,
  type RtcConnectionOptions
} from '../../src/jupyter/rtc-connection.js';
import { connect as connectMcp, metaError, type Harness } from '../mcp/harness.js';
import { FakeRtcServer } from './helpers/fake-rtc-server.js';

const FILE_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const SESSION_ID = 'server-session-1';
const TOKEN = 'unit-token';

const cleanups: Array<() => void | Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
  cleanups.length = 0;
});

async function startServer(options?: { saveStatus?: 'success' | 'skipped' | 'failed' }) {
  const server = await FakeRtcServer.start(options ?? {});
  cleanups.push(() => server.close());
  return server;
}

function makeConnection(
  server: FakeRtcServer,
  overrides: Partial<RtcConnectionOptions> = {}
): { connection: RtcConnection; ydoc: Y.Doc; states: ConnectionState[] } {
  const ydoc = overrides.ydoc ?? new Y.Doc();
  const connection = new RtcConnection({
    wsBaseUrl: server.baseUrl,
    token: TOKEN,
    fileId: FILE_ID,
    sessionId: SESSION_ID,
    awarenessUser: { name: 'assistant', color: '#123456' },
    // Keep the reconnect backoff short; y-websocket starts at 200ms.
    maxBackoffTime: 50,
    saveTimeoutMs: 1_000,
    ...overrides,
    ydoc
  });
  const states: ConnectionState[] = [];
  connection.on('state', (state) => states.push(state));
  cleanups.push(() => {
    connection.dispose();
    if (overrides.ydoc === undefined) ydoc.destroy();
  });
  return { connection, ydoc, states };
}

function waitForState(connection: RtcConnection, target: ConnectionState, timeoutMs = 5_000) {
  if (connection.state === target) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      off();
      reject(new Error(`timeout waiting for state ${target}; now ${connection.state}`));
    }, timeoutMs);
    const off = connection.on('state', (state) => {
      if (state !== target) return;
      clearTimeout(timer);
      off();
      resolve();
    });
  });
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

function expectTerminal(error: unknown, code: string): CoreError {
  expect(isCoreError(error)).toBe(true);
  if (!isCoreError(error)) throw new Error('not a CoreError');
  expect(error.code).toBe(code);
  return error;
}

describe('RtcConnection: opening a room', () => {
  it('connects with an unencoded room name, the sessionId query and header auth', async () => {
    const server = await startServer();
    const { connection, states } = makeConnection(server);

    await connection.connect(5_000);

    expect(connection.state).toBe('ready');
    expect(states).toEqual(['syncing', 'ready']);
    expect(server.seenRooms[0]).toBe(`json:notebook:${FILE_ID}`);
    expect(server.seenRooms[0]).not.toContain('%3A');
    expect(server.seenQueries[0]).toContain(`sessionId=${SESSION_ID}`);
    // SPEC.md §11: the default transport keeps the credential out of the URL
    // entirely - it travels in the handshake header instead.
    expect(server.seenAuthorizations[0]).toBe(`token ${TOKEN}`);
    expect(server.seenQueries[0]).not.toContain(TOKEN);
    expect(connection.url).not.toContain(TOKEN);
    expect(JSON.stringify(connection.provider.params)).not.toContain(TOKEN);
  });

  it('can fall back to the browser-style ?token= query (opt-in)', async () => {
    const server = await startServer();
    const { connection } = makeConnection(server, { tokenTransport: 'query' });

    await connection.connect(5_000);

    expect(server.seenQueries[0]).toContain(`token=${TOKEN}`);
    expect(server.seenAuthorizations[0]).toBeNull();
    // Even then our own accessor redacts it (SPEC.md §11).
    expect(connection.url).not.toContain(TOKEN);
    expect(connection.url).toContain('token=<redacted>');
  });

  it('publishes {user, autosave: true} in awareness (SPEC.md §6)', async () => {
    const server = await startServer();
    const { connection } = makeConnection(server);
    await connection.connect(5_000);

    expect(connection.provider.awareness.getLocalState()).toEqual({
      user: { name: 'assistant', color: '#123456' },
      autosave: true
    });
  });

  it('syncs two independent connections through the server', async () => {
    const server = await startServer();
    const a = makeConnection(server);
    const b = makeConnection(server);

    await a.connection.connect(5_000);
    await b.connection.connect(5_000);

    a.ydoc.getMap('cells').set('x', 42);

    await expect
      .poll(() => b.ydoc.getMap('cells').get('x'), { timeout: 5_000 })
      .toBe(42);
    // disableBc is mandatory: without it the two docs would sync in-process and
    // this assertion would pass without the server (spike/NOTES.md §3.14).
    expect(server.accepted).toHaveLength(2);
  });
});

describe('RtcConnection: RAW save', () => {
  it('returns the server status verbatim', async () => {
    const server = await startServer();
    const { connection } = makeConnection(server);
    await connection.connect(5_000);

    await expect(connection.save(2_000)).resolves.toBe('success');
    server.setSaveStatus('skipped');
    await expect(connection.save(2_000)).resolves.toBe('skipped');
    server.setSaveStatus('failed');
    await expect(connection.save(2_000)).resolves.toBe('failed');

    // Ids are matched, not positional: three distinct requests were sent.
    expect(server.saveRequests).toEqual([1, 2, 3]);
  });

  it('reports timeout without claiming failure', async () => {
    const server = await startServer();
    const { connection } = makeConnection(server);
    await connection.connect(5_000);
    server.setReplyToSave(false);

    await expect(connection.save(150)).resolves.toBe('timeout');
    // A late reply for a timed-out request must not crash the handler.
    server.setReplyToSave(true);
    await expect(connection.save(2_000)).resolves.toBe('success');
  });

  it('refuses to send while the room is not ready', async () => {
    const server = await startServer();
    const { connection } = makeConnection(server);

    await expect(connection.save(500)).rejects.toSatisfy(
      (error: unknown) => isCoreError(error) && error.code === 'NOT_READY'
    );
  });
});

describe('RtcConnection: RAW conflict (SPEC.md §6)', () => {
  it('emits conflict, fails with RTC_CONFLICT and stops sending', async () => {
    const server = await startServer();
    const { connection } = makeConnection(server);
    await connection.connect(5_000);

    const conflicts: unknown[] = [];
    connection.on('conflict', (payload) => conflicts.push(payload));

    server.sendConflict();
    await waitForState(connection, 'failed');

    expect(conflicts).toEqual([{ type: 'conflict' }]);
    expectTerminal(connection.terminalError, 'RTC_CONFLICT');
    expect(connection.provider.shouldConnect).toBe(false);
    await expect.poll(() => server.openSockets, { timeout: 3_000 }).toBe(0);

    // Every further write path fails with the stored terminal error.
    await expect(connection.save(500)).rejects.toSatisfy(
      (error: unknown) => isCoreError(error) && error.code === 'RTC_CONFLICT'
    );
    // And no reconnect is attempted.
    await sleep(400);
    expect(server.seenRooms).toHaveLength(1);
  });
});

describe('RtcConnection: close-code fixtures (SPEC.md §6 table)', () => {
  const terminalCases: Array<{ name: string; code: number; reason: string; expected: string }> = [
    {
      name: '1003 unknown_session',
      code: 1003,
      reason: JSON.stringify({ reason: 'unknown_session', sessionId: 'other', reloadable: true }),
      expected: 'RTC_SESSION_REJECTED'
    },
    {
      name: '1003 version_mismatch',
      code: 1003,
      reason: JSON.stringify({ reason: 'version_mismatch', sessionId: 'other', reloadable: true }),
      expected: 'RTC_SESSION_REJECTED'
    },
    {
      name: '1003 initialization_error',
      code: 1003,
      reason: JSON.stringify({ reason: 'initialization_error', reloadable: false }),
      expected: 'RTC_INITIALIZATION_FAILED'
    },
    {
      name: '1003 with an unparsable reason',
      code: 1003,
      reason: 'server session mismatch',
      expected: 'RTC_INITIALIZATION_FAILED'
    },
    { name: '4400', code: 4400, reason: '', expected: 'RTC_BAD_REQUEST' },
    { name: '4404', code: 4404, reason: '', expected: 'NOTEBOOK_NOT_FOUND' }
  ];

  for (const testCase of terminalCases) {
    it(`${testCase.name} -> failed / ${testCase.expected}, no reconnect`, async () => {
      const server = await startServer();
      // Enough planned closes that a reconnect loop would be visible.
      server.planClose({ code: testCase.code, reason: testCase.reason, times: 5 });
      const { connection } = makeConnection(server);

      await expect(connection.connect(5_000)).rejects.toSatisfy(
        (error: unknown) => isCoreError(error) && error.code === testCase.expected
      );

      expect(connection.state).toBe('failed');
      expectTerminal(connection.terminalError, testCase.expected);
      expect(connection.provider.shouldConnect).toBe(false);

      // y-websocket only stops on 4400-4499 by itself; 1003 would otherwise
      // reconnect forever with the stale sessionId (spike/NOTES.md §3.8).
      await sleep(400);
      expect(server.seenRooms).toHaveLength(1);
    });
  }

  it('retries 4500 within the budget and then becomes ready', async () => {
    const server = await startServer();
    server.planClose({ code: 4500, reason: '', times: 2 });
    const { connection } = makeConnection(server, { initRetryBudget: 3 });

    await connection.connect(10_000);

    expect(connection.state).toBe('ready');
    expect(server.seenRooms).toHaveLength(3);
  });

  it('fails with RTC_INITIALIZATION_FAILED once the 4500 budget is spent', async () => {
    const server = await startServer();
    server.planClose({ code: 4500, reason: '', times: 10 });
    const { connection } = makeConnection(server, { initRetryBudget: 2 });

    await expect(connection.connect(10_000)).rejects.toSatisfy(
      (error: unknown) => isCoreError(error) && error.code === 'RTC_INITIALIZATION_FAILED'
    );
    expect(connection.provider.shouldConnect).toBe(false);
    // budget 2 => attempts 1..3 are made, the third close is terminal.
    expect(server.seenRooms).toHaveLength(3);
  });

  it.each([
    {
      name: 'token-authenticated',
      credential: 'token-close-reason-secret',
      options: { token: 'token-close-reason-secret' }
    },
    {
      name: 'assertion-header-authenticated',
      credential: 'assertion-close-reason-secret',
      options: {
        token: '',
        authHeaders: { 'X-Jupyter-Access-Token': 'assertion-close-reason-secret' }
      }
    }
  ])(
    'does not expose a credential from a $name RTC failure through MCP',
    async ({ credential, options }) => {
      const server = await startServer();
      server.planClose({ code: 1003, reason: JSON.stringify({ reason: credential }) });
      const { connection } = makeConnection(server, options);
      let terminal: unknown;
      try {
        await connection.connect(5_000);
        expect.fail('expected RTC rejection');
      } catch (error) {
        terminal = error;
      }
      expectTerminal(terminal, 'RTC_INITIALIZATION_FAILED');
      if ('authHeaders' in options) {
        expect(server.seenHeaders[0]?.['x-jupyter-access-token']).toBe(credential);
        expect(server.seenAuthorizations[0]).toBeNull();
      } else {
        expect(server.seenAuthorizations[0]).toBe(`token ${credential}`);
      }

      let mcp: Harness | undefined;
      try {
        mcp = await connectMcp({
          fake: { failWith: { method: 'notebookOpen', error: terminal } }
        });
        const answer = await mcp.call('notebook_open', {
          path: 'work/analysis.ipynb'
        });
        expect(answer.isError).toBe(true);
        expect(metaError(answer)).toMatchObject({ code: 'RTC_INITIALIZATION_FAILED' });
        expect(JSON.stringify(answer)).not.toContain(credential);
      } finally {
        await mcp?.close();
      }
    }
  );
});

describe('RtcConnection: reconnect (SPEC.md §6, §12)', () => {
  it('keeps the same Y.Doc, one RAW handler and a working save', async () => {
    const server = await startServer();
    const { connection, ydoc } = makeConnection(server);
    await connection.connect(5_000);

    ydoc.getMap('cells').set('before', 1);
    const handlerBefore = connection.provider.messageHandlers[MESSAGE_RAW];
    const clientIdBefore = ydoc.clientID;

    // 1006: the socket dies without a close frame.
    server.dropAll();
    await waitForState(connection, 'reconnecting');
    await waitForState(connection, 'ready', 10_000);

    expect(connection.socketGeneration).toBe(2);
    expect(connection.rawHandlerInstalls).toBe(1);
    expect(connection.provider.messageHandlers[MESSAGE_RAW]).toBe(handlerBefore);
    expect(ydoc.clientID).toBe(clientIdBefore);
    expect(ydoc.getMap('cells').get('before')).toBe(1);

    // The reply still reaches the (single) handler on the new socket.
    await expect(connection.save(2_000)).resolves.toBe('success');

    // And the replica keeps converging after the reconnect.
    ydoc.getMap('cells').set('after', 2);
    await expect
      .poll(() => server.room(`json:notebook:${FILE_ID}`)?.getMap('cells').get('after'), {
        timeout: 5_000
      })
      .toBe(2);
  });

  it('rejects a pending save with OPERATION_UNCERTAIN when the room fails', async () => {
    const server = await startServer();
    const { connection } = makeConnection(server);
    await connection.connect(5_000);
    server.setReplyToSave(false);

    const pending = connection.save(5_000);
    await sleep(50);
    server.sendConflict();

    await expect(pending).rejects.toSatisfy(
      (error: unknown) => isCoreError(error) && error.code === 'OPERATION_UNCERTAIN'
    );
  });
});

describe('RtcConnection: dispose', () => {
  it('closes the socket, stops reconnecting and rejects further calls', async () => {
    const server = await startServer();
    const { connection } = makeConnection(server);
    await connection.connect(5_000);

    connection.dispose();
    connection.dispose(); // idempotent

    expect(connection.state).toBe('closed');
    await expect.poll(() => server.openSockets, { timeout: 3_000 }).toBe(0);
    await expect(connection.connect(500)).rejects.toSatisfy(
      (error: unknown) => isCoreError(error) && error.code === 'HANDLE_EXPIRED'
    );
    await expect(connection.save(500)).rejects.toSatisfy(
      (error: unknown) => isCoreError(error) && error.code === 'HANDLE_EXPIRED'
    );
    await sleep(300);
    expect(server.seenRooms).toHaveLength(1);
  });
});

describe('RtcConnection: reconnect backoff (SPEC.md §6: "backoff with jitter")', () => {
  it('doubles, stays under the ceiling and never returns a fixed delay', () => {
    // Deterministic half plus a jittered half: `random` is the only source of
    // variation, so the bounds can be asserted exactly.
    expect(reconnectDelayMs(1, 2_500, () => 0)).toBe(100);
    expect(reconnectDelayMs(1, 2_500, () => 0.999)).toBeCloseTo(200, 0);
    expect(reconnectDelayMs(2, 2_500, () => 0)).toBe(200);
    expect(reconnectDelayMs(3, 2_500, () => 0)).toBe(400);
    // Capped by the ceiling, jitter included.
    expect(reconnectDelayMs(10, 2_500, () => 0)).toBe(1_250);
    expect(reconnectDelayMs(10, 2_500, () => 1)).toBe(2_500);

    // y-websocket's own delay is `min(2^n * 100, max)` with no jitter; two
    // replicas that lose the same server must not retry at the same moment.
    const draws = new Set([0.1, 0.4, 0.9].map((r) => reconnectDelayMs(4, 2_500, () => r)));
    expect(draws.size).toBe(3);
    for (const delay of draws) {
      expect(delay).toBeGreaterThanOrEqual(800);
      expect(delay).toBeLessThanOrEqual(1_600);
    }
  });

  it('a pending save resolves timeout as soon as its socket dies', async () => {
    const server = await startServer();
    const { connection } = makeConnection(server, { saveTimeoutMs: 30_000 });
    await connection.connect(5_000);
    server.setReplyToSave(false);

    const pending = connection.save(30_000);
    await sleep(50);
    const started = Date.now();
    server.dropAll();

    // The reply can only arrive on the socket that carried the request, so
    // waiting out the 30 s budget would add delay and no information. SPEC.md
    // §6: a timeout still does not mean the file was not written.
    await expect(pending).resolves.toBe('timeout');
    expect(Date.now() - started).toBeLessThan(2_000);
  }, 20_000);
});

describe('RtcConnection: fileId revalidation on reconnect (SPEC.md §6 signal table)', () => {
  it('reconnects when the document session still reports the same fileId', async () => {
    const server = await startServer();
    const calls: number[] = [];
    const { connection } = makeConnection(server, {
      revalidateFileId: () => {
        calls.push(Date.now());
        return Promise.resolve(FILE_ID);
      }
    });
    await connection.connect(5_000);
    expect(calls).toHaveLength(0);

    server.dropAll();
    await waitForState(connection, 'reconnecting');
    await waitForState(connection, 'ready', 10_000);
    expect(calls.length).toBeGreaterThanOrEqual(1);
    expect(connection.terminalError).toBeNull();
  }, 20_000);

  it('fails with FILE_ID_CHANGED and does not reopen the room', async () => {
    const server = await startServer();
    const { connection } = makeConnection(server, {
      revalidateFileId: () => Promise.resolve('a-different-file-id')
    });
    await connection.connect(5_000);

    server.dropAll();
    await waitForState(connection, 'failed');

    expectTerminal(connection.terminalError, 'FILE_ID_CHANGED');
    expect(connection.synced).toBe(false);
    await sleep(400);
    // No second room was opened with the stale identity.
    expect(server.seenRooms).toHaveLength(1);
    await expect(connection.save(500)).rejects.toSatisfy(
      (error: unknown) => isCoreError(error) && error.code === 'FILE_ID_CHANGED'
    );
  }, 20_000);

  it('treats a failing check as one more attempt and keeps retrying', async () => {
    const server = await startServer();
    let attempts = 0;
    const { connection } = makeConnection(server, {
      revalidateFileId: () => {
        attempts += 1;
        if (attempts < 3) return Promise.reject(new Error('server not back yet'));
        return Promise.resolve(FILE_ID);
      }
    });
    await connection.connect(5_000);

    server.dropAll();
    await waitForState(connection, 'reconnecting');
    await waitForState(connection, 'ready', 10_000);

    expect(attempts).toBeGreaterThanOrEqual(3);
    expect(connection.state).toBe('ready');
    expect(connection.terminalError).toBeNull();
  }, 20_000);
});
