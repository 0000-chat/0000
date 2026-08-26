# Communicator Cloudflare Data Plane Design

**Status:** Approved for implementation planning

**Audience:** Communicator implementers, operators, security reviewers, and API
client developers

**Goal:** Provide a tenant-isolated, replayable, bidirectional messaging API over
the existing Synapse and mautrix deployment, with REST reads and commands,
WebSocket updates, a small backoffice, and a safe extension boundary for future
message-triggered automation.

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
- Cloudflare Queues for asynchronous ingestion and failure isolation;
- a batched, compressed ordinary R2 event archive;
- one `TenantProjectionDO` per customer workspace;
- one `IdentityCommandDO` per sending identity;
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

## Ownership boundaries

```text
Synapse                    Operational Matrix history and messaging truth
mautrix                    Remote-network translation and account sessions
Matrix Gateway             E2EE-capable Matrix client, normalization, commands
Cloudflare Queue           Retry, backpressure, and failure isolation
ordinary R2                Immutable or append-only replay batches and exports
TenantProjectionDO         Rebuildable tenant query projection and live events
IdentityCommandDO          Ordered outbound commands and paced-send scheduling
API Worker                 Authentication, authorization, validation, routing
Backoffice                 Reference client and operator test surface
```

The Cloudflare projection does not replace Matrix history. A message is not
considered confirmed application state merely because an API command was
accepted. The resulting Matrix event must return through normal ingestion.

## Tenant, principal, and identity model

A tenant is one customer workspace. A principal is an authenticated human,
service, or agent making API calls. An identity is the persona and connected
account set through which messages are observed or sent.

The pilot has one tenant with at least these identities:

```text
Pilot tenant
|-- Human identity
|   `-- Human WhatsApp account
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

## High-level architecture

### Inbound and projection path

```text
Remote network
    -> mautrix
    -> encrypted Matrix room event
    -> verified Matrix Gateway
    -> authenticated ingestion Worker
    -> ingestion Queue
    -> ordinary R2 batch + TenantProjectionDO
    -> REST queries + WebSocket events
```

The Matrix Gateway incrementally consumes authorized Matrix rooms, decrypts
events, maps them to tenant and identity ownership, normalizes them, and
submits idempotent batches. It advances its Matrix checkpoint only according to
the durable-delivery contract defined by the implementation plan.

The Queue consumer validates each envelope, groups events by tenant, writes
compressed tenant batches to R2, and applies each group to the deterministic
tenant DO. The Queue batch is acknowledged only after all required durable
writes succeed.

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

## Tenant projection

`TenantProjectionDO` is deterministically addressed by tenant ID. Its SQLite
database contains normalized, indexed, interactive state rather than raw
lifetime evidence.

Candidate tables include:

- schema migrations;
- identities and connected accounts;
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
GET /v1/accounts
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

The API Worker authenticates every HTTP request and WebSocket ticket request.
Trusted claims identify:

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

## Failure behavior

The system must behave safely under partial failure:

- duplicate ingestion is ignored through canonical event IDs;
- a Queue retry cannot create duplicate messages or aggregates;
- a repeated API idempotency key returns the original command;
- a repeated Matrix Gateway call uses the same Matrix transaction ID;
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
- paced-send cancellation and optional-phase failures; and
- future automation dispatch, decision, tool, and response latency.

Metrics must identify tenant and identity through privacy-safe internal IDs and
must not use message bodies as labels.

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

Telegram, Messenger, and LinkedIn must later pass the same contract tests with
capability-specific expectations rather than separate product APIs.

## Delivery sequence

Implementation planning should divide the work into these milestones:

1. repository and Cloudflare project foundation;
2. canonical event, command, authorization, and capability contracts;
3. ordinary R2 archive and replay manifest contract;
4. `TenantProjectionDO` schema, migrations, ingestion RPC, and tests;
5. authenticated ingestion Worker and Queue consumer;
6. versioned read API and generated OpenAPI contract;
7. hibernatable WebSocket tickets, subscriptions, and resume behavior;
8. Matrix Gateway event-consumer integration;
9. `IdentityCommandDO`, direct-send path, and command status;
10. paced-send scheduler, typing/read phases, and cancellation;
11. remaining mutation capabilities and capability negotiation;
12. protected backoffice reference client;
13. R2 rebuild, export, deletion, and recovery validation;
14. observability, security review, deployment, and pilot acceptance; and
15. a documented but inactive automation extension contract.

The future automation runtime is a separate milestone and requires its own
approved design before model or tool execution is enabled.
