/**
 * The `request_id` ledger of one working session (SPEC.md §9 "Retries,
 * errors, and response size").
 *
 * The session keeps `H` - the highest accepted number - and up to
 * `maxReceipts` compact receipts. Under the session lock, in this order:
 *
 * 1. the number is in the registry and the payload digest matches → the stored
 *    answer is replayed with `replayed: true` and the original
 *    `firstAcceptedAt`; a different payload is `REQUEST_ID_CONFLICT`;
 * 2. the number is missing but `<= H` → `REQUEST_ID_EXPIRED`, nothing runs;
 * 3. the number is `> H + 1` → `REQUEST_OUT_OF_ORDER`;
 * 4. the number is `H + 1` → preconditions and the memory reserve are checked,
 *    then the receipt is created and `H` bumped **before the first effect**.
 *
 * `H` never decreases and is never reset: evicting a receipt frees memory, it
 * never turns an old number back into a new one. Eviction removes the oldest
 * *completed* receipt only; a registry full of active operations refuses the
 * new request with `RESOURCE_LIMIT` before any effect.
 *
 * Outputs are never copied here. A receipt stores either a small result value
 * or a reference to the job that owns the data (SPEC.md §9: "outputs are not
 * copied into the retry ledger"). The memory a receipt may need is reserved at
 * acceptance through {@link BeginRequest.reserveBytes}: a request whose answer
 * would not fit `receiptMaxBytes` is refused with `RESOURCE_LIMIT` while its
 * number is still unused. Completing never drops a receipt, so an operation
 * that ran stays replayable until its slot is evicted by the count limit.
 *
 * @module
 */

import { createHash } from 'node:crypto';

import { canonicalJson, coreError, type JsonValue, type SideEffects } from '../core/index.js';

/** Largest `request_id` a session accepts: the positive 64-bit range. */
export const MAX_REQUEST_ID = (1n << 63n) - 1n;

/** The four deduplicated tools of SPEC.md §9. */
export type DedupTool = 'notebook_create' | 'notebook_apply' | 'notebook_execute' | 'kernel_control';

/**
 * What a replay hands back.
 *
 * `execution` keeps only the job handle: the job itself owns the outputs, so
 * replaying a `notebook_execute` re-reads the live job instead of returning a
 * copy of a possibly huge answer.
 */
export type ReplayPayload =
  | { readonly kind: 'value'; readonly value: unknown }
  | { readonly kind: 'execution'; readonly executionId: string };

/** One compact receipt (SPEC.md §9). */
export interface Receipt {
  readonly requestId: string;
  readonly tool: DedupTool;
  /** Target handle, e.g. the `notebook_id`; `null` for a session-level call. */
  readonly target: string | null;
  readonly digest: string;
  /** RFC 3339 UTC of the *first* acceptance; a replay never moves it. */
  readonly firstAcceptedAt: string;
  /** `active` until the operation finished, whatever the outcome. */
  state: 'active' | 'completed';
  /** Established effects on the document/file/kernel (SPEC.md §9). */
  effects: SideEffects;
  /** Present once the operation succeeded. */
  replay: ReplayPayload | null;
  /** Present once the operation failed; a replay re-throws it. */
  failure: Error | null;
}

/** Outcome of {@link RequestLedger.begin}. */
export type LedgerDecision =
  | { readonly kind: 'replay'; readonly receipt: Receipt }
  | { readonly kind: 'accept'; readonly receipt: Receipt };

/** Arguments of {@link RequestLedger.begin}. */
export interface BeginRequest {
  readonly requestId: string;
  readonly tool: DedupTool;
  readonly target: string | null;
  /** The tool arguments, minus the `request_id` itself. */
  readonly payload: unknown;
  /**
   * Upper bound, in bytes, of the receipt this request may produce. Reserved
   * before the first effect; above `receiptMaxBytes` the request is refused
   * with `RESOURCE_LIMIT` and the number stays unused (SPEC.md §9). Omitted by
   * tools whose answer has a small fixed shape.
   */
  readonly reserveBytes?: number;
}

