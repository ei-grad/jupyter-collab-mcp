/**
 * Adversarial integration review of the transport layer against the real stand
 * (dev/jupyter, port 8892). Reviewer-added; nothing existing is modified.
 *
 * Rows of SPEC.md §12 attacked here:
 *   - "Stateful lifecycle": 100 sequential edits on one handle must reuse one
 *     `Y.Doc` and one uninterrupted RTC socket, with no new initial sync;
 *   - "Network and restart": a reconnect keeps the replica, and an edit written
 *     while the socket was down still reaches an independent client;
 *   - "Cleanup and credentials": startup, reconnect and the terminal error path
 *     never expose the token.
 */
import { YNotebook, type YCodeCell } from '@jupyter/ydoc';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { isCoreError, type ResolvedServer } from '../../src/core/index.js';
import { RtcConnection } from '../../src/jupyter/rtc-connection.js';
import { ServerClient } from '../../src/jupyter/server-client.js';
import { startStand, type Stand } from '../helpers/stand.js';

const PORT = 8892;
const ORIGIN = { label: 'review-transport-int' };

let stand: Stand;
let client: ServerClient;

interface Client {
  readonly notebook: YNotebook;
  readonly connection: RtcConnection;
}

const open: Client[] = [];

function resolvedServer(): ResolvedServer {
  return {
    profile: {
      id: 'review-stand',
      kind: 'standalone',
      apiBaseUrl: stand.baseUrl,
      credentialRef: `literal:${stand.token}`
    },
    apiBaseUrl: stand.baseUrl,
    wsBaseUrl: stand.wsUrl,
    token: stand.token
  };
}

async function openRoom(fileId: string, sessionId: string): Promise<Client> {
  const notebook = new YNotebook();
  const connection = new RtcConnection({
    wsBaseUrl: stand.wsUrl,
    token: stand.token,
    fileId,
    sessionId,
    ydoc: notebook.ydoc,
    awareness: notebook.awareness,
    awarenessUser: { name: 'reviewer', color: '#b71c1c' }
  });
  const entry: Client = { notebook, connection };
  open.push(entry);
  await connection.connect(30_000);
  return entry;
}

function close(entry: Client): void {
  entry.connection.dispose();
  entry.notebook.dispose();
  const index = open.indexOf(entry);
  if (index >= 0) open.splice(index, 1);
}

function waitForState(
  connection: RtcConnection,
  target: 'reconnecting' | 'ready' | 'failed',
  timeoutMs: number
): Promise<void> {
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

function findCell(notebook: YNotebook, id: string): YCodeCell | undefined {
  return notebook.cells.find((cell) => cell.getId() === id) as YCodeCell | undefined;
}

beforeAll(async () => {
  stand = await startStand({ port: PORT });
  client = new ServerClient(resolvedServer());
}, 150_000);

afterAll(async () => {
  for (const entry of open.splice(0)) {
    entry.connection.dispose();
    entry.notebook.dispose();
  }
  await stand?.stop();
}, 150_000);

describe('SPEC.md §12 "Stateful lifecycle" on a real room', () => {
  it('100 sequential edits reuse one Y.Doc, one socket and one initial sync', async () => {
    const created = await client.newUntitledNotebook('');
    const session = await client.collaborationSession(created.path);
    const a = await openRoom(session.fileId, session.sessionId);

    expect(a.notebook.nbformat).toBe(4);
    const socket = a.connection.provider.ws;
    const clientId = a.notebook.ydoc.clientID;

    let cellId = '';
    a.notebook.ydoc.transact(() => {
      cellId = a.notebook.addCell({ cell_type: 'code', source: 'x = 0' }).getId();
    }, ORIGIN);

    for (let i = 1; i <= 100; i += 1) {
      a.notebook.ydoc.transact(() => {
        const cell = findCell(a.notebook, cellId);
        if (cell === undefined) throw new Error('cell disappeared');
        const source = cell.getSource();
        cell.updateSource(0, source.length, `x = ${String(i)}`);
      }, ORIGIN);
      // The point of the row: a warm call must not re-open anything.
      expect(a.connection.state).toBe('ready');
    }

    expect(a.connection.socketGeneration).toBe(1);
    expect(a.connection.provider.ws).toBe(socket);
    expect(a.connection.rawHandlerInstalls).toBe(1);
    expect(a.notebook.ydoc.clientID).toBe(clientId);

    const b = await openRoom(session.fileId, session.sessionId);
    await expect
      .poll(() => findCell(b.notebook, cellId)?.getSource(), { timeout: 30_000 })
      .toBe('x = 100');

    await expect(a.connection.save(30_000)).resolves.toBe('success');
    close(b);
    close(a);
  }, 180_000);
});

describe('SPEC.md §12 "Network and restart" on a real room', () => {
  it('an edit written while the socket is down still reaches the other client', async () => {
    const created = await client.newUntitledNotebook('');
    const session = await client.collaborationSession(created.path);
    const a = await openRoom(session.fileId, session.sessionId);
    const b = await openRoom(session.fileId, session.sessionId);

    let cellId = '';
    a.notebook.ydoc.transact(() => {
      cellId = a.notebook.addCell({ cell_type: 'code', source: 'before' }).getId();
    }, ORIGIN);
    await expect
      .poll(() => findCell(b.notebook, cellId)?.getSource(), { timeout: 30_000 })
      .toBe('before');

    const sawReconnecting = waitForState(a.connection, 'reconnecting', 20_000);
    const sawReady = waitForState(a.connection, 'ready', 40_000);
    a.connection.provider.ws?.close();
    await sawReconnecting;

    // SPEC.md §6: "Updates already created are retained in memory for
    // reconnection." Nothing but the post-reconnect sync can carry it.
    a.notebook.ydoc.transact(() => {
      const cell = findCell(a.notebook, cellId);
      cell?.updateSource(0, cell.getSource().length, 'written while offline');
    }, ORIGIN);

    await sawReady;
    await expect
      .poll(() => findCell(b.notebook, cellId)?.getSource(), { timeout: 40_000 })
      .toBe('written while offline');
    expect(a.connection.rawHandlerInstalls).toBe(1);
    await expect(a.connection.save(30_000)).resolves.toBe('success');

    close(b);
    close(a);
  }, 180_000);
});

describe('SPEC.md §12 "Cleanup and credentials" on a real server', () => {
  it('no token in the handle, its errors or a rejected session', async () => {
    const created = await client.newUntitledNotebook('');
    const session = await client.collaborationSession(created.path);
    const a = await openRoom(session.fileId, session.sessionId);

    expect(a.connection.url).not.toContain(stand.token);
    expect(JSON.stringify(a.connection)).not.toContain(stand.token);
    expect(String(client)).not.toContain(stand.token);
    close(a);

    const notebook = new YNotebook();
    const rejected = new RtcConnection({
      wsBaseUrl: stand.wsUrl,
      token: stand.token,
      fileId: session.fileId,
      sessionId: '11111111-2222-3333-4444-555555555555',
      ydoc: notebook.ydoc,
      awareness: notebook.awareness,
      awarenessUser: { name: 'reviewer', color: '#b71c1c' }
    });
    try {
      const error = await rejected.connect(30_000).then(
        () => new Error('should have been rejected'),
        (reason: unknown) => reason
      );
      expect(isCoreError(error) && error.code).toBe('RTC_SESSION_REJECTED');
      if (isCoreError(error)) {
        expect(JSON.stringify(error.toJSON())).not.toContain(stand.token);
      }
      expect(rejected.url).not.toContain(stand.token);
    } finally {
      rejected.dispose();
      notebook.dispose();
    }
  }, 120_000);
});
