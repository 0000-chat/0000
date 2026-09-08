//! Compile-time and local-only probes for the Matrix SDK boundary.
//!
//! The daemon deliberately does not use [`matrix_sdk::Client::sync_once`].
//! These small adapters keep the raw response body available to the gateway
//! before handing a typed response to `BaseClient`.

use std::{borrow::Cow, error::Error, path::Path};

use http::{Request as HttpRequest, Response as HttpResponse};
use matrix_sdk::{SessionMeta, authentication::matrix::MatrixSession};
use matrix_sdk_base::{BaseClient, DmRoomDefinition, ThreadingSupport, store::RoomLoadSettings};
use matrix_sdk_common::cross_process_lock::CrossProcessLockConfig;
use matrix_sdk_crypto::types::requests::{AnyOutgoingRequest, KeysQueryRequest};
use matrix_sdk_sqlite::{SqliteCryptoStore, SqliteStateStore};
use ruma::{
    api::client::sync::sync_events::v3::{Request as SyncRequest, Response as SyncResponse},
    api::{IncomingResponse, OutgoingRequest, SupportedVersions, auth_scheme::SendAccessToken},
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

/// Re-export the central gateway response-size limit for transport callers.
pub use crate::config::MAX_SYNC_RESPONSE_BYTES;

/// An untouched bounded response body paired with its typed Ruma response.
///
/// The body is intentionally retained: the application inbox encrypts and
/// persists it before passing `typed` to the SDK.
#[derive(Clone)]
pub struct PreservedSyncResponse {
    /// The exact bytes returned by the homeserver.
    pub body: Vec<u8>,
    /// The typed response parsed from `body`.
    pub typed: SyncResponse,
}

/// Errors returned while preserving and parsing a bounded sync response.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum PreserveSyncResponseError {
    /// The homeserver returned an empty response body.
    Empty,
    /// The homeserver returned a response body larger than the configured limit.
    TooLarge,
    /// Ruma could not parse the response body.
    ///
    /// The upstream parse error is intentionally discarded because it may
    /// retain response bytes or server-provided exception text.
    RumaParse,
}

impl PreserveSyncResponseError {
    /// Return the stable, content-free classification for this error.
    pub const fn code(self) -> &'static str {
        match self {
            Self::Empty => "sync_response_empty",
            Self::TooLarge => "sync_response_too_large",
            Self::RumaParse => "sync_response_parse_failed",
        }
    }
}

impl std::fmt::Display for PreserveSyncResponseError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Empty => formatter.write_str("sync response body is empty"),
            Self::TooLarge => formatter.write_str("sync response body is too large"),
            Self::RumaParse => formatter.write_str("failed to parse sync response"),
        }
    }
}

impl Error for PreserveSyncResponseError {}

/// A serializable session envelope used by the application state store.
///
/// This is a transparent wrapper so callers do not need to format or print
/// access/refresh tokens while persisting them.
#[derive(Clone, Serialize, Deserialize)]
pub struct SerializedMatrixSession {
    session: MatrixSession,
}

impl SerializedMatrixSession {
    /// Serialize a Matrix session without exposing its protected values.
    pub fn encode(session: &MatrixSession) -> Result<Vec<u8>, serde_json::Error> {
        serde_json::to_vec(&Self {
            session: session.clone(),
        })
    }

    /// Restore a Matrix session without formatting its protected values.
    pub fn decode(bytes: &[u8]) -> Result<MatrixSession, serde_json::Error> {
        serde_json::from_slice::<Self>(bytes).map(|value| value.session)
    }
}

/// Open the two persistent SDK stores and construct the public `BaseClient`
/// seam used by the daemon.
pub async fn open_base_client(
    state_path: impl AsRef<Path>,
    crypto_path: impl AsRef<Path>,
    passphrase: &str,
    session_meta: SessionMeta,
) -> Result<BaseClient, Box<dyn Error + Send + Sync>> {
    let state = SqliteStateStore::open(state_path, Some(passphrase)).await?;
    let crypto = SqliteCryptoStore::open(crypto_path, Some(passphrase)).await?;
    let base = BaseClient::new(
        matrix_sdk_base::store::StoreConfig::new(CrossProcessLockConfig::SingleProcess)
            .state_store(state)
            .crypto_store(crypto),
        ThreadingSupport::Disabled,
        DmRoomDefinition::default(),
    );
    base.activate(session_meta, RoomLoadSettings::default(), None)
        .await?;
    Ok(base)
}

/// Convert a v3 sync request into an HTTP request while leaving response
/// handling to the caller's bounded raw transport.
pub fn sync_request_to_http(
    base_url: &str,
    access_token: &str,
    since: Option<String>,
) -> Result<HttpRequest<Vec<u8>>, ruma::api::error::IntoHttpError> {
    let mut request = SyncRequest::new();
    request.since = since;
    let supported = SupportedVersions::from_parts(&["v1.1".to_owned()], &Default::default());
    request.try_into_http_request(
        base_url,
        SendAccessToken::IfRequired(access_token),
        Cow::Owned(supported),
    )
}

