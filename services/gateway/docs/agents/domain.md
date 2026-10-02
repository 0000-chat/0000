---
repo: 0000-chat/0000
status: current
---

# Domain docs

Use this directory for reviewed Gateway domain documentation. The Gateway is
a stable entry and adaptation boundary for clients, tools, and services; it
does not own product data, identity policy, or service behavior.

Gateway's first Cloudflare Worker application provides public liveness through
`GET /health` and a public stateless MCP endpoint at `/mcp` with the
`gateway_info` diagnostic. A configured Worker also provides an authenticated,
profile-bound MCP boundary with `use`, `tools.search`, explicit D1 grants,
and service-owned declarations. The checked-in Wrangler config leaves Platform,
D1, and downstream bindings unset, so protected requests fail closed in the
default application. `mcp-use` is composed rather than forked or vendored;
the Executor SDK may be composed later.

Its vocabulary is recorded in the [Gateway glossary](../../CONTEXT.md), its
superseded historical capability decision in
[ADR 0001](../adr/0001-curated-gateway-capabilities.md), its canonical MCP
address and apex path ownership in
[ADR 0002](../adr/0002-canonical-apex-mcp-address.md), and its approved
foundation in the [planning record](../plans/2026-09-19-gateway-foundation.md)
and [specification](../specs/gateway-foundation.md). These documents record
approved scope and the current public boundary. They do not claim a production
deployment or live hostname evidence.

Record future Gateway terms and decisions in the appropriate service document
and keep them consistent with the monorepo's root architecture guidance.
