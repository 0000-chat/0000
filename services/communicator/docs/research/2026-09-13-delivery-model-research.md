# Delivery model research

Research date: 2026-09-13. Scope: area 1, durable outgoing commands; area 2,
independent webhook subscriptions. This note records evidence and proposed
models for review. It does not choose the unresolved product or credential
decisions.

## Constraints from the agreed scope and current code

The agreed behavior saves an outgoing message before bridge dispatch, and the
saved record is not provider delivery. The four-hour outgoing confirmation
window, cancellation before dispatch, no blind resend after uncertain delivery,
and per-chat pause are recorded in the gap assessment, while the runtime state
is still missing ([product alignment](../product-alignment.md#L8),
[gap assessment](2026-09-13-built-vs-agreed-scope.md#L140)). Webhooks must be
independent per subscription, evaluate global/account/chat settings within that
subscription, retry for 24 hours, expose failure, and carry stable event IDs
([product alignment](../product-alignment.md#L48),
[product alignment](../product-alignment.md#L202)).

The repository has useful read-side seams. Canonical events already include
`command.updated` and `bridge.delivery.updated`, and the tenant projection has
`commands` and `message_delivery_updates` rows keyed by identity, account,
connection, and conversation ([canonical event contract](../../packages/contracts/src/canonical-event.ts#L173),
[projection schema](../../apps/control-plane/worker/projection/schema.ts#L212)).
The projector applies ordering by observed time and event ID, and reconciles a
delivery observation if it arrives before its message
([projector-control.ts](../../apps/control-plane/worker/projection/projector-control.ts#L117)).
These are projections, not a live outbound command store. The current command
contract only covers `message.send`; its statuses have no confirmation-required
or delivery-uncertain state ([command contract](../../packages/contracts/src/command.ts#L4)).

The existing D1 `control_event_outbox` has one delivery marker and attempt count
per event ([migration](../../apps/control-plane/migrations/0001_control_directory.sql#L130)).
That is a useful transactional-outbox pattern for control events, but it cannot
represent separate webhook status, destination version, or retry age for many
subscriptions. The Matrix room registry already preserves the ownership tuple
needed to route a reply: tenant, identity, connection, account, provider, and
conversation ([room binding](../../services/matrix-gateway/src/registry.rs#L24)).
The gateway is currently receive-only for room messages. It forbids
`RoomMessage` requests and permits only a receive-side keys query
([matrix policy](../../services/matrix-gateway/src/matrix.rs#L573)).

## Area 1: durable outgoing commands

Matrix gives Communicator a precise Matrix-hop reconciliation key. The
current Matrix specification says the client-generated transaction ID lets a
homeserver distinguish a retransmission, and a retransmission with the same ID
and endpoint returns the original response and event ID. The send endpoint
returns an `event_id`; the event stream can include the same transaction ID in
`unsigned` for remote-echo pairing ([Matrix Client-Server API](https://spec.matrix.org/latest/client-server-api/#transaction-identifiers),
[send endpoint](https://spec.matrix.org/latest/client-server-api/#put_matrixclientv3roomsroomidsendeventtypetxnid),
[remote echo](https://spec.matrix.org/latest/client-server-api/#local-echo)).
The key is scoped to one device and one HTTP endpoint. It does not establish
delivery through the later WhatsApp bridge.

The proposed command record should therefore separate these facts:

| State or record | Meaning |
| --- | --- |
| `accepted/saved` | The request passed authorization and idempotency checks; the outgoing message, command, and dispatch outbox row committed together. |
| `waiting_for_connection` | The explicit connected account has no usable bridge. The command waits; it never silently chooses another account. |
| `confirmation_required` | The four-hour age has elapsed without completion. Store the due time and immutable command age, require explicit user confirmation before dispatch continues, and append the reply timestamp, user identity, and confirmation or cancellation without deleting or resetting the original age. |
| `dispatching` | An internal lease, not proof of provider acceptance. The lease must expire and be safely reclaimable. |
| `delivery_uncertain` | The request may have reached Matrix or the bridge, but no definitive result exists. Pause new sends for that chat and do not create a new provider transaction. Reconcile the same Matrix transaction ID, the sync remote echo, or an explicit bridge status. |
| `matrix_confirmed` | Matrix returned an event ID or a matching remote echo. This confirms the Matrix hop only, not WhatsApp delivery. |
| `bridged` / `delivered` | Separate provider stages record bridge acceptance, provider message ID, and any later delivery evidence. They must not collapse into the Matrix confirmation. |
| `failed` / `cancelled` | Cancellation is allowed before dispatch and after revocation when no provider action was accepted. |

The write path should insert the command and local outgoing message in one
Durable Object transaction, then publish a wakeup. Cloudflare describes Durable
Object storage as private, strongly consistent, transactional, and serializable,
and recommends `transaction()` for atomic read/modify/write operations. It also
warns that external I/O such as `fetch()` can interleave with other requests
([DO storage](https://developers.cloudflare.com/durable-objects/best-practices/access-durable-objects-storage/),
[DO concurrency rules](https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/)).
The Matrix call must therefore happen outside the transaction, behind a
persisted compare-and-set lease and an authorization check immediately before
dispatch. A committed outbox row plus a sweeper alarm prevents a failed queue
send from losing the command.

The Matrix transaction ID should be stable for the command and exact endpoint,
with the request body digest stored beside it. A successful Matrix response
binds `matrix_event_id`; a timeout keeps the command uncertain and does not
generate a fresh transaction ID. A matching remote echo can reconcile the same
command. An uncertain command pauses new sends for that chat until an explicit
user action resolves it, and any retry must be an authorized reconciliation or
retry choice, never an automatic resend. The bridge must separately map that
event to its remote message ID and delivery state. Group creation has no
current command contract or verified provider idempotency behavior, so its
idempotency key and outcome reconciliation need a separate provider decision.
The `message.send` pattern should not be silently generalized to group
management.

Use a Durable Object alarm to move due commands into confirmation-required or to
retry a stale lease. Alarms are at-least-once and Cloudflare retries a failed
handler with exponential backoff, but one alarm has a finite retry budget. The
handler must re-read state, be idempotent, and record the immutable confirmation
age before changing status; a periodic sweep or separately re-scheduled alarm
must recover work after that budget is exhausted
([DO alarm API](https://developers.cloudflare.com/durable-objects/api/base/)).

## Area 2: independent webhook subscriptions

Treat a subscription definition and each event delivery as different records.
The definition needs `subscription_id`, creator, endpoint and credential
version, active or revoked status, and global/account/chat override rules. The
creator may manage that subscription within current grants; the owner or
administrator may manage all subscriptions. This ownership check is separate
from the subscription's per-account and per-chat event filter.
per-event row needs `delivery_id`, `subscription_id`, stable `event_id`, source
event/version, destination version, pending/leased/delivered/failed/cancelled
status, first-pending time, retry deadline, attempt count, next attempt, and
last response. The internal uniqueness key is `(subscription_id, event_id)`.
The receiver-facing event ID and delivery ID should remain stable across
retries; a separate attempt ID can identify each subscription-specific try.

When a newly saved incoming message commits, evaluate each active subscription
using chat override, then account override, then global setting. In the same
authoritative transaction, create the eligible delivery rows. Exclude imports,
own messages, and duplicate sync events. Queue messages are only wakeups for
those durable rows. Cloudflare documents guaranteed queue delivery and exposes
`max_retries`, `retry_delay`, per-message retry, and a dead-letter queue; a
consumer can acknowledge or retry each message ([Queues configuration](https://developers.cloudflare.com/workers/wrangler/configuration/),
[consumer retry example](https://developers.cloudflare.com/queues/tutorials/handle-rate-limits/)).
Those transport controls do not make the webhook HTTP call exactly once. The
worker must deduplicate by delivery ID and event ID, and a DLQ must preserve a
visible failed row rather than silently discard it.

Anchor the 24-hour deadline to `first_pending_at` or source-save time. Retries
must not reset that age. Before every HTTP call, recheck subscription status,
current grant, destination version, and the source message/tombstone. If content
was removed before delivery, cancel the pending row. If it was already sent,
create a removal event under the current destination rules and permissions. A
message edit should create an edit event only after the same current-setting
and permission check; it must not resurrect a disabled destination or replay a
backlog. The payload should be hydrated only after that check, or made
inaccessible when a
tombstone is committed, so a queued copy cannot leak removed content.

Changing a destination increments its version and cancels pending rows for the
old version in one transaction. New events use the new destination and do not
replay backlog. A request already in flight cannot be recalled; a late success
must be recorded as an old-version outcome and must not be retried to the old
endpoint. Revocation follows the same cancellation path, with an authorization
check immediately before send. If subscription ownership or grants live in D1
while delivery rows live in a DO, the revocation write and the worker's final
check are separate operations. Versioned snapshots and a durable handoff make
that race visible, but they cannot preempt a request already in flight. The
product must choose how to display an in-flight request whose response is
unknown after cutover or revocation.

## Tradeoffs and questions for the next design review

Co-locating the per-event command and webhook ledger with the tenant projection
gives atomic source-save plus fan-out and serializable per-tenant updates. It
can concentrate write load and makes cross-tenant subscription queries less
convenient. Keeping subscription definitions in D1 helps administration and
ownership queries, but a D1-to-DO handoff is not one transaction; it needs a
versioned rule snapshot and a durable handoff/replay ledger. The proposed
direction is to keep control ownership in D1 while committing the event’s
subscription delivery rows beside the message projection, with the handoff
itself observable and retryable.

The consequential choices still needing an explicit decision are:

1. Should the same four-hour rule apply to non-message commands such as group
   creation?
2. What provider evidence maps to `matrix_confirmed`, `bridged`, and
   `delivered`, and how should each transition preserve the agreed confirmation,
   cancellation, revocation, and no-blind-resend controls?
3. Should initial webhook payloads be snapshots at save time or current content
   at delivery time when an edit occurs before delivery? Are event IDs shared
   across subscriptions or only stable within each subscription?
4. What is the accepted outcome for an in-flight old-destination or revoked
   request that may already have reached the endpoint, and how should that
   uncertainty appear in the administrator UI?
5. What provider contract supplies idempotency and outcome lookup for group
   creation and other future commands?
