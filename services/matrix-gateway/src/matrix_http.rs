use std::{borrow::Cow, fmt, str, time::Duration};

use async_trait::async_trait;
use futures_util::StreamExt;
use http::header::{AUTHORIZATION, CONTENT_TYPE, HeaderMap};
use reqwest::{Client, RequestBuilder, Url, redirect::Policy};
use ruma::api::{
    IncomingRequest, IncomingResponse, OutgoingRequest, SupportedVersions,
    auth_scheme::SendAccessToken,
    client::keys::get_keys::v3::{Request as KeysQueryRequest, Response as KeysQueryResponse},
    client::sync::sync_events::v3::{Request as SyncRequest, Response as SyncResponse},
};
use sha2::Digest;
use zeroize::Zeroize;

use crate::{
    crypto_outbox::{
        MAX_MATRIX_CRYPTO_REQUEST_BYTES, MAX_MATRIX_CRYPTO_RESPONSE_BYTES, PendingMatrixRequest,
        RawMatrixResponse, validate_canonical_request_bytes,
    },
    matrix::{
        FetchedMatrixSync, MATRIX_RESPONSE_EMPTY, MATRIX_RESPONSE_INVALID,
        MATRIX_RESPONSE_TOO_LARGE, MATRIX_TRANSPORT_FAILED, MATRIX_TRANSPORT_INVALID,
        MatrixTransport,
    },
    secret::{SafeError, SecretBytes},
    store::STORE_CRYPTO_TOO_LARGE,
};

/// A bounded raw Matrix HTTP transport with no implicit retry, proxy,
/// redirect, cookie, or response-decompression behavior.
pub struct ReqwestMatrixTransport {
    client: Client,
    homeserver_url: Url,
    access_token: SecretBytes,
    request_timeout: Duration,
    sync_timeout: Duration,
    sync_deadline: Duration,
}

impl ReqwestMatrixTransport {
    /// Construct a production Matrix transport.
    ///
    /// The homeserver must be an HTTPS origin with no credentials, query,
    /// fragment, or non-root path. Local HTTP is available only to the
    /// crate's unit-test constructor.
    pub fn new(
        homeserver_url: &str,
        access_token: SecretBytes,
        request_timeout: Duration,
        sync_timeout: Duration,
    ) -> Result<Self, SafeError> {
        Self::new_inner(
            homeserver_url,
            access_token,
            request_timeout,
            sync_timeout,
            false,
        )
    }

    #[cfg(test)]
    pub(crate) fn new_for_test(
        homeserver_url: &str,
        access_token: SecretBytes,
        request_timeout: Duration,
        sync_timeout: Duration,
    ) -> Result<Self, SafeError> {
        Self::new_inner(
            homeserver_url,
            access_token,
            request_timeout,
            sync_timeout,
            true,
        )
    }

    fn new_inner(
        homeserver_url: &str,
        access_token: SecretBytes,
        request_timeout: Duration,
        sync_timeout: Duration,
        allow_loopback_http: bool,
    ) -> Result<Self, SafeError> {
        let homeserver_url = parse_homeserver_url(homeserver_url, allow_loopback_http)?;
        if access_token.is_empty() || request_timeout.is_zero() || sync_timeout.is_zero() {
            return Err(SafeError::new(MATRIX_TRANSPORT_INVALID));
        }
        let sync_deadline = request_timeout
            .checked_add(sync_timeout)
            .ok_or_else(|| SafeError::new(MATRIX_TRANSPORT_INVALID))?;
        let sync_millis = sync_timeout.as_millis();
        if sync_millis == 0 || sync_millis > u64::MAX as u128 {
            return Err(SafeError::new(MATRIX_TRANSPORT_INVALID));
        }

        let client = Client::builder()
            .tls_backend_rustls()
            .redirect(Policy::none())
            .no_proxy()
            .referer(false)
            .no_gzip()
            .no_brotli()
            .no_zstd()
            .no_deflate()
            .retry(reqwest::retry::never())
            .connect_timeout(request_timeout)
            .https_only(!allow_loopback_http)
            .build()
            .map_err(|_| SafeError::new(MATRIX_TRANSPORT_INVALID))?;

        Ok(Self {
            client,
            homeserver_url,
            access_token,
            request_timeout,
            sync_timeout,
            sync_deadline,
        })
    }

    fn sync_request(&self, since: Option<&SecretBytes>) -> Result<RequestBuilder, SafeError> {
        let since = since
            .map(|since| {
                validate_sync_token(since)?;
                str::from_utf8(since.as_bytes())
                    .map_err(|_| SafeError::new(MATRIX_TRANSPORT_INVALID))
            })
            .transpose()?;
        let access_token = str::from_utf8(self.access_token.as_bytes())
            .map_err(|_| SafeError::new(MATRIX_TRANSPORT_INVALID))?;

        let mut request = SyncRequest::new();
        request.since = since.map(str::to_owned);
        request.timeout = Some(self.sync_timeout);
        let supported = SupportedVersions::from_parts(&["v1.1".to_owned()], &Default::default());
        let request: http::Request<Vec<u8>> = request
            .try_into_http_request(
                self.homeserver_url.as_str(),
                SendAccessToken::IfRequired(access_token),
                Cow::Owned(supported),
            )
            .map_err(|_| SafeError::new(MATRIX_TRANSPORT_INVALID))?;
        let mut headers = request.headers().clone();
        if let Some(value) = headers.get_mut(AUTHORIZATION) {
            value.set_sensitive(true);
        }
        let url = Url::parse(&request.uri().to_string())
            .map_err(|_| SafeError::new(MATRIX_TRANSPORT_INVALID))?;
        Ok(self
            .client
            .request(request.method().clone(), url)
            .headers(headers)
            .timeout(self.sync_deadline))
    }

