use std::{
    fmt::Write as _,
    fs,
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
};

use chrono::{DateTime, Duration, TimeZone, Utc};
use communicator_matrix_gateway::{
    crypto::{AEAD_TAG_BYTES, Keyring, Sealed},
    secret::SafeError,
    store::{
        STORE_ALREADY_BOOTSTRAPPED, STORE_BOOTSTRAP_INVALID, STORE_SDK_POSITION_UNJOURNALED,
        STORE_SYNC_CONFLICT, STORE_SYNC_CORRUPT, STORE_SYNC_INVALID, STORE_SYNC_TOKEN_MISMATCH,
        STORE_SYNC_TOO_LARGE, Store,
    },
    store_types::{
        InboxId, MAX_BOOTSTRAP_ROOM_ANCHORS, MAX_BOOTSTRAP_SESSION_BYTES, MAX_ROOM_ANCHOR_BYTES,
        MAX_SYNC_RESPONSE_BYTES, MAX_SYNC_TOKEN_BYTES, NewBootstrapState, NewRawSyncInbox,
        ReasonCode, RoomAnchor, SdkInboxPosition, SyncInboxState,
    },
};
use rusqlite::{Connection, OptionalExtension, params};
use tempfile::tempdir;

const CANARIES: [&str; 3] = [
    "sync-request-canary-6e0f8a3e",
    "sync-next-token-canary-9b1a5d7c",
    "sync-response-canary-2c4f7e81",
];

fn timestamp(milliseconds: i64) -> DateTime<Utc> {
    Utc.timestamp_millis_opt(milliseconds)
        .single()
        .expect("construct test timestamp")
}

fn assert_error(error: SafeError, code: &str) {
    assert_eq!(error.code(), code);
    assert_eq!(error.to_string(), code);
    assert_eq!(format!("{error}"), code);
}

fn anchor(lookup: [u8; 32], bytes: usize) -> RoomAnchor {
    RoomAnchor::new(lookup, vec![0xA5; bytes]).expect("construct test room anchor")
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

fn bootstrap_state(session: &[u8], token: &[u8], anchors: Vec<RoomAnchor>) -> NewBootstrapState {
    NewBootstrapState::new(
        session.to_vec(),
        token.to_vec(),
        anchors,
        timestamp(1_700_000_000_000),
    )
    .expect("construct valid bootstrap state")
}

#[derive(Debug, Eq, PartialEq)]
struct RawGatewayState {
    singleton: i64,
    session_cipher: Vec<u8>,
    session_nonce: Vec<u8>,
    session_key_version: i64,
    committed_token_cipher: Vec<u8>,
    committed_token_nonce: Vec<u8>,
    committed_token_key_version: i64,
    fetch_token_cipher: Vec<u8>,
    fetch_token_nonce: Vec<u8>,
    fetch_token_key_version: i64,
    maintenance_code: Option<String>,
    maintenance_since: Option<String>,
    bootstrapped_at: Option<String>,
    updated_at: String,
}

fn raw_gateway_state(path: &Path) -> Option<RawGatewayState> {
    let connection = Connection::open(path).expect("open sqlite database for bootstrap inspection");
    connection
        .query_row(
            "SELECT singleton, session_cipher, session_nonce, session_key_version,
                    committed_token_cipher, committed_token_nonce, committed_token_key_version,
                    fetch_token_cipher, fetch_token_nonce, fetch_token_key_version,
                    maintenance_code, maintenance_since, bootstrapped_at, updated_at
             FROM gateway_state",
            [],
            |row| {
                Ok(RawGatewayState {
                    singleton: row.get(0)?,
                    session_cipher: row.get(1)?,
                    session_nonce: row.get(2)?,
                    session_key_version: row.get(3)?,
                    committed_token_cipher: row.get(4)?,
                    committed_token_nonce: row.get(5)?,
                    committed_token_key_version: row.get(6)?,
                    fetch_token_cipher: row.get(7)?,
                    fetch_token_nonce: row.get(8)?,
                    fetch_token_key_version: row.get(9)?,
                    maintenance_code: row.get(10)?,
                    maintenance_since: row.get(11)?,
                    bootstrapped_at: row.get(12)?,
                    updated_at: row.get(13)?,
                })
            },
        )
        .optional()
        .expect("read gateway bootstrap row")
}

#[derive(Debug, Eq, PartialEq)]
struct RawRoomProgress {
    room_lookup: Vec<u8>,
    anchor_event_cipher: Vec<u8>,
    anchor_event_nonce: Vec<u8>,
    key_version: i64,
    updated_at: String,
}

fn raw_room_progress(path: &Path) -> Vec<RawRoomProgress> {
    let connection = Connection::open(path).expect("open sqlite database for anchor inspection");
    let mut statement = connection
        .prepare(
            "SELECT room_lookup, anchor_event_cipher, anchor_event_nonce,
                    key_version, updated_at
             FROM room_progress ORDER BY room_lookup",
        )
        .expect("prepare room anchor inspection");
    statement
        .query_map([], |row| {
            Ok(RawRoomProgress {
                room_lookup: row.get(0)?,
                anchor_event_cipher: row.get(1)?,
                anchor_event_nonce: row.get(2)?,
                key_version: row.get(3)?,
                updated_at: row.get(4)?,
            })
        })
        .expect("query room anchor inspection")
        .collect::<Result<Vec<_>, _>>()
        .expect("read room anchor rows")
}

fn table_count(path: &Path, table: &str) -> i64 {
    let connection = Connection::open(path).expect("open sqlite database for count inspection");
    connection
        .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
            row.get(0)
        })
        .expect("count sqlite rows")
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
    assert!(!bytes.windows(needle.len()).any(|window| window == needle));
}

