# 03 Recover and manage webhook delivery

## What to build

Complete webhook management and targeted recovery after automatic retries and endpoint health reporting are available. Add explicit disable, re-enable, secret rotation, and manual redelivery through the human Notifications panel and documented HTTP and CLI interfaces. Preserve the account-free room capability model and make the operations behave the same across all three surfaces.

Manual redelivery targets one failed event while its original message and delivery record remain available. It uses the original event identity so receivers can deduplicate it. Re-enabling a disabled endpoint starts with new messages and does not replay an automatic backlog.

## Acceptance criteria

- [ ] A room holder can explicitly disable and re-enable any endpoint through the panel, HTTP, and CLI. Disabling cancels pending attempts. Re-enabling receives new messages only and does not replay events that accumulated while disabled.
- [ ] A room holder can rotate an endpoint's secret through all three surfaces. The new secret is revealed only as the rotation result; list and status views do not reveal it.
- [ ] A room holder can request redelivery for an individually selected failed event only while its original message and delivery record still exist. The notification retains the original event identity and is signed for delivery with the endpoint's active secret.
- [ ] Manual redelivery does not create an automatic backlog or a second logical event. Duplicate delivery remains possible.
- [ ] The panel, HTTP, and CLI present consistent endpoint state, last success, last failure, recovery, and the outcome of manual redelivery.
- [ ] Integration tests exercise explicit disable, pending cancellation, re-enable with no backlog, secret rotation and reveal-once behavior, and retained-event redelivery through the approved fake transport and controllable clock/alarm. Thin panel and CLI tests cover the same operations.
- [ ] Redelivery is rejected when the source message or delivery record is no longer retained. Room expiry and deletion remove endpoint configuration, pending work, and history.

## Blocked by

[02 Retry failed deliveries and disable unhealthy destinations (#26)](https://github.com/0000-chat/0000-full/issues/26).

## Parent

[Room Notifications spec](https://github.com/0000-chat/0000-full/issues/24)

