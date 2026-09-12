# Authenticated Matrix Ingestion and Queue Projection Implementation Plan

> **Execution requirement:** Implement this plan sequentially in the dedicated
> `codex/matrix-queue-ingestion` worktree. Every implementation task must be
> performed by a `gpt-5.6-luna` worker with `reasoning_effort: max` and
> `fork_turns: none`. The primary agent owns orchestration, architecture
> decisions, review, verification, commits, the pull request, and merge. Do not
> use a Sol model for implementation.

**Goal:** Add the authenticated Cloudflare ingestion boundary and Queue
consumer that connect already-normalized Matrix events to the existing R2
archive and `TenantProjectionDO`, without yet implementing the Contabo Matrix
Gateway itself.

**Architecture:** The private Matrix Gateway will submit one-tenant,
projection-valid canonical batches over authenticated HTTPS. The Worker will
authorize the gateway route from D1, commit the immutable R2 batch, and enqueue
a small pointer to that committed batch. A Queue consumer will read and verify
the committed R2 pair, resolve immutable account bindings from D1, apply the
events atomically to the tenant DO, and acknowledge only that successful Queue
message.

**Technology:** TypeScript 7, Zod 4, Hono, Cloudflare Workers, Queues, R2, D1,
SQLite Durable Objects, Wrangler, `@cloudflare/vitest-plugin`, Vitest, pnpm.

---

## Simple explanation

This phase builds the reliable pipe between Matrix and the Communicator data
model.

The Matrix Gateway will eventually send a batch of decrypted, normalized
events to one private API endpoint. The endpoint checks that the Gateway is
allowed to submit those exact accounts and identities. It then saves the batch
to R2 before doing anything else. Only after R2 confirms the batch is safely
committed does the Worker put a tiny reference to it on Cloudflare Queues.

The Queue consumer follows that reference, verifies the R2 data again, and
updates the correct tenant Durable Object. If anything fails, the Queue message
is retried. Repeating a request or Queue delivery is safe and does not create
duplicate messages. A failed DO can always be rebuilt from R2.

This phase does **not** connect to Synapse yet. It creates and proves the exact
HTTP contract that the later Matrix Gateway will use.

---

## Position in the approved delivery sequence

This is milestone 8 in
`docs/superpowers/specs/2026-08-27-communicator-cloudflare-data-plane-design.md`:

> authenticated ingestion Worker and Queue consumer

Milestones already merged:

- D1 Control Directory, product OIDC validation, and tenant/identity
  authorization;
- ordinary R2 archive and replay manifest contract; and
- `TenantProjectionDO` schema, migrations, live ingestion RPC, queries, and
  rebuild protocol.

The next milestones remain:

- versioned live read API;
- hibernatable WebSocket subscriptions;
- the Contabo Matrix Gateway event consumer and encrypted local outbox; and
- outbound command coordination.

---

## Locked phase decisions

1. **Archive first.** A verified R2 data/manifest pair is the ingestion commit
   marker and the loss-prevention boundary.
2. **Queue a pointer, not the event body.** Cloudflare Queue messages are
   limited to 128 KB, while the approved archive/projection batch is up to 500
   events and 4 MiB uncompressed. The Queue body therefore contains only a
   strict committed-archive pointer.
3. **The ingress endpoint returns `202` only after both R2 commit and Queue
   send succeed.** A committed archive followed by a Queue-send failure returns
   a retryable `503`; the same request safely resends the same pointer.
4. **One ingress request, R2 batch, Queue pointer, and DO apply belong to exactly
   one tenant.** Mixed-tenant input is rejected before any durable write.
5. **Only projection-valid canonical events enter this pilot archive path.**
   The endpoint parses every event with `ProjectionEventEnvelopeSchema` before
   the first R2 write.
6. **Dedicated machine authentication.** The ingestion endpoint uses the
   existing OIDC/JWKS verifier primitive but a separate ingestion audience and
   a dedicated middleware. Only an active D1 principal of type `service` bound
   to an active gateway route may submit.
7. **Caller identifiers are never authority.** D1 must confirm the authenticated
   service principal, gateway route, tenant, account, connection, identity, and
   provider for every event.
8. **Account ownership is immutable.** `account_id -> connection_id` and the
   connection's tenant/identity/provider cannot be silently reassigned. A
   mapping may be retired, but accepted archives remain projectable.
9. **No third ingestion ledger.** The R2 manifest proves archive commitment,
   the DO `applied_events` table proves projection idempotency, and Queue/DLQ
   owns delivery state. Another D1/R2 ledger would add a failure boundary
   without making R2 and DO transactional.
10. **Per-message Queue decisions.** Successful siblings are explicitly
    acknowledged; each failed sibling is explicitly retried. Never call
    `ackAll()` for a mixed result.
11. **All Queue failures retry.** Retryable outages use a short retry delay;
    invalid/conflicting poison messages use a longer delay and ultimately move
    to the configured DLQ. The consumer never acknowledges a failed pointer.
12. **No ordering assumption.** Queue delivery is not ordered. R2 writes are
    immutable and the DO's event hashes plus last-write-wins rules provide
    convergence under duplicates and reordering.
13. **Source and projection checkpoints are different.** R2 stores a one-way
    digest of the Matrix source checkpoint. The DO stores only a derived live
    event watermark. Neither contains the raw Matrix `/sync` token.
14. **No credentials in Cloudflare data records.** Matrix tokens, E2EE keys,
    bridge/appservice secrets, provider sessions, OIDC tokens, and raw sync
    responses never enter an event, Queue message, R2 object, DO, fixture,
    error, log, or trace.
15. **The Queue consumer does not use public-user authorization.** It creates a
    narrow internal `projection.write` context from trusted D1 ownership.
16. **The DO remains externally I/O-free.** R2, D1, Queue, and authentication
    work stays in the Worker orchestration layer, outside a DO transaction.
17. **The later Matrix Gateway owns E2EE and raw source progress.** This phase
    freezes that boundary but does not add a Synapse client or alter bridge
    code.
18. **No live production event ingestion is enabled merely by merging.** Live
    Cloudflare resources and the Contabo Gateway require the later deployment
    gate and protected credentials.
19. **Empty Cloudflare resources may be provisioned during configuration.** If
    staging/production D1, Queue, or R2 resources do not exist, the primary
    agent may create only the exact reviewed empty resources through the connected
    Cloudflare API. Resource creation does not authorize a Worker deployment or
    live ingestion.

---

## Explicitly excluded scope

Do not implement any of the following in this plan:

- a Synapse `/sync` client or Matrix sliding-sync client;
- Matrix E2EE device/session/key storage;
- the Matrix Gateway local SQLite outbox;
- conversion from raw Matrix events into canonical events;
- WhatsApp, Telegram, Messenger, or LinkedIn bridge changes;
- bridge database reads;
- backfill orchestration;
- media download or attachment-byte archiving;
- public conversation/read APIs or WebSockets;
- outbound sends, typing, receipts, reactions, edits, or command scheduling;
- connection-linking UI or bridge provisioning;
- automated R2 rebuild orchestration;
- R2 Data Catalog, Pipelines, Parquet, or Brain integration;
- a second analytics database;
- a public management API for gateway routes or account mappings;
- production deployment or DNS changes; or
- modifying vendored or upstream Synapse/mautrix source code.

Fixtures and operator-only D1 seed helpers may create route/account records for
tests. Public management endpoints are a later connection-lifecycle milestone.

---

## Current Cloudflare references that constrain the implementation

Re-verify these pages from official Cloudflare documentation immediately before
implementation if a numeric value or API shape has changed:

- Queue JavaScript APIs and 128 KB message-body limit:
  <https://developers.cloudflare.com/queues/configuration/javascript-apis/>
- Queue batching, per-message acknowledgement, and retry behavior:
  <https://developers.cloudflare.com/queues/configuration/batching-retries/>
- Queue delivery does not guarantee global ordering:
  <https://developers.cloudflare.com/queues/reference/how-queues-works/>
- Wrangler Queue producer/consumer configuration:
  <https://developers.cloudflare.com/workers/wrangler/configuration/>
- Dead-letter queues:
  <https://developers.cloudflare.com/queues/configuration/dead-letter-queues/>
- Workers Vitest Queue helpers (`createMessageBatch`, `getQueueResult`):
  <https://developers.cloudflare.com/workers/testing/vitest-integration/test-apis/>

Repository limits remain authoritative unless a separately reviewed migration
changes them:

- `MAX_ARCHIVE_EVENTS = 500`;
- `MAX_EVENT_CANONICAL_BYTES = 1 MiB`;
- `MAX_ARCHIVE_UNCOMPRESSED_BYTES = 4 MiB`;
- `MAX_ARCHIVE_COMPRESSED_BYTES = 5 MiB`;
- `MAX_PROJECTION_BATCH_EVENTS = 500`; and
- `MAX_PROJECTION_BATCH_BYTES = 4 MiB`.

