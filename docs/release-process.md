# Release Process

Public releases should be predictable and auditable.

## Rules

- Do not move published release tags.
- Use a new patch version for follow-up changes, such as `v0.1.2`.
- Run `bun test`, `bun run typecheck`, `bun run sbom`, and
  `bun run observability:check` before tagging.
- Wait for public CI to pass on `main`.
- Create a GitHub Release with a concise summary of user-visible changes.
- Complete the [release checklist](release-checklist.md).

## Provenance And Artifacts

Each CI run uploads `sbom.cdx.json` as an artifact. Release notes should link
the GitHub Release, passing CI run, SBOM artifact or committed SBOM reference,
source tag, and source commit SHA. They should call out whether install, update,
runtime discovery, or host contract behavior changed.

This repository does not currently publish binary artifacts. Users install from
source by cloning the public repository and running Bun. Release notes should
explicitly say when a release is source-only and there are no binary assets or
checksums.

## Checksums

If source archives or packaged artifacts are published later, include SHA-256
checksums in the release notes and do not replace artifacts in-place.
