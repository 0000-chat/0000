# Brain monorepo import

Date: 2026-09-17 (UTC)

The Brain scaffold was imported from
`/home/ubuntu/0000-full/repos/0000-brain` into `services/brain` in the `0000`
monorepo.

## Import basis

- Destination base: `51e6407e076909eee65f14e1227b9d28a304c533` (`0000` `main`)
- Imported source tip: `77189264a622c9ff9ce91aef67a11d3c3fe065b1` (source `main`)
- The import commit retains the destination base and source tip as its two
  parents. Reconciled source files are staged below `services/brain`; the
  unmodified source tip remains available as its second parent and under the
  namespaced refs.
- Source refs from both the local bundle and remote were retained under
  `refs/migration/brain/`. This includes the source feature branch and internal
  turn-diff refs. The complete source and destination ref sets are also
  preserved in verified Git bundles.
- The source `main` checkout was two commits behind the remote default branch.
  The selected remote tip is the current source `main`; the older local branch
  tips remain available in the namespaced refs and backup.
- Destination `main` advanced by six Gateway commits after the initial import
  base was recorded. Those commits were fetched and are retained when the
  import branch is merged into current `main`.

## Relocation and product reconciliation

The existing `services/brain` scaffold contained only its monorepo package
wrapper and `.gitkeep`. The wrapper remains `@0000/brain` and now runs the
service-scoped check alongside the existing root Bun/Turbo checks. Brain's
standalone metadata and README now describe its intended role as an
LLM-supported wiki and knowledge service, its dependency on Platform for
common identity, and Cloudflare as its public runtime class. The local check
validates the canonical product name `0000-brain` while operating from the
monorepo root.

The root README records the service import. The source quality workflow remains
under the service tree as provenance; the monorepo root workflow now runs
`bun run check:application` from the Brain service directory after the shared
workspace checks.

## Preserved local state

The source checkout and its linked feature worktree were retained unchanged.
The destination's pre-existing untracked `services/msg/.gitkeep` was not
included in this import and remains in the original destination checkout.
The source's 84 local `.agents/skills` links were recreated under
`services/brain/.agents/skills` with relative targets adjusted for the new
directory depth; these local ignored links are not committed.

The private preservation backup is
`/home/ubuntu/0000-full/migration-backups/brain-20260917T052303Z/`. It contains
source and destination Git bundles, filesystem snapshots, ref and worktree
inventories, source Git integrity output, Codex rollout copies, a consistent
Codex SQLite backup, the task ID map, and the GitHub inventory. Its final
checksum manifest and verification results are recorded alongside the backup.

## GitHub state

The public source repository had no issues, pull requests, milestones, or
releases. Its nine labels were inventoried. There were no issue records to
transfer; the full source API inventory is retained in the backup.

## Codex tasks

Five Codex tasks were associated with the source by exact working-directory
and Git-origin matching, reconciled against all seven archived Desktop listing
pages and the complete scoped state database query. Four idle tasks were
forked into the destination project without submitting prompts. Each copy's
complete paginated history was compared with its source: the turn and item
records matched. The previously archived task's canonical copy is archived.
One retry produced a redundant fork of that archived task; it is archived and
recorded separately in the private task ID map.

The migration task itself was still running during this import, so its copy is
deferred until it becomes idle. The original-to-copy mapping and rerun rule are
in `codex/task-id-map.json` under the private backup. One legacy task was
untitled in Desktop; `codex fork` derived a display title from its legacy
record, while its full history was copied and compared successfully.

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
