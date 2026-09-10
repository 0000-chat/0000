use std::{
    fs,
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
};

use chrono::{DateTime, Duration, TimeZone, Utc};
use communicator_matrix_gateway::{
    batch::{BackfillJob, BatchWindow, RoutedEvent, WindowSource, build_window},
    crypto::Keyring,
    ledger::{STORE_LEDGER_CAS_MISMATCH, STORE_LEDGER_CORRUPT, STORE_LEDGER_INVALID},
    model::{
        CanonicalEvent, CanonicalEventSource, CanonicalPayload, DeliveryStatus, Direction,
        MessageCreatedPayload, Provider,
    },
    store::Store,
    store_types::{NewBootstrapState, NewRawSyncInbox},
};
use rusqlite::{Connection, params};
use sha2::{Digest, Sha256};
use tempfile::{TempDir, tempdir};

const INITIAL_TOKEN: &[u8] = b"initial-token";
const NEXT_TOKEN: &[u8] = b"next-token";
const ARCHIVED_AT_MILLIS: i64 = 1_757_550_123_000;
const CAS_NEXT_MILLIS: i64 = ARCHIVED_AT_MILLIS + 1_000;
const EXPLICIT_JOB_ID: &str = "019f0000-0000-7000-8000-000000000001";

fn timestamp(milliseconds: i64) -> DateTime<Utc> {
    Utc.timestamp_millis_opt(milliseconds)
        .single()
        .expect("valid test timestamp")
}

