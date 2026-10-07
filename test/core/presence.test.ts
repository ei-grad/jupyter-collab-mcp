/**
 * Presence identity derivation and sanitization (SPEC.md §10 "Presence").
 */
import { describe, expect, it } from 'vitest';

import {
  agentUsername,
  isAnonymousJupyterIdentity,
  normalizePresenceColor,
  presenceUser,
  sanitizeDeclaration,
  sanitizePresenceText,
  type PresenceOwner
} from '../../src/core/index.js';

const ALICE: PresenceOwner = { name: 'alice', source: 'configured' };
const FALLBACK = { name: 'Assistant (MCP)', color: '#0f766e' };

describe('sanitizePresenceText', () => {
  it('removes bidi and zero-width format characters and turns controls into spaces', () => {
    expect(sanitizePresenceText('Bot‮ nimda‬​', 64)).toBe('Bot nimda');
    expect(sanitizePresenceText('a\nb\tc\u0007d e', 64)).toBe('a b c d e');
    expect(sanitizePresenceText('  ⁦⁩ ', 64)).toBeUndefined();
    expect(sanitizePresenceText(42, 64)).toBeUndefined();
  });

  it('caps by code points without splitting a surrogate pair', () => {
    const capped = sanitizePresenceText('😀'.repeat(10), 4)!;
    expect([...capped]).toHaveLength(4);
    expect(capped).toBe('😀😀😀…');
  });
});

describe('normalizePresenceColor', () => {
  it('accepts only #rrggbb', () => {
    expect(normalizePresenceColor('#A1b2C3')).toBe('#a1b2c3');
    for (const bad of ['red', '#abc', '#12345678', 'url(x)', '#12345g', undefined]) {
      expect(normalizePresenceColor(bad), String(bad)).toBeUndefined();
    }
  });
});

describe('sanitizeDeclaration', () => {
  it('rejects a name that is empty after sanitization and drops an invalid color', () => {
    expect(sanitizeDeclaration({ name: '​\n' }).declaration).toBeNull();
    const result = sanitizeDeclaration({ name: 'Claude', task: '  ', color: 'red' });
    expect(result.declaration).toEqual({ name: 'Claude' });
    expect(result.colorApplied).toBe(false);
    expect(sanitizeDeclaration({ name: 'Claude', color: '#112233' }).colorApplied).toBe(true);
  });
});

describe('presenceUser', () => {
  it('derives a username that never equals the owner and differs per context', () => {
    const first = presenceUser({ owner: ALICE, contextTag: 'aaaa1111', declaration: null, clientInfo: null, fallback: FALLBACK });
    const second = presenceUser({ owner: ALICE, contextTag: 'bbbb2222', declaration: null, clientInfo: null, fallback: FALLBACK });
    expect(first.username).toBe(agentUsername('alice', 'aaaa1111'));
    expect(first.username).toBe('alice~agent-aaaa1111');
    expect(first.username).not.toBe('alice');
    expect(second.username).not.toBe(first.username);
  });

  it('publishes the full IUser shape with fixed initials and the owner marker last', () => {
    const user = presenceUser({
      owner: ALICE,
      contextTag: 'aaaa1111',
      declaration: { name: 'Claude Code', model: 'opus', task: 'fix plots', color: '#112233' },
      clientInfo: { name: 'ignored' },
      fallback: FALLBACK
    });
    expect(user).toEqual({
      username: 'alice~agent-aaaa1111',
      name: 'Claude Code (agent of alice)',
      display_name: 'Claude Code · opus · fix plots (agent of alice)',
      initials: 'AI',
      color: '#112233',
      avatar_url: null
    });
  });

  it('defaults to clientInfo, then to the operator name and colour', () => {
    const fromClient = presenceUser({
      owner: ALICE, contextTag: 't', declaration: null,
      clientInfo: { name: 'claude-code', title: 'Claude Code', version: '2.1.0' }, fallback: FALLBACK
    });
    expect(fromClient.display_name).toBe('Claude Code 2.1.0 (agent of alice)');
    const fromOperator = presenceUser({ owner: ALICE, contextTag: 't', declaration: null, clientInfo: null, fallback: { name: 'Ops bot', color: 'nope' } });
    expect(fromOperator.display_name).toBe('Ops bot (agent of alice)');
    expect(fromOperator.color).toBe('#0f766e');
  });

  it('marks an unknown owner instead of naming the fallback', () => {
    const user = presenceUser({
      owner: { name: 'mcp-0123abcd', source: 'unknown' }, contextTag: 't', declaration: { name: 'Bot' }, clientInfo: null, fallback: FALLBACK
    });
    expect(user.username).toBe('mcp-0123abcd~agent-t');
    expect(user.display_name).toBe('Bot (agent, owner unknown)');
  });
});

describe('isAnonymousJupyterIdentity', () => {
  it('recognises the random identity of a shared-token server', () => {
    expect(isAnonymousJupyterIdentity({ username: '0123456789abcdef0123456789abcdef', name: 'Anonymous Io' })).toBe(true);
    expect(isAnonymousJupyterIdentity({ username: 'alice', name: 'Alice' })).toBe(false);
    expect(isAnonymousJupyterIdentity({ username: '0123456789abcdef0123456789abcdef', name: 'Alice' })).toBe(false);
  });
});
