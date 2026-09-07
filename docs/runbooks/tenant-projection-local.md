# Tenant Projection Durable Object: Local Runbook

This runbook is the local operator and developer reference for the
`TenantProjectionDO`. It describes the checked-in RPC, SQLite, replay, and
rebuild contracts. It does not provision Cloudflare resources, connect to a
remote account, or authorize a deployment.

## The simple model

There is one Durable Object namespace instance per canonical tenant ID. Each
instance owns a private SQLite database containing a query projection of
canonical messaging events. The projection is disposable: it can be cleared
and rebuilt without changing the systems that are authoritative for tenancy,
raw history, or operational messaging.

The normal data relationships are:

| System | Authority and responsibility |
| --- | --- |
| Control Directory in D1 | Authoritative tenants, principals, memberships, identities, grants, and non-secret account-to-connection placement. |
| Synapse | Operational messaging record and live Matrix history. It is not replaced by the projection. |
| Ordinary R2 archive | Immutable, committed canonical event batches and the source for a rebuild. A manifest is the replay listing/commit view. |
| `TenantProjectionDO` SQLite | Disposable tenant-scoped derived rows, query state, audit/change metadata, and replay checkpoints. It is not raw-event or authorization authority. |
| Authenticated Worker (future path) | Authenticates the principal, chooses the tenant, derives grants and connection bindings from D1, and routes to the exact tenant object. |

The existing browser UI remains on its current path in this phase. There is
no public projection route, and the projection modules do not read R2, write
R2, publish Queue work, call Matrix or a provider, send commands, open
WebSockets, or run alarms/automation. A `command.updated` event records an
observed command status; it never executes the command.

## Authority boundaries and deterministic routing

The router validates a canonical resource ID and passes that exact string to
the namespace:

```ts
env.TENANT_PROJECTION.getByName(tenantId)
```

Do not use a slug, display name, hash, caller-selected opaque object ID, or a
normalization of the tenant ID. The object is permanently bound by the first
successful `initialize` call. Every later RPC compares the supplied tenant to
the stored SQLite binding; a caller-selected tenant is never authority.

The Worker configuration is declarative:

```jsonc
"exports": {
  "TenantProjectionDO": { "type": "durable-object", "storage": "sqlite" }
}
```

`TENANT_PROJECTION` is repeated under the base, `staging`, and `production`
environment bindings because named-environment bindings are not inherited.
`TenantProjectionDO` is exported beside the unchanged default Worker export,
and its generated type is present in `worker-configuration.d.ts`. This phase
uses no legacy Durable Object migration array and does not deploy or provision
the namespace. The SQLite backend becomes a namespace property only when a
later approved deployment provisions it.

The constructor uses `blockConcurrencyWhile()` only to run the ordered
`_sql_schema_migrations` setup. `initialize` is the only RPC that creates
`projection_meta`; an uninitialized object returns `projection_not_found` for
all other operations.

## Local verification

Run these commands from the repository root. They use the local test runtime
and checked-in fixtures only:

```bash
pnpm --filter @communicator/control-plane test:worker
pnpm --filter @communicator/control-plane types:worker
pnpm check
python3 -m unittest tests.test_repository_contract -v
git diff --check
```

For a focused projection pass:

```bash
pnpm --filter @communicator/control-plane exec vitest run \
  --config vitest.worker.config.ts \
  worker/test/projection/routing.test.ts \
  worker/test/projection/schema.test.ts \
  worker/test/projection/apply-batch.test.ts \
  worker/test/projection/projector.test.ts \
  worker/test/projection/queries.test.ts \
  worker/test/projection/rebuild.test.ts
```

This invokes Vitest directly in the control-plane package, so the six listed
projection files are selection arguments rather than arguments silently
ignored by the `test:worker` wrapper.

The Task 8 repository gate also runs the prescribed repository scan for
credential-like fields and forbidden key material over the projection source,
this runbook, and Wrangler configuration. The pattern is assembled below only
so that this runbook does not match its own scan; after shell concatenation it
is the prescribed pattern and the paths are unchanged:

