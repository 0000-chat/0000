import type { ChildProcessWithoutNullStreams } from "node:child_process"
import { EventEmitter } from "node:events"
import { PassThrough, Readable, Writable } from "node:stream"
import { describe, expect, test } from "bun:test"
import { AgentSideConnection, ndJsonStream, type Agent } from "@agentclientprotocol/sdk"

import {
  DEFAULT_ACP_PROCESS_EXIT_GRACE_MS,
  HermesAcpRuntimeAdapter,
  HermesAcpSession,
  resolveRuntimeConfigApplication,
} from "./acp-session"
import type {
  BridgeAcpRawUpdate,
  BridgeAcpRuntimeClient,
  BridgeCreateSessionParams,
  BridgePromptParams,
  BridgeSetConfigOptionParams,
} from "./acp-runtime-client"
import type {
  InitializeResponse,
  PromptResponse,
  RequestPermissionResponse,
  SessionConfigOption,
} from "@agentclientprotocol/sdk"
import { TerminalHandleRegistry } from "./terminal-handles"
import type { SdkAcpRuntimeTerminalHandle } from "./sdk-acp-runtime-client"

type RuntimeRequest = {
  method: string
  params: unknown
}

type FakeRuntimeUpdate = Record<string, unknown>
type DelayedFakeRuntimeUpdate = { delayMs: number; update: FakeRuntimeUpdate }

