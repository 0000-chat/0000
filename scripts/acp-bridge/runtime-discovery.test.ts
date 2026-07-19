import { spawn, type ChildProcess } from "node:child_process"
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { describe, expect, test } from "bun:test"
import * as runtimeDiscovery from "./runtime-discovery"
import {
  capabilitiesFromInitializeResult,
  discoverRuntimeProfiles,
  resolveExecutableForSpawn,
  runtimeDiscoveryEnv,
} from "./runtime-discovery"
import { resolveNodeProxyExecutable } from "./acp-node-proxy-launcher"

const noDiscoveredCommands = async () => []

describe("runtime discovery", () => {
  test("resolves Volta's concrete Node image for proxy launches", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "acp-runtime-volta-node-"))
    const fakeNodePath = join(tempDir, "node-image")
    const fakeVoltaPath = join(tempDir, "volta")
    await writeFile(fakeNodePath, "#!/bin/sh\nexit 0\n")
    await writeFile(
      fakeVoltaPath,
      "#!/bin/sh\nif [ \"$1\" = \"which\" ] && [ \"$2\" = \"node\" ]; then printf '%s\\n' \"$FAKE_NODE_IMAGE\"; exit 0; fi\nexit 1\n",
    )
    await chmod(fakeNodePath, 0o755)
    await chmod(fakeVoltaPath, 0o755)
    try {
      expect(
        resolveNodeProxyExecutable({
          FAKE_NODE_IMAGE: fakeNodePath,
          PATH: tempDir,
        }),
      ).toBe(fakeNodePath)
    } finally {
      await rm(tempDir, { force: true, recursive: true })
    }
  })

  test("detaches the Bun ACP discovery proxy for process-group cleanup", () => {
    const module = runtimeDiscovery as typeof runtimeDiscovery & {
      buildAcpDiscoveryProxySpawnOptions?: (
        options: Parameters<typeof Bun.spawn>[1],
      ) => Parameters<typeof Bun.spawn>[1]
    }

    expect(module.buildAcpDiscoveryProxySpawnOptions).toBeFunction()
    expect(
      module.buildAcpDiscoveryProxySpawnOptions?.({
        detached: false,
        stdio: ["pipe", "pipe", "pipe"],
      })?.detached,
    ).toBe(process.platform !== "win32")
  })

  test("force-kills ACP discovery probes that ignore SIGTERM", async () => {
    const module = runtimeDiscovery as typeof runtimeDiscovery & {
      terminateAcpDiscoveryChild?: (
        child: ChildProcess,
        options?: { killDelayMs?: number; timeoutMs?: number },
      ) => Promise<void>
    }
    expect(module.terminateAcpDiscoveryChild).toBeFunction()

    const tempDir = await mkdtemp(join(tmpdir(), "acp-runtime-stubborn-"))
    const scriptPath = join(tempDir, "stubborn-probe.js")
    await writeFile(
      scriptPath,
      "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)\n",
    )
    const child = spawn(process.execPath, [scriptPath], { stdio: "ignore" })
    try {
      await delay(50)
      expect(isProcessAlive(child.pid)).toBe(true)

      await module.terminateAcpDiscoveryChild?.(child, {
        killDelayMs: 10,
        timeoutMs: 1_000,
      })

      expect(isProcessAlive(child.pid)).toBe(false)
    } finally {
      if (isProcessAlive(child.pid)) {
        child.kill("SIGKILL")
      }
      await rm(tempDir, { force: true, recursive: true })
    }
  })

  test("ACP node proxy exits when its expected bridge parent is gone", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "acp-runtime-orphan-"))
    const scriptPath = join(tempDir, "long-running-runtime.js")
    await writeFile(
      scriptPath,
      "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)\n",
    )
    const proxy = spawn(
      "node",
      [join(import.meta.dir, "acp-node-proxy.cjs"), process.execPath, scriptPath],
      {
        env: {
          ...process.env,
          ZERO_CHAT_ACP_PROXY_PARENT_CHECK_MS: "10",
          ZERO_CHAT_ACP_PROXY_PARENT_PID: "99999999",
          ZERO_CHAT_ACP_PROXY_TERMINATE_GRACE_MS: "20",
        },
        stdio: "ignore",
      },
    )
    try {
      const result = await Promise.race([
        waitForClose(proxy),
        delay(3_000).then(() => "timeout" as const),
      ])

      expect(result).toBe("closed")
      expect(isProcessAlive(proxy.pid)).toBe(false)
    } finally {
      if (isProcessAlive(proxy.pid)) {
        proxy.kill("SIGKILL")
      }
      await rm(tempDir, { force: true, recursive: true })
    }
  })

  test("ACP node proxy stays up when expected bridge parent is alive but indirect", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "acp-runtime-indirect-parent-"))
    const scriptPath = join(tempDir, "short-runtime.js")
    await writeFile(scriptPath, "setTimeout(() => process.exit(0), 150)\n")
    const expectedParent = spawn(process.execPath, ["-e", "setTimeout(() => {}, 5000)"], {
      stdio: "ignore",
    })
    const proxy = spawn(
      "node",
      [join(import.meta.dir, "acp-node-proxy.cjs"), process.execPath, scriptPath],
      {
        env: {
          ...process.env,
          ZERO_CHAT_ACP_PROXY_PARENT_CHECK_MS: "10",
          ZERO_CHAT_ACP_PROXY_PARENT_PID: String(expectedParent.pid),
          ZERO_CHAT_ACP_PROXY_TERMINATE_GRACE_MS: "20",
        },
        stdio: "ignore",
      },
    )
    try {
      const result = await Promise.race([
        waitForClose(proxy),
        delay(3_000).then(() => "timeout" as const),
      ])

      expect(result).toBe("closed")
      expect(proxy.exitCode).toBe(0)
      expect(isProcessAlive(proxy.pid)).toBe(false)
    } finally {
      if (isProcessAlive(proxy.pid)) {
        proxy.kill("SIGKILL")
      }
      if (isProcessAlive(expectedParent.pid)) {
        expectedParent.kill("SIGKILL")
      }
      await rm(tempDir, { force: true, recursive: true })
    }
  })

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
          supportsNativeSubagentControl: false,
          supportsNativeSubagentStatus: true,
          supportsNativeSubagentTools: true,
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
      supportsNativeSubagentControl: false,
      supportsNativeSubagentStatus: true,
      supportsNativeSubagentTools: true,
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
      command: ["npx", "--yes", "@agentclientprotocol/codex-acp@1.1.4"],
      diagnostics: { acp: "supported", contextMode: "available", mcpServers: 2 },
      capabilities: {
        nativeSkills: true,
        nativeHooks: true,
        nativeMcp: true,
        supportsNativeSubagentControl: false,
        supportsNativeSubagentStatus: false,
        supportsNativeSubagentTools: true,
      },
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

  test("discovers Codex through npx when bunx is unavailable", async () => {
    const probeCalls: string[] = []
    const profiles = await discoverRuntimeProfiles({
      baseAgentCommand: "hermes acp",
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
        if (key === "command -v bunx") {
          return { ok: false, stdout: "", stderr: "" }
        }
        return { ok: false, stdout: "", stderr: "" }
      },
    })

    expect(probeCalls).toContain("npx --yes @agentclientprotocol/codex-acp@1.1.4")
    expect(profiles.find((profile) => profile.kind === "codex")).toMatchObject({
      id: "codex:codex-acp",
      command: ["npx", "--yes", "@agentclientprotocol/codex-acp@1.1.4"],
      status: "available",
    })
  })

  test("falls back to bunx for Codex when npx is unavailable", async () => {
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

    expect(profiles.find((profile) => profile.kind === "codex")).toMatchObject({
      id: "codex:codex-acp",
      command: ["bunx", "@agentclientprotocol/codex-acp@1.1.4"],
      status: "available",
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
      capabilities: {
        sessionMcpServers: true,
        supportsNativeSubagentControl: false,
        supportsNativeSubagentStatus: false,
        supportsNativeSubagentTools: true,
      },
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

  test("does not fall back to the stale Zed Codex ACP package when the maintained adapter fails", async () => {
    const probeCalls: string[] = []
    const profiles = await discoverRuntimeProfiles({
      baseAgentCommand: "hermes acp",
      discoverAcpCommands: noDiscoveredCommands,
      probeAcpCommand: async (command) => {
        const key = command.join(" ")
        probeCalls.push(key)
        if (
          key === "npx --yes @agentclientprotocol/codex-acp@1.1.4" ||
          key === "bunx @agentclientprotocol/codex-acp@1.1.4"
        ) {
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

    expect(probeCalls).toContain("npx --yes @agentclientprotocol/codex-acp@1.1.4")
    expect(probeCalls).toContain("bunx @agentclientprotocol/codex-acp@1.1.4")
    expect(probeCalls).not.toContain("bunx @zed-industries/codex-acp@0.16.0")
    expect(probeCalls).not.toContain("bunx --yes @agentclientprotocol/codex-acp@0.0.45")
    expect(probeCalls).not.toContain("npx --yes @agentclientprotocol/codex-acp@0.0.45")
    expect(profiles.find((profile) => profile.kind === "codex")).toMatchObject({
      id: "codex:codex-acp",
      command: ["npx", "--yes", "@agentclientprotocol/codex-acp@1.1.4"],
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
          call.command.join(" ") === "npx --yes @agentclientprotocol/codex-acp@1.1.4" &&
          call.timeoutMs === 30_000,
      ),
    ).toBe(true)
    expect(probeCalls.find((call) => call.command.join(" ") === "hermes acp")).toEqual({
      command: ["hermes", "acp"],
      timeoutMs: 30_000,
    })
    expect(probeCalls.find((call) => call.command.join(" ") === "openclaw acp")).toEqual({
      command: ["openclaw", "acp"],
      timeoutMs: 20_000,
    })
    expect(
      probeCalls
        .filter(
          (call) =>
            call.command.join(" ") !== "hermes acp" &&
            call.command.join(" ") !== "npx --yes @agentclientprotocol/codex-acp@1.1.4" &&
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

    expect(profiles.find((profile) => profile.id === "hermes:default")).toMatchObject({
      capabilities: {
        supportsNativeSubagentControl: false,
        supportsNativeSubagentStatus: false,
        supportsNativeSubagentTools: true,
      },
    })
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

  test("ignores legacy Zed Codex ACP custom commands", async () => {
    const probeCalls: string[] = []
    const profiles = await discoverRuntimeProfiles({
      baseAgentCommand: "hermes acp",
      customCommands: [["bunx", "@zed-industries/codex-acp@0.16.0"]],
      discoverAcpCommands: noDiscoveredCommands,
      probeAcpCommand: async (command) => {
        probeCalls.push(command.join(" "))
        return { ok: true }
      },
      runCommand: async (command) => {
        const key = command.join(" ")
        if (key === "command -v bunx") {
          return { ok: true, stdout: "/home/dev/.bun/bin/bunx\n" }
        }
        if (key === "command -v hermes" || key === "command -v npx") {
          return { ok: false, stdout: "", stderr: "" }
        }
        return { ok: false, stdout: "", stderr: "" }
      },
    })

    expect(probeCalls).not.toContain("bunx @zed-industries/codex-acp@0.16.0")
    expect(
      profiles.some(
        (profile) =>
          profile.command.join(" ") === "bunx @zed-industries/codex-acp@0.16.0",
      ),
    ).toBe(false)
  })

  test("accepts maintained Codex ACP custom commands", async () => {
    const maintainedCommands = [
      ["npx", "--yes", "@agentclientprotocol/codex-acp@1.1.4"],
      ["npx", "--yes", "@agentclientprotocol/codex-acp@1.2.0"],
    ]
    const probeCalls: string[] = []
    const profiles = await discoverRuntimeProfiles({
      baseAgentCommand: "hermes acp",
      customCommands: maintainedCommands,
      discoverAcpCommands: noDiscoveredCommands,
      probeAcpCommand: async (command) => {
        probeCalls.push(command.join(" "))
        return { ok: true }
      },
      runCommand: async (command) => {
        if (command.join(" ") === "command -v npx") {
          return { ok: true, stdout: "/usr/bin/npx\n" }
        }
        return { ok: false, stdout: "", stderr: "" }
      },
    })

    for (const command of maintainedCommands) {
      const commandKey = command.join(" ")
      expect(probeCalls).toContain(commandKey)
      expect(
        profiles.some(
          (profile) =>
            profile.kind === "unknown-acp" && profile.command.join(" ") === commandKey,
        ),
      ).toBe(true)
    }
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
      compatibility: {
        mcpServerNameAliases: {
          "0000": "zero-chat",
        },
      },
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

function isProcessAlive(pid: number | undefined): boolean {
  if (!pid) {
    return false
  }
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function waitForClose(child: ChildProcess): Promise<"closed"> {
  return new Promise((resolve) => {
    child.once("close", () => resolve("closed"))
    child.once("exit", () => resolve("closed"))
  })
}
