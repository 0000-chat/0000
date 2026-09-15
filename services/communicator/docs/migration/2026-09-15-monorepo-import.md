# Communicator monorepo import

Date: 2026-09-15 (UTC)

The Communicator application was imported from
`/home/ubuntu/0000-full/repos/0000-communicator` into
`services/communicator` in the `0000` monorepo on branch
`codex/import-communicator`.

## Import basis

- Destination base: `62fb3a0` (`0000` `main`)
- Imported source tip: `a250f64f71a8a135fe394cc394c1ab35de886ccf`
  (`codex/whatsapp-pilot-deployment`, PR39)
- The migration commit has the destination base and source tip as parents.
  The source tree is staged below `services/communicator`, preserving source
  commit ancestry without merging alternate feature branches into the
  product tree.
- All 201 refs from the verified source bundle are retained under
  `refs/migration/communicator/`, including source heads, remotes, migration
  refs, worktree refs, turn-diff refs, `HEAD`, and `stash`.

The source heads `codex/pilot-private-gateway`,
`codex/oxlint-biome-communicator`, and
`research/whatsapp-provider-boundaries` diverge from the selected tip. They
remain recoverable through the namespaced refs and the source backup; their
changes were not applied implicitly.

## Relocation adaptations

The imported application keeps its nested pnpm workspace and
`pnpm-lock.yaml`. The outer monorepo service manifest is private and named
`@0000/communicator`, exposes `./scripts/check` for the Bun/Turbo service
check, and retains the original full pnpm/Rust check as
`check:application`. The application check validates the canonical metadata
name `0000-communicator` instead of deriving it from the relocated directory
name.

The outer root workflow runs the service check after the Bun/Turbo checks.
The root README and this service README describe the two workspace layers.
The 84 existing source-scoped skill links were recreated under the relocated
service `.agents/skills` directory with corrected relative targets. They are
local ignored state and are not part of the commit.

## Preserved local state

Credentials, runtime databases, generated dependencies, build outputs,
Wrangler state, caches, and temporary test artifacts stay outside tracked
files. Tracked edits and meaningful untracked files from source worktrees are
preserved by the migration backup at
`/home/ubuntu/0000-full/migration-backups/communicator-2026-09-15/`.
The source checkout was not modified.

The source migration handoff remains at
`docs/migration/2026-09-12-communicator-migration.md`; its intentionally red
health observation and alternate historical refs remain unchanged.

## Issue routing

Current service work belongs to
[`0000-chat/0000`](https://github.com/0000-chat/0000) and uses the
`service:communicator` label. The pilot map is
[WhatsApp pilot with reusable provider boundaries](https://github.com/0000-chat/0000/issues/1).
The verified transfer map is `1–5 → 1–5`, `7 → 6`, `8 → 7`, `9 → 8`,
`10 → 9`, `11–36 → 11–36`, and `38 → 10`; its captured record is retained at
`/home/ubuntu/0000-full/migration-backups/communicator-2026-09-15/issues/transfer/mapping.json`.
Imported planning and wayfinder links now use the destination URLs. Other
historical source links remain where they document source history or review
provenance.

## Validation

- `bun install --frozen-lockfile` completed without changing the root lockfile.
- `bun run check` passed for all 9 outer workspace manifests.
- `bun run check:turbo` passed all 9 tasks; the Communicator task ran
  `./scripts/check`.
- `bun run check:turbo:dry` reported the same 9-task graph and command.
- `./scripts/check` passed Oxlint 1.82.0, Biome 2.5.13, and 367 checked files.
- `PYTHONDONTWRITEBYTECODE=1 TMPDIR=<root-filesystem-temp> python3 -m unittest discover -s tests -q`
  passed all 187 Python tests. The root-filesystem temp directory was used
  because `/tmp` was full during migration.

The full nested Rust and pnpm application check was not rerun during import;
the imported application and configuration files remain byte-identical outside
the documented relocation adaptations. The follow-up documentation commit
changed only agent guidance and destination issue URLs; no application
implementation changed. The nested check can rebuild the unchanged application
toolchain.

## Preservation backup verification

The final preservation report is
`/home/ubuntu/0000-full/migration-backups/communicator-2026-09-15/REPORT.txt`.
It records the 6,006,035,714-byte source archive
`source/source.tar.zst` with SHA-256
`605d71b4b40654a38ce65c168cbca7967df5d927ee08d5010a9f33c08331abaa`, 35
registered worktrees with one missing/prunable entry, 3,857 selected dirty or
non-generated records, and zero archive/checksum failures.

## GitHub migration result

All 36 issues were transferred natively to `0000-chat/0000`: 9 open and 27
closed, with all 166 comments preserved. Every issue has the
`service:communicator` label. The transfer required restoring 14 parent links
and one dependency link. Final content, parent, dependency, and child-list
verification found no mismatches. Issue references in bodies and comments
were updated using the recorded mapping.

The source repository has no remaining non-PR issues. Source pull requests
#6, #37, and #39 remain at their original URLs. Their records are preserved
in the backup; PR #39's implementation is included in the imported source tip.

The final issue report is
`/home/ubuntu/0000-full/migration-backups/communicator-2026-09-15/issues/migration-report.md`.
The enriched mapping is `issues/transfer/old-to-new.json` under that backup.

## Codex project continuity

Live Codex session files were left in place. The backup contains a manifest
of 11,452 session files and a consistent SQLite snapshot whose integrity
check passed. The service's 84 local skill links resolve to their original
targets.

The Codex app project entry was not changed. Open
`/home/ubuntu/0000-full/0000/services/communicator` as the dedicated
Communicator project in the app. Existing conversations remain stored with
their historical directory metadata. The installed CLI can show them and
resume one using the new service directory:

```sh
codex resume --all -C /home/ubuntu/0000-full/0000/services/communicator
```

At the initial handoff, the migration commits were local on
`codex/import-communicator`; monorepo `main` and remote code had not changed.
The user subsequently authorized merging and pushing the migration to main.
The original checkout and linked worktrees remain available for recovery.