describe("ACP final text extraction", () => {
  test("keeps simple Codex ACP answer chunks when the turn has no tool activity", async () => {
    const session = new HermesAcpSession({
      agentCommand: "bunx @zed-industries/codex-acp@0.16.0",
      runtimeClient: createFakeRuntimeClient({
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

  test("keeps post-tool Codex ACP text while hiding pre-tool unclassified text", async () => {
    const session = new HermesAcpSession({
      agentCommand: "bunx @zed-industries/codex-acp@0.16.0",
      runtimeClient: createFakeRuntimeClient({
        updates: [
          { content: { text: "private reasoning", type: "text" }, sessionUpdate: "agent_message_chunk" },
          { content: { name: "shell", type: "tool_call" }, sessionUpdate: "tool_call" },
          { content: { text: "\nfinal answer", type: "text" }, sessionUpdate: "agent_message_chunk" },
        ],
      }),
    })

    const result = await session.sendUserMessage("hello")

    expect(result.text).toBe("\nfinal answer")
    expect(result.events.filter((event) => event.part?.type === "text")).toHaveLength(1)
    expect(result.events.filter((event) => event.part?.type === "thinking")).toHaveLength(1)
    expect(result.events.filter((event) => event.eventType === "agent_thought_chunk")).toHaveLength(1)
    expect(result.finalText?.withheld).toBe(false)
    expect(result.finalText).toMatchObject({
      answerChunkCount: 1,
      answerTextLength: 13,
      runtimeId: "codex",
      thoughtChunkCount: 0,
    })
  })

  test("keeps Codex ACP final chunks emitted after completed tool activity", async () => {
    const session = new HermesAcpSession({
      agentCommand: "bunx @zed-industries/codex-acp@0.16.0",
      runtimeClient: createFakeRuntimeClient({
        updates: [
          { content: { name: "shell", type: "tool_call" }, sessionUpdate: "tool_call" },
          {
            content: { status: "completed", toolCallId: "tool-1", type: "tool_call_update" },
            sessionUpdate: "tool_call_update",
          },
          { content: { text: "Final", type: "text" }, sessionUpdate: "agent_message_chunk" },
          { content: { text: " answer", type: "text" }, sessionUpdate: "agent_message_chunk" },
        ],
      }),
    })

    const result = await session.sendUserMessage("hello")

    expect(result.text).toBe("Final answer")
    expect(result.events.filter((event) => event.part?.type === "text")).toHaveLength(2)
    expect(result.events.filter((event) => event.part?.type === "thinking")).toHaveLength(0)
    expect(result.finalText).toMatchObject({
      answerChunkCount: 2,
      answerTextLength: 12,
      runtimeId: "codex",
      thoughtChunkCount: 0,
      toolEventCount: 2,
      trustedFinalResultText: false,
      withheld: false,
    })
  })

  test("keeps Codex ACP answer chunks when the turn has classified thought events", async () => {
    const session = new HermesAcpSession({
      agentCommand: ["bunx", "@zed-industries/codex-acp@0.16.0"],
      runtimeClient: createFakeRuntimeClient({
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

  test("hides pre-tool Codex message chunks while keeping post-tool final chunks", async () => {
    const observedEvents: Array<{ eventType: string; partType?: string }> = []
    const session = new HermesAcpSession({
      agentCommand: "bunx @zed-industries/codex-acp@0.16.0",
      onEvent: (event) => {
        observedEvents.push({ eventType: event.eventType, partType: event.part?.type })
      },
      runtimeClient: createFakeRuntimeClient({
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

    expect(result.text).toBe(" second thought")
    expect(result.finalText).toMatchObject({
      answerChunkCount: 2,
      answerTextLength: 15,
      reason: "codex_unclassified_message_chunks",
      runtimeId: "codex",
      thoughtChunkCount: 0,
      toolEventCount: 2,
      withheld: false,
    })
    expect(result.events.map((event) => event.eventType)).toEqual([
      "agent_thought_chunk",
      "agent_thought_chunk",
      "tool_call",
      "tool_call_update",
      "agent_message_chunk",
      "agent_message_chunk",
    ])
    expect(result.events.filter((event) => event.part?.type === "text")).toHaveLength(2)
    expect(result.events.filter((event) => event.part?.type === "thinking")).toHaveLength(2)
    expect(observedEvents).toEqual([
      { eventType: "tool_call", partType: "tool_call" },
      { eventType: "tool_call_update", partType: "tool_result" },
      { eventType: "agent_thought_chunk", partType: "thinking" },
      { eventType: "agent_thought_chunk", partType: "thinking" },
      { eventType: "agent_message_chunk", partType: "text" },
      { eventType: "agent_message_chunk", partType: "text" },
    ])
  })

  test("keeps non-Codex ACP message chunk accumulation unchanged", async () => {
    const session = new HermesAcpSession({
      agentCommand: "hermes acp",
      runtimeClient: createFakeRuntimeClient({
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

  test("hides Claude Code ACP progress chunks before the last tool while keeping final text", async () => {
    const observedEvents: Array<{ eventType: string; partType?: string }> = []
    const session = new HermesAcpSession({
      agentCommand: "npx --yes @agentclientprotocol/claude-agent-acp@0.39.0",
      onEvent: (event) => {
        observedEvents.push({ eventType: event.eventType, partType: event.part?.type })
      },
      runtimeClient: createFakeRuntimeClient({
        updates: [
          { content: { text: "checking schema", type: "text" }, sessionUpdate: "agent_message_chunk" },
          { content: { name: "read", type: "tool_call" }, sessionUpdate: "tool_call" },
          {
            content: { status: "completed", toolCallId: "tool-1", type: "tool_call_update" },
            sessionUpdate: "tool_call_update",
          },
          { content: { text: "planning writes", type: "text" }, sessionUpdate: "agent_message_chunk" },
          { content: { name: "write", type: "tool_call" }, sessionUpdate: "tool_call" },
          {
            content: { status: "completed", toolCallId: "tool-2", type: "tool_call_update" },
            sessionUpdate: "tool_call_update",
          },
          { content: { text: "Done", type: "text" }, sessionUpdate: "agent_message_chunk" },
          { content: { text: ". All writes succeeded.", type: "text" }, sessionUpdate: "agent_message_chunk" },
        ],
      }),
    })

    const result = await session.sendUserMessage("hello")

    expect(result.text).toBe("Done. All writes succeeded.")
    expect(result.finalText).toMatchObject({
      answerChunkCount: 2,
      answerTextLength: 27,
      reason: "untrusted_message_chunks",
      runtimeId: "claude-code",
      toolEventCount: 4,
      withheld: false,
    })
    expect(result.events.map((event) => event.eventType)).toEqual([
      "agent_thought_chunk",
      "tool_call",
      "tool_call_update",
      "agent_thought_chunk",
      "tool_call",
      "tool_call_update",
      "agent_message_chunk",
      "agent_message_chunk",
    ])
    expect(result.events.filter((event) => event.part?.type === "thinking")).toHaveLength(2)
    expect(result.events.filter((event) => event.part?.type === "text")).toHaveLength(2)
    expect(observedEvents).toEqual([
      { eventType: "tool_call", partType: "tool_call" },
      { eventType: "tool_call_update", partType: "tool_result" },
      { eventType: "tool_call", partType: "tool_call" },
      { eventType: "tool_call_update", partType: "tool_result" },
      { eventType: "agent_thought_chunk", partType: "thinking" },
      { eventType: "agent_thought_chunk", partType: "thinking" },
      { eventType: "agent_message_chunk", partType: "text" },
      { eventType: "agent_message_chunk", partType: "text" },
    ])
  })
})

describe("ACP runtime adapter boundary", () => {
  test("keeps SDK permission callbacks pending with an app-actionable request id", async () => {
    const permissionEventSeen = deferred<void>()
    const permissionResponses: RequestPermissionResponse[] = []
    let permissionExternalRequestId: string | undefined

    const session = new HermesAcpSession({
      agentCommand: "codex acp",
      onEvent: (event) => {
        if (event.eventType === "permission_request") {
          permissionExternalRequestId = event.externalRequestId
          permissionEventSeen.resolve()
        }
      },
      spawnProcess: createFakeAcpProcess({
        permissionResponses,
        requestPermissionOnPrompt: true,
      }),
    })

    await session.start()
    const resultPromise = session.sendUserMessage("needs approval")

    await permissionEventSeen.promise
    await waitForMicrotasks()

    expect(typeof permissionExternalRequestId).toBe("string")
    expect(permissionExternalRequestId).not.toHaveLength(0)

    const delivered = await session.respondToPermissionRequest(permissionExternalRequestId ?? "", {
      approved: true,
    })
    expect(delivered).toBe(true)

    const result = await resultPromise

    expect(permissionResponses).toEqual([
      { outcome: { optionId: "allow_once", outcome: "selected" } },
    ])
    expect(result.stopReason).toBe("end_turn")
  })

  test("lets the node proxy run its process-group kill fallback before bridge escalation", () => {
    expect(DEFAULT_ACP_PROCESS_EXIT_GRACE_MS).toBeGreaterThan(1000)
  })

  test("preserves safe ACP error kind diagnostics without exposing raw error payloads", async () => {
    const session = new HermesAcpSession({
      agentCommand: "claude acp",
      runtimeClient: createFakeRuntimeClient({
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

  test("extends prompt timeout while ACP activity continues", async () => {
    const session = new HermesAcpSession({
      agentCommand: "codex acp",
      requestTimeoutMs: 30,
      runtimeClient: createFakeRuntimeClient({
        promptDelayMs: 20,
        updates: [
          {
            delayMs: 20,
            update: {
              content: { text: "still working", type: "text" },
              sessionUpdate: "agent_message_chunk",
            },
          },
        ],
      }),
    })

    const result = await session.sendUserMessage("long but active")

    expect(result.stopReason).toBe("end_turn")
  })

  test("suppresses routine Hermes stderr lifecycle logs", async () => {
    const processes: ChildProcessWithoutNullStreams[] = []
    const events: Array<{ eventType: string }> = []
    const errors: Error[] = []
    const session = new HermesAcpSession({
      agentCommand: "hermes acp",
      onError: (error) => {
        errors.push(error)
      },
      onEvent: (event) => {
        events.push({ eventType: event.eventType })
      },
      spawnProcess: createFakeAcpProcess({ processes }),
    })

    await session.start()
    const stderr = processes[0]?.stderr as PassThrough | undefined
    stderr?.write(
      [
        "acp_adapter.server: ACP client connected",
        "Initialize from unknown (protocol v1)",
        "run_agent: Loaded environment variables from profile",
        "OpenAI client created for request",
        "agent.auxiliary_client: Vision auto-detect enabled",
        "tools.terminal_tool: local environment ready",
        "OpenAI client closed request_complete",
      ].join("\n"),
    )
    await waitForMicrotasks()

    expect(events).toEqual([])
    expect(errors).toEqual([])
  })

  test("maps WARN Hermes stderr logs to runtime diagnostics", async () => {
    const processes: ChildProcessWithoutNullStreams[] = []
    const events: Array<{ eventType: string; payload: unknown; partType?: string }> = []
    const errors: Error[] = []
    const session = new HermesAcpSession({
      agentCommand: "hermes acp",
      onError: (error) => {
        errors.push(error)
      },
      onEvent: (event) => {
        events.push({
          eventType: event.eventType,
          partType: event.part?.type,
          payload: event.payload,
        })
      },
      spawnProcess: createFakeAcpProcess({ processes }),
    })

    await session.start()
    const stderr = processes[0]?.stderr as PassThrough | undefined
    stderr?.write("WARN acp_adapter.server: transient reconnect\n")
    await waitForMicrotasks()

    expect(errors).toEqual([])
    expect(events).toEqual([
      {
        eventType: "runtime_diagnostic",
        partType: "event",
        payload: {
          message: "WARN acp_adapter.server: transient reconnect",
          severity: "warn",
        },
      },
    ])
  })

  test("keeps ERROR Hermes stderr logs as single bridge error events", async () => {
    const processes: ChildProcessWithoutNullStreams[] = []
    const events: Array<{ eventType: string; partStatus?: string; partType?: string }> = []
    const errors: Error[] = []
    const session = new HermesAcpSession({
      agentCommand: "hermes acp",
      onError: (error) => {
        errors.push(error)
      },
      onEvent: (event) => {
        events.push({
          eventType: event.eventType,
          partStatus: event.part?.status,
          partType: event.part?.type,
        })
      },
      spawnProcess: createFakeAcpProcess({ processes }),
    })

    await session.start()
    const stderr = processes[0]?.stderr as PassThrough | undefined
    stderr?.write("ERROR acp_adapter.server: runtime crashed\n")
    await waitForMicrotasks()

    expect(errors).toEqual([])
    expect(events).toEqual([
      {
        eventType: "bridge_error",
        partStatus: "error",
        partType: "error",
      },
    ])
  })

  test("force-kills the ACP process when graceful termination does not exit", async () => {
    const kills: Array<NodeJS.Signals | undefined> = []
    const session = new HermesAcpSession({
      agentCommand: "openclaw acp",
      processExitGraceMs: 1,
      spawnProcess: createFakeAcpProcess({ kills }),
    })

    await session.start()
    await session.close()

    expect(kills).toEqual(["SIGTERM", "SIGKILL"])
  })

  test("registers spawned ACP children and closes them through the process registry", async () => {
    const kills: Array<NodeJS.Signals | undefined> = []
    const registered: Array<Record<string, unknown>> = []
    const terminated: string[] = []
    const session = new HermesAcpSession({
      agentCommand: ["codex", "acp"],
      processRegistry: {
        registerProcess: async (input) => {
          registered.push(input)
          return {
            ...input,
            id: "process-1",
            startedAt: "2026-06-12T00:00:00.000Z",
            updatedAt: "2026-06-12T00:00:00.000Z",
          }
        },
        terminateProcess: async (entry, child) => {
          terminated.push(entry.id)
          child?.kill("SIGTERM")
        },
      },
      spawnProcess: createFakeAcpProcess({ emitExitOnKill: true, kills, pid: 4321 }),
    })

    await session.start()
    await session.close()

    expect(registered).toEqual([
      expect.objectContaining({
        args: ["acp"],
        command: "codex",
        pid: 4321,
      }),
    ])
    expect(terminated).toEqual(["process-1"])
    expect(kills).toEqual(["SIGTERM"])
  })

  test("does not force-kill the ACP process when graceful termination exits", async () => {
    const kills: Array<NodeJS.Signals | undefined> = []
    const session = new HermesAcpSession({
      agentCommand: "openclaw acp",
      processExitGraceMs: 50,
      spawnProcess: createFakeAcpProcess({
        emitExitOnKill: true,
        kills,
      }),
    })

    await session.start()
    await session.close()

    expect(kills).toEqual(["SIGTERM"])
  })

  test("emits SDK terminal callback activity as durable bridge events", async () => {
    const events: Array<{ eventType: string; part?: { json?: unknown; type?: string }; source: string }> =
      []
    const registry = new TerminalHandleRegistry<SdkAcpRuntimeTerminalHandle>()
    const session = new HermesAcpSession({
      agentCommand: "openclaw acp",
      onEvent: (event) => {
        events.push(event)
      },
      spawnProcess: createFakeAcpProcess({ useTerminalOnPrompt: true }),
      terminalAdapter: {
        createTerminal: async () => ({
          currentOutput: async () => ({ output: "terminal output", truncated: false }),
          kill: async () => undefined,
          release: async () => undefined,
          terminalId: "terminal-1",
          waitForExit: async () => ({ exitCode: 0 }),
        }),
        registry,
        scope: {
          agentSessionId: "agent-session-1",
          bridgeDeviceId: "device-1",
          organizationId: "org-1",
          runtimeProfileId: "openclaw:acp",
          threadId: "thread-1",
        },
      },
    })

    const result = await session.sendUserMessage("use terminal")

    expect(result.events.filter((event) => event.eventType === "terminal_activity")).toHaveLength(3)
    expect(events.filter((event) => event.eventType === "terminal_activity")).toEqual([
      expect.objectContaining({
        part: expect.objectContaining({
          json: expect.objectContaining({ action: "created", terminalId: "terminal-1" }),
          type: "event",
        }),
        source: "bridge",
      }),
      expect.objectContaining({
        part: expect.objectContaining({
          json: expect.objectContaining({ action: "output", output: "terminal output" }),
          type: "event",
        }),
        source: "bridge",
      }),
      expect.objectContaining({
        part: expect.objectContaining({
          json: expect.objectContaining({ action: "exit", exitCode: 0 }),
          type: "event",
        }),
        source: "bridge",
      }),
    ])
  })

  test("wraps runtime operations in tagged adapter results", async () => {
    const adapter = new HermesAcpRuntimeAdapter({
      createSession: () =>
        new HermesAcpSession({
          agentCommand: "hermes acp",
          runtimeClient: createFakeRuntimeClient({ updates: [] }),
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
      runtimeClient: createFakeRuntimeClient({ updates: [] }),
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
    const requests: RuntimeRequest[] = []
    const session = new HermesAcpSession({
      agentCommand: "hermes acp",
      runtimeClient: createFakeRuntimeClient({
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
    const requests: RuntimeRequest[] = []
    const session = new HermesAcpSession({
      agentCommand: "hermes acp",
      runtimeClient: createFakeRuntimeClient({
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
    const requests: RuntimeRequest[] = []
    const session = new HermesAcpSession({
      agentCommand: "legacy acp",
      runtimeClient: createFakeRuntimeClient({
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

function createFakeRuntimeClient(options: {
  configOptions?: Array<{ currentValue: string; id: string }>
  initializeResult?: unknown
  promptDelayMs?: number
  promptError?: { code: number; data?: Record<string, unknown>; message: string }
  promptResult?: unknown
  requests?: RuntimeRequest[]
  updates: Array<FakeRuntimeUpdate | DelayedFakeRuntimeUpdate>
}): BridgeAcpRuntimeClient {
  const updateCallbacks = new Set<(event: BridgeAcpRawUpdate) => void>()
  return {
    async cancel() {
      options.requests?.push({ method: "session/cancel", params: { sessionId: "session-1" } })
      return true
    },
    async close() {},
    async closeSession(params) {
      options.requests?.push({ method: "session/close", params })
    },
    async createSession(params: BridgeCreateSessionParams) {
      options.requests?.push({ method: "session/new", params })
      const configOptions = options.configOptions as SessionConfigOption[] | undefined
      return {
        configOptions,
        raw: { configOptions, sessionId: "session-1" },
        sessionId: "session-1",
      }
    },
    async initialize() {
      options.requests?.push({ method: "initialize", params: undefined })
      const raw = (options.initializeResult ?? {
        agentCapabilities: { sessionCapabilities: {} },
        protocolVersion: 1,
      }) as InitializeResponse
      return { capabilities: raw.agentCapabilities, raw }
    },
    async loadSession(params) {
      options.requests?.push({ method: "session/load", params })
      return { raw: { sessionId: params.sessionId }, sessionId: params.sessionId }
    },
    onUpdate(callback) {
      updateCallbacks.add(callback)
      return () => {
        updateCallbacks.delete(callback)
      }
    },
    async prompt(params: BridgePromptParams) {
      options.requests?.push({ method: "session/prompt", params })
      if (options.promptError) {
        throw options.promptError
      }
      for (const update of options.updates) {
        if (isDelayedFakeRuntimeUpdate(update)) {
          await new Promise((resolve) => setTimeout(resolve, update.delayMs))
        }
        const rawUpdate = isDelayedFakeRuntimeUpdate(update) ? update.update : update
        for (const callback of updateCallbacks) {
          callback({
            sessionId: "session-1",
            update: normalizeFakeSessionUpdate(rawUpdate) as BridgeAcpRawUpdate["update"],
          })
        }
      }
      if (options.promptDelayMs !== undefined) {
        await new Promise((resolve) => setTimeout(resolve, options.promptDelayMs))
      }
      const raw = (options.promptResult ?? { stopReason: "end_turn" }) as PromptResponse
      return { raw, stopReason: raw.stopReason }
    },
    async resumeSession(params) {
      options.requests?.push({ method: "session/resume", params })
      return { raw: { sessionId: params.sessionId }, sessionId: params.sessionId }
    },
    async setConfigOption(params: BridgeSetConfigOptionParams) {
      options.requests?.push({ method: "session/set_config_option", params })
      options.configOptions = (options.configOptions ?? []).map((option) =>
        option.id === params.configId && "value" in params && typeof params.value === "string"
          ? { ...option, currentValue: params.value }
          : option,
      )
      return { configOptions: (options.configOptions ?? []) as SessionConfigOption[] }
    },
  }
}

function isDelayedFakeRuntimeUpdate(
  update: FakeRuntimeUpdate | DelayedFakeRuntimeUpdate,
): update is DelayedFakeRuntimeUpdate {
  return typeof (update as DelayedFakeRuntimeUpdate).delayMs === "number"
}

function createFakeAcpProcess(options: {
  emitExitOnKill?: boolean
  kills?: Array<NodeJS.Signals | undefined>
  pid?: number
  permissionResponses?: RequestPermissionResponse[]
  processes?: ChildProcessWithoutNullStreams[]
  requestPermissionOnPrompt?: boolean
  useTerminalOnPrompt?: boolean
}): () => ChildProcessWithoutNullStreams {
  return () => {
    const stdout = new PassThrough()
    const stderr = new PassThrough()
    const stdin = new PassThrough()
    let agentConnection: AgentSideConnection
    const agent: Agent = {
      authenticate: async () => undefined,
      cancel: async () => undefined,
      initialize: async (params) => ({
        agentCapabilities: { sessionCapabilities: {} },
        protocolVersion: params.protocolVersion,
      }),
      newSession: async () => ({ sessionId: "session-1" }),
      prompt: async (params) => {
        if (options.useTerminalOnPrompt) {
          const terminal = await agentConnection.createTerminal({
            command: "printf terminal",
            sessionId: params.sessionId,
          })
          await terminal.currentOutput()
          await terminal.waitForExit()
        }
        if (options.requestPermissionOnPrompt) {
          const response = await agentConnection.requestPermission({
            options: [
              { kind: "allow_once", name: "Allow once", optionId: "allow_once" },
              { kind: "reject_once", name: "Reject once", optionId: "reject_once" },
            ],
            sessionId: params.sessionId,
            toolCall: {
              kind: "edit",
              status: "pending",
              title: "Edit file",
              toolCallId: "tool-approval-1",
            },
          })
          options.permissionResponses?.push(response)
          return {
            stopReason:
              response.outcome.outcome === "selected" ? "end_turn" : "cancelled",
          }
        }
        return { stopReason: "end_turn" }
      },
    }
    agentConnection = new AgentSideConnection(
      () => agent,
      ndJsonStream(
        Writable.toWeb(stdout) as WritableStream<Uint8Array>,
        Readable.toWeb(stdin) as unknown as ReadableStream<Uint8Array>,
      ),
    )
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
      pid: options.pid,
      stdout,
    }) as unknown as ChildProcessWithoutNullStreams
    options.processes?.push(process)
    return process
  }
}

async function waitForMicrotasks(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve))
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve
    reject = promiseReject
  })
  return { promise, reject, resolve }
}

function normalizeFakeSessionUpdate(update: Record<string, unknown>): Record<string, unknown> {
  if (update.sessionUpdate === "tool_call") {
    const content = update.content as Record<string, unknown> | undefined
    return {
      kind: "execute",
      sessionUpdate: "tool_call",
      status: "in_progress",
      title: typeof content?.name === "string" ? content.name : "tool",
      toolCallId: "tool-1",
    }
  }
  if (update.sessionUpdate === "tool_call_update") {
    const content = update.content as Record<string, unknown> | undefined
    return {
      content:
        typeof content?.text === "string"
          ? [{ content: { text: content.text, type: "text" }, type: "content" }]
          : undefined,
      sessionUpdate: "tool_call_update",
      status: "completed",
      toolCallId: "tool-1",
    }
  }
  return update
}
