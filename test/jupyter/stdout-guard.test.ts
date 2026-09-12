/**
 * SPEC.md §11: in stdio transport stdout carries MCP frames only.
 *
 * The guard is process-wide, so it is tested in child processes: the assertion
 * is on the real stdout/stderr of a `tsx` run, not on a stubbed console.
 */
import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { installStdoutGuard, isStdoutGuardInstalled } from '../../src/jupyter/stdout-guard.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..');
const TSX = resolve(REPO_ROOT, 'node_modules', '.bin', 'tsx');

interface Run {
  code: number | null;
  stdout: string;
  stderr: string;
}

function runFixture(file: string, env: NodeJS.ProcessEnv = {}): Promise<Run> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(TSX, [resolve(HERE, 'fixtures', file)], {
      cwd: REPO_ROOT,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('error', rejectPromise);
    child.on('close', (code) => resolvePromise({ code, stdout, stderr }));
  });
}

describe('installStdoutGuard', () => {
  it('keeps console.log/info/debug off stdout and redacts tokens', async () => {
    const run = await runFixture('guarded-console.ts');

    expect(run.code).toBe(0);
    // Only what the fixture wrote to stdout itself, plus the line printed after
    // the guard was restored.
    expect(run.stdout).toBe('MARKER-GUARDED\nMARKER-RESTORED\n');

    expect(run.stderr).toContain('[console] log-line');
    expect(run.stderr).toContain('[console] info-line');
    expect(run.stderr).toContain('[console] Starting WebSocket:');
    // console.error/warn are already on stderr and stay unwrapped.
    expect(run.stderr).toContain('\nerror-line');
    expect(run.stderr).toContain('\nwarn-line');
    // SPEC.md §11: a WS URL that carries the token must be redacted.
    expect(run.stderr).not.toContain('supersecret');
    expect(run.stderr).toContain('token=<redacted>');
  }, 30_000);

  it('silences the console.debug that @jupyterlab/services emits', async () => {
    const guarded = await runFixture('guarded-kernel.ts');
    expect(guarded.code).toBe(0);
    expect(guarded.stdout).toBe('MARKER-KERNEL\n');
    expect(guarded.stderr).toContain('Starting WebSocket:');
  }, 30_000);

  it('control run without the guard does write to stdout', async () => {
    // spike/NOTES.md §3.4: this is the behaviour the guard exists for.
    const control = await runFixture('guarded-kernel.ts', { GUARD: '0' });
    expect(control.code).toBe(0);
    expect(control.stdout).toContain('Starting WebSocket:');
  }, 30_000);

  it('is idempotent and restorable in-process', () => {
    expect(isStdoutGuardInstalled()).toBe(false);
    const lines: string[] = [];
    const stream = {
      write(chunk: string): boolean {
        lines.push(chunk);
        return true;
      }
    } as unknown as NodeJS.WritableStream;

    const original = console.log;
    const restore = installStdoutGuard({ stream, prefix: '> ' });
    const restoreAgain = installStdoutGuard({ stream, prefix: 'IGNORED ' });
    expect(restoreAgain).toBe(restore);
    expect(isStdoutGuardInstalled()).toBe(true);

    console.log('hello %s', 'world');
    expect(lines).toEqual(['> hello world\n']);

    restore();
    restore(); // idempotent
    expect(isStdoutGuardInstalled()).toBe(false);
    expect(console.log).toBe(original);
  });
});
