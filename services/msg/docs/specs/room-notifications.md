# Room Notifications

## Problem Statement

Room participants and agents need to learn about new messages without keeping a room open or running a listener. The room model has no user accounts: possession of the room URL grants access, and messages and author names are untrusted. Notifications must preserve that model while giving participants opt-in webhook and browser push delivery, useful delivery status, and clear limits around retries and room expiry.

## Solution

Add room-scoped webhook and browser push notifications. A room may have at most five webhook endpoints. Anyone holding the room URL may create, list, disable, remove, re-enable, or rotate the secret for any endpoint in that room; no separate account or endpoint owner is introduced.

Webhook registration begins with messages created after registration. This includes messages posted by the person or agent that registered the endpoint. Replaying an idempotent message POST does not create another notification event. Each event carries the full message payload, a stable event ID, the message UUID, message timestamp, room-local sequence, and only routing identifiers that do not grant room access. The service adds no room capability, capability URL, management token, or other access secret to the event envelope or routing metadata. Message content is delivered as authored and may itself contain sensitive text.

Webhook deliveries use HTTPS POST with the normal msg JSON representation. Each endpoint has a separate signing secret. Every request carries a signing timestamp and signature; the secret is shown only when the endpoint is created or its secret is rotated. Version one has no configurable custom authentication headers. Endpoint URLs containing embedded credentials are redacted in the management UI, and delivery URLs are never logged.

Message acceptance is independent of notification delivery. Delivery runs as durable background work, with the queue or alarm mechanism left to implementation. Attempts for each event use increasing delays and stop within 24 hours. Events are independent, have no ordering guarantee, and may be delivered more than once. A destination that has failed continuously for 24 hours is disabled. A successful delivery resets that continuous-failure period, so an old event exhausting its retry window does not by itself disable a destination that has since succeeded. Disabling stops pending attempts. Re-enabling starts with new messages and does not create an automatic backlog. A participant may explicitly request redelivery of a failed event while its original message and delivery record still exist.

Keep delivery history for up to seven days, bounded by room expiry or deletion. The history includes attempt counts, timestamps, status, and failure categories; it excludes response bodies, message content, secrets, and full request details. A human Notifications panel and documented HTTP and CLI interfaces provide the same room-scoped management operations: create, list, disable, remove, re-enable, rotate a secret, view delivery state, and manually redeliver an available failed event. All three surfaces show endpoint state, last success, last failure, and recovery. Agents use the documented HTTP and CLI interfaces without needing the human panel.

Browser push is opt-in for each room and browser or device, with explicit enrollment and the browser's permission. It can notify while the tab is closed. If push is unsupported or permission is denied, explain that state and how the user can change it where applicable. The user can unsubscribe the current browser or device from the room. The notification text is always “New message in msg”; it contains no message preview, and clicking it opens the room. Suppress an alert while that room is focused and for a post made by that browser. Collapse pending alerts for the same room. Push subscriptions have their own lifecycle: remove a subscription rejected as invalid by the push provider, do not count an offline device as a webhook failure, and retain an undelivered push for no more than 24 hours.

The browser's private source identity is an origin-local UUID shared by tabs. Create it only during explicit enrollment, after permission and native push subscription acquisition succeed. Browser posts may send the existing UUID in `X-Msg-Browser-Id`; validate it at the Worker boundary and keep it out of public messages, webhook payloads, and push payloads. Enrollment and unsubscribe remain room-scoped. Removing one room association leaves the native `PushSubscription` intact for any other room that uses it. Accept the browser's native subscription serialization, including optional `expirationTime` (`null` or a non-negative integer), while storing only endpoint and key material.

The room expires after seven days without a new message. Only a message refreshes that inactivity period; notification settings and delivery work do not. Room deletion or expiry removes webhook configurations, push subscriptions, pending deliveries, and retained delivery history. A request already in flight may still complete, and content already delivered to an external receiver cannot be recalled. External receivers may retain the full message after the room expires.

## User Stories

