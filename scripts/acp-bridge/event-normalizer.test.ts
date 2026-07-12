import assert from "node:assert/strict"
import { test } from "node:test"

import {
  classifyRuntimeLogLine,
  normalizeAcpNotification,
  normalizeBridgeError,
  normalizeRuntimeDiagnostic,
  shouldSuppressRuntimeDiagnostic,
} from "./event-normalizer"

test("normalizes ACP available command updates for UI consumption", () => {
  const event = normalizeAcpNotification(
    {
      method: "session/update",
      params: {
        sessionId: "session-1",
        update: {
          sessionUpdate: "available_commands_update",
          availableCommands: [
            {
              description: "Show runtime status",
              input: { hint: "optional filter" },
              name: "status",
            },
            { description: "Set the current goal", name: "/goal" },
          ],
        },
      },
    },
    12,
  )

  assert.equal(event.eventType, "available_commands_update")
  assert.deepEqual(event.part?.json, {
    availableCommands: [
      { description: "Show runtime status", inputHint: "optional filter", name: "status" },
      { description: "Set the current goal", name: "goal" },
    ],
  })
})

test("normalizes ACP agent image chunks as uploadable attachments", () => {
  const event = normalizeAcpNotification(
    {
      method: "session/update",
      params: {
        sessionId: "session-1",
        update: {
          content: {
            data: "iVBORw0KGgo=",
            mimeType: "image/png",
            type: "image",
            uri: "file:///workspace/reply.png",
          },
          sessionUpdate: "agent_message_chunk",
        },
      },
    },
    13,
  )

  assert.equal(event.eventType, "agent_message_chunk")
  assert.deepEqual(event.attachmentUpload, {
    dataBase64: "iVBORw0KGgo=",
    filename: "reply.png",
    kind: "base64",
    mediaType: "image/png",
  })
  assert.equal(event.part?.type, "event")
  assert.equal(event.part?.status, "streaming")
})

test("classifies routine Hermes lifecycle logs as suppressible info diagnostics", () => {
  for (const line of [
    "acp_adapter.server: ACP client connected",
    "Initialize from unknown (protocol v1)",
    "run_agent: Loaded environment variables from profile",
    "OpenAI client created for request",
    "agent.auxiliary_client: Vision auto-detect enabled",
    "tools.terminal_tool: local environment ready",
    "OpenAI client closed request_complete",
  ]) {
    const diagnostic = classifyRuntimeLogLine(line)
    assert.equal(diagnostic?.severity, "info")
    assert.equal(shouldSuppressRuntimeDiagnostic(diagnostic), true)
  }
})

test("classifies successful delegation completion diagnostics as suppressible info", () => {
  for (const line of [
    "async delegation completed successfully",
    "delegation batch finished successfully",
  ]) {
    const diagnostic = classifyRuntimeLogLine(line)
    assert.equal(diagnostic?.severity, "info")
    assert.equal(shouldSuppressRuntimeDiagnostic(diagnostic), true)
  }
})

test("does not suppress unsuccessful delegation completion diagnostics", () => {
  for (const line of [
    "async delegation completed unsuccessfully",
    "async delegation completed with failure",
    "delegation batch finished with error",
  ]) {
    const diagnostic = classifyRuntimeLogLine(line)
    assert.equal(shouldSuppressRuntimeDiagnostic(diagnostic), false)
    assert.notEqual(diagnostic?.severity, "info")
  }
})

test("classifies routine CLI status logs as suppressible info diagnostics", () => {
  for (const line of [
    "The user's messages are sent from the 0000 Chat app. When the",
    "📦 Preflight compression: ~141,110 tokens >= 136,000 threshold. This may take a moment.",
    "🗜️ Compacting context — summarizing earlier conversation so I can continue...",
    "2026-06-12 17:31:19 [INFO] agent.auxiliary_client: Auxiliary compression: connection error on auto, trying fallback",
  ]) {
    const diagnostic = classifyRuntimeLogLine(line)
    assert.equal(diagnostic?.severity, "info")
    assert.equal(shouldSuppressRuntimeDiagnostic(diagnostic), true)
  }
})

