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
`./scripts/check`; direct commits on `main` are blocked after bootstrap.

## Agent skills

### Issue tracker

Issues are tracked in GitHub Issues for `0000-chat/0000-communicator`. See `docs/agents/issue-tracker.md`.

### Triage labels

The default five-role triage vocabulary is used. See `docs/agents/triage-labels.md`.

### Domain docs

This repository uses a single-context domain-doc layout. See `docs/agents/domain.md`.

### Wayfinding

When choosing the next product slice, defining a pilot boundary, or deciding
whether this is a pilot or a full product, read
`/home/ubuntu/0000-full/skills/ecosystem/wayfinder/SKILL.md` first. The
current migration leaves that scope decision open; keep
`docs/migration/wayfinder-draft.md` proposed until the human decision is
recorded.