/// Parse an HTTP response into a typed v3 sync response without losing the
/// exact bounded body that must be journaled first.
pub fn preserve_sync_response(
    response: HttpResponse<Vec<u8>>,
) -> Result<PreservedSyncResponse, PreserveSyncResponseError> {
    let body_len = response.body().len();
    if body_len == 0 {
        return Err(PreserveSyncResponseError::Empty);
    }
    if body_len > MAX_SYNC_RESPONSE_BYTES {
        return Err(PreserveSyncResponseError::TooLarge);
    }

    let status = response.status();
    let version = response.version();
    let headers = response.headers().clone();
    let body = response.into_body();
    let mut parse_response = HttpResponse::new(body.as_slice());
    *parse_response.status_mut() = status;
    *parse_response.version_mut() = version;
    *parse_response.headers_mut() = headers;
    let typed = SyncResponse::try_from_http_response(parse_response)
        .map_err(|_| PreserveSyncResponseError::RumaParse)?;
    Ok(PreservedSyncResponse { body, typed })
}

/// The request classes the receive-only daemon is allowed to observe.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum MatrixCryptoRequestKind {
    /// Device/one-time/fallback key upload, which pauses maintenance.
    KeysUpload,
    /// Device key query, the only request the receive-only path may send.
    KeysQuery,
    /// One-time-key claim, forbidden in the receive-only path.
    KeysClaim,
    /// Encrypted to-device request, forbidden in the receive-only path.
    ToDevice,
    /// Verification or in-room verification request, forbidden in the path.
    Verification,
    /// In-room message request, forbidden in the path.
    RoomMessage,
    /// Cross-signing signature/signing-key upload, forbidden in the path.
    SigningOrSignature,
    /// Key-backup request, forbidden in the path.
    Backup,
}

/// The result of classifying one SDK outgoing crypto request.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum MatrixCryptoRequestPolicy {
    /// Process this request through the durable keys-query outbox.
    AllowKeysQuery,
    /// Persist maintenance and pause the source checkpoint loop.
    RequireMaintenance,
    /// Fail closed with the stable policy code.
    Forbidden,
}

/// Stable code used when a forbidden crypto request reaches the daemon.
pub const MATRIX_CRYPTO_KIND_NOT_ALLOWED: &str = "matrix_crypto_kind_not_allowed";

/// Return the receive-only policy for a classified crypto request kind.
pub fn policy_for_crypto_kind(kind: MatrixCryptoRequestKind) -> MatrixCryptoRequestPolicy {
    match kind {
        MatrixCryptoRequestKind::KeysQuery => MatrixCryptoRequestPolicy::AllowKeysQuery,
        MatrixCryptoRequestKind::KeysUpload => MatrixCryptoRequestPolicy::RequireMaintenance,
        MatrixCryptoRequestKind::KeysClaim
        | MatrixCryptoRequestKind::ToDevice
        | MatrixCryptoRequestKind::Verification
        | MatrixCryptoRequestKind::RoomMessage
        | MatrixCryptoRequestKind::SigningOrSignature
        | MatrixCryptoRequestKind::Backup => MatrixCryptoRequestPolicy::Forbidden,
    }
}

/// Classify an SDK request without serializing or logging protected values.
pub fn classify_crypto_request(
    request: &AnyOutgoingRequest,
) -> (MatrixCryptoRequestKind, MatrixCryptoRequestPolicy) {
    let kind = match request {
        AnyOutgoingRequest::KeysUpload(_) => MatrixCryptoRequestKind::KeysUpload,
        AnyOutgoingRequest::KeysQuery(_) => MatrixCryptoRequestKind::KeysQuery,
        AnyOutgoingRequest::KeysClaim(_) => MatrixCryptoRequestKind::KeysClaim,
        AnyOutgoingRequest::ToDeviceRequest(_) => MatrixCryptoRequestKind::ToDevice,
        AnyOutgoingRequest::RoomMessage(_) => MatrixCryptoRequestKind::RoomMessage,
        AnyOutgoingRequest::SignatureUpload(_) => MatrixCryptoRequestKind::SigningOrSignature,
    };

    (kind, policy_for_crypto_kind(kind))
}

/// Return the stable policy error for a forbidden request kind.
pub fn enforce_crypto_request_policy(
    request: &AnyOutgoingRequest,
) -> Result<MatrixCryptoRequestKind, &'static str> {
    let (kind, policy) = classify_crypto_request(request);
    match policy {
        MatrixCryptoRequestPolicy::Forbidden => Err(MATRIX_CRYPTO_KIND_NOT_ALLOWED),
        MatrixCryptoRequestPolicy::AllowKeysQuery
        | MatrixCryptoRequestPolicy::RequireMaintenance => Ok(kind),
    }
}

/// Compute the stable body digest used to rebind a persisted KeysQuery after
/// the SDK creates a replacement in-memory request ID.
pub fn keys_query_body_digest(request: &KeysQueryRequest) -> [u8; 32] {
    #[derive(Serialize)]
    struct CanonicalKeysQuery<'a> {
        device_keys: &'a std::collections::BTreeMap<ruma::OwnedUserId, Vec<ruma::OwnedDeviceId>>,
        timeout_ms: Option<u64>,
    }

    let body = CanonicalKeysQuery {
        device_keys: &request.device_keys,
        timeout_ms: request.timeout.map(|timeout| timeout.as_millis() as u64),
    };
    let encoded = match serde_json::to_vec(&body) {
        Ok(encoded) => encoded,
        Err(_) => b"matrix-crypto-request-invalid".to_vec(),
    };
    Sha256::digest(encoded).into()
}

/// Return true when a freshly enumerated KeysQuery is a safe replacement for
/// a persisted request row. Matching the body—not the SDK request ID—is the
/// restart/re-enumeration contract.
pub fn keys_query_rebinds_to_digest(
    persisted_digest: [u8; 32],
    request: &KeysQueryRequest,
) -> bool {
    keys_query_body_digest(request) == persisted_digest
}
