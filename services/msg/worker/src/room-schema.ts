import { ROOM_LIMITS } from "./room-domain";
import { WEBHOOK_RETRY_INITIAL_DELAY_MS, WEBHOOK_RETRY_WINDOW_MS } from "./webhook-policy";

export const CURRENT_ROOM_SCHEMA_VERSION = 7;

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
    // Ownership and service-local participation are separate durable facts.
    // Legacy rows remain explicitly unowned until a valid link establishes a
    // participant grant; no visitor is promoted to owner by this migration.
    const columns = rows<{ name: string }>(sql.exec("PRAGMA table_info(room_state)"));
    if (!columns.some((column) => column.name === "owner_guest_id")) sql.exec("ALTER TABLE room_state ADD COLUMN owner_guest_id TEXT");
    if (!columns.some((column) => column.name === "notification_id")) sql.exec("ALTER TABLE room_state ADD COLUMN notification_id TEXT");
    const roomsWithoutNotificationId = rows<{ singleton: number }>(sql.exec("SELECT singleton FROM room_state WHERE notification_id IS NULL"));
    for (const room of roomsWithoutNotificationId) sql.exec("UPDATE room_state SET notification_id = ?, schema_version = ? WHERE singleton = ?", crypto.randomUUID(), CURRENT_ROOM_SCHEMA_VERSION, room.singleton);
    sql.exec(`
      CREATE TABLE IF NOT EXISTS room_acl (
        guest_id TEXT NOT NULL,
        source TEXT NOT NULL CHECK (source IN ('owner', 'public', 'management')),
        capabilities TEXT NOT NULL,
        active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
        created_at INTEGER NOT NULL,
        PRIMARY KEY (guest_id, source)
      );
      CREATE INDEX IF NOT EXISTS room_acl_room_guest ON room_acl(guest_id, source);
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
    return;
  }
  if (version === 5) {
    const columns = rows<{ name: string }>(sql.exec("PRAGMA table_info(room_acl)"));
    if (!columns.some((column) => column.name === "grant_id")) sql.exec("ALTER TABLE room_acl ADD COLUMN grant_id TEXT");
    const webhookTables = rows<{ name: string }>(sql.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'webhook_endpoints'"));
    if (webhookTables.length === 0) createVersionFourWebhookTables(sql);
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
    const columns = rows<{ name: string }>(sql.exec("PRAGMA table_info(room_state)"));
    if (!columns.some((column) => column.name === "creation_guest_id")) sql.exec("ALTER TABLE room_state ADD COLUMN creation_guest_id TEXT");
    if (!columns.some((column) => column.name === "owner_organization_id")) sql.exec("ALTER TABLE room_state ADD COLUMN owner_organization_id TEXT");
    if (!columns.some((column) => column.name === "owner_subject_id")) sql.exec("ALTER TABLE room_state ADD COLUMN owner_subject_id TEXT");
    if (!columns.some((column) => column.name === "links_revoked")) sql.exec("ALTER TABLE room_state ADD COLUMN links_revoked INTEGER NOT NULL DEFAULT 0 CHECK (links_revoked IN (0, 1))");
    sql.exec("UPDATE room_state SET creation_guest_id = owner_guest_id WHERE creation_guest_id IS NULL AND owner_guest_id IS NOT NULL");
    sql.exec(`
      CREATE TABLE IF NOT EXISTS claim_receipts (
        idempotency_key TEXT PRIMARY KEY,
        request_digest TEXT NOT NULL,
        original_guest_id TEXT NOT NULL,
        claimant_subject_id TEXT NOT NULL,
        organization_id TEXT NOT NULL,
        revoke_links INTEGER NOT NULL CHECK (revoke_links IN (0, 1)),
        claimed_at INTEGER NOT NULL
      )
    `);
    const webhookColumns = rows<{ name: string }>(sql.exec("PRAGMA table_info(webhook_deliveries)"));
    if (!webhookColumns.some((column) => column.name === "manual_redelivery_requested_at")) sql.exec("ALTER TABLE webhook_deliveries ADD COLUMN manual_redelivery_requested_at INTEGER");
    sql.exec("UPDATE room_state SET schema_version = ? WHERE singleton = 1", CURRENT_ROOM_SCHEMA_VERSION);
    return;
  }
  if (version === 7) {
    ensurePlatformSchemaAtV7(sql);
    ensureNotificationSchemaAtV7(sql);
    sql.exec("UPDATE room_state SET schema_version = ? WHERE singleton = 1", CURRENT_ROOM_SCHEMA_VERSION);
    return;
  }
  throw new Error("The room schema migration is not defined.");
}

/** Upstream notification releases used the same schema version numbers before
 * Platform ownership was added. Reconcile those durable rows before the
 * notification-only additions run so an upgrade never drops auth state. */
function ensurePlatformSchemaAtV7(sql: SqlStorage): void {
  const stateColumns = rows<{ name: string }>(sql.exec("PRAGMA table_info(room_state)"));
  if (!stateColumns.some((column) => column.name === "creation_guest_id")) sql.exec("ALTER TABLE room_state ADD COLUMN creation_guest_id TEXT");
  if (!stateColumns.some((column) => column.name === "owner_guest_id")) sql.exec("ALTER TABLE room_state ADD COLUMN owner_guest_id TEXT");
  if (!stateColumns.some((column) => column.name === "owner_organization_id")) sql.exec("ALTER TABLE room_state ADD COLUMN owner_organization_id TEXT");
  if (!stateColumns.some((column) => column.name === "owner_subject_id")) sql.exec("ALTER TABLE room_state ADD COLUMN owner_subject_id TEXT");
  if (!stateColumns.some((column) => column.name === "links_revoked")) sql.exec("ALTER TABLE room_state ADD COLUMN links_revoked INTEGER NOT NULL DEFAULT 0 CHECK (links_revoked IN (0, 1))");
  sql.exec("UPDATE room_state SET creation_guest_id = owner_guest_id WHERE creation_guest_id IS NULL AND owner_guest_id IS NOT NULL");
  sql.exec(`
    CREATE TABLE IF NOT EXISTS room_acl (
      guest_id TEXT NOT NULL,
      source TEXT NOT NULL CHECK (source IN ('owner', 'public', 'management')),
      capabilities TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
      created_at INTEGER NOT NULL,
      grant_id TEXT,
      PRIMARY KEY (guest_id, source)
    );
    CREATE INDEX IF NOT EXISTS room_acl_room_guest ON room_acl(guest_id, source);
    CREATE TABLE IF NOT EXISTS claim_receipts (
      idempotency_key TEXT PRIMARY KEY,
      request_digest TEXT NOT NULL,
      original_guest_id TEXT NOT NULL,
      claimant_subject_id TEXT NOT NULL,
      organization_id TEXT NOT NULL,
      revoke_links INTEGER NOT NULL CHECK (revoke_links IN (0, 1)),
      claimed_at INTEGER NOT NULL
    );
  `);
  const aclColumns = rows<{ name: string }>(sql.exec("PRAGMA table_info(room_acl)"));
  if (!aclColumns.some((column) => column.name === "grant_id")) sql.exec("ALTER TABLE room_acl ADD COLUMN grant_id TEXT");
}

function createVersionFourWebhookTables(sql: SqlStorage): void {
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
}

function ensureNotificationSchemaAtV7(sql: SqlStorage): void {
  const stateColumns = rows<{ name: string }>(sql.exec("PRAGMA table_info(room_state)"));
  if (!stateColumns.some((column) => column.name === "notification_id")) sql.exec("ALTER TABLE room_state ADD COLUMN notification_id TEXT");
  const roomsWithoutNotificationId = rows<{ singleton: number }>(sql.exec("SELECT singleton FROM room_state WHERE notification_id IS NULL"));
  for (const room of roomsWithoutNotificationId) sql.exec("UPDATE room_state SET notification_id = ? WHERE singleton = ?", crypto.randomUUID(), room.singleton);

  createVersionFourWebhookTables(sql);
  const endpointColumns = rows<{ name: string }>(sql.exec("PRAGMA table_info(webhook_endpoints)"));
  if (!endpointColumns.some((column) => column.name === "failure_started_at")) {
    sql.exec("ALTER TABLE webhook_endpoints RENAME TO webhook_endpoints_v4");
    sql.exec(`
      CREATE TABLE webhook_endpoints (
        id TEXT PRIMARY KEY, url TEXT NOT NULL, secret TEXT NOT NULL,
        created_at INTEGER NOT NULL, status TEXT NOT NULL CHECK(status IN ('active', 'disabled')),
        failure_started_at INTEGER, last_success_at INTEGER, last_failure_at INTEGER,
        recovered_at INTEGER, disabled_at INTEGER
      )
    `);
    sql.exec("INSERT INTO webhook_endpoints (id, url, secret, created_at, status) SELECT id, url, secret, created_at, status FROM webhook_endpoints_v4");
    sql.exec("DROP TABLE webhook_endpoints_v4");
  }
  const deliveryColumns = rows<{ name: string }>(sql.exec("PRAGMA table_info(webhook_deliveries)"));
  if (!deliveryColumns.some((column) => column.name === "retry_expires_at")) {
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
      INSERT INTO webhook_deliveries (id, endpoint_id, event_id, message_id, message_sequence, created_at, due_at, retry_expires_at, attempted_at, completed_at, lease_expires_at, cancelled_at, status, attempt_count, failure_category)
      SELECT id, endpoint_id, event_id, message_id, message_sequence, created_at, due_at, created_at + ${WEBHOOK_RETRY_WINDOW_MS}, attempted_at, completed_at, lease_expires_at, NULL, status, attempt_count, failure_category
      FROM webhook_deliveries_v4
    `);
    sql.exec("DROP TABLE webhook_deliveries_v4");
  }
  const currentDeliveryColumns = rows<{ name: string }>(sql.exec("PRAGMA table_info(webhook_deliveries)"));
  if (!currentDeliveryColumns.some((column) => column.name === "manual_redelivery_requested_at")) sql.exec("ALTER TABLE webhook_deliveries ADD COLUMN manual_redelivery_requested_at INTEGER");
  sql.exec(`
    CREATE TABLE IF NOT EXISTS webhook_delivery_attempts (
      delivery_id TEXT NOT NULL, attempt_number INTEGER NOT NULL,
      attempted_at INTEGER NOT NULL, completed_at INTEGER,
      status TEXT NOT NULL CHECK(status IN ('sending', 'delivered', 'failed')),
      failure_category TEXT,
      PRIMARY KEY (delivery_id, attempt_number)
    );
    CREATE INDEX IF NOT EXISTS webhook_deliveries_due ON webhook_deliveries(status, due_at, retry_expires_at, created_at);
    CREATE INDEX IF NOT EXISTS webhook_deliveries_endpoint ON webhook_deliveries(endpoint_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS webhook_deliveries_retention ON webhook_deliveries(created_at);
    CREATE INDEX IF NOT EXISTS webhook_delivery_attempts_delivery ON webhook_delivery_attempts(delivery_id, attempt_number);
  `);

  const messageColumns = rows<{ name: string }>(sql.exec("PRAGMA table_info(messages)"));
  if (!messageColumns.some((column) => column.name === "source_browser_id")) sql.exec("ALTER TABLE messages ADD COLUMN source_browser_id TEXT");
  sql.exec(`
    CREATE TABLE IF NOT EXISTS push_subscriptions (
      id TEXT PRIMARY KEY, source_browser_id TEXT NOT NULL UNIQUE,
      endpoint TEXT NOT NULL UNIQUE, p256dh TEXT NOT NULL, auth TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS push_deliveries (
      id TEXT PRIMARY KEY, subscription_id TEXT NOT NULL, event_id TEXT NOT NULL,
      message_id TEXT NOT NULL, message_sequence INTEGER NOT NULL,
      created_at INTEGER NOT NULL, due_at INTEGER NOT NULL, retry_expires_at INTEGER NOT NULL,
      attempted_at INTEGER, completed_at INTEGER, lease_expires_at INTEGER,
      status TEXT NOT NULL CHECK(status IN ('pending', 'sending', 'retrying', 'delivered', 'failed')),
      attempt_count INTEGER NOT NULL, failure_category TEXT
    );
    CREATE INDEX IF NOT EXISTS push_deliveries_due ON push_deliveries(status, due_at, retry_expires_at, created_at);
    CREATE INDEX IF NOT EXISTS push_deliveries_subscription ON push_deliveries(subscription_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS push_deliveries_retention ON push_deliveries(created_at);
  `);
}

function rows<T>(cursor: Iterable<unknown>): T[] { return [...cursor] as T[]; }
