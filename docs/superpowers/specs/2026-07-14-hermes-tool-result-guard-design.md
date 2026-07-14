# Hermes Tool-Result Guard Design

## Context

Hermes can emit an ACP tool-completion event whose `toolCallId` belongs to an older tool call. In the observed incident, Hermes's ACP completion callback failed after consuming IDs from an internal FIFO queue. Later completions were consequently paired with stale IDs.

The 0000 bridge had already reconciled the older call after a later tool started. It therefore ignored the stale completion, continued waiting for the current standard tool's exact ID, and terminalized the task when that result timer expired.

The upstream correlation bug belongs to Hermes. This design adds a narrow compatibility guard in the owned `/home/ubuntu/0000` bridge so that an upstream metadata mismatch cannot falsely fail an otherwise progressing task.

## Goals

- Prevent a Hermes ACP result-ID mismatch from causing `tool_result_timeout` for an ordinary tool.
- Preserve the received event and its original ID for diagnosis.
- Record a structured diagnostic when the guard is used.
- Keep delegate and other subagent settlement strict.
- Make no changes to Hermes or other third-party repositories.

## Non-goals

- Repair Hermes's internal FIFO queue.
- Rewrite a result to claim that it belongs to another tool call.
- Infer or display the correct result-to-tool association.
- Relax correlation rules for non-Hermes runtimes or background/subagent work.

## Design

The guard belongs in `BridgeSessionManager.recordToolEvent`, where normalized ACP tool events already update the bridge's pending-tool timers.

For a completed `tool_result` event:

1. If its ID matches an active tool call, retain the existing exact-match behavior and clear that call.
2. If there is no exact match and the active runtime is not Hermes, retain the existing behavior.
3. If there is no exact match and the active runtime is Hermes, find pending standard tool calls for the same queue item.
4. If at least one standard call is pending, clear its timeout as provider-progress reconciliation. Do not modify the normalized event, payload, external event ID, or received `toolCallId`.
5. Leave pending delegate/subagent calls untouched.

The bridge currently reconciles ordinary tools when a later tool begins, assistant output resumes, or a turn completes without an explicit result. A mismatched completed Hermes result is equivalent evidence that the provider progressed past ordinary tool execution, so this guard extends that existing liveness policy rather than inventing result correlation.

## Observability

When the guard settles pending standard work, emit a structured bridge log event named `bridge.session.tool_result_id_mismatch` containing:

- queue, thread, session, and runtime profile identifiers already used by adjacent bridge logs;
- the received tool-call ID;
- the pending tool-call ID and tool name;
- `reasonCode: "provider_progressed_with_mismatched_tool_result"`;
- `settlementState: "provider_progressed"`.

The event must not contain prompts, tool inputs, tool output, authorization data, or secrets. The original normalized ACP event remains persisted unchanged, providing the audit record without fabricating a repaired correlation.

## Safety Boundaries

- Gate the behavior on `session.runtimeProfile.kind === "hermes"`.
- Apply it only to completed result states, never start/input-streaming events.
- Settle only tools whose resolved class is `standard`.
- Do not synthesize a tool result or change any ID.
- If no standard tool is pending, record no reconciliation and continue normally.

## Tests

Add focused `session-manager` regression coverage for:

1. A Hermes standard tool starts, a later standard tool replaces it, and a completion arrives with the older ID. The current standard-tool timer is reconciled, the queue item succeeds, the mismatch diagnostic is emitted, and no `tool_result_timeout` occurs.
2. The persisted completion retains the stale ID exactly as received.
3. The same mismatched sequence under a non-Hermes runtime retains strict timeout behavior.
4. A mismatched Hermes result does not settle a pending delegate/subagent call.

Run the focused bridge tests during development, then the repository-required `bun test`, `bun run typecheck`, and clean-status checks before landing.

## Ownership and Landing

All implementation, tests, and documentation stay in `/home/ubuntu/0000`. The work is developed on `codex/hermes-tool-result-guard` from local `main`, reviewed and validated there, then merged to local `main` and pushed to the owned `origin` repository.
