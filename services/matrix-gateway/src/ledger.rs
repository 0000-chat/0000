//! Closed, validated values shared by the Matrix gateway store ledgers.
//!
//! The store owns the transitions represented by these values.  This module
//! only defines the narrow data boundary: identifiers and timestamps are
//! checked before they enter the ledger, while protected bytes remain inside
//! [`SecretBytes`] and never appear in formatting output.

use std::fmt;

use chrono::{DateTime, Utc};

use crate::{
    batch,
    config::MAX_BATCH_CANONICAL_BYTES,
    ingestion, model,
    secret::{SafeError, SecretBytes},
    store_types::MAX_ROOM_ANCHOR_BYTES,
};

/// Maximum number of batches in one live or backfill window page.
pub const MAX_WINDOW_BATCHES: usize = 10_000;
/// Maximum number of room candidates staged for one live window.
pub const MAX_WINDOW_ROOM_CANDIDATES: usize = 100_000;
/// Maximum number of batches in one backfill page.
pub const MAX_BACKFILL_PAGE_BATCHES: usize = 10_000;
/// Maximum protected operator-parameter bytes for one backfill job.
pub const MAX_BACKFILL_PARAMETERS_BYTES: usize = 64 * 1024;
/// Maximum protected pagination bytes for one backfill checkpoint.
pub const MAX_BACKFILL_PAGINATION_BYTES: usize = 64 * 1024;
/// Maximum UTF-8 bytes retained for a ledger identifier.
pub const MAX_LEDGER_ID_BYTES: usize = 160;

/// Stable error returned when a live-ledger value is malformed.
pub const STORE_LEDGER_INVALID: &str = "store_ledger_invalid";
/// Stable error returned when a live-ledger value exceeds a frozen bound.
pub const STORE_LEDGER_TOO_LARGE: &str = "store_ledger_too_large";
/// Stable error returned for an immutable live-ledger conflict.
pub const STORE_LEDGER_CONFLICT: &str = "store_ledger_conflict";
/// Stable error returned when a live-ledger transition is not ready.
pub const STORE_LEDGER_NOT_READY: &str = "store_ledger_not_ready";
/// Stable error returned when a live-ledger compare-and-swap does not match.
pub const STORE_LEDGER_CAS_MISMATCH: &str = "store_ledger_cas_mismatch";
/// Stable error returned when protected live-ledger state is corrupt.
pub const STORE_LEDGER_CORRUPT: &str = "store_ledger_corrupt";

/// Stable error returned when a backfill value is malformed.
pub const STORE_BACKFILL_INVALID: &str = "store_backfill_invalid";
/// Stable error returned for an immutable backfill conflict.
pub const STORE_BACKFILL_CONFLICT: &str = "store_backfill_conflict";
/// Stable error returned when a backfill transition is not ready.
pub const STORE_BACKFILL_NOT_READY: &str = "store_backfill_not_ready";
/// Stable error returned when protected backfill state is corrupt.
pub const STORE_BACKFILL_CORRUPT: &str = "store_backfill_corrupt";

/// One newly created collecting live window.
#[derive(Clone, Eq, PartialEq)]
pub struct NewLiveWindow {
    window_id: String,
    created_at: DateTime<Utc>,
    ignored_count: u64,
}

impl NewLiveWindow {
    /// Construct a validated collecting-window description.
    pub fn new(
        window_id: impl Into<String>,
        created_at: DateTime<Utc>,
        ignored_count: u64,
    ) -> Result<Self, SafeError> {
        let value = Self {
            window_id: window_id.into(),
            created_at,
            ignored_count,
        };
        value.validate()?;
        Ok(value)
    }

    /// Revalidate the caller-owned window description.
    pub(crate) fn validate(&self) -> Result<(), SafeError> {
        if !valid_digest_id(&self.window_id, "window_")
            || !valid_utc_millisecond(self.created_at)
            || !fits_sqlite_integer(self.ignored_count)
        {
            return Err(ledger_invalid());
        }
        Ok(())
    }

    /// Borrow the deterministic live-window identifier.
    pub fn window_id(&self) -> &str {
        &self.window_id
    }

    /// Borrow the UTC creation timestamp.
    pub fn created_at(&self) -> &DateTime<Utc> {
        &self.created_at
    }

    /// Return the count of ignored input events.
    pub const fn ignored_count(&self) -> u64 {
        self.ignored_count
    }
}

