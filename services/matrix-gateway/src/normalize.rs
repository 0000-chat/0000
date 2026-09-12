//! Pure Matrix-to-Communicator event normalization.
//!
//! Matrix SDK details stop at this module's input boundary.  The normalizer
//! owns no I/O and takes all tenant authority from the verified room binding.

use std::{collections::BTreeMap, fmt};

use chrono::{DateTime, Duration, SecondsFormat, Utc};
use zeroize::Zeroize;

use crate::{
    model::{
        self, AttachmentObservedPayload, CanonicalEvent, CanonicalEventSource, CanonicalEventType,
        CanonicalPayload, ConversationUpdatedPayload, DeliveryStatus, Direction,
        MessageCreatedPayload, MessageDeletedPayload, MessageEditedPayload,
        ParticipantUpdatedPayload, ReactionAddedPayload, ReactionRemovedPayload, ReceiptPayload,
        TypingStartedPayload, TypingStoppedPayload, attachment_id, durable_event_id, message_id,
        participant_id, reaction_id, receipt_source_key, typing_source_key,
    },
    registry::{RoomBinding, RoomBindingStatus},
};

/// A canonical projection envelope emitted by the gateway.
pub type ProjectionEventEnvelope = CanonicalEvent;

/// Maximum number of attachment metadata records accepted on one Matrix
/// message.
pub const MAX_MESSAGE_ATTACHMENTS: usize = 100;

/// Stable reason returned for a room that is not the exact active binding.
pub const MATRIX_UNKNOWN_ROOM: &str = "matrix_unknown_room";
/// Stable reason returned for an event from a participant not known in the
/// bound room.
pub const MATRIX_UNKNOWN_SENDER: &str = "matrix_unknown_sender";
/// Stable reason returned for malformed event data.
pub const MATRIX_MALFORMED_EVENT: &str = "matrix_malformed_event";
/// Stable reason returned for an unsupported Matrix message type.
pub const MATRIX_UNSUPPORTED_MESSAGE_TYPE: &str = "matrix_unsupported_message_type";
/// Stable reason returned for an unsupported Matrix state event.
pub const MATRIX_UNSUPPORTED_STATE: &str = "matrix_unsupported_state";
/// Stable reason returned for an unsupported Matrix ephemeral event.
pub const MATRIX_UNSUPPORTED_EPHEMERAL: &str = "matrix_unsupported_ephemeral";
/// Stable reason returned when a relation target is not known in the room.
pub const MATRIX_MISSING_RELATION_TARGET: &str = "matrix_missing_relation_target";
/// Stable reason returned when a message body exceeds the projection bound.
pub const MATRIX_BODY_TOO_LARGE: &str = "matrix_body_too_large";
/// Stable reason returned when attachment metadata exceeds a projection bound.
pub const MATRIX_METADATA_TOO_LARGE: &str = "matrix_metadata_too_large";
/// Stable reason returned when an event timestamp is invalid.
pub const MATRIX_INVALID_TIMESTAMP: &str = "matrix_invalid_timestamp";
/// Stable reason returned when a typing replacement has no transition.
pub const MATRIX_TYPING_UNCHANGED: &str = "matrix_typing_unchanged";
/// Stable reason returned for an event that cannot be decrypted yet.
pub const MATRIX_UNABLE_TO_DECRYPT: &str = "matrix_unable_to_decrypt";

/// Bytes retained for a later retry or source-gap request.
///
/// The wrapper deliberately has no byte access in the public API.  The
/// gateway's recovery and store code can consume it inside this crate, while
/// formatting always stays content-free.
pub struct ProtectedBytes {
    bytes: Vec<u8>,
}

impl ProtectedBytes {
    /// Wrap protected bytes without exposing them through formatting.
    pub fn new(bytes: impl AsRef<[u8]>) -> Self {
        Self {
            bytes: bytes.as_ref().to_vec(),
        }
    }

    /// Return the byte count without returning the bytes.
    pub fn len(&self) -> usize {
        self.bytes.len()
    }

    /// Return whether no protected bytes are present.
    pub fn is_empty(&self) -> bool {
        self.bytes.is_empty()
    }

    /// Borrow the bytes for the single in-crate recovery consumer.
    #[allow(dead_code)]
    pub(crate) fn as_bytes(&self) -> &[u8] {
        &self.bytes
    }

    /// Move the bytes to the single in-crate persistence consumer.
    #[allow(dead_code)]
    pub(crate) fn into_bytes(mut self) -> Vec<u8> {
        std::mem::take(&mut self.bytes)
    }
}

impl PartialEq for ProtectedBytes {
    fn eq(&self, other: &Self) -> bool {
        self.bytes == other.bytes
    }
}

impl Eq for ProtectedBytes {}

impl fmt::Debug for ProtectedBytes {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("[REDACTED]")
    }
}

impl fmt::Display for ProtectedBytes {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("[REDACTED]")
    }
}

impl Drop for ProtectedBytes {
    fn drop(&mut self) {
        self.bytes.zeroize();
    }
}

/// The Matrix message family understood by the gateway.
#[derive(Clone, Copy, Eq, PartialEq)]
pub enum MatrixMessageKind {
    Text,
    Notice,
    Emote,
    Image,
    File,
    Audio,
    Video,
    Unsupported,
}

impl MatrixMessageKind {
    fn is_supported(self) -> bool {
        !matches!(self, Self::Unsupported)
    }
}

impl fmt::Debug for MatrixMessageKind {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::Text => "text",
            Self::Notice => "notice",
            Self::Emote => "emote",
            Self::Image => "image",
            Self::File => "file",
            Self::Audio => "audio",
            Self::Video => "video",
            Self::Unsupported => "unsupported",
        })
    }
}

/// A relation attached to a Matrix message.
pub enum MatrixRelation {
    Reply { target_event_id: String },
    Replace { target_event_id: String },
}

impl MatrixRelation {
    /// Construct a reply relation.
    pub fn reply(target_event_id: impl Into<String>) -> Self {
        Self::Reply {
            target_event_id: target_event_id.into(),
        }
    }

    /// Construct an edit relation.
    pub fn replace(target_event_id: impl Into<String>) -> Self {
        Self::Replace {
            target_event_id: target_event_id.into(),
        }
    }
}

impl fmt::Debug for MatrixRelation {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("MatrixRelation([REDACTED])")
    }
}

