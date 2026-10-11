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
public `GET /health` liveness endpoint that returns
`{"status":"ok","service":"gateway"}`. It makes no downstream calls and reads
no product data. It reports Worker liveness only and is not a Gateway
Capability. The unauthenticated `/mcp` surface exposes the same operational
`gateway_info` diagnostic.

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

The authenticated boundary is available when the deployment supplies the
Platform Verification binding, the `gateway_profiles` and
`gateway_profile_tool_grants` D1 tables, and a service binding. Platform
returns an agent principal containing `agentId`, `organizationId`, and
`profileId`; Gateway does not issue or interpret credentials itself. Gateway
management accepts only a verified human session with Platform's explicit
`canManageProfile` permission. A missing verifier, database, or service
binding fails closed.

The canonical `/mcp` route derives the organization and profile from the
verified agent credential. `/mcp/profile/{id}` and
`/mcp/organizations/{org}/profiles/{id}` remain compatible aliases and
reject credential/profile mismatches. The profile-scoped catalog contains
`use`, `tools.search`, and granted declarations published by service-owned
MCP `tools/list` responses. The Msg adapter uses the direct
`https://msg.0000.chat/mcp` surface through a service binding, never forwards
the incoming Platform credential, and sends only informational Gateway
identity headers. Msg still authorizes each Thread or resource capability.

`use` accepts the documented restricted JavaScript subset: literals, arrays,
null-prototype object literals, bindings, returns, direct `tools` calls,
`tools.search`, and exact-name `tools.call`. It has complete-program
parsing, bounded syntax depth and node count, at most eight host calls,
bounded output, and a five-second execution/dependency deadline. Programs
have no network, filesystem, credential, global, loop, import, or dynamic-code
access; all effects pass through the per-call Gateway grant and a fresh
Platform credential check. This is a bounded interpreter, not a general
JavaScript runtime.

The connected catalog and authenticated routes are locally tested Worker
behavior. The addresses and hosted bindings remain target behavior; this
README does not claim a configured route or live deployment. Cloud owns route,
binding, migration, and secret configuration, while each downstream service
owns its service-tool declarations and resource authorization.
