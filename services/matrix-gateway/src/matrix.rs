//! Compile-time and local-only probes for the Matrix SDK boundary.
//!
//! The daemon deliberately does not use [`matrix_sdk::Client::sync_once`].
//! These small adapters keep the raw response body available to the gateway
//! before handing a typed response to `BaseClient`.

use std::{borrow::Cow, error::Error, fmt, path::Path};

use async_trait::async_trait;
use chrono::{DateTime, Utc};
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

use crate::{
    crypto_outbox::{
        ExactMatrixRequest, PendingMatrixRequest, RawMatrixResponse, SavedMatrixResponse,
    },
    secret::{SafeError, SecretBytes},
    store::STORE_SYNC_TOO_LARGE,
    store_types::{NewRawSyncInbox, RawSyncInbox, ReasonCode},
};

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

/// Stable error code for an invalid or unavailable Matrix session.
pub const MATRIX_SESSION_INVALID: &str = "matrix_session_invalid";
/// Stable error code for an adapter operation attempted before readiness.
pub const MATRIX_SESSION_NOT_READY: &str = "matrix_session_not_ready";
/// Stable error code for invalid transport configuration or input.
pub const MATRIX_TRANSPORT_INVALID: &str = "matrix_transport_invalid";
/// Stable error code for a failed Matrix HTTP operation.
pub const MATRIX_TRANSPORT_FAILED: &str = "matrix_transport_failed";
/// Stable error code for an empty Matrix response body.
pub const MATRIX_RESPONSE_EMPTY: &str = "matrix_response_empty";
/// Stable error code for a Matrix response over its fixed bound.
pub const MATRIX_RESPONSE_TOO_LARGE: &str = "matrix_response_too_large";
/// Stable error code for malformed or inconsistent Matrix response bytes.
pub const MATRIX_RESPONSE_INVALID: &str = "matrix_response_invalid";
/// Stable error code for a Matrix SDK failure.
pub const MATRIX_SDK_FAILED: &str = "matrix_sdk_failed";
/// Stable error code for an SDK position absent from the application journal.
pub const MATRIX_SDK_POSITION_UNJOURNALED: &str = "matrix_sdk_position_unjournaled";
/// Stable error code for an invalid Matrix room membership envelope.
pub const MATRIX_ROOM_MEMBERSHIP_INVALID: &str = "matrix_room_membership_invalid";
/// Stable error code for crypto maintenance that must pause the gateway.
pub const MATRIX_CRYPTO_MAINTENANCE_REQUIRED: &str = "matrix_crypto_maintenance_required";
/// Stable error code for a crypto request kind outside this phase's allowlist.
pub const MATRIX_CRYPTO_KIND_NOT_ALLOWED: &str = "matrix_crypto_kind_not_allowed";
/// Stable error code for an unrecoverable persisted crypto acknowledgement.
pub const MATRIX_CRYPTO_ACK_UNRECOVERABLE: &str = "matrix_crypto_ack_unrecoverable";

/// A bounded, exact Matrix `/sync` response owned by the application.
///
/// The request token, next token, and transferred response body are all
/// protected values. The DTO deliberately has no general byte extraction API.
///
/// ```compile_fail
/// use communicator_matrix_gateway::matrix::FetchedMatrixSync;
/// fn requires_clone<T: Clone>() {}
/// requires_clone::<FetchedMatrixSync>();
/// ```
/// ```compile_fail
/// use communicator_matrix_gateway::matrix::FetchedMatrixSync;
/// fn requires_serialize<T: serde::Serialize>() {}
/// requires_serialize::<FetchedMatrixSync>();
/// ```
/// ```compile_fail
/// use communicator_matrix_gateway::matrix::FetchedMatrixSync;
/// fn requires_as_ref<T: AsRef<[u8]>>() {}
/// requires_as_ref::<FetchedMatrixSync>();
/// ```
/// ```compile_fail
/// use communicator_matrix_gateway::matrix::FetchedMatrixSync;
/// fn requires_deref<T: std::ops::Deref>() {}
/// requires_deref::<FetchedMatrixSync>();
/// ```
pub struct FetchedMatrixSync {
    request_token: SecretBytes,
    next_token: SecretBytes,
    exact_body: SecretBytes,
}

