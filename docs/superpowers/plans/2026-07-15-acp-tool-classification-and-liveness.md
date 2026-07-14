# ACP Tool Classification and Liveness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent human-readable ACP tool titles from changing execution semantics, and prevent an unresolved tool-result timer from masquerading as whole-session liveness failure.

**Architecture:** Carry structured ACP tool metadata (`kind`) through the bridge and give it precedence over display-title heuristics. Treat a missing tool completion as a non-terminal observation; only process/transport failure or the ACP request-idle timeout may terminate the parent turn. Preserve the last unresolved-tool metadata on a genuine ACP request timeout so production diagnostics still explain where provider silence began.

**Tech Stack:** Bun, TypeScript, ACP normalized events, 0000 bridge session management, structured bridge logging.

---

## Scope and evidence

This plan covers two production failure modes on bridge commit `81ac0ee`:

- `kx73xdbkb4g0q1aztgd4wjbdfn8ag8hj` and `kx795rsdc69xz71j1tgw72yzgh8ah27f`: structured `kind: "read"` calls were promoted to `subagent` only because their display titles contained `workflow`. They bypassed standard-tool reconciliation and failed at the 30-minute subagent timeout.
- `kx7cvg19anhg5w6pqbbrjst1rn8ah8h0`: a correctly classified `kind: "search"` call (`tc-b2d04f0b4aff`) was the last call in a four-tool batch. Hermes emitted no completion or subsequent activity. The bridge reported `provider_quiet` after two minutes, then its independent five-minute tool timer terminated the turn as `tool_result_timeout`, before the ten-minute ACP request-idle timeout could identify the real failure boundary.

The classifier work fully prevents the first failure mode. The liveness work prevents the premature and misleading error in the third task, but cannot make a silent Hermes process produce a result. If silence continues, the turn must fail at the existing ACP request deadline as `acp_method_timeout`, with the unresolved search attached as diagnostic context.

Automatic prompt replay is deliberately out of scope. The third task had five permission responses and may already have performed mutations; replaying it could duplicate side effects. A later recovery design may retry only after an explicit, audited effect-safety model exists.

## File map

- Modify `scripts/acp-bridge/runtime-profiles.ts`: structured tool-kind classification and provenance.
- Modify `scripts/acp-bridge/runtime-profiles.test.ts`: positive and negative classifier regressions.
- Modify `scripts/acp-bridge/session-manager.ts`: retain kind/provenance and separate tool expiry from liveness.
- Modify `scripts/acp-bridge/session-manager.test.ts`: replay both production failure shapes.
- Modify `scripts/acp-bridge/bridge-log.ts`: register a privacy-safe tracking event.
- Modify `docs/acp-bridge-debugging-runbook.md`: document the new diagnostic contract.

### Task 1: Lock down structured classification with failing tests

**Files:**
- Modify: `scripts/acp-bridge/runtime-profiles.test.ts`
- Test: `scripts/acp-bridge/runtime-profiles.test.ts`

- [ ] **Step 1: Add negative false-positive cases**

```ts
test("keeps structured read and search tools standard regardless of title prose", () => {
  const profile: BridgeRuntimeProfile = {
    capabilities: {},
    command: ["hermes", "acp"],
    compatibility: hermesRuntimeCompatibility(),
    id: "hermes:default",
    kind: "hermes",
    label: "Hermes",
    status: "available",
  }

  for (const input of [
    { toolKind: "read", toolName: "read: docs/workflow.md" },
    { toolKind: "read", toolName: "read: notes/background-workers.md" },
    { toolKind: "search", toolName: "search: subagent workflow" },
    { toolKind: "execute", toolName: "background worker task" },
  ]) {
    expect(resolveToolCallTimeoutPolicy({
      defaultTimeoutMs: 300_000,
      profile,
      ...input,
    })).toEqual({
      classificationSource: "structured_kind",
      policyId: "structured-standard-tool",
      timeoutMs: 300_000,
      toolClass: "standard",
    })
  }
})
```

- [ ] **Step 2: Require provenance in positive subagent cases**

Update the existing `agent.run` expectation to include `classificationSource: "generic_policy"`. Update the Hermes `delegate:` expectation to pass `toolKind: "other"` and require `classificationSource: "runtime_policy"`. Update every remaining exact policy expectation in this file: generic terminal/build matches use `generic_policy`, unmatched tools use `default_policy`, and explicit-timeout cases use `explicit_timeout`.

