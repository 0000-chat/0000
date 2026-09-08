use communicator_matrix_gateway::model::{
    AttachmentObservedPayload, CanonicalEvent, CanonicalEventSource, CanonicalEventType,
    CanonicalPayload, CommandStatus, CommandUpdatedPayload, ConversationUpdatedPayload,
    DeletionTombstonePayload, DeliveryMode, DeliveryStatus, Direction, MessageCreatedPayload,
    MessageDeletedPayload, MessageEditedPayload, ParticipantUpdatedPayload, Provider,
    ReactionAddedPayload, ReactionRemovedPayload, ReceiptPayload, ResourceType,
    TypingStartedPayload, TypingStoppedPayload,
};

fn base_event(payload: CanonicalPayload) -> CanonicalEvent {
    CanonicalEvent::new(
        "evt_fixture",
        CanonicalEventSource::Live,
        "tenant_fixture",
        "identity_fixture",
        Provider::Telegram,
        "account_fixture",
        "conversation_fixture",
        Some("!room:example.org".into()),
        Some("$event:example.org".into()),
        Some("remote_fixture".into()),
        "2026-09-09T01:02:03.000Z",
        "2026-09-09T01:02:04.000Z",
        payload,
    )
    .expect("fixture event is valid")
}

fn valid_payloads() -> Vec<(CanonicalEventType, CanonicalPayload)> {
    vec![
        (
            CanonicalEventType::MessageCreated,
            CanonicalPayload::MessageCreated(MessageCreatedPayload {
                message_id: "message_fixture".into(),
                direction: Direction::Inbound,
                sender_participant_id: Some("participant_fixture".into()),
                sender_label: "Fixture sender".into(),
                body: "hello".into(),
                reply_to_message_id: None,
                delivery_status: DeliveryStatus::Accepted,
                unread: true,
            }),
        ),
        (
            CanonicalEventType::MessageEdited,
            CanonicalPayload::MessageEdited(MessageEditedPayload {
                message_id: "message_fixture".into(),
                body: "edited".into(),
                editor_participant_id: None,
            }),
        ),
        (
            CanonicalEventType::MessageDeleted,
            CanonicalPayload::MessageDeleted(MessageDeletedPayload {
                message_id: "message_fixture".into(),
                reason_code: Some("moderation".into()),
            }),
        ),
        (
            CanonicalEventType::ReactionAdded,
            CanonicalPayload::ReactionAdded(ReactionAddedPayload {
                reaction_id: "reaction_fixture".into(),
                message_id: "message_fixture".into(),
                participant_id: "participant_fixture".into(),
                emoji: "👍".into(),
            }),
        ),
        (
            CanonicalEventType::ReactionRemoved,
            CanonicalPayload::ReactionRemoved(ReactionRemovedPayload {
                reaction_id: "reaction_fixture".into(),
                message_id: "message_fixture".into(),
            }),
        ),
        (
            CanonicalEventType::ReceiptRead,
            CanonicalPayload::ReceiptRead(ReceiptPayload {
                message_id: "message_fixture".into(),
                participant_id: "participant_fixture".into(),
                local_identity: true,
            }),
        ),
        (
            CanonicalEventType::ReceiptDelivered,
            CanonicalPayload::ReceiptDelivered(ReceiptPayload {
                message_id: "message_fixture".into(),
                participant_id: "participant_fixture".into(),
                local_identity: false,
            }),
        ),
        (
            CanonicalEventType::TypingStarted,
            CanonicalPayload::TypingStarted(TypingStartedPayload {
                participant_id: "participant_fixture".into(),
                expires_at: "2026-09-09T01:02:34.000Z".into(),
            }),
        ),
        (
            CanonicalEventType::TypingStopped,
            CanonicalPayload::TypingStopped(TypingStoppedPayload {
                participant_id: "participant_fixture".into(),
            }),
        ),
        (
            CanonicalEventType::AttachmentObserved,
            CanonicalPayload::AttachmentObserved(AttachmentObservedPayload {
                attachment_id: "attachment_fixture".into(),
                message_id: "message_fixture".into(),
                file_name: Some("photo.jpg".into()),
                mime_type: Some("image/jpeg".into()),
                size_bytes: Some(42),
                sha256: Some("a".repeat(64)),
                r2_key: Some("attachments/fixture".into()),
            }),
        ),
        (
            CanonicalEventType::ConversationUpdated,
            CanonicalPayload::ConversationUpdated(ConversationUpdatedPayload {
                title: "Fixture conversation".into(),
                archived: false,
                muted: false,
            }),
        ),
        (
            CanonicalEventType::ParticipantUpdated,
            CanonicalPayload::ParticipantUpdated(ParticipantUpdatedPayload {
                participant_id: "participant_fixture".into(),
                display_name: "Fixture participant".into(),
                remote_id: Some("remote_fixture".into()),
                avatar_url: Some("https://example.org/avatar".into()),
            }),
        ),
        (
            CanonicalEventType::CommandUpdated,
            CanonicalPayload::CommandUpdated(CommandUpdatedPayload {
                command_id: "command_fixture".into(),
                operation: "message.send".into(),
                delivery_mode: DeliveryMode::Direct,
                status: CommandStatus::Accepted,
                failure_code: None,
            }),
        ),
        (
            CanonicalEventType::BridgeDeliveryUpdated,
            CanonicalPayload::BridgeDeliveryUpdated(
                communicator_matrix_gateway::model::BridgeDeliveryUpdatedPayload {
                    message_id: "message_fixture".into(),
                    delivery_status: DeliveryStatus::Delivered,
                    failure_code: None,
                },
            ),
        ),
        (
            CanonicalEventType::ReplayTombstone,
            CanonicalPayload::ReplayTombstone(
                communicator_matrix_gateway::model::EventMarkerPayload {
                    target_event_id: "$target:example.org".into(),
                    reason_code: "replayed".into(),
                },
            ),
        ),
        (
            CanonicalEventType::CorrectionApplied,
            CanonicalPayload::CorrectionApplied(
                communicator_matrix_gateway::model::EventMarkerPayload {
                    target_event_id: "$target:example.org".into(),
                    reason_code: "corrected".into(),
                },
            ),
        ),
        (
            CanonicalEventType::DeletionTombstone,
            CanonicalPayload::DeletionTombstone(DeletionTombstonePayload {
                resource_type: ResourceType::Message,
                resource_id: "message_fixture".into(),
                reason_code: "retention".into(),
            }),
        ),
    ]
}

