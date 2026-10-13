---
repo: 0000-chat/0000
status: current
---

# Durable storage

This document describes the public storage topology, finite service limits,
and lifecycle behavior implemented by the Database Worker. It describes a
self-hostable service; it does not claim a managed or production deployment.

## First durable increment

The Worker routes each opaque database slug to one SQLite-backed Durable
Object (DO). That DO owns database metadata, tables, columns, records,
per-database counters, lifecycle timestamps, export snapshots, and mutation
replay outcomes. REST and MCP call the same operation layer so they share data,
limits, and retry behavior. The slug is generated from 16 cryptographically
random bytes; names are not identifiers or access credentials.

A singleton SQLite Registry DO owns creation-key recovery and global admission
for database count, logical storage, mutation replay, physical SQLite
reservations, admitted requests, mutations, exports, and its own bounded
control store. The existing Registry binding and SQLite class are reused.
Before a cross-DO write, the Registry records a reservation; uncertain results
remain charged until reconciliation. A database mutation commits its data and
local replay outcome in the database DO, after which the Registry settles the
global reservation and usage. The DOs do not share a transaction, so recovery
must account for both sides of that boundary.

Before creation, the Registry stores a digest of the creation key and request,
a fresh slug, and a pending state. An idempotent `ensureCreated` call
initializes that slug. The Registry stores the completed creation result
before returning it. A matching retry recovers the same result; reusing a key
with different create fields conflicts. Retired databases cannot be
reinitialized by replaying an earlier creation request. Clients must generate
creation keys with at least 128 bits of cryptographic randomness and retain
them only for retry; the server's length check cannot measure key entropy.

Each database mutation validates against the current schema and checks its
version preconditions in the same synchronous SQLite transaction as the data
change, quota counters, successful activity timestamp, and 24-hour replay
outcome. A thrown error rolls back that transaction. Global capacity is
reserved before the local commit; when the result is uncertain the reservation
is retained until the Registry reconciles it. Cloudflare documents that
`transactionSync` callbacks must finish synchronously and roll back when they
throw; consume SQL cursors before crossing an `await` boundary. See the
[SQLite storage API](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/)
and [Rules of Durable Objects](https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/).

Mutation replay is keyed per database and compares a transport-neutral digest
of the canonical operation, target, inputs, and preconditions. A matching key
returns the original logical result without repeating the mutation. A changed
request conflicts. Creation replay is kept separately in the Registry. The
24-hour period starts at completion; retries after it are not guaranteed safe.
Replay does not renew inactivity or consume another mutation allowance, though
the request and returned bytes remain subject to throttling.

Durable state belongs in DO SQLite storage, not Worker or DO instance memory.
The Registry's capacity policy and reservation records are durable too. The
Registry measures database physical usage with the DO SQLite
`sql.databaseSize` metric. It reserves up to 128 MiB for each database and
tracks an aggregate database reservation ceiling separately from the
Registry/control-store ceiling. On retirement, new requests stop, pending
cross-DO reservations are reconciled, and `deleteAll()` must complete before
the Registry releases that database's physical reservation. An uncertain
physical cleanup remains charged for retry. Retired slugs stay unavailable and
do not cause a new local database to be initialized.

## Finite public capacity limits

All values below are finite defaults in the public Wrangler configuration and
apply across REST and MCP. The capacity policy is revisioned: changing any
capacity value or the service suspension state requires increasing
`CAPACITY_POLICY_REVISION`. A conflicting value at the same revision, an older
revision, or missing/invalid policy fails closed. Operators can change these
public configuration values when self-hosting; they are not account-, domain-,
or credential-specific settings.

| Global limit | Default bound |
| --- | ---: |
| Databases | 32 |
| Logical live-resource storage | 512 MiB |
| Retained mutation replay outcomes | 1 GiB |
| Aggregate physical reservation for database SQLite stores | 4 GiB (32 × 128 MiB) |
| Physical SQLite storage reservation | 128 MiB per database |
| Admitted requests | 50,000 per UTC day and 1,000 per minute |
| Mutations | 5,000 per UTC day |
| Immutable export snapshots | 128 MiB aggregate |
| Registry/control SQLite store | 64 MiB, separate from database reservations |

These limits bound service-level admission and storage reservations. They do
not cap provider-level incoming HTTP invocations or guarantee an absolute
provider billing ceiling. The 4 GiB value covers aggregate per-database
reservations; the separate Registry/control-store limit is additional.

Per-database values apply across every holder of a slug. Daily counters reset
at 00:00 UTC.

| Per-database limit | Default bound |
| --- | ---: |
| Logical live-resource storage | 10 MiB |
| Data requests | 1,000 per UTC day, including at most 100 mutations |
| Request burst | 60 requests per minute |
| Request body | 64 KiB |
| Ordinary response body | 256 KiB; collection page limits 1–100 (default 20) |
| Returned data | 100 MiB per UTC day |

