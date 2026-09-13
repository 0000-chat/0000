# Implementation worker ledger

Snapshot: 2026-09-13 (Pacific/Auckland). Evidence below is read-only status
captured during aggregate bootstrap. A later merge must append a new row or
update the existing row with the worker's final commit and verification.

| Scope | Worktree | Branch | HEAD | Status / dirty evidence |
| --- | --- | --- | --- | --- |
| Aggregate | `/tmp/0000-communicator-aggregate` | `codex/implement-agent-messaging` | `9d6684eac906de7a2024d397dc1057edc32f4795` | Planning baseline committed; ledger changes pending this commit. |
| Existing health work | `/tmp/0000-communicator-health` | `codex/gateway-health-inspection` | `bac77da77d8d8280d672a7402faf2c77adbbc1c9` | Dirty and protected: `services/matrix-gateway/src/health.rs`, `services/matrix-gateway/tests/healthcheck.rs`. |
| Health worker (#5) | `/tmp/0000-communicator-worker-5` | `codex/implement-health-5` | `bac77da77d8d8280d672a7402faf2c77adbbc1c9` | Dirty with the same two health files; awaiting worker handoff/commit. |
| Grants worker (T01/#12) | `/tmp/0000-communicator-worker-12` | `codex/implement-grants-12` | `0a9455de0b4569fa63ee755888b0f7abb2fe67ea` | Clean at migration head; implementation not yet committed. |
| Provider research | `/tmp/communicator-provider-research` | `research/whatsapp-provider-boundaries` | `fdac312fad746a31f44d2949e3c286020c8715a0` | Clean research branch; not an implementation merge. |
| Oxlint/biome | `/home/ubuntu/0000-full/worktrees/oxlint-biome-communicator/0000-communicator` | `codex/oxlint-biome-communicator` | `e5bc69edcab510c9f3732e1a7995365a946076c6` | Clean and protected unrelated worktree. |

The canonical migration root remains on `codex/migration-communicator` at
`0a9455de0b4569fa63ee755888b0f7abb2fe67ea` with its pre-existing dirty
planning paths and an untracked `.target-health/` directory observed during
bootstrap. It was not edited by the aggregate bootstrap. The aggregate was
created from the migration head after read-only inspection confirmed that
origin `main` is `5aa71396cdea9925013c68d20bca095a64efda46` and PR #6 is open
from the migration branch into `main`; no target-main commit was integrated.

## Ticket ledger

The published plan is the source of truth for dependencies and acceptance.
Tickets are initially `planned`; workers must change a ticket to `in review`,
`merged`, or `blocked` with a branch, SHA, dirty evidence, and validation note.

| Ticket | Scope | Initial state |
| --- | --- | --- |
| #5 | Gateway health | worker active; dirty handoff |
| #9 | Runtime | blocked by #5 |
| #11 | Agent messaging specification | aggregate parent / planned |
| #12–#36 | T01–T25 child tickets | planned; dependencies in aggregate plan |
