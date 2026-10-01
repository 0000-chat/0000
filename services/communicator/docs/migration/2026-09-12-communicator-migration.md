---
repo: 0000-chat/0000
status: archived
---

# Communicator migration history

Archived migration record dated 2026-09-12. The application history was imported
into the independent Communicator repository before its later monorepo import.

## Preserved technical provenance

- Destination scaffold base: `052efc6a19167da1619b822bf3e07fbbaa1ebb27`.
- Source main: `0541524cf6732463ccb2af17da9a6b734dc6d90e`.
- Integrated service-loop source: `46703ac2a34068eb987e9da7508fe9ad3aac6213`.
- Merge commits: `413dcd4` for source main and `613cdc8` for the integration line.

The import retained the Matrix service-loop implementation and technical plans,
reconciled README and ignore-file conflicts, and preserved the canonical
`0000-communicator` product identity. Original refs, local uncommitted work,
backup manifests, and workstation/session records were retained privately.

## Validation scope

The migration carried application and tooling state forward. It was not a live
Matrix deployment or acceptance test, and did not establish Platform identity
integration. Use the current service README and `scripts/check` for the present
validation baseline. The later [monorepo import](2026-09-15-monorepo-import.md)
records relocation into this repository.
