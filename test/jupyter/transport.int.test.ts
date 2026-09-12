/**
 * Integration tests for the transport layer against the real stand
 * (dev/jupyter, port 8896): SPEC.md §6 handshake, two independent RTC clients,
 * RAW save, reconnect, and the close codes the fake server can only imitate.
 *
 * Everything the notebook content needs goes through `@jupyter/ydoc` here, on
 * purpose: `RtcConnection` itself stays agnostic, but the room on the other end
 * is a real notebook document.
 */
import { YNotebook, type YCodeCell } from '@jupyter/ydoc';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { isCoreError, type ResolvedServer } from '../../src/core/index.js';
import { RtcConnection } from '../../src/jupyter/rtc-connection.js';
import { ServerClient } from '../../src/jupyter/server-client.js';
import { startStand, type Stand } from '../helpers/stand.js';

const PORT = 8896;
/** Transaction origin marking our own writes (SPEC.md §10, spike/NOTES.md §3.2). */
const ORIGIN = { label: 'transport-int-test' };

let stand: Stand;
let client: ServerClient;

interface Client {
  readonly notebook: YNotebook;
  readonly connection: RtcConnection;
}

const openClients: Client[] = [];

function resolvedServer(): ResolvedServer {
  return {
    profile: {
      id: 'stand',
      kind: 'standalone',
      apiBaseUrl: stand.baseUrl,
      credentialRef: `literal:${stand.token}`
    },
    apiBaseUrl: stand.baseUrl,
    wsBaseUrl: stand.wsUrl,
    token: stand.token
  };
}

async function openRoom(fileId: string, sessionId: string, timeoutMs = 20_000): Promise<Client> {
  const notebook = new YNotebook();
  const connection = new RtcConnection({
    wsBaseUrl: stand.wsUrl,
    token: stand.token,
    fileId,
    sessionId,
    ydoc: notebook.ydoc,
    awareness: notebook.awareness,
    awarenessUser: { name: 'mcp-test', color: '#2e7d32' }
  });
  const entry: Client = { notebook, connection };
  openClients.push(entry);
  await connection.connect(timeoutMs);
  return entry;
}

function closeClient(entry: Client): void {
  entry.connection.dispose();
  entry.notebook.dispose();
}

/** Resolve on the next transition into `target` (never on the current state). */
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
}, 120_000);

afterAll(async () => {
  for (const entry of openClients.splice(0)) closeClient(entry);
  await stand?.stop();
}, 120_000);

