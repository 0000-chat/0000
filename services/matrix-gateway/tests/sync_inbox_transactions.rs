use std::{
    fmt::Write as _,
    fs,
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
};

use chrono::{DateTime, Duration, TimeZone, Utc};
use communicator_matrix_gateway::{
    config::{MAX_PENDING_REQUEST_ROWS, MAX_RECOVERY_BYTES},
    crypto::{AEAD_TAG_BYTES, Keyring, Sealed},
    secret::SafeError,
    store::{
        STORE_ALREADY_BOOTSTRAPPED, STORE_BOOTSTRAP_INVALID, STORE_SDK_POSITION_UNJOURNALED,
        STORE_SYNC_CONFLICT, STORE_SYNC_CORRUPT, STORE_SYNC_INVALID, STORE_SYNC_TOKEN_MISMATCH,
        STORE_SYNC_TOO_LARGE, Store,
    },
    store_types::{
        InboxId, MAX_BOOTSTRAP_ROOM_ANCHORS, MAX_BOOTSTRAP_SESSION_BYTES, MAX_ROOM_ANCHOR_BYTES,
        MAX_SYNC_RESPONSE_BYTES, MAX_SYNC_TOKEN_BYTES, NewBootstrapState, NewRawSyncInbox,
        ReasonCode, RoomAnchor, SdkInboxPosition, SyncInboxState,
    },
};
use rusqlite::{Connection, OptionalExtension, Transaction, params, types::Value};
use sha2::{Digest, Sha256};
use tempfile::tempdir;

const CANARIES: [&str; 3] = [
    "sync-request-canary-6e0f8a3e",
    "sync-next-token-canary-9b1a5d7c",
    "sync-response-canary-2c4f7e81",
];

fn timestamp(milliseconds: i64) -> DateTime<Utc> {
    Utc.timestamp_millis_opt(milliseconds)
        .single()
        .expect("construct test timestamp")
}

fn assert_error(error: SafeError, code: &str) {
    assert_eq!(error.code(), code);
    assert_eq!(error.to_string(), code);
    assert_eq!(format!("{error}"), code);
}

fn anchor(lookup: [u8; 32], bytes: usize) -> RoomAnchor {
    RoomAnchor::new(lookup, vec![0xA5; bytes]).expect("construct test room anchor")
}

fn secure_tempdir() -> tempfile::TempDir {
    let directory = tempdir().expect("create temporary state directory");
    fs::set_permissions(directory.path(), fs::Permissions::from_mode(0o700))
        .expect("secure temporary state directory");
    directory
}

fn database_path(directory: &Path) -> PathBuf {
    directory.join("gateway.sqlite3")
}

fn test_keyring() -> Keyring {
    Keyring::new([0x11; 32], 1).expect("construct fixed test keyring")
}

fn bootstrap_state(session: &[u8], token: &[u8], anchors: Vec<RoomAnchor>) -> NewBootstrapState {
    NewBootstrapState::new(
        session.to_vec(),
        token.to_vec(),
        anchors,
        timestamp(1_700_000_000_000),
    )
    .expect("construct valid bootstrap state")
}

#[derive(Clone, Eq, PartialEq)]
struct RawGatewayState {
    singleton: i64,
    session_cipher: Vec<u8>,
    session_nonce: Vec<u8>,
    session_key_version: i64,
    committed_token_cipher: Vec<u8>,
    committed_token_nonce: Vec<u8>,
    committed_token_key_version: i64,
    fetch_token_cipher: Vec<u8>,
    fetch_token_nonce: Vec<u8>,
    fetch_token_key_version: i64,
    maintenance_code: Option<String>,
    maintenance_since: Option<String>,
    bootstrapped_at: Option<String>,
    updated_at: String,
}

