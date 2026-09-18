import type { CloudflareAccessConfig } from './config.js';
import type { GatewayAuthGate } from './http.js';
import { IdentityVerifier, type IdentityVerifierOptions } from './identity.js';

/** Trust only the signed assertion inserted by Access, never forwarded email headers. */
export function createCloudflareAccessGate(
  config: CloudflareAccessConfig,
  options: Pick<IdentityVerifierOptions, 'getKey' | 'now' | 'fetchImpl'> = {}
): GatewayAuthGate {
  const verifier = new IdentityVerifier({
    issuer: config.accessIssuer,
    audience: config.accessAudience,
    jwksUri: new URL('/cdn-cgi/access/certs', config.accessIssuer),
    emailDomain: config.usernameEmailDomain,
    usernameMode: config.usernameMode,
    allowedUsers: config.allowedUsers,
    allowMissingEmailVerified: config.allowMissingEmailVerified,
    ...options
  });
  return async (request) => {
    const assertion = request.headers.get('cf-access-jwt-assertion');
    try {
      const identity = await verifier.verify(assertion ?? '');
      return {
        identity,
        authInfo: {
          token: identity.assertion(),
          clientId: 'cloudflare-access',
          scopes: [...identity.scopes],
          expiresAt: identity.expiresAt
        }
      };
    } catch {
      return Response.json({ error: 'invalid_token' }, {
        status: 401,
        headers: { 'cache-control': 'no-store' }
      });
    }
  };
}
