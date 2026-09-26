import { Database } from "bun:sqlite";
import { expect, mock, test } from "bun:test";

import { hashCapability } from "./room-domain";

mock.module("cloudflare:workers", () => ({
  DurableObject: class {
    protected ctx: unknown;
    constructor(ctx: unknown) { this.ctx = ctx; }
  },
}));

class Context {
  readonly storage: {
    readonly sql: { exec(query: string, ...values: unknown[]): Iterable<unknown> };
    transactionSync<T>(callback: () => T): T;
    setAlarm(value: number): Promise<void>;
    deleteAlarm(): Promise<void>;
  };
  constructor(readonly database: Database) {
    this.storage = {
      sql: {
        exec: (query, ...values) => {
          if (values.length === 0 && query.includes(";")) {
            database.exec(query);
            return [];
          }
          const statement = database.query(query);
          if (/^\s*(?:SELECT|PRAGMA)/iu.test(query)) return statement.all(...(values as never[]));
          statement.run(...(values as never[]));
          return [];
        },
      },
      transactionSync: <T>(callback: () => T) => database.transaction(callback)(),
      setAlarm: async () => {},
      deleteAlarm: async () => {},
    };
  }
  waitUntil() {}
  getWebSockets() { return []; }
  acceptWebSocket() {}
}

async function room(database = new Database(":memory:")) {
  const { ConversationRoom } = await import("./conversation-room");
  const context = new Context(database);
  return { context, room: new ConversationRoom(context as never, {}, () => 1_000) };
}

function request(path: string, value: unknown): Request {
  return new Request(`https://room${path}`, {
    body: JSON.stringify(value),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
}

function messageInput(author: string, displayName: string, content: string, extra: Record<string, unknown> = {}) {
  return { author, content, display_name: displayName, semantic_type: "message", ...extra };
}

test("claims normalized author and only delivers generated passwords on the first receipt", async () => {
  const { context, room: durable } = await room();
  const initialized = await durable.fetch(request("/initialize", {
    initial: messageInput(" Alice ", "Human Alice", "first"),
    management_hash: "hash",
  }));
  const initial = await initialized.json() as Record<string, unknown>;
  expect(initialized.status).toBe(200);
  expect(initial.name_password).toMatch(/^[A-Za-z0-9]{8}$/u);
  expect(initial.name_password_notice).toContain("Save this password now");
  expect(initial.name_password_notice).toContain("future posts using this name in this room");
  expect(initial.name_password_notice).toContain("Losing it means the name cannot be reused");

  const password = initial.name_password as string;
  const read = await durable.fetch(new Request("https://room/read?after=0"));
  expect(JSON.stringify(await read.json())).not.toContain(password);
  expect(context.database.query("SELECT COUNT(*) AS count FROM name_claims").get()).toEqual({ count: 2 });

  const replayInput = messageInput(" Retry ", "Retry display", "retry", { idempotency_key: "retry-1" });
  const first = await durable.fetch(request("/messages", { idempotency_key: "retry-1", input: replayInput }));
  const firstValue = await first.json() as Record<string, unknown>;
  const generated = firstValue.name_password as string;
  const replay = await durable.fetch(request("/messages", { idempotency_key: "retry-1", input: replayInput }));
  expect(first.status).toBe(200);
  expect(generated).toMatch(/^[A-Za-z0-9]{8}$/u);
  const replayValue = await replay.json() as Record<string, unknown>;
  expect(replayValue).toMatchObject({ replayed: true });
  expect(replayValue).not.toHaveProperty("name_password");
  expect(JSON.stringify(replayValue)).not.toContain(generated);
});

test("accepts a caller password without echoing it and enforces it case insensitively", async () => {
  const { room: durable } = await room();
  await durable.fetch(request("/initialize", { initial: messageInput("owner", "owner", "first"), management_hash: "hash" }));
  const first = await durable.fetch(request("/messages", { input: messageInput("Chosen", "Shown", "chosen", { name_password: "caller-secret" }) }));
  const firstValue = await first.json() as Record<string, unknown>;
  expect(firstValue).not.toHaveProperty("name_password");
  expect(firstValue).not.toHaveProperty("name_password_notice");

  const accepted = await durable.fetch(request("/messages", { input: messageInput(" chosen ", "shown", "again", { name_password: "caller-secret" }) }));
  expect(accepted.status).toBe(200);
  const rejected = await durable.fetch(request("/messages", { input: messageInput("CHOSEN", "shown", "wrong", { name_password: "other-secret" }) }));
  expect(rejected.status).toBe(409);
});

test("rejects posts whose two names belong to conflicting claims", async () => {
  const { room: durable } = await room();
  await durable.fetch(request("/initialize", { initial: messageInput("owner", "owner", "first"), management_hash: "hash" }));
  await durable.fetch(request("/messages", { input: messageInput("left", "left-display", "left", { name_password: "left-secret" }) }));
  await durable.fetch(request("/messages", { input: messageInput("right", "right-display", "right", { name_password: "right-secret" }) }));
  const response = await durable.fetch(request("/messages", { input: messageInput("left", "right", "conflict", { name_password: "left-secret" }) }));
  expect(response.status).toBe(409);
});

test("does not backfill claims for names that predate the migration", async () => {
  const { context, room: durable } = await room();
  await durable.fetch(request("/initialize", { initial: messageInput("Älice", "Legacy Ä", "first"), management_hash: "hash" }));
  context.database.exec("DELETE FROM name_claims");
  context.database.exec("UPDATE room_schema SET version = 12 WHERE singleton = 1");
  context.database.exec("DROP TABLE legacy_names");
  const { ConversationRoom } = await import("./conversation-room");
  const migrated = new ConversationRoom(context as never, {}, () => 1_000);
  const response = await migrated.fetch(request("/messages", { input: messageInput("äLICE", " legacy ä ", "after migration") }));
  expect(response.status).toBe(200);
  expect(await response.json()).not.toHaveProperty("name_password");
  expect(context.database.query("SELECT normalized_name FROM legacy_names ORDER BY normalized_name").all()).toEqual([{ normalized_name: "legacy ä" }, { normalized_name: "älice" }]);
});

test("returns generated credentials through delegated GET posting but not replay", async () => {
  const { room: durable } = await room();
  await durable.fetch(request("/initialize", { initial: messageInput("owner", "owner", "first"), management_hash: await hashCapability("owner") }));
  await durable.fetch(request("/manage?token=owner", { action: "enable", get_post_token: "delegated" }));
  const body = { input: messageInput("fetcher", "fetcher", "via get"), request_id: "get-1", token: "delegated" };
  const first = await durable.fetch(request("/get-post", body));
  const value = await first.json() as Record<string, unknown>;
  const replay = await durable.fetch(request("/get-post", body));
  expect(first.status).toBe(200);
  expect(value.name_password).toMatch(/^[A-Za-z0-9]{8}$/u);
  const replayValue = await replay.json() as Record<string, unknown>;
  expect(replayValue).toMatchObject({ replayed: true });
  expect(replayValue).not.toHaveProperty("name_password");
});
