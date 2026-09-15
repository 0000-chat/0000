# Domain docs

This repository uses a single-context domain-doc layout.

## Read before exploring

Before exploring the codebase, read these files when they exist:

- `CONTEXT.md` at the repository root.
- Relevant ADRs under `docs/adr/`.

Proceed silently when either location does not exist. Do not suggest creating it upfront. The `/domain-modeling` skill creates domain documents when the team resolves terms or architectural decisions.

## File structure

```text
/
├── CONTEXT.md
├── docs/adr/
│   ├── 0001-example-decision.md
│   └── 0002-another-decision.md
└── src/
```

## Use glossary vocabulary

When output names a domain concept in an issue title, proposal, hypothesis, or test name, use the term defined in `CONTEXT.md`. Do not substitute a synonym that the glossary explicitly avoids.

If the glossary lacks the required concept, reconsider whether the term belongs to the project. Record a real vocabulary gap for `/domain-modeling`.

## Flag ADR conflicts

Explicitly identify output that contradicts an existing ADR:

> _Contradicts ADR-0007, but may warrant reopening because..._
