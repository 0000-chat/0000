# Communicator Matrix Gateway Design

**Status:** Approved-boundary implementation design

**Date:** 2026-09-09

**Scope:** Contabo-side Matrix-to-Cloudflare ingestion only

## Simple model

The Matrix Gateway is the private courier between Synapse and the already-built
Cloudflare ingestion endpoint. It logs in to Matrix as a dedicated encrypted
device. Before it lets the Matrix SDK process a `/sync` response, it saves the
exact response bytes in an encrypted local inbox. It then decrypts approved
events on the VPS, translates them into Communicator's common event format,
saves each unsent batch locally, and retries that exact batch until Cloudflare
accepts it. Only then may it advance Communicator's Matrix checkpoint.

The gateway does not replace Synapse, the mautrix bridges, R2, or the tenant
Durable Objects. Synapse remains the operational messaging record, R2 remains
the immutable replay archive, and each Durable Object remains a rebuildable
tenant query projection.

## Goals

- Observe approved encrypted Matrix portal rooms without reading Synapse or
  mautrix private database schemas.
- Persist one stable Matrix device and its E2EE keys across restarts.
- Normalize supported Matrix events into the existing strict projection event
  contract.
- Keep tenant, identity, connection, account, and room ownership explicit and
  fail closed for unknown or conflicting mappings.
- Persist each exact Matrix `/sync` response, its source tokens, and exact
  outbound request bytes encrypted on the VPS before stateful processing or
  network delivery.
- Retry idempotently and advance a Matrix sync checkpoint only after every
  tenant batch for that sync window is accepted.
- Support an explicit, bounded backfill command without silently importing old
  history during first boot.
- Expose content-free health and operational diagnostics.

## Non-goals

- Sending messages, reactions, read receipts, or typing events to Matrix or a
  remote provider. Those belong to the later outbound-command phase.
- Replacing Synapse or treating the gateway database as authoritative history.
- Querying mautrix or Synapse application databases directly.
- Storing attachment bytes in the gateway or a Durable Object.
- Running an LLM or automation in the ingestion path.
- Automatically joining every room visible to the Matrix account.
- Public Matrix federation.

## Runtime boundary

The gateway is a Rust service in `services/matrix-gateway`, built as a pinned
multi-stage container and attached only to the Compose `core` network. It has
no published host port. It talks to Synapse over the private Compose network and
to the Cloudflare HTTPS endpoint over outbound TLS.

Rust and `matrix-rust-sdk` are selected because the gateway requires persistent
E2EE device state in a server process. Bootstrap uses the high-level SDK client.
The daemon uses Ruma request types, a bounded raw HTTP transport, and a public
`BaseClient` backed by the SDK's SQLite state and crypto stores. It never calls
the high-level `Client::sync_once` path. More than one process must never open
the same Matrix store or gateway state directory.

The service owns two persistent data areas beneath
`${COMMUNICATOR_RUNTIME_DIR}/matrix-gateway`:

- `matrix-store/`: the SDK's encrypted persistent Matrix/E2EE SQLite store;
- `state/`: the gateway registry, encrypted raw-sync inbox, sync-window ledger,
  encrypted ingestion and Matrix-crypto outboxes, and operational state.

Host root provisions secret files beneath
`${COMMUNICATOR_RUNTIME_DIR}/secrets`, then assigns them to the gateway's fixed
numeric UID/GID with mode 0600 so the non-root container can read them without
making them group/world-readable. They provide the Matrix password,
Matrix-store passphrase, gateway-state encryption key, OAuth client secret, and
non-secret-but-protected runtime configuration. Secret values are never
supplied as command-line arguments, Compose environment values, logs, health
output, or persisted plaintext.

## Matrix identity and bootstrap

The gateway uses a dedicated Matrix service user and a stable device identity.
The account is a high-value credential because it can decrypt every explicitly
approved portal room it joins.

Bootstrap is an operator command, not an automatic startup side effect:

1. Validate permissions and configuration.
2. Log in once with the protected password file and a fixed device display
   name.
3. Persist the returned session and E2EE state in the encrypted SDK store.
4. Perform key bootstrap/cross-signing setup required by the SDK, upload device,
   one-time, and fallback keys, and verify no `KeysUpload` request remains.
5. Record a first `/sync` token without emitting historical timeline events;
   for every joined room, retain only an encrypted last-durable-event anchor so
   a later limited timeline can prove a gap was closed.
6. Exit with a credential-free summary for operator review.

