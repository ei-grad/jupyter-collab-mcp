/**
 * Agent presence published in JupyterLab awareness (SPEC.md §10 "Presence").
 *
 * Pure derivation of the JupyterLab `IUser` this client publishes in every
 * room. Two layers feed it and never mix:
 *
 * - the **owner**, controlled by the operator or the authenticated Jupyter
 *   server and never by tool arguments. It names the human the agent acts for
 *   and forms the `username` key JupyterLab groups and filters presence by;
 * - the **declaration**, self-reported by the agent (`session_identify`, or
 *   MCP `clientInfo` by default). It only decorates display text.
 *
 * Neither layer is an authorization identity, an authorship proof or a lock.
 *
 * @module
 */

/** Character caps applied after sanitization (SPEC.md §10). */
export const PRESENCE_LIMITS = Object.freeze({
  name: 64,
  model: 64,
  task: 120,
  owner: 64,
  version: 32
});

/** `IUser.initials` of every agent; fixed so an avatar never imitates a person. */
export const AGENT_INITIALS = 'AI';

/** Colour used when neither the agent nor the operator supplies a valid one. */
export const DEFAULT_PRESENCE_COLOR = '#0f766e';

/** JupyterLab `IUser` as published in awareness `user`. */
export interface PresenceUser {
  readonly username: string;
  readonly name: string;
  readonly display_name: string;
  readonly initials: string;
  readonly color: string;
  readonly avatar_url: null;
}

/** Sanitized self-declaration of `session_identify`. */
export interface PresenceDeclaration {
  readonly name: string;
  readonly model?: string;
  readonly task?: string;
  readonly color?: string;
}

/** The subset of MCP `clientInfo` presence reads. */
export interface PresenceClientInfo {
  readonly name?: string | undefined;
  readonly title?: string | undefined;
  readonly version?: string | undefined;
}

/**
 * Where the owner came from: operator configuration, the Jupyter server's
 * authenticated non-anonymous identity, or neither (a per-process fallback).
 */
export type PresenceOwnerSource = 'configured' | 'jupyter' | 'unknown';

export interface PresenceOwner {
  readonly name: string;
  readonly source: PresenceOwnerSource;
}

const LINE_BREAKING = /[\p{Cc}\p{Zl}\p{Zp}]/gu;
// Format characters include the bidi embeddings, overrides and isolates
// (U+202A-U+202E, U+2066-U+2069), marks (U+200E/F, U+061C) and zero-width
// joiners, any of which could reorder or hide the owner marker.
const FORMAT = /\p{Cf}/gu;

/**
 * Remove control, line-separator and format characters, collapse whitespace
 * and cap the result at `maxChars` code points. `undefined` for a non-string
 * or a value that is empty afterwards.
 */
export function sanitizePresenceText(value: unknown, maxChars: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const cleaned = value.replace(FORMAT, '').replace(LINE_BREAKING, ' ').replace(/\s+/gu, ' ').trim();
  if (cleaned === '') return undefined;
  const chars = [...cleaned];
  if (chars.length <= maxChars) return cleaned;
  return `${chars.slice(0, Math.max(maxChars - 1, 0)).join('').trimEnd()}…`;
}

/** Lower-case `#rrggbb`, or `undefined` for anything else. */
export function normalizePresenceColor(value: unknown): string | undefined {
  return typeof value === 'string' && /^#[0-9a-f]{6}$/iu.test(value) ? value.toLowerCase() : undefined;
}

/**
 * Sanitize a `session_identify` payload. `declaration` is `null` when the
 * name is empty after sanitization; an invalid colour is dropped and reported
 * through `colorApplied: false` rather than rejected.
 */
