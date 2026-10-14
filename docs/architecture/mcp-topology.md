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

Planned contract, implemented code, configured route, and deployed or tested
endpoint are separate states. Service READMEs and the operator's release
evidence provide the more specific state for each surface.
