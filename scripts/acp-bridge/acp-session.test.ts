import type { ChildProcessWithoutNullStreams } from "node:child_process"
import { EventEmitter } from "node:events"
import { PassThrough, Writable } from "node:stream"
import { describe, expect, test } from "bun:test"

import {
  DEFAULT_ACP_PROCESS_EXIT_GRACE_MS,
  HermesAcpRuntimeAdapter,
  HermesAcpSession,
  type JsonRpcMessage,
  resolveRuntimeConfigApplication,
} from "./acp-session"

describe("ACP final text extraction", () => {
  test("keeps simple Codex ACP answer chunks when the turn has no tool activity", async () => {
    const session = new HermesAcpSession({
      agentCommand: "npx --yes @zed-industries/codex-acp@0.15.0",
      spawnProcess: createFakeAcpProcess({
        updates: [
          { content: { text: "ACP", type: "text" }, sessionUpdate: "agent_message_chunk" },
          { content: { text: " smoke", type: "text" }, sessionUpdate: "agent_message_chunk" },
          { content: { text: " ok", type: "text" }, sessionUpdate: "agent_message_chunk" },
        ],
      }),
    })

    const result = await session.sendUserMessage("hello")

    expect(result.text).toBe("ACP smoke ok")
    expect(result.finalText).toMatchObject({
      answerChunkCount: 3,
      answerTextLength: 12,
      runtimeId: "codex",
      thoughtChunkCount: 0,
      toolEventCount: 0,
      trustedFinalResultText: false,
      withheld: false,
    })
  })

  test("withholds Codex ACP text when tool activity has no classified thought events", async () => {
    const session = new HermesAcpSession({
      agentCommand: "npx --yes @zed-industries/codex-acp@0.15.0",
      spawnProcess: createFakeAcpProcess({
        updates: [
          { content: { text: "private reasoning", type: "text" }, sessionUpdate: "agent_message_chunk" },
          { content: { name: "shell", type: "tool_call" }, sessionUpdate: "tool_call" },
          { content: { text: "\nfinal answer", type: "text" }, sessionUpdate: "agent_message_chunk" },
        ],
      }),
    })

    const result = await session.sendUserMessage("hello")

    expect(result.text).toBe("")
    expect(result.events.filter((event) => event.part?.type === "text")).toEqual([])
    expect(result.events.filter((event) => event.part?.type === "thinking")).toHaveLength(2)
    expect(result.events.filter((event) => event.eventType === "agent_thought_chunk")).toHaveLength(2)
    expect(result.finalText?.withheld).toBe(true)
    expect(result.finalText).toMatchObject({
      answerChunkCount: 2,
      answerTextLength: 30,
      runtimeId: "codex",
      thoughtChunkCount: 0,
    })
  })

  test("keeps Codex ACP answer chunks when the turn has classified thought events", async () => {
    const session = new HermesAcpSession({
      agentCommand: ["npx", "--yes", "@zed-industries/codex-acp@0.15.0"],
      spawnProcess: createFakeAcpProcess({
        updates: [
          { content: { text: "private reasoning", type: "text" }, sessionUpdate: "agent_thought_chunk" },
          { content: { text: "final", type: "text" }, sessionUpdate: "agent_message_chunk" },
          { content: { text: " answer", type: "text" }, sessionUpdate: "agent_message_chunk" },
        ],
      }),
    })

    const result = await session.sendUserMessage("hello")

    expect(result.text).toBe("final answer")
    expect(result.finalText?.withheld).toBe(false)
  })

  test("reclassifies streamed Codex message chunks as hidden thinking when a later tool appears", async () => {
    const observedEvents: Array<{ eventType: string; partType?: string }> = []
    const session = new HermesAcpSession({
      agentCommand: "npx --yes @zed-industries/codex-acp@0.15.0",
      onEvent: (event) => {
        observedEvents.push({ eventType: event.eventType, partType: event.part?.type })
      },
      spawnProcess: createFakeAcpProcess({
        updates: [
          { content: { text: "first ", type: "text" }, sessionUpdate: "agent_message_chunk" },
          { content: { text: "thought", type: "text" }, sessionUpdate: "agent_message_chunk" },
          { content: { name: "shell", type: "tool_call" }, sessionUpdate: "tool_call" },
          { content: { text: "tool output", type: "text" }, sessionUpdate: "tool_call_update" },
          { content: { text: " second", type: "text" }, sessionUpdate: "agent_message_chunk" },
          { content: { text: " thought", type: "text" }, sessionUpdate: "agent_message_chunk" },
        ],
      }),
    })

    const result = await session.sendUserMessage("hello")

    expect(result.text).toBe("")
    expect(result.finalText).toMatchObject({
      answerChunkCount: 4,
      answerTextLength: 28,
      reason: "codex_unclassified_message_chunks",
      runtimeId: "codex",
      thoughtChunkCount: 0,
      toolEventCount: 2,
      withheld: true,
    })
    expect(result.events.map((event) => event.eventType)).toEqual([
      "agent_thought_chunk",
      "agent_thought_chunk",
      "tool_call",
      "tool_call_update",
      "agent_thought_chunk",
      "agent_thought_chunk",
    ])
    expect(result.events.filter((event) => event.part?.type === "text")).toEqual([])
    expect(result.events.filter((event) => event.part?.type === "thinking")).toHaveLength(4)
    expect(observedEvents).toEqual([
      { eventType: "tool_call", partType: "tool_call" },
      { eventType: "tool_call_update", partType: "tool_result" },
      { eventType: "agent_thought_chunk", partType: "thinking" },
      { eventType: "agent_thought_chunk", partType: "thinking" },
      { eventType: "agent_thought_chunk", partType: "thinking" },
      { eventType: "agent_thought_chunk", partType: "thinking" },
    ])
  })

  test("keeps non-Codex ACP message chunk accumulation unchanged", async () => {
    const session = new HermesAcpSession({
      agentCommand: "hermes acp",
      spawnProcess: createFakeAcpProcess({
        updates: [
          { content: { text: "normal", type: "text" }, sessionUpdate: "agent_message_chunk" },
          { content: { text: " answer", type: "text" }, sessionUpdate: "agent_message_chunk" },
        ],
      }),
    })

    const result = await session.sendUserMessage("hello")

    expect(result.text).toBe("normal answer")
    expect(result.finalText?.withheld).toBe(false)
  })
})