fn raw_gateway_state(path: &Path) -> Option<RawGatewayState> {
    let connection = Connection::open(path).expect("open sqlite database for bootstrap inspection");
    connection
        .query_row(
            "SELECT singleton, session_cipher, session_nonce, session_key_version,
                    committed_token_cipher, committed_token_nonce, committed_token_key_version,
                    fetch_token_cipher, fetch_token_nonce, fetch_token_key_version,
                    maintenance_code, maintenance_since, bootstrapped_at, updated_at
             FROM gateway_state",
            [],
            |row| {
                Ok(RawGatewayState {
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
        .expect("read gateway bootstrap row")
}

#[derive(Eq, PartialEq)]
struct RawRoomProgress {
    room_lookup: Vec<u8>,
    anchor_event_cipher: Vec<u8>,
    anchor_event_nonce: Vec<u8>,
    key_version: i64,
    updated_at: String,
}

fn raw_room_progress(path: &Path) -> Vec<RawRoomProgress> {
    let connection = Connection::open(path).expect("open sqlite database for anchor inspection");
    let mut statement = connection
        .prepare(
            "SELECT room_lookup, anchor_event_cipher, anchor_event_nonce,
                    key_version, updated_at
             FROM room_progress ORDER BY room_lookup",
        )
        .expect("prepare room anchor inspection");
    statement
        .query_map([], |row| {
            Ok(RawRoomProgress {
                room_lookup: row.get(0)?,
                anchor_event_cipher: row.get(1)?,
                anchor_event_nonce: row.get(2)?,
                key_version: row.get(3)?,
                updated_at: row.get(4)?,
            })
        })
        .expect("query room anchor inspection")
        .collect::<Result<Vec<_>, _>>()
        .expect("read room anchor rows")
}

fn table_count(path: &Path, table: &str) -> i64 {
    let connection = Connection::open(path).expect("open sqlite database for count inspection");
    connection
        .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
            row.get(0)
        })
        .expect("count sqlite rows")
}

fn sqlite_storage_bytes(path: &Path) -> Vec<u8> {
    let mut bytes = fs::read(path).expect("read sqlite database bytes");
    for suffix in ["-wal", "-shm"] {
        let mut sidecar = PathBuf::from(path);
        let name = format!(
            "{}{}",
            sidecar
                .file_name()
                .expect("database filename")
                .to_string_lossy(),
            suffix
        );
        sidecar.set_file_name(name);
        if let Ok(mut sidecar_bytes) = fs::read(sidecar) {
            bytes.append(&mut sidecar_bytes);
        }
    }
    bytes
}

fn assert_storage_excludes(bytes: &[u8], needle: &[u8]) {
    assert!(!bytes.windows(needle.len()).any(|window| window == needle));
}

fn assert_protected_bytes_eq(actual: &[u8], expected: &[u8], label: &str) {
    assert!(actual == expected, "{label} mismatch");
}

fn assert_gateway_snapshot_eq(
    actual: &Option<RawGatewayState>,
    expected: &Option<RawGatewayState>,
) {
    assert!(actual == expected, "gateway state snapshot mismatch");
}

fn assert_room_progress_snapshot_eq(actual: &[RawRoomProgress], expected: &[RawRoomProgress]) {
    assert!(actual == expected, "room progress snapshot mismatch");
}

fn assert_sync_inbox_snapshot_eq(actual: &[RawSyncInboxRow], expected: &[RawSyncInboxRow]) {
    assert!(actual == expected, "sync inbox snapshot mismatch");
}

#[derive(Clone, Eq, PartialEq)]
struct SyncInboxMetadata {
    inbox_id: String,
    predecessor_id: Option<String>,
    request_cipher_len: i64,
    request_nonce_len: i64,
    next_cipher_len: i64,
    next_nonce_len: i64,
    response_cipher_len: i64,
    response_nonce_len: i64,
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

fn raw_sync_inbox_metadata(path: &Path) -> Vec<SyncInboxMetadata> {
    let connection = Connection::open(path).expect("open sqlite metadata inspection");
    let row_limit = i64::try_from(MAX_PENDING_REQUEST_ROWS + 1).expect("sync row limit");
    let mut statement = connection
        .prepare(
            "SELECT inbox_id, predecessor_id,
                    length(request_token_cipher), length(request_token_nonce),
                    length(next_token_cipher), length(next_token_nonce),
                    length(response_cipher), length(response_nonce), byte_count,
                    state, crypto_drained, observed_at, created_at,
                    sdk_processed_at, prepared_at, committed_at, terminal_code
             FROM sync_inbox ORDER BY rowid LIMIT ?1",
        )
        .expect("prepare sqlite metadata inspection");
    statement
        .query_map([row_limit], |row| {
            Ok(SyncInboxMetadata {
                inbox_id: row.get(0)?,
                predecessor_id: row.get(1)?,
                request_cipher_len: row.get(2)?,
                request_nonce_len: row.get(3)?,
                next_cipher_len: row.get(4)?,
                next_nonce_len: row.get(5)?,
                response_cipher_len: row.get(6)?,
                response_nonce_len: row.get(7)?,
                byte_count: row.get(8)?,
                state: row.get(9)?,
                crypto_drained: row.get(10)?,
                observed_at: row.get(11)?,
                created_at: row.get(12)?,
                sdk_processed_at: row.get(13)?,
                prepared_at: row.get(14)?,
                committed_at: row.get(15)?,
                terminal_code: row.get(16)?,
            })
        })
        .expect("query sqlite metadata inspection")
        .collect::<Result<Vec<_>, _>>()
        .expect("read sqlite metadata rows")
}

fn assert_sync_inbox_metadata_eq(actual: &[SyncInboxMetadata], expected: &[SyncInboxMetadata]) {
    assert!(actual == expected, "sync inbox metadata mismatch");
}

fn assert_code_only(error: SafeError, code: &str) {
    assert_eq!(error.code(), code);
    assert_eq!(error.to_string(), code);
    assert_eq!(format!("{error}"), code);
    assert_eq!(
        format!("{error:?}"),
        format!("SafeError {{ code: \"{code}\" }}")
    );
}

fn unique_anchors(count: usize) -> Vec<RoomAnchor> {
    let mut anchors = Vec::with_capacity(count);
    for index in 0..count {
        let mut lookup = [0_u8; 32];
        lookup[24..].copy_from_slice(&(index as u64).to_be_bytes());
        anchors.push(anchor(lookup, 1));
    }
    anchors
}

#[derive(Clone, Eq, PartialEq)]
struct RawSyncInboxRow {
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

fn raw_sync_inbox_rows(path: &Path) -> Vec<RawSyncInboxRow> {
    let connection = Connection::open(path).expect("open sqlite database for sync inspection");
    let row_limit = i64::try_from(MAX_PENDING_REQUEST_ROWS + 1).expect("sync row limit");
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
        .expect("prepare sync inbox inspection");
    statement
        .query_map([row_limit], |row| {
            Ok(RawSyncInboxRow {
                inbox_id: row.get(0)?,
                predecessor_id: row.get(1)?,
                request_token_cipher: row.get(2)?,
                request_token_nonce: row.get(3)?,
                request_token_key_version: row.get(4)?,
                request_token_digest: row.get(5)?,
                next_token_cipher: row.get(6)?,
                next_token_nonce: row.get(7)?,
                next_token_key_version: row.get(8)?,
                next_token_digest: row.get(9)?,
                response_cipher: row.get(10)?,
                response_nonce: row.get(11)?,
                response_key_version: row.get(12)?,
                response_sha256: row.get(13)?,
                byte_count: row.get(14)?,
                state: row.get(15)?,
                crypto_drained: row.get(16)?,
                observed_at: row.get(17)?,
                created_at: row.get(18)?,
                sdk_processed_at: row.get(19)?,
                prepared_at: row.get(20)?,
                committed_at: row.get(21)?,
                terminal_code: row.get(22)?,
            })
        })
        .expect("query sync inbox inspection")
        .collect::<Result<Vec<_>, _>>()
        .expect("read sync inbox rows")
}

fn raw_sync_inbox_values(path: &Path) -> Vec<Vec<Value>> {
    let connection = Connection::open(path).expect("open sqlite value inspection");
    let row_limit = i64::try_from(MAX_PENDING_REQUEST_ROWS + 1).expect("sync row limit");
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
        .expect("prepare sqlite value inspection");
    statement
        .query_map([row_limit], |row| {
            (0..23)
                .map(|index| row.get(index))
                .collect::<Result<Vec<Value>, _>>()
        })
        .expect("query sqlite value inspection")
        .collect::<Result<Vec<_>, _>>()
        .expect("read sqlite value rows")
}

fn raw_gateway_values(path: &Path) -> Vec<Vec<Value>> {
    let connection = Connection::open(path).expect("open sqlite gateway value inspection");
    let mut statement = connection
        .prepare(
            "SELECT singleton, session_cipher, session_nonce, session_key_version,
                    committed_token_cipher, committed_token_nonce, committed_token_key_version,
                    fetch_token_cipher, fetch_token_nonce, fetch_token_key_version,
                    maintenance_code, maintenance_since, bootstrapped_at, updated_at
             FROM gateway_state ORDER BY singleton",
        )
        .expect("prepare sqlite gateway value inspection");
    statement
        .query_map([], |row| {
            (0..14)
                .map(|index| row.get(index))
                .collect::<Result<Vec<Value>, _>>()
        })
        .expect("query sqlite gateway value inspection")
        .collect::<Result<Vec<_>, _>>()
        .expect("read sqlite gateway value rows")
}

fn digest(bytes: &[u8]) -> [u8; 32] {
    Sha256::digest(bytes).into()
}

fn derived_inbox_id(
    request_token_digest: &[u8; 32],
    next_token_digest: &[u8; 32],
    response_sha256: &[u8; 32],
) -> String {
    let mut framed = Vec::new();
    for value in [
        b"matrix-sync-inbox-v1".as_slice(),
        request_token_digest.as_slice(),
        next_token_digest.as_slice(),
        response_sha256.as_slice(),
    ] {
        framed.extend_from_slice(
            &(u32::try_from(value.len()).expect("test frame length")).to_be_bytes(),
        );
        framed.extend_from_slice(value);
    }
    let encoded = digest(&framed)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    format!("inbox_{encoded}")
}

fn raw_sync_input(
    request_token: &[u8],
    next_token: &[u8],
    response: &[u8],
    observed_at: i64,
) -> NewRawSyncInbox {
    NewRawSyncInbox::new(
        request_token.to_vec(),
        next_token.to_vec(),
        response.to_vec(),
        timestamp(observed_at),
    )
    .expect("construct valid raw sync input")
}

fn mark_inbox_committed(path: &Path, inbox_id: &str, at: i64) {
    let connection = Connection::open(path).expect("open sqlite commit fixture");
    let at = timestamp(at).to_rfc3339();
    connection
        .execute(
            "UPDATE sync_inbox
             SET state = 'committed', sdk_processed_at = ?2,
                 prepared_at = ?2, committed_at = ?2
             WHERE inbox_id = ?1",
            params![inbox_id, at],
        )
        .expect("mark inbox committed fixture");
}

fn set_committed_token(path: &Path, token: &[u8]) {
    let sealed = test_keyring()
        .seal("gateway_state", "1", "committed_token", token)
        .expect("seal committed-token fixture");
    let connection = Connection::open(path).expect("open sqlite token fixture");
    connection
        .execute(
            "UPDATE gateway_state
             SET committed_token_cipher = ?1, committed_token_nonce = ?2,
                 committed_token_key_version = ?3",
            params![
                sealed.ciphertext,
                sealed.nonce.as_slice(),
                i64::from(sealed.key_version),
            ],
        )
        .expect("update committed-token fixture");
}

fn set_fetch_token(path: &Path, token: &[u8]) {
    let sealed = test_keyring()
        .seal("gateway_state", "1", "fetch_token", token)
        .expect("seal fetch-token fixture");
    let connection = Connection::open(path).expect("open sqlite token fixture");
    connection
        .execute(
            "UPDATE gateway_state
             SET fetch_token_cipher = ?1, fetch_token_nonce = ?2,
                 fetch_token_key_version = ?3",
            params![
                sealed.ciphertext,
                sealed.nonce.as_slice(),
                i64::from(sealed.key_version),
            ],
        )
        .expect("update fetch-token fixture");
}

fn insert_valid_fetched_row(
    transaction: &Transaction<'_>,
    predecessor_id: Option<&str>,
    request_token: &[u8],
    next_token: &[u8],
    response: &[u8],
    observed_at: i64,
) -> String {
    let request_token_digest = digest(request_token);
    let next_token_digest = digest(next_token);
    let response_sha256 = digest(response);
    let inbox_id = derived_inbox_id(&request_token_digest, &next_token_digest, &response_sha256);
    let keyring = test_keyring();
    let request_sealed = keyring
        .seal("sync_inbox", &inbox_id, "request_token", request_token)
        .expect("seal request token fixture");
    let next_sealed = keyring
        .seal("sync_inbox", &inbox_id, "next_token", next_token)
        .expect("seal next token fixture");
    let response_sealed = keyring
        .seal("sync_inbox", &inbox_id, "response", response)
        .expect("seal response fixture");
    let at = timestamp(observed_at).to_rfc3339();
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
                inbox_id,
                predecessor_id,
                request_sealed.ciphertext,
                request_sealed.nonce.as_slice(),
                i64::from(request_sealed.key_version),
                request_token_digest.as_slice(),
                next_sealed.ciphertext,
                next_sealed.nonce.as_slice(),
                i64::from(next_sealed.key_version),
                next_token_digest.as_slice(),
                response_sealed.ciphertext,
                response_sealed.nonce.as_slice(),
                i64::from(response_sealed.key_version),
                response_sha256.as_slice(),
                i64::try_from(response.len()).expect("fixture response length"),
                at,
            ],
        )
        .expect("insert valid fetched row fixture");
    inbox_id
}

fn populate_row_cap_chain(path: &Path) -> String {
    let connection = Connection::open(path).expect("open row-cap fixture");
    let transaction = connection
        .unchecked_transaction()
        .expect("begin row-cap fixture transaction");
    let mut predecessor_id = None;
    let mut first_id = String::new();
    for index in 0..MAX_PENDING_REQUEST_ROWS {
        let request = if index == 0 {
            b"initial".to_vec()
        } else {
            format!("next-{}", index - 1).into_bytes()
        };
        let next = format!("next-{index}").into_bytes();
        let id = insert_valid_fetched_row(
            &transaction,
            predecessor_id.as_deref(),
            &request,
            &next,
            &[u8::try_from(index % 251).expect("fixture byte")],
            1_700_000_001_000_i64
                .checked_add(i64::try_from(index).expect("fixture index") * 1_000)
                .expect("fixture timestamp"),
        );
        if index == 0 {
            first_id = id.clone();
        }
        predecessor_id = Some(id);
    }
    let final_token = format!("next-{}", MAX_PENDING_REQUEST_ROWS - 1);
    let sealed = test_keyring()
        .seal("gateway_state", "1", "fetch_token", final_token.as_bytes())
        .expect("seal row-cap fetch token");
    transaction
        .execute(
            "UPDATE gateway_state
             SET fetch_token_cipher = ?1, fetch_token_nonce = ?2,
                 fetch_token_key_version = ?3",
            params![
                sealed.ciphertext,
                sealed.nonce.as_slice(),
                i64::from(sealed.key_version),
            ],
        )
        .expect("set row-cap fetch token");
    transaction.commit().expect("commit row-cap fixture");
    first_id
}

fn setup_two_row_chain() -> (tempfile::TempDir, PathBuf, Store, String, String) {
    let directory = secure_tempdir();
    let path = database_path(directory.path());
    let mut store = Store::open(&path, test_keyring()).expect("open gateway store");
    store
        .initialize_bootstrap_state(bootstrap_state(b"session", b"initial", Vec::new()))
        .expect("initialize bootstrap state");
    let first = store
        .append_fetched_sync(raw_sync_input(
            b"initial",
            b"next-1",
            b"first",
            1_700_000_001_000,
        ))
        .expect("append first response");
    let second = store
        .append_fetched_sync(raw_sync_input(
            b"next-1",
            b"next-2",
            b"second",
            1_700_000_002_000,
        ))
        .expect("append second response");
    (
        directory,
        path,
        store,
        first.as_str().to_owned(),
        second.as_str().to_owned(),
    )
}

fn assert_both_chain_reads_corrupt(store: &Store, path: &Path, sdk_digest: &[u8; 32]) {
    let before_rows = raw_sync_inbox_rows(path);
    let before_gateway = raw_gateway_state(path);
    assert_code_only(
        store
            .reconcile_sdk_position(sdk_digest)
            .expect_err("reconcile must reject the corrupted retained chain"),
        STORE_SYNC_CORRUPT,
    );
    assert_code_only(
        store
            .oldest_uncommitted_inbox()
            .expect_err("oldest-inbox read must reject the corrupted retained chain"),
        STORE_SYNC_CORRUPT,
    );
    assert_sync_inbox_snapshot_eq(&raw_sync_inbox_rows(path), &before_rows);
    assert_gateway_snapshot_eq(&raw_gateway_state(path), &before_gateway);
}

fn update_predecessor(path: &Path, inbox_id: &str, predecessor_id: Option<&str>) {
    let connection = Connection::open(path).expect("open predecessor corruption fixture");
    connection
        .execute("PRAGMA foreign_keys = OFF", [])
        .expect("disable fixture foreign keys");
    connection
        .execute(
            "UPDATE sync_inbox SET predecessor_id = ?2 WHERE inbox_id = ?1",
            params![inbox_id, predecessor_id],
        )
        .expect("update predecessor fixture");
}

fn update_sync_inbox_sql(path: &Path, sql: &str) {
    let connection = Connection::open(path).expect("open sync corruption fixture");
    connection
        .execute("PRAGMA ignore_check_constraints = ON", [])
        .expect("enable fixture check bypass");
    connection
        .execute(sql, [])
        .expect("apply sync corruption fixture");
}

fn replace_sync_inbox_ciphertext_with_wrong_aad(
    path: &Path,
    inbox_id: &str,
    target_column: &str,
    aad_column: &str,
    plaintext: &[u8],
) {
    let sealed = test_keyring()
        .seal("sync_inbox", inbox_id, aad_column, plaintext)
        .expect("seal wrong-aad sync fixture");
    let connection = Connection::open(path).expect("open wrong-aad sync fixture");
    connection
        .execute(
            &format!(
                "UPDATE sync_inbox SET {target_column}_cipher = ?1,
                        {target_column}_nonce = ?2,
                        {target_column}_key_version = ?3
                 WHERE inbox_id = ?4"
            ),
            params![
                sealed.ciphertext,
                sealed.nonce.as_slice(),
                i64::from(sealed.key_version),
                inbox_id,
            ],
        )
        .expect("write wrong-aad sync fixture");
}

fn rebuild_sync_inbox_without_predecessor_unique_index(path: &Path) {
    let connection = Connection::open(path).expect("open fork fixture");
    connection
        .execute_batch(
            "PRAGMA foreign_keys = OFF;
             ALTER TABLE sync_inbox RENAME TO sync_inbox_original;
             CREATE TABLE sync_inbox_fork(
               inbox_id TEXT PRIMARY KEY, predecessor_id TEXT,
               request_token_cipher BLOB NOT NULL, request_token_nonce BLOB NOT NULL,
               request_token_key_version INTEGER NOT NULL, request_token_digest BLOB NOT NULL,
               next_token_cipher BLOB NOT NULL, next_token_nonce BLOB NOT NULL,
               next_token_key_version INTEGER NOT NULL, next_token_digest BLOB NOT NULL,
               response_cipher BLOB NOT NULL, response_nonce BLOB NOT NULL,
               response_key_version INTEGER NOT NULL, response_sha256 BLOB NOT NULL,
               byte_count INTEGER NOT NULL, state TEXT NOT NULL,
               crypto_drained INTEGER NOT NULL, observed_at TEXT NOT NULL,
               created_at TEXT NOT NULL, sdk_processed_at TEXT,
               prepared_at TEXT, committed_at TEXT, terminal_code TEXT
             );
             INSERT INTO sync_inbox_fork SELECT * FROM sync_inbox_original;
             DROP TABLE sync_inbox_original;
             ALTER TABLE sync_inbox_fork RENAME TO sync_inbox;
             PRAGMA foreign_keys = ON;",
        )
        .expect("rebuild fork fixture table");
}

fn rebuild_room_progress_without_lookup_unique_index(path: &Path) {
    let connection = Connection::open(path).expect("open duplicate room lookup fixture");
    connection
        .execute_batch(
            "PRAGMA foreign_keys = OFF;
             ALTER TABLE room_progress RENAME TO room_progress_original;
             CREATE TABLE room_progress(
               room_lookup BLOB,
               anchor_event_cipher BLOB NOT NULL, anchor_event_nonce BLOB NOT NULL,
               key_version INTEGER NOT NULL, updated_at TEXT NOT NULL
             );
             INSERT INTO room_progress SELECT * FROM room_progress_original;
             DROP TABLE room_progress_original;
             PRAGMA foreign_keys = ON;",
        )
        .expect("rebuild duplicate room lookup fixture table");
}

fn duplicate_room_progress_row(path: &Path, room_lookup: &[u8; 32]) {
    let connection = Connection::open(path).expect("open duplicate room lookup insert fixture");
    connection
        .execute(
            "INSERT INTO room_progress
             SELECT room_lookup, anchor_event_cipher, anchor_event_nonce,
                    key_version, updated_at
             FROM room_progress WHERE room_lookup = ?1 LIMIT 1",
            params![room_lookup.as_slice()],
        )
        .expect("insert duplicate unrelated room lookup fixture");
}

fn insert_extra_row_after_row_cap(path: &Path) {
    let rows = raw_sync_inbox_rows(path);
    let predecessor = rows.last().expect("row-cap tail").inbox_id.clone();
    let mut connection = Connection::open(path).expect("open over-cap fixture");
    let transaction = connection
        .transaction()
        .expect("begin over-cap fixture transaction");
    insert_valid_fetched_row(
        &transaction,
        Some(&predecessor),
        format!("next-{}", MAX_PENDING_REQUEST_ROWS - 1).as_bytes(),
        format!("next-{MAX_PENDING_REQUEST_ROWS}").as_bytes(),
        b"over-cap",
        1_700_000_003_000,
    );
    transaction.commit().expect("commit over-cap fixture");
    set_fetch_token(path, format!("next-{MAX_PENDING_REQUEST_ROWS}").as_bytes());
}

fn populate_aggregate_cap_chain(path: &Path) -> String {
    let connection = Connection::open(path).expect("open aggregate-cap fixture");
    let transaction = connection
        .unchecked_transaction()
        .expect("begin aggregate-cap fixture transaction");
    let mut predecessor_id = None;
    let mut first_id = String::new();
    for index in 0..4_u8 {
        let request = if index == 0 {
            b"initial".to_vec()
        } else {
            format!("next-{}", index - 1).into_bytes()
        };
        let next = format!("next-{index}").into_bytes();
        let response = vec![0xB0_u8 + index; MAX_SYNC_RESPONSE_BYTES];
        let id = insert_valid_fetched_row(
            &transaction,
            predecessor_id.as_deref(),
            &request,
            &next,
            &response,
            1_700_000_001_000 + i64::from(index) * 1_000,
        );
        if index == 0 {
            first_id = id.clone();
        }
        predecessor_id = Some(id);
    }
    transaction.commit().expect("commit aggregate-cap fixture");
    set_fetch_token(path, b"next-3");
    first_id
}

fn populate_small_four_row_chain(path: &Path) {
    let connection = Connection::open(path).expect("open small aggregate-cap fixture");
    let transaction = connection
        .unchecked_transaction()
        .expect("begin small aggregate-cap fixture transaction");
    let mut predecessor_id = None;
    for index in 0..4_u8 {
        let request = if index == 0 {
            b"initial".to_vec()
        } else {
            format!("next-{}", index - 1).into_bytes()
        };
        let next = format!("next-{index}").into_bytes();
        let id = insert_valid_fetched_row(
            &transaction,
            predecessor_id.as_deref(),
            &request,
            &next,
            b"small response",
            1_700_000_001_000 + i64::from(index) * 1_000,
        );
        predecessor_id = Some(id);
    }
    transaction
        .commit()
        .expect("commit small aggregate-cap fixture");
    set_fetch_token(path, b"next-3");
}

fn assert_two_row_corruption(mutate: impl FnOnce(&Path, &str, &str)) {
    let (_directory, path, store, first, second) = setup_two_row_chain();
    mutate(&path, &first, &second);
    assert_both_chain_reads_corrupt(&store, &path, &digest(b"next-2"));
}

#[test]
fn constants_match_the_locked_sync_limits() {
    assert_eq!(MAX_SYNC_RESPONSE_BYTES, 64 * 1024 * 1024);
    assert_eq!(MAX_PENDING_REQUEST_ROWS, 2_000);
    assert_eq!(MAX_RECOVERY_BYTES, 256 * 1024 * 1024);
    assert_eq!(MAX_SYNC_TOKEN_BYTES, 64 * 1024);
    assert_eq!(MAX_BOOTSTRAP_SESSION_BYTES, 1024 * 1024);
    assert_eq!(MAX_BOOTSTRAP_ROOM_ANCHORS, 100_000);
    assert_eq!(MAX_ROOM_ANCHOR_BYTES, 64 * 1024);
}

#[test]
fn stable_sync_error_constants_match_the_wire_contract() {
    assert_eq!(STORE_SYNC_INVALID, "store_sync_invalid");
    assert_eq!(STORE_SYNC_TOO_LARGE, "store_sync_too_large");
    assert_eq!(STORE_SYNC_TOKEN_MISMATCH, "store_sync_token_mismatch");
    assert_eq!(STORE_SYNC_CONFLICT, "store_sync_conflict");
    assert_eq!(
        STORE_SDK_POSITION_UNJOURNALED,
        "matrix_sdk_position_unjournaled"
    );
}

#[test]
fn room_anchor_accepts_nonempty_bytes_at_the_exact_limit() {
    let value = anchor([0x11; 32], MAX_ROOM_ANCHOR_BYTES);
    assert_eq!(value.room_lookup(), &[0x11; 32]);
    assert_eq!(value.anchor_event().as_bytes().len(), MAX_ROOM_ANCHOR_BYTES);

    assert_error(
        RoomAnchor::new([0x11; 32], Vec::new()).expect_err("empty anchor must fail"),
        STORE_BOOTSTRAP_INVALID,
    );
    assert_error(
        RoomAnchor::new([0x11; 32], vec![0xA5; MAX_ROOM_ANCHOR_BYTES + 1])
            .expect_err("oversized anchor must fail"),
        STORE_BOOTSTRAP_INVALID,
    );
}

#[test]
fn bootstrap_accepts_exact_session_token_and_anchor_limits() {
    let anchors = vec![anchor([0x22; 32], MAX_ROOM_ANCHOR_BYTES)];
    let value = NewBootstrapState::new(
        vec![0xB6; MAX_BOOTSTRAP_SESSION_BYTES],
        vec![0xC7; MAX_SYNC_TOKEN_BYTES],
        anchors,
        timestamp(1_700_000_000_000),
    )
    .expect("exact bootstrap limits must be accepted");
    let _ = value;

    assert_error(
        NewBootstrapState::new(
            Vec::new(),
            vec![0xC7],
            Vec::new(),
            timestamp(1_700_000_000_000),
        )
        .expect_err("empty session must fail"),
        STORE_BOOTSTRAP_INVALID,
    );
    assert_error(
        NewBootstrapState::new(
            vec![0xB6; MAX_BOOTSTRAP_SESSION_BYTES + 1],
            vec![0xC7],
            Vec::new(),
            timestamp(1_700_000_000_000),
        )
        .expect_err("oversized session must fail"),
        STORE_BOOTSTRAP_INVALID,
    );
    assert_error(
        NewBootstrapState::new(
            vec![0xB6],
            vec![0xC7; MAX_SYNC_TOKEN_BYTES + 1],
            Vec::new(),
            timestamp(1_700_000_000_000),
        )
        .expect_err("oversized bootstrap token must fail"),
        STORE_BOOTSTRAP_INVALID,
    );
}

#[test]
fn bootstrap_rejects_duplicate_and_over_limit_room_anchors() {
    let duplicate = vec![anchor([0x33; 32], 1), anchor([0x33; 32], 1)];
    assert_error(
        NewBootstrapState::new(
            vec![0xB6],
            vec![0xC7],
            duplicate,
            timestamp(1_700_000_000_000),
        )
        .expect_err("duplicate room lookups must fail"),
        STORE_BOOTSTRAP_INVALID,
    );

    let accepted_at_limit = NewBootstrapState::new(
        vec![0xB6],
        vec![0xC7],
        unique_anchors(MAX_BOOTSTRAP_ROOM_ANCHORS),
        timestamp(1_700_000_000_000),
    )
    .expect("exactly 100,000 unique room anchors must be accepted");
    drop(accepted_at_limit);

    assert_error(
        NewBootstrapState::new(
            vec![0xB6],
            vec![0xC7],
            unique_anchors(MAX_BOOTSTRAP_ROOM_ANCHORS + 1),
            timestamp(1_700_000_000_000),
        )
        .expect_err("too many room anchors must fail"),
        STORE_BOOTSTRAP_INVALID,
    );
}

#[test]
fn bootstrap_and_sync_reject_sub_millisecond_and_out_of_range_timestamps() {
    let sub_millisecond = Utc
        .timestamp_opt(1_700_000_000, 1)
        .single()
        .expect("construct sub-millisecond timestamp");
    assert_error(
        NewBootstrapState::new(vec![0xB6], vec![0xC7], Vec::new(), sub_millisecond)
            .expect_err("sub-millisecond bootstrap timestamp must fail"),
        STORE_BOOTSTRAP_INVALID,
    );
    assert_error(
        NewRawSyncInbox::new(vec![0xB6], vec![0xC7], vec![0xD8], sub_millisecond)
            .expect_err("sub-millisecond sync timestamp must fail"),
        STORE_SYNC_INVALID,
    );

    let out_of_range = DateTime::<Utc>::MAX_UTC - Duration::nanoseconds(999_999_999);
    assert_eq!(out_of_range.timestamp_subsec_nanos(), 0);
    assert_error(
        NewBootstrapState::new(vec![0xB6], vec![0xC7], Vec::new(), out_of_range)
            .expect_err("out-of-range bootstrap timestamp must fail"),
        STORE_BOOTSTRAP_INVALID,
    );
    assert_error(
        NewRawSyncInbox::new(vec![0xB6], vec![0xC7], vec![0xD8], out_of_range)
            .expect_err("out-of-range sync timestamp must fail"),
        STORE_SYNC_INVALID,
    );
}

#[test]
fn raw_sync_inbox_accepts_exact_token_and_response_limits() {
    let value = NewRawSyncInbox::new(
        vec![0xB6; MAX_SYNC_TOKEN_BYTES],
        vec![0xC7; MAX_SYNC_TOKEN_BYTES],
        vec![0xD8; MAX_SYNC_RESPONSE_BYTES],
        timestamp(1_700_000_000_000),
    )
    .expect("exact sync limits must be accepted");
    let _ = value;

    assert_error(
        NewRawSyncInbox::new(
            Vec::new(),
            vec![0xC7],
            vec![0xD8],
            timestamp(1_700_000_000_000),
        )
        .expect_err("empty request token must fail"),
        STORE_SYNC_INVALID,
    );
    assert_error(
        NewRawSyncInbox::new(
            vec![0xB6],
            Vec::new(),
            vec![0xD8],
            timestamp(1_700_000_000_000),
        )
        .expect_err("empty next token must fail"),
        STORE_SYNC_INVALID,
    );
    assert_error(
        NewRawSyncInbox::new(
            vec![0xB6],
            vec![0xC7],
            Vec::new(),
            timestamp(1_700_000_000_000),
        )
        .expect_err("empty response must fail"),
        STORE_SYNC_INVALID,
    );
    assert_error(
        NewRawSyncInbox::new(
            vec![0xB6; MAX_SYNC_TOKEN_BYTES + 1],
            vec![0xC7],
            vec![0xD8],
            timestamp(1_700_000_000_000),
        )
        .expect_err("oversized request token must fail"),
        STORE_SYNC_TOO_LARGE,
    );
    assert_error(
        NewRawSyncInbox::new(
            vec![0xB6],
            vec![0xC7; MAX_SYNC_TOKEN_BYTES + 1],
            vec![0xD8],
            timestamp(1_700_000_000_000),
        )
        .expect_err("oversized next token must fail"),
        STORE_SYNC_TOO_LARGE,
    );

    let oversized_response = vec![0xD8; MAX_SYNC_RESPONSE_BYTES + 1];
    assert_error(
        NewRawSyncInbox::new(
            vec![0xB6],
            vec![0xC7],
            oversized_response,
            timestamp(1_700_000_000_000),
        )
        .expect_err("64 MiB plus one response byte must fail"),
        STORE_SYNC_TOO_LARGE,
    );
}

#[test]
fn reason_codes_accept_only_bounded_lowercase_wire_codes() {
    for value in ["abc".to_owned(), "a1_b2".to_owned(), "a".repeat(64)] {
        let reason = ReasonCode::new(value.clone());
        assert_eq!(reason.expect("valid reason code").as_str(), value);
    }

    for value in [
        "".to_owned(),
        "ab".to_owned(),
        "a".repeat(65),
        "Abc".to_owned(),
        "1abc".to_owned(),
        "abc_".to_owned(),
        "_abc".to_owned(),
        "ab__cd".to_owned(),
        "ab-cd".to_owned(),
        "ab cd".to_owned(),
        "ab.cd".to_owned(),
    ] {
        assert_error(
            ReasonCode::new(value).expect_err("invalid reason code must fail"),
            STORE_SYNC_INVALID,
        );
    }
}

#[test]
fn state_and_sdk_position_mappings_are_exact() {
    let states = [
        (SyncInboxState::Fetched, "fetched"),
        (SyncInboxState::SdkProcessed, "sdk_processed"),
        (SyncInboxState::Prepared, "prepared"),
        (SyncInboxState::Committed, "committed"),
        (SyncInboxState::Quarantined, "quarantined"),
    ];
    for (state, wire) in states {
        assert_eq!(state.as_str(), wire);
    }

    assert_eq!(SdkInboxPosition::Committed.journaled_inbox_id(), None);
    let _ = SyncInboxState::Fetched;
}

#[test]
fn secret_bearing_dto_debug_and_display_are_exactly_redacted() {
    let canary_anchor = RoomAnchor::new([0x44; 32], CANARIES[0].as_bytes().to_vec())
        .expect("construct canary anchor");
    assert_redacted(&canary_anchor, "RoomAnchor([REDACTED])", CANARIES[0]);

    let bootstrap = NewBootstrapState::new(
        CANARIES[0].as_bytes().to_vec(),
        CANARIES[1].as_bytes().to_vec(),
        vec![anchor([0x45; 32], 1)],
        timestamp(1_700_000_000_000),
    )
    .expect("construct canary bootstrap");
    assert_redacted(&bootstrap, "NewBootstrapState([REDACTED])", CANARIES[0]);
    assert!(!format!("{bootstrap:?}").contains(CANARIES[1]));
    assert!(!bootstrap.to_string().contains(CANARIES[1]));

    let sync = NewRawSyncInbox::new(
        CANARIES[0].as_bytes().to_vec(),
        CANARIES[1].as_bytes().to_vec(),
        CANARIES[2].as_bytes().to_vec(),
        timestamp(1_700_000_000_000),
    )
    .expect("construct canary sync inbox");
    assert_redacted(&sync, "NewRawSyncInbox([REDACTED])", CANARIES[0]);
    for canary in CANARIES.iter().skip(1) {
        assert!(!format!("{sync:?}").contains(canary));
        assert!(!sync.to_string().contains(canary));
    }
}

fn assert_redacted<T>(value: &T, expected: &str, canary: &str)
where
    T: std::fmt::Debug + std::fmt::Display,
{
    let mut debug = String::new();
    write!(&mut debug, "{value:?}").expect("format debug value");
    assert!(debug == expected, "debug redaction mismatch");
    assert!(!debug.contains(canary));
    let display = value.to_string();
    assert!(display == expected, "display redaction mismatch");
    assert!(!display.contains(canary));
}

#[test]
fn bootstrap_initializes_exact_singleton_and_room_anchors_atomically() {
    let directory = secure_tempdir();
    let path = database_path(directory.path());
    let first_lookup = [0x51; 32];
    let second_lookup = [0x52; 32];
    let expected_timestamp = timestamp(1_700_000_000_000).to_rfc3339();
    let mut store = Store::open(&path, test_keyring()).expect("open gateway store");

    store
        .initialize_bootstrap_state(bootstrap_state(
            b"bootstrap-session",
            b"bootstrap-token",
            vec![anchor(first_lookup, 3), anchor(second_lookup, 4)],
        ))
        .expect("initialize bootstrap state");

    assert_eq!(table_count(&path, "gateway_state"), 1);
    assert_eq!(table_count(&path, "room_progress"), 2);
    let gateway = raw_gateway_state(&path).expect("singleton row");
    assert_eq!(gateway.singleton, 1);
    assert!(!gateway.session_cipher.is_empty());
    assert_eq!(gateway.session_nonce.len(), 24);
    assert_eq!(gateway.session_key_version, 1);
    assert!(!gateway.committed_token_cipher.is_empty());
    assert_eq!(gateway.committed_token_nonce.len(), 24);
    assert_eq!(gateway.committed_token_key_version, 1);
    assert!(!gateway.fetch_token_cipher.is_empty());
    assert_eq!(gateway.fetch_token_nonce.len(), 24);
    assert_eq!(gateway.fetch_token_key_version, 1);
    assert_eq!(gateway.maintenance_code, None);
    assert_eq!(gateway.maintenance_since, None);
    assert_eq!(
        gateway.bootstrapped_at.as_deref(),
        Some(expected_timestamp.as_str())
    );
    assert_eq!(gateway.updated_at, expected_timestamp);

    let anchors = raw_room_progress(&path);
    assert_eq!(anchors.len(), 2);
    assert_eq!(anchors[0].room_lookup, first_lookup);
    assert_eq!(anchors[1].room_lookup, second_lookup);
    for (lookup, expected_event) in [
        (first_lookup, vec![0xA5; 3]),
        (second_lookup, vec![0xA5; 4]),
    ] {
        let actual_event = store
            .room_anchor(&lookup)
            .expect("decrypt room anchor")
            .expect("supplied room anchor");
        assert_protected_bytes_eq(actual_event.as_bytes(), &expected_event, "room anchor");
    }
    for row in anchors {
        assert!(!row.anchor_event_cipher.is_empty());
        assert_eq!(row.anchor_event_nonce.len(), 24);
        assert_eq!(row.key_version, 1);
        assert_eq!(row.updated_at, expected_timestamp);
    }
}

#[test]
fn bootstrap_rejects_duplicate_initialization_without_rewriting_state() {
    let directory = secure_tempdir();
    let path = database_path(directory.path());
    let mut store = Store::open(&path, test_keyring()).expect("open gateway store");
    store
        .initialize_bootstrap_state(bootstrap_state(
            b"first-session",
            b"first-token",
            vec![anchor([0x61; 32], 1)],
        ))
        .expect("initialize first bootstrap state");
    let before_gateway = raw_gateway_state(&path);
    let before_anchors = raw_room_progress(&path);

    let error = store
        .initialize_bootstrap_state(bootstrap_state(
            b"second-session",
            b"second-token",
            vec![anchor([0x62; 32], 1)],
        ))
        .expect_err("duplicate bootstrap must fail");
    assert_code_only(error, STORE_ALREADY_BOOTSTRAPPED);
    assert_gateway_snapshot_eq(&raw_gateway_state(&path), &before_gateway);
    assert_room_progress_snapshot_eq(&raw_room_progress(&path), &before_anchors);
}

#[test]
fn bootstrap_rejects_duplicate_room_lookups_and_rolls_back() {
    let directory = secure_tempdir();
    let path = database_path(directory.path());
    let store = Store::open(&path, test_keyring()).expect("open gateway store");
    let duplicate = NewBootstrapState::new(
        b"session".to_vec(),
        b"token".to_vec(),
        vec![anchor([0x71; 32], 1), anchor([0x71; 32], 1)],
        timestamp(1_700_000_000_000),
    )
    .expect_err("duplicate room lookup must fail before persistence");
    assert_code_only(duplicate, STORE_BOOTSTRAP_INVALID);
    assert_eq!(table_count(&path, "gateway_state"), 0);
    assert_eq!(table_count(&path, "room_progress"), 0);
    drop(store);
}

#[test]
fn bootstrap_sql_failure_on_second_anchor_rolls_back_singleton_and_first_anchor() {
    let directory = secure_tempdir();
    let path = database_path(directory.path());
    let mut store = Store::open(&path, test_keyring()).expect("open gateway store");
    let trigger_connection =
        Connection::open(&path).expect("open separate sqlite connection for trigger fixture");
    trigger_connection
        .execute_batch(
            "CREATE TRIGGER fail_second_bootstrap_anchor
             BEFORE INSERT ON room_progress
             WHEN (SELECT COUNT(*) FROM room_progress) >= 1
             BEGIN
               SELECT RAISE(ABORT, 'anchor_abort_fixture');
             END;",
        )
        .expect("install nonsecret abort trigger fixture");
    drop(trigger_connection);

    let error = store
        .initialize_bootstrap_state(bootstrap_state(
            b"session",
            b"token",
            vec![anchor([0x81; 32], 1), anchor([0x82; 32], 1)],
        ))
        .expect_err("second anchor fixture must abort the transaction");
    assert_code_only(error, STORE_BOOTSTRAP_INVALID);
    assert_eq!(table_count(&path, "gateway_state"), 0);
    assert_eq!(table_count(&path, "room_progress"), 0);
}

#[test]
fn bootstrap_rejects_invalid_timestamp_empty_or_oversized_protected_values() {
    let directory = secure_tempdir();
    let path = database_path(directory.path());
    let store = Store::open(&path, test_keyring()).expect("open gateway store");

    assert_code_only(
        NewBootstrapState::new(
            Vec::new(),
            b"token".to_vec(),
            Vec::new(),
            timestamp(1_700_000_000_000),
        )
        .expect_err("empty session must be rejected"),
        STORE_BOOTSTRAP_INVALID,
    );
    assert_code_only(
        NewBootstrapState::new(
            b"session".to_vec(),
            Vec::new(),
            Vec::new(),
            timestamp(1_700_000_000_000),
        )
        .expect_err("empty token must be rejected"),
        STORE_BOOTSTRAP_INVALID,
    );
    assert_code_only(
        RoomAnchor::new([0x91; 32], Vec::new()).expect_err("empty room anchor must be rejected"),
        STORE_BOOTSTRAP_INVALID,
    );
    assert_code_only(
        RoomAnchor::new([0x92; 32], vec![0xA5; MAX_ROOM_ANCHOR_BYTES + 1])
            .expect_err("oversized room anchor must be rejected"),
        STORE_BOOTSTRAP_INVALID,
    );
    assert_code_only(
        NewBootstrapState::new(
            vec![0xB6; MAX_BOOTSTRAP_SESSION_BYTES + 1],
            b"token".to_vec(),
            Vec::new(),
            timestamp(1_700_000_000_000),
        )
        .expect_err("oversized session must be rejected"),
        STORE_BOOTSTRAP_INVALID,
    );
    let sub_millisecond = Utc
        .timestamp_opt(1_700_000_000, 1)
        .single()
        .expect("construct sub-millisecond timestamp");
    assert_code_only(
        NewBootstrapState::new(
            b"session".to_vec(),
            b"token".to_vec(),
            Vec::new(),
            sub_millisecond,
        )
        .expect_err("sub-millisecond timestamp must be rejected"),
        STORE_BOOTSTRAP_INVALID,
    );
    assert_eq!(table_count(&path, "gateway_state"), 0);
    assert_eq!(table_count(&path, "room_progress"), 0);
    drop(store);
}

#[test]
fn bootstrap_ciphertext_round_trips_after_reopen() {
    let directory = secure_tempdir();
    let path = database_path(directory.path());
    let lookup = [0xA1; 32];
    let session = b"session-round-trip-canary";
    let token = b"token-round-trip-canary";
    let anchor_event = b"anchor-round-trip-canary";
    let mut store = Store::open(&path, test_keyring()).expect("open gateway store");
    store
        .initialize_bootstrap_state(bootstrap_state(
            session,
            token,
            vec![RoomAnchor::new(lookup, anchor_event.to_vec()).expect("construct anchor")],
        ))
        .expect("initialize bootstrap state");
    drop(store);

    let reopened = Store::open(&path, test_keyring()).expect("reopen gateway store");
    let stored_session = reopened
        .matrix_session()
        .expect("read matrix session")
        .expect("session after bootstrap");
    assert_protected_bytes_eq(stored_session.as_bytes(), session, "matrix session");
    let stored_anchor = reopened
        .room_anchor(&lookup)
        .expect("read room anchor")
        .expect("anchor after bootstrap");
    assert_protected_bytes_eq(stored_anchor.as_bytes(), anchor_event, "room anchor");
}

#[test]
fn bootstrap_plaintext_is_absent_from_db_wal_shm_while_store_open() {
    let directory = secure_tempdir();
    let path = database_path(directory.path());
    let mut store = Store::open(&path, test_keyring()).expect("open gateway store");
    store
        .initialize_bootstrap_state(bootstrap_state(
            CANARIES[0].as_bytes(),
            CANARIES[1].as_bytes(),
            vec![
                RoomAnchor::new([0xB1; 32], CANARIES[2].as_bytes().to_vec())
                    .expect("construct canary anchor"),
            ],
        ))
        .expect("initialize bootstrap state");

    let storage = sqlite_storage_bytes(&path);
    for canary in CANARIES {
        assert_storage_excludes(&storage, canary.as_bytes());
    }
}

fn assert_session_corruption(sql: &str) {
    let directory = secure_tempdir();
    let path = database_path(directory.path());
    let mut store = Store::open(&path, test_keyring()).expect("open gateway store");
    store
        .initialize_bootstrap_state(bootstrap_state(b"session", b"token", Vec::new()))
        .expect("initialize bootstrap state");
    let connection = Connection::open(&path).expect("open sqlite corruption fixture");
    connection
        .execute(sql, [])
        .expect("apply session corruption fixture");
    drop(connection);

    assert_code_only(
        store
            .matrix_session()
            .expect_err("corrupt session state must fail closed"),
        STORE_SYNC_CORRUPT,
    );
}

fn assert_anchor_corruption(sql: &str) {
    let directory = secure_tempdir();
    let path = database_path(directory.path());
    let lookup = [0xC1; 32];
    let mut store = Store::open(&path, test_keyring()).expect("open gateway store");
    store
        .initialize_bootstrap_state(bootstrap_state(
            b"session",
            b"token",
            vec![anchor(lookup, 1)],
        ))
        .expect("initialize bootstrap state");
    let connection = Connection::open(&path).expect("open sqlite corruption fixture");
    connection
        .execute(sql, [])
        .expect("apply anchor corruption fixture");
    drop(connection);

    assert_code_only(
        store
            .room_anchor(&lookup)
            .expect_err("corrupt room anchor must fail closed"),
        STORE_SYNC_CORRUPT,
    );
}

#[test]
fn bootstrap_corruption_fails_closed_without_secret_formatting() {
    for sql in [
        "UPDATE gateway_state SET session_cipher = zeroblob(0)",
        "UPDATE gateway_state SET session_nonce = zeroblob(1)",
        "UPDATE gateway_state SET session_key_version = 0",
    ] {
        assert_session_corruption(sql);
    }
    for sql in [
        "UPDATE room_progress SET anchor_event_cipher = zeroblob(0)",
        "UPDATE room_progress SET anchor_event_nonce = zeroblob(1)",
        "UPDATE room_progress SET key_version = 0",
        "UPDATE room_progress SET updated_at = 'corrupt_timestamp_fixture'",
    ] {
        assert_anchor_corruption(sql);
    }
}

#[test]
fn room_progress_count_over_limit_fails_closed() {
    let directory = secure_tempdir();
    let path = database_path(directory.path());
    let mut store = Store::open(&path, test_keyring()).expect("open gateway store");
    store
        .initialize_bootstrap_state(bootstrap_state(b"session", b"token", Vec::new()))
        .expect("initialize bootstrap state");

    let row_limit = i64::try_from(MAX_BOOTSTRAP_ROOM_ANCHORS + 1).expect("row limit");
    let connection = Connection::open(&path).expect("open sqlite row-count fixture");
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
                    1, ?2
             FROM numbers",
            params![row_limit, timestamp(1_700_000_000_000).to_rfc3339()],
        )
        .expect("insert practical over-limit fixture");
    drop(connection);

    assert_code_only(
        store
            .matrix_session()
            .expect_err("over-limit room-progress state must fail closed"),
        STORE_SYNC_CORRUPT,
    );
}

#[test]
fn oversized_session_token_and_anchor_ciphertext_fail_closed() {
    let directory = secure_tempdir();
    let path = database_path(directory.path());
    let mut store = Store::open(&path, test_keyring()).expect("open gateway store");
    store
        .initialize_bootstrap_state(bootstrap_state(b"session", b"token", Vec::new()))
        .expect("initialize bootstrap state");
    let connection = Connection::open(&path).expect("open session ciphertext fixture");
    connection
        .execute(
            &format!(
                "UPDATE gateway_state SET session_cipher = zeroblob({})",
                MAX_BOOTSTRAP_SESSION_BYTES + AEAD_TAG_BYTES + 1
            ),
            [],
        )
        .expect("oversize session ciphertext");
    drop(connection);
    assert_code_only(
        store
            .matrix_session()
            .expect_err("oversized session ciphertext must fail closed"),
        STORE_SYNC_CORRUPT,
    );

    let directory = secure_tempdir();
    let path = database_path(directory.path());
    let mut store = Store::open(&path, test_keyring()).expect("open gateway store");
    store
        .initialize_bootstrap_state(bootstrap_state(b"session", b"token", Vec::new()))
        .expect("initialize bootstrap state");
    let connection = Connection::open(&path).expect("open token ciphertext fixture");
    connection
        .execute(
            &format!(
                "UPDATE gateway_state SET committed_token_cipher = zeroblob({})",
                MAX_SYNC_TOKEN_BYTES + AEAD_TAG_BYTES + 1
            ),
            [],
        )
        .expect("oversize token ciphertext");
    drop(connection);
    assert_code_only(
        store
            .matrix_session()
            .expect_err("oversized token ciphertext must fail closed"),
        STORE_SYNC_CORRUPT,
    );

    let directory = secure_tempdir();
    let path = database_path(directory.path());
    let lookup = [0xC8; 32];
    let mut store = Store::open(&path, test_keyring()).expect("open gateway store");
    store
        .initialize_bootstrap_state(bootstrap_state(
            b"session",
            b"token",
            vec![anchor(lookup, 1)],
        ))
        .expect("initialize bootstrap state");
    let connection = Connection::open(&path).expect("open anchor ciphertext fixture");
    connection
        .execute(
            &format!(
                "UPDATE room_progress SET anchor_event_cipher = zeroblob({})",
                MAX_ROOM_ANCHOR_BYTES + AEAD_TAG_BYTES + 1
            ),
            [],
        )
        .expect("oversize anchor ciphertext");
    drop(connection);
    assert_code_only(
        store
            .room_anchor(&lookup)
            .expect_err("oversized anchor ciphertext must fail closed"),
        STORE_SYNC_CORRUPT,
    );
}

#[test]
fn getters_return_none_only_for_wholly_unbootstrapped_store_and_fail_on_orphans() {
    let directory = secure_tempdir();
    let path = database_path(directory.path());
    let mut store = Store::open(&path, test_keyring()).expect("open gateway store");
    assert!(
        store
            .matrix_session()
            .expect("read unbootstrapped session")
            .is_none()
    );
    assert!(
        store
            .room_anchor(&[0xD1; 32])
            .expect("read unbootstrapped anchor")
            .is_none()
    );
    assert_code_only(
        store
            .oldest_uncommitted_inbox()
            .expect_err("fresh oldest-inbox read must report missing bootstrap"),
        communicator_matrix_gateway::store::STORE_NOT_BOOTSTRAPPED,
    );
    assert_code_only(
        store
            .room_anchor(&[])
            .expect_err("invalid room lookup must fail"),
        STORE_BOOTSTRAP_INVALID,
    );

    let connection = Connection::open(&path).expect("open sqlite orphan fixture");
    connection
        .execute(
            "INSERT INTO room_progress
             (room_lookup, anchor_event_cipher, anchor_event_nonce, key_version, updated_at)
             VALUES (?1, ?2, ?3, 1, ?4)",
            params![
                vec![0xD2_u8; 32],
                vec![0xD3_u8],
                vec![0xD4_u8; 24],
                timestamp(1_700_000_000_000).to_rfc3339(),
            ],
        )
        .expect("insert orphan room anchor fixture");
    drop(connection);
    assert_code_only(
        store
            .matrix_session()
            .expect_err("orphan anchor must fail session getter closed"),
        STORE_SYNC_CORRUPT,
    );
    assert_code_only(
        store
            .room_anchor(&[0xD2; 32])
            .expect_err("orphan anchor must fail anchor getter closed"),
        STORE_SYNC_CORRUPT,
    );
    assert_code_only(
        store
            .committed_sync_token()
            .expect_err("orphan anchor must fail committed-token getter closed"),
        STORE_SYNC_CORRUPT,
    );
    assert_code_only(
        store
            .fetch_sync_token()
            .expect_err("orphan anchor must fail fetch-token getter closed"),
        STORE_SYNC_CORRUPT,
    );
    assert_code_only(
        store
            .reconcile_sdk_position(&digest(b"orphan"))
            .expect_err("orphan anchor must fail reconcile closed"),
        STORE_SYNC_CORRUPT,
    );
    assert_code_only(
        store
            .oldest_uncommitted_inbox()
            .expect_err("orphan anchor must fail oldest-inbox read closed"),
        STORE_SYNC_CORRUPT,
    );
    let before_orphan_sync = raw_sync_inbox_values(&path);
    let before_orphan_gateway = raw_gateway_values(&path);
    let before_orphan_rooms = raw_room_progress(&path);
    assert_code_only(
        store
            .append_fetched_sync(raw_sync_input(
                b"orphan-request",
                b"orphan-next",
                b"candidate",
                1_700_000_001_000,
            ))
            .expect_err("orphan anchor must fail append closed"),
        STORE_SYNC_CORRUPT,
    );
    assert_eq!(raw_sync_inbox_values(&path), before_orphan_sync);
    assert_eq!(raw_gateway_values(&path), before_orphan_gateway);
    assert_room_progress_snapshot_eq(&raw_room_progress(&path), &before_orphan_rooms);
    drop(store);

    let directory = secure_tempdir();
    let path = database_path(directory.path());
    let store = Store::open(&path, test_keyring()).expect("open gateway store");
    let connection = Connection::open(&path).expect("open sqlite partial singleton fixture");
    connection
        .execute(
            "INSERT INTO gateway_state(singleton, updated_at) VALUES (1, ?1)",
            [timestamp(1_700_000_000_000).to_rfc3339()],
        )
        .expect("insert partial singleton fixture");
    drop(connection);
    assert_code_only(
        store
            .matrix_session()
            .expect_err("partial singleton must fail closed"),
        STORE_SYNC_CORRUPT,
    );
    assert_code_only(
        store
            .room_anchor(&[0xD5; 32])
            .expect_err("partial singleton must fail anchor getter closed"),
        STORE_SYNC_CORRUPT,
    );
    drop(store);

    let directory = secure_tempdir();
    let path = database_path(directory.path());
    let missing_lookup = [0xD6; 32];
    let mut store = Store::open(&path, test_keyring()).expect("open gateway store");
    store
        .initialize_bootstrap_state(bootstrap_state(
            b"session",
            b"token",
            vec![anchor([0xD7; 32], 1)],
        ))
        .expect("initialize bootstrap state");
    assert!(
        store
            .room_anchor(&missing_lookup)
            .expect("read absent valid anchor")
            .is_none()
    );
}

#[test]
fn orphan_sync_inbox_rows_fail_closed_through_every_sync_entry_point() {
    let directory = secure_tempdir();
    let path = database_path(directory.path());
    let mut store = Store::open(&path, test_keyring()).expect("open fresh gateway store");
    let connection = Connection::open(&path).expect("open sqlite orphan sync fixture");
    let transaction = connection
        .unchecked_transaction()
        .expect("begin orphan sync fixture transaction");
    insert_valid_fetched_row(
        &transaction,
        None,
        b"initial",
        b"next-1",
        b"orphan response",
        1_700_000_001_000,
    );
    transaction.commit().expect("commit orphan sync fixture");
    let before_rows = raw_sync_inbox_values(&path);
    let before_gateway = raw_gateway_values(&path);

    assert_code_only(
        store
            .matrix_session()
            .expect_err("orphan sync row must fail session getter closed"),
        STORE_SYNC_CORRUPT,
    );
    assert_code_only(
        store
            .room_anchor(&[0xD8; 32])
            .expect_err("orphan sync row must fail anchor getter closed"),
        STORE_SYNC_CORRUPT,
    );
    assert_code_only(
        store
            .committed_sync_token()
            .expect_err("orphan sync row must fail committed-token getter closed"),
        STORE_SYNC_CORRUPT,
    );
    assert_code_only(
        store
            .fetch_sync_token()
            .expect_err("orphan sync row must fail fetch-token getter closed"),
        STORE_SYNC_CORRUPT,
    );
    assert_code_only(
        store
            .reconcile_sdk_position(&digest(b"next-1"))
            .expect_err("orphan sync row must fail reconcile closed"),
        STORE_SYNC_CORRUPT,
    );
    assert_code_only(
        store
            .oldest_uncommitted_inbox()
            .expect_err("orphan sync row must fail oldest-inbox read closed"),
        STORE_SYNC_CORRUPT,
    );
    assert_code_only(
        store
            .append_fetched_sync(raw_sync_input(
                b"initial",
                b"next-2",
                b"candidate",
                1_700_000_002_000,
            ))
            .expect_err("orphan sync row must fail append closed"),
        STORE_SYNC_CORRUPT,
    );
    assert_eq!(raw_sync_inbox_values(&path), before_rows);
    assert_eq!(raw_gateway_values(&path), before_gateway);
}

#[test]
fn committed_and_fetch_encrypted_columns_decrypt_to_exact_same_token_but_their_stored_nonces_differ()
 {
    let directory = secure_tempdir();
    let path = database_path(directory.path());
    let mut store = Store::open(&path, test_keyring()).expect("open gateway store");
    let token = b"same-token-plaintext";
    store
        .initialize_bootstrap_state(bootstrap_state(b"session", token, Vec::new()))
        .expect("initialize bootstrap state");
    let row = raw_gateway_state(&path).expect("singleton row");
    assert!(
        row.committed_token_nonce != row.fetch_token_nonce,
        "committed and fetch token nonces must differ"
    );

    let committed_nonce: [u8; 24] = row
        .committed_token_nonce
        .clone()
        .try_into()
        .expect("committed nonce length");
    let fetch_nonce: [u8; 24] = row
        .fetch_token_nonce
        .clone()
        .try_into()
        .expect("fetch nonce length");
    let keyring = test_keyring();
    let committed = keyring
        .open(
            "gateway_state",
            "1",
            "committed_token",
            &Sealed {
                nonce: committed_nonce,
                ciphertext: row.committed_token_cipher.clone(),
                key_version: row
                    .committed_token_key_version
                    .try_into()
                    .expect("committed key version"),
            },
        )
        .expect("open committed token");
    let fetched = keyring
        .open(
            "gateway_state",
            "1",
            "fetch_token",
            &Sealed {
                nonce: fetch_nonce,
                ciphertext: row.fetch_token_cipher.clone(),
                key_version: row
                    .fetch_token_key_version
                    .try_into()
                    .expect("fetch key version"),
            },
        )
        .expect("open fetch token");
    assert_protected_bytes_eq(committed.as_bytes(), token, "committed token");
    assert_protected_bytes_eq(fetched.as_bytes(), token, "fetch token");
}

#[test]
fn source_contract_keeps_protected_dto_fields_private_and_non_derived() {
    let source = include_str!("../src/store_types.rs");
    for type_name in [
        "RoomAnchor",
        "NewBootstrapState",
        "NewRawSyncInbox",
        "RawSyncInbox",
    ] {
        let marker = format!("pub struct {type_name} {{");
        let start = source
            .find(&marker)
            .unwrap_or_else(|| panic!("missing {marker}"));
        let end = source[start..]
            .find("}\n")
            .map(|offset| start + offset)
            .expect("struct declaration terminator");
        let declaration = &source[start..=end];
        assert!(
            !declaration.lines().skip(1).any(|line| {
                line.trim_start().starts_with("pub ") || line.trim_start().starts_with("pub(")
            }),
            "{type_name} fields must remain private"
        );

        let attribute_start = source[..start].rfind("\n\n").map_or(0, |offset| offset + 2);
        let attributes = &source[attribute_start..start];
        for prohibited in ["Clone", "Serialize", "Deref", "AsRef"] {
            assert!(
                !attributes.contains(prohibited),
                "{type_name} must not derive or expose {prohibited}"
            );
        }
    }

    for prohibited in [
        "pub request_token:",
        "pub next_token:",
        "pub response:",
        "pub session:",
        "pub initial_token:",
        "pub anchor_event:",
    ] {
        assert!(
            !source.contains(prohibited),
            "protected field became public"
        );
    }
}

#[test]
fn inbox_position_debug_does_not_expose_protected_id_text() {
    let position = SdkInboxPosition::Committed;
    assert_eq!(format!("{position:?}"), "Committed");
}

// Keep the imported private-constructor types in this integration contract
// test: their crate-private construction and getters are exercised by the
// unit tests next to store_types.rs.
#[allow(dead_code)]
fn _crate_private_types_are_part_of_the_public_contract() {
    let _ = std::any::TypeId::of::<InboxId>();
}

#[test]
fn append_journals_exact_raw_response_before_any_later_state() {
    let directory = secure_tempdir();
    let path = database_path(directory.path());
    let mut store = Store::open(&path, test_keyring()).expect("open gateway store");
    store
        .initialize_bootstrap_state(bootstrap_state(b"session", b"initial", Vec::new()))
        .expect("initialize bootstrap state");

    let response = b"{ \n  \"message\": \"caf\xC3\xA9\" \n}\n";
    let id = store
        .append_fetched_sync(raw_sync_input(
            b"initial",
            b"next-1",
            response,
            1_700_000_001_000,
        ))
        .expect("append fetched sync response");

    assert_eq!(raw_sync_inbox_rows(&path).len(), 1);
    let committed = store
        .committed_sync_token()
        .expect("read committed token")
        .expect("committed token after bootstrap");
    assert_protected_bytes_eq(committed.as_bytes(), b"initial", "committed token");
    let fetched = store
        .fetch_sync_token()
        .expect("read fetch token")
        .expect("fetch token after append");
    assert_protected_bytes_eq(fetched.as_bytes(), b"next-1", "fetch token");
    let inbox = store
        .oldest_uncommitted_inbox()
        .expect("read oldest inbox")
        .expect("fetched inbox row");
    assert_eq!(inbox.inbox_id().as_str(), id.as_str());
    assert_protected_bytes_eq(inbox.response().as_bytes(), response, "raw sync response");
    assert_eq!(inbox.state(), SyncInboxState::Fetched);
    assert_eq!(inbox.observed_at(), &timestamp(1_700_000_001_000));
    assert_eq!(inbox.created_at(), &timestamp(1_700_000_001_000));
}

#[test]
fn append_advances_only_fetch_token_and_links_verified_predecessor() {
    let directory = secure_tempdir();
    let path = database_path(directory.path());
    let mut store = Store::open(&path, test_keyring()).expect("open gateway store");
    store
        .initialize_bootstrap_state(bootstrap_state(b"session", b"initial", Vec::new()))
        .expect("initialize bootstrap state");

    let first = store
        .append_fetched_sync(raw_sync_input(
            b"initial",
            b"next-1",
            b"first response",
            1_700_000_001_000,
        ))
        .expect("append first response");
    let second = store
        .append_fetched_sync(raw_sync_input(
            b"next-1",
            b"next-2",
            b"second response",
            1_700_000_002_000,
        ))
        .expect("append second response");

    let rows = raw_sync_inbox_rows(&path);
    assert_eq!(rows.len(), 2);
    assert_eq!(rows[0].inbox_id, first.as_str());
    assert_eq!(rows[1].inbox_id, second.as_str());
    assert_eq!(rows[0].predecessor_id, None);
    assert_eq!(rows[1].predecessor_id.as_deref(), Some(first.as_str()));

    let committed = store
        .committed_sync_token()
        .expect("read committed token")
        .expect("committed token after bootstrap");
    assert_protected_bytes_eq(committed.as_bytes(), b"initial", "committed token");
    let fetched = store
        .fetch_sync_token()
        .expect("read fetch token")
        .expect("fetch token after append");
    assert_protected_bytes_eq(fetched.as_bytes(), b"next-2", "fetch token");
}

#[test]
fn append_rejects_empty_and_over_64_mib_response_without_mutation() {
    let directory = secure_tempdir();
    let path = database_path(directory.path());
    let mut store = Store::open(&path, test_keyring()).expect("open gateway store");
    store
        .initialize_bootstrap_state(bootstrap_state(b"session", b"initial", Vec::new()))
        .expect("initialize bootstrap state");
    store
        .append_fetched_sync(raw_sync_input(
            b"initial",
            b"boundary-next",
            &vec![0xD9; MAX_SYNC_RESPONSE_BYTES],
            1_700_000_001_000,
        ))
        .expect("exactly 64 MiB response must be accepted");
    store
        .append_fetched_sync(raw_sync_input(
            b"boundary-next",
            b"next-1",
            b"accepted response",
            1_700_000_002_000,
        ))
        .expect("append baseline response");
    let before_rows = raw_sync_inbox_rows(&path);
    let before_gateway = raw_gateway_state(&path);

    assert_code_only(
        NewRawSyncInbox::new(
            b"next-1".to_vec(),
            b"next-2".to_vec(),
            Vec::new(),
            timestamp(1_700_000_003_000),
        )
        .expect_err("empty response must fail before mutation"),
        STORE_SYNC_INVALID,
    );
    assert_sync_inbox_snapshot_eq(&raw_sync_inbox_rows(&path), &before_rows);
    assert_gateway_snapshot_eq(&raw_gateway_state(&path), &before_gateway);

    assert_code_only(
        NewRawSyncInbox::new(
            b"next-1".to_vec(),
            b"next-2".to_vec(),
            vec![0xE1; MAX_SYNC_RESPONSE_BYTES + 1],
            timestamp(1_700_000_003_000),
        )
        .expect_err("one byte over the response bound must fail before mutation"),
        STORE_SYNC_TOO_LARGE,
    );
    assert_sync_inbox_snapshot_eq(&raw_sync_inbox_rows(&path), &before_rows);
    assert_gateway_snapshot_eq(&raw_gateway_state(&path), &before_gateway);
}

#[test]
fn append_rejects_oversized_or_empty_tokens_without_mutation() {
    let directory = secure_tempdir();
    let path = database_path(directory.path());
    let mut store = Store::open(&path, test_keyring()).expect("open gateway store");
    store
        .initialize_bootstrap_state(bootstrap_state(b"session", b"initial", Vec::new()))
        .expect("initialize bootstrap state");
    let before_rows = raw_sync_inbox_rows(&path);
    let before_gateway = raw_gateway_state(&path);

    assert_code_only(
        NewRawSyncInbox::new(
            Vec::new(),
            b"next-1".to_vec(),
            b"response".to_vec(),
            timestamp(1_700_000_001_000),
        )
        .expect_err("empty request token must fail before mutation"),
        STORE_SYNC_INVALID,
    );
    assert_code_only(
        NewRawSyncInbox::new(
            b"initial".to_vec(),
            Vec::new(),
            b"response".to_vec(),
            timestamp(1_700_000_001_000),
        )
        .expect_err("empty next token must fail before mutation"),
        STORE_SYNC_INVALID,
    );
    assert_code_only(
        NewRawSyncInbox::new(
            vec![0xE2; MAX_SYNC_TOKEN_BYTES + 1],
            b"next-1".to_vec(),
            b"response".to_vec(),
            timestamp(1_700_000_001_000),
        )
        .expect_err("oversized request token must fail before mutation"),
        STORE_SYNC_TOO_LARGE,
    );
    assert_code_only(
        NewRawSyncInbox::new(
            b"initial".to_vec(),
            vec![0xE3; MAX_SYNC_TOKEN_BYTES + 1],
            b"response".to_vec(),
            timestamp(1_700_000_001_000),
        )
        .expect_err("oversized next token must fail before mutation"),
        STORE_SYNC_TOO_LARGE,
    );

    assert_sync_inbox_snapshot_eq(&raw_sync_inbox_rows(&path), &before_rows);
    assert_gateway_snapshot_eq(&raw_gateway_state(&path), &before_gateway);
}

#[test]
fn oversized_corrupt_sync_blob_fails_closed() {
    let directory = secure_tempdir();
    let path = database_path(directory.path());
    let mut store = Store::open(&path, test_keyring()).expect("open gateway store");
    store
        .initialize_bootstrap_state(bootstrap_state(b"session", b"initial", Vec::new()))
        .expect("initialize bootstrap state");
    store
        .append_fetched_sync(raw_sync_input(
            b"initial",
            b"next-1",
            b"response",
            1_700_000_001_000,
        ))
        .expect("append response for corruption fixture");

    let connection = Connection::open(&path).expect("open sqlite blob corruption fixture");
    connection
        .execute(
            "UPDATE sync_inbox
             SET response_cipher = zeroblob(?1)",
            [i64::try_from(MAX_SYNC_RESPONSE_BYTES + AEAD_TAG_BYTES + 1).expect("blob length")],
        )
        .expect("write oversized response ciphertext fixture");
    drop(connection);

    assert_code_only(
        store
            .oldest_uncommitted_inbox()
            .expect_err("oversized response ciphertext must fail closed"),
        STORE_SYNC_CORRUPT,
    );
}

#[test]
fn oversized_corrupt_sync_text_fails_closed() {
    let directory = secure_tempdir();
    let path = database_path(directory.path());
    let mut store = Store::open(&path, test_keyring()).expect("open gateway store");
    store
        .initialize_bootstrap_state(bootstrap_state(b"session", b"initial", Vec::new()))
        .expect("initialize bootstrap state");
    store
        .append_fetched_sync(raw_sync_input(
            b"initial",
            b"next-1",
            b"response",
            1_700_000_001_000,
        ))
        .expect("append response for corruption fixture");

    let oversized_id = format!("inbox_{}", "a".repeat(1_000_000));
    let connection = Connection::open(&path).expect("open sqlite text corruption fixture");
    connection
        .execute("UPDATE sync_inbox SET inbox_id = ?1", [oversized_id])
        .expect("write oversized inbox ID fixture");
    drop(connection);

    assert_code_only(
        store
            .oldest_uncommitted_inbox()
            .expect_err("oversized inbox ID must fail closed"),
        STORE_SYNC_CORRUPT,
    );
}

#[test]
fn byte_identical_retry_returns_existing_id_and_retains_first_timestamp() {
    let directory = secure_tempdir();
    let path = database_path(directory.path());
    let mut store = Store::open(&path, test_keyring()).expect("open gateway store");
    store
        .initialize_bootstrap_state(bootstrap_state(b"session", b"initial", Vec::new()))
        .expect("initialize bootstrap state");
    let first = store
        .append_fetched_sync(raw_sync_input(
            b"initial",
            b"next-1",
            b"same exact body",
            1_700_000_001_000,
        ))
        .expect("append first response");
    let before_rows = raw_sync_inbox_rows(&path);
    let before_gateway = raw_gateway_state(&path);
    let retry = store
        .append_fetched_sync(raw_sync_input(
            b"initial",
            b"next-1",
            b"same exact body",
            1_700_000_009_000,
        ))
        .expect("identical retry should be idempotent");

    assert_eq!(retry.as_str(), first.as_str());
    assert_sync_inbox_snapshot_eq(&raw_sync_inbox_rows(&path), &before_rows);
    assert_gateway_snapshot_eq(&raw_gateway_state(&path), &before_gateway);
    let inbox = store
        .oldest_uncommitted_inbox()
        .expect("read inbox after retry")
        .expect("inbox after retry");
    assert_eq!(inbox.observed_at(), &timestamp(1_700_000_001_000));
    assert_eq!(inbox.created_at(), &timestamp(1_700_000_001_000));
}

#[test]
fn exact_retry_revalidates_the_entire_retained_chain_before_returning() {
    let (_directory, path, mut store, _first, _second) = setup_two_row_chain();
    update_sync_inbox_sql(
        &path,
        "UPDATE sync_inbox SET response_cipher = zeroblob(1)
         WHERE predecessor_id IS NOT NULL",
    );
    let before_rows = raw_sync_inbox_metadata(&path);
    let before_gateway = raw_gateway_state(&path);

    assert_code_only(
        store
            .append_fetched_sync(raw_sync_input(
                b"initial",
                b"next-1",
                b"first",
                1_700_000_009_000,
            ))
            .expect_err("exact retry must verify a corrupt retained successor"),
        STORE_SYNC_CORRUPT,
    );
    assert_sync_inbox_metadata_eq(&raw_sync_inbox_metadata(&path), &before_rows);
    assert_gateway_snapshot_eq(&raw_gateway_state(&path), &before_gateway);
}

#[test]
fn duplicate_request_token_digest_in_chain_fails_closed() {
    let directory = secure_tempdir();
    let path = database_path(directory.path());
    let mut store = Store::open(&path, test_keyring()).expect("open gateway store");
    store
        .initialize_bootstrap_state(bootstrap_state(b"session", b"initial", Vec::new()))
        .expect("initialize bootstrap state");
    store
        .append_fetched_sync(raw_sync_input(
            b"initial",
            b"next-1",
            b"first",
            1_700_000_001_000,
        ))
        .expect("append first response");
    store
        .append_fetched_sync(raw_sync_input(
            b"next-1",
            b"initial",
            b"second",
            1_700_000_002_000,
        ))
        .expect("append token loop response");

    let request_token = b"initial";
    let next_token = b"next-3";
    let response = b"third";
    let request_token_digest = digest(request_token);
    let next_token_digest = digest(next_token);
    let response_sha256 = digest(response);
    let inbox_id = derived_inbox_id(&request_token_digest, &next_token_digest, &response_sha256);
    let predecessor_id = raw_sync_inbox_rows(&path)
        .last()
        .expect("second inbox row")
        .inbox_id
        .clone();
    let keyring = test_keyring();
    let request_sealed = keyring
        .seal("sync_inbox", &inbox_id, "request_token", request_token)
        .expect("seal repeated request token");
    let next_sealed = keyring
        .seal("sync_inbox", &inbox_id, "next_token", next_token)
        .expect("seal third next token");
    let response_sealed = keyring
        .seal("sync_inbox", &inbox_id, "response", response)
        .expect("seal third response");
    let fetch_sealed = keyring
        .seal("gateway_state", "1", "fetch_token", next_token)
        .expect("seal updated fetch token");
    let observed_at = timestamp(1_700_000_003_000).to_rfc3339();
    let connection = Connection::open(&path).expect("open duplicate-digest fixture");
    connection
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
                inbox_id,
                predecessor_id,
                request_sealed.ciphertext,
                request_sealed.nonce.as_slice(),
                i64::from(request_sealed.key_version),
                request_token_digest.as_slice(),
                next_sealed.ciphertext,
                next_sealed.nonce.as_slice(),
                i64::from(next_sealed.key_version),
                next_token_digest.as_slice(),
                response_sealed.ciphertext,
                response_sealed.nonce.as_slice(),
                i64::from(response_sealed.key_version),
                response_sha256.as_slice(),
                i64::try_from(response.len()).expect("response length"),
                observed_at,
            ],
        )
        .expect("insert repeated request-token row");
    connection
        .execute(
            "UPDATE gateway_state
             SET fetch_token_cipher = ?1, fetch_token_nonce = ?2,
                 fetch_token_key_version = ?3",
            params![
                fetch_sealed.ciphertext,
                fetch_sealed.nonce.as_slice(),
                i64::from(fetch_sealed.key_version),
            ],
        )
        .expect("update duplicate-digest fixture fetch token");
    drop(connection);

    assert_code_only(
        store
            .oldest_uncommitted_inbox()
            .expect_err("duplicate request-token digest must fail closed"),
        STORE_SYNC_CORRUPT,
    );
}

