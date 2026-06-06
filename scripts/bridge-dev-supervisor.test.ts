import { describe, expect, test } from "bun:test"

import { getSupervisorArgv, parseArgs } from "./bridge-dev-supervisor"

describe("bridge dev supervisor args", () => {
  test("preserves bridge command args when Bun strips the separator from process argv", () => {
    const argv = getSupervisorArgv([
      "/home/ubuntu/.bun/bin/bun",
      "/home/ubuntu/0000/scripts/bridge-dev-supervisor.ts",
      "/home/ubuntu/.bun/bin/bun",
      "scripts/acp-bridge.ts",
      "start",
      "--runtime-command",
      "/tmp/zero-custom-acp",
      "--max-in-flight",
      "4",
    ])

    const config = parseArgs(argv)

    expect(config.command).toEqual([
      "/home/ubuntu/.bun/bin/bun",
      "scripts/acp-bridge.ts",
      "start",
      "--runtime-command",
      "/tmp/zero-custom-acp",
      "--max-in-flight",
      "4",
    ])
  })

  test("preserves bridge command args when Node-style argv includes the script path", () => {
    const argv = getSupervisorArgv([
      "node",
      "/home/ubuntu/0000/scripts/bridge-dev-supervisor.ts",
      "--",
      "bun",
      "scripts/acp-bridge.ts",
      "start",
      "--poll-ms",
      "1000",
    ])

    const config = parseArgs(argv)

    expect(config.command).toEqual(["bun", "scripts/acp-bridge.ts", "start", "--poll-ms", "1000"])
  })
})
