import { describe, expect, test } from "bun:test"

import { checkBridgeObservability } from "./observability-check"

describe("bridge observability guard", () => {
  test("allows registered bridge events", () => {
    const reports = checkBridgeObservability({
      files: ["scripts/acp-bridge.ts"],
      readFile: () => `log({ event: "bridge.start", level: "info" })`,
    })

    expect(reports).toEqual([])
  })

  test("rejects unregistered bridge events", () => {
    const reports = checkBridgeObservability({
      files: ["scripts/acp-bridge.ts"],
      readFile: () => `log({ event: "bridge.mystery", level: "info" })`,
    })

    expect(reports).toEqual([
      "scripts/acp-bridge.ts references unregistered bridge log event bridge.mystery",
    ])
  })

  test("rejects raw console usage in bridge source", () => {
    const reports = checkBridgeObservability({
      files: ["scripts/acp-bridge.ts"],
      readFile: () => `console.error("bad")`,
    })

    expect(reports[0]).toContain("uses raw console.error")
  })

  test("rejects sensitive log-like fields outside the logger boundary", () => {
    const reports = checkBridgeObservability({
      files: ["scripts/acp-bridge.ts"],
      readFile: () => `log({ event: "bridge.start", level: "info", bridgeToken: "secret" })`,
    })

    expect(reports[0]).toContain("sensitive log-like field names")
  })
})
