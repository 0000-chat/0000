# Authentication preflight for T02 / issue #13

The current OIDC placeholders ending in `.invalid` and the disabled ingress
flags are deliberate local safety settings. No authorization server is
configured, so they do not prove a live OAuth deployment.

T02 must implement a runnable authorization-code flow with PKCE and the remote
MCP transport using the existing OIDC and D1 grant concepts. The canonical
shared API/MCP resource identifier is the proposed boundary, pending the
worker's concrete configuration and tests. Production hostname, provider
registration, redirect allowlist, and live authorization-server setup are
external setup and cannot be claimed by local tests.

The implementation must retain the raw PKCE verifier securely until the token
exchange; storing only a hash and then attempting the exchange is insufficient.
The T02 worker owns the verifier lifecycle, installation persistence, resource
binding, revocation checks, and MCP/API resolver reuse.
