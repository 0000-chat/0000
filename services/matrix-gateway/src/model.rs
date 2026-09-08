//! Matrix-neutral gateway models and canonical event payload types.

use std::{cmp::Ordering, error::Error, fmt, str::FromStr};

use serde::{
    Deserialize, Deserializer, Serialize, Serializer,
    de::Error as _,
    ser::{Error as _, SerializeStruct},
};
use sha2::{Digest, Sha256};

const MODEL_EMPTY_TUPLE_FIELD: &str = "model_empty_tuple_field";
const MODEL_TUPLE_TOO_LARGE: &str = "model_tuple_too_large";
const MODEL_UNKNOWN_EVENT_TYPE: &str = "model_unknown_event_type";
const MODEL_UNKNOWN_EVENT_SOURCE: &str = "model_unknown_event_source";
const MODEL_INVALID_RECEIPT_TYPE: &str = "model_invalid_receipt_type";
const MODEL_INVALID_TYPING_TRANSITION: &str = "model_invalid_typing_transition";
const MODEL_ORDINAL_OVERFLOW: &str = "model_ordinal_overflow";
const MODEL_UNKNOWN_PROVIDER: &str = "model_unknown_provider";
const MODEL_UNKNOWN_DIRECTION: &str = "model_unknown_direction";
const MODEL_UNKNOWN_DELIVERY_STATUS: &str = "model_unknown_delivery_status";
const MODEL_UNKNOWN_DELIVERY_MODE: &str = "model_unknown_delivery_mode";
const MODEL_UNKNOWN_COMMAND_STATUS: &str = "model_unknown_command_status";
const MODEL_UNKNOWN_RESOURCE_TYPE: &str = "model_unknown_resource_type";
const MODEL_CANONICAL_INVALID: &str = "model_canonical_invalid";
const MODEL_CANONICAL_SCHEMA: &str = "model_canonical_schema";
const MODEL_CANONICAL_ID: &str = "model_canonical_id";
const MODEL_CANONICAL_PAYLOAD: &str = "model_canonical_payload";
const MODEL_CANONICAL_TOO_LARGE: &str = "model_canonical_too_large";

/// Canonical schema version shared with the TypeScript projection contract.
pub const CANONICAL_SCHEMA_VERSION: u8 = 1;
/// Maximum serialized size of one canonical event envelope.
pub const MAX_EVENT_CANONICAL_BYTES: usize = 1024 * 1024;
/// Maximum safe integer representable by ECMAScript JSON numbers.
const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

macro_rules! string_enum {
    (
        $(#[$meta:meta])*
        $name:ident, $unknown_code:expr,
        [$(($variant:ident, $value:literal)),+ $(,)?]
    ) => {
        $(#[$meta])*
        #[derive(Clone, Copy, Eq, PartialEq, Hash)]
        pub enum $name {
            $($variant),+
        }

        impl $name {
            /// The exact wire representation of this value.
            pub const fn as_str(self) -> &'static str {
                match self {
                    $(Self::$variant => $value),+
                }
            }

            /// All values in their locked wire order.
            pub const ALL: &'static [Self] = &[$(Self::$variant),+];

            /// All exact wire strings in their locked order.
            pub const VALUES: &'static [&'static str] = &[$($value),+];
        }

        impl fmt::Debug for $name {
            fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
                formatter.write_str(self.as_str())
            }
        }

        impl fmt::Display for $name {
            fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
                formatter.write_str(self.as_str())
            }
        }

        impl FromStr for $name {
            type Err = ModelError;

            fn from_str(value: &str) -> Result<Self, Self::Err> {
                match value {
                    $($value => Ok(Self::$variant),)+
                    _ => Err(ModelError::new($unknown_code)),
                }
            }
        }

        impl TryFrom<&str> for $name {
            type Error = ModelError;

            fn try_from(value: &str) -> Result<Self, Self::Error> {
                value.parse()
            }
        }

        impl Serialize for $name {
            fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
            where
                S: Serializer,
            {
                serializer.serialize_str(self.as_str())
            }
        }

        impl<'de> Deserialize<'de> for $name {
            fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
            where
                D: Deserializer<'de>,
            {
                let value = <String as Deserialize>::deserialize(deserializer)
                    .map_err(|_| D::Error::custom("invalid canonical enum"))?;
                value
                    .parse()
                    .map_err(|_| D::Error::custom("invalid canonical enum"))
            }
        }
    };
}

string_enum! {
    /// The exact canonical event types supported by the projection contract.
    CanonicalEventType, MODEL_UNKNOWN_EVENT_TYPE,
    [
        (MessageCreated, "message.created"),
        (MessageEdited, "message.edited"),
        (MessageDeleted, "message.deleted"),
        (ReactionAdded, "reaction.added"),
        (ReactionRemoved, "reaction.removed"),
        (ReceiptRead, "receipt.read"),
        (ReceiptDelivered, "receipt.delivered"),
        (TypingStarted, "typing.started"),
        (TypingStopped, "typing.stopped"),
        (AttachmentObserved, "attachment.observed"),
        (ConversationUpdated, "conversation.updated"),
        (ParticipantUpdated, "participant.updated"),
        (CommandUpdated, "command.updated"),
        (BridgeDeliveryUpdated, "bridge.delivery.updated"),
        (ReplayTombstone, "replay.tombstone"),
        (CorrectionApplied, "correction.applied"),
        (DeletionTombstone, "deletion.tombstone"),
    ]
}

string_enum! {
    /// Providers accepted by the connection contract.
    Provider, MODEL_UNKNOWN_PROVIDER,
    [
        (Whatsapp, "whatsapp"),
        (Telegram, "telegram"),
        (Messenger, "messenger"),
        (Linkedin, "linkedin"),
    ]
}

