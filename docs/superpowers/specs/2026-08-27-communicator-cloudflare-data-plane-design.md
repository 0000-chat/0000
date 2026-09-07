# Communicator Product and Cloudflare Data Plane System Specification

**Status:** Approved system design; implementation planning follows this document

**Audience:** Communicator implementers, operators, security reviewers, and API
client developers

**Goal:** Provide a tenant-isolated, replayable, bidirectional messaging API over
the existing Synapse and mautrix deployment, with REST reads and commands,
WebSocket updates, account-linking lifecycle, a small backoffice, and a safe
extension boundary for future message-triggered automation.

## Simple explanation

Synapse and mautrix already move messages between Matrix and external networks.
The Cloudflare data plane turns that working messaging infrastructure into a
product API.

An application uses REST to retrieve conversations and issue commands. It uses
a WebSocket to receive live changes and command progress. It never needs to
know about Matrix room IDs, bridge databases, Durable Object bindings, or R2
object layouts.

```text
External application
    |-- REST reads and commands
    `-- WebSocket live updates
                 |
          Communicator API Worker
             /             \
 Tenant Projection DO   Identity Command DO
             |                 |
             |           Matrix Gateway
             |                 |
             `---------- Synapse / mautrix
```

The system is full duplex:

- users sign in to Communicator and receive only their authorized tenant and
  identity view;
- an identity can link one or more provider accounts through a guided,
  short-lived connection flow;
- inbound messages become queryable application state;
- outbound commands can send, edit, delete, react, mark read, and emit typing;
- direct delivery introduces no deliberate delay;
- paced delivery can mark read, wait, emit typing for a length-based duration,
  and then send; and
- later automation can quickly decide whether an inbound message requires a
  response or another permitted action.

Synapse remains the operational messaging system of record. Ordinary R2 holds
the replayable event archive. Durable Object SQLite contains rebuildable,
interactive projections and command state.

## Scope

The Cloudflare data plane includes:

- a canonical, versioned messaging-event envelope;
- a verified Matrix event consumer and bidirectional Matrix Gateway on the
  Contabo host;
- an authenticated Cloudflare ingestion endpoint;
- a small D1 control directory for tenant, principal, membership, identity
  scope, and non-secret connection-routing authority;
- Cloudflare Queues for asynchronous ingestion and failure isolation;
- a batched, compressed ordinary R2 event archive;
- one `TenantProjectionDO` per customer workspace;
- one `IdentityCommandDO` per sending identity;
- short-lived `LinkSessionDO` instances for remote-account pairing;
- a private Connection Gateway over mautrix provisioning interfaces;
- a versioned REST API;
- a resumable WebSocket event interface;
- a small protected backoffice that uses the same API as external clients;
- replay, export, deletion, and audit behavior; and
- an inactive extension seam for future message-triggered automation.

This design does not include:

- changes or forks to Synapse or mautrix source code;
- R2 Data Catalog or Cloudflare Pipelines;
- the separate Brain product or a Brain connector implementation;
- an LLM, autonomous response policy, automation-rule editor, or tool runtime;
- a polished customer-facing application;
- guaranteed support for an operation the remote network or active bridge does
  not support; or
- attachment bytes inside Durable Object SQLite.

Provider-specific challenge screens and brittle login details belong in each
provider implementation plan. This system design defines their shared product
contract, lifecycle, security boundary, and failure behavior.

## Ownership boundaries

```text
Synapse                    Operational Matrix history and messaging truth
mautrix                    Remote-network translation and account sessions
Matrix Gateway             E2EE-capable Matrix client, normalization, commands
Connection Gateway         Private normalization of mautrix account provisioning
D1 Control Directory       Authoritative product tenancy and authorization data
Cloudflare Queue           Retry, backpressure, and failure isolation
ordinary R2                Immutable or append-only replay batches and exports
TenantProjectionDO         Rebuildable tenant query projection and live events
IdentityCommandDO          Ordered outbound commands and paced-send scheduling
LinkSessionDO              Short-lived remote-account linking coordination
API Worker                 Authentication, authorization, validation, routing
Backoffice                 Reference client and operator test surface
```

The Cloudflare projection does not replace Matrix history. A message is not
considered confirmed application state merely because an API command was
accepted. The resulting Matrix event must return through normal ingestion.

## Tenant, principal, and identity model

A tenant is one customer workspace. A principal is an authenticated human,
service, or agent making API calls. An identity is the persona through which
messages are observed or sent. A connection binds one remote account on one
provider to exactly one identity. An identity may own multiple connections.

The pilot has one tenant with at least these identities:

```text
Pilot tenant
|-- Human identity
|   |-- Human WhatsApp account
|   |-- Human Telegram account
|   `-- Human Messenger account
`-- Agent identity
    `-- Agent WhatsApp account
```

Telegram, Messenger, and LinkedIn accounts can later attach to an authorized
identity without changing the tenant boundary.

Normal principals receive explicit identity scopes. The Human principal cannot
query or send through the Agent identity, and the Agent principal cannot query
or send through the Human identity. Platform-administrator break-glass access
must be explicit and audited. A Durable Object is not an authentication
boundary by itself; both the API Worker and DO methods must enforce the
authorized identity set supplied by trusted routing code.

The authorization hierarchy is:

```text
tenant
|-- memberships and roles
|-- principals
|   `-- explicit identity and operation scopes
`-- identities
    `-- zero or more provider connections
```

A remote account may not be silently reassigned between identities.
Reassignment is an audited workflow that stops pending commands, proves
authority over both identities, and explicitly chooses how existing projected
history is handled.

