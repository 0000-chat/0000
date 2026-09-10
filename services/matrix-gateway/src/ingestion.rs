//! OAuth-backed, byte-exact delivery of encrypted ingestion batches.
//!
//! The ingestion outbox owns the bytes sent through this module.  This client
//! deliberately does not deserialize or rebuild a pending request before a
//! retry, and its externally visible errors never retain upstream values.

use std::{
    error::Error,
    fmt,
    net::IpAddr,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

use async_trait::async_trait;
use futures_util::StreamExt;
use reqwest::{
    StatusCode, Url,
    header::{ACCEPT, AUTHORIZATION, CONTENT_ENCODING, CONTENT_TYPE},
    redirect::Policy,
};
use serde::Deserialize;
use zeroize::Zeroize;

use crate::{config::OAuthClientAuthMethod, secret::SafeError};

/// Maximum number of bytes retained from either an OAuth or ingestion body.
pub const MAX_RESPONSE_BYTES: usize = 64 * 1024;

const INGESTION_PATH: &str = "/internal/v1/ingestion/batches";
const OAUTH_INVALID_URL: &str = "oauth_invalid_url";
const OAUTH_INVALID_REQUEST: &str = "oauth_invalid_request";
const OAUTH_REQUEST_FAILED: &str = "oauth_request_failed";
const OAUTH_RESPONSE_INVALID: &str = "oauth_response_invalid";
const OAUTH_RESPONSE_TOO_LARGE: &str = "oauth_response_too_large";
const OAUTH_TOKEN_INVALID: &str = "oauth_token_invalid";
const INGESTION_INVALID_URL: &str = "ingestion_invalid_url";
const INGESTION_CLIENT_INVALID: &str = "ingestion_client_invalid";
const INGESTION_TOKEN_FAILED: &str = "ingestion_token_failed";
const INGESTION_REQUEST_FAILED: &str = "ingestion_request_failed";
const INGESTION_RESPONSE_INVALID: &str = "ingestion_response_invalid";
const INGESTION_RESPONSE_TOO_LARGE: &str = "ingestion_response_too_large";
const INGESTION_UNAUTHORIZED: &str = "ingestion_unauthorized";
const INGESTION_RATE_LIMITED: &str = "ingestion_rate_limited";
const INGESTION_SERVER_FAILED: &str = "ingestion_server_failed";

/// A secret string whose formatting surface is always redacted.
pub struct SecretString {
    value: String,
}

impl SecretString {
    /// Store a string as a secret value.
    pub fn new(value: impl Into<String>) -> Self {
        Self {
            value: value.into(),
        }
    }

    /// Borrow the secret for one explicitly scoped protocol operation.
    pub fn as_str(&self) -> &str {
        &self.value
    }

    /// Return whether the secret has no bytes.
    pub fn is_empty(&self) -> bool {
        self.value.is_empty()
    }
}

impl Clone for SecretString {
    fn clone(&self) -> Self {
        Self::new(self.value.clone())
    }
}

impl fmt::Debug for SecretString {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("[REDACTED]")
    }
}

impl fmt::Display for SecretString {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("[REDACTED]")
    }
}

impl Drop for SecretString {
    fn drop(&mut self) {
        self.value.zeroize();
    }
}

/// The exact bytes and immutable identity of one outbox entry.
#[derive(Clone, Eq, PartialEq)]
pub struct PendingBatch {
    tenant_id: String,
    batch_id: String,
    request_bytes: Vec<u8>,
}

impl PendingBatch {
    /// Construct a pending batch without parsing or normalizing its bytes.
    pub fn new(
        tenant_id: impl Into<String>,
        batch_id: impl Into<String>,
        request_bytes: Vec<u8>,
    ) -> Self {
        Self {
            tenant_id: tenant_id.into(),
            batch_id: batch_id.into(),
            request_bytes,
        }
    }

    /// Return the immutable tenant identity.
    pub fn tenant_id(&self) -> &str {
        &self.tenant_id
    }

    /// Return the immutable batch identity.
    pub fn batch_id(&self) -> &str {
        &self.batch_id
    }

