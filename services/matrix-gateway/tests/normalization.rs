use std::{collections::BTreeMap, fs, os::unix::fs::PermissionsExt, path::Path};

use chrono::{DateTime, TimeZone, Utc};
use communicator_matrix_gateway::{
    crypto::Keyring,
    model::{CanonicalEvent, CanonicalPayload, DeliveryStatus, Direction},
    normalize::{
        KnownRelation, KnownRelations, MatrixAttachment, MatrixMembership, MatrixMembershipKind,
        MatrixMessage, MatrixMessageKind, MatrixReaction, MatrixReceipt, MatrixReceiptType,
        MatrixRedaction, MatrixRelation, MatrixRoomState, MatrixRoomStateKind, MatrixTyping,
        NormalizeOutcome, ObservedMatrixEvent, ProtectedBytes, normalize,
    },
    registry::{NewRoomBinding, RoomBinding, room_lookup},
    store::Store,
};
use serde::Deserialize;
use tempfile::{TempDir, tempdir};

const ROOM_ID: &str = "!portal:example.org";
const OTHER_ROOM_ID: &str = "!other:example.org";
const OWNER_USER_ID: &str = "@owner:example.org";
const ALICE_USER_ID: &str = "@alice:example.org";
const UNKNOWN_USER_ID: &str = "@unknown:example.org";
const MESSAGE_EVENT_ID: &str = "$message:example.org";
const REACTION_EVENT_ID: &str = "$reaction:example.org";
const OBSERVED_AT: &str = "2026-09-09T01:02:03.000Z";
const OCCURRED_AT: &str = "2026-09-09T01:02:02.000Z";

#[derive(Deserialize)]
struct FixtureFile {
    cases: Vec<FixtureCase>,
}

#[derive(Deserialize)]
struct FixtureCase {
    name: String,
    outcome: String,
    event_types: Vec<String>,
    reason_code: Option<String>,
}

fn timestamp(value: &str) -> DateTime<Utc> {
    DateTime::parse_from_rfc3339(value)
        .expect("fixture timestamp")
        .with_timezone(&Utc)
}

fn observed_at() -> DateTime<Utc> {
    timestamp(OBSERVED_AT)
}

fn keyring() -> Keyring {
    Keyring::new([0x11; 32], 1).expect("test keyring")
}

fn binding_with(tenant_id: &str, identity_id: &str, room_id: &str) -> (TempDir, RoomBinding) {
    let directory = tempdir().expect("temporary gateway state");
    fs::set_permissions(directory.path(), fs::Permissions::from_mode(0o700))
        .expect("secure temporary gateway state");
    let database = directory.path().join("gateway.sqlite3");
    let mut store = Store::open(&database, keyring()).expect("open gateway state");
    let new_binding = NewRoomBinding::new(
        "binding_0123456789abcdef0123456789abcdef",
        room_id,
        tenant_id,
        identity_id,
        "connection_demo",
        "account_demo",
        communicator_matrix_gateway::model::Provider::Telegram,
        "route_demo",
        "conversation_demo",
        OWNER_USER_ID,
        timestamp("2026-09-01T00:00:00.000Z"),
    )
    .expect("valid room binding");
    store
        .append_room_binding(new_binding)
        .expect("append room binding");
    let lookup = room_lookup(&keyring(), room_id).expect("room lookup");
    let binding = store
        .active_room_binding(&lookup)
        .expect("active room lookup")
        .expect("active binding");
    (directory, binding)
}

fn binding() -> (TempDir, RoomBinding) {
    binding_with("tenant_demo", "identity_demo", ROOM_ID)
}

fn known_relations(binding: &RoomBinding) -> KnownRelations {
    let mut known = BTreeMap::new();
    known.insert(
        ALICE_USER_ID.to_owned(),
        KnownRelation::participant(binding.matrix_room_id()),
    );
    known.insert(
        MESSAGE_EVENT_ID.to_owned(),
        KnownRelation::message(binding.matrix_room_id()),
    );
    known.insert(
        REACTION_EVENT_ID.to_owned(),
        KnownRelation::reaction(binding.matrix_room_id(), MESSAGE_EVENT_ID),
    );
    known
}

