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

The full source-path inventory found two tasks across active and archived
state. The idle archived task was forked with the installed `codex fork`
command into `/home/ubuntu/0000-full/0000/services/gateway`. Its title, five
turns, turn contents, destination working directory, and destination project
path were verified. The original title and conversation history are unchanged,
and its archived state was restored. The CLI flow temporarily unarchived the
original and updated its metadata timestamp.

The copy can be read by ID and has the destination working directory, but the
Codex Desktop active and archived task listings did not enumerate it after a
metadata refresh. Desktop list visibility remains unverified. The task ID map
is retained in the private backup, not this public repository.

The other task was this active migration task. Its copy is deferred until it
becomes idle so its history is complete. It is the only pending task copy. The
private task map records its original ID and prevents duplicate forks when the
migration resumes.

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

## Preservation backup

The private verified backup is at
`/home/ubuntu/0000-full/migration-backups/gateway-20260917T052113Z/`. It
contains source and destination Git bundles, working-tree archives, registered
worktree state, Codex metadata/history snapshots, Codex session manifests,
GitHub issue indexes, the existing service scaffold, and SHA-256 manifests.
The original checkout and backup are retained.