    /// Return the exact outbox bytes that must be sent on every attempt.
    pub fn exact_request_bytes(&self) -> &[u8] {
        &self.request_bytes
    }
}

impl fmt::Debug for PendingBatch {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("PendingBatch([REDACTED])")
    }
}

/// The result of a successfully acknowledged ingestion request.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Delivery {
    /// The upstream created or had already committed the batch.
    Accepted,
}

/// The operational class assigned to a delivery failure.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum DeliveryErrorClass {
    /// The batch or response is invalid and should not be retried.
    Terminal,
    /// Delivery should pause until authentication or upstream state changes.
    Paused,
    /// Delivery may be attempted again according to the outbox policy.
    Retryable,
}

/// A redacted delivery failure with a stable code and operational class.
#[derive(Clone, Copy, Eq, PartialEq)]
pub struct DeliveryError {
    class: DeliveryErrorClass,
    code: &'static str,
    retry_after: Option<Duration>,
}

impl DeliveryError {
    fn new(class: DeliveryErrorClass, code: &'static str) -> Self {
        Self {
            class,
            code,
            retry_after: None,
        }
    }

    fn with_retry_after(
        class: DeliveryErrorClass,
        code: &'static str,
        retry_after: Option<Duration>,
    ) -> Self {
        Self {
            class,
            code,
            retry_after,
        }
    }

    /// Return the operational class of this failure.
    pub const fn class(&self) -> DeliveryErrorClass {
        self.class
    }

    /// Return the bounded delay supplied by the upstream, when present.
    pub const fn retry_after(&self) -> Option<Duration> {
        self.retry_after
    }

    /// Return the stable machine-readable failure code.
    pub const fn code(&self) -> &'static str {
        self.code
    }
}

impl fmt::Debug for DeliveryError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("DeliveryError")
            .field("class", &self.class)
            .field("code", &self.code)
            .field("retry_after", &self.retry_after)
            .finish()
    }
}

impl fmt::Display for DeliveryError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.code)
    }
}

impl Error for DeliveryError {}

/// Bounded retry and backoff settings for one delivery operation.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct RetryPolicy {
    /// Maximum number of HTTP attempts, including the initial attempt.
    pub max_attempts: usize,
    /// Delay before the first retry when no Retry-After is supplied.
    pub base_delay: Duration,
    /// Maximum calculated exponential-backoff delay.
    pub max_delay: Duration,
    /// Maximum delay accepted from Retry-After.
    pub max_retry_after: Duration,
}

impl Default for RetryPolicy {
    fn default() -> Self {
        Self {
            max_attempts: 3,
            base_delay: Duration::from_millis(100),
            max_delay: Duration::from_secs(5),
            max_retry_after: Duration::from_secs(30),
        }
    }
}

/// A source of short-lived OAuth bearer tokens.
#[async_trait]
pub trait TokenProvider: Send + Sync {
    /// Return a cached token or force one fresh token request.
    async fn bearer(&self, force_refresh: bool) -> Result<SecretString, SafeError>;
}

/// A sink for immutable pending batches.
#[async_trait]
pub trait BatchSink: Send + Sync {
    /// Deliver one batch and classify any failure without retaining payloads.
    async fn deliver(&self, batch: &PendingBatch) -> Result<Delivery, DeliveryError>;
}

struct CachedToken {
    token: SecretString,
    expires_at: Instant,
}

/// OAuth 2.0 client-credentials token provider with an in-memory cache.
pub struct OAuthTokenProvider {
    token_url: Url,
    client_id: String,
    client_secret: SecretString,
    auth_method: OAuthClientAuthMethod,
    client: reqwest::Client,
    refresh_skew: Duration,
    cache: Mutex<Option<CachedToken>>,
}

impl OAuthTokenProvider {
    /// Construct a production token provider.  Production OAuth URLs must use
    /// HTTPS.
    pub fn new(
        token_url: impl AsRef<str>,
        client_id: impl Into<String>,
        client_secret: SecretString,
        auth_method: OAuthClientAuthMethod,
        request_timeout: Duration,
        refresh_skew: Duration,
    ) -> Result<Self, SafeError> {
        Self::build(
            token_url.as_ref(),
            client_id.into(),
            client_secret,
            auth_method,
            request_timeout,
            refresh_skew,
            false,
        )
    }