test("classifies WARN runtime logs as runtime_diagnostic events", () => {
  const diagnostic = classifyRuntimeLogLine(
    "2026-06-10 20:46:59 [WARNING] agent.tool_executor: Tool memory returned error",
  )

  assert.deepEqual(diagnostic, {
    severity: "warn",
    text: "2026-06-10 20:46:59 [WARNING] agent.tool_executor: Tool memory returned error",
  })
  assert.equal(shouldSuppressRuntimeDiagnostic(diagnostic), false)

  const event = normalizeRuntimeDiagnostic(diagnostic!, 4, "session-1")

  assert.equal(event.eventType, "runtime_diagnostic")
  assert.equal(event.part?.type, "event")
  assert.deepEqual(event.payload, {
    message: "2026-06-10 20:46:59 [WARNING] agent.tool_executor: Tool memory returned error",
    severity: "warn",
  })
})

test("keeps ERROR and PANIC runtime logs as bridge errors", () => {
  for (const line of [
    "ERROR acp_adapter.server: runtime crashed",
    "FATAL worker failed to initialize",
    "panic: unexpected nil session",
  ]) {
    const diagnostic = classifyRuntimeLogLine(line)
    assert.equal(diagnostic?.severity, "error")
    assert.equal(shouldSuppressRuntimeDiagnostic(diagnostic), false)

    const event = normalizeBridgeError(new Error(diagnostic!.text), 5, "session-1")
    assert.equal(event.eventType, "bridge_error")
    assert.equal(event.part?.type, "error")
  }
})

test("redacts sensitive runtime log values before classification", () => {
  const diagnostic = classifyRuntimeLogLine("ERROR token=sk-secret Bearer abc123")

  assert.equal(diagnostic?.severity, "error")
  assert.equal(diagnostic?.text.includes("sk-secret"), false)
  assert.equal(diagnostic?.text.includes("abc123"), false)
})

test("ignores malformed ACP command entries without dropping the update", () => {
  const event = normalizeAcpNotification(
    {
      method: "session/update",
      params: {
        sessionId: "session-1",
        update: {
          sessionUpdate: "available_commands_update",
          availableCommands: [
            { description: "missing a name" },
            { description: "Plan the work", input: { hint: 123 }, name: "plan" },
          ],
        },
      },
    },
    13,
  )

  assert.equal(event.eventType, "available_commands_update")
  assert.deepEqual(event.part?.json, {
    availableCommands: [{ description: "Plan the work", name: "plan" }],
  })
})

test("normalizes SDK plan updates as structured events", () => {
  const event = normalizeAcpNotification(
    {
      method: "session/update",
      params: {
        sessionId: "session-1",
        update: {
          sessionUpdate: {
            plan: {
              entries: [
                {
                  _meta: {
                    fileRefs: [
                      {
                        line: 42,
                        path: "scripts/acp-bridge/event-normalizer.ts",
                      },
                    ],
                  },
                  content: "Preserve plan update shape",
                  priority: "high",
                  status: "in_progress",
                },
                {
                  content: "Verify plan events are not assistant prose",
                  priority: "medium",
                  status: "pending",
                },
              ],
              id: "plan-1",
              type: "items",
            },
            type: "planUpdate",
          },
        },
      },
    },
    19,
  )

  assert.equal(event.eventType, "plan_update")
  assert.equal(event.part?.type, "event")
  assert.equal(event.part?.text, undefined)
  const normalizedPlanUpdate = {
    associatedFiles: [
      {
        line: 42,
        path: "scripts/acp-bridge/event-normalizer.ts",
      },
    ],
    category: "plan",
    items: [
      {
        _meta: {
          fileRefs: [
            {
              line: 42,
              path: "scripts/acp-bridge/event-normalizer.ts",
            },
          ],
        },
        content: "Preserve plan update shape",
        priority: "high",
        status: "in_progress",
      },
      {
        content: "Verify plan events are not assistant prose",
        priority: "medium",
        status: "pending",
      },
    ],
    plan: {
      entries: [
        {
          _meta: {
            fileRefs: [
              {
                line: 42,
                path: "scripts/acp-bridge/event-normalizer.ts",
              },
            ],
          },
          content: "Preserve plan update shape",
          priority: "high",
          status: "in_progress",
        },
        {
          content: "Verify plan events are not assistant prose",
          priority: "medium",
          status: "pending",
        },
      ],
      id: "plan-1",
      type: "items",
    },
    planId: "plan-1",
    type: "planUpdate",
  }
  assert.deepEqual(event.payload, normalizedPlanUpdate)
  assert.deepEqual(event.part?.json, normalizedPlanUpdate)
})