impl fmt::Debug for NewLiveWindow {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("NewLiveWindow")
            .field("ignored_count", &self.ignored_count)
            .finish()
    }
}

/// One encrypted room-anchor candidate staged for a live window.
pub struct RoomAnchorCandidate {
    room_lookup: Vec<u8>,
    anchor_event: SecretBytes,
}

impl RoomAnchorCandidate {
    /// Construct a candidate after validating its fixed lookup and bytes.
    pub fn new(room_lookup: impl Into<Vec<u8>>, anchor_event: Vec<u8>) -> Result<Self, SafeError> {
        let value = Self {
            room_lookup: room_lookup.into(),
            anchor_event: SecretBytes::new(anchor_event),
        };
        value.validate()?;
        Ok(value)
    }

    /// Revalidate the candidate before it is persisted.
    pub(crate) fn validate(&self) -> Result<(), SafeError> {
        if self.room_lookup.len() != 32 {
            return Err(ledger_invalid());
        }
        validate_ledger_secret(&self.anchor_event, MAX_ROOM_ANCHOR_BYTES)
    }

    /// Borrow the fixed-size keyed room lookup bytes.
    pub fn room_lookup(&self) -> &[u8] {
        &self.room_lookup
    }

    /// Borrow the protected anchor event wrapper.
    pub fn anchor_event(&self) -> &SecretBytes {
        &self.anchor_event
    }
}

impl fmt::Debug for RoomAnchorCandidate {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("RoomAnchorCandidate([REDACTED])")
    }
}

/// One encrypted typing-state candidate staged for a live window.
pub struct RoomEphemeralCandidate {
    room_lookup: Vec<u8>,
    typing_set: SecretBytes,
    typing_expires_at: DateTime<Utc>,
}

impl RoomEphemeralCandidate {
    /// Construct a candidate after validating its lookup, bytes, and expiry.
    pub fn new(
        room_lookup: impl Into<Vec<u8>>,
        typing_set: Vec<u8>,
        typing_expires_at: DateTime<Utc>,
    ) -> Result<Self, SafeError> {
        let value = Self {
            room_lookup: room_lookup.into(),
            typing_set: SecretBytes::new(typing_set),
            typing_expires_at,
        };
        value.validate()?;
        Ok(value)
    }

    /// Revalidate the candidate before it is persisted.
    pub(crate) fn validate(&self) -> Result<(), SafeError> {
        if self.room_lookup.len() != 32 || !valid_utc_millisecond(self.typing_expires_at) {
            return Err(ledger_invalid());
        }
        validate_ledger_secret(&self.typing_set, MAX_ROOM_ANCHOR_BYTES)
    }

    /// Borrow the fixed-size keyed room lookup bytes.
    pub fn room_lookup(&self) -> &[u8] {
        &self.room_lookup
    }

    /// Borrow the protected typing-set wrapper.
    pub fn typing_set(&self) -> &SecretBytes {
        &self.typing_set
    }

    /// Borrow the UTC typing expiry timestamp.
    pub fn typing_expires_at(&self) -> &DateTime<Utc> {
        &self.typing_expires_at
    }
}

impl fmt::Debug for RoomEphemeralCandidate {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("RoomEphemeralCandidate([REDACTED])")
    }
}

/// One immutable ingestion request selected from the protected outbox.
pub struct PendingIngestionBatch {
    row_id: String,
    batch: ingestion::PendingBatch,
    attempt_count: u32,
    next_attempt_at: DateTime<Utc>,
}

impl PendingIngestionBatch {
    /// Construct and validate one pending ingestion row.
    pub fn new(
        row_id: impl Into<String>,
        batch: ingestion::PendingBatch,
        attempt_count: u32,
        next_attempt_at: DateTime<Utc>,
    ) -> Result<Self, SafeError> {
        let value = Self {
            row_id: row_id.into(),
            batch,
            attempt_count,
            next_attempt_at,
        };
        value.validate()?;
        Ok(value)
    }

    /// Construct a row after the store has authenticated its protected bytes.
    #[allow(dead_code)]
    pub(crate) fn from_verified_parts(
        row_id: String,
        batch: ingestion::PendingBatch,
        attempt_count: u32,
        next_attempt_at: DateTime<Utc>,
    ) -> Result<Self, SafeError> {
        Self::new(row_id, batch, attempt_count, next_attempt_at)
    }

