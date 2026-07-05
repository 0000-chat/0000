import {
  AgentSideConnection,
  PROTOCOL_VERSION,
  RequestError,
  type Agent,
  type Stream,
} from "@agentclientprotocol/sdk"
import { mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, test } from "bun:test"

import {
  SdkAcpRuntimeClient,
  type SdkAcpRuntimeActivity,
  type SdkAcpRuntimeTerminalHandle,
} from "./sdk-acp-runtime-client"
import { TerminalHandleRegistry } from "./terminal-handles"

test("bridges SDK session updates through the runtime client interface", async () => {
  const streams = createPairedStreams()
  let agentConnection: AgentSideConnection
  const agent: Agent = {
    authenticate: async () => undefined,
    cancel: async () => undefined,
    initialize: async (params) => ({
      agentCapabilities: { loadSession: true },
      protocolVersion: params.protocolVersion,
    }),
    newSession: async () => ({ sessionId: "session-1" }),
    prompt: async (params) => {
      await agentConnection.sessionUpdate({
        sessionId: params.sessionId,
        update: {
          content: { text: "sdk hello", type: "text" },
          sessionUpdate: "agent_message_chunk",
        },
      })
      return { stopReason: "end_turn" }
    },
  }
  agentConnection = new AgentSideConnection(() => agent, streams.agent)
  const client = new SdkAcpRuntimeClient({ stream: streams.client })
  const updates: unknown[] = []
  client.onUpdate((event) => updates.push(event))

  await expect(client.initialize()).resolves.toMatchObject({
    capabilities: { loadSession: true },
    raw: { protocolVersion: PROTOCOL_VERSION },
  })
  await expect(client.createSession({ cwd: "/tmp", mcpServers: [] })).resolves.toMatchObject({
    sessionId: "session-1",
  })
  await expect(
    client.prompt({
      prompt: [{ text: "hello", type: "text" }],
      sessionId: "session-1",
    }),
  ).resolves.toMatchObject({ stopReason: "end_turn" })
  expect(updates).toEqual([
    {
      sessionId: "session-1",
      update: {
        content: { text: "sdk hello", type: "text" },
        sessionUpdate: "agent_message_chunk",
      },
    },
  ])
})

test("delegates lifecycle and auth SDK methods through the runtime client interface", async () => {
  const streams = createPairedStreams()
  const calls: Array<{ method: string; params: unknown }> = []
  const agent: Agent = {
    authenticate: async (params) => {
      calls.push({ method: "authenticate", params })
      return { _meta: { authenticated: true } }
    },
    cancel: async () => undefined,
    closeSession: async (params) => {
      calls.push({ method: "closeSession", params })
      return { _meta: { closed: true } }
    },
    deleteSession: async (params) => {
      calls.push({ method: "deleteSession", params })
      return { _meta: { deleted: true } }
    },
    initialize: async (params) => ({
      agentCapabilities: {
        auth: { logout: {} },
        sessionCapabilities: {
          close: {},
          delete: {},
          list: {},
          resume: {},
        },
      },
      protocolVersion: params.protocolVersion,
    }),
    listSessions: async (params) => {
      calls.push({ method: "listSessions", params })
      return {
        nextCursor: "cursor-2",
        sessions: [
          {
            additionalDirectories: ["/tmp/project/packages/web"],
            cwd: "/tmp/project",
            sessionId: "session-1",
            title: "Existing session",
            updatedAt: "2026-06-08T00:00:00.000Z",
          },
        ],
      }
    },
    logout: async (params) => {
      calls.push({ method: "logout", params })
      return { _meta: { loggedOut: true } }
    },
    newSession: async () => ({ sessionId: "session-new" }),
    prompt: async () => ({ stopReason: "end_turn" }),
    resumeSession: async (params) => {
      calls.push({ method: "resumeSession", params })
      return { _meta: { resumed: true } }
    },
  }
  new AgentSideConnection(() => agent, streams.agent)
  const client = new SdkAcpRuntimeClient({ stream: streams.client })

  await client.initialize()

  await expect(client.listSessions({ cursor: "cursor-1", cwd: "/tmp/project" })).resolves.toEqual([
    {
      additionalDirectories: ["/tmp/project/packages/web"],
      cwd: "/tmp/project",
      sessionId: "session-1",
      title: "Existing session",
      updatedAt: "2026-06-08T00:00:00.000Z",
    },
  ])
  await expect(
    client.resumeSession({
      additionalDirectories: ["/tmp/project/packages/web"],
      cwd: "/tmp/project",
      mcpServers: [],
      sessionId: "session-1",
    }),
  ).resolves.toEqual({
    raw: { _meta: { resumed: true } },
    sessionId: "session-1",
  })
  await expect(client.closeSession({ sessionId: "session-1" })).resolves.toBeUndefined()
  await expect(client.deleteSession({ sessionId: "session-1" })).resolves.toBeUndefined()
  await expect(client.authenticate({ methodId: "oauth" })).resolves.toEqual({
    _meta: { authenticated: true },
  })
  await expect(client.logout()).resolves.toBeUndefined()

  expect(calls).toEqual([
    { method: "listSessions", params: { cursor: "cursor-1", cwd: "/tmp/project" } },
    {
      method: "resumeSession",
      params: {
        additionalDirectories: ["/tmp/project/packages/web"],
        cwd: "/tmp/project",
        mcpServers: [],
        sessionId: "session-1",
      },
    },
    { method: "closeSession", params: { sessionId: "session-1" } },
    { method: "deleteSession", params: { sessionId: "session-1" } },
    { method: "authenticate", params: { methodId: "oauth" } },
    { method: "logout", params: {} },
  ])
})