/// Attachment metadata observed on a Matrix message.
///
/// This type intentionally has no bytes or download URI.  A later producer
/// may add an R2 key after it has independently archived content.
pub struct MatrixAttachment {
    file_name: Option<String>,
    mime_type: Option<String>,
    size_bytes: Option<u64>,
    sha256: Option<String>,
}

impl MatrixAttachment {
    /// Construct attachment metadata without accepting attachment bytes.
    pub fn new(
        file_name: Option<String>,
        mime_type: Option<String>,
        size_bytes: Option<u64>,
        sha256: Option<String>,
    ) -> Self {
        Self {
            file_name,
            mime_type,
            size_bytes,
            sha256,
        }
    }
}

impl fmt::Debug for MatrixAttachment {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("MatrixAttachment([REDACTED])")
    }
}

/// A Matrix message at the SDK-independent normalization boundary.
pub struct MatrixMessage {
    room_id: String,
    event_id: String,
    sender_user_id: String,
    sender_label: String,
    body: String,
    formatted_body: Option<String>,
    occurred_at: String,
    kind: MatrixMessageKind,
    relation: Option<MatrixRelation>,
    attachments: Vec<MatrixAttachment>,
    remote_message_id: Option<String>,
    source: CanonicalEventSource,
}

impl MatrixMessage {
    /// Construct a live plain-body text message.
    pub fn new(
        room_id: impl Into<String>,
        event_id: impl Into<String>,
        sender_user_id: impl Into<String>,
        sender_label: impl Into<String>,
        body: impl Into<String>,
        occurred_at: impl Into<String>,
    ) -> Self {
        Self {
            room_id: room_id.into(),
            event_id: event_id.into(),
            sender_user_id: sender_user_id.into(),
            sender_label: sender_label.into(),
            body: body.into(),
            formatted_body: None,
            occurred_at: occurred_at.into(),
            kind: MatrixMessageKind::Text,
            relation: None,
            attachments: Vec::new(),
            remote_message_id: None,
            source: CanonicalEventSource::Live,
        }
    }

    /// Set the Matrix message family.
    pub fn with_kind(mut self, kind: MatrixMessageKind) -> Self {
        self.kind = kind;
        self
    }

    /// Retain formatted HTML only at the input boundary.  The normalizer
    /// always emits the plain `body` field.
    pub fn with_formatted_body(mut self, formatted_body: impl Into<String>) -> Self {
        self.formatted_body = Some(formatted_body.into());
        self
    }

    /// Set a reply or replacement relation.
    pub fn with_relation(mut self, relation: MatrixRelation) -> Self {
        self.relation = Some(relation);
        self
    }

    /// Set bounded attachment metadata.
    pub fn with_attachments(mut self, attachments: Vec<MatrixAttachment>) -> Self {
        self.attachments = attachments;
        self
    }

    /// Set the optional bridge-provided canonical remote message ID.
    pub fn with_remote_message_id(mut self, remote_message_id: impl Into<String>) -> Self {
        self.remote_message_id = Some(remote_message_id.into());
        self
    }

    /// Mark the message as a historical backfill event.
    pub fn with_source(mut self, source: CanonicalEventSource) -> Self {
        self.source = source;
        self
    }
}

impl fmt::Debug for MatrixMessage {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("MatrixMessage([REDACTED])")
    }
}

/// A Matrix redaction of a previously observed event.
pub struct MatrixRedaction {
    room_id: String,
    event_id: String,
    sender_user_id: String,
    target_event_id: String,
    reason_code: Option<String>,
    occurred_at: String,
    source: CanonicalEventSource,
}

impl MatrixRedaction {
    /// Construct a redaction without retaining event content.
    pub fn new(
        room_id: impl Into<String>,
        event_id: impl Into<String>,
        sender_user_id: impl Into<String>,
        target_event_id: impl Into<String>,
        reason_code: Option<String>,
        occurred_at: impl Into<String>,
    ) -> Self {
        Self {
            room_id: room_id.into(),
            event_id: event_id.into(),
            sender_user_id: sender_user_id.into(),
            target_event_id: target_event_id.into(),
            reason_code,
            occurred_at: occurred_at.into(),
            source: CanonicalEventSource::Live,
        }
    }

    /// Mark the redaction as a historical backfill event.
    pub fn with_source(mut self, source: CanonicalEventSource) -> Self {
        self.source = source;
        self
    }
}

impl fmt::Debug for MatrixRedaction {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("MatrixRedaction([REDACTED])")
    }
}

/// A Matrix reaction add event.
pub struct MatrixReaction {
    room_id: String,
    event_id: String,
    sender_user_id: String,
    target_event_id: String,
    emoji: String,
    occurred_at: String,
    source: CanonicalEventSource,
}

impl MatrixReaction {
    /// Construct a reaction add event.
    pub fn new(
        room_id: impl Into<String>,
        event_id: impl Into<String>,
        sender_user_id: impl Into<String>,
        target_event_id: impl Into<String>,
        emoji: impl Into<String>,
        occurred_at: impl Into<String>,
    ) -> Self {
        Self {
            room_id: room_id.into(),
            event_id: event_id.into(),
            sender_user_id: sender_user_id.into(),
            target_event_id: target_event_id.into(),
            emoji: emoji.into(),
            occurred_at: occurred_at.into(),
            source: CanonicalEventSource::Live,
        }
    }

    /// Mark the reaction as a historical backfill event.
    pub fn with_source(mut self, source: CanonicalEventSource) -> Self {
        self.source = source;
        self
    }
}

impl fmt::Debug for MatrixReaction {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("MatrixReaction([REDACTED])")
    }
}

/// The Matrix receipt kind mapped by the gateway.
#[derive(Clone, Copy, Eq, PartialEq)]
pub enum MatrixReceiptType {
    Read,
    Delivered,
}

impl MatrixReceiptType {
    fn as_str(self) -> &'static str {
        match self {
            Self::Read => "read",
            Self::Delivered => "delivered",
        }
    }
}

impl fmt::Debug for MatrixReceiptType {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.as_str())
    }
}

/// A single receipt entry from one Matrix replacement snapshot.
pub struct MatrixReceipt {
    room_id: String,
    target_event_id: String,
    sender_user_id: String,
    receipt_type: MatrixReceiptType,
    occurred_at: String,
    source: CanonicalEventSource,
}

