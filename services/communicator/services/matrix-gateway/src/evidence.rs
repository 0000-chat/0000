//! Read-only, exact-attempt observations of the pinned bridge's status events.
//! Source: mautrix-go v0.30.0 event/beeper.go and bridgev2/messagestatus.go.
//! The bridge reports delivery only for DMs (bridgev2/portal.go). Matrix
//! acceptance, an empty recipient list, and Matrix read receipts prove none.

use std::{sync::Arc, time::Duration};

use chrono::{TimeZone, Utc};
use matrix_sdk::Client;
use ruma::api::client::room::get_room_event::v3::Request;
use ruma::api::client::state::get_state_events::v3::Request as StateRequest;
use serde::Deserialize;
use serde_json::{Value, json};
use tokio::sync::Mutex;

use crate::{model::Provider, secret::SafeError, store::Store};

pub const EVIDENCE_CONFLICT: &str = "provider_evidence_conflict";
pub const EVIDENCE_UNSUPPORTED: &str = "provider_evidence_unsupported";
pub const EVIDENCE_UNAVAILABLE: &str = "provider_evidence_unavailable";

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EvidenceRequest {
    pub schema_version: u8,
    pub tenant_id: String,
    pub account_id: String,
    pub connection_id: String,
    pub identity_id: String,
    pub conversation_id: String,
    pub transaction_id: String,
    pub request_digest: String,
    pub projection_generation: u64,
    pub session_generation: String,
    pub observation_event_id: String,
}

/// Uses the same activated SDK as sending. No sync, receipts, or provider
/// operations occur; the only I/O is authenticated Matrix event/state GETs.
pub struct MatrixEvidenceReader {
    client: Client,
    timeout: Duration,
}

impl MatrixEvidenceReader {
    pub fn new(client: Client, timeout: Duration) -> Self {
        Self { client, timeout }
    }

    pub async fn observe(
        &self,
        store: &Arc<Mutex<Store>>,
        gateway_route_id: &str,
        owner: &str,
        request: EvidenceRequest,
    ) -> Result<Value, SafeError> {
        if request.schema_version != 1 {
            return Err(SafeError::new(EVIDENCE_CONFLICT));
        }
        let guard = store.lock().await;
        let context =
            guard.outbound_evidence_context(&request.tenant_id, &request.transaction_id)?;
        let binding = guard
            .active_room_binding_for_outbound(
                &request.tenant_id,
                &request.account_id,
                &request.connection_id,
                &request.identity_id,
                Provider::Whatsapp,
                &request.conversation_id,
            )?
            .ok_or_else(|| SafeError::new(EVIDENCE_CONFLICT))?;
        if context.account_id != request.account_id
            || context.connection_id != request.connection_id
            || context.identity_id != request.identity_id
            || context.conversation_id != request.conversation_id
            || context.request_digest != request.request_digest
            || context.session_generation != request.session_generation
            || context.projection_generation != request.projection_generation
            || binding.session_generation() != Some(request.session_generation.as_str())
            || binding.matrix_room_id() != context.matrix_room_id
            || binding.gateway_route_id() != gateway_route_id
            || binding.owner_matrix_user_id() != owner
        {
            return Err(SafeError::new(EVIDENCE_CONFLICT));
        }
        let room = ruma::RoomId::parse(&context.matrix_room_id)
            .map_err(|_| SafeError::new(EVIDENCE_CONFLICT))?;
        let event_id = ruma::EventId::parse(&request.observation_event_id)
            .map_err(|_| SafeError::new(EVIDENCE_CONFLICT))?;
        drop(guard);
        let response = tokio::time::timeout(
            self.timeout,
            self.client.send(Request::new(room.clone(), event_id)),
        )
        .await
        .map_err(|_| SafeError::new(EVIDENCE_UNAVAILABLE))?
        .map_err(|_| SafeError::new(EVIDENCE_UNAVAILABLE))?;
        let raw = response.event.json().get();
        if raw.len() > 64 * 1024 {
            return Err(SafeError::new(EVIDENCE_UNSUPPORTED));
        }
        let event: Value =
            serde_json::from_str(raw).map_err(|_| SafeError::new(EVIDENCE_UNSUPPORTED))?;
        if event["room_id"] != context.matrix_room_id {
            return Err(SafeError::new(EVIDENCE_CONFLICT));
        }
        let own = ruma::UserId::parse(owner).map_err(|_| SafeError::new(EVIDENCE_CONFLICT))?;
        let bot = format!("@whatsappbot:{}", own.server_name());
        let normalized = normalize_status(&event, &bot, &context.matrix_event_id, &request)?;
        if normalized["source"] == "provider" {
            // A singleton recipient is not itself evidence of a DM. Check the
            // bot-authored portal metadata and the source-backed default ghost
            // mapping. Unknown aliases/templates fail closed instead of guessing.
            let state =
                tokio::time::timeout(self.timeout, self.client.send(StateRequest::new(room)))
                    .await
                    .map_err(|_| SafeError::new(EVIDENCE_UNAVAILABLE))?
                    .map_err(|_| SafeError::new(EVIDENCE_UNAVAILABLE))?;
            let state_key = format!("{}/whatsapp", own.server_name());
            let mut portal = None;
            for raw in state.room_state {
                if raw.json().get().len() > 64 * 1024 {
                    return Err(SafeError::new(EVIDENCE_UNSUPPORTED));
                }
                let value: Value = serde_json::from_str(raw.json().get())
                    .map_err(|_| SafeError::new(EVIDENCE_UNSUPPORTED))?;
                if value["type"] == "m.bridge"
                    && value["state_key"] == state_key
                    && portal.replace(value).is_some()
                {
                    return Err(SafeError::new(EVIDENCE_UNSUPPORTED));
                }
            }
            let portal = portal.ok_or_else(|| SafeError::new(EVIDENCE_UNSUPPORTED))?;
            let content = &portal["content"];
            let channel = content["channel"]["id"].as_str().unwrap_or_default();
            let (user, prefix) = if let Some(user) = channel.strip_suffix("@s.whatsapp.net") {
                (user, "")
            } else if let Some(user) = channel.strip_suffix("@lid") {
                (user, "lid-")
            } else {
                return Err(SafeError::new(EVIDENCE_UNSUPPORTED));
            };
            if portal["sender"] != bot
                || content["bridgebot"] != bot
                || content["protocol"]["id"] != "whatsapp"
                || content["com.beeper.room_type.v2"] != "dm"
                || user.is_empty()
                || !user.bytes().all(|byte| byte.is_ascii_digit())
                || event["content"]["delivered_to_users"][0]
                    != format!("@whatsapp_{prefix}{user}:{}", own.server_name())
            {
                return Err(SafeError::new(EVIDENCE_UNSUPPORTED));
            }
        }
        // A rotation/removal while the GET was in flight must not update the
        // previous account/session's attempt.
        let guard = store.lock().await;
        let current = guard
            .active_room_binding_for_outbound(
                &request.tenant_id,
                &request.account_id,
                &request.connection_id,
                &request.identity_id,
                Provider::Whatsapp,
                &request.conversation_id,
            )?
            .ok_or_else(|| SafeError::new(EVIDENCE_CONFLICT))?;
        if current.session_generation() != binding.session_generation()
            || current.matrix_room_id() != binding.matrix_room_id()
            || current.gateway_route_id() != binding.gateway_route_id()
            || current.owner_matrix_user_id() != binding.owner_matrix_user_id()
        {
            return Err(SafeError::new(EVIDENCE_CONFLICT));
        }
        Ok(normalized)
    }
}