#[test]
fn same_request_token_with_different_successor_or_body_fails_closed() {
    let directory = secure_tempdir();
    let path = database_path(directory.path());
    let mut store = Store::open(&path, test_keyring()).expect("open gateway store");
    store
        .initialize_bootstrap_state(bootstrap_state(b"session", b"initial", Vec::new()))
        .expect("initialize bootstrap state");
    store
        .append_fetched_sync(raw_sync_input(
            b"initial",
            b"next-1",
            b"body-1",
            1_700_000_001_000,
        ))
        .expect("append baseline response");
    let before_rows = raw_sync_inbox_rows(&path);
    let before_gateway = raw_gateway_state(&path);

    assert_code_only(
        store
            .append_fetched_sync(raw_sync_input(
                b"initial",
                b"next-different",
                b"body-1",
                1_700_000_002_000,
            ))
            .expect_err("same request with a different successor must conflict"),
        STORE_SYNC_CONFLICT,
    );
    assert_sync_inbox_snapshot_eq(&raw_sync_inbox_rows(&path), &before_rows);
    assert_gateway_snapshot_eq(&raw_gateway_state(&path), &before_gateway);

    assert_code_only(
        store
            .append_fetched_sync(raw_sync_input(
                b"initial",
                b"next-1",
                b"body-different",
                1_700_000_003_000,
            ))
            .expect_err("same request with a different body must conflict"),
        STORE_SYNC_CONFLICT,
    );
    assert_sync_inbox_snapshot_eq(&raw_sync_inbox_rows(&path), &before_rows);
    assert_gateway_snapshot_eq(&raw_gateway_state(&path), &before_gateway);
}

