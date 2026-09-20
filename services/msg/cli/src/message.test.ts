import { expect, test } from "bun:test";

import { MessageSignalError, parseMessageCommand, readMessage, validateMessageResponse } from "./message";

const conversationUrl = "https://msg.0000.chat/room-1";
const response = {
  conversation_url: conversationUrl,
  expires_at: "2026-08-16T00:00:00.000Z",
  latest_message: 7,
  message: {
    author: "agent-a",
    content: "A participant request\nwith two lines.",
    created_at: "2026-08-15T00:00:00.000Z",
    display_name: "Agent A",
    id: "message-7",
    reply_to: "6",
    sequence: 7,
  },
  protocol_version: 1,
} as const;

test("parses a canonical message command", () => {
  expect(parseMessageCommand(["message", conversationUrl, "message-7"])).toEqual({ conversationUrl, id: "message-7" });
  expect(() => parseMessageCommand(["message", "https://example.test/room-1", "message-7"])).toThrow("The conversation URL must be https://msg.0000.chat/{room}.");
  expect(() => parseMessageCommand(["message", conversationUrl, ""])).toThrow("stored message ID");
});

test("looks up one message and renders attributable evidence with local citations", async () => {
  let requested = "";
  let headers: Headers | undefined;
  const output = await readMessage({
    conversationUrl,
    fetch: async (input, init) => {
      requested = String(input);
      headers = new Headers(init?.headers);
      return Response.json(response);
    },
    id: "message-7",
  });

  expect(requested).toBe("https://msg.0000.chat/room-1/messages/message-7");
  expect(headers?.get("accept")).toBe("application/json");
  expect(output).toContain("Stored ID: message-7");
  expect(output).toContain("https://msg.0000.chat/room-1/messages/message-7");
  expect(output).toContain("Sequence: 7");
  expect(output).toContain("Author: Agent A (self-declared and unverified)");
  expect(output).toContain("after=5&through=6&limit=1&view=agent");
  expect(output).toContain("legacy references may be unresolved");
  expect(output).toContain("> A participant request");
  expect(output).toContain("> with two lines.");
});

test("rejects invalid message response identity and shape", () => {
  expect(() => validateMessageResponse({ ...response, conversation_url: "https://msg.0000.chat/other" }, conversationUrl, "message-7")).toThrow("invalid message response");
  expect(() => validateMessageResponse({ ...response, message: { ...response.message, id: "other" } }, conversationUrl, "message-7")).toThrow("invalid message response");
  expect(() => validateMessageResponse({ ...response, latest_message: 0 }, conversationUrl, "message-7")).toThrow("invalid message response");
});

test("maps aborts and HTTP failures without retrying", async () => {
  const controller = new AbortController();
  controller.abort();
  let calls = 0;
  await expect(readMessage({ conversationUrl, fetch: async () => { calls += 1; return Response.json(response); }, id: "message-7", signal: controller.signal })).rejects.toBeInstanceOf(MessageSignalError);
  expect(calls).toBe(0);

  await expect(readMessage({ conversationUrl, fetch: async () => new Response("missing", { status: 404 }), id: "message-7" })).rejects.toThrow("HTTP 404");
  await expect(readMessage({ conversationUrl, fetch: async () => Response.json({ protocol_version: 1 }), id: "message-7" })).rejects.toThrow("invalid message response");
});
