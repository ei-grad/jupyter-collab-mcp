/**
 * Credential resolution, local runtime discovery and server selection
 * (SPEC.md §11, docs/CONNECTIONS.md §9).
 */

import { describe, expect, it } from 'vitest';

import { isCoreError, withDefaults, type ServerProfile } from '../../src/core/index.js';
import {
  ServerRegistry,
  describeServer,
  discoverLocalServers,
  resolveCredential,
  resolveServer,
  runtimeDirCandidates
} from '../../src/service/index.js';

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    return isCoreError(error) ? error.code : 'other';
  }
  return 'no-error';
}

async function asyncCodeOf(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
  } catch (error) {
    return isCoreError(error) ? error.code : 'other';
  }
  return 'no-error';
}

const PROFILE: ServerProfile = {
  id: 'main',
  kind: 'standalone',
  apiBaseUrl: 'http://127.0.0.1:8888/',
  credentialRef: 'literal:tok'
};

describe('credential references', () => {
  it('reads env:', () => {
    expect(resolveCredential('env:JUP_TOK', { env: { JUP_TOK: 'secret' } })).toBe('secret');
  });

  it('AUTH_REQUIRED when the variable is unset, without naming a value', () => {
    expect(codeOf(() => resolveCredential('env:MISSING', { env: {} }))).toBe('AUTH_REQUIRED');
  });

  it('reads file: and trims one trailing newline', () => {
    expect(resolveCredential('file:/x/token', { readFile: () => 'abc\n' })).toBe('abc');
  });

  it('AUTH_REQUIRED for an unreadable or empty credential file', () => {
    expect(
      codeOf(() =>
        resolveCredential('file:/x/token', {
          readFile: () => {
            throw new Error('ENOENT');
          }
        })
      )
    ).toBe('AUTH_REQUIRED');
    expect(codeOf(() => resolveCredential('file:/x/token', { readFile: () => '' }))).toBe(
      'AUTH_REQUIRED'
    );
  });

  it('INVALID_ARGUMENT for an unknown scheme', () => {
    expect(codeOf(() => resolveCredential('vault:x' as never))).toBe('INVALID_ARGUMENT');
  });

  it('derives the WS base and keeps the token inside the process', () => {
    const resolved = resolveServer(PROFILE);
    expect(resolved.apiBaseUrl).toBe('http://127.0.0.1:8888');
    expect(resolved.wsBaseUrl).toBe('ws://127.0.0.1:8888');
    expect(resolved.token).toBe('tok');
    expect(JSON.stringify(describeServer(PROFILE))).not.toContain('tok');
  });

  it.each([
    ['apiBaseUrl query', { apiBaseUrl: 'https://host.invalid/user/alice?token=url-secret' }],
    ['apiBaseUrl userinfo', { apiBaseUrl: 'https://url-secret@host.invalid/user/alice' }],
    ['wsBaseUrl query', { wsBaseUrl: 'wss://host.invalid/user/alice?token=url-secret' }],
    ['wsBaseUrl userinfo', { wsBaseUrl: 'wss://url-secret@host.invalid/user/alice' }],
    ['browserBaseUrl query', { browserBaseUrl: 'https://host.invalid/user/alice?token=url-secret' }],
    ['browserBaseUrl userinfo', { browserBaseUrl: 'https://url-secret@host.invalid/user/alice' }]
  ])('rejects a credential-bearing %s without echoing it', async (_name, change) => {
    const registry = new ServerRegistry(
      withDefaults({ servers: [{ ...PROFILE, ...change }] })
    );
    try {
      await registry.list();
      expect.fail('expected invalid server URL');
    } catch (error) {
      expect(error).toMatchObject({ code: 'INVALID_ARGUMENT' });
      expect(String(error)).not.toContain('url-secret');
      expect(JSON.stringify(error)).not.toContain('url-secret');
    }
  });
});

