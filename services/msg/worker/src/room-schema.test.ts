import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";

import { CURRENT_ROOM_SCHEMA_VERSION, migrateRoomSchema } from "./room-schema";
import { ROOM_LIMITS } from "./room-domain";

function storage(database: Database) {
  return {
    transactionSync: <T>(callback: () => T) => database.transaction(callback)(),
    sql: {
      exec(query: string, ...values: unknown[]) {
        if (values.length === 0 && query.includes(";")) { database.exec(query); return []; }
        const statement = database.query(query);
        if (/^\s*(?:SELECT|PRAGMA)/i.test(query)) return statement.all(...(values as never[]));
        statement.run(...(values as never[])); return [];
      },
    },
  };
}

function restoreVersionFourWebhookTables(database: Database) {
  database.exec(`
    DROP TABLE IF EXISTS push_deliveries;
    DROP TABLE IF EXISTS push_subscriptions;
    DROP TABLE IF EXISTS webhook_delivery_attempts;
    DROP TABLE IF EXISTS webhook_deliveries;
    DROP TABLE IF EXISTS webhook_endpoints;
    CREATE TABLE webhook_endpoints (
      id TEXT PRIMARY KEY, url TEXT NOT NULL, secret TEXT NOT NULL,
      created_at INTEGER NOT NULL, status TEXT NOT NULL CHECK(status = 'active')
    );
    CREATE TABLE webhook_deliveries (
      id TEXT PRIMARY KEY, endpoint_id TEXT NOT NULL, event_id TEXT NOT NULL,
      message_id TEXT NOT NULL, message_sequence INTEGER NOT NULL,
      created_at INTEGER NOT NULL, due_at INTEGER NOT NULL,
      attempted_at INTEGER, completed_at INTEGER, lease_expires_at INTEGER,
      status TEXT NOT NULL CHECK(status IN ('pending', 'sending', 'delivered', 'failed')),
      attempt_count INTEGER NOT NULL, failure_category TEXT
    );
    CREATE INDEX webhook_deliveries_due ON webhook_deliveries(status, due_at, created_at);
    CREATE INDEX webhook_deliveries_endpoint ON webhook_deliveries(endpoint_id, created_at DESC);
    CREATE INDEX webhook_deliveries_retention ON webhook_deliveries(created_at);
  `);
  const messageColumns = database.query("PRAGMA table_info(messages)").all() as { name: string }[];
  if (messageColumns.some(({ name }) => name === "source_browser_id")) database.exec("ALTER TABLE messages DROP COLUMN source_browser_id");
}

test("initializes a fresh durable schema at the current version", () => {
  const database = new Database(":memory:");
  migrateRoomSchema(storage(database));
  expect(database.query("SELECT version FROM room_schema").get()).toEqual({ version: CURRENT_ROOM_SCHEMA_VERSION });
});

test("leaves an existing current schema unchanged", () => {
  const database = new Database(":memory:");
  const roomStorage = storage(database);
  migrateRoomSchema(roomStorage);
  migrateRoomSchema(roomStorage);
  expect(database.query("SELECT version FROM room_schema").get()).toEqual({ version: CURRENT_ROOM_SCHEMA_VERSION });
});

test("fails closed when durable storage has a future schema", () => {
  const database = new Database(":memory:");
  const roomStorage = storage(database);
  migrateRoomSchema(roomStorage);
  database.query("UPDATE room_schema SET version = ?").run(CURRENT_ROOM_SCHEMA_VERSION + 1);
  expect(() => migrateRoomSchema(roomStorage)).toThrow("newer");
});

test("rebuilds legacy inactivity expiry from the last message without an absolute cap", () => {
  const database = new Database(":memory:");
  const roomStorage = storage(database);
  migrateRoomSchema(roomStorage);
  const lastMessageAt = 29 * 24 * 60 * 60 * 1000;
  const oldAbsoluteExpiry = 30 * 24 * 60 * 60 * 1000;
  database.exec("DROP TABLE push_deliveries; DROP TABLE push_subscriptions; ALTER TABLE messages DROP COLUMN source_browser_id;");
  database.exec("DROP TABLE webhook_delivery_attempts; DROP TABLE webhook_deliveries; DROP TABLE webhook_endpoints;");
  database.query("UPDATE room_schema SET version = 2").run();
  database.query("INSERT INTO room_state (singleton, schema_version, protocol_version, created_at, last_message_at, inactivity_expires_at, absolute_expires_at, next_sequence, message_count, total_bytes, status, tombstone_expires_at, management_hash) VALUES (1, 2, 1, ?, ?, ?, ?, 2, 1, 5, 'active', NULL, 'hash')").run(0, lastMessageAt, oldAbsoluteExpiry, oldAbsoluteExpiry);

  migrateRoomSchema(roomStorage);

  expect(database.query("SELECT version FROM room_schema").get()).toEqual({ version: CURRENT_ROOM_SCHEMA_VERSION });
  expect(database.query("SELECT schema_version, inactivity_expires_at FROM room_state").get()).toEqual({ schema_version: CURRENT_ROOM_SCHEMA_VERSION, inactivity_expires_at: lastMessageAt + ROOM_LIMITS.inactivityTtlMs });
});

