---
repo: 0000-chat/0000
status: current
---

# MCP topology

This document is the public cross-service contract for MCP addresses and the
Gateway's connected-tool surface. Each service owns its operation semantics,
resource authorization, and implementation documentation. An address in this
document is a target contract; it is not evidence that code, a route, or a
deployment is already live.

## Addresses

Every first-party MCP surface uses the `/mcp` path.

| Surface | Target MCP address | Owner and maturity |
| --- | --- | --- |
| Msg canonical Worker | `https://0000.chat/mcp` | [Msg](../../services/msg/README.md); selected Worker resource and URL contract, `msg.0000.chat/mcp` remains a POST compatibility origin |
| Gateway standalone host | `https://gateway.0000.chat/mcp` | [Gateway](../../services/gateway/docs/README.md); selected standalone MCP surface |
| Gateway apex route (deferred) | `https://0000.chat/mcp` | [Gateway](../../services/gateway/docs/README.md); previous assembled target, requiring a future separate route/host decision |
| Database | `https://database.0000.chat/mcp` | [Database](../../services/database/README.md); target service surface |
| Streams | `https://streams.0000.chat/mcp` | [Streams](../../services/streams/README.md); Worker MCP surface, hosted route unverified |
| Brain | `https://brain.0000.chat/mcp` | [Brain](../../services/brain/README.md); target service surface |
| Communicator | `https://communicator.0000.chat/mcp` | [Communicator](../../services/communicator/docs/runbooks/oauth-remote-mcp.md); standalone target following the service-host convention, Platform-backed Worker implementation; no deployment claim |

The service-host pattern for a later first-party service is
`https://<service>.0000.chat/mcp`. A service may also expose other HTTP
surfaces, but those do not become Gateway tools merely because they exist.

Msg owns the selected apex Worker and `/mcp` contract for this cutover. Its
compatibility host continues to accept MCP POSTs and legacy OAuth flows. The
Gateway remains directly addressable at `gateway.0000.chat/mcp`; its previous
assembled apex target is deferred until a future separate route or host
decision. Route provisioning and the environment mapping are operator-owned,
so this contract does not claim that either selected route is configured or
deployed.

## Gateway connected tools

Gateway's default built-in catalog contains enabled, service-published tools
from participating first-party services such as Msg, Database, Streams, and
Brain. This gives clients one common Gateway entry point while leaving the
service MCP endpoints independently addressable.

Catalog availability does not grant execution access. A client does not need a
per-user opt-in just to expose or discover the default built-in catalog, but
the active Access Profile still controls which tools and connections are
visible and callable. Gateway filters discovery for that profile and rechecks
the profile grant at invocation. The Gateway `use` interface is the primary
agent-facing entry for these connected tools; discovery and `tools.search`
return only what the active profile can call. Profile-specific MCP paths such
as `/mcp/profile/{id}` remain compatible with this contract wherever that
route form is configured. The profile-bound credential establishes the caller
context; the downstream service remains responsible for authorization to its
own resources.

Gateway does not mirror arbitrary downstream HTTP routes, and cataloging a
service does not create a hard runtime dependency on every other service.
Service-owned authorization and the profile grant are both required when a
connected tool is called. Direct service MCP clients continue to use the
service's own authentication and resource-authorization contract.

## Current maturity

The following status keeps target topology separate from repository and route
evidence:

| Surface | Repository evidence | Hosted status represented here |
| --- | --- | --- |
| Gateway | The Worker source provides health, the stateless `gateway_info` diagnostic, and a configured-app path for authenticated profile-bound `use`, `tools.search`, D1 grants, and service-owned catalog adapters. Gateway tests exercise the boundary in a real Worker runtime, including the Msg adapter. | The standalone MCP route is the selected Gateway surface; the previous apex target is deferred. This document claims no live route or hosted binding. |
| Msg | The Worker contains an MCP implementation and the service owns its Thread protocol. | Msg owns the selected canonical Worker resource and `/mcp` entry at `https://0000.chat/mcp`; `https://msg.0000.chat/mcp` remains the POST compatibility entry. This document claims no new deployment. |
| Database | The public service remains a scaffold without a selected application API. | The direct address is a planned service surface. |
| Streams | The Worker exposes browser, API, and MCP surfaces; route configuration exists. | The direct address is the target service contract; deployment remains unverified. |
| Brain | The public service remains scaffold-only without an application API. | The direct address is a planned service surface. |
| Communicator | The Worker implements Platform-backed discovery, authenticated stateless MCP POST, and service-owned resource authorization. Extracted-bundle tests exercise discovery and denial locally. | The standalone address is a target contract only. No public route, registration, Gateway inclusion, or deployment is verified here. |

Planned contract, implemented code, configured route, and deployed or tested
endpoint are separate states. Service READMEs and the operator's release
evidence provide the more specific state for each surface.

## Communicator discovery and authentication

Communicator's standalone target follows the service-host convention above.
Its MCP transport URL is `https://communicator.0000.chat/mcp`. The registered
resource and audience for that target are `https://communicator.0000.chat`,
without the `/mcp` transport path. This matches the public production
[configuration](../../services/communicator/apps/control-plane/wrangler.jsonc).
Self-hosted operators can register another origin and resource. Clients use
the exact resource advertised by discovery rather than appending `/mcp` or
assuming that every service uses the Msg resource contract.

The [authentication runbook](../../services/communicator/docs/runbooks/oauth-remote-mcp.md)
owns configuration and client preparation. The implemented discovery contract
requires the complete Platform browser configuration:

- An unauthenticated `/mcp` request returns `401` with a Bearer
  `resource_metadata` challenge pointing at the request origin's
  `/.well-known/oauth-protected-resource`.
- Both that metadata path and `/.well-known/oauth-protected-resource/mcp`
  advertise the configured `COMMUNICATOR_PLATFORM_BROWSER_RESOURCE`, Platform
  base URL in `authorization_servers`, configured scopes, and the service
  OpenAPI documentation URL. The alias does not change the resource.
- `/.well-known/oauth-authorization-server` advertises the configured Platform
  issuer and its `/api/auth/oauth2/authorize` and `/api/auth/oauth2/token`
  endpoints with authorization-code PKCE S256. Communicator does not issue
  these credentials. Missing browser configuration returns unavailable
  metadata rather than falling back to the retired local issuer.
- Authenticated MCP uses POST with the SDK's Streamable HTTP request headers.
  Authenticated GET returns `405` with `Allow: POST`. Server clients can omit
  `Origin`; an explicit `Origin` must equal the request origin. This contract
  does not add cross-origin browser access or a persistent SSE session.

Platform validates credentials. Communicator separately checks the immutable
local principal binding and its tenant, identity, account, and chat grants.
Platform capabilities limit those grants; neither discovery nor tool listing
grants execution. The same registered resource protects API and MCP access.
The [Platform verifier](../../services/communicator/apps/control-plane/worker/auth/platform.ts),
[discovery routes](../../services/communicator/apps/control-plane/worker/auth/browser-routes.ts),
and [MCP handler](../../services/communicator/apps/control-plane/worker/mcp.ts)
own the implementation. Retired Worker-local OAuth issuance is not a consumer
prerequisite.

This is a public target and local implementation contract, not evidence of
DNS, TLS, routes, Platform registrations, deployment, or external-client
acceptance. Gateway catalog inclusion remains separate and is not established
by this direct-service contract. Release consumers verify the
[bundle composition](../../services/communicator/docs/release-bundles.md)
before any separately authorized publication or deployment.
