---
repo: 0000-chat/0000
status: archived
---

# Room webhook configuration upgrade

The maintained result is the [room notifications
specification](../specs/room-notifications.md), with configuration examples in
the [service README](../../README.md) and generated HTTP and agent contracts
in [discovery.ts](../../worker/src/discovery.ts).

Implement vendor-neutral receiver configuration in the Msg Worker. Keep the
existing event fields, HMAC signing format, retries, explicit redelivery,
disable and enable behavior, and signing-secret rotation.

## Contract

- Extend `POST /{room}/webhooks` with optional `headers`, `prompt`, and
  `exclude_authors`. Add `PATCH /{room}/webhooks/{id}` for partial updates of
  `url` and those fields. Omitted fields remain unchanged. Empty headers and
  exclusion lists clear them; `prompt: null` clears the prompt. Reject empty
  updates and unknown fields. Extend MCP `create_webhook` and add
  `update_webhook` with the same semantics.
- Accept header names case-insensitively, reject duplicate spellings, invalid
  HTTP tokens, hop-by-hop and routing headers, and headers reserved by Msg's
  content type and signature protocol. Accept `Authorization`. Reject invalid
  values and control characters without echoing input. Limit configuration to
  16 headers, 128 bytes per name, 4 KiB per value, and 16 KiB in total. Bound
  the complete HTTP and MCP mutation before parsing or returning errors.
- Treat every header value as write-only. Responses expose only
  `header_names`, including create and update receipts. Never include values
  in endpoint metadata, browser output, exports, telemetry, or errors. Keep
  remote response bodies out of delivery metadata and logs.
- Reuse the service's AES-GCM record encryption and
  `MSG_DATA_ENCRYPTION_KEY_V1`, with authenticated context scoped to the room
  and endpoint. Existing webhook signing secrets are currently plaintext.
  Encrypt new signing secrets when the key is available and migrate legacy
  secrets without changing their HMAC value. Header writes require a valid
  key and fail closed. Preserve existing URL-only webhook operation where
  encryption was not configured. Do not introduce another key or a new
  production deployment requirement for existing URL-only consumers.
- Add `summary`, `room_url`, `seq`, `author`, `semantic_type`, and `content`
  beside the existing payload fields. Include `prompt` only when configured,
  passing its exact string through. Limit prompt text to 4 KiB. Msg has no
  stored room name, so the summary uses the author and canonical room ID.
- Accept up to 50 exclusions, each bounded by Msg's author identifier limit.
  Match the stored author and display name using the room's established name
  normalization. Skip matching authors before automatic queue creation.
  Filter updates affect new queue entries and preserve retries and explicit
  redelivery of retained events.
- Destination, header, prompt, and signing-secret updates apply to future
  outbound attempts. Preserve event identity and sequence on retry or
  redelivery. Protect existing disable and rotation behavior when an update
  overlaps signing, decryption, or dispatch.

## Tasks and files

1. Implement validation and encrypted endpoint configuration in
   `worker/src/webhooks.ts`, `webhook-policy.ts`, `room-schema.ts`, and
   `conversation-room.ts`, adding a small crypto module only if needed.
2. Extend protocol types and service delegation in `worker/src/protocol.ts`
   and `room-service.ts`. Wire HTTP and MCP mutations in `worker.ts` and
   `mcp.ts`. Keep input failures generic so schema errors cannot echo values.
3. Extend real room and Worker integration coverage in webhook, schema,
   service, HTTP, MCP, and Miniflare tests. Adjust test fixtures only inside
   this worktree. Use synthetic credentials in tests.
4. Update the generated `/openapi.json` and `/agent.txt` contracts in
   `worker/src/discovery.ts`, the service README, the owning webhook
   reference, and affected indexes. Document an `Authorization` example
   using a placeholder and vendor-neutral receiver language.
5. Review implementation and public prose, run root and Msg checks, archive
   this plan with a link to the maintained reference, commit, push this
   branch, and open a PR. Monitor CI and address failures. Never merge or
   deploy. Write the requested job report outside the repository.

## Acceptance tests

- Create and update a webhook over HTTP and MCP. Assert replace, preserve,
  and clear semantics, room scoping, missing IDs, malformed input, request
  limits, header count and byte boundaries, and excluded reserved names.
- A local receiver observes its configured Authorization header and exact
  prompt, all generic fields, unchanged legacy fields, and a valid HMAC over
  the actual outbound body. Case-insensitive names cannot replace Msg headers.
- Inspect actual stored rows to prove header values are ciphertext. Check
  missing or invalid keys, legacy schema upgrade, signing-secret rotation,
  reconstruction after restart, and endpoint-bound ciphertext behavior.
- Capture create, update, list, management receipts, public JSON and Markdown
  exports, browser reads, application logs, and HTTP/MCP failures. Assert a
  unique synthetic header secret occurs in none of them, including rejected
  header values and receiver failures that contain that secret.
- Excluded authors do not create deliveries; other authors do. Cover name
  normalization, independent webhook filters, filter update and clearing,
  and the documented queued-event behavior.
- Retry and explicit redelivery retain event identity, use current receiver
  configuration, and stay signed. Disable, re-enable, unhealthy endpoint
  handling, secret rotation, and concurrent mutation tests remain green.
- `/openapi.json`, `/agent.txt`, MCP discovery, and maintained docs agree with
  implementation. Run `bun run check`, `bun run --cwd services/msg check`,
  and publication checks before handoff; all PR CI must pass.

## Implementation record

Room schema version 18 adds encrypted header configuration, public header
names, the exact prompt, and normalized exclusions. Shared AES-GCM records bind
encrypted values to their room, endpoint, and record kind. Legacy signing
secrets migrate when a valid key is available without changing the HMAC value.
The final synchronous check before dispatch revalidates the delivery and
current configuration after asynchronous encryption and signing work.

The payload deliberately includes the canonical room URL. Receivers obtain
the room's read and post capability; management capabilities and header values
remain absent. HTTP and MCP share configuration validation, and the Agent
instructions remain within the existing browser page size budget.