test("normalizes SDK plan removals with stable adapter aliases", () => {
  const event = normalizeAcpNotification(
    {
      method: "session/update",
      params: {
        sessionId: "session-1",
        update: {
          sessionUpdate: {
            plan: {
              id: "plan-removed",
              status: "cancelled",
            },
            type: "planRemoved",
          },
        },
      },
    },
    20,
  )

  assert.equal(event.eventType, "plan_removed")
  assert.equal(event.part?.type, "event")
  assert.equal(event.part?.text, undefined)
  assert.deepEqual(event.payload, {
    associatedFiles: [],
    category: "plan",
    items: [],
    plan: {
      id: "plan-removed",
      status: "cancelled",
    },
    planId: "plan-removed",
    type: "planRemoved",
  })
  assert.deepEqual(event.part?.json, event.payload)
})

test("normalizes ACP agent message chunks as text", () => {
  const event = normalizeAcpNotification(
    {
      method: "session/update",
      params: {
        sessionId: "session-1",
        update: {
          content: { text: "answer chunk", type: "text" },
          sessionUpdate: "agent_message_chunk",
        },
      },
    },
    14,
  )

  assert.equal(event.eventType, "agent_message_chunk")
  assert.deepEqual(event.part, {
    status: "streaming",
    text: "answer chunk",
    type: "text",
  })
})

test("normalizes typed ACP agent message chunks as text", () => {
  const event = normalizeAcpNotification(
    {
      method: "session/update",
      params: {
        sessionId: "session-1",
        update: {
          sessionUpdate: {
            content: { text: "answer chunk", type: "text" },
            type: "agentMessageChunk",
          },
        },
      },
    },
    17,
  )

  assert.equal(event.eventType, "agent_message_chunk")
  assert.deepEqual(event.part, {
    status: "streaming",
    text: "answer chunk",
    type: "text",
  })
})

test("normalizes addressable ACP file resources as attachment parts", () => {
  const event = normalizeAcpNotification(
    {
      method: "session/update",
      params: {
        sessionId: "session-1",
        update: {
          file: {
            checksumSha256: "d".repeat(64),
            filename: "agent-output.txt",
            mediaType: "text/plain",
            sizeBytes: 17,
            storageBackend: "r2",
            url: "https://0000.chat/api/attachments/attachments/agent/agent-output.txt",
          },
          sessionUpdate: "file",
        },
      },
    },
    15,
  )

  assert.equal(event.eventType, "file")
  assert.deepEqual(event.part, {
    json: {
      checksumSha256: "d".repeat(64),
      filename: "agent-output.txt",
      mediaType: "text/plain",
      sizeBytes: 17,
      status: "available",
      storageBackend: "r2",
      type: "file",
      url: "https://0000.chat/api/attachments/attachments/agent/agent-output.txt",
    },
    status: "complete",
    type: "attachment",
  })
})

test("normalizes local ACP file resources as deferred upload candidates", () => {
  const event = normalizeAcpNotification(
    {
      method: "session/update",
      params: {
        sessionId: "session-1",
        update: {
          file: {
            filename: "agent-output.txt",
            mediaType: "text/plain",
            path: "./agent-output.txt",
            sizeBytes: 17,
          },
          sessionUpdate: "file",
        },
      },
    },
    16,
  )

  assert.equal(event.eventType, "file")
  assert.deepEqual(event.attachmentUpload, {
    filename: "agent-output.txt",
    kind: "local_file",
    mediaType: "text/plain",
    path: "./agent-output.txt",
    sizeBytes: 17,
  })
  assert.deepEqual(event.payload, {
    candidateKind: "local_file",
    eventKind: "file",
    filename: "agent-output.txt",
    mediaType: "text/plain",
    sizeBytes: 17,
    status: "pending_upload",
    type: "agent_attachment_upload",
  })
  assert.deepEqual(event.part?.json, event.payload)
  assert.equal(JSON.stringify(event.payload).includes("./agent-output.txt"), false)
})

test("normalizes byte ACP file resources as deferred upload candidates", () => {
  const event = normalizeAcpNotification(
    {
      method: "session/update",
      params: {
        sessionId: "session-1",
        update: {
          file: {
            contentBase64: "YWdlbnQgb3V0cHV0",
            filename: "agent-output.txt",
            mediaType: "text/plain",
            sizeBytes: 12,
          },
          sessionUpdate: "file",
        },
      },
    },
    17,
  )

  assert.equal(event.attachmentUpload?.kind, "base64")
  assert.equal(JSON.stringify(event.payload).includes("YWdlbnQgb3V0cHV0"), false)
})

