import { Database } from "bun:sqlite";
import { expect, mock, test } from "bun:test";

import { hashCapability, ROOM_LIMITS } from "./room-domain";

const DAY_MS = 24 * 60 * 60 * 1000;
type WebhookPayloadSigner = (secret: string, timestamp: string, body: string) => Promise<string>;

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

async function room(database = new Database(":memory:"), clock: () => number = Date.now, env: Record<string, string> = {}, signWebhook?: WebhookPayloadSigner) {
  const { ConversationRoom } = await import("./conversation-room");
  const context = new Context(database);
  return { context, room: new ConversationRoom(context as never, env, clock, signWebhook) };
}

function request(path: string, value: unknown) {
  const body = value !== null && typeof value === "object" && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, entry]) => {
      if ((key !== "initial" && key !== "input") || entry === null || typeof entry !== "object" || Array.isArray(entry)) return [key, entry];
      const message = entry as Record<string, unknown>;
      return [key, message.author === undefined || message.name_password !== undefined ? entry : { ...message, name_password: "test-password" }];
    }))
    : value;
  return new Request(`https://room${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
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

test("looks up a stored message only inside the room and preserves its sequence", async () => {
  const { room: durable } = await room();
  const initialized = await durable.fetch(request("/initialize", { management_hash: "hash", initial: { content: "first", author: "a", display_name: "a", semantic_type: "message" } }));
  const id = (await initialized.json() as { id: string }).id;

  const found = await durable.fetch(new Request(`https://room/messages/${id}`));
  expect(found.status).toBe(200);
  expect(await found.json()).toMatchObject({ message: { id, content: "first", sequence: 1 }, latest_message: 1 });
  expect((await durable.fetch(new Request("https://room/messages/missing"))).status).toBe(404);
  expect((await durable.fetch(new Request("https://room/messages/%"))).status).toBe(404);
});

test("rejects missing reply targets without consuming state or retry keys", async () => {
  const database = new Database(":memory:");
  let now = 1_000;
  const { context, room: durable } = await room(database, () => now);
  await durable.fetch(request("/initialize", { now, management_hash: "hash", initial: { content: "first", author: "a", display_name: "a", semantic_type: "message" } }));
  expect((await durable.fetch(new Request("https://room/live?after=1"))).status).toBe(101);
  const before = await (await durable.fetch(new Request("https://room/read?after=0"))).json() as { expires_at: string; latest_message: number; messages: readonly unknown[] };
  expect(context.sockets[0]?.sent).toHaveLength(1);

  const rejected = await durable.fetch(request("/messages", { now: now + 1, idempotency_key: "retry-after-rejection", input: { content: "reply", author: "b", display_name: "b", semantic_type: "message", reply_to: "999" } }));
  expect(rejected.status).toBe(404);
  const afterRejected = await (await durable.fetch(new Request("https://room/read?after=0"))).json() as { expires_at: string; latest_message: number; messages: readonly unknown[] };
  expect(afterRejected).toMatchObject({ expires_at: before.expires_at, latest_message: before.latest_message });
  expect(afterRejected.messages).toHaveLength(1);
  expect(context.sockets[0]?.sent).toHaveLength(1);

  now += 2;
  const accepted = await durable.fetch(request("/messages", { now: now, idempotency_key: "retry-after-rejection", input: { content: "reply", author: "b", display_name: "b", semantic_type: "message", reply_to: "1" } }));
  expect(accepted.status).toBe(200);
  expect(await accepted.json()).toMatchObject({ replayed: false, message: { sequence: 2, reply_to: "1" } });
  expect(JSON.parse(context.sockets[0]!.sent.at(-1)!)).toMatchObject({ type: "message.created", sequence: 2 });
  const afterAccepted = await (await durable.fetch(new Request("https://room/read?after=0"))).json() as { expires_at: string; latest_message: number; messages: readonly unknown[] };
  expect(afterAccepted.latest_message).toBe(2);
  expect(afterAccepted.messages).toHaveLength(2);
  expect(afterAccepted.expires_at).toBe(new Date(now + ROOM_LIMITS.inactivityTtlMs).toISOString());
  expect(context.alarmAt).toBe(now + ROOM_LIMITS.inactivityTtlMs);
  database.close();
});