The D1 Control Directory is authoritative for tenants, principals,
memberships, roles, identity grants, and non-secret connection placement. The
tenant DO may project the identity and connection fields needed for queries,
but rebuilding message state from R2 does not create or grant product access.
This separation lets the API resolve an authenticated issuer/subject before it
routes to a tenant DO.

## High-level architecture

### Inbound and projection path

```text
Remote network
    -> mautrix
    -> encrypted Matrix room event
    -> verified Matrix Gateway
    -> authenticated ingestion Worker
    -> ordinary R2 data + committed manifest
    -> ingestion Queue (committed-archive pointer only)
    -> Queue consumer
    -> TenantProjectionDO
    -> REST queries + WebSocket events
```

The Matrix Gateway incrementally consumes authorized Matrix rooms, decrypts
events, maps them to tenant and identity ownership, normalizes one-tenant
projection-valid batches, and submits them to the private ingestion Worker. It
persists the stable archive timestamp, deterministic batch identity, and raw
Matrix checkpoint in a protected local outbox. The raw checkpoint advances only
after every batch for the sync response has received HTTP `202`; it is never
sent to Cloudflare.

The ingestion Worker validates the complete request before external writes,
commits canonical compressed event data to ordinary R2, and writes the
manifest as the immutable archive commit marker. Only after verifying that R2
pair does it send a strict small pointer to the ingestion Queue. Queue messages
carry no event body, Matrix ID, source token, or credential. This archive-first
ordering is required because the approved event batch can be up to 4 MiB while
Cloudflare Queue message bodies are limited to 128 KiB. The consumer reads and
verifies the exact R2 data/manifest pair, resolves trusted control-directory
ownership, and applies the tenant batch atomically. It acknowledges only after
that projection transaction commits. A `202` proves R2 commitment plus a
completed Queue send; a Queue acknowledgement proves verified R2 evidence plus
the committed tenant projection. Duplicate requests, lost responses, and lost
acknowledgements therefore produce safe retries rather than event loss.

The R2 source checkpoint is a one-way
`matrix_sync_token_sha256` digest. The tenant projection stores a separate
derived live-event watermark; neither Cloudflare record contains the raw Matrix
`/sync` token. The later Gateway owns E2EE devices, decryption keys, raw source
progress, and the fsynced local outbox. This design freezes that boundary and
does not add a Synapse client, gateway implementation, or bridge changes.

### Outbound command path

```text
External client
    -> API Worker
    -> IdentityCommandDO
    -> authenticated Matrix Gateway command endpoint
    -> Synapse
    -> mautrix
    -> remote network
```

The Matrix Gateway owns the verified Matrix sessions and encryption material
needed to act as the selected Matrix identity. Cloudflare does not store those
Matrix E2EE sessions in the pilot.

After a command reaches Matrix, its Matrix event returns through the inbound
path. That returned event updates the tenant projection and notifies clients.
This prevents phantom messages that exist only in Cloudflare.

### Authentication and account-linking path

```text
Communicator user
    -> authenticated API Worker
    -> short-lived LinkSessionDO
    -> private Connection Gateway on Contabo
    -> selected mautrix provisioning interface
    -> remote provider authentication
    -> bridge-owned session storage
```

The ordinary product never exposes a mautrix provisioning endpoint or shared
secret to a browser. The Connection Gateway presents one provider-neutral
contract to Cloudflare, resolves the correct bridge instance and Matrix
identity, and translates provider-specific steps into canonical link-session
states and actions.

Long-lived remote-provider sessions remain owned by mautrix on Contabo.
Cloudflare retains only non-secret connection identity, capability, lifecycle,
health, and audit metadata. Element and bridge-bot commands remain an operator
fallback, not the intended customer experience.

## Canonical event envelope

All inbound, backfilled, and command-result events use one versioned envelope.
The exact schema will be frozen before implementation, but the contract must
contain at least:

```json
{
  "schema_version": 1,
  "event_id": "$matrix-event-id",
  "event_type": "message.created",
  "tenant_id": "tenant_123",
  "identity_id": "identity_human",
  "platform": "whatsapp",
  "account_id": "account_123",
  "conversation_id": "conversation_456",
  "matrix_room_id": "!opaque:communicator.0000.gold",
  "matrix_event_id": "$matrix-event-id",
  "remote_message_id": "optional-remote-id",
  "occurred_at": "2026-08-27T10:00:00.000Z",
  "observed_at": "2026-08-27T10:00:02.000Z",
  "payload": {}
}
```

The supported event families must cover:

- message creation, edit, deletion, and reply relationships;
- reactions and reaction removal;
- read and delivery receipts;
- typing state when it is useful to expose;
- attachment metadata;
- conversation and participant changes;
- command status and bridge-delivery status; and
- replay, correction, and deletion tombstones.

`event_id` is the canonical idempotency key. Matrix event IDs and stable remote
message IDs remain separately queryable. Backfill preserves the original
`occurred_at` and records the later `observed_at`.

## Canonical resource model

The public API uses stable Communicator IDs and never requires callers to use
Matrix or bridge identifiers. Provider and Matrix identifiers remain internal
aliases for reconciliation and diagnostics.

The principal resources are:

- `Tenant`: customer workspace and isolation boundary;
- `Membership`: principal role and tenant access;
- `Principal`: authenticated human, service, or automation actor;
- `Identity`: human or agent persona with independent visibility and command
  authority;
