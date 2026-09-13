//! Strict, fail-closed gateway configuration.
//!
//! Secrets are deliberately represented only by paths here. Reading those
//! files belongs to the secret-loading module and must not happen while
//! parsing config.

use std::{
    fmt,
    net::SocketAddr,
    path::{Component, Path, PathBuf},
};

use http::Uri;
use serde::Deserialize;

/// Fixed gateway schema version.
pub const GATEWAY_SCHEMA_VERSION: i64 = 1;
/// Fixed canonical event schema version.
pub const CANONICAL_SCHEMA_VERSION: u8 = 1;
/// Maximum number of canonical events in one ingestion batch.
pub const MAX_BATCH_EVENTS: usize = 500;
/// Maximum encoded canonical JSONL bytes in one ingestion batch.
pub const MAX_BATCH_CANONICAL_BYTES: usize = 4 * 1024 * 1024;
/// Maximum encoded canonical bytes for one event.
pub const MAX_EVENT_CANONICAL_BYTES: usize = 1024 * 1024;
/// Maximum raw sync response body accepted by the transport.
pub const MAX_SYNC_RESPONSE_BYTES: usize = 64 * 1024 * 1024;
/// Maximum number of key-recovery windows that may be chained.
pub const MAX_KEY_RECOVERY_WINDOWS: u64 = 16;
/// Maximum age of a key-recovery chain.
pub const MAX_KEY_RECOVERY_AGE_SECS: u64 = 10 * 60;
/// Maximum number of pending request rows.
pub const MAX_PENDING_REQUEST_ROWS: u64 = 2_000;
/// Maximum encrypted recovery/inbox bytes.
pub const MAX_RECOVERY_BYTES: u64 = 256 * 1024 * 1024;
/// Maximum age of a pending request.
pub const MAX_PENDING_AGE_SECS: u64 = 24 * 60 * 60;
/// Maximum UTF-8 bytes accepted for one complete JSON configuration document.
pub const MAX_CONFIG_JSON_BYTES: usize = 64 * 1024;
/// Maximum UTF-8 bytes accepted for any textual or path configuration field.
pub const MAX_CONFIG_FIELD_BYTES: usize = 4 * 1024;
/// Maximum outbound request timeout (60 seconds; the default is 10 seconds).
pub const MAX_REQUEST_TIMEOUT_SECS: u64 = 60;
/// Maximum Matrix sync timeout (5 minutes; the default is 30 seconds).
pub const MAX_SYNC_TIMEOUT_SECS: u64 = 5 * 60;
/// Retention period for accepted batches.
pub const ACCEPTED_RETENTION_SECS: u64 = 7 * 24 * 60 * 60;
/// Relative path of the Cloudflare ingestion endpoint.
pub const INGESTION_PATH: &str = "/internal/v1/ingestion/batches";
/// Version string attached to canonical ingestion batches.
pub const PRODUCER_VERSION: &str = concat!("matrix-gateway/", env!("CARGO_PKG_VERSION"));

const CONFIG_INVALID: &str = "config_invalid";

/// The OAuth client authentication method accepted by the gateway.
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum OAuthClientAuthMethod {
    Basic,
    Post,
}

/// Parsed and semantically validated gateway configuration.
///
/// Values are private so callers cannot construct an unchecked configuration
/// or accidentally serialize protected endpoints and paths. Use
/// GatewayConfig::from_json and the read-only getters.
#[derive(Clone)]
pub struct GatewayConfig {
    homeserver_url: String,
    matrix_user_id: String,
    matrix_store_dir: PathBuf,
    state_db_path: PathBuf,
    ingestion_base_url: String,
    oauth_token_url: String,
    oauth_client_id: String,
    oauth_client_auth_method: OAuthClientAuthMethod,
    matrix_password_file: PathBuf,
    matrix_store_passphrase_file: PathBuf,
    state_key_file: PathBuf,
    oauth_client_secret_file: PathBuf,
    request_timeout_secs: u64,
    sync_timeout_secs: u64,
    provisioning: Option<ProvisioningConfig>,
}

/// Private authenticated provisioning gateway configuration. Secret values
/// are represented only by protected file paths and loaded by the command
/// runner immediately before binding the private listener.
#[derive(Clone)]
pub struct ProvisioningConfig {
    listen_addr: SocketAddr,
    bridge_url: String,
    bridge_shared_secret_file: PathBuf,
    gateway_shared_secret_file: PathBuf,
    matrix_user_id: String,
    gateway_route_id: String,
    bridge_instance_id: String,
    matrix_room_namespace: String,
}

