//! Deterministic Matrix ingestion-window partitioning and request construction.
//!
//! This module is the boundary between normalized events and the encrypted
//! ingestion outbox. It keeps source checkpoints as protected input, emits
//! only their digests, and returns request bytes that have passed a typed
//! deserialize and identity check.

use std::{
    cmp::Ordering,
    collections::BTreeMap,
    error::Error,
    fmt,
    time::{SystemTime, UNIX_EPOCH},
};

use chrono::{DateTime, Duration, SecondsFormat, Utc};
use rand_core::{OsRng, RngCore};
use uuid::Uuid;

use crate::{
    canonical::{
        self, CanonicalBatchInput, CanonicalBatchRequest, CanonicalError, CanonicalEventBatch,
        SourceCheckpoint,
    },
    config::{
        CANONICAL_SCHEMA_VERSION, MAX_BATCH_CANONICAL_BYTES, MAX_BATCH_EVENTS,
        MAX_EVENT_CANONICAL_BYTES, PRODUCER_VERSION,
    },
    model::{self, CanonicalEvent},
    store_types::MAX_SYNC_TOKEN_BYTES,
};

/// Maximum accepted event count for one explicit backfill invocation.
pub const MAX_BACKFILL_EVENTS: u64 = 100_000;
/// Maximum accepted wall-clock interval for one explicit backfill invocation.
pub const MAX_BACKFILL_INTERVAL_DAYS: i64 = 90;

/// Stable reason for an event that cannot fit the canonical event limit.
pub const BATCH_EVENT_TOO_LARGE: &str = "batch_event_too_large";
/// Stable reason for an event that fails the canonical model boundary.
pub const BATCH_EVENT_INVALID: &str = "batch_event_invalid";
/// Stable reason for conflicting canonical bytes under one event ID.
pub const BATCH_DUPLICATE_ID_CONFLICT: &str = "batch_duplicate_id_conflict";
/// Stable error for malformed or unsupported window source input.
pub const BATCH_INVALID_SOURCE: &str = "batch_invalid_source";
/// Stable error for malformed batch metadata or request bytes.
pub const BATCH_INVALID_REQUEST: &str = "batch_invalid_request";
/// Stable error for an encoder result that violates the frozen limits.
pub const BATCH_ENCODING_FAILED: &str = "batch_encoding_failed";
/// Stable error when an explicit backfill exceeds its invocation limit.
pub const BATCH_BACKFILL_TOO_LARGE: &str = "batch_backfill_too_large";

/// A value-free error returned by batch construction and request verification.
#[derive(Clone, Copy, Eq, PartialEq)]
pub struct BatchError {
    code: &'static str,
}

impl BatchError {
    const fn new(code: &'static str) -> Self {
        Self { code }
    }

    /// Return the stable machine-readable error code.
    pub const fn code(self) -> &'static str {
        self.code
    }
}

impl fmt::Debug for BatchError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("BatchError")
            .field("code", &self.code)
            .finish()
    }
}

impl fmt::Display for BatchError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.code)
    }
}

impl Error for BatchError {}

/// One normalized event together with the verified gateway route that owns it.
#[derive(Clone, Eq, PartialEq)]
pub struct RoutedEvent {
    gateway_route_id: String,
    pub event: CanonicalEvent,
}

impl RoutedEvent {
    /// Attach one canonical event to its immutable gateway route.
    pub fn new(gateway_route_id: impl Into<String>, event: CanonicalEvent) -> Self {
        Self {
            gateway_route_id: gateway_route_id.into(),
            event,
        }
    }

    /// Return the route used for partitioning and request metadata.
    pub fn gateway_route_id(&self) -> &str {
        &self.gateway_route_id
    }

    /// Borrow the canonical event.
    pub fn event(&self) -> &CanonicalEvent {
        &self.event
    }
}

impl fmt::Debug for RoutedEvent {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("RoutedEvent([REDACTED])")
    }
}

/// A source checkpoint for one live sync window or one explicit backfill run.
#[derive(Clone, Eq, PartialEq)]
pub enum WindowSource {
    /// The raw Matrix `next_batch` token stays local and is never serialized.
    Live { next_batch: Vec<u8> },
    /// A digest-bound backfill checkpoint with no raw pagination token.
    Backfill(BackfillCheckpoint),
}

impl WindowSource {
    /// Construct a live source from the raw Matrix `next_batch` token.
    pub fn live(next_batch: impl AsRef<[u8]>) -> Self {
        Self::Live {
            next_batch: next_batch.as_ref().to_vec(),
        }
    }

    /// Construct a source from an already validated backfill checkpoint.
    pub fn backfill(checkpoint: BackfillCheckpoint) -> Self {
        Self::Backfill(checkpoint)
    }
}

impl fmt::Debug for WindowSource {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("WindowSource([REDACTED])")
    }
}