- `Connection`: one provider account bound to one identity;
- `LinkSession`: temporary workflow used to create or repair a connection;
- `Conversation`: provider conversation observed through a connection;
- `Participant`: normalized remote participant plus provider aliases;
- `Message`: current normalized message state;
- `MessageVersion`: immutable edit history where policy permits retention;
- `Reaction`, `Receipt`, and `TypingState`: related messaging state;
- `Attachment`: metadata, hashes, provider references, and optional R2 keys;
- `Command`: requested outbound mutation and its durable progress; and
- `AuditEvent`: security- or operator-relevant action without unnecessary
  message content.

One provider conversation can appear through more than one connection. The
pilot stores each connection-specific view separately unless a future,
explicit conversation-linking feature proves that two views should be merged.
This avoids accidental cross-identity disclosure.

Messages are not generic CRUD records. Provider-observed messages change only
through normalized inbound events, and outbound message mutations change the
projection only after the resulting Matrix event is observed. Local labels,
annotations, and saved filters may use ordinary CRUD semantics.

## Tenant projection

`TenantProjectionDO` is deterministically addressed by tenant ID. Its SQLite
database contains normalized, indexed, interactive state rather than raw
lifetime evidence.

Candidate tables include:

- schema migrations;
- identities, connections, provider capabilities, and connection health;
- conversations and participants;
- messages and message versions;
- reactions and receipts;
- attachment metadata and R2 references;
- applied event IDs;
- recent change-sequence entries for WebSocket recovery;
- ingestion and replay checkpoints;
- local labels and annotations;
- report aggregates; and
- audit records relevant to tenant-level access.

The DO applies each tenant batch atomically where records are related. A message
mutation, conversation summary, unread counter, change-sequence record, and
applied-event marker must not disagree after a successful call.

All critical state is persisted before any in-memory cache or WebSocket
broadcast is updated. Duplicate Queue delivery, reconnect replay, and operator
replay must be harmless.

## Command model

An outbound mutation is a command, not a direct database mutation. Each command
has:

- a unique command ID;
- a caller-provided idempotency key;
- tenant, principal, and sending identity;
- target conversation and optional target message;
- requested operation and payload;
- remote capability snapshot;
- delivery mode;
- current state and timestamps;
- Matrix transaction and event IDs when assigned;
- retry and failure information; and
- an audit trail.

Representative state transitions are:

```text
accepted
  -> scheduled
  -> reading
  -> typing
  -> submitted_to_matrix
  -> matrix_confirmed
  -> bridged
  -> delivered
```

Commands may also become `cancelled`, `unsupported`, or `failed`. Not every
bridge can report every intermediate state. The API must distinguish an
unknown state from a successful state.

The Matrix Gateway derives the Matrix transaction ID deterministically from
the Communicator command ID so that transport retries do not duplicate a
message.

## Supported mutations

The API is designed to support:

- sending text and supported attachments;
- editing a sent message;
- deleting or redacting a sent message;
- adding and removing reactions;
- marking a conversation read;
- starting and stopping typing; and
- cancelling a paced send before submission.

Support is capability-driven. The API exposes the currently known capabilities
of each conversation. Unsupported operations fail clearly before dispatch when
possible. An operation accepted by Matrix may still fail at the bridge or
remote network, and that failure must be reflected in command status.

The system uses standard Matrix and supported mautrix behavior. It does not
patch bridge source code to simulate unsupported remote features.

## Direct and paced delivery

Both modes use the reliable command path.

### Direct delivery

Direct delivery introduces no deliberate delay. The command becomes due
immediately, but the HTTP API still returns an asynchronous command resource.
Clients observe final progress through REST or WebSocket.

### Paced delivery

Paced delivery is an explicit state machine:

```text
accepted
  -> optionally mark read
  -> optional reading delay
  -> typing on
  -> length-based typing delay
  -> submit message
  -> typing off, best effort
```

The typing duration is derived from a named server-side profile using message
grapheme length, a configured typing rate, bounded variation, and minimum and
maximum limits. Long waits refresh the Matrix typing timeout. The server stores
the resolved schedule so retries do not choose new random values.

Typing, read receipt, or presence failure must not silently discard the
message. Each optional phase records its result and the policy determines
whether message submission continues. Typing-off is always attempted but is
best effort.

Paced commands remain cancellable until message submission begins. The
backoffice and API expose the calculated schedule and current phase.

## Identity command coordination

`IdentityCommandDO` is deterministically addressed by tenant and sending
identity. It owns:

- idempotency and command records;
- per-identity outbound ordering;
- scheduled command steps;
- paced-send state;
- cancellation state;
- rate-limit and retry metadata; and
- recent command status for API and WebSocket use.

An identity-level boundary prevents Human and Agent commands from sharing a
scheduler or authority context. It also lets both identities operate
concurrently.

The DO uses its single alarm as a timer for the earliest pending step. Multiple
commands are represented in a SQLite schedule table; the alarm processes all
due work, persists outcomes, and schedules the next earliest step. It never
holds the object awake merely to sleep until a due time.

Long-running or approval-based work is not implemented as one alarm handler.
Such work can later start a Cloudflare Workflow while the command DO retains
the user-visible command record.

## REST API

The canonical product interface is a versioned HTTPS API. Durable Objects are
never exposed directly.

Representative read endpoints are:

```http
GET /v1/me
GET /v1/identities
GET /v1/providers
GET /v1/connections
GET /v1/connections/{connection_id}
GET /v1/conversations
GET /v1/conversations/{conversation_id}
GET /v1/conversations/{conversation_id}/capabilities
GET /v1/conversations/{conversation_id}/messages
GET /v1/messages/{message_id}
GET /v1/search/messages
GET /v1/reports/activity
```

