# 0000-communicator

This independent repository is the scaffold for communication adapters and
delivery channels. It is coordinated by `0000-full`, not embedded application
source.

The current delivery contains metadata, documentation, a local check, a
pre-commit hook, and CI only. It contains no application source, package
manifest, generated dependency tree, database, API, deployment configuration,
secret, or license.

Standalone public components do not require hosted platform authentication.
Cloudflare is the public ingress and normal runtime class. Run
`./scripts/check`; it validates metadata, formats supported files with Biome,
and lints supported JavaScript and TypeScript files with pinned tools. Direct
commits on `main` are blocked after bootstrap.

## Agent skills

### Issue tracker

Issues are tracked in GitHub Issues for `0000-chat/0000-communicator`. See `docs/agents/issue-tracker.md`.

### Triage labels

The default five-role triage vocabulary is used. See `docs/agents/triage-labels.md`.

### Domain docs

This repository uses a single-context domain-doc layout. See `docs/agents/domain.md`.
