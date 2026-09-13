use std::{
    fmt::Write as _,
    fs,
    path::{Path, PathBuf},
};

use chrono::{DateTime, TimeZone, Utc};

#[cfg(unix)]
use std::os::unix::{fs::PermissionsExt, fs::symlink};

use communicator_matrix_gateway::{
    crypto::Keyring,
    model::Provider,
    registry::{NewRoomBinding, RoomBindingStatus},
    store::{
        STORE_ROOM_BINDING_DUPLICATE_ID, STORE_ROOM_BINDING_DUPLICATE_ROOM,
        STORE_ROOM_BINDING_INVALID, Store,
    },
};
use rusqlite::{Connection, OptionalExtension, params};
use tempfile::tempdir;

fn secure_tempdir() -> tempfile::TempDir {
    let directory = tempdir().expect("create temporary state directory");
    #[cfg(unix)]
    fs::set_permissions(directory.path(), fs::Permissions::from_mode(0o700))
        .expect("secure temporary state directory");
    directory
}

fn database_path(directory: &Path) -> std::path::PathBuf {
    directory.join("gateway.sqlite3")
}

fn timestamp(milliseconds: i64) -> DateTime<Utc> {
    Utc.timestamp_millis_opt(milliseconds)
        .single()
        .expect("construct test timestamp")
}

fn test_keyring() -> Keyring {
    Keyring::new([0x11; 32], 1).expect("construct fixed test keyring")
}

fn test_binding(binding_id: &str, matrix_room_id: &str) -> NewRoomBinding {
    test_binding_with(
        binding_id,
        matrix_room_id,
        "tenant_demo",
        "identity_demo",
        "connection_demo",
        "account_demo",
        Provider::Telegram,
        "route_demo",
        "conversation_demo",
        "@owner:example.test",
        timestamp(1_700_000_000_000),
    )
}

#[allow(clippy::too_many_arguments)]
fn test_binding_with(
    binding_id: &str,
    matrix_room_id: &str,
    tenant_id: &str,
    identity_id: &str,
    connection_id: &str,
    account_id: &str,
    platform: Provider,
    gateway_route_id: &str,
    conversation_id: &str,
    owner_matrix_user_id: &str,
    created_at: DateTime<Utc>,
) -> NewRoomBinding {
    NewRoomBinding::new(
        binding_id,
        matrix_room_id,
        tenant_id,
        identity_id,
        connection_id,
        account_id,
        platform,
        gateway_route_id,
        conversation_id,
        owner_matrix_user_id,
        created_at,
    )
    .expect("construct valid test binding")
}

#[derive(Debug, Eq, PartialEq)]
struct RawRoomBindingRow {
    rowid: i64,
    binding_id: String,
    room_lookup: Vec<u8>,
    account_lookup: Vec<u8>,
    payload_cipher: Vec<u8>,
    payload_nonce: Vec<u8>,
    key_version: i64,
    status: String,
    created_at: String,
    retired_at: Option<String>,
}

fn raw_room_binding(path: &Path, binding_id: &str) -> Option<RawRoomBindingRow> {
    let connection = Connection::open(path).expect("open sqlite database for row inspection");
    connection
        .query_row(
            "SELECT rowid, binding_id, room_lookup, account_lookup, payload_cipher,
                    payload_nonce, key_version, status, created_at, retired_at
             FROM room_bindings WHERE binding_id = ?1",
            [binding_id],
            |row| {
                Ok(RawRoomBindingRow {
                    rowid: row.get(0)?,
                    binding_id: row.get(1)?,
                    room_lookup: row.get(2)?,
                    account_lookup: row.get(3)?,
                    payload_cipher: row.get(4)?,
                    payload_nonce: row.get(5)?,
                    key_version: row.get(6)?,
                    status: row.get(7)?,
                    created_at: row.get(8)?,
                    retired_at: row.get(9)?,
                })
            },
        )
        .optional()
        .expect("read sqlite room binding row")
}

fn room_binding_count(path: &Path) -> i64 {
    let connection = Connection::open(path).expect("open sqlite database for count inspection");
    connection
        .query_row("SELECT COUNT(*) FROM room_bindings", [], |row| row.get(0))
        .expect("count room binding rows")
}