/** Budgets this ledger enforces before any effect (SPEC.md §9). */
export interface LedgerLimits {
  readonly maxReceipts: number;
  readonly requestMaxBytes: number;
  readonly receiptMaxBytes: number;
}

/** Turn any value into something {@link canonicalJson} accepts. */
function jsonSafe(value: unknown): JsonValue | undefined {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value) ?? 'null') as JsonValue;
}

/** sha256 over the canonical JSON of `{tool, target, args}` (SPEC.md §9). */
export function payloadDigest(tool: string, target: string | null, payload: unknown): string {
  const pre = canonicalJson({ tool, target, args: jsonSafe(payload) ?? null });
  return createHash('sha256').update(pre, 'utf8').digest('hex');
}

/** Parse a canonical decimal `request_id`; `null` when it is not one. */
export function parseRequestId(value: string): bigint | null {
  if (!/^[1-9][0-9]{0,19}$/.test(value)) return null;
  const parsed = BigInt(value);
  return parsed > MAX_REQUEST_ID ? null : parsed;
}

/** The ledger of one working session. Never used across sessions. */
export class RequestLedger {
  readonly #limits: LedgerLimits;
  readonly #receipts = new Map<string, Receipt>();
  readonly #now: () => Date;
  #high = 0n;

  constructor(limits: LedgerLimits, now: () => Date = () => new Date()) {
    this.#limits = limits;
    this.#now = now;
  }

  /** `H`, the highest accepted number. Never decreases. */
  get high(): bigint {
    return this.#high;
  }

  /**
   * `H + 1` as a canonical decimal string, or `null` when the 64-bit range is
   * exhausted and the session accepts no further mutation (SPEC.md §9).
   */
  get nextRequestId(): string | null {
    return this.#high >= MAX_REQUEST_ID ? null : (this.#high + 1n).toString();
  }

  /** Receipts currently retained. */
  get size(): number {
    return this.#receipts.size;
  }

  /** Look up a receipt without touching the ledger. */
  get(requestId: string): Receipt | undefined {
    return this.#receipts.get(requestId);
  }

  /**
   * Resolve every request-number outcome that precedes mutable preconditions.
   * `null` means exactly `H + 1`, so the caller may validate current state and
   * then call {@link begin} to reserve and accept the operation.
   */
  preflight(request: BeginRequest): LedgerDecision | null {
    const parsed = parseRequestId(request.requestId);
    if (parsed === null) {
      throw coreError(
        'INVALID_ARGUMENT',
        'request_id must be the canonical decimal form of a positive 64-bit number',
        { details: { request_id: request.requestId, next_request_id: this.nextRequestId } }
      );
    }
    const existing = this.#receipts.get(request.requestId);
    if (existing !== undefined) {
      const digest = payloadDigest(request.tool, request.target, request.payload);
      if (existing.digest !== digest) {
        throw coreError(
          'REQUEST_ID_CONFLICT',
          `request_id ${request.requestId} was already accepted with a different payload`,
          {
            details: {
              request_id: request.requestId,
              first_accepted_at: existing.firstAcceptedAt,
              tool: existing.tool,
              next_request_id: this.nextRequestId
            }
          }
        );
      }
      return { kind: 'replay', receipt: existing };
    }
    if (parsed <= this.#high) {
      throw coreError(
        'REQUEST_ID_EXPIRED',
        `receipt for request_id ${request.requestId} is gone; its effect cannot be established`,
        {
          details: { request_id: request.requestId, next_request_id: this.nextRequestId }
        }
      );
    }
    if (parsed > this.#high + 1n) {
      throw coreError(
        'REQUEST_OUT_OF_ORDER',
        `request_id ${request.requestId} arrived before ${(this.#high + 1n).toString()}`,
        { details: { request_id: request.requestId, next_request_id: this.nextRequestId } }
      );
    }
    return null;
  }

