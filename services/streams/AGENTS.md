# 0000-streams

This directory contains the Streams service in the public `0000` monorepo.
Read the root `AGENTS.md` for workspace-wide rules. Git commands from this
directory use the monorepo root.

The service's canonical metadata requires `0000-database` for durable storage.
The imported application currently stores records in a Cloudflare Durable
Object backed by SQLite; database integration has not been verified. The
Worker exposes browser, API, and MCP surfaces. Browser requests use Cloudflare
Access, while MCP requests use the configured bearer token; a hosted 0000
account is not required. The Wrangler route and migration configuration are
present, but deployment has not been verified. No license has been selected.
Keep product metadata canonical as `0000-streams`; the Bun workspace package is
`@0000/streams`.

Cloudflare is the public ingress and normal runtime class. The monorepo root
owns the Bun and Turborepo workspace checks. The `check` package script
validates the service wrapper; `check:application` runs application lint,
format, type, and tests from this directory.

## Agent skills

### Issue tracker

Issues for this service are tracked in `0000-chat/0000` and use the
`service:streams` label. See `docs/agents/issue-tracker.md`.

### Triage labels

The tracker uses the five default triage labels. See `docs/agents/triage-labels.md`.

### Domain docs

This repository uses the single-context layout. See `docs/agents/domain.md`.