Representative command endpoints are:

```http
POST   /v1/conversations/{conversation_id}/messages
PATCH  /v1/messages/{message_id}
DELETE /v1/messages/{message_id}
POST   /v1/messages/{message_id}/reactions
DELETE /v1/messages/{message_id}/reactions/{reaction_id}
POST   /v1/conversations/{conversation_id}/read
POST   /v1/conversations/{conversation_id}/typing
POST   /v1/commands/{command_id}/cancel
GET    /v1/commands/{command_id}
```

Account-linking endpoints are:

```http
POST   /v1/identities/{identity_id}/link-sessions
GET    /v1/link-sessions/{link_session_id}
POST   /v1/link-sessions/{link_session_id}/actions
DELETE /v1/link-sessions/{link_session_id}
POST   /v1/connections/{connection_id}/reconnect
POST   /v1/connections/{connection_id}/disconnect
POST   /v1/connections/{connection_id}/unlink
```

Administrative asynchronous endpoints include:

```http
POST /v1/exports
GET  /v1/exports/{export_id}
POST /v1/replays
GET  /v1/replays/{replay_id}
```

Every mutation accepts an `Idempotency-Key`. Commands return `202 Accepted`
unless the operation can be rejected synchronously. Collection endpoints use
opaque cursor pagination. The API publishes an OpenAPI contract from which a
TypeScript client can be generated.

Messages mirrored from remote systems are not generic CRUD rows. Directly
editing projection SQLite is forbidden. Message create, edit, delete, and
reaction requests are remote commands and become projection changes only after
their Matrix events are observed.

Local resources such as labels, annotations, saved filters, WebSocket
subscriptions, and later automation rules may use ordinary CRUD semantics.

## Authentication and authorization

Communicator product authentication, internal Matrix authentication, and
remote-provider authentication are separate concerns:

1. Product authentication proves the principal using the API or backoffice.
2. Internal Matrix credentials let the Matrix Gateway observe or act as an
   authorized Communicator identity.
3. Remote-provider authentication creates and maintains a mautrix connection
   for one external account.

Ordinary product users never receive Matrix access tokens, E2EE keys, bridge
database credentials, provisioning shared secrets, or long-lived provider
sessions.

The product authentication boundary is standards-based. The API Worker
validates issuer, audience, signature, expiry, and revocation-relevant claims
from a configured OIDC/JWKS authority. The pilot backoffice may be additionally
protected by Cloudflare Access, but that outer gate does not replace
application authorization. Machine clients use separately issued, revocable,
scoped credentials rather than browser session tokens.

The API Worker authenticates every HTTP request and WebSocket-ticket request.
Trusted product claims or server-side membership lookup identify:

- tenant;
- principal;
- allowed identity IDs;
- role and command scopes; and
- break-glass status when present.

The Worker routes only to the tenant and identity objects implied by trusted
claims. A caller-provided tenant or identity ID is never accepted as authority.
DO methods receive a narrow authorization context and re-check identity scope
against the requested records.

Break-glass access must record operator, reason, scope, start and end time, and
affected resources without recording unnecessary message content.

Authorization decisions default to deny. Sensitive actions require distinct
scopes, including connection linking, connection unlinking, sending through an
identity, exports, replay, retention changes, and break-glass inspection.
Changing a role or revoking a principal must take effect within a bounded token
lifetime and must invalidate newly requested WebSocket tickets.

### Control-directory resolution

The API normalizes the validated OIDC issuer and subject to an internal
principal ID, then queries the D1 Control Directory for active memberships and
identity grants. A tenant ID supplied as a route, header, or query value is a
selection hint only; an active matching membership is required before the
Worker obtains a DO stub or private gateway route.

The minimum authoritative tables are `tenants`, `principals`, `memberships`,
`identities`, `identity_grants`, `connections`, `connection_routes`, and
`break_glass_grants`, all with explicit migrations and audit timestamps.
Membership and identity-grant changes use D1 transactions. Changes that must
also appear in a tenant projection use an idempotent control-event outbox;
cross-product writes are never described as one atomic transaction.

The directory contains no message bodies, provider authentication material,
Matrix access tokens, E2EE keys, or bridge provisioning secrets. It has its own
backup, restore, migration, and audit procedure because it is authoritative
control-plane state rather than a rebuildable message projection.

### Workspace onboarding

The pilot provisions its tenant, initial owner, Human identity, and Agent
identity through an audited operator workflow. Public self-service signup,
billing, invitations, and organization lifecycle are not required for the
first data-plane pilot. Their eventual implementation must create the same
tenant, membership, principal, and identity records rather than a parallel
authorization model.

Baseline workspace roles are `owner`, `admin`, and `member`; service and agent
principals are represented by principal type plus explicit scopes rather than
by a universally privileged role. Owners can delegate connection management
per identity. Only authorized administrators can request break-glass access,
and break-glass never becomes an ambient owner permission.

## Connection and link-session lifecycle

A `Connection` is the durable, non-secret product representation of one
provider account. It records:

- tenant, owning identity, provider, and Communicator connection ID;
- internal bridge-instance and Matrix-user routing references;
- privacy-safe remote account label and provider account ID when available;
- lifecycle and health status;
- supported capabilities and the version at which they were observed;
- initial-sync and backfill progress;
- last successful inbound and outbound activity;
- attention, disconnect, and revocation reason codes; and
- created, connected, refreshed, disconnected, and unlinked timestamps.

