# 0000-brain

This independent repository is the scaffold for future reasoning and
orchestration components. It is coordinated by `0000-full`, not a monorepo
subdirectory.

The current delivery contains metadata, documentation, a local check, a
pre-commit hook, and CI only. It contains no application source, package
manifest, generated dependency tree, database, API, deployment configuration,
secret, or license.

Standalone public components do not require hosted platform authentication.
Cloudflare is the public ingress and normal runtime class. Run
`./scripts/check`; it validates metadata, formats supported files with Biome,
and lints supported JavaScript and TypeScript files with pinned tools. Direct
commits on `main` are blocked after bootstrap.