Do not reduce those limits merely to fit event bodies into a Queue message.

---

## End-to-end protocol

```text
future verified Matrix Gateway on Contabo
  |
  | POST /internal/v1/ingestion/batches
  | Authorization: Bearer <service JWT with required iat/exp and <=5 minute TTL>
  | one tenant, stable batch_id, projection-valid events
  v
Cloudflare control-plane Worker
  1. bounded body read and strict schema parse
  2. verify ingestion OIDC audience and active service principal
  3. resolve active gateway route in D1
  4. resolve and validate every active account/connection binding in D1
  5. recompute deterministic batch_id
  6. create-or-verify R2 data object
  7. create-or-verify R2 manifest (commit marker)
  8. send strict small pointer to INGESTION_QUEUE
  9. return HTTP 202
          |
          v
Cloudflare Queue
  body contains no event payload or credential
          |
          v
Queue consumer in control-plane Worker
  1. strict pointer parse
  2. exact R2 manifest/data read and verification
  3. pointer/manifest/digest/tenant/batch equality checks
  4. parse every archived event as a projection event
  5. resolve immutable historical bindings from D1
  6. initialize tenant DO idempotently
  7. derive exact live event watermark
  8. TenantProjectionDO.applyBatch() atomically
  9. message.ack()
```

The invariant is:

```text
HTTP 202
  => verified R2 data/manifest pair exists
  && at least one corresponding Queue pointer send completed

Queue message acknowledged
  => exact verified R2 batch exists
  && exact tenant DO transaction committed
```

The reverse implications are not required. A response can be lost after Queue
send, or an acknowledgement can be lost after DO commit. Those windows produce
safe duplicate work.

---

## Contract shapes

Create `packages/contracts/src/ingestion.ts` and export it from
`packages/contracts/src/index.ts`.

Export these named symbols from that module:

```ts
MAX_INGESTION_REQUEST_BYTES = 32 * 1024 * 1024
MAX_INGESTION_QUEUE_POINTER_BYTES = 8 * 1024
MAX_INGESTION_TIMESTAMP_CHARS = 64
MAX_INGESTION_PRODUCER_VERSION_CHARS = 128
MatrixCheckpointDigestSchema
IngestionBatchRequestSchema
IngestionAcceptedResponseSchema
CommittedArchivePointerSchema
IngestionCommittedArchiveManifestSchema
IngestionErrorCodeSchema
IngestionErrorResponseSchema
```

All schemas must use the repository's descriptor-safe strict-object and
strict-array pattern. They must reject accessors, proxy traps, inherited
properties, symbols, sparse arrays, unexpected fields, and prototype-sensitive
keys without invoking hostile code.

### Ingestion request

```ts
type IngestionBatchRequest = {
  schema_version: 1;
  gateway_route_id: CanonicalResourceId;
  tenant_id: CanonicalResourceId;
  batch_id: CanonicalResourceId; // batch_<64 lowercase hex>
  archived_at: Timestamp;        // stable across every retry
  producer_version: string;      // stable, 1..128 printable chars
  source_checkpoint: {
    kind: "matrix_sync_token_sha256";
    value: `sha256:${string}`;    // exactly 64 lowercase hex after prefix
  };
  events: ProjectionEventEnvelope[]; // 1..500, one tenant
};
```

`archived_at` uses `TimestampSchema.max(64)`. `producer_version` must be 1–128
ASCII printable characters (`0x20..0x7e`) with no leading/trailing whitespace;
reject rather than trim a noncanonical input. Use the named exported constants
above in tests and Worker code.

Cross-field refinements:

- every event `tenant_id` equals request `tenant_id`;
- every event is projection-valid, not merely canonical-envelope-valid;
- event IDs are unique within the batch;
- at least one account is present;
- `batch_id` matches `^batch_[0-9a-f]{64}$`;
- `source_checkpoint.value` is only a digest and never a raw token;
- `archived_at`, `producer_version`, and source checkpoint are nonempty and
  bounded; and
- canonical encoded event bytes remain within existing archive limits.

The Worker-level preparation helper, not Zod alone, performs canonical-byte
encoding, byte limits, hashing, sorted-event normalization, and batch-ID
recomputation before the first write.

The HTTP transport adds `MAX_INGESTION_REQUEST_BYTES = 32 * 1024 * 1024`. This
is not an archive limit. It is a bounded wire-parsing ceiling that accommodates
the approved 4 MiB canonical JSONL even when a JSON sender uses legal six-byte
`\uXXXX` escapes plus envelope overhead. The future Gateway must send compact
UTF-8 JSON. Insignificant whitespace or alternate escaping cannot bypass the
32 MiB transport ceiling; a semantically equivalent but pathologically bloated
wire representation may be rejected. Every accepted request must satisfy both
the transport ceiling and the stricter existing canonical archive limits.

### Deterministic batch identity

Reuse `encodeCanonicalEventBatch` to obtain the exact canonical JSONL bytes and
`canonical_sha256`. The digest includes one final newline per event exactly as
the archive codec already specifies.

Build a null-prototype object whose keys are written in this exact order, encode
it through the existing canonical JSON encoder, and hash its UTF-8 bytes:

```json
{
  "schema_version": 1,
  "tenant_id": "tenant_...",
  "gateway_route_id": "gateway_route_...",
  "canonical_sha256": "<64 lowercase hex>",
  "source_checkpoint": {
    "kind": "matrix_sync_token_sha256",
    "value": "sha256:<64 lowercase hex>"
  },
  "archived_at": "<canonical input timestamp>",
  "producer_version": "<stable gateway release>"
}
```

```text
batch_id = "batch_" + sha256(canonical UTF-8 JSON above)
```

The ingress route rejects a mismatched caller `batch_id` before R2 or Queue I/O.
Changing any immutable input while reusing a batch ID is invalid. An exact
retry recomputes exactly the same ID, archive keys, manifest, and Queue pointer.

Do not derive `archived_at` from the Worker clock. The future Gateway will
persist it with the batch in its protected local outbox.

### Accepted response

```ts
type IngestionAcceptedResponse = {
  schema_version: 1;
  tenant_id: CanonicalResourceId;
  batch_id: CanonicalResourceId;
  status: "accepted";
  archive_status: "created" | "already_committed";
};
```

Return status `202`. Do not return R2 keys, digests, event IDs, Queue IDs,
connection routes, Matrix identifiers, or authorization details.

### Queue pointer

```ts
type CommittedArchivePointer = {
  schema_version: 1;
  kind: "archive.batch.committed";
  tenant_id: CanonicalResourceId;
  batch_id: CanonicalResourceId;          // exact batch_<sha256>
  manifest_key: ArchiveManifestKey;
  canonical_sha256: string;               // 64 lowercase hex
  gateway_route_id: CanonicalResourceId;
};
```

The schema must verify that `manifest_key` encodes the same tenant and batch.
The pointer is expected to be far below 128 KB; additionally enforce a local
maximum of 8 KiB over its canonical JSON bytes before calling Queue `send()`.
No event body, source checkpoint, Matrix identifier, user content, or token is
present.

### Error envelope

Use the existing public shape:

```ts
type IngestionErrorResponse = {
  error: {
    code:
      | "ingestion_invalid"
      | "ingestion_too_large"
      | "ingestion_unauthenticated"
      | "ingestion_not_found"
      | "ingestion_conflict"
      | "ingestion_unavailable";
    message: string;
  };
};
```

Messages are fixed, generic, and content-free. Do not serialize Zod issues,
database errors, R2 keys, Queue errors, exception messages, or causes.

HTTP mapping:

| Condition | Status | Code |
|---|---:|---|
| malformed/unknown field/mixed tenant/batch-ID mismatch | 400 | `ingestion_invalid` |
| HTTP body or canonical batch over a limit | 413 | `ingestion_too_large` |
| absent, invalid, expired, missing-time-claim, overlong, wrong-audience token | 401 | `ingestion_unauthenticated` |
| unknown/disabled principal or route; unmapped/inactive account | 404 | `ingestion_not_found` |
| immutable archive conflict | 409 | `ingestion_conflict` |
| D1, R2, JWKS, or Queue transient failure | 503 | `ingestion_unavailable` |
| R2 committed and Queue send completed | 202 | accepted response |

Treat disabled/unknown ownership as `404` so callers cannot distinguish which
identifier exists.

---

## D1 control-directory migration

Add `apps/control-plane/migrations/0002_ingestion_routing.sql`.

The migration must be forward-only and must not rewrite
`0001_control_directory.sql`.

Required logical schema:

```sql
CREATE TABLE gateway_routes (
  id TEXT PRIMARY KEY,
  service_principal_id TEXT NOT NULL
    REFERENCES principals(id) ON DELETE RESTRICT,
  status TEXT NOT NULL
    CHECK (status IN ('active', 'disabled', 'revoked')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  revoked_at TEXT,
  CHECK (
    (status = 'revoked' AND revoked_at IS NOT NULL) OR
    (status <> 'revoked' AND revoked_at IS NULL)
  )
);

CREATE TABLE connection_accounts (
  account_id TEXT PRIMARY KEY,
  connection_id TEXT NOT NULL UNIQUE
    REFERENCES connections(id) ON DELETE RESTRICT,
  status TEXT NOT NULL
    CHECK (status IN ('active', 'retired')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  retired_at TEXT,
  CHECK (
    (status = 'retired' AND retired_at IS NOT NULL) OR
    (status = 'active' AND retired_at IS NULL)
  )
);
```

Add indexes for gateway route service/status and account connection/status.

Add triggers that abort any update of:

- `gateway_routes.id`;
- `gateway_routes.service_principal_id`;
- `connection_accounts.account_id`; or
- `connection_accounts.connection_id`.

Also add historical-lifecycle triggers that:

- deny deletion of a `gateway_routes` or `connection_accounts` row;
- deny changing `connections.tenant_id`, `connections.identity_id`, or
  `connections.provider` once that connection has a `connection_accounts` row;
- deny changing `principals.issuer`, `principals.subject`, or
  `principals.principal_type` once that principal is referenced by a
  `gateway_routes` row;
- deny changing `connection_routes.connection_id` or
  `connection_routes.gateway_route_id` once that connection has a
  `connection_accounts` row; and
- deny deletion of `connection_routes` once its connection has a
  `connection_accounts` row;
- make `principals.status = 'revoked'` terminal and preserve the first
  non-null `principals.revoked_at` value. A revoked principal is never
  reactivated; credential rotation creates a new principal instead;
- make `revoked_tokens` append-only by denying every `UPDATE` and `DELETE`.
  A revoked issuer/JTI pair is never reused; credential rotation issues a new
  JTI (and a new principal when principal credentials rotate);
- make `connection_accounts.status = 'retired'` terminal; and
- make `gateway_routes.status = 'revoked'` terminal.

Other lifecycle status/timestamp updates remain allowed and are the
retirement/revocation mechanism. `connection_routes.gateway_route_id` already exists; resolution must
join it to `gateway_routes.id` even though the original table cannot gain a new
foreign key without rebuilding it. The conditional triggers deliberately let
an unregistered legacy `connection_routes` row be corrected before its first
account mapping is inserted; after that insert, historical ownership is frozen.

Required repository operations in
`apps/control-plane/worker/control-directory/ingestion-repository.ts`:

```ts
type ActiveIngestionRoute = {
  gateway_route_id: string;
  service_principal_id: string;
};

type ArchivedIngestionRoute = ActiveIngestionRoute;

type ActiveIngestionService = {
  service_principal_id: string;
  issuer: string;
  subject: string;
  token_id: string;
};

type IngestionConnectionBinding = ProjectionConnectionBinding & {
  gateway_route_id: string;
  account_status: "active" | "retired";
};

findActiveIngestionService(db, issuer, subject, tokenId)
resolveActiveIngestionRoute(db, servicePrincipalId, gatewayRouteId)
resolveActiveIngressBindings(db, gatewayRouteId, tenantId, accountIds)
resolveArchivedIngestionRoute(db, gatewayRouteId)
resolveArchivedBindings(db, gatewayRouteId, tenantId, accountIds)
```

Use these exact return shapes:

```ts
findActiveIngestionService(...):
  Promise<IngestionDirectoryResult<ActiveIngestionService>>;
resolveActiveIngestionRoute(...):
  Promise<IngestionDirectoryResult<ActiveIngestionRoute>>;
resolveActiveIngressBindings(...):
  Promise<IngestionDirectoryResult<IngestionConnectionBinding[]>>;
resolveArchivedIngestionRoute(...):
  Promise<IngestionDirectoryResult<ArchivedIngestionRoute>>;
resolveArchivedBindings(...):
  Promise<IngestionDirectoryResult<IngestionConnectionBinding[]>>;
```

Every function returns an explicit discriminated result:

```ts
type IngestionDirectoryResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: "not_found" | "unavailable" };
```

Rules:

- authentication requires an active `service` principal;
- service JWTs require a `jti`; a matching revoked token is denied;
- ingress requires active tenant, identity, route, and account mapping;
- ingress rejects connection states `revoked` and `unlinked`, but accepts
  `connected`, `syncing`, `ready`, `attention_required`, and `disconnected` so
  an already-spooled message is not stranded by a temporary connection state;
- every account is resolved in one bounded query or bounded chunked queries;
- exact requested account coverage is required—no missing or extra binding;
- event identity and platform must equal the trusted connection row;
- `connection_routes.gateway_route_id` must equal the authenticated route;
- consumer-time resolution accepts active or retired account mappings and
  inactive connection/identity/tenant lifecycle states, because the batch was
  already authorized and committed; however immutable ownership and route
  equality must still match;
- consumer-time route resolution accepts an inactive route/principal but must
  return the immutable route owner from D1; the Queue pointer deliberately does
  not carry a principal ID and the consumer must use only the D1 result;
- rows are returned sorted uniquely by UTF-8 `account_id`; and
- any D1 error becomes an internal generic unavailable result without leaking
  SQL or row details.

All authorization, route, and binding reads must start from
`db.withSession("first-primary")`. A revocation or disablement committed just
before ingress must be visible to the decision; do not authorize from a stale
replica or an earlier cached directory result.

Do not accept bindings from the request or Queue message.

---

## Authentication boundary

Add independent ingress configuration:

```text
COMMUNICATOR_INGRESS_ENABLED
COMMUNICATOR_INGESTION_OIDC_ISSUER
COMMUNICATOR_INGESTION_OIDC_AUDIENCE
COMMUNICATOR_INGESTION_OIDC_JWKS_URL
```

`COMMUNICATOR_INGRESS_ENABLED` is the literal string `"true"` or `"false"`
and defaults to `"false"` in every committed environment. When false, the HTTP
route returns generic `503 ingestion_unavailable` before authentication/body
read or any D1/R2/Queue I/O. The Queue consumer does **not** use this flag: it
continues safely draining pointers that were accepted before ingress closed.
Enabling production requires a later explicit deployment change and staging
smoke test; merging this phase cannot start ingestion.

A full operational pause is not implemented by returning `retry()` from a live
consumer because that would burn retry budget. The runbook pause sequence is:

1. set ingress false and deploy/verify the route gate;
2. either let the consumer drain accepted pointers, or pause/detach the hosted
   Queue consumer through Cloudflare configuration;
3. monitor backlog age against the recorded Queue retention and the 12-hour
   operator SLA; and
4. reattach/resume before retention expiry, then enable ingress only after the
   backlog is healthy.

Local tests prove flag behavior and per-message retry rules. The later staging
smoke test proves hosted pause/resume and in-flight delivery without exhausting
the retry budget.

The audience must be distinct from `COMMUNICATOR_OIDC_AUDIENCE`. The route must
not use `createAuthorizationMiddleware`, memberships, `X-Communicator-Tenant`,
or browser session authorization.

Add `createIngestionAuthorizationMiddleware` that:

1. parses one bearer token through `parseBearerToken`;
2. verifies issuer, signature, algorithm, and ingestion audience using a
   dedicated `createOidcVerifier` configuration;
3. requires integer NumericDate `iat` and `exp` claims, requires `exp > iat`,
   rejects `exp - iat > INGESTION_TOKEN_MAX_TTL_SECONDS`, rejects an `iat`
   farther than `INGESTION_TOKEN_CLOCK_TOLERANCE_SECONDS` in the future, and
   validates `exp` and optional `nbf` with that same bounded tolerance. Export
   fixed code constants of 300 seconds maximum TTL and 30 seconds clock
   tolerance; do not make production accept an unbounded deployment value;
4. requires `token_id`/JWT `jti`;
5. opens the D1 session;
6. resolves an active `service` principal;
7. checks `revoked_tokens`;
8. stores only `{service_principal_id, issuer, token_id}` in Hono variables; and
9. returns a generic 401/404/503 error on failure.

The route then proves that this service principal owns the requested active
gateway route. Product users, agents, operators, owners, and admins are not
implicitly allowed.

The production issuer/JWKS/audience values remain deployment configuration.
No JWT, private key, service secret, or test signing key is committed.

---

## Source checkpoint and future Matrix Gateway contract

This phase accepts only:

```json
{
  "kind": "matrix_sync_token_sha256",
  "value": "sha256:<64 lowercase hex>"
}
```

The later Gateway computes the digest over the exact raw Matrix `next_batch`
token but stores the raw token only in its protected local SQLite store.