fn fixture(path: impl AsRef<Path>) -> FixtureFile {
    let bytes = fs::read(path).expect("read Matrix event fixture");
    serde_json::from_slice(&bytes).expect("parse Matrix event fixture")
}

fn fixture_case(file: &str, name: &str) -> FixtureCase {
    fixture(format!("{}/{}", env!("CARGO_MANIFEST_DIR"), file))
        .cases
        .into_iter()
        .find(|case| case.name == name)
        .unwrap_or_else(|| panic!("fixture case exists: {name}"))
}

fn assert_event_types(outcome: NormalizeOutcome, expected: &FixtureCase) -> Vec<CanonicalEvent> {
    assert_eq!(expected.outcome, "events");
    assert_eq!(expected.reason_code, None);
    let events = match outcome {
        NormalizeOutcome::Events(events) => events,
        other => panic!("expected events, got {other:?}"),
    };
    let actual: Vec<_> = events
        .iter()
        .map(|event| event.event_type().as_str().to_owned())
        .collect();
    assert_eq!(actual, expected.event_types);
    for event in &events {
        event.validate().expect("normalizer emits valid event");
    }
    events
}

fn assert_ignored(outcome: NormalizeOutcome, expected: &FixtureCase) {
    assert_eq!(expected.outcome, "ignored");
    let NormalizeOutcome::Ignored { reason_code } = outcome else {
        panic!("expected ignored outcome");
    };
    assert_eq!(Some(reason_code), expected.reason_code.as_deref());
}

fn assert_redacted(outcome: &NormalizeOutcome) {
    let rendered = format!("{outcome:?}");
    for protected in [
        "message-canary",
        ROOM_ID,
        OTHER_ROOM_ID,
        OWNER_USER_ID,
        ALICE_USER_ID,
        MESSAGE_EVENT_ID,
    ] {
        assert!(
            !rendered.contains(protected),
            "protected value leaked: {protected}"
        );
    }
}

fn message(
    room_id: &str,
    event_id: &str,
    sender_user_id: &str,
    sender_label: &str,
    body: &str,
) -> ObservedMatrixEvent {
    ObservedMatrixEvent::Message(MatrixMessage::new(
        room_id,
        event_id,
        sender_user_id,
        sender_label,
        body,
        OCCURRED_AT,
    ))
}

fn assert_binding_authority(events: &[CanonicalEvent], binding: &RoomBinding) {
    for event in events {
        assert_eq!(event.tenant_id, binding.tenant_id());
        assert_eq!(event.identity_id, binding.identity_id());
        assert_eq!(event.account_id, binding.account_id());
        assert_eq!(event.conversation_id, binding.conversation_id());
        assert_eq!(event.platform, binding.platform());
        assert_eq!(
            event.matrix_room_id.as_deref(),
            Some(binding.matrix_room_id())
        );
    }
}

#[test]
fn every_task6_fixture_case_is_named_and_bounded() {
    let fixture_files = [
        "testdata/matrix-events/messages.json",
        "testdata/matrix-events/metadata.json",
        "testdata/matrix-events/ephemeral.json",
        "testdata/matrix-events/rejections.json",
        "testdata/matrix-events/isolation.json",
    ];
    let cases: Vec<_> = fixture_files
        .into_iter()
        .flat_map(|file| fixture(format!("{}/{}", env!("CARGO_MANIFEST_DIR"), file)).cases)
        .collect();
    assert!(cases.len() >= 30);
    assert!(cases.iter().all(|case| !case.name.trim().is_empty()));
    assert!(cases.iter().all(|case| case.name.len() <= 100));
}

