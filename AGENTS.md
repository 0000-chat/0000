# 0000-platform

This repository is the scaffold for the shared platform boundary. It is an
independent repository, not a package inside `0000-full`.

The current delivery contains metadata, documentation, a local check, a
pre-commit hook, and CI only. It contains no application source, package
manifest, generated dependency tree, database, API, deployment configuration,
secret, or license.

Standalone public components do not require hosted platform authentication.
When application code is added, this boundary can expose an authentication
adapter without choosing a provider in this scaffold.

Run `./scripts/check` from this repository before committing. Work on a task
branch; direct commits on `main` are blocked after bootstrap.

## Agent skills

### Issue tracker

Issues and specs are tracked in this repository's GitHub Issues. See `docs/agents/issue-tracker.md`.

### Triage labels

Triage uses the five default canonical labels. See `docs/agents/triage-labels.md`.

### Domain docs

This repository uses a single-context layout. See `docs/agents/domain.md`.