fn assert_code_only(error: SafeError, code: &str) {
    assert_eq!(error.code(), code);
    assert_eq!(error.to_string(), code);
    assert_eq!(format!("{error}"), code);
    assert_eq!(
        format!("{error:?}"),
        format!("SafeError {{ code: \"{code}\" }}")
    );
}

fn unique_anchors(count: usize) -> Vec<RoomAnchor> {
    let mut anchors = Vec::with_capacity(count);
    for index in 0..count {
        let mut lookup = [0_u8; 32];
        lookup[24..].copy_from_slice(&(index as u64).to_be_bytes());
        anchors.push(anchor(lookup, 1));
    }
    anchors
}

#[test]
fn constants_match_the_locked_sync_limits() {
    assert_eq!(MAX_SYNC_RESPONSE_BYTES, 64 * 1024 * 1024);
    assert_eq!(MAX_SYNC_TOKEN_BYTES, 64 * 1024);
    assert_eq!(MAX_BOOTSTRAP_SESSION_BYTES, 1024 * 1024);
    assert_eq!(MAX_BOOTSTRAP_ROOM_ANCHORS, 100_000);
    assert_eq!(MAX_ROOM_ANCHOR_BYTES, 64 * 1024);
}

#[test]
fn stable_sync_error_constants_match_the_wire_contract() {
    assert_eq!(STORE_SYNC_INVALID, "store_sync_invalid");
    assert_eq!(STORE_SYNC_TOO_LARGE, "store_sync_too_large");
    assert_eq!(STORE_SYNC_TOKEN_MISMATCH, "store_sync_token_mismatch");
    assert_eq!(STORE_SYNC_CONFLICT, "store_sync_conflict");
    assert_eq!(
        STORE_SDK_POSITION_UNJOURNALED,
        "matrix_sdk_position_unjournaled"
    );
}

#[test]
fn room_anchor_accepts_nonempty_bytes_at_the_exact_limit() {
    let value = anchor([0x11; 32], MAX_ROOM_ANCHOR_BYTES);
    assert_eq!(value.room_lookup(), &[0x11; 32]);
    assert_eq!(value.anchor_event().as_bytes().len(), MAX_ROOM_ANCHOR_BYTES);

    assert_error(
        RoomAnchor::new([0x11; 32], Vec::new()).expect_err("empty anchor must fail"),
        STORE_BOOTSTRAP_INVALID,
    );
    assert_error(
        RoomAnchor::new([0x11; 32], vec![0xA5; MAX_ROOM_ANCHOR_BYTES + 1])
            .expect_err("oversized anchor must fail"),
        STORE_BOOTSTRAP_INVALID,
    );
}

#[test]
fn bootstrap_accepts_exact_session_token_and_anchor_limits() {
    let anchors = vec![anchor([0x22; 32], MAX_ROOM_ANCHOR_BYTES)];
    let value = NewBootstrapState::new(
        vec![0xB6; MAX_BOOTSTRAP_SESSION_BYTES],
        vec![0xC7; MAX_SYNC_TOKEN_BYTES],
        anchors,
        timestamp(1_700_000_000_000),
    )
    .expect("exact bootstrap limits must be accepted");
    let _ = value;

    assert_error(
        NewBootstrapState::new(
            Vec::new(),
            vec![0xC7],
            Vec::new(),
            timestamp(1_700_000_000_000),
        )
        .expect_err("empty session must fail"),
        STORE_BOOTSTRAP_INVALID,
    );
    assert_error(
        NewBootstrapState::new(
            vec![0xB6; MAX_BOOTSTRAP_SESSION_BYTES + 1],
            vec![0xC7],
            Vec::new(),
            timestamp(1_700_000_000_000),
        )
        .expect_err("oversized session must fail"),
        STORE_BOOTSTRAP_INVALID,
    );
    assert_error(
        NewBootstrapState::new(
            vec![0xB6],
            vec![0xC7; MAX_SYNC_TOKEN_BYTES + 1],
            Vec::new(),
            timestamp(1_700_000_000_000),
        )
        .expect_err("oversized bootstrap token must fail"),
        STORE_BOOTSTRAP_INVALID,
    );
}

