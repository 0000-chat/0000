use std::{
    fs,
    io::Write,
    os::unix::fs::{PermissionsExt, symlink},
    path::{Path, PathBuf},
    process::{Command, Output, Stdio},
};

use base64::{Engine as _, engine::general_purpose::STANDARD};
use communicator_matrix_gateway::{
    crypto::Keyring,
    registry::{RoomBindingStatus, room_lookup},
    store::Store,
};
use rusqlite::Connection;
use serde_json::{Value, json};
use tempfile::{TempDir, tempdir};

const FIXTURE: &str = include_str!("../testdata/room-binding-valid.json");
const PROTECTED_VALUES: [&str; 10] = [
    "!portal:communicator.0000.gold",
    "tenant_personal",
    "identity_human",
    "connection_human_whatsapp",
    "account_human_whatsapp",
    "gateway_route_contabo",
    "conversation_human_whatsapp_family",
    "@human:communicator.0000.gold",
    "secret_canary_value",
    "mapping_reason_canary",
];

fn secure_tempdir() -> TempDir {
    let directory = tempdir().expect("create temporary state directory");
    fs::set_permissions(directory.path(), fs::Permissions::from_mode(0o700))
        .expect("secure temporary state directory");
    directory
}

fn write_protected_file(directory: &Path, name: &str, bytes: &[u8]) -> PathBuf {
    let path = directory.join(name);
    fs::write(&path, bytes).expect("write protected test file");
    fs::set_permissions(&path, fs::Permissions::from_mode(0o600))
        .expect("secure protected test file");
    path
}

fn state_key_file(directory: &Path) -> PathBuf {
    write_protected_file(
        directory,
        "state-key",
        STANDARD.encode([0x11_u8; 32]).as_bytes(),
    )
}

fn database_path(directory: &Path) -> PathBuf {
    directory.join("gateway.sqlite3")
}

fn mapping_file(directory: &Path, name: &str, value: &Value) -> PathBuf {
    write_protected_file(directory, name, value.to_string().as_bytes())
}

fn mapping_value() -> Value {
    serde_json::from_str(FIXTURE).expect("valid room-binding fixture")
}

fn command_args(
    operation: &str,
    database: &Path,
    key_file: &Path,
    input: Option<&Path>,
) -> Vec<String> {
    let mut args = vec![
        "registry".to_owned(),
        operation.to_owned(),
        "--state-db".to_owned(),
        database.display().to_string(),
        "--state-key-file".to_owned(),
        key_file.display().to_string(),
    ];
    if let Some(input) = input {
        args.extend(["--input".to_owned(), input.display().to_string()]);
    }
    args
}

fn run(args: &[String]) -> Output {
    Command::new(env!("CARGO_BIN_EXE_communicator-matrix-gateway"))
        .env_clear()
        .args(args)
        .output()
        .expect("run gateway admin command")
}

fn run_with_stdin(args: &[String], input: &[u8]) -> Output {
    let mut child = Command::new(env!("CARGO_BIN_EXE_communicator-matrix-gateway"))
        .env_clear()
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn gateway admin command");
    child
        .stdin
        .take()
        .expect("open command stdin")
        .write_all(input)
        .expect("write command stdin");
    child
        .wait_with_output()
        .expect("wait for gateway admin command")
}

fn output_text(output: &Output) -> (String, String) {
    (
        String::from_utf8(output.stdout.clone()).expect("stdout is UTF-8"),
        String::from_utf8(output.stderr.clone()).expect("stderr is UTF-8"),
    )
}

fn assert_no_protected_values(output: &Output) {
    let (stdout, stderr) = output_text(output);
    for value in PROTECTED_VALUES {
        assert!(!stdout.contains(value));
        assert!(!stderr.contains(value));
    }
}

fn parse_stdout_json(output: &Output) -> Value {
    let (stdout, stderr) = output_text(output);
    assert!(stderr.is_empty());
    serde_json::from_str(stdout.trim()).expect("admin output is JSON")
}

fn test_keyring() -> Keyring {
    Keyring::new([0x11_u8; 32], 1).expect("construct test keyring")
}

#[test]
fn registry_add_accepts_protected_json_and_returns_only_a_synthetic_id() {
    let directory = secure_tempdir();
    let database = database_path(directory.path());
    let key_file = state_key_file(directory.path());
    let input = write_protected_file(directory.path(), "room-binding.json", FIXTURE.as_bytes());

    let output = run(&command_args("add", &database, &key_file, Some(&input)));

    assert!(output.status.success());
    assert_no_protected_values(&output);
    let result = parse_stdout_json(&output);
    let binding_id = result["binding_id"].as_str().expect("binding ID output");
    assert!(binding_id.starts_with("binding_"));
    assert_eq!(binding_id.len(), "binding_".len() + 32);
    assert_eq!(result["status"], "active");

    let store = Store::open(&database, test_keyring()).expect("open stored registry");
    let lookup =
        room_lookup(&test_keyring(), "!portal:communicator.0000.gold").expect("derive room lookup");
    let binding = store
        .active_room_binding(&lookup)
        .expect("read active binding")
        .expect("binding exists");
    assert_eq!(binding.binding_id(), binding_id);
    assert_eq!(binding.tenant_id(), "tenant_personal");
    assert_eq!(binding.platform().as_str(), "whatsapp");
    assert_eq!(binding.status(), RoomBindingStatus::Active);
}

