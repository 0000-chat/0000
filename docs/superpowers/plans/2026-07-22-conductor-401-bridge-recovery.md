# Conductor 401 Bridge Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Recover the disconnected OVH bridge registration and prevent a transient Convex Conductor-routing 401 from permanently disabling it again.

**Architecture:** Give the known Conductor-routing response precedence over generic 401 handling so it uses the existing retryable loop-error path. Keep genuine credential failures terminal, recover production with an idle bridge restart, and verify the three durable queues end to end.

**Tech Stack:** Bun, TypeScript, Bun test, systemd user services, Convex production metadata, repo-owned thread diagnostics.

---

## File Map

- Modify `scripts/acp-bridge/bridge-availability.ts`: bounded transient-response classification.
- Modify `scripts/acp-bridge/bridge-availability.test.ts`: unit regression coverage.
- Modify `scripts/acp-bridge.test.ts`: registration-construction and loop-routing coverage.

### Task 1: Add the failing classification test

**Files:**
- Modify: `scripts/acp-bridge/bridge-availability.test.ts:8-20`

- [ ] **Step 1: Install dependencies**

Run `bun install`.

Expected: exit 0 and no lockfile change.

- [ ] **Step 2: Add the regression assertions**

Extend `classifies auth failures separately from retryable cloud failures` with:

```ts
expect(
  classifyBridgeCloudFailure({
    status: 401,
    body: '{"error":"Instance not served by this Conductor"}',
  }),
).toBe("retryable")
expect(
  classifyBridgeCloudFailure({
    status: 401,
    body: '{"error":"Bridge device credentials are invalid"}',
  }),
).toBe("auth_failed")
```

- [ ] **Step 3: Verify RED**

Run `bun test scripts/acp-bridge/bridge-availability.test.ts`.

Expected: FAIL because the Conductor-routing 401 currently returns `auth_failed`.

### Task 2: Implement the minimal precedence rule

**Files:**
- Modify: `scripts/acp-bridge/bridge-availability.ts:16-33`

- [ ] **Step 1: Add the bounded guard before generic status handling**

Use this complete function body:

```ts
export function classifyBridgeCloudFailure(input: {
  body?: string
  status?: number
}): "auth_failed" | "retryable" {
  const body = input.body ?? ""
  if (/instance not served by this conductor/i.test(body)) {
    return "retryable"
  }
  if (
    input.status === 401 ||
    input.status === 403 ||
    /bridge credentials are invalid/i.test(body) ||
    /bridge token is invalid/i.test(body) ||
    /bridge token scope is invalid/i.test(body) ||
    /bridge device is not paired/i.test(body) ||
    /bridge device revoked/i.test(body)
  ) {
    return "auth_failed"
  }
  return "retryable"
}
```

- [ ] **Step 2: Verify GREEN**

Run `bun test scripts/acp-bridge/bridge-availability.test.ts`.

Expected: PASS.

### Task 3: Add registration and loop regressions

**Files:**
- Modify: `scripts/acp-bridge.test.ts:2642-2760`

- [ ] **Step 1: Cover registration-failure construction**

In `classifies stale bridge registrations as hard auth failures`, add:

```ts
const conductorRoutingFailure = buildBridgeRegistrationFailure(
  new BridgeCloudHttpError(
    "POST",
    "https://example.test/api/agent-bridge/control/pull",
    401,
    '{"error":"Instance not served by this Conductor"}',
  ),
  Date.UTC(2026, 5, 5, 10, 2, 0),
)
expect(conductorRoutingFailure).toBeUndefined()
```

- [ ] **Step 2: Cover retryable loop routing**

Add this test after the permanent-disable loop test:

```ts
test("retries Conductor routing failures without disabling the registration", async () => {
  const dir = await mkdtemp(join(tmpdir(), "0000-bridge-loop-"))
  const logs: Array<Record<string, unknown>> = []
  const retryErrors: unknown[] = []
  const status: BridgeStatus = {
    activeSessions: [],
    connected: true,
    recentErrors: [],
  }
  const conductorError = new BridgeCloudHttpError(
    "POST",
    "https://example.test/api/agent-bridge/control/pull",
    401,
    '{"error":"Instance not served by this Conductor"}',
  )

  await runBridgeLoopIteration({
    claimCommands: async () => {
      throw conductorError
    },
    cleanupStaleClaims: async () => ({ inspected: 0, released: 0 }),
    config: bridgeRegistration(),
    inFlightCommandMetadata: new Map(),
    inFlightCommands: new Map(),
    lastStaleCleanupAt: 0,
    log: Object.assign((entry: Record<string, unknown>) => logs.push(entry), {
      flush: async () => {},
    }),
    manager: {
      getStatus: () => ({
        activeSessions: [],
        terminalInteractionSessionKeyCount: 0,
        sessions: [],
      }),
      handleQueueItem: async () => {},
    },
    maxInFlight: 1,
    now: () => Date.UTC(2026, 5, 5, 10, 3, 0),
    recordLoopError: async (error) => {
      retryErrors.push(error)
    },
    sendHeartbeat: async () => ({ ok: true }),
    setLastStaleCleanupAt: () => {},
    status,
    statusPath: join(dir, "status.json"),
    writeStatus: async () => {},
  })

  expect(retryErrors).toEqual([conductorError])
  expect(status.registrationFailure).toBeUndefined()
  expect(logs).not.toContainEqual(
    expect.objectContaining({ event: "bridge.registration.disabled" }),
  )
})
```

- [ ] **Step 3: Run focused integration tests**

Run `bun test scripts/acp-bridge.test.ts`.

Expected: PASS.

- [ ] **Step 4: Commit the tested implementation**

```bash
git add scripts/acp-bridge/bridge-availability.ts scripts/acp-bridge/bridge-availability.test.ts scripts/acp-bridge.test.ts
git commit -m "fix: retry transient Conductor bridge failures"
```

### Task 4: Validate the repository and commit the plan

**Files:**
- Verify: all changed files
- Commit: `docs/superpowers/plans/2026-07-22-conductor-401-bridge-recovery.md`

- [ ] **Step 1: Run full validation**

Run `bun test`, then `bun run typecheck`.

Expected: all tests pass and typecheck exits 0.

- [ ] **Step 2: Check repository state**

Run `git diff --check main...HEAD` and `git status --short`.

Expected: no whitespace errors; only this plan is uncommitted.

- [ ] **Step 3: Commit the plan**

```bash
git add docs/superpowers/plans/2026-07-22-conductor-401-bridge-recovery.md
git commit -m "docs: plan Conductor 401 bridge recovery"
```

Expected: clean worktree.

### Task 5: Recover and verify production

**Files and services:**
- Inspect: `/home/ubuntu/.0000/bridge-status.json`
- Restart: `0000-chat-bridge.service`
- Diagnose from: `/home/ubuntu/0000-chat`

- [ ] **Step 1: Reconfirm the bridge is idle**

```bash
jq '[.registrations[] | ((.activeSessions // []) | length) + ((.inFlightCommands // []) | length)] | add' /home/ubuntu/.0000/bridge-status.json
```

Expected: `0`. If nonzero, wait for work to settle.

- [ ] **Step 2: Restart the service**

Run `systemctl --user restart 0000-chat-bridge.service`.

Expected: exit 0.

- [ ] **Step 3: Verify the affected registration**

After the status file updates, run:

```bash
jq '.registrations[] | select(.deviceId == "bridge_065772f00e669bf8ed95b55b") | {deviceId, connected, lastPollAt, lastHeartbeatAt, registrationFailure, availability}' /home/ubuntu/.0000/bridge-status.json
```

Expected: `connected: true`, current timestamps, `registrationFailure: null`, and claimable availability. If the Conductor response persists, stop without changing credentials.

- [ ] **Step 4: Verify all three queues**

From `/home/ubuntu/0000-chat`, run:

```bash
bun run logs:threads:investigate -- kx7309gef19dcmp5zyv4s5d43x8ayr3w kx7f43kb71pqggwxcgr9wtjn7s8az0zt kx7cchz82g61mteta3p2mm7nw18aztae --last -2h
bun run logs:acp:failures -- --last -2h
```

Expected: no thread remains indefinitely `queued/eligible_unclaimed`; each is claimed/completed or has a new explicit terminal reason.

### Task 6: Publish the review branch

**Branch:** `codex/conductor-401-retry`

- [ ] **Step 1: Verify clean branch state**

Run `git status --short` and `git log --oneline --decorate -4`.

Expected: clean worktree with design, implementation, and plan commits.

- [ ] **Step 2: Push**

Run `git push -u origin codex/conductor-401-retry`.

Expected: remote review branch created; do not push directly to `main`.
