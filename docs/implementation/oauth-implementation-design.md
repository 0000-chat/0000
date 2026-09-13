# OAuth remote MCP implementation design for T02 / issue #13

Status: implementation preparation only. T01 / issue #12 is still the
dependency gate, so this document uses its confirmed principal, membership,
identity, and account-grant model without assuming the unmerged code shape.
No repository code, client
registration, production configuration, deployment, or live message action is
authorized by this document. Implementation must wait until #12 is accepted
and merged.

## Objective and non-negotiable authority boundary

T02 should expose one standards-based OAuth resource boundary for the existing
API and a read-only remote MCP endpoint. Both transports must reach one
post-authentication resolver and the same stored-read services. OAuth consent
and OAuth scopes establish transport access; the administrator grant system
still decides which connected accounts and chats are readable. The MCP adapter
must not implement a second permission model and must never forward an inbound
bearer token to a provider.

The critical identity rule is stricter than the current OIDC directory lookup:
a delegated client token whose external `iss` and `sub` equal a human owner
MUST NOT resolve to that human principal, membership, owner role, or admin
authority. At authorization time, a trusted client installation is mapped to a
separate local `agent` principal. The human issuer/subject is retained as
consent and audit provenance only. The installation principal starts with no
account or chat grants. It is visible as an ungranted target in the
administrator picker, and only an administrator grant operation can make a
read operation succeed. A caller-supplied Bot or agent name is never an
identity proof.

The resource server must therefore require an installation binding in the
access token or in a trusted introspection result. An access token that has a
valid human `iss`/`sub` but no verifiable installation/client binding is
rejected for the delegated API/MCP surface; it must not fall back to the
existing `findActivePrincipal(issuer, subject)` path. The chosen design makes
Communicator the OAuth authorization server and resource server, so its own
access tokens always carry the installation binding. Configured upstream OIDC
is used only as the human sign-in client described below; an upstream token is
never accepted directly as delegated API/MCP authority. Existing human/admin
routes may continue to use their current direct OIDC path, but that path is
separate from delegated installation authorization.

## Concrete runtime design

### Discovery and resource binding

Use a canonical HTTPS resource URI, supplied as deployment configuration and
used by both the API and MCP metadata. The recommended initial value is the
public MCP resource URI, with the API accepting the same resource only when the
deployment deliberately chooses the shared boundary. Publish OAuth protected
resource metadata at the root and the path-qualified well-known location, and
advertise the configured authorization-server metadata URL. Return
`WWW-Authenticate: Bearer` with the resource metadata URL and the scopes needed
for the rejected operation on an unauthenticated MCP/API request.

The Worker should expose a metadata-driven authorization-code flow with
default routes `/oauth/authorize` and `/oauth/token`. The concrete choice is a
native authorization-server implementation in the existing control-plane
Worker: Hono routes and Web Standard responses, Zod validation, Web Crypto for
PKCE and key operations, `jose` for JWT/JWKS signing and verification, and D1
for durable OAuth records. There is no Better Auth dependency and no alternate
token-broker implementation in this design. A configured upstream OIDC
provider is only the resource-owner login client used by the authorization
endpoint when a local sign-in session is unavailable.

The authorization request must require `response_type=code`, an exact
registered `client_id`, an exact allowlisted `redirect_uri`, `state`, a
cryptographically random `code_challenge`, `code_challenge_method=S256`, and
the canonical `resource`. The requested OAuth scopes are transport scopes
only; the initial read scope should be the least-privilege scope needed for the
read tools. Reject `plain`, omitted PKCE, resource mismatches, unregistered
redirects, and unsupported clients before creating an installation.

Client ID Metadata Documents are the preferred public-client registration path
for MCP. Fetch a CIMD document only through a guarded Worker fetch that pins
the validated HTTPS URL, rejects redirects and special-use addresses, verifies
that the document’s `client_id` equals its URL, and validates every redirect
URI. Keep Dynamic Client Registration disabled by default; support it only
behind an explicit deployment flag and an allowlist. A pre-registered test
client remains useful for deterministic conformance tests. No live ChatGPT or
Grok registration is performed in this preparation task.

### Authorization-code and installation lifecycle

The authorization endpoint validates the request, establishes the human
session through the configured upstream OIDC client or local login boundary,
displays consent, and records the requested resource, client, redirect,
installation binding, and scopes. The callback returns a short-lived,
single-use authorization code to the exact redirect URI. The code is bound to
the client ID, redirect URI, resource, authorization transaction, PKCE
challenge, and delegated installation; it cannot be redeemed by a different
client or redirect.