/// The immutable fields shared by all batches in one explicit backfill run.
#[derive(Clone, Eq, PartialEq)]
pub struct BackfillJob {
    job_id: String,
    room_id: String,
    start_at: String,
    end_at: String,
    max_events: u64,
}

impl BackfillJob {
    /// Construct a bounded operator-requested job with a UUIDv7 ID.
    pub fn new(
        job_id: impl Into<String>,
        room_id: impl Into<String>,
        start_at: impl AsRef<str>,
        end_at: impl AsRef<str>,
        max_events: u64,
    ) -> Result<Self, BatchError> {
        let job = Self {
            job_id: job_id.into(),
            room_id: room_id.into(),
            start_at: canonical_timestamp(start_at.as_ref())?,
            end_at: canonical_timestamp(end_at.as_ref())?,
            max_events,
        };
        validate_backfill_job(&job)?;
        Ok(job)
    }

    /// Create a new operator-run UUIDv7 job using OS randomness.
    pub fn new_uuid_v7(
        room_id: impl Into<String>,
        start_at: impl AsRef<str>,
        end_at: impl AsRef<str>,
        max_events: u64,
    ) -> Result<Self, BatchError> {
        let mut bytes = [0_u8; 16];
        let millis = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|_| BatchError::new(BATCH_INVALID_SOURCE))?
            .as_millis();
        let millis = u64::try_from(millis).map_err(|_| BatchError::new(BATCH_INVALID_SOURCE))?;
        for (index, shift) in (0..6).rev().zip((0..6).map(|index| index * 8)) {
            bytes[index] = (millis >> shift) as u8;
        }

        let mut random = [0_u8; 10];
        OsRng
            .try_fill_bytes(&mut random)
            .map_err(|_| BatchError::new(BATCH_INVALID_SOURCE))?;
        bytes[6] = 0x70 | (random[0] & 0x0f);
        bytes[7] = random[1];
        bytes[8] = 0x80 | (random[2] & 0x3f);
        bytes[9..].copy_from_slice(&random[3..]);

        Self::new(
            Uuid::from_bytes(bytes).to_string(),
            room_id,
            start_at,
            end_at,
            max_events,
        )
    }

    /// Return the stable job ID.
    pub fn job_id(&self) -> &str {
        &self.job_id
    }

    /// Return the exact normalized room ID used in the checkpoint tuple.
    pub fn room_id(&self) -> &str {
        &self.room_id
    }

    /// Return the frozen UTC start timestamp.
    pub fn start_at(&self) -> &str {
        &self.start_at
    }

    /// Return the frozen UTC end timestamp.
    pub fn end_at(&self) -> &str {
        &self.end_at
    }

    /// Return the invocation event limit.
    pub const fn max_events(&self) -> u64 {
        self.max_events
    }

    /// Create the digest-bound checkpoint for one output batch ordinal.
    pub fn checkpoint(&self, batch_ordinal: u64) -> WindowSource {
        WindowSource::backfill(BackfillCheckpoint {
            job_id: self.job_id.clone(),
            room_id: self.room_id.clone(),
            start_at: self.start_at.clone(),
            end_at: self.end_at.clone(),
            max_events: self.max_events,
            batch_ordinal,
        })
    }
}

impl fmt::Debug for BackfillJob {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("BackfillJob([REDACTED])")
    }
}

/// One digest-bound backfill checkpoint, including its batch ordinal.
#[derive(Clone, Eq, PartialEq)]
pub struct BackfillCheckpoint {
    job_id: String,
    room_id: String,
    start_at: String,
    end_at: String,
    max_events: u64,
    batch_ordinal: u64,
}

impl BackfillCheckpoint {
    /// Construct and validate one exact backfill checkpoint.
    pub fn new(
        job_id: impl Into<String>,
        room_id: impl Into<String>,
        start_at: impl AsRef<str>,
        end_at: impl AsRef<str>,
        max_events: u64,
        batch_ordinal: u64,
    ) -> Result<Self, BatchError> {
        let checkpoint = Self {
            job_id: job_id.into(),
            room_id: room_id.into(),
            start_at: canonical_timestamp(start_at.as_ref())?,
            end_at: canonical_timestamp(end_at.as_ref())?,
            max_events,
            batch_ordinal,
        };
        validate_backfill_checkpoint(&checkpoint)?;
        Ok(checkpoint)
    }

    /// Return the job ID used by the checkpoint digest.
    pub fn job_id(&self) -> &str {
        &self.job_id
    }

    /// Return the room ID used by the checkpoint digest.
    pub fn room_id(&self) -> &str {
        &self.room_id
    }

    /// Return the frozen start timestamp.
    pub fn start_at(&self) -> &str {
        &self.start_at
    }

