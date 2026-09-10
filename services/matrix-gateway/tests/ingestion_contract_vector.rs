//! Independent Rust reproduction of the archive-first ingestion contract vector.
//!
//! This test intentionally does not call any TypeScript code (or consume the
//! canonical JSONL from the fixture as its input). It parses the request,
//! serializes each event with the contract's sorted-key JSON rules, and then
//! computes both digests from those independently produced bytes.

use std::collections::BTreeMap;

use serde::Deserialize;
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};

#[derive(Debug, Deserialize)]
struct Fixture {
    request: Request,
    canonical_jsonl: String,
    canonical_sha256: String,
}

#[derive(Debug, Deserialize)]
struct Request {
    schema_version: u8,
    gateway_route_id: String,
    tenant_id: String,
    archived_at: String,
    producer_version: String,
    source_checkpoint: SourceCheckpoint,
    events: Vec<Value>,
    batch_id: String,
}

#[derive(Debug, Deserialize)]
struct SourceCheckpoint {
    kind: String,
    value: String,
}

/// Serialize JSON with the same compact, recursively sorted object keys used
/// by the TypeScript canonical JSON encoder. The vector contains only JSON
/// values, so serde_json's string/number escaping is the same JSON wire format
/// used by the Worker contract.
fn canonical_json(value: &Value) -> String {
    match value {
        Value::Null => "null".to_owned(),
        Value::Bool(value) => value.to_string(),
        Value::Number(value) => value.to_string(),
        Value::String(value) => serde_json::to_string(value).expect("string is JSON-safe"),
        Value::Array(values) => {
            let values = values.iter().map(canonical_json).collect::<Vec<_>>();
            format!("[{}]", values.join(","))
        }
        Value::Object(values) => canonical_object(values),
    }
}

fn canonical_object(values: &Map<String, Value>) -> String {
    // Copy into a BTreeMap rather than relying on serde_json's map feature or
    // insertion order. That makes this serializer independent of fixture key
    // order and mirrors Object.keys(value).sort() for this ASCII contract.
    let sorted = values
        .iter()
        .map(|(key, value)| (key.clone(), value))
        .collect::<BTreeMap<_, _>>();
    let fields = sorted
        .into_iter()
        .map(|(key, value)| {
            let key = serde_json::to_string(&key).expect("key is JSON-safe");
            format!("{key}:{}", canonical_json(value))
        })
        .collect::<Vec<_>>();
    format!("{{{}}}", fields.join(","))
}

fn sha256_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    digest
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>()
}

fn batch_identity(fixture: &Fixture, canonical_sha256: &str) -> Value {
    let mut source_checkpoint = Map::new();
    source_checkpoint.insert(
        "kind".to_owned(),
        Value::String(fixture.request.source_checkpoint.kind.clone()),
    );
    source_checkpoint.insert(
        "value".to_owned(),
        Value::String(fixture.request.source_checkpoint.value.clone()),
    );

    let mut identity = Map::new();
    identity.insert(
        "schema_version".to_owned(),
        Value::from(fixture.request.schema_version),
    );
    identity.insert(
        "tenant_id".to_owned(),
        Value::String(fixture.request.tenant_id.clone()),
    );
    identity.insert(
        "gateway_route_id".to_owned(),
        Value::String(fixture.request.gateway_route_id.clone()),
    );
    identity.insert(
        "canonical_sha256".to_owned(),
        Value::String(canonical_sha256.to_owned()),
    );
    identity.insert(
        "source_checkpoint".to_owned(),
        Value::Object(source_checkpoint),
    );
    identity.insert(
        "archived_at".to_owned(),
        Value::String(fixture.request.archived_at.clone()),
    );
    identity.insert(
        "producer_version".to_owned(),
        Value::String(fixture.request.producer_version.clone()),
    );
    Value::Object(identity)
}

#[test]
fn reproduces_canonical_jsonl_sha256_and_batch_id() {
    let fixture: Fixture =
        serde_json::from_str(include_str!("../testdata/ingestion-contract-v1.json"))
            .expect("ingestion contract fixture is valid JSON");

    // The fixture's events are intentionally treated as unsorted input. The
    // current vector has one event, while this explicit sort keeps the test's
    // preparation boundary visible and deterministic for future vectors.
    let mut events = fixture.request.events.iter().collect::<Vec<_>>();
    events.sort_by_key(|event| {
        (
            event
                .get("observed_at")
                .and_then(Value::as_str)
                .expect("event has observed_at"),
            event
                .get("occurred_at")
                .and_then(Value::as_str)
                .expect("event has occurred_at"),
            event
                .get("event_id")
                .and_then(Value::as_str)
                .expect("event has event_id"),
        )
    });

    let canonical_jsonl = events
        .into_iter()
        .map(|event| format!("{}\n", canonical_json(event)))
        .collect::<String>();
    assert_eq!(canonical_jsonl, fixture.canonical_jsonl);

    let canonical_sha256 = sha256_hex(canonical_jsonl.as_bytes());
    assert_eq!(canonical_sha256, fixture.canonical_sha256);

    let identity_json = canonical_json(&batch_identity(&fixture, &canonical_sha256));
    let batch_id = format!("batch_{}", sha256_hex(identity_json.as_bytes()));
    assert_eq!(batch_id, fixture.request.batch_id);
}
