# 0000-database

This service lives at `services/database` in the public `0000` monorepo. The
outer Bun/Turbo workspace owns wrapper validation; this directory retains the
service's pnpm quality tooling. See
[`docs/migration/2026-09-16-monorepo-import.md`](docs/migration/2026-09-16-monorepo-import.md)
for the preserved standalone history and migration record.

`0000-database` aims to give 0000 products and services a dependable home for
their durable data. It requires `0000-platform` for common identity and
authentication; standalone use does not require a hosted 0000 account.

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
when an intentional local fix is needed. `pnpm run check:application` runs the
service checks; run `bun run check` from the monorepo root for its wrapper.
