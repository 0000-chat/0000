---
repo: 0000-chat/0000
status: current
---

# 0000-database

This service lives at `services/database` in the public `0000` monorepo. It is
in active development: the first durable pilot stores data in one SQLite
Durable Object per database and exposes the same supported operations over
REST and MCP. The implementation decision and its remaining launch gates are
recorded in [`docs/architecture/storage.md`](docs/architecture/storage.md), and
the accepted interface is in
[`docs/specs/standalone-pilot-contract.md`](docs/specs/standalone-pilot-contract.md).

`0000-database` provides durable storage through anonymous, high-entropy
database links. Standalone use does not require a hosted 0000 account, login,
or platform credential. Anyone who has a database link can read its data and
write during the 30-day write window, so links are shared capabilities; do not
store sensitive information. `0000-streams` depends on this service. Database
owns data storage, access, limits, and lifecycle, not user identity or hosted
account management.

Platform identity integration is not part of this increment. Instead, the pilot
uses shared high-entropy bearer database links: anyone with a link can read
data and, during the write window, change it. Do not store sensitive
information. There is no database directory, database deletion route, user
login, or ownership credential in this pilot.

The REST and MCP interfaces create and read databases, tables, columns, and
records; record updates and deletes use version preconditions. Mutations use
idempotency keys, and REST/MCP retries share the same stored outcome. List
routes use bounded pages with opaque cursors. Immutable JSON exports are
available over both interfaces. Indexes, destructive table/column changes,
whole-database administration, and unrestricted SQL are not supported.
Exports are immutable, limited to 12 MiB each, allow at most three active
handles per database, and expire after 24 hours. Each start requires an
idempotency key; pages contain at most 100 items and fit within the 256 KiB
response bound. An expired handle returns `EXPORT_EXPIRED`.

The service enforces finite public capacity limits in addition to per-database
quotas. Defaults allow 32 databases, 512 MiB of logical data, 1 GiB of replay
outcomes, a 4 GiB aggregate reservation for database SQLite storage, and
64 MiB for the separate Registry/control store. Each database reserves up to
128 MiB of physical SQLite storage. Global admitted-work limits are 50,000
requests per UTC day, 1,000 per minute, and 5,000 mutations per UTC day; the
global export reservation is 128 MiB.

Per-database limits are 10 MiB of serialized live resource data, 1,000
requests per UTC day including at most 100 mutations, 60 requests per minute,
64 KiB request bodies, 256 KiB ordinary responses, and 100 MiB of returned
data per UTC day. Single-resource mutation results have a 255 KiB encoded
resource ceiling so MCP envelopes fit within the full-response limit. Daily
returned-byte accounting measures logical resource JSON and excludes transport
envelopes. These are configurable public service ceilings, not a guarantee
that provider ingress charges are bounded. Changes to capacity values require
an increased `CAPACITY_POLICY_REVISION`; a missing, invalid, or stale policy
fails closed. Operators can suspend service with the revisioned
`SERVICE_SUSPENDED` setting. Suspension pauses seven-day inactivity expiry but
does not extend the 30-day write window.

Databases become inaccessible after seven days without a successful data
operation. Successful reads, writes, and export start/read renew activity;
metadata reads, failed operations, and mutation replays do not. Expired data
stops serving before cleanup begins. Its physical reservation remains charged
until the SQLite Durable Object storage is deleted. Expired individual export
snapshots release their logical export reservation; their SQLite pages remain
covered by the database's physical reservation until database cleanup.

`GET /health` reports a provider-neutral readiness response after service
admission succeeds. A local build or test does not establish that a hosted
endpoint has been deployed or that a particular MCP client is compatible.

The planned direct MCP entry for Database is
`https://database.0000.chat/mcp`. This is a public routing target rather than
evidence of a deployed endpoint or an implicit permission grant. See the [MCP
topology contract](../../docs/architecture/mcp-topology.md) for the shared
hostname and path policy.

## Local smoke test

Install the exact service dependencies and start a local Cloudflare runtime:

```sh
pnpm install --frozen-lockfile
pnpm run dev
```

In a second terminal, create a database with a fresh 16-byte random key and
save the returned `databaseId` and `databaseUrl`:

```sh
KEY="$(openssl rand -hex 16)"
curl -i http://localhost:8787/v1/databases \
  -H 'content-type: application/json' \
  -H "Idempotency-Key: ${KEY}" \
  --data '{"name":"Local smoke test"}'
```

Repeat the request with the same key to confirm it returns the same database
link. Use that database ID to create a table and columns, then create and read a
record at `/v1/databases/{databaseId}/tables/{tableId}/records`. Point an MCP
client at `http://localhost:8787/mcp` to read the same record. The acceptance
test automates this flow and restarts Miniflare against the same SQLite
directory to verify persistence.

## Self-hosted remote smoke test

`pnpm run build` runs Wrangler's deploy dry-run and does not publish the
service. To smoke-test a self-hosted account, configure the Worker and SQLite
Durable Object migrations in that account, deploy it under your own authority,
and set `BASE_URL` to its HTTPS Worker URL. Repeat the database and record
requests against `${BASE_URL}/v1/...`, then call `${BASE_URL}/mcp` with your MCP
client and confirm both transports return the same record IDs and values.
Repeat reads after a Worker version rollout to check durable-state continuity.

This checkout has no managed Cloud staging endpoint or ChatGPT staging
consumer, so it does not claim a hosted ChatGPT connection test. Local Cloudflare
runtime tests and a dry-run build do not prove host-client compatibility.

Run `pnpm run check:application` for lint, formatting, type, runtime persistence,
and Wrangler dry-run checks. Run `bun run check` from the monorepo root for the
workspace wrapper.
