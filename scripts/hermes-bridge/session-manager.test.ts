import { describe, expect, test } from "bun:test"

import { BridgeSessionManager, type BridgeSessionContext } from "./session-manager"

describe("bridge session cwd safety", () => {
  test("ignores remote queue cwd by default", async () => {
    const contexts: BridgeSessionContext[] = []
    const manager = new BridgeSessionManager({
      cloudClient: fakeCloudClient(),
      createSession: (context) => {
        contexts.push(context)
        return fakeSession()
      },
    })

    await manager.handleQueueItem({
      cwd: "/Users/alice/private-project",
      id: "queue-1",
      prompt: "hello",
      threadId: "thread-1",
      type: "prompt",
    })

    expect(contexts[0]?.cwd).toBeUndefined()
  })

  test("honors remote queue cwd only when explicitly enabled", async () => {
    const contexts: BridgeSessionContext[] = []
    const manager = new BridgeSessionManager({
      allowRemoteCwd: true,
      cloudClient: fakeCloudClient(),
      createSession: (context) => {
        contexts.push(context)
        return fakeSession()
      },
    })

    await manager.handleQueueItem({
      cwd: "/Users/alice/private-project",
      id: "queue-1",
      prompt: "hello",
      threadId: "thread-1",
      type: "prompt",
    })

    expect(contexts[0]?.cwd).toBe("/Users/alice/private-project")
  })

  test("uses configured agent names instead of runtime labels for run start events", async () => {
    const cloud = fakeCloudClient()
    const manager = new BridgeSessionManager({
      cloudClient: cloud,
      createSession: () => fakeSession(),
      runtimeProfiles: [
        {
          capabilities: {},
          command: ["npx", "--yes", "@zed-industries/codex-acp@latest"],
          id: "codex:codex-acp",
          kind: "codex",
          label: "Codex",
          status: "available",
        },
      ],
    })

    await manager.handleQueueItem({
      bridgeProfileId: "codex:codex-acp",
      id: "queue-1",
      prompt: "hello",
      threadId: "thread-1",
      type: "prompt",
    })

    expect(cloud.events[0]?.[0]?.normalizedPayload).toMatchObject({
      text: "Agent started this run.",
    })
  })

  test("recreates an ACP session when an explicit runtime profile changes", async () => {
    const cloud = fakeCloudClient()
    const contexts: BridgeSessionContext[] = []
    const closedProfiles: Array<string | undefined> = []
    const manager = new BridgeSessionManager({
      cloudClient: cloud,
      createSession: (context) => {
        contexts.push(context)
        return {
          close: async () => {
            closedProfiles.push(context.bridgeProfileId)
          },
          cancel: async () => {},
          sendUserMessage: async () => ({
            events: [],
            rawResult: {},
            sessionId: "session-1",
            text: context.bridgeProfileId ?? "unknown",
          }),
        }
      },
      runtimeProfiles: [
        {
          capabilities: {},
          command: ["npx", "--yes", "@zed-industries/codex-acp@0.15.0"],
          id: "codex:codex-acp",
          kind: "codex",
          label: "Codex",
          status: "available",
        },
        {
          capabilities: { sessionMcpServers: true },
          command: ["npx", "--yes", "@agentclientprotocol/claude-agent-acp@0.39.0"],
          id: "claude-code:claude-acp",
          kind: "claude-code",
          label: "Claude Code",
          status: "available",
        },
      ],
    })

    await manager.handleQueueItem({
      agentSessionId: "agent-session-1",
      bridgeProfileId: "codex:codex-acp",
      id: "queue-codex",
      prompt: "hello",
      threadId: "thread-1",
      type: "prompt",
    })
    await manager.handleQueueItem({
      agentSessionId: "agent-session-1",
      bridgeProfileId: "claude-code:claude-acp",
      id: "queue-claude",
      prompt: "hello",
      threadId: "thread-1",
      type: "prompt",
    })

    expect(contexts.map((context) => context.bridgeProfileId)).toEqual([
      "codex:codex-acp",
      "claude-code:claude-acp",
    ])
    expect(contexts.map((context) => context.agentCommand)).toEqual([
      ["npx", "--yes", "@zed-industries/codex-acp@0.15.0"],
      ["npx", "--yes", "@agentclientprotocol/claude-agent-acp@0.39.0"],
    ])
    expect(closedProfiles).toContain("codex:codex-acp")
    expect(cloud.results.at(-1)).toMatchObject({
      id: "queue-claude",
      result: { ok: true, text: "claude-code:claude-acp" },
    })
    expect(manager.getStatus().sessions).toEqual([
      expect.objectContaining({
        runtimeKind: "claude-code",
        runtimeLabel: "Claude Code",
        runtimeProfileId: "claude-code:claude-acp",
      }),
    ])
  })

  test("waits for a starting ACP session before handling an approval response", async () => {
    const promptStarted = deferred<void>()
    const finishPrompt = deferred<void>()
    const permissionResponses: Array<{ id: string; approved: boolean }> = []
    const cloud = fakeCloudClient()
    const manager = new BridgeSessionManager({
      cloudClient: cloud,
      createSession: () => ({
        close: async () => {},
        cancel: async () => {},
        respondToPermissionRequest: async (id, response) => {
          permissionResponses.push({ id, approved: response.approved })
          return true
        },
        sendUserMessage: async () => {
          promptStarted.resolve()
          await finishPrompt.promise
          return {
            events: [],
            rawResult: {},
            sessionId: "session-1",
            text: "ok",
          }
        },
      }),
    })

    const prompt = manager.handleQueueItem({
      id: "queue-prompt",
      prompt: "hello",
      threadId: "thread-1",
      type: "prompt",
    })

    await manager.handleQueueItem({
      approvalOutcome: "approved",
      externalRequestId: "request-1",
      id: "queue-approval",
      threadId: "thread-1",
      type: "permission-response",
    })

    expect(permissionResponses).toEqual([{ id: "request-1", approved: true }])
    expect(cloud.results.at(-1)).toMatchObject({
      id: "queue-approval",
      result: { ok: true, approved: true },
    })

    await promptStarted.promise
    finishPrompt.resolve()
    await prompt
  })
})

function fakeCloudClient() {
  const events: Array<Array<{ normalizedPayload?: unknown }>> = []
  const results: Array<{ id: string; result: unknown }> = []
  return {
    events,
    results,
    appendEvents: async <TResponse = Record<string, unknown>>(
      input: Array<{ normalizedPayload?: unknown }>,
    ) => {
      events.push(input)
      return {} as TResponse
    },
    markResult: async <TResponse = Record<string, unknown>>(id: string, result: unknown) => {
      results.push({ id, result })
      return {} as TResponse
    },
  }
}

function fakeSession() {
  return {
    close: async () => {},
    cancel: async () => {},
    sendUserMessage: async () => ({
      events: [],
      rawResult: {},
      sessionId: "session-1",
      text: "ok",
    }),
  }
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve
    reject = promiseReject
  })
  return { promise, reject, resolve }
}