#[test]
fn normalizes_inbound_outbound_notice_emote_html_and_reply_messages() {
    let (_directory, binding) = binding();
    let known = known_relations(&binding);

    let inbound = fixture_case("testdata/matrix-events/messages.json", "inbound-text");
    let events = assert_event_types(
        normalize(
            message(
                ROOM_ID,
                "$inbound:example.org",
                ALICE_USER_ID,
                "Alice",
                "message-canary",
            ),
            &binding,
            &known,
            observed_at(),
        ),
        &inbound,
    );
    assert_binding_authority(&events, &binding);
    let CanonicalPayload::MessageCreated(payload) = &events[0].payload else {
        panic!("message event payload")
    };
    assert_eq!(payload.direction, Direction::Inbound);
    assert_eq!(payload.delivery_status, DeliveryStatus::Unknown);
    assert!(payload.unread);
    assert_eq!(payload.body, "message-canary");

    for (name, kind) in [
        ("outbound-text", MatrixMessageKind::Text),
        ("notice", MatrixMessageKind::Notice),
        ("emote", MatrixMessageKind::Emote),
    ] {
        let expected = fixture_case("testdata/matrix-events/messages.json", name);
        let input = MatrixMessage::new(
            ROOM_ID,
            "$kind:example.org",
            OWNER_USER_ID,
            "Owner",
            "hello",
            OCCURRED_AT,
        )
        .with_kind(kind);
        let events = assert_event_types(
            normalize(
                ObservedMatrixEvent::Message(input),
                &binding,
                &known,
                observed_at(),
            ),
            &expected,
        );
        let CanonicalPayload::MessageCreated(payload) = &events[0].payload else {
            panic!("message event payload")
        };
        assert_eq!(payload.direction, Direction::Outbound);
        assert_eq!(payload.delivery_status, DeliveryStatus::Sent);
        assert!(!payload.unread);
    }

    let expected = fixture_case("testdata/matrix-events/messages.json", "html-fallback");
    let html = MatrixMessage::new(
        ROOM_ID,
        "$html:example.org",
        ALICE_USER_ID,
        "Alice",
        "plain body",
        OCCURRED_AT,
    )
    .with_formatted_body("<b>message-canary</b>");
    let events = assert_event_types(
        normalize(
            ObservedMatrixEvent::Message(html),
            &binding,
            &known,
            observed_at(),
        ),
        &expected,
    );
    let CanonicalPayload::MessageCreated(payload) = &events[0].payload else {
        panic!("message event payload")
    };
    assert_eq!(payload.body, "plain body");

    let expected = fixture_case("testdata/matrix-events/messages.json", "reply");
    let reply = MatrixMessage::new(
        ROOM_ID,
        "$reply:example.org",
        ALICE_USER_ID,
        "Alice",
        "reply",
        OCCURRED_AT,
    )
    .with_relation(MatrixRelation::reply(MESSAGE_EVENT_ID));
    let events = assert_event_types(
        normalize(
            ObservedMatrixEvent::Message(reply),
            &binding,
            &known,
            observed_at(),
        ),
        &expected,
    );
    let CanonicalPayload::MessageCreated(payload) = &events[0].payload else {
        panic!("message event payload")
    };
    assert!(payload.reply_to_message_id.is_some());
    assert_redacted(&NormalizeOutcome::Events(events));
}