```ts
expect(resolveToolCallTimeoutPolicy({
  defaultTimeoutMs: 300_000,
  profile,
  toolKind: "other",
  toolName: "delegate: inspect OpenUI primitives",
})).toEqual({
  classificationSource: "runtime_policy",
  policyId: "hermes-delegate-subagent",
  timeoutMs: DEFAULT_LONG_RUNNING_TOOL_RESULT_TIMEOUT_MS,
  toolClass: "subagent",
})
```

- [ ] **Step 3: Verify the tests fail for the intended reason**

```bash
bun test scripts/acp-bridge/runtime-profiles.test.ts
```

Expected: FAIL because `toolKind` and `classificationSource` do not exist and `workflow` currently selects `generic-subagent-tool`.

- [ ] **Step 4: Commit the red tests**

```bash
git add scripts/acp-bridge/runtime-profiles.test.ts
git commit -m "test(acp): cover structured tool classification"
```

### Task 2: Implement structured, anchored classification

**Files:**
- Modify: `scripts/acp-bridge/runtime-profiles.ts`
- Test: `scripts/acp-bridge/runtime-profiles.test.ts`

- [ ] **Step 1: Add classification provenance**

```ts
export type BridgeToolCallClassificationSource =
  | "default_policy"
  | "explicit_timeout"
  | "generic_policy"
  | "runtime_policy"
  | "structured_kind"

export type BridgeToolCallTimeoutResolution = {
  classificationSource: BridgeToolCallClassificationSource
  policyId: string
  timeoutMs: number
  toolClass: BridgeRuntimeToolCallClass
}
```

- [ ] **Step 2: Define structured non-subagent kinds**

```ts
const STRUCTURED_NON_SUBAGENT_TOOL_KINDS = new Set([
  "delete",
  "edit",
  "execute",
  "fetch",
  "move",
  "read",
  "search",
  "switch_mode",
  "think",
])
```

These are the ACP kinds with ordinary, non-delegating semantics. Do not include `other`, because native delegates commonly use it. A structured `execute` may still select a `long_running` policy, but it must never become a subagent because its human-readable title happens to contain `task`, `worker`, or similar prose.

- [ ] **Step 3: Replace generic subagent patterns with anchored identities**

```ts
const GENERIC_SUBAGENT_TOOL_POLICY: BridgeRuntimeToolCallPolicy = {
  id: "generic-subagent-tool",
  toolClass: "subagent",
  toolNamePatterns: [
    "^delegate(?::|_|-|\\b)",
    "^sub-?agent(?::|_|-|\\b)",
    "^agent\\.run(?::|_|-|\\b)",
    "^task(?::|_|-|\\b)",
    "^worker(?::|_|-|\\b)",
  ],
}
```

This removes the unanchored `workflow` and `background` subject-matter patterns.

- [ ] **Step 4: Resolve explicit timeout, then structured semantics, then identity policies**

Extend the input with `toolKind?: string`. Return `classificationSource: "explicit_timeout"` from the explicit branch. Normalize the kind and restrict structured non-subagent tools to long-running policies only when the kind is `execute`:

```ts
const toolKind = input.toolKind?.trim().toLowerCase()
if (toolKind && STRUCTURED_NON_SUBAGENT_TOOL_KINDS.has(toolKind)) {
  const longRunningPolicy =
    toolKind === "execute"
      ? [
          ...(input.profile?.compatibility?.toolCallPolicies ?? []),
          GENERIC_LONG_RUNNING_TOOL_POLICY,
        ].find(
          (policy) =>
            policy.toolClass === "long_running" &&
            toolCallPolicyMatches(policy, input.toolName),
        )
      : undefined
  if (longRunningPolicy) {
    const runtimePolicy = input.profile?.compatibility?.toolCallPolicies?.includes(
      longRunningPolicy,
    )
    return {
      classificationSource: runtimePolicy ? "runtime_policy" : "generic_policy",
      policyId: longRunningPolicy.id,
      timeoutMs: resolvePolicyTimeoutMs(longRunningPolicy, input),
      toolClass: "long_running",
    }
  }
  return {
    classificationSource: "structured_kind",
    policyId: "structured-standard-tool",
    timeoutMs: input.defaultTimeoutMs,
    toolClass: "standard",
  }
}
```

Add a test proving `toolKind: "execute"` plus `toolName: "terminal: bun run quality:changed"` remains `long_running`, while the `background worker task` execute case above remains standard.

Return `default_policy` when no policy matches, `runtime_policy` when the runtime policy matched, and `generic_policy` otherwise:

