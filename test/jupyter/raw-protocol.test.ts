/**
 * SPEC.md §5 (RAW type 2 vs y-websocket messageAuth) and §6 (close-code table).
 */
import * as decoding from 'lib0/decoding';
import { describe, expect, it } from 'vitest';

import {
  MESSAGE_RAW,
  encodeRawJson,
  encodeRawSaveRequest,
  parseRawPayload,
  readRawFrame,
  readRawMessage
} from '../../src/jupyter/raw-protocol.js';
import { classifyClose, parseSessionRejection } from '../../src/jupyter/close-codes.js';

describe('RAW frames', () => {
  it('encodes the save request as varUint(2) varString("save") varUint(id)', () => {
    const frame = encodeRawSaveRequest(7);
    const decoder = decoding.createDecoder(frame);
    expect(decoding.readVarUint(decoder)).toBe(MESSAGE_RAW);
    expect(decoding.readVarString(decoder)).toBe('save');
    expect(decoding.readVarUint(decoder)).toBe(7);
  });

  it('round-trips a save reply through the handler shape', () => {
    const frame = encodeRawJson({ type: 'save', responseTo: 7, status: 'success' });
    const { type, decoder } = readRawFrame(frame);
    expect(type).toBe(MESSAGE_RAW);
    expect(readRawMessage(decoder)).toEqual({
      kind: 'save-reply',
      responseTo: 7,
      status: 'success'
    });
  });

  it('classifies conflict, unknown and unparsable payloads', () => {
    expect(parseRawPayload('{"type":"conflict"}')).toEqual({
      kind: 'conflict',
      payload: { type: 'conflict' }
    });
    expect(parseRawPayload('{"type":"save","responseTo":"1","status":"success"}').kind).toBe(
      'unknown'
    );
    expect(parseRawPayload('{"type":"save","responseTo":1,"status":"weird"}').kind).toBe('unknown');
    expect(parseRawPayload('not json')).toEqual({ kind: 'unparsable', text: 'not json' });
    expect(parseRawPayload('null').kind).toBe('unknown');
  });

  it('accepts every documented save status', () => {
    for (const status of ['success', 'skipped', 'failed'] as const) {
      expect(parseRawPayload(JSON.stringify({ type: 'save', responseTo: 1, status }))).toEqual({
        kind: 'save-reply',
        responseTo: 1,
        status
      });
    }
  });
});

describe('classifyClose', () => {
  it('maps 1003 session rejections (SPEC.md §6 table)', () => {
    for (const reason of ['unknown_session', 'version_mismatch']) {
      const payload = JSON.stringify({ reason, sessionId: 'sid', reloadable: true });
      const disposition = classifyClose(1003, payload);
      expect(disposition.kind).toBe('terminal');
      if (disposition.kind !== 'terminal') throw new Error('unreachable');
      expect(disposition.errorCode).toBe('RTC_SESSION_REJECTED');
      expect(disposition.rejection?.reloadable).toBe(true);
    }
  });

  it('maps 1003 initialization_error and unparsable reasons to the same code', () => {
    const known = classifyClose(1003, JSON.stringify({ reason: 'initialization_error' }));
    const garbage = classifyClose(1003, 'not json at all');
    const empty = classifyClose(1003, '');
    for (const disposition of [known, garbage, empty]) {
      expect(disposition.kind).toBe('terminal');
      if (disposition.kind !== 'terminal') throw new Error('unreachable');
      expect(disposition.errorCode).toBe('RTC_INITIALIZATION_FAILED');
    }
  });

  it('maps 4400/4404/4500 and treats everything else as transient', () => {
    const bad = classifyClose(4400, '');
    const missing = classifyClose(4404, '');
    expect(bad.kind === 'terminal' && bad.errorCode).toBe('RTC_BAD_REQUEST');
    expect(missing.kind === 'terminal' && missing.errorCode).toBe('NOTEBOOK_NOT_FOUND');
    expect(classifyClose(4500, '').kind).toBe('init-retry');
    expect(classifyClose(4499, '').kind).toBe('terminal');
    expect(classifyClose(1006, '').kind).toBe('transient');
    expect(classifyClose(1001, '').kind).toBe('transient');
    expect(classifyClose(1000, '').kind).toBe('transient');
  });

  it('parses only well-formed rejection payloads', () => {
    expect(parseSessionRejection('{"reason":"x"}')).toEqual({ reason: 'x' });
    expect(parseSessionRejection('{"noreason":1}')).toBeNull();
    expect(parseSessionRejection('[]')).toBeNull();
    expect(parseSessionRejection('')).toBeNull();
  });
});
