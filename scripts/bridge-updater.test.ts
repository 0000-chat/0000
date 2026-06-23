import { describe, expect, test } from "bun:test"
import { mkdtemp, readFile, writeFile } from "node:fs/promises"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"

import {
  buildRestartCommandArgs,
  chooseLatestReleaseTag,
  normalizeReleaseTag,
  runBridgeUpdate,
} from "./bridge-updater"

describe("bridge updater release selection", () => {
  test("keeps release metadata aligned with the updater semver contract", () => {
    const packageVersion = JSON.parse(readFileSync("package.json", "utf8")).version as string
    const bridgeSource = readFileSync("scripts/acp-bridge.ts", "utf8")
    const bridgeVersion = bridgeSource.match(/export const BRIDGE_VERSION = "([^"]+)"/)?.[1]
    const [major, minor, patch] = packageVersion.split(".").map((part) => Number.parseInt(part, 10))
    const previousPatchVersion = `${major}.${minor}.${patch - 1}`

    expect(packageVersion).toMatch(/^\d+\.\d+\.\d+$/)
    expect(bridgeVersion).toBe(packageVersion)
    expect(chooseLatestReleaseTag([`v${packageVersion}`], previousPatchVersion)).toBe(`v${packageVersion}`)
  })

  test("chooses the highest stable semver release tag newer than the current version", () => {
    expect(
      chooseLatestReleaseTag(["v0.1.2", "v0.1.3", "v0.2.0", "v0.2.0-beta.1", "not-a-tag"], "0.1.2"),
    ).toBe("v0.2.0")
  })

  test("does not choose a tag when the checkout is already current", () => {
    expect(chooseLatestReleaseTag(["v0.1.2", "v0.1.1"], "0.1.2")).toBeUndefined()
  })

  test("normalizes release tag names from git ls-remote output", () => {
    expect(normalizeReleaseTag("a1b2c3 refs/tags/v1.2.3^{}")).toBe("v1.2.3")
  })
})

describe("bridge updater restart command", () => {
  test("round-trips the restart command through CLI arguments", () => {
    const args = buildRestartCommandArgs(["/usr/bin/bun", "scripts/acp-bridge.ts", "start"])

    expect(args).toEqual([
      "--restart-command",
      "[\"/usr/bin/bun\",\"scripts/acp-bridge.ts\",\"start\"]",
    ])
  })

  test("writes succeeded control command status after a successful update", async () => {
    const dir = await mkdtemp(join(tmpdir(), "0000-bridge-updater-"))
    const statusPath = join(dir, "bridge-status.json")

    await runBridgeUpdate(
      {
        currentVersion: "0.1.20",
        repoPath: dir,
        restartCommand: ["bun", "scripts/acp-bridge.ts", "start"],
        statusPath,
      },
      {
        assertCleanCheckout: async () => {},
        listRemoteReleaseTags: async () => ["abc refs/tags/v0.1.21^{}"],
        now: () => Date.UTC(2026, 5, 22, 9, 10, 0),
        runProcess: async () => ({ stderr: "", stdout: "" }),
        spawnRestart: () => {},
        waitForParentExit: async () => {},
      },
    )

    const written = JSON.parse(await readFile(statusPath, "utf8")) as Record<string, unknown>
    expect(written.pendingControlCommand).toBeUndefined()
    expect(written.controlCommandStatus).toEqual(
      expect.objectContaining({
        command: "updateWhenIdle",
        completedAt: Date.UTC(2026, 5, 22, 9, 10, 0),
        status: "succeeded",
        targetVersion: "0.1.21",
      }),
    )
  })

  test("writes failed control command status without leaving a pending command behind", async () => {
    const dir = await mkdtemp(join(tmpdir(), "0000-bridge-updater-"))
    const statusPath = join(dir, "bridge-status.json")
    await writeFile(
      statusPath,
      `${JSON.stringify({
        activeSessions: [],
        connected: false,
        controlCommandStatus: {
          command: "updateWhenIdle",
          startedAt: Date.UTC(2026, 5, 22, 9, 11, 0),
          status: "executing",
        },
        pendingControlCommand: {
          command: "updateWhenIdle",
          requestedAt: Date.UTC(2026, 5, 22, 9, 10, 0),
        },
        recentErrors: [],
      })}\n`,
      "utf8",
    )

    await expect(
      runBridgeUpdate(
        {
          currentVersion: "0.1.20",
          repoPath: dir,
          restartCommand: ["bun", "scripts/acp-bridge.ts", "start"],
          statusPath,
        },
        {
          assertCleanCheckout: async () => {},
          listRemoteReleaseTags: async () => ["abc refs/tags/v0.1.21^{}"],
          now: () => Date.UTC(2026, 5, 22, 9, 12, 0),
          runProcess: async (_command, args) => {
            if (args.includes("checkout")) {
              throw new Error("token=abc123 fetch failed because checkout exploded in a very long way ".repeat(10))
            }
            return { stderr: "", stdout: "" }
          },
          spawnRestart: () => {},
          waitForParentExit: async () => {},
        },
      ),
    ).rejects.toThrow("checkout exploded")

    const written = JSON.parse(await readFile(statusPath, "utf8")) as Record<string, unknown>
    expect(written.pendingControlCommand).toBeUndefined()
    expect(written.controlCommandStatus).toEqual(
      expect.objectContaining({
        command: "updateWhenIdle",
        failedAt: Date.UTC(2026, 5, 22, 9, 12, 0),
        status: "failed",
        targetVersion: "0.1.21",
      }),
    )
    expect((written.controlCommandStatus as { error?: string }).error).not.toContain("token=abc123")
  })
})
