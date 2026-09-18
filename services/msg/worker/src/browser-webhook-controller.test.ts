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
          deliveries: [{
            created_at: "2026-09-19T00:00:00.000Z",
            event_id: "b0000000-0000-4000-8000-000000000001",
            message_sequence: 2,
            attempts: [
              { attempt_number: 1, attempted_at: "2026-09-19T00:00:00.000Z", completed_at: "2026-09-19T00:00:01.000Z", failure_category: "http_status", status: "failed" },
              { attempt_number: 2, attempted_at: "2026-09-19T00:00:31.000Z", completed_at: null, failure_category: null, status: "sending" },
            ],
            attempt_count: 2,
            attempted_at: "2026-09-19T00:00:31.000Z",
            cancelled_at: null,
            completed_at: null,
            failure_category: null,
            next_attempt_at: null,
            retry_expires_at: "2026-09-20T00:00:00.000Z",
            status: "sending",
          }],
          disabled_at: null,
          failure_started_at: "2026-09-19T00:00:01.000Z",
          id: "a0000000-0000-4000-8000-000000000001",
          last_failure_at: "2026-09-19T00:00:01.000Z",
          last_success_at: null,
          recovered_at: null,
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
  expect(entries[1]?.[0]).toMatchObject({
    failure_started_at: "2026-09-19T00:00:01.000Z",
    id: "a0000000-0000-4000-8000-000000000001",
    last_failure_at: "2026-09-19T00:00:01.000Z",
    deliveries: [{ attempt_count: 2, attempts: [{ attempt_number: 1 }, { attempt_number: 2 }], status: "sending" }],
  });
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

test("disables, re-enables, rotates, and queues a targeted redelivery through the panel controller", async () => {
  const endpointId = "a0000000-0000-4000-8000-000000000001";
  const eventId = "b0000000-0000-4000-8000-000000000001";
  const entry: WebhookPanelEntry = {
    deliveries: [{
      attempts: [],
      attempt_count: 1,
      attempted_at: "2026-09-19T00:00:00.000Z",
      cancelled_at: null,
      completed_at: null,
      created_at: "2026-09-19T00:00:00.000Z",
      event_id: eventId,
      failure_category: "http_status",
      message_sequence: 2,
      next_attempt_at: null,
      retry_expires_at: "2026-09-20T00:00:00.000Z",
      status: "failed",
    }],
    disabled_at: null,
    failure_started_at: "2026-09-19T00:00:00.000Z",
    id: endpointId,
    last_failure_at: "2026-09-19T00:00:00.000Z",
    last_success_at: null,
    recovered_at: null,
    status: "active",
    url: "https://receiver.example.com/hook",
  };
  let current = entry;
  const entries: WebhookPanelEntry[][] = [];
  const busy: boolean[] = [];
  const secrets: Array<{ operation: string; secret: string }> = [];
  const calls: Array<{ method: string; url: string }> = [];
  const controller = createWebhookPanelController({
    endpoint: "https://msg.0000.chat/room-capability/webhooks",
    fetch: async (input, init) => {
      const url = String(input);
      const method = String(init?.method ?? "GET");
      calls.push({ method, url });
      if (method === "GET") return Response.json({ protocol_version: 1, webhooks: [current] });
      if (url.endsWith("/disable")) {
        current = { ...current, disabled_at: "2026-09-19T00:00:01.000Z", status: "disabled" };
        return Response.json({ protocol_version: 1, webhook: current });
      }
      if (url.endsWith("/enable")) {
        current = { ...current, disabled_at: null, failure_started_at: null, status: "active" };
        return Response.json({ protocol_version: 1, webhook: current });
      }
      if (url.endsWith("/rotate-secret")) return Response.json({ protocol_version: 1, secret: "rotated-once", webhook: current });
      if (url.endsWith("/redeliver")) {
        return Response.json({ protocol_version: 1, result: "queued", delivery: { ...entry.deliveries[0], status: "pending" } }, { status: 202 });
      }
      throw new Error(`Unexpected panel request ${method} ${url}`);
    },
    onBusyChange: (value) => busy.push(value),
    onEntries: (value) => entries.push([...value]),
    onSecret: (secret, operation) => secrets.push({ operation, secret }),
  });

  await controller.disable(endpointId);
  await controller.enable(endpointId);
  await controller.rotate(endpointId);
  const result = await controller.redeliver(endpointId, eventId);

  expect(result).toBe("queued");
  expect(current.status).toBe("active");
  expect(secrets).toEqual([{ operation: "rotated", secret: "rotated-once" }]);
  expect(entries.map((value) => value[0]?.status)).toEqual(["disabled", "active", "active", "active"]);
  expect(calls).toEqual([
    { method: "POST", url: `https://msg.0000.chat/room-capability/webhooks/${endpointId}/disable` },
    { method: "GET", url: "https://msg.0000.chat/room-capability/webhooks" },
    { method: "POST", url: `https://msg.0000.chat/room-capability/webhooks/${endpointId}/enable` },
    { method: "GET", url: "https://msg.0000.chat/room-capability/webhooks" },
    { method: "POST", url: `https://msg.0000.chat/room-capability/webhooks/${endpointId}/rotate-secret` },
    { method: "GET", url: "https://msg.0000.chat/room-capability/webhooks" },
    { method: "POST", url: `https://msg.0000.chat/room-capability/webhooks/${endpointId}/deliveries/${eventId}/redeliver` },
    { method: "GET", url: "https://msg.0000.chat/room-capability/webhooks" },
  ]);
  expect(busy).toEqual([true, false, true, false, true, false, true, false]);
});
