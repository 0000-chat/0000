# 0000-cloud

This service directory is the future coordination point for hosted deployment
of the independent 0000 repositories. It is coordinated by `0000-full` and is
not a place for application code in this scaffold.

Cloudflare is the public ingress and normal runtime class. Future software that
requires Docker runs on a private provider-neutral Docker host (DigitalOcean
is only an example); that host does not expose a public product API. This
directory coordinates hosted deployment later and currently contains no
deployment implementation, application package manifest, generated dependency
tree, database, API, secret, or license.

Run `bun run check:application` for this scaffold. Make changes on a `codex/`
branch in the monorepo; direct commits on `main` are blocked.

## Agent skills

### Issue tracker

Issues and specs are tracked in this repository’s GitHub Issues. See `docs/agents/issue-tracker.md`.

### Triage labels

The five canonical triage roles use their default label names. See `docs/agents/triage-labels.md`.

### Domain docs

This repository uses a single-context domain-doc layout. See `docs/agents/domain.md`.
