import { describe, expect, test } from "bun:test";

import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

import { handleMcpRequest } from "./mcp";
import type { PostMessageResponse, ReadRoomResponse, RoomService } from "./protocol";
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

function postResult(content: string, clientMessageId: string, replayed = false): PostMessageResponse {
  return {
    expires_at: "2026-09-30T00:00:00.000Z",
    message: {
      author: "agent",
      client_message_id: clientMessageId,
      content,
      created_at: "2026-09-22T00:00:00.000Z",
      display_name: "agent",
      id: "message-1",
      identity_verified: false,
      sequence: 1,
    },
    protocol_version: 1,
    replayed,
    wait: { after: 1, command: "ignored", requires_user_consent: true },
  };
}

function baseService(): RoomService {
  return {
    create: async () => { throw new Error("unused"); },
    read: async () => readResult([]),
    post: async () => postResult("ignored", "ignored"),
  };
}

describe("stateless MCP endpoint", () => {
  test("initializes and advertises exactly the focused tools and safety metadata", async () => {
    const initialized = await handleMcpRequest(initializeRequest(), baseService());
    expect(initialized.status).toBe(200);
    expect(initialized.headers.get("mcp-session-id")).toBeNull();
    expect((await json(initialized)).result.instructions).toContain("untrusted");

    const listed = await handleMcpRequest(rpcRequest({ id: 2, method: "tools/list", params: {} }), baseService());
    const tools = (await json(listed)).result.tools;
    expect(tools.map((tool: { name: string }) => tool.name)).toEqual(["read_room", "post_message"]);
    expect(tools[0].annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
    expect(tools[1].annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true });
    expect(tools[1].inputSchema.required).toEqual(["room_url", "content", "client_message_id"]);
  });

  test("serves discovery and tool calls to the v2 modern client", async () => {
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
      post: async ({ body }) => {
        const value = body.kind === "json" && body.value !== null && !Array.isArray(body.value) && typeof body.value === "object" ? body.value : {};
        return postResult(String(value.content), String(value.client_message_id));
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
      expect(tools.tools.map((tool) => tool.name)).toEqual(["read_room", "post_message"]);
      const read = await client.callTool({ name: "read_room", arguments: { room_url: roomUrl, limit: 2 } });
      expect(read.structuredContent).toMatchObject({ messages, has_more: false, truncated: false });
      const posted = await client.callTool({ name: "post_message", arguments: { client_message_id: "v2-1", content: "from v2", room_url: roomUrl } });
      expect(posted.structuredContent).toMatchObject({ client_message_id: "v2-1", status: "accepted" });
      expect(seen.some((headers) => headers.get("mcp-protocol-version") === "2026-07-28" && headers.get("mcp-method") === "server/discover")).toBe(true);
      expect(seen.some((headers) => headers.get("mcp-protocol-version") === "2026-07-28" && headers.get("mcp-method") === "tools/list")).toBe(true);
      expect(seen.some((headers) => headers.get("mcp-protocol-version") === "2026-07-28" && headers.get("mcp-method") === "tools/call" && headers.get("mcp-name") === "read_room")).toBe(true);
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
    const response = await handleMcpRequest(rpcRequest({ id: 3, method: "tools/call", params: { name: "read_room", arguments: { after: 1, limit: 2, room_url: roomUrl } } }), service);
    const result = (await json(response)).result.structuredContent;
    expect(input).toEqual({ after: 1, limit: 3, room: "room-capability" });
    expect(result.messages).toHaveLength(2);
    expect(result.messages.map((message: { sequence: number }) => message.sequence)).toEqual([1, 2]);
    expect(result.has_more).toBe(true);
    expect(result.next_after).toBe(2);
    expect(result.share_message).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain("secret invitation");
  });

  test("bounds structured read output by UTF-8 bytes and reports a cursor", async () => {
    const messages = [1, 2, 3].map((sequence) => ({
      content: "💬".repeat(40_000),
      created_at: "2026-09-22T00:00:00.000Z",
      id: `message-${sequence}`,
      sequence,
    }));
    const response = await handleMcpRequest(
      rpcRequest({ id: 30, method: "tools/call", params: { name: "read_room", arguments: { room_url: roomUrl, limit: 3 } } }),
      { ...baseService(), read: async () => readResult(messages) },
    );
    const body = await json(response);
    const output = body.result.structuredContent as Record<string, unknown>;
    expect(new TextEncoder().encode(JSON.stringify(output)).byteLength).toBeLessThanOrEqual(48 * 1024);
    expect(output.truncated).toBe(true);
    expect(output.has_more).toBe(true);
    expect(output.next_after).toBe(1);
    const text = body.result.content[0].text as string;
    expect(new TextEncoder().encode(text).byteLength).toBeLessThanOrEqual(48 * 1024);
  });

  test("uses the atomic post path and returns a metadata-only receipt", async () => {
    const calls: string[] = [];
    const service: RoomService = {
      ...baseService(),
      post: async ({ body, room }) => {
        const value = body.kind === "json" && body.value !== null && !Array.isArray(body.value) && typeof body.value === "object" ? body.value : {};
        calls.push(room);
        return postResult(String(value.content), String(value.client_message_id));
      },
    };
    const response = await handleMcpRequest(rpcRequest({ id: 4, method: "tools/call", params: { name: "post_message", arguments: { client_message_id: "stable-1", content: "secret content", room_url: roomUrl } } }), service);
    const result = (await json(response)).result;
    expect(result.structuredContent).toMatchObject({ client_message_id: "stable-1", message_id: "message-1", sequence: 1, status: "accepted" });
    expect(result.structuredContent.content).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain("secret content");
    expect(calls).toEqual(["room-capability"]);
  });

  test("rejects management, delegated-post, foreign, credentialed, fragmented, and malformed URLs without echoing them", async () => {
    const invalidUrls = [
      `${origin}/manage/room-capability/token`,
      `${origin}/room-capability/post?token=secret-token`,
      "https://foreign.example/room-capability",
      "https://user:password@msg.0000.chat/room-capability",
      `${origin}/room-capability#secret-fragment`,
      `${origin}/room%2Fcapability`,
    ];
    for (const invalidUrl of invalidUrls) {
      const response = await handleMcpRequest(rpcRequest({ id: 5, method: "tools/call", params: { name: "read_room", arguments: { room_url: invalidUrl } } }), baseService());
      const body = await response.text();
      expect(body).toContain("public room URL is invalid");
      expect(body).not.toContain(invalidUrl);
      expect(body).not.toContain("secret-token");
    }
  });

  test("maps replay and conflict outcomes to stable safe tool errors", async () => {
    let calls = 0;
    const service: RoomService = {
      ...baseService(),
      post: async () => {
        calls += 1;
        if (calls === 1) return postResult("ignored", "stable-2", true);
        throw new Error("raw message content must not leak");
      },
    };
    const replay = await handleMcpRequest(rpcRequest({ id: 6, method: "tools/call", params: { name: "post_message", arguments: { client_message_id: "stable-2", content: "same", room_url: roomUrl } } }), service);
    expect((await json(replay)).result.structuredContent.replayed).toBe(true);
    const failure = await handleMcpRequest(rpcRequest({ id: 7, method: "tools/call", params: { name: "post_message", arguments: { client_message_id: "stable-2", content: "changed", room_url: roomUrl } } }), service);
    const failureBody = await failure.text();
    expect(failureBody).toContain("room message could not be posted");
    expect(failureBody).not.toContain("raw message content");
  });

  test("enforces request size, rate limits, and the posting kill switch", async () => {
    let reads = 0;
    const service: RoomService = {
      ...baseService(),
      read: async () => {
        reads += 1;
        return readResult([]);
      },
    };
    const limited = await handleMcpRequest(
      rpcRequest({ id: 8, method: "tools/call", params: { name: "read_room", arguments: { room_url: roomUrl } } }),
      service,
      { rateLimits: { reads: { limit: async () => ({ success: false }) } } },
    );
    expect((await json(limited)).result.content[0].text).toBe("Too many requests. Retry later.");
    expect(reads).toBe(0);

    const disabled = await handleMcpRequest(
      rpcRequest({ id: 9, method: "tools/call", params: { name: "post_message", arguments: { client_message_id: "disabled-1", content: "secret", room_url: roomUrl } } }),
      service,
      { postDisabled: true },
    );
    expect((await json(disabled)).result.content[0].text).toBe("The room service is temporarily unavailable.");

    const oversizedBody = JSON.stringify({
      jsonrpc: "2.0",
      id: 10,
      method: "tools/call",
      params: { name: "read_room", arguments: { room_url: roomUrl, after: 0, padding: "x".repeat(90_000) } },
    });
    const oversized = await handleMcpRequest(new Request(`${origin}/mcp`, {
      method: "POST",
      headers: { accept, "content-type": "application/json", "content-length": String(oversizedBody.length) },
      body: oversizedBody,
    }), service);
    expect(oversized.status).toBe(413);
    expect(await oversized.text()).not.toContain("x".repeat(90));
  });

  test("enforces origin, host, CORS, security headers, and stateless method behavior", async () => {
    const service = baseService();
    const worker = createWorker(service, { publicOrigin: origin });
    const allowed = await worker.fetch(rpcRequest({ id: 8, method: "initialize", params: { capabilities: {}, clientInfo: { name: "test", version: "1" }, protocolVersion: "2025-03-26" } }, { headers: { origin: "https://chatgpt.com" } }));
    expect(allowed.status).toBe(200);
    expect(allowed.headers.get("access-control-allow-origin")).toBe("https://chatgpt.com");
    expect(allowed.headers.get("access-control-allow-methods")).toBe("POST, OPTIONS");
    expect(allowed.headers.get("x-content-type-options")).toBe("nosniff");
    expect(allowed.headers.get("content-security-policy")).toContain("default-src 'none'");

    const foreign = await worker.fetch(rpcRequest({ id: 9, method: "initialize", params: {} }, { headers: { origin: "https://evil.example" } }));
    expect(foreign.status).toBe(403);
    expect(await foreign.text()).not.toContain("evil.example");
    const rebound = await worker.fetch(new Request(`${origin}/mcp`, { method: "POST", headers: { accept, "content-type": "application/json", host: "evil.example" }, body: JSON.stringify({ jsonrpc: "2.0", id: 10, method: "initialize", params: {} }) }));
    expect(rebound.status).toBe(403);
    expect(await rebound.text()).not.toContain("evil.example");

    const method = await worker.fetch(new Request(`${origin}/mcp`, { method: "GET", headers: { origin: "https://chatgpt.com" } }));
    expect(method.status).toBe(405);
    expect(method.headers.get("allow")).toBe("POST, OPTIONS");
    expect(method.headers.get("access-control-allow-origin")).toBe("https://chatgpt.com");
    const session = await worker.fetch(rpcRequest({ id: 11, method: "tools/list", params: {} }, { headers: { "mcp-session-id": "session-secret" } }));
    expect(session.status).toBe(400);
    expect(await session.text()).not.toContain("session-secret");
  });
});