impl FetchedMatrixSync {
    pub(crate) fn from_parts(
        request_token: SecretBytes,
        next_token: SecretBytes,
        exact_body: SecretBytes,
    ) -> Result<Self, SafeError> {
        if request_token.is_empty() || next_token.is_empty() || exact_body.is_empty() {
            return Err(SafeError::new(MATRIX_RESPONSE_INVALID));
        }
        if request_token.len() > crate::store_types::MAX_SYNC_TOKEN_BYTES
            || next_token.len() > crate::store_types::MAX_SYNC_TOKEN_BYTES
        {
            return Err(SafeError::new(MATRIX_RESPONSE_TOO_LARGE));
        }
        if exact_body.len() > MAX_SYNC_RESPONSE_BYTES {
            return Err(SafeError::new(MATRIX_RESPONSE_TOO_LARGE));
        }
        Ok(Self {
            request_token,
            next_token,
            exact_body,
        })
    }

    /// Return the SHA-256 digest of the exact request token.
    pub fn request_token_sha256(&self) -> [u8; 32] {
        Sha256::digest(self.request_token.as_bytes()).into()
    }

    /// Return the SHA-256 digest of the exact response next token.
    pub fn next_token_sha256(&self) -> [u8; 32] {
        Sha256::digest(self.next_token.as_bytes()).into()
    }

    /// Return the exact transferred response byte count.
    pub fn byte_count(&self) -> usize {
        self.exact_body.len()
    }

    /// Move all protected buffers into the store's new-inbox DTO.
    pub fn into_store_input(
        self,
        observed_at: DateTime<Utc>,
    ) -> Result<NewRawSyncInbox, SafeError> {
        let Self {
            request_token,
            next_token,
            exact_body,
        } = self;
        NewRawSyncInbox::new(
            request_token.into_vec(),
            next_token.into_vec(),
            exact_body.into_vec(),
            observed_at,
        )
        .map_err(|error| {
            if error.code() == STORE_SYNC_TOO_LARGE {
                SafeError::new(MATRIX_RESPONSE_TOO_LARGE)
            } else {
                SafeError::new(MATRIX_RESPONSE_INVALID)
            }
        })
    }

    #[allow(dead_code)]
    pub(crate) fn request_token(&self) -> &SecretBytes {
        &self.request_token
    }

    #[allow(dead_code)]
    pub(crate) fn next_token(&self) -> &SecretBytes {
        &self.next_token
    }

    #[allow(dead_code)]
    pub(crate) fn exact_body(&self) -> &SecretBytes {
        &self.exact_body
    }
}

impl fmt::Debug for FetchedMatrixSync {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("FetchedMatrixSync([REDACTED])")
    }
}

impl fmt::Display for FetchedMatrixSync {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("FetchedMatrixSync([REDACTED])")
    }
}

/// One joined-room event observed while processing a saved sync response.
///
/// ```compile_fail
/// use communicator_matrix_gateway::matrix::ObservedMatrixEvent;
/// fn requires_clone<T: Clone>() {}
/// requires_clone::<ObservedMatrixEvent>();
/// ```
/// ```compile_fail
/// use communicator_matrix_gateway::matrix::ObservedMatrixEvent;
/// fn requires_serialize<T: serde::Serialize>() {}
/// requires_serialize::<ObservedMatrixEvent>();
/// ```
/// ```compile_fail
/// use communicator_matrix_gateway::matrix::ObservedMatrixEvent;
/// fn requires_as_ref<T: AsRef<[u8]>>() {}
/// requires_as_ref::<ObservedMatrixEvent>();
/// ```
/// ```compile_fail
/// use communicator_matrix_gateway::matrix::ObservedMatrixEvent;
/// fn requires_deref<T: std::ops::Deref>() {}
/// requires_deref::<ObservedMatrixEvent>();
/// ```
pub enum ObservedMatrixEvent {
    /// A joined-room timeline event.
    Timeline(ObservedRoomEvent),
    /// A joined-room state event.
    State(ObservedRoomEvent),
    /// A joined-room receipt event.
    Receipt(ObservedRoomEvent),
    /// A joined-room typing event.
    Typing(ObservedRoomEvent),
}

impl ObservedMatrixEvent {
    /// Return the stable, content-free event discriminant.
    pub const fn discriminant(&self) -> &'static str {
        match self {
            Self::Timeline(_) => "timeline",
            Self::State(_) => "state",
            Self::Receipt(_) => "receipt",
            Self::Typing(_) => "typing",
        }
    }

    /// Return the stable event kind.
    pub const fn kind(&self) -> &'static str {
        self.discriminant()
    }

    #[allow(dead_code)]
    pub(crate) fn room_event(&self) -> &ObservedRoomEvent {
        match self {
            Self::Timeline(event)
            | Self::State(event)
            | Self::Receipt(event)
            | Self::Typing(event) => event,
        }
    }
}

