/**
 * The MCP stdio adapter over {@link CollabService} (SPEC.md §9).
 *
 * The adapter holds no state and makes no decisions about the notebook, the
 * kernel or the `request_id` ledger. Per call it does exactly four things:
 *
 * 1. validate the snake_case arguments against the tool's zod schema and turn
 *    a failure into `INVALID_ARGUMENT`;
 * 2. rename to camelCase and call the one matching {@link CollabService}
 *    method;
 * 3. rename the result back, split image payloads off into MCP `image`
 *    content or `resource_link`s, and fit the rest into the response budget;
 * 4. turn a thrown {@link CoreError} into `isError: true` with `code`,
 *    `message`, `retryable`, `side_effects` and - when the service reported
 *    them - `next_request_id`, `request_accepted`, `execution_id`, `revision`.
 *
 * Everything that reaches an agent goes through `redactCredentials`
 * (SPEC.md §11), and nothing is ever written to stdout except MCP frames -
 * the process installs the stdout guard before this module runs.
 *
 * @module
 */

import { McpServer, ResourceTemplate, fromJsonSchema } from '@modelcontextprotocol/server';
import type { CallToolResult, ContentBlock, StandardSchemaWithJSON } from '@modelcontextprotocol/server';
import type { z } from 'zod';

import { coreError, redactCredentials, toCoreError } from '../core/index.js';
import { packageVersion } from '../version.js';
import type {
  CollabService,
  ServerStatusRequest,
  ServerStartRequest,
  ExecutionCancelRequest,
  ExecutionGetRequest,
  KernelControlRequest,
  KernelListRequest,
  KernelStatusRequest,
  NotebookApplyRequest,
  NotebookChangesRequest,
  NotebookCloseRequest,
  NotebookCreateRequest,
  NotebookExecuteRequest,
  NotebookListRequest,
  NotebookOpenRequest,
  NotebookReadRequest,
  NotebookSaveRequest,
  OutputReadRequest,
} from '../core/index.js';
import { TOOL_SPECS, TOOL_SPECS_BY_NAME } from './schemas.js';
import type { ToolSpec } from './schemas.js';
import { ReferenceAliases } from './references.js';
import {
  DEFAULT_RESPONSE_MAX_BYTES,
  boundPayload,
  boundText,
  fromWire,
  jsonByteSize,
  toWire,
  WireBudgetError
} from './wire.js';
import { OPAQUE_KEYS } from './wire.js';
import type { WireObject, WireValue } from './wire.js';

/** `_meta` key carrying the structured error of a failed tool call. */
export const ERROR_META_KEY = 'jupyter-collab/error';

/** URI template of our own output snapshots (SPEC.md §9). */
export const OUTPUT_URI_TEMPLATE = 'jupyter-output:{output_id}';

/**
 * The form `CollabService` actually issues: `jupyter-output://<session>/<id>`.
 *
 * RFC 6570 expansion of `{output_id}` never spans a `/`, so the short
 * template does not match that URI and `resources/read` would answer
 * "Resource not found". Both are registered; the service parses either.
 */
export const OUTPUT_URI_TEMPLATE_SESSION = 'jupyter-output://{context_id}/{output_id}';

/** Severity of an adapter diagnostic. Diagnostics never reach stdout. */
export type LogLevel = 'error' | 'warn' | 'info' | 'debug';

/** Options of {@link createMcpServer}. */
export interface McpServerOptions {
  /** Server name reported in `initialize`. */
  readonly name?: string;
  /** Server version reported in `initialize`. */
  readonly version?: string;
  /**
   * UTF-8 budget of one tool answer, structured content included
   * (SPEC.md §9 default: 64 KiB). A larger answer is reduced and marked
   * `response_truncated` with a `read_more` note.
   */
  readonly responseMaxBytes?: number;
  /**
   * Largest base64 image returned as MCP `image` content. Anything bigger
   * stays an `output_id` plus a `resource_link` (SPEC.md §9: a full base64
   * image is not repeated in every answer). Default 128 KiB.
   */
  readonly imageMaxBytes?: number;
  /** Image blocks per answer. Default 4. */
  readonly maxImages?: number;
  /** `resource_link` blocks per answer. Default 16. */
  readonly maxResourceLinks?: number;
  /** Diagnostics sink. Default: nothing. Must never write to stdout. */
  readonly log?: (level: LogLevel, message: string) => void;
}

interface ResolvedOptions {
  readonly name: string;
  readonly version: string;
  readonly responseMaxBytes: number;
  readonly imageMaxBytes: number;
  readonly maxImages: number;
  readonly maxResourceLinks: number;
  readonly log: (level: LogLevel, message: string) => void;
}

function resolve(options: McpServerOptions): ResolvedOptions {
  return {
    name: options.name ?? 'jupyter-collab-mcp',
    version: options.version ?? packageVersion(),
    responseMaxBytes: options.responseMaxBytes ?? DEFAULT_RESPONSE_MAX_BYTES,
    imageMaxBytes: options.imageMaxBytes ?? 128 * 1024,
    maxImages: options.maxImages ?? 4,
    maxResourceLinks: options.maxResourceLinks ?? 16,
    log: options.log ?? ((): void => undefined)
  };
}