`IngestionCommittedArchiveManifestSchema` is the ingestion-specific committed-
manifest validator. It must first parse the generic
`ArchiveBatchManifestSchema`, then require a non-null checkpoint whose kind/value
exactly match the ingestion digest contract above. The ingress route
validates the manifest returned by the writer before Queue send, and the Queue
consumer repeats this validation after R2 read. The generic archive library may
continue supporting other bounded checkpoint kinds for future non-Matrix
archives; no generic archive entry point is exposed to untrusted callers.

The later Gateway protocol is frozen as follows:

1. receive/decrypt a Matrix sync response through a verified device;
2. normalize one or more one-tenant canonical batches;
3. persist each batch, its stable `archived_at`, deterministic `batch_id`, and
   the raw next token in a protected, fsynced local SQLite outbox;
4. submit/retry the exact batch until the Worker returns `202`;
5. advance the durable raw Matrix checkpoint only after every tenant batch for
   that sync response is accepted; and
6. compact the outbox only after checkpoint persistence.

A crash after Queue send but before response/checkpoint persistence causes an
exact retry. It must not cause event loss. If Cloudflare is unavailable, the
Gateway replays its outbox before reading more sync pages. At a disk high-water
mark it pauses sync and alerts instead of dropping events.

Undecryptable encrypted events remain pending locally. Ciphertext is never
silently submitted as a normalized message, and skipping an undecryptable
event is a future explicit audited operator action.

This plan adds documentation and contract tests for this boundary, but does not
implement the Gateway or outbox.

---

## Projection checkpoint derivation

The R2 source checkpoint and DO live checkpoint are not interchangeable.

For Queue projection, derive:

```ts
{
  kind: "live_event_watermark",
  value: maxEvent.event_id,
  last_observed_at: maxEvent.observed_at,
  last_event_id: maxEvent.event_id,
}
```

`maxEvent` is the greatest event using the DO's exact comparator:

1. parsed milliseconds of `observed_at`;
2. `compareOpaqueEventIds`, which compares UTF-8 bytes.

Do not use the last row in archive JSONL because archive sorting also includes
`occurred_at` and therefore is not the DO comparator. The value is the same
event ID so the same maximal event delivered in two overlapping batches cannot
produce a same-tuple/different-value checkpoint conflict.

The reserved `r2_manifest_cursor` remains replay-only.

---

## Queue consumer policy

Configure one producer and one consumer Queue per environment plus a DLQ.

Exact resource map:

| Environment | Worker | D1 | R2 | Ingestion Queue | DLQ |
|---|---|---|---|---|---|
| local | `communicator-control-plane` | `communicator-control-directory-local` | `communicator-event-archive-local` | `communicator-ingestion-local` | `communicator-ingestion-dlq-local` |
| staging | `communicator-control-plane-staging` | `communicator-control-directory-staging` | `communicator-event-archive-staging` | `communicator-ingestion-staging` | `communicator-ingestion-dlq-staging` |
| production | `communicator-control-plane-production` | `communicator-control-directory-production` | `communicator-event-archive-production` | `communicator-ingestion-production` | `communicator-ingestion-dlq-production` |

Local may retain Wrangler's documented all-zero preview D1 ID. Staging and
production must use actual Cloudflare D1 IDs read or created by the primary
agent; a Luna worker must never invent them. All three use binding names
`CONTROL_DB`, `EVENT_ARCHIVE`, `TENANT_PROJECTION`, and `INGESTION_QUEUE`.
Committed OIDC issuer/JWKS placeholders remain nonfunctional until the later
deployment configuration, and the kill switch remains false.

Conservative pilot consumer settings:

```json
{
  "max_batch_size": 10,
  "max_batch_timeout": 5,
  "max_retries": 10,
  "retry_delay": 60,
  "max_concurrency": 5,
  "dead_letter_queue": "communicator-ingestion-dlq-<environment>"
}
```

These are project policy defaults, not claimed platform maxima. Keep names
environment-specific. Add `CONTROL_DB`, `EVENT_ARCHIVE`, `TENANT_PROJECTION`,
and `INGESTION_QUEUE` to every environment in which ingestion can run; never
accidentally share development, staging, and production Queues or R2 buckets.

Process delivered messages sequentially for the pilot. For every message:

1. parse `CommittedArchivePointerSchema`;
2. read the exact committed archive batch by `tenant_id` + `manifest_key`;
3. require exact pointer/manifest tenant, batch, key, and digest equality;
4. parse every event through `ProjectionEventEnvelopeSchema`;
5. require all event tenant IDs equal pointer tenant;
6. resolve exact archived bindings from D1;
7. require event identity/platform equal each binding;
8. get the tenant DO by exact tenant name;
9. call `initialize` with internal `projection.initialize` authorization;
10. call `applyBatch` with internal `projection.write` authorization and the
    derived live event watermark;
11. call `message.ack()` only after both RPCs succeed; and
12. continue with the next sibling message.

On any failure:

- classify it into a stable content-free code;
- call `message.retry({ delaySeconds })`;
- never acknowledge it;
- never throw solely to retry siblings already decided; and
- continue processing later siblings when runtime health allows.

Use a shorter 60-second delay for unavailable/rebuilding errors and a longer
300-second delay for invalid, corrupt, forbidden, or conflict errors. All
failures ultimately reach the configured DLQ after Cloudflare's retry budget.
Do not implement a content-bearing poison quarantine.

The DLQ is an operational queue, not an archive. The runbook must require an
operator to inspect/retry it within 12 hours. This is below the current
Cloudflare Free-plan 24-hour maximum; Paid defaults to four days and can be
configured up to 14 days. Task 4 records the actual account/Queue retention and
uses the maximum allowed value without claiming that local tests simulate time.
A committed R2 batch remains discoverable and rebuildable even if its pointer
ages out of the DLQ.

Rebuild does not require the expired Queue pointer. Manifest listing yields the
tenant archive; each event carries immutable `account_id`, `identity_id`, and
`platform`, and the non-deletable D1 account/connection mapping supplies the
original `connection_id`. The trusted rebuild orchestrator creates its own
internal replay authorization. Gateway route/service provenance is required to
accept live ingress, but it is not needed to reconstruct already-authoritative
message state from R2.

---

## Failure matrix

| Failure window | Required outcome |
|---|---|
| body too large or malformed | 4xx; no D1 mutation, R2 write, or Queue send |
| token invalid/wrong audience/revoked | generic denial; no R2 or Queue I/O |
| service principal or route inactive | generic not-found; no R2 or Queue I/O |
| one account unmapped or cross-route | whole request denied before R2 |
| projection-invalid event | whole request denied before R2 |
| caller batch ID mismatch | whole request denied before R2 |
| R2 data put fails | `503`; no manifest, no Queue send; exact retry safe |
| R2 data exists, crash before manifest | orphan remains invisible; retry verifies data and completes manifest |
| manifest commit succeeds, Queue send fails | `503`; R2 remains committed; exact retry returns `already_committed` then resends pointer |
| Queue send succeeds, HTTP response is lost | Gateway retries; duplicate pointer is safe |
| malformed/forged Queue pointer | no R2/DO mutation; retry then DLQ |
| committed R2 pair missing/corrupt | no overwrite and no DO mutation; retry then DLQ |
| D1 unavailable during consume | R2 remains authoritative; retry, no ACK |
| mapping was retired after HTTP acceptance | historical immutable binding resolves; projection may complete |
| mapping ownership differs from archive | no DO mutation; retry then DLQ/operator investigation |
| DO uninitialized | idempotent initialize then apply |
| DO rebuilding | R2 remains committed; retry until rebuild completes |
| DO transaction fails midway | transaction rolls back; no ACK; retry safe |
| DO commit succeeds, response/ACK is lost | duplicate apply is a no-op; later retry ACKs |
| duplicate exact ingress request | one immutable R2 pair; one or more safe pointers |
| duplicate exact Queue pointer | no duplicate projected rows or aggregates |
| batches delivered out of order | event hashes and LWW rules converge; source checkpoint unaffected |
| one sibling succeeds and one fails | successful message ACKed; failed message retried; no `ackAll` |
| retry budget exhausted | config declares DLQ and R2 remains replayable; actual transfer requires the later staging smoke gate |

Every row above except Cloudflare's passage of real time into a hosted DLQ
requires a deterministic automated test or precise local operator test in this
phase. Hosted retry exhaustion/transfer is explicitly deferred to the staging
deployment smoke gate and must not be claimed from emulator evidence.

---

## Privacy-safe observability

Structured logs may include only bounded operational metadata:

- phase (`auth`, `validation`, `archive`, `enqueue`, `archive_read`, `binding`,
  `projection`, `ack`, `retry`);
- outcome and stable public/internal error code;
- environment and Queue name;
- delivery attempt and chosen retry delay;
- duration, event count, and canonical byte count;
- tenant ID, batch ID, D1-derived service principal ID, and gateway route ID
  only through a consistent truncated SHA-256 fingerprint; and
- projection generation, applied count, duplicate count, and last sequence.