```ts
return {
  classificationSource: runtimePolicy ? "runtime_policy" : "generic_policy",
  policyId: policy.id,
  timeoutMs: resolvePolicyTimeoutMs(policy, input),
  toolClass: policy.toolClass,
}
```

- [ ] **Step 5: Run and commit**

```bash
bun test scripts/acp-bridge/runtime-profiles.test.ts
git add scripts/acp-bridge/runtime-profiles.ts scripts/acp-bridge/runtime-profiles.test.ts
git commit -m "fix(acp): classify tools from structured metadata"
```

Expected: tests PASS, including false-positive and true-delegate cases.

### Task 3: Carry kind and provenance through session tracking

**Files:**
- Modify: `scripts/acp-bridge/session-manager.ts`
- Modify: `scripts/acp-bridge/session-manager.test.ts`
- Modify: `scripts/acp-bridge/bridge-log.ts`
- Test: `scripts/acp-bridge/session-manager.test.ts`

- [ ] **Step 1: Make the test helper production-shaped**

Extend `toolCallEvent()` with a fourth `toolKind?: string` parameter and add `kind: toolKind` to `part.json`.

```ts
function toolCallEvent(
  sequence: number,
  toolName = "shell",
  toolCallId = "tool-1",
  toolKind?: string,
): NormalizedBridgeEvent
```

- [ ] **Step 2: Add an end-to-end false-classification regression**

Create a Hermes test that emits `toolCallEvent(1, "read: docs/workflow.md", "read-1", "read")`, then a thought event. Assert the pending call is tracked as standard, reconciled by later progress, and never times out:

```ts
test("keeps a structured read standard when its title contains workflow", async () => {
  const cloud = fakeCloudClient()
  const logs: Array<Record<string, unknown>> = []
  const manager = new BridgeSessionManager({
    cloudClient: cloud,
    createSession: (context) => ({
      close: async () => {},
      cancel: async () => {},
      sendUserMessage: async () => {
        context.onEvent(
          toolCallEvent(1, "read: docs/workflow.md", "read-1", "read"),
        )
        context.onEvent(streamChunkEvent("agent_thought_chunk", "continuing", 2))
        return {
          events: [],
          rawResult: {},
          sessionId: "session-1",
          text: "ok",
        }
      },
    }),
    livenessTimeoutMs: 10_000,
    log: (entry) => logs.push(entry),
    runtimeProfiles: [hermesRuntimeProfile()],
    toolResultTimeoutMs: 5,
  })

  await manager.handleQueueItem({
    ...promptQueueItem(),
    bridgeProfileId: "hermes:default",
  })

expect(logs).toContainEqual(expect.objectContaining({
  classificationSource: "structured_kind",
  event: "bridge.session.tool_call_tracked",
  toolCallId: "read-1",
  toolClass: "standard",
  toolKind: "read",
  toolPolicyId: "structured-standard-tool",
}))
expect(logs).not.toContainEqual(expect.objectContaining({
  event: "bridge.session.tool_result_timeout",
  toolCallId: "read-1",
}))
})
```

- [ ] **Step 3: Verify the new session test fails**

```bash
bun test scripts/acp-bridge/session-manager.test.ts -t "structured read"
```

Expected: FAIL because `readToolLogFields()` currently drops `kind`.

- [ ] **Step 4: Retain kind in parsed fields**

```ts
function readToolLogFields(value: unknown): {
  toolCallId?: string
  toolKind?: string
  toolName: string
} {
  const records = toolFieldRecords(value)
  return {
    toolCallId: readFirstToolString(records, ["toolCallId", "tool_call_id", "id"]),
    toolKind: readFirstToolString(records, ["kind"]),
    toolName:
      readFirstToolString(records, ["toolName", "name", "tool", "title"]) ??
      "unknown",
  }
}
```

- [ ] **Step 5: Store and pass the descriptor**

Add `classificationSource` and `toolKind?` to `ActiveToolCall`. Change `resolveToolCallPolicy()` to accept `{ toolKind?: string; toolName: string }`, and pass both fields from `annotateToolEvent()`, `recordToolEvent()`, and `trackPendingToolCall()`.

Extend the existing `runtime-profiles` type import with `BridgeToolCallClassificationSource` and `BridgeToolCallTimeoutResolution`; do not duplicate either type locally.