Normal service startup restores the saved session. It must not silently log in
as a new device when restoration fails; doing so could lose access to old
Megolm sessions and create device churn.

## Protected room registry

The gateway never infers tenant ownership from Matrix aliases, display names,
or bridge implementation details. A protected SQLite registry contains an
append-only mapping for each accepted Matrix room:

```text
matrix_room_id -> tenant_id, identity_id, connection_id, account_id,
                  platform, gateway_route_id, conversation_id,
                  owner_matrix_user_id, status
```

Mappings are provisioned through an offline administrative command that reads a
strict JSON document from a protected file. IDs use the same Communicator ID
contract as the Worker. Active mappings are immutable; correction means retire
the old row and append a new version. A Matrix room may have only one active
ownership mapping. A remote account may map to multiple rooms but only within
its fixed tenant/identity/connection/platform authority.

Unknown rooms, invited rooms, malformed events, unknown senders, and ownership
conflicts are quarantined without emitting message content. The process records
only bounded content-free counters and stable reason codes.

## Canonical normalization

Every emitted event conforms to `ProjectionEventEnvelopeSchema`. The envelope
contains the existing fields:

```text
schema_version, event_id, event_type, event_source, tenant_id, identity_id,
platform, account_id, conversation_id, matrix_room_id, matrix_event_id,
remote_message_id, occurred_at, observed_at, payload
```

Gateway identifiers are deterministic and ASCII-safe:

- Every hash input is a sequence of `u32` big-endian byte length followed by
  UTF-8 bytes. The first field is the exact domain label below.
- `event_id`: `evt_` plus SHA-256 of
  `canonical-event-v1, source-key, event-type, ordinal`. The source key is the
  Matrix event ID for durable events. For receipts it is
  `receipt-v1, room-id, target-event-id, participant-id, receipt-type`; for
  typing transitions it is
  `typing-v1, checkpoint-digest, room-id, participant-id, transition`.
- `message_id`: `message_` plus SHA-256 of
  `matrix-message-v1, room-id, original-message-event-id`.
- `reaction_id`: `reaction_` plus SHA-256 of
  `matrix-reaction-v1, room-id, reaction-event-id`.
- `participant_id`: `participant_` plus SHA-256 of
  `matrix-participant-v1, tenant-id, platform, account-id, matrix-user-id`.
- `attachment_id`: `attachment_` plus SHA-256 of
  `matrix-attachment-v1, message-id, zero-based-ordinal`.
- `conversation_id` is the immutable active registry value; it is not derived
  from a display name or room alias.
- `matrix_room_id` and `matrix_event_id`: retained in the R2 event body but
  never copied into Queue pointers or logs;
- `remote_message_id`: populated only when an upstream canonical identifier is
  present in a bridge-authored event; otherwise null.

The gateway must not use display names, timestamps, or message bodies as
identity inputs.

### Supported live mappings

The first gateway release emits only mappings whose Matrix semantics can be
made deterministic:

- `m.room.message` text/notice/emote -> `message.created`;
- `m.replace` relation -> `message.edited`;
- redaction of a known message -> `message.deleted`;
- `m.reaction` -> `reaction.added`;
- redaction of a known reaction -> `reaction.removed`;
- `m.receipt` read receipt -> `receipt.read`;
- `m.typing` replacement sets -> `typing.started` with a 30-second local
  projection expiry and `typing.stopped` for members removed from the set;
- supported file/image/audio/video message metadata -> one `message.created`
  plus `attachment.observed` per attachment;
- room name/topic/avatar state changes -> `conversation.updated` when the
  projection payload can be completed without inference;
- membership/profile changes for known participants -> `participant.updated`.

Receipts and typing are ephemeral replacement snapshots, not durable Matrix
timeline events. The gateway guarantees at-least-once handling only for a
snapshot that Synapse included in a durably journaled `/sync` response. It
cannot recover a transient state that appeared and disappeared between sync
responses. Receipt identifiers remain deterministic. Each typing snapshot
compares with the prior committed set for its room and emits deterministic
start/stop transitions. A start carries an expiry equal to the inbox's frozen
observation time plus 30 seconds. The projection and UI treat expired typing
state as inactive even if Matrix never supplied a later stop snapshot.

Unsupported encrypted event types and incomplete relation targets are skipped
with a bounded reason code. They are not coerced into `message.created`.
Delivery receipts, command outcomes, replay/correction markers, and deletion
tombstones are not invented from Matrix events; their later authoritative
producers use the same canonical contract.

