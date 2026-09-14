//! Private provider gateway for the pinned mautrix-whatsapp provisioning API.
//!
//! The HTTP surface in this module is intentionally provider-neutral.  Only
//! this adapter knows the mautrix process, step, and transaction identifiers;
//! they remain in a bounded in-memory map and are never returned to the
//! control-plane Worker or browser.

use std::{collections::HashMap, fmt, net::SocketAddr, sync::Arc, time::Duration};

use chrono::{DateTime, TimeZone, Utc};
use reqwest::{Client, Method, StatusCode, Url, redirect::Policy};
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    sync::Mutex,
};
use uuid::Uuid;

use crate::{
    history::HistoryGatewayServer,
    ingestion::SecretString,
    model::Provider,
    outbound::{
        MatrixGroupAction, MatrixGroupChange, MatrixGroupFailure, MatrixGroupManager,
        MatrixGroupObservation, MatrixGroupObservationRequest, OutboundTextSender,
    },
    store::{NewOutboundText, OutboundTextCompletion, OutboundTextPreparation, Store},
};

const PROVISIONING_ROOT: &str = "/_matrix/provision/v3";
const MAX_HTTP_BODY_BYTES: usize = 64 * 1024;
const MAX_QR_BYTES: usize = 16 * 1024;
const MAX_ID_BYTES: usize = 512;
const PROVIDER_ERROR: &str = "provider_error";
const PROVIDER_UNAVAILABLE: &str = "provider_unavailable";
const PROVISIONING_DISABLED: &str = "provisioning_disabled";
const PROVISIONING_UNSUPPORTED: &str = "provisioning_unsupported";
const IDENTITY_MISMATCH: &str = "identity_mismatch";
const INVALID_REQUEST: &str = "invalid_request";
const CONTACT_MISSING_STORE: &str = "contact_registry_unavailable";
const CONTACT_SCOPE_MISMATCH: &str = "contact_scope_mismatch";
const CONTACT_UNCERTAIN: &str = "contact_creation_uncertain";
const GROUP_MISSING_STORE: &str = "group_registry_unavailable";
const GROUP_SCOPE_MISMATCH: &str = "group_scope_mismatch";
const GROUP_UNCERTAIN: &str = "group_creation_uncertain";
const GROUP_MANAGEMENT_SCOPE_MISMATCH: &str = "group_management_scope_mismatch";
const GROUP_MANAGEMENT_UNCERTAIN: &str = "group_management_uncertain";
const OUTBOUND_TRANSACTION_CONFLICT: &str = "outbound_transaction_conflict";
const OUTBOUND_SCOPE_MISMATCH: &str = "outbound_scope_mismatch";
const OUTBOUND_UNCERTAIN: &str = "outbound_delivery_uncertain";
const OUTBOUND_MISSING_SENDER: &str = "outbound_sender_unavailable";
const OUTBOUND_STALE_SESSION: &str = "outbound_stale_session";

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ProvisioningFailure {
    ProviderError,
    ProviderUnavailable,
    ProvisioningDisabled,
    ProvisioningUnsupported,
    IdentityMismatch,
    InvalidRequest,
}

impl ProvisioningFailure {
    pub const fn code(self) -> &'static str {
        match self {
            Self::ProviderError => PROVIDER_ERROR,
            Self::ProviderUnavailable => PROVIDER_UNAVAILABLE,
            Self::ProvisioningDisabled => PROVISIONING_DISABLED,
            Self::ProvisioningUnsupported => PROVISIONING_UNSUPPORTED,
            Self::IdentityMismatch => IDENTITY_MISMATCH,
            Self::InvalidRequest => INVALID_REQUEST,
        }
    }
}

impl fmt::Display for ProvisioningFailure {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.code())
    }
}

impl std::error::Error for ProvisioningFailure {}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProvisioningStart {
    pub gateway_ref: String,
    pub qr: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ProvisioningPoll {
    Qr { qr: Option<String> },
    Connected { user_login_id: String },
    Expired,
    Failed(ProvisioningFailure),
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct PrivateLoginHandle {
    process_id: String,
    step_id: String,
    txn_id: String,
}

/// A bounded client for the exact mautrix-go v0.30.0 provisioning routes.
pub struct WhatsAppProvisioningClient {
    client: Client,
    bridge_url: Url,
    shared_secret: SecretString,
    matrix_user_id: String,
    sessions: Arc<Mutex<HashMap<String, PrivateLoginHandle>>>,
}

impl fmt::Debug for WhatsAppProvisioningClient {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("WhatsAppProvisioningClient([REDACTED])")
    }
}

impl WhatsAppProvisioningClient {
    /// Construct the production adapter.  The bridge endpoint must be HTTPS;
    /// loopback HTTP is available only through `new_for_test`.
    pub fn new(
        bridge_url: impl AsRef<str>,
        shared_secret: SecretString,
        matrix_user_id: impl Into<String>,
        timeout: Duration,
    ) -> Result<Self, ProvisioningFailure> {
        Self::build(
            bridge_url.as_ref(),
            shared_secret,
            matrix_user_id.into(),
            timeout,
            false,
        )
    }

    /// Construct a loopback-only adapter for a controlled HTTP fixture.
    pub fn new_for_test(
        bridge_url: impl AsRef<str>,
        shared_secret: SecretString,
        matrix_user_id: impl Into<String>,
        timeout: Duration,
    ) -> Result<Self, ProvisioningFailure> {
        Self::build(
            bridge_url.as_ref(),
            shared_secret,
            matrix_user_id.into(),
            timeout,
            true,
        )
    }

    fn build(
        bridge_url: &str,
        shared_secret: SecretString,
        matrix_user_id: String,
        timeout: Duration,
        allow_loopback_http: bool,
    ) -> Result<Self, ProvisioningFailure> {
        if shared_secret.as_str().len() < 16 || matrix_user_id.is_empty() || timeout.is_zero() {
            return Err(ProvisioningFailure::InvalidRequest);
        }
        let url = Url::parse(bridge_url).map_err(|_| ProvisioningFailure::InvalidRequest)?;
        let loopback_http = allow_loopback_http
            && url.scheme() == "http"
            && matches!(url.host_str(), Some("127.0.0.1" | "localhost"))
            && url.port().is_some();
        if (url.scheme() != "https" && !loopback_http)
            || url.username() != ""
            || url.password().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
            || url.path() != "/"
        {
            return Err(ProvisioningFailure::InvalidRequest);
        }
        let client = Client::builder()
            .redirect(Policy::none())
            .no_proxy()
            .referer(false)
            .no_gzip()
            .no_brotli()
            .no_zstd()
            .no_deflate()
            .https_only(!loopback_http)
            .connect_timeout(timeout)
            .build()
            .map_err(|_| ProvisioningFailure::InvalidRequest)?;
        Ok(Self {
            client,
            bridge_url: url,
            shared_secret,
            matrix_user_id,
            sessions: Arc::new(Mutex::new(HashMap::new())),
        })
    }

    fn route_url(&self, path: &str) -> Result<Url, ProvisioningFailure> {
        self.bridge_url
            .join(path.trim_start_matches('/'))
            .map_err(|_| ProvisioningFailure::InvalidRequest)
    }

    async fn request(
        &self,
        method: Method,
        path: &str,
        query: &[(&str, &str)],
    ) -> Result<Value, ProvisioningFailure> {
        let (status, value) = self.request_raw(method, path, query, None).await?;
        if !status.is_success() {
            return Err(ProvisioningFailure::ProviderError);
        }
        Ok(value)
    }

    async fn request_raw(
        &self,
        method: Method,
        path: &str,
        query: &[(&str, &str)],
        body: Option<&Value>,
    ) -> Result<(StatusCode, Value), ProvisioningFailure> {
        let mut url = self.route_url(path)?;
        {
            let mut pairs = url.query_pairs_mut();
            for (name, value) in query {
                pairs.append_pair(name, value);
            }
        }
        let mut request = self
            .client
            .request(method, url)
            .bearer_auth(self.shared_secret.as_str());
        if let Some(body) = body {
            let bytes = serde_json::to_vec(body).map_err(|_| ProvisioningFailure::ProviderError)?;
            request = request
                .header("content-type", "application/json")
                .body(bytes);
        }
        let response = request
            .send()
            .await
            .map_err(|_| ProvisioningFailure::ProviderUnavailable)?;
        let status = response.status();
        let body = read_bounded_body(response).await?;
        if status == StatusCode::UNAUTHORIZED || status == StatusCode::FORBIDDEN {
            return Err(ProvisioningFailure::ProvisioningDisabled);
        }
        let value =
            serde_json::from_slice(&body).map_err(|_| ProvisioningFailure::ProviderError)?;
        Ok((status, value))
    }

    /// Search provider users through the pinned provisioning endpoint. A
    /// missing endpoint is an explicit unsupported capability, so the Worker
    /// can report that state instead of fabricating a contact.
    pub async fn search_users(
        &self,
        provider_login_id: &str,
        query: &str,
    ) -> Result<Value, ProvisioningFailure> {
        if query.trim().is_empty() || query.len() > 200 {
            return Err(ProvisioningFailure::InvalidRequest);
        }
        let (status, value) = self
            .request_raw(
                Method::POST,
                &format!("{PROVISIONING_ROOT}/search_users"),
                &[("login_id", provider_login_id)],
                Some(&json!({ "query": query })),
            )
            .await?;
        if status == StatusCode::NOT_FOUND
            || status == StatusCode::NOT_IMPLEMENTED
            || status == StatusCode::METHOD_NOT_ALLOWED
        {
            return Err(ProvisioningFailure::ProvisioningUnsupported);
        }
        if !status.is_success() {
            return Err(ProvisioningFailure::ProviderError);
        }
        Ok(value)
    }

    /// Resolve one explicit provider identifier. A 404 is preserved as an
    /// unresolved result so the private gateway never turns it into a mock
    /// success.
    pub async fn resolve_identifier(
        &self,
        provider_login_id: &str,
        identifier: &str,
    ) -> Result<Option<Value>, ProvisioningFailure> {
        if identifier.is_empty() || identifier.len() > MAX_ID_BYTES {
            return Err(ProvisioningFailure::InvalidRequest);
        }
        let (status, value) = self
            .request_raw(
                Method::GET,
                &format!(
                    "{PROVISIONING_ROOT}/resolve_identifier/{}",
                    encode_path(identifier)
                ),
                &[("login_id", provider_login_id)],
                None,
            )
            .await?;
        if status == StatusCode::NOT_FOUND {
            return Ok(None);
        }
        if status == StatusCode::NOT_IMPLEMENTED || status == StatusCode::METHOD_NOT_ALLOWED {
            return Err(ProvisioningFailure::ProvisioningUnsupported);
        }
        if !status.is_success() {
            return Err(ProvisioningFailure::ProviderError);
        }
        Ok(Some(value))
    }

    /// Ask the bridge to create the one-to-one room for one already resolved
    /// provider identifier. The returned object is validated by the gateway
    /// handler before any room binding is persisted.
    pub async fn create_dm(
        &self,
        provider_login_id: &str,
        identifier: &str,
    ) -> Result<Value, ProvisioningFailure> {
        if identifier.is_empty() || identifier.len() > MAX_ID_BYTES {
            return Err(ProvisioningFailure::InvalidRequest);
        }
        let (status, value) = self
            .request_raw(
                Method::POST,
                &format!("{PROVISIONING_ROOT}/create_dm/{}", encode_path(identifier)),
                &[("login_id", provider_login_id)],
                None,
            )
            .await?;
        if status == StatusCode::NOT_IMPLEMENTED || status == StatusCode::METHOD_NOT_ALLOWED {
            return Err(ProvisioningFailure::ProvisioningUnsupported);
        }
        if !status.is_success() {
            return Err(ProvisioningFailure::ProviderError);
        }
        Ok(value)
    }

    /// Create one WhatsApp group through bridgev2's pinned
    /// `create_group/{type}` route. The body intentionally follows the
    /// provider schema: participants are provider IDs and the requested name
    /// is nested under `name.name`.
    pub async fn create_group(
        &self,
        provider_login_id: &str,
        name: &str,
        participants: &[String],
    ) -> Result<Value, ProvisioningFailure> {
        if name.trim().is_empty()
            || name.len() > 100
            || participants.is_empty()
            || participants.len() > 128
            || participants.iter().any(|value| {
                value.is_empty()
                    || value.len() > MAX_ID_BYTES
                    || value.chars().any(char::is_whitespace)
            })
        {
            return Err(ProvisioningFailure::InvalidRequest);
        }
        let (status, value) = self
            .request_raw(
                Method::POST,
                &format!("{PROVISIONING_ROOT}/create_group/group"),
                &[("login_id", provider_login_id)],
                Some(&json!({
                    "participants": participants,
                    "name": { "name": name }
                })),
            )
            .await?;
        if status == StatusCode::NOT_IMPLEMENTED || status == StatusCode::METHOD_NOT_ALLOWED {
            return Err(ProvisioningFailure::ProvisioningUnsupported);
        }
        if !status.is_success() {
            return Err(ProvisioningFailure::ProviderError);
        }
        Ok(value)
    }

    /// Start a QR login.  The adapter first checks the pinned connector's
    /// advertised flows, then starts the exact `start/qr` process.
    pub async fn start_qr(&self) -> Result<ProvisioningStart, ProvisioningFailure> {
        let flows = self
            .request(
                Method::GET,
                &format!("{PROVISIONING_ROOT}/login/flows"),
                &[("user_id", self.matrix_user_id.as_str())],
            )
            .await?;
        if !advertises_qr(&flows) {
            return Err(ProvisioningFailure::ProviderError);
        }
        let response = self
            .request(
                Method::POST,
                &format!("{PROVISIONING_ROOT}/login/start/qr"),
                &[("user_id", self.matrix_user_id.as_str())],
            )
            .await?;
        let process_id = required_id(&response, &["login_id", "process_id"])?;
        let step_id = required_id(&response, &["step_id", "step"])?;
        let txn_id = required_id(&response, &["txn_id", "transaction_id"])?;
        let qr = qr_data(&response)?.ok_or(ProvisioningFailure::ProviderError)?;
        let gateway_ref = format!("gw_{}", Uuid::new_v4().simple());
        self.sessions.lock().await.insert(
            gateway_ref.clone(),
            PrivateLoginHandle {
                process_id,
                step_id,
                txn_id,
            },
        );
        Ok(ProvisioningStart { gateway_ref, qr })
    }

    /// Poll/rotate a QR with the exact `display_and_wait` step route.
    pub async fn poll(&self, gateway_ref: &str) -> Result<ProvisioningPoll, ProvisioningFailure> {
        if gateway_ref.is_empty() || gateway_ref.len() > MAX_ID_BYTES {
            return Err(ProvisioningFailure::InvalidRequest);
        }
        let handle = self
            .sessions
            .lock()
            .await
            .get(gateway_ref)
            .cloned()
            .ok_or(ProvisioningFailure::ProviderUnavailable)?;
        let path = format!(
            "{PROVISIONING_ROOT}/login/step/{}/{}/display_and_wait",
            encode_path(&handle.process_id),
            encode_path(&handle.step_id),
        );
        let response = self
            .request(
                Method::POST,
                &path,
                &[
                    ("txn_id", handle.txn_id.as_str()),
                    ("user_id", self.matrix_user_id.as_str()),
                ],
            )
            .await?;
        if let Some(user_login_id) = complete_identity(&response) {
            if user_login_id.is_empty() || user_login_id.len() > MAX_ID_BYTES {
                return Err(ProvisioningFailure::IdentityMismatch);
            }
            self.sessions.lock().await.remove(gateway_ref);
            return Ok(ProvisioningPoll::Connected { user_login_id });
        }
        if let Some(error_code) = error_code(&response) {
            if error_code == "FI.MAU.WHATSAPP.LOGIN_TIMEOUT" {
                self.sessions.lock().await.remove(gateway_ref);
                return Ok(ProvisioningPoll::Expired);
            }
            return Ok(ProvisioningPoll::Failed(ProvisioningFailure::ProviderError));
        }
        let qr = qr_data(&response)?;
        let next_step = optional_id(&response, &["step_id", "step"]).unwrap_or(handle.step_id);
        let next_txn =
            optional_id(&response, &["txn_id", "transaction_id"]).unwrap_or(handle.txn_id);
        self.sessions.lock().await.insert(
            gateway_ref.to_owned(),
            PrivateLoginHandle {
                process_id: handle.process_id,
                step_id: next_step,
                txn_id: next_txn,
            },
        );
        Ok(ProvisioningPoll::Qr { qr })
    }

