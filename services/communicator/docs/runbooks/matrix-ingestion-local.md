# Matrix ingestion local runbook

This runbook is for a local developer or operator exercising the authenticated
ingestion Worker and Queue consumer. It uses only synthetic data. Production
deployment, live Matrix credentials, and live provider traffic are outside
this phase.

## The short version

The future Matrix Gateway sends one tenant's normalized events to the private
Worker endpoint. The Worker verifies the gateway route and account mappings,
writes the batch to R2, and then sends a small pointer to the Queue. The Queue
consumer reads the exact R2 pair and applies the events to that tenant's
Durable Object. It acknowledges a message only after the projection commits.

Synapse remains the operational messaging record. R2 is the immutable replay
archive. The tenant Durable Object SQLite database is a rebuildable projection.
If the same request or pointer is delivered again, the batch and projection
remain idempotent.

The local end-to-end test captures the Queue send in memory and delivers that
captured pointer through the real Worker Queue handler. It does not contact
Matrix, Synapse, or any other live provider.

## Local prerequisites

Run these checks from the repository root. Wrangler is used through the
checked-in control-plane dependency, so a global Wrangler install is not
required.

```sh
node --version
pnpm --version
WRANGLER_LOG_PATH=/tmp/communicator-matrix-ingestion-wrangler.log pnpm --filter @communicator/control-plane exec wrangler --version
```

Use Node `>=24 <27` and pnpm `10.14.0`, as pinned by `package.json` and
`.nvmrc`. Install the lockfile state before running a test or local migration:

```sh
pnpm install --frozen-lockfile
```

The focused Worker ingestion exercise uses the Cloudflare-compatible local test
runtime and does not require Docker. Full repository verification does require
Docker Engine and Docker Compose v2: `pnpm test:python` includes bridge
contract tests that invoke `docker compose config`. Do not set Matrix access
tokens, device keys, session keys, bridge secrets, or provider credentials.

## Bindings and resource names

The exact bindings are declared in
`apps/control-plane/wrangler.jsonc`:

| Binding | Resource or class | Local value |
| --- | --- | --- |
| `CONTROL_DB` | D1 database | `communicator-control-directory-local` |
| `EVENT_ARCHIVE` | R2 bucket | `communicator-event-archive-local` |
| `TENANT_PROJECTION` | SQLite Durable Object namespace | `TenantProjectionDO` |
| `INGESTION_QUEUE` | Queue producer | `communicator-ingestion-local` |
| Queue consumer DLQ | Dead-letter Queue | `communicator-ingestion-dlq-local` |

The local Worker name is `communicator-control-plane`. The base D1
configuration uses the local sentinel database ID
`00000000-0000-0000-0000-000000000001` and preview binding `CONTROL_DB`.

Staging and production are separate resources. Their checked-in names are:

| Environment | Worker | D1 | R2 | Queue | DLQ |
| --- | --- | --- | --- | --- | --- |
| staging | `communicator-control-plane-staging` | `communicator-control-directory-staging` | `communicator-event-archive-staging` | `communicator-ingestion-staging` | `communicator-ingestion-dlq-staging` |
| production | `communicator-control-plane-production` | `communicator-control-directory-production` | `communicator-event-archive-production` | `communicator-ingestion-production` | `communicator-ingestion-dlq-production` |

Every environment uses the bindings `CONTROL_DB`, `EVENT_ARCHIVE`,
`TENANT_PROJECTION`, and `INGESTION_QUEUE`. The configured consumer policy is
`max_batch_size: 10`, `max_batch_timeout: 5`, `max_retries: 10`,
`retry_delay: 60`, `max_concurrency: 5`, with the environment-specific DLQ.

The staging and production resource handoff records Queue and DLQ retention as
`1,209,600` seconds, or 14 days, in
`deploy/cloudflare/ingestion-resources.json`. Operators must inspect a DLQ
message within 12 hours. Local tests do not simulate hosted retention or timed
DLQ transfer.

The configuration keeps `COMMUNICATOR_INGRESS_ENABLED` false in every checked-
in environment. The tests override that flag only inside an in-memory app and
inject a fake verifier. They do not create a working live ingress credential.

