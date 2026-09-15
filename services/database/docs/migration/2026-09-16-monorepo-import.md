# 0000-database monorepo import

Imported `0000-chat/0000-database` into `services/database` on 2026-09-16.

The selected source tip was `b9c97a3a37b03589a456abd5010c51342e57d386`
(`origin/main`). It includes the local source `main` tip
`ef6aa3d95f6f7df8a1a306c4c1d76192a52476e1`; divergent branches, remote refs,
Codex checkpoint refs, worktrees, patches, ignored state, and stashes were
preserved in `refs/migration/database/*` and in the retained source checkout.

Before import, complete Git bundles, tracked-tree archives, eight worktree
archives, change-class manifests, detailed issue snapshots, service-skill link
manifests, and hashes were stored at
`/home/ubuntu/0000-full/migration-backups/database-20260915T182615Z`.
SQLite backup-API copies and integrity-check records preserve the active Codex
session stores there as well. The original checkout and backup directory are
retained.

The source registered eight worktrees and no stashes. The selected source tip
does not implicitly merge the divergent worktree branches or the dirty
`codex/hono-health-openapi` worktree; each remains in the source checkout,
the namespaced refs, and the verified worktree archive. The Codex discovery
record identified 35 source-working-directory sessions (33 unarchived and two
archived) and 35 rollouts. All six copied SQLite stores passed integrity
checks.

The destination scaffold at commit
`6857c5065e6793475e89bb663aed1e26f7035c2d` was retained as the workspace
wrapper: its package is `@0000/database`; the source pnpm lockfile and quality
tooling remain inside this service. Root Bun/Turbo checks and the service
application check are intentionally separate.

All twelve source issues were natively transferred, preserving their original
metadata and comments, and labeled `service:database`:

| Source | Destination |
| --- | --- |
| #1 | #37 |
| #2 | #38 |
| #3 | #39 |
| #4 | #40 |
| #5 | #41 |
| #6 | #42 |
| #7 | #43 |
| #8 | #44 |
| #9 | #45 |
| #10 | #46 |
| #11 | #47 |
| #12 | #48 |

There were no source pull requests or releases. Native transfer did not alter
the source history. The transferred map issue owns its transferred child
issues, and the recorded dependency edges remain present. The dedicated Codex
Desktop project must still be relinked manually to this directory; session
preservation is verified, but the desktop application has not yet provided
evidence that it relinked existing sessions.
