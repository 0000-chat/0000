---
repo: 0000-chat/0000
status: current
---

# MCP Events and OAuth

This is the self-hosting contract for Msg's MCP Events integration. It covers
the tested local Worker shape and the setup needed to verify it. It does not
describe a live deployment or a production route.

## Scope and authority

The integration watches explicitly selected Threads. A person who holds a
Thread URL grants an OAuth connection read, post, and monitor capabilities for
that Thread. The grant does not create a Msg account, and the URL alone does
not silently authorize a connection.

ChatGPT evaluates matching events under the connected user's monitoring
instructions and chooses a reply in the triggering Thread, a notification
through the ChatGPT monitoring task, or silence. Msg supplies the event,
enforces the Thread grant, and validates response origin; it does not choose
the monitoring outcome.

## Self-host prerequisites

The Worker needs its existing ConversationRoom Durable Object and D1
operations database. Set `MSG_PUBLIC_ORIGIN` to the canonical HTTPS origin of
the Worker. The default Wrangler value is `https://msg.0000.chat`; use the
self-hosted origin for a different installation. Set `MSG_DB` and the existing
`MSG_DATA_ENCRYPTION_KEY_V1` secret for the operations database. The existing
operator and VAPID settings remain required by the Wrangler configuration.

Apply the service migrations in order. The local migration set relevant to
this integration includes:

- `worker/migrations/0005_mcp_oauth.sql` for the MCP integration's public OAuth
  clients, authorization requests and codes, account-free principals,
  per-Thread grants, access tokens, rotating refresh-token families, and grant
  provenance.
- Its `grant_source` column records whether a grant was issued from a public
  Thread link or an explicit management/admin path. The current consent flow
  issues public-link grants.

OAuth and event signing values are high-entropy opaque values. The OAuth store
keeps hashes of bearer, authorization-code, and refresh-token values. A
subscriber supplies a `whsec_` callback signing secret; Msg stores and uses it
for signed challenge and event delivery.

Cloudflare workerd cannot safely provide the pinned DNS plus TLS socket
operation needed for an attacker-controlled callback URL. Msg therefore uses
the first-party self-hostable dispatcher in
[`scripts/mcp-webhook-dispatcher.ts`](../../scripts/mcp-webhook-dispatcher.ts).
The Worker sends only to the administrator-configured dispatcher URL, with a
bearer token and a bounded relay envelope. The dispatcher resolves every DNS
answer, rejects a mixed or private result, connects to a validated public
address while retaining the original hostname for TLS, rejects redirects, and
applies bounded request, response, header, concurrency, rate, and timeout
limits. The dispatcher has no Msg account or hosted dependency.

Set the same high-entropy token in the Worker and dispatcher. For a
self-hosted HTTPS dispatcher, provide the certificate and key files:

```sh
MSG_MCP_WEBHOOK_DISPATCH_TOKEN='replace-with-a-random-value' \
MSG_MCP_WEBHOOK_DISPATCH_HOST='0.0.0.0' \
MSG_MCP_WEBHOOK_DISPATCH_PORT='8787' \
MSG_MCP_WEBHOOK_DISPATCH_TLS_CERT_FILE='/etc/msg-dispatcher/fullchain.pem' \
MSG_MCP_WEBHOOK_DISPATCH_TLS_KEY_FILE='/etc/msg-dispatcher/privkey.pem' \
  bun scripts/mcp-webhook-dispatcher.ts
```

The script listens on `127.0.0.1:8787/dispatch` without TLS by default, which
is suitable only for local testing. A non-loopback listener requires both
`MSG_MCP_WEBHOOK_DISPATCH_TLS_CERT_FILE` and
`MSG_MCP_WEBHOOK_DISPATCH_TLS_KEY_FILE`; a self-hoster may use those files or
an HTTPS reverse proxy. Set `MSG_MCP_WEBHOOK_DISPATCH_URL` to the resulting
HTTPS URL, including `/dispatch`. The Worker client rejects an HTTP dispatcher
URL. Protect the endpoint with the same `MSG_MCP_WEBHOOK_DISPATCH_TOKEN`; do
not expose the local HTTP listener directly. If either Worker dispatcher
setting is missing, event subscriptions and delivery fail clearly while
ordinary OAuth-protected reads and posts remain available.

## OAuth endpoints

Let `{origin}` be `MSG_PUBLIC_ORIGIN`.

The OAuth metadata and authorization routes are available when `MSG_DB` is
configured. Without D1, the Worker does not have the durable OAuth store
required for protected MCP operations. Event subscriptions additionally
require both dispatcher settings above.