## Apply the local D1 migrations

Wrangler reads `apps/control-plane/migrations` from the checked-in Worker
configuration and applies every pending SQL file in numeric filename order.
The command below applies the full directory, including the earlier
control-directory and ingestion migrations and the current authority and
lifecycle migrations.

```sh
WRANGLER_LOG_PATH=/tmp/communicator-matrix-ingestion-wrangler.log pnpm --filter @communicator/control-plane exec wrangler d1 migrations apply CONTROL_DB --local
```

Never add `--remote` to this command. The local projection schema is created by
the `TenantProjectionDO` test runtime, not by a D1 migration.

## Seed a credential-free local directory

The ingestion route needs a tenant, an active service principal, an active
gateway route owned by that principal, an identity, a connection, a route
binding, and an account mapping. The following SQL uses synthetic values and
stores no credential or message content. Run it once against a fresh local
database after applying the migrations. The ingestion migration makes route
and account history append-only, so a reused ID is rejected rather than
silently replacing an existing mapping. Inspect any pre-existing rows and use
a new synthetic suffix for another local fixture.

```sh
WRANGLER_LOG_PATH=/tmp/communicator-matrix-ingestion-wrangler.log pnpm --filter @communicator/control-plane exec wrangler d1 execute CONTROL_DB --local --command "
INSERT INTO tenants (id, slug, display_name, status, created_at, updated_at)
VALUES ('tenant_task9_seed', 'task9_seed', 'Task 9 local tenant', 'active', '2026-09-08T00:00:00.000Z', '2026-09-08T00:00:00.000Z');
INSERT INTO principals (id, issuer, subject, principal_type, display_name, status, created_at, updated_at)
VALUES ('principal_task9_seed_service', 'https://ingestion-local.invalid/', 'service-task9-seed', 'service', 'Task 9 local service', 'active', '2026-09-08T00:00:00.000Z', '2026-09-08T00:00:00.000Z');
INSERT INTO identities (id, tenant_id, identity_kind, display_name, status, created_at, updated_at)
VALUES ('identity_task9_seed', 'tenant_task9_seed', 'human', 'Task 9 local identity', 'active', '2026-09-08T00:00:00.000Z', '2026-09-08T00:00:00.000Z');
INSERT INTO connections (id, tenant_id, identity_id, provider, display_label, status, created_at, updated_at)
VALUES ('connection_task9_seed', 'tenant_task9_seed', 'identity_task9_seed', 'whatsapp', 'Task 9 local connection', 'ready', '2026-09-08T00:00:00.000Z', '2026-09-08T00:00:00.000Z');
INSERT INTO gateway_routes (id, service_principal_id, status, created_at, updated_at, revoked_at)
VALUES ('gateway_route_task9_seed', 'principal_task9_seed_service', 'active', '2026-09-08T00:00:00.000Z', '2026-09-08T00:00:00.000Z', NULL);
INSERT INTO connection_routes (connection_id, gateway_route_id, bridge_instance_id, matrix_user_id, matrix_room_namespace, created_at, updated_at)
VALUES ('connection_task9_seed', 'gateway_route_task9_seed', 'bridge_task9_seed', '@task9seed:example.invalid', '!task9seed:example.invalid', '2026-09-08T00:00:00.000Z', '2026-09-08T00:00:00.000Z');
INSERT INTO connection_accounts (account_id, connection_id, status, created_at, updated_at, retired_at)
VALUES ('account_task9_seed', 'connection_task9_seed', 'active', '2026-09-08T00:00:00.000Z', '2026-09-08T00:00:00.000Z', NULL);
"
```

Verify only the mapping metadata. Do not select payloads, tokens, or any
message data:

```sh
WRANGLER_LOG_PATH=/tmp/communicator-matrix-ingestion-wrangler.log pnpm --filter @communicator/control-plane exec wrangler d1 execute CONTROL_DB --local --command "SELECT ca.account_id, ca.connection_id, c.tenant_id, c.identity_id, c.provider, cr.gateway_route_id FROM connection_accounts AS ca JOIN connections AS c ON c.id = ca.connection_id JOIN connection_routes AS cr ON cr.connection_id = c.id WHERE ca.account_id = 'account_task9_seed';"
```

