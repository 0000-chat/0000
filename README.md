# 0000

This public repository is the initial 0000 monorepo scaffold. It contains the
workspace boundaries for six services and three shared packages, with Bun and
Turborepo pinned for repeatable local and CI checks.

The scaffold has no service implementation, authentication, API, deployment
configuration, or product UI. The placeholder packages are private and have
no code dependencies until real imports and contracts are added.

## Service boundaries

Every reusable product service uses `0000-platform` for shared identity and
authentication. Platform is the single authority for accounts, credentials,
and user or organization access; services authorize their own resources.
`0000-streams` also requires `0000-database` at runtime for durable storage.
Those are product/runtime relationships, not npm workspace dependencies in
this scaffold.

`0000-brain` is reserved for the wiki and knowledge service for people and
agents. It is not a general agent execution service.

## Workspace commands

Requires Bun `1.3.14`.

```sh
bun install --frozen-lockfile
bun run check
bun run check:turbo
bun run check:turbo:dry
```

`check` validates the root and placeholder manifests, discovered workspace
names, private publication safety, and retained directory markers.
`check:turbo` runs that metadata check through Turbo across every workspace;
`check:turbo:dry` only prints the task graph. Neither command claims to build
or test application code.
