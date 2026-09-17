# 0000-platform monorepo import record

Date: 2026-09-17 UTC

## Repositories and source selection

- Source checkout: /home/ubuntu/0000-full/repos/0000-platform
- Source remote: https://github.com/0000-chat/0000-platform.git (public)
- Destination monorepo: /home/ubuntu/0000-full/0000
- Destination service path: services/platform
- Destination remote: https://github.com/0000-chat/0000.git (public)
- Source service name: platform; canonical product metadata remains 0000-platform.
- Import worktree: /home/ubuntu/0000-full/worktrees/platform-import/0000
- Import branch: codex/import-platform
- Destination base fetched from origin/main: 51e6407e076909eee65f14e1227b9d28a304c533

The selected source checkout branch was codex/setup-matt-pocock-skills
(fcdcb06f18f5a3f8f67a569d424b3add659243e9). It diverged from source
origin/main (e61e1a3024f202e9495341e5396da0c60b4663ae) at
9ef7b633e0d0a5e1d6730630228b3cd426b03323. Both tips were preserved and
explicitly reconciled without changing the source checkout. The resulting
source reconciliation commit is be2b0cd6962943378b7b9769ac172abb6a69aaf6;
its parents are source origin/main and the selected checkout tip. The
merged tree had no conflicts. All six source refs, including both source
branches, origin/main, and two Codex turn-diff refs, are retained under
refs/migration/platform/.

## Preserved state and GitHub records

The source checkout was clean apart from 84 ignored managed-skill symlinks.
It had no staged or unstaged patch, untracked file, stash, or missing
worktree. Both registered source worktrees are retained; status and complete
checkout snapshots are in the backup. The source scaffold check failed before
migration because its strict tracked-file allowlist did not include files
already present on the checked-out branch. The destination service check now
validates the canonical source file set and monorepo prefix.

The monorepo's shared checkout changed during this run: a separate
codex/import-streams task has an in-progress merge and untracked
services/streams files. That checkout and its work were left untouched. Its
pre-existing untracked services/msg/.gitkeep is preserved in that checkout
and included in the destination backup.

Source GitHub inventory (read-only public API, all pages):

- Issues: 0; comments: 0.
- Pull requests: 0; releases: 0; milestones: 0; labels: 9.

Destination GitHub inventory at capture:

- Existing issues: 48 with 193 comments; pull requests: 0; releases: 0;
  milestones: 0; labels: 21.

There were no source issues or pull requests to transfer. Destination issues
were not changed.

## Local backups

Verified backup root: /home/ubuntu/0000-full/migration-backups/platform-20260917T052336Z.

The source and destination Git bundles verify. The backup includes source and
destination tracked archives, full source checkout state, both source
worktree snapshots, the existing destination platform scaffold, the
untracked services/msg marker, staged and unstaged patches, refs, stashes,
worktree/status manifests, ignored-path inventory, public GitHub issue
snapshots, and Codex database backups. SHA256SUMS is verified after the
final backup inventory is written.

Codex state was discovered through the installed CLI at
/home/ubuntu/.codex/state_5.sqlite. The SQLite online snapshots
state_5.sqlite and state_5-after-forks.sqlite passed PRAGMA integrity_check.
Seven completed source/copy rollout files were also copied to
codex/task-rollouts/ and individually SHA-256 verified against their originals;
the manifest is codex/task-rollouts-manifest.json. A separate SHA-256-verified
snapshot of the active migration task rollout was captured at 2026-09-17
06:54 UTC; its independent fork remains deferred until the task is idle.

The related thread_history_1.sqlite contains thread turns, but its online
backup stopped advancing at 1,638,400,000 of 2,454,638,592 bytes while Codex
was actively writing. The incomplete output was removed; the source database
remains intact and unmodified. No backup integrity claim is made for that
database. Other Codex database files were listed by path and size only; they
were not opened or copied.

The source's 84 managed skill links were retained in the original checkout,
backed up in the ignored-path manifest, and recreated in the clean main
worktree at /home/ubuntu/0000-full/worktrees/0000-main-msg-merge/0000/services/platform/.agents/skills.
All links resolve under /home/ubuntu/0000-full/skills/ecosystem and are
ignored by the imported service's .gitignore.

## Codex task inventory and mapping

The source Codex project is
0de30699-d99b-4e85-96ec-fdacf73a8ecd; the destination Codex project is
5be04433-07cb-419e-a2df-d7a74132f4d0.

The active Desktop listing has a 50-task limit and no cursor. Its source match
was the active migration task 01a0adcb-d5fe-7f10-bed6-add2ca8746cc. The
archived listing was read across all seven pages (317 tasks before copies,
318 after copies). Because the Desktop listings omitted old source-checkout
sessions, the inventory was reconciled against the local state_5.sqlite
threads table by exact source path and source project ID. It contains four
records: the archived parent session 01a09093-0f68-7b00-83d5-4a24527f6165
("Set up engineering skills"), its archived worker 01a09095-ebb7-72c0-9702-95f00bc057f8,
the active migration task, and legacy guardian session
01a0add3-461b-7c51-8dfa-47f7e0da210a.

The installed codex-cli 0.154.0 supports `codex fork <SESSION_ID> --cd
<DESTINATION_DIRECTORY>`. Parent and worker copies are IDs
01a0adf9-2093-7410-93c2-ca3c2a75a699 and 01a0ae01-5e2c-7bd0-aa6c-fc63f39c415e;
all history pages were compared in order, and their 5 and 2 turns match.
Their destination CWDs and archived flags are verified. They can be read by
ID, but Desktop's active 50-item window and all archive pages did not return
them, so visibility under the destination project is not verified.

The guardian source was still completing when the first fork was made. That
incomplete copy (01a0ae02-cb4e-7932-9015-4551d0deef7b) has 49 of the source's
50 turns and is retained archived for audit. After the original's latest turn
completed, a second fork (01a0ae09-aac8-7312-8a4d-18364656d049) was made
without submitting a prompt. All five history pages and 50 turns match in
order, its destination CWD is verified, and Desktop lists it under the
platform destination project ID. The source has no stored title; Codex
assigned the copy the title "Migrate project and Codex tasks".

The current migration task remains active and its copy is deferred as
requested. Once it is idle, run `codex fork
01a0adcb-d5fe-7f10-bed6-add2ca8746cc --cd
/home/ubuntu/0000-full/0000/services/platform` without a prompt, then verify
and record its new task ID. The ID-keyed mapping in
`docs/migration/codex-task-mapping.json` prevents duplicate forks on rerun.
It also records the incomplete guardian attempt and each visibility result.

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