// ---------------------------------------------------------------------------
// errors (SPEC.md §9 "Tool errors return isError: true")
// ---------------------------------------------------------------------------

/** The structured error the adapter puts into `_meta` and into the text. */
export interface WireError {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
  readonly side_effects: 'none' | 'applied' | 'unknown';
  readonly next_request_id?: string | null;
  readonly request_accepted?: boolean | null;
  readonly execution_id?: string;
  readonly execution_ids?: readonly string[];
  readonly revision?: string;
  readonly details?: Record<string, unknown>;
}

function redactDeep(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (typeof value === 'string') return redactCredentials(value);
  if (depth >= 6) return '[details depth omitted]';
  if (Array.isArray(value)) return value.map((item) => redactDeep(item, depth + 1, seen));
  if (value !== null && typeof value === 'object') {
    if (seen.has(value)) return '[details cycle omitted]';
    seen.add(value);
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      out[key] = redactDeep(child, depth + 1, seen);
    }
    seen.delete(value);
    return out;
  }
  return value;
}

function pick(details: Record<string, unknown> | undefined, ...keys: string[]): unknown {
  if (details === undefined) return undefined;
  for (const key of keys) {
    const value = details[key];
    if (value !== undefined) return value;
  }
  return undefined;
}

/**
 * Turn any thrown value into the SPEC.md §9 error shape.
 *
 * `next_request_id`, `request_accepted`, `execution_id` and `revision` are
 * lifted out of `CoreError.details` when the service put them there: an agent
 * that lost its counter must be able to recover it from an *error* too
 * (SPEC.md §9 "Even a replay returns the current next_request_id").
 */
export function toWireError(thrown: unknown): WireError {
  const error = toCoreError(thrown);
  const details = error.details === undefined
    ? undefined
    : (redactDeep({ ...error.details }) as Record<string, unknown>);

  const nextRequestId = pick(details, 'next_request_id', 'nextRequestId');
  const requestAccepted = pick(details, 'request_accepted', 'requestAccepted');
  const executionId = pick(details, 'execution_id', 'executionId');
  const executionIds = pick(details, 'execution_ids', 'executionIds');
  const revision = pick(details, 'revision');

  return {
    code: error.code,
    message: redactCredentials(error.message),
    retryable: error.retryable,
    side_effects: error.sideEffects,
    ...(typeof nextRequestId === 'string' || nextRequestId === null ? { next_request_id: nextRequestId } : {}),
    ...(typeof requestAccepted === 'boolean' || requestAccepted === null ? { request_accepted: requestAccepted } : {}),
    ...(typeof executionId === 'string' ? { execution_id: executionId } : {}),
    ...(Array.isArray(executionIds) && executionIds.every((value) => typeof value === 'string')
      ? { execution_ids: executionIds as string[] }
      : {}),
    ...(typeof revision === 'string' ? { revision } : {}),
    ...(details === undefined ? {} : { details })
  };
}

function presentWireError(wire: WireError, references: ReferenceAliases): WireError {
  const { details, ...base } = wire;
  const presented = references.presentValue(base as unknown as WireValue) as unknown as WireError;
  return details === undefined
    ? presented
    : {
        ...presented,
        details: references.presentValue(details as unknown as WireValue) as unknown as Record<string, unknown>
      };
}

const RECOVERY_DETAIL_KEYS = [
  'notebook_id', 'cell_id', 'execution_id', 'execution_ids', 'output_id',
  'revision', 'expected', 'current', 'cursor', 'next_cursor', 'next_request_id',
  'request_accepted'
] as const;

function boundedString(value: string, maxBytes: number): string {
  return boundText(value, maxBytes).text;
}

function boundedDetails(details: Record<string, unknown>, maxBytes: number): Record<string, unknown> {
  if (jsonByteSize(details) <= maxBytes) return details;
  const kept: Record<string, unknown> = { details_truncated: true };
  for (const key of RECOVERY_DETAIL_KEYS) {
    const value = details[key];
    if (typeof value === 'string') kept[key] = boundedString(value, 512);
    else if (typeof value === 'boolean' || value === null || typeof value === 'number') kept[key] = value;
    else if (Array.isArray(value) && value.every((entry) => typeof entry === 'string')) {
      kept[key] = value.slice(0, 32).map((entry) => boundedString(entry, 128));
    }
  }
  return kept;
}

function boundWireError(wire: WireError, maxBytes: number): WireError {
  const message = boundedString(wire.message, Math.min(4096, Math.max(256, Math.floor(maxBytes / 4))));
  const { details, ...withoutDetails } = wire;
  const base: WireError = { ...withoutDetails, message };
  if (details === undefined) return base;
  const available = Math.max(128, maxBytes - jsonByteSize(base) - 128);
  return { ...base, details: boundedDetails(details, available) };
}