fn test_keyring() -> Keyring {
    Keyring::new([0x11; 32], 1).expect("construct test keyring")
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

fn expected_window_id(inbox_id: &str) -> String {
    let digest = test_keyring()
        .lookup_digest("matrix-live-window-v1", &[inbox_id])
        .expect("derive deterministic window ID");
    format!(
        "window_{}",
        digest
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>()
    )
}

fn setup_processed_row(drain_crypto: bool) -> (TempDir, PathBuf, Store, String) {
    let directory = secure_tempdir();
    let path = database_path(directory.path());
    let mut store = Store::open(&path, test_keyring()).expect("open store");
    store
        .initialize_bootstrap_state(
            NewBootstrapState::new(
                b"matrix-session".to_vec(),
                INITIAL_TOKEN.to_vec(),
                Vec::new(),
                timestamp(1_725_000_000_000),
            )
            .expect("bootstrap state"),
        )
        .expect("initialize bootstrap state");
    let inbox_id = store
        .append_fetched_sync(
            NewRawSyncInbox::new(
                INITIAL_TOKEN.to_vec(),
                NEXT_TOKEN.to_vec(),
                b"raw-sync-response".to_vec(),
                timestamp(1_725_000_001_000),
            )
            .expect("raw sync response"),
        )
        .expect("append raw response")
        .as_str()
        .to_owned();
    store
        .record_sdk_processing(&inbox_id, &[])
        .expect("SDK processing");
    if drain_crypto {
        store.mark_crypto_drained(&inbox_id).expect("crypto drain");
    }
    (directory, path, store, inbox_id)
}

fn message_event(index: usize, body: &str) -> CanonicalEvent {
    CanonicalEvent::new(
        format!("$event_live_delivery_{index:04}:example.org"),
        CanonicalEventSource::Live,
        "tenant_demo",
        "identity_demo",
        Provider::Whatsapp,
        "account_demo",
        "conversation_demo",
        Some("!room:example.org".to_owned()),
        Some(format!("$event_live_delivery_{index:04}:example.org")),
        None,
        "2026-09-11T01:02:02.000Z",
        "2026-09-11T01:02:03.000Z",
        CanonicalPayload::MessageCreated(MessageCreatedPayload {
            message_id: format!("message_{index:064x}"),
            direction: Direction::Inbound,
            sender_participant_id: Some(
                "participant_0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
                    .to_owned(),
            ),
            sender_label: "Alice".to_owned(),
            body: body.to_owned(),
            reply_to_message_id: None,
            delivery_status: DeliveryStatus::Unknown,
            unread: true,
        }),
    )
    .expect("valid canonical event")
}

fn live_window(event_count: usize, archived_at: i64) -> BatchWindow {
    let events = (0..event_count)
        .map(|index| RoutedEvent::new("route_demo", message_event(index, &format!("body-{index}"))))
        .collect::<Vec<_>>();
    build_window(
        WindowSource::live(NEXT_TOKEN),
        timestamp(archived_at),
        &events,
    )
    .expect("valid live batch window")
}

fn prepare_live_window(store: &mut Store, inbox_id: &str, event_count: usize) -> BatchWindow {
    let window_id = expected_window_id(inbox_id);
    let window = live_window(event_count, ARCHIVED_AT_MILLIS);
    store
        .create_collecting_live_window(
            inbox_id,
            communicator_matrix_gateway::ledger::NewLiveWindow::new(
                window_id,
                timestamp(ARCHIVED_AT_MILLIS),
                0,
            )
            .expect("valid collecting window"),
        )
        .expect("create collecting window");
    store
        .finalize_live_window(inbox_id, &expected_window_id(inbox_id), &window, &[], &[])
        .expect("finalize live window");
    window
}

fn seed_explicit_backfill(path: &Path) {
    let keyring = test_keyring();
    let job = BackfillJob::new(
        EXPLICIT_JOB_ID,
        "!room:example.org",
        "2026-09-01T00:00:00.000Z",
        "2026-09-02T00:00:00.000Z",
        10,
    )
    .expect("valid explicit job");
    let window = build_window(
        job.checkpoint(0),
        timestamp(ARCHIVED_AT_MILLIS),
        &[RoutedEvent::new(
            "route_demo",
            message_event(900, "explicit-backfill"),
        )],
    )
    .expect("valid explicit batch");
    let batch = &window.batches[0];
    let parameters = keyring
        .seal(
            "backfill_jobs",
            EXPLICIT_JOB_ID,
            "parameters",
            b"parameters",
        )
        .expect("seal explicit parameters");
    let request = keyring
        .seal(
            "outbox_batches",
            &batch.batch_id,
            "request",
            batch.exact_request_bytes(),
        )
        .expect("seal explicit request");
    let digest: [u8; 32] = Sha256::digest(batch.exact_request_bytes()).into();
    let connection = Connection::open(path).expect("open sqlite setup connection");
    connection
        .execute(
            "INSERT INTO backfill_jobs
             (job_id, kind, live_window_id, state, parameters_cipher, parameters_nonce,
              pagination_cipher, pagination_nonce, key_version, accepted_events, created_at,
              completed_at, cancelled_at, terminal_code)
             VALUES (?1, 'explicit', NULL, 'pending', ?2, ?3, NULL, NULL, ?4, 0, ?5,
                     NULL, NULL, NULL)",
            params![
                EXPLICIT_JOB_ID,
                parameters.ciphertext,
                parameters.nonce.as_slice(),
                i64::from(parameters.key_version),
                timestamp(ARCHIVED_AT_MILLIS).to_rfc3339(),
            ],
        )
        .expect("seed explicit job");
    connection
        .execute(
            "INSERT INTO outbox_batches
             (batch_row_id, source_kind, window_id, backfill_job_id, ordinal, state,
              request_cipher, request_nonce, request_key_version, request_sha256,
              byte_count, attempt_count, next_attempt_at, accepted_at, terminal_code)
             VALUES (?1, 'backfill', NULL, ?2, 0, 'pending', ?3, ?4, ?5, ?6, ?7, 0, ?8,
                     NULL, NULL)",
            params![
                batch.batch_id,
                EXPLICIT_JOB_ID,
                request.ciphertext,
                request.nonce.as_slice(),
                i64::from(request.key_version),
                digest.as_slice(),
                i64::try_from(batch.exact_request_bytes().len()).expect("request fits SQLite"),
                timestamp(ARCHIVED_AT_MILLIS).to_rfc3339(),
            ],
        )
        .expect("seed explicit outbox row");
}

fn seed_pending_live_window(path: &Path, inbox_id: &str, window: &BatchWindow) {
    let window_id = expected_window_id(inbox_id);
    let batch = &window.batches[0];
    let request = test_keyring()
        .seal(
            "outbox_batches",
            &batch.batch_id,
            "request",
            batch.exact_request_bytes(),
        )
        .expect("seal live request");
    let digest: [u8; 32] = Sha256::digest(batch.exact_request_bytes()).into();
    let connection = Connection::open(path).expect("open sqlite setup connection");
    connection
        .execute(
            "UPDATE sync_inbox SET state = 'prepared', prepared_at = ?1
             WHERE inbox_id = ?2 AND state = 'sdk_processed' AND crypto_drained = 1",
            params![timestamp(ARCHIVED_AT_MILLIS).to_rfc3339(), inbox_id],
        )
        .expect("prepare second inbox row");
    connection
        .execute(
            "INSERT INTO sync_windows
             (window_id, inbox_id, state, batch_count, accepted_count, ignored_count,
              created_at, committed_at, terminal_code)
             VALUES (?1, ?2, 'pending', 1, 0, 0, ?3, NULL, NULL)",
            params![
                window_id,
                inbox_id,
                timestamp(ARCHIVED_AT_MILLIS).to_rfc3339(),
            ],
        )
        .expect("seed pending live window");
    connection
        .execute(
            "INSERT INTO outbox_batches
             (batch_row_id, source_kind, window_id, backfill_job_id, ordinal, state,
              request_cipher, request_nonce, request_key_version, request_sha256,
              byte_count, attempt_count, next_attempt_at, accepted_at, terminal_code)
             VALUES (?1, 'live', ?2, NULL, 0, 'pending', ?3, ?4, ?5, ?6, ?7, 0, ?8,
                     NULL, NULL)",
            params![
                batch.batch_id,
                window_id,
                request.ciphertext,
                request.nonce.as_slice(),
                i64::from(request.key_version),
                digest.as_slice(),
                i64::try_from(batch.exact_request_bytes().len()).expect("request fits SQLite"),
                window.archived_at,
            ],
        )
        .expect("seed pending live outbox row");
}

fn outbox_schedule(path: &Path, row_id: &str) -> (i64, String) {
    Connection::open(path)
        .expect("open sqlite inspection connection")
        .query_row(
            "SELECT attempt_count, next_attempt_at FROM outbox_batches WHERE batch_row_id = ?1",
            [row_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .expect("read outbox schedule")
}

fn assert_code(error: communicator_matrix_gateway::secret::SafeError, code: &str) {
    assert_eq!(error.code(), code);
}

#[test]
fn selects_due_live_batch_before_explicit_and_replays_exact_bytes_after_retry_and_reopen() {
    let (_directory, path, mut store, inbox_id) = setup_processed_row(true);
    let window = prepare_live_window(&mut store, &inbox_id, 1);
    seed_explicit_backfill(&path);
    let batch = &window.batches[0];
    let due = timestamp(ARCHIVED_AT_MILLIS);

    let selected = store
        .next_pending_ingestion_batch(timestamp(CAS_NEXT_MILLIS))
        .expect("select due live batch")
        .expect("live row is available");
    assert_eq!(selected.row_id(), batch.batch_id);
    assert_eq!(selected.batch().tenant_id(), "tenant_demo");
    assert_eq!(
        selected.batch().exact_request_bytes(),
        batch.exact_request_bytes()
    );
    assert_eq!(selected.attempt_count(), 0);
    assert_eq!(selected.next_attempt_at(), &due);

    store
        .record_ingestion_attempt(
            selected.row_id(),
            selected.attempt_count(),
            *selected.next_attempt_at(),
            due,
            timestamp(CAS_NEXT_MILLIS),
        )
        .expect("record first delivery attempt");
    assert_eq!(outbox_schedule(&path, selected.row_id()).0, 1);

    drop(store);
    let reopened = Store::open(&path, test_keyring()).expect("reopen store");
    let retried = reopened
        .next_pending_ingestion_batch(timestamp(CAS_NEXT_MILLIS))
        .expect("select retried live batch")
        .expect("retried row is available at its due time");
    assert_eq!(retried.row_id(), batch.batch_id);
    assert_eq!(
        retried.batch().exact_request_bytes(),
        batch.exact_request_bytes()
    );
    assert_eq!(retried.attempt_count(), 1);
    assert_eq!(retried.next_attempt_at(), &timestamp(CAS_NEXT_MILLIS));
}

#[test]
fn selects_pending_rows_by_ordinal_but_skips_a_later_due_row_when_earlier_is_not_due() {
    let (_directory, path, mut store, inbox_id) = setup_processed_row(true);
    let window = prepare_live_window(&mut store, &inbox_id, 501);
    assert_eq!(window.batches.len(), 2, "fixture must create two batches");
    let first = &window.batches[0];
    let second = &window.batches[1];
    let connection = Connection::open(&path).expect("open sqlite setup connection");
    connection
        .execute(
            "UPDATE outbox_batches SET next_attempt_at = ?1 WHERE batch_row_id = ?2",
            params![
                timestamp(CAS_NEXT_MILLIS + 10_000).to_rfc3339(),
                first.batch_id
            ],
        )
        .expect("make ordinal-zero row not due");
    connection
        .execute(
            "UPDATE outbox_batches SET next_attempt_at = ?1 WHERE batch_row_id = ?2",
            params![timestamp(ARCHIVED_AT_MILLIS).to_rfc3339(), second.batch_id],
        )
        .expect("make ordinal-one row due");

    let selected = store
        .next_pending_ingestion_batch(timestamp(CAS_NEXT_MILLIS))
        .expect("select due row")
        .expect("later row is due");
    assert_eq!(selected.row_id(), second.batch_id);

    connection
        .execute(
            "UPDATE outbox_batches SET next_attempt_at = ?1 WHERE batch_row_id = ?2",
            params![timestamp(ARCHIVED_AT_MILLIS).to_rfc3339(), first.batch_id],
        )
        .expect("make ordinal-zero row due");
    let selected = store
        .next_pending_ingestion_batch(timestamp(CAS_NEXT_MILLIS))
        .expect("select lowest ordinal due row")
        .expect("ordinal-zero row is now due");
    assert_eq!(selected.row_id(), first.batch_id);
}

#[test]
fn blocks_a_newer_pending_live_window_behind_the_oldest_uncommitted_window() {
    let (_directory, path, mut store, first_inbox_id) = setup_processed_row(true);
    let first_window = prepare_live_window(&mut store, &first_inbox_id, 1);
    let second_inbox_id = store
        .append_fetched_sync(
            NewRawSyncInbox::new(
                NEXT_TOKEN.to_vec(),
                b"newer-token".to_vec(),
                b"newer-response".to_vec(),
                timestamp(1_725_000_002_000),
            )
            .expect("newer raw sync response"),
        )
        .expect("append newer response")
        .as_str()
        .to_owned();
    store
        .record_sdk_processing(&second_inbox_id, &[])
        .expect("process newer response");
    store
        .mark_crypto_drained(&second_inbox_id)
        .expect("drain newer response crypto");
    let second_window = build_window(
        WindowSource::live(b"newer-token"),
        timestamp(ARCHIVED_AT_MILLIS),
        &[RoutedEvent::new("route_demo", message_event(901, "newer"))],
    )
    .expect("valid newer live window");
    seed_pending_live_window(&path, &second_inbox_id, &second_window);

    let selected = store
        .next_pending_ingestion_batch(timestamp(CAS_NEXT_MILLIS))
        .expect("select oldest live window")
        .expect("oldest live row is due");
    assert_eq!(selected.row_id(), first_window.batches[0].batch_id);
}

#[test]
fn returns_none_for_collecting_undrained_and_quarantined_live_windows() {
    let (_directory, _path, mut store, inbox_id) = setup_processed_row(true);
    store
        .create_collecting_live_window(
            &inbox_id,
            communicator_matrix_gateway::ledger::NewLiveWindow::new(
                expected_window_id(&inbox_id),
                timestamp(ARCHIVED_AT_MILLIS),
                0,
            )
            .expect("valid collecting window"),
        )
        .expect("create collecting window");
    assert!(
        store
            .next_pending_ingestion_batch(timestamp(CAS_NEXT_MILLIS))
            .expect("collecting window is not ready")
            .is_none()
    );

    let (_directory, _path, store, _inbox_id) = setup_processed_row(false);
    assert!(
        store
            .next_pending_ingestion_batch(timestamp(CAS_NEXT_MILLIS))
            .expect("undrained inbox is not ready")
            .is_none()
    );

    let (_directory, path, mut store, inbox_id) = setup_processed_row(true);
    let window = prepare_live_window(&mut store, &inbox_id, 1);
    let window_id = expected_window_id(&inbox_id);
    let row_id = window.batches[0].batch_id.clone();
    let connection = Connection::open(&path).expect("open sqlite quarantine setup connection");
    connection
        .execute(
            "UPDATE sync_inbox SET state = 'quarantined', terminal_code = 'delivery_failed'
             WHERE inbox_id = ?1",
            [&inbox_id],
        )
        .expect("quarantine inbox row");
    connection
        .execute(
            "UPDATE sync_windows SET state = 'quarantined', terminal_code = 'delivery_failed'
             WHERE window_id = ?1",
            [&window_id],
        )
        .expect("quarantine window row");
    connection
        .execute(
            "UPDATE outbox_batches SET state = 'quarantined', terminal_code = 'delivery_failed'
             WHERE batch_row_id = ?1",
            [&row_id],
        )
        .expect("quarantine outbox row");
    assert!(
        store
            .next_pending_ingestion_batch(timestamp(CAS_NEXT_MILLIS))
            .expect("quarantined window is not ready")
            .is_none()
    );
}

#[test]
fn cas_rejects_invalid_boundaries_and_stale_or_duplicate_workers_without_change() {
    let (_directory, path, mut store, inbox_id) = setup_processed_row(true);
    let window = prepare_live_window(&mut store, &inbox_id, 1);
    let row_id = window.batches[0].batch_id.as_str();
    let due = timestamp(ARCHIVED_AT_MILLIS);
    let next = timestamp(CAS_NEXT_MILLIS);

    assert_code(
        store
            .record_ingestion_attempt("not-a-batch-id", 0, due, due, next)
            .expect_err("invalid row ID"),
        STORE_LEDGER_INVALID,
    );
    assert_code(
        store
            .record_ingestion_attempt(row_id, 0, due, due + Duration::nanoseconds(1), next)
            .expect_err("sub-millisecond attempted timestamp"),
        STORE_LEDGER_INVALID,
    );
    assert_code(
        store
            .record_ingestion_attempt(row_id, 0, due, due - Duration::milliseconds(1), next)
            .expect_err("attempt before due"),
        STORE_LEDGER_INVALID,
    );
    assert_code(
        store
            .record_ingestion_attempt(row_id, 0, due, due, due)
            .expect_err("next attempt must be later"),
        STORE_LEDGER_INVALID,
    );

    store
        .record_ingestion_attempt(row_id, 0, due, due, next)
        .expect("first CAS succeeds");
    let after_success = outbox_schedule(&path, row_id);
    assert_eq!(after_success, (1, next.to_rfc3339()));

    assert_code(
        store
            .record_ingestion_attempt(row_id, 0, due, due, next + Duration::seconds(1))
            .expect_err("stale worker must lose CAS"),
        STORE_LEDGER_CAS_MISMATCH,
    );
    assert_eq!(outbox_schedule(&path, row_id), after_success);
    assert_code(
        store
            .record_ingestion_attempt(row_id, 0, due, due, next + Duration::seconds(1))
            .expect_err("duplicate worker with old due must lose CAS"),
        STORE_LEDGER_CAS_MISMATCH,
    );
    assert_eq!(outbox_schedule(&path, row_id), after_success);
}

#[test]
fn corrupt_request_digest_fails_closed_for_selection_and_cas_without_mutation() {
    let (_directory, path, mut store, inbox_id) = setup_processed_row(true);
    let window = prepare_live_window(&mut store, &inbox_id, 1);
    let row_id = window.batches[0].batch_id.clone();
    let before = outbox_schedule(&path, &row_id);
    Connection::open(&path)
        .expect("open sqlite corruption setup connection")
        .execute(
            "UPDATE outbox_batches SET request_sha256 = zeroblob(32) WHERE batch_row_id = ?1",
            [&row_id],
        )
        .expect("tamper request digest");

    assert_code(
        store
            .next_pending_ingestion_batch(timestamp(CAS_NEXT_MILLIS))
            .expect_err("tampered request must fail closed"),
        STORE_LEDGER_CORRUPT,
    );
    assert_code(
        store
            .record_ingestion_attempt(
                &row_id,
                0,
                timestamp(ARCHIVED_AT_MILLIS),
                timestamp(ARCHIVED_AT_MILLIS),
                timestamp(CAS_NEXT_MILLIS),
            )
            .expect_err("CAS must validate before mutation"),
        STORE_LEDGER_CORRUPT,
    );
    assert_eq!(outbox_schedule(&path, &row_id), before);
}

#[test]
fn reopened_store_returns_none_until_due_and_preserves_attempt_state() {
    let (_directory, path, mut store, inbox_id) = setup_processed_row(true);
    let window = prepare_live_window(&mut store, &inbox_id, 1);
    let row_id = window.batches[0].batch_id.clone();
    drop(store);

    let reopened = Store::open(&path, test_keyring()).expect("reopen store");
    assert!(
        reopened
            .next_pending_ingestion_batch(timestamp(ARCHIVED_AT_MILLIS - 1))
            .expect("not-yet-due selection")
            .is_none()
    );
    let selected = reopened
        .next_pending_ingestion_batch(timestamp(ARCHIVED_AT_MILLIS))
        .expect("due selection after reopen")
        .expect("pending row is due");
    assert_eq!(selected.row_id(), row_id);
    assert_eq!(selected.attempt_count(), 0);
    assert_eq!(
        selected.batch().exact_request_bytes(),
        window.batches[0].exact_request_bytes()
    );
}
