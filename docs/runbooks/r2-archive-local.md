# Ordinary R2 Event Archive — Local Runbook

This runbook is the local operator reference for the ordinary R2 event archive
contract. It describes the checked-in binding, object layout, commit marker,
retry behavior, bounded replay reader, and local checks. It does not provision
Cloudflare resources or authorize a deployment.

## Deployment prohibition

The bucket names in Wrangler are configuration targets only; they do not
provision Cloudflare resources. This phase authorizes no `wrangler deploy`,
`wrangler dev --remote`, `r2 bucket create`, remote bucket listing, object
mutation, or Cloudflare API mutation. Do not inspect or change a live bucket as
part of local archive verification.

The archive names are reserved targets and are not evidence that any bucket
exists:

- local: `communicator-event-archive-local`
- staging: `communicator-event-archive-staging`
- production: `communicator-event-archive-production`

## Storage separation

`EVENT_ARCHIVE` is an ordinary R2 bucket binding for immutable, canonical event
batches and their manifests. It is a rebuild/replay source for derived
projections. It is not a backup destination and does not contain a VPS image,
database dump, bridge state, or recovery bundle.

The existing encrypted VPS/restic backup uses its own root-only
`RESTIC_REPOSITORY` target and recovery workflow. The repository does not name
that target or carry its credentials. The event archive must never use the
restic bucket, restic objects, restic credentials, restic retention policy, or
restic recovery procedure. Even when both services use R2-compatible storage,
their buckets and operational ownership remain distinct.

## Current scope

The archive contract and local Worker archive library are testable, but there
is no public archive route and no live invocation path in this phase. The
`EVENT_ARCHIVE` binding is isolated in each checked-in Wrangler environment;
local tests may use an in-memory R2-compatible fixture. No production write,
replay, provisioning, or deployment is implied by the binding declaration.
No application route imports the archive writer or reader yet.

## Object layout and metadata

The data object is gzip-compressed canonical JSON Lines. The manifest is a
canonical JSON object stored separately:

```text
events/tenant_pilot/2026/09/07/01/batch_01abc.jsonl.gz
manifests/tenant_pilot/2026/09/07/01/batch_01abc.json
```

`tenant_pilot` and `batch_01abc` are synthetic examples. The shape is:

```text
events/<tenant_id>/<YYYY>/<MM>/<DD>/<HH>/<batch_id>.jsonl.gz
manifests/<tenant_id>/<YYYY>/<MM>/<DD>/<HH>/<batch_id>.json
```

The partition is UTC and is derived from the earliest event's
`observed_at`. The same tenant, UTC hour, and `batch_id` must occur in both
keys. Resource IDs match the canonical lower-case resource-ID grammar, a batch
ID starts with `batch_`, and the complete printable-ASCII key is at most 512
characters. Path traversal, alternate prefixes, invalid dates, and mismatched
tenant or batch components are invalid.

The data object has `Content-Type: application/x-ndjson` and
`Content-Encoding: gzip`. The manifest has `Content-Type: application/json`
and no content encoding. Both objects carry exactly this custom metadata shape
(with the hash filled by the encoder):

```text
schema-version = 1
tenant-id = tenant_pilot
batch-id = batch_01abc
canonical-sha256 = <64 lowercase hexadecimal characters>
```

The manifest records schema version `1`, the data key, gzip and NDJSON
declarations, event and byte counts, the canonical SHA-256, the data ETag,
first/last event IDs and observed times, archive time, producer version, and a
nullable source checkpoint. Its tenant and batch must agree with the key, its
data partition must agree with `first_observed_at`, and
`first_observed_at` must not be later than `last_observed_at` as an instant.

## Immutable commit lifecycle

The manifest is the commit marker. A data object alone is not a committed
batch and must never be replayed.

1. Validate the tenant, batch, timestamps, producer/checkpoint fields, and
   canonical event input. Canonicalize and gzip the batch while enforcing the
   bounds below, before any R2 write.
2. Put the data key with an unconditional-create precondition
   (`onlyIf: { etagDoesNotMatch: "*" }`). A successful put or a conditional
   miss is followed by a bounded read of the actual object.
3. Verify the data object's key, size, ETag, content metadata, custom metadata,
   gzip contents, canonical JSONL bytes, tenant, event count, and SHA-256. The
   actual R2 size and ETag are the source of truth for the manifest.
4. Build the manifest from that verified data and conditionally create the
   manifest key with the same immutable-create precondition.
5. Read the manifest back and validate its canonical bytes and metadata, then
   verify the referenced data object again. Return `created` only after this
   pair is verified; a matching existing marker returns `already_committed`.

There is no update-in-place operation. The data object is written first so a
manifest can never certify data that was not checked. The manifest is written
last so listing `manifests/<tenant_id>/` is a commit-marker view of batches
that are eligible for replay.

## Retry behavior

An identical retry means the same tenant, `batch_id`, canonical event bytes,
archive time, producer version, and source checkpoint (therefore the same
manifest bytes).

- If the data key is absent, the retry creates and verifies it, then attempts
  the manifest.