function errorResult(thrown: unknown, maxBytes: number, references: ReferenceAliases): CallToolResult {
  const wire = boundWireError(presentWireError(toWireError(thrown), references), maxBytes);
  const head = `${wire.code}: ${wire.message}`;
  const facts = [
    `retryable=${String(wire.retryable)}`,
    `side_effects=${wire.side_effects}`,
    ...(wire.next_request_id === undefined ? [] : [`next_request_id=${String(wire.next_request_id)}`]),
    ...(wire.request_accepted === undefined ? [] : [`request_accepted=${String(wire.request_accepted)}`]),
    ...(wire.execution_id === undefined ? [] : [`execution_id=${wire.execution_id}`]),
    ...(wire.execution_ids === undefined ? [] : [`execution_ids=${wire.execution_ids.join(',')}`]),
    ...(wire.revision === undefined ? [] : [`revision=${wire.revision}`])
  ].join(' ');
  const diagnostics = wire.details === undefined ? '' : `\ndetails=${JSON.stringify(wire.details)}`;
  const text = boundText(`${head}\n${facts}${diagnostics}`, maxBytes).text;
  return {
    content: [{ type: 'text', text }],
    isError: true,
    _meta: { [ERROR_META_KEY]: wire as unknown as Record<string, unknown> }
  };
}

/** Build the `INVALID_ARGUMENT` answer for arguments that failed the schema. */
function invalidArgument(
  tool: string,
  issues: readonly z.core.$ZodIssue[],
  maxBytes: number,
  references: ReferenceAliases
): CallToolResult {
  const detail = issues
    .slice(0, 8)
    .map((issue) => `${issue.path.length === 0 ? '(root)' : issue.path.join('.')}: ${issue.message}`)
    .join('; ');
  return errorResult(
    coreError('INVALID_ARGUMENT', `invalid arguments for ${tool}: ${detail}`, {
      details: {
        tool,
        issues: issues.slice(0, 8).map((issue) => ({ path: issue.path.join('.'), message: issue.message }))
      }
    }),
    maxBytes,
    references
  );
}

// ---------------------------------------------------------------------------
// output content: image vs resource_link (SPEC.md §9)
// ---------------------------------------------------------------------------

const IMAGE_MIME = ['image/png', 'image/jpeg'] as const;

function isObject(value: WireValue | undefined): value is WireObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asText(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && value.every((line) => typeof line === 'string')) return value.join('');
  return undefined;
}

/** The `image/png` or `image/jpeg` payload of an inlined nbformat output. */
function inlineImage(output: WireValue | undefined): { mimeType: string; data: string } | undefined {
  if (!isObject(output)) return undefined;
  const bundle = output['data'];
  if (!isObject(bundle)) return undefined;
  for (const mimeType of IMAGE_MIME) {
    const data = asText(bundle[mimeType]);
    if (data !== undefined && data.length > 0) return { mimeType, data };
  }
  return undefined;
}

interface ExtractedContent {
  readonly payload: WireObject;
  readonly blocks: ContentBlock[];
}

/**
 * Visit protocol output entries, lift image payloads into MCP `image` content
 * and add a `resource_link` for every snapshot that stays behind an
 * `output_id`.
 *
 * An image that becomes a content block is removed from `structuredContent`
 * and marked `delivered_as: "image"`, so its base64 is not repeated in the
 * same answer (SPEC.md §9). An image too large for the budget keeps its
 * `output_id`: the bytes are read with `output_read` or the
 * `jupyter-output:` resource.
 */
function extractOutputContent(tool: string, payload: WireObject, options: ResolvedOptions): ExtractedContent {
  const blocks: ContentBlock[] = [];
  let images = 0;
  let links = 0;
  const seenUris = new Set<string>();

  const extractEntry = (node: WireValue): WireValue => {
    if (!isObject(node)) return node;
    const looksLikeOutputEntry = typeof node['output_type'] === 'string' && typeof node['index'] === 'number';
    if (!looksLikeOutputEntry) return node;

    const next: WireObject = { ...node };

    const snapshot = isObject(next['snapshot']) ? next['snapshot'] : undefined;
    const image = inlineImage(next['output']);

    if (image !== undefined && images < options.maxImages && jsonByteSize(image.data) <= options.imageMaxBytes) {
      images++;
      blocks.push({ type: 'image', data: image.data, mimeType: image.mimeType });
      delete next['output'];
      next['delivered_as'] = 'image';
      next['truncated'] = true;
    }

    if (snapshot !== undefined && links < options.maxResourceLinks) {
      const uri = snapshot['uri'];
      if (typeof uri === 'string' && !seenUris.has(uri)) {
        seenUris.add(uri);
        links++;
        const mimeTypes = snapshot['mime_types'];
        const mimeType = Array.isArray(mimeTypes) && typeof mimeTypes[0] === 'string' ? mimeTypes[0] : undefined;
        blocks.push({
          type: 'resource_link',
          uri,
          name: typeof snapshot['output_id'] === 'string' ? snapshot['output_id'] : uri,
          description: `Output snapshot, ${String(snapshot['byte_size'] ?? '?')} bytes. Read it as a resource, or with output_read.`,
          ...(mimeType === undefined ? {} : { mimeType })
        });
      }
    }
    return next;
  };

  if (!['notebook_read', 'notebook_execute', 'execution_get'].includes(tool)) {
    return { payload, blocks };
  }

  const cells = payload['cells'];
  if (!Array.isArray(cells)) return { payload, blocks };
  const mappedCells = cells.map((cell) => {
    if (!isObject(cell) || !Array.isArray(cell['outputs'])) return cell;
    return { ...cell, outputs: cell['outputs'].map(extractEntry) };
  });
  return { payload: { ...payload, cells: mappedCells }, blocks };
}

