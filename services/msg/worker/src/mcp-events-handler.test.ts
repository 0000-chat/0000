import { describe, expect, test } from "bun:test";
import { handleMcpRequest, type McpAuthContext } from "./mcp-events-handler";
import type { RoomService } from "./protocol";

function request(method: string, params?: Record<string, unknown>, id = 1): Request {
  return new Request("https://msg.example.test/mcp", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) }) });
}

const auth: McpAuthContext = { grantId: "grant-1", principalId: "principal-1", scopes: ["read", "post", "monitor"], authorize: () => true };
const service: RoomService = {
  async create() { throw new Error("unused"); },
  async mcpSubscribe(input) { return { id: input.id ?? "sub-test", refreshBefore: new Date(10_000).toISOString(), cursor: input.cursor ?? "1", truncated: false }; },
  async mcpUnsubscribe() { return { removed: true }; },
};

describe("MCP 2 events", () => {
  test("advertises protocol 2026-07-28 and events capability", async () => {
    const response = await handleMcpRequest(request("server/discover"), service);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ result: { supportedVersions: ["2026-07-28"], capabilities: { events: {} } } });
  });

  test("returns an OAuth protected-resource challenge for an unauthenticated call", async () => {
    const response = await handleMcpRequest(request("tools/list"), service);
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toContain("resource_metadata=\"https://msg.example.test/.well-known/oauth-protected-resource\"");
  });

test("verifies callback and creates a Thread-scoped subscription", async () => {
    const secret = `whsec_${btoa(String.fromCharCode(...new Uint8Array(32)))}`;
    let callbackRequest: Request | undefined;
    let verificationCalls = 0;
    const response = await handleMcpRequest(request("events/subscribe", {
      name: "message.created",
      arguments: { room_url: "https://msg.example.test/thread-1" },
      delivery: { mode: "webhook", url: "https://receiver.example.test/callback", secret },
      cursor: null,
    }), { ...service, mcpSubscribe: async (input) => ({ id: input.id ?? "sub-test", refreshBefore: new Date(10_000).toISOString(), cursor: "1", truncated: false }) }, {
      origin: "https://msg.example.test",
      auth: { authenticate: async () => auth },
      callbackFetch: async (input, init) => {
        verificationCalls += 1;
        callbackRequest = new Request(input, init);
        const body = JSON.parse(String(init?.body)) as { challenge: string };
        return new Response(JSON.stringify({ challenge: body.challenge }), { status: 200, headers: { "content-type": "application/json" } });
      },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ result: { truncated: false, cursor: "1" } });
    expect(callbackRequest?.headers.get("X-MCP-Subscription-Id")).toMatch(/^sub_/u);
  expect(callbackRequest?.headers.get("webhook-signature")).toMatch(/^v1,/u);
    const refreshed = await handleMcpRequest(request("events/subscribe", {
      name: "message.created",
      arguments: { room_url: "https://msg.example.test/thread-1" },
      delivery: { mode: "webhook", url: "https://receiver.example.test/callback", secret },
      cursor: null,
    }), { ...service, mcpSubscribe: async (input) => ({ id: input.id ?? "sub-test", refreshBefore: new Date(10_000).toISOString(), cursor: "1", truncated: false }) }, {
      origin: "https://msg.example.test",
      auth: { authenticate: async () => auth },
      callbackFetch: async (input, init) => {
        verificationCalls += 1;
        const body = JSON.parse(String(init?.body)) as { challenge: string };
        return new Response(JSON.stringify({ challenge: body.challenge }), { status: 200, headers: { "content-type": "application/json" } });
      },
    });
    expect(refreshed.status).toBe(200);
    expect(verificationCalls).toBe(1);
});

test("stamps response origin with the authenticated principal", async () => {
  let posted: Record<string, unknown> | undefined;
  const response = await handleMcpRequest(request("tools/call", {
    name: "post_message",
    arguments: {
      room_url: "https://msg.example.test/thread-1",
      content: "reply",
      author: "model-selected-label",
      client_message_id: "client-1",
      response_context: { subscription_id: "sub-one", event_id: "event-one" },
    },
  }), {
    ...service,
    mcpValidateResponseContext: async (input) => input.principal_id === "principal-1" && input.subscription_id === "sub-one" && input.event_id === "event-one",
    mcpPostMessage: async (input) => { posted = input as unknown as Record<string, unknown>; return { accepted: true, protocol_version: 1, request_id: "client-1", sequence: 2, expires_at: "now", replayed: false }; },
  }, { origin: "https://msg.example.test", auth: { authenticate: async () => auth } });
  expect(response.status).toBe(200);
  expect((posted as { principal_id?: string }).principal_id).toBe("principal-1");
  expect((posted as { origin?: { subscription_id?: string; event_id?: string } }).origin).toEqual({ subscription_id: "sub-one", event_id: "event-one" });
});

test("requires and validates the event context for post_response", async () => {
  const base = { room_url: "https://msg.example.test/thread-1", content: "reply", author: "agent", client_message_id: "client-2" };
  const missing = await handleMcpRequest(request("tools/call", { name: "post_response", arguments: base }), service, { origin: "https://msg.example.test", auth: { authenticate: async () => auth } });
  expect((await missing.json() as { result: { isError?: boolean } }).result.isError).toBe(true);
  const foreign = await handleMcpRequest(request("tools/call", { name: "post_response", arguments: { ...base, response_context: { subscription_id: "other-thread", event_id: "event-one" } } }), {
    ...service,
    mcpValidateResponseContext: async () => false,
    mcpPostMessage: async () => { throw new Error("must not post"); },
  }, { origin: "https://msg.example.test", auth: { authenticate: async () => auth } });
  expect((await foreign.json() as { result: { isError?: boolean } }).result.isError).toBe(true);
});

test("requires the bearer token scope and selected Thread grant together", async () => {
  const room = "https://msg.example.test/thread-1";
  const readOnlyAuth: McpAuthContext = { grantId: "grant-1", principalId: "principal-1", scopes: ["threads:read"], authorize: () => true };
  const post = await handleMcpRequest(request("tools/call", { name: "post_message", arguments: { room_url: room, content: "blocked", author: "agent", client_message_id: "narrow-1" } }), {
    ...service,
    mcpPostMessage: async () => { throw new Error("must not post"); },
  }, { origin: "https://msg.example.test", auth: { authenticate: async () => readOnlyAuth } });
  expect((await post.json() as { result: { isError?: boolean } }).result.isError).toBe(true);

  const grantDeniedAuth: McpAuthContext = { grantId: "grant-1", principalId: "principal-1", scopes: ["threads:read", "threads:post", "threads:monitor"], authorize: () => false };
  const read = await handleMcpRequest(request("tools/call", { name: "read_thread", arguments: { room_url: room } }), {
    ...service,
    mcpReadThread: async () => { throw new Error("must not read"); },
  }, { origin: "https://msg.example.test", auth: { authenticate: async () => grantDeniedAuth } });
  expect((await read.json() as { result: { isError?: boolean } }).result.isError).toBe(true);

  const events = await handleMcpRequest(request("events/list"), service, { origin: "https://msg.example.test", auth: { authenticate: async () => readOnlyAuth } });
  expect((await events.json() as { error?: { code?: number } }).error?.code).toBe(-32001);
});
});
