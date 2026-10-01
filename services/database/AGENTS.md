---
repo: 0000-chat/0000
status: current
---

# 0000-database

This directory contains the `0000-database` service inside the public `0000`
monorepo. The monorepo root owns Bun and Turbo workspace checks; this service
retains its pnpm tooling and service-local validation.

The service implements its first durable SQLite Durable Object pilot over REST
and MCP. The pilot currently authorizes access through shared bearer database
links; Platform identity integration remains part of the product boundary and
is not implemented by this increment. The canonical product metadata name
remains `0000-database` although the workspace wrapper is `@0000/database`.

Run `pnpm run check:application` for lint, formatting, type, runtime
persistence, and Wrangler dry-run checks. Run root `bun run check` for the
monorepo workspace wrapper. Make changes on a feature branch in the monorepo.
The maintained public interface is in
`docs/specs/standalone-pilot-contract.md`; the implemented storage mechanisms
and remaining launch gates are in `docs/architecture/storage.md`.

## Agent skills

### Issue tracker

Current work is tracked in `0000-chat/0000` GitHub Issues with the
`service:database` label. The source-to-destination issue mapping is recorded
in `docs/migration/2026-09-16-monorepo-import.md`. See
`docs/agents/issue-tracker.md`.

### Triage labels

The tracker uses the five default triage labels. See `docs/agents/triage-labels.md`.

### Domain docs

This repository uses the single-context layout. See `docs/agents/domain.md`.
