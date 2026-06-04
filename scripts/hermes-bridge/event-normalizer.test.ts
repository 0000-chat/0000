import assert from "node:assert/strict"
import { test } from "node:test"

import { normalizeAcpNotification } from "./event-normalizer"

test("normalizes ACP available command updates for UI consumption", () => {
  const event = normalizeAcpNotification(
    {
      jsonrpc: "2.0",
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
      jsonrpc: "2.0",
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

test("normalizes ACP agent message chunks as text", () => {
  const event = normalizeAcpNotification(
    {
      jsonrpc: "2.0",
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

test("normalizes ACP thought chunks as hidden thinking by default", () => {
  const event = normalizeAcpNotification(
    {
      jsonrpc: "2.0",
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

test("preserves user-visible ACP thought summaries", () => {
  const event = normalizeAcpNotification(
    {
      jsonrpc: "2.0",
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