An event that is unable to decrypt is not an unsupported event and is never
skipped. The gateway retains the raw response and prior committed token. It may
journal a bounded chain of later sync responses to receive naturally delivered
to-device key material. This receive-only phase does not generate room-key
requests or `/keys/claim` calls. It does not emit or commit the later windows
out of order. It finishes any KeysQuery created by one response before it
applies the next response in that chain. A limited timeline is
a source gap: the gateway paginates backward from `prev_batch`
until it reaches that room's encrypted last-committed event anchor, then folds
the missing events into the same window. Checkpoint advancement remains blocked
if the anchor cannot be reached inside the 90-day/100,000-event safety bound.
There is no automatic “skip gap” operation.

Direction and unread state are based on the room mapping's
`owner_matrix_user_id`, not the gateway service user or a display name. Events
sent by that owner are outbound; events from other known room participants are
inbound. Historical events use `event_source=backfill`; forward sync uses
`event_source=live`.

## Sync-window transaction and checkpoint rule

The raw Matrix `next_batch` value is a secret-bearing opaque checkpoint. It is
never sent to Cloudflare. For live `/sync` and live gap-fill batches,
Cloudflare receives only:

```json
{"kind":"matrix_sync_token_sha256","value":"sha256:<64 lowercase hex>"}
```

An explicit operator-requested backfill instead sends
`matrix_backfill_run_sha256`, a digest-bound identity derived from its local
job ID, frozen interval, limit, room, and batch ordinal. This lets crash/resume
reproduce the same immutable batch while a separate requested run remains
auditable. Raw pagination tokens and raw job parameters are never sent.

The gateway keeps two tokens. The committed token is the last response whose
canonical batches Cloudflare accepted. The fetch token is the tail of the
contiguous encrypted inbox and may move ahead only to retrieve missing E2EE
key material. Neither token comes from the SDK store. The SDK store token may
be equal to or ahead of the committed token only when every intervening raw
response exists in the local inbox.

For each `/sync` response, the gateway follows this order:

1. Fetch with the gateway's encrypted fetch token and a bounded 64 MiB response
   body. Parse only enough to validate the response and obtain `next_batch`.
2. In one `synchronous=FULL` SQLite transaction, encrypt and persist the exact
   response bytes, request token, next token, hashes, byte count, one frozen
   observation timestamp, and predecessor link. Fsync the database before any
   SDK call. Every replay uses that timestamp.
3. Feed the typed response to the persistent `BaseClient` so it processes
   to-device events, device-list changes, room state, and E2EE keys. Enumerate
   SDK crypto requests through an explicit allowlist. The receive-only daemon
   supports only `/keys/query`. It persists the request and its stable body
   digest before sending and persists the exact valid response before SDK
   acknowledgement. Only one unresolved query may exist. The service does not
   enumerate a new SDK request or apply another saved sync response until it
   accepts that query. After a restart, every loaded unresolved row needs an SDK
   rebind. A pending row is first resent from its saved bytes. Once a response
   is durably present, the service may enumerate exactly once to rebind it to
   the SDK's current query ID. It creates no new application row during rebind
   and matches by canonical request body. Otherwise it proves that every device key and signature in the
   saved response is present in the restored crypto store. An unprovable
   acknowledgement becomes a terminal crypto quarantine. `/keys/upload` pauses
   with a persisted maintenance code.
   `/keys/claim`,
   to-device sends, verification, signing, room sends, and key backup are not
   generated in this phase and fail closed if they appear.
4. Extract supported raw events. If the SDK already processed this response
   before a crash, decrypt its saved encrypted timeline events directly with
   the restored `OlmMachine`. The pinned-SDK recovery test must prove this path.
5. Normalize all accepted events. Partition them by
   `(tenant_id, gateway_route_id)` so a request never mixes tenants or routes.
6. Deterministically sort events by `observed_at`, then `occurred_at`, then the
   generated ASCII `event_id`, exactly matching the existing archive codec.
7. Split each partition at 500 events and before 4 MiB canonical JSONL. Freeze
   one `archived_at`, the canonical digest, and the `batch_id` for each batch.
8. In one local SQLite transaction, persist the exact encrypted ingestion
   request bytes and candidate room anchors, create the sync window, and mark
   its inbox row prepared.