    /// Fetch one bounded raw sync response, optionally with an application
    /// checkpoint. Bootstrap passes `None` so the request has no `since`
    /// parameter; runtime passes `Some` through the public transport port.
    pub(crate) async fn fetch_sync_bytes(
        &self,
        since: Option<&SecretBytes>,
    ) -> Result<(Vec<u8>, SyncResponse), SafeError> {
        let response = self
            .sync_request(since)?
            .send()
            .await
            .map_err(|_| SafeError::new(MATRIX_TRANSPORT_FAILED))?;
        if !response.status().is_success() {
            return Err(SafeError::new(MATRIX_TRANSPORT_FAILED));
        }
        let mut body = read_bounded_body(response, crate::matrix::MAX_SYNC_RESPONSE_BYTES).await?;
        let typed = match parse_sync_response(&body) {
            Ok(typed) => typed,
            Err(error) => {
                body.zeroize();
                return Err(error);
            }
        };
        Ok((body, typed))
    }

    fn crypto_request(&self, request: &PendingMatrixRequest) -> Result<RequestBuilder, SafeError> {
        validate_pending_request(request)?;
        let url = self
            .homeserver_url
            .join("_matrix/client/v3/keys/query")
            .map_err(|_| SafeError::new(MATRIX_TRANSPORT_INVALID))?;
        let mut headers = HeaderMap::new();
        let authorization = bearer_header(&self.access_token)?;
        headers.insert(AUTHORIZATION, authorization);
        headers.insert(
            CONTENT_TYPE,
            http::HeaderValue::from_static("application/json"),
        );
        Ok(self
            .client
            .post(url)
            .headers(headers)
            .body(request.request().as_bytes().to_vec())
            .timeout(self.request_timeout))
    }
}

impl fmt::Debug for ReqwestMatrixTransport {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("ReqwestMatrixTransport([REDACTED])")
    }
}

impl fmt::Display for ReqwestMatrixTransport {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("ReqwestMatrixTransport([REDACTED])")
    }
}

#[async_trait]
impl MatrixTransport for ReqwestMatrixTransport {
    async fn fetch_sync(&self, since: &SecretBytes) -> Result<FetchedMatrixSync, SafeError> {
        validate_sync_token(since)?;
        let (body, typed) = self.fetch_sync_bytes(Some(since)).await?;
        let next_token = typed.next_batch.as_bytes().to_vec();
        FetchedMatrixSync::from_parts(
            SecretBytes::from_slice(since.as_bytes()),
            SecretBytes::new(next_token),
            SecretBytes::new(body),
        )
    }

    async fn send_crypto(
        &self,
        request: &PendingMatrixRequest,
    ) -> Result<RawMatrixResponse, SafeError> {
        let response = self
            .crypto_request(request)?
            .send()
            .await
            .map_err(|_| SafeError::new(MATRIX_TRANSPORT_FAILED))?;
        if !response.status().is_success() {
            return Err(SafeError::new(MATRIX_TRANSPORT_FAILED));
        }
        let mut body = read_bounded_body(response, MAX_MATRIX_CRYPTO_RESPONSE_BYTES).await?;
        if let Err(error) = validate_keys_query_response(&body) {
            body.zeroize();
            return Err(error);
        }
        RawMatrixResponse::keys_query(body).map_err(|error| match error.code() {
            STORE_CRYPTO_TOO_LARGE => SafeError::new(MATRIX_RESPONSE_TOO_LARGE),
            _ => SafeError::new(MATRIX_RESPONSE_INVALID),
        })
    }
}

fn parse_homeserver_url(value: &str, allow_loopback_http: bool) -> Result<Url, SafeError> {
    let mut url = Url::parse(value).map_err(|_| SafeError::new(MATRIX_TRANSPORT_INVALID))?;
    if url.username() != ""
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || url.host_str().is_none()
        || !matches!(url.path(), "" | "/")
    {
        return Err(SafeError::new(MATRIX_TRANSPORT_INVALID));
    }

    let https = url.scheme() == "https";
    let loopback_http = allow_loopback_http
        && url.scheme() == "http"
        && url.host_str() == Some("127.0.0.1")
        && url.port().is_some();
    if !https && !loopback_http {
        return Err(SafeError::new(MATRIX_TRANSPORT_INVALID));
    }
    if url.path().is_empty() {
        url.set_path("/");
    }
    Ok(url)
}

/// Validate the origin used by bootstrap with the same parser as the concrete
/// transport. Unit tests may use a loopback HTTP fixture; production builds
/// retain the HTTPS-only policy.
pub(crate) fn validate_bootstrap_homeserver_url(value: &str) -> Result<(), SafeError> {
    parse_homeserver_url(value, cfg!(test)).map(|_| ())
}

fn validate_sync_token(token: &SecretBytes) -> Result<(), SafeError> {
    if token.is_empty() || token.len() > crate::store_types::MAX_SYNC_TOKEN_BYTES {
        return Err(if token.len() > crate::store_types::MAX_SYNC_TOKEN_BYTES {
            SafeError::new(MATRIX_RESPONSE_TOO_LARGE)
        } else {
            SafeError::new(MATRIX_TRANSPORT_INVALID)
        });
    }
    str::from_utf8(token.as_bytes())
        .map(|_| ())
        .map_err(|_| SafeError::new(MATRIX_TRANSPORT_INVALID))
}

