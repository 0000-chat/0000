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

use chrono::{DateTime, Utc};
use rusqlite::{Connection, OptionalExtension, Row, TransactionBehavior, params};
use rustix::fs::{FlockOperation, OFlags, flock};

use crate::{
    config::GATEWAY_SCHEMA_VERSION,
    crypto::{AEAD_TAG_BYTES, Keyring, Sealed},
    model,
    registry::{
        NewRoomBinding, RoomBinding, RoomBindingPayload, RoomBindingStatus,
        account_lookup as registry_account_lookup, room_lookup as registry_room_lookup,
        valid_binding_id as registry_valid_binding_id,
    },
    secret::{SafeError, SecretBytes},
    store_types::{
        MAX_BOOTSTRAP_ROOM_ANCHORS, MAX_BOOTSTRAP_SESSION_BYTES, MAX_ROOM_ANCHOR_BYTES,
        MAX_SYNC_TOKEN_BYTES, NewBootstrapState,
    },
};

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

/// Stable error returned for an active room-binding conflict.
pub const STORE_ROOM_BINDING_DUPLICATE_ROOM: &str = "store_room_binding_duplicate_room";
/// Stable error returned for a duplicate room-binding identifier.
pub const STORE_ROOM_BINDING_DUPLICATE_ID: &str = "store_room_binding_duplicate_id";
/// Stable error returned for invalid or corrupt room-binding state.
pub const STORE_ROOM_BINDING_INVALID: &str = "store_room_binding_invalid";

/// Stable error returned when bootstrap state does not exist yet.
pub const STORE_NOT_BOOTSTRAPPED: &str = "store_not_bootstrapped";
/// Stable error returned when bootstrap has already populated the store.
pub const STORE_ALREADY_BOOTSTRAPPED: &str = "store_already_bootstrapped";
/// Stable error returned when bootstrap input or its transaction is invalid.
pub const STORE_BOOTSTRAP_INVALID: &str = "store_bootstrap_invalid";
/// Stable error returned when sync-ledger input is malformed.
pub const STORE_SYNC_INVALID: &str = "store_sync_invalid";
/// Stable error returned when sync-ledger input exceeds a fixed bound.
pub const STORE_SYNC_TOO_LARGE: &str = "store_sync_too_large";
/// Stable error returned when a sync response does not continue the fetch token.
pub const STORE_SYNC_TOKEN_MISMATCH: &str = "store_sync_token_mismatch";
/// Stable error returned when a sync inbox identity conflicts with existing bytes.
pub const STORE_SYNC_CONFLICT: &str = "store_sync_conflict";
/// Stable error returned when persisted sync state fails closed validation.
pub const STORE_SYNC_CORRUPT: &str = "store_sync_corrupt";
/// Stable error returned when the SDK position is not durably journaled.
pub const STORE_SDK_POSITION_UNJOURNALED: &str = "matrix_sdk_position_unjournaled";

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
    // SQLite and key material are dropped before the advisory lock is released.
    connection: Connection,
    keyring: Keyring,
    #[allow(dead_code)]
    lock: File,
    pragmas: StorePragmas,
}

struct StoredRoomBindingRow {
    binding_id: String,
    room_lookup: Vec<u8>,
    account_lookup: Vec<u8>,
    payload_cipher: Vec<u8>,
    payload_nonce: Vec<u8>,
    key_version: i64,
    status: String,
    created_at: String,
    retired_at: Option<String>,
}

struct StoredGatewayStateRow {
    singleton: i64,
    session_cipher: Option<Vec<u8>>,
    session_nonce: Option<Vec<u8>>,
    session_key_version: Option<i64>,
    committed_token_cipher: Option<Vec<u8>>,
    committed_token_nonce: Option<Vec<u8>>,
    committed_token_key_version: Option<i64>,
    fetch_token_cipher: Option<Vec<u8>>,
    fetch_token_nonce: Option<Vec<u8>>,
    fetch_token_key_version: Option<i64>,
    maintenance_code: Option<String>,
    maintenance_since: Option<String>,
    bootstrapped_at: Option<String>,
    updated_at: Option<String>,
}

