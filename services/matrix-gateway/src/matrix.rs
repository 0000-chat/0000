//! Compile-time and local-only probes for the Matrix SDK boundary.
//!
//! The daemon deliberately does not use [`matrix_sdk::Client::sync_once`].
//! These small adapters keep the raw response body available to the gateway
//! before handing a typed response to `BaseClient`.

use std::{
    collections::{BTreeMap, HashSet},
    fmt,
    fs::symlink_metadata,
    path::Path,
    str,
    time::Duration,
};

use async_trait::async_trait;
use chrono::{DateTime, Utc};
use http::{Request as HttpRequest, Response as HttpResponse, header::CONTENT_TYPE};
use matrix_sdk::{
    Client, SessionMeta, authentication::matrix::MatrixSession, config::RequestConfig,
};
use matrix_sdk_base::{
    BaseClient, DmRoomDefinition, RoomState, ThreadingSupport,
    store::RoomLoadSettings,
    sync::{JoinedRoomUpdate, State as SdkState, SyncResponse as SdkSyncResponse},
};
use matrix_sdk_common::cross_process_lock::CrossProcessLockConfig;
use matrix_sdk_crypto::{
    DecryptionSettings, MegolmError, TrustRequirement,
    types::requests::{AnyIncomingResponse, AnyOutgoingRequest, KeysQueryRequest},
};
use matrix_sdk_sqlite::{SqliteCryptoStore, SqliteStateStore};
use ruma::{
    OwnedEventId, OwnedRoomId, OwnedTransactionId, UserId,
    api::client::{
        keys::get_keys::v3::{Request as RumaKeysQueryRequest, Response as KeysQueryResponse},
        session::login::v3::{LoginInfo, Password, Request as LoginRequest},
        sync::sync_events::v3::Response as RumaSyncResponse,
        uiaa::{MatrixUserIdentifier, UserIdentifier},
    },
    api::{IncomingRequest, IncomingResponse},
    events::{
        AnyStateEvent, AnySyncEphemeralRoomEvent, AnySyncStateEvent, AnySyncTimelineEvent,
        AnyTimelineEvent,
    },
    serde::Raw,
};
use sha2::{Digest, Sha256};
use zeroize::Zeroize;

use crate::{
    crypto_outbox::{
        ExactMatrixRequest, PendingMatrixRequest, RawMatrixResponse, SavedMatrixResponse,
    },
    matrix_http::{ReqwestMatrixTransport, validate_bootstrap_homeserver_url},
    secret::{SafeError, SecretBytes},
    store::{STORE_SYNC_TOO_LARGE, Store},
    store_types::{
        InboxId, NewBootstrapState, NewRawSyncInbox, RawSyncInbox, ReasonCode, RoomAnchor,
    },
};

/// Re-export the central gateway response-size limit for transport callers.
pub use crate::config::MAX_SYNC_RESPONSE_BYTES;

/// Stable error returned when a Matrix history page cannot be fetched.
pub const MATRIX_HISTORY_UNAVAILABLE: &str = "matrix_history_unavailable";
/// Stable error returned when the private Matrix media descriptor is invalid.
pub const MATRIX_MEDIA_INVALID: &str = "matrix_media_invalid";
/// Stable error returned when a Matrix media object is absent.
pub const MATRIX_MEDIA_MISSING: &str = "matrix_media_missing";
/// Stable error returned when Matrix rejects the media request.
pub const MATRIX_MEDIA_REJECTED: &str = "matrix_media_rejected";
/// Stable error returned when a Matrix media request times out.
pub const MATRIX_MEDIA_TIMEOUT: &str = "matrix_media_timeout";
/// Stable error returned when Matrix cannot serve media.
pub const MATRIX_MEDIA_UNAVAILABLE: &str = "matrix_media_unavailable";
/// Stable error returned when a Matrix media response is too large.
pub const MATRIX_MEDIA_TOO_LARGE: &str = "matrix_media_too_large";
/// Stable error returned when Matrix returns no media bytes.
pub const MATRIX_MEDIA_EMPTY: &str = "matrix_media_empty";
/// Maximum bytes accepted by the private attachment boundary.
pub const MAX_MEDIA_BYTES: usize = 8 * 1024 * 1024;

/// Encrypted Matrix-file metadata retained behind the gateway boundary.
///
/// The key and IV are only ever serialized into the encrypted gateway store
/// and are never part of a canonical event or an HTTP response.
#[derive(Clone, Eq, PartialEq, serde::Serialize, serde::Deserialize)]
pub(crate) struct EncryptedMediaDescriptor {
    pub(crate) algorithm: String,
    pub(crate) key: Vec<u8>,
    pub(crate) iv: Vec<u8>,
    pub(crate) ciphertext_sha256: String,
}

impl Drop for EncryptedMediaDescriptor {
    fn drop(&mut self) {
        self.key.zeroize();
        self.iv.zeroize();
    }
}

/// The original Matrix media target retained for one attachment revision.
///
/// `server_name` and `media_id` come from the event's `mxc://` URI. The
/// transport pins the HTTP origin separately, so this value cannot introduce
/// an arbitrary upstream URL.
#[derive(Clone, Eq, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct MatrixMediaDescriptor {
    pub(crate) server_name: String,
    pub(crate) media_id: String,
    pub(crate) mime_type: Option<String>,
    pub(crate) source_sha256: Option<String>,
    pub(crate) encrypted: Option<EncryptedMediaDescriptor>,
}

impl fmt::Debug for MatrixMediaDescriptor {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("MatrixMediaDescriptor([REDACTED])")
    }
}

/// Bounded bytes and content type returned by the Matrix media transport.
pub struct FetchedMatrixMedia {
    bytes: SecretBytes,
    mime_type: String,
}

impl fmt::Debug for FetchedMatrixMedia {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("FetchedMatrixMedia([REDACTED])")
    }
}

impl FetchedMatrixMedia {
    pub(crate) fn new(bytes: Vec<u8>, mime_type: String) -> Result<Self, SafeError> {
        if bytes.is_empty() {
            return Err(SafeError::new(MATRIX_MEDIA_EMPTY));
        }
        if bytes.len() > MAX_MEDIA_BYTES {
            return Err(SafeError::new(MATRIX_MEDIA_TOO_LARGE));
        }
        Ok(Self {
            bytes: SecretBytes::new(bytes),
            mime_type,
        })
    }

    pub(crate) fn into_parts(self) -> (SecretBytes, String) {
        (self.bytes, self.mime_type)
    }
}

/// A bounded raw response from Matrix's room-message pagination endpoint.
///
/// Event bodies stay in Ruma's raw wrapper until the history boundary decides
/// how to normalize them. The transport layer does not deserialize provider
/// or projection payloads.
pub struct RawBackfillPage {
    start: String,
    end: Option<String>,
    chunk: Vec<Raw<AnyTimelineEvent>>,
    state: Vec<Raw<AnyStateEvent>>,
}

impl RawBackfillPage {
    /// Construct one validated page returned by Matrix.
    pub(crate) fn new(
        start: String,
        end: Option<String>,
        chunk: Vec<Raw<AnyTimelineEvent>>,
        state: Vec<Raw<AnyStateEvent>>,
    ) -> Result<Self, SafeError> {
        if start.is_empty()
            || start.len() > crate::store_types::MAX_SYNC_TOKEN_BYTES
            || end.as_deref().is_some_and(|value| {
                value.is_empty() || value.len() > crate::store_types::MAX_SYNC_TOKEN_BYTES
            })
        {
            return Err(SafeError::new(MATRIX_RESPONSE_INVALID));
        }
        Ok(Self {
            start,
            end,
            chunk,
            state,
        })
    }

    /// Return the Matrix token at the beginning of this page.
    pub fn start(&self) -> &str {
        &self.start
    }

    /// Return the next Matrix pagination token, when one exists.
    pub fn end(&self) -> Option<&str> {
        self.end.as_deref()
    }

    /// Borrow the raw timeline events in Matrix response order.
    pub fn chunk(&self) -> &[Raw<AnyTimelineEvent>] {
        &self.chunk
    }

    /// Borrow the raw state events included for this page.
    pub fn state(&self) -> &[Raw<AnyStateEvent>] {
        &self.state
    }
}

async fn open_unactivated_base_client(
    state_path: impl AsRef<Path>,
    crypto_path: impl AsRef<Path>,
    passphrase: &str,
) -> Result<BaseClient, SafeError> {
    let state = SqliteStateStore::open(state_path, Some(passphrase))
        .await
        .map_err(|_| SafeError::new(MATRIX_SESSION_INVALID))?;
    let crypto = SqliteCryptoStore::open(crypto_path, Some(passphrase))
        .await
        .map_err(|_| SafeError::new(MATRIX_SESSION_INVALID))?;
    let base = BaseClient::new(
        matrix_sdk_base::store::StoreConfig::new(CrossProcessLockConfig::SingleProcess)
            .state_store(state)
            .crypto_store(crypto),
        ThreadingSupport::Disabled,
        DmRoomDefinition::default(),
    );
    Ok(base)
}

#[cfg(test)]
async fn open_activated_base_client(
    state_path: impl AsRef<Path>,
    crypto_path: impl AsRef<Path>,
    passphrase: &str,
    session_meta: SessionMeta,
) -> Result<BaseClient, SafeError> {
    let base = open_unactivated_base_client(state_path, crypto_path, passphrase).await?;
    base.activate(session_meta, RoomLoadSettings::default(), None)
        .await
        .map_err(|_| SafeError::new(MATRIX_SESSION_INVALID))?;
    Ok(base)
}

fn serialize_matrix_session(session: &MatrixSession) -> Result<SecretBytes, SafeError> {
    serde_json::to_vec(session)
        .map(SecretBytes::new)
        .map_err(|_| SafeError::new(MATRIX_SESSION_INVALID))
}

fn deserialize_matrix_session(bytes: &SecretBytes) -> Result<MatrixSession, SafeError> {
    serde_json::from_slice(bytes.as_bytes()).map_err(|_| SafeError::new(MATRIX_SESSION_INVALID))
}

async fn open_restored_base_client(
    state_path: impl AsRef<Path>,
    crypto_path: impl AsRef<Path>,
    passphrase: &str,
    session_meta: SessionMeta,
) -> Result<BaseClient, SafeError> {
    let state = SqliteStateStore::open(state_path, Some(passphrase))
        .await
        .map_err(|_| SafeError::new(MATRIX_SESSION_INVALID))?;
    let crypto = SqliteCryptoStore::open(crypto_path, Some(passphrase))
        .await
        .map_err(|_| SafeError::new(MATRIX_SESSION_INVALID))?;
    let account = match matrix_sdk_crypto::store::CryptoStore::load_account(&crypto).await {
        Ok(Some(account)) => account,
        Ok(None) | Err(_) => return Err(SafeError::new(MATRIX_SESSION_INVALID)),
    };
    if account.user_id() != session_meta.user_id || account.device_id() != session_meta.device_id {
        return Err(SafeError::new(MATRIX_SESSION_INVALID));
    }

    let base = BaseClient::new(
        matrix_sdk_base::store::StoreConfig::new(CrossProcessLockConfig::SingleProcess)
            .state_store(state)
            .crypto_store(crypto),
        ThreadingSupport::Disabled,
        DmRoomDefinition::default(),
    );
    base.activate(session_meta, RoomLoadSettings::default(), None)
        .await
        .map_err(|_| SafeError::new(MATRIX_SESSION_INVALID))?;
    Ok(base)
}

/// Restore the one high-level SDK client used by the private outbound route.
///
/// The client is built around one unactivated `BaseClient` and restores the
/// persisted session exactly once. The returned client therefore shares the
/// activated Olm machine and SQLite stores with no second crypto client.
pub async fn restore_matrix_client(
    homeserver_url: &str,
    expected_user_id: &str,
    sdk_store_path: &Path,
    sdk_store_passphrase: &SecretBytes,
    state_store: &Store,
) -> Result<Client, SafeError> {
    let expected_user_id = parse_matrix_user_id(expected_user_id)?;
    validate_bootstrap_homeserver_url(homeserver_url)?;
    let session_bytes = state_store
        .matrix_session()
        .map_err(|_| SafeError::new(MATRIX_SESSION_INVALID))?
        .ok_or_else(|| SafeError::new(MATRIX_SESSION_INVALID))?;
    let session = deserialize_matrix_session(&session_bytes)?;
    if session.meta.user_id != expected_user_id || session.tokens.access_token.is_empty() {
        return Err(SafeError::new(MATRIX_SESSION_INVALID));
    }
    let passphrase = secret_utf8(sdk_store_passphrase, MATRIX_SESSION_INVALID)?;
    inspect_sdk_store_path(sdk_store_path, true)?;
    inspect_persisted_sdk_store(sdk_store_path)?;
    let base = open_unactivated_base_client(sdk_store_path, sdk_store_path, passphrase).await?;
    let client = match Client::builder()
        .homeserver_url(homeserver_url)
        .server_versions([ruma::api::MatrixVersion::V1_1])
        .request_config(RequestConfig::default().disable_retry())
        .base_client(base.clone())
        .build()
        .await
    {
        Ok(client) => client,
        Err(_) => {
            let _ = base.close_stores().await;
            return Err(SafeError::new(MATRIX_SESSION_INVALID));
        }
    };
    if client.restore_session(session.clone()).await.is_err() {
        drop(client);
        let _ = base.close_stores().await;
        return Err(SafeError::new(MATRIX_SESSION_INVALID));
    }
    let valid_account = base.session_meta().is_some_and(|meta| {
        meta.user_id == session.meta.user_id && meta.device_id == session.meta.device_id
    });
    let machine_guard = base.olm_machine().await;
    let valid_machine = machine_guard.as_ref().is_some_and(|machine| {
        machine.user_id() == session.meta.user_id && machine.device_id() == session.meta.device_id
    });
    drop(machine_guard);
    if !valid_account || !valid_machine {
        drop(client);
        let _ = base.close_stores().await;
        return Err(SafeError::new(MATRIX_SESSION_INVALID));
    }
    Ok(client)
}