fn sqlite_storage_bytes(path: &Path) -> Vec<u8> {
    let mut bytes = fs::read(path).expect("read sqlite database bytes");
    for suffix in ["-wal", "-shm"] {
        let mut sidecar = PathBuf::from(path);
        let name = format!(
            "{}{}",
            sidecar.file_name().unwrap().to_string_lossy(),
            suffix
        );
        sidecar.set_file_name(name);
        if let Ok(mut sidecar_bytes) = fs::read(sidecar) {
            bytes.append(&mut sidecar_bytes);
        }
    }
    bytes
}

fn assert_storage_excludes(bytes: &[u8], plaintext: &str) {
    let needle = plaintext.as_bytes();
    assert!(
        !bytes.windows(needle.len()).any(|window| window == needle),
        "protected plaintext unexpectedly present in sqlite storage: {plaintext}"
    );
}

fn schema_objects(path: &Path, object_type: &str) -> Vec<String> {
    let connection = Connection::open(path).expect("open sqlite database for inspection");
    let mut statement = connection
        .prepare(
            "SELECT name FROM sqlite_master \
             WHERE type = ?1 AND name NOT LIKE 'sqlite_autoindex_%' \
             ORDER BY name",
        )
        .expect("prepare sqlite schema inspection");
    statement
        .query_map([object_type], |row| row.get(0))
        .expect("query sqlite schema inspection")
        .collect::<Result<Vec<String>, _>>()
        .expect("read sqlite schema inspection")
}

fn pragma_text(path: &Path, pragma: &str) -> String {
    let connection = Connection::open(path).expect("open sqlite database for pragma inspection");
    connection
        .query_row(&format!("PRAGMA {pragma}"), [], |row| row.get(0))
        .expect("read sqlite pragma")
}

fn pragma_i64(path: &Path, pragma: &str) -> i64 {
    let connection = Connection::open(path).expect("open sqlite database for pragma inspection");
    connection
        .query_row(&format!("PRAGMA {pragma}"), [], |row| row.get(0))
        .expect("read sqlite pragma")
}

#[test]
fn opens_brand_new_database_with_exact_v1_schema_and_pragmas() {
    let directory = secure_tempdir();
    let path = database_path(directory.path());

    let store = Store::open(&path, test_keyring()).expect("open brand-new gateway database");
    assert!(store.pragmas().foreign_keys());
    assert_eq!(store.pragmas().journal_mode(), "wal");
    assert_eq!(store.pragmas().synchronous(), 2);
    assert_eq!(store.pragmas().busy_timeout_ms(), 5_000);
    drop(store);

    assert_eq!(
        schema_objects(&path, "table"),
        vec![
            "attachment_descriptors",
            "backfill_jobs",
            "gateway_state",
            "matrix_crypto_outbox",
            "outbox_batches",
            "room_bindings",
            "room_ephemeral_state",
            "room_progress",
            "schema_meta",
            "sync_inbox",
            "sync_windows",
            "window_room_anchors",
            "window_room_ephemeral",
        ]
    );
    assert_eq!(
        schema_objects(&path, "index"),
        vec!["one_active_room", "one_unresolved_crypto_request"]
    );

    let connection = Connection::open(&path).expect("open sqlite database for metadata check");
    assert_eq!(
        connection
            .query_row("SELECT version FROM schema_meta", [], |row| row
                .get::<_, i64>(0))
            .expect("read schema version"),
        1
    );
    assert_eq!(
        pragma_text(&path, "journal_mode").to_ascii_lowercase(),
        "wal"
    );
    assert_eq!(pragma_i64(&path, "synchronous"), 2);
    assert_eq!(pragma_i64(&path, "busy_timeout"), 5000);
}

