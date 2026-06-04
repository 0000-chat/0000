import { describe, expect, test } from "bun:test"
import {
  capabilitiesFromInitializeResult,
  discoverRuntimeProfiles,
  runtimeDiscoveryEnv,
} from "./runtime-discovery"

const noDiscoveredCommands = async () => []

describe("runtime discovery", () => {
  test("extracts runtime nuance capabilities from ACP initialize results", () => {
    expect(
      capabilitiesFromInitializeResult({
        agentCapabilities: {
          loadSession: true,
          sessionCapabilities: { cancel: {}, close: {}, resume: {} },
        },
        runtimeCapabilities: {
          maxSessions: 4,
          runtimeConfigOptions: {
            model: ["gpt-5.5"],
            thoughtLevel: ["medium", "high"],
          },
          sharedGatewayKey: true,
          sessionIsolation: "unverified",
          structuredInteractions: true,
        },
      }),
    ).toEqual({
      maxSessions: 4,
      models: ["gpt-5.5"],
      runtimeConfigOptions: {
        model: ["gpt-5.5"],
        thoughtLevel: ["medium", "high"],
      },
      sessionIsolation: "unverified",
      sharedGatewayKey: true,
      supportsCancel: true,
      supportsClose: true,
      supportsResume: true,
      supportsStructuredInteractions: true,
      thoughtLevels: ["medium", "high"],
    })
  })

  test("adds common user tool directories to child process PATH", () => {
    const env = runtimeDiscoveryEnv({ HOME: "/home/dev", PATH: "/usr/bin", TERM: "dumb" })

    expect(env.PATH?.split(":").slice(0, 4)).toEqual([
      "/home/dev/.volta/bin",
      "/home/dev/.bun/bin",
      "/home/dev/.local/bin",
      "/usr/bin",
    ])
    expect(env.TERM).toBe("xterm-256color")
  })

  test("discovers Codex with context-mode diagnostics", async () => {
    const profiles = await discoverRuntimeProfiles({
      baseAgentCommand: "hermes acp",
      discoverAcpCommands: async () => [
        { name: "status", description: "Show session status" },
        { name: "plan", description: "Create a plan", inputHint: "task" },
      ],
      probeAcpCommand: async () => ({
        ok: true,
        capabilities: {
          models: ["gpt-5.5", "gpt-5.4"],
          thoughtLevels: ["medium", "high"],
          supportsCancel: true,
        },
      }),
      runCommand: async (command) => {
        const key = command.join(" ")
        if (key === "command -v npx") {
          return { ok: true, stdout: "/usr/bin/npx\n" }
        }
        if (key === "codex --version") {
          return { ok: true, stdout: "codex-cli 1.0.0\n" }
        }
        if (key === "codex mcp list") {
          return { ok: true, stdout: "context-mode enabled\n0000-chat enabled\n" }
        }
        if (key === "command -v context-mode") {
          return { ok: true, stdout: "/usr/local/bin/context-mode\n" }
        }
        if (key === "command -v hermes") {
          return { ok: false, stdout: "", stderr: "" }
        }
        return { ok: false, stdout: "", stderr: "" }
      },
    })

    const codex = profiles.find((profile) => profile.kind === "codex")
    expect(codex).toMatchObject({
      id: "codex:codex-acp",
      command: ["npx", "--yes", "@zed-industries/codex-acp@0.15.0"],
      diagnostics: { acp: "supported", contextMode: "available", mcpServers: 2 },
      capabilities: { nativeSkills: true, nativeHooks: true, nativeMcp: true },
    })
    expect(codex?.availableCommands).toEqual([
      { name: "status", description: "Show session status" },
      { name: "plan", description: "Create a plan", inputHint: "task" },
    ])
    expect(codex).toMatchObject({
      models: ["gpt-5.5", "gpt-5.4"],
      thoughtLevels: ["medium", "high"],
      capabilityProvenance: {
        modelSelection: { source: "native" },
        thoughtLevelSelection: { source: "native" },
        cancelTurn: { nativeMethod: "session/cancel", source: "native" },
      },
    })
  })

  test("discovers Claude Code through the ACP adapter", async () => {
    const profiles = await discoverRuntimeProfiles({
      baseAgentCommand: "hermes acp",
      discoverAcpCommands: noDiscoveredCommands,
      probeAcpCommand: async () => ({
        ok: true,
        capabilities: {
          supportsClose: false,
          supportsResume: false,
          supportsStructuredInteractions: true,
        },
      }),
      runCommand: async (command) => {
        const key = command.join(" ")
        if (key === "command -v npx") {
          return { ok: true, stdout: "/usr/bin/npx\n" }
        }
        return { ok: false, stdout: "", stderr: "" }
      },
    })

    expect(profiles.find((profile) => profile.kind === "claude-code")).toMatchObject({
      id: "claude-code:claude-acp",
      label: "Claude Code",
      command: ["npx", "--yes", "@agentclientprotocol/claude-agent-acp@0.39.0"],
      diagnostics: { acp: "supported" },
      capabilities: { sessionMcpServers: true },
      capabilityProvenance: {
        closeSession: {
          diagnosticReasonCode: "session_close_unsupported",
          source: "unsupported",
        },
        resumeSession: {
          diagnosticReasonCode: "session_resume_failed",
          source: "fallback",
        },
        structuredInteractions: { source: "native" },
      },
    })
    expect(profiles.some((profile) => profile.command.join(" ") === "claude acp")).toBe(false)
  })

  test("uses bunx for package adapter runtimes when npx is unavailable", async () => {
    const profiles = await discoverRuntimeProfiles({
      baseAgentCommand: "hermes acp",
      discoverAcpCommands: noDiscoveredCommands,
      probeAcpCommand: async () => ({ ok: true }),
      runCommand: async (command) => {
        const key = command.join(" ")
        if (key === "command -v npx") {
          return { ok: false, stdout: "", stderr: "" }
        }
        if (key === "command -v bunx") {
          return { ok: true, stdout: "/home/dev/.bun/bin/bunx\n" }
        }
        return { ok: false, stdout: "", stderr: "" }
      },
    })

    expect(profiles.find((profile) => profile.kind === "claude-code")).toMatchObject({
      id: "claude-code:claude-acp",
      command: ["bunx", "--yes", "@agentclientprotocol/claude-agent-acp@0.39.0"],
      status: "available",
    })
  })

  test("does not synthesize a Hermes profile for non-Hermes base commands", async () => {
    const profiles = await discoverRuntimeProfiles({
      baseAgentCommand: "npx --yes @zed-industries/codex-acp@latest",
      discoverAcpCommands: noDiscoveredCommands,
      probeAcpCommand: async () => ({ ok: true }),
      runCommand: async (command) => {
        if (command.join(" ") === "command -v npx") {
          return { ok: true, stdout: "/usr/bin/npx\n" }
        }
        return { ok: false, stdout: "", stderr: "" }
      },
    })

    expect(profiles.some((profile) => profile.id === "hermes:default")).toBe(false)
    expect(profiles.some((profile) => profile.id === "codex:codex-acp")).toBe(true)
  })

  test("marks runtimes unavailable when the ACP handshake probe fails", async () => {
    const profiles = await discoverRuntimeProfiles({
      baseAgentCommand: "hermes acp",
      discoverAcpCommands: noDiscoveredCommands,
      probeAcpCommand: async () => ({ ok: false, reason: "initialize timed out" }),
      runCommand: async (command) => {
        if (command.join(" ") === "command -v npx") {
          return { ok: true, stdout: "/usr/bin/npx\n" }
        }
        return { ok: false, stdout: "", stderr: "" }
      },
    })

    expect(profiles.find((profile) => profile.kind === "codex")).toMatchObject({
      id: "codex:codex-acp",
      status: "unavailable",
      diagnostics: { acp: "unsupported", reason: "initialize timed out" },
    })
  })

  test("keeps unavailable profiles isolated", async () => {
    const profiles = await discoverRuntimeProfiles({
      baseAgentCommand: "hermes acp",
      discoverAcpCommands: noDiscoveredCommands,
      probeAcpCommand: async () => ({ ok: true }),
      runCommand: async (command) => {
        if (command.join(" ") === "command -v npx") {
          return { ok: false, stdout: "", stderr: "" }
        }
        if (command.join(" ") === "command -v hermes") {
          return { ok: true, stdout: "/usr/bin/hermes\n" }
        }
        return { ok: false, stdout: "", stderr: "" }
      },
    })

    expect(profiles.some((profile) => profile.id === "hermes:default")).toBe(true)
    expect(profiles.some((profile) => profile.kind === "codex")).toBe(false)
  })

  test("includes custom ACP commands when provided", async () => {
    const profiles = await discoverRuntimeProfiles({
      baseAgentCommand: "hermes acp",
      customCommands: [["my-agent", "acp"]],
      discoverAcpCommands: noDiscoveredCommands,
      probeAcpCommand: async () => ({ ok: true }),
      runCommand: async (command) => {
        if (command.join(" ") === "command -v my-agent") {
          return { ok: true, stdout: "/opt/bin/my-agent\n" }
        }
        if (command.join(" ") === "command -v hermes") {
          return { ok: false, stdout: "", stderr: "" }
        }
        if (command.join(" ") === "command -v npx") {
          return { ok: false, stdout: "", stderr: "" }
        }
        return { ok: false, stdout: "", stderr: "" }
      },
    })

    expect(profiles.find((profile) => profile.kind === "unknown-acp")).toMatchObject({
      command: ["my-agent", "acp"],
      status: "available",
      capabilities: { sessionMcpServers: true },
    })
  })

  test("publishes Hermes cwd-bound session behavior and max session limits", async () => {
    const profiles = await discoverRuntimeProfiles({
      baseAgentCommand: "hermes acp",
      discoverAcpCommands: noDiscoveredCommands,
      probeAcpCommand: async () => ({
        ok: true,
        capabilities: { cwdBoundSessions: true, maxSessions: 3, supportsResume: true },
      }),
      runCommand: async (command) => {
        if (command.join(" ") === "command -v hermes") {
          return { ok: true, stdout: "/usr/bin/hermes\n" }
        }
        return { ok: false, stdout: "", stderr: "" }
      },
    })

    expect(profiles.find((profile) => profile.kind === "hermes")).toMatchObject({
      maxSessions: 3,
      identityRules: {
        cwdBoundSessions: true,
        cwdSwitchPolicy: "new_session_required",
      },
      capabilityProvenance: {
        maxSessions: { source: "native", value: 3 },
        resumeSession: { source: "native" },
      },
    })
  })

  test("degrades OpenClaw shared gateway profiles without proven session isolation", async () => {
    const profiles = await discoverRuntimeProfiles({
      baseAgentCommand: "hermes acp",
      discoverAcpCommands: noDiscoveredCommands,
      probeAcpCommand: async () => ({
        ok: true,
        capabilities: { sharedGatewayKey: true, sessionIsolation: "unverified" },
      }),
      runCommand: async (command) => {
        if (command.join(" ") === "command -v openclaw") {
          return { ok: true, stdout: "/usr/bin/openclaw\n" }
        }
        return { ok: false, stdout: "", stderr: "" }
      },
    })

    expect(profiles.find((profile) => profile.kind === "openclaw")).toMatchObject({
      diagnostics: { reason: "runtime_isolation_unverified" },
      identityRules: {
        appIdentityFromMeta: false,
        scopeSessionKeyByThread: true,
      },
      capabilityProvenance: {
        sessionIsolation: {
          diagnosticReasonCode: "runtime_isolation_unverified",
          source: "fallback",
        },
      },
    })
  })
})