A `LinkSession` is short-lived and addressed by an unguessable ID. It binds the
authenticated principal, tenant, target identity, provider, selected bridge
instance, expiration time, and current action. It does not become the
long-lived provider session.

Canonical success states are:

```text
created
  -> awaiting_user
  -> authenticating
  -> connected
  -> syncing
  -> ready
```

Canonical exception states are:

```text
challenge_required  attention_required  rate_limited
expired             failed              cancelled
disconnected        revoked             unlinking -> unlinked
```

The current link response contains one canonical `next_action`, such as
`scan_qr`, `enter_phone`, `enter_code`, `enter_password`,
`complete_browser_challenge`, `wait`, or `none`. Each action has a short
expiry, a provider-neutral display contract, and an allowlist of accepted
response fields. Clients do not infer the next step from provider-specific
error strings.

QR payloads, verification codes, passwords, cookies, 2FA values, passkeys, and
challenge artifacts are ephemeral secrets. They are never written to Durable
Object SQLite, R2, analytics, traces, screenshots, support bundles, or test
evidence. If a sensitive value must traverse Communicator, the Worker forwards
it only to the private Connection Gateway over an authenticated channel and
redacts it before all logging. Browser-assisted handoff is preferred over
asking customers to paste reusable cookies.

Before linking, the UX displays provider-specific risk, retention, backfill,
and expected challenge information. A successful provider login first creates
or confirms the mautrix session, then idempotently persists the non-secret
connection record. The systems cannot share one transaction, so reconciliation
must detect and repair a bridge session created just before a Cloudflare write
failure. Initial synchronization is visible as `syncing`; it is not reported
as `ready` merely because authentication succeeded.

`disconnect` pauses or disables Communicator use without claiming remote
logout. `unlink` attempts remote logout and removes the active bridge binding;
it is externally disruptive and requires explicit confirmation. Neither
operation silently deletes projected history or R2 archives. Historical-data
deletion is a separate retention workflow.

### Account-linking UX contract

The backoffice and future customer application use the same guided journey:

1. Sign in and choose an authorized workspace.
2. Choose the Human, Agent, or other authorized identity that will own the
   connection.
3. Open Connections and choose a provider card.
4. Review supported capabilities, unofficial-platform risk, retention,
   backfill, and expected authentication steps.
5. Select an available login method and create a link session.
6. Complete the displayed QR, code, 2FA, passkey, or browser challenge.
7. Observe `connected`, initial `syncing` progress, and finally `ready`.
8. Resolve later `attention_required` or `disconnected` states through the same
   connection screen.

The identity choice is always explicit before authentication begins. A user
must not accidentally connect a personal account to an agent identity. The UI
shows the target identity throughout the flow and repeats it on confirmation.

Provider challenges may expire or change while the page is open. The UI renders
the server-provided current action, announces expiry and status accessibly, and
can resume a still-valid session after navigation or WebSocket reconnection.
It never claims that Communicator can bypass a provider security challenge.

## Provider adapter contract

The Connection Gateway implements one internal adapter contract for every
bridge. An adapter must provide:

- provider identity and bridge-instance health;
- supported login methods and current login action;
- start, continue, cancel, reconnect, disconnect, and unlink operations;
- canonical status, error, and challenge mapping;
- remote-account metadata safe for the product projection;
- initial-sync progress where observable; and
- conversation and mutation capability discovery.

The first adapters target WhatsApp, Telegram, Messenger, and LinkedIn. Their
authentication mechanics may differ, but they do not create separate public
product APIs. Capability differences are data. The connection and conversation
capability documents determine whether an application may send attachments,
edit, delete, react, mark read, or emit typing.

The gateway also contains a connection router. The router maps a connection to
one concrete bridge instance and Contabo host. This indirection allows later
horizontal placement or migration without changing public connection IDs or
client APIs. Migration of an active provider session is provider-specific and
must never be implied by merely changing the routing record.

## Link-session coordination

`LinkSessionDO` is deterministically addressed by a random link-session ID. It
owns the state-transition guard, principal and target-identity binding,
expiration, retry counters, non-secret action metadata, and an audit-safe event
timeline. It rejects actions from a different principal or identity scope and
uses an alarm to expire abandoned sessions.

The DO stores only opaque references to sensitive challenges. A QR payload or
other secret response is retrieved from the Connection Gateway through a
short-lived, authenticated, single-purpose route and returned only to the
authorized client. Once consumed or expired, the gateway invalidates it.

Cloudflare-to-Contabo provisioning calls use a dedicated service identity,
authenticated transport, bounded request lifetime, nonce or request ID, and
idempotency key. The gateway authorizes each operation against the supplied
tenant, identity, link session, provider, and bridge instance rather than
trusting network location alone. Its provisioning interface is not routed by
the public reverse proxy.

## Realtime WebSocket API

REST remains authoritative; WebSocket delivery is a live convenience.

The client requests a short-lived, single-use realtime ticket over authenticated
HTTPS and then upgrades to the WebSocket endpoint. Long-lived bearer tokens are
not placed in query strings.

Clients subscribe only to authorized identities and event families. Server
events include a monotonically increasing tenant change sequence. On
reconnection, a client supplies its last sequence or uses REST to retrieve
missed changes.

Representative events include:

- link-session state and non-secret next-action changes;
- connection ready, syncing, health, attention, and disconnect changes;
- message creation, edit, and deletion;
- reaction and receipt changes;
- conversation summary and unread-count changes;
- typing changes when exposed;
- command state transitions;
- export and replay progress; and
- access or capability changes relevant to the client.

The pilot may host hibernatable WebSocket connections in
`TenantProjectionDO`. The external protocol must not depend on that placement,
so realtime coordination can later move to a separate DO class without
breaking clients.

