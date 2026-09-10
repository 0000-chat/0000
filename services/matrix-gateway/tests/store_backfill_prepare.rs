use std::{
    fs,
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
};

use chrono::{DateTime, TimeZone, Utc};
use communicator_matrix_gateway::{
    batch::BackfillJob,
    crypto::Keyring,
    ledger::{
        BackfillState, NewBackfillJob, STORE_BACKFILL_CONFLICT, STORE_BACKFILL_CORRUPT,
        STORE_BACKFILL_INVALID, STORE_BACKFILL_NOT_READY,
    },
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
