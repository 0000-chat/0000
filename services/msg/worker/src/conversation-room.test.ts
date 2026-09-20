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
