# Agent messaging aggregate plan

Snapshot: 2026-09-13 (Pacific/Auckland)

The aggregate branch is `codex/implement-agent-messaging` in
`/tmp/communicator-implementation/aggregate/0000-communicator`. It starts at migration/PR #6 head
`0a9455de0b4569fa63ee755888b0f7abb2fe67ea`. The approved planning baseline is
`9d6684eac906de7a2024d397dc1057edc32f4795`, which copies only the planning
paths requested by the implementation session.

The implementation target is issue #11 and its published child tickets #12
through #36, with existing #5 health and #9 runtime work included only when
their dependency gates are actually satisfied. PR #6 remains open from the
migration branch into `main`; the aggregate is based on that PR head so it
preserves the migrated application history and the PR's relationship to the
default branch. No default-branch merge, production deployment, live account,
or real-message acceptance is part of this aggregate task.

Execution authorization: the user explicitly resumed implementation of the
entire specification #11 ticket graph for this session. That instruction
overrides the earlier publication pause and the repository's one-ticket/session
planning note for this aggregate. Workers should execute the approved ticket
scope without re-requesting that authorization; live client/account proof and
deployment remain separately gated by the acceptance criteria below.

Architecture decision #7 is recorded in
[`decision-07-connection-status.md`](decision-07-connection-status.md). It is
an implementation direction, not a closed ticket: worker #15 must still make
the freshness policy concrete, and the actual pin API remains unverified.

## Dependency order

Workers should take one vertical ticket at a time and publish a branch and
commit for the merger. The merger integrates worker commits serially, records
the source branch and SHA, runs the narrowest relevant checks, then runs the
repository check when the worktree and disk state permit it.

1. Existing #5 health evidence gates #9 runtime work. Preserve the original
   dirty health worktree while the dedicated health worker proves its change.
2. T01 / #12 establishes account-scoped stored reads and administrator grants.
3. T02 / #13 establishes the shared API/MCP OAuth read authority.
4. T24 / #14 links WhatsApp accounts through the provider-neutral lifecycle.
5. T03 / #15 establishes capability and bounded history-import progress.
6. T04 / #16 and T05 / #17 add attachments and scoped search/context.
7. T06 / #18, T07 / #19, and T08 / #20 establish durable acceptance,
   offline confirmation, and uncertain-send recovery.
8. T09 / #21 adds WhatsApp text dispatch and evidence, followed by T10 / #22,
   T11 / #23, and T12 / #24 for contact and group operations.
9. T13 / #25, T14 / #26, and T15 / #27 add independent webhook configuration,
   delivery, retry, cutover, and manual retry.
10. T16 / #28 through T21 / #33 cover removal, revision events, receipts,
    archive purge, controlled retention, and safe restore.
11. T25 / #34 handles relink and explicit disconnect after the send recovery
    gates.
12. T22 / #35 is the ChatGPT Work proof gate; T23 / #36 is the Grok connector
    proof gate. Mocks may prove contracts, but these tickets remain open until
    their stated client/account evidence exists.

This order follows the published planning document and does not close,
rewrite, or assume completion of an existing issue. A worker may proceed in a
later wave only when its blocking contract is present in the aggregate or the
worker records a concrete blocked state.

## Current frontier checkpoint

T01/#12 feature behavior is accepted and integrated at aggregate commit
`c86c9b0`, with the focused grants/read/socket, UI, TypeScript/Vite, and
repository checks recorded in the worker ledger. Fresh default, async-leak,
and no-file-parallelism Worker diagnostics each exit 0 with 41 files and 591
passing tests. The earlier teardown is recorded as an observed Vitest 4.1.11
shutdown nondeterminism risk under final-validation monitoring; it is not an
active #12 feature blocker and does not block independent child contracts.