For every protected identifier fingerprint, compute lowercase hex
`SHA-256(UTF-8(kind + "\u0000" + value))` and log only the first 12 hex
characters with a field name ending in `_fingerprint`. The `kind` domain
separator prevents the same raw string used in two identifier classes from
sharing a fingerprint. Do not create a reversible map or log the full digest.

Never log:

- event bodies or payload objects;
- sender/participant labels;
- Matrix room/event IDs;
- remote message/account IDs;
- raw tenant/account/identity/connection/route/principal IDs;
- full R2 keys or manifests;
- source checkpoint values;
- timestamps from message events;
- JWTs, authorization headers, cookies, E2EE data, provider sessions;
- raw exception objects/messages/causes; or
- request/Queue bodies.

Tests must spy on every log call across denial, R2 failure, Queue failure, D1
failure, DO failure, conflict, and success, then recursively assert none of the
fixture secrets/content/identifiers appear.

---

## Exact file map

Expected new files:

```text
packages/contracts/src/ingestion.ts
packages/contracts/test/ingestion.test.ts
apps/control-plane/migrations/0002_ingestion_routing.sql
apps/control-plane/worker/auth/ingestion-middleware.ts
apps/control-plane/worker/control-directory/ingestion-repository.ts
apps/control-plane/worker/ingestion/errors.ts
apps/control-plane/worker/ingestion/fingerprint.ts
apps/control-plane/worker/ingestion/config.ts
apps/control-plane/worker/ingestion/prepare.ts
apps/control-plane/worker/ingestion/route.ts
apps/control-plane/worker/ingestion/consumer.ts
apps/control-plane/worker/test/ingestion/contract-boundary.test.ts
apps/control-plane/worker/test/ingestion/config.test.ts
apps/control-plane/worker/test/ingestion/auth.test.ts
apps/control-plane/worker/test/ingestion/directory.test.ts
apps/control-plane/worker/test/ingestion/route.test.ts
apps/control-plane/worker/test/ingestion/consumer.test.ts
apps/control-plane/worker/test/ingestion/end-to-end.test.ts
apps/control-plane/worker/test/ingestion/log-redaction.test.ts
apps/control-plane/worker/test/ingestion/support.ts
docs/runbooks/matrix-ingestion-local.md
deploy/cloudflare/ingestion-resources.json
README.md
```

Expected modified files:

```text
docs/PROPOSAL.md
docs/superpowers/specs/2026-08-27-communicator-cloudflare-data-plane-design.md
packages/contracts/src/index.ts
packages/test-fixtures/src/pilot-scenario.ts
packages/test-fixtures/test/pilot-scenario.test.ts
apps/control-plane/wrangler.jsonc
apps/control-plane/worker-configuration.d.ts
apps/control-plane/worker/app.ts
apps/control-plane/worker/index.ts
apps/control-plane/worker/auth/oidc.ts
apps/control-plane/worker/test/control-directory-schema.test.ts
apps/control-plane/worker/test/oidc.test.ts
apps/control-plane/worker/test/support/directory-fixtures.ts
```

The worker may choose a smaller module split only if responsibilities and test
boundaries remain equivalent. Do not put the entire phase into `app.ts` or
`index.ts`.

---

## Worker execution protocol for every task

Before Task 1, the primary agent runs:

```bash
pnpm install --frozen-lockfile
pnpm check
pnpm test
chmod 0755 scripts/init-telegram-runtime.sh
pnpm test:python
git status --short
```

This establishes a clean dependency and regression baseline in the dedicated
worktree. The local `chmod` normalizes the shared-filesystem checkout artifact
to the repository's existing exact `0755` security contract; it must not create
a Git diff or relax the test. A worker must not assume another worktree's
`node_modules` exists.

For each task below, the orchestrator must use this exact lifecycle:

1. Spawn one implementation worker with:
   - model `gpt-5.6-luna`;
   - reasoning effort `max`;
   - `fork_turns: none`;
   - worker role;
   - exact worktree path, task text, and plan path.
2. The worker reads the proposal, system specification, this whole plan, and
   all files named by its task before editing.
3. The worker uses test-driven development: add the focused failing test, run
   it to prove red, implement the narrow behavior, rerun to green, and run all
   affected regression suites.
4. The worker does not commit, push, deploy, edit live Cloudflare resources, or
   access the Contabo host.
5. Spawn a fresh independent Luna/max specification reviewer with no inherited
   turns. It checks the task diff against this plan and reports findings only.
6. Send every valid finding back to the same implementation worker for fixes.
7. Spawn a fresh independent Luna/max quality reviewer with no inherited
   turns. It checks correctness, security, maintainability, test strength, and
   regression risk.
8. Send every valid finding back to the same implementation worker for fixes.
9. The primary agent inspects the exact diff, reruns focused and affected
   suites, runs `git diff --check`, confirms no unrelated/user work changed,
   and commits the completed task.
10. Only then begin the next task.

No reviewer may approve based only on the worker summary. Reviewers must inspect
the current worktree and tests directly.

---

### Task 1: Amend the architecture and freeze ingestion contracts

**Files:**

- Create: `packages/contracts/src/ingestion.ts`
- Create: `packages/contracts/test/ingestion.test.ts`
- Modify: `packages/contracts/src/index.ts`
- Modify: `docs/PROPOSAL.md`
- Modify:
  `docs/superpowers/specs/2026-08-27-communicator-cloudflare-data-plane-design.md`

**Steps:**

1. Add failing contract tests for exact accepted request, response, pointer,
   error, and `IngestionCommittedArchiveManifestSchema` shapes described above.
2. Add hostile-input tests for accessors, proxies, inherited fields, symbol
   fields, sparse arrays, duplicate event IDs, unexpected properties,
   prototype-sensitive keys, cyclic payloads, excessive depth/nodes, and
   projection-invalid event payloads.
3. Add cross-field tests for mixed tenant, invalid batch grammar,
   tenant/batch mismatch embedded in `manifest_key`, wrong checkpoint kind,
   raw-looking checkpoint values, invalid digest, and empty/oversized input.
4. Reuse exported archive/projection schemas and constants. Do not duplicate
   their numeric limits or weaken their validation.
5. Implement the strict schemas and exports.
6. Amend the proposal/spec inbound diagram and prose from “Queue contains event
   batches and consumer writes R2” to the archive-first pointer protocol.
7. Record the 128 KB versus 4 MiB rationale, exact acknowledgement invariant,
   checkpoint separation, and later-Gateway outbox boundary.
8. Preserve Synapse as operational record, R2 as immutable archive, and DO as
   rebuildable projection.

**Focused verification:**

```bash
pnpm --filter @communicator/contracts test -- ingestion.test.ts
pnpm --filter @communicator/contracts check
git diff --check
```

**Commit:** `docs: freeze archive-first ingestion contract`

---

### Task 2: Add deterministic preparation and batch identity

**Files:**

- Create: `apps/control-plane/worker/ingestion/errors.ts`
- Create: `apps/control-plane/worker/ingestion/prepare.ts`
- Create:
  `apps/control-plane/worker/test/ingestion/contract-boundary.test.ts`

**Steps:**

1. Add failing tests that prepare an exact request into:
   - strictly sorted projection events;
   - exact canonical JSONL bytes/digest;
   - a recomputed deterministic batch ID;
   - an archive-writer input; and
   - a bounded Queue pointer constructor input.
2. Prove identical inputs produce byte-identical preparation across key order
   variation and repeated calls.
3. Prove any immutable field change changes the recomputed batch ID and a
   caller mismatch fails before external I/O.
4. Prove `archived_at` is never replaced by wall-clock time.
5. Prove 500 events/4 MiB exact boundaries and 501/over-limit rejection.
6. Prove the Queue pointer canonical JSON is at most 8 KiB.
7. Implement preparation by reusing `encodeCanonicalEventBatch`, the existing
   canonical JSON encoder, and `sha256Hex`.
8. Map failures to stable `IngestionError` codes with no raw cause exposure.
9. Deep-freeze returned prepared structures or copy them so caller mutation
   cannot change data between validation and R2 write.

**Focused verification:**

```bash
pnpm --filter @communicator/control-plane test:worker -- contract-boundary.test.ts
pnpm --filter @communicator/control-plane check
git diff --check
```

**Commit:** `feat: prepare deterministic ingestion batches`

---

### Task 3: Add immutable D1 ingestion routing

**Files:**

- Create: `apps/control-plane/migrations/0002_ingestion_routing.sql`
- Create:
  `apps/control-plane/worker/control-directory/ingestion-repository.ts`
- Create: `apps/control-plane/worker/test/ingestion/directory.test.ts`
- Modify: `apps/control-plane/worker/test/control-directory-schema.test.ts`
- Modify: `apps/control-plane/worker/test/support/directory-fixtures.ts`
- Modify: `packages/test-fixtures/src/pilot-scenario.ts`
- Modify: `packages/test-fixtures/test/pilot-scenario.test.ts`

**Steps:**

