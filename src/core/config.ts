/**
 * Process configuration of the service: upstream server profiles, the
 * discovery switch, the SPEC.md §9 budgets and the awareness identity the RTC
 * connection publishes.
 *
 * Types only. Reading a file, resolving `env:` / `file:` credential references
 * and validating URLs belong to the layer that builds a {@link ServiceConfig};
 * this module must stay importable from anywhere in `src/core` without
 * touching the filesystem (SPEC.md §11: credentials are never part of tool
 * arguments and never reach a response).
 *
 * @module
 */

import type { CredentialRef, ServerKind, ServerProfile } from './types.js';

export type { CredentialRef, ServerKind, ServerProfile };

// ---------------------------------------------------------------------------
// limits (SPEC.md §9 "Initial configurable limits")
// ---------------------------------------------------------------------------

/**
 * Configurable budgets of one process.
 *
 * SPEC.md §9 calls these "design values, not measured limits": they are
 * defaults an operator may raise or lower, not measured capacities. Every one
 * of them is checked **before** the effect of a call, so exhausting a budget
 * gives `RESOURCE_LIMIT` (or `DOCUMENT_TOO_LARGE`) without consuming a
 * `request_id` and without touching the document, the file or the kernel.
 *
 * Active handles and active jobs are never evicted to make room for a new one.
 */
export interface ServiceLimits {
  /** Cells listed in one summary. SPEC.md §9 default: 100. */
  readonly summaryMaxCells: number;
  /** UTF-8 budget of one tool response. SPEC.md §9 default: 64 KiB. */
  readonly responseMaxBytes: number;
  /**
   * Upper bound of `wait_ms` in any single tool call. SPEC.md §9 default:
   * 30 s. A larger `wait_ms` argument is clamped, not rejected; the wait ending
   * never interrupts the computation (SPEC.md §8).
   */
  readonly maxWaitMs: number;
  /** Entries in one notebook's change journal. SPEC.md §9 default: 10 000. */
  readonly journalMaxEvents: number;
  /**
   * Open notebook replicas per process. SPEC.md §9 default: 32. Two working
   * sessions on the same notebook are two replicas and count twice (SPEC.md §4).
   */
  readonly maxOpenNotebooks: number;
  /** Working sessions per process. SPEC.md §9 default: 64. */
  readonly maxSessions: number;
  /**
   * Request receipts kept per working session. SPEC.md §9: up to 4 096.
   * Eviction removes the oldest *completed* receipt only, and never lowers `H`.
   */
  readonly maxReceiptsPerSession: number;
  /**
   * Size of one accepted tool request, checked before the effect (SPEC.md §9:
   * "The input request size and compact receipt are also limited and checked
   * before the effect").
   */
  readonly requestMaxBytes: number;
  /**
   * Memory a single receipt may reserve. Outputs are never copied into the
   * dedup ledger; a receipt stores the job reference instead (SPEC.md §9).
   */
  readonly receiptMaxBytes: number;
  /**
   * Output bytes collected for one execution job. On overflow the cell is
   * marked `output_incomplete` and the kernel is **not** interrupted
   * (SPEC.md §9).
   */
  readonly executionOutputMaxBytes: number;
  /**
   * Separate budget of one `resources/read` answer (SPEC.md §9). A snapshot
   * that does not fit is not inlined: the caller pages through `output_read`.
   */
  readonly resourceReadMaxBytes: number;
}

/**
 * SPEC.md §9 defaults, transcribed literally.
 *
 * `executionOutputMaxBytes` is the one value SPEC.md does not name: 750 KiB is
 * the per-job collection budget the existing execution path already uses.
 */
export const DEFAULT_SERVICE_LIMITS: ServiceLimits = Object.freeze({
  summaryMaxCells: 100,
  responseMaxBytes: 64 * 1024,
  maxWaitMs: 30_000,
  journalMaxEvents: 10_000,
  maxOpenNotebooks: 32,
  maxSessions: 64,
  maxReceiptsPerSession: 4096,
  requestMaxBytes: 256 * 1024,
  receiptMaxBytes: 4 * 1024,
  executionOutputMaxBytes: 750 * 1024,
  resourceReadMaxBytes: 1024 * 1024
});

