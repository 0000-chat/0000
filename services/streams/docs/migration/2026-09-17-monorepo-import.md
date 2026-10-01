---
repo: 0000-chat/0000
status: archived
---

# 0000-streams monorepo import

Archived import provenance for the `streams` service. The independent service
history was imported into `services/streams` in the public monorepo. This
record describes repository migration, not production deployment.

Local checkout inventories, backup locations, session records, and operator
coordination details are retained privately. Public contributors need only this
repository and the service's documented tools and checks.

## Source provenance

Imported source commit: `36356baf768fc11f2223fa8a7052fb7cf91c8353`. The original source and destination
histories remain available through the monorepo import ancestry.

## Validation

- Root `bun run check` passed across 11 workspace manifests. `bun run check:turbo:dry` passed and includes `@0000/streams` (with a remote-cache warning).
- Streams `bun run check:application` passed with Oxlint 1.82.0 and Biome 2.5.13, checking five files.
- Full `bun run check:turbo` reached 10/11 and failed only at the existing `@0000/msg` workspace because `oxlint` was unavailable on PATH. The root lockfile declares Oxlint, which a frozen CI install should provide.