#[test]
fn normalizes_edits_redactions_and_reactions_only_for_known_relations() {
    let (_directory, binding) = binding();
    let known = known_relations(&binding);

    let expected = fixture_case("testdata/matrix-events/messages.json", "edit");
    let edit = MatrixMessage::new(
        ROOM_ID,
        "$edit:example.org",
        ALICE_USER_ID,
        "Alice",
        "edited",
        OCCURRED_AT,
    )
    .with_relation(MatrixRelation::replace(MESSAGE_EVENT_ID));
    let events = assert_event_types(
        normalize(
            ObservedMatrixEvent::Message(edit),
            &binding,
            &known,
            observed_at(),
        ),
        &expected,
    );
    assert!(matches!(
        events[0].payload,
        CanonicalPayload::MessageEdited(_)
    ));

    let expected = fixture_case("testdata/matrix-events/messages.json", "redaction-message");
    let redaction = MatrixRedaction::new(
        ROOM_ID,
        "$redaction-message:example.org",
        ALICE_USER_ID,
        MESSAGE_EVENT_ID,
        None,
        OCCURRED_AT,
    );
    let events = assert_event_types(
        normalize(
            ObservedMatrixEvent::Redaction(redaction),
            &binding,
            &known,
            observed_at(),
        ),
        &expected,
    );
    assert!(matches!(
        events[0].payload,
        CanonicalPayload::MessageDeleted(_)
    ));

    let expected = fixture_case("testdata/matrix-events/messages.json", "reaction-add");
    let reaction = MatrixReaction::new(
        ROOM_ID,
        REACTION_EVENT_ID,
        ALICE_USER_ID,
        MESSAGE_EVENT_ID,
        "👍",
        OCCURRED_AT,
    );
    let events = assert_event_types(
        normalize(
            ObservedMatrixEvent::Reaction(reaction),
            &binding,
            &known,
            observed_at(),
        ),
        &expected,
    );
    assert!(matches!(
        events[0].payload,
        CanonicalPayload::ReactionAdded(_)
    ));

    let expected = fixture_case("testdata/matrix-events/messages.json", "reaction-remove");
    let reaction_redaction = MatrixRedaction::new(
        ROOM_ID,
        "$redaction-reaction:example.org",
        ALICE_USER_ID,
        REACTION_EVENT_ID,
        None,
        OCCURRED_AT,
    );
    let events = assert_event_types(
        normalize(
            ObservedMatrixEvent::Redaction(reaction_redaction),
            &binding,
            &known,
            observed_at(),
        ),
        &expected,
    );
    assert!(matches!(
        events[0].payload,
        CanonicalPayload::ReactionRemoved(_)
    ));
}

#[test]
fn normalizes_attachment_metadata_without_copying_bytes_and_preserves_order() {
    let (_directory, binding) = binding();
    let known = known_relations(&binding);
    for (index, kind) in [
        MatrixMessageKind::Image,
        MatrixMessageKind::File,
        MatrixMessageKind::Audio,
        MatrixMessageKind::Video,
    ]
    .into_iter()
    .enumerate()
    {
        let expected = fixture_case(
            "testdata/matrix-events/metadata.json",
            ["image", "file", "audio", "video"][index],
        );
        let attachment = MatrixAttachment::new(
            Some("photo.jpg".to_owned()),
            Some("image/jpeg".to_owned()),
            Some(42),
            Some("a".repeat(64)),
        );
        let input = MatrixMessage::new(
            ROOM_ID,
            format!("$attachment-{index}:example.org"),
            ALICE_USER_ID,
            "Alice",
            "photo",
            OCCURRED_AT,
        )
        .with_kind(kind)
        .with_attachments(vec![attachment]);
        let events = assert_event_types(
            normalize(
                ObservedMatrixEvent::Message(input),
                &binding,
                &known,
                observed_at(),
            ),
            &expected,
        );
        assert!(matches!(
            events[0].payload,
            CanonicalPayload::MessageCreated(_)
        ));
        assert!(matches!(
            events[1].payload,
            CanonicalPayload::AttachmentObserved(_)
        ));
        let CanonicalPayload::AttachmentObserved(payload) = &events[1].payload else {
            unreachable!()
        };
        assert_eq!(payload.file_name.as_deref(), Some("photo.jpg"));
        assert_eq!(payload.mime_type.as_deref(), Some("image/jpeg"));
        assert_eq!(payload.size_bytes, Some(42));
        assert_eq!(payload.sha256.as_deref(), Some("a".repeat(64).as_str()));
        assert_eq!(payload.r2_key, None);
    }
}