```bash
pattern_1="access[_-]?"key
pattern_2="secret[_-]?"key
pattern_3="BEGIN .*"PRIVATE" KEY"
pattern_4="provider_"cookie
pattern_5="matrix_"access"_token"
pattern_6="e2ee_"key
scan_pattern="${pattern_1}|${pattern_2}|${pattern_3}|${pattern_4}|${pattern_5}|${pattern_6}"
if ! command -v rg >/dev/null 2>&1; then
  echo "required scanner rg is not available" >&2
  exit 127
fi
if rg -n "$scan_pattern" apps/control-plane/worker/projection docs/runbooks/tenant-projection-local.md apps/control-plane/wrangler.jsonc; then
  scan_status=0
else
  scan_status=$?
fi
case "$scan_status" in
  1) exit 0 ;;
  0)
    echo "forbidden credential-like match found" >&2
    exit 1
    ;;
  *)
    echo "rg failed while scanning the required paths" >&2
    exit "$scan_status"
    ;;
esac
```

Expected result is no output and exit status zero: these paths must contain no
real credential or forbidden stored field. Test fixtures may contain literal
strings used to assert that the fields are rejected; those test-only strings
are under `tests/` and are intentionally outside this scan. A missing `rg`, an
unreadable path, or any scanner status other than the clean no-match status is
a verification failure. Do not use `wrangler deploy`, remote development,
bucket mutation, or any other remote Cloudflare command while following this
runbook.

## RPC authorization and scopes

Every RPC input carries `schema_version: 1`, `tenant_id`, and a narrow
authorization context. The context contains:

- `tenant_id` and `principal_id`;
- `allowed_identity_ids`, sorted and unique, with at most 500 IDs; and
- sorted, unique projection scopes.

The five projection scopes are:

| Operation | Required scope | Additional check |
| --- | --- | --- |
| `initialize` | `projection.initialize` | Tenant-wide; permanently establishes the tenant binding. |
| `applyBatch` | `projection.write` | Every distinct live-event identity must be in `allowed_identity_ids`. |
| `listConversations`, `listMessages`, `listChanges` | `projection.read` | The requested identity must be in `allowed_identity_ids`. |
| `beginRebuild`, `abortRebuild`, `completeRebuild` | `projection.rebuild` | Tenant-wide lifecycle operation; rebuild ID and generation are checked. |
| `applyReplayPage` | `projection.rebuild` | Tenant-wide replay, but callable only by the trusted R2-reader orchestration path. It deliberately does not use the identity allow-list. |
| `getStatus` | `projection.status` | Tenant-wide status read. |

The future authenticated Worker derives this context and the exact
account-to-connection bindings from trusted D1 directory rows. HTTP input
must never be forwarded as authority. The DO re-checks the context tenant,
input tenant, and stored tenant, defaults to deny, and never treats a selected
identity as proof of access. Missing scopes or identity grants return the
content-free `projection_forbidden` code.

## Account and resource identity invariants

`account_id` is the canonical remote-account reference. `connection_id` is the
Communicator channel/connection ID exposed in public projection results. They
are distinct and both are stored.

Every nonempty live batch or replay page supplies a duplicate-free list of
one-to-500 connection bindings sorted lexicographically by `account_id`. The
list must contain exactly one row for every distinct event `account_id`, with
no unused rows. Each row's identity and platform must agree with every event
that uses that account. An empty terminal replay uses `connections: []`.

The first accepted event for an account persists its binding in
`connection_bindings`. The object checks both unique directions before an
insert:

- an existing account must match its connection, identity, and platform; and
- an existing connection must not belong to another account.

Any remap or mismatch is `projection_conflict`, not a leaked SQLite
constraint error. Rebuilds do not clear this table. A future audited
reassignment workflow must explicitly decide whether to migrate history or
replace the object.