#[test]
fn wrong_request_token_fails_without_extending_chain() {
    let directory = secure_tempdir();
    let path = database_path(directory.path());
    let mut store = Store::open(&path, test_keyring()).expect("open gateway store");
    store
        .initialize_bootstrap_state(bootstrap_state(b"session", b"initial", Vec::new()))
        .expect("initialize bootstrap state");
    let before_rows = raw_sync_inbox_rows(&path);
    let before_gateway = raw_gateway_state(&path);

    assert_code_only(
        store
            .append_fetched_sync(raw_sync_input(
                b"wrong-request",
                b"next-1",
                b"body",
                1_700_000_001_000,
            ))
            .expect_err("wrong request token must fail closed"),
        STORE_SYNC_TOKEN_MISMATCH,
    );
    assert_sync_inbox_snapshot_eq(&raw_sync_inbox_rows(&path), &before_rows);
    assert_gateway_snapshot_eq(&raw_gateway_state(&path), &before_gateway);
}

#[test]
fn oldest_uncommitted_follows_chain_not_lexical_id_or_timestamp_order() {
    let directory = secure_tempdir();
    let path = database_path(directory.path());
    let mut store = Store::open(&path, test_keyring()).expect("open gateway store");
    store
        .initialize_bootstrap_state(bootstrap_state(b"session", b"initial", Vec::new()))
        .expect("initialize bootstrap state");
    let first = store
        .append_fetched_sync(raw_sync_input(
            b"initial",
            b"next-1",
            b"first",
            1_700_000_001_000,
        ))
        .expect("append first response");
    let second = store
        .append_fetched_sync(raw_sync_input(
            b"next-1",
            b"next-2",
            b"second",
            1_700_000_002_000,
        ))
        .expect("append second response");
    mark_inbox_committed(&path, first.as_str(), 1_700_000_003_000);
    set_committed_token(&path, b"next-1");

    let oldest = store
        .oldest_uncommitted_inbox()
        .expect("read oldest uncommitted inbox")
        .expect("uncommitted successor");
    assert_eq!(oldest.inbox_id().as_str(), second.as_str());
    assert_protected_bytes_eq(oldest.response().as_bytes(), b"second", "oldest response");
}