test("migrates v4 pending, sending, delivered, and failed webhook history", () => {
  const database = new Database(":memory:");
  const roomStorage = storage(database);
  migrateRoomSchema(roomStorage);
  restoreVersionFourWebhookTables(database);
  database.query("UPDATE room_schema SET version = 4").run();

  const endpointId = "endpoint-v4";
  const base = 4_000_000_000_000;
  database.query("INSERT INTO webhook_endpoints (id, url, secret, created_at, status) VALUES (?, ?, ?, ?, 'active')")
    .run(endpointId, "https://receiver.example.com/events", "private-test-secret", base);
  const insertDelivery = database.query("INSERT INTO webhook_deliveries (id, endpoint_id, event_id, message_id, message_sequence, created_at, due_at, attempted_at, completed_at, lease_expires_at, status, attempt_count, failure_category) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
  insertDelivery.run("pending", endpointId, "event-pending", "message-pending", 2, base, base + 250, null, null, null, "pending", 0, null);
  insertDelivery.run("sending", endpointId, "event-sending", "message-sending", 3, base + 100, base + 350, base + 351, null, base + 10_351, "sending", 1, null);
  insertDelivery.run("delivered", endpointId, "event-delivered", "message-delivered", 4, base + 200, base + 450, base + 451, base + 500, null, "delivered", 1, null);
  insertDelivery.run("failed", endpointId, "event-failed", "message-failed", 5, base + 300, base + 550, base + 551, base + 600, null, "failed", 1, "http_status");

  migrateRoomSchema(roomStorage);

  const deliveries = database.query("SELECT id, retry_expires_at, due_at, status, attempt_count, manual_redelivery_requested_at FROM webhook_deliveries ORDER BY id").all();
  expect(deliveries).toEqual([
    { id: "delivered", retry_expires_at: base + 200 + 24 * 60 * 60 * 1_000, due_at: base + 450, status: "delivered", attempt_count: 1, manual_redelivery_requested_at: null },
    { id: "failed", retry_expires_at: base + 300 + 24 * 60 * 60 * 1_000, due_at: base + 600 + 30_000, status: "retrying", attempt_count: 1, manual_redelivery_requested_at: null },
    { id: "pending", retry_expires_at: base + 24 * 60 * 60 * 1_000, due_at: base + 250, status: "pending", attempt_count: 0, manual_redelivery_requested_at: null },
    { id: "sending", retry_expires_at: base + 100 + 24 * 60 * 60 * 1_000, due_at: base + 350, status: "sending", attempt_count: 1, manual_redelivery_requested_at: null },
  ]);
  expect(database.query("SELECT attempt_number, attempted_at, completed_at, status, failure_category FROM webhook_delivery_attempts WHERE delivery_id = 'sending'").get())
    .toEqual({ attempt_number: 1, attempted_at: base + 351, completed_at: null, status: "sending", failure_category: null });
  expect(database.query("SELECT attempt_number, attempted_at, completed_at, status, failure_category FROM webhook_delivery_attempts WHERE delivery_id = 'delivered'").get())
    .toEqual({ attempt_number: 1, attempted_at: base + 451, completed_at: base + 500, status: "delivered", failure_category: null });
  expect(database.query("SELECT attempt_number, attempted_at, completed_at, status, failure_category FROM webhook_delivery_attempts WHERE delivery_id = 'failed'").get())
    .toEqual({ attempt_number: 1, attempted_at: base + 551, completed_at: base + 600, status: "failed", failure_category: "http_status" });
  expect(database.query("SELECT last_success_at, last_failure_at, failure_started_at, recovered_at FROM webhook_endpoints WHERE id = ?").get(endpointId))
    .toEqual({ last_success_at: base + 500, last_failure_at: base + 600, failure_started_at: base + 600, recovered_at: null });
});
