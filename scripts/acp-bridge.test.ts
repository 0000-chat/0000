import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { chmod, mkdtemp, readFile, stat } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"

import {
  BRIDGE_VERSION,
  buildHeartbeatStatusPayload,
  type BridgeStatus,
  describeStatus,
  deriveConvexCloudUrl,
  ensureSecureBridgeConfigFile,
  buildAgentConnectionSkillContent,
  buildAgentToolsMcpServers,
  buildStartupSecuritySummary,
  getAllowRemoteCwd,
  getConvexUrl,
  normalizeBridgeConfigFile,
  normalizeQueueCommand,
  repairBridgeConfigFiles,
  runBridgeLoopIteration,
  upsertBridgeRegistration,
  writeBridgeConfigFile,
  writeBridgeStatusFile,
} from "./acp-bridge"
import { DEFAULT_CLAUDE_CODE_ACP_COMMAND, DEFAULT_CODEX_ACP_COMMAND } from "./hermes-bridge/runtime-defaults"

test("bridge version matches package metadata", () => {
  const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"))
  expect(BRIDGE_VERSION).toBe(packageJson.version)
})

describe("bridge Convex URL resolution", () => {
  test("derives a Convex cloud URL from a Convex site URL", () => {
    expect(deriveConvexCloudUrl("https://example-123.convex.site")).toBe(
      "https://example-123.convex.cloud",
    )
  })

  test("prefers explicit flag and environment values", () => {
    const config = {
      appUrl: "https://0000.chat",
      bridgeApiUrl: "https://example-123.convex.site",
    }

    expect(getConvexUrl({ "convex-url": "https://flag.convex.cloud" }, config, {})).toBe(
      "https://flag.convex.cloud",
    )
    expect(
      getConvexUrl({}, config, { ZERO_CHAT_BRIDGE_CONVEX_URL: "https://env.convex.cloud" }),
    ).toBe("https://env.convex.cloud")
  })

  test("falls back to the paired bridge API URL before app URL derivation", () => {
    expect(
      getConvexUrl(
        {},
        {
          appUrl: "https://0000.chat",
          bridgeApiUrl: "https://uncommon-starfish-672.convex.site",
        },
        {},
      ),
    ).toBe("https://uncommon-starfish-672.convex.cloud")
  })
})

describe("bridge queue command normalization", () => {
  test("preserves runtime selection fields from claim responses", () => {
    expect(
      normalizeQueueCommand({
        agentName: "Claude Code",
        agentSessionId: "session_123",
        bridgeProfileId: "claude-code:claude-acp",
        cwd: "/home/dev",
        externalSessionId: "acp-session-123",
        hermesProfileName: "writer",
        id: "queue_123",
        kind: "prompt",
        prompt: "hello",
        threadId: "thread_123",
      }),
    ).toMatchObject({
      agentName: "Claude Code",
      agentSessionId: "session_123",
      bridgeProfileId: "claude-code:claude-acp",
      cwd: "/home/dev",
      externalSessionId: "acp-session-123",
      hermesProfileName: "writer",
      id: "queue_123",
      prompt: "hello",
      threadId: "thread_123",
      type: "prompt",
    })
  })
})

describe("bridge MCP helper configuration", () => {
  test("uses public app URL for agent tool invocation", () => {
    expect(
      buildAgentToolsMcpServers({
        agentSessionId: "agent_session_1",
        agentToolsUrl: "https://0000.chat",
        appUrl: "https://0000.chat",
        bridgeToken: "token-a",
        deviceId: "bridge_a",
        threadId: "thread_1",
      }),
    ).toEqual([
      {
        args: ["scripts/agent-tools-mcp.ts"],
        command: "bun",
        env: [
          { name: "ZERO_CHAT_AGENT_SESSION_ID", value: "agent_session_1" },
          { name: "ZERO_CHAT_APP_URL", value: "https://0000.chat" },
          { name: "ZERO_CHAT_AGENT_TOOLS_URL", value: "https://0000.chat" },
          { name: "ZERO_CHAT_BRIDGE_DEVICE_ID", value: "bridge_a" },
          { name: "ZERO_CHAT_THREAD_ID", value: "thread_1" },
          { name: "ZERO_CHAT_BRIDGE_TOKEN", value: "token-a" },
        ],
        name: "0000-chat",
      },
    ])
  })
})

