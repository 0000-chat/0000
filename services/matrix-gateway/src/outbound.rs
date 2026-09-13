//! Authenticated, encrypted Matrix text dispatch for the private gateway.
//!
//! The control-plane Worker owns account and grant authority. This module
//! owns the final Matrix room boundary: it accepts only an already-authorized
//! room binding, refuses unknown or unencrypted rooms, and sends with the
//! caller's durable transaction ID. It never falls back to plaintext.

use std::{fmt, time::Duration};

use async_trait::async_trait;
use matrix_sdk::{Client, config::RequestConfig};
use ruma::{
    OwnedEventId, OwnedTransactionId, RoomId, api::error::ErrorKind,
    events::room::message::RoomMessageEventContent,
};

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
