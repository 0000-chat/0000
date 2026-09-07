# TenantProjectionDO SQLite Projection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add one SQLite-backed `TenantProjectionDO` per tenant that atomically and idempotently projects canonical messaging events into tenant- and identity-scoped conversation/message query state, supports deterministic replay and resumable rebuilds, and remains internal to the Worker in this phase.

**Architecture:** The Worker routes a validated tenant ID to `TENANT_PROJECTION.getByName(tenantId)`. An explicit, idempotent `initialize` RPC permanently binds the object to that tenant before any other operation; every later RPC validates the supplied tenant against SQLite. The object preflights and hashes a bounded batch before entering one synchronous SQLite transaction, and records an applied-event marker in the same transaction as every derived row, checkpoint, and change-sequence entry. Ordinary R2 remains the replayable raw archive; this SQLite database is disposable derived state and never becomes the authority for raw events, access control, provider sessions, or outbound commands.

**Tech Stack:** TypeScript 7, Zod 4, Cloudflare Workers, declarative Wrangler `exports`, SQLite-backed Durable Objects, Durable Object RPC, `ctx.storage.sql`, `ctx.storage.transactionSync`, `@cloudflare/vitest-plugin`, Vitest, and the existing canonical JSON/archive contracts.

**Execution policy:** The primary agent is the orchestrator and final reviewer. Dispatch exactly one implementation task at a time to a fresh worker with `model=gpt-5.6-luna`, `reasoning_effort=max`, and `fork_turns=none`; never use a Sol model for implementation. Give the worker the complete task text and bounded repository context rather than asking it to discover the plan. Each worker follows TDD, self-reviews, runs the task gates, commits, and returns `DONE`, `DONE_WITH_CONCERNS`, `NEEDS_CONTEXT`, or `BLOCKED`. Before advancing, obtain spec-compliance review and then code-quality review; use the same Luna/max/none configuration for testing workers, return every finding to the responsible implementer, and repeat review until PASS.

---

## Simple explanation

Each customer workspace gets its own small, private SQLite database. When the same event arrives twice, the second copy cannot change message/conversation state; a newer source checkpoint may still advance so ingestion does not stall. When archived events are replayed, they rebuild the same conversations and messages without sending anything back to WhatsApp, Telegram, Messenger, LinkedIn, or Matrix. Queries name an identity and carry a narrow permission context, so the Human inbox and Agent inbox cannot be mixed by a missing SQL filter or by merely selecting another identity.

This phase builds the internal database and typed RPC boundary only. The existing browser UI remains on its current API/simulated-data path. A later phase will connect authenticated HTTP/WebSocket APIs and Queue ingestion to these RPCs.

## Locked phase decisions

1. One `TenantProjectionDO` is addressed by the exact canonical tenant ID with `getByName(tenantId)`.
2. Use Cloudflare's current declarative `exports` configuration with `storage: "sqlite"`, not the legacy Wrangler `migrations` array. This repository has never provisioned a DO namespace, so no migration from the legacy form is needed. Do not deploy in this phase; the SQLite backend becomes an irreversible namespace property only when provisioned.
3. Repeat the `TENANT_PROJECTION` binding in the base, staging, and production environments because Durable Object bindings are not inherited. The top-level `exports` declaration is inherited by named environments.
4. Export a class extending `DurableObject<Cloudflare.Env>` from `worker/index.ts`; use typed RPC methods, not a DO `fetch()` handler.
5. Use `_sql_schema_migrations`, never `PRAGMA user_version`. Run only schema setup in constructor `blockConcurrencyWhile()`.
6. Use `ctx.storage.transactionSync()` for every multi-table state transition. Preflight validation and hashing happen before the transaction; no `await`, external I/O, R2 call, D1 call, Queue call, or provider action occurs inside it.
7. Do not change `CanonicalEventEnvelopeSchema`. Add a stricter, versioned projection-input schema around its `payload`. This preserves the already-merged R2 archive contract while defining exactly what this projector can materialize.
8. Every accepted new event inserts `applied_events`, its derived rows, one `projection_changes` row, and an optional checkpoint update atomically. Equal `event_id` plus equal canonical hash/binding is an event/domain no-op; an independently newer valid live checkpoint may still advance atomically. Equal ID plus different hash or binding aborts the whole batch with `projection_conflict`.
9. Sort a preflighted batch by `Date.parse(observed_at)`, then validated opaque `event_id` using unsigned UTF-8 byte order (shorter prefix first). State tables use the same BINARY tie-break so out-of-order application converges across JavaScript and SQLite.
10. Conversation summaries are recomputed from normalized rows for touched conversations inside the same transaction. Do not maintain unread or attachment totals using unguarded deltas.
11. `initialize` is the only RPC allowed to create `projection_meta`. Every other RPC fails with `projection_not_found` before initialization and must match the stored tenant afterward. The future Worker remains responsible for authenticating principals and deriving D1-backed grants; every DO RPC nevertheless receives a narrow trusted authorization context, matches its tenant, and re-checks operation/identity scope. A caller-selected tenant or identity is never authority.
12. Rebuild is an explicit `ready -> rebuilding -> ready|rebuild_failed` state machine. Partial rebuild data is never returned by ordinary query RPCs. An operator can atomically abort an unrecoverable partial rebuild into a content-free failed state, then begin a fresh rebuild with a never-used ID; neither completed nor failed rebuild IDs can be reused. Replay RPCs never emit remote commands, Queue messages, alarms, WebSockets, or automation.
13. Store message text and normalized metadata needed for interactive queries, but never attachment bytes, E2EE keys, provider cookies/tokens, Matrix access tokens, bridge secrets, or auth claims. Attachments contain metadata and optional R2 keys only.
14. Keep at most 10,000 recent projection change rows per tenant. This is a WebSocket-recovery buffer, not a second raw-event archive.
15. Canonical `account_id` and Communicator `connection_id` are distinct. Trusted ingestion/replay supplies an exact D1-derived mapping; projection stores both and public channel-facing results use `connection_id` only.
16. Communicator resource IDs are globally unique within a tenant. A participant ID identifies one conversation-participation resource rather than a cross-conversation contact. Reusing any resource ID under another identity, connection, or conversation is corruption and fails closed; overlapping provider/Matrix aliases do not weaken that invariant.
17. Only intended RPC methods may be visible on the exported `TenantProjectionDO` prototype. TypeScript `private` is not a runtime RPC boundary; every internal helper on the class must use ECMAScript `#private` syntax, or be a module-private function. Tests must prove no transaction, SQL, authorization, status-reading, binding, checkpoint, trim, or projector helper is reflectively present/callable as an ordinary property on a live DO instance.

## Explicitly excluded scope

- no HTTP/API route changes and no UI data-source changes;
- no Queue producer/consumer or Matrix event consumer;
- no live R2 replay orchestration, R2 writes, bucket creation, or deployment;
- no WebSocket endpoint, alarm, paced delivery, outbound command execution, or automation;
- no D1 schema changes or copying authorization state into the DO;
- no media bytes, export generation, retention erasure, legal hold, or orphan cleanup;
- no R2 Data Catalog, Pipelines, or Brain integration;
- no LinkedIn branch integration and no Matrix/mautrix/Compose/VPS changes.

## Current Cloudflare references that constrain the implementation

- New Durable Object classes should use declarative `exports` and SQLite: <https://developers.cloudflare.com/durable-objects/reference/durable-objects-migrations/>
- Named environments must repeat Durable Object bindings: <https://developers.cloudflare.com/durable-objects/reference/environments/>
- RPC methods require serializable parameters/results and compatibility date `2024-04-03` or later: <https://developers.cloudflare.com/durable-objects/best-practices/create-durable-object-stubs-and-send-requests/>
- Enhanced Workers RPC error serialization is enabled by the configured compatibility date and preserves serializable own properties, including non-enumerable `cause`; raw diagnostic causes therefore must not be Error properties: <https://developers.cloudflare.com/workers/runtime-apis/rpc/error-handling/>
- `transactionSync()` is SQLite-only, synchronous, and rolls back when its callback throws: <https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/>
- Use constructor `blockConcurrencyWhile()` only for initialization/schema migration: <https://developers.cloudflare.com/durable-objects/api/state/>
- Current limits include 128 MB Worker memory, 10 GB per SQLite-backed Durable Object, at most 100 bound parameters per SQL query, and at most 2 MB per string/BLOB/row; account-level quotas are separate and plan-dependent: <https://developers.cloudflare.com/durable-objects/platform/limits/>

Do not copy numeric prices into code or tests. The limits above are operational guardrails, not reasons to approach the platform maximums.

## Exact file map

- Create `packages/contracts/src/projection.ts`: event-specific payloads, RPC inputs/results, cursor payloads, rebuild/checkpoint/status contracts, and product bounds.
- Create `packages/contracts/test/projection.test.ts`: strict contract and boundary tests.
- Modify `packages/contracts/src/canonical-event.ts`: export the existing opaque event-ID schema as `OpaqueEventIdSchema`; do not narrow event IDs to Communicator resource IDs.
- Modify `packages/contracts/src/conversation.ts`: export the existing delivery-status enum as `DeliveryStatusSchema` and add only the message page result contract.
- Modify `packages/contracts/src/index.ts`: export projection contracts.
- Create `apps/control-plane/worker/projection/errors.ts`: stable error codes and a content-redacting error class.
- Create `apps/control-plane/worker/projection/cursor.ts`: canonical opaque seek cursors bound to tenant, identity, filters, and query kind.
- Create `apps/control-plane/worker/projection/schema.ts`: ordered SQL schema migrations and schema runner.
- Create `apps/control-plane/worker/projection/projector.ts`: pure/preflight helpers and synchronous event-to-SQL projection logic.
- Create `apps/control-plane/worker/projection/tenant-projection.ts`: `TenantProjectionDO` RPC class and transaction/rebuild/query orchestration.
- Create `apps/control-plane/worker/projection/routing.ts`: deterministic namespace routing helper.
- Create focused tests under `apps/control-plane/worker/test/projection/`.
- Modify `apps/control-plane/worker/index.ts`: export `TenantProjectionDO`; do not alter the default application export.
- Modify `apps/control-plane/wrangler.jsonc`: declarative class export plus three environment bindings.
- Regenerate `apps/control-plane/worker-configuration.d.ts`; never hand-edit it.
- Create `docs/runbooks/tenant-projection-local.md`.
- Modify `tests/test_repository_contract.py` only for stable scope/configuration guards.

## Contract shapes

### Projection payloads

Create strict Zod payload schemas. All object schemas are `.strict()`. Reuse `CanonicalResourceIdSchema`, `OpaqueEventIdSchema`, `TimestampSchema`, `DeliveryModeSchema`, `CommandStatusSchema`, and `DeliveryStatusSchema`. Export `OpaqueEventIdSchema` from `canonical-event.ts` by renaming/exporting its existing private `OpaqueIdSchema`; preserve its accepted values and all canonical-envelope behavior. Export `DeliveryStatusSchema` from `conversation.ts` by naming its existing inline enum; preserve its accepted values and use it in `MessageSchema` as well as projection contracts.