export function sanitizeDeclaration(input: {
  readonly name: unknown;
  readonly model?: unknown;
  readonly task?: unknown;
  readonly color?: unknown;
}): { readonly declaration: PresenceDeclaration | null; readonly colorApplied: boolean } {
  const name = sanitizePresenceText(input.name, PRESENCE_LIMITS.name);
  const model = sanitizePresenceText(input.model, PRESENCE_LIMITS.model);
  const task = sanitizePresenceText(input.task, PRESENCE_LIMITS.task);
  const color = normalizePresenceColor(input.color);
  const colorApplied = input.color === undefined || color !== undefined;
  if (name === undefined) return { declaration: null, colorApplied };
  return {
    declaration: {
      name,
      ...(model === undefined ? {} : { model }),
      ...(task === undefined ? {} : { task }),
      ...(color === undefined ? {} : { color })
    },
    colorApplied
  };
}

/** Default display name from MCP `clientInfo`: title (or name) plus version. */
export function clientInfoDisplayName(info: PresenceClientInfo | null | undefined): string | undefined {
  if (info === null || info === undefined) return undefined;
  const base = sanitizePresenceText(info.title, PRESENCE_LIMITS.name) ?? sanitizePresenceText(info.name, PRESENCE_LIMITS.name);
  if (base === undefined) return undefined;
  const version = sanitizePresenceText(info.version, PRESENCE_LIMITS.version);
  return sanitizePresenceText(version === undefined ? base : `${base} ${version}`, PRESENCE_LIMITS.name);
}

/** Sanitized owner name, or `undefined` when nothing usable remains. */
export function sanitizeOwner(value: unknown): string | undefined {
  return sanitizePresenceText(value, PRESENCE_LIMITS.owner);
}

/**
 * Awareness `username` of one agent: `<owner>~agent-<context tag>`.
 *
 * JupyterLab's collaborators panel hides entries whose username equals the
 * viewer's own and groups entries by username, so the suffix keeps the agent
 * visible to its owner and keeps two agents of one owner apart.
 */
export function agentUsername(owner: string, contextTag: string): string {
  return `${owner}~agent-${contextTag}`;
}

/** Suffix appended to every rendered name; it always names the owner. */
export function ownerMarker(owner: PresenceOwner): string {
  return owner.source === 'unknown' ? ' (agent, owner unknown)' : ` (agent of ${owner.name})`;
}

/** Inputs of {@link presenceUser}. */
export interface PresenceUserInput {
  readonly owner: PresenceOwner;
  readonly contextTag: string;
  readonly declaration: PresenceDeclaration | null;
  readonly clientInfo: PresenceClientInfo | null;
  /** Operator `awarenessUser`: default display name and colour. */
  readonly fallback: { readonly name: string; readonly color: string };
}

/**
 * The `IUser` one agent publishes. Display precedence: declaration, then
 * `clientInfo`, then the operator default. The owner marker is appended last,
 * outside anything the agent controls.
 */
export function presenceUser(input: PresenceUserInput): PresenceUser {
  const declaration = input.declaration;
  const name =
    declaration?.name ??
    clientInfoDisplayName(input.clientInfo) ??
    sanitizePresenceText(input.fallback.name, PRESENCE_LIMITS.name) ??
    'Assistant';
  const label = [name, declaration?.model, declaration?.task]
    .filter((part): part is string => part !== undefined)
    .join(' · ');
  const marker = ownerMarker(input.owner);
  return {
    username: agentUsername(input.owner.name, input.contextTag),
    name: `${name}${marker}`,
    display_name: `${label}${marker}`,
    initials: AGENT_INITIALS,
    color: declaration?.color ?? normalizePresenceColor(input.fallback.color) ?? DEFAULT_PRESENCE_COLOR,
    avatar_url: null
  };
}

/**
 * `true` for the identity `jupyter_server` generates per token-authenticated
 * request when no real user exists: a random 32-hex username and
 * `Anonymous <moon>` name. It changes between requests and names nobody.
 */
export function isAnonymousJupyterIdentity(identity: { readonly username: string; readonly name?: string | null }): boolean {
  return /^[0-9a-f]{32}$/u.test(identity.username) && (identity.name ?? '').startsWith('Anonymous ');
}
