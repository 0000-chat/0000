# Security

The 0000 bridge is public so users can inspect the local code that runs on
their machines before connecting an agent to 0000 Chat.

## Trust Model

- The bridge is a local process controlled by the user.
- The bridge authenticates to 0000 Chat with a pairing token stored locally.
- The bridge polls 0000 Chat over HTTPS for queued work and posts results back.
- The bridge should not contain private app/backend source code or generated
  server internals.
- Local config, status, tokens, and logs must stay out of git.

## Sensitive Data

Do not commit:

- Pairing tokens or bridge tokens.
- `~/.0000/bridge.json`.
- `~/.0000/bridge-status.json`.
- Local logs containing prompts, responses, file paths, or machine details.
- API keys, auth headers, cookies, or agent provider credentials.

## Reporting Issues

Please report security concerns privately before public disclosure. If GitHub
private vulnerability reporting is enabled for this repository, use that flow.
Otherwise, contact the maintainers through the 0000 Chat project channels and
include:

- A short description of the issue.
- Steps to reproduce.
- The affected commit or release.
- Whether any secrets, prompts, local files, or account data may be exposed.

## Maintainer Checklist

- Keep dependencies minimal and visible.
- Prefer explicit, auditable network calls.
- Keep logs redacted by default.
- Document every file written outside the repository.
- Review install scripts for least privilege and predictable paths.
- Run `bun test` and `bun run typecheck` before merging bridge changes.