// ---------------------------------------------------------------------------
// compact text rendering
// ---------------------------------------------------------------------------

function s(value: WireValue | undefined): string {
  if (value === undefined || value === null) return '-';
  if (typeof value === 'object') return Array.isArray(value) ? `[${String(value.length)}]` : '{…}';
  return String(value);
}

function nested(payload: WireObject, key: string): WireObject {
  const value = payload[key];
  return isObject(value) ? value : {};
}

function envelopeLine(payload: WireObject): string[] {
  const parts: string[] = [];
  if ('next_request_id' in payload) parts.push(`next_request_id=${s(payload['next_request_id'])}`);
  if (payload['request_accepted'] !== undefined) parts.push(`request_accepted=${s(payload['request_accepted'])}`);
  if (payload['replayed'] === true) parts.push('replayed=true (result reused from a receipt — nothing ran again)');
  if (payload['response_truncated'] === true) parts.push(`truncated: ${s(payload['read_more'])}`);
  return parts.length === 0 ? [] : [parts.join(' ')];
}

function cellLines(cells: WireValue | undefined): string[] {
  if (!Array.isArray(cells)) return [];
  return cells.flatMap((cell) => {
    if (!isObject(cell)) return '  -';
    const state = cell['state'] ?? cell['execution_state'];
    const refs = [
      `source_revision=${s(cell['source_revision'])}`,
      `cell_revision=${s(cell['cell_revision'])}`,
      ...(cell['outputs_revision'] === undefined ? [] : [`outputs_revision=${s(cell['outputs_revision'])}`])
    ];
    const row = `  index=${s(cell['index'])} cell_id=${s(cell['cell_id'])} type=${s(cell['cell_type'] ?? state)} ${refs.join(' ')} ${s(cell['preview'] ?? cell['state'] ?? '')}`.trimEnd();
    return typeof cell['source'] === 'string'
      ? [row, `    source=${JSON.stringify(cell['source'])}`]
      : [row];
  });
}