/// Public SDK-backed Matrix processing seam used after bootstrap or restore.
pub struct MatrixSdkProcessor {
    base: BaseClient,
    recovery_frontier: RecoveryFrontier,
    pending_keys_query: std::sync::Mutex<Option<PendingSdkKeysQuery>>,
}

#[derive(Default)]
struct RecoveryFrontier {
    inbox_ids: HashSet<String>,
}

impl RecoveryFrontier {
    fn from_inbox_ids(ids: Vec<InboxId>) -> Self {
        Self {
            inbox_ids: ids
                .into_iter()
                .map(|inbox_id| inbox_id.as_str().to_owned())
                .collect(),
        }
    }

    fn contains(&self, inbox_id: &InboxId) -> bool {
        self.inbox_ids.contains(inbox_id.as_str())
    }

    fn include(&mut self, inbox_id: &InboxId) {
        self.inbox_ids.insert(inbox_id.as_str().to_owned());
    }
}

struct PendingSdkKeysQuery {
    request_id: SecretBytes,
    request_sha256: [u8; 32],
}

fn inspect_sdk_store_path(path: &Path, require_nonempty: bool) -> Result<(), SafeError> {
    let metadata = match symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound && !require_nonempty => {
            return Ok(());
        }
        Err(_) => return Err(SafeError::new(MATRIX_SESSION_INVALID)),
    };
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(SafeError::new(MATRIX_SESSION_INVALID));
    }

    let mut entries =
        std::fs::read_dir(path).map_err(|_| SafeError::new(MATRIX_SESSION_INVALID))?;
    let has_entry = entries
        .next()
        .transpose()
        .map_err(|_| SafeError::new(MATRIX_SESSION_INVALID))?
        .is_some();
    if require_nonempty != has_entry {
        return Err(SafeError::new(MATRIX_SESSION_INVALID));
    }
    Ok(())
}

fn inspect_persisted_sdk_store(path: &Path) -> Result<(), SafeError> {
    for filename in [
        matrix_sdk_sqlite::STATE_STORE_DATABASE_NAME,
        "matrix-sdk-crypto.sqlite3",
    ] {
        let metadata = symlink_metadata(path.join(filename))
            .map_err(|_| SafeError::new(MATRIX_SESSION_INVALID))?;
        if metadata.file_type().is_symlink() || !metadata.is_file() {
            return Err(SafeError::new(MATRIX_SESSION_INVALID));
        }
    }
    Ok(())
}

fn secret_utf8<'a>(value: &'a SecretBytes, empty_code: &'static str) -> Result<&'a str, SafeError> {
    if value.is_empty() {
        return Err(SafeError::new(empty_code));
    }
    str::from_utf8(value.as_bytes()).map_err(|_| SafeError::new(empty_code))
}

const BOOTSTRAP_REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
const BOOTSTRAP_SYNC_TIMEOUT: Duration = Duration::from_secs(30);

fn new_bootstrap_transport(
    homeserver_url: &str,
    access_token: SecretBytes,
) -> Result<ReqwestMatrixTransport, SafeError> {
    #[cfg(test)]
    {
        ReqwestMatrixTransport::new_for_test(
            homeserver_url,
            access_token,
            BOOTSTRAP_REQUEST_TIMEOUT,
            BOOTSTRAP_SYNC_TIMEOUT,
        )
    }
    #[cfg(not(test))]
    {
        ReqwestMatrixTransport::new(
            homeserver_url,
            access_token,
            BOOTSTRAP_REQUEST_TIMEOUT,
            BOOTSTRAP_SYNC_TIMEOUT,
        )
    }
}

fn parse_matrix_user_id(value: &str) -> Result<ruma::OwnedUserId, SafeError> {
    if value.is_empty() {
        return Err(SafeError::new(MATRIX_SESSION_INVALID));
    }
    let user_id = UserId::parse(value).map_err(|_| SafeError::new(MATRIX_SESSION_INVALID))?;
    if user_id.as_str() != value {
        return Err(SafeError::new(MATRIX_SESSION_INVALID));
    }
    Ok(user_id)
}

fn reject_invalid_memberships(response: &RumaSyncResponse) -> Result<(), SafeError> {
    if !response.rooms.invite.is_empty() || !response.rooms.leave.is_empty() {
        return Err(SafeError::new(MATRIX_ROOM_MEMBERSHIP_INVALID));
    }
    Ok(())
}

fn optional_event_id_from_raw<T>(event: &Raw<T>) -> Result<Option<OwnedEventId>, SafeError> {
    event
        .get_field::<OwnedEventId>("event_id")
        .map_err(|_| SafeError::new(MATRIX_RESPONSE_INVALID))
}

pub(crate) fn validate_raw_event_room<T>(
    event: &Raw<T>,
    room_id: &OwnedRoomId,
) -> Result<(), SafeError> {
    let embedded_room = event
        .get_field::<OwnedRoomId>("room_id")
        .map_err(|_| SafeError::new(MATRIX_RESPONSE_INVALID))?;
    if embedded_room.is_some_and(|embedded| embedded != *room_id) {
        return Err(SafeError::new(MATRIX_RESPONSE_INVALID));
    }
    Ok(())
}

fn validate_response_event_rooms(response: &RumaSyncResponse) -> Result<(), SafeError> {
    for (room_id, room) in &response.rooms.join {
        for event in &room.timeline.events {
            validate_raw_event_room(event, room_id)?;
        }
        let state_events = match &room.state {
            ruma::api::client::sync::sync_events::v3::State::Before(state)
            | ruma::api::client::sync::sync_events::v3::State::After(state) => &state.events,
            _ => return Err(SafeError::new(MATRIX_RESPONSE_INVALID)),
        };
        for event in state_events {
            validate_raw_event_room(event, room_id)?;
        }
        for event in &room.ephemeral.events {
            validate_raw_event_room(event, room_id)?;
        }
    }
    Ok(())
}

fn validate_response_event_ids(response: &RumaSyncResponse) -> Result<(), SafeError> {
    let mut event_ids = HashSet::new();
    for room in response.rooms.join.values() {
        for event in &room.timeline.events {
            if let Some(event_id) = optional_event_id_from_raw(event)?
                && !event_ids.insert(event_id)
            {
                return Err(SafeError::new(MATRIX_RESPONSE_INVALID));
            }
        }
        let state_events = match &room.state {
            ruma::api::client::sync::sync_events::v3::State::Before(state)
            | ruma::api::client::sync::sync_events::v3::State::After(state) => &state.events,
            _ => return Err(SafeError::new(MATRIX_RESPONSE_INVALID)),
        };
        for event in state_events {
            if let Some(event_id) = optional_event_id_from_raw(event)?
                && !event_ids.insert(event_id)
            {
                return Err(SafeError::new(MATRIX_RESPONSE_INVALID));
            }
        }
    }
    Ok(())
}

fn bootstrap_anchors(
    response: &RumaSyncResponse,
    state_store: &Store,
) -> Result<Vec<RoomAnchor>, SafeError> {
    let mut rooms: Vec<_> = response.rooms.join.iter().collect();
    rooms.sort_by(|(left, _), (right, _)| left.as_str().as_bytes().cmp(right.as_str().as_bytes()));
    let mut anchors = Vec::new();
    for (room_id, room) in rooms {
        let Some(last) = room.timeline.events.last() else {
            continue;
        };
        let Some(event_id) = optional_event_id_from_raw(last)? else {
            continue;
        };
        let lookup = state_store.matrix_room_lookup(room_id.as_str())?;
        anchors.push(RoomAnchor::new(lookup, event_id.as_bytes().to_vec())?);
    }
    Ok(anchors)
}

/// Bootstrap one persistent Matrix E2EE session and its application checkpoint.
pub async fn bootstrap_matrix(
    homeserver_url: &str,
    matrix_user_id: &str,
    sdk_store_path: &Path,
    password: &SecretBytes,
    sdk_store_passphrase: &SecretBytes,
    state_store: &mut Store,
    bootstrapped_at: DateTime<Utc>,
) -> Result<(), SafeError> {
    if state_store
        .matrix_session()
        .map_err(|_| SafeError::new(MATRIX_SESSION_INVALID))?
        .is_some()
    {
        return Err(SafeError::new(MATRIX_SESSION_INVALID));
    }
    let user_id = parse_matrix_user_id(matrix_user_id)?;
    let password = secret_utf8(password, MATRIX_SESSION_INVALID)?;
    let passphrase = secret_utf8(sdk_store_passphrase, MATRIX_SESSION_INVALID)?;
    inspect_sdk_store_path(sdk_store_path, false)?;
    validate_bootstrap_homeserver_url(homeserver_url)?;

    let base = open_unactivated_base_client(sdk_store_path, sdk_store_path, passphrase)
        .await
        .map_err(|_| SafeError::new(MATRIX_SESSION_INVALID));
    let base = match base {
        Ok(base) => base,
        Err(error) => return Err(error),
    };
    let client = match Client::builder()
        .homeserver_url(homeserver_url)
        .sqlite_store(sdk_store_path, Some(passphrase))
        .server_versions([ruma::api::MatrixVersion::V1_1])
        .request_config(RequestConfig::default().disable_retry())
        .base_client(base.clone())
        .build()
        .await
    {
        Ok(client) => client,
        Err(_) => {
            let _ = base.close_stores().await;
            return Err(SafeError::new(MATRIX_SESSION_INVALID));
        }
    };
    // Send the one password login through the high-level SDK HTTP client, but
    // do not call `MatrixAuth::login_username`. That convenience method starts
    // the SDK's asynchronous E2EE initialization task, which performs its own
    // account-data reads before bootstrap's deliberately single raw sync.
    let login_info = LoginInfo::Password(Password::new(
        UserIdentifier::Matrix(MatrixUserIdentifier::new(matrix_user_id.to_owned())),
        password.to_owned(),
    ));
    let mut login_request = LoginRequest::new(login_info);
    login_request.initial_device_display_name = Some("communicator-matrix-gateway".to_owned());
    let login = match client
        .send(login_request)
        .with_request_config(RequestConfig::default().disable_retry())
        .await
    {
        Ok(response) => response,
        Err(_) => {
            let _ = base.close_stores().await;
            return Err(SafeError::new(MATRIX_SESSION_INVALID));
        }
    };
    let session = MatrixSession::from(&login);
    if session.meta.user_id != user_id
        || session.meta.device_id.as_str().is_empty()
        || session.tokens.access_token.is_empty()
    {
        let _ = base.close_stores().await;
        return Err(SafeError::new(MATRIX_SESSION_INVALID));
    }
    if base
        .activate(session.meta.clone(), RoomLoadSettings::default(), None)
        .await
        .is_err()
    {
        let _ = base.close_stores().await;
        return Err(SafeError::new(MATRIX_SESSION_INVALID));
    }
    // The SDK login request above intentionally does not install a high-level
    // Client session. The activated BaseClient is the logged-in SDK seam used
    // for the one initial response, and dropping the HTTP Client here ensures
    // no background SDK task can issue additional requests.
    drop(client);
    let access_token = SecretBytes::from_slice(session.tokens.access_token.as_bytes());
    let transport = match new_bootstrap_transport(homeserver_url, access_token) {
        Ok(transport) => transport,
        Err(error) => {
            let _ = base.close_stores().await;
            return Err(error);
        }
    };
    let (mut body, typed) = match transport.fetch_sync_bytes(None).await {
        Ok(value) => value,
        Err(error) => {
            let _ = base.close_stores().await;
            return Err(error);
        }
    };
    drop(transport);
    if let Err(error) = reject_invalid_memberships(&typed)
        .and_then(|_| validate_response_event_ids(&typed))
        .and_then(|_| validate_response_event_rooms(&typed))
    {
        body.zeroize();
        let _ = base.close_stores().await;
        return Err(error);
    }
    let anchors = match bootstrap_anchors(&typed, state_store) {
        Ok(anchors) => anchors,
        Err(error) => {
            body.zeroize();
            let _ = base.close_stores().await;
            return Err(error);
        }
    };
    let initial_token_text = typed.next_batch.clone();
    let initial_token = initial_token_text.as_bytes().to_vec();
    if base.receive_sync_response(typed).await.is_err() {
        body.zeroize();
        let _ = base.close_stores().await;
        return Err(SafeError::new(MATRIX_SDK_FAILED));
    }
    if base.sync_token().await.as_deref() != Some(initial_token_text.as_str()) {
        body.zeroize();
        let _ = base.close_stores().await;
        return Err(SafeError::new(MATRIX_SDK_FAILED));
    }
    let serialized = match serialize_matrix_session(&session) {
        Ok(serialized) => serialized,
        Err(_) => {
            body.zeroize();
            let _ = base.close_stores().await;
            return Err(SafeError::new(MATRIX_SESSION_INVALID));
        }
    };
    body.zeroize();
    let bootstrap_state = NewBootstrapState::new(
        serialized.into_vec(),
        initial_token,
        anchors,
        bootstrapped_at,
    )
    .map_err(|_| SafeError::new(MATRIX_SESSION_INVALID));
    if bootstrap_state
        .and_then(|state| {
            state_store
                .initialize_bootstrap_state(state)
                .map_err(|_| SafeError::new(MATRIX_SESSION_INVALID))
        })
        .is_err()
    {
        let _ = base.close_stores().await;
        return Err(SafeError::new(MATRIX_SESSION_INVALID));
    }
    base.close_stores()
        .await
        .map_err(|_| SafeError::new(MATRIX_SDK_FAILED))
}