describe("ACP runtime adapter boundary", () => {
  test("lets the node proxy run its process-group kill fallback before bridge escalation", () => {
    expect(DEFAULT_ACP_PROCESS_EXIT_GRACE_MS).toBeGreaterThan(1000)
  })

  test("retries session creation with an empty MCP server list when a runtime rejects configured MCP servers", async () => {
    const requests: JsonRpcMessage[] = []
    const errors: string[] = []
    const session = new HermesAcpSession({
      agentCommand: "openclaw acp",
      mcpServers: [{ args: ["serve"], command: "/bin/0000-mcp", name: "0000" }],
      onError: (error) => {
        errors.push(error.message)
      },
      spawnProcess: createFakeAcpProcess({
        failSessionNewWithMcpServers: true,
        requests,
        updates: [],
      }),
    })

    await expect(session.start()).resolves.toBe("session-1")

    expect(requests.map((request) => request.method)).toEqual([
      "initialize",
      "session/new",
      "session/new",
    ])
    expect(requests[1]?.params).toMatchObject({ mcpServers: expect.any(Array) })
    expect(requests[2]?.params).toMatchObject({ mcpServers: [] })
    expect(errors).toContain(
      "ACP session/new rejected configured MCP servers; retrying with an empty MCP server list",
    )
  })

  test("sends an empty MCP server list when no client MCP servers are configured", async () => {
    const requests: JsonRpcMessage[] = []
    const session = new HermesAcpSession({
      agentCommand: "openclaw acp",
      spawnProcess: createFakeAcpProcess({
        requests,
        updates: [],
      }),
    })

    await session.start()

    expect(requests[1]?.params).toMatchObject({ mcpServers: [] })
  })

  test("preserves safe ACP error kind diagnostics without exposing raw error payloads", async () => {
    const session = new HermesAcpSession({
      agentCommand: "claude acp",
      spawnProcess: createFakeAcpProcess({
        promptError: {
          code: -32603,
          data: { errorKind: "authentication_failed" },
          message: "Internal error: Failed to authenticate. API Error: 401 Invalid authentication credentials",
        },
        updates: [],
      }),
    })

    await expect(session.sendUserMessage("hello")).rejects.toThrow(
      "ACP session/prompt failed: provider_login_failed (code -32603)",
    )
  })

  test("force-kills the ACP process when graceful termination does not exit", async () => {
    const kills: Array<NodeJS.Signals | undefined> = []
    const session = new HermesAcpSession({
      agentCommand: "openclaw acp",
      processExitGraceMs: 1,
      spawnProcess: createFakeAcpProcess({ kills, updates: [] }),
    })

    await session.start()
    await session.close()

    expect(kills).toEqual(["SIGTERM", "SIGKILL"])
  })

  test("does not force-kill the ACP process when graceful termination exits", async () => {
    const kills: Array<NodeJS.Signals | undefined> = []
    const session = new HermesAcpSession({
      agentCommand: "openclaw acp",
      processExitGraceMs: 50,
      spawnProcess: createFakeAcpProcess({
        emitExitOnKill: true,
        kills,
        updates: [],
      }),
    })

    await session.start()
    await session.close()

    expect(kills).toEqual(["SIGTERM"])
  })

  test("wraps runtime operations in tagged adapter results", async () => {
    const adapter = new HermesAcpRuntimeAdapter({
      createSession: () =>
        new HermesAcpSession({
          agentCommand: "hermes acp",
          spawnProcess: createFakeAcpProcess({ updates: [] }),
        }),
    })

    const created = await adapter.createSession({ agentCommand: "hermes acp" })
    expect(created).toMatchObject({
      ok: true,
      capabilityUsed: "createSession",
      nativeMethod: "session/new",
    })
    if (!created.ok) {
      throw new Error("expected session creation to succeed")
    }

    const prompt = await adapter.sendPrompt(created.session, "hello")
    expect(prompt).toMatchObject({
      ok: true,
      capabilityUsed: "sendPrompt",
      nativeMethod: "session/prompt",
    })

    const closed = await adapter.closeSession(created.session)
    expect(closed).toMatchObject({
      ok: true,
      capabilityUsed: "closeSession",
      nativeMethod: "process.kill",
    })
  })

  test("reports unsupported interaction responses through adapter result tags", async () => {
    const adapter = new HermesAcpRuntimeAdapter()
    const session = new HermesAcpSession({
      agentCommand: "hermes acp",
      spawnProcess: createFakeAcpProcess({ updates: [] }),
    })

    const result = await adapter.sendInteractionResponse(session, {
      approved: true,
      externalRequestId: "missing",
    })

    expect(result).toMatchObject({
      ok: false,
      capabilityUsed: "sendInteractionResponse",
      diagnosticReasonCode: "permission_response_unmatched",
    })
  })

  test("applies runtime config fallback when an option disappears at claim time", async () => {
    expect(
      resolveRuntimeConfigApplication({
        requested: { model: "gpt-5.5", thoughtLevel: "high" },
        supportedOptions: { model: ["gpt-5.5"], thoughtLevel: ["medium"] },
      }),
    ).toEqual({
      applied: { model: "gpt-5.5" },
      diagnostics: [
        {
          option: "thoughtLevel",
          reasonCode: "runtime_config_option_unavailable",
          value: "high",
        },
      ],
      ok: true,
      policy: "omit_unavailable",
    })
  })

  test("sets ACP session config options around a prompt", async () => {
    const requests: JsonRpcMessage[] = []
    const session = new HermesAcpSession({
      agentCommand: "hermes acp",
      spawnProcess: createFakeAcpProcess({
        configOptions: [
          { currentValue: "default-model", id: "model" },
          { currentValue: "medium", id: "thoughtLevel" },
        ],
        requests,
        updates: [],
      }),
    })

    await session.sendUserMessage("hello", {
      runtimeConfig: { model: "gpt-5.5", thoughtLevel: "high" },
    })

    expect(requests.map((request) => request.method)).toEqual([
      "initialize",
      "session/new",
      "session/set_config_option",
      "session/set_config_option",
      "session/prompt",
      "session/set_config_option",
      "session/set_config_option",
    ])
    expect(requests[2]?.params).toMatchObject({
      configId: "model",
      sessionId: "session-1",
      value: "gpt-5.5",
    })
    expect(requests[3]?.params).toMatchObject({
      configId: "thoughtLevel",
      sessionId: "session-1",
      value: "high",
    })
    expect(requests[5]?.params).toMatchObject({
      configId: "model",
      sessionId: "session-1",
      value: "default-model",
    })
    expect(requests[6]?.params).toMatchObject({
      configId: "thoughtLevel",
      sessionId: "session-1",
      value: "medium",
    })
  })

  test("sends attachment references as ACP resource link content blocks", async () => {
    const requests: JsonRpcMessage[] = []
    const session = new HermesAcpSession({
      agentCommand: "hermes acp",
      spawnProcess: createFakeAcpProcess({
        requests,
        updates: [],
      }),
    })

    await session.sendUserMessage("review these", {
      attachments: [
        {
          filename: "diagram.png",
          mediaType: "image/png",
          sizeBytes: 1234,
          url: "https://app.example.test/api/attachments/image",
        },
        {
          filename: "notes.txt",
          mediaType: "text/plain",
          sizeBytes: 42,
          url: "https://app.example.test/api/attachments/file",
        },
      ],
      systemPrompt: "Prefer concise answers.",
    })

    const promptRequest = requests.find((request) => request.method === "session/prompt")
    expect(promptRequest?.params).toMatchObject({ sessionId: "session-1" })
    const params = promptRequest?.params as { prompt?: unknown[] } | undefined
    expect(params?.prompt).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          _meta: { "0000.chat/role": "system" },
          text: expect.stringContaining("Prefer concise answers."),
          type: "text",
        }),
        { text: "review these", type: "text" },
        {
          mimeType: "image/png",
          name: "diagram.png",
          size: 1234,
          type: "resource_link",
          uri: "https://app.example.test/api/attachments/image",
        },
        {
          mimeType: "text/plain",
          name: "notes.txt",
          size: 42,
          type: "resource_link",
          uri: "https://app.example.test/api/attachments/file",
        },
      ]),
    )
  })

  test("falls back to text attachment references when resource links are disabled", async () => {
    const requests: JsonRpcMessage[] = []
    const session = new HermesAcpSession({
      agentCommand: "legacy acp",
      spawnProcess: createFakeAcpProcess({
        initializeResult: {
          agentCapabilities: {
            _meta: { "0000.chat/promptResourceLinks": false },
            sessionCapabilities: {},
          },
        },
        requests,
        updates: [],
      }),
    })

    const result = await session.sendUserMessage("review this", {
      attachmentReferenceText:
        "Attached files available to this ACP run:\n- report.pdf (application/pdf, 55 bytes): https://app.example.test/report.pdf",
      attachments: [
        {
          filename: "report.pdf",
          mediaType: "application/pdf",
          sizeBytes: 55,
          url: "https://app.example.test/report.pdf",
        },
      ],
    })

    const promptRequest = requests.find((request) => request.method === "session/prompt")
    const params = promptRequest?.params as { prompt?: unknown[] } | undefined
    expect(params?.prompt).toContainEqual({
      text: "review this\n\nAttached files available to this ACP run:\n- report.pdf (application/pdf, 55 bytes): https://app.example.test/report.pdf",
      type: "text",
    })
    expect(params?.prompt).not.toContainEqual(
      expect.objectContaining({ type: "resource_link" }),
    )
    expect(result.attachmentDeliveryMode).toBe("text_references")
  })
})