#[test]
fn reopens_current_schema_and_rejects_downgrade_or_newer_versions() {
    let directory = secure_tempdir();
    let path = database_path(directory.path());

    drop(Store::open(&path, test_keyring()).expect("create current schema"));
    Store::open(&path, test_keyring()).expect("reopen current schema");

    drop(Store::open(&path, test_keyring()).expect("close current schema before downgrade tamper"));
    let connection = Connection::open(&path).expect("open database for downgrade tamper");
    connection
        .execute_batch("PRAGMA ignore_check_constraints=ON; UPDATE schema_meta SET version=0;")
        .expect("write simulated downgrade");
    drop(connection);
    let downgrade =
        Store::open(&path, test_keyring()).expect_err("downgraded schema must fail closed");
    assert_eq!(downgrade.code(), "store_schema_downgrade");

    let connection = Connection::open(&path).expect("open database for newer-version tamper");
    connection
        .execute_batch("PRAGMA ignore_check_constraints=ON; UPDATE schema_meta SET version=2;")
        .expect("write simulated newer schema");
    drop(connection);
    let newer = Store::open(&path, test_keyring()).expect_err("newer schema must fail closed");
    assert_eq!(newer.code(), "store_schema_newer");
}

#[test]
fn rejects_invalid_schema_and_error_format_is_code_only() {
    let directory = secure_tempdir();
    let path = database_path(directory.path());

    drop(Store::open(&path, test_keyring()).expect("create current schema"));
    let connection = Connection::open(&path).expect("open database for invalid-schema tamper");
    connection
        .execute_batch("DROP TABLE gateway_state;")
        .expect("remove required table");
    drop(connection);

    let error = Store::open(&path, test_keyring()).expect_err("invalid schema must fail closed");
    assert_eq!(error.code(), "store_schema_invalid");
    let mut debug = String::new();
    write!(&mut debug, "{error:?}").expect("format debug error");
    assert_eq!(debug, "StoreError { code: \"store_schema_invalid\" }");
    assert_eq!(error.to_string(), "store_schema_invalid");
    assert!(!debug.contains(path.to_string_lossy().as_ref()));
}

#[test]
fn exclusive_lock_excludes_second_store_and_releases_on_drop() {
    let directory = secure_tempdir();
    let path = database_path(directory.path());

    let first = Store::open(&path, test_keyring()).expect("open first store");
    let second =
        Store::open(&path, test_keyring()).expect_err("second store must be excluded by lock");
    assert_eq!(second.code(), "store_lock_unavailable");
    let mut debug = String::new();
    write!(&mut debug, "{second:?}").expect("format lock error");
    assert_eq!(debug, "StoreError { code: \"store_lock_unavailable\" }");
    assert!(!debug.contains(path.to_string_lossy().as_ref()));

    drop(first);
    Store::open(&path, test_keyring()).expect("lock must release with store lifetime");
    assert!(fs::metadata(path.with_extension("lock")).is_ok());
}

#[test]
fn store_declares_sqlite_connection_before_lock_for_drop_order() {
    let source = include_str!("../src/store.rs");
    let connection = source
        .find("connection: Connection")
        .expect("store must own a sqlite connection");
    let keyring = source
        .find("keyring: Keyring")
        .expect("store must own its keyring");
    let lock = source.find("lock: File").expect("store must own its lock");
    assert!(
        connection < keyring && keyring < lock,
        "SQLite connection and keyring must be declared before the lock so they drop first"
    );
}

#[cfg(unix)]
#[test]
fn rejects_symlink_database_path() {
    let directory = secure_tempdir();
    let target = database_path(directory.path());
    drop(Store::open(&target, test_keyring()).expect("create target database"));
    let alias = directory.path().join("database-alias.sqlite3");
    symlink(&target, &alias).expect("create database symlink");

    let error = Store::open(&alias, test_keyring()).expect_err("database symlink must fail closed");
    assert_eq!(error.code(), "store_path_invalid");
}

#[cfg(unix)]
#[test]
fn rejects_symlink_lock_path() {
    let directory = secure_tempdir();
    let path = database_path(directory.path());
    let lock_path = path.with_extension("lock");
    let lock_target = directory.path().join("lock-target");
    fs::write(&lock_target, b"").expect("create lock target");
    symlink(&lock_target, &lock_path).expect("create lock symlink");

    let error = Store::open(&path, test_keyring()).expect_err("lock symlink must fail closed");
    assert_eq!(error.code(), "store_path_invalid");
}

