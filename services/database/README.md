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

`0000-database` aims to give 0000 products and services a dependable home for
their durable data. The product boundary uses `0000-platform` for common
identity and authentication; standalone use does not require a hosted 0000
account. `0000-streams` depends on this service. Database is responsible for
durable storage and retrieval, clear data ownership and lifecycle, consistent
access, and data integrity. It is not responsible for user experiences,
communication channels, reasoning, or coordinating the hosted platform.

Platform identity integration is not part of this increment. Instead, the pilot
uses shared high-entropy bearer database links: anyone with a link can read
data and, during the write window, change it. Do not store sensitive
information. There is no database directory, database deletion route, user
login, or ownership credential in this pilot.

The implemented REST and MCP operations create and read databases, tables,
columns, and records; record updates and deletes use version preconditions.
Mutations use idempotency keys, and REST/MCP retries share the same stored
outcome. List routes use bounded pages with opaque cursors. Table/column
destructive changes, indexes, exports, whole-database administration, and
unrestricted SQL are outside this increment.

The provisional per-database limits are 10 MiB of serialized live resource
data, 1,000 requests per UTC day including at most 100 mutations, 60 requests
per minute, 64 KiB request bodies, 256 KiB ordinary responses, and 100 MiB
returned data per UTC day. Databases stop accepting writes 30 days after
creation and become inaccessible after seven days without a successful record
read or committed mutation. Reads, writes, and counters are shared by every
holder of the link. Single-resource mutation results have a 255 KiB encoded
resource ceiling so routine MCP envelopes fit within the 256 KiB full-response
cap. Daily returned-byte accounting measures logical resource JSON and excludes
transport envelopes. Global admission, physical expiry cleanup, bounded export
capacity, and hosted suspension controls are still launch gates; the pilot
does not claim public-service readiness.

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