test("normalizes ACP thought chunks as hidden thinking by default", () => {
  const event = normalizeAcpNotification(
    {
      method: "session/update",
      params: {
        sessionId: "session-1",
        update: {
          content: { text: "private reasoning", type: "text" },
          sessionUpdate: "agent_thought_chunk",
        },
      },
    },
    15,
  )

  assert.equal(event.eventType, "agent_thought_chunk")
  assert.deepEqual(event.part, {
    reasoningVisibility: "hidden",
    status: "streaming",
    text: "private reasoning",
    type: "thinking",
  })
})

test("normalizes ACP tool updates with official title and status fields", () => {
  const event = normalizeAcpNotification(
    {
      method: "session/update",
      params: {
        sessionId: "session-1",
        update: {
          content: [{ content: { text: "done", type: "text" }, type: "content" }],
          sessionUpdate: "tool_call_update",
          status: "completed",
          title: "Run typecheck",
          toolCallId: "call-1",
        },
      },
    },
    18,
  )

  assert.equal(event.eventType, "tool_call_update")
  assert.equal(event.part?.type, "tool_result")
  assert.deepEqual(event.part?.json, {
    contentLength: 1,
    omitted: "tool result payload omitted by bridge",
    state: "output-available",
    status: "completed",
    toolCallId: "call-1",
    toolName: "Run typecheck",
    type: "tool_call_update",
  })
})

test("normalizes legacy nested ACP tool update fields", () => {
  const event = normalizeAcpNotification(
    {
      method: "session/update",
      params: {
        sessionId: "session-1",
        update: {
          content: {
            name: "shell",
            status: "completed",
            toolCallId: "tool-1",
            type: "tool_call_update",
          },
          sessionUpdate: "tool_call_update",
        },
      },
    },
    19,
  )

  assert.equal(event.eventType, "tool_call_update")
  assert.equal(event.part?.type, "tool_result")
  assert.deepEqual(event.part?.json, {
    contentLength: 4,
    omitted: "tool result payload omitted by bridge",
    state: "output-available",
    status: "completed",
    toolCallId: "tool-1",
    toolName: "shell",
    type: "tool_call_update",
  })
})

test("normalizes typed ACP thought chunks as hidden thinking", () => {
  const event = normalizeAcpNotification(
    {
      method: "session/update",
      params: {
        sessionId: "session-1",
        update: {
          sessionUpdate: {
            content: { text: "private reasoning", type: "text" },
            type: "agentThoughtChunk",
          },
        },
      },
    },
    18,
  )

  assert.equal(event.eventType, "agent_thought_chunk")
  assert.deepEqual(event.part, {
    reasoningVisibility: "hidden",
    status: "streaming",
    text: "private reasoning",
    type: "thinking",
  })
})

test("normalizes single-key ACP thought chunks as hidden thinking", () => {
  const event = normalizeAcpNotification(
    {
      method: "session/update",
      params: {
        sessionId: "session-1",
        update: {
          sessionUpdate: {
            agentThoughtChunk: {
              content: { text: "single-key reasoning", type: "text" },
            },
          },
        },
      },
    },
    19,
  )

  assert.equal(event.eventType, "agent_thought_chunk")
  assert.deepEqual(event.part, {
    reasoningVisibility: "hidden",
    status: "streaming",
    text: "single-key reasoning",
    type: "thinking",
  })
})

test("preserves Codex session info updates as metadata-only events", () => {
  const event = normalizeAcpNotification(
    {
      method: "session/update",
      params: {
        sessionId: "session-1",
        update: {
          _meta: {
            codex: {
              threadStatus: {
                activeFlags: ["background"],
                type: "active",
              },
            },
          },
          sessionUpdate: "session_info_update",
        },
      },
    },
    20,
  )

  assert.equal(event.eventType, "session_info_update")
  assert.equal(event.source, "acp_bridge")
  assert.deepEqual(event.part, {
    json: {
      _meta: {
        codex: {
          threadStatus: {
            activeFlags: ["background"],
            type: "active",
          },
        },
      },
      sessionUpdate: "session_info_update",
    },
    status: "streaming",
    type: "event",
  })
  assert.equal(JSON.stringify(event.part).includes("assistant answer"), false)
})

test("preserves user-visible ACP thought summaries", () => {
  const event = normalizeAcpNotification(
    {
      method: "session/update",
      params: {
        sessionId: "session-1",
        update: {
          content: { text: "safe summary", type: "text" },
          reasoningVisibility: "user_visible_summary",
          sessionUpdate: "agent_thought_chunk",
        },
      },
    },
    16,
  )

  assert.equal(event.eventType, "agent_thought_chunk")
  assert.deepEqual(event.part, {
    reasoningVisibility: "user_visible_summary",
    status: "streaming",
    text: "safe summary",
    type: "thinking",
  })
})
