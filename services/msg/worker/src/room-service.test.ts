import { expect, test } from "bun:test";

import { ERROR_CODES, ProtocolError } from "./errors";
import { DurableRoomService } from "./room-service";

test("creates independent room and management capabilities and does not leak management URL", async () => {
  const calls: Request[] = [];
  const service = new DurableRoomService(
    { getByName: () => ({ fetch: async (request: Request) => { calls.push(request); return Response.json({ created_at: "2026-08-10T00:00:00.000Z", expires_at: "2026-08-17T00:00:00.000Z", absolute_expires_at: "2026-09-09T00:00:00.000Z" }); } }) } as never,
    "https://msg.0000.chat",
    (values) => values.fill(7),
  );

  const result = await service.create({ body: { kind: "raw", value: "hello" } });

  expect(result.conversation_url).toMatch(/^https:\/\/msg\.0000\.chat\/[^/]+$/);
  expect(result.manage_url).toContain("/manage/");
  expect(result.share_message).not.toContain(result.manage_url);
  expect(result.wait).toEqual({
    after: 1,
    command: `npx --yes @0000chat/msg@latest wait '${result.conversation_url}' --after 1`,
    requires_user_consent: true,
  });
  expect(result.wait.command).not.toContain("/manage/");
  expect(result.share_message).toBe([
    "Join my conversation:",
    result.conversation_url,
    "",
    "If you are using an AI agent, copy this message to it:",
    "",
    "```",
    "Do not open or automate the web page.",
    `Run \`npx --yes @0000chat/msg@latest join ${result.conversation_url}\` and follow the instructions it returns.`,
    "```",
  ].join("\n"));
  expect(result.room.created_at).toBe("2026-08-10T00:00:00.000Z");
  expect(result).not.toHaveProperty("absolute_expires_at");
  expect(calls).toHaveLength(1);
});

test("adds foreground wait metadata after a posted message without exposing management capabilities", async () => {
  const service = new DurableRoomService({
    getByName: () => ({
      fetch: async () => Response.json({
        protocol_version: 1,
        message: { content: "reply", created_at: "2026-08-10T00:00:00.000Z", id: "message", sequence: 7 },
      }),
    }),
  } as never, "https://msg.0000.chat");

  const result = await service.post({ body: { kind: "raw", value: "reply" }, room: "public-room" });

  expect(result.wait).toEqual({
    after: 7,
    command: "npx --yes @0000chat/msg@latest wait 'https://msg.0000.chat/public-room' --after 7",
    requires_user_consent: true,
  });
  expect(result.wait.command).not.toContain("manage");
});

test("uses dedicated internal MCP routes without putting a token in the request", async () => {
  const calls: Request[] = [];
  const service = new DurableRoomService({
    getByName: () => ({ fetch: async (request: Request) => {
      calls.push(request);
      if (request.url.endsWith("/mcp-post")) return Response.json({ accepted: true, client_message_id: "mcp-1", protocol_version: 1, replayed: false, request_id: "mcp-1", sequence: 2 });
      return Response.json({ active: true, agent_posting_enabled: true, expires_at: "2026-08-17T00:00:00.000Z", latest_message: 2, protocol_version: 1 });
    } }),
  } as never, "https://msg.0000.chat");

  const posted = await service.mcpPost!({ room: "public-room", body: { kind: "json", value: { content: "hello", client_message_id: "mcp-1" } } });
  const status = await service.roomStatus!({ room: "public-room" });

  expect(posted).toMatchObject({ accepted: true, request_id: "mcp-1", sequence: 2 });
  expect(status).toMatchObject({ active: true, agent_posting_enabled: true });
  expect(calls[0]?.url).toBe("https://room/mcp-post");
  expect(await calls[0]?.clone().json()).toEqual({ input: { author: "anonymous", client_message_id: "mcp-1", content: "hello", display_name: "anonymous", identity_verified: false, semantic_type: "message" } });
  expect(calls[1]?.url).toBe("https://room/status");
});

test("creates a delegated GET posting URL only for owner management actions", async () => {
  const calls: Request[] = [];
  const service = new DurableRoomService(
    { getByName: () => ({ fetch: async (request: Request) => { calls.push(request); return Response.json({ protocol_version: 1, expires_at: "2026-08-17T00:00:00.000Z", get_post_enabled: true }); } }) } as never,
    "https://msg.0000.chat",
    (values) => values.fill(9),
  );

  const result = await service.manage({ action: "enable", method: "POST", room: "public-room", token: "owner-token" });
  const body = await calls[0]!.clone().json() as { action: string; get_post_token: string };

  expect(result.get_post_url).toBe("https://msg.0000.chat/public-room/post?token=CQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQk");
  expect(result.get_post_url_warning).toContain("write capability");
  expect(result.get_post_url_warning).toContain("X-0000-Post-Token");
  expect(body.action).toBe("enable");
  expect(body.get_post_token).toBeTruthy();
  expect(JSON.stringify(result)).not.toContain("owner-token");
});

