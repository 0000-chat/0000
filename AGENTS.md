# 0000-communicator

This independent repository contains the communication adapter application and
its delivery-channel boundary. It is coordinated by `0000-full`, not embedded
application source.

The application history was migrated from the previous local Communicator
checkout. Treat `docs/migration/2026-09-12-communicator-migration.md` as the
handoff for preserved refs, dirty work, excluded local state, and pending
validation. Keep credentials, runtime databases, generated dependencies, and
other local state outside tracked files.

Standalone public components do not require hosted platform authentication.
Cloudflare is the public ingress and normal runtime class. Run
`./scripts/check`; it validates the imported application metadata and required
repository files. The pinned `scripts/lint` and `scripts/format-check` tools
remain available for reviewed cleanup work; the imported application currently
has a recorded pre-existing tooling baseline and the repository check does not
claim that baseline is clean. Direct commits on `main` are blocked after
bootstrap.

## Agent skills

### Issue tracker

Issues are tracked in GitHub Issues for `0000-chat/0000-communicator`. See `docs/agents/issue-tracker.md`.

### Triage labels

The default five-role triage vocabulary is used. See `docs/agents/triage-labels.md`.

### Domain docs

This repository uses a single-context domain-doc layout. See `docs/agents/domain.md`.

### Wayfinding

When choosing the next product slice, defining a pilot boundary, or deciding
the outbound route, read `/home/ubuntu/0000-full/skills/ecosystem/wayfinder/SKILL.md`
first and then follow the [WhatsApp pilot with reusable provider boundaries](https://github.com/0000-chat/0000-communicator/issues/1).

The pilot direction is settled: WhatsApp comes first, with provider boundaries
that support adding other providers shortly thereafter. Preserve and reconcile
the imported history recorded in `docs/migration/2026-09-12-communicator-migration.md`.
The map Notes allow execution because the user requested continuation. Execute
at most one nonresearch ticket per session. Use the map and named child tickets
for current acceptance, dependencies, and ticket order.
