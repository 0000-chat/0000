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
})

function fakeCloudClient() {
  return {
    appendEvents: async <TResponse = Record<string, unknown>>() => ({}) as TResponse,
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
