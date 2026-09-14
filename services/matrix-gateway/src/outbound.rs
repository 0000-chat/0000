//! Authenticated, encrypted Matrix text dispatch for the private gateway.
//!
//! The control-plane Worker owns account and grant authority. This module
//! owns the final Matrix room boundary: it accepts only an already-authorized
//! room binding, refuses unknown or unencrypted rooms, and sends with the
//! caller's durable transaction ID. It never falls back to plaintext.

use std::{collections::HashSet, fmt, time::Duration};

use async_trait::async_trait;
use chrono::{DateTime, Utc};
use matrix_sdk::{Client, config::RequestConfig, room::MessagesOptions};
use ruma::{
    OwnedEventId, OwnedTransactionId, OwnedUserId, RoomId, UserId,
    api::error::ErrorKind,
    events::room::{
        member::{MembershipState, RoomMemberEventContent},
        message::RoomMessageEventContent,
        name::RoomNameEventContent,
    },
    uint,
};
use serde_json::Value;
use tokio::time::timeout;

/// A content-free failure from the encrypted Matrix send boundary.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum OutboundSendFailure {
    /// The bound room is not present in the restored SDK state.
    RoomNotFound,
    /// The bound room did not prove encryption before the send.
    RoomNotEncrypted,
    /// The Matrix session was rejected by the homeserver.
    MatrixSessionExpired,
    /// The homeserver explicitly rate-limited the request.
    MatrixRateLimited,
    /// The homeserver explicitly rejected the request before accepting it.
    MatrixRejected,
    /// The SDK could not complete the Matrix request. The caller must treat
    /// this as uncertain because the homeserver may have accepted it.
    MatrixRequest,
}

impl OutboundSendFailure {
    pub const fn code(self) -> &'static str {
        match self {
            Self::RoomNotFound => "matrix_room_not_found",
            Self::RoomNotEncrypted => "matrix_room_not_encrypted",
            Self::MatrixSessionExpired => "matrix_session_expired",
            Self::MatrixRateLimited => "matrix_rate_limited",
            Self::MatrixRejected => "matrix_rejected",
            Self::MatrixRequest => "matrix_request_failed",
        }
    }
}

impl fmt::Display for OutboundSendFailure {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.code())
    }
}

impl std::error::Error for OutboundSendFailure {}

/// The Matrix evidence returned after the homeserver accepts the event.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MatrixSendResult {
    pub event_id: OwnedEventId,
}

/// The only provider-facing operation exposed to the private gateway route.
#[async_trait]
pub trait OutboundTextSender: Send + Sync {
    async fn send_encrypted_text(
        &self,
        room_id: &str,
        transaction_id: &str,
        body: &str,
    ) -> Result<MatrixSendResult, OutboundSendFailure>;
}

