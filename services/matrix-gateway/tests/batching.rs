use std::collections::BTreeMap;

use chrono::{DateTime, Utc};
use communicator_matrix_gateway::{
    batch::{
        BackfillJob, BatchQuarantine, RoutedEvent, WindowSource, build_window,
        reparse_and_verify_request,
    },
    canonical::{
        CanonicalBatchRequest, canonical_event_json_line_bytes, canonical_json_bytes, sha256_hex,
    },
    config::{MAX_BATCH_CANONICAL_BYTES, MAX_BATCH_EVENTS, MAX_EVENT_CANONICAL_BYTES},
    model::{
        CanonicalEvent, CanonicalEventSource, CanonicalPayload, DeliveryStatus, Direction,
        MessageCreatedPayload, Provider,
    },
};
use serde_json::Value;

const ROOM_ID: &str = "!room:example.org";
const OBSERVED_AT: &str = "2026-09-09T01:02:03.000Z";
const OCCURRED_AT: &str = "2026-09-09T01:02:02.000Z";
const BACKFILL_JOB_ID: &str = "018f0f2c-5f5a-7abc-8def-0123456789ab";
const BACKFILL_START: &str = "2026-09-01T00:00:00.000Z";
const BACKFILL_END: &str = "2026-09-09T00:00:00.000Z";

fn timestamp(value: &str) -> DateTime<Utc> {
    DateTime::parse_from_rfc3339(value)
        .expect("test timestamp")
        .with_timezone(&Utc)
}

fn message_event(
    tenant_id: &str,
    event_id: &str,
    observed_at: &str,
    occurred_at: &str,
    body: &str,
) -> CanonicalEvent {
    CanonicalEvent::new(
        event_id,
        CanonicalEventSource::Live,
        tenant_id,
        "identity_demo",
        Provider::Whatsapp,
        "account_demo",
        "conversation_demo",
        Some(ROOM_ID.to_owned()),
        Some(format!("${event_id}:example.org")),
        None,
        occurred_at,
        observed_at,
        CanonicalPayload::MessageCreated(MessageCreatedPayload {
            message_id: "message_0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
                .to_owned(),
            direction: Direction::Inbound,
            sender_participant_id: Some(
                "participant_0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
                    .to_owned(),
            ),
            sender_label: "Alice".to_owned(),
            body: body.to_owned(),
            reply_to_message_id: None,
            delivery_status: DeliveryStatus::Unknown,
            unread: true,
        }),
    )
    .expect("valid canonical message event")
}

fn event_with_body_len(index: usize, body_len: usize) -> CanonicalEvent {
    message_event(
        "tenant_demo",
        &format!("evt_{index:04}"),
        OBSERVED_AT,
        OCCURRED_AT,
        &"x".repeat(body_len),
    )
}

fn routed(route_id: &str, event: CanonicalEvent) -> RoutedEvent {
    RoutedEvent::new(route_id, event)
}

fn live_window(events: &[RoutedEvent]) -> communicator_matrix_gateway::batch::BatchWindow {
    build_window(
        WindowSource::live(b"opaque-next-batch-token"),
        timestamp(OBSERVED_AT),
        events,
    )
    .expect("valid live window")
}

fn request_events(batch: &communicator_matrix_gateway::batch::BuiltBatch) -> &[CanonicalEvent] {
    &batch.events
}

fn exact_size_events(target: usize) -> Vec<CanonicalEvent> {
    let mut prefix = Vec::new();
    let mut prefix_bytes = 0_usize;
    for index in 0..MAX_BATCH_EVENTS {
        let empty = event_with_body_len(index, 0);
        let full = event_with_body_len(index, 20_000);
        let empty_len = canonical_event_json_line_bytes(&empty)
            .expect("empty fixture event encodes")
            .len();
        let full_len = canonical_event_json_line_bytes(&full)
            .expect("full fixture event encodes")
            .len();
        let remaining = target.checked_sub(prefix_bytes);
        if let Some(remaining) = remaining
            && (empty_len..=full_len).contains(&remaining)
        {
            let body_len = remaining - empty_len;
            let candidate = event_with_body_len(index, body_len);
            let candidate_len = canonical_event_json_line_bytes(&candidate)
                .expect("sized fixture event encodes")
                .len();
            if candidate_len == remaining && body_len > 0 && body_len < 20_000 {
                prefix.push(candidate);
                return prefix;
            }
        }
        prefix_bytes = prefix_bytes
            .checked_add(full_len)
            .expect("fixture size does not overflow");
        prefix.push(full);
    }
    panic!("could not construct a canonical JSONL fixture of {target} bytes");
}

