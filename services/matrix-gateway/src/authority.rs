//! Private, one-shot outbound authority claims.
//!
//! The control-plane Worker owns the current grant and membership epoch. The
//! gateway asks it for a single claim immediately before a Matrix or provider
//! call. A claim response is useful only when every request binding is echoed
//! exactly; transport or protocol uncertainty never authorizes a sender.

use std::{fmt, net::IpAddr, time::Duration};

use async_trait::async_trait;
use futures_util::StreamExt;
use reqwest::{Client, Method, StatusCode, Url, redirect::Policy};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::ingestion::SecretString;

const CLAIM_PATH: &str = "/internal/v1/outbound/dispatch-claims";
const MAX_REQUEST_BYTES: usize = 64 * 1024;
const MAX_RESPONSE_BYTES: usize = 64 * 1024;
const MAX_CLAIM_LIFETIME_SECS: i64 = 60;

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", deny_unknown_fields)]
pub enum OutboundCapability {
    #[serde(rename = "account_grant")]
    AccountGrant {
        grant_id: String,
        authorization_epoch: u64,
    },
    #[serde(rename = "owner_admin")]
    OwnerAdmin {
        authority_id: String,
        authority_epoch: u64,
    },
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MessageAuthorityClaim {
    pub tenant_id: String,
    pub membership_id: String,
    pub actor_identity_id: String,
    pub account_id: String,
    pub conversation_id: String,
    pub connection_id: String,
    pub reservation_id: String,
    pub command_id: String,
    pub dispatch_id: String,
    pub transaction_id: String,
    pub request_digest: String,
    pub body_digest: String,
    pub capability: OutboundCapability,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct OperationAuthorityClaim {
    pub operation: PrivateAuthorityOperation,
    pub tenant_id: String,
    pub membership_id: String,
    pub actor_identity_id: String,
    pub account_id: String,
    pub conversation_id: String,
    pub connection_id: String,
    pub reservation_id: String,
    pub operation_id: String,
    pub request_hash: String,
    pub session_generation: String,
    pub capability: OutboundCapability,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum PrivateAuthorityOperation {
    ConversationCreate,
    ReceiptSend,
    GroupCreate,
    GroupManage,
}

impl PrivateAuthorityOperation {
    const fn as_str(self) -> &'static str {
        match self {
            Self::ConversationCreate => "conversation.create",
            Self::ReceiptSend => "receipt.send",
            Self::GroupCreate => "group.create",
            Self::GroupManage => "group.manage",
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum AuthorityClaimRequest {
    Message(MessageAuthorityClaim),
    Operation(OperationAuthorityClaim),
}

impl AuthorityClaimRequest {
    fn operation(&self) -> &'static str {
        match self {
            Self::Message(_) => "message.send",
            Self::Operation(value) => value.operation.as_str(),
        }
    }

    fn operation_id(&self) -> &str {
        match self {
            Self::Message(value) => &value.dispatch_id,
            Self::Operation(value) => &value.operation_id,
        }
    }

    fn claim_id(&self) -> String {
        match self {
            Self::Message(value) => format!("claim_{}", value.transaction_id),
            Self::Operation(value) => format!("claim_{}", value.operation_id),
        }
    }

    fn common(&self) -> AuthorityClaimCommon<'_> {
        match self {
            Self::Message(value) => AuthorityClaimCommon {
                tenant_id: &value.tenant_id,
                membership_id: &value.membership_id,
                identity_id: &value.actor_identity_id,
                account_id: &value.account_id,
                conversation_id: &value.conversation_id,
                connection_id: &value.connection_id,
                reservation_id: &value.reservation_id,
                request_hash: &value.request_digest,
                session_generation: None,
                capability: &value.capability,
            },
            Self::Operation(value) => AuthorityClaimCommon {
                tenant_id: &value.tenant_id,
                membership_id: &value.membership_id,
                identity_id: &value.actor_identity_id,
                account_id: &value.account_id,
                conversation_id: &value.conversation_id,
                connection_id: &value.connection_id,
                reservation_id: &value.reservation_id,
                request_hash: &value.request_hash,
                session_generation: Some(&value.session_generation),
                capability: &value.capability,
            },
        }
    }
}

struct AuthorityClaimCommon<'a> {
    tenant_id: &'a str,
    membership_id: &'a str,
    identity_id: &'a str,
    account_id: &'a str,
    conversation_id: &'a str,
    connection_id: &'a str,
    reservation_id: &'a str,
    request_hash: &'a str,
    session_generation: Option<&'a str>,
    capability: &'a OutboundCapability,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum AuthorityClaimOutcome {
    Allowed { expires_at: String },
    Denied { reason: String },
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum AuthorityClaimFailure {
    InvalidRequest,
    Uncertain,
}

impl AuthorityClaimFailure {
    pub const fn code(self) -> &'static str {
        match self {
            Self::InvalidRequest => "authority_invalid_request",
            Self::Uncertain => "authority_uncertain",
        }
    }
}

impl fmt::Display for AuthorityClaimFailure {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.code())
    }
}

