use std::{fs, os::unix::fs::PermissionsExt, path::PathBuf};

use chrono::{DateTime, TimeZone, Utc};
use communicator_matrix_gateway::{
    crypto::Keyring, health::inspect_at, store::Store, store_types::NewBootstrapState,
};
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
