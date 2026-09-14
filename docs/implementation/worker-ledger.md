# Implementation worker ledger

Snapshot: 2026-09-13 (Pacific/Auckland). Evidence below records the serialized
#14, #17, #18, and #25 aggregate merges and the active child frontier. The
ledger and plan remain intentionally dirty after the code commit so the next
merger can preserve this coordination state.

| Scope | Worktree | Branch | HEAD | Status / dirty evidence |
| --- | --- | --- | --- | --- |
| Aggregate | `/tmp/communicator-implementation/aggregate/0000-communicator` | `codex/implement-agent-messaging` | `d7dee32db7d5f718252e545c761d0ede31413b48` | Health #5, runtime #9, tooling baseline, #12 feature behavior, #13 OAuth/MCP, #14 linking, #17 search, #18 durable acceptance, #25 webhook configuration, and the atomic cutover follow-up merged serially. Focused #18 compatibility 9 files/99 tests, TypeScript/Vite, and pinned `scripts/check` 257 files pass. Draft PR remains WIP; no live delivery/account/deployment proof claimed. |
| Existing health work | `/tmp/0000-communicator-health` | `codex/gateway-health-inspection` | `bac77da77d8d8280d672a7402faf2c77adbbc1c9` | Dirty and protected: `services/matrix-gateway/src/health.rs`, `services/matrix-gateway/tests/healthcheck.rs`; preserved diff SHA-256 `b4968e9c176d598ef2bf2667007f2408f6ff6406b3ff8d7f69d9e4012356d303`. |
| Health worker (#5) | `/tmp/0000-communicator-worker-5` | `codex/implement-health-5` | `870a24e21c91c4611d0ecd557e9fe8dcc0f5310a` | Clean source branch merged as aggregate commit `c16c12a`; pending no further worker action. |
| Runtime worker (#9) | `/tmp/communicator-implementation/worker-9/0000-communicator` | `codex/implement-runtime-9` | `659f02b683bd3583652b5575b0a74f9035387988` | Clean source branch merged as aggregate commit `f681496`; source branch preserved for evidence. |
| Tooling baseline | `/tmp/communicator-implementation/tooling-baseline/0000-communicator` | `codex/communicator-tooling-baseline` | `8dcd2acfa396a6ff8a1223d699b9aa7a5e910f47` | Clean source branch merged as aggregate commit `e4b8ede`; 191 authored files mechanically formatted, 46 Oxlint warnings fixed minimally, and three generated artifacts excluded from Biome. |
| Grants worker (T01/#12) | `/tmp/0000-communicator-worker-12` | `codex/implement-grants-12` | `823642f42dacab3ba24f75c57203f94b03125896` | Feature behavior accepted and integrated at aggregate `c86c9b0`; worker retains only three untracked dependency links; source/lockfile changes are clean. Fresh full Worker diagnostics pass; the earlier teardown is monitored as an upstream Vitest 4.1.11 shutdown flake, with no root-cause-fix claim. |
| OAuth worker (T02/#13) | `/tmp/communicator-implementation/worker-13/0000-communicator` | `codex/implement-oauth-13` | `8d21121` | Clean source branch merged as aggregate `83a6c3f`; full Worker 42 files/594 tests, TypeScript/build, packaging/validator/bootstrap dry-runs, local Wrangler deploy dry-run with 11 variables, and diff passed. The aggregate cached pinned tooling check also passed; no deployment occurred. |
| Linking worker (T24/#14) | `/tmp/communicator-implementation/worker-14/0000-communicator` | `codex/implement-linking-14` | `7fde33860479d2b916c479bf19367d8cf34185fc` | Clean final source merged as aggregate `87695a58e4891e6d1dbeabdbb9355fee4001d25e`. Worker evidence: UI 19 files/117 tests, focused linking UI 8, Worker linking 2 files/6, TypeScript/build/scripts check, Rust provisioning 3/3, clippy, Python 18, rustfmt/diff. Delayed-D1 injection coverage remains limited; real phone/deployment proof is not claimed. |
| History worker (#15) | `/tmp/communicator-implementation/worker-15/0000-communicator` | `codex/implement-history-15` | `87695a5` base | Active from the verified #14 aggregate; migration `0011_history` is conditional per worker handoff. No completion claim. |
| Search worker (#17) | `/tmp/communicator-implementation/worker-17/0000-communicator` | `codex/implement-search-17` | `52e161dcbba6c290b040b00dc4b0f072c9ea768e` | Clean source merged as aggregate `9de7a756e0b24dadc4489e2257a17d2a96b34849`; worker full suite 42 files/595 tests and aggregate focused search/auth/linking 7 files/66 tests pass. No new migration was required. |
| Durable acceptance worker (#18) | `/tmp/communicator-implementation/worker-18/0000-communicator` | `codex/implement-durable-acceptance-18` | `0933839ad6eee1ceb630253665ac9a1e420a0c85` | Clean source branch at final worker commit; merged as aggregate `d7dee32`. Worker full suite 42 files/598 tests passed. Aggregate focused acceptance/OAuth/search/webhook/projection/schema suite passed 9 files/99 tests, TypeScript, both Vite builds, and `scripts/check` 257 files. |
| Offline acceptance worker (#19) | `/tmp/communicator-implementation/worker-19/0000-communicator` | `codex/implement-offline-19` | `d7dee32db7d5f718252e545c761d0ede31413b48` base | Active isolated worker from the verified #18 aggregate for offline confirmation, cancel, and administrator scope. First bounded controlled-clock checkpoint is pending; no acceptance claim. |
| Webhook/config worker (#25) | `/tmp/communicator-implementation/worker-25/0000-communicator` | `codex/implement-webhook-config-25` | `145a1206f98387efc1edb3c75b2572087ca553ef` | Clean source merged as aggregate `b42ff168c5ca198f7c5e49f44d456100cdfdb0c5`; full Worker 43 files/597 tests, realtime 16, migration 20, TypeScript/build, and `scripts/check` 245 files pass. Migration `0010_webhook_subscriptions` is included; credential references remain opaque deployment metadata and later delivery must owner-scope them. Atomic cutover follow-up `008ddfc49ae6f98774524925541a43c63b9b445e` is merged as aggregate `f9a22905`; focused webhook 5/5 passes. |
| Provider research | `/tmp/communicator-provider-research` | `research/whatsapp-provider-boundaries` | `fdac312fad746a31f44d2949e3c286020c8715a0` | Clean research branch; not an implementation merge. |
| Oxlint/biome | `/home/ubuntu/0000-full/worktrees/oxlint-biome-communicator/0000-communicator` | `codex/oxlint-biome-communicator` | `e5bc69edcab510c9f3732e1a7995365a946076c6` | Clean and protected unrelated worktree. |

The canonical migration root remains on `codex/migration-communicator` at
`0a9455de0b4569fa63ee755888b0f7abb2fe67ea` with its pre-existing dirty
planning paths and an untracked `.target-health/` directory observed during
bootstrap. It was not edited by the aggregate bootstrap. The aggregate was
created from the migration head after read-only inspection confirmed that
origin `main` is `5aa71396cdea9925013c68d20bca095a64efda46` and PR #6 is open
from the migration branch into `main`; no target-main commit was integrated.

## Proactive disk recovery checkpoint

The disk sweep measured 287 MB free on `/tmp` and 4.9 GB on the root volume
before cleanup. Active Cargo processes were using the linking worker's dedicated
`linking14-cargo-target`, which was preserved. `cargo clean` removed only the
inactive generated `.target-health` tree (20.8 GiB) and old
`tmp-recovery/cargo-target` artifacts (4.3 GiB). The old
`/tmp/communicator-pnpm-store` was moved intact to the canonical
`node_modules/.cache/tmp-recovery/communicator-pnpm-store` and the old path was
retained as a symlink, freeing 608 MB of RAM-backed space.

Source worktrees, commits, and older temporary gateway SQLite databases were
untouched. Workers were directed to use disk-backed `TMPDIR` and avoid
parallel Cargo builds against a shared target.

## Ticket ledger

The published plan is the source of truth for dependencies and acceptance.
Tickets are initially `planned`; workers must change a ticket to `in review`,
`merged`, or `blocked` with a branch, SHA, dirty evidence, and validation note.

| Ticket | Scope | Initial state |
| --- | --- | --- |
| #5 | Gateway health | verified and merged as `c16c12a`; issue remains open until aggregate PR merge |
| #9 | Runtime | verified and merged as `f681496`; issue remains open until aggregate PR merge |
| #11 | Agent messaging specification | aggregate parent active; #12 feature behavior, #13 OAuth/MCP, #14 linking, #17 search, #18 durable acceptance, and #25 webhook configuration plus its atomic cutover follow-up are integrated through `d7dee32`. #15 is active with review findings held; #19 is active from the verified #18 base. Issues remain open until the draft PR merges. |
| #12 | T01 account grants | feature behavior accepted and integrated at aggregate `c86c9b0` from `codex/implement-grants-12` at `823642f`; fresh default and diagnostic Worker runs pass 41/591, while the prior teardown remains an observed shutdown flake with no root-cause-fix claim; issue remains open |
| #13/#14 | T02 OAuth and T24 WhatsApp linking | #13 verified and merged as aggregate `83a6c3f`; #14 verified and merged as aggregate `87695a5d` from clean `7fde338`, with delayed-D1 coverage limitation recorded. Real phone/deployment proof is pending later authorized acceptance; issues remain open |
| #15 | T03 history import | active on `codex/implement-history-15` from aggregate `87695a5d`; migration `0011_history` conditional; no acceptance claim yet |
| #17 | T05 scoped search/context | verified and merged as aggregate `9de7a756` from clean `52e161d`; focused aggregate search/auth/linking 7 files/66 tests, control-plane build, and `scripts/check` 251 files pass; issue remains open |
| #18/#25 | T06 durable acceptance / T13 webhook configuration | #18 final worker `0933839` was integrated as aggregate `d7dee32`; focused aggregate 9 files/99 tests, TypeScript, both Vite builds, and `scripts/check` 257 files pass. #25 is verified and merged as aggregate `b42ff168`, with atomic cutover follow-up `f9a22905` passing 5/5, opaque credential metadata, and later owner-scoped delivery still required; issues remain open |
| #19–#36 | Remaining child tickets | #19 active from `d7dee32` on `codex/implement-offline-19`; other tickets remain planned or dependency-held; dependencies in aggregate plan |

Architecture decision #7 is tracked at
[`decision-07-connection-status.md`](decision-07-connection-status.md). It is
not a #7 issue closure or acceptance claim.

## Ticket reporting rule

Every meaningful merge or recovery checkpoint must update the affected GitHub
ticket with its branch, commit, validation evidence, and remaining blockers.
Frontier changes also update #11 and the map. Issues remain open until the
aggregate PR merges, and failed acceptance is never marked complete; unchanged
status does not receive routine duplicate comments.

## Phased worker execution

Workers now return after one passing, committed backend flow and receive a
bounded follow-up for the remaining acceptance surface. A phase checkpoint is
reviewable progress, not whole-ticket acceptance or an aggregate merge gate.

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
integrated; the earlier teardown is tracked separately below as an observed
shutdown flake. It does not gate #13/#14 implementation, which was dispatched
independently from `cf6b50f`.

## Teardown verification checkpoint

In a fresh canonical worktree at the exact tracked checkpoint `cf6b50f`, the
default full Worker run, `detectAsyncLeaks`, and the no-file-parallelism run
each exited 0 with 41 files and 591 passing tests. The leak diagnostic emitted
no leak report. The worktree had no tracked source or configuration changes;
its validation dependency links remain preserved.

The earlier `EnvironmentTeardownError` is therefore classified as an observed
Vitest 4.1.11/workerd shutdown nondeterminism risk under final-validation
monitoring, rather than an active #12 feature blocker. No root-cause fix,
suppression, or dependency/configuration change is claimed. Issues remain open
and the aggregate remains work in progress pending final validation.

## #14 linking phase-1 checkpoint

Worker `codex/implement-linking-14` returned commit `e160220` with one passing
backend flow test and TypeScript passing. The covered flow is administrator
start to ephemeral QR, poll, verified provider account, connection, and route;
an absent QR is stored as an attempt and no agent grant is created
automatically.

This is a phased backend checkpoint, not whole-ticket acceptance or an
aggregate merge. The worker remains intentionally dirty in the private Rust
provisioning gateway (`services/matrix-gateway/Cargo.toml`, `src/lib.rs`, and
new `src/provisioning.rs`); lifecycle guards and the administrator UI remain
pending. The next bounded phase completes the gateway/backend guards using a
dedicated Cargo target to avoid the shared lock. Preserve the dirty worker
state until that phase returns.

## #13 OAuth phase-1 checkpoint (historical)

Worker `codex/implement-oauth-13` returned clean commit `bef228f`. The focused
OAuth/MCP flow, schema regressions, and TypeScript pass. The checkpoint covers
browser redirect/callback, CSRF consent, PKCE, non-admin installation with
zero account grants, and deny-before/admin-grant/read-after authorization.

This is a phased backend checkpoint, not whole-ticket acceptance or an
aggregate merge. Official SDK integration, the wider denial matrix, and
deployment packaging remain pending. The next bounded phase completes SDK and
authority tests; do not unblock dependent tickets from this checkpoint alone.

## #13 OAuth phase-2 checkpoint (historical)

Worker `codex/implement-oauth-13` returned clean commit `092c8df`. It adds the
official MCP SDK transport/client integration, real default-upstream OAuth
exchange and JWKS verification, and grant-filtered account reads. Focused tests,
the full Worker suite (42 files, 593 tests), TypeScript, both Vite builds, and
`scripts/check` pass.

This remains a phased checkpoint, not whole-ticket acceptance or an aggregate
merge. The final bounded phase is completing the denial matrix and deployment
configuration/documentation; dependent tickets remain gated until that phase
returns accepted evidence.

The subsequent focused denial-matrix suite passes 3 tests covering bad
state/client/redirect/verifier, wrong resource/issuer, expiry/clock, tenant
mismatch, scope upgrade without a grant, forged identity, overlapping verifier
classification, token/installation revocation, challenges, and credential
nonforwarding. The worker reports an atomic code claim. Packaging,
configuration, and runbook completion are still running on the dirty worker;
this checkpoint is not accepted or merge-ready.

Packaging review identified that the local bootstrap mistakenly uses `--remote`
and that the upstream identity-provider callback is conflated with the
downstream MCP callback. The worker is correcting those boundaries before the
final packaging checkpoint; no merge or acceptance claim is made.

## #13 aggregate merge evidence

Clean worker commit
`8d21121b6eef61789fa4b4ee4ec6bc5aa01541af` was merged as aggregate commit
`83a6c3fd822ea70dbd9f579e1599c7a48ff5a6e4`. The worker reported the full
Worker suite passing 42 files/594 tests, TypeScript and both builds, packaging
unit test 1/1, validator and bootstrap dry-runs, a local Wrangler deploy
dry-run with 11 variables, and diff checks. Aggregate focused OAuth/schema/auth
verification passed 5 files/59 tests; TypeScript plus both Vite builds passed;
`scripts/check` passed 241 files with pinned Oxlint 1.82.0 and Biome 2.5.13.

The aggregate check used the cached pinned tooling after npm DNS returned
`EAI_AGAIN`; no check was removed or bypassed. The Wrangler validation was a
dry-run only, and no deployment occurred. #13 remains open until the aggregate
PR merges; #17/#18/#25 may now branch from this verified aggregate base.

## #14 linking phase-2 checkpoint

Clean worker commit
`79431077fe6765e6395bfbff753b5227909bea53` passes linking coverage of 2 files
and 6 tests, Rust provisioning 3/3, clippy (`--lib --tests -D warnings`),
TypeScript, Python 18 tests, `scripts/check`, rustfmt, and diff. It implements
the explicit persisted allowlist, Durable Object commit serialization, and
alarm cleanup.

The delayed-D1 injection test could not reach the bound Durable Object
environment and was removed; that coverage limitation is explicit and is not a
passing claim. Administrator UI phase 3 is now running on the same branch.
This remains a phased checkpoint, not whole-ticket acceptance or an aggregate
merge.

## #14 phase-3 setup recovery

The linking worker remained clean at `7943107` after the UI inspection and QR
package installation attempt. Sandbox DNS returned `EAI_AGAIN`; no package or
lockfile changes were made and no installation process remained active. The
parent dispatched an escalated registry install into isolated worker
dependencies before resuming the existing UI implementation. This setup
checkpoint records no UI implementation progress or acceptance evidence. The
subsequent authorized install added the `qrcode` dependency to the worker's
`apps/control-plane/package.json` and `pnpm-lock.yaml`; that later dependency
change is distinct from the failed sandbox attempt.

## #14 aggregate merge evidence

Clean worker commit
`7fde33860479d2b916c479bf19367d8cf34185fc` was merged serially as aggregate
commit `87695a58e4891e6d1dbeabdbb9355fee4001d25e`. The merge preserved OAuth
migration `0006` and linked migration `0007`, resolving the expected
`app.ts`, Wrangler durable-object/configuration, and lockfile conflicts without
discarding either feature. The aggregate contracts dependency link was
repointed to the aggregate tree; worker dependency links remain generated and
untracked.

The first focused aggregate run reached 45/46 assertions across five Worker
files; its only failure was the schema expectation omitting the
`connection_provider_identities` table created by migration `0007`. The
schema expectation was repaired, then the schema test passed. The affected
Wrangler configuration expectations were updated for `LinkSessionDO` and
`CONNECTION_GATEWAY_URL`; the final configuration file passed 8/8 tests. The
control-plane TypeScript check and both Vite builds passed, and the pinned
`scripts/check` passed all 250 files. Persistent logs are under the aggregate
verification cache, including `linking-auth-schema-worker.log`,
`schema-config-worker.log`, `config-worker-final.log`,
`control-plane-check.log`, and `scripts-check-final.log`.

Worker evidence covers UI 19 files/117 tests, focused linking UI 8 tests,
Worker linking 2 files/6 tests, Rust provisioning 3/3, clippy, Python 18
tests, TypeScript/build, rustfmt, and diff. Delayed-D1 injection could not
reach the bound Durable Object environment and remains a stated coverage
limitation. The pinned adapter path is implemented, but no real phone scan,
production deployment, or live account proof is claimed.

## Active child dispatch checkpoint

The parent dispatched #15 history from the verified #14 aggregate
`87695a5d`, and #18 durable acceptance plus #25 webhook/configuration from the
earlier verified OAuth base `83a6c3f`. #17 search is integrated at aggregate
`9de7a756`, #25 is integrated at `f9a22905` including its isolated atomic
cutover follow-up, and #18 is now integrated at `d7dee32`. Migration
`0010_webhook_subscriptions` and the projection-level
`durable_outbound_acceptance` schema are integrated; no standalone
`0009_acceptance` migration was added. #15 owns conditional migration
`0011_history`; no migration is added merely to fill numbers. The parent
dispatched #19 from `d7dee32` on `codex/implement-offline-19` for its first
bounded offline confirmation checkpoint.

The latest resource checkpoint recovered `/tmp` from 216 MB to approximately
854 MB after worker #25's private dependency relocation; root disk reported
approximately 12 GB free. Source worktrees and temporary gateway databases
were preserved, and workers continue using disk-backed caches.

The aggregate commit is local and the branch is nine commits ahead of its
remote tracking ref. An automatic approval review rejected the authorized
`git push origin codex/implement-agent-messaging` because it treated the push
as exporting private source/history without trusted destination evidence. No
push workaround was attempted; the commit and evidence remain preserved for
the parent to handle through the approved channel.

## #17 search aggregate merge evidence

Clean worker commit
`52e161dcbba6c290b040b00dc4b0f072c9ea768e` was merged serially as aggregate
commit `9de7a756e0b24dadc4489e2257a17d2a96b34849`. The two merge conflicts
were resolved by retaining both linking-session authorization paths and the
new `/api/v1/search/*` authorization path in `worker/app.ts`, and by exporting
both `linking` and `search` contracts. No migration was needed for this slice.

The clean worker reported 42 files/595 Worker tests, API 12, MCP 3,
projection-query 12, and realtime-ticket 16 passing, with TypeScript/build,
contracts, and `scripts/check` passing. Aggregate focused compatibility
verification passed 7 files/66 tests, control-plane TypeScript plus both Vite
builds passed, and pinned `scripts/check` passed 251 files. The focused log
contains three expected negative-path worker diagnostics for projection
conflict/rebuilding; the command exited 0 with no failed assertions. The
worker's test-only expiry-filter cleanup avoids a random digest false positive
and is also being reconciled by #25.

## #25 webhook configuration aggregate merge evidence

Clean worker commit
`145a1206f98387efc1edb3c75b2572087ca553ef` was merged serially as aggregate
commit `b42ff168c5ca198f7c5e49f44d456100cdfdb0c5`. The merge preserved the
search and linking authorization paths and MCP tools while adding webhook
subscription routes, MCP operations, contracts, and migration
`0010_webhook_subscriptions`. The shared realtime expiry-filter assertion was
kept once; it is the same test-only cleanup correction also present in #17.

Aggregate focused webhook/auth/schema/search/realtime verification passed 5
files/54 tests, control-plane TypeScript plus both Vite builds passed, and
pinned `scripts/check` passed 255 files. The worker reported 43 files/597
Worker tests, realtime 16, migration 20, TypeScript/build, and its repository
check passing. `credential_ref` remains opaque deployment metadata; later
delivery work must resolve it with owner-scoped authorization. No live webhook
delivery or production deployment is claimed.

## #15 bounded hold and #19 active checkpoint

History worker #15 is active on `codex/implement-history-15` from aggregate
`87695a5`, with conditional migration `0011_history`. Review found that the
current progress prematurely terminates whole imports at a range boundary,
does not yet implement the gateway history endpoints, and may truncate total
coverage through the per-batch `max_events` budget. The worker must address
those findings with evidence before integration.

Durable acceptance #18 worker commit `0933839ad6eee1ceb630253665ac9a1e420a0c85`
was merged serially as aggregate `d7dee32db7d5f718252e545c761d0ede31413b48`.
The worker reported 42 files/598 tests passing, and the aggregate focused
acceptance/OAuth/MCP/search/webhook/projection/schema run passed 9 files/99
tests. Aggregate TypeScript, both Vite builds, `scripts/check` (257 files),
and `git diff --check` pass. The focused log includes the same expected
negative-path projection diagnostics seen in earlier worker suites; Vitest
reported no failed assertions and exited 0. This evidence covers the
implemented durable acceptance boundary; live provider delivery and real
account proof remain outside this local merge.

Worker #19 is active at `/tmp/communicator-implementation/worker-19/0000-communicator`
on `codex/implement-offline-19` from aggregate `d7dee32`. Its first bounded
checkpoint covers offline confirmation, cancel, and administrator scope under
a controlled clock. The checkpoint is pending and is not an acceptance claim;
#20 follows only after a verified #19 merge because it shares the lifecycle.

## #25 atomic cutover follow-up evidence

Independent review found that the initial webhook cutover path read the current
version and then wrote `version + 1` without serialization. Concurrent
cutovers could therefore assign the same version to different destinations.
Follow-up commit `008ddfc49ae6f98774524925541a43c63b9b445e` was merged as
aggregate `f9a2290534728feb2629ce2461dfe8d80f57fd7b`. The focused aggregate
webhook regression passes 5/5, including unique concurrent versions, same-key
idempotent retry, atomic audit/outbox behavior, and revoke guards. The
control-plane TypeScript/Vite check and pinned `scripts/check` 255-file gate
also pass. Credential metadata remains opaque and later delivery remains
owner-scoped work; no live delivery or deployment is claimed.
