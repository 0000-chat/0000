//! Crash-safe gateway state-store foundation.
//!
//! This module owns the gateway SQLite connection and its process-wide lock.
//! The connection is deliberately private: higher-level gateway code will add
//! domain transactions here rather than passing a raw connection around.

use std::{
    fmt,
    fs::{File, OpenOptions, symlink_metadata},
    os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt},
    path::Path,
    time::Duration,
};

use rusqlite::{Connection, OptionalExtension};
use rustix::fs::{FlockOperation, OFlags, flock};

use crate::config::GATEWAY_SCHEMA_VERSION;

/// The database lock is kept beside the database and has this extension.
pub const STORE_LOCK_EXTENSION: &str = "lock";

/// Stable error returned by state-store operations.
///
/// Only the fixed code is retained. In particular, no SQLite message, path,
/// SQL statement, or secret-bearing value is ever stored or formatted.
#[derive(Clone, Copy, Eq, PartialEq)]
pub struct StoreError {
    code: &'static str,
}

impl StoreError {
    /// Construct a value-free store error from a stable code.
    pub const fn new(code: &'static str) -> Self {
        Self { code }
    }

    /// Return the stable machine-readable error code.
    pub const fn code(self) -> &'static str {
        self.code
    }
}

impl fmt::Debug for StoreError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("StoreError")
            .field("code", &self.code)
            .finish()
    }
}

impl fmt::Display for StoreError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.code)
    }
}

impl std::error::Error for StoreError {}

/// Error code for a lock file that cannot be opened.
pub const STORE_LOCK_OPEN: &str = "store_lock_open";
/// Error code for an already-held process lock.
pub const STORE_LOCK_UNAVAILABLE: &str = "store_lock_unavailable";
/// Error code for opening or configuring SQLite.
pub const STORE_SQLITE_OPEN: &str = "store_sqlite_open";
/// Error code for a failed schema initialization.
pub const STORE_SCHEMA_INITIALIZE: &str = "store_schema_initialize";
/// Error code for a schema version older than this release.
pub const STORE_SCHEMA_DOWNGRADE: &str = "store_schema_downgrade";
/// Error code for a schema version newer than this release.
pub const STORE_SCHEMA_NEWER: &str = "store_schema_newer";
/// Error code for a malformed or unexpected schema.
pub const STORE_SCHEMA_INVALID: &str = "store_schema_invalid";
/// Error code for required SQLite settings that could not be applied.
pub const STORE_PRAGMA_INVALID: &str = "store_pragma_invalid";
/// Error code for an unsafe state-store path or filesystem identity.
pub const STORE_PATH_INVALID: &str = "store_path_invalid";

const SCHEMA_SQL: &str = r#"
CREATE TABLE schema_meta(version INTEGER NOT NULL CHECK(version = 1));
CREATE TABLE gateway_state(
  singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
  session_cipher BLOB, session_nonce BLOB, session_key_version INTEGER,
  committed_token_cipher BLOB, committed_token_nonce BLOB,
  committed_token_key_version INTEGER,
  fetch_token_cipher BLOB, fetch_token_nonce BLOB,
  fetch_token_key_version INTEGER,
  maintenance_code TEXT, maintenance_since TEXT,
  bootstrapped_at TEXT, updated_at TEXT NOT NULL,
  CHECK((maintenance_code IS NULL AND maintenance_since IS NULL)
     OR (maintenance_code IN ('crypto_maintenance_required',
                              'matrix_crypto_kind_not_allowed',
                              'matrix_crypto_ack_unrecoverable')
         AND maintenance_since IS NOT NULL))
);
CREATE TABLE room_bindings(
  binding_id TEXT PRIMARY KEY,
  room_lookup BLOB NOT NULL,
  account_lookup BLOB NOT NULL,
  payload_cipher BLOB NOT NULL, payload_nonce BLOB NOT NULL,
  key_version INTEGER NOT NULL, status TEXT NOT NULL,
  created_at TEXT NOT NULL, retired_at TEXT,
  CHECK(status IN ('active','retired')),
  CHECK((status='active' AND retired_at IS NULL) OR
        (status='retired' AND retired_at IS NOT NULL))
);
CREATE UNIQUE INDEX one_active_room ON room_bindings(room_lookup)
  WHERE status='active';