test("probes a delegated GET posting capability without putting the token in a query", async () => {
  const calls: Request[] = [];
  const service = new DurableRoomService({
    getByName: () => ({ fetch: async (request: Request) => {
      calls.push(request);
      return Response.json({ active: true, get_post_enabled: true, protocol_version: 1 });
    } }),
  } as never, "https://msg.0000.chat");

  const result = await service.getPostProbe({ room: "public-room", token: "delegated-token" });

  expect(result).toEqual({ active: true, get_post_enabled: true, protocol_version: 1 });
  expect(calls[0]?.method).toBe("POST");
  expect(calls[0]?.url).toBe("https://room/get-post-probe");
  expect(await calls[0]?.clone().json()).toEqual({ token: "delegated-token" });
});

test("adds public handoff and wait metadata to a room read", async () => {
  const service = new DurableRoomService({
    getByName: () => ({
      fetch: async () => Response.json({
        absolute_expires_at: "2026-09-09T00:00:00.000Z",
        expires_at: "2026-08-17T00:00:00.000Z",
        latest_message: 2,
        messages: [{ content: "hello", created_at: "2026-08-10T00:00:00.000Z", id: "message", sequence: 2 }],
        protocol_version: 1,
      }),
    }),
  } as never, "https://msg.0000.chat");

  const result = await service.read({ after: 0, room: "public-room" });

  expect(result.conversation_url).toBe("https://msg.0000.chat/public-room");
  expect(result.share_message).toContain("npx --yes @0000chat/msg@latest join https://msg.0000.chat/public-room");
  expect(result.wait).toEqual({
    after: 2,
    command: "npx --yes @0000chat/msg@latest wait 'https://msg.0000.chat/public-room' --after 2",
    requires_user_consent: true,
  });
  expect(result.share_message).not.toContain("/manage/");
  expect(result).not.toHaveProperty("absolute_expires_at");
});

test("uses a normalized configured service origin for public URLs and quoted wait commands", async () => {
  const service = new DurableRoomService({
    getByName: () => ({ fetch: async () => Response.json({ created_at: "2026-08-10T00:00:00.000Z", expires_at: "2026-08-17T00:00:00.000Z" }) }),
  } as never, "HTTPS://MSG.0000.CHAT:443/$(touch injected)/%27%22", (values) => values.fill(7));

  const result = await service.create({ body: { kind: "raw", value: "hello" } });

  expect(result.conversation_url).toMatch(/^https:\/\/msg\.0000\.chat\/[^/]+$/);
  expect(result.wait.command).toBe(`npx --yes @0000chat/msg@latest wait '${result.conversation_url}' --after 1`);
  expect(result.wait.command).not.toContain("injected");
});

test("converts Durable Object export and live errors to protocol errors", async () => {
  const calls: Request[] = [];
  const service = new DurableRoomService({
    getByName: () => ({
      fetch: async (request: Request) => {
        calls.push(request);
        return Response.json({ error: { code: ERROR_CODES.gone, message: "The conversation has expired." } }, { status: 410 });
      },
    }),
  } as never, "https://msg.0000.chat");

  await expect(service.exportRoom({ format: "json", room: "room" })).rejects.toMatchObject(new ProtocolError(ERROR_CODES.gone, "The conversation has expired.", 410));
  await expect(service.live({ after: 0, room: "room" })).rejects.toMatchObject(new ProtocolError(ERROR_CODES.gone, "The conversation has expired.", 410));
  expect(calls[0]?.url).toContain("/export.json");
  expect(calls[1]?.headers.get("upgrade")).toBe("websocket");
});

test("copies successful export responses before the public Worker adds security headers", async () => {
  const upstream = Response.json({ messages: [] });
  const service = new DurableRoomService({
    getByName: () => ({ fetch: async () => upstream }),
  } as never, "https://msg.0000.chat");

  const response = await service.exportRoom({ format: "json", room: "room" });

  expect(response).not.toBe(upstream);
  expect(await response.json()).toEqual({ messages: [] });
});
