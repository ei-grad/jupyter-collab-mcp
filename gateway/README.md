# Authenticated HTTP mode

`jupyter-collab-mcp --http` exposes the same tools and output resources as the
stdio mode over authenticated MCP HTTP. It is part of the main TypeScript
package and executable; `gateway/` contains only container and deployment
documentation.

The HTTP host either federates login to a trusted OIDC provider (the default)
or validates assertions from Cloudflare Access Managed OAuth. Each authenticated
login grant or transport session owns a persistent Node stdio worker.
That process boundary keeps notebook handles and credentials separate while
reusing the canonical stdio implementation and schemas.

## Configuration

All variables use the `JUPYTER_MCP_` prefix.
The OAuth credentials, Redis, redirect and refresh settings below apply only
to the default `AUTH_MODE=oauth`.

| Suffix | Value |
| --- | --- |
| `AUTH_MODE` | `oauth` (default) or `cloudflare-access` |
| `PUBLIC_URL` | Public HTTPS base URL, for example `https://mcp.example.invalid` |
| `OIDC_CONFIG_URL` | Trusted HTTPS OIDC discovery document |
| `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET` | Upstream OIDC client credentials |
| `STORAGE_KEY` | URL-safe base64 Fernet key encoding exactly 32 bytes |
| `SIGNING_KEY` | Secret used to hash opaque OAuth records, at least 32 characters |
| `REDIS_URL` | `rediss://...` or an absolute private `unix:///...` URL |
| `REDIRECT_URIS` | Space-separated exact callbacks or bounded callback patterns |
| `USERNAME_EMAIL_DOMAIN` | Required verified email domain |
| `USERNAME_MODE` | `email-localpart` or `email-localpart-dashes` |
| `ALLOW_MISSING_EMAIL_VERIFIED` | `true` or `false` (default); permit only an absent claim from the configured trusted issuer |
| `ENABLE_REFRESH` | `true` or `false` (default); enable upstream renewal and downstream refresh rotation |
| `REFRESH_GRANT_TTL_SECONDS` | Absolute refresh-session bound; default 28800 (eight hours), never extended by rotation |
| `ALLOWED_USERS` | Space-separated provisioned JupyterHub usernames |
| `API_BASE_URL` | Operator-controlled JupyterHub proxy base |
| `BROWSER_BASE_URL` | Display base; defaults to `API_BASE_URL` |
| `ASSERTION_HEADER` | Upstream assertion header; default `X-Jupyter-Access-Token` |
| `RUNTIME_DIR` | Private worker directory; default `/run/mcp` |
| `MAX_WORKERS` | Global process cap; default 16 |
| `MAX_WORKERS_PER_PRINCIPAL` | Grant cap per OIDC principal; default 4 |
| `REQUEST_TIMEOUT` | Per-RPC timeout in seconds; default 120 |
| `CONNECT_TIMEOUT` | Worker initialization timeout in seconds; default 10 |
| `EXPIRY_POLL_SECONDS` | Expired-worker sweep interval; default 5 |
| `NODE_COMMAND`, `UPSTREAM_CLI` | Optional local worker executable overrides |

## Cloudflare Access Managed OAuth

With `AUTH_MODE=cloudflare-access`, Cloudflare owns discovery, client registration,
login, token issuance and refresh. The origin does not expose its own OAuth
endpoints and does not connect to Redis. Configure:

| Suffix | Value |
| --- | --- |
| `ACCESS_ISSUER` | Exact Access team origin, e.g. `https://team.cloudflareaccess.com` |
| `ACCESS_AUDIENCE` | This MCP Access application's audience tag |
| `ACCESS_SESSION_TTL_SECONDS` | Absolute in-memory transport/worker lifetime; default 28800 |
| `ACCESS_SESSION_IDLE_SECONDS` | Idle session timeout; default 900 (15 minutes) |

The common public/Jupyter URLs, username mapping, provisioned-user allow-list,
assertion header and worker limits still apply. Set the missing-email-verification
opt-in only when justified by the configured Access identity policy. Every MCP
request must carry a valid RS256 `Cf-Access-Jwt-Assertion`; a client bearer token
or unsigned email header alone is never accepted. JWKS comes from the configured
team's `/cdn-cgi/access/certs`. Provision downstream Jupyter to accept this issuer
and audience, since an Access assertion differs from a SaaS OIDC ID token.

This mode uses the sessionful 2025 Streamable HTTP transport. Each successful
`initialize` creates an unpredictable `Mcp-Session-Id`, bound to the verified
issuer, subject and mapped username. Independent connections, including two
agents for one user, have separate workers and handles. The session header is
never sufficient authorization; every request needs a fresh validated assertion.
Rotating that assertion preserves the worker and updates its private credential
before a tool request. The same assertion can initialize separate connections.
Clients must retain the session header and initialize again after a 404.
Modern-only stateless clients without this session handshake are not supported.

