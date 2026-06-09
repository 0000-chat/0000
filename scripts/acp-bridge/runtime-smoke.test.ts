import { describe, expect, test } from "bun:test"

import { buildRuntimeSmokeMatrix, formatRuntimeSmokeMatrix } from "./runtime-smoke"
import type { BridgeRuntimeProfile } from "./runtime-profiles"

const profile = (overrides: Partial<BridgeRuntimeProfile>): BridgeRuntimeProfile => ({
  id: "codex:npx-agentclientprotocol-codex-acp",
  kind: "codex",
  label: "Codex",
  command: ["npx", "--yes", "@agentclientprotocol/codex-acp@0.0.45"],
  status: "available",
  diagnostics: { acp: "supported" },
  availableCommands: [],
  capabilities: { sessionMcpServers: true },
  ...overrides,
})

describe("runtime smoke matrix", () => {
  test("marks supported discovered ACP runtimes as pass", async () => {
    const matrix = await buildRuntimeSmokeMatrix({
      host: "smoke-host",
      now: () => new Date("2026-06-05T00:00:00.000Z"),
      discover: async () => [
        profile({
          availableCommands: [{ name: "status" }],
          capabilities: { sessionMcpServers: true, supportsCancel: true },
          models: ["gpt-5.5"],
          thoughtLevels: ["medium", "high"],
        }),
      ],
    })

    const codex = matrix.rows.find((row) => row.runtime === "codex")
    expect(codex).toMatchObject({
      status: "pass",
      acp: "supported",
      availableCommands: 1,
      capabilities: { models: ["gpt-5.5"], supportsCancel: true },
    })
    expect(matrix.summary).toEqual({ pass: 1, fail: 0, blocked: 3 })
  })

  test("separates ACP probe failures from missing runtime blocks", async () => {
    const matrix = await buildRuntimeSmokeMatrix({
      discover: async () => [
        profile({
          kind: "hermes",
          label: "Hermes",
          command: ["hermes", "acp"],
          status: "unavailable",
          diagnostics: { acp: "unsupported", reason: "ACP initialize probe timed out" },
        }),
      ],
    })

    const hermes = matrix.rows.find((row) => row.runtime === "hermes")
    const openclaw = matrix.rows.find((row) => row.runtime === "openclaw")
    expect(hermes).toMatchObject({
      status: "fail",
      reason: "ACP initialize probe timed out",
    })
    expect(openclaw).toMatchObject({
      status: "blocked",
      reason: "runtime binary or profile was not discovered",
    })
  })

  test("includes custom commands in the matrix", async () => {
    const matrix = await buildRuntimeSmokeMatrix({
      customCommands: [["custom-acp", "--stdio"]],
      discover: async () => [
        profile({
          id: "unknown-acp:custom-acp-stdio",
          kind: "unknown-acp",
          label: "custom-acp --stdio",
          command: ["custom-acp", "--stdio"],
          status: "available",
          diagnostics: { acp: "supported" },
        }),
      ],
    })

    expect(matrix.rows.find((row) => row.label === "custom-acp --stdio")).toMatchObject({
      status: "pass",
      runtime: "custom-acp",
    })
  })

  test("formats a redacted markdown table for docs and handoff notes", async () => {
    const matrix = await buildRuntimeSmokeMatrix({
      host: "smoke-host",
      now: () => new Date("2026-06-05T00:00:00.000Z"),
      discover: async () => [profile({})],
    })

    expect(formatRuntimeSmokeMatrix(matrix)).toContain(
      "Summary: 1 pass, 0 fail, 3 blocked",
    )
    expect(formatRuntimeSmokeMatrix(matrix)).toContain("| Codex | pass | supported |")
  })
})
