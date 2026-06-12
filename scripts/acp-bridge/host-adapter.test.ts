import { describe, expect, test } from "bun:test"

import { ConvexBridgeCloudClient } from "./convex-http"
import { ConvexBridgeHostAdapter, type BridgeHostWorkItem } from "./host-adapter"

describe("bridge host adapter boundary", () => {
  test("wraps Convex transport methods behind the host adapter interface", async () => {
    const calls: Array<{ method: string; args: unknown[] }> = []
    const transport = {
      appendEvents: async (...args: unknown[]) => record(calls, "appendEvents", args, { ok: true }),
      claimWork: async (...args: unknown[]) =>
        record(calls, "claimWork", args, {
          commands: [
            {
              agentSessionId: "session-1",
              claimId: "claim-1",
              id: "queue-1",
              kind: "prompt",
              leaseUntil: 123,
              threadId: "thread-1",
            },
          ],
        }),
      cleanupStaleClaims: async (...args: unknown[]) =>
        record(calls, "cleanupStaleClaims", args, { released: 1 }),
      heartbeat: async (...args: unknown[]) => record(calls, "heartbeat", args, { ok: true }),
      markResult: async (...args: unknown[]) => record(calls, "markResult", args, { ok: true }),
    }
    const adapter = new ConvexBridgeHostAdapter(transport)

    await adapter.heartbeat({ status: { connected: true } })
    const claimed = await adapter.claimWork({ limit: 1 })
    await adapter.appendEvents({
      events: [
        {
          eventType: "agent.message.delta",
          rawPayload: { text: "hello" },
          sequence: 1,
          threadId: "thread-1",
        },
      ],
    })
    const diagnosticsResult = await adapter.appendDiagnostics({
      diagnostics: [{ message: "ok", reasonCode: "bridge.config.loaded", traceId: "trace-1" }],
    })
    await adapter.completeWork({ claimId: "claim-1", result: { ok: true }, workItem: claimed.workItems[0]! })
    await adapter.releaseWork({
      claimId: "claim-1",
      reason: "runtime stopped",
      workItem: claimed.workItems[0]!,
    })
    await adapter.answerInteraction({
      approved: true,
      claimId: "claim-interaction",
      externalRequestId: "permission-1",
      interactionId: "interaction-1",
      threadId: "thread-1",
    })

    expect(calls.map((call) => call.method)).toEqual([
      "heartbeat",
      "claimWork",
      "appendEvents",
      "markResult",
      "markResult",
      "markResult",
    ])
    expect(diagnosticsResult).toEqual({ ok: true, skipped: 1 })
    expect(calls[3]?.args).toEqual(["queue-1", { ok: true, claimId: "claim-1" }, "claim-1"])
    expect(calls[4]?.args).toEqual([
      "queue-1",
      { claimId: "claim-1", error: "runtime stopped", ok: false, retryable: true },
      "claim-1",
    ])
  })

  test("preserves transport method context for Convex client methods", async () => {
    class ContextSensitiveTransport {
      private readonly ok = true

      async claimWork() {
        if (!this.ok) {
          throw new Error("missing method context")
        }
        return { commands: [] }
      }
    }

    const adapter = new ConvexBridgeHostAdapter(new ContextSensitiveTransport())

    await expect(adapter.claimWork()).resolves.toEqual({ raw: { commands: [] }, workItems: [] })
  })

  test("normalizes claimed Convex commands into host work items", async () => {
    const adapter = new ConvexBridgeHostAdapter({
      claimWork: async () => ({
        commands: [
          {
            claimId: "claim-1",
            effectiveSessionCap: 2,
            hostIssuedAt: 10,
            id: "queue-1",
            kind: "prompt",
            leaseUntil: 20,
            runtimeConfig: { model: "gpt-5.5" },
            targetResourceState: "active",
            threadId: "thread-1",
          },
        ],
      }),
    })

    const result = await adapter.claimWork()
    expect(result.workItems).toEqual([
      {
        agentSessionId: undefined,
        claimId: "claim-1",
        command: expect.any(Object),
        effectiveSessionCap: 2,
        hostIssuedAt: 10,
        id: "queue-1",
        kind: "prompt",
        leaseUntil: 20,
        runtimeConfig: { model: "gpt-5.5" },
        targetResourceState: "active",
        threadId: "thread-1",
      } satisfies BridgeHostWorkItem,
    ])
  })

  test("real Convex transport sends claimId as the queue result fence", async () => {
    let body: Record<string, unknown> | undefined
    const client = new ConvexBridgeCloudClient({
      appUrl: "https://app.example.test",
      bridgeApiUrl: "https://bridge.example.test",
      bridgeToken: "secret",
      deviceId: "device-1",
      fetch: async (_input, init) => {
        body = JSON.parse(String(init?.body)) as Record<string, unknown>
        return Response.json({ ok: true })
      },
    })

    await client.markResult("queue-1", { ok: true, claimId: "claim-1" })

    expect(body).toMatchObject({
      claimId: "claim-1",
      commandId: "queue-1",
      deviceId: "device-1",
      result: { ok: true, claimId: "claim-1" },
    })
  })

  test("real Convex transport rejects queue results without claimId", async () => {
    const client = new ConvexBridgeCloudClient({
      appUrl: "https://app.example.test",
      bridgeToken: "secret",
      deviceId: "device-1",
      fetch: async () => Response.json({ ok: true }),
    })

    await expect(client.markResult("queue-1", { ok: true })).rejects.toThrow("claimId is required")
  })
})

function record<TResponse>(
  calls: Array<{ method: string; args: unknown[] }>,
  method: string,
  args: unknown[],
  response: TResponse,
): TResponse {
  calls.push({ args, method })
  return response
}
