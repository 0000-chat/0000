use communicator_matrix_gateway::config::{ConfigError, GatewayConfig};

const OVERLONG_CONFIG_FIELD_BYTES: usize = 8 * 1024;
const OVERLONG_CONFIG_INPUT_PADDING_BYTES: usize = 128 * 1024;

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
        "ingestion_service_credential_file": "/run/secrets/ingestion-service-credential",
        "matrix_password_file": "/run/secrets/matrix-password",
        "matrix_store_passphrase_file": "/run/secrets/matrix-store-passphrase",
        "state_key_file": "/run/secrets/state-key",
        "request_timeout_secs": 10,
        "sync_timeout_secs": 30
    })
}

fn assert_config_invalid(result: Result<GatewayConfig, ConfigError>) {
    assert_eq!(result.unwrap_err().code(), "config_invalid");
}

#[test]
fn rejects_complete_json_input_above_the_hard_limit() {
    let input = format!(
        "{}{}",
        valid_config(),
        " ".repeat(OVERLONG_CONFIG_INPUT_PADDING_BYTES)
    );

    assert_config_invalid(GatewayConfig::from_json(&input));
}

#[test]
fn rejects_overlong_value_in_every_textual_or_path_field() {
    for field in [
        "homeserver_url",
        "matrix_user_id",
        "matrix_store_dir",
        "state_db_path",
        "ingestion_base_url",
        "ingestion_service_credential_file",
        "matrix_password_file",
        "matrix_store_passphrase_file",
        "state_key_file",
    ] {
        let mut value = valid_config();
        value[field] = serde_json::Value::String("a".repeat(OVERLONG_CONFIG_FIELD_BYTES));

        assert_config_invalid(parse_config(value));
    }
}

#[test]
fn rejects_unbounded_request_and_sync_timeouts() {
    for field in ["request_timeout_secs", "sync_timeout_secs"] {
        let mut value = valid_config();
        value[field] = serde_json::json!(u64::MAX);

        assert_config_invalid(parse_config(value));
    }
}
