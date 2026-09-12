import { defineConfig } from 'vitest/config';

/**
 * Two projects, one for each cost class:
 *
 *   unit - everything except `*.int.test.ts`; 10s timeout, no external server.
 *   int  - `*.int.test.ts`; 60s timeout, because these start the Jupyter stand
 *          in `dev/jupyter/` (start.sh alone waits up to 90s for
 *          `GET /api/status`, so hooks that start it pass their own timeout).
 *
 * Both run in plain Node: the whole point is that the RTC client works with
 * no DOM. Integration files run single-file-at-a-time so two of them cannot
 * fight over the same port; each file still owns a distinct assigned port.
 */
const shared = {
  environment: 'node' as const,
  globals: false
};

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          ...shared,
          name: 'unit',
          include: ['test/**/*.test.ts'],
          exclude: ['**/node_modules/**', '**/dist/**', '**/*.int.test.ts'],
          testTimeout: 10_000,
          hookTimeout: 10_000
        }
      },
      {
        test: {
          ...shared,
          name: 'int',
          include: ['test/**/*.int.test.ts'],
          exclude: ['**/node_modules/**', '**/dist/**'],
          testTimeout: 60_000,
          hookTimeout: 120_000,
          fileParallelism: false
        }
      }
    ]
  }
});
