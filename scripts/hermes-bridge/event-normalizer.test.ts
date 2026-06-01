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
