import { describe, expect, test } from "bun:test"
import { discoverRuntimeProfiles, runtimeDiscoveryEnv } from "./runtime-discovery"

const noDiscoveredCommands = async () => []

describe("runtime discovery", () => {
  test("adds common user tool directories to child process PATH", () => {
    const env = runtimeDiscoveryEnv({ HOME: "/home/dev", PATH: "/usr/bin", TERM: "dumb" })

    expect(env.PATH?.split(":").slice(0, 3)).toEqual([
      "/home/dev/.volta/bin",
      "/home/dev/.bun/bin",
      "/home/dev/.local/bin",
    ])
    expect(env.PATH).toContain("/usr/bin")
    expect(env.TERM).toBe("xterm-256color")
  })

  test("discovers Codex with context-mode diagnostics", async () => {
    const profiles = await discoverRuntimeProfiles({
      baseAgentCommand: "hermes acp",
      discoverAcpCommands: async () => [
        { name: "status", description: "Show session status" },
        { name: "plan", description: "Create a plan", inputHint: "task" },
      ],
      probeAcpCommand: async () => ({ ok: true }),
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
  })

  test("discovers Claude Code through the ACP adapter", async () => {
    const profiles = await discoverRuntimeProfiles({
      baseAgentCommand: "hermes acp",
      discoverAcpCommands: noDiscoveredCommands,
      probeAcpCommand: async () => ({ ok: true }),
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
})