function createFakeAcpProcess(options: {
  configOptions?: Array<{ currentValue: string; id: string }>
  emitExitOnKill?: boolean
  failSessionNewWithMcpServers?: boolean
  initializeResult?: unknown
  kills?: Array<NodeJS.Signals | undefined>
  promptError?: { code: number; data?: Record<string, unknown>; message: string }
  promptResult?: unknown
  requests?: JsonRpcMessage[]
  updates: Array<Record<string, unknown>>
}): () => ChildProcessWithoutNullStreams {
  return () => {
    const stdout = new PassThrough()
    const stderr = new PassThrough()
    const stdin = new Writable({
      write(chunk, _encoding, callback): void {
        try {
          for (const line of chunk.toString("utf8").split("\n")) {
            if (!line.trim()) {
              continue
            }
            const message = JSON.parse(line) as JsonRpcMessage
            options.requests?.push(message)
            handleRequest(message, stdout, options)
          }
          callback()
        } catch (error) {
          callback(error instanceof Error ? error : new Error(String(error)))
        }
      },
    })
    const process = Object.assign(new EventEmitter(), {
      kill: (signal?: NodeJS.Signals) => {
        options.kills?.push(signal)
        if (options.emitExitOnKill) {
          queueMicrotask(() => {
            process.emit("exit", signal === "SIGKILL" ? 137 : 0, signal ?? null)
          })
        }
        return true
      },
      stderr,
      stdin,
      stdout,
    }) as unknown as ChildProcessWithoutNullStreams
    return process
  }
}