impl std::error::Error for AuthorityClaimFailure {}

#[async_trait]
pub trait OutboundAuthority: Send + Sync {
    async fn claim(
        &self,
        request: AuthorityClaimRequest,
    ) -> Result<AuthorityClaimOutcome, AuthorityClaimFailure>;
}

/// Bounded HTTP client for the private Worker claim endpoint.
pub struct AuthorityClaimClient {
    client: Client,
    endpoint: Url,
    shared_secret: SecretString,
}

impl fmt::Debug for AuthorityClaimClient {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("AuthorityClaimClient([REDACTED])")
    }
}

impl AuthorityClaimClient {
    pub fn new(
        base_url: impl AsRef<str>,
        shared_secret: SecretString,
        timeout: Duration,
    ) -> Result<Self, AuthorityClaimFailure> {
        Self::build(base_url.as_ref(), shared_secret, timeout, false)
    }

    #[cfg(test)]
    pub fn new_for_test(
        base_url: impl AsRef<str>,
        shared_secret: SecretString,
        timeout: Duration,
    ) -> Result<Self, AuthorityClaimFailure> {
        Self::build(base_url.as_ref(), shared_secret, timeout, true)
    }

    fn build(
        base_url: &str,
        shared_secret: SecretString,
        timeout: Duration,
        allow_loopback_http: bool,
    ) -> Result<Self, AuthorityClaimFailure> {
        if shared_secret.as_str().len() < 16 || timeout.is_zero() {
            return Err(AuthorityClaimFailure::InvalidRequest);
        }
        let base = Url::parse(base_url).map_err(|_| AuthorityClaimFailure::InvalidRequest)?;
        let loopback_http = allow_loopback_http
            && base.scheme() == "http"
            && is_loopback(&base)
            && base.port().is_some();
        if (base.scheme() != "https" && !loopback_http)
            || base.username() != ""
            || base.password().is_some()
            || base.query().is_some()
            || base.fragment().is_some()
            || base.path() != "/"
        {
            return Err(AuthorityClaimFailure::InvalidRequest);
        }
        let endpoint = base
            .join(CLAIM_PATH.trim_start_matches('/'))
            .map_err(|_| AuthorityClaimFailure::InvalidRequest)?;
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
            .timeout(timeout)
            .build()
            .map_err(|_| AuthorityClaimFailure::InvalidRequest)?;
        Ok(Self {
            client,
            endpoint,
            shared_secret,
        })
    }

