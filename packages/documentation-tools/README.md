---
repo: 0000-chat/0000
status: current
---

# Documentation tools

This package checks repository Markdown frontmatter from the working tree,
Git index, or a commit tree. The same pure validator powers the ESLint rule and
the Git index guard. It requires `repo` and `status` YAML scalars, keeps other
frontmatter fields intact, and applies the rules in the repository's
`.docs-policy.json`.

The `docs-check` executable requires a trusted identity from `--repo owner/repo`
or `GITHUB_REPOSITORY`; `.docs-policy.json` checks that identity but never
supplies it. The executable supports `--root <path>` for cached use, plus
`--mode worktree`, `--mode index`,
`--mode commit --commit <sha>`, `--mode published --base-ref origin/main
--head <sha>`, and `--mode pre-push`. Use `--root <path>` when the executable
runs outside the target checkout. When both `--repo` and `GITHUB_REPOSITORY`
are set, they must agree. For publication scans, `--base-ref` accepts a full
commit ID or a remote-tracking ref. An all-zero initial push base uses the
policy's `namingBaseline` and fails if that commit is unavailable. The pre-push
hook fetches `publicationBase` before scanning every commit introduced by the
push.

The policy is JSON with `schemaVersion: 1`, `expectedRepo`, a full-commit
`namingBaseline`, optional `publicationBase` (default `origin/main`),
`privatePathSegments`, and exact `deniedPaths` or `excludedPaths` entries of
`{ "path": "...", "reason": "..." }`. Path exceptions do not accept globs or
directory prefixes. The package exports `validateDocument` and the
`eslintPlugin`; the rule name is `documentation-tools/frontmatter`.

The package is installed from the deterministic tarball under
`release/documentation-tools.tgz`. It is a repository artifact rather than an
npm registry publication. Consumers install it with `npm ci --ignore-scripts`
inside an ignored cache.

The scanner handles `.md` and `.markdown` files case-insensitively. MDX is
explicitly unsupported: tracked `.mdx` files fail until an extension policy is
reviewed. Markdown exceptions are exact paths with a nonempty reason; glob or
directory exclusions are not supported.

Installing root dependencies runs the hook installer. It configures
`core.hooksPath=.githooks` only when no custom hook path is present; a
conflicting setting is left unchanged and reported as an error. Run
`node scripts/install-docs-hooks.mjs` to verify or install the hooks explicitly.