describe("bridge multi-organization config", () => {
  test("accepts an empty multi-organization config before the first registration is appended", () => {
    expect(
      normalizeBridgeConfigFile({
        version: 2,
        registrations: [],
      }),
    ).toEqual({
      version: 2,
      registrations: [],
    })
  })

  test("normalizes legacy single-device bridge configs into one registration", () => {
    expect(
      normalizeBridgeConfigFile({
        appUrl: "https://0000.chat",
        bridgeToken: "token-a",
        deviceId: "bridge_a",
        deviceName: "Laptop",
        pairedAt: "2026-06-01T00:00:00.000Z",
      }),
    ).toEqual({
      version: 2,
      registrations: [
        {
          appUrl: "https://0000.chat",
          bridgeToken: "token-a",
          deviceId: "bridge_a",
          deviceName: "Laptop",
          pairedAt: "2026-06-01T00:00:00.000Z",
        },
      ],
    })
  })

  test("upserts bridge registrations without deleting other organizations", () => {
    const original = normalizeBridgeConfigFile({
      version: 2,
      registrations: [
        {
          appUrl: "https://0000.chat",
          bridgeToken: "token-a",
          deviceId: "bridge_a",
          deviceName: "Org A",
          pairedAt: "2026-06-01T00:00:00.000Z",
        },
      ],
    })

    const appended = upsertBridgeRegistration(original, {
      appUrl: "https://0000.chat",
      bridgeToken: "token-b",
      deviceId: "bridge_b",
      deviceName: "Org B",
      pairedAt: "2026-06-01T00:01:00.000Z",
    })
    const replaced = upsertBridgeRegistration(appended, {
      appUrl: "https://0000.chat",
      bridgeToken: "token-b2",
      deviceId: "bridge_b",
      deviceName: "Org B renamed",
      pairedAt: "2026-06-01T00:02:00.000Z",
    })

    expect(appended.registrations.map((registration) => registration.deviceId)).toEqual([
      "bridge_a",
      "bridge_b",
    ])
    expect(replaced.registrations).toEqual([
      original.registrations[0],
      {
        appUrl: "https://0000.chat",
        bridgeToken: "token-b2",
        deviceId: "bridge_b",
        deviceName: "Org B renamed",
        pairedAt: "2026-06-01T00:02:00.000Z",
      },
    ])
  })

  test("renders multi-registration status without leaking secrets", () => {
    const output = describeStatus(
      {
        connected: true,
        activeSessions: ["session-a"],
        recentErrors: ["Bearer secret-token failed"],
        registrations: [
          {
            appUrl: "https://0000.chat",
            connected: true,
            deviceId: "bridge_a",
            deviceName: "Org A laptop",
            activeSessions: ["session-a"],
            inFlightCommands: [{ id: "queue-a", startedAt: "2026-06-01T00:00:00.000Z" }],
            recentErrors: ["authorization: secret-value"],
          },
          {
            appUrl: "https://0000.chat",
            connected: false,
            deviceId: "bridge_b",
            deviceName: "Org B laptop",
            activeSessions: [],
            recentErrors: [],
          },
        ],
      },
      true,
    )

    expect(output).toContain("registered links: 2")
    expect(output).toContain("Org A laptop")
    expect(output).toContain("Org B laptop")
    expect(output).not.toContain("secret-token")
    expect(output).not.toContain("secret-value")
  })

  test("repairs legacy bridge configs by merging registrations with a backup", async () => {
    const dir = await mkdtemp(join(tmpdir(), "0000-bridge-repair-"))
    const targetPath = join(dir, "bridge.json")
    const sourcePath = join(dir, "legacy-bridge.json")

    await writeBridgeConfigFile(targetPath, {
      version: 2,
      registrations: [
        {
          appUrl: "https://0000.chat",
          bridgeToken: "token-current",
          deviceId: "bridge_current",
          deviceName: "Current org",
          pairedAt: "2026-06-01T00:00:00.000Z",
        },
      ],
    })
    await writeBridgeConfigFile(sourcePath, {
      appUrl: "https://example-123.convex.site",
      bridgeToken: "token-legacy",
      deviceId: "bridge_legacy",
      deviceName: "Legacy org",
      pairedAt: "2026-05-21T00:00:00.000Z",
    })

    const result = await repairBridgeConfigFiles({
      now: () => new Date("2026-06-03T08:16:45.000Z"),
      sourcePaths: [sourcePath],
      targetPath,
    })

    const repaired = JSON.parse(await readFile(targetPath, "utf8"))
    expect(result).toMatchObject({
      backupPath: `${targetPath}.backup-20260603T081645Z`,
      importedRegistrationCount: 1,
      previousRegistrationCount: 1,
      registrationCount: 2,
      targetPath,
    })
    expect((await stat(result.backupPath!)).mode & 0o777).toBe(0o600)
    expect(repaired.registrations.map((registration: { deviceId: string }) => registration.deviceId)).toEqual([
      "bridge_current",
      "bridge_legacy",
    ])
    expect(repaired.registrations[1]).toMatchObject({
      appUrl: "https://0000.chat",
      bridgeApiUrl: "https://example-123.convex.site",
      deviceId: "bridge_legacy",
    })
  })

  test("agent skill tells agents to append organizations instead of reinstalling", () => {
    const content = buildAgentConnectionSkillContent({
      agentCommand: "hermes acp",
      appUrl: "https://0000.chat",
      configPath: "/home/alice/.0000/bridge.json",
      skillPath: "/home/alice/.claude/skills/0000/SKILL.md",
    })

    expect(content).toContain("multiple 0000 organizations")
    expect(content).toContain("connect-org <code>")
    expect(content).toContain("Do not delete, recreate, overwrite, or move the bridge config")
    expect(content).toContain("repair-config")
  })
})

