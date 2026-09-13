# Agent messaging aggregate plan

Snapshot: 2026-09-13 (Pacific/Auckland)

The aggregate branch is `codex/implement-agent-messaging` in
`/tmp/0000-communicator-aggregate`. It starts at migration/PR #6 head
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

From the canonical migration root (`/home/ubuntu/0000-full/repos/0000-communicator`),
`./scripts/check` passed with the pre-existing planning edits. Running the
same script from the required aggregate path reports `invalid product
metadata` because the script compares the metadata name `0000-communicator`
with the worktree directory name `0000-communicator-aggregate`; this is a
path-name check limitation, not a planning-file failure. `git diff --check`
passed for the aggregate baseline.
