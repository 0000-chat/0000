import { describe, expect, test } from "bun:test";
import { handleMcpRequest, type McpAuthContext } from "./mcp-events-handler";
import type { RoomService } from "./protocol";

function request(method: string, params?: Record<string, unknown>, id = 1, extraHeaders: Record<string, string> = {}, authenticated = true): Request {
  return new Request("https://msg.example.test/mcp", { method: "POST", headers: { "content-type": "application/json", ...(authenticated ? { authorization: "Bearer test-token" } : {}), ...extraHeaders }, body: JSON.stringify({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) }) });
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

test("advertises account-free tools while explicit bearer requests still require OAuth", async () => {
  const response = await handleMcpRequest(request("tools/list", undefined, 1, {}, false), service);
  expect(response.status).toBe(200);
  const listed = await response.json() as { result: { tools: Array<{ name: string; inputSchema: { required?: string[] } }> } };
  expect(listed.result.tools.map((tool) => tool.name)).toContain("prepare_subscription");
  expect(listed.result.tools.find((tool) => tool.name === "read_thread")?.inputSchema.required).not.toContain("subscription_key");
  expect(listed.result.tools.find((tool) => tool.name === "post_response")?.inputSchema.required).not.toContain("subscription_key");

  const challenged = await handleMcpRequest(request("tools/list", undefined, 2, { authorization: "Bearer malformed" }), service, {
    auth: { authenticate: async () => null },
  });
  expect(challenged.status).toBe(401);
  expect(challenged.headers.get("www-authenticate")).toContain("resource_metadata=\"https://msg.example.test/.well-known/oauth-protected-resource\"");

  const events = await handleMcpRequest(request("events/list", undefined, 3, {}, false), service, { origin: "https://msg.example.test" });
  const event = (await events.json() as { result: { events: Array<{ inputSchema: { required: string[] }; payloadSchema: { properties: { response_context: { required: string[] } } } }> } }).result.events[0];
  expect(event.inputSchema.required).toContain("subscription_key");
  expect(event.payloadSchema.properties.response_context.required).toContain("response_token");

  const eventChallenge = await handleMcpRequest(request("events/list", undefined, 4, { authorization: "Bearer malformed" }), service, {
    origin: "https://msg.example.test",
    auth: { authenticate: async () => null },
  });
  expect(eventChallenge.status).toBe(401);
});

test("prepares a private key and keeps anonymous failures inside MCP without an OAuth challenge", async () => {
  const key = "A".repeat(43);
  let preparedRoom: string | undefined;
  const prepared = await handleMcpRequest(request("tools/call", { name: "prepare_subscription", arguments: { room_url: "https://msg.example.test/thread-1" } }, 1, {}, false), {
    ...service,
    mcpPrepareSubscription: async (input) => {
      preparedRoom = input.room;
      return { subscription_key: key, expires_at: "2030-01-01T00:00:00.000Z" };
    },
  }, { origin: "https://msg.example.test" });
  expect(prepared.status).toBe(200);
  expect(preparedRoom).toBe("thread-1");
  expect((await prepared.json() as { result: { structuredContent: { subscription_key: string } } }).result.structuredContent.subscription_key).toBe(key);

  const missing = await handleMcpRequest(request("events/subscribe", {
    name: "message.created",
    arguments: { room_url: "https://msg.example.test/thread-1" },
    delivery: { mode: "webhook", url: "https://receiver.example.test/callback", secret: `whsec_${btoa("m".repeat(32))}` },
  }, 1, {}, false), service, { origin: "https://msg.example.test" });
  expect(missing.status).toBe(200);
  expect((await missing.json() as { error?: { message?: string } }).error?.message).toContain("subscription_key");
  expect(missing.headers.get("www-authenticate")).toBeNull();
});