#[cfg(unix)]
#[test]
fn rejects_database_hardlink_alias() {
    let directory = secure_tempdir();
    let path = database_path(directory.path());
    drop(Store::open(&path, test_keyring()).expect("create current schema"));
    let alias = directory.path().join("database-alias.sqlite3");
    fs::hard_link(&path, &alias).expect("create database hardlink alias");

    let error =
        Store::open(&alias, test_keyring()).expect_err("hardlinked database must fail closed");
    assert_eq!(error.code(), "store_path_invalid");
}

#[cfg(unix)]
#[test]
fn rejects_group_or_other_writable_database_parent() {
    let directory = secure_tempdir();
    let insecure = directory.path().join("insecure");
    fs::create_dir(&insecure).expect("create insecure state directory");
    fs::set_permissions(&insecure, fs::Permissions::from_mode(0o777))
        .expect("make state directory insecure");

    let error = Store::open(database_path(&insecure), test_keyring())
        .expect_err("insecure parent must fail closed");
    assert_eq!(error.code(), "store_path_invalid");
}

#[test]
fn rejects_schema_sql_with_removed_token_boundary() {
    let directory = secure_tempdir();
    let path = database_path(directory.path());
    drop(Store::open(&path, test_keyring()).expect("create current schema"));
    let connection = Connection::open(&path).expect("open database for schema tamper");
    connection
        .execute_batch(
            "PRAGMA writable_schema=ON;
             UPDATE sqlite_master
             SET sql=replace(sql, 'PRIMARY KEY', 'PRIMARYKEY')
             WHERE type='table' AND name='room_progress';
             PRAGMA writable_schema=OFF;",
        )
        .expect("remove schema token boundary");
    drop(connection);

    let error = Store::open(&path, test_keyring())
        .expect_err("token-boundary schema change must fail closed");
    assert!(matches!(
        error.code(),
        "store_schema_invalid" | "store_pragma_invalid"
    ));
    assert_eq!(error.to_string(), error.code());
    let mut debug = String::new();
    write!(&mut debug, "{error:?}").expect("format schema error");
    assert_eq!(debug, format!("StoreError {{ code: {:?} }}", error.code()));
}

#[test]
fn rejects_schema_sql_with_changed_check_literal_case() {
    let directory = secure_tempdir();
    let path = database_path(directory.path());
    drop(Store::open(&path, test_keyring()).expect("create current schema"));
    let connection = Connection::open(&path).expect("open database for schema tamper");
    connection
        .execute_batch(
            "PRAGMA writable_schema=ON;
             UPDATE sqlite_master
             SET sql=replace(sql, '''active''', '''ACTIVE''')
             WHERE type='table' AND name='room_bindings';
             PRAGMA writable_schema=OFF;",
        )
        .expect("change schema check literal case");
    drop(connection);

    let error =
        Store::open(&path, test_keyring()).expect_err("check literal change must fail closed");
    assert_eq!(error.code(), "store_schema_invalid");
}

#[test]
fn appends_and_reads_a_protected_room_binding() {
    let directory = secure_tempdir();
    let path = database_path(directory.path());
    let matrix_room_id = "!room-demo:example.test";
    let binding_id = "binding_0123456789abcdef0123456789abcdef";
    let binding = test_binding(binding_id, matrix_room_id);
    let room_lookup = test_keyring()
        .lookup_digest("room-binding-room-v1", &[matrix_room_id])
        .expect("derive room lookup");

    let mut store = Store::open(&path, test_keyring()).expect("open gateway store");
    store
        .append_room_binding(binding)
        .expect("append room binding");
    let found = store
        .active_room_binding(&room_lookup)
        .expect("read room binding")
        .expect("active room binding");

    assert_eq!(found.binding_id(), binding_id);
    assert_eq!(found.matrix_room_id(), matrix_room_id);
    assert_eq!(found.tenant_id(), "tenant_demo");
    assert_eq!(found.identity_id(), "identity_demo");
    assert_eq!(found.connection_id(), "connection_demo");
    assert_eq!(found.account_id(), "account_demo");
    assert_eq!(found.platform(), Provider::Telegram);
    assert_eq!(found.gateway_route_id(), "route_demo");
    assert_eq!(found.conversation_id(), "conversation_demo");
    assert_eq!(found.owner_matrix_user_id(), "@owner:example.test");
    assert_eq!(found.status(), RoomBindingStatus::Active);
    assert_eq!(found.created_at(), &timestamp(1_700_000_000_000));
    assert!(found.retired_at().is_none());
}

