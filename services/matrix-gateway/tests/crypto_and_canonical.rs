use communicator_matrix_gateway::{
    canonical::{CanonicalBatchInput, SourceCheckpoint, encode_canonical_event_batch},
    config::{MAX_BATCH_CANONICAL_BYTES, MAX_BATCH_EVENTS, MAX_EVENT_CANONICAL_BYTES},
    model::{
        CanonicalEvent, CanonicalEventSource, CanonicalPayload, DeliveryStatus, Direction,
        MessageCreatedPayload, Provider,
    },
};

const TENANT_ID: &str = "tenant_ingestion_test";
const ROUTE_ID: &str = "gateway_route_test";
const ARCHIVED_AT: &str = "2026-09-07T02:03:04.000+00:00";
const PRODUCER_VERSION: &str = "gateway-test-1";
const CHECKPOINT_KIND: &str = "matrix_sync_token_sha256";
const CHECKPOINT_VALUE: &str =
    "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

fn event(event_id: &str, observed_at: &str, occurred_at: &str, body: &str) -> CanonicalEvent {
    CanonicalEvent::new(
        event_id,
        CanonicalEventSource::Live,
        TENANT_ID,
        "identity_ingestion",
        Provider::Whatsapp,
        "account_ingestion_whatsapp",
        "conversation_ingestion_0001",
        Some("!room:server".to_owned()),
        Some("$matrix-1:server".to_owned()),
        Some("remote-1".to_owned()),
        occurred_at,
        observed_at,
        CanonicalPayload::MessageCreated(MessageCreatedPayload {
            message_id: "message_ingestion_0001".to_owned(),
            direction: Direction::Inbound,
            sender_participant_id: None,
            sender_label: "Ingestion fixture".to_owned(),
            body: body.to_owned(),
            reply_to_message_id: None,
            delivery_status: DeliveryStatus::Unknown,
            unread: true,
        }),
    )
    .expect("test event is valid")
}

fn fixture_input(events: Vec<CanonicalEvent>) -> CanonicalBatchInput {
    CanonicalBatchInput {
        gateway_route_id: ROUTE_ID.to_owned(),
        tenant_id: TENANT_ID.to_owned(),
        archived_at: ARCHIVED_AT.to_owned(),
        producer_version: PRODUCER_VERSION.to_owned(),
        source_checkpoint: SourceCheckpoint {
            kind: CHECKPOINT_KIND.to_owned(),
            value: CHECKPOINT_VALUE.to_owned(),
        },
        events,
    }
}

fn events_with_total_body_bytes(target: usize) -> Vec<CanonicalEvent> {
    let mut events = (0..MAX_BATCH_EVENTS)
        .map(|index| {
            event(
                &format!("$boundary-{index}:server"),
                "2026-09-07T01:00:00.000Z",
                "2026-09-07T00:00:00.000Z",
                "",
            )
        })
        .collect::<Vec<_>>();
    let base = encode_canonical_event_batch(fixture_input(events.clone()))
        .expect("empty boundary events are valid")
        .uncompressed_bytes;
    assert!(target >= base);
    let mut remaining = target - base;
    for value in &mut events {
        let body_length = remaining.min(20_000);
        if let CanonicalPayload::MessageCreated(payload) = &mut value.payload {
            payload.body = "x".repeat(body_length);
        }
        remaining -= body_length;
    }
    assert_eq!(remaining, 0);
    events
}