/// A supported Matrix event which the pinned WhatsApp bridge translates into
/// a provider group operation. The gateway deliberately exposes Matrix room
/// events here instead of inventing a bridge HTTP management endpoint.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum MatrixGroupAction {
    Rename,
    AddParticipants,
    RemoveParticipants,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MatrixGroupChange {
    pub room_id: String,
    pub provider_group_id: String,
    pub operation_id: String,
    pub operation_started_at: String,
    pub action: MatrixGroupAction,
    pub name: Option<String>,
    pub participant_provider_ids: Vec<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MatrixGroupObservationRequest {
    pub room_id: String,
    pub provider_group_id: String,
    pub operation_id: String,
    pub operation_started_at: String,
    pub action: MatrixGroupAction,
    pub name: Option<String>,
    pub participant_provider_ids: Vec<String>,
    pub source_event_ids: Vec<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MatrixGroupObservation {
    pub provider_group_id: String,
    pub matrix_room_id: String,
    pub name: String,
    pub revision: String,
    pub member_provider_ids: Vec<String>,
    pub evidence_id: String,
    pub observed_at: String,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum MatrixGroupFailure {
    RoomNotFound,
    MatrixRequest,
    Uncertain,
    MalformedObservation,
}

impl MatrixGroupFailure {
    pub const fn code(self) -> &'static str {
        match self {
            Self::RoomNotFound => "matrix_room_not_found",
            Self::MatrixRequest => "matrix_group_request_failed",
            Self::Uncertain => "matrix_group_observation_uncertain",
            Self::MalformedObservation => "matrix_group_observation_invalid",
        }
    }
}

/// Matrix-side group management boundary. Implementations must send only
/// supported Matrix room events and may return success only after a bridge
/// authored state observation proves the resulting provider snapshot.
#[async_trait]
pub trait MatrixGroupManager: Send + Sync {
    async fn apply_group_change(
        &self,
        change: MatrixGroupChange,
    ) -> Result<MatrixGroupObservation, MatrixGroupFailure>;

    async fn observe_group(
        &self,
        request: MatrixGroupObservationRequest,
    ) -> Result<Option<MatrixGroupObservation>, MatrixGroupFailure>;
}

/// Production sender backed by the one restored Matrix SDK client.
#[derive(Clone)]
pub struct MatrixSdkTextSender {
    client: Client,
    request_timeout: Duration,
}

impl fmt::Debug for MatrixSdkTextSender {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("MatrixSdkTextSender([REDACTED])")
    }
}

impl MatrixSdkTextSender {
    pub fn new(client: Client, request_timeout: Duration) -> Self {
        Self {
            client,
            request_timeout,
        }
    }
}

fn classify_matrix_error(error: &matrix_sdk::Error) -> OutboundSendFailure {
    let Some(api_error) = error.as_client_api_error() else {
        return OutboundSendFailure::MatrixRequest;
    };
    let status = api_error.status_code.as_u16();
    let expired_token = api_error
        .error_kind()
        .is_some_and(|kind| matches!(kind, ErrorKind::UnknownToken(_) | ErrorKind::MissingToken));

    match status {
        401 => OutboundSendFailure::MatrixSessionExpired,
        429 => OutboundSendFailure::MatrixRateLimited,
        _ if expired_token => OutboundSendFailure::MatrixSessionExpired,
        400..=499 if status != 408 => OutboundSendFailure::MatrixRejected,
        _ => OutboundSendFailure::MatrixRequest,
    }
}

#[async_trait]
impl OutboundTextSender for MatrixSdkTextSender {
    async fn send_encrypted_text(
        &self,
        room_id: &str,
        transaction_id: &str,
        body: &str,
    ) -> Result<MatrixSendResult, OutboundSendFailure> {
        let room_id = RoomId::parse(room_id).map_err(|_| OutboundSendFailure::RoomNotFound)?;
        let room = self
            .client
            .get_room(&room_id)
            .ok_or(OutboundSendFailure::RoomNotFound)?;

        // `Room::send` intentionally falls back to plaintext when the room is
        // not encrypted. Establish the state explicitly before calling it so
        // an unknown/not-encrypted room is a hard failure with no plaintext
        // request emitted.
        let encryption_state = room
            .latest_encryption_state()
            .await
            .map_err(|error| classify_matrix_error(&error))?;
        if !encryption_state.is_encrypted() {
            return Err(OutboundSendFailure::RoomNotEncrypted);
        }

        let transaction_id: OwnedTransactionId = transaction_id.to_owned().into();
        let result = room
            .send(RoomMessageEventContent::text_plain(body))
            .with_transaction_id(transaction_id)
            .with_request_config(
                RequestConfig::default()
                    .disable_retry()
                    .timeout(Some(self.request_timeout)),
            )
            .await
            .map_err(|error| classify_matrix_error(&error))?;
        Ok(MatrixSendResult {
            event_id: result.response.event_id,
        })
    }
}

/// Production Matrix event transport for the pinned mautrix-whatsapp bridge.
/// Rename is sent as `m.room.name`; add/remove use Matrix membership APIs,
/// which the bridge maps to `SetGroupName` and `UpdateGroupParticipants`.
#[derive(Clone)]
pub struct MatrixSdkGroupManager {
    client: Client,
    request_timeout: Duration,
}

impl fmt::Debug for MatrixSdkGroupManager {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("MatrixSdkGroupManager([REDACTED])")
    }
}

impl MatrixSdkGroupManager {
    pub fn new(client: Client, request_timeout: Duration) -> Self {
        Self {
            client,
            request_timeout,
        }
    }

    fn room(&self, room_id: &str) -> Result<matrix_sdk::Room, MatrixGroupFailure> {
        let room_id = RoomId::parse(room_id).map_err(|_| MatrixGroupFailure::RoomNotFound)?;
        self.client
            .get_room(&room_id)
            .ok_or(MatrixGroupFailure::RoomNotFound)
    }

