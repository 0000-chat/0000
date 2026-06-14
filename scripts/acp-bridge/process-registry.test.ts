import { afterEach, describe, expect, test } from "bun:test"
import { readFile, rm, writeFile } from "node:fs/promises"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  AcpBridgeProcessRegistry,
  type AcpBridgeProcessRegistryEntry,
} from "./process-registry"

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })))
})

describe("ACP bridge process registry", () => {
  test("persists child ownership records with atomic JSON shape", async () => {
    const path = tempRegistryPath()
    const registry = new AcpBridgeProcessRegistry({ path })

    await registry.registerProcess({
      args: ["@zed-industries/codex-acp@0.15.0"],
      command: "bunx",
      cwd: "/repo",
      pid: 12345,
      queueItemId: "queue-1",
      claimId: "claim-1",
      sessionKey: "session-1",
      runtimeProfileId: "codex:default",
    })

    const raw = JSON.parse(await readFile(path, "utf8")) as { entries: AcpBridgeProcessRegistryEntry[] }
    expect(raw.entries).toEqual([
      expect.objectContaining({
        args: ["@zed-industries/codex-acp@0.15.0"],
        command: "bunx",
        pid: 12345,
        queueItemId: "queue-1",
        claimId: "claim-1",
        sessionKey: "session-1",
        runtimeProfileId: "codex:default",
      }),
    ])

    const reloaded = new AcpBridgeProcessRegistry({ path })
    await reloaded.load()
    expect(reloaded.getProcessHealth()).toMatchObject({
      canClaim: true,
      childCount: 1,
      childCountsByRuntimeProfile: { "codex:default": 1 },
      status: "healthy",
    })
  })

  test("treats corrupt persisted state as unsafe no-claim state", async () => {
    const path = tempRegistryPath()
    await writeFile(path, "{not json", "utf8")
    const registry = new AcpBridgeProcessRegistry({ path })

    await registry.load()

    expect(registry.getProcessHealth()).toMatchObject({
      ambiguousProcessCount: 1,
      canClaim: false,
      status: "corrupt",
    })
  })

  test("treats newer registry versions as unsafe no-claim state", async () => {
    const path = tempRegistryPath()
    await writeFile(path, JSON.stringify({ version: 999, entries: [] }), "utf8")
    const registry = new AcpBridgeProcessRegistry({ path })

    await registry.load()

    expect(registry.getProcessHealth()).toMatchObject({
      ambiguousProcessCount: 1,
      canClaim: false,
      status: "newer_version",
    })
  })

  test("blocks claims when the registered child process cap is breached", async () => {
    const path = tempRegistryPath()
    const registry = new AcpBridgeProcessRegistry({ maxProcesses: 1, path })
    await registry.registerProcess({
      args: ["acp"],
      command: "codex",
      pid: 111,
      runtimeProfileId: "codex:default",
    })
    await registry.registerProcess({
      args: ["acp"],
      command: "codex",
      pid: 222,
      runtimeProfileId: "codex:default",
    })

    expect(registry.getProcessHealth()).toMatchObject({
      canClaim: false,
      childCount: 2,
      processCap: 1,
      processCapExceeded: true,
      status: "cap_exceeded",
    })
  })

  test("blocks claims when the registered child process count reaches the cap", async () => {
    const path = tempRegistryPath()
    const registry = new AcpBridgeProcessRegistry({ maxProcesses: 1, path })
    await registry.registerProcess({
      args: ["acp"],
      command: "codex",
      pid: 111,
      runtimeProfileId: "codex:default",
    })

    expect(registry.getProcessHealth()).toMatchObject({
      canClaim: false,
      childCount: 1,
      processCap: 1,
      processCapExceeded: true,
      status: "cap_exceeded",
    })
  })

  test("updates the registered child process cap without terminating running children", async () => {
    const path = tempRegistryPath()
    const registry = new AcpBridgeProcessRegistry({ maxProcesses: 1, path })
    await registry.registerProcess({
      args: ["acp"],
      command: "codex",
      pid: 111,
      runtimeProfileId: "codex:default",
    })

    expect(registry.getProcessHealth()).toMatchObject({
      canClaim: false,
      childCount: 1,
      processCap: 1,
      processCapExceeded: true,
      status: "cap_exceeded",
    })

    registry.setMaxProcesses(2)

    expect(registry.getProcessHealth()).toMatchObject({
      canClaim: true,
      childCount: 1,
      processCap: 2,
      processCapExceeded: false,
      status: "healthy",
    })
  })

  test("serializes concurrent registrations so persisted entries are not lost", async () => {
    const path = tempRegistryPath()
    let beforePersistWriteCalls = 0
    let releaseFirstPersist!: () => void
    let firstRegistration!: Promise<AcpBridgeProcessRegistryEntry>
    const firstPersistCanContinue = new Promise<void>((release) => {
      releaseFirstPersist = release
    })
    const registry = new AcpBridgeProcessRegistry({
      path,
      beforePersistWrite: async () => {
        beforePersistWriteCalls += 1
        if (beforePersistWriteCalls === 1) {
          firstPersistSnapshotReached()
          await firstPersistCanContinue
        }
      },
    })
    let firstPersistSnapshotReached!: () => void
    const firstPersistSnapshot = new Promise<void>((resolve) => {
      firstPersistSnapshotReached = resolve
    })
    firstRegistration = registry.registerProcess({
      args: ["acp"],
      command: "codex",
      pid: 111,
      runtimeProfileId: "codex:default",
    })
    void firstRegistration.catch(() => undefined)
    await firstPersistSnapshot
    const secondRegistration = registry.registerProcess({
      args: ["acp"],
      command: "codex",
      pid: 222,
      runtimeProfileId: "codex:secondary",
    })
    const secondSettledBeforeFirstPersist = await Promise.race([
      secondRegistration.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 50)),
    ])
    releaseFirstPersist()
    await Promise.all([firstRegistration, secondRegistration])

    const raw = JSON.parse(await readFile(path, "utf8")) as { entries: AcpBridgeProcessRegistryEntry[] }
    expect(secondSettledBeforeFirstPersist).toBe(false)
    expect(raw.entries.map((entry) => entry.pid).sort()).toEqual([111, 222])
  })

  test("startup reconciliation removes dead registered children before claims", async () => {
    const path = tempRegistryPath()
    const registry = new AcpBridgeProcessRegistry({
      isProcessAlive: () => false,
      path,
    })
    await registry.registerProcess({
      args: ["acp"],
      command: "codex",
      pid: 111,
      queueItemId: "queue-dead",
      runtimeProfileId: "codex:default",
    })

    await registry.reconcileBeforeClaiming()

    expect(registry.getProcessHealth()).toMatchObject({
      canClaim: true,
      childCount: 0,
      status: "healthy",
    })
  })

  test("startup reconciliation terminates stale unregistered bridge proxy processes", async () => {
    const path = tempRegistryPath()
    const ownedProxyScriptPath = "/opt/0000/scripts/acp-bridge/acp-node-proxy.cjs"
    const terminated: number[] = []
    const registry = new AcpBridgeProcessRegistry({
      listProcessCandidates: () => [
        {
          commandLine: `bun ${ownedProxyScriptPath} bunx @zed-industries/codex-acp@0.15.0`,
          elapsedMs: 120_000,
          pid: 222,
          ppid: 1,
          source: "test",
        },
        {
          commandLine: `bun ${ownedProxyScriptPath} bunx @zed-industries/codex-acp@0.15.0`,
          elapsedMs: 1_000,
          pid: 333,
          ppid: 1,
          source: "test",
        },
        {
          commandLine: `bun ${ownedProxyScriptPath} bunx @zed-industries/codex-acp@0.15.0`,
          elapsedMs: 120_000,
          parentCommandLine: "bun scripts/acp-bridge.ts start --max-in-flight 1",
          pid: 334,
          ppid: 900,
          source: "test",
        },
        {
          commandLine: `bun ${ownedProxyScriptPath} bunx @zed-industries/codex-acp@0.15.0`,
          elapsedMs: 120_000,
          parentCommandLine: `node ${ownedProxyScriptPath} bunx @zed-industries/codex-acp@0.15.0`,
          pid: 335,
          ppid: 901,
          source: "test",
        },
        {
          commandLine: "bun /other/scripts/acp-bridge/acp-node-proxy.cjs bunx @zed-industries/codex-acp@0.15.0",
          elapsedMs: 120_000,
          pid: 444,
          ppid: 1,
          source: "test",
        },
      ],
      orphanProcessGraceMs: 60_000,
      ownedProxyScriptPath,
      path,
      terminateProcessId: async (pid) => {
        terminated.push(pid)
      },
    })

    await registry.reconcileBeforeClaiming()

    expect(terminated).toEqual([222])
    expect(registry.getProcessHealth().startupReconciliation).toMatchObject({
      orphanedProcessCount: 1,
      terminatedOrphanedProcessCount: 1,
    })
  })

  test("periodic cleanup terminates only stale unregistered bridge proxy processes", async () => {
    const path = tempRegistryPath()
    const currentCgroup = "/user.slice/user-1000.slice/user@1000.service/app.slice/0000-chat-bridge.service"
    const ownedProxyScriptPath = "/opt/0000/scripts/acp-bridge/acp-node-proxy.cjs"
    const terminated: number[] = []
    const registry = new AcpBridgeProcessRegistry({
      currentCgroup,
      isProcessAlive: (pid) => pid === 333,
      listProcessCandidates: () => [
        {
          commandLine: `bun ${ownedProxyScriptPath} bunx @zed-industries/codex-acp@0.15.0`,
          elapsedMs: 120_000,
          pid: 222,
          ppid: 1,
          source: "test",
        },
        {
          commandLine: `bun ${ownedProxyScriptPath} /home/ubuntu/.local/bin/hermes acp`,
          elapsedMs: 120_000,
          pid: 333,
          ppid: 1,
          source: "test",
        },
        {
          commandLine: `bun ${ownedProxyScriptPath} bunx @zed-industries/codex-acp@0.15.0`,
          elapsedMs: 1_000,
          pid: 444,
          ppid: 1,
          source: "test",
        },
        {
          cgroup: currentCgroup,
          commandLine: "node ./start.mjs",
          elapsedMs: 120_000,
          pid: 555,
          ppid: 1,
          source: "test",
        },
        {
          cgroup: currentCgroup,
          commandLine:
            "/home/ubuntu/.bun/bin/bun /home/ubuntu/.codex/plugins/cache/context-mode/context-mode/1.0.162/start.mjs",
          elapsedMs: 120_000,
          parentCommandLine: "node ./start.mjs",
          pid: 556,
          ppid: 555,
          source: "test",
        },
        {
          cgroup: "/user.slice/user-1000.slice/user@1000.service/app.slice/other.service",
          commandLine: "node ./start.mjs",
          elapsedMs: 120_000,
          pid: 557,
          ppid: 1,
          source: "test",
        },
      ],
      orphanProcessGraceMs: 60_000,
      ownedProxyScriptPath,
      path,
      readProcessIdentity: (pid) =>
        pid === 333
          ? {
              argv: ["bunx", "@zed-industries/codex-acp@0.15.0"],
              source: "test",
              startTime: "boot-1:333",
            }
          : undefined,
      terminateProcessId: async (pid) => {
        terminated.push(pid)
      },
    })
    await registry.registerProcess({
      args: ["/home/ubuntu/.local/bin/hermes", "acp"],
      bridgeDeviceId: "device-1",
      command: "bun",
      pid: 333,
      runtimeProfileId: "hermes:default",
      sessionKey: "session-1",
    })

    const result = await registry.cleanupOrphanedProcesses()

    expect(result).toMatchObject({
      orphanedProcessCount: 3,
      terminatedOrphanedProcessCount: 3,
    })
    expect(terminated).toEqual([222, 555, 556])
    expect(registry.getProcessHealth()).toMatchObject({
      childCount: 1,
      startupReconciliation: {
        orphanedProcessCount: 0,
        status: "not_run",
        terminatedOrphanedProcessCount: 0,
      },
    })
  })

  test("periodic cleanup preserves escaped helpers while a matching external runtime is active", async () => {
    const path = tempRegistryPath()
    const currentCgroup = "/user.slice/user-1000.slice/user@1000.service/app.slice/0000-chat-bridge.service"
    const terminated: number[] = []
    const registry = new AcpBridgeProcessRegistry({
      currentCgroup,
      isProcessAlive: (pid) => pid === 333,
      listProcessCandidates: () => [
        {
          cgroup: currentCgroup,
          commandLine: "node ./start.mjs",
          elapsedMs: 120_000,
          pid: 555,
          ppid: 1,
          source: "test",
        },
        {
          cgroup: currentCgroup,
          commandLine:
            "/home/ubuntu/.bun/bin/bun /home/ubuntu/.codex/plugins/cache/context-mode/context-mode/1.0.162/start.mjs",
          elapsedMs: 120_000,
          parentCommandLine: "node ./start.mjs",
          pid: 556,
          ppid: 555,
          source: "test",
        },
      ],
      path,
      readProcessIdentity: (pid) =>
        pid === 333
          ? {
              argv: ["bunx", "@zed-industries/codex-acp@0.15.0"],
              source: "test",
              startTime: "boot-1:333",
            }
          : undefined,
      terminateProcessId: async (pid) => {
        terminated.push(pid)
      },
    })
    await registry.registerProcess({
      args: ["@zed-industries/codex-acp@0.15.0"],
      bridgeDeviceId: "device-1",
      command: "bunx",
      pid: 333,
      runtimeProfileId: "codex:codex-acp",
      sessionKey: "session-1",
    })

    const result = await registry.cleanupOrphanedProcesses()

    expect(result).toMatchObject({
      orphanedProcessCount: 0,
      terminatedOrphanedProcessCount: 0,
    })
    expect(terminated).toEqual([])
  })

  test("periodic cleanup ignores stale external runtime entries when cleaning escaped helpers", async () => {
    const path = tempRegistryPath()
    const currentCgroup = "/user.slice/user-1000.slice/user@1000.service/app.slice/0000-chat-bridge.service"
    const terminated: number[] = []
    const registry = new AcpBridgeProcessRegistry({
      currentCgroup,
      isProcessAlive: () => false,
      listProcessCandidates: () => [
        {
          cgroup: currentCgroup,
          commandLine: "node ./start.mjs",
          elapsedMs: 120_000,
          pid: 555,
          ppid: 1,
          source: "test",
        },
        {
          cgroup: currentCgroup,
          commandLine:
            "/home/ubuntu/.bun/bin/bun /home/ubuntu/.codex/plugins/cache/context-mode/context-mode/1.0.162/start.mjs",
          elapsedMs: 120_000,
          parentCommandLine: "node ./start.mjs",
          pid: 556,
          ppid: 555,
          source: "test",
        },
      ],
      path,
      terminateProcessId: async (pid) => {
        terminated.push(pid)
      },
    })
    await registry.registerProcess({
      args: ["@zed-industries/codex-acp@0.15.0"],
      bridgeDeviceId: "device-1",
      command: "bunx",
      pid: 333,
      runtimeProfileId: "codex:codex-acp",
      sessionKey: "session-1",
    })

    const result = await registry.cleanupOrphanedProcesses()

    expect(result).toMatchObject({
      orphanedProcessCount: 2,
      terminatedOrphanedProcessCount: 2,
    })
    expect(terminated).toEqual([555, 556])
  })

  test("startup reconciliation refuses claims for live ambiguous registered children", async () => {
    const path = tempRegistryPath()
    const registry = new AcpBridgeProcessRegistry({
      isProcessAlive: () => true,
      path,
      readProcessCommand: () => "unrelated process",
    })
    await registry.registerProcess({
      args: ["acp"],
      command: "codex",
      pid: 111,
      queueItemId: "queue-live",
      runtimeProfileId: "codex:default",
    })

    await registry.reconcileBeforeClaiming()

    expect(registry.getProcessHealth()).toMatchObject({
      ambiguousProcessCount: 1,
      canClaim: false,
      status: "ambiguous",
    })
  })

  test("startup reconciliation refuses exact argv matches when process start time changed", async () => {
    const path = tempRegistryPath()
    let startTime = "boot-1:123"
    const registry = new AcpBridgeProcessRegistry({
      isProcessAlive: () => true,
      path,
      readProcessIdentity: () => ({
        argv: ["/usr/local/bin/codex", "acp"],
        source: "test",
        startTime,
      }),
    })
    await registry.registerProcess({
      args: ["acp"],
      bridgeDeviceId: "device-1",
      claimId: "claim-1",
      command: "codex",
      pid: 111,
      queueItemId: "queue-live",
      runtimeProfileId: "codex:default",
      sessionKey: "session-1",
    })

    startTime = "boot-1:999"
    await registry.reconcileBeforeClaiming()

    expect(registry.getProcessHealth()).toMatchObject({
      ambiguousProcessCount: 1,
      canClaim: false,
      childCount: 1,
      status: "ambiguous",
    })
  })

  test("startup reconciliation refuses legacy entries without captured process identity", async () => {
    const path = tempRegistryPath()
    await writeFile(
      path,
      JSON.stringify({
        version: 1,
        entries: [
          {
            args: ["acp"],
            bridgeDeviceId: "device-1",
            command: "codex",
            id: "entry-1",
            pid: 111,
            queueItemId: "queue-live",
            runtimeProfileId: "codex:default",
            sessionKey: "session-1",
            startedAt: "2026-06-05T00:00:00.000Z",
            updatedAt: "2026-06-05T00:00:00.000Z",
          },
        ],
      }),
      "utf8",
    )
    const registry = new AcpBridgeProcessRegistry({
      isProcessAlive: () => true,
      path,
      readProcessIdentity: () => ({
        argv: ["/usr/local/bin/codex", "acp"],
        source: "test",
        startTime: "boot-1:123",
      }),
    })

    await registry.reconcileBeforeClaiming()

    expect(registry.getProcessHealth()).toMatchObject({
      ambiguousProcessCount: 1,
      canClaim: false,
      childCount: 1,
      status: "ambiguous",
    })
  })
})

function tempRegistryPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "acp-process-registry-"))
  tempDirs.push(dir)
  return join(dir, "registry.json")
}