    /// Cancel the exact bridge process.  Missing opaque references are
    /// idempotent and do not reveal provider state.
    pub async fn cancel(&self, gateway_ref: &str) -> Result<(), ProvisioningFailure> {
        let Some(handle) = self.sessions.lock().await.get(gateway_ref).cloned() else {
            return Ok(());
        };
        self.request(
            Method::POST,
            &format!(
                "{PROVISIONING_ROOT}/login/cancel/{}",
                encode_path(&handle.process_id)
            ),
            &[("user_id", self.matrix_user_id.as_str())],
        )
        .await?;
        self.sessions.lock().await.remove(gateway_ref);
        Ok(())
    }
}

fn encode_path(value: &str) -> String {
    url::form_urlencoded::byte_serialize(value.as_bytes()).collect()
}

fn decode_path_suffix(path: &str, prefix: &str) -> Option<String> {
    let encoded = path.strip_prefix(prefix)?;
    if encoded.is_empty() {
        return None;
    }
    url::form_urlencoded::parse(format!("value={encoded}").as_bytes())
        .next()
        .map(|(_, value)| value.into_owned())
        .filter(|value| !value.is_empty() && value.len() <= MAX_ID_BYTES)
}

fn deterministic_binding_id(tenant_id: &str, account_id: &str, conversation_id: &str) -> String {
    let mut digest = Sha256::new();
    digest.update(tenant_id.as_bytes());
    digest.update([0]);
    digest.update(account_id.as_bytes());
    digest.update([0]);
    digest.update(conversation_id.as_bytes());
    let encoded = digest.finalize();
    format!(
        "binding_{}",
        encoded
            .iter()
            .take(16)
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>()
    )
}

#[derive(Clone, Debug)]
struct DirectChatPayload {
    provider_id: String,
    matrix_room_id: String,
}

fn provider_identifier(value: &Value) -> Result<String, ProvisioningFailure> {
    let provider_id = value
        .get("id")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty() && value.len() <= MAX_ID_BYTES)
        .ok_or(ProvisioningFailure::ProviderError)?;
    Ok(provider_id.to_owned())
}

fn resolved_contact_payload(value: Value) -> Result<Value, ProvisioningFailure> {
    let _ = provider_identifier(&value)?;
    Ok(value)
}

fn search_results_payload(value: Value, operation_id: &str) -> Result<Value, ProvisioningFailure> {
    let results = value
        .get("results")
        .and_then(Value::as_array)
        .cloned()
        .or_else(|| value.as_array().cloned())
        .ok_or(ProvisioningFailure::ProviderError)?;
    if results.len() > 100 {
        return Err(ProvisioningFailure::ProviderError);
    }
    for result in &results {
        let _ = provider_identifier(result)?;
    }
    Ok(json!({
        "results": results,
        "evidence": {
            "source": "bridge",
            "operation": "search",
            "evidence_id": operation_id,
            "observed_at": Utc::now().to_rfc3339(),
            "status": "confirmed",
            "reason": null
        }
    }))
}

fn direct_chat_payload(value: Value) -> Result<DirectChatPayload, ProvisioningFailure> {
    let provider_id = provider_identifier(&value)?;
    let matrix_room_id = value
        .get("dm_room_mxid")
        .and_then(Value::as_str)
        .or_else(|| value.get("matrix_room_id").and_then(Value::as_str))
        .filter(|value| !value.is_empty() && value.len() <= MAX_ID_BYTES)
        .ok_or(ProvisioningFailure::ProviderError)?
        .to_owned();
    if value.get("mxid").and_then(Value::as_str).is_none() {
        return Err(ProvisioningFailure::ProviderError);
    }
    Ok(DirectChatPayload {
        provider_id,
        matrix_room_id,
    })
}

fn created_group_payload(value: Value) -> Result<(String, String), ProvisioningFailure> {
    let provider_group_id = value
        .get("id")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty() && value.len() <= MAX_ID_BYTES)
        .ok_or(ProvisioningFailure::ProviderError)?
        .to_owned();
    let matrix_room_id = value
        .get("mxid")
        .and_then(Value::as_str)
        .or_else(|| value.get("matrix_room_id").and_then(Value::as_str))
        .filter(|value| !value.is_empty() && value.len() <= MAX_ID_BYTES)
        .ok_or(ProvisioningFailure::ProviderError)?
        .to_owned();
    Ok((provider_group_id, matrix_room_id))
}

fn group_response(request: &GroupRequest, provider_group_id: &str, matrix_room_id: &str) -> Value {
    let observed_at = Utc::now().to_rfc3339();
    json!({
        "id": provider_group_id,
        "provider_group_id": provider_group_id,
        "mxid": matrix_room_id,
        "matrix_room_id": matrix_room_id,
        "name": request.name,
        "participants": request.participants,
        "participant_provider_ids": request.participants,
        "tenant_id": request.tenant_id,
        "identity_id": request.identity_id,
        "account_id": request.account_id,
        "connection_id": request.connection_id,
        "operation_id": request.operation_id,
        "conversation_id": request.conversation_id,
        "evidence": {
            "source": "provider",
            "evidence_id": request.operation_id,
            "observed_at": observed_at,
            "operation_id": request.operation_id,
            "account_id": request.account_id,
            "connection_id": request.connection_id,
            "provider_group_id": provider_group_id,
            "matrix_room_id": matrix_room_id,
            "participant_provider_ids": request.participants,
            "status": "confirmed",
            "reason": null
        }
    })
}

fn managed_group_response(
    request: &GroupManagementRequest,
    observation: MatrixGroupObservation,
    source: &str,
) -> Result<Value, ProvisioningFailure> {
    if observation.provider_group_id != request.provider_group_id
        || observation.matrix_room_id != request.matrix_room_id
        || observation.name.trim().is_empty()
        || observation.name.len() > 100
        || observation.revision.is_empty()
        || observation.revision.len() > MAX_ID_BYTES
        || observation.evidence_id.is_empty()
        || observation.evidence_id.len() > MAX_ID_BYTES
        || observation.member_provider_ids.len() > 128
        || observation.member_provider_ids.iter().any(|member| {
            member.is_empty()
                || member.len() > MAX_ID_BYTES
                || member.chars().any(char::is_whitespace)
        })
    {
        return Err(ProvisioningFailure::ProviderError);
    }
    Ok(json!({
        "id": observation.provider_group_id,
        "provider_group_id": observation.provider_group_id,
        "mxid": observation.matrix_room_id,
        "matrix_room_id": observation.matrix_room_id,
        "name": observation.name,
        "revision": observation.revision,
        "group_revision": observation.revision,
        "members": observation.member_provider_ids,
        "member_provider_ids": observation.member_provider_ids,
        "tenant_id": request.tenant_id,
        "identity_id": request.identity_id,
        "account_id": request.account_id,
        "connection_id": request.connection_id,
        "operation_id": request.operation_id,
        "conversation_id": request.conversation_id,
        "evidence": {
            "source": source,
            "evidence_id": observation.evidence_id,
            "observed_at": observation.observed_at,
            "operation_id": request.operation_id,
            "account_id": request.account_id,
            "connection_id": request.connection_id,
            "provider_group_id": observation.provider_group_id,
            "matrix_room_id": observation.matrix_room_id,
            "revision": observation.revision,
            "name": observation.name,
            "member_provider_ids": observation.member_provider_ids,
            "status": "confirmed",
            "reason": null
        }
    }))
}

fn contact_chat_response(request: &ContactRequest, matrix_room_id: &str, status: &str) -> Value {
    let provider_id = request.provider_id.as_deref().unwrap_or_default();
    let conversation_id = request.conversation_id.as_deref().unwrap_or_default();
    json!({
        "id": provider_id,
        "name": provider_id,
        "identifiers": [provider_id],
        "tenant_id": request.tenant_id,
        "identity_id": request.identity_id,
        "account_id": request.account_id,
        "connection_id": request.connection_id,
        "conversation_id": conversation_id,
        "session_generation": request.session_generation,
        "matrix_room_id": matrix_room_id,
        "status": status,
        "evidence": {
            "source": "bridge",
            "operation": "create_dm",
            "evidence_id": request.operation_id,
            "observed_at": Utc::now().to_rfc3339(),
            "status": status,
            "reason": null
        }
    })
}

fn contact_failure_response(error: ProvisioningFailure) -> (u16, Vec<u8>) {
    let status = match error {
        ProvisioningFailure::InvalidRequest => 400,
        ProvisioningFailure::ProvisioningUnsupported => 501,
        ProvisioningFailure::ProvisioningDisabled => 403,
        ProvisioningFailure::ProviderUnavailable
        | ProvisioningFailure::ProviderError
        | ProvisioningFailure::IdentityMismatch => 502,
    };
    response(status, json!({ "error": error.code() }))
}

fn group_failure_response(error: ProvisioningFailure) -> (u16, Vec<u8>) {
    let status = match error {
        ProvisioningFailure::InvalidRequest => 400,
        ProvisioningFailure::ProvisioningUnsupported => 501,
        ProvisioningFailure::ProvisioningDisabled => 403,
        ProvisioningFailure::ProviderUnavailable
        | ProvisioningFailure::ProviderError
        | ProvisioningFailure::IdentityMismatch => 502,
    };
    response(status, json!({ "error": error.code() }))
}

fn matrix_group_failure_response(error: MatrixGroupFailure) -> (u16, Vec<u8>) {
    let status = match error {
        MatrixGroupFailure::RoomNotFound => 404,
        MatrixGroupFailure::MalformedObservation => 502,
        MatrixGroupFailure::MatrixRequest | MatrixGroupFailure::Uncertain => 502,
    };
    response(
        status,
        json!({ "error": GROUP_MANAGEMENT_UNCERTAIN, "detail": error.code() }),
    )
}

fn string_field<'a>(value: &'a Value, names: &[&str]) -> Option<&'a str> {
    names
        .iter()
        .find_map(|name| value.get(*name).and_then(Value::as_str))
}

fn required_id(value: &Value, names: &[&str]) -> Result<String, ProvisioningFailure> {
    let result = optional_id(value, names).ok_or(ProvisioningFailure::ProviderError)?;
    if result.len() > MAX_ID_BYTES {
        return Err(ProvisioningFailure::ProviderError);
    }
    Ok(result)
}

fn optional_id(value: &Value, names: &[&str]) -> Option<String> {
    string_field(value, names)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
}

fn qr_data(value: &Value) -> Result<Option<String>, ProvisioningFailure> {
    let display = value.get("display_and_wait").unwrap_or(value);
    let candidate = display
        .get("data")
        .and_then(Value::as_str)
        .or_else(|| display.get("qr").and_then(Value::as_str));
    match candidate {
        Some(qr) if qr.len() <= MAX_QR_BYTES => Ok(Some(qr.to_owned())),
        Some(_) => Err(ProvisioningFailure::ProviderError),
        None => Ok(None),
    }
}

fn complete_identity(value: &Value) -> Option<String> {
    value
        .get("complete")
        .and_then(|complete| complete.get("user_login_id"))
        .and_then(Value::as_str)
        .map(str::to_owned)
        .or_else(|| string_field(value, &["user_login_id"]).map(str::to_owned))
}

fn error_code(value: &Value) -> Option<&str> {
    value
        .get("error")
        .and_then(Value::as_str)
        .or_else(|| value.get("error_code").and_then(Value::as_str))
}

fn advertises_qr(value: &Value) -> bool {
    value
        .get("flows")
        .and_then(Value::as_array)
        .is_some_and(|flows| {
            flows.iter().any(|flow| {
                flow.get("id")
                    .and_then(Value::as_str)
                    .or_else(|| flow.get("type").and_then(Value::as_str))
                    == Some("qr")
            })
        })
}

async fn read_bounded_body(response: reqwest::Response) -> Result<Vec<u8>, ProvisioningFailure> {
    let mut body = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = futures_util::StreamExt::next(&mut stream).await {
        let chunk = chunk.map_err(|_| ProvisioningFailure::ProviderUnavailable)?;
        if body.len().saturating_add(chunk.len()) > MAX_HTTP_BODY_BYTES {
            return Err(ProvisioningFailure::ProviderError);
        }
        body.extend_from_slice(&chunk);
    }
    Ok(body)
}

