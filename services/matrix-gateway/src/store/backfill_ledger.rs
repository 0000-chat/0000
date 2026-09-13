//! Explicit backfill job creation and ownership transactions.

use std::{collections::HashSet, str};

use chrono::{DateTime, Utc};
use rusqlite::{Row, Transaction, TransactionBehavior, params, types::ValueRef};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use zeroize::Zeroizing;

use crate::{
    batch::{self, BackfillJob, BatchWindow, WindowSource},
    canonical::{self, CanonicalBatchInput, SourceCheckpoint},
    config::{MAX_BATCH_CANONICAL_BYTES, MAX_EVENT_CANONICAL_BYTES},
    crypto::{AEAD_TAG_BYTES, Sealed},
    ingestion::PendingBatch,
    ledger::{
        BackfillCommitOutcome, BackfillState, MAX_BACKFILL_PAGE_BATCHES,
        MAX_BACKFILL_PAGINATION_BYTES, MAX_BACKFILL_PARAMETERS_BYTES, MAX_LEDGER_ID_BYTES,
        NewBackfillJob, PendingIngestionBatch, STORE_BACKFILL_CONFLICT, STORE_BACKFILL_CORRUPT,
        STORE_BACKFILL_INVALID, STORE_BACKFILL_NOT_READY, STORE_LEDGER_CAS_MISMATCH,
        StoredBackfillJob,
    },
    model,
    secret::SafeError,
};

use super::{Store, lowercase_hex, parse_stored_timestamp, valid_utc_millisecond};

const BACKFILL_KIND_EXPLICIT: &str = "explicit";
const BACKFILL_KIND_LIVE_GAP: &str = "live_gap";
const BACKFILL_KIND_OUTBOX: &str = "backfill";
const BACKFILL_PARAMETERS_COLUMN: &str = "parameters";
const BACKFILL_PAGINATION_COLUMN: &str = "pagination";
const BACKFILL_NONCE_BYTES: usize = 24;
const BACKFILL_KIND_MAX_BYTES: usize = BACKFILL_KIND_LIVE_GAP.len();
const BACKFILL_STATE_MAX_BYTES: usize = "quarantined".len();
const BACKFILL_TIMESTAMP_MAX_BYTES: usize = 64;
const BACKFILL_TERMINAL_CODE_MAX_BYTES: usize = 64;
const BACKFILL_ROOM_ID_MAX_BYTES: usize = 4096;
const BACKFILL_JOB_ENVELOPE_MAGIC: &[u8] = b"communicator-backfill-job-v1\0";
// Version 1 has one protected parameters column and no separate job-definition
// columns. Keep the immutable job fields in the same authenticated envelope so
// resume can reconstruct them without adding schema or plaintext storage.
const BACKFILL_JOB_ENVELOPE_HEADER_BYTES: usize =
    BACKFILL_JOB_ENVELOPE_MAGIC.len() + (4 * 4) + 8 + 4;
const MAX_BACKFILL_JOB_ENVELOPE_BYTES: usize = MAX_BACKFILL_PARAMETERS_BYTES
    + BACKFILL_JOB_ENVELOPE_HEADER_BYTES
    + MAX_LEDGER_ID_BYTES
    + BACKFILL_ROOM_ID_MAX_BYTES
    + (2 * BACKFILL_TIMESTAMP_MAX_BYTES);
const BACKFILL_EXHAUSTED_SENTINEL: &[u8] = b"{\"schema_version\":1,\"state\":\"exhausted\"}";
const BACKFILL_TERMINAL_MARKER_PREFIX: &[u8] =
    b"{\"schema_version\":1,\"state\":\"exhausted\",\"page_start\":";
const BACKFILL_OUTBOX_SOURCE_KIND_MAX_BYTES: usize = "backfill".len();
const BACKFILL_OUTBOX_STATE_MAX_BYTES: usize = "quarantined".len();
const BACKFILL_OUTBOX_TIMESTAMP_MAX_BYTES: usize = 64;
const BACKFILL_OUTBOX_TERMINAL_CODE_MAX_BYTES: usize = 64;
const BACKFILL_OUTBOX_BATCH_ID_PREFIX: &str = "batch_";
const BACKFILL_OUTBOX_REQUEST_MAX_CIPHERTEXT_BYTES: usize =
    MAX_BATCH_CANONICAL_BYTES + AEAD_TAG_BYTES;
const BACKFILL_OUTBOX_ATTEMPT_COUNT_MAX: i64 = 1_000_000;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct TerminalPageMarkerFields {
    schema_version: u8,
    state: String,
    page_start: u64,
    page_length: u64,
    accepted_events: u64,
    page_requests_sha256: String,
}

#[derive(Clone, Copy, Eq, PartialEq)]
struct TerminalPageMarker {
    page_start: u64,
    page_length: u64,
    accepted_events: u64,
    page_requests_sha256: [u8; 32],
}

enum StoredPagination {
    None,
    Provider,
    LegacyExhausted,
    Terminal(TerminalPageMarker),
}

/// The authenticated history gateway's persisted cursor envelope. Keep this
/// shape local to the ledger so terminal detection cannot be triggered by an
/// arbitrary JSON field in provider pagination bytes.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct HistoryPaginationEnvelope {
    schema_version: u8,
    range_id: String,
    input_cursor: Option<String>,
    source_cursor: String,
    public_cursor: String,
    page_start: u64,
    page_length: u64,
    history_terminal: bool,
}

fn checked_backfill_checkpoint_recovery_bytes<I>(
    existing_request_ciphertext_bytes: u64,
    request_plaintext_lengths: I,
    pagination_plaintext_len: usize,
) -> Result<u64, SafeError>
where
    I: IntoIterator<Item = usize>,
{
    let mut total = super::checked_recovery_bytes(0, existing_request_ciphertext_bytes)
        .map_err(|_| backfill_too_large())?;
    for request_plaintext_len in request_plaintext_lengths {
        total = super::checked_protected_recovery_bytes(total, request_plaintext_len)
            .map_err(|_| backfill_too_large())?;
    }
    super::checked_protected_recovery_bytes(total, pagination_plaintext_len)
        .map_err(|_| backfill_too_large())
}

fn terminal_page_digest(window: &BatchWindow) -> Result<[u8; 32], SafeError> {
    let mut digest = Sha256::new();
    for batch in &window.batches {
        let request = batch.exact_request_bytes();
        let length = u64::try_from(request.len()).map_err(|_| backfill_invalid())?;
        digest.update(length.to_be_bytes());
        digest.update(request);
    }
    Ok(digest.finalize().into())
}

fn encode_terminal_page_marker(
    page_start: u64,
    page_length: u64,
    accepted_events: u64,
    page_requests_sha256: [u8; 32],
) -> Result<Vec<u8>, SafeError> {
    let page_end = page_start
        .checked_add(page_length)
        .ok_or_else(backfill_corrupt)?;
    if page_end > batch::MAX_BACKFILL_EVENTS
        || page_length > u64::try_from(MAX_BACKFILL_PAGE_BATCHES).unwrap_or(u64::MAX)
        || accepted_events > batch::MAX_BACKFILL_EVENTS
    {
        return Err(backfill_corrupt());
    }
    let marker = format!(
        "{{\"schema_version\":1,\"state\":\"exhausted\",\"page_start\":{page_start},\"page_length\":{page_length},\"accepted_events\":{accepted_events},\"page_requests_sha256\":\"{}\"}}",
        lowercase_hex(&page_requests_sha256)
    )
    .into_bytes();
    if marker.len() > MAX_BACKFILL_PAGINATION_BYTES {
        return Err(backfill_corrupt());
    }
    Ok(marker)
}

fn decode_hex_digest(value: &str) -> Result<[u8; 32], SafeError> {
    let bytes = value.as_bytes();
    if bytes.len() != 64 {
        return Err(backfill_corrupt());
    }
    let mut digest = [0_u8; 32];
    for (index, pair) in bytes.chunks_exact(2).enumerate() {
        let high = hex_digit(pair[0]).ok_or_else(backfill_corrupt)?;
        let low = hex_digit(pair[1]).ok_or_else(backfill_corrupt)?;
        digest[index] = (high << 4) | low;
    }
    Ok(digest)
}

fn hex_digit(value: u8) -> Option<u8> {
    match value {
        b'0'..=b'9' => Some(value - b'0'),
        b'a'..=b'f' => Some(value - b'a' + 10),
        _ => None,
    }
}

fn decode_terminal_page_marker(bytes: &[u8]) -> Result<TerminalPageMarker, SafeError> {
    let fields: TerminalPageMarkerFields =
        serde_json::from_slice(bytes).map_err(|_| backfill_corrupt())?;
    if fields.schema_version != 1 || fields.state != "exhausted" {
        return Err(backfill_corrupt());
    }
    let page_end = fields
        .page_start
        .checked_add(fields.page_length)
        .ok_or_else(backfill_corrupt)?;
    if page_end > batch::MAX_BACKFILL_EVENTS
        || fields.page_length > u64::try_from(MAX_BACKFILL_PAGE_BATCHES).unwrap_or(u64::MAX)
        || fields.accepted_events > batch::MAX_BACKFILL_EVENTS
    {
        return Err(backfill_corrupt());
    }
    let page_requests_sha256 = decode_hex_digest(&fields.page_requests_sha256)?;
    let marker = TerminalPageMarker {
        page_start: fields.page_start,
        page_length: fields.page_length,
        accepted_events: fields.accepted_events,
        page_requests_sha256,
    };
    if encode_terminal_page_marker(
        marker.page_start,
        marker.page_length,
        marker.accepted_events,
        marker.page_requests_sha256,
    )? != bytes
    {
        return Err(backfill_corrupt());
    }
    Ok(marker)
}

fn stored_pagination(value: Option<&[u8]>) -> Result<StoredPagination, SafeError> {
    match value {
        None => Ok(StoredPagination::None),
        Some(value) if value == BACKFILL_EXHAUSTED_SENTINEL => {
            Ok(StoredPagination::LegacyExhausted)
        }
        Some(value) if value.starts_with(BACKFILL_TERMINAL_MARKER_PREFIX) => Ok(
            StoredPagination::Terminal(decode_terminal_page_marker(value)?),
        ),
        Some(_) => Ok(StoredPagination::Provider),
    }
}

fn is_reserved_provider_pagination(value: &[u8]) -> bool {
    value == BACKFILL_EXHAUSTED_SENTINEL || value.starts_with(BACKFILL_TERMINAL_MARKER_PREFIX)
}

#[cfg(test)]
#[allow(clippy::items_after_test_module)]
mod tests {
    use super::*;
    use rusqlite::Connection;

    #[test]
    fn backfill_outbox_preflight_aggregates_actual_ciphertext_bytes() {
        let job = BackfillJob::new(
            "018f0f2c-5f5a-7abc-8def-abcdef012345",
            "!backfill:example.test",
            "2023-11-14T22:13:20.000Z",
            "2023-11-15T22:13:20.000Z",
            100,
        )
        .expect("construct backfill job");
        let connection = Connection::open_in_memory().expect("open in-memory database");
        connection
            .execute_batch(
                "CREATE TABLE outbox_batches(
                     backfill_job_id TEXT, request_cipher BLOB, byte_count INTEGER
                 );
                 INSERT INTO outbox_batches(backfill_job_id, request_cipher, byte_count)
                 VALUES ('018f0f2c-5f5a-7abc-8def-abcdef012345', zeroblob(20), 1);",
            )
            .expect("create backfill outbox fixture");

        assert_eq!(
            preflight_backfill_outbox_bytes(&connection, &job).expect("preflight backfill outbox"),
            (1, 20)
        );
    }

    #[test]
    fn backfill_checkpoint_projection_counts_existing_and_protected_new_bytes() {
        assert_eq!(
            checked_backfill_checkpoint_recovery_bytes(
                crate::config::MAX_RECOVERY_BYTES - 34,
                [1_usize],
                1,
            )
            .expect("exact recovery boundary"),
            crate::config::MAX_RECOVERY_BYTES
        );
        assert!(
            checked_backfill_checkpoint_recovery_bytes(
                crate::config::MAX_RECOVERY_BYTES - 33,
                [1_usize],
                1,
            )
            .is_err()
        );
    }
}

