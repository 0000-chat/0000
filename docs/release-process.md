# Release Process

Public releases should be predictable and auditable.

## Rules

- Do not move published release tags.
- Use a new patch version for follow-up changes, such as `v0.1.2`.
- Run `bun test`, `bun run typecheck`, and `bun run sbom` before tagging.
- Wait for public CI to pass on `main`.
- Create a GitHub Release with a concise summary of user-visible changes.

## Provenance And Artifacts

Each CI run uploads `sbom.cdx.json` as an artifact. Release notes should link
the passing CI run and call out whether install behavior changed.

This repository does not currently publish binary artifacts. Users install from
source by cloning the public repository and running Bun.

## Checksums

If source archives or packaged artifacts are published later, include SHA-256
checksums in the release notes and do not replace artifacts in-place.