string_enum! {
    /// Message direction in a projection payload.
    Direction, MODEL_UNKNOWN_DIRECTION,
    [(Inbound, "inbound"), (Outbound, "outbound")]
}

string_enum! {
    /// Delivery states accepted by message and bridge payloads.
    DeliveryStatus, MODEL_UNKNOWN_DELIVERY_STATUS,
    [
        (Unknown, "unknown"),
        (Accepted, "accepted"),
        (Sent, "sent"),
        (Delivered, "delivered"),
        (Read, "read"),
        (Failed, "failed"),
    ]
}

string_enum! {
    /// Delivery modes accepted by command payloads.
    DeliveryMode, MODEL_UNKNOWN_DELIVERY_MODE,
    [(Direct, "direct"), (Paced, "paced")]
}

string_enum! {
    /// Command lifecycle states accepted by command payloads.
    CommandStatus, MODEL_UNKNOWN_COMMAND_STATUS,
    [
        (Accepted, "accepted"),
        (Scheduled, "scheduled"),
        (Reading, "reading"),
        (Typing, "typing"),
        (SubmittedToMatrix, "submitted_to_matrix"),
        (MatrixConfirmed, "matrix_confirmed"),
        (Bridged, "bridged"),
        (Delivered, "delivered"),
        (Cancelled, "cancelled"),
        (Unsupported, "unsupported"),
        (Failed, "failed"),
    ]
}

string_enum! {
    /// Resource kinds accepted by deletion tombstones.
    ResourceType, MODEL_UNKNOWN_RESOURCE_TYPE,
    [
        (Message, "message"),
        (Conversation, "conversation"),
        (Participant, "participant"),
        (Attachment, "attachment"),
    ]
}

string_enum! {
    /// The exact canonical event sources supported by the projection contract.
    CanonicalEventSource, MODEL_UNKNOWN_EVENT_SOURCE,
    [
        (Live, "live"),
        (Backfill, "backfill"),
        (CommandResult, "command_result"),
        (Replay, "replay"),
        (Correction, "correction"),
        (Deletion, "deletion"),
    ]
}

/// A value-free error returned when a deterministic model input is invalid.
///
/// The error deliberately contains only a stable code.  It never retains a
/// room, event, account, participant, or other protected identifier.
#[derive(Clone, Copy, Eq, PartialEq)]
pub struct ModelError {
    code: &'static str,
}

impl ModelError {
    const fn new(code: &'static str) -> Self {
        Self { code }
    }

    /// Return the stable machine-readable error code.
    pub const fn code(self) -> &'static str {
        self.code
    }
}

impl fmt::Debug for ModelError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ModelError")
            .field("code", &self.code)
            .finish()
    }
}

impl fmt::Display for ModelError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.code)
    }
}

impl Error for ModelError {}

macro_rules! redacted_debug {
    ($name:ty, $label:literal) => {
        impl fmt::Debug for $name {
            fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
                formatter.write_str(concat!($label, "([REDACTED])"))
            }
        }
    };
}

fn deserialize_required_option<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::<T>::deserialize(deserializer)
        .map_err(|_| D::Error::custom("invalid nullable canonical field"))
}

fn deserialize_trimmed_opaque<'de, D>(deserializer: D) -> Result<String, D::Error>
where
    D: Deserializer<'de>,
{
    let value = String::deserialize(deserializer)
        .map_err(|_| D::Error::custom("invalid opaque event ID"))?;
    let normalized = js_trim(&value);
    if !valid_opaque(normalized, 1024) {
        return Err(D::Error::custom("invalid opaque event ID"));
    }
    Ok(normalized.to_owned())
}

/// The message-created projection payload.
#[derive(Clone, Eq, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MessageCreatedPayload {
    pub message_id: String,
    pub direction: Direction,
    #[serde(deserialize_with = "deserialize_required_option")]
    pub sender_participant_id: Option<String>,
    pub sender_label: String,
    pub body: String,
    #[serde(deserialize_with = "deserialize_required_option")]
    pub reply_to_message_id: Option<String>,
    pub delivery_status: DeliveryStatus,
    pub unread: bool,
}
redacted_debug!(MessageCreatedPayload, "MessageCreatedPayload");

/// The message-edited projection payload.
#[derive(Clone, Eq, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MessageEditedPayload {
    pub message_id: String,
    pub body: String,
    #[serde(deserialize_with = "deserialize_required_option")]
    pub editor_participant_id: Option<String>,
}
redacted_debug!(MessageEditedPayload, "MessageEditedPayload");

/// The message-deleted projection payload.
#[derive(Clone, Eq, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MessageDeletedPayload {
    pub message_id: String,
    #[serde(deserialize_with = "deserialize_required_option")]
    pub reason_code: Option<String>,
}
redacted_debug!(MessageDeletedPayload, "MessageDeletedPayload");

/// The reaction-added projection payload.
#[derive(Clone, Eq, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ReactionAddedPayload {
    pub reaction_id: String,
    pub message_id: String,
    pub participant_id: String,
    pub emoji: String,
}
redacted_debug!(ReactionAddedPayload, "ReactionAddedPayload");

/// The reaction-removed projection payload.
#[derive(Clone, Eq, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ReactionRemovedPayload {
    pub reaction_id: String,
    pub message_id: String,
}
redacted_debug!(ReactionRemovedPayload, "ReactionRemovedPayload");

/// The read/delivery receipt projection payload.
#[derive(Clone, Eq, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ReceiptPayload {
    pub message_id: String,
    pub participant_id: String,
    pub local_identity: bool,
}
redacted_debug!(ReceiptPayload, "ReceiptPayload");