impl MatrixReceipt {
    /// Construct one read or delivery receipt entry.
    pub fn new(
        room_id: impl Into<String>,
        target_event_id: impl Into<String>,
        sender_user_id: impl Into<String>,
        receipt_type: MatrixReceiptType,
        occurred_at: impl Into<String>,
    ) -> Self {
        Self {
            room_id: room_id.into(),
            target_event_id: target_event_id.into(),
            sender_user_id: sender_user_id.into(),
            receipt_type,
            occurred_at: occurred_at.into(),
            source: CanonicalEventSource::Live,
        }
    }

    /// Mark the receipt as a historical backfill observation.
    pub fn with_source(mut self, source: CanonicalEventSource) -> Self {
        self.source = source;
        self
    }
}

impl fmt::Debug for MatrixReceipt {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("MatrixReceipt([REDACTED])")
    }
}

/// A typing replacement snapshot for one saved sync response.
pub struct MatrixTyping {
    room_id: String,
    checkpoint_digest: String,
    members: Vec<String>,
    previous_members: Vec<String>,
    source: CanonicalEventSource,
}

impl MatrixTyping {
    /// Construct a typing snapshot and its previously committed room set.
    pub fn new<I, M, P, Q>(
        room_id: impl Into<String>,
        checkpoint_digest: impl Into<String>,
        members: I,
        previous_members: P,
    ) -> Self
    where
        I: IntoIterator<Item = M>,
        M: Into<String>,
        P: IntoIterator<Item = Q>,
        Q: Into<String>,
    {
        Self {
            room_id: room_id.into(),
            checkpoint_digest: checkpoint_digest.into(),
            members: members.into_iter().map(Into::into).collect(),
            previous_members: previous_members.into_iter().map(Into::into).collect(),
            source: CanonicalEventSource::Live,
        }
    }

    /// Mark the snapshot as a historical backfill observation.
    pub fn with_source(mut self, source: CanonicalEventSource) -> Self {
        self.source = source;
        self
    }
}

impl fmt::Debug for MatrixTyping {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("MatrixTyping([REDACTED])")
    }
}

/// Room state families whose complete canonical snapshot can be represented.
#[derive(Clone, Copy, Eq, PartialEq)]
pub enum MatrixRoomStateKind {
    Name,
    Topic,
    Avatar,
    Unsupported,
}

impl fmt::Debug for MatrixRoomStateKind {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::Name => "name",
            Self::Topic => "topic",
            Self::Avatar => "avatar",
            Self::Unsupported => "unsupported",
        })
    }
}

/// A Matrix room state event carrying a complete conversation snapshot.
pub struct MatrixRoomState {
    room_id: String,
    event_id: String,
    sender_user_id: String,
    kind: MatrixRoomStateKind,
    title: String,
    archived: bool,
    muted: bool,
    occurred_at: String,
    source: CanonicalEventSource,
}

impl MatrixRoomState {
    /// Construct a room-state snapshot.
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        room_id: impl Into<String>,
        event_id: impl Into<String>,
        sender_user_id: impl Into<String>,
        kind: MatrixRoomStateKind,
        title: impl Into<String>,
        archived: bool,
        muted: bool,
        occurred_at: impl Into<String>,
    ) -> Self {
        Self {
            room_id: room_id.into(),
            event_id: event_id.into(),
            sender_user_id: sender_user_id.into(),
            kind,
            title: title.into(),
            archived,
            muted,
            occurred_at: occurred_at.into(),
            source: CanonicalEventSource::Live,
        }
    }

    /// Mark the state event as a historical backfill event.
    pub fn with_source(mut self, source: CanonicalEventSource) -> Self {
        self.source = source;
        self
    }
}

impl fmt::Debug for MatrixRoomState {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("MatrixRoomState([REDACTED])")
    }
}

/// Membership/profile families that have a complete participant snapshot.
#[derive(Clone, Copy, Eq, PartialEq)]
pub enum MatrixMembershipKind {
    Profile,
    Joined,
    Left,
    Unsupported,
}

impl fmt::Debug for MatrixMembershipKind {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::Profile => "profile",
            Self::Joined => "joined",
            Self::Left => "left",
            Self::Unsupported => "unsupported",
        })
    }
}

/// A Matrix membership/profile event for one known participant.
pub struct MatrixMembership {
    room_id: String,
    event_id: String,
    sender_user_id: String,
    member_user_id: String,
    kind: MatrixMembershipKind,
    display_name: String,
    remote_id: Option<String>,
    avatar_url: Option<String>,
    occurred_at: String,
    source: CanonicalEventSource,
}

impl MatrixMembership {
    /// Construct a participant snapshot.
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        room_id: impl Into<String>,
        event_id: impl Into<String>,
        sender_user_id: impl Into<String>,
        member_user_id: impl Into<String>,
        kind: MatrixMembershipKind,
        display_name: impl Into<String>,
        remote_id: Option<String>,
        avatar_url: Option<String>,
        occurred_at: impl Into<String>,
    ) -> Self {
        Self {
            room_id: room_id.into(),
            event_id: event_id.into(),
            sender_user_id: sender_user_id.into(),
            member_user_id: member_user_id.into(),
            kind,
            display_name: display_name.into(),
            remote_id,
            avatar_url,
            occurred_at: occurred_at.into(),
            source: CanonicalEventSource::Live,
        }
    }

    /// Mark the membership event as a historical backfill event.
    pub fn with_source(mut self, source: CanonicalEventSource) -> Self {
        self.source = source;
        self
    }
}

impl fmt::Debug for MatrixMembership {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("MatrixMembership([REDACTED])")
    }
}

/// A relation or participant known from earlier committed events in the same
/// room and authority.
pub enum KnownRelation {
    Message {
        room_id: String,
    },
    Reaction {
        room_id: String,
        message_event_id: String,
    },
    Participant {
        room_id: String,
    },
}

impl KnownRelation {
    /// Mark a Matrix event as a known message in one room.
    pub fn message(room_id: impl Into<String>) -> Self {
        Self::Message {
            room_id: room_id.into(),
        }
    }

    /// Mark a Matrix event as a known reaction and retain its message target.
    pub fn reaction(room_id: impl Into<String>, message_event_id: impl Into<String>) -> Self {
        Self::Reaction {
            room_id: room_id.into(),
            message_event_id: message_event_id.into(),
        }
    }

    /// Mark a Matrix user as a known participant in one room.
    pub fn participant(room_id: impl Into<String>) -> Self {
        Self::Participant {
            room_id: room_id.into(),
        }
    }
}

impl fmt::Debug for KnownRelation {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("KnownRelation([REDACTED])")
    }
}

/// Known Matrix relation and participant entries keyed by their Matrix ID.
pub type KnownRelations = BTreeMap<String, KnownRelation>;