Communicator resource IDs are globally unique within a tenant, regardless of
identity, account, connection, conversation, or platform. The unscoped
resource primary keys are intentional. Reusing a message, participant,
reaction, attachment, command, or conversation ID under another owner is
corruption and fails closed. Matrix and remote aliases may overlap, but they
are never resource primary keys. Every child or pending row carries its owner
scope, and each handler verifies it before changing state.

## Event application and idempotency

The projection accepts the 17 versioned event payloads defined by
`ProjectionEventEnvelopeSchema`. For mutating RPCs, structural validation,
payload pairing, tenant/key cross-checks, bounds, canonical JSON
serialization, newline-inclusive byte counting, and hashing (where applicable)
complete before the state-transition transaction and before any write. A
read-only state lookup may precede that preflight—for example, to inspect the
stored tenant, lifecycle state, or current checkpoint—but it must not mutate
state.

Events are ordered for LWW decisions by `(observed_at, event_id)`, where the
timestamp is parsed to milliseconds and the event ID is compared by unsigned
UTF-8 bytes (shorter prefix first). Presentation activity uses occurred-time
tuples with deterministic event/resource-ID tie-breaks appropriate to the
stored family; archive enumeration and R2 source cursor progress are separate
orderings.

The canonical event line, including its final newline, is the event hash input.
Within one input, repeated IDs with identical canonical bytes collapse to one
event. A previously applied identical ID is a duplicate/domain no-op. A
repeated ID with a different canonical hash, owner binding, or immutable
envelope field is `projection_conflict`; the whole batch is rejected. An
older event can still be newly applied and produce audit/change metadata while
losing the mutable-state comparison. It must not overwrite the newer winner.

### The 17 payloads and their state effects

The envelope and every payload are strict: unknown fields, wrong enum values,
invalid IDs/timestamps, and out-of-bound strings/numbers are rejected before
SQL. The supported event types are:

| Event type | Payload and projection effect |
| --- | --- |
| `message.created` | Message ID, direction, sender reference/label, body, optional reply, initial delivery status, and unread flag. Creates the immutable created version and message shell. |
| `message.edited` | Message ID, replacement body, and optional editor. Adds a version; the greatest observed tuple supplies the visible body. |
| `message.deleted` | Message ID and nullable reason. Creates/updates a permanent message tombstone and redacts the message. |
| `reaction.added` | Reaction, message, participant, and emoji. Upserts reaction state by observed tuple. |
| `reaction.removed` | Reaction and message IDs. Stores a removed reaction without visible participant/emoji data. |
| `receipt.read` | Message, participant, and immutable local/remote classification. A local read clears unread when the message exists. |
| `receipt.delivered` | Message, participant, and immutable local/remote classification. It never changes local unread. |
| `typing.started` | Participant and expiry timestamp. Stores typing data; expiry is retained data, not a wall-clock deletion. |
| `typing.stopped` | Participant ID. Stores the stopped state. |
| `attachment.observed` | Attachment/message IDs and bounded metadata/reference. Stores metadata only; never attachment bytes. |
| `conversation.updated` | Bounded title plus archived/muted flags. Updates conversation metadata by observed tuple. |
| `participant.updated` | Participant, display name, optional remote ID, and optional avatar URL. Updates participant state by observed tuple. |
| `command.updated` | `message.send` command, direct/paced mode, status, and optional failure code. Records observation only. |
| `bridge.delivery.updated` | Message delivery status and optional failure code. Stores/reconciles delivery observation only. |
| `replay.tombstone` | Target opaque event ID and reason. Records a marker-only correction. |
| `correction.applied` | Target opaque event ID and reason. Uses the same marker-only path. |
| `deletion.tombstone` | Message, conversation, participant, or attachment ID and reason. Creates a resource tombstone and applies redaction. |

Child observations can precede their primary target: edits, deletes, reaction
removal, receipts, delivery updates, and attachment observations are retained
as bounded pending/version/tombstone state and reconciled when the target
arrives. The later target must match the owner already claimed by pending
state. Reused IDs across resource families or owner tuples fail closed.

