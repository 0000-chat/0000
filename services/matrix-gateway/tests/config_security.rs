use base64::Engine as _;
use communicator_matrix_gateway::config::{
    ACCEPTED_RETENTION_SECS, CANONICAL_SCHEMA_VERSION, ConfigError, GATEWAY_SCHEMA_VERSION,
    GatewayConfig, INGESTION_PATH, MAX_BATCH_CANONICAL_BYTES, MAX_BATCH_EVENTS,
    MAX_EVENT_CANONICAL_BYTES, MAX_KEY_RECOVERY_AGE_SECS, MAX_KEY_RECOVERY_WINDOWS,
    MAX_PENDING_AGE_SECS, MAX_PENDING_REQUEST_ROWS, MAX_RECOVERY_BYTES, MAX_SYNC_RESPONSE_BYTES,
    PRODUCER_VERSION,
};
use communicator_matrix_gateway::protected::Protected;
use communicator_matrix_gateway::secret::{
    SECRET_INVALID, SECRET_TOO_LARGE, SecretKind, load_secret,
};
use std::{
    fs,
    os::unix::fs::{PermissionsExt, symlink},
    path::{Path, PathBuf},
};

const CANARY: &str = "secret-canary-must-not-escape";

fn write_secret(dir: &Path, name: &str, bytes: &[u8], mode: u32) -> PathBuf {
    let path = dir.join(name);
    fs::write(&path, bytes).expect("write test secret");
    fs::set_permissions(&path, fs::Permissions::from_mode(mode)).expect("set test mode");
    path
}

fn assert_safe_error(error: communicator_matrix_gateway::secret::SafeError, code: &str) {
    assert_eq!(error.code(), code);
    assert!(!format!("{error:?}").contains(CANARY));
    assert!(!error.to_string().contains(CANARY));
}

fn assert_safe_config_error(error: communicator_matrix_gateway::config::ConfigError) {
    assert_eq!(error.code(), "config_invalid");
    assert!(!format!("{error:?}").contains(CANARY));
    assert!(!error.to_string().contains(CANARY));
}

fn parse_config(value: serde_json::Value) -> Result<GatewayConfig, ConfigError> {
    GatewayConfig::from_json(&value.to_string())
}

fn valid_config() -> serde_json::Value {
    serde_json::json!({
        "homeserver_url": "http://synapse:8008",
        "matrix_user_id": "@gateway:example.org",
        "matrix_store_dir": "/var/lib/communicator/matrix",
        "state_db_path": "/var/lib/communicator/state.sqlite3",
        "ingestion_base_url": "https://ingest.example.org",
        "oauth_token_url": "https://auth.example.org/oauth/token",
        "oauth_client_id": "communicator-gateway",
        "oauth_client_auth_method": "client_secret_basic",
        "matrix_password_file": "/run/secrets/matrix-password",
        "matrix_store_passphrase_file": "/run/secrets/matrix-store-passphrase",
        "state_key_file": "/run/secrets/state-key",
        "oauth_client_secret_file": "/run/secrets/oauth-client-secret",
        "request_timeout_secs": 10,
        "sync_timeout_secs": 30
    })
}