    fn provider_user_id(&self, provider_id: &str) -> Result<OwnedUserId, MatrixGroupFailure> {
        if provider_id.is_empty()
            || provider_id.len() > 512
            || provider_id.chars().any(char::is_whitespace)
        {
            return Err(MatrixGroupFailure::MalformedObservation);
        }
        let domain = self
            .client
            .user_id()
            .ok_or(MatrixGroupFailure::MatrixRequest)?
            .server_name()
            .as_str();
        // mautrix-whatsapp's generated appservice registration uses the
        // bridge network prefix `whatsapp_`; the provider ID itself is the
        // localpart, including the pinned `lid-` form for LID users.
        UserId::parse(format!("@whatsapp_{provider_id}:{domain}"))
            .map_err(|_| MatrixGroupFailure::MalformedObservation)
    }

    fn own_user_id(&self) -> Result<OwnedUserId, MatrixGroupFailure> {
        self.client
            .user_id()
            .ok_or(MatrixGroupFailure::MatrixRequest)
            .map(ToOwned::to_owned)
    }

    fn bridge_bot_id(&self) -> Result<OwnedUserId, MatrixGroupFailure> {
        let domain = self.own_user_id()?.server_name().as_str().to_owned();
        UserId::parse(format!("@whatsappbot:{domain}"))
            .map_err(|_| MatrixGroupFailure::MalformedObservation)
    }

    fn operation_started_at(value: &str) -> Result<u64, MatrixGroupFailure> {
        let timestamp = DateTime::parse_from_rfc3339(value)
            .map_err(|_| MatrixGroupFailure::MalformedObservation)?
            .timestamp_millis();
        u64::try_from(timestamp).map_err(|_| MatrixGroupFailure::MalformedObservation)
    }

    fn valid_provider_id(value: &str) -> bool {
        !value.is_empty() && value.len() <= 512 && !value.chars().any(char::is_whitespace)
    }

    fn bridge_provider_id(&self, user_id: &UserId) -> Result<Option<String>, MatrixGroupFailure> {
        let own_user = self.own_user_id()?;
        if user_id.server_name() != own_user.server_name() {
            return Ok(None);
        }
        let Some(provider_id) = user_id.localpart().strip_prefix("whatsapp_") else {
            return Ok(None);
        };
        if !Self::valid_provider_id(provider_id) {
            return Err(MatrixGroupFailure::MalformedObservation);
        }
        Ok(Some(provider_id.to_owned()))
    }

    fn is_own_event(&self, user_id: &UserId) -> Result<bool, MatrixGroupFailure> {
        let own_user = self.own_user_id()?;
        Ok(user_id == &*own_user)
    }

