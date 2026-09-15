use std::{fs, os::unix::fs::PermissionsExt, path::PathBuf};

use chrono::{DateTime, Duration, TimeZone, Utc};
use communicator_matrix_gateway::{
    crypto::Keyring,
    crypto_outbox::{ExactMatrixRequest, RawMatrixResponse},
    store::{
        STORE_CRYPTO_CONFLICT, STORE_CRYPTO_CORRUPT, STORE_CRYPTO_INVALID, STORE_CRYPTO_NOT_READY,
        Store,
    },
    store_types::{NewBootstrapState, NewRawSyncInbox, ReasonCode},
};
use rusqlite::{Connection, params, types::Value};
use sha2::{Digest, Sha256};
use tempfile::{TempDir, tempdir};

fn timestamp(milliseconds: i64) -> DateTime<Utc> {
    Utc.timestamp_millis_opt(milliseconds)
        .single()
        .expect("construct test timestamp")
}

fn secure_store() -> (TempDir, PathBuf, Store, String) {
    let directory = tempdir().expect("create temporary state directory");
    fs::set_permissions(directory.path(), fs::Permissions::from_mode(0o700))
        .expect("secure temporary state directory");
    let path = directory.path().join("gateway.sqlite3");
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
    let inbox_id = store
        .append_fetched_sync(
            NewRawSyncInbox::new(
                b"initial".to_vec(),
                b"next-1".to_vec(),
                b"sync response".to_vec(),
                timestamp(1_700_000_001_000),
            )
            .expect("construct sync response"),
        )
        .expect("append sync response")
        .as_str()
        .to_owned();
    (directory, path, store, inbox_id)
}

fn secure_store_with_two_rows() -> (TempDir, PathBuf, Store, String, String) {
    let (directory, path, mut store, first) = secure_store();
    let second = store
        .append_fetched_sync(
            NewRawSyncInbox::new(
                b"next-1".to_vec(),
                b"next-2".to_vec(),
                b"second sync response".to_vec(),
                timestamp(1_700_000_002_000),
            )
            .expect("construct second sync response"),
        )
        .expect("append second sync response")
        .as_str()
        .to_owned();
    (directory, path, store, first, second)
}

fn test_keyring() -> Keyring {
    Keyring::new([0x11; 32], 1).expect("construct fixed test keyring")
}

fn canonical_request() -> Vec<u8> {
    br#"{"device_keys":{}}"#.to_vec()
}

fn request_with_id(id: &[u8]) -> ExactMatrixRequest {
    ExactMatrixRequest::keys_query(id.to_vec(), canonical_request())
        .expect("construct crypto request")
}

fn raw_crypto_row_id(path: &std::path::Path) -> String {
    Connection::open(path)
        .expect("open crypto snapshot database")
        .query_row(
            "SELECT crypto_row_id FROM matrix_crypto_outbox ORDER BY rowid LIMIT 1",
            [],
            |row| row.get(0),
        )
        .expect("read crypto row ID")
}

fn query_values(connection: &Connection, sql: &str, columns: usize) -> Vec<Vec<Value>> {
    let mut statement = connection.prepare(sql).expect("prepare snapshot query");
    statement
        .query_map([], |row| {
            (0..columns)
                .map(|index| row.get(index))
                .collect::<Result<Vec<Value>, _>>()
        })
        .expect("query snapshot rows")
        .collect::<Result<Vec<_>, _>>()
        .expect("read snapshot rows")
}

#[derive(Clone, PartialEq)]
struct RawSnapshot {
    gateway: Vec<Vec<Value>>,
    inbox: Vec<Vec<Value>>,
    crypto: Vec<Vec<Value>>,
}

