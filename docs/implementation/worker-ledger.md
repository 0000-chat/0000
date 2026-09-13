# Implementation worker ledger

Snapshot: 2026-09-13 (Pacific/Auckland). Evidence below is read-only status
captured during aggregate bootstrap. A later merge must append a new row or
update the existing row with the worker's final commit and verification.

| Scope | Worktree | Branch | HEAD | Status / dirty evidence |
| --- | --- | --- | --- | --- |
| Aggregate | `/tmp/communicator-implementation/aggregate/0000-communicator` | `codex/implement-agent-messaging` | `cf6b50f` | Health #5, runtime #9, tooling baseline, and #12 feature behavior integrated serially; focused checks and restored `scripts/check` pass. A separate full-Worker teardown failure holds aggregate PR readiness, while #13/#14 implement independently from this checkpoint. |
| Existing health work | `/tmp/0000-communicator-health` | `codex/gateway-health-inspection` | `bac77da77d8d8280d672a7402faf2c77adbbc1c9` | Dirty and protected: `services/matrix-gateway/src/health.rs`, `services/matrix-gateway/tests/healthcheck.rs`; preserved diff SHA-256 `b4968e9c176d598ef2bf2667007f2408f6ff6406b3ff8d7f69d9e4012356d303`. |
| Health worker (#5) | `/tmp/0000-communicator-worker-5` | `codex/implement-health-5` | `870a24e21c91c4611d0ecd557e9fe8dcc0f5310a` | Clean source branch merged as aggregate commit `c16c12a`; pending no further worker action. |
| Runtime worker (#9) | `/tmp/communicator-implementation/worker-9/0000-communicator` | `codex/implement-runtime-9` | `659f02b683bd3583652b5575b0a74f9035387988` | Clean source branch merged as aggregate commit `f681496`; source branch preserved for evidence. |
| Tooling baseline | `/tmp/communicator-implementation/tooling-baseline/0000-communicator` | `codex/communicator-tooling-baseline` | `8dcd2acfa396a6ff8a1223d699b9aa7a5e910f47` | Clean source branch merged as aggregate commit `e4b8ede`; 191 authored files mechanically formatted, 46 Oxlint warnings fixed minimally, and three generated artifacts excluded from Biome. |
| Grants worker (T01/#12) | `/tmp/0000-communicator-worker-12` | `codex/implement-grants-12` | `823642f42dacab3ba24f75c57203f94b03125896` | Feature behavior accepted and integrated at aggregate `c86c9b0`; worker retains only three untracked dependency links; source/lockfile changes are clean. Full-Worker teardown remains a separate aggregate PR-readiness blocker. |
| OAuth worker (T02/#13) | `/tmp/communicator-implementation/worker-13/0000-communicator` | `codex/implement-oauth-13` | `cf6b50f6a56b5bf56ffaf1cf8bb0d8359ed0b2ea` | Dispatched independently from aggregate checkpoint `cf6b50f`; implementation in progress; no acceptance evidence yet. |
| Linking worker (T24/#14) | `/tmp/communicator-implementation/worker-14/0000-communicator` | pending worker checkout | `cf6b50f` base | Dispatched independently from aggregate checkpoint `cf6b50f`; implementation in progress; no acceptance evidence yet. |
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
| #11 | Agent messaging specification | aggregate parent active; #12 feature behavior is accepted/integrated at `c86c9b0`; a separate full-Worker teardown failure holds PR readiness; #13/#14 are dispatched independently |
| #12 | T01 account grants | feature behavior accepted and integrated at aggregate `c86c9b0` from `codex/implement-grants-12` at `823642f`; full-suite process failure remains a crosscutting PR-readiness blocker; issue remains open |
| #13/#14 | T02 OAuth and T24 WhatsApp linking | independently implementing from aggregate checkpoint `cf6b50f`; no child acceptance evidence yet; issues remain open |
| #15–#36 | T03–T25 child tickets | planned; dependencies in aggregate plan |

Architecture decision #7 is tracked at
[`decision-07-connection-status.md`](decision-07-connection-status.md). It is
not a #7 issue closure or acceptance claim.

## Ticket reporting rule

Every meaningful merge or recovery checkpoint must update the affected GitHub
ticket with its branch, commit, validation evidence, and remaining blockers.
Frontier changes also update #11 and the map. Issues remain open until the
aggregate PR merges, and failed acceptance is never marked complete; unchanged
status does not receive routine duplicate comments.

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

The following grants sections preserve earlier recovery and acceptance-hold
checkpoints. They are historical evidence; the current transition is recorded
in the aggregate integration checkpoint below: #12 feature behavior is accepted
in `c86c9b0`, while the full-Worker teardown failure is tracked separately as a
crosscutting PR-readiness blocker.

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

## Grants follow-up recovery

The three full-suite failures were identified as an outdated attachment-schema
expectation, a source-inspection test broken by an async signature, and an
ingestion socket fixture missing reader membership and an identity grant. The
worker fixed those cases in the uncommitted follow-up after `bc80a6a`.

The SQL pagination path now uses `EXISTS`, and explicit account authorization
resolves only the requested account. Focused regressions pass: grants 6/6,
cross-owner 1/1, and TypeScript. The final full Worker/UI runs are still in
progress; the follow-up is not committed or merged, and #12 remains held until
clean committed full-suite results are reported.

## Grants aggregate integration checkpoint

The accepted worker source `823642f42dacab3ba24f75c57203f94b03125896`, including
the `f9e16bc` and `bc80a6a` repair history, was integrated as aggregate commit
`c86c9b0`. Conflict resolution preserved the grants behavior alongside the
aggregate runtime, tooling, and documentation; 33 changed source files were
normalized with the pinned formatter. Focused grants/read/socket verification
passed 45/45 tests, the isolated socket suite passed 28/28, the UI suite passed
109/109, TypeScript and both Vite builds passed, and `scripts/check` passed its
233-file application/tooling check.

Two isolated full Worker runs each exercised 41 files and 591 passing tests but
exited with one `EnvironmentTeardownError` in
`worker/test/realtime/socket.test.ts`: workerd/Vitest closed an RPC while
`onUserConsoleLog`/`resolve` was pending. The hypothesis is a pending RPC and
console-log teardown race. The attempt was to rerun the full Worker alone, with
the temporary dependency links retained, after the earlier concurrent run. The
same teardown signature reproduced, so this is an integration checkpoint rather
than a full-suite process pass. The #12 feature behavior remains accepted and
integrated; the teardown is a separate crosscutting PR-readiness blocker. It
does not gate #13/#14 implementation, which was dispatched independently from
`cf6b50f`. Issues remain open and no PR-ready or deployment claim is made.
