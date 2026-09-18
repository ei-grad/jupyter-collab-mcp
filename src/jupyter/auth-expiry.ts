import { coreError } from '../core/index.js';

/** Expiry-only guard: signature and identity validation belong to the gateway. */
export function assertionDeadline(assertion: string, expiresAt?: number): number {
  try {
    const parts = assertion.split('.');
    if (parts.length !== 3) throw new Error();
    const payload: unknown = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8'));
    const exp = (payload as { exp?: unknown } | null)?.exp;
    if (typeof exp !== 'number' || !Number.isFinite(exp) || exp * 1000 <= Date.now()) {
      throw new Error();
    }
    const deadline = Math.min(exp, expiresAt ?? exp) * 1000;
    if (!Number.isFinite(deadline) || deadline <= Date.now()) throw new Error();
    return deadline;
  } catch {
    throw coreError('AUTH_REQUIRED', 'assertion is expired or has no valid expiry');
  }
}