| `event_type` | Exact payload |
| --- | --- |
| `message.created` | `{ message_id, direction: "inbound" | "outbound", sender_participant_id: resource ID \| null, sender_label: 1..100 chars, body: 0..20,000 chars, reply_to_message_id: resource ID \| null, delivery_status, unread: boolean }` |
| `message.edited` | `{ message_id, body: 0..20,000 chars, editor_participant_id: resource ID \| null }` |
| `message.deleted` | `{ message_id, reason_code: 1..100 chars \| null }` |
| `reaction.added` | `{ reaction_id, message_id, participant_id, emoji: 1..64 chars }` |
| `reaction.removed` | `{ reaction_id, message_id }` |
| `receipt.read` | `{ message_id, participant_id, local_identity: boolean }` |
| `receipt.delivered` | `{ message_id, participant_id, local_identity: boolean }` |
| `typing.started` | `{ participant_id, expires_at: timestamp }` |
| `typing.stopped` | `{ participant_id }` |
| `attachment.observed` | `{ attachment_id, message_id, file_name: string(0..255) \| null, mime_type: string(1..255) \| null, size_bytes: nonnegative safe integer \| null, sha256: 64 lowercase hex \| null, r2_key: printable ASCII string(1..512) \| null }` |
| `conversation.updated` | `{ title: string(1..200), archived: boolean, muted: boolean }` |
| `participant.updated` | `{ participant_id, display_name: string(1..100), remote_id: string(1..1024) \| null, avatar_url: string(1..2048) \| null }` |
| `command.updated` | `{ command_id, operation: "message.send", delivery_mode, status, failure_code: string(1..100) \| null }` |
| `bridge.delivery.updated` | `{ message_id, delivery_status, failure_code: string(1..100) \| null }` |
| `replay.tombstone` | `{ target_event_id: OpaqueEventId, reason_code: string(1..100) }` |
| `correction.applied` | `{ target_event_id: OpaqueEventId, reason_code: string(1..100) }`; the corrected domain event must be a separate canonical event |
| `deletion.tombstone` | `{ resource_type: "message" \| "conversation" \| "participant" \| "attachment", resource_id, reason_code: string(1..100) }` |

`ProjectionEventEnvelopeSchema` first validates `CanonicalEventEnvelopeSchema`, then validates `payload` with the schema selected by `event_type`. Reject an unknown field, wrong payload/event pairing, getter, symbol, prototype-sensitive input, oversized string, non-finite number, or non-JSON value before any SQL call. Export `parseProjectionEvent()` to return a copy-safe normalized value; do not mutate caller objects.

For `attachment.observed`, cross-field validation is tenant-bound: `r2_key=null` is allowed; a nonnull key requires nonnull `sha256` and must equal exactly ``media/${event.tenant_id}/${payload.sha256}``. Reject every other printable key, including another tenant's prefix, traversal-like segments, and a hash/key mismatch. This phase stores the reference only and never fetches or writes the media object.

### RPC inputs and bounds

Use these exported constants:

```ts
export const MAX_PROJECTION_BATCH_EVENTS = 500;
export const MAX_PROJECTION_BATCH_BYTES = 4 * 1024 * 1024;
export const DEFAULT_PROJECTION_PAGE_SIZE = 50;
export const MAX_PROJECTION_PAGE_SIZE = 100;
export const MAX_PROJECTION_CURSOR_CHARS = 2_048;
export const MAX_PROJECTION_CHECKPOINT_VALUE_CHARS = 4_096;
export const MAX_PROJECTION_CHANGES = 10_000;
```

Define one narrow authorization context now so later API work cannot accidentally treat a selected identity as authority:

```ts
type ProjectionScope =
  | "projection.initialize"
  | "projection.write"
  | "projection.read"
  | "projection.rebuild"
  | "projection.status";

type ProjectionAuthorizationContext = {
  schema_version: 1;
  tenant_id: CanonicalResourceId;
  principal_id: CanonicalResourceId;
  allowed_identity_ids: CanonicalResourceId[]; // 0..500, lexicographically sorted, unique
  scopes: ProjectionScope[];                    // 1..5, lexicographically sorted, unique
};

type ProjectionConnectionBinding = {
  account_id: CanonicalResourceId;
  connection_id: CanonicalResourceId;
  identity_id: CanonicalResourceId;
  platform: "whatsapp" | "telegram" | "messenger" | "linkedin";
};
```

The future authenticated Worker constructs authorization and connection bindings from trusted D1 directory results; HTTP input must never be forwarded as authority. This phase exposes no public route, but every DO RPC requires `authorization.tenant_id === input.tenant_id === stored tenant`, validates the required scope, and defaults to deny. Identity-scoped calls require the requested identity in `allowed_identity_ids`; live batch writes require every event identity in that set. The Worker sends only the grant subset relevant to that call, so the 500-item transport bound does not cap a principal's total directory grants. Tenant-wide initialization/status/rebuild require their dedicated scopes; replay is tenant-wide and does not depend on `allowed_identity_ids`. This is defense in depth, not a claim that a DO binding authenticates a principal by itself.

`account_id` is the canonical remote-account reference and is **not** a Communicator channel/connection ID. Every nonempty live or replay page supplies `connections`, a duplicate-free list of 1..500 `ProjectionConnectionBinding` rows sorted lexicographically by `account_id` (the unique key). It must contain exactly one row for every distinct event `account_id`, no unused rows, and each row's identity/platform must match all corresponding envelopes. Empty terminal replay supplies `connections: []`. The DO stores both IDs; public conversation/message/change results and filters use only `connection_id`. A duplicate canonical event must also match its previously stored connection binding or fail `projection_conflict`.

The first accepted event for an account inserts a tenant-persistent `connection_bindings` row. Before insertion, check both the account primary key and connection unique key explicitly: an existing account must match connection/identity/platform exactly, and an existing connection may not belong to another account. Either mismatch is `projection_conflict`, never a leaked SQLite uniqueness error. Every later event and rebuild page follows the same rule. Rebuild does **not** clear this table. Silent remote-account reassignment is therefore impossible; the later audited reassignment workflow must explicitly migrate or replace the DO after choosing history behavior.

After structural/cross-field preflight and hashing, construct this private internal value; it is not an RPC contract:

```ts
type PreparedProjectionEvent = {
  event: ProjectionEventEnvelope;
  connection: ProjectionConnectionBinding;
  eventHash: string;
  canonicalLineBytes: number;
  observedMs: number;
  occurredMs: number;
};
```

`applyPreparedBatch` and every projector handler receive `PreparedProjectionEvent`, never a bare envelope, so required `connection_id` is always available without another lookup or an unsafe account alias.

Opaque event-ID ties use one portable byte comparator. Export `compareOpaqueEventIds(a,b)`: UTF-8 encode both validated IDs, compare unsigned bytes lexicographically, and place the shorter byte sequence first when one is a prefix. Batch sorting and every JavaScript LWW comparison use this helper. SQL winner/order expressions use `event_id COLLATE BINARY`; the SQLite database is UTF-8 and its default/BINARY collation compares encoded bytes. Tests include non-ASCII and prefix IDs and assert JavaScript/SQLite agreement. Canonical resource IDs are ASCII by schema, so their existing lexical tie-break is equivalent.

Define strict, copy-safe schemas for:

```ts
type ProjectionCheckpointInput = {
  kind: string;                 // trimmed, 1..64
  value: string;                // trimmed, 1..4096; generic live source only
  last_observed_at: string;     // bounded timestamp
  last_event_id: OpaqueEventId;
};

type ApplyProjectionBatchInput = {
  schema_version: 1;
  tenant_id: CanonicalResourceId;
  authorization: ProjectionAuthorizationContext;
  mode: "live";
  rebuild_id: null;
  connections: ProjectionConnectionBinding[];
  events: ProjectionEventEnvelope[]; // 1..500, aggregate canonical bytes <=4 MiB
  checkpoint: ProjectionCheckpointInput | null;
};

type ApplyProjectionBatchResult = {
  schema_version: 1;
  tenant_id: CanonicalResourceId;
  generation: number;
  applied_count: number;
  duplicate_count: number;
  last_sequence: number;
};
```

Define these remaining strict RPC contracts exactly (all timestamps use `TimestampSchema`; all IDs use `CanonicalResourceIdSchema` unless explicitly described as opaque):

```ts
type InitializeProjectionInput = {
  schema_version: 1; tenant_id: string; initialized_at: string;
  authorization: ProjectionAuthorizationContext;
};
type ProjectionStatusInput = {
  schema_version: 1; tenant_id: string;
  authorization: ProjectionAuthorizationContext;
};
type ProjectionStatusCheckpoint = {
  kind: string; value: string; generation: number; updated_at: string;
  last_observed_at: string | null; last_event_id: OpaqueEventId | null;
  source_cursor: string | null; page_digest: string | null;
};
type ProjectionStatus = {
  schema_version: 1; tenant_id: string; schema_generation: number;
  state: "ready" | "rebuilding" | "rebuild_failed"; generation: number;
  rebuild_id: string | null; last_completed_rebuild_id: string | null;
  last_failed_rebuild_id: string | null;
  last_rebuild_failure_code: RebuildFailureCode | null;
  applied_event_count: number; conversation_count: number; message_count: number;
  latest_change_sequence: number; checkpoints: ProjectionStatusCheckpoint[];
};
type BeginRebuildInput = {
  schema_version: 1; tenant_id: string; rebuild_id: string;
  expected_generation: number; started_at: string;
  authorization: ProjectionAuthorizationContext;
};
type CompleteRebuildInput = {
  schema_version: 1; tenant_id: string; rebuild_id: string;
  terminal_cursor: null; completed_at: string;
  authorization: ProjectionAuthorizationContext;
};
type RebuildFailureCode =
  | "operator_abort"
  | "unsupported_archive"
  | "archive_gap"
  | "binding_conflict"
  | "validation_failed";
type AbortRebuildInput = {
  schema_version: 1; tenant_id: string; rebuild_id: string;
  failed_at: string; failure_code: RebuildFailureCode;
  authorization: ProjectionAuthorizationContext;
};
type ApplyReplayPageInput = {
  schema_version: 1; tenant_id: string; rebuild_id: string;
  source_cursor: string | null; // exact cursor passed to readReplayPage
  connections: ProjectionConnectionBinding[];
  page: ArchiveReplayPage;
  authorization: ProjectionAuthorizationContext;
};
type ListProjectionConversationsInput = {
  schema_version: 1; tenant_id: string; identity_id: string;
  connection_id: string | null; page_size?: number; cursor?: string;
  authorization: ProjectionAuthorizationContext;
};
type ListProjectionMessagesInput = {
  schema_version: 1; tenant_id: string; identity_id: string;
  conversation_id: string; page_size?: number; cursor?: string;
  authorization: ProjectionAuthorizationContext;
};
type ListProjectionChangesInput = {
  schema_version: 1; tenant_id: string; identity_id: string;
  generation: number; after_sequence: number; limit?: number;
  authorization: ProjectionAuthorizationContext;
};
type ProjectionChange = {
  sequence: number; event_id: OpaqueEventId; event_type: CanonicalEventType;
  identity_id: string; connection_id: string; conversation_id: string;
  occurred_at: string; observed_at: string; generation: number;
};
type ProjectionChangePage = {
  schema_version: 1; tenant_id: string; identity_id: string;
  generation: number; items: ProjectionChange[];
  latest_sequence: number; reset_required: boolean;
};
```

