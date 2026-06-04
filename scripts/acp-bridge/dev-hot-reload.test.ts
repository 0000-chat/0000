import { describe, expect, test } from "bun:test"

import { shouldRestartBridgeForDevHotReload } from "./dev-hot-reload"

describe("dev bridge hot reload policy", () => {
  test("restarts immediately when only idle ACP sessions are present", () => {
    expect(
      shouldRestartBridgeForDevHotReload({
        activeSessions: ["idle-session"],
        inFlightCommands: [],
        sessionQueues: [{ sessionKey: "idle-session", threadId: "thread", queueDepth: 0 }],
      }),
    ).toEqual({ ready: true })
  })

  test("waits while queue work is in flight", () => {
    expect(
      shouldRestartBridgeForDevHotReload({
        activeSessions: ["busy-session"],
        inFlightCommands: [{ id: "queue-1", startedAt: "2026-06-02T00:00:00.000Z" }],
        sessionQueues: [],
      }),
    ).toEqual({ ready: false, reason: "in_flight_commands" })
  })

  test("waits while a session queue has running work", () => {
    expect(
      shouldRestartBridgeForDevHotReload({
        activeSessions: ["busy-session"],
        inFlightCommands: [],
        sessionQueues: [
          {
            sessionKey: "busy-session",
            threadId: "thread",
            queueDepth: 1,
            runningQueueItemId: "queue-1",
          },
        ],
      }),
    ).toEqual({ ready: false, reason: "session_queue_busy" })
  })
})
