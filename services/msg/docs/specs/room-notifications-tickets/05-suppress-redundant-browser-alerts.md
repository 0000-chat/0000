# 05 Suppress redundant browser alerts

## What to build

Refine browser push behavior so active participants do not receive redundant alerts. Suppress a room alert when any tab for that room is focused in the same browser. Also suppress an alert for a post made by that browser, using browser-local source context rather than accounts or self-declared author names. Collapse pending push alerts for the same room while keeping different rooms and different browsers independent.

## Acceptance criteria

- [ ] If any tab in a browser has a particular room focused, that browser receives no push alert for that room. Focus in a different room does not suppress the alert.
- [ ] A post made from a browser is not pushed back to that same browser. Suppression does not rely on a user account, a global user identity, or an author label being verified.
- [ ] Pending alerts for the same room collapse into one visible alert. Alerts for separate rooms remain distinct, and one browser's focus or own post does not suppress another browser's alert.
- [ ] Tests cover multiple tabs focused on the same room, focus in another room, multiple rooms, multiple browser subscriptions, and same-browser posts. Use the existing browser controller scheduling seam and approved Worker fake-push boundary to verify the visible behavior in the human browser flow.

## Blocked by

[04 Subscribe to browser push for a room (#28)](https://github.com/0000-chat/0000-full/issues/28).

## Parent

[Room Notifications spec](https://github.com/0000-chat/0000-full/issues/24)