  /**
   * Apply the SPEC.md §9 rules to one incoming number.
   *
   * @throws CoreError `INVALID_ARGUMENT` - not a canonical decimal number, or
   * the session's range is exhausted.
   * @throws CoreError `REQUEST_ID_CONFLICT` - known number, different payload.
   * @throws CoreError `REQUEST_ID_EXPIRED` - unknown number `<= H`.
   * @throws CoreError `REQUEST_OUT_OF_ORDER` - a number beyond `H + 1`.
   * @throws CoreError `RESOURCE_LIMIT` - the request does not fit the input
   * budget, its receipt does not fit the reservation budget, or no receipt slot
   * can be freed. Nothing ran and the number stays unused in every one of these
   * cases.
   */
  begin(request: BeginRequest): LedgerDecision {
    const preflight = this.preflight(request);
    if (preflight !== null) return preflight;
    const parsed = parseRequestId(request.requestId)!;
    const digest = payloadDigest(request.tool, request.target, request.payload);

    // -- step 4: preconditions and the memory reserve, still before any effect
    const requestBytes = Buffer.byteLength(JSON.stringify(request.payload) ?? 'null', 'utf8');
    if (requestBytes > this.#limits.requestMaxBytes) {
      throw coreError('RESOURCE_LIMIT', 'the tool request exceeds the configured input budget', {
        details: {
          request_bytes: requestBytes,
          limit: this.#limits.requestMaxBytes,
          next_request_id: this.nextRequestId
        }
      });
    }
    const reserveBytes = request.reserveBytes ?? 0;
    if (reserveBytes > this.#limits.receiptMaxBytes) {
      throw coreError('RESOURCE_LIMIT', 'the answer of this request would not fit its receipt', {
        details: {
          receipt_bytes: reserveBytes,
          limit: this.#limits.receiptMaxBytes,
          next_request_id: this.nextRequestId
        }
      });
    }
    this.#reserveSlot();

    const receipt: Receipt = {
      requestId: request.requestId,
      tool: request.tool,
      target: request.target,
      digest,
      firstAcceptedAt: this.#now().toISOString(),
      state: 'active',
      effects: 'none',
      replay: null,
      failure: null
    };
    this.#receipts.set(request.requestId, receipt);
    this.#high = parsed;
    return { kind: 'accept', receipt };
  }

  /**
   * Record the answer of an accepted operation.
   *
   * The size of the answer is never a reason to forget the receipt: what a
   * receipt may cost was reserved at acceptance, so an operation that ran stays
   * replayable until eviction frees its slot (SPEC.md §9).
   */
  complete(receipt: Receipt, replay: ReplayPayload, effects: SideEffects = 'applied'): void {
    receipt.state = 'completed';
    receipt.effects = effects;
    receipt.replay = replay;
  }

  /** Record a failure of an accepted operation; the number stays spent. */
  fail(receipt: Receipt, error: Error, effects: SideEffects): void {
    receipt.state = 'completed';
    receipt.effects = effects;
    receipt.failure = error;
  }

  /** Drop every receipt; `H` is deliberately kept (SPEC.md §9). */
  clear(): void {
    this.#receipts.clear();
  }

  #reserveSlot(): void {
    if (this.#receipts.size < this.#limits.maxReceipts) return;
    for (const [id, receipt] of this.#receipts) {
      if (receipt.state !== 'completed') continue;
      this.#receipts.delete(id);
      return;
    }
    throw coreError(
      'RESOURCE_LIMIT',
      'the request receipt registry is full of active operations; nothing was executed',
      {
        details: {
          receipts: this.#receipts.size,
          limit: this.#limits.maxReceipts,
          next_request_id: this.nextRequestId
        }
      }
    );
  }
}