Conversation and message page results reuse `ConversationPageResultSchema` and a new strict `MessagePageResultSchema` with `{ items: Message[], next_cursor }`. No provider/Matrix aliases are added to either public result in this phase; aliases remain internal reconciliation columns. `initialize`, `beginRebuild`, `abortRebuild`, and `completeRebuild` return `ProjectionStatus`; `applyBatch` and `applyReplayPage` return `ApplyProjectionBatchResult`. Every RPC input includes `schema_version: 1`, `tenant_id`, and `authorization`; every ordinary query input additionally includes `identity_id`. Page sizes are 1..100. `after_sequence` is a nonnegative safe integer. Query cursor strings are nonempty and at most 2,048 characters; generic checkpoint/source cursors are at most 4,096. All results are plain structured-clone-safe objects/arrays/primitives, not Zod results, SQL cursors, `Date`, `Map`, `Error`, `Response`, or class instances.

`applyBatch` is live-only; its public schema cannot express replay. `applyReplayPage` is the sole replay entry and is an internal-only RPC for the future trusted R2-reader orchestrator; no public API or arbitrary service caller may invoke it. Both RPCs perform their distinct validation/preflight and call a private `applyPreparedBatch({ mode: "live" | "replay", rebuildId, preparedEvents, checkpointMutation })` transaction helper; this private type is not exported or accepted from RPC input. Live uses only the caller's generic checkpoint. Replay passes only its already-validated reserved R2 source-progress mutation, so the public live checkpoint path cannot forge it.

The DO independently computes `page_digest = await sha256Hex(new TextEncoder().encode(canonicalJsonStringify({ source_cursor, connections, page })))` with the existing archive helpers; this is the lowercase SHA-256 hex of the canonical UTF-8 bytes, and a caller does not supply the digest. Require `page.tenant_id === input.tenant_id` before any SQL. Replay source progress is separate from event ordering. The persisted R2 checkpoint records the last source cursor, last page digest/result, and next expected cursor (or terminal). The first page requires `source_cursor=null`; each later page requires `source_cursor` equal the immediately preceding page's persisted `next_cursor`. A retry of the immediately previous source cursor returns its stored result only when the computed digest matches; a different digest is `projection_conflict`. An unexpected source cursor, terminal reuse, or a **nonnull** `page.next_cursor === source_cursor` self-loop is rejected. The permitted `null/null` case is a first/single/empty terminal page. A successful page advances source progress atomically even when its event tuples are older than a prior page.

The R2 cursor payload intentionally contains an opaque Cloudflare `r2_cursor`; the DO cannot prove that it is monotonic, detect a jump hidden inside it, or classify an arbitrary mismatch as skip versus rewind. The already-tested trusted `readReplayPage` implementation owns manifest-prefix listing correctness and supplies each page directly. This phase promises exact adjacent cursor equality, same-page digest idempotency, tenant binding, and nonnull self-loop rejection—not independent proof that no manifest was skipped. A future stronger snapshot/ordinal protocol requires an archive-contract migration and is outside this phase.

A nonempty replay page must contain at least one manifest, every event must satisfy `ProjectionEventEnvelopeSchema`, and it must fit 500 events/4 MiB. An empty page is legal only as the terminal form `{ manifests: [], events: [], next_cursor: null }`; it writes a terminal checkpoint and returns zero applied/duplicate counts. Empty nonterminal pages and nonempty manifests with no events fail. `ArchiveReplayPageSchema` is intentionally looser (up to 2,000 events/8 MiB and canonical payloads that may not be a projection payload), so archive validity does **not** imply projection applicability. Before live ingestion is enabled, ingestion must archive only the 17 supported projection events. A legacy/unsupported archive payload fails the entire page with `projection_invalid`, leaves the DO rebuilding, and performs no partial SQL. An oversized multi-manifest page fails before SQL so the trusted reader can retry the exact same source cursor with page size 1.

Result and checkpoint mutations are exact:

| Case | Required result/checkpoint behavior |
| --- | --- |
| any nonempty batch | `applied_count` is the number of unique event IDs newly inserted; `duplicate_count = input event count - applied_count`, including same-hash repeats within the input and already-applied IDs; `last_sequence` is the tenant-global maximum after the transaction, or zero |
| live, no checkpoint input | do not mutate `projection_checkpoints`, including for duplicate-only batches |
| live checkpoint, no existing row | insert its value/tuple/current generation; `source_cursor/page_digest/last_applied_count/last_duplicate_count` are null; `updated_at=last_observed_at`; `last_sequence` is current global max |
| live checkpoint tuple newer than existing | replace `value`, `last_observed_at`, parsed `last_observed_ms`, `last_event_id`, current `generation`, and `updated_at=last_observed_at`; set `last_sequence` to post-transaction global max and all replay-only source/digest/count columns null, even when the event batch is duplicate-only |
| live checkpoint tuple exactly equal | exact same value and timestamp is a no-op; a differing value/text at the same `(last_observed_ms,last_event_id)` is `projection_conflict` |
| live checkpoint tuple older | leave the newer stored checkpoint unchanged; event idempotency/result counts still apply |
| first/new replay page | after cursor/digest validation, set reserved row `value=next_cursor ?? "terminal"`, `source_cursor=input.source_cursor`, computed digest/current generation, and that page's applied/duplicate counts plus post-page `last_sequence` |
| replay event tuple fields | store the greatest `(observed_ms,event_id)` seen across all replay pages, not merely the latest R2 page; a later source page with older events advances its cursor but preserves these fields |
| replay checkpoint `updated_at` | use the retained greatest event's original `observed_at`; with no events preserve the prior value, or use `rebuild_started_at` for the first empty terminal page |
| exact replay-page retry | return the stored page `applied_count`, `duplicate_count`, and `last_sequence` unchanged; perform no event/checkpoint writes |
| empty terminal replay | return zero applied/duplicate counts and current global `last_sequence`; write terminal cursor/digest with null event tuple fields when the archive was empty |

All counts and checkpoint changes occur inside the same transaction as markers/domain rows/changes.

## SQLite schema version 1

Use exactly one migration `{ version: 1, name: "initial_tenant_projection", appliedAt: "2026-09-07T00:00:00.000Z" }`; `appliedAt` is fixed migration metadata, not runtime wall-clock truth. The worker may split the following DDL into individual static statements to stay far below Cloudflare's 100 KB statement limit, but must not change its columns or constraints. Every table is `STRICT`. Descriptor-safe preflight validates every timestamp, parsed millisecond as a safe integer, ID, platform, event type/source, delivery status/mode, command status, generation, sequence, count, and size before SQL. SQL independently enforces storage type, required/nullability, booleans, lifecycle/state enums, and the explicit counter/range checks shown below; do not infer additional range checks from `STRICT`.

