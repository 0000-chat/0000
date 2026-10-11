---
repo: 0000-chat/0000
status: current
---

# Gateway documentation

The cross-service MCP address and connected-tool contract is maintained in the
root [MCP topology](../../../docs/architecture/mcp-topology.md). This service
directory owns Gateway implementation and protocol details:

- [ADR 0002: canonical apex MCP address](adr/0002-canonical-apex-mcp-address.md)
  records the direct apex and standalone-host behavior.
- [Gateway foundation plan](plans/2026-09-19-gateway-foundation.md) and
  [specification](specs/gateway-foundation.md) record the diagnostic milestone
  and its boundaries.
- [Authenticated Gateway to Msg contract](specs/gateway-authenticated-msg.md)
  records the profile-bound MCP boundary, restricted `use` contract, and the
  exact Platform, Msg, and Cloud obligations for the connected milestone.
- [ADR 0001](adr/0001-curated-gateway-capabilities.md) is retained as a
  superseded historical decision; the maintained topology governs the default
  service-tool catalog and profile grants.

Monorepo import and preservation facts are recorded in
[`migration/2026-09-17-monorepo-import.md`](migration/2026-09-17-monorepo-import.md).
