# msg monorepo import report

## Result

The msg Worker, npm CLI, Wrangler helper, deployment allocation check, and
msg-only history documents are now under services/msg. The old source
repository was not changed. No production deployment or cutover was run.

This report records a local import into the 0000 monorepo worktree. It does
not claim that the service has been published, deployed, or cut over.

## Source and status

- Source: /home/ubuntu/0000-chat, remote 0000-chat/0000-chat
- Source branch: main
- Source commit: 5ece6f0cc0a045802d78de4be6353d4c905d6610
- Source status at inspection: clean and aligned with origin/main
- Source production route: unchanged
- Production cutover: not performed

The source status showed ignored build and dependency data in the two msg
packages: .turbo directories, CLI dist output, and CLI node_modules. None of
these paths were imported.

## Inventory and mapping

| Source | Destination | Files |
| --- | --- | ---: |
| apps/msg | services/msg/worker | 56 |
| packages/msg-cli | services/msg/cli | 14 |
| wrangler.msg.jsonc | services/msg/wrangler.jsonc | 1 |
| scripts/msg-wrangler-config.ts and its test | services/msg/scripts/wrangler-config.ts and its test | 2 |
| scripts/msg-deployment-allocation.ts and its test | services/msg/scripts/deployment-allocation.ts and its test | 2 |
| msg-only specs | services/msg/docs/history/specs | 9 |
| msg-only plans | services/msg/docs/history/plans | 9 |
| msg-only runbooks | services/msg/docs/history/runbooks | 2 |

The imported Worker includes its migrations, checked-in Worker types,
Miniflare fixtures, source tests, operator helper, production synthetic
check, and public assets marker. The CLI import includes its README, MIT
license, package manifest, source, tests, and pack test.

The service keeps services/msg/.gitkeep for the outer workspace check. It also
keeps the Worker public directory marker from the source repository.

## Adaptations

- The Worker now lives in worker. Its config points to worker/src,
  worker/migrations, and worker/public.
- The Wrangler helper now finds wrangler.jsonc from its own location. It
  resolves service paths and the monorepo Wrangler schema path before it
  writes the temporary config.
- The Worker config test now reads the service-local config.
- The Worker test package runs tests from both src and scripts.
- The service wrapper check runs the Worker, Wrangler tooling, and CLI checks.
- The CLI remains the public package @0000chat/msg. Its repository URL now
  points to 0000-chat/0000 and its directory is services/msg/cli. Its issue
  URL uses the service:msg label.
- The destination has no shared Oxlint config. The service now has its own
  config. The service wrapper declares the tools needed by its checks.
- Source tracing found one import outside the msg code: the Worker logger
  imported apps/web/src/lib/observability/worker. That file belongs to shared
  frozen V1 code and was not copied. The msg logger now emits the same
  metadata-only event fields locally. It bounds the outcome string and does
  not log request or participant content.

Other Worker imports resolve inside the Worker, to runtime built-ins, to
Cloudflare's Worker runtime, or to Miniflare for tests. The CLI imports its
local modules and the declared ws package. No 0000 V2 code is required by the
imported service code.

## Exclusions

- The apps/dev msg prototype, its tests, and its assets were not imported.
- Shared V1 applications, observability modules, and generated shared files
  were not imported.
- The root quality workflow and other shared root quality tooling were not
  imported.
- The old msg production deployment workflow and npm publish workflow remain
  in the source repository. Their root-level operational paths would create
  new deployment and publication triggers outside this service-only import.
- The old root CLI release-tag scripts and production workflow tests were not
  imported.
- Secrets, local environment files, node_modules, .turbo caches, CLI dist
  output, and other generated files were not imported.
- General 0000 docs, V1 docs not specific to msg, and unrelated service code
  were not imported.

The 20 copied history documents are msg-specific. The two docs about the old
prototype remain text only and are marked as historical. The prototype code
and assets remain excluded.

## Root integration

The existing services/* Bun workspace pattern already includes services/msg,
so the root workspace pattern and package manifest did not need a change. The
root README now describes the service and includes its checks in the Turbo
check summary. The controller workspace policy was not changed. The root Bun
lock still needs an install-generated update. The offline package install
could not resolve registry manifests; the destination owner will run the
network-enabled install before finalizing the lock.

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
