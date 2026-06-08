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
      key: terminalHandleKey(scope),
      scope,
    })
    expect(registry.lookup(scope)).toBe(record)
  })

  test("does not leak lookups across organization, device, profile, thread, or agent session", () => {
    const registry = new TerminalHandleRegistry()
    const scope = baseScope()
    const record = registry.create({ handle: fakeHandle(), scope })

    expect(registry.lookup({ ...scope, organizationId: "org-2" })).toBeUndefined()
    expect(registry.lookup({ ...scope, bridgeDeviceId: "device-2" })).toBeUndefined()
    expect(registry.lookup({ ...scope, runtimeProfileId: "claude:default" })).toBeUndefined()
    expect(registry.lookup({ ...scope, threadId: "thread-2" })).toBeUndefined()
    expect(registry.lookup({ ...scope, agentSessionId: "agent-session-2" })).toBeUndefined()
    expect(registry.lookup(scope)).toBe(record)
  })

  test("kills a registered terminal and removes it from the registry", async () => {
    const registry = new TerminalHandleRegistry()
    const handle = fakeHandle()
    const scope = baseScope()

    registry.create({ handle, scope })
    const result = await registry.kill(scope, { signal: "SIGTERM" })

    expect(result).toEqual({ generation: 1, key: terminalHandleKey(scope), status: "killed" })
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

    expect(result).toEqual({ generation: 1, key: terminalHandleKey(scope), status: "released" })
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

    registry.create({ handle: matching, scope })
    registry.create({ handle: otherThread, scope: { ...scope, threadId: "thread-2" } })
    registry.create({ handle: otherSession, scope: { ...scope, agentSessionId: "agent-session-2" } })

    const results = await registry.killSession(scope)

    expect(results).toEqual([{ generation: 1, key: terminalHandleKey(scope), status: "killed" }])
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

    const oldRecord = registry.create({ handle: oldHandle, scope })
    const newRecord = registry.create({ handle: newHandle, scope })

    expect(newRecord.generation).toBe(2)
    expect(await registry.release(scope, { generation: oldRecord.generation })).toEqual({
      currentGeneration: 2,
      generation: 1,
      key: terminalHandleKey(scope),
      status: "stale",
    })
    expect(await registry.kill(scope, { generation: oldRecord.generation })).toEqual({
      currentGeneration: 2,
      generation: 1,
      key: terminalHandleKey(scope),
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
