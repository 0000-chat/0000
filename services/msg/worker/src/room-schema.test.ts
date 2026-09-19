import { Database } from "bun:sqlite";
import { expect, mock, test } from "bun:test";

import { CURRENT_ROOM_SCHEMA_VERSION, migrateRoomSchema } from "./room-schema";
import { ROOM_LIMITS } from "./room-domain";

mock.module("cloudflare:workers", () => ({
  DurableObject: class {
    protected ctx: unknown;
    constructor(ctx: unknown) { this.ctx = ctx; }
  },
}));

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

class DurableTestContext {
  readonly storage: ReturnType<typeof storage>;
  constructor(database: Database) {
    const roomStorage = storage(database);
    this.storage = { ...roomStorage, setAlarm() {}, deleteAlarm() {} };
  }
  getWebSockets() { return []; }
  acceptWebSocket() {}
  waitUntil() {}
}

/** The schema produced by the upstream notifications v7 migrations. Keep this
 * fixture independent from the merged schema so a version collision cannot be
 * hidden by rewinding a Platform-created database. */
function createAuthenticUpstreamV7Schema(database: Database): void {
  database.exec(`
    CREATE TABLE room_schema (singleton INTEGER PRIMARY KEY CHECK(singleton = 1), version INTEGER NOT NULL);
    INSERT INTO room_schema (singleton, version) VALUES (1, 7);
    CREATE TABLE room_state (
      singleton INTEGER PRIMARY KEY CHECK(singleton = 1), schema_version INTEGER NOT NULL,
      protocol_version INTEGER NOT NULL, created_at INTEGER NOT NULL, last_message_at INTEGER NOT NULL,
      inactivity_expires_at INTEGER NOT NULL, absolute_expires_at INTEGER NOT NULL,
      next_sequence INTEGER NOT NULL, message_count INTEGER NOT NULL, total_bytes INTEGER NOT NULL,
      status TEXT NOT NULL, tombstone_expires_at INTEGER, management_hash TEXT,
      notification_id TEXT
    );
    CREATE TABLE messages (
      sequence INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE, content TEXT NOT NULL, author TEXT NOT NULL,
      display_name TEXT NOT NULL, client TEXT, semantic_type TEXT NOT NULL, reply_to TEXT,
      created_at INTEGER NOT NULL, client_message_id TEXT UNIQUE, byte_count INTEGER NOT NULL,
      idempotency_key TEXT, source_browser_id TEXT
    );
    CREATE UNIQUE INDEX messages_idempotency_key ON messages(idempotency_key);
    CREATE TABLE webhook_endpoints (
      id TEXT PRIMARY KEY, url TEXT NOT NULL, secret TEXT NOT NULL,
      created_at INTEGER NOT NULL, status TEXT NOT NULL CHECK(status IN ('active', 'disabled')),
      failure_started_at INTEGER, last_success_at INTEGER, last_failure_at INTEGER,
      recovered_at INTEGER, disabled_at INTEGER
    );
    CREATE TABLE webhook_deliveries (
      id TEXT PRIMARY KEY, endpoint_id TEXT NOT NULL, event_id TEXT NOT NULL,
      message_id TEXT NOT NULL, message_sequence INTEGER NOT NULL,
      created_at INTEGER NOT NULL, due_at INTEGER NOT NULL, retry_expires_at INTEGER NOT NULL,
      attempted_at INTEGER, completed_at INTEGER, lease_expires_at INTEGER, cancelled_at INTEGER,
      status TEXT NOT NULL CHECK(status IN ('pending', 'sending', 'retrying', 'delivered', 'failed', 'cancelled')),
      attempt_count INTEGER NOT NULL, failure_category TEXT, manual_redelivery_requested_at INTEGER
    );
    CREATE INDEX webhook_deliveries_due ON webhook_deliveries(status, due_at, retry_expires_at, created_at);
    CREATE INDEX webhook_deliveries_endpoint ON webhook_deliveries(endpoint_id, created_at DESC);
    CREATE INDEX webhook_deliveries_retention ON webhook_deliveries(created_at);
    CREATE TABLE webhook_delivery_attempts (
      delivery_id TEXT NOT NULL, attempt_number INTEGER NOT NULL,
      attempted_at INTEGER NOT NULL, completed_at INTEGER,
      status TEXT NOT NULL CHECK(status IN ('sending', 'delivered', 'failed')),
      failure_category TEXT,
      PRIMARY KEY (delivery_id, attempt_number)
    );
    CREATE INDEX webhook_delivery_attempts_delivery ON webhook_delivery_attempts(delivery_id, attempt_number);
    CREATE TABLE push_subscriptions (
      id TEXT PRIMARY KEY, source_browser_id TEXT NOT NULL UNIQUE,
      endpoint TEXT NOT NULL UNIQUE, p256dh TEXT NOT NULL, auth TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE push_deliveries (
      id TEXT PRIMARY KEY, subscription_id TEXT NOT NULL, event_id TEXT NOT NULL,
      message_id TEXT NOT NULL, message_sequence INTEGER NOT NULL,
      created_at INTEGER NOT NULL, due_at INTEGER NOT NULL, retry_expires_at INTEGER NOT NULL,
      attempted_at INTEGER, completed_at INTEGER, lease_expires_at INTEGER,
      status TEXT NOT NULL CHECK(status IN ('pending', 'sending', 'retrying', 'delivered', 'failed')),
      attempt_count INTEGER NOT NULL, failure_category TEXT
    );
    CREATE INDEX push_deliveries_due ON push_deliveries(status, due_at, retry_expires_at, created_at);
    CREATE INDEX push_deliveries_subscription ON push_deliveries(subscription_id, created_at DESC);
    CREATE INDEX push_deliveries_retention ON push_deliveries(created_at);
  `);
  database.query("INSERT INTO room_state (singleton, schema_version, protocol_version, created_at, last_message_at, inactivity_expires_at, absolute_expires_at, next_sequence, message_count, total_bytes, status, tombstone_expires_at, management_hash, notification_id) VALUES (1, 7, 1, ?, ?, ?, ?, 2, 1, 5, 'active', NULL, ?, ?)")
    .run(1_000, 2_000, 604_802_000, 2_592_002_000, "upstream-management", "upstream-notification");
  database.query("INSERT INTO messages (sequence, id, content, author, display_name, client, semantic_type, reply_to, created_at, client_message_id, byte_count, idempotency_key, source_browser_id) VALUES (1, ?, ?, ?, ?, NULL, 'message', NULL, ?, NULL, 5, ?, ?)")
    .run("upstream-message", "hello", "upstream", "Upstream", 2_000, "upstream-idempotency", "upstream-browser");
  database.query("INSERT INTO webhook_endpoints (id, url, secret, created_at, status, last_success_at) VALUES (?, ?, ?, ?, 'active', ?)")
    .run("upstream-endpoint", "https://receiver.example/events", "upstream-secret", 2_100, 2_200);
  database.query("INSERT INTO webhook_deliveries (id, endpoint_id, event_id, message_id, message_sequence, created_at, due_at, retry_expires_at, attempted_at, completed_at, lease_expires_at, cancelled_at, status, attempt_count, failure_category, manual_redelivery_requested_at) VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?, NULL, NULL, 'delivered', 1, NULL, NULL)")
    .run("upstream-delivery", "upstream-endpoint", "upstream-event", "upstream-message", 2_300, 2_400, 86_402_300, 2_350, 2_360);
  database.query("INSERT INTO webhook_delivery_attempts (delivery_id, attempt_number, attempted_at, completed_at, status, failure_category) VALUES (?, 1, ?, ?, 'delivered', NULL)")
    .run("upstream-delivery", 2_350, 2_360);
  database.query("INSERT INTO push_subscriptions (id, source_browser_id, endpoint, p256dh, auth, created_at) VALUES (?, ?, ?, ?, ?, ?)")
    .run("upstream-subscription", "upstream-browser", "https://push.example/subscription", "p256dh", "auth", 2_500);
  database.query("INSERT INTO push_deliveries (id, subscription_id, event_id, message_id, message_sequence, created_at, due_at, retry_expires_at, attempted_at, completed_at, lease_expires_at, status, attempt_count, failure_category) VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?, NULL, 'delivered', 1, NULL)")
    .run("upstream-push-delivery", "upstream-subscription", "upstream-push-event", "upstream-message", 2_600, 2_700, 86_402_600, 2_650, 2_660);
}

