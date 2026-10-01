---
repo: 0000-chat/0000
status: current
---

# Documentation conventions

## Ownership

Each service owns its scope, architecture, and interfaces under
`services/<service>/docs/`. The [architecture map](architecture/README.md)
links to those owners. Cross-service decisions belong under
`docs/architecture/decisions/`. Update affected service indexes when a shared
contract changes. Link to a fact's owner instead of copying that fact.

Public guidance must be sufficient for contributors and self-hosters. Keep
private strategy, operator identities, customer plans, and hosted operating
records in their private owner repositories. Repository metadata records
declared ownership; owners still review the content before publication.

## Metadata and lifecycle

Every tracked first-party Markdown file starts with YAML frontmatter:

```yaml
---
repo: 0000-chat/0000
status: current
---
```

Keep any other metadata required by the file's consumer. Use the full canonical
repository slug. Use `current` for maintained references and indexes, `draft`
for proposed work, `accepted` for recorded decisions in decision directories,
`superseded` for replaced guidance, and `archived` for historical evidence.

Read current references and accepted decisions to understand the system. A
draft is a proposal. Superseded and archived documents are historical context;
do not execute their instructions as current work. A superseded document links
to its replacement. Close a temporary plan by archiving it and linking to the
maintained document or decision that records its outcome.

## Names and writing

Use `README.md` for an index, stable lowercase kebab names for maintained
topics, `plans/YYYY-MM-DD-topic.md` for plans, and
`decisions/NNNN-topic.md` for decisions. Existing paths are grandfathered by
the migration baseline; their metadata still must be valid. Avoid `final`,
`latest`, and version suffixes as status markers.

Give each document one purpose. State the scope, distinguish proposed behavior
from implemented behavior, and link claims to their code, checks, or decision
owner. Record open questions as questions. Keep dated verification outcomes
with historical evidence rather than treating them as permanent product facts.

## Checks

Run `bun run check:docs` for document validation and ESLint feedback. The
pre-commit gate checks staged blobs; the pre-push gate checks every newly
published commit. A document deleted in a later commit still needs to pass in
the earlier commit. CI fetches complete history and runs the same checks.

The [documentation tools](../packages/documentation-tools/README.md) describe
the validator, policy configuration, artifact, and hook setup. Local ignored
agent overrides and private links are rejected if forced into Git's index.