When the upstream OIDC login path is used, the authorization endpoint creates
an upstream-only PKCE verifier/challenge, stores that verifier in the separate
encrypted `upstream_login_transactions` record, and redirects to the upstream
issuer. The upstream callback validates its state, redirect, issuer, nonce,
and ID-token claims before local consent continues. This is the only role in
which the Worker retains a raw verifier; it is not the client-facing AS
transaction described next.

The token endpoint accepts `application/x-www-form-urlencoded`, checks the
code, client, redirect URI, resource, expiry, and `code_verifier`, performs the
S256 comparison, atomically consumes the code, and returns an access token.
This authorization server stores the challenge and method, not the client’s raw
verifier. The client owns the verifier and sends it only at token redemption;
the server compares it and discards the request value. The raw verifier
retention requirement applies only when Communicator is itself an upstream
OIDC client: in that separate login transaction, retain that upstream
verifier encrypted until the upstream callback/token exchange, then remove it
and never log it.

Issue a short-lived signed JWT access token with the local AS issuer and
JWKS. Its effective subject is the installation principal, and it carries the
canonical resource/audience, issuer, expiry, issued-at time, unique token ID,
client binding, and installation ID. Any human issuer/subject retained as
consent provenance is non-authorizing metadata; the resolver uses the
installation ID only. Do not use a caller-provided claim or agent name as the
binding. Do not store raw access or refresh tokens in D1. Refresh tokens are a
separate product/deployment decision; T02 can remain access-token-only until a
client requirement is proved.

Persist each OAuth installation separately from the human principal, logical
agent identity, connected messaging account, and account/chat grant. The
installation record should include a generated installation ID, trusted
client ID and metadata fingerprint, authorization-server issuer, canonical
resource, delegated principal ID, consenting human subject reference, status,
creation and revocation times, and last-use metadata. The confirmed #12
bootstrap creates all of these base rows together: a local
`principal_type='agent'` principal with a non-admin membership, a logical
agent identity, and only the minimal read-only `identity_grants` required by
the directory/read model: `connection.read` and `conversation.read` for this
endpoint. It creates zero connected-account or chat grants. The
administrator picker relies on these principal, membership, and identity rows
and must list this target before any account is granted. Never copy the
human’s owner/admin membership or identity grants.

Keep authorization transactions and single-use code state in D1 or a
short-lived Durable Object with compare-and-set consumption. D1 is already the
control directory and supports the primary-session pattern used by current
authorization reads. A conceptual data model is:

1. `oauth_client_installations`: installation/client/resource binding,
   delegated principal, human consent provenance, status, and revocation.
2. `oauth_authorization_transactions`: state binding, PKCE challenge and
   method, client, redirect, resource, expiry, and completion status. It does
   not store the client’s raw verifier.
3. `oauth_authorization_codes`: one-time code digest and all redemption
   bindings, with consumed time and expiry.
4. `upstream_login_transactions`: only for the configured upstream OIDC-client
   role; encrypted upstream verifier, state, callback binding, and expiry,
   removed after callback or failure.
5. Installation/token revocation records: installation revocation invalidates
   every later request; token-level `jti` revocation reuses the existing
   append-only `revoked_tokens` concept. No raw bearer is retained.

### Request resolution and MCP transport

The request pipeline should be explicit:

1. Parse only a `Bearer` header; reject query or body credentials.
2. Verify the token with the existing `createOidcVerifier`/JOSE verifier seam,
   then pass its result through the existing authorization middleware boundary
   rather than bypassing `resolveAuthorization`. The new installation resolver
   sits between token verification and the T01 grant resolver; the existing
   read authorization helpers remain the final identity and projection gate.
   Extend that seam for the local AS issuer while retaining the separate
   upstream OIDC verifier for human login. Validate the allowed algorithms,
   configured issuer, audience/resource, expiry, not-before, issued time, and
   token ID. Continue to use its injectable clock and JWKS fetch.
3. Resolve the trusted installation ID/client binding and verify the
   installation is active, the resource matches, and the token is not revoked.
4. Resolve the linked delegated agent principal, not the human `iss/sub`.
5. Call T01’s account/chat grant resolver and intersect local grants with the
   token’s operation scopes. Recheck principal, installation, membership,
   account/chat grant, and token revocation on every request.
6. Return a narrow authorization context to both API handlers and MCP tool
   handlers.

