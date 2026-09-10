use std::{
    fs,
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
};

use chrono::{DateTime, TimeZone, Utc};
use communicator_matrix_gateway::{
    batch::{BackfillJob, BatchWindow, RoutedEvent, build_window},
    canonical::canonical_event_json_line_bytes,
    crypto::Keyring,
    ledger::{
        BackfillState, NewBackfillJob, STORE_BACKFILL_CONFLICT, STORE_BACKFILL_CORRUPT,
        STORE_BACKFILL_INVALID, STORE_BACKFILL_NOT_READY,
    },
    model::{
        CanonicalEvent, CanonicalEventSource, CanonicalPayload, DeliveryStatus, Direction,
        MessageCreatedPayload, Provider,
    },
    secret::SecretBytes,
    store::Store,
};
use rusqlite::{Connection, OptionalExtension, params};
use tempfile::tempdir;

const JOB_ID: &str = "018f0f2c-5f5a-7abc-8def-abcdef012345";
const SECOND_JOB_ID: &str = "018f0f2c-5f5a-7abc-8def-abcdef012346";
const ROOM_ID: &str = "!backfill:example.test";
const START_AT: &str = "2023-11-14T22:13:20.000Z";
const END_AT: &str = "2023-11-15T22:13:20.000Z";
const TERMINAL_AT: &str = "2023-11-16T22:13:20.000Z";
const TERMINAL_CODE: &str = "manual";
const PARAMETERS: &[u8] = b"operator-parameters-never-plaintext";

struct TerminalShape {
    state: &'static str,
    completed_at: Option<&'static str>,
    cancelled_at: Option<&'static str>,
    terminal_code: Option<&'static str>,
}