#[test]
fn retirement_preserves_everything_except_lifecycle_columns() {
    let directory = secure_tempdir();
    let path = database_path(directory.path());
    let binding_id = "binding_0123456789abcdef0123456789abcdef";
    let matrix_room_id = "!retire-demo:example.test";
    let room_lookup = test_keyring()
        .lookup_digest("room-binding-room-v1", &[matrix_room_id])
        .expect("derive room lookup");

    let mut store = Store::open(&path, test_keyring()).expect("open gateway store");
    store
        .append_room_binding(test_binding(binding_id, matrix_room_id))
        .expect("append room binding");
    let before = raw_room_binding(&path, binding_id).expect("read binding before retirement");
    let count_before = room_binding_count(&path);
    let retired_at = timestamp(1_800_000_000_123);

    store
        .retire_room_binding(binding_id, retired_at)
        .expect("retire active room binding");

    let after = raw_room_binding(&path, binding_id).expect("read binding after retirement");
    assert_eq!(room_binding_count(&path), count_before);
    assert_eq!(after.rowid, before.rowid);
    assert_eq!(after.binding_id, before.binding_id);
    assert_eq!(after.room_lookup, before.room_lookup);
    assert_eq!(after.account_lookup, before.account_lookup);
    assert_eq!(after.payload_cipher, before.payload_cipher);
    assert_eq!(after.payload_nonce, before.payload_nonce);
    assert_eq!(after.key_version, before.key_version);
    assert_eq!(after.created_at, before.created_at);
    assert_eq!(after.status, "retired");
    assert_eq!(after.retired_at, Some(retired_at.to_rfc3339()));
    assert!(
        store
            .active_room_binding(&room_lookup)
            .expect("read retired room")
            .is_none()
    );
}

#[test]
fn replacement_binding_for_retired_room_becomes_active() {
    let directory = secure_tempdir();
    let path = database_path(directory.path());
    let first_id = "binding_0123456789abcdef0123456789abcdef";
    let replacement_id = "binding_fedcba9876543210fedcba9876543210";
    let matrix_room_id = "!replacement-demo:example.test";
    let room_lookup = test_keyring()
        .lookup_digest("room-binding-room-v1", &[matrix_room_id])
        .expect("derive room lookup");

    let mut store = Store::open(&path, test_keyring()).expect("open gateway store");
    store
        .append_room_binding(test_binding(first_id, matrix_room_id))
        .expect("append first binding");
    store
        .retire_room_binding(first_id, timestamp(1_800_000_000_000))
        .expect("retire first binding");
    store
        .append_room_binding(test_binding(replacement_id, matrix_room_id))
        .expect("append replacement binding");

    let active = store
        .active_room_binding(&room_lookup)
        .expect("read replacement binding")
        .expect("replacement is active");
    assert_eq!(active.binding_id(), replacement_id);
    assert_eq!(active.status(), RoomBindingStatus::Active);
    assert_eq!(
        raw_room_binding(&path, first_id)
            .expect("read first row")
            .status,
        "retired"
    );
    assert_eq!(room_binding_count(&path), 2);
}

#[test]
fn duplicate_active_room_is_rejected_without_a_new_row() {
    let directory = secure_tempdir();
    let path = database_path(directory.path());
    let first_id = "binding_0123456789abcdef0123456789abcdef";
    let duplicate_id = "binding_11111111111111111111111111111111";
    let matrix_room_id = "!duplicate-room:example.test";

    let mut store = Store::open(&path, test_keyring()).expect("open gateway store");
    store
        .append_room_binding(test_binding(first_id, matrix_room_id))
        .expect("append first binding");
    let error = store
        .append_room_binding(test_binding(duplicate_id, matrix_room_id))
        .expect_err("active room duplicate must fail");

    assert_eq!(error.code(), STORE_ROOM_BINDING_DUPLICATE_ROOM);
    assert_eq!(room_binding_count(&path), 1);
}

