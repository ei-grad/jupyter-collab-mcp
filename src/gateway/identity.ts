import { createHash } from 'node:crypto';

import {
  createRemoteJWKSet,
  customFetch,
  errors,
  jwtVerify,
  type JWTVerifyOptions,
  type JWTVerifyGetKey
} from 'jose';

import type { UsernameMode } from './config.js';

export interface IdentityVerifierOptions {
  readonly issuer: string;
  readonly audience: string;
  readonly jwksUri: URL;
  readonly emailDomain: string;
  readonly usernameMode: UsernameMode;
  readonly allowedUsers: ReadonlySet<string>;
  readonly allowMissingEmailVerified?: boolean;
  readonly now?: () => number;
  readonly getKey?: JWTVerifyGetKey;
  readonly fetchImpl?: typeof fetch;
}

export interface IdentityBinding {
  readonly issuer: string;
  readonly subject: string;
  readonly username: string;
  readonly nonce?: string;
  readonly authTime?: number;
}

export class AccessIdentity {
  readonly issuer: string;
  readonly subject: string;
  readonly username: string;
  readonly expiresAt: number;
  readonly scopes: readonly string[];
  readonly grantId?: string;
  readonly grantExpiresAt?: number;
  readonly grantGeneration?: number;
  readonly requestExpiresAt?: number;
  readonly #assertion: string;
  readonly #nonce: string | undefined;
  readonly #authTime: number | undefined;

  constructor(init: {
    readonly issuer: string;
    readonly subject: string;
    readonly username: string;
    readonly expiresAt: number;
    readonly assertion: string;
    readonly scopes?: readonly string[];
    readonly grantId?: string;
    readonly grantExpiresAt?: number;
    readonly grantGeneration?: number;
    readonly requestExpiresAt?: number;
    readonly nonce?: string;
    readonly authTime?: number;
  }) {
    this.issuer = init.issuer;
    this.subject = init.subject;
    this.username = init.username;
    this.expiresAt = init.expiresAt;
    this.#assertion = init.assertion;
    this.#nonce = init.nonce;
    this.#authTime = init.authTime;
    if (init.grantId !== undefined) this.grantId = init.grantId;
    if (init.grantExpiresAt !== undefined) this.grantExpiresAt = init.grantExpiresAt;
    if (init.grantGeneration !== undefined) this.grantGeneration = init.grantGeneration;
    if (init.requestExpiresAt !== undefined) this.requestExpiresAt = init.requestExpiresAt;
    this.scopes = Object.freeze([...(init.scopes ?? ['openid', 'email'])]);
    Object.freeze(this);
  }

  assertion(): string {
    return this.#assertion;
  }

  principal(): readonly [string, string] {
    return [this.issuer, this.subject] as const;
  }

