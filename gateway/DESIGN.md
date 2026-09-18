# Hosted MCP security boundary

## Required behavior

The main `jupyter-collab-mcp` executable provides an optional authenticated HTTP
mode. It preserves the stdio tool/resource contract without maintaining a
second implementation of notebook behavior or schemas.

Every MCP request is authenticated before worker allocation. A verified OIDC
identity maps to an operator-provisioned JupyterHub user and fixed operator
URLs; no tool argument may choose a principal, credential, or upstream URL.
Only a signed ID token with a finite active lifetime, the configured issuer/
audience/domain, and an allowed mapped username is accepted. Boolean
`email_verified: true` is required by default; the explicit operator opt-in
allows an absent claim, never false/null/malformed values.

## OAuth boundary

The host is a narrow OAuth proxy. It supports dynamic client registration,
authorization code, and mandatory S256 PKCE, then federates the login to the
configured upstream OIDC provider. It issues an opaque local access token and
never returns upstream tokens. Optional refresh support requests upstream
`offline_access`, rotates downstream credentials, and verifies a fresh signed
ID token against the original grant's identity. No expired assertion is extended.
Implicit and device grants remain unsupported.

Client registrations, authorization transactions, one-time codes, and access
token records, grant families and upstream refresh credentials are encrypted in
Redis. Code/access records cannot outlive the signed upstream ID token. Refresh
families have an absolute configured deadline that rotation never extends.
Redis compare-and-swap serializes renewal; a persisted ten-second receipt gives
concurrent uses the same credential pair without a second upstream request.
This explicit short replay-tolerance window is followed by family revocation
on consumed-token reuse. Client binding is verified before any mutation.
Ambiguous upstream renewal or an abandoned in-flight exchange requires login.
Redirect URIs are checked against current operator
policy at registration, authorization, and callback time. The public URL is
authoritative; routing and OAuth metadata are never inferred from forwarded
headers.

## Worker boundary

One persistent Node subprocess belongs to one server-issued login grant and
its issuer/subject/username. Legacy non-refresh grants retain the assertion-
digest key. Its private directory contains a `0600` assertion and profile;
its argv and minimal environment contain neither secret. The existing stdio
server remains the single implementation of tools, resources, stateful handles,
RTC, and kernels.

A request lease serializes calls and atomic credential renewal for that worker.
Monotonic generations prevent an older queued request from restoring a stale
credential. Separate logins never coalesce. Each new REST hop and WebSocket
handshake reads the current credential; expiry closes existing sockets with
recoverable semantics and reconnect never replays execution. An expiry gap may
retain handles until the absolute grant deadline, but cannot authorize expired
network work. Revocation tombstones prevent pending requests from recreating
revoked workers. Global and per-principal limits reject new workers without
eviction. Signed expiry and the local access-token deadline block new leases
immediately; expired grant workers are retired in the background. Failed
retirement remains registered for retry, and cleanup continues across
independent workers and OAuth storage.

One HTTP host process owns all in-memory notebook handles for its workers. A
multi-replica deployment requires grant-affine routing or an explicit external
worker-routing design; Redis alone does not make notebook handles portable.