## Backoffice

The protected backoffice is a deliberately small reference client, not a
second administrative data path. It calls the same REST and WebSocket APIs as
future applications and never queries DO SQLite, R2, Synapse PostgreSQL, or a
bridge database directly.

The initial backoffice contains:

- system and ingestion status;
- tenant and authorized identity context;
- a Connections screen organized by identity and provider;
- provider capability, risk, and supported-login-method display;
- start, resume, cancel, reconnect, disconnect, and confirmed unlink controls;
- QR, code, browser-challenge, syncing, and attention-required states without
  persisting authentication secrets;
- connection health, last synchronization, and bridge placement status;
- account and conversation browsing;
- message timeline and search;
- live WebSocket connection and sequence status;
- normalized event and command JSON inspection;
- direct and paced send controls;
- reaction, read, edit, delete, and typing controls when supported;
- command state timeline and paced-send cancellation;
- capability inspection;
- local label or annotation CRUD;
- export and replay status; and
- break-glass audit visibility for administrators.

A synthetic normalized-event injector may exist only in local or isolated test
environments. It must be absent or fail closed in production.

## Future message-triggered automation

Automation is not part of the first implementation, but the event and command
contracts must allow it to be added without changing ingestion or bypassing
authorization.

After an inbound message is committed, the projection can later add an
automation-outbox record in the same atomic storage update. An idempotent
dispatcher sends those records to a separate Automation Queue. Slow LLM or tool
calls never run inside ingestion or projection mutation methods.

The future automation path is:

```text
committed inbound message
    -> automation outbox
    -> Automation Queue
    -> conversation-level debounce or micro-batch
    -> fast classifier/agent
    -> no action | notify | call tool | respond | escalate
```

The latency-sensitive stage uses an immediate event plus a short,
conversation-level debounce to combine a burst of messages. It does not wait
for a large archival batch. Deterministic urgent rules may bypass the debounce.
Non-urgent enrichment and reporting may use larger batches separately.

Any automated response calls the same command API with an automation principal,
explicit identity scope, idempotency key, and selected direct or paced delivery
mode. Agents do not receive a privileged mutation path.

Quick decisions and a small number of API calls can run in a Queue-triggered
Worker or lightweight Agent. Durable multi-step work, unreliable tool chains,
long waits, or human approval can use a Workflow. Destructive or externally
consequential actions require an explicit policy and may require approval.

Future automation records must include the triggering event IDs, identity,
model and prompt version, decision, confidence, tool calls, command IDs,
approval state, cost/latency data, and final result.

## R2 archive and replay

The archive uses ordinary R2 and avoids one object per message. The target
layout is tenant-scoped compressed batches and separate exports or media:

```text
events/{tenant}/{year}/{month}/{day}/{hour}/{batch-id}.jsonl.gz
exports/{tenant}/{timestamp}.jsonl.gz
media/{tenant}/{content-hash}
```

Archive batches retain canonical envelopes and enough provenance to rebuild a
fresh tenant projection. Attachment bytes are stored only when product policy
requires an archived copy; SQLite stores metadata and object keys.

Replay must be deterministic and idempotent. Applying the same archive twice
must produce an equivalent projection. A replay cannot silently re-run remote
message commands or future automations.

## Optional Brain connector boundary

Communicator does not depend on the separate Brain product, R2 Data Catalog, or
Cloudflare Pipelines. It exposes a future, tenant-opt-in connector boundary so
Brain can consume authorized message history and committed changes without
reading Synapse, bridge databases, DO SQLite, or Communicator's private R2
bucket directly.

The boundary consists of versioned normalized-event/export contracts,
identity-scoped authorization, resumable cursors or manifests, deletion and
retention signals, and audit records. Brain owns any Data Catalog, Pipelines,
semantic indexing, large-scale historical analytics, or knowledge-runtime
state derived on its side.

Brain receives no provider sessions, Matrix credentials, E2EE keys, or implicit
command authority. If a Brain workflow later needs to send or mutate a message,
it acts as an explicitly scoped service principal through the same public
command API as every other automation. Disabling the connector stops new
delivery but does not make unverified claims about data Brain has already
retained; coordinated deletion requires an explicit cross-product workflow.

## Failure behavior

The system must behave safely under partial failure:

- duplicate ingestion is ignored through canonical event IDs;
- a Queue retry cannot create duplicate messages or aggregates;
- a repeated API idempotency key returns the original command;
- a repeated Matrix Gateway call uses the same Matrix transaction ID;
- a repeated link action returns the existing transition or safely retries it;
- an expired link session cannot continue authenticating;
- a provider session created before a Cloudflare failure is reconciled or
  safely presented for operator cleanup rather than duplicated;
- Connection Gateway unavailability leaves the link or connection in a
  recoverable, visible state;
- D1 Control Directory unavailability fails closed for new authorization,
  linking, export, replay, and command decisions;
- a failed typing or read-receipt phase follows the stored command policy;
- Matrix or bridge failure leaves a queryable failed or retrying command;
- WebSocket disconnection does not lose durable data;
- an unavailable automation system never blocks ingestion or manual commands;
- replay never sends remote messages; and
- DO eviction loses only in-memory caches, not critical state.

Retries are bounded and observable. Permanent failures move to a failed state
or dead-letter path with operator-safe diagnostics. Logs and error payloads do
not expose message contents, access tokens, E2EE keys, bridge sessions, or
remote-account credentials by default.

## Security and trust boundaries