fn secure_tempdir() -> tempfile::TempDir {
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

fn timestamp(milliseconds: i64) -> DateTime<Utc> {
    Utc.timestamp_millis_opt(milliseconds)
        .single()
        .expect("construct test timestamp")
}

fn test_job(max_events: u64) -> BackfillJob {
    test_job_with_id(JOB_ID, max_events)
}

fn test_job_with_id(job_id: &str, max_events: u64) -> BackfillJob {
    BackfillJob::new(job_id, ROOM_ID, START_AT, END_AT, max_events)
        .expect("construct valid explicit backfill job")
}

fn new_job(job: &BackfillJob, parameters: &[u8]) -> NewBackfillJob {
    NewBackfillJob::new(
        job.clone(),
        parameters.to_vec(),
        timestamp(1_700_000_000_000),
    )
    .expect("construct valid new backfill job")
}

fn checkpoint_event(event_id: &str) -> CanonicalEvent {
    CanonicalEvent::new(
        event_id,
        CanonicalEventSource::Backfill,
        "tenant_demo",
        "identity_demo",
        Provider::Whatsapp,
        "account_demo",
        "conversation_demo",
        Some(ROOM_ID.to_owned()),
        Some(format!("${event_id}:example.test")),
        None,
        "2023-11-14T22:13:21.000Z",
        "2023-11-14T22:13:22.000Z",
        CanonicalPayload::MessageCreated(MessageCreatedPayload {
            message_id: "message_0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
                .to_owned(),
            direction: Direction::Inbound,
            sender_participant_id: Some(
                "participant_0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
                    .to_owned(),
            ),
            sender_label: "Alice".to_owned(),
            body: "checkpoint".to_owned(),
            reply_to_message_id: None,
            delivery_status: DeliveryStatus::Unknown,
            unread: true,
        }),
    )
    .expect("construct valid checkpoint event")
}

fn checkpoint_window(job: &BackfillJob, ordinal: u64, event_id: &str) -> BatchWindow {
    build_window(
        job.checkpoint(ordinal),
        timestamp(1_700_000_000_001 + i64::try_from(ordinal).expect("test ordinal fits")),
        &[RoutedEvent::new("route_demo", checkpoint_event(event_id))],
    )
    .expect("construct checkpoint window")
}

fn empty_checkpoint_window(job: &BackfillJob, ordinal: u64) -> BatchWindow {
    build_window(
        job.checkpoint(ordinal),
        timestamp(1_700_000_000_001 + i64::try_from(ordinal).expect("test ordinal fits")),
        &[],
    )
    .expect("construct empty checkpoint window")
}

fn sqlite_storage_bytes(path: &Path) -> Vec<u8> {
    let mut bytes = fs::read(path).expect("read sqlite database bytes");
    for suffix in ["-wal", "-shm"] {
        let mut sidecar = PathBuf::from(path);
        let name = format!(
            "{}{}",
            sidecar
                .file_name()
                .expect("database file name")
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

fn backfill_state(path: &Path, job_id: &str) -> Option<String> {
    let connection = Connection::open(path).expect("open sqlite database for inspection");
    connection
        .query_row(
            "SELECT state FROM backfill_jobs WHERE job_id = ?1",
            [job_id],
            |row| row.get(0),
        )
        .optional()
        .expect("read backfill state")
}

#[test]
fn creates_and_begins_explicit_job_with_exact_job_and_parameters() {
    let directory = secure_tempdir();
    let path = database_path(directory.path());
    let job = test_job(100);

    let mut store = Store::open(&path, test_keyring()).expect("open gateway store");
    store
        .create_backfill_job(new_job(&job, PARAMETERS))
        .expect("create explicit backfill job");

    assert_eq!(backfill_state(&path, JOB_ID).as_deref(), Some("pending"));
    assert_storage_excludes(&sqlite_storage_bytes(&path), PARAMETERS);

    let stored = store
        .begin_or_resume_backfill_job(JOB_ID)
        .expect("begin explicit backfill job");
    assert_eq!(stored.job(), &job);
    assert_eq!(stored.state(), BackfillState::Running);
    assert_eq!(stored.parameters().as_bytes(), PARAMETERS);
    assert!(stored.pagination().is_none());
    assert_eq!(stored.accepted_events(), 0);
}

#[test]
fn checkpoints_one_running_page_and_reopens_the_exact_state() {
    let directory = secure_tempdir();
    let path = database_path(directory.path());
    let job = test_job(100);
    let window = build_window(
        job.checkpoint(0),
        timestamp(1_700_000_000_001),
        &[RoutedEvent::new(
            "route_demo",
            checkpoint_event("evt_checkpoint"),
        )],
    )
    .expect("construct checkpoint window");
    let request = window.batches[0].exact_request_bytes().to_vec();
    let canonical_line = canonical_event_json_line_bytes(&window.batches[0].events[0])
        .expect("construct canonical event line");

    {
        let mut store = Store::open(&path, test_keyring()).expect("open gateway store");
        store
            .create_backfill_job(new_job(&job, PARAMETERS))
            .expect("create explicit backfill job");
        store
            .begin_or_resume_backfill_job(JOB_ID)
            .expect("begin explicit backfill job");
        store
            .checkpoint_backfill_page(
                JOB_ID,
                Some(
                    &SecretBytes::from_text(b"next-page", 64 * 1024)
                        .expect("construct pagination token"),
                ),
                &window,
                1,
            )
            .expect("checkpoint explicit backfill page");
    }

    let connection = Connection::open(&path).expect("open sqlite database for inspection");
    let (state, accepted_events, pagination_cipher, outbox_count, byte_count): (
        String,
        i64,
        Vec<u8>,
        i64,
        i64,
    ) = connection
        .query_row(
            "SELECT j.state, j.accepted_events, j.pagination_cipher,
                    (SELECT COUNT(*) FROM outbox_batches WHERE backfill_job_id = j.job_id),
                    (SELECT byte_count FROM outbox_batches WHERE backfill_job_id = j.job_id)
             FROM backfill_jobs AS j WHERE j.job_id = ?1",
            [JOB_ID],
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
        .expect("read checkpoint state");
    assert_eq!(state, "running");
    assert_eq!(accepted_events, 1);
    assert!(!pagination_cipher.is_empty());
    assert_eq!(outbox_count, 1);
    assert_eq!(byte_count as usize, request.len());
    assert_storage_excludes(&sqlite_storage_bytes(&path), &canonical_line);

    let mut store = Store::open(&path, test_keyring()).expect("reopen gateway store");
    let stored = store
        .begin_or_resume_backfill_job(JOB_ID)
        .expect("resume checkpointed job");
    assert_eq!(
        stored.pagination().expect("stored pagination").as_bytes(),
        b"next-page"
    );
    assert_eq!(stored.accepted_events(), 1);
}

#[test]
fn checkpoints_contiguous_pages_and_replays_exact_page_bytes() {
    let directory = secure_tempdir();
    let path = database_path(directory.path());
    let job = test_job(100);
    let page_zero = checkpoint_window(&job, 0, "evt_page_zero");
    let page_one = checkpoint_window(&job, 1, "evt_page_one");
    let gap = checkpoint_window(&job, 3, "evt_gap");
    let token_zero = SecretBytes::from_text(b"page-zero", 64 * 1024).expect("page token");
    let token_one = SecretBytes::from_text(b"page-one", 64 * 1024).expect("page token");

    let mut store = Store::open(&path, test_keyring()).expect("open gateway store");
    store
        .create_backfill_job(new_job(&job, PARAMETERS))
        .expect("create explicit backfill job");
    store
        .begin_or_resume_backfill_job(JOB_ID)
        .expect("begin explicit backfill job");
    store
        .checkpoint_backfill_page(JOB_ID, Some(&token_zero), &page_zero, 1)
        .expect("checkpoint first page");
    store
        .checkpoint_backfill_page(JOB_ID, Some(&token_zero), &page_zero, 1)
        .expect("replay first page");

    let error = store
        .checkpoint_backfill_page(JOB_ID, Some(&token_one), &gap, 2)
        .expect_err("a page with a gap must be rejected");
    assert_eq!(error.code(), STORE_BACKFILL_NOT_READY);

    store
        .checkpoint_backfill_page(JOB_ID, Some(&token_one), &page_one, 2)
        .expect("checkpoint second page");

    let connection = Connection::open(&path).expect("open sqlite database for inspection");
    let ordinals: Vec<i64> = {
        let mut statement = connection
            .prepare(
                "SELECT ordinal FROM outbox_batches
                 WHERE backfill_job_id = ?1 ORDER BY ordinal",
            )
            .expect("prepare ordinal query");
        statement
            .query_map([JOB_ID], |row| row.get(0))
            .expect("query ordinals")
            .collect::<Result<_, _>>()
            .expect("collect ordinals")
    };
    assert_eq!(ordinals, vec![0, 1]);
}

#[test]
fn checkpoint_none_persists_encrypted_exhaustion_distinct_from_sql_null() {
    let directory = secure_tempdir();
    let path = database_path(directory.path());
    let job = test_job(100);
    let empty = empty_checkpoint_window(&job, 0);

    let mut store = Store::open(&path, test_keyring()).expect("open gateway store");
    store
        .create_backfill_job(new_job(&job, PARAMETERS))
        .expect("create explicit backfill job");
    store
        .begin_or_resume_backfill_job(JOB_ID)
        .expect("begin explicit backfill job");
    let null_before: Option<Vec<u8>> = Connection::open(&path)
        .expect("open sqlite database")
        .query_row(
            "SELECT pagination_cipher FROM backfill_jobs WHERE job_id = ?1",
            [JOB_ID],
            |row| row.get(0),
        )
        .expect("read initial pagination");
    assert!(null_before.is_none());

    store
        .checkpoint_backfill_page(JOB_ID, None, &empty, 0)
        .expect("checkpoint exhausted empty page");
    drop(store);

    let keyring = test_keyring();
    let connection = Connection::open(&path).expect("open sqlite database for inspection");
    let (cipher, nonce, key_version): (Vec<u8>, Vec<u8>, i64) = connection
        .query_row(
            "SELECT pagination_cipher, pagination_nonce, key_version
             FROM backfill_jobs WHERE job_id = ?1",
            [JOB_ID],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .expect("read encrypted exhaustion");
    let plaintext = keyring
        .open(
            "backfill_jobs",
            JOB_ID,
            "pagination",
            &communicator_matrix_gateway::crypto::Sealed {
                nonce: nonce.try_into().expect("pagination nonce length"),
                ciphertext: cipher,
                key_version: u32::try_from(key_version).expect("key version fits"),
            },
        )
        .expect("open exhaustion sentinel");
    assert_eq!(
        plaintext.as_bytes(),
        br#"{"schema_version":1,"state":"exhausted"}"#
    );

    let mut reopened = Store::open(&path, test_keyring()).expect("reopen gateway store");
    let stored = reopened
        .begin_or_resume_backfill_job(JOB_ID)
        .expect("resume exhausted running job");
    assert_eq!(
        stored
            .pagination()
            .expect("exhaustion checkpoint")
            .as_bytes(),
        br#"{"schema_version":1,"state":"exhausted"}"#
    );
    assert_eq!(stored.accepted_events(), 0);
}

#[test]
fn rotated_checkpoint_reseals_parameters_and_pagination_together() {
    let directory = secure_tempdir();
    let path = database_path(directory.path());
    let job = test_job(100);
    let page_zero = checkpoint_window(&job, 0, "evt_rotation_zero");
    let page_one = checkpoint_window(&job, 1, "evt_rotation_one");
    let token_zero = SecretBytes::from_text(b"rotation-zero", 64 * 1024).expect("page token");

    {
        let mut store = Store::open(&path, test_keyring()).expect("open gateway store");
        store
            .create_backfill_job(new_job(&job, PARAMETERS))
            .expect("create explicit backfill job");
        store
            .begin_or_resume_backfill_job(JOB_ID)
            .expect("begin explicit backfill job");
        store
            .checkpoint_backfill_page(JOB_ID, Some(&token_zero), &page_zero, 1)
            .expect("checkpoint first page");
    }

    let rotated = Keyring::new([0x22; 32], 2)
        .expect("construct rotated keyring")
        .with_decryption_key(1, [0x11; 32])
        .expect("retain old key");
    let mut store = Store::open(&path, rotated).expect("open rotated gateway store");
    store
        .checkpoint_backfill_page(JOB_ID, None, &page_one, 2)
        .expect("checkpoint under rotated key");
    drop(store);

    let connection = Connection::open(&path).expect("open sqlite database for inspection");
    let versions: (i64, Vec<u8>, i64) = connection
        .query_row(
            "SELECT key_version, pagination_cipher,
                    (SELECT request_key_version FROM outbox_batches
                     WHERE backfill_job_id = ?1 AND ordinal = 0)
             FROM backfill_jobs WHERE job_id = ?1",
            [JOB_ID],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .expect("read rotated versions");
    assert_eq!(versions.0, 2);
    assert!(!versions.1.is_empty());
    assert_eq!(versions.2, 1);
}

#[test]
fn exact_page_replay_after_key_rotation_does_not_duplicate_outbox_rows() {
    let directory = secure_tempdir();
    let path = database_path(directory.path());
    let job = test_job(100);
    let page = checkpoint_window(&job, 0, "evt_rotation_replay");
    let token = SecretBytes::from_text(b"rotation-replay", 64 * 1024).expect("page token");

    {
        let mut store = Store::open(&path, test_keyring()).expect("open gateway store");
        store
            .create_backfill_job(new_job(&job, PARAMETERS))
            .expect("create explicit backfill job");
        store
            .begin_or_resume_backfill_job(JOB_ID)
            .expect("begin explicit backfill job");
        store
            .checkpoint_backfill_page(JOB_ID, Some(&token), &page, 1)
            .expect("checkpoint first page");
    }

    let rotated = Keyring::new([0x22; 32], 2)
        .expect("construct rotated keyring")
        .with_decryption_key(1, [0x11; 32])
        .expect("retain old key");
    let mut store = Store::open(&path, rotated).expect("open rotated gateway store");
    store
        .checkpoint_backfill_page(JOB_ID, Some(&token), &page, 1)
        .expect("replay page under rotated key");
    drop(store);

    let connection = Connection::open(&path).expect("open sqlite database for inspection");
    let (count, key_version): (i64, i64) = connection
        .query_row(
            "SELECT (SELECT COUNT(*) FROM outbox_batches WHERE backfill_job_id = ?1),
                    key_version
             FROM backfill_jobs WHERE job_id = ?1",
            [JOB_ID],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .expect("read replay state");
    assert_eq!(count, 1);
    assert_eq!(key_version, 2);
}

#[test]
fn checkpoint_rejects_backfill_events_from_another_room_or_source() {
    let directory = secure_tempdir();
    let path = database_path(directory.path());
    let job = test_job(100);
    let mut wrong_room_event = checkpoint_event("evt_wrong_room");
    wrong_room_event.matrix_room_id = Some("!other:example.test".to_owned());
    let wrong_room = build_window(
        job.checkpoint(0),
        timestamp(1_700_000_000_001),
        &[RoutedEvent::new("route_demo", wrong_room_event)],
    )
    .expect("construct wrong-room window");
    let mut wrong_source_event = checkpoint_event("evt_wrong_source");
    wrong_source_event.event_source = CanonicalEventSource::Live;
    let wrong_source = build_window(
        job.checkpoint(0),
        timestamp(1_700_000_000_001),
        &[RoutedEvent::new("route_demo", wrong_source_event)],
    )
    .expect("construct wrong-source window");
    let token = SecretBytes::from_text(b"next-page", 64 * 1024).expect("page token");

    let mut store = Store::open(&path, test_keyring()).expect("open gateway store");
    store
        .create_backfill_job(new_job(&job, PARAMETERS))
        .expect("create explicit backfill job");
    store
        .begin_or_resume_backfill_job(JOB_ID)
        .expect("begin explicit backfill job");

    for window in [&wrong_room, &wrong_source] {
        let error = store
            .checkpoint_backfill_page(JOB_ID, Some(&token), window, 1)
            .expect_err("foreign event metadata must be rejected");
        assert_eq!(error.code(), STORE_BACKFILL_INVALID);
    }

    let connection = Connection::open(&path).expect("open sqlite database for inspection");
    let (accepted_events, outbox_count): (i64, i64) = connection
        .query_row(
            "SELECT accepted_events,
                    (SELECT COUNT(*) FROM outbox_batches WHERE backfill_job_id = ?1)
             FROM backfill_jobs WHERE job_id = ?1",
            [JOB_ID],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .expect("read unchanged state");
    assert_eq!(accepted_events, 0);
    assert_eq!(outbox_count, 0);
}

#[test]
fn exact_creation_replay_is_idempotent_but_changed_bytes_or_job_conflict() {
    let directory = secure_tempdir();
    let path = database_path(directory.path());
    let job = test_job(100);

    let mut store = Store::open(&path, test_keyring()).expect("open gateway store");
    store
        .create_backfill_job(new_job(&job, PARAMETERS))
        .expect("create explicit backfill job");
    store
        .create_backfill_job(new_job(&job, PARAMETERS))
        .expect("replay exact explicit backfill job");

    let changed_parameters = store
        .create_backfill_job(new_job(&job, b"changed-parameters"))
        .expect_err("changed parameters must conflict");
    assert_eq!(changed_parameters.code(), STORE_BACKFILL_CONFLICT);

    let changed_job = store
        .create_backfill_job(new_job(&test_job(101), PARAMETERS))
        .expect_err("changed immutable job fields must conflict");
    assert_eq!(changed_job.code(), STORE_BACKFILL_CONFLICT);

    let connection = Connection::open(&path).expect("open sqlite database for inspection");
    let count: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM backfill_jobs WHERE job_id = ?1",
            [JOB_ID],
            |row| row.get(0),
        )
        .expect("count explicit backfill jobs");
    assert_eq!(count, 1);
}

#[test]
fn begin_resumes_running_job_after_reopen_and_rejects_terminal_or_live_gap_rows() {
    let directory = secure_tempdir();
    let path = database_path(directory.path());
    let job = test_job(100);

    {
        let mut store = Store::open(&path, test_keyring()).expect("open gateway store");
        store
            .create_backfill_job(new_job(&job, PARAMETERS))
            .expect("create explicit backfill job");
    }

    {
        let mut store = Store::open(&path, test_keyring()).expect("reopen gateway store");
        let stored = store
            .begin_or_resume_backfill_job(JOB_ID)
            .expect("begin pending job after reopen");
        assert_eq!(stored.state(), BackfillState::Running);

        let resumed = store
            .begin_or_resume_backfill_job(JOB_ID)
            .expect("resume already-running job after reopen");
        assert_eq!(resumed.job(), &job);
        assert_eq!(resumed.state(), BackfillState::Running);
        assert_eq!(resumed.parameters().as_bytes(), PARAMETERS);
        assert!(resumed.pagination().is_none());
        assert_eq!(resumed.accepted_events(), 0);
    }

    for (state, completed_at, cancelled_at, terminal_code) in [
        ("completed", Some(TERMINAL_AT), None, None),
        ("cancelled", None, Some(TERMINAL_AT), None),
        ("quarantined", None, None, Some(TERMINAL_CODE)),
    ] {
        let connection = Connection::open(&path).expect("open sqlite database for mutation");
        connection
            .execute(
                "UPDATE backfill_jobs
                 SET state = ?1, completed_at = ?2, cancelled_at = ?3, terminal_code = ?4
                 WHERE job_id = ?5",
                params![state, completed_at, cancelled_at, terminal_code, JOB_ID],
            )
            .expect("set valid terminal backfill row");
        drop(connection);

        let mut store = Store::open(&path, test_keyring()).expect("reopen terminal store");
        let error = store
            .begin_or_resume_backfill_job(JOB_ID)
            .expect_err("terminal backfill job must not resume");
        assert_eq!(error.code(), STORE_BACKFILL_NOT_READY);
        drop(store);
    }

    let malformed_terminal_rows = [
        TerminalShape {
            state: "completed",
            completed_at: None,
            cancelled_at: None,
            terminal_code: None,
        },
        TerminalShape {
            state: "cancelled",
            completed_at: None,
            cancelled_at: None,
            terminal_code: None,
        },
        TerminalShape {
            state: "quarantined",
            completed_at: None,
            cancelled_at: None,
            terminal_code: None,
        },
    ];
    for terminal in malformed_terminal_rows {
        let connection = Connection::open(&path).expect("open sqlite database for mutation");
        connection
            .execute(
                "UPDATE backfill_jobs
                 SET state = ?1, completed_at = ?2, cancelled_at = ?3, terminal_code = ?4
                 WHERE job_id = ?5",
                params![
                    terminal.state,
                    terminal.completed_at,
                    terminal.cancelled_at,
                    terminal.terminal_code,
                    JOB_ID
                ],
            )
            .expect("set malformed terminal backfill row");
        drop(connection);

        let mut store = Store::open(&path, test_keyring()).expect("reopen malformed store");
        let error = store
            .begin_or_resume_backfill_job(JOB_ID)
            .expect_err("malformed terminal row must fail closed");
        assert_eq!(error.code(), STORE_BACKFILL_CORRUPT);
        drop(store);
    }

    let connection = Connection::open(&path).expect("open sqlite database for live-gap mutation");
    connection
        .pragma_update(None, "foreign_keys", false)
        .expect("disable foreign keys for corruption fixture");
    connection
        .execute(
            "UPDATE backfill_jobs
             SET kind = 'live_gap', live_window_id = ?1, state = 'pending'
             WHERE job_id = ?2",
            params![
                "window_0000000000000000000000000000000000000000000000000000000000000000",
                JOB_ID
            ],
        )
        .expect("mark row as live gap");
    drop(connection);

    let mut store = Store::open(&path, test_keyring()).expect("reopen live-gap store");
    let error = store
        .begin_or_resume_backfill_job(JOB_ID)
        .expect_err("live-gap row must not resume as explicit job");
    assert_eq!(error.code(), STORE_BACKFILL_NOT_READY);
    drop(store);

    let connection =
        Connection::open(&path).expect("open sqlite database for unknown-kind mutation");
    connection
        .pragma_update(None, "ignore_check_constraints", true)
        .expect("disable check constraints for corruption fixture");
    connection
        .execute(
            "UPDATE backfill_jobs
             SET kind = 'unknown', live_window_id = NULL, state = 'pending'
             WHERE job_id = ?1",
            [JOB_ID],
        )
        .expect("mark row with unknown kind");
    drop(connection);

    let mut store = Store::open(&path, test_keyring()).expect("reopen unknown-kind store");
    let error = store
        .begin_or_resume_backfill_job(JOB_ID)
        .expect_err("unknown kind must fail closed as corruption");
    assert_eq!(error.code(), STORE_BACKFILL_CORRUPT);
    drop(store);

    let connection = Connection::open(&path).expect("open sqlite database for linkage mutation");
    connection
        .pragma_update(None, "foreign_keys", false)
        .expect("disable foreign keys for linkage corruption fixture");
    connection
        .pragma_update(None, "ignore_check_constraints", true)
        .expect("disable check constraints for linkage corruption fixture");
    connection
        .execute(
            "UPDATE backfill_jobs
             SET kind = 'explicit', live_window_id = ?1, state = 'pending'
             WHERE job_id = ?2",
            params![
                "window_0000000000000000000000000000000000000000000000000000000000000000",
                JOB_ID
            ],
        )
        .expect("mark explicit row with live-window linkage");
    drop(connection);

    let mut store = Store::open(&path, test_keyring()).expect("reopen malformed-linkage store");
    let error = store
        .begin_or_resume_backfill_job(JOB_ID)
        .expect_err("explicit row with live-window linkage must fail closed");
    assert_eq!(error.code(), STORE_BACKFILL_CORRUPT);
}

#[test]
fn tampered_parameters_fail_closed_without_changing_pending_state() {
    let directory = secure_tempdir();
    let path = database_path(directory.path());
    let job = test_job(100);

    {
        let mut store = Store::open(&path, test_keyring()).expect("open gateway store");
        store
            .create_backfill_job(new_job(&job, PARAMETERS))
            .expect("create explicit backfill job");
    }

    let connection = Connection::open(&path).expect("open sqlite database for corruption");
    connection
        .execute(
            "UPDATE backfill_jobs SET parameters_cipher = zeroblob(16) WHERE job_id = ?1",
            [JOB_ID],
        )
        .expect("tamper parameters ciphertext");
    drop(connection);

    let mut store = Store::open(&path, test_keyring()).expect("reopen corrupted store");
    let error = store
        .begin_or_resume_backfill_job(JOB_ID)
        .expect_err("tampered parameters must fail closed");
    assert_eq!(error.code(), STORE_BACKFILL_CORRUPT);
    assert_eq!(backfill_state(&path, JOB_ID).as_deref(), Some("pending"));
}

#[test]
fn aad_binding_rejects_row_id_and_cross_context_ciphertext() {
    let directory = secure_tempdir();
    let path = database_path(directory.path());
    let job = test_job(100);

    {
        let mut store = Store::open(&path, test_keyring()).expect("open gateway store");
        store
            .create_backfill_job(new_job(&job, PARAMETERS))
            .expect("create explicit backfill job");
    }

    let connection = Connection::open(&path).expect("open sqlite database for row-ID tampering");
    connection
        .execute(
            "UPDATE backfill_jobs SET job_id = ?1 WHERE job_id = ?2",
            params![SECOND_JOB_ID, JOB_ID],
        )
        .expect("tamper protected row ID");
    drop(connection);

    let mut store = Store::open(&path, test_keyring()).expect("reopen row-ID-tampered store");
    let error = store
        .begin_or_resume_backfill_job(SECOND_JOB_ID)
        .expect_err("changing the row ID must break protected AAD");
    assert_eq!(error.code(), STORE_BACKFILL_CORRUPT);

    let directory = secure_tempdir();
    let path = database_path(directory.path());
    let first_job = test_job_with_id(JOB_ID, 100);
    let second_job = test_job_with_id(SECOND_JOB_ID, 200);

    {
        let mut store = Store::open(&path, test_keyring()).expect("open gateway store");
        store
            .create_backfill_job(new_job(&first_job, PARAMETERS))
            .expect("create first explicit backfill job");
        store
            .create_backfill_job(new_job(&second_job, b"second-job-parameters"))
            .expect("create second explicit backfill job");
    }

    let connection = Connection::open(&path).expect("open sqlite database for context tampering");
    let (ciphertext, nonce): (Vec<u8>, Vec<u8>) = connection
        .query_row(
            "SELECT parameters_cipher, parameters_nonce
             FROM backfill_jobs WHERE job_id = ?1",
            [SECOND_JOB_ID],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .expect("read second job protected values");
    connection
        .execute(
            "UPDATE backfill_jobs
             SET parameters_cipher = ?1, parameters_nonce = ?2
             WHERE job_id = ?3",
            params![ciphertext, nonce, JOB_ID],
        )
        .expect("swap protected values across row contexts");
    drop(connection);

    let mut store = Store::open(&path, test_keyring()).expect("reopen context-tampered store");
    let error = store
        .begin_or_resume_backfill_job(JOB_ID)
        .expect_err("swapping protected values across contexts must fail AAD verification");
    assert_eq!(error.code(), STORE_BACKFILL_CORRUPT);
}

#[test]
fn rejects_malformed_job_id_version_variant_uppercase_and_casing() {
    let directory = secure_tempdir();
    let path = database_path(directory.path());
    let mut store = Store::open(&path, test_keyring()).expect("open gateway store");

    for job_id in [
        "018f0f2c-5f5a-7abc-8def-abcdef01234",
        "018f0f2c-5f5a-4abc-8def-abcdef012345",
        "018f0f2c-5f5a-7abc-cdef-abcdef012345",
        "018F0F2C-5F5A-7ABC-8DEF-ABCDEF012345",
        "018f0f2c-5f5a-7aBc-8def-abcdef012345",
    ] {
        let error = store
            .begin_or_resume_backfill_job(job_id)
            .expect_err("malformed job ID must be rejected");
        assert_eq!(error.code(), STORE_BACKFILL_INVALID, "job ID: {job_id}");
    }
}

fn assert_storage_excludes(bytes: &[u8], plaintext: &[u8]) {
    assert!(
        !bytes
            .windows(plaintext.len())
            .any(|window| window == plaintext),
        "protected plaintext unexpectedly present in sqlite storage"
    );
}
