# Local realtime WebSocket runbook

This runbook covers local verification of the authenticated realtime ticket
endpoint and the hibernatable tenant projection WebSocket. REST remains the
authoritative source of conversation and message data. A WebSocket frame only
tells the client which authorized REST data may have changed.

This local runbook records the phase boundary: no production resource or
credential was created in this phase. Every domain, token, audience, account
identifier, D1 identifier, and ticket in this document is a placeholder. This
runbook intentionally contains no real domain, token, Access audience,
Cloudflare account ID, D1 database ID, or realtime ticket.

The projection can remain empty until milestone 11 enables live ingestion.
That is a valid local state. An empty projection does not prove that a
provider connection is disconnected.

## local prerequisites and setup

Run the commands from the repository root. The workspace requires Node `>=24
<27` and pnpm `10.14.0`.

```bash
node --version
pnpm --version
pnpm install --frozen-lockfile
pnpm --filter @communicator/control-plane exec wrangler --version
```

Use the checked-in local Worker bindings and test fixtures. Do not use
`--remote`, `wrangler dev --remote`, `wrangler deploy`, a staging or
production environment command, or a remote Cloudflare command.

The local browser command for simulated mode is:

```bash
cd apps/control-plane
VITE_DEPLOYMENT_ENV=local VITE_DATA_MODE=simulated pnpm vite --host 127.0.0.1 --port 4173
```

The local Worker test path uses the same route and Durable Object code without
an external service, live provider traffic, or a real credential.

## Apply the D1 migrations in order

Apply the checked-in D1 migrations in this order. Wrangler reads
`apps/control-plane/migrations` from the checked-in Worker configuration and
applies every pending SQL file in numeric filename order.
The first four files create the control directory, ingestion metadata,
connection read metadata, and realtime tickets. The command below applies the
full directory, including the current authority and lifecycle migrations.

Run the migrations against the local `CONTROL_DB` binding:

```bash
pnpm --filter @communicator/control-plane exec wrangler d1 migrations apply CONTROL_DB --local
pnpm --filter @communicator/control-plane exec wrangler d1 migrations list CONTROL_DB --local
```

The second command should show no pending local migration. Do not pass a D1
database identifier. The migration stores `ticket_digest`, tenant and
principal references, bounded subscription and resume JSON, and timestamps. It
does not store a raw ticket, ticket URL, token, or URL column. The raw ticket
exists only in the ticket response and the one upgrade request.

The projection Durable Object has its own SQLite migration history. Its schema
migrations run in version order when the object starts. Version 1 is followed
by version 2, `identity_local_projection_sequences`. Do not add a D1 migration
to change the Durable Object schema.

## Simulated and live behavior

Simulated mode is the browser path selected with `VITE_DATA_MODE=simulated`.
It produces synthetic events through the simulated realtime client and uses
no ticket, WebSocket upgrade, tenant data, or external authentication. Use it
to inspect the UI cache invalidation seam and identity selection.

For live mode, use the local Hono routes, D1 ticket repository, Durable Object
upgrade, hibernation callbacks, and local projection fixtures. It does not mean
live Matrix ingestion or live provider traffic. Run the focused Worker tests
for the live route:

```bash
pnpm --filter @communicator/control-plane exec vitest run --config vitest.worker.config.ts worker/test/realtime/api.test.ts worker/test/realtime/socket.test.ts worker/test/realtime/telemetry.test.ts
```

Tests inject an authorization verifier and synthetic directory rows. They do
not create a product token or an Access assertion. Milestone 11 connects the
persistent Matrix adapter to the existing ingestion boundary. Until then, a
healthy live projection may have no conversation or message rows.

## Request a ticket and upgrade locally

The ticket request is an authenticated HTTPS request. The Worker derives the
tenant, principal, membership, identities, and `conversation.read` grants from
the resolved session. The client does not submit tenant, principal,
membership, or internal projection authorization.

Use placeholders in a local test transcript. Do not paste a credential or a
real ticket into this runbook, a shell history, a URL, or a log.

```http
POST /api/v1/realtime/tickets HTTP/1.1
Host: <local-api-host>
Authorization: Bearer <product-oidc-token>
Content-Type: application/json

{
  "schema_version": 1,
  "subscriptions": [
    {
      "identity_id": "<authorized-identity-id>",
      "families": ["projection"]
    }
  ],
  "resume": [
    {
      "identity_id": "<authorized-identity-id>",
      "generation": 1,
      "after_sequence": 42
    }
  ]
}
```

The response is `201` with no-store headers. The ticket and URL below are
placeholders, not usable credentials:

```json
{
  "schema_version": 1,
  "ticket": "rt1_<base64url-ticket-body>",
  "expires_at": "<rfc3339-expiry>",
  "websocket_url": "wss://<backoffice-host>/api/v1/realtime?ticket=rt1_<base64url-ticket-body>"
}
```

The ticket body contains 32 random bytes encoded as base64url. It expires
after 30 seconds and is consumed by one conditional D1 delete. D1 stores only
the SHA-256 digest. A rejected, expired, or failed upgrade needs a new ticket.