#[test]
fn every_projection_payload_round_trips_with_its_derived_event_type() {
    for (expected_type, payload) in valid_payloads() {
        let event = base_event(payload);
        assert_eq!(event.event_type(), expected_type);
        let encoded = serde_json::to_vec(&event).expect("event serializes");
        let decoded: CanonicalEvent = serde_json::from_slice(&encoded).expect("event parses");
        assert_eq!(decoded, event);
        assert_eq!(decoded.event_type(), expected_type);
    }
}

#[test]
fn canonical_event_rejects_wrong_payload_event_type_pairing_and_unknown_keys() {
    let event = base_event(CanonicalPayload::MessageCreated(MessageCreatedPayload {
        message_id: "message_fixture".into(),
        direction: Direction::Inbound,
        sender_participant_id: None,
        sender_label: "Fixture sender".into(),
        body: "hello".into(),
        reply_to_message_id: None,
        delivery_status: DeliveryStatus::Unknown,
        unread: true,
    }));
    let mut value: serde_json::Value =
        serde_json::from_slice(&serde_json::to_vec(&event).expect("event serializes"))
            .expect("event is JSON");
    value["event_type"] = serde_json::Value::String("message.edited".into());
    assert!(serde_json::from_value::<CanonicalEvent>(value.clone()).is_err());
    value["payload"]["unexpected"] = serde_json::Value::Bool(true);
    assert!(serde_json::from_value::<CanonicalEvent>(value).is_err());
}