#[test]
fn bootstrap_rejects_duplicate_and_over_limit_room_anchors() {
    let duplicate = vec![anchor([0x33; 32], 1), anchor([0x33; 32], 1)];
    assert_error(
        NewBootstrapState::new(
            vec![0xB6],
            vec![0xC7],
            duplicate,
            timestamp(1_700_000_000_000),
        )
        .expect_err("duplicate room lookups must fail"),
        STORE_BOOTSTRAP_INVALID,
    );

    let accepted_at_limit = NewBootstrapState::new(
        vec![0xB6],
        vec![0xC7],
        unique_anchors(MAX_BOOTSTRAP_ROOM_ANCHORS),
        timestamp(1_700_000_000_000),
    )
    .expect("exactly 100,000 unique room anchors must be accepted");
    drop(accepted_at_limit);

    assert_error(
        NewBootstrapState::new(
            vec![0xB6],
            vec![0xC7],
            unique_anchors(MAX_BOOTSTRAP_ROOM_ANCHORS + 1),
            timestamp(1_700_000_000_000),
        )
        .expect_err("too many room anchors must fail"),
        STORE_BOOTSTRAP_INVALID,
    );
}

#[test]
fn bootstrap_and_sync_reject_sub_millisecond_and_out_of_range_timestamps() {
    let sub_millisecond = Utc
        .timestamp_opt(1_700_000_000, 1)
        .single()
        .expect("construct sub-millisecond timestamp");
    assert_error(
        NewBootstrapState::new(vec![0xB6], vec![0xC7], Vec::new(), sub_millisecond)
            .expect_err("sub-millisecond bootstrap timestamp must fail"),
        STORE_BOOTSTRAP_INVALID,
    );
    assert_error(
        NewRawSyncInbox::new(vec![0xB6], vec![0xC7], vec![0xD8], sub_millisecond)
            .expect_err("sub-millisecond sync timestamp must fail"),
        STORE_SYNC_INVALID,
    );

    let out_of_range = DateTime::<Utc>::MAX_UTC - Duration::nanoseconds(999_999_999);
    assert_eq!(out_of_range.timestamp_subsec_nanos(), 0);
    assert_error(
        NewBootstrapState::new(vec![0xB6], vec![0xC7], Vec::new(), out_of_range)
            .expect_err("out-of-range bootstrap timestamp must fail"),
        STORE_BOOTSTRAP_INVALID,
    );
    assert_error(
        NewRawSyncInbox::new(vec![0xB6], vec![0xC7], vec![0xD8], out_of_range)
            .expect_err("out-of-range sync timestamp must fail"),
        STORE_SYNC_INVALID,
    );
}

#[test]
fn raw_sync_inbox_accepts_exact_token_and_response_limits() {
    let value = NewRawSyncInbox::new(
        vec![0xB6; MAX_SYNC_TOKEN_BYTES],
        vec![0xC7; MAX_SYNC_TOKEN_BYTES],
        vec![0xD8; MAX_SYNC_RESPONSE_BYTES],
        timestamp(1_700_000_000_000),
    )
    .expect("exact sync limits must be accepted");
    let _ = value;

    assert_error(
        NewRawSyncInbox::new(
            Vec::new(),
            vec![0xC7],
            vec![0xD8],
            timestamp(1_700_000_000_000),
        )
        .expect_err("empty request token must fail"),
        STORE_SYNC_INVALID,
    );
    assert_error(
        NewRawSyncInbox::new(
            vec![0xB6],
            Vec::new(),
            vec![0xD8],
            timestamp(1_700_000_000_000),
        )
        .expect_err("empty next token must fail"),
        STORE_SYNC_INVALID,
    );
    assert_error(
        NewRawSyncInbox::new(
            vec![0xB6],
            vec![0xC7],
            Vec::new(),
            timestamp(1_700_000_000_000),
        )
        .expect_err("empty response must fail"),
        STORE_SYNC_INVALID,
    );
    assert_error(
        NewRawSyncInbox::new(
            vec![0xB6; MAX_SYNC_TOKEN_BYTES + 1],
            vec![0xC7],
            vec![0xD8],
            timestamp(1_700_000_000_000),
        )
        .expect_err("oversized request token must fail"),
        STORE_SYNC_TOO_LARGE,
    );
    assert_error(
        NewRawSyncInbox::new(
            vec![0xB6],
            vec![0xC7; MAX_SYNC_TOKEN_BYTES + 1],
            vec![0xD8],
            timestamp(1_700_000_000_000),
        )
        .expect_err("oversized next token must fail"),
        STORE_SYNC_TOO_LARGE,
    );

    let oversized_response = vec![0xD8; MAX_SYNC_RESPONSE_BYTES + 1];
    assert_error(
        NewRawSyncInbox::new(
            vec![0xB6],
            vec![0xC7],
            oversized_response,
            timestamp(1_700_000_000_000),
        )
        .expect_err("64 MiB plus one response byte must fail"),
        STORE_SYNC_TOO_LARGE,
    );
}

#[test]
fn reason_codes_accept_only_bounded_lowercase_wire_codes() {
    for value in ["abc".to_owned(), "a1_b2".to_owned(), "a".repeat(64)] {
        let reason = ReasonCode::new(value.clone());
        assert_eq!(reason.expect("valid reason code").as_str(), value);
    }

    for value in [
        "".to_owned(),
        "ab".to_owned(),
        "a".repeat(65),
        "Abc".to_owned(),
        "1abc".to_owned(),
        "abc_".to_owned(),
        "_abc".to_owned(),
        "ab__cd".to_owned(),
        "ab-cd".to_owned(),
        "ab cd".to_owned(),
        "ab.cd".to_owned(),
    ] {
        assert_error(
            ReasonCode::new(value).expect_err("invalid reason code must fail"),
            STORE_SYNC_INVALID,
        );
    }
}

