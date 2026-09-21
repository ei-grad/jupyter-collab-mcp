import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { isCoreError } from '../../src/core/index.js';
import { CLI_USAGE, loadCliConfig, runMainCli } from '../../src/mcp/index.js';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const CLI = join(ROOT, 'src/mcp/cli.ts');
const FAKE = join(ROOT, 'test/mcp/fake-service.ts');
const PACKAGE_VERSION = (
  JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { version: string }
).version;

describe('loadCliConfig', () => {
  it('builds the implicit "default" profile from JUPYTER_URL + JUPYTER_TOKEN', () => {
    const loaded = loadCliConfig([], { JUPYTER_URL: 'http://127.0.0.1:8888/', JUPYTER_TOKEN: 'devtoken' });
    expect(loaded.config.servers).toEqual([
      { id: 'default', kind: 'standalone', apiBaseUrl: 'http://127.0.0.1:8888', credentialRef: 'env:JUPYTER_TOKEN' }
    ]);
    expect(loaded.config.discovery).toBe(false);
    expect(loaded.logLevel).toBe('warn');
  });

  it('references a token file instead of reading it', () => {
    const loaded = loadCliConfig([], { JUPYTER_URL: 'http://h:1', JUPYTER_TOKEN_FILE: '/run/secrets/tok' });
    expect(loaded.config.servers[0]?.credentialRef).toBe('file:/run/secrets/tok');
  });

  it('refuses a URL without any credential reference', () => {
    expect(() => loadCliConfig([], { JUPYTER_URL: 'http://h:1' })).toThrow(/JUPYTER_TOKEN/u);
  });

  it('refuses a process with neither a profile nor discovery', () => {
    try {
      loadCliConfig([], {});
      expect.unreachable('should have thrown');
    } catch (thrown) {
      expect(isCoreError(thrown) && thrown.code).toBe('INVALID_ARGUMENT');
    }
  });

  it('accepts --discover with no profile at all', () => {
    const loaded = loadCliConfig(['--discover'], {});
    expect(loaded.config.discovery).toBe(true);
    expect(loaded.config.servers).toEqual([]);
  });

  it('takes profiles and limits from --config and keeps the awareness overrides', () => {
    const dir = mkdtempSync(join(tmpdir(), 'jcm-cli-'));
    const file = join(dir, 'config.json');
    writeFileSync(
      file,
      JSON.stringify({
        servers: [{ id: 'lab', kind: 'standalone', apiBaseUrl: 'http://lab:8888', credentialRef: 'env:LAB_TOKEN' }],
        limits: { responseMaxBytes: 4096 }
      })
    );
    const loaded = loadCliConfig(['--config', file, '--user-name', 'Ada', '--user-color', '#ff0000'], {});
    expect(loaded.config.servers.map((profile) => profile.id)).toEqual(['lab']);
    expect(loaded.config.limits.responseMaxBytes).toBe(4096);
    expect(loaded.config.limits.summaryMaxCells).toBe(100);
    expect(loaded.config.awarenessUser).toEqual({ name: 'Ada', color: '#ff0000' });
  });

  it('rejects an unknown flag and a bad log level', () => {
    expect(() => loadCliConfig(['--nope'], {})).toThrow(/unknown option/u);
    expect(() => loadCliConfig(['--log-level', 'loud'], {})).toThrow(/--log-level/u);
  });

  it('returns the usage text for --help without needing a server', () => {
    const loaded = loadCliConfig(['--help'], {});
    expect(loaded.exit).toEqual({ text: CLI_USAGE, code: 0 });
  });
});