impl fmt::Debug for ProvisioningConfig {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("ProvisioningConfig([REDACTED])")
    }
}

impl fmt::Debug for GatewayConfig {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("GatewayConfig([REDACTED])")
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
enum RawOAuthClientAuthMethod {
    #[serde(rename = "client_secret_basic")]
    Basic,
    #[serde(rename = "client_secret_post")]
    Post,
}

impl From<RawOAuthClientAuthMethod> for OAuthClientAuthMethod {
    fn from(method: RawOAuthClientAuthMethod) -> Self {
        match method {
            RawOAuthClientAuthMethod::Basic => Self::Basic,
            RawOAuthClientAuthMethod::Post => Self::Post,
        }
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RawGatewayConfig {
    homeserver_url: String,
    matrix_user_id: String,
    matrix_store_dir: PathBuf,
    state_db_path: PathBuf,
    ingestion_base_url: String,
    oauth_token_url: String,
    oauth_client_id: String,
    oauth_client_auth_method: RawOAuthClientAuthMethod,
    matrix_password_file: PathBuf,
    matrix_store_passphrase_file: PathBuf,
    state_key_file: PathBuf,
    oauth_client_secret_file: PathBuf,
    request_timeout_secs: u64,
    sync_timeout_secs: u64,
    #[serde(default)]
    provisioning: Option<RawProvisioningConfig>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RawProvisioningConfig {
    listen_addr: String,
    bridge_url: String,
    bridge_shared_secret_file: PathBuf,
    gateway_shared_secret_file: PathBuf,
    matrix_user_id: String,
    gateway_route_id: String,
    bridge_instance_id: String,
    matrix_room_namespace: String,
}

/// Stable, value-free configuration validation error.
///
/// The error stores only a fixed code. It never retains rejected JSON, a path,
/// a URL, an enum value, or a serde error.
#[derive(Clone, Copy, PartialEq, Eq)]
pub struct ConfigError {
    code: &'static str,
}

impl ConfigError {
    const fn invalid() -> Self {
        Self {
            code: CONFIG_INVALID,
        }
    }

    /// Return the stable machine-readable error code.
    pub const fn code(&self) -> &'static str {
        self.code
    }
}

impl fmt::Debug for ConfigError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ConfigError")
            .field("code", &self.code)
            .finish()
    }
}

impl fmt::Display for ConfigError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.code)
    }
}

impl std::error::Error for ConfigError {}

impl GatewayConfig {
    /// Parse a complete JSON document and apply semantic validation.
    ///
    /// All syntax, schema, and validation failures become the same stable
    /// value-free error code.
    pub fn from_json(input: &str) -> Result<Self, ConfigError> {
        if input.len() > MAX_CONFIG_JSON_BYTES {
            return Err(ConfigError::invalid());
        }
        let raw =
            serde_json::from_str::<RawGatewayConfig>(input).map_err(|_| ConfigError::invalid())?;
        Self::from_raw(raw)
    }

    fn from_raw(raw: RawGatewayConfig) -> Result<Self, ConfigError> {
        let config = Self {
            homeserver_url: raw.homeserver_url,
            matrix_user_id: raw.matrix_user_id,
            matrix_store_dir: raw.matrix_store_dir,
            state_db_path: raw.state_db_path,
            ingestion_base_url: raw.ingestion_base_url,
            oauth_token_url: raw.oauth_token_url,
            oauth_client_id: raw.oauth_client_id,
            oauth_client_auth_method: raw.oauth_client_auth_method.into(),
            matrix_password_file: raw.matrix_password_file,
            matrix_store_passphrase_file: raw.matrix_store_passphrase_file,
            state_key_file: raw.state_key_file,
            oauth_client_secret_file: raw.oauth_client_secret_file,
            request_timeout_secs: raw.request_timeout_secs,
            sync_timeout_secs: raw.sync_timeout_secs,
            provisioning: raw
                .provisioning
                .map(ProvisioningConfig::from_raw)
                .transpose()?,
        };
        config.validate()?;
        Ok(config)
    }

