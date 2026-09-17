# Issue tracker: GitHub

Gateway issues and specifications are tracked in the `0000-chat/0000`
monorepo. Use the `gh` CLI with `--repo 0000-chat/0000` and apply the
`service:gateway` label to Gateway issues.

The former source repository, `0000-chat/0000-gateway`, had no issues or pull
requests at the time of import. Do not recreate historical issue numbers.

Use the five shared triage labels in `triage-labels.md`. For routine issue
operations, use `gh issue create`, `gh issue view`, `gh issue list`,
`gh issue comment`, and `gh issue edit` with the destination repository.
GitHub shares one number space across issues and pull requests; resolve an
ambiguous `#number` with `gh pr view` and then `gh issue view`.

## Pull requests as a triage surface

PRs are not a feature-request surface for this service. Source PRs, if any,
remain at their original URLs; their changes are included only when the
selected source tip contains them.