fn raw_snapshot(path: &std::path::Path) -> RawSnapshot {
    let connection = Connection::open(path).expect("open snapshot database");
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

fn mutate_sql(path: &std::path::Path, sql: &str) {
    let connection = Connection::open(path).expect("open mutation database");
    connection
        .execute("PRAGMA ignore_check_constraints = ON", [])
        .expect("enable fixture constraint bypass");
    connection.execute(sql, []).expect("apply fixture mutation");
}

fn drop_unresolved_index(path: &std::path::Path) {
    let connection = Connection::open(path).expect("open crypto index fixture");
    connection
        .execute("DROP INDEX one_unresolved_crypto_request", [])
        .expect("drop crypto unresolved index fixture");
}

fn crypto_lookup(body: &[u8]) -> [u8; 32] {
    let body = std::str::from_utf8(body).expect("canonical request fixture");
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
                .expect("frame fixture value")
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

fn insert_pending_crypto_row(path: &std::path::Path, inbox_id: &str, sdk_request_id: &[u8]) {
    let body = canonical_request();
    let request_lookup = crypto_lookup(&body);
    let row_id = crypto_row_id(inbox_id, &request_lookup);
    let keyring = test_keyring();
    let sdk_sealed = keyring
        .seal(
            "matrix_crypto_outbox",
            &row_id,
            "sdk_request_id",
            sdk_request_id,
        )
        .expect("seal SDK request ID fixture");
    let request_sealed = keyring
        .seal("matrix_crypto_outbox", &row_id, "request", &body)
        .expect("seal request fixture");
    let connection = Connection::open(path).expect("open pending-row fixture");
    connection
        .execute(
            "INSERT INTO matrix_crypto_outbox
             (crypto_row_id, inbox_id, request_lookup, request_kind,
              sdk_request_id_cipher, sdk_request_id_nonce, sdk_request_id_key_version,
              request_cipher, request_nonce, request_key_version, request_sha256,
              byte_count, response_cipher, response_nonce, response_key_version,
              response_sha256, state, attempt_count, next_attempt_at, accepted_at, terminal_code)
             SELECT ?1, ?2, ?3, 'keys_query', ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11,
                    NULL, NULL, NULL, NULL, 'pending', 0, observed_at, NULL, NULL
             FROM sync_inbox WHERE inbox_id = ?2",
            params![
                row_id,
                inbox_id,
                request_lookup.as_slice(),
                sdk_sealed.ciphertext,
                sdk_sealed.nonce.as_slice(),
                i64::from(sdk_sealed.key_version),
                request_sealed.ciphertext,
                request_sealed.nonce.as_slice(),
                i64::from(request_sealed.key_version),
                Sha256::digest(&body).as_slice(),
                i64::try_from(body.len()).expect("request length"),
            ],
        )
        .expect("insert pending-row fixture");
}

fn data_version(connection: &Connection) -> i64 {
    connection
        .query_row("PRAGMA data_version", [], |row| row.get(0))
        .expect("read data version")
}

fn record_response_received(store: &mut Store, path: &std::path::Path, id: &[u8]) -> String {
    let request = request_with_id(id);
    let inbox_id = Connection::open(path)
        .expect("open inbox lookup database")
        .query_row(
            "SELECT inbox_id FROM sync_inbox ORDER BY rowid LIMIT 1",
            [],
            |row| row.get::<_, String>(0),
        )
        .expect("read inbox ID");
    store
        .record_sdk_processing(&inbox_id, std::slice::from_ref(&request))
        .expect("record crypto request");
    let row_id = raw_crypto_row_id(path);
    store
        .record_attempt(
            &row_id,
            0,
            timestamp(1_700_000_001_000),
            timestamp(1_700_000_001_000),
            timestamp(1_700_000_002_000),
        )
        .expect("lease crypto request");
    store
        .record_crypto_response(
            &row_id,
            &RawMatrixResponse::keys_query(br#"{"response":"saved"}"#.to_vec())
                .expect("construct crypto response"),
        )
        .expect("record crypto response");
    row_id
}

fn assert_code(error: communicator_matrix_gateway::secret::SafeError, code: &str) {
    assert_eq!(error.code(), code);
    assert_eq!(error.to_string(), code);
}

#[test]
fn recovery_dtos_are_redacted_and_closed() {
    let (_directory, _path, mut store, inbox_id) = secure_store();
    let request = ExactMatrixRequest::keys_query(b"sdk-request-id".to_vec(), canonical_request())
        .expect("construct crypto request");
    store
        .record_sdk_processing(&inbox_id, std::slice::from_ref(&request))
        .expect("record crypto request");
    let row_id = store
        .next_pending_crypto_request(timestamp(1_700_000_001_000))
        .expect("select crypto request")
        .expect("pending crypto request")
        .row_id()
        .to_owned();
    store
        .record_attempt(
            &row_id,
            0,
            timestamp(1_700_000_001_000),
            timestamp(1_700_000_001_000),
            timestamp(1_700_000_002_000),
        )
        .expect("lease crypto request");
    store
        .record_crypto_response(
            &row_id,
            &RawMatrixResponse::keys_query(br#"{"one":1}"#.to_vec())
                .expect("construct crypto response"),
        )
        .expect("record crypto response");

    let saved = store
        .saved_crypto_response()
        .expect("load saved crypto response")
        .expect("saved response");
    assert_eq!(format!("{saved:?}"), "SavedMatrixResponse([REDACTED])");
    assert_eq!(format!("{saved}"), "SavedMatrixResponse([REDACTED])");

    store
        .set_crypto_maintenance(
            ReasonCode::new("crypto_maintenance_required").expect("maintenance code"),
            timestamp(1_700_000_003_000),
        )
        .expect("set maintenance");
    let status = store
        .crypto_maintenance_status()
        .expect("load maintenance status")
        .expect("maintenance status");
    assert_eq!(format!("{status:?}"), "CryptoMaintenanceStatus([REDACTED])");
    assert_eq!(format!("{status}"), "CryptoMaintenanceStatus([REDACTED])");
}

#[test]
fn saved_response_is_exact_authenticated_read_only_and_survives_reopen() {
    let (_directory, path, mut store, _first, _second) = secure_store_with_two_rows();
    let row_id = record_response_received(&mut store, &path, b"saved-response");
    let response_body = br#"{"response":"saved"}"#;
    let request_body = canonical_request();
    let expected_request_sha256: [u8; 32] = Sha256::digest(&request_body).into();
    let expected_response_sha256: [u8; 32] = Sha256::digest(response_body).into();
    let inspector = Connection::open(&path).expect("open read-only inspector");
    let before = raw_snapshot(&path);
    let before_version = data_version(&inspector);

    let saved = store
        .saved_crypto_response()
        .expect("load saved response")
        .expect("response is saved");
    assert_eq!(saved.row_id(), row_id);
    assert_eq!(saved.request_sha256(), &expected_request_sha256);
    assert_eq!(saved.response_sha256(), &expected_response_sha256);
    assert_snapshot_unchanged(&raw_snapshot(&path), &before);
    assert_eq!(data_version(&inspector), before_version);

    drop(store);
    let reopened = Store::open(&path, test_keyring()).expect("reopen saved-response store");
    let reopened_saved = reopened
        .saved_crypto_response()
        .expect("load saved response after reopen")
        .expect("saved response after reopen");
    assert_eq!(reopened_saved.row_id(), row_id);
    assert_eq!(reopened_saved.request_sha256(), &expected_request_sha256);
    assert_eq!(reopened_saved.response_sha256(), &expected_response_sha256);
    assert_snapshot_unchanged(&raw_snapshot(&path), &before);
}

#[test]
fn saved_response_returns_none_when_no_crypto_row_exists() {
    let (_directory, _path, store, _inbox_id) = secure_store();
    assert!(
        store
            .saved_crypto_response()
            .expect("read empty crypto ledger")
            .is_none()
    );
}

#[test]
fn saved_response_returns_none_for_pending_or_accepted_rows() {
    let (_directory, path, mut store, inbox_id) = secure_store();
    let request = request_with_id(b"pending-response");
    store
        .record_sdk_processing(&inbox_id, std::slice::from_ref(&request))
        .expect("record pending request");
    assert!(
        store
            .saved_crypto_response()
            .expect("read pending response")
            .is_none()
    );

    let row_id = raw_crypto_row_id(&path);
    store
        .record_attempt(
            &row_id,
            0,
            timestamp(1_700_000_001_000),
            timestamp(1_700_000_001_000),
            timestamp(1_700_000_002_000),
        )
        .expect("lease pending request");
    let response = RawMatrixResponse::keys_query(br#"{"response":"accepted"}"#.to_vec())
        .expect("construct response");
    store
        .record_crypto_response(&row_id, &response)
        .expect("record accepted-path response");
    store
        .complete_crypto_request(&row_id, timestamp(1_700_000_003_000))
        .expect("accept response");
    assert!(
        store
            .saved_crypto_response()
            .expect("read accepted response")
            .is_none()
    );
}

#[test]
fn saved_response_rejects_maintenance_quarantine_or_multiple_unresolved_rows() {
    let (_directory, path, mut store, inbox_id) = secure_store();
    let request = request_with_id(b"quarantined-response");
    store
        .record_sdk_processing(&inbox_id, std::slice::from_ref(&request))
        .expect("record quarantine request");
    store
        .quarantine_crypto_request(
            &raw_crypto_row_id(&path),
            ReasonCode::new("crypto_failed").expect("quarantine code"),
        )
        .expect("quarantine request");
    assert_code(
        store
            .saved_crypto_response()
            .expect_err("quarantine blocks recovery read"),
        STORE_CRYPTO_NOT_READY,
    );

    let (_directory, path, mut store, first, _second) = secure_store_with_two_rows();
    let request = request_with_id(b"maintenance-response");
    store
        .record_sdk_processing(&first, std::slice::from_ref(&request))
        .expect("record maintenance request");
    mutate_sql(
        &path,
        "UPDATE gateway_state
         SET maintenance_code = 'crypto_maintenance_required',
             maintenance_since = '2026-01-01T00:00:00.000Z'",
    );
    assert_code(
        store
            .saved_crypto_response()
            .expect_err("maintenance blocks recovery read"),
        STORE_CRYPTO_NOT_READY,
    );

    let (_directory, path, mut store, first, second) = secure_store_with_two_rows();
    store
        .record_sdk_processing(&first, &[])
        .expect("process first inbox");
    store
        .record_sdk_processing(&second, &[])
        .expect("process second inbox without request");
    drop_unresolved_index(&path);
    insert_pending_crypto_row(&path, &first, b"multiple-one");
    insert_pending_crypto_row(&path, &second, b"multiple-two");
    assert_code(
        store
            .saved_crypto_response()
            .expect_err("multiple unresolved rows fail closed"),
        STORE_CRYPTO_CORRUPT,
    );
}

#[test]
fn saved_response_rejects_corrupt_gateway_chain_parent_request_or_response() {
    let mutations = [
        (
            "UPDATE gateway_state SET maintenance_since = 'bad'",
            STORE_CRYPTO_CORRUPT,
        ),
        (
            "UPDATE sync_inbox SET response_sha256 = zeroblob(32)",
            STORE_CRYPTO_CORRUPT,
        ),
        (
            "UPDATE sync_inbox SET state = 'fetched', sdk_processed_at = NULL",
            STORE_CRYPTO_CORRUPT,
        ),
        (
            "UPDATE matrix_crypto_outbox SET request_sha256 = zeroblob(32)",
            STORE_CRYPTO_CORRUPT,
        ),
        (
            "UPDATE matrix_crypto_outbox SET response_sha256 = zeroblob(32)",
            STORE_CRYPTO_CORRUPT,
        ),
    ];
    for (mutation, expected) in mutations {
        let (_directory, path, mut store, _first, _second) = secure_store_with_two_rows();
        record_response_received(&mut store, &path, mutation.as_bytes());
        mutate_sql(&path, mutation);
        assert_code(
            store
                .saved_crypto_response()
                .expect_err("corrupt recovery fixture"),
            expected,
        );
    }
}

#[test]
fn saved_response_rejects_wrong_sqlite_types_and_oversized_response_before_copy() {
    let cases = [
        "UPDATE matrix_crypto_outbox SET response_cipher = 'text'",
        "UPDATE matrix_crypto_outbox SET response_nonce = 'text'",
        "UPDATE matrix_crypto_outbox SET response_key_version = 'text'",
        "UPDATE matrix_crypto_outbox SET response_sha256 = 'text'",
    ];
    for mutation in cases {
        let (_directory, path, mut store, _first, _second) = secure_store_with_two_rows();
        record_response_received(&mut store, &path, mutation.as_bytes());
        mutate_sql(&path, mutation);
        assert_code(
            store
                .saved_crypto_response()
                .expect_err("wrong response column type"),
            STORE_CRYPTO_CORRUPT,
        );
    }

    let (_directory, path, mut store, _first, _second) = secure_store_with_two_rows();
    record_response_received(&mut store, &path, b"oversized-response");
    mutate_sql(
        &path,
        "UPDATE matrix_crypto_outbox
         SET response_cipher = zeroblob(67108864 + 17)",
    );
    assert_code(
        store
            .saved_crypto_response()
            .expect_err("oversized response ciphertext"),
        STORE_CRYPTO_CORRUPT,
    );
}

#[test]
fn saved_response_does_not_expose_plaintext_in_debug_display_or_errors() {
    let (_directory, path, mut store, _first, _second) = secure_store_with_two_rows();
    let marker = b"saved-response-redaction-canary";
    let request = request_with_id(b"redaction-response");
    let inbox_id = Connection::open(&path)
        .expect("open redaction database")
        .query_row(
            "SELECT inbox_id FROM sync_inbox ORDER BY rowid LIMIT 1",
            [],
            |row| row.get::<_, String>(0),
        )
        .expect("read redaction inbox");
    store
        .record_sdk_processing(&inbox_id, std::slice::from_ref(&request))
        .expect("record redaction request");
    let row_id = raw_crypto_row_id(&path);
    store
        .record_attempt(
            &row_id,
            0,
            timestamp(1_700_000_001_000),
            timestamp(1_700_000_001_000),
            timestamp(1_700_000_002_000),
        )
        .expect("lease redaction request");
    let response_body = format!(r#"{{"marker":"{}"}}"#, String::from_utf8_lossy(marker));
    let response = RawMatrixResponse::keys_query(response_body.into_bytes())
        .expect("construct redaction response");
    store
        .record_crypto_response(&row_id, &response)
        .expect("record redaction response");
    let saved = store
        .saved_crypto_response()
        .expect("load redaction response")
        .expect("redaction response");
    assert!(!format!("{saved:?}").contains(std::str::from_utf8(marker).expect("marker text")));
    assert!(
        !saved
            .to_string()
            .contains(std::str::from_utf8(marker).expect("marker text"))
    );

    mutate_sql(
        &path,
        "UPDATE matrix_crypto_outbox SET response_sha256 = zeroblob(32)",
    );
    let error = store
        .saved_crypto_response()
        .expect_err("corrupt redaction response");
    assert_code(error, STORE_CRYPTO_CORRUPT);
    assert!(!format!("{error:?}").contains(std::str::from_utf8(marker).expect("marker text")));
    assert!(
        !error
            .to_string()
            .contains(std::str::from_utf8(marker).expect("marker text"))
    );
}

#[test]
fn repeated_identical_canonical_requests_in_different_inboxes_are_allowed() {
    let (_directory, path, mut store, first, second) = secure_store_with_two_rows();
    let first_request = request_with_id(b"duplicate-request-first");
    store
        .record_sdk_processing(&first, std::slice::from_ref(&first_request))
        .expect("record first identical canonical request");
    let first_row_id = raw_crypto_row_id(&path);
    store
        .record_attempt(
            &first_row_id,
            0,
            timestamp(1_700_000_001_000),
            timestamp(1_700_000_001_000),
            timestamp(1_700_000_002_000),
        )
        .expect("lease first identical canonical request");
    store
        .record_crypto_response(
            &first_row_id,
            &RawMatrixResponse::keys_query(br#"{"response":"first"}"#.to_vec())
                .expect("construct first response"),
        )
        .expect("record first response");
    store
        .complete_crypto_request(&first_row_id, timestamp(1_700_000_003_000))
        .expect("accept first response");
    store
        .mark_crypto_drained(&first)
        .expect("drain first identical canonical request");

    let second_request = request_with_id(b"duplicate-request-second");
    store
        .record_sdk_processing(&second, std::slice::from_ref(&second_request))
        .expect("record second identical canonical request");

    let connection = Connection::open(&path).expect("open duplicate request database");
    let rows = query_values(
        &connection,
        "SELECT inbox_id, request_lookup FROM matrix_crypto_outbox ORDER BY rowid",
        2,
    );
    assert_eq!(rows.len(), 2);
    assert_ne!(rows[0][0], rows[1][0]);
    assert_eq!(rows[0][1], rows[1][1]);
    assert!(
        store
            .crypto_maintenance_status()
            .expect("verify duplicate canonical requests")
            .is_none()
    );
}

fn maintenance_code(value: &str) -> ReasonCode {
    ReasonCode::new(value).expect("construct maintenance code")
}

fn set_maintenance(store: &mut Store, code: &str, at: i64) {
    store
        .set_crypto_maintenance(maintenance_code(code), timestamp(at))
        .expect("set maintenance marker");
}

#[test]
fn maintenance_set_status_and_exact_retry_survive_reopen() {
    let (_directory, path, mut store, _first, _second) = secure_store_with_two_rows();
    let code = "crypto_maintenance_required";
    let at = timestamp(1_700_000_003_000);
    set_maintenance(&mut store, code, at.timestamp_millis());
    let after_set = raw_snapshot(&path);
    let inspector = Connection::open(&path).expect("open maintenance inspector");
    let before_retry_version = data_version(&inspector);

    let status = store
        .crypto_maintenance_status()
        .expect("read maintenance status")
        .expect("maintenance status");
    assert_eq!(status.code().as_str(), code);
    assert_eq!(status.since(), &at);
    store
        .set_crypto_maintenance(maintenance_code(code), at)
        .expect("exact maintenance retry");
    assert_snapshot_unchanged(&raw_snapshot(&path), &after_set);
    assert_eq!(data_version(&inspector), before_retry_version);

    drop(store);
    let reopened = Store::open(&path, test_keyring()).expect("reopen maintenance store");
    let status = reopened
        .crypto_maintenance_status()
        .expect("read reopened maintenance status")
        .expect("reopened maintenance status");
    assert_eq!(status.code().as_str(), code);
    assert_eq!(status.since(), &at);
}

#[test]
fn maintenance_accepts_exactly_the_three_schema_codes() {
    for (index, code) in [
        "crypto_maintenance_required",
        "matrix_crypto_kind_not_allowed",
        "matrix_crypto_ack_unrecoverable",
    ]
    .into_iter()
    .enumerate()
    {
        let (_directory, _path, mut store, _inbox_id) = secure_store();
        let at = 1_700_000_003_000 + i64::try_from(index).expect("index") * 1_000;
        set_maintenance(&mut store, code, at);
        let status = store
            .crypto_maintenance_status()
            .expect("read exact maintenance code")
            .expect("exact maintenance code status");
        assert_eq!(status.code().as_str(), code);
    }
}

#[test]
fn maintenance_rejects_invalid_code_time_or_unbootstrapped_store_without_writes() {
    let directory = tempdir().expect("create unbootstrapped directory");
    fs::set_permissions(directory.path(), fs::Permissions::from_mode(0o700))
        .expect("secure unbootstrapped directory");
    let path = directory.path().join("gateway.sqlite3");
    let mut unbootstrapped = Store::open(&path, test_keyring()).expect("open empty store");
    let before = raw_snapshot(&path);
    assert_code(
        unbootstrapped
            .set_crypto_maintenance(
                maintenance_code("crypto_maintenance_required"),
                timestamp(1_700_000_003_000),
            )
            .expect_err("unbootstrapped maintenance set"),
        STORE_CRYPTO_NOT_READY,
    );
    assert_snapshot_unchanged(&raw_snapshot(&path), &before);

    let (_directory, path, mut store, _first, _second) = secure_store_with_two_rows();
    let before = raw_snapshot(&path);
    assert_code(
        store
            .set_crypto_maintenance(
                maintenance_code("invalid_maintenance"),
                timestamp(1_700_000_003_000),
            )
            .expect_err("invalid maintenance code"),
        STORE_CRYPTO_INVALID,
    );
    assert_snapshot_unchanged(&raw_snapshot(&path), &before);
    assert_code(
        store
            .set_crypto_maintenance(
                maintenance_code("crypto_maintenance_required"),
                timestamp(1_700_000_003_000) + Duration::nanoseconds(1),
            )
            .expect_err("sub-millisecond maintenance time"),
        STORE_CRYPTO_INVALID,
    );
    assert_snapshot_unchanged(&raw_snapshot(&path), &before);
    assert_code(
        store
            .set_crypto_maintenance(
                maintenance_code("crypto_maintenance_required"),
                timestamp(1_700_000_000_000),
            )
            .expect_err("maintenance time before store update"),
        STORE_CRYPTO_INVALID,
    );
    assert_snapshot_unchanged(&raw_snapshot(&path), &before);
}

#[test]
fn maintenance_rejects_conflicting_code_or_timestamp_without_writes() {
    let (_directory, path, mut store, _first, _second) = secure_store_with_two_rows();
    set_maintenance(&mut store, "crypto_maintenance_required", 1_700_000_003_000);
    let before = raw_snapshot(&path);
    assert_code(
        store
            .set_crypto_maintenance(
                maintenance_code("crypto_maintenance_required"),
                timestamp(1_700_000_004_000),
            )
            .expect_err("different maintenance timestamp"),
        STORE_CRYPTO_CONFLICT,
    );
    assert_snapshot_unchanged(&raw_snapshot(&path), &before);
    assert_code(
        store
            .set_crypto_maintenance(
                maintenance_code("matrix_crypto_kind_not_allowed"),
                timestamp(1_700_000_004_000),
            )
            .expect_err("different maintenance code"),
        STORE_CRYPTO_CONFLICT,
    );
    assert_snapshot_unchanged(&raw_snapshot(&path), &before);
}

#[test]
fn maintenance_corruption_precedes_idempotency_and_state_gates() {
    let (_directory, path, mut store, _first, _second) = secure_store_with_two_rows();
    set_maintenance(&mut store, "crypto_maintenance_required", 1_700_000_003_000);
    mutate_sql(
        &path,
        "UPDATE gateway_state SET maintenance_since = 'not-a-time'",
    );
    let before = raw_snapshot(&path);
    assert_code(
        store
            .set_crypto_maintenance(
                maintenance_code("crypto_maintenance_required"),
                timestamp(1_700_000_003_000),
            )
            .expect_err("corrupt maintenance state"),
        STORE_CRYPTO_CORRUPT,
    );
    assert_snapshot_unchanged(&raw_snapshot(&path), &before);
}

#[test]
fn maintenance_set_rolls_back_every_table_and_column_on_sql_abort() {
    let (_directory, path, mut store, _first, _second) = secure_store_with_two_rows();
    let connection = Connection::open(&path).expect("open maintenance trigger database");
    connection
        .execute_batch(
            "CREATE TRIGGER fail_maintenance_set
             BEFORE UPDATE OF maintenance_code ON gateway_state
             BEGIN SELECT RAISE(ABORT, 'maintenance_set_abort_fixture'); END;",
        )
        .expect("install maintenance set trigger");
    drop(connection);
    let before = raw_snapshot(&path);
    let error = store
        .set_crypto_maintenance(
            maintenance_code("crypto_maintenance_required"),
            timestamp(1_700_000_003_000),
        )
        .expect_err("maintenance set trigger abort");
    assert_code(error, STORE_CRYPTO_CORRUPT);
    assert_snapshot_unchanged(&raw_snapshot(&path), &before);
    mutate_sql(&path, "DROP TRIGGER fail_maintenance_set");
    assert!(!error.to_string().contains("maintenance_set_abort_fixture"));
    assert!(!format!("{error:?}").contains("maintenance_set_abort_fixture"));
}

#[test]
fn maintenance_clear_requires_expected_code_and_no_unresolved_or_quarantined_row() {
    let (_directory, path, mut store, _first, _second) = secure_store_with_two_rows();
    set_maintenance(&mut store, "crypto_maintenance_required", 1_700_000_003_000);
    let before = raw_snapshot(&path);
    assert_code(
        store
            .clear_crypto_maintenance(maintenance_code("matrix_crypto_kind_not_allowed"))
            .expect_err("wrong maintenance code"),
        STORE_CRYPTO_CONFLICT,
    );
    assert_snapshot_unchanged(&raw_snapshot(&path), &before);

    let (_directory, path, mut store, first, _second) = secure_store_with_two_rows();
    let request = request_with_id(b"maintenance-pending");
    store
        .record_sdk_processing(&first, std::slice::from_ref(&request))
        .expect("record pending maintenance row");
    set_maintenance(&mut store, "crypto_maintenance_required", 1_700_000_003_000);
    let before = raw_snapshot(&path);
    assert_code(
        store
            .clear_crypto_maintenance(maintenance_code("crypto_maintenance_required"))
            .expect_err("pending row blocks maintenance clear"),
        STORE_CRYPTO_NOT_READY,
    );
    assert_snapshot_unchanged(&raw_snapshot(&path), &before);

    let (_directory, path, mut store, first, _second) = secure_store_with_two_rows();
    let request = request_with_id(b"maintenance-quarantined");
    store
        .record_sdk_processing(&first, std::slice::from_ref(&request))
        .expect("record quarantined maintenance row");
    store
        .quarantine_crypto_request(
            &raw_crypto_row_id(&path),
            ReasonCode::new("crypto_failed").expect("quarantine code"),
        )
        .expect("quarantine maintenance row");
    set_maintenance(&mut store, "crypto_maintenance_required", 1_700_000_003_000);
    let before = raw_snapshot(&path);
    assert_code(
        store
            .clear_crypto_maintenance(maintenance_code("crypto_maintenance_required"))
            .expect_err("quarantined row blocks maintenance clear"),
        STORE_CRYPTO_NOT_READY,
    );
    assert_snapshot_unchanged(&raw_snapshot(&path), &before);
}

#[test]
fn maintenance_clear_is_idempotent_after_verified_clear() {
    let (_directory, path, mut store, _first, _second) = secure_store_with_two_rows();
    set_maintenance(&mut store, "crypto_maintenance_required", 1_700_000_003_000);
    store
        .clear_crypto_maintenance(maintenance_code("crypto_maintenance_required"))
        .expect("clear maintenance marker");
    let after_clear = raw_snapshot(&path);
    assert!(
        store
            .crypto_maintenance_status()
            .expect("read cleared status")
            .is_none()
    );
    store
        .clear_crypto_maintenance(maintenance_code("crypto_maintenance_required"))
        .expect("idempotent clear");
    assert_snapshot_unchanged(&raw_snapshot(&path), &after_clear);

    drop(store);
    let mut reopened = Store::open(&path, test_keyring()).expect("reopen cleared store");
    reopened
        .clear_crypto_maintenance(maintenance_code("crypto_maintenance_required"))
        .expect("idempotent clear after reopen");
    assert_snapshot_unchanged(&raw_snapshot(&path), &after_clear);
}

#[test]
fn maintenance_clear_rolls_back_every_table_and_column_on_sql_abort() {
    let (_directory, path, mut store, _first, _second) = secure_store_with_two_rows();
    set_maintenance(&mut store, "crypto_maintenance_required", 1_700_000_003_000);
    let connection = Connection::open(&path).expect("open maintenance clear trigger database");
    connection
        .execute_batch(
            "CREATE TRIGGER fail_maintenance_clear
             BEFORE UPDATE OF maintenance_code ON gateway_state
             BEGIN SELECT RAISE(ABORT, 'maintenance_clear_abort_fixture'); END;",
        )
        .expect("install maintenance clear trigger");
    drop(connection);
    let before = raw_snapshot(&path);
    let error = store
        .clear_crypto_maintenance(maintenance_code("crypto_maintenance_required"))
        .expect_err("maintenance clear trigger abort");
    assert_code(error, STORE_CRYPTO_CORRUPT);
    assert_snapshot_unchanged(&raw_snapshot(&path), &before);
    mutate_sql(&path, "DROP TRIGGER fail_maintenance_clear");
    assert!(
        !error
            .to_string()
            .contains("maintenance_clear_abort_fixture")
    );
    assert!(!format!("{error:?}").contains("maintenance_clear_abort_fixture"));
}

#[test]
fn maintenance_status_is_read_only_bounded_and_redacted() {
    let (_directory, path, mut store, _first, _second) = secure_store_with_two_rows();
    set_maintenance(
        &mut store,
        "matrix_crypto_ack_unrecoverable",
        1_700_000_003_000,
    );
    let before = raw_snapshot(&path);
    let inspector = Connection::open(&path).expect("open status inspector");
    let before_version = data_version(&inspector);
    let status = store
        .crypto_maintenance_status()
        .expect("read maintenance status")
        .expect("maintenance status");
    assert_eq!(format!("{status:?}"), "CryptoMaintenanceStatus([REDACTED])");
    assert_eq!(format!("{status}"), "CryptoMaintenanceStatus([REDACTED])");
    assert_snapshot_unchanged(&raw_snapshot(&path), &before);
    assert_eq!(data_version(&inspector), before_version);

    let malformed = ReasonCode::new("not_a_schema_code").expect("valid generic reason code");
    let before_invalid = raw_snapshot(&path);
    assert_code(
        store
            .clear_crypto_maintenance(malformed)
            .expect_err("invalid expected code"),
        STORE_CRYPTO_INVALID,
    );
    assert_snapshot_unchanged(&raw_snapshot(&path), &before_invalid);
}

fn record_accepted_request(store: &mut Store, path: &std::path::Path, id: &[u8]) -> String {
    let row_id = record_response_received(store, path, id);
    store
        .complete_crypto_request(&row_id, timestamp(1_700_000_003_000))
        .expect("accept crypto response");
    row_id
}

fn unknown_inbox_id() -> String {
    format!("inbox_{}", "0".repeat(64))
}

#[test]
fn drain_succeeds_for_oldest_sdk_processed_inbox_with_no_request() {
    let (_directory, path, mut store, first, _second) = secure_store_with_two_rows();
    store
        .record_sdk_processing(&first, &[])
        .expect("process oldest inbox without request");
    store
        .mark_crypto_drained(&first)
        .expect("drain oldest inbox without request");
    let row = raw_snapshot(&path).inbox.remove(0);
    assert_eq!(row[15], Value::Text("sdk_processed".to_owned()));
    assert_eq!(row[16], Value::Integer(1));
}

#[test]
fn drain_succeeds_only_after_its_single_request_is_accepted() {
    let (_directory, path, mut store, first, _second) = secure_store_with_two_rows();
    let before = raw_snapshot(&path);
    let row_id = record_accepted_request(&mut store, &path, b"drain-accepted");
    let before_drain = raw_snapshot(&path);
    store
        .mark_crypto_drained(&first)
        .expect("drain accepted crypto request");
    let after = raw_snapshot(&path);
    assert_eq!(after.gateway, before.gateway);
    assert_eq!(after.crypto, before_drain.crypto);
    assert_eq!(after.inbox.len(), before.inbox.len());
    assert_eq!(after.inbox[0][0], before.inbox[0][0]);
    assert_eq!(after.inbox[0][16], Value::Integer(1));
    for index in 0..after.inbox[0].len() {
        if index != 16 {
            assert_eq!(after.inbox[0][index], before_drain.inbox[0][index]);
        }
    }
    assert_eq!(after.crypto[0][0], Value::Text(row_id));
}

#[test]
fn drain_exact_retry_is_read_only_and_survives_reopen() {
    let (_directory, path, mut store, first, _second) = secure_store_with_two_rows();
    store
        .record_sdk_processing(&first, &[])
        .expect("process drain retry fixture");
    store.mark_crypto_drained(&first).expect("initial drain");
    let after_first = raw_snapshot(&path);
    let inspector = Connection::open(&path).expect("open drain inspector");
    let version = data_version(&inspector);
    store
        .mark_crypto_drained(&first)
        .expect("exact drain retry");
    assert_snapshot_unchanged(&raw_snapshot(&path), &after_first);
    assert_eq!(data_version(&inspector), version);

    drop(store);
    let mut reopened = Store::open(&path, test_keyring()).expect("reopen drained store");
    reopened
        .mark_crypto_drained(&first)
        .expect("exact drain retry after reopen");
    assert_snapshot_unchanged(&raw_snapshot(&path), &after_first);
}

#[test]
fn drained_retry_revalidates_target_lifecycle_after_reopen() {
    let (_directory, path, mut store, first, _second) = secure_store_with_two_rows();
    store
        .record_sdk_processing(&first, &[])
        .expect("process drained retry fixture");
    store
        .mark_crypto_drained(&first)
        .expect("initially drain retry fixture");
    drop(store);

    mutate_sql(
        &path,
        &format!(
            "UPDATE sync_inbox
             SET state = 'fetched', sdk_processed_at = NULL
             WHERE inbox_id = '{first}'"
        ),
    );
    let mut reopened = Store::open(&path, test_keyring()).expect("reopen drained retry store");
    let before_retry = raw_snapshot(&path);
    assert_code(
        reopened
            .mark_crypto_drained(&first)
            .expect_err("invalid drained target must be revalidated"),
        STORE_CRYPTO_NOT_READY,
    );
    assert_snapshot_unchanged(&raw_snapshot(&path), &before_retry);
}

#[test]
fn drain_rejects_pending_response_received_or_quarantined_request() {
    let (_directory, path, mut store, first, _second) = secure_store_with_two_rows();
    let request = request_with_id(b"drain-pending");
    store
        .record_sdk_processing(&first, std::slice::from_ref(&request))
        .expect("record pending drain fixture");
    let before = raw_snapshot(&path);
    assert_code(
        store
            .mark_crypto_drained(&first)
            .expect_err("pending request cannot drain"),
        STORE_CRYPTO_NOT_READY,
    );
    assert_snapshot_unchanged(&raw_snapshot(&path), &before);

    let (_directory, path, mut store, first, _second) = secure_store_with_two_rows();
    let row_id = record_response_received(&mut store, &path, b"drain-response");
    let before = raw_snapshot(&path);
    assert_code(
        store
            .mark_crypto_drained(&first)
            .expect_err("response-received request cannot drain"),
        STORE_CRYPTO_NOT_READY,
    );
    assert_snapshot_unchanged(&raw_snapshot(&path), &before);
    assert!(!row_id.is_empty());

    let (_directory, path, mut store, first, _second) = secure_store_with_two_rows();
    let request = request_with_id(b"drain-quarantined");
    store
        .record_sdk_processing(&first, std::slice::from_ref(&request))
        .expect("record quarantined drain fixture");
    store
        .quarantine_crypto_request(
            &raw_crypto_row_id(&path),
            ReasonCode::new("crypto_failed").expect("quarantine code"),
        )
        .expect("quarantine drain fixture");
    let before = raw_snapshot(&path);
    assert_code(
        store
            .mark_crypto_drained(&first)
            .expect_err("quarantined request cannot drain"),
        STORE_CRYPTO_NOT_READY,
    );
    assert_snapshot_unchanged(&raw_snapshot(&path), &before);
}

#[test]
fn drain_rejects_newer_inbox_while_earlier_crypto_is_not_drained() {
    let (_directory, path, mut store, first, second) = secure_store_with_two_rows();
    store
        .record_sdk_processing(&first, &[])
        .expect("process earlier inbox");
    store
        .record_sdk_processing(&second, &[])
        .expect("process newer inbox");
    let before = raw_snapshot(&path);
    assert_code(
        store
            .mark_crypto_drained(&second)
            .expect_err("newer inbox cannot drain first"),
        STORE_CRYPTO_NOT_READY,
    );
    assert_snapshot_unchanged(&raw_snapshot(&path), &before);
    store
        .mark_crypto_drained(&first)
        .expect("drain earlier inbox");
    store
        .mark_crypto_drained(&second)
        .expect("drain newer inbox after predecessor");
    assert_eq!(raw_snapshot(&path).inbox[1][16], Value::Integer(1));
}

#[test]
fn drain_rejects_maintenance_wrong_state_unknown_id_or_invalid_id() {
    let (_directory, path, mut store, first, _second) = secure_store_with_two_rows();
    store
        .record_sdk_processing(&first, &[])
        .expect("process maintenance drain fixture");
    set_maintenance(&mut store, "crypto_maintenance_required", 1_700_000_003_000);
    let before = raw_snapshot(&path);
    assert_code(
        store
            .mark_crypto_drained(&first)
            .expect_err("maintenance blocks drain"),
        STORE_CRYPTO_NOT_READY,
    );
    assert_snapshot_unchanged(&raw_snapshot(&path), &before);

    let (_directory, path, mut store, first, _second) = secure_store_with_two_rows();
    let before = raw_snapshot(&path);
    assert_code(
        store
            .mark_crypto_drained(&first)
            .expect_err("fetched inbox cannot drain"),
        STORE_CRYPTO_NOT_READY,
    );
    assert_snapshot_unchanged(&raw_snapshot(&path), &before);
    assert_code(
        store
            .mark_crypto_drained(&unknown_inbox_id())
            .expect_err("unknown inbox cannot drain"),
        STORE_CRYPTO_NOT_READY,
    );
    assert_code(
        store
            .mark_crypto_drained("invalid-inbox-id")
            .expect_err("invalid inbox ID"),
        STORE_CRYPTO_INVALID,
    );
    assert_snapshot_unchanged(&raw_snapshot(&path), &before);
}

#[test]
fn drain_rejects_corrupt_gateway_chain_parent_cardinality_or_crypto_row() {
    let mutations = [
        "UPDATE gateway_state SET maintenance_since = 'not-a-time'",
        "UPDATE sync_inbox SET response_sha256 = zeroblob(32)",
    ];
    for mutation in mutations {
        let (_directory, path, mut store, first, _second) = secure_store_with_two_rows();
        store
            .record_sdk_processing(&first, &[])
            .expect("process corruption drain fixture");
        mutate_sql(&path, mutation);
        assert_code(
            store
                .mark_crypto_drained(&first)
                .expect_err("corrupt drain fixture"),
            STORE_CRYPTO_CORRUPT,
        );
    }

    let (_directory, path, mut store, first, _second) = secure_store_with_two_rows();
    let request = request_with_id(b"drain-parent-corrupt");
    store
        .record_sdk_processing(&first, std::slice::from_ref(&request))
        .expect("record parent corruption fixture");
    mutate_sql(
        &path,
        "UPDATE sync_inbox SET state = 'fetched', sdk_processed_at = NULL",
    );
    assert_code(
        store
            .mark_crypto_drained(&first)
            .expect_err("corrupt crypto parent"),
        STORE_CRYPTO_CORRUPT,
    );

    let (_directory, path, mut store, first, second) = secure_store_with_two_rows();
    store
        .record_sdk_processing(&first, &[])
        .expect("process first cardinality fixture");
    store
        .record_sdk_processing(&second, &[])
        .expect("process second cardinality fixture");
    drop_unresolved_index(&path);
    insert_pending_crypto_row(&path, &first, b"drain-cardinality-one");
    insert_pending_crypto_row(&path, &second, b"drain-cardinality-two");
    assert_code(
        store
            .mark_crypto_drained(&first)
            .expect_err("multiple unresolved crypto rows"),
        STORE_CRYPTO_CORRUPT,
    );

    let (_directory, path, mut store, first, _second) = secure_store_with_two_rows();
    store
        .record_sdk_processing(&first, &[])
        .expect("process crypto corruption fixture");
    insert_pending_crypto_row(&path, &first, b"drain-crypto-corrupt");
    mutate_sql(
        &path,
        "UPDATE matrix_crypto_outbox SET request_sha256 = zeroblob(32)",
    );
    assert_code(
        store
            .mark_crypto_drained(&first)
            .expect_err("corrupt crypto row"),
        STORE_CRYPTO_CORRUPT,
    );
}

#[test]
fn drain_rolls_back_every_table_and_column_on_sql_abort() {
    let (_directory, path, mut store, first, _second) = secure_store_with_two_rows();
    store
        .record_sdk_processing(&first, &[])
        .expect("process drain rollback fixture");
    let connection = Connection::open(&path).expect("open drain trigger database");
    connection
        .execute_batch(
            "CREATE TRIGGER fail_crypto_drain
             BEFORE UPDATE OF crypto_drained ON sync_inbox
             BEGIN SELECT RAISE(ABORT, 'crypto_drain_abort_fixture'); END;",
        )
        .expect("install drain trigger");
    drop(connection);
    let before = raw_snapshot(&path);
    let error = store
        .mark_crypto_drained(&first)
        .expect_err("drain trigger abort");
    assert_code(error, STORE_CRYPTO_CORRUPT);
    assert_snapshot_unchanged(&raw_snapshot(&path), &before);
    mutate_sql(&path, "DROP TRIGGER fail_crypto_drain");
    assert!(!error.to_string().contains("crypto_drain_abort_fixture"));
    assert!(!format!("{error:?}").contains("crypto_drain_abort_fixture"));
}

#[test]
fn drain_changes_only_the_target_crypto_drained_column() {
    let (_directory, path, mut store, first, _second) = secure_store_with_two_rows();
    let row_id = record_accepted_request(&mut store, &path, b"drain-column-only");
    let before = raw_snapshot(&path);
    store
        .mark_crypto_drained(&first)
        .expect("drain column-only fixture");
    let after = raw_snapshot(&path);
    assert_eq!(after.gateway, before.gateway);
    assert_eq!(after.crypto, before.crypto);
    assert_eq!(after.inbox.len(), before.inbox.len());
    for row_index in 0..after.inbox.len() {
        for column_index in 0..after.inbox[row_index].len() {
            if row_index == 0 && column_index == 16 {
                assert_eq!(after.inbox[row_index][column_index], Value::Integer(1));
            } else {
                assert_eq!(
                    after.inbox[row_index][column_index],
                    before.inbox[row_index][column_index]
                );
            }
        }
    }
    assert_eq!(after.crypto[0][0], Value::Text(row_id));
}