#[test]
fn duplicate_binding_id_is_rejected_without_a_new_row() {
    let directory = secure_tempdir();
    let path = database_path(directory.path());
    let binding_id = "binding_0123456789abcdef0123456789abcdef";

    let mut store = Store::open(&path, test_keyring()).expect("open gateway store");
    store
        .append_room_binding(test_binding(binding_id, "!first-room:example.test"))
        .expect("append first binding");
    let error = store
        .append_room_binding(test_binding(binding_id, "!second-room:example.test"))
        .expect_err("binding ID duplicate must fail");

    assert_eq!(error.code(), STORE_ROOM_BINDING_DUPLICATE_ID);
    assert_eq!(room_binding_count(&path), 1);
}

#[test]
fn authority_drift_for_reused_account_is_rejected_but_same_authority_is_allowed() {
    let directory = secure_tempdir();
    let path = database_path(directory.path());
    let first_id = "binding_0123456789abcdef0123456789abcdef";
    let first_room = "!authority-first:example.test";

    let mut store = Store::open(&path, test_keyring()).expect("open gateway store");
    store
        .append_room_binding(test_binding(first_id, first_room))
        .expect("append first binding");

    let tenant_drift = test_binding_with(
        "binding_11111111111111111111111111111111",
        "!authority-tenant-drift:example.test",
        "tenant_drift",
        "identity_demo",
        "connection_demo",
        "account_demo",
        Provider::Telegram,
        "route_demo",
        "conversation_demo",
        "@owner:example.test",
        timestamp(1_700_000_000_000),
    );
    let error = store
        .append_room_binding(tenant_drift)
        .expect_err("tenant authority drift must fail");
    assert_eq!(error.code(), STORE_ROOM_BINDING_INVALID);

    let identity_drift = test_binding_with(
        "binding_22222222222222222222222222222222",
        "!authority-identity-drift:example.test",
        "tenant_demo",
        "identity_drift",
        "connection_demo",
        "account_demo",
        Provider::Telegram,
        "route_demo",
        "conversation_demo",
        "@owner:example.test",
        timestamp(1_700_000_000_000),
    );
    let error = store
        .append_room_binding(identity_drift)
        .expect_err("identity authority drift must fail");
    assert_eq!(error.code(), STORE_ROOM_BINDING_INVALID);

    let connection_drift = test_binding_with(
        "binding_33333333333333333333333333333333",
        "!authority-connection-drift:example.test",
        "tenant_demo",
        "identity_demo",
        "connection_drift",
        "account_demo",
        Provider::Telegram,
        "route_demo",
        "conversation_demo",
        "@owner:example.test",
        timestamp(1_700_000_000_000),
    );
    let error = store
        .append_room_binding(connection_drift)
        .expect_err("connection authority drift must fail");
    assert_eq!(error.code(), STORE_ROOM_BINDING_INVALID);

    let same_authority_id = "binding_44444444444444444444444444444444";
    store
        .append_room_binding(test_binding(
            same_authority_id,
            "!authority-same:example.test",
        ))
        .expect("same account authority may span multiple rooms");

    assert_eq!(room_binding_count(&path), 2);
}

#[test]
fn corrupt_ciphertext_fails_closed_for_active_read_and_retirement() {
    let directory = secure_tempdir();
    let path = database_path(directory.path());
    let binding_id = "binding_0123456789abcdef0123456789abcdef";
    let matrix_room_id = "!ciphertext-corrupt:example.test";
    let canary = "tenant_ciphertext_canary_9f2e9b0b";
    let binding = test_binding_with(
        binding_id,
        matrix_room_id,
        canary,
        "identity_demo",
        "connection_demo",
        "account_demo",
        Provider::Telegram,
        "route_demo",
        "conversation_demo",
        "@owner:example.test",
        timestamp(1_700_000_000_000),
    );

    let room_lookup = test_keyring()
        .lookup_digest("room-binding-room-v1", &[matrix_room_id])
        .expect("derive room lookup");
    let mut store = Store::open(&path, test_keyring()).expect("open gateway store");
    store.append_room_binding(binding).expect("append binding");

    let connection = Connection::open(&path).expect("open sqlite database for corruption");
    connection
        .execute(
            "UPDATE room_bindings SET payload_cipher = ?1 WHERE binding_id = ?2",
            params![vec![0_u8; 16], binding_id],
        )
        .expect("corrupt ciphertext");
    drop(connection);

    let active_error = store
        .active_room_binding(&room_lookup)
        .expect_err("corrupt ciphertext must fail active read");
    assert_eq!(active_error.code(), STORE_ROOM_BINDING_INVALID);
    assert_eq!(active_error.to_string(), STORE_ROOM_BINDING_INVALID);
    assert!(!format!("{active_error:?}").contains(canary));

    let retirement_error = store
        .retire_room_binding(binding_id, timestamp(1_800_000_000_000))
        .expect_err("corrupt ciphertext must fail retirement");
    assert_eq!(retirement_error.code(), STORE_ROOM_BINDING_INVALID);
    assert_eq!(retirement_error.to_string(), STORE_ROOM_BINDING_INVALID);
    assert!(!format!("{retirement_error:?}").contains(canary));
    assert_eq!(
        raw_room_binding(&path, binding_id)
            .expect("read corrupt row")
            .status,
        "active"
    );
}