struct StoredBackfillRow {
    job_id: String,
    kind: String,
    live_window_id: Option<String>,
    state: String,
    parameters_cipher: Vec<u8>,
    parameters_nonce: Vec<u8>,
    pagination_cipher: Option<Vec<u8>>,
    pagination_nonce: Option<Vec<u8>>,
    key_version: i64,
    accepted_events: i64,
    created_at: String,
    completed_at: Option<String>,
    cancelled_at: Option<String>,
    terminal_code: Option<String>,
}

struct VerifiedBackfillRow {
    job: BackfillJob,
    state: BackfillState,
    parameters: Zeroizing<Vec<u8>>,
    pagination: Option<Zeroizing<Vec<u8>>>,
    accepted_events: u64,
    created_at: String,
}

struct StoredBackfillOutboxRow {
    batch_row_id: String,
    source_kind: String,
    window_id: Option<String>,
    backfill_job_id: Option<String>,
    ordinal: i64,
    state: String,
    request_cipher: Vec<u8>,
    request_nonce: Vec<u8>,
    request_key_version: i64,
    request_sha256: Vec<u8>,
    byte_count: i64,
    attempt_count: i64,
    next_attempt_at: String,
    accepted_at: Option<String>,
    terminal_code: Option<String>,
}

struct VerifiedBackfillOutboxRow {
    batch_row_id: String,
    ordinal: u64,
    request: Zeroizing<Vec<u8>>,
    request_sha256: [u8; 32],
    byte_count: usize,
    state: String,
    attempt_count: u32,
    next_attempt_at: DateTime<Utc>,
    next_attempt_at_text: String,
    accepted_at: Option<DateTime<Utc>>,
}

struct BackfillOutboxScan {
    count: u64,
    pending_count: u64,
    quarantined_count: u64,
    candidate: Option<VerifiedBackfillOutboxRow>,
}

impl Store {
    /// Create one immutable explicit backfill job in the pending state.
    pub fn create_backfill_job(&mut self, job: NewBackfillJob) -> Result<(), SafeError> {
        job.validate().map_err(|_| backfill_invalid())?;
        let job_id = job.job().job_id();
        validate_job_id(job_id)?;

        let encoded = encode_job_parameters(job.job(), job.parameters().as_bytes())?;
        let sealed = self
            .keyring
            .seal(
                "backfill_jobs",
                job_id,
                BACKFILL_PARAMETERS_COLUMN,
                encoded.as_slice(),
            )
            .map_err(|_| backfill_invalid())?;
        let created_at = job.created_at().to_rfc3339();
        let keyring = &self.keyring;
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| backfill_corrupt())?;

        let existing = load_backfill_row(&transaction, job_id)?;
        if let Some(existing) = existing {
            if existing.kind != BACKFILL_KIND_EXPLICIT {
                return Err(backfill_conflict());
            }
            let verified = verify_backfill_row(keyring, &existing)?;
            if verified.job == *job.job()
                && verified.parameters.as_slice() == job.parameters().as_bytes()
                && verified.created_at == created_at
            {
                return Ok(());
            }
            return Err(backfill_conflict());
        }