/// An event observed at the SDK-independent boundary.
pub enum ObservedMatrixEvent {
    Message(MatrixMessage),
    Redaction(MatrixRedaction),
    Reaction(MatrixReaction),
    Receipt(MatrixReceipt),
    Typing(MatrixTyping),
    RoomState(MatrixRoomState),
    Membership(MatrixMembership),
    UnableToDecrypt(MatrixUnableToDecrypt),
    LimitedTimeline {
        protected_prev_batch: ProtectedBytes,
    },
    Unsupported {
        reason_code: &'static str,
    },
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

/// A Matrix event that could not be decrypted in the current SDK state.
pub struct MatrixUnableToDecrypt {
    /// Protected material retained for a later receive-only retry window.
    pub protected_retry_material: ProtectedBytes,
    /// Upstream bounded reason, never included in formatting.
    pub reason_code: &'static str,
}

impl MatrixUnableToDecrypt {
    /// Construct an undecryptable-event marker.
    pub fn new(protected_retry_material: ProtectedBytes, reason_code: &'static str) -> Self {
        Self {
            protected_retry_material,
            reason_code,
        }
    }
}

impl fmt::Debug for MatrixUnableToDecrypt {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("MatrixUnableToDecrypt([REDACTED])")
    }
}

/// Result of pure normalization.
pub enum NormalizeOutcome {
    /// Zero or more canonical events are ready for a pending window.
    Events(Vec<ProjectionEventEnvelope>),
    /// The response must be retried after receive-only key recovery.
    RetryWindow { reason_code: &'static str },
    /// The response has a limited timeline and must be paginated backward.
    SourceGap {
        protected_prev_batch: ProtectedBytes,
    },
    /// The input is safely ignored with a bounded reason.
    Ignored { reason_code: &'static str },
}

impl NormalizeOutcome {
    /// Borrow emitted events when the outcome is successful.
    pub fn events(&self) -> Option<&[ProjectionEventEnvelope]> {
        match self {
            Self::Events(events) => Some(events),
            Self::RetryWindow { .. } | Self::SourceGap { .. } | Self::Ignored { .. } => None,
        }
    }

    /// Return a content-free reason when the outcome is not a successful event
    /// collection.
    pub const fn reason_code(&self) -> Option<&'static str> {
        match self {
            Self::Events(_) => None,
            Self::RetryWindow { reason_code } | Self::Ignored { reason_code } => Some(reason_code),
            Self::SourceGap { .. } => Some("matrix_source_gap"),
        }
    }
}

impl fmt::Debug for NormalizeOutcome {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Events(_) => formatter.write_str("NormalizeOutcome::Events([REDACTED])"),
            Self::RetryWindow { reason_code } => formatter
                .debug_struct("NormalizeOutcome::RetryWindow")
                .field("reason_code", reason_code)
                .finish(),
            Self::SourceGap { .. } => {
                formatter.write_str("NormalizeOutcome::SourceGap([REDACTED])")
            }
            Self::Ignored { reason_code } => formatter
                .debug_struct("NormalizeOutcome::Ignored")
                .field("reason_code", reason_code)
                .finish(),
        }
    }
}

impl fmt::Display for NormalizeOutcome {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Events(_) => formatter.write_str("NormalizeOutcome::Events([REDACTED])"),
            Self::RetryWindow { reason_code } | Self::Ignored { reason_code } => {
                formatter.write_str(reason_code)
            }
            Self::SourceGap { .. } => formatter.write_str("matrix_source_gap"),
        }
    }
}

impl PartialEq for NormalizeOutcome {
    fn eq(&self, other: &Self) -> bool {
        match (self, other) {
            (Self::Events(left), Self::Events(right)) => left == right,
            (Self::RetryWindow { reason_code: left }, Self::RetryWindow { reason_code: right })
            | (Self::Ignored { reason_code: left }, Self::Ignored { reason_code: right }) => {
                left == right
            }
            (
                Self::SourceGap {
                    protected_prev_batch: left,
                },
                Self::SourceGap {
                    protected_prev_batch: right,
                },
            ) => left == right,
            _ => false,
        }
    }
}

impl Eq for NormalizeOutcome {}

/// Normalize one observed Matrix event without performing I/O.
pub fn normalize(
    input: ObservedMatrixEvent,
    binding: &RoomBinding,
    known_relations: &KnownRelations,
    observed_at: DateTime<Utc>,
) -> NormalizeOutcome {
    match input {
        ObservedMatrixEvent::UnableToDecrypt(value) => {
            let _ = value.protected_retry_material.len();
            NormalizeOutcome::RetryWindow {
                reason_code: MATRIX_UNABLE_TO_DECRYPT,
            }
        }
        ObservedMatrixEvent::LimitedTimeline {
            protected_prev_batch,
        } => {
            if protected_prev_batch.is_empty() {
                NormalizeOutcome::Ignored {
                    reason_code: MATRIX_MALFORMED_EVENT,
                }
            } else {
                NormalizeOutcome::SourceGap {
                    protected_prev_batch,
                }
            }
        }
        ObservedMatrixEvent::Unsupported { reason_code } => {
            NormalizeOutcome::Ignored { reason_code }
        }
        input => {
            let Some(observed_at) = canonical_observed_at(observed_at) else {
                return NormalizeOutcome::Ignored {
                    reason_code: MATRIX_INVALID_TIMESTAMP,
                };
            };
            match input {
                ObservedMatrixEvent::Message(value) => {
                    normalize_message(value, binding, known_relations, &observed_at)
                }
                ObservedMatrixEvent::Redaction(value) => {
                    normalize_redaction(value, binding, known_relations, &observed_at)
                }
                ObservedMatrixEvent::Reaction(value) => {
                    normalize_reaction(value, binding, known_relations, &observed_at)
                }
                ObservedMatrixEvent::Receipt(value) => {
                    normalize_receipt(value, binding, known_relations, &observed_at)
                }
                ObservedMatrixEvent::Typing(value) => {
                    normalize_typing(value, binding, known_relations, &observed_at)
                }
                ObservedMatrixEvent::RoomState(value) => {
                    normalize_room_state(value, binding, known_relations, &observed_at)
                }
                ObservedMatrixEvent::Membership(value) => {
                    normalize_membership(value, binding, known_relations, &observed_at)
                }
                ObservedMatrixEvent::UnableToDecrypt(_)
                | ObservedMatrixEvent::LimitedTimeline { .. }
                | ObservedMatrixEvent::Unsupported { .. } => unreachable!(),
            }
        }
    }
}

