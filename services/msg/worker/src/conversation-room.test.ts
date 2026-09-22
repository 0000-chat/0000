import { Database } from "bun:sqlite";
import { expect, mock, test } from "bun:test";

import { hashCapability, ROOM_LIMITS } from "./room-domain";

const DAY_MS = 24 * 60 * 60 * 1000;

mock.module("cloudflare:workers", () => ({
  DurableObject: class {
    protected ctx: unknown;
    constructor(ctx: unknown) { this.ctx = ctx; }
  },
}));

class Context {
  readonly storage: { sql: { exec(query: string, ...values: unknown[]): Iterable<unknown> }; transactionSync<T>(callback: () => T): T; setAlarm(value: number): Promise<void>; deleteAlarm(): Promise<void> };
  alarmAt?: number;
  readonly sockets: FakeSocket[] = [];
  constructor(readonly database: Database) {
    this.storage = {
      sql: { exec: (query, ...values) => {
        if (values.length === 0 && query.includes(";")) { database.exec(query); return []; }
        const statement = database.query(query);
        if (/^\s*(?:SELECT|PRAGMA)/i.test(query)) return statement.all(...(values as never[]));
        statement.run(...(values as never[])); return [];
      } },
      transactionSync: <T>(callback: () => T) => database.transaction(callback)(),
      setAlarm: async (value) => { this.alarmAt = value; },
      deleteAlarm: async () => { this.alarmAt = undefined; },
    };
  }
  getWebSockets() { return this.sockets; }
  acceptWebSocket(socket: FakeSocket) { this.sockets.push(socket); }
  waitUntil() {}
}

class FakeSocket {
  readonly sent: string[] = [];
  closed?: { code: number; reason: string };
  private attachment: unknown;
  send(value: string) { this.sent.push(value); }
  close(code: number, reason: string) { this.closed = { code, reason }; }
  deserializeAttachment() { return this.attachment; }
  serializeAttachment(value: unknown) { this.attachment = value; }
}

class FakeWebSocketPair {
  0 = new FakeSocket();
  1 = new FakeSocket();
}

(globalThis as unknown as { WebSocketPair: typeof FakeWebSocketPair }).WebSocketPair = FakeWebSocketPair;

async function room(database = new Database(":memory:"), clock: () => number = Date.now, env: Record<string, string> = {}) {
  const { ConversationRoom } = await import("./conversation-room");
  const context = new Context(database);
  return { context, room: new ConversationRoom(context as never, env, clock) };
}

function request(path: string, value: unknown) {
  return new Request(`https://room${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(value) });
}

test("stores ordered messages and idempotent replay in SQLite", async () => {
  const { room: durable } = await room();
  const originalNow = Date.now;
  Date.now = () => 4000;
  try {
    await durable.fetch(request("/initialize", { now: 1000, management_hash: "hash", initial: { content: "first", author: "a", display_name: "a", semantic_type: "message" } }));
    const first = await durable.fetch(request("/messages", { now: 2000, idempotency_key: "one", input: { content: "second", author: "b", display_name: "b", semantic_type: "message" } }));
    const replay = await durable.fetch(request("/messages", { now: 3000, idempotency_key: "one", input: { content: "second", author: "b", display_name: "b", semantic_type: "message" } }));
    const read = await durable.fetch(new Request("https://room/read?after=0"));
    expect(first.status).toBe(200);
    expect((await replay.json()).replayed).toBe(true);
    expect((await read.json()).messages.map((message: { sequence: number }) => message.sequence)).toEqual([1, 2]);
  } finally { Date.now = originalNow; }
});

test("rejects room writes while the post kill switch is enabled", async () => {
  const { room: durable } = await room(undefined, Date.now, { MSG_POST_DISABLED: "1" });
  await durable.fetch(request("/initialize", { management_hash: "hash", initial: { content: "first", author: "a", display_name: "a", semantic_type: "message" } }));

  const response = await durable.fetch(request("/messages", { input: { content: "second", author: "a", display_name: "a", semantic_type: "message" } }));

  expect(response.status).toBe(503);
});

test("keeps GET posting off by default and manages a separate delegated capability", async () => {
  const { room: durable } = await room();
  const management = "management-token";
  const delegated = "delegated-token";
  await durable.fetch(request("/initialize", { management_hash: await hashCapability(management), initial: { content: "first", author: "a", display_name: "a", semantic_type: "message" } }));

  const beforeEnable = await durable.fetch(request("/get-post", { token: delegated, request_id: "r1", input: { content: "blocked", author: "b", display_name: "b", semantic_type: "message" } }));
  const enabled = await durable.fetch(new Request(`https://room/manage?token=${management}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "enable", get_post_token: delegated }) }));
  const posted = await durable.fetch(request("/get-post", { token: delegated, request_id: "r1", input: { content: "second", author: "b", display_name: "b", semantic_type: "message" } }));
  const replay = await durable.fetch(request("/get-post", { token: delegated, request_id: "r1", input: { content: "second", author: "b", display_name: "b", semantic_type: "message" } }));

  expect(beforeEnable.status).toBe(404);
  expect(enabled.status).toBe(200);
  expect(await enabled.json()).toMatchObject({ get_post_enabled: true });
  expect(await posted.json()).toMatchObject({ accepted: true, replayed: false, request_id: "r1", sequence: 2 });
  expect(await replay.json()).toMatchObject({ accepted: true, replayed: true, request_id: "r1", sequence: 2 });
  expect(await (await durable.fetch(new Request("https://room/read?after=0"))).text()).toContain("second");
});

