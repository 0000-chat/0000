import { expect, test } from "bun:test";

import { runCli } from "./cli.js";
import { parseWebhooksCommand } from "./webhooks.js";

const roomUrl = "https://msg.0000.chat/room-capability";
const endpointId = "a0000000-0000-4000-8000-000000000001";

test("parses the documented webhook management commands", () => {
  expect(parseWebhooksCommand(["webhooks", roomUrl, "list"])).toEqual({ conversationUrl: roomUrl, operation: "list" });
  expect(parseWebhooksCommand(["webhooks", roomUrl, "create", "https://receiver.example.com/hook"])).toEqual({
    conversationUrl: roomUrl,
    destinationUrl: "https://receiver.example.com/hook",
    operation: "create",
  });
  expect(parseWebhooksCommand(["webhooks", roomUrl, "remove", endpointId])).toEqual({ conversationUrl: roomUrl, endpointId, operation: "remove" });

  expect(() => parseWebhooksCommand(["webhooks", "https://example.com/room", "list"])).toThrow("conversation URL");
  expect(() => parseWebhooksCommand(["webhooks", roomUrl, "remove", "not-an-id"])).toThrow("Usage: msg webhooks");
});

test("sends list, create, and remove requests to the room's webhook API", async () => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const calls: Array<{ body?: string; method?: string; redirect?: string; url?: string }> = [];
  const responses = [
    { protocol_version: 1, webhooks: [] },
    { protocol_version: 1, secret: "one-time-secret", webhook: { id: endpointId, url: "https://receiver.example.com/hook?token=redacted" } },
    { protocol_version: 1, removed: true },
  ];
  let responseIndex = 0;
  const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      ...(init?.body === undefined ? {} : { body: String(init.body) }),
      method: init?.method,
      redirect: init?.redirect,
      url: String(input),
    });
    return Response.json(responses[responseIndex++]);
  };
  const dependencies = {
    fetch,
    stderr: (text: string) => stderr.push(text),
    stdout: (text: string) => stdout.push(text),
    websocket: () => { throw new Error("WebSocket must not connect."); },
  };

  expect(await runCli(["webhooks", roomUrl, "list"], dependencies)).toBe(0);
  expect(await runCli(["webhooks", roomUrl, "create", "https://receiver.example.com/hook?token=private"], dependencies)).toBe(0);
  expect(await runCli(["webhooks", roomUrl, "remove", endpointId], dependencies)).toBe(0);

  expect(calls).toEqual([
    { method: "GET", redirect: "error", url: `${roomUrl}/webhooks` },
    {
      body: JSON.stringify({ url: "https://receiver.example.com/hook?token=private" }),
      method: "POST",
      redirect: "error",
      url: `${roomUrl}/webhooks`,
    },
    { method: "DELETE", redirect: "error", url: `${roomUrl}/webhooks/${endpointId}` },
  ]);
  expect(JSON.parse(stdout[1] ?? "")).toMatchObject({ secret: "one-time-secret" });
  expect(stdout.join("")).not.toContain("token=private");
  expect(stderr).toEqual([]);
});

test("does not write a result when a webhook request fails", async () => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await runCli(["webhooks", roomUrl, "list"], {
    fetch: async () => Response.json({ error: { message: "The conversation has expired." } }, { status: 410 }),
    stderr: (text) => stderr.push(text),
    stdout: (text) => stdout.push(text),
    websocket: () => { throw new Error("WebSocket must not connect."); },
  });

  expect(code).toBe(1);
  expect(stdout).toEqual([]);
  expect(stderr).toEqual(["The conversation has expired.\n"]);
});