    /// Revalidate all immutable request metadata.
    pub(crate) fn validate(&self) -> Result<(), SafeError> {
        if !valid_digest_id(&self.row_id, "batch_")
            || self.row_id != self.batch.batch_id()
            || !model::valid_resource_id(self.batch.tenant_id())
            || self.batch.exact_request_bytes().is_empty()
            || !valid_utc_millisecond(self.next_attempt_at)
        {
            return Err(ledger_invalid());
        }
        if self.batch.exact_request_bytes().len() > MAX_BATCH_CANONICAL_BYTES {
            return Err(ledger_too_large());
        }
        Ok(())
    }

    /// Borrow the synthetic outbox row identifier.
    pub fn row_id(&self) -> &str {
        &self.row_id
    }

    /// Borrow the immutable exact-byte ingestion request.
    pub fn batch(&self) -> &ingestion::PendingBatch {
        &self.batch
    }

    /// Return the number of delivery attempts already recorded.
    pub const fn attempt_count(&self) -> u32 {
        self.attempt_count
    }

    /// Borrow the next UTC attempt timestamp.
    pub fn next_attempt_at(&self) -> &DateTime<Utc> {
        &self.next_attempt_at
    }
}

impl fmt::Debug for PendingIngestionBatch {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("PendingIngestionBatch([REDACTED])")
    }
}

/// Result of preparing a live window's immutable outbox rows.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum FinalizeOutcome {
    /// The rows were inserted for the first time.
    Prepared { batch_count: u32 },
    /// The same immutable rows were already prepared.
    AlreadyPrepared { batch_count: u32 },
}

/// Result of accepting one live outbox row.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum LiveCommitOutcome {
    /// The row was accepted while sibling rows remain.
    BatchAccepted {
        accepted_count: u32,
        batch_count: u32,
    },
    /// The final row advanced the live window and checkpoint.
    WindowCommitted,
    /// The requested row belongs to an already committed window.
    AlreadyCommitted,
}

/// Result of accepting one explicit-backfill outbox row.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum BackfillCommitOutcome {
    /// The row was accepted while sibling rows or pages remain.
    BatchAccepted { accepted_events: u64 },
    /// The final row completed the explicit backfill job.
    JobCompleted { accepted_events: u64 },
    /// The requested row belongs to an already completed job.
    AlreadyCompleted { accepted_events: u64 },
}

/// One newly created explicit backfill job.
pub struct NewBackfillJob {
    job: batch::BackfillJob,
    parameters: SecretBytes,
    created_at: DateTime<Utc>,
}

impl NewBackfillJob {
    /// Construct and validate one explicit backfill job.
    pub fn new(
        job: batch::BackfillJob,
        parameters: Vec<u8>,
        created_at: DateTime<Utc>,
    ) -> Result<Self, SafeError> {
        let value = Self {
            job,
            parameters: SecretBytes::new(parameters),
            created_at,
        };
        value.validate()?;
        Ok(value)
    }

    /// Revalidate the job and its protected operator parameters.
    pub(crate) fn validate(&self) -> Result<(), SafeError> {
        if !valid_backfill_job(&self.job) || !valid_utc_millisecond(self.created_at) {
            return Err(backfill_invalid());
        }
        validate_backfill_secret(&self.parameters, MAX_BACKFILL_PARAMETERS_BYTES)
    }

    /// Borrow the immutable backfill job definition.
    pub fn job(&self) -> &batch::BackfillJob {
        &self.job
    }

    /// Borrow the protected operator parameters wrapper.
    pub fn parameters(&self) -> &SecretBytes {
        &self.parameters
    }

    /// Borrow the UTC creation timestamp.
    pub fn created_at(&self) -> &DateTime<Utc> {
        &self.created_at
    }
}

impl fmt::Debug for NewBackfillJob {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("NewBackfillJob([REDACTED])")
    }
}

/// One newly created live-gap job linked to a collecting live window.
pub struct NewLiveGapJob {
    job_id: String,
    live_window_id: String,
    parameters: SecretBytes,
    created_at: DateTime<Utc>,
}

impl NewLiveGapJob {
    /// Construct and validate one live-gap job.
    pub fn new(
        job_id: impl Into<String>,
        live_window_id: impl Into<String>,
        parameters: Vec<u8>,
        created_at: DateTime<Utc>,
    ) -> Result<Self, SafeError> {
        let value = Self {
            job_id: job_id.into(),
            live_window_id: live_window_id.into(),
            parameters: SecretBytes::new(parameters),
            created_at,
        };
        value.validate()?;
        Ok(value)
    }