fn ignored(reason_code: &'static str) -> NormalizeOutcome {
    NormalizeOutcome::Ignored { reason_code }
}

fn canonical_observed_at(value: DateTime<Utc>) -> Option<String> {
    let value = value.to_rfc3339_opts(SecondsFormat::Millis, true);
    model::valid_timestamp(&value).then_some(value)
}

fn canonical_occurred_at(value: &str) -> Result<String, &'static str> {
    let parsed = DateTime::parse_from_rfc3339(value)
        .map_err(|_| MATRIX_INVALID_TIMESTAMP)?
        .with_timezone(&Utc);
    let value = parsed.to_rfc3339_opts(SecondsFormat::Millis, true);
    if model::valid_timestamp(&value) {
        Ok(value)
    } else {
        Err(MATRIX_INVALID_TIMESTAMP)
    }
}

fn valid_source(source: CanonicalEventSource) -> bool {
    matches!(
        source,
        CanonicalEventSource::Live | CanonicalEventSource::Backfill
    )
}

fn valid_matrix_event_id(value: &str) -> bool {
    value.starts_with('$') && valid_text(value, 1, 1024)
}

fn valid_matrix_user_id(value: &str) -> bool {
    !value.is_empty() && value.len() <= 4096 && ruma::UserId::parse(value).is_ok()
}

fn valid_body(value: &str) -> bool {
    valid_text(value, 0, 20_000)
}

fn valid_label(value: &str) -> bool {
    valid_text(value, 1, 100)
}

fn valid_bounded_text(value: &str, max: usize) -> bool {
    valid_text(value, 1, max)
}

fn valid_text(value: &str, min_chars: usize, max_chars: usize) -> bool {
    let length = value.encode_utf16().count();
    length >= min_chars && length <= max_chars
}

fn room_matches(room_id: &str, binding: &RoomBinding) -> bool {
    binding.status() == RoomBindingStatus::Active && room_id == binding.matrix_room_id()
}

fn known_participant(
    user_id: &str,
    binding: &RoomBinding,
    known_relations: &KnownRelations,
) -> bool {
    if !valid_matrix_user_id(user_id) {
        return false;
    }
    user_id == binding.owner_matrix_user_id()
        || matches!(
            known_relations.get(user_id),
            Some(KnownRelation::Participant { room_id }) if room_id == binding.matrix_room_id()
        )
}

fn participant_for(
    user_id: &str,
    binding: &RoomBinding,
    known_relations: &KnownRelations,
) -> Result<String, &'static str> {
    if !known_participant(user_id, binding, known_relations) {
        return Err(MATRIX_UNKNOWN_SENDER);
    }
    participant_id(
        binding.tenant_id(),
        binding.platform().as_str(),
        binding.account_id(),
        user_id,
    )
    .map_err(|_| MATRIX_MALFORMED_EVENT)
}

fn known_message(
    target_event_id: &str,
    binding: &RoomBinding,
    known_relations: &KnownRelations,
) -> Option<String> {
    if !valid_matrix_event_id(target_event_id) {
        return None;
    }
    match known_relations.get(target_event_id) {
        Some(KnownRelation::Message { room_id }) if room_id == binding.matrix_room_id() => {
            message_id(binding.matrix_room_id(), target_event_id).ok()
        }
        _ => None,
    }
}

fn known_relation(
    target_event_id: &str,
    binding: &RoomBinding,
    known_relations: &KnownRelations,
) -> Option<ResolvedRelation> {
    if !valid_matrix_event_id(target_event_id) {
        return None;
    }
    match known_relations.get(target_event_id) {
        Some(KnownRelation::Message { room_id }) if room_id == binding.matrix_room_id() => Some(
            ResolvedRelation::Message(message_id(binding.matrix_room_id(), target_event_id).ok()?),
        ),
        Some(KnownRelation::Reaction {
            room_id,
            message_event_id,
        }) if room_id == binding.matrix_room_id() => {
            let message_id = known_message(message_event_id, binding, known_relations)?;
            let reaction_id = reaction_id(binding.matrix_room_id(), target_event_id).ok()?;
            Some(ResolvedRelation::Reaction {
                reaction_id,
                message_id,
            })
        }
        _ => None,
    }
}

enum ResolvedRelation {
    Message(String),
    Reaction {
        reaction_id: String,
        message_id: String,
    },
}

#[allow(clippy::too_many_arguments)]
fn make_event(
    event_id: String,
    source: CanonicalEventSource,
    binding: &RoomBinding,
    matrix_event_id: Option<&str>,
    remote_message_id: Option<String>,
    occurred_at: &str,
    observed_at: &str,
    payload: CanonicalPayload,
) -> Result<CanonicalEvent, &'static str> {
    if !valid_source(source) {
        return Err(MATRIX_MALFORMED_EVENT);
    }
    CanonicalEvent::new(
        event_id,
        source,
        binding.tenant_id(),
        binding.identity_id(),
        binding.platform(),
        binding.account_id(),
        binding.conversation_id(),
        Some(binding.matrix_room_id().to_owned()),
        matrix_event_id.map(str::to_owned),
        remote_message_id,
        occurred_at,
        observed_at,
        payload,
    )
    .map_err(|error| {
        if error.code() == "model_canonical_too_large" {
            MATRIX_METADATA_TOO_LARGE
        } else {
            MATRIX_MALFORMED_EVENT
        }
    })
}

