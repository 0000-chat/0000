# Reliable room coordination ticket graph

Spec: [0000-chat/0000-full#31](https://github.com/0000-chat/0000-full/issues/31)

Product repository: `0000-chat/0000`. Aggregate branch: `codex/msg-room-coordination`.

Current implementation is tracked in aggregate [PR #74](https://github.com/0000-chat/0000/pull/74). The ticket history below records the settled contract; final verification and review evidence are supplied by the parent integration task.

The approved tickets are published with native GitHub blocking relationships. Integration into the aggregate branch plus passing checks releases dependent preparation; issues remain open until the owning closure policy is met. No production deployment or default-branch merge is authorized.

| Slice | Ticket | Blocked by | Status |
| --- | --- | --- | --- |
| 1 | [#33 Clarify agent instructions and authorization](https://github.com/0000-chat/0000-full/issues/33) | None | Implemented in this PR |
| 2 | [#34 Read bounded pages without losing context](https://github.com/0000-chat/0000-full/issues/34) | None | Implemented in this PR |
| 3 | [#35 Look up cited messages and follow validated replies](https://github.com/0000-chat/0000-full/issues/35) | #34 | Implemented in this PR |
| 4 | [#36 Return consistent delivery receipts across posting methods](https://github.com/0000-chat/0000-full/issues/36) | None | Implemented in this PR |
| 5 | [#37 Detect stale replies before posting](https://github.com/0000-chat/0000-full/issues/37) | #34 | Implemented in this PR |
| 6 | [#38 Wait with a deadline and resumable cursor](https://github.com/0000-chat/0000-full/issues/38) | #34 | Implemented in this PR |
| 7 | [#39 Propose, review, and publish tracked requests](https://github.com/0000-chat/0000-full/issues/39) | None | Implemented in this PR |
| 8 | [#40 Report request progress and completion evidence](https://github.com/0000-chat/0000-full/issues/40) | #39 | Implemented in this PR |
| 9 | [#41 Maintain a compact room state panel](https://github.com/0000-chat/0000-full/issues/41) | #39 | Implemented in this PR |
| 10 | [#42 Record decisions with exact-revision approval evidence](https://github.com/0000-chat/0000-full/issues/42) | #35, #41 | Implemented in this PR |
| 11 | [#43 Correct, contest, and supersede shared decisions](https://github.com/0000-chat/0000-full/issues/43) | #42 | Implemented in this PR |
| 12 | [#44 Extend temporary retention without conversational activity](https://github.com/0000-chat/0000-full/issues/44) | None | Implemented in this PR |
| 13 | [#45 Export the complete coordination record](https://github.com/0000-chat/0000-full/issues/45) | #40, #43, #44 | Implemented in this PR |

## Historical baseline and integration evidence

- Aggregate base: `0000-chat/0000@90b0333` (current main when prepared). Includes room notifications.
- The original working copy was dirty and predates that main revision; its uncommitted files remained untouched during preparation. Delegated GET posting and cross-transport receipt parity are part of the aggregate implementation recorded by PR #74.
- Implementers used isolated worktrees; the parent serialized integration and tracker updates.
- The preparation validation command was `bun run check` from the msg service, including actual Worker/room routes and focused CLI/browser checks. Final ticket13 validation remains the parent handoff evidence.
