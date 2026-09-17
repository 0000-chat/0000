# 0000-brain

This service is located in the 0000 monorepo at services/brain. The monorepo
root owns the Bun and Turborepo workspace; this service keeps its own metadata,
validation scripts, and service-specific guidance.

The current delivery is a scaffold with metadata, documentation, local checks,
a pre-commit hook, and source-repository CI configuration. It has no
application implementation, service runtime, database, API, deployment
configuration, secret, or license.

A self-hosted deployment does not require a hosted 0000 account. Brain uses
the operator's Platform instance for common identity and authorizes its own
resources. Cloudflare is the public ingress and normal runtime class.

Run bun run check:application from this directory for the imported scaffold
validation. Run the root workspace checks from the monorepo root. Work on a
codex/ branch; direct commits on main are blocked after bootstrap.
