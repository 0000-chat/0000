//! Crash-safe gateway state-store foundation.
//!
//! This module owns the gateway SQLite connection and its process-wide lock.
//! The connection is deliberately private: higher-level gateway code will add
//! domain transactions here rather than passing a raw connection around.

use std::{
    collections::{HashMap, HashSet},
    fmt,
    fs::{File, OpenOptions, symlink_metadata},
    os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt},
    path::Path,
    time::Duration,
};

use chrono::{DateTime, Utc};
use rusqlite::{Connection, OptionalExtension, Row, TransactionBehavior, params, types::ValueRef};
use rustix::fs::{FlockOperation, OFlags, flock};
use sha2::{Digest, Sha256};

use crate::{
    config::{GATEWAY_SCHEMA_VERSION, MAX_PENDING_REQUEST_ROWS, MAX_RECOVERY_BYTES},
    crypto::{AEAD_TAG_BYTES, Keyring, Sealed},
    model,
    registry::{
        NewRoomBinding, RoomBinding, RoomBindingPayload, RoomBindingStatus,
        account_lookup as registry_account_lookup, room_lookup as registry_room_lookup,
        valid_binding_id as registry_valid_binding_id,
    },
    secret::{SafeError, SecretBytes},
    store_types::{
        InboxId, MAX_BOOTSTRAP_ROOM_ANCHORS, MAX_BOOTSTRAP_SESSION_BYTES, MAX_ROOM_ANCHOR_BYTES,
        MAX_SYNC_RESPONSE_BYTES, MAX_SYNC_TOKEN_BYTES, NewBootstrapState, NewRawSyncInbox,
        RawSyncInbox, ReasonCode, SdkInboxPosition, SyncInboxState,
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

struct StoredSyncInboxRow {
    inbox_id: String,
    predecessor_id: Option<String>,
    request_token_cipher: Vec<u8>,
    request_token_nonce: Vec<u8>,
    request_token_key_version: i64,
    request_token_digest: Vec<u8>,
    next_token_cipher: Vec<u8>,
    next_token_nonce: Vec<u8>,
    next_token_key_version: i64,
    next_token_digest: Vec<u8>,
    response_cipher: Vec<u8>,
    response_nonce: Vec<u8>,
    response_key_version: i64,
    response_sha256: Vec<u8>,
    byte_count: i64,
    state: String,
    crypto_drained: i64,
    observed_at: String,
    created_at: String,
    sdk_processed_at: Option<String>,
    prepared_at: Option<String>,
    committed_at: Option<String>,
    terminal_code: Option<String>,
}

#[derive(Clone, Copy)]
enum GatewayTokenField {
    Committed,
    Fetch,
}

impl GatewayTokenField {
    const fn column(self) -> &'static str {
        match self {
            Self::Committed => "committed_token",
            Self::Fetch => "fetch_token",
        }
    }
}

struct RetainedInboxBounds {
    row_count: usize,
    total_bytes: u64,
}

struct VerifiedInboxChain {
    rows: Vec<RawSyncInbox>,
    next_digest_index: HashMap<[u8; 32], usize>,
    tail_index: Option<usize>,
    first_uncommitted_index: Option<usize>,
}

const SYNC_INBOX_ID_BYTES: usize = "inbox_".len() + 64;
const SYNC_INBOX_STATE_MAX_BYTES: usize = "sdk_processed".len();
const SYNC_TIMESTAMP_MAX_BYTES: usize = 64;
const SYNC_TERMINAL_CODE_MAX_BYTES: usize = 64;
const SYNC_NONCE_BYTES: usize = 24;

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

    /// Append one fetched response and advance only the fetch position.
    pub fn append_fetched_sync(&mut self, response: NewRawSyncInbox) -> Result<InboxId, SafeError> {
        response.validate()?;
        let request_token = response.request_token().as_bytes();
        let next_token = response.next_token().as_bytes();
        let response_bytes = response.response().as_bytes();
        let request_token_digest = sha256(request_token);
        let next_token_digest = sha256(next_token);
        let response_sha256 = sha256(response_bytes);
        let inbox_id =
            derive_inbox_id(&request_token_digest, &next_token_digest, &response_sha256)?;
        let request_token_sealed = self
            .keyring
            .seal(
                "sync_inbox",
                inbox_id.as_str(),
                "request_token",
                request_token,
            )
            .map_err(|_| store_sync_invalid())?;
        let next_token_sealed = self
            .keyring
            .seal("sync_inbox", inbox_id.as_str(), "next_token", next_token)
            .map_err(|_| store_sync_invalid())?;
        let response_sealed = self
            .keyring
            .seal("sync_inbox", inbox_id.as_str(), "response", response_bytes)
            .map_err(|_| store_sync_invalid())?;
        let fetch_token_sealed = self
            .keyring
            .seal("gateway_state", "1", "fetch_token", next_token)
            .map_err(|_| store_sync_invalid())?;
        let observed_at = response.observed_at().to_rfc3339();

        let keyring = &self.keyring;
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| store_sync_invalid())?;
        let _gateway = require_bootstrap_singleton(&transaction, keyring, true)?
            .ok_or_else(store_not_bootstrapped)?;
        let row_scan_limit = sync_inbox_scan_limit()?;

        let mut statement = transaction
            .prepare(
                "SELECT inbox_id, predecessor_id,
                        request_token_cipher, request_token_nonce, request_token_key_version,
                        request_token_digest,
                        next_token_cipher, next_token_nonce, next_token_key_version,
                        next_token_digest,
                        response_cipher, response_nonce, response_key_version, response_sha256,
                        byte_count, state, crypto_drained, observed_at, created_at,
                        sdk_processed_at, prepared_at, committed_at, terminal_code
                 FROM sync_inbox
                 WHERE inbox_id = ?1
                    OR request_token_digest = ?2
                    OR next_token_digest = ?3
                 LIMIT ?4",
            )
            .map_err(|_| store_sync_corrupt())?;
        let mut rows = statement
            .query(params![
                inbox_id.as_str(),
                request_token_digest.as_slice(),
                next_token_digest.as_slice(),
                row_scan_limit,
            ])
            .map_err(|_| store_sync_corrupt())?;
        let mut exact_id = None;
        let mut conflict = false;
        while let Some(row) = rows.next().map_err(|_| store_sync_corrupt())? {
            let stored = read_stored_sync_inbox_row(row).map_err(|_| store_sync_corrupt())?;
            let verified = read_and_verify_inbox_row(stored, keyring)?;
            let exact = verified.request_token().as_bytes() == request_token
                && verified.next_token().as_bytes() == next_token
                && verified.response().as_bytes() == response_bytes;
            if exact {
                if exact_id.replace(verified.inbox_id().clone()).is_some() {
                    conflict = true;
                }
            } else {
                conflict = true;
            }
        }
        drop(rows);
        drop(statement);
        if conflict {
            return Err(store_sync_conflict());
        }
        if let Some(existing_id) = exact_id {
            let current_fetch =
                load_verified_gateway_token(&transaction, keyring, GatewayTokenField::Fetch)?;
            let committed_token =
                load_verified_gateway_token(&transaction, keyring, GatewayTokenField::Committed)?;
            verify_inbox_chain(&transaction, keyring, &committed_token, &current_fetch)?;
            drop(transaction);
            return Ok(existing_id);
        }

        let current_fetch =
            load_verified_gateway_token(&transaction, keyring, GatewayTokenField::Fetch)?;
        if current_fetch.as_bytes() != request_token {
            return Err(store_sync_token_mismatch());
        }
        let committed_token =
            load_verified_gateway_token(&transaction, keyring, GatewayTokenField::Committed)?;
        let chain = verify_inbox_chain(&transaction, keyring, &committed_token, &current_fetch)?;
        if let Some(tail) = chain.tail()
            && response.observed_at() < tail.observed_at()
        {
            return Err(store_sync_invalid());
        }

        let retained_bounds = retained_inbox_bounds(&transaction)?;
        let new_response_bytes =
            u64::try_from(response_bytes.len()).map_err(|_| store_sync_too_large())?;
        if u64::try_from(retained_bounds.row_count)
            .ok()
            .is_none_or(|count| count >= MAX_PENDING_REQUEST_ROWS)
            || checked_sync_inbox_bytes(retained_bounds.total_bytes, new_response_bytes).is_err()
        {
            return Err(store_sync_too_large());
        }

        transaction
            .execute(
                "INSERT INTO sync_inbox
                 (inbox_id, predecessor_id,
                  request_token_cipher, request_token_nonce, request_token_key_version,
                  request_token_digest,
                  next_token_cipher, next_token_nonce, next_token_key_version,
                  next_token_digest,
                  response_cipher, response_nonce, response_key_version, response_sha256,
                  byte_count, state, crypto_drained, observed_at, created_at,
                  sdk_processed_at, prepared_at, committed_at, terminal_code)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10,
                         ?11, ?12, ?13, ?14, ?15, 'fetched', 0, ?16, ?16,
                         NULL, NULL, NULL, NULL)",
                params![
                    inbox_id.as_str(),
                    chain.tail().map(|row| row.inbox_id().as_str()),
                    request_token_sealed.ciphertext.as_slice(),
                    request_token_sealed.nonce.as_slice(),
                    i64::from(request_token_sealed.key_version),
                    request_token_digest.as_slice(),
                    next_token_sealed.ciphertext.as_slice(),
                    next_token_sealed.nonce.as_slice(),
                    i64::from(next_token_sealed.key_version),
                    next_token_digest.as_slice(),
                    response_sealed.ciphertext.as_slice(),
                    response_sealed.nonce.as_slice(),
                    i64::from(response_sealed.key_version),
                    response_sha256.as_slice(),
                    i64::try_from(response_bytes.len()).map_err(|_| store_sync_too_large())?,
                    observed_at,
                ],
            )
            .map_err(|_| store_sync_corrupt())?;
        let updated = transaction
            .execute(
                "UPDATE gateway_state
                 SET fetch_token_cipher = ?1, fetch_token_nonce = ?2,
                     fetch_token_key_version = ?3, updated_at = ?4
                 WHERE singleton = 1",
                params![
                    fetch_token_sealed.ciphertext.as_slice(),
                    fetch_token_sealed.nonce.as_slice(),
                    i64::from(fetch_token_sealed.key_version),
                    observed_at,
                ],
            )
            .map_err(|_| store_sync_corrupt())?;
        if updated != 1 {
            return Err(store_sync_corrupt());
        }
        transaction.commit().map_err(|_| store_sync_corrupt())?;
        Ok(inbox_id)
    }

    /// Reconcile an SDK token digest with the committed or journaled chain.
    pub fn reconcile_sdk_position(
        &self,
        sdk_token_digest: &[u8],
    ) -> Result<SdkInboxPosition, SafeError> {
        if sdk_token_digest.len() != 32 {
            return Err(store_sync_invalid());
        }
        let Some(_gateway) = require_bootstrap_singleton(&self.connection, &self.keyring, true)?
        else {
            return Err(store_not_bootstrapped());
        };
        let committed_token = load_verified_gateway_token(
            &self.connection,
            &self.keyring,
            GatewayTokenField::Committed,
        )?;
        let fetch_token =
            load_verified_gateway_token(&self.connection, &self.keyring, GatewayTokenField::Fetch)?;
        let sdk_token_digest: [u8; 32] = sdk_token_digest
            .try_into()
            .map_err(|_| store_sync_invalid())?;
        let chain = verify_inbox_chain(
            &self.connection,
            &self.keyring,
            &committed_token,
            &fetch_token,
        )?;
        if sha256(committed_token.as_bytes()) == sdk_token_digest {
            return Ok(SdkInboxPosition::Committed);
        }
        chain
            .next_digest_index
            .get(&sdk_token_digest)
            .map(|index| SdkInboxPosition::Journaled {
                inbox_id: chain.rows[*index].inbox_id().clone(),
            })
            .ok_or_else(store_sdk_position_unjournaled)
    }

    /// Return the committed sync token as a newly owned protected value.
    pub fn committed_sync_token(&self) -> Result<Option<SecretBytes>, SafeError> {
        let Some(_gateway) = require_bootstrap_singleton(&self.connection, &self.keyring, true)?
        else {
            return Ok(None);
        };
        load_verified_gateway_token(
            &self.connection,
            &self.keyring,
            GatewayTokenField::Committed,
        )
        .map(Some)
    }

    /// Return the latest fetched sync token as a newly owned protected value.
    pub fn fetch_sync_token(&self) -> Result<Option<SecretBytes>, SafeError> {
        let Some(_gateway) = require_bootstrap_singleton(&self.connection, &self.keyring, true)?
        else {
            return Ok(None);
        };
        load_verified_gateway_token(&self.connection, &self.keyring, GatewayTokenField::Fetch)
            .map(Some)
    }

    /// Return the first row after the contiguous committed prefix.
    pub fn oldest_uncommitted_inbox(&self) -> Result<Option<RawSyncInbox>, SafeError> {
        let Some(_gateway) = require_bootstrap_singleton(&self.connection, &self.keyring, true)?
        else {
            return Err(store_not_bootstrapped());
        };
        let committed_token = load_verified_gateway_token(
            &self.connection,
            &self.keyring,
            GatewayTokenField::Committed,
        )?;
        let fetch_token =
            load_verified_gateway_token(&self.connection, &self.keyring, GatewayTokenField::Fetch)?;
        let chain = verify_inbox_chain(
            &self.connection,
            &self.keyring,
            &committed_token,
            &fetch_token,
        )?;
        Ok(chain.into_first_uncommitted())
    }

    /// Return the authenticated Matrix session after validating store state.
    pub fn matrix_session(&self) -> Result<Option<SecretBytes>, SafeError> {
        let retained_bounds = retained_inbox_bounds(&self.connection)?;
        let gateway_count = self
            .connection
            .query_row("SELECT COUNT(*) FROM gateway_state", [], |row| {
                row.get::<_, i64>(0)
            })
            .map_err(|_| store_sync_corrupt())?;
        let room_progress_count = bounded_room_progress_count(&self.connection)?;
        if gateway_count == 0 && room_progress_count == 0 && retained_bounds.row_count == 0 {
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

        let retained_bounds = retained_inbox_bounds(&self.connection)?;
        let gateway_count = self
            .connection
            .query_row("SELECT COUNT(*) FROM gateway_state", [], |row| {
                row.get::<_, i64>(0)
            })
            .map_err(|_| store_sync_corrupt())?;
        let room_progress_count = bounded_room_progress_count(&self.connection)?;
        if gateway_count == 0 && room_progress_count == 0 && retained_bounds.row_count == 0 {
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

fn store_not_bootstrapped() -> SafeError {
    SafeError::new(STORE_NOT_BOOTSTRAPPED)
}

fn store_sync_invalid() -> SafeError {
    SafeError::new(STORE_SYNC_INVALID)
}

fn store_sync_too_large() -> SafeError {
    SafeError::new(STORE_SYNC_TOO_LARGE)
}

fn store_sync_token_mismatch() -> SafeError {
    SafeError::new(STORE_SYNC_TOKEN_MISMATCH)
}

fn store_sync_conflict() -> SafeError {
    SafeError::new(STORE_SYNC_CONFLICT)
}

fn store_sync_corrupt() -> SafeError {
    SafeError::new(STORE_SYNC_CORRUPT)
}

fn store_sdk_position_unjournaled() -> SafeError {
    SafeError::new(STORE_SDK_POSITION_UNJOURNALED)
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
    let max_token_ciphertext = MAX_SYNC_TOKEN_BYTES
        .checked_add(AEAD_TAG_BYTES)
        .ok_or_else(store_sync_corrupt)?;
    let max_session_ciphertext = MAX_BOOTSTRAP_SESSION_BYTES
        .checked_add(AEAD_TAG_BYTES)
        .ok_or_else(store_sync_corrupt)?;
    let max_key_version = i64::from(u32::MAX);
    let mut statement = connection
        .prepare(
            "SELECT singleton, session_cipher, session_nonce, session_key_version,
                    committed_token_cipher, committed_token_nonce, committed_token_key_version,
                    fetch_token_cipher, fetch_token_nonce, fetch_token_key_version,
                    maintenance_code, maintenance_since, bootstrapped_at, updated_at
             FROM gateway_state LIMIT 2",
        )
        .map_err(|_| store_sync_corrupt())?;
    let mut rows = statement.query([]).map_err(|_| store_sync_corrupt())?;
    let Some(row) = rows.next().map_err(|_| store_sync_corrupt())? else {
        return Ok(None);
    };
    let gateway = StoredGatewayStateRow {
        singleton: read_sync_integer(row, 0, 1, 1)?,
        session_cipher: read_optional_sync_blob(row, 1, AEAD_TAG_BYTES, max_session_ciphertext)?,
        session_nonce: read_optional_sync_blob(row, 2, SYNC_NONCE_BYTES, SYNC_NONCE_BYTES)?,
        session_key_version: read_optional_sync_integer(row, 3, 1, max_key_version)?,
        committed_token_cipher: read_optional_sync_blob(
            row,
            4,
            AEAD_TAG_BYTES,
            max_token_ciphertext,
        )?,
        committed_token_nonce: read_optional_sync_blob(row, 5, SYNC_NONCE_BYTES, SYNC_NONCE_BYTES)?,
        committed_token_key_version: read_optional_sync_integer(row, 6, 1, max_key_version)?,
        fetch_token_cipher: read_optional_sync_blob(row, 7, AEAD_TAG_BYTES, max_token_ciphertext)?,
        fetch_token_nonce: read_optional_sync_blob(row, 8, SYNC_NONCE_BYTES, SYNC_NONCE_BYTES)?,
        fetch_token_key_version: read_optional_sync_integer(row, 9, 1, max_key_version)?,
        maintenance_code: read_optional_sync_text(
            row,
            10,
            SYNC_TERMINAL_CODE_MAX_BYTES,
            valid_maintenance_code,
        )?,
        maintenance_since: read_optional_sync_text(
            row,
            11,
            SYNC_TIMESTAMP_MAX_BYTES,
            valid_stored_utc_millisecond,
        )?,
        bootstrapped_at: read_optional_sync_text(
            row,
            12,
            SYNC_TIMESTAMP_MAX_BYTES,
            valid_stored_utc_millisecond,
        )?,
        updated_at: read_optional_sync_text(
            row,
            13,
            SYNC_TIMESTAMP_MAX_BYTES,
            valid_stored_utc_millisecond,
        )?,
    };
    if rows.next().map_err(|_| store_sync_corrupt())?.is_some() {
        return Err(store_sync_corrupt());
    }
    Ok(Some(gateway))
}

fn require_bootstrap_singleton(
    connection: &Connection,
    keyring: &Keyring,
    validate_rooms: bool,
) -> Result<Option<StoredGatewayStateRow>, SafeError> {
    let gateway_count = connection
        .query_row("SELECT COUNT(*) FROM gateway_state", [], |row| {
            row.get::<_, i64>(0)
        })
        .map_err(|_| store_sync_corrupt())?;
    let room_progress_count = bounded_room_progress_count(connection)?;
    let retained_bounds = retained_inbox_bounds(connection)?;
    if gateway_count == 0 {
        if room_progress_count != 0 || retained_bounds.row_count != 0 {
            return Err(store_sync_corrupt());
        }
        return Ok(None);
    }
    if gateway_count != 1 {
        return Err(store_sync_corrupt());
    }
    let gateway = read_stored_gateway_state(connection)?.ok_or_else(store_sync_corrupt)?;
    validate_stored_gateway_state(keyring, &gateway)?;
    if validate_rooms {
        validate_stored_room_progress(connection, keyring, room_progress_count, None)?;
    }
    Ok(Some(gateway))
}

fn load_verified_gateway_token(
    connection: &Connection,
    keyring: &Keyring,
    field: GatewayTokenField,
) -> Result<SecretBytes, SafeError> {
    let gateway = read_stored_gateway_state(connection)?.ok_or_else(store_not_bootstrapped)?;
    if gateway.singleton != 1 {
        return Err(store_sync_corrupt());
    }
    validate_stored_gateway_state(keyring, &gateway)?;
    let (ciphertext, nonce, key_version) = match field {
        GatewayTokenField::Committed => (
            gateway.committed_token_cipher.as_deref(),
            gateway.committed_token_nonce.as_deref(),
            gateway.committed_token_key_version,
        ),
        GatewayTokenField::Fetch => (
            gateway.fetch_token_cipher.as_deref(),
            gateway.fetch_token_nonce.as_deref(),
            gateway.fetch_token_key_version,
        ),
    };
    let plaintext = open_stored_value(
        keyring,
        StoredValue {
            table: "gateway_state",
            row_id: "1",
            column: field.column(),
            ciphertext,
            nonce,
            key_version,
            max_plaintext_bytes: MAX_SYNC_TOKEN_BYTES,
        },
    )?;
    Ok(SecretBytes::new(plaintext.as_bytes().to_vec()))
}

fn sha256(bytes: &[u8]) -> [u8; 32] {
    Sha256::digest(bytes).into()
}

fn lowercase_hex(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut output = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        output.push(char::from(DIGITS[(byte >> 4) as usize]));
        output.push(char::from(DIGITS[(byte & 0x0f) as usize]));
    }
    output
}

fn derive_inbox_id(
    request_token_digest: &[u8; 32],
    next_token_digest: &[u8; 32],
    response_sha256: &[u8; 32],
) -> Result<InboxId, SafeError> {
    let prefix = b"matrix-sync-inbox-v1";
    let framed_capacity = 4_usize
        .checked_add(prefix.len())
        .and_then(|capacity| capacity.checked_add(4 + 32))
        .and_then(|capacity| capacity.checked_add(4 + 32))
        .and_then(|capacity| capacity.checked_add(4 + 32))
        .ok_or_else(store_sync_invalid)?;
    let mut framed = Vec::with_capacity(framed_capacity);
    for value in [
        prefix.as_slice(),
        request_token_digest.as_slice(),
        next_token_digest.as_slice(),
        response_sha256.as_slice(),
    ] {
        let length = u32::try_from(value.len()).map_err(|_| store_sync_invalid())?;
        framed.extend_from_slice(&length.to_be_bytes());
        framed.extend_from_slice(value);
    }
    let digest = sha256(&framed);
    InboxId::new(format!("inbox_{}", lowercase_hex(&digest))).map_err(|_| store_sync_invalid())
}

fn read_stored_sync_inbox_row(row: &Row<'_>) -> Result<StoredSyncInboxRow, SafeError> {
    let max_token_ciphertext = MAX_SYNC_TOKEN_BYTES
        .checked_add(AEAD_TAG_BYTES)
        .ok_or_else(store_sync_corrupt)?;
    let max_key_version = i64::from(u32::MAX);
    let max_byte_count =
        i64::try_from(MAX_SYNC_RESPONSE_BYTES).map_err(|_| store_sync_corrupt())?;
    let byte_count = read_sync_integer(row, 14, 1, max_byte_count)?;
    let max_response_ciphertext = usize::try_from(byte_count)
        .ok()
        .and_then(|count| count.checked_add(AEAD_TAG_BYTES))
        .ok_or_else(store_sync_corrupt)?;

    Ok(StoredSyncInboxRow {
        inbox_id: read_sync_text(row, 0, SYNC_INBOX_ID_BYTES, valid_stored_inbox_id)?,
        predecessor_id: read_optional_sync_text(
            row,
            1,
            SYNC_INBOX_ID_BYTES,
            valid_stored_inbox_id,
        )?,
        request_token_cipher: read_sync_blob(row, 2, AEAD_TAG_BYTES, max_token_ciphertext)?,
        request_token_nonce: read_sync_blob(row, 3, SYNC_NONCE_BYTES, SYNC_NONCE_BYTES)?,
        request_token_key_version: read_sync_integer(row, 4, 1, max_key_version)?,
        request_token_digest: read_sync_blob(row, 5, 32, 32)?,
        next_token_cipher: read_sync_blob(row, 6, AEAD_TAG_BYTES, max_token_ciphertext)?,
        next_token_nonce: read_sync_blob(row, 7, SYNC_NONCE_BYTES, SYNC_NONCE_BYTES)?,
        next_token_key_version: read_sync_integer(row, 8, 1, max_key_version)?,
        next_token_digest: read_sync_blob(row, 9, 32, 32)?,
        response_cipher: read_sync_blob(row, 10, AEAD_TAG_BYTES, max_response_ciphertext)?,
        response_nonce: read_sync_blob(row, 11, SYNC_NONCE_BYTES, SYNC_NONCE_BYTES)?,
        response_key_version: read_sync_integer(row, 12, 1, max_key_version)?,
        response_sha256: read_sync_blob(row, 13, 32, 32)?,
        byte_count,
        state: read_sync_text(row, 15, SYNC_INBOX_STATE_MAX_BYTES, valid_stored_sync_state)?,
        crypto_drained: read_sync_integer(row, 16, 0, 1)?,
        observed_at: read_sync_text(
            row,
            17,
            SYNC_TIMESTAMP_MAX_BYTES,
            valid_stored_utc_millisecond,
        )?,
        created_at: read_sync_text(
            row,
            18,
            SYNC_TIMESTAMP_MAX_BYTES,
            valid_stored_utc_millisecond,
        )?,
        sdk_processed_at: read_optional_sync_text(
            row,
            19,
            SYNC_TIMESTAMP_MAX_BYTES,
            valid_stored_utc_millisecond,
        )?,
        prepared_at: read_optional_sync_text(
            row,
            20,
            SYNC_TIMESTAMP_MAX_BYTES,
            valid_stored_utc_millisecond,
        )?,
        committed_at: read_optional_sync_text(
            row,
            21,
            SYNC_TIMESTAMP_MAX_BYTES,
            valid_stored_utc_millisecond,
        )?,
        terminal_code: read_optional_sync_text(
            row,
            22,
            SYNC_TERMINAL_CODE_MAX_BYTES,
            valid_stored_reason_code,
        )?,
    })
}

fn read_sync_blob(
    row: &Row<'_>,
    index: usize,
    min_bytes: usize,
    max_bytes: usize,
) -> Result<Vec<u8>, SafeError> {
    match row.get_ref(index).map_err(|_| store_sync_corrupt())? {
        ValueRef::Blob(bytes) if (min_bytes..=max_bytes).contains(&bytes.len()) => {
            Ok(bytes.to_vec())
        }
        _ => Err(store_sync_corrupt()),
    }
}

fn read_optional_sync_blob(
    row: &Row<'_>,
    index: usize,
    min_bytes: usize,
    max_bytes: usize,
) -> Result<Option<Vec<u8>>, SafeError> {
    match row.get_ref(index).map_err(|_| store_sync_corrupt())? {
        ValueRef::Null => Ok(None),
        ValueRef::Blob(bytes) if (min_bytes..=max_bytes).contains(&bytes.len()) => {
            Ok(Some(bytes.to_vec()))
        }
        _ => Err(store_sync_corrupt()),
    }
}

fn read_sync_text(
    row: &Row<'_>,
    index: usize,
    max_bytes: usize,
    validator: fn(&str) -> bool,
) -> Result<String, SafeError> {
    let bytes = match row.get_ref(index).map_err(|_| store_sync_corrupt())? {
        ValueRef::Text(bytes) if bytes.len() <= max_bytes => bytes,
        _ => return Err(store_sync_corrupt()),
    };
    let value = std::str::from_utf8(bytes).map_err(|_| store_sync_corrupt())?;
    if !validator(value) {
        return Err(store_sync_corrupt());
    }
    Ok(value.to_owned())
}

fn read_optional_sync_text(
    row: &Row<'_>,
    index: usize,
    max_bytes: usize,
    validator: fn(&str) -> bool,
) -> Result<Option<String>, SafeError> {
    let value = match row.get_ref(index).map_err(|_| store_sync_corrupt())? {
        ValueRef::Null => return Ok(None),
        ValueRef::Text(bytes) if bytes.len() <= max_bytes => {
            std::str::from_utf8(bytes).map_err(|_| store_sync_corrupt())?
        }
        _ => return Err(store_sync_corrupt()),
    };
    if !validator(value) {
        return Err(store_sync_corrupt());
    }
    Ok(Some(value.to_owned()))
}

fn read_sync_integer(
    row: &Row<'_>,
    index: usize,
    min_value: i64,
    max_value: i64,
) -> Result<i64, SafeError> {
    match row.get_ref(index).map_err(|_| store_sync_corrupt())? {
        ValueRef::Integer(value) if (min_value..=max_value).contains(&value) => Ok(value),
        _ => Err(store_sync_corrupt()),
    }
}

fn read_optional_sync_integer(
    row: &Row<'_>,
    index: usize,
    min_value: i64,
    max_value: i64,
) -> Result<Option<i64>, SafeError> {
    match row.get_ref(index).map_err(|_| store_sync_corrupt())? {
        ValueRef::Null => Ok(None),
        ValueRef::Integer(value) if (min_value..=max_value).contains(&value) => Ok(Some(value)),
        _ => Err(store_sync_corrupt()),
    }
}

fn valid_stored_inbox_id(value: &str) -> bool {
    value.len() == SYNC_INBOX_ID_BYTES
        && value.starts_with("inbox_")
        && value.as_bytes()["inbox_".len()..]
            .iter()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(byte))
}

fn valid_stored_sync_state(value: &str) -> bool {
    matches!(
        value,
        "fetched" | "sdk_processed" | "prepared" | "committed" | "quarantined"
    )
}

fn valid_stored_reason_code(value: &str) -> bool {
    let bytes = value.as_bytes();
    if !(3..=SYNC_TERMINAL_CODE_MAX_BYTES).contains(&bytes.len()) {
        return false;
    }
    if !matches!(bytes.first(), Some(b'a'..=b'z'))
        || !matches!(bytes.last(), Some(b'a'..=b'z' | b'0'..=b'9'))
    {
        return false;
    }
    bytes.iter().enumerate().all(|(index, byte)| {
        matches!(byte, b'a'..=b'z' | b'0'..=b'9' | b'_')
            && (index == 0 || *byte != b'_' || bytes[index - 1] != b'_')
    })
}

impl VerifiedInboxChain {
    fn tail(&self) -> Option<&RawSyncInbox> {
        self.tail_index.map(|index| &self.rows[index])
    }

    fn into_first_uncommitted(self) -> Option<RawSyncInbox> {
        let index = self.first_uncommitted_index?;
        self.rows.into_iter().nth(index)
    }
}

fn sync_inbox_scan_limit() -> Result<i64, SafeError> {
    MAX_PENDING_REQUEST_ROWS
        .checked_add(1)
        .and_then(|limit| i64::try_from(limit).ok())
        .ok_or_else(store_sync_corrupt)
}

fn checked_sync_inbox_bytes(current_total: u64, new_bytes: u64) -> Result<u64, ()> {
    current_total
        .checked_add(new_bytes)
        .filter(|total| *total <= MAX_RECOVERY_BYTES)
        .ok_or(())
}

fn retained_inbox_bounds(connection: &Connection) -> Result<RetainedInboxBounds, SafeError> {
    let row_scan_limit = sync_inbox_scan_limit()?;
    let max_byte_count =
        u64::try_from(MAX_SYNC_RESPONSE_BYTES).map_err(|_| store_sync_corrupt())?;
    let mut statement = connection
        .prepare(
            "SELECT byte_count FROM sync_inbox
             ORDER BY rowid LIMIT ?1",
        )
        .map_err(|_| store_sync_corrupt())?;
    let mut rows = statement
        .query(params![row_scan_limit])
        .map_err(|_| store_sync_corrupt())?;
    let mut row_count = 0_u64;
    let mut total_bytes = 0_u64;
    while let Some(row) = rows.next().map_err(|_| store_sync_corrupt())? {
        row_count = row_count.checked_add(1).ok_or_else(store_sync_corrupt)?;
        if row_count > MAX_PENDING_REQUEST_ROWS {
            return Err(store_sync_corrupt());
        }
        let byte_count = u64::try_from(read_sync_integer(
            row,
            0,
            1,
            i64::try_from(MAX_SYNC_RESPONSE_BYTES).map_err(|_| store_sync_corrupt())?,
        )?)
        .map_err(|_| store_sync_corrupt())?;
        if byte_count > max_byte_count {
            return Err(store_sync_corrupt());
        }
        total_bytes =
            checked_sync_inbox_bytes(total_bytes, byte_count).map_err(|_| store_sync_corrupt())?;
    }
    Ok(RetainedInboxBounds {
        row_count: usize::try_from(row_count).map_err(|_| store_sync_corrupt())?,
        total_bytes,
    })
}

fn parse_stored_timestamp(value: &str) -> Result<DateTime<Utc>, SafeError> {
    if !valid_stored_utc_millisecond(value) {
        return Err(store_sync_corrupt());
    }
    DateTime::parse_from_rfc3339(value)
        .map(|timestamp| timestamp.with_timezone(&Utc))
        .map_err(|_| store_sync_corrupt())
}

fn digest_from_blob(value: &[u8]) -> Result<[u8; 32], SafeError> {
    value.try_into().map_err(|_| store_sync_corrupt())
}

fn read_and_verify_inbox_row(
    row: StoredSyncInboxRow,
    keyring: &Keyring,
) -> Result<RawSyncInbox, SafeError> {
    let inbox_id = InboxId::new(row.inbox_id).map_err(|_| store_sync_corrupt())?;
    let predecessor_id = row
        .predecessor_id
        .map(|value| InboxId::new(value).map_err(|_| store_sync_corrupt()))
        .transpose()?;
    if predecessor_id.as_ref().is_some_and(|id| id == &inbox_id) {
        return Err(store_sync_corrupt());
    }
    let request_token_digest = digest_from_blob(&row.request_token_digest)?;
    let next_token_digest = digest_from_blob(&row.next_token_digest)?;
    let response_sha256 = digest_from_blob(&row.response_sha256)?;
    let byte_count = usize::try_from(row.byte_count).map_err(|_| store_sync_corrupt())?;
    if byte_count == 0 || byte_count > MAX_SYNC_RESPONSE_BYTES {
        return Err(store_sync_corrupt());
    }
    let state = SyncInboxState::from_str(&row.state).map_err(|_| store_sync_corrupt())?;
    let crypto_drained = match row.crypto_drained {
        0 => false,
        1 => true,
        _ => return Err(store_sync_corrupt()),
    };
    let observed_at = parse_stored_timestamp(&row.observed_at)?;
    let created_at = parse_stored_timestamp(&row.created_at)?;
    if observed_at != created_at {
        return Err(store_sync_corrupt());
    }
    let sdk_processed_at = row
        .sdk_processed_at
        .as_deref()
        .map(parse_stored_timestamp)
        .transpose()?;
    let prepared_at = row
        .prepared_at
        .as_deref()
        .map(parse_stored_timestamp)
        .transpose()?;
    let committed_at = row
        .committed_at
        .as_deref()
        .map(parse_stored_timestamp)
        .transpose()?;
    let terminal_code = row
        .terminal_code
        .map(ReasonCode::new)
        .transpose()
        .map_err(|_| store_sync_corrupt())?;

    let request_token = open_stored_value(
        keyring,
        StoredValue {
            table: "sync_inbox",
            row_id: inbox_id.as_str(),
            column: "request_token",
            ciphertext: Some(row.request_token_cipher.as_slice()),
            nonce: Some(row.request_token_nonce.as_slice()),
            key_version: Some(row.request_token_key_version),
            max_plaintext_bytes: MAX_SYNC_TOKEN_BYTES,
        },
    )?;
    let next_token = open_stored_value(
        keyring,
        StoredValue {
            table: "sync_inbox",
            row_id: inbox_id.as_str(),
            column: "next_token",
            ciphertext: Some(row.next_token_cipher.as_slice()),
            nonce: Some(row.next_token_nonce.as_slice()),
            key_version: Some(row.next_token_key_version),
            max_plaintext_bytes: MAX_SYNC_TOKEN_BYTES,
        },
    )?;
    let response = open_stored_value(
        keyring,
        StoredValue {
            table: "sync_inbox",
            row_id: inbox_id.as_str(),
            column: "response",
            ciphertext: Some(row.response_cipher.as_slice()),
            nonce: Some(row.response_nonce.as_slice()),
            key_version: Some(row.response_key_version),
            max_plaintext_bytes: MAX_SYNC_RESPONSE_BYTES,
        },
    )?;
    if sha256(request_token.as_bytes()) != request_token_digest
        || sha256(next_token.as_bytes()) != next_token_digest
        || sha256(response.as_bytes()) != response_sha256
        || response.len() != byte_count
    {
        return Err(store_sync_corrupt());
    }
    if derive_inbox_id(&request_token_digest, &next_token_digest, &response_sha256)? != inbox_id {
        return Err(store_sync_corrupt());
    }

    RawSyncInbox::from_verified_parts(
        inbox_id,
        predecessor_id,
        request_token.as_bytes().to_vec(),
        request_token_digest,
        next_token.as_bytes().to_vec(),
        next_token_digest,
        response.as_bytes().to_vec(),
        response_sha256,
        byte_count,
        state,
        crypto_drained,
        observed_at,
        created_at,
        sdk_processed_at,
        prepared_at,
        committed_at,
        terminal_code,
    )
    .map_err(|_| store_sync_corrupt())
}

fn verify_inbox_chain(
    connection: &Connection,
    keyring: &Keyring,
    committed_token: &SecretBytes,
    fetch_token: &SecretBytes,
) -> Result<VerifiedInboxChain, SafeError> {
    let bounds = retained_inbox_bounds(connection)?;
    let row_scan_limit = sync_inbox_scan_limit()?;
    let mut statement = connection
        .prepare(
            "SELECT inbox_id, predecessor_id,
                    request_token_cipher, request_token_nonce, request_token_key_version,
                    request_token_digest,
                    next_token_cipher, next_token_nonce, next_token_key_version,
                    next_token_digest,
                    response_cipher, response_nonce, response_key_version, response_sha256,
                    byte_count, state, crypto_drained, observed_at, created_at,
                    sdk_processed_at, prepared_at, committed_at, terminal_code
             FROM sync_inbox ORDER BY rowid LIMIT ?1",
        )
        .map_err(|_| store_sync_corrupt())?;
    let mut rows = statement
        .query(params![row_scan_limit])
        .map_err(|_| store_sync_corrupt())?;
    let mut verified_rows = Vec::with_capacity(bounds.row_count);
    while let Some(row) = rows.next().map_err(|_| store_sync_corrupt())? {
        if verified_rows.len() >= bounds.row_count {
            return Err(store_sync_corrupt());
        }
        let stored = read_stored_sync_inbox_row(row)?;
        verified_rows.push(read_and_verify_inbox_row(stored, keyring)?);
    }
    drop(rows);
    drop(statement);
    if verified_rows.len() != bounds.row_count {
        return Err(store_sync_corrupt());
    }
    let mut total_bytes = 0_u64;
    for row in &verified_rows {
        total_bytes = checked_sync_inbox_bytes(
            total_bytes,
            u64::try_from(row.byte_count()).map_err(|_| store_sync_corrupt())?,
        )
        .map_err(|_| store_sync_corrupt())?;
    }
    if total_bytes != bounds.total_bytes {
        return Err(store_sync_corrupt());
    }

    if verified_rows.is_empty() {
        if committed_token.as_bytes() != fetch_token.as_bytes() {
            return Err(store_sync_corrupt());
        }
        return Ok(VerifiedInboxChain {
            rows: verified_rows,
            next_digest_index: HashMap::new(),
            tail_index: None,
            first_uncommitted_index: None,
        });
    }

    let row_capacity = verified_rows.len();
    let mut id_index = HashMap::with_capacity(row_capacity);
    let mut successor_index = HashMap::with_capacity(row_capacity);
    let mut request_digest_index = HashMap::with_capacity(row_capacity);
    let mut next_digest_index = HashMap::with_capacity(row_capacity);
    let mut root_index = None;
    for (index, row) in verified_rows.iter().enumerate() {
        if id_index
            .insert(row.inbox_id().as_str().to_owned(), index)
            .is_some()
            || next_digest_index
                .insert(*row.next_token_digest(), index)
                .is_some()
            || request_digest_index
                .insert(*row.request_token_digest(), index)
                .is_some()
        {
            return Err(store_sync_corrupt());
        }
        match row.predecessor_id() {
            Some(predecessor_id) => {
                if successor_index
                    .insert(predecessor_id.as_str().to_owned(), index)
                    .is_some()
                {
                    return Err(store_sync_corrupt());
                }
            }
            None => {
                if root_index.replace(index).is_some() {
                    return Err(store_sync_corrupt());
                }
            }
        }
    }
    let root_index = root_index.ok_or_else(store_sync_corrupt)?;
    let mut visited = vec![false; row_capacity];
    let mut current = Some(root_index);
    let mut previous_index: Option<usize> = None;
    let mut tail_index = None;
    let mut first_uncommitted_index = None;
    let mut committed_tail_index = None;
    while let Some(index) = current {
        if visited[index] {
            return Err(store_sync_corrupt());
        }
        visited[index] = true;
        let row = &verified_rows[index];
        if let Some(previous_index) = previous_index {
            let previous = &verified_rows[previous_index];
            if row
                .predecessor_id()
                .is_none_or(|id| id != previous.inbox_id())
                || row.request_token().as_bytes() != previous.next_token().as_bytes()
                || row.request_token_digest() != previous.next_token_digest()
                || row.observed_at() < previous.observed_at()
            {
                return Err(store_sync_corrupt());
            }
        } else if row.predecessor_id().is_some() {
            return Err(store_sync_corrupt());
        }
        if row.state() == SyncInboxState::Committed {
            if first_uncommitted_index.is_some() {
                return Err(store_sync_corrupt());
            }
            committed_tail_index = Some(index);
        } else if first_uncommitted_index.is_none() {
            first_uncommitted_index = Some(index);
        }
        tail_index = Some(index);
        previous_index = Some(index);
        current = successor_index.get(row.inbox_id().as_str()).copied();
    }
    if visited.iter().any(|was_visited| !was_visited) {
        return Err(store_sync_corrupt());
    }
    let tail_index = tail_index.ok_or_else(store_sync_corrupt)?;
    if verified_rows[tail_index].next_token().as_bytes() != fetch_token.as_bytes() {
        return Err(store_sync_corrupt());
    }
    if let Some(committed_tail_index) = committed_tail_index {
        if verified_rows[committed_tail_index].next_token().as_bytes() != committed_token.as_bytes()
        {
            return Err(store_sync_corrupt());
        }
    } else if verified_rows[root_index].request_token().as_bytes() != committed_token.as_bytes() {
        return Err(store_sync_corrupt());
    }
    Ok(VerifiedInboxChain {
        rows: verified_rows,
        next_digest_index,
        tail_index: Some(tail_index),
        first_uncommitted_index,
    })
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
    let scan_limit = expected_count
        .checked_add(1)
        .ok_or_else(store_sync_corrupt)?;
    let mut statement = connection
        .prepare(
            "SELECT room_lookup, anchor_event_cipher, anchor_event_nonce,
                    key_version, updated_at
             FROM room_progress ORDER BY room_lookup LIMIT ?1",
        )
        .map_err(|_| store_sync_corrupt())?;
    let mut rows = statement
        .query(params![scan_limit])
        .map_err(|_| store_sync_corrupt())?;
    let mut seen_count = 0_i64;
    let mut seen_lookups =
        HashSet::with_capacity(usize::try_from(expected_count).map_err(|_| store_sync_corrupt())?);
    let mut selected = None;
    while let Some(row) = rows.next().map_err(|_| store_sync_corrupt())? {
        seen_count = seen_count.checked_add(1).ok_or_else(store_sync_corrupt)?;
        if seen_count > expected_count || seen_count as usize > MAX_BOOTSTRAP_ROOM_ANCHORS {
            return Err(store_sync_corrupt());
        }
        let stored = StoredRoomProgressRow {
            room_lookup: read_sync_blob(row, 0, 32, 32)?,
            anchor_event_cipher: read_sync_blob(
                row,
                1,
                AEAD_TAG_BYTES,
                MAX_ROOM_ANCHOR_BYTES
                    .checked_add(AEAD_TAG_BYTES)
                    .ok_or_else(store_sync_corrupt)?,
            )?,
            anchor_event_nonce: read_sync_blob(row, 2, SYNC_NONCE_BYTES, SYNC_NONCE_BYTES)?,
            key_version: read_sync_integer(row, 3, 1, i64::from(u32::MAX))?,
            updated_at: Some(read_sync_text(
                row,
                4,
                SYNC_TIMESTAMP_MAX_BYTES,
                valid_stored_utc_millisecond,
            )?),
        };
        if !seen_lookups.insert(stored.room_lookup.clone()) {
            return Err(store_sync_corrupt());
        }
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
    use chrono::TimeZone;
    use rusqlite::types::Value;
    use std::os::unix::fs::PermissionsExt;
    use tempfile::tempdir;

    #[test]
    fn checked_sync_inbox_bytes_accepts_exact_total_and_rejects_one_over() {
        assert_eq!(
            checked_sync_inbox_bytes(MAX_RECOVERY_BYTES - 1, 1),
            Ok(MAX_RECOVERY_BYTES)
        );
        assert_eq!(checked_sync_inbox_bytes(MAX_RECOVERY_BYTES, 1), Err(()));
        assert_eq!(checked_sync_inbox_bytes(u64::MAX, 1), Err(()));
    }

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

    fn sqlite_values(connection: &Connection, query: &str, columns: usize) -> Vec<Vec<Value>> {
        let mut statement = connection
            .prepare(query)
            .expect("prepare test snapshot query");
        statement
            .query_map([], |row| {
                (0..columns)
                    .map(|index| row.get(index))
                    .collect::<Result<Vec<Value>, _>>()
            })
            .expect("query test snapshot")
            .collect::<Result<Vec<_>, _>>()
            .expect("read test snapshot")
    }

    fn store_snapshot(store: &Store) -> (Vec<Vec<Value>>, Vec<Vec<Value>>) {
        (
            sqlite_values(
                &store.connection,
                "SELECT * FROM sync_inbox ORDER BY rowid",
                23,
            ),
            sqlite_values(
                &store.connection,
                "SELECT * FROM gateway_state ORDER BY singleton",
                14,
            ),
        )
    }

    #[test]
    fn append_revalidates_unchecked_test_dtos_without_mutation() {
        let directory = tempdir().expect("create append validation test directory");
        std::fs::set_permissions(directory.path(), std::fs::Permissions::from_mode(0o700))
            .expect("secure append validation test directory");
        let path = directory.path().join("gateway.sqlite3");
        let mut store = Store::open(&path, Keyring::new([0x11; 32], 1).expect("test keyring"))
            .expect("open append validation test store");
        store
            .initialize_bootstrap_state(
                NewBootstrapState::new(
                    b"session".to_vec(),
                    b"initial".to_vec(),
                    Vec::new(),
                    Utc.timestamp_millis_opt(1_700_000_000_000)
                        .single()
                        .expect("test timestamp"),
                )
                .expect("construct bootstrap test state"),
            )
            .expect("initialize append validation test store");

        let cases = vec![
            (
                b"initial".to_vec(),
                b"next-1".to_vec(),
                Vec::new(),
                STORE_SYNC_INVALID,
            ),
            (
                b"initial".to_vec(),
                b"next-1".to_vec(),
                vec![0xE1; MAX_SYNC_RESPONSE_BYTES + 1],
                STORE_SYNC_TOO_LARGE,
            ),
            (
                Vec::new(),
                b"next-1".to_vec(),
                b"response".to_vec(),
                STORE_SYNC_INVALID,
            ),
            (
                b"initial".to_vec(),
                Vec::new(),
                b"response".to_vec(),
                STORE_SYNC_INVALID,
            ),
            (
                vec![0xE2; MAX_SYNC_TOKEN_BYTES + 1],
                b"next-1".to_vec(),
                b"response".to_vec(),
                STORE_SYNC_TOO_LARGE,
            ),
            (
                b"initial".to_vec(),
                vec![0xE3; MAX_SYNC_TOKEN_BYTES + 1],
                b"response".to_vec(),
                STORE_SYNC_TOO_LARGE,
            ),
        ];
        for (request_token, next_token, response, expected_code) in cases {
            let before = store_snapshot(&store);
            let error = store
                .append_fetched_sync(NewRawSyncInbox::new_unchecked_for_test(
                    request_token,
                    next_token,
                    response,
                    Utc.timestamp_millis_opt(1_700_000_001_000)
                        .single()
                        .expect("test timestamp"),
                ))
                .expect_err("unchecked invalid DTO must be rejected by append");
            assert_eq!(error.code(), expected_code);
            assert_eq!(store_snapshot(&store), before);
        }
    }
}