struct StoredRoomProgressRow {
    room_lookup: Vec<u8>,
    anchor_event_cipher: Vec<u8>,
    anchor_event_nonce: Vec<u8>,
    key_version: i64,
    updated_at: Option<String>,
}

struct StoredValue<'a> {
    table: &'a str,
    row_id: &'a str,
    column: &'a str,
    ciphertext: Option<&'a [u8]>,
    nonce: Option<&'a [u8]>,
    key_version: Option<i64>,
    max_plaintext_bytes: usize,
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
    pub fn open(path: impl AsRef<Path>, keyring: Keyring) -> Result<Self, StoreError> {
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
            connection,
            keyring,
            lock,
            pragmas,
        })
    }

    /// Read-only view of the required connection settings.
    pub fn pragmas(&self) -> &StorePragmas {
        &self.pragmas
    }

    /// Persist the one-shot Matrix session, initial token, and room anchors.
    pub fn initialize_bootstrap_state(
        &mut self,
        state: NewBootstrapState,
    ) -> Result<(), SafeError> {
        state.validate().map_err(|_| store_bootstrap_invalid())?;

        let session = self
            .keyring
            .seal("gateway_state", "1", "session", state.session().as_bytes())
            .map_err(|_| store_bootstrap_invalid())?;
        let committed_token = self
            .keyring
            .seal(
                "gateway_state",
                "1",
                "committed_token",
                state.initial_token().as_bytes(),
            )
            .map_err(|_| store_bootstrap_invalid())?;
        let fetch_token = self
            .keyring
            .seal(
                "gateway_state",
                "1",
                "fetch_token",
                state.initial_token().as_bytes(),
            )
            .map_err(|_| store_bootstrap_invalid())?;

        let mut anchors = Vec::with_capacity(state.anchors().len());
        for anchor in state.anchors() {
            let room_id = room_progress_row_id(anchor.room_lookup());
            let sealed = self
                .keyring
                .seal(
                    "room_progress",
                    &room_id,
                    "anchor_event",
                    anchor.anchor_event().as_bytes(),
                )
                .map_err(|_| store_bootstrap_invalid())?;
            anchors.push((anchor.room_lookup().to_vec(), sealed));
        }

        let timestamp = state.bootstrapped_at().to_rfc3339();
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| store_bootstrap_invalid())?;

        let gateway_count: i64 = transaction
            .query_row("SELECT COUNT(*) FROM gateway_state", [], |row| row.get(0))
            .map_err(|_| store_bootstrap_invalid())?;
        let room_progress_count: i64 = transaction
            .query_row("SELECT COUNT(*) FROM room_progress", [], |row| row.get(0))
            .map_err(|_| store_bootstrap_invalid())?;
        if gateway_count != 0 || room_progress_count != 0 {
            return Err(store_already_bootstrapped());
        }

        transaction
            .execute(
                "INSERT INTO gateway_state
                 (singleton, session_cipher, session_nonce, session_key_version,
                  committed_token_cipher, committed_token_nonce, committed_token_key_version,
                  fetch_token_cipher, fetch_token_nonce, fetch_token_key_version,
                  maintenance_code, maintenance_since, bootstrapped_at, updated_at)
                 VALUES (1, ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, NULL, NULL, ?10, ?10)",
                params![
                    session.ciphertext.as_slice(),
                    session.nonce.as_slice(),
                    i64::from(session.key_version),
                    committed_token.ciphertext.as_slice(),
                    committed_token.nonce.as_slice(),
                    i64::from(committed_token.key_version),
                    fetch_token.ciphertext.as_slice(),
                    fetch_token.nonce.as_slice(),
                    i64::from(fetch_token.key_version),
                    timestamp,
                ],
            )
            .map_err(|_| store_bootstrap_invalid())?;

        for (room_lookup, sealed) in anchors {
            transaction
                .execute(
                    "INSERT INTO room_progress
                     (room_lookup, anchor_event_cipher, anchor_event_nonce, key_version, updated_at)
                     VALUES (?1, ?2, ?3, ?4, ?5)",
                    params![
                        room_lookup.as_slice(),
                        sealed.ciphertext.as_slice(),
                        sealed.nonce.as_slice(),
                        i64::from(sealed.key_version),
                        timestamp,
                    ],
                )
                .map_err(|_| store_bootstrap_invalid())?;
        }

        transaction
            .commit()
            .map_err(|_| store_bootstrap_invalid())?;
        Ok(())
    }

    /// Return the authenticated Matrix session after validating store state.
    pub fn matrix_session(&self) -> Result<Option<SecretBytes>, SafeError> {
        let gateway_count = self
            .connection
            .query_row("SELECT COUNT(*) FROM gateway_state", [], |row| {
                row.get::<_, i64>(0)
            })
            .map_err(|_| store_sync_corrupt())?;
        let room_progress_count = bounded_room_progress_count(&self.connection)?;
        if gateway_count == 0 && room_progress_count == 0 {
            return Ok(None);
        }
        if gateway_count != 1 {
            return Err(store_sync_corrupt());
        }

        let gateway = read_stored_gateway_state(&self.connection)?;
        let gateway = gateway.ok_or_else(store_sync_corrupt)?;
        let session = validate_stored_gateway_state(&self.keyring, &gateway)?;
        validate_stored_room_progress(&self.connection, &self.keyring, room_progress_count, None)?;
        Ok(Some(session))
    }

    /// Return the authenticated anchor for one exact 32-byte room lookup.
    pub fn room_anchor(&self, room_lookup: &[u8]) -> Result<Option<SecretBytes>, SafeError> {
        if room_lookup.len() != 32 {
            return Err(store_bootstrap_invalid());
        }

        let gateway_count = self
            .connection
            .query_row("SELECT COUNT(*) FROM gateway_state", [], |row| {
                row.get::<_, i64>(0)
            })
            .map_err(|_| store_sync_corrupt())?;
        let room_progress_count = bounded_room_progress_count(&self.connection)?;
        if gateway_count == 0 && room_progress_count == 0 {
            return Ok(None);
        }
        if gateway_count != 1 {
            return Err(store_sync_corrupt());
        }

        let gateway = read_stored_gateway_state(&self.connection)?;
        let gateway = gateway.ok_or_else(store_sync_corrupt)?;
        let _session = validate_stored_gateway_state(&self.keyring, &gateway)?;
        validate_stored_room_progress(
            &self.connection,
            &self.keyring,
            room_progress_count,
            Some(room_lookup),
        )
    }

    /// Append one active protected room binding in a single durable
    /// transaction.
    pub fn append_room_binding(&mut self, binding: NewRoomBinding) -> Result<(), SafeError> {
        binding.validate()?;
        if !valid_utc_millisecond(*binding.created_at()) {
            return Err(room_binding_invalid());
        }
        let room_lookup = registry_room_lookup(&self.keyring, binding.matrix_room_id())?;
        let account_lookup =
            registry_account_lookup(&self.keyring, binding.platform(), binding.account_id())?;
        let candidate_payload = binding.payload();
        let payload = binding.payload_json()?;
        let sealed = self
            .keyring
            .seal("room_bindings", binding.binding_id(), "payload", &payload)
            .map_err(|_| room_binding_invalid())?;
        let created_at = binding.created_at().to_rfc3339();

        let keyring = &self.keyring;
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| room_binding_invalid())?;

        let duplicate_id = transaction
            .query_row(
                "SELECT 1 FROM room_bindings WHERE binding_id = ?1 LIMIT 1",
                params![binding.binding_id()],
                |_| Ok(()),
            )
            .optional()
            .map_err(|_| room_binding_invalid())?
            .is_some();
        if duplicate_id {
            return Err(room_binding_duplicate_id());
        }

        let duplicate_room = transaction
            .query_row(
                "SELECT 1 FROM room_bindings
                 WHERE room_lookup = ?1 AND status = 'active' LIMIT 1",
                params![room_lookup.as_slice()],
                |_| Ok(()),
            )
            .optional()
            .map_err(|_| room_binding_invalid())?
            .is_some();
        if duplicate_room {
            return Err(room_binding_duplicate_room());
        }

        let mut statement = transaction
            .prepare(
                "SELECT binding_id, room_lookup, account_lookup, payload_cipher,
                        payload_nonce, key_version, status, created_at, retired_at
                 FROM room_bindings WHERE account_lookup = ?1
                 ORDER BY binding_id",
            )
            .map_err(|_| room_binding_invalid())?;
        let rows = statement
            .query_map(
                params![account_lookup.as_slice()],
                read_stored_room_binding_row,
            )
            .map_err(|_| room_binding_invalid())?;
        let mut existing = Vec::new();
        for row in rows {
            existing.push(row.map_err(|_| room_binding_invalid())?);
        }
        drop(statement);

        for row in existing {
            if row.account_lookup.as_slice() != account_lookup.as_slice() {
                return Err(room_binding_invalid());
            }
            let stored = decode_stored_room_binding(keyring, &row)?;
            let expected_room_lookup = registry_room_lookup(keyring, stored.matrix_room_id())?;
            if expected_room_lookup.as_slice() != row.room_lookup.as_slice() {
                return Err(room_binding_invalid());
            }
            let expected_account_lookup =
                registry_account_lookup(keyring, stored.platform(), stored.account_id())?;
            if expected_account_lookup.as_slice() != row.account_lookup.as_slice() {
                return Err(room_binding_invalid());
            }
            if stored.authority_tuple() != binding.authority_tuple()
                || !stored.payload().same_authority(&candidate_payload)
            {
                return Err(room_binding_invalid());
            }
        }

        transaction
            .execute(
                "INSERT INTO room_bindings
                 (binding_id, room_lookup, account_lookup, payload_cipher,
                  payload_nonce, key_version, status, created_at, retired_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'active', ?7, NULL)",
                params![
                    binding.binding_id(),
                    room_lookup.as_slice(),
                    account_lookup.as_slice(),
                    sealed.ciphertext.as_slice(),
                    sealed.nonce.as_slice(),
                    i64::from(sealed.key_version),
                    created_at,
                ],
            )
            .map_err(|_| room_binding_invalid())?;
        transaction.commit().map_err(|_| room_binding_invalid())?;
        Ok(())
    }

    /// Retire one active protected room binding without rewriting its payload.
    pub fn retire_room_binding(
        &mut self,
        binding_id: &str,
        retired_at: DateTime<Utc>,
    ) -> Result<(), SafeError> {
        if !registry_valid_binding_id(binding_id) || !valid_utc_millisecond(retired_at) {
            return Err(room_binding_invalid());
        }
        let keyring = &self.keyring;
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| room_binding_invalid())?;
        let row = transaction
            .query_row(
                "SELECT binding_id, room_lookup, account_lookup, payload_cipher,
                        payload_nonce, key_version, status, created_at, retired_at
                 FROM room_bindings WHERE binding_id = ?1",
                params![binding_id],
                read_stored_room_binding_row,
            )
            .optional()
            .map_err(|_| room_binding_invalid())?
            .ok_or_else(room_binding_invalid)?;

        let binding = verify_active_room_binding(keyring, &row)?;
        if binding.binding_id() != binding_id || retired_at < *binding.created_at() {
            return Err(room_binding_invalid());
        }
        let retired_at = retired_at.to_rfc3339();
        let updated = transaction
            .execute(
                "UPDATE room_bindings
                 SET status = 'retired', retired_at = ?2
                 WHERE binding_id = ?1 AND status = 'active'",
                params![binding_id, retired_at],
            )
            .map_err(|_| room_binding_invalid())?;
        if updated != 1 {
            return Err(room_binding_invalid());
        }
        transaction.commit().map_err(|_| room_binding_invalid())?;
        Ok(())
    }

    /// Return the verified active room binding for a deterministic room lookup.
    pub fn active_room_binding(
        &self,
        room_lookup: &[u8],
    ) -> Result<Option<RoomBinding>, SafeError> {
        if room_lookup.len() != 32 {
            return Err(room_binding_invalid());
        }

        let mut statement = self
            .connection
            .prepare(
                "SELECT binding_id, room_lookup, account_lookup, payload_cipher,
                        payload_nonce, key_version, status, created_at, retired_at
                 FROM room_bindings
                 WHERE room_lookup = ?1 AND status = 'active'
                 ORDER BY binding_id",
            )
            .map_err(|_| room_binding_invalid())?;
        let rows = statement
            .query_map(params![room_lookup], read_stored_room_binding_row)
            .map_err(|_| room_binding_invalid())?;
        let mut matches = Vec::new();
        for row in rows {
            matches.push(row.map_err(|_| room_binding_invalid())?);
        }
        drop(statement);

        let Some(row) = matches.pop() else {
            return Ok(None);
        };
        if !matches.is_empty() {
            return Err(room_binding_invalid());
        }
        if row.room_lookup.as_slice() != room_lookup {
            return Err(room_binding_invalid());
        }

        let binding = verify_active_room_binding(&self.keyring, &row)?;
        Ok(Some(binding))
    }
}

