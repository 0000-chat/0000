# 0000 Platform

Start here when working on Platform. This document defines its scope and
ownership boundaries. [AUTH_FIRST_SPEC.md](AUTH_FIRST_SPEC.md) records the
agreed authentication MVP and its acceptance gates. [T01_RUNTIME_REPORT.md](T01_RUNTIME_REPORT.md)
records the bounded Worker/D1 investigation. The full MVP is not implemented
or accepted; the T01 probe does not establish production readiness or consumer
adoption.

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

The Platform account UI covers profile, organizations, memberships, agent
identities, OAuth consent and credentials. It does not own product Spaces,
threads, agent execution or the full product's agent-control experience.

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

As of 2026-09-19, Platform has a bounded Worker/D1 T01 investigation in
services/platform and runnable principal/client contracts in
packages/contracts and packages/platform-client. Its real Better Auth callback,
credential verifier and guest-grant route are exercised through local Worker
tests; the external GitHub HTTP boundary and protected resource service are
fixtures. This is evidence for the first slice, not a deployed identity service
or a complete shared-auth integration. The account UI, lifecycle administration,
OAuth installation state, production service provisioning and consumer adoption
remain unimplemented. Database is also a scaffold. Communicator and the message
service have existing auth paths that the MVP must move to the shared Platform
path while leaving resource ACLs local. No apps/0000 implementation was found,
so its login and offline-sync integration is neither implemented nor required
for this MVP. Platform's own account UI is in scope.

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
