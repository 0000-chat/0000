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
})

function fakeCloudClient() {
  const events: Array<Array<{ normalizedPayload?: unknown }>> = []
  return {
    events,
    appendEvents: async <TResponse = Record<string, unknown>>(
      input: Array<{ normalizedPayload?: unknown }>,
    ) => {
      events.push(input)
      return {} as TResponse
    },
    markResult: async <TResponse = Record<string, unknown>>() => ({}) as TResponse,
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
