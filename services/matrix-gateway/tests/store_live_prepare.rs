use std::{
    fs,
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
};

use chrono::{DateTime, TimeZone, Utc};
use communicator_matrix_gateway::{
    batch::{BatchWindow, RoutedEvent, WindowSource, build_window},
    crypto::{Keyring, Sealed},
    ledger::{
        BackfillState, FinalizeOutcome, LiveCommitOutcome, NewLiveGapJob, NewLiveWindow,
        RoomAnchorCandidate, RoomEphemeralCandidate, STORE_LEDGER_CONFLICT, STORE_LEDGER_CORRUPT,
        STORE_LEDGER_INVALID, STORE_LEDGER_NOT_READY,
    },
    model::{
        CanonicalEvent, CanonicalEventSource, CanonicalPayload, DeliveryStatus, Direction,
        MessageCreatedPayload, Provider,
    },
    store::Store,
    store_types::{NewBootstrapState, NewRawSyncInbox},
};
use rusqlite::{Connection, types::Value};
use tempfile::{TempDir, tempdir};

const INITIAL_TOKEN: &[u8] = b"initial-token";
const NEXT_TOKEN: &[u8] = b"next-token";
const ARCHIVED_AT: &str = "2026-09-11T01:02:03.000Z";
const CANARY_BATCH: &str = "live-batch-canary-7b8d";
const CANARY_ANCHOR: &str = "live-anchor-canary-2f91";
const CANARY_TYPING: &str = "live-typing-canary-8c44";
const CANARY_GAP_PARAMETERS: &str = "live-gap-parameters-canary-6d3a";

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

fn setup_one_processed_row() -> (TempDir, PathBuf, Store, String) {
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
    store.mark_crypto_drained(&inbox_id).expect("crypto drain");
    (directory, path, store, inbox_id)
}

