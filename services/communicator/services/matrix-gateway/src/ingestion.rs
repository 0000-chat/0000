//! Byte-exact delivery of encrypted ingestion batches with a provisioned
//! service credential.
//!
//! The ingestion outbox owns the bytes sent through this module.  This client
//! deliberately does not deserialize or rebuild a pending request before a
//! retry, and its externally visible errors never retain upstream values.

use std::{error::Error, fmt, net::IpAddr, sync::Arc, time::Duration};

use async_trait::async_trait;
use futures_util::StreamExt;
use rand_core::{OsRng, RngCore};
use reqwest::{
    StatusCode, Url,
    header::{ACCEPT, CONTENT_ENCODING, CONTENT_TYPE},
    redirect::Policy,
};
use serde::Deserialize;
use zeroize::{Zeroize, Zeroizing};

use crate::secret::SafeError;

/// Maximum number of bytes retained from an ingestion response body.
pub const MAX_RESPONSE_BYTES: usize = 64 * 1024;

const INGESTION_PATH: &str = "/internal/v1/ingestion/batches";
const INGESTION_INVALID_URL: &str = "ingestion_invalid_url";
const INGESTION_CLIENT_INVALID: &str = "ingestion_client_invalid";
const INGESTION_CREDENTIAL_INVALID: &str = "ingestion_credential_invalid";
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
    /// Maximum random jitter added to calculated backoff.
    pub jitter: Duration,
    /// Maximum delay accepted from Retry-After.
    pub max_retry_after: Duration,
}

impl Default for RetryPolicy {
    fn default() -> Self {
        Self {
            max_attempts: 3,
            base_delay: Duration::from_millis(100),
            max_delay: Duration::from_secs(5),
            jitter: Duration::from_millis(100),
            max_retry_after: Duration::from_secs(30),
        }
    }
}

/// A sink for immutable pending batches.
#[async_trait]
pub trait BatchSink: Send + Sync {
    /// Deliver one batch and classify any failure without retaining payloads.
    async fn deliver(&self, batch: &PendingBatch) -> Result<Delivery, DeliveryError>;
}

/// A fixed source of one provisioned bearer credential.
///
/// The source has no acquisition, refresh, or introspection operation. The
/// gateway process reads its protected credential file once at startup and a
/// restart is required to pick up a rotated value. The trait remains a small
/// injection seam for caller tests that need to observe the HTTP boundary.
pub trait CredentialSource: Send + Sync {
    /// Return the opaque credential to attach to the current request.
    fn bearer(&self) -> &SecretString;
}

/// The production credential source backed by the startup-loaded value.
pub struct FixedCredentialSource {
    credential: SecretString,
}

impl FixedCredentialSource {
    /// Store one finite service credential for the lifetime of a process.
    pub fn new(credential: SecretString) -> Self {
        Self { credential }
    }
}

impl CredentialSource for FixedCredentialSource {
    fn bearer(&self) -> &SecretString {
        &self.credential
    }
}

impl fmt::Debug for FixedCredentialSource {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("FixedCredentialSource([REDACTED])")
    }
}

/// Client for the fixed internal ingestion endpoint.
pub struct IngestionClient {
    endpoint: Url,
    client: reqwest::Client,
    credential_source: Arc<dyn CredentialSource>,
    retry_policy: RetryPolicy,
}

impl IngestionClient {
    /// Construct a production client.  The base URL must use HTTPS.
    pub fn new(
        base_url: impl AsRef<str>,
        credential: SecretString,
        request_timeout: Duration,
    ) -> Result<Self, DeliveryError> {
        if credential.is_empty() {
            return Err(DeliveryError::new(
                DeliveryErrorClass::Terminal,
                INGESTION_CREDENTIAL_INVALID,
            ));
        }
        Self::build(
            base_url.as_ref(),
            Arc::new(FixedCredentialSource::new(credential)),
            request_timeout,
            false,
        )
    }

    /// Construct a client for an explicit loopback test endpoint.
    pub fn new_for_test(
        base_url: impl AsRef<str>,
        credential: SecretString,
        request_timeout: Duration,
    ) -> Result<Self, DeliveryError> {
        if credential.is_empty() {
            return Err(DeliveryError::new(
                DeliveryErrorClass::Terminal,
                INGESTION_CREDENTIAL_INVALID,
            ));
        }
        Self::build(
            base_url.as_ref(),
            Arc::new(FixedCredentialSource::new(credential)),
            request_timeout,
            true,
        )
    }

    /// Construct a loopback-only client with an explicitly injected fixed
    /// credential source for controlled caller tests.
    pub fn new_with_credential_source_for_test(
        base_url: impl AsRef<str>,
        credential_source: Arc<dyn CredentialSource>,
        request_timeout: Duration,
    ) -> Result<Self, DeliveryError> {
        Self::build(base_url.as_ref(), credential_source, request_timeout, true)
    }