fn room_binding_invalid() -> SafeError {
    SafeError::new(STORE_ROOM_BINDING_INVALID)
}

fn store_already_bootstrapped() -> SafeError {
    SafeError::new(STORE_ALREADY_BOOTSTRAPPED)
}

fn store_bootstrap_invalid() -> SafeError {
    SafeError::new(STORE_BOOTSTRAP_INVALID)
}

fn store_sync_corrupt() -> SafeError {
    SafeError::new(STORE_SYNC_CORRUPT)
}

fn room_binding_duplicate_room() -> SafeError {
    SafeError::new(STORE_ROOM_BINDING_DUPLICATE_ROOM)
}

fn room_binding_duplicate_id() -> SafeError {
    SafeError::new(STORE_ROOM_BINDING_DUPLICATE_ID)
}

fn valid_utc_millisecond(value: DateTime<Utc>) -> bool {
    value.timestamp_subsec_nanos().is_multiple_of(1_000_000)
        && model::valid_timestamp(&value.to_rfc3339())
}

fn read_stored_gateway_state(
    connection: &Connection,
) -> Result<Option<StoredGatewayStateRow>, SafeError> {
    connection
        .query_row(
            "SELECT singleton, session_cipher, session_nonce, session_key_version,
                    committed_token_cipher, committed_token_nonce, committed_token_key_version,
                    fetch_token_cipher, fetch_token_nonce, fetch_token_key_version,
                    maintenance_code, maintenance_since, bootstrapped_at, updated_at
             FROM gateway_state",
            [],
            |row| {
                Ok(StoredGatewayStateRow {
                    singleton: row.get(0)?,
                    session_cipher: row.get(1)?,
                    session_nonce: row.get(2)?,
                    session_key_version: row.get(3)?,
                    committed_token_cipher: row.get(4)?,
                    committed_token_nonce: row.get(5)?,
                    committed_token_key_version: row.get(6)?,
                    fetch_token_cipher: row.get(7)?,
                    fetch_token_nonce: row.get(8)?,
                    fetch_token_key_version: row.get(9)?,
                    maintenance_code: row.get(10)?,
                    maintenance_since: row.get(11)?,
                    bootstrapped_at: row.get(12)?,
                    updated_at: row.get(13)?,
                })
            },
        )
        .optional()
        .map_err(|_| store_sync_corrupt())
}

