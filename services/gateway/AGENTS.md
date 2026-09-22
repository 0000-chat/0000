# 0000-gateway

This directory contains the gateway service inside the public `0000` monorepo.
The service remains scaffold-only; it has no application implementation,
database, API, deployment configuration, secret, or selected license. It uses
the shared `0000-platform` implementation for common identity and
authentication when runtime code is added. The service may compose the
Executor SDK later, but it does not fork or vendor Executor.

The root Bun and Turborepo workspace owns monorepo validation. Run
`bun run check`, `bun run check:turbo`, and `bun run check:turbo:dry` from the
monorepo root. Gateway source and tooling checks are exposed as
`check:application`; first run `pnpm --dir services/gateway/tooling install
--frozen-lockfile` from the monorepo root, then run
`pnpm --dir services/gateway run check:application`.

Standalone public components do not require hosted platform authentication.
Cloudflare is the public ingress and normal runtime class. Make changes on a
feature branch in the monorepo; do not commit directly to `main`.

## Agent skills

### Issue tracker

Gateway issues are tracked in `0000-chat/0000` with the `service:gateway`
label. See `docs/agents/issue-tracker.md`.

### Triage labels

Use the five default triage labels in `docs/agents/triage-labels.md`.

### Domain docs

This service uses a single-context domain-doc layout. See
`docs/agents/domain.md`.