    /// Construct a provider for an explicit loopback test endpoint.  This is
    /// the only constructor that permits HTTP.
    pub fn new_for_test(
        token_url: impl AsRef<str>,
        client_id: impl Into<String>,
        client_secret: SecretString,
        auth_method: OAuthClientAuthMethod,
        request_timeout: Duration,
        refresh_skew: Duration,
    ) -> Result<Self, SafeError> {
        Self::build(
            token_url.as_ref(),
            client_id.into(),
            client_secret,
            auth_method,
            request_timeout,
            refresh_skew,
            true,
        )
    }

    fn build(
        token_url: &str,
        client_id: String,
        client_secret: SecretString,
        auth_method: OAuthClientAuthMethod,
        request_timeout: Duration,
        refresh_skew: Duration,
        allow_test_http: bool,
    ) -> Result<Self, SafeError> {
        if client_id.is_empty() || client_secret.is_empty() || request_timeout.is_zero() {
            return Err(SafeError::new(OAUTH_INVALID_REQUEST));
        }
        let token_url = validate_url(token_url, allow_test_http, OAUTH_INVALID_URL)?;
        let client = build_http_client(request_timeout)
            .map_err(|_| SafeError::new(OAUTH_INVALID_REQUEST))?;
        Ok(Self {
            token_url,
            client_id,
            client_secret,
            auth_method,
            client,
            refresh_skew,
            cache: Mutex::new(None),
        })
    }

    async fn fetch_token(&self) -> Result<(SecretString, Duration), SafeError> {
        let request = self
            .client
            .post(self.token_url.clone())
            .header(ACCEPT, "application/json")
            .header(CONTENT_TYPE, "application/x-www-form-urlencoded");
        let request = match self.auth_method {
            OAuthClientAuthMethod::Basic => request
                .basic_auth(self.client_id.as_str(), Some(self.client_secret.as_str()))
                .body(form_encode(&[("grant_type", "client_credentials")])),
            OAuthClientAuthMethod::Post => request.body(form_encode(&[
                ("grant_type", "client_credentials"),
                ("client_id", self.client_id.as_str()),
                ("client_secret", self.client_secret.as_str()),
            ])),
        };

        let response = request
            .send()
            .await
            .map_err(|_| SafeError::new(OAUTH_REQUEST_FAILED))?;
        if !response.status().is_success() {
            return Err(SafeError::new(OAUTH_RESPONSE_INVALID));
        }
        if !has_json_content_type(&response) {
            return Err(SafeError::new(OAUTH_RESPONSE_INVALID));
        }
        let body = read_response_body(response)
            .await
            .map_err(|error| match error {
                BodyReadError::TooLarge => SafeError::new(OAUTH_RESPONSE_TOO_LARGE),
                BodyReadError::Failed => SafeError::new(OAUTH_REQUEST_FAILED),
            })?;
        let parsed = serde_json::from_slice::<OAuthResponse>(&body)
            .map_err(|_| SafeError::new(OAUTH_RESPONSE_INVALID))?;
        if !parsed.token_type.eq_ignore_ascii_case("bearer")
            || parsed.access_token.is_empty()
            || parsed.expires_in == 0
        {
            return Err(SafeError::new(OAUTH_TOKEN_INVALID));
        }
        let lifetime = Duration::from_secs(parsed.expires_in);
        Ok((SecretString::new(parsed.access_token), lifetime))
    }
}

impl fmt::Debug for OAuthTokenProvider {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("OAuthTokenProvider([REDACTED])")
    }
}

