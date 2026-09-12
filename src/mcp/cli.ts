#!/usr/bin/env node
/**
 * `jupyter-collab-mcp` - the MCP stdio entry point (SPEC.md §9, §11).
 *
 * Order of operations matters and is fixed here:
 *
 * 1. {@link installStdoutGuard} runs **first**, before any transport object
 *    exists. `@jupyterlab/services` writes `console.debug('Starting
 *    WebSocket: <url>')`, and Node sends `console.debug` to stdout - which in
 *    stdio MCP carries JSON-RPC frames only (SPEC.md §11).
 * 2. the configuration is read from flags and environment; a token is never a
 *    tool argument and never appears in a message, a log line or a URI;
 * 3. the {@link CollabService} implementation is created;
 * 4. `serveStdio` owns the connection. It, not `server.connect`, is what
 *    selects the 2026-07-28 protocol era (docs/SERVICE-DESIGN.md §7.5 item 1).
 *
 * Every diagnostic goes to stderr. Nothing but MCP is ever written to stdout.
 *
 * @module
 */

import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { readFileSync } from 'node:fs';
import { isAbsolute, resolve as resolvePath } from 'node:path';

import type { CollabService, ServerProfile, ServiceConfig, ServiceConfigInput, ShutdownReason } from '../core/index.js';
import { coreError, redactCredentials, toCoreError, withDefaults } from '../core/index.js';

/** Log levels of the stderr diagnostics, from quietest to loudest. */
const LEVELS = ['silent', 'error', 'warn', 'info', 'debug'] as const;
type Level = (typeof LEVELS)[number];

/** `--help` text. Also the documentation of the environment contract. */
export const CLI_USAGE = `jupyter-collab-mcp - MCP server for live JupyterLab notebooks over RTC

Usage: jupyter-collab-mcp [options]

Options:
  --config <file.json>   Full configuration: {servers, discovery, limits, awarenessUser}.
  --discover             Allow servers found in the local Jupyter runtime directory.
  --user-name <name>     Awareness display name shown in JupyterLab.
  --user-color <#rrggbb> Awareness colour.
  --log-level <level>    silent | error | warn | info | debug (default: warn). stderr only.
  --version              Print the version and exit.
  --help                 Print this text and exit.

Environment:
  JUPYTER_URL            Server API base URL; becomes the implicit profile "default".
  JUPYTER_TOKEN          Token for that profile.
  JUPYTER_TOKEN_FILE     File holding the token, used when JUPYTER_TOKEN is unset.

The token is never printed, never part of a tool argument and never part of a
resource URI. stdout carries MCP frames only; all diagnostics go to stderr.`;

// ---------------------------------------------------------------------------
// configuration
// ---------------------------------------------------------------------------

/** What {@link loadCliConfig} produced. */
export interface LoadedCliConfig {
  readonly config: ServiceConfig;
  readonly logLevel: Level;
  /** Set when the process should print something and exit without serving. */
  readonly exit?: { readonly text: string; readonly code: number };
}

function requireValue(flag: string, value: string | undefined): string {
  if (value === undefined) throw coreError('INVALID_ARGUMENT', `${flag} needs a value`);
  return value;
}