Use the official `@modelcontextprotocol/sdk` v1 Web Standard/Hono-compatible
Streamable HTTP transport, pinned to the approved 2025-11-25 behavior. The
endpoint should be `/mcp`, support Streamable HTTP’s required POST and GET
behavior, validate `Origin`, and create stateless per-request read handlers
unless a later client requirement proves resumable sessions necessary. T02
exposes only the stored-read operations already present in the Worker:
identities, connections, channels, conversation lists/details, and paginated
messages. Search and attachment behavior are later tickets; their MCP tools
are added only when those tickets land and are proved. Every tool calls the
shared high-level read service and returns the same IDs, redactions, and
not-found behavior as the API. Send, webhook management, provider linking,
and admin grants remain outside this ticket.

Return 401 with resource metadata when the bearer is absent, malformed,
wrong-issuer, wrong-resource, expired, revoked, or attached to a revoked
installation. Return 403 when the token and installation are valid but the
delegated principal has no local account/chat grant or lacks the requested
operation scope. An OAuth scope upgrade may satisfy transport consent but can
never create or widen a T01 administrator grant.

## Library and protocol choices verified against primary sources

- Reuse the repository’s Hono, Zod, and `jose` dependencies. `jose` already
  provides the remote JWKS and `jwtVerify` path; its primary documentation
  describes signature and claims validation and lists Cloudflare Workers as a
  supported Web Crypto runtime. Use Web Crypto for PKCE S256, random state,
  token/code digests, and encryption of the retained upstream-login verifier.
- Use Hono’s Web Standard `Request`/`Response` boundary and its `app.request`
  test seam. Do not add a second HTTP framework.
- Use the official `@modelcontextprotocol/sdk` v1 Web Standard or Hono adapter,
  pinned to the approved 2025-11-25 protocol. MCP defines Streamable HTTP as
  the remote transport; that contract requires a single endpoint with POST/GET
  behavior, JSON-RPC, and Origin validation.
- Follow RFC 7636 with S256, RFC 8414 authorization-server metadata, RFC 8707
  resource indicators, RFC 9728 protected-resource metadata, and RFC 9700’s
  current OAuth security guidance. Bearer validation remains resource-bound;
  OAuth scopes do not replace local ACLs.
- The chosen authorization-server implementation is native Hono + Zod + Web
  Crypto + `jose`, backed by D1 and the existing control-plane bindings. It
  issues installation-bound resource tokens and keeps the configured upstream
  OIDC provider strictly in the human-login client role. This avoids adding an
  unneeded authentication vendor while preserving the existing verifier and
  directory seams.

## Deployment configuration versus genuine product decisions

Deploy-time configuration should supply the public origin and MCP path,
canonical resource URI, local AS issuer and signing keys/JWKS location,
upstream OIDC issuer/client/JWKS and callback settings for human login,
client-registration mode and allowlist, exact redirect URIs, token/code/state
TTLs, clock tolerance, CORS and Origin policy, accepted MCP protocol versions,
D1/DO bindings, and secret references. Production values must replace the
deliberate `.invalid` OIDC placeholders and disabled ingress flags. Secrets
and raw session state remain outside tracked files.

The following are real decisions that configuration alone must not silently
make: whether API and MCP share one resource URI or use separate resources;
whether CIMD is mandatory or DCR is allowed as a compatibility fallback; the
initial transport scope names; refresh-token support; consent and
installation-revoke UX; and the exact 2025-11-25 versus newer MCP compatibility
target. The non-admin installation invariant, zero initial account grants,
administrator
target-picker visibility, and no human-subject fallback are implementation
requirements, not open choices. T02 does not implement sending, webhooks,
provider account linking, or other providers.

## Tests and seams

Use the existing prior art: construct the Worker with `createApp()` and test
HTTP behavior with `app.request()`; apply D1 migrations through
`cloudflare:test`; and use `runInDurableObject` only when a Durable Object
state path is selected. Inject a clock, random source, crypto helpers, token
verifier, JWKS fetch, upstream OAuth adapter, and provider/read-service spies.
WireMock or an equivalent controllable HTTP fixture should provide upstream
authorization-server metadata, JWKS rotation/failure, login callback, and
token exchange cases. UI MSW mocks are not OAuth conformance evidence.

Focused tests should prove:

1. RFC 7636 S256 vectors, verifier length/character checks, state binding,
   exact redirect and client matching, resource binding, encrypted raw
   verifier retention for the separate upstream OIDC-client transaction,
   challenge-only storage for the Communicator AS transaction, single-use code
   consumption, replay rejection, expiry, and no credential values in logs.