#[test]
fn valid_config_deserializes_and_limits_are_fixed() {
    let config = parse_config(valid_config()).expect("valid config");
    assert_eq!(config.request_timeout_secs(), 10);
    assert_eq!(config.sync_timeout_secs(), 30);
    assert_eq!(config.homeserver_url(), "http://synapse:8008");
    assert_eq!(config.matrix_user_id(), "@gateway:example.org");
    assert_eq!(
        config.matrix_store_dir(),
        Path::new("/var/lib/communicator/matrix")
    );
    assert_eq!(
        config.state_db_path(),
        Path::new("/var/lib/communicator/state.sqlite3")
    );
    assert_eq!(config.ingestion_base_url(), "https://ingest.example.org");
    assert_eq!(
        config.oauth_token_url(),
        "https://auth.example.org/oauth/token"
    );
    assert_eq!(config.oauth_client_id(), "communicator-gateway");
    assert_eq!(
        config.matrix_password_file(),
        Path::new("/run/secrets/matrix-password")
    );
    assert_eq!(
        config.matrix_store_passphrase_file(),
        Path::new("/run/secrets/matrix-store-passphrase")
    );
    assert_eq!(config.state_key_file(), Path::new("/run/secrets/state-key"));
    assert_eq!(
        config.oauth_client_secret_file(),
        Path::new("/run/secrets/oauth-client-secret")
    );
    assert!(matches!(
        config.oauth_client_auth_method(),
        communicator_matrix_gateway::config::OAuthClientAuthMethod::Basic
    ));
    assert_eq!(MAX_RECOVERY_BYTES, 256 * 1024 * 1024);
    assert_eq!(MAX_PENDING_REQUEST_ROWS, 2_000);
    assert_eq!(MAX_PENDING_AGE_SECS, 24 * 60 * 60);
    assert_eq!(ACCEPTED_RETENTION_SECS, 7 * 24 * 60 * 60);
    assert_eq!(GATEWAY_SCHEMA_VERSION, 1);
    assert_eq!(CANONICAL_SCHEMA_VERSION, 1);
    assert_eq!(MAX_BATCH_EVENTS, 500);
    assert_eq!(MAX_BATCH_CANONICAL_BYTES, 4 * 1024 * 1024);
    assert_eq!(MAX_EVENT_CANONICAL_BYTES, 1024 * 1024);
    assert_eq!(MAX_SYNC_RESPONSE_BYTES, 64 * 1024 * 1024);
    assert_eq!(MAX_KEY_RECOVERY_WINDOWS, 16);
    assert_eq!(MAX_KEY_RECOVERY_AGE_SECS, 10 * 60);
    assert_eq!(INGESTION_PATH, "/internal/v1/ingestion/batches");
    assert!(PRODUCER_VERSION.starts_with("matrix-gateway/"));
}

#[test]
fn unknown_fields_are_rejected() {
    let mut value = valid_config();
    value[CANARY] = serde_json::json!(true);
    let error = parse_config(value).unwrap_err();
    assert_safe_config_error(error);
}

#[test]
fn semantic_security_rules_are_rejected() {
    for (field, bad) in [
        ("matrix_store_dir", "relative/store"),
        ("state_db_path", "state.sqlite3"),
        ("ingestion_base_url", "http://ingest.example.org"),
        ("oauth_token_url", "http://auth.example.org/token"),
        ("homeserver_url", "http://other:8008"),
        ("matrix_user_id", "not-a-user-id"),
    ] {
        let mut value = valid_config();
        value[field] = serde_json::json!(bad);
        let error = parse_config(value).unwrap_err();
        assert_safe_config_error(error);
    }
}

#[test]
fn timeouts_must_be_nonzero() {
    for field in ["request_timeout_secs", "sync_timeout_secs"] {
        let mut value = valid_config();
        value[field] = serde_json::json!(0);
        let error = parse_config(value).unwrap_err();
        assert_safe_config_error(error);
    }
}

#[test]
fn auth_method_is_an_exact_enum() {
    for method in ["client_secret_basic", "client_secret_post"] {
        let mut value = valid_config();
        value["oauth_client_auth_method"] = serde_json::json!(method);
        assert!(parse_config(value).is_ok(), "{method}");
    }
    let mut value = valid_config();
    value["oauth_client_auth_method"] = serde_json::json!(CANARY);
    let error = parse_config(value).unwrap_err();
    assert_safe_config_error(error);
}

#[test]
fn malformed_json_is_a_code_only_error() {
    let malformed = format!("{{\"{CANARY}\":");
    let error = GatewayConfig::from_json(&malformed).expect_err("malformed JSON must fail");
    assert_safe_config_error(error);
}

#[test]
fn fragments_are_rejected_before_uri_parsing() {
    for field in ["homeserver_url", "ingestion_base_url", "oauth_token_url"] {
        let mut value = valid_config();
        value[field] = serde_json::json!(format!("https://valid.example/{CANARY}#fragment"));
        if field == "homeserver_url" {
            value[field] = serde_json::json!(format!("http://synapse:8008#{CANARY}"));
        }
        let error = parse_config(value).unwrap_err();
        assert_safe_config_error(error);
    }
}

#[test]
fn parent_directory_components_are_rejected_for_every_config_path() {
    for field in [
        "matrix_store_dir",
        "state_db_path",
        "matrix_password_file",
        "matrix_store_passphrase_file",
        "state_key_file",
        "oauth_client_secret_file",
    ] {
        let mut value = valid_config();
        value[field] = serde_json::json!(format!("/var/lib/communicator/../{CANARY}"));
        let error = parse_config(value).unwrap_err();
        assert_safe_config_error(error);
    }
}

