---
repo: 0000-chat/0000
status: current
---

# Standalone pilot REST and MCP contract

Status: accepted interface contract. The transferred [pilot contract issue](https://github.com/0000-chat/0000/issues/40) records the product decisions. This document specifies the intended public interface; the first durable increment implements only the supported subset listed in the service README. It does not claim hosted client compatibility.

## Purpose and scope

The first use is a personal shopping list that an agent can save and retrieve in a later session. REST and MCP expose the same general database operations and access the same data. One reusable connection per client accepts the database link. Personal ChatGPT Work use is the first client milestone; Grok web, mobile, and Bot follow alongside it. Public plugin distribution, private copies, billing, and ecosystem integration are outside the first release.

The accepted temporary-database policy governs this contract. The user's later decision clarifies that its public deletion restriction concerns the whole database, not tables, columns, indexes, or records.

## Current implementation

The durable pilot implements database create/read; table create/list/read; column create/list/read; and record create/list/read/update/delete. It uses the REST and MCP paths in the operation table below. Table/column changes beyond creation, indexes, and exports remain unimplemented. Passing the runtime acceptance suite proves local SQLite Durable Object persistence and transport parity for the supported slice; it does not prove a managed deployment or host-client compatibility.

## Identity and transport

- REST uses `/v1`; the proposed MCP endpoint is `/mcp` over HTTPS Streamable HTTP. Negotiation and tool envelopes follow the supported MCP SDK version selected during implementation.
- Creation returns `databaseId`, `databaseUrl`, `createdAt`, and `writeUntil`. `databaseId` is the unguessable random slug and is the only public database identity. Use at least 128 bits of cryptographically random entropy, encoded as an opaque URL-safe string. Do not use names as capabilities.
- `databaseUrl` is the absolute REST database URL. A client may accept this link for convenience, but validates its origin and extracts the identifier; it must not fetch arbitrary user-supplied origins. MCP operations take `databaseId` explicitly after normalization.
- Possession of the slug grants shared access under lifecycle rules. There is no separate owner credential or database account in this pilot. No endpoint lists all databases. Never expose creation keys or other database slugs in directory results or ordinary logs.
- Return the access warning with creation and database metadata: anyone with this link can read and change the database while writable; use it at your own risk and do not store sensitive information. No claim of private ownership is implied.
- Resource IDs are opaque strings. Versions are opaque decimal strings, compared for equality by clients; storage advances them without reuse for the same resource. Timestamps use UTC RFC 3339 strings.

## Resource data

| Resource | Required returned fields |
| --- | --- |
| Database | `databaseId`, `databaseUrl`, `name`, `description`, `createdAt`, `writeUntil`, `lastActivityAt`, `state`, `accessWarning` |
| Table | `id`, `name`, `description`, `schemaVersion` |
| Column | `id`, `name`, `type`, `nullable` |
| Index | `id`, `name`, `columnIds` |
| Record | `id`, `values`, `version` |

`state` is `writable` or `read_only` for an accessible database. Expired or removed databases are unavailable. `values` maps column IDs to JSON scalar values. The initial column types are `string`, `number`, and `boolean`; null is allowed only for nullable columns. Missing nullable values become null. Reject unknown column IDs, invalid types, and missing required values without a partial write.

Create inputs accept `name` and optional `description` for databases/tables, `name`, `type`, and `nullable` for columns, and `name` plus a nonempty ordered `columnIds` array for indexes. Names must be nonempty after trimming. Sibling table/column/index names are case-insensitively unique within their respective namespaces. Record creates accept `values`; record patches merge supplied cells without removing unspecified cells. Metadata patches accept only mutable name/description fields. Resource identifiers and lifecycle fields are immutable.

Initial indexes are non-unique indexes over existing columns. Unique constraints, expressions, and unrestricted SQL are not added by this specification. Exact index count, width, and row-work limits must be bounded by the operating-limits decision before release.

## Operation parity

In the table, `D` means `/v1/databases/{databaseId}` and `T` means `D/tables/{tableId}`. MCP takes the corresponding path identifiers as named input fields. Query parameters become fields of the same names in MCP input.

| REST operation | MCP tool | Operation-specific input |
| --- | --- | --- |
| `POST /v1/databases` | `create_database` | Database create fields; creation request key |
| `GET D` | `get_database` | None |
| `POST D/tables` | `create_table` | Table create fields |
| `GET D/tables` | `list_tables` | Pagination |
| `GET T` | `get_table` | None |
| `PATCH T` | `update_table` | Name/description patch |
| `DELETE T` | `delete_table` | Schema precondition |
| `POST T/columns` | `create_column` | Column create fields |
| `GET T/columns` | `list_columns` | Pagination |
| `GET T/columns/{columnId}` | `get_column` | None |
| `PATCH T/columns/{columnId}` | `update_column` | Name/type/nullable patch |
| `DELETE T/columns/{columnId}` | `delete_column` | Schema precondition |
| `POST T/indexes` | `create_index` | Index create fields |
| `GET T/indexes` | `list_indexes` | Pagination |
| `GET T/indexes/{indexId}` | `get_index` | None |
| `DELETE T/indexes/{indexId}` | `delete_index` | Schema precondition |
| `POST T/records` | `create_record` | `values` |
| `GET T/records` | `list_records` | Pagination, filter, sort |
| `GET T/records/{recordId}` | `get_record` | None |
| `PATCH T/records/{recordId}` | `update_record` | `values`, record precondition |
| `DELETE T/records/{recordId}` | `delete_record` | Record precondition |
| `POST D/exports` | `start_export` | None |
| `GET D/exports/{exportId}` | `read_export` | Optional continuation cursor |

Table deletion removes its definitions and records atomically. Column deletion removes its cells and dependent indexes atomically. Index deletion leaves records intact. Schema changes that cannot preserve current values and declared constraints fail atomically; no silent type coercion or destructive migration occurs on a type/nullability patch.

No public database `DELETE` or directory tool exists. Database metadata editing is not needed for the pilot and is omitted from the proposed operation set. Health and OpenAPI routes are transport utilities, not database tools. The current mock endpoint inventory is a starting point, not an obligation to publish all its routes.

## Concurrency and mutations

All data/schema mutations require a retry key. For REST send `Idempotency-Key`; MCP uses `requestKey`. REST record updates/deletes also send `X-Expected-Version`; MCP uses `expectedVersion`. REST table changes and column/index mutations send `X-Expected-Schema-Version`; MCP uses `expectedSchemaVersion`. Missing preconditions are validation errors. These header choices are engineering representations of the approved rules.

Record reads return `version`. Conditional record updates/deletes compare and mutate atomically. A stale version returns `VERSION_CONFLICT` without changing the record. Successful updates advance the version. Deletes return success once; a same-key retry can replay that success. A new request for a missing record returns `NOT_FOUND`.

Table definition reads expose the current `schemaVersion`; column/index operation responses expose it as well (the current REST implementation uses `X-Schema-Version`, and MCP returns `schemaVersion` in structured content). Table metadata/schema changes advance it. Concurrent stale schema changes fail with `SCHEMA_VERSION_CONFLICT`. Creating a new table requires no existing table precondition; sibling-name uniqueness resolves conflicting creates.

Record validation uses the current schema atomically with the write. A schema change that alters stored record values also advances affected record versions. This prevents an old record version from overwriting a schema-driven value change. Index changes do not alter record versions. Storage design must reject transformations beyond its bounded-work limits rather than publish partial changes.

## Retry behavior

Canonical operation identity, target IDs, normalized inputs, and concurrency preconditions determine whether a retry matches. REST/MCP transport envelopes and header spelling do not. The same key and canonical request return the original logical outcome across transports for 24 hours from completion; reads after replay may legitimately see later changes.

The commit and replay outcome are atomic. If the original attempt is still in progress, return `REQUEST_IN_PROGRESS` with retry guidance; do not execute another mutation. A reused key with a different canonical request returns `IDEMPOTENCY_CONFLICT`. Validation or version failures before execution do not commit a mutation or reserve a completed-success outcome. After a conflict, reread and submit the revised operation using a new key.

Database creation uses a separate global namespace of cryptographically random creation keys, with at least 128 bits of entropy. Repeating the creation request with that key recovers the same database link for 24 hours. Never interpret a creation key as a name or public lookup identifier. A recovered response does not recreate a database that an operator has removed.

Database-scoped replay requires the database still to be available and accessible. A committed mutation can replay after the write cutoff without writing again. Replay does not renew inactivity expiry or count as another data mutation. Request traffic may still be throttled. The 24-hour promise requires bounded admission and storage for replay outcomes; capacity exhaustion must reject new work before committing it without its replay result. After 24 hours, automatic retry safety is not promised; clients must not blindly resubmit old creates.

## Reads and ordinary pagination

Collection results contain `items` and `nextCursor`, which is null at the end. `limit` is an integer from 1 to 100, default 20. Responses also respect the byte bound, so a page may contain fewer items. Cursors are opaque continuation tokens bound to the database, resource, and normalized query. They are not access credentials.

Record lists retain typed equality filtering with `filterColumnId` and `filterValue`, and sorting with `sortColumnId` and `sortDirection`. Filter inputs must occur together. JSON scalars are not coerced. Sort ascending by default, place null last, and break ties by record ID. Unknown query fields, invalid cursors, or invalid column references are validation errors.

Ordinary list pagination is a live view, not a point-in-time snapshot. Use export for a consistent copy. Storage implementation must use bounded indexed work or reject a query beyond its supported limits.

## JSON exports

Starting an export captures table definitions, indexes, and records at one consistent point in time. The operation creates an export handle, not a user data mutation, and remains available after the write cutoff. It is subject to bounded export admission and capacity controls.

The start result returns `exportId`, `formatVersion: 1`, `snapshotAt`, and `expiresAt`. The handle is scoped to the database and does not bypass its access/lifecycle rules. Read results contain those identifiers, `items`, and `nextCursor`. Items are tagged as `table`, `column`, `index`, or `record`, include parent IDs where needed, and use the resource representations above. The first item describes the database, excluding access capabilities and retry history. Clients can assemble the bounded JSON pages into a complete export.

Every page uses the same snapshot, including its schema. A cursor must identify that snapshot; never resume against live data. An expired handle returns `EXPORT_EXPIRED`, requiring a new export. A response identifies completion through `nextCursor: null`. Clients must not treat a partial export as complete.

Snapshot lifetime and capacity admission are operating parameters to settle before release, communicated through `expiresAt` and errors. No unbounded snapshot retention or import API is promised. Preserve reserved bounded export capacity during ordinary workload suspension; database expiry/removal still makes the resource unavailable.

## Lifecycle and limits

The database is writable for 30 days from creation. At the cutoff all data/schema mutations fail with `DATABASE_READ_ONLY`; successful replay is not a new write. Reads and bounded exports remain available. Seven-day inactivity expiry follows the accepted policy: successful data reads/writes renew it; metadata, failed requests, and replays do not. Capacity suspension pauses the inactivity countdown but not the 30-day write window. Per-database quota exhaustion does not pause or renew either clock.

The provisional pilot bounds are 10 MiB storage; 1,000 data requests per UTC day including at most 100 mutations; 60 requests/minute burst; 64 KiB request bodies; 256 KiB ordinary response bodies; and 100 MiB returned data per UTC day. UTC daily reset is 00:00. All slug holders and both interfaces share the same counters. Global ceilings take precedence. Export uses a separately bounded allowance; its exact limits and renewal accounting remain in the operating-limits decision.

Single-resource mutation outcomes use a 255 KiB encoded-resource ceiling so the MCP JSON-RPC envelope remains within the 256 KiB full-response cap. Daily returned-byte accounting counts logical resource JSON and excludes transport envelopes.

## Results and errors

REST creates return 201; reads and patches return 200; data/schema deletes return 204. Export start returns 201 for an available handle. REST errors use `{ "error": { "code": "...", "message": "...", "details": {} } }`. MCP returns the same logical result/error fields in structured tool content, plus readable text and `isError` for a tool failure. Tool descriptions and annotations must accurately mark data mutations and destructive operations. Confirmation rules of the host remain in effect.

| HTTP | Codes |
| --- | --- |
| 400 | `VALIDATION_ERROR` |
| 404 | `NOT_FOUND` |
| 409 | `VERSION_CONFLICT`, `SCHEMA_VERSION_CONFLICT`, `IDEMPOTENCY_CONFLICT`, `REQUEST_IN_PROGRESS`, `NAME_CONFLICT`, `SCHEMA_INCOMPATIBLE`, `DATABASE_READ_ONLY` |
| 410 | `EXPORT_EXPIRED` |
| 413 | `REQUEST_TOO_LARGE`, `RESULT_TOO_LARGE` |
| 429 | `QUOTA_EXCEEDED` |
| 503 | `CAPACITY_UNAVAILABLE` |

Errors must not reveal unrelated database identifiers. Distinguish missing records from stale versions inside an accessible database. Return `Retry-After` where a meaningful delay is known, with equivalent MCP error detail. Failure or expiry during an export must be explicit, never a silently truncated success.

## Acceptance examples and remaining work

The interface acceptance sequence creates a database, shopping-list table, and columns; adds milk; reads it in a later request/session; changes quantity; and marks it bought. REST and MCP must observe the same identifiers and values. Verify stale record/schema rejection, cross-transport replay without duplication, creation-link recovery, absence of public discovery/deletion, and a concurrent-write export containing one consistent snapshot.

[Choose pilot persistence and the minimum enforceable operating limits](https://github.com/0000-chat/0000/issues/41) owns storage topology, atomicity mechanisms, restart behavior, bounded schema/index work, quotas, replay capacity, and export lifetime/cost. Those decisions must satisfy this behavior or explicitly reopen the affected product decision.

[Personal ChatGPT connection verification](https://github.com/0000-chat/0000/issues/45) remains empirical: documentation does not prove accountless writes work in the user's account. [Grok verification](https://github.com/0000-chat/0000/issues/46) proceeds alongside. Neither integration is declared working by this specification.

Sources: [consolidated decisions](https://github.com/0000-chat/0000/issues/40#issuecomment-5646417992), [final three approvals](https://github.com/0000-chat/0000/issues/40#issuecomment-5663390706), [implementation baseline](https://github.com/0000-chat/0000/issues/38), and [client compatibility research](https://github.com/0000-chat/0000/issues/44). The durable pilot deliberately implements a subset of this interface; see the README for the implemented operations and the storage decision for remaining launch gates.
