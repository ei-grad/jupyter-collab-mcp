/**
 * `AwarenessRoom` against the fake room server (SPEC.md §10 "Presence"):
 * the global room handshake, prompt removal on leave, and reconnect.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { Awareness } from 'y-protocols/awareness';
import { WebsocketProvider } from 'y-websocket';
import WebSocket from 'ws';
import * as Y from 'yjs';

import { AwarenessRoom, GLOBAL_AWARENESS_ROOM } from '../../src/jupyter/awareness-room.js';
import { FakeRtcServer } from './helpers/fake-rtc-server.js';

const cleanups: Array<() => void | Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
  cleanups.length = 0;
});

async function startServer(): Promise<FakeRtcServer> {
  const server = await FakeRtcServer.start();
  cleanups.push(() => server.close());
  return server;
}

/** A second participant of the same room, like a JupyterLab tab. */
async function observer(server: FakeRtcServer): Promise<Awareness> {
  const doc = new Y.Doc();
  const awareness = new Awareness(doc);
  const provider = new WebsocketProvider(`${server.baseUrl}/api/collaboration/room`, GLOBAL_AWARENESS_ROOM, doc, {
    awareness,
    disableBc: true,
    WebSocketPolyfill: WebSocket as unknown as typeof globalThis.WebSocket
  });
  cleanups.push(() => {
    provider.destroy();
    awareness.destroy();
    doc.destroy();
  });
  await until(() => provider.wsconnected);
  return awareness;
}

async function until(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('condition not reached');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function remoteUsers(awareness: Awareness): string[] {
  return [...awareness.getStates().entries()]
    .filter(([client]) => client !== awareness.clientID)
    .map(([, state]) => String((state['user'] as Record<string, unknown> | undefined)?.['username']));
}

function makeRoom(server: FakeRtcServer, username: string): AwarenessRoom {
  const room = new AwarenessRoom(
    { wsBaseUrl: server.baseUrl, token: 'unit-token', maxBackoffTime: 50 },
    { user: { username, name: username }, current: 'notebook:a.ipynb' }
  );
  cleanups.push(() => room.dispose());
  return room;
}

describe('AwarenessRoom', () => {
  it('joins JupyterLab:globalAwareness with header auth and no session query', async () => {
    const server = await startServer();
    const peer = await observer(server);
    const room = makeRoom(server, 'alice~agent-1');
    room.connect();
    await until(() => remoteUsers(peer).includes('alice~agent-1'));
    expect(room.state).toBe('connected');
    const index = server.seenRooms.lastIndexOf(GLOBAL_AWARENESS_ROOM);
    expect(server.seenQueries[index]).toBe('');
    expect(server.seenAuthorizations[index]).toBe('token unit-token');
  });

  it('publishes state changes and leaves promptly on dispose', async () => {
    const server = await startServer();
    const peer = await observer(server);
    const room = makeRoom(server, 'alice~agent-1');
    room.connect();
    await until(() => remoteUsers(peer).includes('alice~agent-1'));
    room.setLocalState({ user: { username: 'alice~agent-1' }, current: 'notebook:b.ipynb' });
    await until(() => [...peer.getStates().values()].some((state) => state['current'] === 'notebook:b.ipynb'));
    room.dispose();
    // Well under the 30 s awareness timeout: the null state was sent.
    await until(() => !remoteUsers(peer).includes('alice~agent-1'), 2_000);
    expect(room.state).toBe('closed');
  });

  it('reconnects after the server drops the socket and republishes', async () => {
    const server = await startServer();
    const room = makeRoom(server, 'alice~agent-1');
    room.connect();
    await until(() => room.state === 'connected');
    server.dropAll();
    await until(() => room.state === 'reconnecting');
    await until(() => room.state === 'connected' && server.seenRooms.filter((name) => name === GLOBAL_AWARENESS_ROOM).length === 2);
    const peer = await observer(server);
    room.setLocalState({ user: { username: 'alice~agent-1' }, current: 'notebook:c.ipynb' });
    await until(() => [...peer.getStates().values()].some((state) => state['current'] === 'notebook:c.ipynb'));
  });
});