fn bounded_room_progress_count(connection: &Connection) -> Result<i64, SafeError> {
    let count = connection
        .query_row("SELECT COUNT(*) FROM room_progress", [], |row| {
            row.get::<_, i64>(0)
        })
        .map_err(|_| store_sync_corrupt())?;
    if count < 0
        || usize::try_from(count)
            .ok()
            .is_none_or(|count| count > MAX_BOOTSTRAP_ROOM_ANCHORS)
    {
        return Err(store_sync_corrupt());
    }
    Ok(count)
}

fn validate_stored_gateway_state(
    keyring: &Keyring,
    row: &StoredGatewayStateRow,
) -> Result<SecretBytes, SafeError> {
    if row.singleton != 1
        || !row
            .bootstrapped_at
            .as_deref()
            .is_some_and(valid_stored_utc_millisecond)
        || !row
            .updated_at
            .as_deref()
            .is_some_and(valid_stored_utc_millisecond)
    {
        return Err(store_sync_corrupt());
    }

    match (&row.maintenance_code, &row.maintenance_since) {
        (None, None) => {}
        (Some(code), Some(since))
            if valid_maintenance_code(code) && valid_stored_utc_millisecond(since) => {}
        _ => return Err(store_sync_corrupt()),
    }

    let session = open_stored_value(
        keyring,
        StoredValue {
            table: "gateway_state",
            row_id: "1",
            column: "session",
            ciphertext: row.session_cipher.as_deref(),
            nonce: row.session_nonce.as_deref(),
            key_version: row.session_key_version,
            max_plaintext_bytes: MAX_BOOTSTRAP_SESSION_BYTES,
        },
    )?;
    let _committed_token = open_stored_value(
        keyring,
        StoredValue {
            table: "gateway_state",
            row_id: "1",
            column: "committed_token",
            ciphertext: row.committed_token_cipher.as_deref(),
            nonce: row.committed_token_nonce.as_deref(),
            key_version: row.committed_token_key_version,
            max_plaintext_bytes: MAX_SYNC_TOKEN_BYTES,
        },
    )?;
    let _fetch_token = open_stored_value(
        keyring,
        StoredValue {
            table: "gateway_state",
            row_id: "1",
            column: "fetch_token",
            ciphertext: row.fetch_token_cipher.as_deref(),
            nonce: row.fetch_token_nonce.as_deref(),
            key_version: row.fetch_token_key_version,
            max_plaintext_bytes: MAX_SYNC_TOKEN_BYTES,
        },
    )?;

    Ok(SecretBytes::new(session.as_bytes().to_vec()))
}

