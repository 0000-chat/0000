---
repo: 0000-chat/0000
status: current
---

# Gateway

Gateway is a stable entry and adaptation boundary for clients, tools, and services. It does not own product data, identity policy, or downstream service behavior.

## Language

**Gateway Capability**:
A selected business operation offered by Gateway to consumers.

**Service Operation**:
A business operation owned by a downstream service.

**Published Service Tool**:
An agent-facing tool published by a participating first-party service for the
Gateway catalog. Publication does not mirror the service's arbitrary HTTP
routes or grant a caller access to its resources.

**Access Profile**:
The active profile that filters Gateway discovery and supplies tool and
connection grants. Gateway rechecks those grants when a tool is invoked; the
downstream service still authorizes access to its own resources.

Gateway presents connected tools through its `use` interface. Discovery and
`tools.search` are profile-scoped, and profile-specific MCP paths such as
`/mcp/profile/{id}` remain compatible wherever that route form is configured.

The cross-service address and connected-tool contract is maintained in the
[MCP topology](../../docs/architecture/mcp-topology.md). Its target Gateway
addresses are `https://0000.chat/mcp` and
`https://gateway.0000.chat/mcp`; they are intended to serve the same MCP
surface directly, without a redirect, once the apex route is provisioned.