#[test]
fn normalizes_complete_room_state_and_known_profile_snapshots() {
    let (_directory, binding) = binding();
    let known = known_relations(&binding);
    for kind_name in ["room-name", "room-topic", "room-avatar"] {
        let expected = fixture_case("testdata/matrix-events/metadata.json", kind_name);
        let kind = match kind_name {
            "room-name" => MatrixRoomStateKind::Name,
            "room-topic" => MatrixRoomStateKind::Topic,
            _ => MatrixRoomStateKind::Avatar,
        };
        let state = MatrixRoomState::new(
            ROOM_ID,
            format!("${kind_name}:example.org"),
            ALICE_USER_ID,
            kind,
            "Family",
            false,
            false,
            OCCURRED_AT,
        );
        let events = assert_event_types(
            normalize(
                ObservedMatrixEvent::RoomState(state),
                &binding,
                &known,
                observed_at(),
            ),
            &expected,
        );
        assert!(matches!(
            events[0].payload,
            CanonicalPayload::ConversationUpdated(_)
        ));
    }

    let expected = fixture_case("testdata/matrix-events/metadata.json", "membership-profile");
    let membership = MatrixMembership::new(
        ROOM_ID,
        "$membership:example.org",
        ALICE_USER_ID,
        ALICE_USER_ID,
        MatrixMembershipKind::Profile,
        "Alice Updated",
        None,
        Some("https://example.org/avatar.png".to_owned()),
        OCCURRED_AT,
    );
    let events = assert_event_types(
        normalize(
            ObservedMatrixEvent::Membership(membership),
            &binding,
            &known,
            observed_at(),
        ),
        &expected,
    );
    assert!(matches!(
        events[0].payload,
        CanonicalPayload::ParticipantUpdated(_)
    ));
}

#[test]
fn normalizes_receipts_and_typing_replacement_snapshots_deterministically() {
    let (_directory, binding) = binding();
    let known = known_relations(&binding);

    let expected = fixture_case("testdata/matrix-events/ephemeral.json", "receipt-read");
    let receipt = MatrixReceipt::new(
        ROOM_ID,
        MESSAGE_EVENT_ID,
        ALICE_USER_ID,
        MatrixReceiptType::Read,
        OCCURRED_AT,
    );
    let events = assert_event_types(
        normalize(
            ObservedMatrixEvent::Receipt(receipt),
            &binding,
            &known,
            observed_at(),
        ),
        &expected,
    );
    let CanonicalPayload::ReceiptRead(payload) = &events[0].payload else {
        panic!("receipt payload")
    };
    assert!(!payload.local_identity);
    assert!(events[0].matrix_event_id.is_none());

    let expected = fixture_case("testdata/matrix-events/ephemeral.json", "typing-start");
    let typing = MatrixTyping::new(
        ROOM_ID,
        "checkpoint-digest",
        vec![ALICE_USER_ID],
        Vec::<&str>::new(),
    );
    let started = assert_event_types(
        normalize(
            ObservedMatrixEvent::Typing(typing),
            &binding,
            &known,
            observed_at(),
        ),
        &expected,
    );
    let CanonicalPayload::TypingStarted(payload) = &started[0].payload else {
        panic!("typing payload")
    };
    assert_eq!(payload.expires_at, "2026-09-09T01:02:33.000Z");

    let expected = fixture_case("testdata/matrix-events/ephemeral.json", "typing-stop");
    let stopped = assert_event_types(
        normalize(
            ObservedMatrixEvent::Typing(MatrixTyping::new(
                ROOM_ID,
                "checkpoint-digest-2",
                Vec::<&str>::new(),
                vec![ALICE_USER_ID],
            )),
            &binding,
            &known,
            observed_at(),
        ),
        &expected,
    );
    assert!(matches!(
        stopped[0].payload,
        CanonicalPayload::TypingStopped(_)
    ));

    let expected = fixture_case("testdata/matrix-events/ephemeral.json", "typing-replay");
    let replay_input = || {
        ObservedMatrixEvent::Typing(MatrixTyping::new(
            ROOM_ID,
            "checkpoint-replay",
            vec![ALICE_USER_ID],
            Vec::<&str>::new(),
        ))
    };
    let first = assert_event_types(
        normalize(replay_input(), &binding, &known, observed_at()),
        &expected,
    );
    let second = assert_event_types(
        normalize(replay_input(), &binding, &known, observed_at()),
        &expected,
    );
    assert_eq!(first, second);
    assert_redacted(&NormalizeOutcome::Events(first));
}