#[test]
fn state_and_sdk_position_mappings_are_exact() {
    let states = [
        (SyncInboxState::Fetched, "fetched"),
        (SyncInboxState::SdkProcessed, "sdk_processed"),
        (SyncInboxState::Prepared, "prepared"),
        (SyncInboxState::Committed, "committed"),
        (SyncInboxState::Quarantined, "quarantined"),
    ];
    for (state, wire) in states {
        assert_eq!(state.as_str(), wire);
    }

    assert_eq!(SdkInboxPosition::Committed.journaled_inbox_id(), None);
    let _ = SyncInboxState::Fetched;
}

#[test]
fn secret_bearing_dto_debug_and_display_are_exactly_redacted() {
    let canary_anchor = RoomAnchor::new([0x44; 32], CANARIES[0].as_bytes().to_vec())
        .expect("construct canary anchor");
    assert_redacted(&canary_anchor, "RoomAnchor([REDACTED])", CANARIES[0]);

    let bootstrap = NewBootstrapState::new(
        CANARIES[0].as_bytes().to_vec(),
        CANARIES[1].as_bytes().to_vec(),
        vec![anchor([0x45; 32], 1)],
        timestamp(1_700_000_000_000),
    )
    .expect("construct canary bootstrap");
    assert_redacted(&bootstrap, "NewBootstrapState([REDACTED])", CANARIES[0]);
    assert!(!format!("{bootstrap:?}").contains(CANARIES[1]));
    assert!(!bootstrap.to_string().contains(CANARIES[1]));

    let sync = NewRawSyncInbox::new(
        CANARIES[0].as_bytes().to_vec(),
        CANARIES[1].as_bytes().to_vec(),
        CANARIES[2].as_bytes().to_vec(),
        timestamp(1_700_000_000_000),
    )
    .expect("construct canary sync inbox");
    assert_redacted(&sync, "NewRawSyncInbox([REDACTED])", CANARIES[0]);
    for canary in CANARIES.iter().skip(1) {
        assert!(!format!("{sync:?}").contains(canary));
        assert!(!sync.to_string().contains(canary));
    }
}

fn assert_redacted<T>(value: &T, expected: &str, canary: &str)
where
    T: std::fmt::Debug + std::fmt::Display,
{
    let mut debug = String::new();
    write!(&mut debug, "{value:?}").expect("format debug value");
    assert!(debug == expected, "debug redaction mismatch");
    assert!(!debug.contains(canary));
    let display = value.to_string();
    assert!(display == expected, "display redaction mismatch");
    assert!(!display.contains(canary));
}

#[test]
fn bootstrap_initializes_exact_singleton_and_room_anchors_atomically() {
    let directory = secure_tempdir();
    let path = database_path(directory.path());
    let first_lookup = [0x51; 32];
    let second_lookup = [0x52; 32];
    let expected_timestamp = timestamp(1_700_000_000_000).to_rfc3339();
    let mut store = Store::open(&path, test_keyring()).expect("open gateway store");

    store
        .initialize_bootstrap_state(bootstrap_state(
            b"bootstrap-session",
            b"bootstrap-token",
            vec![anchor(first_lookup, 3), anchor(second_lookup, 4)],
        ))
        .expect("initialize bootstrap state");

    assert_eq!(table_count(&path, "gateway_state"), 1);
    assert_eq!(table_count(&path, "room_progress"), 2);
    let gateway = raw_gateway_state(&path).expect("singleton row");
    assert_eq!(gateway.singleton, 1);
    assert!(!gateway.session_cipher.is_empty());
    assert_eq!(gateway.session_nonce.len(), 24);
    assert_eq!(gateway.session_key_version, 1);
    assert!(!gateway.committed_token_cipher.is_empty());
    assert_eq!(gateway.committed_token_nonce.len(), 24);
    assert_eq!(gateway.committed_token_key_version, 1);
    assert!(!gateway.fetch_token_cipher.is_empty());
    assert_eq!(gateway.fetch_token_nonce.len(), 24);
    assert_eq!(gateway.fetch_token_key_version, 1);
    assert_eq!(gateway.maintenance_code, None);
    assert_eq!(gateway.maintenance_since, None);
    assert_eq!(
        gateway.bootstrapped_at.as_deref(),
        Some(expected_timestamp.as_str())
    );
    assert_eq!(gateway.updated_at, expected_timestamp);

    let anchors = raw_room_progress(&path);
    assert_eq!(anchors.len(), 2);
    assert_eq!(anchors[0].room_lookup, first_lookup);
    assert_eq!(anchors[1].room_lookup, second_lookup);
    for (lookup, expected_event) in [
        (first_lookup, vec![0xA5; 3]),
        (second_lookup, vec![0xA5; 4]),
    ] {
        let actual_event = store
            .room_anchor(&lookup)
            .expect("decrypt room anchor")
            .expect("supplied room anchor");
        assert_eq!(actual_event.as_bytes(), expected_event.as_slice());
    }
    for row in anchors {
        assert!(!row.anchor_event_cipher.is_empty());
        assert_eq!(row.anchor_event_nonce.len(), 24);
        assert_eq!(row.key_version, 1);
        assert_eq!(row.updated_at, expected_timestamp);
    }
}