#[async_trait]
impl TokenProvider for OAuthTokenProvider {
    async fn bearer(&self, force_refresh: bool) -> Result<SecretString, SafeError> {
        if !force_refresh {
            let now = Instant::now();
            if let Some(cached) = self
                .cache
                .lock()
                .expect("OAuth token cache lock poisoned")
                .as_ref()
                && now
                    .checked_add(self.refresh_skew)
                    .is_some_and(|refresh_deadline| cached.expires_at > refresh_deadline)
            {
                return Ok(cached.token.clone());
            }
        }

        let (token, lifetime) = self.fetch_token().await?;
        let expires_at = Instant::now()
            .checked_add(lifetime)
            .ok_or_else(|| SafeError::new(OAUTH_TOKEN_INVALID))?;
        *self.cache.lock().expect("OAuth token cache lock poisoned") = Some(CachedToken {
            token: token.clone(),
            expires_at,
        });
        Ok(token)
    }
}

/// Client for the fixed internal ingestion endpoint.
pub struct IngestionClient {
    endpoint: Url,
    client: reqwest::Client,
    token_provider: Arc<dyn TokenProvider>,
    retry_policy: RetryPolicy,
}

impl IngestionClient {
    /// Construct a production client.  The base URL must use HTTPS.
    pub fn new(
        base_url: impl AsRef<str>,
        token_provider: Arc<dyn TokenProvider>,
        request_timeout: Duration,
    ) -> Result<Self, DeliveryError> {
        Self::build(base_url.as_ref(), token_provider, request_timeout, false)
    }

    /// Construct a client for an explicit loopback test endpoint.
    pub fn new_for_test(
        base_url: impl AsRef<str>,
        token_provider: Arc<dyn TokenProvider>,
        request_timeout: Duration,
    ) -> Result<Self, DeliveryError> {
        Self::build(base_url.as_ref(), token_provider, request_timeout, true)
    }

    fn build(
        base_url: &str,
        token_provider: Arc<dyn TokenProvider>,
        request_timeout: Duration,
        allow_test_http: bool,
    ) -> Result<Self, DeliveryError> {
        if request_timeout.is_zero() {
            return Err(DeliveryError::new(
                DeliveryErrorClass::Terminal,
                INGESTION_CLIENT_INVALID,
            ));
        }
        let base_url = validate_url(base_url, allow_test_http, INGESTION_INVALID_URL)
            .map_err(|_| DeliveryError::new(DeliveryErrorClass::Terminal, INGESTION_INVALID_URL))?;
        let endpoint = base_url
            .join(INGESTION_PATH)
            .map_err(|_| DeliveryError::new(DeliveryErrorClass::Terminal, INGESTION_INVALID_URL))?;
        let client = build_http_client(request_timeout).map_err(|_| {
            DeliveryError::new(DeliveryErrorClass::Terminal, INGESTION_CLIENT_INVALID)
        })?;
        Ok(Self {
            endpoint,
            client,
            token_provider,
            retry_policy: RetryPolicy::default(),
        })
    }

    /// Replace the retry policy for subsequent deliveries.
    pub fn with_retry_policy(mut self, retry_policy: RetryPolicy) -> Self {
        self.retry_policy = retry_policy;
        self
    }

