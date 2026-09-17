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
`package.json` is the private `@0000/gateway` workspace wrapper. Original
pnpm-based quality tooling and its lockfile remain isolated under `tooling/`.
The service is still scaffold-only and has no application code.

From the monorepo root, run `bun run check`, `bun run check:turbo`, and
`bun run check:turbo:dry`. For Gateway checks, run
`pnpm --dir services/gateway/tooling install --frozen-lockfile` followed by
`pnpm --dir services/gateway run check:application`.