fn normalize_message(
    value: MatrixMessage,
    binding: &RoomBinding,
    known_relations: &KnownRelations,
    observed_at: &str,
) -> NormalizeOutcome {
    if !room_matches(&value.room_id, binding) {
        return ignored(MATRIX_UNKNOWN_ROOM);
    }
    if !value.kind.is_supported() {
        return ignored(MATRIX_UNSUPPORTED_MESSAGE_TYPE);
    }
    if !valid_matrix_event_id(&value.event_id) || !valid_label(&value.sender_label) {
        return ignored(MATRIX_MALFORMED_EVENT);
    }
    if !valid_body(&value.body) {
        return ignored(MATRIX_BODY_TOO_LARGE);
    }
    let sender_participant_id =
        match participant_for(&value.sender_user_id, binding, known_relations) {
            Ok(value) => value,
            Err(reason_code) => return ignored(reason_code),
        };
    let occurred_at = match canonical_occurred_at(&value.occurred_at) {
        Ok(value) => value,
        Err(reason_code) => return ignored(reason_code),
    };
    if value
        .remote_message_id
        .as_deref()
        .is_some_and(|value| value.trim().is_empty())
    {
        return ignored(MATRIX_MALFORMED_EVENT);
    }

    let relation_target = match value.relation.as_ref() {
        Some(MatrixRelation::Reply { target_event_id })
        | Some(MatrixRelation::Replace { target_event_id }) => {
            match known_message(target_event_id, binding, known_relations) {
                Some(message_id) => Some(message_id),
                None => return ignored(MATRIX_MISSING_RELATION_TARGET),
            }
        }
        None => None,
    };
    let message_id = match message_id(binding.matrix_room_id(), &value.event_id) {
        Ok(value) => value,
        Err(_) => return ignored(MATRIX_MALFORMED_EVENT),
    };
    let direction = if value.sender_user_id == binding.owner_matrix_user_id() {
        Direction::Outbound
    } else {
        Direction::Inbound
    };
    let payload = match value.relation {
        Some(MatrixRelation::Replace { .. }) => {
            CanonicalPayload::MessageEdited(MessageEditedPayload {
                message_id: relation_target.expect("replace relation target is resolved"),
                body: value.body,
                editor_participant_id: Some(sender_participant_id),
            })
        }
        Some(MatrixRelation::Reply { .. }) | None => {
            CanonicalPayload::MessageCreated(MessageCreatedPayload {
                message_id,
                direction,
                sender_participant_id: Some(sender_participant_id),
                sender_label: value.sender_label,
                body: value.body,
                reply_to_message_id: relation_target,
                delivery_status: if direction == Direction::Outbound {
                    DeliveryStatus::Sent
                } else {
                    DeliveryStatus::Unknown
                },
                unread: direction == Direction::Inbound,
            })
        }
    };
    let event_type = payload.event_type();
    let event_id = match durable_event_id(&value.event_id, event_type, 0_u32) {
        Ok(value) => value,
        Err(_) => return ignored(MATRIX_MALFORMED_EVENT),
    };
    let remote_message_id = if matches!(payload, CanonicalPayload::MessageCreated(_)) {
        value.remote_message_id
    } else {
        None
    };
    let message_event = match make_event(
        event_id,
        value.source,
        binding,
        Some(&value.event_id),
        remote_message_id,
        &occurred_at,
        observed_at,
        payload,
    ) {
        Ok(value) => value,
        Err(reason_code) => return ignored(reason_code),
    };

    let mut events = vec![message_event];
    if value.attachments.len() > MAX_MESSAGE_ATTACHMENTS {
        return ignored(MATRIX_METADATA_TOO_LARGE);
    }
    for (ordinal, attachment) in value.attachments.into_iter().enumerate() {
        if attachment
            .file_name
            .as_deref()
            .is_some_and(|value| !valid_text(value, 0, 255))
            || attachment
                .mime_type
                .as_deref()
                .is_some_and(|value| !valid_text(value, 1, 255))
        {
            return ignored(MATRIX_METADATA_TOO_LARGE);
        }
        if attachment.sha256.as_deref().is_some_and(|value| {
            value.len() != 64
                || value
                    .bytes()
                    .any(|byte| !matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
        }) {
            return ignored(MATRIX_MALFORMED_EVENT);
        }
        let attachment_id = match attachment_id(&events[0].payload_message_id(), ordinal as u32) {
            Ok(value) => value,
            Err(_) => return ignored(MATRIX_MALFORMED_EVENT),
        };
        let payload = CanonicalPayload::AttachmentObserved(AttachmentObservedPayload {
            attachment_id,
            message_id: events[0].payload_message_id(),
            file_name: attachment.file_name,
            mime_type: attachment.mime_type,
            size_bytes: attachment.size_bytes,
            sha256: attachment.sha256,
            r2_key: None,
        });
        let event_id = match durable_event_id(
            &value.event_id,
            CanonicalEventType::AttachmentObserved,
            ordinal as u32,
        ) {
            Ok(value) => value,
            Err(_) => return ignored(MATRIX_MALFORMED_EVENT),
        };
        let event = match make_event(
            event_id,
            value.source,
            binding,
            Some(&value.event_id),
            None,
            &occurred_at,
            observed_at,
            payload,
        ) {
            Ok(value) => value,
            Err(reason_code) => return ignored(reason_code),
        };
        events.push(event);
    }
    NormalizeOutcome::Events(events)
}

fn normalize_redaction(
    value: MatrixRedaction,
    binding: &RoomBinding,
    known_relations: &KnownRelations,
    observed_at: &str,
) -> NormalizeOutcome {
    if !room_matches(&value.room_id, binding) {
        return ignored(MATRIX_UNKNOWN_ROOM);
    }
    if !valid_matrix_event_id(&value.event_id) || !valid_matrix_event_id(&value.target_event_id) {
        return ignored(MATRIX_MALFORMED_EVENT);
    }
    if !known_participant(&value.sender_user_id, binding, known_relations) {
        return ignored(MATRIX_UNKNOWN_SENDER);
    }
    if value
        .reason_code
        .as_deref()
        .is_some_and(|value| !valid_bounded_text(value, 100))
    {
        return ignored(MATRIX_MALFORMED_EVENT);
    }
    let occurred_at = match canonical_occurred_at(&value.occurred_at) {
        Ok(value) => value,
        Err(reason_code) => return ignored(reason_code),
    };
    let relation = match known_relation(&value.target_event_id, binding, known_relations) {
        Some(value) => value,
        None => return ignored(MATRIX_MISSING_RELATION_TARGET),
    };
    let (payload, event_type) = match relation {
        ResolvedRelation::Message(message_id) => (
            CanonicalPayload::MessageDeleted(MessageDeletedPayload {
                message_id,
                reason_code: value.reason_code,
            }),
            CanonicalEventType::MessageDeleted,
        ),
        ResolvedRelation::Reaction {
            reaction_id,
            message_id,
        } => (
            CanonicalPayload::ReactionRemoved(ReactionRemovedPayload {
                reaction_id,
                message_id,
            }),
            CanonicalEventType::ReactionRemoved,
        ),
    };
    let event_id = match durable_event_id(&value.event_id, event_type, 0_u32) {
        Ok(value) => value,
        Err(_) => return ignored(MATRIX_MALFORMED_EVENT),
    };
    match make_event(
        event_id,
        value.source,
        binding,
        Some(&value.event_id),
        None,
        &occurred_at,
        observed_at,
        payload,
    ) {
        Ok(value) => NormalizeOutcome::Events(vec![value]),
        Err(reason_code) => ignored(reason_code),
    }
}

fn normalize_reaction(
    value: MatrixReaction,
    binding: &RoomBinding,
    known_relations: &KnownRelations,
    observed_at: &str,
) -> NormalizeOutcome {
    if !room_matches(&value.room_id, binding) {
        return ignored(MATRIX_UNKNOWN_ROOM);
    }
    if !valid_matrix_event_id(&value.event_id) || !valid_matrix_event_id(&value.target_event_id) {
        return ignored(MATRIX_MALFORMED_EVENT);
    }
    if !known_participant(&value.sender_user_id, binding, known_relations) {
        return ignored(MATRIX_UNKNOWN_SENDER);
    }
    if !valid_bounded_text(&value.emoji, 64) {
        return ignored(MATRIX_MALFORMED_EVENT);
    }
    let occurred_at = match canonical_occurred_at(&value.occurred_at) {
        Ok(value) => value,
        Err(reason_code) => return ignored(reason_code),
    };
    let message_id = match known_message(&value.target_event_id, binding, known_relations) {
        Some(value) => value,
        None => return ignored(MATRIX_MISSING_RELATION_TARGET),
    };
    let participant_id = match participant_for(&value.sender_user_id, binding, known_relations) {
        Ok(value) => value,
        Err(reason_code) => return ignored(reason_code),
    };
    let reaction_id = match reaction_id(binding.matrix_room_id(), &value.event_id) {
        Ok(value) => value,
        Err(_) => return ignored(MATRIX_MALFORMED_EVENT),
    };
    let payload = CanonicalPayload::ReactionAdded(ReactionAddedPayload {
        reaction_id,
        message_id,
        participant_id,
        emoji: value.emoji,
    });
    let event_id = match durable_event_id(&value.event_id, CanonicalEventType::ReactionAdded, 0_u32)
    {
        Ok(value) => value,
        Err(_) => return ignored(MATRIX_MALFORMED_EVENT),
    };
    match make_event(
        event_id,
        value.source,
        binding,
        Some(&value.event_id),
        None,
        &occurred_at,
        observed_at,
        payload,
    ) {
        Ok(value) => NormalizeOutcome::Events(vec![value]),
        Err(reason_code) => ignored(reason_code),
    }
}

fn normalize_receipt(
    value: MatrixReceipt,
    binding: &RoomBinding,
    known_relations: &KnownRelations,
    observed_at: &str,
) -> NormalizeOutcome {
    if !room_matches(&value.room_id, binding) {
        return ignored(MATRIX_UNKNOWN_ROOM);
    }
    if !valid_matrix_event_id(&value.target_event_id) {
        return ignored(MATRIX_MALFORMED_EVENT);
    }
    let participant_id = match participant_for(&value.sender_user_id, binding, known_relations) {
        Ok(value) => value,
        Err(reason_code) => return ignored(reason_code),
    };
    let message_id = match known_message(&value.target_event_id, binding, known_relations) {
        Some(value) => value,
        None => return ignored(MATRIX_MISSING_RELATION_TARGET),
    };
    let occurred_at = match canonical_occurred_at(&value.occurred_at) {
        Ok(value) => value,
        Err(reason_code) => return ignored(reason_code),
    };
    let event_type = match value.receipt_type {
        MatrixReceiptType::Read => CanonicalEventType::ReceiptRead,
        MatrixReceiptType::Delivered => CanonicalEventType::ReceiptDelivered,
    };
    let source_key = match receipt_source_key(
        binding.matrix_room_id(),
        &value.target_event_id,
        &participant_id,
        value.receipt_type.as_str(),
    ) {
        Ok(value) => value,
        Err(_) => return ignored(MATRIX_MALFORMED_EVENT),
    };
    let event_id = match durable_event_id(&source_key, event_type, 0_u32) {
        Ok(value) => value,
        Err(_) => return ignored(MATRIX_MALFORMED_EVENT),
    };
    let payload = match value.receipt_type {
        MatrixReceiptType::Read => CanonicalPayload::ReceiptRead(ReceiptPayload {
            message_id,
            participant_id,
            local_identity: value.sender_user_id == binding.owner_matrix_user_id(),
        }),
        MatrixReceiptType::Delivered => CanonicalPayload::ReceiptDelivered(ReceiptPayload {
            message_id,
            participant_id,
            local_identity: value.sender_user_id == binding.owner_matrix_user_id(),
        }),
    };
    match make_event(
        event_id,
        value.source,
        binding,
        None,
        None,
        &occurred_at,
        observed_at,
        payload,
    ) {
        Ok(value) => NormalizeOutcome::Events(vec![value]),
        Err(reason_code) => ignored(reason_code),
    }
}

fn normalize_typing(
    value: MatrixTyping,
    binding: &RoomBinding,
    known_relations: &KnownRelations,
    observed_at: &str,
) -> NormalizeOutcome {
    if !room_matches(&value.room_id, binding) || value.checkpoint_digest.is_empty() {
        return ignored(if value.room_id == binding.matrix_room_id() {
            MATRIX_MALFORMED_EVENT
        } else {
            MATRIX_UNKNOWN_ROOM
        });
    }
    let current = match typing_participants(&value.members, binding, known_relations) {
        Ok(value) => value,
        Err(reason_code) => return ignored(reason_code),
    };
    let previous = match typing_participants(&value.previous_members, binding, known_relations) {
        Ok(value) => value,
        Err(reason_code) => return ignored(reason_code),
    };
    let expiry = match DateTime::parse_from_rfc3339(observed_at)
        .ok()
        .and_then(|value| {
            value
                .with_timezone(&Utc)
                .checked_add_signed(Duration::seconds(30))
        }) {
        Some(value) => value.to_rfc3339_opts(SecondsFormat::Millis, true),
        None => return ignored(MATRIX_INVALID_TIMESTAMP),
    };
    let mut events = Vec::new();
    for participant in current
        .iter()
        .filter(|participant| !previous.contains(*participant))
    {
        let source_key = match typing_source_key(
            &value.checkpoint_digest,
            binding.matrix_room_id(),
            participant,
            "started",
        ) {
            Ok(value) => value,
            Err(_) => return ignored(MATRIX_MALFORMED_EVENT),
        };
        let event_id = match durable_event_id(&source_key, CanonicalEventType::TypingStarted, 0_u32)
        {
            Ok(value) => value,
            Err(_) => return ignored(MATRIX_MALFORMED_EVENT),
        };
        let payload = CanonicalPayload::TypingStarted(TypingStartedPayload {
            participant_id: participant.clone(),
            expires_at: expiry.clone(),
        });
        let event = match make_event(
            event_id,
            value.source,
            binding,
            None,
            None,
            observed_at,
            observed_at,
            payload,
        ) {
            Ok(value) => value,
            Err(reason_code) => return ignored(reason_code),
        };
        events.push(event);
    }
    for participant in previous
        .iter()
        .filter(|participant| !current.contains(*participant))
    {
        let source_key = match typing_source_key(
            &value.checkpoint_digest,
            binding.matrix_room_id(),
            participant,
            "stopped",
        ) {
            Ok(value) => value,
            Err(_) => return ignored(MATRIX_MALFORMED_EVENT),
        };
        let event_id = match durable_event_id(&source_key, CanonicalEventType::TypingStopped, 0_u32)
        {
            Ok(value) => value,
            Err(_) => return ignored(MATRIX_MALFORMED_EVENT),
        };
        let payload = CanonicalPayload::TypingStopped(TypingStoppedPayload {
            participant_id: participant.clone(),
        });
        let event = match make_event(
            event_id,
            value.source,
            binding,
            None,
            None,
            observed_at,
            observed_at,
            payload,
        ) {
            Ok(value) => value,
            Err(reason_code) => return ignored(reason_code),
        };
        events.push(event);
    }
    if events.is_empty() {
        ignored(MATRIX_TYPING_UNCHANGED)
    } else {
        NormalizeOutcome::Events(events)
    }
}

fn typing_participants(
    values: &[String],
    binding: &RoomBinding,
    known_relations: &KnownRelations,
) -> Result<Vec<String>, &'static str> {
    let mut participants = Vec::with_capacity(values.len());
    for user_id in values {
        let participant = participant_for(user_id, binding, known_relations)?;
        participants.push(participant);
    }
    participants.sort();
    participants.dedup();
    Ok(participants)
}

