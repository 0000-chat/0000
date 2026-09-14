use std::{
    fs,
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
};

use chrono::{DateTime, Duration, TimeZone, Utc};
use communicator_matrix_gateway::{
    batch::{BackfillJob, BatchWindow, RoutedEvent, WindowSource, build_window},
    crypto::Keyring,
    ledger::{
        BackfillCommitOutcome, NewBackfillJob, NewLiveWindow, STORE_BACKFILL_CONFLICT,
        STORE_BACKFILL_CORRUPT, STORE_BACKFILL_NOT_READY, STORE_LEDGER_CAS_MISMATCH,
    },
    model::{
        CanonicalEvent, CanonicalEventSource, CanonicalPayload, DeliveryStatus, Direction,
        MessageCreatedPayload, Provider,
    },
    secret::SecretBytes,
    store::Store,
    store_types::{NewBootstrapState, NewRawSyncInbox},
};
use rusqlite::{Connection, params};
use tempfile::{TempDir, tempdir};

const JOB_ONE: &str = "019f1000-0000-7000-8000-000000000001";
const JOB_TWO: &str = "019f1000-0000-7000-8000-000000000002";
const ROOM_ID: &str = "!backfill-delivery:example.test";
const START_AT: &str = "2026-09-01T00:00:00.000Z";
const END_AT: &str = "2026-09-02T00:00:00.000Z";
const CREATED_ONE: i64 = 1_757_000_000_000;
const CREATED_TWO: i64 = CREATED_ONE + 1_000;
const ARCHIVED_AT: i64 = 1_757_000_010_000;
const RETRY_AT: i64 = ARCHIVED_AT + 1_000;

fn timestamp(milliseconds: i64) -> DateTime<Utc> {
    Utc.timestamp_millis_opt(milliseconds)
        .single()
        .expect("valid test timestamp")
}

fn secure_tempdir() -> TempDir {
    let directory = tempdir().expect("create temporary state directory");
    fs::set_permissions(directory.path(), fs::Permissions::from_mode(0o700))
        .expect("secure temporary state directory");
    directory
}

fn path(directory: &Path) -> PathBuf {
    directory.join("gateway.sqlite3")
}

fn keyring() -> Keyring {
    Keyring::new([0x11; 32], 1).expect("construct test keyring")
}

fn job(job_id: &str, max_events: u64) -> BackfillJob {
    BackfillJob::new(job_id, ROOM_ID, START_AT, END_AT, max_events).expect("valid backfill job")
}

fn create_and_begin(store: &mut Store, job: &BackfillJob, created_at: i64) {
    store
        .create_backfill_job(
            NewBackfillJob::new(
                job.clone(),
                b"protected operator parameters".to_vec(),
                timestamp(created_at),
            )
            .expect("valid new backfill job"),
        )
        .expect("create backfill job");
    store
        .begin_or_resume_backfill_job(job.job_id())
        .expect("begin backfill job");
}

fn event(job: &BackfillJob, index: usize, tenant: &str, route: &str) -> RoutedEvent {
    RoutedEvent::new(
        route,
        CanonicalEvent::new(
            format!("$backfill_delivery_{index:04}:example.test"),
            CanonicalEventSource::Backfill,
            tenant,
            "identity_delivery",
            Provider::Whatsapp,
            "account_delivery",
            "conversation_delivery",
            Some(job.room_id().to_owned()),
            Some(format!("$backfill_delivery_{index:04}:example.test")),
            None,
            "2026-09-01T00:00:01.000Z",
            "2026-09-01T00:00:02.000Z",
            CanonicalPayload::MessageCreated(MessageCreatedPayload {
                message_id: format!("message_{index:064x}"),
                direction: Direction::Inbound,
                sender_participant_id: Some(
                    "participant_0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
                        .to_owned(),
                ),
                sender_label: "Alice".to_owned(),
                body: format!("delivery-body-{index}"),
                reply_to_message_id: None,
                delivery_status: DeliveryStatus::Unknown,
                unread: true,
            }),
        )
        .expect("valid backfill event"),
    )
}

fn page(job: &BackfillJob, ordinal: u64, events: &[RoutedEvent]) -> BatchWindow {
    build_window(
        job.checkpoint(ordinal),
        timestamp(ARCHIVED_AT + ordinal as i64),
        events,
    )
    .expect("valid backfill page")
}

