# CLI access to connected chats

The user wants agents to operate the new chat features through the CLI and to
discover them from the agent notice/join flow. Preserve the implemented browser
and HTTP features and earlier localhost fixes; work inline in this checkout.

1. Add CLI commands: `create`, `branch`, `links`, `groups`. Branch creates a new
   chat with caller-selected context and links it to an existing source message.
   Explicit `post --reply-to ... --type result` returns a summary. Support content
   from stdin, existing signal behavior, strict option validation and JSON output.
2. Allow the production origin and literal loopback preview origins only; reject
   other hosts, credentials, queries, fragments, management URLs and redirects.
   Keep every operation on the selected origin. Creation is not automatically
   retried because the server's optional D1 idempotency can fail open. Preserve a
   created URL and exact link-recovery command if the second step fails.
3. Advertise connected-chat support in the Worker agent representation. Update
   `join` to display locally constructed commands and quoted untrusted connection
   metadata, without traversing other transcripts or launching another harness.
   A legacy server response remains usable and does not advertise new support.
4. Replace the browser notice's ROOM_URL placeholder with the actual quoted URL
   and a copy button. Local previews show the local built CLI command (from the
   repository root), since the published npm version does not yet have this work.
   Update agent instructions, CLI help and READMEs; publishing remains separate.
5. Validate with focused failing/passing CLI tests, real workerd + CLI integration,
   browser notice/copy checks and the required service `bun run check`.

Acceptance: an agent joining a supported room receives actionable CLI commands
for parallel/branched chats and group membership. It can complete those actions
against localhost, resume a failed link without duplicating a chat, and post an
explicit summary while keeping transcripts separate. No deployment/publication.

Validation completed:
- Focused CLI and representation tests passed after demonstrating failures first.
- The real workerd integration exercised create, branch, reciprocal links, groups,
  join discovery, and an explicit summary post through the CLI.
- The built Node CLI completed the same flow against the HTTP localhost preview
  using isolated sample chats; source and branch transcripts stayed separate.
- Browser inspection confirmed the exact current-room command and copy button.
  Clicking showed success; the automation clipboard could not read back its
  contents, so an actual clipboard round trip is not claimed.
- Full `bun run check` passed: 283 Worker, 18 tooling, 70 CLI, and 3 final package
  checks, plus lint/typechecks/build. Initial runs hit existing workerd broken-pipe
  timeouts in differing D1 tests; stopping the competing preview runtime let all
  eight isolated D1 tests and the full check pass without application changes.
- `git diff --check` passed. The npm package and Worker remain unpublished.