CREATE TABLE room_progress(
  room_lookup BLOB PRIMARY KEY,
  anchor_event_cipher BLOB NOT NULL, anchor_event_nonce BLOB NOT NULL,
  key_version INTEGER NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE room_ephemeral_state(
  room_lookup BLOB PRIMARY KEY,
  typing_set_cipher BLOB NOT NULL, typing_set_nonce BLOB NOT NULL,
  typing_key_version INTEGER NOT NULL, typing_expires_at TEXT NOT NULL,
  last_committed_inbox_digest BLOB NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE sync_inbox(
  inbox_id TEXT PRIMARY KEY, predecessor_id TEXT,
  request_token_cipher BLOB NOT NULL, request_token_nonce BLOB NOT NULL,
  request_token_key_version INTEGER NOT NULL,
  request_token_digest BLOB NOT NULL,
  next_token_cipher BLOB NOT NULL, next_token_nonce BLOB NOT NULL,
  next_token_key_version INTEGER NOT NULL, next_token_digest BLOB NOT NULL,
  response_cipher BLOB NOT NULL, response_nonce BLOB NOT NULL,
  response_key_version INTEGER NOT NULL, response_sha256 BLOB NOT NULL,
  byte_count INTEGER NOT NULL CHECK(byte_count BETWEEN 1 AND 67108864),
  state TEXT NOT NULL, crypto_drained INTEGER NOT NULL DEFAULT 0,
  observed_at TEXT NOT NULL, created_at TEXT NOT NULL,
  sdk_processed_at TEXT, prepared_at TEXT,
  committed_at TEXT, terminal_code TEXT,
  FOREIGN KEY(predecessor_id) REFERENCES sync_inbox(inbox_id),
  CHECK(state IN ('fetched','sdk_processed','prepared','committed','quarantined')),
  CHECK(crypto_drained IN (0,1)),
  UNIQUE(predecessor_id), UNIQUE(next_token_digest)
);
CREATE TABLE sync_windows(
  window_id TEXT PRIMARY KEY, inbox_id TEXT NOT NULL UNIQUE, state TEXT NOT NULL,
  batch_count INTEGER NOT NULL, accepted_count INTEGER NOT NULL DEFAULT 0,
  ignored_count INTEGER NOT NULL, created_at TEXT NOT NULL,
  committed_at TEXT, terminal_code TEXT,
  FOREIGN KEY(inbox_id) REFERENCES sync_inbox(inbox_id),
  CHECK(state IN ('collecting','pending','committed','quarantined'))
);
CREATE TABLE window_room_anchors(
  window_id TEXT NOT NULL, room_lookup BLOB NOT NULL,
  anchor_event_cipher BLOB NOT NULL, anchor_event_nonce BLOB NOT NULL,
  key_version INTEGER NOT NULL,
  PRIMARY KEY(window_id, room_lookup),
  FOREIGN KEY(window_id) REFERENCES sync_windows(window_id)
);
CREATE TABLE window_room_ephemeral(
  window_id TEXT NOT NULL, room_lookup BLOB NOT NULL,
  typing_set_cipher BLOB NOT NULL, typing_set_nonce BLOB NOT NULL,
  key_version INTEGER NOT NULL, typing_expires_at TEXT NOT NULL,
  PRIMARY KEY(window_id, room_lookup),
  FOREIGN KEY(window_id) REFERENCES sync_windows(window_id)
);
CREATE TABLE backfill_jobs(
  job_id TEXT PRIMARY KEY, kind TEXT NOT NULL, live_window_id TEXT,
  state TEXT NOT NULL,
  parameters_cipher BLOB NOT NULL, parameters_nonce BLOB NOT NULL,
  pagination_cipher BLOB, pagination_nonce BLOB,
  key_version INTEGER NOT NULL, accepted_events INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL, completed_at TEXT, cancelled_at TEXT,
  terminal_code TEXT,
  FOREIGN KEY(live_window_id) REFERENCES sync_windows(window_id),
  CHECK(kind IN ('explicit','live_gap')),
  CHECK((kind='explicit' AND live_window_id IS NULL)
     OR (kind='live_gap' AND live_window_id IS NOT NULL)),
  CHECK(state IN ('pending','running','completed','cancelled','quarantined'))
);
CREATE TABLE outbox_batches(
  batch_row_id TEXT PRIMARY KEY, source_kind TEXT NOT NULL,
  window_id TEXT, backfill_job_id TEXT,
  ordinal INTEGER NOT NULL, state TEXT NOT NULL,
  request_cipher BLOB NOT NULL, request_nonce BLOB NOT NULL,
  request_key_version INTEGER NOT NULL, request_sha256 BLOB NOT NULL,
  byte_count INTEGER NOT NULL, attempt_count INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL, accepted_at TEXT, terminal_code TEXT,
  FOREIGN KEY(window_id) REFERENCES sync_windows(window_id),
  FOREIGN KEY(backfill_job_id) REFERENCES backfill_jobs(job_id),
  CHECK(source_kind IN ('live','backfill')),
  CHECK((source_kind='live' AND window_id IS NOT NULL AND backfill_job_id IS NULL)
     OR (source_kind='backfill' AND window_id IS NULL AND backfill_job_id IS NOT NULL)),
  CHECK(state IN ('pending','accepted','quarantined')),
  UNIQUE(window_id, ordinal), UNIQUE(backfill_job_id, ordinal)
);
CREATE TABLE matrix_crypto_outbox(
  crypto_row_id TEXT PRIMARY KEY, inbox_id TEXT NOT NULL,
  request_lookup BLOB NOT NULL, request_kind TEXT NOT NULL,
  sdk_request_id_cipher BLOB NOT NULL, sdk_request_id_nonce BLOB NOT NULL,
  sdk_request_id_key_version INTEGER NOT NULL,
  request_cipher BLOB NOT NULL, request_nonce BLOB NOT NULL,
  request_key_version INTEGER NOT NULL, request_sha256 BLOB NOT NULL,
  byte_count INTEGER NOT NULL CHECK(byte_count > 0),
  response_cipher BLOB, response_nonce BLOB, response_key_version INTEGER,
  response_sha256 BLOB,
  state TEXT NOT NULL, attempt_count INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL, accepted_at TEXT, terminal_code TEXT,
  FOREIGN KEY(inbox_id) REFERENCES sync_inbox(inbox_id),
  CHECK(request_kind='keys_query'),
  CHECK(state IN ('pending','response_received','accepted','quarantined')),
  CHECK((response_cipher IS NULL AND response_nonce IS NULL
         AND response_key_version IS NULL AND response_sha256 IS NULL)
     OR (response_cipher IS NOT NULL AND response_nonce IS NOT NULL
         AND response_key_version IS NOT NULL AND response_sha256 IS NOT NULL)),
  CHECK((state='pending' AND response_cipher IS NULL AND accepted_at IS NULL)
     OR (state='response_received' AND response_cipher IS NOT NULL AND accepted_at IS NULL)
     OR (state='accepted' AND response_cipher IS NOT NULL AND accepted_at IS NOT NULL)
     OR (state='quarantined' AND terminal_code IS NOT NULL AND accepted_at IS NULL)),
  UNIQUE(inbox_id, request_lookup)
);
CREATE UNIQUE INDEX one_unresolved_crypto_request
  ON matrix_crypto_outbox((1))
  WHERE state IN ('pending','response_received','quarantined');
"#;

/// The SQLite settings applied to the private state connection.
#[derive(Clone, Eq, PartialEq)]
pub struct StorePragmas {
    foreign_keys: bool,
    journal_mode: String,
    synchronous: i64,
    busy_timeout_ms: i64,
}

impl fmt::Debug for StorePragmas {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("StorePragmas")
            .field("foreign_keys", &self.foreign_keys)
            .field("journal_mode", &self.journal_mode)
            .field("synchronous", &self.synchronous)
            .field("busy_timeout_ms", &self.busy_timeout_ms)
            .finish()
    }
}

impl StorePragmas {
    /// Whether SQLite foreign-key enforcement is enabled.
    pub const fn foreign_keys(&self) -> bool {
        self.foreign_keys
    }

    /// Return the configured journal mode.
    pub fn journal_mode(&self) -> &str {
        &self.journal_mode
    }

    /// Return SQLite's numeric synchronous setting (`2` is FULL).
    pub const fn synchronous(&self) -> i64 {
        self.synchronous
    }

    /// Return the busy timeout in milliseconds.
    pub const fn busy_timeout_ms(&self) -> i64 {
        self.busy_timeout_ms
    }
}

/// An exclusively owned gateway state database.
pub struct Store {
    // Rust drops struct fields in declaration order. Keep Connection first so
    // SQLite closes before the advisory lock is released.
    _connection: Connection,
    _lock: File,
    pragmas: StorePragmas,
}

impl fmt::Debug for Store {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("Store")
    }
}

