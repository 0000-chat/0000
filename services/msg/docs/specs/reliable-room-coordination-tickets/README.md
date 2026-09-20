# Reliable room coordination ticket graph

Spec: [0000-chat/0000-full#31](https://github.com/0000-chat/0000-full/issues/31)

Product repository: `0000-chat/0000`. Aggregate branch: `codex/msg-room-coordination`.

The approved tickets are published with native GitHub blocking relationships. Integration into the aggregate branch plus passing checks releases dependent preparation; issues remain open until the owning closure policy is met. No production deployment or default-branch merge is authorized.

| Slice | Ticket | Blocked by | Status |
| --- | --- | --- | --- |
| 1 | [#33 Clarify agent instructions and authorization](https://github.com/0000-chat/0000-full/issues/33) | None | Pending |
| 2 | [#34 Read bounded pages without losing context](https://github.com/0000-chat/0000-full/issues/34) | None | Pending |
| 3 | [#35 Look up cited messages and follow validated replies](https://github.com/0000-chat/0000-full/issues/35) | #34 | Pending |
| 4 | [#36 Return consistent delivery receipts across posting methods](https://github.com/0000-chat/0000-full/issues/36) | None | Pending |
| 5 | [#37 Detect stale replies before posting](https://github.com/0000-chat/0000-full/issues/37) | #34 | Pending |
| 6 | [#38 Wait with a deadline and resumable cursor](https://github.com/0000-chat/0000-full/issues/38) | #34 | Pending |
| 7 | [#39 Propose, review, and publish tracked requests](https://github.com/0000-chat/0000-full/issues/39) | None | Pending |
| 8 | [#40 Report request progress and completion evidence](https://github.com/0000-chat/0000-full/issues/40) | #39 | Pending |
| 9 | [#41 Maintain a compact room state panel](https://github.com/0000-chat/0000-full/issues/41) | #39 | Pending |
| 10 | [#42 Record decisions with exact-revision approval evidence](https://github.com/0000-chat/0000-full/issues/42) | #35, #41 | Pending |
| 11 | [#43 Correct, contest, and supersede shared decisions](https://github.com/0000-chat/0000-full/issues/43) | #42 | Pending |
| 12 | [#44 Extend temporary retention without conversational activity](https://github.com/0000-chat/0000-full/issues/44) | None | Pending |
| 13 | [#45 Export the complete coordination record](https://github.com/0000-chat/0000-full/issues/45) | #40, #43, #44 | Pending |

## Baseline and integration evidence

- Aggregate base: `0000-chat/0000@90b0333` (current main when prepared). Includes room notifications.
- Original working copy is dirty and predates current main. Its uncommitted files remain untouched. Delegated GET posting exists there but is not yet in this clean base; slice 4 must reconcile that prerequisite before claiming cross-transport receipt parity.
- Implementers use isolated worktrees; the parent serializes integration and tracker updates.
- Shared validation: `bun run check` from the msg service, including actual Worker/room routes and focused CLI/browser checks.
