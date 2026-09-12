/**
 * Lifecycle helper for the disposable Jupyter stand in `dev/jupyter/`.
 *
 * The stand is the only server integration tests are allowed to touch. It is
 * started through `dev/jupyter/start.sh`, which:
 *   - waits until `GET /api/status` answers 200 with the token,
 *   - prints the base URL as its last stdout line,
 *   - refuses with **exit code 3** when its own PID file names a live process.
 *
 * Exit 3 is not a failure here: the caller reuses the running server and
 * {@link Stand.stop} becomes a no-op, because a test must never stop a server
 * it did not start. Every test that starts its own server must call `stop()`
 * (see `dev/jupyter/README.md`).
 *
 * Each test file uses its own assigned port; two files on one port would
 * silently share a Jupyter root and a `SERVER_SESSION`.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
/** Repository root: test/helpers -> test -> repo. */
export const REPO_ROOT = resolve(HERE, '..', '..');
/** Directory holding start.sh / stop.sh. */
export const STAND_DIR = resolve(REPO_ROOT, 'dev', 'jupyter');

/** Default token of the stand (`dev/jupyter/start.sh`). */
export const DEFAULT_TOKEN = 'devtoken';

export interface StartStandOptions {
  /** Port to use. Every test file has its own assigned port. */
  readonly port: number;
  /** Defaults to {@link DEFAULT_TOKEN}. */
  readonly token?: string;
  /** Contents root; defaults to the stand's `.runtime/<port>/root`. */
  readonly root?: string;
  /** Milliseconds to wait for start.sh. Default 120000; the script waits 90s. */
  readonly timeoutMs?: number;
}

export interface Stand {
  /** e.g. `http://127.0.0.1:8893`, no trailing slash. */
  readonly baseUrl: string;
  /** Same origin with the `ws` scheme, no trailing slash. */
  readonly wsUrl: string;
  readonly token: string;
  /** Absolute path of the Jupyter contents root. */
  readonly root: string;
  readonly port: number;
  /** `false` when the server was already running and we merely reused it. */
  readonly owned: boolean;
  /** Runs stop.sh, but only for a server this call started. Idempotent. */
  stop(): Promise<void>;
}

interface ScriptRun {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

function runScript(
  script: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number
): Promise<ScriptRun> {
  return new Promise<ScriptRun>((resolvePromise, rejectPromise) => {
    const child = spawn(resolve(STAND_DIR, script), [], {
      cwd: STAND_DIR,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      rejectPromise(
        new Error(`${script} timed out after ${timeoutMs}ms\nstdout:\n${stdout}\nstderr:\n${stderr}`)
      );
    }, timeoutMs);
    timer.unref?.();

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      rejectPromise(error);
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise({ code, stdout, stderr });
    });
  });
}

/** Last stdout line that looks like an http(s) URL; start.sh prints one. */
function parseBaseUrl(stdout: string): string | null {
  const lines = stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i]!;
    if (/^https?:\/\/\S+$/.test(line)) return line.replace(/\/+$/, '');
  }
  return null;
}

/** `root     : /abs/path` line printed by start.sh. */
function parseRoot(stdout: string): string | null {
  const match = /^root\s*:\s*(.+)$/m.exec(stdout);
  return match ? match[1]!.trim() : null;
}

function defaultRoot(port: number): string {
  return resolve(STAND_DIR, '.runtime', String(port), 'root');
}

function toWs(baseUrl: string): string {
  return baseUrl.replace(/^http/, 'ws');
}

async function stopScript(port: number, timeoutMs: number): Promise<void> {
  const run = await runScript('stop.sh', { PORT: String(port) }, timeoutMs);
  if (run.code !== 0) {
    throw new Error(`stop.sh exited ${run.code}\nstdout:\n${run.stdout}\nstderr:\n${run.stderr}`);
  }
}

/**
 * Start (or reuse) the stand on `port`.
 *
 * @throws when start.sh fails for any reason other than exit 3.
 */
export async function startStand(options: StartStandOptions): Promise<Stand> {
  const { port } = options;
  const token = options.token ?? DEFAULT_TOKEN;
  const timeoutMs = options.timeoutMs ?? 120_000;

  if (!existsSync(resolve(STAND_DIR, 'start.sh'))) {
    throw new Error(`stand not found at ${STAND_DIR}; see dev/jupyter/README.md`);
  }

  const env: NodeJS.ProcessEnv = { PORT: String(port), TOKEN: token };
  if (options.root !== undefined) env['ROOT'] = options.root;

  const run = await runScript('start.sh', env, timeoutMs);

  // Exit 3: a live server already owns this port. Reuse it, never stop it.
  if (run.code === 3) {
    const baseUrl = `http://127.0.0.1:${port}`;
    return makeStand({
      baseUrl,
      token,
      root: options.root ?? defaultRoot(port),
      port,
      owned: false,
      timeoutMs
    });
  }

  if (run.code !== 0) {
    throw new Error(
      `start.sh exited ${run.code}\nstdout:\n${run.stdout}\nstderr:\n${run.stderr}`
    );
  }

  const baseUrl = parseBaseUrl(run.stdout);
  if (baseUrl === null) {
    throw new Error(`start.sh printed no base URL\nstdout:\n${run.stdout}\nstderr:\n${run.stderr}`);
  }

  return makeStand({
    baseUrl,
    token,
    root: options.root ?? parseRoot(run.stdout) ?? defaultRoot(port),
    port,
    owned: true,
    timeoutMs
  });
}

/**
 * Stop whatever runs on `port` and start a fresh server (`RESTART=1`).
 *
 * Use it when a test needs a *new* `SERVER_SESSION` - the server-wide
 * collaboration `sessionId` changes only when the Jupyter process restarts
 * (spike/NOTES.md §3.7). The returned stand always owns its server.
 */
export async function restartStand(options: StartStandOptions): Promise<Stand> {
  const { port } = options;
  const token = options.token ?? DEFAULT_TOKEN;
  const timeoutMs = options.timeoutMs ?? 120_000;

  const env: NodeJS.ProcessEnv = { PORT: String(port), TOKEN: token, RESTART: '1' };
  if (options.root !== undefined) env['ROOT'] = options.root;

  const run = await runScript('start.sh', env, timeoutMs);
  if (run.code !== 0) {
    throw new Error(
      `start.sh RESTART=1 exited ${run.code}\nstdout:\n${run.stdout}\nstderr:\n${run.stderr}`
    );
  }
  const baseUrl = parseBaseUrl(run.stdout);
  if (baseUrl === null) {
    throw new Error(`start.sh printed no base URL\nstdout:\n${run.stdout}\nstderr:\n${run.stderr}`);
  }
  return makeStand({
    baseUrl,
    token,
    root: options.root ?? parseRoot(run.stdout) ?? defaultRoot(port),
    port,
    owned: true,
    timeoutMs
  });
}

function makeStand(init: {
  baseUrl: string;
  token: string;
  root: string;
  port: number;
  owned: boolean;
  timeoutMs: number;
}): Stand {
  let stopped = false;
  return {
    baseUrl: init.baseUrl,
    wsUrl: toWs(init.baseUrl),
    token: init.token,
    root: init.root,
    port: init.port,
    owned: init.owned,
    async stop(): Promise<void> {
      if (!init.owned || stopped) return;
      stopped = true;
      await stopScript(init.port, init.timeoutMs);
    }
  };
}