The public API Worker is the only internet-facing product data-plane entry
point. Durable Object RPC, Queue producers and consumers, R2, the Matrix
Gateway, the Connection Gateway, Synapse administration, and mautrix
provisioning are private service surfaces.

The design uses these secret boundaries:

- the configured identity authority owns product-login credentials;
- the API Worker owns only the keys and service credentials needed for product
  authentication, Queue/R2 bindings, and private gateway calls;
- the Matrix Gateway owns Matrix access tokens, device identity, and E2EE keys;
- each mautrix bridge owns its long-lived provider session;
- the Connection Gateway can invoke provisioning but does not return reusable
  bridge credentials to Cloudflare; and
- clients receive only product tokens and short-lived linking or realtime
  artifacts appropriate to their current operation.

Secrets are injected through protected runtime secret mechanisms, rotated with
overlap where possible, and excluded from repository files and deployment
archives. Backups containing bridge sessions or Matrix encryption material are
encrypted and access-controlled as credentials, not treated as ordinary data
exports.

Every storage key, Queue message, DO lookup, archive key, and gateway request is
derived from trusted tenant and identity context. Tests must attempt horizontal
and vertical privilege escalation, including guessed connection IDs,
link-session takeover, cross-identity commands, replayed service requests, and
break-glass use without an active reason.

## Privacy, retention, and deletion

Message content is sensitive. Access follows tenant and identity scopes at
every interface. R2 objects and exports are private. Matrix encryption keys
remain protected on the Contabo host.

Deletion is a workflow across distinct systems:

- projection deletion in Durable Object SQLite;
- archive deletion or retention enforcement in ordinary R2;
- Synapse retention or room-event handling;
- Matrix media deletion where applicable;
- bridge mapping and session handling; and
- remote-network deletion when explicitly requested and supported.

Deleting a projection does not claim that remote or archived data was deleted.
Irreversible external actions, including remote message deletion or account
unlinking, require explicit authority and audit evidence.

## Observability

The pilot must expose metrics and structured events for:

- Matrix ingestion lag and checkpoint age;
- Queue batch success, retry, and dead-letter counts;
- R2 archive batch success and age;
- DO apply latency, duplicates, and schema version;
- REST request latency and authorization failures;
- active and resumed WebSocket connections;
- command latency by phase and platform;
- Matrix Gateway and bridge failures;
- link-session completion, expiry, challenge, and redacted failure counts;
- connection health, reconnect demand, and initial-sync age;
- paced-send cancellation and optional-phase failures; and
- future automation dispatch, decision, tool, and response latency.

Metrics must identify tenant and identity through privacy-safe internal IDs and
must not use message bodies as labels.

## Deployment, migration, and scaling

Cloudflare resources are deployed from versioned configuration with separate
development, staging, and production bindings. Schema changes use explicit,
forward-only Durable Object migrations and versioned SQLite migrations. Worker
deployment must remain compatible with the previous persisted schema until the
corresponding migration has completed.

Contabo gateway releases are immutable, checksummed artifacts deployed through
the existing release and rollback procedure. The Matrix and Connection
Gateways are separate logical responsibilities but may initially run in one
repository and VPS deployment. Neither requires a fork of Synapse or mautrix.

Scaling boundaries are independent:

- tenant query and realtime load scales by `TenantProjectionDO`;
- outbound ordering and paced scheduling scales by `IdentityCommandDO`;
- active account pairing scales by short-lived `LinkSessionDO`;
- ingestion throughput scales through Queue batches;
- archives scale through tenant-partitioned R2 batches; and
- remote connectivity scales through bridge-instance placement behind the
  Connection Gateway router.

Adding another VPS or bridge instance changes placement data and private
gateway routing, not public API identifiers. A provider account session is not
assumed portable; migration requires an adapter-specific, audited procedure or
fresh pairing. Capacity alerts must be defined before a host approaches its
CPU, memory, disk, database-connection, bridge-session, or Queue-lag threshold.

## Testing and rollout strategy

The implementation must include:

- schema and serialization tests for every public contract;
- authorization tests across tenant, identity, role, and break-glass scopes;
- state-machine tests for commands, links, connections, replay, and deletion;
- provider-adapter contract tests with deterministic fake gateways;
- idempotency, duplicate-delivery, reordering, and partial-failure tests;
- DO migration, eviction, alarm, WebSocket resume, and projection rebuild tests;
- secret-redaction and public-surface tests;
- isolated integration tests against Synapse and the gateway interfaces; and
- backoffice end-to-end tests that use only the public API.

Rollout proceeds through local deterministic adapters, an isolated Cloudflare
environment, the existing single-tenant WhatsApp pilot, the Agent and Human
identity isolation suite, and then additional providers one at a time. Manual
Element pairing remains available until the corresponding self-service adapter
passes its linking, reconnect, unlink, secret-handling, and recovery tests.

Provider contract tests assert capability-specific behavior. They do not claim
that every provider supports every mutation or login method.

## Acceptance criteria

The first production-like pilot is complete when all of the following are
demonstrated with WhatsApp:

1. An inbound Human message appears through REST and WebSocket.
2. An inbound Agent message appears only to an Agent-authorized principal.
3. Human and Agent query and command isolation is symmetric.
4. Audited break-glass access can inspect explicitly scoped data.
5. Duplicate ingestion does not duplicate messages or aggregates.
6. Edits, deletions, reactions, receipts, and attachment metadata project
   correctly when supported.
7. A direct send reaches Matrix without an artificial delay and is confirmed
   through normal ingestion.
8. A paced send marks read when configured, emits typing, waits according to a
   stored length-based schedule, and then sends.
