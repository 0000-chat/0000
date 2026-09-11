use std::{
    fs,
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
};

use chrono::{DateTime, Duration, TimeZone, Utc};
use communicator_matrix_gateway::{
    batch::{RoutedEvent, WindowSource, build_window},
    crypto::Keyring,
    crypto_outbox::{ExactMatrixRequest, RawMatrixResponse},
    ledger::{
        LiveCommitOutcome, NewLiveGapJob, NewLiveWindow, RoomAnchorCandidate,
        RoomEphemeralCandidate, STORE_LEDGER_CONFLICT, STORE_LEDGER_CORRUPT, STORE_LEDGER_INVALID,
        STORE_LEDGER_NOT_READY,
    },
    model::{
        CanonicalEvent, CanonicalEventSource, CanonicalPayload, DeliveryStatus, Direction,
        MessageCreatedPayload, Provider,
    },
    store::Store,
    store_types::{NewBootstrapState, NewRawSyncInbox, ReasonCode},
};
use rusqlite::{Connection, params};
use tempfile::{TempDir, tempdir};

const INITIAL_TOKEN: &[u8] = b"initial-token";
const NEXT_TOKEN: &[u8] = b"next-token";
const OBSERVED_AT: i64 = 1_725_000_001_000;
const ARCHIVED_AT: i64 = 1_757_550_123_000;
const BACKFILL_JOB_ID: &str = "018f0f00-0000-7000-8000-000000000001";
const BACKFILL_BATCH_ONE: &str =
    "batch_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const BACKFILL_BATCH_TWO: &str =
    "batch_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const BACKFILL_BATCH_THREE: &str =
    "batch_cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
const COMMITTED_BASE: i64 = ARCHIVED_AT + 10_000;
const COMMITTED_STEP: i64 = 1_000;
const LIVE_GAP_JOB_ID: &str = "018f0f00-0000-7000-8000-000000000002";

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

fn setup_collecting_window() -> (TempDir, PathBuf, Store, String, String) {
    let directory = secure_tempdir();
    let path = database_path(directory.path());
    let mut store = Store::open(&path, test_keyring()).expect("open collecting store");
    store
        .initialize_bootstrap_state(
            NewBootstrapState::new(
                b"matrix-session".to_vec(),
                INITIAL_TOKEN.to_vec(),
                Vec::new(),
                timestamp(1_725_000_000_000),
            )
            .expect("collecting bootstrap state"),
        )
        .expect("initialize collecting bootstrap state");
    let inbox_id = store
        .append_fetched_sync(
            NewRawSyncInbox::new(
                INITIAL_TOKEN.to_vec(),
                NEXT_TOKEN.to_vec(),
                b"collecting-response".to_vec(),
                timestamp(OBSERVED_AT),
            )
            .expect("collecting raw response"),
        )
        .expect("append collecting response")
        .as_str()
        .to_owned();
    store
        .record_sdk_processing(&inbox_id, &[])
        .expect("collecting SDK processing");
    store
        .mark_crypto_drained(&inbox_id)
        .expect("collecting crypto drain");
    let window_id = expected_window_id(&inbox_id);
    store
        .create_collecting_live_window(
            &inbox_id,
            NewLiveWindow::new(window_id.clone(), timestamp(ARCHIVED_AT), 0)
                .expect("collecting window"),
        )
        .expect("create collecting window");
    (directory, path, store, inbox_id, window_id)
}