| Endpoint | Contract |
| --- | --- |
| `GET {origin}/.well-known/oauth-protected-resource` | Protected-resource metadata for `{origin}/mcp`, the authorization server, and `threads:*` scopes. |
| `GET {origin}/.well-known/oauth-authorization-server` | Authorization-server metadata, including registration, consent, token, and revocation endpoints. |
| `POST {origin}/register` | Registers a public client with HTTPS redirect URIs. |
| `GET/POST {origin}/authorize` | Creates and completes a PKCE S256 consent flow. The consent form accepts one or more active Thread URLs and selected capabilities. |
| `POST {origin}/token` | Exchanges an authorization code or rotates a refresh token for a one-hour access token. |
| `POST {origin}/revoke` | Revokes an access or refresh token and disconnects its principal and grants. |
| `POST {origin}/mcp` | Handles MCP JSON-RPC requests with a bearer access token for protected methods. |

The OAuth scopes are `threads:read`, `threads:post`, and
`threads:monitor`. A grant is checked against the requested canonical Thread
on every protected read, post, and subscription operation. Access tokens last
one hour; refresh tokens last 30 days and rotate. Reuse of a refresh token
revokes its family. An access-token expiry uses the normal refresh flow. A
revoked principal or Thread grant cannot recover retained events through the
public MCP surface and requires a new explicit grant.

When a Thread owner claims a room with `revoke_links: true`, new public-link
MCP grants are rejected and existing public-link subscriptions stop before
their next callback. An explicit management/admin grant, when established by
an authorized integration, remains governed by its own grant and is not
treated as a public link. MCP `create_room` remains account-free: its returned
management URL is the explicit owner capability; ordinary access can establish
an anonymous Platform guest later.

Client registration accepts JSON with `client_name` and `redirect_uris`.
Authorization requires `response_type=code`, the registered redirect URI,
the matching `{origin}/mcp` resource, a state value, and a PKCE S256 challenge.
The consent POST must name the selected Thread URLs and requested scopes. Msg
checks that each selected Thread is active and belongs to this service origin.

## MCP surface

`POST {origin}/mcp` accepts MCP JSON-RPC requests up to 256 KiB. The server
advertises MCP `2026-07-28`, `server/discover`, and the event methods
`events/list`, `events/subscribe`, and `events/unsubscribe`.

`initialize` echoes a supported client `protocolVersion`. Supported versions
are `2026-07-28` and the installed MCP SDK's versions, including `2024-11-05`,
`2025-03-26`, `2025-06-18`, and `2025-11-25`. A missing or unsupported version
falls back to `2026-07-28`. Subsequent requests accept the negotiated
`MCP-Protocol-Version` header. `server/discover` advertises the modern revision.
Tool definitions retain optional metadata and output schemas. For versions
before `2025-06-18`, tool results include the payload as JSON text so clients
that ignore `structuredContent` can still read it. A missing protocol header
uses the `2025-03-26` tool result format.

The protected tools are:

- `get_room_status` reads status and retention metadata for one selected
  Thread;
- `read_thread` reads retained messages and bounded Thread context;
- `read_message` reads one retained message in full;
- `post_message` posts under the existing Msg author, name-claim, idempotency,
  and retention rules.
- `post_response` posts an event-triggered reply and requires `room_url`,
  `content`, `author`, `client_message_id`, and the validated
  `response_context` from the delivered event. Its `name_password` is the
  existing room-local name-claim credential: retain the private value returned
  by the first successful post and send it again for later responses using the
  same claimed author/display name. It is never event content or a substitute
  for OAuth identity.

An event-triggered `post_response` carries `response_context` with the
`subscription_id` and `event_id` from the delivered event. Msg validates that
the context belongs to the authenticated principal and selected Thread,
stamps the persisted origin, suppresses only that subscription's own response,
and deduplicates retries by subscription and triggering event. Posting names,
client labels, retry IDs, and host metadata do not establish this binding.

Account-free native event access is also available to a caller that holds an
explicit Thread URL. Call `prepare_subscription` with that URL to receive a
private `subscription_key`; Msg stores only its hash in the Thread's Durable
Object. The key is required for anonymous `events/subscribe` and
`events/unsubscribe` operations. The public
`events/list` catalog advertises `message.created` without a grant key.
`read_thread`, `read_message`, and ordinary `post_message` calls remain
available from the explicit Thread URL; an event-triggered `post_response` or
response-context `post_message` uses the delivered response token and does not
require the preparation key. A missing or invalid subscription key is a
bounded MCP error without an OAuth challenge. An explicit invalid Bearer token
still follows the OAuth authentication path and fails there.