#[test]
fn sdk_position_accepts_committed_and_each_contiguous_journaled_token() {
    let directory = secure_tempdir();
    let path = database_path(directory.path());
    let mut store = Store::open(&path, test_keyring()).expect("open gateway store");
    store
        .initialize_bootstrap_state(bootstrap_state(b"session", b"initial", Vec::new()))
        .expect("initialize bootstrap state");

    assert_eq!(
        store
            .reconcile_sdk_position(&digest(b"initial"))
            .expect("reconcile committed token"),
        SdkInboxPosition::Committed
    );
    let first = store
        .append_fetched_sync(raw_sync_input(
            b"initial",
            b"next-1",
            b"first",
            1_700_000_001_000,
        ))
        .expect("append first response");
    assert_eq!(
        store
            .reconcile_sdk_position(&digest(b"next-1"))
            .expect("reconcile first journaled token")
            .journaled_inbox_id()
            .expect("first journaled row")
            .as_str(),
        first.as_str()
    );
    let second = store
        .append_fetched_sync(raw_sync_input(
            b"next-1",
            b"next-2",
            b"second",
            1_700_000_002_000,
        ))
        .expect("append second response");
    assert_eq!(
        store
            .reconcile_sdk_position(&digest(b"next-2"))
            .expect("reconcile second journaled token")
            .journaled_inbox_id()
            .expect("second journaled row")
            .as_str(),
        second.as_str()
    );
}