/** One short human/agent-readable rendering of a result (SPEC.md §9). */
export function renderText(tool: string, payload: WireObject): string {
  const lines: string[] = [];
  switch (tool) {
    case 'server_status':
    case 'server_start':
      lines.push(`${s(payload['server_id'])}: ${s(payload['state'])}; supports_start=${s(payload['supports_start'])}`);
      break;
    case 'server_list': {
      const servers = payload['servers'];
      lines.push(`${Array.isArray(servers) ? servers.length : 0} server(s); discovery=${s(payload['discovery_enabled'])} selection_required=${s(payload['selection_required'])}`);
      if (Array.isArray(servers)) {
        for (const entry of servers) {
          if (!isObject(entry)) continue;
          const d = nested(entry, 'descriptor');
          lines.push(`  ${s(d['id'])} ${s(d['kind'])} ${s(d['api_base_url'])} origin=${s(entry['origin'])}${entry['default_choice'] === true ? ' default' : ''}`);
        }
      }
      break;
    }
    case 'notebook_list': {
      const entries = payload['entries'];
      lines.push(`${s(payload['directory'])}: ${Array.isArray(entries) ? entries.length : 0} entr(ies) truncated=${s(payload['truncated'])}`);
      if (Array.isArray(entries)) {
        for (const entry of entries) {
          if (!isObject(entry)) continue;
          const session = isObject(entry['session']) ? entry['session'] : undefined;
          lines.push(`  ${s(entry['type'])} ${s(entry['path'])}${session === undefined ? '' : ` kernel=${s(session['kernel_name'])}`}`);
        }
      }
      break;
    }
    case 'notebook_create':
    case 'notebook_open': {
      const nb = nested(payload, 'notebook');
      const summary = nested(payload, 'summary');
      lines.push(
        `notebook ${s(nb['notebook_id'])} ${s(nb['path'])} ${s(nb['connection_state'])}${nb['stale'] === true ? ' stale' : ''} cells=${s(summary['cell_count'])}` +
          (tool === 'notebook_create' ? ` renamed=${s(payload['renamed'])} untitled=${s(payload['untitled_path'])}` : ` reused=${s(payload['reused'])}`)
      );
      lines.push(`changes_cursor=${s(payload['changes_cursor'])}`);
      lines.push(...cellLines(summary['cells']));
      break;
    }
    case 'notebook_close':
      lines.push(`notebook ${s(payload['notebook_id'])} closed=${payload['already_closed'] === true ? 'already' : 'now'}; kernel left running`);
      break;
    case 'notebook_read': {
      lines.push(`${s(payload['view'])} of ${s(payload['notebook_id'])} ${s(payload['connection_state'])}${payload['stale'] === true ? ' stale' : ''} structure=${s(payload['structure_revision'])} changes_cursor=${s(payload['changes_cursor'])}`);
      const summary = payload['summary'];
      if (isObject(summary)) {
        lines.push(`cells=${s(summary['cell_count'])} truncated=${s(summary['truncated'])}`);
        if (payload['next_cursor'] !== undefined) lines.push(`next_cursor=${s(payload['next_cursor'])}`);
        lines.push(...cellLines(summary['cells']));
      } else {
        if (payload['next_cursor'] !== undefined) lines.push(`next_cursor=${s(payload['next_cursor'])}`);
        lines.push(...cellLines(payload['cells']));
        lines.push(...outputLines(payload['cells']));
      }
      break;
    }
    case 'notebook_apply': {
      const results = payload['results'];
      lines.push(`${Array.isArray(results) ? results.length : 0} operation(s) applied_locally=${s(payload['applied_locally'])} delivery=${s(payload['delivery'])} persistence=${s(payload['persistence'])}${payload['partial'] === true ? ' PARTIAL — re-read the affected cells' : ''}`);
      if (Array.isArray(results)) {
        for (const entry of results) {
          if (!isObject(entry)) continue;
          lines.push(`  ${s(entry['op'])} ${s(entry['cell_id'])} source=${s(entry['source_revision'])} cell=${s(entry['cell_revision'])}`);
        }
      }
      lines.push(`structure=${s(payload['structure_revision'])} changes_cursor=${s(payload['changes_cursor'])}`);
      break;
    }
    case 'notebook_execute':
    case 'execution_get': {
      lines.push(
        `execution ${s(payload['execution_id'])} ${s(payload['state'])}${payload['reason'] === undefined ? '' : ` (${s(payload['reason'])})`} kernel=${s(payload['kernel_id'])} wait_timed_out=${s(payload['wait_timed_out'])} cursor=${s(payload['cursor'])}`
      );
      const cells = payload['cells'];
      if (Array.isArray(cells)) {
        for (const cell of cells) {
          if (!isObject(cell)) continue;
          const outputs = cell['outputs'];
          const reason = cell['not_sent_reason'] ?? cell['aborted_reason'];
          lines.push(
            `  ${s(cell['cell_id'])} ${s(cell['state'])}${reason === undefined ? '' : `/${s(reason)}`} count=${s(cell['execution_count'])} outputs=${Array.isArray(outputs) ? outputs.length : 0}${cell['output_incomplete'] === true ? ' output_incomplete' : ''}${cell['source_changed'] === true ? ' source_changed' : ''}`
          );
          if (Array.isArray(outputs)) {
            for (const output of outputs) {
              if (!isObject(output)) continue;
              lines.push(`    ${s(output['output_type'])} ${renderOutputReference(output)}`);
            }
          }
        }
      }
      break;
    }
    case 'output_read':
      lines.push(
        `output ${s(payload['output_id'])} ${s(payload['mime_type'])} ${s(payload['encoding'])} bytes ${s(payload['byte_offset'])}..+${String((payload['data'] as string | undefined)?.length ?? 0)} of ${s(payload['byte_size'])} truncated=${s(payload['truncated'])}`
      );
      if (payload['next_cursor'] !== undefined) lines.push(`next_cursor=${s(payload['next_cursor'])}`);
      lines.push(`data=${JSON.stringify(payload['data'] ?? '')}`);
      break;
    case 'execution_cancel':
      lines.push(
        `execution ${s(payload['execution_id'])} notebook=${s(payload['notebook_id'])} ${s(payload['state'])}; cancelled=${s(payload['cancelled_cell_ids'])} already_sent=${s(payload['already_sent_cell_ids'])}; the kernel was not interrupted`
      );
      break;
    case 'notebook_changes': {
      const events = payload['events'];
      lines.push(`${Array.isArray(events) ? events.length : 0} event(s) next_cursor=${s(payload['next_cursor'])} truncated=${s(payload['truncated'])} ${s(payload['connection_state'])} wait_timed_out=${s(payload['wait_timed_out'])}`);
      if (Array.isArray(events)) {
        for (const event of events) {
          if (!isObject(event)) continue;
          lines.push(`  ${s(event['sequence'])} ${s(event['kind'])} ${s(event['cell_id'])} ${s(event['origin'])}`);
        }
      }
      break;
    }
    case 'notebook_save':
      lines.push(
        `save ${s(payload['save_status'])} revision_persistence=${s(payload['revision_persistence'])} autosave=${s(payload['autosave_enabled'])}${payload['save_status'] === 'skipped' || payload['save_status'] === 'timeout' ? ' — this is NOT a confirmation that the file was written' : ''}`
      );
      break;
    case 'kernel_list': {
      const specs = payload['kernelspecs'];
      const running = payload['running'];
      lines.push(`${Array.isArray(specs) ? specs.length : 0} kernelspec(s), default=${s(payload['default_kernel_name'])}, ${Array.isArray(running) ? running.length : 0} running`);
      if (Array.isArray(running)) {
        for (const kernel of running) {
          if (!isObject(kernel)) continue;
          lines.push(`  ${s(kernel['kernel_id'])} ${s(kernel['kernel_name'])} ${s(kernel['execution_status'])} paths=${s(kernel['bound_paths'])}`);
        }
      }
      break;
    }
    case 'kernel_status':
      lines.push(
        `kernel ${s(payload['kernel_id'])} (${s(payload['kernel_name'])}) channel=${s(payload['channel_state'])} status=${s(payload['execution_status'])} at ${s(payload['observed_at'])} active=${s(payload['active_execution_ids'])}`
      );
      break;
    case 'kernel_control': {
      const effects = nested(payload, 'effects');
      lines.push(
        `${s(payload['action'])}: ${s(payload['previous_kernel_id'])} -> ${s(payload['kernel_id'])} (${s(payload['kernel_name'])}) binding_changed=${s(effects['binding_changed'])} invalidated=${s(effects['invalidated_execution_ids'])} outputs_cleared=false`
      );
      lines.push(`status=${s(nested(payload, 'status')['execution_status'])}`);
      break;
    }
    default:
      lines.push(tool);
  }
  lines.push(...envelopeLine(payload));
  return lines.join('\n');
}