describe('ServerClient against a real Jupyter Server', () => {
  it('reports status, creates a notebook and sees it in the listing', async () => {
    const status = await client.status();
    expect(typeof status.started).toBe('string');

    const created = await client.newUntitledNotebook('');
    expect(created.path).toMatch(/\.ipynb$/);

    const stat = await client.contentsExists(created.path);
    expect(stat).not.toBeNull();
    expect(stat?.type).toBe('notebook');

    // A plain file must be filtered out of the listing (SPEC.md §9).
    const plainFile = await fetch(`${stand.baseUrl}/api/contents/`, {
      method: 'POST',
      headers: { Authorization: `token ${stand.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'file', ext: '.txt' })
    });
    const plainModel = JSON.parse(await plainFile.text()) as { path: string };

    const listing = await client.listDirectory('');
    expect(listing.entries.some((entry) => entry.path === created.path)).toBe(true);
    expect(listing.entries.some((entry) => entry.path === plainModel.path)).toBe(false);

    await expect(client.contentsExists('definitely/not/here.ipynb')).resolves.toBeNull();
  });

  it('returns a fileId per document and one server-wide sessionId', async () => {
    const first = await client.newUntitledNotebook('');
    const second = await client.newUntitledNotebook('');

    const sessionA = await client.collaborationSession(first.path);
    const sessionB = await client.collaborationSession(second.path);
    const sessionAgain = await client.collaborationSession(first.path);

    expect(sessionA.fileId).not.toBe(sessionB.fileId);
    // spike/NOTES.md §3.7: SERVER_SESSION is one per Jupyter process.
    expect(sessionA.sessionId).toBe(sessionB.sessionId);
    expect(sessionAgain.fileId).toBe(sessionA.fileId);
    expect(sessionAgain.httpStatus).toBe(200);
  });

  it('handles unicode, spaces and nested directories in both encodings', async () => {
    const directory = `δοκιμή κατάλογος ${Date.now()}`;
    const created = await client.newUntitledNotebook('');
    // Rename the untitled notebook into a nested unicode directory via the
    // Contents API; only the *path encoding* is under test here.
    const nested = `${directory}/${created.path}`;
    const response = await fetch(
      `${stand.baseUrl}/api/contents/${encodeURIComponent(created.path)}`,
      {
        method: 'PATCH',
        headers: {
          Authorization: `token ${stand.token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ path: nested })
      }
    );
    // The directory does not exist yet, so the rename fails; create it first.
    if (!response.ok) {
      await response.text();
      const dir = await fetch(`${stand.baseUrl}/api/contents/`, {
        method: 'POST',
        headers: {
          Authorization: `token ${stand.token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ type: 'directory' })
      });
      const dirModel = (await dir.json()) as { path: string };
      const renameDir = await fetch(
        `${stand.baseUrl}/api/contents/${encodeURIComponent(dirModel.path)}`,
        {
          method: 'PATCH',
          headers: {
            Authorization: `token ${stand.token}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ path: directory })
        }
      );
      expect(renameDir.ok).toBe(true);
      await renameDir.text();
    }

    const notebook = await client.newUntitledNotebook(directory);
    expect(notebook.path.startsWith(`${directory}/`)).toBe(true);

    const stat = await client.contentsExists(notebook.path);
    expect(stat?.type).toBe('notebook');

    const session = await client.collaborationSession(notebook.path);
    expect(session.fileId).toBeTruthy();

    const listing = await client.listDirectory(directory);
    expect(listing.entries.some((entry) => entry.path === notebook.path)).toBe(true);
  });
});