9. Drain Matrix crypto requests, then POST ingestion requests in stable order.
   Retry identical bytes. Mark an ingestion batch accepted only after a strict
   202 response with matching tenant and batch IDs and archive status `created`
   or `already_committed`.
10. In one SQLite transaction, mark the inbox and window committed, apply room
    anchors, and advance the committed token only after all Matrix crypto and
    ingestion rows for that response are accepted. A response with no emitted
    events follows the same rule after its counters are recorded.

The SDK store and gateway database cannot share one SQLite transaction. The
encrypted raw inbox closes that boundary. If the process dies before SDK state
changes, it applies the saved response normally. If it dies after SDK state
changes, it recognizes the SDK token as a token from the contiguous inbox and
reconstructs the response from the saved raw bytes and restored crypto store.
Any SDK token that does not match the committed token or a contiguous inbox
token fails closed. The service retains committed inbox rows for seven days,
so recovery never depends on asking Synapse to reproduce an old response.
The pinned-SDK test also simulates a crash after crypto-store changes commit but
before the state-store token commits. Reapplying the saved response must be
idempotent. Failure of that test blocks this architecture.

If the process crashes at any point, startup drains the oldest pending window
before requesting a newer `/sync`. Lost responses are safe: resending the same
bytes yields the same `batch_id` and archive content. HTTP 400/404/409/413 are
terminal quarantines requiring operator action; 401 causes one token refresh
then pauses; 429 and 5xx use bounded exponential backoff with jitter and honor a
bounded `Retry-After` value.

The local ledger is a recovery inbox and transport outbox, not a third
authoritative event store. Accepted response and request bodies are purged
after a configurable seven-day safety window only when their Matrix checkpoint
is committed. Purge runs in one foreign-key-safe transaction. It detaches the
oldest retained inbox row from the deleted prefix and removes accepted child
rows before their windows. It then deletes the selected self-referencing inbox
rows newest-to-oldest. It never deletes the newest committed row or a row named
by the current SDK token. R2 is the long-term replay authority.

The current R2 contract archives normalized canonical event envelopes, not
original Matrix ciphertext or arbitrary unknown Matrix JSON. The encrypted raw
inbox is a short-lived crash-recovery journal and is never uploaded to R2 in
this phase. Unknown durable event types remain recoverable from Synapse history;
supported canonical history in R2 is sufficient to rebuild the tenant
projection.

## At-rest protection

The Matrix SDK store uses the SDK's passphrase-encrypted persistent SQLite
store. Gateway inbox, registry, and outbox values that reveal identifiers,
endpoints, checkpoint tokens, Matrix response or crypto-request bytes, or
canonical event content are encrypted at the application layer using
XChaCha20-Poly1305 with a random 24-byte nonce and explicit versioned associated
data. The 32-byte master key is loaded from a mode-0600 Docker secret file.
Plaintext is held only in process memory.

SQLite stores only ciphertext for protected columns. Non-sensitive operational
columns are limited to synthetic row IDs, state enums, attempt counters,
bounded reason codes, timestamps, byte counts, and key versions. Key rotation is
explicit and transactional: decrypt with the old key, re-encrypt with the new
key, verify every row, then update the active key version.

The existing restic backup includes both gateway directories and required
secret files. The isolated restore test verifies that a restored gateway can
open both databases and inspect state without contacting Matrix or Cloudflare.

## Authentication to Cloudflare

The gateway uses OAuth 2.0 client credentials against a configured token
endpoint. The client ID is protected configuration and the client secret is a
mode-0600 file. Tokens are cached only in memory, refreshed before expiry, and
must satisfy the Worker's dedicated short-lived ingestion JWT policy (issuer,
audience, subject/principal mapping, and maximum five-minute lifetime).

The gateway sends only:

```http
POST /internal/v1/ingestion/batches
Authorization: Bearer <short-lived service JWT>
Content-Type: application/json
Content-Encoding: identity
```

The implementation exposes a token-provider interface so tests can use a fake
issuer. It does not add a static long-lived bearer-token fallback.

## Explicit backfill

First boot starts at “now.” History is imported only by an operator command with
an exact room mapping, UTC start/end timestamps, and maximum-event limit. The
command paginates Matrix history backwards, decrypts and normalizes supported
events, reverses them into deterministic forward order, and writes them through
the same encrypted outbox and ingestion client with `event_source=backfill`.