#[derive(Clone, Debug, Deserialize)]
struct GatewayRequest {
    session_id: String,
    tenant_id: String,
    actor_principal_id: String,
    membership_id: String,
    target_identity_id: String,
    provider: String,
    generation: u64,
    gateway_ref: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct OutboundRouteRequest {
    gateway_route_id: String,
    bridge_instance_id: String,
    matrix_user_id: String,
    matrix_room_namespace: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ContactRouteRequest {
    gateway_route_id: String,
    bridge_instance_id: String,
    matrix_user_id: String,
    matrix_room_namespace: String,
    provider_login_id: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ContactRequest {
    schema_version: u8,
    tenant_id: String,
    account_id: String,
    connection_id: String,
    identity_id: String,
    provider: Provider,
    session_generation: String,
    route: ContactRouteRequest,
    operation_id: String,
    query: Option<String>,
    provider_id: Option<String>,
    conversation_id: Option<String>,
}

impl ContactRequest {
    fn validate(&self, route: &GatewayRouteMetadata) -> Result<(), &'static str> {
        if self.schema_version != 1
            || self.provider != Provider::Whatsapp
            || !valid_resource_id(&self.tenant_id)
            || !valid_resource_id(&self.account_id)
            || !valid_resource_id(&self.connection_id)
            || !valid_resource_id(&self.identity_id)
            || !valid_resource_id(&self.operation_id)
            || !valid_provider_login_id(&self.route.provider_login_id)
            || DateTime::parse_from_rfc3339(&self.session_generation).is_err()
            || self.route.gateway_route_id != route.gateway_route_id
            || self.route.bridge_instance_id != route.bridge_instance_id
            || self.route.matrix_user_id != route.matrix_user_id
            || self.route.matrix_room_namespace != route.matrix_room_namespace
        {
            return Err(INVALID_REQUEST);
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct GroupRequest {
    schema_version: u8,
    tenant_id: String,
    account_id: String,
    connection_id: String,
    identity_id: String,
    provider: Provider,
    session_generation: String,
    route: ContactRouteRequest,
    operation_id: String,
    conversation_id: String,
    name: String,
    participants: Vec<String>,
}

impl GroupRequest {
    fn validate(&self, route: &GatewayRouteMetadata) -> Result<(), &'static str> {
        if self.schema_version != 1
            || self.provider != Provider::Whatsapp
            || !valid_resource_id(&self.tenant_id)
            || !valid_resource_id(&self.account_id)
            || !valid_resource_id(&self.connection_id)
            || !valid_resource_id(&self.identity_id)
            || !valid_resource_id(&self.operation_id)
            || !valid_resource_id(&self.conversation_id)
            || !valid_provider_login_id(&self.route.provider_login_id)
            || self.name.trim().is_empty()
            || self.name.len() > 100
            || self.participants.is_empty()
            || self.participants.len() > 128
            || self.participants.iter().any(|value| {
                value.is_empty()
                    || value.len() > MAX_ID_BYTES
                    || value.chars().any(char::is_whitespace)
            })
            || DateTime::parse_from_rfc3339(&self.session_generation).is_err()
            || self.route.gateway_route_id != route.gateway_route_id
            || self.route.bridge_instance_id != route.bridge_instance_id
            || self.route.matrix_user_id != route.matrix_user_id
            || self.route.matrix_room_namespace != route.matrix_room_namespace
        {
            return Err(INVALID_REQUEST);
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct GroupManagementRequest {
    schema_version: u8,
    tenant_id: String,
    account_id: String,
    connection_id: String,
    identity_id: String,
    provider: Provider,
    session_generation: String,
    route: ContactRouteRequest,
    operation_id: String,
    operation_created_at: String,
    conversation_id: String,
    provider_group_id: String,
    matrix_room_id: String,
    expected_revision: String,
    action: String,
    name: Option<String>,
    participant_provider_ids: Vec<String>,
}

impl GroupManagementRequest {
    fn validate(
        &self,
        route: &GatewayRouteMetadata,
        allow_missing_name: bool,
    ) -> Result<(), &'static str> {
        let valid_action = matches!(
            self.action.as_str(),
            "rename" | "add_participants" | "remove_participants" | "event" | "refresh"
        );
        if self.schema_version != 1
            || self.provider != Provider::Whatsapp
            || !valid_resource_id(&self.tenant_id)
            || !valid_resource_id(&self.account_id)
            || !valid_resource_id(&self.connection_id)
            || !valid_resource_id(&self.identity_id)
            || !valid_resource_id(&self.operation_id)
            || DateTime::parse_from_rfc3339(&self.operation_created_at).is_err()
            || !valid_resource_id(&self.conversation_id)
            || self.provider_group_id.is_empty()
            || self.provider_group_id.len() > MAX_ID_BYTES
            || self.matrix_room_id.is_empty()
            || self.matrix_room_id.len() > MAX_ID_BYTES
            || self.expected_revision.is_empty()
            || self.expected_revision.len() > MAX_ID_BYTES
            || !valid_provider_login_id(&self.route.provider_login_id)
            || !valid_action
            || self.participant_provider_ids.len() > 128
            || self.participant_provider_ids.iter().any(|value| {
                value.is_empty()
                    || value.len() > MAX_ID_BYTES
                    || value.chars().any(char::is_whitespace)
            })
            || (self.action == "rename"
                && !allow_missing_name
                && self
                    .name
                    .as_deref()
                    .is_none_or(|value| value.trim().is_empty() || value.len() > 100))
            || (self.action != "rename" && self.name.is_some())
            || DateTime::parse_from_rfc3339(&self.session_generation).is_err()
            || self.route.gateway_route_id != route.gateway_route_id
            || self.route.bridge_instance_id != route.bridge_instance_id
            || self.route.matrix_user_id != route.matrix_user_id
            || self.route.matrix_room_namespace != route.matrix_room_namespace
        {
            return Err(INVALID_REQUEST);
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct OutboundTextRequest {
    schema_version: u8,
    tenant_id: String,
    account_id: String,
    connection_id: String,
    identity_id: String,
    provider: Provider,
    conversation_id: String,
    message_id: String,
    event_id: String,
    transaction_id: String,
    request_digest: String,
    projection_generation: u64,
    session_generation: String,
    route: OutboundRouteRequest,
    body: String,
}

impl OutboundTextRequest {
    fn validate(&self, route: &GatewayRouteMetadata) -> Result<(), &'static str> {
        if self.schema_version != 1
            || self.provider != Provider::Whatsapp
            || !valid_resource_id(&self.tenant_id)
            || !valid_resource_id(&self.account_id)
            || !valid_resource_id(&self.connection_id)
            || !valid_resource_id(&self.identity_id)
            || !valid_resource_id(&self.conversation_id)
            || !valid_resource_id(&self.message_id)
            || !valid_resource_id(&self.event_id)
            || !valid_resource_id(&self.transaction_id)
            || !valid_digest(&self.request_digest)
            || self.projection_generation == 0
            || self.body.is_empty()
            || self.body.len() > 20_000
            || DateTime::parse_from_rfc3339(&self.session_generation).is_err()
            || self.route.gateway_route_id != route.gateway_route_id
            || self.route.bridge_instance_id != route.bridge_instance_id
            || self.route.matrix_user_id != route.matrix_user_id
            || self.route.matrix_room_namespace != route.matrix_room_namespace
        {
            return Err(INVALID_REQUEST);
        }
        Ok(())
    }
}

fn valid_resource_id(value: &str) -> bool {
    crate::model::valid_resource_id(value)
}

fn valid_provider_login_id(value: &str) -> bool {
    !value.is_empty() && value.len() <= MAX_ID_BYTES && !value.chars().any(char::is_whitespace)
}

fn valid_digest(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct GatewayOwner {
    session_id: String,
    tenant_id: String,
    actor_principal_id: String,
    membership_id: String,
    target_identity_id: String,
    provider: String,
    generation: u64,
}

impl From<&GatewayRequest> for GatewayOwner {
    fn from(request: &GatewayRequest) -> Self {
        Self {
            session_id: request.session_id.clone(),
            tenant_id: request.tenant_id.clone(),
            actor_principal_id: request.actor_principal_id.clone(),
            membership_id: request.membership_id.clone(),
            target_identity_id: request.target_identity_id.clone(),
            provider: request.provider.clone(),
            generation: request.generation,
        }
    }
}

#[derive(Clone, Debug)]
struct GatewaySession {
    owner: GatewayOwner,
    gateway_ref: String,
}

#[derive(Clone, Debug)]
pub struct GatewayRouteMetadata {
    pub gateway_route_id: String,
    pub bridge_instance_id: String,
    pub matrix_user_id: String,
    pub matrix_room_namespace: String,
}

#[derive(Clone)]
pub struct ProvisioningGatewayServer {
    client: Arc<WhatsAppProvisioningClient>,
    gateway_token: SecretString,
    route: GatewayRouteMetadata,
    sessions: Arc<Mutex<HashMap<String, GatewaySession>>>,
    history: Option<Arc<HistoryGatewayServer>>,
    outbound_store: Option<Arc<Mutex<Store>>>,
    outbound_sender: Option<Arc<dyn OutboundTextSender>>,
    group_manager: Option<Arc<dyn MatrixGroupManager>>,
}

impl fmt::Debug for ProvisioningGatewayServer {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("ProvisioningGatewayServer([REDACTED])")
    }
}

impl ProvisioningGatewayServer {
    pub fn new(
        client: WhatsAppProvisioningClient,
        gateway_token: SecretString,
        route: GatewayRouteMetadata,
    ) -> Result<Self, ProvisioningFailure> {
        if gateway_token.as_str().len() < 16 {
            return Err(ProvisioningFailure::InvalidRequest);
        }
        Ok(Self {
            client: Arc::new(client),
            gateway_token,
            route,
            sessions: Arc::new(Mutex::new(HashMap::new())),
            history: None,
            outbound_store: None,
            outbound_sender: None,
            group_manager: None,
        })
    }

    /// Add the authenticated Matrix history adapter to the same private
    /// listener used by the provider-linking routes.
    pub fn with_history(mut self, history: HistoryGatewayServer) -> Self {
        self.outbound_store = Some(history.store_handle());
        self.history = Some(Arc::new(history));
        self
    }

    /// Attach the one restored, encrypted Matrix sender. The sender is kept
    /// behind the route's private process boundary and cannot choose another
    /// account or room.
    pub fn with_outbound_sender(mut self, sender: Arc<dyn OutboundTextSender>) -> Self {
        self.outbound_sender = Some(sender);
        self
    }

    /// Attach the Matrix room event boundary used by the pinned bridge for
    /// rename and membership operations. Group management never calls an
    /// invented provider HTTP endpoint.
    pub fn with_group_manager(mut self, manager: Arc<dyn MatrixGroupManager>) -> Self {
        self.group_manager = Some(manager);
        self
    }

    /// Serve the private gateway on a caller-supplied listener.  The caller
    /// must bind this listener only to the private network; no public Caddy
    /// route is registered by this module.
    pub async fn serve(self, listener: TcpListener) -> Result<(), std::io::Error> {
        loop {
            let (stream, _) = listener.accept().await?;
            let server = self.clone();
            tokio::spawn(async move {
                let _ = server.handle_connection(stream).await;
            });
        }
    }

    pub async fn handle_connection(&self, mut stream: TcpStream) -> Result<(), std::io::Error> {
        let request = read_http_request(&mut stream).await?;
        let (status, body) = self.handle_request(request).await;
        write_http_response(&mut stream, status, &body).await
    }

    async fn handle_request(&self, request: HttpRequest) -> (u16, Vec<u8>) {
        if request.path.starts_with("/v1/history-imports/")
            || request.path == "/v1/attachments/read"
        {
            return match &self.history {
                Some(history) => history.handle_request(request).await,
                None => response(404, json!({ "error": "not_found" })),
            };
        }
        if request.authorization.as_deref() != Some(self.gateway_token.as_str()) {
            return response(401, json!({ "error": "unauthorized" }));
        }
        if !request
            .request_id
            .as_deref()
            .is_some_and(|value| !value.is_empty() && value.len() <= MAX_ID_BYTES)
            || !request
                .idempotency_key
                .as_deref()
                .is_some_and(|value| !value.is_empty() && value.len() <= MAX_ID_BYTES)
        {
            return response(400, json!({ "error": INVALID_REQUEST }));
        }
        if request.path == "/v1/outbound/text" {
            let idempotency_key = request.idempotency_key.as_deref().unwrap_or_default();
            let parsed = match serde_json::from_slice::<OutboundTextRequest>(&request.body) {
                Ok(parsed) => parsed,
                Err(_) => return response(400, json!({ "error": INVALID_REQUEST })),
            };
            if let Err(error) = parsed.validate(&self.route) {
                let status = if error == OUTBOUND_STALE_SESSION {
                    409
                } else {
                    400
                };
                return response(status, json!({ "error": error }));
            }
            return self.outbound_text(parsed, idempotency_key).await;
        }
        if request.path == "/v1/groups/create" {
            let parsed = match serde_json::from_slice::<GroupRequest>(&request.body) {
                Ok(parsed) => parsed,
                Err(_) => return response(400, json!({ "error": INVALID_REQUEST })),
            };
            if let Err(error) = parsed.validate(&self.route) {
                return response(400, json!({ "error": error }));
            }
            return self.group_create(parsed).await;
        }
        let management_source = if request.path == "/v1/groups/management/event" {
            Some("event")
        } else if request.path == "/v1/groups/management/refresh" {
            Some("refresh")
        } else if request.path == "/v1/groups/rename" {
            Some("provider")
        } else if request.path == "/v1/groups/participants/add" {
            Some("provider")
        } else if request.path == "/v1/groups/participants/remove" {
            Some("provider")
        } else {
            None
        };
        if let Some(source) = management_source {
            let parsed = match serde_json::from_slice::<GroupManagementRequest>(&request.body) {
                Ok(parsed) => parsed,
                Err(_) => return response(400, json!({ "error": INVALID_REQUEST })),
            };
            if let Err(error) =
                parsed.validate(&self.route, source == "event" || source == "refresh")
            {
                return response(400, json!({ "error": error }));
            }
            return self.group_manage(parsed, source).await;
        }
        if request.path == "/v1/contacts/search"
            || request.path.starts_with("/v1/contacts/resolve/")
            || request.path == "/v1/conversations/direct"
        {
            let parsed = match serde_json::from_slice::<ContactRequest>(&request.body) {
                Ok(parsed) => parsed,
                Err(_) => return response(400, json!({ "error": INVALID_REQUEST })),
            };
            if let Err(error) = parsed.validate(&self.route) {
                return response(400, json!({ "error": error }));
            }
            if request.path == "/v1/contacts/search" {
                return self.contact_search(parsed).await;
            }
            if request.path == "/v1/conversations/direct" {
                return self.contact_create(parsed).await;
            }
            let Some(identifier) = decode_path_suffix(&request.path, "/v1/contacts/resolve/")
            else {
                return response(400, json!({ "error": INVALID_REQUEST }));
            };
            return self.contact_resolve(parsed, &identifier).await;
        }
        let parsed = match serde_json::from_slice::<GatewayRequest>(&request.body) {
            Ok(parsed) => parsed,
            Err(_) => return response(400, json!({ "error": INVALID_REQUEST })),
        };
        if parsed.provider != "whatsapp" || parsed.session_id.is_empty() || parsed.generation == 0 {
            return response(400, json!({ "error": INVALID_REQUEST }));
        }
        let owner = GatewayOwner::from(&parsed);
        match request.path.as_str() {
            "/v1/link-sessions/start" => self.start(owner).await,
            "/v1/link-sessions/poll" => self.poll(parsed, owner).await,
            "/v1/link-sessions/cancel" => self.cancel(parsed, owner).await,
            _ => response(404, json!({ "error": "not_found" })),
        }
    }

    async fn contact_search(&self, request: ContactRequest) -> (u16, Vec<u8>) {
        let Some(query) = request.query.as_deref() else {
            return response(400, json!({ "error": INVALID_REQUEST }));
        };
        match self
            .client
            .search_users(&request.route.provider_login_id, query)
            .await
        {
            Ok(value) => match search_results_payload(value, &request.operation_id) {
                Ok(payload) => response(200, payload),
                Err(error) => contact_failure_response(error),
            },
            Err(error) => contact_failure_response(error),
        }
    }

    async fn group_create(&self, request: GroupRequest) -> (u16, Vec<u8>) {
        let Some(store_handle) = self.outbound_store.as_ref() else {
            return response(503, json!({ "error": GROUP_MISSING_STORE }));
        };
        let provider_value = match self
            .client
            .create_group(
                &request.route.provider_login_id,
                &request.name,
                &request.participants,
            )
            .await
        {
            Ok(value) => value,
            Err(error) => return group_failure_response(error),
        };
        let (provider_group_id, matrix_room_id) = match created_group_payload(provider_value) {
            Ok(value) => value,
            Err(error) => return group_failure_response(error),
        };
        let created_at = Utc
            .timestamp_millis_opt(Utc::now().timestamp_millis())
            .single()
            .unwrap_or_else(Utc::now);
        let binding_id = deterministic_binding_id(
            &request.tenant_id,
            &request.account_id,
            &request.conversation_id,
        );
        let binding = match crate::registry::NewRoomBinding::new_with_session_generation(
            binding_id,
            matrix_room_id.clone(),
            request.tenant_id.clone(),
            request.identity_id.clone(),
            request.connection_id.clone(),
            request.account_id.clone(),
            Provider::Whatsapp,
            self.route.gateway_route_id.clone(),
            request.conversation_id.clone(),
            self.route.matrix_user_id.clone(),
            request.session_generation.clone(),
            created_at,
        ) {
            Ok(binding) => binding,
            Err(_) => return response(502, json!({ "error": GROUP_UNCERTAIN })),
        };
        {
            let mut store = store_handle.lock().await;
            if store.append_room_binding(binding).is_err() {
                return response(502, json!({ "error": GROUP_SCOPE_MISMATCH }));
            }
        }
        response(
            200,
            group_response(&request, &provider_group_id, &matrix_room_id),
        )
    }

    async fn group_manage(&self, request: GroupManagementRequest, source: &str) -> (u16, Vec<u8>) {
        let Some(store_handle) = self.outbound_store.as_ref() else {
            return response(503, json!({ "error": GROUP_MISSING_STORE }));
        };
        let Some(group_manager) = self.group_manager.as_ref() else {
            return response(503, json!({ "error": GROUP_MANAGEMENT_UNCERTAIN }));
        };
        let existing_room = {
            let store = store_handle.lock().await;
            match store.active_room_binding_for_outbound(
                &request.tenant_id,
                &request.account_id,
                &request.connection_id,
                &request.identity_id,
                Provider::Whatsapp,
                &request.conversation_id,
            ) {
                Ok(binding) => binding.map(|binding| binding.matrix_room_id().to_owned()),
                Err(_) => {
                    return response(503, json!({ "error": GROUP_MANAGEMENT_SCOPE_MISMATCH }));
                }
            }
        };
        if existing_room.as_deref() != Some(request.matrix_room_id.as_str()) {
            return response(403, json!({ "error": GROUP_MANAGEMENT_SCOPE_MISMATCH }));
        }
        let observation = if source == "event" || source == "refresh" {
            match group_manager
                .observe_group(MatrixGroupObservationRequest {
                    room_id: request.matrix_room_id.clone(),
                    provider_group_id: request.provider_group_id.clone(),
                    operation_id: request.operation_id.clone(),
                    operation_started_at: request.operation_created_at.clone(),
                    action: match request.action.as_str() {
                        "rename" => MatrixGroupAction::Rename,
                        "add_participants" => MatrixGroupAction::AddParticipants,
                        "remove_participants" => MatrixGroupAction::RemoveParticipants,
                        _ => return response(400, json!({ "error": INVALID_REQUEST })),
                    },
                    name: request.name.clone(),
                    participant_provider_ids: request.participant_provider_ids.clone(),
                    source_event_ids: Vec::new(),
                })
                .await
            {
                Ok(Some(observation)) => observation,
                Ok(None) => return response(404, json!({ "error": "not_found" })),
                Err(error) => return matrix_group_failure_response(error),
            }
        } else {
            let action = match request.action.as_str() {
                "rename" => MatrixGroupAction::Rename,
                "add_participants" => MatrixGroupAction::AddParticipants,
                "remove_participants" => MatrixGroupAction::RemoveParticipants,
                _ => return response(400, json!({ "error": INVALID_REQUEST })),
            };
            match group_manager
                .apply_group_change(MatrixGroupChange {
                    room_id: request.matrix_room_id.clone(),
                    provider_group_id: request.provider_group_id.clone(),
                    operation_id: request.operation_id.clone(),
                    operation_started_at: request.operation_created_at.clone(),
                    action,
                    name: request.name.clone(),
                    participant_provider_ids: request.participant_provider_ids.clone(),
                })
                .await
            {
                Ok(observation) => observation,
                Err(error) => return matrix_group_failure_response(error),
            }
        };
        match managed_group_response(&request, observation, source) {
            Ok(value) => response(200, value),
            Err(error) => group_failure_response(error),
        }
    }

    async fn contact_resolve(&self, request: ContactRequest, identifier: &str) -> (u16, Vec<u8>) {
        match self
            .client
            .resolve_identifier(&request.route.provider_login_id, identifier)
            .await
        {
            Ok(Some(value)) => match resolved_contact_payload(value) {
                Ok(payload) => response(200, payload),
                Err(error) => contact_failure_response(error),
            },
            Ok(None) => response(404, json!({ "error": "unresolved" })),
            Err(error) => contact_failure_response(error),
        }
    }

    async fn contact_create(&self, request: ContactRequest) -> (u16, Vec<u8>) {
        let Some(provider_id) = request.provider_id.as_deref() else {
            return response(400, json!({ "error": INVALID_REQUEST }));
        };
        let Some(conversation_id) = request.conversation_id.as_deref() else {
            return response(400, json!({ "error": INVALID_REQUEST }));
        };
        let Some(store_handle) = self.outbound_store.as_ref() else {
            return response(503, json!({ "error": CONTACT_MISSING_STORE }));
        };

        let existing_room = {
            let store = store_handle.lock().await;
            match store.active_room_binding_for_outbound(
                &request.tenant_id,
                &request.account_id,
                &request.connection_id,
                &request.identity_id,
                Provider::Whatsapp,
                conversation_id,
            ) {
                Ok(binding) => binding.map(|binding| binding.matrix_room_id().to_owned()),
                Err(_) => return response(503, json!({ "error": CONTACT_SCOPE_MISMATCH })),
            }
        };
        if let Some(matrix_room_id) = existing_room {
            match self
                .client
                .resolve_identifier(&request.route.provider_login_id, provider_id)
                .await
            {
                Ok(Some(value)) => match provider_identifier(&value) {
                    Ok(resolved_id) if resolved_id == provider_id => {}
                    Ok(_) => {
                        return response(409, json!({ "error": CONTACT_SCOPE_MISMATCH }));
                    }
                    Err(error) => return contact_failure_response(error),
                },
                Ok(None) => return response(404, json!({ "error": "unresolved" })),
                Err(error) => return contact_failure_response(error),
            }
            return response(
                200,
                contact_chat_response(&request, matrix_room_id.as_str(), "already_exists"),
            );
        }

        let provider_value = match self
            .client
            .create_dm(&request.route.provider_login_id, provider_id)
            .await
        {
            Ok(value) => value,
            Err(error) => return contact_failure_response(error),
        };
        let resolved = match direct_chat_payload(provider_value) {
            Ok(value) => value,
            Err(error) => return contact_failure_response(error),
        };
        if resolved.provider_id != provider_id {
            return response(409, json!({ "error": CONTACT_SCOPE_MISMATCH }));
        }

        let created_at = Utc
            .timestamp_millis_opt(Utc::now().timestamp_millis())
            .single()
            .unwrap_or_else(Utc::now);
        let binding_id =
            deterministic_binding_id(&request.tenant_id, &request.account_id, conversation_id);
        let binding = match crate::registry::NewRoomBinding::new_with_session_generation(
            binding_id,
            resolved.matrix_room_id.clone(),
            request.tenant_id.clone(),
            request.identity_id.clone(),
            request.connection_id.clone(),
            request.account_id.clone(),
            Provider::Whatsapp,
            self.route.gateway_route_id.clone(),
            conversation_id.to_owned(),
            self.route.matrix_user_id.clone(),
            request.session_generation.clone(),
            created_at,
        ) {
            Ok(binding) => binding,
            Err(_) => return response(502, json!({ "error": CONTACT_UNCERTAIN })),
        };
        {
            let mut store = store_handle.lock().await;
            if store.append_room_binding(binding).is_err() {
                let existing = store
                    .active_room_binding_for_outbound(
                        &request.tenant_id,
                        &request.account_id,
                        &request.connection_id,
                        &request.identity_id,
                        Provider::Whatsapp,
                        conversation_id,
                    )
                    .ok()
                    .flatten();
                if let Some(existing) = existing {
                    return response(
                        200,
                        contact_chat_response(
                            &request,
                            existing.matrix_room_id(),
                            "already_exists",
                        ),
                    );
                }
                return response(502, json!({ "error": CONTACT_UNCERTAIN }));
            }
        }
        response(
            200,
            contact_chat_response(&request, &resolved.matrix_room_id, "created"),
        )
    }

    async fn start(&self, owner: GatewayOwner) -> (u16, Vec<u8>) {
        match self.client.start_qr().await {
            Ok(start) => {
                self.sessions.lock().await.insert(
                    start.gateway_ref.clone(),
                    GatewaySession {
                        owner,
                        gateway_ref: start.gateway_ref.clone(),
                    },
                );
                response(
                    200,
                    json!({
                        "gateway_ref": start.gateway_ref,
                        "action": "scan_qr",
                        "qr": start.qr,
                        "action_expires_at": null,
                    }),
                )
            }
            Err(error) => response(502, json!({ "error": error.code() })),
        }
    }

    async fn outbound_text(
        &self,
        request: OutboundTextRequest,
        idempotency_key: &str,
    ) -> (u16, Vec<u8>) {
        let Some(store_handle) = self.outbound_store.as_ref() else {
            return response(503, json!({ "error": OUTBOUND_MISSING_SENDER }));
        };
        let Some(sender) = self.outbound_sender.as_ref() else {
            return response(503, json!({ "error": OUTBOUND_MISSING_SENDER }));
        };

        let mut store = store_handle.lock().await;
        let binding = match store.active_room_binding_for_outbound(
            &request.tenant_id,
            &request.account_id,
            &request.connection_id,
            &request.identity_id,
            Provider::Whatsapp,
            &request.conversation_id,
        ) {
            Ok(Some(binding)) => binding,
            Ok(None) => return response(403, json!({ "error": OUTBOUND_SCOPE_MISMATCH })),
            Err(_) => return response(503, json!({ "error": OUTBOUND_SCOPE_MISMATCH })),
        };
        if binding.session_generation() != Some(request.session_generation.as_str()) {
            return response(409, json!({ "error": OUTBOUND_STALE_SESSION }));
        }
        if binding.gateway_route_id() != self.route.gateway_route_id
            || binding.owner_matrix_user_id() != self.route.matrix_user_id
        {
            return response(403, json!({ "error": OUTBOUND_SCOPE_MISMATCH }));
        }
        let matrix_room_id = binding.matrix_room_id().to_owned();
        let input = NewOutboundText {
            transaction_id: request.transaction_id.clone(),
            idempotency_key: idempotency_key.to_owned(),
            request_digest: request.request_digest.clone(),
            tenant_id: request.tenant_id.clone(),
            account_id: request.account_id.clone(),
            connection_id: request.connection_id.clone(),
            identity_id: request.identity_id.clone(),
            conversation_id: request.conversation_id.clone(),
            message_id: request.message_id.clone(),
            event_id: request.event_id.clone(),
            matrix_room_id: matrix_room_id.clone(),
            session_generation: request.session_generation.clone(),
            projection_generation: request.projection_generation,
            body: request.body.clone(),
            created_at: Utc::now(),
        };
        let preparation = match store.prepare_outbound_text(input) {
            Ok(preparation) => preparation,
            Err(error) if error.code() == crate::store::STORE_OUTBOUND_CONFLICT => {
                return response(409, json!({ "error": OUTBOUND_TRANSACTION_CONFLICT }));
            }
            Err(_) => return response(503, json!({ "error": OUTBOUND_SCOPE_MISMATCH })),
        };
        match preparation {
            OutboundTextPreparation::ExistingTerminal { response: body } => {
                drop(store);
                return (200, body);
            }
            OutboundTextPreparation::ExistingPending => {
                let observed_at = Utc::now().to_rfc3339();
                let body = outbound_result_json(
                    &request,
                    "uncertain",
                    &observed_at,
                    Some(OUTBOUND_UNCERTAIN),
                    Some(json!({
                        "source": "refresh",
                        "status": "uncertain",
                        "evidence_id": format!("uncertain_{}", request.transaction_id),
                        "observed_at": observed_at.clone(),
                        "reason": "transaction_pending_after_restart"
                    })),
                );
                let body_bytes = serde_json::to_vec(&body).unwrap_or_default();
                let _ = store.complete_outbound_text(
                    &request.tenant_id,
                    &request.transaction_id,
                    &request.request_digest,
                    OutboundTextCompletion {
                        state: "uncertain".to_owned(),
                        matrix_stage: "unknown".to_owned(),
                        bridge_stage: "unknown".to_owned(),
                        provider_stage: "unknown".to_owned(),
                        response: body_bytes.clone(),
                        matrix_evidence: None,
                        bridge_evidence: None,
                        provider_evidence: None,
                        updated_at: Utc::now(),
                    },
                );
                drop(store);
                return (200, body_bytes);
            }
            OutboundTextPreparation::Created => {}
        }
        drop(store);

        let send_result = sender
            .send_encrypted_text(&matrix_room_id, &request.transaction_id, &request.body)
            .await;
        let observed_at = Utc::now().to_rfc3339();
        let (outcome, state, matrix_stage, matrix_evidence, reason, status) = match send_result {
            Ok(result) => {
                let evidence = json!({
                    "source": "matrix",
                    "status": "confirmed",
                    "evidence_id": result.event_id.as_str(),
                    "observed_at": observed_at.clone(),
                });
                (
                    "accepted",
                    "accepted",
                    "confirmed",
                    Some(evidence),
                    None,
                    200,
                )
            }
            Err(crate::outbound::OutboundSendFailure::RoomNotFound)
            | Err(crate::outbound::OutboundSendFailure::RoomNotEncrypted) => (
                "rejected",
                "rejected",
                "unknown",
                None,
                Some("matrix_room_not_sendable"),
                200,
            ),
            Err(crate::outbound::OutboundSendFailure::MatrixSessionExpired) => (
                "session_expired",
                "session_expired",
                "unknown",
                None,
                Some("matrix_session_expired"),
                200,
            ),
            Err(crate::outbound::OutboundSendFailure::MatrixRateLimited) => (
                "rate_limited",
                "rate_limited",
                "unknown",
                None,
                Some("matrix_rate_limited"),
                200,
            ),
            Err(crate::outbound::OutboundSendFailure::MatrixRejected) => (
                "rejected",
                "rejected",
                "unknown",
                None,
                Some("matrix_request_rejected"),
                200,
            ),
            Err(crate::outbound::OutboundSendFailure::MatrixRequest) => (
                "uncertain",
                "uncertain",
                "unknown",
                Some(json!({
                    "source": "refresh",
                    "status": "uncertain",
                    "evidence_id": format!("uncertain_{}", request.transaction_id),
                    "observed_at": observed_at,
                    "reason": "matrix_request_failed_after_authorization"
                })),
                Some(OUTBOUND_UNCERTAIN),
                200,
            ),
        };
        let body = outbound_result_json(
            &request,
            outcome,
            &observed_at,
            reason,
            matrix_evidence.clone(),
        );
        let body_bytes = serde_json::to_vec(&body).unwrap_or_default();
        let matrix_evidence_bytes = matrix_evidence
            .as_ref()
            .and_then(|evidence| serde_json::to_vec(evidence).ok());
        let mut store = store_handle.lock().await;
        if store
            .complete_outbound_text(
                &request.tenant_id,
                &request.transaction_id,
                &request.request_digest,
                OutboundTextCompletion {
                    state: state.to_owned(),
                    matrix_stage: matrix_stage.to_owned(),
                    bridge_stage: "unknown".to_owned(),
                    provider_stage: "unknown".to_owned(),
                    response: body_bytes.clone(),
                    matrix_evidence: matrix_evidence_bytes,
                    bridge_evidence: None,
                    provider_evidence: None,
                    updated_at: Utc::now(),
                },
            )
            .is_err()
        {
            return response(503, json!({ "error": OUTBOUND_UNCERTAIN }));
        }
        (status, body_bytes)
    }

    async fn poll(&self, request: GatewayRequest, owner: GatewayOwner) -> (u16, Vec<u8>) {
        let Some(gateway_ref) = request.gateway_ref.as_deref() else {
            return response(400, json!({ "error": INVALID_REQUEST }));
        };
        let session = self.sessions.lock().await.get(gateway_ref).cloned();
        let Some(session) = session else {
            return response(409, json!({ "error": "stale_session" }));
        };
        if session.owner != owner || session.gateway_ref != gateway_ref {
            return response(409, json!({ "error": "stale_session" }));
        }
        match self.client.poll(gateway_ref).await {
            Ok(ProvisioningPoll::Qr { qr }) => response(
                200,
                json!({ "status": "awaiting_user", "action": if qr.is_some() { "scan_qr" } else { "wait" }, "qr": qr, "action_expires_at": null }),
            ),
            Ok(ProvisioningPoll::Connected { user_login_id }) => {
                self.sessions.lock().await.remove(gateway_ref);
                response(
                    200,
                    json!({
                        "status": "connected",
                        "provider_identity": {
                            "user_login_id": user_login_id,
                            "display_label": "WhatsApp",
                            "route": {
                                "gateway_route_id": self.route.gateway_route_id,
                                "bridge_instance_id": self.route.bridge_instance_id,
                                "matrix_user_id": self.route.matrix_user_id,
                                "matrix_room_namespace": self.route.matrix_room_namespace,
                            }
                        }
                    }),
                )
            }
            Ok(ProvisioningPoll::Expired) => {
                self.sessions.lock().await.remove(gateway_ref);
                response(200, json!({ "status": "expired", "error_code": "expired" }))
            }
            Ok(ProvisioningPoll::Failed(error)) => response(
                200,
                json!({ "status": "failed", "error_code": error.code() }),
            ),
            Err(error) => response(502, json!({ "error": error.code() })),
        }
    }

    async fn cancel(&self, request: GatewayRequest, owner: GatewayOwner) -> (u16, Vec<u8>) {
        let Some(gateway_ref) = request.gateway_ref.as_deref() else {
            return response(400, json!({ "error": INVALID_REQUEST }));
        };
        let session = self.sessions.lock().await.get(gateway_ref).cloned();
        let Some(session) = session else {
            return response(200, json!({}));
        };
        if session.owner != owner {
            return response(409, json!({ "error": "stale_session" }));
        }
        match self.client.cancel(gateway_ref).await {
            Ok(()) => {
                self.sessions.lock().await.remove(gateway_ref);
                response(200, json!({}))
            }
            Err(error) => response(502, json!({ "error": error.code() })),
        }
    }
}

#[derive(Debug)]
pub(crate) struct HttpRequest {
    pub(crate) path: String,
    pub(crate) authorization: Option<String>,
    pub(crate) request_id: Option<String>,
    pub(crate) idempotency_key: Option<String>,
    pub(crate) body: Vec<u8>,
}

pub(crate) async fn read_http_request(
    stream: &mut TcpStream,
) -> Result<HttpRequest, std::io::Error> {
    let mut buffer = Vec::with_capacity(4096);
    let header_end = loop {
        let mut chunk = [0_u8; 2048];
        let count = stream.read(&mut chunk).await?;
        if count == 0 {
            return Err(std::io::Error::new(
                std::io::ErrorKind::UnexpectedEof,
                "request closed",
            ));
        }
        buffer.extend_from_slice(&chunk[..count]);
        if buffer.len() > MAX_HTTP_BODY_BYTES {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "request too large",
            ));
        }
        if let Some(index) = buffer.windows(4).position(|window| window == b"\r\n\r\n") {
            break index + 4;
        }
    };
    let headers = std::str::from_utf8(&buffer[..header_end])
        .map_err(|_| std::io::Error::new(std::io::ErrorKind::InvalidData, "invalid headers"))?;
    let mut lines = headers.split("\r\n");
    let request_line = lines
        .next()
        .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::InvalidData, "missing request"))?;
    let mut request_parts = request_line.split_whitespace();
    let method = request_parts.next().unwrap_or_default();
    if method != "POST" {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "method not allowed",
        ));
    }
    let path = request_parts.next().unwrap_or_default().to_owned();
    let mut content_length = 0_usize;
    let mut authorization = None;
    let mut request_id = None;
    let mut idempotency_key = None;
    for line in lines {
        if let Some((name, value)) = line.split_once(':') {
            if name.eq_ignore_ascii_case("content-length") {
                content_length = value.trim().parse().unwrap_or(MAX_HTTP_BODY_BYTES + 1);
            } else if name.eq_ignore_ascii_case("authorization") {
                let value = value.trim();
                authorization = value.strip_prefix("Bearer ").map(str::to_owned);
            } else if name.eq_ignore_ascii_case("x-request-id") {
                request_id = Some(value.trim().to_owned());
            } else if name.eq_ignore_ascii_case("idempotency-key") {
                idempotency_key = Some(value.trim().to_owned());
            }
        }
    }
    if content_length > MAX_HTTP_BODY_BYTES {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "body too large",
        ));
    }
    while buffer.len() < header_end + content_length {
        let mut chunk = [0_u8; 2048];
        let count = stream.read(&mut chunk).await?;
        if count == 0 {
            return Err(std::io::Error::new(
                std::io::ErrorKind::UnexpectedEof,
                "body closed",
            ));
        }
        buffer.extend_from_slice(&chunk[..count]);
    }
    Ok(HttpRequest {
        path,
        authorization,
        request_id,
        idempotency_key,
        body: buffer[header_end..header_end + content_length].to_vec(),
    })
}

