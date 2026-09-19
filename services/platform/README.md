# 0000 Platform

Start here when working on Platform. This document defines its scope and
ownership boundaries. [AUTH_FIRST_SPEC.md](AUTH_FIRST_SPEC.md) records the
agreed authentication MVP and its acceptance gates. [T01_RUNTIME_REPORT.md](T01_RUNTIME_REPORT.md),
[T02_ACCOUNT_REPORT.md](T02_ACCOUNT_REPORT.md),
[T03_ORGANIZATION_REPORT.md](T03_ORGANIZATION_REPORT.md), and
[T04_CREDENTIAL_REPORT.md](T04_CREDENTIAL_REPORT.md), and
[T05_AGENT_REPORT.md](T05_AGENT_REPORT.md) record bounded Worker/D1 evidence.
T01 through T05 are reviewed and verified on the aggregate branch. T05 aggregate
checks passed at `10d31c8` (seven Worker/D1 files, ten tests and restart).
[SIGNUP_RECOVERY_REPORT.md](SIGNUP_RECOVERY_REPORT.md) records the reviewed
recovery follow-up; combined checks at `54fc212` pass eight Worker/D1 files,
twenty tests and separate guest/resource and human runtime restart probes.
[T08_GUEST_REPORT.md](T08_GUEST_REPORT.md) records the reviewed guest lifecycle.
Combined checks at `1d221bb` pass nine Worker/D1 files, twenty-two tests,
format/typecheck and guest/resource runtime restart. This establishes the shared
guest boundary used by the msg integration described below.
[GUEST_PERMISSION_REPORT.md](GUEST_PERMISSION_REPORT.md) records the reviewed
permission follow-up integrated at `ddf93ad`. Independent checks pass ten
Worker/D1 files, twenty-seven tests, format/typecheck and restart persistence.
Distinct owner and participant permissions can coexist on one resource without
widening or revoking each other; pre-migration grants retain their default
permission. Msg binds each grant to its local permission source.
The [shared client](../../packages/platform-client/README.md) transport follow-up
is integrated at `82e6181`: verification and guest operations have a configurable
deadline covering fetch and body parsing, reject redirects, and preserve
failure categories. Twelve client tests and the twenty-seven-test Platform
suite plus restart pass independently; native and adversarial reviews found no
confirmed defect. T12's server-side rate limits and audit remain outstanding.
T03 aggregate checks passed at `c51d285`; T04 checks passed at `dc30cd4`.
[T14_RECONNECT_REPORT.md](T14_RECONNECT_REPORT.md) records the independently
reviewed reconnect fixture, integrated and verified at `166e54d`.
[T06_OAUTH_REPORT.md](T06_OAUTH_REPORT.md) records the bounded code-only
personal-harness OAuth installation flow and its Worker/D1 evidence. T06 is reviewed and
integrated at `86324b0`; combined checks pass eleven Worker/D1 files, thirty-two
tests, formatting/typecheck and restart persistence. Independent browser
approve/deny and trusted CLI rollback checks pass. Final review's login-error
retry regression is corrected and independently verified. Provider HTTP remains
simulated; these checks do not establish external-client adoption.
[Msg's report](../msg/T09_PLATFORM_AUTH_REPORT.md) records its reviewed shared
auth integration at `be5b001`. Parent combined checks pass the full msg package,
the actual Platform Worker/D1-to-msg Worker/DO boundary with 59 assertions, and
Platform's 32 tests plus restart. Chromium guest, management, recovery,
revocation and outage flows pass independently.
[T09_NOTIFICATIONS_MERGE_REPORT.md](T09_NOTIFICATIONS_MERGE_REPORT.md) records
the upstream notification merge, forward schema reconciliation and participant
recovery correction, with combined actual Platform/msg boundary evidence.
[Msg's claim report](../msg/T10_CLAIM_REPORT.md) records atomic guest-to-organization
transfer, exact authorized retries, preserved participants and explicit link
revocation, reviewed and integrated at `c54d884`. Parent checks pass the full
msg package and 83 actual Platform/D1-to-msg/DO claim assertions; deterministic
DO expiry coverage also passes. Native reviews and the bounded adversarial
review found no remaining confirmed defect. The Database-style fixture remains
a local contract fixture.
[Msg's quota report](../msg/T13_QUOTA_REPORT.md) records service-owned managed
and self-host policy configuration, integrated at `4242217`. Parent combined
checks pass 198 Worker tests, 20 tooling tests, 66 CLI tests and build/pack.
Actual Platform guest replacement preserves the same actor's exhausted quota;
executed production-entry checks deny all missing or failed action bindings
before resource calls. Native and bounded adversarial reviews found no remaining
confirmed defect. Limits remain per-location and permissive; private Cloud
configuration publication remains T15. Communicator integration remains T11.
[T07_OAUTH_REPORT.md](T07_OAUTH_REPORT.md) records the bounded trusted-client
refresh rotation, replay protection and installation-control implementation.
T07 is reviewed and integrated at `1d519cd`. Parent combined checks pass twelve
Worker/D1 files and forty-nine tests, formatting/typecheck, persistence and
refresh restart probes, Chromium installation controls, and 142 actual
Platform-to-msg boundary assertions. Native and bounded Grok reviews close the
refresh and installation-isolation findings. [The runtime report](T07_RUNTIME_ACCEPTANCE_REPORT.md)
describes the restart/browser evidence. Provider HTTP remains simulated; these
checks do not establish external-client adoption. Communicator human/browser
integration, server safeguards and setup remain open.
The full MVP is not implemented or accepted, and these reports do not establish
production readiness.

[T11_SERVICE_PRINCIPAL_REPORT.md](T11_SERVICE_PRINCIPAL_REPORT.md) records the
bounded organization-owned service-principal prerequisite, integrated here on
the existing machine lifecycle. Service principals have an immutable stored
kind, stable `subjectId` values, fixed-kind owner/admin management routes,
per-audience grants and opaque credentials, and authoritative current-state
verification. Parent acceptance at `cb89383` passes thirteen Worker/D1 files and
fifty-two tests, formatting/typecheck, persistence and refresh restart, and the
actual Platform-to-msg boundary (142 assertions). Independent Standards/Spec
reviews and a bounded Grok runtime-kind review are clear. Communicator adoption,
deployment provisioning and full T11 consumer acceptance remain open. The
[T11 browser report](T11_BROWSER_REPORT.md) records the first-party human
browser purpose, shared SDK, real Worker/D1 consumer fixture and Chromium
proof; it does not claim Communicator adoption or deployed provisioning.

[T11_BINDINGS_REPORT.md](T11_BINDINGS_REPORT.md) records the reviewed immutable
Communicator mappings and current local-state resolver. Actual D1 proves
terminal history and tenant association, including replacement attempts. Public
routes, provisioning, UI and realtime adoption remain pending.

[T11_MATRIX_CALLER_REPORT.md](T11_MATRIX_CALLER_REPORT.md) records the bounded
Matrix gateway caller prerequisite: protected finite ingestion and claim
credentials, separate transport secrets, and explicit recovery after a 401
without automatic daemon or supervisor replay. Actual coordinator, protected-file
replacement and persisted-batch tests pass. The real Platform-to-Communicator
boundary remains a separate T11 gate.

## Purpose and deployment

0000 Platform is the shared open-source identity and credential authority for
0000 services. It owns human accounts, organizations, memberships, agent
identities, grants, credentials and their lifecycle within a deployment.
Better Auth is the selected human identity foundation. Product services use
Platform's shared contract, client and middleware instead of issuing credentials
or inventing independent auth systems.

The same Platform supports these deployment shapes:

| Deployment | How Platform is used |
| --- | --- |
| OSS self-hosted services | The operator runs the open-source Platform with selected services, using its own Google/GitHub provider credentials. The MVP target is Workers and D1, with local development; Docker is outside the MVP. No 0000 Cloud account is required. |
| Managed standalone services and external harnesses | Managed Platform serves service-only customers and external clients such as CLI, harness and MCP integrations. Spaces and the full product UI are not prerequisites. |
| Managed full 0000 product | The product uses the same Platform accounts and organizations, then adds its Spaces, threads, agent control and product UI. |

“Standalone” describes a service that customers can use independently as a
product. It still uses Platform. There is one logical identity authority per
deployment, not one global authority across all self-hosted installations.
Spaces are optional product organization, not a required tenant layer for
service-only customers.

Managed signup is open by default and creates a default organization. Self-hosted
operators choose open or invitation-only signup. That choice is independent of
guest access to shared resources.

## Ownership

| Concern | Owner |
| --- | --- |
| Human login, browser sessions, profile and external identity links | Platform through Better Auth |
| Organizations, human memberships and membership administration | Platform |
| Stable human, organization-owned agent and guest identities | Platform |
| API credential and OAuth issuance, validation, expiry, rotation and revocation | Platform |
| Agent grants, OAuth consent and installation identity | Platform, bounded by current membership and service permissions |
| Common principal contract, validation client and authentication middleware | Platform-owned shared packages |
| Databases, connections, streams, messages, knowledge resources and their ACLs | The service that owns each resource |
| Spaces, threads, application state, agent execution/control and full-product UI | The assembled product |
| Managed fleet provisioning, billing, allowances and support | The actual Cloud operations owner |

Platform authentication establishes who or what made a request and the
organization or grant under which it acts. It does not grant blanket access to
that organization's resources. Services check their own resource ACLs and may
further restrict an authenticated principal. For an organization-owned resource,
the service checks its stored organization association; for a guest-owned
resource, it checks its stored guest owner or participant grant. Platform
startup and identity persistence do not depend on the public 0000 Database
service.

An organization-owned agent has the same stable identity across services, with
a separate grant and credential for each service audience. It does not inherit
its creator's permissions. It survives its creator leaving the organization;
organization administrators can manage its grants and lifecycle. A personal
harness connection instead remains bounded by the member's current membership
and delegated access; it cannot inherit the member's administrator privileges,
and removing that membership cuts off its access.

The account UI covers profile, linked sign-in providers, default-organization
access status and sign-out. T03 adds explicit organization selection and
creation, organization naming, member roles/removal/leave, copyable invitations
and verified-email acceptance. A separate operator section can suspend or
restore organizations and disable or restore human accounts when an existing
user ID is explicitly configured. T04 adds personal opaque API credentials
scoped to the selected organization and registered service audience, with
one-time issue display, metadata listing, rotation and revocation. See the T03
and T04 reports for bounded local evidence and review status. T05 adds
organization-owned agent creation, lifecycle, per-service grants and agent
credential controls to this account UI. T06 covers the bounded
authorization-code/PKCE personal-harness
consent and installation path; T07 refresh rotation and installation
revocation remain later Platform work. Platform does not own product
Spaces, threads, agent execution or the full product's agent-control
experience.

## Guest identity and resource ownership

Platform can create a persistent, organization-less guest identity for a client
when it first uses an anonymous feature. This lets a recipient open a message
share link and read or post immediately without creating an account. The guest
identity is not proof of a real-world identity, and Platform does not secretly
correlate separate clients or devices. Its use across services requires explicit
service-specific credentials or grants.

The message service owns share-link and participant permissions. A link grants
participation, not ownership; participant management is separate from resource
ownership. An anonymous database flow follows the same principal and claim
boundaries when Database has a working consumer implementation. A guest identity
or bootstrap credential alone never grants access to an arbitrary service
resource.

Claiming a guest-owned resource requires proof of control over its registered
guest ownership and an authenticated organization's authority to accept it. The
resource-owning service verifies its stored ownership record and performs an
atomic, idempotent transfer that preserves the resource ID and data. A retry
cannot restore the old owner grant or claim the resource twice. Existing share
links remain valid by default unless the claimant explicitly revokes them;
claiming ownership does not erase participant identities or their separate
permissions. The operation does not revoke the guest's unrelated credentials or
resource grants. Guest access lasts while the relevant resources remain
available under service policy; Platform does not impose an arbitrary expiry
that strands a guest. Resource retention remains service-owned.

## Relationship to the ecosystem

| Component | Relationship to Platform |
| --- | --- |
| Database | Uses shared principals; owns databases, their ACLs and resource claims |
| Streams | Uses shared principals; owns stream permissions; also depends on Database |
| Brain | Uses shared principals; owns knowledge resources and their permissions |
| Communicator | Uses shared principals; owns connections, installations and operation permissions |
| Message service | Uses shared principals; owns messages, share links and participant permissions |
| Gateway | May route requests; untrusted headers do not establish identity |
| Full 0000 product | Uses the same users and organizations; owns Spaces, threads and its UI |
| Cloud | Operates the same system without another customer identity directory |

Do not invent service dependencies merely because components share a monorepo.
Separate deployments remain separate trust domains; moving identities or
resources between them requires an explicit migration. Never link identities
only because email addresses match.

## Code boundaries

services/platform/ owns Better Auth, identity and tenancy state, and credential
authority. packages/contracts/ publishes the versioned principal and
authentication result contracts. packages/platform-client/ provides validation,
transport adapters and shared middleware. Each service owns resource
authorization and domain behavior.

The shared contract and client are part of Platform's responsibility. They must
not expose Better Auth storage as a service API or become alternate issuers. A
non-TypeScript service must be able to implement the same wire contract.
Cloudflare Workers is the initial runtime direction; the monorepo's Bun and
Turborepo tooling does not select the production runtime.

## Local setup and operator credentials

Install the monorepo dependencies with `bun install --frozen-lockfile` from the
repository root. From `services/platform`, initialize the local identity schema
with `bun x wrangler d1 migrations apply platform-identity --local`, then start
Wrangler with `bun run dev`. It serves `http://localhost:8787`. Copy
`.dev.vars.example` to `.dev.vars` and replace its Google/GitHub client IDs and
secrets plus `BETTER_AUTH_SECRET`. Register these local callback URLs with the
provider applications:
`http://localhost:8787/api/auth/callback/google` and
`http://localhost:8787/api/auth/callback/github`. If the local port or public
Worker URL changes, set `PLATFORM_BASE_URL` to that exact origin and update the
provider callback URLs to match.

Wrangler configuration contains only example IDs and no provider or Better Auth
secret values. Deployed operators set `GOOGLE_CLIENT_ID` and `GITHUB_CLIENT_ID`
as Worker variables and provide `GOOGLE_CLIENT_SECRET`, `GITHUB_CLIENT_SECRET`
and `BETTER_AUTH_SECRET` with Wrangler secrets in the target environment. The
Better Auth secret also protects its encrypted social-provider access and
refresh tokens. Example values are placeholders and must not be used as
deployment credentials.

Operator lifecycle controls are disabled unless the Worker variable
`PLATFORM_OPERATOR_USER_ID` names an existing Better Auth user ID. An operator
chooses the account using trusted access to the identity database, then sets
that ID in the target Worker environment; the account's email or organization
role is not authority. Keep the variable empty until an operator is explicitly
chosen. Changing it rotates the operator identity and uses the same mechanism
for self-hosted and managed deployments. There is no first-signup promotion or
shared bootstrap password.

`PLATFORM_DEPLOYMENT_MODE=self-hosted` with
`PLATFORM_SIGNUP_POLICY=open` is the local default. Managed deployments always
allow signup. Self-hosted operators may choose `open` or `invite-only`; the
latter requires a verified provider email matching an unexpired pending
invitation to an active organization. T03 provides invitation management and
acceptance in the account UI without sending email. Membership, invitation and
operator lifecycle checks remain in Platform's shared identity boundary; see
the bounded T03 report for implementation and local test evidence.

Personal API credentials use the positive finite Worker variable
`PLATFORM_CREDENTIAL_MAX_LIFETIME_DAYS`; it defaults to `90` days in
`wrangler.jsonc`. The account form labels requested lifetimes in days. A
request may shorten the configured maximum, while omitted duration uses the
maximum; zero, negative, non-finite or larger values are rejected. An invalid
server configuration makes credential issuance and rotation unavailable.
Secrets are shown once and are not stored in browser storage or URLs. Operators
register trusted resource services with the local deployment tool, for example
`bun run provision:service -- --local register --service-id service-id --audience https://service.example/mcp --capability resource:read`.
The tool supports metadata updates, verifier rotation and disablement; use
`--remote` only when an operator intentionally targets a remote D1 database.

Organization-owned service principals use the same owner/admin session and
origin-protected account boundary as agents. Their management API is rooted at
`/api/account/service-principals`; lifecycle, grants and credential operations
use `/update`, `/lifecycle`, `/grants`, `/grants/revoke`, `/credentials`,
`/credentials/rotate` and `/credentials/revoke`. Service routes fix the machine
kind to `service` and use `subjectId` for the stable principal identifier;
request metadata cannot convert an agent or service principal. Credential
secrets are returned only from issue/rotation responses, while listing returns
metadata. These routes are a Platform prerequisite and do not add an account
UI, an OAuth `client_credentials` grant or service-consumer integration.

Rate limits for Platform login, credential issuance and guest bootstrap belong
to Platform. Anonymous operation quotas and enforcement belong to each resource
service. Managed allowances are configured by their actual Cloud owner and must
not require a request-time call to Cloud. Self-hosted operators configure their
own limits. Creating another guest identity must not reset a service's abuse
controls.

Offline reading, editing and queued work belong to the application. When it
reconnects, the server checks authentication and resource permission against
current state when it applies each queued write; a client-side pre-send check is
not enough. Revocation can reject queued writes but must not discard unsynced
local work; Platform cannot retract data already cached on a device.

## Status and first outcome

As of 2026-09-19, Platform has a reviewed T01 Worker/D1 investigation and T02
human account slice, plus runnable principal/client contracts in
`packages/contracts` and `packages/platform-client`. T03 adds organization and
membership administration, invitation acceptance and explicitly configured
operator lifecycle controls; its implementation and review fixes are integrated
and verified at `c51d285`. T04 adds bounded personal credential lifecycle UI,
validated local service registration tooling and a two-audience Worker/D1
fixture, reviewed and independently verified at `dc30cd4`; its exact evidence
and limits are in `T04_CREDENTIAL_REPORT.md`. T05 implements organization-owned
agents, separate audience grants and agent credential lifecycle in the local
Worker/D1 path; [T05_AGENT_REPORT.md](T05_AGENT_REPORT.md) records its bounded
worker evidence and limitations, independently reviewed and verified on the
aggregate at `10d31c8`.
T06 adds a bounded code-only OAuth installation flow; [T06_OAUTH_REPORT.md](T06_OAUTH_REPORT.md)
records its evidence. T07 adds explicitly trusted refresh-enabled personal
harnesses, hash-only rotation lineage, replay fencing and account revoke;
[T07_OAUTH_REPORT.md](T07_OAUTH_REPORT.md) records its local evidence and
limits. Local Worker tests exercise
Better Auth callbacks, sessions, D1 persistence, signup policy, profile,
organization, human credential, agent and T06 OAuth controls;
Google/GitHub
HTTP responses are simulated at the provider boundary. The service and
protected-resource checks remain fixtures. This is not a deployed identity
service or a complete shared-auth integration. T06 does not claim a live
external provider/client or consumer adoption; managed deployment ownership and
aggregate T07 acceptance remain later work.
Database is also a scaffold.
The message service now uses shared Platform authentication with local resource
ACLs; Communicator still needs that migration. No
apps/0000 implementation was found, so its login and offline-sync integration
is neither implemented nor required for this MVP. Platform's own account UI is
in scope.

The MVP outcome is a user who signs in, manages an organization and grants,
connects a harness or obtains a scoped API credential, and uses existing
consumers through one validated integration path. Anonymous message links remain
immediately usable and create a guest identity automatically. Revocation,
cross-organization denial, audience checks and narrowly granted agent behavior
must be proven. A focused contract fixture is useful evidence for the boundary;
it is not production adoption by Database or another scaffold.

The MVP uses Workers and D1 directly and does not require Docker. Public
repository visibility is not a license grant; license selection is separate
from this scope. Managed operations may add convenience but cannot be a
requirement for legitimate self-hosting.
