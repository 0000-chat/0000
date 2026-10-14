import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "bun:test";
import { convertV4MiniflareOptions, Miniflare } from "../../../platform/node_modules/miniflare";

import { createMcpWebhookDispatcherClient } from "./mcp-webhook-dispatcher-client";
import { acquireMiniflareTestLock } from "../test-fixtures/miniflare-test-lock";
import { buildWorkerBundleInChild } from "../test-fixtures/msg-worker.miniflare-fixture";

test("relays signed callback bytes only to the configured dispatcher", async () => {
  let endpoint = "";
  let authorization = "";
  let userAgent = "";
  let relay: Record<string, unknown> | undefined;
  const callback = createMcpWebhookDispatcherClient({
    endpoint: "https://dispatcher.example.test/dispatch",
    token: "relay-secret",
    fetch: async (input, init) => {
      endpoint = String(input);
      const requestHeaders = new Headers(init?.headers);
      authorization = requestHeaders.get("authorization") ?? "";
      userAgent = requestHeaders.get("user-agent") ?? "";
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
  expect(userAgent).toBe("0000-msg-dispatcher-client/1");
  expect(relay).toMatchObject({ url: "https://attacker-controlled.example.test/events", method: "POST" });
  const relayHeaders = relay === undefined ? undefined : relay.headers;
  expect(relayHeaders && typeof relayHeaders === "object" ? (relayHeaders as Record<string, string>)["webhook-signature"] : undefined).toBe("v1,signature");
  expect(relay === undefined ? undefined : relay.body).toBe("{\"event_id\":\"event-1\"}");
  expect(response.status).toBe(204);
});

test("rejects dispatcher redirects without following or retrying them", async () => {
  let calls = 0;
  let redirect: RequestRedirect | undefined;
  const callback = createMcpWebhookDispatcherClient({
    endpoint: "https://dispatcher.example.test/dispatch",
    token: "relay-secret",
    fetch: async (_input, init) => {
      calls += 1;
      redirect = init?.redirect;
      return new Response(null, {
        status: 302,
        headers: { location: "https://other.example.test/dispatch" },
      });
    },
  });

  await expect(
    callback("https://attacker-controlled.example.test/events", {
      method: "POST",
      body: "{\"event_id\":\"event-redirect\"}",
    }),
  ).rejects.toThrow("dispatcher request failed");
  expect(redirect).toBe("manual");
  expect(calls).toBe(1);
});

test("rejects invalid dispatcher configuration before a callback can be sent", () => {
  expect(() => createMcpWebhookDispatcherClient({ endpoint: "http://dispatcher.example.test", token: "secret" })).toThrow();
  expect(() => createMcpWebhookDispatcherClient({ endpoint: "https://dispatcher.example.test", token: "" })).toThrow();
});

test.serial("normalizes callback redirect mode in the Workers runtime", { timeout: 30_000 }, async () => {
  const releaseRuntime = await acquireMiniflareTestLock();
  const persistence = await mkdtemp(join(tmpdir(), "msg-mcp-dispatcher-runtime-"));
  let runtime: Miniflare | undefined;
  try {
    const script = await buildWorkerBundleInChild(new URL("../test-fixtures/mcp-webhook-dispatcher-runtime.ts", import.meta.url).pathname);
    let relayBody = "";
    let relayAuthorization = "";
    runtime = new Miniflare(convertV4MiniflareOptions({
      bindings: {
        MSG_MCP_WEBHOOK_DISPATCH_TOKEN: "runtime-relay-secret",
        MSG_MCP_WEBHOOK_DISPATCH_URL: "https://dispatcher.example.test/dispatch",
      },
      compatibilityDate: "2026-08-09",
      host: "127.0.0.1",
      modules: true,
      name: "msg-mcp-dispatcher-runtime",
      outboundService: async (request) => {
        relayAuthorization = request.headers.get("authorization") ?? "";
        relayBody = await request.text();
        return new Response(JSON.stringify({ body: "", headers: {}, status: 204 }), {
          headers: { "content-type": "application/json" },
          status: 200,
        });
      },
      port: 0,
      resourcePersistencePath: persistence,
      script,
    }));
    await runtime.ready;
    const response = await runtime.dispatchFetch("https://msg.0000.chat/callback", {
      body: "{\"event\":\"runtime\"}",
      headers: { "content-type": "application/json", "webhook-signature": "v1,runtime" },
      method: "POST",
      redirect: "error",
    });
    expect(response.status).toBe(204);
    expect(await response.text()).toBe("");
    expect(relayAuthorization).toBe("Bearer runtime-relay-secret");
    expect(relayBody).toContain("v1,runtime");
    expect(JSON.parse(relayBody)).toMatchObject({ body: "{\"event\":\"runtime\"}" });
  } finally {
    await runtime?.dispose();
    await rm(persistence, { force: true, recursive: true });
    await releaseRuntime();
  }
});
