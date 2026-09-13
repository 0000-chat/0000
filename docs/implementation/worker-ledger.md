# Implementation worker ledger

Snapshot: 2026-09-13 (Pacific/Auckland). Evidence below is read-only status
captured during aggregate bootstrap. A later merge must append a new row or
update the existing row with the worker's final commit and verification.

| Scope | Worktree | Branch | HEAD | Status / dirty evidence |
| --- | --- | --- | --- | --- |
| Aggregate | `/tmp/communicator-implementation/aggregate/0000-communicator` | `codex/implement-agent-messaging` | `f681496` | Runtime worker #9 merged serially after health; focused runtime/health tests and `scripts/check` passed; ledger update pending this commit. |
| Existing health work | `/tmp/0000-communicator-health` | `codex/gateway-health-inspection` | `bac77da77d8d8280d672a7402faf2c77adbbc1c9` | Dirty and protected: `services/matrix-gateway/src/health.rs`, `services/matrix-gateway/tests/healthcheck.rs`; preserved diff SHA-256 `b4968e9c176d598ef2bf2667007f2408f6ff6406b3ff8d7f69d9e4012356d303`. |
| Health worker (#5) | `/tmp/0000-communicator-worker-5` | `codex/implement-health-5` | `870a24e21c91c4611d0ecd557e9fe8dcc0f5310a` | Clean source branch merged as aggregate commit `c16c12a`; pending no further worker action. |
| Runtime worker (#9) | `/tmp/communicator-implementation/worker-9/0000-communicator` | `codex/implement-runtime-9` | `659f02b683bd3583652b5575b0a74f9035387988` | Clean source branch merged as aggregate commit `f681496`; source branch preserved for evidence. |
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
| #5 | Gateway health | verified and merged as `c16c12a`; issue remains open until aggregate PR merge |
| #9 | Runtime | verified and merged as `f681496`; issue remains open until aggregate PR merge |
| #11 | Agent messaging specification | aggregate parent / planned |
| #12 | T01 account grants | implementing on `codex/implement-grants-12` in `/tmp/0000-communicator-worker-12`; dirty handoff |
| #13–#36 | T02–T25 child tickets | planned; dependencies in aggregate plan |

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

## Runtime merge evidence

Worker #9 source `659f02b683bd3583652b5575b0a74f9035387988` was merged as
aggregate commit `f681496`. Focused aggregate verification passed the binary
behavior test (1/1) and healthcheck suite (24/24), followed by the canonical
basename `./scripts/check`. The worker also reported registry-admin (10),
configuration/redaction (20), and Matrix transport (17) suites, clippy with
warnings denied, formatting, diff, and JSON checks passing. Its systemd parse
could not run because the installed binary is absent; no deployment was
attempted.

## Coordination artifacts

The pinned WhatsApp bridge contract is copied verbatim at
[`pinned-whatsapp-linking-contract.md`](pinned-whatsapp-linking-contract.md)
(source and aggregate SHA-256:
`25094f2361042bad9af2d8f61bd633ea0f6fbcc4ee6049e73a08d276c804654b`). It is
research evidence for T24, not live-account proof. The OAuth constraints for
T02 are recorded in [`auth-preflight.md`](auth-preflight.md).

Issue state remains intentionally open while the aggregate draft PR is in
progress. Readiness is recorded here by dependency and worker evidence; an
open GitHub issue or a future `Closes` reference is not treated as proof that
the ticket is complete.
