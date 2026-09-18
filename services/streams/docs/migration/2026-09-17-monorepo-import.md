# 0000-streams monorepo import

Updated 2026-09-17.

The import moves service `streams` from `0000-chat/0000-streams` into `0000-chat/0000`. The selected source branch is `codex/oxlint-biome-scaffolds`; it and source `origin/main` point to `36356baf768fc11f2223fa8a7052fb7cf91c8353`, while source `main` is `67de6b2a3d883c7ccccc6a2e1cbc766041fad549`. The staged import is replayed on destination `origin/main` at `b43ac3cb71681e4ee6388ecd27fa2481a1f11494`. Source inventory found 0 issues, 0 pull requests, 0 releases, and 9 labels recorded in the backup. Source refs remain under `refs/migration/streams/` and in verified bundles; the destination’s existing `.gitkeep` was kept.

The original source checkout and migration backups are retained. Durable backup root: `/home/ubuntu/0000-full/migration-backups/streams-20260917T052328Z`. The latest destination bundle `/home/ubuntu/0000-full/migration-backups/streams-20260917T052328Z/destination-post-b43-all.bundle` verifies 286 refs and complete history; `/home/ubuntu/0000-full/migration-backups/streams-20260917T052328Z/SHA256SUMS` verifies 84/84 entries. The latest Streams skills symlink archive `/home/ubuntu/0000-full/migration-backups/streams-20260917T052328Z/destination/streams-agents.tar` contains 84 symlinks, with paired symlink and resolved inventories alongside it.

The source Codex Desktop project ID is `2207c8a3-6bda-44a-ad36-fba364d98f9f`. The destination project is `0000-streams-new`, ID `72aeeba2-e595-4bea-a10a-bc1554c1021c`, at the destination service path above.

## Validation

- Root `bun run check` passed across 11 workspace manifests. `bun run check:turbo:dry` passed and includes `@0000/streams` (with a remote-cache warning).
- Streams `bun run check:application` passed with Oxlint 1.82.0 and Biome 2.5.13, checking five files.
- Full `bun run check:turbo` reached 10/11 and failed only at the existing `@0000/msg` workspace because `oxlint` was unavailable on PATH. The root lockfile declares Oxlint, which a frozen CI install should provide.

## Codex task inventory

The source contained two user tasks and three internal records. The active listing surfaced only the current migration task. The archived scan covered all seven pages and 317 entries, with one source match. The complete mapping is in `codex-task-mapping.json`.

- Archived task `Set up Matt Pocock skills` (`01a09093-3e4c-7102-b135-e323efa9acd5`) was copied as `01a0addb-d2e7-7210-a917-bac588e73d14`. Its five-turn history is equivalent, the destination cwd is correct, and the archived status is preserved. Desktop task-list visibility remains unconfirmed and requires manual verification.
- Active task `Migrate service and Codex tasks` (`01a0adcc-0e30-7f62-89dd-c0bfe4bc8763`) is deferred until idle; no copy was made.
- One implementation subagent record and two guardian reviews were excluded from user-task copies. Codex database and rollout backups cover those records.

For an idempotent rerun, query the destination for a task whose `forked_from_id` equals the source task ID. Reuse an existing match; create a fork only when none exists.
