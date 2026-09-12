/**
 * Keep stdout clean for the MCP stdio channel (SPEC.md §11).
 *
 * In stdio transport stdout carries JSON-RPC frames only; diagnostics go to
 * stderr. Our own code never prints to stdout, but a dependency does:
 * `@jupyterlab/services` calls `console.debug('Starting WebSocket: <url>')`
 * (kernel/default.js:80,158,1535) and Node routes `console.debug` — like
 * `console.log` and `console.info` — to stdout (spike/NOTES.md §3.4).
 *
 * {@link installStdoutGuard} re-points every stdout-writing `console` method
 * onto stderr: `log`, `info`, `debug` and, because they bypass `console.log`
 * entirely, `dir` and `dirxml`. `console.warn`, `console.error` and
 * `console.trace` already write to stderr and are left alone, so a library
 * that swaps them keeps working.
 *
 * Ordering: install the guard *before* the first `@jupyterlab/services` object
 * is created. ESM hoists `import`, so an entry point that imports the guard and
 * the services package in the same module cannot control the order of the
 * imports themselves — but the console call happens when a `KernelConnection`
 * is constructed, not at import time, so an entry point that calls
 * `installStdoutGuard()` at the top of its body and only then reaches any
 * transport code is safe. When in doubt, `await import()` the transport after
 * installing.
 *
 * @module
 */

import { formatWithOptions, inspect } from 'node:util';

import { redactCredentials } from '../core/index.js';

/**
 * Console methods Node writes to stdout.
 *
 * `log`, `info` and `debug` share one implementation, and `table`, `group`,
 * `count` and `timeEnd` are routed through `console.log`, so replacing `log`
 * covers them too. `dir` and `dirxml` do **not** go through `log`: they reach
 * the stdout stream directly (`node:internal/console/constructor`,
 * `kWriteToConsole`), so they have to be replaced by name - verified on Node
 * 24.14, where overriding only `log`/`info`/`debug` still let both print.
 */
const GUARDED = ['log', 'info', 'debug', 'dir', 'dirxml'] as const;

type GuardedMethod = (typeof GUARDED)[number];

/** Options of {@link installStdoutGuard}. */
export interface StdoutGuardOptions {
  /**
   * Prefix written before every redirected line. Default `'[console] '`.
   * Set to `''` to disable.
   */
  readonly prefix?: string;
  /** Sink for the redirected lines. Default `process.stderr`. */
  readonly stream?: NodeJS.WritableStream;
  /**
   * Drop the redirected lines instead of writing them to {@link stream}.
   * Useful for a process that must stay completely silent.
   */
  readonly silent?: boolean;
}

/** Undo an install. Idempotent; a second call does nothing (SPEC.md §11). */
export type RestoreConsole = () => void;

interface ActiveGuard {
  readonly restore: RestoreConsole;
}

let active: ActiveGuard | null = null;

/**
 * Redirect every stdout-writing `console` method to stderr (SPEC.md §11).
 *
 * Idempotent: while a guard is installed, further calls return the *same*
 * restore function and change nothing, so two subsystems can both ask for the
 * guard without stacking wrappers. Credentials are stripped from every
 * redirected line with {@link redactCredentials}, because the message that
 * motivated the guard is a WebSocket URL that may carry `?token=`.
 *
 * @returns a function that puts the original console methods back.
 */
export function installStdoutGuard(options: StdoutGuardOptions = {}): RestoreConsole {
  if (active !== null) return active.restore;

  const prefix = options.prefix ?? '[console] ';
  const stream = options.stream ?? process.stderr;
  const silent = options.silent ?? false;

  const originals = new Map<GuardedMethod, unknown>();
  for (const method of GUARDED) {
    originals.set(method, console[method]);
  }

  const emit = (text: string): void => {
    if (silent) return;
    stream.write(`${prefix}${redactCredentials(text)}\n`);
  };

  const write = (args: readonly unknown[]): void => {
    if (silent) return;
    emit(formatWithOptions({ colors: false }, ...args));
  };

  for (const method of ['log', 'info', 'debug', 'dirxml'] as const) {
    console[method] = (...args: unknown[]): void => {
      write(args);
    };
  }
  // `console.dir(value, options)` takes inspect options rather than format
  // arguments; keep that contract, minus colours, which stderr does not need.
  console.dir = (value?: unknown, options?: unknown): void => {
    if (silent) return;
    const inspectOptions = typeof options === 'object' && options !== null ? options : {};
    emit(inspect(value, { ...inspectOptions, colors: false }));
  };

  let restored = false;
  const restore: RestoreConsole = () => {
    if (restored) return;
    restored = true;
    for (const method of GUARDED) {
      const original = originals.get(method);
      if (original !== undefined) {
        (console as unknown as Record<string, unknown>)[method] = original;
      }
    }
    active = null;
  };

  active = { restore };
  return restore;
}

/** `true` while a guard installed by {@link installStdoutGuard} is active. */
export function isStdoutGuardInstalled(): boolean {
  return active !== null;
}