```sql
CREATE TABLE IF NOT EXISTS _sql_schema_migrations (
  version INTEGER PRIMARY KEY CHECK(version >= 1),
  name TEXT NOT NULL UNIQUE,
  applied_at TEXT NOT NULL
) STRICT;

CREATE TABLE projection_meta (
  singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
  tenant_id TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL CHECK(state IN ('ready','rebuilding','rebuild_failed')),
  generation INTEGER NOT NULL CHECK(generation >= 1 AND generation <= 9007199254740991),
  rebuild_id TEXT,
  rebuild_started_at TEXT,
  last_completed_rebuild_id TEXT,
  last_failed_rebuild_id TEXT,
  last_rebuild_failure_code TEXT CHECK(last_rebuild_failure_code IS NULL OR last_rebuild_failure_code IN ('operator_abort','unsupported_archive','archive_gap','binding_conflict','validation_failed')),
  initialized_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE connection_bindings (
  account_id TEXT PRIMARY KEY,
  connection_id TEXT NOT NULL UNIQUE,
  identity_id TEXT NOT NULL,
  platform TEXT NOT NULL
) STRICT;

CREATE TABLE completed_rebuilds (
  rebuild_id TEXT PRIMARY KEY,
  generation INTEGER NOT NULL UNIQUE CHECK(generation >= 2 AND generation <= 9007199254740991),
  completed_at TEXT NOT NULL
) STRICT;

CREATE TABLE failed_rebuilds (
  rebuild_id TEXT PRIMARY KEY,
  generation INTEGER NOT NULL UNIQUE CHECK(generation >= 2 AND generation <= 9007199254740991),
  failed_at TEXT NOT NULL,
  failure_code TEXT NOT NULL CHECK(failure_code IN ('operator_abort','unsupported_archive','archive_gap','binding_conflict','validation_failed'))
) STRICT;

CREATE TABLE applied_events (
  event_id TEXT PRIMARY KEY,
  event_hash TEXT NOT NULL CHECK(length(event_hash) = 64),
  event_type TEXT NOT NULL,
  event_source TEXT NOT NULL,
  identity_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  observed_ms INTEGER NOT NULL CHECK(observed_ms BETWEEN -9007199254740991 AND 9007199254740991),
  generation INTEGER NOT NULL CHECK(generation >= 1)
) STRICT;

CREATE TABLE conversations (
  id TEXT PRIMARY KEY,
  identity_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  platform TEXT NOT NULL,
  title TEXT NOT NULL,
  archived INTEGER NOT NULL CHECK(archived IN (0,1)),
  muted INTEGER NOT NULL CHECK(muted IN (0,1)),
  last_message_preview TEXT NOT NULL DEFAULT '',
  shell_activity_at TEXT NOT NULL,
  shell_activity_ms INTEGER NOT NULL,
  shell_activity_event_id TEXT NOT NULL,
  last_activity_at TEXT NOT NULL,
  last_activity_ms INTEGER NOT NULL,
  unread_count INTEGER NOT NULL DEFAULT 0 CHECK(unread_count >= 0),
  message_count INTEGER NOT NULL DEFAULT 0 CHECK(message_count >= 0),
  attachment_count INTEGER NOT NULL DEFAULT 0 CHECK(attachment_count >= 0),
  metadata_observed_ms INTEGER NOT NULL CHECK(metadata_observed_ms BETWEEN -9007199254740991 AND 9007199254740991),
  metadata_event_id TEXT NOT NULL,
  deleted_at TEXT,
  last_event_id TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE participants (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  identity_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  platform TEXT NOT NULL,
  display_name TEXT NOT NULL,
  remote_id TEXT,
  avatar_url TEXT,
  last_observed_ms INTEGER NOT NULL,
  last_event_id TEXT NOT NULL,
  deleted_at TEXT
) STRICT;

CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  identity_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  platform TEXT NOT NULL,
  direction TEXT NOT NULL CHECK(direction IN ('inbound','outbound')),
  sender_participant_id TEXT,
  sender_label TEXT NOT NULL,
  body TEXT NOT NULL,
  reply_to_message_id TEXT,
  delivery_status TEXT NOT NULL CHECK(delivery_status IN ('unknown','accepted','sent','delivered','read','failed')),
  unread INTEGER NOT NULL CHECK(unread IN (0,1)),
  local_read_at TEXT,
  occurred_at TEXT NOT NULL,
  occurred_ms INTEGER NOT NULL,
  observed_at TEXT NOT NULL,
  current_observed_ms INTEGER NOT NULL,
  current_event_id TEXT NOT NULL,
  matrix_room_id TEXT,
  matrix_event_id TEXT,
  remote_message_id TEXT,
  edited_at TEXT,
  deleted_at TEXT,
  deletion_reason TEXT,
  attachment_count INTEGER NOT NULL DEFAULT 0 CHECK(attachment_count >= 0),
  delivery_failure_code TEXT,
  delivery_observed_ms INTEGER,
  delivery_event_id TEXT
) STRICT;

CREATE TABLE message_versions (
  event_id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL,
  identity_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  platform TEXT NOT NULL,
  version_kind TEXT NOT NULL CHECK(version_kind IN ('created','edited')),
  body TEXT NOT NULL,
  editor_participant_id TEXT,
  occurred_at TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  observed_ms INTEGER NOT NULL
) STRICT;

CREATE TABLE reactions (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL,
  identity_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  platform TEXT NOT NULL,
  participant_id TEXT,
  emoji TEXT,
  occurred_at TEXT NOT NULL,
  last_observed_ms INTEGER NOT NULL,
  last_event_id TEXT NOT NULL,
  removed_at TEXT
) STRICT;

CREATE TABLE receipts (
  message_id TEXT NOT NULL,
  participant_id TEXT NOT NULL,
  receipt_type TEXT NOT NULL CHECK(receipt_type IN ('read','delivered')),
  identity_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  platform TEXT NOT NULL,
  local_identity INTEGER NOT NULL CHECK(local_identity IN (0,1)),
  occurred_at TEXT NOT NULL,
  last_observed_ms INTEGER NOT NULL,
  last_event_id TEXT NOT NULL,
  PRIMARY KEY(message_id,participant_id,receipt_type)
) STRICT;

CREATE TABLE typing_states (
  conversation_id TEXT NOT NULL,
  participant_id TEXT NOT NULL,
  identity_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  platform TEXT NOT NULL,
  is_typing INTEGER NOT NULL CHECK(is_typing IN (0,1)),
  expires_at TEXT,
  last_observed_ms INTEGER NOT NULL,
  last_event_id TEXT NOT NULL,
  PRIMARY KEY(conversation_id,participant_id)
) STRICT;

CREATE TABLE attachments (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL,
  identity_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  platform TEXT NOT NULL,
  file_name TEXT,
  mime_type TEXT,
  size_bytes INTEGER CHECK(size_bytes IS NULL OR size_bytes >= 0),
  sha256 TEXT CHECK(sha256 IS NULL OR length(sha256) = 64),
  r2_key TEXT,
  observed_at TEXT NOT NULL,
  last_observed_ms INTEGER NOT NULL,
  last_event_id TEXT NOT NULL,
  deleted_at TEXT
) STRICT;

CREATE TABLE commands (
  id TEXT PRIMARY KEY,
  identity_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  platform TEXT NOT NULL,
  operation TEXT NOT NULL CHECK(operation = 'message.send'),
  delivery_mode TEXT NOT NULL CHECK(delivery_mode IN ('direct','paced')),
  status TEXT NOT NULL CHECK(status IN ('accepted','scheduled','reading','typing','submitted_to_matrix','matrix_confirmed','bridged','delivered','cancelled','unsupported','failed')),
  failure_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_observed_ms INTEGER NOT NULL,
  last_event_id TEXT NOT NULL
) STRICT;

CREATE TABLE message_delivery_updates (
  message_id TEXT PRIMARY KEY,
  identity_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  platform TEXT NOT NULL,
  delivery_status TEXT NOT NULL CHECK(delivery_status IN ('unknown','accepted','sent','delivered','read','failed')),
  failure_code TEXT,
  occurred_at TEXT NOT NULL,
  last_observed_ms INTEGER NOT NULL,
  last_event_id TEXT NOT NULL
) STRICT;

CREATE TABLE event_tombstones (
  target_event_id TEXT PRIMARY KEY,
  tombstone_event_id TEXT NOT NULL UNIQUE,
  tombstone_type TEXT NOT NULL CHECK(tombstone_type IN ('replay.tombstone','correction.applied')),
  identity_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  platform TEXT NOT NULL,
  reason_code TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  observed_ms INTEGER NOT NULL
) STRICT;

CREATE TABLE resource_tombstones (
  resource_type TEXT NOT NULL CHECK(resource_type IN ('message','conversation','participant','attachment')),
  resource_id TEXT NOT NULL,
  tombstone_event_id TEXT NOT NULL UNIQUE,
  identity_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  platform TEXT NOT NULL,
  reason_code TEXT,
  occurred_at TEXT NOT NULL,
  observed_ms INTEGER NOT NULL,
  PRIMARY KEY(resource_type,resource_id)
) STRICT;

CREATE TABLE projection_changes (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL UNIQUE,
  event_type TEXT NOT NULL,
  identity_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  generation INTEGER NOT NULL CHECK(generation >= 1)
) STRICT;

CREATE TABLE projection_change_floors (
  identity_id TEXT PRIMARY KEY,
  discarded_through_sequence INTEGER NOT NULL CHECK(discarded_through_sequence >= 0)
) STRICT;

CREATE TABLE projection_checkpoints (
  kind TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  source_cursor TEXT,
  page_digest TEXT CHECK(page_digest IS NULL OR length(page_digest) = 64),
  last_observed_at TEXT,
  last_observed_ms INTEGER,
  last_event_id TEXT,
  generation INTEGER NOT NULL CHECK(generation >= 1),
  updated_at TEXT NOT NULL,
  last_applied_count INTEGER CHECK(last_applied_count IS NULL OR last_applied_count >= 0),
  last_duplicate_count INTEGER CHECK(last_duplicate_count IS NULL OR last_duplicate_count >= 0),
  last_sequence INTEGER CHECK(last_sequence IS NULL OR last_sequence >= 0)
) STRICT;
```

Do not add foreign keys from potentially out-of-order child events to message/conversation rows. Isolation comes from one database per tenant plus stored tenant binding, and logical consistency comes from validated envelope IDs and transaction rules. Add these indexes exactly by access path, not redundant single-column indexes:

```sql
CREATE INDEX idx_conversations_identity_activity ON conversations(identity_id,last_activity_ms DESC,id ASC);
CREATE INDEX idx_conversations_identity_connection_activity ON conversations(identity_id,connection_id,last_activity_ms DESC,id ASC);
CREATE INDEX idx_messages_identity_conversation_occurred ON messages(identity_id,conversation_id,occurred_ms DESC,id ASC);
CREATE INDEX idx_messages_matrix_event ON messages(matrix_event_id) WHERE matrix_event_id IS NOT NULL;
CREATE INDEX idx_messages_remote_message ON messages(remote_message_id) WHERE remote_message_id IS NOT NULL;
CREATE INDEX idx_message_versions_message_order ON message_versions(message_id,observed_ms DESC,event_id DESC);
CREATE INDEX idx_participants_conversation_name ON participants(conversation_id,display_name,id);
CREATE INDEX idx_reactions_message_state ON reactions(message_id,removed_at,occurred_at);
CREATE INDEX idx_receipts_message_type_time ON receipts(message_id,receipt_type,occurred_at);
CREATE INDEX idx_attachments_message_state ON attachments(message_id,deleted_at,id);
CREATE INDEX idx_delivery_message_order ON message_delivery_updates(message_id,last_observed_ms,last_event_id);
CREATE INDEX idx_applied_events_order ON applied_events(observed_ms,event_id);
CREATE INDEX idx_projection_changes_identity_sequence ON projection_changes(identity_id,sequence);
CREATE INDEX idx_resource_tombstones_resource_order ON resource_tombstones(resource_type,resource_id,observed_ms);
```

## Event projection semantics

