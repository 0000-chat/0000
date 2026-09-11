use std::{
    fs,
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
};

use chrono::{DateTime, Duration, TimeZone, Utc};
use communicator_matrix_gateway::{
    batch::{RoutedEvent, WindowSource, build_window},
    crypto::Keyring,
    ledger::{
        LiveCommitOutcome, NewLiveWindow, STORE_LEDGER_CONFLICT, STORE_LEDGER_CORRUPT,
        STORE_LEDGER_INVALID, STORE_LEDGER_NOT_READY,
    },
    model::{
        CanonicalEvent, CanonicalEventSource, CanonicalPayload, DeliveryStatus, Direction,
        MessageCreatedPayload, Provider,
    },
    store::Store,
    store_types::{NewBootstrapState, NewRawSyncInbox, ReasonCode},
};
use rusqlite::Connection;
use tempfile::{TempDir, tempdir};

const INITIAL_TOKEN: &[u8] = b"initial-token";
const NEXT_TOKEN: &[u8] = b"next-token";
const OBSERVED_AT: i64 = 1_725_000_001_000;
const ARCHIVED_AT: i64 = 1_757_550_123_000;

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
    let hex = digest
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    format!("window_{hex}")
}

fn message_event_at(index: usize, body: &str) -> CanonicalEvent {
    CanonicalEvent::new(
        format!("$event_live_recovery_{index:04}:example.org"),
        CanonicalEventSource::Live,
        "tenant_demo",
        "identity_demo",
        Provider::Whatsapp,
        "account_demo",
        "conversation_demo",
        Some("!room:example.org".to_owned()),
        Some(format!("$event_live_recovery_{index:04}:example.org")),
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

fn setup_pending_window() -> (TempDir, PathBuf, Store, String, String) {
    setup_pending_window_with_event_count(1)
}

fn setup_pending_window_with_event_count(
    event_count: usize,
) -> (TempDir, PathBuf, Store, String, String) {
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
                timestamp(OBSERVED_AT),
            )
            .expect("raw sync response"),
        )
        .expect("append raw response")
        .as_str()
        .to_owned();
    store
        .record_sdk_processing(&inbox_id, &[])
        .expect("SDK processing");
    store.mark_crypto_drained(&inbox_id).expect("crypto drain");

    let window_id = expected_window_id(&inbox_id);
    store
        .create_collecting_live_window(
            &inbox_id,
            NewLiveWindow::new(window_id.clone(), timestamp(ARCHIVED_AT), 0)
                .expect("collecting window"),
        )
        .expect("create collecting window");
    let events = (0..event_count)
        .map(|index| {
            RoutedEvent::new(
                "route_demo",
                message_event_at(index, &format!("recovery-body-{index}")),
            )
        })
        .collect::<Vec<_>>();
    let window = build_window(
        WindowSource::live(NEXT_TOKEN),
        timestamp(ARCHIVED_AT),
        &events,
    )
    .expect("valid live window");
    let row_id = window.batches[0].batch_id.clone();
    store
        .finalize_live_window(&inbox_id, &window_id, &window, &[], &[])
        .expect("prepare live window");
    (directory, path, store, inbox_id, row_id)
}

fn assert_code(error: communicator_matrix_gateway::secret::SafeError, code: &str) {
    assert_eq!(error.code(), code);
}

fn live_states(path: &Path) -> Vec<(i64, String, Option<String>, Option<String>)> {
    let connection = Connection::open(path).expect("open state inspection connection");
    let mut statement = connection
        .prepare(
            "SELECT ordinal, state, accepted_at, terminal_code
             FROM outbox_batches WHERE source_kind = 'live' ORDER BY ordinal",
        )
        .expect("prepare state inspection");
    statement
        .query_map([], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
        })
        .expect("query state inspection")
        .collect::<Result<Vec<_>, _>>()
        .expect("collect state inspection")
}