Conversation shells use event occurrence time and event-ID tie-breaks. Message
body versions use observed time and opaque event-ID tie-breaks; visible message
activity uses occurred time and message-ID tie-breaks. Summaries are recomputed
once per touched conversation, in sorted conversation-ID order, from normalized
rows in the same transaction. Active messages determine message count, inbound
unread count, non-deleted attachment count, a 280-character preview, and
activity; a message-less shell falls back to shell activity.

The local/remote receipt flag is immutable for each
`(message_id, participant_id, receipt_type)` key. A local read uses the event's
`occurred_at` as `local_read_at` and clears unread; a remote receipt never
does. A newer event cannot change the classification. Delivery and command
status remain observed-only and never send, schedule, retry, acknowledge, or
mutate another system. Event markers validate their target owner and record
bounded audit metadata only.

Important payload bounds are message bodies up to 20,000 characters,
sender/display labels up to 100, titles up to 200, emoji up to 64, filenames
and MIME values up to 255, remote IDs up to 1,024, avatar URLs up to 2,048,
reason/failure codes up to 100, and attachment references up to 512. Opaque
event IDs are at most 1,024 characters and canonical resource IDs are at most
128 printable-ASCII characters. The explicit 64-character timestamp limit
applies to the canonical envelope's `occurred_at` and `observed_at`, and to
`ProjectionCheckpointInput.last_observed_at`, which uses the same bounded
timestamp schema; each remains an offset-aware datetime. Lifecycle fields
`initialized_at`, `started_at`, `completed_at`, and `failed_at`, typing
`expires_at`, and status checkpoint `updated_at`/`last_observed_at` use the
offset-aware `TimestampSchema` without an additional character-length bound in
this contract. Projection parses event and checkpoint timestamps to safe
millisecond values for ordering; lifecycle timestamps are caller-supplied and
must not be replaced with wall-clock time. The canonical JSON graph is bounded
to depth 32, 50,000 nodes, 10,000 collection entries, 256-character object
keys, and 1,048,576-character strings.

The stable error codes are deliberately content-free:

| Condition | Code |
| --- | --- |
| Malformed contract, unsupported projection payload, or invalid cursor/page | `projection_invalid` |
| Tenant disagreement | `projection_tenant_mismatch` |
| Missing scope or identity grant | `projection_forbidden` |
| Count or byte bound exceeded | `projection_too_large` |
| Uninitialized object | `projection_not_found` |
| Ready-only operation while rebuilding | `projection_rebuilding` |
| Query/live/replay operation after abort | `projection_rebuild_failed` |
| Wrong rebuild ID/generation, replay in ready state, or incomplete terminal state | `projection_rebuild_mismatch` |
| Hash/binding/owner conflict or replay cursor/digest conflict | `projection_conflict` |
| Unexpected runtime or SQLite failure | `projection_unavailable` |

## SQLite tables and indexes

Schema version 1 is recorded in `_sql_schema_migrations` with fixed migration
metadata. All tables are strict SQLite tables. The schema is intentionally a
derived-state schema; do not add raw archive, grant, session, or credential
storage to it.

| Group | Tables | Purpose |
| --- | --- | --- |
| Lifecycle and durable identity | `_sql_schema_migrations`, `projection_meta`, `connection_bindings`, `completed_rebuilds`, `failed_rebuilds` | Schema version, permanent tenant binding, connection invariant, and bounded rebuild history. |
| Query state | `conversations`, `participants`, `messages`, `message_versions`, `reactions`, `receipts`, `typing_states`, `attachments`, `commands`, `message_delivery_updates` | Tenant/identity/connection-scoped interactive state, including pending child events. |
| Redaction and audit | `event_tombstones`, `resource_tombstones`, `applied_events` | Marker-only event audit and resource deletion gates, plus event idempotency records. |
| Recovery and progress | `projection_changes`, `projection_change_floors`, `projection_checkpoints` | Tenant-global change sequence, per-identity retention floors, and live/R2 source progress. |

Indexes follow access paths rather than adding redundant single-column
indexes:

- conversation seeks use identity plus activity, with a second path for
  identity plus connection plus activity;