fn validate_pending_request(request: &PendingMatrixRequest) -> Result<(), SafeError> {
    let request_id = request.sdk_request_id().as_bytes();
    let body = request.request().as_bytes();
    if request_id.is_empty()
        || request_id.len() > crate::crypto_outbox::MAX_SDK_REQUEST_ID_BYTES
        || body.is_empty()
        || body.len() > MAX_MATRIX_CRYPTO_REQUEST_BYTES
        || sha2::Sha256::digest(body).as_slice() != request.request_sha256()
    {
        return Err(SafeError::new(MATRIX_TRANSPORT_INVALID));
    }
    validate_canonical_request_bytes(body).map_err(|_| SafeError::new(MATRIX_TRANSPORT_INVALID))?;
    let request = http::Request::builder()
        .method(http::Method::POST)
        .uri("/_matrix/client/v3/keys/query")
        .body(body)
        .map_err(|_| SafeError::new(MATRIX_TRANSPORT_INVALID))?;
    KeysQueryRequest::try_from_http_request(request, &[] as &[&str])
        .map(|_| ())
        .map_err(|_| SafeError::new(MATRIX_TRANSPORT_INVALID))
}

fn bearer_header(token: &SecretBytes) -> Result<http::HeaderValue, SafeError> {
    if token.is_empty() {
        return Err(SafeError::new(MATRIX_TRANSPORT_INVALID));
    }
    let mut bytes = Vec::with_capacity(b"Bearer ".len() + token.len());
    bytes.extend_from_slice(b"Bearer ");
    bytes.extend_from_slice(token.as_bytes());
    let result =
        http::HeaderValue::from_bytes(&bytes).map_err(|_| SafeError::new(MATRIX_TRANSPORT_INVALID));
    bytes.zeroize();
    let mut value = result?;
    value.set_sensitive(true);
    Ok(value)
}

const UNKNOWN_BODY_INITIAL_CAPACITY: usize = 8 * 1024;

fn initial_body_capacity(content_length: Option<u64>, limit: usize) -> Result<usize, SafeError> {
    let limit_u64 = u64::try_from(limit).map_err(|_| SafeError::new(MATRIX_RESPONSE_TOO_LARGE))?;
    match content_length {
        Some(length) if length > limit_u64 => Err(SafeError::new(MATRIX_RESPONSE_TOO_LARGE)),
        Some(length) => usize::try_from(length)
            .map(|length| length.min(limit))
            .map_err(|_| SafeError::new(MATRIX_RESPONSE_TOO_LARGE)),
        None => Ok(UNKNOWN_BODY_INITIAL_CAPACITY.min(limit)),
    }
}

async fn read_bounded_body(
    response: reqwest::Response,
    limit: usize,
) -> Result<Vec<u8>, SafeError> {
    let capacity = initial_body_capacity(response.content_length(), limit)?;
    let mut body = Vec::with_capacity(capacity.min(limit));
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = match chunk {
            Ok(chunk) => chunk,
            Err(_) => {
                body.zeroize();
                return Err(SafeError::new(MATRIX_TRANSPORT_FAILED));
            }
        };
        if let Err(error) = append_bounded_chunk(&mut body, &chunk, limit) {
            body.zeroize();
            return Err(error);
        }
    }
    if body.is_empty() {
        return Err(SafeError::new(MATRIX_RESPONSE_EMPTY));
    }
    Ok(body)
}

fn append_bounded_chunk(body: &mut Vec<u8>, chunk: &[u8], limit: usize) -> Result<(), SafeError> {
    let new_len = body
        .len()
        .checked_add(chunk.len())
        .ok_or_else(|| SafeError::new(MATRIX_RESPONSE_TOO_LARGE))?;
    if new_len > limit {
        return Err(SafeError::new(MATRIX_RESPONSE_TOO_LARGE));
    }
    body.extend_from_slice(chunk);
    Ok(())
}

fn parse_sync_response(body: &[u8]) -> Result<SyncResponse, SafeError> {
    let response = http::Response::builder()
        .status(http::StatusCode::OK)
        .header(CONTENT_TYPE, "application/json")
        .body(body)
        .map_err(|_| SafeError::new(MATRIX_RESPONSE_INVALID))?;
    let typed = SyncResponse::try_from_http_response(response)
        .map_err(|_| SafeError::new(MATRIX_RESPONSE_INVALID))?;
    if typed.next_batch.is_empty() {
        return Err(SafeError::new(MATRIX_RESPONSE_INVALID));
    }
    if typed.next_batch.len() > crate::store_types::MAX_SYNC_TOKEN_BYTES {
        return Err(SafeError::new(MATRIX_RESPONSE_TOO_LARGE));
    }
    Ok(typed)
}

fn validate_keys_query_response(body: &[u8]) -> Result<(), SafeError> {
    let response = http::Response::builder()
        .status(http::StatusCode::OK)
        .header(CONTENT_TYPE, "application/json")
        .body(body)
        .map_err(|_| SafeError::new(MATRIX_RESPONSE_INVALID))?;
    KeysQueryResponse::try_from_http_response(response)
        .map(|_| ())
        .map_err(|_| SafeError::new(MATRIX_RESPONSE_INVALID))
}

