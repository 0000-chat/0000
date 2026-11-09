---
repo: 0000-chat/0000
status: current
---

# Communicator documentation

This directory contains the imported application runbooks, design records,
implementation plans, and migration handoff for the communication adapters and
delivery-channel runtime.

The files are scoped to `services/communicator` in the `0000` monorepo. Paths
in the runbooks are relative to this service directory. The application keeps
its nested pnpm workspace; the monorepo root uses Bun and Turborepo only for
the outer workspace checks.

The [release bundle contract](release-bundles.md) defines the prebuilt Worker
and UI, native gateway, pinned bridge inputs, consumer verification, and
persistent-state requirements. It does not establish a deployed candidate or
a public MCP address.

The [MCP topology](../../../docs/architecture/mcp-topology.md#communicator-discovery-and-authentication)
defines the standalone target address and discovery/resource contract. The
[authentication runbook](runbooks/oauth-remote-mcp.md) owns Platform-backed
client preparation. Neither document claims a live deployment.

The [saved send authority contract](saved-send-authority.md) defines originating
actor capture, credential expiry, final permission, pinned gateway execution,
and the distinction between denial, temporary unavailability, and uncertainty.

The [integrated local proof runner](../scripts/integrated-proof/README.md)
drives Platform, the Worker, durable storage, and the production-constructed
gateway together against controlled endpoints. Its browser check uses
explicitly simulated data and does not establish live provider acceptance.