    /// Validate this configuration.
    pub fn validate(&self) -> Result<(), ConfigError> {
        validate_internal_homeserver(&self.homeserver_url)?;
        validate_https_endpoint(&self.ingestion_base_url)?;
        validate_https_endpoint(&self.oauth_token_url)?;
        validate_matrix_user_id(&self.matrix_user_id)?;
        validate_path(&self.matrix_store_dir)?;
        validate_path(&self.state_db_path)?;
        validate_path(&self.matrix_password_file)?;
        validate_path(&self.matrix_store_passphrase_file)?;
        validate_path(&self.state_key_file)?;
        validate_path(&self.oauth_client_secret_file)?;
        validate_text(&self.oauth_client_id)?;
        if self.request_timeout_secs == 0 || self.request_timeout_secs > MAX_REQUEST_TIMEOUT_SECS {
            return Err(ConfigError::invalid());
        }
        if self.sync_timeout_secs == 0 || self.sync_timeout_secs > MAX_SYNC_TIMEOUT_SECS {
            return Err(ConfigError::invalid());
        }
        if let Some(provisioning) = &self.provisioning {
            provisioning.validate()?;
        }
        Ok(())
    }

    /// Return the private Synapse homeserver URL.
    pub fn homeserver_url(&self) -> &str {
        &self.homeserver_url
    }

    /// Return the configured Matrix service user ID.
    pub fn matrix_user_id(&self) -> &str {
        &self.matrix_user_id
    }

    /// Return the persistent Matrix store directory.
    pub fn matrix_store_dir(&self) -> &Path {
        &self.matrix_store_dir
    }

    /// Return the gateway state database path.
    pub fn state_db_path(&self) -> &Path {
        &self.state_db_path
    }

    /// Return the Cloudflare ingestion base URL.
    pub fn ingestion_base_url(&self) -> &str {
        &self.ingestion_base_url
    }

    /// Return the OAuth token URL.
    pub fn oauth_token_url(&self) -> &str {
        &self.oauth_token_url
    }

    /// Return the OAuth client ID.
    pub fn oauth_client_id(&self) -> &str {
        &self.oauth_client_id
    }

    /// Return the OAuth client authentication method.
    pub const fn oauth_client_auth_method(&self) -> OAuthClientAuthMethod {
        self.oauth_client_auth_method
    }

    /// Return the Matrix password file path.
    pub fn matrix_password_file(&self) -> &Path {
        &self.matrix_password_file
    }

    /// Return the Matrix store passphrase file path.
    pub fn matrix_store_passphrase_file(&self) -> &Path {
        &self.matrix_store_passphrase_file
    }

    /// Return the gateway state-key file path.
    pub fn state_key_file(&self) -> &Path {
        &self.state_key_file
    }

    /// Return the OAuth client-secret file path.
    pub fn oauth_client_secret_file(&self) -> &Path {
        &self.oauth_client_secret_file
    }

    /// Return the request timeout in seconds.
    pub const fn request_timeout_secs(&self) -> u64 {
        self.request_timeout_secs
    }

    /// Return the sync timeout in seconds.
    pub const fn sync_timeout_secs(&self) -> u64 {
        self.sync_timeout_secs
    }

    /// Return the optional private provisioning gateway configuration.
    pub fn provisioning(&self) -> Option<&ProvisioningConfig> {
        self.provisioning.as_ref()
    }

    /// Return fixed backpressure and retention limits.
    pub const fn limits() -> GatewayLimits {
        GatewayLimits {
            max_pending_request_rows: MAX_PENDING_REQUEST_ROWS,
            max_recovery_bytes: MAX_RECOVERY_BYTES,
            max_pending_age_secs: MAX_PENDING_AGE_SECS,
            accepted_retention_secs: ACCEPTED_RETENTION_SECS,
        }
    }
}

impl ProvisioningConfig {
    fn from_raw(raw: RawProvisioningConfig) -> Result<Self, ConfigError> {
        let listen_addr = raw
            .listen_addr
            .parse::<SocketAddr>()
            .map_err(|_| ConfigError::invalid())?;
        let config = Self {
            listen_addr,
            bridge_url: raw.bridge_url,
            bridge_shared_secret_file: raw.bridge_shared_secret_file,
            gateway_shared_secret_file: raw.gateway_shared_secret_file,
            matrix_user_id: raw.matrix_user_id,
            gateway_route_id: raw.gateway_route_id,
            bridge_instance_id: raw.bridge_instance_id,
            matrix_room_namespace: raw.matrix_room_namespace,
        };
        config.validate()?;
        Ok(config)
    }

    fn validate(&self) -> Result<(), ConfigError> {
        if self.listen_addr.port() == 0 {
            return Err(ConfigError::invalid());
        }
        validate_https_root_endpoint(&self.bridge_url)?;
        validate_path(&self.bridge_shared_secret_file)?;
        validate_path(&self.gateway_shared_secret_file)?;
        validate_matrix_user_id(&self.matrix_user_id)?;
        validate_text(&self.gateway_route_id)?;
        validate_text(&self.bridge_instance_id)?;
        validate_text(&self.matrix_room_namespace)?;
        Ok(())
    }