  assertionDigest(): string {
    return createHash('sha256').update(this.#assertion).digest('base64url');
  }

  binding(): IdentityBinding {
    return {
      issuer: this.issuer, subject: this.subject, username: this.username,
      ...(this.#nonce === undefined ? {} : { nonce: this.#nonce }),
      ...(this.#authTime === undefined ? {} : { authTime: this.#authTime })
    };
  }

  forGrant(grantId: string, grantExpiresAt: number, grantGeneration: number, requestExpiresAt: number): AccessIdentity {
    return new AccessIdentity({
      ...this.binding(), expiresAt: this.expiresAt, assertion: this.#assertion,
      scopes: this.scopes, grantId, grantExpiresAt, grantGeneration, requestExpiresAt
    });
  }

  toJSON(): Record<string, unknown> {
    return {
      issuer: this.issuer,
      subject: this.subject,
      username: this.username,
      expiresAt: this.expiresAt,
      scopes: this.scopes
    };
  }
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const IDENTITY_FAILURE_REASONS = [
  'invalid_token', 'invalid_claims', 'signature', 'issuer', 'audience',
  'expired', 'not_yet_valid', 'email_verified_missing', 'email_not_verified',
  'email_domain', 'user_not_allowed', 'principal_changed', 'nonce_mismatch',
  'auth_time_mismatch', 'unknown'
] as const;

type IdentityFailureReason = typeof IDENTITY_FAILURE_REASONS[number];

export class IdentityVerificationError extends Error {
  constructor(readonly reason: IdentityFailureReason) {
    super('access ID token is missing or invalid');
  }
}

export function identityFailureReason(error: unknown): IdentityFailureReason | 'unknown' {
  return error instanceof IdentityVerificationError && IDENTITY_FAILURE_REASONS.includes(error.reason)
    ? error.reason : 'unknown';
}

function jwtFailureReason(error: unknown): IdentityFailureReason {
  if (error instanceof errors.JWSSignatureVerificationFailed) return 'signature';
  if (error instanceof errors.JWTExpired) return 'expired';
  if (error instanceof errors.JWTClaimValidationFailed) {
    switch (error.claim) {
      case 'iss': return 'issuer';
      case 'aud': return 'audience';
      case 'nbf': return 'not_yet_valid';
      default: return 'invalid_claims';
    }
  }
  return error instanceof errors.JOSEError ? 'invalid_token' : 'unknown';
}

export class IdentityVerifier {
  readonly #options: IdentityVerifierOptions;
  readonly #getKey: JWTVerifyGetKey;

  constructor(options: IdentityVerifierOptions) {
    if (options.jwksUri.protocol !== 'https:' || options.jwksUri.hostname === '') {
      throw new Error('OIDC JWKS URI must use HTTPS');
    }
    this.#options = { ...options, allowedUsers: new Set(options.allowedUsers) };
    this.#getKey =
      options.getKey ??
      createRemoteJWKSet(
        options.jwksUri,
        options.fetchImpl === undefined ? {} : { [customFetch]: options.fetchImpl }
      );
  }

  async verify(assertion: string, expected?: IdentityBinding): Promise<AccessIdentity> {
    if (assertion === '') throw new IdentityVerificationError('invalid_token');
    const now = this.#options.now?.() ?? Date.now() / 1000;
    const checks: JWTVerifyOptions = {
      issuer: this.#options.issuer,
      audience: this.#options.audience,
      algorithms: ['RS256'],
      currentDate: new Date(now * 1000)
    };
    let payload: Awaited<ReturnType<typeof jwtVerify>>['payload'];
    try {
      ({ payload } = await jwtVerify(assertion, this.#getKey, checks));
    } catch (error) {
      throw new IdentityVerificationError(jwtFailureReason(error));
    }
    const { exp, nbf = 0, iss, sub, email, email_verified: emailVerified } = payload;
    const emailPattern = new RegExp(
      `^[A-Za-z0-9._+-]+@${escapeRegex(this.#options.emailDomain)}$`
    );
    if (
      typeof exp !== 'number' ||
      !Number.isFinite(exp) ||
      exp <= now ||
      typeof nbf !== 'number' ||
      !Number.isFinite(nbf) ||
      nbf > now ||
      typeof iss !== 'string' ||
      iss === '' ||
      typeof sub !== 'string' ||
      sub === '' ||
      typeof email !== 'string'
    ) {
      throw new IdentityVerificationError('invalid_claims');
    }
    if (emailVerified === undefined) {
      if (this.#options.allowMissingEmailVerified !== true) throw new IdentityVerificationError('email_verified_missing');
    } else if (emailVerified !== true) {
      throw new IdentityVerificationError('email_not_verified');
    }
    if (!emailPattern.test(email)) throw new IdentityVerificationError('email_domain');
    let username = email.slice(0, -(`@${this.#options.emailDomain}`).length);
    if (this.#options.usernameMode === 'email-localpart-dashes') {
      username = username.replaceAll('.', '-');
    }
    if (!this.#options.allowedUsers.has(username)) {
      throw new IdentityVerificationError('user_not_allowed');
    }
    if (expected !== undefined) {
      if (iss !== expected.issuer || sub !== expected.subject || username !== expected.username) {
        throw new IdentityVerificationError('principal_changed');
      }
      if (payload.nonce !== undefined && payload.nonce !== expected.nonce) {
        throw new IdentityVerificationError('nonce_mismatch');
      }
      if (payload.auth_time !== undefined && payload.auth_time !== expected.authTime) {
        throw new IdentityVerificationError('auth_time_mismatch');
      }
    }
    return new AccessIdentity({
      issuer: iss,
      subject: sub,
      username,
      expiresAt: exp,
      assertion,
      ...(typeof payload.nonce === 'string' ? { nonce: payload.nonce } : {}),
      ...(typeof payload.auth_time === 'number' ? { authTime: payload.auth_time } : {})
    });
  }
}
