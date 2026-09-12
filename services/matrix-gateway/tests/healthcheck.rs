use std::{fs, os::unix::fs::PermissionsExt, path::PathBuf};

use chrono::{DateTime, TimeZone, Utc};
use communicator_matrix_gateway::{
    config::{MAX_PENDING_AGE_SECS, MAX_PENDING_REQUEST_ROWS, MAX_SYNC_RESPONSE_BYTES},
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

fn insert_sync_row(
    connection: &Connection,
    inbox_id: &str,
    byte_count: i64,
    state: &str,
    observed_at: &str,
) {
    connection
        .execute(
            "INSERT INTO sync_inbox
             (inbox_id, predecessor_id,
              request_token_cipher, request_token_nonce, request_token_key_version,
              request_token_digest, next_token_cipher, next_token_nonce,
              next_token_key_version, next_token_digest,
              response_cipher, response_nonce, response_key_version, response_sha256,
              byte_count, state, crypto_drained, observed_at, created_at,
              sdk_processed_at, prepared_at, committed_at, terminal_code)
             VALUES (?1, NULL, zeroblob(1), zeroblob(24), 1, randomblob(32),
                     zeroblob(1), zeroblob(24), 1, randomblob(32),
                     zeroblob(1), zeroblob(24), 1, zeroblob(32),
                     ?2, ?3, 0, ?4, ?4, NULL, NULL, NULL, NULL)",
            params![inbox_id, byte_count, state, observed_at],
        )
        .expect("insert sync fixture");
}

fn insert_crypto_row(
    connection: &Connection,
    crypto_row_id: &str,
    inbox_id: &str,
    byte_count: i64,
    state: &str,
    next_attempt_at: &str,
) {
    connection
        .execute(
            "INSERT INTO matrix_crypto_outbox
             (crypto_row_id, inbox_id, request_lookup, request_kind,
              sdk_request_id_cipher, sdk_request_id_nonce, sdk_request_id_key_version,
              request_cipher, request_nonce, request_key_version, request_sha256,
              byte_count, response_cipher, response_nonce, response_key_version,
              response_sha256, state, attempt_count, next_attempt_at,
              accepted_at, terminal_code)
             VALUES (?1, ?2, randomblob(32), 'keys_query',
                     zeroblob(1), zeroblob(24), 1, zeroblob(1), zeroblob(24), 1,
                     zeroblob(32), ?3,
                     CASE WHEN ?4 IN ('response_received', 'accepted')
                          THEN zeroblob(1) END,
                     CASE WHEN ?4 IN ('response_received', 'accepted')
                          THEN zeroblob(24) END,
                     CASE WHEN ?4 IN ('response_received', 'accepted')
                          THEN 1 END,
                     CASE WHEN ?4 IN ('response_received', 'accepted')
                          THEN zeroblob(32) END,
                     ?4, 0, ?5,
                     CASE WHEN ?4 = 'accepted' THEN ?5 END,
                     CASE WHEN ?4 = 'quarantined' THEN 'terminal' END)",
            params![crypto_row_id, inbox_id, byte_count, state, next_attempt_at,],
        )
        .expect("insert crypto fixture");
}

fn insert_quarantined_window(connection: &Connection, inbox_id: &str) {
    connection
        .execute(
            "INSERT INTO sync_windows
             (window_id, inbox_id, state, batch_count, accepted_count, ignored_count,
              created_at, committed_at, terminal_code)
             VALUES ('window_quarantine', ?1, 'quarantined', 1, 0, 0,
                     '2023-11-14T22:13:20.000Z', NULL, 'terminal')",
            [inbox_id],
        )
        .expect("insert quarantined window fixture");
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

#[test]
fn retained_sync_bytes_at_limit_block_inbox() {
    let (_directory, path, store) = bootstrap_store();
    drop(store);
    let connection = Connection::open(&path).expect("open fixture connection");
    let byte_count = i64::try_from(MAX_SYNC_RESPONSE_BYTES).expect("sync byte limit fits i64");
    for value in 0..4 {
        insert_sync_row(
            &connection,
            &format!("inbox_{value:064x}"),
            byte_count,
            "committed",
            "2023-11-14T22:13:20.000Z",
        );
    }

    let report = inspect_at(&path, timestamp(1_700_000_001_000)).expect("inspect inbox pressure");

    assert!(
        report
            .to_json()
            .contains("\"inbox_state\":\"bytes_exceeded\"")
    );
    assert!(!report.is_healthy());
}

#[test]
fn retained_committed_sync_bytes_still_count_without_age_pressure() {
    let (_directory, path, store) = bootstrap_store();
    drop(store);
    let connection = Connection::open(&path).expect("open fixture connection");
    let byte_count = i64::try_from(MAX_SYNC_RESPONSE_BYTES).expect("sync byte limit fits i64");
    for value in 0..4 {
        insert_sync_row(
            &connection,
            &format!("inbox_{value:064x}"),
            byte_count,
            "committed",
            "2023-11-14T22:13:20.000Z",
        );
    }

    let report = inspect_at(&path, timestamp(1_700_000_000_001)).expect("inspect retained bytes");

    assert!(
        report
            .to_json()
            .contains("\"inbox_state\":\"bytes_exceeded\"")
    );
    assert!(
        !report
            .to_json()
            .contains("\"inbox_state\":\"age_exceeded\"")
    );
}

#[test]
fn unresolved_sync_age_blocks_inbox() {
    let (_directory, path, store) = bootstrap_store();
    drop(store);
    let connection = Connection::open(&path).expect("open fixture connection");
    insert_sync_row(
        &connection,
        "inbox_age",
        1,
        "fetched",
        "2023-11-14T22:13:20.000Z",
    );

    let report = inspect_at(
        &path,
        timestamp(1_700_000_000_000 + (MAX_PENDING_AGE_SECS as i64 + 1) * 1_000),
    )
    .expect("inspect inbox age");

    assert!(
        report
            .to_json()
            .contains("\"inbox_state\":\"age_exceeded\"")
    );
    assert!(!report.is_healthy());
}

#[test]
fn unresolved_crypto_rows_and_parent_age_block_inbox() {
    let (_directory, path, store) = bootstrap_store();
    drop(store);
    let connection = Connection::open(&path).expect("open fixture connection");
    insert_sync_row(
        &connection,
        "inbox_crypto",
        1,
        "sdk_processed",
        "2023-11-14T22:13:20.000Z",
    );
    insert_crypto_row(
        &connection,
        "crypto_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "inbox_crypto",
        1,
        "response_received",
        "2023-11-14T22:13:20.000Z",
    );

    let report = inspect_at(
        &path,
        timestamp(1_700_000_000_000 + (MAX_PENDING_AGE_SECS as i64 + 1) * 1_000),
    )
    .expect("inspect crypto age");

    assert!(
        report
            .to_json()
            .contains("\"inbox_state\":\"age_exceeded\"")
    );
    assert!(!report.is_healthy());
}

#[test]
fn unresolved_crypto_rows_at_limit_block_inbox() {
    let (_directory, path, store) = bootstrap_store();
    drop(store);
    let connection = Connection::open(&path).expect("open fixture connection");
    connection
        .execute_batch(
            "PRAGMA foreign_keys = OFF;
             DROP INDEX one_unresolved_crypto_request",
        )
        .expect("allow bounded crypto pressure fixture");
    for value in 0..MAX_PENDING_REQUEST_ROWS {
        let inbox_id = format!("inbox_{value:064x}");
        let crypto_row_id = format!("crypto_{value:064x}");
        insert_sync_row(
            &connection,
            &inbox_id,
            1,
            "sdk_processed",
            "2023-11-14T22:13:20.000Z",
        );
        insert_crypto_row(
            &connection,
            &crypto_row_id,
            &inbox_id,
            1,
            "pending",
            "2023-11-14T22:13:20.000Z",
        );
    }

    let report = inspect_at(&path, timestamp(1_700_000_001_000)).expect("inspect crypto rows");
    let json = report.to_json();
    assert!(json.contains("\"inbox_state\":\"rows_exceeded\""));
    assert!(json.contains("\"outbox_state\":\"within_limits\""));
    assert!(!report.is_healthy());
}

#[test]
fn combined_pending_rows_block_both_states() {
    let (_directory, path, store) = bootstrap_store();
    drop(store);
    let connection = Connection::open(&path).expect("open fixture connection");
    connection
        .execute_batch("PRAGMA foreign_keys = OFF")
        .expect("disable fixture foreign keys");
    insert_sync_row(
        &connection,
        "inbox_combined_rows",
        1,
        "fetched",
        "2023-11-14T22:13:20.000Z",
    );
    insert_crypto_row(
        &connection,
        "crypto_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        "inbox_combined_rows",
        1,
        "pending",
        "2023-11-14T22:13:20.000Z",
    );
    insert_pending_outbox_rows(
        &connection,
        MAX_PENDING_REQUEST_ROWS - 1,
        1,
        "2023-11-14T22:13:20.000Z",
    );

    let report = inspect_at(&path, timestamp(1_700_000_001_000)).expect("inspect combined rows");
    let json = report.to_json();
    assert!(json.contains("\"inbox_state\":\"rows_exceeded\""));
    assert!(json.contains("\"outbox_state\":\"rows_exceeded\""));
    assert!(!report.is_healthy());
}

#[test]
fn combined_pending_bytes_block_both_states() {
    let (_directory, path, store) = bootstrap_store();
    drop(store);
    let connection = Connection::open(&path).expect("open fixture connection");
    connection
        .execute_batch("PRAGMA foreign_keys = OFF")
        .expect("disable fixture foreign keys");
    let sync_byte_count = i64::try_from(MAX_SYNC_RESPONSE_BYTES).expect("sync byte limit fits i64");
    for value in 0..3 {
        insert_sync_row(
            &connection,
            &format!("inbox_{value:064x}"),
            sync_byte_count,
            "committed",
            "2023-11-14T22:13:20.000Z",
        );
    }
    insert_pending_outbox_rows(&connection, 16, 4 * 1024 * 1024, "2023-11-14T22:13:20.000Z");

    let report = inspect_at(&path, timestamp(1_700_000_001_000)).expect("inspect combined bytes");
    let json = report.to_json();
    assert!(json.contains("\"inbox_state\":\"bytes_exceeded\""));
    assert!(json.contains("\"outbox_state\":\"bytes_exceeded\""));
    assert!(!report.is_healthy());
}

#[test]
fn missing_crypto_parent_or_invalid_inbox_value_is_corrupt() {
    for invalid_inbox in [false, true] {
        let (_directory, path, store) = bootstrap_store();
        drop(store);
        let connection = Connection::open(&path).expect("open fixture connection");
        connection
            .execute_batch("PRAGMA foreign_keys = OFF; PRAGMA ignore_check_constraints = ON")
            .expect("disable fixture constraints");
        if invalid_inbox {
            insert_sync_row(
                &connection,
                "inbox_invalid",
                1,
                "fetched",
                "2023-11-14T22:13:20.000Z",
            );
            connection
                .execute("UPDATE sync_inbox SET byte_count = 'one'", [])
                .expect("corrupt sync byte count");
        } else {
            insert_crypto_row(
                &connection,
                "crypto_missing_parent",
                "inbox_missing_parent",
                1,
                "pending",
                "2023-11-14T22:13:20.000Z",
            );
        }

        let report =
            inspect_at(&path, timestamp(1_700_000_001_000)).expect("inspect corrupt inbox fixture");
        assert!(report.to_json().contains("\"inbox_state\":\"corrupt\""));
        assert!(!report.is_healthy());
    }
}

#[test]
fn maintenance_code_persists_across_health_reopen() {
    for code in [
        "crypto_maintenance_required",
        "matrix_crypto_kind_not_allowed",
        "matrix_crypto_ack_unrecoverable",
    ] {
        let (_directory, path, store) = bootstrap_store();
        drop(store);
        let connection = Connection::open(&path).expect("open fixture connection");
        connection
            .execute(
                "UPDATE gateway_state
                 SET maintenance_code = ?1, maintenance_since = ?2
                 WHERE singleton = 1",
                params![code, "2023-11-14T22:13:20.000Z"],
            )
            .expect("persist maintenance fixture");
        drop(connection);

        let first = inspect_at(&path, timestamp(1_700_000_001_000)).expect("inspect maintenance");
        let second =
            inspect_at(&path, timestamp(1_700_000_001_000)).expect("reopen maintenance database");
        for report in [first, second] {
            let json = report.to_json();
            assert!(json.contains(&format!("\"maintenance_code\":\"{code}\"")));
            assert!(json.contains("\"terminal_quarantine\":false"));
            assert!(!report.is_healthy());
        }
    }
}

#[test]
fn terminal_quarantine_is_reported_for_crypto_window_and_batch() {
    {
        let (_directory, path, store) = bootstrap_store();
        drop(store);
        let connection = Connection::open(&path).expect("open fixture connection");
        insert_sync_row(
            &connection,
            "inbox_crypto_quarantine",
            1,
            "sdk_processed",
            "2023-11-14T22:13:20.000Z",
        );
        insert_crypto_row(
            &connection,
            "crypto_quarantine",
            "inbox_crypto_quarantine",
            1,
            "quarantined",
            "2023-11-14T22:13:20.000Z",
        );
        let report =
            inspect_at(&path, timestamp(1_700_000_001_000)).expect("inspect crypto quarantine");
        assert!(report.to_json().contains("\"terminal_quarantine\":true"));
        assert!(!report.is_healthy());
    }

    {
        let (_directory, path, store) = bootstrap_store();
        drop(store);
        let connection = Connection::open(&path).expect("open fixture connection");
        insert_sync_row(
            &connection,
            "inbox_window_quarantine",
            1,
            "fetched",
            "2023-11-14T22:13:20.000Z",
        );
        insert_quarantined_window(&connection, "inbox_window_quarantine");
        let report =
            inspect_at(&path, timestamp(1_700_000_001_000)).expect("inspect window quarantine");
        assert!(report.to_json().contains("\"terminal_quarantine\":true"));
        assert!(!report.is_healthy());
    }

    {
        let (_directory, path, store) = bootstrap_store();
        drop(store);
        let connection = Connection::open(&path).expect("open fixture connection");
        connection
            .execute_batch("PRAGMA foreign_keys = OFF; PRAGMA ignore_check_constraints = ON")
            .expect("disable batch constraints");
        insert_pending_outbox_rows(&connection, 1, 1, "2023-11-14T22:13:20.000Z");
        connection
            .execute(
                "UPDATE outbox_batches
                 SET state = 'quarantined', terminal_code = 'terminal'",
                [],
            )
            .expect("quarantine batch fixture");
        let report =
            inspect_at(&path, timestamp(1_700_000_001_000)).expect("inspect batch quarantine");
        assert!(report.to_json().contains("\"terminal_quarantine\":true"));
        assert!(!report.is_healthy());
    }
}

#[test]
fn invalid_maintenance_metadata_is_corrupt_and_content_free() {
    let updates = [
        "UPDATE gateway_state SET maintenance_code = 'unknown_code', maintenance_since = '2023-11-14T22:13:20.000Z' WHERE singleton = 1",
        "UPDATE gateway_state SET maintenance_code = NULL, maintenance_since = '2023-11-14T22:13:20.000Z' WHERE singleton = 1",
        "UPDATE gateway_state SET maintenance_code = 'crypto_maintenance_required', maintenance_since = NULL WHERE singleton = 1",
        "UPDATE gateway_state SET maintenance_code = 42, maintenance_since = '2023-11-14T22:13:20.000Z' WHERE singleton = 1",
        "UPDATE gateway_state SET maintenance_code = 'crypto_maintenance_required', maintenance_since = 'not-a-time' WHERE singleton = 1",
    ];
    for update in updates {
        let (_directory, path, store) = bootstrap_store();
        drop(store);
        let connection = Connection::open(&path).expect("open fixture connection");
        connection
            .execute_batch("PRAGMA ignore_check_constraints = ON")
            .expect("disable maintenance constraints");
        connection
            .execute(update, [])
            .expect("corrupt maintenance fixture");
        let report =
            inspect_at(&path, timestamp(1_700_000_001_000)).expect("inspect corrupt maintenance");
        let json = report.to_json();
        assert!(json.contains("\"inbox_state\":\"corrupt\""));
        assert!(json.contains("\"maintenance_code\":null"));
        assert!(!json.contains("unknown_code"));
        assert!(!report.is_healthy());
    }
}

#[test]
fn invalid_terminal_code_is_corrupt_without_quarantine_flag() {
    let (_directory, path, store) = bootstrap_store();
    drop(store);
    let connection = Connection::open(&path).expect("open fixture connection");
    connection
        .execute_batch("PRAGMA foreign_keys = OFF; PRAGMA ignore_check_constraints = ON")
        .expect("disable terminal constraints");
    insert_sync_row(
        &connection,
        "inbox_invalid_terminal",
        1,
        "sdk_processed",
        "2023-11-14T22:13:20.000Z",
    );
    insert_crypto_row(
        &connection,
        "crypto_invalid_terminal",
        "inbox_invalid_terminal",
        1,
        "quarantined",
        "2023-11-14T22:13:20.000Z",
    );
    connection
        .execute("UPDATE matrix_crypto_outbox SET terminal_code = 'BAD'", [])
        .expect("corrupt terminal code");

    let report =
        inspect_at(&path, timestamp(1_700_000_001_000)).expect("inspect invalid terminal code");
    let json = report.to_json();
    assert!(json.contains("\"inbox_state\":\"corrupt\""));
    assert!(json.contains("\"terminal_quarantine\":false"));
    assert!(!report.is_healthy());
}