fn oversized_event() -> CanonicalEvent {
    let mut event = message_event(
        "tenant_demo",
        "evt_oversized",
        OBSERVED_AT,
        OCCURRED_AT,
        "x",
    );
    let CanonicalPayload::MessageCreated(payload) = &mut event.payload else {
        unreachable!("message fixture has a message payload")
    };
    payload.body = "x".repeat(MAX_EVENT_CANONICAL_BYTES);
    event
}

fn quarantined_codes(window: &communicator_matrix_gateway::batch::BatchWindow) -> Vec<&str> {
    window
        .quarantined
        .iter()
        .map(BatchQuarantine::reason_code)
        .collect()
}

#[test]
fn empty_windows_are_valid_and_have_no_requests() {
    let window = live_window(&[]);

    assert!(window.batches.is_empty());
    assert!(window.exact_request_bytes().is_empty());
    assert!(window.quarantined.is_empty());
    assert_eq!(window.archived_at, OBSERVED_AT);
}

#[test]
fn partitions_are_sorted_by_utf8_tenant_then_route_and_never_mix_authority() {
    let events = vec![
        routed(
            "route_z",
            message_event("tenant_b", "evt_bz", OBSERVED_AT, OCCURRED_AT, "b-z"),
        ),
        routed(
            "route_a",
            message_event("tenant_b", "evt_ba", OBSERVED_AT, OCCURRED_AT, "b-a"),
        ),
        routed(
            "route_z",
            message_event("tenant_a", "evt_az", OBSERVED_AT, OCCURRED_AT, "a-z"),
        ),
        routed(
            "route_a",
            message_event("tenant_a", "evt_aa", OBSERVED_AT, OCCURRED_AT, "a-a"),
        ),
    ];

    let window = live_window(&events);
    let partitions: Vec<_> = window
        .batches
        .iter()
        .map(|batch| (batch.tenant_id(), batch.gateway_route_id()))
        .collect();

    assert_eq!(
        partitions,
        vec![
            ("tenant_a", "route_a"),
            ("tenant_a", "route_z"),
            ("tenant_b", "route_a"),
            ("tenant_b", "route_z"),
        ]
    );
    assert!(
        window
            .batches
            .iter()
            .all(|batch| batch.one_tenant_and_route())
    );
}

#[test]
fn event_order_is_observed_then_occurred_then_utf16_event_id() {
    let events = vec![
        routed(
            "route_demo",
            message_event(
                "tenant_demo",
                "evt_z",
                "2026-09-09T01:02:04.000Z",
                "2026-09-09T01:02:00.000Z",
                "third",
            ),
        ),
        routed(
            "route_demo",
            message_event(
                "tenant_demo",
                "evt_b",
                OBSERVED_AT,
                "2026-09-09T01:02:01.000Z",
                "second",
            ),
        ),
        routed(
            "route_demo",
            message_event(
                "tenant_demo",
                "evt_a",
                OBSERVED_AT,
                "2026-09-09T01:02:01.000Z",
                "first",
            ),
        ),
    ];

    let window = live_window(&events);
    let ids: Vec<_> = request_events(&window.batches[0])
        .iter()
        .map(|event| event.event_id.as_str())
        .collect();
    assert_eq!(ids, vec!["evt_a", "evt_b", "evt_z"]);
}

#[test]
fn partitions_split_at_500_events() {
    let events: Vec<_> = (0..=MAX_BATCH_EVENTS)
        .map(|index| routed("route_demo", event_with_body_len(index, 0)))
        .collect();

    let window = live_window(&events);

    assert_eq!(window.batches.len(), 2);
    assert_eq!(window.batches[0].events.len(), MAX_BATCH_EVENTS);
    assert_eq!(window.batches[1].events.len(), 1);
}