#[test]
fn reproduces_task_one_fixture_bytes_digest_and_batch_id() {
    let batch = encode_canonical_event_batch(fixture_input(vec![event(
        "$event-1:server",
        "2026-09-07T01:00:01.500Z",
        "2026-09-07T01:00:01.000Z",
        "",
    )]))
    .expect("fixture batch is valid");

    assert_eq!(
        String::from_utf8(batch.canonical_jsonl.clone()).expect("canonical JSONL is UTF-8"),
        "{\"account_id\":\"account_ingestion_whatsapp\",\"conversation_id\":\"conversation_ingestion_0001\",\"event_id\":\"$event-1:server\",\"event_source\":\"live\",\"event_type\":\"message.created\",\"identity_id\":\"identity_ingestion\",\"matrix_event_id\":\"$matrix-1:server\",\"matrix_room_id\":\"!room:server\",\"observed_at\":\"2026-09-07T01:00:01.500Z\",\"occurred_at\":\"2026-09-07T01:00:01.000Z\",\"payload\":{\"body\":\"\",\"delivery_status\":\"unknown\",\"direction\":\"inbound\",\"message_id\":\"message_ingestion_0001\",\"reply_to_message_id\":null,\"sender_label\":\"Ingestion fixture\",\"sender_participant_id\":null,\"unread\":true},\"platform\":\"whatsapp\",\"remote_message_id\":\"remote-1\",\"schema_version\":1,\"tenant_id\":\"tenant_ingestion_test\"}\n"
    );
    assert_eq!(
        batch.canonical_sha256,
        "717310de1e6dab7600b0a6cd2a96965c6cbffd27b0c294ed0ef99323a78f8d64"
    );
    assert_eq!(
        batch.batch_id,
        "batch_44041dc8a8de63c3e343eb72a6f381b739bee93e41ec6c24720b4beded3d220a"
    );
    assert_eq!(
        String::from_utf8(batch.identity_json).expect("identity is UTF-8"),
        "{\"archived_at\":\"2026-09-07T02:03:04.000+00:00\",\"canonical_sha256\":\"717310de1e6dab7600b0a6cd2a96965c6cbffd27b0c294ed0ef99323a78f8d64\",\"gateway_route_id\":\"gateway_route_test\",\"producer_version\":\"gateway-test-1\",\"schema_version\":1,\"source_checkpoint\":{\"kind\":\"matrix_sync_token_sha256\",\"value\":\"sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\"},\"tenant_id\":\"tenant_ingestion_test\"}"
    );
    assert_eq!(batch.request.batch_id, batch.batch_id);
}

#[test]
fn sorts_by_observed_then_occurred_then_event_id_and_uses_one_lf_per_line() {
    let batch = encode_canonical_event_batch(fixture_input(vec![
        event(
            "$z:server",
            "2026-09-07T01:00:00.000Z",
            "2026-09-07T00:00:02.000Z",
            "z",
        ),
        event(
            "$b:server",
            "2026-09-07T01:00:00.000Z",
            "2026-09-07T00:00:01.000Z",
            "b",
        ),
        event(
            "$a:server",
            "2026-09-07T01:00:00.000Z",
            "2026-09-07T00:00:01.000Z",
            "a",
        ),
    ]))
    .expect("sorted batch is valid");

    assert_eq!(
        batch
            .events
            .iter()
            .map(|value| value.event_id.as_str())
            .collect::<Vec<_>>(),
        vec!["$a:server", "$b:server", "$z:server"]
    );
    assert_eq!(batch.canonical_jsonl.last(), Some(&b'\n'));
    assert_eq!(
        batch
            .canonical_jsonl
            .iter()
            .filter(|byte| **byte == b'\n')
            .count(),
        3
    );
    assert!(!batch.canonical_jsonl.windows(2).any(|pair| pair == b"\n\n"));
}

#[test]
fn sorts_timestamp_offsets_by_utc_instant_before_event_id() {
    let batch = encode_canonical_event_batch(fixture_input(vec![
        event(
            "$b:server",
            "2026-09-07T01:00:00.000Z",
            "2026-09-07T00:00:00.000Z",
            "b",
        ),
        event(
            "$a:server",
            "2026-09-07T02:00:00.000+01:00",
            "2026-09-07T01:00:00.000+01:00",
            "a",
        ),
    ]))
    .expect("timestamp offsets are valid canonical timestamps");

    assert_eq!(
        batch
            .events
            .iter()
            .map(|value| value.event_id.as_str())
            .collect::<Vec<_>>(),
        vec!["$a:server", "$b:server"]
    );
}

#[test]
fn rejects_empty_batches_before_returning_output() {
    let error = encode_canonical_event_batch(fixture_input(Vec::new()))
        .expect_err("an empty batch cannot be archived");
    assert_eq!(error.code(), "canonical_invalid");
}