- If the data key already exists, the conditional put does not overwrite it.
  The writer reads and verifies the existing bytes and metadata. Exact data is
  reused; different data at the same key is an `archive_conflict`.
- If the first attempt wrote data but failed before the manifest, an identical
  retry can finish the marker and commit the batch.
- If the manifest already exists with the exact expected canonical bytes and
  the verified data pair, the retry returns `already_committed`.
- If the manifest exists but differs in any manifest-bearing input, metadata,
  ETag, size, or referenced data, the retry returns `archive_conflict`; neither
  object is overwritten.
- Concurrent identical writers may race on the conditional puts. The winner
  commits once; the loser validates the winner's pair and receives the same
  already-committed result. A conflicting writer never replaces the winner.

## Orphans and deferred garbage collection

A data object left behind by a failure before the manifest put is an orphan.
It is intentionally invisible to the committed-manifest listing and to replay:
readers list only `manifests/<tenant_id>/`, then validate each manifest before
reading its data key. An orphan is not evidence of a committed event batch.

This phase does not delete or garbage-collect orphans. A later maintenance
job may list only contract-shaped `events/` keys, derive the paired manifest
key, confirm that no valid manifest exists, and delete the data object only
after a conservative safe-age threshold longer than the maximum retry and
reconciliation window. The job must tolerate a retry racing with its scan,
re-check immediately before deletion, record only redacted diagnostics, and
never delete a valid manifest/data pair. Safe-age GC is a future deletion
workflow, not a local command in this runbook.

## Manifest diagnostics and replay

`listCommittedManifestPage` is a manifest-only diagnostic/admin reader. It
lists the tenant's manifest prefix, validates every returned manifest, and
uses the R2 cursor without reading event bodies. Its default page size is 50
manifests and its maximum is 100. The 100-manifest limit is for bounded
diagnostics and administration; it is not a recommendation to replay 100
batches at once.

`readCommittedArchiveBatch` and `readReplayPage` are read-only. Replay has
`replay_mode: "projection_only"`: it returns validated manifests and canonical
events for a caller that may rebuild a derived projection. It does not write
R2, mutate D1 or a Durable Object, acknowledge a source, emit a replay event,
call Matrix or a provider, send media, or perform deletion. A replay consumer
must treat the returned page as input data only and must not turn this reader
into an outbound side effect.

Replay defaults to one manifest/batch per page and accepts at most 100. The
page is additionally capped at 2,000 aggregate events and 8 MiB of aggregate
decoded/uncompressed canonical JSONL, whichever is reached first. Thus a
larger requested page size does not bypass the event or byte caps. Replay and
manifest cursors are opaque, canonical, tenant-bound values; do not construct
or edit them by hand.

## Contract bounds

These are application contract limits, independent of a provider's or
Cloudflare's larger maximums. Exact boundaries are accepted; values above
them, empty batches, and zero byte counts are rejected.

| Contract constant | Bound |
| --- | ---: |
| `MAX_ARCHIVE_EVENTS` | 500 events per batch |
| `MAX_EVENT_CANONICAL_BYTES` | 1 MiB per canonical event envelope |
| `MAX_ARCHIVE_UNCOMPRESSED_BYTES` | 4 MiB canonical JSONL per batch |
| `MAX_ARCHIVE_COMPRESSED_BYTES` | 5 MiB gzip output per batch |
| `MAX_ARCHIVE_MANIFEST_BYTES` | 64 KiB per manifest |
| `MAX_ARCHIVE_KEY_CHARS` | 512 printable-ASCII characters |
| `MAX_ARCHIVE_ETAG_CHARS` | 256 characters |
| `MAX_PRODUCER_VERSION_CHARS` | 128 characters, non-empty after trim |
| `MAX_CHECKPOINT_KIND_CHARS` | 64 characters, non-empty after trim |
| `MAX_CHECKPOINT_VALUE_CHARS` | 512 characters, non-empty after trim |
| `DEFAULT_MANIFEST_PAGE_SIZE` | 50 manifests |
| `MAX_MANIFEST_PAGE_SIZE` | 100 manifests |
| `DEFAULT_REPLAY_PAGE_SIZE` | 1 manifest/batch |
| `MAX_REPLAY_PAGE_EVENTS` | 2,000 events (`4 * MAX_ARCHIVE_EVENTS`) |
| `MAX_REPLAY_PAGE_UNCOMPRESSED_BYTES` | 8 MiB aggregate decoded bytes |
| `MAX_REPLAY_CURSOR_CHARS` | 4,096 characters |
| `MAX_R2_CURSOR_CHARS` | 2,048 characters |
| `MAX_MANIFEST_PREFIX_CHARS` | 256 printable-ASCII characters |

Canonical JSON input has additional safety bounds: depth at most 32, at most
50,000 visited nodes, at most 10,000 entries in an array or object, object
keys at most 256 characters, and strings at most 1,048,576 characters.
Canonical resource IDs are at most 128 ASCII characters and match
`^[a-z]+_[a-z0-9_]+$`. Opaque event, Matrix-room, Matrix-event, and remote
message IDs are non-empty and at most 1,024 characters; Matrix IDs also retain
their required `!` or `$` prefix. Contract timestamps are ISO date-times with
an offset and at most 64 characters.

