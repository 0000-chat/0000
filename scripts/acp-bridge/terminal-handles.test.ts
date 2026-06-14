import { describe, expect, test } from "bun:test"

import {
  TerminalHandleRegistry,
  terminalHandleKey,
  type TerminalHandle,
  type TerminalHandleScope,
} from "./terminal-handles"

describe("terminal handle registry", () => {
  test("creates and looks up a terminal handle by full bridge session scope", () => {
    const registry = new TerminalHandleRegistry()
    const handle = fakeHandle()
    const scope = baseScope()

    const record = registry.create({ handle, scope })

    expect(record).toMatchObject({
      generation: 1,
      key: terminalHandleKey(scope, record.terminalId),
      scope,
    })
    expect(registry.lookup(scope)).toBe(record)
  })

  test("does not leak lookups across organization, device, profile, thread, or agent session", () => {
    const registry = new TerminalHandleRegistry()
    const scope = baseScope()
    const record = registry.create({ handle: fakeHandle(), scope, terminalId: "terminal-1" })

    expect(registry.lookup({ ...scope, organizationId: "org-2" }, "terminal-1")).toBeUndefined()
    expect(registry.lookup({ ...scope, bridgeDeviceId: "device-2" }, "terminal-1")).toBeUndefined()
    expect(registry.lookup({ ...scope, runtimeProfileId: "claude:default" }, "terminal-1")).toBeUndefined()
    expect(registry.lookup({ ...scope, threadId: "thread-2" }, "terminal-1")).toBeUndefined()
    expect(registry.lookup({ ...scope, agentSessionId: "agent-session-2" }, "terminal-1")).toBeUndefined()
    expect(registry.lookup(scope, "terminal-1")).toBe(record)
  })

  test("keeps multiple terminal handles active within the same ACP session", async () => {
    const registry = new TerminalHandleRegistry()
    const scope = baseScope()
    const firstHandle = fakeHandle()
    const secondHandle = fakeHandle()

    const first = registry.create({ handle: firstHandle, scope, terminalId: "terminal-1" })
    const second = registry.create({ handle: secondHandle, scope, terminalId: "terminal-2" })

    expect(first.key).not.toBe(second.key)
    expect(first.generation).toBe(1)
    expect(second.generation).toBe(1)
    expect(registry.lookup(scope, "terminal-1")).toBe(first)
    expect(registry.lookup(scope, "terminal-2")).toBe(second)

    expect(await registry.kill(scope, { terminalId: "terminal-1" })).toEqual({
      generation: 1,
      key: first.key,
      status: "killed",
    })
    expect(firstHandle.kills).toEqual(["SIGTERM"])
    expect(secondHandle.kills).toEqual([])
    expect(registry.lookup(scope, "terminal-1")).toBeUndefined()
    expect(registry.lookup(scope, "terminal-2")).toBe(second)
  })

  test("kills a registered terminal and removes it from the registry", async () => {
    const registry = new TerminalHandleRegistry()
    const handle = fakeHandle()
    const scope = baseScope()

    const record = registry.create({ handle, scope })
    const result = await registry.kill(scope, { signal: "SIGTERM" })

    expect(result).toEqual({
      generation: 1,
      key: record.key,
      status: "killed",
    })
    expect(handle.kills).toEqual(["SIGTERM"])
    expect(handle.releases).toBe(0)
    expect(registry.lookup(scope)).toBeUndefined()
  })

  test("releases a registered terminal without killing it", async () => {
    const registry = new TerminalHandleRegistry()
    const handle = fakeHandle()
    const scope = baseScope()

    registry.create({ handle, scope })
    const result = await registry.release(scope)

    expect(result).toMatchObject({ generation: 1, status: "released" })
    expect(handle.kills).toEqual([])
    expect(handle.releases).toBe(1)
    expect(registry.lookup(scope)).toBeUndefined()
  })

  test("kills only handles in the requested agent session scope", async () => {
    const registry = new TerminalHandleRegistry()
    const scope = baseScope()
    const matching = fakeHandle()
    const otherThread = fakeHandle()
    const otherSession = fakeHandle()

    const matchingRecord = registry.create({ handle: matching, scope })
    registry.create({ handle: otherThread, scope: { ...scope, threadId: "thread-2" } })
    registry.create({ handle: otherSession, scope: { ...scope, agentSessionId: "agent-session-2" } })

    const results = await registry.killSession(scope)

    expect(results).toEqual([
      { generation: 1, key: matchingRecord.key, status: "killed" },
    ])
    expect(matching.kills).toEqual(["SIGTERM"])
    expect(otherThread.kills).toEqual([])
    expect(otherSession.kills).toEqual([])
    expect(registry.lookup(scope)).toBeUndefined()
    expect(registry.lookup({ ...scope, threadId: "thread-2" })).toBeDefined()
    expect(registry.lookup({ ...scope, agentSessionId: "agent-session-2" })).toBeDefined()
  })

  test("uses generations to fence stale release and kill operations", async () => {
    const registry = new TerminalHandleRegistry()
    const scope = baseScope()
    const oldHandle = fakeHandle()
    const newHandle = fakeHandle()

    const oldRecord = registry.create({ handle: oldHandle, scope, terminalId: "terminal-1" })
    const newRecord = registry.create({ handle: newHandle, scope, terminalId: "terminal-1" })

    expect(newRecord.generation).toBe(2)
    expect(await registry.release(scope, {
      generation: oldRecord.generation,
      terminalId: oldRecord.terminalId,
    })).toEqual({
      currentGeneration: 2,
      generation: 1,
      key: oldRecord.key,
      status: "stale",
    })
    expect(await registry.kill(scope, {
      generation: oldRecord.generation,
      terminalId: oldRecord.terminalId,
    })).toEqual({
      currentGeneration: 2,
      generation: 1,
      key: oldRecord.key,
      status: "stale",
    })
    expect(oldHandle.kills).toEqual([])
    expect(oldHandle.releases).toBe(0)
    expect(newHandle.kills).toEqual([])
    expect(registry.lookup(scope)).toBe(newRecord)
  })
})

function baseScope(): TerminalHandleScope {
  return {
    agentSessionId: "agent-session-1",
    bridgeDeviceId: "device-1",
    organizationId: "org-1",
    runtimeProfileId: "codex:default",
    threadId: "thread-1",
  }
}

function fakeHandle(): TerminalHandle & { kills: string[]; releases: number } {
  return {
    kills: [],
    releases: 0,
    kill(signal) {
      this.kills.push(signal ?? "SIGTERM")
    },
    release() {
      this.releases += 1
    },
  }
}