    async fn observe_room(
        &self,
        room: &matrix_sdk::Room,
        request: &MatrixGroupObservationRequest,
    ) -> Result<Option<MatrixGroupObservation>, MatrixGroupFailure> {
        let started_at = Self::operation_started_at(&request.operation_started_at)?;
        let bridge_bot = self.bridge_bot_id()?;
        let mut required_source_event_ids: HashSet<String> =
            request.source_event_ids.iter().cloned().collect();
        let name_raw = room
            .get_state_event_static::<RoomNameEventContent>()
            .await
            .map_err(|_| MatrixGroupFailure::MatrixRequest)?;
        let Some(name_raw) = name_raw else {
            return Ok(None);
        };
        let name_event = name_raw
            .deserialize()
            .map_err(|_| MatrixGroupFailure::MalformedObservation)?;
        let Some(name) = (match &name_event {
            matrix_sdk::deserialized_responses::SyncOrStrippedState::Sync(event) => event
                .as_original()
                .map(|original| original.content.name.clone()),
            matrix_sdk::deserialized_responses::SyncOrStrippedState::Stripped(_) => None,
        }) else {
            return Err(MatrixGroupFailure::MalformedObservation);
        };
        let name = name.trim();
        if name.is_empty() || name.len() > 100 {
            return Err(MatrixGroupFailure::MalformedObservation);
        }
        if request.action == MatrixGroupAction::Rename {
            if request.name.as_deref() != Some(name) {
                return Ok(None);
            }
            if self.is_own_event(name_event.sender())?
                && name_event
                    .origin_server_ts()
                    .map(|timestamp| timestamp.get().into())
                    .is_some_and(|timestamp: u64| timestamp >= started_at)
            {
                if let Some(event_id) = name_event.event_id() {
                    if required_source_event_ids.is_empty() {
                        required_source_event_ids.insert(event_id.to_string());
                    }
                }
            }
        }

        let member_events = room
            .get_state_events_static::<RoomMemberEventContent>()
            .await
            .map_err(|_| MatrixGroupFailure::MatrixRequest)?;
        let mut member_provider_ids = Vec::new();
        let mut fresh_member_provider_ids = HashSet::new();
        for raw in member_events {
            let event = raw
                .deserialize()
                .map_err(|_| MatrixGroupFailure::MalformedObservation)?;
            let user_id = event.user_id();
            let Some(provider_id) = self.bridge_provider_id(user_id)? else {
                continue;
            };
            if event.membership() == &MembershipState::Join {
                member_provider_ids.push(provider_id.clone());
            }
            if self.is_own_event(event.sender())?
                && event
                    .origin_server_ts()
                    .map(|timestamp| timestamp.get().into())
                    .is_some_and(|timestamp: u64| timestamp >= started_at)
            {
                if request
                    .participant_provider_ids
                    .iter()
                    .any(|requested| requested == &provider_id)
                {
                    if let Some(event_id) = event.event_id().map(|event_id| event_id.to_string()) {
                        required_source_event_ids.insert(event_id);
                    }
                    fresh_member_provider_ids.insert(provider_id);
                }
            }
        }

        let status = self
            .observe_bridge_status(room, &bridge_bot, &required_source_event_ids, started_at)
            .await?;
        let Some((status_event_id, status_timestamp)) = status else {
            return Ok(None);
        };

        match request.action {
            MatrixGroupAction::Rename => {
                if required_source_event_ids.is_empty() {
                    return Ok(None);
                }
            }
            MatrixGroupAction::AddParticipants => {
                if request.participant_provider_ids.iter().any(|provider_id| {
                    !member_provider_ids
                        .iter()
                        .any(|member| member == provider_id)
                }) {
                    return Ok(None);
                }
                if request
                    .participant_provider_ids
                    .iter()
                    .any(|provider_id| !fresh_member_provider_ids.contains(provider_id))
                {
                    return Ok(None);
                }
            }
            MatrixGroupAction::RemoveParticipants => {
                if request.participant_provider_ids.iter().any(|provider_id| {
                    member_provider_ids
                        .iter()
                        .any(|member| member == provider_id)
                }) {
                    return Ok(None);
                }
            }
        }

        member_provider_ids.sort_unstable();
        member_provider_ids.dedup();
        if member_provider_ids.len() > 128 {
            return Err(MatrixGroupFailure::MalformedObservation);
        }
        Ok(Some(MatrixGroupObservation {
            provider_group_id: request.provider_group_id.to_owned(),
            matrix_room_id: room.room_id().to_string(),
            name: name.to_owned(),
            revision: status_timestamp.to_string(),
            member_provider_ids,
            evidence_id: status_event_id,
            observed_at: Utc::now().to_rfc3339(),
        }))
    }

    async fn observe_bridge_status(
        &self,
        room: &matrix_sdk::Room,
        bridge_bot: &UserId,
        required_source_event_ids: &HashSet<String>,
        started_at: u64,
    ) -> Result<Option<(String, u64)>, MatrixGroupFailure> {
        if required_source_event_ids.is_empty() {
            return Ok(None);
        }
        let mut options = MessagesOptions::backward();
        options.limit = uint!(100);
        let messages = timeout(self.request_timeout, room.messages(options))
            .await
            .map_err(|_| MatrixGroupFailure::MatrixRequest)?
            .map_err(|_| MatrixGroupFailure::MatrixRequest)?;
        let mut statuses = Vec::new();
        for event in messages.chunk {
            if event.kind.event_type().as_deref() != Some("com.beeper.message_send_status")
                || event.sender().as_deref() != Some(bridge_bot)
            {
                continue;
            }
            let timestamp = event
                .timestamp()
                .map(|value| value.get().into())
                .ok_or(MatrixGroupFailure::MalformedObservation)?;
            if timestamp < started_at {
                continue;
            }
            let content: Value = event
                .raw()
                .get_field("content")
                .map_err(|_| MatrixGroupFailure::MalformedObservation)?
                .ok_or(MatrixGroupFailure::MalformedObservation)?;
            if content.get("status").and_then(Value::as_str) != Some("success") {
                continue;
            }
            let source_event_id = content
                .get("m.relates_to")
                .and_then(|value| value.get("event_id"))
                .and_then(Value::as_str)
                .ok_or(MatrixGroupFailure::MalformedObservation)?;
            if !required_source_event_ids.contains(source_event_id) {
                continue;
            }
            let Some(event_id) = event.event_id() else {
                return Err(MatrixGroupFailure::MalformedObservation);
            };
            statuses.push((source_event_id.to_owned(), event_id.to_string(), timestamp));
        }
        Ok(correlate_bridge_success(
            required_source_event_ids,
            statuses,
        ))
    }
}