fn setup_committed_chain(count: usize) -> (TempDir, PathBuf, Store, Vec<String>) {
    assert!(count > 0);
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

    let mut request_token = INITIAL_TOKEN.to_vec();
    let mut inbox_ids = Vec::with_capacity(count);
    for index in 0..count {
        let next_token = format!("committed-next-token-{index}").into_bytes();
        let inbox_id = store
            .append_fetched_sync(
                NewRawSyncInbox::new(
                    request_token,
                    next_token.clone(),
                    format!("committed-response-{index}").into_bytes(),
                    timestamp(OBSERVED_AT + index as i64 * COMMITTED_STEP),
                )
                .expect("raw sync response"),
            )
            .expect("append committed response")
            .as_str()
            .to_owned();
        store
            .record_sdk_processing(&inbox_id, &[])
            .expect("SDK processing");
        store.mark_crypto_drained(&inbox_id).expect("crypto drain");

        let window_id = expected_window_id(&inbox_id);
        let committed_at = timestamp(COMMITTED_BASE + index as i64 * COMMITTED_STEP);
        store
            .create_collecting_live_window(
                &inbox_id,
                NewLiveWindow::new(window_id.clone(), committed_at, 0).expect("collecting window"),
            )
            .expect("create collecting window");
        store
            .commit_empty_live_window(&inbox_id, &window_id, &[], &[], committed_at)
            .expect("commit empty window");

        inbox_ids.push(inbox_id);
        request_token = next_token;
    }
    (directory, path, store, inbox_ids)
}

fn next_token_digest(path: &Path, inbox_id: &str) -> [u8; 32] {
    let value: Vec<u8> = Connection::open(path)
        .expect("open token digest connection")
        .query_row(
            "SELECT next_token_digest FROM sync_inbox WHERE inbox_id = ?1",
            [inbox_id],
            |row| row.get(0),
        )
        .expect("read next token digest");
    value.try_into().expect("32-byte next token digest")
}

fn inbox_chain_rows(path: &Path) -> Vec<(String, Option<String>)> {
    let connection = Connection::open(path).expect("open inbox chain connection");
    let mut statement = connection
        .prepare("SELECT inbox_id, predecessor_id FROM sync_inbox ORDER BY rowid")
        .expect("prepare inbox chain query");
    statement
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
        .expect("query inbox chain")
        .collect::<Result<Vec<_>, _>>()
        .expect("collect inbox chain")
}