function packageVersion(): string {
  try {
    const require = createRequire(import.meta.url);
    const pkg = require('../../package.json') as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/**
 * Build the service configuration from flags and environment.
 *
 * `JUPYTER_URL` plus `JUPYTER_TOKEN` (or `JUPYTER_TOKEN_FILE`) form one
 * implicit profile called `default`, which is the single-server case
 * `session_open` may pick without a `server_id` (SPEC.md §6 item 1). A `--config`
 * file may declare more; the implicit profile is appended only when the file
 * does not already define an id `default`.
 */
export function loadCliConfig(argv: readonly string[], env: NodeJS.ProcessEnv): LoadedCliConfig {
  let logLevel: Level = 'warn';
  let discovery = false;
  let userName: string | undefined;
  let userColor: string | undefined;
  let fileInput: ServiceConfigInput = {};

  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    switch (flag) {
      case '--help':
      case '-h':
        return { config: withDefaults({}), logLevel, exit: { text: CLI_USAGE, code: 0 } };
      case '--version':
        return { config: withDefaults({}), logLevel, exit: { text: packageVersion(), code: 0 } };
      case '--config': {
        const path = requireValue('--config', argv[++index]);
        const absolute = isAbsolute(path) ? path : resolvePath(process.cwd(), path);
        let parsed: unknown;
        try {
          parsed = JSON.parse(readFileSync(absolute, 'utf8'));
        } catch (thrown) {
          throw coreError('INVALID_ARGUMENT', `cannot read --config ${path}: ${toCoreError(thrown).message}`);
        }
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
          throw coreError('INVALID_ARGUMENT', `--config ${path} must contain a JSON object`);
        }
        fileInput = parsed as ServiceConfigInput;
        break;
      }
      case '--discover':
        discovery = true;
        break;
      case '--user-name':
        userName = requireValue('--user-name', argv[++index]);
        break;
      case '--user-color':
        userColor = requireValue('--user-color', argv[++index]);
        break;
      case '--log-level': {
        const value = requireValue('--log-level', argv[++index]);
        if (!(LEVELS as readonly string[]).includes(value)) {
          throw coreError('INVALID_ARGUMENT', `--log-level must be one of ${LEVELS.join(', ')}`);
        }
        logLevel = value as Level;
        break;
      }
      default:
        throw coreError('INVALID_ARGUMENT', `unknown option ${String(flag)} (try --help)`);
    }
  }

  const servers: ServerProfile[] = [...(fileInput.servers ?? [])];
  const implicit = implicitProfile(env);
  if (implicit !== undefined && !servers.some((profile) => profile.id === implicit.id)) servers.push(implicit);

  const config = withDefaults({
    ...fileInput,
    servers,
    discovery: discovery || (fileInput.discovery ?? false),
    ...(userName === undefined && userColor === undefined
      ? {}
      : {
          awarenessUser: {
            ...fileInput.awarenessUser,
            ...(userName === undefined ? {} : { name: userName }),
            ...(userColor === undefined ? {} : { color: userColor })
          }
        })
  });

  if (config.servers.length === 0 && !config.discovery) {
    throw coreError(
      'INVALID_ARGUMENT',
      'no server configured: set JUPYTER_URL and JUPYTER_TOKEN (or JUPYTER_TOKEN_FILE), pass --config, or allow --discover'
    );
  }
  return { config, logLevel };
}

function implicitProfile(env: NodeJS.ProcessEnv): ServerProfile | undefined {
  const url = env['JUPYTER_URL'];
  if (url === undefined || url.trim() === '') return undefined;
  const tokenFile = env['JUPYTER_TOKEN_FILE'];
  const credentialRef =
    env['JUPYTER_TOKEN'] !== undefined && env['JUPYTER_TOKEN'] !== ''
      ? ('env:JUPYTER_TOKEN' as const)
      : tokenFile !== undefined && tokenFile !== ''
        ? (`file:${tokenFile}` as const)
        : undefined;
  if (credentialRef === undefined) {
    throw coreError('INVALID_ARGUMENT', 'JUPYTER_URL is set but neither JUPYTER_TOKEN nor JUPYTER_TOKEN_FILE is');
  }
  return {
    id: 'default',
    kind: 'standalone',
    apiBaseUrl: url.replace(/\/+$/u, ''),
    credentialRef
  };
}

// ---------------------------------------------------------------------------
// running
// ---------------------------------------------------------------------------

/** Options of {@link runCli}. Everything has a process-level default. */
export interface CliOptions {
  readonly argv?: readonly string[];
  readonly env?: NodeJS.ProcessEnv;
  /**
   * Build the service. The default is `createCollabService` from
   * `src/service`; setting `JUPYTER_COLLAB_MCP_SERVICE_MODULE` to a module
   * exporting `createService(config)` replaces it, which is how the tests
   * drive the real CLI against a fake.
   */
  readonly createService?: (config: ServiceConfig) => CollabService | Promise<CollabService>;
  readonly stderr?: NodeJS.WritableStream;
  readonly stdin?: NodeJS.ReadableStream;
  /** How long shutdown may take before the process is ended anyway. */
  readonly shutdownDeadlineMs?: number;
  /** Install SIGINT/SIGTERM/EOF handlers. Default `true`. */
  readonly installSignalHandlers?: boolean;
  /** Called instead of `process.exit`, so a test can observe the code. */
  readonly exit?: (code: number) => void;
}

/** Handle of a running CLI. */
export interface CliResult {
  /** Stop serving and shut the service down. Idempotent. */
  close(reason?: ShutdownReason): Promise<void>;
}

