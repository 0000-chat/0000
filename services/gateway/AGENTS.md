---
repo: 0000-chat/0000
status: current
---

# 0000-gateway

This directory contains the gateway service inside the public `0000` monorepo.
Gateway has a Cloudflare Worker application with public liveness `GET /health`
and a public stateless MCP endpoint at `/mcp` exposing the `gateway_info`
diagnostic. When Platform Verification, the Gateway D1 migration, and a
service binding are configured, the same `/mcp` entry and compatible
profile-specific paths expose an authenticated, profile-bound `use` boundary
and deterministic `tools.search`. New profiles have no grants; every service
call is checked against the current profile and the owning service's resource
rules. The checked-in Wrangler config binds neither dependency, so protected
requests fail closed until a deployment supplies them. It composes `mcp-use`;
it does not fork or vendor it. The service may compose the Executor SDK later.

The foundation plan, specification, and ADR are approved. This documentation
does not claim a production deployment or live hostname evidence.

The maintained cross-service target is recorded in the [MCP topology](../../docs/architecture/mcp-topology.md):
`https://0000.chat/mcp` is canonical and
`https://gateway.0000.chat/mcp` is the same direct MCP surface without a
redirect. Route provisioning and deployment evidence remain operator-owned.

The root Bun and Turborepo workspace owns monorepo validation. Run
`bun run check`, `bun run check:turbo`, and `bun run check:turbo:dry` from the
monorepo root. Gateway source and tooling checks are exposed as
`check:application`; first run `pnpm --dir services/gateway/tooling install
--frozen-lockfile` from the monorepo root, then run
`pnpm --dir services/gateway run check:application`.

Standalone public components do not require hosted platform authentication.
Cloudflare is the public ingress and normal runtime class. Make changes on a
feature branch in the monorepo; do not commit directly to `main`.

## Agent skills

### Issue tracker

Gateway issues are tracked in `0000-chat/0000` with the `service:gateway`
label. See `docs/agents/issue-tracker.md`.

### Triage labels

Use the five default triage labels in `docs/agents/triage-labels.md`.

### Domain docs

This service uses a single-context domain-doc layout. See
`docs/agents/domain.md`.