fn assert_foreign_keys_clean(path: &Path) {
    let connection = Connection::open(path).expect("open foreign-key check connection");
    let mut statement = connection
        .prepare("PRAGMA foreign_key_check")
        .expect("prepare foreign-key check");
    let violations = statement
        .query_map([], |_row| Ok(()))
        .expect("query foreign-key check")
        .collect::<Result<Vec<_>, _>>()
        .expect("collect foreign-key check");
    assert!(
        violations.is_empty(),
        "foreign-key violations: {violations:?}"
    );
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

fn insert_backfill_pressure_fixture(path: &Path) {
    let connection = Connection::open(path).expect("open backfill pressure connection");
    connection
        .execute(
            "INSERT INTO backfill_jobs
             (job_id, kind, live_window_id, state,
              parameters_cipher, parameters_nonce, pagination_cipher, pagination_nonce,
              key_version, accepted_events, created_at,
              completed_at, cancelled_at, terminal_code)
             VALUES (?1, 'explicit', NULL, 'running', ?2, ?3, NULL, NULL,
                     1, 0, ?4, NULL, NULL, NULL)",
            params![
                BACKFILL_JOB_ID,
                vec![0_u8; 32],
                vec![0_u8; 24],
                timestamp(ARCHIVED_AT - 30_000).to_rfc3339(),
            ],
        )
        .expect("insert backfill pressure job");

    for (row_id, ordinal, state, byte_count, next_attempt_at, terminal_code) in [
        (
            BACKFILL_BATCH_ONE,
            0_i64,
            "pending",
            17_i64,
            timestamp(ARCHIVED_AT - 20_000),
            None,
        ),
        (
            BACKFILL_BATCH_TWO,
            1_i64,
            "pending",
            19_i64,
            timestamp(ARCHIVED_AT + 20_000),
            None,
        ),
        (
            BACKFILL_BATCH_THREE,
            2_i64,
            "quarantined",
            23_i64,
            timestamp(ARCHIVED_AT - 40_000),
            Some("delivery_failed"),
        ),
    ] {
        connection
            .execute(
                "INSERT INTO outbox_batches
                 (batch_row_id, source_kind, window_id, backfill_job_id,
                  ordinal, state, request_cipher, request_nonce, request_key_version,
                  request_sha256, byte_count, attempt_count, next_attempt_at,
                  accepted_at, terminal_code)
                 VALUES (?1, 'backfill', NULL, ?2, ?3, ?4, ?5, ?6, 1,
                         ?7, ?8, 0, ?9, NULL, ?10)",
                params![
                    row_id,
                    BACKFILL_JOB_ID,
                    ordinal,
                    state,
                    vec![0_u8; 32],
                    vec![0_u8; 24],
                    vec![0_u8; 32],
                    byte_count,
                    next_attempt_at.to_rfc3339(),
                    terminal_code,
                ],
            )
            .expect("insert backfill pressure row");
    }
}

fn live_byte_count(path: &Path, row_id: &str) -> u64 {
    let connection = Connection::open(path).expect("open live byte-count connection");
    let byte_count: i64 = connection
        .query_row(
            "SELECT byte_count FROM outbox_batches WHERE batch_row_id = ?1",
            [row_id],
            |row| row.get(0),
        )
        .expect("read live byte count");
    u64::try_from(byte_count).expect("valid live byte count")
}

#[test]
fn purge_with_no_eligible_rows_returns_zero_counts() {
    let directory = secure_tempdir();
    let path = database_path(directory.path());
    let mut store = Store::open(&path, test_keyring()).expect("open empty store");
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

    let outcome = store
        .purge_committed_prefix(timestamp(ARCHIVED_AT), &[0xAA; 32])
        .expect("empty purge");

    assert_eq!(outcome.inbox_rows(), 0);
    assert_eq!(outcome.windows(), 0);
    assert_eq!(outcome.crypto_rows(), 0);
    assert_eq!(outcome.ingestion_rows(), 0);
    assert_eq!(outcome.live_gap_jobs(), 0);
}

#[test]
fn purge_uses_strict_cutoff_retains_newest_and_rewires_predecessor() {
    let (_directory, path, mut store, inbox_ids) = setup_committed_chain(3);

    let outcome = store
        .purge_committed_prefix(timestamp(COMMITTED_BASE + COMMITTED_STEP), &[0xAA; 32])
        .expect("purge strictly older committed prefix");

    assert_eq!(outcome.inbox_rows(), 1);
    assert_eq!(outcome.windows(), 1);
    assert_eq!(outcome.crypto_rows(), 0);
    assert_eq!(outcome.ingestion_rows(), 0);
    assert_eq!(outcome.live_gap_jobs(), 0);
    assert_eq!(
        inbox_chain_rows(&path),
        vec![
            (inbox_ids[1].clone(), None),
            (inbox_ids[2].clone(), Some(inbox_ids[1].clone())),
        ]
    );
    assert_foreign_keys_clean(&path);
}

#[test]
fn purge_deletes_only_the_contiguous_oldest_prefix() {
    let (_directory, path, mut store, inbox_ids) = setup_committed_chain(4);

    let outcome = store
        .purge_committed_prefix(
            timestamp(COMMITTED_BASE + 2 * COMMITTED_STEP + 1),
            &[0xAA; 32],
        )
        .expect("purge three oldest committed rows");

    assert_eq!(outcome.inbox_rows(), 3);
    assert_eq!(outcome.windows(), 3);
    assert_eq!(outcome.crypto_rows(), 0);
    assert_eq!(outcome.ingestion_rows(), 0);
    assert_eq!(outcome.live_gap_jobs(), 0);
    assert_eq!(inbox_chain_rows(&path), vec![(inbox_ids[3].clone(), None)]);
    assert_foreign_keys_clean(&path);
}

#[test]
fn purge_retains_the_row_at_the_sdk_token_position() {
    let (_directory, path, mut store, inbox_ids) = setup_committed_chain(4);
    let sdk_digest = next_token_digest(&path, &inbox_ids[1]);

    let outcome = store
        .purge_committed_prefix(
            timestamp(COMMITTED_BASE + 2 * COMMITTED_STEP + 1),
            &sdk_digest,
        )
        .expect("purge prefix before SDK position");

    assert_eq!(outcome.inbox_rows(), 1);
    assert_eq!(outcome.windows(), 1);
    assert_eq!(outcome.crypto_rows(), 0);
    assert_eq!(outcome.ingestion_rows(), 0);
    assert_eq!(outcome.live_gap_jobs(), 0);
    assert_eq!(
        inbox_chain_rows(&path),
        vec![
            (inbox_ids[1].clone(), None),
            (inbox_ids[2].clone(), Some(inbox_ids[1].clone())),
            (inbox_ids[3].clone(), Some(inbox_ids[2].clone())),
        ]
    );
}

#[test]
fn purge_stops_at_a_nonterminal_live_child() {
    let (_directory, path, mut store, inbox_id, row_id) = setup_pending_window();
    store
        .accept_live_batch_and_maybe_commit_window(&row_id, timestamp(COMMITTED_BASE))
        .expect("commit first live window");

    let second = store
        .append_fetched_sync(
            NewRawSyncInbox::new(
                NEXT_TOKEN.to_vec(),
                b"blocking-tail-token".to_vec(),
                b"blocking-tail-response".to_vec(),
                timestamp(OBSERVED_AT + 1_000),
            )
            .expect("second raw sync response"),
        )
        .expect("append second response")
        .as_str()
        .to_owned();
    store
        .record_sdk_processing(&second, &[])
        .expect("second SDK processing");
    store
        .mark_crypto_drained(&second)
        .expect("second crypto drain");
    let second_window_id = expected_window_id(&second);
    store
        .create_collecting_live_window(
            &second,
            NewLiveWindow::new(
                second_window_id.clone(),
                timestamp(COMMITTED_BASE + 1_000),
                0,
            )
            .expect("second collecting window"),
        )
        .expect("create second collecting window");
    store
        .commit_empty_live_window(
            &second,
            &second_window_id,
            &[],
            &[],
            timestamp(COMMITTED_BASE + 1_000),
        )
        .expect("commit second window");

    Connection::open(&path)
        .expect("open child blocking connection")
        .execute(
            "UPDATE outbox_batches
             SET state = 'pending', accepted_at = NULL
             WHERE batch_row_id = ?1",
            [row_id.as_str()],
        )
        .expect("make live child nonterminal");

    let outcome = store
        .purge_committed_prefix(timestamp(COMMITTED_BASE + 1_000), &[0xAA; 32])
        .expect("blocked purge returns empty outcome");
    assert_eq!(
        outcome,
        communicator_matrix_gateway::ledger::PurgeOutcome::new(0, 0, 0, 0, 0)
    );
    assert_eq!(
        Connection::open(&path)
            .expect("open blocked postcondition connection")
            .query_row(
                "SELECT COUNT(*) FROM sync_inbox WHERE inbox_id = ?1",
                [inbox_id.as_str()],
                |row| row.get::<_, i64>(0),
            )
            .expect("count blocked inbox"),
        1
    );
}

#[test]
fn purge_cleans_terminal_gap_jobs_staged_state_and_accepted_live_rows() {
    let (_directory, path, mut store, inbox_id, window_id) = setup_collecting_window();
    let anchor = RoomAnchorCandidate::new([0x42; 32], b"committed-anchor".to_vec())
        .expect("anchor candidate");
    let ephemeral = RoomEphemeralCandidate::new(
        [0x43; 32],
        b"committed-typing".to_vec(),
        timestamp(COMMITTED_BASE + 10_000),
    )
    .expect("ephemeral candidate");
    store
        .create_live_gap_job(
            NewLiveGapJob::new(
                LIVE_GAP_JOB_ID,
                window_id.clone(),
                b"gap-parameters".to_vec(),
                timestamp(ARCHIVED_AT - 1_000),
            )
            .expect("live-gap job"),
        )
        .expect("create live-gap job");
    store
        .begin_or_resume_live_gap_job(LIVE_GAP_JOB_ID)
        .expect("begin live-gap job");
    let events = vec![RoutedEvent::new(
        "route_demo",
        message_event_at(900, "gap-body"),
    )];
    let window = build_window(
        WindowSource::live(NEXT_TOKEN),
        timestamp(ARCHIVED_AT),
        &events,
    )
    .expect("gap live window");
    let row_id = window.batches[0].batch_id.clone();
    store
        .complete_live_gap_and_finalize_window(
            LIVE_GAP_JOB_ID,
            &window,
            std::slice::from_ref(&anchor),
            std::slice::from_ref(&ephemeral),
        )
        .expect("complete live-gap preparation");
    store
        .accept_live_batch_and_maybe_commit_window(&row_id, timestamp(COMMITTED_BASE))
        .expect("commit live-gap window");

    let second = store
        .append_fetched_sync(
            NewRawSyncInbox::new(
                NEXT_TOKEN.to_vec(),
                b"gap-tail-token".to_vec(),
                b"gap-tail-response".to_vec(),
                timestamp(OBSERVED_AT + 1_000),
            )
            .expect("tail raw sync response"),
        )
        .expect("append tail response")
        .as_str()
        .to_owned();
    store
        .record_sdk_processing(&second, &[])
        .expect("tail SDK processing");
    store
        .mark_crypto_drained(&second)
        .expect("tail crypto drain");
    let second_window_id = expected_window_id(&second);
    store
        .create_collecting_live_window(
            &second,
            NewLiveWindow::new(
                second_window_id.clone(),
                timestamp(COMMITTED_BASE + 1_000),
                0,
            )
            .expect("tail collecting window"),
        )
        .expect("create tail collecting window");
    store
        .commit_empty_live_window(
            &second,
            &second_window_id,
            &[],
            &[],
            timestamp(COMMITTED_BASE + 1_000),
        )
        .expect("commit tail window");

    let outcome = store
        .purge_committed_prefix(timestamp(COMMITTED_BASE + 1_000), &[0xAA; 32])
        .expect("purge gap prefix");
    assert_eq!(outcome.inbox_rows(), 1);
    assert_eq!(outcome.windows(), 1);
    assert_eq!(outcome.crypto_rows(), 0);
    assert_eq!(outcome.ingestion_rows(), 1);
    assert_eq!(outcome.live_gap_jobs(), 1);

    let connection = Connection::open(&path).expect("open gap postcondition connection");
    assert_eq!(
        connection
            .query_row(
                "SELECT COUNT(*) FROM sync_windows WHERE window_id = ?1",
                [window_id.as_str()],
                |row| row.get::<_, i64>(0),
            )
            .expect("count purged window"),
        0
    );
    assert_eq!(
        connection
            .query_row(
                "SELECT COUNT(*) FROM window_room_anchors WHERE window_id = ?1",
                [window_id.as_str()],
                |row| row.get::<_, i64>(0),
            )
            .expect("count purged anchors"),
        0
    );
    assert_eq!(
        connection
            .query_row(
                "SELECT COUNT(*) FROM window_room_ephemeral WHERE window_id = ?1",
                [window_id.as_str()],
                |row| row.get::<_, i64>(0),
            )
            .expect("count purged ephemeral"),
        0
    );
    assert_eq!(
        connection
            .query_row(
                "SELECT COUNT(*) FROM backfill_jobs WHERE job_id = ?1",
                [LIVE_GAP_JOB_ID],
                |row| row.get::<_, i64>(0),
            )
            .expect("count purged live-gap job"),
        0
    );
    assert_eq!(
        connection
            .query_row(
                "SELECT COUNT(*) FROM outbox_batches WHERE batch_row_id = ?1",
                [row_id.as_str()],
                |row| row.get::<_, i64>(0),
            )
            .expect("count purged outbox row"),
        0
    );
    assert_eq!(
        connection
            .query_row(
                "SELECT COUNT(*) FROM sync_inbox WHERE inbox_id = ?1",
                [inbox_id.as_str()],
                |row| row.get::<_, i64>(0),
            )
            .expect("count purged inbox row"),
        0
    );
    assert_foreign_keys_clean(&path);
}

#[test]
fn purge_survives_reopen_and_rejects_invalid_input() {
    let (_directory, path, mut store, inbox_ids) = setup_committed_chain(2);
    let before = inbox_chain_rows(&path);

    assert_code(
        store
            .purge_committed_prefix(
                timestamp(COMMITTED_BASE) + Duration::nanoseconds(1),
                &[0xAA; 32],
            )
            .expect_err("sub-millisecond cutoff must be invalid"),
        STORE_LEDGER_INVALID,
    );
    assert_code(
        store
            .purge_committed_prefix(timestamp(COMMITTED_BASE), &[0xAA; 31])
            .expect_err("short SDK digest must be invalid"),
        STORE_LEDGER_INVALID,
    );
    assert_eq!(inbox_chain_rows(&path), before);

    store
        .purge_committed_prefix(timestamp(COMMITTED_BASE + COMMITTED_STEP), &[0xAA; 32])
        .expect("purge oldest row before reopen");
    drop(store);
    let reopened = Store::open(&path, test_keyring()).expect("reopen purged store");
    assert_eq!(inbox_chain_rows(&path), vec![(inbox_ids[1].clone(), None)]);
    assert_eq!(
        reopened
            .committed_sync_token()
            .expect("read committed token after reopen")
            .expect("committed token after reopen")
            .as_bytes(),
        b"committed-next-token-1"
    );
    assert_foreign_keys_clean(&path);
}

#[test]
fn purge_rolls_back_when_a_selected_staged_value_is_corrupt() {
    let (_directory, path, mut store, inbox_id, window_id) = setup_collecting_window();
    let anchor =
        RoomAnchorCandidate::new([0x44; 32], b"corrupt-me".to_vec()).expect("anchor candidate");
    store
        .commit_empty_live_window(
            &inbox_id,
            &window_id,
            std::slice::from_ref(&anchor),
            &[],
            timestamp(COMMITTED_BASE),
        )
        .expect("commit anchored window");
    let second = store
        .append_fetched_sync(
            NewRawSyncInbox::new(
                NEXT_TOKEN.to_vec(),
                b"corrupt-tail-token".to_vec(),
                b"corrupt-tail-response".to_vec(),
                timestamp(OBSERVED_AT + 1_000),
            )
            .expect("tail raw response"),
        )
        .expect("append tail response")
        .as_str()
        .to_owned();
    store
        .record_sdk_processing(&second, &[])
        .expect("tail SDK processing");
    store
        .mark_crypto_drained(&second)
        .expect("tail crypto drain");
    let second_window_id = expected_window_id(&second);
    store
        .create_collecting_live_window(
            &second,
            NewLiveWindow::new(
                second_window_id.clone(),
                timestamp(COMMITTED_BASE + 1_000),
                0,
            )
            .expect("tail window"),
        )
        .expect("create tail window");
    store
        .commit_empty_live_window(
            &second,
            &second_window_id,
            &[],
            &[],
            timestamp(COMMITTED_BASE + 1_000),
        )
        .expect("commit tail window");
    let before = inbox_chain_rows(&path);
    Connection::open(&path)
        .expect("open staged corruption connection")
        .execute(
            "UPDATE window_room_anchors SET anchor_event_cipher = zeroblob(32)
             WHERE window_id = ?1",
            [window_id.as_str()],
        )
        .expect("tamper selected staged value");

    assert_code(
        store
            .purge_committed_prefix(timestamp(COMMITTED_BASE + 1_000), &[0xAA; 32])
            .expect_err("corrupt staged value must roll back purge"),
        STORE_LEDGER_CORRUPT,
    );
    assert_eq!(inbox_chain_rows(&path), before);
    assert_foreign_keys_clean(&path);
}

#[test]
fn purge_deletes_one_accepted_crypto_row_and_reports_exact_totals() {
    let directory = secure_tempdir();
    let path = database_path(directory.path());
    let mut store = Store::open(&path, test_keyring()).expect("open crypto purge store");
    store
        .initialize_bootstrap_state(
            NewBootstrapState::new(
                b"matrix-session".to_vec(),
                INITIAL_TOKEN.to_vec(),
                Vec::new(),
                timestamp(1_725_000_000_000),
            )
            .expect("crypto purge bootstrap"),
        )
        .expect("initialize crypto purge bootstrap");
    let inbox_id = store
        .append_fetched_sync(
            NewRawSyncInbox::new(
                INITIAL_TOKEN.to_vec(),
                NEXT_TOKEN.to_vec(),
                b"crypto-purge-response".to_vec(),
                timestamp(OBSERVED_AT),
            )
            .expect("crypto purge response"),
        )
        .expect("append crypto purge response")
        .as_str()
        .to_owned();
    let request = ExactMatrixRequest::keys_query(
        b"crypto-purge-sdk-request".to_vec(),
        br#"{"device_keys":{}}"#.to_vec(),
    )
    .expect("crypto request");
    store
        .record_sdk_processing(&inbox_id, std::slice::from_ref(&request))
        .expect("record crypto purge request");
    let crypto_row_id: String = Connection::open(&path)
        .expect("open crypto row lookup connection")
        .query_row(
            "SELECT crypto_row_id FROM matrix_crypto_outbox",
            [],
            |row| row.get(0),
        )
        .expect("read crypto row ID");
    store
        .record_attempt(
            &crypto_row_id,
            0,
            timestamp(OBSERVED_AT),
            timestamp(OBSERVED_AT),
            timestamp(OBSERVED_AT + 1_000),
        )
        .expect("lease crypto purge request");
    store
        .record_crypto_response(
            &crypto_row_id,
            &RawMatrixResponse::keys_query(br#"{"ok":true}"#.to_vec())
                .expect("crypto purge response body"),
        )
        .expect("record crypto purge response");
    store
        .complete_crypto_request(&crypto_row_id, timestamp(COMMITTED_BASE))
        .expect("accept crypto purge response");
    store
        .mark_crypto_drained(&inbox_id)
        .expect("drain crypto purge row");
    let window_id = expected_window_id(&inbox_id);
    store
        .create_collecting_live_window(
            &inbox_id,
            NewLiveWindow::new(window_id.clone(), timestamp(COMMITTED_BASE), 0)
                .expect("crypto purge window"),
        )
        .expect("create crypto purge window");
    store
        .commit_empty_live_window(&inbox_id, &window_id, &[], &[], timestamp(COMMITTED_BASE))
        .expect("commit crypto purge window");
    let second = store
        .append_fetched_sync(
            NewRawSyncInbox::new(
                NEXT_TOKEN.to_vec(),
                b"crypto-purge-tail".to_vec(),
                b"crypto-purge-tail-response".to_vec(),
                timestamp(OBSERVED_AT + 1_000),
            )
            .expect("crypto purge tail response"),
        )
        .expect("append crypto purge tail")
        .as_str()
        .to_owned();
    store
        .record_sdk_processing(&second, &[])
        .expect("crypto purge tail SDK processing");
    store
        .mark_crypto_drained(&second)
        .expect("crypto purge tail drain");
    let second_window_id = expected_window_id(&second);
    store
        .create_collecting_live_window(
            &second,
            NewLiveWindow::new(
                second_window_id.clone(),
                timestamp(COMMITTED_BASE + 1_000),
                0,
            )
            .expect("crypto purge tail window"),
        )
        .expect("create crypto purge tail window");
    store
        .commit_empty_live_window(
            &second,
            &second_window_id,
            &[],
            &[],
            timestamp(COMMITTED_BASE + 1_000),
        )
        .expect("commit crypto purge tail");

    let outcome = store
        .purge_committed_prefix(timestamp(COMMITTED_BASE + 1_000), &[0xAA; 32])
        .expect("purge crypto row");
    assert_eq!(outcome.inbox_rows(), 1);
    assert_eq!(outcome.windows(), 1);
    assert_eq!(outcome.crypto_rows(), 1);
    assert_eq!(outcome.ingestion_rows(), 0);
    assert_eq!(outcome.live_gap_jobs(), 0);
    assert_eq!(
        Connection::open(&path)
            .expect("open crypto purge postcondition connection")
            .query_row(
                "SELECT COUNT(*) FROM matrix_crypto_outbox WHERE crypto_row_id = ?1",
                [crypto_row_id.as_str()],
                |row| row.get::<_, i64>(0),
            )
            .expect("count purged crypto row"),
        0
    );
    assert_foreign_keys_clean(&path);
}

#[test]
fn ledger_pressure_reports_empty_store() {
    let directory = secure_tempdir();
    let path = database_path(directory.path());
    let store = Store::open(&path, test_keyring()).expect("open empty store");

    let pressure = store.ledger_pressure().expect("empty pressure snapshot");
    assert_eq!(pressure.pending_batches(), 0);
    assert_eq!(pressure.pending_bytes(), 0);
    assert_eq!(pressure.quarantined_windows(), 0);
    assert_eq!(pressure.oldest_pending_at(), None);
}

#[test]
fn ledger_pressure_aggregates_live_and_backfill_rows_and_survives_reopen() {
    let (_directory, path, mut store, inbox_id, row_id) = setup_pending_window();
    let live_bytes = live_byte_count(&path, &row_id);
    let oldest = timestamp(ARCHIVED_AT - 20_000);
    insert_backfill_pressure_fixture(&path);

    let pressure = store.ledger_pressure().expect("mixed pressure snapshot");
    assert_eq!(pressure.pending_batches(), 3);
    assert_eq!(pressure.pending_bytes(), live_bytes + 17 + 19);
    assert_eq!(pressure.quarantined_windows(), 0);
    assert_eq!(pressure.oldest_pending_at(), Some(&oldest));

    let window_id = expected_window_id(&inbox_id);
    store
        .quarantine_live_batch(
            &row_id,
            ReasonCode::new("delivery_failed").expect("valid quarantine reason"),
        )
        .expect("quarantine live row");
    let pressure = store
        .ledger_pressure()
        .expect("quarantined mixed pressure snapshot");
    assert_eq!(pressure.pending_batches(), 2);
    assert_eq!(pressure.pending_bytes(), 17 + 19);
    assert_eq!(pressure.quarantined_windows(), 1);
    assert_eq!(pressure.oldest_pending_at(), Some(&oldest));

    store
        .retry_quarantined_window(&window_id, timestamp(ARCHIVED_AT + 10_000))
        .expect("reopen live window");
    let pressure = store.ledger_pressure().expect("reopened pressure snapshot");
    assert_eq!(pressure.pending_batches(), 3);
    assert_eq!(pressure.pending_bytes(), live_bytes + 17 + 19);
    assert_eq!(pressure.quarantined_windows(), 0);
    assert_eq!(pressure.oldest_pending_at(), Some(&oldest));

    drop(store);
    let reopened = Store::open(&path, test_keyring()).expect("reopen pressure store");
    let pressure = reopened
        .ledger_pressure()
        .expect("pressure snapshot after reopen");
    assert_eq!(pressure.pending_batches(), 3);
    assert_eq!(pressure.pending_bytes(), live_bytes + 17 + 19);
    assert_eq!(pressure.quarantined_windows(), 0);
    assert_eq!(pressure.oldest_pending_at(), Some(&oldest));
}

#[test]
fn ledger_pressure_rejects_corrupt_integer_and_timestamp_metadata() {
    for update in [
        "UPDATE outbox_batches SET byte_count = -1 WHERE batch_row_id = ?1",
        "UPDATE outbox_batches SET byte_count = 9223372036854775807 WHERE batch_row_id = ?1",
        "UPDATE outbox_batches SET attempt_count = -1 WHERE batch_row_id = ?1",
        "UPDATE outbox_batches SET next_attempt_at = 'not-a-timestamp' WHERE batch_row_id = ?1",
    ] {
        let (_directory, path, store, _inbox_id, row_id) = setup_pending_window();
        Connection::open(&path)
            .expect("open pressure corruption connection")
            .execute(update, [row_id.as_str()])
            .expect("tamper pressure metadata");
        assert_code(
            store
                .ledger_pressure()
                .expect_err("corrupt pressure metadata must fail closed"),
            STORE_LEDGER_CORRUPT,
        );
    }
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