#[test]
fn provider_platform_drift_in_protected_payload_fails_closed() {
    let directory = secure_tempdir();
    let path = database_path(directory.path());
    let binding_id = "binding_0123456789abcdef0123456789abcdef";
    let matrix_room_id = "!provider-drift:example.test";
    let room_lookup = test_keyring()
        .lookup_digest("room-binding-room-v1", &[matrix_room_id])
        .expect("derive room lookup");
    let mut store = Store::open(&path, test_keyring()).expect("open gateway store");
    store
        .append_room_binding(test_binding(binding_id, matrix_room_id))
        .expect("append binding");

    let payload = format!(
        r#"{{"schema_version":1,"matrix_room_id":"{matrix_room_id}","tenant_id":"tenant_demo","identity_id":"identity_demo","connection_id":"connection_demo","account_id":"account_demo","platform":"whatsapp","gateway_route_id":"route_demo","conversation_id":"conversation_demo","owner_matrix_user_id":"@owner:example.test"}}"#
    );
    let sealed = test_keyring()
        .seal("room_bindings", binding_id, "payload", payload.as_bytes())
        .expect("seal drifted provider payload");
    let connection = Connection::open(&path).expect("open sqlite database for provider tamper");
    connection
        .execute(
            "UPDATE room_bindings
             SET payload_cipher = ?1, payload_nonce = ?2, key_version = ?3
             WHERE binding_id = ?4",
            params![
                sealed.ciphertext,
                sealed.nonce.as_slice(),
                i64::from(sealed.key_version),
                binding_id
            ],
        )
        .expect("write drifted provider payload");
    drop(connection);

    let active_error = store
        .active_room_binding(&room_lookup)
        .expect_err("provider drift must fail active read");
    assert_eq!(active_error.code(), STORE_ROOM_BINDING_INVALID);
    let retirement_error = store
        .retire_room_binding(binding_id, timestamp(1_800_000_000_000))
        .expect_err("provider drift must fail retirement");
    assert_eq!(retirement_error.code(), STORE_ROOM_BINDING_INVALID);
    assert!(!format!("{retirement_error:?}").contains(binding_id));
    assert_eq!(
        raw_room_binding(&path, binding_id)
            .expect("read provider-drift row")
            .status,
        "active"
    );
}

#[test]
fn failed_append_and_retirement_leave_no_partial_state() {
    let directory = secure_tempdir();
    let path = database_path(directory.path());
    let binding_id = "binding_0123456789abcdef0123456789abcdef";
    let matrix_room_id = "!rollback-demo:example.test";

    let mut store = Store::open(&path, test_keyring()).expect("open gateway store");
    store
        .append_room_binding(test_binding(binding_id, matrix_room_id))
        .expect("append binding");
    let before = raw_room_binding(&path, binding_id).expect("read original row");

    let drift = test_binding_with(
        "binding_11111111111111111111111111111111",
        "!rollback-drift:example.test",
        "tenant_rollback_drift",
        "identity_demo",
        "connection_demo",
        "account_demo",
        Provider::Telegram,
        "route_demo",
        "conversation_demo",
        "@owner:example.test",
        timestamp(1_700_000_000_000),
    );
    let append_error = store
        .append_room_binding(drift)
        .expect_err("authority drift append must fail");
    assert_eq!(append_error.code(), STORE_ROOM_BINDING_INVALID);
    assert_eq!(room_binding_count(&path), 1);
    assert_eq!(raw_room_binding(&path, binding_id), Some(before));

    let retirement_error = store
        .retire_room_binding(binding_id, timestamp(1_699_999_999_999))
        .expect_err("retirement before creation must fail");
    assert_eq!(retirement_error.code(), STORE_ROOM_BINDING_INVALID);
    assert_eq!(room_binding_count(&path), 1);
    assert_eq!(
        raw_room_binding(&path, binding_id)
            .expect("read row after failed retirement")
            .status,
        "active"
    );
}

