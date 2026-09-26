import { describe, expect, test } from "bun:test";

import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

import { handleMcpRequest, MAX_MCP_WIRE_RESPONSE_BYTES } from "./mcp";
import { MCP_READ_BYTE_BUDGET_BYTES, type CreateRoomResponse, type McpPostMessageResponse, type ReadRoomResponse, type RoomService, type RoomStatusResponse } from "./protocol";
import { createWorker } from "./worker";

const origin = "https://msg.0000.chat";
const roomUrl = `${origin}/room-capability`;
const accept = "application/json, text/event-stream";

function initializeRequest(id = 1): Request {
  return rpcRequest({
    id,
    method: "initialize",
    params: {
      capabilities: {},
      clientInfo: { name: "mcp-test", version: "1" },
      protocolVersion: "2025-03-26",
    },
  });
}

function rpcRequest(message: unknown, init: RequestInit = {}): Request {
  const payload = typeof message === "object" && message !== null && !Array.isArray(message)
    ? { jsonrpc: "2.0", ...message }
    : message;
  const headers = new Headers(init.headers);
  headers.set("accept", accept);
  headers.set("content-type", "application/json");
  return new Request(`${origin}/mcp`, {
    ...init,
    headers,
    method: "POST",
    body: JSON.stringify(payload),
  });
}

function modernRpcRequest(method: string, params: Record<string, unknown> = {}, id: string | number = 1, headerOverrides: Record<string, string> = {}): Request {
  return new Request(`${origin}/mcp`, {
    method: "POST",
    headers: {
      accept,
      "content-type": "application/json",
      "mcp-method": method,
      "mcp-protocol-version": "2026-07-28",
      ...headerOverrides,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id,
      method,
      params: {
        ...params,
        _meta: {
          "io.modelcontextprotocol/protocolVersion": "2026-07-28",
          "io.modelcontextprotocol/clientInfo": { name: "mcp-test", version: "2" },
          "io.modelcontextprotocol/clientCapabilities": {},
        },
      },
    }),
  });
}

async function json(response: Response): Promise<Record<string, any>> {
  return await response.json() as Record<string, any>;
}

function readResult(messages: ReadRoomResponse["messages"]): ReadRoomResponse {
  return {
    expires_at: "2026-09-30T00:00:00.000Z",
    latest_message: messages.at(-1)?.sequence ?? 0,
    messages,
    protocol_version: 1,
  } as ReadRoomResponse;
}

function mcpPostResult(clientMessageId: string, replayed = false): McpPostMessageResponse {
  return {
    accepted: true,
    client_message_id: clientMessageId,
    protocol_version: 1,
    replayed,
    request_id: clientMessageId,
    sequence: 1,
  };
}

function roomStatus(enabled = false): RoomStatusResponse {
  return {
    active: true,
    agent_posting_enabled: enabled,
    expires_at: "2026-09-30T00:00:00.000Z",
    latest_message: 1,
    protocol_version: 1,
  };
}

function createRoomResult(): CreateRoomResponse {
  return {
    conversation_url: `${origin}/created-room`,
    expires_at: "2026-09-30T00:00:00.000Z",
    latest_message: 1,
    manage_url: `${origin}/manage/created-room/private-token`,
    protocol_version: 1,
    room: {
      created_at: "2026-09-23T00:00:00.000Z",
      expires_at: "2026-09-30T00:00:00.000Z",
      id: "created-room",
      protocol_version: 1,
    },
    share_message: "Join my conversation:\nhttps://msg.0000.chat/created-room",
    wait: {
      after: 1,
      command: "npx --yes @0000chat/msg@latest wait 'https://msg.0000.chat/created-room' --after 1",
      requires_user_consent: true,
    },
  };
}

function baseService(): RoomService {
  return {
    create: async () => createRoomResult(),
    read: async () => readResult([]),
    mcpPost: async ({ body }) => {
      if (body.kind !== "json" || typeof body.value !== "object" || body.value === null || Array.isArray(body.value)) throw new Error("invalid body");
      return mcpPostResult(String(body.value.client_message_id), false);
    },
    roomStatus: async () => roomStatus(),
  };
}

