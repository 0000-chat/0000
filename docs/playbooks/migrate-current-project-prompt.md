---
repo: 0000-chat/0000
status: current
---

# Reusable service migration prompt

Migrate the current project into the 0000 monorepo following
[the import playbook](import-service-repository.md). Infer the source repository
and destination service name from the checkout, and confirm the destination
against its README and workspace policy. Preserve history, branches, and local
work through verified private backups. Reconcile existing destination content
and run appropriate checks. Record public provenance and validation separately
from private checkout, backup, and session details. Retain the source checkout
and backups until cutover is verified. Publish or merge only within the user's
authorized scope.
