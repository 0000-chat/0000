use std::{fmt::Write as _, fs, path::Path};

#[cfg(unix)]
use std::os::unix::{fs::PermissionsExt, fs::symlink};

use communicator_matrix_gateway::store::Store;
use rusqlite::Connection;
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

    let store = Store::open(&path).expect("open brand-new gateway database");
    assert!(store.pragmas().foreign_keys());
    assert_eq!(store.pragmas().journal_mode(), "wal");
    assert_eq!(store.pragmas().synchronous(), 2);
    assert_eq!(store.pragmas().busy_timeout_ms(), 5_000);
    drop(store);

    assert_eq!(
        schema_objects(&path, "table"),
        vec![
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

    drop(Store::open(&path).expect("create current schema"));
    Store::open(&path).expect("reopen current schema");

    drop(Store::open(&path).expect("close current schema before downgrade tamper"));
    let connection = Connection::open(&path).expect("open database for downgrade tamper");
    connection
        .execute_batch("PRAGMA ignore_check_constraints=ON; UPDATE schema_meta SET version=0;")
        .expect("write simulated downgrade");
    drop(connection);
    let downgrade = Store::open(&path).expect_err("downgraded schema must fail closed");
    assert_eq!(downgrade.code(), "store_schema_downgrade");

    let connection = Connection::open(&path).expect("open database for newer-version tamper");
    connection
        .execute_batch("PRAGMA ignore_check_constraints=ON; UPDATE schema_meta SET version=2;")
        .expect("write simulated newer schema");
    drop(connection);
    let newer = Store::open(&path).expect_err("newer schema must fail closed");
    assert_eq!(newer.code(), "store_schema_newer");
}

#[test]
fn rejects_invalid_schema_and_error_format_is_code_only() {
    let directory = secure_tempdir();
    let path = database_path(directory.path());

    drop(Store::open(&path).expect("create current schema"));
    let connection = Connection::open(&path).expect("open database for invalid-schema tamper");
    connection
        .execute_batch("DROP TABLE gateway_state;")
        .expect("remove required table");
    drop(connection);

    let error = Store::open(&path).expect_err("invalid schema must fail closed");
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

    let first = Store::open(&path).expect("open first store");
    let second = Store::open(&path).expect_err("second store must be excluded by lock");
    assert_eq!(second.code(), "store_lock_unavailable");
    let mut debug = String::new();
    write!(&mut debug, "{second:?}").expect("format lock error");
    assert_eq!(debug, "StoreError { code: \"store_lock_unavailable\" }");
    assert!(!debug.contains(path.to_string_lossy().as_ref()));

    drop(first);
    Store::open(&path).expect("lock must release with store lifetime");
    assert!(fs::metadata(path.with_extension("lock")).is_ok());
}

#[test]
fn store_declares_sqlite_connection_before_lock_for_drop_order() {
    let source = include_str!("../src/store.rs");
    let connection = source
        .find("_connection: Connection")
        .expect("store must own a sqlite connection");
    let lock = source.find("_lock: File").expect("store must own its lock");
    assert!(
        connection < lock,
        "SQLite connection must be declared before the lock so it drops first"
    );
}

#[cfg(unix)]
#[test]
fn rejects_symlink_database_path() {
    let directory = secure_tempdir();
    let target = database_path(directory.path());
    drop(Store::open(&target).expect("create target database"));
    let alias = directory.path().join("database-alias.sqlite3");
    symlink(&target, &alias).expect("create database symlink");

    let error = Store::open(&alias).expect_err("database symlink must fail closed");
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

    let error = Store::open(&path).expect_err("lock symlink must fail closed");
    assert_eq!(error.code(), "store_path_invalid");
}

#[cfg(unix)]
#[test]
fn rejects_database_hardlink_alias() {
    let directory = secure_tempdir();
    let path = database_path(directory.path());
    drop(Store::open(&path).expect("create current schema"));
    let alias = directory.path().join("database-alias.sqlite3");
    fs::hard_link(&path, &alias).expect("create database hardlink alias");

    let error = Store::open(&alias).expect_err("hardlinked database must fail closed");
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

    let error =
        Store::open(database_path(&insecure)).expect_err("insecure parent must fail closed");
    assert_eq!(error.code(), "store_path_invalid");
}

#[test]
fn rejects_schema_sql_with_removed_token_boundary() {
    let directory = secure_tempdir();
    let path = database_path(directory.path());
    drop(Store::open(&path).expect("create current schema"));
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

    let error = Store::open(&path).expect_err("token-boundary schema change must fail closed");
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
    drop(Store::open(&path).expect("create current schema"));
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

    let error = Store::open(&path).expect_err("check literal change must fail closed");
    assert_eq!(error.code(), "store_schema_invalid");
}