#[test]
fn registry_add_accepts_json_from_non_tty_stdin() {
    let directory = secure_tempdir();
    let database = database_path(directory.path());
    let key_file = state_key_file(directory.path());
    let args = command_args("add", &database, &key_file, Some(Path::new("-")));

    let output = run_with_stdin(&args, FIXTURE.as_bytes());

    assert!(output.status.success());
    assert_no_protected_values(&output);
    assert!(
        parse_stdout_json(&output)["binding_id"]
            .as_str()
            .is_some_and(|value| value.starts_with("binding_"))
    );
}

#[test]
fn registry_add_rejects_unknown_fields_invalid_ids_and_unknown_platform() {
    let cases = [
        ("unknown", json!({"secret_canary_value": true})),
        (
            "invalid-room",
            json!({"matrix_room_id": "room-without-matrix-prefix"}),
        ),
        ("invalid-tenant", json!({"tenant_id": "tenant"})),
        ("unknown-platform", json!({"platform": "signal"})),
    ];

    for (name, change) in cases {
        let directory = secure_tempdir();
        let database = database_path(directory.path());
        let key_file = state_key_file(directory.path());
        let mut value = mapping_value();
        if let Some(object) = change.as_object() {
            for (key, item) in object {
                object_set(&mut value, key, item.clone());
            }
        }
        let input = mapping_file(directory.path(), name, &value);

        let output = run(&command_args("add", &database, &key_file, Some(&input)));

        assert!(!output.status.success());
        assert_no_protected_values(&output);
        assert!(output.stdout.is_empty());
    }
}

#[test]
fn registry_add_rejects_active_room_and_account_authority_drift() {
    let directory = secure_tempdir();
    let database = database_path(directory.path());
    let key_file = state_key_file(directory.path());
    let first = mapping_file(directory.path(), "first.json", &mapping_value());
    let first_output = run(&command_args("add", &database, &key_file, Some(&first)));
    assert!(first_output.status.success());

    let reused_room = mapping_value();
    let reused_room_file = mapping_file(directory.path(), "reused-room.json", &reused_room);
    let reused_room_output = run(&command_args(
        "add",
        &database,
        &key_file,
        Some(&reused_room_file),
    ));
    assert!(!reused_room_output.status.success());
    assert_no_protected_values(&reused_room_output);

    let mut drift = mapping_value();
    object_set(
        &mut drift,
        "matrix_room_id",
        json!("!second:communicator.0000.gold"),
    );
    object_set(&mut drift, "tenant_id", json!("tenant_other"));
    let drift_file = mapping_file(directory.path(), "drift.json", &drift);
    let drift_output = run(&command_args(
        "add",
        &database,
        &key_file,
        Some(&drift_file),
    ));
    assert!(!drift_output.status.success());
    assert_no_protected_values(&drift_output);
}

#[test]
fn registry_retire_uses_a_protected_document_and_keeps_history() {
    let directory = secure_tempdir();
    let database = database_path(directory.path());
    let key_file = state_key_file(directory.path());
    let input = mapping_file(directory.path(), "room-binding.json", &mapping_value());
    let added = run(&command_args("add", &database, &key_file, Some(&input)));
    assert!(added.status.success());
    let binding_id = parse_stdout_json(&added)["binding_id"]
        .as_str()
        .expect("binding ID")
        .to_owned();

    let retirement = mapping_file(
        directory.path(),
        "retire.json",
        &json!({
            "schema_version": 1,
            "binding_id": binding_id,
            "reason_code": "mapping_replaced"
        }),
    );
    let output = run(&command_args(
        "retire",
        &database,
        &key_file,
        Some(&retirement),
    ));

    assert!(output.status.success());
    assert_no_protected_values(&output);
    assert_eq!(parse_stdout_json(&output)["status"], "retired");

    let store = Store::open(&database, test_keyring()).expect("open retired registry");
    let lookup =
        room_lookup(&test_keyring(), "!portal:communicator.0000.gold").expect("derive room lookup");
    assert!(
        store
            .active_room_binding(&lookup)
            .expect("read retired room")
            .is_none()
    );
    drop(store);

    let connection = Connection::open(&database).expect("open registry history");
    let count: i64 = connection
        .query_row("SELECT COUNT(*) FROM room_bindings", [], |row| row.get(0))
        .expect("count registry history");
    assert_eq!(count, 1);
}

