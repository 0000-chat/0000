# Domain docs

Use this directory for reviewed Gateway domain documentation. The Gateway is
a stable entry and adaptation boundary for clients, tools, and services; it
does not own product data, identity policy, or service behavior.

Gateway's first Cloudflare Worker application provides public liveness through
`GET /health` and a public stateless MCP endpoint at `/mcp` with only the
`gateway_info` diagnostic. These are operational probes, not Gateway
Capabilities. The milestone makes no downstream service calls and has no
Platform auth middleware, service bindings, database, secret, or selected
license. `mcp-use` is composed rather than forked or vendored; the Executor SDK
may be composed later.

Its vocabulary is recorded in the [Gateway glossary](../../CONTEXT.md), its
accepted capability boundary in [ADR 0001](../adr/0001-curated-gateway-capabilities.md),
and its approved foundation in the [planning record](../plans/2026-09-19-gateway-foundation.md)
and [specification](../specs/gateway-foundation.md). These documents record
approved scope and the current public boundary. They do not claim a production
deployment or live hostname evidence.

Record future Gateway terms and decisions in the appropriate service document
and keep them consistent with the monorepo's root architecture guidance.
