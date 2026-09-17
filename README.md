# 0000

This public repository is the 0000 monorepo. It contains the workspace
boundaries for six services and three shared packages, with Bun and Turborepo
pinned for repeatable outer workspace checks. `services/communicator` contains
the imported communication adapter application; the other service directories
remain scaffold placeholders.

## Service boundaries

Every reusable product service uses `0000-platform` for shared identity and
authentication. Platform is the single authority for accounts, credentials,
and user or organization access; services authorize their own resources.
`0000-streams` also requires `0000-database` at runtime for durable storage.
Those are product/runtime relationships, not npm workspace dependencies in
the outer workspace.

0000-brain is reserved for the wiki and knowledge service for people and
agents. Its imported scaffold and standalone source checks live in services/brain.
It is not a general agent execution service.

## Workspace commands

Requires Bun `1.3.14`.

```sh
bun install --frozen-lockfile
bun run check
bun run check:turbo
bun run check:turbo:dry
```

`check` validates the root and workspace manifests, discovered workspace
names, private publication safety, and retained directory markers.
`check:turbo` runs each workspace check through Turbo, including the
Communicator relocation and tooling check; `check:turbo:dry` only prints the
task graph. The Communicator application has its own nested pnpm workspace and
checks; see
[`services/communicator/README.md`](services/communicator/README.md).

The import procedure and preservation records are documented in
[`services/brain/docs/migration/2026-09-17-monorepo-import.md`](services/brain/docs/migration/2026-09-17-monorepo-import.md),
[`services/communicator/docs/migration/2026-09-15-monorepo-import.md`](services/communicator/docs/migration/2026-09-15-monorepo-import.md)
and [`docs/playbooks/import-service-repository.md`](docs/playbooks/import-service-repository.md).
