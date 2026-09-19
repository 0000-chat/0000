import { ROOM_LIMITS } from "./room-domain";

export const CURRENT_ROOM_SCHEMA_VERSION = 6;

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
    `);
    return;
  }
  if (version === 5) {
    const columns = rows<{ name: string }>(sql.exec("PRAGMA table_info(room_acl)"));
    if (!columns.some((column) => column.name === "grant_id")) sql.exec("ALTER TABLE room_acl ADD COLUMN grant_id TEXT");
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
      );
    `);
    return;
  }
  throw new Error("The room schema migration is not defined.");
}

function rows<T>(cursor: Iterable<unknown>): T[] { return [...cursor] as T[]; }