impl fmt::Debug for ObservedMatrixEvent {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("ObservedMatrixEvent([REDACTED])")
    }
}

impl fmt::Display for ObservedMatrixEvent {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("ObservedMatrixEvent([REDACTED])")
    }
}

/// Protected raw JSON for one joined-room observation.
///
/// ```compile_fail
/// use communicator_matrix_gateway::matrix::ObservedRoomEvent;
/// fn requires_clone<T: Clone>() {}
/// requires_clone::<ObservedRoomEvent>();
/// ```
/// ```compile_fail
/// use communicator_matrix_gateway::matrix::ObservedRoomEvent;
/// fn requires_serialize<T: serde::Serialize>() {}
/// requires_serialize::<ObservedRoomEvent>();
/// ```
/// ```compile_fail
/// use communicator_matrix_gateway::matrix::ObservedRoomEvent;
/// fn requires_as_ref<T: AsRef<[u8]>>() {}
/// requires_as_ref::<ObservedRoomEvent>();
/// ```
/// ```compile_fail
/// use communicator_matrix_gateway::matrix::ObservedRoomEvent;
/// fn requires_deref<T: std::ops::Deref>() {}
/// requires_deref::<ObservedRoomEvent>();
/// ```
#[allow(dead_code)]
pub struct ObservedRoomEvent {
    room_id: SecretBytes,
    exact_json: SecretBytes,
    unable_to_decrypt: bool,
}

#[allow(dead_code)]
impl ObservedRoomEvent {
    pub(crate) fn new(
        room_id: SecretBytes,
        exact_json: SecretBytes,
        unable_to_decrypt: bool,
    ) -> Result<Self, SafeError> {
        if room_id.is_empty() || exact_json.is_empty() {
            return Err(SafeError::new(MATRIX_RESPONSE_INVALID));
        }
        if exact_json.len() > crate::config::MAX_EVENT_CANONICAL_BYTES {
            return Err(SafeError::new(MATRIX_RESPONSE_TOO_LARGE));
        }
        Ok(Self {
            room_id,
            exact_json,
            unable_to_decrypt,
        })
    }

    pub(crate) fn room_id(&self) -> &SecretBytes {
        &self.room_id
    }

    pub(crate) fn exact_json(&self) -> &SecretBytes {
        &self.exact_json
    }

    pub(crate) const fn unable_to_decrypt(&self) -> bool {
        self.unable_to_decrypt
    }
}

impl fmt::Debug for ObservedRoomEvent {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("ObservedRoomEvent([REDACTED])")
    }
}

impl fmt::Display for ObservedRoomEvent {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("ObservedRoomEvent([REDACTED])")
    }
}

/// A bounded backward timeline gap that must be recovered before commitment.
///
/// ```compile_fail
/// use communicator_matrix_gateway::matrix::LimitedTimelineGap;
/// fn requires_clone<T: Clone>() {}
/// requires_clone::<LimitedTimelineGap>();
/// ```
/// ```compile_fail
/// use communicator_matrix_gateway::matrix::LimitedTimelineGap;
/// fn requires_serialize<T: serde::Serialize>() {}
/// requires_serialize::<LimitedTimelineGap>();
/// ```
/// ```compile_fail
/// use communicator_matrix_gateway::matrix::LimitedTimelineGap;
/// fn requires_as_ref<T: AsRef<[u8]>>() {}
/// requires_as_ref::<LimitedTimelineGap>();
/// ```
/// ```compile_fail
/// use communicator_matrix_gateway::matrix::LimitedTimelineGap;
/// fn requires_deref<T: std::ops::Deref>() {}
/// requires_deref::<LimitedTimelineGap>();
/// ```
#[allow(dead_code)]
pub struct LimitedTimelineGap {
    room_id: SecretBytes,
    prev_batch: SecretBytes,
}

#[allow(dead_code)]
impl LimitedTimelineGap {
    pub(crate) fn new(room_id: SecretBytes, prev_batch: SecretBytes) -> Result<Self, SafeError> {
        if room_id.is_empty() || prev_batch.is_empty() {
            return Err(SafeError::new(MATRIX_RESPONSE_INVALID));
        }
        if prev_batch.len() > crate::store_types::MAX_SYNC_TOKEN_BYTES {
            return Err(SafeError::new(MATRIX_RESPONSE_TOO_LARGE));
        }
        Ok(Self {
            room_id,
            prev_batch,
        })
    }