/// The typing-started projection payload.
#[derive(Clone, Eq, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TypingStartedPayload {
    pub participant_id: String,
    pub expires_at: String,
}
redacted_debug!(TypingStartedPayload, "TypingStartedPayload");

/// The typing-stopped projection payload.
#[derive(Clone, Eq, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TypingStoppedPayload {
    pub participant_id: String,
}
redacted_debug!(TypingStoppedPayload, "TypingStoppedPayload");

/// The attachment-observed projection payload.
#[derive(Clone, Eq, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AttachmentObservedPayload {
    pub attachment_id: String,
    pub message_id: String,
    #[serde(deserialize_with = "deserialize_required_option")]
    pub file_name: Option<String>,
    #[serde(deserialize_with = "deserialize_required_option")]
    pub mime_type: Option<String>,
    #[serde(deserialize_with = "deserialize_required_option")]
    pub size_bytes: Option<u64>,
    #[serde(deserialize_with = "deserialize_required_option")]
    pub sha256: Option<String>,
    #[serde(deserialize_with = "deserialize_required_option")]
    pub r2_key: Option<String>,
}
redacted_debug!(AttachmentObservedPayload, "AttachmentObservedPayload");

/// The conversation-updated projection payload.
#[derive(Clone, Eq, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ConversationUpdatedPayload {
    pub title: String,
    pub archived: bool,
    pub muted: bool,
}
redacted_debug!(ConversationUpdatedPayload, "ConversationUpdatedPayload");

/// The participant-updated projection payload.
#[derive(Clone, Eq, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ParticipantUpdatedPayload {
    pub participant_id: String,
    pub display_name: String,
    #[serde(deserialize_with = "deserialize_required_option")]
    pub remote_id: Option<String>,
    #[serde(deserialize_with = "deserialize_required_option")]
    pub avatar_url: Option<String>,
}
redacted_debug!(ParticipantUpdatedPayload, "ParticipantUpdatedPayload");

/// The command-updated projection payload.
#[derive(Clone, Eq, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CommandUpdatedPayload {
    pub command_id: String,
    pub operation: String,
    pub delivery_mode: DeliveryMode,
    pub status: CommandStatus,
    #[serde(deserialize_with = "deserialize_required_option")]
    pub failure_code: Option<String>,
}
redacted_debug!(CommandUpdatedPayload, "CommandUpdatedPayload");

/// The bridge-delivery-updated projection payload.
#[derive(Clone, Eq, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BridgeDeliveryUpdatedPayload {
    pub message_id: String,
    pub delivery_status: DeliveryStatus,
    #[serde(deserialize_with = "deserialize_required_option")]
    pub failure_code: Option<String>,
}
redacted_debug!(BridgeDeliveryUpdatedPayload, "BridgeDeliveryUpdatedPayload");

/// The replay/correction marker payload.
#[derive(Clone, Eq, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EventMarkerPayload {
    #[serde(deserialize_with = "deserialize_trimmed_opaque")]
    pub target_event_id: String,
    pub reason_code: String,
}
redacted_debug!(EventMarkerPayload, "EventMarkerPayload");

/// The deletion-tombstone projection payload.
#[derive(Clone, Eq, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DeletionTombstonePayload {
    pub resource_type: ResourceType,
    pub resource_id: String,
    pub reason_code: String,
}
redacted_debug!(DeletionTombstonePayload, "DeletionTombstonePayload");

/// The one-of projection payload selected by the event type.
#[derive(Clone, Eq, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum CanonicalPayload {
    MessageCreated(MessageCreatedPayload),
    MessageEdited(MessageEditedPayload),
    MessageDeleted(MessageDeletedPayload),
    ReactionAdded(ReactionAddedPayload),
    ReactionRemoved(ReactionRemovedPayload),
    ReceiptRead(ReceiptPayload),
    ReceiptDelivered(ReceiptPayload),
    TypingStarted(TypingStartedPayload),
    TypingStopped(TypingStoppedPayload),
    AttachmentObserved(AttachmentObservedPayload),
    ConversationUpdated(ConversationUpdatedPayload),
    ParticipantUpdated(ParticipantUpdatedPayload),
    CommandUpdated(CommandUpdatedPayload),
    BridgeDeliveryUpdated(BridgeDeliveryUpdatedPayload),
    ReplayTombstone(EventMarkerPayload),
    CorrectionApplied(EventMarkerPayload),
    DeletionTombstone(DeletionTombstonePayload),
}

impl fmt::Debug for CanonicalPayload {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("CanonicalPayload([REDACTED])")
    }
}

impl CanonicalPayload {
    /// Return the event type represented by this payload variant.
    pub const fn event_type(&self) -> CanonicalEventType {
        match self {
            Self::MessageCreated(_) => CanonicalEventType::MessageCreated,
            Self::MessageEdited(_) => CanonicalEventType::MessageEdited,
            Self::MessageDeleted(_) => CanonicalEventType::MessageDeleted,
            Self::ReactionAdded(_) => CanonicalEventType::ReactionAdded,
            Self::ReactionRemoved(_) => CanonicalEventType::ReactionRemoved,
            Self::ReceiptRead(_) => CanonicalEventType::ReceiptRead,
            Self::ReceiptDelivered(_) => CanonicalEventType::ReceiptDelivered,
            Self::TypingStarted(_) => CanonicalEventType::TypingStarted,
            Self::TypingStopped(_) => CanonicalEventType::TypingStopped,
            Self::AttachmentObserved(_) => CanonicalEventType::AttachmentObserved,
            Self::ConversationUpdated(_) => CanonicalEventType::ConversationUpdated,
            Self::ParticipantUpdated(_) => CanonicalEventType::ParticipantUpdated,
            Self::CommandUpdated(_) => CanonicalEventType::CommandUpdated,
            Self::BridgeDeliveryUpdated(_) => CanonicalEventType::BridgeDeliveryUpdated,
            Self::ReplayTombstone(_) => CanonicalEventType::ReplayTombstone,
            Self::CorrectionApplied(_) => CanonicalEventType::CorrectionApplied,
            Self::DeletionTombstone(_) => CanonicalEventType::DeletionTombstone,
        }
    }
}

