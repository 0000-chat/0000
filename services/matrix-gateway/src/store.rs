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

use chrono::{DateTime, Duration as ChronoDuration, Utc};
use rusqlite::{
    Connection, OptionalExtension, Row, TransactionBehavior, ffi, params, types::ValueRef,
};
use rustix::fs::{FlockOperation, OFlags, flock};
use sha2::{Digest, Sha256};

use crate::{
    config::{GATEWAY_SCHEMA_VERSION, MAX_PENDING_REQUEST_ROWS, MAX_RECOVERY_BYTES},
    crypto::{AEAD_TAG_BYTES, Keyring, Sealed},
    crypto_outbox::{
        CryptoMaintenanceStatus, CryptoRowId, ExactMatrixRequest, MATRIX_CRYPTO_REQUEST_KIND,
        MAX_MATRIX_CRYPTO_REQUEST_BYTES, MAX_MATRIX_CRYPTO_RESPONSE_BYTES,
        MAX_SDK_REQUEST_ID_BYTES, PendingMatrixRequest, RawMatrixResponse, SavedMatrixResponse,
        validate_canonical_request_bytes, validate_json_object,
    },
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

mod backfill_ledger;
mod live_ledger;

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
/// Stable error returned for malformed or conflicting attachment descriptors.
pub const STORE_ATTACHMENT_INVALID: &str = "store_attachment_invalid";
/// Stable error returned when one attachment revision is rebound to different
/// protected Matrix media metadata.
pub const STORE_ATTACHMENT_CONFLICT: &str = "store_attachment_conflict";
/// Stable error returned when an outbound text journal entry is malformed.
pub const STORE_OUTBOUND_INVALID: &str = "store_outbound_invalid";
/// Stable error returned when an outbound transaction conflicts with a
/// previously committed request.
pub const STORE_OUTBOUND_CONFLICT: &str = "store_outbound_conflict";
/// Stable error returned when an outbound journal row cannot be authenticated.
pub const STORE_OUTBOUND_CORRUPT: &str = "store_outbound_corrupt";

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
/// Stable error returned when a crypto request is malformed.
pub const STORE_CRYPTO_INVALID: &str = "store_crypto_invalid";
/// Stable error returned when a crypto request exceeds a frozen bound.
pub const STORE_CRYPTO_TOO_LARGE: &str = "store_crypto_too_large";
/// Stable error returned when crypto processing cannot advance yet.
pub const STORE_CRYPTO_NOT_READY: &str = "store_crypto_not_ready";
/// Stable error returned when another unresolved crypto request exists.
pub const STORE_CRYPTO_UNRESOLVED: &str = "store_crypto_unresolved";
/// Stable error returned for an exact crypto request conflict.
pub const STORE_CRYPTO_CONFLICT: &str = "store_crypto_conflict";
/// Stable error returned for corrupt crypto or linked inbox state.
pub const STORE_CRYPTO_CORRUPT: &str = "store_crypto_corrupt";

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
CREATE TABLE attachment_descriptors(
  attachment_lookup BLOB PRIMARY KEY,
  payload_cipher BLOB NOT NULL, payload_nonce BLOB NOT NULL,
  key_version INTEGER NOT NULL, updated_at TEXT NOT NULL
);
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
CREATE TABLE outbound_transactions(
  transaction_id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL,
  request_digest TEXT NOT NULL CHECK(length(request_digest) = 64),
  body_digest BLOB NOT NULL CHECK(length(body_digest) = 32),
  tenant_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  identity_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  matrix_room_id TEXT NOT NULL,
  session_generation TEXT NOT NULL,
  projection_generation INTEGER NOT NULL CHECK(projection_generation > 0),
  body_cipher BLOB NOT NULL, body_nonce BLOB NOT NULL,
  body_key_version INTEGER NOT NULL,
  state TEXT NOT NULL,
  matrix_stage TEXT NOT NULL,
  bridge_stage TEXT NOT NULL,
  provider_stage TEXT NOT NULL,
  response_cipher BLOB, response_nonce BLOB, response_key_version INTEGER,
  response_sha256 BLOB,
  matrix_evidence_cipher BLOB, matrix_evidence_nonce BLOB,
  matrix_evidence_key_version INTEGER,
  bridge_evidence_cipher BLOB, bridge_evidence_nonce BLOB,
  bridge_evidence_key_version INTEGER,
  provider_evidence_cipher BLOB, provider_evidence_nonce BLOB,
  provider_evidence_key_version INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK(state IN ('pending','accepted','uncertain','rejected','rate_limited',
                 'session_expired','missing_capability')),
  CHECK(matrix_stage IN ('unknown','confirmed')),
  CHECK(bridge_stage IN ('unknown','accepted','uncertain')),
  CHECK(provider_stage IN ('unknown','accepted','delivered','uncertain')),
  CHECK((response_cipher IS NULL AND response_nonce IS NULL
         AND response_key_version IS NULL AND response_sha256 IS NULL)
     OR (response_cipher IS NOT NULL AND response_nonce IS NOT NULL
         AND response_key_version IS NOT NULL AND response_sha256 IS NOT NULL)),
  CHECK((matrix_evidence_cipher IS NULL AND matrix_evidence_nonce IS NULL
         AND matrix_evidence_key_version IS NULL)
     OR (matrix_evidence_cipher IS NOT NULL AND matrix_evidence_nonce IS NOT NULL
         AND matrix_evidence_key_version IS NOT NULL)),
  CHECK((bridge_evidence_cipher IS NULL AND bridge_evidence_nonce IS NULL
         AND bridge_evidence_key_version IS NULL)
     OR (bridge_evidence_cipher IS NOT NULL AND bridge_evidence_nonce IS NOT NULL
         AND bridge_evidence_key_version IS NOT NULL)),
  CHECK((provider_evidence_cipher IS NULL AND provider_evidence_nonce IS NULL
         AND provider_evidence_key_version IS NULL)
     OR (provider_evidence_cipher IS NOT NULL AND provider_evidence_nonce IS NOT NULL
         AND provider_evidence_key_version IS NOT NULL))
);
CREATE UNIQUE INDEX outbound_transaction_scope
  ON outbound_transactions(tenant_id, transaction_id);
"#;

// Schema version 1 stores created before the attachment boundary did not
// contain this additive table. Keep the version stable and install the table
// before the exact schema-object check below.
const ATTACHMENT_DESCRIPTOR_MIGRATION_SQL: &str = r#"
CREATE TABLE IF NOT EXISTS attachment_descriptors(
  attachment_lookup BLOB PRIMARY KEY,
  payload_cipher BLOB NOT NULL, payload_nonce BLOB NOT NULL,
  key_version INTEGER NOT NULL, updated_at TEXT NOT NULL
);
"#;

// Version 1 stores predate the outbound text boundary. Keep the schema
// version stable while installing this additive, authenticated journal table
// before the exact schema-object check.
const OUTBOUND_TRANSACTION_MIGRATION_SQL: &str = r#"
CREATE TABLE IF NOT EXISTS outbound_transactions(
  transaction_id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL,
  request_digest TEXT NOT NULL CHECK(length(request_digest) = 64),
  body_digest BLOB NOT NULL CHECK(length(body_digest) = 32),
  tenant_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  identity_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  matrix_room_id TEXT NOT NULL,
  session_generation TEXT NOT NULL,
  projection_generation INTEGER NOT NULL CHECK(projection_generation > 0),
  body_cipher BLOB NOT NULL, body_nonce BLOB NOT NULL,
  body_key_version INTEGER NOT NULL,
  state TEXT NOT NULL,
  matrix_stage TEXT NOT NULL,
  bridge_stage TEXT NOT NULL,
  provider_stage TEXT NOT NULL,
  response_cipher BLOB, response_nonce BLOB, response_key_version INTEGER,
  response_sha256 BLOB,
  matrix_evidence_cipher BLOB, matrix_evidence_nonce BLOB,
  matrix_evidence_key_version INTEGER,
  bridge_evidence_cipher BLOB, bridge_evidence_nonce BLOB,
  bridge_evidence_key_version INTEGER,
  provider_evidence_cipher BLOB, provider_evidence_nonce BLOB,
  provider_evidence_key_version INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK(state IN ('pending','accepted','uncertain','rejected','rate_limited',
                 'session_expired','missing_capability')),
  CHECK(matrix_stage IN ('unknown','confirmed')),
  CHECK(bridge_stage IN ('unknown','accepted','uncertain')),
  CHECK(provider_stage IN ('unknown','accepted','delivered','uncertain')),
  CHECK((response_cipher IS NULL AND response_nonce IS NULL
         AND response_key_version IS NULL AND response_sha256 IS NULL)
     OR (response_cipher IS NOT NULL AND response_nonce IS NOT NULL
         AND response_key_version IS NOT NULL AND response_sha256 IS NOT NULL)),
  CHECK((matrix_evidence_cipher IS NULL AND matrix_evidence_nonce IS NULL
         AND matrix_evidence_key_version IS NULL)
     OR (matrix_evidence_cipher IS NOT NULL AND matrix_evidence_nonce IS NOT NULL
         AND matrix_evidence_key_version IS NOT NULL)),
  CHECK((bridge_evidence_cipher IS NULL AND bridge_evidence_nonce IS NULL
         AND bridge_evidence_key_version IS NULL)
     OR (bridge_evidence_cipher IS NOT NULL AND bridge_evidence_nonce IS NOT NULL
         AND bridge_evidence_key_version IS NOT NULL)),
  CHECK((provider_evidence_cipher IS NULL AND provider_evidence_nonce IS NULL
         AND provider_evidence_key_version IS NULL)
     OR (provider_evidence_cipher IS NOT NULL AND provider_evidence_nonce IS NOT NULL
         AND provider_evidence_key_version IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS outbound_transaction_scope
  ON outbound_transactions(tenant_id, transaction_id);
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

struct StoredCryptoRow {
    crypto_row_id: String,
    inbox_id: String,
    request_lookup: Vec<u8>,
    request_kind: String,
    sdk_request_id_cipher: Vec<u8>,
    sdk_request_id_nonce: Vec<u8>,
    sdk_request_id_key_version: i64,
    request_cipher: Vec<u8>,
    request_nonce: Vec<u8>,
    request_key_version: i64,
    request_sha256: Vec<u8>,
    byte_count: i64,
    response_cipher: Option<Vec<u8>>,
    response_nonce: Option<Vec<u8>>,
    response_key_version: Option<i64>,
    response_sha256: Option<Vec<u8>>,
    state: String,
    attempt_count: i64,
    next_attempt_at: String,
    accepted_at: Option<String>,
    terminal_code: Option<String>,
}

/// Input for one provider-neutral outbound text journal entry.  The body is
/// sealed by `Store` before SQLite is touched; callers never write plaintext
/// content through a raw connection.
#[derive(Clone)]
pub struct NewOutboundText {
    pub transaction_id: String,
    pub idempotency_key: String,
    pub request_digest: String,
    pub tenant_id: String,
    pub account_id: String,
    pub connection_id: String,
    pub identity_id: String,
    pub conversation_id: String,
    pub message_id: String,
    pub event_id: String,
    pub matrix_room_id: String,
    pub session_generation: String,
    pub projection_generation: u64,
    pub body: String,
    pub created_at: DateTime<Utc>,
}

/// The result of claiming an outbound transaction before Matrix I/O.
pub enum OutboundTextPreparation {
    /// This request inserted a new pending row and owns the one send attempt.
    Created,
    /// A previous attempt already reached a terminal result. The encrypted
    /// response is returned for an idempotent replay.
    ExistingTerminal { response: Vec<u8> },
    /// A previous process committed the journal but did not record a result.
    /// The caller must surface uncertainty and must not send again.
    ExistingPending,
}

/// Durable stage/result update for one outbound transaction.  Evidence is
/// encrypted separately by stage so a missing bridge or provider receipt is
/// represented as unknown rather than promoted from Matrix acceptance.
pub struct OutboundTextCompletion {
    pub state: String,
    pub matrix_stage: String,
    pub bridge_stage: String,
    pub provider_stage: String,
    pub response: Vec<u8>,
    pub matrix_evidence: Option<Vec<u8>>,
    pub bridge_evidence: Option<Vec<u8>>,
    pub provider_evidence: Option<Vec<u8>>,
    pub updated_at: DateTime<Utc>,
}

struct StoredOutboundTextRow {
    transaction_id: String,
    idempotency_key: String,
    request_digest: String,
    body_digest: Vec<u8>,
    tenant_id: String,
    account_id: String,
    connection_id: String,
    identity_id: String,
    conversation_id: String,
    message_id: String,
    event_id: String,
    matrix_room_id: String,
    session_generation: String,
    projection_generation: i64,
    body_cipher: Vec<u8>,
    body_nonce: Vec<u8>,
    body_key_version: i64,
    state: String,
    response_cipher: Option<Vec<u8>>,
    response_nonce: Option<Vec<u8>>,
    response_key_version: Option<i64>,
    response_sha256: Option<Vec<u8>>,
    created_at: String,
    updated_at: String,
}

struct StoredCryptoResponseFields {
    cipher: Option<Vec<u8>>,
    nonce: Option<Vec<u8>>,
    key_version: Option<i64>,
    sha256: Option<Vec<u8>>,
}

#[derive(Clone, Copy, Eq, PartialEq)]
enum CryptoLifecycle {
    Pending,
    ResponseReceived,
    Accepted,
    Quarantined,
}

impl CryptoLifecycle {
    fn from_str(value: &str) -> Result<Self, SafeError> {
        match value {
            "pending" => Ok(Self::Pending),
            "response_received" => Ok(Self::ResponseReceived),
            "accepted" => Ok(Self::Accepted),
            "quarantined" => Ok(Self::Quarantined),
            _ => Err(store_crypto_corrupt()),
        }
    }
}

#[allow(dead_code)]
struct VerifiedCryptoRow {
    crypto_row_id: CryptoRowId,
    inbox_id: InboxId,
    request_lookup: [u8; 32],
    sdk_request_id: SecretBytes,
    request: SecretBytes,
    request_sha256: [u8; 32],
    byte_count: usize,
    request_nonce: [u8; 24],
    response: Option<SecretBytes>,
    response_sha256: Option<[u8; 32]>,
    state: CryptoLifecycle,
    attempt_count: u32,
    next_attempt_at: DateTime<Utc>,
    accepted_at: Option<DateTime<Utc>>,
    terminal_code: Option<ReasonCode>,
}

struct PreparedCryptoRequest<'a> {
    request: &'a ExactMatrixRequest,
    request_lookup: [u8; 32],
    crypto_row_id: CryptoRowId,
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

/// Content-free pressure metrics for retained inbox and crypto request state.
pub(crate) struct InboxCryptoPressure {
    pending_request_rows: u64,
    protected_bytes: u64,
    oldest_pending_at: Option<DateTime<Utc>>,
    next_retention_at: Option<DateTime<Utc>>,
}

impl InboxCryptoPressure {
    /// Return the number of unresolved crypto request rows.
    pub(crate) const fn pending_request_rows(&self) -> u64 {
        self.pending_request_rows
    }

    /// Return the bytes protected by retained inbox and crypto request rows.
    pub(crate) const fn protected_bytes(&self) -> u64 {
        self.protected_bytes
    }

    /// Return the oldest inbox or unresolved crypto retry timestamp.
    pub(crate) const fn oldest_pending_at(&self) -> Option<DateTime<Utc>> {
        self.oldest_pending_at
    }

    /// Return the strict retention deadline for the oldest purgeable row.
    pub(crate) const fn next_retention_at(&self) -> Option<DateTime<Utc>> {
        self.next_retention_at
    }
}

struct VerifiedInboxChain {
    rows: Vec<RawSyncInbox>,
    next_digest_index: HashMap<[u8; 32], usize>,
    ordered_indices: Vec<usize>,
    tail_index: Option<usize>,
    /// Physical SQLite row index retained for live-ledger selection.
    first_uncommitted_index: Option<usize>,
    first_uncommitted_position: Option<usize>,
}

struct VerifiedCryptoContext {
    gateway: StoredGatewayStateRow,
    chain: VerifiedInboxChain,
    crypto_rows: Vec<VerifiedCryptoRow>,
}

const SYNC_INBOX_ID_BYTES: usize = "inbox_".len() + 64;
const SYNC_INBOX_STATE_MAX_BYTES: usize = "sdk_processed".len();
const SYNC_TIMESTAMP_MAX_BYTES: usize = 64;
const SYNC_TERMINAL_CODE_MAX_BYTES: usize = 64;
const ATTACHMENT_DESCRIPTOR_MAX_BYTES: usize = 32 * 1024;
const ATTACHMENT_DESCRIPTOR_FIELD_COUNT: usize = 9;
const SYNC_NONCE_BYTES: usize = 24;
const CRYPTO_ROW_ID_BYTES: usize = "crypto_".len() + 64;
const CRYPTO_REQUEST_KIND_MAX_BYTES: usize = MATRIX_CRYPTO_REQUEST_KIND.len();
const CRYPTO_STATE_MAX_BYTES: usize = "response_received".len();
const CRYPTO_ATTEMPT_COUNT_MAX: i64 = 1_000_000;

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

    /// Commit one outbound request before any Matrix or bridge I/O occurs.
    ///
    /// The transaction ID is the provider-neutral idempotency key. A matching
    /// request replays its stored response; a matching journal entry without
    /// a response is deliberately returned as pending so a restart cannot
    /// authorize a second send.
    pub fn prepare_outbound_text(
        &mut self,
        input: NewOutboundText,
    ) -> Result<OutboundTextPreparation, SafeError> {
        validate_outbound_text_input(&input)?;
        let body_digest = sha256(input.body.as_bytes());
        let body_sealed = self
            .keyring
            .seal(
                "outbound_transactions",
                &input.transaction_id,
                "body",
                input.body.as_bytes(),
            )
            .map_err(|_| SafeError::new(STORE_OUTBOUND_INVALID))?;
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| SafeError::new(STORE_OUTBOUND_INVALID))?;
        let existing = transaction
            .query_row(
                "SELECT transaction_id, idempotency_key, request_digest, body_digest,
                        tenant_id, account_id, connection_id, identity_id,
                        conversation_id, message_id, event_id, matrix_room_id,
                        session_generation, projection_generation,
                        body_cipher, body_nonce, body_key_version, state,
                        response_cipher, response_nonce, response_key_version,
                        response_sha256, created_at, updated_at
                 FROM outbound_transactions
                 WHERE tenant_id = ?1 AND transaction_id = ?2
                 LIMIT 1",
                params![input.tenant_id.as_str(), input.transaction_id.as_str()],
                read_stored_outbound_row,
            )
            .optional()
            .map_err(|_| SafeError::new(STORE_OUTBOUND_CORRUPT))?;

        if let Some(row) = existing {
            let body = open_outbound_body(&self.keyring, &row)?;
            if !outbound_matches(&row, &input, &body_digest, body.as_slice()) {
                return Err(SafeError::new(STORE_OUTBOUND_CONFLICT));
            }
            let result = if row.state == "pending" {
                OutboundTextPreparation::ExistingPending
            } else {
                let response = open_outbound_response(&self.keyring, &row)?
                    .ok_or_else(|| SafeError::new(STORE_OUTBOUND_CORRUPT))?;
                OutboundTextPreparation::ExistingTerminal { response }
            };
            transaction
                .commit()
                .map_err(|_| SafeError::new(STORE_OUTBOUND_CORRUPT))?;
            return Ok(result);
        }

        let created_at = input.created_at.to_rfc3339();
        transaction
            .execute(
                "INSERT INTO outbound_transactions
                 (transaction_id, idempotency_key, request_digest, body_digest,
                  tenant_id, account_id, connection_id, identity_id,
                  conversation_id, message_id, event_id, matrix_room_id,
                  session_generation, projection_generation,
                  body_cipher, body_nonce, body_key_version, state,
                  matrix_stage, bridge_stage, provider_stage,
                  response_cipher, response_nonce, response_key_version,
                  response_sha256, matrix_evidence_cipher, matrix_evidence_nonce,
                  matrix_evidence_key_version, bridge_evidence_cipher,
                  bridge_evidence_nonce, bridge_evidence_key_version,
                  provider_evidence_cipher, provider_evidence_nonce,
                  provider_evidence_key_version, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12,
                         ?13, ?14, ?15, ?16, ?17, 'pending', 'unknown',
                         'unknown', 'unknown', NULL, NULL, NULL, NULL, NULL,
                         NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
                         ?18, ?18)",
                params![
                    input.transaction_id,
                    input.idempotency_key,
                    input.request_digest,
                    body_digest.as_slice(),
                    input.tenant_id,
                    input.account_id,
                    input.connection_id,
                    input.identity_id,
                    input.conversation_id,
                    input.message_id,
                    input.event_id,
                    input.matrix_room_id,
                    input.session_generation,
                    i64::try_from(input.projection_generation)
                        .map_err(|_| SafeError::new(STORE_OUTBOUND_INVALID))?,
                    body_sealed.ciphertext.as_slice(),
                    body_sealed.nonce.as_slice(),
                    i64::from(body_sealed.key_version),
                    created_at,
                ],
            )
            .map_err(|_| SafeError::new(STORE_OUTBOUND_CORRUPT))?;
        transaction
            .commit()
            .map_err(|_| SafeError::new(STORE_OUTBOUND_CORRUPT))?;
        Ok(OutboundTextPreparation::Created)
    }

    /// Persist the result of the one authorized outbound attempt. Once this
    /// method records a non-pending state, subsequent duplicate deliveries
    /// only replay the authenticated response.
    pub fn complete_outbound_text(
        &mut self,
        tenant_id: &str,
        transaction_id: &str,
        request_digest: &str,
        completion: OutboundTextCompletion,
    ) -> Result<(), SafeError> {
        if !valid_resource_id_for_store(tenant_id)
            || !valid_resource_id_for_store(transaction_id)
            || !valid_digest(request_digest)
            || !valid_outbound_state(&completion.state)
            || !valid_matrix_stage(&completion.matrix_stage)
            || !valid_bridge_stage(&completion.bridge_stage)
            || !valid_provider_stage(&completion.provider_stage)
            || completion.response.is_empty()
            || completion.response.len() > 64 * 1024
            || !model::valid_timestamp(&completion.updated_at.to_rfc3339())
        {
            return Err(SafeError::new(STORE_OUTBOUND_INVALID));
        }
        if completion.state == "pending" {
            return Err(SafeError::new(STORE_OUTBOUND_INVALID));
        }
        let response_sealed = self
            .keyring
            .seal(
                "outbound_transactions",
                transaction_id,
                "response",
                &completion.response,
            )
            .map_err(|_| SafeError::new(STORE_OUTBOUND_INVALID))?;
        let matrix_evidence = seal_optional_outbound_value(
            &self.keyring,
            transaction_id,
            "matrix_evidence",
            completion.matrix_evidence.as_deref(),
        )?;
        let bridge_evidence = seal_optional_outbound_value(
            &self.keyring,
            transaction_id,
            "bridge_evidence",
            completion.bridge_evidence.as_deref(),
        )?;
        let provider_evidence = seal_optional_outbound_value(
            &self.keyring,
            transaction_id,
            "provider_evidence",
            completion.provider_evidence.as_deref(),
        )?;
        let response_sha256 = sha256(&completion.response);
        let updated_at = completion.updated_at.to_rfc3339();
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| SafeError::new(STORE_OUTBOUND_CORRUPT))?;
        let current: Option<(String, String)> = transaction
            .query_row(
                "SELECT state, matrix_stage FROM outbound_transactions
                 WHERE tenant_id = ?1 AND transaction_id = ?2
                   AND request_digest = ?3 LIMIT 1",
                params![tenant_id, transaction_id, request_digest],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()
            .map_err(|_| SafeError::new(STORE_OUTBOUND_CORRUPT))?;
        let Some((current_state, current_matrix_stage)) = current else {
            return Err(SafeError::new(STORE_OUTBOUND_CONFLICT));
        };
        if current_state != "pending" {
            // A duplicate arriving while the first authorized sender is still
            // in flight may conservatively record `uncertain`.  The original
            // sender can then return with authoritative Matrix confirmation.
            // Preserve that stronger evidence and its replay response without
            // downgrading any bridge/provider evidence already present.
            if matches!(current_state.as_str(), "uncertain" | "accepted")
                && current_matrix_stage != "confirmed"
                && completion.state == "accepted"
                && completion.matrix_stage == "confirmed"
            {
                let updated = transaction
                    .execute(
                        "UPDATE outbound_transactions
                         SET state = 'accepted', matrix_stage = 'confirmed',
                             response_cipher = ?1, response_nonce = ?2,
                             response_key_version = ?3, response_sha256 = ?4,
                             matrix_evidence_cipher = ?5,
                             matrix_evidence_nonce = ?6,
                             matrix_evidence_key_version = ?7,
                             updated_at = ?8
                         WHERE tenant_id = ?9 AND transaction_id = ?10
                           AND request_digest = ?11
                           AND state IN ('uncertain', 'accepted')
                           AND matrix_stage != 'confirmed'",
                        params![
                            response_sealed.ciphertext.as_slice(),
                            response_sealed.nonce.as_slice(),
                            i64::from(response_sealed.key_version),
                            response_sha256.as_slice(),
                            matrix_evidence
                                .as_ref()
                                .map(|value| value.ciphertext.as_slice()),
                            matrix_evidence.as_ref().map(|value| value.nonce.as_slice()),
                            matrix_evidence
                                .as_ref()
                                .map(|value| i64::from(value.key_version)),
                            updated_at,
                            tenant_id,
                            transaction_id,
                            request_digest,
                        ],
                    )
                    .map_err(|_| SafeError::new(STORE_OUTBOUND_CORRUPT))?;
                if updated > 1 {
                    return Err(SafeError::new(STORE_OUTBOUND_CORRUPT));
                }
            }
            transaction
                .commit()
                .map_err(|_| SafeError::new(STORE_OUTBOUND_CORRUPT))?;
            return Ok(());
        }
        let updated = transaction
            .execute(
                "UPDATE outbound_transactions
                 SET state = ?1, matrix_stage = ?2, bridge_stage = ?3,
                     provider_stage = ?4, response_cipher = ?5,
                     response_nonce = ?6, response_key_version = ?7,
                     response_sha256 = ?8, matrix_evidence_cipher = ?9,
                     matrix_evidence_nonce = ?10,
                     matrix_evidence_key_version = ?11,
                     bridge_evidence_cipher = ?12,
                     bridge_evidence_nonce = ?13,
                     bridge_evidence_key_version = ?14,
                     provider_evidence_cipher = ?15,
                     provider_evidence_nonce = ?16,
                     provider_evidence_key_version = ?17,
                     updated_at = ?18
                 WHERE tenant_id = ?19 AND transaction_id = ?20
                   AND request_digest = ?21 AND state = 'pending'",
                params![
                    completion.state,
                    completion.matrix_stage,
                    completion.bridge_stage,
                    completion.provider_stage,
                    response_sealed.ciphertext.as_slice(),
                    response_sealed.nonce.as_slice(),
                    i64::from(response_sealed.key_version),
                    response_sha256.as_slice(),
                    matrix_evidence
                        .as_ref()
                        .map(|value| value.ciphertext.as_slice()),
                    matrix_evidence.as_ref().map(|value| value.nonce.as_slice()),
                    matrix_evidence
                        .as_ref()
                        .map(|value| i64::from(value.key_version)),
                    bridge_evidence
                        .as_ref()
                        .map(|value| value.ciphertext.as_slice()),
                    bridge_evidence.as_ref().map(|value| value.nonce.as_slice()),
                    bridge_evidence
                        .as_ref()
                        .map(|value| i64::from(value.key_version)),
                    provider_evidence
                        .as_ref()
                        .map(|value| value.ciphertext.as_slice()),
                    provider_evidence
                        .as_ref()
                        .map(|value| value.nonce.as_slice()),
                    provider_evidence
                        .as_ref()
                        .map(|value| i64::from(value.key_version)),
                    updated_at,
                    tenant_id,
                    transaction_id,
                    request_digest,
                ],
            )
            .map_err(|_| SafeError::new(STORE_OUTBOUND_CORRUPT))?;
        if updated != 1 {
            return Err(SafeError::new(STORE_OUTBOUND_CONFLICT));
        }
        transaction
            .commit()
            .map_err(|_| SafeError::new(STORE_OUTBOUND_CORRUPT))
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

    /// Atomically mark one fetched response as SDK-processed and persist its
    /// single allowlisted Matrix crypto request, if any.
    pub fn record_sdk_processing(
        &mut self,
        inbox_id: &str,
        requests: &[ExactMatrixRequest],
    ) -> Result<(), SafeError> {
        if !valid_stored_inbox_id(inbox_id) {
            return Err(store_crypto_invalid());
        }
        let target_id = InboxId::new(inbox_id.to_owned()).map_err(|_| store_crypto_invalid())?;
        if requests.len() > 1 {
            return Err(store_crypto_invalid());
        }
        for request in requests {
            request.validate()?;
        }

        let prepared_request = requests
            .first()
            .map(|request| {
                let request_lookup =
                    matrix_request_lookup(&self.keyring, request.request().as_bytes())
                        .map_err(|_| store_crypto_invalid())?;
                let crypto_row_id = derive_crypto_row_id(&target_id, &request_lookup)?;
                Ok(PreparedCryptoRequest {
                    request,
                    request_lookup,
                    crypto_row_id,
                })
            })
            .transpose()?;

        let keyring = &self.keyring;
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| store_crypto_corrupt())?;
        let context = load_crypto_context(&transaction, keyring)?;
        let gateway = &context.gateway;
        let chain = &context.chain;
        let crypto_rows = &context.crypto_rows;
        let target_index = chain
            .rows
            .iter()
            .position(|row| row.inbox_id() == &target_id)
            .ok_or_else(store_crypto_invalid)?;
        let target = &chain.rows[target_index];

        let existing = crypto_rows
            .iter()
            .filter(|row| row.inbox_id == target_id)
            .collect::<Vec<_>>();
        if existing.len() > 1 {
            return Err(store_crypto_corrupt());
        }

        if gateway.maintenance_code.is_some() {
            return Err(store_crypto_not_ready());
        }

        if target.state() == SyncInboxState::Quarantined
            || chain.rows[..target_index]
                .iter()
                .any(|row| row.state() == SyncInboxState::Quarantined)
        {
            return Err(store_crypto_not_ready());
        }

        if target.state() == SyncInboxState::SdkProcessed {
            if target.crypto_drained() {
                return Err(store_crypto_corrupt());
            }
            if existing.first().is_some_and(|stored| {
                stored.state == CryptoLifecycle::Pending
                    && stored.attempt_count == 0
                    && stored.next_attempt_at != *target.observed_at()
            }) {
                return Err(store_crypto_corrupt());
            }
            let exact_retry = match (requests.first(), existing.first()) {
                (None, None) => true,
                (Some(request), Some(stored)) => {
                    stored.sdk_request_id.as_bytes() == request.sdk_request_id().as_bytes()
                        && stored.request.as_bytes() == request.request().as_bytes()
                }
                _ => false,
            };
            drop(transaction);
            return if exact_retry {
                Ok(())
            } else {
                Err(store_crypto_conflict())
            };
        }

        if !existing.is_empty() {
            return Err(store_crypto_corrupt());
        }

        if target.state() != SyncInboxState::Fetched {
            return Err(store_crypto_not_ready());
        }
        if target.crypto_drained()
            || target.sdk_processed_at().is_some()
            || target.prepared_at().is_some()
            || target.committed_at().is_some()
            || target.terminal_code().is_some()
        {
            return Err(store_crypto_corrupt());
        }
        if chain
            .rows
            .iter()
            .position(|row| row.state() == SyncInboxState::Fetched)
            != Some(target_index)
        {
            return Err(store_crypto_not_ready());
        }
        if chain.rows[..target_index].iter().any(|row| {
            !matches!(
                row.state(),
                SyncInboxState::SdkProcessed | SyncInboxState::Prepared | SyncInboxState::Committed
            )
        }) {
            return Err(store_crypto_not_ready());
        }

        if let Some(row) = crypto_rows
            .iter()
            .find(|row| is_unresolved_crypto_state(row.state))
        {
            match row.state {
                CryptoLifecycle::Quarantined => return Err(store_crypto_not_ready()),
                CryptoLifecycle::Pending | CryptoLifecycle::ResponseReceived => {
                    return Err(store_crypto_unresolved());
                }
                CryptoLifecycle::Accepted => return Err(store_crypto_corrupt()),
            }
        }

        if let Some(prepared) = prepared_request.as_ref() {
            let sdk_request_id = keyring
                .seal(
                    "matrix_crypto_outbox",
                    prepared.crypto_row_id.as_str(),
                    "sdk_request_id",
                    prepared.request.sdk_request_id().as_bytes(),
                )
                .map_err(|_| store_crypto_invalid())?;
            let request_cipher = keyring
                .seal(
                    "matrix_crypto_outbox",
                    prepared.crypto_row_id.as_str(),
                    "request",
                    prepared.request.request().as_bytes(),
                )
                .map_err(|_| store_crypto_invalid())?;
            let observed_at = target.observed_at().to_rfc3339();
            transaction
                .execute(
                    "INSERT INTO matrix_crypto_outbox
                     (crypto_row_id, inbox_id, request_lookup, request_kind,
                      sdk_request_id_cipher, sdk_request_id_nonce, sdk_request_id_key_version,
                      request_cipher, request_nonce, request_key_version, request_sha256,
                      byte_count, response_cipher, response_nonce, response_key_version,
                      response_sha256, state, attempt_count, next_attempt_at,
                      accepted_at, terminal_code)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12,
                             NULL, NULL, NULL, NULL, 'pending', 0, ?13, NULL, NULL)",
                    params![
                        prepared.crypto_row_id.as_str(),
                        target_id.as_str(),
                        prepared.request_lookup.as_slice(),
                        MATRIX_CRYPTO_REQUEST_KIND,
                        sdk_request_id.ciphertext.as_slice(),
                        sdk_request_id.nonce.as_slice(),
                        i64::from(sdk_request_id.key_version),
                        request_cipher.ciphertext.as_slice(),
                        request_cipher.nonce.as_slice(),
                        i64::from(request_cipher.key_version),
                        prepared.request.request_sha256().as_slice(),
                        i64::try_from(prepared.request.request().len())
                            .map_err(|_| store_crypto_too_large())?,
                        observed_at,
                    ],
                )
                .map_err(map_crypto_insert_error)?;
        }

        let updated = transaction
            .execute(
                "UPDATE sync_inbox
                 SET state = 'sdk_processed', sdk_processed_at = observed_at
                 WHERE inbox_id = ?1 AND state = 'fetched' AND crypto_drained = 0
                   AND sdk_processed_at IS NULL AND prepared_at IS NULL
                   AND committed_at IS NULL AND terminal_code IS NULL",
                params![target_id.as_str()],
            )
            .map_err(|_| store_crypto_corrupt())?;
        if updated != 1 {
            return Err(store_crypto_corrupt());
        }
        transaction.commit().map_err(|_| store_crypto_corrupt())?;
        Ok(())
    }

    /// Load the one saved Matrix response for restart rebind.
    ///
    /// The caller must invoke this only inside the globally serialized crypto
    /// lane. This method authenticates the complete local context, but it does
    /// not prove any Matrix SDK state or acknowledge a request.
    pub fn saved_crypto_response(&self) -> Result<Option<SavedMatrixResponse>, SafeError> {
        let context = load_crypto_context(&self.connection, &self.keyring)?;
        if context.gateway.maintenance_code.is_some() {
            return Err(store_crypto_not_ready());
        }

        let Some(row) = context
            .crypto_rows
            .into_iter()
            .find(|row| is_unresolved_crypto_state(row.state))
        else {
            return Ok(None);
        };
        match row.state {
            CryptoLifecycle::Pending => Ok(None),
            CryptoLifecycle::ResponseReceived => {
                let response = row.response.ok_or_else(store_crypto_corrupt)?;
                let response_sha256 = row.response_sha256.ok_or_else(store_crypto_corrupt)?;
                Ok(Some(SavedMatrixResponse::from_verified_parts(
                    row.crypto_row_id.as_str().to_owned(),
                    row.request_sha256,
                    response,
                    response_sha256,
                )))
            }
            CryptoLifecycle::Quarantined => Err(store_crypto_not_ready()),
            CryptoLifecycle::Accepted => Err(store_crypto_corrupt()),
        }
    }

    /// Load the persisted global crypto-maintenance marker.
    ///
    /// The later adapter must restore the SDK store without network access and
    /// prove that no forbidden outgoing request or quarantined crypto row
    /// remains before it calls [`Self::clear_crypto_maintenance`].
    pub fn crypto_maintenance_status(&self) -> Result<Option<CryptoMaintenanceStatus>, SafeError> {
        let context = load_crypto_context(&self.connection, &self.keyring)?;
        match (
            context.gateway.maintenance_code,
            context.gateway.maintenance_since,
        ) {
            (None, None) => Ok(None),
            (Some(code), Some(since)) => {
                let code = ReasonCode::new(code).map_err(|_| store_crypto_corrupt())?;
                let since = parse_stored_timestamp(&since).map_err(|_| store_crypto_corrupt())?;
                Ok(Some(CryptoMaintenanceStatus::from_verified_parts(
                    code, since,
                )))
            }
            _ => Err(store_crypto_corrupt()),
        }
    }

    /// Persist the global crypto-maintenance marker.
    ///
    /// The later adapter must establish the SDK-side reason before calling
    /// this method. This method records only the allowlisted local marker and
    /// does not inspect or modify Matrix SDK state.
    pub fn set_crypto_maintenance(
        &mut self,
        code: ReasonCode,
        at: DateTime<Utc>,
    ) -> Result<(), SafeError> {
        if !valid_maintenance_code(code.as_str()) || !valid_utc_millisecond(at) {
            return Err(store_crypto_invalid());
        }

        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| store_crypto_corrupt())?;
        let context = load_crypto_context(&transaction, &self.keyring)?;
        let bootstrapped_at = context
            .gateway
            .bootstrapped_at
            .as_deref()
            .ok_or_else(store_crypto_corrupt)
            .and_then(parse_stored_timestamp)?;
        let updated_at = context
            .gateway
            .updated_at
            .as_deref()
            .ok_or_else(store_crypto_corrupt)
            .and_then(parse_stored_timestamp)?;

        match (
            context.gateway.maintenance_code.as_deref(),
            context.gateway.maintenance_since.as_deref(),
        ) {
            (None, None) => {
                if at < bootstrapped_at || at < updated_at {
                    return Err(store_crypto_invalid());
                }
                let timestamp = at.to_rfc3339();
                let changed = transaction
                    .execute(
                        "UPDATE gateway_state
                         SET maintenance_code = ?1, maintenance_since = ?2, updated_at = ?2
                         WHERE singleton = 1
                           AND maintenance_code IS NULL AND maintenance_since IS NULL",
                        params![code.as_str(), timestamp],
                    )
                    .map_err(|_| store_crypto_corrupt())?;
                if changed != 1 {
                    return Err(store_crypto_conflict());
                }
                transaction.commit().map_err(|_| store_crypto_corrupt())?;
                Ok(())
            }
            (Some(current_code), Some(current_since)) => {
                let current_since =
                    parse_stored_timestamp(current_since).map_err(|_| store_crypto_corrupt())?;
                if current_code == code.as_str() && current_since == at {
                    drop(transaction);
                    return Ok(());
                }
                Err(store_crypto_conflict())
            }
            _ => Err(store_crypto_corrupt()),
        }
    }

    /// Clear the global crypto-maintenance marker after local recovery.
    ///
    /// Before calling this method, the later adapter must restore the SDK
    /// store without network access and prove that no `KeysUpload` or other
    /// forbidden outgoing request remains. The store also requires a clean
    /// authenticated crypto ledger here.
    pub fn clear_crypto_maintenance(&mut self, expected: ReasonCode) -> Result<(), SafeError> {
        if !valid_maintenance_code(expected.as_str()) {
            return Err(store_crypto_invalid());
        }

        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| store_crypto_corrupt())?;
        let context = load_crypto_context(&transaction, &self.keyring)?;
        if context
            .crypto_rows
            .iter()
            .any(|row| is_unresolved_crypto_state(row.state))
        {
            return Err(store_crypto_not_ready());
        }

        match (
            context.gateway.maintenance_code.as_deref(),
            context.gateway.maintenance_since.as_deref(),
        ) {
            (None, None) => {
                drop(transaction);
                Ok(())
            }
            (Some(code), Some(since)) if code == expected.as_str() => {
                let changed = transaction
                    .execute(
                        "UPDATE gateway_state
                         SET maintenance_code = NULL, maintenance_since = NULL
                         WHERE singleton = 1 AND maintenance_code = ?1
                           AND maintenance_since = ?2",
                        params![expected.as_str(), since],
                    )
                    .map_err(|_| store_crypto_corrupt())?;
                if changed != 1 {
                    return Err(store_crypto_conflict());
                }
                transaction.commit().map_err(|_| store_crypto_corrupt())?;
                Ok(())
            }
            (Some(_), Some(_)) => Err(store_crypto_conflict()),
            _ => Err(store_crypto_corrupt()),
        }
    }

    /// Mark one source-ordered SDK-processed inbox as crypto-drained.
    ///
    /// The later adapter must verify that the SDK has no outstanding outgoing
    /// request and, when this inbox had a request, has acknowledged the exact
    /// accepted response before calling this method. This method proves only
    /// the local ledger and source-order conditions.
    pub fn mark_crypto_drained(&mut self, inbox_id: &str) -> Result<(), SafeError> {
        if !valid_stored_inbox_id(inbox_id) {
            return Err(store_crypto_invalid());
        }
        let target_id = InboxId::new(inbox_id.to_owned()).map_err(|_| store_crypto_invalid())?;

        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| store_crypto_corrupt())?;
        let context = load_crypto_context(&transaction, &self.keyring)?;
        if context.gateway.maintenance_code.is_some() {
            return Err(store_crypto_not_ready());
        }
        let Some(target_index) = context
            .chain
            .rows
            .iter()
            .position(|row| row.inbox_id() == &target_id)
        else {
            return Err(store_crypto_not_ready());
        };
        let target = &context.chain.rows[target_index];

        if target.state() != SyncInboxState::SdkProcessed {
            return Err(store_crypto_not_ready());
        }
        if target.sdk_processed_at() != Some(target.observed_at())
            || target.prepared_at().is_some()
            || target.committed_at().is_some()
            || target.terminal_code().is_some()
        {
            return Err(store_crypto_corrupt());
        }

        for earlier in &context.chain.rows[..target_index] {
            if !earlier.crypto_drained()
                || !matches!(
                    earlier.state(),
                    SyncInboxState::SdkProcessed
                        | SyncInboxState::Prepared
                        | SyncInboxState::Committed
                )
            {
                return Err(store_crypto_not_ready());
            }
        }

        for row in &context.crypto_rows {
            let Some(parent_index) = context
                .chain
                .rows
                .iter()
                .position(|candidate| candidate.inbox_id() == &row.inbox_id)
            else {
                return Err(store_crypto_corrupt());
            };
            if parent_index < target_index && row.state != CryptoLifecycle::Accepted {
                return Err(store_crypto_not_ready());
            }
        }

        let target_crypto_rows = context
            .crypto_rows
            .iter()
            .filter(|row| row.inbox_id == target_id)
            .collect::<Vec<_>>();
        match target_crypto_rows.as_slice() {
            [] => {}
            [row]
                if row.state == CryptoLifecycle::Accepted
                    && row.response.is_some()
                    && row.response_sha256.is_some()
                    && row.accepted_at.is_some() => {}
            [_] => return Err(store_crypto_not_ready()),
            _ => return Err(store_crypto_corrupt()),
        }
        if context
            .crypto_rows
            .iter()
            .any(|row| is_unresolved_crypto_state(row.state))
        {
            return Err(store_crypto_not_ready());
        }

        if target.crypto_drained() {
            return Ok(());
        }

        let changed = transaction
            .execute(
                "UPDATE sync_inbox
                 SET crypto_drained = 1
                 WHERE inbox_id = ?1
                   AND state = 'sdk_processed'
                   AND crypto_drained = 0
                   AND sdk_processed_at = observed_at
                   AND prepared_at IS NULL
                   AND committed_at IS NULL
                   AND terminal_code IS NULL",
                params![target_id.as_str()],
            )
            .map_err(|_| store_crypto_corrupt())?;
        if changed != 1 {
            return Err(store_crypto_conflict());
        }
        transaction.commit().map_err(|_| store_crypto_corrupt())?;
        Ok(())
    }

    /// Return one authenticated pending crypto request whose retry time is due.
    pub fn next_pending_crypto_request(
        &self,
        now: DateTime<Utc>,
    ) -> Result<Option<PendingMatrixRequest>, SafeError> {
        if !valid_utc_millisecond(now) {
            return Err(store_crypto_invalid());
        }
        let context = load_crypto_context(&self.connection, &self.keyring)?;
        if context.gateway.maintenance_code.is_some() {
            return Err(store_crypto_not_ready());
        }
        let Some(row) = context
            .crypto_rows
            .into_iter()
            .find(|row| is_unresolved_crypto_state(row.state))
        else {
            return Ok(None);
        };
        match row.state {
            CryptoLifecycle::Pending => {
                if row.next_attempt_at > now {
                    return Ok(None);
                }
                let row_id = row.crypto_row_id.as_str().to_owned();
                Ok(Some(PendingMatrixRequest::from_verified_parts(
                    row_id,
                    row.sdk_request_id,
                    row.request,
                    row.request_sha256,
                    row.attempt_count,
                    row.next_attempt_at,
                )))
            }
            CryptoLifecycle::ResponseReceived | CryptoLifecycle::Quarantined => {
                Err(store_crypto_not_ready())
            }
            CryptoLifecycle::Accepted => Err(store_crypto_corrupt()),
        }
    }

    /// Return whether authenticated pending crypto work exists, even when its
    /// persisted retry deadline has not arrived.
    pub fn has_pending_crypto_request(&self) -> Result<bool, SafeError> {
        let context = load_crypto_context(&self.connection, &self.keyring)?;
        if context.gateway.maintenance_code.is_some() {
            return Err(store_crypto_not_ready());
        }
        Ok(context
            .crypto_rows
            .iter()
            .any(|row| row.state == CryptoLifecycle::Pending))
    }

    /// Return the earliest authenticated retry deadline for pending crypto.
    ///
    /// The selector deliberately reads only the bounded scheduling metadata;
    /// it never reconstructs or exposes a request body.
    pub(crate) fn next_crypto_retry_at(&self) -> Result<Option<DateTime<Utc>>, SafeError> {
        let context = load_crypto_context(&self.connection, &self.keyring)?;
        if context.gateway.maintenance_code.is_some() {
            return Err(store_crypto_not_ready());
        }
        Ok(context
            .crypto_rows
            .iter()
            .filter(|row| row.state == CryptoLifecycle::Pending)
            .map(|row| row.next_attempt_at)
            .min())
    }

    /// Durably lease one pending request before its caller performs HTTP.
    pub fn record_attempt(
        &mut self,
        row: &str,
        expected_attempt_count: u32,
        expected_next_attempt_at: DateTime<Utc>,
        now: DateTime<Utc>,
        next: DateTime<Utc>,
    ) -> Result<(), SafeError> {
        let row_id = CryptoRowId::new(row.to_owned()).map_err(|_| store_crypto_invalid())?;
        if expected_attempt_count > CRYPTO_ATTEMPT_COUNT_MAX as u32
            || !valid_utc_millisecond(expected_next_attempt_at)
            || !valid_utc_millisecond(now)
            || !valid_utc_millisecond(next)
            || next <= now
        {
            return Err(store_crypto_invalid());
        }

        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| store_crypto_corrupt())?;
        let context = load_crypto_context(&transaction, &self.keyring)?;
        let addressed = context
            .crypto_rows
            .iter()
            .find(|candidate| candidate.crypto_row_id == row_id);
        let Some(addressed) = addressed else {
            return Err(store_crypto_not_ready());
        };
        if context.gateway.maintenance_code.is_some() {
            return Err(store_crypto_not_ready());
        }
        if addressed.state != CryptoLifecycle::Pending {
            return Err(store_crypto_not_ready());
        }
        if addressed.attempt_count != expected_attempt_count
            || addressed.next_attempt_at != expected_next_attempt_at
        {
            return Err(store_crypto_conflict());
        }
        if addressed.next_attempt_at > now {
            return Err(store_crypto_not_ready());
        }

        let updated = transaction
            .execute(
                "UPDATE matrix_crypto_outbox
                 SET attempt_count = CASE
                       WHEN attempt_count < ?6 THEN attempt_count + 1
                       ELSE ?6
                     END,
                     next_attempt_at = ?1
                 WHERE crypto_row_id = ?2 AND state = 'pending'
                   AND attempt_count = ?3 AND next_attempt_at = ?4
                   AND next_attempt_at <= ?5",
                params![
                    next.to_rfc3339(),
                    row_id.as_str(),
                    i64::from(expected_attempt_count),
                    expected_next_attempt_at.to_rfc3339(),
                    now.to_rfc3339(),
                    CRYPTO_ATTEMPT_COUNT_MAX,
                ],
            )
            .map_err(|_| store_crypto_corrupt())?;
        if updated != 1 {
            return Err(store_crypto_conflict());
        }
        transaction.commit().map_err(|_| store_crypto_corrupt())?;
        Ok(())
    }

    /// Persist one exact verified response for a leased pending request.
    pub fn record_crypto_response(
        &mut self,
        row: &str,
        response: &RawMatrixResponse,
    ) -> Result<(), SafeError> {
        let row_id = CryptoRowId::new(row.to_owned()).map_err(|_| store_crypto_invalid())?;
        response.validate()?;
        let keyring = &self.keyring;

        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| store_crypto_corrupt())?;
        let context = load_crypto_context(&transaction, &self.keyring)?;
        let addressed = context
            .crypto_rows
            .iter()
            .find(|candidate| candidate.crypto_row_id == row_id);
        let Some(addressed) = addressed else {
            return Err(store_crypto_not_ready());
        };
        if context.gateway.maintenance_code.is_some() {
            return Err(store_crypto_not_ready());
        }
        match addressed.state {
            CryptoLifecycle::Pending => {
                if addressed.attempt_count == 0 {
                    return Err(store_crypto_not_ready());
                }
                let response_sealed = keyring
                    .seal(
                        "matrix_crypto_outbox",
                        row_id.as_str(),
                        "response",
                        response.body().as_bytes(),
                    )
                    .map_err(|_| store_crypto_invalid())?;
                if response_sealed.nonce == addressed.request_nonce {
                    return Err(store_crypto_invalid());
                }
                let updated = transaction
                    .execute(
                        "UPDATE matrix_crypto_outbox
                         SET response_cipher = ?1, response_nonce = ?2,
                             response_key_version = ?3, response_sha256 = ?4,
                             state = 'response_received'
                         WHERE crypto_row_id = ?5 AND state = 'pending'
                           AND response_cipher IS NULL AND response_nonce IS NULL
                           AND response_key_version IS NULL AND response_sha256 IS NULL",
                        params![
                            response_sealed.ciphertext.as_slice(),
                            response_sealed.nonce.as_slice(),
                            i64::from(response_sealed.key_version),
                            response.sha256().as_slice(),
                            row_id.as_str(),
                        ],
                    )
                    .map_err(|_| store_crypto_corrupt())?;
                if updated != 1 {
                    return Err(store_crypto_conflict());
                }
            }
            CryptoLifecycle::ResponseReceived => {
                if addressed
                    .response
                    .as_ref()
                    .is_some_and(|stored| stored.as_bytes() == response.body().as_bytes())
                {
                    drop(transaction);
                    return Ok(());
                }
                return Err(store_crypto_conflict());
            }
            CryptoLifecycle::Accepted | CryptoLifecycle::Quarantined => {
                return Err(store_crypto_not_ready());
            }
        }
        transaction.commit().map_err(|_| store_crypto_corrupt())?;
        Ok(())
    }

    /// Mark a verified response accepted after the SDK acknowledgement.
    pub fn complete_crypto_request(
        &mut self,
        row: &str,
        accepted_at: DateTime<Utc>,
    ) -> Result<(), SafeError> {
        let row_id = CryptoRowId::new(row.to_owned()).map_err(|_| store_crypto_invalid())?;
        if !valid_utc_millisecond(accepted_at) {
            return Err(store_crypto_invalid());
        }

        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| store_crypto_corrupt())?;
        let context = load_crypto_context(&transaction, &self.keyring)?;
        let addressed = context
            .crypto_rows
            .iter()
            .find(|candidate| candidate.crypto_row_id == row_id);
        let Some(addressed) = addressed else {
            return Err(store_crypto_not_ready());
        };
        if context.gateway.maintenance_code.is_some() {
            return Err(store_crypto_not_ready());
        }
        let parent = context
            .chain
            .rows
            .iter()
            .find(|candidate| candidate.inbox_id() == &addressed.inbox_id)
            .ok_or_else(store_crypto_corrupt)?;
        match addressed.state {
            CryptoLifecycle::ResponseReceived => {
                if accepted_at < *parent.observed_at() {
                    return Err(store_crypto_invalid());
                }
                let updated = transaction
                    .execute(
                        "UPDATE matrix_crypto_outbox
                         SET state = 'accepted', accepted_at = ?1
                         WHERE crypto_row_id = ?2 AND state = 'response_received'
                           AND accepted_at IS NULL",
                        params![accepted_at.to_rfc3339(), row_id.as_str()],
                    )
                    .map_err(|_| store_crypto_corrupt())?;
                if updated != 1 {
                    return Err(store_crypto_conflict());
                }
            }
            CryptoLifecycle::Accepted => {
                if accepted_at < *parent.observed_at() {
                    return Err(store_crypto_invalid());
                }
                if addressed.accepted_at == Some(accepted_at) {
                    drop(transaction);
                    return Ok(());
                }
                return Err(store_crypto_conflict());
            }
            CryptoLifecycle::Pending | CryptoLifecycle::Quarantined => {
                return Err(store_crypto_not_ready());
            }
        }
        transaction.commit().map_err(|_| store_crypto_corrupt())?;
        Ok(())
    }

    /// Terminally quarantine one pending or response-bearing crypto request.
    pub fn quarantine_crypto_request(
        &mut self,
        row: &str,
        code: ReasonCode,
    ) -> Result<(), SafeError> {
        let row_id = CryptoRowId::new(row.to_owned()).map_err(|_| store_crypto_invalid())?;
        if !valid_stored_reason_code(code.as_str()) {
            return Err(store_crypto_invalid());
        }

        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| store_crypto_corrupt())?;
        let context = load_crypto_context(&transaction, &self.keyring)?;
        let addressed = context
            .crypto_rows
            .iter()
            .find(|candidate| candidate.crypto_row_id == row_id);
        let Some(addressed) = addressed else {
            return Err(store_crypto_not_ready());
        };
        if context.gateway.maintenance_code.is_some() {
            return Err(store_crypto_not_ready());
        }
        match addressed.state {
            CryptoLifecycle::Pending | CryptoLifecycle::ResponseReceived => {
                let updated = transaction
                    .execute(
                        "UPDATE matrix_crypto_outbox
                         SET state = 'quarantined', terminal_code = ?1
                         WHERE crypto_row_id = ?2
                           AND state IN ('pending', 'response_received')
                           AND accepted_at IS NULL AND terminal_code IS NULL",
                        params![code.as_str(), row_id.as_str()],
                    )
                    .map_err(|_| store_crypto_corrupt())?;
                if updated != 1 {
                    return Err(store_crypto_conflict());
                }
            }
            CryptoLifecycle::Quarantined => {
                if addressed
                    .terminal_code
                    .as_ref()
                    .is_some_and(|stored| stored.as_str() == code.as_str())
                {
                    drop(transaction);
                    return Ok(());
                }
                return Err(store_crypto_conflict());
            }
            CryptoLifecycle::Accepted => return Err(store_crypto_not_ready()),
        }
        transaction.commit().map_err(|_| store_crypto_corrupt())?;
        Ok(())
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
        let sdk_row_index = chain
            .next_digest_index
            .get(&sdk_token_digest)
            .copied()
            .ok_or_else(store_sdk_position_unjournaled)?;
        let sdk_position = chain
            .ordered_indices
            .iter()
            .position(|index| *index == sdk_row_index)
            .ok_or_else(store_sync_corrupt)?;
        if chain
            .first_uncommitted_position
            .is_none_or(|first| sdk_position < first)
        {
            return Err(store_sdk_position_unjournaled());
        }
        Ok(SdkInboxPosition::Journaled {
            inbox_id: chain.rows[sdk_row_index].inbox_id().clone(),
        })
    }

    /// Return the verified uncommitted journal rows from the first
    /// uncommitted row through the SDK position.
    ///
    /// The returned IDs are derived from the authenticated predecessor chain,
    /// never from synthetic ID ordering. An empty frontier represents the
    /// committed application position.
    pub(crate) fn recoverable_inbox_ids(
        &self,
        sdk_token_digest: &[u8; 32],
    ) -> Result<Vec<InboxId>, SafeError> {
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
        if sha256(committed_token.as_bytes()) == *sdk_token_digest {
            return Ok(Vec::new());
        }
        let sdk_row_index = chain
            .next_digest_index
            .get(sdk_token_digest)
            .copied()
            .ok_or_else(store_sdk_position_unjournaled)?;
        let frontier_end = chain
            .ordered_indices
            .iter()
            .position(|index| *index == sdk_row_index)
            .ok_or_else(store_sync_corrupt)?;
        let frontier_start = chain
            .first_uncommitted_position
            .filter(|start| frontier_end >= *start)
            .ok_or_else(store_sdk_position_unjournaled)?;
        Ok(chain.ordered_indices[frontier_start..=frontier_end]
            .iter()
            .map(|index| chain.rows[*index].inbox_id().clone())
            .collect())
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

    /// Return the authenticated inbox suffix after the contiguous committed
    /// prefix.  The rows are ordered by the verified predecessor chain rather
    /// than SQLite row order, and protected values never cross this crate
    /// boundary except through the returned validated DTOs.
    pub(crate) fn uncommitted_inbox_rows(&self) -> Result<Vec<RawSyncInbox>, SafeError> {
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
        Ok(chain.into_uncommitted())
    }

    /// Return authenticated, content-free pressure metrics for retained inbox
    /// rows and unresolved crypto requests.
    pub(crate) fn inbox_crypto_pressure(&self) -> Result<InboxCryptoPressure, SafeError> {
        let context = load_crypto_context(&self.connection, &self.keyring)?;
        let mut protected_bytes = 0_u64;
        let mut oldest_pending_at: Option<DateTime<Utc>> = None;

        for row in &context.chain.rows {
            let byte_count = u64::try_from(row.byte_count()).map_err(|_| store_sync_corrupt())?;
            protected_bytes = protected_bytes
                .checked_add(byte_count)
                .ok_or_else(store_sync_corrupt)?;
            if !matches!(
                row.state(),
                SyncInboxState::Committed | SyncInboxState::Quarantined
            ) {
                oldest_pending_at = Some(
                    oldest_pending_at
                        .map_or(*row.observed_at(), |oldest| oldest.min(*row.observed_at())),
                );
            }
        }

        let mut pending_request_rows = 0_u64;
        for row in &context.crypto_rows {
            if !matches!(
                row.state,
                CryptoLifecycle::Pending | CryptoLifecycle::ResponseReceived
            ) {
                continue;
            }
            pending_request_rows = pending_request_rows
                .checked_add(1)
                .ok_or_else(store_crypto_corrupt)?;
            let byte_count = u64::try_from(row.byte_count).map_err(|_| store_crypto_corrupt())?;
            protected_bytes = protected_bytes
                .checked_add(byte_count)
                .ok_or_else(store_crypto_corrupt)?;
            let parent = context
                .chain
                .rows
                .iter()
                .find(|candidate| candidate.inbox_id() == &row.inbox_id)
                .ok_or_else(store_crypto_corrupt)?;
            let parent_observed_at = *parent.observed_at();
            oldest_pending_at = Some(
                oldest_pending_at
                    .map_or(parent_observed_at, |oldest| oldest.min(parent_observed_at)),
            );
        }

        let committed_prefix = context
            .chain
            .ordered_indices
            .iter()
            .map(|index| &context.chain.rows[*index])
            .take_while(|row| row.state() == SyncInboxState::Committed)
            .collect::<Vec<_>>();
        let oldest_purge_candidate = committed_prefix
            .split_last()
            .and_then(|(_, purgeable_prefix)| purgeable_prefix.first())
            .copied();
        let next_retention_at = oldest_purge_candidate
            .map(|row| {
                let committed_at = *row.committed_at().ok_or_else(store_sync_corrupt)?;
                let retention_cutoff = committed_at
                    .checked_add_signed(ChronoDuration::days(7))
                    .ok_or_else(store_sync_corrupt)?;
                retention_cutoff
                    .checked_add_signed(ChronoDuration::milliseconds(1))
                    .ok_or_else(store_sync_corrupt)
            })
            .transpose()?;

        Ok(InboxCryptoPressure {
            pending_request_rows,
            protected_bytes,
            oldest_pending_at,
            next_retention_at,
        })
    }

    /// Return the deterministic live-window identifier for one authenticated
    /// inbox row.  The response key version is read from the verified row so
    /// key rotation cannot change an existing window identity.
    pub(crate) fn live_window_id_for_inbox(&self, inbox_id: &str) -> Result<String, SafeError> {
        if !valid_stored_inbox_id(inbox_id) {
            return Err(store_sync_invalid());
        }
        let response_key_version: i64 = self
            .connection
            .query_row(
                "SELECT response_key_version FROM sync_inbox WHERE inbox_id = ?1",
                [inbox_id],
                |row| row.get(0),
            )
            .map_err(|_| store_sync_corrupt())?;
        let response_key_version = u32::try_from(response_key_version)
            .ok()
            .filter(|version| *version != 0)
            .ok_or_else(store_sync_corrupt)?;
        let digest = self
            .keyring
            .lookup_digest_at(response_key_version, "matrix-live-window-v1", &[inbox_id])
            .map_err(|_| store_sync_corrupt())?;
        Ok(format!("window_{}", lowercase_hex(&digest)))
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

    /// Resolve a Matrix room ID through this store's keyed registry.
    pub(crate) fn matrix_room_lookup(&self, matrix_room_id: &str) -> Result<[u8; 32], SafeError> {
        registry_room_lookup(&self.keyring, matrix_room_id)
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

    /// Return the authenticated persisted typing snapshot for one room. This
    /// read is intentionally bounded and exposes only the protected value to
    /// the in-crate service coordinator for restart-time normalization.
    pub(crate) fn room_ephemeral_typing(
        &self,
        room_lookup: &[u8],
    ) -> Result<Option<(SecretBytes, DateTime<Utc>)>, SafeError> {
        if room_lookup.len() != 32 {
            return Err(store_sync_corrupt());
        }
        let _session = self.matrix_session()?.ok_or_else(store_not_bootstrapped)?;
        let mut statement = self
            .connection
            .prepare(
                "SELECT typing_set_cipher, typing_set_nonce, typing_key_version,
                        typing_expires_at
                 FROM room_ephemeral_state WHERE room_lookup = ?1 LIMIT 2",
            )
            .map_err(|_| store_sync_corrupt())?;
        let mut rows = statement
            .query(params![room_lookup])
            .map_err(|_| store_sync_corrupt())?;
        let Some(row) = rows.next().map_err(|_| store_sync_corrupt())? else {
            return Ok(None);
        };
        let ciphertext: Vec<u8> = row.get(0).map_err(|_| store_sync_corrupt())?;
        let nonce: Vec<u8> = row.get(1).map_err(|_| store_sync_corrupt())?;
        let key_version: i64 = row.get(2).map_err(|_| store_sync_corrupt())?;
        let expires_at: String = row.get(3).map_err(|_| store_sync_corrupt())?;
        if rows.next().map_err(|_| store_sync_corrupt())?.is_some()
            || nonce.len() != 24
            || ciphertext.len() < AEAD_TAG_BYTES
            || key_version <= 0
        {
            return Err(store_sync_corrupt());
        }
        let expires_at = parse_stored_timestamp(&expires_at)?;
        let lookup: [u8; 32] = room_lookup.try_into().map_err(|_| store_sync_corrupt())?;
        let row_id = room_progress_row_id(&lookup);
        let plaintext = open_stored_value(
            &self.keyring,
            StoredValue {
                table: "room_ephemeral_state",
                row_id: &row_id,
                column: "typing_set",
                ciphertext: Some(ciphertext.as_slice()),
                nonce: Some(nonce.as_slice()),
                key_version: Some(key_version),
                max_plaintext_bytes: MAX_ROOM_ANCHOR_BYTES,
            },
        )?;
        Ok(Some((
            SecretBytes::new(plaintext.as_bytes().to_vec()),
            expires_at,
        )))
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

    /// Resolve one active Matrix room from the complete history owner tuple.
    ///
    /// The caller supplies the authenticated Communicator authority rather
    /// than a room ID. The account lookup narrows the encrypted registry scan;
    /// every candidate is then decrypted and compared against all five
    /// immutable authority fields before it can be returned.
    pub fn active_room_binding_for_history(
        &self,
        tenant_id: &str,
        account_id: &str,
        connection_id: &str,
        identity_id: &str,
        platform: model::Provider,
    ) -> Result<Option<RoomBinding>, SafeError> {
        if !model::valid_resource_id(tenant_id)
            || !model::valid_resource_id(account_id)
            || !model::valid_resource_id(connection_id)
            || !model::valid_resource_id(identity_id)
        {
            return Err(room_binding_invalid());
        }
        let account_lookup = registry_account_lookup(&self.keyring, platform, account_id)?;
        let mut statement = self
            .connection
            .prepare(
                "SELECT binding_id, room_lookup, account_lookup, payload_cipher,
                        payload_nonce, key_version, status, created_at, retired_at
                 FROM room_bindings
                 WHERE account_lookup = ?1 AND status = 'active'
                 ORDER BY binding_id",
            )
            .map_err(|_| room_binding_invalid())?;
        let rows = statement
            .query_map(
                params![account_lookup.as_slice()],
                read_stored_room_binding_row,
            )
            .map_err(|_| room_binding_invalid())?;
        let mut matches = Vec::new();
        for row in rows {
            let row = row.map_err(|_| room_binding_invalid())?;
            if row.account_lookup.as_slice() != account_lookup.as_slice() {
                return Err(room_binding_invalid());
            }
            let binding = verify_active_room_binding(&self.keyring, &row)?;
            if binding.tenant_id() == tenant_id
                && binding.account_id() == account_id
                && binding.connection_id() == connection_id
                && binding.identity_id() == identity_id
                && binding.platform() == platform
            {
                matches.push(binding);
            }
        }
        drop(statement);

        if matches.len() > 1 {
            return Err(room_binding_invalid());
        }
        Ok(matches.pop())
    }

    /// Resolve one active outbound room from the complete authority tuple and
    /// the requested conversation.  Outbound routing is conversation-scoped:
    /// an account may own several active chats, so the history resolver's
    /// account-wide uniqueness rule cannot be reused here.
    pub fn active_room_binding_for_outbound(
        &self,
        tenant_id: &str,
        account_id: &str,
        connection_id: &str,
        identity_id: &str,
        platform: model::Provider,
        conversation_id: &str,
    ) -> Result<Option<RoomBinding>, SafeError> {
        if !model::valid_resource_id(tenant_id)
            || !model::valid_resource_id(account_id)
            || !model::valid_resource_id(connection_id)
            || !model::valid_resource_id(identity_id)
            || !model::valid_resource_id(conversation_id)
        {
            return Err(room_binding_invalid());
        }
        let account_lookup = registry_account_lookup(&self.keyring, platform, account_id)?;
        let mut statement = self
            .connection
            .prepare(
                "SELECT binding_id, room_lookup, account_lookup, payload_cipher,
                        payload_nonce, key_version, status, created_at, retired_at
                 FROM room_bindings
                 WHERE account_lookup = ?1 AND status = 'active'
                 ORDER BY binding_id",
            )
            .map_err(|_| room_binding_invalid())?;
        let rows = statement
            .query_map(
                params![account_lookup.as_slice()],
                read_stored_room_binding_row,
            )
            .map_err(|_| room_binding_invalid())?;
        let mut matches = Vec::new();
        for row in rows {
            let row = row.map_err(|_| room_binding_invalid())?;
            if row.account_lookup.as_slice() != account_lookup.as_slice() {
                return Err(room_binding_invalid());
            }
            let binding = verify_active_room_binding(&self.keyring, &row)?;
            if binding.tenant_id() == tenant_id
                && binding.account_id() == account_id
                && binding.connection_id() == connection_id
                && binding.identity_id() == identity_id
                && binding.platform() == platform
                && binding.conversation_id() == conversation_id
            {
                matches.push(binding);
            }
        }
        drop(statement);

        if matches.len() > 1 {
            return Err(room_binding_invalid());
        }
        Ok(matches.pop())
    }

    /// Persist one source media descriptor behind the gateway keyring.
    ///
    /// The lookup tuple is deliberately wider than the room binding: a
    /// descriptor is addressable only by the complete authority, conversation,
    /// message, attachment, revision, and provider tuple. Replays of the same
    /// event are idempotent; a different descriptor for that revision fails
    /// closed as a conflict.
    pub(crate) fn upsert_attachment_descriptor(
        &mut self,
        fields: &[&str],
        payload: &[u8],
    ) -> Result<(), SafeError> {
        let lookup = attachment_descriptor_lookup(&self.keyring, fields)?;
        if payload.is_empty() || payload.len() > ATTACHMENT_DESCRIPTOR_MAX_BYTES {
            return Err(attachment_invalid());
        }
        let row_id = attachment_descriptor_row_id(&lookup);
        let sealed = self
            .keyring
            .seal("attachment_descriptors", &row_id, "payload", payload)
            .map_err(|_| attachment_invalid())?;
        let updated_at = Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        let keyring = &self.keyring;
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| attachment_invalid())?;
        let existing = transaction
            .query_row(
                "SELECT payload_cipher, payload_nonce, key_version
                 FROM attachment_descriptors WHERE attachment_lookup = ?1",
                params![lookup.as_slice()],
                |row| {
                    Ok((
                        row.get::<_, Vec<u8>>(0)?,
                        row.get::<_, Vec<u8>>(1)?,
                        row.get::<_, i64>(2)?,
                    ))
                },
            )
            .optional()
            .map_err(|_| attachment_invalid())?;
        if let Some((ciphertext, nonce, key_version)) = existing {
            let nonce: [u8; 24] = nonce.try_into().map_err(|_| attachment_invalid())?;
            let key_version = u32::try_from(key_version).map_err(|_| attachment_invalid())?;
            let stored = keyring
                .open(
                    "attachment_descriptors",
                    &row_id,
                    "payload",
                    &Sealed {
                        nonce,
                        ciphertext,
                        key_version,
                    },
                )
                .map_err(|_| attachment_invalid())?;
            if stored.as_slice() != payload {
                return Err(attachment_conflict());
            }
            transaction.commit().map_err(|_| attachment_invalid())?;
            return Ok(());
        }
        let inserted = transaction
            .execute(
                "INSERT INTO attachment_descriptors
                 (attachment_lookup, payload_cipher, payload_nonce, key_version, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                params![
                    lookup.as_slice(),
                    sealed.ciphertext.as_slice(),
                    sealed.nonce.as_slice(),
                    i64::from(sealed.key_version),
                    updated_at,
                ],
            )
            .map_err(|_| attachment_invalid())?;
        if inserted != 1 {
            return Err(attachment_invalid());
        }
        transaction.commit().map_err(|_| attachment_invalid())?;
        Ok(())
    }

    /// Load one sealed source descriptor by the complete authority tuple.
    pub(crate) fn load_attachment_descriptor(
        &self,
        fields: &[&str],
    ) -> Result<Option<SecretBytes>, SafeError> {
        let lookup = attachment_descriptor_lookup(&self.keyring, fields)?;
        let row = self
            .connection
            .query_row(
                "SELECT payload_cipher, payload_nonce, key_version
                 FROM attachment_descriptors WHERE attachment_lookup = ?1",
                params![lookup.as_slice()],
                |row| {
                    Ok((
                        row.get::<_, Vec<u8>>(0)?,
                        row.get::<_, Vec<u8>>(1)?,
                        row.get::<_, i64>(2)?,
                    ))
                },
            )
            .optional()
            .map_err(|_| attachment_invalid())?;
        let Some((ciphertext, nonce, key_version)) = row else {
            return Ok(None);
        };
        let nonce: [u8; 24] = nonce.try_into().map_err(|_| attachment_invalid())?;
        let key_version = u32::try_from(key_version).map_err(|_| attachment_invalid())?;
        let row_id = attachment_descriptor_row_id(&lookup);
        let plaintext = self
            .keyring
            .open(
                "attachment_descriptors",
                &row_id,
                "payload",
                &Sealed {
                    nonce,
                    ciphertext,
                    key_version,
                },
            )
            .map_err(|_| attachment_invalid())?;
        if plaintext.len() > ATTACHMENT_DESCRIPTOR_MAX_BYTES {
            return Err(attachment_invalid());
        }
        Ok(Some(SecretBytes::new(plaintext.as_slice().to_vec())))
    }

    /// Derive an opaque, authority-bound cursor for one Matrix history page.
    ///
    /// The Matrix token is supplied only to the keyed digest and is never
    /// returned. The corresponding raw token remains in the encrypted
    /// backfill pagination envelope.
    pub fn history_cursor_token(
        &self,
        import_id: &str,
        range_id: &str,
        source_cursor: &str,
    ) -> Result<String, SafeError> {
        if !model::valid_resource_id(import_id)
            || !model::valid_resource_id(range_id)
            || source_cursor.is_empty()
            || source_cursor.len() > MAX_SYNC_TOKEN_BYTES
        {
            return Err(room_binding_invalid());
        }
        let digest = self
            .keyring
            .lookup_digest("history-cursor-v1", &[import_id, range_id, source_cursor])
            .map_err(|_| room_binding_invalid())?;
        Ok(format!("history_{}", lowercase_hex(&digest)))
    }
}

fn room_binding_invalid() -> SafeError {
    SafeError::new(STORE_ROOM_BINDING_INVALID)
}

fn attachment_invalid() -> SafeError {
    SafeError::new(STORE_ATTACHMENT_INVALID)
}

fn attachment_conflict() -> SafeError {
    SafeError::new(STORE_ATTACHMENT_CONFLICT)
}

fn attachment_descriptor_lookup(keyring: &Keyring, fields: &[&str]) -> Result<[u8; 32], SafeError> {
    if fields.len() != ATTACHMENT_DESCRIPTOR_FIELD_COUNT {
        return Err(attachment_invalid());
    }
    keyring
        .lookup_digest("attachment-descriptor-v1", fields)
        .map_err(|_| attachment_invalid())
}

fn attachment_descriptor_row_id(lookup: &[u8; 32]) -> String {
    format!("attachment_{}", lowercase_hex(lookup))
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

fn store_crypto_invalid() -> SafeError {
    SafeError::new(STORE_CRYPTO_INVALID)
}

fn store_crypto_too_large() -> SafeError {
    SafeError::new(STORE_CRYPTO_TOO_LARGE)
}

fn store_crypto_not_ready() -> SafeError {
    SafeError::new(STORE_CRYPTO_NOT_READY)
}

fn store_crypto_unresolved() -> SafeError {
    SafeError::new(STORE_CRYPTO_UNRESOLVED)
}

fn store_crypto_conflict() -> SafeError {
    SafeError::new(STORE_CRYPTO_CONFLICT)
}

fn store_crypto_corrupt() -> SafeError {
    SafeError::new(STORE_CRYPTO_CORRUPT)
}

fn map_crypto_storage_error(error: SafeError) -> SafeError {
    match error.code() {
        STORE_NOT_BOOTSTRAPPED => store_crypto_not_ready(),
        STORE_CRYPTO_NOT_READY
        | STORE_CRYPTO_UNRESOLVED
        | STORE_CRYPTO_CONFLICT
        | STORE_CRYPTO_CORRUPT => error,
        _ => store_crypto_corrupt(),
    }
}

fn map_crypto_insert_error(error: rusqlite::Error) -> SafeError {
    match error {
        rusqlite::Error::SqliteFailure(failure, _)
            if failure.extended_code == ffi::SQLITE_CONSTRAINT_UNIQUE
                || failure.extended_code == ffi::SQLITE_CONSTRAINT_PRIMARYKEY =>
        {
            store_crypto_conflict()
        }
        _ => store_crypto_corrupt(),
    }
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

fn matrix_request_lookup(
    keyring: &Keyring,
    canonical_request: &[u8],
) -> Result<[u8; 32], SafeError> {
    matrix_request_lookup_at(keyring, keyring.active_key_version(), canonical_request)
}

fn matrix_request_lookup_at(
    keyring: &Keyring,
    key_version: u32,
    canonical_request: &[u8],
) -> Result<[u8; 32], SafeError> {
    let canonical_request_utf8 =
        std::str::from_utf8(canonical_request).map_err(|_| store_crypto_invalid())?;
    keyring
        .lookup_digest_at(
            key_version,
            "matrix-crypto-request-v1",
            &[MATRIX_CRYPTO_REQUEST_KIND, canonical_request_utf8],
        )
        .map_err(|_| store_crypto_invalid())
}

fn derive_crypto_row_id(
    inbox_id: &InboxId,
    request_lookup: &[u8; 32],
) -> Result<CryptoRowId, SafeError> {
    let prefix = b"matrix-crypto-row-v1";
    let inbox_bytes = inbox_id.as_str().as_bytes();
    let capacity = 4_usize
        .checked_add(prefix.len())
        .and_then(|value| value.checked_add(4 + inbox_bytes.len()))
        .and_then(|value| value.checked_add(4 + request_lookup.len()))
        .ok_or_else(store_crypto_invalid)?;
    let mut framed = Vec::with_capacity(capacity);
    for value in [prefix.as_slice(), inbox_bytes, request_lookup.as_slice()] {
        let length = u32::try_from(value.len()).map_err(|_| store_crypto_invalid())?;
        framed.extend_from_slice(&length.to_be_bytes());
        framed.extend_from_slice(value);
    }
    let digest = sha256(&framed);
    CryptoRowId::new(format!("crypto_{}", lowercase_hex(&digest)))
        .map_err(|_| store_crypto_invalid())
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

fn read_crypto_blob_len(
    row: &Row<'_>,
    index: usize,
    min_bytes: usize,
    max_bytes: usize,
) -> Result<u64, SafeError> {
    match row.get_ref(index).map_err(|_| store_crypto_corrupt())? {
        ValueRef::Blob(bytes) if (min_bytes..=max_bytes).contains(&bytes.len()) => {
            u64::try_from(bytes.len()).map_err(|_| store_crypto_corrupt())
        }
        _ => Err(store_crypto_corrupt()),
    }
}

fn preflight_stored_crypto_response_fields(
    row: &Row<'_>,
    max_response_ciphertext: usize,
) -> Result<Option<u64>, SafeError> {
    let response_refs = [
        row.get_ref(12).map_err(|_| store_crypto_corrupt())?,
        row.get_ref(13).map_err(|_| store_crypto_corrupt())?,
        row.get_ref(14).map_err(|_| store_crypto_corrupt())?,
        row.get_ref(15).map_err(|_| store_crypto_corrupt())?,
    ];
    let all_null = response_refs
        .iter()
        .all(|value| matches!(value, ValueRef::Null));
    let any_null = response_refs
        .iter()
        .any(|value| matches!(value, ValueRef::Null));
    if all_null {
        return Ok(None);
    }
    if any_null {
        return Err(store_crypto_corrupt());
    }

    let response_cipher_len =
        read_crypto_blob_len(row, 12, AEAD_TAG_BYTES + 1, max_response_ciphertext)?;
    match row.get_ref(13).map_err(|_| store_crypto_corrupt())? {
        ValueRef::Blob(bytes) if bytes.len() == SYNC_NONCE_BYTES => {}
        _ => return Err(store_crypto_corrupt()),
    }
    match row.get_ref(14).map_err(|_| store_crypto_corrupt())? {
        ValueRef::Integer(value) if (1..=i64::from(u32::MAX)).contains(&value) => {}
        _ => return Err(store_crypto_corrupt()),
    }
    match row.get_ref(15).map_err(|_| store_crypto_corrupt())? {
        ValueRef::Blob(bytes) if bytes.len() == 32 => {}
        _ => return Err(store_crypto_corrupt()),
    }
    Ok(Some(response_cipher_len))
}

fn preflight_crypto_row(row: &Row<'_>, current_recovery_bytes: u64) -> Result<u64, SafeError> {
    let max_key_version = i64::from(u32::MAX);
    let max_sdk_ciphertext = MAX_SDK_REQUEST_ID_BYTES
        .checked_add(AEAD_TAG_BYTES)
        .ok_or_else(store_crypto_corrupt)?;
    let max_request_ciphertext = MAX_MATRIX_CRYPTO_REQUEST_BYTES
        .checked_add(AEAD_TAG_BYTES)
        .ok_or_else(store_crypto_corrupt)?;
    let max_response_ciphertext = MAX_MATRIX_CRYPTO_RESPONSE_BYTES
        .checked_add(AEAD_TAG_BYTES)
        .ok_or_else(store_crypto_corrupt)?;
    let byte_count = read_crypto_integer(row, 11, 1, MAX_MATRIX_CRYPTO_REQUEST_BYTES as i64)?;
    let max_request_ciphertext_for_row = usize::try_from(byte_count)
        .ok()
        .and_then(|count| count.checked_add(AEAD_TAG_BYTES))
        .filter(|count| *count <= max_request_ciphertext)
        .ok_or_else(store_crypto_corrupt)?;

    let sdk_request_id_ciphertext_len =
        read_crypto_blob_len(row, 4, AEAD_TAG_BYTES, max_sdk_ciphertext)?;
    read_crypto_blob_len(row, 5, SYNC_NONCE_BYTES, SYNC_NONCE_BYTES)?;
    read_crypto_integer(row, 6, 1, max_key_version)?;
    let request_ciphertext_len =
        read_crypto_blob_len(row, 7, AEAD_TAG_BYTES, max_request_ciphertext_for_row)?;
    read_crypto_blob_len(row, 8, SYNC_NONCE_BYTES, SYNC_NONCE_BYTES)?;
    read_crypto_integer(row, 9, 1, max_key_version)?;
    let response_ciphertext_len =
        preflight_stored_crypto_response_fields(row, max_response_ciphertext)?;

    checked_crypto_recovery_bytes(
        current_recovery_bytes,
        sdk_request_id_ciphertext_len,
        request_ciphertext_len,
        response_ciphertext_len,
    )
    .map_err(|_| store_crypto_corrupt())
}

fn read_stored_crypto_row(row: &Row<'_>) -> Result<StoredCryptoRow, SafeError> {
    let max_key_version = i64::from(u32::MAX);
    let max_sdk_ciphertext = MAX_SDK_REQUEST_ID_BYTES
        .checked_add(AEAD_TAG_BYTES)
        .ok_or_else(store_crypto_corrupt)?;
    let max_request_ciphertext = MAX_MATRIX_CRYPTO_REQUEST_BYTES
        .checked_add(AEAD_TAG_BYTES)
        .ok_or_else(store_crypto_corrupt)?;
    let max_response_ciphertext = MAX_MATRIX_CRYPTO_RESPONSE_BYTES
        .checked_add(AEAD_TAG_BYTES)
        .ok_or_else(store_crypto_corrupt)?;
    let response = read_stored_crypto_response_fields(row, max_response_ciphertext)?;
    let byte_count = read_crypto_integer(row, 11, 1, MAX_MATRIX_CRYPTO_REQUEST_BYTES as i64)?;
    let max_request_ciphertext_for_row = usize::try_from(byte_count)
        .ok()
        .and_then(|count| count.checked_add(AEAD_TAG_BYTES))
        .filter(|count| *count <= max_request_ciphertext)
        .ok_or_else(store_crypto_corrupt)?;

    Ok(StoredCryptoRow {
        crypto_row_id: read_sync_text(row, 0, CRYPTO_ROW_ID_BYTES, valid_stored_crypto_row_id)?,
        inbox_id: read_sync_text(row, 1, SYNC_INBOX_ID_BYTES, valid_stored_inbox_id)?,
        request_lookup: read_sync_blob(row, 2, 32, 32)?,
        request_kind: read_sync_text(
            row,
            3,
            CRYPTO_REQUEST_KIND_MAX_BYTES,
            valid_stored_crypto_request_kind,
        )?,
        sdk_request_id_cipher: read_sync_blob(row, 4, AEAD_TAG_BYTES, max_sdk_ciphertext)?,
        sdk_request_id_nonce: read_sync_blob(row, 5, SYNC_NONCE_BYTES, SYNC_NONCE_BYTES)?,
        sdk_request_id_key_version: read_sync_integer(row, 6, 1, max_key_version)?,
        request_cipher: read_sync_blob(row, 7, AEAD_TAG_BYTES, max_request_ciphertext_for_row)?,
        request_nonce: read_sync_blob(row, 8, SYNC_NONCE_BYTES, SYNC_NONCE_BYTES)?,
        request_key_version: read_sync_integer(row, 9, 1, max_key_version)?,
        request_sha256: read_sync_blob(row, 10, 32, 32)?,
        byte_count,
        response_cipher: response.cipher,
        response_nonce: response.nonce,
        response_key_version: response.key_version,
        response_sha256: response.sha256,
        state: read_sync_text(row, 16, CRYPTO_STATE_MAX_BYTES, valid_stored_crypto_state)?,
        attempt_count: read_crypto_integer(row, 17, 0, CRYPTO_ATTEMPT_COUNT_MAX)?,
        next_attempt_at: read_sync_text(
            row,
            18,
            SYNC_TIMESTAMP_MAX_BYTES,
            valid_stored_utc_millisecond,
        )?,
        accepted_at: read_optional_sync_text(
            row,
            19,
            SYNC_TIMESTAMP_MAX_BYTES,
            valid_stored_utc_millisecond,
        )?,
        terminal_code: read_optional_sync_text(
            row,
            20,
            SYNC_TERMINAL_CODE_MAX_BYTES,
            valid_stored_reason_code,
        )?,
    })
}

fn read_stored_crypto_response_fields(
    row: &Row<'_>,
    max_response_ciphertext: usize,
) -> Result<StoredCryptoResponseFields, SafeError> {
    let response_cipher_ref = row.get_ref(12).map_err(|_| store_crypto_corrupt())?;
    let response_nonce_ref = row.get_ref(13).map_err(|_| store_crypto_corrupt())?;
    let response_key_version_ref = row.get_ref(14).map_err(|_| store_crypto_corrupt())?;
    let response_sha256_ref = row.get_ref(15).map_err(|_| store_crypto_corrupt())?;

    let response_refs = [
        response_cipher_ref,
        response_nonce_ref,
        response_key_version_ref,
        response_sha256_ref,
    ];
    let all_null = response_refs
        .iter()
        .all(|value| matches!(value, ValueRef::Null));
    let any_null = response_refs
        .iter()
        .any(|value| matches!(value, ValueRef::Null));
    if all_null {
        return Ok(StoredCryptoResponseFields {
            cipher: None,
            nonce: None,
            key_version: None,
            sha256: None,
        });
    }
    if any_null {
        return Err(store_crypto_corrupt());
    }

    let response_cipher = match response_cipher_ref {
        ValueRef::Blob(bytes)
            if (AEAD_TAG_BYTES + 1..=max_response_ciphertext).contains(&bytes.len()) =>
        {
            bytes
        }
        _ => return Err(store_crypto_corrupt()),
    };
    let response_nonce = match response_nonce_ref {
        ValueRef::Blob(bytes) if bytes.len() == SYNC_NONCE_BYTES => bytes,
        _ => return Err(store_crypto_corrupt()),
    };
    let response_key_version = match response_key_version_ref {
        ValueRef::Integer(value) if (1..=i64::from(u32::MAX)).contains(&value) => value,
        _ => return Err(store_crypto_corrupt()),
    };
    let response_sha256 = match response_sha256_ref {
        ValueRef::Blob(bytes) if bytes.len() == 32 => bytes,
        _ => return Err(store_crypto_corrupt()),
    };

    Ok(StoredCryptoResponseFields {
        cipher: Some(response_cipher.to_vec()),
        nonce: Some(response_nonce.to_vec()),
        key_version: Some(response_key_version),
        sha256: Some(response_sha256.to_vec()),
    })
}

fn read_crypto_integer(
    row: &Row<'_>,
    index: usize,
    min_value: i64,
    max_value: i64,
) -> Result<i64, SafeError> {
    match row.get_ref(index).map_err(|_| store_crypto_corrupt())? {
        ValueRef::Integer(value) if (min_value..=max_value).contains(&value) => Ok(value),
        _ => Err(store_crypto_corrupt()),
    }
}

fn read_and_verify_crypto_row(
    stored: StoredCryptoRow,
    keyring: &Keyring,
) -> Result<VerifiedCryptoRow, SafeError> {
    let crypto_row_id =
        CryptoRowId::new(stored.crypto_row_id).map_err(|_| store_crypto_corrupt())?;
    let inbox_id = InboxId::new(stored.inbox_id).map_err(|_| store_crypto_corrupt())?;
    let request_lookup = digest_from_blob(&stored.request_lookup)?;
    let request_sha256 = digest_from_blob(&stored.request_sha256)?;
    let byte_count = usize::try_from(stored.byte_count).map_err(|_| store_crypto_corrupt())?;
    if stored.request_kind != MATRIX_CRYPTO_REQUEST_KIND {
        return Err(store_crypto_corrupt());
    }
    let state = CryptoLifecycle::from_str(&stored.state)?;
    let attempt_count = u32::try_from(stored.attempt_count).map_err(|_| store_crypto_corrupt())?;
    let next_attempt_at = parse_stored_timestamp(&stored.next_attempt_at)?;
    let accepted_at = stored
        .accepted_at
        .as_deref()
        .map(parse_stored_timestamp)
        .transpose()?;
    let terminal_code = stored
        .terminal_code
        .map(ReasonCode::new)
        .transpose()
        .map_err(|_| store_crypto_corrupt())?;

    let sdk_request_id_plaintext = open_stored_value(
        keyring,
        StoredValue {
            table: "matrix_crypto_outbox",
            row_id: crypto_row_id.as_str(),
            column: "sdk_request_id",
            ciphertext: Some(stored.sdk_request_id_cipher.as_slice()),
            nonce: Some(stored.sdk_request_id_nonce.as_slice()),
            key_version: Some(stored.sdk_request_id_key_version),
            max_plaintext_bytes: MAX_SDK_REQUEST_ID_BYTES,
        },
    )?;
    let request_plaintext = open_stored_value(
        keyring,
        StoredValue {
            table: "matrix_crypto_outbox",
            row_id: crypto_row_id.as_str(),
            column: "request",
            ciphertext: Some(stored.request_cipher.as_slice()),
            nonce: Some(stored.request_nonce.as_slice()),
            key_version: Some(stored.request_key_version),
            max_plaintext_bytes: MAX_MATRIX_CRYPTO_REQUEST_BYTES,
        },
    )?;
    if sdk_request_id_plaintext.is_empty()
        || sdk_request_id_plaintext.len() > MAX_SDK_REQUEST_ID_BYTES
        || request_plaintext.len() != byte_count
        || request_plaintext.is_empty()
        || request_plaintext.len() > MAX_MATRIX_CRYPTO_REQUEST_BYTES
    {
        return Err(store_crypto_corrupt());
    }
    validate_canonical_request_bytes(request_plaintext.as_bytes())
        .map_err(|_| store_crypto_corrupt())?;
    if sha256(request_plaintext.as_bytes()) != request_sha256 {
        return Err(store_crypto_corrupt());
    }
    let request_key_version =
        u32::try_from(stored.request_key_version).map_err(|_| store_crypto_corrupt())?;
    let expected_lookup =
        matrix_request_lookup_at(keyring, request_key_version, request_plaintext.as_bytes())
            .map_err(|_| store_crypto_corrupt())?;
    if expected_lookup != request_lookup
        || derive_crypto_row_id(&inbox_id, &request_lookup)? != crypto_row_id
    {
        return Err(store_crypto_corrupt());
    }

    let response = match (
        stored.response_cipher,
        stored.response_nonce,
        stored.response_key_version,
        stored.response_sha256,
    ) {
        (None, None, None, None) => None,
        (Some(ciphertext), Some(nonce), Some(key_version), Some(response_sha256)) => {
            let nonce: [u8; 24] = nonce.try_into().map_err(|_| store_crypto_corrupt())?;
            if nonce == stored.request_nonce.as_slice() {
                return Err(store_crypto_corrupt());
            }
            let response_sha256 = digest_from_blob(&response_sha256)?;
            let plaintext = open_stored_value(
                keyring,
                StoredValue {
                    table: "matrix_crypto_outbox",
                    row_id: crypto_row_id.as_str(),
                    column: "response",
                    ciphertext: Some(ciphertext.as_slice()),
                    nonce: Some(&nonce),
                    key_version: Some(key_version),
                    max_plaintext_bytes: MAX_MATRIX_CRYPTO_RESPONSE_BYTES,
                },
            )?;
            validate_stored_crypto_response(plaintext.as_bytes())?;
            if sha256(plaintext.as_bytes()) != response_sha256 {
                return Err(store_crypto_corrupt());
            }
            Some((
                SecretBytes::new(plaintext.as_bytes().to_vec()),
                response_sha256,
            ))
        }
        _ => return Err(store_crypto_corrupt()),
    };
    let (response, response_sha256) = response
        .map_or((None, None), |(response, response_sha256)| {
            (Some(response), Some(response_sha256))
        });

    match state {
        CryptoLifecycle::Pending
            if response.is_none() && accepted_at.is_none() && terminal_code.is_none() => {}
        CryptoLifecycle::ResponseReceived
            if response.is_some()
                && accepted_at.is_none()
                && terminal_code.is_none()
                && attempt_count >= 1 => {}
        CryptoLifecycle::Accepted
            if response.is_some()
                && accepted_at.is_some()
                && terminal_code.is_none()
                && attempt_count >= 1 => {}
        CryptoLifecycle::Quarantined if accepted_at.is_none() && terminal_code.is_some() => {}
        _ => return Err(store_crypto_corrupt()),
    }

    let request_nonce: [u8; 24] = stored
        .request_nonce
        .try_into()
        .map_err(|_| store_crypto_corrupt())?;

    Ok(VerifiedCryptoRow {
        crypto_row_id,
        inbox_id,
        request_lookup,
        sdk_request_id: SecretBytes::new(sdk_request_id_plaintext.as_bytes().to_vec()),
        request: SecretBytes::new(request_plaintext.as_bytes().to_vec()),
        request_sha256,
        byte_count,
        request_nonce,
        response,
        response_sha256,
        state,
        attempt_count,
        next_attempt_at,
        accepted_at,
        terminal_code,
    })
}

fn validate_stored_crypto_response(bytes: &[u8]) -> Result<(), SafeError> {
    if bytes.is_empty() || bytes.len() > MAX_MATRIX_CRYPTO_RESPONSE_BYTES {
        return Err(store_crypto_corrupt());
    }
    std::str::from_utf8(bytes).map_err(|_| store_crypto_corrupt())?;
    validate_json_object(bytes).map_err(|_| store_crypto_corrupt())
}

const CRYPTO_ROW_COLUMNS: &str = "crypto_row_id, inbox_id, request_lookup, request_kind,
     sdk_request_id_cipher, sdk_request_id_nonce, sdk_request_id_key_version,
     request_cipher, request_nonce, request_key_version, request_sha256,
     byte_count, response_cipher, response_nonce, response_key_version,
     response_sha256, state, attempt_count, next_attempt_at,
     accepted_at, terminal_code";

fn is_unresolved_crypto_state(state: CryptoLifecycle) -> bool {
    matches!(
        state,
        CryptoLifecycle::Pending | CryptoLifecycle::ResponseReceived | CryptoLifecycle::Quarantined
    )
}

fn verify_crypto_parent_row(
    parent: &RawSyncInbox,
    row: &VerifiedCryptoRow,
) -> Result<(), SafeError> {
    match row.state {
        CryptoLifecycle::Pending | CryptoLifecycle::ResponseReceived => {
            if parent.state() != SyncInboxState::SdkProcessed
                || parent.crypto_drained()
                || parent.sdk_processed_at() != Some(parent.observed_at())
            {
                return Err(store_crypto_corrupt());
            }
        }
        CryptoLifecycle::Accepted => {
            if !matches!(
                parent.state(),
                SyncInboxState::SdkProcessed | SyncInboxState::Prepared | SyncInboxState::Committed
            ) || row
                .accepted_at
                .is_none_or(|accepted| accepted < *parent.observed_at())
            {
                return Err(store_crypto_corrupt());
            }
        }
        CryptoLifecycle::Quarantined => {
            if !matches!(
                parent.state(),
                SyncInboxState::SdkProcessed | SyncInboxState::Quarantined
            ) {
                return Err(store_crypto_corrupt());
            }
        }
    }
    Ok(())
}

fn load_verified_crypto_rows(
    connection: &Connection,
    keyring: &Keyring,
    chain: &VerifiedInboxChain,
) -> Result<Vec<VerifiedCryptoRow>, SafeError> {
    let row_limit = chain
        .rows
        .len()
        .checked_add(1)
        .and_then(|limit| i64::try_from(limit).ok())
        .ok_or_else(store_crypto_corrupt)?;
    let query = format!(
        "SELECT {CRYPTO_ROW_COLUMNS}
         FROM matrix_crypto_outbox ORDER BY rowid LIMIT ?1"
    );
    let mut statement = connection
        .prepare(&query)
        .map_err(|_| store_crypto_corrupt())?;
    let mut rows = statement
        .query(params![row_limit])
        .map_err(|_| store_crypto_corrupt())?;
    let mut verified_rows = Vec::with_capacity(chain.rows.len());
    let mut recovery_bytes = 0_u64;
    let mut row_ids = HashSet::with_capacity(chain.rows.len());
    let mut request_lookups = HashSet::with_capacity(chain.rows.len());
    let mut rows_by_inbox = HashSet::with_capacity(chain.rows.len());
    while let Some(row) = rows.next().map_err(|_| store_crypto_corrupt())? {
        if verified_rows.len() >= chain.rows.len() {
            return Err(store_crypto_corrupt());
        }
        recovery_bytes = preflight_crypto_row(row, recovery_bytes)?;
        let stored = read_stored_crypto_row(row).map_err(|_| store_crypto_corrupt())?;
        let verified_row = read_and_verify_crypto_row(stored, keyring)?;
        if !row_ids.insert(verified_row.crypto_row_id.as_str().to_owned())
            || !request_lookups.insert((
                verified_row.inbox_id.as_str().to_owned(),
                verified_row.request_lookup,
            ))
            || !rows_by_inbox.insert(verified_row.inbox_id.as_str().to_owned())
        {
            return Err(store_crypto_corrupt());
        }
        let parent = chain
            .rows
            .iter()
            .find(|candidate| candidate.inbox_id() == &verified_row.inbox_id)
            .ok_or_else(store_crypto_corrupt)?;
        verify_crypto_parent_row(parent, &verified_row)?;
        verified_rows.push(verified_row);
    }
    if verified_rows
        .iter()
        .filter(|row| is_unresolved_crypto_state(row.state))
        .count()
        > 1
    {
        return Err(store_crypto_corrupt());
    }
    Ok(verified_rows)
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

fn valid_stored_crypto_row_id(value: &str) -> bool {
    value.len() == CRYPTO_ROW_ID_BYTES
        && value.starts_with("crypto_")
        && value.as_bytes()["crypto_".len()..]
            .iter()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(byte))
}

fn valid_stored_crypto_request_kind(value: &str) -> bool {
    value == MATRIX_CRYPTO_REQUEST_KIND
}

fn valid_stored_crypto_state(value: &str) -> bool {
    matches!(
        value,
        "pending" | "response_received" | "accepted" | "quarantined"
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

    fn into_uncommitted(self) -> Vec<RawSyncInbox> {
        let Some(start) = self.first_uncommitted_position else {
            return Vec::new();
        };
        let mut rows = self.rows.into_iter().map(Some).collect::<Vec<_>>();
        self.ordered_indices[start..]
            .iter()
            .map(|index| rows[*index].take().expect("verified inbox index"))
            .collect()
    }
}

fn sync_inbox_scan_limit() -> Result<i64, SafeError> {
    MAX_PENDING_REQUEST_ROWS
        .checked_add(1)
        .and_then(|limit| i64::try_from(limit).ok())
        .ok_or_else(store_sync_corrupt)
}

fn checked_sync_inbox_bytes(current_total: u64, new_bytes: u64) -> Result<u64, ()> {
    checked_recovery_bytes(current_total, new_bytes)
}

fn checked_recovery_bytes(current_total: u64, new_bytes: u64) -> Result<u64, ()> {
    current_total
        .checked_add(new_bytes)
        .filter(|total| *total <= MAX_RECOVERY_BYTES)
        .ok_or(())
}

/// Add one protected value to the recovery aggregate.
///
/// Recovery limits count the ciphertext stored in SQLite. Callers pass the
/// plaintext length for new values, so this helper adds the AEAD tag before
/// applying the checked aggregate cap.
fn checked_protected_recovery_bytes(current_total: u64, plaintext_len: usize) -> Result<u64, ()> {
    let plaintext_len = u64::try_from(plaintext_len).map_err(|_| ())?;
    let protected_len = plaintext_len
        .checked_add(u64::try_from(AEAD_TAG_BYTES).map_err(|_| ())?)
        .ok_or(())?;
    checked_recovery_bytes(current_total, protected_len)
}

fn checked_crypto_recovery_bytes(
    current_total: u64,
    sdk_request_id_ciphertext_len: u64,
    request_ciphertext_len: u64,
    response_ciphertext_len: Option<u64>,
) -> Result<u64, ()> {
    [
        sdk_request_id_ciphertext_len,
        request_ciphertext_len,
        response_ciphertext_len.unwrap_or(0),
    ]
    .into_iter()
    .try_fold(current_total, checked_recovery_bytes)
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

fn load_crypto_context(
    connection: &Connection,
    keyring: &Keyring,
) -> Result<VerifiedCryptoContext, SafeError> {
    let gateway =
        require_bootstrap_singleton(connection, keyring, true).map_err(map_crypto_storage_error)?;
    let Some(gateway) = gateway else {
        return Err(store_crypto_not_ready());
    };
    let committed_token =
        load_verified_gateway_token(connection, keyring, GatewayTokenField::Committed)
            .map_err(map_crypto_storage_error)?;
    let fetch_token = load_verified_gateway_token(connection, keyring, GatewayTokenField::Fetch)
        .map_err(map_crypto_storage_error)?;
    let chain = verify_inbox_chain(connection, keyring, &committed_token, &fetch_token)
        .map_err(map_crypto_storage_error)?;
    let crypto_rows =
        load_verified_crypto_rows(connection, keyring, &chain).map_err(map_crypto_storage_error)?;
    Ok(VerifiedCryptoContext {
        gateway,
        chain,
        crypto_rows,
    })
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
            ordered_indices: Vec::new(),
            tail_index: None,
            first_uncommitted_index: None,
            first_uncommitted_position: None,
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
    let mut first_uncommitted_position = None;
    let mut committed_tail_index = None;
    let mut ordered_indices = Vec::with_capacity(row_capacity);
    while let Some(index) = current {
        if visited[index] {
            return Err(store_sync_corrupt());
        }
        visited[index] = true;
        ordered_indices.push(index);
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
        } else if first_uncommitted_position.is_none() {
            first_uncommitted_index = Some(index);
            first_uncommitted_position = Some(ordered_indices.len() - 1);
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
        ordered_indices,
        tail_index: Some(tail_index),
        first_uncommitted_index,
        first_uncommitted_position,
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
    connection
        .execute_batch(ATTACHMENT_DESCRIPTOR_MIGRATION_SQL)
        .map_err(|_| StoreError::new(STORE_SCHEMA_INITIALIZE))?;
    connection
        .execute_batch(OUTBOUND_TRANSACTION_MIGRATION_SQL)
        .map_err(|_| StoreError::new(STORE_SCHEMA_INITIALIZE))?;
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

fn valid_resource_id_for_store(value: &str) -> bool {
    model::valid_resource_id(value)
}

fn valid_digest(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}

fn valid_outbound_state(value: &str) -> bool {
    matches!(
        value,
        "accepted"
            | "uncertain"
            | "rejected"
            | "rate_limited"
            | "session_expired"
            | "missing_capability"
    )
}

fn valid_matrix_stage(value: &str) -> bool {
    matches!(value, "unknown" | "confirmed")
}

fn valid_bridge_stage(value: &str) -> bool {
    matches!(value, "unknown" | "accepted" | "uncertain")
}

fn valid_provider_stage(value: &str) -> bool {
    matches!(value, "unknown" | "accepted" | "delivered" | "uncertain")
}

fn validate_outbound_text_input(input: &NewOutboundText) -> Result<(), SafeError> {
    if !valid_resource_id_for_store(&input.transaction_id)
        || input.idempotency_key.is_empty()
        || input.idempotency_key.len() > 512
        || !valid_digest(&input.request_digest)
        || !valid_resource_id_for_store(&input.tenant_id)
        || !valid_resource_id_for_store(&input.account_id)
        || !valid_resource_id_for_store(&input.connection_id)
        || !valid_resource_id_for_store(&input.identity_id)
        || !valid_resource_id_for_store(&input.conversation_id)
        || !valid_resource_id_for_store(&input.message_id)
        || !valid_resource_id_for_store(&input.event_id)
        || !model::valid_matrix_room_id(&input.matrix_room_id)
        || !model::valid_timestamp(&input.session_generation)
        || input.projection_generation == 0
        || input.body.is_empty()
        || input.body.len() > 20_000
        || !model::valid_timestamp(&input.created_at.to_rfc3339())
    {
        return Err(SafeError::new(STORE_OUTBOUND_INVALID));
    }
    Ok(())
}

fn read_stored_outbound_row(row: &Row<'_>) -> rusqlite::Result<StoredOutboundTextRow> {
    Ok(StoredOutboundTextRow {
        transaction_id: row.get(0)?,
        idempotency_key: row.get(1)?,
        request_digest: row.get(2)?,
        body_digest: row.get(3)?,
        tenant_id: row.get(4)?,
        account_id: row.get(5)?,
        connection_id: row.get(6)?,
        identity_id: row.get(7)?,
        conversation_id: row.get(8)?,
        message_id: row.get(9)?,
        event_id: row.get(10)?,
        matrix_room_id: row.get(11)?,
        session_generation: row.get(12)?,
        projection_generation: row.get(13)?,
        body_cipher: row.get(14)?,
        body_nonce: row.get(15)?,
        body_key_version: row.get(16)?,
        state: row.get(17)?,
        response_cipher: row.get(18)?,
        response_nonce: row.get(19)?,
        response_key_version: row.get(20)?,
        response_sha256: row.get(21)?,
        created_at: row.get(22)?,
        updated_at: row.get(23)?,
    })
}

fn outbound_matches(
    row: &StoredOutboundTextRow,
    input: &NewOutboundText,
    body_digest: &[u8; 32],
    body: &[u8],
) -> bool {
    row.transaction_id == input.transaction_id
        && row.idempotency_key == input.idempotency_key
        && row.request_digest == input.request_digest
        && row.body_digest.as_slice() == body_digest
        && row.tenant_id == input.tenant_id
        && row.account_id == input.account_id
        && row.connection_id == input.connection_id
        && row.identity_id == input.identity_id
        && row.conversation_id == input.conversation_id
        && row.message_id == input.message_id
        && row.event_id == input.event_id
        && row.matrix_room_id == input.matrix_room_id
        && row.session_generation == input.session_generation
        && row.projection_generation == i64::try_from(input.projection_generation).unwrap_or(-1)
        && body == input.body.as_bytes()
}

fn sealed_outbound_value(
    ciphertext: Vec<u8>,
    nonce: Vec<u8>,
    key_version: i64,
) -> Result<Sealed, SafeError> {
    let nonce: [u8; 24] = nonce
        .try_into()
        .map_err(|_| SafeError::new(STORE_OUTBOUND_CORRUPT))?;
    let key_version =
        u32::try_from(key_version).map_err(|_| SafeError::new(STORE_OUTBOUND_CORRUPT))?;
    Ok(Sealed {
        nonce,
        ciphertext,
        key_version,
    })
}

fn open_outbound_body(
    keyring: &Keyring,
    row: &StoredOutboundTextRow,
) -> Result<Vec<u8>, SafeError> {
    let sealed = sealed_outbound_value(
        row.body_cipher.clone(),
        row.body_nonce.clone(),
        row.body_key_version,
    )?;
    let plaintext = keyring
        .open(
            "outbound_transactions",
            &row.transaction_id,
            "body",
            &sealed,
        )
        .map_err(|_| SafeError::new(STORE_OUTBOUND_CORRUPT))?;
    if sha256(plaintext.as_bytes()).as_slice() != row.body_digest.as_slice() {
        return Err(SafeError::new(STORE_OUTBOUND_CORRUPT));
    }
    Ok(plaintext.as_bytes().to_vec())
}

fn open_outbound_response(
    keyring: &Keyring,
    row: &StoredOutboundTextRow,
) -> Result<Option<Vec<u8>>, SafeError> {
    let Some(ciphertext) = row.response_cipher.clone() else {
        return Ok(None);
    };
    let nonce = row
        .response_nonce
        .clone()
        .ok_or_else(|| SafeError::new(STORE_OUTBOUND_CORRUPT))?;
    let key_version = row
        .response_key_version
        .ok_or_else(|| SafeError::new(STORE_OUTBOUND_CORRUPT))?;
    let expected_digest = row
        .response_sha256
        .as_deref()
        .ok_or_else(|| SafeError::new(STORE_OUTBOUND_CORRUPT))?;
    let sealed = sealed_outbound_value(ciphertext, nonce, key_version)?;
    let plaintext = keyring
        .open(
            "outbound_transactions",
            &row.transaction_id,
            "response",
            &sealed,
        )
        .map_err(|_| SafeError::new(STORE_OUTBOUND_CORRUPT))?;
    if sha256(plaintext.as_bytes()).as_slice() != expected_digest {
        return Err(SafeError::new(STORE_OUTBOUND_CORRUPT));
    }
    Ok(Some(plaintext.as_bytes().to_vec()))
}

fn seal_optional_outbound_value(
    keyring: &Keyring,
    transaction_id: &str,
    column: &str,
    value: Option<&[u8]>,
) -> Result<Option<Sealed>, SafeError> {
    value
        .map(|value| {
            if value.is_empty() || value.len() > 16 * 1024 {
                return Err(SafeError::new(STORE_OUTBOUND_INVALID));
            }
            keyring
                .seal("outbound_transactions", transaction_id, column, value)
                .map_err(|_| SafeError::new(STORE_OUTBOUND_INVALID))
        })
        .transpose()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ledger::NewLiveWindow;
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
    fn checked_recovery_bytes_applies_the_cap_across_each_addition() {
        assert_eq!(
            checked_recovery_bytes(MAX_RECOVERY_BYTES - 1, 1),
            Ok(MAX_RECOVERY_BYTES)
        );
        assert_eq!(checked_recovery_bytes(MAX_RECOVERY_BYTES, 1), Err(()));
        assert_eq!(checked_recovery_bytes(u64::MAX, 0), Err(()));
    }

    #[test]
    fn checked_crypto_recovery_bytes_checks_each_secret_ciphertext_and_the_cap() {
        assert_eq!(checked_crypto_recovery_bytes(0, 5, 7, Some(9)), Ok(21));
        assert_eq!(
            checked_crypto_recovery_bytes(MAX_RECOVERY_BYTES - 3, 1, 2, None),
            Ok(MAX_RECOVERY_BYTES)
        );
        assert_eq!(
            checked_crypto_recovery_bytes(MAX_RECOVERY_BYTES - 3, 1, 3, None),
            Err(())
        );
        assert_eq!(
            checked_crypto_recovery_bytes(u64::MAX - 1, 0, 0, Some(2)),
            Err(())
        );
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

    #[test]
    fn outbound_completion_promotes_late_matrix_confirmation_and_replays_after_reopen() {
        let directory = tempdir().expect("create outbound completion test directory");
        std::fs::set_permissions(directory.path(), std::fs::Permissions::from_mode(0o700))
            .expect("secure outbound completion test directory");
        let path = directory.path().join("gateway.sqlite3");
        let key_material = [0x22; 32];
        let created_at = Utc
            .timestamp_millis_opt(1_700_000_000_000)
            .single()
            .expect("test timestamp");
        let input = NewOutboundText {
            transaction_id: "txn_outbound_race".to_owned(),
            idempotency_key: "idem_outbound_race".to_owned(),
            request_digest: "a".repeat(64),
            tenant_id: "tenant_test".to_owned(),
            account_id: "account_test".to_owned(),
            connection_id: "connection_test".to_owned(),
            identity_id: "identity_test".to_owned(),
            conversation_id: "conversation_test".to_owned(),
            message_id: "message_test".to_owned(),
            event_id: "event_test".to_owned(),
            matrix_room_id: "!room-test:example.org".to_owned(),
            session_generation: created_at.to_rfc3339(),
            projection_generation: 1,
            body: "durable outbound body".to_owned(),
            created_at,
        };
        let uncertain_response = br#"{"outcome":"uncertain"}"#.to_vec();
        let accepted_response = br#"{"outcome":"accepted","event_id":"$event"}"#.to_vec();
        let matrix_evidence =
            br#"{"source":"matrix","status":"confirmed","event_id":"$event"}"#.to_vec();

        {
            let mut store =
                Store::open(&path, Keyring::new(key_material, 1).expect("test keyring"))
                    .expect("open outbound store");
            assert!(matches!(
                store
                    .prepare_outbound_text(input.clone())
                    .expect("claim outbound row"),
                OutboundTextPreparation::Created
            ));
            store
                .complete_outbound_text(
                    &input.tenant_id,
                    &input.transaction_id,
                    &input.request_digest,
                    OutboundTextCompletion {
                        state: "uncertain".to_owned(),
                        matrix_stage: "unknown".to_owned(),
                        bridge_stage: "unknown".to_owned(),
                        provider_stage: "unknown".to_owned(),
                        response: uncertain_response,
                        matrix_evidence: None,
                        bridge_evidence: None,
                        provider_evidence: None,
                        updated_at: created_at,
                    },
                )
                .expect("record duplicate uncertainty");
            store
                .complete_outbound_text(
                    &input.tenant_id,
                    &input.transaction_id,
                    &input.request_digest,
                    OutboundTextCompletion {
                        state: "accepted".to_owned(),
                        matrix_stage: "confirmed".to_owned(),
                        bridge_stage: "unknown".to_owned(),
                        provider_stage: "unknown".to_owned(),
                        response: accepted_response.clone(),
                        matrix_evidence: Some(matrix_evidence),
                        bridge_evidence: None,
                        provider_evidence: None,
                        updated_at: created_at + chrono::Duration::seconds(1),
                    },
                )
                .expect("promote late Matrix confirmation");
        }

        let mut reopened = Store::open(
            &path,
            Keyring::new(key_material, 1).expect("reopen test keyring"),
        )
        .expect("reopen outbound store");
        match reopened
            .prepare_outbound_text(input)
            .expect("replay outbound row after reopen")
        {
            OutboundTextPreparation::ExistingTerminal { response } => {
                assert_eq!(response, accepted_response);
            }
            OutboundTextPreparation::Created | OutboundTextPreparation::ExistingPending => {
                panic!("late Matrix confirmation was not durably replayable")
            }
        }
    }

    #[test]
    fn inbox_crypto_pressure_uses_immutable_parent_age() {
        let directory = tempdir().expect("create crypto pressure test directory");
        std::fs::set_permissions(directory.path(), std::fs::Permissions::from_mode(0o700))
            .expect("secure crypto pressure test directory");
        let path = directory.path().join("gateway.sqlite3");
        let mut store = Store::open(&path, Keyring::new([0x11; 32], 1).expect("test keyring"))
            .expect("open crypto pressure test store");
        let parent_observed_at = Utc
            .timestamp_millis_opt(1_700_000_000_000)
            .single()
            .expect("parent timestamp");
        store
            .initialize_bootstrap_state(
                NewBootstrapState::new(
                    b"session".to_vec(),
                    b"initial".to_vec(),
                    Vec::new(),
                    parent_observed_at,
                )
                .expect("construct bootstrap test state"),
            )
            .expect("initialize crypto pressure test store");

        let inbox_id = store
            .append_fetched_sync(NewRawSyncInbox::new_unchecked_for_test(
                b"initial".to_vec(),
                b"next-1".to_vec(),
                b"response".to_vec(),
                parent_observed_at,
            ))
            .expect("append old inbox");
        let request = ExactMatrixRequest::keys_query(b"sdk-request-id".to_vec(), br#"{}"#.to_vec())
            .expect("construct crypto request");
        store
            .record_sdk_processing(inbox_id.as_str(), &[request])
            .expect("record crypto request");
        let request_lookup =
            matrix_request_lookup(&store.keyring, b"{}").expect("derive crypto request lookup");
        let crypto_row_id =
            derive_crypto_row_id(&inbox_id, &request_lookup).expect("derive crypto row id");
        let retry_at = Utc
            .timestamp_millis_opt(1_700_000_002_000)
            .single()
            .expect("retry timestamp");
        store
            .record_attempt(
                crypto_row_id.as_str(),
                0,
                parent_observed_at,
                Utc.timestamp_millis_opt(1_700_000_001_000)
                    .single()
                    .expect("lease timestamp"),
                retry_at,
            )
            .expect("lease and reschedule crypto request");

        let pressure = store.inbox_crypto_pressure().expect("read crypto pressure");
        assert_eq!(pressure.oldest_pending_at(), Some(parent_observed_at));
    }

    #[test]
    fn inbox_crypto_pressure_reports_oldest_purge_candidate_deadline() {
        let directory = tempdir().expect("create retention deadline test directory");
        std::fs::set_permissions(directory.path(), std::fs::Permissions::from_mode(0o700))
            .expect("secure retention deadline test directory");
        let path = directory.path().join("gateway.sqlite3");
        let mut store = Store::open(&path, Keyring::new([0x11; 32], 1).expect("test keyring"))
            .expect("open retention deadline test store");
        let first_observed_at = Utc
            .timestamp_millis_opt(1_700_000_000_000)
            .single()
            .expect("first observation timestamp");
        store
            .initialize_bootstrap_state(
                NewBootstrapState::new(
                    b"session".to_vec(),
                    b"initial".to_vec(),
                    Vec::new(),
                    first_observed_at,
                )
                .expect("construct bootstrap test state"),
            )
            .expect("initialize retention deadline test store");

        let first_id = store
            .append_fetched_sync(NewRawSyncInbox::new_unchecked_for_test(
                b"initial".to_vec(),
                b"next-1".to_vec(),
                br#"{"next_batch":"next-1"}"#.to_vec(),
                first_observed_at,
            ))
            .expect("append first inbox")
            .as_str()
            .to_owned();
        store
            .record_sdk_processing(&first_id, &[])
            .expect("record first empty SDK processing");
        store
            .mark_crypto_drained(&first_id)
            .expect("drain first empty crypto set");
        let first_window_id = format!(
            "window_{}",
            store
                .keyring
                .lookup_digest("matrix-live-window-v1", &[&first_id])
                .expect("derive first window ID")
                .iter()
                .map(|byte| format!("{byte:02x}"))
                .collect::<String>()
        );
        store
            .create_collecting_live_window(
                &first_id,
                NewLiveWindow::new(first_window_id.clone(), first_observed_at, 0)
                    .expect("create first collecting window"),
            )
            .expect("create first empty window");
        let first_committed_at = Utc
            .timestamp_millis_opt(1_700_000_000_100)
            .single()
            .expect("first commit timestamp");
        store
            .commit_empty_live_window(&first_id, &first_window_id, &[], &[], first_committed_at)
            .expect("commit first empty window");

        let second_observed_at = Utc
            .timestamp_millis_opt(1_700_000_001_000)
            .single()
            .expect("second observation timestamp");
        let second_id = store
            .append_fetched_sync(NewRawSyncInbox::new_unchecked_for_test(
                b"next-1".to_vec(),
                b"next-2".to_vec(),
                br#"{"next_batch":"next-2"}"#.to_vec(),
                second_observed_at,
            ))
            .expect("append second inbox")
            .as_str()
            .to_owned();
        store
            .record_sdk_processing(&second_id, &[])
            .expect("record second empty SDK processing");
        store
            .mark_crypto_drained(&second_id)
            .expect("drain second empty crypto set");
        let second_window_id = format!(
            "window_{}",
            store
                .keyring
                .lookup_digest("matrix-live-window-v1", &[&second_id])
                .expect("derive second window ID")
                .iter()
                .map(|byte| format!("{byte:02x}"))
                .collect::<String>()
        );
        store
            .create_collecting_live_window(
                &second_id,
                NewLiveWindow::new(second_window_id.clone(), second_observed_at, 0)
                    .expect("create second collecting window"),
            )
            .expect("create second empty window");
        let second_committed_at = Utc
            .timestamp_millis_opt(1_700_000_001_100)
            .single()
            .expect("second commit timestamp");
        store
            .commit_empty_live_window(&second_id, &second_window_id, &[], &[], second_committed_at)
            .expect("commit second empty window");

        let expected = first_committed_at
            .checked_add_signed(chrono::Duration::days(7))
            .and_then(|value| value.checked_add_signed(chrono::Duration::milliseconds(1)))
            .expect("retention deadline");
        let pressure = store
            .inbox_crypto_pressure()
            .expect("read retention pressure");
        assert_eq!(pressure.next_retention_at(), Some(expected));
    }
}