#[test]
fn canonical_jsonl_splits_just_below_at_and_above_4_mib() {
    let below = exact_size_events(MAX_BATCH_CANONICAL_BYTES - 1)
        .into_iter()
        .map(|event| routed("route_demo", event))
        .collect::<Vec<_>>();
    let at = exact_size_events(MAX_BATCH_CANONICAL_BYTES)
        .into_iter()
        .map(|event| routed("route_demo", event))
        .collect::<Vec<_>>();
    let above = exact_size_events(MAX_BATCH_CANONICAL_BYTES + 1)
        .into_iter()
        .map(|event| routed("route_demo", event))
        .collect::<Vec<_>>();

    let below_window = live_window(&below);
    let at_window = live_window(&at);
    let above_window = live_window(&above);

    assert_eq!(below_window.batches.len(), 1);
    assert_eq!(
        below_window.batches[0].canonical_jsonl.len(),
        MAX_BATCH_CANONICAL_BYTES - 1
    );
    assert_eq!(at_window.batches.len(), 1);
    assert_eq!(
        at_window.batches[0].canonical_jsonl.len(),
        MAX_BATCH_CANONICAL_BYTES
    );
    assert_eq!(above_window.batches.len(), 2);
    assert!(
        above_window
            .batches
            .iter()
            .all(|batch| batch.canonical_jsonl.len() <= MAX_BATCH_CANONICAL_BYTES)
    );
}

#[test]
fn one_oversized_event_is_quarantined_without_blocking_siblings() {
    let events = vec![
        routed(
            "route_demo",
            message_event(
                "tenant_demo",
                "evt_small",
                OBSERVED_AT,
                OCCURRED_AT,
                "small",
            ),
        ),
        routed("route_demo", oversized_event()),
    ];

    let window = live_window(&events);

    assert_eq!(window.batches.len(), 1);
    assert_eq!(window.batches[0].events.len(), 1);
    assert_eq!(window.batches[0].events[0].event_id, "evt_small");
    assert_eq!(quarantined_codes(&window), vec!["batch_event_too_large"]);
}

#[test]
fn byte_identical_duplicate_events_collapse_before_request_encoding() {
    let event = message_event(
        "tenant_demo",
        "evt_duplicate",
        OBSERVED_AT,
        OCCURRED_AT,
        "same",
    );
    let events = vec![
        routed("route_demo", event.clone()),
        routed("route_demo", event),
    ];

    let window = live_window(&events);

    assert_eq!(window.batches.len(), 1);
    assert_eq!(window.batches[0].events.len(), 1);
    assert!(window.quarantined.is_empty());
}

#[test]
fn duplicate_id_conflicts_are_quarantined_before_encoding() {
    let events = vec![
        routed(
            "route_demo",
            message_event(
                "tenant_demo",
                "evt_conflict",
                OBSERVED_AT,
                OCCURRED_AT,
                "one",
            ),
        ),
        routed(
            "route_demo",
            message_event(
                "tenant_demo",
                "evt_conflict",
                OBSERVED_AT,
                OCCURRED_AT,
                "two",
            ),
        ),
    ];

    let window = live_window(&events);

    assert!(window.batches.is_empty());
    assert_eq!(
        quarantined_codes(&window),
        vec!["batch_duplicate_id_conflict"]
    );
}