    fn build(
        base_url: &str,
        credential_source: Arc<dyn CredentialSource>,
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
            credential_source,
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
        let token = self.credential_source.bearer();

        loop {
            attempt = attempt.saturating_add(1);

            let response = match self.send_once(batch, token).await {
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
                return Err(DeliveryError::new(
                    DeliveryErrorClass::Paused,
                    INGESTION_UNAUTHORIZED,
                ));
            }

            if status == StatusCode::ACCEPTED {
                match parse_accepted_response(response, batch).await {
                    Ok(delivery) => return Ok(delivery),
                    Err(error) if error.class() == DeliveryErrorClass::Retryable => {
                        if attempt < max_attempts {
                            sleep_for(Some(retry_delay(&self.retry_policy, attempt))).await;
                            continue;
                        }
                        return Err(error);
                    }
                    Err(error) => return Err(error),
                }
            }

            if is_retryable_status(status) {
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
                let code = if status == StatusCode::TOO_MANY_REQUESTS {
                    INGESTION_RATE_LIMITED
                } else {
                    INGESTION_SERVER_FAILED
                };
                return Err(DeliveryError::with_retry_after(
                    DeliveryErrorClass::Retryable,
                    code,
                    retry_after,
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
        build_ingestion_request(&self.client, &self.endpoint, batch, token)
            .send()
            .await
            .map_err(|_| ())
    }
}

fn build_ingestion_request(
    client: &reqwest::Client,
    endpoint: &Url,
    batch: &PendingBatch,
    token: &SecretString,
) -> reqwest::RequestBuilder {
    client
        .post(endpoint.clone())
        .header(ACCEPT, "application/json")
        .bearer_auth(token.as_str())
        .header(CONTENT_TYPE, "application/json")
        .header(CONTENT_ENCODING, "identity")
        .header("x-tenant-id", batch.tenant_id())
        .header("x-batch-id", batch.batch_id())
        .body(batch.exact_request_bytes().to_vec())
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
            match error {
                BodyReadError::TooLarge => DeliveryErrorClass::Terminal,
                BodyReadError::Failed => DeliveryErrorClass::Retryable,
            },
            match error {
                BodyReadError::TooLarge => INGESTION_RESPONSE_TOO_LARGE,
                BodyReadError::Failed => INGESTION_REQUEST_FAILED,
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

#[derive(Clone, Copy, Debug)]
enum BodyReadError {
    TooLarge,
    Failed,
}

async fn read_response_body(
    response: reqwest::Response,
) -> Result<Zeroizing<Vec<u8>>, BodyReadError> {
    if response
        .content_length()
        .is_some_and(|length| length > MAX_RESPONSE_BYTES as u64)
    {
        return Err(BodyReadError::TooLarge);
    }

    let mut stream = response.bytes_stream();
    let mut body = Zeroizing::new(Vec::with_capacity(MAX_RESPONSE_BYTES));
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

fn is_retryable_status(status: StatusCode) -> bool {
    status == StatusCode::REQUEST_TIMEOUT
        || status == StatusCode::TOO_EARLY
        || status == StatusCode::TOO_MANY_REQUESTS
        || status.is_server_error()
}

fn retry_delay(policy: &RetryPolicy, attempt: usize) -> Duration {
    if policy.base_delay.is_zero() || policy.max_delay.is_zero() {
        return Duration::ZERO;
    }
    let exponent = attempt.saturating_sub(1).min(31) as u32;
    let multiplier = 1_u32.checked_shl(exponent).unwrap_or(u32::MAX);
    let exponential = policy
        .base_delay
        .checked_mul(multiplier)
        .unwrap_or(policy.max_delay)
        .min(policy.max_delay);
    exponential
        .saturating_add(random_jitter(policy.jitter))
        .min(policy.max_delay)
}

fn random_jitter(maximum: Duration) -> Duration {
    if maximum.is_zero() {
        return Duration::ZERO;
    }
    let maximum_nanos = u64::try_from(maximum.as_nanos()).unwrap_or(u64::MAX);
    if maximum_nanos == 0 {
        return Duration::ZERO;
    }
    let mut random_bytes = [0_u8; 8];
    if OsRng.try_fill_bytes(&mut random_bytes).is_err() {
        return Duration::ZERO;
    }
    let range = maximum_nanos.saturating_add(1);
    Duration::from_nanos(u64::from_le_bytes(random_bytes) % range)
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

#[cfg(test)]
mod tests {
    use super::*;
    use reqwest::header::AUTHORIZATION;

    #[test]
    fn ingestion_request_marks_bearer_authorization_sensitive() {
        let client = reqwest::Client::new();
        let endpoint = Url::parse("http://127.0.0.1:8080/internal/v1/ingestion/batches")
            .expect("test endpoint");
        let batch = PendingBatch::new("tenant", "batch", b"{}".to_vec());
        let token = SecretString::new("token");

        let request = build_ingestion_request(&client, &endpoint, &batch, &token)
            .build()
            .expect("build ingestion request");
        let authorization = request
            .headers()
            .get(AUTHORIZATION)
            .expect("authorization header");

        assert_eq!(authorization, "Bearer token");
        assert!(authorization.is_sensitive());
    }

    #[tokio::test]
    async fn bounded_response_body_uses_zeroizing_storage() {
        let server = wiremock::MockServer::start().await;
        wiremock::Mock::given(wiremock::matchers::method("GET"))
            .respond_with(
                wiremock::ResponseTemplate::new(200)
                    .set_body_raw("response-body", "application/octet-stream"),
            )
            .mount(&server)
            .await;

        let response = reqwest::Client::new()
            .get(server.uri())
            .send()
            .await
            .expect("response");
        let body: Zeroizing<Vec<u8>> = read_response_body(response).await.expect("body");

        assert_eq!(body.as_slice(), b"response-body");
    }

    #[tokio::test]
    async fn response_body_starts_with_capacity_for_full_bound() {
        let server = wiremock::MockServer::start().await;
        wiremock::Mock::given(wiremock::matchers::method("GET"))
            .respond_with(wiremock::ResponseTemplate::new(200).set_body_bytes(Vec::new()))
            .mount(&server)
            .await;

        let response = reqwest::Client::new()
            .get(server.uri())
            .send()
            .await
            .expect("response");
        let body = read_response_body(response).await.expect("body");

        assert!(body.is_empty());
        assert!(body.capacity() >= MAX_RESPONSE_BYTES);
    }
}