test("preserves clear SDK diagnostics when optional lifecycle methods are unsupported", async () => {
  const streams = createPairedStreams()
  const agent: Agent = {
    authenticate: async () => undefined,
    cancel: async () => undefined,
    initialize: async (params) => ({
      agentCapabilities: {},
      protocolVersion: params.protocolVersion,
    }),
    newSession: async () => ({ sessionId: "session-1" }),
    prompt: async () => ({ stopReason: "end_turn" }),
  }
  new AgentSideConnection(() => agent, streams.agent)
  const client = new SdkAcpRuntimeClient({ stream: streams.client })
  await client.initialize()

  await expectUnsupportedMethod(client.listSessions({}), "session/list")
  await expectUnsupportedMethod(client.deleteSession({ sessionId: "session-1" }), "session/delete")
  await expectUnsupportedMethod(
    client.resumeSession({ cwd: "/tmp/project", mcpServers: [], sessionId: "session-1" }),
    "session/resume",
  )
  await expectUnsupportedMethod(client.closeSession({ sessionId: "session-1" }), "session/close")
  await expectUnsupportedMethod(client.logout(), "logout")
})

test("preserves clear SDK diagnostics when authenticate is rejected by the SDK connection", async () => {
  const client = new SdkAcpRuntimeClient({
    connection: {
      authenticate: async () => {
        throw RequestError.methodNotFound("authenticate")
      },
    } as unknown as ConstructorParameters<typeof SdkAcpRuntimeClient>[0]["connection"],
  })

  await expectUnsupportedMethod(client.authenticate({ methodId: "oauth" }), "authenticate")
})

test("passes SDK request ids with permission callbacks", async () => {
  const streams = createPairedStreams()
  const requestContexts: Array<{ requestId?: unknown } | undefined> = []
  let agentConnection: AgentSideConnection
  const agent: Agent = {
    authenticate: async () => undefined,
    cancel: async () => undefined,
    initialize: async (params) => ({
      agentCapabilities: {},
      protocolVersion: params.protocolVersion,
    }),
    newSession: async () => ({ sessionId: "session-1" }),
    prompt: async (params) => {
      await agentConnection.requestPermission({
        options: [
          {
            kind: "allow_once",
            name: "Allow once",
            optionId: "allow_once",
          },
        ],
        sessionId: params.sessionId,
        toolCall: {
          kind: "edit",
          status: "pending",
          title: "Edit file",
          toolCallId: "tool-1",
        },
      })
      return { stopReason: "end_turn" }
    },
  }
  agentConnection = new AgentSideConnection(() => agent, streams.agent)
  const client = new SdkAcpRuntimeClient({
    onPermissionRequest: async (_params, context) => {
      requestContexts.push(context)
      return { outcome: { outcome: "cancelled" } }
    },
    stream: streams.client,
  })

  await client.initialize()
  await client.createSession({ cwd: "/tmp", mcpServers: [] })
  await client.prompt({
    prompt: [{ text: "hello", type: "text" }],
    sessionId: "session-1",
  })

  expect(requestContexts).toHaveLength(1)
  expect(requestContexts[0]?.requestId).toBeDefined()
})