    /// Deliver one pending batch using its exact stored bytes on every try.
    async fn deliver_inner(&self, batch: &PendingBatch) -> Result<Delivery, DeliveryError> {
        let max_attempts = self.retry_policy.max_attempts.max(1);
        let mut attempt = 0_usize;
        let mut forced_refresh_used = false;
        let mut force_refresh = false;
        let mut token = None;

        loop {
            if token.is_none() || force_refresh {
                token = Some(
                    self.token_provider
                        .bearer(force_refresh)
                        .await
                        .map_err(|_| {
                            DeliveryError::new(DeliveryErrorClass::Paused, INGESTION_TOKEN_FAILED)
                        })?,
                );
                force_refresh = false;
            }
            attempt = attempt.saturating_add(1);

            let response = match self
                .send_once(batch, token.as_ref().expect("token populated"))
                .await
            {
                Ok(response) => response,
                Err(()) => {
                    if attempt < max_attempts {
                        sleep_for(Some(retry_delay(&self.retry_policy, attempt))).await;
                        continue;
                    }
                    return Err(DeliveryError::new(
                        DeliveryErrorClass::Retryable,
                        INGESTION_REQUEST_FAILED,
                    ));
                }
            };

            let status = response.status();
            if status == StatusCode::UNAUTHORIZED {
                drop(response);
                if !forced_refresh_used && attempt < max_attempts {
                    forced_refresh_used = true;
                    token = None;
                    force_refresh = true;
                    continue;
                }
                return Err(DeliveryError::new(
                    DeliveryErrorClass::Paused,
                    INGESTION_UNAUTHORIZED,
                ));
            }

            if status == StatusCode::ACCEPTED {
                return parse_accepted_response(response, batch).await;
            }

            if status == StatusCode::TOO_MANY_REQUESTS {
                let retry_after = bounded_retry_after(
                    response.headers().get("retry-after"),
                    self.retry_policy.max_retry_after,
                );
                drop(response);
                if attempt < max_attempts {
                    sleep_for(
                        retry_after.or_else(|| Some(retry_delay(&self.retry_policy, attempt))),
                    )
                    .await;
                    continue;
                }
                return Err(DeliveryError::with_retry_after(
                    DeliveryErrorClass::Retryable,
                    INGESTION_RATE_LIMITED,
                    retry_after,
                ));
            }

            if is_retryable_status(status) {
                drop(response);
                if attempt < max_attempts {
                    sleep_for(Some(retry_delay(&self.retry_policy, attempt))).await;
                    continue;
                }
                return Err(DeliveryError::new(
                    DeliveryErrorClass::Retryable,
                    INGESTION_SERVER_FAILED,
                ));
            }

            drop(response);
            return Err(DeliveryError::new(
                DeliveryErrorClass::Terminal,
                INGESTION_RESPONSE_INVALID,
            ));
        }
    }

    async fn send_once(
        &self,
        batch: &PendingBatch,
        token: &SecretString,
    ) -> Result<reqwest::Response, ()> {
        self.client
            .post(self.endpoint.clone())
            .header(ACCEPT, "application/json")
            .header(AUTHORIZATION, format!("Bearer {}", token.as_str()))
            .header(CONTENT_TYPE, "application/x-ndjson")
            .header(CONTENT_ENCODING, "identity")
            .header("x-tenant-id", batch.tenant_id())
            .header("x-batch-id", batch.batch_id())
            .body(batch.exact_request_bytes().to_vec())
            .send()
            .await
            .map_err(|_| ())
    }
}

impl fmt::Debug for IngestionClient {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("IngestionClient([REDACTED])")
    }
}