    /// Return the frozen end timestamp.
    pub fn end_at(&self) -> &str {
        &self.end_at
    }

    /// Return the invocation event limit.
    pub const fn max_events(&self) -> u64 {
        self.max_events
    }

    /// Return the output batch ordinal.
    pub const fn batch_ordinal(&self) -> u64 {
        self.batch_ordinal
    }
}

impl fmt::Debug for BackfillCheckpoint {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("BackfillCheckpoint([REDACTED])")
    }
}

/// A content-free quarantine record for one or more rejected input events.
#[derive(Clone, Eq, PartialEq)]
pub struct BatchQuarantine {
    reason_code: &'static str,
    count: usize,
}

impl BatchQuarantine {
    const fn new(reason_code: &'static str, count: usize) -> Self {
        Self { reason_code, count }
    }

    /// Return the stable reason code.
    pub const fn reason_code(&self) -> &'static str {
        self.reason_code
    }

    /// Return the number of input events represented by this record.
    pub const fn count(&self) -> usize {
        self.count
    }
}

impl fmt::Debug for BatchQuarantine {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("BatchQuarantine")
            .field("reason_code", &self.reason_code)
            .field("count", &self.count)
            .finish()
    }
}

/// One fully verified immutable ingestion batch.
#[derive(Clone, Eq, PartialEq)]
pub struct BuiltBatch {
    /// The strict typed request parsed from `request_json`.
    pub request: CanonicalBatchRequest,
    /// The event order used by canonical JSONL and the request.
    pub events: Vec<CanonicalEvent>,
    /// Canonical event JSON followed by LF for each event.
    pub canonical_jsonl: Vec<u8>,
    /// Byte count of `canonical_jsonl`.
    pub uncompressed_bytes: usize,
    /// Lowercase SHA-256 of `canonical_jsonl`.
    pub canonical_sha256: String,
    /// Deterministic immutable batch ID.
    pub batch_id: String,
    /// Canonical identity object bytes used for `batch_id`.
    pub identity_json: Vec<u8>,
    /// Exact request bytes that belong in the ingestion outbox.
    pub request_json: Vec<u8>,
}

impl BuiltBatch {
    /// Return the exact request bytes without reconstructing them.
    pub fn exact_request_bytes(&self) -> &[u8] {
        &self.request_json
    }

    /// Return the request tenant.
    pub fn tenant_id(&self) -> &str {
        &self.request.tenant_id
    }

    /// Return the request route.
    pub fn gateway_route_id(&self) -> &str {
        &self.request.gateway_route_id
    }

    /// Prove the batch has one tenant, one route, and unique event IDs.
    pub fn one_tenant_and_route(&self) -> bool {
        if self.events.is_empty()
            || self.events.len() != self.request.events.len()
            || self.request.schema_version != CANONICAL_SCHEMA_VERSION
        {
            return false;
        }
        let mut event_ids = std::collections::HashSet::with_capacity(self.events.len());
        self.events.iter().all(|event| {
            event.tenant_id == self.request.tenant_id && event_ids.insert(&event.event_id)
        })
    }
}

impl fmt::Debug for BuiltBatch {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("BuiltBatch([REDACTED])")
    }
}

/// The deterministic output for one sync or backfill processing window.
#[derive(Clone, Eq, PartialEq)]
pub struct BatchWindow {
    /// The one frozen UTC timestamp used by all output batches.
    pub archived_at: String,
    /// The base source checkpoint digest for this window.
    pub source_checkpoint: SourceCheckpoint,
    /// Stable partition-then-ordinal output order.
    pub batches: Vec<BuiltBatch>,
    /// Content-free rejected-event records.
    pub quarantined: Vec<BatchQuarantine>,
}

impl BatchWindow {
    /// Return all exact request bodies in stable output order.
    pub fn exact_request_bytes(&self) -> Vec<Vec<u8>> {
        self.batches
            .iter()
            .map(|batch| batch.request_json.clone())
            .collect()
    }

    /// Return the total number of quarantined input events.
    pub fn quarantined_count(&self) -> usize {
        self.quarantined.iter().map(BatchQuarantine::count).sum()
    }
}

impl fmt::Debug for BatchWindow {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("BatchWindow([REDACTED])")
    }
}

struct PreparedEvent {
    routed: RoutedEvent,
    canonical_bytes: Vec<u8>,
    line_bytes: Vec<u8>,
}

struct DuplicateGroup {
    first: PreparedEvent,
    count: usize,
    conflict: bool,
}

struct Partition {
    tenant_id: String,
    gateway_route_id: String,
    events: Vec<PreparedEvent>,
}