- message seeks use identity/conversation/occurrence, while partial alias
  indexes cover Matrix event, remote message, reply target, and sender
  participant lookups;
- owner indexes on messages, versions, reactions, receipts, attachments,
  delivery updates, commands, event tombstones, and resource tombstones make
  cross-owner checks and conversation redaction bounded;
- version, reaction, receipt, attachment, delivery, and tombstone state have
  their message/resource ordering indexes; participant and typing lookups have
  their participant/conversation paths; and
- applied events use observed order, changes use identity/sequence, and
  resource tombstones use resource/order and resource ID paths.

The current index names are `idx_conversations_identity_activity`,
`idx_conversations_identity_connection_activity`,
`idx_messages_identity_conversation_occurred`,
`idx_messages_matrix_event`, `idx_messages_remote_message`,
`idx_messages_reply_target`, `idx_messages_sender_participant`,
`idx_messages_conversation_owner`, `idx_message_versions_message_order`,
`idx_message_versions_editor_participant`,
`idx_message_versions_conversation_owner`, `idx_participants_conversation_name`,
`idx_reactions_message_state`, `idx_reactions_participant`,
`idx_reactions_conversation_owner`, `idx_receipts_message_type_time`,
`idx_receipts_participant`, `idx_receipts_conversation_owner`,
`idx_typing_participant`, `idx_attachments_message_state`,
`idx_attachments_conversation_owner`, `idx_delivery_message_order`,
`idx_delivery_conversation_owner`, `idx_commands_conversation_owner`,
`idx_event_tombstones_conversation_owner`, `idx_applied_events_order`,
`idx_projection_changes_identity_sequence`,
`idx_resource_tombstones_resource_order`, `idx_resource_tombstones_id`, and
`idx_resource_tombstones_conversation_owner`. Query changes must preserve the
seek/owner access paths rather than silently introducing a full-table scan.

The schema tests are the source of truth for exact columns, checks, and index
names. Do not copy an entire DDL statement into an operational change or use
`PRAGMA user_version`.

## Transaction boundary

The boundary is intentionally easy to audit:

1. Parse a descriptor-safe copy of the RPC input.
2. Check authorization, tenant, event/page shape, binding coverage, bounds,
   canonical bytes, event hashes, and (for replay) the page digest.
3. Enter exactly one synchronous `transactionSync()` for the state transition.
4. In that transaction, verify persistent bindings, read applied markers,
   project new events, insert markers and one `projection_changes` row per new
   event, recompute touched summaries, trim changes, and mutate the applicable
   checkpoint.
5. Return plain structured-clone-safe data after the transaction succeeds.

No `await`, R2/D1/Queue call, network I/O, provider action, or remote command
may run inside the transaction. Any `ProjectionError`, owner mismatch,
constraint failure, or unexpected exception rolls back derived rows, markers,
change rows, and checkpoint changes together. Constructor schema setup is the
only initialization work allowed in `blockConcurrencyWhile()`.

## Live and R2 checkpoint mutation contract

The live generic checkpoint and the reserved R2 source-progress checkpoint are
different protocols. `applyBatch` cannot write the reserved
`r2_manifest_cursor` row; only `applyReplayPage` can maintain it.

For any nonempty batch, `applied_count` is the number of unique event IDs
newly inserted. `duplicate_count` is `input event count - applied_count`,
including repeated IDs within the input and already-applied IDs. Both counts
and `last_sequence` (the tenant-global maximum after the transaction, or zero)
are returned from the same transaction.

### Generic live checkpoint (`applyBatch`)

| Case | Required behavior |
| --- | --- |
| No checkpoint input | Leave `projection_checkpoints` unchanged, including for a duplicate-only batch. |
| Checkpoint with no existing row | Insert its value, last-observed tuple, current generation, and `last_sequence`; set `source_cursor`, `page_digest`, `last_applied_count`, and `last_duplicate_count` to null; set `updated_at` to `last_observed_at`. |
| Incoming tuple newer than the stored tuple | Replace value, observed timestamp/milliseconds, event ID, generation, and `updated_at`; clear all replay-only source/digest/count fields and set `last_sequence` to the post-transaction global maximum, even for a duplicate-only batch. |
| Incoming tuple exactly equal | The same value and timestamp are a no-op. A different value or timestamp at that tuple is `projection_conflict`. |
| Incoming tuple older | Leave the newer stored checkpoint unchanged; event idempotency and result counts still apply. |