#[async_trait]
impl BatchSink for IngestionClient {
    async fn deliver(&self, batch: &PendingBatch) -> Result<Delivery, DeliveryError> {
        self.deliver_inner(batch).await
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct OAuthResponse {
    access_token: String,
    token_type: String,
    expires_in: u64,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct AcceptedResponse {
    schema_version: u64,
    tenant_id: String,
    batch_id: String,
    status: String,
    archive_status: String,
}

async fn parse_accepted_response(
    response: reqwest::Response,
    batch: &PendingBatch,
) -> Result<Delivery, DeliveryError> {
    if !has_json_content_type(&response) {
        return Err(DeliveryError::new(
            DeliveryErrorClass::Terminal,
            INGESTION_RESPONSE_INVALID,
        ));
    }
    let body = read_response_body(response).await.map_err(|error| {
        DeliveryError::new(
            DeliveryErrorClass::Terminal,
            match error {
                BodyReadError::TooLarge => INGESTION_RESPONSE_TOO_LARGE,
                BodyReadError::Failed => INGESTION_RESPONSE_INVALID,
            },
        )
    })?;
    let accepted = serde_json::from_slice::<AcceptedResponse>(&body).map_err(|_| {
        DeliveryError::new(DeliveryErrorClass::Terminal, INGESTION_RESPONSE_INVALID)
    })?;
    if accepted.schema_version != 1
        || accepted.tenant_id != batch.tenant_id()
        || accepted.batch_id != batch.batch_id()
        || accepted.status != "accepted"
        || !matches!(
            accepted.archive_status.as_str(),
            "created" | "already_committed"
        )
    {
        return Err(DeliveryError::new(
            DeliveryErrorClass::Terminal,
            INGESTION_RESPONSE_INVALID,
        ));
    }
    Ok(Delivery::Accepted)
}

enum BodyReadError {
    TooLarge,
    Failed,
}

async fn read_response_body(response: reqwest::Response) -> Result<Vec<u8>, BodyReadError> {
    if response
        .content_length()
        .is_some_and(|length| length > MAX_RESPONSE_BYTES as u64)
    {
        return Err(BodyReadError::TooLarge);
    }

    let mut stream = response.bytes_stream();
    let mut body = Vec::new();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|_| BodyReadError::Failed)?;
        if body.len().saturating_add(chunk.len()) > MAX_RESPONSE_BYTES {
            return Err(BodyReadError::TooLarge);
        }
        body.extend_from_slice(&chunk);
    }
    Ok(body)
}

fn has_json_content_type(response: &reqwest::Response) -> bool {
    response
        .headers()
        .get_all(CONTENT_TYPE)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .filter_map(|value| value.split(';').next())
        .any(|value| value.trim().eq_ignore_ascii_case("application/json"))
}

fn build_http_client(timeout: Duration) -> Result<reqwest::Client, reqwest::Error> {
    reqwest::Client::builder()
        .redirect(Policy::none())
        .timeout(timeout)
        .build()
}

fn validate_url(
    value: &str,
    allow_test_http: bool,
    error_code: &'static str,
) -> Result<Url, SafeError> {
    let url = Url::parse(value).map_err(|_| SafeError::new(error_code))?;
    let valid_scheme = match url.scheme() {
        "https" => true,
        "http" => allow_test_http && is_loopback_url(&url),
        _ => false,
    };
    if !valid_scheme
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(SafeError::new(error_code));
    }
    Ok(url)
}

fn is_loopback_url(url: &Url) -> bool {
    url.host_str().is_some_and(|host| {
        host.eq_ignore_ascii_case("localhost")
            || host
                .parse::<IpAddr>()
                .is_ok_and(|address| address.is_loopback())
    })
}

fn form_encode(fields: &[(&str, &str)]) -> String {
    let mut encoded = String::new();
    for (index, (name, value)) in fields.iter().enumerate() {
        if index != 0 {
            encoded.push('&');
        }
        form_encode_component(name, &mut encoded);
        encoded.push('=');
        form_encode_component(value, &mut encoded);
    }
    encoded
}

fn form_encode_component(value: &str, output: &mut String) {
    const HEX: &[u8; 16] = b"0123456789ABCDEF";
    for byte in value.as_bytes() {
        match *byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => {
                output.push(*byte as char)
            }
            b' ' => output.push('+'),
            byte => {
                output.push('%');
                output.push(HEX[(byte >> 4) as usize] as char);
                output.push(HEX[(byte & 0x0f) as usize] as char);
            }
        }
    }
}

fn is_retryable_status(status: StatusCode) -> bool {
    status == StatusCode::REQUEST_TIMEOUT
        || status == StatusCode::TOO_EARLY
        || status.is_server_error()
}

fn retry_delay(policy: &RetryPolicy, attempt: usize) -> Duration {
    if policy.base_delay.is_zero() || policy.max_delay.is_zero() {
        return Duration::ZERO;
    }
    let exponent = attempt.saturating_sub(1).min(31) as u32;
    let multiplier = 1_u32.checked_shl(exponent).unwrap_or(u32::MAX);
    policy
        .base_delay
        .checked_mul(multiplier)
        .unwrap_or(policy.max_delay)
        .min(policy.max_delay)
}

fn bounded_retry_after(
    value: Option<&reqwest::header::HeaderValue>,
    maximum: Duration,
) -> Option<Duration> {
    let value = value?.to_str().ok()?.trim().parse::<u64>().ok()?;
    if value > maximum.as_secs() {
        return Some(maximum);
    }
    Some(Duration::from_secs(value).min(maximum))
}

async fn sleep_for(delay: Option<Duration>) {
    if let Some(delay) = delay.filter(|delay| !delay.is_zero()) {
        tokio::time::sleep(delay).await;
    }
}
