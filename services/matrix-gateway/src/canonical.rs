//! Canonical JSON serialization for the gateway's deterministic byte boundary.

use std::{cmp::Ordering, collections::HashSet, error::Error, fmt};

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};

use crate::{
    config::{
        CANONICAL_SCHEMA_VERSION, MAX_BATCH_CANONICAL_BYTES, MAX_BATCH_EVENTS,
        MAX_EVENT_CANONICAL_BYTES,
    },
    model::{self, CanonicalEvent},
};

/// Maximum nesting depth accepted by the canonical JSON contract.
pub const MAX_CANONICAL_JSON_DEPTH: usize = 32;
/// Maximum number of JSON value nodes accepted by one canonical document.
pub const MAX_CANONICAL_JSON_NODES: usize = 50_000;
/// Maximum number of entries in one JSON array or object.
pub const MAX_CANONICAL_JSON_COLLECTION_ENTRIES: usize = 10_000;
/// Maximum UTF-16 code units in one JSON object key.
pub const MAX_CANONICAL_JSON_KEY_CHARS: usize = 256;
/// Maximum UTF-16 code units in one JSON string value.
pub const MAX_CANONICAL_JSON_STRING_CHARS: usize = 1024 * 1024;
const MAX_SAFE_INTEGER: i64 = 9_007_199_254_740_991;

const CANONICAL_INVALID: &str = "canonical_invalid";
const CANONICAL_TOO_LARGE: &str = "canonical_too_large";
const CANONICAL_TENANT_MISMATCH: &str = "canonical_tenant_mismatch";

/// A value-free canonical JSON validation error.
///
/// The error contains only a stable code. It never retains the rejected JSON
/// value or any text from that value.
#[derive(Clone, Copy, Eq, PartialEq)]
pub struct CanonicalError {
    code: &'static str,
}

impl CanonicalError {
    const fn invalid() -> Self {
        Self {
            code: CANONICAL_INVALID,
        }
    }

    const fn too_large() -> Self {
        Self {
            code: CANONICAL_TOO_LARGE,
        }
    }

    const fn tenant_mismatch() -> Self {
        Self {
            code: CANONICAL_TENANT_MISMATCH,
        }
    }

    /// Return the stable machine-readable error code.
    pub const fn code(&self) -> &'static str {
        self.code
    }
}

impl fmt::Debug for CanonicalError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("CanonicalError")
            .field("code", &self.code)
            .finish()
    }
}

impl fmt::Display for CanonicalError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.code)
    }
}

impl Error for CanonicalError {}

struct Validation {
    nodes: usize,
}

/// Serialize a JSON value with compact syntax and recursively sorted object
/// keys. Object keys use ECMAScript's UTF-16 code-unit ordering, which differs
/// from Rust's Unicode scalar ordering for some non-BMP characters.
pub fn canonical_json(value: &Value) -> Result<String, CanonicalError> {
    let mut validation = Validation { nodes: 0 };
    serialize_value(value, 0, &mut validation)
}

/// Alias matching the name used by the Worker canonical JSON helper.
pub fn canonical_json_stringify(value: &Value) -> Result<String, CanonicalError> {
    canonical_json(value)
}

/// Serialize a JSON value as one canonical JSON Lines record.
pub fn canonical_json_line(value: &Value) -> Result<String, CanonicalError> {
    let mut serialized = canonical_json(value)?;
    if serialized.as_bytes().contains(&b'\n') || serialized.as_bytes().contains(&b'\r') {
        return Err(CanonicalError::invalid());
    }
    serialized.push('\n');
    Ok(serialized)
}

/// Return the UTF-8 bytes of [`canonical_json`].
pub fn canonical_json_bytes(value: &Value) -> Result<Vec<u8>, CanonicalError> {
    canonical_json(value).map(String::into_bytes)
}

/// Return the UTF-8 bytes of [`canonical_json_line`].
pub fn canonical_json_line_bytes(value: &Value) -> Result<Vec<u8>, CanonicalError> {
    canonical_json_line(value).map(String::into_bytes)
}

/// Serialize one typed canonical event through the generic JSON boundary.
///
/// `serde_json::Value` is intentionally confined to this module. Callers
/// construct events with the typed model, and this conversion is the one
/// place where the recursively sorted JSON representation is produced.
pub fn canonical_event_json(event: &CanonicalEvent) -> Result<String, CanonicalError> {
    event.validate().map_err(map_model_error)?;
    let value = serde_json::to_value(event).map_err(|_| CanonicalError::invalid())?;
    canonical_json(&value)
}

