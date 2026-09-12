/**
 * Local Jupyter runtime discovery (SPEC.md §11).
 *
 * A Jupyter Server writes `jpserver-<pid>.json` into its runtime directory:
 * `{"url", "port", "token", "root_dir", ...}`. Reading those descriptors is
 * the one way this process may learn about a server nobody configured.
 *
 * Two rules from SPEC.md §11 shape the module:
 *
 * - discovery returns **URLs, the root and safe identifiers only**. The token
 *   found in a descriptor stays internal: it becomes a `literal:` credential
 *   reference that never leaves the process and is never part of
 *   {@link ServerDescriptor};
 * - an explicit configuration is never silently replaced by a local server -
 *   enforced one level up, in `ServerRegistry`, which consults discovery only
 *   when no profile is configured.
 *
 * Nothing here is pinged: a descriptor of a dead server is a descriptor whose
 * reachability is unknown, not an error (`server_list` says as much).
 *
 * @module
 */

import { execFile } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import type { ServerProfile } from '../core/index.js';
import { deriveWsBaseUrl, normalizeBaseUrl } from '../jupyter/paths.js';

/** Injection points; the defaults touch the real filesystem. */
export interface DiscoveryEnvironment {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly platform?: NodeJS.Platform;
  readonly home?: string;
  readonly listDir?: (dir: string) => readonly string[];
  readonly readFile?: (path: string) => string;
  /** `jupyter --runtime-dir`; `null` when the CLI is absent or too slow. */
  readonly runtimeDirCommand?: () => Promise<string | null>;
}

/** One descriptor, already reduced to what a profile needs. */
export interface DiscoveredServer {
  readonly profile: ServerProfile;
  /** Contents root the server reported, for diagnostics only. */
  readonly rootDir: string | null;
  /** File the descriptor came from. */
  readonly source: string;
}

interface RuntimeDescriptor {
  url?: string;
  port?: number;
  token?: string;
  root_dir?: string;
  base_url?: string;
  hostname?: string;
  secure?: boolean;
  sock?: string;
}

/** Ask the Jupyter CLI for its runtime directory; never throws. */
export function jupyterRuntimeDir(timeoutMs = 3000): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      execFile(
        'jupyter',
        ['--runtime-dir'],
        { timeout: timeoutMs, windowsHide: true },
        (error, stdout) => {
          if (error) {
            resolve(null);
            return;
          }
          const value = stdout.trim();
          resolve(value.length > 0 ? value : null);
        }
      );
    } catch {
      resolve(null);
    }
  });
}

/**
 * Directories that may hold `jpserver-*.json`, most specific first.
 *
 * `JUPYTER_RUNTIME_DIR` wins; then the platform data directories macOS and
 * Linux use. The `jupyter --runtime-dir` answer is added by
 * {@link discoverLocalServers}, which may await it.
 */
export function runtimeDirCandidates(environment: DiscoveryEnvironment = {}): readonly string[] {
  const env = environment.env ?? process.env;
  const platform = environment.platform ?? process.platform;
  const home = environment.home ?? homedir();
  const dirs: string[] = [];
  const push = (dir: string | undefined): void => {
    if (dir !== undefined && dir !== '' && !dirs.includes(dir)) dirs.push(dir);
  };

  push(env['JUPYTER_RUNTIME_DIR']);
  const xdgData = env['XDG_DATA_HOME'];
  if (platform === 'darwin') {
    push(join(home, 'Library', 'Jupyter', 'runtime'));
  }
  push(xdgData === undefined || xdgData === '' ? undefined : join(xdgData, 'jupyter', 'runtime'));
  push(join(home, '.local', 'share', 'jupyter', 'runtime'));
  const xdgRuntime = env['XDG_RUNTIME_DIR'];
  push(xdgRuntime === undefined || xdgRuntime === '' ? undefined : join(xdgRuntime, 'jupyter'));
  return dirs;
}

/**
 * Read every readable `jpserver-*.json` and turn it into a profile.
 *
 * The generated `id` is `local-<port>` (falling back to the file name), which
 * is a safe identifier: it carries neither a token nor a user name. Duplicate
 * URLs collapse to the first descriptor found.
 */
export async function discoverLocalServers(
  environment: DiscoveryEnvironment = {}
): Promise<readonly DiscoveredServer[]> {
  const listDir = environment.listDir ?? ((dir: string) => readdirSync(dir));
  const readFile = environment.readFile ?? ((path: string) => readFileSync(path, 'utf8'));
  const runtimeDirCommand = environment.runtimeDirCommand ?? (() => jupyterRuntimeDir());

  const dirs = [...runtimeDirCandidates(environment)];
  const fromCli = await runtimeDirCommand();
  if (fromCli !== null && !dirs.includes(fromCli)) dirs.unshift(fromCli);

  const byUrl = new Map<string, DiscoveredServer>();
  for (const dir of dirs) {
    let names: readonly string[];
    try {
      names = listDir(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.startsWith('jpserver-') || !name.endsWith('.json')) continue;
      const file = join(dir, name);
      let descriptor: RuntimeDescriptor;
      try {
        descriptor = JSON.parse(readFile(file)) as RuntimeDescriptor;
      } catch {
        continue;
      }
      const server = toProfile(descriptor, name, file);
      if (server === null) continue;
      if (byUrl.has(server.profile.apiBaseUrl)) continue;
      byUrl.set(server.profile.apiBaseUrl, server);
    }
  }
  return [...byUrl.values()];
}

function toProfile(
  descriptor: RuntimeDescriptor,
  fileName: string,
  file: string
): DiscoveredServer | null {
  // A `sock`-only server has no URL this client can dial.
  if (typeof descriptor.url !== 'string' || descriptor.url.length === 0) return null;
  let apiBaseUrl: string;
  try {
    apiBaseUrl = normalizeBaseUrl(new URL(descriptor.url).toString());
  } catch {
    return null;
  }
  const port = typeof descriptor.port === 'number' ? descriptor.port : null;
  const id = port === null ? `local-${fileName.replace(/\.json$/, '')}` : `local-${port}`;
  const token = typeof descriptor.token === 'string' ? descriptor.token : '';
  return {
    profile: {
      id,
      kind: 'standalone',
      apiBaseUrl,
      wsBaseUrl: deriveWsBaseUrl(apiBaseUrl),
      browserBaseUrl: apiBaseUrl,
      // The token never leaves the process: it is held as a reference the
      // resolver understands, and `server_list` returns the descriptor only.
      credentialRef: `literal:${token}`
    },
    rootDir: typeof descriptor.root_dir === 'string' ? descriptor.root_dir : null,
    source: file
  };
}