#[test]
fn canonical_event_enforces_envelope_and_projection_bounds_without_floats() {
    let event = base_event(CanonicalPayload::AttachmentObserved(
        AttachmentObservedPayload {
            attachment_id: "attachment_fixture".into(),
            message_id: "message_fixture".into(),
            file_name: None,
            mime_type: Some("image/jpeg".into()),
            size_bytes: Some(42),
            sha256: None,
            r2_key: None,
        },
    ));
    let mut value: serde_json::Value =
        serde_json::from_slice(&serde_json::to_vec(&event).expect("event serializes"))
            .expect("event is JSON");
    value["payload"]["size_bytes"] = serde_json::json!(1.5);
    assert!(serde_json::from_value::<CanonicalEvent>(value).is_err());

    let mut invalid = serde_json::to_value(&event).expect("event is JSON");
    invalid["schema_version"] = serde_json::json!(2);
    assert!(serde_json::from_value::<CanonicalEvent>(invalid).is_err());
}

#[test]
fn ordering_key_is_observed_then_occurred_then_event_id() {
    let event = base_event(CanonicalPayload::TypingStopped(TypingStoppedPayload {
        participant_id: "participant_fixture".into(),
    }));
    assert_eq!(
        event.ordering_key(),
        (
            "2026-09-09T01:02:04.000Z",
            "2026-09-09T01:02:03.000Z",
            "evt_fixture",
        )
    );
}

#[test]
fn protected_event_values_are_redacted_from_debug_and_errors() {
    let event = base_event(CanonicalPayload::MessageEdited(MessageEditedPayload {
        message_id: "message_fixture".into(),
        body: "body-canary".into(),
        editor_participant_id: None,
    }));
    let debug = format!("{event:?}");
    assert!(!debug.contains("body-canary"));
    assert!(!format!("{}", event).contains("body-canary"));

    let error = CanonicalEvent::new(
        "",
        CanonicalEventSource::Live,
        "tenant_fixture",
        "identity_fixture",
        Provider::Telegram,
        "account_fixture",
        "conversation_fixture",
        None,
        None,
        None,
        "2026-09-09T01:02:03.000Z",
        "2026-09-09T01:02:04.000Z",
        CanonicalPayload::TypingStopped(TypingStoppedPayload {
            participant_id: "body-canary".into(),
        }),
    )
    .expect_err("empty event ID is invalid");
    assert!(!format!("{error:?}").contains("body-canary"));
    assert!(!error.to_string().contains("body-canary"));
}