#[test]
fn bootstrap_rejects_duplicate_initialization_without_rewriting_state() {
    let directory = secure_tempdir();
    let path = database_path(directory.path());
    let mut store = Store::open(&path, test_keyring()).expect("open gateway store");
    store
        .initialize_bootstrap_state(bootstrap_state(
            b"first-session",
            b"first-token",
            vec![anchor([0x61; 32], 1)],
        ))
        .expect("initialize first bootstrap state");
    let before_gateway = raw_gateway_state(&path);
    let before_anchors = raw_room_progress(&path);

    let error = store
        .initialize_bootstrap_state(bootstrap_state(
            b"second-session",
            b"second-token",
            vec![anchor([0x62; 32], 1)],
        ))
        .expect_err("duplicate bootstrap must fail");
    assert_code_only(error, STORE_ALREADY_BOOTSTRAPPED);
    assert_eq!(raw_gateway_state(&path), before_gateway);
    assert_eq!(raw_room_progress(&path), before_anchors);
}

#[test]
fn bootstrap_rejects_duplicate_room_lookups_and_rolls_back() {
    let directory = secure_tempdir();
    let path = database_path(directory.path());
    let store = Store::open(&path, test_keyring()).expect("open gateway store");
    let duplicate = NewBootstrapState::new(
        b"session".to_vec(),
        b"token".to_vec(),
        vec![anchor([0x71; 32], 1), anchor([0x71; 32], 1)],
        timestamp(1_700_000_000_000),
    )
    .expect_err("duplicate room lookup must fail before persistence");
    assert_code_only(duplicate, STORE_BOOTSTRAP_INVALID);
    assert_eq!(table_count(&path, "gateway_state"), 0);
    assert_eq!(table_count(&path, "room_progress"), 0);
    drop(store);
}

#[test]
fn bootstrap_sql_failure_on_second_anchor_rolls_back_singleton_and_first_anchor() {
    let directory = secure_tempdir();
    let path = database_path(directory.path());
    let mut store = Store::open(&path, test_keyring()).expect("open gateway store");
    let trigger_connection =
        Connection::open(&path).expect("open separate sqlite connection for trigger fixture");
    trigger_connection
        .execute_batch(
            "CREATE TRIGGER fail_second_bootstrap_anchor
             BEFORE INSERT ON room_progress
             WHEN (SELECT COUNT(*) FROM room_progress) >= 1
             BEGIN
               SELECT RAISE(ABORT, 'anchor_abort_fixture');
             END;",
        )
        .expect("install nonsecret abort trigger fixture");
    drop(trigger_connection);

    let error = store
        .initialize_bootstrap_state(bootstrap_state(
            b"session",
            b"token",
            vec![anchor([0x81; 32], 1), anchor([0x82; 32], 1)],
        ))
        .expect_err("second anchor fixture must abort the transaction");
    assert_code_only(error, STORE_BOOTSTRAP_INVALID);
    assert_eq!(table_count(&path, "gateway_state"), 0);
    assert_eq!(table_count(&path, "room_progress"), 0);
}

#[test]
fn bootstrap_rejects_invalid_timestamp_empty_or_oversized_protected_values() {
    let directory = secure_tempdir();
    let path = database_path(directory.path());
    let store = Store::open(&path, test_keyring()).expect("open gateway store");

    assert_code_only(
        NewBootstrapState::new(
            Vec::new(),
            b"token".to_vec(),
            Vec::new(),
            timestamp(1_700_000_000_000),
        )
        .expect_err("empty session must be rejected"),
        STORE_BOOTSTRAP_INVALID,
    );
    assert_code_only(
        NewBootstrapState::new(
            b"session".to_vec(),
            Vec::new(),
            Vec::new(),
            timestamp(1_700_000_000_000),
        )
        .expect_err("empty token must be rejected"),
        STORE_BOOTSTRAP_INVALID,
    );
    assert_code_only(
        RoomAnchor::new([0x91; 32], Vec::new()).expect_err("empty room anchor must be rejected"),
        STORE_BOOTSTRAP_INVALID,
    );
    assert_code_only(
        RoomAnchor::new([0x92; 32], vec![0xA5; MAX_ROOM_ANCHOR_BYTES + 1])
            .expect_err("oversized room anchor must be rejected"),
        STORE_BOOTSTRAP_INVALID,
    );
    assert_code_only(
        NewBootstrapState::new(
            vec![0xB6; MAX_BOOTSTRAP_SESSION_BYTES + 1],
            b"token".to_vec(),
            Vec::new(),
            timestamp(1_700_000_000_000),
        )
        .expect_err("oversized session must be rejected"),
        STORE_BOOTSTRAP_INVALID,
    );
    let sub_millisecond = Utc
        .timestamp_opt(1_700_000_000, 1)
        .single()
        .expect("construct sub-millisecond timestamp");
    assert_code_only(
        NewBootstrapState::new(
            b"session".to_vec(),
            b"token".to_vec(),
            Vec::new(),
            sub_millisecond,
        )
        .expect_err("sub-millisecond timestamp must be rejected"),
        STORE_BOOTSTRAP_INVALID,
    );
    assert_eq!(table_count(&path, "gateway_state"), 0);
    assert_eq!(table_count(&path, "room_progress"), 0);
    drop(store);
}

