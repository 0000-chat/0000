import { expect, test } from "bun:test";

import { createWebhookPanelController, type WebhookPanelEntry } from "./browser-controller";

test("loads, creates, and removes endpoints through the room webhook API", async () => {
  const entries: WebhookPanelEntry[][] = [];
  const busyChanges: boolean[] = [];
  const secrets: string[] = [];
  const calls: Array<{ body?: string; method: string; url: string }> = [];
  let registered: WebhookPanelEntry | undefined;
  const controller = createWebhookPanelController({
    endpoint: "https://msg.0000.chat/room-capability/webhooks",
    fetch: async (input, init) => {
      const url = String(input);
      const method = String(init?.method ?? "GET");
      calls.push({ ...(init?.body === undefined ? {} : { body: String(init.body) }), method, url });
      if (method === "GET") return Response.json({ protocol_version: 1, webhooks: registered ? [registered] : [] });
      if (method === "POST") {
        registered = {
          deliveries: [],
          id: "a0000000-0000-4000-8000-000000000001",
          status: "active",
          url: "https://receiver.example.com/hook?token=redacted",
        };
        return Response.json({ protocol_version: 1, secret: "created-once", webhook: registered }, { status: 201 });
      }
      registered = undefined;
      return Response.json({ protocol_version: 1, removed: true });
    },
    onBusyChange: (busy) => busyChanges.push(busy),
    onEntries: (value) => entries.push([...value]),
    onSecret: (secret) => secrets.push(secret),
  });

  await controller.list();
  await controller.create("https://receiver.example.com/hook?token=private");
  await controller.remove("a0000000-0000-4000-8000-000000000001");

  expect(entries).toHaveLength(3);
  expect(entries[0]).toEqual([]);
  expect(entries[1]).toHaveLength(1);
  expect(entries[1]?.[0]).toMatchObject({ id: "a0000000-0000-4000-8000-000000000001" });
  expect(entries[2]).toEqual([]);
  expect(secrets).toEqual(["created-once"]);
  expect(calls.map(({ method, url }) => [method, url])).toEqual([
    ["GET", "https://msg.0000.chat/room-capability/webhooks"],
    ["POST", "https://msg.0000.chat/room-capability/webhooks"],
    ["GET", "https://msg.0000.chat/room-capability/webhooks"],
    ["DELETE", "https://msg.0000.chat/room-capability/webhooks/a0000000-0000-4000-8000-000000000001"],
    ["GET", "https://msg.0000.chat/room-capability/webhooks"],
  ]);
  expect(JSON.parse(calls[1]?.body ?? "")).toEqual({ url: "https://receiver.example.com/hook?token=private" });
  expect(busyChanges).toEqual([true, false, true, false, true, false]);
});
