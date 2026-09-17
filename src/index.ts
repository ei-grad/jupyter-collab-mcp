/**
 * jupyter-collab-mcp - public entry point.
 *
 * Re-exports the five modules the package is made of, so a consumer imports
 * from the package root and never from a file path:
 *
 * - `core`            - contracts, errors, revisions, cursors, the
 *                       `CollabService` facade and its configuration;
 * - `core/notebook`   - the shared notebook model over `@jupyter/ydoc`;
 * - `jupyter`         - HTTP client, RTC connection and the stdout guard;
 * - `kernel`          - kernel messaging, the output reducer and job queue;
 * - `service`         - the stateful `CollabService` implementation;
 * - `mcp`             - the MCP stdio adapter over `CollabService`.
 *
 * The layering of SPEC.md §1 still holds: `core` knows nothing about MCP, and
 * everything below `mcp` works without it.
 *
 * @module
 */

export * from './core/index.js';
export * from './core/notebook/index.js';
export * from './jupyter/index.js';
export * from './kernel/index.js';
export { createCollabService, DEFAULT_OUTPUT_STORE_BYTES } from './service/index.js';
export type { CollabServiceOptions } from './service/index.js';
export * from './mcp/index.js';

/**
 * `AwarenessUser` exists twice: the configured identity in `src/core/config.ts`
 * and the transport-level shape `src/jupyter/rtc-connection.ts` publishes.
 * The configured one keeps the plain name.
 */
export type { AwarenessUser } from './core/config.js';
export type { AwarenessUser as RtcAwarenessUser } from './jupyter/index.js';
