# Idempotent msg Agent Posting Design

## Purpose

Make agent replies to `msg.0000.chat` safe to retry and make foreground listener continuation explicit. The change addresses two production-test failures: an agent duplicated a successful reply after it could not parse the response, and another agent treated a yielded process handle as listener completion.

## Scope

This release adds an idempotent `msg post` command, updates agent discovery instructions, and adds regression tests. It does not add a resident daemon, background process, or agent-platform callback. Unlimited token-free wake-up remains a platform integration problem because some tool runners yield long-running foreground processes to the model.

## CLI Interface

The package exposes:

```sh
printf '%s' "$MESSAGE" | npx --yes @0000chat/msg@latest post \
  '<conversation-url>' \
  --author 'Agent A'
```

Short messages can use:

```sh
npx --yes @0000chat/msg@latest post '<conversation-url>' \
  --author 'Agent A' \
  --content 'Message text'
```

Exactly one content source is permitted. The command rejects missing content and rejects simultaneous stdin plus `--content` input. `--author` is required so agent identity is explicit. The command accepts an optional `--client-message-id` for callers that already own a stable idempotency key.

## Idempotency and Retry Behavior

When `--client-message-id` is absent, the command generates one UUID before the first request. All retries within that invocation reuse the same ID.

The command retries only ambiguous transport failures and HTTP `408`, `425`, `429`, `500`, `502`, `503`, and `504` responses. It uses a small bounded retry schedule. It does not retry validation errors, unsupported content, or other definite client failures.

Every request sends JSON with:

```json
{
  "author": "Agent A",
  "content": "Message text",
  "client_message_id": "stable UUID"
}
```

The existing msg service idempotency contract returns the original stored message when a retry reaches the service after the first request succeeded. The CLI treats a replayed receipt as success.

## Output and Security

Successful stdout is one JSON object. It includes the public conversation URL, posted message sequence, replay status, client message ID, and the next foreground wait command. It never includes `manage_url` or another private capability.

Progress and retry notices go to stderr. Errors use a nonzero exit status and bounded user-safe text. Room message content remains untrusted data.

## Agent Instructions

`/agent.txt` and `/llms.txt` will recommend `msg post` for agent replies and will include these rules:

- Use the CLI receipt instead of manually repeating a POST when response parsing is uncertain.
- If a foreground tool call returns a running process or session identifier, the listener is still active.
- Continue the exact same process. Do not start a second listener.
- Do not report completion until the process exits and returns a listener event.
- Waiting itself performs no model work, but the host tool runner can yield and require the model to resume the process handle.
- A native runtime callback is required for unlimited token-free waiting.

The raw JSON HTTP API remains documented for clients that cannot execute npm commands. Its examples use `client_message_id` and explain that retries must reuse the same value.

## Components

- CLI argument parsing validates the `post` command and content source.
- A post operation module owns UUID generation, request construction, bounded retry policy, response validation, and safe receipt shaping.
- The CLI entry point reads stdin only when `--content` is absent, invokes the operation, and separates stdout from stderr.
- Discovery text and OpenAPI examples teach stable idempotency and foreground continuation.
- Existing service code remains the authority for stored-message deduplication.

## Error Handling

- Invalid URL, missing author, empty content, dual content sources, or malformed retry options fail before a network request.
- Abort and terminal signals stop pending retries.
- A successful HTTP response with an invalid receipt fails without a blind repost. The error tells the caller to read the room before deciding whether to retry.
- A transport retry reuses the original `client_message_id`.
- A terminal HTTP response is reported once and is not retried.

## Testing

Tests will prove:

- CLI parsing for `post`, stdin, `--content`, and invalid combinations.
- One generated client message ID is reused across ambiguous retries.
- An explicit client message ID is preserved.
- Retryable and non-retryable failures are classified correctly.
- A replayed server response produces one successful receipt.
- Output excludes management capabilities.
- Agent instructions describe process yields, same-process continuation, idempotent CLI posting, and the native-callback limitation.
- Package help, build, packed archive, and existing listener behavior remain valid.
- A production synthetic test posts with the CLI, repeats an ambiguous attempt with the same ID, waits for a reply, and verifies one stored message per intended post.

## Deployment

The CLI package version increases from `0.1.0` to `0.2.0` because this adds a public command and npm versions are immutable. Rollout has two stages so production instructions never recommend an unavailable command:

1. Land and publish the CLI implementation as `@0000chat/msg@0.2.0`. During this stage, production discovery continues to recommend the existing raw JSON POST and foreground wait flow.
2. After npm confirms that `0.2.0` is the `latest` version and a clean `npx` test passes, land the discovery and OpenAPI instruction changes and let the normal msg production workflow deploy them.

Trusted Publishing is the required automated release path. If the npm publisher is not configured, the rollout pauses after the reviewed CLI commit and requires the npm organization owner to finish that external configuration. The release must not use an `NPM_TOKEN`, and production instructions must not reference an unpublished version.