/** The Platform branch's last pre-merge schema, version 6. */
function createPlatformV6Schema(database: Database): void {
  database.exec(`
    CREATE TABLE room_schema (singleton INTEGER PRIMARY KEY CHECK(singleton = 1), version INTEGER NOT NULL);
    INSERT INTO room_schema (singleton, version) VALUES (1, 6);
    CREATE TABLE room_state (
      singleton INTEGER PRIMARY KEY CHECK(singleton = 1), schema_version INTEGER NOT NULL,
      protocol_version INTEGER NOT NULL, created_at INTEGER NOT NULL, last_message_at INTEGER NOT NULL,
      inactivity_expires_at INTEGER NOT NULL, absolute_expires_at INTEGER NOT NULL,
      next_sequence INTEGER NOT NULL, message_count INTEGER NOT NULL, total_bytes INTEGER NOT NULL,
      status TEXT NOT NULL, tombstone_expires_at INTEGER, management_hash TEXT,
      owner_guest_id TEXT, creation_guest_id TEXT, owner_organization_id TEXT,
      owner_subject_id TEXT, links_revoked INTEGER NOT NULL DEFAULT 0 CHECK (links_revoked IN (0, 1))
    );
    CREATE TABLE messages (
      sequence INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE, content TEXT NOT NULL, author TEXT NOT NULL,
      display_name TEXT NOT NULL, client TEXT, semantic_type TEXT NOT NULL, reply_to TEXT,
      created_at INTEGER NOT NULL, client_message_id TEXT UNIQUE, byte_count INTEGER NOT NULL,
      idempotency_key TEXT
    );
    CREATE UNIQUE INDEX messages_idempotency_key ON messages(idempotency_key);
    CREATE TABLE room_acl (
      guest_id TEXT NOT NULL, source TEXT NOT NULL CHECK (source IN ('owner', 'public', 'management')),
      capabilities TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
      created_at INTEGER NOT NULL, grant_id TEXT, PRIMARY KEY (guest_id, source)
    );
    CREATE INDEX room_acl_room_guest ON room_acl(guest_id, source);
    CREATE TABLE claim_receipts (
      idempotency_key TEXT PRIMARY KEY, request_digest TEXT NOT NULL, original_guest_id TEXT NOT NULL,
      claimant_subject_id TEXT NOT NULL, organization_id TEXT NOT NULL,
      revoke_links INTEGER NOT NULL CHECK (revoke_links IN (0, 1)), claimed_at INTEGER NOT NULL
    );
  `);
  database.query("INSERT INTO room_state (singleton, schema_version, protocol_version, created_at, last_message_at, inactivity_expires_at, absolute_expires_at, next_sequence, message_count, total_bytes, status, tombstone_expires_at, management_hash, owner_guest_id, creation_guest_id, owner_organization_id, owner_subject_id, links_revoked) VALUES (1, 6, 1, 1000, 2000, 604802000, 2592002000, 2, 1, 5, 'active', NULL, 'platform-management', 'platform-owner', 'platform-owner', 'platform-org', 'platform-subject', 0)").run();
  database.query("INSERT INTO messages (sequence, id, content, author, display_name, client, semantic_type, reply_to, created_at, client_message_id, byte_count, idempotency_key) VALUES (1, 'platform-message', 'hello', 'platform', 'Platform', NULL, 'message', NULL, 2_000, NULL, 5, 'platform-idempotency')").run();
  database.query("INSERT INTO room_acl (guest_id, source, capabilities, active, created_at, grant_id) VALUES ('platform-owner', 'owner', '[\"msg:read\",\"msg:write\"]', 1, 2_000, 'platform-grant')").run();
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

test("upgrades the Platform v6 schema and adds notification state", () => {
  const database = new Database(":memory:");
  createPlatformV6Schema(database);

  migrateRoomSchema(storage(database));

  expect(database.query("SELECT version FROM room_schema").get()).toEqual({ version: CURRENT_ROOM_SCHEMA_VERSION });
  expect(database.query("SELECT creation_guest_id, owner_guest_id, owner_organization_id, owner_subject_id, links_revoked, notification_id FROM room_state").get()).toEqual({
    creation_guest_id: "platform-owner",
    owner_guest_id: "platform-owner",
    owner_organization_id: "platform-org",
    owner_subject_id: "platform-subject",
    links_revoked: 0,
    notification_id: expect.any(String),
  });
  expect(database.query("SELECT capabilities, grant_id FROM room_acl WHERE guest_id = 'platform-owner' AND source = 'owner'").get()).toEqual({ capabilities: '["msg:read","msg:write"]', grant_id: "platform-grant" });
  expect(database.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('webhook_endpoints', 'webhook_deliveries', 'push_subscriptions', 'push_deliveries') ORDER BY name").all()).toEqual([
    { name: "push_deliveries" },
    { name: "push_subscriptions" },
    { name: "webhook_deliveries" },
    { name: "webhook_endpoints" },
  ]);
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

test("reconciles an authentic upstream v7 room without promoting a guest", async () => {
  const database = new Database(":memory:");
  createAuthenticUpstreamV7Schema(database);

  const { ConversationRoom } = await import("./conversation-room");
  const durable = new ConversationRoom(new DurableTestContext(database) as never, {} as never, () => 3_000);

  expect(database.query("SELECT version FROM room_schema").get()).toEqual({ version: CURRENT_ROOM_SCHEMA_VERSION });
  expect(database.query("SELECT creation_guest_id, owner_guest_id, owner_organization_id, owner_subject_id, links_revoked FROM room_state").get()).toEqual({
    creation_guest_id: null,
    owner_guest_id: null,
    owner_organization_id: null,
    owner_subject_id: null,
    links_revoked: 0,
  });
  expect(database.query("SELECT COUNT(*) AS count FROM room_acl").get()).toEqual({ count: 0 });
  expect(database.query("SELECT notification_id FROM room_state").get()).toEqual({ notification_id: "upstream-notification" });
  expect(database.query("SELECT id, url, secret, status, last_success_at FROM webhook_endpoints").get()).toEqual({ id: "upstream-endpoint", url: "https://receiver.example/events", secret: "upstream-secret", status: "active", last_success_at: 2_200 });
  expect(database.query("SELECT id, status, manual_redelivery_requested_at FROM webhook_deliveries").get()).toEqual({ id: "upstream-delivery", status: "delivered", manual_redelivery_requested_at: null });
  expect(database.query("SELECT delivery_id, attempt_number, status FROM webhook_delivery_attempts").get()).toEqual({ delivery_id: "upstream-delivery", attempt_number: 1, status: "delivered" });
  expect(database.query("SELECT id, source_browser_id FROM push_subscriptions").get()).toEqual({ id: "upstream-subscription", source_browser_id: "upstream-browser" });
  expect(database.query("SELECT id, status FROM push_deliveries").get()).toEqual({ id: "upstream-push-delivery", status: "delivered" });

  const recorded = await durable.fetch(new Request("https://room/access/record", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ guest_id: "upgraded-guest", source: "public", capabilities: ["msg:read", "msg:write"], grant_id: "upgraded-grant" }),
  }));
  expect(recorded.status).toBe(200);
  const grant = await durable.fetch(new Request("https://room/access/grant", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ guest_id: "upgraded-guest", source: "public", grant_id: "upgraded-grant" }),
  }));
  expect(grant.status).toBe(200);
  expect(await grant.json()).toEqual({ source: "public", grant_id: "upgraded-grant", capabilities: ["msg:read", "msg:write"], active: true });
  const read = await durable.fetch(new Request("https://room/read?resource=upgraded-room"));
  expect(read.status).toBe(200);
  expect((await read.json() as { messages: Array<{ id: string }> }).messages).toEqual([{ id: "upstream-message", content: "hello", author: "upstream", display_name: "Upstream", semantic_type: "message", identity_verified: false, created_at: "1970-01-01T00:00:02.000Z", sequence: 1, byte_count: 5 }]);
});