```ts
return resolveToolCallTimeoutPolicy({
  defaultTimeoutMs: this.toolResultTimeoutMs,
  explicitTimeoutMs: this.explicitToolResultTimeoutMs,
  profile: session.runtimeProfile,
  requestTimeoutMs: this.requestTimeoutMs,
  toolKind: tool.toolKind,
  toolName: tool.toolName,
})
```

- [ ] **Step 6: Add a privacy-safe classification diagnostic**

Register `bridge.session.tool_call_tracked` in `bridge-log.ts`. Emit it after storing the active call:

```ts
this.writeLog({
  level: "debug",
  event: "bridge.session.tool_call_tracked",
  queueId: queueItemId,
  threadId: session.threadId,
  agentSessionId: session.providerSessionKey,
  bridgeProfileId: session.runtimeProfile?.id,
  classificationSource: policy.classificationSource,
  toolCallId: tool.toolCallId,
  toolClass: policy.toolClass,
  toolKind: tool.toolKind,
  toolPolicyId: policy.policyId,
  toolTimeoutMs: policy.timeoutMs,
})
```

Do not include the display title or arguments in this new event.

- [ ] **Step 7: Run and commit**

```bash
bun test scripts/acp-bridge/runtime-profiles.test.ts scripts/acp-bridge/session-manager.test.ts
git add scripts/acp-bridge/bridge-log.ts scripts/acp-bridge/session-manager.ts scripts/acp-bridge/session-manager.test.ts
git commit -m "feat(acp): retain tool classification provenance"
```

Expected: tests PASS.

### Task 4: Separate tool expiry from parent-turn liveness

**Files:**
- Modify: `scripts/acp-bridge/session-manager.ts`
- Modify: `scripts/acp-bridge/session-manager.test.ts`
- Test: `scripts/acp-bridge/session-manager.test.ts`

- [ ] **Step 1: Add the final-search provider-silence regression**

Create a deferred fake prompt that emits four standard read/search calls. Use `toolResultTimeoutMs: 5`; after observing the tool timeout, reject the prompt with `new Error("ACP request timed out: session/prompt")`.

```ts
test("keeps unresolved standard tools non-terminal until the ACP request timeout", async () => {
  const cloud = fakeCloudClient()
  const logs: Array<Record<string, unknown>> = []
  let rejectPrompt!: (error: Error) => void
  const manager = new BridgeSessionManager({
    cloudClient: cloud,
    createSession: (context) => ({
      close: async () => {},
      cancel: async () => {},
      sendUserMessage: async () => {
        context.onEvent(toolCallEvent(1, "read: first", "read-1", "read"))
        context.onEvent(toolCallEvent(2, "search: first", "search-1", "search"))
        context.onEvent(toolCallEvent(3, "read: second", "read-2", "read"))
        context.onEvent(
          toolCallEvent(4, "search: final", "search-final", "search"),
        )
        return await new Promise<never>((_, reject) => {
          rejectPrompt = reject
        })
      },
    }),
    livenessTimeoutMs: 10_000,
    log: (entry) => logs.push(entry),
    toolResultTimeoutMs: 5,
  })

  const handled = manager.handleQueueItem(promptQueueItem())
await eventually(() => expect(logs).toContainEqual(expect.objectContaining({
  event: "bridge.session.tool_result_timeout",
  terminal: false,
  toolCallId: "search-final",
})))
expect(cloud.results).not.toContainEqual(expect.objectContaining({
  result: expect.objectContaining({ reasonCode: "tool_result_timeout" }),
}))

rejectPrompt(new Error("ACP request timed out: session/prompt"))
await handled

expect(cloud.results).toContainEqual(expect.objectContaining({
  result: expect.objectContaining({
    classificationSource: "explicit_timeout",
    failureClass: "provider_silent_after_tool",
    ok: false,
    reasonCode: "acp_method_timeout",
    terminal: true,
    toolCallId: "search-final",
  }),
}))
})
```

- [ ] **Step 2: Add a late-recovery regression**

Let the tool timer fire, then emit assistant output and return a successful result. Assert `bridge.session.tool_result_timeout` has `terminal: false`, the queue result is successful, and `agent.turn.failed` is absent:

```ts
test("allows late provider progress after a tool result observation", async () => {
  const cloud = fakeCloudClient()
  const logs: Array<Record<string, unknown>> = []
  const manager = new BridgeSessionManager({
    cloudClient: cloud,
    createSession: (context) => ({
      close: async () => {},
      cancel: async () => {},
      sendUserMessage: async () => {
        context.onEvent(
          toolCallEvent(1, "search: slow", "search-slow", "search"),
        )
        await new Promise((resolve) => setTimeout(resolve, 20))
        context.onEvent(streamChunkEvent("agent_thought_chunk", "resumed", 2))
        return {
          events: [],
          rawResult: {},
          sessionId: "session-1",
          text: "ok",
        }
      },
    }),
    livenessTimeoutMs: 10_000,
    log: (entry) => logs.push(entry),
    toolResultTimeoutMs: 5,
  })

  await manager.handleQueueItem(promptQueueItem())

  expect(logs).toContainEqual(expect.objectContaining({
    event: "bridge.session.tool_result_timeout",
    terminal: false,
    toolCallId: "search-slow",
  }))
  expect(cloud.results).toContainEqual(expect.objectContaining({
    result: expect.objectContaining({ ok: true }),
  }))
  expect(logs).not.toContainEqual(expect.objectContaining({
    event: "agent.turn.failed",
  }))
})
```

- [ ] **Step 3: Verify both tests fail under current behavior**

```bash
bun test scripts/acp-bridge/session-manager.test.ts -t "unresolved standard tools|late provider recovery"
```

Expected: FAIL because the tool timer currently rejects `activeLivenessFailures`.

- [ ] **Step 4: Replace stored failures with observations**

```ts
type ToolResultTimeoutObservation = {
  ageMs: number
  classificationSource: BridgeToolCallClassificationSource
  failureClass: "tool_result_unresolved"
  providerSilenceMs?: number
  providerState?: SessionLivenessRecord["state"]
  timeoutMs: number
  toolCallId: string
  toolClass: string
  toolKind?: string
  toolPolicyId: string
}

private readonly activeToolTimeoutObservations = new Map<
  string,
  ToolResultTimeoutObservation
>()
```

Update all existing cleanup sites from `activeToolTimeoutFailures` to `activeToolTimeoutObservations`.

- [ ] **Step 5: Make the timer observational**

At expiry, save liveness context and log `terminal: false`:

```ts
const liveness = this.activeLiveness.get(queueItemId)
const details: ToolResultTimeoutObservation = {
  ageMs,
  classificationSource: activeTool.classificationSource,
  failureClass: "tool_result_unresolved",
  providerSilenceMs: liveness
    ? Date.now() - liveness.lastMeaningfulEventAt
    : undefined,
  providerState: liveness?.state,
  timeoutMs: activeTool.toolTimeoutMs,
  toolCallId: activeTool.toolCallId,
  toolClass: activeTool.toolClass,
  toolKind: activeTool.toolKind,
  toolPolicyId: activeTool.toolPolicyId,
}
this.activeToolTimeoutObservations.set(queueItemId, details)
this.writeLog({
  level: "warn",
  event: "bridge.session.tool_result_timeout",
  queueId: queueItemId,
  threadId: session.threadId,
  reasonCode: "tool_result_timeout",
  terminal: false,
  ...details,
})
```

Delete the call that rejects `activeLivenessFailures` with `ACP live session lost: tool_result_timeout`. Do not change process-exit or transport-close failure handling.

The observation intentionally omits `toolName`: display titles may contain paths or task subject matter. Tool ID, structured kind, class, policy, and classification source are sufficient for correlation.

- [ ] **Step 6: Clear stale observations when provider progress proves recovery**

Add a narrow helper and call it whenever the matching active tool is cleared by an exact result or by `reconcilePendingToolCalls()`:

```ts
private clearToolTimeoutObservation(
  queueItemId: string,
  toolCallId: string,
): void {
  const observation = this.activeToolTimeoutObservations.get(queueItemId)
  if (observation?.toolCallId === toolCallId) {
    this.activeToolTimeoutObservations.delete(queueItemId)
  }
}
```

The late-recovery test must assert the observation is absent from the successful queue result. This prevents a recovered search from being blamed if a different failure happens later in the same turn.

- [ ] **Step 7: Attach the observation to a genuine request timeout**

Change `classifyPromptError()` to accept `ToolResultTimeoutObservation`, remove its `ACP live session lost: tool_result_timeout` branch, and enrich the existing request-timeout branch:

```ts
if (message.includes("ACP request timed out: session/prompt")) {
  return {
    terminal: true,
    details: toolTimeoutObservation
      ? {
          ...toolTimeoutObservation,
          failureClass: "provider_silent_after_tool",
        }
      : undefined,
    message: "ACP prompt request timed out.",
    reasonCode: "acp_method_timeout",
  }
}
```