The deterministic Worker tests use `seedIngestionFixture` in
`apps/control-plane/worker/test/ingestion/support.ts` instead of this manual
SQL. That helper clears and seeds the real D1 test binding for each test, with
fake route, connection, identity, and account values. No signed JWT is needed
for the captured test because it injects a credential-free verifier.

## Run the captured submission and consume exercise

Do not use `curl` or a live JWT for this exercise. Run the existing test that
performs the complete local path:

```sh
WRANGLER_LOG_PATH=/tmp/communicator-matrix-ingestion-wrangler.log pnpm --filter @communicator/control-plane exec vitest run --config vitest.worker.config.ts worker/test/ingestion/end-to-end.test.ts -t "archives Human WhatsApp ingress, queues a pointer, and projects it into the real tenant DO"
```

The test calls these existing helpers in `support.ts`:

1. `seedIngestionFixture` inserts the fake D1 service principal, route,
   connection, and account mapping.
2. `requestForEvents` creates one deterministic projection-valid event and
   recomputes its stable `batch_id`.
3. `postIngestionBatch` invokes
   `POST /internal/v1/ingestion/batches` with an injected verifier and a
   `createCapturingQueue` sender.
4. The test checks HTTP `202`, the committed R2 data/manifest pair, and the
   pointer fields.
5. `deliverQueueMessages` creates a Workers `MessageBatch` for the captured
   pointer and invokes the real `worker.queue` handler.
6. The test checks an explicit ACK and reads only projection counts, the
   connection ID, and the content-free live watermark.

Run the focused consumer assertion separately when checking the exact
archive-read, projection-apply, and ACK boundary:

```sh
WRANGLER_LOG_PATH=/tmp/communicator-matrix-ingestion-wrangler.log pnpm --filter @communicator/control-plane exec vitest run --config vitest.worker.config.ts worker/test/ingestion/consumer.test.ts -t "reads one exact archive pair, initializes, applies once, and ACKs after success"
```

The Queue pointer has exactly these fields:

```text
schema_version
kind
tenant_id
batch_id
manifest_key
canonical_sha256
gateway_route_id
```

It contains identifiers and digests only. It never contains an event body,
raw Matrix response, token, or key. The manifest is the R2 commit marker. The
data object is written and verified first; the manifest is written and
verified second; the pointer is sent only after both are committed.

## Technical protocol and idempotency

The private endpoint accepts one tenant per request. It performs the following
steps before returning `202`:

1. Read a bounded JSON body and validate the strict ingestion schema.
2. Verify the dedicated ingestion OIDC audience and active service principal.
3. Resolve the active gateway route in D1.
4. Resolve every event account to its immutable tenant, identity, provider,
   connection, and route mapping.
5. Recompute the deterministic `batch_id` from the canonical event bytes and
   stable request metadata.
6. Create or verify the R2 data object and manifest pair.
7. Send the strict pointer to `INGESTION_QUEUE`.
8. Return `202` with `archive_status` set to `created` or `already_committed`.

The consumer then parses the pointer, reads and verifies the exact R2 pair,
checks tenant/batch/key/digest equality, validates every archived event,
resolves historical D1 bindings, initializes the exact tenant object, and
calls `applyBatch` with a minimal internal `projection.write` authorization.
It calls `message.ack()` only after the Durable Object transaction succeeds.

An exact retry uses the same batch ID and body. It reuses one immutable R2
pair and may send another safe pointer. A duplicate pointer is a projection
no-op. The same batch ID with different canonical content is a conflict.
Queue delivery order is not an authority. The projection's event hashes and
last-write-wins ordering converge after duplicates or reordering.

The request source checkpoint is only this digest shape:

```json
{
  "kind": "matrix_sync_token_sha256",
  "value": "sha256:<64 lowercase hex characters>"
}
```

The raw Matrix sync token never enters D1, R2, the Durable Object, Queue, an
error, a log, or a trace. The consumer derives a separate
`live_event_watermark` from the greatest `(observed_at, event_id)` event tuple.
The source checkpoint digest and projection watermark must never be treated
as the same cursor.

