# 01 Configure webhooks and receive signed new-message events

## What to build

Deliver the first usable webhook path: a room holder configures an HTTPS destination, posts a new message, and the receiver gets a signed notification. Room capability possession remains the sole authority; there are no accounts or endpoint owners.

Provide create, list, and remove operations through the human Notifications panel and documented HTTP and CLI interfaces. Enforce a maximum of five endpoints per room. Generate a separate signing secret per endpoint and reveal it only in the create result. Redact embedded URL credentials in the panel and keep destination URLs, message content, response bodies, capabilities, tokens, and secrets out of logs.

For messages created after registration, send the full message in the standard msg JSON representation over HTTPS, with a stable event ID, message UUID, message timestamp, room-local sequence, and only non-secret routing metadata. Preserve authored content as-is. Sign each request and include its timestamp. Do not add configurable custom authentication headers. Include the registering browser or agent's own new posts; an idempotent replay must not create a second event.

Keep message acceptance independent of delivery and schedule the first attempt as durable asynchronous work. Show initial delivery status and metadata history for up to seven days, bounded by room expiry or deletion. Room lifecycle cleanup in this slice removes webhook configuration, pending webhook deliveries, and delivery history. Push subscription cleanup belongs to the browser-push slice.

## Acceptance criteria

- [ ] A room holder can create, list, and remove an endpoint through the panel, HTTP, and CLI, with the same room capability controlling all three surfaces.
- [ ] The fifth endpoint can be created and a sixth is rejected. No endpoint owner or account is introduced.
- [ ] An endpoint receives messages posted after registration, including the registrant's posts. Existing messages are not sent. Replaying the same idempotent post produces no additional event.
- [ ] Posting succeeds independently of receiver availability. The initial delivery is durable across Worker or Durable Object restart and is dispatched asynchronously.
- [ ] The receiver gets the unchanged full message payload, stable event ID, message UUID, timestamp, room-local sequence, and safe routing metadata. The service adds no room or management capability to the event envelope or metadata.
- [ ] Requests use HTTPS, the normal msg JSON representation, an endpoint-specific secret, a timestamp, and a verifiable signature. The secret is revealed only by endpoint creation. No user-configured auth headers are available.
- [ ] The panel redacts embedded destination credentials. Logs and retained delivery history contain no message content, response bodies, full destination URLs, capabilities, tokens, signatures, or secrets.
- [ ] Initial attempt status and metadata remain visible for up to seven days, bounded by room expiry or deletion.
- [ ] Room expiry and deletion remove webhook configuration, pending webhook deliveries, and delivery history without extending room life. Already in-flight requests may finish.
- [ ] Worker HTTP integration tests use the approved Miniflare boundary with real Durable Object persistence, fake outbound delivery, and controllable time/alarm to prove initial dispatch across restart, idempotency, registration boundaries, and cleanup. Thin panel and CLI tests cover create, list, and remove.

## Blocked by

None (can start immediately).

## Parent

[Room Notifications spec](https://github.com/0000-chat/0000-full/issues/24)

