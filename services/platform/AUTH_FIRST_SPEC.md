# Platform authentication MVP

Date: 2026-09-19. Status: agreed MVP design; T01 through T05 reviewed and verified
on the aggregate; T14 reconnect fixture reviewed and verified at `166e54d`;
T05 verified at `10d31c8`; full MVP not accepted.

[README.md](README.md) defines Platform's ownership. This specification records
the agreed product and security decisions for the implementation.
Implementation details marked for validation must be proven against the selected
Better Auth version and Workers/D1 runtime. [T01_RUNTIME_REPORT.md](T01_RUNTIME_REPORT.md)
records the T01 investigation; [T02_ACCOUNT_REPORT.md](T02_ACCOUNT_REPORT.md)
records local evidence for the initial account slice. [T03_ORGANIZATION_REPORT.md](T03_ORGANIZATION_REPORT.md)
records the organization and lifecycle slice, reviewed and verified on the
aggregate at `c51d285`. [T04_CREDENTIAL_REPORT.md](T04_CREDENTIAL_REPORT.md)
records the bounded human credential, service registration and two-audience
fixture evidence, reviewed and verified at aggregate `dc30cd4`. [T05_AGENT_REPORT.md](T05_AGENT_REPORT.md)
records the local organization-owned agent and per-audience grant evidence,
reviewed and independently verified at aggregate `10d31c8`. The evidence
does not complete the design's acceptance gates
or establish production authentication.

[SIGNUP_RECOVERY_REPORT.md](SIGNUP_RECOVERY_REPORT.md) records the reviewed
interrupted-signup repair, integrated and independently verified at `54fc212`.
Combined checks pass eight Worker/D1 files/twenty tests and both guest/resource
and actual human runtime restart probes with simulated provider HTTP.

[T08_GUEST_REPORT.md](T08_GUEST_REPORT.md) and
[GUEST_PERMISSION_REPORT.md](GUEST_PERMISSION_REPORT.md) record the reviewed
guest lifecycle and independent resource permissions, integrated at `ddf93ad`.
The integrated tree matches the independently tested checkpoint: ten Worker/D1
files, twenty-seven tests, format/typecheck and restart persistence pass.
Native reviews and a bounded Grok adversarial review found no confirmed defect.
Actual msg adoption, management access and grant-to-local-permission binding
remain acceptance gates; these results do not establish consumer readiness.

The shared-client transport portion of T12 is integrated at `82e6181` with
independently verified deadlines, late-result suppression and redirect refusal.
Twelve client tests and twenty-seven Worker/D1 tests plus restart pass; native
and bounded adversarial reviews accepted this slice. Distributed endpoint
limits, audit and the rest of T12 remain required.

## MVP outcome and deployment

Use the same open-source Platform for self-hosted deployments and managed 0000
deployments. The managed service supports standalone customers using external
harnesses, CLI or MCP clients without requiring Spaces or the full product UI.
The managed full product uses the same Platform accounts and organizations, and
adds its own Spaces, threads, agent control and application UI.

The initial runtime is Cloudflare Workers with D1. Local development is in scope;
Docker is not part of this MVP. Platform owns its identity database directly and
does not depend on the public Database service to start or authenticate users.
A self-hosted operator needs no 0000 Cloud account and supplies their own Google
and GitHub OAuth provider credentials.

Managed signup is open by default and creates a default organization.
Self-hosted signup is configurable as open or invitation-only. This setting is
independent of anonymous guest access. There are no existing Platform users to
import, so legacy identity import, dual-trust and user cutover gates are removed.
Migrating service code away from local issuers remains in scope; it is not a
legacy user-data import.

## Human identity and account experience

Use Better Auth for human accounts, browser sessions and social login through
Google and GitHub. This replaces the earlier magic-link direction. Self-hosters
configure their own provider credentials. Linking a provider identity to an
existing account requires proof of control of both accounts; an email match
alone never links or merges identities.

Keep browser session cookies at Platform and protect browser flows with origin
and CSRF checks. Do not distribute session cookies to services or put long-lived
credentials in URLs or browser local storage.