fn correlate_bridge_success(
    required_source_event_ids: &HashSet<String>,
    statuses: impl IntoIterator<Item = (String, String, u64)>,
) -> Option<(String, u64)> {
    if required_source_event_ids.is_empty() {
        return None;
    }
    let mut successful_source_event_ids = HashSet::new();
    let mut newest: Option<(String, u64)> = None;
    for (source_event_id, status_event_id, timestamp) in statuses {
        if !required_source_event_ids.contains(&source_event_id) {
            continue;
        }
        successful_source_event_ids.insert(source_event_id);
        if newest
            .as_ref()
            .is_none_or(|(_, current)| timestamp > *current)
        {
            newest = Some((status_event_id, timestamp));
        }
    }
    (successful_source_event_ids.len() == required_source_event_ids.len()).then_some(newest?)
}

#[async_trait]
impl MatrixGroupManager for MatrixSdkGroupManager {
    async fn apply_group_change(
        &self,
        change: MatrixGroupChange,
    ) -> Result<MatrixGroupObservation, MatrixGroupFailure> {
        let room = self.room(&change.room_id)?;
        let mut source_event_ids = Vec::new();
        match change.action {
            MatrixGroupAction::Rename => {
                let name = change
                    .name
                    .clone()
                    .filter(|value| !value.trim().is_empty() && value.len() <= 100)
                    .ok_or(MatrixGroupFailure::MalformedObservation)?;
                let result = timeout(self.request_timeout, room.set_name(name))
                    .await
                    .map_err(|_| MatrixGroupFailure::MatrixRequest)?
                    .map_err(|_| MatrixGroupFailure::MatrixRequest)?;
                source_event_ids.push(result.event_id.to_string());
            }
            MatrixGroupAction::AddParticipants => {
                for provider_id in &change.participant_provider_ids {
                    let user_id = self.provider_user_id(&provider_id)?;
                    timeout(self.request_timeout, room.invite_user_by_id(&user_id))
                        .await
                        .map_err(|_| MatrixGroupFailure::MatrixRequest)?
                        .map_err(|_| MatrixGroupFailure::MatrixRequest)?;
                }
            }
            MatrixGroupAction::RemoveParticipants => {
                for provider_id in &change.participant_provider_ids {
                    let user_id = self.provider_user_id(&provider_id)?;
                    timeout(
                        self.request_timeout,
                        room.kick_user(&user_id, Some("communicator group management")),
                    )
                    .await
                    .map_err(|_| MatrixGroupFailure::MatrixRequest)?
                    .map_err(|_| MatrixGroupFailure::MatrixRequest)?;
                }
            }
        }
        self.observe_room(
            &room,
            &MatrixGroupObservationRequest {
                room_id: change.room_id,
                provider_group_id: change.provider_group_id,
                operation_id: change.operation_id,
                operation_started_at: change.operation_started_at,
                action: change.action,
                name: change.name,
                participant_provider_ids: change.participant_provider_ids,
                source_event_ids,
            },
        )
        .await?
        .ok_or(MatrixGroupFailure::Uncertain)
    }

    async fn observe_group(
        &self,
        request: MatrixGroupObservationRequest,
    ) -> Result<Option<MatrixGroupObservation>, MatrixGroupFailure> {
        let room = self.room(&request.room_id)?;
        self.observe_room(&room, &request).await
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashSet;

    use super::correlate_bridge_success;

    #[test]
    fn bridge_success_requires_every_submitted_target_and_ignores_unrelated_events() {
        let required = HashSet::from([
            "$member-a:example.test".to_owned(),
            "$member-b:example.test".to_owned(),
        ]);

        assert_eq!(
            correlate_bridge_success(
                &required,
                [
                    (
                        "$member-a:example.test".to_owned(),
                        "$status-a:example.test".to_owned(),
                        20,
                    ),
                    (
                        "$unrelated-c:example.test".to_owned(),
                        "$status-c:example.test".to_owned(),
                        30,
                    ),
                ],
            ),
            None,
        );
        assert_eq!(
            correlate_bridge_success(
                &required,
                [
                    (
                        "$member-a:example.test".to_owned(),
                        "$status-a:example.test".to_owned(),
                        20,
                    ),
                    (
                        "$member-b:example.test".to_owned(),
                        "$status-b:example.test".to_owned(),
                        21,
                    ),
                    (
                        "$unrelated-c:example.test".to_owned(),
                        "$status-c:example.test".to_owned(),
                        30,
                    ),
                ],
            ),
            Some(("$status-b:example.test".to_owned(), 21)),
        );
    }
}