Each anonymous preparation creates an isolated per-Thread principal and grant.
It does not create a Msg account, share an IP identity, or authorize another
Thread. Active grants are bounded per Thread and expire with the Thread's
inactivity deadline or within 24 hours. A valid `events/subscribe` refresh
with the same unexpired key rolls the 24-hour grant window forward, subject to
the Thread deadline; expired or revoked keys cannot be revived. Preparing,
reading, and monitoring do not extend Thread retention.

For an anonymous event response, the delivered `response_context` includes an
event-scoped `response_token`. Send it unchanged with `post_response` or a
response-context `post_message`. The token is derived from server-only grant
material and the exact Thread, subscription, and event; it is not the
subscription key and cannot be reused in another Thread or event. Thread link
revocation, grant expiry, unsubscribe, and deletion stop delivery and
invalidate response authorization.

## `message.created` subscriptions

`events/subscribe` accepts `name: "message.created"`, arguments containing a
canonical `room_url` and, for an anonymous caller, its `subscription_key`, and
webhook delivery with `mode: "webhook"`, `url`, and `secret`. Callback URLs
must be HTTPS and resolve only to public addresses.
Msg sends a signed verification challenge before storing a subscription. The
callback must return the challenge in a successful JSON response.

The initial subscription is future-only when `cursor` is omitted. A reconnect
may supply the last cursor while the Thread grant remains valid. Subscriptions
last at most 24 hours and are renewed while the grant remains valid. A response
includes the subscription ID, refresh deadline, cursor, and a `truncated`
indicator. If retained history starts after the requested cursor, delivery
continues from the oldest retained event and `truncated` explicitly reports
the recovery gap. Subscription expiry pauses delivery until a still-authorized
refresh or reconnect; a valid grant may replay retained events from its cursor.
A revoked principal or Thread grant cannot renew through the public MCP
surface. A deleted or expired Thread stops delivery and removes its event
state; no retained replay resumes for that Thread.

The service allows at most 32 active subscriptions for a Thread and at most 8
active subscriptions for one principal on that Thread. Refreshing an existing
active subscription identity remains allowed when either limit is reached.
Expired or stopped delivery-attempt metadata is pruned independently. Msg
retains the canonical subscription identity while retained messages still
reference its watcher origin or response-deduplication record, so expiry and
reconnect do not lose own-response suppression or duplicate-response handling.

Renewal may rotate the callback signing secret. The prior secret remains
accepted for five minutes so an in-flight delivery can complete.

Each delivered event has a stable `eventId`, event name, timestamp, cursor,
Thread/message references, Msg author label, and a UTF-8 bounded preview of at
most 512 bytes. The delivered event data also carries the validated
`response_context`; anonymous contexts additionally include `response_token`.
Use `read_thread` or `read_message` for full content and surrounding context.

Delivery uses the standard webhook headers `webhook-id`,
`webhook-timestamp`, and `webhook-signature`. The signature is
`v1,<base64-HMAC-SHA256>` over `{webhook-id}.{webhook-timestamp}.{body}`.
Callbacks have a 10-second delivery timeout and retry for up to 24 hours with
bounded backoff. A callback response must be successful for the delivery to
advance its cursor; redirects are returned as failures and are never followed.

Monitoring and reads do not extend Thread retention. Posts follow the existing
Msg posting and retention rules. Explicit revocation stops delivery and
prevents public renewal; subscription expiry pauses delivery until a valid
refresh or reconnect. Thread deletion stops delivery and clears the associated
subscription state.

## Local verification

From this service directory, generate Worker types and run the focused MCP
coverage before using a self-hosted endpoint:

```sh
bun run wrangler:types
cd worker
bun test src/mcp-auth.test.ts src/mcp.test.ts src/mcp-webhook-dispatcher-client.test.ts src/mcp-webhook-transport.test.ts
bun test src/conversation-room.test.ts -t MCP
cd ..
bun test scripts/mcp-webhook-dispatcher.test.ts
```

The service check includes the Worker typecheck, lint, tests, and UI build:

```sh
bun run check
```

Use a local HTTPS callback that resolves to a public test address for an
endpoint probe. Check metadata discovery, client registration, PKCE consent,
token exchange, `initialize`, event discovery, callback challenge, subscribe,
delivery, renewal, reconnect cursor recovery, revocation, and Thread cleanup.
Keep the public endpoint probe separate from local verification; this
documentation records no live deployment or cutover.

Run the full service check before deploying a self-hosted instance. This
contract documents local verification and setup; it makes no live deployment
or cutover claim.