#[test]
fn archived_at_checkpoint_digest_and_request_bytes_are_deterministic_and_redacted() {
    let token = b"opaque-next-batch-token";
    let events = vec![routed(
        "route_demo",
        message_event(
            "tenant_demo",
            "evt_deterministic",
            OBSERVED_AT,
            OCCURRED_AT,
            "body",
        ),
    )];
    let first = build_window(
        WindowSource::live(token),
        timestamp("2026-09-09T01:02:03.987654Z"),
        &events,
    )
    .expect("first deterministic window");
    let second = build_window(
        WindowSource::live(token),
        timestamp("2026-09-09T01:02:03.987654Z"),
        &events,
    )
    .expect("second deterministic window");

    let digest = format!("sha256:{}", sha256_hex(token));
    assert_eq!(first.archived_at, "2026-09-09T01:02:03.987Z");
    assert_eq!(first.batches[0].request.source_checkpoint.value, digest);
    assert_eq!(first.exact_request_bytes(), second.exact_request_bytes());
    assert_eq!(first.batches[0].batch_id, second.batches[0].batch_id);
    assert!(
        !first.batches[0]
            .exact_request_bytes()
            .windows(token.len())
            .any(|window| window == token)
    );
    assert!(!format!("{:?}", WindowSource::live(token)).contains("opaque-next-batch-token"));
}

#[test]
fn exact_request_bytes_reparse_as_strict_typed_request_and_verify_id() {
    let events = vec![routed(
        "route_demo",
        message_event(
            "tenant_demo",
            "evt_request",
            OBSERVED_AT,
            OCCURRED_AT,
            "request",
        ),
    )];
    let window = live_window(&events);
    let batch = &window.batches[0];
    let bytes = batch.exact_request_bytes();
    let typed: CanonicalBatchRequest = serde_json::from_slice(bytes).expect("strict request JSON");

    assert_eq!(typed, batch.request);
    assert_eq!(
        reparse_and_verify_request(bytes).expect("verified request"),
        typed
    );
    let value: Value = serde_json::from_slice(bytes).expect("request value");
    assert_eq!(
        canonical_json_bytes(&value).expect("canonical request"),
        bytes
    );
}

#[test]
fn live_and_backfill_checkpoint_kinds_are_exact() {
    let events = vec![routed(
        "route_demo",
        message_event(
            "tenant_demo",
            "evt_checkpoint",
            OBSERVED_AT,
            OCCURRED_AT,
            "checkpoint",
        ),
    )];
    let live = live_window(&events);
    let job = BackfillJob::new(
        BACKFILL_JOB_ID,
        ROOM_ID,
        BACKFILL_START,
        BACKFILL_END,
        100_000,
    )
    .expect("valid UUIDv7 backfill job");
    let backfill =
        build_window(job.checkpoint(0), timestamp(OBSERVED_AT), &events).expect("backfill window");

    assert_eq!(
        live.batches[0].request.source_checkpoint.kind,
        "matrix_sync_token_sha256"
    );
    assert_eq!(
        backfill.batches[0].request.source_checkpoint.kind,
        "matrix_backfill_run_sha256"
    );
    assert_ne!(
        live.batches[0].request.source_checkpoint.value,
        backfill.batches[0].request.source_checkpoint.value
    );
}

#[test]
fn uuidv7_backfill_job_is_reused_on_resume_but_new_runs_get_new_identity() {
    let events = vec![routed(
        "route_demo",
        message_event(
            "tenant_demo",
            "evt_backfill",
            OBSERVED_AT,
            OCCURRED_AT,
            "backfill",
        ),
    )];
    let job = BackfillJob::new(
        BACKFILL_JOB_ID,
        ROOM_ID,
        BACKFILL_START,
        BACKFILL_END,
        100_000,
    )
    .expect("valid UUIDv7 backfill job");
    let resumed = build_window(job.checkpoint(0), timestamp(OBSERVED_AT), &events)
        .expect("resumed backfill window");
    let replayed = build_window(job.checkpoint(0), timestamp(OBSERVED_AT), &events)
        .expect("replayed backfill window");
    let separately_requested = BackfillJob::new(
        "018f0f2c-5f5a-7abc-8def-abcdef012345",
        ROOM_ID,
        BACKFILL_START,
        BACKFILL_END,
        100_000,
    )
    .expect("second UUIDv7 backfill job");
    let separate = build_window(
        separately_requested.checkpoint(0),
        timestamp(OBSERVED_AT),
        &events,
    )
    .expect("separate backfill window");

    assert_eq!(
        resumed.exact_request_bytes(),
        replayed.exact_request_bytes()
    );
    assert_eq!(resumed.batches[0].batch_id, replayed.batches[0].batch_id);
    assert_ne!(resumed.batches[0].batch_id, separate.batches[0].batch_id);
}

