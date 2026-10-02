---
repo: 0000-chat/0000
status: current
---

# Durable storage

This document records the chosen storage design for the first durable database
increment and the operating decisions still required before public launch. It
describes behavior implemented in the local first increment and remaining
launch gates; it does not claim a production deployment or public-launch
readiness.

## First durable increment

The Worker routes each opaque database slug to one SQLite-backed Durable
Object (DO). That DO owns the database metadata, tables, columns, records,
per-database counters, lifecycle timestamps, and mutation replay outcomes.
REST and MCP call the same operation layer so they share data, limits, and
retry behavior. The slug is generated from 16 cryptographically random bytes;
names are not identifiers or access credentials.

A singleton SQLite Registry DO owns creation-key recovery. Before calling the
database DO, it stores a digest of the creation key and request, a fresh slug,
and a pending state. An idempotent `ensureCreated` call initializes that slug.
The Registry then stores the completed creation result before returning it.
A matching retry resumes the same slug and returns the same result; reusing a
key with different create fields conflicts. The Registry is a creation saga,
not a global capacity controller, and the two DOs do not share a transaction.
Clients must generate creation keys with at least 128 bits of cryptographic
randomness and retain them only for retry; the server's length check cannot
measure key entropy.

Each database mutation validates against the current schema and checks its
version preconditions in the same synchronous SQLite transaction as the data
change, quota counters, successful activity timestamp, and 24-hour replay
outcome. A thrown error rolls back that transaction. Cloudflare documents that
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
Restart acceptance therefore means replacing both runtime instances while
retaining their storage, then reading and updating the same IDs, values,
versions, counters, and timestamps.

## Provisional per-database limits

These pilot values apply across REST and MCP and across all holders of a slug.
Daily counters reset at 00:00 UTC. Any future global admission ceiling must
take precedence; this increment does not implement one.

| Limit | Provisional bound |
| --- | --- |
| Logical live-resource storage | 10 MiB per database |
| Data requests | 1,000 per UTC day, including at most 100 mutations |
| Request burst | 60 requests per minute |
| Request body | 64 KiB |
| Ordinary response body | 256 KiB; collections paginate with limits from 1 to 100 (default 20) |
| Returned data | 100 MiB per UTC day |

The 256 KiB limit is the maximum complete response body. Single-resource
mutation outcomes, including replays, are capped at 255 KiB of serialized
resource JSON so either transport can return them within that body limit;
schema writes that expand existing records enforce the same cap. Collection
pages shrink to fit the effective transport budget, while a single resource
that cannot fit returns `RESULT_TOO_LARGE`. The daily returned-data counter
counts logical resource JSON bytes, excluding HTTP and MCP envelopes.

The first-increment logical measure is the UTF-8 byte length of
`JSON.stringify({ database, tables, columns, records })` built from the live
API resource representations; collection arrays are ordered by resource ID.
It has no separate fixed metadata allowance. This is a logical quota, not a
SQLite file-size cap: SQLite pages, indexes, request timestamps, quota counters,
replay rows, and deleted-page reuse add physical bytes. In particular, the
10 MiB live-resource limit does not bound replay storage.

At most 100 successful mutations may occur on each UTC day. A rolling 24-hour
replay window can therefore contain 200 successful outcomes across a UTC day
boundary. If each retained outcome can be as large as the 256 KiB ordinary
response bound, response bodies alone can reach 50 MiB per database. The
current per-database estimate charges each outcome's response JSON bytes,
serialized response-header bytes, a 64-byte request fingerprint, and a
128-byte fixed allowance, with a 51 MiB cap. This estimate is not a physical
SQLite bound; actual row, index, and page overhead and the global
reserve-before-commit behavior still require measurement before public launch.

## Lifecycle

Creation records `createdAt`, `writeUntil`, and `lastActivityAt` durably.
`writeUntil` is 30 days after creation. At and after that cutoff, new data and
schema mutations fail as read-only; reads remain available subject to expiry
and quotas. Export is not implemented in this increment. The write window is
never extended or paused.

Seven-day inactivity expiry is measured from the last successful data read or
write. Successful schema writes also count as activity. Metadata polling,
failed requests, mutation replays, and per-database quota rejections do not
renew it. A database's own quota exhaustion does not pause the countdown. The
increment has no service-wide suspension control; a launch suspension design
must persist paused intervals and exclude them from inactivity age. Expiry is
checked when a request is admitted; alarms may clean up rows but are not the
enforcement boundary. There is no public database-delete or directory
operation.

## Acceptance criteria for #41/#48

These are acceptance requirements for the tracked issues, not a test report.
The local suite does not directly exercise the 1,000-request/day or 100 MiB/day
returned-data cutoff; those remain verification requirements.

The tracked increment is acceptable when tests show that:

- database, schema, records, versions, counters, creation results, and clocks
  survive Worker and DO instance replacement;
- creation retries recover the same slug after failures before initialization,
  after database creation, and before the Registry records completion, while
  changed inputs conflict and no retry recreates an operator-removed database;
- REST and MCP retries with the same mutation key change data once and return
  the same logical result; stale preconditions and over-quota writes leave no
  partial data;
- daily, burst, body, response, returned-byte, 10 MiB logical-storage,
  seven-day inactivity, and 30-day write-cutoff boundaries are enforced,
  including UTC rollover and the different activity rules above.

Before anonymous public launch, the service still needs durable global
admission for database creation, aggregate storage growth, request/workload,
replay retention, and cleanup, plus a defined suspension control. Reservations
must be acquired before commits and remain charged while a cross-DO outcome is
uncertain; per-database quotas and the Registry saga do not provide this bound.
The global ceilings, reservation recovery, physical-to-logical storage
relationship, and behavior under concurrent near-capacity load remain
unmeasured. Export also requires its own bounded capacity and immutable
snapshot path. Keep exports and any other unimplemented operation unavailable
until those limits and behaviors pass acceptance; do not infer implementation
or production readiness from this design.
