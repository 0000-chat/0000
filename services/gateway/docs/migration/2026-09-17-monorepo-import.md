---
repo: 0000-chat/0000
status: archived
---

# Gateway monorepo import

Archived import provenance for the `gateway` service. The independent service
history was imported into `services/gateway` in the public monorepo. This
record describes repository migration, not production deployment.

Local checkout inventories, backup locations, session records, and operator
coordination details are retained privately. Public contributors need only this
repository and the service's documented tools and checks.

## Source provenance

Imported source commit: `7df07b320b6493f7ced26c466384911b9446f70a`. The original source and destination
histories remain available through the monorepo import ancestry.

## Validation and publication

- Source `./scripts/check`: passed on the selected source tip.
- Monorepo `bun install --frozen-lockfile`, `bun run check` (9 workspace
  manifests), `bun run check:turbo` (9/9 tasks), and `bun run check:turbo:dry`:
  passed; the root `bun.lock` is unchanged.
- Gateway frozen pnpm install and `pnpm run check:application` (Oxlint and
  Biome): passed.
- The destination `service:gateway` label was created. The source had no
  issues, pull requests, or releases to transfer.
- The import commit has the destination base and selected source tip as its two
  parents. All seven source branch refs are retained under
  `refs/migration/gateway/`; source branch tips are ancestors of the selected
  source tip. Git object verification passed.
- The service prefix and wrapper are present, all 84 skill links resolve to
  their original targets, and no dependencies, secrets, databases, or
  generated files are tracked.
- The import commit `e798f3ba7b044d4e090bdd9a7128afcccb59c73c` was pushed to
  monorepo `main` as a fast-forward. GitHub Actions [Check workspace run
  35188777356](https://github.com/0000-chat/0000/actions/runs/35188777356)
  passed.