## Stable errors and operator checks

The HTTP endpoint returns a content-free error envelope. The status and code
mapping is:

| Status | Code | Meaning |
| ---: | --- | --- |
| 400 | `ingestion_invalid` | Body, schema, content type, key, or batch identity is invalid. |
| 401 | `ingestion_unauthenticated` | The bearer credential is missing or fails the ingestion verifier. |
| 404 | `ingestion_not_found` | The service, route, tenant, or account mapping is not available. |
| 409 | `ingestion_conflict` | Immutable archive or batch data disagrees with an existing record. |
| 413 | `ingestion_too_large` | The bounded request or canonical archive limits were exceeded. |
| 503 | `ingestion_unavailable` | D1, R2, Queue, or another required local service failed. |

The response message is generic. The implementation never serializes a raw
exception, provider response, request body, or archive content.

For Queue failures, the consumer retries every failed message and never ACKs
it. It uses a 60-second delay for unavailable or rebuilding state. It uses a
300-second delay for invalid, corrupt, missing, forbidden, or conflicting
state. Successful siblings are ACKed independently. A malformed pointer,
missing/corrupt pair, mapping conflict, or failed projection eventually goes
to the configured DLQ after the Queue retry budget.

When investigating, check only metadata and state:

- the stable error code and status;
- tenant and batch correlation metadata allowed by the operator log policy;
- whether the manifest exists and its key, batch, tenant, and digest agree with
  the pointer;
- whether the data object exists and its size, ETag, and content metadata agree
  with the manifest;
- whether D1 still resolves the historical route and account mapping; and
- whether the tenant projection status reports the expected generation,
  applied count, and live watermark.

Do not print or paste event bodies, raw Queue payloads, full manifests, source
checkpoint values, Matrix room/event IDs, credentials, or raw exception
messages. Tests in `log-redaction.test.ts` prove that request bodies, tokens,
protected IDs, and archive content do not reach logs.

## DLQ and retention procedure

The DLQ is an operational investigation queue, not an archive. Hosted staging
and production Queue and DLQ resources retain messages for 14 days. Inspect a
failed pointer within 12 hours so reconciliation does not depend on retention
expiry. Local tests assert retry and ACK decisions but do not simulate the
14-day clock or hosted DLQ transfer.

Never skip or delete a failed pointer before reconciliation. For its stable
tenant and batch metadata, compare:

1. the R2 manifest and referenced data object;
2. the manifest digest and pointer digest;
3. the immutable D1 route/account/connection/identity mapping; and
4. the tenant Durable Object status, generation, applied count, and source
   versus projection checkpoint fields.

If the pair is valid and the failure was temporary, replay the same pointer
after fixing the unavailable dependency. If the pointer is malformed or
conflicts with immutable archive evidence, do not mutate the archive to make it
fit. Keep the item for the approved operator decision and record only a
content-free reason. Delete or discard it only after reconciliation and the
approved retention/deletion decision. An expired pointer does not erase the R2
archive or prevent a tenant rebuild from the committed manifest listing.

## Full R2 rebuild after projection divergence

R2 is the repair source. A rebuild does not need the original Queue pointer.
The trusted operator path is:

1. Identify one tenant and read its projection status with the
   `projection.status` scope.
2. Call `beginRebuild` with the current generation, a never-used rebuild ID,
   and a caller-supplied `started_at`.
3. Use the existing `readReplayPage` archive reader to list that tenant's
   committed manifests. Start at a null archive cursor and pass each validated
   page to `applyReplayPage` with the active rebuild ID and internal
   `projection.rebuild` authorization.
4. Resume from the Durable Object's persisted replay cursor after a crash.
   Retry the same page and digest if the page did not commit. Do not skip an
   invalid page or advance the cursor by hand.
5. After the terminal replay page commits, call `completeRebuild` with the
   active rebuild ID and a caller-supplied `completed_at`.
6. Confirm the object is `ready`, its generation is current, and its counts and
   live event watermark are derived from the replayed R2 evidence.