/** One line, at most 200 characters: a summary row must never wrap. */
function flatten(text: string): string {
  const single = text.replace(/\s+/gu, ' ').trim();
  return single.length <= 200 ? single : `${single.slice(0, 200)}…`;
}

function summarizeOutput(output: WireObject): string {
  const type = output['output_type'];
  if (type === 'error') return `${s(output['ename'])}: ${s(output['evalue'])}`;
  const inner = output['output'];
  if (isObject(inner)) {
    if (inner['output_type'] === 'stream') return flatten(`${s(inner['name'])} ${asText(inner['text']) ?? ''}`);
    if (inner['output_type'] === 'error') return `${s(inner['ename'])}: ${s(inner['evalue'])}`;
    const bundle = inner['data'];
    if (isObject(bundle)) {
      const plain = asText(bundle['text/plain']);
      if (plain !== undefined) return flatten(plain);
    }
  }
  const mimeTypes = output['mime_types'];
  const suffix = output['delivered_as'] === 'image' ? ' (returned as image content)' : '';
  return `${Array.isArray(mimeTypes) && mimeTypes.length > 0 ? mimeTypes.join(',') : 'no payload'} ${String(output['byte_size'] ?? '')} bytes${suffix}`.trim();
}

function renderOutputReference(output: WireObject): string {
  const snapshot = nested(output, 'snapshot');
  if (typeof snapshot['output_id'] === 'string') {
    return `output_id=${snapshot['output_id']} — call output_read with this id`;
  }
  const raw = output['output'];
  return raw === undefined ? summarizeOutput(output) : JSON.stringify(raw);
}

function outputLines(cells: WireValue | undefined): string[] {
  if (!Array.isArray(cells)) return [];
  const lines: string[] = [];
  for (const cell of cells) {
    if (!isObject(cell) || !Array.isArray(cell['outputs'])) continue;
    for (const output of cell['outputs']) {
      if (!isObject(output)) continue;
      lines.push(`  cell_id=${s(cell['cell_id'])} output_index=${s(output['index'])} ${renderOutputReference(output)}`);
    }
  }
  return lines;
}

// ---------------------------------------------------------------------------
// dispatch
// ---------------------------------------------------------------------------

/**
 * Call the one {@link CollabService} method a tool maps to.
 *
 * The argument was validated against the tool's zod schema and renamed to
 * camelCase, so the cast is the single, contained place where the wire shape
 * is asserted to be the facade shape.
 */
async function dispatch(service: CollabService, tool: string, request: unknown): Promise<unknown> {
  switch (tool) {
    case 'server_status':
      return service.serverStatus(request as ServerStatusRequest);
    case 'server_start':
      return service.serverStart(request as ServerStartRequest);
    case 'server_list':
      return service.serverList();
    case 'notebook_list':
      return service.notebookList(request as NotebookListRequest);
    case 'notebook_create':
      return service.notebookCreate(request as NotebookCreateRequest);
    case 'notebook_open':
      return service.notebookOpen(request as NotebookOpenRequest);
    case 'notebook_close':
      return service.notebookClose(request as NotebookCloseRequest);
    case 'notebook_read':
      return service.notebookRead(request as NotebookReadRequest);
    case 'notebook_apply':
      return service.notebookApply(request as NotebookApplyRequest);
    case 'notebook_execute':
      return service.notebookExecute(request as NotebookExecuteRequest);
    case 'execution_get':
      return service.executionGet(request as ExecutionGetRequest);
    case 'output_read':
      return service.outputRead(request as OutputReadRequest);
    case 'execution_cancel':
      return service.executionCancel(request as ExecutionCancelRequest);
    case 'notebook_changes':
      return service.notebookChanges(request as NotebookChangesRequest);
    case 'notebook_save':
      return service.notebookSave(request as NotebookSaveRequest);
    case 'kernel_list':
      return service.kernelList(request as KernelListRequest);
    case 'kernel_status':
      return service.kernelStatus(request as KernelStatusRequest);
    case 'kernel_control':
      return service.kernelControl(request as KernelControlRequest);
    default:
      throw new Error(`unknown tool ${tool}`);
  }
}