/// A validated canonical projection event envelope.
#[derive(Clone, Eq, PartialEq)]
pub struct CanonicalEvent {
    pub schema_version: u8,
    pub event_id: String,
    pub event_source: CanonicalEventSource,
    pub tenant_id: String,
    pub identity_id: String,
    pub platform: Provider,
    pub account_id: String,
    pub conversation_id: String,
    pub matrix_room_id: Option<String>,
    pub matrix_event_id: Option<String>,
    pub remote_message_id: Option<String>,
    pub occurred_at: String,
    pub observed_at: String,
    pub payload: CanonicalPayload,
}

impl fmt::Debug for CanonicalEvent {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("CanonicalEvent([REDACTED])")
    }
}

impl fmt::Display for CanonicalEvent {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("CanonicalEvent([REDACTED])")
    }
}

/// Parsed canonical-event ordering key.  The timestamp components are UTC
/// milliseconds, matching the precision used by JavaScript `Date.parse`.
#[derive(Clone, Eq, PartialEq)]
pub struct CanonicalOrderingKey {
    observed_at_millis: i64,
    occurred_at_millis: i64,
    event_id: String,
}

impl CanonicalOrderingKey {
    /// Return the parsed observation instant in UTC milliseconds.
    pub const fn observed_at_millis(&self) -> i64 {
        self.observed_at_millis
    }

    /// Return the parsed occurrence instant in UTC milliseconds.
    pub const fn occurred_at_millis(&self) -> i64 {
        self.occurred_at_millis
    }

    /// Return the event ID tie-break value.
    pub fn event_id(&self) -> &str {
        &self.event_id
    }
}

impl fmt::Debug for CanonicalOrderingKey {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("CanonicalOrderingKey([REDACTED])")
    }
}

impl Ord for CanonicalOrderingKey {
    fn cmp(&self, other: &Self) -> Ordering {
        match self.observed_at_millis.cmp(&other.observed_at_millis) {
            Ordering::Equal => match self.occurred_at_millis.cmp(&other.occurred_at_millis) {
                Ordering::Equal => self
                    .event_id
                    .encode_utf16()
                    .cmp(other.event_id.encode_utf16()),
                ordering => ordering,
            },
            ordering => ordering,
        }
    }
}

impl PartialOrd for CanonicalOrderingKey {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

impl PartialEq<(&str, &str, &str)> for CanonicalOrderingKey {
    fn eq(&self, other: &(&str, &str, &str)) -> bool {
        parse_timestamp(other.0).is_some_and(|observed| {
            parse_timestamp(other.1).is_some_and(|occurred| {
                observed.millis == self.observed_at_millis
                    && occurred.millis == self.occurred_at_millis
                    && self.event_id == other.2
            })
        })
    }
}

impl CanonicalEvent {
    /// Construct and validate a canonical event.  The event type is derived
    /// from `payload`, so a caller cannot accidentally select a mismatched
    /// event/payload pair through this constructor.
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        event_id: impl Into<String>,
        event_source: CanonicalEventSource,
        tenant_id: impl Into<String>,
        identity_id: impl Into<String>,
        platform: Provider,
        account_id: impl Into<String>,
        conversation_id: impl Into<String>,
        matrix_room_id: Option<String>,
        matrix_event_id: Option<String>,
        remote_message_id: Option<String>,
        occurred_at: impl Into<String>,
        observed_at: impl Into<String>,
        payload: CanonicalPayload,
    ) -> Result<Self, ModelError> {
        let payload = normalize_payload(payload)?;
        let event = Self {
            schema_version: CANONICAL_SCHEMA_VERSION,
            event_id: normalize_opaque(&event_id.into(), 1024)?,
            event_source,
            tenant_id: tenant_id.into(),
            identity_id: identity_id.into(),
            platform,
            account_id: account_id.into(),
            conversation_id: conversation_id.into(),
            matrix_room_id,
            matrix_event_id,
            remote_message_id: remote_message_id
                .map(|value| normalize_opaque(&value, 1024))
                .transpose()?,
            occurred_at: occurred_at.into(),
            observed_at: observed_at.into(),
            payload,
        };
        event.validate()?;
        Ok(event)
    }

    /// Return the event type derived from the typed payload.
    pub const fn event_type(&self) -> CanonicalEventType {
        self.payload.event_type()
    }

    /// Return the stable sort key required by the canonical archive contract.
    pub fn ordering_key(&self) -> CanonicalOrderingKey {
        let observed_at_millis =
            parse_timestamp(&self.observed_at).map_or(i64::MIN, |timestamp| timestamp.millis);
        let occurred_at_millis =
            parse_timestamp(&self.occurred_at).map_or(i64::MIN, |timestamp| timestamp.millis);
        CanonicalOrderingKey {
            observed_at_millis,
            occurred_at_millis,
            event_id: self.event_id.clone(),
        }
    }

    /// Validate all envelope and projection payload constraints.
    pub fn validate(&self) -> Result<(), ModelError> {
        self.validate_fields()?;
        let encoded =
            serde_json::to_vec(self).map_err(|_| ModelError::new(MODEL_CANONICAL_INVALID))?;
        if encoded.len() > MAX_EVENT_CANONICAL_BYTES {
            return Err(ModelError::new(MODEL_CANONICAL_TOO_LARGE));
        }
        Ok(())
    }

