---
repo: 0000-chat/0000
status: current
---

# Public workspace guidance

Read the [workspace README](README.md), the affected service's README and
`AGENTS.md`, and the [architecture map](docs/architecture/README.md) before
changing a service boundary. Service documentation owns that service's scope
and interfaces.

Follow the [documentation conventions](docs/documentation.md). Use maintained
references and accepted decisions for current guidance. Drafts are proposals;
archived and superseded records are historical context. Update the owning
reference and affected indexes when a fact changes, then close its temporary
plan with a link to the maintained result.

Run `bun run check` and the affected service's checks before handing off a
change. Documentation checks validate repository ownership, lifecycle, and
naming; staged and publication checks inspect Git blobs. Review prose for
private content before publishing it.