describe("bridge security defaults", () => {
  test("pins default package-backed ACP runtime commands", () => {
    expect(DEFAULT_CODEX_ACP_COMMAND).toBe("npx --yes @zed-industries/codex-acp@0.15.0")
    expect(DEFAULT_CLAUDE_CODE_ACP_COMMAND).toBe(
      "npx --yes @agentclientprotocol/claude-agent-acp@0.39.0",
    )
  })

  test("writes bridge config files with owner-only permissions", async () => {
    const dir = await mkdtemp(join(tmpdir(), "0000-bridge-config-"))
    const path = join(dir, "bridge.json")

    await writeBridgeConfigFile(path, { bridgeToken: "secret" })

    expect((await stat(path)).mode & 0o777).toBe(0o600)
  })

  test("repairs loose permissions on an existing bridge config file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "0000-bridge-config-"))
    const path = join(dir, "bridge.json")
    await writeBridgeConfigFile(path, { bridgeToken: "secret" })
    await chmod(path, 0o644)

    await ensureSecureBridgeConfigFile(path)

    expect((await stat(path)).mode & 0o777).toBe(0o600)
  })

  test("writes bridge status files with owner-only permissions", async () => {
    const dir = await mkdtemp(join(tmpdir(), "0000-bridge-status-"))
    const path = join(dir, "bridge-status.json")

    await writeBridgeStatusFile(path, { connected: true })

    expect((await stat(path)).mode & 0o777).toBe(0o600)
  })

  test("keeps remote cwd disabled unless explicitly enabled", () => {
    expect(getAllowRemoteCwd({}, {})).toBe(false)
    expect(getAllowRemoteCwd({ "allow-remote-cwd": true }, {})).toBe(true)
    expect(getAllowRemoteCwd({ "allow-remote-cwd": "true" }, {})).toBe(true)
    expect(getAllowRemoteCwd({}, { ZERO_CHAT_BRIDGE_ALLOW_REMOTE_CWD: "1" })).toBe(true)
  })

  test("writes reconnect skill with remote cwd enabled", () => {
    const source = readFileSync(new URL("./acp-bridge.ts", import.meta.url), "utf8")

    expect(source).toContain(
      "bun scripts/acp-bridge.ts start --agent-command ${JSON.stringify(input.agentCommand)} --allow-remote-cwd",
    )
  })

  test("prints startup security defaults", () => {
    expect(
      buildStartupSecuritySummary({
        allowRemoteCwd: false,
        configPath: "/home/alice/.0000/bridge.json",
      }),
    ).toContain("remote bridge log forwarding: disabled")
  })
})