Platform owns the account experience for profile, organizations, memberships,
organization-owned agent identities, consent and credentials. The current T03
slice adds explicit organization selection, member and invitation management,
atomic owner protection and configured operator lifecycle recovery. It includes
the identity administration needed by service-only customers. T05 adds
organization-owned agent creation, lifecycle, per-service grants and opaque
agent credentials to the Platform account UI. Product Spaces,
threads, agent execution and full-product agent control remain with the product
UI. Integrate a full application's login only where that application exists;
no apps/0000 implementation was found. Building full-product login or offline
sync is not an MVP acceptance gate.

## Principals, grants and credentials

All consumers use the same versioned principal contract, Platform client and
authentication middleware. Consumers must not create service-local users,
organization authorities, credential issuers or hand-rolled variations of
Platform verification. Shared contracts describe authenticated identity and
stable failure categories without exposing Better Auth's storage schema.

The contract discriminates human, agent, service and guest principals. A verified
organization principal identifies its Platform authority, stable subject,
organization, credential, intended service audience and applicable grant.
Humans require current organization membership. Agent and service machine
principals require an explicit current grant. Guest principals are a separate
kind with no organization; a nullable organization field must not turn them
into organization members. IDs, email addresses and display names are not
interchangeable identity keys.

Platform issues opaque API credentials scoped to a subject, organization where
applicable, service audience and allowed capabilities. Their expiry is
configurable and defaults to 90 days. Show a credential secret once and store a
protected verifier, not the raw secret. Use a distinct credential for each
service audience; enabling another service does not expand existing credentials.
Expose only configured Better Auth/plugin operations. Enforce subject,
organization, audience and grant binding server-side on every route; submitted
plugin metadata cannot set those authority fields. A machine credential must
never create or impersonate a human browser session.

Platform is also the OAuth authorization server in this MVP for external
harnesses and MCP clients. Use standard OAuth flows and bind each installation to
its registered client, user/agent, consent, resource and permitted service
grants. Require PKCE, exact registered redirect validation, resource validation,
explicit consent, refresh-token rotation with reuse protection, revocation and
installation binding. OAuth-issued credentials normalize to the same principal
contract. Token lifetime details beyond the configurable API-credential default
are a technical decision; the revocation guarantees below apply to every remote
request.

An organization-owned agent has the same stable identity when it is authorized
for more than one service, but receives a separate grant and credential for each
service. It never inherits its creator's administrator role. It remains when
its creator leaves, and organization administrators can manage it. A member may
also connect a personal harness. Its authority is capped by that member's
current membership and explicit access; it cannot inherit the member's
administrator privileges. Removing the member cuts off the connection's access
at the next verification.

Default-organization creation is idempotent across interrupted and concurrent
signup retries, and leaves the user as an owner. Do not depend on an unrepeatable
login hook for this operation. Accepting an invitation does not silently merge
unrelated accounts.

Signing out revokes the browser session only. It does not revoke API credentials,
OAuth consent, refresh tokens or an installation. Those have explicit
revocation controls. Organization administration must protect the final owner
and make concurrent membership changes safe.

## Request verification and service ownership

For every remote authenticated request, the service uses the shared Platform
path to check current Platform state. No positive verification cache or offline
service verification is part of this MVP. Platform checks credential status and
expiry, authority, expected audience, principal state, current membership or
grant, and relevant consent or installation status. The service identity is
authenticated and the expected audience comes from its Platform registration,
not an arbitrary audience or identity header supplied with the request.

After authentication, the resource-owning service checks its own action-level
ACL. For organization-authorized access, it matches the principal organization
to the resource's stored organization. Guest ownership is checked against the
stored guest owner. Explicit share-link and participant grants are checked
independently of whether the resource owner is a guest or an organization;
claiming does not expand or erase those grants. A Platform grant is an upper
bound on what a principal may do in that service; it is not a resource ACL. A
Gateway or caller-provided header does not establish identity. Services never
forward a credential to another audience or retry a failed verification through
another issuer or identity path. In particular, a rejected delegated or
installation token must not be retried through a human-session verifier.