- Use `(observed_ms ASC, event_id-by-UTF8-bytes ASC)` as the single **event/LWW** comparator. This is intentionally separate from the archive codec's `(observed_at, occurred_at, event_id)` ordering: archives enumerate manifests by R2 key and replay pages may arrive with older projection tuples. Sort each projection batch and resolve mutable-state winners with the observed comparator; never use it for R2 source-cursor progress. Separately, presentation activity uses `(occurred_ms, ASCII resource_id)` because it answers when conversation content happened, not which observation won.
- Ensure a conversation shell exists for every event before projecting child state. The shell uses resolved connection plus envelope identity/account/platform, title defaults to `conversation_id`, and counters/preview start at zero/empty. Its nonnullable shell activity tuple is the greatest `(occurred_ms,event_id)` seen for that conversation and retains the winning original `occurred_at`; last activity initially equals it. If an existing shell has different immutable identity/account/connection/platform, throw `projection_conflict` and roll back.
- Freeze one invariant: every Communicator resource ID is globally unique **within its tenant**, regardless of connection. The upstream normalizer allocates those IDs; remote/Matrix aliases may overlap and are never resource primary keys. Therefore the unscoped primary keys below are intentional: reusing one resource ID under another identity/account/connection/conversation is corruption and fails `projection_conflict`, not a second valid view. Every child/pending row stores identity/account/connection/conversation/platform. Before any edit, delete, reaction, receipt, typing, attachment, delivery, command, event tombstone, or reconciliation, verify its stored owner scope equals the resolved binding and conversation shell. Add same-ID cross-identity, cross-connection, and cross-conversation regression cases for every child family.
- Centralize `resource_tombstones` lookup/gating. Every create/update handler consults the applicable resource and conversation tombstone before retaining sensitive state. The mere presence of a resource tombstone dominates **all** older and later non-tombstone arrivals; those events may still enter audit/change rows but never resurrect content. `resource_tombstones.reason_code` is nullable only because `message.deleted.reason_code` is nullable; explicit `deletion.tombstone` reasons remain required by contract. When multiple tombstones target the same resource, the maximum `(observed_ms,tombstone_event_id)` wins its reason/occurred/metadata, while redaction remains continuously active. A losing tombstone is still an applied/change event.
- `conversation.updated`: update metadata only if its ordering tuple is newer and no conversation tombstone exists.
- `participant.updated`: upsert by tenant-unique participant ID, require its stored conversation ownership to match, and update only on a newer tuple when neither participant nor conversation is tombstoned. A deleted participant always has `display_name='Deleted participant'`, null remote/avatar values, and `deleted_at` from the tombstone event's `occurred_at`.
- `message.created`: insert the immutable scoped `created` version. Create or reconcile the message resource. A second create with different immutable identity/account/conversation/platform/direction is `projection_conflict`. Apply the latest known created/edited version by projection tuple, then reconcile the newest stored delivery update, latest local read receipt, and active attachment count. Respect message/conversation tombstones.
- `message.edited`: insert a scoped `edited` version even when the base message has not arrived. If the message exists and the edit tuple wins, update current body and set `edited_at=event.occurred_at`. A later create recomputes from all versions. Tombstoned message/conversation versions are stored with `body=''` and `editor_participant_id=NULL`, never with sensitive content.
- `message.deleted`: always upsert a message resource tombstone. If the message exists, set `deleted_at=event.occurred_at`, `deletion_reason=payload.reason_code`, `sender_label='Deleted sender'`, `body=''`, and provider aliases/reply reference null. Retain only IDs plus non-content timestamps needed for idempotency/audit. Also clear every matching `message_versions.body` and editor, delete its reactions and receipts, and redact its attachments. The stored fixed sender label already satisfies query mapping.
- `reaction.added/removed`: use scoped reaction ID and tuple-winner logic. A removal-before-add row has nullable participant/emoji and `removed_at=event.occurred_at`; a later older add may fill no content and cannot resurrect it. Message/conversation tombstones delete related reactions and prevent later sensitive values from being retained.
- Receipts always upsert the newest scoped row, even before a message exists. `local_identity` is an immutable classification for one `(message_id,participant_id,receipt_type)` key: a later event that changes it is canonical ownership corruption and must fail atomically with `projection_conflict`. Local and remote receipts therefore use stable participant keys rather than overwriting one another's classification. A local read sets `local_read_at=event.occurred_at` and unread zero when the message exists; when a message later arrives it consults the newest local read receipt and is born read. Remote receipts never alter local unread.
- Typing retains the newest scoped row per conversation+participant. `started` stores `expires_at`; `stopped` clears it. Replay may reconstruct expired rows, but later consumers filter by expiry. A conversation tombstone deletes typing rows and blocks later content.
- Attachments always upsert scoped metadata, even before a message exists; never store bytes. Message creation and summary recomputation count active attachment rows. Attachment/message/conversation tombstones clear filename, MIME, hash, and R2 key and set `deleted_at` from the tombstone event.
- `command.updated`: upsert scoped observed state by tuple; it never executes a command. First sighting uses `created_at=event.occurred_at`; repeated events preserve the earliest occurred timestamp and set `updated_at` to the winning event's `occurred_at`.
- `bridge.delivery.updated`: always upsert the scoped `message_delivery_updates` row by tuple, including before message creation. Reconcile the newest row into a present message; retain `failure_code` only for `failed`. Message/conversation deletion clears the failure code and prevents later sensitive failure detail.
- `replay.tombstone` and `correction.applied` are audit/control markers only in this phase. They upsert scoped `event_tombstones`; for repeated markers targeting the same event, the maximum `(observed_ms,tombstone_event_id)` wins metadata. They do not retroactively suppress, undo, or reproject the target. Upstream must emit a separate corrected/deleted domain event; tests assert marker-only and reverse-order winner behavior explicitly.
- `deletion.tombstone`: upsert scoped `resource_tombstones` and apply deterministic redaction. Conversation deletion sets title `Deleted conversation`, preview empty and counters zero; redacts every message and message-version body, participant, and attachment; deletes reactions, receipts, and typing; and clears delivery/command failure detail. A message tombstone applies the message redaction fields above with `deletion_reason=payload.reason_code`; repeated tombstone tuple winners update that reason/deleted timestamp without restoring content. Participant deletion follows the fixed-label rule. Attachment deletion follows the attachment rule. Missing targets remain tombstoned so later arrivals are born redacted. Deleted conversations are omitted from pages; directly requested deleted messages remain redacted.
- Recompute touched conversations one at a time in sorted ID order—never a 500-placeholder `IN` list. Select the latest nondeleted message by `occurred_ms DESC, id ASC`; set preview to its first 280 Unicode code units and activity text/milliseconds to that message. With no active message, use empty preview and the stored nonnullable shell activity tuple. Recompute active message count, unread inbound count, every message's active attachment count, and conversation active attachment count.
- Append one `projection_changes` row per newly applied event even when an older domain event loses tuple comparison. Sequences are tenant-global. After inserting, trim to newest 10,000 total rows; before deletion, update `projection_change_floors` for each affected identity to the greatest deleted sequence.
- Deterministic time mapping is mandatory: domain `created_at`, `updated_at`, `edited_at`, `deleted_at`, `removed_at`, `local_read_at`, delivery occurrence, and command timestamps come from the relevant event's `occurred_at`; event/checkpoint ordering comes from `observed_at`/parsed milliseconds. `projection_meta.updated_at` changes only from validated caller-supplied lifecycle timestamps (`initialized_at`, `started_at`, `failed_at`, `completed_at`). A nonempty live checkpoint uses its greatest event's `observed_at`; an empty terminal replay checkpoint preserves the previous page timestamp or uses `rebuild_started_at` when the archive is empty. No projection path calls a wall clock.

## Error contract

`ProjectionError` exposes only one stable code:

```ts
type ProjectionErrorCode =
  | "projection_invalid"
  | "projection_forbidden"
  | "projection_tenant_mismatch"
  | "projection_conflict"
  | "projection_rebuilding"
  | "projection_rebuild_failed"
  | "projection_rebuild_mismatch"
  | "projection_not_found"
  | "projection_too_large"
  | "projection_unavailable";
```

The public error message is the code. Use `projection_forbidden` for a missing scope or identity grant without disclosing which grant was absent. Never store the original cause as any own property of `ProjectionError`, including a non-enumerable `cause`: enhanced Workers RPC serialization preserves serializable own properties and would cross the boundary. If local tests/diagnostics need the raw cause, retain it only in a module-private `WeakMap<ProjectionError, unknown>` with an internal retrieval helper; the RPC-visible error must contain no reference to it. Never put event payloads, message text, cursors, auth material, SQL bindings, or raw Cloudflare exceptions into a `ProjectionError` message/property or any log. Successful pagination results and authorized internal status may return their explicitly typed cursor/checkpoint fields.

Apply this mapping consistently and test each row:

| Condition | Projection code |
| --- | --- |
| malformed/hostile contract input, unsupported projection payload, bad query/replay cursor syntax, `archive_invalid`, or `archive_corrupt` from cursor/page validation | `projection_invalid` |
| input/context/stored/page/cursor tenant disagreement or `archive_tenant_mismatch` | `projection_tenant_mismatch` |
| missing operation scope or requested live/query identity grant | `projection_forbidden` |
| canonical batch/page exceeds count/byte bounds or `archive_too_large` | `projection_too_large` |
| object not initialized | `projection_not_found` |
| ordinary query or live apply while state is rebuilding | `projection_rebuilding` |
| ordinary query, live apply, or replay apply while state is `rebuild_failed` | `projection_rebuild_failed` |
| wrong rebuild ID, wrong expected generation for begin, replay while ready, begin incompatible with current rebuild, or complete without current terminal checkpoint | `projection_rebuild_mismatch` |
| event hash/binding mismatch, resource-owner reuse, generation-bound query cursor mismatch, unexpected replay source cursor/non-null self-loop/digest mismatch, or `archive_conflict` | `projection_conflict` |
| unexpected SQLite/runtime failure or `archive_unavailable` | `projection_unavailable` |
| `archive_not_found` | `projection_invalid` (a page/cursor contract must never point the DO at storage; the future trusted reader handles missing objects before RPC) |

---

### Task 1: Freeze projection contracts and event-specific payloads

**Files:**
- Create: `packages/contracts/src/projection.ts`
- Create: `packages/contracts/test/projection.test.ts`
- Modify: `packages/contracts/src/canonical-event.ts`
- Modify: `packages/contracts/src/conversation.ts`
- Modify: `packages/contracts/src/index.ts`

- [ ] **Step 1: Write failing contract tests**

Cover every one of the 17 event types with one valid payload and table-driven invalid cases: wrong payload for type, extra keys, bad resource IDs, opaque event IDs that are valid but not resource IDs, oversized body/labels/emoji/R2 key, negative or unsafe size, malformed SHA, invalid timestamps, getter/symbol/prototype input, and caller mutation after parsing. Cover authorization and connection-binding sorting/uniqueness/bounds, scope requirements, all RPC object strictness, all three projection states, all five rebuild failure codes, strict `abortRebuild` input, exact 1/500 batch-event, 0/1/500 binding, 1/100 page, 2,048 query-cursor, and 4,096 checkpoint/source-cursor boundaries. Aggregate canonical-byte and cross-field binding/media-key checks belong to Task 4. Assert RPC outputs contain only structured-clone-safe primitives/plain arrays/objects.

- [ ] **Step 2: Prove RED**

```bash
pnpm --filter @communicator/contracts test -- projection.test.ts
```

Expected: FAIL because `projection.ts` and exports do not exist.

- [ ] **Step 3: Implement the exact schemas above**

Use descriptor-safe preprocessing consistent with `canonical-event.ts`; do not rely on plain `.parse()` reading hostile getters. Export `OpaqueEventIdSchema`, `DeliveryStatusSchema`, `ProjectionConnectionBindingSchema`, a `ProjectionPayloadSchemaByType` map, `ProjectionEventEnvelopeSchema`, `parseProjectionEvent`, every authorization/RPC schema and type (including `AbortRebuildInput`), both exact cursor payload schemas, projection state/rebuild-failure/error/result enums, and all seven constants. Do not duplicate or alter existing accepted ID/status values.

- [ ] **Step 4: Prove GREEN and regression**

```bash
pnpm --filter @communicator/contracts test -- projection.test.ts
pnpm --filter @communicator/contracts test
pnpm --filter @communicator/contracts check
```

- [ ] **Step 5: Commit**

```bash
git add packages/contracts/src/projection.ts packages/contracts/test/projection.test.ts packages/contracts/src/canonical-event.ts packages/contracts/src/conversation.ts packages/contracts/src/index.ts
git commit -m "feat: define tenant projection contracts"
```

### Task 2: Configure the SQLite Durable Object and deterministic routing

**Files:**
- Modify: `apps/control-plane/wrangler.jsonc`
- Modify generated: `apps/control-plane/worker-configuration.d.ts`
- Modify: `apps/control-plane/worker/index.ts`
- Create: `apps/control-plane/worker/projection/errors.ts`
- Create: `apps/control-plane/worker/projection/routing.ts`
- Create: `apps/control-plane/worker/projection/tenant-projection.ts`
- Create: `apps/control-plane/worker/test/projection/routing.test.ts`

- [ ] **Step 1: Write failing routing/config tests**

Assert valid tenant IDs route through `TENANT_PROJECTION.getByName()` with the exact tenant string; invalid IDs never touch the binding; class and binding names match; base/staging/production each contain the binding; top-level `exports.TenantProjectionDO` is `{ "type": "durable-object", "storage": "sqlite" }`; and no legacy `migrations` key is introduced. Directly test the stable ProjectionError code/message, absence of any raw-cause own property, private WeakMap diagnostic retrieval, safe wrapping, and the temporary `getStatus` rejection. Exercise an actual stub/RPC error boundary where the local Workers test harness supports it and prove a malicious raw-cause sentinel cannot reach the caller; if the harness cannot cleanly assert a rejected DO RPC, the no-own-property invariant plus the official enhanced-serialization contract is the mandatory deterministic substitute and the limitation must be documented in the test. Use the existing `worker/test/health.test.ts` and `worker/test/authorization.test.ts` suites as the explicit unchanged-default-route oracle; do not snapshot function source or prose.

- [ ] **Step 2: Prove RED**

```bash
pnpm --filter @communicator/control-plane test:worker -- worker/test/projection/routing.test.ts
```

- [ ] **Step 3: Add configuration and the minimal class**

Add top-level:

```jsonc
"exports": {
  "TenantProjectionDO": { "type": "durable-object", "storage": "sqlite" }
},
"durable_objects": {
  "bindings": [
    { "name": "TENANT_PROJECTION", "class_name": "TenantProjectionDO" }
  ]
}
```

