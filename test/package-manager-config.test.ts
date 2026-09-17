import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

describe('package manager configuration', () => {
  it('gives clean installs permission to build esbuild', () => {
    const packageJson = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8')
    ) as Record<string, unknown>;
    const projectRoot = fileURLToPath(new URL('..', import.meta.url));
    const allowBuilds = JSON.parse(
      execFileSync('pnpm', ['config', 'get', 'allowBuilds', '--json'], {
        cwd: projectRoot,
        encoding: 'utf8'
      })
    ) as Record<string, unknown>;

    expect(packageJson.packageManager).toMatch(/^pnpm@\d+\.\d+\.\d+$/);
    expect(packageJson.bin).toEqual({
      'jupyter-collab-mcp': 'dist/mcp/cli.js'
    });
    expect(allowBuilds['esbuild']).toBe(true);
  });
});