#[test]
fn backfill_checkpoint_digest_uses_only_the_frozen_length_prefixed_tuple() {
    let events = vec![routed(
        "route_demo",
        message_event(
            "tenant_demo",
            "evt_backfill_digest",
            OBSERVED_AT,
            OCCURRED_AT,
            "digest",
        ),
    )];
    let job = BackfillJob::new(
        BACKFILL_JOB_ID,
        ROOM_ID,
        BACKFILL_START,
        BACKFILL_END,
        100_000,
    )
    .expect("valid UUIDv7 backfill job");
    let window = build_window(job.checkpoint(7), timestamp(OBSERVED_AT), &events)
        .expect("backfill digest window");
    let expected_digest = communicator_matrix_gateway::model::framed_hash_id(
        "matrix-backfill-checkpoint-v1",
        &[
            BACKFILL_JOB_ID,
            ROOM_ID,
            BACKFILL_START,
            BACKFILL_END,
            "100000",
            "7",
        ],
    )
    .expect("frozen tuple digest");

    assert_eq!(
        window.batches[0].request.source_checkpoint.value,
        format!("sha256:{expected_digest}")
    );
    let bytes = window.batches[0].exact_request_bytes();
    assert!(
        !bytes
            .windows(BACKFILL_JOB_ID.len())
            .any(|window| window == BACKFILL_JOB_ID.as_bytes())
    );
}

#[test]
fn backfill_ingestion_contract_vector_matches_rust_batching() {
    let fixture: Value = serde_json::from_str(include_str!(
        "../testdata/ingestion-contract-backfill-v1.json"
    ))
    .expect("backfill ingestion contract fixture is valid JSON");
    let mut event = message_event(
        "tenant_demo",
        "evt_backfill_contract",
        OBSERVED_AT,
        OCCURRED_AT,
        "backfill",
    );
    event.event_source = CanonicalEventSource::Backfill;
    let job = BackfillJob::new(
        BACKFILL_JOB_ID,
        ROOM_ID,
        BACKFILL_START,
        BACKFILL_END,
        100_000,
    )
    .expect("valid UUIDv7 backfill job");
    let window = build_window(
        job.checkpoint(0),
        timestamp(OBSERVED_AT),
        &[routed("route_demo", event)],
    )
    .expect("backfill vector window");
    let batch = &window.batches[0];
    assert_eq!(
        serde_json::from_slice::<Value>(batch.exact_request_bytes()).expect("request JSON"),
        fixture.get("request").cloned().expect("fixture request"),
    );
    assert_eq!(
        String::from_utf8(batch.canonical_jsonl.clone()).expect("UTF-8 JSONL"),
        fixture
            .get("canonical_jsonl")
            .and_then(Value::as_str)
            .expect("fixture canonical JSONL"),
    );
    assert_eq!(
        batch.canonical_sha256,
        fixture
            .get("canonical_sha256")
            .and_then(Value::as_str)
            .expect("fixture canonical digest"),
    );
    assert_eq!(
        batch.batch_id,
        fixture["request"]
            .get("batch_id")
            .and_then(Value::as_str)
            .expect("fixture batch ID"),
    );
}

#[test]
fn request_events_remain_unique_and_each_batch_has_one_tenant_and_route() {
    let mut events = Vec::new();
    for (tenant, route) in [
        ("tenant_a", "route_a"),
        ("tenant_a", "route_b"),
        ("tenant_b", "route_a"),
    ] {
        events.push(routed(
            route,
            message_event(
                tenant,
                &format!("evt_{tenant}_{route}"),
                OBSERVED_AT,
                OCCURRED_AT,
                "strict",
            ),
        ));
    }

    let window = live_window(&events);
    for batch in &window.batches {
        assert!(batch.one_tenant_and_route());
        let mut ids = BTreeMap::new();
        for event in &batch.request.events {
            *ids.entry(event.event_id.clone()).or_insert(0_usize) += 1;
            assert_eq!(event.tenant_id, batch.request.tenant_id);
        }
        assert!(ids.values().all(|count| *count == 1));
    }
}
