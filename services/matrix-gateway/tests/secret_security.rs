use communicator_matrix_gateway::secret::{
    SECRET_INVALID, SECRET_TOO_LARGE, SafeError, SecretBytes, SecretKind, load_secret,
};
use rustix::{
    fs::{CWD, Mode, Uid, mkfifoat},
    process::geteuid,
};
use std::{
    fs,
    os::unix::fs::{MetadataExt, PermissionsExt, symlink},
    path::{Path, PathBuf},
    process::Command,
    thread,
    time::{Duration, Instant},
};

const CANARY: &str = "secret-review-canary";
const ABSOLUTE_MAX_TEXT_BYTES: usize = 1024 * 1024;
const FIFO_CHILD_ENV: &str = "COMMUNICATOR_MATRIX_GATEWAY_FIFO_CHILD";
const FIFO_PATH_ENV: &str = "COMMUNICATOR_MATRIX_GATEWAY_FIFO_PATH";

fn write_secret(dir: &Path, name: &str, bytes: &[u8]) -> PathBuf {
    let path = dir.join(name);
    fs::write(&path, bytes).expect("write test secret");
    fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).expect("set test mode");
    path
}

fn assert_safe_error(error: SafeError, code: &str) {
    assert_eq!(error.code(), code);
    assert!(!format!("{error:?}").contains(CANARY));
    assert!(!error.to_string().contains(CANARY));
}

#[test]
fn secret_construction_bypasses_are_not_public() {
    let source = include_str!("../src/secret.rs");

    assert!(
        !source.contains("pub fn new("),
        "SecretBytes::new must not be a public constructor"
    );
    assert!(
        !source.contains("pub fn from_slice("),
        "SecretBytes::from_slice must not be a public constructor"
    );
    assert!(
        !source.contains("pub fn parse_secret("),
        "parse_secret must not be a public parser bypass"
    );
}

#[test]
fn text_secret_rejects_ascii_and_unicode_controls_anywhere() {
    for text in [
        "before\u{0000}after",
        "before\u{0001}after",
        "before\u{001f}after",
        "before\u{007f}after",
        "before\u{0085}after",
        "before\u{000b}after",
        "before\u{2028}after",
        "before\u{2029}after",
    ] {
        let error = SecretBytes::from_text(text.as_bytes(), 128).unwrap_err();
        assert_safe_error(error, SECRET_INVALID);
    }
}

#[test]
fn text_secret_allows_normal_non_ascii_text_and_one_final_lf() {
    let plain = SecretBytes::from_text("秘密—value".as_bytes(), 128).expect("normal UTF-8");
    assert_eq!(plain.as_bytes(), "秘密—value".as_bytes());

    let with_lf = SecretBytes::from_text("秘密—value\n".as_bytes(), 128).expect("final LF");
    assert_eq!(with_lf.as_bytes(), "秘密—value".as_bytes());
}

#[test]
fn intermediate_symlink_is_rejected() {
    let tempdir = tempfile::tempdir().expect("tempdir");
    let real_dir = tempdir.path().join("real");
    fs::create_dir(&real_dir).expect("real directory");
    let target = write_secret(&real_dir, "secret", CANARY.as_bytes());
    let link_dir = tempdir.path().join("link-dir");
    symlink(&real_dir, &link_dir).expect("intermediate symlink");

    let path = link_dir.join("secret");
    let error = load_secret(&path, SecretKind::Text { max_bytes: 128 }).unwrap_err();
    assert_safe_error(error, SECRET_INVALID);
    assert_eq!(
        fs::read_to_string(target).expect("target remains readable"),
        CANARY
    );
}

#[test]
fn parent_dir_component_is_rejected() {
    let tempdir = tempfile::tempdir().expect("tempdir");
    let safe_dir = tempdir.path().join("safe");
    fs::create_dir(&safe_dir).expect("safe directory");
    let target = write_secret(tempdir.path(), "target", CANARY.as_bytes());

    let path = safe_dir.join("..").join("target");
    let error = load_secret(&path, SecretKind::Text { max_bytes: 128 }).unwrap_err();
    assert_safe_error(error, SECRET_INVALID);
    assert_eq!(
        fs::read_to_string(target).expect("target remains readable"),
        CANARY
    );
}

