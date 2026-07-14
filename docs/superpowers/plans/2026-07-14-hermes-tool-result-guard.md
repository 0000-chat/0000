# Hermes Tool-Result Guard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent an upstream Hermes ACP completion-ID mismatch from falsely terminalizing a 0000 task while preserving the received event unchanged.

**Architecture:** Extend the bridge's existing pending-tool reconciliation path with one Hermes-only trigger for a completed result whose ID is not active. The trigger reconciles standard tools only; the existing native-tool guard keeps subagent and long-running work pending. Register a dedicated structured log event and prove the behavior with a focused session-manager replay.

**Tech Stack:** Bun, TypeScript, Bun test runner, 0000 ACP bridge.

---

### Task 1: Capture the mismatched-completion regression

**Files:**
- Modify: `scripts/acp-bridge/session-manager.test.ts: after "clears an older pending tool when a later tool starts"`

- [ ] **Step 1: Write the failing Hermes regression test**

Add this test after the existing later-tool-start test. The deliberate delay keeps the later tool's timer active long enough for the current implementation to fail.

```ts
test("reconciles a pending Hermes standard tool after a mismatched completion", async () => {
  const cloud = fakeCloudClient();
  const logs: Array<Record<string, unknown>> = [];
  const manager = new BridgeSessionManager({
    cloudClient: cloud,
    createSession: (context) => ({
      close: async () => {},
      cancel: async () => {},
      sendUserMessage: async () => {
        context.onEvent(toolCallEvent(1, "search", "tool-1"));
        context.onEvent(toolCallEvent(2, "shell", "tool-2"));
        context.onEvent(toolResultEvent(3, "tool-1", "search"));
        await new Promise((resolve) => setTimeout(resolve, 20));
        return { events: [], rawResult: {}, sessionId: "session-1", text: "ok" };
      },
    }),
    livenessTimeoutMs: 10_000,
    log: (entry) => logs.push(entry),
    runtimeProfiles: [hermesRuntimeProfile()],
    toolResultTimeoutMs: 5,
  });

  await manager.handleQueueItem({
    ...promptQueueItem(),
    bridgeProfileId: "hermes:default",
  });

  expect(cloud.results.at(-1)).toMatchObject({ id: "queue-prompt", result: { ok: true } });
  expect(logs).toContainEqual(expect.objectContaining({
    event: "bridge.session.tool_result_id_mismatch",
    receivedToolCallId: "tool-1",
    toolCallId: "tool-2",
  }));
  expect(logs).not.toContainEqual(expect.objectContaining({
    event: "bridge.session.tool_result_timeout",
    toolCallId: "tool-2",
  }));
  expect(flattenPersistedEvents(cloud.events)).toContainEqual(expect.objectContaining({
    eventType: "tool_result",
    normalizedPayload: expect.objectContaining({
      json: expect.objectContaining({ toolCallId: "tool-1" }),
    }),
  }));
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test scripts/acp-bridge/session-manager.test.ts -t "reconciles a pending Hermes standard tool after a mismatched completion"`

Expected: FAIL because the current bridge leaves `tool-2` pending until `tool_result_timeout` terminalizes the queue item.

- [ ] **Step 3: Commit the red test**

```bash
git add scripts/acp-bridge/session-manager.test.ts
git commit -m "test(acp): cover Hermes mismatched tool completion"
```

### Task 2: Add the narrow bridge compatibility guard

**Files:**
- Modify: `scripts/acp-bridge/session-manager.ts: ToolCallReconciliationTrigger and recordToolEvent`
- Modify: `scripts/acp-bridge/bridge-log.ts: bridgeLogEventNames`

- [ ] **Step 1: Add a reconciliation trigger and register the diagnostic event**

Extend the trigger union and log-event registry:

```ts
type ToolCallReconciliationTrigger =
  | "assistant_output_resumed"
  | "later_tool_started"
  | "mismatched_tool_result"
  | "turn_completed";
```

```ts
"bridge.session.tool_result_id_mismatch",
```

- [ ] **Step 2: Reconcile only standard Hermes work after a mismatched completion**

In the completed-result branch of `recordToolEvent`, preserve the exact-match fast path. When the received ID has no active call, the runtime kind is Hermes, and a standard call is pending, log the received and pending IDs and call the existing reconciliation helper with `trigger: "mismatched_tool_result"`.

```ts
const activeTool = this.activeToolCalls.get(queueItemId)?.get(toolCallId);
if (activeTool) {
  this.clearToolCall(queueItemId, toolCallId);
  return;
}
if (session.runtimeProfile?.kind !== "hermes") {
  return;
}
const pendingStandardTool = Array.from(
  this.activeToolCalls.get(queueItemId)?.values() ?? [],
).find((tool) => tool.toolClass === "standard");
if (!pendingStandardTool) {
  return;
}
this.writeLog({
  level: "warn",
  event: "bridge.session.tool_result_id_mismatch",
  queueId: queueItemId,
  threadId: session.threadId,
  agentSessionId: session.providerSessionKey,
  bridgeProfileId: session.runtimeProfile?.id,
  reasonCode: "provider_progressed_with_mismatched_tool_result",
  settlementState: "provider_progressed",
  receivedToolCallId: toolCallId,
  toolCallId: pendingStandardTool.toolCallId,
  toolClass: pendingStandardTool.toolClass,
  toolName: pendingStandardTool.toolName,
  toolPolicyId: pendingStandardTool.toolPolicyId,
  toolTimeoutMs: pendingStandardTool.toolTimeoutMs,
});
this.reconcilePendingToolCalls(queueItemId, session, {
  trigger: "mismatched_tool_result",
});
```

Do not mutate `event`, `part.json`, `payload`, or the received ID. The existing `shouldKeepNativeToolPending` function leaves delegate/subagent and long-running calls pending for this non-terminal trigger.

- [ ] **Step 3: Run the focused regression test to verify it passes**

Run: `bun test scripts/acp-bridge/session-manager.test.ts -t "reconciles a pending Hermes standard tool after a mismatched completion"`

Expected: PASS; the queue item succeeds, the raw event retains `tool-1`, the mismatch log identifies pending `tool-2`, and no tool timeout is emitted.

- [ ] **Step 4: Run the related bridge test file**

Run: `bun test scripts/acp-bridge/session-manager.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit the implementation**

```bash
git add scripts/acp-bridge/session-manager.ts scripts/acp-bridge/bridge-log.ts scripts/acp-bridge/session-manager.test.ts
git commit -m "fix(acp): guard Hermes mismatched tool results"
```

### Task 3: Validate the owned bridge change

**Files:**
- Verify: `scripts/acp-bridge/session-manager.ts`
- Verify: `scripts/acp-bridge/session-manager.test.ts`
- Verify: `scripts/acp-bridge/bridge-log.ts`

- [ ] **Step 1: Run the repository test suite**

Run: `bun test`

Expected: PASS.

- [ ] **Step 2: Run guarded type checking**

Run: `bun run typecheck`

Expected: PASS.

- [ ] **Step 3: Inspect the final owned diff and worktree state**

Run: `git diff main...HEAD --check && git diff --stat main...HEAD && git status --short --branch`

Expected: no whitespace errors, only the design/plan, bridge source, bridge log registry, and focused test changes, and a clean feature branch.

- [ ] **Step 4: Merge the approved work and push the owned repository**

Run after the user authorizes landing: merge `codex/hermes-tool-result-guard` into local `main`, then push `main` to the owned `origin`.
