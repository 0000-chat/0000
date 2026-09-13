# 0000-gateway

`0000-gateway` aims to give clients, tools, and services one clear way to reach
the capabilities they need.

It should hide differences between underlying services, translate requests
when their shapes differ, and route work to the right capability. Consumers
should not need to understand the internal layout of the 0000 family.

This service is responsible for:

- presenting a stable boundary to consumers;
- directing requests to the right capability;
- adapting between different service expectations;
- keeping service-specific details out of clients.

It is not responsible for owning product data, making product decisions,
providing communication channels, or defining the hosted user experience.

No hard dependency on another 0000 service is confirmed.

Install the pinned development tooling with `pnpm install --frozen-lockfile`.
`pnpm lint` runs Oxlint correctness checks and `pnpm format:check` verifies
Biome formatting without changing files. Use `pnpm lint:fix` or `pnpm format`
when an intentional local fix is needed. `./scripts/check` runs the
nonmutating checks used by CI.
