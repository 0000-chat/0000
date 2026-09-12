# Communicator migration handoff

Date: 2026-09-12 (UTC)

Paused task handoff: `codex://threads/01a03e08-02aa-75e3-af87-94dee9e66438`.

This branch preserves the destination repository history while importing the
useful application history from `/home/ubuntu/communicator`. The source
checkout was not changed. The destination branch is
`codex/migration-communicator`.

## Result

- Destination scaffold base: `052efc6a19167da1619b822bf3e07fbbaa1ebb27`.
- Source `main`: `0541524cf6732463ccb2af17da9a6b734dc6d90e`.
- Imported integration branch: `codex/matrix-live-ingestion` at
  `46703ac2a34068eb987e9da7508fe9ad3aac6213`; it is 28 commits ahead of and
  has no commits behind source `main`.
- `codex/matrix-health` points at the same `46703ac` commit. Its dirty Task 6
  work is carried separately below.
- Destination merge commits are `413dcd4` (source `main` plus destination
  history) and `613cdc8` (the integration line). The later handoff commit adds
  this report, the metadata/check updates, and the preserved Task 6 files.
- The source Matrix service-loop plan is now local at
  `docs/superpowers/plans/2026-09-11-communicator-matrix-service-loop.md`.

The only merge conflicts were the destination `.gitignore` and `README.md`.
The resolved files retain the `0000-communicator` identity and coordination
language while adding the imported application setup, runbooks, and runtime
security guidance. The metadata and local check no longer describe the repo as
scaffold-only.

## Ref preservation

The source bundle was created and verified at:

`/home/ubuntu/0000-full/migration-backups/communicator-20260912T081132Z/source-all-refs.bundle`

The bundle is 1,913,020 bytes, contains 120 heads, and records a complete
history. Its SHA-256 is:

`ace1f97d59f0432ac1ef98a8a095b0347aabde484956f925018797f9bd273439`

The destination contains 120 matching preservation refs under
`refs/migration/source/`: 70 source repository refs, 49 worktree heads, and a
source `HEAD` preservation ref. The source branch heads are listed here with
their exact object IDs:

```text
codex/cloudflare-data-plane 6baaf2e44c313ce4e1c743a8ef899612d51a6a62
codex/conversation-shell-ui-polish bc48398115d7f32786be9c2ae18399ff65c4a87d
codex/conversations-channel-shell-design 1ffbce2e2350d42b21eb84193d466f075a88a659
codex/implement-control-directory-auth 16b78103693321ca5d4de8cedcecba9ebb75bc06
codex/linkedin-bridge 9ded5379fc909c7c9d7e06751e1fab252967c8b3
codex/live-read-api dcca82f89b5cbb54a56c3d7fcaaa2594bbeabe13
codex/matrix-backfill-delivery c3fae275401aa911715a3799813bae449a8ba49a
codex/matrix-backfill-ledger 66b7631851d7009cd7112cb4933a1667ee0713f5
codex/matrix-backpressure-corrective 3e9dedc280433aa24fd6e6dca9804c6ea53c3245
codex/matrix-gateway 7f3fc58db20a086bde16cfae9f8cfe8dababdbeb
codex/matrix-health 46703ac2a34068eb987e9da7508fe9ad3aac6213
codex/matrix-ledger-contract b3c32072be9988cbb06e0d1abaab6108c6cd95cb
codex/matrix-live-delivery d22a2b340b68604e824e70b4a437a1d0ea89e720
codex/matrix-live-ingestion 46703ac2a34068eb987e9da7508fe9ad3aac6213
codex/matrix-live-ledger 0f21dc351f6ebfc2dbef1ad8b4d6bf520654121c
codex/matrix-live-recovery d7b6c75f878139c0b36ea4e0fb6728c6c588fb3e
codex/matrix-mcp 7c902fb1a73c78bc299f8c4641c480bbf510e840
codex/matrix-mcp-design d2115f987e2b0c30c952ad4466c0b0c803ba3197
codex/matrix-orchestration-corrective 2dd9ecafbb3684c6eb918d3856ad28aa25b8d349
codex/matrix-orchestration-wave b157e0008d66f5440a3d205ec5e9e890d7c8a51b
codex/matrix-queue-ingestion a649650392ab3420540ae825bdc1966fa030e37e
codex/matrix-service-contracts 10c6f477ed214e7e68a3d431f16bea5f61eb5cf1
codex/matrix-shutdown-corrective 99186618c979a140740fbd703f2f70238baee213
codex/matrix-store-completion-plan 52dcc743ca8534176f6189cc9dea7061c4b70a8a
codex/matrix-store-review-fixes 7846faf432cc37a41e81974a56dfa66f4dc7cda0
codex/matrix-task10-service 0466c79bf0596b05b5a6885097a2d22c2b90e436
codex/matrix-wave1-events 8ce3184169ae2d3c7ce90f4c32dcae1f3bfa9642
codex/matrix-wave1-fix-backfill-contract e0308f87cb2fdfd7653043db912e8a6c9e6e856b
codex/matrix-wave1-fix-ingestion ec25779f0402f18f4a75b8e75e2025ca8667044d
codex/matrix-wave1-security-fix 09ccbe47af02249f9965acedc00ad80cb53f263c
codex/messenger-bridge fdbd50897bb8ad1e53983839fcf963a74fbae8ee
codex/plan-cloudflare-control-directory 0331a12cb964f32da26e407f051971a0b4f560f8
codex/r2-archive-replay bfe34c0e608924fd4f52cc3dfe66fc70e340345b
codex/realtime-fix-principal-sequence 04dc64bdc4bd543475186a3d590aadaf8d950999
codex/realtime-task2-sequences 218829617281daf0333c91f685915d1fde75136f
codex/realtime-task3-tickets c788ccf2ae321a67a56f4d47b1b774ab1a73a52f
codex/realtime-task4-api 6911c9e78aa86071793e295f158d2ff371e91cf8
codex/realtime-task5-sockets e28c2fcb016d76304877ee65d49809fda37fb918
codex/realtime-task6-broadcast 79a18c5bfa7e1e2e89d178cba8e0ccb3d4f76d88
codex/realtime-task7-client d3a98b5b56131a456c653a411953b0ed1fe6743a
codex/realtime-task8-ui 9342c114269a57154df3a3eae123b1409c07e3b8
codex/realtime-task9-docs 654d454c91f7d22c71747f2f78df3f25d8c4906d
codex/realtime-wave2-gate-fix d0aa1755ca01ad9c8b682a8a9678ec7889465c48
codex/realtime-websocket e7e5a88faff5f3c1751690cd17cde652cf5b13af
codex/telegram-bridge 7eea8fa009855bf5c4d7546b1f2cde998c381e01
codex/tenant-projection-do d3536041b3621efd2ea8bc421293c6526a04a616
feat/communicator-ui-foundation ea88d49ab5106a53cc580f07f68ba172b7819370
feat/matrix-core 4c38fe42dfc7135986ddf2ff7859a1fc7039492b
main 0541524cf6732463ccb2af17da9a6b734dc6d90e
plan/matrix-core da2136042e6d5ed8c56e7a03a4c3b043cb77b07a
```

