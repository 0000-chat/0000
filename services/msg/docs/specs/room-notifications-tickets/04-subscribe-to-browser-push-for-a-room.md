# 04 Subscribe to browser push for a room

## What to build

Add opt-in Web Push enrollment per room and browser or device. Implement real browser-compatible signed and encrypted Web Push, choosing the protocol details during implementation. Enrollment requires an explicit user action and browser permission. Explain unsupported push and denied permission states, including how permission can be changed where applicable, and let the user unsubscribe the current browser or device from the room.

Deliver push asynchronously for new messages, including closed-tab delivery through the service worker. Display only “New message in msg”; include no message preview. Clicking the notification opens the room. A push subscription rejected as invalid by the provider is removed. An offline device is not counted as a webhook failure, and an undelivered push expires within 24 hours.

## Acceptance criteria

- [ ] A browser user can enroll this browser or device for one room, grant the required permission, and unsubscribe it later. Unsupported browsers and denied permission show an accurate explanation and available next step.
- [ ] The browser receives only messages posted after enrollment. An idempotent message replay creates no additional push event.
- [ ] A standards-compliant signed and encrypted Web Push message reaches the service worker with closed tabs. Its user-visible text is exactly “New message in msg”, contains no preview, and opens the associated room when clicked.
- [ ] Push delivery is asynchronous and durable for its bounded delivery window. Invalid provider subscriptions are removed; offline devices do not change webhook health; undelivered pushes expire within 24 hours.
- [ ] Room expiry or deletion removes its push subscriptions and pending push work and does not extend room life. Already in-flight push requests may complete.
- [ ] Worker integration tests use the approved fake push transport and controllable clock/alarm for enrollment, delivery, invalid-subscription cleanup, offline expiry, and room cleanup. Browser tests cover enrollment and unsubscribe. A real-browser smoke test verifies closed-tab delivery and click-through.

## Blocked by

None (can start immediately).

## Parent

[Room Notifications spec](https://github.com/0000-chat/0000-full/issues/24)
