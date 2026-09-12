# 0000-communicator

This independent repository contains the communication adapter application
coordinated by `0000-full`. Communicator connects Matrix-derived messaging
events to tenant-scoped application state. Synapse remains the operational
messaging record, R2 holds the immutable replay archive, and one SQLite
Durable Object per tenant holds a rebuildable projection. The ingestion Queue
carries only a pointer to a committed R2 batch.

## Start here

- [Local Matrix ingestion runbook](docs/runbooks/matrix-ingestion-local.md)
- [Control Directory local runbook](docs/runbooks/control-directory-local.md)
- [R2 archive local runbook](docs/runbooks/r2-archive-local.md)
- [Tenant projection local runbook](docs/runbooks/tenant-projection-local.md)

## Local setup and checks

The workspace requires Node `>=24 <27` and pnpm `10.14.0`.

Docker is not needed for the focused Cloudflare Worker ingestion exercise.
Full repository verification also requires Docker Engine and Docker Compose v2:
`pnpm test:python` includes bridge contract tests that invoke `docker compose
config`.

```sh
pnpm install --frozen-lockfile
./scripts/check
pnpm check
pnpm test
pnpm test:python
```

For the ingestion Worker tests:

```sh
pnpm --filter @communicator/control-plane test:worker
```

The command above and the focused ingestion commands in the runbook use only
the local Worker test runtime; they do not require Docker. Install Docker
Engine and Docker Compose v2 before the full `pnpm test:python` gate.

The local Wrangler configuration keeps `COMMUNICATOR_INGRESS_ENABLED` false
and uses simulated data. Tests use fake fixtures and local Worker bindings.
They never call Matrix, Synapse, another provider, or a live Cloudflare
resource. Do not use `wrangler deploy`, `--remote`, production resources, or
live Matrix credentials for this local work.

The Matrix Gateway decrypts E2EE on a VPS and sends normalized, one-tenant
batches to the private ingestion endpoint. Session, device, access, and other
Matrix keys stay on that VPS and never enter Cloudflare.

Cloudflare is the public ingress and normal runtime class. Standalone public
components do not require hosted platform authentication.