        transaction
            .execute(
                "INSERT INTO backfill_jobs
                 (job_id, kind, live_window_id, state,
                  parameters_cipher, parameters_nonce, pagination_cipher, pagination_nonce,
                  key_version, accepted_events, created_at,
                  completed_at, cancelled_at, terminal_code)
                 VALUES (?1, 'explicit', NULL, 'pending', ?2, ?3, NULL, NULL,
                         ?4, 0, ?5, NULL, NULL, NULL)",
                params![
                    job_id,
                    sealed.ciphertext.as_slice(),
                    sealed.nonce.as_slice(),
                    i64::from(sealed.key_version),
                    created_at,
                ],
            )
            .map_err(|_| backfill_corrupt())?;
        transaction.commit().map_err(|_| backfill_corrupt())?;
        Ok(())
    }

    /// Claim a pending explicit job or verify and return an already-running job.
    pub fn begin_or_resume_backfill_job(
        &mut self,
        job_id: &str,
    ) -> Result<StoredBackfillJob, SafeError> {
        validate_job_id(job_id)?;

        let keyring = &self.keyring;
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| backfill_corrupt())?;
        let Some(row) = load_backfill_row(&transaction, job_id)? else {
            return Err(backfill_not_ready());
        };
        match (row.kind.as_str(), row.live_window_id.as_deref()) {
            (BACKFILL_KIND_EXPLICIT, None) => {}
            (BACKFILL_KIND_LIVE_GAP, Some(_)) => return Err(backfill_not_ready()),
            _ => return Err(backfill_corrupt()),
        }

        let state = BackfillState::from_str(&row.state).map_err(|_| backfill_corrupt())?;
        let mut verified = verify_backfill_row(keyring, &row)?;
        let resulting_state = match state {
            BackfillState::Pending => {
                let updated = transaction
                    .execute(
                        "UPDATE backfill_jobs
                         SET state = 'running'
                         WHERE job_id = ?1 AND kind = 'explicit' AND state = 'pending'",
                        [job_id],
                    )
                    .map_err(|_| backfill_corrupt())?;
                if updated != 1 {
                    return Err(backfill_corrupt());
                }
                BackfillState::Running
            }
            BackfillState::Running => BackfillState::Running,
            BackfillState::Completed | BackfillState::Cancelled | BackfillState::Quarantined => {
                return Err(backfill_not_ready());
            }
        };

        let parameters = std::mem::take(&mut *verified.parameters);
        let pagination = verified
            .pagination
            .as_mut()
            .map(|value| std::mem::take(&mut **value));
        let stored = StoredBackfillJob::from_verified_parts(
            verified.job,
            resulting_state,
            parameters,
            pagination,
            verified.accepted_events,
        )
        .map_err(|_| backfill_corrupt())?;
        transaction.commit().map_err(|_| backfill_corrupt())?;
        Ok(stored)
    }

    /// Return the authenticated number of durable batches already checkpointed
    /// for one explicit history job. The count is the next backfill checkpoint
    /// ordinal and lets a resumed history page reuse the existing seek model.
    pub fn backfill_batch_count(&mut self, job_id: &str) -> Result<u64, SafeError> {
        validate_job_id(job_id)?;
        let keyring = &self.keyring;
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| backfill_corrupt())?;
        let row = load_backfill_row(&transaction, job_id)?.ok_or_else(backfill_not_ready)?;
        validate_explicit_job_shape(&row)?;
        let verified = verify_backfill_row(keyring, &row)?;
        let count = load_backfill_outbox_rows(&transaction, keyring, &verified.job)?;
        transaction.commit().map_err(|_| backfill_corrupt())?;
        Ok(count)
    }

    /// Load one authenticated explicit history job without changing its
    /// lifecycle state. History response replay uses this after a terminal
    /// page has already completed the durable ledger transition.
    pub fn load_backfill_job_for_history(
        &mut self,
        job_id: &str,
    ) -> Result<StoredBackfillJob, SafeError> {
        validate_job_id(job_id)?;
        let keyring = &self.keyring;
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| backfill_corrupt())?;
        let row = load_backfill_row(&transaction, job_id)?.ok_or_else(backfill_not_ready)?;
        validate_explicit_job_shape(&row)?;
        let mut verified = verify_backfill_row(keyring, &row)?;
        let parameters = std::mem::take(&mut *verified.parameters);
        let pagination = verified
            .pagination
            .as_mut()
            .map(|value| std::mem::take(&mut **value));
        let stored = StoredBackfillJob::from_verified_parts(
            verified.job,
            verified.state,
            parameters,
            pagination,
            verified.accepted_events,
        )
        .map_err(|_| backfill_corrupt())?;
        transaction.commit().map_err(|_| backfill_corrupt())?;
        Ok(stored)
    }

    /// Re-read one already checkpointed page from the authenticated encrypted
    /// outbox. This is used by a retried history request after the first
    /// response was lost, so the gateway can replay the exact canonical events
    /// without fetching Matrix again.
    pub fn backfill_page_events(
        &mut self,
        job_id: &str,
        page_start: u64,
        page_length: u64,
    ) -> Result<Vec<crate::model::CanonicalEvent>, SafeError> {
        validate_job_id(job_id)?;
        let page_end = page_start
            .checked_add(page_length)
            .ok_or_else(backfill_invalid)?;
        let keyring = &self.keyring;
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| backfill_corrupt())?;
        let row = load_backfill_row(&transaction, job_id)?.ok_or_else(backfill_not_ready)?;
        validate_explicit_job_shape(&row)?;
        let verified = verify_backfill_row(keyring, &row)?;
        let count = load_backfill_outbox_rows(&transaction, keyring, &verified.job)?;
        if page_end > count {
            return Err(backfill_not_ready());
        }
        let page_start_sql = i64::try_from(page_start).map_err(|_| backfill_invalid())?;
        let page_end_sql = i64::try_from(page_end).map_err(|_| backfill_invalid())?;
        let limit = page_length
            .checked_add(1)
            .and_then(|value| i64::try_from(value).ok())
            .ok_or_else(backfill_invalid)?;
        let mut statement = transaction
            .prepare(
                "SELECT batch_row_id, source_kind, window_id, backfill_job_id,
                        ordinal, state, request_cipher, request_nonce, request_key_version,
                        request_sha256, byte_count, attempt_count, next_attempt_at,
                        accepted_at, terminal_code
                 FROM outbox_batches
                 WHERE backfill_job_id = ?1 AND ordinal >= ?2 AND ordinal < ?3
                 ORDER BY ordinal ASC LIMIT ?4",
            )
            .map_err(|_| backfill_corrupt())?;
        let mut rows = statement
            .query(params![job_id, page_start_sql, page_end_sql, limit])
            .map_err(|_| backfill_corrupt())?;
        let mut output = Vec::new();
        let mut offset = 0_u64;
        while let Some(row) = rows.next().map_err(|_| backfill_corrupt())? {
            if offset >= page_length {
                return Err(backfill_corrupt());
            }
            let stored =
                verify_backfill_outbox_row(keyring, &verified.job, read_backfill_outbox_row(row)?)?;
            let expected_ordinal = page_start
                .checked_add(offset)
                .ok_or_else(backfill_corrupt)?;
            if stored.ordinal != expected_ordinal {
                return Err(backfill_corrupt());
            }
            let request = batch::reparse_and_verify_request(stored.request.as_slice())
                .map_err(|_| backfill_corrupt())?;
            output.extend(request.events);
            offset = offset.checked_add(1).ok_or_else(backfill_corrupt)?;
        }
        if offset != page_length {
            return Err(backfill_corrupt());
        }
        drop(rows);
        drop(statement);
        transaction.commit().map_err(|_| backfill_corrupt())?;
        Ok(output)
    }

    /// Persist one exact page for a running explicit backfill job.
    pub fn checkpoint_backfill_page(
        &mut self,
        job_id: &str,
        pagination: Option<&crate::secret::SecretBytes>,
        window: &BatchWindow,
        accepted_events: u64,
    ) -> Result<(), SafeError> {
        validate_checkpoint_input(job_id, pagination, window, accepted_events)?;
        let accepted_events_sql = i64::try_from(accepted_events).map_err(|_| backfill_invalid())?;

        let keyring = &self.keyring;
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| backfill_corrupt())?;
        let Some(row) = load_backfill_row(&transaction, job_id)? else {
            return Err(backfill_not_ready());
        };
        match (row.kind.as_str(), row.live_window_id.as_deref()) {
            (BACKFILL_KIND_EXPLICIT, None) => {}
            (BACKFILL_KIND_LIVE_GAP, Some(_)) => return Err(backfill_not_ready()),
            _ => return Err(backfill_corrupt()),
        }
        let state = BackfillState::from_str(&row.state).map_err(|_| backfill_corrupt())?;
        let verified = verify_backfill_row(keyring, &row)?;
        if state != BackfillState::Running {
            return Err(backfill_not_ready());
        }
        if accepted_events < verified.accepted_events || accepted_events > verified.job.max_events()
        {
            return Err(backfill_invalid());
        }

        let (existing_count, existing_request_ciphertext_bytes) =
            preflight_backfill_outbox_bytes(&transaction, &verified.job)?;
        if existing_count != 0 && verified.pagination.is_none() {
            return Err(backfill_corrupt());
        }

        let page_start = find_page_start(&verified.job, &window.source_checkpoint, existing_count)?;
        validate_page_sources(&verified.job, window, page_start)?;
        let page_length = u64::try_from(window.batches.len()).map_err(|_| backfill_corrupt())?;
        let page_end = page_start
            .checked_add(page_length)
            .ok_or_else(backfill_invalid)?;
        if page_end > verified.job.max_events() {
            return Err(backfill_invalid());
        }

        if page_start > existing_count {
            return Err(backfill_invalid());
        }

        let page_requests_sha256 = terminal_page_digest(window)?;
        let existing_pagination =
            stored_pagination(verified.pagination.as_deref().map(|value| &**value))?;
        let generated_pagination;
        let pagination_bytes = match (&existing_pagination, pagination) {
            (StoredPagination::LegacyExhausted, _) => return Err(backfill_conflict()),
            (StoredPagination::Terminal(marker), None) => {
                let marker_end = marker
                    .page_start
                    .checked_add(marker.page_length)
                    .ok_or_else(backfill_corrupt)?;
                if marker_end != existing_count {
                    return Err(backfill_corrupt());
                }
                if marker.page_start != page_start
                    || marker.page_length != page_length
                    || marker.accepted_events != accepted_events
                    || marker.page_requests_sha256 != page_requests_sha256
                {
                    return Err(backfill_conflict());
                }
                generated_pagination = encode_terminal_page_marker(
                    page_start,
                    page_length,
                    accepted_events,
                    page_requests_sha256,
                )?;
                generated_pagination.as_slice()
            }
            (StoredPagination::Terminal(_), Some(_)) => return Err(backfill_conflict()),
            (_, Some(value)) => value.as_bytes(),
            (_, None) => {
                generated_pagination = encode_terminal_page_marker(
                    page_start,
                    page_length,
                    accepted_events,
                    page_requests_sha256,
                )?;
                generated_pagination.as_slice()
            }
        };
        let new_request_plaintext_lengths = window
            .batches
            .iter()
            .filter(|_| page_start == existing_count)
            .map(|batch| batch.exact_request_bytes().len());
        checked_backfill_checkpoint_recovery_bytes(
            existing_request_ciphertext_bytes,
            new_request_plaintext_lengths,
            pagination_bytes.len(),
        )?;

        let validated_existing_count =
            load_backfill_outbox_rows(&transaction, keyring, &verified.job)?;
        if validated_existing_count != existing_count {
            return Err(backfill_corrupt());
        }
        if page_start < existing_count {
            if page_end > existing_count {
                return Err(backfill_conflict());
            }
            validate_existing_page(
                &transaction,
                keyring,
                &verified.job,
                page_start,
                page_end,
                window,
            )?;
            if verified.accepted_events != accepted_events
                || verified
                    .pagination
                    .as_ref()
                    .is_none_or(|value| value.as_slice() != pagination_bytes)
            {
                return Err(backfill_conflict());
            }
            persist_backfill_checkpoint(
                &transaction,
                keyring,
                &row,
                &verified,
                pagination_bytes,
                accepted_events_sql,
            )?;
            transaction.commit().map_err(|_| backfill_corrupt())?;
            return Ok(());
        } else if page_length == 0
            && verified.accepted_events == accepted_events
            && verified
                .pagination
                .as_ref()
                .is_some_and(|value| value.as_slice() == pagination_bytes)
        {
            persist_backfill_checkpoint(
                &transaction,
                keyring,
                &row,
                &verified,
                pagination_bytes,
                accepted_events_sql,
            )?;
            transaction.commit().map_err(|_| backfill_corrupt())?;
            return Ok(());
        }

        let mut sealed_requests = Vec::with_capacity(window.batches.len());
        for (offset, batch) in window.batches.iter().enumerate() {
            let ordinal = page_start
                .checked_add(u64::try_from(offset).map_err(|_| backfill_corrupt())?)
                .ok_or_else(backfill_corrupt)?;
            let collision: i64 = transaction
                .query_row(
                    "SELECT COUNT(*) FROM outbox_batches WHERE batch_row_id = ?1",
                    [batch.batch_id.as_str()],
                    |value| value.get(0),
                )
                .map_err(|_| backfill_corrupt())?;
            if collision != 0 {
                return Err(backfill_conflict());
            }
            let request = batch.exact_request_bytes();
            let sealed = keyring
                .seal(
                    "outbox_batches",
                    batch.batch_id.as_str(),
                    "request",
                    request,
                )
                .map_err(|_| backfill_invalid())?;
            let request_sha256: [u8; 32] = Sha256::digest(request).into();
            sealed_requests.push((
                batch.batch_id.as_str(),
                i64::try_from(ordinal).map_err(|_| backfill_invalid())?,
                sealed,
                request_sha256,
                i64::try_from(request.len()).map_err(|_| backfill_invalid())?,
            ));
        }

        for (batch_row_id, ordinal, sealed, request_sha256, byte_count) in sealed_requests {
            transaction
                .execute(
                    "INSERT INTO outbox_batches
                     (batch_row_id, source_kind, window_id, backfill_job_id,
                      ordinal, state, request_cipher, request_nonce, request_key_version,
                      request_sha256, byte_count, attempt_count, next_attempt_at,
                      accepted_at, terminal_code)
                     VALUES (?1, 'backfill', NULL, ?2, ?3, 'pending', ?4, ?5, ?6,
                             ?7, ?8, 0, ?9, NULL, NULL)",
                    params![
                        batch_row_id,
                        job_id,
                        ordinal,
                        sealed.ciphertext.as_slice(),
                        sealed.nonce.as_slice(),
                        i64::from(sealed.key_version),
                        request_sha256.as_slice(),
                        byte_count,
                        window.archived_at.as_str(),
                    ],
                )
                .map_err(|_| backfill_conflict())?;
        }

        persist_backfill_checkpoint(
            &transaction,
            keyring,
            &row,
            &verified,
            pagination_bytes,
            accepted_events_sql,
        )?;
        transaction.commit().map_err(|_| backfill_corrupt())?;
        Ok(())
    }

    /// Accept one explicit-backfill row and complete its job when its durable
    /// page checkpoint proves that the row is the final accepted row.
    pub fn accept_backfill_batch_and_maybe_complete_job(
        &mut self,
        row_id: &str,
        accepted_at: DateTime<Utc>,
    ) -> Result<BackfillCommitOutcome, SafeError> {
        if !valid_batch_row_id(row_id) || !valid_utc_millisecond(accepted_at) {
            return Err(backfill_invalid());
        }

        let keyring = &self.keyring;
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| backfill_corrupt())?;
        let target =
            load_backfill_outbox_row_by_id(&transaction, row_id)?.ok_or_else(backfill_not_ready)?;
        if target.source_kind != BACKFILL_KIND_OUTBOX {
            return Err(backfill_not_ready());
        }
        if target.window_id.is_some() {
            return Err(backfill_corrupt());
        }
        let job_id = target
            .backfill_job_id
            .clone()
            .ok_or_else(backfill_corrupt)?;
        validate_job_id(&job_id).map_err(|_| backfill_corrupt())?;
        let job_row = load_backfill_row(&transaction, &job_id)?.ok_or_else(backfill_corrupt)?;
        validate_explicit_job_shape(&job_row)?;
        let verified = verify_backfill_row(keyring, &job_row)?;
        let created_at =
            parse_stored_timestamp(&verified.created_at).map_err(|_| backfill_corrupt())?;
        if accepted_at < created_at {
            return Err(backfill_invalid());
        }
        let scan = scan_backfill_outbox_rows(&transaction, keyring, &verified.job, None)?;
        validate_backfill_page_shape(&verified, scan.count)?;
        let target = verify_backfill_outbox_row(keyring, &verified.job, target)?;
        if target.batch_row_id != row_id || target.state == "quarantined" {
            return Err(backfill_not_ready());
        }

        match verified.state {
            BackfillState::Completed => {
                if scan.pending_count != 0
                    || scan.quarantined_count != 0
                    || !is_exhausted_pagination(&verified)
                {
                    return Err(backfill_corrupt());
                }
                if target.state != "accepted" {
                    return Err(backfill_corrupt());
                }
                if target.accepted_at != Some(accepted_at) {
                    return Err(backfill_conflict());
                }
                drop(transaction);
                return Ok(BackfillCommitOutcome::AlreadyCompleted {
                    accepted_events: verified.accepted_events,
                });
            }
            BackfillState::Running => {}
            BackfillState::Pending | BackfillState::Cancelled | BackfillState::Quarantined => {
                return Err(backfill_not_ready());
            }
        }

        match target.state.as_str() {
            "pending" => {
                let updated = transaction
                    .execute(
                        "UPDATE outbox_batches
                         SET state = 'accepted', accepted_at = ?1
                         WHERE batch_row_id = ?2 AND source_kind = 'backfill'
                           AND window_id IS NULL AND backfill_job_id = ?3
                           AND ordinal = ?4 AND state = 'pending'
                           AND request_sha256 = ?5 AND byte_count = ?6
                           AND attempt_count = ?7 AND next_attempt_at = ?8
                           AND accepted_at IS NULL AND terminal_code IS NULL
                           AND EXISTS (
                             SELECT 1 FROM backfill_jobs AS j
                             WHERE j.job_id = outbox_batches.backfill_job_id
                               AND j.kind = 'explicit' AND j.live_window_id IS NULL
                               AND j.state = 'running'
                           )",
                        params![
                            accepted_at.to_rfc3339(),
                            row_id,
                            job_id.as_str(),
                            i64::try_from(target.ordinal).map_err(|_| backfill_corrupt())?,
                            target.request_sha256.as_slice(),
                            i64::try_from(target.byte_count).map_err(|_| backfill_corrupt())?,
                            i64::from(target.attempt_count),
                            target.next_attempt_at_text.as_str(),
                        ],
                    )
                    .map_err(|_| backfill_corrupt())?;
                if updated != 1 {
                    return Err(backfill_corrupt());
                }
            }
            "accepted" => {
                if target.accepted_at != Some(accepted_at) {
                    return Err(backfill_conflict());
                }
            }
            _ => return Err(backfill_corrupt()),
        }

        let after = scan_backfill_outbox_rows(&transaction, keyring, &verified.job, None)?;
        validate_backfill_page_shape(&verified, after.count)?;
        if after.pending_count == 0
            && after.quarantined_count == 0
            && is_exhausted_pagination(&verified)
        {
            let updated = transaction
                .execute(
                    "UPDATE backfill_jobs
                     SET state = 'completed', completed_at = ?1
                     WHERE job_id = ?2 AND kind = 'explicit' AND live_window_id IS NULL
                       AND state = 'running' AND completed_at IS NULL
                       AND cancelled_at IS NULL AND terminal_code IS NULL
                       AND accepted_events = ?3",
                    params![
                        accepted_at.to_rfc3339(),
                        job_id.as_str(),
                        verified.accepted_events
                    ],
                )
                .map_err(|_| backfill_corrupt())?;
            if updated != 1 {
                return Err(backfill_corrupt());
            }
            transaction.commit().map_err(|_| backfill_corrupt())?;
            return Ok(BackfillCommitOutcome::JobCompleted {
                accepted_events: verified.accepted_events,
            });
        }

        transaction.commit().map_err(|_| backfill_corrupt())?;
        Ok(BackfillCommitOutcome::BatchAccepted {
            accepted_events: verified.accepted_events,
        })
    }

    /// Complete an explicit backfill whose authenticated page state is exhausted.
    pub fn complete_backfill_job(
        &mut self,
        job_id: &str,
        completed_at: DateTime<Utc>,
    ) -> Result<(), SafeError> {
        validate_job_id(job_id)?;
        if !valid_utc_millisecond(completed_at) {
            return Err(backfill_invalid());
        }

        let keyring = &self.keyring;
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| backfill_corrupt())?;
        let row = load_backfill_row(&transaction, job_id)?.ok_or_else(backfill_not_ready)?;
        validate_explicit_job_shape(&row)?;
        let verified = verify_backfill_row(keyring, &row)?;
        let created_at =
            parse_stored_timestamp(&verified.created_at).map_err(|_| backfill_corrupt())?;
        if completed_at < created_at {
            return Err(backfill_invalid());
        }
        let scan = scan_backfill_outbox_rows(&transaction, keyring, &verified.job, None)?;
        validate_backfill_page_shape(&verified, scan.count)?;

        match verified.state {
            BackfillState::Completed => {
                if scan.pending_count != 0
                    || scan.quarantined_count != 0
                    || !is_exhausted_pagination(&verified)
                {
                    return Err(backfill_corrupt());
                }
                let stored = row.completed_at.as_deref().ok_or_else(backfill_corrupt)?;
                if parse_stored_timestamp(stored).map_err(|_| backfill_corrupt())? != completed_at {
                    return Err(backfill_conflict());
                }
                drop(transaction);
                Ok(())
            }
            BackfillState::Running => {
                if scan.pending_count != 0
                    || scan.quarantined_count != 0
                    || !is_exhausted_pagination(&verified)
                {
                    return Err(backfill_not_ready());
                }
                let updated = transaction
                    .execute(
                        "UPDATE backfill_jobs
                         SET state = 'completed', completed_at = ?1
                         WHERE job_id = ?2 AND kind = 'explicit' AND live_window_id IS NULL
                           AND state = 'running' AND completed_at IS NULL
                           AND cancelled_at IS NULL AND terminal_code IS NULL
                           AND accepted_events = ?3",
                        params![completed_at.to_rfc3339(), job_id, verified.accepted_events],
                    )
                    .map_err(|_| backfill_corrupt())?;
                if updated != 1 {
                    return Err(backfill_corrupt());
                }
                transaction.commit().map_err(|_| backfill_corrupt())?;
                Ok(())
            }
            BackfillState::Pending | BackfillState::Cancelled | BackfillState::Quarantined => {
                Err(backfill_not_ready())
            }
        }
    }

    /// Cancel an explicit backfill while retaining its encrypted audit rows.
    pub fn cancel_backfill_job(
        &mut self,
        job_id: &str,
        cancelled_at: DateTime<Utc>,
    ) -> Result<(), SafeError> {
        validate_job_id(job_id)?;
        if !valid_utc_millisecond(cancelled_at) {
            return Err(backfill_invalid());
        }

        let keyring = &self.keyring;
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| backfill_corrupt())?;
        let row = load_backfill_row(&transaction, job_id)?.ok_or_else(backfill_not_ready)?;
        validate_explicit_job_shape(&row)?;
        let verified = verify_backfill_row(keyring, &row)?;
        let created_at =
            parse_stored_timestamp(&verified.created_at).map_err(|_| backfill_corrupt())?;
        if cancelled_at < created_at {
            return Err(backfill_invalid());
        }
        let scan = scan_backfill_outbox_rows(&transaction, keyring, &verified.job, None)?;
        validate_backfill_page_shape(&verified, scan.count)?;

        match verified.state {
            BackfillState::Cancelled => {
                let stored = row.cancelled_at.as_deref().ok_or_else(backfill_corrupt)?;
                if parse_stored_timestamp(stored).map_err(|_| backfill_corrupt())? != cancelled_at {
                    return Err(backfill_conflict());
                }
                drop(transaction);
                Ok(())
            }
            BackfillState::Pending | BackfillState::Running => {
                if verified.state == BackfillState::Pending && scan.count != 0 {
                    return Err(backfill_corrupt());
                }
                let updated = transaction
                    .execute(
                        "UPDATE backfill_jobs
                         SET state = 'cancelled', cancelled_at = ?1
                         WHERE job_id = ?2 AND kind = 'explicit' AND live_window_id IS NULL
                           AND state IN ('pending', 'running')
                           AND completed_at IS NULL AND cancelled_at IS NULL
                           AND terminal_code IS NULL AND accepted_events = ?3",
                        params![cancelled_at.to_rfc3339(), job_id, verified.accepted_events],
                    )
                    .map_err(|_| backfill_corrupt())?;
                if updated != 1 {
                    return Err(backfill_corrupt());
                }
                transaction.commit().map_err(|_| backfill_corrupt())?;
                Ok(())
            }
            BackfillState::Completed | BackfillState::Quarantined => Err(backfill_not_ready()),
        }
    }
}

