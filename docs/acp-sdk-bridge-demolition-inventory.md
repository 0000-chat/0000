# ACP SDK Bridge Demolition Inventory

Date: 2026-06-08

This inventory defines the delete/keep boundary for replacing the custom ACP protocol core with `@agentclientprotocol/sdk`. The rewrite should remove SDK-owned protocol mechanics instead of preserving a legacy fallback. Product and process supervision behavior remains bridge-owned.

## Baseline

- `bun test scripts/acp-bridge/acp-session.test.ts`: 17 pass, 0 fail
- `bun test scripts/acp-bridge/session-manager.test.ts`: 44 pass, 0 fail
- `bun test scripts/acp-bridge/event-normalizer.test.ts`: 11 pass, 0 fail
- `bun test scripts/acp-bridge/runtime-discovery.test.ts`: 12 pass, 0 fail
- `/home/ubuntu/.config/superpowers/worktrees/0000-chat/codex-acp-sdk-bridge-rewrite`: `bun run quality:fast` passed with no changed-path tasks

## Responsibility Classification

### `scripts/acp-bridge/acp-session.ts`

sdk-owned:
- `JsonRpcMessage` and local ACP request/response shapes that duplicate SDK schemas.
- Request ID generation, `pending` request map, timeout bookkeeping, and JSON-RPC result/error matching.
- Line-delimited stdin/stdout framing and custom message parsing for ACP traffic.
- `initialize`, `session/new`, `session/load`, `session/prompt`, `session/cancel`, `session/close`, `session/list`, `session/set_mode`, and `session/set_config_option` request construction.
- `session/update` notification dispatch when it is only routing SDK event payloads.
- Permission response protocol writes for `session/request_permission`.
- Runtime capability extraction from raw initialize responses when the SDK exposes typed capability data.
- Legacy retries whose only purpose is custom protocol uncertainty, including MCP-server retry behavior that can move behind bridge policy plus SDK calls.

0000-owned:
- Hidden 0000 system prompt injection and prompt/thread-history assembly.
- Attachment delivery policy, resource-link fallback, and text fallback.
- Final text diagnostics, Codex-specific unclassified message chunk handling, and event finalization.
- Bridge error redaction and adapter result tags used by queue/result reporting.
- Runtime config application decisions, including product fallback when selected options are unavailable.
- Permission option selection semantics and safe diagnostics exposed to the product.

process-supervision-owned:
- Child process spawn command splitting and cwd handling.
- Environment/PATH behavior inherited from runtime profile configuration.
- stderr capture and bridge error callbacks.
- Graceful close, process-group termination fallback, force-kill timeout, and pending operation failure on process exit.

### `scripts/acp-bridge/runtime-discovery.ts`

sdk-owned:
- Manual initialize probe JSON-RPC envelope and response parsing in `probeLocalAcpCommand`.
- Raw initialize capability parsing in `capabilitiesFromInitializeResult` where SDK schema types cover the data.
- Manual `session/new` plus `session/update` traffic used only to discover runtime commands.
- Any probe request IDs, stdin writes, stdout message framing, and JSON parsing of ACP messages.

0000-owned:
- Built-in runtime catalog and command resolution (`codex`, `claude`, OpenClaw gateway/package adapters).
- Runtime profile IDs, labels, status, diagnostics, capability provenance, identity rules, max-session policy, and Hermes/OpenClaw-specific degradation rules.
- PATH augmentation with user tool directories and context-mode/Codex MCP diagnostics.
- Normalized available command metadata published in bridge device capabilities.
- Unavailable-profile isolation and actionable diagnostics.

process-supervision-owned:
- Spawning discovery commands and ACP probe children.
- Active discovery child tracking and termination.
- Probe timeouts, stderr capture, and local command execution wrappers.

### `scripts/acp-bridge/session-manager.ts`

sdk-owned:
- None as a primary responsibility. Any calls that rely on old `HermesAcpSession` protocol methods should be redirected through a bridge runtime client interface.

0000-owned:
- Convex bridge queue item shape, claim handling, result acknowledgement, and terminal error classification.
- Organization/device/thread/session/runtime profile scoping.
- Runtime profile selection and Hermes profile command resolution.
- Session record lifecycle, provider session keys, cwd safety, mailbox conversation IDs, and bridge profile IDs.
- Prompt, steer, cancel, approval-response, and close workflows at the product queue level.
- Event batching, event upload, bridge result marking, and timeline semantics.
- Attachment upload to Convex/blob storage, local path resolution, attachment summaries, media-type summaries, and durable fallback.
- Approval policy, approval-level handling, and external request/session IDs.
- Bridge logs, privacy-preserving redaction, and safe diagnostics.

process-supervision-owned:
- Session close timeout policy and orchestration of managed session close/cancel calls.
- Delegation to runtime session/client process lifecycle through the managed session boundary.

### `scripts/acp-bridge/event-normalizer.ts`

sdk-owned:
- Local parsing of ACP request/notification envelopes only where the SDK now provides typed update callbacks.
- Duplicated schema narrowing for ACP update payloads when SDK schema types can replace the local wire-shape assumptions.

0000-owned:
- Mapping ACP updates to `NormalizedBridgeEvent` and 0000 message/activity semantics.
- Permission request normalization into approval request parts.
- Agent message, thought, command, tool, file/resource, and attachment event classification.
- Attachment upload candidate extraction, payload sanitization, access metadata normalization, and pending upload status.
- Large/sensitive payload truncation and privacy-safe bridge error normalization.
- Status normalization and UI-facing event payload shaping.

process-supervision-owned:
- None.

## Preservation Test List

- `scripts/acp-bridge/event-normalizer.test.ts`: preserve. Verifies 0000-owned event normalization, attachment fallback candidates, thought visibility, available commands, and permission/timeline shaping.
- `scripts/acp-bridge/session-manager.test.ts`: preserve. Verifies 0000-owned queue handling, scoping, cwd safety, approval/cancel/steer workflows, attachment upload, result marking, and session lifecycle semantics. Update only where it directly mocks the old `HermesAcpSession` protocol surface.
- `scripts/acp-bridge/runtime-discovery.test.ts`: split. Preserve tests for runtime profiles, PATH diagnostics, command resolution, Hermes/OpenClaw policy, unavailable isolation, and capability publication. Replace tests asserting manual initialize/session-update wire probes.
- `scripts/acp-bridge/runtime-smoke.test.ts`: preserve as an integration guard once the SDK-backed runtime client is wired.
- `scripts/acp-bridge/acp-session.test.ts`: split. Preserve bridge-owned final text extraction, attachment delivery, runtime config fallback, process kill fallback, safe diagnostics, and adapter result tags. Delete or replace tests that assert raw JSON-RPC mechanics, pending request behavior, manual request payloads, or legacy transport fallback.

## First Delete Boundary

Delete or replace first:
- Raw JSON-RPC request/pending/framing assertions in `acp-session.test.ts`.
  - Status: removed. Process-supervision tests now use SDK `AgentSideConnection` over the fake child process streams instead of local `JsonRpcMessage` parsing.
- Local protocol type definitions in `acp-session.ts` that are covered by SDK schema types.
- `HermesAcpSession` protocol methods and probes that manually construct ACP method calls.
- Manual initialize/session-update discovery probes in `runtime-discovery.ts`.

Keep while replacing:
- A bridge-owned runtime client interface that `session-manager.ts` can call without knowing protocol mechanics.
- Process launch/kill helpers, either in a dedicated helper or owned by the SDK client wrapper when it owns the child process.
- Event normalization output shapes and product queue semantics.
