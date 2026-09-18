# T01 runtime findings

Date: 2026-09-19. Status: implementation evidence assembled for parent review;
T01 and the full authentication MVP are not accepted.

## Scope and runtime

This is a local Worker/D1 investigation for ticket #55, not a deployment, account
UI, production bootstrap or consumer migration. Better Auth callback handling,
Platform routes, D1 storage and shared-client verification run in the Worker.
GitHub HTTP responses, service registration and the protected resource service
are fixtures. OAuth client setup is inserted by the test because dynamic
registration is disabled.

| Component | Version or setting |
| --- | --- |
| Bun | 1.3.14 |
| Better Auth / OAuth Provider | 1.7.5 |
| Drizzle ORM | 0.45.2 |
| Wrangler / Miniflare | 4.135.0 / 5.20260918.0-alpha |
| Cloudflare Vitest plugin / Vitest | 1.1.13 / 4.1.11 |
| TypeScript / Node.js types | 7.0.2 / 22.20.3 |
| Worker runtime | compatibility date 2026-09-18, nodejs_compat |

Better Auth core, organization, JWT and OAuth tables are generated from the
pinned plugins into migrations/0001_better_auth.sql. Platform-owned authority
state, including bootstrap receipts and hashed credentials, is in
migrations/0002_platform_authority.sql. The resource table belongs to the test
fixture. The SQLite Drizzle adapter uses transaction:false and camelCase:true;
extension writes requiring atomicity use D1 batch(). A durable default-org
receipt makes completed retries return their saved IDs without recreating a
membership removed later.

The candidate v1 principal carries kind, authority, subject, credential,
audience, capabilities and expiry. Human adds organization/membership; agent and
service add organization/grant; guest adds grant/resource IDs and has no expiry.
Runtime routes here exercise human and guest principals only.

Every verifier and guest-grant request starts a fresh
IDENTITY_DB.withSession("first-primary") session; no session or positive auth
cache is reused across requests. Issuance-time membership checks query D1
directly. This proves current-state behavior locally; replica consistency is
based on documented D1 session semantics, not a live remote-replica test.

## Executed boundaries

| Routes or seam | Evidence |
| --- | --- |
| POST /api/auth/sign-in/social; GET /api/auth/callback/github | Better Auth handles callback state and persists user, provider account and session in D1; only GitHub HTTP responses are simulated. New requests and Better Auth instances read the session. |
| GET /api/me | Repeated calls return the receipt-backed default org and owner IDs. Removing the owner membership does not recreate it; the existing human credential then fails verification. |
| POST /api/credentials; POST /api/credentials/revoke; /internal/v1/authenticate | Issuance requires a Platform session and trusted Origin, binds authority to registered service/current membership, and stores only a SHA-256 verifier. The client sends its verifier separately from the presented credential and validates/rebuilds the unknown wire principal. Wrong audience, revocation or removed membership returns 401; malformed authority or transport failure fails closed as 503. |
| Protected resource fixture | Authorization uses its own stored owner row after Platform authentication. A different tenant gets non-enumerating 404. The fixture is not a production consumer. |
| POST /api/guest/bootstrap; POST /internal/v1/guest-grants | A bootstrap guest alone cannot access a resource. A separately registered guest:grant issuer proves the guest bootstrap and resource owner; excess capabilities and mismatched proof are rejected. The resulting credential is bounded to guest, audience, resource and capability. The verifier cannot issue grants, and the grant issuer cannot authenticate arbitrary credentials. |
| /api/auth/oauth2/authorize; /api/auth/oauth2/consent; /api/auth/oauth2/token | D1/Worker test exercises PKCE, redirect, consent, code exchange, opaque hashed access-token configuration and sequential refresh replay; details and limitations follow. |

The guest restart script bundles the Worker, applies migrations and issues a
bounded grant in one Miniflare runtime, disposes Workerd, then opens a second
runtime on the same persistent D1 path without reapplying migrations or service
registration. The same service authenticates the same grant and authorizes the
same fixture resource after restart. Human sessions are proven across new
Better Auth instances and requests, not across a process restart.

## OAuth findings and unresolved production gate

The pinned Provider requires PKCE, disables dynamic registration, restricts
clients to the configured resource, sets refreshTokenReuseInterval to 0,
disables its JWT plugin and explicitly sets storeTokens to hashed. The runtime
access token is not a three-part compact JWT and its D1 value differs from the
response token; tests never print token values. OAuth tokens are not yet
normalized by /internal/v1/authenticate or bound to a Platform installation.

The probe rejects missing PKCE, unregistered redirect/resource and unknown
client; the accepted code flow preserves the registered redirect and state.
The resource allowedScopes list must include offline_access or the plugin drops
it before storing the grant, and a later refresh returns no replacement token.
Allowing offline_access makes the sequential exchange and rotation succeed.
Replaying the consumed refresh token returns 400 invalid_grant and the
replacement is then rejected.

That is not a concurrency or production revocation guarantee. Pinned source
marks the old refresh row and inserts its replacement in separate adapter
calls. Family invalidation separately reads the family, deletes access rows,
then deletes refresh rows; its source comment identifies a race. The family is
scoped to clientId and userId, not a Platform installation. D1 batch atomicity
does not combine these adapter calls. T06/T07 must gate issue, introspection and
resource use on current Platform installation/grant state, prove concurrent
replay and revocation, and verify a supported pre-token/pre-introspection guard
or equivalent seam against the pinned plugin. If the plugin cannot enforce the
guard, choose a component that can.

This version's JSON/browser-fetch consent path returns { redirect: true, url },
although its documentation metadata describes redirect_uri. The test validates
the returned url. T06 should retain redirect-origin, path and state checks.

## Remaining acceptance

The probes establish local feasibility for human session, retry-safe default
organization, scoped credentials, authoritative verification, service-owned
resource ACL and bounded guest grant. They do not complete the authentication
MVP. Google login and proof-based account linking, production service/operator
provisioning, account and organization UI, OAuth installation lifecycle and
token normalization, concurrent org/final-owner changes, human-session restart,
consumer migration and managed deployment ownership remain unproven. No
production Worker or real provider secrets were used.

## Reproducible checks

From the 0000 worktree root, bun run check passes only the 11-manifest workspace
scaffold validator; it is not an authentication test. Run the other checks from
the stated package directory:

- packages/contracts: bun run check passed TypeScript and 3 unit tests.
- packages/platform-client: bun run check passed TypeScript and 3 unit tests /
  16 assertions for credential separation, malformed/expired/wrong authority
  or audience, rejected credentials and outage behavior.
- services/platform: bun run check passed Biome (20 files), Worker typecheck,
  both workerd/D1 test files (2 tests), Miniflare restart and git diff check.
- services/platform: bun run generate:migration preserved the Better Auth
  migration byte-for-byte.
- services/platform: bun x wrangler types worker-configuration.d.ts regenerated
  the Env/runtime types with no diff.

The OAuth test emits non-fatal Miniflare warnings about inspecting
application/x-www-form-urlencoded request bodies. OAuth and provider fixtures
are synthetic; tests print no token values.