function handleRequest(
  message: JsonRpcMessage,
  stdout: PassThrough,
  options: {
    configOptions?: Array<{ currentValue: string; id: string }>
    failSessionNewWithMcpServers?: boolean
    initializeResult?: unknown
    promptError?: { code: number; data?: Record<string, unknown>; message: string }
    promptResult?: unknown
    updates: Array<Record<string, unknown>>
  },
) {
  if (message.method === "initialize") {
    writeJson(stdout, {
      id: message.id,
      jsonrpc: "2.0",
      result: options.initializeResult ?? { agentCapabilities: { sessionCapabilities: {} } },
    })
    return
  }

  if (message.method === "session/new") {
    const params =
      message.params && typeof message.params === "object" && !Array.isArray(message.params)
        ? (message.params as Record<string, unknown>)
        : {}
    if (
      options.failSessionNewWithMcpServers &&
      Array.isArray(params.mcpServers) &&
      params.mcpServers.length > 0
    ) {
      writeJson(stdout, {
        error: { code: -32602, message: "mcpServers are not supported" },
        id: message.id,
        jsonrpc: "2.0",
      })
      return
    }
    writeJson(stdout, {
      id: message.id,
      jsonrpc: "2.0",
      result: { configOptions: options.configOptions, sessionId: "session-1" },
    })
    return
  }

  if (message.method === "session/set_config_option") {
    const params =
      message.params && typeof message.params === "object" && !Array.isArray(message.params)
        ? (message.params as Record<string, unknown>)
        : {}
    const configId = typeof params.configId === "string" ? params.configId : undefined
    const value = typeof params.value === "string" ? params.value : undefined
    if (configId && value) {
      options.configOptions = (options.configOptions ?? []).map((option) =>
        option.id === configId ? { ...option, currentValue: value } : option,
      )
    }
    writeJson(stdout, {
      id: message.id,
      jsonrpc: "2.0",
      result: { configOptions: options.configOptions },
    })
    return
  }

  if (message.method === "session/prompt") {
    if (options.promptError) {
      writeJson(stdout, {
        error: options.promptError,
        id: message.id,
        jsonrpc: "2.0",
      })
      return
    }
    for (const update of options.updates) {
      writeJson(stdout, {
        jsonrpc: "2.0",
        method: "session/update",
        params: { sessionId: "session-1", update },
      })
    }
    writeJson(stdout, {
      id: message.id,
      jsonrpc: "2.0",
      result: options.promptResult ?? { stopReason: "end_turn" },
    })
  }
}

function writeJson(stdout: PassThrough, message: unknown) {
  stdout.write(`${JSON.stringify(message)}\n`)
}