1. Add red schema tests for the new tables, indexes, check constraints,
   foreign keys, and immutability triggers.
2. Apply `0001` then `0002` in tests; prove a fresh database and a migrated
   existing fixture both work.
3. Treat pre-`0002` `connection_routes` rows as unregistered legacy data: the
   migration must not invent a service owner or account ID. Active ingestion
   denies them until an operator changes any noncanonical route ID, inserts the
   matching `gateway_routes` row, and then inserts `connection_accounts`.
   Update current test fixtures from `gateway-human`/`gateway-agent` to valid
   `gateway_route_human`/`gateway_route_agent` IDs. Update schema-test table
   assertions and reverse-FK cleanup order for both new tables.
4. Seed separate Human/Agent identities and at least WhatsApp, Telegram, and
   Messenger account bindings across two tenants and two service routes.
5. Test active service/route/account success.
6. Test human/agent/operator principal rejection, missing `jti`, token
   revocation, disabled/revoked principal, wrong route owner, inactive route,
   inactive tenant/identity/account, revoked/unlinked connection, cross-tenant
   IDs, platform mismatch, identity mismatch, missing account, extra row, and
   D1 exception. Separately prove `attention_required` and `disconnected`
   connections may drain already-spooled events.
7. Prove active ingress resolution rejects retired mappings while archived
   consumer resolution accepts them without allowing reassignment.
8. Revoke a service principal, attempt to change its status back to `active`
   and to erase or replace its first non-null `revoked_at`, and prove every
   attempt aborts. Insert a `revoked_tokens` row, attempt both `UPDATE` and
   `DELETE`, and prove both abort. After each attempted reversal, replay the
   same otherwise-valid JWT and prove active ingestion remains denied before
   R2 or Queue I/O. Credential rotation tests must use a new principal/JTI.
9. Attempt every forbidden ownership/lifecycle update and delete after account
   registration, then prove the originally accepted archive still resolves to
   the original route, tenant, service subject/type, identity, provider,
   account, and connection for consumer replay.
10. Prove all output is sorted uniquely and exactly covers requested accounts.
11. Implement bounded SQL and generic typed outcomes. Do not interpolate IDs or
   construct unbounded `IN` clauses.
12. Use `withSession("first-primary")` and prove a revocation/disablement made
    immediately before a lookup is observed.
13. Do not add message content, Matrix tokens, bridge secrets, or provider
    credentials to D1.

**Focused verification:**

```bash
pnpm --filter @communicator/control-plane test:worker -- control-directory-schema.test.ts directory.test.ts
pnpm --filter @communicator/test-fixtures test
pnpm --filter @communicator/control-plane check
git diff --check
```

**Commit:** `feat: authorize immutable ingestion routes`

---

### Task 4: Configure Queues, DLQ, and environment bindings

**Files:**

- Modify: `apps/control-plane/wrangler.jsonc`
- Regenerate: `apps/control-plane/worker-configuration.d.ts`
- Create: `deploy/cloudflare/ingestion-resources.json`
- Create: `apps/control-plane/worker/test/ingestion/config.test.ts`

**Steps:**

1. Before code changes, the primary agent—not the Luna worker—uses the connected
   Cloudflare API read-only to enumerate existing D1, Queue, and R2 resources in
   the intended 0000 account. Reuse exact-name resources only. If required
   staging/production D1, Queue, or R2 resources are absent, create only the
   reviewed empty resources, set the account-supported message retention to its
   maximum, record their IDs/names/retention, and do not deploy a Worker, apply
   a migration, or send a message. Never guess or commit sentinel deployment
   IDs.
   Record the nonsecret handoff before spawning the implementation worker in
   `deploy/cloudflare/ingestion-resources.json` with this exact shape:

   ```json
   {
     "schema_version": 1,
     "cloudflare_account_id": "<actual account ID>",
     "verified_at": "<RFC 3339 timestamp>",
     "environments": {
       "staging": {
         "d1": { "name": "communicator-control-directory-staging", "id": "<actual UUID>" },
         "r2": { "name": "communicator-event-archive-staging" },
         "queue": { "name": "communicator-ingestion-staging", "id": "<actual ID>", "retention_seconds": 86400 },
         "dlq": { "name": "communicator-ingestion-dlq-staging", "id": "<actual ID>", "retention_seconds": 86400 }
       },
       "production": {
         "d1": { "name": "communicator-control-directory-production", "id": "<actual UUID>" },
         "r2": { "name": "communicator-event-archive-production" },
         "queue": { "name": "communicator-ingestion-production", "id": "<actual ID>", "retention_seconds": 86400 },
         "dlq": { "name": "communicator-ingestion-dlq-production", "id": "<actual ID>", "retention_seconds": 86400 }
       }
     }
   }
   ```

   The shown `86400` values illustrate the Free-plan minimum handoff shape;
   write the actual API-reported values. If the primary agent cannot produce
   this complete file, stop Task 4. The worker must consume the file and never
   invent or infer an ID.
2. Add `INGESTION_QUEUE` producer and ingestion consumer declarations for local,
   staging, and production using the exact resource map in this plan.
3. Configure the explicit distinct DLQ, `max_batch_size: 10`,
   `max_batch_timeout: 5`, `max_retries: 10`, `retry_delay: 60`, and
   `max_concurrency: 5` in each environment.
4. Add `COMMUNICATOR_INGRESS_ENABLED: "false"` and the ingestion OIDC vars to
   all environments. Prove its audience differs from the public API audience.
5. Ensure `CONTROL_DB`, `EVENT_ARCHIVE`, and `TENANT_PROJECTION` bindings are
   explicit in every deployable environment because Wrangler environment
   binding sections are non-inheritable. Only local may use the documented
   all-zero preview D1 ID.
6. Add `/internal/*` to the asset `run_worker_first` rules so authenticated
   ingress can never fall through to the SPA.
7. Never place a secret in Wrangler vars. Issuer, audience, resource names, and
   nonsecret database IDs are allowed; tokens/private keys are not.
8. Run `pnpm --filter @communicator/control-plane types:worker`, inspect the
   generated diff, and commit the generated type file. Do not use
   `git diff --exit-code` until after the generated change has been committed.
9. Add config-contract assertions for exact names, DLQ, retries, retention
   record, bindings, kill switch, Worker-first paths, no shared production
   resources, and no zero/sentinel staging or production IDs.
10. Do not deploy the Worker, apply remote D1 migrations, create a Queue
    consumer deployment, or enable live traffic in this task.

**Focused verification:**

```bash
pnpm --filter @communicator/control-plane types:worker
pnpm --filter @communicator/control-plane test:worker
pnpm --filter @communicator/control-plane check
git diff --check
```

**Commit:** `chore: configure ingestion queues and bindings`

---

### Task 5: Add dedicated ingestion machine authentication

**Files:**

- Create: `apps/control-plane/worker/auth/ingestion-middleware.ts`
- Create: `apps/control-plane/worker/ingestion/config.ts`
- Create: `apps/control-plane/worker/test/ingestion/auth.test.ts`
- Modify: `apps/control-plane/worker/auth/oidc.ts`
- Modify: `apps/control-plane/worker/test/oidc.test.ts`
- Modify: `apps/control-plane/worker/app.ts`

**Steps:**

1. Add red tests for missing/malformed bearer, invalid signature, wrong issuer,
   product API audience, unsupported algorithm, missing/non-integer `iat`,
   missing/non-integer `exp`, `exp <= iat`, a lifetime over 300 seconds, an
   `iat` more than 30 seconds in the future, expired token beyond 30 seconds,
   invalid optional `nbf`, missing subject, missing `jti`, revoked token,
   non-service principal, inactive principal, D1 unavailable, and JWKS failure.
   Boundary tests must prove exactly 300 seconds is accepted, 301 is denied,
   and the 30-second tolerance is used only for clock comparison—not added to
   the permitted signed lifetime.
2. Prove a product user/owner JWT cannot access the ingestion boundary even
   when it has tenant membership.
3. Prove `X-Communicator-Tenant` is ignored and cannot select authority.
4. Add a separate lazily cached verifier created from the ingestion OIDC env
   values, never the public API audience.
5. Add a narrow Hono variable containing only service principal metadata.
6. Ensure every denial response and log is fixed/content-free.
7. Add typed OIDC verification failures with only `invalid` and `unavailable`
   classifications. Map JOSE claim/signature/issuer/audience/algorithm failures
   after a usable key set resolves to invalid. Map every failure while fetching,
   rate-limiting, receiving a non-2xx response, parsing, validating, caching, or
   configuring the remote JWKS—including network errors, timeouts, HTTP 429/5xx,
   malformed JSON, and a key set with no usable keys—to unavailable. An unknown
   JWT `kid` against an otherwise successfully loaded usable key set is invalid.
   Preserve the original exception only as an unexposed internal cause.