    pub(crate) fn room_id(&self) -> &SecretBytes {
        &self.room_id
    }

    pub(crate) fn prev_batch(&self) -> &SecretBytes {
        &self.prev_batch
    }
}

impl fmt::Debug for LimitedTimelineGap {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("LimitedTimelineGap([REDACTED])")
    }
}

impl fmt::Display for LimitedTimelineGap {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("LimitedTimelineGap([REDACTED])")
    }
}

/// Events and limited gaps extracted from one processed sync response.
///
/// ```compile_fail
/// use communicator_matrix_gateway::matrix::ProcessedSync;
/// fn requires_clone<T: Clone>() {}
/// requires_clone::<ProcessedSync>();
/// ```
/// ```compile_fail
/// use communicator_matrix_gateway::matrix::ProcessedSync;
/// fn requires_serialize<T: serde::Serialize>() {}
/// requires_serialize::<ProcessedSync>();
/// ```
/// ```compile_fail
/// use communicator_matrix_gateway::matrix::ProcessedSync;
/// fn requires_as_ref<T: AsRef<[u8]>>() {}
/// requires_as_ref::<ProcessedSync>();
/// ```
/// ```compile_fail
/// use communicator_matrix_gateway::matrix::ProcessedSync;
/// fn requires_deref<T: std::ops::Deref>() {}
/// requires_deref::<ProcessedSync>();
/// ```
pub struct ProcessedSync {
    events: Vec<ObservedMatrixEvent>,
    gaps: Vec<LimitedTimelineGap>,
}

#[allow(dead_code)]
impl ProcessedSync {
    pub(crate) fn new(events: Vec<ObservedMatrixEvent>, gaps: Vec<LimitedTimelineGap>) -> Self {
        Self { events, gaps }
    }

    /// Return the number of extracted joined-room events.
    pub fn event_count(&self) -> usize {
        self.events.len()
    }

    /// Return the number of limited timeline gaps.
    pub fn gap_count(&self) -> usize {
        self.gaps.len()
    }

    /// Return whether any extracted timeline event could not be decrypted.
    pub fn has_undecryptable_events(&self) -> bool {
        self.events.iter().any(|event| {
            matches!(event, ObservedMatrixEvent::Timeline(value) if value.unable_to_decrypt())
        })
    }

    pub(crate) fn events(&self) -> &[ObservedMatrixEvent] {
        &self.events
    }

    pub(crate) fn gaps(&self) -> &[LimitedTimelineGap] {
        &self.gaps
    }
}

impl fmt::Debug for ProcessedSync {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("ProcessedSync([REDACTED])")
    }
}

impl fmt::Display for ProcessedSync {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("ProcessedSync([REDACTED])")
    }
}

/// Proof that one persisted crypto response was acknowledged by the SDK.
///
/// ```compile_fail
/// use communicator_matrix_gateway::matrix::CryptoAckProof;
/// fn requires_clone<T: Clone>() {}
/// requires_clone::<CryptoAckProof>();
/// ```
/// ```compile_fail
/// use communicator_matrix_gateway::matrix::CryptoAckProof;
/// fn requires_serialize<T: serde::Serialize>() {}
/// requires_serialize::<CryptoAckProof>();
/// ```
/// ```compile_fail
/// use communicator_matrix_gateway::matrix::CryptoAckProof;
/// fn requires_as_ref<T: AsRef<[u8]>>() {}
/// requires_as_ref::<CryptoAckProof>();
/// ```
/// ```compile_fail
/// use communicator_matrix_gateway::matrix::CryptoAckProof;
/// fn requires_deref<T: std::ops::Deref>() {}
/// requires_deref::<CryptoAckProof>();
/// ```
/// ```compile_fail
/// use communicator_matrix_gateway::matrix::CryptoAckProof;
/// fn cannot_read_proof_details(proof: CryptoAckProof) {
///     let _ = proof.row_id();
///     let _ = proof.response_sha256();
/// }
/// ```
pub struct CryptoAckProof {
    row_id: String,
    response_sha256: [u8; 32],
}

#[allow(dead_code)]
impl CryptoAckProof {
    pub(crate) fn new(row_id: String, response_sha256: [u8; 32]) -> Self {
        Self {
            row_id,
            response_sha256,
        }
    }

