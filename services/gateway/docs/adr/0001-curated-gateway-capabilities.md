---
repo: 0000-chat/0000
status: superseded
---

# Curate Gateway capabilities across REST and MCP

This accepted decision is retained for historical context. It is superseded by
the maintained [MCP topology](../../../../docs/architecture/mcp-topology.md),
which makes enabled, service-published tools available in Gateway's default
catalog without requiring per-user opt-in to expose them. Access Profile
discovery and grants still govern what a caller can see and invoke, and the
downstream service retains resource authorization. Gateway does not mirror
arbitrary downstream HTTP routes or grant access automatically.

The historical decision exposed only explicitly selected business operations
as Gateway Capabilities and applied Gateway-level authorization checks once in
shared application behavior across REST and MCP projections. Operational
`/health` remained a REST-only endpoint outside the business capability set.
