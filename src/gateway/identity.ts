import { createHash } from 'node:crypto';

import {
  createRemoteJWKSet,
  customFetch,
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
  readonly now?: () => number;
  readonly getKey?: JWTVerifyGetKey;
  readonly fetchImpl?: typeof fetch;
}

export class AccessIdentity {
  readonly issuer: string;
  readonly subject: string;
  readonly username: string;
  readonly expiresAt: number;
  readonly scopes: readonly string[];
  readonly #assertion: string;

  constructor(init: {
    readonly issuer: string;
    readonly subject: string;
    readonly username: string;
    readonly expiresAt: number;
    readonly assertion: string;
    readonly scopes?: readonly string[];
  }) {
    this.issuer = init.issuer;
    this.subject = init.subject;
    this.username = init.username;
    this.expiresAt = init.expiresAt;
    this.#assertion = init.assertion;
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

  async verify(assertion: string): Promise<AccessIdentity> {
    if (assertion === '') throw new Error('access ID token is missing or invalid');
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
    } catch {
      throw new Error('access ID token is missing or invalid');
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
      typeof email !== 'string' ||
      emailVerified !== true ||
      !emailPattern.test(email)
    ) {
      throw new Error('access ID token is missing or invalid');
    }
    let username = email.slice(0, -(`@${this.#options.emailDomain}`).length);
    if (this.#options.usernameMode === 'email-localpart-dashes') {
      username = username.replaceAll('.', '-');
    }
    if (!this.#options.allowedUsers.has(username)) {
      throw new Error('access ID token is missing or invalid');
    }
    return new AccessIdentity({
      issuer: iss,
      subject: sub,
      username,
      expiresAt: exp,
      assertion
    });
  }
}