#[test]
fn bootstrap_ciphertext_round_trips_after_reopen() {
    let directory = secure_tempdir();
    let path = database_path(directory.path());
    let lookup = [0xA1; 32];
    let session = b"session-round-trip-canary";
    let token = b"token-round-trip-canary";
    let anchor_event = b"anchor-round-trip-canary";
    let mut store = Store::open(&path, test_keyring()).expect("open gateway store");
    store
        .initialize_bootstrap_state(bootstrap_state(
            session,
            token,
            vec![RoomAnchor::new(lookup, anchor_event.to_vec()).expect("construct anchor")],
        ))
        .expect("initialize bootstrap state");
    drop(store);

    let reopened = Store::open(&path, test_keyring()).expect("reopen gateway store");
    let stored_session = reopened
        .matrix_session()
        .expect("read matrix session")
        .expect("session after bootstrap");
    assert_eq!(stored_session.as_bytes(), session);
    let stored_anchor = reopened
        .room_anchor(&lookup)
        .expect("read room anchor")
        .expect("anchor after bootstrap");
    assert_eq!(stored_anchor.as_bytes(), anchor_event);
}

#[test]
fn bootstrap_plaintext_is_absent_from_db_wal_shm_while_store_open() {
    let directory = secure_tempdir();
    let path = database_path(directory.path());
    let mut store = Store::open(&path, test_keyring()).expect("open gateway store");
    store
        .initialize_bootstrap_state(bootstrap_state(
            CANARIES[0].as_bytes(),
            CANARIES[1].as_bytes(),
            vec![
                RoomAnchor::new([0xB1; 32], CANARIES[2].as_bytes().to_vec())
                    .expect("construct canary anchor"),
            ],
        ))
        .expect("initialize bootstrap state");

    let storage = sqlite_storage_bytes(&path);
    for canary in CANARIES {
        assert_storage_excludes(&storage, canary.as_bytes());
    }
}

fn assert_session_corruption(sql: &str) {
    let directory = secure_tempdir();
    let path = database_path(directory.path());
    let mut store = Store::open(&path, test_keyring()).expect("open gateway store");
    store
        .initialize_bootstrap_state(bootstrap_state(b"session", b"token", Vec::new()))
        .expect("initialize bootstrap state");
    let connection = Connection::open(&path).expect("open sqlite corruption fixture");
    connection
        .execute(sql, [])
        .expect("apply session corruption fixture");
    drop(connection);

    assert_code_only(
        store
            .matrix_session()
            .expect_err("corrupt session state must fail closed"),
        STORE_SYNC_CORRUPT,
    );
}

fn assert_anchor_corruption(sql: &str) {
    let directory = secure_tempdir();
    let path = database_path(directory.path());
    let lookup = [0xC1; 32];
    let mut store = Store::open(&path, test_keyring()).expect("open gateway store");
    store
        .initialize_bootstrap_state(bootstrap_state(
            b"session",
            b"token",
            vec![anchor(lookup, 1)],
        ))
        .expect("initialize bootstrap state");
    let connection = Connection::open(&path).expect("open sqlite corruption fixture");
    connection
        .execute(sql, [])
        .expect("apply anchor corruption fixture");
    drop(connection);

    assert_code_only(
        store
            .room_anchor(&lookup)
            .expect_err("corrupt room anchor must fail closed"),
        STORE_SYNC_CORRUPT,
    );
}

#[test]
fn bootstrap_corruption_fails_closed_without_secret_formatting() {
    for sql in [
        "UPDATE gateway_state SET session_cipher = zeroblob(0)",
        "UPDATE gateway_state SET session_nonce = zeroblob(1)",
        "UPDATE gateway_state SET session_key_version = 0",
    ] {
        assert_session_corruption(sql);
    }
    for sql in [
        "UPDATE room_progress SET anchor_event_cipher = zeroblob(0)",
        "UPDATE room_progress SET anchor_event_nonce = zeroblob(1)",
        "UPDATE room_progress SET key_version = 0",
        "UPDATE room_progress SET updated_at = 'corrupt_timestamp_fixture'",
    ] {
        assert_anchor_corruption(sql);
    }
}