/// Select the oldest due explicit-backfill row after authenticating the entire
/// candidate job and all of its durable outbox rows.
pub(crate) fn select_next_pending_backfill_batch(
    transaction: &Transaction<'_>,
    keyring: &crate::crypto::Keyring,
    now: DateTime<Utc>,
) -> Result<Option<PendingIngestionBatch>, SafeError> {
    if !valid_utc_millisecond(now) {
        return Err(backfill_invalid());
    }

    let mut statement = transaction
        .prepare(
            "SELECT job_id FROM backfill_jobs
             WHERE kind = 'explicit' AND live_window_id IS NULL AND state = 'running'
             ORDER BY created_at ASC, job_id ASC",
        )
        .map_err(|_| backfill_corrupt())?;
    let mut rows = statement.query([]).map_err(|_| backfill_corrupt())?;
    while let Some(row) = rows.next().map_err(|_| backfill_corrupt())? {
        let job_id = read_text(row, 0, MAX_LEDGER_ID_BYTES)?;
        let job_row = load_backfill_row(transaction, &job_id)?.ok_or_else(backfill_corrupt)?;
        validate_explicit_job_shape(&job_row)?;
        let verified = verify_backfill_row(keyring, &job_row)?;
        if verified.state != BackfillState::Running {
            return Err(backfill_corrupt());
        }
        let scan = scan_backfill_outbox_rows(transaction, keyring, &verified.job, Some(now))?;
        validate_backfill_page_shape(&verified, scan.count)?;
        let Some(candidate) = scan.candidate else {
            continue;
        };
        let request = batch::reparse_and_verify_request(candidate.request.as_slice())
            .map_err(|_| backfill_corrupt())?;
        let batch = PendingBatch::new(
            request.tenant_id,
            candidate.batch_row_id.clone(),
            candidate.request.as_slice().to_vec(),
        );
        return PendingIngestionBatch::from_verified_parts(
            candidate.batch_row_id,
            batch,
            candidate.attempt_count,
            candidate.next_attempt_at,
        )
        .map(Some)
        .map_err(|_| backfill_corrupt());
    }
    Ok(None)
}

/// Apply the backfill half of the shared ingestion-attempt CAS API.
///
/// `None` means the addressed row is a live row and the caller should continue
/// with the live ledger.  `Some` means the row was a backfill row and this
/// helper has either applied the CAS or returned its stable failure.
pub(crate) fn try_record_backfill_ingestion_attempt(
    transaction: &Transaction<'_>,
    keyring: &crate::crypto::Keyring,
    row_id: &str,
    expected_attempt_count: u32,
    expected_next_attempt_at: DateTime<Utc>,
    attempted_at: DateTime<Utc>,
    next_attempt_at: DateTime<Utc>,
) -> Result<Option<()>, SafeError> {
    let Some(stored_target) = load_backfill_outbox_row_by_id(transaction, row_id)? else {
        return Ok(None);
    };
    match stored_target.source_kind.as_str() {
        "live" => return Ok(None),
        BACKFILL_KIND_OUTBOX => {}
        _ => return Err(backfill_corrupt()),
    }
    let job_id = stored_target
        .backfill_job_id
        .clone()
        .ok_or_else(backfill_corrupt)?;
    validate_job_id(&job_id).map_err(|_| backfill_corrupt())?;
    if stored_target.window_id.is_some() {
        return Err(backfill_corrupt());
    }
    let job_row = load_backfill_row(transaction, &job_id)?.ok_or_else(backfill_corrupt)?;
    validate_explicit_job_shape(&job_row)?;
    let verified_job = verify_backfill_row(keyring, &job_row)?;
    let scan = scan_backfill_outbox_rows(transaction, keyring, &verified_job.job, None)?;
    validate_backfill_page_shape(&verified_job, scan.count)?;
    if verified_job.state != BackfillState::Running {
        return Err(ledger_cas_mismatch());
    }
    let target = verify_backfill_outbox_row(keyring, &verified_job.job, stored_target)?;
    if target.state != "pending"
        || target.ordinal >= scan.count
        || target.attempt_count != expected_attempt_count
        || target.next_attempt_at != expected_next_attempt_at
        || target.attempt_count >= BACKFILL_OUTBOX_ATTEMPT_COUNT_MAX as u32
        || attempted_at < expected_next_attempt_at
        || next_attempt_at <= attempted_at
    {
        return Err(ledger_cas_mismatch());
    }

    let updated = transaction
        .execute(
            "UPDATE outbox_batches
             SET attempt_count = attempt_count + 1, next_attempt_at = ?1
             WHERE batch_row_id = ?2 AND source_kind = 'backfill'
               AND window_id IS NULL AND backfill_job_id = ?3
               AND ordinal = ?4 AND state = 'pending'
               AND attempt_count = ?5 AND next_attempt_at = ?6
               AND attempt_count < ?7 AND accepted_at IS NULL AND terminal_code IS NULL
               AND EXISTS (
                 SELECT 1 FROM backfill_jobs AS j
                 WHERE j.job_id = outbox_batches.backfill_job_id
                   AND j.kind = 'explicit' AND j.live_window_id IS NULL
                   AND j.state = 'running'
               )",
            params![
                next_attempt_at.to_rfc3339(),
                row_id,
                job_id.as_str(),
                i64::try_from(target.ordinal).map_err(|_| backfill_corrupt())?,
                i64::from(expected_attempt_count),
                target.next_attempt_at_text.as_str(),
                BACKFILL_OUTBOX_ATTEMPT_COUNT_MAX,
            ],
        )
        .map_err(|_| backfill_corrupt())?;
    if updated != 1 {
        return Err(ledger_cas_mismatch());
    }
    Ok(Some(()))
}

fn ledger_cas_mismatch() -> SafeError {
    SafeError::new(STORE_LEDGER_CAS_MISMATCH)
}

fn validate_checkpoint_input(
    job_id: &str,
    pagination: Option<&crate::secret::SecretBytes>,
    window: &BatchWindow,
    accepted_events: u64,
) -> Result<(), SafeError> {
    validate_job_id(job_id)?;
    if window.batches.len() > MAX_BACKFILL_PAGE_BATCHES {
        return Err(backfill_too_large());
    }
    if accepted_events > batch::MAX_BACKFILL_EVENTS || i64::try_from(accepted_events).is_err() {
        return Err(backfill_invalid());
    }
    validate_input_timestamp(&window.archived_at)?;
    validate_input_source_checkpoint(&window.source_checkpoint)?;
    if let Some(pagination) = pagination {
        if pagination.is_empty() {
            return Err(backfill_invalid());
        }
        if pagination.len() > MAX_BACKFILL_PAGINATION_BYTES {
            return Err(backfill_invalid());
        }
        if is_reserved_provider_pagination(pagination.as_bytes()) {
            return Err(backfill_invalid());
        }
    }

    let mut request_plaintext_lengths = Vec::with_capacity(window.batches.len());
    for built in &window.batches {
        validate_input_batch(window, built)?;
        request_plaintext_lengths.push(built.exact_request_bytes().len());
    }
    checked_backfill_checkpoint_recovery_bytes(
        0,
        request_plaintext_lengths,
        pagination.map_or(0, |value| value.len()),
    )?;

    let mut batch_ids = HashSet::with_capacity(window.batches.len());
    for built in &window.batches {
        if !batch_ids.insert(built.batch_id.as_str()) {
            return Err(backfill_invalid());
        }
    }
    Ok(())
}