pub(crate) fn response(status: u16, body: Value) -> (u16, Vec<u8>) {
    (
        status,
        serde_json::to_vec(&body).unwrap_or_else(|_| b"{\"error\":\"provider_error\"}".to_vec()),
    )
}

fn outbound_result_json(
    request: &OutboundTextRequest,
    outcome: &str,
    observed_at: &str,
    reason: Option<&str>,
    evidence: Option<Value>,
) -> Value {
    let mut body = json!({
        "outcome": outcome,
        "transaction_id": request.transaction_id,
        "request_digest": request.request_digest,
        "account_id": request.account_id,
        "connection_id": request.connection_id,
        "session_generation": request.session_generation,
        "observed_at": observed_at,
    });
    if let Some(reason) = reason {
        body["reason"] = Value::String(reason.to_owned());
    }
    if let Some(evidence) = evidence {
        body["evidence"] = Value::Array(vec![evidence]);
    }
    body
}

pub(crate) async fn write_http_response(
    stream: &mut TcpStream,
    status: u16,
    body: &[u8],
) -> Result<(), std::io::Error> {
    let reason = match status {
        200 => "OK",
        400 => "Bad Request",
        401 => "Unauthorized",
        404 => "Not Found",
        409 => "Conflict",
        502 => "Bad Gateway",
        _ => "Error",
    };
    let head = format!(
        "HTTP/1.1 {status} {reason}\r\nContent-Type: application/json\r\nCache-Control: no-store\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    );
    stream.write_all(head.as_bytes()).await?;
    stream.write_all(body).await
}

/// Run the private server on a configured address.
pub async fn serve_private_gateway(
    server: ProvisioningGatewayServer,
    listen_addr: SocketAddr,
) -> Result<(), std::io::Error> {
    server.serve(TcpListener::bind(listen_addr).await?).await
}

#[cfg(test)]
mod tests {
    use std::{
        fs,
        os::unix::fs::PermissionsExt,
        sync::{
            Arc, Mutex as StdMutex,
            atomic::{AtomicUsize, Ordering},
        },
    };

    use super::*;
    use async_trait::async_trait;
    use base64::Engine as _;
    use chrono::{TimeZone, Utc};
    use serde_json::json;
    use tempfile::tempdir;
    use tokio::{io::AsyncWriteExt, sync::Notify};
    use wiremock::{Mock, MockServer, ResponseTemplate, matchers};

    use crate::{
        attachments::AttachmentDescriptor,
        batch::RoutedEvent,
        crypto::Keyring,
        crypto_outbox::{PendingMatrixRequest, RawMatrixResponse},
        history::HistoryGatewayServer,
        matrix::{
            FetchedMatrixMedia, FetchedMatrixSync, MatrixMediaDescriptor, MatrixTransport,
            RawBackfillPage,
        },
        model::{
            AttachmentObservedPayload, CanonicalEvent, CanonicalEventSource, CanonicalPayload,
        },
        normalize::{MatrixAttachment, MatrixMessage, MatrixMessageKind},
        outbound::{
            MatrixGroupAction, MatrixGroupChange, MatrixGroupFailure, MatrixGroupManager,
            MatrixGroupObservation, MatrixGroupObservationRequest, MatrixSendResult,
            OutboundTextSender,
        },
        registry::NewRoomBinding,
        secret::{SafeError, SecretBytes},
        store::Store,
    };
    use ruma::{events::AnyTimelineEvent, serde::Raw};

    const BRIDGE_SECRET: &str = "bridge-secret-for-test";
    const GATEWAY_SECRET: &str = "gateway-secret-for-test";
    const MATRIX_USER: &str = "@communicator:communicator.0000.gold";

    fn client_url(server: &MockServer) -> String {
        format!("{}/", server.uri())
    }

    fn route() -> GatewayRouteMetadata {
        GatewayRouteMetadata {
            gateway_route_id: "gateway_route_whatsapp".to_owned(),
            bridge_instance_id: "whatsapp-primary".to_owned(),
            matrix_user_id: MATRIX_USER.to_owned(),
            matrix_room_namespace: "communicator.0000.gold".to_owned(),
        }
    }

    async fn mount_start_fixtures(server: &MockServer) {
        Mock::given(matchers::method("GET"))
            .and(matchers::path(format!("{PROVISIONING_ROOT}/login/flows")))
            .and(matchers::query_param("user_id", MATRIX_USER))
            .and(matchers::header(
                "authorization",
                format!("Bearer {BRIDGE_SECRET}"),
            ))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "flows": [{"id": "qr"}]
            })))
            .mount(server)
            .await;
        Mock::given(matchers::method("POST"))
            .and(matchers::path(format!(
                "{PROVISIONING_ROOT}/login/start/qr"
            )))
            .and(matchers::query_param("user_id", MATRIX_USER))
            .and(matchers::header(
                "authorization",
                format!("Bearer {BRIDGE_SECRET}"),
            ))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "login_id": "process-1",
                "step_id": "fi.mau.whatsapp.login.qr",
                "txn_id": "txn-1",
                "display_and_wait": {"data": "qr-fixture"}
            })))
            .mount(server)
            .await;
    }

    #[tokio::test]
    async fn adapter_uses_exact_pinned_routes_and_keeps_bridge_handles_private() {
        let bridge = MockServer::start().await;
        mount_start_fixtures(&bridge).await;
        Mock::given(matchers::method("POST"))
            .and(matchers::path(format!(
                "{PROVISIONING_ROOT}/login/step/process-1/fi.mau.whatsapp.login.qr/display_and_wait"
            )))
            .and(matchers::query_param("txn_id", "txn-1"))
            .and(matchers::query_param("user_id", MATRIX_USER))
            .and(matchers::header(
                "authorization",
                format!("Bearer {BRIDGE_SECRET}"),
            ))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "complete": {"user_login_id": "15551234567"}
            })))
            .mount(&bridge)
            .await;
        Mock::given(matchers::method("POST"))
            .and(matchers::path(format!(
                "{PROVISIONING_ROOT}/login/cancel/process-1"
            )))
            .and(matchers::query_param("user_id", MATRIX_USER))
            .and(matchers::header(
                "authorization",
                format!("Bearer {BRIDGE_SECRET}"),
            ))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({})))
            .mount(&bridge)
            .await;

        let client = WhatsAppProvisioningClient::new_for_test(
            client_url(&bridge),
            SecretString::new(BRIDGE_SECRET),
            MATRIX_USER,
            Duration::from_secs(2),
        )
        .expect("test bridge URL is valid");
        let started = client.start_qr().await.expect("QR start succeeds");
        assert_eq!(started.qr, "qr-fixture");
        assert!(!started.gateway_ref.contains("process-1"));
        let connected = client
            .poll(&started.gateway_ref)
            .await
            .expect("poll succeeds");
        assert_eq!(
            connected,
            ProvisioningPoll::Connected {
                user_login_id: "15551234567".to_owned()
            }
        );

        // A fresh start is used for the cancellation route after the first
        // connected result has removed its private handle.
        let second = client.start_qr().await.expect("second QR start succeeds");
        client
            .cancel(&second.gateway_ref)
            .await
            .expect("cancel succeeds");
    }

    #[tokio::test]
    async fn adapter_classifies_bridge_auth_failures_without_returning_secret_data() {
        let bridge = MockServer::start().await;
        Mock::given(matchers::method("GET"))
            .and(matchers::path(format!("{PROVISIONING_ROOT}/login/flows")))
            .respond_with(ResponseTemplate::new(403).set_body_string(BRIDGE_SECRET))
            .mount(&bridge)
            .await;
        let client = WhatsAppProvisioningClient::new_for_test(
            client_url(&bridge),
            SecretString::new(BRIDGE_SECRET),
            MATRIX_USER,
            Duration::from_secs(2),
        )
        .expect("test bridge URL is valid");
        let error = client
            .start_qr()
            .await
            .expect_err("auth failure is rejected");
        assert_eq!(error, ProvisioningFailure::ProvisioningDisabled);
        assert_eq!(error.to_string(), PROVISIONING_DISABLED);
        assert!(!format!("{error:?}").contains(BRIDGE_SECRET));
    }

    #[tokio::test]
    async fn private_gateway_requires_worker_auth_and_returns_only_opaque_refs() {
        let bridge = MockServer::start().await;
        mount_start_fixtures(&bridge).await;
        let client = WhatsAppProvisioningClient::new_for_test(
            client_url(&bridge),
            SecretString::new(BRIDGE_SECRET),
            MATRIX_USER,
            Duration::from_secs(2),
        )
        .expect("test bridge URL is valid");
        let server =
            ProvisioningGatewayServer::new(client, SecretString::new(GATEWAY_SECRET), route())
                .expect("gateway secret is valid");
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind listener");
        let address = listener.local_addr().expect("listener address");
        let task = tokio::spawn(server.serve(listener));
        let http = Client::builder().no_proxy().build().expect("HTTP client");
        let body = serde_json::to_vec(&json!({
            "session_id": "link_session_1",
            "tenant_id": "tenant_pilot",
            "actor_principal_id": "principal_human",
            "membership_id": "membership_human",
            "target_identity_id": "identity_human",
            "provider": "whatsapp",
            "generation": 1
        }))
        .expect("request body");
        let unauthorized = http
            .post(format!("http://{address}/v1/link-sessions/start"))
            .bearer_auth("wrong-secret")
            .header("content-type", "application/json")
            .header("x-request-id", "request-unauthorized")
            .header("idempotency-key", "idempotency-unauthorized")
            .body(body.clone())
            .send()
            .await
            .expect("unauthorized response");
        assert_eq!(unauthorized.status(), StatusCode::UNAUTHORIZED);

        let response = http
            .post(format!("http://{address}/v1/link-sessions/start"))
            .bearer_auth(GATEWAY_SECRET)
            .header("content-type", "application/json")
            .header("x-request-id", "request-start")
            .header("idempotency-key", "idempotency-start")
            .body(body)
            .send()
            .await
            .expect("gateway response");
        assert_eq!(response.status(), StatusCode::OK);
        let response_body: Value =
            serde_json::from_slice(&response.bytes().await.expect("gateway body"))
                .expect("gateway JSON");
        assert!(response_body.get("gateway_ref").is_some());
        assert_eq!(
            response_body.get("qr").and_then(Value::as_str),
            Some("qr-fixture")
        );
        let serialized = response_body.to_string();
        assert!(!serialized.contains("process-1"));
        assert!(!serialized.contains("txn-1"));
        assert!(!serialized.contains(BRIDGE_SECRET));
        task.abort();
    }

    #[tokio::test]
    async fn contact_routes_use_selected_login_and_replay_exact_bound_account() {
        let bridge = MockServer::start().await;
        Mock::given(matchers::method("POST"))
            .and(matchers::path(format!("{PROVISIONING_ROOT}/search_users")))
            .and(matchers::query_param("login_id", "login-two"))
            .and(matchers::header(
                "authorization",
                format!("Bearer {BRIDGE_SECRET}"),
            ))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "results": [{
                    "id": "contact-two",
                    "name": "Two",
                    "identifiers": ["+15550000002", "contact-two@lid"]
                }]
            })))
            .mount(&bridge)
            .await;
        Mock::given(matchers::method("POST"))
            .and(matchers::path(format!(
                "{PROVISIONING_ROOT}/create_dm/contact-two"
            )))
            .and(matchers::query_param("login_id", "login-two"))
            .and(matchers::header(
                "authorization",
                format!("Bearer {BRIDGE_SECRET}"),
            ))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "id": "contact-two",
                "mxid": "@contact-two:example.test",
                "dm_room_mxid": "!contact-two:example.test"
            })))
            .mount(&bridge)
            .await;
        Mock::given(matchers::method("GET"))
            .and(matchers::path(format!(
                "{PROVISIONING_ROOT}/resolve_identifier/contact-two"
            )))
            .and(matchers::query_param("login_id", "login-two"))
            .and(matchers::header(
                "authorization",
                format!("Bearer {BRIDGE_SECRET}"),
            ))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "id": "contact-two",
                "name": "Two",
                "identifiers": ["+15550000002", "contact-two@lid"]
            })))
            .mount(&bridge)
            .await;

        let client = WhatsAppProvisioningClient::new_for_test(
            client_url(&bridge),
            SecretString::new(BRIDGE_SECRET),
            MATRIX_USER,
            Duration::from_secs(2),
        )
        .expect("test bridge URL is valid");
        let directory = tempdir().expect("state directory");
        fs::set_permissions(directory.path(), fs::Permissions::from_mode(0o700))
            .expect("restrict state parent");
        let database = directory.path().join("gateway.sqlite3");
        let store = Store::open(
            &database,
            Keyring::new([0x66; 32], 1).expect("test keyring"),
        )
        .expect("open state store");
        let history = HistoryGatewayServer::new(
            store,
            Arc::new(SharedHistoryTransport {
                calls: AtomicUsize::new(0),
                event_count: 0,
            }),
            GATEWAY_SECRET,
        )
        .expect("history gateway");
        let server =
            ProvisioningGatewayServer::new(client, SecretString::new(GATEWAY_SECRET), route())
                .expect("provisioning gateway")
                .with_history(history);
        let session_generation = "2026-09-14T00:00:00.000Z";
        let request = |path: &str, idempotency_key: &str, body: Value| HttpRequest {
            path: path.to_owned(),
            authorization: Some(GATEWAY_SECRET.to_owned()),
            request_id: Some(format!("request-{idempotency_key}")),
            idempotency_key: Some(idempotency_key.to_owned()),
            body: serde_json::to_vec(&body).expect("request JSON"),
        };
        let route_body = json!({
            "gateway_route_id": "gateway_route_whatsapp",
            "bridge_instance_id": "whatsapp-primary",
            "matrix_user_id": MATRIX_USER,
            "matrix_room_namespace": "communicator.0000.gold",
            "provider_login_id": "login-two"
        });
        let search_body = json!({
            "schema_version": 1,
            "tenant_id": "tenant_contact",
            "account_id": "account_two",
            "connection_id": "connection_two",
            "identity_id": "identity_contact",
            "provider": "whatsapp",
            "session_generation": session_generation,
            "route": route_body,
            "operation_id": "contact_search_two",
            "query": "Two"
        });
        let (search_status, search_bytes) = server
            .handle_request(request(
                "/v1/contacts/search",
                "contact-search-idempotency",
                search_body,
            ))
            .await;
        assert_eq!(search_status, 200);
        let search_response: Value =
            serde_json::from_slice(&search_bytes).expect("search response JSON");
        assert_eq!(search_response["results"][0]["id"], "contact-two");

        let create_body = json!({
            "schema_version": 1,
            "tenant_id": "tenant_contact",
            "account_id": "account_two",
            "connection_id": "connection_two",
            "identity_id": "identity_contact",
            "provider": "whatsapp",
            "session_generation": session_generation,
            "route": route_body,
            "operation_id": "contact_create_two",
            "provider_id": "contact-two",
            "conversation_id": "conversation_contact_two"
        });
        let (created_status, created_bytes) = server
            .handle_request(request(
                "/v1/conversations/direct",
                "contact-create-idempotency",
                create_body.clone(),
            ))
            .await;
        assert_eq!(created_status, 200);
        let created: Value = serde_json::from_slice(&created_bytes).expect("created response JSON");
        assert_eq!(created["status"], "created");
        assert_eq!(created["account_id"], "account_two");
        assert_eq!(created["connection_id"], "connection_two");
        assert_eq!(created["identity_id"], "identity_contact");
        assert_eq!(created["conversation_id"], "conversation_contact_two");
        assert_eq!(created["id"], "contact-two");

        let binding = {
            let store = server
                .outbound_store
                .as_ref()
                .expect("outbound store")
                .lock()
                .await;
            store
                .active_room_binding_for_outbound(
                    "tenant_contact",
                    "account_two",
                    "connection_two",
                    "identity_contact",
                    Provider::Whatsapp,
                    "conversation_contact_two",
                )
                .expect("binding lookup")
                .expect("persisted binding")
        };
        assert_eq!(binding.matrix_room_id(), "!contact-two:example.test");
        assert_eq!(binding.session_generation(), Some(session_generation));

        let (duplicate_status, duplicate_bytes) = server
            .handle_request(request(
                "/v1/conversations/direct",
                "contact-create-replay",
                create_body,
            ))
            .await;
        assert_eq!(duplicate_status, 200);
        let duplicate: Value =
            serde_json::from_slice(&duplicate_bytes).expect("duplicate response JSON");
        assert_eq!(duplicate["status"], "already_exists");
        assert_eq!(duplicate["account_id"], "account_two");
        assert_eq!(duplicate["conversation_id"], "conversation_contact_two");
        assert_eq!(duplicate["id"], "contact-two");

        let requests = bridge.received_requests().await.expect("bridge requests");
        assert!(!requests.is_empty());
        assert!(requests.iter().all(|request| {
            request
                .url
                .query_pairs()
                .any(|(name, value)| name == "login_id" && value == "login-two")
        }));
        assert!(
            requests
                .iter()
                .all(|request| !request.url.query_pairs().any(|(name, _)| name == "user_id"))
        );
    }

    #[tokio::test]
    async fn group_route_uses_pinned_create_group_schema_and_persists_bound_room() {
        let bridge = MockServer::start().await;
        Mock::given(matchers::method("POST"))
            .and(matchers::path(format!(
                "{PROVISIONING_ROOT}/create_group/group"
            )))
            .and(matchers::query_param("login_id", "login-group"))
            .and(matchers::header(
                "authorization",
                format!("Bearer {BRIDGE_SECRET}"),
            ))
            .and(matchers::body_json(json!({
                "participants": ["contact-one", "contact-two"],
                "name": { "name": "Operations" }
            })))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "id": "group-provider-1",
                "mxid": "!group-1:example.test"
            })))
            .mount(&bridge)
            .await;

        let client = WhatsAppProvisioningClient::new_for_test(
            client_url(&bridge),
            SecretString::new(BRIDGE_SECRET),
            MATRIX_USER,
            Duration::from_secs(2),
        )
        .expect("test bridge URL is valid");
        let directory = tempdir().expect("state directory");
        fs::set_permissions(directory.path(), fs::Permissions::from_mode(0o700))
            .expect("restrict state parent");
        let database = directory.path().join("gateway.sqlite3");
        let store = Store::open(
            &database,
            Keyring::new([0x67; 32], 1).expect("test keyring"),
        )
        .expect("open state store");
        let history = HistoryGatewayServer::new(
            store,
            Arc::new(SharedHistoryTransport {
                calls: AtomicUsize::new(0),
                event_count: 0,
            }),
            GATEWAY_SECRET,
        )
        .expect("history gateway");
        let server =
            ProvisioningGatewayServer::new(client, SecretString::new(GATEWAY_SECRET), route())
                .expect("provisioning gateway")
                .with_history(history);
        let request = HttpRequest {
            path: "/v1/groups/create".to_owned(),
            authorization: Some(GATEWAY_SECRET.to_owned()),
            request_id: Some("request-group-create".to_owned()),
            idempotency_key: Some("group-create-idempotency".to_owned()),
            body: serde_json::to_vec(&json!({
                "schema_version": 1,
                "tenant_id": "tenant_group",
                "account_id": "account_group",
                "connection_id": "connection_group",
                "identity_id": "identity_group",
                "provider": "whatsapp",
                "session_generation": "2026-09-14T00:00:00.000Z",
                "route": {
                    "gateway_route_id": "gateway_route_whatsapp",
                    "bridge_instance_id": "whatsapp-primary",
                    "matrix_user_id": MATRIX_USER,
                    "matrix_room_namespace": "communicator.0000.gold",
                    "provider_login_id": "login-group"
                },
                "operation_id": "group_create_one",
                "conversation_id": "conversation_group_one",
                "name": "Operations",
                "participants": ["contact-one", "contact-two"]
            }))
            .expect("request JSON"),
        };
        let (status, bytes) = server.handle_request(request).await;
        assert_eq!(status, 200, "{}", String::from_utf8_lossy(&bytes));
        let body: Value = serde_json::from_slice(&bytes).expect("group response JSON");
        assert_eq!(body["provider_group_id"], "group-provider-1");
        assert_eq!(body["matrix_room_id"], "!group-1:example.test");
        assert_eq!(body["conversation_id"], "conversation_group_one");
        assert_eq!(body["account_id"], "account_group");
        assert_eq!(body["evidence"]["source"], "provider");
        assert_eq!(body["evidence"]["operation_id"], "group_create_one");
        assert_eq!(
            body["evidence"]["participant_provider_ids"],
            json!(["contact-one", "contact-two"])
        );
        let binding = {
            let store = server
                .outbound_store
                .as_ref()
                .expect("outbound store")
                .lock()
                .await;
            store
                .active_room_binding_for_outbound(
                    "tenant_group",
                    "account_group",
                    "connection_group",
                    "identity_group",
                    Provider::Whatsapp,
                    "conversation_group_one",
                )
                .expect("binding lookup")
                .expect("persisted group binding")
        };
        assert_eq!(binding.matrix_room_id(), "!group-1:example.test");
        assert_eq!(
            binding.session_generation(),
            Some("2026-09-14T00:00:00.000Z")
        );
        let requests = bridge.received_requests().await.expect("bridge requests");
        assert_eq!(requests.len(), 1, "provider request count: {requests:?}");
        assert_eq!(
            requests[0]
                .url
                .query_pairs()
                .find(|(name, _)| name == "login_id"),
            Some(("login_id".into(), "login-group".into()))
        );
    }

    struct BlockingOutboundSender {
        calls: Arc<AtomicUsize>,
        entered: Arc<Notify>,
        release: Arc<Notify>,
    }

    #[async_trait]
    impl OutboundTextSender for BlockingOutboundSender {
        async fn send_encrypted_text(
            &self,
            _room_id: &str,
            _transaction_id: &str,
            _body: &str,
        ) -> Result<MatrixSendResult, crate::outbound::OutboundSendFailure> {
            let call = self.calls.fetch_add(1, Ordering::SeqCst);
            if call == 0 {
                self.entered.notify_one();
                self.release.notified().await;
            }
            Ok(MatrixSendResult {
                event_id: ruma::EventId::parse("$outbound-race:example.test")
                    .expect("valid outbound event ID"),
            })
        }
    }

    struct RecordingOutboundSender {
        rooms: Arc<StdMutex<Vec<String>>>,
    }

    struct RecordingGroupManager {
        changes: Arc<StdMutex<Vec<MatrixGroupChange>>>,
        observation: MatrixGroupObservation,
    }

    #[async_trait]
    impl MatrixGroupManager for RecordingGroupManager {
        async fn apply_group_change(
            &self,
            change: MatrixGroupChange,
        ) -> Result<MatrixGroupObservation, MatrixGroupFailure> {
            self.changes.lock().expect("group change lock").push(change);
            Ok(self.observation.clone())
        }

        async fn observe_group(
            &self,
            _request: MatrixGroupObservationRequest,
        ) -> Result<Option<MatrixGroupObservation>, MatrixGroupFailure> {
            Ok(Some(self.observation.clone()))
        }
    }

    #[tokio::test]
    async fn group_management_uses_matrix_events_and_requires_authoritative_snapshot() {
        let bridge = MockServer::start().await;
        let client = WhatsAppProvisioningClient::new_for_test(
            client_url(&bridge),
            SecretString::new(BRIDGE_SECRET),
            MATRIX_USER,
            Duration::from_secs(2),
        )
        .expect("test bridge URL is valid");
        let directory = tempdir().expect("state directory");
        fs::set_permissions(directory.path(), fs::Permissions::from_mode(0o700))
            .expect("restrict state parent");
        let database = directory.path().join("gateway.sqlite3");
        let created_at = Utc
            .timestamp_millis_opt(1_700_000_000_000)
            .single()
            .expect("valid binding timestamp");
        let mut store = Store::open(
            &database,
            Keyring::new([0x68; 32], 1).expect("test keyring"),
        )
        .expect("open state store");
        store
            .append_room_binding(
                NewRoomBinding::new_with_session_generation(
                    "binding_68686868686868686868686868686868",
                    "!group-management:example.test",
                    "tenant_group_management",
                    "identity_group_management",
                    "connection_group_management",
                    "account_group_management",
                    Provider::Whatsapp,
                    "gateway_route_whatsapp",
                    "conversation_group_management",
                    MATRIX_USER,
                    "2026-09-14T00:00:00.000Z",
                    created_at,
                )
                .expect("room binding"),
            )
            .expect("append room binding");
        let history = HistoryGatewayServer::new(
            store,
            Arc::new(SharedHistoryTransport {
                calls: AtomicUsize::new(0),
                event_count: 0,
            }),
            GATEWAY_SECRET,
        )
        .expect("history gateway");
        let changes = Arc::new(StdMutex::new(Vec::new()));
        let manager = Arc::new(RecordingGroupManager {
            changes: Arc::clone(&changes),
            observation: MatrixGroupObservation {
                provider_group_id: "120363000000000000@g.us".to_owned(),
                matrix_room_id: "!group-management:example.test".to_owned(),
                name: "Renamed operations".to_owned(),
                revision: "1700000001000".to_owned(),
                member_provider_ids: vec!["15551234567".to_owned(), "lid-42".to_owned()],
                evidence_id: "$bridge-group-name:example.test".to_owned(),
                observed_at: "2026-09-14T00:00:01Z".to_owned(),
            },
        });
        let server =
            ProvisioningGatewayServer::new(client, SecretString::new(GATEWAY_SECRET), route())
                .expect("provisioning gateway")
                .with_history(history)
                .with_group_manager(Arc::clone(&manager) as Arc<dyn MatrixGroupManager>);
        let request = HttpRequest {
            path: "/v1/groups/rename".to_owned(),
            authorization: Some(GATEWAY_SECRET.to_owned()),
            request_id: Some("request-group-management".to_owned()),
            idempotency_key: Some("group-management-idempotency".to_owned()),
            body: serde_json::to_vec(&json!({
                "schema_version": 1,
                "tenant_id": "tenant_group_management",
                "account_id": "account_group_management",
                "connection_id": "connection_group_management",
                "identity_id": "identity_group_management",
                "provider": "whatsapp",
                "session_generation": "2026-09-14T00:00:00.000Z",
                "route": {
                    "gateway_route_id": "gateway_route_whatsapp",
                    "bridge_instance_id": "whatsapp-primary",
                    "matrix_user_id": MATRIX_USER,
                    "matrix_room_namespace": "communicator.0000.gold",
                    "provider_login_id": "login-group"
                },
                "operation_id": "group_management_one",
                "operation_created_at": "2026-09-14T00:00:00.000Z",
                "conversation_id": "conversation_group_management",
                "provider_group_id": "120363000000000000@g.us",
                "matrix_room_id": "!group-management:example.test",
                "expected_revision": "0",
                "action": "rename",
                "name": "Renamed operations",
                "participant_provider_ids": []
            }))
            .expect("request JSON"),
        };
        let (status, bytes) = server.handle_request(request).await;
        assert_eq!(status, 200, "{}", String::from_utf8_lossy(&bytes));
        let body: Value = serde_json::from_slice(&bytes).expect("management response JSON");
        assert_eq!(body["evidence"]["source"], "provider");
        assert_eq!(
            body["evidence"]["evidence_id"],
            "$bridge-group-name:example.test"
        );
        assert_eq!(
            body["member_provider_ids"],
            json!(["15551234567", "lid-42"])
        );
        let changes = changes.lock().expect("group change lock");
        assert_eq!(changes.len(), 1);
        assert_eq!(changes[0].action, MatrixGroupAction::Rename);
        assert_eq!(changes[0].room_id, "!group-management:example.test");
        assert_eq!(changes[0].name.as_deref(), Some("Renamed operations"));
        drop(changes);
        assert!(
            bridge
                .received_requests()
                .await
                .expect("bridge requests")
                .is_empty()
        );

        let parsed_request: GroupManagementRequest = serde_json::from_value(json!({
            "schema_version": 1,
            "tenant_id": "tenant_group_management",
            "account_id": "account_group_management",
            "connection_id": "connection_group_management",
            "identity_id": "identity_group_management",
            "provider": "whatsapp",
            "session_generation": "2026-09-14T00:00:00.000Z",
            "route": {
                "gateway_route_id": "gateway_route_whatsapp",
                "bridge_instance_id": "whatsapp-primary",
                "matrix_user_id": MATRIX_USER,
                "matrix_room_namespace": "communicator.0000.gold",
                "provider_login_id": "login-group"
            },
            "operation_id": "group_management_one",
            "operation_created_at": "2026-09-14T00:00:00.000Z",
            "conversation_id": "conversation_group_management",
            "provider_group_id": "120363000000000000@g.us",
            "matrix_room_id": "!group-management:example.test",
            "expected_revision": "0",
            "action": "rename",
            "name": "Renamed operations",
            "participant_provider_ids": []
        }))
        .expect("management request");
        assert!(
            managed_group_response(
                &parsed_request,
                MatrixGroupObservation {
                    member_provider_ids: vec!["malformed member".to_owned()],
                    ..manager.observation.clone()
                },
                "provider",
            )
            .is_err()
        );
    }

    #[async_trait]
    impl OutboundTextSender for RecordingOutboundSender {
        async fn send_encrypted_text(
            &self,
            room_id: &str,
            transaction_id: &str,
            _body: &str,
        ) -> Result<MatrixSendResult, crate::outbound::OutboundSendFailure> {
            self.rooms
                .lock()
                .expect("recording sender lock")
                .push(room_id.to_owned());
            Ok(MatrixSendResult {
                event_id: ruma::EventId::parse(format!("${transaction_id}:example.test").as_str())
                    .expect("valid recording event ID"),
            })
        }
    }

    #[tokio::test]
    async fn outbound_duplicate_in_flight_keeps_one_send_and_replays_confirmation_after_reopen() {
        let bridge = MockServer::start().await;
        let client = WhatsAppProvisioningClient::new_for_test(
            client_url(&bridge),
            SecretString::new(BRIDGE_SECRET),
            MATRIX_USER,
            Duration::from_secs(2),
        )
        .expect("test bridge URL is valid");

        let directory = tempdir().expect("state directory");
        fs::set_permissions(directory.path(), fs::Permissions::from_mode(0o700))
            .expect("restrict state parent");
        let database = directory.path().join("gateway.sqlite3");
        let generation = Utc
            .timestamp_millis_opt(1_700_000_000_000)
            .single()
            .expect("valid generation timestamp");
        let mut store = Store::open(
            &database,
            Keyring::new([0x44; 32], 1).expect("test keyring"),
        )
        .expect("open state store");
        store
            .append_room_binding(
                NewRoomBinding::new_with_session_generation(
                    "binding_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                    "!outbound-race:example.test",
                    "tenant_outbound",
                    "identity_outbound",
                    "connection_outbound",
                    "account_outbound",
                    Provider::Whatsapp,
                    "gateway_route_whatsapp",
                    "conversation_outbound",
                    MATRIX_USER,
                    generation.to_rfc3339(),
                    generation,
                )
                .expect("room binding"),
            )
            .expect("append room binding");
        let transport = Arc::new(SharedHistoryTransport {
            calls: AtomicUsize::new(0),
            event_count: 0,
        });
        let history = HistoryGatewayServer::new(
            store,
            Arc::clone(&transport) as Arc<dyn MatrixTransport>,
            GATEWAY_SECRET,
        )
        .expect("history gateway");
        let calls = Arc::new(AtomicUsize::new(0));
        let sender = Arc::new(BlockingOutboundSender {
            calls: Arc::clone(&calls),
            entered: Arc::new(Notify::new()),
            release: Arc::new(Notify::new()),
        });
        let server =
            ProvisioningGatewayServer::new(client, SecretString::new(GATEWAY_SECRET), route())
                .expect("provisioning gateway")
                .with_history(history)
                .with_outbound_sender(Arc::clone(&sender) as Arc<dyn OutboundTextSender>);

        let request_body = serde_json::to_vec(&json!({
            "schema_version": 1,
            "tenant_id": "tenant_outbound",
            "account_id": "account_outbound",
            "connection_id": "connection_outbound",
            "identity_id": "identity_outbound",
            "provider": "whatsapp",
            "conversation_id": "conversation_outbound",
            "message_id": "message_outbound",
            "event_id": "event_outbound",
            "transaction_id": "txn_outbound_race",
            "request_digest": "b".repeat(64),
            "projection_generation": 1,
            "session_generation": generation.to_rfc3339(),
            "route": {
                "gateway_route_id": "gateway_route_whatsapp",
                "bridge_instance_id": "whatsapp-primary",
                "matrix_user_id": MATRIX_USER,
                "matrix_room_namespace": "communicator.0000.gold"
            },
            "body": "race body"
        }))
        .expect("request JSON");
        let first_request = HttpRequest {
            path: "/v1/outbound/text".to_owned(),
            authorization: Some(GATEWAY_SECRET.to_owned()),
            request_id: Some("first".to_owned()),
            idempotency_key: Some("outbound-idempotency-race".to_owned()),
            body: request_body.clone(),
        };
        let duplicate_request = HttpRequest {
            path: "/v1/outbound/text".to_owned(),
            authorization: Some(GATEWAY_SECRET.to_owned()),
            request_id: Some("duplicate".to_owned()),
            idempotency_key: Some("outbound-idempotency-race".to_owned()),
            body: request_body.clone(),
        };
        let replay_request = HttpRequest {
            path: "/v1/outbound/text".to_owned(),
            authorization: Some(GATEWAY_SECRET.to_owned()),
            request_id: Some("replay".to_owned()),
            idempotency_key: Some("outbound-idempotency-race".to_owned()),
            body: request_body,
        };

        let first_server = server.clone();
        let first = tokio::spawn(async move { first_server.handle_request(first_request).await });
        tokio::time::timeout(Duration::from_secs(2), sender.entered.notified())
            .await
            .expect("first sender reaches controlled gate");

        let (duplicate_status, duplicate_body) = server.handle_request(duplicate_request).await;
        assert_eq!(duplicate_status, 200);
        let duplicate_json: Value =
            serde_json::from_slice(&duplicate_body).expect("duplicate response JSON");
        assert_eq!(duplicate_json["outcome"], "uncertain");

        sender.release.notify_one();
        let (first_status, first_body) = first.await.expect("first request task");
        assert_eq!(first_status, 200);
        let first_json: Value = serde_json::from_slice(&first_body).expect("first response JSON");
        assert_eq!(first_json["outcome"], "accepted");
        assert_eq!(calls.load(Ordering::SeqCst), 1);

        let (replay_status, replay_body) = server.handle_request(replay_request).await;
        assert_eq!(replay_status, 200);
        let replay_json: Value = serde_json::from_slice(&replay_body).expect("replay JSON");
        assert_eq!(replay_json["outcome"], "accepted");
        assert_eq!(replay_json["evidence"][0]["source"], "matrix");

        drop(server);
        let mut reopened = Store::open(
            &database,
            Keyring::new([0x44; 32], 1).expect("reopen test keyring"),
        )
        .expect("reopen outbound store");
        let preparation = reopened
            .prepare_outbound_text(NewOutboundText {
                transaction_id: "txn_outbound_race".to_owned(),
                idempotency_key: "outbound-idempotency-race".to_owned(),
                request_digest: "b".repeat(64),
                tenant_id: "tenant_outbound".to_owned(),
                account_id: "account_outbound".to_owned(),
                connection_id: "connection_outbound".to_owned(),
                identity_id: "identity_outbound".to_owned(),
                conversation_id: "conversation_outbound".to_owned(),
                message_id: "message_outbound".to_owned(),
                event_id: "event_outbound".to_owned(),
                matrix_room_id: "!outbound-race:example.test".to_owned(),
                session_generation: generation.to_rfc3339(),
                projection_generation: 1,
                body: "race body".to_owned(),
                created_at: generation,
            })
            .expect("replay after reopen");
        match preparation {
            OutboundTextPreparation::ExistingTerminal { response } => {
                let response: Value = serde_json::from_slice(&response).expect("stored JSON");
                assert_eq!(response["outcome"], "accepted");
                assert_eq!(response["evidence"][0]["source"], "matrix");
            }
            OutboundTextPreparation::Created | OutboundTextPreparation::ExistingPending => {
                panic!("reopened journal lost the confirmed terminal result")
            }
        }
    }

    #[tokio::test]
    async fn outbound_routes_two_conversations_on_one_account_to_their_bound_rooms() {
        let bridge = MockServer::start().await;
        let client = WhatsAppProvisioningClient::new_for_test(
            client_url(&bridge),
            SecretString::new(BRIDGE_SECRET),
            MATRIX_USER,
            Duration::from_secs(2),
        )
        .expect("test bridge URL is valid");
        let directory = tempdir().expect("state directory");
        fs::set_permissions(directory.path(), fs::Permissions::from_mode(0o700))
            .expect("restrict state parent");
        let database = directory.path().join("gateway.sqlite3");
        let created_at = Utc
            .timestamp_millis_opt(1_700_000_000_000)
            .single()
            .expect("valid binding timestamp");
        let session_generation = "2026-09-13T00:00:00.000Z".to_owned();
        let mut store = Store::open(
            &database,
            Keyring::new([0x55; 32], 1).expect("test keyring"),
        )
        .expect("open state store");
        for (binding_id, room_id, conversation_id) in [
            (
                "binding_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
                "!outbound-chat-one:example.test",
                "conversation_one",
            ),
            (
                "binding_cccccccccccccccccccccccccccccccc",
                "!outbound-chat-two:example.test",
                "conversation_two",
            ),
        ] {
            store
                .append_room_binding(
                    NewRoomBinding::new_with_session_generation(
                        binding_id,
                        room_id,
                        "tenant_outbound",
                        "identity_outbound",
                        "connection_outbound",
                        "account_outbound",
                        Provider::Whatsapp,
                        "gateway_route_whatsapp",
                        conversation_id,
                        MATRIX_USER,
                        session_generation.clone(),
                        created_at,
                    )
                    .expect("room binding"),
                )
                .expect("append room binding");
        }
        let transport = Arc::new(SharedHistoryTransport {
            calls: AtomicUsize::new(0),
            event_count: 0,
        });
        let history = HistoryGatewayServer::new(
            store,
            Arc::clone(&transport) as Arc<dyn MatrixTransport>,
            GATEWAY_SECRET,
        )
        .expect("history gateway");
        let rooms = Arc::new(StdMutex::new(Vec::new()));
        let server =
            ProvisioningGatewayServer::new(client, SecretString::new(GATEWAY_SECRET), route())
                .expect("provisioning gateway")
                .with_history(history)
                .with_outbound_sender(Arc::new(RecordingOutboundSender {
                    rooms: Arc::clone(&rooms),
                }));

        let request = |conversation_id: &str, transaction_id: &str, digest: char| HttpRequest {
            path: "/v1/outbound/text".to_owned(),
            authorization: Some(GATEWAY_SECRET.to_owned()),
            request_id: Some(format!("request-{transaction_id}")),
            idempotency_key: Some(format!("idempotency-{transaction_id}")),
            body: serde_json::to_vec(&json!({
                "schema_version": 1,
                "tenant_id": "tenant_outbound",
                "account_id": "account_outbound",
                "connection_id": "connection_outbound",
                "identity_id": "identity_outbound",
                "provider": "whatsapp",
                "conversation_id": conversation_id,
                "message_id": format!("message_{transaction_id}"),
                "event_id": format!("event_{transaction_id}"),
                "transaction_id": transaction_id,
                "request_digest": digest.to_string().repeat(64),
                "projection_generation": 1,
                "session_generation": session_generation.clone(),
                "route": {
                    "gateway_route_id": "gateway_route_whatsapp",
                    "bridge_instance_id": "whatsapp-primary",
                    "matrix_user_id": MATRIX_USER,
                    "matrix_room_namespace": "communicator.0000.gold"
                },
                "body": format!("body-{transaction_id}")
            }))
            .expect("request JSON"),
        };

        let mut stale_request = request("conversation_one", "txn_chat_stale", 'c');
        let mut stale_body: Value =
            serde_json::from_slice(&stale_request.body).expect("stale request JSON");
        stale_body["session_generation"] = Value::String("2026-09-12T00:00:00.000Z".to_owned());
        stale_request.body = serde_json::to_vec(&stale_body).expect("stale request body");
        let (stale_status, stale_response) = server.handle_request(stale_request).await;
        assert_eq!(stale_status, 409);
        assert_eq!(
            serde_json::from_slice::<Value>(&stale_response).expect("stale response JSON")["error"],
            OUTBOUND_STALE_SESSION
        );
        assert!(rooms.lock().expect("recording sender lock").is_empty());

        let (first_status, _) = server
            .handle_request(request("conversation_one", "txn_chat_one", 'd'))
            .await;
        let (second_status, _) = server
            .handle_request(request("conversation_two", "txn_chat_two", 'e'))
            .await;
        assert_eq!(first_status, 200);
        assert_eq!(second_status, 200);
        assert_eq!(
            rooms.lock().expect("recording sender lock").as_slice(),
            [
                "!outbound-chat-one:example.test",
                "!outbound-chat-two:example.test"
            ]
        );

        let (wrong_status, _) = server
            .handle_request(request("conversation_missing", "txn_chat_missing", 'f'))
            .await;
        assert_eq!(wrong_status, 403);
        assert_eq!(rooms.lock().expect("recording sender lock").len(), 2);
    }

    #[tokio::test]
    async fn shared_listener_reads_only_the_bound_original_mxc_descriptor() {
        let bridge = MockServer::start().await;
        let client = WhatsAppProvisioningClient::new_for_test(
            client_url(&bridge),
            SecretString::new(BRIDGE_SECRET),
            MATRIX_USER,
            Duration::from_secs(2),
        )
        .expect("test bridge URL is valid");

        let directory = tempdir().expect("state directory");
        fs::set_permissions(directory.path(), fs::Permissions::from_mode(0o700))
            .expect("restrict state parent");
        let database = directory.path().join("gateway.sqlite3");
        let mut store = Store::open(
            &database,
            Keyring::new([0x22; 32], 1).expect("test keyring"),
        )
        .expect("open state store");
        store
            .append_room_binding(
                NewRoomBinding::new(
                    "binding_0123456789abcdef0123456789abcdef",
                    "!attachment:example.test",
                    "tenant_demo",
                    "identity_demo",
                    "connection_demo",
                    "account_demo",
                    crate::model::Provider::Whatsapp,
                    "route_demo",
                    "conversation_demo",
                    "@owner:example.test",
                    Utc.timestamp_millis_opt(1_700_000_000_000)
                        .single()
                        .expect("valid binding timestamp"),
                )
                .expect("room binding"),
            )
            .expect("append room binding");
        let binding = store
            .active_room_binding_for_history(
                "tenant_demo",
                "account_demo",
                "connection_demo",
                "identity_demo",
                crate::model::Provider::Whatsapp,
            )
            .expect("resolve binding")
            .expect("active binding");

        let body = b"fixture media bytes".to_vec();
        let digest = crate::canonical::sha256_hex(&body);
        let media = MatrixMediaDescriptor {
            server_name: "matrix.example".to_owned(),
            media_id: "media123".to_owned(),
            mime_type: Some("image/png".to_owned()),
            source_sha256: Some(digest.clone()),
            encrypted: None,
        };
        let message = MatrixMessage::new(
            "!attachment:example.test",
            "$attachment-message:example.test",
            "@owner:example.test",
            "Owner",
            "photo",
            "2026-01-01T00:00:00.000Z",
        )
        .with_kind(MatrixMessageKind::Image)
        .with_attachments(vec![
            MatrixAttachment::new(
                Some("photo.png".to_owned()),
                Some("image/png".to_owned()),
                Some(body.len() as u64),
                Some(digest.clone()),
            )
            .with_media_descriptor(media),
        ]);
        let descriptor =
            AttachmentDescriptor::from_source(&binding, &message, &message.attachments()[0], 0)
                .expect("descriptor derivation")
                .expect("source media descriptor");

        let transport = Arc::new(AttachmentTransport {
            calls: AtomicUsize::new(0),
            bytes: body.clone(),
            mime_type: "image/png".to_owned(),
        });
        let message_id = crate::model::message_id(
            "!attachment:example.test",
            "$attachment-message:example.test",
        )
        .expect("message ID");
        let attachment_id = crate::model::attachment_id(&message_id, 0).expect("attachment ID");
        let initial_revision = crate::model::durable_event_id(
            "$attachment-message:example.test",
            crate::model::CanonicalEventType::AttachmentObserved,
            0,
        )
        .expect("attachment revision");
        let raw_event = CanonicalEvent::new(
            initial_revision,
            CanonicalEventSource::Live,
            "tenant_demo",
            "identity_demo",
            crate::model::Provider::Whatsapp,
            "account_demo",
            "conversation_demo",
            Some("!attachment:example.test".to_owned()),
            Some("$attachment-message:example.test".to_owned()),
            None,
            "2026-01-01T00:00:00.000Z",
            "2026-01-01T00:00:00.000Z",
            CanonicalPayload::AttachmentObserved(AttachmentObservedPayload {
                attachment_id: attachment_id.clone(),
                message_id: message_id.clone(),
                file_name: Some("photo.png".to_owned()),
                mime_type: Some("image/png".to_owned()),
                size_bytes: Some(body.len() as u64),
                sha256: Some(digest.clone()),
                r2_key: None,
            }),
        )
        .expect("raw canonical event");
        let mut routed = vec![RoutedEvent::new("route_demo", raw_event)];
        let mut descriptors = vec![descriptor];
        crate::attachments::resolve_media_metadata(
            transport.as_ref(),
            &mut routed,
            &mut descriptors,
        )
        .await
        .expect("resolve source media");
        assert_eq!(routed.len(), 2);
        let descriptor = descriptors.pop().expect("resolved descriptor");
        let fields = descriptor.lookup_fields();
        let descriptor_revision = fields[7].to_owned();
        let payload = descriptor.to_json().expect("descriptor JSON");
        store
            .upsert_attachment_descriptor(&fields, &payload)
            .expect("persist descriptor");
        let history = HistoryGatewayServer::new(
            store,
            Arc::clone(&transport) as Arc<dyn MatrixTransport>,
            GATEWAY_SECRET,
        )
        .expect("history gateway");
        let server =
            ProvisioningGatewayServer::new(client, SecretString::new(GATEWAY_SECRET), route())
                .expect("provisioning gateway")
                .with_history(history);
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind listener");
        let address = listener.local_addr().expect("listener address");
        let task = tokio::spawn(server.serve(listener));
        let http = Client::builder().no_proxy().build().expect("HTTP client");
        let request = json!({
            "tenant_id": "tenant_demo",
            "account_id": "account_demo",
            "connection_id": "connection_demo",
            "identity_id": "identity_demo",
            "conversation_id": "conversation_demo",
            "message_id": message_id,
            "attachment_id": attachment_id,
            "revision": descriptor_revision,
            "provider": "whatsapp",
            "media_key": format!("media/tenant_demo/{digest}"),
            "expected_size_bytes": body.len(),
            "expected_sha256": digest,
            "expected_mime_type": "image/png",
        });
        let unauthorized = http
            .post(format!("http://{address}/v1/attachments/read"))
            .bearer_auth("wrong-gateway-secret")
            .header("x-request-id", "attachment-unauthorized")
            .header("idempotency-key", "attachment-unauthorized")
            .header("content-type", "application/json")
            .body(serde_json::to_vec(&request).expect("request JSON"))
            .send()
            .await
            .expect("unauthorized response");
        assert_eq!(unauthorized.status(), StatusCode::UNAUTHORIZED);
        assert_eq!(transport.calls.load(Ordering::SeqCst), 1);

        let response = http
            .post(format!("http://{address}/v1/attachments/read"))
            .bearer_auth(GATEWAY_SECRET)
            .header("x-request-id", "attachment-read")
            .header("idempotency-key", "attachment-read")
            .header("content-type", "application/json")
            .body(serde_json::to_vec(&request).expect("request JSON"))
            .send()
            .await
            .expect("attachment response");
        assert_eq!(response.status(), StatusCode::OK);
        let response_body: Value =
            serde_json::from_slice(&response.bytes().await.expect("attachment body"))
                .expect("attachment JSON");
        assert_eq!(response_body["status"], "available");
        assert_eq!(response_body["mime_type"], "image/png");
        assert_eq!(response_body["sha256"], request["expected_sha256"]);
        assert_eq!(response_body["size_bytes"], request["expected_size_bytes"]);
        assert_eq!(
            response_body["bytes_base64"],
            base64::engine::general_purpose::STANDARD.encode(&body)
        );
        assert_eq!(transport.calls.load(Ordering::SeqCst), 2);

        let mut wrong_scope = request.clone();
        wrong_scope["message_id"] = Value::String("message_other".to_owned());
        let missing = http
            .post(format!("http://{address}/v1/attachments/read"))
            .bearer_auth(GATEWAY_SECRET)
            .header("x-request-id", "attachment-wrong-message")
            .header("idempotency-key", "attachment-wrong-message")
            .header("content-type", "application/json")
            .body(serde_json::to_vec(&wrong_scope).expect("request JSON"))
            .send()
            .await
            .expect("wrong scope response");
        assert_eq!(missing.status(), StatusCode::OK);
        let missing_body: Value =
            serde_json::from_slice(&missing.bytes().await.expect("missing body"))
                .expect("missing JSON");
        assert_eq!(missing_body["status"], "unavailable");
        assert_eq!(missing_body["reason"], "missing");
        assert_eq!(transport.calls.load(Ordering::SeqCst), 2);
        task.abort();
    }

    struct SharedHistoryTransport {
        calls: AtomicUsize,
        event_count: usize,
    }

    struct AttachmentTransport {
        calls: AtomicUsize,
        bytes: Vec<u8>,
        mime_type: String,
    }

    #[async_trait]
    impl MatrixTransport for AttachmentTransport {
        async fn fetch_sync(&self, _since: &SecretBytes) -> Result<FetchedMatrixSync, SafeError> {
            Err(SafeError::new("attachment_test_unexpected_sync"))
        }

        async fn fetch_media(
            &self,
            descriptor: &MatrixMediaDescriptor,
        ) -> Result<FetchedMatrixMedia, SafeError> {
            assert_eq!(descriptor.server_name, "matrix.example");
            assert_eq!(descriptor.media_id, "media123");
            self.calls.fetch_add(1, Ordering::SeqCst);
            FetchedMatrixMedia::new(self.bytes.clone(), self.mime_type.clone())
        }

        async fn send_crypto(
            &self,
            _request: &PendingMatrixRequest,
        ) -> Result<RawMatrixResponse, SafeError> {
            Err(SafeError::new("attachment_test_unexpected_crypto"))
        }
    }

    #[async_trait]
    impl MatrixTransport for SharedHistoryTransport {
        async fn fetch_sync(&self, _since: &SecretBytes) -> Result<FetchedMatrixSync, SafeError> {
            Err(SafeError::new("history_test_unexpected_sync"))
        }

        async fn backfill_page(
            &self,
            _room_id: &str,
            _from: Option<&SecretBytes>,
            _limit: u64,
        ) -> Result<RawBackfillPage, SafeError> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            let chunk = (0..self.event_count)
                .map(|index| {
                    Raw::<AnyTimelineEvent>::from_json_string(
                        json!({
                            "event_id": format!("$shared-history-{index}:example.test"),
                            "origin_server_ts": 1_767_225_600_000_i64,
                            "sender": "@owner:example.test",
                            "type": "m.room.message",
                            "room_id": "!shared-history:example.test",
                            "content": {
                                "msgtype": "m.text",
                                "body": format!("history page {index}")
                            }
                        })
                        .to_string(),
                    )
                    .map_err(|_| SafeError::new("history_test_invalid_event"))
                })
                .collect::<Result<Vec<_>, _>>()?;
            RawBackfillPage::new(
                "matrix-start".to_owned(),
                Some("matrix-end".to_owned()),
                chunk,
                Vec::new(),
            )
        }

        async fn send_crypto(
            &self,
            _request: &PendingMatrixRequest,
        ) -> Result<RawMatrixResponse, SafeError> {
            Err(SafeError::new("history_test_unexpected_crypto"))
        }
    }

    async fn wait_for_history_page(transport: &SharedHistoryTransport) {
        tokio::time::timeout(Duration::from_secs(2), async {
            while transport.calls.load(Ordering::SeqCst) == 0 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("lost-response request reaches Matrix history transport");
    }

    async fn spawn_shared_history_gateway(
        event_count: usize,
    ) -> (
        tempfile::TempDir,
        Arc<SharedHistoryTransport>,
        std::net::SocketAddr,
        tokio::task::JoinHandle<Result<(), std::io::Error>>,
    ) {
        let bridge = MockServer::start().await;
        let client = WhatsAppProvisioningClient::new_for_test(
            client_url(&bridge),
            SecretString::new(BRIDGE_SECRET),
            MATRIX_USER,
            Duration::from_secs(2),
        )
        .expect("test bridge URL is valid");

        let directory = tempdir().expect("state directory");
        fs::set_permissions(directory.path(), fs::Permissions::from_mode(0o700))
            .expect("restrict state parent");
        let database = directory.path().join("gateway.sqlite3");
        let keyring = Keyring::new([0x11; 32], 1).expect("test keyring");
        let mut store = Store::open(&database, keyring).expect("open state store");
        store
            .append_room_binding(
                NewRoomBinding::new(
                    "binding_0123456789abcdef0123456789abcdef",
                    "!shared-history:example.test",
                    "tenant_demo",
                    "identity_demo",
                    "connection_demo",
                    "account_demo",
                    crate::model::Provider::Whatsapp,
                    "route_demo",
                    "conversation_demo",
                    "@owner:example.test",
                    Utc.timestamp_millis_opt(1_700_000_000_000)
                        .single()
                        .expect("valid binding timestamp"),
                )
                .expect("room binding"),
            )
            .expect("append room binding");

        let transport = Arc::new(SharedHistoryTransport {
            calls: AtomicUsize::new(0),
            event_count,
        });
        let history = HistoryGatewayServer::new(
            store,
            Arc::clone(&transport) as Arc<dyn MatrixTransport>,
            GATEWAY_SECRET,
        )
        .expect("history gateway");
        let server =
            ProvisioningGatewayServer::new(client, SecretString::new(GATEWAY_SECRET), route())
                .expect("provisioning gateway")
                .with_history(history);
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind listener");
        let address = listener.local_addr().expect("listener address");
        let task = tokio::spawn(server.serve(listener));
        (directory, transport, address, task)
    }

    fn shared_history_owner(import_id: &str, max_events: u64) -> Value {
        json!({
            "tenant_id": "tenant_demo",
            "account_id": "account_demo",
            "connection_id": "connection_demo",
            "identity_id": "identity_demo",
            "provider": "whatsapp",
            "import_id": import_id,
            "start_at": "2026-01-01T00:00:00.000Z",
            "end_at": "2026-01-02T00:00:00.000Z",
            "max_events": max_events
        })
    }

    #[tokio::test]
    async fn shared_listener_authenticates_history_and_replays_a_lost_advance_response() {
        let (_directory, transport, address, task) = spawn_shared_history_gateway(1).await;
        let http = Client::builder().no_proxy().build().expect("HTTP client");
        let base_url = format!("http://{address}");
        let owner = shared_history_owner("import_shared_history", 100);
        let start_body = serde_json::to_vec(&owner).expect("start body");
        let unauthorized = http
            .post(format!("{base_url}/v1/history-imports/start"))
            .bearer_auth("wrong-history-secret")
            .header("content-type", "application/json")
            .header("x-request-id", "history-unauthorized")
            .header("idempotency-key", "history-unauthorized")
            .body(start_body.clone())
            .send()
            .await
            .expect("unauthorized history response");
        assert_eq!(unauthorized.status(), StatusCode::UNAUTHORIZED);

        let started = http
            .post(format!("{base_url}/v1/history-imports/start"))
            .bearer_auth(GATEWAY_SECRET)
            .header("content-type", "application/json")
            .header("x-request-id", "history-start")
            .header("idempotency-key", "history-start")
            .body(start_body)
            .send()
            .await
            .expect("history start response");
        assert_eq!(started.status(), StatusCode::OK);

        let mut advance = owner;
        advance["range_id"] = json!("range_shared_history");
        advance["source_cursor"] = Value::Null;
        let advance_body = serde_json::to_vec(&advance).expect("advance body");
        let mut lost_response = TcpStream::connect(address)
            .await
            .expect("connect lost-response request");
        let request = format!(
            "POST /v1/history-imports/advance HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer {GATEWAY_SECRET}\r\nContent-Type: application/json\r\nX-Request-Id: history-advance\r\nIdempotency-Key: history-advance\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            advance_body.len(),
            String::from_utf8(advance_body.clone()).expect("advance JSON UTF-8")
        );
        lost_response
            .write_all(request.as_bytes())
            .await
            .expect("write lost-response request");
        lost_response
            .shutdown()
            .await
            .expect("close lost-response request");
        drop(lost_response);
        wait_for_history_page(&transport).await;
        assert_eq!(transport.calls.load(Ordering::SeqCst), 1);

        let replay = http
            .post(format!("{base_url}/v1/history-imports/advance"))
            .bearer_auth(GATEWAY_SECRET)
            .header("content-type", "application/json")
            .header("x-request-id", "history-advance")
            .header("idempotency-key", "history-advance")
            .body(advance_body)
            .send()
            .await
            .expect("replayed history response");
        assert_eq!(replay.status(), StatusCode::OK);
        let replay_body: Value =
            serde_json::from_slice(&replay.bytes().await.expect("replayed history body"))
                .expect("replayed history JSON");
        assert_eq!(replay_body["status"], "active");
        assert_eq!(replay_body["events"].as_array().map(Vec::len), Some(1));
        let public_cursor = replay_body["next_cursor"]
            .as_str()
            .expect("opaque replay cursor");
        assert!(public_cursor.starts_with("history_"));
        assert_ne!(public_cursor, "matrix-end");
        assert_eq!(transport.calls.load(Ordering::SeqCst), 1);

        task.abort();
    }

    #[tokio::test]
    async fn shared_listener_accepts_500_events_and_rejects_501_without_checkpointing() {
        for (event_count, max_events, expected_status) in [
            (500_usize, 500_u64, StatusCode::OK),
            (501, 501, StatusCode::BAD_GATEWAY),
        ] {
            let (_directory, transport, address, task) =
                spawn_shared_history_gateway(event_count).await;
            let http = Client::builder().no_proxy().build().expect("HTTP client");
            let base_url = format!("http://{address}");
            let import_id = format!("import_shared_bound_{event_count}");
            let owner = shared_history_owner(&import_id, max_events);
            let started = http
                .post(format!("{base_url}/v1/history-imports/start"))
                .bearer_auth(GATEWAY_SECRET)
                .header("content-type", "application/json")
                .header("x-request-id", format!("history-bound-start-{event_count}"))
                .header(
                    "idempotency-key",
                    format!("history-bound-start-{event_count}"),
                )
                .body(serde_json::to_vec(&owner).expect("start body"))
                .send()
                .await
                .expect("history start response");
            assert_eq!(started.status(), StatusCode::OK);

            let mut advance = owner;
            advance["range_id"] = json!(format!("range_shared_bound_{event_count}"));
            advance["source_cursor"] = Value::Null;
            let advance_body = serde_json::to_vec(&advance).expect("advance body");
            let first = http
                .post(format!("{base_url}/v1/history-imports/advance"))
                .bearer_auth(GATEWAY_SECRET)
                .header("content-type", "application/json")
                .header(
                    "x-request-id",
                    format!("history-bound-advance-{event_count}"),
                )
                .header(
                    "idempotency-key",
                    format!("history-bound-advance-{event_count}"),
                )
                .body(advance_body.clone())
                .send()
                .await
                .expect("history advance response");
            assert_eq!(first.status(), expected_status);
            let first_body: Value =
                serde_json::from_slice(&first.bytes().await.expect("history advance body"))
                    .expect("history advance JSON");

            if event_count == 500 {
                assert_eq!(first_body["status"], "active");
                assert_eq!(first_body["events"].as_array().map(Vec::len), Some(500));
                assert!(
                    first_body["next_cursor"]
                        .as_str()
                        .is_some_and(|value| value.starts_with("history_"))
                );
                assert_eq!(transport.calls.load(Ordering::SeqCst), 1);
            } else {
                assert_eq!(first_body["error"], "provider_error");
                assert_eq!(transport.calls.load(Ordering::SeqCst), 1);

                let retry = http
                    .post(format!("{base_url}/v1/history-imports/advance"))
                    .bearer_auth(GATEWAY_SECRET)
                    .header("content-type", "application/json")
                    .header(
                        "x-request-id",
                        format!("history-bound-advance-{event_count}"),
                    )
                    .header(
                        "idempotency-key",
                        format!("history-bound-advance-{event_count}"),
                    )
                    .body(advance_body)
                    .send()
                    .await
                    .expect("oversized history retry response");
                assert_eq!(retry.status(), StatusCode::BAD_GATEWAY);
                assert_eq!(transport.calls.load(Ordering::SeqCst), 2);

                let start_retry = http
                    .post(format!("{base_url}/v1/history-imports/start"))
                    .bearer_auth(GATEWAY_SECRET)
                    .header("content-type", "application/json")
                    .header("x-request-id", "history-bound-start-retry")
                    .header("idempotency-key", "history-bound-start-retry")
                    .body(
                        serde_json::to_vec(&shared_history_owner(&import_id, max_events))
                            .expect("start retry body"),
                    )
                    .send()
                    .await
                    .expect("history start retry response");
                assert_eq!(start_retry.status(), StatusCode::OK);
                let start_retry_body: Value = serde_json::from_slice(
                    &start_retry.bytes().await.expect("history start retry body"),
                )
                .expect("history start retry JSON");
                assert_eq!(start_retry_body["ranges"][0]["source_cursor"], Value::Null);
            }

            task.abort();
        }
    }
}