/// Return the UTF-8 bytes for one typed canonical event without a line ending.
pub fn canonical_event_json_bytes(event: &CanonicalEvent) -> Result<Vec<u8>, CanonicalError> {
    canonical_event_json(event).map(String::into_bytes)
}

/// Return one typed canonical event as exactly one JSONL record.
pub fn canonical_event_json_line(event: &CanonicalEvent) -> Result<String, CanonicalError> {
    let mut serialized = canonical_event_json(event)?;
    serialized.push('\n');
    Ok(serialized)
}

/// Return one typed canonical event as UTF-8 JSONL bytes.
pub fn canonical_event_json_line_bytes(event: &CanonicalEvent) -> Result<Vec<u8>, CanonicalError> {
    canonical_event_json_line(event).map(String::into_bytes)
}

/// A digest checkpoint included in the immutable ingestion batch identity.
#[derive(Clone, Eq, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SourceCheckpoint {
    pub kind: String,
    pub value: String,
}

impl fmt::Debug for SourceCheckpoint {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("SourceCheckpoint([REDACTED])")
    }
}

impl fmt::Display for SourceCheckpoint {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("SourceCheckpoint([REDACTED])")
    }
}

/// Input metadata and typed events for one immutable archive batch.
#[derive(Clone, Eq, PartialEq)]
pub struct CanonicalBatchInput {
    pub gateway_route_id: String,
    pub tenant_id: String,
    pub archived_at: String,
    pub producer_version: String,
    pub source_checkpoint: SourceCheckpoint,
    pub events: Vec<CanonicalEvent>,
}

/// The strict request object whose bytes are sent to the ingestion endpoint.
#[derive(Clone, Eq, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CanonicalBatchRequest {
    pub schema_version: u8,
    pub gateway_route_id: String,
    pub tenant_id: String,
    pub batch_id: String,
    pub archived_at: String,
    pub producer_version: String,
    pub source_checkpoint: SourceCheckpoint,
    pub events: Vec<CanonicalEvent>,
}

impl fmt::Debug for CanonicalBatchRequest {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("CanonicalBatchRequest([REDACTED])")
    }
}

impl fmt::Display for CanonicalBatchRequest {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("CanonicalBatchRequest([REDACTED])")
    }
}

/// The deterministic output of canonical event batch encoding.
#[derive(Clone, Eq, PartialEq)]
pub struct CanonicalEventBatch {
    pub request: CanonicalBatchRequest,
    pub events: Vec<CanonicalEvent>,
    pub canonical_jsonl: Vec<u8>,
    pub uncompressed_bytes: usize,
    pub canonical_sha256: String,
    pub batch_id: String,
    pub identity_json: Vec<u8>,
    pub request_json: Vec<u8>,
}

/// Compatibility name matching the Worker archive codec's input type.
pub type EncodeCanonicalEventBatchInput = CanonicalBatchInput;
/// Compatibility name matching the Worker archive codec's output type.
pub type EncodedCanonicalEventBatch = CanonicalEventBatch;
/// Compatibility name for the strict ingestion request object.
pub type IngestionBatchRequest = CanonicalBatchRequest;

impl fmt::Debug for CanonicalEventBatch {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("CanonicalEventBatch([REDACTED])")
    }
}

impl fmt::Display for CanonicalEventBatch {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("CanonicalEventBatch([REDACTED])")
    }
}