/** Minimal JSON-RPC conversation over the child's stdio. */
async function converse(requests: unknown[], timeoutMs = 25_000): Promise<{ stdout: string; stderr: string }> {
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(ROOT, 'node_modules/tsx/dist/cli.mjs'), CLI, '--log-level', 'debug'], {
      cwd: ROOT,
      env: {
        ...process.env,
        JUPYTER_URL: 'http://127.0.0.1:8888',
        JUPYTER_TOKEN: 'devtoken',
        JUPYTER_COLLAB_MCP_SERVICE_MODULE: FAKE
      },
      stdio: ['pipe', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    let seen = 0;
    const finish = (): void => {
      clearTimeout(timer);
      // SIGTERM must reach service.shutdown before the process ends.
      child.once('close', () => resolve({ stdout, stderr }));
      child.kill('SIGTERM');
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`timed out; stdout=${stdout} stderr=${stderr}`));
    }, timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
      seen = stdout.split('\n').filter((line) => line.trim() !== '').length;
      if (seen >= requests.filter((request) => (request as { id?: unknown }).id !== undefined).length) finish();
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('error', reject);
    // The 2025-era opening is served by the same factory (serveStdio legacy:
    // 'serve'), and is far easier to hand-write than the modern handshake.
    for (const request of requests) child.stdin.write(`${JSON.stringify(request)}\n`);
  });
}

describe('the cli child process', () => {
  it('runs when invoked through an installed-package bin symlink', () => {
    const directory = mkdtempSync(join(tmpdir(), 'jcm-bin-'));
    const executable = join(directory, 'jupyter-collab-mcp');
    symlinkSync(CLI, executable);
    try {
      const run = spawnSync(
        process.execPath,
        [join(ROOT, 'node_modules/tsx/dist/cli.mjs'), executable, '--version'],
        { cwd: ROOT, encoding: 'utf8' }
      );
      expect(run.status).toBe(0);
      expect(run.stdout).toBe('');
      expect(run.stderr.trim()).toBe(PACKAGE_VERSION);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('reports the declared version with --http without loading HTTP configuration', () => {
    const run = spawnSync(
      process.execPath,
      [join(ROOT, 'node_modules/tsx/dist/cli.mjs'), CLI, '--http', '--version'],
      { cwd: ROOT, encoding: 'utf8' }
    );
    expect(run.status).toBe(0);
    expect(run.stdout).toBe('');
    expect(run.stderr.trim()).toBe(PACKAGE_VERSION);
  });

  it('dispatches --http through the HTTP runtime seam', async () => {
    let started = 0;
    let closed = 0;
    const handle = await runMainCli({
      argv: ['--http'],
      env: {},
      installSignalHandlers: false,
      stderr: { write: () => true } as unknown as NodeJS.WritableStream,
      startHttp: async () => {
        started++;
        return {
          close: async () => {
            closed++;
          }
        };
      }
    });
    expect(started).toBe(1);
    await handle.close();
    expect(closed).toBe(1);
  });

  it(
    'writes JSON-RPC and nothing else to stdout, and diagnostics to stderr',
    async () => {
      const { stdout, stderr } = await converse([
        {
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'raw', version: '0' } }
        },
        { jsonrpc: '2.0', method: 'notifications/initialized' },
        { jsonrpc: '2.0', id: 2, method: 'tools/list' },
        { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'server_list', arguments: {} } }
      ]);

      const lines = stdout.split('\n').filter((line) => line.trim() !== '');
      expect(lines.length).toBeGreaterThanOrEqual(3);
      for (const line of lines) {
        const parsed = JSON.parse(line) as { jsonrpc?: string };
        expect(parsed.jsonrpc).toBe('2.0');
      }
      const answers = lines.map((line) => JSON.parse(line) as { id?: number; result?: Record<string, unknown> });
      expect(answers.find((answer) => answer.id === 1)?.result?.['serverInfo']).toMatchObject({ version: PACKAGE_VERSION });
      const tools = answers.find((answer) => answer.id === 2)?.result?.['tools'] as { name: string }[];
      expect(tools).toHaveLength(18);
      const call = answers.find((answer) => answer.id === 3)?.result as { structuredContent?: Record<string, unknown> };
      expect(call.structuredContent?.['servers']).toBeDefined();

      expect(stderr).toContain('[info]');
      expect(stderr).not.toContain('{"jsonrpc"');
      // The stdout guard was installed before the service was built…
      expect(stdout).not.toContain('noise a dependency writes to stdout');
      expect(stderr).toContain('noise a dependency writes to stdout');
      // …and SIGTERM reached CollabService.shutdown.
      expect(stderr).toContain('[fake] shutdown signal');
    },
    30_000
  );
});