fn validate_stored_ciphertext_length(
    ciphertext: &[u8],
    max_plaintext_bytes: usize,
) -> Result<(), SafeError> {
    let max_ciphertext_bytes = max_plaintext_bytes
        .checked_add(AEAD_TAG_BYTES)
        .ok_or_else(store_sync_corrupt)?;
    if ciphertext.len() < AEAD_TAG_BYTES || ciphertext.len() > max_ciphertext_bytes {
        return Err(store_sync_corrupt());
    }
    Ok(())
}

fn open_stored_value(
    keyring: &Keyring,
    value: StoredValue<'_>,
) -> Result<crate::crypto::Plaintext, SafeError> {
    let ciphertext = value.ciphertext.ok_or_else(store_sync_corrupt)?;
    let nonce = value.nonce.ok_or_else(store_sync_corrupt)?;
    validate_stored_ciphertext_length(ciphertext, value.max_plaintext_bytes)?;
    if nonce.len() != 24 {
        return Err(store_sync_corrupt());
    }
    let nonce: [u8; 24] = nonce.try_into().map_err(|_| store_sync_corrupt())?;
    let key_version = value
        .key_version
        .and_then(|value| u32::try_from(value).ok())
        .filter(|value| *value != 0)
        .ok_or_else(store_sync_corrupt)?;
    let sealed = Sealed {
        nonce,
        ciphertext: ciphertext.to_vec(),
        key_version,
    };
    let plaintext = keyring
        .open(value.table, value.row_id, value.column, &sealed)
        .map_err(|_| store_sync_corrupt())?;
    if plaintext.is_empty() || plaintext.len() > value.max_plaintext_bytes {
        return Err(store_sync_corrupt());
    }
    Ok(plaintext)
}

