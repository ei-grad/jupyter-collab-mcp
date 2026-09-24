/**
 * Acceptance harness: the REAL product, driven only through MCP.
 *
 * Nothing here imports `CollabService` or `src/service`. The product under
 * test is the process `pnpm start` runs - `tsx src/mcp/cli.ts` with
 * `JUPYTER_URL` / `JUPYTER_TOKEN` - and the only channel to it is a
 * line-delimited JSON-RPC stdio stream read by the official MCP client.
 *
 * The transport is written here rather than taken from
 * `@modelcontextprotocol/client/stdio` for one reason: SPEC.md §11 requires
 * that the child writes MCP frames and *nothing else* to stdout, so the test
 * has to keep every byte the child produced (`stdoutRaw`) and check it
 * itself. `StdioClientTransport` consumes the stream and would hide it.
 *
 * The second RTC client (`openRemote`) is the independent observer/writer
 * SPEC.md §12 demands: a plain `YNotebook` on the same room, with no
 * knowledge of the MCP process.
 */

import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { YNotebook } from '@jupyter/ydoc';
import { Client } from '@modelcontextprotocol/client';
import type { Transport } from '@modelcontextprotocol/client';

/** The transport callback the SDK installs; typed structurally, not by name. */
type MessageHandler = NonNullable<Transport['onmessage']>;

import { RtcConnection, ServerClient } from '../../src/jupyter/index.js';
import type { ResolvedServer } from '../../src/core/index.js';
import type { Stand } from '../helpers/stand.js';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const TSX = join(ROOT, 'node_modules/tsx/dist/cli.mjs');
const CLI = join(ROOT, 'src/mcp/cli.ts');

// ---------------------------------------------------------------------------
// transport
// ---------------------------------------------------------------------------

/**
 * Line-delimited JSON-RPC over a child process we spawn and observe.
 *
 * Every stdout line is kept verbatim in {@link ChildTransport.stdoutRaw};
 * a line that is not a JSON-RPC message is kept in
 * {@link ChildTransport.impurities} instead of being silently dropped.
 */
export class ChildTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: MessageHandler;

  readonly stdoutRaw: string[] = [];
  readonly impurities: string[] = [];
  stderr = '';

  #child: ChildProcessWithoutNullStreams | undefined;
  #buffer = '';
  #exited: Promise<number | null> | undefined;

  constructor(
    private readonly env: NodeJS.ProcessEnv,
    private readonly extraArgs: readonly string[] = []
  ) {}

  get pid(): number | undefined {
    return this.#child?.pid;
  }

  async start(): Promise<void> {
    if (this.#child !== undefined) return;
    const child = spawn(process.execPath, [TSX, CLI, '--log-level', 'info', ...this.extraArgs], {
      cwd: ROOT,
      env: { ...process.env, ...this.env },
      stdio: ['pipe', 'pipe', 'pipe']
    }) as ChildProcessWithoutNullStreams;
    this.#child = child;
    this.#exited = new Promise((resolveExit) => child.once('exit', (code) => resolveExit(code)));
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => this.#consume(chunk));
    child.stderr.on('data', (chunk: string) => {
      this.stderr += chunk;
    });
    child.on('error', (error) => this.onerror?.(error));
    child.on('close', () => this.onclose?.());
  }

  #consume(chunk: string): void {
    this.#buffer += chunk;
    for (;;) {
      const newline = this.#buffer.indexOf('\n');
      if (newline < 0) break;
      const line = this.#buffer.slice(0, newline).replace(/\r$/u, '');
      this.#buffer = this.#buffer.slice(newline + 1);
      if (line.trim() === '') continue;
      this.stdoutRaw.push(line);
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        this.impurities.push(line);
        continue;
      }
      if (
        parsed === null ||
        typeof parsed !== 'object' ||
        (parsed as { jsonrpc?: unknown }).jsonrpc !== '2.0'
      ) {
        this.impurities.push(line);
        continue;
      }
      this.onmessage?.(parsed as Parameters<MessageHandler>[0]);
    }
  }

  async send(message: unknown): Promise<void> {
    const child = this.#child;
    if (child === undefined) throw new Error('transport not started');
    child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  async close(): Promise<void> {
    const child = this.#child;
    if (child === undefined) return;
    child.stdin.end();
    child.kill('SIGTERM');
    const exited = await Promise.race([
      this.#exited,
      new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), 8_000).unref?.())
    ]);
    if (exited === 'timeout') child.kill('SIGKILL');
    this.#child = undefined;
    this.onclose?.();
  }
}

// ---------------------------------------------------------------------------
// the client
// ---------------------------------------------------------------------------

/** One `tools/call` answer, as far as the acceptance tests care. */
export interface ToolAnswer {
  content: {
    type: string;
    text?: string;
    data?: string;
    mimeType?: string;
    uri?: string;
    name?: string;
  }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
  _meta?: Record<string, unknown>;
}

export interface McpChild {
  readonly client: Client;
  readonly transport: ChildTransport;
  /** Call a tool and require success; throws with the structured error otherwise. */
  call(name: string, args?: Record<string, unknown>): Promise<Record<string, unknown>>;
  /** Call a tool and require `isError: true`; returns the structured error. */
  fail(name: string, args?: Record<string, unknown>): Promise<WireError>;
  /** Raw answer, error or not. */
  raw(name: string, args?: Record<string, unknown>): Promise<ToolAnswer>;
  /** Every text block the child ever sent us, for the credential scan. */
  readonly texts: string[];
  close(): Promise<void>;
}