/// Build deterministic, tenant-and-route-isolated ingestion batches.
pub fn build_window(
    source: WindowSource,
    archived_at: DateTime<Utc>,
    events: &[RoutedEvent],
) -> Result<BatchWindow, BatchError> {
    let archived_at = archived_at.to_rfc3339_opts(SecondsFormat::Millis, true);
    let base_checkpoint = source_checkpoint(&source, 0)?;
    let backfill_limit = match &source {
        WindowSource::Live { .. } => None,
        WindowSource::Backfill(checkpoint) => Some(checkpoint.max_events),
    };

    let (prepared, mut quarantined) = preprocess_events(events);
    if backfill_limit.is_some_and(|limit| prepared.len() as u64 > limit) {
        return Err(BatchError::new(BATCH_BACKFILL_TOO_LARGE));
    }

    let mut partitions = collect_partitions(prepared);
    partitions.sort_by(compare_partitions);

    let mut batches = Vec::new();
    let mut batch_offset = 0_u64;
    for partition in partitions {
        let chunks = split_partition(partition.events);
        for chunk in chunks {
            let checkpoint = source_checkpoint(&source, batch_offset)?;
            let input = CanonicalBatchInput {
                gateway_route_id: partition.gateway_route_id.clone(),
                tenant_id: partition.tenant_id.clone(),
                archived_at: archived_at.clone(),
                producer_version: PRODUCER_VERSION.to_owned(),
                source_checkpoint: checkpoint,
                events: chunk.into_iter().map(|event| event.routed.event).collect(),
            };
            batches.push(BuiltBatch::from_verified(encode_batch(input)?));
            batch_offset = batch_offset
                .checked_add(1)
                .ok_or_else(|| BatchError::new(BATCH_INVALID_SOURCE))?;
        }
    }

    quarantined.shrink_to_fit();
    Ok(BatchWindow {
        archived_at,
        source_checkpoint: base_checkpoint,
        batches,
        quarantined,
    })
}

/// Reparse strict request bytes and recompute their canonical content and ID.
pub fn reparse_and_verify_request(
    request_bytes: &[u8],
) -> Result<CanonicalBatchRequest, BatchError> {
    let request = serde_json::from_slice::<CanonicalBatchRequest>(request_bytes)
        .map_err(|_| BatchError::new(BATCH_INVALID_REQUEST))?;
    let value =
        serde_json::to_value(&request).map_err(|_| BatchError::new(BATCH_INVALID_REQUEST))?;
    let canonical_request = canonical::canonical_json_bytes(&value)
        .map_err(|_| BatchError::new(BATCH_INVALID_REQUEST))?;
    if canonical_request != request_bytes {
        return Err(BatchError::new(BATCH_INVALID_REQUEST));
    }

    validate_request_metadata(&request)?;
    if request.events.is_empty() || request.events.len() > MAX_BATCH_EVENTS {
        return Err(BatchError::new(BATCH_INVALID_REQUEST));
    }

    let mut sorted_events = request.events.clone();
    sorted_events.sort_by_key(|event| event.ordering_key());
    if sorted_events != request.events {
        return Err(BatchError::new(BATCH_INVALID_REQUEST));
    }

    let mut event_ids = std::collections::HashSet::with_capacity(request.events.len());
    for event in &request.events {
        if event.tenant_id != request.tenant_id || !event_ids.insert(&event.event_id) {
            return Err(BatchError::new(BATCH_INVALID_REQUEST));
        }
    }
    let canonical_jsonl = canonical_lines(&request.events)?;
    let canonical_sha256 = canonical::sha256_hex(&canonical_jsonl);
    let input = request_input(&request);
    let identity_json = canonical::batch_identity_json(&input, &canonical_sha256)
        .map_err(|_| BatchError::new(BATCH_INVALID_REQUEST))?;
    let expected_batch_id = format!("batch_{}", canonical::sha256_hex(&identity_json));
    if request.batch_id != expected_batch_id {
        return Err(BatchError::new(BATCH_INVALID_REQUEST));
    }
    Ok(request)
}

impl BuiltBatch {
    fn from_verified(encoded: CanonicalEventBatch) -> Self {
        Self {
            request: encoded.request,
            events: encoded.events,
            canonical_jsonl: encoded.canonical_jsonl,
            uncompressed_bytes: encoded.uncompressed_bytes,
            canonical_sha256: encoded.canonical_sha256,
            batch_id: encoded.batch_id,
            identity_json: encoded.identity_json,
            request_json: encoded.request_json,
        }
    }
}