    /// Return the synthetic persisted crypto-row identifier.
    pub(crate) fn row_id(&self) -> &str {
        &self.row_id
    }

    /// Return the digest of the exact acknowledged response bytes.
    pub(crate) fn response_sha256(&self) -> &[u8; 32] {
        &self.response_sha256
    }
}

impl fmt::Debug for CryptoAckProof {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("CryptoAckProof([REDACTED])")
    }
}

impl fmt::Display for CryptoAckProof {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("CryptoAckProof([REDACTED])")
    }
}

/// Result of restart-time rebinding of one persisted crypto response.
///
/// ```compile_fail
/// use communicator_matrix_gateway::matrix::RestartCryptoAck;
/// fn requires_clone<T: Clone>() {}
/// requires_clone::<RestartCryptoAck>();
/// ```
/// ```compile_fail
/// use communicator_matrix_gateway::matrix::RestartCryptoAck;
/// fn requires_serialize<T: serde::Serialize>() {}
/// requires_serialize::<RestartCryptoAck>();
/// ```
/// ```compile_fail
/// use communicator_matrix_gateway::matrix::RestartCryptoAck;
/// fn requires_as_ref<T: AsRef<[u8]>>() {}
/// requires_as_ref::<RestartCryptoAck>();
/// ```
/// ```compile_fail
/// use communicator_matrix_gateway::matrix::RestartCryptoAck;
/// fn requires_deref<T: std::ops::Deref>() {}
/// requires_deref::<RestartCryptoAck>();
/// ```
pub enum RestartCryptoAck {
    /// The saved response was applied to a fresh current request.
    Rebound(CryptoAckProof),
    /// The saved response was already proven present in the restored store.
    AlreadyApplied(CryptoAckProof),
    /// The saved response cannot be safely acknowledged after restart.
    Unrecoverable(ReasonCode),
}

#[allow(dead_code)]
impl RestartCryptoAck {
    /// Return the stable, content-free result discriminant.
    pub const fn discriminant(&self) -> &'static str {
        match self {
            Self::Rebound(_) => "rebound",
            Self::AlreadyApplied(_) => "already_applied",
            Self::Unrecoverable(_) => "unrecoverable",
        }
    }

    pub(crate) fn proof(&self) -> Option<&CryptoAckProof> {
        match self {
            Self::Rebound(proof) | Self::AlreadyApplied(proof) => Some(proof),
            Self::Unrecoverable(_) => None,
        }
    }

    pub(crate) fn reason(&self) -> Option<&ReasonCode> {
        match self {
            Self::Unrecoverable(reason) => Some(reason),
            Self::Rebound(_) | Self::AlreadyApplied(_) => None,
        }
    }
}

impl fmt::Debug for RestartCryptoAck {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("RestartCryptoAck([REDACTED])")
    }
}

impl fmt::Display for RestartCryptoAck {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("RestartCryptoAck([REDACTED])")
    }
}

/// The bounded raw Matrix HTTP port used by the service loop.
#[async_trait]
pub trait MatrixTransport: Send + Sync {
    async fn fetch_sync(&self, since: &SecretBytes) -> Result<FetchedMatrixSync, SafeError>;

    async fn send_crypto(
        &self,
        request: &PendingMatrixRequest,
    ) -> Result<RawMatrixResponse, SafeError>;
}

/// The SDK/application boundary used by the service loop.
#[async_trait]
pub trait MatrixProcessor: Send {
    async fn sdk_token_digest(&self) -> Result<Option<[u8; 32]>, SafeError>;

    async fn apply_saved_sync(
        &mut self,
        response: &RawSyncInbox,
    ) -> Result<ProcessedSync, SafeError>;

    async fn recover_saved_sync(
        &mut self,
        response: &RawSyncInbox,
    ) -> Result<ProcessedSync, SafeError>;

    async fn pending_crypto_requests(&self) -> Result<Vec<ExactMatrixRequest>, SafeError>;

    async fn apply_crypto_response(
        &mut self,
        request: &PendingMatrixRequest,
        response: &RawMatrixResponse,
    ) -> Result<CryptoAckProof, SafeError>;

    async fn rebind_saved_crypto_response(
        &mut self,
        saved: &SavedMatrixResponse,
    ) -> Result<RestartCryptoAck, SafeError>;
}

#[cfg(test)]
mod task1_red_tests {
    use chrono::{TimeZone, Utc};