fn normalize_room_state(
    value: MatrixRoomState,
    binding: &RoomBinding,
    known_relations: &KnownRelations,
    observed_at: &str,
) -> NormalizeOutcome {
    if !room_matches(&value.room_id, binding) {
        return ignored(MATRIX_UNKNOWN_ROOM);
    }
    if value.kind == MatrixRoomStateKind::Unsupported {
        return ignored(MATRIX_UNSUPPORTED_STATE);
    }
    if !valid_matrix_event_id(&value.event_id)
        || !known_participant(&value.sender_user_id, binding, known_relations)
    {
        return ignored(if valid_matrix_event_id(&value.event_id) {
            MATRIX_UNKNOWN_SENDER
        } else {
            MATRIX_MALFORMED_EVENT
        });
    }
    if !valid_text(&value.title, 1, 200) {
        return ignored(MATRIX_METADATA_TOO_LARGE);
    }
    let occurred_at = match canonical_occurred_at(&value.occurred_at) {
        Ok(value) => value,
        Err(reason_code) => return ignored(reason_code),
    };
    let payload = CanonicalPayload::ConversationUpdated(ConversationUpdatedPayload {
        title: value.title,
        archived: value.archived,
        muted: value.muted,
    });
    let event_id = match durable_event_id(
        &value.event_id,
        CanonicalEventType::ConversationUpdated,
        0_u32,
    ) {
        Ok(value) => value,
        Err(_) => return ignored(MATRIX_MALFORMED_EVENT),
    };
    match make_event(
        event_id,
        value.source,
        binding,
        Some(&value.event_id),
        None,
        &occurred_at,
        observed_at,
        payload,
    ) {
        Ok(value) => NormalizeOutcome::Events(vec![value]),
        Err(reason_code) => ignored(reason_code),
    }
}

