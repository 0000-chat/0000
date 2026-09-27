# Contributing to 0000

This repository contains the complete public, self-hostable 0000 product. A
public pull request must build and test without access to `0000-cloud` or any
sibling checkout.

## Choose a top-level placement

Use this placement test for new code:

| Question | Place it in |
| --- | --- |
| Is it a user-facing application for the assembled product? | `apps/` |
| Is it an independently deployable runtime module? | `services/` |
| Is it reusable in-process code with more than one real consumer? | `packages/` |
| Is it generic local or self-hosted deployment material? | `deploy/` |
| Is it an example or contributor-facing explanation? | `examples/` or `docs/` |

Keep product behavior, first-party agents, reusable integrations, SDKs, and
self-hosting changes in this repository. An implementation-only module may
remain nested inside its owning service; do not promote it to a root package
until a second public consumer makes that reuse real.

Provider interfaces and adapters that support user-owned credentials are
public. Put an adapter inside the service that owns the capability, or in a
root package once it has multiple consumers. Platform owns credential and
identity authority, but that does not make every provider adapter part of
Platform.

## Keep private operations in `0000-cloud`

Fleet management, managed credential custody, internal support tooling,
commercial operations, and private production configuration belong in
`0000-cloud`. Public product code must not depend on Cloud, a private package,
a sibling path, or a local filesystem checkout.

If Cloud operations expose a defect in public product code, fix it in this
repository and publish a new immutable release for Cloud to consume. Keep a
fix private only when the defect exists solely in private operations.

## Run public checks

Install Bun `1.3.14`, then run:

```sh
bun install --frozen-lockfile
bun run check
bun run check:topology
bun run check:turbo
bun run check:turbo:dry
```

The topology checks reject private workspace references, source imports, and
lockfile entries, as well as symlinks that resolve outside the repository.
They allow documentation to describe the public/private architecture. These
checks must pass from a clean public checkout without `0000-cloud`.