The upgrade request must be a GET with exactly one `ticket` query parameter,
`Upgrade: websocket`, and the `communicator.realtime.v1` subprotocol. The
Worker removes the ticket before it forwards a server-generated internal
context to the tenant projection object. The client never sends a tenant ID or
an identity list in the upgrade URL.

```http
GET /api/v1/realtime?ticket=rt1_<base64url-ticket-body> HTTP/1.1
Host: <backoffice-host>
Connection: Upgrade
Upgrade: websocket
Sec-WebSocket-Protocol: communicator.realtime.v1
```

The negotiated subprotocol is exactly `communicator.realtime.v1`. The ticket
POST is authenticated and appears in OpenAPI. OpenAPI intentionally excludes `GET /api/v1/realtime`
because the runtime `101 Switching Protocols` upgrade cannot be represented by
the generated response model. The plain GET route is still registered and is
documented by this runbook.

## Server frames

All JSON server frames use `schema_version: 1`. The values in these examples
are placeholders unless a local test replaces them with fixture values.

### Connected frame

The first frame reports one position for every subscribed identity:

```json
{
  "schema_version": 1,
  "type": "connected",
  "tenant_id": "<tenant-id>",
  "positions": [
    {
      "identity_id": "<identity-id>",
      "generation": 1,
      "sequence": 42
    }
  ],
  "connection_expires_at": "<rfc3339-lease-expiry>"
}
```

### Projection changes frame

The server sends only projection metadata. One frame contains at most 100
contiguous changes for one identity:

```json
{
  "schema_version": 1,
  "type": "projection.changes",
  "tenant_id": "<tenant-id>",
  "identity_id": "<identity-id>",
  "generation": 1,
  "from_sequence": 43,
  "to_sequence": 44,
  "changes": [
    {
      "sequence": 43,
      "event_type": "message.created",
      "connection_id": "<connection-id>",
      "conversation_id": "<conversation-id>",
      "occurred_at": "<rfc3339-time>"
    }
  ]
}
```

The frame contains no event ID, message body, preview, participant name,
Matrix identifier, provider identifier, ticket, or storage identifier. The
client invalidates or refetches the affected REST query after it accepts the
frame.

### Reset-required frame

The server sends this frame when the generation changed, retained history is
below the requested position, or replay would exceed 500 matching changes:

```json
{
  "schema_version": 1,
  "type": "reset_required",
  "tenant_id": "<tenant-id>",
  "identity_id": "<identity-id>",
  "generation": 2,
  "latest_sequence": 7,
  "reason": "generation_changed"
}
```

`reason` is `generation_changed`, `history_unavailable`, or
`replay_too_large`. The client invalidates the REST queries for that identity,
uses the supplied generation and latest sequence as its new baseline, and
keeps the socket open. It does not replay across generations.

### Ping and pong

The literal text `ping` receives the literal text `pong` through the Durable
Object auto-response. These are text messages, not JSON frames:

```text
client -> ping
server -> pong
```

The auto-response works while the Durable Object is hibernated and does not
wake the object. The client must not send commands or change subscriptions.

### Error response example

Version 1 has no JSON `error` member in its strict server-frame union. The
following is the error frame example used in a diagnostic transcript only. It
is not sent after a successful WebSocket upgrade:

```json
{
  "schema_version": 1,
  "type": "error",
  "code": "invalid_request",
  "message": "Invalid request"
}
```

Before the upgrade, the actual bounded error response is an HTTP response:

```http
HTTP/1.1 400 Bad Request
Content-Type: application/json
Cache-Control: no-store

{
  "error": {
    "code": "invalid_request",
    "message": "Invalid request"
  }
}
```

After `101`, a protocol violation closes the socket with a generic close code
and reason. For example, a non-`ping` inbound message closes with code `1008`
and reason `unsupported realtime message`. The client must not treat a close
reason as an authorization or storage detail.

## Resume and reset rules

Store the latest accepted sequence separately for each subscribed identity and
with its generation. A client reconnects by requesting a new ticket and
including at most one `resume` position for each subscribed identity. It must
not reuse a consumed ticket or put a bearer credential in the WebSocket URL.

Public sequences are identity-local. Internal tenant ordering may coexist with
identity-local external resume positions. The storage Durable Object may keep
a tenant-global sequence for internal ordering, but the public protocol never
exposes that sequence or its gaps. A Human position cannot reveal Agent
activity, and an Agent position cannot reveal Human activity.

After a reconnect, the client accepts a change only when its identity and
generation match the stored position and its sequence is greater than the
stored sequence. It ignores a duplicate or repeated change at or below the
stored sequence. It advances the stored position only after processing the
frame and then refetches the affected REST data.

For `reset_required`, the client discards the affected identity's old cursor,
invalidates its REST queries, and records the supplied generation and
`latest_sequence`. It leaves other identity positions unchanged. A reset does
not close the socket. If a rebuild closes the socket with `1012`, reconnect
with a new ticket and the new generation baseline.