fn validate_stored_room_progress(
    connection: &Connection,
    keyring: &Keyring,
    expected_count: i64,
    selected_room_lookup: Option<&[u8]>,
) -> Result<Option<SecretBytes>, SafeError> {
    let mut statement = connection
        .prepare(
            "SELECT room_lookup, anchor_event_cipher, anchor_event_nonce,
                    key_version, updated_at
             FROM room_progress ORDER BY room_lookup",
        )
        .map_err(|_| store_sync_corrupt())?;
    let mut rows = statement.query([]).map_err(|_| store_sync_corrupt())?;
    let mut seen_count = 0_i64;
    let mut selected = None;
    while let Some(row) = rows.next().map_err(|_| store_sync_corrupt())? {
        seen_count = seen_count.checked_add(1).ok_or_else(store_sync_corrupt)?;
        if seen_count > expected_count || seen_count as usize > MAX_BOOTSTRAP_ROOM_ANCHORS {
            return Err(store_sync_corrupt());
        }
        let stored = StoredRoomProgressRow {
            room_lookup: row.get(0).map_err(|_| store_sync_corrupt())?,
            anchor_event_cipher: row.get(1).map_err(|_| store_sync_corrupt())?,
            anchor_event_nonce: row.get(2).map_err(|_| store_sync_corrupt())?,
            key_version: row.get(3).map_err(|_| store_sync_corrupt())?,
            updated_at: row.get(4).map_err(|_| store_sync_corrupt())?,
        };
        let event = open_stored_room_progress(keyring, &stored)?;
        if selected_room_lookup.is_some_and(|lookup| stored.room_lookup.as_slice() == lookup) {
            if selected.is_some() {
                return Err(store_sync_corrupt());
            }
            selected = Some(event);
        }
    }
    if seen_count != expected_count {
        return Err(store_sync_corrupt());
    }
    Ok(selected)
}

