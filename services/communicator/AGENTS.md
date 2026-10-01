---
repo: 0000-chat/0000
status: current
---

# 0000-communicator

This directory contains the `0000-communicator` service inside the public
`0000` monorepo. It retains the imported application and its delivery-channel
boundary as a nested pnpm workspace. The monorepo root owns the Bun/Turbo
workspace checks; run service commands from this directory.

The application history was migrated from the previous local Communicator
checkout. Treat `docs/migration/2026-09-12-communicator-migration.md` as the
public provenance and validation summary. Keep credentials, runtime databases, generated dependencies, and
other local state outside tracked files. The canonical product metadata name
remains `0000-communicator`, even though the service directory is named
`communicator`.

The monorepo import record is
`docs/migration/2026-09-15-monorepo-import.md`; use it for the source ref and
public validation details.

Standalone public use does not require a hosted 0000 account. Communicator
uses `0000-platform` for common identity and authentication. Cloudflare is the
public ingress and normal runtime class. Run `./scripts/check` for the
relocated application and tooling check. Run
`pnpm run check:application` for the full nested Rust and pnpm workspace check.
The imported application currently has a recorded pre-existing tooling
baseline, so a check failure in those tools must be reconciled through
reviewed cleanup. Make changes on a feature branch in the monorepo.

## Agent skills

### Issue tracker

Current service work is tracked in GitHub Issues for `0000-chat/0000` using the
`service:communicator` label. The imported source issue map is anchored at
[WhatsApp pilot with reusable provider boundaries](https://github.com/0000-chat/0000/issues/1);
historical source issue references remain in imported documentation until each
mapped destination ticket is updated. See
`docs/agents/issue-tracker.md`.

### Triage labels

The default five-role triage vocabulary is used. See `docs/agents/triage-labels.md`.

### Domain docs

This repository uses a single-context domain-doc layout. See `docs/agents/domain.md`.

### Choosing work

Read the service README, product alignment, and the
[WhatsApp pilot with reusable provider boundaries](https://github.com/0000-chat/0000/issues/1)
before choosing a product slice. Identify the acceptance criteria, dependencies,
and smallest independently verifiable change. Use the current issue and its
child tickets for execution order; historical plans are design evidence.
Keep provider boundaries reusable and verify the public service without access
to private infrastructure or operational records.
