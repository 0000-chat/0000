import type { ChildProcessWithoutNullStreams } from "node:child_process"
import { EventEmitter } from "node:events"
import { PassThrough, Writable } from "node:stream"
import { describe, expect, test } from "bun:test"

import {
  HermesAcpRuntimeAdapter,
  HermesAcpSession,
  type JsonRpcMessage,
  resolveRuntimeConfigApplication,
} from "./acp-session"

describe("ACP final text extraction", () => {
  test("withholds Codex ACP text when the turn has no classified thought events", async () => {
    const session = new HermesAcpSession({
      agentCommand: "npx --yes @zed-industries/codex-acp@0.15.0",
      spawnProcess: createFakeAcpProcess({
        updates: [
          { content: { text: "private reasoning", type: "text" }, sessionUpdate: "agent_message_chunk" },
          { content: { text: "\nfinal answer", type: "text" }, sessionUpdate: "agent_message_chunk" },
        ],
      }),
    })

    const result = await session.sendUserMessage("hello")

    expect(result.text).toBe("")
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
})

function createFakeAcpProcess(options: {
  configOptions?: Array<{ currentValue: string; id: string }>
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
    return Object.assign(new EventEmitter(), {
      kill: () => true,
      stderr,
      stdin,
      stdout,
    }) as unknown as ChildProcessWithoutNullStreams
  }
}

function handleRequest(
  message: JsonRpcMessage,
  stdout: PassThrough,
  options: {
    configOptions?: Array<{ currentValue: string; id: string }>
    promptResult?: unknown
    updates: Array<Record<string, unknown>>
  },
) {
  if (message.method === "initialize") {
    writeJson(stdout, {
      id: message.id,
      jsonrpc: "2.0",
      result: { agentCapabilities: { sessionCapabilities: {} } },
    })
    return
  }

  if (message.method === "session/new") {
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