Invalid, expired or revoked credentials return HTTP 401. An authenticated
principal without resource permission is denied with HTTP 403 or a documented
non-enumerating 404. A disabled principal or suspended organization is denied
at the next authoritative verification. If Platform is unavailable, the
request fails closed with HTTP 503. An already-authorized operation may finish;
no request falls back to anonymous access during an outage. Do not hard-delete
an organization until its resource-owning services have handled its data.

Bootstrap is an explicit, restricted provisioning operation with no shared
default password or broadly reusable secret. Service verifier credentials are
bound to a registered service and allow verification only. They cannot issue
end-user credentials or enumerate organization data. Do not log bearer
credentials, OAuth secrets or browser cookies.

## Guest identity and resource claims

On first use of an anonymous feature, Platform creates a persistent guest
identity for that client automatically. An open message share link remains
immediately usable for reading and posting; the recipient does not have to
register or sign in. The client receives its own guest identity. Platform may
reuse a guest identity across services only when its credentials are
intentionally available there. It does not silently track or correlate clients
or devices. A guest ID proves control of that guest credential, not a person's
real-world identity.

Guest identity, guest bootstrap bearer, service credential and resource
permission are distinct concepts. The guest principal has no organization
authority. A bootstrap bearer has a separately defined purpose and audience;
it is not accepted as a generic service API credential. A service grants access
to a guest only through its registered, authenticated Platform integration and
its own resource rules. Do not trust guest-supplied resource IDs, owner fields,
organization claims or grant claims as proof of ownership.

The message service owns share links, participants and message permissions.
Opening a valid link creates/uses the guest identity automatically and grants
only the link's intended participation. Participation is not ownership, and
participant management remains separate from ownership. When a guest-owned
resource is claimed, existing share links stay valid by default; the claimant
may explicitly revoke them. The claim must not accidentally delete guest
participant identities or their separate permissions.

Claiming a resource requires a knowledge or possession proof of control over its
recorded guest ownership and an authenticated organization with authority to
accept it. The
resource service is authoritative for its resource registration and stored
owner; proof is checked against that state through the service's authenticated
path, not a guest's assertion. Platform establishes the claimant's current
organization authority and any narrow service-bound grant required by the
integration. The precise proof and transport are product-specific validation
work, not an endpoint design in this specification.

The resource service atomically and idempotently transfers ownership while
preserving the resource ID and data. It removes the former guest owner's
ownership permission in that same service transaction. A concurrent or repeated
claim cannot transfer twice or restore the old owner access. Share-link
participation remains a separate permission. Do not globally revoke the
reusable guest identity, its other resource grants or unrelated credentials as
a side effect of one claim. The anonymous Database flow follows these same
rules when Database has an implementation.

Guest access remains usable for as long as the associated resources remain
available under service policy. Do not impose arbitrary guest credential expiry
that destroys access to still-valid resources without a recovery path. Resource
retention is decided by each service, not by Platform.

Platform protects login, recovery, issuance, verification and guest-bootstrap
endpoints with bounded deadlines and distributed limits that work across Worker
instances. Each service owns anonymous-operation quotas and enforcement.
Managed-use allowances are configured by the Cloud operations owner and must not
add a Cloud request-time dependency. Self-hosted operators can configure their
own limits. Creating a new guest identity must not by itself reset a service's
abuse controls.

## Offline application behavior

Local reading, editing and queued changes belong to the application. The app may
retain local work while offline. On reconnect it renews or re-establishes
Platform authentication, but the server checks current resource permissions
when it applies each queued change; a client-side pre-send check is insufficient.
Stale offline authority cannot make the server accept a write after revocation.
If access was revoked, preserve unsynced local work for the user to resolve;
Platform cannot remotely retract data already cached on a device.
Building an offline-sync product flow is deferred.