/**
 * Publish a zod schema's JSON Schema without letting the SDK validate with it.
 *
 * The SDK's own pre-dispatch check answers a bad argument with a plain text
 * `Input validation error`, which carries no `code` / `retryable` /
 * `side_effects`. SPEC.md §9 wants one error shape for every failure, so the
 * adapter validates with the same schema inside the handler and builds an
 * `INVALID_ARGUMENT` result itself. `tools/list` still publishes the exact
 * schema, because that comes from `~standard.jsonSchema`.
 */
function publishOnly(schema: z.ZodType): StandardSchemaWithJSON<unknown, unknown> {
  const standard = (schema as unknown as StandardSchemaWithJSON<unknown, unknown>)['~standard'];
  return { '~standard': { ...standard, validate: (value: unknown) => ({ value }) } };
}

// ---------------------------------------------------------------------------
// the server
// ---------------------------------------------------------------------------

/**
 * Build the MCP server for one connection.
 *
 * Register everything once: `serveStdio` calls the factory per connection and
 * pins the instance, so the same registrations serve both protocol eras
 * (docs/SERVICE-DESIGN.md §7.3). Capabilities are `tools` and `resources`
 * without `subscribe`: SPEC.md §9 needs `resources/read` and `resources/list`
 * for our own `jupyter-output:` URIs and explicitly no notifications.
 */
export function createMcpServer(service: CollabService, options: McpServerOptions = {}): McpServer {
  const resolved = resolve(options);
  const server = new McpServer(
    { name: resolved.name, version: resolved.version },
    { capabilities: { tools: {}, resources: {} } }
  );
  const references = new ReferenceAliases();

  for (const spec of TOOL_SPECS) registerTool(server, service, spec, resolved, references);
  registerOutputResources(server, service, resolved, references);

  return server;
}

function registerTool(
  server: McpServer,
  service: CollabService,
  spec: ToolSpec,
  options: ResolvedOptions,
  references: ReferenceAliases
): void {
  server.registerTool(
    spec.name,
    {
      title: spec.title,
      description: spec.description,
      inputSchema: publishOnly(spec.input),
      outputSchema: fromJsonSchema(spec.output),
      annotations: {
        title: spec.title,
        readOnlyHint: spec.readOnly,
        destructiveHint: spec.name === 'kernel_control',
        idempotentHint: spec.deduplicated,
        openWorldHint: true
      }
    },
    async (rawArgs: unknown): Promise<CallToolResult> => {
      const parsed = spec.input.safeParse(rawArgs ?? {});
      if (!parsed.success) {
        options.log('debug', `${spec.name}: invalid arguments`);
        return invalidArgument(spec.name, parsed.error.issues, options.responseMaxBytes, references);
      }
      try {
        const request = references.resolveValue(parsed.data as unknown as WireValue);
        const result = await dispatch(service, spec.name, fromWire(request));
        return buildResult(spec.name, result, options, references);
      } catch (thrown) {
        options.log('debug', `${spec.name}: ${toWireError(thrown).code}`);
        return errorResult(thrown, options.responseMaxBytes, references);
      }
    }
  );
}

/** Assemble content blocks and `structuredContent` from a service result. */
function buildResult(
  tool: string,
  result: unknown,
  options: ResolvedOptions,
  references: ReferenceAliases
): CallToolResult {
  const wire = references.presentValue(publicResult(toWire(result)));
  const base: WireObject = typeof wire === 'object' && wire !== null && !Array.isArray(wire) ? wire : { result: wire };
  const extracted = extractOutputContent(tool, base, options);
  let bounded;
  try {
    bounded = boundPayload(extracted.payload, options.responseMaxBytes);
  } catch (error) {
    if (!(error instanceof WireBudgetError)) throw error;
    const executionId =
      typeof extracted.payload['execution_id'] === 'string'
        ? extracted.payload['execution_id']
        : undefined;
    const requestAccepted =
      typeof extracted.payload['request_accepted'] === 'boolean'
        ? extracted.payload['request_accepted']
        : undefined;
    const nextRequestId =
      typeof extracted.payload['next_request_id'] === 'string' ||
      extracted.payload['next_request_id'] === null
        ? extracted.payload['next_request_id']
        : undefined;
    throw coreError(
      'RESOURCE_LIMIT',
      `${tool} cannot fit one recoverable result in the response budget; retry with smaller limits or a narrower cell selection`,
      {
        details: {
          byte_size: error.byteSize,
          max_bytes: error.maxBytes,
          ...(executionId === undefined ? {} : { execution_id: executionId }),
          ...(requestAccepted === undefined ? {} : { request_accepted: requestAccepted }),
          ...(nextRequestId === undefined ? {} : { next_request_id: nextRequestId })
        },
        sideEffects:
          TOOL_SPECS_BY_NAME.get(tool)?.readOnly === true
            ? 'none'
            : requestAccepted === true
              ? 'applied'
              : 'unknown'
      }
    );
  }
  const text = boundText(renderText(tool, bounded.payload), options.responseMaxBytes).text;
  return {
    content: [{ type: 'text', text }, ...extracted.blocks],
    structuredContent: bounded.payload
  };
}