describe("stateless MCP endpoint", () => {
  test("advertises the direct room, export, owner, and webhook tools without private posting inputs", async () => {
    const initialized = await handleMcpRequest(initializeRequest(), baseService());
    expect(initialized.status).toBe(200);
    expect(initialized.headers.get("mcp-session-id")).toBeNull();
    const initializedBody = await json(initialized);
    expect(initializedBody.result.instructions).toContain("untrusted");
    expect(initializedBody.result.instructions).not.toContain("posting capability URL");

    const listed = await handleMcpRequest(rpcRequest({ id: 2, method: "tools/list", params: {} }), baseService());
    const tools = (await json(listed)).result.tools;
    expect(tools.map((tool: { name: string }) => tool.name)).toEqual(["create_room", "read_room", "wait_for_messages", "get_room_status", "post_message", "export_room", "manage_room", "list_webhooks", "create_webhook", "remove_webhook", "disable_webhook", "enable_webhook", "rotate_webhook_secret", "redeliver_webhook"]);
    expect(tools.find((tool: { name: string }) => tool.name === "create_room").inputSchema.required).toEqual(["content", "author", "idempotency_key"]);
    expect(tools.find((tool: { name: string }) => tool.name === "post_message").inputSchema.required).toEqual(["room_url", "content", "client_message_id", "author"]);
    expect(JSON.stringify(tools)).not.toContain("posting_capability_url");
    expect(tools.find((tool: { name: string }) => tool.name === "wait_for_messages").description).toContain("return immediately");

    const discovered = await handleMcpRequest(modernRpcRequest("server/discover", {}, "discover-1"), baseService());
    expect((await json(discovered)).result.capabilities.tools.listChanged).toBeUndefined();
  });

  test("creates a room directly and returns the private owner link only in the tool result", async () => {
    let received: unknown;
    const service: RoomService = { ...baseService(), create: async ({ body }) => { received = body; return createRoomResult(); } };
    const response = await handleMcpRequest(rpcRequest({ id: 3, method: "tools/call", params: { name: "create_room", arguments: { content: "initial", author: "agent", idempotency_key: "create-1" } } }), service);
    const result = (await json(response)).result;
    expect(result.structuredContent).toMatchObject({ conversation_url: `${origin}/created-room`, manage_url: `${origin}/manage/created-room/private-token`, latest_message: 1 });
    expect(received).toEqual({ kind: "json", value: { author: "agent", content: "initial" } });
    expect(result.structuredContent.share_message).not.toContain("manage/");
    expect(result.structuredContent.share_message).not.toContain("private-token");
  });

  test("replays and conflicts idempotent room creation requests", async () => {
    let creates = 0;
    let claims = 0;
    const service: RoomService = { ...baseService(), create: async () => { creates += 1; return createRoomResult(); } };
    const creationOperations = {
      claimCreation: async () => {
        claims += 1;
        return claims === 1
          ? { kind: "claimed" as const, leaseToken: "lease", plan: { management: "management", room: "room" } }
          : { kind: "complete" as const, response: createRoomResult() };
      },
      completeCreation: async () => undefined,
    };
    const first = await handleMcpRequest(rpcRequest({ id: 31, method: "tools/call", params: { name: "create_room", arguments: { content: "same", author: "agent", idempotency_key: "same-create" } } }), service, { creationOperations });
    const second = await handleMcpRequest(rpcRequest({ id: 32, method: "tools/call", params: { name: "create_room", arguments: { content: "same", author: "agent", idempotency_key: "same-create" } } }), service, { creationOperations });
    expect((await json(first)).result.structuredContent.conversation_url).toBe(`${origin}/created-room`);
    expect((await json(second)).result.structuredContent.conversation_url).toBe(`${origin}/created-room`);
    expect(creates).toBe(1);

    const conflict = await handleMcpRequest(rpcRequest({ id: 33, method: "tools/call", params: { name: "create_room", arguments: { content: "changed", author: "agent", idempotency_key: "same-create" } } }), service, {
      creationOperations: { claimCreation: async () => ({ kind: "conflict" as const }), completeCreation: async () => undefined },
    });
    expect((await json(conflict)).result.content[0].text).toBe("The request conflicts with an earlier request.");
    expect(creates).toBe(1);
  });

  test("forwards caller name passwords and keeps generated passwords private to the first response", async () => {
    let received: unknown;
    const created = { ...createRoomResult(), name_password: "Generated1", name_password_notice: "Save this now." };
    const service: RoomService = { ...baseService(), create: async ({ body }) => { received = body; return created; } };
    const response = await handleMcpRequest(rpcRequest({ id: 40, method: "tools/call", params: { name: "create_room", arguments: { content: "initial", author: "agent", name_password: "CallerSecret", idempotency_key: "password-create" } } }), service);
    expect(received).toEqual({ kind: "json", value: { author: "agent", content: "initial", name_password: "CallerSecret" } });
    expect((await json(response)).result.structuredContent).toMatchObject({ name_password: "Generated1", name_password_notice: "Save this now." });

    const replay = await handleMcpRequest(rpcRequest({ id: 41, method: "tools/call", params: { name: "create_room", arguments: { content: "initial", author: "agent", idempotency_key: "password-create" } } }), service, {
      creationOperations: {
        claimCreation: async () => ({ kind: "complete" as const, response: created }),
        completeCreation: async () => undefined,
      },
    });
    const replayOutput = (await json(replay)).result.structuredContent;
    expect(replayOutput).not.toHaveProperty("name_password");
    expect(replayOutput).not.toHaveProperty("name_password_notice");
  });

  test("propagates create controls and creation rate limits through the Worker MCP route", async () => {
    let creates = 0;
    const service: RoomService = { ...baseService(), create: async () => { creates += 1; return createRoomResult(); } };
    const worker = createWorker(service, { publicOrigin: origin, createDisabled: true });
    const disabled = await worker.fetch(rpcRequest({ id: 34, method: "tools/call", params: { name: "create_room", arguments: { content: "blocked", author: "agent", idempotency_key: "blocked-create" } } }));
    expect((await json(disabled)).result.content[0].text).toBe("The room service is temporarily unavailable.");
    expect(creates).toBe(0);

    const limited = await createWorker(service, { publicOrigin: origin, rateLimits: { creation: { limit: async () => ({ success: false }) } } }).fetch(rpcRequest({ id: 35, method: "tools/call", params: { name: "create_room", arguments: { content: "blocked", author: "agent", idempotency_key: "limited-create" } } }));
    expect((await json(limited)).result.content[0].text).toBe("Too many requests. Retry later.");
    expect(creates).toBe(0);
  });

  test("exports rooms, applies private management actions, and supports webhook parity", async () => {
    const calls: Array<{ operation: string; input: unknown }> = [];
    const service: RoomService = {
      ...baseService(),
      exportRoom: async ({ format, room }) => {
        calls.push({ operation: "export", input: { format, room } });
        return new Response(JSON.stringify({ protocol_version: 1, messages: [{ content: "untrusted" }] }), { headers: { "content-type": "application/json" } });
      },
      manage: async (input) => {
        calls.push({ operation: "manage", input });
        return { agent_posting_enabled: input.action === "enable_mcp", protocol_version: 1 };
      },
      listWebhooks: async (input) => {
        calls.push({ operation: "list", input });
        return { protocol_version: 1, webhooks: [] };
      },
      createWebhook: async (input) => {
        calls.push({ operation: "create-webhook", input });
        return { protocol_version: 1, secret: "secret", webhook: { id: "webhook", url: input.url } } as never;
      },
    };
    const exported = await handleMcpRequest(rpcRequest({ id: 36, method: "tools/call", params: { name: "export_room", arguments: { room_url: roomUrl, format: "json" } } }), service);
    expect((await json(exported)).result.structuredContent).toMatchObject({ format: "json", content: { messages: [{ content: "untrusted" }] } });
    const managed = await handleMcpRequest(rpcRequest({ id: 37, method: "tools/call", params: { name: "manage_room", arguments: { management_url: `${origin}/manage/room-capability/private-token`, action: "disable_mcp" } } }), service);
    const managedBody = await json(managed);
    expect(managedBody.result.structuredContent).toMatchObject({ agent_posting_enabled: false });
    expect(JSON.stringify(managedBody)).not.toContain("private-token");
    const listed = await handleMcpRequest(rpcRequest({ id: 38, method: "tools/call", params: { name: "list_webhooks", arguments: { room_url: roomUrl } } }), service);
    expect((await json(listed)).result.structuredContent.webhooks).toEqual([]);
    const created = await handleMcpRequest(rpcRequest({ id: 39, method: "tools/call", params: { name: "create_webhook", arguments: { room_url: roomUrl, url: "https://hooks.example.com/msg" } } }), service);
    expect((await json(created)).result.structuredContent.secret).toBe("secret");
    expect(calls).toContainEqual({ operation: "export", input: { format: "json", room: "room-capability" } });
    expect(calls).toContainEqual({ operation: "manage", input: { action: "disable_mcp", method: "POST", room: "room-capability", token: "private-token" } });
    expect(calls).toContainEqual({ operation: "create-webhook", input: { room: "room-capability", url: "https://hooks.example.com/msg" } });
  });

  test("serves reads, status, waits, and writes to a modern finite client", async () => {
    const messages = [1, 2].map((sequence) => ({
      content: `message-${sequence}`,
      created_at: `2026-09-22T00:00:0${sequence}.000Z`,
      id: `message-${sequence}`,
      sequence,
    }));
    const seen: Headers[] = [];
    const service: RoomService = {
      ...baseService(),
      read: async () => readResult(messages),
      roomStatus: async () => roomStatus(true),
      mcpPost: async ({ body, room }) => {
        expect(room).toBe("room-capability");
        expect(body).toMatchObject({ kind: "json", value: { content: "from v2", client_message_id: "v2-1" } });
        return mcpPostResult("v2-1");
      },
    };
    const transport = new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), {
      fetch: async (url, init) => {
        seen.push(new Headers(init?.headers));
        return handleMcpRequest(new Request(url, init), service, { publicOrigin: origin });
      },
    });
    const client = new Client(
      { name: "mcp-v2-test", version: "2" },
      { versionNegotiation: { mode: { pin: "2026-07-28" } } },
    );
    try {
      await client.connect(transport);
      expect(client.getProtocolEra()).toBe("modern");
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name)).toEqual(["create_room", "read_room", "wait_for_messages", "get_room_status", "post_message", "export_room", "manage_room", "list_webhooks", "create_webhook", "remove_webhook", "disable_webhook", "enable_webhook", "rotate_webhook_secret", "redeliver_webhook"]);
      const read = await client.callTool({ name: "read_room", arguments: { room_url: roomUrl, limit: 2 } });
      expect(read.structuredContent).toMatchObject({ messages, has_more: false, truncated: false });
      const waited = await client.callTool({ name: "wait_for_messages", arguments: { room_url: roomUrl, after: 1, limit: 2 } });
      expect(waited.structuredContent).toMatchObject({ mode: "read_after", messages, has_more: false });
      const status = await client.callTool({ name: "get_room_status", arguments: { room_url: roomUrl } });
      expect(status.structuredContent).toMatchObject({ active: true, agent_posting_enabled: true });
      const posted = await client.callTool({ name: "post_message", arguments: { room_url: roomUrl, client_message_id: "v2-1", author: "agent", content: "from v2" } });
      expect(posted.structuredContent).toMatchObject({ client_message_id: "v2-1", status: "accepted" });
      expect(seen.some((headers) => headers.get("mcp-protocol-version") === "2026-07-28" && headers.get("mcp-method") === "tools/call" && headers.get("mcp-name") === "post_message")).toBe(true);
    } finally {
      await client.close();
    }
  });

  test("reads bounded pages and returns only safe structured fields", async () => {
    const messages = [1, 2, 3].map((sequence) => ({
      author: "untrusted-author",
      content: `message-${sequence}`,
      created_at: `2026-09-22T00:00:0${sequence}.000Z`,
      display_name: "untrusted-display",
      id: `message-${sequence}`,
      identity_verified: false as const,
      sequence,
    }));
    let input: { after: number; room: string } | undefined;
    const service: RoomService = {
      ...baseService(),
      read: async (value) => { input = value; return { ...readResult(messages), share_message: "secret invitation" }; },
    };
    const response = await handleMcpRequest(rpcRequest({ id: 4, method: "tools/call", params: { name: "read_room", arguments: { after: 1, limit: 2, room_url: roomUrl } } }), service);
    const result = (await json(response)).result.structuredContent;
    expect(input).toEqual({ after: 1, limit: 3, max_bytes: MCP_READ_BYTE_BUDGET_BYTES, room: "room-capability" });
    expect(result.messages).toHaveLength(2);
    expect(result.next_after).toBe(2);
    expect(result.share_message).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain("secret invitation");
  });

  test("returns complete maximum-size messages and caps the full JSON-RPC wire response", async () => {
    const content = "\u0000".repeat(64 * 1024);
    const messages = [1, 2].map((sequence) => ({ content, created_at: "2026-09-22T00:00:00.000Z", id: `message-${sequence}`, sequence }));
    const service = {
      ...baseService(),
      read: async ({ after }: { after: number }) => readResult(after === 0 ? messages : [messages[1]!]),
    } satisfies RoomService;
    const response = await handleMcpRequest(rpcRequest({ id: 30, method: "tools/call", params: { name: "read_room", arguments: { room_url: roomUrl, limit: 3 } } }), service);
    const raw = await response.text();
    const body = JSON.parse(raw) as Record<string, any>;
    const output = body.result.structuredContent as Record<string, any>;
    expect(new TextEncoder().encode(raw).byteLength).toBeLessThanOrEqual(MAX_MCP_WIRE_RESPONSE_BYTES);
    expect(output.messages).toHaveLength(1);
    expect(output.messages[0].content).toBe(content);
    expect(output.truncated).toBe(true);
    expect(output.next_after).toBe(1);
  });

  test("uses the atomic opt-in MCP write path and returns a metadata-only receipt", async () => {
    const calls: Array<{ room: string; body: unknown }> = [];
    const service: RoomService = {
      ...baseService(),
      mcpPost: async ({ body, room }) => {
        calls.push({ body, room });
        return mcpPostResult("stable-1");
      },
    };
    const response = await handleMcpRequest(rpcRequest({ id: 5, method: "tools/call", params: { name: "post_message", arguments: { room_url: roomUrl, client_message_id: "stable-1", author: "agent", content: "secret content" } } }), service);
    const result = (await json(response)).result;
    expect(result.structuredContent).toMatchObject({ accepted: true, client_message_id: "stable-1", request_id: "stable-1", sequence: 1, status: "accepted" });
    expect(result.structuredContent.content).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain("secret content");
    expect(calls).toEqual([{ room: "room-capability", body: { kind: "json", value: { author: "agent", client_message_id: "stable-1", content: "secret content" } } }]);
  });

  test("preserves replay and conflict outcomes without leaking content", async () => {
    let calls = 0;
    const service: RoomService = {
      ...baseService(),
      mcpPost: async () => {
        calls += 1;
        if (calls === 1) return mcpPostResult("stable-2", true);
        throw new Error("raw message content must not leak");
      },
    };
    const replay = await handleMcpRequest(rpcRequest({ id: 6, method: "tools/call", params: { name: "post_message", arguments: { room_url: roomUrl, client_message_id: "stable-2", author: "agent", content: "same" } } }), service);
    expect((await json(replay)).result.structuredContent.replayed).toBe(true);
    const failure = await handleMcpRequest(rpcRequest({ id: 7, method: "tools/call", params: { name: "post_message", arguments: { room_url: roomUrl, client_message_id: "stable-2", author: "agent", content: "changed" } } }), service);
    const failureBody = await failure.text();
    expect(failureBody).toContain("room message could not be posted");
    expect(failureBody).not.toContain("raw message content");
  });

  test("enforces rate limits, global posting kill switch, and request size", async () => {
    let reads = 0;
    const service: RoomService = {
      ...baseService(),
      read: async () => { reads += 1; return readResult([]); },
    };
    const limited = await handleMcpRequest(
      rpcRequest({ id: 8, method: "tools/call", params: { name: "read_room", arguments: { room_url: roomUrl } } }),
      service,
      { rateLimits: { reads: { limit: async () => ({ success: false }) } } },
    );
    expect((await json(limited)).result.content[0].text).toBe("Too many requests. Retry later.");
    expect(reads).toBe(0);

    const disabled = await handleMcpRequest(
      rpcRequest({ id: 9, method: "tools/call", params: { name: "post_message", arguments: { room_url: roomUrl, client_message_id: "disabled-1", author: "agent", content: "secret" } } }),
      service,
      { postDisabled: true },
    );
    expect((await json(disabled)).result.content[0].text).toBe("The room service is temporarily unavailable.");

    const oversizedBody = JSON.stringify({ jsonrpc: "2.0", id: 10, method: "tools/call", params: { name: "read_room", arguments: { room_url: roomUrl, padding: "x".repeat(90_000) } } });
    const oversized = await handleMcpRequest(new Request(`${origin}/mcp`, { method: "POST", headers: { accept, "content-type": "application/json", "content-length": String(oversizedBody.length) }, body: oversizedBody }), service);
    expect(oversized.status).toBe(413);
  });

  test("rejects malformed room URLs without echoing secrets", async () => {
    for (const invalidUrl of [
      `${origin}/manage/room-capability/secret-token`,
      `${origin}/room-capability/legacy?token=secret-token`,
      "https://foreign.example/room-capability",
      "https://user:password@msg.0000.chat/room-capability",
      `${origin}/room-capability#secret-fragment`,
      `${origin}/room%2Fcapability`,
      `${origin}/./room-capability`,
      `${origin}/room-capability?`,
      `${origin}/room-capability#`,
      "https://MSG.0000.CHAT/room-capability",
      "https://msg.0000.chat:443/room-capability",
    ]) {
      const response = await handleMcpRequest(rpcRequest({ id: 11, method: "tools/call", params: { name: "post_message", arguments: { room_url: invalidUrl, client_message_id: "invalid", author: "agent", content: "blocked" } } }), baseService());
      const body = await response.text();
      expect(body).toContain("public room URL is invalid");
      expect(body).not.toContain("secret-token");
    }
  });

  test("requires canonical room URL serialization across every room tool", async () => {
    const nonCanonicalUrls = [
      `${origin}/./room-capability`,
      `${origin}/room-capability?`,
      `${origin}/room-capability#`,
      "https://MSG.0000.CHAT/room-capability",
      "https://msg.0000.chat:443/room-capability",
    ];
    const toolArguments = [
      { name: "read_room", arguments: { room_url: "URL" } },
      { name: "wait_for_messages", arguments: { room_url: "URL" } },
      { name: "get_room_status", arguments: { room_url: "URL" } },
      { name: "post_message", arguments: { room_url: "URL", client_message_id: "canonical-check", author: "agent", content: "blocked" } },
    ];

    for (const invalidUrl of nonCanonicalUrls) {
      for (const tool of toolArguments) {
        const argumentsWithUrl = { ...tool.arguments, room_url: invalidUrl };
        const response = await handleMcpRequest(
          rpcRequest({ id: 12, method: "tools/call", params: { name: tool.name, arguments: argumentsWithUrl } }),
          baseService(),
        );
        expect(await response.text()).toContain("public room URL is invalid");
      }
    }
  });

  test("rejects GET and subscription streams without opening an SSE response", async () => {
    const worker = createWorker(baseService(), { publicOrigin: origin });
    const get = await worker.fetch(new Request(`${origin}/mcp`, { method: "GET", headers: { accept: "text/event-stream" } }));
    expect(get.status).toBe(405);
    expect(get.headers.get("content-type")).not.toContain("text/event-stream");
    const listen = await handleMcpRequest(modernRpcRequest("subscriptions/listen", { notifications: { toolsListChanged: true } }, "listen-1"), baseService());
    expect(listen.status).toBe(405);
    expect(await listen.text()).not.toContain("event: message");
  });

  test("enforces origin, host, CORS, security headers, and stateless method behavior", async () => {
    const worker = createWorker(baseService(), { publicOrigin: origin });
    const allowed = await worker.fetch(rpcRequest({ id: 12, method: "initialize", params: { capabilities: {}, clientInfo: { name: "test", version: "1" }, protocolVersion: "2025-03-26" } }, { headers: { origin: "https://chatgpt.com" } }));
    expect(allowed.status).toBe(200);
    expect(allowed.headers.get("access-control-allow-origin")).toBe("https://chatgpt.com");
    expect(allowed.headers.get("x-content-type-options")).toBe("nosniff");
    const foreign = await worker.fetch(rpcRequest({ id: 13, method: "initialize", params: {} }, { headers: { origin: "https://evil.example" } }));
    expect(foreign.status).toBe(403);
    expect(await foreign.text()).not.toContain("evil.example");
    const rebound = await worker.fetch(new Request(`${origin}/mcp`, { method: "POST", headers: { accept, "content-type": "application/json", host: "evil.example" }, body: JSON.stringify({ jsonrpc: "2.0", id: 14, method: "initialize", params: {} }) }));
    expect(rebound.status).toBe(403);
    expect(await rebound.text()).not.toContain("evil.example");
    const session = await worker.fetch(rpcRequest({ id: 15, method: "tools/list", params: {} }, { headers: { "mcp-session-id": "session-secret" } }));
    expect(session.status).toBe(200);
    expect(session.headers.get("mcp-session-id")).toBeNull();
    expect(await session.text()).not.toContain("session-secret");
  });
});