test("rejects stale writes without touching expiry, message count, or notifications", async () => {
  const database = new Database(":memory:");
  let now = 1_000;
  const { context, room: durable } = await room(database, () => now);
  await durable.fetch(request("/initialize", { now, management_hash: "hash", initial: { content: "first", author: "a", display_name: "a", semantic_type: "message" } }));
  await durable.fetch(new Request("https://room/live?after=1"));

  now += 1;
  const accepted = await durable.fetch(request("/messages", {
    based_on_sequence: 1,
    idempotency_key: "accepted-message",
    input: { content: "accepted", author: "b", display_name: "b", semantic_type: "message" },
  }));
  expect(accepted.status).toBe(200);
  const acceptedValue = await accepted.json() as { expires_at: string; message: { sequence: number } };
  const sentAfterAccepted = context.sockets[0]?.sent.length;
  const beforeStale = await (await durable.fetch(new Request("https://room/read?after=0"))).json() as { expires_at: string; latest_message: number; messages: unknown[] };
  expect(acceptedValue.expires_at).toBe(beforeStale.expires_at);

  now += 1;
  const stale = await durable.fetch(request("/messages", {
    based_on_sequence: 1,
    idempotency_key: "stale-message",
    input: { content: "stale", author: "b", display_name: "b", semantic_type: "message" },
  }));
  expect(stale.status).toBe(409);
  expect(await stale.json()).toMatchObject({ error: { code: "stale_sequence", latest_message: 2, review_after: 1 } });
  const afterStale = await (await durable.fetch(new Request("https://room/read?after=0"))).json() as { expires_at: string; latest_message: number; messages: unknown[] };
  expect(acceptedValue.message.sequence).toBe(2);
  expect(afterStale).toMatchObject({ expires_at: beforeStale.expires_at, latest_message: 2 });
  expect(afterStale.messages).toHaveLength(beforeStale.messages.length);
  expect(context.sockets[0]?.sent.length).toBe(sentAfterAccepted);

  const retried = await durable.fetch(request("/messages", {
    based_on_sequence: 2,
    idempotency_key: "stale-message",
    input: { content: "stale", author: "b", display_name: "b", semantic_type: "message" },
  }));
  expect(retried.status).toBe(200);
  expect(await retried.json()).toMatchObject({ replayed: false, message: { sequence: 3 } });
  database.close();
});