test("renews an anonymous key for subscribe and strips it from persisted callback arguments", async () => {
  const key = "B".repeat(43);
  const resolveCalls: boolean[] = [];
  let subscription: Parameters<NonNullable<RoomService["mcpSubscribe"]>>[0] | undefined;
  const callbackFetch: typeof fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as { challenge: string };
    return new Response(JSON.stringify({ challenge: body.challenge }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const response = await handleMcpRequest(request("events/subscribe", {
    name: "message.created",
    arguments: { room_url: "https://msg.example.test/thread-1", subscription_key: key },
    delivery: { mode: "webhook", url: "https://receiver.example.test/anonymous", secret: `whsec_${btoa("n".repeat(32))}` },
    cursor: null,
  }, 1, {}, false), {
    ...service,
    mcpResolveSubscriptionKey: async (input) => {
      expect(input.subscription_key).toBe(key);
      resolveCalls.push(input.renew);
      return { grant_id: "anon-grant", principal_id: "anon-principal", expires_at: "2030-01-01T00:00:00.000Z" };
    },
    mcpSubscribe: async (input) => { subscription = input; return { id: input.id ?? "sub-anonymous", refreshBefore: "2030-01-01T00:00:00.000Z", cursor: "1", truncated: false }; },
  }, { origin: "https://msg.example.test", callbackFetch });
  expect(response.status).toBe(200);
  expect(resolveCalls).toEqual([true]);
  expect(subscription?.principal_id).toBe("anon-principal");
  expect(subscription?.grant_id).toBe("anon-grant");
  expect(JSON.parse(subscription?.arguments_json ?? "{}" )).toEqual({ room_url: "https://msg.example.test/thread-1" });
  expect(subscription?.arguments_json).not.toContain("subscription_key");
});

test("passes an anonymous response token to the Thread validator before posting", async () => {
  let validatedToken: string | undefined;
  let postedPrincipal: string | undefined;
  const response = await handleMcpRequest(request("tools/call", {
    name: "post_response",
    arguments: {
      room_url: "https://msg.example.test/thread-1",
      content: "reply",
      author: "agent",
      client_message_id: "anonymous-response-1",
      response_context: { subscription_id: "sub-anonymous", event_id: "event-anonymous", response_token: "response-secret" },
    },
  }, 1, {}, false), {
    ...service,
    mcpResolveResponseContext: async (input) => input.response_token === "response-secret" ? ({ grant_id: "anon-grant", principal_id: "anon-principal" }) : null,
    mcpValidateResponseContext: async (input) => { validatedToken = input.response_token; return input.response_token === "response-secret"; },
    mcpPostMessage: async (input) => { postedPrincipal = input.principal_id; return { accepted: true, protocol_version: 1, request_id: "anonymous-response-1", sequence: 2, expires_at: "now", replayed: false }; },
  }, { origin: "https://msg.example.test" });
  expect(response.status).toBe(200);
  expect(validatedToken).toBe("response-secret");
  expect(postedPrincipal).toBe("anon-principal");
});

test("keeps ordinary anonymous reads and posts available from the explicit Thread URL", async () => {
  let readRoom: string | undefined;
  let postRoom: string | undefined;
  const durableService: RoomService = {
    ...service,
    mcpReadThread: async (input) => { readRoom = input.room; return { messages: [], after: 0, has_more: false, latest_message: 0, protocol_version: 1, truncated: false, expires_at: "now" }; },
    mcpPostMessage: async (input) => { postRoom = input.room; return { accepted: true, protocol_version: 1, request_id: "anonymous-post-1", sequence: 1, expires_at: "now", replayed: false }; },
  };
  const options = { origin: "https://msg.example.test" };
  const read = await handleMcpRequest(request("tools/call", { name: "read_thread", arguments: { room_url: "https://msg.example.test/thread-1" } }, 1, {}, false), durableService, options);
  const post = await handleMcpRequest(request("tools/call", { name: "post_message", arguments: { room_url: "https://msg.example.test/thread-1", content: "ordinary", author: "agent", client_message_id: "anonymous-post-1" } }, 2, {}, false), durableService, options);
  expect(read.status).toBe(200);
  expect(post.status).toBe(200);
  expect(readRoom).toBe("thread-1");
  expect(postRoom).toBe("thread-1");
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