[T14_RECONNECT_REPORT.md](T14_RECONNECT_REPORT.md) records the reviewed fixture
at aggregate `166e54d`: actual social reauthentication with simulated provider
HTTP, current membership/credential checks, conditional resource ownership at
write, and local queue retention after denial. Aggregate checks pass. This is
session re-establishment, not proof of sliding renewal or a production sync
engine; no application or Database adoption is claimed.

## Adoption scope and acceptance

This is a bounded monorepo integration: implement Platform and its shared
contracts/client/middleware, then move existing Communicator and message-service
authentication paths onto that shared path and retire their local issuers.
Their resource permissions remain service-owned. Other services adopt the same
path as implementations become available; do not invent dependencies or new
service implementations to make the authentication design fit.

Database is a scaffold. Do not build the whole service to prove authentication.
Use a focused, clearly labeled contract fixture with stored tenant ownership and
a resource action to test the shared path and claim rules. Such a fixture is not
production Database adoption and must not be reported as an actual Database
operation. Track Database adoption for when its consumer implementation exists.
Put managed deployment configuration in its real owning workspace; do not
invent a substitute Cloud service or workspace. Full-product login is integrated
only where a product implementation exists.

The MVP is accepted when all of the following are demonstrated:

- Google and GitHub sign-in, account linking with proof of both accounts,
  retry-safe default-organization creation with owner membership, self-hosted
  open/invitation-only configuration, origin/CSRF protections, organization and
  invitation administration, final-owner protection, and Platform-owned
  operator lifecycle controls work in the selected Workers/D1 runtime.
- Shared contracts, client and middleware validate authority, principal kind,
  audience, expiry, membership/grant and failure results. Existing Communicator
  and message-service consumers use this path; a fixture is reported only as a
  fixture.
- Opaque API credentials support scoped issuance, rotation and revocation with
  the configured 90-day default. External harness/MCP OAuth covers PKCE, exact
  redirects, resource validation, consent, refresh rotation/reuse protection,
  revocation and installation binding.
- The same organization-owned agent can receive separate service grants without
  inheriting its creator's rights; removing a member denies that member's
  personal harness on the next authoritative check.
- Anonymous message links remain immediately readable/postable and provision a
  guest automatically. Guest claims prove both guest control and organization
  authority, transfer atomically and idempotently, preserve IDs/data, remove
  owner access, and preserve unrelated grants and default share-link access.
  Guest identity cannot be used as proof of real-world identity or as a general
  service credential.
- Cross-organization and wrong-audience requests are denied; invalid, expired
  or revoked credentials return 401; resource denials return 403 or documented
  non-enumerating 404; unavailable Platform returns 503 without fallback.
  Disabled principals and suspended organizations deny access, and a rejected
  delegated or installation token never retries the human verifier. Resource ACL tests demonstrate that identity
  authentication alone does not grant access. Bootstrap and service-verifier
  credentials cannot issue user credentials or read arbitrary organization
  data. Final-owner changes resist concurrency races.
- Worker/D1 runtime tests prove the chosen adapter's authoritative verification
  and the transactions needed for safe default-organization creation, refresh
  rotation/reuse handling and membership changes. Service-owned atomic claim
  behavior is checked in the real message implementation and focused fixture.

No user/org import, dual-trust period, historical session cutover, full
apps/0000 integration or offline-sync build is an acceptance gate. Database
production adoption is tracked separately and cannot be claimed from a fixture.

## Technical validation still required

The product decisions above are settled. [T01_RUNTIME_REPORT.md](T01_RUNTIME_REPORT.md)
records the pinned versions and the flows exercised in Workers/D1. The following
items remain open and must be verified rather than inferred from documentation
alone:

- The pinned OAuth Provider passes a sequential D1 PKCE/code/refresh-reuse
  probe. Its family invalidation is a sequence of adapter deletes with a
  concurrent race documented in the pinned source. T06/T07 must add authoritative
  Platform installation/grant checks and prove concurrent replay and revocation
  before OAuth acceptance.