    /// Revalidate the live-gap linkage and protected parameters.
    pub(crate) fn validate(&self) -> Result<(), SafeError> {
        if !valid_job_id(&self.job_id)
            || !valid_digest_id(&self.live_window_id, "window_")
            || !valid_utc_millisecond(self.created_at)
        {
            return Err(ledger_invalid());
        }
        validate_ledger_secret(&self.parameters, MAX_BACKFILL_PARAMETERS_BYTES)
    }

    /// Borrow the opaque live-gap job identifier.
    pub fn job_id(&self) -> &str {
        &self.job_id
    }

    /// Borrow the linked live-window identifier.
    pub fn live_window_id(&self) -> &str {
        &self.live_window_id
    }

    /// Borrow the protected gap parameters wrapper.
    pub fn parameters(&self) -> &SecretBytes {
        &self.parameters
    }

    /// Borrow the UTC creation timestamp.
    pub fn created_at(&self) -> &DateTime<Utc> {
        &self.created_at
    }
}

impl fmt::Debug for NewLiveGapJob {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("NewLiveGapJob([REDACTED])")
    }
}

/// SQLite lifecycle state of an explicit or live-gap backfill job.
#[derive(Clone, Copy, Eq, PartialEq)]
pub enum BackfillState {
    /// The job exists but has not been claimed by a worker.
    Pending,
    /// The job is owned by a worker and may receive pages.
    Running,
    /// The job reached an exhausted, fully accepted terminal state.
    Completed,
    /// The operator cancelled the job.
    Cancelled,
    /// The job stopped on a terminal failure.
    Quarantined,
}

impl BackfillState {
    /// Return the exact lowercase SQLite representation.
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::Running => "running",
            Self::Completed => "completed",
            Self::Cancelled => "cancelled",
            Self::Quarantined => "quarantined",
        }
    }

    /// Parse only the exact representations emitted by [`Self::as_str`].
    #[allow(dead_code)]
    pub(crate) fn from_str(value: &str) -> Result<Self, SafeError> {
        match value {
            "pending" => Ok(Self::Pending),
            "running" => Ok(Self::Running),
            "completed" => Ok(Self::Completed),
            "cancelled" => Ok(Self::Cancelled),
            "quarantined" => Ok(Self::Quarantined),
            _ => Err(backfill_invalid()),
        }
    }
}

impl fmt::Debug for BackfillState {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.as_str())
    }
}

impl fmt::Display for BackfillState {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.as_str())
    }
}

/// A verified explicit backfill job returned by the store.
pub struct StoredBackfillJob {
    job: batch::BackfillJob,
    state: BackfillState,
    parameters: SecretBytes,
    pagination: Option<SecretBytes>,
    accepted_events: u64,
}

impl StoredBackfillJob {
    /// Construct a validated stored backfill job from authenticated values.
    pub fn new(
        job: batch::BackfillJob,
        state: BackfillState,
        parameters: Vec<u8>,
        pagination: Option<Vec<u8>>,
        accepted_events: u64,
    ) -> Result<Self, SafeError> {
        let value = Self {
            job,
            state,
            parameters: SecretBytes::new(parameters),
            pagination: pagination.map(SecretBytes::new),
            accepted_events,
        };
        value.validate()?;
        Ok(value)
    }

    /// Construct a row after the store has authenticated its protected data.
    #[allow(dead_code)]
    pub(crate) fn from_verified_parts(
        job: batch::BackfillJob,
        state: BackfillState,
        parameters: Vec<u8>,
        pagination: Option<Vec<u8>>,
        accepted_events: u64,
    ) -> Result<Self, SafeError> {
        Self::new(job, state, parameters, pagination, accepted_events)
    }

    /// Revalidate all stored job fields and protected bounds.
    pub(crate) fn validate(&self) -> Result<(), SafeError> {
        if !valid_backfill_job(&self.job)
            || !fits_sqlite_integer(self.accepted_events)
            || self.accepted_events > self.job.max_events()
        {
            return Err(backfill_invalid());
        }
        validate_backfill_secret(&self.parameters, MAX_BACKFILL_PARAMETERS_BYTES)?;
        if let Some(pagination) = self.pagination.as_ref() {
            validate_backfill_secret(pagination, MAX_BACKFILL_PAGINATION_BYTES)?;
        }
        Ok(())
    }