`DELETE` closes the transport and worker. Idle timeout reclaims abandoned
connections even if a client disconnects without DELETE; authenticated requests
reset it, and a running request prevents idle eviction. The absolute lifetime is
never extended. Handles expire with their transport session, so a client returning
after inactivity must initialize and reopen its notebook handles. Token expiry
stops Jupyter traffic but preserves handles until the session timeout.
Restarting the origin loses process-local handles and
transport sessions, but does not lose Cloudflare's OAuth login or registration.
Keep the origin private behind the tunnel and enable Managed OAuth on the Access
application before publishing this mode. Restrict OAuth callback patterns in
Cloudflare; the origin's `REDIRECT_URIS` setting is unused in this mode.

## Built-in OAuth

Enable `ALLOW_MISSING_EMAIL_VERIFIED` only for a configured issuer whose
authentication policy establishes the signed email identity without that claim.
It permits absence only: explicit `false`, `null` and malformed values remain
rejected, along with invalid signatures, issuer/audience, expiry, domains and
unprovisioned users. There are no automatic issuer-hostname exceptions.

Redirect patterns accept an exact HTTPS callback, one bounded HTTPS path suffix
such as `https://client.example.invalid/oauth/*`, or a loopback port pattern
such as `http://127.0.0.1:*`. Hostname wildcards, path escapes, credentials,
queries, and fragments are rejected.

The OAuth surface supports dynamic registration and authorization code grants
with mandatory S256 PKCE and optional refresh grants. It does not support implicit, device,
client-ID metadata documents, or `private_key_jwt`. The exact verified upstream
ID token is encrypted in Redis, never returned to the MCP client, and bounds
the lifetime of every authorization code and local access token.

With `ENABLE_REFRESH=true`, also enable refresh grants at the trusted OIDC
provider. The upstream authorization request adds `offline_access`; MCP clients
continue using `openid email`. Cloudflare Access SaaS uses the API/provider grant
name `refresh_tokens` (plural), automatically enables `offline_access`, and sets
the upstream lifetime through `refresh_token_options.lifetime`. Keep short-lived
access/ID tokens and set the provider refresh lifetime no longer than the local
absolute grant bound. A refreshed ID token is mandatory; a response without a
replacement refresh token retains the previous upstream refresh credential.

Refresh tokens rotate and remain bound to their original client and identity.
Concurrent uses receive the same newly issued pair for ten seconds from a
persisted encrypted receipt. This short window intentionally tolerates replay;
reuse afterwards revokes the entire family. Issued token lifetimes and the
absolute session deadline never extend through receipt replay. An uncertain
upstream renewal failure requires login instead of blindly retrying a token
that the provider may already have consumed. Stable Redis data and encryption/
signing keys preserve grants across gateway restarts. Existing registrations
and unexpired access tokens survive upgrade, but pre-refresh registrations need
fresh registration/login to receive refresh permission.

## Isolation and lifecycle

Refresh workers use a stable login-grant/issuer/subject/username key. Replacing
the verified assertion preserves their process and handles; separate logins and
agents remain isolated. REST and new WebSocket handshakes re-read the current
private credential. Existing sockets close at credential expiry and reconnect
with the current credential. Expiry gaps retain handles until the grant deadline
but do not authorize expired credentials. Non-refresh workers retain the legacy
`(issuer, subject, SHA256(exact ID token))` key. Capacity failures never evict
another worker.

The parent writes the assertion and fixed Jupyter profile to an owner-only
temporary directory. Secrets are absent from argv, environment variables,
logs, MCP responses, and public descriptors. Requests for one worker are
serialized. HTTP disconnect releases only the request lease. Expiry and
shutdown attempt every independent worker; a failed close remains owned and is
retried. Worker shutdown leaves Jupyter kernels running.

Redis stores encrypted OAuth state, not notebook handles. Run one HTTP-host
process per replica unless routing guarantees that every request for a grant
returns to the replica holding its worker.

## Running and verification

```sh
pnpm build
JUPYTER_MCP_PUBLIC_URL=https://mcp.example.invalid \
  jupyter-collab-mcp --http
```

The server listens on `0.0.0.0:8000`, serves MCP at `/mcp`, and exposes an
unauthenticated readiness response at `/healthcheck` without operational
details.

```sh
pnpm typecheck
pnpm exec vitest run --project unit test/gateway
pnpm exec vitest run --project int test/gateway
docker build -f gateway/Dockerfile --target tested -t jupyter-mcp-http:local .
```

Set `JUPYTER_MCP_TEST_REDIS_IMAGE` to a locally available Redis image to include
the disposable Redis CAS/AOF restart integration test. It uses no existing
datastore. `scripts/header-refresh-smoke.ts` exercises notebook/kernel handle
continuity against a disposable local Jupyter server supplied with two signed
assertions. Neither test uses production credentials.

The container is Node 24 only, runs as UID/GID 10001, and expects `/run/mcp` to
remain private to that user.