fn normalize_status(
    event: &Value,
    bot: &str,
    target: &str,
    request: &EvidenceRequest,
) -> Result<Value, SafeError> {
    if event["type"] != "com.beeper.message_send_status" {
        return Err(SafeError::new(EVIDENCE_UNSUPPORTED));
    }
    if event["sender"] != bot
        || event["event_id"] != request.observation_event_id
        || event["content"]["m.relates_to"]["rel_type"] != "m.reference"
        || event["content"]["m.relates_to"]["event_id"] != target
    {
        return Err(SafeError::new(EVIDENCE_CONFLICT));
    }
    // Some delivery updates omit the transaction ID, but must still refer to
    // the exact homeserver event sealed in this transaction's journal.
    if let Some(txn) = event["content"].get("relates_to_txn_id")
        && txn != ""
        && txn != &request.transaction_id
    {
        return Err(SafeError::new(EVIDENCE_CONFLICT));
    }
    let timestamp = event["origin_server_ts"]
        .as_i64()
        .and_then(|value| Utc.timestamp_millis_opt(value).single())
        .ok_or_else(|| SafeError::new(EVIDENCE_UNSUPPORTED))?;
    let (source, status, reason) = match event["content"]["status"].as_str() {
        Some("SUCCESS") => {
            let delivered = match event["content"].get("delivered_to_users") {
                None | Some(Value::Null) => false,
                Some(Value::Array(users)) if users.len() <= 1 => {
                    if users.iter().any(|user| {
                        user.as_str()
                            .is_none_or(|s| ruma::UserId::parse(s).is_err())
                    }) {
                        return Err(SafeError::new(EVIDENCE_UNSUPPORTED));
                    }
                    !users.is_empty()
                }
                _ => return Err(SafeError::new(EVIDENCE_UNSUPPORTED)),
            };
            if delivered {
                ("provider", "delivered", "bridge_reported_dm_delivery")
            } else {
                ("bridge", "accepted", "bridge_reported_success")
            }
        }
        Some("PENDING") => ("bridge", "uncertain", "bridge_pending"),
        Some("FAIL_RETRIABLE") => ("bridge", "uncertain", "bridge_fail_retriable"),
        Some("FAIL_PERMANENT") => ("bridge", "uncertain", "bridge_fail_permanent"),
        _ => return Err(SafeError::new(EVIDENCE_UNSUPPORTED)),
    };
    // Never copy error/message/internal_error, recipients, or provider content.
    Ok(json!({
        "schema_version": 1,
        "tenant_id": request.tenant_id,
        "account_id": request.account_id,
        "connection_id": request.connection_id,
        "session_generation": request.session_generation,
        "conversation_id": request.conversation_id,
        "transaction_id": request.transaction_id,
        "request_digest": request.request_digest,
        "projection_generation": request.projection_generation,
        "evidence_id": request.observation_event_id,
        "source": source, "status": status, "reason": reason,
        "observed_at": timestamp.to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        "remote_echo_id": target,
        "provider_read": "unsupported",
    }))
}
