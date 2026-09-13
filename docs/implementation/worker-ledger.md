# Implementation worker ledger

Snapshot: 2026-09-13 (Pacific/Auckland). Evidence below is read-only status
captured during aggregate bootstrap. A later merge must append a new row or
update the existing row with the worker's final commit and verification.

| Scope | Worktree | Branch | HEAD | Status / dirty evidence |
| --- | --- | --- | --- | --- |
| Aggregate | `/tmp/communicator-implementation/aggregate/0000-communicator` | `codex/implement-agent-messaging` | `c16c12a` | Health worker #5 merged serially; focused tests and `scripts/check` passed; ledger update pending this commit. |
| Existing health work | `/tmp/0000-communicator-health` | `codex/gateway-health-inspection` | `bac77da77d8d8280d672a7402faf2c77adbbc1c9` | Dirty and protected: `services/matrix-gateway/src/health.rs`, `services/matrix-gateway/tests/healthcheck.rs`; preserved diff SHA-256 `b4968e9c176d598ef2bf2667007f2408f6ff6406b3ff8d7f69d9e4012356d303`. |
| Health worker (#5) | `/tmp/0000-communicator-worker-5` | `codex/implement-health-5` | `870a24e21c91c4611d0ecd557e9fe8dcc0f5310a` | Clean source branch merged as aggregate commit `c16c12a`; pending no further worker action. |
| Grants worker (T01/#12) | `/tmp/0000-communicator-worker-12` | `codex/implement-grants-12` | `0a9455de0b4569fa63ee755888b0f7abb2fe67ea` | Dirty implementation handoff: modified `packages/contracts/src/{authorization,conversation,index,projection}.ts`; untracked `apps/control-plane/migrations/0005_account_grants.sql` and `packages/contracts/src/grants.ts`. |
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

Architecture decision #7 is tracked at
[`decision-07-connection-status.md`](decision-07-connection-status.md). It is
not a #7 issue closure or acceptance claim.

## Health merge evidence

Worker #5 source `870a24e21c91c4611d0ecd557e9fe8dcc0f5310a` was merged with
the full worker branch as aggregate merge commit `c16c12a`. The focused
`communicator-matrix-gateway` `healthcheck` target passed all 24 tests. The
canonical-basename `./scripts/check` also passed. The protected original dirty
health worktree remains separate and was not staged, cleaned, or merged from
directly.