    use super::*;

    #[test]
    fn fetched_sync_moves_all_exact_allocations_into_store_input() {
        let request_token = b"request-token".to_vec();
        let request_pointer = request_token.as_ptr();
        let next_token = b"next-token".to_vec();
        let next_pointer = next_token.as_ptr();
        let response = br#"{"next_batch":"next-token"}"#.to_vec();
        let response_pointer = response.as_ptr();
        let fetched = FetchedMatrixSync {
            request_token: SecretBytes::new(request_token),
            next_token: SecretBytes::new(next_token),
            exact_body: SecretBytes::new(response),
        };

        let observed_at = Utc
            .timestamp_millis_opt(1_700_000_000_000)
            .single()
            .expect("valid timestamp");
        let input = fetched
            .into_store_input(observed_at)
            .expect("valid store input");

        assert_eq!(
            input.response().as_bytes(),
            br#"{"next_batch":"next-token"}"#
        );
        assert_eq!(input.request_token().as_bytes().as_ptr(), request_pointer);
        assert_eq!(input.next_token().as_bytes().as_ptr(), next_pointer);
        assert_eq!(input.response().as_bytes().as_ptr(), response_pointer);
    }

    #[test]
    fn adapter_dtos_have_closed_redacted_formatting() {
        fn assert_redacted<T>(value: &T, expected: &str, canaries: &[&str])
        where
            T: fmt::Debug + fmt::Display,
        {
            assert_eq!(format!("{value:?}"), expected);
            assert_eq!(value.to_string(), expected);
            for canary in canaries {
                assert!(!format!("{value:?}").contains(canary));
                assert!(!value.to_string().contains(canary));
            }
        }

        let fetched = FetchedMatrixSync {
            request_token: SecretBytes::new(b"fetched-request-canary".to_vec()),
            next_token: SecretBytes::new(b"fetched-next-canary".to_vec()),
            exact_body: SecretBytes::new(b"fetched-body-canary".to_vec()),
        };
        assert_redacted(
            &fetched,
            "FetchedMatrixSync([REDACTED])",
            &[
                "fetched-request-canary",
                "fetched-next-canary",
                "fetched-body-canary",
            ],
        );

        let room_event = ObservedRoomEvent::new(
            SecretBytes::new(b"room-canary".to_vec()),
            SecretBytes::new(b"event-canary".to_vec()),
            true,
        )
        .expect("room event fixture");
        assert_redacted(
            &room_event,
            "ObservedRoomEvent([REDACTED])",
            &["room-canary", "event-canary"],
        );
        let observed = ObservedMatrixEvent::Timeline(room_event);
        assert_redacted(
            &observed,
            "ObservedMatrixEvent([REDACTED])",
            &["room-canary", "event-canary"],
        );

        let gap = LimitedTimelineGap::new(
            SecretBytes::new(b"gap-room-canary".to_vec()),
            SecretBytes::new(b"gap-token-canary".to_vec()),
        )
        .expect("gap fixture");
        assert_redacted(
            &gap,
            "LimitedTimelineGap([REDACTED])",
            &["gap-room-canary", "gap-token-canary"],
        );
        let processed = ProcessedSync::new(vec![observed], vec![gap]);
        assert_redacted(
            &processed,
            "ProcessedSync([REDACTED])",
            &[
                "room-canary",
                "event-canary",
                "gap-room-canary",
                "gap-token-canary",
            ],
        );

        let proof = CryptoAckProof::new("proof-row-canary".to_owned(), [0xA5; 32]);
        assert_redacted(&proof, "CryptoAckProof([REDACTED])", &["proof-row-canary"]);
        let rebound = RestartCryptoAck::Rebound(proof);
        assert_redacted(
            &rebound,
            "RestartCryptoAck([REDACTED])",
            &["proof-row-canary"],
        );
        let already_applied = RestartCryptoAck::AlreadyApplied(CryptoAckProof::new(
            "already-row-canary".to_owned(),
            [0x5A; 32],
        ));
        assert_redacted(
            &already_applied,
            "RestartCryptoAck([REDACTED])",
            &["already-row-canary"],
        );
        let unrecoverable = RestartCryptoAck::Unrecoverable(
            ReasonCode::new("unrecoverable_reason_canary").expect("reason fixture"),
        );
        assert_redacted(
            &unrecoverable,
            "RestartCryptoAck([REDACTED])",
            &["unrecoverable_reason_canary"],
        );
    }
}
