import { describe, expect, test } from "bun:test"
import { chmod, mkdtemp, stat } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"

import {
  deriveConvexCloudUrl,
  ensureSecureBridgeConfigFile,
  buildStartupSecuritySummary,
  getAllowRemoteCwd,
  getConvexUrl,
  writeBridgeConfigFile,
  writeBridgeStatusFile,
} from "./acp-bridge"
import { DEFAULT_CLAUDE_CODE_ACP_COMMAND, DEFAULT_CODEX_ACP_COMMAND } from "./hermes-bridge/runtime-defaults"

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
    expect(getAllowRemoteCwd({ "allow-remote-cwd": "true" }, {})).toBe(true)
    expect(getAllowRemoteCwd({}, { ZERO_CHAT_BRIDGE_ALLOW_REMOTE_CWD: "1" })).toBe(true)
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