## Hibernation, leases, and limits

The tenant projection Durable Object uses the Hibernation API. Its constructor
configures `setWebSocketAutoResponse()` for `ping` and `pong`. The upgrade path
uses `acceptWebSocket()` on the Durable Object state, `getWebSockets()` for
restored sockets, and `serializeAttachment()` for the complete authorization
attachment. It implements `webSocketMessage`, `webSocketClose`,
`webSocketError`, and `alarm` handlers. It must not call the standard
`server.accept()` method and must not keep authorization in an in-memory socket
map.

The serialized attachment contains only the bounded tenant and principal IDs,
subscriptions, identity-local positions, lease expiry, and resume flag. The
application guard is 12,000 JSON bytes, below the Cloudflare attachment limit
of 16,384 bytes. A malformed attachment closes only its socket.

The ticket lasts 30 seconds. A connected socket has a 15-minute lease. The
Durable Object schedules the earliest lease alarm. An expired socket closes
with code `1000` and reason `realtime lease expired`; the client obtains a new
ticket to reconnect. Reconnection rechecks membership, identity status, and
scopes.

The locked pilot limits are:

| Resource | Limit |
| --- | ---: |
| Identities in one ticket | 16 |
| Changes in one `projection.changes` frame | 100 |
| Matching changes replayed per identity per connection | 500 |
| Concurrent sockets in one tenant | 256 |
| Concurrent sockets for one principal | 8 |
| Serialized attachment guard | 12,000 JSON bytes |
| Ticket lifetime | 30 seconds |
| Socket authorization lease | 15 minutes |

The platform auto-response request and response are each limited to 2,048
characters. The pilot limits are lower than the platform socket maximum.

## Generic errors and safe diagnostics

The public error vocabulary is intentionally small:

| Situation | Status and response |
| --- | --- |
| Bad method, header, subprotocol, query shape, or JSON | `400 invalid_request` |
| Missing, malformed, expired, consumed, or revoked ticket | `401 unauthenticated` |
| Identity or `conversation.read` authorization not found | `404 not_found` |
| D1, Durable Object, or capacity failure | `503 service_unavailable` |

Unauthorized, expired, consumed, malformed, and revoked tickets use the same
bounded `401` body. Do not retry a consumed ticket. Acquire a new one after
authentication or authorization changes. An invalid socket message closes
with `1008`. A rebuild closes current sockets with `1012`. These responses do
not include internal failure text.

Safe local diagnostics are limited to commands and fields that contain no
secret values:

```bash
python3 -m unittest tests.test_repository_contract -v
pnpm --filter @communicator/control-plane check
pnpm --filter @communicator/control-plane exec vitest run --config vitest.worker.config.ts worker/test/realtime/api.test.ts worker/test/realtime/socket.test.ts worker/test/realtime/telemetry.test.ts
git diff --check
```

Socket telemetry logs only schema-validated fields. Never log a raw ticket,
ticket URL, ticket digest, bearer credential, Access assertion, internal
context header, message body, preview, participant label, Matrix ID, remote ID,
or storage ID. Do not log request headers or serialized attachments. Error
responses and close reasons remain generic.

## Structured socket events and metric derivation

The Worker emits one structured event per subscribed identity. The event name
is `realtime.socket` and the closed outcome set is `accepted`, `resumed`,
`closed`, `lease_expired`, and `capacity_rejected`.

```json
{
  "schema_version": 1,
  "type": "realtime.socket",
  "outcome": "resumed",
  "tenant_id": "<tenant-id>",
  "identity_id": "<identity-id>",
  "active_tenant_socket_count": 1,
  "resumed": true,
  "timestamp": "<rfc3339-time>"
}
```

`active_tenant_socket_count` is the bounded count observed at the event. Use
the latest value for a tenant as the active-socket gauge. Do not sum events,
because a socket with multiple subscriptions produces one event per identity.
Count `realtime.socket` events by outcome for accepted, resumed, closed,
lease-expired, and capacity-rejected observations. Count `resumed` events for
reconnect demand, and compare accepted with resumed observations over the same
interval. Treat those counters as identity-subscription observations, not as
an exact socket count.

Telemetry contains no arbitrary labels and cannot carry credentials or message
content. A logging sink must accept only the schema-validated event shape.

## Cloudflare Access and deployment topology

Worker-level Cloudflare Access policies currently reject WebSocket upgrades.
For a future deployed backoffice, use a hostname-based Cloudflare Access application for the backoffice hostname. Do not rely on a Worker-level Access policy to protect the WebSocket handshake. Access is an outer same-origin gate; the product authorization middleware still resolves the tenant, membership, identity, and scopes.

The ticket POST advertises bearer security in OpenAPI. The Access assertion is
edge-injected and is not a client-supplied WebSocket header. The upgrade uses
only the short-lived ticket and the exact subprotocol. This local phase does
not configure an Access application, hostname, audience, account, D1 ID,
credential, or production route.
