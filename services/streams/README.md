# 0000-streams

This directory contains the `0000-streams` service inside the public `0000`
monorepo. It includes the imported Worker application and retains the service
metadata and validation tools. The monorepo root owns the Bun and Turborepo
workspace; this service package keeps the `@0000/streams` workspace identity.

Streams provides the boundary for ordered streams of events or records. The
canonical product metadata requires `0000-database` for durable storage; the
imported implementation currently stores records in a Cloudflare Durable
Object backed by SQLite. That database integration has not been verified.

The Worker exposes browser, API, and MCP surfaces. Browser requests use
Cloudflare Access, while MCP requests use the configured bearer token. A hosted
0000 account is not required. Cloudflare is the public ingress and runtime
class. The Wrangler route and migration configuration are present, but this
service's deployment has not been verified. No license has been selected.

From the monorepo root, run the workspace checks:

```sh
bun install --frozen-lockfile
bun run check
bun run check:turbo
bun run check:turbo:dry
```

From this directory, `bun run check` validates the service workspace wrapper.
Run `bun run check:application` for lint, formatting, type, and application
tests. The application tests include a Wrangler dry-run bundle check.