impl Store {
    /// Open or initialize a version-1 gateway database.
    ///
    /// The process lock is acquired before SQLite is opened. A second process
    /// (or a second open in this process) receives a stable lock error without
    /// touching the database connection.
    pub fn open(path: impl AsRef<Path>) -> Result<Self, StoreError> {
        let path = path.as_ref();
        validate_parent(path)?;
        let before = existing_identity(path)?;
        let lock_path = path.with_extension(STORE_LOCK_EXTENSION);
        let lock = acquire_lock(&lock_path)?;
        let mut connection =
            Connection::open(path).map_err(|_| StoreError::new(STORE_SQLITE_OPEN))?;
        validate_opened_identity(path, before)?;
        let pragmas = configure_connection(&connection)?;
        initialize_or_validate_schema(&mut connection)?;

        Ok(Self {
            _connection: connection,
            _lock: lock,
            pragmas,
        })
    }

    /// Read-only view of the required connection settings.
    pub fn pragmas(&self) -> &StorePragmas {
        &self.pragmas
    }
}

fn acquire_lock(path: &Path) -> Result<File, StoreError> {
    let before = existing_identity(path)?;
    let lock = OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .custom_flags(OFlags::NOFOLLOW.bits() as i32)
        .mode(0o600)
        .open(path)
        .map_err(|_| StoreError::new(STORE_LOCK_OPEN))?;
    validate_opened_identity(path, before)?;

    flock(&lock, FlockOperation::NonBlockingLockExclusive)
        .map_err(|_| StoreError::new(STORE_LOCK_UNAVAILABLE))?;
    Ok(lock)
}

