---
repo: 0000-chat/0000
status: current
---

# 0000-gateway

`0000-gateway` aims to give clients, tools, and services one clear way to reach
the capabilities they need.

It hides differences between underlying services, translates requests when
their shapes differ, and routes work to the right capability. Consumers should
not need to understand the internal layout of the 0000 family.

This service is responsible for:

- presenting a stable boundary to consumers;
- directing requests to the right capability;
- adapting between different service expectations;
- keeping service-specific details out of clients.

It does not own product data, make product decisions, provide communication
channels, or define the hosted user experience. It requires `0000-platform` for
common identity and authentication; standalone use does not require a hosted
0000 account.

This directory is the Gateway subtree in the `0000` monorepo. Its root
`package.json` is the private `@0000/gateway` workspace. The Worker serves a
public `GET /health` liveness endpoint that returns `{"status":"ok","service":"gateway"}`.
The endpoint makes no downstream calls and reads no product data. It reports
Worker liveness only and is not a Gateway Capability.

The Worker uses Hono and has an explicit Wrangler compatibility date and
`nodejs_compat` flag. Its application test dispatches through a real
Miniflare/workerd runtime. Original pnpm-based quality tooling and its
lockfile remain isolated under `tooling/`.

From the monorepo root, run `bun run check`, `bun run check:turbo`, and
`bun run check:turbo:dry`. For Gateway checks, run
`pnpm --dir services/gateway/tooling install --frozen-lockfile` followed by
`pnpm --dir services/gateway run check:application`.

## MCP topology and delivery maturity

The public cross-service contract is the [MCP topology](../../docs/architecture/mcp-topology.md).
It names `https://0000.chat/mcp` as the canonical Gateway address and
`https://gateway.0000.chat/mcp` as a standalone host for the same MCP surface.
Both addresses are intended to serve MCP directly, without a redirect, after
the apex route is provisioned. Gateway's default built-in catalog includes
enabled, service-published first-party tools; profile grants and each owning
service's resource authorization remain separate checks. A catalog entry does
not grant permission or create a hard dependency on every service.

The current Worker milestone remains a health endpoint and a stateless
`gateway_info` diagnostic. The addresses and connected service-tool catalog
are target behavior; this README does not claim a configured route or live
deployment. Public CI publishes the immutable Worker artifact, while the
operator-owned release path supplies environment routes and promotion evidence.
