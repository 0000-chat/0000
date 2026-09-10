use std::{
    fs,
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
};

use chrono::{DateTime, TimeZone, Utc};
use communicator_matrix_gateway::{
    canonical::canonical_json_bytes,
    crypto::{Keyring, Sealed},
    crypto_outbox::{
        ExactMatrixRequest, MAX_MATRIX_CRYPTO_REQUEST_BYTES, MAX_SDK_REQUEST_ID_BYTES,
    },
    secret::SafeError,
    store::{
        STORE_CRYPTO_CONFLICT, STORE_CRYPTO_CORRUPT, STORE_CRYPTO_INVALID, STORE_CRYPTO_NOT_READY,
        STORE_CRYPTO_TOO_LARGE, STORE_CRYPTO_UNRESOLVED, Store,
    },
    store_types::{NewBootstrapState, NewRawSyncInbox},
};
use rusqlite::{Connection, params, types::Value};
use serde_json::json;
use sha2::{Digest, Sha256};
use tempfile::{TempDir, tempdir};

fn assert_error(error: SafeError, code: &str) {
    assert_eq!(error.code(), code);
    assert_eq!(error.to_string(), code);
    assert_eq!(
        format!("{error:?}"),
        format!("SafeError {{ code: \"{code}\" }}")
    );
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

fn inbox_states(path: &Path) -> Vec<(String, String, i64, Option<String>)> {
    let connection = Connection::open(path).expect("open sqlite state inspection");
    let mut statement = connection
        .prepare(
            "SELECT inbox_id, state, crypto_drained, sdk_processed_at
             FROM sync_inbox ORDER BY rowid",
        )
        .expect("prepare sqlite state inspection");
    statement
        .query_map([], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
        })
        .expect("query sqlite state inspection")
        .collect::<Result<Vec<_>, _>>()
        .expect("read sqlite states")
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

#[derive(Clone, PartialEq)]
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

fn raw_crypto_rows(path: &Path) -> Vec<RawCryptoRow> {
    let connection = Connection::open(path).expect("open sqlite crypto snapshot database");
    let mut statement = connection
        .prepare(
            "SELECT crypto_row_id, inbox_id, request_lookup, request_kind,
                    sdk_request_id_cipher, sdk_request_id_nonce, sdk_request_id_key_version,
                    request_cipher, request_nonce, request_key_version, request_sha256,
                    byte_count, response_cipher, response_nonce, response_key_version,
                    response_sha256, state, attempt_count, next_attempt_at,
                    accepted_at, terminal_code
             FROM matrix_crypto_outbox ORDER BY rowid",
        )
        .expect("prepare crypto snapshot query");
    statement
        .query_map([], |row| {
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
        })
        .expect("query crypto snapshot rows")
        .collect::<Result<Vec<_>, _>>()
        .expect("read crypto snapshot rows")
}

fn raw_crypto_row(path: &Path) -> RawCryptoRow {
    let rows = raw_crypto_rows(path);
    assert_eq!(rows.len(), 1, "expected one crypto row");
    rows.into_iter().next().expect("crypto row")
}

fn request_with_body(sdk_request_id: &[u8], body: &[u8]) -> ExactMatrixRequest {
    ExactMatrixRequest::keys_query(sdk_request_id.to_vec(), body.to_vec())
        .expect("construct canonical keys query request")
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

fn decrypt_crypto_value(row: &RawCryptoRow, column: &str) -> Vec<u8> {
    let (ciphertext, nonce, key_version) = match column {
        "sdk_request_id" => (
            &row.sdk_request_id_cipher,
            &row.sdk_request_id_nonce,
            row.sdk_request_id_key_version,
        ),
        "request" => (
            &row.request_cipher,
            &row.request_nonce,
            row.request_key_version,
        ),
        _ => panic!("unsupported crypto column"),
    };
    let nonce: [u8; 24] = nonce.as_slice().try_into().expect("crypto nonce length");
    test_keyring()
        .open(
            "matrix_crypto_outbox",
            &row.crypto_row_id,
            column,
            &Sealed {
                nonce,
                ciphertext: ciphertext.clone(),
                key_version: u32::try_from(key_version).expect("crypto key version"),
            },
        )
        .expect("decrypt crypto fixture")
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
        "protected canary class appeared in SQLite storage"
    );
}

fn request_body_with_marker(marker: &str) -> Vec<u8> {
    canonical_json_bytes(&json!({
        "device_keys": {"@alice:example.org": ["DEVICE"]},
        "marker": marker,
        "timeout": null
    }))
    .expect("canonical request body with marker")
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
        .expect("seal crypto sdk ID fixture");
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
                Sha256::digest(body).as_slice(),
                i64::try_from(body.len()).expect("crypto body length"),
            ],
        )
        .expect("insert crypto row fixture");
}