9. Retrying either send mode does not duplicate the remote message.
10. Supported reaction, read, edit, and delete commands complete through the
    Matrix/mautrix path.
11. Command progress and failures are visible through REST, WebSocket, and the
    backoffice.
12. The backoffice accesses data only through authenticated product APIs.
13. R2 contains batched replay records rather than one object per message.
14. A fresh tenant projection can be rebuilt from R2 without sending commands
    or triggering automation.
15. Restart and partial-failure tests preserve checkpoints, command state,
    identity isolation, and Matrix encryption sessions.
16. Product authentication rejects invalid issuer, audience, signature,
    expiry, tenant, identity, and operation scope.
17. Revoked access cannot obtain new realtime tickets, commands, exports, or
    link sessions after the documented revocation bound.
18. Connection and capability state are queryable without exposing Matrix,
    bridge, or provider credentials.
19. Security tests demonstrate that public routes cannot reach mautrix
    provisioning or gateway-administration interfaces.
20. The D1 Control Directory can be restored without granting stale, deleted,
    or cross-tenant memberships, and a tenant projection rebuild does not alter
    directory authority.

Self-service account linking is a separately releasable milestone. A provider
adapter is complete when:

1. An authorized principal can start a link session for an allowed identity.
2. Canonical next actions can complete the provider's supported login methods.
3. A different tenant, identity, or principal cannot inspect or continue the
   link session.
4. No authentication secret appears in DO SQLite, R2, logs, traces, test
   artifacts, or the resulting connection record.
5. Authentication success becomes `syncing` and only a usable connection
   becomes `ready`.
6. Expiry, challenge, reconnect, disconnect, revocation, and confirmed unlink
   behavior is observable and recoverable as specified.
7. Unlinking does not silently delete historical messages or archives.
8. Manual operator pairing remains a documented fallback.

Telegram, Messenger, and LinkedIn must later pass the same contract tests with
capability-specific expectations rather than separate product APIs.

## Implementation technology choices

The initial TypeScript workspace uses Node.js 24 LTS and pnpm. The protected
backoffice and public API are one same-origin Cloudflare application package:

- React and TypeScript for the backoffice;
- Vite with `@cloudflare/vite-plugin` for local Workers-compatible development
  and deployment;
- TanStack Router and TanStack Query for typed routes and server state;
- shadcn/ui, Tailwind CSS, React Hook Form, and Zod for accessible, owned UI
  components and validated forms;
- Hono with `@hono/zod-openapi` for the Worker HTTP API and OpenAPI contract;
- generated OpenAPI TypeScript types for the browser client;
- Mock Service Worker with contract-valid fixtures for early interactive
  development;
- Vitest with `@cloudflare/vitest-plugin` for Worker and Durable Object tests;
  and
- Playwright for user-visible browser acceptance tests.

The first package is `apps/control-plane`, containing a React client and Hono
Worker entry built by one Vite configuration. Shared schemas live in
`packages/contracts`, and deterministic non-secret scenarios live in
`packages/test-fixtures`. Later Queue consumers and Contabo gateways are
separate deployable packages that import the same versioned contracts.

D1 is used only for the authoritative control directory. Durable Object SQLite
remains the per-tenant interactive messaging projection and command scheduler;
ordinary R2 remains the replayable message archive. These three SQLite/object
stores are not interchangeable and have separate recovery contracts.

The pilot does not adopt React Admin, Refine, a full-stack SSR framework,
Redux, Socket.IO, or a general DO SQLite ORM. The messaging timeline,
link-session wizard, command phases, WebSocket resume behavior, and
capability-driven mutations are custom product behavior rather than generic
CRUD. Durable Object persistence uses explicit migrations and focused
repository functions so transaction and replay behavior remain auditable.

Mock mode is a replaceable adapter, not a second application. It implements the
same OpenAPI shapes and realtime event types as the live API, is visibly marked
in the UI, contains no production secrets, and fails closed in production
builds. Every backend milestone replaces one mock capability through the same
client boundary and ends with a browser-verifiable checkpoint.

## Delivery sequence

Implementation planning should divide the work into these milestones:

1. repository and Cloudflare project foundation;
2. canonical resource, event, command, connection, link-session,
   authorization, and capability contracts;
3. contract-backed UI shell, identity selector, Connections, inbox, command
   activity, and system-status screens using visible simulated data;
4. browser acceptance harness and protected staging preview;
5. D1 Control Directory migrations, product-authentication validation, and
   tenant/identity authorization;
6. ordinary R2 archive and replay manifest contract;
7. `TenantProjectionDO` schema, migrations, ingestion RPC, and tests;
8. authenticated ingestion Worker and Queue consumer;
9. versioned live read API replacing the corresponding UI mocks;
10. hibernatable WebSocket tickets, subscriptions, and resume behavior;
11. Matrix Gateway event-consumer integration;
12. `IdentityCommandDO`, direct-send path, and command status;
13. paced-send scheduler, typing/read phases, and cancellation;
14. remaining mutation capabilities and capability negotiation;
15. R2 rebuild, export, deletion, and recovery validation;
16. observability, security review, deployment, and core pilot acceptance;
17. `LinkSessionDO` and private Connection Gateway with a deterministic fake
    provider adapter;
18. WhatsApp self-service linking and lifecycle acceptance;
19. Telegram, Messenger, and LinkedIn adapters as their bridge deployments
    become ready; and
20. a documented but inactive automation extension contract.

The future automation runtime is a separate milestone and requires its own
approved design before model or tool execution is enabled.
