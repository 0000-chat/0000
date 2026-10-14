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

test("accepts configured legacy room origins for durable tools and subscription migration", async () => {
  const canonicalOrigin = "https://msg.example.test";
  const legacyOrigin = "https://legacy.msg.example.test";
  const rooms: string[] = [];
  const subscriptions: Array<Parameters<NonNullable<RoomService["mcpSubscribe"]>>[0]> = [];
  let unsubscribed: Parameters<NonNullable<RoomService["mcpUnsubscribe"]>>[0] | undefined;
  const callbackFetch: typeof fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as { challenge: string };
    return new Response(JSON.stringify({ challenge: body.challenge }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const durableService: RoomService = {
    ...service,
    mcpReadThread: async ({ room }) => { rooms.push(`read:${room}`); return {} as never; },
    mcpReadMessage: async ({ room }) => { rooms.push(`message:${room}`); return {} as never; },
    mcpPostMessage: async ({ room }) => { rooms.push(`post:${room}`); return { accepted: true, protocol_version: 1, request_id: "legacy-post", sequence: 2, expires_at: "now", replayed: false }; },
    mcpSubscribe: async (input) => { subscriptions.push(input); return { id: input.id ?? "sub-test", refreshBefore: new Date(10_000).toISOString(), cursor: input.cursor ?? "1", truncated: false }; },
    mcpUnsubscribe: async (input) => { unsubscribed = input; return { removed: true }; },
  };
  const options = {
    origin: canonicalOrigin,
    acceptedOrigins: [legacyOrigin],
    auth: { authenticate: async () => auth },
    callbackFetch,
  };
  const legacyRoom = `${legacyOrigin}/thread-1`;
  const canonicalRoom = `${canonicalOrigin}/thread-1`;

  for (const [name, args] of [
    ["read_thread", { room_url: legacyRoom }] as const,
    ["read_message", { room_url: legacyRoom, message_id: "message-1" }] as const,
    ["post_message", { room_url: legacyRoom, content: "legacy post", author: "agent", client_message_id: "legacy-1" }] as const,
  ]) {
    const response = await handleMcpRequest(request("tools/call", { name, arguments: args }), durableService, options);
    expect(response.status).toBe(200);
  }
  expect(rooms).toEqual(["read:thread-1", "message:thread-1", "post:thread-1"]);

  const subscriptionParams = (room_url: string) => ({
    name: "message.created",
    arguments: { room_url },
    delivery: { mode: "webhook", url: "https://receiver.example.test/migrate", secret: `whsec_${btoa("m".repeat(32))}` },
    cursor: null,
  });
  const legacySubscribe = await handleMcpRequest(request("events/subscribe", subscriptionParams(legacyRoom)), durableService, options);
  const canonicalSubscribe = await handleMcpRequest(request("events/subscribe", subscriptionParams(canonicalRoom)), durableService, options);
  expect(legacySubscribe.status).toBe(200);
  expect(canonicalSubscribe.status).toBe(200);
  expect(subscriptions).toHaveLength(2);
  expect(subscriptions[0]?.id).toBe(subscriptions[1]?.id);
  expect(JSON.parse(subscriptions[0]!.arguments_json)).toEqual({ room_url: canonicalRoom });
  expect(subscriptions[0]!.legacy_arguments_json).toEqual([JSON.stringify({ room_url: legacyRoom })]);

  const unsubscribedResponse = await handleMcpRequest(request("events/unsubscribe", subscriptionParams(canonicalRoom)), durableService, options);
  expect(unsubscribedResponse.status).toBe(200);
  expect(unsubscribed?.arguments_json).toBe(JSON.stringify({ room_url: canonicalRoom }));
  expect(unsubscribed?.legacy_arguments_json).toEqual([JSON.stringify({ room_url: legacyRoom })]);
});
});
