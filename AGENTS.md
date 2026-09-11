# 0000-database

This independent repository is the scaffold for the persistent-data boundary.
It is coordinated by `0000-full` but is not nested application code.

The scaffold contains metadata, documentation, a standard-library-only local
check wrapper, a pre-commit hook, and CI only. It contains no database, schema,
application source, package manifest, generated dependency tree, deployment
configuration, secret, or license.

Standalone public components do not require hosted platform authentication.
Cloudflare is the public ingress and normal runtime class. Run
`./scripts/check`; direct commits on `main` are blocked after bootstrap.

## Agent skills

### Issue tracker

Issues are tracked in this repository's GitHub Issues. See `docs/agents/issue-tracker.md`.

### Triage labels

The tracker uses the five default triage labels. See `docs/agents/triage-labels.md`.

### Domain docs

This repository uses the single-context layout. See `docs/agents/domain.md`.