#[test]
fn nullable_fields_are_required_but_accept_explicit_null() {
    let nullable_payload_fields: [(&str, &[&str]); 17] = [
        (
            "message.created",
            &["sender_participant_id", "reply_to_message_id"],
        ),
        ("message.edited", &["editor_participant_id"]),
        ("message.deleted", &["reason_code"]),
        ("reaction.added", &[]),
        ("reaction.removed", &[]),
        ("receipt.read", &[]),
        ("receipt.delivered", &[]),
        ("typing.started", &[]),
        ("typing.stopped", &[]),
        (
            "attachment.observed",
            &["file_name", "mime_type", "size_bytes", "sha256", "r2_key"],
        ),
        ("conversation.updated", &[]),
        ("participant.updated", &["remote_id", "avatar_url"]),
        ("command.updated", &["failure_code"]),
        ("bridge.delivery.updated", &["failure_code"]),
        ("replay.tombstone", &[]),
        ("correction.applied", &[]),
        ("deletion.tombstone", &[]),
    ];

    for (expected_type, payload) in valid_payloads() {
        let event = base_event(payload);
        let value = serde_json::to_value(&event).expect("event is JSON");
        let fields = nullable_payload_fields
            .iter()
            .find(|(event_type, _)| *event_type == expected_type.as_str())
            .map(|(_, fields)| *fields)
            .expect("event type is listed");
        for field in fields {
            let mut explicit_null = value.clone();
            explicit_null["payload"]
                .as_object_mut()
                .expect("payload object")
                .insert((*field).to_owned(), serde_json::Value::Null);
            assert!(
                serde_json::from_value::<CanonicalEvent>(explicit_null.clone()).is_ok(),
                "explicit null for {expected_type}.{field} should be accepted"
            );
            explicit_null["payload"]
                .as_object_mut()
                .expect("payload object")
                .remove(*field);
            assert!(
                serde_json::from_value::<CanonicalEvent>(explicit_null).is_err(),
                "missing {expected_type}.{field} should be rejected"
            );
        }
    }

    let event = base_event(CanonicalPayload::TypingStopped(TypingStoppedPayload {
        participant_id: "participant_fixture".into(),
    }));
    for field in ["matrix_room_id", "matrix_event_id", "remote_message_id"] {
        let mut value = serde_json::to_value(&event).expect("event is JSON");
        value[field] = serde_json::Value::Null;
        assert!(serde_json::from_value::<CanonicalEvent>(value.clone()).is_ok());
        value.as_object_mut().expect("event object").remove(field);
        assert!(serde_json::from_value::<CanonicalEvent>(value).is_err());
    }
}

#[test]
fn resource_ids_match_the_shared_regex_edges_exactly() {
    let event = base_event(CanonicalPayload::TypingStopped(TypingStoppedPayload {
        participant_id: "participant_fixture".into(),
    }));
    let mut trailing_underscore = serde_json::to_value(&event).expect("event is JSON");
    trailing_underscore["tenant_id"] = serde_json::json!("tenant_a_");
    assert!(serde_json::from_value::<CanonicalEvent>(trailing_underscore).is_ok());

    let mut digit_prefix = serde_json::to_value(&event).expect("event is JSON");
    digit_prefix["tenant_id"] = serde_json::json!("tenant1_id");
    assert!(serde_json::from_value::<CanonicalEvent>(digit_prefix).is_err());
}

#[test]
fn timestamps_accept_contract_offsets_and_order_by_instants() {
    let event = base_event(CanonicalPayload::TypingStopped(TypingStoppedPayload {
        participant_id: "participant_fixture".into(),
    }));
    for timestamp in [
        "2026-09-09T01:02:03+00:00",
        "2026-09-09T01:02:03+01:00",
        "0000-01-01T00:00Z",
    ] {
        let mut value = serde_json::to_value(&event).expect("event is JSON");
        value["occurred_at"] = serde_json::json!(timestamp);
        assert!(
            serde_json::from_value::<CanonicalEvent>(value).is_ok(),
            "contract timestamp should be accepted: {timestamp}"
        );
    }

    let mut earlier = serde_json::to_value(&event).expect("event is JSON");
    earlier["event_id"] = serde_json::json!("evt_earlier");
    earlier["observed_at"] = serde_json::json!("2026-09-09T01:30:00+01:00");
    earlier["occurred_at"] = serde_json::json!("2026-09-09T01:00:00Z");
    let earlier: CanonicalEvent = serde_json::from_value(earlier).expect("earlier event");

    let mut later = serde_json::to_value(&event).expect("event is JSON");
    later["event_id"] = serde_json::json!("evt_later");
    later["observed_at"] = serde_json::json!("2026-09-09T00:45:00Z");
    later["occurred_at"] = serde_json::json!("2026-09-09T00:30:00Z");
    let later: CanonicalEvent = serde_json::from_value(later).expect("later event");

    assert!(earlier.ordering_key() < later.ordering_key());
}

