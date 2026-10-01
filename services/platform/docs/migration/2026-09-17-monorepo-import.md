---
repo: 0000-chat/0000
status: archived
---

# 0000-platform monorepo import record

Archived import provenance for the `platform` service. The independent service
history was imported into `services/platform` in the public monorepo. This
record describes repository migration, not production deployment.

Local checkout inventories, backup locations, session records, and operator
coordination details are retained privately. Public contributors need only this
repository and the service's documented tools and checks.

## Source provenance

Imported source commit: `be2b0cd6962943378b7b9769ac172abb6a69aaf6`. The original source and destination
histories remain available through the monorepo import ancestry.

## Validation and cutover

- `bun install --frozen-lockfile` passed in the isolated main integration
  worktree.
- Root `bun run check` passed with 11 workspace manifests.
- `services/platform` `bun run check:application` passed.
- `git diff --check`, the staged diff check, and the migration mapping JSON
  parse passed.
- The full root `bun run check:turbo` failed in the existing `@0000/msg`
  package: the restart and expiry-alarm Miniflare tests both timed out after
  15 seconds, and Miniflare reported that the Workers runtime failed to start.
  176 tests passed, 2 failed, and 1 errored. Running
  `src/worker.miniflare.test.ts` alone reproduced the restart timeout; its
  alarm test passed (8 pass, 1 fail). No `services/msg` files were changed.
- The service import merge commit is
  17a154a809fe9979e9fc84d7ea74b82c325f2667. It has the destination base and
  the reconciled source history as its two parents.
- The final main integration commit at first push was
  2dad3c4d14a900bd855803295df0240d43eb21d9. It includes the latest origin
  main and the local msg, cloud, brain, and platform imports. The non-forced
  push to `origin/main` succeeded, and the clean local `main` worktree and
  `origin/main` both resolved to that SHA at verification.
- GitHub Actions run
  [35191748803](https://github.com/0000-chat/0000/actions/runs/35191748803)
  completed with failure at `Run bun run check:turbo`. The previous main run
  [35191274606](https://github.com/0000-chat/0000/actions/runs/35191274606),
  for pre-platform commit b43ac3cb71681e4ee6388ecd27fa2481a1f11494, failed at
  the same step. This confirms the root check failure predates the platform
  import; the platform-specific check passes.
