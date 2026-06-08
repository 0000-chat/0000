import assert from "node:assert/strict"
import { test } from "node:test"

import { normalizeAcpNotification } from "./event-normalizer"

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