1. As a room participant holding the room URL, I want to create a webhook in the human panel so that an external tool can react to future messages without polling.
2. As an agent holding the room URL, I want to create a webhook through documented HTTP and CLI operations so that I can configure delivery without using a browser.
3. As a room participant, I want to list all webhooks through the panel, HTTP, and CLI so that I can inspect the room's complete notification setup.
4. As a room participant, I want to disable any room webhook through the panel, HTTP, or CLI so that I can stop its pending and future automatic delivery.
5. As a room participant, I want to remove any room webhook through the panel, HTTP, or CLI so that an endpoint I no longer use is removed.
6. As a room participant, I want to re-enable a disabled webhook through the panel, HTTP, or CLI so that it can receive new messages again without replaying an automatic backlog.
7. As a webhook manager, I want to rotate an endpoint's secret through the panel, HTTP, or CLI so that I can replace a compromised or outdated secret.
8. As a webhook manager, I want to see a secret only when creating or rotating it so that the service does not expose stored signing credentials in routine views.
9. As a room participant, I want a maximum of five webhooks per room so that a room cannot accidentally create unlimited fan-out.
10. As the participant or agent registering a webhook, I want it to receive my own new messages too so that automation sees the same conversation as other participants.
11. As a webhook manager, I want registration to begin with future messages only so that existing conversation history is not sent as a surprise backlog.
12. As an agent retrying a message POST, I want an idempotent replay to produce no second notification event so that a transport retry does not repeat downstream work.
13. As a webhook receiver, I want the full message, stable event ID, message UUID, timestamp, room-local sequence, and safe routing identifiers so that I can process and deduplicate an event.
14. As a webhook receiver, I want service-generated event metadata to omit room capabilities and management tokens so that delivery does not grant my system unrelated room-management authority.
15. As a webhook receiver, I want a timestamp and signature made with the endpoint's separate secret on every request so that I can verify the sender and reject stale requests.
16. As an endpoint manager, I want HTTPS-only destinations and a normal msg JSON body without configurable custom authentication headers so that webhook setup has a clear, constrained contract.
17. As an endpoint manager, I want embedded URL credentials redacted in the panel and endpoint URLs excluded from logs so that credentials are not exposed during routine use.
18. As a room participant, I want message posting to succeed independently of webhook availability so that a notification outage does not interrupt the conversation.
19. As a webhook receiver, I want retry attempts for a failed event to use increasing delays for no more than 24 hours so that temporary failures can recover without creating unbounded work.
20. As a webhook receiver, I want events delivered independently with possible duplicates and no ordering promise so that I can design for the actual delivery guarantees.
21. As a webhook manager, I want a destination disabled only after 24 hours of continuous delivery failure so that a single expired event does not disable a destination that is succeeding on newer events.
22. As a webhook manager, I want a successful delivery to reset the continuous-failure period so that a recovered endpoint remains enabled.
23. As a webhook manager, I want disabling to stop pending attempts and re-enabling to start with new messages only so that stale queued work does not create a backlog.
24. As a webhook manager, I want to request one failed event's redelivery while its message and delivery record still exist so that I can recover a specific event deliberately.
25. As a room participant, I want up to seven days of delivery metadata showing attempt counts, timestamps, status, and failure categories so that I can diagnose recent outcomes without retaining message bodies or response bodies.
26. As a room participant, I want to see last success, failure, and recovery in the Notifications panel so that I can quickly understand endpoint health.
27. As an agent, I want the same management operations and delivery status through documented HTTP and CLI interfaces so that I can set up and monitor webhooks without the human panel.
28. As a browser user, I want to enroll a browser or device for one room with explicit permission so that I control where that room's push alerts appear.
29. As a browser user, I want an explanation when push is unsupported or permission is denied so that I understand why enrollment is unavailable and what I can do.
30. As a browser user, I want to unsubscribe the current browser or device from a room so that I can stop its room-specific push alerts.
31. As a browser user, I want a generic “New message in msg” alert with no preview so that room content does not appear on a lock screen.
32. As a browser user, I want clicking a push alert to open its room so that I can return directly to the conversation.
33. As a browser user, I want push suppressed while that room is focused and for a message posted by my browser so that active participation does not produce redundant alerts.
34. As a browser user, I want pending alerts for one room collapsed and undelivered pushes limited to 24 hours so that a quiet or offline device is not flooded later.
35. As a browser user, I want an invalid push subscription removed and an offline device kept separate from webhook failure state so that one delivery channel does not misreport another.
36. As a room participant, I want only new messages to refresh the seven-day inactivity expiry so that notification setup and delivery do not keep an unused room alive.
37. As a room participant, I want webhook configurations, push subscriptions, pending deliveries, and delivery history removed when the room expires or is deleted so that notification state follows the room's lifetime.

## Implementation Decisions

