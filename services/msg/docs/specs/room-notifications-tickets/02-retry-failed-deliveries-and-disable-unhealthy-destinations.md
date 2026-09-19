# 02 Retry failed deliveries and disable unhealthy destinations

## What to build

Add webhook retry policy, destination health tracking, and delivery history to the initial signed-delivery flow. Keep retry state independent for each event. Do not add manual redelivery or explicit manual disable and re-enable controls in this slice; those arrive in the recovery slice.

Show delivery attempts, last success, last failure, current endpoint state, recovery, and failure categories through the Notifications panel and documented HTTP and CLI views. Retain this metadata for up to seven days, bounded by room expiry or deletion. Never retain response bodies or log message content, secrets, signatures, or full request data.

## Acceptance criteria

- [ ] Each failed event retries with increasing delays for no more than 24 hours. Events are processed independently; duplicates are possible and ordering is not guaranteed.
- [ ] A destination is automatically disabled only after 24 hours of continuous delivery failure. A successful delivery resets that failure period. Expiration of an older event does not disable a destination after a newer event has succeeded.
- [ ] Automatic disable stops pending attempts for that destination. Room expiry and deletion also cancel pending attempts and remove retained notification metadata.
- [ ] The panel, HTTP, and CLI views report attempt counts, timestamps, status, failure categories, last success, last failure, and recovery without response bodies, message content, or secrets.
- [ ] Integration tests use the approved fake webhook transport and controllable clock/alarm to verify the retry window, increasing delay, duplicate and out-of-order outcomes, automatic disable, cancellation, recovery, and durable state across restart.
- [ ] Include the regression where a newer success resets continuous failure even though an older event later exhausts its retry window. Do not add a manual redelivery control in this slice.
- [ ] Thin panel and CLI tests show retry status and health consistently with the HTTP view.

## Blocked by

[01 Configure webhooks and receive signed new-message events (#25)](https://github.com/0000-chat/0000-full/issues/25).

## Parent

[Room Notifications spec](https://github.com/0000-chat/0000-full/issues/24)