async function defaultCreateService(config: ServiceConfig, env: NodeJS.ProcessEnv): Promise<CollabService> {
  const modulePath = env['JUPYTER_COLLAB_MCP_SERVICE_MODULE'];
  if (modulePath !== undefined && modulePath !== '') {
    const absolute = isAbsolute(modulePath) ? modulePath : resolvePath(process.cwd(), modulePath);
    const module = (await import(pathToFileURL(absolute).href)) as {
      createService?: (config: ServiceConfig) => CollabService | Promise<CollabService>;
    };
    if (typeof module.createService !== 'function') {
      throw coreError('INVALID_ARGUMENT', `${modulePath} does not export createService(config)`);
    }
    return module.createService(config);
  }
  // Imported here, not at the top: nothing that can reach
  // `@jupyterlab/services` may be constructed before the stdout guard runs.
  const { createCollabService } = await import('../service/index.js');
  // `runCli` already installed the guard; asking for it twice is harmless but
  // saying so keeps the ordering contract visible.
  return createCollabService(config, { guardStdout: false });
}

/**
 * Start the stdio server and keep it running until stdin ends or a signal
 * arrives.
 *
 * Returns as soon as the transport is serving; the returned handle closes it
 * again. Shutdown stops accepting work, asks the service to flush within the
 * deadline and leaves every kernel running (SPEC.md §4).
 */
export async function runCli(options: CliOptions = {}): Promise<CliResult> {
  // 1. stdout belongs to MCP from this line on (SPEC.md §11).
  const { installStdoutGuard } = await import('../jupyter/index.js');
  installStdoutGuard();

  const env = options.env ?? process.env;
  const stderr = options.stderr ?? process.stderr;
  const argv = options.argv ?? process.argv.slice(2);
  const exit = options.exit ?? ((code: number) => process.exit(code));

  const loaded = loadCliConfig(argv, env);
  if (loaded.exit !== undefined) {
    stderr.write(`${loaded.exit.text}\n`);
    exit(loaded.exit.code);
    return { close: async () => undefined };
  }

  const threshold = LEVELS.indexOf(loaded.logLevel);
  const log = (level: 'error' | 'warn' | 'info' | 'debug', message: string): void => {
    if (LEVELS.indexOf(level) > threshold) return;
    stderr.write(`[${level}] ${redactCredentials(message)}\n`);
  };

  const service = await (options.createService ?? ((config: ServiceConfig) => defaultCreateService(config, env)))(
    loaded.config
  );

  // 2. Only now is any MCP or transport object created.
  const { createMcpServer } = await import('./server.js');
  const { serveStdio } = await import('@modelcontextprotocol/server/stdio');

  const handle = serveStdio(
    () =>
      createMcpServer(service, {
        version: packageVersion(),
        responseMaxBytes: loaded.config.limits.responseMaxBytes,
        log
      }),
    { onerror: (error: Error) => log('error', `transport: ${error.message}`) }
  );

  log('info', `serving ${String(loaded.config.servers.length)} server profile(s) over stdio`);

  let closing: Promise<void> | undefined;
  const close = (reason: ShutdownReason): Promise<void> => {
    if (closing !== undefined) return closing;
    closing = (async () => {
      log('info', `shutting down (${reason})`);
      const deadline = options.shutdownDeadlineMs ?? 5_000;
      const timer = setTimeout(() => {
        log('error', `shutdown exceeded ${String(deadline)} ms; exiting anyway`);
        exit(1);
      }, deadline);
      timer.unref?.();
      try {
        await handle.close();
      } catch (thrown) {
        log('warn', `transport close: ${toCoreError(thrown).message}`);
      }
      try {
        await service.shutdown(reason);
      } catch (thrown) {
        log('warn', `service shutdown: ${toCoreError(thrown).message}`);
      }
      clearTimeout(timer);
    })();
    return closing;
  };

  if (options.installSignalHandlers !== false) {
    const onSignal = (reason: ShutdownReason) => (): void => {
      void close(reason).then(() => exit(0));
    };
    process.once('SIGINT', onSignal('signal'));
    process.once('SIGTERM', onSignal('signal'));
    // `process.stdin` and a plain readable stream have incompatible `once`
    // overloads; only the EventEmitter part is used here.
    const stdin: NodeJS.EventEmitter = options.stdin ?? process.stdin;
    const onEof = (): void => {
      void close('eof').then(() => exit(0));
    };
    stdin.once('end', onEof);
    stdin.once('close', onEof);
  }

  return { close: async (reason: ShutdownReason = 'client_request') => close(reason) };
}

/** `true` when this module is the process entry point. */
function isEntryPoint(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return import.meta.url === pathToFileURL(resolvePath(entry)).href;
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  runCli().catch((thrown: unknown) => {
    const error = toCoreError(thrown);
    process.stderr.write(`[error] ${error.code}: ${redactCredentials(error.message)}\n`);
    process.exit(2);
  });
}