fn validate_parent(path: &Path) -> Result<(), StoreError> {
    let parent = path.parent().unwrap_or_else(|| Path::new("."));
    let parent = if parent.as_os_str().is_empty() {
        Path::new(".")
    } else {
        parent
    };
    let metadata = symlink_metadata(parent).map_err(|_| StoreError::new(STORE_PATH_INVALID))?;
    if !metadata.file_type().is_dir() || metadata.permissions().mode() & 0o022 != 0 {
        return Err(StoreError::new(STORE_PATH_INVALID));
    }
    Ok(())
}

#[derive(Clone, Copy, Eq, PartialEq)]
struct FileIdentity {
    device: u64,
    inode: u64,
}

fn existing_identity(path: &Path) -> Result<Option<FileIdentity>, StoreError> {
    match symlink_metadata(path) {
        Ok(metadata) => {
            if !metadata.file_type().is_file() || metadata.nlink() != 1 {
                return Err(StoreError::new(STORE_PATH_INVALID));
            }
            Ok(Some(FileIdentity {
                device: metadata.dev(),
                inode: metadata.ino(),
            }))
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(_) => Err(StoreError::new(STORE_PATH_INVALID)),
    }
}

fn validate_opened_identity(path: &Path, before: Option<FileIdentity>) -> Result<(), StoreError> {
    let after = existing_identity(path)?.ok_or_else(|| StoreError::new(STORE_PATH_INVALID))?;
    if before.is_some_and(|before| before != after) {
        return Err(StoreError::new(STORE_PATH_INVALID));
    }
    Ok(())
}

fn configure_connection(connection: &Connection) -> Result<StorePragmas, StoreError> {
    connection
        .pragma_update(None, "foreign_keys", true)
        .map_err(|_| StoreError::new(STORE_PRAGMA_INVALID))?;
    let journal_mode = connection
        .pragma_update_and_check(None, "journal_mode", "WAL", |row| row.get::<_, String>(0))
        .map_err(|_| StoreError::new(STORE_PRAGMA_INVALID))?;
    connection
        .pragma_update(None, "synchronous", 2_i64)
        .map_err(|_| StoreError::new(STORE_PRAGMA_INVALID))?;
    connection
        .busy_timeout(Duration::from_secs(5))
        .map_err(|_| StoreError::new(STORE_PRAGMA_INVALID))?;

    let foreign_keys = pragma_i64(connection, "foreign_keys")?;
    let synchronous = pragma_i64(connection, "synchronous")?;
    let busy_timeout_ms = pragma_i64(connection, "busy_timeout")?;

    if !journal_mode.eq_ignore_ascii_case("wal")
        || foreign_keys != 1
        || synchronous != 2
        || busy_timeout_ms != 5_000
    {
        return Err(StoreError::new(STORE_PRAGMA_INVALID));
    }

    Ok(StorePragmas {
        foreign_keys: true,
        journal_mode,
        synchronous,
        busy_timeout_ms,
    })
}

fn pragma_i64(connection: &Connection, name: &str) -> Result<i64, StoreError> {
    connection
        .query_row(&format!("PRAGMA {name}"), [], |row| row.get(0))
        .map_err(|_| StoreError::new(STORE_PRAGMA_INVALID))
}

fn initialize_or_validate_schema(connection: &mut Connection) -> Result<(), StoreError> {
    let schema_meta_exists = connection
        .query_row(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='schema_meta' LIMIT 1",
            [],
            |_| Ok(()),
        )
        .optional()
        .map_err(|_| StoreError::new(STORE_SCHEMA_INVALID))?
        .is_some();

    if !schema_meta_exists {
        let user_object_count: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'",
                [],
                |row| row.get(0),
            )
            .map_err(|_| StoreError::new(STORE_SCHEMA_INVALID))?;
        if user_object_count != 0 {
            return Err(StoreError::new(STORE_SCHEMA_INVALID));
        }

        let transaction = connection
            .transaction()
            .map_err(|_| StoreError::new(STORE_SCHEMA_INITIALIZE))?;
        transaction
            .execute_batch(SCHEMA_SQL)
            .map_err(|_| StoreError::new(STORE_SCHEMA_INITIALIZE))?;
        transaction
            .execute(
                "INSERT INTO schema_meta(version) VALUES (?1)",
                [GATEWAY_SCHEMA_VERSION],
            )
            .map_err(|_| StoreError::new(STORE_SCHEMA_INITIALIZE))?;
        transaction
            .commit()
            .map_err(|_| StoreError::new(STORE_SCHEMA_INITIALIZE))?;
    }

    validate_schema_version(connection)?;
    validate_schema_objects(connection)
}

