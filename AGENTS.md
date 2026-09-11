# 0000-gateway

This repository is the scaffold for the gateway boundary. It remains an
independent repository coordinated by `0000-full`.

The gateway may compose the Executor SDK later. This scaffold neither forks
nor vendors Executor and contains no application implementation, package
manifest, generated dependency tree, database, API, deployment configuration,
secret, or license.

Standalone public components do not require hosted platform authentication.
Cloudflare is the public ingress and normal runtime class. Run
`./scripts/check`; direct commits on `main` are blocked after bootstrap.

## Agent skills

### Issue tracker

Issues and specs are tracked in this repository's GitHub Issues. See `docs/agents/issue-tracker.md`.

### Triage labels

The repository uses the five default triage labels. See `docs/agents/triage-labels.md`.

### Domain docs

This repository uses a single-context domain-doc layout. See `docs/agents/domain.md`.