fn validate_input_batch(window: &BatchWindow, built: &batch::BuiltBatch) -> Result<(), SafeError> {
    let request_bytes = built.exact_request_bytes();
    if request_bytes.is_empty() || request_bytes.len() > MAX_BATCH_CANONICAL_BYTES {
        return Err(backfill_invalid());
    }
    let request =
        batch::reparse_and_verify_request(request_bytes).map_err(|_| backfill_invalid())?;
    if request != built.request
        || request.events != built.events
        || built.batch_id != request.batch_id
        || request.archived_at != window.archived_at
    {
        return Err(backfill_invalid());
    }
    validate_input_source_checkpoint(&request.source_checkpoint)?;

    let mut canonical_jsonl = Vec::new();
    for event in &request.events {
        let line =
            canonical::canonical_event_json_line_bytes(event).map_err(|_| backfill_invalid())?;
        let event_bytes = line.len().checked_sub(1).ok_or_else(backfill_invalid)?;
        if event_bytes > MAX_EVENT_CANONICAL_BYTES {
            return Err(backfill_invalid());
        }
        let next_len = canonical_jsonl
            .len()
            .checked_add(line.len())
            .ok_or_else(backfill_invalid)?;
        if next_len > MAX_BATCH_CANONICAL_BYTES {
            return Err(backfill_invalid());
        }
        canonical_jsonl.extend_from_slice(&line);
    }
    let canonical_sha256 = canonical::sha256_hex(&canonical_jsonl);
    let request_input = CanonicalBatchInput {
        gateway_route_id: request.gateway_route_id.clone(),
        tenant_id: request.tenant_id.clone(),
        archived_at: request.archived_at.clone(),
        producer_version: request.producer_version.clone(),
        source_checkpoint: request.source_checkpoint.clone(),
        events: request.events.clone(),
    };
    let identity_json = canonical::batch_identity_json(&request_input, &canonical_sha256)
        .map_err(|_| backfill_invalid())?;
    let expected_batch_id = format!("batch_{}", canonical::sha256_hex(&identity_json));
    if built.canonical_jsonl != canonical_jsonl
        || built.uncompressed_bytes != canonical_jsonl.len()
        || built.canonical_sha256 != canonical_sha256
        || built.identity_json != identity_json
        || built.batch_id != expected_batch_id
    {
        return Err(backfill_invalid());
    }
    Ok(())
}

fn validate_input_timestamp(value: &str) -> Result<(), SafeError> {
    if !model::valid_timestamp(value)
        || DateTime::parse_from_rfc3339(value).is_err()
        || !value.is_ascii()
    {
        return Err(backfill_invalid());
    }
    Ok(())
}

fn validate_input_source_checkpoint(checkpoint: &SourceCheckpoint) -> Result<(), SafeError> {
    if checkpoint.kind != "matrix_backfill_run_sha256" || !valid_sha256_value(&checkpoint.value) {
        return Err(backfill_invalid());
    }
    Ok(())
}

fn find_page_start(
    job: &BackfillJob,
    source_checkpoint: &SourceCheckpoint,
    existing_count: u64,
) -> Result<u64, SafeError> {
    for ordinal in 0..=existing_count {
        if expected_source_checkpoint(job, ordinal)? == *source_checkpoint {
            return Ok(ordinal);
        }
    }
    Err(backfill_not_ready())
}

fn validate_page_sources(
    job: &BackfillJob,
    window: &BatchWindow,
    page_start: u64,
) -> Result<(), SafeError> {
    if expected_source_checkpoint(job, page_start)? != window.source_checkpoint {
        return Err(backfill_invalid());
    }
    for (offset, built) in window.batches.iter().enumerate() {
        let ordinal = page_start
            .checked_add(u64::try_from(offset).map_err(|_| backfill_invalid())?)
            .ok_or_else(backfill_invalid)?;
        let request = batch::reparse_and_verify_request(built.exact_request_bytes())
            .map_err(|_| backfill_invalid())?;
        validate_request_job_scope(job, &request).map_err(|_| backfill_invalid())?;
        if request.source_checkpoint != expected_source_checkpoint(job, ordinal)? {
            return Err(backfill_invalid());
        }
    }
    Ok(())
}

fn validate_request_job_scope(
    job: &BackfillJob,
    request: &canonical::CanonicalBatchRequest,
) -> Result<(), SafeError> {
    if request.events.iter().any(|event| {
        event.event_source != model::CanonicalEventSource::Backfill
            || event.matrix_room_id.as_deref() != Some(job.room_id())
    }) {
        return Err(backfill_invalid());
    }
    Ok(())
}

fn expected_source_checkpoint(
    job: &BackfillJob,
    ordinal: u64,
) -> Result<SourceCheckpoint, SafeError> {
    let WindowSource::Backfill(checkpoint) = job.checkpoint(ordinal) else {
        return Err(backfill_corrupt());
    };
    let max_events = checkpoint.max_events().to_string();
    let batch_ordinal = checkpoint.batch_ordinal().to_string();
    let digest = model::framed_hash_id(
        "matrix-backfill-checkpoint-v1",
        &[
            checkpoint.job_id(),
            checkpoint.room_id(),
            checkpoint.start_at(),
            checkpoint.end_at(),
            &max_events,
            &batch_ordinal,
        ],
    )
    .map_err(|_| backfill_corrupt())?;
    Ok(SourceCheckpoint {
        kind: "matrix_backfill_run_sha256".to_owned(),
        value: format!("sha256:{digest}"),
    })
}

fn valid_sha256_value(value: &str) -> bool {
    value.len() == "sha256:".len() + 64
        && value.starts_with("sha256:")
        && value["sha256:".len()..]
            .bytes()
            .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
}

fn load_backfill_row(
    connection: &rusqlite::Connection,
    job_id: &str,
) -> Result<Option<StoredBackfillRow>, SafeError> {
    preflight_backfill_job_bytes(connection, job_id)?;
    let mut statement = connection
        .prepare(
            "SELECT job_id, kind, live_window_id, state,
                    parameters_cipher, parameters_nonce, pagination_cipher, pagination_nonce,
                    key_version, accepted_events, created_at,
                    completed_at, cancelled_at, terminal_code
             FROM backfill_jobs WHERE job_id = ?1",
        )
        .map_err(|_| backfill_corrupt())?;
    let mut rows = statement.query([job_id]).map_err(|_| backfill_corrupt())?;
    let Some(row) = rows.next().map_err(|_| backfill_corrupt())? else {
        return Ok(None);
    };
    let stored = read_backfill_row(row)?;
    if rows.next().map_err(|_| backfill_corrupt())?.is_some() {
        return Err(backfill_corrupt());
    }
    Ok(Some(stored))
}

fn read_backfill_row(row: &Row<'_>) -> Result<StoredBackfillRow, SafeError> {
    Ok(StoredBackfillRow {
        job_id: read_text(row, 0, MAX_LEDGER_ID_BYTES)?,
        kind: read_text(row, 1, BACKFILL_KIND_MAX_BYTES)?,
        live_window_id: read_optional_text(row, 2, MAX_LEDGER_ID_BYTES)?,
        state: read_text(row, 3, BACKFILL_STATE_MAX_BYTES)?,
        parameters_cipher: read_blob(
            row,
            4,
            AEAD_TAG_BYTES,
            MAX_BACKFILL_JOB_ENVELOPE_BYTES
                .checked_add(AEAD_TAG_BYTES)
                .ok_or_else(backfill_corrupt)?,
        )?,
        parameters_nonce: read_blob(row, 5, BACKFILL_NONCE_BYTES, BACKFILL_NONCE_BYTES)?,
        pagination_cipher: read_optional_blob(
            row,
            6,
            AEAD_TAG_BYTES,
            MAX_BACKFILL_PAGINATION_BYTES
                .checked_add(AEAD_TAG_BYTES)
                .ok_or_else(backfill_corrupt)?,
        )?,
        pagination_nonce: read_optional_blob(row, 7, BACKFILL_NONCE_BYTES, BACKFILL_NONCE_BYTES)?,
        key_version: read_integer(row, 8, 1, i64::from(u32::MAX))?,
        accepted_events: read_integer(row, 9, 0, i64::MAX)?,
        created_at: read_text(row, 10, BACKFILL_TIMESTAMP_MAX_BYTES)?,
        completed_at: read_optional_text(row, 11, BACKFILL_TIMESTAMP_MAX_BYTES)?,
        cancelled_at: read_optional_text(row, 12, BACKFILL_TIMESTAMP_MAX_BYTES)?,
        terminal_code: read_optional_text(row, 13, BACKFILL_TERMINAL_CODE_MAX_BYTES)?,
    })
}

fn validate_explicit_job_shape(row: &StoredBackfillRow) -> Result<(), SafeError> {
    if row.kind != BACKFILL_KIND_EXPLICIT || row.live_window_id.is_some() {
        if row.kind == BACKFILL_KIND_LIVE_GAP {
            return Err(backfill_not_ready());
        }
        return Err(backfill_corrupt());
    }
    Ok(())
}

fn validate_backfill_page_shape(
    job: &VerifiedBackfillRow,
    outbox_count: u64,
) -> Result<(), SafeError> {
    if outbox_count > job.job.max_events() {
        return Err(backfill_corrupt());
    }
    if outbox_count != 0 && job.pagination.is_none() {
        return Err(backfill_corrupt());
    }
    if let StoredPagination::Terminal(marker) =
        stored_pagination(job.pagination.as_deref().map(|value| &**value))?
    {
        let marker_end = marker
            .page_start
            .checked_add(marker.page_length)
            .ok_or_else(backfill_corrupt)?;
        if marker_end != outbox_count {
            return Err(backfill_corrupt());
        }
    }
    Ok(())
}

fn is_exhausted_pagination(job: &VerifiedBackfillRow) -> bool {
    job.pagination.as_ref().is_some_and(|value| {
        value.as_slice() == BACKFILL_EXHAUSTED_SENTINEL
            || value
                .as_slice()
                .starts_with(BACKFILL_TERMINAL_MARKER_PREFIX)
            || serde_json::from_slice::<HistoryPaginationEnvelope>(value.as_slice())
                .ok()
                .is_some_and(|value| {
                    value.schema_version == 1
                        && !value.range_id.is_empty()
                        && value
                            .input_cursor
                            .as_deref()
                            .is_none_or(|cursor| !cursor.is_empty())
                        && !value.source_cursor.is_empty()
                        && value.public_cursor.starts_with("history_")
                        && value.page_start.checked_add(value.page_length).is_some()
                        && value.history_terminal
                })
    })
}

fn load_backfill_outbox_rows(
    connection: &rusqlite::Connection,
    keyring: &crate::crypto::Keyring,
    job: &BackfillJob,
) -> Result<u64, SafeError> {
    Ok(scan_backfill_outbox_rows(connection, keyring, job, None)?.count)
}

fn preflight_backfill_outbox_bytes(
    connection: &rusqlite::Connection,
    job: &BackfillJob,
) -> Result<(u64, u64), SafeError> {
    preflight_backfill_outbox_ciphertext_bytes(connection, job.job_id(), job.max_events())
}

