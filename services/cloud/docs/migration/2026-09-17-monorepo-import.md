# 0000-cloud monorepo import

Status: local import candidate; repository merge and push are still pending.

## Repository inventory

- Source: `0000-chat/0000-cloud`, private, default branch `main`.
- Destination: `0000-chat/0000`, public, default branch `main`.
- Service path: `services/cloud`, inferred by removing the `0000-` repository
  prefix.
- Selected source tip: `db016ecf28ba98473c308156c7223f86f77840c8`
  (`origin/main`, `chore: complete oxlint and biome tooling`). The source
  checkout's local `main` was `803fdc7131afe431677c834557b92eef87c796dc`, two
  commits behind that remote tip.
- Destination base: `51e6407e076909eee65f14e1227b9d28a304c533`.
- Source refs: seven refs captured in the source bundle. All were fetched into
  the destination's local `refs/migration/cloud/` namespace. Push only the
  selected import through `main`; the namespace includes private alternate
  work and stays local.

The selected default-branch history contains the coordination scaffold and
tooling commits. The divergent `codex/mastra-factory` branch contains private
deployment records. Its tip and the dirty worktree change are preserved in the
source checkout, destination migration namespace, and backup, but are excluded
from the public service tree. No high-confidence credential patterns were
found in the 35 reachable source blobs scanned.

The source checkout has three linked worktrees. `hosted-boundaries` and
`oxlint-biome-scaffolds` were clean; `mastra-factory` has an uncommitted change
to `docs/mastra-factory-deployment.md`. The source root was clean apart from
ignored skill links. The backup includes every worktree's status, patches,
untracked/ignored lists, and working-tree archive. No stashes were listed.

The destination already had untracked `services/msg/.gitkeep` and ignored
workspace dependencies. Both were captured in the destination working-tree
backup and left untouched.

## Backups and external state

Verified backup directory:
`/home/ubuntu/0000-full/migration-backups/cloud-20260917T052111Z`.
It contains verified source and destination Git bundles, tracked archives,
working-tree archives, all linked-worktree snapshots, local Git exclude files,
GitHub inventories, and SHA-256 manifests. `sha256sum --check SHA256SUMS`
passed. The original source checkout and its worktrees remain in place.

GitHub inventory found zero source issues, zero pull requests, zero releases,
and nine labels. There was nothing to transfer; the complete indexes and label
snapshot are in the backup.

## Codex task inventory

The archived-task API returned all 317 records across seven pages. One matched
the source checkout path. The active-task API returned its maximum 50 global
records and exposes no cursor; scanning rollout metadata under the configured
Codex sessions root found the current source task and a legacy rollout tied to
that same session. The durable source-to-copy mapping is in
`codex-task-migration.json`.

The archived task has five completed turns and remains archived. Its copy is
pending until the service path exists in the destination checkout. The current
migration task is active and must be copied only after it becomes idle; its
copy is deferred. Original tasks remain intact. Update the mapping with each
copy ID after verification, and skip any source ID that already has a copy ID
on a rerun.

## Validation

- Source and destination bundles verified before import.
- Initial backup checksum verification passed.
- Source `./scripts/check` on the original local `main` reports the three
  existing `docs/agents/*` files as extra; the selected remote branch includes
  those paths in its expected scaffold.
- Destination `bun run check` on the existing checkout reports the pre-existing
  untracked `services/msg/.gitkeep` directory lacks `package.json`. The isolated candidate is
  based on clean remote `main`; checks there do not include that untracked path.
- Service wrapper and application checks, monorepo checks, merge ancestry,
  post-copy task history, final push, and CI verification remain to be recorded.