#[test]
fn quarantines_and_retries_one_pending_live_batch_through_public_store_methods() {
    let (_directory, path, mut store, inbox_id, row_id) = setup_pending_window();
    let window_id = expected_window_id(&inbox_id);
    let reason = ReasonCode::new("delivery_failed").expect("valid quarantine reason");

    store
        .quarantine_live_batch(&row_id, reason)
        .expect("quarantine pending live row");

    let states: (
        String,
        String,
        String,
        Option<String>,
        Option<String>,
        Option<String>,
    ) = Connection::open(&path)
        .expect("open postcondition connection")
        .query_row(
            "SELECT i.state, w.state, o.state, i.terminal_code, w.terminal_code,
                        o.terminal_code
                 FROM sync_inbox i
                 JOIN sync_windows w ON w.inbox_id = i.inbox_id
                 JOIN outbox_batches o ON o.window_id = w.window_id",
            [],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                    row.get(5)?,
                ))
            },
        )
        .expect("read quarantine state");
    assert_eq!(
        states,
        (
            "quarantined".to_owned(),
            "quarantined".to_owned(),
            "quarantined".to_owned(),
            Some("delivery_failed".to_owned()),
            Some("delivery_failed".to_owned()),
            Some("delivery_failed".to_owned()),
        )
    );

    store
        .retry_quarantined_window(&window_id, timestamp(ARCHIVED_AT + 10_000))
        .expect("retry quarantined live window");
    let states: (
        String,
        String,
        String,
        Option<String>,
        Option<String>,
        Option<String>,
    ) = Connection::open(&path)
        .expect("open retry postcondition connection")
        .query_row(
            "SELECT i.state, w.state, o.state, i.terminal_code, w.terminal_code,
                        o.terminal_code
                 FROM sync_inbox i
                 JOIN sync_windows w ON w.inbox_id = i.inbox_id
                 JOIN outbox_batches o ON o.window_id = w.window_id",
            [],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                    row.get(5)?,
                ))
            },
        )
        .expect("read retry state");
    assert_eq!(
        states,
        (
            "prepared".to_owned(),
            "pending".to_owned(),
            "pending".to_owned(),
            None,
            None,
            None,
        )
    );
    assert!(
        store
            .next_pending_ingestion_batch(timestamp(ARCHIVED_AT + 9_999))
            .expect("retry row is not due yet")
            .is_none()
    );
    assert_eq!(
        store
            .next_pending_ingestion_batch(timestamp(ARCHIVED_AT + 10_000))
            .expect("retry row is due")
            .expect("pending retry row")
            .row_id(),
        row_id
    );
}

#[test]
fn quarantine_same_reason_is_idempotent_but_different_reason_conflicts() {
    let (_directory, path, mut store, _inbox_id, row_id) = setup_pending_window();
    let reason = || ReasonCode::new("delivery_failed").expect("valid quarantine reason");

    store
        .quarantine_live_batch(&row_id, reason())
        .expect("initial quarantine");
    let quarantined = live_states(&path);

    store
        .quarantine_live_batch(&row_id, reason())
        .expect("same reason quarantine is idempotent");
    assert_eq!(live_states(&path), quarantined);

    assert_code(
        store
            .quarantine_live_batch(
                &row_id,
                ReasonCode::new("transport_failed").expect("valid alternate reason"),
            )
            .expect_err("different reason must conflict"),
        STORE_LEDGER_CONFLICT,
    );
    assert_eq!(live_states(&path), quarantined);
}

#[test]
fn quarantine_preserves_siblings_and_retry_reopens_after_reopen_without_moving_tokens() {
    let (_directory, path, mut store, inbox_id, first_row_id) =
        setup_pending_window_with_event_count(501);
    let window_id = expected_window_id(&inbox_id);
    let states = live_states(&path);
    assert_eq!(states.len(), 2, "fixture must create two sibling batches");

    store
        .quarantine_live_batch(
            &first_row_id,
            ReasonCode::new("delivery_failed").expect("valid quarantine reason"),
        )
        .expect("quarantine first sibling");
    assert_eq!(
        live_states(&path),
        vec![
            (
                0,
                "quarantined".to_owned(),
                None,
                Some("delivery_failed".to_owned()),
            ),
            (1, "pending".to_owned(), None, None),
        ]
    );
    assert_eq!(
        store
            .committed_sync_token()
            .expect("read committed token after quarantine")
            .expect("committed token after quarantine")
            .as_bytes(),
        INITIAL_TOKEN
    );
    assert_eq!(
        store
            .fetch_sync_token()
            .expect("read fetch token after quarantine")
            .expect("fetch token after quarantine")
            .as_bytes(),
        NEXT_TOKEN
    );
    assert!(
        store
            .next_pending_ingestion_batch(timestamp(ARCHIVED_AT + 10_000))
            .expect("quarantined owner is not selectable")
            .is_none()
    );

    drop(store);
    let mut reopened = Store::open(&path, test_keyring()).expect("reopen recovery store");
    reopened
        .retry_quarantined_window(&window_id, timestamp(ARCHIVED_AT + 10_000))
        .expect("retry quarantined sibling window");
    assert_eq!(
        live_states(&path),
        vec![
            (0, "pending".to_owned(), None, None),
            (1, "pending".to_owned(), None, None),
        ]
    );
    assert_eq!(
        reopened
            .committed_sync_token()
            .expect("read committed token after retry")
            .expect("committed token after retry")
            .as_bytes(),
        INITIAL_TOKEN
    );
    assert_eq!(
        reopened
            .fetch_sync_token()
            .expect("read fetch token after retry")
            .expect("fetch token after retry")
            .as_bytes(),
        NEXT_TOKEN
    );
    assert_eq!(
        reopened
            .next_pending_ingestion_batch(timestamp(ARCHIVED_AT + 10_000))
            .expect("select retried first sibling")
            .expect("retried sibling is due")
            .row_id(),
        first_row_id
    );

    assert_eq!(
        reopened
            .accept_live_batch_and_maybe_commit_window(
                &first_row_id,
                timestamp(ARCHIVED_AT + 10_000),
            )
            .expect("accept retried first sibling"),
        LiveCommitOutcome::BatchAccepted {
            accepted_count: 1,
            batch_count: 2,
        }
    );
    assert_eq!(
        reopened
            .committed_sync_token()
            .expect("read committed token before final sibling")
            .expect("committed token before final sibling")
            .as_bytes(),
        INITIAL_TOKEN
    );
}

