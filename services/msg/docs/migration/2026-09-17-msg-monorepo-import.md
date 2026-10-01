---
repo: 0000-chat/0000
status: archived
---

# msg monorepo import report

Archived import provenance for the `msg` service. The independent service
history was imported into `services/msg` in the public monorepo. This
record describes repository migration, not production deployment.

Local checkout inventories, backup locations, session records, and operator
coordination details are retained privately. Public contributors need only this
repository and the service's documented tools and checks.

## Source provenance

Imported source commit: `5ece6f0cc0a045802d78de4be6353d4c905d6610`. The original source and destination
histories remain available through the monorepo import ancestry.

## Result

The msg Worker, npm CLI, Wrangler helper, deployment allocation check, and
msg-only history documents are now under services/msg. The old source
repository was not changed. No production deployment or cutover was run.

This report records a local import into the 0000 monorepo worktree. It does
not claim that the service has been published, deployed, or cut over.

## Source and status

The source status showed ignored build and dependency data in the two msg
packages: .turbo directories, CLI dist output, and CLI node_modules. None of
these paths were imported.

## Validation

- Passed `bun run check` at the monorepo root; it found 10 workspace manifests.
- Passed both msg tooling test files: 9 tests.
- Passed 161 Worker and service-script tests across 18 files that do not need
  the external Miniflare or `ws` packages.
- Passed all 50 CLI source tests.
- The CLI pack test passed its package-metadata assertion. Its build and packed
  binary checks could not complete because `ws` was not installed.
- The offline Bun install could not resolve registry manifests. The root
  `bun.lock` update, full service checks, and Turbo checks remain pending for a
  network-enabled install by the destination owner.
- No deployment or source-repository mutation was performed.