#[test]
fn ignores_ephemeral_and_state_events_that_cannot_be_completed() {
    let (_directory, binding) = binding();
    let known = known_relations(&binding);
    let expected = fixture_case(
        "testdata/matrix-events/rejections.json",
        "unsupported-ephemeral",
    );
    assert_ignored(
        normalize(
            ObservedMatrixEvent::Unsupported {
                reason_code: "matrix_unsupported_ephemeral",
            },
            &binding,
            &known,
            observed_at(),
        ),
        &expected,
    );

    let expected = fixture_case(
        "testdata/matrix-events/rejections.json",
        "unsupported-state",
    );
    let state = MatrixRoomState::new(
        ROOM_ID,
        "$state:example.org",
        ALICE_USER_ID,
        MatrixRoomStateKind::Unsupported,
        "ignored",
        false,
        false,
        OCCURRED_AT,
    );
    assert_ignored(
        normalize(
            ObservedMatrixEvent::RoomState(state),
            &binding,
            &known,
            observed_at(),
        ),
        &expected,
    );
}

#[test]
fn retries_undecryptable_events_and_returns_source_gaps_without_success_events() {
    let (_directory, binding) = binding();
    let known = known_relations(&binding);
    let retry = normalize(
        ObservedMatrixEvent::UnableToDecrypt(
            communicator_matrix_gateway::normalize::MatrixUnableToDecrypt::new(
                ProtectedBytes::new(b"retry-material-canary"),
                "matrix_unable_to_decrypt",
            ),
        ),
        &binding,
        &known,
        observed_at(),
    );
    assert_eq!(
        retry,
        NormalizeOutcome::RetryWindow {
            reason_code: "matrix_unable_to_decrypt"
        }
    );
    assert_redacted(&retry);

    let gap = normalize(
        ObservedMatrixEvent::LimitedTimeline {
            protected_prev_batch: ProtectedBytes::new(b"prev-batch-canary"),
        },
        &binding,
        &known,
        observed_at(),
    );
    assert!(matches!(gap, NormalizeOutcome::SourceGap { .. }));
    assert_redacted(&gap);
}

#[test]
fn fails_closed_for_unknown_rooms_senders_relations_bounds_and_timestamps() {
    let (_directory, binding) = binding();
    let known = known_relations(&binding);
    let cases = [
        (
            "unknown-room",
            message(
                OTHER_ROOM_ID,
                "$room:example.org",
                ALICE_USER_ID,
                "Alice",
                "body",
            ),
        ),
        (
            "unknown-sender",
            message(
                ROOM_ID,
                "$sender:example.org",
                UNKNOWN_USER_ID,
                "Unknown",
                "body",
            ),
        ),
    ];
    for (name, input) in cases {
        let expected = fixture_case("testdata/matrix-events/rejections.json", name);
        assert_ignored(normalize(input, &binding, &known, observed_at()), &expected);
    }

    let expected = fixture_case(
        "testdata/matrix-events/rejections.json",
        "missing-relation-target",
    );
    let missing = MatrixMessage::new(
        ROOM_ID,
        "$missing-reply:example.org",
        ALICE_USER_ID,
        "Alice",
        "body",
        OCCURRED_AT,
    )
    .with_relation(MatrixRelation::reply("$missing:example.org"));
    assert_ignored(
        normalize(
            ObservedMatrixEvent::Message(missing),
            &binding,
            &known,
            observed_at(),
        ),
        &expected,
    );

    let expected = fixture_case("testdata/matrix-events/rejections.json", "oversized-body");
    assert_ignored(
        normalize(
            message(
                ROOM_ID,
                "$oversized:example.org",
                ALICE_USER_ID,
                "Alice",
                &"x".repeat(20_001),
            ),
            &binding,
            &known,
            observed_at(),
        ),
        &expected,
    );

    let expected = fixture_case(
        "testdata/matrix-events/rejections.json",
        "invalid-timestamp",
    );
    let invalid_timestamp = MatrixMessage::new(
        ROOM_ID,
        "$invalid-time:example.org",
        ALICE_USER_ID,
        "Alice",
        "body",
        "not-a-timestamp",
    );
    assert_ignored(
        normalize(
            ObservedMatrixEvent::Message(invalid_timestamp),
            &binding,
            &known,
            observed_at(),
        ),
        &expected,
    );

    let expected = fixture_case(
        "testdata/matrix-events/rejections.json",
        "unsupported-message",
    );
    let unsupported = MatrixMessage::new(
        ROOM_ID,
        "$unsupported:example.org",
        ALICE_USER_ID,
        "Alice",
        "body",
        OCCURRED_AT,
    )
    .with_kind(MatrixMessageKind::Unsupported);
    assert_ignored(
        normalize(
            ObservedMatrixEvent::Message(unsupported),
            &binding,
            &known,
            observed_at(),
        ),
        &expected,
    );
}

