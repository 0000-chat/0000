/**
 * The projection schema is deliberately versioned separately from SQLite's
 * user_version pragma. Durable Object SQLite storage can be re-entered after
 * an instance is evicted, so the migration table is the durable source of
 * schema truth.
 */

export type ProjectionMigration = {
  readonly version: number;
  readonly name: string;
  readonly appliedAt: string;
  readonly statements: readonly string[];
};

const initialTenantProjectionStatements = Object.freeze([
  `CREATE TABLE IF NOT EXISTS _sql_schema_migrations (
  version INTEGER PRIMARY KEY CHECK(version >= 1),
  name TEXT NOT NULL UNIQUE,
  applied_at TEXT NOT NULL
) STRICT`,
  `CREATE TABLE projection_meta (
  singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
  tenant_id TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL CHECK(state IN ('ready','rebuilding','rebuild_failed')),
  generation INTEGER NOT NULL CHECK(generation >= 1 AND generation <= 9007199254740991),
  rebuild_id TEXT,
  rebuild_started_at TEXT,
  last_completed_rebuild_id TEXT,
  last_failed_rebuild_id TEXT,
  last_rebuild_failure_code TEXT CHECK(last_rebuild_failure_code IS NULL OR last_rebuild_failure_code IN ('operator_abort','unsupported_archive','archive_gap','binding_conflict','validation_failed')),
  initialized_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT`,
  `CREATE TABLE connection_bindings (
  account_id TEXT PRIMARY KEY,
  connection_id TEXT NOT NULL UNIQUE,
  identity_id TEXT NOT NULL,
  platform TEXT NOT NULL
) STRICT`,
  `CREATE TABLE completed_rebuilds (
  rebuild_id TEXT PRIMARY KEY,
  generation INTEGER NOT NULL UNIQUE CHECK(generation >= 2 AND generation <= 9007199254740991),
  completed_at TEXT NOT NULL
) STRICT`,
  `CREATE TABLE failed_rebuilds (
  rebuild_id TEXT PRIMARY KEY,
  generation INTEGER NOT NULL UNIQUE CHECK(generation >= 2 AND generation <= 9007199254740991),
  failed_at TEXT NOT NULL,
  failure_code TEXT NOT NULL CHECK(failure_code IN ('operator_abort','unsupported_archive','archive_gap','binding_conflict','validation_failed'))
) STRICT`,
  `CREATE TABLE applied_events (
  event_id TEXT PRIMARY KEY,
  event_hash TEXT NOT NULL CHECK(length(event_hash) = 64),
  event_type TEXT NOT NULL,
  event_source TEXT NOT NULL,
  identity_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  observed_ms INTEGER NOT NULL CHECK(observed_ms BETWEEN -9007199254740991 AND 9007199254740991),
  generation INTEGER NOT NULL CHECK(generation >= 1)
) STRICT`,
  `CREATE TABLE conversations (
  id TEXT PRIMARY KEY,
  identity_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  platform TEXT NOT NULL,
  title TEXT NOT NULL,
  archived INTEGER NOT NULL CHECK(archived IN (0,1)),
  muted INTEGER NOT NULL CHECK(muted IN (0,1)),
  last_message_preview TEXT NOT NULL DEFAULT '',
  shell_activity_at TEXT NOT NULL,
  shell_activity_ms INTEGER NOT NULL,
  shell_activity_event_id TEXT NOT NULL,
  last_activity_at TEXT NOT NULL,
  last_activity_ms INTEGER NOT NULL,
  unread_count INTEGER NOT NULL DEFAULT 0 CHECK(unread_count >= 0),
  message_count INTEGER NOT NULL DEFAULT 0 CHECK(message_count >= 0),
  attachment_count INTEGER NOT NULL DEFAULT 0 CHECK(attachment_count >= 0),
  metadata_observed_ms INTEGER NOT NULL CHECK(metadata_observed_ms BETWEEN -9007199254740991 AND 9007199254740991),
  metadata_event_id TEXT NOT NULL,
  deleted_at TEXT,
  last_event_id TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT`,
  `CREATE TABLE participants (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  identity_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  platform TEXT NOT NULL,
  display_name TEXT NOT NULL,
  remote_id TEXT,
  avatar_url TEXT,
  last_observed_ms INTEGER NOT NULL,
  last_event_id TEXT NOT NULL,
  deleted_at TEXT
) STRICT`,
  `CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  identity_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  platform TEXT NOT NULL,
  direction TEXT NOT NULL CHECK(direction IN ('inbound','outbound')),
  sender_participant_id TEXT,
  sender_label TEXT NOT NULL,
  body TEXT NOT NULL,
  reply_to_message_id TEXT,
  delivery_status TEXT NOT NULL CHECK(delivery_status IN ('unknown','accepted','sent','delivered','read','failed')),
  unread INTEGER NOT NULL CHECK(unread IN (0,1)),
  local_read_at TEXT,
  occurred_at TEXT NOT NULL,
  occurred_ms INTEGER NOT NULL,
  observed_at TEXT NOT NULL,
  current_observed_ms INTEGER NOT NULL,
  current_event_id TEXT NOT NULL,
  matrix_room_id TEXT,
  matrix_event_id TEXT,
  remote_message_id TEXT,
  edited_at TEXT,
  deleted_at TEXT,
  deletion_reason TEXT,
  attachment_count INTEGER NOT NULL DEFAULT 0 CHECK(attachment_count >= 0),
  delivery_failure_code TEXT,
  delivery_observed_ms INTEGER,
  delivery_event_id TEXT
) STRICT`,
  `CREATE TABLE message_versions (
  event_id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL,
  identity_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  platform TEXT NOT NULL,
  version_kind TEXT NOT NULL CHECK(version_kind IN ('created','edited')),
  body TEXT NOT NULL,
  editor_participant_id TEXT,
  occurred_at TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  observed_ms INTEGER NOT NULL
) STRICT`,
  `CREATE TABLE reactions (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL,
  identity_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  platform TEXT NOT NULL,
  participant_id TEXT,
  emoji TEXT,
  occurred_at TEXT NOT NULL,
  last_observed_ms INTEGER NOT NULL,
  last_event_id TEXT NOT NULL,
  removed_at TEXT
) STRICT`,
  `CREATE TABLE receipts (
  message_id TEXT NOT NULL,
  participant_id TEXT NOT NULL,
  receipt_type TEXT NOT NULL CHECK(receipt_type IN ('read','delivered')),
  identity_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  platform TEXT NOT NULL,
  local_identity INTEGER NOT NULL CHECK(local_identity IN (0,1)),
  occurred_at TEXT NOT NULL,
  last_observed_ms INTEGER NOT NULL,
  last_event_id TEXT NOT NULL,
  PRIMARY KEY(message_id,participant_id,receipt_type)
) STRICT`,
  `CREATE TABLE typing_states (
  conversation_id TEXT NOT NULL,
  participant_id TEXT NOT NULL,
  identity_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  platform TEXT NOT NULL,
  is_typing INTEGER NOT NULL CHECK(is_typing IN (0,1)),
  expires_at TEXT,
  last_observed_ms INTEGER NOT NULL,
  last_event_id TEXT NOT NULL,
  PRIMARY KEY(conversation_id,participant_id)
) STRICT`,
  `CREATE TABLE attachments (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL,
  identity_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  platform TEXT NOT NULL,
  file_name TEXT,
  mime_type TEXT,
  size_bytes INTEGER CHECK(size_bytes IS NULL OR size_bytes >= 0),
  sha256 TEXT CHECK(sha256 IS NULL OR length(sha256) = 64),
  r2_key TEXT,
  observed_at TEXT NOT NULL,
  last_observed_ms INTEGER NOT NULL,
  last_event_id TEXT NOT NULL,
  deleted_at TEXT
) STRICT`,
  `CREATE TABLE commands (
  id TEXT PRIMARY KEY,
  identity_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  platform TEXT NOT NULL,
  operation TEXT NOT NULL CHECK(operation = 'message.send'),
  delivery_mode TEXT NOT NULL CHECK(delivery_mode IN ('direct','paced')),
  status TEXT NOT NULL CHECK(status IN ('accepted','scheduled','reading','typing','submitted_to_matrix','matrix_confirmed','bridged','delivered','cancelled','unsupported','failed')),
  failure_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_observed_ms INTEGER NOT NULL,
  last_event_id TEXT NOT NULL
) STRICT`,
  `CREATE TABLE message_delivery_updates (
  message_id TEXT PRIMARY KEY,
  identity_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  platform TEXT NOT NULL,
  delivery_status TEXT NOT NULL CHECK(delivery_status IN ('unknown','accepted','sent','delivered','read','failed')),
  failure_code TEXT,
  occurred_at TEXT NOT NULL,
  last_observed_ms INTEGER NOT NULL,
  last_event_id TEXT NOT NULL
) STRICT`,
  `CREATE TABLE event_tombstones (
  target_event_id TEXT PRIMARY KEY,
  tombstone_event_id TEXT NOT NULL UNIQUE,
  tombstone_type TEXT NOT NULL CHECK(tombstone_type IN ('replay.tombstone','correction.applied')),
  identity_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  platform TEXT NOT NULL,
  reason_code TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  observed_ms INTEGER NOT NULL
) STRICT`,
  `CREATE TABLE resource_tombstones (
  resource_type TEXT NOT NULL CHECK(resource_type IN ('message','conversation','participant','attachment')),
  resource_id TEXT NOT NULL,
  tombstone_event_id TEXT NOT NULL UNIQUE,
  identity_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  platform TEXT NOT NULL,
  reason_code TEXT,
  occurred_at TEXT NOT NULL,
  observed_ms INTEGER NOT NULL,
  PRIMARY KEY(resource_type,resource_id)
) STRICT`,
  `CREATE TABLE projection_changes (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL UNIQUE,
  event_type TEXT NOT NULL,
  identity_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  generation INTEGER NOT NULL CHECK(generation >= 1)
) STRICT`,
  `CREATE TABLE projection_change_floors (
  identity_id TEXT PRIMARY KEY,
  discarded_through_sequence INTEGER NOT NULL CHECK(discarded_through_sequence >= 0)
) STRICT`,
  `CREATE TABLE projection_checkpoints (
  kind TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  source_cursor TEXT,
  page_digest TEXT CHECK(page_digest IS NULL OR length(page_digest) = 64),
  last_observed_at TEXT,
  last_observed_ms INTEGER,
  last_event_id TEXT,
  generation INTEGER NOT NULL CHECK(generation >= 1),
  updated_at TEXT NOT NULL,
  last_applied_count INTEGER CHECK(last_applied_count IS NULL OR last_applied_count >= 0),
  last_duplicate_count INTEGER CHECK(last_duplicate_count IS NULL OR last_duplicate_count >= 0),
  last_sequence INTEGER CHECK(last_sequence IS NULL OR last_sequence >= 0)
) STRICT`,
  `CREATE INDEX idx_conversations_identity_activity ON conversations(identity_id,last_activity_ms DESC,id ASC)`,
  `CREATE INDEX idx_conversations_identity_connection_activity ON conversations(identity_id,connection_id,last_activity_ms DESC,id ASC)`,
  `CREATE INDEX idx_messages_identity_conversation_occurred ON messages(identity_id,conversation_id,occurred_ms DESC,id ASC)`,
  `CREATE INDEX idx_messages_matrix_event ON messages(matrix_event_id) WHERE matrix_event_id IS NOT NULL`,
  `CREATE INDEX idx_messages_remote_message ON messages(remote_message_id) WHERE remote_message_id IS NOT NULL`,
  `CREATE INDEX idx_message_versions_message_order ON message_versions(message_id,observed_ms DESC,event_id DESC)`,
  `CREATE INDEX idx_participants_conversation_name ON participants(conversation_id,display_name,id)`,
  `CREATE INDEX idx_reactions_message_state ON reactions(message_id,removed_at,occurred_at)`,
  `CREATE INDEX idx_receipts_message_type_time ON receipts(message_id,receipt_type,occurred_at)`,
  `CREATE INDEX idx_attachments_message_state ON attachments(message_id,deleted_at,id)`,
  `CREATE INDEX idx_delivery_message_order ON message_delivery_updates(message_id,last_observed_ms,last_event_id)`,
  `CREATE INDEX idx_applied_events_order ON applied_events(observed_ms,event_id)`,
  `CREATE INDEX idx_projection_changes_identity_sequence ON projection_changes(identity_id,sequence)`,
  `CREATE INDEX idx_resource_tombstones_resource_order ON resource_tombstones(resource_type,resource_id,observed_ms)`,
]);

