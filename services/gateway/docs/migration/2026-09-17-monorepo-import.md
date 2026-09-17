# Gateway monorepo import

Date: 2026-09-17 (UTC)

The `0000-gateway` repository was imported under `services/gateway` in the
public `0000` monorepo. The independent source checkout remains at
`/home/ubuntu/0000-full/repos/0000-gateway`.

## Import basis

- Source repository: `0000-chat/0000-gateway`.
- Selected source branch and tip: `main`, `7df07b320b6493f7ced26c466384911b9446f70a`.
- Destination base: `0000` `main`, `51e6407e076909eee65f14e1227b9d28a304c533`.
- The import commit has both the destination base and selected source tip as
  parents. The complete source bundle and all source refs are retained under
  `refs/migration/gateway/` in the monorepo Git database.
- The source checkout's local `main` was one commit behind its remote. All
  source branch tips were ancestors of the selected remote `main` tip; no
  divergent feature tip was applied separately.

## Relocation adaptations

The service wrapper is the private `@0000/gateway` workspace. The source
pnpm manifest and lockfile remain isolated in `tooling/`, so the monorepo's
Bun lockfile stays independent. The source product metadata continues to use
`0000-gateway` and marks the service scaffold-only. The original scaffold
check now validates its files below the service prefix, and the monorepo root
workflow runs the Gateway application/tooling check after the Bun and Turbo
checks.

The original nested quality workflow is retained as source history. The active
monorepo workflow is `.github/workflows/check.yml` at the repository root.

## Preserved local state

The source checkout was not modified. All four registered source worktrees
were clean; the `oxlint-biome-services` worktree had an ignored 156 MB
`node_modules` tree. The source's 84 ignored skill links were recreated below
`services/gateway/.agents/skills` with corrected relative paths and verified
against their original targets. The links remain ignored local state.

The existing Gateway destination scaffold was archived before overlay. The
pre-existing untracked `services/msg/.gitkeep` and ignored destination state
were included in the destination backup. Another task had an in-progress
Streams merge in the shared destination worktree; that worktree was left
untouched and separately snapshotted. The Gateway import was built in an
isolated worktree.

## GitHub migration

The source repository had no issues, pull requests, or releases, so there were
no issue transfers or PR URL remaps. The source repository, destination
repository, labels, and issue/PR indexes were captured in the private backup.
Gateway issues now belong in `0000-chat/0000` with the `service:gateway` label.

## Codex project continuity

The full source-path inventory found two Codex tasks across active and archived
state. The idle archived task was forked with the installed `codex fork`
command into `/home/ubuntu/0000-full/0000/services/gateway`. Its original title,
five turns, turn contents, destination working directory, and destination
Codex project path were verified. The original task title and conversation history are unchanged and its archived
state was restored after the CLI fork; the fork flow did update its metadata
timestamp when it temporarily unarchived it. The copy can be read by ID, has
the registered destination project
path, and retains the original title and five turns. However, the Codex Desktop
active and archived task listings do not enumerate this CLI-created copy, even
after metadata refresh, so Desktop list visibility remains unverified. The task
ID mapping is kept in the private backup, not in this public repository.

The second task was this active migration task. Its copy is deferred until the
task is idle so its history is complete. It remains the only pending Codex
copy; its ID and the verified fork mapping are in the private task map.

## Validation and publication

- Source `./scripts/check`: passed on the selected source tip.
- Monorepo `bun install --frozen-lockfile`, `bun run check` (9 workspace
  manifests), `bun run check:turbo` (9/9 tasks), and `bun run check:turbo:dry`:
  passed; the root `bun.lock` is unchanged.
- Gateway frozen pnpm install and `pnpm run check:application` (Oxlint and
  Biome): passed.
- The monorepo `service:gateway` label was created with the service label
  convention; the source had no issues, PRs, or releases to transfer.
- The import commit has the destination base and selected source tip as its two
  parents. All seven source branch refs are ancestors of the selected tip and
  are retained under `refs/migration/gateway/`. Git object verification passed.
- The service prefix and wrapper are present, all 84 skill links resolve to
  their original targets, and the tracked import contains no dependency,
  secret, database, or generated files. The root lockfile remains unchanged.
- Push to monorepo `main` and CI verification: pending.

## Preservation backup

The private verified backup is at
`/home/ubuntu/0000-full/migration-backups/gateway-20260917T052113Z/`. It
contains source and destination Git bundles, working-tree archives, registered
worktree state, Codex metadata/history snapshots, Codex session manifests,
GitHub issue indexes, the existing service scaffold, and SHA-256 manifests.
The original checkout and backup are retained.