/// Restore a Matrix SDK processor without performing any network operation.
pub async fn restore_matrix_processor(
    homeserver_url: &str,
    expected_user_id: &str,
    sdk_store_path: &Path,
    sdk_store_passphrase: &SecretBytes,
    state_store: &Store,
) -> Result<MatrixSdkProcessor, SafeError> {
    // The homeserver is intentionally unused during restore. Keep the
    // argument in the public seam for parity with bootstrap, but do not parse,
    // discover, or otherwise contact it: restoration is strictly offline.
    let _ = homeserver_url;
    let expected_user_id = parse_matrix_user_id(expected_user_id)?;
    let session_bytes = state_store
        .matrix_session()
        .map_err(|_| SafeError::new(MATRIX_SESSION_INVALID))?
        .ok_or_else(|| SafeError::new(MATRIX_SESSION_INVALID))?;
    let session = deserialize_matrix_session(&session_bytes)?;
    if session.meta.user_id != expected_user_id || session.tokens.access_token.is_empty() {
        return Err(SafeError::new(MATRIX_SESSION_INVALID));
    }
    let passphrase = secret_utf8(sdk_store_passphrase, MATRIX_SESSION_INVALID)?;
    inspect_sdk_store_path(sdk_store_path, true)?;
    inspect_persisted_sdk_store(sdk_store_path)?;
    let base = open_restored_base_client(
        sdk_store_path,
        sdk_store_path,
        passphrase,
        session.meta.clone(),
    )
    .await?;
    let sdk_token = base.sync_token().await;
    let recovery_frontier = sdk_token.as_ref().and_then(|token| {
        let digest: [u8; 32] = Sha256::digest(token.as_bytes()).into();
        state_store.recoverable_inbox_ids(&digest).ok()
    });
    let valid_position = recovery_frontier.is_some();
    let valid_account = base.session_meta().is_some_and(|meta| {
        meta.user_id == session.meta.user_id && meta.device_id == session.meta.device_id
    }) && valid_position;
    let machine_guard = base.olm_machine().await;
    let valid_machine = machine_guard.as_ref().is_some_and(|machine| {
        machine.user_id() == session.meta.user_id && machine.device_id() == session.meta.device_id
    });
    drop(machine_guard);
    if !valid_account || !valid_machine {
        let _ = base.close_stores().await;
        return Err(SafeError::new(MATRIX_SESSION_INVALID));
    }
    let Some(recovery_frontier) = recovery_frontier else {
        let _ = base.close_stores().await;
        return Err(SafeError::new(MATRIX_SESSION_INVALID));
    };
    Ok(MatrixSdkProcessor {
        base,
        recovery_frontier: RecoveryFrontier::from_inbox_ids(recovery_frontier),
        pending_keys_query: std::sync::Mutex::new(None),
    })
}