    /// Borrow the immutable explicit backfill job definition.
    pub fn job(&self) -> &batch::BackfillJob {
        &self.job
    }

    /// Return the current SQLite job state.
    pub const fn state(&self) -> BackfillState {
        self.state
    }

    /// Borrow the protected operator parameters wrapper.
    pub fn parameters(&self) -> &SecretBytes {
        &self.parameters
    }

    /// Borrow the protected pagination wrapper, when a checkpoint exists.
    pub fn pagination(&self) -> Option<&SecretBytes> {
        self.pagination.as_ref()
    }

    /// Return the cumulative accepted source-event count.
    pub const fn accepted_events(&self) -> u64 {
        self.accepted_events
    }
}

impl fmt::Debug for StoredBackfillJob {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("StoredBackfillJob")
            .field("state", &self.state)
            .field("accepted_events", &self.accepted_events)
            .finish()
    }
}

/// A verified live-gap job returned by the store.
pub struct StoredLiveGapJob {
    job_id: String,
    live_window_id: String,
    state: BackfillState,
    parameters: SecretBytes,
    accepted_events: u64,
}

impl StoredLiveGapJob {
    /// Construct a validated stored live-gap job from authenticated values.
    pub fn new(
        job_id: impl Into<String>,
        live_window_id: impl Into<String>,
        state: BackfillState,
        parameters: Vec<u8>,
        accepted_events: u64,
    ) -> Result<Self, SafeError> {
        let value = Self {
            job_id: job_id.into(),
            live_window_id: live_window_id.into(),
            state,
            parameters: SecretBytes::new(parameters),
            accepted_events,
        };
        value.validate()?;
        Ok(value)
    }

    /// Construct a row after the store has authenticated its protected data.
    #[allow(dead_code)]
    pub(crate) fn from_verified_parts(
        job_id: String,
        live_window_id: String,
        state: BackfillState,
        parameters: Vec<u8>,
        accepted_events: u64,
    ) -> Result<Self, SafeError> {
        Self::new(job_id, live_window_id, state, parameters, accepted_events)
    }

    /// Revalidate the opaque linkage and protected bounds.
    pub(crate) fn validate(&self) -> Result<(), SafeError> {
        if !valid_job_id(&self.job_id)
            || !valid_digest_id(&self.live_window_id, "window_")
            || !fits_sqlite_integer(self.accepted_events)
            || self.accepted_events > batch::MAX_BACKFILL_EVENTS
        {
            return Err(ledger_invalid());
        }
        validate_ledger_secret(&self.parameters, MAX_BACKFILL_PARAMETERS_BYTES)
    }

    /// Borrow the opaque live-gap job identifier.
    pub fn job_id(&self) -> &str {
        &self.job_id
    }

    /// Borrow the linked live-window identifier.
    pub fn live_window_id(&self) -> &str {
        &self.live_window_id
    }

    /// Return the current SQLite job state.
    pub const fn state(&self) -> BackfillState {
        self.state
    }

    /// Borrow the protected gap parameters wrapper.
    pub fn parameters(&self) -> &SecretBytes {
        &self.parameters
    }

    /// Return the cumulative accepted source-event count.
    pub const fn accepted_events(&self) -> u64 {
        self.accepted_events
    }
}

impl fmt::Debug for StoredLiveGapJob {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("StoredLiveGapJob")
            .field("state", &self.state)
            .field("accepted_events", &self.accepted_events)
            .finish()
    }
}

/// Counts returned after a committed-prefix purge.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct PurgeOutcome {
    inbox_rows: u64,
    windows: u64,
    crypto_rows: u64,
    ingestion_rows: u64,
    live_gap_jobs: u64,
}

impl PurgeOutcome {
    /// Construct a count-only purge result.
    pub const fn new(
        inbox_rows: u64,
        windows: u64,
        crypto_rows: u64,
        ingestion_rows: u64,
        live_gap_jobs: u64,
    ) -> Self {
        Self {
            inbox_rows,
            windows,
            crypto_rows,
            ingestion_rows,
            live_gap_jobs,
        }
    }

    /// Return the number of purged inbox rows.
    pub const fn inbox_rows(&self) -> u64 {
        self.inbox_rows
    }

    /// Return the number of purged windows.
    pub const fn windows(&self) -> u64 {
        self.windows
    }

