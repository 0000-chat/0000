# 0000-gateway

This directory contains the gateway service inside the public `0000` monorepo.
Gateway now has its first Cloudflare Worker application: public liveness
`GET /health` and a public stateless MCP endpoint at `/mcp` exposing only the
`gateway_info` diagnostic. These are operational probes, not Gateway
Capabilities. This milestone makes no downstream service calls and has no
Platform auth middleware, service bindings, database, secret, or selected
license. It composes `mcp-use`; it does not fork or vendor it. The service may
compose the Executor SDK later.

The foundation plan, specification, and ADR are approved. This documentation
does not claim a production deployment or live hostname evidence.

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