- Use the room capability as the sole authority for webhook management. Do not introduce user accounts or endpoint ownership.
- Limit webhook endpoints to five per room. Give every endpoint an independent signing secret, revealed only at creation and rotation.
- Emit events only for messages created after registration. Include the registering participant's own posts and suppress duplicate events for idempotent post replays.
- Send HTTPS requests using the standard msg JSON message shape, with a timestamp and signature on every webhook request. Do not provide user-configurable custom authentication headers in version one.
- Keep message acceptance separate from delivery and use durable asynchronous work. The concrete queue or alarm mechanism is an implementation detail.
- Retry each webhook event with increasing delays for at most 24 hours. Do not promise event ordering or exactly-once delivery. Disable an endpoint after 24 hours of continuous destination failure; a successful delivery resets that period. Disabling cancels pending attempts. Re-enabling does not replay a backlog; redelivery is an explicit action for a still-retained failed event.
- Keep only delivery metadata for up to seven days and within the room's lifetime. Do not store response bodies or log message content, endpoint URLs, capability values, tokens, signatures, or secrets.
- Expose create, list, disable, remove, re-enable, secret rotation, status, and manual-redelivery operations through the human panel and documented HTTP and CLI interfaces.
- Require explicit per-room, per-browser or device push enrollment and browser permission. Keep push independent from webhook failure accounting; use generic, preview-free alerts, focus and own-post suppression, same-room collapse, and a 24-hour undelivered push limit.
- Suppress a push for the subscription whose private browser identity sourced the post before touching that subscription's pending work. A different new message replaces that subscription's pending or retrying row for the room; the replacement points to the new message and starts its own 24-hour deadline. An already-sending request may finish, but an older delivery cannot be retried or lease-recovered after a newer eligible delivery exists for that subscription. Replacement never resets an existing event's deadline, and the provider TTL is recomputed at the final send boundary after encryption.
- Use the room's nonsecret `notification_id` as the stable [RFC 8030 Topic](https://www.rfc-editor.org/rfc/rfc8030.html#section-5.4), encoded as its UUID without hyphens, so a push service replaces retained work only for the same subscription and room. Use the same room identifier in the service worker's stable notification tag to replace an alert already displayed on that device. At display time, any focused same-origin window client with the same room pathname suppresses the alert, independent of its `view` query or saved view preference.
- Room expiry is seven days after the last new message. Notification activity does not extend expiry. Expiry and deletion remove push subscriptions and cancel pending work, while acknowledging that already in-flight requests may finish.
- Treat authors as self-declared and content as untrusted. Notification consumers must prevent feedback loops when their own actions create room messages.

## Testing Decisions

**Approved testing boundary:** The primary boundary is Worker HTTP exercised through the existing Miniflare fixture with real Durable Object persistence, a controllable fake outbound webhook and push transport, and a controllable clock/alarm. Existing Miniflare coverage already exercises persistence across restarts, idempotent posts, and expiry alarms; this seam extends that coverage without choosing a production queue or alarm design.

The Worker behavior tests should assert the observable management contract across create, list, disable, remove, re-enable, secret rotation, status, and manual redelivery; the five-endpoint cap; registration boundaries; full payload and signature verification; and the absence of service-generated room capabilities and management tokens from the event envelope, routing metadata, and logs. Verify that authored message content is preserved as the full payload. Exercise durable state across restarts, independent event delivery, increasing retry delays, duplicate and out-of-order outcomes, pending cancellation, and room deletion or expiry. Include a regression where a newer successful delivery resets a destination's failure period even though an older event later exhausts its retry window. Verify that recovery does not send an automatic backlog after re-enabling.

Use CLI tests through the existing `runCli` injectable fetch and output dependencies for the documented agent management and status operations. Use browser controller tests, which already support injected sockets and scheduling, for permissions, unsupported or denied states, subscribe and unsubscribe, focused-room suppression, own-browser-post suppression, and alert collapse. Add a real-browser smoke test for closed-tab push and click-through behavior, since controller tests cannot establish service-worker delivery in a closed tab. Run the service check before handoff.

## Out of Scope

- User accounts or cross-room notification preferences.
- Native Slack, Discord, or other provider-specific adapters.
- Backfilling notifications for messages posted before endpoint registration.
- Guaranteed delivery, exactly-once delivery, or ordering across events.
- Automatic backlog delivery after re-enabling an endpoint.
- Configurable custom authentication headers in version one.
- Recalling content already accepted by an external receiver after room expiry or deletion.
- Changes to the old source repository, deployment workflow, production route, or production cutover.

## Further Notes

Message authors are unverified and message content is untrusted. Receivers should avoid treating a notification as trusted instructions and should prevent their own notification-triggered posts from causing feedback loops. The service cannot determine what an external receiver retains after delivery.

The exact retry delays, signature format, status vocabulary, and HTTP/CLI operation shapes remain implementation details. They must preserve the behavior and security boundaries in this specification without adding room or management capabilities to webhook event envelopes or logs. Authored message content remains unmodified.
