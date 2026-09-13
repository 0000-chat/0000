//! Private provider gateway for the pinned mautrix-whatsapp provisioning API.
//!
//! The HTTP surface in this module is intentionally provider-neutral.  Only
//! this adapter knows the mautrix process, step, and transaction identifiers;
//! they remain in a bounded in-memory map and are never returned to the
//! control-plane Worker or browser.

use std::{collections::HashMap, fmt, net::SocketAddr, sync::Arc, time::Duration};

use reqwest::{Client, Method, StatusCode, Url, redirect::Policy};
use serde::Deserialize;
use serde_json::{Value, json};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    sync::Mutex,
};
use uuid::Uuid;

use crate::{history::HistoryGatewayServer, ingestion::SecretString};

const PROVISIONING_ROOT: &str = "/_matrix/provision/v3";
const MAX_HTTP_BODY_BYTES: usize = 64 * 1024;
const MAX_QR_BYTES: usize = 16 * 1024;
const MAX_ID_BYTES: usize = 512;
const PROVIDER_ERROR: &str = "provider_error";
const PROVIDER_UNAVAILABLE: &str = "provider_unavailable";
const PROVISIONING_DISABLED: &str = "provisioning_disabled";
const IDENTITY_MISMATCH: &str = "identity_mismatch";
const INVALID_REQUEST: &str = "invalid_request";

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ProvisioningFailure {
    ProviderError,
    ProviderUnavailable,
    ProvisioningDisabled,
    IdentityMismatch,
    InvalidRequest,
}

impl ProvisioningFailure {
    pub const fn code(self) -> &'static str {
        match self {
            Self::ProviderError => PROVIDER_ERROR,
            Self::ProviderUnavailable => PROVIDER_UNAVAILABLE,
            Self::ProvisioningDisabled => PROVISIONING_DISABLED,
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
        let mut url = self.route_url(path)?;
        {
            let mut pairs = url.query_pairs_mut();
            for (name, value) in query {
                pairs.append_pair(name, value);
            }
        }
        let response = self
            .client
            .request(method, url)
            .bearer_auth(self.shared_secret.as_str())
            .send()
            .await
            .map_err(|_| ProvisioningFailure::ProviderUnavailable)?;
        let status = response.status();
        let body = read_bounded_body(response).await?;
        if status == StatusCode::UNAUTHORIZED || status == StatusCode::FORBIDDEN {
            return Err(ProvisioningFailure::ProvisioningDisabled);
        }
        if !status.is_success() {
            return Err(ProvisioningFailure::ProviderError);
        }
        serde_json::from_slice(&body).map_err(|_| ProvisioningFailure::ProviderError)
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
        })
    }

    /// Add the authenticated Matrix history adapter to the same private
    /// listener used by the provider-linking routes.
    pub fn with_history(mut self, history: HistoryGatewayServer) -> Self {
        self.history = Some(Arc::new(history));
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
        if request.path.starts_with("/v1/history-imports/") {
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
            Arc,
            atomic::{AtomicUsize, Ordering},
        },
    };

    use super::*;
    use async_trait::async_trait;
    use chrono::{TimeZone, Utc};
    use serde_json::json;
    use tempfile::tempdir;
    use tokio::io::AsyncWriteExt;
    use wiremock::{Mock, MockServer, ResponseTemplate, matchers};

    use crate::{
        crypto::Keyring,
        crypto_outbox::{PendingMatrixRequest, RawMatrixResponse},
        history::HistoryGatewayServer,
        matrix::{FetchedMatrixSync, MatrixTransport, RawBackfillPage},
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

    struct SharedHistoryTransport {
        calls: AtomicUsize,
        event_count: usize,
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