/** The structured error the adapter puts into `_meta['jupyter-collab/error']`. */
export interface WireError {
  code: string;
  message: string;
  retryable: boolean;
  side_effects: string;
  next_request_id?: string | null;
  request_accepted?: boolean | null;
  execution_id?: string;
  current_cell_ref?: string;
  current_notebook_ref?: string;
  revision?: string;
  details?: Record<string, unknown>;
}

const ERROR_META_KEY = 'jupyter-collab/error';

export function metaError(answer: ToolAnswer): WireError {
  const meta = answer._meta ?? {};
  return (meta[ERROR_META_KEY] ?? {}) as WireError;
}

/**
 * Spawn the CLI against `stand` and complete the MCP handshake.
 *
 * The client pins protocol revision 2026-07-28: a successful `initialize` is
 * itself the proof that the served era is the modern one
 * (docs/SERVICE-DESIGN.md §7.5).
 */
export async function startMcp(
  stand: Stand,
  extraEnv: NodeJS.ProcessEnv = {},
  extraArgs: readonly string[] = []
): Promise<McpChild> {
  const transport = new ChildTransport({
    JUPYTER_URL: stand.baseUrl,
    JUPYTER_TOKEN: stand.token,
    // Never let a stray descriptor of a developer's own Jupyter join in.
    JUPYTER_COLLAB_MCP_SERVICE_MODULE: '',
    ...extraEnv
  }, extraArgs);
  const client = new Client(
    { name: 'jupyter-collab-mcp-acceptance', version: '0.0.0' },
    { versionNegotiation: { mode: { pin: '2026-07-28' } } }
  );
  await client.connect(transport as unknown as Parameters<Client['connect']>[0]);

  const texts: string[] = [];
  const raw = async (name: string, args: Record<string, unknown> = {}): Promise<ToolAnswer> => {
    const answer = (await client.callTool({ name, arguments: args })) as unknown as ToolAnswer;
    for (const block of answer.content ?? []) if (typeof block.text === 'string') texts.push(block.text);
    return answer;
  };

  return {
    client,
    transport,
    texts,
    raw,
    async call(name, args = {}) {
      const answer = await raw(name, args);
      if (answer.isError === true) {
        const error = metaError(answer);
        throw new Error(`${name} failed: ${error.code}: ${error.message}`);
      }
      if (answer.structuredContent === undefined) throw new Error(`${name} returned no structuredContent`);
      return answer.structuredContent;
    },
    async fail(name, args = {}) {
      const answer = await raw(name, args);
      if (answer.isError !== true) {
        throw new Error(`${name} unexpectedly succeeded: ${JSON.stringify(answer.structuredContent)}`);
      }
      return metaError(answer);
    },
    async close() {
      await client.close();
      await transport.close();
    }
  };
}

// ---------------------------------------------------------------------------
// the independent RTC client (SPEC.md §12 "second independent client")
// ---------------------------------------------------------------------------

export interface RemoteClient {
  readonly notebook: YNotebook;
  readonly connection: RtcConnection;
  dispose(): void;
}

/** Open `path` in a second, plain `YNotebook` that knows nothing about MCP. */
export async function openRemote(stand: Stand, path: string): Promise<RemoteClient> {
  const server: ResolvedServer = {
    profile: {
      id: 'acceptance-remote',
      kind: 'standalone',
      apiBaseUrl: stand.baseUrl,
      credentialRef: `literal:${stand.token}`
    },
    apiBaseUrl: stand.baseUrl,
    wsBaseUrl: stand.wsUrl,
    token: stand.token
  };
  const client = new ServerClient(server);
  const session = await client.collaborationSession(path);
  const notebook = new YNotebook();
  const connection = new RtcConnection({
    wsBaseUrl: stand.wsUrl,
    token: stand.token,
    fileId: session.fileId,
    sessionId: session.sessionId,
    ydoc: notebook.ydoc,
    awareness: notebook.awareness,
    awarenessUser: { name: 'acceptance-remote', color: '#8e24aa' }
  });
  await connection.connect(30_000);
  await until('remote replica synced', () => notebook.nbformat !== undefined);
  return {
    notebook,
    connection,
    dispose(): void {
      connection.dispose();
      notebook.dispose();
    }
  };
}

// ---------------------------------------------------------------------------
// small utilities
// ---------------------------------------------------------------------------

export async function until(
  what: string,
  predicate: () => boolean,
  timeoutMs = 20_000,
  intervalMs = 50
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) return;
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${what}`);
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

/**
 * The per-session `request_id` counter an agent is required to keep: take the
 * `next_request_id` of the last answer of this session (SPEC.md §9).
 */
export class Counter {
  #next = '1';
  get value(): string {
    return this.#next;
  }
  take(payload: Record<string, unknown> | WireError | undefined): void {
    const next = (payload as { next_request_id?: unknown } | undefined)?.next_request_id;
    if (typeof next === 'string') this.#next = next;
  }
}

export const TERMINAL_STATES = new Set(['succeeded', 'failed', 'cancelled', 'interrupted', 'unknown']);

/** Read `execution_get` until the job is terminal. */
export async function settle(
  mcp: McpChild,
  executionId: string,
  timeoutMs = 60_000
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  let cursor: string | undefined;
  for (;;) {
    const view = await mcp.call('execution_get', {
      execution_id: executionId,
      wait_ms: 1000,
      ...(cursor === undefined ? {} : { cursor })
    });
    cursor = view['cursor'] as string | undefined;
    if (TERMINAL_STATES.has(String(view['state']))) return view;
    if (Date.now() > deadline) throw new Error(`job stuck in ${String(view['state'])}`);
  }
}
