# Contributing

The public `0000` repository must remain buildable and testable without any
sibling checkout. Keep changes inside the public product boundary and run the
root checks before opening a pull request.

## Choose a top-level placement

Use this placement test for new code:

| Question | Place it in |
| --- | --- |
| Is it a user-facing application for the assembled product? | `apps/` |
| Is it an independently deployable runtime module? | `services/` |
| Is it reusable in-process code with more than one real consumer? | `packages/` |
| Is it generic local or self-hosted deployment material? | `deploy/` |
| Is it an example or contributor-facing explanation? | `examples/` or `docs/` |

An implementation-only module may remain nested inside its owning service. Do
not promote it to a root package until a second consumer makes that reuse real.
Private operations code, production configuration, credentials, and machine
specific coordination do not belong in this repository.

## Checks

From the repository root, run:

```sh
bun install --frozen-lockfile
bun run check
bun run check:topology
```

The topology checks reject private workspace references, imports, and lockfile
entries, as well as symlinks that resolve outside the repository. They also
verify that the current service dependency metadata agrees with the public
architecture.