Repeat only `durable_objects.bindings` under staging and production. Export `TenantProjectionDO` from `worker/index.ts` beside the unchanged default/app exports. The initial class extends `DurableObject<Cloudflare.Env>` and exposes a temporary typed `getStatus` that throws `projection_unavailable` until Task 3 supplies schema initialization. Do not add `fetch()`.

Implement:

```ts
export function getTenantProjection(
  env: Pick<Cloudflare.Env, "TENANT_PROJECTION">,
  tenantId: unknown,
): DurableObjectStub<TenantProjectionDO>;
```

Validate before accessing the binding. Never use `newUniqueId()` or `idFromString()`.

- [ ] **Step 4: Generate types and prove GREEN**

```bash
pnpm --filter @communicator/control-plane types:worker
pnpm --filter @communicator/control-plane test:worker -- worker/test/projection/routing.test.ts
pnpm --filter @communicator/control-plane test:worker -- worker/test/health.test.ts worker/test/authorization.test.ts
pnpm --filter @communicator/control-plane check
```

Inspect the generated `Cloudflare.Env` and require a specifically typed `TENANT_PROJECTION` namespace; do not hand-edit it.

- [ ] **Step 5: Commit**

```bash
git add apps/control-plane/wrangler.jsonc apps/control-plane/worker-configuration.d.ts apps/control-plane/worker/index.ts apps/control-plane/worker/projection/errors.ts apps/control-plane/worker/projection/routing.ts apps/control-plane/worker/projection/tenant-projection.ts apps/control-plane/worker/test/projection/routing.test.ts
git commit -m "build: configure tenant projection durable object"
```

### Task 3: Add deterministic SQLite schema migrations and tenant binding

**Files:**
- Create: `apps/control-plane/worker/projection/schema.ts`
- Modify: `apps/control-plane/worker/projection/tenant-projection.ts`
- Create: `apps/control-plane/worker/test/projection/schema.test.ts`

- [ ] **Step 1: Write failing schema/lifecycle tests**

Import `env` and `runInDurableObject` from `"cloudflare:test"`. Use `env.TENANT_PROJECTION.getByName()` for RPC calls and `runInDurableObject(stub, async (instance, state) => { ... })` for direct SQLite inspection. Assert every exact application table, column type/nullability/check, named index, migration `{ version: 1, name: "initial_tenant_projection", appliedAt: "2026-09-07T00:00:00.000Z" }`, and absence of secret/media-byte columns. This includes `failed_rebuilds` and all nullable active-failure columns/checks in `projection_meta`. Instantiate twice and prove migration idempotence. Assert `getStatus` before initialization returns `projection_not_found`. Call `initialize` with a valid `projection.initialize` authorization context, assert generation 1/state `ready` and null active/completed/failed rebuild metadata, repeat the exact/same-tenant initialization without changing `initialized_at`, then assert another tenant against the same stub fails with `projection_tenant_mismatch`. Assert a distinct named stub isolates its rows. Verify missing/wrong scopes fail `projection_forbidden` before data access.

- [ ] **Step 2: Prove RED**

```bash
pnpm --filter @communicator/control-plane test:worker -- worker/test/projection/schema.test.ts
```

- [ ] **Step 3: Implement migrations and constructor initialization**

Export an ordered immutable migration array. In the constructor:

```ts
this.ctx.blockConcurrencyWhile(async () => {
  runProjectionMigrations(this.ctx.storage);
});
```

`runProjectionMigrations` receives `DurableObjectStorage`, uses its `.sql` property for statements, and uses that same storage object's `transactionSync()` for each migration. The migration runner creates `_sql_schema_migrations`, reads applied versions, applies each missing migration inside `transactionSync`, inserts its version/name/fixed `appliedAt` only after all statements succeed, rejects an unknown newer stored version or same version with another name, and contains no external I/O or `await`. Implement `initialize` as the only creator of `projection_meta`: it inserts generation 1/state ready with the caller's validated `initialized_at`, accepts later initialization for the same tenant without changing the original timestamp, and rejects another tenant. Add private synchronous authorization/tenant guards used by every RPC; absence is `projection_not_found`, stored/input/context tenant mismatch is `projection_tenant_mismatch`, and denied scope/identity is `projection_forbidden`. Do not infer tenant identity from the opaque DO ID or use `Date.now()`.

- [ ] **Step 4: Prove GREEN and restart behavior**

Run the focused suite, the full Worker suite, and use a fresh stub call after instance eviction/test lifecycle where supported to show SQLite state—not an in-memory property—carries tenant binding and schema version.

```bash
pnpm --filter @communicator/control-plane test:worker -- worker/test/projection/schema.test.ts
pnpm --filter @communicator/control-plane test:worker
```

- [ ] **Step 5: Commit**

```bash
git add apps/control-plane/worker/projection/schema.ts apps/control-plane/worker/projection/tenant-projection.ts apps/control-plane/worker/test/projection/schema.test.ts
git commit -m "feat: initialize tenant projection sqlite"
```

### Task 4: Implement preflight, hashing, and atomic idempotent application

**Files:**
- Create: `apps/control-plane/worker/projection/projector.ts`
- Modify: `apps/control-plane/worker/projection/tenant-projection.ts`
- Create: `apps/control-plane/worker/test/projection/apply-batch.test.ts`
- Reuse: `apps/control-plane/worker/archive/canonical-json.ts`
- Reuse: `apps/control-plane/worker/archive/codec.ts`

- [ ] **Step 1: Write failing batch invariants tests**

Test 1 and 500-event boundaries, 501 rejection, exact newline-inclusive 4 MiB canonical acceptance/one-byte overflow rejection, all preflight failures before SQL mutation, caller-object mutation isolation, deterministic tuple sorting, UTF-8-byte event-ID ordering (non-ASCII plus prefix cases) matching SQLite BINARY, exact duplicate collapse inside one batch, duplicate delivery across calls, same-ID/different-hash conflict, and same-event/same-hash but different connection conflict. Cover exact connection-binding coverage with no extras/duplicates, account remap, connection reused by another account, identity/platform mismatch, tenant mismatch, event-tenant mismatch, missing write scope, any live event identity outside the authorization set, rejection of any non-live mode/non-null rebuild ID, ready/rebuilding mismatch, valid/invalid tenant-derived media keys, and injected mid-projection failure rolling back every table/checkpoint/change row. For the failure seam, inside `runInDurableObject` create `TEMP TRIGGER fail_projection_change BEFORE INSERT ON projection_changes BEGIN SELECT RAISE(ABORT,'synthetic'); END`, call the RPC, assert sanitized `projection_unavailable` plus no partial rows, then drop the trigger in `finally`.

- [ ] **Step 2: Prove RED**

```bash
pnpm --filter @communicator/control-plane test:worker -- worker/test/projection/apply-batch.test.ts
```

- [ ] **Step 3: Implement preflight and transaction skeleton**

Parse a descriptor-safe snapshot with `ApplyProjectionBatchInputSchema`. Enforce `projection.write`, require every unique live event identity in the supplied allowed set, resolve the exact D1-derived connection binding for every event, and reject unused/mismatched bindings before SQL. Canonicalize each event with the existing canonical serializer, count newline-inclusive bytes, hash with `sha256Hex`, and group duplicate IDs. Exact duplicate bytes collapse; conflicting bytes fail. Sort unique events by parsed observed milliseconds then opaque `event_id`. Validate a generic live checkpoint's last tuple equals the greatest event tuple when present; `applyBatch` rejects reserved `r2_manifest_cursor`, which only `applyReplayPage` may maintain.

Only after all asynchronous hashes finish, call the ECMAScript `#applyPreparedBatch` helper (or an equivalent module-private function) described above; it is the sole owner of one `transactionSync` and is never an RPC method/export. Do not use TypeScript-only `private` for this or any other DO helper because emitted prototype methods are RPC-visible. For live mode, require initialized tenant in `ready` state, check-or-insert every exact persistent `connection_bindings` row, pre-read existing `applied_events`, reject any hash or stored binding conflict, project only new events through a temporary no-op `projectEvent` hook, insert one applied marker/change row per new event, advance a generic live checkpoint under the mutation table above, trim changes/update per-identity floors, and return counts/last sequence. Binding inserts are part of this same transaction and roll back with event failure. Cloudflare permits at most 100 bound parameters per query: split event-ID lookups into deterministic chunks of at most 90 (or query individually), and use the same policy for every dynamic list. Never construct a 500-placeholder `IN` clause. Hash the exact canonical event JSON line including its final newline. Map archive errors explicitly: invalid/corrupt/not-found to `projection_invalid`, tenant mismatch to `projection_tenant_mismatch`, too-large to `projection_too_large`, conflict to `projection_conflict`, and unavailable to `projection_unavailable`; every unknown canonicalization/hash/SQL/runtime failure is `projection_unavailable`. A thrown `ProjectionError` rolls back unchanged and no error exposes payload content.

- [ ] **Step 4: Prove GREEN and regression**

```bash
pnpm --filter @communicator/control-plane test:worker -- worker/test/projection/apply-batch.test.ts
pnpm --filter @communicator/control-plane test:worker
pnpm --filter @communicator/control-plane check
```

- [ ] **Step 5: Commit**

```bash
git add apps/control-plane/worker/projection/projector.ts apps/control-plane/worker/projection/tenant-projection.ts apps/control-plane/worker/test/projection/apply-batch.test.ts
git commit -m "feat: apply projection batches idempotently"
```

### Task 5: Project conversations, messages, and related event families

**Files:**
- Modify: `apps/control-plane/worker/projection/projector.ts`
- Modify: `apps/control-plane/worker/projection/tenant-projection.ts`
- Create: `apps/control-plane/worker/test/projection/projector.test.ts`

- [ ] **Step 1: Write failing table-driven projection tests**

For all 17 event types, prove the exact semantics in “Event projection semantics.” Include edit/delete/reaction removal/receipt/delivery/attachment before message creation; older events losing tuple comparison; same timestamps using opaque event-ID tie-break; local versus remote receipts; expired typing retained as data only; attachment metadata without bytes and exact count reconciliation; command/delivery observed-only behavior; and marker-only correction. For each child family, attempt the same child/target ID from another identity/account/conversation and require atomic `projection_conflict`. For each resource tombstone, send newer post-delete updates and prove no content resurrection. Assert conversation deletion clears version bodies, participants, attachments, reactions, receipts, typing, and delivery failure detail.

For every newly accepted event, query SQLite directly inside `runInDurableObject()` and assert its applied marker plus change row are both present and checkpoint/summary updates are transactionally consistent. Assert domain rows separately under LWW rules: an older newly accepted event intentionally adds audit/change rows while leaving the winning domain state unchanged. For a duplicate with no/newly equal checkpoint, assert every table remains unchanged; for a duplicate-only batch with a newer valid live checkpoint, assert only that checkpoint advances per the exact matrix. For any failed transaction, assert marker/change/domain/checkpoint all remain unchanged. Include a malicious payload string in a forced error and prove neither error message nor enumerable fields contain it.

- [ ] **Step 2: Prove RED**