    fn validate_fields(&self) -> Result<(), ModelError> {
        if self.schema_version != CANONICAL_SCHEMA_VERSION
            || !is_normalized_opaque(&self.event_id, 1024)
            || !valid_resource_id(&self.tenant_id)
            || !valid_resource_id(&self.identity_id)
            || !valid_resource_id(&self.account_id)
            || !valid_resource_id(&self.conversation_id)
            || !valid_timestamp(&self.occurred_at)
            || !valid_timestamp(&self.observed_at)
        {
            return Err(ModelError::new(MODEL_CANONICAL_INVALID));
        }
        if !self
            .matrix_room_id
            .as_deref()
            .is_none_or(valid_matrix_room_id)
            || !self
                .matrix_event_id
                .as_deref()
                .is_none_or(valid_matrix_event_id)
            || !self
                .remote_message_id
                .as_deref()
                .is_none_or(|value| is_normalized_opaque(value, 1024))
        {
            return Err(ModelError::new(MODEL_CANONICAL_INVALID));
        }
        validate_payload(&self.payload)?;
        Ok(())
    }
}

impl Serialize for CanonicalEvent {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        self.validate_fields()
            .map_err(|_| S::Error::custom("invalid canonical event"))?;
        let mut state = serializer.serialize_struct("CanonicalEvent", 15)?;
        state.serialize_field("schema_version", &self.schema_version)?;
        state.serialize_field("event_id", &self.event_id)?;
        state.serialize_field("event_type", &self.event_type())?;
        state.serialize_field("event_source", &self.event_source)?;
        state.serialize_field("tenant_id", &self.tenant_id)?;
        state.serialize_field("identity_id", &self.identity_id)?;
        state.serialize_field("platform", &self.platform)?;
        state.serialize_field("account_id", &self.account_id)?;
        state.serialize_field("conversation_id", &self.conversation_id)?;
        state.serialize_field("matrix_room_id", &self.matrix_room_id)?;
        state.serialize_field("matrix_event_id", &self.matrix_event_id)?;
        state.serialize_field("remote_message_id", &self.remote_message_id)?;
        state.serialize_field("occurred_at", &self.occurred_at)?;
        state.serialize_field("observed_at", &self.observed_at)?;
        state.serialize_field("payload", &self.payload)?;
        state.end()
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RawCanonicalEvent {
    schema_version: u8,
    event_id: String,
    event_type: CanonicalEventType,
    event_source: CanonicalEventSource,
    tenant_id: String,
    identity_id: String,
    platform: Provider,
    account_id: String,
    conversation_id: String,
    #[serde(deserialize_with = "deserialize_required_option")]
    matrix_room_id: Option<String>,
    #[serde(deserialize_with = "deserialize_required_option")]
    matrix_event_id: Option<String>,
    #[serde(deserialize_with = "deserialize_required_option")]
    remote_message_id: Option<String>,
    occurred_at: String,
    observed_at: String,
    payload: serde_json::Value,
}

impl<'de> Deserialize<'de> for CanonicalEvent {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = serde_json::Value::deserialize(deserializer)
            .map_err(|_| D::Error::custom("invalid canonical event"))?;
        let raw: RawCanonicalEvent = serde_json::from_value(value)
            .map_err(|_| D::Error::custom("invalid canonical event"))?;
        let event_type = raw.event_type;
        let payload = match event_type {
            CanonicalEventType::MessageCreated => {
                serde_json::from_value(raw.payload).map(CanonicalPayload::MessageCreated)
            }
            CanonicalEventType::MessageEdited => {
                serde_json::from_value(raw.payload).map(CanonicalPayload::MessageEdited)
            }
            CanonicalEventType::MessageDeleted => {
                serde_json::from_value(raw.payload).map(CanonicalPayload::MessageDeleted)
            }
            CanonicalEventType::ReactionAdded => {
                serde_json::from_value(raw.payload).map(CanonicalPayload::ReactionAdded)
            }
            CanonicalEventType::ReactionRemoved => {
                serde_json::from_value(raw.payload).map(CanonicalPayload::ReactionRemoved)
            }
            CanonicalEventType::ReceiptRead => {
                serde_json::from_value(raw.payload).map(CanonicalPayload::ReceiptRead)
            }
            CanonicalEventType::ReceiptDelivered => {
                serde_json::from_value(raw.payload).map(CanonicalPayload::ReceiptDelivered)
            }
            CanonicalEventType::TypingStarted => {
                serde_json::from_value(raw.payload).map(CanonicalPayload::TypingStarted)
            }
            CanonicalEventType::TypingStopped => {
                serde_json::from_value(raw.payload).map(CanonicalPayload::TypingStopped)
            }
            CanonicalEventType::AttachmentObserved => {
                serde_json::from_value(raw.payload).map(CanonicalPayload::AttachmentObserved)
            }
            CanonicalEventType::ConversationUpdated => {
                serde_json::from_value(raw.payload).map(CanonicalPayload::ConversationUpdated)
            }
            CanonicalEventType::ParticipantUpdated => {
                serde_json::from_value(raw.payload).map(CanonicalPayload::ParticipantUpdated)
            }
            CanonicalEventType::CommandUpdated => {
                serde_json::from_value(raw.payload).map(CanonicalPayload::CommandUpdated)
            }
            CanonicalEventType::BridgeDeliveryUpdated => {
                serde_json::from_value(raw.payload).map(CanonicalPayload::BridgeDeliveryUpdated)
            }
            CanonicalEventType::ReplayTombstone => {
                serde_json::from_value(raw.payload).map(CanonicalPayload::ReplayTombstone)
            }
            CanonicalEventType::CorrectionApplied => {
                serde_json::from_value(raw.payload).map(CanonicalPayload::CorrectionApplied)
            }
            CanonicalEventType::DeletionTombstone => {
                serde_json::from_value(raw.payload).map(CanonicalPayload::DeletionTombstone)
            }
        }
        .map_err(|_| D::Error::custom("invalid canonical payload"))?;