// ---------------------------------------------------------------------------
// awareness identity (SPEC.md §6, §10)
// ---------------------------------------------------------------------------

/**
 * The Yjs awareness state this client publishes on every room it joins.
 *
 * SPEC.md §10: presence shows the assistant's name and colour and disappears
 * on disconnect; it is never an authorship proof or a lock. SPEC.md §6: the
 * same awareness state carries `autosave: true`, which keeps the server's
 * debounced autosave enabled even when a browser publishes `autosave: false`.
 * The `autosave` flag is not configurable and therefore not a field here.
 */
export interface AwarenessUser {
  /** Display name shown to humans in JupyterLab. Never a credential. */
  readonly name: string;
  /** `#rrggbb`. JupyterLab renders the cursor/presence badge with it. */
  readonly color: string;
}

/** Neutral default identity; an operator may override both fields. */
export const DEFAULT_AWARENESS_USER: AwarenessUser = Object.freeze({
  name: 'Assistant (MCP)',
  color: '#0f766e'
});

// ---------------------------------------------------------------------------
// discovery (SPEC.md §11, docs/CONNECTIONS.md §9)
// ---------------------------------------------------------------------------

/**
 * Whether the process may add servers found in the local Jupyter runtime
 * directory to the explicitly configured {@link ServiceConfig.servers}.
 *
 * SPEC.md §11: discovery returns URLs, the root and safe identifiers only, and
 * an explicit configuration is never silently replaced by a discovered local
 * server. With `false` the process uses configured profiles only, which is the
 * safe default for anything but a developer machine.
 */
export type DiscoveryMode = boolean;

// ---------------------------------------------------------------------------
// service configuration
// ---------------------------------------------------------------------------

/**
 * Fully resolved configuration of one service process.
 *
 * Profiles follow docs/CONNECTIONS.md §9: `id`, `kind`, `apiBaseUrl`,
 * optional `wsBaseUrl` / `browserBaseUrl`, a `credentialRef` (a reference,
 * never the secret) and the explicit TLS/proxy trust references. Tools only
 * ever choose an allowed `id`; no tool argument carries a URL or a token
 * (SPEC.md §11).
 */
export interface ServiceConfig {
  /**
   * Operator-supplied profiles, in preference order. An empty list is legal
   * only together with {@link discovery} `true`; otherwise every session_open
   * fails with `SERVER_NOT_FOUND`.
   *
   * Ids are unique. When more than one profile matches and the caller passed
   * no `server_id`, `session_open` fails with `SERVER_SELECTION_REQUIRED`
   * rather than guessing (SPEC.md §6 item 1).
   */
  readonly servers: readonly ServerProfile[];
  /** See {@link DiscoveryMode}. */
  readonly discovery: DiscoveryMode;
  readonly limits: ServiceLimits;
  readonly awarenessUser: AwarenessUser;
}

/**
 * What a configuration loader accepts before defaults are applied.
 *
 * Only `servers` has no default: a process with neither profiles nor discovery
 * has nothing to connect to.
 */
export interface ServiceConfigInput {
  readonly servers?: readonly ServerProfile[];
  readonly discovery?: DiscoveryMode;
  /** Partial override; unspecified budgets keep {@link DEFAULT_SERVICE_LIMITS}. */
  readonly limits?: Partial<ServiceLimits>;
  readonly awarenessUser?: Partial<AwarenessUser>;
}

/**
 * Apply the SPEC.md §9 defaults to a partial configuration.
 *
 * Pure and dependency-free on purpose: resolving credentials, reading files
 * and validating URLs happen elsewhere, so this stays usable in unit tests.
 */
export function withDefaults(input: ServiceConfigInput): ServiceConfig {
  return {
    servers: input.servers ?? [],
    discovery: input.discovery ?? false,
    limits: { ...DEFAULT_SERVICE_LIMITS, ...input.limits },
    awarenessUser: { ...DEFAULT_AWARENESS_USER, ...input.awarenessUser }
  };
}