```bash
pnpm --filter @communicator/control-plane test:worker -- worker/test/projection/projector.test.ts
```

- [ ] **Step 3: Implement the full projector switch**

Use exhaustive `switch (prepared.event.event_type)` with a `never` assertion. Each handler accepts only the SQL handle, one `PreparedProjectionEvent` (parsed envelope/payload, exact resolved connection, hash/bytes, parsed tuples), and a `Set` of touched conversation IDs. The existing DO transaction creates one set before its event loop, passes it to each projector call, and after all new events are projected invokes the projector's summary-recomputation helper once; that helper processes sorted conversation IDs individually. All of this remains inside the existing single transaction. It is synchronous and contains no binding access, network call, clock call, random value, log, or promise. Use parameterized SQL only. Split helpers by responsibility if `projector.ts` would exceed roughly 700 lines; acceptable names are `project-message.ts`, `project-social.ts`, and `project-control.ts` under the same folder, with no circular imports.

Implement scoped pending rows, centralized tombstone gating/redaction, delivery/read/attachment reconciliation, deterministic timestamp mapping, and one-at-a-time sorted summary recomputation exactly. Use event/lifecycle timestamps only; never `Date.now()` inside deterministic projection. A replay of the same event set in any batch grouping must converge to identical domain rows (excluding applied/change/source-progress ordering rows and local SQLite row IDs, which must not appear in results).

- [ ] **Step 4: Prove GREEN and deterministic rebuild equivalence**

Apply one fixture stream in chronological order to one tenant stub and reversed/batched order to another; after removing tenant ID, generation, applied-order rows, source-progress rows, and change-sequence numbers, assert all normalized domain/query rows are identical. Include 500 events touching 500 conversations to prove there is no parameter-limit failure. Then apply the stream twice and assert no domain row changes on the second application.

```bash
pnpm --filter @communicator/control-plane test:worker -- worker/test/projection/projector.test.ts
pnpm --filter @communicator/control-plane test:worker
```

- [ ] **Step 5: Commit**

```bash
git add apps/control-plane/worker/projection apps/control-plane/worker/test/projection/projector.test.ts
git commit -m "feat: project canonical messaging state"
```

### Task 6: Add identity-scoped seek-pagination query RPCs

**Files:**
- Create: `apps/control-plane/worker/projection/cursor.ts`
- Modify: `apps/control-plane/worker/projection/tenant-projection.ts`
- Create: `apps/control-plane/worker/test/projection/queries.test.ts`

- [ ] **Step 1: Write failing cursor/query tests**

Cover canonical unpadded base64url cursor round-trip; wrong tenant, identity, conversation, connection filter, generation, or literal query kind; padding, invalid alphabet, noncanonical JSON, oversized cursor, and hostile option objects. For conversations, assert required authorization/identity filtering, optional connection filtering, descending nonnullable activity with ID tie-break, exact 1/50/100 page bounds, no duplicates/gaps, message-less shells, and no deleted conversation. For messages, assert conversation ownership by identity, descending occurrence with ID tie-break, redacted deleted rows, no provider/Matrix aliases in output, and no cross-identity results. For changes, assert tenant-global sequence resume filtered by identity, generation match, exact retention boundary, `latest_sequence`, and max 100.

- [ ] **Step 2: Prove RED**

```bash
pnpm --filter @communicator/control-plane test:worker -- worker/test/projection/queries.test.ts
```

- [ ] **Step 3: Implement cursor and query RPCs**

Use descriptor-safe strict inputs. Define these exact cursor payloads—no aliases or optional extra fields:

```ts
type ConversationCursor = {
  schema_version: 1;
  query_kind: "projection.conversations";
  tenant_id: CanonicalResourceId;
  identity_id: CanonicalResourceId;
  connection_id: CanonicalResourceId | null;
  generation: number;
  last_activity_ms: number; // safe integer parsed from returned last_activity_at
  last_id: CanonicalResourceId;
};
type MessageCursor = {
  schema_version: 1;
  query_kind: "projection.messages";
  tenant_id: CanonicalResourceId;
  identity_id: CanonicalResourceId;
  conversation_id: CanonicalResourceId;
  generation: number;
  last_occurred_ms: number; // safe integer parsed from returned occurred_at
  last_id: CanonicalResourceId;
};
```

Encode canonical JSON as unpadded base64url; decode with strict alphabet, unused-bit, 2,048-character size, schema, canonical-re-encode, generation, and full context checks. Any cursor from an earlier rebuild generation fails `projection_conflict`. Never expose SQLite offsets.

Before ordinary queries, require the initialized tenant, `projection.read`, the requested identity in `allowed_identity_ids`, and `projection_meta.state='ready'`; a rebuilding object throws `projection_rebuilding`. Use indexed seek predicates and `LIMIT pageSize + 1`. Map stored `connection_id` directly to existing `ConversationSummarySchema`/`MessageSchema` compatible shapes; never substitute `account_id`. A redacted deleted message maps its cleared sender to `Deleted sender`. Return deep-frozen/copy-safe plain data.

`listChanges` returns only metadata needed for later WebSocket recovery; do not include message body or full payload. `generation` must equal current generation or fail `projection_conflict`. `latest_sequence` is the tenant-global maximum (zero when none). For the requested identity, let `floor` be `projection_change_floors.discarded_through_sequence` or zero. The boundary is exact: `reset_required = after_sequence < floor`. When true, return no items plus current generation/global latest sequence; when false, return identity-filtered rows with `sequence > after_sequence` in ascending order. This avoids silently skipping discarded history.

- [ ] **Step 4: Prove GREEN and query-plan indexes**

Use `EXPLAIN QUERY PLAN` assertions that tolerate SQLite wording changes but require the intended named compound indexes and reject a full table scan for populated fixtures.

```bash
pnpm --filter @communicator/control-plane test:worker -- worker/test/projection/queries.test.ts
pnpm --filter @communicator/control-plane test:worker
pnpm --filter @communicator/control-plane check
```

- [ ] **Step 5: Commit**

```bash
git add apps/control-plane/worker/projection/cursor.ts apps/control-plane/worker/projection/tenant-projection.ts apps/control-plane/worker/test/projection/queries.test.ts
git commit -m "feat: query tenant projection state"
```

### Task 7: Add resumable rebuild state and replay-safe RPCs

**Files:**
- Modify: `apps/control-plane/worker/projection/tenant-projection.ts`
- Create: `apps/control-plane/worker/test/projection/rebuild.test.ts`

- [ ] **Step 1: Write failing rebuild state-machine tests**

Test ready generation 1; tenant-wide rebuild authorization (including a multi-identity replay with `allowed_identity_ids: []`); begin with expected generation; atomic clearing of all derived/applied/change/checkpoint/floor rows but not schema/meta/`connection_bindings`/rebuild-history tables; generation increment; exact same-ID/expected-generation/started-at begin retry; same ID with changed start/generation rejection; different ID/generation conflicts; rejection of every completed/failed rebuild ID reuse; connection remap rejection across rebuild; live apply rejected while rebuilding; replay apply requires exact ID; ordinary queries rejected; status/checkpoint available; first completion and same-ID completion retry preserving the first timestamp; different-ID completion rejection; and live apply allowed afterward. Prove a failed begin/apply/abort/complete transition rolls back.

Exercise the recovery path explicitly: apply at least one valid partial page, then an invalid/unsupported/owner-conflict page; prove the failed page makes no changes and state remains rebuilding; call `abortRebuild`; prove partial domain/audit/checkpoint data is cleared and never queryable, state is `rebuild_failed`, status reports only bounded failure metadata, same exact abort retry is idempotent, and live/query/replay calls fail. Then begin a fresh never-used rebuild ID from the failed state, replay a corrected/supported stream, and complete successfully. Do not implement a skip-event escape hatch.

For replay continuity, cover: `page.tenant_id` must equal RPC/context/stored tenant; first source cursor must be null; a nonnull cursor decodes canonically and belongs to the tenant; next page must present the exact immediately persisted expected cursor; an unexpected/wrong-tenant/noncanonical source cursor fails without claiming skip/rewind classification; a nonnull next cursor equal to source fails while initial `null/null` terminal succeeds; an older event tuple on a later R2 page still advances source progress; same-page/same-digest crash retry returns the persisted result without new rows; same source/different digest conflicts; nonempty valid projection page; unsupported archive payload; 501-event/over-4-MiB page; empty nonterminal page; nonempty-manifest/empty-event page; empty terminal archive; terminal page; post-terminal page rejection; and completion only after terminal checkpoint.

- [ ] **Step 2: Prove RED**

```bash
pnpm --filter @communicator/control-plane test:worker -- worker/test/projection/rebuild.test.ts
```

- [ ] **Step 3: Implement the rebuild RPCs**

`beginRebuild` requires `projection.rebuild`, accepts caller-supplied validated `started_at`, and never uses wall-clock time. When ready or `rebuild_failed`, require `expected_generation === current generation` and reject a `rebuild_id` already present in persistent `completed_rebuilds` or `failed_rebuilds`. Delete derived/applied/change/floor/checkpoint tables in dependency-safe order inside `transactionSync`, but preserve `_sql_schema_migrations`, `projection_meta`, `connection_bindings`, and both rebuild-history tables. Reset SQLite autoincrement for `projection_changes` only if supported/tested, increment generation, set rebuilding metadata, and clear the active last-failure fields (history remains in `failed_rebuilds`). When already rebuilding with the same ID, return status only if `expected_generation === current generation - 1` **and** `started_at === stored rebuild_started_at`; otherwise fail `projection_rebuild_mismatch` without clearing. A different active ID also fails.

`abortRebuild` requires `projection.rebuild`, the exact active rebuild ID, caller-supplied `failed_at`, and one bounded `RebuildFailureCode`; it never stores an exception/message/payload. In one transaction, clear every partial derived/applied/change/floor/checkpoint row, reset the change sequence when supported, insert `{ rebuild_id, generation, failed_at, failure_code }` into `failed_rebuilds`, set state `rebuild_failed`, clear active rebuild fields, set last-failure fields, and set `updated_at=failed_at`. Preserve schema, tenant binding, connection bindings, and rebuild histories. When already failed, an exact retry matching the last failed ID/timestamp/code returns status unchanged; mismatched details/ID fail `projection_rebuild_mismatch`. It cannot abort ready state. Partial data is never restored or exposed as ready. Because R2 is immutable, an unsupported archive requires a projector/contract migration or corrected trusted reader before the next fresh rebuild; abort does not silently skip evidence.

`applyReplayPage` requires tenant-wide `projection.rebuild` plus matching tenant/rebuild ID; it deliberately does not consult `allowed_identity_ids`. It accepts a validated `ArchiveReplayPage`, additionally validates every event with `ProjectionEventEnvelopeSchema`, resolves the exact supplied D1-derived account→connection bindings, enforces 500 events/4 MiB, computes its own canonical page digest (including the resolved binding list), and delegates events to the same one-transaction projection path with mode `replay`; it never reads R2 itself. Nonnull source/next cursors must pass the existing `decodeReplayCursor` canonical and tenant checks.

