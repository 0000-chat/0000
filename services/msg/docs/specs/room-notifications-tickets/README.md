# Room Notifications Ticket Breakdown

**Status: Published; five issues are ready for agent work.**

This breakdown maps every numbered user story in the Room Notifications spec to one or more demoable implementation slices.

| Ticket | Issue | Blocked by |
| --- | --- | --- |
| 01 Configure webhooks and receive signed new-message events | [#25](https://github.com/0000-chat/0000-full/issues/25) | None |
| 02 Retry failed deliveries and disable unhealthy destinations | [#26](https://github.com/0000-chat/0000-full/issues/26) | [#25](https://github.com/0000-chat/0000-full/issues/25) |
| 03 Recover and manage webhook delivery | [#27](https://github.com/0000-chat/0000-full/issues/27) | [#26](https://github.com/0000-chat/0000-full/issues/26) |
| 04 Subscribe to browser push for a room | [#28](https://github.com/0000-chat/0000-full/issues/28) | None |
| 05 Suppress redundant browser alerts | [#29](https://github.com/0000-chat/0000-full/issues/29) | [#28](https://github.com/0000-chat/0000-full/issues/28) |

## Story coverage

| Ticket | Covered source stories |
| --- | --- |
| 01 Configure webhooks and receive signed new-message events | 1–3, 5, 8 (secret reveal on creation), 9–18, 25 (initial delivery metadata), 27 (create/list/remove parity), 36–37 (room lifetime and webhook cleanup baseline) |
| 02 Retry failed deliveries and disable unhealthy destinations | 19–23 (automatic retry and health behavior), 25 (retry history), 26 (health and recovery status), 27 (status parity) |
| 03 Recover and manage webhook delivery | 4, 6–8 (manual controls and secret rotation), 23 (explicit disable/re-enable behavior), 24, 27 (full management parity) |
| 04 Subscribe to browser push for a room | 28–32, 34 (push delivery TTL), 35, 36–37 (push lifetime and cleanup) |
| 05 Suppress redundant browser alerts | 33–34 (focus, own-post suppression, and same-room collapse) |
