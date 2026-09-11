# Domain docs

This repository uses a single-context domain documentation layout.

## Read before exploring

Read these files when they exist:

- `CONTEXT.md` at the repository root
- Relevant ADRs under `docs/adr/`

Proceed silently when either location is absent. Do not propose creating these files before they are needed. The `/domain-modeling` skill creates them when the project resolves domain terms or architectural decisions.

## File structure

```text
/
├── CONTEXT.md
├── docs/adr/
│   ├── 0001-example-decision.md
│   └── 0002-another-decision.md
└── src/
```

## Use the glossary's vocabulary

Use terms defined in `CONTEXT.md` when naming domain concepts in issue titles, refactor proposals, hypotheses, and tests. Do not substitute synonyms that the glossary rejects.

If a needed concept is absent, reconsider whether the project uses that concept. If it reveals a real vocabulary gap, record it for `/domain-modeling`.

## Flag ADR conflicts

Call out any proposal that contradicts an existing ADR. Name the ADR and explain why the decision may need to be reconsidered.
