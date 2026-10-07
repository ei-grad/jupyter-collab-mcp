/**
 * Agent presence against the real stand (SPEC.md §10 "Presence").
 *
 * An independent client joins `JupyterLab:globalAwareness` exactly as the
 * JupyterLab collaborators panel does and must see the agent with its derived
 * `username` and `current` notebook while one is open, see a declaration
 * update, and see it leave promptly once the last notebook closes. A second
 * replica of the notebook room checks the document-room `IUser`.
 *
 * Port 8931 belongs to this file alone.
 */

import { YNotebook } from '@jupyter/ydoc';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Awareness } from 'y-protocols/awareness';
import { WebsocketProvider } from 'y-websocket';
import * as Y from 'yjs';

import type { CollabService, ResolvedServer } from '../../src/core/index.js';
import { GLOBAL_AWARENESS_ROOM } from '../../src/jupyter/awareness-room.js';
import { RtcConnection } from '../../src/jupyter/rtc-connection.js';
import { ServerClient } from '../../src/jupyter/server-client.js';
import { authenticatedWebSocket } from '../../src/jupyter/ws-auth.js';
import { createCollabService } from '../../src/service/index.js';
import { PROCESS_PRESENCE_OWNER } from '../../src/service/presence.js';
import { apiFetchOk } from '../helpers/fetch.js';
import { startStand, type Stand } from '../helpers/stand.js';

const PORT = 8931;
const RUN = Date.now().toString(36);
const nb = (label: string): string => `presence-${RUN}-${label}.ipynb`;

let stand: Stand;
const cleanups: Array<() => void | Promise<void>> = [];

function profile(): ResolvedServer['profile'] {
  return {
    id: 'stand',
    kind: 'standalone',
    apiBaseUrl: stand.baseUrl,
    wsBaseUrl: stand.wsUrl,
    credentialRef: `literal:${stand.token}`
  };
}

/** A JupyterLab-like participant of the global awareness room. */
async function panelObserver(): Promise<Awareness> {
  const doc = new Y.Doc();
  const awareness = new Awareness(doc);
  awareness.setLocalState({ user: { username: 'human', name: 'Human', display_name: 'Human' } });
  const provider = new WebsocketProvider(`${stand.wsUrl}/api/collaboration/room`, GLOBAL_AWARENESS_ROOM, doc, {
    awareness,
    disableBc: true,
    WebSocketPolyfill: authenticatedWebSocket(stand.token)
  });
  cleanups.push(() => {
    provider.destroy();
    awareness.destroy();
    doc.destroy();
  });
  await until(() => provider.synced, 20_000);
  return awareness;
}

