use std::{fs, os::unix::fs::PermissionsExt, path::PathBuf};

use chrono::{DateTime, TimeZone, Utc};
use communicator_matrix_gateway::{
    config::{MAX_PENDING_AGE_SECS, MAX_PENDING_REQUEST_ROWS},
    crypto::Keyring,
    health::inspect_at,
    store::Store,
    store_types::NewBootstrapState,
};
use rusqlite::{Connection, params};
use tempfile::{TempDir, tempdir};

const HEALTHY_JSON: &str = r#"{"schema_version":1,"status":"healthy","session":"present","inbox_state":"within_limits","outbox_state":"within_limits","maintenance_code":null,"terminal_quarantine":false}"#;
const MISSING_SESSION_JSON: &str = r#"{"schema_version":1,"status":"blocked","session":"missing","inbox_state":"within_limits","outbox_state":"within_limits","maintenance_code":null,"terminal_quarantine":false}"#;

fn timestamp(milliseconds: i64) -> DateTime<Utc> {
    Utc.timestamp_millis_opt(milliseconds)
        .single()
        .expect("valid test timestamp")
}

fn bootstrap_store() -> (TempDir, PathBuf, Store) {
    let directory = tempdir().expect("create test directory");
    fs::set_permissions(directory.path(), fs::Permissions::from_mode(0o700))
        .expect("secure test directory");
    let path = directory.path().join("gateway.sqlite3");
    let mut store = Store::open(&path, Keyring::new([0x11; 32], 1).expect("test keyring"))
        .expect("open test store");
    store
        .initialize_bootstrap_state(
            NewBootstrapState::new(
                b"matrix-session".to_vec(),
                b"initial-token".to_vec(),
                Vec::new(),
                timestamp(1_700_000_000_000),
            )
            .expect("construct bootstrap state"),
        )
        .expect("initialize bootstrap state");
    (directory, path, store)
}

fn empty_store() -> (TempDir, PathBuf, Store) {
    let directory = tempdir().expect("create test directory");
    fs::set_permissions(directory.path(), fs::Permissions::from_mode(0o700))
        .expect("secure test directory");
    let path = directory.path().join("gateway.sqlite3");
    let store = Store::open(&path, Keyring::new([0x11; 32], 1).expect("test keyring"))
        .expect("open test store");
    (directory, path, store)
}

fn insert_pending_outbox_rows(
    connection: &Connection,
    row_count: u64,
    byte_count: i64,
    next_attempt_at: &str,
) {
    connection
        .execute(
            "WITH RECURSIVE numbers(value) AS (
                 SELECT 0
                 UNION ALL SELECT value + 1 FROM numbers
                 WHERE value + 1 < ?1
             )
             INSERT INTO outbox_batches
             (batch_row_id, source_kind, window_id, backfill_job_id, ordinal, state,
              request_cipher, request_nonce, request_key_version, request_sha256,
              byte_count, attempt_count, next_attempt_at, accepted_at, terminal_code)
             SELECT 'batch_' || printf('%064x', value), 'live',
                    'window_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
                    NULL, value, 'pending', zeroblob(16), zeroblob(24), 1, zeroblob(32),
                    ?2, 0, ?3, NULL, NULL
             FROM numbers",
            params![
                i64::try_from(row_count).expect("test row count fits SQLite"),
                byte_count,
                next_attempt_at,
            ],
        )
        .expect("insert outbox fixtures");
}

#[test]
fn healthy_bootstrap_has_exact_compact_json_and_key_order() {
    let (_directory, path, _store) = bootstrap_store();

    let report = inspect_at(&path, timestamp(1_700_000_001_000)).expect("inspect healthy store");

    assert_eq!(report.to_json(), HEALTHY_JSON);
}

#[test]
fn missing_session_is_blocked() {
    let (_directory, path, _store) = empty_store();

    let report = inspect_at(&path, timestamp(1_700_000_001_000)).expect("inspect empty store");

    assert_eq!(report.to_json(), MISSING_SESSION_JSON);
}