test("revokes and rotates GET posting capabilities before the next write transaction", async () => {
  const { room: durable } = await room();
  const management = "management-token";
  await durable.fetch(request("/initialize", { management_hash: await hashCapability(management), initial: { content: "first", author: "a", display_name: "a", semantic_type: "message" } }));
  const manage = (action: string, token?: string) => new Request(`https://room/manage?token=${management}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action, ...(token ? { get_post_token: token } : {}) }) });
  await durable.fetch(manage("enable", "old-token"));
  await durable.fetch(manage("rotate", "new-token"));

  const old = await durable.fetch(request("/get-post", { token: "old-token", request_id: "old", input: { content: "old", author: "b", display_name: "b", semantic_type: "message" } }));
  const current = await durable.fetch(request("/get-post", { token: "new-token", request_id: "new", input: { content: "new", author: "b", display_name: "b", semantic_type: "message" } }));
  await durable.fetch(manage("disable"));
  const disabled = await durable.fetch(request("/get-post", { token: "new-token", request_id: "disabled", input: { content: "disabled", author: "b", display_name: "b", semantic_type: "message" } }));

  expect(old.status).toBe(404);
  expect(current.status).toBe(200);
  expect(disabled.status).toBe(404);
  expect((await (await durable.fetch(new Request("https://room/read?after=0"))).json()).latest_message).toBe(2);
});

test("prefixes delegated GET retries to avoid accidental POST key collisions", async () => {
  const { room: durable } = await room();
  const management = "management-token";
  const input = { content: "same logical message", author: "b", display_name: "b", semantic_type: "message" };
  await durable.fetch(request("/initialize", { management_hash: await hashCapability(management), initial: { content: "first", author: "a", display_name: "a", semantic_type: "message" } }));
  await durable.fetch(new Request(`https://room/manage?token=${management}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "enable", get_post_token: "delegated-token" }) }));
  const post = await durable.fetch(request("/messages", { idempotency_key: "shared-request", input }));
  const getPost = await durable.fetch(request("/get-post", { token: "delegated-token", request_id: "shared-request", input }));
  const getRetry = await durable.fetch(request("/get-post", { token: "delegated-token", request_id: "shared-request", input }));
  const conflict = await durable.fetch(request("/get-post", { token: "delegated-token", request_id: "shared-request", input: { ...input, content: "different" } }));

  expect(post.status).toBe(200);
  expect(await getPost.json()).toMatchObject({ accepted: true, replayed: false, sequence: 3, request_id: "shared-request" });
  expect(await getRetry.json()).toMatchObject({ accepted: true, replayed: true, sequence: 3, request_id: "shared-request" });
  expect(conflict.status).toBe(409);
  expect((await (await durable.fetch(new Request("https://room/read?after=0"))).json()).latest_message).toBe(3);
});

test("allows forced deletion only through the internal Durable Object route", async () => {
  const { context, room: durable } = await room();
  await durable.fetch(request("/initialize", { management_hash: "hash", initial: { content: "first", author: "a", display_name: "a", semantic_type: "message" } }));
  await durable.fetch(new Request("https://room/live?after=0"));

  const deleted = await durable.fetch(new Request("https://room/operator-delete", { method: "POST" }));

  expect(deleted.status).toBe(200);
  expect(context.sockets[0].closed).toMatchObject({ code: 1001 });
  expect((await durable.fetch(new Request("https://room/read?after=0"))).status).toBe(410);
});

test("keeps an active room alive past the former absolute deadline", async () => {
  let now = 1_000;
  const { room: durable } = await room(undefined, () => now);
  const start = 1_000;
  await durable.fetch(request("/initialize", { now: start, management_hash: "hash", initial: { content: "first", author: "a", display_name: "a", semantic_type: "message" } }));
  const postAt = start + 29 * DAY_MS;
  for (const day of [6, 12, 18, 24, 29]) {
    now = start + day * DAY_MS;
    const posted = await durable.fetch(request("/messages", { now: 0, input: { content: `still active at day ${day}`, author: "a", display_name: "a", semantic_type: "message" } }));
    expect(posted.status).toBe(200);
    if (day === 29) expect((await posted.json()).expires_at).toBe(new Date(postAt + ROOM_LIMITS.inactivityTtlMs).toISOString());
  }
  now = start + 30 * DAY_MS + 1;
  expect((await durable.fetch(new Request("https://room/read?after=0"))).status).toBe(200);
  now = postAt + ROOM_LIMITS.inactivityTtlMs + 1;
  expect((await durable.fetch(new Request("https://room/read?after=0"))).status).toBe(410);
});

test("migrates a capped legacy room before its old alarm can expire it", async () => {
  const database = new Database(":memory:");
  let now = 1_000;
  await room(database, () => now);
  const start = 1_000;
  const lastMessageAt = start + 29 * DAY_MS;
  const oldAbsolute = start + 30 * DAY_MS;
  database.query("DELETE FROM messages").run();
  database.query("DELETE FROM room_state").run();
  database.query("UPDATE room_schema SET version = 2").run();
  database.query("INSERT INTO room_state (singleton, schema_version, protocol_version, created_at, last_message_at, inactivity_expires_at, absolute_expires_at, next_sequence, message_count, total_bytes, status, tombstone_expires_at, management_hash) VALUES (1, 2, 1, ?, ?, ?, ?, 2, 1, 5, 'active', NULL, 'hash')").run(start, lastMessageAt, oldAbsolute, oldAbsolute);
  database.query("INSERT INTO messages (sequence, id, content, author, display_name, client, semantic_type, reply_to, created_at, client_message_id, byte_count, idempotency_key) VALUES (1, 'legacy-message', 'first', 'a', 'a', NULL, 'message', NULL, ?, NULL, 5, NULL)").run(lastMessageAt);

  now = oldAbsolute + 1;
  const restarted = await room(database, () => now);
  await restarted.room.alarm();

  expect((await restarted.room.fetch(new Request("https://room/read?after=0"))).status).toBe(200);
  expect(restarted.context.alarmAt).toBe(lastMessageAt + ROOM_LIMITS.inactivityTtlMs);
});

test("does not expose the legacy absolute expiry field in room responses", async () => {
  let now = 1_000;
  const { context, room: durable } = await room(undefined, () => now);
  const initial = await durable.fetch(request("/initialize", { management_hash: "hash", initial: { content: "first", author: "a", display_name: "a", semantic_type: "message" } }));
  expect(await initial.json()).not.toHaveProperty("absolute_expires_at");
  const read = await durable.fetch(new Request("https://room/read?after=0"));
  expect(await read.json()).not.toHaveProperty("absolute_expires_at");
  const live = await durable.fetch(new Request("https://room/live?after=0"));
  expect(JSON.parse(context.sockets[0].sent[0])).not.toHaveProperty("absolute_expires_at");
  expect(live.status).toBe(101);
  now += 1;
  const posted = await durable.fetch(request("/messages", { input: { content: "second", author: "a", display_name: "a", semantic_type: "message" } }));
  expect(await posted.json()).not.toHaveProperty("absolute_expires_at");
  expect(JSON.parse(context.sockets[0].sent.at(-1)!)).not.toHaveProperty("absolute_expires_at");
  const exported = await durable.fetch(new Request("https://room/export.json"));
  expect((await exported.json()).room).not.toHaveProperty("absolute_expires_at");
});

test("serializes concurrent accepted posts into strict unique sequences", async () => {
  const { room: durable } = await room();
  const originalNow = Date.now;
  Date.now = () => 2_000;
  try {
    await durable.fetch(request("/initialize", { now: 1_000, management_hash: "hash", initial: { content: "first", author: "a", display_name: "a", semantic_type: "message" } }));
    const responses = await Promise.all(Array.from({ length: 20 }, (_, index) => durable.fetch(request("/messages", { now: 2_000, input: { content: `message-${index}`, author: "a", display_name: "a", semantic_type: "message" } }))));
    const sequences = await Promise.all(responses.map(async (response) => (await response.json()).message.sequence));
    expect(sequences).toEqual(Array.from({ length: 20 }, (_, index) => index + 2));
  } finally { Date.now = originalNow; }
});

test("keeps SQLite room state after a Durable Object restart", async () => {
  const database = new Database(":memory:");
  const first = await room(database);
  const originalNow = Date.now;
  Date.now = () => 2_000;
  try {
    await first.room.fetch(request("/initialize", { now: 1_000, management_hash: "hash", initial: { content: "first", author: "a", display_name: "a", semantic_type: "message" } }));
    await first.room.fetch(request("/messages", { now: 2_000, input: { content: "second", author: "a", display_name: "a", semantic_type: "message" } }));
    const restarted = await room(database);
    const read = await restarted.room.fetch(new Request("https://room/read?after=0"));
    expect((await read.json()).latest_message).toBe(2);
  } finally { Date.now = originalNow; }
});

test("hides invalid management tokens and deletes valid rooms", async () => {
  const { room: durable } = await room();
  const token = "management-token";
  await durable.fetch(request("/initialize", { now: Date.now(), management_hash: await hashCapability(token), initial: { content: "first", author: "a", display_name: "a", semantic_type: "message" } }));
  expect((await durable.fetch(new Request("https://room/manage?token=wrong"))).status).toBe(404);
  expect((await durable.fetch(new Request(`https://room/manage?token=${token}`))).status).toBe(200);
  expect((await durable.fetch(new Request(`https://room/manage?token=${token}`, { method: "DELETE" })).then(async (response) => response)).status).toBe(200);
  expect((await durable.fetch(new Request("https://room/read?after=0"))).status).toBe(410);
});

test("rejects idempotency key reuse with changed body or client message id", async () => {
  const { room: durable } = await room();
  const now = Date.now();
  await durable.fetch(request("/initialize", { now, management_hash: "hash", initial: { content: "first", author: "a", display_name: "a", semantic_type: "message" } }));
  const input = { content: "second", author: "a", display_name: "a", semantic_type: "message", client_message_id: "client-one" };
  expect((await durable.fetch(request("/messages", { now: now + 1, idempotency_key: "header-key", input }))).status).toBe(200);
  expect((await durable.fetch(request("/messages", { now: now + 2, idempotency_key: "header-key", input: { ...input, content: "changed" } }))).status).toBe(409);
  expect((await durable.fetch(request("/messages", { now: now + 3, idempotency_key: "header-key", input: { ...input, client_message_id: "client-two" } }))).status).toBe(409);
});

test("replays through a client message id with a new header and rejects cross-key rows", async () => {
  const { room: durable } = await room();
  await durable.fetch(request("/initialize", { management_hash: "hash", initial: { content: "first", author: "a", display_name: "a", semantic_type: "message" } }));
  const first = { content: "one", author: "a", display_name: "a", semantic_type: "message", client_message_id: "client-a" };
  const second = { content: "two", author: "a", display_name: "a", semantic_type: "message", client_message_id: "client-b" };
  await durable.fetch(request("/messages", { idempotency_key: "header-a", input: first }));
  expect((await durable.fetch(request("/messages", { idempotency_key: "other-header", input: first }))).status).toBe(200);
  await durable.fetch(request("/messages", { idempotency_key: "header-b", input: second }));
  expect((await durable.fetch(request("/messages", { idempotency_key: "header-b", input: first }))).status).toBe(409);
});

test("enforces the 10 MiB room quota using full message storage bytes", async () => {
  const { room: durable } = await room();
  const input = { content: "a".repeat(64 * 1024), author: "a", display_name: "a", semantic_type: "message" };
  await durable.fetch(request("/initialize", { management_hash: "hash", initial: input }));
  for (let index = 0; index < 158; index += 1) {
    expect((await durable.fetch(request("/messages", { input }))).status).toBe(200);
  }
  expect((await durable.fetch(request("/messages", { input }))).status).toBe(429);
});

test("uses only the Durable Object clock for expiry and inactivity refresh", async () => {
  let now = 1_000;
  const { room: durable } = await room(undefined, () => now);
  await durable.fetch(request("/initialize", { now: 999_999_999, management_hash: "hash", initial: { content: "first", author: "a", display_name: "a", semantic_type: "message" } }));
  now = 2_000;
  const accepted = await durable.fetch(request("/messages", { now: 999_999_999, input: { content: "second", author: "a", display_name: "a", semantic_type: "message" } }));
  expect((await accepted.json()).expires_at).toBe(new Date(now + ROOM_LIMITS.inactivityTtlMs).toISOString());
  now = 2_000 + ROOM_LIMITS.inactivityTtlMs + 1;
  expect((await durable.fetch(request("/messages", { now: 0, input: { content: "late", author: "a", display_name: "a", semantic_type: "message" } }))).status).toBe(410);
});

test("exports a complete ascending transcript with safety warnings", async () => {
  const { room: durable } = await room();
  await durable.fetch(request("/initialize", { management_hash: "hash", initial: { content: "first", author: "a", display_name: "Alpha", semantic_type: "message" } }));
  await durable.fetch(request("/messages", { input: { content: "second", author: "b", display_name: "Beta", semantic_type: "note" } }));
  const markdown = await durable.fetch(new Request("https://room/export.md"));
  const json = await durable.fetch(new Request("https://room/export.json"));
  const markdownBody = await markdown.text();
  expect(markdown.status).toBe(200);
  expect(markdownBody).toContain("self-declared");
  expect(markdownBody).toContain("untrusted");
  expect(markdownBody.indexOf("first")).toBeLessThan(markdownBody.indexOf("second"));
  expect((await json.json()).messages.map((message: { sequence: number }) => message.sequence)).toEqual([1, 2]);
  const empty = await room();
  expect((await empty.room.fetch(new Request("https://room/export.json"))).status).toBe(404);
});

test("returns gone for exports after expiry", async () => {
  let now = 1_000;
  const { room: durable } = await room(undefined, () => now);
  await durable.fetch(request("/initialize", { management_hash: "hash", initial: { content: "first", author: "a", display_name: "a", semantic_type: "message" } }));
  now += ROOM_LIMITS.inactivityTtlMs + 1;
  expect((await durable.fetch(new Request("https://room/export.md"))).status).toBe(410);
});

test("expires after seven idle days and reads do not extend the deadline", async () => {
  let now = 1_000;
  const { room: durable } = await room(undefined, () => now);
  const start = 1_000;
  await durable.fetch(request("/initialize", { now: start, management_hash: "hash", initial: { content: "first", author: "a", display_name: "a", semantic_type: "message" } }));
  now = start + ROOM_LIMITS.inactivityTtlMs - 1;
  expect((await durable.fetch(new Request("https://room/read?after=0"))).status).toBe(200);
  now = start + ROOM_LIMITS.inactivityTtlMs + 1;
  expect((await durable.fetch(new Request("https://room/read?after=0"))).status).toBe(410);
});

test("read-triggered expiry sends the same frame and close as the alarm", async () => {
  let now = 1_000;
  const { context, room: durable } = await room(undefined, () => now);
  await durable.fetch(request("/initialize", { now: 1_000, management_hash: "hash", initial: { content: "first", author: "a", display_name: "a", semantic_type: "message" } }));
  now = 2_000;
  await durable.fetch(new Request("https://room/live?after=1"));
  now = 1_000 + ROOM_LIMITS.inactivityTtlMs + 1;
  expect((await durable.fetch(new Request("https://room/read?after=0"))).status).toBe(410);
  expect(JSON.parse(context.sockets[0].sent.at(-1)!)).toMatchObject({ type: "conversation.expired" });
  expect(context.sockets[0].closed).toMatchObject({ code: 1001 });
});

test("post-triggered expiry sends the same frame and close as the alarm", async () => {
  let now = 1_000;
  const { context, room: durable } = await room(undefined, () => now);
  await durable.fetch(request("/initialize", { now: 1_000, management_hash: "hash", initial: { content: "first", author: "a", display_name: "a", semantic_type: "message" } }));
  now = 2_000;
  await durable.fetch(new Request("https://room/live?after=1"));
  now = 1_000 + ROOM_LIMITS.inactivityTtlMs + 1;
  expect((await durable.fetch(request("/messages", { now: 0, input: { content: "late", author: "a", display_name: "a", semantic_type: "message" } }))).status).toBe(410);
  expect(JSON.parse(context.sockets[0].sent.at(-1)!)).toMatchObject({ type: "conversation.expired" });
  expect(context.sockets[0].closed).toMatchObject({ code: 1001 });
});

test("purges a tombstone and safely repeats alarm delivery", async () => {
  let now = 1_000;
  const { room: durable } = await room(undefined, () => now);
  await durable.fetch(request("/initialize", { now: 1_000, management_hash: "hash", initial: { content: "first", author: "a", display_name: "a", semantic_type: "message" } }));
  now = 1_000 + ROOM_LIMITS.inactivityTtlMs + 1;
  await durable.alarm();
  await durable.alarm();
  now = 1_000 + ROOM_LIMITS.inactivityTtlMs + ROOM_LIMITS.tombstoneTtlMs + 2;
  await durable.alarm();
  await durable.alarm();
  expect((await durable.fetch(new Request("https://room/read?after=0"))).status).toBe(404);
});

test("limits live sockets and emits only metadata frames", async () => {
  const { context, room: durable } = await room();
  const now = Date.now();
  await durable.fetch(request("/initialize", { now, management_hash: "hash", initial: { content: "first", author: "a", display_name: "a", semantic_type: "message" } }));
  const live = await durable.fetch(new Request("https://room/live?after=1"));
  expect(live.status).toBe(101);
  expect(JSON.parse(context.sockets[0].sent[0])).toMatchObject({ type: "ready", latest_message: 1 });
  await durable.fetch(request("/messages", { now: now + 1, input: { content: "secret content", author: "a", display_name: "a", semantic_type: "message" } }));
  const created = JSON.parse(context.sockets[0].sent[1]);
  expect(created).toMatchObject({ type: "message.created", sequence: 2 });
  expect(JSON.stringify(created)).not.toContain("secret content");
  await durable.webSocketMessage(context.sockets[0] as never, "invalid");
  expect(context.sockets[0].closed).toMatchObject({ code: 1008 });
  await Promise.all(Array.from({ length: 49 }, () => durable.fetch(new Request("https://room/live?after=2"))));
  expect((await durable.fetch(new Request("https://room/live?after=2"))).status).toBe(503);
});

test("sends an expiry frame before it closes live sockets", async () => {
  let now = 1_000;
  const { context, room: durable } = await room(undefined, () => now);
  await durable.fetch(request("/initialize", { now: 1_000, management_hash: "hash", initial: { content: "first", author: "a", display_name: "a", semantic_type: "message" } }));
  now = 2_000;
  expect((await durable.fetch(new Request("https://room/live?after=1"))).status).toBe(101);
  now = 1_000 + ROOM_LIMITS.inactivityTtlMs + 1;
  await durable.alarm();
  expect(JSON.parse(context.sockets[0].sent.at(-1)!)).toMatchObject({ type: "conversation.expired" });
  expect(context.sockets[0].closed).toMatchObject({ code: 1001 });
});

test("accepts a reconnect cursor and reports the current latest sequence", async () => {
  const { context, room: durable } = await room();
  const now = Date.now();
  await durable.fetch(request("/initialize", { now, management_hash: "hash", initial: { content: "first", author: "a", display_name: "a", semantic_type: "message" } }));
  await durable.fetch(request("/messages", { now: now + 1, input: { content: "second", author: "a", display_name: "a", semantic_type: "message" } }));
  expect((await durable.fetch(new Request("https://room/live?after=1"))).status).toBe(101);
  expect(JSON.parse(context.sockets[0].sent[0])).toMatchObject({ type: "ready", latest_message: 2 });
});
