# Security

The 0000 bridge is public so users can inspect the local code that runs on
their machines before connecting an agent to 0000 Chat.

## Trust Model

- The bridge is a local process controlled by the user.
- The bridge authenticates to 0000 Chat with a pairing token stored locally.
- The bridge polls 0000 Chat over HTTPS for queued work and posts results back.
- The selected ACP runtime receives normal agent work and may emit transcript,
  tool-call, and tool-result events that are posted back to 0000 Chat.
- The selected ACP runtime is trusted with the bridge token when 0000 MCP helper
  tools are configured for that runtime.
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

Treat prompts, agent responses, tool calls, and tool results as potentially
sensitive. The bridge redacts operational logs, but normal agent events are the
product data needed for 0000 Chat to show and coordinate the agent run.

## Reporting Issues

Please report security concerns privately before public disclosure through
GitHub private vulnerability reporting for this repository. If that is
unavailable, contact the maintainers through the 0000 Chat project channels and
include:

- A short description of the issue.
- Steps to reproduce.
- The affected commit or release.
- Whether any secrets, prompts, local files, or account data may be exposed.

## Maintainer Checklist

- Keep dependencies minimal and visible.
- Prefer explicit, auditable network calls.
- Keep logs redacted by default.
- Keep normal event-data handling documented separately from operational logs.
- Document every file written outside the repository.
- Review install scripts for least privilege and predictable paths.
- Run `bun test` and `bun run typecheck` before merging bridge changes.
- Keep package-backed runtime examples pinned to exact versions.

## Revocation

Users can revoke bridge access by removing the bridge device in 0000 Chat,
stopping the local bridge process, and deleting `$HOME/.0000/bridge.json`.
See [Revoking Bridge Access](docs/revocation.md).
