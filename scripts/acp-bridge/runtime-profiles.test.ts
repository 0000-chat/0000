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
      classificationSource: "generic_policy",
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
        toolKind: "other",
        toolName: "delegate: inspect OpenUI primitives",
      }),
    ).toMatchObject({
      classificationSource: "runtime_policy",
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
      classificationSource: "generic_policy",
      policyId: "generic-long-running-tool",
      timeoutMs: DEFAULT_LONG_RUNNING_TOOL_RESULT_TIMEOUT_MS,
      toolClass: "long_running",
    })
  })

  test("classifies foreground terminal test and typecheck variants as long-running", () => {
    const profile: BridgeRuntimeProfile = {
      capabilities: {},
      command: ["hermes", "acp"],
      id: "hermes:test",
      kind: "hermes",
      label: "Hermes",
      status: "available",
    }

    for (const toolName of [
      "terminal: bunx vitest run src/routes/__tests__/debug-auth-redirects.test.tsx",
      "terminal: bun run e2e e2e/dev-auth-bypass.spec.ts",
      "terminal: TSC_GUARD_LOCK_DIR=/home/empath/.cache/tsc-semaphore bun run --cwd apps/app typecheck:fast apps/app/src/routes/login.tsx",
      "terminal: playwright test \"e2e/dev-auth-bypass.spec.ts\"",
    ]) {
      expect(
        resolveToolCallTimeoutPolicy({
          defaultTimeoutMs: 300_000,
          profile,
          toolName,
        }),
      ).toEqual({
        classificationSource: "generic_policy",
        policyId: "generic-long-running-tool",
        timeoutMs: DEFAULT_LONG_RUNNING_TOOL_RESULT_TIMEOUT_MS,
        toolClass: "long_running",
      })
    }
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
        classificationSource: "generic_policy",
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
      classificationSource: "explicit_timeout",
      policyId: "explicit-tool-result-timeout",
      timeoutMs: 5,
      toolClass: "standard",
    })
  })

  test("keeps structured ordinary tools standard regardless of title prose", () => {
    const profile: BridgeRuntimeProfile = {
      capabilities: {},
      command: ["hermes", "acp"],
      compatibility: hermesRuntimeCompatibility(),
      id: "hermes:test",
      kind: "hermes",
      label: "Hermes",
      status: "available",
    }

    for (const input of [
      { toolKind: "read", toolName: "read: docs/workflow.md" },
      { toolKind: "read", toolName: "read: notes/background-workers.md" },
      { toolKind: "search", toolName: "search: subagent workflow" },
      { toolKind: "execute", toolName: "background worker task" },
    ]) {
      expect(
        resolveToolCallTimeoutPolicy({
          defaultTimeoutMs: 300_000,
          profile,
          ...input,
        }),
      ).toEqual({
        classificationSource: "structured_kind",
        policyId: "structured-standard-tool",
        timeoutMs: 300_000,
        toolClass: "standard",
      })
    }
  })

  test("keeps structured execute tools eligible for long-running terminal policy", () => {
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
        toolKind: "execute",
        toolName: "terminal: bun run quality:changed",
      }),
    ).toEqual({
      classificationSource: "generic_policy",
      policyId: "generic-long-running-tool",
      timeoutMs: DEFAULT_LONG_RUNNING_TOOL_RESULT_TIMEOUT_MS,
      toolClass: "long_running",
    })
  })
})