#[test]
fn pending_outbox_bytes_at_limit_are_blocked() {
    let (_directory, path, store) = bootstrap_store();
    drop(store);
    let connection = Connection::open(&path).expect("open fixture connection");
    connection
        .execute_batch("PRAGMA foreign_keys = OFF")
        .expect("disable fixture foreign keys");
    connection
        .execute(
            "WITH RECURSIVE numbers(value) AS (
                 SELECT 0
                 UNION ALL SELECT value + 1 FROM numbers WHERE value < 63
             )
             INSERT INTO outbox_batches
             (batch_row_id, source_kind, window_id, backfill_job_id, ordinal, state,
              request_cipher, request_nonce, request_key_version, request_sha256,
              byte_count, attempt_count, next_attempt_at, accepted_at, terminal_code)
             SELECT 'batch_' || printf('%064x', value), 'live',
                    'window_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
                    NULL, value, 'pending', zeroblob(16), zeroblob(24), 1, zeroblob(32),
                    4194304, 0, '2023-11-14T22:13:20.000Z', NULL, NULL
             FROM numbers",
            [],
        )
        .expect("insert pressure fixtures");

    let report = inspect_at(&path, timestamp(1_700_000_001_000)).expect("inspect pressured store");

    assert!(
        report
            .to_json()
            .contains("\"outbox_state\":\"bytes_exceeded\"")
    );
    assert!(!report.is_healthy());
}

#[test]
fn pending_outbox_rows_at_limit_are_blocked() {
    let (_directory, path, store) = bootstrap_store();
    drop(store);
    let connection = Connection::open(&path).expect("open fixture connection");
    connection
        .execute_batch("PRAGMA foreign_keys = OFF")
        .expect("disable fixture foreign keys");
    insert_pending_outbox_rows(
        &connection,
        MAX_PENDING_REQUEST_ROWS,
        1,
        "2023-11-14T22:13:20.000Z",
    );

    let report = inspect_at(&path, timestamp(1_700_000_001_000)).expect("inspect pressured store");

    assert!(
        report
            .to_json()
            .contains("\"outbox_state\":\"rows_exceeded\"")
    );
    assert!(!report.is_healthy());
}

#[test]
fn pending_outbox_age_allows_exact_limit_and_blocks_afterward() {
    let (_directory, path, store) = bootstrap_store();
    drop(store);
    let connection = Connection::open(&path).expect("open fixture connection");
    connection
        .execute_batch("PRAGMA foreign_keys = OFF")
        .expect("disable fixture foreign keys");
    insert_pending_outbox_rows(&connection, 1, 1, "2023-11-14T22:13:20.000Z");
    drop(connection);

    let exact_limit = timestamp(
        1_700_000_000_000 + i64::try_from(MAX_PENDING_AGE_SECS).expect("test age fits i64") * 1_000,
    );
    let report = inspect_at(&path, exact_limit).expect("inspect exact age boundary");
    assert!(report.is_healthy());

    let report = inspect_at(&path, timestamp(exact_limit.timestamp_millis() + 1))
        .expect("inspect overdue store");
    assert!(
        report
            .to_json()
            .contains("\"outbox_state\":\"age_exceeded\"")
    );
    assert!(!report.is_healthy());
}

#[test]
fn invalid_outbox_numeric_or_timestamp_is_corrupt() {
    for update in [
        "UPDATE outbox_batches SET byte_count = 'one'",
        "UPDATE outbox_batches SET next_attempt_at = 42",
    ] {
        let (_directory, path, store) = bootstrap_store();
        drop(store);
        let connection = Connection::open(&path).expect("open fixture connection");
        connection
            .execute_batch("PRAGMA foreign_keys = OFF")
            .expect("disable fixture foreign keys");
        insert_pending_outbox_rows(&connection, 1, 1, "2023-11-14T22:13:20.000Z");
        connection
            .execute(update, [])
            .expect("corrupt fixture column");
        drop(connection);

        let report = inspect_at(&path, timestamp(1_700_000_001_000))
            .expect("inspect corrupt outbox fixture");
        assert!(report.to_json().contains("\"outbox_state\":\"corrupt\""));
        assert!(!report.is_healthy());
    }
}

#[test]
fn unknown_outbox_lifecycle_or_source_is_corrupt() {
    for update in [
        "UPDATE outbox_batches SET state = 'future'",
        "UPDATE outbox_batches SET source_kind = 'other'",
    ] {
        let (_directory, path, store) = bootstrap_store();
        drop(store);
        let connection = Connection::open(&path).expect("open fixture connection");
        connection
            .execute_batch(
                "PRAGMA foreign_keys = OFF;
                 PRAGMA ignore_check_constraints = ON",
            )
            .expect("disable fixture constraints");
        insert_pending_outbox_rows(&connection, 1, 1, "2023-11-14T22:13:20.000Z");
        connection
            .execute(update, [])
            .expect("corrupt fixture state");
        drop(connection);

        let report = inspect_at(&path, timestamp(1_700_000_001_000))
            .expect("inspect corrupt outbox fixture");
        assert!(report.to_json().contains("\"outbox_state\":\"corrupt\""));
        assert!(!report.is_healthy());
    }
}