8. The ingestion middleware maps invalid to 401 and unavailable to 503. Existing
   public session behavior may remain its current generic denial contract.
9. Keep dependency injection hooks so tests never access a network JWKS, and
   add explicit injected invalid-versus-unavailable tests for every class above.
10. Keep temporal enforcement ingestion-specific: extend the verifier with
    explicit options or validate the verified payload in the ingestion
    middleware. Do not silently tighten the existing product-session token
    contract. After trying to reverse a principal or JTI revocation, prove a
    missing-`exp` token and an over-300-second token using the same credential
    remain denied before D1 authorization, R2, Queue, or DO work.
11. Add `isIngressEnabled(value: unknown): boolean` in the ingestion config
    module so generated literal Wrangler types are widened safely; do not
    compare a generated literal `"false"` directly with `"true"`.
12. Prove both runtime flag values. The disabled route performs no verifier,
    D1, body, R2, Queue, or DO work and exposes no configuration detail.

**Focused verification:**

```bash
pnpm --filter @communicator/control-plane test:worker -- auth.test.ts oidc.test.ts authorization.test.ts session.test.ts
pnpm --filter @communicator/control-plane check
git diff --check
```

**Commit:** `feat: authenticate ingestion service principals`

---

### Task 6: Implement archive-first authenticated ingress

**Files:**

- Create: `apps/control-plane/worker/ingestion/route.ts`
- Create: `apps/control-plane/worker/test/ingestion/route.test.ts`
- Modify: `apps/control-plane/worker/app.ts`

**Steps:**

1. Add a bounded request-body reader using the exact 32 MiB transport ceiling.
   Reject a declared or observed body above it and stop/cancel the stream on
   overflow. Require `Content-Type: application/json` with an optional UTF-8
   charset and reject non-identity content encodings. Canonical archive limits
   remain the stricter semantic gate. Test exact bytes, chunked overflow,
   cancellation, legal escaped-Unicode/control-heavy input, and bloated input
   above the ceiling.
2. Add `POST /internal/v1/ingestion/batches`; do not include it in the public
   product OpenAPI document.
3. Parse/authenticate/prepare before any R2 or Queue operation.
4. Resolve the active route and exact bindings from D1, then validate every
   event tenant/account/identity/platform against the trusted rows.
5. Call `archiveCanonicalEventBatch` with the stable request metadata.
6. Construct and schema-parse the pointer from the verified returned manifest,
   not from unchecked caller strings.
7. Parse the returned manifest through the ingestion-specific manifest
   validator, proving no null/generic/raw checkpoint can reach Queue through
   this route.
8. Await `env.INGESTION_QUEUE.send(pointer, { contentType: "json" })`.
9. Return `202` only after the send promise fulfills.
10. Map archive conflict to 409 and transient R2/Queue/D1 errors to 503.
11. Add failure injection tests at every archive writer stage and before/during
    Queue send. Assert Queue is never called before a verified manifest.
12. Test exact retry after R2 commit + Queue failure, and duplicate pointer
    generation after simulated lost response.
13. Assert no route can write for a second tenant/identity/account.
14. Ensure deployed asset routing sends `/internal/*` to the Worker rather than
    the SPA asset fallback; add a configuration-contract test for this.
15. Extend `AppServices` with a narrow injected Queue sender seam used only by
    route unit tests. Production defaults to `env.INGESTION_QUEUE.send`; tests
    capture the exact pointer or inject a rejected send promise without mocking
    the rest of the route.

**Focused verification:**

```bash
pnpm --filter @communicator/control-plane test:worker -- route.test.ts writer.test.ts
pnpm --filter @communicator/control-plane check
git diff --check
```

**Commit:** `feat: accept archive-first ingestion batches`

---

### Task 7: Implement the committed-archive Queue consumer

**Files:**

- Create: `apps/control-plane/worker/ingestion/consumer.ts`
- Create: `apps/control-plane/worker/test/ingestion/consumer.test.ts`
- Modify: `apps/control-plane/worker/index.ts`

**Steps:**

1. Add red tests with Cloudflare Queue test helpers for one valid pointer.
2. Read via `readCommittedArchiveBatch`; do not list R2 and do not trust an R2
   key until strict pointer parsing and tenant-key validation succeed.
3. Verify exact manifest key, tenant, batch, and canonical digest equality.
4. Parse the manifest through the ingestion-specific validator; a null,
   generic, or raw-looking source checkpoint is corrupt for this consumer and
   must never reach the DO.
5. Re-parse every archived event as a projection event before DO access.
6. Resolve the historical route from D1, take its immutable service principal
   as the only principal authority, then resolve exact historical bindings and
   validate ownership. No Queue field may supply or override the principal.
7. Build an internal authorization context using that D1-derived service principal,
   pointer tenant, sorted exact event identity IDs, and only the required
   `projection.initialize`/`projection.write` scopes for each RPC.
8. Initialize the tenant DO idempotently using a deterministic timestamp from
   the archive (never the consumer clock when retry identity matters).
9. Compute the `live_event_watermark` using the DO comparator and call
   `applyBatch` once for the complete archive batch.
10. Explicitly ACK only after successful apply.
11. Explicitly retry on invalid pointer, R2 missing/corrupt/unavailable, D1
    mismatch/unavailable, DO unavailable/rebuilding/conflict, and unexpected
    error.
12. Continue across sibling messages and prove success/failure independence.
13. Export a module-worker default object with both `fetch` and `queue`
    handlers while continuing to export `TenantProjectionDO`.
14. Consumer tests must construct deliveries with `createMessageBatch` and
    inspect exact per-message outcomes with `getQueueResult`; do not substitute
    home-grown ACK booleans for Cloudflare's Queue test contract.

**Focused verification:**

```bash
pnpm --filter @communicator/control-plane test:worker -- consumer.test.ts reader.test.ts apply-batch.test.ts
pnpm --filter @communicator/control-plane check
git diff --check
```

**Commit:** `feat: project committed archive queue messages`

---

### Task 8: Prove the complete consistency and failure matrix

**Files:**

- Create: `apps/control-plane/worker/test/ingestion/end-to-end.test.ts`
- Create: `apps/control-plane/worker/test/ingestion/log-redaction.test.ts`
- Create/modify: `apps/control-plane/worker/test/ingestion/support.ts`

**Steps:**

1. Build requests through the real Hono app, real R2 binding, real D1 fixture,
   and real tenant DO. Inject a capturing Queue producer only where the local
   runtime cannot automatically deliver a producer send; feed the captured
   exact body through Cloudflare's real `createMessageBatch` Queue test helper.
   Mock only the external OIDC/JWKS verification boundary.
2. Prove HTTP request -> R2 manifest/data -> Queue pointer -> DO query for:
   - Human WhatsApp inbound message;
   - Agent WhatsApp inbound message;
   - Telegram event through another connection;
   - two tenants with identical remote-looking values; and
   - a multi-event batch containing supported event families.
3. Query DO state through its real RPCs and prove tenant and Human/Agent
   isolation, conversation/message state, counters, changes, and watermark.
4. Add each failure-matrix row from this plan with exact durable-state
   assertions—not only status-code assertions.
5. Prove duplicate ingress before/after response loss, duplicate Queue pointer,
   duplicate event across overlapping batches, reordered batches, and mixed
   Queue sibling outcomes.
6. Prove no one-R2-object-per-message behavior: a multi-event request creates
   exactly one data object and one manifest.
7. Prove R2 exists when DO fails and replay can rebuild a fresh projection.
8. Prove no raw source checkpoint, Matrix token, JWT, message body, or protected
   identifier appears in Queue bodies other than the allowed pointer fields.
9. Spy on logs and recursively scan for every canary secret/content value.
10. Prove a permanent poison pointer is retried and never ACKed. Config-contract
    tests prove an explicit retry budget and DLQ are declared; they do **not**
    claim to simulate Cloudflare's eventual timed handoff.
11. Record a required later staging smoke test that sends a non-sensitive test
    pointer, observes retries and DLQ transfer, then deletes/reconciles only the
    test artifact. That staging evidence is a deployment gate, not a pre-merge
    unit-test claim for this code-only milestone.

**Focused verification:**

```bash
pnpm --filter @communicator/control-plane test:worker -- end-to-end.test.ts log-redaction.test.ts
pnpm --filter @communicator/control-plane test:worker
pnpm --filter @communicator/control-plane check
git diff --check
```

**Commit:** `test: prove ingestion consistency boundaries`

---

### Task 9: Write the local operations and future Gateway runbook

**Files:**

- Create: `docs/runbooks/matrix-ingestion-local.md`
- Create: `README.md`
- Modify: existing R2 and projection runbooks only where their “future Queue”
  exclusions are now stale.

**Steps:**

1. Explain the archive-first pointer protocol simply, then technically.
2. Document local prerequisites, migrations, Queue names, bindings, tests, and
   exact local dev commands.
3. Document safe fixture seeding for service principal, route, connection, and
   account mapping without credentials.