Pass `this.activeToolTimeoutObservations.get(item.id)` from the prompt catch block.

- [ ] **Step 8: Preserve rolling-version compatibility**

Keep `failActiveQueueItem(queueId, "tool_result_timeout", metadata)` support for old supervisor journals. New session-manager timers must not generate that terminal path themselves.

- [ ] **Step 9: Run and commit**

```bash
bun test scripts/acp-bridge/session-manager.test.ts
git add scripts/acp-bridge/session-manager.ts scripts/acp-bridge/session-manager.test.ts
git commit -m "fix(acp): decouple tool expiry from session liveness"
```

Expected: the production-shaped silence case terminates as `acp_method_timeout`; late provider recovery succeeds; process/transport failure remains immediately terminal.

### Task 5: Document and verify the diagnostic contract

**Files:**
- Modify: `docs/acp-bridge-debugging-runbook.md`
- Modify: `scripts/acp-bridge/session-manager.test.ts`

- [ ] **Step 1: Assert persisted terminal metadata**

In the low-timeout ACP regression, require the persisted `bridge_error` JSON to contain `classificationSource: "explicit_timeout"` because the existing test-only low-timeout option intentionally overrides the normal policy. The Task 3 regression remains the proof that a production-shaped structured search records `structured_kind`:

```ts
expect.objectContaining({
  classificationSource: "explicit_timeout",
  failureClass: "provider_silent_after_tool",
  reasonCode: "acp_method_timeout",
  toolCallId: "search-final",
  toolClass: "standard",
  toolKind: "search",
  toolPolicyId: "structured-standard-tool",
})
```

- [ ] **Step 2: Add the runbook distinction**

```md
### Tool completion versus session liveness

- `bridge.session.tool_result_timeout` with `terminal: false` means the bridge
  did not observe a matching completion by the policy deadline. It is not proof
  that the ACP session died.
- `classificationSource: structured_kind` means ACP `kind` overrode display
  title heuristics. `runtime_policy` and `generic_policy` are intentional
  identity-matching paths.
- Terminal `acp_method_timeout` with
  `failureClass: provider_silent_after_tool` means the provider remained idle
  through the ACP request deadline; use the attached safe tool metadata to find
  where progress stopped.
- Do not replay prompts automatically when permission requests, edits,
  execution, or other possible side effects occurred before silence.
```

- [ ] **Step 3: Run and commit**

```bash
bun test scripts/acp-bridge/runtime-profiles.test.ts scripts/acp-bridge/session-manager.test.ts scripts/acp-bridge/session-liveness.test.ts
git diff --check
git add docs/acp-bridge-debugging-runbook.md scripts/acp-bridge/session-manager.test.ts
git commit -m "docs(acp): distinguish tool expiry from provider silence"
```

Expected: all tests PASS and `git diff --check` prints nothing.

### Task 6: Run the bridge handoff gate

**Files:**
- Verify all files listed in the file map.

- [ ] **Step 1: Run targeted bridge tests**

```bash
bun test scripts/acp-bridge/runtime-profiles.test.ts scripts/acp-bridge/session-manager.test.ts scripts/acp-bridge/session-liveness.test.ts scripts/acp-bridge.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run the repository suite and guarded typecheck**

```bash
bun test
bun run typecheck
```

Expected: both commands exit 0.

- [ ] **Step 3: Verify scope and history**

```bash
git status --short
git diff origin/main...HEAD --stat
git log --oneline origin/main..HEAD
```

Expected: only the six mapped files changed, with focused test/classifier/plumbing/liveness/documentation commits.

- [ ] **Step 4: Perform the production acceptance review**

```text
kind=read + title containing workflow       => standard / structured_kind
kind=search + title containing subagent     => standard / structured_kind
Hermes delegate: title + kind=other         => subagent / runtime_policy
standard tool expiry + later ACP progress   => parent turn may complete
standard tool expiry + ACP request timeout  => acp_method_timeout
process exit or transport close             => immediate terminal failure
tool timer alone                             => never calls activeLivenessFailures
automatic prompt replay                     => absent
```

- [ ] **Step 5: Commit only scoped test corrections if the gate required them**

```bash
git add scripts/acp-bridge/runtime-profiles.test.ts scripts/acp-bridge/session-manager.test.ts scripts/acp-bridge/session-liveness.test.ts scripts/acp-bridge.test.ts
git commit -m "test(acp): finalize tool liveness regressions"
```

Do not bundle unrelated bridge cleanup into this plan.