Inside the same projection transaction, read the reserved `r2_manifest_cursor` checkpoint. For a new page, require `input.source_cursor` to equal the expected value (`null` when absent, otherwise the stored nonterminal `value`), then atomically store `source_cursor=input.source_cursor`, `page_digest`, `value=page.next_cursor ?? "terminal"`, current generation, deterministic timestamp fields, and the returned counts/sequence. Advance regardless of event tuple order. If input instead repeats the checkpoint's `source_cursor`, return the stored counts/sequence only when its computed digest matches; never run projection again. Reject every other cursor relation. The source cursor/digest continuity check is an extra integrity boundary around the future trusted R2 reader; it does not make fabricated pages safe for public callers, so this method remains unreachable from HTTP and arbitrary service bindings.

An empty page is accepted only when manifests/events are both empty and `next_cursor=null`; it creates the same terminal checkpoint using `rebuild_started_at` when no prior replay timestamp exists. Nonempty pages require manifests and events. Any invalid/unsupported/oversized page fails before SQL, leaving the object rebuilding and source cursor unchanged. A larger R2 read may be retried at page size 1 from the identical source cursor.

`completeRebuild` requires `projection.rebuild`, exact active rebuild ID, `terminal_cursor:null`, caller-supplied `completed_at`, and a stored current-generation `r2_manifest_cursor` checkpoint whose value is exactly `terminal`—including for an empty archive. The first completion atomically inserts `{ rebuild_id, generation, completed_at }` into `completed_rebuilds`, sets ready, clears active rebuild fields, records `last_completed_rebuild_id`, clears last-failure fields, and sets `updated_at=completed_at`. A later retry while ready with that exact remembered ID and valid null terminal cursor returns current status without changing the original completion timestamp; another/older ID fails `projection_rebuild_mismatch`. Completed/failed IDs can never begin a new rebuild. It never claims raw archive authority or performs external side effects. `getStatus` requires `projection.status`, remains callable in every state, and reports schema version, state, current/last completed/last failed rebuild IDs, bounded failure code, counts, latest sequence, and content-free checkpoint metadata.

- [ ] **Step 4: Prove GREEN, restart, and replay twice**

```bash
pnpm --filter @communicator/control-plane test:worker -- worker/test/projection/rebuild.test.ts
pnpm --filter @communicator/control-plane test:worker
pnpm --filter @communicator/control-plane check
```

Recreate/evict the class where the test runtime permits and prove resume state is entirely SQLite-backed. Rebuild twice from the same fixture archive and compare all query results for equality.

- [ ] **Step 5: Commit**

```bash
git add apps/control-plane/worker/projection/tenant-projection.ts apps/control-plane/worker/test/projection/rebuild.test.ts
git commit -m "feat: rebuild tenant projections safely"
```

### Task 8: Complete the local runbook and stable repository guards

**Files:**
- Create: `docs/runbooks/tenant-projection-local.md`
- Modify: `tests/test_repository_contract.py` only for stable guards

- [ ] **Step 1: Document the operational contract**

Include the simple model, ownership boundaries, deterministic tenant naming, declarative export/bindings, local-only test commands, table/index overview, authorization context/scopes, persistent account→connection binding invariant, tenant-unique resource IDs, idempotency/conflict rules, transaction boundary, exact generic versus R2 checkpoint mutation table, replay cursor/digest continuity and the opaque-cursor no-skip-proof limitation, rebuild state machine/resume procedure, abort-to-failed recovery and never-used rebuild-ID rule, change retention/gap behavior, generation-bound identity queries, storage/parameter/row limits, tenant-derived media-key validation, redaction/forbidden data, and explicit excluded scope. State that an invalid immutable page remains unapplied, an operator abort removes all partial projection content while retaining only bounded failure metadata, and a corrected projector/reader can start a fresh rebuild without skipping archive evidence. State that R2 is the rebuild archive and Synapse remains operational messaging record; DO SQLite is disposable. State that the future authenticated Worker derives authorization and connection mappings from D1 and that `applyReplayPage` may only be called by the trusted R2-reader orchestration path. Link the official current Cloudflare references from this plan.

- [ ] **Step 2: Add narrow guards only**

Stable Python guards may assert the top-level SQLite export, three environment bindings, generated binding type, class export, absence of legacy DO migrations, absence of provider/Matrix/Queue/R2 calls within `worker/projection`, and no credential-like fields. Do not pin prose, line order, generated timestamps, test totals, or full SQL text.

- [ ] **Step 3: Verify**

```bash
python3 -m unittest tests.test_repository_contract -v
! rg -n "access[_-]?key|secret[_-]?key|BEGIN .*PRIVATE KEY|provider_cookie|matrix_access_token|e2ee_key" apps/control-plane/worker/projection docs/runbooks/tenant-projection-local.md apps/control-plane/wrangler.jsonc
git diff --check
```

Expected secret scan: no real credential or forbidden stored field. Test strings that assert absence may appear only under test paths.

- [ ] **Step 4: Commit**

```bash
git add docs/runbooks/tenant-projection-local.md tests/test_repository_contract.py
git commit -m "docs: add tenant projection operations contract"
```

Omit the Python file if unchanged.

### Task 9: Fresh independent phase verification

The implementation worker does not perform this task. Assign a fresh `gpt-5.6-luna`, `reasoning_effort=max`, `fork_turns=none` testing worker.

- [ ] **Step 1: Audit scope and generated configuration**

```bash
git status --short --branch
git log --oneline origin/main..HEAD
git diff --stat origin/main...HEAD
git diff --name-only origin/main...HEAD
pnpm --filter @communicator/control-plane types:worker
git diff --exit-code -- apps/control-plane/worker-configuration.d.ts
```

Fail for any UI/API route, D1 migration, Queue, Matrix/provider, R2 behavior, Compose/VPS/deployment, secret, or runtime-state change.

- [ ] **Step 2: Run all gates**

```bash
pnpm check
pnpm test
pnpm --filter @communicator/control-plane test:e2e
chmod 0755 scripts/init-telegram-runtime.sh
python3 -m unittest discover -s tests -q
git diff --check
git status --short
```

Record actual totals. Do not compare them with this plan.

- [ ] **Step 3: Report PASS/FAIL for the adversarial audit**

1. one deterministic DO per tenant and three environment bindings;
2. stored tenant binding rejects a misrouted tenant;
3. all 17 payload schemas are strict and bounded;
4. trusted account→connection bindings are exact and API results never alias account IDs;
5. preflight/hash completes before one synchronous transaction;
6. no internal DO helper is RPC-addressable (runtime `#private` or module-private only);
7. duplicate same hash/binding is harmless; conflicting hash or binding fails closed;
8. applied marker, derived rows, change, and checkpoint are atomic;
9. out-of-order batches converge by tuple and rebuild twice is equivalent;
10. every RPC checks its narrow authorization scope; queries additionally check allowed identity;
11. conversation/message queries use generation- and context-bound seek cursors;
12. cross-tenant, reused resource ID across owners, and cursor substitution fail closed;
13. partial rebuild data cannot be queried; R2 cursor/digest continuity and same-page retry are idempotent; an invalid immutable page can be atomically aborted into `rebuild_failed`, all partial content is removed, and a fresh never-used rebuild can succeed;
14. tombstones prevent all later content resurrection and cascade every specified redaction;
15. attachment R2 keys are null or exactly tenant/hash-derived; no bytes/secrets/content-bearing logs or error leakage;
16. replay performs no R2/Queue/Matrix/provider/HTTP/WebSocket/alarm/automation action;
17. schema migration is restart-safe and does not use `PRAGMA user_version`;
18. no public API/UI/ingestion/deployment/Data Catalog/Pipeline/Brain scope creep.

Any failure returns to the responsible task with a focused red regression before a fix.

### Task 10: Primary-agent review, PR, and merge

The primary orchestrator performs this task.

- [ ] **Step 1: Review every commit and full diff**

Inspect current Cloudflare types/config schema, transaction boundaries, query plans, SQL parameter counts, tenant/identity validation, hostile input handling, deterministic ordering, tombstone/redaction semantics, rebuild transitions, error leakage, and scope.

- [ ] **Step 2: Run final proportional gates**

```bash
pnpm check
pnpm test
git diff --check
git status --short
```

- [ ] **Step 3: Push and open one PR**

Title: `feat: add tenant SQLite projection durable object`

The PR body must state that this is an internal, rebuildable projection; list typed event projection, idempotent atomic application, identity-scoped queries, checkpoints/rebuild; include exact verification evidence; and state that no live Cloudflare namespace was provisioned/deployed and no public API/Queue/provider behavior was added.

- [ ] **Step 4: Require a mergeable, independently reviewed, green state; merge and fast-forward `main`**

Do not merge with findings, conflicts, dirty/generated drift, failed checks, or unknown GitHub status. After merge:

```bash
cd /home/ubuntu/communicator
git pull --ff-only
git status --short --branch
git rev-parse HEAD
git rev-parse origin/main
```

## Phase acceptance checklist

- [ ] one SQLite-backed `TenantProjectionDO` is deterministically routed per tenant;
- [ ] declarative class export and every environment binding are correct and generated types are stable;
- [ ] stored tenant binding prevents alias/misrouting leakage;
- [ ] schema migrations are versioned, restart-safe, and constructor-only;
- [ ] all 17 canonical event types have strict projection payloads;
- [ ] canonical accounts resolve through exact trusted bindings and public results expose real connection IDs;
- [ ] Communicator resource IDs are tenant-unique and owner reuse fails closed;
- [ ] batches are bounded, copied, canonical-hashed, deterministically ordered, and preflighted before SQL;
- [ ] only intended RPC methods are runtime-visible; every internal DO helper uses ECMAScript `#private` or module-private scope;
- [ ] one transaction atomically applies event markers, derived rows, summaries, changes, and checkpoint;
- [ ] exact duplicates are no-ops and conflicting duplicates fail closed;
- [ ] out-of-order event grouping converges deterministically;
- [ ] conversation/message/change queries are bounded, seek-paginated, and identity-scoped;
- [ ] every RPC checks a narrow trusted authorization context and defaults to deny;
- [ ] query/change cursors are generation-bound and retained-change gaps are exact;
- [ ] rebuild is resumable, source-cursor/digest continuous, idempotent, hides partial state, and can abort safely into a content-free failed state before a fresh rebuild;
- [ ] replay twice yields equivalent query state and has no side effects;
- [ ] attachment bytes, credentials, provider sessions, Matrix secrets, and E2EE keys are absent;
- [ ] nonnull attachment R2 keys exactly match `media/{tenant}/{sha256}`;
- [ ] R2/Synapse/DO authority boundaries and deletion/retention deferrals remain intact;
- [ ] no public API, Queue, provider mutation, deployment, Data Catalog, Pipeline, or Brain coupling is added;
- [ ] all repository, Worker, browser, Python, generated-type, and formatting checks pass;
- [ ] fresh Luna verification and primary review have no remaining findings;
- [ ] the phase PR is merged and local `main` is clean/current.

## Next phase after merge

Write a new detailed plan for the Queue/ingestion adapter that takes canonical Matrix-consumer batches, writes the ordinary R2 archive with the existing two-stage protocol, applies the same batch to `TenantProjectionDO`, and advances its source checkpoint only under an explicitly chosen failure/retry policy. Do not add the public API or outbound provider commands until that ingestion consistency contract is merged.