T02/#13 is integrated at aggregate commit `83a6c3f` after the worker's
full-suite, packaging dry-run, and aggregate focused checks passed. T24/#14 is
integrated as aggregate commit `87695a5d` from clean worker commit
`7fde338`; the linking UI/backend, pinned provisioning path, and lifecycle
guards passed their focused evidence. Delayed-D1 injection coverage remains
limited, and real phone/deployment proof is intentionally not claimed. T05/#17
search is integrated as aggregate commit `9de7a756` from clean worker commit
`52e161d`; its focused compatibility and repository checks pass. T13/#25
webhook configuration is integrated as aggregate commit `b42ff168` from clean
worker commit `145a120`; its focused webhook/auth/schema/search/realtime checks
and repository gates pass. The verified atomic cutover follow-up is now
integrated as aggregate commit `f9a22905`, with focused webhook 5/5,
control-plane, and repository gates passing. T03/#15 is active from
`87695a5d` with review findings held, and #18 remains in a bounded phase. Do
not claim any child complete from dispatch alone.

Migration `0006_oauth` is integrated for #13, `0007_linking` for #14, and
`0010_webhook_subscriptions` for #25. #17 search required no new migration.
Reserve `0009_acceptance` only if #18 requires it; do not add migrations merely
to fill numbers. #15 owns conditional migration `0011_history` from its active
worker handoff.

The aggregate merge commit is `f9a2290534728feb2629ce2461dfe8d80f57fd7b`.
The #25 source worker was clean at `145a1206f98387efc1edb3c75b2572087ca553ef`,
with atomic cutover follow-up `008ddfc49ae6f98774524925541a43c63b9b445e`.
Aggregate webhook/auth/schema/search/realtime compatibility, the cutover
regression, control-plane TypeScript and both Vite builds, and the pinned
`scripts/check` gate pass. The draft PR remains work in progress; no
default-branch merge, production deployment, live webhook delivery, or live
account proof occurred. #15 history remains held for its range-termination,
gateway-endpoint, and total-coverage findings, and #18 remains held for its
final MCP/invalid/crash matrix.

## Merge and release rules

- Keep every worker in its own worktree and branch. Merge at most one worker
  branch into this aggregate at a time.
- Before each merge, capture branch SHA, status, diff, and relevant tests.
  Refuse to merge a dirty worker until the dirty state is explicitly part of
  the handoff; never discard it.
- Resolve conflicts in favor of the approved spec and preserved migration
  history, with a focused verification after each resolution.
- Preserve `/tmp/0000-communicator-health`, the oxlint worktree, and research
  worktrees unchanged. Do not clean shared caches or temporary state while the
  disk-pressure incident is unresolved.
- Never merge `main`, close issues, deploy production, pair a real account, or
  claim live ChatGPT/Grok acceptance from mocks.
- The eventual draft PR should target the repository's actual default branch
  and use a truthful work-in-progress body that references `Closes #11` and
  `Closes #12` through `#36`, plus `#5` and `#9` only when those tickets are
  included in the aggregate. Its body must explain the migration base and PR
  #6 relationship and state that no production deployment occurred.

## Validation baseline

From the canonical migration root
(`/home/ubuntu/0000-full/repos/0000-communicator`), `./scripts/check` passed
with the pre-existing planning edits. After relocating the clean aggregate to
`/tmp/communicator-implementation/aggregate/0000-communicator`, the same
`./scripts/check` passed there too; the basename now matches
`0000-product.json`. `git diff --check` passed for the aggregate baseline.

Recovery note: the bounded status sweep initially failed because `/tmp` was
full. The hypothesis was an inactive generated cache, so the intact 3.4 GB
`/tmp/cargo-target` tree was moved to
`/home/ubuntu/0000-full/repos/0000-communicator/node_modules/.cache/tmp-recovery/cargo-target`
and `/tmp/cargo-target` was symlinked to that location. `df` then reported
3.4 GB free on `/tmp` and sandboxed status/check commands worked again. No
source worktree, dirty branch, or root `.target-health/` cache was copied,
staged, or deleted.
