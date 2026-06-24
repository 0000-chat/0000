import { describe, expect, test } from "bun:test"

import {
  buildSupervisorChildExitEvent,
  getSupervisorArgv,
  parseArgs,
  supervisorEvent,
} from "./bridge-dev-supervisor"

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

  test("builds redaction-safe child exit audit events", () => {
    const event = buildSupervisorChildExitEvent(
      ["bun", "scripts/acp-bridge.ts", "start", "--agent-command", "secret command"],
      {
        exitCode: 1,
        exitSignal: null,
        reason: "bridge process exited",
      },
    )

    expect(event).toMatchObject({
      commandArgCount: 5,
      commandBasename: "bun",
      event: "bridge.supervisor.child_exited",
      exitCode: 1,
      exitSignal: null,
      level: "info",
      reason: "bridge process exited",
      service: "bridge-dev-supervisor",
    })
    expect(event.commandHash).toMatch(/^[a-f0-9]{64}$/)
    expect(JSON.stringify(event)).not.toContain("secret command")
  })

  test("builds signal and restart supervisor audit events", () => {
    const command = ["/home/ubuntu/.bun/bin/bun", "scripts/acp-bridge.ts", "start"]

    expect(
      supervisorEvent("bridge.supervisor.restart_requested", command, {
        reason: "bridge files changed",
      }),
    ).toMatchObject({
      commandBasename: "bun",
      event: "bridge.supervisor.restart_requested",
      reason: "bridge files changed",
      service: "bridge-dev-supervisor",
    })

    expect(
      supervisorEvent("bridge.supervisor.stop_requested", command, {
        reason: "supervisor signal",
        signal: "SIGTERM",
      }),
    ).toMatchObject({
      event: "bridge.supervisor.stop_requested",
      reason: "supervisor signal",
      signal: "SIGTERM",
    })
  })
})