#[test]
fn accepts_every_worker_timestamp_shape_and_rejects_invalid_dates() {
    for archived_at in [
        "2026-09-07T01:02Z",
        "2026-09-07T01:02:03+01:00",
        "0000-01-01T00:00Z",
    ] {
        let mut input = fixture_input(vec![event(
            "$timestamp-shape:server",
            "2026-09-07T01:00:00.000Z",
            "2026-09-07T00:00:00.000Z",
            "body",
        )]);
        input.archived_at = archived_at.to_owned();
        assert!(
            encode_canonical_event_batch(input).is_ok(),
            "Worker-valid timestamp was rejected: {archived_at}"
        );
    }

    let mut invalid = fixture_input(vec![event(
        "$invalid-date:server",
        "2026-09-07T01:00:00.000Z",
        "2026-09-07T00:00:00.000Z",
        "body",
    )]);
    invalid.archived_at = "2026-02-30T01:02Z".to_owned();
    let error =
        encode_canonical_event_batch(invalid).expect_err("invalid calendar dates must be rejected");
    assert_eq!(error.code(), "canonical_invalid");
}

#[test]
fn rejects_event_count_and_canonical_byte_limits_before_returning_output() {
    let exactly_max_events = (0..MAX_BATCH_EVENTS)
        .map(|index| {
            event(
                &format!("$event-{index}:server"),
                "2026-09-07T01:00:00.000Z",
                "2026-09-07T00:00:00.000Z",
                "body",
            )
        })
        .collect();
    let exact_count_batch = encode_canonical_event_batch(fixture_input(exactly_max_events))
        .expect("exactly the fixed event count must be accepted");
    assert_eq!(exact_count_batch.events.len(), MAX_BATCH_EVENTS);

    let too_many = (0..=MAX_BATCH_EVENTS)
        .map(|index| {
            event(
                &format!("$event-{index}:server"),
                "2026-09-07T01:00:00.000Z",
                "2026-09-07T00:00:00.000Z",
                "body",
            )
        })
        .collect();
    let error = encode_canonical_event_batch(fixture_input(too_many))
        .expect_err("more than the fixed event count must fail");
    assert_eq!(error.code(), "canonical_too_large");

    assert_eq!(MAX_EVENT_CANONICAL_BYTES, 1024 * 1024);
    assert_eq!(MAX_BATCH_CANONICAL_BYTES, 4 * 1024 * 1024);
}

#[test]
fn accepts_exact_batch_bytes_and_rejects_one_byte_over() {
    let exact_events = events_with_total_body_bytes(MAX_BATCH_CANONICAL_BYTES);
    let exact = encode_canonical_event_batch(fixture_input(exact_events))
        .expect("exactly the canonical batch byte limit must be accepted");
    assert_eq!(exact.uncompressed_bytes, MAX_BATCH_CANONICAL_BYTES);

    let oversized_events = events_with_total_body_bytes(MAX_BATCH_CANONICAL_BYTES + 1);
    let error = encode_canonical_event_batch(fixture_input(oversized_events))
        .expect_err("one byte above the canonical batch limit must fail");
    assert_eq!(error.code(), "canonical_too_large");
}

#[test]
fn rejects_duplicate_event_ids_and_cross_tenant_events() {
    let duplicate = encode_canonical_event_batch(fixture_input(vec![
        event(
            "$duplicate:server",
            "2026-09-07T01:00:00.000Z",
            "2026-09-07T00:00:00.000Z",
            "one",
        ),
        event(
            "$duplicate:server",
            "2026-09-07T01:00:01.000Z",
            "2026-09-07T00:00:01.000Z",
            "two",
        ),
    ]))
    .expect_err("duplicate IDs are not a valid batch");
    assert_eq!(duplicate.code(), "canonical_invalid");

    let mut cross_tenant = event(
        "$cross-tenant:server",
        "2026-09-07T01:00:00.000Z",
        "2026-09-07T00:00:00.000Z",
        "body",
    );
    cross_tenant.tenant_id = "tenant_other".to_owned();
    let error = encode_canonical_event_batch(fixture_input(vec![cross_tenant]))
        .expect_err("cross-tenant events cannot enter a batch");
    assert_eq!(error.code(), "canonical_tenant_mismatch");
}