#[test]
fn quarantine_and_retry_reject_invalid_and_not_ready_requests() {
    let (_directory, path, mut store, inbox_id, row_id) = setup_pending_window();
    let window_id = expected_window_id(&inbox_id);
    let reason = || ReasonCode::new("delivery_failed").expect("valid quarantine reason");

    assert_code(
        store
            .quarantine_live_batch("not-a-batch-id", reason())
            .expect_err("invalid batch ID"),
        STORE_LEDGER_INVALID,
    );
    assert_code(
        store
            .retry_quarantined_window(
                "not-a-window-id",
                timestamp(ARCHIVED_AT) + Duration::nanoseconds(1),
            )
            .expect_err("invalid window ID and timestamp"),
        STORE_LEDGER_INVALID,
    );
    assert_code(
        store
            .quarantine_live_batch(&format!("batch_{}", "0".repeat(64)), reason())
            .expect_err("missing batch is not ready"),
        STORE_LEDGER_NOT_READY,
    );
    assert_code(
        store
            .retry_quarantined_window(
                &format!("window_{}", "0".repeat(64)),
                timestamp(ARCHIVED_AT),
            )
            .expect_err("missing window is not ready"),
        STORE_LEDGER_NOT_READY,
    );
    assert_code(
        store
            .retry_quarantined_window(&window_id, timestamp(ARCHIVED_AT))
            .expect_err("pending window is not ready for retry"),
        STORE_LEDGER_NOT_READY,
    );
    assert_eq!(
        live_states(&path),
        vec![(0, "pending".to_owned(), None, None)]
    );

    assert_eq!(
        store
            .accept_live_batch_and_maybe_commit_window(&row_id, timestamp(ARCHIVED_AT))
            .expect("commit live row"),
        LiveCommitOutcome::WindowCommitted
    );
    assert_code(
        store
            .quarantine_live_batch(&row_id, reason())
            .expect_err("committed batch is not ready for quarantine"),
        STORE_LEDGER_NOT_READY,
    );
    assert_code(
        store
            .retry_quarantined_window(&window_id, timestamp(ARCHIVED_AT))
            .expect_err("committed window is not ready for retry"),
        STORE_LEDGER_NOT_READY,
    );
}

#[test]
fn recovery_rejects_corrupt_protected_state_without_mutation() {
    let (_directory, path, mut store, _inbox_id, row_id) = setup_pending_window();
    let before = live_states(&path);
    Connection::open(&path)
        .expect("open request corruption connection")
        .execute(
            "UPDATE outbox_batches SET request_sha256 = zeroblob(32) WHERE batch_row_id = ?1",
            [&row_id],
        )
        .expect("tamper request digest");
    assert_code(
        store
            .quarantine_live_batch(
                &row_id,
                ReasonCode::new("delivery_failed").expect("valid quarantine reason"),
            )
            .expect_err("corrupt request must fail closed"),
        STORE_LEDGER_CORRUPT,
    );
    assert_eq!(live_states(&path), before);

    let (_directory, path, mut store, inbox_id, row_id) = setup_pending_window();
    let window_id = expected_window_id(&inbox_id);
    store
        .quarantine_live_batch(
            &row_id,
            ReasonCode::new("delivery_failed").expect("valid quarantine reason"),
        )
        .expect("quarantine before token corruption");
    let before = live_states(&path);
    Connection::open(&path)
        .expect("open token corruption connection")
        .execute(
            "UPDATE sync_inbox SET next_token_cipher = zeroblob(32) WHERE inbox_id = ?1",
            [&inbox_id],
        )
        .expect("tamper next-token ciphertext");
    assert_code(
        store
            .retry_quarantined_window(&window_id, timestamp(ARCHIVED_AT + 10_000))
            .expect_err("corrupt token must fail closed"),
        STORE_LEDGER_CORRUPT,
    );
    assert_eq!(live_states(&path), before);
}