#[test]
fn protected_values_are_redacted_in_debug_and_display() {
    assert_eq!(format!("{:?}", Protected::new(CANARY)), "[REDACTED]");
    assert_eq!(format!("{}", Protected::new(CANARY)), "[REDACTED]");
}

#[test]
fn missing_secret_is_a_code_only_error() {
    let tempdir = tempfile::tempdir().expect("tempdir");
    let path = tempdir.path().join("missing-secret-canary");
    let error = load_secret(&path, SecretKind::Text { max_bytes: 128 }).unwrap_err();
    assert_safe_error(error, SECRET_INVALID);
}

#[test]
fn symlink_secret_is_rejected_without_disclosing_target() {
    let tempdir = tempfile::tempdir().expect("tempdir");
    let target = write_secret(tempdir.path(), "target", CANARY.as_bytes(), 0o600);
    let path = tempdir.path().join("link");
    symlink(&target, &path).expect("symlink");

    let error = load_secret(&path, SecretKind::Text { max_bytes: 128 }).unwrap_err();
    assert_safe_error(error, SECRET_INVALID);
}

#[test]
fn secret_mode_must_be_exactly_0600() {
    let tempdir = tempfile::tempdir().expect("tempdir");
    for mode in [0o400, 0o640, 0o6000] {
        let path = write_secret(
            tempdir.path(),
            &format!("secret-{mode:o}"),
            CANARY.as_bytes(),
            mode,
        );
        let error = load_secret(&path, SecretKind::Text { max_bytes: 128 }).unwrap_err();
        assert_safe_error(error, SECRET_INVALID);
    }
}

#[test]
fn text_secret_rejects_embedded_nul_and_trailing_whitespace() {
    let tempdir = tempfile::tempdir().expect("tempdir");
    for (name, value) in [
        ("nul", b"before\0after".as_slice()),
        ("invalid-utf8", b"invalid-\xff".as_slice()),
        ("space", b"trailing-space ".as_slice()),
        ("tab", b"trailing-tab\t".as_slice()),
        ("double-lf", b"one\n\n".as_slice()),
        ("crlf", b"one\r\n".as_slice()),
    ] {
        let path = write_secret(tempdir.path(), name, value, 0o600);
        let error = load_secret(&path, SecretKind::Text { max_bytes: 128 }).unwrap_err();
        assert_safe_error(error, SECRET_INVALID);
    }
}

#[test]
fn oversized_secret_is_rejected_before_reading() {
    let tempdir = tempfile::tempdir().expect("tempdir");
    let path = write_secret(tempdir.path(), "oversized", b"123456789", 0o600);
    let error = load_secret(&path, SecretKind::Text { max_bytes: 8 }).unwrap_err();
    assert_safe_error(error, SECRET_TOO_LARGE);
}

#[test]
fn state_key_requires_strict_base64_and_exact_decoded_length() {
    let tempdir = tempfile::tempdir().expect("tempdir");
    for (name, value) in [
        ("invalid", b"not-base64".as_slice()),
        (
            "wrong-length",
            b"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA".as_slice(),
        ),
    ] {
        let path = write_secret(tempdir.path(), name, value, 0o600);
        let error = load_secret(&path, SecretKind::StateKey).unwrap_err();
        assert_safe_error(error, SECRET_INVALID);
    }

    let mut whitespace = vec![b'A'; 41];
    whitespace.extend_from_slice(b"= \n");
    let path = write_secret(tempdir.path(), "whitespace", &whitespace, 0o600);
    let error = load_secret(&path, SecretKind::StateKey).unwrap_err();
    assert_safe_error(error, SECRET_INVALID);
}

#[test]
fn valid_text_and_state_key_secrets_are_loaded() {
    let tempdir = tempfile::tempdir().expect("tempdir");
    let text_path = write_secret(tempdir.path(), "text", b"text-canary\n", 0o600);
    let text = load_secret(&text_path, SecretKind::Text { max_bytes: 128 }).expect("text secret");
    assert_eq!(text.as_bytes(), b"text-canary");

    let encoded = base64::engine::general_purpose::STANDARD.encode([7_u8; 32]);
    let state_path = write_secret(tempdir.path(), "state", encoded.as_bytes(), 0o600);
    let state = load_secret(&state_path, SecretKind::StateKey).expect("state key");
    assert_eq!(state.as_bytes(), [7_u8; 32]);
}