/// Extract the persisted Matrix access token for the receive-only HTTP
/// transport after validating the stored session identity.  The token is
/// returned only to the in-process transport constructor and is never
/// formatted, serialized, or exposed through an administrative command.
pub fn matrix_access_token(
    session_bytes: &SecretBytes,
    expected_user_id: &str,
) -> Result<SecretBytes, SafeError> {
    let expected_user_id = parse_matrix_user_id(expected_user_id)?;
    let session = deserialize_matrix_session(session_bytes)?;
    if session.meta.user_id != expected_user_id || session.tokens.access_token.is_empty() {
        return Err(SafeError::new(MATRIX_SESSION_INVALID));
    }
    Ok(SecretBytes::from_slice(
        session.tokens.access_token.as_bytes(),
    ))
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
    let device_keys = match serde_json::to_value(&request.device_keys) {
        Ok(value) => value,
        Err(_) => serde_json::Value::Null,
    };
    let timeout = request
        .timeout
        .map(|timeout| serde_json::Value::from(timeout.as_millis() as u64))
        .unwrap_or(serde_json::Value::Null);
    let body = serde_json::json!({
        "device_keys": device_keys,
        "timeout": timeout,
    });
    let encoded = crate::canonical::canonical_json_bytes(&body)
        .unwrap_or_else(|_| b"matrix-crypto-request-invalid".to_vec());
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
    /// Construct a bounded fetched response from already protected values.
    pub fn from_parts(
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
    /// Construct one bounded protected room observation.
    pub fn new(
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
    /// Construct one bounded protected timeline-gap descriptor.
    pub fn new(room_id: SecretBytes, prev_batch: SecretBytes) -> Result<Self, SafeError> {
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
    /// Construct a processed response from validated adapter observations.
    pub fn new(events: Vec<ObservedMatrixEvent>, gaps: Vec<LimitedTimelineGap>) -> Self {
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
    /// Construct an acknowledgement proof from a verified row and response digest.
    pub fn new(row_id: String, response_sha256: [u8; 32]) -> Self {
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

    /// Fetch and, when required, decrypt one protected Matrix media object.
    /// The descriptor is produced from an authenticated room event; callers
    /// cannot provide an arbitrary URL or Matrix media ID.
    async fn fetch_media(
        &self,
        descriptor: &MatrixMediaDescriptor,
    ) -> Result<FetchedMatrixMedia, SafeError> {
        let _ = descriptor;
        Err(SafeError::new(MATRIX_MEDIA_UNAVAILABLE))
    }

    /// Fetch one bounded backward room-history page.
    ///
    /// Implementations that do not expose history retain the receive-only
    /// service boundary by returning a stable unavailable error.
    async fn backfill_page(
        &self,
        room_id: &str,
        from: Option<&SecretBytes>,
        limit: u64,
    ) -> Result<RawBackfillPage, SafeError> {
        let _ = (room_id, from, limit);
        Err(SafeError::new(MATRIX_HISTORY_UNAVAILABLE))
    }

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

fn canonical_keys_query_request(request: &KeysQueryRequest) -> Result<Vec<u8>, SafeError> {
    let device_keys = serde_json::to_value(&request.device_keys)
        .map_err(|_| SafeError::new(MATRIX_SDK_FAILED))?;
    let timeout = request
        .timeout
        .map(|value| serde_json::Value::from(value.as_millis() as u64))
        .unwrap_or(serde_json::Value::Null);
    crate::canonical::canonical_json_bytes(&serde_json::json!({
        "device_keys": device_keys,
        "timeout": timeout,
    }))
    .map_err(|_| SafeError::new(MATRIX_SDK_FAILED))
}

fn parse_transaction_id(bytes: &[u8]) -> Result<OwnedTransactionId, SafeError> {
    if bytes.is_empty() || bytes.len() > crate::crypto_outbox::MAX_SDK_REQUEST_ID_BYTES {
        return Err(SafeError::new(MATRIX_RESPONSE_INVALID));
    }
    let value = str::from_utf8(bytes).map_err(|_| SafeError::new(MATRIX_RESPONSE_INVALID))?;
    if value.is_empty() {
        return Err(SafeError::new(MATRIX_RESPONSE_INVALID));
    }
    Ok(value.to_owned().into())
}

fn parse_keys_query_response(body: &SecretBytes) -> Result<KeysQueryResponse, SafeError> {
    if body.is_empty() || body.len() > crate::crypto_outbox::MAX_MATRIX_CRYPTO_RESPONSE_BYTES {
        return Err(
            if body.len() > crate::crypto_outbox::MAX_MATRIX_CRYPTO_RESPONSE_BYTES {
                SafeError::new(MATRIX_RESPONSE_TOO_LARGE)
            } else {
                SafeError::new(MATRIX_RESPONSE_EMPTY)
            },
        );
    }
    let response = HttpResponse::builder()
        .status(http::StatusCode::OK)
        .header(CONTENT_TYPE, "application/json")
        .body(body.as_bytes())
        .map_err(|_| SafeError::new(MATRIX_RESPONSE_INVALID))?;
    KeysQueryResponse::try_from_http_response(response)
        .map_err(|_| SafeError::new(MATRIX_RESPONSE_INVALID))
}

fn unrecoverable_ack() -> RestartCryptoAck {
    RestartCryptoAck::Unrecoverable(
        ReasonCode::new(MATRIX_CRYPTO_ACK_UNRECOVERABLE)
            .expect("the static acknowledgement reason is valid"),
    )
}

fn cross_signing_keys_equal(
    left: &matrix_sdk_crypto::types::CrossSigningKey,
    right: &matrix_sdk_crypto::types::CrossSigningKey,
) -> bool {
    let Ok(mut left) = serde_json::to_value(left) else {
        return false;
    };
    let Ok(mut right) = serde_json::to_value(right) else {
        return false;
    };
    for value in [&mut left, &mut right] {
        let remove_unsigned = if let Some(unsigned) = value
            .get_mut("unsigned")
            .and_then(|value| value.as_object_mut())
        {
            unsigned.remove("device_display_name");
            unsigned.is_empty()
        } else {
            false
        };
        if remove_unsigned {
            let Some(object) = value.as_object_mut() else {
                return false;
            };
            object.remove("unsigned");
        }
    }
    left == right
}

fn signed_device_keys_equal(
    stored: &matrix_sdk_crypto::Device,
    response: &matrix_sdk_crypto::types::DeviceKeys,
) -> bool {
    let Ok(mut stored) = serde_json::to_value(stored.as_device_keys()) else {
        return false;
    };
    let Ok(mut response) = serde_json::to_value(response) else {
        return false;
    };
    for value in [&mut stored, &mut response] {
        let remove_unsigned = if let Some(unsigned) = value
            .get_mut("unsigned")
            .and_then(|value| value.as_object_mut())
        {
            unsigned.remove("device_display_name");
            unsigned.is_empty()
        } else {
            false
        };
        if remove_unsigned {
            let Some(object) = value.as_object_mut() else {
                return false;
            };
            object.remove("unsigned");
        }
    }
    stored == response
}

fn verify_cross_signing_signature(
    signer: &matrix_sdk_crypto::types::CrossSigningKey,
    signed: &matrix_sdk_crypto::types::CrossSigningKey,
) -> bool {
    let Some((key_id, signing_key)) = signer.get_first_key_and_id() else {
        return false;
    };
    let Ok(value) = serde_json::to_value(signed) else {
        return false;
    };
    let Ok(mut canonical) = ruma::canonical_json::to_canonical_value(value) else {
        return false;
    };
    let Some(object) = canonical.as_object_mut() else {
        return false;
    };
    object.remove("signatures");
    object.remove("unsigned");
    let Some(signature) = signed.signatures.get_signature(&signed.user_id, key_id) else {
        return false;
    };
    signing_key
        .verify(canonical.to_string().as_bytes(), &signature)
        .is_ok()
}

fn has_nonempty_saved_key_maps(response: &KeysQueryResponse) -> bool {
    if response.device_keys.is_empty()
        || response.master_keys.is_empty()
        || response.self_signing_keys.is_empty()
        || response.user_signing_keys.is_empty()
        || response.device_keys.values().any(BTreeMap::is_empty)
    {
        return false;
    }

    let mut device_users = response.device_keys.keys();
    if response.master_keys.len() != response.device_keys.len()
        || response.self_signing_keys.len() != response.device_keys.len()
        || response.user_signing_keys.len() != response.device_keys.len()
        || device_users.any(|user_id| {
            !response.master_keys.contains_key(user_id)
                || !response.self_signing_keys.contains_key(user_id)
                || !response.user_signing_keys.contains_key(user_id)
        })
    {
        return false;
    }

    true
}

fn has_nonempty_cross_signing_signatures(key: &matrix_sdk_crypto::types::CrossSigningKey) -> bool {
    serde_json::to_value(&key.signatures)
        .ok()
        .and_then(|value| value.as_object().map(|object| !object.is_empty()))
        .unwrap_or(false)
}

fn cross_signing_key_has_usage(
    key: &matrix_sdk_crypto::types::CrossSigningKey,
    usage: &str,
) -> bool {
    serde_json::to_value(key)
        .ok()
        .and_then(|value| value.get("usage").cloned())
        .and_then(|value| value.as_array().cloned())
        .is_some_and(|usages| usages.iter().any(|value| value.as_str() == Some(usage)))
}

fn validate_saved_crypto_response(response: &KeysQueryResponse) -> Result<(), SafeError> {
    if !response.failures.is_empty() || !has_nonempty_saved_key_maps(response) {
        return Err(SafeError::new(MATRIX_RESPONSE_INVALID));
    }

    for (user_id, devices) in &response.device_keys {
        for (device_id, raw_device) in devices {
            let device_keys: matrix_sdk_crypto::types::DeviceKeys =
                serde_json::from_str(raw_device.json().get())
                    .map_err(|_| SafeError::new(MATRIX_RESPONSE_INVALID))?;
            if device_keys.user_id != *user_id
                || device_keys.device_id != *device_id
                || device_keys.check_self_signature().is_err()
            {
                return Err(SafeError::new(MATRIX_RESPONSE_INVALID));
            }
        }
    }

    let mut master_keys = BTreeMap::new();
    for (user_id, raw_key) in &response.master_keys {
        let key: matrix_sdk_crypto::types::CrossSigningKey =
            serde_json::from_str(raw_key.json().get())
                .map_err(|_| SafeError::new(MATRIX_RESPONSE_INVALID))?;
        if key.user_id != *user_id
            || key.get_first_key_and_id().is_none()
            || !has_nonempty_cross_signing_signatures(&key)
            || !cross_signing_key_has_usage(&key, "master")
            || !verify_cross_signing_signature(&key, &key)
        {
            return Err(SafeError::new(MATRIX_RESPONSE_INVALID));
        }
        master_keys.insert(user_id.clone(), key);
    }

    for (user_id, raw_key) in &response.self_signing_keys {
        let key: matrix_sdk_crypto::types::CrossSigningKey =
            serde_json::from_str(raw_key.json().get())
                .map_err(|_| SafeError::new(MATRIX_RESPONSE_INVALID))?;
        let Some(master) = master_keys.get(user_id) else {
            return Err(SafeError::new(MATRIX_RESPONSE_INVALID));
        };
        if key.user_id != *user_id
            || key.get_first_key_and_id().is_none()
            || !has_nonempty_cross_signing_signatures(&key)
            || !cross_signing_key_has_usage(&key, "self_signing")
            || !verify_cross_signing_signature(master, &key)
        {
            return Err(SafeError::new(MATRIX_RESPONSE_INVALID));
        }
    }

    for (user_id, raw_key) in &response.user_signing_keys {
        let key: matrix_sdk_crypto::types::CrossSigningKey =
            serde_json::from_str(raw_key.json().get())
                .map_err(|_| SafeError::new(MATRIX_RESPONSE_INVALID))?;
        let Some(master) = master_keys.get(user_id) else {
            return Err(SafeError::new(MATRIX_RESPONSE_INVALID));
        };
        if key.user_id != *user_id
            || key.get_first_key_and_id().is_none()
            || !has_nonempty_cross_signing_signatures(&key)
            || !cross_signing_key_has_usage(&key, "user_signing")
            || !verify_cross_signing_signature(master, &key)
        {
            return Err(SafeError::new(MATRIX_RESPONSE_INVALID));
        }
    }

    Ok(())
}

fn saved_response_digest_matches(saved: &SavedMatrixResponse) -> bool {
    Sha256::digest(saved.response().as_bytes()).as_slice() == saved.response_sha256()
}

fn event_json<T>(event: &Raw<T>) -> Result<SecretBytes, SafeError> {
    let json = event.json().get();
    if json.is_empty() {
        return Err(SafeError::new(MATRIX_RESPONSE_INVALID));
    }
    SecretBytes::from_text(json.as_bytes(), crate::config::MAX_EVENT_CANONICAL_BYTES)
        .map_err(|_| SafeError::new(MATRIX_RESPONSE_TOO_LARGE))
}

fn observed_event(
    room_id: &str,
    event: &Raw<AnySyncTimelineEvent>,
    unable_to_decrypt: bool,
) -> Result<ObservedMatrixEvent, SafeError> {
    Ok(ObservedMatrixEvent::Timeline(ObservedRoomEvent::new(
        SecretBytes::from_slice(room_id.as_bytes()),
        event_json(event)?,
        unable_to_decrypt,
    )?))
}

/// Convert one raw `/messages` timeline event into the same protected
/// observation boundary used by the receive-only sync path. Encrypted raw
/// events are retained as an explicit retry marker and can never be silently
/// checkpointed as if they were clear text.
pub(crate) fn observed_backfill_timeline_event(
    room_id: &str,
    event: &Raw<AnyTimelineEvent>,
) -> Result<ObservedMatrixEvent, SafeError> {
    let event_type = event
        .get_field::<String>("type")
        .map_err(|_| SafeError::new(MATRIX_RESPONSE_INVALID))?
        .ok_or_else(|| SafeError::new(MATRIX_RESPONSE_INVALID))?;
    Ok(ObservedMatrixEvent::Timeline(ObservedRoomEvent::new(
        SecretBytes::from_slice(room_id.as_bytes()),
        event_json(event)?,
        event_type == "m.room.encrypted",
    )?))
}

/// Convert one raw `/messages` state event into the existing protected state
/// observation boundary.
pub(crate) fn observed_backfill_state_event(
    room_id: &str,
    event: &Raw<AnyStateEvent>,
) -> Result<ObservedMatrixEvent, SafeError> {
    Ok(ObservedMatrixEvent::State(ObservedRoomEvent::new(
        SecretBytes::from_slice(room_id.as_bytes()),
        event_json(event)?,
        false,
    )?))
}

fn observed_state_event(
    room_id: &str,
    event: &Raw<AnySyncStateEvent>,
) -> Result<ObservedMatrixEvent, SafeError> {
    Ok(ObservedMatrixEvent::State(ObservedRoomEvent::new(
        SecretBytes::from_slice(room_id.as_bytes()),
        event_json(event)?,
        false,
    )?))
}

fn observed_ephemeral_event(
    room_id: &str,
    event: &Raw<AnySyncEphemeralRoomEvent>,
) -> Result<Option<ObservedMatrixEvent>, SafeError> {
    let event_type = event
        .get_field::<String>("type")
        .map_err(|_| SafeError::new(MATRIX_RESPONSE_INVALID))?;
    let Some(event_type) = event_type else {
        return Err(SafeError::new(MATRIX_RESPONSE_INVALID));
    };
    let kind = match event_type.as_str() {
        "m.receipt" => ObservedMatrixEvent::Receipt,
        "m.typing" => ObservedMatrixEvent::Typing,
        _ => return Ok(None),
    };
    let value = ObservedRoomEvent::new(
        SecretBytes::from_slice(room_id.as_bytes()),
        event_json(event)?,
        false,
    )?;
    Ok(Some(kind(value)))
}

fn sorted_joined_rooms(
    rooms: &BTreeMap<OwnedRoomId, JoinedRoomUpdate>,
) -> Vec<(&OwnedRoomId, &JoinedRoomUpdate)> {
    let mut rooms: Vec<_> = rooms.iter().collect();
    rooms.sort_by(|(left, _), (right, _)| left.as_str().as_bytes().cmp(right.as_str().as_bytes()));
    rooms
}

fn push_sdk_state_events(
    events: &mut Vec<ObservedMatrixEvent>,
    room_id: &str,
    state: &SdkState,
) -> Result<(), SafeError> {
    let state_events = match state {
        SdkState::Before(state) | SdkState::After(state) => state,
    };
    for event in state_events {
        events.push(observed_state_event(room_id, event)?);
    }
    Ok(())
}

fn extract_sdk_observations(response: &SdkSyncResponse) -> Result<ProcessedSync, SafeError> {
    let mut events = Vec::new();
    let mut gaps = Vec::new();
    for (room_id, room) in sorted_joined_rooms(&response.rooms.joined) {
        for event in &room.timeline.events {
            let event_type = event
                .kind
                .raw()
                .get_field::<String>("type")
                .map_err(|_| SafeError::new(MATRIX_RESPONSE_INVALID))?
                .ok_or_else(|| SafeError::new(MATRIX_RESPONSE_INVALID))?;
            let unable_to_decrypt =
                event_type == "m.room.encrypted" && event.kind.encryption_info().is_none();
            events.push(observed_event(
                room_id.as_str(),
                event.kind.raw(),
                unable_to_decrypt,
            )?);
        }
        push_sdk_state_events(&mut events, room_id.as_str(), &room.state)?;
        for event in &room.ephemeral {
            if let Some(event) = observed_ephemeral_event(room_id.as_str(), event)? {
                events.push(event);
            }
        }
        if room.timeline.limited {
            let prev_batch = room
                .timeline
                .prev_batch
                .as_deref()
                .ok_or_else(|| SafeError::new(MATRIX_RESPONSE_INVALID))?;
            if prev_batch.is_empty() {
                return Err(SafeError::new(MATRIX_RESPONSE_INVALID));
            }
            gaps.push(LimitedTimelineGap::new(
                SecretBytes::from_slice(room_id.as_bytes()),
                SecretBytes::from_slice(prev_batch.as_bytes()),
            )?);
        }
    }
    Ok(ProcessedSync::new(events, gaps))
}

async fn extract_raw_observations(
    response: &RumaSyncResponse,
    machine: Option<&matrix_sdk_crypto::OlmMachine>,
) -> Result<ProcessedSync, SafeError> {
    let mut events = Vec::new();
    let mut gaps = Vec::new();
    let settings = DecryptionSettings {
        sender_device_trust_requirement: TrustRequirement::Untrusted,
    };
    let mut rooms: Vec<_> = response.rooms.join.iter().collect();
    rooms.sort_by(|(left, _), (right, _)| left.as_str().as_bytes().cmp(right.as_str().as_bytes()));
    for (room_id, room) in rooms {
        for event in &room.timeline.events {
            let event_type = event
                .get_field::<String>("type")
                .map_err(|_| SafeError::new(MATRIX_RESPONSE_INVALID))?
                .ok_or_else(|| SafeError::new(MATRIX_RESPONSE_INVALID))?;
            if event_type == "m.room.encrypted" {
                let machine = machine.ok_or_else(|| SafeError::new(MATRIX_SDK_FAILED))?;
                let decrypted = machine
                    .decrypt_room_event(event.cast_ref_unchecked(), room_id, &settings)
                    .await;
                match decrypted {
                    Ok(decrypted) => {
                        events.push(ObservedMatrixEvent::Timeline(ObservedRoomEvent::new(
                            SecretBytes::from_slice(room_id.as_str().as_bytes()),
                            event_json(&decrypted.event)?,
                            false,
                        )?))
                    }
                    Err(MegolmError::MissingRoomKey(_)) => {
                        events.push(observed_event(room_id.as_str(), event, true)?)
                    }
                    Err(_) => return Err(SafeError::new(MATRIX_SDK_FAILED)),
                }
            } else {
                events.push(observed_event(room_id.as_str(), event, false)?);
            }
        }
        let state_events = match &room.state {
            ruma::api::client::sync::sync_events::v3::State::Before(state)
            | ruma::api::client::sync::sync_events::v3::State::After(state) => &state.events,
            _ => return Err(SafeError::new(MATRIX_RESPONSE_INVALID)),
        };
        for event in state_events {
            events.push(observed_state_event(room_id.as_str(), event)?);
        }
        for event in &room.ephemeral.events {
            if let Some(event) = observed_ephemeral_event(room_id.as_str(), event)? {
                events.push(event);
            }
        }
        if room.timeline.limited {
            let prev_batch = room
                .timeline
                .prev_batch
                .as_deref()
                .ok_or_else(|| SafeError::new(MATRIX_RESPONSE_INVALID))?;
            if prev_batch.is_empty() {
                return Err(SafeError::new(MATRIX_RESPONSE_INVALID));
            }
            if prev_batch.len() > crate::store_types::MAX_SYNC_TOKEN_BYTES {
                return Err(SafeError::new(MATRIX_RESPONSE_TOO_LARGE));
            }
            gaps.push(LimitedTimelineGap::new(
                SecretBytes::from_slice(room_id.as_str().as_bytes()),
                SecretBytes::from_slice(prev_batch.as_bytes()),
            )?);
        }
    }
    Ok(ProcessedSync::new(events, gaps))
}

fn parse_saved_sync(response: &RawSyncInbox) -> Result<RumaSyncResponse, SafeError> {
    if response.response().is_empty() || response.byte_count() != response.response().len() {
        return Err(if response.response().is_empty() {
            SafeError::new(MATRIX_RESPONSE_EMPTY)
        } else {
            SafeError::new(MATRIX_RESPONSE_INVALID)
        });
    }
    if response.byte_count() > MAX_SYNC_RESPONSE_BYTES {
        return Err(if response.byte_count() > MAX_SYNC_RESPONSE_BYTES {
            SafeError::new(MATRIX_RESPONSE_TOO_LARGE)
        } else {
            SafeError::new(MATRIX_RESPONSE_INVALID)
        });
    }
    if str::from_utf8(response.request_token().as_bytes()).is_err()
        || str::from_utf8(response.next_token().as_bytes()).is_err()
    {
        return Err(SafeError::new(MATRIX_RESPONSE_INVALID));
    }
    let parsed = HttpResponse::builder()
        .status(http::StatusCode::OK)
        .header(CONTENT_TYPE, "application/json")
        .body(response.response().as_bytes())
        .map_err(|_| SafeError::new(MATRIX_RESPONSE_INVALID))?;
    let typed = RumaSyncResponse::try_from_http_response(parsed)
        .map_err(|_| SafeError::new(MATRIX_RESPONSE_INVALID))?;
    if typed.next_batch.is_empty() {
        return Err(SafeError::new(MATRIX_RESPONSE_INVALID));
    }
    if typed.next_batch.len() > crate::store_types::MAX_SYNC_TOKEN_BYTES {
        return Err(SafeError::new(MATRIX_RESPONSE_TOO_LARGE));
    }
    if Sha256::digest(typed.next_batch.as_bytes()).as_slice() != response.next_token_digest() {
        return Err(SafeError::new(MATRIX_RESPONSE_INVALID));
    }
    reject_invalid_memberships(&typed)?;
    validate_response_event_ids(&typed)?;
    validate_response_event_rooms(&typed)?;
    Ok(typed)
}

impl MatrixSdkProcessor {
    async fn require_sdk_at_token(&self, token_digest: &[u8; 32]) -> Result<(), SafeError> {
        let Some(token) = self.base.sync_token().await else {
            return Err(SafeError::new(MATRIX_SDK_POSITION_UNJOURNALED));
        };
        let actual: [u8; 32] = Sha256::digest(token.as_bytes()).into();
        if &actual != token_digest {
            return Err(SafeError::new(MATRIX_SDK_POSITION_UNJOURNALED));
        }
        Ok(())
    }

    fn require_recoverable_inbox(&self, response: &RawSyncInbox) -> Result<(), SafeError> {
        if !self.recovery_frontier.contains(response.inbox_id()) {
            return Err(SafeError::new(MATRIX_SDK_POSITION_UNJOURNALED));
        }
        Ok(())
    }

    async fn mark_keys_query_response(
        machine: &matrix_sdk_crypto::OlmMachine,
        request_id: &OwnedTransactionId,
        response: &KeysQueryResponse,
    ) -> Result<(), SafeError> {
        machine
            .mark_request_as_sent(
                request_id.as_ref(),
                AnyIncomingResponse::KeysQuery(response),
            )
            .await
            .map_err(|_| SafeError::new(MATRIX_SDK_FAILED))
    }

    async fn prove_saved_crypto_response(
        &self,
        machine: &matrix_sdk_crypto::OlmMachine,
        saved: &SavedMatrixResponse,
    ) -> Result<bool, SafeError> {
        let response = parse_keys_query_response(saved.response())?;
        if validate_saved_crypto_response(&response).is_err() {
            return Ok(false);
        }

        for (user_id, devices) in &response.device_keys {
            let stored = machine
                .get_user_devices(user_id, None)
                .await
                .map_err(|_| SafeError::new(MATRIX_SDK_FAILED))?;
            let identity = machine
                .get_identity(user_id, None)
                .await
                .map_err(|_| SafeError::new(MATRIX_SDK_FAILED))?;
            let Some(identity) = identity else {
                return Ok(false);
            };
            let self_signing_key = match &identity {
                matrix_sdk_crypto::UserIdentity::Own(identity) => identity.self_signing_key(),
                matrix_sdk_crypto::UserIdentity::Other(identity) => identity.self_signing_key(),
            };
            if !has_nonempty_cross_signing_signatures(self_signing_key.as_ref()) {
                return Ok(false);
            }
            for (device_id, raw_device) in devices {
                let device_keys: matrix_sdk_crypto::types::DeviceKeys =
                    serde_json::from_str(raw_device.json().get())
                        .map_err(|_| SafeError::new(MATRIX_RESPONSE_INVALID))?;
                if device_keys.user_id != *user_id
                    || device_keys.device_id != *device_id
                    || device_keys.check_self_signature().is_err()
                {
                    return Ok(false);
                }
                let Some(device) = stored.get(device_id) else {
                    return Ok(false);
                };
                if device.user_id() != user_id
                    || device.device_id() != device_id
                    || !signed_device_keys_equal(&device, &device_keys)
                {
                    return Ok(false);
                }
                if self_signing_key.verify_device_keys(&device_keys).is_err() {
                    return Ok(false);
                }
            }

            let master_key = match &identity {
                matrix_sdk_crypto::UserIdentity::Own(identity) => identity.master_key(),
                matrix_sdk_crypto::UserIdentity::Other(identity) => identity.master_key(),
            };
            let stored_self_signing_key = match &identity {
                matrix_sdk_crypto::UserIdentity::Own(identity) => identity.self_signing_key(),
                matrix_sdk_crypto::UserIdentity::Other(identity) => identity.self_signing_key(),
            };
            if !has_nonempty_cross_signing_signatures(master_key.as_ref())
                || !has_nonempty_cross_signing_signatures(stored_self_signing_key.as_ref())
                || !verify_cross_signing_signature(master_key.as_ref(), master_key.as_ref())
            {
                return Ok(false);
            }

            let Some(raw_master_key) = response.master_keys.get(user_id) else {
                return Ok(false);
            };
            let response_master_key: matrix_sdk_crypto::types::CrossSigningKey =
                serde_json::from_str(raw_master_key.json().get())
                    .map_err(|_| SafeError::new(MATRIX_RESPONSE_INVALID))?;
            if !cross_signing_keys_equal(master_key.as_ref(), &response_master_key) {
                return Ok(false);
            }

            let Some(raw_self_signing_key) = response.self_signing_keys.get(user_id) else {
                return Ok(false);
            };
            let response_self_signing_key: matrix_sdk_crypto::types::CrossSigningKey =
                serde_json::from_str(raw_self_signing_key.json().get())
                    .map_err(|_| SafeError::new(MATRIX_RESPONSE_INVALID))?;
            if !cross_signing_keys_equal(
                stored_self_signing_key.as_ref(),
                &response_self_signing_key,
            ) || !verify_cross_signing_signature(
                &response_master_key,
                &response_self_signing_key,
            ) {
                return Ok(false);
            }

            let Some(raw_user_signing_key) = response.user_signing_keys.get(user_id) else {
                return Ok(false);
            };
            let response_user_signing_key: matrix_sdk_crypto::types::CrossSigningKey =
                serde_json::from_str(raw_user_signing_key.json().get())
                    .map_err(|_| SafeError::new(MATRIX_RESPONSE_INVALID))?;
            let user_signing_matches = match &identity {
                matrix_sdk_crypto::UserIdentity::Own(identity) => {
                    cross_signing_keys_equal(
                        identity.user_signing_key().as_ref(),
                        &response_user_signing_key,
                    ) && has_nonempty_cross_signing_signatures(identity.user_signing_key().as_ref())
                }
                matrix_sdk_crypto::UserIdentity::Other(_) => false,
            };
            if !user_signing_matches
                || !verify_cross_signing_signature(&response_master_key, &response_user_signing_key)
            {
                return Ok(false);
            }
        }
        Ok(true)
    }
}

#[async_trait]
impl MatrixProcessor for MatrixSdkProcessor {
    async fn sdk_token_digest(&self) -> Result<Option<[u8; 32]>, SafeError> {
        Ok(self
            .base
            .sync_token()
            .await
            .map(|token| Sha256::digest(token.as_bytes()).into()))
    }

    async fn apply_saved_sync(
        &mut self,
        response: &RawSyncInbox,
    ) -> Result<ProcessedSync, SafeError> {
        let typed = parse_saved_sync(response)?;
        self.require_sdk_at_token(response.request_token_digest())
            .await?;
        let sdk_response = self
            .base
            .receive_sync_response(typed)
            .await
            .map_err(|_| SafeError::new(MATRIX_SDK_FAILED))?;
        let processed = extract_sdk_observations(&sdk_response)?;
        self.recovery_frontier.include(response.inbox_id());
        Ok(processed)
    }

    async fn recover_saved_sync(
        &mut self,
        response: &RawSyncInbox,
    ) -> Result<ProcessedSync, SafeError> {
        let typed = parse_saved_sync(response)?;
        self.require_recoverable_inbox(response)?;
        for room_id in typed.rooms.join.keys() {
            let Some(room) = self.base.get_room(room_id) else {
                return Err(SafeError::new(MATRIX_SDK_FAILED));
            };
            if room.state() != RoomState::Joined {
                return Err(SafeError::new(MATRIX_ROOM_MEMBERSHIP_INVALID));
            }
        }
        let machine_guard = self.base.olm_machine().await;
        let machine = machine_guard.as_ref();
        extract_raw_observations(&typed, machine).await
    }

    async fn pending_crypto_requests(&self) -> Result<Vec<ExactMatrixRequest>, SafeError> {
        let machine_guard = self.base.olm_machine().await;
        let machine = machine_guard
            .as_ref()
            .ok_or_else(|| SafeError::new(MATRIX_SESSION_NOT_READY))?;
        let requests = machine
            .outgoing_requests()
            .await
            .map_err(|_| SafeError::new(MATRIX_SDK_FAILED))?;

        // Keep the machine guard alive while every outgoing request is
        // classified.  The receive-only phase must make its decision from
        // one coherent SDK snapshot and must never ask the machine to create
        // another request while doing so.
        if requests.len() > 1 {
            for request in &requests {
                let _ = classify_crypto_request(request.request());
            }
        }

        let mut pending = self
            .pending_keys_query
            .lock()
            .map_err(|_| SafeError::new(MATRIX_SDK_FAILED))?;
        *pending = None;
        if requests.len() > 1 {
            return Err(SafeError::new(MATRIX_CRYPTO_KIND_NOT_ALLOWED));
        }
        let Some(request) = requests.first() else {
            return Ok(Vec::new());
        };
        let (kind, policy) = classify_crypto_request(request.request());
        match (kind, policy, request.request()) {
            (
                MatrixCryptoRequestKind::KeysQuery,
                MatrixCryptoRequestPolicy::AllowKeysQuery,
                AnyOutgoingRequest::KeysQuery(query),
            ) => {
                let body = canonical_keys_query_request(query)?;
                let id = request.request_id().as_bytes().to_vec();
                let exact = ExactMatrixRequest::keys_query(id.clone(), body)
                    .map_err(|_| SafeError::new(MATRIX_SDK_FAILED))?;
                *pending = Some(PendingSdkKeysQuery {
                    request_id: SecretBytes::new(id),
                    request_sha256: *exact.request_sha256(),
                });
                Ok(vec![exact])
            }
            (_, MatrixCryptoRequestPolicy::RequireMaintenance, _) => {
                Err(SafeError::new(MATRIX_CRYPTO_MAINTENANCE_REQUIRED))
            }
            _ => Err(SafeError::new(MATRIX_CRYPTO_KIND_NOT_ALLOWED)),
        }
    }

    async fn apply_crypto_response(
        &mut self,
        request: &PendingMatrixRequest,
        response: &RawMatrixResponse,
    ) -> Result<CryptoAckProof, SafeError> {
        if Sha256::digest(request.request().as_bytes()).as_slice() != request.request_sha256() {
            return Err(SafeError::new(MATRIX_RESPONSE_INVALID));
        }
        let request_id = parse_transaction_id(request.sdk_request_id().as_bytes())?;
        let body = request.request().as_bytes();
        let parsed_request = HttpRequest::builder()
            .method(http::Method::POST)
            .uri("/_matrix/client/v3/keys/query")
            .body(body)
            .map_err(|_| SafeError::new(MATRIX_RESPONSE_INVALID))?;
        let query = RumaKeysQueryRequest::try_from_http_request(parsed_request, &[] as &[&str])
            .map_err(|_| SafeError::new(MATRIX_RESPONSE_INVALID))?;
        let query = KeysQueryRequest {
            timeout: query.timeout,
            device_keys: query.device_keys,
        };
        if keys_query_body_digest(&query) != *request.request_sha256() {
            return Err(SafeError::new(MATRIX_RESPONSE_INVALID));
        }
        let request_matches = self
            .pending_keys_query
            .lock()
            .map_err(|_| SafeError::new(MATRIX_SDK_FAILED))?
            .as_ref()
            .is_some_and(|pending| {
                pending.request_id.as_bytes() == request.sdk_request_id().as_bytes()
                    && pending.request_sha256 == *request.request_sha256()
            });
        if !request_matches {
            return Err(SafeError::new(MATRIX_RESPONSE_INVALID));
        }

        let parsed_response = parse_keys_query_response(response.body())?;
        let machine_guard = self.base.olm_machine().await;
        let machine = machine_guard
            .as_ref()
            .ok_or_else(|| SafeError::new(MATRIX_SESSION_NOT_READY))?;
        machine
            .mark_request_as_sent(
                request_id.as_ref(),
                AnyIncomingResponse::KeysQuery(&parsed_response),
            )
            .await
            .map_err(|_| SafeError::new(MATRIX_SDK_FAILED))?;
        self.pending_keys_query
            .lock()
            .map_err(|_| SafeError::new(MATRIX_SDK_FAILED))?
            .take();
        Ok(CryptoAckProof::new(
            request.row_id().to_owned(),
            *response.sha256(),
        ))
    }

    async fn rebind_saved_crypto_response(
        &mut self,
        saved: &SavedMatrixResponse,
    ) -> Result<RestartCryptoAck, SafeError> {
        let machine_guard = self.base.olm_machine().await;
        let machine = machine_guard
            .as_ref()
            .ok_or_else(|| SafeError::new(MATRIX_SESSION_NOT_READY))?;
        let requests = machine
            .outgoing_requests()
            .await
            .map_err(|_| SafeError::new(MATRIX_SDK_FAILED))?;
        if requests.len() > 1 {
            return Ok(unrecoverable_ack());
        }
        if let Some(request) = requests.first() {
            let AnyOutgoingRequest::KeysQuery(query) = request.request() else {
                return Ok(unrecoverable_ack());
            };
            if keys_query_body_digest(query) != *saved.request_sha256() {
                return Ok(unrecoverable_ack());
            }
            if !saved_response_digest_matches(saved) {
                return Ok(unrecoverable_ack());
            }
            let response = match parse_keys_query_response(saved.response()) {
                Ok(response) => response,
                Err(_) => return Ok(unrecoverable_ack()),
            };
            if validate_saved_crypto_response(&response).is_err() {
                return Ok(unrecoverable_ack());
            }
            let request_id = request.request_id().to_owned();
            if Self::mark_keys_query_response(machine, &request_id, &response)
                .await
                .is_err()
            {
                return Ok(unrecoverable_ack());
            }
            return Ok(RestartCryptoAck::Rebound(CryptoAckProof::new(
                saved.row_id().to_owned(),
                *saved.response_sha256(),
            )));
        }
        if !saved_response_digest_matches(saved) {
            return Ok(unrecoverable_ack());
        }
        match self.prove_saved_crypto_response(machine, saved).await {
            Ok(true) => Ok(RestartCryptoAck::AlreadyApplied(CryptoAckProof::new(
                saved.row_id().to_owned(),
                *saved.response_sha256(),
            ))),
            Ok(false) | Err(_) => Ok(unrecoverable_ack()),
        }
    }
}

#[cfg(test)]
mod task1_red_tests {
    use chrono::{TimeZone, Utc};

    use super::*;

    #[test]
    fn task3_room_lookup_delegation_is_available_to_the_adapter() {
        fn invoke(store: &crate::store::Store) {
            let _ = store.matrix_room_lookup("!room:example.org");
        }

        let _ = invoke as fn(&crate::store::Store);
    }

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

#[cfg(test)]
mod task5_crypto_tests {
    use std::collections::BTreeMap;

    use matrix_sdk_crypto::types::requests::{AnyIncomingResponse, AnyOutgoingRequest};
    use ruma::{
        api::{OutgoingResponse, client::keys::upload_keys::v3::Response as UploadKeysResponse},
        owned_device_id, owned_user_id,
    };
    use sha2::{Digest, Sha256};
    use tempfile::tempdir;

    use super::*;

    #[test]
    fn forbidden_crypto_kinds_are_fail_closed() {
        for kind in [
            MatrixCryptoRequestKind::KeysClaim,
            MatrixCryptoRequestKind::ToDevice,
            MatrixCryptoRequestKind::Verification,
            MatrixCryptoRequestKind::RoomMessage,
            MatrixCryptoRequestKind::SigningOrSignature,
            MatrixCryptoRequestKind::Backup,
        ] {
            assert_eq!(
                policy_for_crypto_kind(kind),
                MatrixCryptoRequestPolicy::Forbidden
            );
        }
    }

    #[tokio::test]
    async fn rebind_does_not_ack_a_maintenance_request() {
        let directory = tempdir().expect("temporary SDK store");
        let sdk_path = directory.path().join("matrix-sdk");
        let session_meta = SessionMeta {
            user_id: owned_user_id!("@task5-maintenance:example.org"),
            device_id: owned_device_id!("TASK5MAINT"),
        };
        let base =
            open_activated_base_client(&sdk_path, &sdk_path, "task5-passphrase", session_meta)
                .await
                .expect("open SDK store");
        let saved_body = SecretBytes::from_slice(br#"{}"#);
        let saved = SavedMatrixResponse::from_verified_parts(
            "crypto_task5_maintenance".to_owned(),
            [0x11; 32],
            saved_body,
            Sha256::digest(br#"{}"#).into(),
        );
        let initial_requests = {
            let machine_guard = base.olm_machine().await;
            let machine = machine_guard.as_ref().expect("active Olm machine");
            machine
                .outgoing_requests()
                .await
                .expect("enumerate initial requests")
        };
        assert!(
            initial_requests
                .iter()
                .any(|request| matches!(request.request(), AnyOutgoingRequest::KeysUpload(_)))
        );
        assert!(
            initial_requests
                .iter()
                .any(|request| matches!(request.request(), AnyOutgoingRequest::KeysQuery(_)))
        );

        let mut processor = MatrixSdkProcessor {
            base,
            recovery_frontier: RecoveryFrontier::default(),
            pending_keys_query: std::sync::Mutex::new(None),
        };

        let result = processor
            .rebind_saved_crypto_response(&saved)
            .await
            .expect("maintenance rebind result");
        assert!(matches!(result, RestartCryptoAck::Unrecoverable(_)));
        let machine_guard = processor.base.olm_machine().await;
        let machine = machine_guard.as_ref().expect("active Olm machine");
        let requests = machine.outgoing_requests().await.unwrap();
        assert!(
            requests
                .iter()
                .any(|request| matches!(request.request(), AnyOutgoingRequest::KeysUpload(_)))
        );
        assert!(
            requests
                .iter()
                .any(|request| matches!(request.request(), AnyOutgoingRequest::KeysQuery(_)))
        );
    }

    #[tokio::test]
    async fn matching_rebind_with_malformed_response_is_unrecoverable() {
        let directory = tempdir().expect("temporary SDK store");
        let sdk_path = directory.path().join("matrix-sdk");
        let session_meta = SessionMeta {
            user_id: owned_user_id!("@task5-rebind:example.org"),
            device_id: owned_device_id!("TASK5REBIND"),
        };
        let base =
            open_activated_base_client(&sdk_path, &sdk_path, "task5-passphrase", session_meta)
                .await
                .expect("open SDK store");

        let upload_response = UploadKeysResponse::new(BTreeMap::new());
        let query = {
            let machine_guard = base.olm_machine().await;
            let machine = machine_guard.as_ref().expect("active Olm machine");
            let requests = machine
                .outgoing_requests()
                .await
                .expect("enumerate requests");
            let upload = requests
                .iter()
                .find(|request| matches!(request.request(), AnyOutgoingRequest::KeysUpload(_)))
                .expect("fresh account upload request");
            machine
                .mark_request_as_sent(
                    upload.request_id(),
                    AnyIncomingResponse::KeysUpload(&upload_response),
                )
                .await
                .expect("acknowledge fixture upload");

            let requests = machine.outgoing_requests().await.expect("enumerate query");
            requests
                .into_iter()
                .find_map(|request| match request.request() {
                    AnyOutgoingRequest::KeysQuery(query) => {
                        Some((request.request_id().to_owned(), query.clone()))
                    }
                    _ => None,
                })
                .expect("replacement keys query")
        };
        let request_body = canonical_keys_query_request(&query.1).expect("canonical query");
        let malformed_response = SecretBytes::from_slice(br#"{"device_keys":[]}"#);
        let saved = SavedMatrixResponse::from_verified_parts(
            "crypto_task5_rebind".to_owned(),
            Sha256::digest(&request_body).into(),
            malformed_response,
            Sha256::digest(br#"{"device_keys":[]}"#).into(),
        );
        let mut processor = MatrixSdkProcessor {
            base,
            recovery_frontier: RecoveryFrontier::default(),
            pending_keys_query: std::sync::Mutex::new(None),
        };

        let result = processor
            .rebind_saved_crypto_response(&saved)
            .await
            .expect("restart rebind returns a classified result");
        assert_eq!(result.discriminant(), "unrecoverable");

        let failure_response =
            br#"{"device_keys":{},"master_keys":{},"self_signing_keys":{},"user_signing_keys":{},"failures":{"@task5-rebind:example.org":{"errcode":"M_NOT_FOUND","error":"failure detail"}}}"#;
        let failure_saved = SavedMatrixResponse::from_verified_parts(
            "crypto_task5_failure".to_owned(),
            Sha256::digest(&request_body).into(),
            SecretBytes::from_slice(failure_response),
            Sha256::digest(failure_response).into(),
        );
        let failure_result = processor
            .rebind_saved_crypto_response(&failure_saved)
            .await
            .expect("failure response rebind result");
        assert_eq!(failure_result.discriminant(), "unrecoverable");

        let different_request = SavedMatrixResponse::from_verified_parts(
            "crypto_task5_different_request".to_owned(),
            [0x22; 32],
            SecretBytes::from_slice(failure_response),
            Sha256::digest(failure_response).into(),
        );
        let different_result = processor
            .rebind_saved_crypto_response(&different_request)
            .await
            .expect("different request rebind result");
        assert_eq!(different_result.discriminant(), "unrecoverable");
        let machine_guard = processor.base.olm_machine().await;
        let machine = machine_guard.as_ref().expect("active Olm machine");
        assert_eq!(machine.outgoing_requests().await.unwrap().len(), 1);
    }

    #[tokio::test]
    async fn no_request_requires_a_complete_device_and_identity_proof() {
        let directory = tempdir().expect("temporary SDK store");
        let sdk_path = directory.path().join("matrix-sdk");
        let user_id = owned_user_id!("@task5-proof:example.org");
        let device_id = owned_device_id!("TASK5PROOF");
        let session_meta = SessionMeta {
            user_id: user_id.clone(),
            device_id: device_id.clone(),
        };
        let base =
            open_activated_base_client(&sdk_path, &sdk_path, "task5-passphrase", session_meta)
                .await
                .expect("open SDK store");

        let (request_body, response_body) = {
            let machine_guard = base.olm_machine().await;
            let machine = machine_guard.as_ref().expect("active Olm machine");
            let bootstrap = machine
                .bootstrap_cross_signing(false)
                .await
                .expect("bootstrap cross signing");
            let upload_response = UploadKeysResponse::new(BTreeMap::new());
            let upload = bootstrap
                .upload_keys_req
                .as_ref()
                .expect("cross-signing bootstrap device upload");
            let device_keys = match upload.request() {
                AnyOutgoingRequest::KeysUpload(request) => request
                    .device_keys
                    .clone()
                    .expect("device keys in upload request"),
                _ => panic!("bootstrap returned a non-upload request"),
            };
            machine
                .mark_request_as_sent(
                    upload.request_id(),
                    AnyIncomingResponse::KeysUpload(&upload_response),
                )
                .await
                .expect("acknowledge fixture upload");

            let requests = machine.outgoing_requests().await.expect("enumerate query");
            let (_request_id, query) = requests
                .into_iter()
                .find_map(|request| match request.request() {
                    AnyOutgoingRequest::KeysQuery(query) => {
                        Some((request.request_id().to_owned(), query.clone()))
                    }
                    _ => None,
                })
                .expect("identity keys query");
            let mut response = KeysQueryResponse::new();
            response.device_keys.insert(
                user_id.clone(),
                BTreeMap::from([(device_id.clone(), device_keys)]),
            );
            let signing_keys = &bootstrap.upload_signing_keys_req;
            response.master_keys.insert(
                user_id.clone(),
                signing_keys
                    .master_key
                    .clone()
                    .expect("master key upload")
                    .to_raw(),
            );
            response.self_signing_keys.insert(
                user_id.clone(),
                signing_keys
                    .self_signing_key
                    .clone()
                    .expect("self-signing key upload")
                    .to_raw(),
            );
            response.user_signing_keys.insert(
                user_id.clone(),
                signing_keys
                    .user_signing_key
                    .clone()
                    .expect("user-signing key upload")
                    .to_raw(),
            );
            let request_body = canonical_keys_query_request(&query).expect("canonical query");
            let response_body: Vec<u8> = response
                .try_into_http_response()
                .expect("serialize identity response")
                .into_body();
            (request_body, response_body)
        };

        let saved = SavedMatrixResponse::from_verified_parts(
            "crypto_task5_proof".to_owned(),
            Sha256::digest(&request_body).into(),
            SecretBytes::from_slice(&response_body),
            Sha256::digest(&response_body).into(),
        );
        let mut processor = MatrixSdkProcessor {
            base,
            recovery_frontier: RecoveryFrontier::default(),
            pending_keys_query: std::sync::Mutex::new(None),
        };
        let mut tampered_json: serde_json::Value =
            serde_json::from_slice(&response_body).expect("identity response JSON");
        let signature_key = tampered_json["master_keys"][user_id.as_str()]["keys"]
            .as_object()
            .and_then(|keys| keys.keys().next())
            .cloned()
            .expect("master key id");
        let signatures = tampered_json["master_keys"][user_id.as_str()]["signatures"]
            [user_id.as_str()]
        .as_object_mut()
        .expect("master signatures");
        let signature = signatures
            .get_mut(&signature_key)
            .and_then(|value| value.as_str())
            .expect("master signature value")
            .as_bytes()
            .to_vec();
        let mut signature = signature;
        signature[0] = if signature[0] == b'A' { b'B' } else { b'A' };
        signatures.insert(
            signature_key,
            serde_json::Value::String(String::from_utf8(signature).expect("base64 signature")),
        );
        let tampered_body = serde_json::to_vec(&tampered_json).expect("tampered response JSON");
        let tampered_saved = SavedMatrixResponse::from_verified_parts(
            "crypto_task5_tampered_matching".to_owned(),
            Sha256::digest(&request_body).into(),
            SecretBytes::from_slice(&tampered_body),
            Sha256::digest(&tampered_body).into(),
        );
        let tampered_parsed = parse_keys_query_response(&SecretBytes::from_slice(&tampered_body))
            .expect("tampered response parses");
        assert!(validate_saved_crypto_response(&tampered_parsed).is_err());
        let tampered_result = processor
            .rebind_saved_crypto_response(&tampered_saved)
            .await
            .expect("tampered matching rebind result");
        assert_eq!(tampered_result.discriminant(), "unrecoverable");
        let result = processor
            .rebind_saved_crypto_response(&saved)
            .await
            .expect("restart proof result");
        assert_eq!(result.discriminant(), "rebound");

        let repeated = processor
            .rebind_saved_crypto_response(&saved)
            .await
            .expect("repeated restart proof result");
        assert_eq!(repeated.discriminant(), "already_applied");

        let partial_response = format!(r#"{{"device_keys":{{"{}":{{}}}}}}"#, user_id).into_bytes();
        let partial = SavedMatrixResponse::from_verified_parts(
            "crypto_task5_partial".to_owned(),
            Sha256::digest(&request_body).into(),
            SecretBytes::from_slice(&partial_response),
            Sha256::digest(&partial_response).into(),
        );
        let partial_result = processor
            .rebind_saved_crypto_response(&partial)
            .await
            .expect("partial restart proof result");
        assert_eq!(partial_result.discriminant(), "unrecoverable");

        let tampered = SavedMatrixResponse::from_verified_parts(
            "crypto_task5_tampered".to_owned(),
            Sha256::digest(&request_body).into(),
            SecretBytes::from_slice(&response_body),
            [0xA5; 32],
        );
        let tampered_result = processor
            .rebind_saved_crypto_response(&tampered)
            .await
            .expect("tampered restart proof result");
        assert_eq!(tampered_result.discriminant(), "unrecoverable");
    }

    #[tokio::test]
    async fn direct_acknowledgement_requires_the_enumerated_id_and_body() {
        let directory = tempdir().expect("temporary SDK store");
        let sdk_path = directory.path().join("matrix-sdk");
        let session_meta = SessionMeta {
            user_id: owned_user_id!("@task5-direct:example.org"),
            device_id: owned_device_id!("TASK5DIRECT"),
        };
        let base =
            open_activated_base_client(&sdk_path, &sdk_path, "task5-passphrase", session_meta)
                .await
                .expect("open SDK store");
        let mut processor = MatrixSdkProcessor {
            base,
            recovery_frontier: RecoveryFrontier::default(),
            pending_keys_query: std::sync::Mutex::new(None),
        };

        let exact = {
            let machine_guard = processor.base.olm_machine().await;
            let machine = machine_guard.as_ref().expect("active Olm machine");
            let requests = machine
                .outgoing_requests()
                .await
                .expect("enumerate requests");
            let upload = requests
                .iter()
                .find(|request| matches!(request.request(), AnyOutgoingRequest::KeysUpload(_)))
                .expect("fresh account upload request");
            let upload_response = UploadKeysResponse::new(BTreeMap::new());
            machine
                .mark_request_as_sent(
                    upload.request_id(),
                    AnyIncomingResponse::KeysUpload(&upload_response),
                )
                .await
                .expect("acknowledge fixture upload");
            drop(upload_response);
            drop(machine_guard);
            let exact_requests = processor
                .pending_crypto_requests()
                .await
                .expect("enumerate one keys query");
            assert_eq!(exact_requests.len(), 1);
            exact_requests.into_iter().next().expect("exact keys query")
        };
        let pending = PendingMatrixRequest::from_verified_parts(
            "crypto_task5_direct".to_owned(),
            SecretBytes::from_slice(exact.sdk_request_id().as_bytes()),
            SecretBytes::from_slice(exact.request().as_bytes()),
            *exact.request_sha256(),
            1,
            Utc::now(),
        );
        let response =
            RawMatrixResponse::keys_query(br#"{}"#.to_vec()).expect("typed empty keys response");

        let malformed = RawMatrixResponse::keys_query(
            br#"{"device_keys":[],"canary":"response-canary"}"#.to_vec(),
        )
        .expect("JSON object response");
        assert_eq!(
            processor
                .apply_crypto_response(&pending, &malformed)
                .await
                .expect_err("schema-invalid response must fail before acknowledgement")
                .code(),
            MATRIX_RESPONSE_INVALID
        );

        let changed_body = br#"{"device_keys":{},"timeout":0}"#;
        let changed = PendingMatrixRequest::from_verified_parts(
            "crypto_task5_changed_body".to_owned(),
            SecretBytes::from_slice(exact.sdk_request_id().as_bytes()),
            SecretBytes::from_slice(changed_body),
            Sha256::digest(changed_body).into(),
            1,
            Utc::now(),
        );
        assert_eq!(
            processor
                .apply_crypto_response(&changed, &response)
                .await
                .expect_err("same SDK ID with a different body must fail")
                .code(),
            MATRIX_RESPONSE_INVALID
        );

        let proof = processor
            .apply_crypto_response(&pending, &response)
            .await
            .expect("direct SDK acknowledgement");
        assert_eq!(proof.row_id(), "crypto_task5_direct");

        assert_eq!(
            processor
                .apply_crypto_response(&pending, &response)
                .await
                .expect_err("a second acknowledgement must not reach the SDK")
                .code(),
            MATRIX_RESPONSE_INVALID
        );

        let mismatched = PendingMatrixRequest::from_verified_parts(
            "crypto_task5_mismatch".to_owned(),
            SecretBytes::from_slice(b"different-id"),
            SecretBytes::from_slice(exact.request().as_bytes()),
            *exact.request_sha256(),
            1,
            Utc::now(),
        );
        assert_eq!(
            processor
                .apply_crypto_response(&mismatched, &response)
                .await
                .expect_err("different request ID must fail")
                .code(),
            MATRIX_RESPONSE_INVALID
        );
    }
}

#[cfg(test)]
mod task3_bootstrap_tests {
    use std::{
        fs,
        os::unix::fs::{PermissionsExt, symlink},
    };

    use chrono::{TimeZone, Utc};
    use matrix_sdk::test_utils::mocks::MatrixMockServer;
    use matrix_sdk::{SessionMeta, SessionTokens, authentication::matrix::MatrixSession};
    use matrix_sdk_crypto::store::CryptoStore;
    use matrix_sdk_sqlite::SqliteCryptoStore;
    use matrix_sdk_test::{
        InvitedRoomBuilder, JoinedRoomBuilder, LeftRoomBuilder, SyncResponseBuilder,
        event_factory::EventFactory,
    };
    use ruma::{api::OutgoingResponse, event_id, owned_user_id, room_id};
    use rusqlite::Connection;
    use serde_json::Value;
    use tempfile::tempdir;
    use wiremock::{Mock, ResponseTemplate, matchers};

    use super::{bootstrap_matrix, inspect_sdk_store_path, open_activated_base_client};
    use crate::{
        crypto::Keyring, registry, secret::SecretBytes, store::Store,
        store_types::NewBootstrapState,
    };

    #[test]
    fn private_session_helpers_round_trip_and_redact_decode_failures() {
        let session = MatrixSession {
            meta: SessionMeta {
                user_id: owned_user_id!("@private-helper:example.org"),
                device_id: ruma::device_id!("PRIVATEHELPER").to_owned(),
            },
            tokens: SessionTokens {
                access_token: "private-helper-access".to_owned(),
                refresh_token: Some("private-helper-refresh".to_owned()),
            },
        };

        let serialized = super::serialize_matrix_session(&session).expect("session encoding");
        let restored = super::deserialize_matrix_session(&serialized).expect("session decoding");
        assert_eq!(restored.meta, session.meta);
        assert_eq!(restored.tokens, session.tokens);

        let error = super::deserialize_matrix_session(&SecretBytes::from_slice(
            br#"{"canary":"private-session-canary"}"#,
        ))
        .expect_err("malformed session must fail closed");
        assert_eq!(error.code(), "matrix_session_invalid");
        assert!(!error.to_string().contains("private-session-canary"));
        assert!(std::error::Error::source(&error).is_none());
    }

    fn timestamp(millis: i64) -> chrono::DateTime<Utc> {
        Utc.timestamp_millis_opt(millis)
            .single()
            .expect("valid timestamp")
    }

    async fn mount_bootstrap_mocks(
        server: &MatrixMockServer,
        user_id: &ruma::UserId,
        sync_body: Vec<u8>,
    ) {
        Mock::given(matchers::method("POST"))
            .and(matchers::path("/_matrix/client/v3/login"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "access_token": "bootstrap-access-token",
                "device_id": "BOOTSTRAPDEVICE",
                "home_server": "example.org",
                "user_id": user_id.as_str(),
            })))
            .expect(1)
            .mount(server.server())
            .await;
        Mock::given(matchers::method("GET"))
            .and(matchers::path("/_matrix/client/v3/sync"))
            .respond_with(
                ResponseTemplate::new(200)
                    .insert_header("content-type", "application/json")
                    .set_body_bytes(sync_body),
            )
            .expect(1)
            .mount(server.server())
            .await;
    }

    #[test]
    fn sdk_store_path_policy_accepts_only_missing_or_empty_real_directories() {
        let root = tempdir().expect("temporary root");
        let missing = root.path().join("missing");
        assert!(inspect_sdk_store_path(&missing, false).is_ok());
        assert!(inspect_sdk_store_path(&missing, true).is_err());

        let empty = root.path().join("empty");
        fs::create_dir(&empty).expect("empty directory");
        assert!(inspect_sdk_store_path(&empty, false).is_ok());
        assert!(inspect_sdk_store_path(&empty, true).is_err());

        let file = root.path().join("file");
        fs::write(&file, b"not a directory").expect("file fixture");
        assert_eq!(
            inspect_sdk_store_path(&file, false).unwrap_err().code(),
            "matrix_session_invalid"
        );

        let nonempty = root.path().join("nonempty");
        fs::create_dir(&nonempty).expect("nonempty directory");
        fs::write(nonempty.join("partial-state"), b"operator diagnosis").expect("marker");
        assert_eq!(
            inspect_sdk_store_path(&nonempty, false).unwrap_err().code(),
            "matrix_session_invalid"
        );
        assert!(inspect_sdk_store_path(&nonempty, true).is_ok());

        let symlink_target = root.path().join("symlink-target");
        fs::create_dir(&symlink_target).expect("symlink target");
        let symlink_path = root.path().join("symlink");
        symlink(&symlink_target, &symlink_path).expect("symlink fixture");
        assert_eq!(
            inspect_sdk_store_path(&symlink_path, false)
                .unwrap_err()
                .code(),
            "matrix_session_invalid"
        );
        assert_eq!(
            inspect_sdk_store_path(&symlink_path, true)
                .unwrap_err()
                .code(),
            "matrix_session_invalid"
        );
    }

    #[tokio::test]
    async fn bootstrap_existing_application_session_fails_before_network_or_sdk_open() {
        let server = MatrixMockServer::new().await;
        let app_directory = tempdir().expect("application directory");
        let sdk_directory = tempdir().expect("SDK directory");
        fs::set_permissions(app_directory.path(), fs::Permissions::from_mode(0o700))
            .expect("application permissions");
        fs::set_permissions(sdk_directory.path(), fs::Permissions::from_mode(0o700))
            .expect("SDK permissions");
        let app_path = app_directory.path().join("gateway.sqlite3");
        let sdk_path = sdk_directory.path().join("matrix-sdk");
        let user_id = ruma::user_id!("@already-bootstrapped:example.org");
        let session = MatrixSession {
            meta: SessionMeta {
                user_id: user_id.to_owned(),
                device_id: ruma::device_id!("ALREADYBOOTSTRAPPED").to_owned(),
            },
            tokens: SessionTokens {
                access_token: "already-bootstrapped-token".to_owned(),
                refresh_token: None,
            },
        };
        let mut state_store = Store::open(
            &app_path,
            Keyring::new([0x11; 32], 1).expect("test keyring"),
        )
        .expect("application store");
        state_store
            .initialize_bootstrap_state(
                NewBootstrapState::new(
                    serde_json::to_vec(&session).expect("session encoding"),
                    b"already-bootstrapped-next".to_vec(),
                    Vec::new(),
                    timestamp(1_700_000_010_000),
                )
                .expect("bootstrap fixture"),
            )
            .expect("bootstrap fixture persistence");

        let error = bootstrap_matrix(
            &server.uri(),
            user_id.as_str(),
            &sdk_path,
            &SecretBytes::from_text(b"password", 1024).expect("password"),
            &SecretBytes::from_text(b"passphrase", 1024).expect("passphrase"),
            &mut state_store,
            timestamp(1_700_000_011_000),
        )
        .await
        .expect_err("an existing application session must block bootstrap");
        assert_eq!(error.code(), "matrix_session_invalid");
        assert!(!sdk_path.exists(), "the SDK path must not be touched");
        assert!(
            server
                .server()
                .received_requests()
                .await
                .expect("requests recorded")
                .is_empty()
        );
    }

    #[tokio::test]
    async fn bootstrap_rejects_invited_and_left_rooms_before_sdk_feed() {
        let server = MatrixMockServer::new().await;
        let user_id = ruma::user_id!("@membership-reject:example.org");
        let invite_room = ruma::room_id!("!membership-invite:example.org");
        let left_room = ruma::room_id!("!membership-left:example.org");
        let mut sync = SyncResponseBuilder::new();
        sync.add_invited_room(InvitedRoomBuilder::new(invite_room));
        sync.add_left_room(LeftRoomBuilder::new(left_room));
        let mut sync = sync.build_sync_response();
        sync.next_batch = "membership-rejected-next".to_owned();
        let body = sync
            .try_into_http_response()
            .expect("sync fixture should serialize")
            .into_body();
        mount_bootstrap_mocks(&server, user_id, body).await;

        let app_directory = tempdir().expect("application directory");
        let sdk_directory = tempdir().expect("SDK directory");
        fs::set_permissions(app_directory.path(), fs::Permissions::from_mode(0o700))
            .expect("application permissions");
        fs::set_permissions(sdk_directory.path(), fs::Permissions::from_mode(0o700))
            .expect("SDK permissions");
        let app_path = app_directory.path().join("gateway.sqlite3");
        let sdk_path = sdk_directory.path().join("matrix-sdk");
        let mut state_store = Store::open(
            &app_path,
            Keyring::new([0x11; 32], 1).expect("test keyring"),
        )
        .expect("application store");
        let error = bootstrap_matrix(
            &server.uri(),
            user_id.as_str(),
            &sdk_path,
            &SecretBytes::from_text(b"password", 1024).expect("password"),
            &SecretBytes::from_text(b"passphrase", 1024).expect("passphrase"),
            &mut state_store,
            timestamp(1_700_000_012_000),
        )
        .await
        .expect_err("invited and left rooms must fail closed");
        assert_eq!(error.code(), "matrix_room_membership_invalid");
        assert!(
            state_store
                .matrix_session()
                .expect("session state should remain readable")
                .is_none()
        );

        let crypto = SqliteCryptoStore::open(&sdk_path, Some("passphrase"))
            .await
            .expect("partial SDK store should remain openable");
        assert!(
            crypto
                .load_account()
                .await
                .expect("crypto account")
                .is_some()
        );
        drop(crypto);
        let requests = server
            .server()
            .received_requests()
            .await
            .expect("requests recorded");
        assert_eq!(requests.len(), 2);
        assert!(state_store.oldest_uncommitted_inbox().is_err());
    }

    #[tokio::test]
    async fn bootstrap_application_persistence_failure_leaves_sdk_state_intact() {
        let server = MatrixMockServer::new().await;
        let user_id = ruma::user_id!("@persistence-failure:example.org");
        let mut sync = SyncResponseBuilder::new().build_sync_response();
        sync.next_batch = "persistence-failure-next".to_owned();
        let body = sync
            .try_into_http_response()
            .expect("sync fixture should serialize")
            .into_body();
        mount_bootstrap_mocks(&server, user_id, body).await;

        let app_directory = tempdir().expect("application directory");
        let sdk_directory = tempdir().expect("SDK directory");
        fs::set_permissions(app_directory.path(), fs::Permissions::from_mode(0o700))
            .expect("application permissions");
        fs::set_permissions(sdk_directory.path(), fs::Permissions::from_mode(0o700))
            .expect("SDK permissions");
        let app_path = app_directory.path().join("gateway.sqlite3");
        let sdk_path = sdk_directory.path().join("matrix-sdk");
        let mut state_store = Store::open(
            &app_path,
            Keyring::new([0x11; 32], 1).expect("test keyring"),
        )
        .expect("application store");
        Connection::open(&app_path)
            .expect("secondary sqlite connection")
            .execute_batch(
                "CREATE TRIGGER fail_bootstrap_insert BEFORE INSERT ON gateway_state
                 BEGIN SELECT RAISE(ABORT, 'fixture failure'); END;",
            )
            .expect("persistence failure trigger");

        let error = bootstrap_matrix(
            &server.uri(),
            user_id.as_str(),
            &sdk_path,
            &SecretBytes::from_text(b"password", 1024).expect("password"),
            &SecretBytes::from_text(b"passphrase", 1024).expect("passphrase"),
            &mut state_store,
            timestamp(1_700_000_013_000),
        )
        .await
        .expect_err("application persistence must fail closed");
        assert_eq!(error.code(), "matrix_session_invalid");
        assert!(!format!("{error:?}").contains("fixture failure"));
        assert!(
            state_store
                .matrix_session()
                .expect("application state remains readable")
                .is_none()
        );

        let reopened = open_activated_base_client(
            &sdk_path,
            &sdk_path,
            "passphrase",
            SessionMeta {
                user_id: user_id.to_owned(),
                device_id: ruma::device_id!("BOOTSTRAPDEVICE").to_owned(),
            },
        )
        .await
        .expect("SDK stores must remain intact after application failure");
        assert_eq!(
            reopened.sync_token().await.as_deref(),
            Some("persistence-failure-next")
        );
        reopened
            .close_stores()
            .await
            .expect("close reopened stores");
        let requests = server
            .server()
            .received_requests()
            .await
            .expect("requests recorded");
        assert_eq!(requests.len(), 2);
    }

    #[tokio::test]
    async fn bootstrap_logs_in_once_syncs_once_and_persists_only_checkpoint_state() {
        let server = MatrixMockServer::new().await;
        let user_id = owned_user_id!("@bootstrap:example.org");
        let room_with_event = room_id!("!bootstrap-event:example.org");
        let room_without_event = room_id!("!bootstrap-empty:example.org");
        let event_id = event_id!("$bootstrap-anchor:example.org");
        let mut sync = SyncResponseBuilder::new()
            .add_joined_room(
                JoinedRoomBuilder::new(room_with_event).add_timeline_event(
                    EventFactory::new()
                        .room(room_with_event)
                        .sender(&user_id)
                        .text_msg("initial history")
                        .event_id(event_id),
                ),
            )
            .add_joined_room(JoinedRoomBuilder::new(room_without_event))
            .build_sync_response();
        sync.next_batch = "bootstrap-next".to_owned();
        let sync_response: http::Response<Vec<u8>> = sync
            .try_into_http_response()
            .expect("sync fixture should serialize");
        let sync_body = sync_response.into_body();

        Mock::given(matchers::method("POST"))
            .and(matchers::path("/_matrix/client/v3/login"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "access_token": "bootstrap-access-token",
                "device_id": "BOOTSTRAPDEVICE",
                "home_server": "example.org",
                "user_id": user_id.as_str(),
            })))
            .expect(1)
            .mount(server.server())
            .await;
        Mock::given(matchers::method("GET"))
            .and(matchers::path("/_matrix/client/v3/sync"))
            .respond_with(
                ResponseTemplate::new(200)
                    .insert_header("content-type", "application/json")
                    .set_body_bytes(sync_body),
            )
            .expect(1)
            .mount(server.server())
            .await;

        let app_directory = tempdir().unwrap();
        let sdk_directory = tempdir().unwrap();
        fs::set_permissions(app_directory.path(), fs::Permissions::from_mode(0o700)).unwrap();
        fs::set_permissions(sdk_directory.path(), fs::Permissions::from_mode(0o700)).unwrap();
        let app_path = app_directory.path().join("gateway.sqlite3");
        let sdk_path = sdk_directory.path().join("matrix-sdk");
        let mut state_store = Store::open(
            &app_path,
            Keyring::new([0x11; 32], 1).expect("test keyring"),
        )
        .unwrap();
        let password = SecretBytes::from_text(b"bootstrap-password", 1024).unwrap();
        let passphrase = SecretBytes::from_text(b"bootstrap-passphrase", 1024).unwrap();
        bootstrap_matrix(
            &server.uri(),
            user_id.as_str(),
            &sdk_path,
            &password,
            &passphrase,
            &mut state_store,
            Utc.timestamp_millis_opt(1_700_000_020_000)
                .single()
                .unwrap(),
        )
        .await
        .expect("bootstrap should succeed");

        let requests = server
            .server()
            .received_requests()
            .await
            .expect("requests recorded");
        assert_eq!(requests.len(), 2);
        let login = requests
            .iter()
            .find(|request| request.method == http::Method::POST)
            .expect("login request");
        let login_json: Value = serde_json::from_slice(&login.body).expect("login JSON");
        assert_eq!(
            login_json["identifier"]["user"].as_str(),
            Some(user_id.as_str())
        );
        assert_eq!(
            login_json["initial_device_display_name"].as_str(),
            Some("communicator-matrix-gateway")
        );
        let initial_sync = requests
            .iter()
            .find(|request| request.method == http::Method::GET)
            .expect("initial sync request");
        assert_eq!(initial_sync.url.path(), "/_matrix/client/v3/sync");
        assert_eq!(
            initial_sync
                .url
                .query_pairs()
                .find_map(|(key, value)| (key == "timeout").then(|| value.into_owned()))
                .as_deref(),
            Some("30000")
        );
        assert!(
            initial_sync
                .url
                .query_pairs()
                .all(|(key, _)| key != "since")
        );
        assert_eq!(
            initial_sync
                .headers
                .get("authorization")
                .and_then(|value| value.to_str().ok()),
            Some("Bearer bootstrap-access-token")
        );

        let serialized = state_store
            .matrix_session()
            .expect("session state")
            .expect("bootstrap session");
        let session: MatrixSession = serde_json::from_slice(serialized.as_bytes()).unwrap();
        assert_eq!(session.meta.user_id, user_id);
        assert_eq!(session.meta.device_id.as_str(), "BOOTSTRAPDEVICE");
        assert_eq!(session.tokens.access_token, "bootstrap-access-token");
        assert_eq!(
            state_store
                .committed_sync_token()
                .unwrap()
                .unwrap()
                .as_bytes(),
            b"bootstrap-next"
        );
        assert_eq!(
            state_store.fetch_sync_token().unwrap().unwrap().as_bytes(),
            b"bootstrap-next"
        );
        assert!(state_store.oldest_uncommitted_inbox().unwrap().is_none());

        let keyring = Keyring::new([0x11; 32], 1).expect("test keyring");
        let event_lookup = registry::room_lookup(&keyring, room_with_event.as_str()).unwrap();
        assert_eq!(
            state_store
                .room_anchor(&event_lookup)
                .unwrap()
                .unwrap()
                .as_bytes(),
            event_id.as_str().as_bytes()
        );
        let empty_lookup = registry::room_lookup(&keyring, room_without_event.as_str()).unwrap();
        assert!(state_store.room_anchor(&empty_lookup).unwrap().is_none());

        let reopened = open_activated_base_client(
            &sdk_path,
            &sdk_path,
            "bootstrap-passphrase",
            session.meta.clone(),
        )
        .await
        .expect("SDK stores reopen");
        assert_eq!(
            reopened.sync_token().await.as_deref(),
            Some("bootstrap-next")
        );
        let machine_guard = reopened.olm_machine().await;
        let machine = machine_guard.as_ref().expect("restored account");
        assert_eq!(machine.user_id(), user_id);
        assert_eq!(machine.device_id().as_str(), "BOOTSTRAPDEVICE");
        drop(machine_guard);
        reopened.close_stores().await.unwrap();
    }
}

#[cfg(test)]
mod task4_sync_tests {
    use super::*;
    use matrix_sdk_test::{JoinedRoomBuilder, SyncResponseBuilder, event_factory::EventFactory};
    use ruma::{events::AnySyncTimelineEvent, owned_user_id, room_id, serde::Raw};

    #[tokio::test]
    async fn raw_recovery_extracts_allowed_kinds_in_sorted_source_order_and_gaps() {
        let user_id = owned_user_id!("@task4:example.org");
        let room_a = room_id!("!a-task4:example.org");
        let room_b = room_id!("!b-task4:example.org");
        let factory_a = EventFactory::new().room(room_a).sender(&user_id);
        let factory_b = EventFactory::new().room(room_b).sender(&user_id);
        let event_a = factory_a
            .text_msg("timeline-a")
            .event_id(ruma::event_id!("$timeline-a:example.org"))
            .into_raw_sync();
        let state_a = factory_a
            .room_name("state-a")
            .event_id(ruma::event_id!("$state-a:example.org"))
            .into_raw_sync_state();
        let event_b = factory_b
            .text_msg("timeline-b")
            .event_id(ruma::event_id!("$timeline-b:example.org"))
            .into_raw_sync();
        let joined_a = JoinedRoomBuilder::new(room_a)
            .add_timeline_event(event_a)
            .add_state_event(state_a)
            .add_receipt(
                factory_a
                    .read_receipts()
                    .add(
                        ruma::event_id!("$timeline-a:example.org"),
                        &user_id,
                        ruma::events::receipt::ReceiptType::Read,
                        ruma::events::receipt::ReceiptThread::Unthreaded,
                    )
                    .into_event(),
            )
            .add_typing(factory_a.typing(vec![&user_id]))
            .set_timeline_limited()
            .set_timeline_prev_batch("gap-a");
        let joined_b = JoinedRoomBuilder::new(room_b)
            .add_timeline_event(event_b)
            .set_timeline_limited()
            .set_timeline_prev_batch("gap-b");
        let response = SyncResponseBuilder::new()
            .add_joined_room(joined_b)
            .add_joined_room(joined_a)
            .build_sync_response();

        let processed = extract_raw_observations(&response, None).await.unwrap();
        let kinds: Vec<_> = processed
            .events()
            .iter()
            .map(ObservedMatrixEvent::discriminant)
            .collect();
        assert_eq!(
            kinds,
            ["timeline", "state", "receipt", "typing", "timeline"]
        );
        let rooms: Vec<_> = processed
            .events()
            .iter()
            .map(|event| event.room_event().room_id().as_bytes())
            .collect();
        assert!(rooms.windows(2).all(|pair| pair[0] <= pair[1]));
        assert_eq!(processed.gap_count(), 2);
        assert!(
            processed
                .gaps()
                .iter()
                .all(|gap| !gap.prev_batch().is_empty())
        );
    }

    #[test]
    fn sync_validation_rejects_membership_duplicates_and_mismatched_rooms() {
        let room = room_id!("!task4-validation:example.org");
        let other_room = room_id!("!task4-other:example.org");
        let user_id = owned_user_id!("@task4-validation:example.org");
        let event = EventFactory::new()
            .room(room)
            .sender(&user_id)
            .text_msg("duplicate")
            .event_id(ruma::event_id!("$duplicate-task4:example.org"))
            .into_raw_sync();
        let response = SyncResponseBuilder::new()
            .add_joined_room(JoinedRoomBuilder::new(room).add_timeline_event(event.clone()))
            .add_joined_room(JoinedRoomBuilder::new(other_room).add_timeline_event(event))
            .build_sync_response();
        assert_eq!(
            validate_response_event_ids(&response).unwrap_err().code(),
            MATRIX_RESPONSE_INVALID
        );

        let mut membership = SyncResponseBuilder::new();
        membership.add_invited_room(matrix_sdk_test::InvitedRoomBuilder::new(room));
        let membership = membership.build_sync_response();
        assert_eq!(
            reject_invalid_memberships(&membership).unwrap_err().code(),
            MATRIX_ROOM_MEMBERSHIP_INVALID
        );

        let mismatched: Raw<AnySyncTimelineEvent> = matrix_sdk_test::sync_timeline_event!({
            "event_id": "$mismatch-task4:example.org",
            "origin_server_ts": 1,
            "sender": "@task4-validation:example.org",
            "type": "m.room.message",
            "room_id": "!not-the-joined-room:example.org",
            "content": {"msgtype": "m.text", "body": "mismatch"}
        });
        let mismatch = SyncResponseBuilder::new()
            .add_joined_room(JoinedRoomBuilder::new(room).add_timeline_event(mismatched))
            .build_sync_response();
        assert_eq!(
            validate_response_event_rooms(&mismatch).unwrap_err().code(),
            MATRIX_RESPONSE_INVALID
        );
    }
}
