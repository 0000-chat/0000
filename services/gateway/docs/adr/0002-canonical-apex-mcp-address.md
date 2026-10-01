---
repo: 0000-chat/0000
status: accepted
---

# Serve Gateway MCP at the canonical apex address

`https://0000.chat/mcp` is the intended canonical public Gateway MCP address. The Gateway Worker can be built and deployed first at `https://gateway.0000.chat/mcp`. When the apex route is added, the same Worker serves MCP requests directly at both addresses, without an HTTP redirect. Both addresses then expose the same MCP behavior as Gateway evolves; documentation and future authentication or discovery metadata identify the apex address as canonical.

Cloudflare routes the apex `/mcp` path and any MCP paths beneath it to the Gateway Worker. A separate landing page application owns all other `0000.chat` paths. The existing `gateway.0000.chat` Worker custom domain remains available. This preserves a single MCP implementation while allowing the landing page to be deployed independently; redirects were rejected because MCP clients send requests such as POST to the endpoint.

Profile-specific MCP paths such as `/mcp/profile/{id}` remain compatible with
this host and path shape wherever they are configured. The profile path does
not change which host is canonical or turn the standalone host into a
redirect.

The apex MCP route may be added after Gateway is running at its subdomain. It does not need to be available while the current apex application is removed or before the landing page launches. Adding the route requires a proxied apex DNS record. Gateway releases before that addition should verify MCP initialization, tool listing, and a diagnostic call at the subdomain; once the apex route is added, verification should exercise both addresses and check that non-MCP apex paths remain outside Gateway. This decision records the target design; it does not claim the route has been configured or deployed.