        Self::new(
            raw.event_id,
            raw.event_source,
            raw.tenant_id,
            raw.identity_id,
            raw.platform,
            raw.account_id,
            raw.conversation_id,
            raw.matrix_room_id,
            raw.matrix_event_id,
            raw.remote_message_id,
            raw.occurred_at,
            raw.observed_at,
            payload,
        )
        .and_then(|event| {
            if event.schema_version == raw.schema_version {
                Ok(event)
            } else {
                Err(ModelError::new(MODEL_CANONICAL_SCHEMA))
            }
        })
        .map_err(|_| D::Error::custom("invalid canonical event"))
    }
}

fn normalize_opaque(value: &str, max_bytes: usize) -> Result<String, ModelError> {
    let normalized = js_trim(value);
    if !valid_opaque(normalized, max_bytes) {
        return Err(ModelError::new(MODEL_CANONICAL_ID));
    }
    Ok(normalized.to_owned())
}

fn normalize_payload(payload: CanonicalPayload) -> Result<CanonicalPayload, ModelError> {
    match payload {
        CanonicalPayload::ReplayTombstone(mut marker) => {
            marker.target_event_id = normalize_opaque(&marker.target_event_id, 1024)?;
            Ok(CanonicalPayload::ReplayTombstone(marker))
        }
        CanonicalPayload::CorrectionApplied(mut marker) => {
            marker.target_event_id = normalize_opaque(&marker.target_event_id, 1024)?;
            Ok(CanonicalPayload::CorrectionApplied(marker))
        }
        other => Ok(other),
    }
}

fn valid_text(value: &str, min_chars: usize, max_chars: usize) -> bool {
    let length = value.encode_utf16().count();
    length >= min_chars && length <= max_chars
}

fn valid_resource_id(value: &str) -> bool {
    if value.len() > 128 {
        return false;
    }
    let Some((prefix, suffix)) = value.split_once('_') else {
        return false;
    };
    !prefix.is_empty()
        && !suffix.is_empty()
        && prefix.bytes().all(|byte| byte.is_ascii_lowercase())
        && suffix
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'_')
}

fn valid_opaque(value: &str, max_bytes: usize) -> bool {
    let normalized = js_trim(value);
    !normalized.is_empty() && normalized.encode_utf16().count() <= max_bytes
}

fn is_normalized_opaque(value: &str, max_bytes: usize) -> bool {
    !value.is_empty() && js_trim(value) == value && value.encode_utf16().count() <= max_bytes
}

fn is_js_trim_character(character: char) -> bool {
    matches!(
        character,
        '\u{0009}'..='\u{000D}'
            | '\u{0020}'
            | '\u{00A0}'
            | '\u{1680}'
            | '\u{2000}'..='\u{200A}'
            | '\u{2028}'
            | '\u{2029}'
            | '\u{202F}'
            | '\u{205F}'
            | '\u{3000}'
            | '\u{FEFF}'
    )
}

fn js_trim(value: &str) -> &str {
    value.trim_matches(is_js_trim_character)
}

fn valid_matrix_room_id(value: &str) -> bool {
    value.starts_with('!') && valid_text(value, 1, 1024)
}

fn valid_matrix_event_id(value: &str) -> bool {
    value.starts_with('$') && valid_text(value, 1, 1024)
}

#[derive(Clone, Copy)]
struct ParsedTimestamp {
    millis: i64,
}

fn parse_timestamp(value: &str) -> Option<ParsedTimestamp> {
    let bytes = value.as_bytes();
    if value.encode_utf16().count() > 64
        || bytes.len() < 17
        || bytes.iter().any(|byte| !byte.is_ascii())
        || bytes.get(4) != Some(&b'-')
        || bytes.get(7) != Some(&b'-')
        || bytes.get(10) != Some(&b'T')
        || bytes.get(13) != Some(&b':')
    {
        return None;
    }

    let digits = |start: usize, end: usize| -> Option<u32> {
        let slice = bytes.get(start..end)?;
        if slice.is_empty() || slice.iter().any(|byte| !byte.is_ascii_digit()) {
            return None;
        }
        let mut number = 0_u32;
        for byte in slice {
            number = number
                .checked_mul(10)?
                .checked_add(u32::from(byte - b'0'))?;
        }
        Some(number)
    };
    let (Some(year), Some(month), Some(day)) = (digits(0, 4), digits(5, 7), digits(8, 10)) else {
        return None;
    };
    if !(1..=12).contains(&month) {
        return None;
    }
    let leap = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0);
    let days_in_month = match month {
        2 if leap => 29,
        2 => 28,
        4 | 6 | 9 | 11 => 30,
        _ => 31,
    };
    if day == 0 || day > days_in_month {
        return None;
    }

    let (Some(hour), Some(minute)) = (digits(11, 13), digits(14, 16)) else {
        return None;
    };
    if hour > 23 || minute > 59 {
        return None;
    }

    let mut cursor = 16;
    let mut second = 0_u32;
    let mut milliseconds = 0_u32;
    if bytes.get(cursor) == Some(&b':') {
        let parsed_second = digits(cursor + 1, cursor + 3)?;
        if parsed_second > 59 {
            return None;
        }
        second = parsed_second;
        cursor += 3;
        if bytes.get(cursor) == Some(&b'.') {
            let fraction_start = cursor + 1;
            let fraction_end = bytes[fraction_start..]
                .iter()
                .position(|byte| *byte == b'Z' || *byte == b'+' || *byte == b'-')
                .map_or(bytes.len(), |position| fraction_start + position);
            let fraction = bytes.get(fraction_start..fraction_end)?;
            if fraction.is_empty() || fraction.iter().any(|byte| !byte.is_ascii_digit()) {
                return None;
            }
            for (index, byte) in fraction.iter().take(3).enumerate() {
                let scale = match index {
                    0 => 100,
                    1 => 10,
                    _ => 1,
                };
                milliseconds = milliseconds.checked_add(u32::from(byte - b'0') * scale)?;
            }
            cursor = fraction_end;
        }
    }

    let offset_minutes = match bytes.get(cursor) {
        Some(b'Z') if cursor + 1 == bytes.len() => 0_i64,
        Some(sign @ (b'+' | b'-')) if cursor + 6 == bytes.len() => {
            if bytes.get(cursor + 3) != Some(&b':') {
                return None;
            }
            let hours = digits(cursor + 1, cursor + 3)?;
            let minutes = digits(cursor + 4, cursor + 6)?;
            if hours > 23 || minutes > 59 {
                return None;
            }
            let total = i64::from(hours) * 60 + i64::from(minutes);
            if *sign == b'+' { total } else { -total }
        }
        _ => return None,
    };

    let days = days_from_civil(i64::from(year), i64::from(month), i64::from(day));
    let local_millis = days
        .checked_mul(86_400_000)?
        .checked_add(i64::from(hour) * 3_600_000)?
        .checked_add(i64::from(minute) * 60_000)?
        .checked_add(i64::from(second) * 1_000)?
        .checked_add(i64::from(milliseconds))?;
    Some(ParsedTimestamp {
        millis: local_millis.checked_sub(offset_minutes.checked_mul(60_000)?)?,
    })
}

fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let year = year - i64::from(month <= 2);
    let era = if year >= 0 {
        year / 400
    } else {
        (year - 399) / 400
    };
    let year_of_era = year - era * 400;
    let month_prime = month + if month > 2 { -3 } else { 9 };
    let day_of_year = (153 * month_prime + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    era * 146_097 + day_of_era - 719_468
}

pub(crate) fn valid_timestamp(value: &str) -> bool {
    parse_timestamp(value).is_some()
}

fn valid_reason(value: &Option<String>) -> bool {
    value
        .as_deref()
        .is_none_or(|reason| valid_text(reason, 1, 100))
}

fn valid_resource(value: &str) -> bool {
    valid_resource_id(value)
}

fn validate_payload(payload: &CanonicalPayload) -> Result<(), ModelError> {
    let valid = match payload {
        CanonicalPayload::MessageCreated(value) => {
            valid_resource(&value.message_id)
                && valid_text(&value.sender_label, 1, 100)
                && valid_text(&value.body, 0, 20_000)
                && value
                    .sender_participant_id
                    .as_deref()
                    .is_none_or(valid_resource)
                && value
                    .reply_to_message_id
                    .as_deref()
                    .is_none_or(valid_resource)
        }
        CanonicalPayload::MessageEdited(value) => {
            valid_resource(&value.message_id)
                && valid_text(&value.body, 0, 20_000)
                && value
                    .editor_participant_id
                    .as_deref()
                    .is_none_or(valid_resource)
        }
        CanonicalPayload::MessageDeleted(value) => {
            valid_resource(&value.message_id) && valid_reason(&value.reason_code)
        }
        CanonicalPayload::ReactionAdded(value) => {
            valid_resource(&value.reaction_id)
                && valid_resource(&value.message_id)
                && valid_resource(&value.participant_id)
                && valid_text(&value.emoji, 1, 64)
        }
        CanonicalPayload::ReactionRemoved(value) => {
            valid_resource(&value.reaction_id) && valid_resource(&value.message_id)
        }
        CanonicalPayload::ReceiptRead(value) | CanonicalPayload::ReceiptDelivered(value) => {
            valid_resource(&value.message_id) && valid_resource(&value.participant_id)
        }
        CanonicalPayload::TypingStarted(value) => {
            valid_resource(&value.participant_id) && valid_timestamp(&value.expires_at)
        }
        CanonicalPayload::TypingStopped(value) => valid_resource(&value.participant_id),
        CanonicalPayload::AttachmentObserved(value) => {
            valid_resource(&value.attachment_id)
                && valid_resource(&value.message_id)
                && value
                    .file_name
                    .as_deref()
                    .is_none_or(|name| valid_text(name, 0, 255))
                && value
                    .mime_type
                    .as_deref()
                    .is_none_or(|mime| valid_text(mime, 1, 255))
                && value.size_bytes.is_none_or(|size| size <= MAX_SAFE_INTEGER)
                && value.sha256.as_deref().is_none_or(valid_sha256)
                && value.r2_key.as_deref().is_none_or(valid_r2_key)
        }
        CanonicalPayload::ConversationUpdated(value) => valid_text(&value.title, 1, 200),
        CanonicalPayload::ParticipantUpdated(value) => {
            valid_resource(&value.participant_id)
                && valid_text(&value.display_name, 1, 100)
                && value
                    .remote_id
                    .as_deref()
                    .is_none_or(|remote| valid_text(remote, 1, 1024))
                && value
                    .avatar_url
                    .as_deref()
                    .is_none_or(|avatar| valid_text(avatar, 1, 2048))
        }
        CanonicalPayload::CommandUpdated(value) => {
            valid_resource(&value.command_id)
                && value.operation == "message.send"
                && valid_reason(&value.failure_code)
        }
        CanonicalPayload::BridgeDeliveryUpdated(value) => {
            valid_resource(&value.message_id) && valid_reason(&value.failure_code)
        }
        CanonicalPayload::ReplayTombstone(value) | CanonicalPayload::CorrectionApplied(value) => {
            is_normalized_opaque(&value.target_event_id, 1024)
                && valid_text(&value.reason_code, 1, 100)
        }
        CanonicalPayload::DeletionTombstone(value) => {
            valid_resource(&value.resource_id) && valid_text(&value.reason_code, 1, 100)
        }
    };
    if !valid {
        return Err(ModelError::new(MODEL_CANONICAL_PAYLOAD));
    }
    Ok(())
}

