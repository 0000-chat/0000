import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"

import {
  buildRestartCommandArgs,
  chooseLatestReleaseTag,
  normalizeReleaseTag,
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
})