#[test]
fn sdk_position_rejects_committed_digest_when_retained_chain_is_missing() {
    let (_directory, path, store, _first, second) = setup_two_row_chain();
    let connection = Connection::open(&path).expect("open missing-chain fixture");
    connection
        .execute("DELETE FROM sync_inbox WHERE inbox_id = ?1", [&second])
        .expect("remove retained successor fixture row");
    drop(connection);

    let before_rows = raw_sync_inbox_values(&path);
    let before_gateway = raw_gateway_values(&path);
    assert_code_only(
        store
            .reconcile_sdk_position(&digest(b"initial"))
            .expect_err("committed digest must still verify the retained chain"),
        STORE_SYNC_CORRUPT,
    );
    assert_eq!(raw_sync_inbox_values(&path), before_rows);
    assert_eq!(raw_gateway_values(&path), before_gateway);
}

#[test]
fn sdk_position_rejects_unknown_digest_or_broken_chain() {
    let directory = secure_tempdir();
    let path = database_path(directory.path());
    let mut store = Store::open(&path, test_keyring()).expect("open gateway store");
    store
        .initialize_bootstrap_state(bootstrap_state(b"session", b"initial", Vec::new()))
        .expect("initialize bootstrap state");
    assert_code_only(
        store
            .reconcile_sdk_position(&[0xA1; 31])
            .expect_err("digest with wrong length must fail"),
        STORE_SYNC_INVALID,
    );
    assert_code_only(
        store
            .reconcile_sdk_position(&[0xA1; 32])
            .expect_err("unknown digest must fail"),
        STORE_SDK_POSITION_UNJOURNALED,
    );
    store
        .append_fetched_sync(raw_sync_input(
            b"initial",
            b"next-1",
            b"body",
            1_700_000_001_000,
        ))
        .expect("append response for corruption fixture");
    let connection = Connection::open(&path).expect("open sqlite chain corruption fixture");
    connection
        .execute("UPDATE sync_inbox SET next_token_digest = zeroblob(32)", [])
        .expect("corrupt next token digest");
    drop(connection);
    assert_code_only(
        store
            .reconcile_sdk_position(&digest(b"next-1"))
            .expect_err("broken chain must fail closed"),
        STORE_SYNC_CORRUPT,
    );
}

#[test]
fn token_reads_and_raw_inbox_survive_reopen_with_exact_bytes() {
    let directory = secure_tempdir();
    let path = database_path(directory.path());
    let response = b"{\n  \"accent\": \"caf\xC3\xA9\",\n  \"space\":  \"kept\"\n}";
    let mut store = Store::open(&path, test_keyring()).expect("open gateway store");
    store
        .initialize_bootstrap_state(bootstrap_state(b"session", b"initial", Vec::new()))
        .expect("initialize bootstrap state");
    store
        .append_fetched_sync(raw_sync_input(
            b"initial",
            b"next-1",
            response,
            1_700_000_001_000,
        ))
        .expect("append response");
    drop(store);

    let reopened = Store::open(&path, test_keyring()).expect("reopen gateway store");
    let committed = reopened
        .committed_sync_token()
        .expect("read committed token after reopen")
        .expect("committed token after reopen");
    assert_protected_bytes_eq(committed.as_bytes(), b"initial", "committed token");
    let fetched = reopened
        .fetch_sync_token()
        .expect("read fetch token after reopen")
        .expect("fetch token after reopen");
    assert_protected_bytes_eq(fetched.as_bytes(), b"next-1", "fetch token");
    let inbox = reopened
        .oldest_uncommitted_inbox()
        .expect("read inbox after reopen")
        .expect("inbox after reopen");
    assert_protected_bytes_eq(inbox.response().as_bytes(), response, "raw sync response");
}

#[test]
fn corrupt_token_response_hash_nonce_key_version_state_or_lifecycle_fails_closed() {
    for sql in [
        "UPDATE gateway_state SET fetch_token_nonce = zeroblob(1)",
        "UPDATE gateway_state SET fetch_token_key_version = 0",
    ] {
        let directory = secure_tempdir();
        let path = database_path(directory.path());
        let mut store = Store::open(&path, test_keyring()).expect("open gateway store");
        store
            .initialize_bootstrap_state(bootstrap_state(b"session", b"initial", Vec::new()))
            .expect("initialize bootstrap state");
        let connection = Connection::open(&path).expect("open token corruption fixture");
        connection.execute(sql, []).expect("apply token corruption");
        drop(connection);
        assert_code_only(
            store
                .fetch_sync_token()
                .expect_err("corrupt fetch token must fail closed"),
            STORE_SYNC_CORRUPT,
        );
    }

    for sql in [
        "UPDATE sync_inbox SET response_sha256 = zeroblob(32)",
        "UPDATE sync_inbox SET response_nonce = zeroblob(1)",
        "UPDATE sync_inbox SET response_key_version = 0",
        "UPDATE sync_inbox SET state = 'committed'",
        "UPDATE sync_inbox SET state = 'prepared', prepared_at = NULL",
    ] {
        let directory = secure_tempdir();
        let path = database_path(directory.path());
        let mut store = Store::open(&path, test_keyring()).expect("open gateway store");
        store
            .initialize_bootstrap_state(bootstrap_state(b"session", b"initial", Vec::new()))
            .expect("initialize bootstrap state");
        store
            .append_fetched_sync(raw_sync_input(
                b"initial",
                b"next-1",
                b"body",
                1_700_000_001_000,
            ))
            .expect("append response for corruption fixture");
        let connection = Connection::open(&path).expect("open row corruption fixture");
        connection.execute(sql, []).expect("apply row corruption");
        drop(connection);
        assert_code_only(
            store
                .oldest_uncommitted_inbox()
                .expect_err("corrupt row must fail closed"),
            STORE_SYNC_CORRUPT,
        );
    }
}

#[test]
fn committed_token_ciphertext_and_aad_corruption_fails_both_token_getters() {
    for corruption in ["nonce", "key_version", "aad", "fetch_aad"] {
        let directory = secure_tempdir();
        let path = database_path(directory.path());
        let store = Store::open(&path, test_keyring()).expect("open committed-token fixture");
        let mut store = store;
        store
            .initialize_bootstrap_state(bootstrap_state(b"session", b"token", Vec::new()))
            .expect("initialize bootstrap state");
        let connection = Connection::open(&path).expect("open committed-token corruption fixture");
        match corruption {
            "nonce" => {
                connection
                    .execute(
                        "UPDATE gateway_state SET committed_token_nonce = zeroblob(1)",
                        [],
                    )
                    .expect("corrupt committed-token nonce");
            }
            "key_version" => {
                connection
                    .execute(
                        "UPDATE gateway_state SET committed_token_key_version = 0",
                        [],
                    )
                    .expect("corrupt committed-token key version");
            }
            "aad" => {
                let sealed = test_keyring()
                    .seal("gateway_state", "1", "fetch_token", b"token")
                    .expect("seal wrong-aad committed token");
                connection
                    .execute(
                        "UPDATE gateway_state
                         SET committed_token_cipher = ?1,
                             committed_token_nonce = ?2,
                             committed_token_key_version = ?3",
                        params![
                            sealed.ciphertext,
                            sealed.nonce.as_slice(),
                            i64::from(sealed.key_version)
                        ],
                    )
                    .expect("write wrong-aad committed token");
            }
            "fetch_aad" => {
                let sealed = test_keyring()
                    .seal("gateway_state", "1", "committed_token", b"token")
                    .expect("seal wrong-aad fetch token");
                connection
                    .execute(
                        "UPDATE gateway_state
                         SET fetch_token_cipher = ?1,
                             fetch_token_nonce = ?2,
                             fetch_token_key_version = ?3",
                        params![
                            sealed.ciphertext,
                            sealed.nonce.as_slice(),
                            i64::from(sealed.key_version)
                        ],
                    )
                    .expect("write wrong-aad fetch token");
            }
            _ => unreachable!("known corruption fixture"),
        }
        drop(connection);

        assert_code_only(
            store
                .committed_sync_token()
                .expect_err("committed-token corruption must fail committed getter"),
            STORE_SYNC_CORRUPT,
        );
        assert_code_only(
            store
                .fetch_sync_token()
                .expect_err("committed-token corruption must fail fetch getter"),
            STORE_SYNC_CORRUPT,
        );
    }
}