fn normalize_membership(
    value: MatrixMembership,
    binding: &RoomBinding,
    known_relations: &KnownRelations,
    observed_at: &str,
) -> NormalizeOutcome {
    if !room_matches(&value.room_id, binding) {
        return ignored(MATRIX_UNKNOWN_ROOM);
    }
    if value.kind == MatrixMembershipKind::Unsupported {
        return ignored(MATRIX_UNSUPPORTED_STATE);
    }
    if !valid_matrix_event_id(&value.event_id) {
        return ignored(MATRIX_MALFORMED_EVENT);
    }
    if !known_participant(&value.sender_user_id, binding, known_relations)
        || !known_participant(&value.member_user_id, binding, known_relations)
    {
        return ignored(MATRIX_UNKNOWN_SENDER);
    }
    if !valid_text(&value.display_name, 1, 100) {
        return ignored(MATRIX_METADATA_TOO_LARGE);
    }
    if value
        .remote_id
        .as_deref()
        .is_some_and(|value| !valid_text(value, 1, 1024))
        || value
            .avatar_url
            .as_deref()
            .is_some_and(|value| !valid_text(value, 1, 2048))
    {
        return ignored(MATRIX_METADATA_TOO_LARGE);
    }
    let occurred_at = match canonical_occurred_at(&value.occurred_at) {
        Ok(value) => value,
        Err(reason_code) => return ignored(reason_code),
    };
    let participant_id = match participant_for(&value.member_user_id, binding, known_relations) {
        Ok(value) => value,
        Err(reason_code) => return ignored(reason_code),
    };
    let payload = CanonicalPayload::ParticipantUpdated(ParticipantUpdatedPayload {
        participant_id,
        display_name: value.display_name,
        remote_id: value.remote_id,
        avatar_url: value.avatar_url,
    });
    let event_id = match durable_event_id(
        &value.event_id,
        CanonicalEventType::ParticipantUpdated,
        0_u32,
    ) {
        Ok(value) => value,
        Err(_) => return ignored(MATRIX_MALFORMED_EVENT),
    };
    match make_event(
        event_id,
        value.source,
        binding,
        Some(&value.event_id),
        None,
        &occurred_at,
        observed_at,
        payload,
    ) {
        Ok(value) => NormalizeOutcome::Events(vec![value]),
        Err(reason_code) => ignored(reason_code),
    }
}

trait EventMessageId {
    fn payload_message_id(&self) -> String;
}

impl EventMessageId for CanonicalEvent {
    fn payload_message_id(&self) -> String {
        match &self.payload {
            CanonicalPayload::MessageCreated(value) => value.message_id.clone(),
            CanonicalPayload::MessageEdited(value) => value.message_id.clone(),
            _ => String::new(),
        }
    }
}