fn preflight_backfill_outbox_ciphertext_bytes(
    connection: &rusqlite::Connection,
    job_id: &str,
    max_rows: u64,
) -> Result<(u64, u64), SafeError> {
    let min_ciphertext = i64::try_from(AEAD_TAG_BYTES).map_err(|_| backfill_corrupt())?;
    let max_ciphertext = i64::try_from(BACKFILL_OUTBOX_REQUEST_MAX_CIPHERTEXT_BYTES)
        .map_err(|_| backfill_corrupt())?;
    let max_byte_count =
        i64::try_from(MAX_BATCH_CANONICAL_BYTES).map_err(|_| backfill_corrupt())?;
    let (count, total_bytes, invalid_count): (i64, i64, i64) = connection
        .query_row(
            "SELECT COUNT(*),
                    COALESCE(SUM(CASE
                        WHEN typeof(request_cipher) = 'blob'
                         AND length(request_cipher) >= ?2
                         AND length(request_cipher) <= ?3
                        THEN length(request_cipher) ELSE 0 END), 0),
                    COALESCE(SUM(CASE
                        WHEN typeof(request_cipher) <> 'blob'
                          OR length(request_cipher) < ?2
                          OR length(request_cipher) > ?3
                          OR typeof(byte_count) <> 'integer'
                          OR byte_count < 1 OR byte_count > ?4
                        THEN 1 ELSE 0 END), 0)
             FROM outbox_batches WHERE backfill_job_id = ?1",
            params![job_id, min_ciphertext, max_ciphertext, max_byte_count],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .map_err(|_| backfill_corrupt())?;
    if invalid_count != 0 {
        return Err(backfill_corrupt());
    }
    let count = u64::try_from(count).map_err(|_| backfill_corrupt())?;
    if count > max_rows {
        return Err(backfill_corrupt());
    }
    let total_bytes = u64::try_from(total_bytes).map_err(|_| backfill_corrupt())?;
    super::checked_recovery_bytes(0, total_bytes).map_err(|_| backfill_corrupt())?;
    Ok((count, total_bytes))
}

fn preflight_backfill_job_bytes(
    connection: &rusqlite::Connection,
    job_id: &str,
) -> Result<(), SafeError> {
    let max_parameters_ciphertext = i64::try_from(
        MAX_BACKFILL_JOB_ENVELOPE_BYTES
            .checked_add(AEAD_TAG_BYTES)
            .ok_or_else(backfill_corrupt)?,
    )
    .map_err(|_| backfill_corrupt())?;
    let max_pagination_ciphertext = i64::try_from(
        MAX_BACKFILL_PAGINATION_BYTES
            .checked_add(AEAD_TAG_BYTES)
            .ok_or_else(backfill_corrupt)?,
    )
    .map_err(|_| backfill_corrupt())?;
    let min_ciphertext = i64::try_from(AEAD_TAG_BYTES).map_err(|_| backfill_corrupt())?;
    let nonce_bytes = i64::try_from(BACKFILL_NONCE_BYTES).map_err(|_| backfill_corrupt())?;
    let (job_count, parameters_bytes, pagination_bytes, invalid_count): (i64, i64, i64, i64) =
        connection
            .query_row(
                "SELECT COUNT(*),
                        COALESCE(SUM(CASE
                            WHEN typeof(parameters_cipher) = 'blob'
                             AND length(parameters_cipher) BETWEEN ?2 AND ?3
                            THEN length(parameters_cipher) ELSE 0 END), 0),
                        COALESCE(SUM(CASE
                            WHEN typeof(pagination_cipher) = 'blob'
                             AND length(pagination_cipher) BETWEEN ?2 AND ?4
                            THEN length(pagination_cipher) ELSE 0 END), 0),
                        COALESCE(SUM(CASE
                            WHEN typeof(parameters_cipher) <> 'blob'
                              OR length(parameters_cipher) < ?2
                              OR length(parameters_cipher) > ?3
                              OR typeof(parameters_nonce) <> 'blob'
                              OR length(parameters_nonce) <> ?5
                              OR (pagination_cipher IS NULL) != (pagination_nonce IS NULL)
                              OR (pagination_cipher IS NOT NULL AND
                                  (typeof(pagination_cipher) <> 'blob'
                                   OR length(pagination_cipher) < ?2
                                   OR length(pagination_cipher) > ?4
                                   OR typeof(pagination_nonce) <> 'blob'
                                   OR length(pagination_nonce) <> ?5))
                            THEN 1 ELSE 0 END), 0)
                 FROM backfill_jobs WHERE job_id = ?1",
                params![
                    job_id,
                    min_ciphertext,
                    max_parameters_ciphertext,
                    max_pagination_ciphertext,
                    nonce_bytes,
                ],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .map_err(|_| backfill_corrupt())?;
    if job_count > 1 || invalid_count != 0 {
        return Err(backfill_corrupt());
    }
    let mut total_bytes = u64::try_from(parameters_bytes).map_err(|_| backfill_corrupt())?;
    total_bytes = super::checked_recovery_bytes(
        total_bytes,
        u64::try_from(pagination_bytes).map_err(|_| backfill_corrupt())?,
    )
    .map_err(|_| backfill_corrupt())?;
    let (_, outbox_bytes) =
        preflight_backfill_outbox_ciphertext_bytes(connection, job_id, batch::MAX_BACKFILL_EVENTS)?;
    super::checked_recovery_bytes(total_bytes, outbox_bytes).map_err(|_| backfill_corrupt())?;
    Ok(())
}

fn scan_backfill_outbox_rows(
    connection: &rusqlite::Connection,
    keyring: &crate::crypto::Keyring,
    job: &BackfillJob,
    now: Option<DateTime<Utc>>,
) -> Result<BackfillOutboxScan, SafeError> {
    let (count, _) = preflight_backfill_outbox_bytes(connection, job)?;

    let mut statement = connection
        .prepare(
            "SELECT batch_row_id, source_kind, window_id, backfill_job_id,
                    ordinal, state, request_cipher, request_nonce, request_key_version,
                    request_sha256, byte_count, attempt_count, next_attempt_at,
                    accepted_at, terminal_code
             FROM outbox_batches
             WHERE backfill_job_id = ?1
             ORDER BY ordinal ASC",
        )
        .map_err(|_| backfill_corrupt())?;
    let mut rows = statement
        .query([job.job_id()])
        .map_err(|_| backfill_corrupt())?;
    let mut expected_ordinal = 0_u64;
    let mut pending_count = 0_u64;
    let mut quarantined_count = 0_u64;
    let mut candidate = None;
    let mut pending_head_blocked = false;
    while let Some(row) = rows.next().map_err(|_| backfill_corrupt())? {
        let stored = read_backfill_outbox_row(row)?;
        let checked = verify_backfill_outbox_row(keyring, job, stored)?;
        if checked.ordinal != expected_ordinal {
            return Err(backfill_corrupt());
        }
        expected_ordinal = expected_ordinal
            .checked_add(1)
            .ok_or_else(backfill_corrupt)?;
        match checked.state.as_str() {
            "pending" => {
                pending_count = pending_count.checked_add(1).ok_or_else(backfill_corrupt)?;
                if let Some(now) = now
                    && !pending_head_blocked
                    && candidate.is_none()
                {
                    if checked.next_attempt_at <= now {
                        candidate = Some(checked);
                    } else {
                        pending_head_blocked = true;
                    }
                }
            }
            "quarantined" => {
                quarantined_count = quarantined_count
                    .checked_add(1)
                    .ok_or_else(backfill_corrupt)?;
            }
            "accepted" => {}
            _ => return Err(backfill_corrupt()),
        }
    }
    if expected_ordinal != count {
        return Err(backfill_corrupt());
    }
    Ok(BackfillOutboxScan {
        count,
        pending_count,
        quarantined_count,
        candidate,
    })
}

fn load_backfill_outbox_row_by_id(
    connection: &rusqlite::Connection,
    row_id: &str,
) -> Result<Option<StoredBackfillOutboxRow>, SafeError> {
    let mut ownership_statement = connection
        .prepare(
            "SELECT source_kind, backfill_job_id
             FROM outbox_batches WHERE batch_row_id = ?1 LIMIT 2",
        )
        .map_err(|_| backfill_corrupt())?;
    let mut ownership_rows = ownership_statement
        .query([row_id])
        .map_err(|_| backfill_corrupt())?;
    let Some(ownership_row) = ownership_rows.next().map_err(|_| backfill_corrupt())? else {
        return Ok(None);
    };
    let source_kind = read_text(ownership_row, 0, BACKFILL_OUTBOX_SOURCE_KIND_MAX_BYTES)?;
    let backfill_job_id = read_optional_text(ownership_row, 1, MAX_LEDGER_ID_BYTES)?;
    if ownership_rows
        .next()
        .map_err(|_| backfill_corrupt())?
        .is_some()
    {
        return Err(backfill_corrupt());
    }
    if source_kind == BACKFILL_KIND_OUTBOX {
        let backfill_job_id = backfill_job_id.ok_or_else(backfill_corrupt)?;
        preflight_backfill_job_bytes(connection, &backfill_job_id)?;
    }

    let mut statement = connection
        .prepare(
            "SELECT batch_row_id, source_kind, window_id, backfill_job_id,
                    ordinal, state, request_cipher, request_nonce, request_key_version,
                    request_sha256, byte_count, attempt_count, next_attempt_at,
                    accepted_at, terminal_code
             FROM outbox_batches WHERE batch_row_id = ?1 LIMIT 2",
        )
        .map_err(|_| backfill_corrupt())?;
    let mut rows = statement.query([row_id]).map_err(|_| backfill_corrupt())?;
    let Some(row) = rows.next().map_err(|_| backfill_corrupt())? else {
        return Ok(None);
    };
    let stored = read_backfill_outbox_row(row)?;
    if rows.next().map_err(|_| backfill_corrupt())?.is_some() {
        return Err(backfill_corrupt());
    }
    Ok(Some(stored))
}

fn validate_existing_page(
    connection: &rusqlite::Connection,
    keyring: &crate::crypto::Keyring,
    job: &BackfillJob,
    page_start: u64,
    page_end: u64,
    window: &BatchWindow,
) -> Result<(), SafeError> {
    let page_length = page_end
        .checked_sub(page_start)
        .ok_or_else(backfill_corrupt)?;
    let limit = page_length
        .checked_add(1)
        .and_then(|value| i64::try_from(value).ok())
        .ok_or_else(backfill_corrupt)?;
    let page_start_sql = i64::try_from(page_start).map_err(|_| backfill_corrupt())?;
    let page_end_sql = i64::try_from(page_end).map_err(|_| backfill_corrupt())?;
    let mut statement = connection
        .prepare(
            "SELECT batch_row_id, source_kind, window_id, backfill_job_id,
                    ordinal, state, request_cipher, request_nonce, request_key_version,
                    request_sha256, byte_count, attempt_count, next_attempt_at,
                    accepted_at, terminal_code
             FROM outbox_batches
             WHERE backfill_job_id = ?1 AND ordinal >= ?2 AND ordinal < ?3
             ORDER BY ordinal ASC LIMIT ?4",
        )
        .map_err(|_| backfill_corrupt())?;
    let mut rows = statement
        .query(params![job.job_id(), page_start_sql, page_end_sql, limit])
        .map_err(|_| backfill_corrupt())?;
    let mut offset = 0_usize;
    while let Some(row) = rows.next().map_err(|_| backfill_corrupt())? {
        if offset >= window.batches.len() {
            return Err(backfill_corrupt());
        }
        let stored = verify_backfill_outbox_row(keyring, job, read_backfill_outbox_row(row)?)?;
        let expected_ordinal = page_start
            .checked_add(u64::try_from(offset).map_err(|_| backfill_corrupt())?)
            .ok_or_else(backfill_corrupt)?;
        let expected = &window.batches[offset];
        if stored.ordinal != expected_ordinal
            || stored.batch_row_id != expected.batch_id
            || stored.request.as_slice() != expected.exact_request_bytes()
        {
            return Err(backfill_conflict());
        }
        offset = offset.checked_add(1).ok_or_else(backfill_corrupt)?;
    }
    if offset != window.batches.len() {
        return Err(backfill_corrupt());
    }
    Ok(())
}

fn read_backfill_outbox_row(row: &Row<'_>) -> Result<StoredBackfillOutboxRow, SafeError> {
    Ok(StoredBackfillOutboxRow {
        batch_row_id: read_text(row, 0, MAX_LEDGER_ID_BYTES)?,
        source_kind: read_text(row, 1, BACKFILL_OUTBOX_SOURCE_KIND_MAX_BYTES)?,
        window_id: read_optional_text(row, 2, MAX_LEDGER_ID_BYTES)?,
        backfill_job_id: read_optional_text(row, 3, MAX_LEDGER_ID_BYTES)?,
        ordinal: read_integer(row, 4, 0, i64::from(u32::MAX))?,
        state: read_text(row, 5, BACKFILL_OUTBOX_STATE_MAX_BYTES)?,
        request_cipher: read_blob(
            row,
            6,
            AEAD_TAG_BYTES,
            BACKFILL_OUTBOX_REQUEST_MAX_CIPHERTEXT_BYTES,
        )?,
        request_nonce: read_blob(row, 7, BACKFILL_NONCE_BYTES, BACKFILL_NONCE_BYTES)?,
        request_key_version: read_integer(row, 8, 1, i64::from(u32::MAX))?,
        request_sha256: read_blob(row, 9, 32, 32)?,
        byte_count: read_integer(row, 10, 1, MAX_BATCH_CANONICAL_BYTES as i64)?,
        attempt_count: read_integer(row, 11, 0, BACKFILL_OUTBOX_ATTEMPT_COUNT_MAX)?,
        next_attempt_at: read_text(row, 12, BACKFILL_OUTBOX_TIMESTAMP_MAX_BYTES)?,
        accepted_at: read_optional_text(row, 13, BACKFILL_OUTBOX_TIMESTAMP_MAX_BYTES)?,
        terminal_code: read_optional_text(row, 14, BACKFILL_OUTBOX_TERMINAL_CODE_MAX_BYTES)?,
    })
}

fn verify_backfill_outbox_row(
    keyring: &crate::crypto::Keyring,
    job: &BackfillJob,
    row: StoredBackfillOutboxRow,
) -> Result<VerifiedBackfillOutboxRow, SafeError> {
    validate_batch_row_id(&row.batch_row_id)?;
    if row.source_kind != BACKFILL_KIND_OUTBOX
        || row.window_id.is_some()
        || row.backfill_job_id.as_deref() != Some(job.job_id())
    {
        return Err(backfill_corrupt());
    }
    let ordinal = u64::try_from(row.ordinal).map_err(|_| backfill_corrupt())?;
    if ordinal >= job.max_events() {
        return Err(backfill_corrupt());
    }
    let state = row.state.as_str();
    match state {
        "pending" if row.accepted_at.is_none() && row.terminal_code.is_none() => {}
        "accepted" if row.accepted_at.is_some() && row.terminal_code.is_none() => {}
        "quarantined" if row.accepted_at.is_none() && row.terminal_code.is_some() => {}
        _ => return Err(backfill_corrupt()),
    }
    validate_timestamp(&row.next_attempt_at)?;
    validate_optional_timestamp(row.accepted_at.as_deref())?;
    validate_terminal_code(row.terminal_code.as_deref())?;
    let next_attempt_at =
        parse_stored_timestamp(&row.next_attempt_at).map_err(|_| backfill_corrupt())?;
    let accepted_at = row
        .accepted_at
        .as_deref()
        .map(parse_stored_timestamp)
        .transpose()
        .map_err(|_| backfill_corrupt())?;

    let byte_count = usize::try_from(row.byte_count).map_err(|_| backfill_corrupt())?;
    let plaintext = open_outbox_value(
        keyring,
        row.batch_row_id.as_str(),
        &row.request_cipher,
        &row.request_nonce,
        row.request_key_version,
        byte_count,
    )?;
    if plaintext.len() != byte_count {
        return Err(backfill_corrupt());
    }
    let request =
        batch::reparse_and_verify_request(plaintext.as_bytes()).map_err(|_| backfill_corrupt())?;
    let request_sha256: [u8; 32] = row
        .request_sha256
        .as_slice()
        .try_into()
        .map_err(|_| backfill_corrupt())?;
    if Sha256::digest(plaintext.as_bytes()).as_slice() != request_sha256
        || request.batch_id != row.batch_row_id
        || request.source_checkpoint != expected_source_checkpoint(job, ordinal)?
    {
        return Err(backfill_corrupt());
    }
    validate_request_job_scope(job, &request).map_err(|_| backfill_corrupt())?;

    Ok(VerifiedBackfillOutboxRow {
        batch_row_id: row.batch_row_id,
        ordinal,
        request: Zeroizing::new(plaintext.as_bytes().to_vec()),
        request_sha256,
        byte_count,
        state: row.state,
        attempt_count: u32::try_from(row.attempt_count).map_err(|_| backfill_corrupt())?,
        next_attempt_at,
        next_attempt_at_text: row.next_attempt_at,
        accepted_at,
    })
}

fn validate_batch_row_id(value: &str) -> Result<(), SafeError> {
    if !valid_batch_row_id(value) {
        return Err(backfill_corrupt());
    }
    Ok(())
}

fn valid_batch_row_id(value: &str) -> bool {
    value.len() == BACKFILL_OUTBOX_BATCH_ID_PREFIX.len() + 64
        && value.starts_with(BACKFILL_OUTBOX_BATCH_ID_PREFIX)
        && value[BACKFILL_OUTBOX_BATCH_ID_PREFIX.len()..]
            .bytes()
            .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
}

fn persist_backfill_checkpoint(
    transaction: &rusqlite::Transaction<'_>,
    keyring: &crate::crypto::Keyring,
    row: &StoredBackfillRow,
    verified: &VerifiedBackfillRow,
    pagination: &[u8],
    accepted_events: i64,
) -> Result<(), SafeError> {
    let rotated_parameters = if row.key_version != i64::from(keyring.active_key_version()) {
        let encoded = encode_job_parameters(&verified.job, verified.parameters.as_slice())?;
        Some(
            keyring
                .seal(
                    "backfill_jobs",
                    row.job_id.as_str(),
                    BACKFILL_PARAMETERS_COLUMN,
                    encoded.as_slice(),
                )
                .map_err(|_| backfill_invalid())?,
        )
    } else {
        None
    };
    let sealed_pagination = keyring
        .seal(
            "backfill_jobs",
            row.job_id.as_str(),
            BACKFILL_PAGINATION_COLUMN,
            pagination,
        )
        .map_err(|_| backfill_invalid())?;
    let parameters_cipher = rotated_parameters
        .as_ref()
        .map_or(row.parameters_cipher.as_slice(), |value| {
            value.ciphertext.as_slice()
        });
    let parameters_nonce = rotated_parameters
        .as_ref()
        .map_or(row.parameters_nonce.as_slice(), |value| {
            value.nonce.as_slice()
        });
    let key_version = i64::from(keyring.active_key_version());
    let updated = transaction
        .execute(
            "UPDATE backfill_jobs
             SET parameters_cipher = ?1, parameters_nonce = ?2,
                 pagination_cipher = ?3, pagination_nonce = ?4,
                 key_version = ?5, accepted_events = ?6
             WHERE job_id = ?7 AND kind = 'explicit' AND live_window_id IS NULL
               AND state = 'running'",
            params![
                parameters_cipher,
                parameters_nonce,
                sealed_pagination.ciphertext.as_slice(),
                sealed_pagination.nonce.as_slice(),
                key_version,
                accepted_events,
                row.job_id.as_str(),
            ],
        )
        .map_err(|_| backfill_corrupt())?;
    if updated != 1 {
        return Err(backfill_corrupt());
    }
    Ok(())
}

fn verify_backfill_row(
    keyring: &crate::crypto::Keyring,
    row: &StoredBackfillRow,
) -> Result<VerifiedBackfillRow, SafeError> {
    if row.kind != BACKFILL_KIND_EXPLICIT || row.live_window_id.is_some() {
        return Err(backfill_corrupt());
    }
    validate_job_id(row.job_id.as_str()).map_err(|_| backfill_corrupt())?;
    let state = BackfillState::from_str(&row.state).map_err(|_| backfill_corrupt())?;
    validate_timestamp(row.created_at.as_str())?;
    validate_optional_timestamp(row.completed_at.as_deref())?;
    validate_optional_timestamp(row.cancelled_at.as_deref())?;
    validate_terminal_code(row.terminal_code.as_deref())?;
    validate_state_shape(
        state,
        row.completed_at.is_some(),
        row.cancelled_at.is_some(),
        row.terminal_code.is_some(),
    )?;
    let created_at = parse_stored_timestamp(&row.created_at).map_err(|_| backfill_corrupt())?;
    if let Some(completed_at) = row.completed_at.as_deref()
        && parse_stored_timestamp(completed_at).map_err(|_| backfill_corrupt())? < created_at
    {
        return Err(backfill_corrupt());
    }
    if let Some(cancelled_at) = row.cancelled_at.as_deref()
        && parse_stored_timestamp(cancelled_at).map_err(|_| backfill_corrupt())? < created_at
    {
        return Err(backfill_corrupt());
    }

    let accepted_events = u64::try_from(row.accepted_events).map_err(|_| backfill_corrupt())?;
    let parameters_plaintext = open_backfill_value(
        keyring,
        row.job_id.as_str(),
        BACKFILL_PARAMETERS_COLUMN,
        &row.parameters_cipher,
        &row.parameters_nonce,
        row.key_version,
        MAX_BACKFILL_JOB_ENVELOPE_BYTES,
    )?;
    let (job, parameters) =
        decode_job_parameters(row.job_id.as_str(), parameters_plaintext.as_bytes())?;
    if accepted_events > job.max_events() {
        return Err(backfill_corrupt());
    }

    let pagination = match (&row.pagination_cipher, &row.pagination_nonce) {
        (None, None) => None,
        (Some(cipher), Some(nonce)) => Some(Zeroizing::new(
            open_backfill_value(
                keyring,
                row.job_id.as_str(),
                BACKFILL_PAGINATION_COLUMN,
                cipher,
                nonce,
                row.key_version,
                MAX_BACKFILL_PAGINATION_BYTES,
            )?
            .as_bytes()
            .to_vec(),
        )),
        _ => return Err(backfill_corrupt()),
    };

    stored_pagination(pagination.as_deref().map(|value| &**value))?;

    if state == BackfillState::Pending && (accepted_events != 0 || pagination.is_some()) {
        return Err(backfill_corrupt());
    }

    Ok(VerifiedBackfillRow {
        job,
        state,
        parameters,
        pagination,
        accepted_events,
        created_at: row.created_at.clone(),
    })
}

fn encode_job_parameters(
    job: &BackfillJob,
    parameters: &[u8],
) -> Result<Zeroizing<Vec<u8>>, SafeError> {
    if parameters.is_empty() {
        return Err(backfill_invalid());
    }
    if parameters.len() > MAX_BACKFILL_PARAMETERS_BYTES {
        return Err(backfill_invalid());
    }
    let fields = [
        job.job_id().as_bytes(),
        job.room_id().as_bytes(),
        job.start_at().as_bytes(),
        job.end_at().as_bytes(),
    ];
    let fields_bytes = fields.iter().try_fold(0_usize, |total, field| {
        total
            .checked_add(field.len())
            .ok_or_else(backfill_too_large)
    })?;
    let total = BACKFILL_JOB_ENVELOPE_HEADER_BYTES
        .checked_add(fields_bytes)
        .and_then(|value| value.checked_add(parameters.len()))
        .ok_or_else(backfill_too_large)?;
    if total > MAX_BACKFILL_JOB_ENVELOPE_BYTES {
        return Err(backfill_too_large());
    }

    let mut encoded = Zeroizing::new(Vec::with_capacity(total));
    encoded.extend_from_slice(BACKFILL_JOB_ENVELOPE_MAGIC);
    for field in fields {
        let length = u32::try_from(field.len()).map_err(|_| backfill_too_large())?;
        encoded.extend_from_slice(&length.to_be_bytes());
    }
    encoded.extend_from_slice(&job.max_events().to_be_bytes());
    let parameters_length = u32::try_from(parameters.len()).map_err(|_| backfill_too_large())?;
    encoded.extend_from_slice(&parameters_length.to_be_bytes());
    for field in fields {
        encoded.extend_from_slice(field);
    }
    encoded.extend_from_slice(parameters);
    Ok(encoded)
}

fn decode_job_parameters(
    row_job_id: &str,
    plaintext: &[u8],
) -> Result<(BackfillJob, Zeroizing<Vec<u8>>), SafeError> {
    if plaintext.len() > MAX_BACKFILL_JOB_ENVELOPE_BYTES
        || plaintext.len() < BACKFILL_JOB_ENVELOPE_HEADER_BYTES
    {
        return Err(backfill_corrupt());
    }
    let mut cursor = 0_usize;
    let magic = take_bytes(plaintext, &mut cursor, BACKFILL_JOB_ENVELOPE_MAGIC.len())?;
    if magic != BACKFILL_JOB_ENVELOPE_MAGIC {
        return Err(backfill_corrupt());
    }

    let job_id_length = take_u32(plaintext, &mut cursor)? as usize;
    let room_id_length = take_u32(plaintext, &mut cursor)? as usize;
    let start_at_length = take_u32(plaintext, &mut cursor)? as usize;
    let end_at_length = take_u32(plaintext, &mut cursor)? as usize;
    let max_events = take_u64(plaintext, &mut cursor)?;
    let parameters_length = take_u32(plaintext, &mut cursor)? as usize;

    if job_id_length > MAX_LEDGER_ID_BYTES
        || room_id_length > BACKFILL_ROOM_ID_MAX_BYTES
        || start_at_length > BACKFILL_TIMESTAMP_MAX_BYTES
        || end_at_length > BACKFILL_TIMESTAMP_MAX_BYTES
        || parameters_length == 0
        || parameters_length > MAX_BACKFILL_PARAMETERS_BYTES
    {
        return Err(backfill_corrupt());
    }
    let job_id = str::from_utf8(take_bytes(plaintext, &mut cursor, job_id_length)?)
        .map_err(|_| backfill_corrupt())?;
    let room_id = str::from_utf8(take_bytes(plaintext, &mut cursor, room_id_length)?)
        .map_err(|_| backfill_corrupt())?;
    let start_at = str::from_utf8(take_bytes(plaintext, &mut cursor, start_at_length)?)
        .map_err(|_| backfill_corrupt())?;
    let end_at = str::from_utf8(take_bytes(plaintext, &mut cursor, end_at_length)?)
        .map_err(|_| backfill_corrupt())?;
    let parameters =
        Zeroizing::new(take_bytes(plaintext, &mut cursor, parameters_length)?.to_vec());
    if cursor != plaintext.len() || job_id != row_job_id {
        return Err(backfill_corrupt());
    }

    let job = BackfillJob::new(job_id, room_id, start_at, end_at, max_events)
        .map_err(|_| backfill_corrupt())?;
    Ok((job, parameters))
}

fn take_bytes<'a>(
    bytes: &'a [u8],
    cursor: &mut usize,
    length: usize,
) -> Result<&'a [u8], SafeError> {
    let end = cursor.checked_add(length).ok_or_else(backfill_corrupt)?;
    let value = bytes.get(*cursor..end).ok_or_else(backfill_corrupt)?;
    *cursor = end;
    Ok(value)
}

