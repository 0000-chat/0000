# 0000-database

This directory contains the `0000-database` service inside the public `0000`
monorepo. The monorepo root owns Bun and Turbo workspace checks; this service
retains its pnpm tooling and service-local validation.

The imported scaffold contains metadata, documentation, a local check wrapper,
development-only quality tooling, a pre-commit hook, and CI only. It contains
no database, schema, application source, runtime dependency tree, deployment
configuration, secret, or license. The canonical product metadata name remains
`0000-database` although the workspace wrapper is `@0000/database`.

Standalone public components do not require hosted platform authentication.
Cloudflare is the public ingress and normal runtime class. Run
`pnpm run check:application` for the imported service and root `bun run check`
for the monorepo wrapper. Make changes on a feature branch in the monorepo.

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