fn preprocess_events(events: &[RoutedEvent]) -> (Vec<PreparedEvent>, Vec<BatchQuarantine>) {
    let mut groups = BTreeMap::<String, DuplicateGroup>::new();
    let mut quarantined = Vec::new();

    for routed in events {
        if !model::valid_resource_id(routed.gateway_route_id()) {
            quarantined.push(BatchQuarantine::new(BATCH_EVENT_INVALID, 1));
            continue;
        }
        let canonical_bytes = match canonical::canonical_event_json_bytes(&routed.event) {
            Ok(bytes) => bytes,
            Err(error)
                if error.code() == "canonical_too_large"
                    || event_text_bytes(&routed.event) > MAX_EVENT_CANONICAL_BYTES =>
            {
                quarantined.push(BatchQuarantine::new(BATCH_EVENT_TOO_LARGE, 1));
                continue;
            }
            Err(_) => {
                quarantined.push(BatchQuarantine::new(BATCH_EVENT_INVALID, 1));
                continue;
            }
        };
        if canonical_bytes.len() > MAX_EVENT_CANONICAL_BYTES {
            quarantined.push(BatchQuarantine::new(BATCH_EVENT_TOO_LARGE, 1));
            continue;
        }
        let mut line_bytes = canonical_bytes.clone();
        line_bytes.push(b'\n');
        let prepared = PreparedEvent {
            routed: routed.clone(),
            canonical_bytes,
            line_bytes,
        };
        let event_id = prepared.routed.event.event_id.clone();
        if let Some(group) = groups.get_mut(&event_id) {
            group.count += 1;
            if group.first.canonical_bytes != prepared.canonical_bytes
                || group.first.routed.gateway_route_id != prepared.routed.gateway_route_id
                || group.first.routed.event.tenant_id != prepared.routed.event.tenant_id
            {
                group.conflict = true;
            }
        } else {
            groups.insert(
                event_id,
                DuplicateGroup {
                    first: prepared,
                    count: 1,
                    conflict: false,
                },
            );
        }
    }

    let mut prepared = Vec::with_capacity(groups.len());
    for group in groups.into_values() {
        if group.conflict {
            quarantined.push(BatchQuarantine::new(
                BATCH_DUPLICATE_ID_CONFLICT,
                group.count,
            ));
        } else {
            prepared.push(group.first);
        }
    }
    (prepared, quarantined)
}

fn event_text_bytes(event: &CanonicalEvent) -> usize {
    let mut total = 0_usize;
    let mut add = |value: &str| {
        total = total.saturating_add(value.len());
    };
    add(&event.event_id);
    add(&event.tenant_id);
    add(&event.identity_id);
    add(&event.account_id);
    add(&event.conversation_id);
    add(event.matrix_room_id.as_deref().unwrap_or_default());
    add(event.matrix_event_id.as_deref().unwrap_or_default());
    add(event.remote_message_id.as_deref().unwrap_or_default());
    add(&event.occurred_at);
    add(&event.observed_at);
    match &event.payload {
        model::CanonicalPayload::MessageCreated(value) => {
            add(&value.message_id);
            add(value.sender_participant_id.as_deref().unwrap_or_default());
            add(&value.sender_label);
            add(&value.body);
            add(value.reply_to_message_id.as_deref().unwrap_or_default());
        }
        model::CanonicalPayload::MessageEdited(value) => {
            add(&value.message_id);
            add(&value.body);
            add(value.editor_participant_id.as_deref().unwrap_or_default());
        }
        model::CanonicalPayload::MessageDeleted(value) => {
            add(&value.message_id);
            add(value.reason_code.as_deref().unwrap_or_default());
        }
        model::CanonicalPayload::ReactionAdded(value) => {
            add(&value.reaction_id);
            add(&value.message_id);
            add(&value.participant_id);
            add(&value.emoji);
        }
        model::CanonicalPayload::ReactionRemoved(value) => {
            add(&value.reaction_id);
            add(&value.message_id);
        }
        model::CanonicalPayload::ReceiptRead(value)
        | model::CanonicalPayload::ReceiptDelivered(value) => {
            add(&value.message_id);
            add(&value.participant_id);
        }
        model::CanonicalPayload::TypingStarted(value) => {
            add(&value.participant_id);
            add(&value.expires_at);
        }
        model::CanonicalPayload::TypingStopped(value) => add(&value.participant_id),
        model::CanonicalPayload::AttachmentObserved(value) => {
            add(&value.attachment_id);
            add(&value.message_id);
            add(value.file_name.as_deref().unwrap_or_default());
            add(value.mime_type.as_deref().unwrap_or_default());
            add(value.sha256.as_deref().unwrap_or_default());
            add(value.r2_key.as_deref().unwrap_or_default());
        }
        model::CanonicalPayload::ConversationUpdated(value) => add(&value.title),
        model::CanonicalPayload::ParticipantUpdated(value) => {
            add(&value.participant_id);
            add(&value.display_name);
            add(value.remote_id.as_deref().unwrap_or_default());
            add(value.avatar_url.as_deref().unwrap_or_default());
        }
        model::CanonicalPayload::CommandUpdated(value) => {
            add(&value.command_id);
            add(&value.operation);
            add(value.failure_code.as_deref().unwrap_or_default());
        }
        model::CanonicalPayload::BridgeDeliveryUpdated(value) => {
            add(&value.message_id);
            add(value.failure_code.as_deref().unwrap_or_default());
        }
        model::CanonicalPayload::ReplayTombstone(value)
        | model::CanonicalPayload::CorrectionApplied(value) => {
            add(&value.target_event_id);
            add(&value.reason_code);
        }
        model::CanonicalPayload::DeletionTombstone(value) => {
            add(&value.resource_id);
            add(&value.reason_code);
        }
    }
    total
}