test("serves SDK filesystem callbacks through the 0000 workspace policy", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "zero-acp-fs-"))
  const sourcePath = join(workspaceRoot, "source.txt")
  const targetPath = join(workspaceRoot, "target.txt")
  const approvalDeniedPath = join(workspaceRoot, "approval-denied.txt")
  const outsideRoot = await mkdtemp(join(tmpdir(), "zero-acp-fs-outside-"))
  const outsidePath = join(outsideRoot, "outside.txt")
  await writeFile(sourcePath, "allowed content", "utf8")
  await writeFile(outsidePath, "outside content must not persist", "utf8")

  const streams = createPairedStreams()
  const activities: SdkAcpRuntimeActivity[] = []
  let agentConnection: AgentSideConnection
  const agent: Agent = {
    authenticate: async () => undefined,
    cancel: async () => undefined,
    initialize: async (params) => ({
      agentCapabilities: {},
      protocolVersion: params.protocolVersion,
    }),
    newSession: async () => ({ sessionId: "session-1" }),
    prompt: async (params) => {
      let deniedReadRejected = false
      try {
        await agentConnection.readTextFile({
          path: outsidePath,
          sessionId: params.sessionId,
        })
      } catch {
        deniedReadRejected = true
      }
      if (!deniedReadRejected) {
        throw new Error("Expected denied filesystem read to reject")
      }
      const readResult = await agentConnection.readTextFile({
        path: sourcePath,
        sessionId: params.sessionId,
      })
      await agentConnection.writeTextFile({
        content: `${readResult.content} updated`,
        path: targetPath,
        sessionId: params.sessionId,
      })
      let deniedWriteRejected = false
      try {
        await agentConnection.writeTextFile({
          content: "approval denied content must not persist",
          path: approvalDeniedPath,
          sessionId: params.sessionId,
        })
      } catch {
        deniedWriteRejected = true
      }
      if (!deniedWriteRejected) {
        throw new Error("Expected denied filesystem write to reject")
      }
      return { stopReason: "end_turn" }
    },
  }
  agentConnection = new AgentSideConnection(() => agent, streams.agent)
  const client = new SdkAcpRuntimeClient({
    filesystemPolicy: {
      onWriteApprovalRequired: async (_diagnostic, params) => params.path !== approvalDeniedPath,
      workspaceRoots: [workspaceRoot],
    },
    onActivity: (activity) => {
      activities.push(activity)
    },
    stream: streams.client,
  })

  await client.initialize()
  const session = await client.createSession({ cwd: workspaceRoot, mcpServers: [] })
  await expect(
    client.prompt({
      prompt: [{ text: "use files", type: "text" }],
      sessionId: session.sessionId,
    }),
  ).resolves.toMatchObject({ stopReason: "end_turn" })
  await expect(readFile(targetPath, "utf8")).resolves.toBe("allowed content updated")
  const filesystemActivities = activities.filter((activity) => activity.type === "filesystem_activity")
  expect(filesystemActivities).toEqual([
    expect.objectContaining({
      allowed: false,
      contentOmitted: true,
      operation: "read",
      reason: "path_outside_workspace",
      requestedPath: outsidePath,
      sessionId: "session-1",
      status: "denied",
    }),
    expect.objectContaining({
      allowed: true,
      contentLength: "allowed content".length,
      contentOmitted: true,
      operation: "read",
      requestedPath: sourcePath,
      sessionId: "session-1",
      status: "allowed",
    }),
    expect.objectContaining({
      allowed: true,
      approval: expect.objectContaining({ outcome: "approved", required: true }),
      contentLength: "allowed content updated".length,
      contentOmitted: true,
      operation: "write",
      requestedPath: targetPath,
      sessionId: "session-1",
      status: "allowed",
    }),
    expect.objectContaining({
      allowed: false,
      approval: expect.objectContaining({ outcome: "denied", required: true }),
      contentLength: "approval denied content must not persist".length,
      contentOmitted: true,
      operation: "write",
      reason: "write_approval_denied",
      requestedPath: approvalDeniedPath,
      sessionId: "session-1",
      status: "denied",
    }),
  ])
  expect(JSON.stringify(filesystemActivities)).not.toContain("allowed content updated")
  expect(JSON.stringify(filesystemActivities)).not.toContain("approval denied content must not persist")
})