fn valid_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
}

fn valid_r2_key(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 512
        && value.bytes().all(|byte| (0x20..=0x7e).contains(&byte))
}

/// Hash a versioned tuple using unambiguous length-prefixed UTF-8 framing.
///
/// The encoded input is exactly:
///
/// ```text
/// u32::to_be_bytes(domain.len()) || domain ||
/// u32::to_be_bytes(field_0.len()) || field_0 || ...
/// ```
///
/// No fields are concatenated without their byte lengths.  The returned
/// digest is lowercase hexadecimal and therefore safe for use in resource
/// identifiers.
pub fn framed_hash_id(domain: &str, fields: &[&str]) -> Result<String, ModelError> {
    let mut hasher = Sha256::new();
    for value in std::iter::once(domain).chain(fields.iter().copied()) {
        if value.is_empty() {
            return Err(ModelError::new(MODEL_EMPTY_TUPLE_FIELD));
        }
        let length =
            u32::try_from(value.len()).map_err(|_| ModelError::new(MODEL_TUPLE_TOO_LARGE))?;
        hasher.update(length.to_be_bytes());
        hasher.update(value.as_bytes());
    }

    let digest = hasher.finalize();
    let mut encoded = String::with_capacity(digest.len() * 2);
    const HEX: &[u8; 16] = b"0123456789abcdef";
    for byte in digest {
        encoded.push(HEX[usize::from(byte >> 4)] as char);
        encoded.push(HEX[usize::from(byte & 0x0f)] as char);
    }
    Ok(encoded)
}

/// Derive the stable canonical message resource identifier.
pub fn message_id(
    matrix_room_id: &str,
    original_message_event_id: &str,
) -> Result<String, ModelError> {
    framed_hash_id(
        "matrix-message-v1",
        &[matrix_room_id, original_message_event_id],
    )
    .map(|digest| format!("message_{digest}"))
}

/// Derive the stable participant resource identifier for one tenant authority.
pub fn participant_id(
    tenant_id: &str,
    platform: &str,
    account_id: &str,
    matrix_user_id: &str,
) -> Result<String, ModelError> {
    framed_hash_id(
        "matrix-participant-v1",
        &[tenant_id, platform, account_id, matrix_user_id],
    )
    .map(|digest| format!("participant_{digest}"))
}

fn ordinal_field<N>(ordinal: N) -> Result<String, ModelError>
where
    N: TryInto<u32>,
{
    let ordinal = ordinal
        .try_into()
        .map_err(|_| ModelError::new(MODEL_ORDINAL_OVERFLOW))?;
    Ok(ordinal.to_string())
}

/// Derive the stable event identifier for a durable or snapshot source.
pub fn durable_event_id<N>(
    source_key: &str,
    event_type: CanonicalEventType,
    ordinal: N,
) -> Result<String, ModelError>
where
    N: TryInto<u32>,
{
    let ordinal = ordinal_field(ordinal)?;
    framed_hash_id(
        "canonical-event-v1",
        &[source_key, event_type.as_str(), &ordinal],
    )
    .map(|digest| format!("evt_{digest}"))
}

/// Alias for [`durable_event_id`] using the concise envelope field name.
pub fn event_id<N>(
    source_key: &str,
    event_type: CanonicalEventType,
    ordinal: N,
) -> Result<String, ModelError>
where
    N: TryInto<u32>,
{
    durable_event_id(source_key, event_type, ordinal)
}

/// Derive the stable source key for one Matrix read/delivery receipt tuple.
pub fn receipt_source_key(
    matrix_room_id: &str,
    target_event_id: &str,
    participant_id: &str,
    receipt_type: &str,
) -> Result<String, ModelError> {
    if !matches!(receipt_type, "read" | "delivered") {
        return Err(ModelError::new(MODEL_INVALID_RECEIPT_TYPE));
    }
    framed_hash_id(
        "receipt-v1",
        &[
            matrix_room_id,
            target_event_id,
            participant_id,
            receipt_type,
        ],
    )
    .map(|digest| format!("receipt_{digest}"))
}

/// Derive the stable source key for one typing replacement transition.
pub fn typing_source_key(
    checkpoint_digest: &str,
    matrix_room_id: &str,
    participant_id: &str,
    transition: &str,
) -> Result<String, ModelError> {
    if !matches!(transition, "started" | "stopped") {
        return Err(ModelError::new(MODEL_INVALID_TYPING_TRANSITION));
    }
    framed_hash_id(
        "typing-v1",
        &[
            checkpoint_digest,
            matrix_room_id,
            participant_id,
            transition,
        ],
    )
    .map(|digest| format!("typing_{digest}"))
}

/// Derive the stable reaction resource identifier.
pub fn reaction_id(matrix_room_id: &str, reaction_event_id: &str) -> Result<String, ModelError> {
    framed_hash_id("matrix-reaction-v1", &[matrix_room_id, reaction_event_id])
        .map(|digest| format!("reaction_{digest}"))
}

/// Derive the stable attachment resource identifier for a message ordinal.
pub fn attachment_id<N>(message_id: &str, ordinal: N) -> Result<String, ModelError>
where
    N: TryInto<u32>,
{
    let ordinal = ordinal_field(ordinal)?;
    framed_hash_id("matrix-attachment-v1", &[message_id, &ordinal])
        .map(|digest| format!("attachment_{digest}"))
}