The 256 KiB limit is the maximum complete response body. Single-resource
mutation outcomes, including replays, are capped at 255 KiB of serialized
resource JSON so either transport can return them within that body limit;
schema writes that expand existing records enforce the same cap. Collection
pages shrink to fit the effective transport budget, while a single resource
that cannot fit returns `RESULT_TOO_LARGE`. The daily returned-data counter
counts logical resource JSON bytes, excluding HTTP and MCP envelopes. The
global admitted-work counters count requests accepted by Database; provider
ingress charges for rejected incoming requests are outside this accounting.

The logical measure is the UTF-8 byte length of
`JSON.stringify({ database, tables, columns, records })` built from the live
API resource representations; collection arrays are ordered by resource ID.
It has no separate fixed metadata allowance. This is a logical quota, not a
SQLite file-size cap: SQLite pages, indexes, request timestamps, quota counters,
replay rows, and deleted-page reuse add physical bytes. In particular, the
10 MiB per-database live-resource limit does not bound replay storage. Replay
and export reservations have separate global ceilings. Physical usage is the
SQLite DO's `sql.databaseSize` measurement; deletion of an individual export
snapshot can release its logical export reservation without immediately
reducing the SQLite page allocation. Database physical capacity is released
only after the database's storage has been deleted.

At most 100 successful mutations may occur per database on each UTC day, and
at most 5,000 mutations are admitted service-wide per UTC day. A rolling
24-hour replay window can therefore cross a UTC day boundary. Each mutation
reserves a bounded amount from the global replay ceiling before it commits;
the local replay outcome and global reservation are reconciled after commit.
These logical reservations are separate from the physical SQLite bounds.

## Lifecycle

Creation records `createdAt`, `writeUntil`, and `lastActivityAt` durably.
`writeUntil` is 30 days after creation. At and after that cutoff, new data and
schema mutations fail as read-only; reads and bounded exports remain available
subject to expiry and quotas. The write window never extends or pauses.

Seven-day inactivity expiry is measured from the last successful data
operation. Resource reads, writes, schema writes, export start, and export
page reads renew it. Metadata polling, failed requests, mutation replays, and
per-database quota rejections do not. Persisted service-suspension intervals
are excluded from inactivity age; service suspension does not pause the
30-day write window. Inactivity is enforced at request admission and alarms
perform eventual storage cleanup. There is no public whole-database delete or
directory operation.

When a database expires, the Registry marks it retiring and stops serving its
slug. It reconciles in-flight global reservations, then asks the database DO
to delete all storage. The physical reservation is released only after
storage deletion succeeds. Failed or uncertain cleanup remains charged for
retry. A retired slug does not allocate local SQL tables or become active
again through a creation replay.

## Immutable JSON exports

An export is a consistent, immutable snapshot of the database metadata, tables,
columns, and records at `snapshotAt`. The first database item omits the URL,
access warning, slug, and creation retry history. Indexes are not part of the
current resource model. REST starts exports with `POST D/exports` and a
required `Idempotency-Key`; MCP uses `start_export(databaseId, requestKey)`.
REST reads pages at `GET D/exports/{exportId}` and MCP uses
`read_export(databaseId, exportId, cursor?, limit?)`.

Snapshots are limited to 12 MiB each, three active exports per database, and
128 MiB of global logical export reservation. Handles expire after 24 hours.
Pages accept limits from 1 to 100 (default 20) and the complete response is
bounded by 256 KiB. `snapshotAt`, `expiresAt`, and an opaque continuation
cursor let clients assemble the immutable snapshot. An expired handle returns
HTTP 410 `EXPORT_EXPIRED`. Export items use `type` tags `database`, `table`,
`column`, or `record`. Column items put the scalar type (`string`, `number`, or
`boolean`) in `columnType` so `type` remains the item tag. Ordinary record
items include `values`; when those values do not fit in one response, the
service emits record chunks with
`chunk: { encoding: "json", offsetBytes, totalBytes }` and a `data` string.
Concatenate each record's UTF-8 `data` chunks in offset order to reconstruct
the JSON-encoded `values`. Expiry releases the logical export reservation;
SQLite pages remain covered by the database's physical reservation until
database cleanup deletes them.

## Acceptance and deployment boundary

The local acceptance suite is intended to cover policy parsing, global and
per-database admission, request and returned-byte UTC rollovers, concurrent
capacity, suspension-aware inactivity, the fixed write cutoff, physical
cleanup, and immutable export persistence and expiry. These checks establish
local SQLite Durable Object behavior only. A public artifact build also does
not establish that a managed or production endpoint has been deployed, nor
that a host MCP client is compatible.
