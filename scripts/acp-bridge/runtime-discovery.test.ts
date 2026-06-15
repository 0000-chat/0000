import { chmod, mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, test } from "bun:test"
import {
  capabilitiesFromInitializeResult,
  discoverRuntimeProfiles,
  resolveExecutableForSpawn,
  runtimeDiscoveryEnv,
} from "./runtime-discovery"

const noDiscoveredCommands = async () => []

describe("runtime discovery", () => {
  test("resolves ACP executables before the Bun node proxy can lose shim PATH entries", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "acp-runtime-bin-"))
    const executablePath = join(tempDir, "shim-runtime")
    await writeFile(executablePath, "#!/bin/sh\nexit 0\n")
    await chmod(executablePath, 0o755)

    expect(resolveExecutableForSpawn("shim-runtime", { PATH: tempDir })).toBe(executablePath)
    expect(resolveExecutableForSpawn(executablePath, { PATH: "" })).toBe(executablePath)
  })

  test("extracts runtime nuance capabilities from ACP initialize results", () => {
    expect(
      capabilitiesFromInitializeResult({
        agentCapabilities: {
          auth: { logout: {} },
          loadSession: true,
          sessionCapabilities: { cancel: {}, close: {}, delete: {}, fork: {}, list: {}, resume: {} },
        },
        protocolVersion: 1,
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
      sdkProtocolVersion: "1",
      supportsAuth: true,
      supportsCancel: true,
      supportsClose: true,
      supportsLogout: true,
      supportsResume: true,
      supportsSessionDelete: true,
      supportsSessionFork: true,
      supportsSessionList: true,
      supportsSessionResume: true,
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
        if (key === "command -v bunx") {
          return { ok: true, stdout: "/usr/bin/bunx\n" }
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
      command: ["bunx", "@zed-industries/codex-acp@0.16.0"],
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
      command: ["bunx", "@agentclientprotocol/claude-agent-acp@0.39.0"],
      status: "available",
    })
  })

  test("does not fall back to retired Codex ACP package when Zed Codex probe fails", async () => {
    const probeCalls: string[] = []
    const profiles = await discoverRuntimeProfiles({
      baseAgentCommand: "hermes acp",
      discoverAcpCommands: noDiscoveredCommands,
      probeAcpCommand: async (command) => {
        const key = command.join(" ")
        probeCalls.push(key)
        if (key === "bunx @zed-industries/codex-acp@0.16.0") {
          return { ok: false, reason: "sh: codex-acp: command not found" }
        }
        return { ok: true }
      },
      runCommand: async (command) => {
        const key = command.join(" ")
        if (key === "command -v npx") {
          return { ok: true, stdout: "/home/dev/.volta/bin/npx\n" }
        }
        if (key === "command -v bunx") {
          return { ok: true, stdout: "/home/dev/.bun/bin/bunx\n" }
        }
        if (key === "codex --version") {
          return { ok: true, stdout: "codex-cli 1.0.0\n" }
        }
        if (key === "codex mcp list") {
          return { ok: true, stdout: "" }
        }
        return { ok: false, stdout: "", stderr: "" }
      },
    })

    expect(probeCalls).toContain("bunx @zed-industries/codex-acp@0.16.0")
    expect(probeCalls).not.toContain("bunx --yes @agentclientprotocol/codex-acp@0.0.45")
    expect(probeCalls).not.toContain("npx --yes @agentclientprotocol/codex-acp@0.0.45")
    expect(profiles.find((profile) => profile.kind === "codex")).toMatchObject({
      id: "codex:codex-acp",
      command: ["bunx", "@zed-industries/codex-acp@0.16.0"],
      diagnostics: { acp: "unsupported", reason: "sh: codex-acp: command not found" },
      status: "unavailable",
    })
  })

  test("uses extended ACP initialize probe timeouts for runtimes with slower startup", async () => {
    const probeCalls: Array<{ command: string[]; timeoutMs?: number }> = []
    await discoverRuntimeProfiles({
      baseAgentCommand: "hermes acp",
      discoverAcpCommands: noDiscoveredCommands,
      probeAcpCommand: async (command, options) => {
        probeCalls.push({ command, timeoutMs: options?.timeoutMs })
        return { ok: true }
      },
      runCommand: async (command) => {
        if (command[0] === "command" && command[1] === "-v") {
          return { ok: true, stdout: `/usr/bin/${command[2]}\n` }
        }
        return { ok: true, stdout: "" }
      },
    })

    expect(
      probeCalls.some(
        (call) =>
          call.command.join(" ") === "bunx @zed-industries/codex-acp@0.16.0" &&
          call.timeoutMs === 30_000,
      ),
    ).toBe(true)
    expect(probeCalls.find((call) => call.command.join(" ") === "openclaw acp")).toEqual({
      command: ["openclaw", "acp"],
      timeoutMs: 20_000,
    })
    expect(
      probeCalls
        .filter(
          (call) =>
            call.command.join(" ") !== "bunx @zed-industries/codex-acp@0.16.0" &&
            call.command.join(" ") !== "openclaw acp",
        )
        .every((call) => call.timeoutMs === undefined),
    ).toBe(true)
  })

  test("does not synthesize a Hermes profile for non-Hermes base commands", async () => {
    const profiles = await discoverRuntimeProfiles({
      baseAgentCommand: "bunx @zed-industries/codex-acp@0.16.0",
      discoverAcpCommands: noDiscoveredCommands,
      probeAcpCommand: async () => ({ ok: true }),
      runCommand: async (command) => {
        if (command.join(" ") === "command -v bunx") {
          return { ok: true, stdout: "/usr/bin/bunx\n" }
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
        if (command.join(" ") === "command -v bunx") {
          return { ok: true, stdout: "/usr/bin/bunx\n" }
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

  test("ignores retired Codex ACP custom commands", async () => {
    const probeCalls: string[] = []
    const profiles = await discoverRuntimeProfiles({
      baseAgentCommand: "hermes acp",
      customCommands: [["npx", "--yes", "@agentclientprotocol/codex-acp@0.0.45"]],
      discoverAcpCommands: noDiscoveredCommands,
      probeAcpCommand: async (command) => {
        probeCalls.push(command.join(" "))
        return { ok: true }
      },
      runCommand: async (command) => {
        const key = command.join(" ")
        if (key === "command -v npx") {
          return { ok: true, stdout: "/usr/bin/npx\n" }
        }
        if (key === "command -v hermes" || key === "command -v bunx") {
          return { ok: false, stdout: "", stderr: "" }
        }
        return { ok: false, stdout: "", stderr: "" }
      },
    })

    expect(probeCalls).not.toContain("npx --yes @agentclientprotocol/codex-acp@0.0.45")
    expect(
      profiles.some(
        (profile) =>
          profile.command.join(" ") === "npx --yes @agentclientprotocol/codex-acp@0.0.45",
      ),
    ).toBe(false)
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

  test("reports actionable OpenClaw gateway token diagnostics", async () => {
    const profiles = await discoverRuntimeProfiles({
      baseAgentCommand: "hermes acp",
      discoverAcpCommands: noDiscoveredCommands,
      probeAcpCommand: async (command) => {
        if (command.join(" ") === "openclaw acp") {
          return {
            ok: false,
            reason:
              "gateway connect failed: GatewayClientRequestError: unauthorized: gateway token missing (set gateway.remote.token to match gateway.auth.token)",
          }
        }
        return { ok: true, capabilities: {} }
      },
      runCommand: async (command) => {
        if (command.join(" ") === "command -v openclaw") {
          return { ok: true, stdout: "/usr/bin/openclaw\n" }
        }
        return { ok: false, stdout: "", stderr: "" }
      },
    })

    expect(profiles.find((profile) => profile.kind === "openclaw")).toMatchObject({
      diagnostics: {
        acp: "unsupported",
        reason: "openclaw_gateway_token_missing",
        detail: expect.stringContaining("gateway.remote.token"),
      },
      status: "unavailable",
    })
  })
})