describe("bridge lifecycle control", () => {
  test("requests a deterministic restart when the app asks an idle bridge to restart", async () => {
    const status = createLoopStatus()
    const writes: unknown[] = []

    const result = await runBridgeLoopIteration({
      ...createLoopInput(status),
      sendHeartbeat: async () => ({
        ok: true,
        control: { command: { command: "restartWhenIdle", requestedAt: 123 } },
      }),
      writeStatus: async (_path, value) => {
        writes.push(value)
      },
    })

    expect(result.restartRequested).toBe(true)
    expect(status.lifecycle).toBe("restarting")
    expect(status.updateState?.status).toBe("restarting")
    expect(writes.length).toBeGreaterThan(0)
  })

  test("drains instead of restarting while bridge work is still active", async () => {
    const status = createLoopStatus()
    const inFlightCommands = new Map<string, Promise<void>>()
    const inFlightCommandMetadata = new Map()
    inFlightCommands.set("queue-a", new Promise(() => {}))
    inFlightCommandMetadata.set("queue-a", {
      id: "queue-a",
      startedAt: "2026-06-01T00:00:00.000Z",
    })

    const result = await runBridgeLoopIteration({
      ...createLoopInput(status),
      inFlightCommands,
      inFlightCommandMetadata,
      sendHeartbeat: async () => ({
        ok: true,
        control: { command: { command: "restartWhenIdle", requestedAt: 123 } },
      }),
      writeStatus: async () => {},
    })

    expect(result.restartRequested).toBe(false)
    expect(status.lifecycle).toBe("draining")
    expect(status.updateState?.status).toBe("waitingForIdle")
  })

  test("launches the updater when the app asks an idle bridge to update", async () => {
    const status = createLoopStatus()
    const launches: unknown[] = []

    const result = await runBridgeLoopIteration({
      ...createLoopInput(status),
      sendHeartbeat: async () => ({
        ok: true,
        control: { command: { command: "updateWhenIdle", requestedAt: 123 } },
      }),
      launchUpdater: async (input) => {
        launches.push(input)
      },
      writeStatus: async () => {},
    })

    expect(result.restartRequested).toBe(true)
    expect(status.lifecycle).toBe("updating")
    expect(status.updateState?.status).toBe("installing")
    expect(launches).toEqual([
      expect.objectContaining({
        currentVersion: BRIDGE_VERSION,
        requestedAt: 123,
        statusPath: "/tmp/bridge-status.json",
      }),
    ])
    expect(buildHeartbeatStatusPayload(status)).toMatchObject({
      lifecycle: "updating",
      updateState: { status: "installing" },
    })
  })

  test("waits for idle work before launching an update", async () => {
    const status = createLoopStatus()
    const inFlightCommands = new Map<string, Promise<void>>()
    const inFlightCommandMetadata = new Map()
    inFlightCommands.set("queue-a", new Promise(() => {}))
    inFlightCommandMetadata.set("queue-a", {
      id: "queue-a",
      startedAt: "2026-06-01T00:00:00.000Z",
    })

    const result = await runBridgeLoopIteration({
      ...createLoopInput(status),
      inFlightCommands,
      inFlightCommandMetadata,
      sendHeartbeat: async () => ({
        ok: true,
        control: { command: { command: "updateWhenIdle", requestedAt: 123 } },
      }),
      launchUpdater: async () => {
        throw new Error("should not launch while busy")
      },
      writeStatus: async () => {},
    })

    expect(result.restartRequested).toBe(false)
    expect(status.lifecycle).toBe("draining")
    expect(status.updateState?.status).toBe("waitingForIdle")
  })
})

function createLoopStatus(): BridgeStatus {
  return {
    deviceId: "bridge-a",
    appUrl: "https://0000.chat",
    connected: true,
    activeSessions: [],
    activeQueueItemIds: [],
    inFlightCommands: [],
    sessionQueues: [],
    recentErrors: [],
  }
}

function createLoopInput(status: ReturnType<typeof createLoopStatus>) {
  return {
    config: {
      appUrl: "https://0000.chat",
      bridgeToken: "token-a",
      deviceId: "bridge-a",
      deviceName: "Bridge A",
      pairedAt: "2026-06-01T00:00:00.000Z",
    },
    status,
    maxInFlight: 1,
    manager: {
      getStatus: () => ({ activeSessions: [], sessions: [] }),
      handleQueueItem: async () => {},
    },
    inFlightCommands: new Map<string, Promise<void>>(),
    inFlightCommandMetadata: new Map(),
    lastStaleCleanupAt: 0,
    setLastStaleCleanupAt: () => {},
    log: Object.assign(() => {}, { flush: async () => {} }),
    recordLoopError: async (error: unknown) => {
      throw error
    },
    statusPath: "/tmp/bridge-status.json",
    now: () => Date.parse("2026-06-01T00:00:00.000Z"),
    heartbeatIntervalMs: 0,
    cleanupStaleClaims: async () => ({ released: 0, inspected: 0 }),
    claimCommands: async () => [],
    launchUpdater: async () => {},
  }
}
