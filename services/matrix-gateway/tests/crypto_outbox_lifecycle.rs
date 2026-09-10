use std::{
    fs,
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
};

use chrono::{DateTime, TimeZone, Utc};
use communicator_matrix_gateway::{
    canonical::canonical_json_bytes,
    crypto::{Keyring, Sealed},
    crypto_outbox::{ExactMatrixRequest, MAX_MATRIX_CRYPTO_RESPONSE_BYTES, RawMatrixResponse},
    store::{
        STORE_CRYPTO_CONFLICT, STORE_CRYPTO_CORRUPT, STORE_CRYPTO_INVALID, STORE_CRYPTO_NOT_READY,
        STORE_CRYPTO_TOO_LARGE, Store,
    },
    store_types::{NewBootstrapState, NewRawSyncInbox},
};
use rusqlite::{Connection, types::Value};
use serde_json::json;
use sha2::{Digest, Sha256};
use tempfile::{TempDir, tempdir};

fn exact_json_object(size: usize) -> Vec<u8> {
    let prefix = br#"{"a":""#;
    let suffix = br#""}"#;
    assert!(size >= prefix.len() + suffix.len());
    let mut body = Vec::with_capacity(size);
    body.extend_from_slice(prefix);
    body.extend(std::iter::repeat_n(
        b'x',
        size - prefix.len() - suffix.len(),
    ));
    body.extend_from_slice(suffix);
    assert_eq!(body.len(), size);
    body
}

fn assert_code(error: communicator_matrix_gateway::secret::SafeError, code: &str) {
    assert_eq!(error.code(), code);
    assert_eq!(error.to_string(), code);
}

fn timestamp(milliseconds: i64) -> DateTime<Utc> {
    Utc.timestamp_millis_opt(milliseconds)
        .single()
        .expect("construct test timestamp")
}