#[cfg(test)]
mod transport_tests {
    use std::time::Duration;

    use chrono::{TimeZone, Utc};
    use matrix_sdk_test::SyncResponseBuilder;
    use ruma::api::OutgoingResponse;
    use sha2::{Digest, Sha256};
    use wiremock::{Mock, MockServer, ResponseTemplate, matchers};

    use super::{ReqwestMatrixTransport, append_bounded_chunk, initial_body_capacity};
    use crate::{
        crypto_outbox::{
            ExactMatrixRequest, MAX_MATRIX_CRYPTO_RESPONSE_BYTES, PendingMatrixRequest,
        },
        matrix::{
            MATRIX_RESPONSE_EMPTY, MATRIX_RESPONSE_INVALID, MATRIX_RESPONSE_TOO_LARGE,
            MATRIX_TRANSPORT_FAILED, MATRIX_TRANSPORT_INVALID, MAX_SYNC_RESPONSE_BYTES,
            MatrixTransport,
        },
        secret::{SafeError, SecretBytes},
    };

    fn timestamp() -> chrono::DateTime<Utc> {
        Utc.timestamp_millis_opt(1_700_000_000_000)
            .single()
            .expect("valid timestamp")
    }

    fn pending_keys_query(body: &[u8]) -> PendingMatrixRequest {
        let exact = ExactMatrixRequest::keys_query(b"sdk-request-id".to_vec(), body.to_vec())
            .expect("canonical keys query");
        PendingMatrixRequest::from_verified_parts(
            "crypto-row-test".to_owned(),
            SecretBytes::from_slice(exact.sdk_request_id().as_bytes()),
            SecretBytes::from_slice(exact.request().as_bytes()),
            *exact.request_sha256(),
            0,
            timestamp(),
        )
    }

    fn assert_safe_error(error: SafeError, code: &str, canary: &str) {
        assert_eq!(error.code(), code);
        if !canary.is_empty() {
            assert!(!format!("{error:?}").contains(canary));
            assert!(!error.to_string().contains(canary));
        }
        assert!(std::error::Error::source(&error).is_none());
    }

    #[tokio::test]
    async fn sync_request_and_response_are_exact_and_application_owned() {
        let server = MockServer::start().await;
        let mut typed = SyncResponseBuilder::new().build_sync_response();
        typed.next_batch = "next-application-token".to_owned();
        let response: http::Response<Vec<u8>> = typed
            .try_into_http_response()
            .expect("fixture response should serialize");
        let expected_body = response.body().clone();
        Mock::given(matchers::method("GET"))
            .and(matchers::path("/_matrix/client/v3/sync"))
            .respond_with(
                ResponseTemplate::new(200)
                    .insert_header("content-type", "application/json")
                    .set_body_bytes(expected_body.clone()),
            )
            .expect(1)
            .mount(&server)
            .await;

        let transport = ReqwestMatrixTransport::new_for_test(
            &server.uri(),
            SecretBytes::from_text(b"application-token", 1024).expect("token"),
            Duration::from_secs(2),
            Duration::from_secs(1),
        )
        .expect("loopback transport");
        let since = SecretBytes::from_text(b"application-since", 1024).expect("since");
        let fetched = transport.fetch_sync(&since).await.expect("sync response");
        assert_eq!(fetched.byte_count(), expected_body.len());
        let now = Utc::now();
        let observed_at = Utc
            .timestamp_millis_opt(now.timestamp_millis())
            .single()
            .expect("timestamp should be valid");
        let saved = fetched
            .into_store_input(observed_at)
            .expect("store input should be valid");
        assert_eq!(saved.response().as_bytes(), expected_body);

        let requests = server.received_requests().await.expect("requests recorded");
        assert_eq!(requests.len(), 1);
        assert_eq!(requests[0].method, http::Method::GET);
        assert_eq!(requests[0].url.path(), "/_matrix/client/v3/sync");
        assert_eq!(requests[0].url.query_pairs().count(), 2);
        assert_eq!(
            requests[0]
                .url
                .query_pairs()
                .find_map(|(key, value)| (key == "since").then(|| value.into_owned()))
                .as_deref(),
            Some("application-since")
        );
        assert_eq!(
            requests[0]
                .url
                .query_pairs()
                .find_map(|(key, value)| (key == "timeout").then(|| value.into_owned()))
                .as_deref(),
            Some("1000")
        );
        assert_eq!(
            requests[0]
                .headers
                .get("authorization")
                .and_then(|value| value.to_str().ok()),
            Some("Bearer application-token")
        );
        assert!(requests[0].headers.get("accept-encoding").is_none());
        assert!(requests[0].headers.get("referer").is_none());
        assert!(requests[0].headers.get("cookie").is_none());
    }

