import { afterEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';

import { isCoreError, type ConnectionState } from '../../src/core/index.js';
import { MESSAGE_RAW } from '../../src/jupyter/raw-protocol.js';
import { RtcConnection, type RtcConnectionOptions } from '../../src/jupyter/rtc-connection.js';
import { FakeRtcServer } from '../jupyter/helpers/fake-rtc-server.js';

const FILE_ID = 'review-file-id';
const ROOM = `json:notebook:${FILE_ID}`;
const SESSION_ID = 'review-session';
const TOKEN = 'review-token';

const cleanups: Array<() => void | Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
  cleanups.length = 0;
});

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

async function startServer(): Promise<FakeRtcServer> {
  const server = await FakeRtcServer.start({});
  cleanups.push(() => server.close());
  return server;
}

function makeConnection(
  server: FakeRtcServer,
  overrides: Partial<RtcConnectionOptions> = {}
): { connection: RtcConnection; ydoc: Y.Doc } {
  const ydoc = overrides.ydoc ?? new Y.Doc();
  const connection = new RtcConnection({
    wsBaseUrl: server.baseUrl,
    token: TOKEN,
    fileId: FILE_ID,
    sessionId: SESSION_ID,
    awarenessUser: { name: 'reviewer', color: '#ff0000' },
    maxBackoffTime: 50,
    saveTimeoutMs: 1_000,
    ...overrides,
    ydoc
  });
  cleanups.push(() => {
    connection.dispose();
    if (overrides.ydoc === undefined) ydoc.destroy();
  });
  return { connection, ydoc };
}

function waitForState(
  connection: RtcConnection,
  target: ConnectionState,
  timeoutMs = 8_000
): Promise<void> {
  if (connection.state === target) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      off();
      reject(new Error(`timeout waiting for ${target}; now ${connection.state}`));
    }, timeoutMs);
    const off = connection.on('state', (state) => {
      if (state !== target) return;
      clearTimeout(timer);
      off();
      resolve();
    });
  });
}

describe('SPEC.md §6: state notifications report current synchronization', () => {
  it('SPEC.md §6: "Reconnecting ... does not leave the previous synced flag true"', async () => {
    const server = await startServer();
    const { connection } = makeConnection(server);

    const samples: Array<{ state: ConnectionState; synced: boolean }> = [];
    connection.on('state', (state) => samples.push({ state, synced: connection.synced }));

    await connection.connect(5_000);
    server.dropAll();
    await waitForState(connection, 'reconnecting');
    await waitForState(connection, 'ready');

    // y-websocket emits 'connection-close' BEFORE it clears `provider.synced`
    // (node_modules/y-websocket/src/y-websocket.js, closeWebsocketConnection).
    // RtcConnection.synced delegates straight to that flag, so a subscriber
    // that recomputes readiness inside the state callback - the natural place -
    // reads a stale `true` for the whole notification.
    const notReady = samples.filter((sample) => sample.state !== 'ready');
    expect(notReady.map((sample) => `${sample.state}:${String(sample.synced)}`)).toEqual(
      notReady.map((sample) => `${sample.state}:false`)
    );
  });
});

describe('SPEC.md §12 "RAW and eviction" / "Network and restart": repeated reconnects', () => {
  it('keeps one RAW handler, one doc observer and working saves over three reconnects', async () => {
    const server = await startServer();
    const { connection, ydoc } = makeConnection(server);
    await connection.connect(5_000);

    const handler = connection.provider.messageHandlers[MESSAGE_RAW];
    const clientId = ydoc.clientID;

    for (let round = 1; round <= 3; round += 1) {
      server.dropAll();
      await waitForState(connection, 'reconnecting');
      await waitForState(connection, 'ready', 10_000);

      expect(connection.rawHandlerInstalls, `round ${round}`).toBe(1);
      expect(connection.provider.messageHandlers[MESSAGE_RAW], `round ${round}`).toBe(handler);
      expect(connection.socketGeneration, `round ${round}`).toBe(round + 1);
      expect(ydoc.clientID, `round ${round}`).toBe(clientId);
      await expect(connection.save(2_000), `round ${round}`).resolves.toBe('success');
    }
  }, 30_000);

  it('delivers an edit made while the socket was down (SPEC.md §6: updates kept in memory)', async () => {
    const server = await startServer();
    const { connection, ydoc } = makeConnection(server);
    await connection.connect(5_000);

    server.dropAll();
    await waitForState(connection, 'reconnecting');
    // The write happens with no socket at all: y-websocket drops the frame and
    // only the post-reconnect sync can carry it.
    ydoc.getMap('cells').set('written-offline', 'yes');
    expect(connection.state).toBe('reconnecting');

    await waitForState(connection, 'ready', 10_000);
    await expect
      .poll(() => server.room(ROOM)?.getMap('cells').get('written-offline'), { timeout: 5_000 })
      .toBe('yes');
  }, 30_000);
});