#[test]
fn opaque_ids_use_javascript_trim_and_utf16_lengths() {
    let event = base_event(CanonicalPayload::ReplayTombstone(
        communicator_matrix_gateway::model::EventMarkerPayload {
            target_event_id: "  $target:example.org  ".into(),
            reason_code: "replayed".into(),
        },
    ));
    let mut value = serde_json::to_value(&event).expect("event is JSON");
    value["event_id"] = serde_json::json!("  evt_fixture  ");
    value["remote_message_id"] = serde_json::json!("  remote_fixture  ");
    let decoded: CanonicalEvent = serde_json::from_value(value).expect("trimmed event");
    assert_eq!(decoded.event_id, "evt_fixture");
    assert_eq!(decoded.remote_message_id.as_deref(), Some("remote_fixture"));
    if let CanonicalPayload::ReplayTombstone(ref marker) = decoded.payload {
        assert_eq!(marker.target_event_id, "$target:example.org");
    } else {
        panic!("expected replay marker");
    }

    let mut control = serde_json::to_value(&decoded).expect("event is JSON");
    control["event_id"] = serde_json::json!("evt\u{0001}fixture");
    assert!(serde_json::from_value::<CanonicalEvent>(control).is_ok());

    let emoji_510 = format!("{}{}", "evt_", "😀".repeat(510));
    let mut utf16 = serde_json::to_value(&decoded).expect("event is JSON");
    utf16["event_id"] = serde_json::Value::String(emoji_510);
    assert!(serde_json::from_value::<CanonicalEvent>(utf16).is_ok());
    let emoji_511 = format!("{}{}", "evt_", "😀".repeat(511));
    let mut utf16 = serde_json::to_value(&decoded).expect("event is JSON");
    utf16["event_id"] = serde_json::Value::String(emoji_511);
    assert!(serde_json::from_value::<CanonicalEvent>(utf16).is_err());
}

#[test]
fn public_opaque_fields_must_already_be_normalized_before_serialization() {
    let mut event = base_event(CanonicalPayload::TypingStopped(TypingStoppedPayload {
        participant_id: "participant_fixture".into(),
    }));
    event.event_id = "  evt_fixture  ".into();
    event.remote_message_id = Some("  remote_fixture  ".into());

    assert!(event.validate().is_err());
    assert!(serde_json::to_vec(&event).is_err());

    let normalized = CanonicalEvent::new(
        "  evt_fixture  ",
        CanonicalEventSource::Live,
        "tenant_fixture",
        "identity_fixture",
        Provider::Telegram,
        "account_fixture",
        "conversation_fixture",
        None,
        None,
        Some("  remote_fixture  ".into()),
        "2026-09-09T01:02:03.000Z",
        "2026-09-09T01:02:04.000Z",
        CanonicalPayload::TypingStopped(TypingStoppedPayload {
            participant_id: "participant_fixture".into(),
        }),
    )
    .expect("constructor normalizes opaque IDs");
    assert_eq!(normalized.event_id, "evt_fixture");
    assert_eq!(
        normalized.remote_message_id.as_deref(),
        Some("remote_fixture")
    );
    assert!(serde_json::to_vec(&normalized).is_ok());
}

#[test]
fn ordering_key_uses_javascript_utf16_event_id_order() {
    let mut bmp = base_event(CanonicalPayload::TypingStopped(TypingStoppedPayload {
        participant_id: "participant_fixture".into(),
    }));
    bmp.event_id = format!("evt{}", '\u{e000}');

    let mut non_bmp = base_event(CanonicalPayload::TypingStopped(TypingStoppedPayload {
        participant_id: "participant_fixture".into(),
    }));
    non_bmp.event_id = format!("evt{}", '\u{10000}');

    // JavaScript compares UTF-16 code units: the non-BMP surrogate pair
    // (D800) sorts before the BMP private-use code unit (E000).
    assert!(non_bmp.ordering_key() < bmp.ordering_key());
}
