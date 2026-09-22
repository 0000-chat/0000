import { describe, expect, test } from "bun:test";

import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

import { enforceMcpWireLimit, handleMcpRequest, MAX_MCP_WIRE_RESPONSE_BYTES } from "./mcp";
import { MCP_READ_BYTE_BUDGET_BYTES, type GetPostMessageResponse, type ReadRoomResponse, type RoomService } from "./protocol";
import { createWorker } from "./worker";

const origin = "https://msg.0000.chat";
const roomUrl = `${origin}/room-capability`;
const postingCapabilityUrl = `${origin}/room-capability/post?token=delegated-token`;
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

function getPostResult(clientMessageId: string, replayed = false): GetPostMessageResponse {
  return {
    accepted: true,
    protocol_version: 1,
    replayed,
    request_id: clientMessageId,
    sequence: 1,
  };
}

function baseService(): RoomService {
  return {
    create: async () => { throw new Error("unused"); },
    read: async () => readResult([]),
    getPost: async () => getPostResult("ignored"),
  };
}

describe("stateless MCP endpoint", () => {
  test("initializes and advertises exactly the focused tools and safety metadata", async () => {
    const initialized = await handleMcpRequest(initializeRequest(), baseService());
    expect(initialized.status).toBe(200);
    expect(initialized.headers.get("mcp-session-id")).toBeNull();
    const initializedBody = await json(initialized);
    expect(initializedBody.result.instructions).toContain("untrusted");
    expect(initializedBody.result.capabilities.tools.listChanged).toBeUndefined();

    const listed = await handleMcpRequest(rpcRequest({ id: 2, method: "tools/list", params: {} }), baseService());
    const tools = (await json(listed)).result.tools;
    expect(tools.map((tool: { name: string }) => tool.name)).toEqual(["read_room", "post_message"]);
    expect(tools[0].annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
    expect(tools[1].annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true });
    expect(tools[1].inputSchema.required).toEqual(["posting_capability_url", "content", "client_message_id"]);

    const discovered = await handleMcpRequest(modernRpcRequest("server/discover", {}, "discover-1"), baseService());
    expect((await json(discovered)).result.capabilities.tools.listChanged).toBeUndefined();
  });

  test("rejects GET and subscription streams without opening an SSE response", async () => {
    const worker = createWorker(baseService(), { publicOrigin: origin });
    const get = await worker.fetch(new Request(`${origin}/mcp`, {
      method: "GET",
      headers: { accept: "text/event-stream" },
    }));
    expect(get.status).toBe(405);
    expect(get.headers.get("content-type")).not.toContain("text/event-stream");

    const listen = await handleMcpRequest(
      modernRpcRequest("subscriptions/listen", { notifications: { toolsListChanged: true } }, "listen-1"),
      baseService(),
    );
    expect(listen.status).toBe(405);
    expect(listen.headers.get("content-type")).not.toContain("text/event-stream");
    expect(await listen.text()).not.toContain("event: message");

    const methodMismatch = await handleMcpRequest(
      modernRpcRequest("tools/list", {}, "method-mismatch", { "mcp-method": "subscriptions/listen" }),
      baseService(),
    );
    expect(methodMismatch.status).toBe(400);
    expect((await json(methodMismatch)).error.code).toBe(-32020);

    const nameMismatch = await handleMcpRequest(
      modernRpcRequest("tools/call", { name: "read_room", arguments: {} }, "name-mismatch", { "mcp-name": "post_message" }),
      baseService(),
    );
    expect(nameMismatch.status).toBe(400);
    expect((await json(nameMismatch)).error.code).toBe(-32020);
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
      getPost: async ({ requestId }) => {
        return getPostResult(requestId);
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
      const posted = await client.callTool({ name: "post_message", arguments: { client_message_id: "v2-1", content: "from v2", posting_capability_url: postingCapabilityUrl } });
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
    expect(input).toEqual({ after: 1, limit: 3, max_bytes: MCP_READ_BYTE_BUDGET_BYTES, room: "room-capability" });
    expect(result.messages).toHaveLength(2);
    expect(result.messages.map((message: { sequence: number }) => message.sequence)).toEqual([1, 2]);
    expect(result.has_more).toBe(true);
    expect(result.next_after).toBe(2);
    expect(result.share_message).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain("secret invitation");
  });

  test("returns complete maximum-size messages, paginates, and caps the full JSON-RPC wire response", async () => {
    const content = "\u0000".repeat(64 * 1024);
    const messages = [1, 2].map((sequence) => ({
      content,
      created_at: "2026-09-22T00:00:00.000Z",
      id: `message-${sequence}`,
      sequence,
    }));
    const service = {
      ...baseService(),
      read: async ({ after }: { after: number }) => readResult(after === 0 ? messages : [messages[1]!]),
    } satisfies RoomService;
    const response = await handleMcpRequest(
      rpcRequest({ id: 30, method: "tools/call", params: { name: "read_room", arguments: { room_url: roomUrl, limit: 3 } } }),
      service,
    );
    const raw = await response.text();
    const body = JSON.parse(raw) as Record<string, any>;
    const output = body.result.structuredContent as Record<string, any>;
    expect(new TextEncoder().encode(raw).byteLength).toBeLessThanOrEqual(MAX_MCP_WIRE_RESPONSE_BYTES);
    expect(output.messages).toHaveLength(1);
    expect(output.messages[0].content).toBe(content);
    expect(output.truncated).toBe(true);
    expect(output.has_more).toBe(true);
    expect(output.next_after).toBe(1);

    const next = await handleMcpRequest(
      rpcRequest({ id: 31, method: "tools/call", params: { name: "read_room", arguments: { after: 1, room_url: roomUrl, limit: 3 } } }),
      service,
    );
    const nextBody = await json(next);
    expect(nextBody.result.structuredContent.messages).toHaveLength(1);
    expect(nextBody.result.structuredContent.messages[0].content).toBe(content);
    expect(nextBody.result.structuredContent.has_more).toBe(false);
  });

  test("returns an explicit error without advancing when the first message cannot fit", async () => {
    const response = await handleMcpRequest(
      rpcRequest({ id: 32, method: "tools/call", params: { name: "read_room", arguments: { room_url: roomUrl } } }),
      { ...baseService(), read: async () => readResult([{ content: "\u0000".repeat(100 * 1024), created_at: "2026-09-22T00:00:00.000Z", id: "oversized", sequence: 7 }]) },
    );
    const body = await json(response);
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toContain("first room message cannot fit");
    expect(body.result.structuredContent).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain("next_after");
  });

  test("caps finite JSON wire responses without consuming an unbounded event stream", async () => {
    const oversized = await enforceMcpWireLimit(new Response(JSON.stringify({ payload: "x".repeat(MAX_MCP_WIRE_RESPONSE_BYTES) }), {
      headers: { "content-type": "application/json" },
    }));
    expect(oversized.status).toBe(500);
    expect(await oversized.text()).toContain("maximum wire size");

    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(new Error("the event stream must not be consumed"));
      },
    });
    const streamResponse = new Response(stream, { headers: { "content-type": "text/event-stream" } });
    expect(await enforceMcpWireLimit(streamResponse)).toBe(streamResponse);
  });

  test("uses the atomic delegated GET-post path and returns a metadata-only receipt", async () => {
    const calls: Array<{ room: string; token: string; requestId: string }> = [];
    const service: RoomService = {
      ...baseService(),
      getPost: async ({ requestId, room, token }) => {
        calls.push({ requestId, room, token });
        return getPostResult(requestId);
      },
    };
    const response = await handleMcpRequest(rpcRequest({ id: 4, method: "tools/call", params: { name: "post_message", arguments: { client_message_id: "stable-1", content: "secret content", posting_capability_url: postingCapabilityUrl } } }), service);
    const result = (await json(response)).result;
    expect(result.structuredContent).toMatchObject({ accepted: true, client_message_id: "stable-1", request_id: "stable-1", sequence: 1, status: "accepted" });
    expect(result.structuredContent.content).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain("secret content");
    expect(calls).toEqual([{ requestId: "stable-1", room: "room-capability", token: "delegated-token" }]);
  });

  test("requires an owner-enabled posting capability URL and strictly rejects public or malformed URLs", async () => {
    let calls = 0;
    const service: RoomService = {
      ...baseService(),
      getPost: async () => {
        calls += 1;
        return getPostResult("ignored");
      },
    };
    const invalidUrls = [
      roomUrl,
      `${origin}/room-capability/post`,
      `${origin}/room-capability/post?token=delegated-token&unknown=value`,
      `${origin}/room-capability/post?token=one&token=two`,
      `${origin}/room-capability/post?token=delegated-token#fragment`,
      `https://user:password@msg.0000.chat/room-capability/post?token=delegated-token`,
      `https://foreign.example/room-capability/post?token=delegated-token`,
      `${origin}/room-capability/post?token=not%2Fa%20token`,
    ];
    for (const invalidUrl of invalidUrls) {
      const response = await handleMcpRequest(rpcRequest({ id: 50, method: "tools/call", params: { name: "post_message", arguments: { client_message_id: "invalid", content: "blocked", posting_capability_url: invalidUrl } } }), service);
      const body = await response.text();
      expect(body).toContain("posting capability URL is invalid");
      expect(body).not.toContain(invalidUrl);
      expect(body).not.toContain("delegated-token");
    }
    const oversized = `${origin}/room-capability/post?token=${"x".repeat(8 * 1024)}`;
    const response = await handleMcpRequest(rpcRequest({ id: 51, method: "tools/call", params: { name: "post_message", arguments: { client_message_id: "oversized", content: "blocked", posting_capability_url: oversized } } }), service);
    expect(await response.text()).toContain("posting capability URL is too large");
    expect(calls).toBe(0);
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
      getPost: async () => {
        calls += 1;
        if (calls === 1) return getPostResult("stable-2", true);
        throw new Error("raw message content must not leak");
      },
    };
    const replay = await handleMcpRequest(rpcRequest({ id: 6, method: "tools/call", params: { name: "post_message", arguments: { client_message_id: "stable-2", content: "same", posting_capability_url: postingCapabilityUrl } } }), service);
    expect((await json(replay)).result.structuredContent.replayed).toBe(true);
    const failure = await handleMcpRequest(rpcRequest({ id: 7, method: "tools/call", params: { name: "post_message", arguments: { client_message_id: "stable-2", content: "changed", posting_capability_url: postingCapabilityUrl } } }), service);
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
      rpcRequest({ id: 9, method: "tools/call", params: { name: "post_message", arguments: { client_message_id: "disabled-1", content: "secret", posting_capability_url: postingCapabilityUrl } } }),
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
    const caseAndPort = await worker.fetch(rpcRequest({ id: 11, method: "tools/list", params: {} }, { headers: { host: "MSG.0000.CHAT:443" } }));
    expect(caseAndPort.status).toBe(200);
    const session = await worker.fetch(rpcRequest({ id: 12, method: "tools/list", params: {} }, { headers: { "mcp-session-id": "session-secret" } }));
    expect(session.status).toBe(200);
    expect(session.headers.get("mcp-session-id")).toBeNull();
    expect(await session.text()).not.toContain("session-secret");
  });
});