    fn request_body(
        &self,
        request: &AuthorityClaimRequest,
        now: &str,
        expires_at: &str,
    ) -> Result<Value, AuthorityClaimFailure> {
        let common = request.common();
        let capability = serde_json::to_value(common.capability)
            .map_err(|_| AuthorityClaimFailure::InvalidRequest)?;
        let mut body = serde_json::json!({
            "schema_version": 1,
            "operation": request.operation(),
            "tenant_id": common.tenant_id,
            "membership_id": common.membership_id,
            "identity_id": common.identity_id,
            "account_id": common.account_id,
            "conversation_id": common.conversation_id,
            "connection_id": common.connection_id,
            "reservation_id": common.reservation_id,
            "operation_id": request.operation_id(),
            "request_hash": common.request_hash,
            "capability": capability,
            "now": now,
            "expires_at": expires_at,
            "claim_id": request.claim_id(),
        });
        if let Some(session_generation) = common.session_generation {
            body["session_generation"] = Value::String(session_generation.to_owned());
        }
        if let AuthorityClaimRequest::Message(value) = request {
            body["command_id"] = Value::String(value.command_id.clone());
            body["dispatch_id"] = Value::String(value.dispatch_id.clone());
            body["transaction_id"] = Value::String(value.transaction_id.clone());
            body["request_digest"] = Value::String(value.request_digest.clone());
            body["body_digest"] = Value::String(value.body_digest.clone());
        }
        let encoded =
            serde_json::to_vec(&body).map_err(|_| AuthorityClaimFailure::InvalidRequest)?;
        if encoded.len() > MAX_REQUEST_BYTES {
            return Err(AuthorityClaimFailure::InvalidRequest);
        }
        Ok(body)
    }
}

#[async_trait]
impl OutboundAuthority for AuthorityClaimClient {
    async fn claim(
        &self,
        request: AuthorityClaimRequest,
    ) -> Result<AuthorityClaimOutcome, AuthorityClaimFailure> {
        let now = chrono::Utc::now();
        let expires = now + chrono::Duration::seconds(MAX_CLAIM_LIFETIME_SECS);
        let now_text = now.to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        let expires_text = expires.to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        let body = self.request_body(&request, &now_text, &expires_text)?;
        let claim_id = request.claim_id();
        let request_id = format!("authority_{claim_id}");
        let response = self
            .client
            .request(Method::POST, self.endpoint.clone())
            .bearer_auth(self.shared_secret.as_str())
            .header("content-type", "application/json")
            .header("accept", "application/json")
            .header("cache-control", "no-store")
            .header("x-request-id", request_id)
            .header("idempotency-key", claim_id)
            .body(serde_json::to_vec(&body).map_err(|_| AuthorityClaimFailure::InvalidRequest)?)
            .send()
            .await
            .map_err(|_| AuthorityClaimFailure::Uncertain)?;
        let status = response.status();
        let bytes = bounded_body(response, MAX_RESPONSE_BYTES).await?;
        let value: Value =
            serde_json::from_slice(&bytes).map_err(|_| AuthorityClaimFailure::Uncertain)?;
        parse_response(&request, status, value)
    }
}

async fn bounded_body(
    response: reqwest::Response,
    limit: usize,
) -> Result<Vec<u8>, AuthorityClaimFailure> {
    if response
        .content_length()
        .is_some_and(|length| length > limit as u64)
    {
        return Err(AuthorityClaimFailure::Uncertain);
    }
    let mut body = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|_| AuthorityClaimFailure::Uncertain)?;
        if body.len().saturating_add(chunk.len()) > limit {
            return Err(AuthorityClaimFailure::Uncertain);
        }
        body.extend_from_slice(&chunk);
    }
    Ok(body)
}

