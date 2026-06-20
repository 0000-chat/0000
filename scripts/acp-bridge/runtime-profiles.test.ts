import { describe, expect, test } from "bun:test"

import {
  DEFAULT_LONG_RUNNING_TOOL_RESULT_TIMEOUT_MS,
  hermesRuntimeCompatibility,
  resolveToolCallTimeoutPolicy,
  type BridgeRuntimeProfile,
} from "./runtime-profiles"

describe("runtime profile compatibility", () => {
  test("classifies common subagent tool names as long-running without runtime-specific configuration", () => {
    const profile: BridgeRuntimeProfile = {
      capabilities: {},
      command: ["codex", "acp"],
      id: "codex:test",
      kind: "codex",
      label: "Codex",
      status: "available",
    }

    expect(
      resolveToolCallTimeoutPolicy({
        defaultTimeoutMs: 300_000,
        profile,
        toolName: "agent.run",
      }),
    ).toEqual({
      policyId: "generic-subagent-tool",
      timeoutMs: DEFAULT_LONG_RUNNING_TOOL_RESULT_TIMEOUT_MS,
      toolClass: "subagent",
    })
  })

  test("lets runtime profiles adapt provider-specific subagent tool names", () => {
    const profile: BridgeRuntimeProfile = {
      capabilities: {},
      command: ["hermes", "acp"],
      compatibility: hermesRuntimeCompatibility(),
      id: "hermes:test",
      kind: "hermes",
      label: "Hermes",
      status: "available",
    }

    expect(
      resolveToolCallTimeoutPolicy({
        defaultTimeoutMs: 300_000,
        profile,
        toolName: "delegate: inspect OpenUI primitives",
      }),
    ).toMatchObject({
      policyId: "hermes-delegate-subagent",
      timeoutMs: DEFAULT_LONG_RUNNING_TOOL_RESULT_TIMEOUT_MS,
      toolClass: "subagent",
    })
  })

  test("keeps explicit bridge tool timeout overrides authoritative", () => {
    const profile: BridgeRuntimeProfile = {
      capabilities: {},
      command: ["hermes", "acp"],
      compatibility: hermesRuntimeCompatibility(),
      id: "hermes:test",
      kind: "hermes",
      label: "Hermes",
      status: "available",
    }

    expect(
      resolveToolCallTimeoutPolicy({
        defaultTimeoutMs: 5,
        explicitTimeoutMs: 5,
        profile,
        toolName: "delegate_task",
      }),
    ).toEqual({
      policyId: "explicit-tool-result-timeout",
      timeoutMs: 5,
      toolClass: "standard",
    })
  })
})