### R2 replay checkpoint (`applyReplayPage`)

| Case | Required behavior |
| --- | --- |
| First or new page | After source-cursor and digest validation, set `value` to `next_cursor` or `terminal`, record the input source cursor and computed digest/current generation, and store that page's applied/duplicate counts and post-page sequence. |
| Event tuple across replay pages | Retain the greatest `(observed_ms, event_id)` seen across all pages, not merely the latest R2 page. A later page with older events still advances source progress while preserving the retained tuple. |
| Replay checkpoint `updated_at` | Use the retained event's original `observed_at`; with no events preserve the prior value, or use `rebuild_started_at` for the first empty terminal page. |
| Exact same-page retry | Same source cursor plus the same computed digest returns the stored page counts and sequence without event or checkpoint writes. A different digest is `projection_conflict`. |
| Empty terminal replay | Return zero applied/duplicate counts and the current global sequence. Write terminal source progress and digest; when the archive is empty, tuple fields remain null. |

The caller never supplies `page_digest`. The DO computes lowercase SHA-256 over
the canonical JSON of `{ source_cursor, connections, page }`. Source progress
is not event/LWW ordering.

## Replay continuity and its deliberate limitation

`applyReplayPage` is an internal-only RPC for the future trusted reader that
lists committed R2 manifests. It accepts a page; it never reads R2 itself.
Only that orchestration path may call it. The future Worker must not expose it
as a public route or arbitrary service binding.

Replay rules are:

- the page tenant must equal the RPC, authorization, and stored tenant;
- the first source cursor is `null`, and each later source cursor must equal
  the immediately preceding persisted `next_cursor` exactly;
- non-null cursors must pass canonical, tenant-bound decoding; a terminal
  checkpoint cannot be advanced as a new page (an exact same-page retry is
  allowed when its source cursor and digest match);
- a non-null `next_cursor` equal to the non-null source cursor is a conflict;
  the permitted `null`/`null` form is the first, single, or empty terminal page;
- a nonempty page has at least one manifest, projection-valid events, and at
  most 500 events and 4 MiB of canonical projection input; an empty page is
  legal only as `{ manifests: [], events: [], next_cursor: null }` with no
  bindings;
- archive schema validity alone is insufficient: a page can be valid archive
  data but still contain an unsupported projection payload, which fails the
  complete page before the state-transition transaction or any write; and
- an oversized immutable page is rejected before the state-transition
  transaction or any write so the trusted reader can retry the same source
  cursor with a smaller page (normally one manifest).

The encoded Cloudflare R2 cursor is opaque. The DO can enforce exact adjacent
cursor equality, tenant binding, same-page digest idempotency, and non-null
self-loop rejection, but it cannot prove that the opaque cursor is monotonic,
detect a hidden jump, or classify an arbitrary mismatch as a skipped page or
rewind. The trusted `readReplayPage` implementation owns manifest-prefix
listing correctness. Independent no-skip proof would require a future archive
snapshot/ordinal contract migration.

## Rebuild, resume, and abort recovery

The lifecycle is `ready -> rebuilding -> ready`, or
`ready -> rebuilding -> rebuild_failed -> rebuilding` for a fresh recovery
attempt.

### Start and resume

1. Ensure the object is initialized and read status with
   `projection.status`.
2. Call `beginRebuild` with the current `expected_generation`, a new
   canonical `rebuild_id`, and a caller-supplied `started_at`. Neither a
   completed nor failed rebuild ID may ever be reused. The operation clears
   derived events, query rows, change rows/floors, and checkpoints in one
   transaction, increments the generation, and preserves schema, tenant
   binding, connection bindings, and rebuild history.