fn take_u32(bytes: &[u8], cursor: &mut usize) -> Result<u32, SafeError> {
    let value = take_bytes(bytes, cursor, 4)?;
    Ok(u32::from_be_bytes(
        value.try_into().map_err(|_| backfill_corrupt())?,
    ))
}

fn take_u64(bytes: &[u8], cursor: &mut usize) -> Result<u64, SafeError> {
    let value = take_bytes(bytes, cursor, 8)?;
    Ok(u64::from_be_bytes(
        value.try_into().map_err(|_| backfill_corrupt())?,
    ))
}

fn open_backfill_value(
    keyring: &crate::crypto::Keyring,
    job_id: &str,
    column: &str,
    ciphertext: &[u8],
    nonce: &[u8],
    key_version: i64,
    max_plaintext_bytes: usize,
) -> Result<crate::crypto::Plaintext, SafeError> {
    let max_ciphertext_bytes = max_plaintext_bytes
        .checked_add(AEAD_TAG_BYTES)
        .ok_or_else(backfill_corrupt)?;
    if !(AEAD_TAG_BYTES..=max_ciphertext_bytes).contains(&ciphertext.len())
        || nonce.len() != BACKFILL_NONCE_BYTES
    {
        return Err(backfill_corrupt());
    }
    let nonce: [u8; BACKFILL_NONCE_BYTES] = nonce.try_into().map_err(|_| backfill_corrupt())?;
    let key_version = u32::try_from(key_version)
        .ok()
        .filter(|version| *version != 0)
        .ok_or_else(backfill_corrupt)?;
    let plaintext = keyring
        .open(
            "backfill_jobs",
            job_id,
            column,
            &Sealed {
                nonce,
                ciphertext: ciphertext.to_vec(),
                key_version,
            },
        )
        .map_err(|_| backfill_corrupt())?;
    if plaintext.is_empty() || plaintext.len() > max_plaintext_bytes {
        return Err(backfill_corrupt());
    }
    Ok(plaintext)
}