- Isolated consent probe `41cd96f` adds per-request auth construction, public
  PKCE, signed flow/reference binding and concurrent organization selection;
  the parent focused Worker/D1 rerun passes three tests. Independent review
  requires coherent current-authority predicates during activation, exact
  selection-race outcomes and fail-closed handling of unbound token responses.
  The code-exchange response bypasses the pinned provider's after hook, so
  production needs a Worker response wrapper with complete route coverage.
  This experiment remains outside the aggregate and does not pass T06/T07.
- A real Miniflare runtime restart preserves a bounded guest grant and resource
  fixture in persistent D1. Human login/session and social linking work across
  local Worker requests with simulated provider HTTP. T03's local Worker/D1
  tests exercise final-owner and invitation races and pass on the reviewed
  aggregate at `c51d285`. The interrupted-signup defect reproduced at `e32e821`
  is repaired and verified at aggregate `54fc212`: exact provider-subject
  recovery, pending-owner constraints, denied-link preservation, concurrent
  retry convergence and positive Google/GitHub callback recovery are covered.
  Deterministic D1 assertions prove the owner constraint; callback races are
  bounded overlap tests, not every possible database interleaving. Actual human
  signup/session/key persistence across a fresh runtime, independent revocation
  and logout pass without migration replay. A losing concurrent link may return
  a provider callback error while preserving recoverability. OAuth lifecycle
  acceptance remains separate.
- The versioned principal, verification route, service registration fixture,
  service-verifier bootstrap and guest-grant exchange are candidate T01
  contracts. T04 now exercises local trusted service registration, human
  credential lifecycle and two exact service audiences through the shared
  client and Worker/D1 fixture; [T04_CREDENTIAL_REPORT.md](T04_CREDENTIAL_REPORT.md)
  records the evidence and its local-only limits. Better Auth encrypts stored Google/GitHub access and refresh
  tokens. The pinned callback assigns `idToken` directly, and T02's test
  asserts only that the stored Google access token differs from its synthetic
  raw value. OAuth server access tokens are configured as opaque and hashed,
  and T06 now normalizes code-issued access through `/internal/v1/authenticate`
  with an exact Platform installation and provider-row binding. Current
  membership, client, service, catalog and consent are checked without
  caller-supplied authority. T07 refresh lifecycle remains outstanding.
- T05 exercises organization-owned agent creation, stable identity across two
  service audiences, live grant and agent lifecycle checks, one-time opaque
  credential issue/rotation/revocation and creator-departure administration in
  local Worker/D1 tests, including controlled narrowing races, coherent live
  verification snapshots and replacement-insert rollback. Aggregate checks pass
  seven Worker/D1 files/ten tests plus restart at `10d31c8`; independent review
  and combined browser controls pass. Service/resource checks remain fixtures,
  not production consumer adoption.
- Confirm managed configuration's real owning workspace and keep runtime
  anonymous enforcement independent of a Cloud network call.

T02 login, account and signup-policy behavior is reviewed and verified on the
aggregate at `7152bcd`, with provider HTTP simulated in Worker/D1 tests. T03
organization, invitation and operator behavior and review fixes are integrated
and independently verified at `c51d285` with real Worker/D1 route tests and
Chromium organization flows. T04 is reviewed, integrated and independently
verified at `dc30cd4`, including credential and organization browser flows. T05
is reviewed, integrated and independently verified at `10d31c8`, with bounded
Worker/D1 agent lifecycle, two-audience and coherent verification evidence.
T06 is reviewed and integrated at `86324b0`: combined checks pass eleven
Worker/D1 files/thirty-two tests plus restart persistence. Native Chromium
approve/deny navigation, real CLI transaction rollback and failed-login retry
are independently verified. The bounded adversarial review found no confirmed
exploitable defect; its login retry regression was corrected and reviewed.
Refresh issuance remains disabled until T07 acceptance.
This local credential and registration evidence does not establish deployed
provisioning, live provider behavior or consumer
adoption. The full Platform authentication MVP remains unimplemented until
every acceptance gate passes. Each report limits its claims to the named flows
and fixtures.