const initialTenantProjectionMigration: ProjectionMigration = Object.freeze({
  version: 1,
  name: "initial_tenant_projection",
  appliedAt: "2026-09-07T00:00:00.000Z",
  statements: initialTenantProjectionStatements,
});

/** The complete immutable migration history for the projection database. */
export const PROJECTION_MIGRATIONS: readonly ProjectionMigration[] = Object.freeze([
  initialTenantProjectionMigration,
]);

/** Alias retained for callers that use the generic schema-migration name. */
export const SCHEMA_MIGRATIONS = PROJECTION_MIGRATIONS;

const migrationTableStatement = initialTenantProjectionStatements[0]!;

type AppliedMigrationRow = {
  version: number;
  name: string;
};

/**
 * Apply all missing schema migrations synchronously. This function intentionally
 * performs no I/O beyond the supplied SQLite storage and never consults wall
 * clock state. A migration's metadata row is inserted only after all of its
 * statements have succeeded in the same SQLite transaction.
 */
export function runProjectionMigrations(storage: DurableObjectStorage): void {
  storage.sql.exec(migrationTableStatement);

  const applied = storage.sql
    .exec<AppliedMigrationRow>(
      "SELECT version, name FROM _sql_schema_migrations ORDER BY version",
    )
    .toArray();
  const knownByVersion = new Map(
    PROJECTION_MIGRATIONS.map((migration) => [migration.version, migration]),
  );
  const latestVersion =
    PROJECTION_MIGRATIONS[PROJECTION_MIGRATIONS.length - 1]?.version ?? 0;

  for (const row of applied) {
    const migration = knownByVersion.get(row.version);
    if (migration === undefined) {
      if (row.version > latestVersion) {
        throw new Error("projection schema has an unknown newer version");
      }
      throw new Error("projection schema migration version mismatch");
    }
    if (row.name !== migration.name) {
      throw new Error("projection schema migration name mismatch");
    }
  }

  const appliedVersions = new Set(applied.map((row) => row.version));
  for (const migration of PROJECTION_MIGRATIONS) {
    if (appliedVersions.has(migration.version)) continue;

    storage.transactionSync(() => {
      for (const statement of migration.statements) {
        storage.sql.exec(statement);
      }
      storage.sql.exec(
        "INSERT INTO _sql_schema_migrations (version, name, applied_at) VALUES (?, ?, ?)",
        migration.version,
        migration.name,
        migration.appliedAt,
      );
    });
  }
}