test("serves SDK terminal callbacks through the terminal handle registry", async () => {
  const streams = createPairedStreams()
  const registry = new TerminalHandleRegistry<SdkAcpRuntimeTerminalHandle>()
  const activities: SdkAcpRuntimeActivity[] = []
  const released: string[] = []
  const killed: string[] = []
  let handleCount = 0
  let agentConnection: AgentSideConnection
  const agent: Agent = {
    authenticate: async () => undefined,
    cancel: async () => undefined,
    initialize: async (params) => ({
      agentCapabilities: {},
      protocolVersion: params.protocolVersion,
    }),
    newSession: async () => ({ sessionId: "session-1" }),
    prompt: async (params) => {
      const command = `echo ${"x".repeat(400)}`
      const first = await agentConnection.createTerminal({
        command,
        sessionId: params.sessionId,
      })
      await expect(first.currentOutput()).resolves.toMatchObject({
        output: "terminal-1".repeat(600),
        truncated: false,
      })
      await expect(first.waitForExit()).resolves.toEqual({ exitCode: 0 })
      await first.release()

      const second = await agentConnection.createTerminal({
        command: "sleep",
        sessionId: params.sessionId,
      })
      await second.kill()
      return { stopReason: "end_turn" }
    },
  }
  agentConnection = new AgentSideConnection(() => agent, streams.agent)
  const client = new SdkAcpRuntimeClient({
    stream: streams.client,
    terminalAdapter: {
      createTerminal: async () => {
        handleCount += 1
        const id = `terminal-${handleCount}`
        return {
          currentOutput: async () => ({ output: id.repeat(600), truncated: false }),
          kill: async () => {
            killed.push(id)
          },
          release: async () => {
            released.push(id)
          },
          terminalId: id,
          waitForExit: async () => ({ exitCode: 0 }),
        }
      },
      registry,
      scope: {
        agentSessionId: "agent-session-1",
        bridgeDeviceId: "device-1",
        organizationId: "org-1",
        runtimeProfileId: "codex:codex-acp",
        threadId: "thread-1",
      },
    },
    onActivity: (activity) => {
      activities.push(activity)
    },
  })

  await client.initialize()
  const session = await client.createSession({ cwd: "/tmp", mcpServers: [] })
  await expect(
    client.prompt({ prompt: [{ text: "use terminal", type: "text" }], sessionId: session.sessionId }),
  ).resolves.toMatchObject({ stopReason: "end_turn" })
  expect(released).toEqual(["terminal-1"])
  expect(killed).toEqual(["terminal-2"])
  expect(registry.list()).toHaveLength(0)
  const terminalActivities = activities.filter((activity) => activity.type === "terminal_activity")
  expect(terminalActivities).toEqual([
    expect.objectContaining({
      action: "created",
      command: expect.stringMatching(/^echo x+$/),
      generation: 1,
      sessionId: "session-1",
      status: "running",
      terminalId: "terminal-1",
    }),
    expect.objectContaining({
      action: "output",
      outputTruncated: true,
      status: "output",
      terminalId: "terminal-1",
    }),
    expect.objectContaining({
      action: "exit",
      exitCode: 0,
      status: "exited",
      terminalId: "terminal-1",
    }),
    expect.objectContaining({
      action: "released",
      status: "released",
      terminalId: "terminal-1",
    }),
    expect.objectContaining({
      action: "created",
      generation: 2,
      sessionId: "session-1",
      status: "running",
      terminalId: "terminal-2",
    }),
    expect.objectContaining({
      action: "killed",
      status: "killed",
      terminalId: "terminal-2",
    }),
  ])
  const outputActivity = terminalActivities.find(
    (activity) => activity.type === "terminal_activity" && activity.action === "output",
  )
  expect(outputActivity?.output).toHaveLength(4096)
  const createActivity = terminalActivities.find(
    (activity) => activity.type === "terminal_activity" && activity.action === "created",
  )
  expect(createActivity?.command).toHaveLength(300)
})

function createPairedStreams(): { agent: Stream; client: Stream } {
  const clientToAgent = new TransformStream()
  const agentToClient = new TransformStream()
  return {
    agent: {
      readable: clientToAgent.readable,
      writable: agentToClient.writable,
    } as unknown as Stream,
    client: {
      readable: agentToClient.readable,
      writable: clientToAgent.writable,
    } as unknown as Stream,
  }
}

async function expectUnsupportedMethod(promise: Promise<unknown>, method: string): Promise<void> {
  try {
    await promise
    throw new Error(`Expected ${method} to reject`)
  } catch (error) {
    expect(error).toMatchObject({
      code: -32601,
      data: { method },
      name: "RequestError",
    })
    expect(error).toHaveProperty("message", `"Method not found": ${method}`)
  }
}
