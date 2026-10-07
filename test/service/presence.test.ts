/**
 * Presence lifecycle and identity in the registry layer (SPEC.md §10
 * "Presence"): one global room per server binding while a notebook is open,
 * `current` follows the last notebook worked with, `session_identify`
 * republishes everywhere, and presence never fails notebook work.
 */
import { describe, expect, it } from 'vitest';

import {
  isCoreError,
  type CollabService,
  type PresenceUser,
  type ServiceConfigInput
} from '../../src/core/index.js';
import { createCollabService, type NotebookHandleInit } from '../../src/service/index.js';
import type { PresenceRoom } from '../../src/service/presence.js';
import { PROCESS_PRESENCE_OWNER } from '../../src/service/presence.js';
import { makeFakeHandle, makeFakeServer } from './helpers.js';

interface RoomLog {
  readonly serverId: string;
  states: Array<Record<string, unknown>>;
  disposed: boolean;
}

interface Rig {
  readonly service: CollabService;
  readonly rooms: RoomLog[];
  /** Awareness users republished into each document room, by path. */
  readonly documentUsers: Map<string, PresenceUser[]>;
  readonly initialUsers: Map<string, PresenceUser>;
}

const PROFILE = {
  id: 'lab',
  kind: 'standalone' as const,
  apiBaseUrl: 'http://jupyter.test',
  credentialRef: 'literal:unit-token' as const
};

function rig(options: {
  config?: Partial<ServiceConfigInput>;
  me?: () => Promise<Response>;
  failRoom?: boolean;
} = {}): Rig {
  const server = makeFakeServer({
    files: [
      { path: 'a.ipynb', type: 'notebook' },
      { path: 'b.ipynb', type: 'notebook' }
    ]
  });
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input.toString());
    if (url.pathname === '/api/me' && options.me !== undefined) return options.me();
    return server.fetchImpl(input, init);
  }) as typeof fetch;
  const rooms: RoomLog[] = [];
  const documentUsers = new Map<string, PresenceUser[]>();
  const initialUsers = new Map<string, PresenceUser>();
  const service = createCollabService(
    { servers: [PROFILE], ...options.config },
    {
      guardStdout: false,
      fetchImpl,
      openHandle: async (init: NotebookHandleInit) => {
        initialUsers.set(init.path, init.awarenessUser as PresenceUser);
        const { handle } = makeFakeHandle(init);
        const users: PresenceUser[] = [];
        documentUsers.set(init.path, users);
        Object.assign(handle, { setAwarenessUser: (user: PresenceUser) => users.push(user) });
        return handle;
      },
      openPresenceRoom: (serverId, state): PresenceRoom => {
        if (options.failRoom === true) throw new Error('no room');
        const log: RoomLog = { serverId, states: [{ ...state }], disposed: false };
        rooms.push(log);
        return {
          get state() {
            return log.disposed ? 'closed' as const : 'connected' as const;
          },
          lastCloseCode: null,
          connect: () => undefined,
          setLocalState: (next) => log.states.push({ ...next }),
          dispose: () => {
            log.disposed = true;
          }
        };
      }
    }
  );
  return { service, rooms, documentUsers, initialUsers };
}