fn checkpoint(
    store: &mut Store,
    job: &BackfillJob,
    ordinal: u64,
    events: &[RoutedEvent],
    pagination: Option<&[u8]>,
    accepted_events: u64,
) -> BatchWindow {
    let window = page(job, ordinal, events);
    let pagination = pagination
        .map(|bytes| SecretBytes::from_text(bytes, 64 * 1024).expect("valid pagination secret"));
    store
        .checkpoint_backfill_page(job.job_id(), pagination.as_ref(), &window, accepted_events)
        .expect("checkpoint backfill page");
    window
}

fn setup_live(store_path: &Path) -> (Store, String) {
    let mut store = Store::open(store_path, keyring()).expect("open live store");
    store
        .initialize_bootstrap_state(
            NewBootstrapState::new(
                b"matrix-session".to_vec(),
                b"initial-token".to_vec(),
                Vec::new(),
                timestamp(CREATED_ONE),
            )
            .expect("valid bootstrap state"),
        )
        .expect("initialize bootstrap state");
    let inbox_id = store
        .append_fetched_sync(
            NewRawSyncInbox::new(
                b"initial-token".to_vec(),
                b"next-token".to_vec(),
                b"raw-sync-response".to_vec(),
                timestamp(CREATED_ONE + 1_000),
            )
            .expect("valid raw sync inbox"),
        )
        .expect("append sync inbox")
        .as_str()
        .to_owned();
    store
        .record_sdk_processing(&inbox_id, &[])
        .expect("record SDK processing");
    store.mark_crypto_drained(&inbox_id).expect("drain crypto");
    (store, inbox_id)
}

fn live_window_id(inbox_id: &str) -> String {
    let digest = keyring()
        .lookup_digest("matrix-live-window-v1", &[inbox_id])
        .expect("derive live window ID");
    format!(
        "window_{}",
        digest
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>()
    )
}

fn live_event() -> RoutedEvent {
    RoutedEvent::new(
        "route_live",
        CanonicalEvent::new(
            "$live_delivery:example.test",
            CanonicalEventSource::Live,
            "tenant_live",
            "identity_live",
            Provider::Whatsapp,
            "account_live",
            "conversation_live",
            Some("!live:example.test".to_owned()),
            Some("$live_delivery:example.test".to_owned()),
            None,
            "2026-09-01T00:00:01.000Z",
            "2026-09-01T00:00:02.000Z",
            CanonicalPayload::MessageCreated(MessageCreatedPayload {
                message_id: "message_live_delivery".to_owned(),
                direction: Direction::Inbound,
                sender_participant_id: None,
                sender_label: "Alice".to_owned(),
                body: "live".to_owned(),
                reply_to_message_id: None,
                delivery_status: DeliveryStatus::Unknown,
                unread: true,
            }),
        )
        .expect("valid live event"),
    )
}

fn add_live_window(store: &mut Store, inbox_id: &str) -> String {
    let window_id = live_window_id(inbox_id);
    store
        .create_collecting_live_window(
            inbox_id,
            NewLiveWindow::new(window_id.clone(), timestamp(ARCHIVED_AT), 0)
                .expect("valid collecting live window"),
        )
        .expect("create collecting live window");
    let window = build_window(
        WindowSource::live(b"next-token"),
        timestamp(ARCHIVED_AT),
        &[live_event()],
    )
    .expect("valid live window");
    store
        .finalize_live_window(inbox_id, &window_id, &window, &[], &[])
        .expect("finalize live window");
    window.batches[0].batch_id.clone()
}

