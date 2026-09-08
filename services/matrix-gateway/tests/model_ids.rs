use communicator_matrix_gateway::model::{
    CanonicalEventSource, CanonicalEventType, attachment_id, durable_event_id, message_id,
    participant_id, reaction_id, receipt_source_key, typing_source_key,
};

const EVENT_TYPES: [&str; 17] = [
    "message.created",
    "message.edited",
    "message.deleted",
    "reaction.added",
    "reaction.removed",
    "receipt.read",
    "receipt.delivered",
    "typing.started",
    "typing.stopped",
    "attachment.observed",
    "conversation.updated",
    "participant.updated",
    "command.updated",
    "bridge.delivery.updated",
    "replay.tombstone",
    "correction.applied",
    "deletion.tombstone",
];

const EVENT_SOURCES: [&str; 6] = [
    "live",
    "backfill",
    "command_result",
    "replay",
    "correction",
    "deletion",
];

#[test]
fn message_id_uses_length_prefixed_framing() {
    let first = message_id("ab", "c").expect("valid message tuple");
    let second = message_id("a", "bc").expect("valid message tuple");

    assert_ne!(first, second);
    assert_eq!(first, message_id("ab", "c").expect("valid message tuple"));
    assert!(first.starts_with("message_"));
    assert_eq!(first.len(), "message_".len() + 64);
    assert!(
        first["message_".len()..]
            .bytes()
            .all(|byte: u8| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
    );
}

#[test]
fn participant_id_is_deterministic_for_the_full_authority_tuple() {
    let id = participant_id("tenant_a", "telegram", "account_a", "@alice:example.org")
        .expect("valid participant tuple");

    assert_eq!(
        id,
        participant_id("tenant_a", "telegram", "account_a", "@alice:example.org")
            .expect("valid participant tuple")
    );
    assert_ne!(
        id,
        participant_id("tenant_b", "telegram", "account_a", "@alice:example.org")
            .expect("valid participant tuple")
    );
    assert!(id.starts_with("participant_"));
    assert_eq!(id.len(), "participant_".len() + 64);
}

#[test]
fn canonical_event_type_and_source_conversions_are_exact() {
    let event_types = [
        CanonicalEventType::MessageCreated,
        CanonicalEventType::MessageEdited,
        CanonicalEventType::MessageDeleted,
        CanonicalEventType::ReactionAdded,
        CanonicalEventType::ReactionRemoved,
        CanonicalEventType::ReceiptRead,
        CanonicalEventType::ReceiptDelivered,
        CanonicalEventType::TypingStarted,
        CanonicalEventType::TypingStopped,
        CanonicalEventType::AttachmentObserved,
        CanonicalEventType::ConversationUpdated,
        CanonicalEventType::ParticipantUpdated,
        CanonicalEventType::CommandUpdated,
        CanonicalEventType::BridgeDeliveryUpdated,
        CanonicalEventType::ReplayTombstone,
        CanonicalEventType::CorrectionApplied,
        CanonicalEventType::DeletionTombstone,
    ];
    let event_sources = [
        CanonicalEventSource::Live,
        CanonicalEventSource::Backfill,
        CanonicalEventSource::CommandResult,
        CanonicalEventSource::Replay,
        CanonicalEventSource::Correction,
        CanonicalEventSource::Deletion,
    ];

    assert_eq!(event_types.map(CanonicalEventType::as_str), EVENT_TYPES);
    assert_eq!(
        event_sources.map(CanonicalEventSource::as_str),
        EVENT_SOURCES
    );
    for value in EVENT_TYPES {
        let parsed = value
            .parse::<CanonicalEventType>()
            .expect("known event type");
        assert_eq!(parsed.as_str(), value);
        assert_eq!(parsed.to_string(), value);
    }
    for value in EVENT_SOURCES {
        let parsed = value
            .parse::<CanonicalEventSource>()
            .expect("known event source");
        assert_eq!(parsed.as_str(), value);
        assert_eq!(parsed.to_string(), value);
    }
}

#[test]
fn durable_event_id_uses_the_versioned_source_tuple() {
    let id = durable_event_id("$event:example", CanonicalEventType::MessageCreated, 0_u32)
        .expect("valid durable tuple");

    assert_eq!(
        id,
        "evt_12412fd87a56d94fe96e392baece00d596737bd3d66713417a4988f6e473ae85"
    );
    assert_eq!(
        id,
        durable_event_id("$event:example", CanonicalEventType::MessageCreated, 0)
            .expect("valid durable tuple")
    );
    assert_ne!(
        id,
        durable_event_id("$event:example", CanonicalEventType::MessageCreated, 1)
            .expect("valid durable tuple")
    );
    assert!(
        id["evt_".len()..]
            .bytes()
            .all(|byte: u8| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
    );
}

#[test]
fn receipt_and_typing_source_keys_hash_their_full_tuples() {
    let receipt = receipt_source_key("!room:example", "$target:event", "participant_x", "read")
        .expect("valid receipt tuple");
    let typing = typing_source_key(
        "checkpoint-digest",
        "!room:example",
        "participant_x",
        "started",
    )
    .expect("valid typing tuple");

    assert_eq!(
        receipt,
        "receipt_5998500800a6b0f3e5aca92f39f36ccd71bfdadd8a0e57a5ab38c0a7dc7264be"
    );
    assert_eq!(
        typing,
        "typing_aa79636c29a7798a2575dc904cd8c47cf63e177b08ab61519ea8eec4c326b998"
    );
    assert_ne!(
        receipt,
        receipt_source_key("!room:example", "$target:other", "participant_x", "read")
            .expect("valid receipt tuple")
    );
    assert_ne!(
        typing,
        typing_source_key(
            "other-checkpoint",
            "!room:example",
            "participant_x",
            "started",
        )
        .expect("valid typing tuple")
    );
}

#[test]
fn reaction_and_attachment_ids_use_framed_tuples() {
    let reaction = reaction_id("!room:example", "$reaction:event").expect("valid reaction tuple");
    let attachment = attachment_id("message_x", 0_u32).expect("valid attachment tuple");

    assert_eq!(
        reaction,
        "reaction_d71c79c1a15c7f0b408847ca58d72cfaa5854c9f8fe6d79d770628962b5b80d0"
    );
    assert_eq!(
        attachment,
        "attachment_ca601772ddd56a2a0f9bfc029499bbf747cda94681f8648b4bd5da292005b3ce"
    );
    assert_ne!(
        attachment,
        attachment_id("message_x", 1).expect("valid attachment tuple")
    );
}

#[test]
fn tuple_inputs_reject_empty_fields_and_numeric_overflow() {
    assert!(message_id("", "event").is_err());
    assert!(reaction_id("room", "").is_err());
    assert!(receipt_source_key("room", "event", "participant", "").is_err());
    assert!(typing_source_key("checkpoint", "room", "participant", "").is_err());
    assert!(attachment_id("message", u64::from(u32::MAX) + 1).is_err());
    assert!(
        durable_event_id(
            "event",
            CanonicalEventType::MessageCreated,
            u64::from(u32::MAX) + 1
        )
        .is_err()
    );
}
