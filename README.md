# 0000-database

`0000-database` aims to give 0000 products and services a dependable home for
their durable data.

It should make data easy to store, find, change, and retain without requiring
each service to solve persistence on its own. It should give consumers clear
data ownership and predictable behavior as their needs grow.

`0000-streams` depends on this service. Other 0000 services can use it when
they need durable state, but that use does not make them part of the database.

This service is responsible for:

- durable storage and retrieval;
- clear ownership and lifecycle of stored data;
- consistent access to data across the 0000 family;
- protecting data integrity as products change.

It is not responsible for user experiences, communication channels, reasoning,
or coordinating the hosted platform.

Install the pinned development tooling with `pnpm install --frozen-lockfile`.
`pnpm lint` runs Oxlint correctness checks and `pnpm format:check` verifies
Biome formatting without changing files. Use `pnpm lint:fix` or `pnpm format`
when an intentional local fix is needed. `./scripts/check` runs the
nonmutating checks used by CI.