3. Read committed R2 pages through the trusted replay reader and pass each
   page to `applyReplayPage` with the active rebuild ID. Ordinary queries and
   live apply are rejected while rebuilding; status remains available.
   A retry of `beginRebuild` with the same ID is status-only only when its
   `started_at` matches and `expected_generation` is the current generation
   minus one; a changed lifecycle request is a mismatch.
4. If the process crashes after a page commits, use the persisted replay
   checkpoint's `value` as the next source cursor. If the page did not commit,
   retry the same source cursor and page; the same digest is idempotent. DO
   eviction or recreation is safe because resume state is in SQLite, not an
   in-memory field.
5. Call `completeRebuild` only after the current-generation replay checkpoint
   has value `terminal`, with the active rebuild ID and caller-supplied
   `completed_at`. Completion changes the state to `ready` and records bounded
   history. The exact completion retry is idempotent; another ID is a mismatch.

### Abort an invalid or unrecoverable page

An invalid immutable page remains unapplied: it does not advance the source
cursor and does not leave partial rows from that page. If the operator cannot
continue, call `abortRebuild` with the exact active rebuild ID, a supplied
`failed_at`, and one bounded failure code: `operator_abort`,
`unsupported_archive`, `archive_gap`, `binding_conflict`, or
`validation_failed`. The transaction removes all partial
projection content, applied markers, change rows/floors, and checkpoints. It
retains only bounded failure metadata in `failed_rebuilds` and
`projection_meta`, while preserving schema, tenant binding, connection
bindings, and rebuild histories.

The failed object does not expose partial data and rejects ordinary queries,
live apply, and replay. An exact abort retry is idempotent; changed details or
another ID fail closed. There is no skip-event escape hatch. Because R2 is
immutable, an unsupported page requires a corrected projector/reader or a
contract migration. After that correction, begin a fresh rebuild with a
never-used ID and replay the archive evidence again; the operator does not
silently skip the bad page.

## Query cursors, generations, and change gaps

Conversation and message queries require `projection.read`, an allowed
identity, and `projection_meta.state = ready`. Deleted conversations are
omitted; a directly requested deleted message remains present but redacted.
Page sizes are 1..100, with a default of 50. Cursors are canonical opaque
base64url values capped at 2,048 characters and bind the query kind, tenant,
identity, conversation/connection filter, and current generation. A cursor
from an earlier rebuild generation is `projection_conflict`; SQLite offsets
are never exposed.

`listConversations` seeks by descending non-null activity time and ascending
conversation ID, optionally filtered by connection. `listMessages` first proves
that the conversation is active and owned by the requested identity, then
seeks by descending occurrence time and ascending message ID. A deleted
message's result is redacted and public results expose `connection_id`, never
the internal account or provider/Matrix aliases.

`listChanges` returns metadata only: event ID/type, identity, connection,
conversation, timestamps, generation, and sequence. It never returns a body
or full payload. The projection retains at most 10,000 recent change rows per
tenant. When older rows are trimmed, `projection_change_floors` records the
greatest discarded sequence per identity. If `after_sequence` is below that
floor, the response has no items and `reset_required: true`; it never silently
pretends that a gap was replayed. A change query must use the current
generation. A rebuild clears the change buffer and starts a new sequence for
the new generation.

## Limits and bounded SQL

Application limits are intentionally below platform ceilings:

| Limit | Value |
| --- | ---: |
| Events per live/replay projection batch | 500 |
| Canonical projection bytes per batch | 4 MiB |
| Query page size | 1..100 (default 50) |
| Query cursor length | 2,048 characters |
| Generic checkpoint value | 4,096 characters |
| Authorization identities and connection bindings | 500 each |
| Retained change rows per tenant | 10,000 |

