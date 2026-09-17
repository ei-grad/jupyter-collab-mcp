# Hosted MCP security boundary

## Required behavior

The main `jupyter-collab-mcp` executable provides an optional authenticated HTTP
mode. It preserves the stdio tool/resource contract without maintaining a
second implementation of notebook behavior or schemas.

Every MCP request is authenticated before worker allocation. A verified OIDC
identity maps to an operator-provisioned JupyterHub user and fixed operator
URLs; no tool argument may choose a principal, credential, or upstream URL.
Only a signed ID token with a finite active lifetime, exact boolean
`email_verified: true`, the configured issuer/audience/domain, and an allowed
mapped username is accepted.

## OAuth boundary

The host is a narrow OAuth proxy. It supports dynamic client registration,
authorization code, and mandatory S256 PKCE, then federates the login to the
configured upstream OIDC provider. It issues an opaque local access token and
never returns upstream tokens. Refresh and broader grant types are unsupported.

Client registrations, authorization transactions, one-time codes, and access
token records are encrypted in Redis. Code/token records cannot outlive the
signed upstream ID token. Redirect URIs are checked against current operator
policy at registration, authorization, and callback time. The public URL is
authoritative; routing and OAuth metadata are never inferred from forwarded
headers.

## Worker boundary

One persistent Node subprocess belongs to one `(issuer, subject, assertion
digest)` tuple. Its private directory contains a `0600` assertion and profile;
its argv and minimal environment contain neither secret. The existing stdio
server remains the single implementation of tools, resources, stateful handles,
RTC, and kernels.

A request lease serializes calls for that worker. Rotation allocates a new
worker instead of replacing the old grant. Global and per-principal limits
reject new workers without eviction. Signed expiry blocks new leases
immediately; idle expired workers are retired in the background. Failed
retirement remains registered for retry, and cleanup continues across
independent workers and OAuth storage.

One HTTP host process owns all in-memory notebook handles for its workers. A
multi-replica deployment requires grant-affine routing or an explicit external
worker-routing design; Redis alone does not make notebook handles portable.