test("rejects an initial reply before room creation but preserves prior initialization replay", async () => {
  const empty = await room();
  expect((await empty.room.fetch(request("/initialize", { management_hash: "hash", initial: { content: "invalid", author: "a", display_name: "a", semantic_type: "message", reply_to: "1" } }))).status).toBe(404);
  expect((await empty.room.fetch(new Request("https://room/read?after=0"))).status).toBe(404);
  expect((await empty.room.fetch(request("/initialize", { management_hash: "hash", initial: { content: "first", author: "a", display_name: "a", semantic_type: "message" } }))).status).toBe(200);

  const existing = await room();
  await existing.room.fetch(request("/initialize", { management_hash: "hash", initial: { content: "first", author: "a", display_name: "a", semantic_type: "message" } }));
  const replay = await existing.room.fetch(request("/initialize", { management_hash: "hash", initial: { content: "ignored", author: "b", display_name: "b", semantic_type: "message", reply_to: "999" } }));
  expect(replay.status).toBe(200);
  expect(await replay.json()).toMatchObject({ created: false, sequence: 1, content: "first" });
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

test.serial("releases a manual claim without an attempt after repeated signing-key rotations", async () => {
  const database = new Database(":memory:");
  const originalFetch = globalThis.fetch;
  let outboundRequests = 0;
  const now = 4_000_000_000_000;
  let endpointId = "";
  let rotations = 0;
  let activeRoom: Awaited<ReturnType<typeof room>>["room"] | undefined;
  globalThis.fetch = (async () => {
    outboundRequests += 1;
    return new Response(null, { status: 204 });
  }) as typeof fetch;
  const signer: WebhookPayloadSigner = async () => {
    if (!activeRoom || !endpointId) throw new Error("The test signer was used before the endpoint was ready.");
    rotations += 1;
    const rotated = await activeRoom.fetch(new Request(`https://room/webhooks/${endpointId}/rotate-secret`, { method: "POST" }));
    expect(rotated.status).toBe(200);
    return `v1=stale-${rotations}`;
  };

  try {
    const { room: durable } = await room(database, () => now, {}, signer);
    activeRoom = durable;
    await durable.fetch(request("/initialize", { management_hash: "hash", initial: { content: "first", author: "a", display_name: "a", semantic_type: "message" } }));
    const created = await durable.fetch(request("/webhooks", { url: "https://receiver.example.com/signing-rotation-limit" }));
    endpointId = (await created.json() as { webhook: { id: string } }).webhook.id;
    const posted = await durable.fetch(request("/messages", { input: { content: "retained source", author: "b", display_name: "Beta", semantic_type: "message" } }));
    const eventId = (await posted.json() as { message: { id: string } }).message.id;
    const delivery = database.query("SELECT id FROM webhook_deliveries WHERE event_id = ?").get(eventId) as { id: string };
    const priorFailureAt = now - 1_000;
    const priorAttemptAt = now - 1_500;
    database.query("UPDATE webhook_endpoints SET status = 'disabled', disabled_at = ?, failure_started_at = ?, last_failure_at = ? WHERE id = ?")
      .run(priorFailureAt, priorFailureAt, priorFailureAt, endpointId);
    database.query("UPDATE webhook_deliveries SET status = 'failed', attempt_count = 1, attempted_at = ?, completed_at = ?, failure_category = 'http_status' WHERE id = ?")
      .run(priorAttemptAt, priorFailureAt, delivery.id);
    database.query("INSERT INTO webhook_delivery_attempts (delivery_id, attempt_number, attempted_at, completed_at, status, failure_category) VALUES (?, 1, ?, ?, 'failed', 'http_status')")
      .run(delivery.id, priorAttemptAt, priorFailureAt);

    const redeliver = `https://room/webhooks/${endpointId}/deliveries/${eventId}/redeliver`;
    const queued = await durable.fetch(new Request(redeliver, { method: "POST" }));
    expect(await queued.json()).toMatchObject({ result: "queued", delivery: { attempt_count: 1, event_id: eventId, status: "pending" } });
    await durable.alarm();

    expect(rotations).toBe(8);
    expect(outboundRequests).toBe(0);
    expect(database.query("SELECT status, due_at, retry_expires_at, attempt_count, attempted_at, completed_at, cancelled_at, failure_category, manual_redelivery_requested_at FROM webhook_deliveries WHERE id = ?").get(delivery.id))
      .toEqual({
        status: "pending",
        due_at: now + 250,
        retry_expires_at: 4_000_000_000_000 + 24 * 60 * 60 * 1_000,
        attempt_count: 1,
        attempted_at: priorAttemptAt,
        completed_at: priorFailureAt,
        cancelled_at: null,
        failure_category: "http_status",
        manual_redelivery_requested_at: now,
      });
    expect(database.query("SELECT attempt_number, attempted_at, completed_at, status, failure_category FROM webhook_delivery_attempts WHERE delivery_id = ? ORDER BY attempt_number").all(delivery.id))
      .toEqual([{ attempt_number: 1, attempted_at: priorAttemptAt, completed_at: priorFailureAt, status: "failed", failure_category: "http_status" }]);

    const listed = await durable.fetch(new Request("https://room/webhooks"));
    expect(await listed.json()).toMatchObject({
      webhooks: [{
        status: "disabled",
        disabled_at: new Date(priorFailureAt).toISOString(),
        failure_started_at: new Date(priorFailureAt).toISOString(),
        last_failure_at: new Date(priorFailureAt).toISOString(),
        deliveries: [{ attempt_count: 1, event_id: eventId, failure_category: "http_status", next_attempt_at: new Date(now + 250).toISOString(), status: "pending" }],
      }],
    });
    const duplicate = await durable.fetch(new Request(redeliver, { method: "POST" }));
    expect(await duplicate.json()).toMatchObject({ result: "already_queued", delivery: { attempt_count: 1, event_id: eventId, status: "pending" } });
    await durable.alarm();
    expect(rotations).toBe(8);
    expect(outboundRequests).toBe(0);
  } finally {
    globalThis.fetch = originalFetch;
    database.close();
  }
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
  database.exec("DROP TABLE push_deliveries; DROP TABLE push_subscriptions; ALTER TABLE messages DROP COLUMN source_browser_id;");
  database.exec("DROP TABLE webhook_delivery_attempts; DROP TABLE webhook_deliveries; DROP TABLE webhook_endpoints;");
  database.query("UPDATE room_schema SET version = 2").run();
  database.query("INSERT INTO room_state (singleton, schema_version, protocol_version, created_at, last_message_at, inactivity_expires_at, absolute_expires_at, next_sequence, message_count, total_bytes, status, tombstone_expires_at, management_hash) VALUES (1, 2, 1, ?, ?, ?, ?, 2, 1, 5, 'active', NULL, 'hash')").run(start, lastMessageAt, oldAbsolute, oldAbsolute);
  database.query("INSERT INTO messages (sequence, id, content, author, display_name, client, semantic_type, reply_to, created_at, client_message_id, byte_count, idempotency_key) VALUES (1, 'legacy-message', 'first', 'a', 'a', NULL, 'message', '999', ?, 'legacy-client', 5, NULL)").run(lastMessageAt);

  now = oldAbsolute + 1;
  const restarted = await room(database, () => now);
  await restarted.room.alarm();

  expect((await restarted.room.fetch(new Request("https://room/read?after=0"))).status).toBe(200);
  expect(await (await restarted.room.fetch(new Request("https://room/messages/legacy-message"))).json()).toMatchObject({ message: { id: "legacy-message", reply_to: "999" } });
  const replay = await restarted.room.fetch(request("/messages", { input: { content: "first", author: "a", display_name: "a", semantic_type: "message", client_message_id: "legacy-client", reply_to: "999" } }));
  expect(replay.status).toBe(200);
  expect(await replay.json()).toMatchObject({ replayed: true, message: { id: "legacy-message", reply_to: "999" } });
  expect(restarted.context.alarmAt).toBe(lastMessageAt + ROOM_LIMITS.inactivityTtlMs);
});

test("reads a room created by the standalone v4 Worker", async () => {
  const database = new Database(":memory:");
  database.exec(`
    CREATE TABLE room_schema (singleton INTEGER PRIMARY KEY CHECK(singleton = 1), version INTEGER NOT NULL);
    CREATE TABLE room_state (
      singleton INTEGER PRIMARY KEY CHECK(singleton = 1), schema_version INTEGER NOT NULL,
      protocol_version INTEGER NOT NULL, created_at INTEGER NOT NULL, last_message_at INTEGER NOT NULL,
      inactivity_expires_at INTEGER NOT NULL, absolute_expires_at INTEGER NOT NULL,
      next_sequence INTEGER NOT NULL, message_count INTEGER NOT NULL, total_bytes INTEGER NOT NULL,
      status TEXT NOT NULL, tombstone_expires_at INTEGER, management_hash TEXT
    );
    CREATE TABLE messages (
      sequence INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE, content TEXT NOT NULL, author TEXT NOT NULL,
      display_name TEXT NOT NULL, client TEXT, semantic_type TEXT NOT NULL, reply_to TEXT,
      created_at INTEGER NOT NULL, client_message_id TEXT UNIQUE, byte_count INTEGER NOT NULL,
      idempotency_key TEXT
    );
    CREATE TABLE name_claims (normalized_name TEXT PRIMARY KEY, password_hash TEXT NOT NULL, created_at INTEGER NOT NULL);
    CREATE TABLE legacy_names (normalized_name TEXT PRIMARY KEY);
    INSERT INTO room_schema VALUES (1, 4);
    INSERT INTO room_state VALUES (1, 4, 1, 1, 1, 9999999999999, 9999999999999, 2, 1, 1, 'active', NULL, 'hash');
    INSERT INTO messages VALUES (1, 'id', 'x', 'author', 'display', NULL, 'message', NULL, 1, NULL, 1, NULL);
  `);
  database.query("INSERT INTO name_claims (normalized_name, password_hash, created_at) VALUES (?, ?, ?)").run("author", await hashCapability("old-password"), 1);

  const { room: durable } = await room(database, () => 1_000);
  const response = await durable.fetch(new Request("https://room/read?after=0"));

  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ latest_message: 1, messages: [{ sequence: 1, display_name: "display" }] });
  const wrongPassword = await durable.fetch(request("/messages", { input: { content: "second", author: "author", display_name: "display", semantic_type: "message", name_password: "wrong-password" } }));
  expect(wrongPassword.status).toBe(409);
});

