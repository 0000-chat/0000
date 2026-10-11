---
repo: 0000-chat/0000
status: archived
---

# 0000-database monorepo import

Archived import provenance for the `database` service. The independent service
history was imported into `services/database` in the public monorepo. This
record describes repository migration, not production deployment.

Local checkout inventories, backup locations, session records, and operator
coordination details are retained privately. Public contributors need only this
repository and the service's documented tools and checks.

## Source provenance

Imported source commit: `b9c97a3a37b03589a456abd5010c51342e57d386`. The original
source and destination histories remain available through the monorepo import
ancestry.

## Provenance and validation

All twelve source issues were natively transferred, preserving their original
metadata and comments, and labeled `service:database`:

| Source | Destination |
| --- | --- |
| #1 | #37 |
| #2 | #38 |
| #3 | #39 |
| #4 | #40 |
| #5 | #41 |
| #6 | #42 |
| #7 | #43 |
| #8 | #44 |
| #9 | #45 |
| #10 | #46 |
| #11 | #47 |
| #12 | #48 |

There were no source pull requests or releases. Native transfer did not alter
the source history. The transferred map issue owns its transferred child
issues, and the recorded dependency edges remain present.

The current service-specific and root workspace checks are documented in the
service README. Rerun them when changing the imported service.