fn collect_partitions(prepared: Vec<PreparedEvent>) -> Vec<Partition> {
    let mut partitions = Vec::<Partition>::new();
    for event in prepared {
        let tenant_id = event.routed.event.tenant_id.clone();
        let gateway_route_id = event.routed.gateway_route_id.clone();
        if let Some(partition) = partitions.iter_mut().find(|partition| {
            partition.tenant_id == tenant_id && partition.gateway_route_id == gateway_route_id
        }) {
            partition.events.push(event);
        } else {
            partitions.push(Partition {
                tenant_id,
                gateway_route_id,
                events: vec![event],
            });
        }
    }
    for partition in &mut partitions {
        partition.events.sort_by(|left, right| {
            left.routed
                .event
                .ordering_key()
                .cmp(&right.routed.event.ordering_key())
        });
    }
    partitions
}

fn compare_partitions(left: &Partition, right: &Partition) -> Ordering {
    utf8_cmp(&left.tenant_id, &right.tenant_id)
        .then_with(|| utf8_cmp(&left.gateway_route_id, &right.gateway_route_id))
}

fn utf8_cmp(left: &str, right: &str) -> Ordering {
    left.as_bytes().cmp(right.as_bytes())
}

fn split_partition(events: Vec<PreparedEvent>) -> Vec<Vec<PreparedEvent>> {
    let mut chunks = Vec::new();
    let mut current = Vec::new();
    let mut current_bytes = 0_usize;

    for event in events {
        let exceeds_events = current.len() == MAX_BATCH_EVENTS;
        let exceeds_bytes = !current.is_empty()
            && current_bytes.saturating_add(event.line_bytes.len()) > MAX_BATCH_CANONICAL_BYTES;
        if exceeds_events || exceeds_bytes {
            chunks.push(current);
            current = Vec::new();
            current_bytes = 0;
        }
        current_bytes = current_bytes.saturating_add(event.line_bytes.len());
        current.push(event);
    }
    if !current.is_empty() {
        chunks.push(current);
    }
    chunks
}

fn encode_batch(input: CanonicalBatchInput) -> Result<CanonicalEventBatch, BatchError> {
    let encoded = if input.source_checkpoint.kind == "matrix_sync_token_sha256" {
        canonical::encode_canonical_event_batch(input.clone()).map_err(map_canonical_error)?
    } else if input.source_checkpoint.kind == "matrix_backfill_run_sha256" {
        encode_backfill_batch(input.clone())?
    } else {
        return Err(BatchError::new(BATCH_INVALID_SOURCE));
    };
    verify_encoded_batch(encoded, &input)
}

fn encode_backfill_batch(input: CanonicalBatchInput) -> Result<CanonicalEventBatch, BatchError> {
    validate_batch_input(&input)?;
    let mut events = input.events.clone();
    events.sort_by_key(|event| event.ordering_key());
    let canonical_jsonl = canonical_lines(&events)?;
    let canonical_sha256 = canonical::sha256_hex(&canonical_jsonl);
    let identity_json = canonical::batch_identity_json(&input, &canonical_sha256)
        .map_err(|_| BatchError::new(BATCH_INVALID_REQUEST))?;
    let batch_id = format!("batch_{}", canonical::sha256_hex(&identity_json));
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
    let request_value =
        serde_json::to_value(&request).map_err(|_| BatchError::new(BATCH_INVALID_REQUEST))?;
    let request_json = canonical::canonical_json_bytes(&request_value)
        .map_err(|_| BatchError::new(BATCH_INVALID_REQUEST))?;
    let uncompressed_bytes = canonical_jsonl.len();
    Ok(CanonicalEventBatch {
        request,
        events,
        uncompressed_bytes,
        canonical_jsonl,
        canonical_sha256,
        batch_id: request_value
            .get("batch_id")
            .and_then(serde_json::Value::as_str)
            .ok_or_else(|| BatchError::new(BATCH_INVALID_REQUEST))?
            .to_owned(),
        identity_json,
        request_json,
    })
}

