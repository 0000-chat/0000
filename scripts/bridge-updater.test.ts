import { describe, expect, test } from "bun:test"

import {
  buildRestartCommandArgs,
  chooseLatestReleaseTag,
  normalizeReleaseTag,
} from "./bridge-updater"

describe("bridge updater release selection", () => {
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