fn validate_schema_version(connection: &Connection) -> Result<(), StoreError> {
    let row_count: i64 = connection
        .query_row("SELECT COUNT(*) FROM schema_meta", [], |row| row.get(0))
        .map_err(|_| StoreError::new(STORE_SCHEMA_INVALID))?;
    if row_count != 1 {
        return Err(StoreError::new(STORE_SCHEMA_INVALID));
    }

    let version: i64 = connection
        .query_row("SELECT version FROM schema_meta", [], |row| row.get(0))
        .map_err(|_| StoreError::new(STORE_SCHEMA_INVALID))?;
    match version.cmp(&GATEWAY_SCHEMA_VERSION) {
        std::cmp::Ordering::Less => Err(StoreError::new(STORE_SCHEMA_DOWNGRADE)),
        std::cmp::Ordering::Greater => Err(StoreError::new(STORE_SCHEMA_NEWER)),
        std::cmp::Ordering::Equal => Ok(()),
    }
}

#[derive(Clone, Eq, PartialEq)]
struct SchemaObject {
    object_type: String,
    name: String,
    sql: String,
}

fn validate_schema_objects(connection: &Connection) -> Result<(), StoreError> {
    let mut statement = connection
        .prepare(
            "SELECT type, name, sql FROM sqlite_master \
             WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name",
        )
        .map_err(|_| StoreError::new(STORE_SCHEMA_INVALID))?;
    let actual = statement
        .query_map([], |row| {
            Ok(SchemaObject {
                object_type: row.get(0)?,
                name: row.get(1)?,
                sql: row.get(2)?,
            })
        })
        .map_err(|_| StoreError::new(STORE_SCHEMA_INVALID))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| StoreError::new(STORE_SCHEMA_INVALID))?;

    let expected_connection =
        Connection::open_in_memory().map_err(|_| StoreError::new(STORE_SCHEMA_INVALID))?;
    expected_connection
        .execute_batch(SCHEMA_SQL)
        .map_err(|_| StoreError::new(STORE_SCHEMA_INVALID))?;
    let mut expected_statement = expected_connection
        .prepare(
            "SELECT type, name, sql FROM sqlite_master \
             WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name",
        )
        .map_err(|_| StoreError::new(STORE_SCHEMA_INVALID))?;
    let expected = expected_statement
        .query_map([], |row| {
            Ok(SchemaObject {
                object_type: row.get(0)?,
                name: row.get(1)?,
                sql: row.get(2)?,
            })
        })
        .map_err(|_| StoreError::new(STORE_SCHEMA_INVALID))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| StoreError::new(STORE_SCHEMA_INVALID))?;

    if actual.len() != expected.len()
        || actual
            .iter()
            .zip(expected.iter())
            .any(|(actual, expected)| {
                actual.object_type != expected.object_type
                    || actual.name != expected.name
                    || normalize_sql(&actual.sql) != normalize_sql(&expected.sql)
            })
    {
        return Err(StoreError::new(STORE_SCHEMA_INVALID));
    }
    Ok(())
}

fn normalize_sql(sql: &str) -> &str {
    sql.trim_end_matches(';').trim()
}