    #[tokio::test]
    async fn bootstrap_sync_bytes_omits_since_query_and_returns_exact_typed_response() {
        let server = MockServer::start().await;
        let mut typed = SyncResponseBuilder::new().build_sync_response();
        typed.next_batch = "bootstrap-next-token".to_owned();
        let response: http::Response<Vec<u8>> = typed
            .try_into_http_response()
            .expect("fixture response should serialize");
        let expected_body = response.body().clone();
        Mock::given(matchers::method("GET"))
            .and(matchers::path("/_matrix/client/v3/sync"))
            .respond_with(
                ResponseTemplate::new(200)
                    .insert_header("content-type", "application/json")
                    .set_body_bytes(expected_body.clone()),
            )
            .expect(1)
            .mount(&server)
            .await;

        let transport = ReqwestMatrixTransport::new_for_test(
            &server.uri(),
            SecretBytes::from_text(b"bootstrap-application-token", 1024).expect("token"),
            Duration::from_secs(2),
            Duration::from_secs(1),
        )
        .expect("loopback transport");
        let (body, parsed) = transport
            .fetch_sync_bytes(None)
            .await
            .expect("bootstrap sync response");

        assert_eq!(body, expected_body);
        assert_eq!(parsed.next_batch, "bootstrap-next-token");
        let requests = server.received_requests().await.expect("requests recorded");
        assert_eq!(requests.len(), 1);
        assert_eq!(requests[0].url.query_pairs().count(), 1);
        assert!(requests[0].url.query_pairs().all(|(key, _)| key != "since"));
    }

    #[tokio::test]
    async fn crypto_request_uses_exact_endpoint_auth_and_body() {
        let server = MockServer::start().await;
        let request_body = br#"{"device_keys":{}}"#;
        let response_body = br#"{"device_keys":{}}"#;
        Mock::given(matchers::method("POST"))
            .and(matchers::path("/_matrix/client/v3/keys/query"))
            .respond_with(ResponseTemplate::new(200).set_body_bytes(response_body))
            .expect(1)
            .mount(&server)
            .await;
        let transport = ReqwestMatrixTransport::new_for_test(
            &server.uri(),
            SecretBytes::from_text(b"application-token", 1024).expect("token"),
            Duration::from_secs(2),
            Duration::from_secs(1),
        )
        .expect("loopback transport");
        let response = transport
            .send_crypto(&pending_keys_query(request_body))
            .await
            .expect("crypto response");
        let expected_digest: [u8; 32] = Sha256::digest(response_body).into();
        assert_eq!(response.sha256(), &expected_digest);
        let requests = server.received_requests().await.expect("requests recorded");
        assert_eq!(requests[0].method, http::Method::POST);
        assert_eq!(requests[0].url.path(), "/_matrix/client/v3/keys/query");
        assert_eq!(requests[0].url.query_pairs().count(), 0);
        assert_eq!(requests[0].body, request_body);
        assert_eq!(
            requests[0]
                .headers
                .get("authorization")
                .and_then(|value| value.to_str().ok()),
            Some("Bearer application-token")
        );
        assert_eq!(
            requests[0]
                .headers
                .get("content-type")
                .and_then(|value| value.to_str().ok()),
            Some("application/json")
        );
    }