#[test]
fn directory_secret_is_rejected() {
    let tempdir = tempfile::tempdir().expect("tempdir");
    let path = tempdir.path().join("directory");
    fs::create_dir(&path).expect("directory");

    let error = load_secret(&path, SecretKind::Text { max_bytes: 128 }).unwrap_err();
    assert_safe_error(error, SECRET_INVALID);
}

#[test]
#[ignore = "supplemental integration coverage; requires privilege to chown the fixture"]
fn foreign_owner_is_rejected_in_privileged_integration() {
    let tempdir = tempfile::tempdir().expect("tempdir");
    let path = write_secret(tempdir.path(), "foreign-owner", CANARY.as_bytes());
    let current_uid = geteuid().as_raw();
    let foreign_uid = if current_uid == 0 { 1 } else { 0 };

    rustix::fs::chown(&path, Some(Uid::from_raw(foreign_uid)), None)
        .expect("privileged integration fixture ownership change");

    let error = load_secret(&path, SecretKind::Text { max_bytes: 128 }).unwrap_err();
    assert_safe_error(error, SECRET_INVALID);
}

#[test]
fn public_text_parser_rejects_oversized_input() {
    let error = SecretBytes::from_text(CANARY.as_bytes(), 4).unwrap_err();
    assert_safe_error(error, SECRET_TOO_LARGE);
}

#[test]
fn public_state_key_parser_rejects_oversized_input() {
    let oversized = vec![b'A'; 45];
    let error = SecretBytes::from_state_key_base64(&oversized).unwrap_err();
    assert_safe_error(error, SECRET_INVALID);
}

#[test]
fn text_limit_has_a_hard_absolute_maximum() {
    let tempdir = tempfile::tempdir().expect("tempdir");
    let path = write_secret(tempdir.path(), "bounded", b"small");

    let error = load_secret(
        &path,
        SecretKind::Text {
            max_bytes: ABSOLUTE_MAX_TEXT_BYTES + 1,
        },
    )
    .unwrap_err();
    assert_safe_error(error, SECRET_TOO_LARGE);

    let error = SecretBytes::from_text(b"small", ABSOLUTE_MAX_TEXT_BYTES + 1).unwrap_err();
    assert_safe_error(error, SECRET_TOO_LARGE);
}

#[test]
fn secret_kind_does_not_derive_debug() {
    let source = include_str!("../src/secret.rs");
    let before_enum = source
        .split_once("pub enum SecretKind")
        .map_or(source, |(prefix, _)| prefix);
    let derive_line = before_enum
        .lines()
        .rev()
        .find(|line| line.contains("derive("))
        .expect("SecretKind derive line");
    assert!(
        !derive_line.contains("Debug"),
        "SecretKind must not derive Debug"
    );
}

#[test]
fn fifo_secret_is_rejected_without_blocking() {
    if let Some(path) = std::env::var_os(FIFO_PATH_ENV) {
        let path = PathBuf::from(path);
        let error = load_secret(&path, SecretKind::Text { max_bytes: 128 }).unwrap_err();
        assert_safe_error(error, SECRET_INVALID);
        return;
    }

    let tempdir = tempfile::tempdir().expect("tempdir");
    let path = tempdir.path().join("fifo");
    mkfifoat(CWD, &path, Mode::RUSR | Mode::WUSR).expect("mode-0600 FIFO");
    let metadata = fs::symlink_metadata(&path).expect("FIFO metadata");
    assert_eq!(metadata.permissions().mode() & 0o7777, 0o600);
    assert_eq!(metadata.uid(), geteuid().as_raw());

    let mut child = Command::new(std::env::current_exe().expect("test executable"))
        .arg("--exact")
        .arg("fifo_secret_is_rejected_without_blocking")
        .arg("--nocapture")
        .env(FIFO_CHILD_ENV, "1")
        .env(FIFO_PATH_ENV, &path)
        .spawn()
        .expect("spawn bounded FIFO test");

    let deadline = Instant::now() + Duration::from_secs(2);
    let status = loop {
        if let Some(status) = child.try_wait().expect("poll FIFO child") {
            break status;
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            panic!("FIFO loader did not return within the bounded test timeout");
        }
        thread::sleep(Duration::from_millis(10));
    };
    assert!(
        status.success(),
        "FIFO child exited unsuccessfully: {status}"
    );
}