2. JWT signature, issuer, audience/resource, `exp`, `nbf`, `iat`, `jti`, JWKS
   rotation, token revocation, installation revocation, and 401 challenge
   metadata. Opaque tokens are tested only through an explicit introspection
   seam.
3. The critical same-human-subject case: seed an owner token and a delegated
   token with the same external `iss/sub`; assert that the delegated request
   resolves only to the installation-scoped non-admin agent principal, has no
   owner/admin role, creates the confirmed non-admin membership and logical
   agent identity with only minimal read-only identity grants, has zero
   account/chat grants, appears in the admin target picker, and cannot select
   another identity by naming it. Add an account grant through the
   administrator path, then prove only the granted account/chat is readable.
4. API and MCP calls use the same resolver, IDs, redactions, pagination, and
   not-found behavior for the currently implemented identities, connections,
   channels, conversations, and messages. Prove a valid installation without
   an account/chat grant gets 403, while a wrong resource, issuer,
   expired/revoked token, or revoked installation gets 401 with
   `WWW-Authenticate` resource metadata.
5. Streamable HTTP POST/GET, JSON-RPC errors, required `Accept` values,
   Origin rejection, discovery metadata, least-privilege scope challenges,
   and no bearer forwarding to a provider. The provider spy must observe no
   inbound Authorization header.
6. Configuration contract checks fail clearly for missing/invalid issuer,
   resource, signing key, redirect allowlist, or `.invalid` production values.
   Existing OIDC, directory, read, archive, projection, and revocation tests
   remain regression coverage.

The first controlled client proof, after #12 and deployment configuration are
complete, should spell out the T02 portion of the ChatGPT Work path: discover
protected-resource metadata; complete authorization-code PKCE; and read the
currently implemented identities, connections, channels, conversation
history/details, and messages through MCP. Search, attachment reads, replies,
one-to-one/group management, subscriptions, and receiver verification expand
only with their later tickets. This T02 preparation performs none of those
live actions.
Grok web/mobile/Bot support remains a separate proof and cannot be inferred
from a successful OAuth test.

## Risks and recovery gates

- **#12 contract drift:** hypothesis: the grant resolver or target-picker
  interface changes before merge. Attempt: keep T02 dependent on a narrow
  post-verification resolver contract and do not write branch-dependent code.
  Check: after #12 merges, map account/chat grant reads and administrator target
  selection explicitly before implementation.
- **Missing installation claim:** hypothesis: an implementation accidentally
  accepts a direct upstream OIDC token on the delegated surface. Attempt:
  require the native Communicator AS issuer and installation claim for every
  delegated token; use upstream OIDC only during human login. Check: a
  same-subject token without the local binding must fail closed in the
  principal-boundary test.
- **Protocol or SDK drift:** hypothesis: the selected SDK defaults to a newer
  MCP era. Attempt: pin a compatible release or isolate the Web Standard
  adapter. Check: run the 2025-11-25 transport and metadata contract tests
  before accepting a client proof.
- **Registration and SSRF exposure:** hypothesis: CIMD/DCR metadata is fetched
  without sufficient network restrictions. Attempt: use the guarded metadata
  fetch and allowlists. Check: redirect, special-use address, mismatch, and
  malformed-document fixtures remain rejected.
- **Revocation race or key rotation:** hypothesis: a cached verifier or
  installation record outlives revocation. Attempt: use primary D1 reads,
  short key caches, token IDs, and installation status checks on every request.
  Check: revoke immediately before API/MCP read and assert denial on both
  surfaces.

## Sources

- [MCP authorization, 2025-11-25](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization)
- [MCP transports, 2025-11-25](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports)
- [RFC 7636: PKCE](https://www.rfc-editor.org/rfc/rfc7636)
- [RFC 8414: authorization-server metadata](https://www.rfc-editor.org/rfc/rfc8414)
- [RFC 8707: resource indicators](https://www.rfc-editor.org/rfc/rfc8707)
- [RFC 9728: protected-resource metadata](https://www.rfc-editor.org/rfc/rfc9728)
- [RFC 9700: OAuth security BCP](https://www.rfc-editor.org/rfc/rfc9700)
- [`jose` `jwtVerify` documentation](https://github.com/panva/jose/blob/main/docs/jwt/verify/functions/jwtVerify.md)
- [Hono testing with `app.request`](https://www.honojs.com/docs/guides/testing)
- [Official MCP TypeScript SDK v1 server guide](https://ts.sdk.modelcontextprotocol.io/server)