fn mutate_crypto_row(path: &Path, sql: &str) {
    let connection = Connection::open(path).expect("open crypto corruption fixture");
    connection
        .execute("PRAGMA ignore_check_constraints = ON", [])
        .expect("enable crypto corruption fixture checks");
    connection
        .execute(sql, [])
        .expect("apply crypto corruption fixture");
}

fn assert_crypto_retry_corrupt(mutate: impl FnOnce(&Path, &RawCryptoRow)) {
    let (_directory, path, mut store, first, _second) = setup_two_fetched_rows();
    let body = canonical_keys_query();
    let request = request_with_body(b"sdk-corruption-id", &body);
    store
        .record_sdk_processing(&first, std::slice::from_ref(&request))
        .expect("create crypto corruption fixture");
    let row = raw_crypto_row(&path);
    mutate(&path, &row);
    let before = raw_snapshot(&path);
    assert_error(
        store
            .record_sdk_processing(&first, std::slice::from_ref(&request))
            .expect_err("corrupt crypto row must be rejected"),
        STORE_CRYPTO_CORRUPT,
    );
    assert_snapshot_unchanged(&raw_snapshot(&path), &before);
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

fn exact_size_canonical_keys_query(size: usize) -> Vec<u8> {
    assert!(size >= 29);
    let first = "x".repeat(1_048_576);
    let second = "y".repeat(1_048_576);
    let third = "z".repeat(1_048_576);
    let fourth = "w".repeat(size - 29 - 3 * 1_048_576);
    canonical_json_bytes(&json!({
        "a": first,
        "b": second,
        "c": third,
        "d": fourth
    }))
    .expect("bounded canonical keys query fixture")
}

#[test]
fn keys_query_dto_accepts_only_exact_bounded_canonical_json_object() {
    let body = canonical_keys_query();
    let request = ExactMatrixRequest::keys_query(b"sdk-request-id".to_vec(), body.clone())
        .expect("canonical object must be accepted");
    let expected_sha256: [u8; 32] = Sha256::digest(&body).into();
    assert_eq!(request.request_sha256(), &expected_sha256);

    let exact_limit = exact_size_canonical_keys_query(MAX_MATRIX_CRYPTO_REQUEST_BYTES);
    assert_eq!(exact_limit.len(), MAX_MATRIX_CRYPTO_REQUEST_BYTES);
    ExactMatrixRequest::keys_query(b"sdk-request-id".to_vec(), exact_limit)
        .expect("the exact request limit must be accepted");
}

#[test]
fn keys_query_dto_rejects_empty_oversized_invalid_utf8_and_non_object_bodies() {
    assert_error(
        ExactMatrixRequest::keys_query(Vec::new(), canonical_keys_query())
            .expect_err("empty SDK request ID must fail"),
        STORE_CRYPTO_INVALID,
    );
    assert_error(
        ExactMatrixRequest::keys_query(b"sdk-request-id".to_vec(), Vec::new())
            .expect_err("empty request body must fail"),
        STORE_CRYPTO_INVALID,
    );
    assert_error(
        ExactMatrixRequest::keys_query(
            vec![0_u8; MAX_SDK_REQUEST_ID_BYTES + 1],
            canonical_keys_query(),
        )
        .expect_err("oversized SDK request ID must fail"),
        STORE_CRYPTO_TOO_LARGE,
    );
    assert_error(
        ExactMatrixRequest::keys_query(
            b"sdk-request-id".to_vec(),
            vec![b'{'; MAX_MATRIX_CRYPTO_REQUEST_BYTES + 1],
        )
        .expect_err("oversized request body must fail"),
        STORE_CRYPTO_TOO_LARGE,
    );
    assert_error(
        ExactMatrixRequest::keys_query(b"sdk-request-id".to_vec(), vec![0xff, 0xfe])
            .expect_err("invalid UTF-8 must fail"),
        STORE_CRYPTO_INVALID,
    );
    for body in [b"null".as_slice(), b"[]".as_slice(), b"\"text\"".as_slice()] {
        assert_error(
            ExactMatrixRequest::keys_query(b"sdk-request-id".to_vec(), body.to_vec())
                .expect_err("a non-object JSON value must fail"),
            STORE_CRYPTO_INVALID,
        );
    }
}

#[test]
fn keys_query_dto_rejects_noncanonical_or_trailing_json_bytes() {
    for body in [
        br#"{ "a": 1 }"#.as_slice(),
        br#"{"a":1,"a":1}"#.as_slice(),
        br#"{"a":1} trailing"#.as_slice(),
        b"{\"a\":1}\n".as_slice(),
    ] {
        assert_error(
            ExactMatrixRequest::keys_query(b"sdk-request-id".to_vec(), body.to_vec())
                .expect_err("noncanonical or trailing JSON must fail"),
            STORE_CRYPTO_INVALID,
        );
    }
}

#[test]
fn crypto_request_dto_is_non_clone_and_redacts_debug_and_display() {
    let request =
        ExactMatrixRequest::keys_query(b"sdk-request-id".to_vec(), canonical_keys_query())
            .expect("canonical request fixture");
    assert_eq!(format!("{request:?}"), "ExactMatrixRequest([REDACTED])");
    assert_eq!(format!("{request}"), "ExactMatrixRequest([REDACTED])");
}

#[test]
fn sdk_processing_without_request_marks_only_first_fetched_inbox_processed() {
    let (_directory, path, mut store, first, second) = setup_two_fetched_rows();

    store
        .record_sdk_processing(&first, &[])
        .expect("first fetched row can be marked SDK-processed");

    assert_eq!(
        inbox_states(&path),
        vec![
            (
                first,
                "sdk_processed".to_owned(),
                0,
                Some(timestamp(1_700_000_001_000).to_rfc3339()),
            ),
            (second, "fetched".to_owned(), 0, None),
        ]
    );
}

#[test]
fn sdk_processing_with_keys_query_encrypts_exact_request_in_same_transaction() {
    let (_directory, path, mut store, first, second) = setup_two_fetched_rows();
    let body = canonical_keys_query();
    let sdk_request_id = b"sdk-request-id-exact";
    let request = request_with_body(sdk_request_id, &body);

    store
        .record_sdk_processing(&first, std::slice::from_ref(&request))
        .expect("keys query should be recorded atomically");

    let states = inbox_states(&path);
    assert_eq!(states.len(), 2);
    assert_eq!(states[0].0, first);
    assert_eq!(states[0].1, "sdk_processed");
    assert_eq!(states[0].2, 0);
    assert_eq!(states[0].3, Some(timestamp(1_700_000_001_000).to_rfc3339()));
    assert_eq!(states[1].0, second);
    assert_eq!(states[1].1, "fetched");
    assert_eq!(states[1].2, 0);
    assert!(states[1].3.is_none());

    let row = raw_crypto_row(&path);
    assert_eq!(row.inbox_id, first);
    assert_eq!(row.request_kind, "keys_query");
    assert_eq!(row.state, "pending");
    assert_eq!(row.attempt_count, 0);
    assert!(row.response_cipher.is_none());
    assert!(row.response_nonce.is_none());
    assert!(row.response_key_version.is_none());
    assert!(row.response_sha256.is_none());
    assert!(row.accepted_at.is_none());
    assert!(row.terminal_code.is_none());
    assert_eq!(
        row.next_attempt_at,
        timestamp(1_700_000_001_000).to_rfc3339()
    );
    assert_eq!(
        row.byte_count,
        i64::try_from(body.len()).expect("body length")
    );
    assert!(
        decrypt_crypto_value(&row, "sdk_request_id") == sdk_request_id,
        "SDK request ID bytes changed"
    );
    assert!(
        decrypt_crypto_value(&row, "request") == body,
        "request body bytes changed"
    );
    assert_ne!(row.sdk_request_id_nonce, row.request_nonce);

    let expected_lookup = crypto_lookup(&body);
    assert!(
        row.request_lookup == expected_lookup,
        "request lookup mismatch"
    );
    let expected_sha256: [u8; 32] = Sha256::digest(&body).into();
    assert!(
        row.request_sha256 == expected_sha256,
        "request digest mismatch"
    );
    assert_eq!(row.crypto_row_id, crypto_row_id(&first, &expected_lookup));
}

#[test]
fn sdk_processing_retry_is_exact_and_never_rewrites_ciphertext_or_timestamps() {
    let (_directory, path, mut store, first, _second) = setup_two_fetched_rows();
    let body = canonical_keys_query();
    let request = request_with_body(b"sdk-request-id-retry", &body);
    store
        .record_sdk_processing(&first, std::slice::from_ref(&request))
        .expect("initial request recording");
    let before = raw_snapshot(&path);

    store
        .record_sdk_processing(&first, std::slice::from_ref(&request))
        .expect("exact retry should be idempotent");

    assert_snapshot_unchanged(&raw_snapshot(&path), &before);
}

#[test]
fn sdk_processing_retry_with_missing_extra_or_different_request_conflicts() {
    let (_directory, path, mut store, first, _second) = setup_two_fetched_rows();
    let body = canonical_keys_query();
    let request = request_with_body(b"sdk-request-id-missing", &body);
    store
        .record_sdk_processing(&first, std::slice::from_ref(&request))
        .expect("initial request recording");
    let before = raw_snapshot(&path);
    assert_error(
        store
            .record_sdk_processing(&first, &[])
            .expect_err("missing request on retry must conflict"),
        STORE_CRYPTO_CONFLICT,
    );
    assert_snapshot_unchanged(&raw_snapshot(&path), &before);

    let (_directory, path, mut store, first, _second) = setup_two_fetched_rows();
    store
        .record_sdk_processing(&first, &[])
        .expect("initial no-request recording");
    let before = raw_snapshot(&path);
    let extra = request_with_body(b"sdk-request-id-extra", &body);
    assert_error(
        store
            .record_sdk_processing(&first, std::slice::from_ref(&extra))
            .expect_err("extra request on retry must conflict"),
        STORE_CRYPTO_CONFLICT,
    );
    assert_snapshot_unchanged(&raw_snapshot(&path), &before);

    let (_directory, path, mut store, first, _second) = setup_two_fetched_rows();
    store
        .record_sdk_processing(&first, std::slice::from_ref(&request))
        .expect("initial request recording");
    let before = raw_snapshot(&path);
    let different_body = request_body_with_marker("different-request-body");
    let different = request_with_body(b"sdk-request-id-different", &different_body);
    assert_error(
        store
            .record_sdk_processing(&first, std::slice::from_ref(&different))
            .expect_err("different request on retry must conflict"),
        STORE_CRYPTO_CONFLICT,
    );
    assert_snapshot_unchanged(&raw_snapshot(&path), &before);
}

#[test]
fn sdk_processing_rejects_second_request_and_rolls_back_every_column() {
    let (_directory, path, mut store, first, _second) = setup_two_fetched_rows();
    let body = canonical_keys_query();
    let first_request = request_with_body(b"sdk-request-id-one", &body);
    let second_request = request_with_body(b"sdk-request-id-two", &body);
    let before = raw_snapshot(&path);

    assert_error(
        store
            .record_sdk_processing(&first, &[first_request, second_request])
            .expect_err("two SDK requests must be rejected"),
        STORE_CRYPTO_INVALID,
    );
    assert_snapshot_unchanged(&raw_snapshot(&path), &before);
}

#[test]
fn sdk_processing_rejects_out_of_order_inbox_or_quarantined_predecessor() {
    let (_directory, path, mut store, _first, second) = setup_two_fetched_rows();
    let before = raw_snapshot(&path);
    assert_error(
        store
            .record_sdk_processing(&second, &[])
            .expect_err("a later fetched row cannot be processed first"),
        STORE_CRYPTO_NOT_READY,
    );
    assert_snapshot_unchanged(&raw_snapshot(&path), &before);

    let (_directory, path, mut store, first, second) = setup_two_fetched_rows();
    mutate_crypto_row(
        &path,
        &format!(
            "UPDATE sync_inbox SET state = 'quarantined', terminal_code = 'crypto_failed'
             WHERE inbox_id = '{first}'"
        ),
    );
    let before = raw_snapshot(&path);
    assert_error(
        store
            .record_sdk_processing(&second, &[])
            .expect_err("a quarantined predecessor must block progress"),
        STORE_CRYPTO_NOT_READY,
    );
    assert_snapshot_unchanged(&raw_snapshot(&path), &before);

    let (_directory, path, mut store, first, _second) = setup_two_fetched_rows();
    mutate_crypto_row(
        &path,
        &format!(
            "UPDATE sync_inbox SET state = 'quarantined', terminal_code = 'crypto_failed'
             WHERE inbox_id = '{first}'"
        ),
    );
    let before = raw_snapshot(&path);
    assert_error(
        store
            .record_sdk_processing(&first, &[])
            .expect_err("a quarantined target must not be processed"),
        STORE_CRYPTO_NOT_READY,
    );
    assert_snapshot_unchanged(&raw_snapshot(&path), &before);
}

#[test]
fn sdk_processing_blocks_while_any_unresolved_crypto_row_exists() {
    let (_directory, path, mut store, first, second) = setup_two_fetched_rows();
    let body = canonical_keys_query();
    let request = request_with_body(b"sdk-request-id-unresolved", &body);
    store
        .record_sdk_processing(&first, std::slice::from_ref(&request))
        .expect("create unresolved crypto request");
    let before = raw_snapshot(&path);

    assert_error(
        store
            .record_sdk_processing(&second, &[])
            .expect_err("a pending crypto request must serialize processing"),
        STORE_CRYPTO_UNRESOLVED,
    );
    assert_snapshot_unchanged(&raw_snapshot(&path), &before);
}

#[test]
fn sdk_processing_detects_multiple_unresolved_rows_if_unique_index_is_bypassed() {
    let (_directory, path, mut store, first, second) = setup_two_fetched_rows();
    let body = canonical_keys_query();
    let request = request_with_body(b"sdk-request-id-first", &body);
    store
        .record_sdk_processing(&first, std::slice::from_ref(&request))
        .expect("create first unresolved request");
    drop_unresolved_crypto_index(&path);
    let second_body = request_body_with_marker("second-unresolved");
    insert_pending_crypto_row(&path, &first, b"sdk-request-id-second", &second_body);
    let before = raw_snapshot(&path);

    assert_error(
        store
            .record_sdk_processing(&second, &[])
            .expect_err("two unresolved rows must fail closed"),
        STORE_CRYPTO_CORRUPT,
    );
    assert_snapshot_unchanged(&raw_snapshot(&path), &before);
}

#[test]
fn sdk_processing_rejects_unknown_corrupt_or_wrong_lifecycle_inbox() {
    let (_directory, path, mut store, first, _second) = setup_two_fetched_rows();
    mutate_crypto_row(
        &path,
        &format!("UPDATE sync_inbox SET state = 'unknown_state' WHERE inbox_id = '{first}'"),
    );
    let before = raw_snapshot(&path);
    assert_error(
        store
            .record_sdk_processing(&first, &[])
            .expect_err("unknown inbox state must fail closed"),
        STORE_CRYPTO_CORRUPT,
    );
    assert_snapshot_unchanged(&raw_snapshot(&path), &before);

    let (_directory, path, mut store, first, _second) = setup_two_fetched_rows();
    mutate_crypto_row(
        &path,
        &format!("UPDATE sync_inbox SET crypto_drained = 1 WHERE inbox_id = '{first}'"),
    );
    let before = raw_snapshot(&path);
    assert_error(
        store
            .record_sdk_processing(&first, &[])
            .expect_err("a drained fetched inbox must fail closed"),
        STORE_CRYPTO_CORRUPT,
    );
    assert_snapshot_unchanged(&raw_snapshot(&path), &before);

    let (_directory, path, mut store, first, _second) = setup_two_fetched_rows();
    mutate_crypto_row(
        &path,
        &format!(
            "UPDATE sync_inbox SET state = 'sdk_processed', sdk_processed_at = NULL
             WHERE inbox_id = '{first}'"
        ),
    );
    let before = raw_snapshot(&path);
    assert_error(
        store
            .record_sdk_processing(&first, &[])
            .expect_err("inconsistent inbox lifecycle must fail closed"),
        STORE_CRYPTO_CORRUPT,
    );
    assert_snapshot_unchanged(&raw_snapshot(&path), &before);
}

#[test]
fn sdk_processing_rejects_corrupt_crypto_cipher_nonce_key_digest_id_or_lifecycle() {
    assert_crypto_retry_corrupt(|path, _row| {
        mutate_crypto_row(
            path,
            "UPDATE matrix_crypto_outbox
             SET sdk_request_id_cipher = zeroblob(length(sdk_request_id_cipher))",
        );
    });
    assert_crypto_retry_corrupt(|path, _row| {
        mutate_crypto_row(
            path,
            "UPDATE matrix_crypto_outbox SET sdk_request_id_nonce = zeroblob(24)",
        );
    });
    assert_crypto_retry_corrupt(|path, _row| {
        mutate_crypto_row(
            path,
            "UPDATE matrix_crypto_outbox SET sdk_request_id_key_version = 9999",
        );
    });
    assert_crypto_retry_corrupt(|path, _row| {
        mutate_crypto_row(
            path,
            "UPDATE matrix_crypto_outbox
             SET request_cipher = zeroblob(length(request_cipher))",
        );
    });
    assert_crypto_retry_corrupt(|path, _row| {
        mutate_crypto_row(
            path,
            "UPDATE matrix_crypto_outbox SET request_nonce = zeroblob(24)",
        );
    });
    assert_crypto_retry_corrupt(|path, _row| {
        mutate_crypto_row(
            path,
            "UPDATE matrix_crypto_outbox SET request_key_version = 9999",
        );
    });
    assert_crypto_retry_corrupt(|path, _row| {
        mutate_crypto_row(
            path,
            "UPDATE matrix_crypto_outbox SET request_sha256 = zeroblob(32)",
        );
    });
    assert_crypto_retry_corrupt(|path, _row| {
        mutate_crypto_row(
            path,
            "UPDATE matrix_crypto_outbox SET request_lookup = zeroblob(32)",
        );
    });
    assert_crypto_retry_corrupt(|path, _row| {
        mutate_crypto_row(
            path,
            "UPDATE matrix_crypto_outbox
             SET crypto_row_id = 'crypto_ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'",
        );
    });
    assert_crypto_retry_corrupt(|path, _row| {
        mutate_crypto_row(
            path,
            "UPDATE matrix_crypto_outbox SET state = 'response_received'",
        );
    });
    assert_crypto_retry_corrupt(|path, _row| {
        mutate_crypto_row(
            path,
            "UPDATE matrix_crypto_outbox
             SET request_cipher = zeroblob(4194321)",
        );
    });
    assert_crypto_retry_corrupt(|path, _row| {
        mutate_crypto_row(
            path,
            "UPDATE matrix_crypto_outbox SET next_attempt_at = '2026-01-01T00:00:00.000Z'",
        );
    });
    assert_crypto_retry_corrupt(|path, _row| {
        mutate_crypto_row(
            path,
            "UPDATE matrix_crypto_outbox SET response_sha256 = zeroblob(32)",
        );
    });
}

#[test]
fn crypto_row_id_accepts_only_crypto_prefix_and_64_lowercase_hex() {
    let (_directory, path, mut store, first, _second) = setup_two_fetched_rows();
    let body = canonical_keys_query();
    let request = request_with_body(b"sdk-request-id-row-id", &body);
    store
        .record_sdk_processing(&first, std::slice::from_ref(&request))
        .expect("create crypto row");
    let row = raw_crypto_row(&path);
    assert_eq!(row.crypto_row_id.len(), "crypto_".len() + 64);
    assert!(row.crypto_row_id.starts_with("crypto_"));
    assert!(
        row.crypto_row_id["crypto_".len()..]
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    );
}

#[test]
fn sdk_processing_plaintext_is_absent_from_database_wal_and_shm_while_open() {
    let (_directory, path, mut store, first, _second) = setup_two_fetched_rows();
    let sdk_id_canary = b"sdk-request-id-privacy-canary-6e0f8a3e";
    let body_canary = "request-body-privacy-canary-9b1a5d7c";
    let body = request_body_with_marker(body_canary);
    let request = request_with_body(sdk_id_canary, &body);
    store
        .record_sdk_processing(&first, std::slice::from_ref(&request))
        .expect("record privacy fixture");

    let storage = sqlite_storage_bytes(&path);
    assert_storage_excludes(&storage, sdk_id_canary);
    assert_storage_excludes(&storage, body_canary.as_bytes());
}

#[test]
fn sdk_processing_survives_reopen_with_first_ciphertext_and_timestamp_intact() {
    let (_directory, path, mut store, first, _second) = setup_two_fetched_rows();
    let body = canonical_keys_query();
    let request = request_with_body(b"sdk-request-id-reopen", &body);
    store
        .record_sdk_processing(&first, std::slice::from_ref(&request))
        .expect("initial request recording");
    let before = raw_snapshot(&path);
    drop(store);

    let mut reopened = Store::open(&path, test_keyring()).expect("reopen gateway store");
    reopened
        .record_sdk_processing(&first, std::slice::from_ref(&request))
        .expect("exact retry after reopen");

    assert_snapshot_unchanged(&raw_snapshot(&path), &before);
}