async function until(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('condition not reached');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const last = (log: RoomLog): Record<string, unknown> => log.states.at(-1)!;
const userOf = (state: Record<string, unknown>): PresenceUser => state['user'] as PresenceUser;

describe('global presence lifecycle', () => {
  it('joins once per server while notebooks are open and follows the last one worked with', async () => {
    const { service, rooms } = rig({ config: { presence: { owner: 'alice' } } });
    try {
      const a = await service.notebookOpen({ path: 'a.ipynb' });
      await until(() => rooms.length === 1);
      expect(rooms[0]!.serverId).toBe('lab');
      expect(last(rooms[0]!)).toMatchObject({ current: 'notebook:a.ipynb', documents: ['a.ipynb'] });
      expect(userOf(last(rooms[0]!)).username).toMatch(/^alice~agent-[0-9a-f]{8}$/u);

      const b = await service.notebookOpen({ path: 'b.ipynb' });
      expect(last(rooms[0]!)).toMatchObject({ current: 'notebook:b.ipynb', documents: ['a.ipynb', 'b.ipynb'] });
      await service.notebookRead({ notebookId: a.notebook.notebookId, view: 'summary' });
      expect(last(rooms[0]!)['current']).toBe('notebook:a.ipynb');

      await service.notebookClose({ notebookId: a.notebook.notebookId });
      expect(rooms[0]!.disposed).toBe(false);
      expect(last(rooms[0]!)).toMatchObject({ current: 'notebook:b.ipynb', documents: ['b.ipynb'] });
      await service.notebookClose({ notebookId: b.notebook.notebookId });
      expect(rooms[0]!.disposed).toBe(true);

      await service.notebookOpen({ path: 'a.ipynb' });
      await until(() => rooms.length === 2);
      expect(rooms).toHaveLength(2);
    } finally {
      await service.shutdown('client_request');
    }
    expect(rooms.every((room) => room.disposed)).toBe(true);
  });

  it('never fails or blocks notebook work when the presence room cannot be created', async () => {
    const { service } = rig({ failRoom: true });
    try {
      const opened = await service.notebookOpen({ path: 'a.ipynb' });
      expect(opened.notebook.path).toBe('a.ipynb');
      await service.notebookRead({ notebookId: opened.notebook.notebookId, view: 'summary' });
    } finally {
      await service.shutdown('client_request');
    }
  });
});

describe('owner', () => {
  it('uses the non-anonymous Jupyter identity and publishes only the final username', async () => {
    let answer: (response: Response) => void = () => undefined;
    const { service, rooms, documentUsers } = rig({
      me: () => new Promise<Response>((resolve) => {
        answer = resolve;
      })
    });
    try {
      await service.notebookOpen({ path: 'a.ipynb' });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(rooms).toHaveLength(0);
      answer(new Response(JSON.stringify({ identity: { username: 'bob', name: 'Bob' } }), { status: 200 }));
      await until(() => rooms.length === 1);
      expect(userOf(rooms[0]!.states[0]!).username).toMatch(/^bob~agent-/u);
      expect(userOf(rooms[0]!.states[0]!).display_name).toMatch(/\(agent of bob\)$/u);
      expect(documentUsers.get('a.ipynb')!.at(-1)!.username).toMatch(/^bob~agent-/u);
    } finally {
      await service.shutdown('client_request');
    }
  });

  it('ignores an anonymous token identity and falls back to the process owner', async () => {
    const anonymous = JSON.stringify({ identity: { username: '0123456789abcdef0123456789abcdef', name: 'Anonymous Io' } });
    const { service, rooms } = rig({ me: async () => new Response(anonymous, { status: 200 }) });
    try {
      await service.notebookOpen({ path: 'a.ipynb' });
      await until(() => rooms.length === 1);
      const user = userOf(rooms[0]!.states[0]!);
      expect(user.username.startsWith(`${PROCESS_PRESENCE_OWNER}~agent-`)).toBe(true);
      expect(user.display_name).toMatch(/\(agent, owner unknown\)$/u);
    } finally {
      await service.shutdown('client_request');
    }
  });

  it('prefers the configured owner over the server identity', async () => {
    const { service, rooms } = rig({
      config: { presence: { owner: 'carol' } },
      me: async () => new Response(JSON.stringify({ identity: { username: 'mallory' } }), { status: 200 })
    });
    try {
      await service.notebookOpen({ path: 'a.ipynb' });
      await until(() => rooms.length === 1);
      expect(userOf(last(rooms[0]!)).username).toMatch(/^carol~agent-/u);
    } finally {
      await service.shutdown('client_request');
    }
  });
});

describe('session_identify', () => {
  it('republishes in the global and document rooms without consuming a request number', async () => {
    const { service, rooms, documentUsers } = rig({ config: { presence: { owner: 'alice' } } });
    try {
      await service.notebookOpen({ path: 'a.ipynb' });
      await until(() => rooms.length === 1);
      const before = (await service.serverList()).nextRequestId;
      const result = await service.sessionIdentify({ name: 'Claude‮ Code', task: 'tidy plots', color: '#AABBCC' });
      expect(result.nextRequestId).toBe(before);
      expect(result.declared).toEqual({ name: 'Claude Code', task: 'tidy plots', color: '#aabbcc' });
      expect(result.servers).toEqual([
        expect.objectContaining({ serverId: 'lab', ownerSource: 'configured', openDocuments: 1, globalPresence: 'connected' })
      ]);
      const published = userOf(last(rooms[0]!));
      expect(published.display_name).toBe('Claude Code · tidy plots (agent of alice)');
      expect(published.color).toBe('#aabbcc');
      expect(documentUsers.get('a.ipynb')!.at(-1)).toEqual(published);

      const again = await service.sessionIdentify({ name: 'Claude Code', task: 'tidy plots', color: '#aabbcc' });
      expect(again.servers[0]!.user).toEqual(published);

      const cleared = await service.sessionIdentify({ name: 'Claude Code', color: 'red' });
      expect(cleared.colorApplied).toBe(false);
      expect(userOf(last(rooms[0]!)).display_name).toBe('Claude Code (agent of alice)');
      expect(userOf(last(rooms[0]!)).color).toBe('#0f766e');
    } finally {
      await service.shutdown('client_request');
    }
  });

  it('rejects an empty name with INVALID_ARGUMENT and keeps the previous presence', async () => {
    const { service } = rig({ config: { presence: { owner: 'alice' } } });
    try {
      await expect(service.sessionIdentify({ name: '​ \n' })).rejects.toSatisfy(
        (error: unknown) => isCoreError(error) && error.code === 'INVALID_ARGUMENT'
      );
    } finally {
      await service.shutdown('client_request');
    }
  });

  it('uses clientInfo by default unless the operator disabled it', async () => {
    for (const clientInfo of [true, false]) {
      const { service, initialUsers } = rig({
        config: { presence: { owner: 'alice', clientInfo }, awarenessUser: { name: 'Ops bot' } }
      });
      try {
        service.observeClientInfo?.({ name: 'claude-code', title: 'Claude Code', version: '2.1.0' });
        await service.notebookOpen({ path: 'a.ipynb' });
        expect(initialUsers.get('a.ipynb')!.display_name).toBe(
          clientInfo ? 'Claude Code 2.1.0 (agent of alice)' : 'Ops bot (agent of alice)'
        );
      } finally {
        await service.shutdown('client_request');
      }
    }
  });

  it('gives two contexts with the same owner distinct usernames', async () => {
    const first = rig({ config: { presence: { owner: 'alice' } } });
    const second = rig({ config: { presence: { owner: 'alice' } } });
    try {
      await first.service.notebookOpen({ path: 'a.ipynb' });
      await second.service.notebookOpen({ path: 'a.ipynb' });
      const one = first.initialUsers.get('a.ipynb')!.username;
      const two = second.initialUsers.get('a.ipynb')!.username;
      expect(one).toMatch(/^alice~agent-/u);
      expect(two).toMatch(/^alice~agent-/u);
      expect(one).not.toBe(two);
    } finally {
      await first.service.shutdown('client_request');
      await second.service.shutdown('client_request');
    }
  });
});