    #[tokio::test]
    async fn schema_invalid_canonical_keys_query_request_is_rejected_before_network() {
        let server = MockServer::start().await;
        Mock::given(matchers::path("/_matrix/client/v3/keys/query"))
            .respond_with(ResponseTemplate::new(200).set_body_bytes(br#"{"device_keys":{}}"#))
            .mount(&server)
            .await;
        let transport = ReqwestMatrixTransport::new_for_test(
            &server.uri(),
            SecretBytes::from_text(b"request-schema-token", 1024).expect("token"),
            Duration::from_secs(2),
            Duration::from_secs(1),
        )
        .expect("loopback transport");

        let error = transport
            .send_crypto(&pending_keys_query(
                br#"{"canary":"request-schema-canary","timeout":1000}"#,
            ))
            .await
            .expect_err("canonical but schema-invalid request must fail before transport");
        assert_safe_error(error, MATRIX_TRANSPORT_INVALID, "request-schema-canary");
        assert!(server.received_requests().await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn schema_invalid_success_response_is_rejected_before_returning_raw_bytes() {
        let server = MockServer::start().await;
        Mock::given(matchers::path("/_matrix/client/v3/keys/query"))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_bytes(br#"{"canary":"response-schema-canary","device_keys":[]}"#),
            )
            .expect(1)
            .mount(&server)
            .await;
        let transport = ReqwestMatrixTransport::new_for_test(
            &server.uri(),
            SecretBytes::from_text(b"response-schema-token", 1024).expect("token"),
            Duration::from_secs(2),
            Duration::from_secs(1),
        )
        .expect("loopback transport");

        let error = transport
            .send_crypto(&pending_keys_query(br#"{"device_keys":{}}"#))
            .await
            .expect_err("schema-invalid successful response must fail closed");
        assert_safe_error(error, MATRIX_RESPONSE_INVALID, "response-schema-canary");
    }

    #[tokio::test]
    async fn nontrivial_typed_keys_query_request_and_response_preserve_exact_bytes() {
        let server = MockServer::start().await;
        let request_body = br#"{"device_keys":{"@alice:example.org":["DEVICE"]},"timeout":1000}"#;
        let response_body = serde_json::to_vec(&*matrix_sdk_test::test_json::KEYS_QUERY)
            .expect("typed response fixture should serialize");
        Mock::given(matchers::method("POST"))
            .and(matchers::path("/_matrix/client/v3/keys/query"))
            .respond_with(ResponseTemplate::new(200).set_body_bytes(response_body.clone()))
            .expect(1)
            .mount(&server)
            .await;
        let transport = ReqwestMatrixTransport::new_for_test(
            &server.uri(),
            SecretBytes::from_text(b"typed-application-token", 1024).expect("token"),
            Duration::from_secs(2),
            Duration::from_secs(1),
        )
        .expect("loopback transport");

        let response = transport
            .send_crypto(&pending_keys_query(request_body))
            .await
            .expect("nontrivial typed response");
        assert_eq!(response.body().as_bytes(), response_body);

        let requests = server.received_requests().await.expect("requests recorded");
        assert_eq!(requests.len(), 1);
        assert_eq!(requests[0].body, request_body);
    }

    #[test]
    fn production_origin_policy_is_https_only_and_content_free() {
        let transport = ReqwestMatrixTransport::new(
            "https://matrix.example",
            SecretBytes::from_text(b"valid-origin-token", 1024).expect("token"),
            Duration::from_secs(1),
            Duration::from_secs(1),
        )
        .expect("an HTTPS origin with a root path is valid");
        assert_eq!(
            format!("{transport:?}"),
            "ReqwestMatrixTransport([REDACTED])"
        );

        for value in [
            "http://127.0.0.1:8080",
            "https://matrix.example/path",
            "https://matrix.example/?query=secret",
            "https://user:password@matrix.example",
        ] {
            let error = ReqwestMatrixTransport::new(
                value,
                SecretBytes::from_text(b"origin-token-canary", 1024).expect("token"),
                Duration::from_secs(1),
                Duration::from_secs(1),
            )
            .expect_err("invalid origin");
            assert_safe_error(error, MATRIX_TRANSPORT_INVALID, "origin-token-canary");
        }
    }

    #[tokio::test]
    async fn invalid_since_is_rejected_before_any_request_is_built() {
        let server = MockServer::start().await;
        let transport = ReqwestMatrixTransport::new_for_test(
            &server.uri(),
            SecretBytes::from_text(b"token", 1024).expect("token"),
            Duration::from_secs(2),
            Duration::from_secs(1),
        )
        .expect("loopback transport");

        for since in [
            SecretBytes::new(Vec::new()),
            SecretBytes::new(vec![b'x'; crate::store_types::MAX_SYNC_TOKEN_BYTES + 1]),
            SecretBytes::new(vec![0xff]),
        ] {
            let error = transport
                .fetch_sync(&since)
                .await
                .expect_err("invalid since must fail before transport");
            assert!(matches!(
                error.code(),
                MATRIX_TRANSPORT_INVALID | MATRIX_RESPONSE_TOO_LARGE
            ));
        }
        assert!(server.received_requests().await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn closed_local_connection_is_reported_as_a_transport_failure() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind local port");
        let address = listener.local_addr().expect("read local address");
        drop(listener);

        let transport = ReqwestMatrixTransport::new_for_test(
            &format!("http://127.0.0.1:{}", address.port()),
            SecretBytes::from_text(b"connect-token-canary", 1024).expect("token"),
            Duration::from_millis(100),
            Duration::from_millis(1),
        )
        .expect("loopback transport");
        let error = transport
            .fetch_sync(&SecretBytes::from_text(b"since", 1024).expect("since"))
            .await
            .expect_err("closed local connection must fail");
        assert_safe_error(error, MATRIX_TRANSPORT_FAILED, "connect-token-canary");
    }

    #[tokio::test]
    async fn redirect_and_non_success_bodies_are_not_followed_or_retained() {
        let server = MockServer::start().await;
        let canary = "upstream-body-canary";
        Mock::given(matchers::path("/_matrix/client/v3/sync"))
            .respond_with(
                ResponseTemplate::new(302)
                    .insert_header("location", server.uri())
                    .set_body_string(canary),
            )
            .expect(1)
            .mount(&server)
            .await;
        let transport = ReqwestMatrixTransport::new_for_test(
            &server.uri(),
            SecretBytes::from_text(b"redirect-token-canary", 1024).expect("token"),
            Duration::from_secs(2),
            Duration::from_secs(1),
        )
        .expect("loopback transport");
        let error = transport
            .fetch_sync(&SecretBytes::from_text(b"since", 1024).expect("since"))
            .await
            .expect_err("redirect must fail");
        assert_safe_error(error, MATRIX_TRANSPORT_FAILED, canary);
        assert_eq!(server.received_requests().await.unwrap().len(), 1);

        let server = MockServer::start().await;
        Mock::given(matchers::path("/_matrix/client/v3/sync"))
            .respond_with(
                ResponseTemplate::new(400)
                    .insert_header("content-type", "application/json")
                    .set_body_string(canary),
            )
            .expect(1)
            .mount(&server)
            .await;
        let transport = ReqwestMatrixTransport::new_for_test(
            &server.uri(),
            SecretBytes::from_text(b"token", 1024).expect("token"),
            Duration::from_secs(2),
            Duration::from_secs(1),
        )
        .expect("loopback transport");
        let error = transport
            .fetch_sync(&SecretBytes::from_text(b"since", 1024).expect("since"))
            .await
            .expect_err("non-success must fail");
        assert_safe_error(error, MATRIX_TRANSPORT_FAILED, canary);
    }

    #[tokio::test]
    async fn crypto_response_status_and_body_failures_are_content_free() {
        for (status, body, expected_code) in [
            (
                400,
                b"crypto-upstream-error-canary".as_slice(),
                MATRIX_TRANSPORT_FAILED,
            ),
            (200, b"".as_slice(), MATRIX_RESPONSE_EMPTY),
            (200, b"{malformed".as_slice(), MATRIX_RESPONSE_INVALID),
        ] {
            let server = MockServer::start().await;
            Mock::given(matchers::path("/_matrix/client/v3/keys/query"))
                .respond_with(
                    ResponseTemplate::new(status)
                        .insert_header("content-type", "application/json")
                        .set_body_bytes(body),
                )
                .expect(1)
                .mount(&server)
                .await;
            let transport = ReqwestMatrixTransport::new_for_test(
                &server.uri(),
                SecretBytes::from_text(b"crypto-token-canary", 1024).expect("token"),
                Duration::from_secs(2),
                Duration::from_secs(1),
            )
            .expect("loopback transport");
            let error = transport
                .send_crypto(&pending_keys_query(br#"{"device_keys":{}}"#))
                .await
                .expect_err("crypto response must fail");
            assert_safe_error(error, expected_code, "crypto-upstream-error-canary");
        }
    }

    #[tokio::test]
    async fn response_headers_do_not_enable_cookies_or_compression() {
        let server = MockServer::start().await;
        Mock::given(matchers::path("/_matrix/client/v3/keys/query"))
            .respond_with(
                ResponseTemplate::new(200)
                    .insert_header("set-cookie", "session=should-not-return")
                    .set_body_bytes(br#"{"device_keys":{}}"#),
            )
            .expect(2)
            .mount(&server)
            .await;
        let transport = ReqwestMatrixTransport::new_for_test(
            &server.uri(),
            SecretBytes::from_text(b"token", 1024).expect("token"),
            Duration::from_secs(2),
            Duration::from_secs(1),
        )
        .expect("loopback transport");
        let request = pending_keys_query(br#"{"device_keys":{}}"#);
        transport
            .send_crypto(&request)
            .await
            .expect("first response");
        transport
            .send_crypto(&request)
            .await
            .expect("second response");

        let requests = server.received_requests().await.expect("requests recorded");
        assert_eq!(requests.len(), 2);
        for request in requests {
            assert!(request.headers.get("accept-encoding").is_none());
            assert!(request.headers.get("referer").is_none());
            assert!(request.headers.get("cookie").is_none());
        }
    }

    #[tokio::test]
    async fn empty_malformed_and_deadline_responses_fail_closed() {
        for (status, body, code) in [
            (200, b"".as_slice(), MATRIX_RESPONSE_EMPTY),
            (200, b"not-json".as_slice(), MATRIX_RESPONSE_INVALID),
        ] {
            let server = MockServer::start().await;
            Mock::given(matchers::path("/_matrix/client/v3/sync"))
                .respond_with(
                    ResponseTemplate::new(status)
                        .insert_header("content-type", "application/json")
                        .set_body_bytes(body),
                )
                .expect(1)
                .mount(&server)
                .await;
            let transport = ReqwestMatrixTransport::new_for_test(
                &server.uri(),
                SecretBytes::from_text(b"token", 1024).expect("token"),
                Duration::from_secs(2),
                Duration::from_secs(1),
            )
            .expect("loopback transport");
            let error = transport
                .fetch_sync(&SecretBytes::from_text(b"since", 1024).expect("since"))
                .await
                .expect_err("response must fail");
            assert_safe_error(error, code, "not-json");
        }

        let server = MockServer::start().await;
        Mock::given(matchers::path("/_matrix/client/v3/sync"))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_delay(Duration::from_millis(200))
                    .set_body_bytes(br#"{"next_batch":"late"}"#),
            )
            .expect(1)
            .mount(&server)
            .await;
        let transport = ReqwestMatrixTransport::new_for_test(
            &server.uri(),
            SecretBytes::from_text(b"timeout-token-canary", 1024).expect("token"),
            Duration::from_millis(20),
            Duration::from_millis(1),
        )
        .expect("loopback transport");
        let error = transport
            .fetch_sync(&SecretBytes::from_text(b"since", 1024).expect("since"))
            .await
            .expect_err("deadline must fail");
        assert_safe_error(error, MATRIX_TRANSPORT_FAILED, "timeout-token-canary");
    }

    #[tokio::test]
    async fn declared_oversize_and_malformed_crypto_are_rejected() {
        let server = MockServer::start().await;
        Mock::given(matchers::path("/_matrix/client/v3/sync"))
            .respond_with(ResponseTemplate::new(200).set_body_bytes(vec![
                b'x';
                MAX_SYNC_RESPONSE_BYTES
                    + 1
            ]))
            .expect(1)
            .mount(&server)
            .await;
        let transport = ReqwestMatrixTransport::new_for_test(
            &server.uri(),
            SecretBytes::from_text(b"token", 1024).expect("token"),
            Duration::from_secs(2),
            Duration::from_secs(1),
        )
        .expect("loopback transport");
        let error = transport
            .fetch_sync(&SecretBytes::from_text(b"since", 1024).expect("since"))
            .await
            .expect_err("oversize must fail");
        assert_safe_error(error, MATRIX_RESPONSE_TOO_LARGE, "token");

        let server = MockServer::start().await;
        Mock::given(matchers::path("/_matrix/client/v3/keys/query"))
            .respond_with(ResponseTemplate::new(200).set_body_bytes(vec![
                b'x';
                MAX_MATRIX_CRYPTO_RESPONSE_BYTES
                    + 1
            ]))
            .expect(1)
            .mount(&server)
            .await;
        let transport = ReqwestMatrixTransport::new_for_test(
            &server.uri(),
            SecretBytes::from_text(b"token", 1024).expect("token"),
            Duration::from_secs(2),
            Duration::from_secs(1),
        )
        .expect("loopback transport");
        let error = transport
            .send_crypto(&pending_keys_query(br#"{"device_keys":{}}"#))
            .await
            .expect_err("declared crypto oversize must fail");
        assert_safe_error(error, MATRIX_RESPONSE_TOO_LARGE, "token");

        let server = MockServer::start().await;
        Mock::given(matchers::path("/_matrix/client/v3/keys/query"))
            .respond_with(ResponseTemplate::new(200).set_body_bytes(b"{malformed"))
            .expect(1)
            .mount(&server)
            .await;
        let transport = ReqwestMatrixTransport::new_for_test(
            &server.uri(),
            SecretBytes::from_text(b"token", 1024).expect("token"),
            Duration::from_secs(2),
            Duration::from_secs(1),
        )
        .expect("loopback transport");
        let error = transport
            .send_crypto(&pending_keys_query(br#"{"device_keys":{}}"#))
            .await
            .expect_err("malformed crypto response must fail");
        assert_safe_error(error, MATRIX_RESPONSE_INVALID, "malformed");
    }

    #[tokio::test]
    async fn streamed_crypto_bound_rejects_one_over_and_accepts_exact_limit() {
        let server = MockServer::start().await;
        let oversized = vec![b'x'; MAX_MATRIX_CRYPTO_RESPONSE_BYTES + 1];
        Mock::given(matchers::path("/_matrix/client/v3/keys/query"))
            .respond_with(
                ResponseTemplate::new(200)
                    .insert_header("transfer-encoding", "chunked")
                    .set_body_bytes(oversized),
            )
            .expect(1)
            .mount(&server)
            .await;
        let transport = ReqwestMatrixTransport::new_for_test(
            &server.uri(),
            SecretBytes::from_text(b"stream-token-canary", 1024).expect("token"),
            Duration::from_secs(2),
            Duration::from_secs(1),
        )
        .expect("loopback transport");
        let error = transport
            .send_crypto(&pending_keys_query(br#"{"device_keys":{}}"#))
            .await
            .expect_err("streamed response over the limit must fail");
        assert_safe_error(error, MATRIX_RESPONSE_TOO_LARGE, "stream-token-canary");

        let server = MockServer::start().await;
        let exact = exact_json_object(MAX_MATRIX_CRYPTO_RESPONSE_BYTES);
        assert_eq!(exact.first(), Some(&b'{'));
        assert_eq!(exact.last(), Some(&b'}'));
        assert!(crate::crypto_outbox::validate_json_object(&exact).is_ok());
        let expected_digest: [u8; 32] = Sha256::digest(&exact).into();
        Mock::given(matchers::path("/_matrix/client/v3/keys/query"))
            .respond_with(
                ResponseTemplate::new(200)
                    .insert_header("transfer-encoding", "chunked")
                    .set_body_bytes(exact),
            )
            .expect(1)
            .mount(&server)
            .await;
        let transport = ReqwestMatrixTransport::new_for_test(
            &server.uri(),
            SecretBytes::from_text(b"exact-token", 1024).expect("token"),
            Duration::from_secs(3),
            Duration::from_secs(1),
        )
        .expect("loopback transport");
        let response = transport
            .send_crypto(&pending_keys_query(br#"{"device_keys":{}}"#))
            .await
            .expect("exact-limit response must be accepted");
        assert_eq!(response.sha256(), &expected_digest);
    }

    #[test]
    fn streaming_limit_rejects_before_appending_and_accepts_exact_limit() {
        let mut body = vec![0_u8; MAX_MATRIX_CRYPTO_RESPONSE_BYTES - 1];
        assert_safe_error(
            append_bounded_chunk(&mut body, b"xx", MAX_MATRIX_CRYPTO_RESPONSE_BYTES)
                .expect_err("one over the limit"),
            MATRIX_RESPONSE_TOO_LARGE,
            "",
        );
        assert_eq!(body.len(), MAX_MATRIX_CRYPTO_RESPONSE_BYTES - 1);
        append_bounded_chunk(&mut body, b"x", MAX_MATRIX_CRYPTO_RESPONSE_BYTES)
            .expect("exact limit");
        assert_eq!(body.len(), MAX_MATRIX_CRYPTO_RESPONSE_BYTES);
    }

    #[test]
    fn initial_body_capacity_bounds_unknown_and_declared_lengths() {
        let limit = MAX_SYNC_RESPONSE_BYTES;
        let unknown = initial_body_capacity(None, limit).expect("unknown length capacity");
        assert!(unknown < limit / 1024);
        assert_eq!(
            unknown,
            initial_body_capacity(None, limit / 2).expect("unknown length capacity is fixed")
        );
        assert_eq!(
            initial_body_capacity(Some(4 * 1024), limit).expect("small declared length"),
            4 * 1024
        );
        assert_eq!(
            initial_body_capacity(
                Some(u64::try_from(limit).expect("limit fits in u64")),
                limit
            )
            .expect("hard-limit declared length"),
            limit
        );
    }

    fn exact_json_object(size: usize) -> Vec<u8> {
        let prefix = br#"{"a":""#;
        let suffix = br#""}"#;
        assert!(size >= prefix.len() + suffix.len());
        let mut body = Vec::with_capacity(size);
        body.extend_from_slice(prefix);
        body.extend(std::iter::repeat_n(
            b'x',
            size - prefix.len() - suffix.len(),
        ));
        body.extend_from_slice(suffix);
        assert_eq!(body.len(), size);
        body
    }
}