fn secure_tempdir() -> TempDir {
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

fn canonical_keys_query() -> Vec<u8> {
    canonical_json_bytes(&json!({
        "device_keys": {
            "@alice:example.org": ["DEVICE", "SECOND"],
            "@東京:example.org": ["端末"]
        },
        "timeout": null
    }))
    .expect("canonical keys query fixture")
}

fn request_with_body(sdk_request_id: &[u8], body: &[u8]) -> ExactMatrixRequest {
    ExactMatrixRequest::keys_query(sdk_request_id.to_vec(), body.to_vec())
        .expect("construct canonical keys query request")
}

fn setup_two_fetched_rows() -> (TempDir, PathBuf, Store, String, String) {
    let directory = secure_tempdir();
    let path = database_path(directory.path());
    let mut store = Store::open(&path, test_keyring()).expect("open gateway store");
    store
        .initialize_bootstrap_state(
            NewBootstrapState::new(
                b"session".to_vec(),
                b"initial".to_vec(),
                Vec::new(),
                timestamp(1_700_000_000_000),
            )
            .expect("construct bootstrap state"),
        )
        .expect("initialize bootstrap state");
    let first = store
        .append_fetched_sync(
            NewRawSyncInbox::new(
                b"initial".to_vec(),
                b"next-1".to_vec(),
                b"first response".to_vec(),
                timestamp(1_700_000_001_000),
            )
            .expect("construct first response"),
        )
        .expect("append first response");
    let second = store
        .append_fetched_sync(
            NewRawSyncInbox::new(
                b"next-1".to_vec(),
                b"next-2".to_vec(),
                b"second response".to_vec(),
                timestamp(1_700_000_002_000),
            )
            .expect("construct second response"),
        )
        .expect("append second response");
    (
        directory,
        path,
        store,
        first.as_str().to_owned(),
        second.as_str().to_owned(),
    )
}

#[derive(Clone, PartialEq)]
struct RawSnapshot {
    gateway: Vec<Vec<Value>>,
    inbox: Vec<Vec<Value>>,
    crypto: Vec<Vec<Value>>,
}

fn query_values(connection: &Connection, sql: &str, columns: usize) -> Vec<Vec<Value>> {
    let mut statement = connection
        .prepare(sql)
        .expect("prepare sqlite snapshot query");
    statement
        .query_map([], |row| {
            (0..columns)
                .map(|index| row.get(index))
                .collect::<Result<Vec<Value>, _>>()
        })
        .expect("query sqlite snapshot rows")
        .collect::<Result<Vec<_>, _>>()
        .expect("read sqlite snapshot rows")
}

fn raw_snapshot(path: &Path) -> RawSnapshot {
    let connection = Connection::open(path).expect("open sqlite snapshot database");
    RawSnapshot {
        gateway: query_values(
            &connection,
            "SELECT singleton, session_cipher, session_nonce, session_key_version,
                    committed_token_cipher, committed_token_nonce, committed_token_key_version,
                    fetch_token_cipher, fetch_token_nonce, fetch_token_key_version,
                    maintenance_code, maintenance_since, bootstrapped_at, updated_at
             FROM gateway_state ORDER BY singleton",
            14,
        ),
        inbox: query_values(
            &connection,
            "SELECT inbox_id, predecessor_id,
                    request_token_cipher, request_token_nonce, request_token_key_version,
                    request_token_digest,
                    next_token_cipher, next_token_nonce, next_token_key_version,
                    next_token_digest,
                    response_cipher, response_nonce, response_key_version, response_sha256,
                    byte_count, state, crypto_drained, observed_at, created_at,
                    sdk_processed_at, prepared_at, committed_at, terminal_code
             FROM sync_inbox ORDER BY rowid",
            23,
        ),
        crypto: query_values(
            &connection,
            "SELECT crypto_row_id, inbox_id, request_lookup, request_kind,
                    sdk_request_id_cipher, sdk_request_id_nonce, sdk_request_id_key_version,
                    request_cipher, request_nonce, request_key_version, request_sha256,
                    byte_count, response_cipher, response_nonce, response_key_version,
                    response_sha256, state, attempt_count, next_attempt_at,
                    accepted_at, terminal_code
             FROM matrix_crypto_outbox ORDER BY rowid",
            21,
        ),
    }
}

fn assert_snapshot_unchanged(actual: &RawSnapshot, expected: &RawSnapshot) {
    assert!(actual == expected, "sqlite snapshot changed");
}

fn mutate_sql(path: &Path, sql: &str) {
    let connection = Connection::open(path).expect("open sqlite mutation database");
    connection
        .execute("PRAGMA ignore_check_constraints = ON", [])
        .expect("enable sqlite mutation checks");
    connection.execute(sql, []).expect("apply sqlite mutation");
}

fn crypto_lookup(body: &[u8]) -> [u8; 32] {
    let body = std::str::from_utf8(body).expect("canonical request UTF-8");
    test_keyring()
        .lookup_digest("matrix-crypto-request-v1", &["keys_query", body])
        .expect("derive request lookup")
}

fn crypto_row_id(inbox_id: &str, request_lookup: &[u8; 32]) -> String {
    let mut framed = Vec::new();
    for value in [
        b"matrix-crypto-row-v1".as_slice(),
        inbox_id.as_bytes(),
        request_lookup.as_slice(),
    ] {
        framed.extend_from_slice(
            &u32::try_from(value.len())
                .expect("test frame length")
                .to_be_bytes(),
        );
        framed.extend_from_slice(value);
    }
    let digest: [u8; 32] = Sha256::digest(&framed).into();
    format!(
        "crypto_{}",
        digest
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>()
    )
}

fn raw_crypto_row_id(path: &Path) -> String {
    Connection::open(path)
        .expect("open sqlite crypto database")
        .query_row(
            "SELECT crypto_row_id FROM matrix_crypto_outbox ORDER BY rowid LIMIT 1",
            [],
            |row| row.get(0),
        )
        .expect("read crypto row ID")
}

fn drop_unresolved_crypto_index(path: &Path) {
    let connection = Connection::open(path).expect("open crypto index fixture");
    connection
        .execute("DROP INDEX one_unresolved_crypto_request", [])
        .expect("drop crypto unresolved index fixture");
}

fn insert_pending_crypto_row(path: &Path, inbox_id: &str, sdk_request_id: &[u8], body: &[u8]) {
    let request_lookup = crypto_lookup(body);
    let row_id = crypto_row_id(inbox_id, &request_lookup);
    let keyring = test_keyring();
    let sdk_sealed = keyring
        .seal(
            "matrix_crypto_outbox",
            &row_id,
            "sdk_request_id",
            sdk_request_id,
        )
        .expect("seal crypto SDK ID fixture");
    let request_sealed = keyring
        .seal("matrix_crypto_outbox", &row_id, "request", body)
        .expect("seal crypto request fixture");
    let connection = Connection::open(path).expect("open crypto row fixture");
    connection
        .execute(
            "INSERT INTO matrix_crypto_outbox
             (crypto_row_id, inbox_id, request_lookup, request_kind,
              sdk_request_id_cipher, sdk_request_id_nonce, sdk_request_id_key_version,
              request_cipher, request_nonce, request_key_version, request_sha256,
              byte_count, response_cipher, response_nonce, response_key_version,
              response_sha256, state, attempt_count, next_attempt_at,
              accepted_at, terminal_code)
             SELECT ?1, ?2, ?3, 'keys_query', ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11,
                    NULL, NULL, NULL, NULL, 'pending', 0, observed_at, NULL, NULL
             FROM sync_inbox WHERE inbox_id = ?2",
            rusqlite::params![
                row_id,
                inbox_id,
                request_lookup.as_slice(),
                sdk_sealed.ciphertext,
                sdk_sealed.nonce.as_slice(),
                i64::from(sdk_sealed.key_version),
                request_sealed.ciphertext,
                request_sealed.nonce.as_slice(),
                i64::from(request_sealed.key_version),
                Sha256::digest(body).as_slice(),
                i64::try_from(body.len()).expect("crypto body length"),
            ],
        )
        .expect("insert crypto row fixture");
}

#[allow(dead_code)]
struct RawCryptoRow {
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

fn raw_crypto_row(path: &Path) -> RawCryptoRow {
    Connection::open(path)
        .expect("open sqlite crypto database")
        .query_row(
            "SELECT crypto_row_id, inbox_id, request_lookup, request_kind,
                    sdk_request_id_cipher, sdk_request_id_nonce, sdk_request_id_key_version,
                    request_cipher, request_nonce, request_key_version, request_sha256,
                    byte_count, response_cipher, response_nonce, response_key_version,
                    response_sha256, state, attempt_count, next_attempt_at,
                    accepted_at, terminal_code
             FROM matrix_crypto_outbox ORDER BY rowid LIMIT 1",
            [],
            |row| {
                Ok(RawCryptoRow {
                    crypto_row_id: row.get(0)?,
                    inbox_id: row.get(1)?,
                    request_lookup: row.get(2)?,
                    request_kind: row.get(3)?,
                    sdk_request_id_cipher: row.get(4)?,
                    sdk_request_id_nonce: row.get(5)?,
                    sdk_request_id_key_version: row.get(6)?,
                    request_cipher: row.get(7)?,
                    request_nonce: row.get(8)?,
                    request_key_version: row.get(9)?,
                    request_sha256: row.get(10)?,
                    byte_count: row.get(11)?,
                    response_cipher: row.get(12)?,
                    response_nonce: row.get(13)?,
                    response_key_version: row.get(14)?,
                    response_sha256: row.get(15)?,
                    state: row.get(16)?,
                    attempt_count: row.get(17)?,
                    next_attempt_at: row.get(18)?,
                    accepted_at: row.get(19)?,
                    terminal_code: row.get(20)?,
                })
            },
        )
        .expect("read one crypto row")
}

fn decrypt_crypto_response(row: &RawCryptoRow, keyring: &Keyring) -> Vec<u8> {
    let nonce: [u8; 24] = row
        .response_nonce
        .as_deref()
        .expect("response nonce")
        .try_into()
        .expect("response nonce length");
    keyring
        .open(
            "matrix_crypto_outbox",
            &row.crypto_row_id,
            "response",
            &Sealed {
                nonce,
                ciphertext: row
                    .response_cipher
                    .as_ref()
                    .expect("response ciphertext")
                    .clone(),
                key_version: u32::try_from(row.response_key_version.expect("response key version"))
                    .expect("response key version range"),
            },
        )
        .expect("decrypt response")
        .as_bytes()
        .to_vec()
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
    assert!(
        !bytes.windows(needle.len()).any(|window| window == needle),
        "protected canary appeared in SQLite storage"
    );
}

#[test]
fn raw_matrix_response_accepts_exact_bounded_json_object_without_rewriting() {
    let body = exact_json_object(MAX_MATRIX_CRYPTO_RESPONSE_BYTES);
    let expected: [u8; 32] = Sha256::digest(&body).into();
    let response = RawMatrixResponse::keys_query(body).expect("exact bounded JSON object");
    assert_eq!(response.sha256(), &expected);
}

#[test]
fn raw_matrix_response_rejects_empty_oversized_invalid_utf8_malformed_and_non_object() {
    assert_code(
        RawMatrixResponse::keys_query(Vec::new()).expect_err("empty body"),
        STORE_CRYPTO_INVALID,
    );
    assert_code(
        RawMatrixResponse::keys_query(exact_json_object(MAX_MATRIX_CRYPTO_RESPONSE_BYTES + 1))
            .expect_err("one-over body"),
        STORE_CRYPTO_TOO_LARGE,
    );
    assert_code(
        RawMatrixResponse::keys_query(vec![0xff, 0xfe]).expect_err("invalid UTF-8"),
        STORE_CRYPTO_INVALID,
    );
    for body in [br#"{"a":1} trailing"#.as_slice(), br#"{"a":1"#.as_slice()] {
        assert_code(
            RawMatrixResponse::keys_query(body.to_vec()).expect_err("malformed or trailing JSON"),
            STORE_CRYPTO_INVALID,
        );
    }
    for body in [
        b"null".as_slice(),
        b"[]".as_slice(),
        br#""text""#.as_slice(),
    ] {
        assert_code(
            RawMatrixResponse::keys_query(body.to_vec()).expect_err("non-object JSON"),
            STORE_CRYPTO_INVALID,
        );
    }
}

#[test]
fn raw_matrix_response_accepts_deep_nested_large_values_and_keeps_exact_digest() {
    let mut body = Vec::new();
    for _ in 0..96 {
        body.extend_from_slice(br#"{"nested":"#);
    }
    body.extend_from_slice(b"{\"value\":\"");
    body.extend(std::iter::repeat_n(b'x', 1024 * 1024));
    body.extend_from_slice(b"\"}");
    body.extend(std::iter::repeat_n(b'}', 96));
    let expected: [u8; 32] = Sha256::digest(&body).into();

    let response = RawMatrixResponse::keys_query(body).expect("deep large JSON object");
    assert_eq!(response.sha256(), &expected);
}

#[test]
fn crypto_transport_dtos_redact_and_forbid_clone_serialize_deref_and_as_ref() {
    let response = RawMatrixResponse::keys_query(br#"{"a":1}"#.to_vec()).expect("response fixture");
    assert_eq!(format!("{response:?}"), "RawMatrixResponse([REDACTED])");
    assert_eq!(format!("{response}"), "RawMatrixResponse([REDACTED])");
}

#[test]
fn next_pending_returns_exact_verified_due_request_and_is_read_only() {
    let (_directory, path, mut store, first, _second) = setup_two_fetched_rows();
    let body = canonical_keys_query();
    let sdk_request_id = b"sdk-request-id-selection";
    let request = request_with_body(sdk_request_id, &body);
    store
        .record_sdk_processing(&first, std::slice::from_ref(&request))
        .expect("record pending request");
    let before = raw_snapshot(&path);

    let selected = store
        .next_pending_crypto_request(timestamp(1_700_000_001_000))
        .expect("select due request")
        .expect("pending request exists");
    assert_eq!(selected.row_id(), raw_crypto_row_id(&path));
    assert_eq!(selected.request_kind(), "keys_query");
    assert_eq!(selected.sdk_request_id().as_bytes(), sdk_request_id);
    assert_eq!(selected.request().as_bytes(), body.as_slice());
    let expected_sha256: [u8; 32] = Sha256::digest(&body).into();
    assert_eq!(selected.request_sha256(), &expected_sha256);
    assert_eq!(selected.attempt_count(), 0);
    assert_eq!(selected.next_attempt_at(), timestamp(1_700_000_001_000));
    assert_snapshot_unchanged(&raw_snapshot(&path), &before);
}

#[test]
fn sdk_processing_exact_retry_after_key_rotation_does_not_rewrite_row() {
    let (_directory, path, mut store, first, _second) = setup_two_fetched_rows();
    let body = canonical_keys_query();
    let request = request_with_body(b"sdk-request-id-rotated-retry", &body);
    store
        .record_sdk_processing(&first, std::slice::from_ref(&request))
        .expect("record initial SDK processing");
    let before = raw_snapshot(&path);
    drop(store);

    let rotated_keyring = Keyring::new([0x22; 32], 2)
        .expect("construct rotated keyring")
        .with_decryption_key(1, [0x11; 32])
        .expect("retain old key for retry verification");
    let mut reopened = Store::open(&path, rotated_keyring).expect("reopen with rotated keyring");
    reopened
        .record_sdk_processing(&first, std::slice::from_ref(&request))
        .expect("exact SDK processing retry");
    assert_snapshot_unchanged(&raw_snapshot(&path), &before);
}

#[test]
fn next_pending_returns_none_for_absent_or_future_request() {
    let (_directory, _path, store, _first, _second) = setup_two_fetched_rows();
    assert!(
        store
            .next_pending_crypto_request(timestamp(1_700_000_001_000))
            .expect("empty selection")
            .is_none()
    );

    let (_directory, path, mut store, first, _second) = setup_two_fetched_rows();
    let body = canonical_keys_query();
    let request = request_with_body(b"sdk-request-id-future", &body);
    store
        .record_sdk_processing(&first, std::slice::from_ref(&request))
        .expect("record future fixture");
    let row_id = raw_crypto_row_id(&path);
    mutate_sql(
        &path,
        &format!(
            "UPDATE matrix_crypto_outbox SET next_attempt_at = '2026-01-01T00:00:00.000Z'
             WHERE crypto_row_id = '{row_id}'"
        ),
    );
    assert!(
        store
            .next_pending_crypto_request(timestamp(1_700_000_001_000))
            .expect("future selection")
            .is_none()
    );
}

#[test]
fn next_pending_rejects_response_received_quarantined_multiple_or_corrupt_unresolved_rows() {
    let (_directory, path, mut store, first, _second) = setup_two_fetched_rows();
    let body = canonical_keys_query();
    let request = request_with_body(b"sdk-request-id-response", &body);
    store
        .record_sdk_processing(&first, std::slice::from_ref(&request))
        .expect("record response fixture");
    store
        .record_attempt(
            &raw_crypto_row_id(&path),
            0,
            timestamp(1_700_000_001_000),
            timestamp(1_700_000_001_000),
            timestamp(1_700_000_002_000),
        )
        .expect("lease response fixture");
    let response =
        RawMatrixResponse::keys_query(br#"{"one":1}"#.to_vec()).expect("response fixture");
    store
        .record_crypto_response(&raw_crypto_row_id(&path), &response)
        .expect("record response fixture");
    assert_code(
        store
            .next_pending_crypto_request(timestamp(1_700_000_003_000))
            .expect_err("response received blocks selection"),
        STORE_CRYPTO_NOT_READY,
    );

    let (_directory, path, mut store, first, _second) = setup_two_fetched_rows();
    let request = request_with_body(b"sdk-request-id-quarantine", &body);
    store
        .record_sdk_processing(&first, std::slice::from_ref(&request))
        .expect("record quarantine fixture");
    store
        .quarantine_crypto_request(
            &raw_crypto_row_id(&path),
            communicator_matrix_gateway::store_types::ReasonCode::new("crypto_failed")
                .expect("reason"),
        )
        .expect("quarantine fixture");
    assert_code(
        store
            .next_pending_crypto_request(timestamp(1_700_000_003_000))
            .expect_err("quarantine blocks selection"),
        STORE_CRYPTO_NOT_READY,
    );

    let (_directory, path, mut store, first, _second) = setup_two_fetched_rows();
    let first_request = request_with_body(b"sdk-request-id-multiple-one", &body);
    store
        .record_sdk_processing(&first, std::slice::from_ref(&first_request))
        .expect("record first unresolved fixture");
    drop_unresolved_crypto_index(&path);
    let second_body = canonical_json_bytes(&json!({"marker":"second"})).expect("second body");
    insert_pending_crypto_row(&path, &first, b"sdk-request-id-multiple-two", &second_body);
    assert_code(
        store
            .next_pending_crypto_request(timestamp(1_700_000_003_000))
            .expect_err("multiple unresolved rows must fail closed"),
        STORE_CRYPTO_CORRUPT,
    );

    let (_directory, path, mut store, first, _second) = setup_two_fetched_rows();
    let request = request_with_body(b"sdk-request-id-corrupt", &body);
    store
        .record_sdk_processing(&first, std::slice::from_ref(&request))
        .expect("record corrupt fixture");
    mutate_sql(
        &path,
        "UPDATE matrix_crypto_outbox SET request_sha256 = zeroblob(32)",
    );
    assert_code(
        store
            .next_pending_crypto_request(timestamp(1_700_000_003_000))
            .expect_err("corrupt unresolved row must fail closed"),
        STORE_CRYPTO_CORRUPT,
    );
}

#[test]
fn next_pending_rejects_maintenance_corrupt_chain_or_parent_mismatch() {
    let (_directory, path, mut store, first, _second) = setup_two_fetched_rows();
    let body = canonical_keys_query();
    let request = request_with_body(b"sdk-request-id-maintenance", &body);
    store
        .record_sdk_processing(&first, std::slice::from_ref(&request))
        .expect("record maintenance fixture");
    mutate_sql(
        &path,
        "UPDATE gateway_state
         SET maintenance_code = 'crypto_maintenance_required',
             maintenance_since = '2026-01-01T00:00:00.000Z'",
    );
    assert_code(
        store
            .next_pending_crypto_request(timestamp(1_700_000_003_000))
            .expect_err("maintenance blocks selection"),
        STORE_CRYPTO_NOT_READY,
    );

    let (_directory, path, mut store, first, _second) = setup_two_fetched_rows();
    let request = request_with_body(b"sdk-request-id-chain", &body);
    store
        .record_sdk_processing(&first, std::slice::from_ref(&request))
        .expect("record chain fixture");
    mutate_sql(
        &path,
        "UPDATE sync_inbox SET response_sha256 = zeroblob(32)",
    );
    assert_code(
        store
            .next_pending_crypto_request(timestamp(1_700_000_003_000))
            .expect_err("corrupt inbox chain must fail closed"),
        STORE_CRYPTO_CORRUPT,
    );

    let (_directory, path, mut store, first, _second) = setup_two_fetched_rows();
    let request = request_with_body(b"sdk-request-id-parent", &body);
    store
        .record_sdk_processing(&first, std::slice::from_ref(&request))
        .expect("record parent fixture");
    mutate_sql(
        &path,
        "UPDATE sync_inbox SET state = 'fetched', sdk_processed_at = NULL",
    );
    assert_code(
        store
            .next_pending_crypto_request(timestamp(1_700_000_003_000))
            .expect_err("parent mismatch must fail closed"),
        STORE_CRYPTO_CORRUPT,
    );
}

#[test]
fn record_attempt_leases_exact_row_before_send_and_changes_only_retry_fields() {
    let (_directory, path, mut store, first, _second) = setup_two_fetched_rows();
    let body = canonical_keys_query();
    let request = request_with_body(b"sdk-request-id-lease", &body);
    store
        .record_sdk_processing(&first, std::slice::from_ref(&request))
        .expect("record lease fixture");
    let row_id = raw_crypto_row_id(&path);
    let before = raw_snapshot(&path);
    let selected = store
        .next_pending_crypto_request(timestamp(1_700_000_001_000))
        .expect("select lease fixture")
        .expect("lease fixture exists");
    store
        .record_attempt(
            &row_id,
            selected.attempt_count(),
            selected.next_attempt_at(),
            timestamp(1_700_000_001_000),
            timestamp(1_700_000_002_000),
        )
        .expect("record durable lease");
    let after = raw_snapshot(&path);
    assert_eq!(after.gateway, before.gateway);
    assert_eq!(after.inbox, before.inbox);
    assert_eq!(after.crypto[0][..17], before.crypto[0][..17]);
    assert_eq!(after.crypto[0][19..], before.crypto[0][19..]);
    assert_eq!(after.crypto[0][17], Value::Integer(1));
    assert_eq!(
        after.crypto[0][18],
        Value::Text(timestamp(1_700_000_002_000).to_rfc3339())
    );
}

#[test]
fn record_attempt_compare_and_swap_allows_exactly_one_of_two_stale_leases() {
    let (_directory, path, mut store, first, _second) = setup_two_fetched_rows();
    let body = canonical_keys_query();
    let request = request_with_body(b"sdk-request-id-cas", &body);
    store
        .record_sdk_processing(&first, std::slice::from_ref(&request))
        .expect("record CAS fixture");
    let row_id = raw_crypto_row_id(&path);
    let selected = store
        .next_pending_crypto_request(timestamp(1_700_000_001_000))
        .expect("select CAS fixture")
        .expect("CAS fixture exists");
    store
        .record_attempt(
            &row_id,
            selected.attempt_count(),
            selected.next_attempt_at(),
            timestamp(1_700_000_001_000),
            timestamp(1_700_000_002_000),
        )
        .expect("first stale lease wins");
    let before_loser = raw_snapshot(&path);
    assert_code(
        store
            .record_attempt(
                &row_id,
                selected.attempt_count(),
                selected.next_attempt_at(),
                timestamp(1_700_000_001_000),
                timestamp(1_700_000_002_000),
            )
            .expect_err("second stale lease loses CAS"),
        STORE_CRYPTO_CONFLICT,
    );
    assert_snapshot_unchanged(&raw_snapshot(&path), &before_loser);
}

#[test]
fn record_attempt_rejects_future_invalid_time_wrong_row_wrong_state_maintenance_and_overflow() {
    let (_directory, path, mut store, first, _second) = setup_two_fetched_rows();
    let body = canonical_keys_query();
    let request = request_with_body(b"sdk-request-id-reject", &body);
    store
        .record_sdk_processing(&first, std::slice::from_ref(&request))
        .expect("record rejection fixture");
    let row_id = raw_crypto_row_id(&path);
    let expected = timestamp(1_700_000_001_000);
    let now = timestamp(1_700_000_001_000);
    assert_code(
        store
            .record_attempt(&row_id, 0, expected, now, timestamp(1_700_000_000_000))
            .expect_err("nonfuture next time"),
        STORE_CRYPTO_INVALID,
    );
    assert_code(
        store
            .record_attempt(
                &row_id,
                0,
                expected,
                timestamp(1_700_000_000_000),
                timestamp(1_700_000_002_000),
            )
            .expect_err("future stored row"),
        STORE_CRYPTO_NOT_READY,
    );
    assert_code(
        store
            .record_attempt(
                "not-a-crypto-row",
                0,
                expected,
                now,
                timestamp(1_700_000_002_000),
            )
            .expect_err("invalid row shape"),
        STORE_CRYPTO_INVALID,
    );
    let wrong_row = format!("crypto_{}", "f".repeat(64));
    assert_code(
        store
            .record_attempt(&wrong_row, 0, expected, now, timestamp(1_700_000_002_000))
            .expect_err("wrong row"),
        STORE_CRYPTO_NOT_READY,
    );

    let (_directory, path, mut store, first, _second) = setup_two_fetched_rows();
    let request = request_with_body(b"sdk-request-id-wrong-state", &body);
    store
        .record_sdk_processing(&first, std::slice::from_ref(&request))
        .expect("record wrong-state fixture");
    let row_id = raw_crypto_row_id(&path);
    store
        .record_attempt(&row_id, 0, expected, now, timestamp(1_700_000_002_000))
        .expect("lease wrong-state fixture");
    let response = RawMatrixResponse::keys_query(br#"{"response":true}"#.to_vec())
        .expect("wrong-state response");
    store
        .record_crypto_response(&row_id, &response)
        .expect("record wrong-state response");
    store
        .complete_crypto_request(&row_id, timestamp(1_700_000_003_000))
        .expect("complete wrong-state fixture");
    assert_code(
        store
            .record_attempt(
                &row_id,
                1,
                timestamp(1_700_000_002_000),
                timestamp(1_700_000_003_000),
                timestamp(1_700_000_004_000),
            )
            .expect_err("wrong lifecycle state"),
        STORE_CRYPTO_NOT_READY,
    );

    let (_directory, path, mut store, first, _second) = setup_two_fetched_rows();
    let request = request_with_body(b"sdk-request-id-maintenance-attempt", &body);
    store
        .record_sdk_processing(&first, std::slice::from_ref(&request))
        .expect("record maintenance attempt fixture");
    let row_id = raw_crypto_row_id(&path);
    mutate_sql(
        &path,
        "UPDATE gateway_state
         SET maintenance_code = 'crypto_maintenance_required',
             maintenance_since = '2026-01-01T00:00:00.000Z'",
    );
    assert_code(
        store
            .record_attempt(&row_id, 0, expected, now, timestamp(1_700_000_002_000))
            .expect_err("maintenance blocks attempt"),
        STORE_CRYPTO_NOT_READY,
    );

    let (_directory, path, mut store, first, _second) = setup_two_fetched_rows();
    let request = request_with_body(b"sdk-request-id-overflow", &body);
    store
        .record_sdk_processing(&first, std::slice::from_ref(&request))
        .expect("record overflow fixture");
    let row_id = raw_crypto_row_id(&path);
    mutate_sql(
        &path,
        "UPDATE matrix_crypto_outbox SET attempt_count = 1000000",
    );
    assert_code(
        store
            .record_attempt(
                &row_id,
                1_000_000,
                expected,
                now,
                timestamp(1_700_000_002_000),
            )
            .expect_err("attempt count overflow"),
        STORE_CRYPTO_NOT_READY,
    );
}

#[test]
fn record_attempt_failure_rolls_back_every_table_and_column() {
    let (_directory, path, mut store, first, _second) = setup_two_fetched_rows();
    let body = canonical_keys_query();
    let request = request_with_body(b"sdk-request-id-rollback", &body);
    store
        .record_sdk_processing(&first, std::slice::from_ref(&request))
        .expect("record rollback fixture");
    let row_id = raw_crypto_row_id(&path);
    let trigger_connection = Connection::open(&path).expect("open trigger connection");
    trigger_connection
        .execute_batch(
            "CREATE TRIGGER fail_crypto_attempt
             BEFORE UPDATE OF attempt_count ON matrix_crypto_outbox
             BEGIN SELECT RAISE(ABORT, 'crypto_attempt_abort_fixture'); END;",
        )
        .expect("install attempt trigger");
    drop(trigger_connection);
    let before = raw_snapshot(&path);
    assert_code(
        store
            .record_attempt(
                &row_id,
                0,
                timestamp(1_700_000_001_000),
                timestamp(1_700_000_001_000),
                timestamp(1_700_000_002_000),
            )
            .expect_err("trigger aborts attempt"),
        STORE_CRYPTO_CORRUPT,
    );
    assert_snapshot_unchanged(&raw_snapshot(&path), &before);
}

#[test]
fn pending_request_plaintext_never_appears_in_debug_display_or_safe_errors() {
    let (_directory, path, mut store, first, _second) = setup_two_fetched_rows();
    let sdk_canary = b"sdk-pending-privacy-canary";
    let body = canonical_json_bytes(&json!({"canary":"pending-request-privacy-canary"}))
        .expect("privacy request body");
    let request = request_with_body(sdk_canary, &body);
    store
        .record_sdk_processing(&first, std::slice::from_ref(&request))
        .expect("record privacy fixture");
    let selected = store
        .next_pending_crypto_request(timestamp(1_700_000_001_000))
        .expect("select privacy fixture")
        .expect("privacy fixture exists");
    let debug = format!("{selected:?}");
    let display = format!("{selected}");
    assert_eq!(debug, "PendingMatrixRequest([REDACTED])");
    assert_eq!(display, "PendingMatrixRequest([REDACTED])");
    assert!(!debug.contains("pending-request-privacy-canary"));
    assert!(!display.contains("sdk-pending-privacy-canary"));
    let error = store
        .record_attempt(
            &raw_crypto_row_id(&path),
            0,
            timestamp(1_700_000_001_000),
            timestamp(1_700_000_001_000),
            timestamp(1_700_000_000_000),
        )
        .expect_err("invalid attempt input");
    assert_eq!(error.code(), STORE_CRYPTO_INVALID);
    assert!(!error.to_string().contains("privacy"));
    assert!(!format!("{error:?}").contains("privacy"));
}

#[test]
fn record_response_encrypts_exact_bytes_and_transitions_atomically() {
    let (_directory, path, mut store, first, _second) = setup_two_fetched_rows();
    let body = canonical_keys_query();
    let request = request_with_body(b"sdk-request-id-response-happy", &body);
    store
        .record_sdk_processing(&first, std::slice::from_ref(&request))
        .expect("record response request");
    let row_id = raw_crypto_row_id(&path);
    let selected = store
        .next_pending_crypto_request(timestamp(1_700_000_001_000))
        .expect("select response request")
        .expect("response request exists");
    store
        .record_attempt(
            &row_id,
            selected.attempt_count(),
            selected.next_attempt_at(),
            timestamp(1_700_000_001_000),
            timestamp(1_700_000_002_000),
        )
        .expect("lease response request");

    let exact_body = br#"{ "z": 1, "a": [2, 3] }"#.to_vec();
    let response = RawMatrixResponse::keys_query(exact_body.clone()).expect("exact response");
    let before = raw_snapshot(&path);
    store
        .record_crypto_response(&row_id, &response)
        .expect("persist exact response");
    let after = raw_snapshot(&path);
    assert_eq!(after.gateway, before.gateway);
    assert_eq!(after.inbox, before.inbox);
    let row = raw_crypto_row(&path);
    assert_eq!(row.state, "response_received");
    assert_eq!(row.attempt_count, 1);
    assert_eq!(
        row.next_attempt_at,
        timestamp(1_700_000_002_000).to_rfc3339()
    );
    assert!(row.response_cipher.is_some());
    assert!(row.response_nonce.is_some());
    assert_eq!(row.response_key_version, Some(1));
    assert_eq!(
        row.response_sha256,
        Some(Sha256::digest(&exact_body).to_vec())
    );
    assert_eq!(decrypt_crypto_response(&row, &test_keyring()), exact_body);
    assert_ne!(row.response_nonce, Some(row.request_nonce.clone()));
    assert_ne!(row.response_nonce, Some(row.sdk_request_id_nonce.clone()));
    let wrong_field_nonce: [u8; 24] = row
        .response_nonce
        .as_deref()
        .expect("response nonce")
        .try_into()
        .expect("response nonce length");
    let wrong_field = test_keyring().open(
        "matrix_crypto_outbox",
        &row.crypto_row_id,
        "request",
        &Sealed {
            nonce: wrong_field_nonce,
            ciphertext: row
                .response_cipher
                .as_ref()
                .expect("response ciphertext")
                .clone(),
            key_version: 1,
        },
    );
    assert!(
        wrong_field.is_err(),
        "response AAD must bind the response field"
    );
}

#[test]
fn record_response_requires_a_lease_and_exact_retry_never_rewrites() {
    let (_directory, path, mut store, first, _second) = setup_two_fetched_rows();
    let body = canonical_keys_query();
    let request = request_with_body(b"sdk-request-id-response-lease", &body);
    store
        .record_sdk_processing(&first, std::slice::from_ref(&request))
        .expect("record response lease fixture");
    let row_id = raw_crypto_row_id(&path);
    let response =
        RawMatrixResponse::keys_query(br#"{"response":true}"#.to_vec()).expect("response fixture");
    let before = raw_snapshot(&path);
    assert_code(
        store
            .record_crypto_response(&row_id, &response)
            .expect_err("response before a lease"),
        STORE_CRYPTO_NOT_READY,
    );
    assert_snapshot_unchanged(&raw_snapshot(&path), &before);

    store
        .record_attempt(
            &row_id,
            0,
            timestamp(1_700_000_001_000),
            timestamp(1_700_000_001_000),
            timestamp(1_700_000_002_000),
        )
        .expect("lease response fixture");
    store
        .record_crypto_response(&row_id, &response)
        .expect("first response write");
    let after_first = raw_snapshot(&path);
    store
        .record_crypto_response(&row_id, &response)
        .expect("exact response retry");
    assert_snapshot_unchanged(&raw_snapshot(&path), &after_first);
}

#[test]
fn record_response_rejects_corrupt_companions_before_transition_with_full_snapshot_unchanged() {
    let (_directory, path, mut store, first, _second) = setup_two_fetched_rows();
    let body = canonical_keys_query();
    let request = request_with_body(b"sdk-request-id-corrupt-response-companions", &body);
    store
        .record_sdk_processing(&first, std::slice::from_ref(&request))
        .expect("record corrupt companion fixture");
    let row_id = raw_crypto_row_id(&path);
    store
        .record_attempt(
            &row_id,
            0,
            timestamp(1_700_000_001_000),
            timestamp(1_700_000_001_000),
            timestamp(1_700_000_002_000),
        )
        .expect("lease corrupt companion fixture");

    mutate_sql(
        &path,
        "UPDATE matrix_crypto_outbox
         SET response_cipher = zeroblob(67108880), response_nonce = zeroblob(23),
             response_key_version = 1, response_sha256 = zeroblob(32)",
    );
    let before = raw_snapshot(&path);
    let response =
        RawMatrixResponse::keys_query(br#"{"response":true}"#.to_vec()).expect("response fixture");
    assert_code(
        store
            .record_crypto_response(&row_id, &response)
            .expect_err("corrupt response companions fail closed"),
        STORE_CRYPTO_CORRUPT,
    );
    assert_snapshot_unchanged(&raw_snapshot(&path), &before);
}

#[test]
fn record_response_rejects_conflict_corruption_wrong_state_parent_or_maintenance() {
    let (_directory, path, mut store, first, _second) = setup_two_fetched_rows();
    let body = canonical_keys_query();
    let request = request_with_body(b"sdk-request-id-response-conflict", &body);
    store
        .record_sdk_processing(&first, std::slice::from_ref(&request))
        .expect("record response conflict fixture");
    let row_id = raw_crypto_row_id(&path);
    store
        .record_attempt(
            &row_id,
            0,
            timestamp(1_700_000_001_000),
            timestamp(1_700_000_001_000),
            timestamp(1_700_000_002_000),
        )
        .expect("lease response conflict fixture");
    let response =
        RawMatrixResponse::keys_query(br#"{"response":true}"#.to_vec()).expect("response fixture");
    store
        .record_crypto_response(&row_id, &response)
        .expect("record first response");
    let before = raw_snapshot(&path);
    let different = RawMatrixResponse::keys_query(br#"{"response":false}"#.to_vec())
        .expect("different response fixture");
    assert_code(
        store
            .record_crypto_response(&row_id, &different)
            .expect_err("different response conflicts"),
        STORE_CRYPTO_CONFLICT,
    );
    assert_snapshot_unchanged(&raw_snapshot(&path), &before);

    let (_directory, path, mut store, first, _second) = setup_two_fetched_rows();
    let request = request_with_body(b"sdk-request-id-response-corrupt", &body);
    store
        .record_sdk_processing(&first, std::slice::from_ref(&request))
        .expect("record response corruption fixture");
    let row_id = raw_crypto_row_id(&path);
    store
        .record_attempt(
            &row_id,
            0,
            timestamp(1_700_000_001_000),
            timestamp(1_700_000_001_000),
            timestamp(1_700_000_002_000),
        )
        .expect("lease response corruption fixture");
    mutate_sql(
        &path,
        "UPDATE matrix_crypto_outbox SET request_nonce = zeroblob(24)",
    );
    assert_code(
        store
            .record_crypto_response(&row_id, &response)
            .expect_err("corrupt request row"),
        STORE_CRYPTO_CORRUPT,
    );

    let (_directory, path, mut store, first, _second) = setup_two_fetched_rows();
    let request = request_with_body(b"sdk-request-id-response-parent", &body);
    store
        .record_sdk_processing(&first, std::slice::from_ref(&request))
        .expect("record response parent fixture");
    let row_id = raw_crypto_row_id(&path);
    store
        .record_attempt(
            &row_id,
            0,
            timestamp(1_700_000_001_000),
            timestamp(1_700_000_001_000),
            timestamp(1_700_000_002_000),
        )
        .expect("lease response parent fixture");
    mutate_sql(
        &path,
        "UPDATE sync_inbox SET state = 'fetched', sdk_processed_at = NULL",
    );
    assert_code(
        store
            .record_crypto_response(&row_id, &response)
            .expect_err("parent lifecycle mismatch"),
        STORE_CRYPTO_CORRUPT,
    );

    let (_directory, path, mut store, first, _second) = setup_two_fetched_rows();
    let request = request_with_body(b"sdk-request-id-response-maintenance", &body);
    store
        .record_sdk_processing(&first, std::slice::from_ref(&request))
        .expect("record response maintenance fixture");
    let row_id = raw_crypto_row_id(&path);
    store
        .record_attempt(
            &row_id,
            0,
            timestamp(1_700_000_001_000),
            timestamp(1_700_000_001_000),
            timestamp(1_700_000_002_000),
        )
        .expect("lease response maintenance fixture");
    mutate_sql(
        &path,
        "UPDATE gateway_state
         SET maintenance_code = 'crypto_maintenance_required',
             maintenance_since = '2026-01-01T00:00:00.000Z'",
    );
    assert_code(
        store
            .record_crypto_response(&row_id, &response)
            .expect_err("maintenance blocks response"),
        STORE_CRYPTO_NOT_READY,
    );
}

#[test]
fn complete_request_accepts_only_verified_response_and_is_exactly_idempotent() {
    let (_directory, path, mut store, first, _second) = setup_two_fetched_rows();
    let body = canonical_keys_query();
    let request = request_with_body(b"sdk-request-id-complete", &body);
    store
        .record_sdk_processing(&first, std::slice::from_ref(&request))
        .expect("record completion fixture");
    let row_id = raw_crypto_row_id(&path);
    store
        .record_attempt(
            &row_id,
            0,
            timestamp(1_700_000_001_000),
            timestamp(1_700_000_001_000),
            timestamp(1_700_000_002_000),
        )
        .expect("lease completion fixture");
    let response = RawMatrixResponse::keys_query(br#"{"response":"verified"}"#.to_vec())
        .expect("verified response");
    store
        .record_crypto_response(&row_id, &response)
        .expect("record verified response");
    let accepted_at = timestamp(1_700_000_003_000);
    store
        .complete_crypto_request(&row_id, accepted_at)
        .expect("accept verified response");
    let first_accept = raw_snapshot(&path);
    let row = raw_crypto_row(&path);
    assert_eq!(row.state, "accepted");
    assert_eq!(row.accepted_at, Some(accepted_at.to_rfc3339()));
    store
        .complete_crypto_request(&row_id, accepted_at)
        .expect("exact acceptance retry");
    assert_snapshot_unchanged(&raw_snapshot(&path), &first_accept);
}

#[test]
fn complete_request_rejects_early_timestamp_conflict_corruption_and_wrong_state() {
    let (_directory, path, mut store, first, _second) = setup_two_fetched_rows();
    let body = canonical_keys_query();
    let request = request_with_body(b"sdk-request-id-complete-early", &body);
    store
        .record_sdk_processing(&first, std::slice::from_ref(&request))
        .expect("record early completion fixture");
    let row_id = raw_crypto_row_id(&path);
    store
        .record_attempt(
            &row_id,
            0,
            timestamp(1_700_000_001_000),
            timestamp(1_700_000_001_000),
            timestamp(1_700_000_002_000),
        )
        .expect("lease early completion fixture");
    let response =
        RawMatrixResponse::keys_query(br#"{"response":true}"#.to_vec()).expect("response fixture");
    store
        .record_crypto_response(&row_id, &response)
        .expect("record early completion response");
    let before = raw_snapshot(&path);
    assert_code(
        store
            .complete_crypto_request(&row_id, timestamp(1_700_000_000_000))
            .expect_err("acceptance before observation"),
        STORE_CRYPTO_INVALID,
    );
    assert_snapshot_unchanged(&raw_snapshot(&path), &before);

    store
        .complete_crypto_request(&row_id, timestamp(1_700_000_003_000))
        .expect("initial acceptance");
    let before_conflict = raw_snapshot(&path);
    assert_code(
        store
            .complete_crypto_request(&row_id, timestamp(1_700_000_004_000))
            .expect_err("different acceptance timestamp"),
        STORE_CRYPTO_CONFLICT,
    );
    assert_snapshot_unchanged(&raw_snapshot(&path), &before_conflict);

    let (_directory, path, mut store, first, _second) = setup_two_fetched_rows();
    let request = request_with_body(b"sdk-request-id-complete-corrupt", &body);
    store
        .record_sdk_processing(&first, std::slice::from_ref(&request))
        .expect("record corrupt completion fixture");
    let row_id = raw_crypto_row_id(&path);
    store
        .record_attempt(
            &row_id,
            0,
            timestamp(1_700_000_001_000),
            timestamp(1_700_000_001_000),
            timestamp(1_700_000_002_000),
        )
        .expect("lease corrupt completion fixture");
    store
        .record_crypto_response(&row_id, &response)
        .expect("record corrupt completion response");
    mutate_sql(
        &path,
        "UPDATE matrix_crypto_outbox SET response_sha256 = zeroblob(32)",
    );
    let before_corrupt = raw_snapshot(&path);
    assert_code(
        store
            .complete_crypto_request(&row_id, timestamp(1_700_000_003_000))
            .expect_err("corrupt response blocks acceptance"),
        STORE_CRYPTO_CORRUPT,
    );
    assert_snapshot_unchanged(&raw_snapshot(&path), &before_corrupt);

    let (_directory, path, mut store, first, _second) = setup_two_fetched_rows();
    let request = request_with_body(b"sdk-request-id-complete-wrong-state", &body);
    store
        .record_sdk_processing(&first, std::slice::from_ref(&request))
        .expect("record wrong-state completion fixture");
    let row_id = raw_crypto_row_id(&path);
    let before_pending = raw_snapshot(&path);
    assert_code(
        store
            .complete_crypto_request(&row_id, timestamp(1_700_000_003_000))
            .expect_err("pending cannot be accepted"),
        STORE_CRYPTO_NOT_READY,
    );
    assert_snapshot_unchanged(&raw_snapshot(&path), &before_pending);
}

#[test]
fn quarantine_preserves_request_response_retry_fields_and_blocks_progress() {
    let (_directory, path, mut store, first, second) = setup_two_fetched_rows();
    let body = canonical_keys_query();
    let request = request_with_body(b"sdk-request-id-quarantine-response", &body);
    store
        .record_sdk_processing(&first, std::slice::from_ref(&request))
        .expect("record quarantine response fixture");
    let row_id = raw_crypto_row_id(&path);
    store
        .record_attempt(
            &row_id,
            0,
            timestamp(1_700_000_001_000),
            timestamp(1_700_000_001_000),
            timestamp(1_700_000_002_000),
        )
        .expect("lease quarantine response fixture");
    let response = RawMatrixResponse::keys_query(br#"{"response":"quarantine"}"#.to_vec())
        .expect("quarantine response");
    store
        .record_crypto_response(&row_id, &response)
        .expect("record quarantine response");
    let before = raw_snapshot(&path);
    let code = communicator_matrix_gateway::store_types::ReasonCode::new("crypto_failed")
        .expect("quarantine code");
    store
        .quarantine_crypto_request(&row_id, code)
        .expect("quarantine response request");
    let after = raw_snapshot(&path);
    assert_eq!(after.gateway, before.gateway);
    assert_eq!(after.inbox, before.inbox);
    assert_eq!(after.crypto[0][..16], before.crypto[0][..16]);
    assert_eq!(after.crypto[0][17..20], before.crypto[0][17..20]);
    assert_eq!(after.crypto[0][20], Value::Text("crypto_failed".to_owned()));
    assert_eq!(after.crypto[0][16], Value::Text("quarantined".to_owned()));

    let before_progress = raw_snapshot(&path);
    assert_code(
        store
            .record_sdk_processing(&second, &[])
            .expect_err("quarantined head blocks newer progress"),
        STORE_CRYPTO_NOT_READY,
    );
    assert_snapshot_unchanged(&raw_snapshot(&path), &before_progress);
}

#[test]
fn quarantine_is_exactly_idempotent_and_has_no_recovery_transition() {
    let (_directory, path, mut store, first, _second) = setup_two_fetched_rows();
    let body = canonical_keys_query();
    let request = request_with_body(b"sdk-request-id-quarantine-idempotent", &body);
    store
        .record_sdk_processing(&first, std::slice::from_ref(&request))
        .expect("record quarantine idempotency fixture");
    let row_id = raw_crypto_row_id(&path);
    let code = communicator_matrix_gateway::store_types::ReasonCode::new("crypto_failed")
        .expect("quarantine code");
    store
        .quarantine_crypto_request(&row_id, code.clone())
        .expect("quarantine request");
    let before_retry = raw_snapshot(&path);
    store
        .quarantine_crypto_request(&row_id, code)
        .expect("exact quarantine retry");
    assert_snapshot_unchanged(&raw_snapshot(&path), &before_retry);
    let different = communicator_matrix_gateway::store_types::ReasonCode::new("crypto_timeout")
        .expect("different quarantine code");
    assert_code(
        store
            .quarantine_crypto_request(&row_id, different)
            .expect_err("different quarantine code conflicts"),
        STORE_CRYPTO_CONFLICT,
    );
    assert_snapshot_unchanged(&raw_snapshot(&path), &before_retry);
    assert_code(
        store
            .record_attempt(
                &row_id,
                0,
                timestamp(1_700_000_001_000),
                timestamp(1_700_000_001_000),
                timestamp(1_700_000_002_000),
            )
            .expect_err("quarantined request cannot recover"),
        STORE_CRYPTO_NOT_READY,
    );
    assert_snapshot_unchanged(&raw_snapshot(&path), &before_retry);
}

#[test]
fn response_acceptance_and_quarantine_failures_roll_back_every_table_and_column() {
    let body = canonical_keys_query();

    let (_directory, path, mut store, first, _second) = setup_two_fetched_rows();
    let request = request_with_body(b"sdk-request-id-response-rollback", &body);
    store
        .record_sdk_processing(&first, std::slice::from_ref(&request))
        .expect("record response rollback fixture");
    let row_id = raw_crypto_row_id(&path);
    store
        .record_attempt(
            &row_id,
            0,
            timestamp(1_700_000_001_000),
            timestamp(1_700_000_001_000),
            timestamp(1_700_000_002_000),
        )
        .expect("lease response rollback fixture");
    let response = RawMatrixResponse::keys_query(br#"{"response":true}"#.to_vec())
        .expect("response rollback body");
    let trigger_connection = Connection::open(&path).expect("open response trigger connection");
    trigger_connection
        .execute_batch(
            "CREATE TRIGGER fail_crypto_response
             BEFORE UPDATE OF response_cipher ON matrix_crypto_outbox
             BEGIN SELECT RAISE(ABORT, 'crypto_response_abort_fixture'); END;",
        )
        .expect("install response trigger");
    drop(trigger_connection);
    let before = raw_snapshot(&path);
    assert_code(
        store
            .record_crypto_response(&row_id, &response)
            .expect_err("response trigger aborts transaction"),
        STORE_CRYPTO_CORRUPT,
    );
    assert_snapshot_unchanged(&raw_snapshot(&path), &before);

    let (_directory, path, mut store, first, _second) = setup_two_fetched_rows();
    let request = request_with_body(b"sdk-request-id-complete-rollback", &body);
    store
        .record_sdk_processing(&first, std::slice::from_ref(&request))
        .expect("record completion rollback fixture");
    let row_id = raw_crypto_row_id(&path);
    store
        .record_attempt(
            &row_id,
            0,
            timestamp(1_700_000_001_000),
            timestamp(1_700_000_001_000),
            timestamp(1_700_000_002_000),
        )
        .expect("lease completion rollback fixture");
    store
        .record_crypto_response(&row_id, &response)
        .expect("record completion rollback response");
    let trigger_connection = Connection::open(&path).expect("open completion trigger connection");
    trigger_connection
        .execute_batch(
            "CREATE TRIGGER fail_crypto_complete
             BEFORE UPDATE OF accepted_at ON matrix_crypto_outbox
             BEGIN SELECT RAISE(ABORT, 'crypto_complete_abort_fixture'); END;",
        )
        .expect("install completion trigger");
    drop(trigger_connection);
    let before = raw_snapshot(&path);
    assert_code(
        store
            .complete_crypto_request(&row_id, timestamp(1_700_000_003_000))
            .expect_err("completion trigger aborts transaction"),
        STORE_CRYPTO_CORRUPT,
    );
    assert_snapshot_unchanged(&raw_snapshot(&path), &before);

    let (_directory, path, mut store, first, _second) = setup_two_fetched_rows();
    let request = request_with_body(b"sdk-request-id-quarantine-rollback", &body);
    store
        .record_sdk_processing(&first, std::slice::from_ref(&request))
        .expect("record quarantine rollback fixture");
    let row_id = raw_crypto_row_id(&path);
    let trigger_connection = Connection::open(&path).expect("open quarantine trigger connection");
    trigger_connection
        .execute_batch(
            "CREATE TRIGGER fail_crypto_quarantine
             BEFORE UPDATE OF terminal_code ON matrix_crypto_outbox
             BEGIN SELECT RAISE(ABORT, 'crypto_quarantine_abort_fixture'); END;",
        )
        .expect("install quarantine trigger");
    drop(trigger_connection);
    let before = raw_snapshot(&path);
    let code = communicator_matrix_gateway::store_types::ReasonCode::new("crypto_failed")
        .expect("quarantine rollback code");
    assert_code(
        store
            .quarantine_crypto_request(&row_id, code)
            .expect_err("quarantine trigger aborts transaction"),
        STORE_CRYPTO_CORRUPT,
    );
    assert_snapshot_unchanged(&raw_snapshot(&path), &before);
}

#[test]
fn response_plaintext_is_absent_from_database_wal_and_shm_while_open() {
    let (_directory, path, mut store, first, _second) = setup_two_fetched_rows();
    let body = canonical_keys_query();
    let request = request_with_body(b"sdk-request-id-response-privacy", &body);
    store
        .record_sdk_processing(&first, std::slice::from_ref(&request))
        .expect("record response privacy fixture");
    let row_id = raw_crypto_row_id(&path);
    store
        .record_attempt(
            &row_id,
            0,
            timestamp(1_700_000_001_000),
            timestamp(1_700_000_001_000),
            timestamp(1_700_000_002_000),
        )
        .expect("lease response privacy fixture");
    let marker = b"response-plaintext-privacy-canary-6e0f8a3e";
    let body = format!(r#"{{"marker":"{}"}}"#, String::from_utf8_lossy(marker)).into_bytes();
    let response = RawMatrixResponse::keys_query(body).expect("privacy response");
    store
        .record_crypto_response(&row_id, &response)
        .expect("record privacy response");
    assert_storage_excludes(&sqlite_storage_bytes(&path), marker);
}

#[test]
fn all_crypto_lifecycle_states_survive_reopen_and_verify_fail_closed() {
    let body = canonical_keys_query();

    let (_directory, path, mut store, first, _second) = setup_two_fetched_rows();
    let request = request_with_body(b"sdk-request-id-reopen-pending", &body);
    store
        .record_sdk_processing(&first, std::slice::from_ref(&request))
        .expect("record pending reopen fixture");
    let row_id = raw_crypto_row_id(&path);
    let before = raw_snapshot(&path);
    drop(store);
    let reopened = Store::open(&path, test_keyring()).expect("reopen pending store");
    let selected = reopened
        .next_pending_crypto_request(timestamp(1_700_000_001_000))
        .expect("verify pending after reopen")
        .expect("pending after reopen");
    assert_eq!(selected.row_id(), row_id);
    assert_snapshot_unchanged(&raw_snapshot(&path), &before);

    let (_directory, path, mut store, first, _second) = setup_two_fetched_rows();
    let request = request_with_body(b"sdk-request-id-reopen-response", &body);
    store
        .record_sdk_processing(&first, std::slice::from_ref(&request))
        .expect("record response reopen fixture");
    let row_id = raw_crypto_row_id(&path);
    store
        .record_attempt(
            &row_id,
            0,
            timestamp(1_700_000_001_000),
            timestamp(1_700_000_001_000),
            timestamp(1_700_000_002_000),
        )
        .expect("lease response reopen fixture");
    let response = RawMatrixResponse::keys_query(br#"{"response":"reopen"}"#.to_vec())
        .expect("reopen response");
    store
        .record_crypto_response(&row_id, &response)
        .expect("record response reopen fixture");
    let before = raw_snapshot(&path);
    drop(store);
    let mut reopened = Store::open(&path, test_keyring()).expect("reopen response store");
    reopened
        .record_crypto_response(&row_id, &response)
        .expect("exact response retry after reopen");
    assert_snapshot_unchanged(&raw_snapshot(&path), &before);

    let (_directory, path, mut store, first, _second) = setup_two_fetched_rows();
    let request = request_with_body(b"sdk-request-id-reopen-accepted", &body);
    store
        .record_sdk_processing(&first, std::slice::from_ref(&request))
        .expect("record accepted reopen fixture");
    let row_id = raw_crypto_row_id(&path);
    store
        .record_attempt(
            &row_id,
            0,
            timestamp(1_700_000_001_000),
            timestamp(1_700_000_001_000),
            timestamp(1_700_000_002_000),
        )
        .expect("lease accepted reopen fixture");
    let response = RawMatrixResponse::keys_query(br#"{"response":"accepted"}"#.to_vec())
        .expect("accepted response");
    store
        .record_crypto_response(&row_id, &response)
        .expect("record accepted response");
    let accepted_at = timestamp(1_700_000_003_000);
    store
        .complete_crypto_request(&row_id, accepted_at)
        .expect("accept reopen fixture");
    let before = raw_snapshot(&path);
    drop(store);
    let mut reopened = Store::open(&path, test_keyring()).expect("reopen accepted store");
    reopened
        .complete_crypto_request(&row_id, accepted_at)
        .expect("exact accepted retry after reopen");
    assert_snapshot_unchanged(&raw_snapshot(&path), &before);

    let (_directory, path, mut store, first, _second) = setup_two_fetched_rows();
    let request = request_with_body(b"sdk-request-id-reopen-quarantine", &body);
    store
        .record_sdk_processing(&first, std::slice::from_ref(&request))
        .expect("record quarantine reopen fixture");
    let row_id = raw_crypto_row_id(&path);
    let code = communicator_matrix_gateway::store_types::ReasonCode::new("crypto_failed")
        .expect("reopen quarantine code");
    store
        .quarantine_crypto_request(&row_id, code.clone())
        .expect("quarantine reopen fixture");
    let before = raw_snapshot(&path);
    drop(store);
    let mut reopened = Store::open(&path, test_keyring()).expect("reopen quarantined store");
    reopened
        .quarantine_crypto_request(&row_id, code)
        .expect("exact quarantine retry after reopen");
    assert_snapshot_unchanged(&raw_snapshot(&path), &before);
}
