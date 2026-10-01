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
| Gateway canonical | `https://0000.chat/mcp` | [Gateway](../../services/gateway/docs/README.md); target route |
| Gateway standalone host | `https://gateway.0000.chat/mcp` | [Gateway](../../services/gateway/docs/README.md); target alias |
| Msg | `https://msg.0000.chat/mcp` | [Msg](../../services/msg/README.md); Worker MCP surface, hosted route evidence remains separate |
| Database | `https://database.0000.chat/mcp` | [Database](../../services/database/README.md); target service surface |
| Streams | `https://streams.0000.chat/mcp` | [Streams](../../services/streams/README.md); Worker MCP surface, hosted route unverified |
| Brain | `https://brain.0000.chat/mcp` | [Brain](../../services/brain/README.md); target service surface |

The service-host pattern for a later first-party service is
`https://<service>.0000.chat/mcp`. A service may also expose other HTTP
surfaces, but those do not become Gateway tools merely because they exist.

The apex and standalone Gateway addresses are two direct entry points to the
same MCP surface. Once the apex route is provisioned, both addresses must
serve MCP requests directly, including POST requests, with no HTTP redirect
between them. The apex `/mcp` path and MCP paths beneath it belong to Gateway;
other apex paths remain with the landing application. Route provisioning and
the environment mapping are operator-owned, so this contract does not claim
that either route is configured or deployed.

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
| Gateway | The Worker source provides health and the stateless `gateway_info` MCP diagnostic. | Canonical and standalone MCP routes are target behavior; this document claims no live route. |
| Msg | The Worker contains an MCP implementation and the service owns its Thread protocol. | The direct `/mcp` address is the target service contract; this document claims no new deployment. |
| Database | The public service remains a scaffold without a selected application API. | The direct address is a planned service surface. |
| Streams | The Worker exposes browser, API, and MCP surfaces; route configuration exists. | The direct address is the target service contract; deployment remains unverified. |
| Brain | The public service remains scaffold-only without an application API. | The direct address is a planned service surface. |

Planned contract, implemented code, configured route, and deployed or tested
endpoint are separate states. Service READMEs and the operator's release
evidence provide the more specific state for each surface.
