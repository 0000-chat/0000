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
channels, or define the hosted user experience. No hard dependency on another
0000 service is confirmed.

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

## Production deployment

A push to `main` runs the Gateway deployment workflow after the full workspace
and application checks pass. Configure the repository secret
`CLOUDFLARE_API_TOKEN` with permission to deploy Workers in account
`d8f2eee5aab20d72439aabdfbb221bb7`; the workflow supplies the account ID,
verifies that `main` still points at the commit being built, and smoke-tests
`https://gateway.0000.chat/health` after deployment.
