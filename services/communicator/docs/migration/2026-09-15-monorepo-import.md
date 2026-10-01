---
repo: 0000-chat/0000
status: archived
---

# Communicator monorepo import

Archived import provenance for the `communicator` service. The independent service
history was imported into `services/communicator` in the public monorepo. This
record describes repository migration, not production deployment.

Local checkout inventories, backup locations, session records, and operator
coordination details are retained privately. Public contributors need only this
repository and the service's documented tools and checks.

## Source provenance

Imported source commit: `a250f64f71a8a135fe394cc394c1ab35de886ccf`. The original source and destination
histories remain available through the monorepo import ancestry.

## Validation

- `bun install --frozen-lockfile` completed without changing the root lockfile.
- `bun run check` passed for all 9 outer workspace manifests.
- `bun run check:turbo` passed all 9 tasks; the Communicator task ran
  `./scripts/check`.
- `bun run check:turbo:dry` reported the same 9-task graph and command.
- `./scripts/check` passed Oxlint 1.82.0, Biome 2.5.13, and 367 checked files.
- `PYTHONDONTWRITEBYTECODE=1 TMPDIR=<root-filesystem-temp> python3 -m unittest discover -s tests -q`
  passed all 187 Python tests.

The full nested Rust and pnpm application check was not rerun during import;
the imported application and configuration files remain byte-identical outside
the documented relocation adaptations. The follow-up documentation commit
changed only agent guidance and destination issue URLs; no application
implementation changed. The nested check can rebuild the unchanged application
toolchain.

## GitHub migration result

All 36 issues were transferred natively to `0000-chat/0000`: 9 open and 27
closed, with all 166 comments preserved. Every issue has the
`service:communicator` label. The transfer required restoring 14 parent links
and one dependency link. Final content, parent, dependency, and child-list
verification found no mismatches. Issue references in bodies and comments
were updated using the recorded mapping.