The manifest schema is strict: unknown fields, wrong schema/version,
compression, content type, hash format, ETag, tenant, batch, key, timestamp,
or checkpoint shape are invalid. A source checkpoint is either `null` or a
strict `{ kind, value }` object within the bounds above. Replay pages are
strict `{ schema_version: 1, replay_mode: "projection_only", tenant_id,
manifests, events, next_cursor }` values; all manifests and events must belong
to the page tenant. The encoded replay cursor contains the exact prefix
`manifests/<tenant_id>/`, an R2 cursor of 1–2,048 characters, and a total
encoded length of at most 4,096 characters.

## Worker platform envelope

The current [Cloudflare Workers limits](https://developers.cloudflare.com/workers/platform/limits/)
page documents 128 MB of memory per isolate on both Free and Paid plans. This
is per isolate, not per invocation: one isolate may serve many concurrent
requests, so concurrent archive reads share the isolate's memory budget. The
4 MiB batch and 8 MiB replay caps deliberately leave headroom for compressed
buffers, decoded rows, validation, framework state, and other concurrent
requests; keep the reader bounded/streaming and do not turn a page into an
unbounded accumulator.

The same page currently lists 50 subrequests per invocation on Free and
10,000 on Workers Paid (with a configured Paid limit that may be increased).
R2 `list`, `get`, `put`, `delete`, and `head` calls count as subrequests. A
100-manifest diagnostic or replay operation can therefore consume many R2
subrequests even though its application page bounds are respected. If an
operational job relies on high subrequest counts, use the appropriate Workers
Paid plan and verify the Worker's configured limit; do not assume the Free
50-request allowance. The platform also limits an invocation to six outbound
connections waiting for response headers, so avoid issuing unbounded parallel
R2 operations.

## Redaction and handling rules

- Use synthetic fixtures such as `tenant_pilot` for local examples and tests;
  do not copy production events into a fixture, issue, terminal transcript, or
  review.
- Never print or paste event payloads, message text, media, room IDs, contact
  IDs, provider identifiers, credentials, cookies, authorization material,
  source checkpoints, or complete manifests. A manifest contains event IDs,
  timestamps, tenant and batch names, and a data hash and is sensitive too.
- Log only stable archive error codes and generic messages. Do not serialize
  R2 bodies, request environments, exception causes, or cursor contents.
- Keep examples and configuration free of real credentials. Do not use a
  remote Wrangler session, live bucket command, tail of production logs, or a
  command that writes secret values to the repository.

## Local verification

Run from the repository root. These commands exercise local generation,
type/build checks, and the Worker test runtime only:

```bash
pnpm --filter @communicator/control-plane types:worker
pnpm --filter @communicator/control-plane check
pnpm --filter @communicator/control-plane test:worker
```

Inspect the checked-in Wrangler binding and generated type without contacting
Cloudflare:

```bash
rg -n 'EVENT_ARCHIVE|communicator-event-archive-' \
  apps/control-plane/wrangler.jsonc \
  apps/control-plane/worker-configuration.d.ts
```

The expected binding is `EVENT_ARCHIVE` in the base, staging, and production
Wrangler configurations, with the three reserved names listed above. The
local Worker runtime may expose an empty isolated binding. No application
route is expected to read or write it yet. Do not replace these checks with
`wrangler dev --remote`, a remote R2 listing, a bucket creation command, or an
object mutation.

## Future provisioning checklist (do not execute in this phase)

Only after an explicit infrastructure approval and deletion/privacy review:

- [ ] Confirm the intended Cloudflare account, environment owner, billing plan,
      and the three reserved bucket names.
- [ ] Provision one ordinary event-archive bucket per environment, and record
      evidence that none is the encrypted restic backup target.
- [ ] Attach only the `EVENT_ARCHIVE` binding to the matching Worker
      environment; keep credentials out of source control and use least
      privilege and rotation procedures.
- [ ] Confirm the selected Workers plan and configured subrequest limit are
      compatible with the intended diagnostic/replay workload.
- [ ] Run an approved synthetic write/read/retry/repair probe and verify that
      a data object is never considered committed without its manifest.
- [ ] Add redacted monitoring for unavailable, conflict, corrupt, orphan, and
      safe-age-GC candidates before enabling any maintenance job.
- [ ] Make the retention, legal-hold, object-lock, and erasure decision in the
      deletion/privacy milestone. Do not add lifecycle rules, bucket locks, or
      deletion automation here.
- [ ] Obtain deployment approval and perform any environment rollout through
      the separate deployment runbook; this local task does not deploy.

## Explicitly excluded scope

This phase includes no public routes or API, Durable Objects, Queues, Matrix or
provider integration, media handling, export handling, deletion or erasure,
R2 Data Catalog, Pipelines, Brain, deployment, bucket creation, secret
configuration, or live Cloudflare mutation. Retention policy, object locks,
and all destructive cleanup remain deferred to the deletion/privacy milestone.
