import { describe, expect, test } from "bun:test"

import { createWorkerBridgeLogger, redactLogValue } from "./hermes-bridge/bridge-log"

describe("bridge log privacy", () => {
  test("redacts sensitive object fields and nested prompt content", () => {
    expect(
      redactLogValue({
        authorization: "Bearer live-token",
        nested: {
          bridgeToken: "bridge-token",
          prompt: "read my private files",
        },
        ok: "visible",
      }),
    ).toEqual({
      authorization: "[redacted]",
      nested: {
        bridgeToken: "[redacted]",
        prompt: "[redacted]",
      },
      ok: "visible",
    })
  })

  test("redacts sensitive strings before worker log delivery", async () => {
    const deliveries: unknown[] = []
    const stderrWrites: string[] = []
    const logger = createWorkerBridgeLogger({
      bridgeToken: "worker-token",
      deviceId: "bridge-1",
      fetch: (async (_url, init) => {
        deliveries.push(JSON.parse(String(init?.body)))
        return new Response(null, { status: 204 })
      }) as typeof fetch,
      flushIntervalMs: 10_000,
      logUrl: "https://0000.chat/api/agent-bridge/logs",
      stderr: {
        write(chunk: string) {
          stderrWrites.push(chunk)
          return true
        },
      } as NodeJS.WritableStream,
    })

    logger({
      event: "bridge.audit",
      level: "info",
      message: "authorization: Bearer secret-token prompt=hello bridgeToken=abc123",
      prompt: "raw prompt",
    })
    await logger.flush()

    const serializedDelivery = JSON.stringify(deliveries)
    const serializedStderr = stderrWrites.join("")
    expect(serializedDelivery).not.toContain("secret-token")
    expect(serializedDelivery).not.toContain("raw prompt")
    expect(serializedDelivery).toContain("[redacted]")
    expect(serializedStderr).not.toContain("secret-token")
    expect(serializedStderr).not.toContain("raw prompt")
  })
})