/// Encode typed events into the archive's canonical JSONL and batch identity.
pub fn encode_canonical_event_batch(
    input: CanonicalBatchInput,
) -> Result<CanonicalEventBatch, CanonicalError> {
    validate_batch_metadata(&input)?;
    if input.events.is_empty() {
        return Err(CanonicalError::invalid());
    }
    if input.events.len() > MAX_BATCH_EVENTS {
        return Err(CanonicalError::too_large());
    }

    let mut seen_event_ids = HashSet::with_capacity(input.events.len());
    for event in &input.events {
        event.validate().map_err(map_model_error)?;
        if event.tenant_id != input.tenant_id {
            return Err(CanonicalError::tenant_mismatch());
        }
        if !seen_event_ids.insert(event.event_id.as_str()) {
            return Err(CanonicalError::invalid());
        }
    }

    let mut events = input.events.clone();
    events.sort_unstable_by(compare_events);

    let mut chunks = Vec::with_capacity(events.len());
    let mut total = 0usize;
    for event in &events {
        let line = canonical_event_json_line_bytes(event)?;
        let event_bytes = line
            .len()
            .checked_sub(1)
            .ok_or_else(CanonicalError::invalid)?;
        if event_bytes > MAX_EVENT_CANONICAL_BYTES {
            return Err(CanonicalError::too_large());
        }
        total = total
            .checked_add(line.len())
            .ok_or_else(CanonicalError::too_large)?;
        if total > MAX_BATCH_CANONICAL_BYTES {
            return Err(CanonicalError::too_large());
        }
        chunks.push(line);
    }

    let mut canonical_jsonl = Vec::with_capacity(total);
    for chunk in chunks {
        canonical_jsonl.extend_from_slice(&chunk);
    }
    let canonical_sha256 = sha256_hex(&canonical_jsonl);
    let identity_json = batch_identity_json(&input, &canonical_sha256)?;
    let batch_id = format!("batch_{}", sha256_hex(&identity_json));

    let request = CanonicalBatchRequest {
        schema_version: CANONICAL_SCHEMA_VERSION,
        gateway_route_id: input.gateway_route_id,
        tenant_id: input.tenant_id,
        batch_id,
        archived_at: input.archived_at,
        producer_version: input.producer_version,
        source_checkpoint: input.source_checkpoint,
        events: events.clone(),
    };
    let request_value = serde_json::to_value(&request).map_err(|_| CanonicalError::invalid())?;
    let request_json = canonical_json_bytes(&request_value)?;

    Ok(CanonicalEventBatch {
        request,
        events,
        canonical_jsonl,
        uncompressed_bytes: total,
        canonical_sha256,
        batch_id: request_value
            .get("batch_id")
            .and_then(Value::as_str)
            .ok_or_else(CanonicalError::invalid)?
            .to_owned(),
        identity_json,
        request_json,
    })
}

fn map_model_error(error: crate::model::ModelError) -> CanonicalError {
    if error.code() == "model_canonical_too_large" {
        CanonicalError::too_large()
    } else {
        CanonicalError::invalid()
    }
}

/// Compute lowercase SHA-256 as the canonical hexadecimal digest.
pub fn sha256_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    let mut result = String::with_capacity(digest.len() * 2);
    for byte in digest {
        result.push_str(&format!("{byte:02x}"));
    }
    result
}

/// Serialize the exact immutable batch identity object used for `batch_id`.
pub fn batch_identity_json(
    input: &CanonicalBatchInput,
    canonical_sha256: &str,
) -> Result<Vec<u8>, CanonicalError> {
    #[derive(Serialize)]
    struct Identity<'a> {
        schema_version: u8,
        tenant_id: &'a str,
        gateway_route_id: &'a str,
        canonical_sha256: &'a str,
        source_checkpoint: &'a SourceCheckpoint,
        archived_at: &'a str,
        producer_version: &'a str,
    }

    let identity = Identity {
        schema_version: CANONICAL_SCHEMA_VERSION,
        tenant_id: &input.tenant_id,
        gateway_route_id: &input.gateway_route_id,
        canonical_sha256,
        source_checkpoint: &input.source_checkpoint,
        archived_at: &input.archived_at,
        producer_version: &input.producer_version,
    };
    let value = serde_json::to_value(identity).map_err(|_| CanonicalError::invalid())?;
    canonical_json_bytes(&value)
}

/// Derive the immutable batch identifier from canonical JSONL bytes and
/// request metadata.
pub fn batch_id(
    input: &CanonicalBatchInput,
    canonical_sha256: &str,
) -> Result<String, CanonicalError> {
    let identity = batch_identity_json(input, canonical_sha256)?;
    Ok(format!("batch_{}", sha256_hex(&identity)))
}