#[test]
fn sync_plaintext_is_absent_from_database_wal_and_shm_while_open() {
    let directory = secure_tempdir();
    let path = database_path(directory.path());
    let mut store = Store::open(&path, test_keyring()).expect("open gateway store");
    store
        .initialize_bootstrap_state(bootstrap_state(
            b"session",
            CANARIES[0].as_bytes(),
            Vec::new(),
        ))
        .expect("initialize bootstrap state");
    let response = b"{ \n  \"unicode\": \"caf\xC3\xA9\", \"whitespace\":  true \n}\n";
    store
        .append_fetched_sync(raw_sync_input(
            CANARIES[0].as_bytes(),
            CANARIES[1].as_bytes(),
            [CANARIES[2].as_bytes(), response].concat().as_slice(),
            1_700_000_001_000,
        ))
        .expect("append canary response");

    let storage = sqlite_storage_bytes(&path);
    for canary in CANARIES {
        assert_storage_excludes(&storage, canary.as_bytes());
    }
    assert_storage_excludes(&storage, response);
}

#[test]
fn append_rejects_observed_time_before_verified_predecessor_without_mutation() {
    let directory = secure_tempdir();
    let path = database_path(directory.path());
    let mut store = Store::open(&path, test_keyring()).expect("open gateway store");
    store
        .initialize_bootstrap_state(bootstrap_state(b"session", b"initial", Vec::new()))
        .expect("initialize bootstrap state");
    store
        .append_fetched_sync(raw_sync_input(
            b"initial",
            b"next-1",
            b"first",
            1_700_000_002_000,
        ))
        .expect("append predecessor response");
    let before_rows = raw_sync_inbox_rows(&path);
    let before_gateway = raw_gateway_state(&path);

    assert_code_only(
        store
            .append_fetched_sync(raw_sync_input(
                b"next-1",
                b"next-2",
                b"older response",
                1_700_000_001_000,
            ))
            .expect_err("an observed time before its predecessor must be invalid"),
        STORE_SYNC_INVALID,
    );
    assert_sync_inbox_snapshot_eq(&raw_sync_inbox_rows(&path), &before_rows);
    assert_gateway_snapshot_eq(&raw_gateway_state(&path), &before_gateway);
}

#[test]
fn append_at_row_cap_allows_exact_retry_but_rejects_new_row_without_mutation() {
    let directory = secure_tempdir();
    let path = database_path(directory.path());
    let mut store = Store::open(&path, test_keyring()).expect("open gateway store");
    store
        .initialize_bootstrap_state(bootstrap_state(b"session", b"initial", Vec::new()))
        .expect("initialize bootstrap state");
    let first_id = populate_row_cap_chain(&path);
    assert_eq!(
        table_count(&path, "sync_inbox"),
        MAX_PENDING_REQUEST_ROWS as i64
    );
    let before_retry_rows = raw_sync_inbox_rows(&path);
    let before_retry_gateway = raw_gateway_state(&path);

    let retry_id = store
        .append_fetched_sync(raw_sync_input(
            b"initial",
            b"next-0",
            &[0],
            1_700_000_999_000,
        ))
        .expect("exact retry at the retained row cap must succeed");
    assert_eq!(retry_id.as_str(), first_id);
    assert_sync_inbox_snapshot_eq(&raw_sync_inbox_rows(&path), &before_retry_rows);
    assert_gateway_snapshot_eq(&raw_gateway_state(&path), &before_retry_gateway);

    let before_rejection_rows = raw_sync_inbox_rows(&path);
    let before_rejection_gateway = raw_gateway_state(&path);
    assert_code_only(
        store
            .append_fetched_sync(raw_sync_input(
                format!("next-{}", MAX_PENDING_REQUEST_ROWS - 1).as_bytes(),
                "next-over-cap".as_bytes(),
                b"new row",
                1_700_003_000_000,
            ))
            .expect_err("a new row at the retained row cap must be too large"),
        STORE_SYNC_TOO_LARGE,
    );
    assert_sync_inbox_snapshot_eq(&raw_sync_inbox_rows(&path), &before_rejection_rows);
    assert_gateway_snapshot_eq(&raw_gateway_state(&path), &before_rejection_gateway);
}

#[test]
fn row_cap_checks_token_and_chain_before_too_large() {
    let directory = secure_tempdir();
    let path = database_path(directory.path());
    let mut store = Store::open(&path, test_keyring()).expect("open row-cap precedence store");
    store
        .initialize_bootstrap_state(bootstrap_state(b"session", b"initial", Vec::new()))
        .expect("initialize bootstrap state");
    populate_row_cap_chain(&path);

    let before_conflict_rows = raw_sync_inbox_rows(&path);
    let before_conflict_gateway = raw_gateway_state(&path);
    assert_code_only(
        store
            .append_fetched_sync(raw_sync_input(
                b"initial",
                b"next-conflict",
                b"candidate",
                1_700_003_000_000,
            ))
            .expect_err("same request with a different successor must conflict before row cap"),
        STORE_SYNC_CONFLICT,
    );
    assert_sync_inbox_snapshot_eq(&raw_sync_inbox_rows(&path), &before_conflict_rows);
    assert_gateway_snapshot_eq(&raw_gateway_state(&path), &before_conflict_gateway);

    let before_rows = raw_sync_inbox_metadata(&path);
    let before_gateway = raw_gateway_state(&path);
    assert_code_only(
        store
            .append_fetched_sync(raw_sync_input(
                b"wrong-request",
                b"next-over-cap",
                b"candidate",
                1_700_003_000_000,
            ))
            .expect_err("wrong request token must win over row capacity"),
        STORE_SYNC_TOKEN_MISMATCH,
    );
    assert_sync_inbox_metadata_eq(&raw_sync_inbox_metadata(&path), &before_rows);
    assert_gateway_snapshot_eq(&raw_gateway_state(&path), &before_gateway);

    update_sync_inbox_sql(
        &path,
        "UPDATE sync_inbox SET response_sha256 = zeroblob(32)
         WHERE predecessor_id IS NULL",
    );
    let before_corrupt_rows = raw_sync_inbox_metadata(&path);
    let before_corrupt_gateway = raw_gateway_state(&path);
    assert_code_only(
        store
            .append_fetched_sync(raw_sync_input(
                format!("next-{}", MAX_PENDING_REQUEST_ROWS - 1).as_bytes(),
                b"next-corrupt-cap",
                b"candidate",
                1_700_003_001_000,
            ))
            .expect_err("corrupt chain must win over row capacity"),
        STORE_SYNC_CORRUPT,
    );
    assert_sync_inbox_metadata_eq(&raw_sync_inbox_metadata(&path), &before_corrupt_rows);
    assert_gateway_snapshot_eq(&raw_gateway_state(&path), &before_corrupt_gateway);
}

#[test]
fn append_rejects_persisted_row_count_over_cap_as_corrupt_without_mutation() {
    let directory = secure_tempdir();
    let path = database_path(directory.path());
    let mut store = Store::open(&path, test_keyring()).expect("open gateway store");
    store
        .initialize_bootstrap_state(bootstrap_state(b"session", b"initial", Vec::new()))
        .expect("initialize bootstrap state");
    populate_row_cap_chain(&path);
    rebuild_sync_inbox_without_predecessor_unique_index(&path);
    insert_extra_row_after_row_cap(&path);
    let before_count = table_count(&path, "sync_inbox");
    assert_eq!(before_count, MAX_PENDING_REQUEST_ROWS as i64 + 1);
    assert_eq!(table_count(&path, "sync_inbox"), before_count);
    assert_all_sync_entry_points_report_corrupt(&mut store, &path, &[0xD9; 32]);
    assert_eq!(table_count(&path, "sync_inbox"), before_count);
}

#[test]
fn successful_append_changes_only_fetch_position_and_leaves_lifecycle_fresh() {
    let directory = secure_tempdir();
    let path = database_path(directory.path());
    let lookup = [0xE8; 32];
    let mut store = Store::open(&path, test_keyring()).expect("open gateway store");
    store
        .initialize_bootstrap_state(bootstrap_state(
            b"session",
            b"initial",
            vec![anchor(lookup, 1)],
        ))
        .expect("initialize bootstrap state");
    let before_gateway = raw_gateway_state(&path).expect("gateway snapshot before append");
    let before_rooms = raw_room_progress(&path);
    let id = store
        .append_fetched_sync(raw_sync_input(
            b"initial",
            b"next-1",
            b"fresh response",
            1_700_000_001_000,
        ))
        .expect("append response");

    let rows = raw_sync_inbox_rows(&path);
    assert_eq!(rows.len(), 1);
    let row = &rows[0];
    assert_eq!(row.inbox_id, id.as_str());
    assert_eq!(row.state, "fetched");
    assert_eq!(row.crypto_drained, 0);
    assert_eq!(row.sdk_processed_at, None);
    assert_eq!(row.prepared_at, None);
    assert_eq!(row.committed_at, None);
    assert_eq!(row.terminal_code, None);

    let after_gateway = raw_gateway_state(&path).expect("gateway snapshot after append");
    assert_room_progress_snapshot_eq(&raw_room_progress(&path), &before_rooms);
    assert_protected_bytes_eq(
        &after_gateway.session_cipher,
        &before_gateway.session_cipher,
        "session ciphertext",
    );
    assert_protected_bytes_eq(
        &after_gateway.session_nonce,
        &before_gateway.session_nonce,
        "session nonce",
    );
    assert_eq!(
        after_gateway.session_key_version,
        before_gateway.session_key_version
    );
    assert_protected_bytes_eq(
        &after_gateway.committed_token_cipher,
        &before_gateway.committed_token_cipher,
        "committed-token ciphertext",
    );
    assert_protected_bytes_eq(
        &after_gateway.committed_token_nonce,
        &before_gateway.committed_token_nonce,
        "committed-token nonce",
    );
    assert_eq!(
        after_gateway.committed_token_key_version,
        before_gateway.committed_token_key_version
    );
    assert_eq!(after_gateway.singleton, before_gateway.singleton);
    assert_eq!(
        after_gateway.maintenance_code,
        before_gateway.maintenance_code
    );
    assert_eq!(
        after_gateway.maintenance_since,
        before_gateway.maintenance_since
    );
    assert_eq!(
        after_gateway.bootstrapped_at,
        before_gateway.bootstrapped_at
    );
    assert_eq!(
        after_gateway.updated_at,
        timestamp(1_700_000_001_000).to_rfc3339()
    );
    assert_ne!(after_gateway.updated_at, before_gateway.updated_at);
    let mut allowed_changes = before_gateway.clone();
    allowed_changes.fetch_token_cipher = after_gateway.fetch_token_cipher.clone();
    allowed_changes.fetch_token_nonce = after_gateway.fetch_token_nonce.clone();
    allowed_changes.fetch_token_key_version = after_gateway.fetch_token_key_version;
    allowed_changes.updated_at = after_gateway.updated_at.clone();
    assert_gateway_snapshot_eq(&Some(after_gateway), &Some(allowed_changes));
}

#[test]
fn token_getters_return_none_on_fresh_store_and_corrupt_on_partial_singleton() {
    let directory = secure_tempdir();
    let path = database_path(directory.path());
    let store = Store::open(&path, test_keyring()).expect("open fresh gateway store");
    assert!(
        store
            .committed_sync_token()
            .expect("read fresh committed token")
            .is_none()
    );
    assert!(
        store
            .fetch_sync_token()
            .expect("read fresh fetch token")
            .is_none()
    );
    drop(store);

    let directory = secure_tempdir();
    let path = database_path(directory.path());
    let store = Store::open(&path, test_keyring()).expect("open partial-singleton store");
    let connection = Connection::open(&path).expect("open partial singleton fixture");
    connection
        .execute(
            "INSERT INTO gateway_state(singleton, updated_at) VALUES (1, ?1)",
            [timestamp(1_700_000_000_000).to_rfc3339()],
        )
        .expect("insert partial singleton fixture");
    drop(connection);
    assert_code_only(
        store
            .committed_sync_token()
            .expect_err("partial singleton committed token must fail closed"),
        STORE_SYNC_CORRUPT,
    );
    assert_code_only(
        store
            .fetch_sync_token()
            .expect_err("partial singleton fetch token must fail closed"),
        STORE_SYNC_CORRUPT,
    );
}

fn assert_all_sync_entry_points_report_corrupt(store: &mut Store, path: &Path, lookup: &[u8; 32]) {
    let before_sync = raw_sync_inbox_values(path);
    let before_gateway = raw_gateway_values(path);
    let before_rooms = raw_room_progress(path);
    assert_code_only(
        store
            .matrix_session()
            .expect_err("corrupt bootstrap state must fail session read closed"),
        STORE_SYNC_CORRUPT,
    );
    assert_code_only(
        store
            .room_anchor(lookup)
            .expect_err("corrupt bootstrap state must fail room read closed"),
        STORE_SYNC_CORRUPT,
    );
    assert_code_only(
        store
            .committed_sync_token()
            .expect_err("corrupt bootstrap state must fail committed-token read closed"),
        STORE_SYNC_CORRUPT,
    );
    assert_code_only(
        store
            .fetch_sync_token()
            .expect_err("corrupt bootstrap state must fail fetch-token read closed"),
        STORE_SYNC_CORRUPT,
    );
    assert_code_only(
        store
            .reconcile_sdk_position(&digest(b"token"))
            .expect_err("corrupt bootstrap state must fail reconcile closed"),
        STORE_SYNC_CORRUPT,
    );
    assert_code_only(
        store
            .oldest_uncommitted_inbox()
            .expect_err("corrupt bootstrap state must fail oldest read closed"),
        STORE_SYNC_CORRUPT,
    );
    assert_code_only(
        store
            .append_fetched_sync(raw_sync_input(
                b"token",
                b"next-corrupt-bootstrap",
                b"candidate",
                1_700_000_001_000,
            ))
            .expect_err("corrupt bootstrap state must fail append closed"),
        STORE_SYNC_CORRUPT,
    );
    assert_eq!(raw_sync_inbox_values(path), before_sync);
    assert_eq!(raw_gateway_values(path), before_gateway);
    assert_room_progress_snapshot_eq(&raw_room_progress(path), &before_rooms);
}

#[test]
fn oversized_gateway_and_room_progress_values_fail_before_sync_materialization() {
    for sql in [
        format!(
            "UPDATE gateway_state SET session_cipher = zeroblob({})",
            MAX_BOOTSTRAP_SESSION_BYTES + AEAD_TAG_BYTES + 1
        ),
        format!(
            "UPDATE gateway_state SET committed_token_cipher = zeroblob({})",
            MAX_SYNC_TOKEN_BYTES + AEAD_TAG_BYTES + 1
        ),
        format!(
            "UPDATE gateway_state SET updated_at = printf('%.*c', {}, 'x')",
            1_000_000
        ),
    ] {
        let directory = secure_tempdir();
        let path = database_path(directory.path());
        let lookup = [0xE4; 32];
        let mut store = Store::open(&path, test_keyring()).expect("open gateway bounds store");
        store
            .initialize_bootstrap_state(bootstrap_state(
                b"session",
                b"token",
                vec![anchor(lookup, 1)],
            ))
            .expect("initialize bootstrap state");
        update_sync_inbox_sql(&path, &sql);
        assert_all_sync_entry_points_report_corrupt(&mut store, &path, &lookup);
    }

    for sql in [
        format!(
            "UPDATE room_progress SET anchor_event_cipher = zeroblob({})",
            MAX_ROOM_ANCHOR_BYTES + AEAD_TAG_BYTES + 1
        ),
        "UPDATE room_progress SET room_lookup = zeroblob(33)".to_owned(),
        format!(
            "UPDATE room_progress SET updated_at = printf('%.*c', {}, 'x')",
            1_000_000
        ),
    ] {
        let directory = secure_tempdir();
        let path = database_path(directory.path());
        let lookup = [0xE5; 32];
        let mut store = Store::open(&path, test_keyring()).expect("open room bounds store");
        store
            .initialize_bootstrap_state(bootstrap_state(
                b"session",
                b"token",
                vec![anchor(lookup, 1)],
            ))
            .expect("initialize bootstrap state");
        update_sync_inbox_sql(&path, &sql);
        assert_all_sync_entry_points_report_corrupt(&mut store, &path, &lookup);
    }
}