Other divergent work remains reachable through the preservation refs and bundle
and through the untouched source checkout. It was not indiscriminately merged.

## Dirty and local work preservation

The inventory covered all 50 source worktrees. The source root had 14
untracked `.test-tmp` files (84K). They are preserved at:

`/home/ubuntu/0000-full/migration-backups/communicator-20260912T081132Z/source-test-tmp.tar.gz`

The `matrix-health` worktree had one tracked edit and two untracked files:

- `services/matrix-gateway/src/lib.rs` adding `pub mod health;`;
- `services/matrix-gateway/src/health.rs`;
- `services/matrix-gateway/tests/healthcheck.rs`.

The tracked patch is preserved at
`matrix-health-working-tree.patch` (SHA-256
`b52293ed20f182aad63f09f9624c60c7dfd1e0cf59da7ad8cbded6aa341c69a0`), and the
two untracked files are preserved at `matrix-health-untracked.tar.gz` (SHA-256
`599567bfbdaea6af8f54672cffba0013cc64ae83771524bad57b9532d5d4d88f`). The
same files are present in this migration branch. Their behavior is unchanged:
the observer currently opens the database read-only and emits the healthy
shape; the empty-store test intentionally remains RED because it expects
`blocked`/`missing`. Do not fix that behavior as part of migration.

The `matrix-wave1-security-fix` worktree had 15,829 untracked files under its
32G `target/` directory. These are Rust build outputs and were excluded as
regenerable cache state. The other 47 worktrees had no tracked or untracked
working-tree changes. Ignored dependency and runtime state is covered in the
exclusions below.

Task 7 daemon/admin work and Task 8 packaging work had not started. The
receive-only Matrix service-loop plan remains the active foundation; an
outbound command path is still a product decision.

The proposed scope note is preserved at
`docs/migration/wayfinder-draft.md`. Pilot versus full-product scope remains
open, so its candidate tickets are not canonical issues.

## Exclusions and secret handling

The source checkout was about 42G, including 42G of `.worktrees` and 623M of
root `node_modules`. Those regenerable trees were excluded from backup. The
source refs and complete history are preserved by the bundle, and all
meaningful dirty worktree state is accounted for above; the 32G build tree is
explicitly recorded as a regenerable exclusion.

Also excluded from backup were per-worktree `node_modules`, `target`,
`dist`, test reports, coverage, Wrangler generated state, and local cache/tmp
directories. The source inventory identified Wrangler local configuration and
SQLite state under `apps/control-plane/.wrangler/`; path names and aggregate
sizes were recorded without printing values. The source's tracked
`deploy/images.lock.env` contains image-pin keys, not credentials; actual
environment files, keys, databases, and runtime state were not copied into
the tracked destination.

The backup directory is outside the repository at
`/home/ubuntu/0000-full/migration-backups/communicator-20260912T081132Z/`.
Its bundle, patch, and two archives have these SHA-256 values:

```text
source-all-refs.bundle       ace1f97d59f0432ac1ef98a8a095b0347aabde484956f925018797f9bd273439
source-test-tmp.tar.gz       e476fd5354e5167ad55ac75fe70067817ff69bdb8cd2249769dc5a1be84f490f
matrix-health-working-tree.patch
                             b52293ed20f182aad63f09f9624c60c7dfd1e0cf59da7ad8cbded6aa341c69a0
matrix-health-untracked.tar.gz
                             599567bfbdaea6af8f54672cffba0013cc64ae83771524bad57b9532d5d4d88f
```

## Validation and pending work

Completed migration checks include bundle verification, exact source-to-
destination preservation-ref comparison with zero mismatches across 120 refs,
SHA-256 comparison of copied Task 6 files, merge-conflict resolution,
`./scripts/check` passing, and `git diff --check` passing. `git fsck --full
--no-progress` exited 0 and reported one dangling tree
`97f2deba53704279b085453cafc3a7bbb8754141`, with no corruption errors.

The paused handoff reports a focused health result of one passing test and one
intentional missing-session RED. No fresh health test was run during migration;
the failure remains pending the separately authorized Task 6 fix.
Full Rust, Worker, Python, Docker, or deployment checks are not a migration
requirement and were not run here. No push, deployment, issue creation, or
external write was performed.