fn open_stored_room_progress(
    keyring: &Keyring,
    row: &StoredRoomProgressRow,
) -> Result<SecretBytes, SafeError> {
    if row.room_lookup.len() != 32
        || !row
            .updated_at
            .as_deref()
            .is_some_and(valid_stored_utc_millisecond)
    {
        return Err(store_sync_corrupt());
    }
    let room_id = room_progress_row_id(&row.room_lookup);
    let plaintext = open_stored_value(
        keyring,
        StoredValue {
            table: "room_progress",
            row_id: &room_id,
            column: "anchor_event",
            ciphertext: Some(row.anchor_event_cipher.as_slice()),
            nonce: Some(row.anchor_event_nonce.as_slice()),
            key_version: Some(row.key_version),
            max_plaintext_bytes: MAX_ROOM_ANCHOR_BYTES,
        },
    )?;
    Ok(SecretBytes::new(plaintext.as_bytes().to_vec()))
}

fn valid_maintenance_code(value: &str) -> bool {
    matches!(
        value,
        "crypto_maintenance_required"
            | "matrix_crypto_kind_not_allowed"
            | "matrix_crypto_ack_unrecoverable"
    )
}

fn valid_stored_utc_millisecond(value: &str) -> bool {
    if !model::valid_timestamp(value) {
        return false;
    }
    let Ok(timestamp) = DateTime::parse_from_rfc3339(value) else {
        return false;
    };
    timestamp.offset().local_minus_utc() == 0
        && timestamp.timestamp_subsec_nanos().is_multiple_of(1_000_000)
}

fn room_progress_row_id(room_lookup: &[u8]) -> String {
    let mut hex = String::with_capacity(room_lookup.len() * 2);
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    for byte in room_lookup {
        hex.push(char::from(DIGITS[(byte >> 4) as usize]));
        hex.push(char::from(DIGITS[(byte & 0x0f) as usize]));
    }
    format!("room_{hex}")
}

fn read_stored_room_binding_row(row: &Row<'_>) -> rusqlite::Result<StoredRoomBindingRow> {
    Ok(StoredRoomBindingRow {
        binding_id: row.get(0)?,
        room_lookup: row.get(1)?,
        account_lookup: row.get(2)?,
        payload_cipher: row.get(3)?,
        payload_nonce: row.get(4)?,
        key_version: row.get(5)?,
        status: row.get(6)?,
        created_at: row.get(7)?,
        retired_at: row.get(8)?,
    })
}

