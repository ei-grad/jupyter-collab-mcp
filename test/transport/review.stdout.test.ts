/**
 * Adversarial review of `src/jupyter/stdout-guard.ts` and of the transport's
 * behaviour as a whole process (SPEC.md §11, §12 "Cleanup and credentials").
 *
 * Both cases run in a real child process: the guard is process-wide and a
 * handle leak is only visible in a process that is allowed to exit by itself.
 */
import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..');
const TSX = resolve(REPO_ROOT, 'node_modules', '.bin', 'tsx');

interface Run {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
}

function runFixture(file: string, killAfterMs: number): Promise<Run> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(TSX, [resolve(HERE, 'fixtures', file)], {
      cwd: REPO_ROOT,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, killAfterMs);
    child.on('error', rejectPromise);
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolvePromise({ code, signal, stdout, stderr, timedOut });
    });
  });
}

describe('FINDING: console.dir / console.dirxml bypass the stdout guard', () => {
  it('SPEC.md §11: "In stdio mode, stdout is reserved for MCP"', async () => {
    const run = await runFixture('console-holes.ts', 30_000);

    expect(run.code).toBe(0);
    // console.log/info/debug/table/group/count are all routed through
    // `console.log` and land on stderr; `dir` and `dirxml` write to the stdout
    // stream directly (node:internal/console/constructor kWriteToConsole), so
    // they corrupt the MCP frame stream and are not redacted either.
    expect(run.stdout).toBe('');
    expect(run.stdout).not.toContain('SUPERSECRET');
  }, 60_000);
});

describe('SPEC.md §12 "Cleanup and credentials": a whole RTC lifecycle in one process', () => {
  it('prints nothing on stdout, no token anywhere, and exits without process.exit()', async () => {
    const run = await runFixture('lifecycle-silence.ts', 40_000);

    expect(run.stderr).toContain('MARKER-DONE');
    expect(run.stderr).toContain('save=success');
    expect(run.stderr).toContain('generation=2');
    expect(run.stderr).toContain('terminal=RTC_SESSION_REJECTED');
    // SPEC.md §11: startup, reconnect and the failure path must not print the
    // credential on any stream.
    expect(run.stdout).toBe('');
    expect(run.stderr).not.toContain('LIFECYCLE-TOKEN-abc123');
    // SPEC.md §4: dispose() frees the sockets/timers, so nothing keeps the
    // event loop alive.
    expect(run.timedOut).toBe(false);
    expect(run.code).toBe(0);
  }, 60_000);
});
