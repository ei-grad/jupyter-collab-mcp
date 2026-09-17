# Authenticated HTTP mode

`jupyter-collab-mcp --http` exposes the same tools and output resources as the
stdio mode over authenticated MCP HTTP. It is part of the main TypeScript
package and executable; `gateway/` contains only container and deployment
documentation.

The HTTP host federates login to a trusted OIDC provider. Each verified
principal and exact ID-token generation owns a persistent Node stdio worker.
That process boundary keeps notebook handles and credentials separate while
reusing the canonical stdio implementation and schemas.

## Configuration

All variables use the `JUPYTER_MCP_` prefix.

| Suffix | Value |
| --- | --- |
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
with mandatory S256 PKCE. It does not support refresh, implicit, device,
client-ID metadata documents, or `private_key_jwt`. The exact verified upstream
ID token is encrypted in Redis, never returned to the MCP client, and bounds
the lifetime of every authorization code, local access token, and worker.

## Isolation and lifecycle

The worker key is `(issuer, subject, SHA256(exact ID token))`. A rotated grant
gets a new process and cannot use the previous grant's handles. An existing
unexpired grant remains available until its own expiry. Capacity failures never
evict another worker.

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

The container is Node 24 only, runs as UID/GID 10001, and expects `/run/mcp` to
remain private to that user.