fn open_outbox_value(
    keyring: &crate::crypto::Keyring,
    batch_row_id: &str,
    ciphertext: &[u8],
    nonce: &[u8],
    key_version: i64,
    max_plaintext_bytes: usize,
) -> Result<crate::crypto::Plaintext, SafeError> {
    let max_ciphertext_bytes = max_plaintext_bytes
        .checked_add(AEAD_TAG_BYTES)
        .ok_or_else(backfill_corrupt)?;
    if !(AEAD_TAG_BYTES..=max_ciphertext_bytes).contains(&ciphertext.len())
        || nonce.len() != BACKFILL_NONCE_BYTES
    {
        return Err(backfill_corrupt());
    }
    let nonce: [u8; BACKFILL_NONCE_BYTES] = nonce.try_into().map_err(|_| backfill_corrupt())?;
    let key_version = u32::try_from(key_version)
        .ok()
        .filter(|version| *version != 0)
        .ok_or_else(backfill_corrupt)?;
    let plaintext = keyring
        .open(
            "outbox_batches",
            batch_row_id,
            "request",
            &Sealed {
                nonce,
                ciphertext: ciphertext.to_vec(),
                key_version,
            },
        )
        .map_err(|_| backfill_corrupt())?;
    if plaintext.is_empty() || plaintext.len() > max_plaintext_bytes {
        return Err(backfill_corrupt());
    }
    Ok(plaintext)
}

fn validate_state_shape(
    state: BackfillState,
    has_completed_at: bool,
    has_cancelled_at: bool,
    has_terminal_code: bool,
) -> Result<(), SafeError> {
    let valid = match state {
        BackfillState::Pending | BackfillState::Running => {
            !has_completed_at && !has_cancelled_at && !has_terminal_code
        }
        BackfillState::Completed => has_completed_at && !has_cancelled_at && !has_terminal_code,
        BackfillState::Cancelled => !has_completed_at && has_cancelled_at && !has_terminal_code,
        BackfillState::Quarantined => !has_completed_at && !has_cancelled_at && has_terminal_code,
    };
    if valid {
        Ok(())
    } else {
        Err(backfill_corrupt())
    }
}

fn validate_job_id(value: &str) -> Result<(), SafeError> {
    if !(model::valid_resource_id(value) || valid_uuid_v7(value)) {
        return Err(backfill_invalid());
    }
    Ok(())
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

fn validate_timestamp(value: &str) -> Result<(), SafeError> {
    let Ok(timestamp) = DateTime::parse_from_rfc3339(value) else {
        return Err(backfill_corrupt());
    };
    if !model::valid_timestamp(value)
        || timestamp.offset().local_minus_utc() != 0
        || !timestamp.timestamp_subsec_nanos().is_multiple_of(1_000_000)
        || !value.is_ascii()
    {
        return Err(backfill_corrupt());
    }
    Ok(())
}

fn validate_optional_timestamp(value: Option<&str>) -> Result<(), SafeError> {
    if let Some(value) = value {
        validate_timestamp(value)?;
    }
    Ok(())
}

fn validate_terminal_code(value: Option<&str>) -> Result<(), SafeError> {
    if let Some(value) = value {
        crate::store_types::ReasonCode::new(value.to_owned()).map_err(|_| backfill_corrupt())?;
    }
    Ok(())
}

fn read_blob(
    row: &Row<'_>,
    index: usize,
    min_bytes: usize,
    max_bytes: usize,
) -> Result<Vec<u8>, SafeError> {
    match row.get_ref(index).map_err(|_| backfill_corrupt())? {
        ValueRef::Blob(bytes) if (min_bytes..=max_bytes).contains(&bytes.len()) => {
            Ok(bytes.to_vec())
        }
        _ => Err(backfill_corrupt()),
    }
}

fn read_optional_blob(
    row: &Row<'_>,
    index: usize,
    min_bytes: usize,
    max_bytes: usize,
) -> Result<Option<Vec<u8>>, SafeError> {
    match row.get_ref(index).map_err(|_| backfill_corrupt())? {
        ValueRef::Null => Ok(None),
        ValueRef::Blob(bytes) if (min_bytes..=max_bytes).contains(&bytes.len()) => {
            Ok(Some(bytes.to_vec()))
        }
        _ => Err(backfill_corrupt()),
    }
}

fn read_text(row: &Row<'_>, index: usize, max_bytes: usize) -> Result<String, SafeError> {
    match row.get_ref(index).map_err(|_| backfill_corrupt())? {
        ValueRef::Text(bytes) if bytes.len() <= max_bytes => str::from_utf8(bytes)
            .map(str::to_owned)
            .map_err(|_| backfill_corrupt()),
        _ => Err(backfill_corrupt()),
    }
}

fn read_optional_text(
    row: &Row<'_>,
    index: usize,
    max_bytes: usize,
) -> Result<Option<String>, SafeError> {
    match row.get_ref(index).map_err(|_| backfill_corrupt())? {
        ValueRef::Null => Ok(None),
        ValueRef::Text(bytes) if bytes.len() <= max_bytes => Ok(Some(
            str::from_utf8(bytes)
                .map_err(|_| backfill_corrupt())?
                .to_owned(),
        )),
        _ => Err(backfill_corrupt()),
    }
}

fn read_integer(
    row: &Row<'_>,
    index: usize,
    min_value: i64,
    max_value: i64,
) -> Result<i64, SafeError> {
    match row.get_ref(index).map_err(|_| backfill_corrupt())? {
        ValueRef::Integer(value) if (min_value..=max_value).contains(&value) => Ok(value),
        _ => Err(backfill_corrupt()),
    }
}

const fn backfill_invalid() -> SafeError {
    SafeError::new(STORE_BACKFILL_INVALID)
}

const fn backfill_too_large() -> SafeError {
    SafeError::new(crate::ledger::STORE_LEDGER_TOO_LARGE)
}

const fn backfill_conflict() -> SafeError {
    SafeError::new(STORE_BACKFILL_CONFLICT)
}

const fn backfill_not_ready() -> SafeError {
    SafeError::new(STORE_BACKFILL_NOT_READY)
}

const fn backfill_corrupt() -> SafeError {
    SafeError::new(STORE_BACKFILL_CORRUPT)
}