#[test]
fn room_progress_count_over_limit_fails_closed() {
    let directory = secure_tempdir();
    let path = database_path(directory.path());
    let mut store = Store::open(&path, test_keyring()).expect("open gateway store");
    store
        .initialize_bootstrap_state(bootstrap_state(b"session", b"token", Vec::new()))
        .expect("initialize bootstrap state");

    let row_limit = i64::try_from(MAX_BOOTSTRAP_ROOM_ANCHORS + 1).expect("row limit");
    let connection = Connection::open(&path).expect("open sqlite row-count fixture");
    connection
        .execute(
            "WITH RECURSIVE numbers(value) AS (
                 SELECT 1
                 UNION ALL
                 SELECT value + 1 FROM numbers WHERE value < ?1
             )
             INSERT INTO room_progress
                 (room_lookup, anchor_event_cipher, anchor_event_nonce,
                  key_version, updated_at)
             SELECT CAST(printf('%032d', value) AS BLOB), zeroblob(1), zeroblob(24),
                    1, ?2
             FROM numbers",
            params![row_limit, timestamp(1_700_000_000_000).to_rfc3339()],
        )
        .expect("insert practical over-limit fixture");
    drop(connection);

    assert_code_only(
        store
            .matrix_session()
            .expect_err("over-limit room-progress state must fail closed"),
        STORE_SYNC_CORRUPT,
    );
}

#[test]
fn oversized_session_token_and_anchor_ciphertext_fail_closed() {
    let directory = secure_tempdir();
    let path = database_path(directory.path());
    let mut store = Store::open(&path, test_keyring()).expect("open gateway store");
    store
        .initialize_bootstrap_state(bootstrap_state(b"session", b"token", Vec::new()))
        .expect("initialize bootstrap state");
    let connection = Connection::open(&path).expect("open session ciphertext fixture");
    connection
        .execute(
            &format!(
                "UPDATE gateway_state SET session_cipher = zeroblob({})",
                MAX_BOOTSTRAP_SESSION_BYTES + AEAD_TAG_BYTES + 1
            ),
            [],
        )
        .expect("oversize session ciphertext");
    drop(connection);
    assert_code_only(
        store
            .matrix_session()
            .expect_err("oversized session ciphertext must fail closed"),
        STORE_SYNC_CORRUPT,
    );

    let directory = secure_tempdir();
    let path = database_path(directory.path());
    let mut store = Store::open(&path, test_keyring()).expect("open gateway store");
    store
        .initialize_bootstrap_state(bootstrap_state(b"session", b"token", Vec::new()))
        .expect("initialize bootstrap state");
    let connection = Connection::open(&path).expect("open token ciphertext fixture");
    connection
        .execute(
            &format!(
                "UPDATE gateway_state SET committed_token_cipher = zeroblob({})",
                MAX_SYNC_TOKEN_BYTES + AEAD_TAG_BYTES + 1
            ),
            [],
        )
        .expect("oversize token ciphertext");
    drop(connection);
    assert_code_only(
        store
            .matrix_session()
            .expect_err("oversized token ciphertext must fail closed"),
        STORE_SYNC_CORRUPT,
    );

    let directory = secure_tempdir();
    let path = database_path(directory.path());
    let lookup = [0xC8; 32];
    let mut store = Store::open(&path, test_keyring()).expect("open gateway store");
    store
        .initialize_bootstrap_state(bootstrap_state(
            b"session",
            b"token",
            vec![anchor(lookup, 1)],
        ))
        .expect("initialize bootstrap state");
    let connection = Connection::open(&path).expect("open anchor ciphertext fixture");
    connection
        .execute(
            &format!(
                "UPDATE room_progress SET anchor_event_cipher = zeroblob({})",
                MAX_ROOM_ANCHOR_BYTES + AEAD_TAG_BYTES + 1
            ),
            [],
        )
        .expect("oversize anchor ciphertext");
    drop(connection);
    assert_code_only(
        store
            .room_anchor(&lookup)
            .expect_err("oversized anchor ciphertext must fail closed"),
        STORE_SYNC_CORRUPT,
    );
}

#[test]
fn getters_return_none_only_for_wholly_unbootstrapped_store_and_fail_on_orphans() {
    let directory = secure_tempdir();
    let path = database_path(directory.path());
    let store = Store::open(&path, test_keyring()).expect("open gateway store");
    assert!(
        store
            .matrix_session()
            .expect("read unbootstrapped session")
            .is_none()
    );
    assert!(
        store
            .room_anchor(&[0xD1; 32])
            .expect("read unbootstrapped anchor")
            .is_none()
    );
    assert_code_only(
        store
            .room_anchor(&[])
            .expect_err("invalid room lookup must fail"),
        STORE_BOOTSTRAP_INVALID,
    );

    let connection = Connection::open(&path).expect("open sqlite orphan fixture");
    connection
        .execute(
            "INSERT INTO room_progress
             (room_lookup, anchor_event_cipher, anchor_event_nonce, key_version, updated_at)
             VALUES (?1, ?2, ?3, 1, ?4)",
            params![
                vec![0xD2_u8; 32],
                vec![0xD3_u8],
                vec![0xD4_u8; 24],
                timestamp(1_700_000_000_000).to_rfc3339(),
            ],
        )
        .expect("insert orphan room anchor fixture");
    drop(connection);
    assert_code_only(
        store
            .matrix_session()
            .expect_err("orphan anchor must fail session getter closed"),
        STORE_SYNC_CORRUPT,
    );
    assert_code_only(
        store
            .room_anchor(&[0xD2; 32])
            .expect_err("orphan anchor must fail anchor getter closed"),
        STORE_SYNC_CORRUPT,
    );
    drop(store);

    let directory = secure_tempdir();
    let path = database_path(directory.path());
    let store = Store::open(&path, test_keyring()).expect("open gateway store");
    let connection = Connection::open(&path).expect("open sqlite partial singleton fixture");
    connection
        .execute(
            "INSERT INTO gateway_state(singleton, updated_at) VALUES (1, ?1)",
            [timestamp(1_700_000_000_000).to_rfc3339()],
        )
        .expect("insert partial singleton fixture");
    drop(connection);
    assert_code_only(
        store
            .matrix_session()
            .expect_err("partial singleton must fail closed"),
        STORE_SYNC_CORRUPT,
    );
    assert_code_only(
        store
            .room_anchor(&[0xD5; 32])
            .expect_err("partial singleton must fail anchor getter closed"),
        STORE_SYNC_CORRUPT,
    );
    drop(store);

    let directory = secure_tempdir();
    let path = database_path(directory.path());
    let missing_lookup = [0xD6; 32];
    let mut store = Store::open(&path, test_keyring()).expect("open gateway store");
    store
        .initialize_bootstrap_state(bootstrap_state(
            b"session",
            b"token",
            vec![anchor([0xD7; 32], 1)],
        ))
        .expect("initialize bootstrap state");
    assert!(
        store
            .room_anchor(&missing_lookup)
            .expect("read absent valid anchor")
            .is_none()
    );
}

