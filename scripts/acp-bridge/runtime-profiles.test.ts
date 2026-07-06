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

  test("classifies terminal quality commands as long-running", () => {
    const profile: BridgeRuntimeProfile = {
      capabilities: {},
      command: ["hermes", "acp"],
      id: "hermes:test",
      kind: "hermes",
      label: "Hermes",
      status: "available",
    }

    expect(
      resolveToolCallTimeoutPolicy({
        defaultTimeoutMs: 300_000,
        profile,
        toolName: "terminal: bun run quality:changed",
      }),
    ).toEqual({
      policyId: "generic-long-running-tool",
      timeoutMs: DEFAULT_LONG_RUNNING_TOOL_RESULT_TIMEOUT_MS,
      toolClass: "long_running",
    })
  })

  test("classifies terminal work push commands as long-running", () => {
    const profile: BridgeRuntimeProfile = {
      capabilities: {},
      command: ["hermes", "acp"],
      id: "hermes:test",
      kind: "hermes",
      label: "Hermes",
      status: "available",
    }

    for (const toolName of [
      "terminal: bun run work:push",
      "terminal: export TSC_GUARD_LOCK_DIR=/tmp/locks && bun run work:push",
      "terminal: git rev-list --left-right --count origin/main...main && bun run work:push",
    ]) {
      expect(
        resolveToolCallTimeoutPolicy({
          defaultTimeoutMs: 300_000,
          profile,
          toolName,
        }),
      ).toEqual({
        policyId: "generic-long-running-tool",
        timeoutMs: DEFAULT_LONG_RUNNING_TOOL_RESULT_TIMEOUT_MS,
        toolClass: "long_running",
      })
    }
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