    /// Return the private listener address.
    pub const fn listen_addr(&self) -> SocketAddr {
        self.listen_addr
    }

    /// Return the pinned bridge HTTPS root URL.
    pub fn bridge_url(&self) -> &str {
        &self.bridge_url
    }

    /// Return the protected bridge shared-secret path.
    pub fn bridge_shared_secret_file(&self) -> &Path {
        &self.bridge_shared_secret_file
    }

    /// Return the protected Worker-to-gateway shared-secret path.
    pub fn gateway_shared_secret_file(&self) -> &Path {
        &self.gateway_shared_secret_file
    }

    /// Return the Matrix provisioning service user ID.
    pub fn matrix_user_id(&self) -> &str {
        &self.matrix_user_id
    }

    /// Return the configured route identity.
    pub fn gateway_route_id(&self) -> &str {
        &self.gateway_route_id
    }

    /// Return the configured bridge instance label.
    pub fn bridge_instance_id(&self) -> &str {
        &self.bridge_instance_id
    }

    /// Return the configured Matrix room namespace.
    pub fn matrix_room_namespace(&self) -> &str {
        &self.matrix_room_namespace
    }
}

/// Fixed backpressure and retention limits exposed for service consumers.
#[derive(Clone, Copy, PartialEq, Eq)]
pub struct GatewayLimits {
    max_pending_request_rows: u64,
    max_recovery_bytes: u64,
    max_pending_age_secs: u64,
    accepted_retention_secs: u64,
}

impl GatewayLimits {
    /// Return the maximum number of pending request rows.
    pub const fn max_pending_request_rows(self) -> u64 {
        self.max_pending_request_rows
    }

    /// Return the maximum encrypted recovery/inbox bytes.
    pub const fn max_recovery_bytes(self) -> u64 {
        self.max_recovery_bytes
    }

    /// Return the maximum age of a pending request.
    pub const fn max_pending_age_secs(self) -> u64 {
        self.max_pending_age_secs
    }

    /// Return the accepted-batch retention period.
    pub const fn accepted_retention_secs(self) -> u64 {
        self.accepted_retention_secs
    }
}

fn invalid() -> ConfigError {
    ConfigError::invalid()
}

fn validate_text(value: &str) -> Result<(), ConfigError> {
    if value.is_empty()
        || value.len() > MAX_CONFIG_FIELD_BYTES
        || value.trim() != value
        || value
            .chars()
            .any(|character| character == '\0' || character.is_control())
    {
        return Err(invalid());
    }
    Ok(())
}

fn validate_path(path: &Path) -> Result<(), ConfigError> {
    if !path.is_absolute()
        || path
            .components()
            .any(|component| component == Component::ParentDir)
    {
        return Err(invalid());
    }

    let value = path.to_string_lossy();
    validate_text(&value)
}

fn parse_absolute_uri(value: &str) -> Result<Uri, ConfigError> {
    validate_text(value)?;
    if value.contains('#') {
        return Err(invalid());
    }

    let uri = value.parse::<Uri>().map_err(|_| invalid())?;
    if uri.scheme_str().is_none() || uri.authority().is_none() || uri.host().is_none() {
        return Err(invalid());
    }
    if uri
        .authority()
        .is_some_and(|authority| authority.as_str().contains('@'))
    {
        return Err(invalid());
    }
    Ok(uri)
}

fn validate_https_endpoint(value: &str) -> Result<(), ConfigError> {
    let uri = parse_absolute_uri(value)?;
    if uri.scheme_str() != Some("https") {
        return Err(invalid());
    }
    if uri.query().is_some() {
        return Err(invalid());
    }
    Ok(())
}

fn validate_https_root_endpoint(value: &str) -> Result<(), ConfigError> {
    validate_https_endpoint(value)?;
    let uri = parse_absolute_uri(value)?;
    if uri.path() != "" && uri.path() != "/" {
        return Err(invalid());
    }
    Ok(())
}

fn validate_internal_homeserver(value: &str) -> Result<(), ConfigError> {
    let uri = parse_absolute_uri(value)?;
    if uri.scheme_str() != Some("http")
        || uri.host() != Some("synapse")
        || uri.port_u16() != Some(8008)
        || (uri.path() != "" && uri.path() != "/")
        || uri.query().is_some()
    {
        return Err(invalid());
    }
    Ok(())
}

fn validate_matrix_user_id(value: &str) -> Result<(), ConfigError> {
    validate_text(value)?;
    if ruma::UserId::parse(value).is_err() {
        return Err(invalid());
    }
    Ok(())
}