/** Expose connection lifetime without rewriting arbitrary notebook values. */
function publicResult(value: WireValue): WireValue {
  if (Array.isArray(value)) return value.map(publicResult);
  if (!isObject(value)) return value;
  const result: WireObject = {};
  for (const [key, child] of Object.entries(value)) {
    if (key === 'session_id') continue;
    if (OPAQUE_KEYS.has(key)) {
      result[key] = child;
    } else if (key === 'lifetime' && isObject(child)) {
      result[key] = {
        ...child,
        scope: child['scope'] === 'until_session_close' ? 'until_connection_close' : child['scope']!,
        released_by: Array.isArray(child['released_by'])
          ? child['released_by'].map((event) => event === 'session_close' ? 'connection_close' : event)
          : []
      };
    } else result[key] = publicResult(child);
  }
  return result;
}

function registerOutputResources(
  server: McpServer,
  service: CollabService,
  options: ResolvedOptions,
  references: ReferenceAliases
): void {
  const listSnapshots = async (cursor?: string): Promise<{
    resources: { uri: string; name: string; mimeType: string; description: string }[];
    nextCursor?: string;
  }> => {
    const listed = await service.listOutputResources(cursor);
    return {
      resources: listed.resources.map((entry) => ({
        uri: entry.uri,
        name: references.present('output', entry.outputId),
        mimeType: entry.mimeType,
        description: `Output snapshot of execution ${entry.executionId}, ${String(entry.byteSize)} bytes.`
      })),
      ...(listed.nextCursor === undefined ? {} : { nextCursor: listed.nextCursor })
    };
  };

  type ResourceContents =
    | { uri: string; mimeType?: string; text: string }
    | { uri: string; mimeType?: string; blob: string };

  const readSnapshot = async (uri: URL): Promise<{ contents: ResourceContents[] }> => {
    try {
      const contents = await service.readOutputResource(uri.href);
      if (contents.text !== undefined) {
        return { contents: [{ uri: contents.uri, mimeType: contents.mimeType, text: contents.text }] };
      }
      if (contents.blob !== undefined) {
        return { contents: [{ uri: contents.uri, mimeType: contents.mimeType, blob: contents.blob }] };
      }
      // Too large for one resources/read: SPEC.md §9 says point at the tool
      // rather than invent a partial blob.
      return {
        contents: [
          {
            uri: contents.uri,
            mimeType: 'application/json',
            text: JSON.stringify({
              output_id: references.present('output', contents.outputId),
              mime_type: contents.mimeType,
              byte_size: contents.byteSize,
              truncated: true,
              read_more: `too large for resources/read — call output_read with output_id ${references.present('output', contents.outputId)}`
            })
          }
        ]
      };
    } catch (thrown) {
      const wire = toWireError(thrown);
      options.log('debug', `resources/read ${uri.href}: ${wire.code}`);
      throw new Error(`${wire.code}: ${wire.message}`);
    }
  };

  const metadata = {
    title: 'Notebook output snapshot',
    description:
      'One immutable output snapshot produced by a run. The URI carries no credentials and expires on bounded-store eviction or connection closure (then HANDLE_EXPIRED). Hosts that do not read resources use the output_read tool for the same bytes.'
  };

  // The listing lives on the short form; both templates read, because the URI
  // an answer carries is the long one and `{output_id}` does not span "/".
  server.registerResource(
    'jupyter-output',
    new ResourceTemplate(OUTPUT_URI_TEMPLATE, { list: () => listSnapshots() }),
    metadata,
    readSnapshot
  );
  server.registerResource(
    'jupyter-output-session',
    new ResourceTemplate(OUTPUT_URI_TEMPLATE_SESSION, { list: undefined }),
    metadata,
    readSnapshot
  );
  // McpServer's resource-template aggregation drops the page cursor. Install
  // the protocol handler explicitly so `resources/list` preserves the
  // service's continuation contract across both stdio and HTTP transports.
  server.server.setRequestHandler('resources/list', (request) =>
    listSnapshots(request.params?.cursor)
  );
}
