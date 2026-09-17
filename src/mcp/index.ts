/**
 * MCP adapter (SPEC.md §9).
 *
 * `src/core/service.ts` defines the contract; this module owns the canonical
 * stdio adapter. The hosted gateway proxies MCP without moving protocol
 * concerns below `src/core/`, so the core remains usable independently
 * (SPEC.md §1).
 *
 * - `schemas.ts` - the snake_case input/output schemas of the 18 tools;
 * - `wire.ts`    - camelCase <-> snake_case and the response-size budget;
 * - `server.ts`  - `createMcpServer(service, options)`;
 * - `cli.ts`     - the `jupyter-collab-mcp` stdio entry point.
 *
 * @module
 */

export { createMcpServer, renderText, toWireError, ERROR_META_KEY, OUTPUT_URI_TEMPLATE } from './server.js';
export type { LogLevel, McpServerOptions, WireError } from './server.js';

export { TOOL_SPECS, TOOL_SPECS_BY_NAME, DEDUPLICATED_TOOLS } from './schemas.js';
export type { JsonSchema, ToolSpec } from './schemas.js';

export {
  DEFAULT_RESPONSE_MAX_BYTES,
  OPAQUE_KEYS,
  boundPayload,
  boundText,
  camelKey,
  fromWire,
  jsonByteSize,
  snakeKey,
  toWire,
  WireBudgetError
} from './wire.js';
export type { BoundedPayload, WireObject, WireValue } from './wire.js';

export { CLI_USAGE, loadCliConfig, runCli, runMainCli } from './cli.js';
export type { CliOptions, CliResult, LoadedCliConfig, MainCliOptions } from './cli.js';
