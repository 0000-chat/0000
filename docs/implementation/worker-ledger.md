# Implementation worker ledger

Snapshot: 2026-09-13 (Pacific/Auckland). Evidence below is read-only status
captured during aggregate bootstrap. A later merge must append a new row or
update the existing row with the worker's final commit and verification.

| Scope | Worktree | Branch | HEAD | Status / dirty evidence |
| --- | --- | --- | --- | --- |
| Aggregate | `/tmp/communicator-implementation/aggregate/0000-communicator` | `codex/implement-agent-messaging` | `e4b8ede` | Health #5, runtime #9, and tooling baseline merged serially; focused suites and restored `scripts/check` pass; grants #12 remains held. |
| Existing health work | `/tmp/0000-communicator-health` | `codex/gateway-health-inspection` | `bac77da77d8d8280d672a7402faf2c77adbbc1c9` | Dirty and protected: `services/matrix-gateway/src/health.rs`, `services/matrix-gateway/tests/healthcheck.rs`; preserved diff SHA-256 `b4968e9c176d598ef2bf2667007f2408f6ff6406b3ff8d7f69d9e4012356d303`. |
| Health worker (#5) | `/tmp/0000-communicator-worker-5` | `codex/implement-health-5` | `870a24e21c91c4611d0ecd557e9fe8dcc0f5310a` | Clean source branch merged as aggregate commit `c16c12a`; pending no further worker action. |
| Runtime worker (#9) | `/tmp/communicator-implementation/worker-9/0000-communicator` | `codex/implement-runtime-9` | `659f02b683bd3583652b5575b0a74f9035387988` | Clean source branch merged as aggregate commit `f681496`; source branch preserved for evidence. |
| Tooling baseline | `/tmp/communicator-implementation/tooling-baseline/0000-communicator` | `codex/communicator-tooling-baseline` | `8dcd2acfa396a6ff8a1223d699b9aa7a5e910f47` | Clean source branch merged as aggregate commit `e4b8ede`; 191 authored files mechanically formatted, 46 Oxlint warnings fixed minimally, and three generated artifacts excluded from Biome. |
| Grants worker (T01/#12) | `/tmp/0000-communicator-worker-12` | `codex/implement-grants-12` | `bc80a6a7130c6fd0979142c2517277f43f6b27a5` | Repair checkpoint atop `f9e16bc` preserved but held; targeted suites pass while three full-suite failures remain under investigation. |
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
| #12 | T01 account grants | held at clean checkpoint `f9e16b` on `codex/implement-grants-12`; source preserved while UI/realtime acceptance fixes and regression evidence are collected |
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

## Default-branch merge evidence

Fetched `origin/main` at `5aa71396cdea9925013c68d20bca095a64efda46` and merged
it into the aggregate as `8331ad4`. The three conflicts were resolved by
preserving the migrated application check and metadata, adding main's Node 24
workflow setup and Biome/Oxlint assets, and unioning the ignore rules. The
scaffold-only metadata rule was not retained because it contradicts the
imported application handoff.

Focused post-merge Rust verification passed the binary behavior test (1/1)
and healthcheck suite (24/24). The tooling baseline then reconciled the
imported source with the pinned formatter and linter. The restored full
`./scripts/check` passes: Biome checked 229 files after excluding the exact
generated MSW service worker, route tree, and Wrangler worker-configuration
artifacts, and Oxlint reported no warnings. No unrelated source cleanup was
applied.

## Tooling baseline merge evidence

The clean worker branch `codex/communicator-tooling-baseline` at
`8dcd2acfa396a6ff8a1223d699b9aa7a5e910f47` was merged as `e4b8ede`. The
representative auth, control-directory, realtime, and contract edits were
reviewed as formatter/unused-warning cleanup; the three Biome exclusions are
generated artifacts rather than source paths. Verification passed with 40
worker test files and 580 tests, 18 UI test files and 107 tests,
`pnpm --filter @communicator/control-plane check` (TypeScript plus both Vite
builds), and `cargo fmt --all --check`.

## Grants recovery checkpoint

After several unanswered checkpoint requests and a repair diff growing by
roughly 1,000 lines without reported test results, the parent interrupted and
resumed the same worker with a bounded checkpoint/typecheck/API-regression-first
instruction. The working hypothesis is that accumulated edits without
incremental feedback prolonged the loop. The attempt is to preserve dirty
source and require current compilation plus the smallest meaningful grant test
before further expansion; the check remains pending. #12 stays held and no
code is merged.

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

## Preparation designs

The OAuth and WhatsApp linking designs are preserved at
[`oauth-implementation-design.md`](oauth-implementation-design.md) and
[`linking-implementation-design.md`](linking-implementation-design.md). They
are nonempty implementation preparation documents, not acceptance evidence,
live registration, deployment, or phone-scan proof. The missing private
provisioning gateway for #14 remains implementation scope: it requires a
runnable authenticated gateway/configuration boundary and controlled HTTP
integration tests. Later deployment and phone scanning require separate
authorization.

## Grants worker checkpoint

The #12 parent is paused for a final test report and bounded authorization fix;
its source worktree remains preserved and no grants code has entered the
aggregate. The checkpoint reports 5/5 grants checks, 41 worker files with 585
tests, 18 UI files with 107 tests, and passing contracts/control-plane type
checks. Three parent P1 read/grant/list findings were fixed.

Independent review found an absence-based realtime authorization path:
`realtimeReadScopeSupported` could allow an identity socket when no active
accounts existed, exposing retired backlog. The worker resumed a bounded fix
with an explicit principal/permission policy, denying delegated identity-wide
subscriptions while preserving the proper human-admin path. The working
hypothesis is a legacy-compatibility fallback bypass; the attempted fix removes
that implicit fallback and must add focused retired/no-account and revocation
regressions before commit. This checkpoint does not claim #12 complete.

## Grants acceptance hold

Independent UI review and the parent review hold checkpoint `f9e16b` despite
its clean worktree and prior test reports. The UI still targets the signed-in
owner instead of the selected agent, its MSW store does not persist created
grants, pagination is absent, selected chat IDs cannot be discovered through
the UI, and query errors are not shown. These are acceptance blockers, not
aggregate merge conflicts.

The realtime old-socket-normal-revalidation claim also remains unproven: the
helper is covered, but the actual tenant-socket path needs inspection and
regressions. The implementer is resuming the bounded fix and new UI behavior
tests. Keep `f9e16b` and the repair checkpoint preserved; do not merge #12
until those findings have accepted evidence.

## Grants repair checkpoint

The worker preserved repair commit `bc80a6a7130c6fd0979142c2517277f43f6b27a5`
atop `f9e16bc`. Targeted read/socket (39), UI (4), grants (5), and TypeScript
checks passed. The full 590-test suite still has three failures under exact
failure investigation, so #12 remains held and no code has entered the
aggregate.

The dependency-related failures were traced to the worker removing a temporary
untracked root `node_modules` symlink after validation; no source or lockfile
changes were lost. The worker must retain the dependency links through final
validation and report or fix the three failures before another merge decision.