Cloudflare's [Workers platform limits](https://developers.cloudflare.com/workers/platform/limits/)
currently documents 128 MB Worker memory. Cloudflare also documents 10 GB per
SQLite-backed Durable Object, at most 100 bound SQL parameters per query, and a
2 MB per-string/BLOB/row limit. Dynamic event-ID lookups therefore use deterministic
chunks of at most 90 parameters, never one 500-placeholder `IN` expression.
The R2 archive reader has looser replay-page ceilings (at most 100 manifests,
2,000 aggregate events, and 8 MiB uncompressed), but the projection boundary
still enforces the 500-event/4-MiB limits above. Archive objects separately
cap one canonical event at 1 MiB, one batch at 4 MiB uncompressed/5 MiB
compressed, and one manifest at 64 KiB.

## Media keys and redaction

An attachment stores metadata and an optional R2 reference, never bytes. A
null reference is valid. A non-null reference requires a non-null lowercase
SHA-256 and must equal exactly:

```text
media/<tenant_id>/<sha256>
```

Another tenant's prefix, traversal-like key, or hash/key mismatch is
`projection_invalid`. The projection neither fetches nor writes the media
object.

Message text and normalized metadata needed for queries may be stored. The
projection must not store attachment bytes, cryptographic key material,
provider sessions/tokens/cookies, Matrix credentials, bridge secrets, or
authorization claims. Errors and logs contain only stable codes and bounded
metadata; they must not contain payload text, cursors, SQL bindings,
authorization material, or raw runtime causes. `ProjectionError` exposes only
its stable code/message across RPC; diagnostic causes remain module-private.

Resource tombstones are permanent redaction gates. They dominate older and
later non-tombstone arrivals, which may remain in audit/change rows but cannot
resurrect content:

- a deleted message returns an empty body, `Deleted sender`, zero attachment
  count, no aliases/reply reference, and no delivery failure detail;
- a deleted participant returns `Deleted participant` with remote/avatar data
  cleared;
- a deleted conversation is omitted from conversation pages, has a fixed
  deleted title, empty preview, and zero counters, and clears child content;
- deleted attachments clear filename, MIME, size, hash, and R2 reference;
- reactions, receipts, typing rows, and delivery/command failure detail are
  removed or cleared according to their resource scope; and
- `replay.tombstone` and `correction.applied` are audit/control markers only.
  They do not retroactively reproject a target; upstream must emit a separate
  corrected or deleted domain event.

## Explicitly excluded scope

This local projection phase does not include:

- HTTP/API routes, WebSocket endpoints, UI data-source changes, or public
  exposure of projection RPCs;
- Queue producers/consumers, Matrix event consumers, provider integrations,
  outbound command execution, paced delivery, alarms, or automation;
- live R2 replay orchestration, R2 writes, bucket creation, object deletion,
  export generation, or deployment;
- D1 schema changes or copying authorization state into the DO;
- media bytes, retention erasure, legal hold, orphan cleanup, or a second raw
  event archive in SQLite; or
- R2 Data Catalog, Pipelines, Brain, LinkedIn, Matrix/mautrix, Compose, or VPS
  changes.

The durable boundaries are therefore explicit: R2 remains the rebuild
archive, Synapse remains the operational messaging record, D1 remains the
future source for authentication-derived grants and connection mappings, and
DO SQLite remains disposable derived state.

## Official Cloudflare references

These are the current references selected by the implementation plan:

- [Durable Object migrations and declarative SQLite exports](https://developers.cloudflare.com/durable-objects/reference/durable-objects-migrations/)
- [Durable Object bindings in named environments](https://developers.cloudflare.com/durable-objects/reference/environments/)
- [Durable Object stubs and RPC](https://developers.cloudflare.com/durable-objects/best-practices/create-durable-object-stubs-and-send-requests/)
- [Workers RPC error handling](https://developers.cloudflare.com/workers/runtime-apis/rpc/error-handling/)
- [`transactionSync()` and the SQLite storage API](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/)
- [Durable Object state and `blockConcurrencyWhile()`](https://developers.cloudflare.com/durable-objects/api/state/)
- [Workers platform limits](https://developers.cloudflare.com/workers/platform/limits/)
- [Durable Object platform limits](https://developers.cloudflare.com/durable-objects/platform/limits/)