describe('SPEC.md §6: a terminal signal must stop this replica from talking to the room', () => {
  it('RAW conflict stops outgoing updates synchronously', async () => {
    const server = await startServer();
    const { connection, ydoc } = makeConnection(server);
    await connection.connect(5_000);

    const states: ConnectionState[] = [];
    connection.on('state', (state) => states.push(state));

    server.sendConflict();
    await waitForState(connection, 'failed');

    // "stop sending updates immediately": the socket must already be gone
    // when the state event fires, not on the next timer tick.
    expect(connection.provider.ws).toBeNull();
    ydoc.getMap('cells').set('after-conflict', 'must-not-arrive');
    await sleep(400);
    expect(server.room(ROOM)?.getMap('cells').get('after-conflict')).toBeUndefined();
    expect(server.seenRooms).toHaveLength(1);

    expect(states).toEqual(['conflict', 'failed']);
    expect(connection.state).toBe('failed');
    expect(connection.terminalError?.code).toBe('RTC_CONFLICT');
  }, 20_000);

  it('a mid-session 1003 rejects the replica and never resyncs it', async () => {
    const server = await startServer();
    const { connection, ydoc } = makeConnection(server);
    await connection.connect(5_000);
    ydoc.getMap('cells').set('before', 1);
    await expect.poll(() => server.room(ROOM)?.getMap('cells').get('before')).toBe(1);

    // The room accepted us and only then decided the server session is stale -
    // exactly the restart case of SPEC.md §6.
    server.accepted[0]?.close(
      1003,
      JSON.stringify({ reason: 'unknown_session', sessionId: 'other', reloadable: true })
    );
    await waitForState(connection, 'failed');
    expect(connection.terminalError?.code).toBe('RTC_SESSION_REJECTED');

    ydoc.getMap('cells').set('after-1003', 'must-not-arrive');
    await sleep(500);
    expect(server.room(ROOM)?.getMap('cells').get('after-1003')).toBeUndefined();
    // "disable auto-reconnect and do not synchronize this Y.Doc again"
    expect(server.seenRooms).toHaveLength(1);
    expect(connection.provider.shouldConnect).toBe(false);
  }, 20_000);

  it('a save in flight when a mid-session 1003 arrives is OPERATION_UNCERTAIN', async () => {
    const server = await startServer();
    const { connection } = makeConnection(server);
    await connection.connect(5_000);
    server.setReplyToSave(false);

    const pending = connection.save(5_000);
    await sleep(50);
    server.accepted[0]?.close(1003, JSON.stringify({ reason: 'version_mismatch' }));

    await expect(pending).rejects.toSatisfy(
      (error: unknown) => isCoreError(error) && error.code === 'OPERATION_UNCERTAIN'
    );
  }, 20_000);
});

describe('SPEC.md §12 "Cleanup and credentials": dispose releases everything', () => {
  it('stops document delivery and rejects an in-flight save', async () => {
    const server = await startServer();
    const ydoc = new Y.Doc();
    const { connection } = makeConnection(server, { ydoc });
    await connection.connect(5_000);
    server.setReplyToSave(false);

    const pending = connection.save(5_000);

    connection.dispose();

    await expect(pending).rejects.toSatisfy(
      (error: unknown) => isCoreError(error) && error.code === 'HANDLE_EXPIRED'
    );
    expect(connection.provider.ws).toBeNull();
    ydoc.getMap('cells').set('after-dispose', 'must-not-arrive');
    await sleep(400);
    expect(server.room(ROOM)?.getMap('cells').get('after-dispose')).toBeUndefined();
    expect(connection.state).toBe('closed');
    // Diagnostics survive close (SPEC.md §4), credentials do not (SPEC.md §11).
    expect(connection.url).not.toContain(TOKEN);
    expect(JSON.stringify(connection)).not.toContain(TOKEN);
    ydoc.destroy();
  }, 20_000);

  it('the public provider handle does not expose the raw token', async () => {
    const server = await startServer();
    const { connection } = makeConnection(server);
    await connection.connect(5_000);

    // `connection.url` is redacted, but `connection.provider` is public and its
    // `params` is a plain enumerable object: any diagnostic dump of it (or of
    // `provider.url`) prints the credential. SPEC.md §11 forbids credentials in
    // logs and messages.
    expect(JSON.stringify(connection.provider.params)).not.toContain(TOKEN);
  }, 20_000);
});