fn decode_stored_room_binding(
    keyring: &Keyring,
    row: &StoredRoomBindingRow,
) -> Result<RoomBinding, SafeError> {
    let nonce: [u8; 24] = row
        .payload_nonce
        .as_slice()
        .try_into()
        .map_err(|_| room_binding_invalid())?;
    let key_version = u32::try_from(row.key_version).map_err(|_| room_binding_invalid())?;
    let sealed = Sealed {
        nonce,
        ciphertext: row.payload_cipher.clone(),
        key_version,
    };
    let plaintext = keyring
        .open("room_bindings", &row.binding_id, "payload", &sealed)
        .map_err(|_| room_binding_invalid())?;
    let payload =
        RoomBindingPayload::from_json(plaintext.as_slice()).map_err(|_| room_binding_invalid())?;
    let status = RoomBindingStatus::from_str(&row.status).map_err(|_| room_binding_invalid())?;
    let created_at = parse_utc_timestamp(&row.created_at)?;
    let retired_at = row
        .retired_at
        .as_deref()
        .map(parse_utc_timestamp)
        .transpose()?;
    RoomBinding::from_verified_parts(
        row.binding_id.clone(),
        payload,
        status,
        created_at,
        retired_at,
    )
    .map_err(|_| room_binding_invalid())
}

fn verify_active_room_binding(
    keyring: &Keyring,
    row: &StoredRoomBindingRow,
) -> Result<RoomBinding, SafeError> {
    let binding = decode_stored_room_binding(keyring, row)?;
    if binding.status() != RoomBindingStatus::Active {
        return Err(room_binding_invalid());
    }
    let expected_room_lookup = registry_room_lookup(keyring, binding.matrix_room_id())?;
    if expected_room_lookup.as_slice() != row.room_lookup.as_slice() {
        return Err(room_binding_invalid());
    }
    let expected_account_lookup =
        registry_account_lookup(keyring, binding.platform(), binding.account_id())?;
    if expected_account_lookup.as_slice() != row.account_lookup.as_slice() {
        return Err(room_binding_invalid());
    }
    Ok(binding)
}

fn parse_utc_timestamp(value: &str) -> Result<DateTime<Utc>, SafeError> {
    if !model::valid_timestamp(value) {
        return Err(room_binding_invalid());
    }
    let timestamp = DateTime::parse_from_rfc3339(value).map_err(|_| room_binding_invalid())?;
    if timestamp.offset().local_minus_utc() != 0
        || !timestamp.timestamp_subsec_nanos().is_multiple_of(1_000_000)
    {
        return Err(room_binding_invalid());
    }
    Ok(timestamp.with_timezone(&Utc))
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn room_progress_count_is_bounded_before_rows_are_read() {
        let connection = Connection::open_in_memory().expect("open in-memory database");
        connection.execute_batch(SCHEMA_SQL).expect("create schema");
        let row_limit = i64::try_from(MAX_BOOTSTRAP_ROOM_ANCHORS + 1).expect("row limit");
        connection
            .execute(
                "WITH RECURSIVE numbers(value) AS (
                     SELECT 1
                     UNION ALL
                     SELECT value + 1 FROM numbers WHERE value < ?1
                 )
                 INSERT INTO room_progress
                     (room_lookup, anchor_event_cipher, anchor_event_nonce,
                      key_version, updated_at)
                 SELECT CAST(printf('%032d', value) AS BLOB), zeroblob(1), zeroblob(24),
                        1, '2023-11-14T22:13:20+00:00'
                 FROM numbers",
                [row_limit],
            )
            .expect("insert bounded fixture rows");

        assert_eq!(
            bounded_room_progress_count(&connection),
            Err(store_sync_corrupt())
        );
    }

    #[test]
    fn stored_ciphertext_length_rejects_out_of_bound_values_before_open() {
        for max_plaintext_bytes in [
            MAX_BOOTSTRAP_SESSION_BYTES,
            MAX_SYNC_TOKEN_BYTES,
            MAX_ROOM_ANCHOR_BYTES,
        ] {
            let too_short = vec![0_u8; AEAD_TAG_BYTES - 1];
            assert_eq!(
                validate_stored_ciphertext_length(&too_short, max_plaintext_bytes),
                Err(store_sync_corrupt())
            );

            let too_long = vec![0_u8; max_plaintext_bytes + AEAD_TAG_BYTES + 1];
            assert_eq!(
                validate_stored_ciphertext_length(&too_long, max_plaintext_bytes),
                Err(store_sync_corrupt())
            );
        }
    }
}