#[test]
fn committed_and_fetch_encrypted_columns_decrypt_to_exact_same_token_but_their_stored_nonces_differ()
 {
    let directory = secure_tempdir();
    let path = database_path(directory.path());
    let mut store = Store::open(&path, test_keyring()).expect("open gateway store");
    let token = b"same-token-plaintext";
    store
        .initialize_bootstrap_state(bootstrap_state(b"session", token, Vec::new()))
        .expect("initialize bootstrap state");
    let row = raw_gateway_state(&path).expect("singleton row");
    assert_ne!(row.committed_token_nonce, row.fetch_token_nonce);

    let committed_nonce: [u8; 24] = row
        .committed_token_nonce
        .clone()
        .try_into()
        .expect("committed nonce length");
    let fetch_nonce: [u8; 24] = row
        .fetch_token_nonce
        .clone()
        .try_into()
        .expect("fetch nonce length");
    let keyring = test_keyring();
    let committed = keyring
        .open(
            "gateway_state",
            "1",
            "committed_token",
            &Sealed {
                nonce: committed_nonce,
                ciphertext: row.committed_token_cipher.clone(),
                key_version: row
                    .committed_token_key_version
                    .try_into()
                    .expect("committed key version"),
            },
        )
        .expect("open committed token");
    let fetched = keyring
        .open(
            "gateway_state",
            "1",
            "fetch_token",
            &Sealed {
                nonce: fetch_nonce,
                ciphertext: row.fetch_token_cipher.clone(),
                key_version: row
                    .fetch_token_key_version
                    .try_into()
                    .expect("fetch key version"),
            },
        )
        .expect("open fetch token");
    assert_eq!(committed.as_bytes(), token);
    assert_eq!(fetched.as_bytes(), token);
}

#[test]
fn source_contract_keeps_protected_dto_fields_private_and_non_derived() {
    let source = include_str!("../src/store_types.rs");
    for type_name in [
        "RoomAnchor",
        "NewBootstrapState",
        "NewRawSyncInbox",
        "RawSyncInbox",
    ] {
        let marker = format!("pub struct {type_name} {{");
        let start = source
            .find(&marker)
            .unwrap_or_else(|| panic!("missing {marker}"));
        let end = source[start..]
            .find("}\n")
            .map(|offset| start + offset)
            .expect("struct declaration terminator");
        let declaration = &source[start..=end];
        assert!(
            !declaration.lines().skip(1).any(|line| {
                line.trim_start().starts_with("pub ") || line.trim_start().starts_with("pub(")
            }),
            "{type_name} fields must remain private"
        );

        let attribute_start = source[..start].rfind("\n\n").map_or(0, |offset| offset + 2);
        let attributes = &source[attribute_start..start];
        for prohibited in ["Clone", "Serialize", "Deref", "AsRef"] {
            assert!(
                !attributes.contains(prohibited),
                "{type_name} must not derive or expose {prohibited}"
            );
        }
    }

    for prohibited in [
        "pub request_token:",
        "pub next_token:",
        "pub response:",
        "pub session:",
        "pub initial_token:",
        "pub anchor_event:",
    ] {
        assert!(
            !source.contains(prohibited),
            "protected field became public"
        );
    }
}

#[test]
fn inbox_position_debug_does_not_expose_protected_id_text() {
    let position = SdkInboxPosition::Committed;
    assert_eq!(format!("{position:?}"), "Committed");
}

// Keep the imported private-constructor types in this integration contract
// test: their crate-private construction and getters are exercised by the
// unit tests next to store_types.rs.
#[allow(dead_code)]
fn _crate_private_types_are_part_of_the_public_contract() {
    let _ = std::any::TypeId::of::<InboxId>();
}