The rebuild preserves the immutable D1 account/connection history and the R2
data/manifest pair. It clears and recreates derived projection rows. It does
not copy the raw source checkpoint into the projection, and it never changes
Synapse. If an immutable archive page is unsupported or corrupt, abort the
rebuild with a bounded failure code, fix the trusted reader/projector or make
the reviewed contract migration, then start a fresh rebuild ID. There is no
skip-event escape hatch.

Exercise the committed archive rebuild behavior with the existing test:

```sh
WRANGLER_LOG_PATH=/tmp/communicator-matrix-ingestion-wrangler.log pnpm --filter @communicator/control-plane exec vitest run --config vitest.worker.config.ts worker/test/ingestion/end-to-end.test.ts -t "retains R2 while a tenant DO rebuilds and rebuilds a fresh projection from the archive"
```

There is no checked-in standalone rebuild CLI. Use the existing projection
RPCs and archive reader described in
`docs/runbooks/tenant-projection-local.md`; do not invent a remote command.

## Later Matrix Gateway contract

This phase stops at the authenticated ingestion boundary. A later Matrix
Gateway on the VPS must implement the following contract without changing the
R2, Queue, or projection consistency rules:

1. Maintain a verified Matrix device/session on the VPS and decrypt E2EE there.
2. Read Matrix sync responses, normalize inbound events into canonical
   Communicator events, and keep one tenant per submitted batch.
3. Persist an encrypted, fsynced local SQLite outbox row containing the stable
   `archived_at`, deterministic `batch_id`, canonical request body, and raw
   Matrix `next_batch` token. The raw token remains in this protected local
   store only.
4. Submit the exact batch body to
   `POST /internal/v1/ingestion/batches` and retry the same ID and body until
   the Worker returns `202`.
5. Advance the durable raw source checkpoint only after every tenant batch from
   that Matrix sync response is accepted. Compact the outbox only after the
   checkpoint is persisted.
6. If Cloudflare is unavailable, replay the protected outbox before reading
   more sync pages. If the local disk reaches its high-water mark, pause sync
   and alert instead of dropping events.
7. Keep undecryptable events pending. Never submit ciphertext as a normalized
   message, and do not silently skip it.
8. Normalize inbound and outbound mutations, typing, and read receipts while
   preserving tenant and identity isolation in every outbox row, checkpoint,
   batch, retry, and acknowledgement.

The Gateway may read the operational Matrix/Synapse record through its verified
device, but Cloudflare receives only the normalized batch and its digests.
Matrix session keys, device keys, access keys, bridge secrets, raw sync
responses, and provider credentials never cross the VPS boundary.

## Local verification gate

From the repository root, run the focused exercise and then the complete Task 9
verification commands. The focused Worker commands do not require Docker; the
`pnpm test:python` repository gate does require Docker Engine and Docker Compose
v2 because its bridge contract tests invoke `docker compose config`:

```sh
WRANGLER_LOG_PATH=/tmp/communicator-matrix-ingestion-wrangler.log pnpm --filter @communicator/control-plane exec vitest run --config vitest.worker.config.ts worker/test/ingestion/end-to-end.test.ts -t "archives Human WhatsApp ingress, queues a pointer, and projects it into the real tenant DO"
WRANGLER_LOG_PATH=/tmp/communicator-matrix-ingestion-wrangler.log pnpm --filter @communicator/control-plane exec vitest run --config vitest.worker.config.ts worker/test/ingestion/consumer.test.ts -t "reads one exact archive pair, initializes, applies once, and ACKs after success"
pnpm check
WRANGLER_LOG_PATH=/tmp/communicator-matrix-ingestion-wrangler.log pnpm test
chmod 0755 scripts/init-telegram-runtime.sh
pnpm test:python
git diff --check
```

All commands are local. Do not run `wrangler deploy`, `wrangler dev
--remote`, remote D1/R2/Queue commands, or a live Matrix provider action as
part of this gate.

## Related runbooks

- [Control Directory local runbook](control-directory-local.md)
- [R2 archive local runbook](r2-archive-local.md)
- [Tenant projection local runbook](tenant-projection-local.md)