fn message_event(body: &str) -> CanonicalEvent {
    CanonicalEvent::new(
        "$event_live_prepare:example.org",
        CanonicalEventSource::Live,
        "tenant_demo",
        "identity_demo",
        Provider::Whatsapp,
        "account_demo",
        "conversation_demo",
        Some("!room:example.org".to_owned()),
        Some("$event_live_prepare:example.org".to_owned()),
        None,
        "2026-09-11T01:02:02.000Z",
        ARCHIVED_AT,
        CanonicalPayload::MessageCreated(MessageCreatedPayload {
            message_id: "message_0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
                .to_owned(),
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

fn live_window(body: &str) -> BatchWindow {
    build_window(
        WindowSource::live(NEXT_TOKEN),
        timestamp(1_757_550_123_000),
        &[RoutedEvent::new("route_demo", message_event(body))],
    )
    .expect("valid live batch window")
}

fn new_window(inbox_id: &str, ignored_count: u64) -> NewLiveWindow {
    NewLiveWindow::new(
        expected_window_id(inbox_id),
        timestamp(1_757_550_123_000),
        ignored_count,
    )
    .expect("valid new live window")
}

fn new_live_gap_job(window_id: &str, parameters: &[u8]) -> NewLiveGapJob {
    new_live_gap_job_with_id(&format!("job_{}", "44".repeat(32)), window_id, parameters)
}

fn new_live_gap_job_with_id(job_id: &str, window_id: &str, parameters: &[u8]) -> NewLiveGapJob {
    NewLiveGapJob::new(
        job_id,
        window_id,
        parameters.to_vec(),
        timestamp(1_757_550_123_001),
    )
    .expect("valid live-gap job")
}

fn candidate_sets() -> (Vec<RoomAnchorCandidate>, Vec<RoomEphemeralCandidate>) {
    (
        vec![
            RoomAnchorCandidate::new(vec![0x22; 32], CANARY_ANCHOR.as_bytes().to_vec())
                .expect("anchor candidate"),
        ],
        vec![
            RoomEphemeralCandidate::new(
                vec![0x33; 32],
                CANARY_TYPING.as_bytes().to_vec(),
                timestamp(1_757_550_124_000),
            )
            .expect("typing candidate"),
        ],
    )
}

fn table_count(path: &Path, table: &str) -> i64 {
    Connection::open(path)
        .expect("open sqlite inspection connection")
        .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
            row.get(0)
        })
        .expect("count table rows")
}

fn sqlite_storage_bytes(path: &Path) -> Vec<u8> {
    let mut bytes = fs::read(path).expect("read sqlite database");
    for suffix in ["-wal", "-shm"] {
        let sidecar = PathBuf::from(format!("{}{}", path.display(), suffix));
        if let Ok(mut sidecar_bytes) = fs::read(sidecar) {
            bytes.append(&mut sidecar_bytes);
        }
    }
    bytes
}

fn database_snapshot(path: &Path) -> Vec<Vec<Vec<Value>>> {
    let connection = Connection::open(path).expect("open sqlite snapshot connection");
    [
        "sync_inbox",
        "sync_windows",
        "backfill_jobs",
        "outbox_batches",
        "window_room_anchors",
        "window_room_ephemeral",
    ]
    .into_iter()
    .map(|table| {
        let mut statement = connection
            .prepare(&format!("SELECT * FROM {table} ORDER BY rowid"))
            .expect("prepare sqlite snapshot query");
        let columns = statement.column_count();
        statement
            .query_map([], |row| {
                (0..columns)
                    .map(|index| row.get(index))
                    .collect::<Result<Vec<Value>, _>>()
            })
            .expect("query sqlite snapshot")
            .collect::<Result<_, _>>()
            .expect("collect sqlite snapshot")
    })
    .collect()
}

fn read_sealed(path: &Path, sql: &str) -> Sealed {
    let connection = Connection::open(path).expect("open sqlite inspection connection");
    connection
        .query_row(sql, [], |row| {
            let ciphertext: Vec<u8> = row.get(0)?;
            let nonce: Vec<u8> = row.get(1)?;
            let key_version: i64 = row.get(2)?;
            Ok(Sealed {
                nonce: nonce.try_into().expect("24-byte nonce"),
                ciphertext,
                key_version: key_version.try_into().expect("key version"),
            })
        })
        .expect("read sealed value")
}

#[test]
fn creates_only_oldest_crypto_drained_window_with_deterministic_id() {
    let (_directory, path, mut store, inbox_id) = setup_one_processed_row();
    let expected_id = expected_window_id(&inbox_id);

    store
        .create_collecting_live_window(&inbox_id, new_window(&inbox_id, 0))
        .expect("create collecting window");
    assert_eq!(table_count(&path, "sync_windows"), 1);
    let (stored_id, state, batch_count): (String, String, i64) = Connection::open(&path)
        .expect("open sqlite inspection connection")
        .query_row(
            "SELECT window_id, state, batch_count FROM sync_windows",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .expect("read collecting window");
    assert_eq!(stored_id, expected_id);
    assert_eq!(state, "collecting");
    assert_eq!(batch_count, 0);

    store
        .create_collecting_live_window(&inbox_id, new_window(&inbox_id, 0))
        .expect("identical creation is idempotent");
    assert_eq!(table_count(&path, "sync_windows"), 1);

    let changed = NewLiveWindow::new(expected_id, timestamp(1_757_550_123_001), 0)
        .expect("changed immutable input remains DTO-valid");
    let error = store
        .create_collecting_live_window(&inbox_id, changed)
        .expect_err("changed creation must conflict");
    assert_eq!(error.code(), STORE_LEDGER_CONFLICT);
    assert_eq!(table_count(&path, "sync_windows"), 1);
}

#[test]
fn creation_requires_the_oldest_sdk_processed_crypto_drained_inbox() {
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
    let first = store
        .append_fetched_sync(
            NewRawSyncInbox::new(
                INITIAL_TOKEN.to_vec(),
                b"next-one".to_vec(),
                b"first-response".to_vec(),
                timestamp(1_725_000_001_000),
            )
            .expect("first response"),
        )
        .expect("append first response")
        .as_str()
        .to_owned();
    let second = store
        .append_fetched_sync(
            NewRawSyncInbox::new(
                b"next-one".to_vec(),
                b"next-two".to_vec(),
                b"second-response".to_vec(),
                timestamp(1_725_000_002_000),
            )
            .expect("second response"),
        )
        .expect("append second response")
        .as_str()
        .to_owned();
    store
        .record_sdk_processing(&first, &[])
        .expect("process first response");
    store
        .record_sdk_processing(&second, &[])
        .expect("process second response");

    let error = store
        .create_collecting_live_window(&second, new_window(&second, 0))
        .expect_err("newer inbox cannot create a live window");
    assert_eq!(error.code(), STORE_LEDGER_NOT_READY);
    let error = store
        .create_collecting_live_window(&first, new_window(&first, 0))
        .expect_err("undrained oldest inbox cannot create a window");
    assert_eq!(error.code(), STORE_LEDGER_NOT_READY);
    assert_eq!(table_count(&path, "sync_windows"), 0);
}

#[test]
fn finalization_encrypts_exact_rows_transitions_states_and_replays_idempotently() {
    let (_directory, path, mut store, inbox_id) = setup_one_processed_row();
    let window_id = expected_window_id(&inbox_id);
    store
        .create_collecting_live_window(&inbox_id, new_window(&inbox_id, 0))
        .expect("create collecting window");
    let window = live_window(CANARY_BATCH);
    let exact_request = window.batches[0].exact_request_bytes().to_vec();
    let batch_id = window.batches[0].batch_id.clone();
    let (anchors, ephemeral) = candidate_sets();

    let outcome = store
        .finalize_live_window(&inbox_id, &window_id, &window, &anchors, &ephemeral)
        .expect("finalize live window");
    assert_eq!(outcome, FinalizeOutcome::Prepared { batch_count: 1 });

    let connection = Connection::open(&path).expect("open sqlite inspection connection");
    let inbox_state: String = connection
        .query_row(
            "SELECT state FROM sync_inbox WHERE inbox_id = ?1",
            [&inbox_id],
            |row| row.get(0),
        )
        .expect("read inbox state");
    let window_state: (String, i64, i64) = connection
        .query_row(
            "SELECT state, batch_count, accepted_count FROM sync_windows WHERE window_id = ?1",
            [&window_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .expect("read window state");
    assert_eq!(inbox_state, "prepared");
    assert_eq!(window_state, ("pending".to_owned(), 1, 0));
    assert_eq!(table_count(&path, "outbox_batches"), 1);
    assert_eq!(table_count(&path, "window_room_anchors"), 1);
    assert_eq!(table_count(&path, "window_room_ephemeral"), 1);

    let keyring = test_keyring();
    let outbox = read_sealed(
        &path,
        "SELECT request_cipher, request_nonce, request_key_version
         FROM outbox_batches",
    );
    let decrypted_request = keyring
        .open("outbox_batches", &batch_id, "request", &outbox)
        .expect("open exact outbox request");
    assert_eq!(decrypted_request.as_bytes(), exact_request.as_slice());
    let anchor = read_sealed(
        &path,
        "SELECT anchor_event_cipher, anchor_event_nonce, key_version
         FROM window_room_anchors",
    );
    let anchor_row_id = format!("{window_id}:{}", "22".repeat(32));
    assert_eq!(
        keyring
            .open(
                "window_room_anchors",
                &anchor_row_id,
                "anchor_event",
                &anchor,
            )
            .expect("open staged anchor")
            .as_bytes(),
        CANARY_ANCHOR.as_bytes()
    );
    assert!(
        !sqlite_storage_bytes(&path)
            .windows(CANARY_BATCH.len())
            .any(|bytes| { bytes == CANARY_BATCH.as_bytes() })
    );
    assert!(
        !sqlite_storage_bytes(&path)
            .windows(CANARY_ANCHOR.len())
            .any(|bytes| { bytes == CANARY_ANCHOR.as_bytes() })
    );
    assert!(
        !sqlite_storage_bytes(&path)
            .windows(CANARY_TYPING.len())
            .any(|bytes| { bytes == CANARY_TYPING.as_bytes() })
    );

    let (anchors, ephemeral) = candidate_sets();
    assert_eq!(
        store
            .finalize_live_window(&inbox_id, &window_id, &window, &anchors, &ephemeral)
            .expect("identical finalization is idempotent"),
        FinalizeOutcome::AlreadyPrepared { batch_count: 1 }
    );

    let changed = live_window("changed-live-batch");
    let (anchors, ephemeral) = candidate_sets();
    let error = store
        .finalize_live_window(&inbox_id, &window_id, &changed, &anchors, &ephemeral)
        .expect_err("changed request bytes must conflict");
    assert_eq!(error.code(), STORE_LEDGER_CONFLICT);
    assert_eq!(table_count(&path, "outbox_batches"), 1);
}

#[test]
fn finalization_rejects_zero_batches_without_partial_rows() {
    let (_directory, path, mut store, inbox_id) = setup_one_processed_row();
    let window_id = expected_window_id(&inbox_id);
    store
        .create_collecting_live_window(&inbox_id, new_window(&inbox_id, 0))
        .expect("create collecting window");
    let empty = BatchWindow {
        archived_at: ARCHIVED_AT.to_owned(),
        source_checkpoint: build_window(
            WindowSource::live(NEXT_TOKEN),
            timestamp(1_757_550_123_000),
            &[],
        )
        .expect("empty source checkpoint window")
        .source_checkpoint,
        batches: Vec::new(),
        quarantined: Vec::new(),
    };

    let error = store
        .finalize_live_window(&inbox_id, &window_id, &empty, &[], &[])
        .expect_err("zero-batch finalization must fail");
    assert_eq!(error.code(), STORE_LEDGER_INVALID);
    assert_eq!(table_count(&path, "outbox_batches"), 0);
    let states: (String, String) = Connection::open(&path)
        .expect("open sqlite inspection connection")
        .query_row(
            "SELECT i.state, w.state
             FROM sync_inbox i JOIN sync_windows w ON w.inbox_id = i.inbox_id",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .expect("read unchanged states");
    assert_eq!(
        states,
        ("sdk_processed".to_owned(), "collecting".to_owned())
    );
}

#[test]
fn live_gap_creation_and_begin_are_idempotent_and_do_not_prepare_live_state() {
    let (_directory, path, mut store, inbox_id) = setup_one_processed_row();
    let window_id = expected_window_id(&inbox_id);
    store
        .create_collecting_live_window(&inbox_id, new_window(&inbox_id, 0))
        .expect("create collecting window");
    let parameters = CANARY_GAP_PARAMETERS.as_bytes();

    store
        .create_live_gap_job(new_live_gap_job(&window_id, parameters))
        .expect("create live-gap job");
    store
        .create_live_gap_job(new_live_gap_job(&window_id, parameters))
        .expect("identical live-gap creation is idempotent");
    assert_eq!(table_count(&path, "backfill_jobs"), 1);
    assert_eq!(table_count(&path, "outbox_batches"), 0);
    let stored: (String, String, Option<Vec<u8>>, Option<Vec<u8>>) = Connection::open(&path)
        .expect("open sqlite inspection connection")
        .query_row(
            "SELECT kind, state, pagination_cipher, pagination_nonce
             FROM backfill_jobs",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .expect("read live-gap job metadata");
    assert_eq!(
        stored,
        ("live_gap".to_owned(), "pending".to_owned(), None, None)
    );
    let sealed = read_sealed(
        &path,
        "SELECT parameters_cipher, parameters_nonce, key_version
         FROM backfill_jobs",
    );
    assert_eq!(
        test_keyring()
            .open(
                "backfill_jobs",
                &format!("job_{}", "44".repeat(32)),
                "parameters",
                &sealed,
            )
            .expect("open exact live-gap parameters")
            .as_bytes(),
        parameters
    );
    assert!(
        !sqlite_storage_bytes(&path)
            .windows(CANARY_GAP_PARAMETERS.len())
            .any(|bytes| bytes == parameters)
    );

    let changed = new_live_gap_job(&window_id, b"changed-live-gap-parameters");
    let error = store
        .create_live_gap_job(changed)
        .expect_err("changed live-gap parameters must conflict");
    assert_eq!(error.code(), STORE_LEDGER_CONFLICT);

    let job_id = format!("job_{}", "44".repeat(32));
    let stored = store
        .begin_or_resume_live_gap_job(&job_id)
        .expect("begin live-gap job");
    assert_eq!(stored.job_id(), job_id);
    assert_eq!(stored.live_window_id(), window_id);
    assert_eq!(stored.state(), BackfillState::Running);
    assert_eq!(stored.parameters().as_bytes(), parameters);
    assert_eq!(stored.accepted_events(), 0);

    let resumed = store
        .begin_or_resume_live_gap_job(&job_id)
        .expect("resume running live-gap job");
    assert_eq!(resumed.state(), BackfillState::Running);
    assert_eq!(resumed.parameters().as_bytes(), parameters);
    assert_eq!(table_count(&path, "outbox_batches"), 0);

    let states: (String, String) = Connection::open(&path)
        .expect("open sqlite inspection connection")
        .query_row(
            "SELECT i.state, w.state
             FROM sync_inbox i JOIN sync_windows w ON w.inbox_id = i.inbox_id",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .expect("read unchanged live states");
    assert_eq!(
        states,
        ("sdk_processed".to_owned(), "collecting".to_owned())
    );
}

#[test]
fn distinct_live_gap_job_for_same_window_conflicts_without_mutation() {
    let (_directory, path, mut store, inbox_id) = setup_one_processed_row();
    let window_id = expected_window_id(&inbox_id);
    store
        .create_collecting_live_window(&inbox_id, new_window(&inbox_id, 0))
        .expect("create collecting window");
    store
        .create_live_gap_job(new_live_gap_job_with_id(
            &format!("job_{}", "44".repeat(32)),
            &window_id,
            b"first-gap-parameters",
        ))
        .expect("create first live-gap job");
    let before = database_snapshot(&path);

    let error = store
        .create_live_gap_job(new_live_gap_job_with_id(
            &format!("job_{}", "55".repeat(32)),
            &window_id,
            b"second-gap-parameters",
        ))
        .expect_err("a second job ID for one live window must conflict");
    assert_eq!(error.code(), STORE_LEDGER_CONFLICT);
    assert_eq!(database_snapshot(&path), before);
    assert_eq!(table_count(&path, "backfill_jobs"), 1);
}

#[test]
fn live_window_id_remains_deterministic_across_key_rotation() {
    let (_directory, path, mut store, inbox_id) = setup_one_processed_row();
    let window_id = expected_window_id(&inbox_id);
    let window = live_window(CANARY_BATCH);
    store
        .create_collecting_live_window(&inbox_id, new_window(&inbox_id, 0))
        .expect("create collecting window under key version one");
    store
        .finalize_live_window(&inbox_id, &window_id, &window, &[], &[])
        .expect("prepare live window under key version one");
    drop(store);

    let rotated = Keyring::new([0x22; 32], 2)
        .expect("construct rotated keyring")
        .with_decryption_key(1, [0x11; 32])
        .expect("retain key version one");
    let mut store = Store::open(&path, rotated).expect("reopen with rotated keyring");
    assert_eq!(
        store
            .finalize_live_window(&inbox_id, &window_id, &window, &[], &[])
            .expect("recognize prepared window after key rotation"),
        FinalizeOutcome::AlreadyPrepared { batch_count: 1 }
    );

    let pending = store
        .next_pending_ingestion_batch(timestamp(1_757_550_124_000))
        .expect("select rotated-key live batch")
        .expect("prepared live batch exists");
    let row_id = pending.row_id().to_owned();
    assert_eq!(
        store
            .accept_live_batch_and_maybe_commit_window(&row_id, timestamp(1_757_550_125_000))
            .expect("complete original live window after rotation"),
        LiveCommitOutcome::WindowCommitted
    );

    let new_inbox_id = store
        .append_fetched_sync(
            NewRawSyncInbox::new(
                NEXT_TOKEN.to_vec(),
                b"rotated-next-token".to_vec(),
                b"rotated-response".to_vec(),
                timestamp(1_757_550_126_000),
            )
            .expect("construct new rotated response"),
        )
        .expect("append new response under active key version two");
    assert_ne!(new_inbox_id.as_str(), inbox_id);
    let response_key_versions: Vec<i64> = Connection::open(&path)
        .expect("open sqlite inspection connection")
        .prepare("SELECT response_key_version FROM sync_inbox ORDER BY rowid")
        .expect("prepare response key version query")
        .query_map([], |row| row.get(0))
        .expect("query response key versions")
        .collect::<Result<_, _>>()
        .expect("collect response key versions");
    assert_eq!(response_key_versions, vec![1, 2]);
}

#[test]
fn live_gap_accepts_the_closed_job_id_contract() {
    let (_directory, path, mut store, inbox_id) = setup_one_processed_row();
    let window_id = expected_window_id(&inbox_id);
    store
        .create_collecting_live_window(&inbox_id, new_window(&inbox_id, 0))
        .expect("create collecting window");

    let job_id = "gap_job_0123456789abcdef";
    store
        .create_live_gap_job(new_live_gap_job_with_id(
            job_id,
            &window_id,
            b"resource-id-parameters",
        ))
        .expect("resource-style job ID is valid");
    assert_eq!(table_count(&path, "backfill_jobs"), 1);
}

#[test]
fn complete_live_gap_prepares_live_rows_and_completes_only_the_gap_job() {
    let (_directory, path, mut store, inbox_id) = setup_one_processed_row();
    let window_id = expected_window_id(&inbox_id);
    store
        .create_collecting_live_window(&inbox_id, new_window(&inbox_id, 0))
        .expect("create collecting window");
    let job_id = format!("job_{}", "44".repeat(32));
    store
        .create_live_gap_job(new_live_gap_job(&window_id, b"gap-complete-parameters"))
        .expect("create live-gap job");
    store
        .begin_or_resume_live_gap_job(&job_id)
        .expect("begin live-gap job");
    let window = live_window(CANARY_BATCH);
    let (anchors, ephemeral) = candidate_sets();

    assert_eq!(
        store
            .complete_live_gap_and_finalize_window(&job_id, &window, &anchors, &ephemeral)
            .expect("complete live-gap job and prepare window"),
        FinalizeOutcome::Prepared { batch_count: 1 }
    );

    let connection = Connection::open(&path).expect("open sqlite inspection connection");
    let states: (String, String, String, Option<String>, Option<String>) = connection
        .query_row(
            "SELECT i.state, w.state, j.state, j.completed_at, j.cancelled_at
             FROM sync_inbox i
             JOIN sync_windows w ON w.inbox_id = i.inbox_id
             JOIN backfill_jobs j ON j.live_window_id = w.window_id
             WHERE i.inbox_id = ?1",
            [&inbox_id],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                ))
            },
        )
        .expect("read completed live-gap state");
    assert_eq!(states.0, "prepared");
    assert_eq!(states.1, "pending");
    assert_eq!(states.2, "completed");
    assert!(states.3.is_some());
    assert!(states.4.is_none());
    let ownership: (String, String, Option<String>) = connection
        .query_row(
            "SELECT source_kind, window_id, backfill_job_id FROM outbox_batches",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .expect("read live outbox ownership");
    assert_eq!(ownership, ("live".to_owned(), window_id, None));

    drop(connection);
    drop(store);
    let mut reopened = Store::open(&path, test_keyring()).expect("reopen store");
    let (anchors, ephemeral) = candidate_sets();
    assert_eq!(
        reopened
            .complete_live_gap_and_finalize_window(&job_id, &window, &anchors, &ephemeral)
            .expect("identical completion is idempotent after reopen"),
        FinalizeOutcome::AlreadyPrepared { batch_count: 1 }
    );
    let changed = live_window("changed-live-gap-batch");
    let (anchors, ephemeral) = candidate_sets();
    let error = reopened
        .complete_live_gap_and_finalize_window(&job_id, &changed, &anchors, &ephemeral)
        .expect_err("changed completion bytes must conflict");
    assert_eq!(error.code(), STORE_LEDGER_CONFLICT);
    assert_eq!(table_count(&path, "outbox_batches"), 1);
}

#[test]
fn live_gap_rejects_inconsistent_persisted_window_as_corrupt() {
    let (_directory, path, mut store, inbox_id) = setup_one_processed_row();
    let window_id = expected_window_id(&inbox_id);
    store
        .create_collecting_live_window(&inbox_id, new_window(&inbox_id, 0))
        .expect("create collecting window");
    store
        .create_live_gap_job(new_live_gap_job(&window_id, b"window-state-canary"))
        .expect("create live-gap job");

    Connection::open(&path)
        .expect("open sqlite mutation connection")
        .execute(
            "UPDATE sync_windows SET state = 'pending', batch_count = 1
             WHERE window_id = ?1",
            [&window_id],
        )
        .expect("tamper window state");

    let error = store
        .begin_or_resume_live_gap_job(&format!("job_{}", "44".repeat(32)))
        .expect_err("inconsistent window state must be corrupt");
    assert_eq!(error.code(), STORE_LEDGER_CORRUPT);
    let state: String = Connection::open(&path)
        .expect("open sqlite inspection connection")
        .query_row("SELECT state FROM backfill_jobs", [], |row| row.get(0))
        .expect("read unchanged job state");
    assert_eq!(state, "pending");
}