4. Document a deterministic local submission and Queue-consume exercise using
   fake content only.
5. Document error codes and what an operator checks without exposing content.
6. Document DLQ inspection/retry rules, current retention/SLA, and the rule that
   operators never skip or delete a failed pointer until its R2/DO state is
   reconciled.
7. Document full R2 rebuild as the repair path after a projection divergence.
8. Document the later Matrix Gateway E2EE/outbox/checkpoint contract verbatim
   enough that a Luna worker can implement it without redesigning this phase.
9. State clearly that production deployment and live Matrix credentials are
   outside this phase.
10. Verify every command against the current repository; do not document
    aspirational files or scripts as existing.
11. Keep the new root README concise: project purpose, architecture entry
    points, local prerequisite/install/check/test commands, runbook links,
    simulated-versus-live safety boundary, and the statement that no live
    provider action occurs from local tests.

**Focused verification:**

```bash
pnpm check
pnpm test
chmod 0755 scripts/init-telegram-runtime.sh
pnpm test:python
git diff --check
```

**Commit:** `docs: add matrix ingestion operations contract`

---

### Task 10: Fresh independent phase verification

This task is testing only. Use a fresh Luna/max worker with `fork_turns: none`
that did not implement Tasks 1–9.

**Required actions:**

1. Read the proposal, system specification, whole plan, entire phase diff, and
   all new/modified runbooks.
2. Create a requirement-to-evidence matrix covering every locked decision,
   contract field, D1 rule, failure row, privacy rule, test, and deliverable.
3. Run the complete test suite from a fresh dependency install or verified
   lockfile state.
4. Regenerate Worker types and prove no drift.
5. Add adversarial tests for any uncovered case, including hostile JS inputs,
   body-stream overflow, same-ID/different-body retries, cross-tenant bindings,
   retired mappings, Queue duplicates/reordering, archive corruption, DO
   rebuilding, and log leakage.
6. Confirm no source/token/key/session fixture resembles a live credential.
7. Confirm no VPS, provider account, production data, or deployed Worker was
   mutated. If Task 4 created reviewed empty Cloudflare resources, confirm their
   exact names/IDs and that they contain no data or active consumer deployment.
8. Report PASS only when every requirement has direct evidence. Otherwise list
   findings with severity, file/line, reproduction, and required fix.

The primary agent sends valid findings to the responsible implementation
worker, reruns this independent verification after fixes, and records exact
test counts.

**Required commands:**

```bash
pnpm install --frozen-lockfile
pnpm check
pnpm test
chmod 0755 scripts/init-telegram-runtime.sh
pnpm test:python
pnpm --filter @communicator/control-plane types:worker
git diff --exit-code -- apps/control-plane/worker-configuration.d.ts
git diff --check
git status --short
```

No commit unless tests were added/fixed. If the verifier adds tests, use:

**Commit:** `test: harden matrix ingestion phase`

---

### Task 11: Primary-agent review, PR, merge, and main verification

The primary agent—not an implementation worker—must:

1. Inspect every commit and the complete diff from the recorded base commit.
2. Confirm all Task 10 findings are resolved and reviewers rechecked fixes.
3. Re-run the full commands below and capture exact results.
4. Push `codex/matrix-queue-ingestion` and open a private-repository pull
   request with architecture, security, failure semantics, tests, and excluded
   scope summarized.
5. Wait for GitHub checks and inspect failures rather than assuming local tests
   cover them.
6. Merge only when checks pass and the branch is current with `origin/main`.
7. Fast-forward the local main worktree, reinstall from the lockfile if needed,
   and run the merged-result verification on main.
8. Confirm local main equals `origin/main`, the PR is `MERGED`, and no source or
   lockfile drift was created by verification.

**Required pre-PR and post-merge commands:**

```bash
pnpm install --frozen-lockfile
pnpm check
pnpm test
chmod 0755 scripts/init-telegram-runtime.sh
pnpm test:python
pnpm --filter @communicator/control-plane types:worker
git diff --exit-code -- apps/control-plane/worker-configuration.d.ts
git diff --check
git status --short
```

Do not call the overall Communicator goal complete after this merge. This PR
completes milestone 8, not the whole product.

---

## Phase acceptance checklist

### Architecture and durability

- [ ] The proposal and system spec document archive-first Queue pointers.
- [ ] An HTTP `202` proves verified R2 commitment and successful Queue send.
- [ ] A Queue ACK proves verified R2 plus committed tenant DO transaction.
- [ ] No event body is constrained by the 128 KB Queue limit.
- [ ] No DO state exists without replayable R2 evidence through this path.
- [ ] Exact retries at every crash window are safe.
- [ ] No third cross-store ingestion ledger was added.

### Contracts and identity

- [ ] All ingress/pointer/response/error contracts are strict and hostile-input
      safe.
- [ ] Batch IDs are deterministically recomputed from immutable content.
- [ ] Source checkpoint values are one-way hashes only.
- [ ] Both ingress and consumer reject a generic/null/raw-looking archive source
      checkpoint through the ingestion-specific manifest validator.
- [ ] Source checkpoints and projection watermarks are distinct.
- [ ] Queue pointers are canonically at most 8 KiB.
- [ ] All accepted events are projection-valid before R2 write.

### Authentication and authorization

- [ ] Ingestion has a distinct OIDC audience and middleware.
- [ ] Only active service principals with non-revoked `jti` tokens can submit.
- [ ] Every ingestion JWT has required integer `iat`/`exp`, at most a five-minute
      signed lifetime, and only 30 seconds of clock tolerance; permanent or
      overlong service tokens cannot authenticate.
- [ ] An active gateway route must belong to the authenticated service.
- [ ] D1 proves tenant/account/connection/identity/platform for every event.
- [ ] Product users and caller-provided tenant hints cannot authorize ingress.
- [ ] Cross-tenant and cross-identity attempts fail before R2 or Queue writes.
- [ ] Authorization/route/binding reads use a primary-consistent D1 session and
      observe immediately preceding revocations.

### Directory and lifecycle

- [ ] Forward-only migration adds gateway route and account ownership records.
- [ ] Account/connection and route/principal ownership cannot be reassigned.
- [ ] Principal revocation is terminal, revoked issuer/JTI rows are append-only,
      and attempted reversal cannot make the same JWT usable again.
- [ ] Registered account, route, connection ownership, and route rows cannot be
      deleted out from under an accepted archive.
- [ ] Active ingress rejects inactive ownership records.
- [ ] Consumer replay of an already accepted archive can resolve retired
      historical mappings.
- [ ] No message body or credential is stored in D1.

### Queue and projection

- [ ] Local/staging/production resources have distinct explicit bindings.
- [ ] Every consumer has an explicit DLQ and retry budget.
- [ ] The committed ingress kill switch is false and blocks new HTTP acceptance
      until a later deployment explicitly enables it; the consumer can still
      drain previously accepted pointers.
- [ ] Per-message ACK/retry decisions preserve successful siblings.
- [ ] Invalid/corrupt/conflicting messages are never acknowledged.
- [ ] Duplicate and reordered delivery converges without duplicate state.
- [ ] DO initialization and apply are idempotent.
- [ ] Live event watermark uses the DO's exact comparator.
- [ ] Rebuilding/unavailable DOs retry without endangering R2 evidence.

### Privacy and operations

- [ ] Queue bodies contain only the approved pointer fields.
- [ ] Logs contain only fingerprinted metadata and stable codes.
- [ ] Canary tests prove no content, protected identifier, token, or checkpoint
      leaks.
- [ ] Runbook covers local setup, DLQ, reconciliation, rebuild, and later
      Gateway outbox/checkpoint behavior.
- [ ] Local tests describe their DLQ limitation; actual timed DLQ transfer is a
      required later staging deployment smoke gate.
- [ ] No production deployment or live credential handling occurred.

### Verification and integration

- [ ] Focused task suites pass.
- [ ] Full TypeScript checks and tests pass.
- [ ] Full Python tests pass.
- [ ] Generated Worker types have no drift.
- [ ] `git diff --check` passes.
- [ ] Fresh independent verifier reports PASS.
- [ ] PR checks pass.
- [ ] PR is merged.
- [ ] Local main equals `origin/main`.
- [ ] Post-merge main verification passes.

---

## Next phase after merge

After this milestone is merged, choose the next work from the approved delivery
sequence based on current dependencies:

1. build the versioned live read API over `TenantProjectionDO` so the
   back-office UI can replace simulated conversation data;
2. add hibernatable WebSocket tickets and change subscriptions; then
3. implement the Contabo Matrix Gateway using the frozen authenticated ingress
   contract, verified E2EE devices, deterministic normalization, and protected
   local SQLite outbox.

Bridge-specific normalization can then be validated against live WhatsApp,
Telegram, Messenger, and LinkedIn rooms without changing the archive, Queue, or
projection consistency protocol.
