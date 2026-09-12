/**
 * The `request_id` ledger of SPEC.md §9: all six outcomes, eviction, the
 * behaviour past 4 096 receipts and two concurrent callers of one number.
 */

import { describe, expect, it } from 'vitest';

import { isCoreError, type CoreError } from '../../src/core/index.js';
import { MAX_REQUEST_ID, RequestLedger, parseRequestId, payloadDigest } from '../../src/service/index.js';
import type { LedgerLimits } from '../../src/service/index.js';

const LIMITS: LedgerLimits = {
  maxReceipts: 4,
  requestMaxBytes: 1024,
  receiptMaxBytes: 512
};

function ledger(overrides: Partial<LedgerLimits> = {}): RequestLedger {
  return new RequestLedger({ ...LIMITS, ...overrides });
}

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    return isCoreError(error) ? (error as CoreError).code : `not-core:${String(error)}`;
  }
  return 'no-error';
}

function accept(l: RequestLedger, id: string, payload: unknown = { a: 1 }): void {
  const decision = l.begin({ requestId: id, tool: 'notebook_apply', target: 'nb', payload });
  expect(decision.kind).toBe('accept');
  if (decision.kind === 'accept') l.complete(decision.receipt, { kind: 'value', value: { id } });
}

describe('RequestLedger', () => {
  it('starts at "1" and advances by one', () => {
    const l = ledger();
    expect(l.nextRequestId).toBe('1');
    accept(l, '1');
    expect(l.nextRequestId).toBe('2');
    accept(l, '2');
    expect(l.nextRequestId).toBe('3');
  });

  it('1. replays the stored answer for the same number and payload', () => {
    const l = ledger();
    const first = l.begin({ requestId: '1', tool: 'notebook_apply', target: 'nb', payload: { a: 1 } });
    expect(first.kind).toBe('accept');
    if (first.kind !== 'accept') return;
    l.complete(first.receipt, { kind: 'value', value: { ok: true } });

    const again = l.begin({ requestId: '1', tool: 'notebook_apply', target: 'nb', payload: { a: 1 } });
    expect(again.kind).toBe('replay');
    expect(again.receipt.firstAcceptedAt).toBe(first.receipt.firstAcceptedAt);
    expect(again.receipt.replay).toEqual({ kind: 'value', value: { ok: true } });
    // H did not move: a replay is not a new acceptance.
    expect(l.nextRequestId).toBe('2');
  });

  it('1b. REQUEST_ID_CONFLICT for the same number with a different payload', () => {
    const l = ledger();
    accept(l, '1', { a: 1 });
    expect(
      codeOf(() =>
        l.begin({ requestId: '1', tool: 'notebook_apply', target: 'nb', payload: { a: 2 } })
      )
    ).toBe('REQUEST_ID_CONFLICT');
  });

  it('1c. the target handle is part of the digest', () => {
    const l = ledger();
    accept(l, '1', { a: 1 });
    expect(
      codeOf(() =>
        l.begin({ requestId: '1', tool: 'notebook_apply', target: 'other', payload: { a: 1 } })
      )
    ).toBe('REQUEST_ID_CONFLICT');
  });

  it('2. REQUEST_ID_EXPIRED for a forgotten number below H, without executing', () => {
    const l = ledger({ maxReceipts: 2 });
    accept(l, '1');
    accept(l, '2');
    accept(l, '3'); // evicts the oldest completed receipt, which is "1"
    expect(codeOf(() => l.begin({ requestId: '1', tool: 'notebook_apply', target: 'nb', payload: { a: 1 } }))).toBe(
      'REQUEST_ID_EXPIRED'
    );
    // H is untouched by eviction (SPEC.md §9).
    expect(l.nextRequestId).toBe('4');
  });

  it('3. REQUEST_OUT_OF_ORDER for a number beyond H + 1', () => {
    const l = ledger();
    accept(l, '1');
    expect(codeOf(() => l.begin({ requestId: '5', tool: 'notebook_apply', target: 'nb', payload: {} }))).toBe(
      'REQUEST_OUT_OF_ORDER'
    );
    expect(l.nextRequestId).toBe('2');
  });

  it('4. RESOURCE_LIMIT when every receipt is active, before any effect', () => {
    const l = ledger({ maxReceipts: 2 });
    l.begin({ requestId: '1', tool: 'notebook_execute', target: 'nb', payload: {} });
    l.begin({ requestId: '2', tool: 'notebook_execute', target: 'nb', payload: {} });
    expect(codeOf(() => l.begin({ requestId: '3', tool: 'notebook_execute', target: 'nb', payload: {} }))).toBe(
      'RESOURCE_LIMIT'
    );
    // Rejected before acceptance: the number stays available.
    expect(l.nextRequestId).toBe('3');
  });

  it('4b. RESOURCE_LIMIT when the request itself is over the input budget', () => {
    const l = ledger({ requestMaxBytes: 32 });
    expect(
      codeOf(() =>
        l.begin({ requestId: '1', tool: 'notebook_apply', target: 'nb', payload: { blob: 'x'.repeat(200) } })
      )
    ).toBe('RESOURCE_LIMIT');
    expect(l.nextRequestId).toBe('1');
  });

  it('INVALID_ARGUMENT for a non-canonical number', () => {
    const l = ledger();
    for (const bad of ['0', '01', '', 'abc', '-1', '1.0', ' 1']) {
      expect(codeOf(() => l.begin({ requestId: bad, tool: 'notebook_apply', target: null, payload: {} }))).toBe(
        'INVALID_ARGUMENT'
      );
    }
    expect(l.nextRequestId).toBe('1');
  });

  it('evicts only completed receipts, never an active one', () => {
    const l = ledger({ maxReceipts: 2 });
    const active = l.begin({ requestId: '1', tool: 'notebook_execute', target: 'nb', payload: {} });
    accept(l, '2');
    accept(l, '3'); // "2" is the only evictable receipt
    expect(l.get('1')).toBeDefined();
    expect(l.get('2')).toBeUndefined();
    expect(l.get('3')).toBeDefined();
    expect(active.kind).toBe('accept');
  });

  it('drops the receipt when the stored result exceeds receiptMaxBytes', () => {
    const l = ledger({ receiptMaxBytes: 64 });
    const decision = l.begin({ requestId: '1', tool: 'notebook_apply', target: 'nb', payload: {} });
    if (decision.kind !== 'accept') throw new Error('expected acceptance');
    l.complete(decision.receipt, { kind: 'value', value: { blob: 'y'.repeat(400) } });
    expect(l.get('1')).toBeUndefined();
    // The number stays spent, so a replay is EXPIRED, never a second run.
    expect(codeOf(() => l.begin({ requestId: '1', tool: 'notebook_apply', target: 'nb', payload: {} }))).toBe(
      'REQUEST_ID_EXPIRED'
    );
  });

  it('an execution receipt keeps only the job reference', () => {
    const l = ledger({ receiptMaxBytes: 8 });
    const decision = l.begin({ requestId: '1', tool: 'notebook_execute', target: 'nb', payload: {} });
    if (decision.kind !== 'accept') throw new Error('expected acceptance');
    l.complete(decision.receipt, { kind: 'execution', executionId: 'exec_1' });
    expect(l.get('1')?.replay).toEqual({ kind: 'execution', executionId: 'exec_1' });
  });

  it('a failed operation still spends the number and replays the failure', () => {
    const l = ledger();
    const decision = l.begin({ requestId: '1', tool: 'kernel_control', target: 'nb', payload: {} });
    if (decision.kind !== 'accept') throw new Error('expected acceptance');
    l.fail(decision.receipt, new Error('kernel exploded'), 'unknown');
    expect(l.nextRequestId).toBe('2');
    const again = l.begin({ requestId: '1', tool: 'kernel_control', target: 'nb', payload: {} });
    expect(again.kind).toBe('replay');
    expect(again.receipt.failure?.message).toBe('kernel exploded');
    expect(again.receipt.effects).toBe('unknown');
  });

  it('accepts more than 4 096 operations: memory is bounded, H is not', () => {
    const l = ledger({ maxReceipts: 4096 });
    for (let n = 1; n <= 5000; n += 1) accept(l, String(n), { n });
    expect(l.size).toBe(4096);
    expect(l.nextRequestId).toBe('5001');
    // The oldest numbers were evicted but stay forbidden.
    expect(codeOf(() => l.begin({ requestId: '1', tool: 'notebook_apply', target: 'nb', payload: { n: 1 } }))).toBe(
      'REQUEST_ID_EXPIRED'
    );
    expect(l.get('5000')).toBeDefined();
  });

  it('two concurrent callers of one number produce one acceptance and one replay', async () => {
    const l = ledger();
    // The session lock serialises them; here that is a plain await chain.
    const payload = { cells: ['a'] };
    const first = l.begin({ requestId: '1', tool: 'notebook_execute', target: 'nb', payload });
    if (first.kind !== 'accept') throw new Error('expected acceptance');
    await Promise.resolve();
    l.complete(first.receipt, { kind: 'execution', executionId: 'exec_x' });
    const second = l.begin({ requestId: '1', tool: 'notebook_execute', target: 'nb', payload });
    expect(second.kind).toBe('replay');
    expect(second.receipt.replay).toEqual({ kind: 'execution', executionId: 'exec_x' });
  });

  it('the range is finite: at the top the session accepts no more mutations', () => {
    const l = ledger();
    const top = new RequestLedger(LIMITS);
    expect(parseRequestId(MAX_REQUEST_ID.toString())).toBe(MAX_REQUEST_ID);
    expect(parseRequestId((MAX_REQUEST_ID + 1n).toString())).toBeNull();
    expect(top.nextRequestId).toBe('1');
    expect(l.nextRequestId).toBe('1');
  });

  it('the digest is stable across key order and sensitive to the tool', () => {
    const a = payloadDigest('notebook_apply', 'nb', { x: 1, y: 2 });
    const b = payloadDigest('notebook_apply', 'nb', { y: 2, x: 1 });
    const c = payloadDigest('notebook_execute', 'nb', { x: 1, y: 2 });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it('clear() frees receipts but keeps H', () => {
    const l = ledger();
    accept(l, '1');
    accept(l, '2');
    l.clear();
    expect(l.size).toBe(0);
    expect(l.nextRequestId).toBe('3');
  });
});