#[test]
fn duplicate_unrelated_room_lookup_fails_all_sync_reads() {
    let directory = secure_tempdir();
    let path = database_path(directory.path());
    let lookup = [0xE6; 32];
    let unrelated = [0xE7; 32];
    let mut store = Store::open(&path, test_keyring()).expect("open duplicate lookup store");
    store
        .initialize_bootstrap_state(bootstrap_state(
            b"session",
            b"token",
            vec![anchor(lookup, 1), anchor(unrelated, 1)],
        ))
        .expect("initialize bootstrap state");
    rebuild_room_progress_without_lookup_unique_index(&path);
    duplicate_room_progress_row(&path, &unrelated);

    assert_all_sync_entry_points_report_corrupt(&mut store, &path, &lookup);
}

#[test]
fn retained_chain_corruption_matrix_is_rejected_by_both_reads() {
    assert_two_row_corruption(|path, first, second| {
        update_predecessor(path, first, Some(second));
        update_predecessor(path, second, Some(first));
    });

    assert_two_row_corruption(|path, _first, second| {
        update_predecessor(path, second, Some(&format!("inbox_{}", "a".repeat(64))));
    });

    assert_two_row_corruption(|path, _first, second| {
        update_predecessor(path, second, None);
    });

    assert_two_row_corruption(|path, _first, _second| {
        set_committed_token(path, b"wrong-root-token");
    });

    assert_two_row_corruption(|path, _first, second| {
        mark_inbox_committed(path, second, 1_700_000_003_000);
    });

    assert_two_row_corruption(|path, _first, _second| {
        set_fetch_token(path, b"wrong-final-token");
    });

    assert_two_row_corruption(|path, _first, _second| {
        update_sync_inbox_sql(
            path,
            "UPDATE sync_inbox SET request_token_digest = zeroblob(32)
             WHERE predecessor_id IS NULL",
        );
    });

    assert_two_row_corruption(|path, _first, _second| {
        update_sync_inbox_sql(
            path,
            "UPDATE sync_inbox SET next_token_digest = zeroblob(32)
             WHERE predecessor_id IS NULL",
        );
    });

    assert_two_row_corruption(|path, _first, second| {
        update_sync_inbox_sql(
            path,
            &format!(
                "UPDATE sync_inbox SET response_cipher = zeroblob(1)
                 WHERE inbox_id = '{second}'"
            ),
        );
    });

    assert_two_row_corruption(|path, first, _second| {
        replace_sync_inbox_ciphertext_with_wrong_aad(
            path,
            first,
            "next_token",
            "response",
            b"next-1",
        );
    });

    assert_two_row_corruption(|path, _first, second| {
        update_sync_inbox_sql(
            path,
            &format!(
                "UPDATE sync_inbox SET observed_at = '2023-11-14T22:13:20+00:00',
                 created_at = '2023-11-14T22:13:20+00:00' WHERE inbox_id = '{second}'"
            ),
        );
    });

    assert_two_row_corruption(|path, _first, second| {
        update_sync_inbox_sql(
            path,
            &format!(
                "UPDATE sync_inbox SET state = 'prepared',
                 sdk_processed_at = '2023-11-14T22:13:22+00:00', prepared_at = NULL
                 WHERE inbox_id = '{second}'"
            ),
        );
    });

    assert_two_row_corruption(|path, _first, _second| {
        update_sync_inbox_sql(path, "UPDATE sync_inbox SET state = 'invalid_state'");
    });

    let (_directory, path, store, first, _second) = setup_two_row_chain();
    rebuild_sync_inbox_without_predecessor_unique_index(&path);
    let mut connection = Connection::open(&path).expect("open multiple-successor fixture");
    let transaction = connection
        .transaction()
        .expect("begin multiple-successor fixture transaction");
    insert_valid_fetched_row(
        &transaction,
        Some(&first),
        b"next-1",
        b"next-3",
        b"fork successor",
        1_700_000_003_000,
    );
    transaction
        .commit()
        .expect("commit multiple-successor fixture");
    set_fetch_token(&path, b"next-3");
    assert_both_chain_reads_corrupt(&store, &path, &digest(b"next-3"));

    let (_directory, path, store, _first, second) = setup_two_row_chain();
    rebuild_sync_inbox_without_predecessor_unique_index(&path);
    let mut connection = Connection::open(&path).expect("open duplicate-next fixture");
    let transaction = connection
        .transaction()
        .expect("begin duplicate-next fixture transaction");
    insert_valid_fetched_row(
        &transaction,
        Some(&second),
        b"next-2",
        b"next-1",
        b"duplicate successor digest",
        1_700_000_003_000,
    );
    transaction.commit().expect("commit duplicate-next fixture");
    set_fetch_token(&path, b"next-1");

    let before_rows = raw_sync_inbox_values(&path);
    let before_gateway = raw_gateway_values(&path);
    assert_code_only(
        store
            .reconcile_sdk_position(&digest(b"next-1"))
            .expect_err("duplicate next-token digest must fail reconcile closed"),
        STORE_SYNC_CORRUPT,
    );
    assert_code_only(
        store
            .oldest_uncommitted_inbox()
            .expect_err("duplicate next-token digest must fail oldest read closed"),
        STORE_SYNC_CORRUPT,
    );
    assert_eq!(raw_sync_inbox_values(&path), before_rows);
    assert_eq!(raw_gateway_values(&path), before_gateway);

    let directory = secure_tempdir();
    let path = database_path(directory.path());
    let mut store = Store::open(&path, test_keyring()).expect("open duplicate-request store");
    store
        .initialize_bootstrap_state(bootstrap_state(b"session", b"initial", Vec::new()))
        .expect("initialize bootstrap state");
    store
        .append_fetched_sync(raw_sync_input(
            b"initial",
            b"next-1",
            b"first",
            1_700_000_001_000,
        ))
        .expect("append first duplicate-request fixture row");
    store
        .append_fetched_sync(raw_sync_input(
            b"next-1",
            b"initial",
            b"loop",
            1_700_000_002_000,
        ))
        .expect("append second duplicate-request fixture row");
    let rows = raw_sync_inbox_rows(&path);
    let predecessor = rows
        .last()
        .expect("duplicate-request predecessor")
        .inbox_id
        .clone();
    let mut connection = Connection::open(&path).expect("open duplicate-request insert fixture");
    let transaction = connection
        .transaction()
        .expect("begin duplicate-request insert fixture transaction");
    insert_valid_fetched_row(
        &transaction,
        Some(&predecessor),
        b"initial",
        b"next-3",
        b"third",
        1_700_000_003_000,
    );
    transaction
        .commit()
        .expect("commit third duplicate-request fixture row");
    set_fetch_token(&path, b"next-3");
    assert_both_chain_reads_corrupt(&store, &path, &digest(b"next-3"));
}

#[test]
fn valid_purge_root_and_empty_or_all_committed_chains_reconcile_without_repair() {
    let (_directory, path, store, first, second) = setup_two_row_chain();
    mark_inbox_committed(&path, &first, 1_700_000_003_000);
    set_committed_token(&path, b"next-1");
    let before_rows = raw_sync_inbox_rows(&path);
    let before_gateway = raw_gateway_state(&path);
    assert_eq!(
        store
            .reconcile_sdk_position(&digest(b"next-2"))
            .expect("reconcile retained purge root")
            .journaled_inbox_id()
            .expect("retained successor")
            .as_str(),
        second
    );
    let oldest = store
        .oldest_uncommitted_inbox()
        .expect("read retained purge root successor")
        .expect("uncommitted successor");
    assert_eq!(oldest.inbox_id().as_str(), second);
    assert_sync_inbox_snapshot_eq(&raw_sync_inbox_rows(&path), &before_rows);
    assert_gateway_snapshot_eq(&raw_gateway_state(&path), &before_gateway);

    let directory = secure_tempdir();
    let path = database_path(directory.path());
    let mut store = Store::open(&path, test_keyring()).expect("open empty bootstrapped store");
    store
        .initialize_bootstrap_state(bootstrap_state(b"session", b"initial", Vec::new()))
        .expect("initialize empty bootstrapped store");
    store
        .committed_sync_token()
        .expect("read empty committed token")
        .expect("committed token after bootstrap");
    assert_eq!(
        store
            .reconcile_sdk_position(&digest(b"initial"))
            .expect("reconcile empty bootstrapped chain"),
        SdkInboxPosition::Committed
    );
    assert!(
        store
            .oldest_uncommitted_inbox()
            .expect("read empty bootstrapped chain")
            .is_none()
    );

    let (_directory, path, store, first, second) = setup_two_row_chain();
    mark_inbox_committed(&path, &first, 1_700_000_003_000);
    mark_inbox_committed(&path, &second, 1_700_004_000_000);
    set_committed_token(&path, b"next-2");
    assert!(
        store
            .oldest_uncommitted_inbox()
            .expect("read all-committed chain")
            .is_none()
    );
    assert_eq!(
        store
            .reconcile_sdk_position(&digest(b"next-2"))
            .expect("reconcile all-committed chain"),
        SdkInboxPosition::Committed
    );
}

#[test]
fn persisted_byte_count_type_or_range_corruption_fails_all_sync_reads_and_append() {
    let sql_cases = [
        "UPDATE sync_inbox SET byte_count = 'not-an-integer'".to_owned(),
        "UPDATE sync_inbox SET byte_count = 0".to_owned(),
        format!(
            "UPDATE sync_inbox SET byte_count = {}",
            MAX_SYNC_RESPONSE_BYTES + 1
        ),
    ];
    for sql in sql_cases {
        let (_directory, path, mut store, _first, _second) = setup_two_row_chain();
        update_sync_inbox_sql(&path, &sql);
        let before_count = table_count(&path, "sync_inbox");
        assert_all_sync_entry_points_report_corrupt(&mut store, &path, &[0xDA; 32]);
        assert_eq!(table_count(&path, "sync_inbox"), before_count);
    }
}

#[test]
fn persisted_aggregate_byte_total_over_cap_is_corrupt_without_mutation() {
    let directory = secure_tempdir();
    let path = database_path(directory.path());
    let mut store = Store::open(&path, test_keyring()).expect("open aggregate-cap store");
    store
        .initialize_bootstrap_state(bootstrap_state(b"session", b"initial", Vec::new()))
        .expect("initialize bootstrap state");
    for index in 0..5 {
        let request = if index == 0 {
            b"initial".to_vec()
        } else {
            format!("next-{index}").into_bytes()
        };
        let next = format!("next-{}", index + 1).into_bytes();
        store
            .append_fetched_sync(raw_sync_input(
                &request,
                &next,
                &[u8::try_from(index).expect("fixture response byte")],
                1_700_000_001_000 + i64::from(index) * 1_000,
            ))
            .expect("append aggregate-cap fixture row");
    }
    update_sync_inbox_sql(
        &path,
        &format!(
            "UPDATE sync_inbox SET byte_count = {}",
            MAX_SYNC_RESPONSE_BYTES
        ),
    );
    let before_count = table_count(&path, "sync_inbox");
    assert_eq!(before_count, 5);
    assert_all_sync_entry_points_report_corrupt(&mut store, &path, &[0xDB; 32]);
    assert_eq!(table_count(&path, "sync_inbox"), before_count);
}

#[test]
fn aggregate_cap_corrupt_chain_precedes_too_large_without_large_fixture() {
    let directory = secure_tempdir();
    let path = database_path(directory.path());
    let mut store = Store::open(&path, test_keyring()).expect("open aggregate precedence store");
    store
        .initialize_bootstrap_state(bootstrap_state(b"session", b"initial", Vec::new()))
        .expect("initialize bootstrap state");
    populate_small_four_row_chain(&path);
    update_sync_inbox_sql(
        &path,
        &format!(
            "UPDATE sync_inbox SET byte_count = {}",
            MAX_SYNC_RESPONSE_BYTES
        ),
    );
    let before_rows = raw_sync_inbox_metadata(&path);
    let before_gateway = raw_gateway_state(&path);

    assert_code_only(
        store
            .append_fetched_sync(raw_sync_input(
                b"next-3",
                b"next-4",
                b"candidate",
                1_700_000_010_000,
            ))
            .expect_err("corrupt chain at aggregate cap must precede too-large"),
        STORE_SYNC_CORRUPT,
    );
    assert_sync_inbox_metadata_eq(&raw_sync_inbox_metadata(&path), &before_rows);
    assert_gateway_snapshot_eq(&raw_gateway_state(&path), &before_gateway);
}

#[test]
fn aggregate_cap_accepts_exact_256_mib_retry_and_rejects_new_rows() {
    let directory = secure_tempdir();
    let path = database_path(directory.path());
    let mut store = Store::open(&path, test_keyring()).expect("open exact aggregate-cap store");
    store
        .initialize_bootstrap_state(bootstrap_state(b"session", b"initial", Vec::new()))
        .expect("initialize bootstrap state");

    let first_id = populate_aggregate_cap_chain(&path);
    assert_eq!(table_count(&path, "sync_inbox"), 4);
    let before_retry_rows = raw_sync_inbox_rows(&path);
    let before_retry_gateway = raw_gateway_state(&path);
    let retry_response = vec![0xB0_u8; MAX_SYNC_RESPONSE_BYTES];
    let retry_id = store
        .append_fetched_sync(raw_sync_input(
            b"initial",
            b"next-0",
            &retry_response,
            1_700_000_099_000,
        ))
        .expect("exact retry at the aggregate cap must succeed");
    assert_eq!(retry_id.as_str(), first_id.as_str());
    assert_sync_inbox_snapshot_eq(&raw_sync_inbox_rows(&path), &before_retry_rows);
    assert_gateway_snapshot_eq(&raw_gateway_state(&path), &before_retry_gateway);

    let before_conflict_rows = raw_sync_inbox_rows(&path);
    let before_conflict_gateway = raw_gateway_state(&path);
    assert_code_only(
        store
            .append_fetched_sync(raw_sync_input(
                b"initial",
                b"next-0",
                b"different body",
                1_700_000_099_500,
            ))
            .expect_err("same request with a different body must conflict before aggregate cap"),
        STORE_SYNC_CONFLICT,
    );
    assert_sync_inbox_snapshot_eq(&raw_sync_inbox_rows(&path), &before_conflict_rows);
    assert_gateway_snapshot_eq(&raw_gateway_state(&path), &before_conflict_gateway);
    drop(before_conflict_rows);
    drop(before_retry_rows);

    let before_mismatch_rows = raw_sync_inbox_metadata(&path);
    let before_mismatch_gateway = raw_gateway_state(&path);
    assert_code_only(
        store
            .append_fetched_sync(raw_sync_input(
                b"wrong-request",
                b"next-over-cap",
                b"candidate",
                1_700_000_100_000,
            ))
            .expect_err("wrong token must win over aggregate capacity"),
        STORE_SYNC_TOKEN_MISMATCH,
    );
    assert_sync_inbox_metadata_eq(&raw_sync_inbox_metadata(&path), &before_mismatch_rows);
    assert_gateway_snapshot_eq(&raw_gateway_state(&path), &before_mismatch_gateway);

    let before_too_large_rows = raw_sync_inbox_metadata(&path);
    let before_too_large_gateway = raw_gateway_state(&path);
    assert_code_only(
        store
            .append_fetched_sync(raw_sync_input(
                b"next-3",
                b"next-4",
                b"new row",
                1_700_000_101_000,
            ))
            .expect_err("valid new row at aggregate capacity must be too large"),
        STORE_SYNC_TOO_LARGE,
    );
    assert_sync_inbox_metadata_eq(&raw_sync_inbox_metadata(&path), &before_too_large_rows);
    assert_gateway_snapshot_eq(&raw_gateway_state(&path), &before_too_large_gateway);
}