describe('local runtime discovery', () => {
  const descriptor = JSON.stringify({
    url: 'http://localhost:8899/',
    port: 8899,
    token: 'runtime-secret',
    root_dir: '/home/jovyan/nb'
  });

  it('lists the standard directories, most specific first', () => {
    const dirs = runtimeDirCandidates({
      env: { JUPYTER_RUNTIME_DIR: '/explicit' },
      platform: 'darwin',
      home: '/Users/jovyan'
    });
    expect(dirs[0]).toBe('/explicit');
    expect(dirs).toContain('/Users/jovyan/Library/Jupyter/runtime');
    expect(dirs).toContain('/Users/jovyan/.local/share/jupyter/runtime');
  });

  it('turns jpserver-*.json into a profile with a safe id and no visible token', async () => {
    const found = await discoverLocalServers({
      env: { JUPYTER_RUNTIME_DIR: '/rt' },
      home: '/home/jovyan',
      listDir: (dir) => (dir === '/rt' ? ['jpserver-42.json', 'nbserver-1.json', 'notes.txt'] : []),
      readFile: () => descriptor,
      runtimeDirCommand: async () => null
    });
    expect(found).toHaveLength(1);
    const entry = found[0]!;
    expect(entry.profile.id).toBe('local-8899');
    expect(entry.profile.apiBaseUrl).toBe('http://localhost:8899');
    expect(entry.profile.wsBaseUrl).toBe('ws://localhost:8899');
    expect(entry.rootDir).toBe('/home/jovyan/nb');
    // The token is a reference the process resolves; the descriptor is safe.
    expect(entry.profile.credentialRef).toBe('literal:runtime-secret');
    expect(JSON.stringify(describeServer(entry.profile))).not.toContain('runtime-secret');
  });

  it('ignores unreadable and malformed descriptors', async () => {
    const found = await discoverLocalServers({
      env: { JUPYTER_RUNTIME_DIR: '/rt' },
      listDir: () => ['jpserver-1.json', 'jpserver-2.json'],
      readFile: (path) => (path.endsWith('jpserver-1.json') ? 'not json' : '{"port": 1}'),
      runtimeDirCommand: async () => null
    });
    // The second parses but has no URL to dial.
    expect(found).toHaveLength(0);
  });

  it.each([
    'http://url-secret@localhost:8899/',
    'http://localhost:8899/?token=url-secret'
  ])('ignores a credential-bearing discovered URL', async (url) => {
    const found = await discoverLocalServers({
      env: { JUPYTER_RUNTIME_DIR: '/rt' },
      listDir: () => ['jpserver-1.json'],
      readFile: () => JSON.stringify({ url, port: 8899, token: 'runtime-secret' }),
      runtimeDirCommand: async () => null
    });
    expect(found).toEqual([]);
    expect(JSON.stringify(found)).not.toContain('url-secret');
  });

  it('adds the directory the Jupyter CLI reports', async () => {
    const found = await discoverLocalServers({
      env: {},
      listDir: (dir) => (dir === '/from-cli' ? ['jpserver-7.json'] : []),
      readFile: () => descriptor,
      runtimeDirCommand: async () => '/from-cli'
    });
    expect(found.map((entry) => entry.profile.id)).toEqual(['local-8899']);
  });
});

describe('ServerRegistry', () => {
  it('auto-selects the single configured server', async () => {
    const registry = new ServerRegistry(withDefaults({ servers: [PROFILE] }));
    const list = await registry.list();
    expect(list.servers).toHaveLength(1);
    expect(list.servers[0]?.defaultChoice).toBe(true);
    expect(list.selectionRequired).toBe(false);
    expect((await registry.select()).id).toBe('main');
  });

  it('SERVER_SELECTION_REQUIRED with two servers and no explicit id', async () => {
    const second: ServerProfile = { ...PROFILE, id: 'other', apiBaseUrl: 'http://127.0.0.1:9999' };
    const registry = new ServerRegistry(withDefaults({ servers: [PROFILE, second] }));
    const list = await registry.list();
    expect(list.selectionRequired).toBe(true);
    expect(list.servers.every((entry) => !entry.defaultChoice)).toBe(true);
    expect(await asyncCodeOf(() => registry.select())).toBe('SERVER_SELECTION_REQUIRED');
    expect((await registry.select('other')).id).toBe('other');
  });

  it('SERVER_NOT_FOUND for an unknown id and for an empty configuration', async () => {
    const registry = new ServerRegistry(withDefaults({ servers: [PROFILE] }));
    expect(await asyncCodeOf(() => registry.select('nope'))).toBe('SERVER_NOT_FOUND');
    const empty = new ServerRegistry(withDefaults({}));
    expect(await asyncCodeOf(() => empty.select())).toBe('SERVER_NOT_FOUND');
  });

  it('an explicit configuration disables the discovery fallback (SPEC.md §11)', async () => {
    let discovered = 0;
    const registry = new ServerRegistry(withDefaults({ servers: [PROFILE], discovery: true }), {
      discover: async () => {
        discovered += 1;
        return [{ ...PROFILE, id: 'local-1' }];
      }
    });
    const list = await registry.list();
    expect(list.servers.map((entry) => entry.descriptor.id)).toEqual(['main']);
    expect(list.discoveryEnabled).toBe(false);
    expect(discovered).toBe(0);
  });

  it('uses discovery only when nothing was configured', async () => {
    const registry = new ServerRegistry(withDefaults({ discovery: true }), {
      discover: async () => [{ ...PROFILE, id: 'local-8899' }]
    });
    const list = await registry.list();
    expect(list.discoveryEnabled).toBe(true);
    expect(list.servers[0]?.origin).toBe('discovered');
    expect(list.servers[0]?.descriptor.id).toBe('local-8899');
  });

  it('discovery runs at most once', async () => {
    let calls = 0;
    const registry = new ServerRegistry(withDefaults({ discovery: true }), {
      discover: async () => {
        calls += 1;
        return [];
      }
    });
    await Promise.all([registry.list(), registry.list(), registry.entries()]);
    expect(calls).toBe(1);
  });
});