#[test]
fn duplicate_matrix_events_are_idempotent_and_authority_isolated_between_tenants() {
    let (_directory_a, binding_a) = binding_with("tenant_a", "identity_a", ROOM_ID);
    let (_directory_b, binding_b) = binding_with("tenant_b", "identity_b", OTHER_ROOM_ID);
    let known_a = known_relations(&binding_a);
    let known_b = known_relations(&binding_b);
    let input_a = message(
        ROOM_ID,
        "$duplicate:example.org",
        ALICE_USER_ID,
        "Alice",
        "body",
    );
    let first = normalize(input_a, &binding_a, &known_a, observed_at());
    let second = normalize(
        message(
            ROOM_ID,
            "$duplicate:example.org",
            ALICE_USER_ID,
            "Alice",
            "different body",
        ),
        &binding_a,
        &known_a,
        observed_at(),
    );
    let first_events = match first {
        NormalizeOutcome::Events(events) => events,
        other => panic!("expected duplicate events: {other:?}"),
    };
    let second_events = match second {
        NormalizeOutcome::Events(events) => events,
        other => panic!("expected duplicate events: {other:?}"),
    };
    assert_eq!(first_events[0].event_id, second_events[0].event_id);
    assert_ne!(first_events[0].payload, second_events[0].payload);

    let tenant_a = match normalize(
        message(
            ROOM_ID,
            "$tenant-event:example.org",
            ALICE_USER_ID,
            "Alice",
            "body",
        ),
        &binding_a,
        &known_a,
        observed_at(),
    ) {
        NormalizeOutcome::Events(events) => events,
        other => panic!("tenant A events: {other:?}"),
    };
    let tenant_b = match normalize(
        message(
            OTHER_ROOM_ID,
            "$tenant-event:example.org",
            ALICE_USER_ID,
            "Alice",
            "body",
        ),
        &binding_b,
        &known_b,
        observed_at(),
    ) {
        NormalizeOutcome::Events(events) => events,
        other => panic!("tenant B events: {other:?}"),
    };
    assert_binding_authority(&tenant_a, &binding_a);
    assert_binding_authority(&tenant_b, &binding_b);
    assert_eq!(tenant_a[0].event_id, tenant_b[0].event_id);
    let CanonicalPayload::MessageCreated(a_payload) = &tenant_a[0].payload else {
        panic!("tenant A payload")
    };
    let CanonicalPayload::MessageCreated(b_payload) = &tenant_b[0].payload else {
        panic!("tenant B payload")
    };
    assert_ne!(a_payload.message_id, b_payload.message_id);
}

#[test]
fn observed_timestamp_is_frozen_and_durable_events_keep_matrix_source_identity() {
    let (_directory, binding) = binding();
    let known = known_relations(&binding);
    let outcome = normalize(
        message(
            ROOM_ID,
            "$ordered:example.org",
            ALICE_USER_ID,
            "Alice",
            "body",
        ),
        &binding,
        &known,
        Utc.timestamp_millis_opt(1_757_378_523_456).unwrap(),
    );
    let events = match outcome {
        NormalizeOutcome::Events(events) => events,
        other => panic!("events expected: {other:?}"),
    };
    assert_eq!(events[0].observed_at, "2025-09-09T00:42:03.456Z");
    assert_eq!(events[0].occurred_at, OCCURRED_AT);
    assert_eq!(
        events[0].matrix_event_id.as_deref(),
        Some("$ordered:example.org")
    );
    assert_eq!(events[0].matrix_room_id.as_deref(), Some(ROOM_ID));
}