#[test]
fn registry_retire_rejects_unbounded_reason_and_unknown_fields() {
    let directory = secure_tempdir();
    let database = database_path(directory.path());
    let key_file = state_key_file(directory.path());
    let input = mapping_file(directory.path(), "room-binding.json", &mapping_value());
    let added = run(&command_args("add", &database, &key_file, Some(&input)));
    assert!(added.status.success());
    let added_json = parse_stdout_json(&added);
    let binding_id = added_json["binding_id"].as_str().expect("binding ID");

    for (name, document) in [
        (
            "long-reason.json",
            json!({
                "schema_version": 1,
                "binding_id": binding_id,
                "reason_code": "a".repeat(65)
            }),
        ),
        (
            "unknown-field.json",
            json!({
                "schema_version": 1,
                "binding_id": binding_id,
                "reason_code": "mapping_replaced",
                "mapping_reason_canary": true
            }),
        ),
    ] {
        let retirement = mapping_file(directory.path(), name, &document);
        let output = run(&command_args(
            "retire",
            &database,
            &key_file,
            Some(&retirement),
        ));
        assert!(!output.status.success());
        assert_no_protected_values(&output);
        assert!(output.stdout.is_empty());
    }
}

#[test]
fn registry_list_summary_reports_only_provider_and_status_counts() {
    let directory = secure_tempdir();
    let database = database_path(directory.path());
    let key_file = state_key_file(directory.path());

    let mut whatsapp = mapping_value();
    object_set(
        &mut whatsapp,
        "account_id",
        json!("account_summary_whatsapp"),
    );
    let whatsapp_file = mapping_file(directory.path(), "whatsapp.json", &whatsapp);
    let added = run(&command_args(
        "add",
        &database,
        &key_file,
        Some(&whatsapp_file),
    ));
    assert!(added.status.success());
    let binding_id = parse_stdout_json(&added)["binding_id"]
        .as_str()
        .expect("binding ID")
        .to_owned();

    let mut telegram = mapping_value();
    object_set(
        &mut telegram,
        "matrix_room_id",
        json!("!summary-telegram:communicator.0000.gold"),
    );
    object_set(&mut telegram, "platform", json!("telegram"));
    object_set(
        &mut telegram,
        "account_id",
        json!("account_summary_telegram"),
    );
    let telegram_file = mapping_file(directory.path(), "telegram.json", &telegram);
    assert!(
        run(&command_args(
            "add",
            &database,
            &key_file,
            Some(&telegram_file),
        ))
        .status
        .success()
    );

    let retirement = mapping_file(
        directory.path(),
        "retire-whatsapp.json",
        &json!({
            "schema_version": 1,
            "binding_id": binding_id,
            "reason_code": "mapping_replaced"
        }),
    );
    assert!(
        run(&command_args(
            "retire",
            &database,
            &key_file,
            Some(&retirement),
        ))
        .status
        .success()
    );

    let output = run(&command_args("list-summary", &database, &key_file, None));

    assert!(output.status.success());
    assert_no_protected_values(&output);
    let summary = parse_stdout_json(&output);
    assert_eq!(summary["providers"]["whatsapp"]["active"], 0);
    assert_eq!(summary["providers"]["whatsapp"]["retired"], 1);
    assert_eq!(summary["providers"]["telegram"]["active"], 1);
    assert_eq!(summary["providers"]["telegram"]["retired"], 0);
    assert_eq!(summary["providers"]["messenger"]["active"], 0);
    assert_eq!(summary["providers"]["linkedin"]["active"], 0);
    assert!(summary.get("total").is_none());
}

#[test]
fn registry_mutations_fail_closed_while_the_daemon_lock_is_held() {
    let directory = secure_tempdir();
    let database = database_path(directory.path());
    let key_file = state_key_file(directory.path());
    let input = mapping_file(directory.path(), "room-binding.json", &mapping_value());
    let store = Store::open(&database, test_keyring()).expect("hold daemon store lock");

    let output = run(&command_args("add", &database, &key_file, Some(&input)));

    assert!(!output.status.success());
    assert_no_protected_values(&output);
    assert_eq!(output.stdout, b"");
    assert_eq!(output.stderr, b"store_lock_unavailable\n");
    drop(store);
}

#[cfg(unix)]
#[test]
fn registry_rejects_symlinked_input_and_key_files() {
    let directory = secure_tempdir();
    let database = database_path(directory.path());
    let real_key = state_key_file(directory.path());
    let real_input = mapping_file(directory.path(), "real-input.json", &mapping_value());
    let key_link = directory.path().join("key-link");
    let input_link = directory.path().join("input-link");
    symlink(&real_key, &key_link).expect("create key symlink");
    symlink(&real_input, &input_link).expect("create input symlink");

    let key_output = run(&command_args(
        "add",
        &database,
        &key_link,
        Some(&real_input),
    ));
    assert!(!key_output.status.success());
    assert_no_protected_values(&key_output);

    let input_output = run(&command_args(
        "add",
        &database,
        &real_key,
        Some(&input_link),
    ));
    assert!(!input_output.status.success());
    assert_no_protected_values(&input_output);
}

#[test]
fn registry_cli_checks_tty_before_reading_stdin() {
    let source_path = Path::new(env!("CARGO_MANIFEST_DIR")).join("src/admin.rs");
    assert!(source_path.exists());
    let source = fs::read_to_string(source_path).expect("read admin source");
    assert!(source.contains("is_terminal()"));
}

fn object_set(value: &mut Value, key: &str, item: Value) {
    value
        .as_object_mut()
        .expect("mapping is an object")
        .insert(key.to_owned(), item);
}
