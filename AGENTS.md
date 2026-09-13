# 0000-cloud

This private repository is the future coordination point for hosted deployment
of the independent 0000 repositories. It is coordinated by `0000-full`, not a
place for application code in this scaffold.

Cloudflare is the public ingress and normal runtime class. Future software that
requires Docker runs on a private provider-neutral Docker host (DigitalOcean
is only an example); that host does not expose a public product API. This
repository coordinates hosted deployment later and currently contains no
deployment implementation, package manifest, generated dependency tree,
database, API, secret, or license.

Run `./scripts/check`; it validates metadata, formats supported files with
Biome, and lints supported JavaScript and TypeScript files with pinned tools.
Direct commits on `main` are blocked after bootstrap.

## Agent skills

### Issue tracker

Issues and specs are tracked in this repository’s GitHub Issues. See `docs/agents/issue-tracker.md`.

### Triage labels

The five canonical triage roles use their default label names. See `docs/agents/triage-labels.md`.

### Domain docs

This repository uses a single-context domain-doc layout. See `docs/agents/domain.md`.
