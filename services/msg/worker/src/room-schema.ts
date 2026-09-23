import { ROOM_LIMITS } from "./room-domain";
import { WEBHOOK_RETRY_INITIAL_DELAY_MS, WEBHOOK_RETRY_WINDOW_MS } from "./webhook-policy";

export const CURRENT_ROOM_SCHEMA_VERSION = 9;

interface SqlStorage {
  exec(query: string, ...values: unknown[]): Iterable<unknown>;
}

interface TransactionalStorage {
  readonly sql: SqlStorage;
  transactionSync<T>(callback: () => T): T;
}

/** Applies only forward, ordered SQLite migrations. Future data fails closed. */
export function migrateRoomSchema(storage: TransactionalStorage, inactivityTtlMs = ROOM_LIMITS.inactivityTtlMs): void {
  storage.sql.exec("CREATE TABLE IF NOT EXISTS room_schema (singleton INTEGER PRIMARY KEY CHECK(singleton = 1), version INTEGER NOT NULL)");
  storage.transactionSync(() => {
    const versionRow = rows<{ version: number }>(storage.sql.exec("SELECT version FROM room_schema WHERE singleton = 1"))[0];
    let version = versionRow?.version;
    if (version === undefined) {
      const legacy = rows<{ name: string }>(storage.sql.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'room_state'"))[0];
      version = legacy ? 1 : 0;
      storage.sql.exec("INSERT INTO room_schema (singleton, version) VALUES (1, ?)", version);
    }
    if (version > CURRENT_ROOM_SCHEMA_VERSION) throw new Error("The room schema is newer than this Worker supports.");
    while (version < CURRENT_ROOM_SCHEMA_VERSION) {
      const next = version + 1;
      applyMigration(storage.sql, next, inactivityTtlMs);
      storage.sql.exec("UPDATE room_schema SET version = ? WHERE singleton = 1", next);
      version = next;
    }
  });
}

function applyMigration(sql: SqlStorage, version: number, inactivityTtlMs: number): void {
  if (version === 1) {
    sql.exec(`
      CREATE TABLE IF NOT EXISTS room_state (
        singleton INTEGER PRIMARY KEY CHECK(singleton = 1), schema_version INTEGER NOT NULL,
        protocol_version INTEGER NOT NULL, created_at INTEGER NOT NULL, last_message_at INTEGER NOT NULL,
        inactivity_expires_at INTEGER NOT NULL, absolute_expires_at INTEGER NOT NULL,
        next_sequence INTEGER NOT NULL, message_count INTEGER NOT NULL, total_bytes INTEGER NOT NULL,
        status TEXT NOT NULL, tombstone_expires_at INTEGER, management_hash TEXT
      );
      CREATE TABLE IF NOT EXISTS messages (
        sequence INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE, content TEXT NOT NULL, author TEXT NOT NULL,
        display_name TEXT NOT NULL, client TEXT, semantic_type TEXT NOT NULL, reply_to TEXT,
        created_at INTEGER NOT NULL, client_message_id TEXT UNIQUE, byte_count INTEGER NOT NULL
      );
    `);
    return;
  }
  if (version === 2) {
    sql.exec("ALTER TABLE messages ADD COLUMN idempotency_key TEXT");
    sql.exec("CREATE UNIQUE INDEX IF NOT EXISTS messages_idempotency_key ON messages(idempotency_key)");
    return;
  }
  if (version === 3) {
    // Existing rooms stored inactivity_expires_at as the minimum of the
    // seven-day idle deadline and the old absolute deadline. Rebuild the
    // activity deadline from the durable last message so that a recent post
    // can keep a room alive beyond the old cap. Keep the legacy column in
    // place for SQLite compatibility, but no runtime path reads it.
    sql.exec(
      "UPDATE room_state SET schema_version = ?, inactivity_expires_at = last_message_at + ? WHERE status = 'active'",
      CURRENT_ROOM_SCHEMA_VERSION,
      inactivityTtlMs,
    );
    sql.exec("UPDATE room_state SET schema_version = ? WHERE status <> 'active'", CURRENT_ROOM_SCHEMA_VERSION);
    return;
  }
  if (version === 4) {
    const columns = rows<{ name: string }>(sql.exec("PRAGMA table_info(room_state)"));
    if (!columns.some((column) => column.name === "notification_id")) sql.exec("ALTER TABLE room_state ADD COLUMN notification_id TEXT");
    const roomsWithoutNotificationId = rows<{ singleton: number }>(sql.exec("SELECT singleton FROM room_state WHERE notification_id IS NULL"));
    for (const room of roomsWithoutNotificationId) sql.exec("UPDATE room_state SET notification_id = ?, schema_version = ? WHERE singleton = ?", crypto.randomUUID(), CURRENT_ROOM_SCHEMA_VERSION, room.singleton);
    sql.exec(`
      CREATE TABLE IF NOT EXISTS webhook_endpoints (
        id TEXT PRIMARY KEY, url TEXT NOT NULL, secret TEXT NOT NULL,
        created_at INTEGER NOT NULL, status TEXT NOT NULL CHECK(status = 'active')
      );
      CREATE TABLE IF NOT EXISTS webhook_deliveries (
        id TEXT PRIMARY KEY, endpoint_id TEXT NOT NULL, event_id TEXT NOT NULL,
        message_id TEXT NOT NULL, message_sequence INTEGER NOT NULL,
        created_at INTEGER NOT NULL, due_at INTEGER NOT NULL,
        attempted_at INTEGER, completed_at INTEGER, lease_expires_at INTEGER,
        status TEXT NOT NULL CHECK(status IN ('pending', 'sending', 'delivered', 'failed')),
        attempt_count INTEGER NOT NULL, failure_category TEXT
      );
      CREATE INDEX IF NOT EXISTS webhook_deliveries_due ON webhook_deliveries(status, due_at, created_at);
      CREATE INDEX IF NOT EXISTS webhook_deliveries_endpoint ON webhook_deliveries(endpoint_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS webhook_deliveries_retention ON webhook_deliveries(created_at);
    `);
    sql.exec("UPDATE room_state SET schema_version = ? WHERE singleton = 1", CURRENT_ROOM_SCHEMA_VERSION);
    return;
  }
  if (version === 5) {
    sql.exec("ALTER TABLE webhook_endpoints RENAME TO webhook_endpoints_v4");
    sql.exec(`
      CREATE TABLE webhook_endpoints (
        id TEXT PRIMARY KEY, url TEXT NOT NULL, secret TEXT NOT NULL,
        created_at INTEGER NOT NULL, status TEXT NOT NULL CHECK(status IN ('active', 'disabled')),
        failure_started_at INTEGER, last_success_at INTEGER, last_failure_at INTEGER,
        recovered_at INTEGER, disabled_at INTEGER
      )
    `);
    sql.exec(`
      INSERT INTO webhook_endpoints (id, url, secret, created_at, status)
      SELECT id, url, secret, created_at, status FROM webhook_endpoints_v4
    `);
    sql.exec("DROP TABLE webhook_endpoints_v4");

    sql.exec("ALTER TABLE webhook_deliveries RENAME TO webhook_deliveries_v4");
    sql.exec(`
      CREATE TABLE webhook_deliveries (
        id TEXT PRIMARY KEY, endpoint_id TEXT NOT NULL, event_id TEXT NOT NULL,
        message_id TEXT NOT NULL, message_sequence INTEGER NOT NULL,
        created_at INTEGER NOT NULL, due_at INTEGER NOT NULL, retry_expires_at INTEGER NOT NULL,
        attempted_at INTEGER, completed_at INTEGER, lease_expires_at INTEGER, cancelled_at INTEGER,
        status TEXT NOT NULL CHECK(status IN ('pending', 'sending', 'retrying', 'delivered', 'failed', 'cancelled')),
        attempt_count INTEGER NOT NULL, failure_category TEXT
      )
    `);
    sql.exec(`
      INSERT INTO webhook_deliveries (
        id, endpoint_id, event_id, message_id, message_sequence, created_at, due_at,
        retry_expires_at, attempted_at, completed_at, lease_expires_at, cancelled_at,
        status, attempt_count, failure_category
      )
      SELECT id, endpoint_id, event_id, message_id, message_sequence, created_at, due_at,
        created_at + ${WEBHOOK_RETRY_WINDOW_MS}, attempted_at, completed_at, lease_expires_at, NULL,
        status, attempt_count, failure_category
      FROM webhook_deliveries_v4
    `);
    sql.exec("DROP TABLE webhook_deliveries_v4");

    sql.exec(`
      CREATE TABLE webhook_delivery_attempts (
        delivery_id TEXT NOT NULL, attempt_number INTEGER NOT NULL,
        attempted_at INTEGER NOT NULL, completed_at INTEGER,
        status TEXT NOT NULL CHECK(status IN ('sending', 'delivered', 'failed')),
        failure_category TEXT,
        PRIMARY KEY (delivery_id, attempt_number)
      )
    `);
    sql.exec(`
      INSERT INTO webhook_delivery_attempts (
        delivery_id, attempt_number, attempted_at, completed_at, status, failure_category
      )
      SELECT id, attempt_count, COALESCE(attempted_at, created_at), completed_at,
        CASE status WHEN 'delivered' THEN 'delivered' WHEN 'failed' THEN 'failed' ELSE 'sending' END,
        failure_category
      FROM webhook_deliveries
      WHERE attempt_count > 0
    `);
    sql.exec(`
      UPDATE webhook_endpoints
      SET last_success_at = (
            SELECT MAX(attempts.completed_at) FROM webhook_delivery_attempts AS attempts
            JOIN webhook_deliveries AS deliveries ON deliveries.id = attempts.delivery_id
            WHERE deliveries.endpoint_id = webhook_endpoints.id AND attempts.status = 'delivered'
          ),
          last_failure_at = (
            SELECT MAX(attempts.completed_at) FROM webhook_delivery_attempts AS attempts
            JOIN webhook_deliveries AS deliveries ON deliveries.id = attempts.delivery_id
            WHERE deliveries.endpoint_id = webhook_endpoints.id AND attempts.status = 'failed'
          ),
          failure_started_at = (
            SELECT MIN(attempts.completed_at) FROM webhook_delivery_attempts AS attempts
            JOIN webhook_deliveries AS deliveries ON deliveries.id = attempts.delivery_id
            WHERE deliveries.endpoint_id = webhook_endpoints.id AND attempts.status = 'failed'
              AND attempts.completed_at > COALESCE((
                SELECT MAX(success.completed_at) FROM webhook_delivery_attempts AS success
                JOIN webhook_deliveries AS success_deliveries ON success_deliveries.id = success.delivery_id
                WHERE success_deliveries.endpoint_id = webhook_endpoints.id AND success.status = 'delivered'
              ), -1)
          ),
          recovered_at = CASE WHEN (
            SELECT MAX(failure.completed_at) FROM webhook_delivery_attempts AS failure
            JOIN webhook_deliveries AS failure_deliveries ON failure_deliveries.id = failure.delivery_id
            WHERE failure_deliveries.endpoint_id = webhook_endpoints.id AND failure.status = 'failed'
          ) < (
            SELECT MAX(success.completed_at) FROM webhook_delivery_attempts AS success
            JOIN webhook_deliveries AS success_deliveries ON success_deliveries.id = success.delivery_id
            WHERE success_deliveries.endpoint_id = webhook_endpoints.id AND success.status = 'delivered'
          ) THEN (
            SELECT MAX(success.completed_at) FROM webhook_delivery_attempts AS success
            JOIN webhook_deliveries AS success_deliveries ON success_deliveries.id = success.delivery_id
            WHERE success_deliveries.endpoint_id = webhook_endpoints.id AND success.status = 'delivered'
          ) ELSE NULL END
    `);
    sql.exec(
      `UPDATE webhook_deliveries SET status = 'retrying', due_at = COALESCE(completed_at, attempted_at, created_at) + ? WHERE status = 'failed' AND attempt_count > 0`,
      WEBHOOK_RETRY_INITIAL_DELAY_MS,
    );
    sql.exec("CREATE INDEX webhook_deliveries_due ON webhook_deliveries(status, due_at, retry_expires_at, created_at)");
    sql.exec("CREATE INDEX webhook_deliveries_endpoint ON webhook_deliveries(endpoint_id, created_at DESC)");
    sql.exec("CREATE INDEX webhook_deliveries_retention ON webhook_deliveries(created_at)");
    sql.exec("CREATE INDEX webhook_delivery_attempts_delivery ON webhook_delivery_attempts(delivery_id, attempt_number)");
    sql.exec("UPDATE room_state SET schema_version = ? WHERE singleton = 1", CURRENT_ROOM_SCHEMA_VERSION);
    return;
  }
  if (version === 6) {
    sql.exec("ALTER TABLE webhook_deliveries ADD COLUMN manual_redelivery_requested_at INTEGER");
    sql.exec("UPDATE room_state SET schema_version = ? WHERE singleton = 1", CURRENT_ROOM_SCHEMA_VERSION);
    return;
  }
  if (version === 7) {
    sql.exec("ALTER TABLE messages ADD COLUMN source_browser_id TEXT");
    sql.exec(`
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
    sql.exec("UPDATE room_state SET schema_version = ? WHERE singleton = 1", CURRENT_ROOM_SCHEMA_VERSION);
    return;
  }
  if (version === 8) {
    const columns = new Set(rows<{ name: string }>(sql.exec("PRAGMA table_info(room_state)")).map((column) => column.name));
    if (!columns.has("get_post_hash")) sql.exec("ALTER TABLE room_state ADD COLUMN get_post_hash TEXT");
    if (!columns.has("get_post_enabled")) sql.exec("ALTER TABLE room_state ADD COLUMN get_post_enabled INTEGER NOT NULL DEFAULT 0");
    sql.exec("UPDATE room_state SET schema_version = ?", CURRENT_ROOM_SCHEMA_VERSION);
    return;
  }
  if (version === 9) {
    // Anonymous MCP posting is an independent room setting. Existing active
    // rooms were historically represented by get_post_enabled, which also
    // guarded the secret delegated GET capability. Default the new setting on
    // for every room and make the active-room intent explicit for the lazy
    // migration path; the delegated hash and flag remain untouched.
    const columns = new Set(rows<{ name: string }>(sql.exec("PRAGMA table_info(room_state)")).map((column) => column.name));
    if (!columns.has("mcp_post_enabled")) sql.exec("ALTER TABLE room_state ADD COLUMN mcp_post_enabled INTEGER NOT NULL DEFAULT 1");
    sql.exec("UPDATE room_state SET mcp_post_enabled = 1 WHERE status = 'active'");
    sql.exec("UPDATE room_state SET schema_version = ?", CURRENT_ROOM_SCHEMA_VERSION);
    return;
  }
  throw new Error("The room schema migration is not defined.");
}

function rows<T>(cursor: Iterable<unknown>): T[] { return [...cursor] as T[]; }
