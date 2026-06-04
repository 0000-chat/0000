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
})

function createFakeAcpProcess(options: {
  promptResult?: unknown
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
            handleRequest(JSON.parse(line) as JsonRpcMessage, stdout, options)
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
  options: { promptResult?: unknown; updates: Array<Record<string, unknown>> },
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
    writeJson(stdout, { id: message.id, jsonrpc: "2.0", result: { sessionId: "session-1" } })
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