Backfill has its own encrypted pagination checkpoint and may resume after a
crash. It never changes the forward `/sync` checkpoint. Re-running the same
bounded interval converges in the projection through deterministic canonical
event IDs; each separately requested run remains an auditable immutable R2
batch. The initial pilot limit is 90 days and 100,000 accepted Matrix events per
invocation; larger imports require multiple explicit invocations.

Gap-fill uses the same paginator and encrypted job machinery but is attached to
a blocked live sync window. It succeeds only when it finds the stored room
anchor; after the combined live+gap batches are accepted, the room anchor and
global sync token advance in the same gateway transaction.

## Backpressure and health

The gateway stops requesting normal new sync responses when the encrypted
inbox plus both outboxes exceed 256 MiB, pending request rows exceed 2,000, or
the oldest pending row is older than 24 hours. A bounded key-recovery fetch may
continue only while the combined hard byte limit remains unbroken. The gateway
continues retrying existing requests.

The container health command is local and content-free. It reports healthy only
when:

- the service loop is alive;
- the Matrix SDK store and gateway state database are open;
- the saved Matrix session/device is present;
- no terminal quarantine or persisted crypto maintenance code is active;
- the inbox and both outboxes are below hard limits.

The maintenance code is stored in the gateway database so a separate local
health process reports the same blocked state after a daemon restart. A
stopped-daemon verification command may clear
`crypto_maintenance_required` only after it restores the SDK store, confirms
that no KeysUpload or forbidden request remains, and confirms that no crypto
row is quarantined. It performs no network request and cannot resend, skip, or
force-acknowledge a crypto request.

Logs use stable event names, reason codes, counts, byte sizes, durations, and
retry classes. They never include message bodies, room/event/user IDs, tokens,
URLs containing secrets, Authorization headers, decrypted exceptions, or raw
checkpoint values.

## Failure and recovery invariants

- Duplicate Matrix events converge through deterministic `event_id`.
- Duplicate HTTP delivery converges through deterministic batch identity.
- Exact Matrix response bytes reach the encrypted inbox before the SDK may
  process them.
- The daemon never trusts the SDK sync token as its fetch or commit token.
- An SDK token ahead of the application token is valid only when the encrypted
  inbox proves every contiguous intervening response.
- A raw Matrix checkpoint never advances past unaccepted tenant batches.
- One tenant's terminal failure cannot cause another tenant's batch to be
  relabeled, but the shared Matrix window remains uncommitted until an operator
  fixes the cause and explicitly retries the quarantined batch. The pilot has
  no tombstone, skip, or force-advance operation.
- A corrupt or undecryptable local inbox, crypto-outbox, or ingestion-outbox
  row fails closed and preserves the prior committed Matrix checkpoint.
- A missing/invalid Matrix session never creates a replacement device
  automatically.
- Unknown room/account ownership never emits event content.
- No gateway operation mutates Synapse or mautrix databases.

## Delivery sequence

1. Compile-spike the pinned Matrix SDK APIs, raw transport, and post-restart
   direct E2EE decryption path; freeze dependency versions.
2. Implement strict configuration, secret loading, and cryptographic storage.
3. Implement registry and deterministic identifiers/normalization.
4. Implement raw-inbox, sync-window, outbox, and checkpoint transactions.
5. Implement OIDC ingestion delivery and retry behavior.
6. Implement Matrix E2EE bootstrap/sync and controlled backfill.
7. Integrate Compose, backup/restore, health, and operations documentation.
8. Pass local failure-matrix tests and independent reviews.
9. Deploy to staging Cloudflare and the Contabo pilot only after the existing
   placeholder issuer/audience bindings are replaced with real values.

## Acceptance criteria

- A fixture encrypted Matrix message is decrypted, normalized, persisted,
  retried after simulated response loss, accepted once, and projected once.
- Restart between any two sync-window steps preserves device identity, exact
  raw response and pending request bytes, and the prior committed checkpoint.
- A crash after SDK state advances but before the application creates an
  outbox reconstructs the same decrypted canonical event from the encrypted
  inbox without refetching the response.
- A missing-key event can receive a key from a later journaled sync response
  without committing either response out of order.
- Two tenants in one sync window produce separate batches and the checkpoint
  advances only after both are accepted.
- Unknown rooms and malformed events produce no archive object and no protected
  log value.
- A bounded 90-day WhatsApp-room backfill can resume without changing the live
  sync checkpoint.
- Backup and isolated restore recover the Matrix/E2EE store, gateway registry,
  outbox, and secrets without contacting live services.
- All repository checks pass and the branch receives spec, quality, security,
  and final phase approval before merge.