fn verify_encoded_batch(
    encoded: CanonicalEventBatch,
    input: &CanonicalBatchInput,
) -> Result<CanonicalEventBatch, BatchError> {
    let request = reparse_and_verify_request(&encoded.request_json)?;
    if request.gateway_route_id != input.gateway_route_id
        || request.tenant_id != input.tenant_id
        || request.archived_at != input.archived_at
        || request.producer_version != input.producer_version
        || request.source_checkpoint != input.source_checkpoint
        || request.events != encoded.events
    {
        return Err(BatchError::new(BATCH_INVALID_REQUEST));
    }
    let canonical_jsonl = canonical_lines(&request.events)?;
    let canonical_sha256 = canonical::sha256_hex(&canonical_jsonl);
    let request_input = request_input(&request);
    let identity_json = canonical::batch_identity_json(&request_input, &canonical_sha256)
        .map_err(|_| BatchError::new(BATCH_INVALID_REQUEST))?;
    let batch_id = format!("batch_{}", canonical::sha256_hex(&identity_json));
    if canonical_jsonl != encoded.canonical_jsonl
        || canonical_sha256 != encoded.canonical_sha256
        || identity_json != encoded.identity_json
        || batch_id != encoded.batch_id
        || encoded.request_json.is_empty()
    {
        return Err(BatchError::new(BATCH_INVALID_REQUEST));
    }
    let uncompressed_bytes = canonical_jsonl.len();
    Ok(CanonicalEventBatch {
        request,
        events: encoded.events,
        canonical_jsonl,
        uncompressed_bytes,
        canonical_sha256,
        batch_id,
        identity_json,
        request_json: encoded.request_json,
    })
}

fn request_input(request: &CanonicalBatchRequest) -> CanonicalBatchInput {
    CanonicalBatchInput {
        gateway_route_id: request.gateway_route_id.clone(),
        tenant_id: request.tenant_id.clone(),
        archived_at: request.archived_at.clone(),
        producer_version: request.producer_version.clone(),
        source_checkpoint: request.source_checkpoint.clone(),
        events: request.events.clone(),
    }
}

fn validate_batch_input(input: &CanonicalBatchInput) -> Result<(), BatchError> {
    if input.events.is_empty()
        || input.events.len() > MAX_BATCH_EVENTS
        || !model::valid_resource_id(&input.gateway_route_id)
        || !model::valid_resource_id(&input.tenant_id)
        || !model::valid_timestamp(&input.archived_at)
        || !valid_producer_version(&input.producer_version)
    {
        return Err(BatchError::new(BATCH_INVALID_REQUEST));
    }
    validate_source_checkpoint(&input.source_checkpoint)?;
    let mut event_ids = std::collections::HashSet::with_capacity(input.events.len());
    for event in &input.events {
        event
            .validate()
            .map_err(|_| BatchError::new(BATCH_INVALID_REQUEST))?;
        if event.tenant_id != input.tenant_id || !event_ids.insert(&event.event_id) {
            return Err(BatchError::new(BATCH_INVALID_REQUEST));
        }
    }
    Ok(())
}

fn validate_request_metadata(request: &CanonicalBatchRequest) -> Result<(), BatchError> {
    if request.schema_version != CANONICAL_SCHEMA_VERSION
        || !model::valid_resource_id(&request.gateway_route_id)
        || !model::valid_resource_id(&request.tenant_id)
        || !model::valid_timestamp(&request.archived_at)
        || !valid_producer_version(&request.producer_version)
    {
        return Err(BatchError::new(BATCH_INVALID_REQUEST));
    }
    validate_source_checkpoint(&request.source_checkpoint)
}

fn valid_producer_version(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value.trim() == value
        && value.bytes().all(|byte| (0x20..=0x7e).contains(&byte))
}

fn canonical_lines(events: &[CanonicalEvent]) -> Result<Vec<u8>, BatchError> {
    let mut result = Vec::new();
    for event in events {
        let line =
            canonical::canonical_event_json_line_bytes(event).map_err(map_canonical_error)?;
        let event_bytes = line
            .len()
            .checked_sub(1)
            .ok_or_else(|| BatchError::new(BATCH_INVALID_REQUEST))?;
        if event_bytes > MAX_EVENT_CANONICAL_BYTES {
            return Err(BatchError::new(BATCH_ENCODING_FAILED));
        }
        let next_len = result
            .len()
            .checked_add(line.len())
            .ok_or_else(|| BatchError::new(BATCH_ENCODING_FAILED))?;
        if next_len > MAX_BATCH_CANONICAL_BYTES {
            return Err(BatchError::new(BATCH_ENCODING_FAILED));
        }
        result.extend_from_slice(&line);
    }
    Ok(result)
}

fn map_canonical_error(error: CanonicalError) -> BatchError {
    if error.code() == "canonical_too_large" {
        BatchError::new(BATCH_ENCODING_FAILED)
    } else {
        BatchError::new(BATCH_INVALID_REQUEST)
    }
}