fn is_loopback(url: &Url) -> bool {
    url.host_str().is_some_and(|host| {
        host.eq_ignore_ascii_case("localhost")
            || host
                .parse::<IpAddr>()
                .is_ok_and(|address| address.is_loopback())
    })
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ResponseClaim {
    id: String,
    tenant_id: String,
    reservation_id: String,
    membership_id: String,
    identity_id: String,
    account_id: String,
    conversation_id: String,
    connection_id: String,
    #[serde(default)]
    grant_id: Option<String>,
    capability: OutboundCapability,
    #[serde(default)]
    operation_scope: Option<String>,
    #[serde(default)]
    operation_id: Option<String>,
    #[serde(default)]
    request_hash: Option<String>,
    #[serde(default)]
    session_generation: Option<String>,
    #[serde(default)]
    status: Option<String>,
    #[serde(default)]
    uncertain_reason: Option<String>,
    expires_at: String,
    created_at: String,
    updated_at: String,
    #[serde(default)]
    command_id: Option<String>,
    #[serde(default)]
    dispatch_id: Option<String>,
    #[serde(default)]
    transaction_id: Option<String>,
    #[serde(default)]
    request_digest: Option<String>,
    #[serde(default)]
    body_digest: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ResponseEnvelope {
    status: String,
    #[serde(default)]
    replayed: Option<bool>,
    #[serde(default)]
    provider_allowed: Option<bool>,
    #[serde(default)]
    reason: Option<String>,
    #[serde(default)]
    claim: Option<ResponseClaim>,
}

fn parse_response(
    request: &AuthorityClaimRequest,
    status: StatusCode,
    value: Value,
) -> Result<AuthorityClaimOutcome, AuthorityClaimFailure> {
    let envelope: ResponseEnvelope =
        serde_json::from_value(value).map_err(|_| AuthorityClaimFailure::Uncertain)?;
    if envelope.status == "denied" {
        let reason = envelope
            .reason
            .filter(|reason| !reason.is_empty())
            .ok_or(AuthorityClaimFailure::Uncertain)?;
        if !status.is_client_error() && !status.is_success() {
            return Err(AuthorityClaimFailure::Uncertain);
        }
        return Ok(AuthorityClaimOutcome::Denied { reason });
    }
    if envelope.status != "claimed"
        || envelope.replayed != Some(false)
        || envelope.provider_allowed != Some(true)
        || !status.is_success()
    {
        return Err(AuthorityClaimFailure::Uncertain);
    }
    let claim = envelope.claim.ok_or(AuthorityClaimFailure::Uncertain)?;
    validate_claim(request, &claim)
}

fn validate_claim(
    request: &AuthorityClaimRequest,
    claim: &ResponseClaim,
) -> Result<AuthorityClaimOutcome, AuthorityClaimFailure> {
    let common = request.common();
    let _response_timestamps = (
        &claim.uncertain_reason,
        &claim.created_at,
        &claim.updated_at,
    );
    if claim.id.is_empty()
        || claim.tenant_id != common.tenant_id
        || claim.reservation_id != common.reservation_id
        || claim.membership_id != common.membership_id
        || claim.identity_id != common.identity_id
        || claim.account_id != common.account_id
        || claim.conversation_id != common.conversation_id
        || claim.connection_id != common.connection_id
        || claim.grant_id
            != match common.capability {
                OutboundCapability::AccountGrant { grant_id, .. } => Some(grant_id.clone()),
                OutboundCapability::OwnerAdmin { .. } => None,
            }
        || claim.capability != *common.capability
        || claim.session_generation.as_deref() != common.session_generation
    {
        return Err(AuthorityClaimFailure::Uncertain);
    }
    let expires_at = chrono::DateTime::parse_from_rfc3339(&claim.expires_at)
        .map_err(|_| AuthorityClaimFailure::Uncertain)?
        .with_timezone(&chrono::Utc);
    if expires_at <= chrono::Utc::now() {
        return Err(AuthorityClaimFailure::Uncertain);
    }
    match request {
        AuthorityClaimRequest::Message(value) => {
            if claim.operation_scope.is_some()
                || claim.operation_id.is_some()
                || claim.request_hash.is_some()
                || claim.status.as_deref() != Some("claimed")
                || claim.command_id.as_deref() != Some(value.command_id.as_str())
                || claim.dispatch_id.as_deref() != Some(value.dispatch_id.as_str())
                || claim.transaction_id.as_deref() != Some(value.transaction_id.as_str())
                || claim.request_digest.as_deref() != Some(value.request_digest.as_str())
                || claim.body_digest.as_deref() != Some(value.body_digest.as_str())
            {
                return Err(AuthorityClaimFailure::Uncertain);
            }
        }
        AuthorityClaimRequest::Operation(_) => {
            if claim.operation_scope.as_deref() != Some(request.operation())
                || claim.operation_id.as_deref() != Some(request.operation_id())
                || claim.request_hash.as_deref() != Some(common.request_hash)
                || claim.status.as_deref() != Some("claimed")
                || claim.command_id.is_some()
                || claim.dispatch_id.is_some()
                || claim.transaction_id.is_some()
                || claim.request_digest.is_some()
                || claim.body_digest.is_some()
            {
                return Err(AuthorityClaimFailure::Uncertain);
            }
        }
    }
    Ok(AuthorityClaimOutcome::Allowed {
        expires_at: claim.expires_at.clone(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{Value, json};
    use wiremock::{Mock, MockServer, ResponseTemplate, matchers};

    fn message_request() -> AuthorityClaimRequest {
        AuthorityClaimRequest::Message(MessageAuthorityClaim {
            tenant_id: "tenant_1".to_owned(),
            membership_id: "membership_1".to_owned(),
            actor_identity_id: "identity_1".to_owned(),
            account_id: "account_1".to_owned(),
            conversation_id: "conversation_1".to_owned(),
            connection_id: "connection_1".to_owned(),
            reservation_id: "reservation_1".to_owned(),
            command_id: "command_1".to_owned(),
            dispatch_id: "dispatch_1".to_owned(),
            transaction_id: "transaction_1".to_owned(),
            request_digest: "a".repeat(64),
            body_digest: "b".repeat(64),
            capability: OutboundCapability::AccountGrant {
                grant_id: "grant_1".to_owned(),
                authorization_epoch: 3,
            },
        })
    }

    fn claim_json() -> Value {
        json!({
            "id": "claim_transaction_1",
            "tenant_id": "tenant_1",
            "reservation_id": "reservation_1",
            "membership_id": "membership_1",
            "identity_id": "identity_1",
            "account_id": "account_1",
            "conversation_id": "conversation_1",
            "connection_id": "connection_1",
            "grant_id": "grant_1",
            "capability": {
                "kind": "account_grant",
                "grant_id": "grant_1",
                "authorization_epoch": 3
            },
            "command_id": "command_1",
            "dispatch_id": "dispatch_1",
            "transaction_id": "transaction_1",
            "request_digest": "a".repeat(64),
            "body_digest": "b".repeat(64),
            "status": "claimed",
            "uncertain_reason": null,
            "expires_at": (chrono::Utc::now() + chrono::Duration::seconds(30)).to_rfc3339(),
            "created_at": chrono::Utc::now().to_rfc3339(),
            "updated_at": chrono::Utc::now().to_rfc3339()
        })
    }

    #[tokio::test]
    async fn validates_exact_claim_echo() {
        let server = MockServer::start().await;
        Mock::given(matchers::method("POST"))
            .and(matchers::path(CLAIM_PATH))
            .and(matchers::header("authorization", "Bearer authority-secret"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "status": "claimed",
                "replayed": false,
                "provider_allowed": true,
                "claim": claim_json()
            })))
            .mount(&server)
            .await;
        let client = AuthorityClaimClient::new_for_test(
            format!("{}/", server.uri()),
            SecretString::new("authority-secret"),
            Duration::from_secs(2),
        )
        .expect("authority test client");
        let outcome = client
            .claim(message_request())
            .await
            .expect("allowed claim");
        assert!(matches!(outcome, AuthorityClaimOutcome::Allowed { .. }));
    }

    #[tokio::test]
    async fn mismatched_claim_echo_is_uncertain() {
        let server = MockServer::start().await;
        let mut claim = claim_json();
        claim["account_id"] = Value::String("other-account".to_owned());
        Mock::given(matchers::method("POST"))
            .and(matchers::path(CLAIM_PATH))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "status": "claimed",
                "replayed": false,
                "provider_allowed": true,
                "claim": claim
            })))
            .mount(&server)
            .await;
        let client = AuthorityClaimClient::new_for_test(
            format!("{}/", server.uri()),
            SecretString::new("authority-secret"),
            Duration::from_secs(2),
        )
        .expect("authority test client");
        assert_eq!(
            client.claim(message_request()).await,
            Err(AuthorityClaimFailure::Uncertain)
        );
    }
}