async function until(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`condition not reached within ${timeoutMs}ms`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

type State = Record<string, unknown> & { user?: Record<string, unknown> };

function agents(awareness: Awareness, prefix: string): State[] {
  return [...awareness.getStates().entries()]
    .filter(([client]) => client !== awareness.clientID)
    .map(([, state]) => state as State)
    .filter((state) => typeof state.user?.['username'] === 'string' && String(state.user['username']).startsWith(prefix));
}

beforeAll(async () => {
  stand = await startStand({ port: PORT });
}, 120_000);

afterAll(async () => {
  for (const cleanup of cleanups.reverse()) {
    try {
      await cleanup();
    } catch {
      // Cleanup is best effort; the assertions already ran.
    }
  }
  try {
    const target = { baseUrl: stand.baseUrl, token: stand.token };
    const listing = await apiFetchOk(target, '/api/contents/?content=1');
    for (const entry of listing.json<{ content?: Array<{ path: string }> }>().content ?? []) {
      if (!entry.path.startsWith(`presence-${RUN}-`) && !entry.path.startsWith('Untitled')) continue;
      await apiFetchOk(target, `/api/contents/${entry.path}`, { method: 'DELETE' }, [204, 404]);
    }
  } catch {
    // Cleaning the stand is best effort.
  }
  await stand.stop();
}, 60_000);

describe('global presence in JupyterLab:globalAwareness', () => {
  it('shows the agent with its username and current notebook, updates it, and leaves on close', async () => {
    const service: CollabService = createCollabService(
      { servers: [profile()], presence: { owner: 'alice' } },
      { guardStdout: false }
    );
    cleanups.push(() => service.shutdown('client_request'));
    const panel = await panelObserver();

    const created = await service.notebookCreate({ requestId: '1', directory: '', name: nb('global') });
    const path = created.notebook.path;
    await until(() => agents(panel, 'alice~agent-').length === 1, 20_000);
    const [seen] = agents(panel, 'alice~agent-');
    const username = String(seen!.user!['username']);
    expect(username).toMatch(/^alice~agent-[0-9a-f]{8}$/u);
    expect(seen).toMatchObject({ current: `notebook:${path}`, documents: [path] });
    expect(seen!.user).toMatchObject({ initials: 'AI', avatar_url: null });
    expect(String(seen!.user!['display_name'])).toMatch(/\(agent of alice\)$/u);

    // A second replica of the notebook room, joined before the declaration
    // so it receives the republished document-room state.
    const collaboration = await new ServerClient({
      profile: profile(), apiBaseUrl: stand.baseUrl, wsBaseUrl: stand.wsUrl, token: stand.token
    }).collaborationSession(path);
    const replica = new YNotebook();
    const room = new RtcConnection({
      wsBaseUrl: stand.wsUrl,
      token: stand.token,
      fileId: collaboration.fileId,
      sessionId: collaboration.sessionId,
      ydoc: replica.ydoc,
      awareness: replica.awareness,
      awarenessUser: { name: 'second replica', color: '#5e35b1' }
    });
    cleanups.push(() => {
      room.dispose();
      replica.dispose();
    });
    await room.connect(30_000);

    const identified = await service.sessionIdentify({ name: 'Integration agent', task: 'presence check' });
    expect(identified.servers[0]).toMatchObject({ serverId: 'stand', globalPresence: 'connected', openDocuments: 1 });
    const declared = 'Integration agent · presence check (agent of alice)';
    await until(() => agents(panel, username).some((state) => state.user?.['display_name'] === declared), 10_000);
    const inDocument = (): State | undefined => [...replica.awareness.getStates().values()]
      .map((state) => state as State)
      .find((state) => state.user?.['username'] === username && state.user['display_name'] === declared);
    await until(() => inDocument() !== undefined, 10_000);
    expect(inDocument()!['autosave']).toBe(true);
    expect(inDocument()!.user).toMatchObject({ initials: 'AI', name: 'Integration agent (agent of alice)' });

    const closedAt = Date.now();
    await service.notebookClose({ notebookId: created.notebook.notebookId });
    // Far below the 30 s awareness timeout: the agent announced its departure.
    await until(() => agents(panel, username).length === 0, 5_000);
    expect(Date.now() - closedAt).toBeLessThan(5_000);
  });

  it('falls back to the per-process owner on a shared-token server', async () => {
    const service: CollabService = createCollabService({ servers: [profile()] }, { guardStdout: false });
    cleanups.push(() => service.shutdown('client_request'));
    const panel = await panelObserver();
    const created = await service.notebookCreate({ requestId: '1', directory: '', name: nb('anonymous') });
    await until(() => agents(panel, `${PROCESS_PRESENCE_OWNER}~agent-`).length === 1, 20_000);
    const [seen] = agents(panel, `${PROCESS_PRESENCE_OWNER}~agent-`);
    expect(String(seen!.user!['display_name'])).toMatch(/\(agent, owner unknown\)$/u);
    expect(seen!['current']).toBe(`notebook:${created.notebook.path}`);
    await service.shutdown('client_request');
    await until(() => agents(panel, `${PROCESS_PRESENCE_OWNER}~agent-`).length === 0, 5_000);
  });
});