    /// Return the number of purged crypto rows.
    pub const fn crypto_rows(&self) -> u64 {
        self.crypto_rows
    }

    /// Return the number of purged ingestion rows.
    pub const fn ingestion_rows(&self) -> u64 {
        self.ingestion_rows
    }

    /// Return the number of purged live-gap jobs.
    pub const fn live_gap_jobs(&self) -> u64 {
        self.live_gap_jobs
    }
}

/// Bounded pressure information for the protected delivery ledger.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct LedgerPressure {
    pending_batches: u64,
    pending_bytes: u64,
    quarantined_windows: u64,
    oldest_pending_at: Option<DateTime<Utc>>,
}

impl LedgerPressure {
    /// Construct a pressure snapshot after validating its optional timestamp.
    pub fn new(
        pending_batches: u64,
        pending_bytes: u64,
        quarantined_windows: u64,
        oldest_pending_at: Option<DateTime<Utc>>,
    ) -> Result<Self, SafeError> {
        if oldest_pending_at.is_some_and(|value| !valid_utc_millisecond(value)) {
            return Err(ledger_invalid());
        }
        Ok(Self {
            pending_batches,
            pending_bytes,
            quarantined_windows,
            oldest_pending_at,
        })
    }

    /// Return the number of pending ingestion rows.
    pub const fn pending_batches(&self) -> u64 {
        self.pending_batches
    }

    /// Return the total exact request bytes pending delivery.
    pub const fn pending_bytes(&self) -> u64 {
        self.pending_bytes
    }

    /// Return the number of quarantined live windows.
    pub const fn quarantined_windows(&self) -> u64 {
        self.quarantined_windows
    }

    /// Borrow the oldest pending-row timestamp, when one exists.
    pub fn oldest_pending_at(&self) -> Option<&DateTime<Utc>> {
        self.oldest_pending_at.as_ref()
    }
}

fn valid_digest_id(value: &str, prefix: &str) -> bool {
    value.len() == prefix.len() + 64
        && value.len() <= MAX_LEDGER_ID_BYTES
        && value.starts_with(prefix)
        && value[prefix.len()..]
            .bytes()
            .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
}

fn valid_job_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= MAX_LEDGER_ID_BYTES
        && (model::valid_resource_id(value) || valid_uuid_v7(value))
}

fn valid_backfill_job(job: &batch::BackfillJob) -> bool {
    !job.job_id().is_empty()
        && job.job_id().len() <= MAX_LEDGER_ID_BYTES
        && model::valid_matrix_room_id(job.room_id())
        && model::valid_timestamp(job.start_at())
        && model::valid_timestamp(job.end_at())
        && (1..=batch::MAX_BACKFILL_EVENTS).contains(&job.max_events())
}

fn valid_uuid_v7(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() == 36
        && [8_usize, 13, 18, 23]
            .into_iter()
            .all(|index| bytes[index] == b'-')
        && bytes.iter().enumerate().all(|(index, byte)| {
            [8_usize, 13, 18, 23].contains(&index) || matches!(*byte, b'0'..=b'9' | b'a'..=b'f')
        })
        && bytes[14] == b'7'
        && matches!(bytes[19], b'8'..=b'9' | b'a'..=b'b')
}

fn valid_utc_millisecond(value: DateTime<Utc>) -> bool {
    value.timestamp_subsec_nanos().is_multiple_of(1_000_000)
        && model::valid_timestamp(&value.to_rfc3339())
}

fn fits_sqlite_integer(value: u64) -> bool {
    i64::try_from(value).is_ok()
}

fn validate_ledger_secret(value: &SecretBytes, max_bytes: usize) -> Result<(), SafeError> {
    if value.is_empty() {
        return Err(ledger_invalid());
    }
    if value.len() > max_bytes {
        return Err(ledger_too_large());
    }
    Ok(())
}

fn validate_backfill_secret(value: &SecretBytes, max_bytes: usize) -> Result<(), SafeError> {
    if value.is_empty() || value.len() > max_bytes {
        return Err(backfill_invalid());
    }
    Ok(())
}

const fn ledger_invalid() -> SafeError {
    SafeError::new(STORE_LEDGER_INVALID)
}

const fn ledger_too_large() -> SafeError {
    SafeError::new(STORE_LEDGER_TOO_LARGE)
}

const fn backfill_invalid() -> SafeError {
    SafeError::new(STORE_BACKFILL_INVALID)
}