fn validate_source_checkpoint(checkpoint: &SourceCheckpoint) -> Result<(), BatchError> {
    if !matches!(
        checkpoint.kind.as_str(),
        "matrix_sync_token_sha256" | "matrix_backfill_run_sha256"
    ) || !valid_sha256_value(&checkpoint.value)
    {
        return Err(BatchError::new(BATCH_INVALID_SOURCE));
    }
    Ok(())
}

fn valid_sha256_value(value: &str) -> bool {
    value.len() == "sha256:".len() + 64
        && value.starts_with("sha256:")
        && value["sha256:".len()..]
            .bytes()
            .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
}

fn source_checkpoint(
    source: &WindowSource,
    batch_ordinal: u64,
) -> Result<SourceCheckpoint, BatchError> {
    match source {
        WindowSource::Live { next_batch } => {
            if next_batch.is_empty() || next_batch.len() > MAX_SYNC_TOKEN_BYTES {
                return Err(BatchError::new(BATCH_INVALID_SOURCE));
            }
            Ok(SourceCheckpoint {
                kind: "matrix_sync_token_sha256".to_owned(),
                value: format!("sha256:{}", canonical::sha256_hex(next_batch)),
            })
        }
        WindowSource::Backfill(checkpoint) => {
            let batch_ordinal = checkpoint
                .batch_ordinal
                .checked_add(batch_ordinal)
                .ok_or_else(|| BatchError::new(BATCH_INVALID_SOURCE))?;
            let max_events = checkpoint.max_events.to_string();
            let batch_ordinal = batch_ordinal.to_string();
            let digest = model::framed_hash_id(
                "matrix-backfill-checkpoint-v1",
                &[
                    &checkpoint.job_id,
                    &checkpoint.room_id,
                    &checkpoint.start_at,
                    &checkpoint.end_at,
                    &max_events,
                    &batch_ordinal,
                ],
            )
            .map_err(|_| BatchError::new(BATCH_INVALID_SOURCE))?;
            Ok(SourceCheckpoint {
                kind: "matrix_backfill_run_sha256".to_owned(),
                value: format!("sha256:{digest}"),
            })
        }
    }
}

fn canonical_timestamp(value: &str) -> Result<String, BatchError> {
    let parsed = DateTime::parse_from_rfc3339(value)
        .map_err(|_| BatchError::new(BATCH_INVALID_SOURCE))?
        .with_timezone(&Utc);
    let normalized = parsed.to_rfc3339_opts(SecondsFormat::Millis, true);
    if model::valid_timestamp(&normalized) {
        Ok(normalized)
    } else {
        Err(BatchError::new(BATCH_INVALID_SOURCE))
    }
}

fn validate_backfill_job(job: &BackfillJob) -> Result<(), BatchError> {
    if !(model::valid_resource_id(&job.job_id) || valid_uuid_v7(&job.job_id))
        || !model::valid_matrix_room_id(&job.room_id)
        || job.max_events == 0
        || job.max_events > MAX_BACKFILL_EVENTS
    {
        return Err(BatchError::new(BATCH_INVALID_SOURCE));
    }
    let start = parse_utc(&job.start_at)?;
    let end = parse_utc(&job.end_at)?;
    if end < start || end.signed_duration_since(start) > Duration::days(MAX_BACKFILL_INTERVAL_DAYS)
    {
        return Err(BatchError::new(BATCH_INVALID_SOURCE));
    }
    Ok(())
}

fn validate_backfill_checkpoint(checkpoint: &BackfillCheckpoint) -> Result<(), BatchError> {
    validate_backfill_job(&BackfillJob {
        job_id: checkpoint.job_id.clone(),
        room_id: checkpoint.room_id.clone(),
        start_at: checkpoint.start_at.clone(),
        end_at: checkpoint.end_at.clone(),
        max_events: checkpoint.max_events,
    })
}

fn parse_utc(value: &str) -> Result<DateTime<Utc>, BatchError> {
    DateTime::parse_from_rfc3339(value)
        .map(|value| value.with_timezone(&Utc))
        .map_err(|_| BatchError::new(BATCH_INVALID_SOURCE))
}

fn valid_uuid_v7(value: &str) -> bool {
    let bytes = value.as_bytes();
    if bytes.len() != 36
        || ![8_usize, 13, 18, 23]
            .into_iter()
            .all(|index| bytes[index] == b'-')
        || bytes
            .iter()
            .enumerate()
            .any(|(index, byte)| [8_usize, 13, 18, 23].contains(&index) && *byte != b'-')
        || bytes.iter().enumerate().any(|(index, byte)| {
            ![8_usize, 13, 18, 23].contains(&index) && !matches!(*byte, b'0'..=b'9' | b'a'..=b'f')
        })
    {
        return false;
    }
    bytes[14] == b'7' && matches!(bytes[19], b'8'..=b'9' | b'a'..=b'b')
}