describe('RtcConnection against a real collaboration room', () => {
  it('syncs two independent clients, saves and survives a reconnect', async () => {
    const created = await client.newUntitledNotebook('');
    const session = await client.collaborationSession(created.path);

    const a = await openRoom(session.fileId, session.sessionId);
    expect(a.connection.state).toBe('ready');
    expect(a.connection.roomName).toBe(`json:notebook:${session.fileId}`);
    // Readiness for the notebook layer: synced AND nbformat defined
    // (spike/NOTES.md §4). A fresh notebook already has one server-made cell.
    expect(a.notebook.nbformat).toBe(4);
    expect(a.notebook.cells.length).toBeGreaterThanOrEqual(1);

    // Our own write, tagged with a transaction origin the notebook layer will
    // use to tell own changes from remote ones.
    const cellId = ((): string => {
      let id = '';
      a.notebook.ydoc.transact(() => {
        id = a.notebook.addCell({ cell_type: 'code', source: 'x = 40 + 2\nx' }).getId();
      }, ORIGIN);
      return id;
    })();

    const b = await openRoom(session.fileId, session.sessionId);
    await expect
      .poll(() => findCell(b.notebook, cellId)?.getSource(), { timeout: 20_000 })
      .toBe('x = 40 + 2\nx');

    // RAW save over the same socket.
    await expect(a.connection.save(20_000)).resolves.toBe('success');

    const handler = a.connection.provider.messageHandlers[2];
    const generationBefore = a.connection.socketGeneration;

    // Force a transport loss without a terminal signal (SPEC.md §6 row 1).
    const sawReconnecting = waitForState(a.connection, 'reconnecting', 10_000);
    const sawReady = waitForState(a.connection, 'ready', 20_000);
    a.connection.provider.ws?.close();
    await sawReconnecting;
    await sawReady;

    expect(a.connection.socketGeneration).toBe(generationBefore + 1);
    // SPEC.md §12: exactly one RAW handler after the reconnect.
    expect(a.connection.rawHandlerInstalls).toBe(1);
    expect(a.connection.provider.messageHandlers[2]).toBe(handler);

    // The same Y.Doc keeps working and save replies are still recognised.
    a.notebook.ydoc.transact(() => {
      const cell = findCell(a.notebook, cellId);
      cell?.updateSource(cell.getSource().length, cell.getSource().length, '\n# after reconnect');
    }, ORIGIN);
    await expect
      .poll(() => findCell(b.notebook, cellId)?.getSource(), { timeout: 20_000 })
      .toContain('# after reconnect');
    await expect(a.connection.save(20_000)).resolves.toBe('success');

    closeClient(a);
    closeClient(b);
    openClients.splice(0, openClients.length);
  }, 90_000);

  it('authenticates the room handshake by header, and by query when asked', async () => {
    const created = await client.newUntitledNotebook('');
    const session = await client.collaborationSession(created.path);

    // Default: `Authorization: token …` on the upgrade request. jupyter_server
    // 2.21.0 accepts it exactly as it does on REST, so the credential never
    // enters a URL (SPEC.md §11).
    const header = await openRoom(session.fileId, session.sessionId);
    expect(header.connection.state).toBe('ready');
    expect(header.connection.url).not.toContain('token');
    expect(JSON.stringify(header.connection.provider.params)).not.toContain(stand.token);

    // The browser docprovider's `?token=` still works; it is the opt-in
    // fallback for a proxy that strips the header.
    const notebook = new YNotebook();
    const query = new RtcConnection({
      wsBaseUrl: stand.wsUrl,
      token: stand.token,
      fileId: session.fileId,
      sessionId: session.sessionId,
      ydoc: notebook.ydoc,
      awareness: notebook.awareness,
      awarenessUser: { name: 'mcp-test', color: '#2e7d32' },
      tokenTransport: 'query'
    });
    try {
      await query.connect(20_000);
      expect(query.state).toBe('ready');
      expect(query.url).toContain('token=<redacted>');
    } finally {
      query.dispose();
      notebook.dispose();
    }
  }, 60_000);

  it('maps a room for a missing file to NOTEBOOK_NOT_FOUND (close 4404)', async () => {
    // A document session for a path that does not exist still answers 201 with
    // a fresh fileId; the room is where it fails (spike/NOTES.md §1.2).
    const missing = `missing-${Date.now()}.ipynb`;
    const session = await client.collaborationSession(missing);
    expect(session.fileId).toBeTruthy();
    await expect(client.contentsExists(missing)).resolves.toBeNull();

    const notebook = new YNotebook();
    const connection = new RtcConnection({
      wsBaseUrl: stand.wsUrl,
      token: stand.token,
      fileId: session.fileId,
      sessionId: session.sessionId,
      ydoc: notebook.ydoc,
      awareness: notebook.awareness,
      awarenessUser: { name: 'mcp-test', color: '#2e7d32' }
    });

    try {
      await expect(connection.connect(20_000)).rejects.toSatisfy(
        (error: unknown) => isCoreError(error) && error.code === 'NOTEBOOK_NOT_FOUND'
      );
      expect(connection.state).toBe('failed');
      expect(connection.provider.shouldConnect).toBe(false);
    } finally {
      connection.dispose();
      notebook.dispose();
    }
  }, 60_000);

  it('rejects an unknown sessionId without reconnecting (close 1003)', async () => {
    const created = await client.newUntitledNotebook('');
    const session = await client.collaborationSession(created.path);

    const notebook = new YNotebook();
    const connection = new RtcConnection({
      wsBaseUrl: stand.wsUrl,
      token: stand.token,
      fileId: session.fileId,
      sessionId: '00000000-0000-0000-0000-000000000000',
      ydoc: notebook.ydoc,
      awareness: notebook.awareness,
      awarenessUser: { name: 'mcp-test', color: '#2e7d32' }
    });

    try {
      await expect(connection.connect(20_000)).rejects.toSatisfy(
        (error: unknown) => isCoreError(error) && error.code === 'RTC_SESSION_REJECTED'
      );
      expect(connection.terminalError?.details).toMatchObject({
        closeCode: 1003,
        reason: 'unknown_session'
      });
      expect(connection.provider.shouldConnect).toBe(false);
    } finally {
      connection.dispose();
      notebook.dispose();
    }
  }, 60_000);
});
