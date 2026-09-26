import { ROOM_LIMITS } from "./room-domain";
import { WEBHOOK_RETRY_INITIAL_DELAY_MS, WEBHOOK_RETRY_WINDOW_MS } from "./webhook-policy";

export const CURRENT_ROOM_SCHEMA_VERSION = 17;

interface SqlStorage {
  exec(query: string, ...values: unknown[]): Iterable<unknown>;
}

interface TransactionalStorage {
  readonly sql: SqlStorage;
  transactionSync<T>(callback: () => T): T;
}

/** Applies only forward, ordered SQLite migrations. Future data fails closed. */
export function migrateRoomSchema(storage: TransactionalStorage, inactivityTtlMs = ROOM_LIMITS.inactivityTtlMs, now = Date.now()): void {
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
      applyMigration(storage.sql, next, inactivityTtlMs, now);
      storage.sql.exec("UPDATE room_schema SET version = ? WHERE singleton = 1", next);
      version = next;
    }
  });
}

function applyMigration(sql: SqlStorage, version: number, inactivityTtlMs: number, now: number): void {
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
    ensureVersionFourSchema(sql);
    return;
  }
  if (version === 5) {
    // The old standalone Worker also used room_schema version 4, but its v4
    // migration created name tables instead of these webhook tables. When a
    // room crosses into this Worker, bootstrap this Worker's v4 shape before
    // applying the ordered v5 migration.
    if (!tableExists(sql, "webhook_endpoints") || !tableExists(sql, "webhook_deliveries")) ensureVersionFourSchema(sql);
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
    sql.exec("UPDATE room_state SET schema_version = ? WHERE singleton = 1", CURRENT_ROOM_SCHEMA_VERSION);
    return;
  }
  if (version === 9) {
    const columns = new Set(rows<{ name: string }>(sql.exec("PRAGMA table_info(room_state)")).map((column) => column.name));
    if (!columns.has("coordination_cursor")) sql.exec("ALTER TABLE room_state ADD COLUMN coordination_cursor INTEGER NOT NULL DEFAULT 0");
    if (!columns.has("published_revision")) sql.exec("ALTER TABLE room_state ADD COLUMN published_revision INTEGER NOT NULL DEFAULT 0");
    sql.exec(`
      CREATE TABLE IF NOT EXISTS coordination_proposals (
        proposal_id TEXT NOT NULL, revision INTEGER NOT NULL, request_id TEXT,
        kind TEXT NOT NULL, actor_label TEXT NOT NULL, authority_class TEXT NOT NULL CHECK(authority_class IN ('participant', 'management')),
        base_revision INTEGER NOT NULL, source_message_ids TEXT NOT NULL, body TEXT NOT NULL,
        created_at INTEGER NOT NULL, byte_count INTEGER NOT NULL,
        PRIMARY KEY (proposal_id, revision)
      );
      CREATE INDEX IF NOT EXISTS coordination_proposals_cursor ON coordination_proposals(created_at, proposal_id, revision);
      CREATE INDEX IF NOT EXISTS coordination_proposals_request ON coordination_proposals(request_id, revision);
      CREATE TABLE IF NOT EXISTS coordination_requests (
        request_id TEXT PRIMARY KEY, published_revision INTEGER NOT NULL,
        purpose TEXT NOT NULL, title TEXT NOT NULL, owner_label TEXT NOT NULL,
        requested_output TEXT NOT NULL, unknowns TEXT NOT NULL, completion_criteria TEXT NOT NULL,
        decision_impact TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('open', 'in_progress', 'blocked', 'done', 'withdrawn')),
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, byte_count INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS coordination_requests_revision ON coordination_requests(published_revision, request_id);
      CREATE TABLE IF NOT EXISTS coordination_events (
        cursor INTEGER PRIMARY KEY, event_id TEXT NOT NULL UNIQUE, operation TEXT NOT NULL,
        proposal_id TEXT, proposal_revision INTEGER, request_id TEXT,
        kind TEXT NOT NULL, actor_label TEXT NOT NULL, authority_class TEXT NOT NULL CHECK(authority_class IN ('participant', 'management')),
        source_message_ids TEXT NOT NULL, base_revision INTEGER NOT NULL, resulting_revision INTEGER,
        body TEXT NOT NULL, created_at INTEGER NOT NULL, byte_count INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS coordination_events_request ON coordination_events(request_id, cursor);
      CREATE TABLE IF NOT EXISTS coordination_retries (
        operation TEXT NOT NULL, retry_id TEXT NOT NULL, fingerprint TEXT NOT NULL,
        receipt TEXT NOT NULL, created_at INTEGER NOT NULL, byte_count INTEGER NOT NULL,
        PRIMARY KEY (operation, retry_id)
      );
    `);
    sql.exec("UPDATE room_state SET schema_version = ? WHERE singleton = 1", CURRENT_ROOM_SCHEMA_VERSION);
    return;
  }
  if (version === 10) {
    sql.exec(`
      CREATE TABLE IF NOT EXISTS coordination_panel (
        singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
        published_revision INTEGER NOT NULL,
        proposal_id TEXT NOT NULL,
        proposal_revision INTEGER NOT NULL,
        purpose TEXT,
        phase TEXT,
        artifacts TEXT NOT NULL,
        next_actions TEXT NOT NULL,
        source_message_ids TEXT NOT NULL,
        owner_label TEXT NOT NULL,
        published_at INTEGER NOT NULL,
        byte_count INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS coordination_events_panel ON coordination_events(operation, resulting_revision, cursor);
    `);
    sql.exec("UPDATE room_state SET schema_version = ? WHERE singleton = 1", CURRENT_ROOM_SCHEMA_VERSION);
    return;
  }
  if (version === 11) {
    sql.exec(`
      CREATE TABLE IF NOT EXISTS coordination_decisions (
        decision_id TEXT PRIMARY KEY,
        latest_proposal_revision INTEGER NOT NULL,
        title TEXT NOT NULL,
        proposal_text TEXT NOT NULL,
        required_approver_labels TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('recommended', 'accepted')),
        recommendation_cursor INTEGER NOT NULL,
        recommendation_published_revision INTEGER NOT NULL,
        accepted_record_id TEXT,
        updated_at INTEGER NOT NULL,
        byte_count INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS coordination_decisions_state ON coordination_decisions(state, recommendation_published_revision, decision_id);
      CREATE TABLE IF NOT EXISTS coordination_decision_positions (
        position_id TEXT PRIMARY KEY,
        decision_id TEXT NOT NULL,
        decision_revision INTEGER NOT NULL,
        participant_label TEXT NOT NULL,
        reporter_label TEXT NOT NULL,
        statement TEXT NOT NULL,
        source_message_ids TEXT NOT NULL,
        published_cursor INTEGER NOT NULL,
        published_revision INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        byte_count INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS coordination_decision_positions_decision ON coordination_decision_positions(decision_id, published_cursor, position_id);
      CREATE TABLE IF NOT EXISTS coordination_decision_accepted_records (
        accepted_record_id TEXT PRIMARY KEY,
        decision_id TEXT NOT NULL,
        decision_revision INTEGER NOT NULL,
        proposal_snapshot TEXT NOT NULL,
        required_approver_labels TEXT NOT NULL,
        owner_label TEXT NOT NULL,
        owner_attestation INTEGER NOT NULL CHECK(owner_attestation = 1),
        publication_cursor INTEGER NOT NULL,
        publication_revision INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        byte_count INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS coordination_decision_accepted_records_decision ON coordination_decision_accepted_records(decision_id, publication_revision, accepted_record_id);
      CREATE TABLE IF NOT EXISTS coordination_decision_approval_evidence (
        approval_record_id TEXT PRIMARY KEY,
        accepted_record_id TEXT NOT NULL,
        decision_id TEXT NOT NULL,
        decision_revision INTEGER NOT NULL,
        participant_label TEXT NOT NULL,
        source_message_id TEXT NOT NULL,
        source_author TEXT NOT NULL,
        source_display_name TEXT NOT NULL,
        source_sequence INTEGER NOT NULL,
        source_created_at INTEGER NOT NULL,
        byte_count INTEGER NOT NULL,
        UNIQUE (accepted_record_id, participant_label),
        UNIQUE (accepted_record_id, source_message_id)
      );
      CREATE INDEX IF NOT EXISTS coordination_decision_approval_evidence_source ON coordination_decision_approval_evidence(source_message_id);
    `);
    sql.exec("UPDATE room_state SET schema_version = ? WHERE singleton = 1", CURRENT_ROOM_SCHEMA_VERSION);
    return;
  }
  if (version === 12) {
    sql.exec(`
      CREATE TABLE IF NOT EXISTS coordination_corrections (
        correction_id TEXT PRIMARY KEY,
        proposal_id TEXT NOT NULL,
        proposal_revision INTEGER NOT NULL,
        target TEXT NOT NULL,
        correction_text TEXT NOT NULL,
        reporter_label TEXT NOT NULL,
        owner_label TEXT NOT NULL,
        source_message_ids TEXT NOT NULL,
        publication_cursor INTEGER NOT NULL,
        publication_revision INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        byte_count INTEGER NOT NULL,
        UNIQUE (proposal_id, proposal_revision)
      );
      CREATE INDEX IF NOT EXISTS coordination_corrections_publication ON coordination_corrections(publication_revision, correction_id);
      CREATE INDEX IF NOT EXISTS coordination_corrections_target_message ON coordination_corrections(json_extract(target, '$.message_id'));
      CREATE INDEX IF NOT EXISTS coordination_corrections_target_publication ON coordination_corrections(json_extract(target, '$.published_revision'));
      CREATE TABLE IF NOT EXISTS coordination_disputes (
        report_id TEXT PRIMARY KEY,
        accepted_record_id TEXT NOT NULL,
        decision_id TEXT NOT NULL,
        decision_revision INTEGER NOT NULL,
        kind TEXT NOT NULL CHECK(kind IN ('dispute', 'approval_withdrawal')),
        actor_label TEXT NOT NULL,
        statement TEXT NOT NULL,
        source_message_ids TEXT NOT NULL,
        approval_record_id TEXT,
        cursor INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        byte_count INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS coordination_disputes_record ON coordination_disputes(accepted_record_id, cursor, report_id);
      CREATE TABLE IF NOT EXISTS coordination_dispute_reviews (
        review_id TEXT PRIMARY KEY,
        report_id TEXT NOT NULL,
        owner_label TEXT NOT NULL,
        base_revision INTEGER NOT NULL,
        disposition TEXT NOT NULL CHECK(disposition IN ('acknowledged', 'rejected')),
        rationale TEXT NOT NULL,
        source_message_ids TEXT NOT NULL,
        cursor INTEGER NOT NULL,
        publication_revision INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        byte_count INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS coordination_dispute_reviews_report ON coordination_dispute_reviews(report_id, cursor, review_id);
      CREATE TABLE IF NOT EXISTS coordination_supersessions (
        supersession_id TEXT PRIMARY KEY,
        proposal_id TEXT NOT NULL,
        proposal_revision INTEGER NOT NULL,
        predecessor_accepted_record_id TEXT NOT NULL,
        successor_decision_id TEXT NOT NULL,
        successor_decision_revision INTEGER NOT NULL,
        predecessor_publication_revision INTEGER NOT NULL,
        reporter_label TEXT NOT NULL,
        owner_label TEXT NOT NULL,
        source_message_ids TEXT NOT NULL,
        publication_cursor INTEGER NOT NULL,
        publication_revision INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        byte_count INTEGER NOT NULL,
        UNIQUE (predecessor_accepted_record_id),
        UNIQUE (proposal_id, proposal_revision)
      );
      CREATE INDEX IF NOT EXISTS coordination_supersessions_successor ON coordination_supersessions(successor_decision_id, successor_decision_revision, publication_revision);
    `);
    sql.exec("UPDATE room_state SET schema_version = ? WHERE singleton = 1", CURRENT_ROOM_SCHEMA_VERSION);
    return;
  }
  if (version === 13) {
    // Name claims are not inferred from messages. Historical names without an
    // existing claim become legacy, while claims stored by an older Worker
    // retain their password protection.
    sql.exec(`
      CREATE TABLE IF NOT EXISTS name_claims (
        normalized_name TEXT PRIMARY KEY,
        password_hash TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS name_claims_password ON name_claims(password_hash);
      CREATE TABLE IF NOT EXISTS legacy_names (
        normalized_name TEXT PRIMARY KEY
      );
    `);
    const claimedNames = new Set(rows<{ normalized_name: string }>(sql.exec("SELECT normalized_name FROM name_claims")).map(({ normalized_name }) => normalized_name));
    const legacyNames = new Set<string>();
    for (const message of rows<{ author: string; display_name: string }>(sql.exec("SELECT author, display_name FROM messages"))) {
      for (const value of [message.author, message.display_name]) {
        const normalized = normalizeLegacyName(value);
        if (normalized && !claimedNames.has(normalized)) legacyNames.add(normalized);
      }
    }
    for (const name of legacyNames) sql.exec("INSERT OR IGNORE INTO legacy_names (normalized_name) VALUES (?)", name);
    sql.exec("UPDATE room_state SET schema_version = ? WHERE singleton = 1", CURRENT_ROOM_SCHEMA_VERSION);
    return;
  }
  if (version === 14) {
    // Keep the v13 table shape on this upgrade path. Some deployed schema 14
    // rooms already removed these fields; migration 15 restores them.
    return;
  }
  if (version === 15) {
    // Schema 14 removed these fields, but this Worker still supports delegated
    // posting. Restore them with posting disabled when a room crossed that
    // schema before this compatibility release.
    const columns = new Set(rows<{ name: string }>(sql.exec("PRAGMA table_info(room_state)")).map((column) => column.name));
    if (!columns.has("get_post_hash")) sql.exec("ALTER TABLE room_state ADD COLUMN get_post_hash TEXT");
    if (!columns.has("get_post_enabled")) sql.exec("ALTER TABLE room_state ADD COLUMN get_post_enabled INTEGER NOT NULL DEFAULT 0");
    sql.exec("UPDATE room_state SET schema_version = ? WHERE singleton = 1", CURRENT_ROOM_SCHEMA_VERSION);
    return;
  }
  if (version === 16) {
    // Version numbers from older deployments do not guarantee that every
    // coordination table exists. Reapply the idempotent table migrations so
    // rooms with a higher recorded version recover missing additive schema.
    for (const compatibilityVersion of [9, 10, 11, 12]) {
      applyMigration(sql, compatibilityVersion, inactivityTtlMs, now);
    }
    return;
  }
  if (version === 17) {
    const columns = new Set(rows<{ name: string }>(sql.exec("PRAGMA table_info(room_state)")).map((column) => column.name));
    if (!columns.has("mcp_post_enabled")) sql.exec("ALTER TABLE room_state ADD COLUMN mcp_post_enabled INTEGER NOT NULL DEFAULT 1");
    sql.exec("UPDATE room_state SET mcp_post_enabled = CASE WHEN status = 'active' AND inactivity_expires_at > ? THEN 1 ELSE 0 END WHERE singleton = 1", now);
    sql.exec("UPDATE room_state SET schema_version = ? WHERE singleton = 1", CURRENT_ROOM_SCHEMA_VERSION);
    return;
  }
  throw new Error("The room schema migration is not defined.");
}

function rows<T>(cursor: Iterable<unknown>): T[] { return [...cursor] as T[]; }
function tableExists(sql: SqlStorage, name: string): boolean {
  return rows<{ name: string }>(sql.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?", name)).length > 0;
}
function ensureVersionFourSchema(sql: SqlStorage): void {
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
}
function normalizeLegacyName(value: string): string { return value.trim().toLowerCase(); }