#[test]
fn protected_payload_plaintext_is_absent_from_database_wal_and_shm_bytes() {
    let directory = secure_tempdir();
    let path = database_path(directory.path());
    let binding_id = "binding_0123456789abcdef0123456789abcdef";
    let matrix_room_id = "!storage-canary-room:example.test";
    let canaries = [
        "tenant_storage_canary_8d72d0b5",
        "identity_storage_canary_8d72d0b5",
        "connection_storage_canary_8d72d0b5",
        "account_storage_canary_8d72d0b5",
        "route_storage_canary_8d72d0b5",
        "conversation_storage_canary_8d72d0b5",
        "@storage-canary-owner:example.test",
    ];
    let binding = test_binding_with(
        binding_id,
        matrix_room_id,
        canaries[0],
        canaries[1],
        canaries[2],
        canaries[3],
        Provider::Telegram,
        canaries[4],
        canaries[5],
        canaries[6],
        timestamp(1_700_000_000_000),
    );

    let mut store = Store::open(&path, test_keyring()).expect("open gateway store");
    store
        .append_room_binding(binding)
        .expect("append canary binding");
    let bytes = sqlite_storage_bytes(&path);
    for canary in canaries {
        assert_storage_excludes(&bytes, canary);
    }
}

#[test]
fn retirement_rejects_malformed_missing_already_retired_and_early_bindings() {
    let directory = secure_tempdir();
    let path = database_path(directory.path());
    let binding_id = "binding_0123456789abcdef0123456789abcdef";

    let mut store = Store::open(&path, test_keyring()).expect("open gateway store");
    store
        .append_room_binding(test_binding(
            binding_id,
            "!retirement-validation:example.test",
        ))
        .expect("append binding");
    let before = raw_room_binding(&path, binding_id).expect("read binding before retirement");

    for invalid_id in [
        "missing_binding_id",
        "binding_0123456789ABCDEF0123456789abcdef",
    ] {
        let error = store
            .retire_room_binding(invalid_id, timestamp(1_800_000_000_000))
            .expect_err("invalid or missing binding ID must fail");
        assert_eq!(error.code(), STORE_ROOM_BINDING_INVALID);
    }
    assert_eq!(raw_room_binding(&path, binding_id), Some(before));

    let sub_millisecond = Utc
        .timestamp_opt(1_800_000_000, 1)
        .single()
        .expect("construct sub-millisecond timestamp");
    let precision_error = store
        .retire_room_binding(binding_id, sub_millisecond)
        .expect_err("sub-millisecond retirement must fail");
    assert_eq!(precision_error.code(), STORE_ROOM_BINDING_INVALID);

    let early_error = store
        .retire_room_binding(binding_id, timestamp(1_699_999_999_999))
        .expect_err("retirement before creation must fail");
    assert_eq!(early_error.code(), STORE_ROOM_BINDING_INVALID);
    assert_eq!(
        raw_room_binding(&path, binding_id)
            .expect("read active row")
            .status,
        "active"
    );

    let retired_at = timestamp(1_800_000_000_000);
    store
        .retire_room_binding(binding_id, retired_at)
        .expect("retire binding");
    let after_retirement = raw_room_binding(&path, binding_id).expect("read retired row");
    let already_retired_error = store
        .retire_room_binding(binding_id, timestamp(1_900_000_000_000))
        .expect_err("already-retired binding must fail");
    assert_eq!(already_retired_error.code(), STORE_ROOM_BINDING_INVALID);
    assert_eq!(raw_room_binding(&path, binding_id), Some(after_retirement));
}