test("opens and reads a schema 14 room after restoring removed delegated-posting columns", async () => {
  const database = new Database(":memory:");
  const initial = await room(database, () => 1_000);
  const created = await initial.room.fetch(request("/initialize", {
    now: 1_000,
    management_hash: "management-hash",
    initial: { content: "first", author: "agent", display_name: "Agent", semantic_type: "message" },
  }));
  expect(created.status).toBe(200);

  database.exec("ALTER TABLE room_state DROP COLUMN get_post_hash; ALTER TABLE room_state DROP COLUMN get_post_enabled;");
  database.query("UPDATE room_schema SET version = 14 WHERE singleton = 1").run();
  database.query("UPDATE room_state SET schema_version = 14 WHERE singleton = 1").run();

  const restarted = await room(database, () => 2_000);
  const response = await restarted.room.fetch(new Request("https://room/read?after=0"));

  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ latest_message: 1, messages: [{ content: "first", sequence: 1 }] });
  expect(database.query("SELECT get_post_hash, get_post_enabled FROM room_state WHERE singleton = 1").get()).toEqual({ get_post_hash: null, get_post_enabled: 0 });
});

test("repairs missing coordination tables when a high-version room is read", async () => {
  const database = new Database(":memory:");
  const initial = await room(database, () => 1_000);
  const created = await initial.room.fetch(request("/initialize", {
    now: 1_000,
    management_hash: "management-hash",
    initial: { content: "fixture", author: "agent", display_name: "Agent", semantic_type: "message" },
  }));
  expect(created.status).toBe(200);

  const coordinationTables = [
    "coordination_proposals",
    "coordination_requests",
    "coordination_events",
    "coordination_retries",
    "coordination_panel",
    "coordination_decisions",
    "coordination_decision_positions",
    "coordination_decision_accepted_records",
    "coordination_decision_approval_evidence",
    "coordination_supersessions",
    "coordination_corrections",
    "coordination_disputes",
    "coordination_dispute_reviews",
  ];
  for (const table of coordinationTables) database.exec(`DROP TABLE IF EXISTS ${table}`);
  database.exec("UPDATE room_schema SET version = 15 WHERE singleton = 1; UPDATE room_state SET schema_version = 15 WHERE singleton = 1");

  const restarted = await room(database, () => 2_000);
  const [{ DurableRoomService }, { createWorker }] = await Promise.all([
    import("./room-service"),
    import("./worker"),
  ]);
  const service = new DurableRoomService({
    getByName: () => ({ fetch: (input) => restarted.room.fetch(input) }),
  }, "https://msg.0000.chat");
  const response = await createWorker(service).fetch(new Request("https://msg.0000.chat/fixture-room/agent?after=0", {
    headers: { accept: "application/json" },
  }));

  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ latest_message: 1, messages: [{ sequence: 1 }] });
  expect(database.query("SELECT version FROM room_schema WHERE singleton = 1").get()).toEqual({ version: 17 });
  const repairedTables = (database.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name GLOB 'coordination_*' ORDER BY name").all() as { name: string }[]).map(({ name }) => name);
  expect(repairedTables).toEqual(coordinationTables.sort());
  database.close();
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

test("supports delegated GET posting with replay receipts and owner revocation", async () => {
  let now = 1_000;
  const managementToken = "management-token";
  const delegatedToken = "delegated-token";
  const rotatedToken = "rotated-token";
  const { context, room: durable } = await room(undefined, () => now);
  await durable.fetch(request("/initialize", {
    now,
    management_hash: await hashCapability(managementToken),
    initial: { content: "first", author: "a", display_name: "a", semantic_type: "message" },
  }));

  const live = await durable.fetch(new Request("https://room/live?after=0"));
  expect(live.status).toBe(101);
  const socket = context.sockets[0]!;
  const messageCreatedCount = () => socket.sent.filter((frame) => (JSON.parse(frame) as { type?: string }).type === "message.created").length;
  const readExpiry = async () => {
    const response = await durable.fetch(new Request("https://room/read?after=0"));
    expect(response.status).toBe(200);
    return (await response.json() as { expires_at: string }).expires_at;
  };
  const initialExpiry = await readExpiry();
  expect(socket.sent).toHaveLength(1);
  expect(messageCreatedCount()).toBe(0);

  const enabled = await durable.fetch(request(`/manage?token=${managementToken}`, { action: "enable", get_post_token: delegatedToken }));
  expect(enabled.status).toBe(200);
  expect(await enabled.json()).toMatchObject({ get_post_enabled: true });
  expect(await readExpiry()).toBe(initialExpiry);
  expect(messageCreatedCount()).toBe(0);

  const getPost = (requestId: string, content: string, token = delegatedToken, replyTo?: string) => durable.fetch(request("/get-post", {
    input: { author: "fetch-only", content, display_name: "fetch-only", semantic_type: "message", ...(replyTo === undefined ? {} : { reply_to: replyTo }) },
    request_id: requestId,
    token,
  }));
  const invalidReply = await getPost("invalid-reply", "must not store", delegatedToken, "999");
  expect(invalidReply.status).toBe(404);
  expect(await readExpiry()).toBe(initialExpiry);
  expect(messageCreatedCount()).toBe(0);

  now = 2_000;
  const first = await getPost("request-1", "second");
  expect(first.status).toBe(200);
  const firstValue = await first.json() as Record<string, unknown> & { message: Record<string, unknown> };
  expect(firstValue.accepted).toBe(true);
  expect(firstValue.protocol_version).toBe(1);
  expect(firstValue.replayed).toBe(false);
  expect(firstValue.request_id).toBe("request-1");
  expect(firstValue.sequence).toBe(2);
  expect(firstValue.message.sequence).toBe(2);
  expect(typeof firstValue.message.id).toBe("string");
  expect(typeof firstValue.message.created_at).toBe("string");
  expect(firstValue).not.toHaveProperty("content");
  expect(JSON.stringify(firstValue)).not.toContain("delegated-token");
  const delegatedExpiry = new Date(now + ROOM_LIMITS.inactivityTtlMs).toISOString();
  expect(await readExpiry()).toBe(delegatedExpiry);
  expect(messageCreatedCount()).toBe(1);

  now = 3_000;
  const replay = await getPost("request-1", "second");
  expect(await replay.json()).toMatchObject({ accepted: true, replayed: true, request_id: "request-1", sequence: 2, message: firstValue.message });
  expect(await readExpiry()).toBe(delegatedExpiry);
  expect(messageCreatedCount()).toBe(1);

  const conflict = await getPost("request-1", "changed");
  expect(conflict.status).toBe(409);
  expect(await readExpiry()).toBe(delegatedExpiry);
  expect(messageCreatedCount()).toBe(1);

  now = 4_000;
  const normal = await durable.fetch(request("/messages", { input: { content: "third", author: "a", display_name: "a", semantic_type: "message" } }));
  expect((await normal.json()).message.sequence).toBe(3);
  const normalExpiry = new Date(now + ROOM_LIMITS.inactivityTtlMs).toISOString();
  expect(await readExpiry()).toBe(normalExpiry);
  expect(messageCreatedCount()).toBe(2);

  now = 5_000;
  const replayAfterNormal = await getPost("request-1", "second");
  expect(await replayAfterNormal.json()).toMatchObject({ accepted: true, replayed: true, request_id: "request-1", sequence: 2, message: firstValue.message });
  expect(await readExpiry()).toBe(normalExpiry);
  expect(messageCreatedCount()).toBe(2);

  const disabled = await durable.fetch(request(`/manage?token=${managementToken}`, { action: "disable" }));
  expect(await disabled.json()).toMatchObject({ get_post_enabled: false });
  expect(await readExpiry()).toBe(normalExpiry);
  expect(messageCreatedCount()).toBe(2);
  expect((await getPost("request-1", "second")).status).toBe(404);
  expect(await readExpiry()).toBe(normalExpiry);
  expect(messageCreatedCount()).toBe(2);

  const rotated = await durable.fetch(request(`/manage?token=${managementToken}`, { action: "rotate", get_post_token: rotatedToken }));
  expect(await rotated.json()).toMatchObject({ get_post_enabled: true });
  expect(await readExpiry()).toBe(normalExpiry);
  expect(messageCreatedCount()).toBe(2);
  expect((await getPost("request-1", "second")).status).toBe(404);
  expect(await readExpiry()).toBe(normalExpiry);
  expect(messageCreatedCount()).toBe(2);

  now = 8_000;
  const rotatedPost = await getPost("request-2", "fourth", rotatedToken);
  expect(rotatedPost.status).toBe(200);
  expect((await rotatedPost.json()).sequence).toBe(4);
  const rotatedExpiry = new Date(now + ROOM_LIMITS.inactivityTtlMs).toISOString();
  expect(await readExpiry()).toBe(rotatedExpiry);
  expect(messageCreatedCount()).toBe(3);

  const finalDisabled = await durable.fetch(request(`/manage?token=${managementToken}`, { action: "disable" }));
  expect(await finalDisabled.json()).toMatchObject({ get_post_enabled: false });
  expect(await readExpiry()).toBe(rotatedExpiry);
  expect(messageCreatedCount()).toBe(3);
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

test.serial("keeps an earlier delivery deadline when retention extends room lifetime", async () => {
  const database = new Database(":memory:");
  let now = 10_000;
  const limits = { MSG_TEST_MODE: "1", MSG_TEST_ROOM_LIMITS: JSON.stringify({ inactivityTtlMs: 1_000 }) };
  const { context, room: durable } = await room(database, () => now, limits);
  const management = "owner-token";
  const originalFetch = globalThis.fetch;
  try {
    await durable.fetch(request("/initialize", { management_hash: await hashCapability(management), initial: { content: "source", author: "a", display_name: "A", semantic_type: "message" } }));
    const endpointResponse = await durable.fetch(request("/webhooks", { url: "https://receiver.example.com/retention-deadline" }));
    const endpointId = (await endpointResponse.json() as { webhook: { id: string } }).webhook.id;
    const posted = await durable.fetch(request("/messages", { input: { content: "queued", author: "b", display_name: "B", semantic_type: "message" } }));
    const messageId = (await posted.json() as { message: { id: string } }).message.id;
    const delivery = database.query("SELECT id FROM webhook_deliveries WHERE endpoint_id = ? AND message_id = ?").get(endpointId, messageId) as { id: string };
    database.query("UPDATE webhook_deliveries SET due_at = ?, retry_expires_at = ? WHERE id = ?").run(10_999, 100_000, delivery.id);

    now = 10_500;
    const extension = await durable.fetch(new Request(`https://room/manage/retention?token=${management}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client_retry_id: "retention-deadline", expires_at: new Date(11_500).toISOString() }) }));
    expect(extension.status).toBe(201);
    expect(context.alarmAt).toBe(10_999);

    globalThis.fetch = (async () => new Response(null, { status: 500 })) as typeof fetch;
    now = 11_000;
    await durable.alarm();
    expect(database.query("SELECT status, inactivity_expires_at FROM room_state WHERE singleton = 1").get()).toEqual({ status: "active", inactivity_expires_at: 11_500 });
    expect(database.query("SELECT status FROM webhook_deliveries WHERE id = ?").get(delivery.id)).toEqual({ status: "retrying" });
    expect(database.query("SELECT COUNT(*) AS count FROM coordination_events").get()).toEqual({ count: 1 });
    expect(database.query("SELECT COUNT(*) AS count FROM coordination_retries").get()).toEqual({ count: 1 });

    now = 11_501;
    await durable.alarm();
    expect(database.query("SELECT status FROM room_state WHERE singleton = 1").get()).toEqual({ status: "deleted" });
    expect(database.query("SELECT COUNT(*) AS count FROM webhook_deliveries").get()).toEqual({ count: 0 });
    expect(database.query("SELECT COUNT(*) AS count FROM coordination_events").get()).toEqual({ count: 0 });
    expect(database.query("SELECT COUNT(*) AS count FROM coordination_retries").get()).toEqual({ count: 0 });

    now = 11_500 + ROOM_LIMITS.tombstoneTtlMs + 1;
    await durable.alarm();
    expect(database.query("SELECT singleton FROM room_state WHERE singleton = 1").get()).toBeNull();
  } finally {
    globalThis.fetch = originalFetch;
    database.close();
  }
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

test("supports direct MCP posting, status, owner control, and name password replay", async () => {
  const database = new Database(":memory:");
  let now = 1_000;
  const { room: durable } = await room(database, () => now);
  const management = "owner-token";
  try {
    const initialized = await durable.fetch(request("/initialize", {
      management_hash: await hashCapability(management),
      initial: { content: "first", author: "owner", display_name: "owner", name_password: "owner-secret", semantic_type: "message" },
    }));
    expect(initialized.status).toBe(200);

    const status = await durable.fetch(new Request("https://room/status"));
    expect(await status.json()).toMatchObject({ active: true, agent_posting_enabled: true, latest_message: 1 });

    now += 1;
    const posted = await durable.fetch(new Request("https://room/mcp-post", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input: { content: "from mcp", author: "agent", display_name: "agent", client_message_id: "mcp-1", semantic_type: "message" } }),
    }));
    expect(posted.status).toBe(200);
    const postedValue = await posted.json() as Record<string, unknown>;
    expect(postedValue).toMatchObject({ accepted: true, replayed: false, request_id: "mcp-1", sequence: 2 });
    expect(postedValue.name_password).toEqual(expect.any(String));
    expect(postedValue.name_password_notice).toEqual(expect.any(String));

    const replay = await durable.fetch(new Request("https://room/mcp-post", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input: { content: "from mcp", author: "agent", display_name: "agent", client_message_id: "mcp-1", name_password: postedValue.name_password, semantic_type: "message" } }),
    }));
    const replayValue = await replay.json() as Record<string, unknown>;
    expect(replayValue).toMatchObject({ accepted: true, replayed: true, sequence: 2 });
    expect(replayValue).not.toHaveProperty("name_password");

    const disabled = await durable.fetch(request(`/manage?token=${management}`, { action: "disable_mcp" }));
    expect(await disabled.json()).toMatchObject({ agent_posting_enabled: false });
    expect((await durable.fetch(new Request("https://room/status"))).status).toBe(200);
    expect(await (await durable.fetch(new Request("https://room/status"))).json()).toMatchObject({ agent_posting_enabled: false });
    expect((await durable.fetch(new Request("https://room/mcp-post", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input: { content: "blocked", author: "agent", display_name: "agent", client_message_id: "mcp-2", name_password: postedValue.name_password, semantic_type: "message" } }),
    }))).status).toBe(404);

    const enabled = await durable.fetch(request(`/manage?token=${management}`, { action: "enable_mcp" }));
    expect(await enabled.json()).toMatchObject({ agent_posting_enabled: true });
  } finally {
    database.close();
  }
});