fn validate_batch_metadata(input: &CanonicalBatchInput) -> Result<(), CanonicalError> {
    if !valid_resource_id(&input.gateway_route_id) || !valid_resource_id(&input.tenant_id) {
        return Err(CanonicalError::invalid());
    }
    if !model::valid_timestamp(&input.archived_at)
        || input.producer_version.is_empty()
        || input.producer_version.len() > 128
        || input
            .producer_version
            .bytes()
            .any(|byte| !(0x20..=0x7e).contains(&byte))
        || input.producer_version.trim() != input.producer_version
    {
        return Err(CanonicalError::invalid());
    }
    if input.source_checkpoint.kind != "matrix_sync_token_sha256"
        || !input.source_checkpoint.value.starts_with("sha256:")
        || input.source_checkpoint.value.len() != "sha256:".len() + 64
        || !input.source_checkpoint.value["sha256:".len()..]
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
    {
        return Err(CanonicalError::invalid());
    }
    Ok(())
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

fn compare_events(left: &CanonicalEvent, right: &CanonicalEvent) -> Ordering {
    let left_key = left.ordering_key();
    let right_key = right.ordering_key();
    left_key
        .observed_at_millis()
        .cmp(&right_key.observed_at_millis())
        .then_with(|| {
            left_key
                .occurred_at_millis()
                .cmp(&right_key.occurred_at_millis())
        })
        .then_with(|| utf16_cmp(left_key.event_id(), right_key.event_id()))
}

fn serialize_value(
    value: &Value,
    depth: usize,
    validation: &mut Validation,
) -> Result<String, CanonicalError> {
    if depth > MAX_CANONICAL_JSON_DEPTH {
        return Err(CanonicalError::invalid());
    }
    validation.nodes = validation
        .nodes
        .checked_add(1)
        .ok_or_else(CanonicalError::invalid)?;
    if validation.nodes > MAX_CANONICAL_JSON_NODES {
        return Err(CanonicalError::invalid());
    }

    match value {
        Value::Null => Ok(String::from("null")),
        Value::Bool(value) => Ok(if *value {
            String::from("true")
        } else {
            String::from("false")
        }),
        Value::Number(value) => {
            let safe_integer = value
                .as_i64()
                .is_some_and(|number| (-MAX_SAFE_INTEGER..=MAX_SAFE_INTEGER).contains(&number))
                || value
                    .as_u64()
                    .is_some_and(|number| number <= MAX_SAFE_INTEGER as u64);
            if !safe_integer {
                return Err(CanonicalError::invalid());
            }
            Ok(value.to_string())
        }
        Value::String(value) => {
            if utf16_len(value) > MAX_CANONICAL_JSON_STRING_CHARS {
                return Err(CanonicalError::invalid());
            }
            serde_json::to_string(value).map_err(|_| CanonicalError::invalid())
        }
        Value::Array(values) => serialize_array(values, depth, validation),
        Value::Object(values) => serialize_object(values, depth, validation),
    }
}

fn serialize_array(
    values: &[Value],
    depth: usize,
    validation: &mut Validation,
) -> Result<String, CanonicalError> {
    if values.len() > MAX_CANONICAL_JSON_COLLECTION_ENTRIES {
        return Err(CanonicalError::invalid());
    }

    let mut serialized = String::from("[");
    for (index, value) in values.iter().enumerate() {
        if index > 0 {
            serialized.push(',');
        }
        serialized.push_str(&serialize_value(value, depth + 1, validation)?);
    }
    serialized.push(']');
    Ok(serialized)
}

fn serialize_object(
    values: &Map<String, Value>,
    depth: usize,
    validation: &mut Validation,
) -> Result<String, CanonicalError> {
    if values.len() > MAX_CANONICAL_JSON_COLLECTION_ENTRIES {
        return Err(CanonicalError::invalid());
    }

    let mut keys = values.keys().collect::<Vec<_>>();
    for key in &keys {
        if is_invalid_key(key) {
            return Err(CanonicalError::invalid());
        }
    }
    keys.sort_unstable_by(|left, right| utf16_cmp(left, right));

    let mut serialized = String::from("{");
    for (index, key) in keys.iter().enumerate() {
        if index > 0 {
            serialized.push(',');
        }
        let encoded_key = serde_json::to_string(key).map_err(|_| CanonicalError::invalid())?;
        serialized.push_str(&encoded_key);
        serialized.push(':');
        let value = values.get(*key).ok_or_else(CanonicalError::invalid)?;
        serialized.push_str(&serialize_value(value, depth + 1, validation)?);
    }
    serialized.push('}');
    Ok(serialized)
}

fn is_invalid_key(key: &str) -> bool {
    matches!(key, "__proto__" | "prototype" | "constructor")
        || utf16_len(key) > MAX_CANONICAL_JSON_KEY_CHARS
}

fn utf16_len(value: &str) -> usize {
    value.encode_utf16().count()
}

fn utf16_cmp(left: &str, right: &str) -> Ordering {
    left.encode_utf16().cmp(right.encode_utf16())
}
