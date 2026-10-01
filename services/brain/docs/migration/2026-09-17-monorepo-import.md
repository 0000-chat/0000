---
repo: 0000-chat/0000
status: archived
---

# Brain monorepo import

Archived import provenance for the `brain` service. The independent service
history was imported into `services/brain` in the public monorepo. This
record describes repository migration, not production deployment.

Local checkout inventories, backup locations, session records, and operator
coordination details are retained privately. Public contributors need only this
repository and the service's documented tools and checks.

## Source provenance

Imported source commit: `77189264a622c9ff9ce91aef67a11d3c3fe065b1`. The original source and destination
histories remain available through the monorepo import ancestry.

## Validation

- `bun install --frozen-lockfile` completed without changing the lockfile.
- `bun run check` passed for all nine workspace manifests.
- `bun run check:turbo` passed all nine workspace check tasks, including Brain's
  wrapper task.
- `bun run check:turbo:dry` reported the nine-package task graph.
- `bun run check:application` and `./scripts/check` passed with Oxlint 1.82.0
  and Biome 2.5.13.
- `git diff --cached --check` passed.

The relocated npm tool commands disable npm workspace discovery because npm
otherwise selects the outer Bun workspace and cannot resolve the service's
pinned executable. The monorepo's remote Turbo cache was unreachable during
the local check; Turbo used its shared local cache. Remote CI is verified after
push and recorded in the private preservation report.
