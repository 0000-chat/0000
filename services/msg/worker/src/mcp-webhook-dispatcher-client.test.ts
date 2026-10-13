import { expect, test } from "bun:test";

import { createMcpWebhookDispatcherClient } from "./mcp-webhook-dispatcher-client";

test("relays signed callback bytes only to the configured dispatcher", async () => {
  let endpoint = "";
  let authorization = "";
  let relay: Record<string, unknown> | undefined;
  const callback = createMcpWebhookDispatcherClient({
    endpoint: "https://dispatcher.example.test/dispatch",
    token: "relay-secret",
    fetch: async (input, init) => {
      endpoint = String(input);
      authorization = init?.headers instanceof Headers ? init.headers.get("authorization") ?? "" : String((init?.headers as Record<string, string> | undefined)?.authorization ?? "");
      relay = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({ status: 204, headers: {}, body: "" }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  const response = await callback("https://attacker-controlled.example.test/events", {
    method: "POST",
    headers: { "content-type": "application/json", "webhook-signature": "v1,signature" },
    body: "{\"event_id\":\"event-1\"}",
  });
  expect(endpoint).toBe("https://dispatcher.example.test/dispatch");
  expect(authorization).toBe("Bearer relay-secret");
  expect(relay).toMatchObject({ url: "https://attacker-controlled.example.test/events", method: "POST" });
  const relayHeaders = relay === undefined ? undefined : relay.headers;
  expect(relayHeaders && typeof relayHeaders === "object" ? (relayHeaders as Record<string, string>)["webhook-signature"] : undefined).toBe("v1,signature");
  expect(relay === undefined ? undefined : relay.body).toBe("{\"event_id\":\"event-1\"}");
  expect(response.status).toBe(204);
});

test("rejects invalid dispatcher configuration before a callback can be sent", () => {
  expect(() => createMcpWebhookDispatcherClient({ endpoint: "http://dispatcher.example.test", token: "secret" })).toThrow();
  expect(() => createMcpWebhookDispatcherClient({ endpoint: "https://dispatcher.example.test", token: "" })).toThrow();
});