fn outbox_schedule(path: &Path, row_id: &str) -> (i64, String) {
    Connection::open(path)
        .expect("open inspection connection")
        .query_row(
            "SELECT attempt_count, next_attempt_at FROM outbox_batches WHERE batch_row_id = ?1",
            [row_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .expect("read outbox schedule")
}

fn backfill_counts(path: &Path, job_id: &str) -> (i64, i64, i64) {
    Connection::open(path)
        .expect("open inspection connection")
        .query_row(
            "SELECT
                (SELECT COUNT(*) FROM outbox_batches WHERE backfill_job_id = ?1),
                (SELECT COUNT(*) FROM outbox_batches WHERE backfill_job_id = ?1 AND state = 'accepted'),
                (SELECT accepted_events FROM backfill_jobs WHERE job_id = ?1)",
            [job_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .expect("read backfill counts")
}

fn assert_code(error: communicator_matrix_gateway::secret::SafeError, code: &str) {
    assert_eq!(error.code(), code);
}

#[test]
fn live_batch_is_selected_before_due_backfill_batch() {
    let directory = secure_tempdir();
    let database = path(directory.path());
    let (mut store, inbox_id) = setup_live(&database);
    let live_row_id = add_live_window(&mut store, &inbox_id);
    let backfill = job(JOB_ONE, 10);
    create_and_begin(&mut store, &backfill, CREATED_ONE);
    checkpoint(
        &mut store,
        &backfill,
        0,
        &[event(&backfill, 0, "tenant_backfill", "route_backfill")],
        None,
        1,
    );

    let selected = store
        .next_pending_ingestion_batch(timestamp(RETRY_AT))
        .expect("select pending delivery")
        .expect("live batch is due");
    assert_eq!(selected.row_id(), live_row_id);
}

#[test]
fn no_live_batch_falls_back_to_explicit_backfill_and_recovers_exact_bytes() {
    let directory = secure_tempdir();
    let database = path(directory.path());
    let mut store = Store::open(&database, keyring()).expect("open store");
    let backfill = job(JOB_ONE, 10);
    create_and_begin(&mut store, &backfill, CREATED_ONE);
    let window = checkpoint(
        &mut store,
        &backfill,
        0,
        &[event(&backfill, 0, "tenant_backfill", "route_backfill")],
        None,
        1,
    );

    let selected = store
        .next_pending_ingestion_batch(timestamp(RETRY_AT))
        .expect("select backfill delivery")
        .expect("backfill row is due");
    assert_eq!(selected.row_id(), window.batches[0].batch_id);
    assert_eq!(
        selected.batch().exact_request_bytes(),
        window.batches[0].exact_request_bytes()
    );
    drop(store);
    let reopened = Store::open(&database, keyring()).expect("reopen store");
    let selected = reopened
        .next_pending_ingestion_batch(timestamp(RETRY_AT))
        .expect("recover backfill delivery")
        .expect("backfill row remains pending");
    assert_eq!(
        selected.batch().exact_request_bytes(),
        window.batches[0].exact_request_bytes()
    );
}

#[test]
fn backfill_selection_is_job_then_ordinal_ordered_and_not_due_head_blocks_sibling() {
    let directory = secure_tempdir();
    let database = path(directory.path());
    let mut store = Store::open(&database, keyring()).expect("open store");
    let first = job(JOB_ONE, 10);
    let second = job(JOB_TWO, 10);
    create_and_begin(&mut store, &second, CREATED_TWO);
    let second_window = checkpoint(
        &mut store,
        &second,
        0,
        &[event(&second, 2, "tenant_second", "route_second")],
        None,
        2,
    );
    create_and_begin(&mut store, &first, CREATED_ONE);
    let first_window = checkpoint(
        &mut store,
        &first,
        0,
        &[event(&first, 1, "tenant_first", "route_first")],
        Some(b"more"),
        1,
    );
    let later = checkpoint(
        &mut store,
        &first,
        1,
        &[event(&first, 3, "tenant_first", "route_first")],
        None,
        2,
    );

    let first_id = first_window.batches[0].batch_id.clone();
    Connection::open(&database)
        .expect("open fixture connection")
        .execute(
            "UPDATE outbox_batches SET next_attempt_at = ?1 WHERE batch_row_id = ?2",
            params![timestamp(RETRY_AT + 10_000).to_rfc3339(), first_id],
        )
        .expect("delay earlier head");
    Connection::open(&database)
        .expect("open fixture connection")
        .execute(
            "UPDATE outbox_batches SET next_attempt_at = ?1 WHERE backfill_job_id = ?2",
            params![timestamp(RETRY_AT + 10_000).to_rfc3339(), JOB_TWO],
        )
        .expect("delay later job");
    assert!(
        store
            .next_pending_ingestion_batch(timestamp(RETRY_AT))
            .expect("not-due head blocks later sibling")
            .is_none()
    );
    Connection::open(&database)
        .expect("open fixture connection")
        .execute(
            "UPDATE outbox_batches SET next_attempt_at = ?1 WHERE batch_row_id = ?2",
            params![timestamp(RETRY_AT).to_rfc3339(), first_id],
        )
        .expect("make earlier head due");
    let selected = store
        .next_pending_ingestion_batch(timestamp(RETRY_AT))
        .expect("select deterministic first job")
        .expect("first job is due");
    assert_eq!(selected.row_id(), first_id);

    store
        .accept_backfill_batch_and_maybe_complete_job(&first_id, timestamp(RETRY_AT))
        .expect("accept first job row");
    assert_eq!(
        store
            .next_pending_ingestion_batch(timestamp(RETRY_AT))
            .expect("select next ordinal")
            .expect("later ordinal is due")
            .row_id(),
        later.batches[0].batch_id
    );
    store
        .accept_backfill_batch_and_maybe_complete_job(
            &later.batches[0].batch_id,
            timestamp(RETRY_AT + 1),
        )
        .expect("accept later ordinal");
    Connection::open(&database)
        .expect("open fixture connection")
        .execute(
            "UPDATE outbox_batches SET next_attempt_at = ?1 WHERE backfill_job_id = ?2",
            params![timestamp(RETRY_AT).to_rfc3339(), JOB_TWO],
        )
        .expect("make later job due");
    let selected = store
        .next_pending_ingestion_batch(timestamp(RETRY_AT))
        .expect("select next job")
        .expect("second job is due");
    assert_eq!(selected.row_id(), second_window.batches[0].batch_id);
}

#[test]
fn backfill_attempt_cas_accepts_stale_and_limit_cases_without_mutation() {
    let directory = secure_tempdir();
    let database = path(directory.path());
    let mut store = Store::open(&database, keyring()).expect("open store");
    let backfill = job(JOB_ONE, 10);
    create_and_begin(&mut store, &backfill, CREATED_ONE);
    let window = checkpoint(
        &mut store,
        &backfill,
        0,
        &[event(&backfill, 0, "tenant_backfill", "route_backfill")],
        None,
        1,
    );
    let row_id = window.batches[0].batch_id.as_str();
    let due = timestamp(ARCHIVED_AT);
    let next = timestamp(RETRY_AT);
    store
        .record_ingestion_attempt(row_id, 0, due, due, next)
        .expect("backfill attempt CAS");
    assert_eq!(outbox_schedule(&database, row_id).0, 1);
    assert_code(
        store
            .record_ingestion_attempt(row_id, 0, due, due, next + Duration::seconds(1))
            .expect_err("stale attempt loses CAS"),
        STORE_LEDGER_CAS_MISMATCH,
    );
    Connection::open(&database)
        .expect("open fixture connection")
        .execute(
            "UPDATE outbox_batches SET attempt_count = 1000000, next_attempt_at = ?1
             WHERE batch_row_id = ?2",
            params![due.to_rfc3339(), row_id],
        )
        .expect("set attempt limit");
    let before = outbox_schedule(&database, row_id);
    assert_code(
        store
            .record_ingestion_attempt(row_id, 1_000_000, due, due, next)
            .expect_err("attempt limit is bounded"),
        STORE_LEDGER_CAS_MISMATCH,
    );
    assert_eq!(outbox_schedule(&database, row_id), before);
}

#[test]
fn partial_and_final_acceptance_preserve_checkpoint_count_and_complete_only_when_exhausted() {
    let directory = secure_tempdir();
    let database = path(directory.path());
    let mut store = Store::open(&database, keyring()).expect("open store");
    let backfill = job(JOB_ONE, 10);
    create_and_begin(&mut store, &backfill, CREATED_ONE);
    let first = checkpoint(
        &mut store,
        &backfill,
        0,
        &[
            event(&backfill, 0, "tenant_a", "route_a"),
            event(&backfill, 1, "tenant_b", "route_b"),
        ],
        Some(b"page-two"),
        7,
    );
    let first_id = first.batches[0].batch_id.clone();
    assert_eq!(
        store
            .accept_backfill_batch_and_maybe_complete_job(&first_id, timestamp(RETRY_AT))
            .expect("accept partial page"),
        BackfillCommitOutcome::BatchAccepted { accepted_events: 7 }
    );
    assert_eq!(backfill_counts(&database, JOB_ONE), (2, 1, 7));
    let second_id = first.batches[1].batch_id.clone();
    assert_eq!(
        store
            .accept_backfill_batch_and_maybe_complete_job(&second_id, timestamp(RETRY_AT + 1))
            .expect("accept non-exhausted final row"),
        BackfillCommitOutcome::BatchAccepted { accepted_events: 7 }
    );
    assert_eq!(
        store
            .complete_backfill_job(JOB_ONE, timestamp(RETRY_AT + 2))
            .expect_err("non-exhausted pagination cannot complete"),
        communicator_matrix_gateway::secret::SafeError::new(STORE_BACKFILL_NOT_READY)
    );
}

#[test]
fn multi_page_acceptance_completes_atomically_and_terminal_retry_is_idempotent() {
    let directory = secure_tempdir();
    let database = path(directory.path());
    let mut store = Store::open(&database, keyring()).expect("open store");
    let backfill = job(JOB_ONE, 10);
    create_and_begin(&mut store, &backfill, CREATED_ONE);
    let first = checkpoint(
        &mut store,
        &backfill,
        0,
        &[event(&backfill, 0, "tenant_a", "route_a")],
        Some(b"page-two"),
        4,
    );
    let second = checkpoint(
        &mut store,
        &backfill,
        1,
        &[event(&backfill, 1, "tenant_b", "route_b")],
        None,
        9,
    );
    assert_eq!(
        store
            .accept_backfill_batch_and_maybe_complete_job(
                &first.batches[0].batch_id,
                timestamp(RETRY_AT)
            )
            .expect("accept first page"),
        BackfillCommitOutcome::BatchAccepted { accepted_events: 9 }
    );
    assert_eq!(
        store
            .accept_backfill_batch_and_maybe_complete_job(
                &second.batches[0].batch_id,
                timestamp(RETRY_AT + 1),
            )
            .expect("complete final page"),
        BackfillCommitOutcome::JobCompleted { accepted_events: 9 }
    );
    assert_eq!(
        store
            .accept_backfill_batch_and_maybe_complete_job(
                &second.batches[0].batch_id,
                timestamp(RETRY_AT + 1),
            )
            .expect("identical completed retry"),
        BackfillCommitOutcome::AlreadyCompleted { accepted_events: 9 }
    );
    assert_code(
        store
            .accept_backfill_batch_and_maybe_complete_job(
                &second.batches[0].batch_id,
                timestamp(RETRY_AT + 2),
            )
            .expect_err("conflicting completed timestamp"),
        STORE_BACKFILL_CONFLICT,
    );
}

#[test]
fn explicit_completion_and_cancellation_have_authenticated_terminal_lifecycle() {
    let directory = secure_tempdir();
    let database = path(directory.path());
    let mut store = Store::open(&database, keyring()).expect("open store");
    let complete_job = job(JOB_ONE, 10);
    create_and_begin(&mut store, &complete_job, CREATED_ONE);
    let complete_page = checkpoint(&mut store, &complete_job, 0, &[], None, 0);
    assert!(complete_page.batches.is_empty());
    store
        .complete_backfill_job(JOB_ONE, timestamp(RETRY_AT))
        .expect("explicit completion");
    store
        .complete_backfill_job(JOB_ONE, timestamp(RETRY_AT))
        .expect("identical explicit completion retry");
    assert_code(
        store
            .complete_backfill_job(JOB_ONE, timestamp(RETRY_AT + 1))
            .expect_err("conflicting completion timestamp"),
        STORE_BACKFILL_CONFLICT,
    );

    let cancelled_job = job(JOB_TWO, 10);
    create_and_begin(&mut store, &cancelled_job, CREATED_TWO);
    let page = checkpoint(
        &mut store,
        &cancelled_job,
        0,
        &[event(&cancelled_job, 2, "tenant_cancel", "route_cancel")],
        None,
        3,
    );
    let before = backfill_counts(&database, JOB_TWO);
    store
        .cancel_backfill_job(JOB_TWO, timestamp(RETRY_AT))
        .expect("cancel running job");
    assert_eq!(backfill_counts(&database, JOB_TWO), before);
    let ciphertext_count: i64 = Connection::open(&database)
        .expect("open ciphertext inspection connection")
        .query_row(
            "SELECT COUNT(*) FROM outbox_batches WHERE backfill_job_id = ?1 AND request_cipher IS NOT NULL",
            [JOB_TWO],
            |row| row.get(0),
        )
        .expect("count retained ciphertext");
    assert_eq!(
        ciphertext_count,
        i64::try_from(page.batches.len()).expect("fits")
    );
    store
        .cancel_backfill_job(JOB_TWO, timestamp(RETRY_AT))
        .expect("identical cancellation retry");
    assert_code(
        store
            .cancel_backfill_job(JOB_TWO, timestamp(RETRY_AT + 1))
            .expect_err("conflicting cancellation timestamp"),
        STORE_BACKFILL_CONFLICT,
    );
    assert_code(
        store
            .begin_or_resume_backfill_job(JOB_TWO)
            .expect_err("cancelled job cannot resume"),
        STORE_BACKFILL_NOT_READY,
    );
}

#[test]
fn corruption_rolls_back_acceptance_and_does_not_touch_live_state() {
    let directory = secure_tempdir();
    let database = path(directory.path());
    let (mut store, inbox_id) = setup_live(&database);
    let live_row_id = add_live_window(&mut store, &inbox_id);
    let backfill = job(JOB_ONE, 10);
    create_and_begin(&mut store, &backfill, CREATED_ONE);
    let page = checkpoint(
        &mut store,
        &backfill,
        0,
        &[event(&backfill, 0, "tenant_backfill", "route_backfill")],
        None,
        1,
    );
    let row_id = page.batches[0].batch_id.clone();
    let live_before: (i64, i64) = Connection::open(&database)
        .expect("open live inspection connection")
        .query_row(
            "SELECT
                (SELECT COUNT(*) FROM sync_inbox WHERE state = 'prepared'),
                (SELECT COUNT(*) FROM sync_windows WHERE state = 'pending')",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .expect("read live state");
    Connection::open(&database)
        .expect("open corruption connection")
        .execute(
            "UPDATE outbox_batches SET request_sha256 = zeroblob(32), next_attempt_at = ?1
             WHERE batch_row_id = ?2",
            params![timestamp(RETRY_AT + 10_000).to_rfc3339(), row_id],
        )
        .expect("tamper request digest");
    Connection::open(&database)
        .expect("open live delay connection")
        .execute(
            "UPDATE outbox_batches SET next_attempt_at = ?1 WHERE batch_row_id = ?2",
            params![timestamp(RETRY_AT + 10_000).to_rfc3339(), live_row_id],
        )
        .expect("delay live row");
    assert_code(
        store
            .next_pending_ingestion_batch(timestamp(RETRY_AT))
            .expect_err("corrupt backfill request fails closed"),
        STORE_BACKFILL_CORRUPT,
    );
    assert_code(
        store
            .accept_backfill_batch_and_maybe_complete_job(&row_id, timestamp(RETRY_AT))
            .expect_err("corrupt acceptance fails closed"),
        STORE_BACKFILL_CORRUPT,
    );
    assert_eq!(backfill_counts(&database, JOB_ONE), (1, 0, 1));
    let live_after: (i64, i64, i64) = Connection::open(&database)
        .expect("open live inspection connection")
        .query_row(
            "SELECT
                (SELECT COUNT(*) FROM sync_inbox WHERE state = 'prepared'),
                (SELECT COUNT(*) FROM sync_windows WHERE state = 'pending'),
                (SELECT COUNT(*) FROM outbox_batches WHERE batch_row_id = ?1)",
            [live_row_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .expect("read unchanged live state");
    assert_eq!(live_after, (live_before.0, live_before.1, 1));
}

#[test]
fn malformed_terminal_and_non_explicit_jobs_are_rejected_without_deletion() {
    let directory = secure_tempdir();
    let database = path(directory.path());
    let mut store = Store::open(&database, keyring()).expect("open store");
    let backfill = job(JOB_ONE, 10);
    create_and_begin(&mut store, &backfill, CREATED_ONE);
    checkpoint(
        &mut store,
        &backfill,
        0,
        &[event(&backfill, 0, "tenant_backfill", "route_backfill")],
        None,
        1,
    );
    Connection::open(&database)
        .expect("open malformed fixture connection")
        .execute(
            "UPDATE backfill_jobs SET completed_at = ?1 WHERE job_id = ?2",
            params![timestamp(RETRY_AT).to_rfc3339(), JOB_ONE],
        )
        .expect("malform running terminal field");
    let before: i64 = Connection::open(&database)
        .expect("open count connection")
        .query_row(
            "SELECT COUNT(*) FROM outbox_batches WHERE backfill_job_id = ?1",
            [JOB_ONE],
            |row| row.get(0),
        )
        .expect("count rows");
    assert_code(
        store
            .cancel_backfill_job(JOB_ONE, timestamp(RETRY_AT))
            .expect_err("malformed job cannot cancel"),
        STORE_BACKFILL_CORRUPT,
    );
    let after: i64 = Connection::open(&database)
        .expect("open count connection")
        .query_row(
            "SELECT COUNT(*) FROM outbox_batches WHERE backfill_job_id = ?1",
            [JOB_ONE],
            |row| row.get(0),
        )
        .expect("count rows");
    assert_eq!(after, before);
}
