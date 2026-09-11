//! Atomic live-window creation and preparation transactions.

use std::collections::HashSet;

use chrono::{DateTime, Utc};
use rusqlite::{Row, Transaction, params, types::ValueRef};
use zeroize::Zeroizing;

use crate::{
    batch::{self, BatchWindow},
    canonical::{self, CanonicalBatchInput, SourceCheckpoint},
    config::MAX_BATCH_CANONICAL_BYTES,
    crypto::AEAD_TAG_BYTES,
    ingestion::PendingBatch,
    ledger::{
        BackfillState, FinalizeOutcome, LiveCommitOutcome, MAX_BACKFILL_PAGINATION_BYTES,
        MAX_BACKFILL_PARAMETERS_BYTES, MAX_LEDGER_ID_BYTES, MAX_WINDOW_BATCHES,
        MAX_WINDOW_ROOM_CANDIDATES, NewLiveGapJob, NewLiveWindow, PendingIngestionBatch,
        RoomAnchorCandidate, RoomEphemeralCandidate, STORE_LEDGER_CAS_MISMATCH,
        STORE_LEDGER_CONFLICT, STORE_LEDGER_CORRUPT, STORE_LEDGER_INVALID, STORE_LEDGER_NOT_READY,
        STORE_LEDGER_TOO_LARGE, StoredLiveGapJob,
    },
    secret::{SafeError, SecretBytes},
    store_types::{InboxId, MAX_BOOTSTRAP_ROOM_ANCHORS, ReasonCode, SyncInboxState},
};

use super::{
    Store, StoredValue, load_crypto_context, lowercase_hex, open_stored_value,
    parse_stored_timestamp, room_progress_row_id, valid_stored_inbox_id, valid_stored_reason_code,
    valid_stored_utc_millisecond, valid_utc_millisecond,
};

const LIVE_WINDOW_ID_DOMAIN: &str = "matrix-live-window-v1";
const WINDOW_STATE_MAX_BYTES: usize = "quarantined".len();
const OUTBOX_STATE_MAX_BYTES: usize = "quarantined".len();
const SOURCE_KIND_MAX_BYTES: usize = "backfill".len();
const OUTBOX_ATTEMPT_COUNT_MAX: i64 = 1_000_000;

struct WindowValidation {
    archived_at: DateTime<Utc>,
    ignored_count: u64,
    batch_count: u32,
}

struct StoredLiveWindow {
    window_id: String,
    inbox_id: String,
    state: String,
    batch_count: i64,
    accepted_count: i64,
    ignored_count: i64,
    created_at: String,
    committed_at: Option<String>,
    terminal_code: Option<String>,
}

struct StoredOutboxBatch {
    batch_row_id: String,
    ordinal: i64,
    state: String,
    request: SecretBytes,
    request_sha256: [u8; 32],
    byte_count: usize,
    attempt_count: u32,
    next_attempt_at: DateTime<Utc>,
    next_attempt_at_text: String,
    accepted_at: Option<DateTime<Utc>>,
    terminal_code: Option<String>,
}

struct StoredAnchor {
    room_lookup: [u8; 32],
    value: SecretBytes,
}

struct StoredEphemeral {
    room_lookup: [u8; 32],
    value: SecretBytes,
    typing_expires_at: DateTime<Utc>,
}

struct StoredBackfillJob {
    job_id: String,
    kind: String,
    live_window_id: Option<String>,
    state: BackfillState,
    parameters: SecretBytes,
    accepted_events: u64,
    created_at: String,
}

impl Store {
    /// Create one protected live-gap job for the oldest collecting window.
    pub fn create_live_gap_job(&mut self, job: NewLiveGapJob) -> Result<(), SafeError> {
        job.validate()?;
        let created_at = job.created_at().to_rfc3339();
        let keyring = &self.keyring;
        let transaction = self
            .connection
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(|_| ledger_corrupt())?;

        let context = load_live_context(&transaction, keyring)?;
        let existing_job = load_backfill_job(&transaction, keyring, job.job_id())?;
        if let Some(existing_job) = existing_job.as_ref() {
            if existing_job.kind != "live_gap"
                || existing_job.live_window_id.as_deref() != Some(job.live_window_id())
                || existing_job.created_at != created_at
                || existing_job.parameters.as_bytes() != job.parameters().as_bytes()
            {
                return Err(ledger_conflict());
            }
            validate_live_gap_target(&context, &transaction, keyring, job.live_window_id(), false)?;
            drop(transaction);
            return Ok(());
        }

        validate_live_gap_target(&context, &transaction, keyring, job.live_window_id(), false)?;
        let sealed = keyring
            .seal(
                "backfill_jobs",
                job.job_id(),
                "parameters",
                job.parameters().as_bytes(),
            )
            .map_err(|_| ledger_corrupt())?;
        let inserted = transaction
            .execute(
                "INSERT INTO backfill_jobs
                 (job_id, kind, live_window_id, state, parameters_cipher, parameters_nonce,
                  pagination_cipher, pagination_nonce, key_version, accepted_events, created_at,
                  completed_at, cancelled_at, terminal_code)
                 VALUES (?1, 'live_gap', ?2, 'pending', ?3, ?4, NULL, NULL, ?5, 0, ?6,
                         NULL, NULL, NULL)",
                params![
                    job.job_id(),
                    job.live_window_id(),
                    sealed.ciphertext.as_slice(),
                    sealed.nonce.as_slice(),
                    i64::from(sealed.key_version),
                    created_at,
                ],
            )
            .map_err(|_| ledger_corrupt())?;
        if inserted != 1 {
            return Err(ledger_corrupt());
        }
        transaction.commit().map_err(|_| ledger_corrupt())?;
        Ok(())
    }

    /// Claim a pending live-gap job or return a validated running job.
    pub fn begin_or_resume_live_gap_job(
        &mut self,
        job_id: &str,
    ) -> Result<StoredLiveGapJob, SafeError> {
        if !valid_job_id(job_id) {
            return Err(ledger_invalid());
        }
        let keyring = &self.keyring;
        let transaction = self
            .connection
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(|_| ledger_corrupt())?;
        let job = load_backfill_job(&transaction, keyring, job_id)?.ok_or_else(ledger_not_ready)?;
        if job.kind != "live_gap" {
            return Err(ledger_not_ready());
        }
        let live_window_id = job.live_window_id.as_deref().ok_or_else(ledger_corrupt)?;
        let context = load_live_context(&transaction, keyring)?;
        validate_live_gap_target(&context, &transaction, keyring, live_window_id, true)?;

        let state = match job.state {
            BackfillState::Pending => {
                let updated = transaction
                    .execute(
                        "UPDATE backfill_jobs SET state = 'running'
                         WHERE job_id = ?1 AND kind = 'live_gap' AND state = 'pending'",
                        [job_id],
                    )
                    .map_err(|_| ledger_corrupt())?;
                if updated != 1 {
                    return Err(ledger_corrupt());
                }
                BackfillState::Running
            }
            BackfillState::Running => BackfillState::Running,
            BackfillState::Completed | BackfillState::Cancelled | BackfillState::Quarantined => {
                return Err(ledger_not_ready());
            }
        };
        let result = StoredLiveGapJob::from_verified_parts(
            job.job_id,
            live_window_id.to_owned(),
            state,
            Zeroizing::new(job.parameters.as_bytes().to_vec()).to_vec(),
            job.accepted_events,
        )
        .map_err(|_| ledger_corrupt())?;
        transaction.commit().map_err(|_| ledger_corrupt())?;
        Ok(result)
    }

    /// Create the deterministic collecting window for the oldest drained SDK row.
    pub fn create_collecting_live_window(
        &mut self,
        inbox_id: &str,
        window: NewLiveWindow,
    ) -> Result<(), SafeError> {
        let inbox_id = validate_inbox_id(inbox_id)?;
        window.validate()?;
        let expected_window_id = derive_window_id(&self.keyring, inbox_id.as_str())?;
        if window.window_id() != expected_window_id {
            return Err(ledger_invalid());
        }
        let created_at = window.created_at().to_rfc3339();
        if !valid_utc_millisecond(*window.created_at()) {
            return Err(ledger_invalid());
        }
        let ignored_count = i64::try_from(window.ignored_count()).map_err(|_| ledger_invalid())?;

        let keyring = &self.keyring;
        let transaction = self
            .connection
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(|_| ledger_corrupt())?;

        let context = load_live_context(&transaction, keyring)?;
        let existing = load_existing_window(&transaction, &expected_window_id, inbox_id.as_str())?;
        if let Some(existing) = existing {
            validate_existing_window_identity(&existing, &expected_window_id, inbox_id.as_str())?;
            validate_window_children(&transaction, keyring, &existing)?;
            if existing.created_at != created_at || existing.ignored_count != ignored_count {
                return Err(ledger_conflict());
            }
            validate_window_inbox_link(&context, &existing)?;
            drop(transaction);
            return Ok(());
        }

        let target = oldest_target(&context, &inbox_id)?;
        if target.state() != SyncInboxState::SdkProcessed || !target.crypto_drained() {
            return Err(ledger_not_ready());
        }
        if *target.observed_at() > *window.created_at() {
            return Err(ledger_invalid());
        }

        let inserted = transaction
            .execute(
                "INSERT INTO sync_windows
                 (window_id, inbox_id, state, batch_count, accepted_count, ignored_count,
                  created_at, committed_at, terminal_code)
                 VALUES (?1, ?2, 'collecting', 0, 0, ?3, ?4, NULL, NULL)",
                params![
                    expected_window_id,
                    inbox_id.as_str(),
                    ignored_count,
                    created_at,
                ],
            )
            .map_err(|_| ledger_corrupt())?;
        if inserted != 1 {
            return Err(ledger_corrupt());
        }
        transaction.commit().map_err(|_| ledger_corrupt())?;
        Ok(())
    }

    /// Atomically persist exact live outbox rows and staged room state.
    pub fn finalize_live_window(
        &mut self,
        inbox_id: &str,
        window_id: &str,
        window: &BatchWindow,
        anchors: &[RoomAnchorCandidate],
        ephemeral: &[RoomEphemeralCandidate],
    ) -> Result<FinalizeOutcome, SafeError> {
        let inbox_id = validate_inbox_id(inbox_id)?;
        validate_window_id(window_id)?;
        let expected_window_id = derive_window_id(&self.keyring, inbox_id.as_str())?;
        if window_id != expected_window_id {
            return Err(ledger_invalid());
        }
        let window_validation = validate_batch_window(window)?;
        validate_candidates(anchors, ephemeral)?;
        if !valid_utc_millisecond(window_validation.archived_at) {
            return Err(ledger_invalid());
        }

        let keyring = &self.keyring;
        let transaction = self
            .connection
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(|_| ledger_corrupt())?;

        let context = load_live_context(&transaction, keyring)?;
        let existing = load_existing_window(&transaction, window_id, inbox_id.as_str())?
            .ok_or_else(ledger_not_ready)?;
        validate_existing_window_identity(&existing, window_id, inbox_id.as_str())?;
        validate_window_inbox_link(&context, &existing)?;

        let outbox = load_outbox_batches(&transaction, keyring, window_id)?;
        let staged_anchors = load_staged_anchors(&transaction, keyring, window_id)?;
        let staged_ephemeral = load_staged_ephemeral(&transaction, keyring, window_id)?;
        validate_window_children_against_metadata(
            &existing,
            &outbox,
            &staged_anchors,
            &staged_ephemeral,
        )?;

        if existing.ignored_count
            != i64::try_from(window_validation.ignored_count).unwrap_or(i64::MAX)
            || existing.state == "quarantined"
        {
            return if existing.ignored_count
                != i64::try_from(window_validation.ignored_count).unwrap_or(i64::MAX)
            {
                Err(ledger_conflict())
            } else {
                Err(ledger_not_ready())
            };
        }

        match existing.state.as_str() {
            "pending" | "committed" => {
                if !same_prepared_input(
                    &existing,
                    &outbox,
                    &staged_anchors,
                    &staged_ephemeral,
                    window,
                    anchors,
                    ephemeral,
                )? {
                    return Err(ledger_conflict());
                }
                drop(transaction);
                return Ok(FinalizeOutcome::AlreadyPrepared {
                    batch_count: window_validation.batch_count,
                });
            }
            "collecting" => {}
            _ => return Err(ledger_corrupt()),
        }

        let target = oldest_target(&context, &inbox_id)?;
        if target.state() != SyncInboxState::SdkProcessed || !target.crypto_drained() {
            return Err(ledger_not_ready());
        }
        if *target.observed_at() > window_validation.archived_at {
            return Err(ledger_invalid());
        }
        let created_at =
            parse_stored_timestamp(&existing.created_at).map_err(|_| ledger_corrupt())?;
        if created_at > window_validation.archived_at {
            return Err(ledger_invalid());
        }
        let expected_checkpoint = SourceCheckpoint {
            kind: "matrix_sync_token_sha256".to_owned(),
            value: format!("sha256:{}", lowercase_hex(target.next_token_digest())),
        };
        if window.source_checkpoint != expected_checkpoint {
            return Err(ledger_not_ready());
        }

        let mut sealed_batches = Vec::with_capacity(window.batches.len());
        for batch in &window.batches {
            let sealed = keyring
                .seal(
                    "outbox_batches",
                    &batch.batch_id,
                    "request",
                    batch.exact_request_bytes(),
                )
                .map_err(|_| ledger_corrupt())?;
            sealed_batches.push(sealed);
        }
        let mut sealed_anchors = Vec::with_capacity(anchors.len());
        for candidate in anchors {
            let row_id = candidate_row_id(window_id, candidate.room_lookup());
            let sealed = keyring
                .seal(
                    "window_room_anchors",
                    &row_id,
                    "anchor_event",
                    candidate.anchor_event().as_bytes(),
                )
                .map_err(|_| ledger_corrupt())?;
            sealed_anchors.push((candidate, row_id, sealed));
        }
        let mut sealed_ephemeral = Vec::with_capacity(ephemeral.len());
        for candidate in ephemeral {
            let row_id = candidate_row_id(window_id, candidate.room_lookup());
            let sealed = keyring
                .seal(
                    "window_room_ephemeral",
                    &row_id,
                    "typing_set",
                    candidate.typing_set().as_bytes(),
                )
                .map_err(|_| ledger_corrupt())?;
            sealed_ephemeral.push((candidate, row_id, sealed));
        }

        for (ordinal, (batch, sealed)) in window.batches.iter().zip(sealed_batches).enumerate() {
            let inserted = transaction
                .execute(
                    "INSERT INTO outbox_batches
                     (batch_row_id, source_kind, window_id, backfill_job_id, ordinal, state,
                      request_cipher, request_nonce, request_key_version, request_sha256,
                      byte_count, attempt_count, next_attempt_at, accepted_at, terminal_code)
                     VALUES (?1, 'live', ?2, NULL, ?3, 'pending', ?4, ?5, ?6, ?7, ?8,
                             0, ?9, NULL, NULL)",
                    params![
                        batch.batch_id.as_str(),
                        window_id,
                        i64::try_from(ordinal).map_err(|_| ledger_corrupt())?,
                        sealed.ciphertext.as_slice(),
                        sealed.nonce.as_slice(),
                        i64::from(sealed.key_version),
                        batch_digest(batch.exact_request_bytes()).as_slice(),
                        i64::try_from(batch.exact_request_bytes().len())
                            .map_err(|_| ledger_too_large())?,
                        window.archived_at.as_str(),
                    ],
                )
                .map_err(|_| ledger_corrupt())?;
            if inserted != 1 {
                return Err(ledger_corrupt());
            }
        }

        for (candidate, _row_id, sealed) in sealed_anchors {
            let inserted = transaction
                .execute(
                    "INSERT INTO window_room_anchors
                     (window_id, room_lookup, anchor_event_cipher, anchor_event_nonce, key_version)
                     VALUES (?1, ?2, ?3, ?4, ?5)",
                    params![
                        window_id,
                        candidate.room_lookup(),
                        sealed.ciphertext.as_slice(),
                        sealed.nonce.as_slice(),
                        i64::from(sealed.key_version),
                    ],
                )
                .map_err(|_| ledger_corrupt())?;
            if inserted != 1 {
                return Err(ledger_corrupt());
            }
        }
        for (candidate, _row_id, sealed) in sealed_ephemeral {
            let inserted = transaction
                .execute(
                    "INSERT INTO window_room_ephemeral
                     (window_id, room_lookup, typing_set_cipher, typing_set_nonce, key_version,
                      typing_expires_at)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                    params![
                        window_id,
                        candidate.room_lookup(),
                        sealed.ciphertext.as_slice(),
                        sealed.nonce.as_slice(),
                        i64::from(sealed.key_version),
                        candidate.typing_expires_at().to_rfc3339(),
                    ],
                )
                .map_err(|_| ledger_corrupt())?;
            if inserted != 1 {
                return Err(ledger_corrupt());
            }
        }

        let updated_window = transaction
            .execute(
                "UPDATE sync_windows
                 SET state = 'pending', batch_count = ?1, accepted_count = 0,
                     committed_at = NULL, terminal_code = NULL
                 WHERE window_id = ?2 AND inbox_id = ?3 AND state = 'collecting'
                   AND batch_count = 0 AND accepted_count = 0
                   AND committed_at IS NULL AND terminal_code IS NULL
                   AND ignored_count = ?4",
                params![
                    i64::from(window_validation.batch_count),
                    window_id,
                    inbox_id.as_str(),
                    i64::try_from(window_validation.ignored_count).map_err(|_| ledger_invalid())?,
                ],
            )
            .map_err(|_| ledger_corrupt())?;
        if updated_window != 1 {
            return Err(ledger_corrupt());
        }
        let updated_inbox = transaction
            .execute(
                "UPDATE sync_inbox
                 SET state = 'prepared', prepared_at = ?1
                 WHERE inbox_id = ?2 AND state = 'sdk_processed' AND crypto_drained = 1
                   AND sdk_processed_at IS NOT NULL AND prepared_at IS NULL
                   AND committed_at IS NULL AND terminal_code IS NULL",
                params![window.archived_at.as_str(), inbox_id.as_str()],
            )
            .map_err(|_| ledger_corrupt())?;
        if updated_inbox != 1 {
            return Err(ledger_corrupt());
        }
        transaction.commit().map_err(|_| ledger_corrupt())?;
        Ok(FinalizeOutcome::Prepared {
            batch_count: window_validation.batch_count,
        })
    }

    /// Return one authenticated, due batch from the oldest pending live window.
    pub fn next_pending_ingestion_batch(
        &self,
        now: DateTime<Utc>,
    ) -> Result<Option<PendingIngestionBatch>, SafeError> {
        if !valid_utc_millisecond(now) {
            return Err(ledger_invalid());
        }

        let transaction = self
            .connection
            .unchecked_transaction()
            .map_err(|_| ledger_corrupt())?;
        let context = load_live_context(&transaction, &self.keyring)?;
        let Some(index) = context.chain.first_uncommitted_index else {
            return Ok(None);
        };
        let oldest = &context.chain.rows[index];
        let expected_window_id = derive_window_id(&self.keyring, oldest.inbox_id().as_str())
            .map_err(|_| ledger_corrupt())?;
        let Some(window) = load_existing_window(
            &transaction,
            &expected_window_id,
            oldest.inbox_id().as_str(),
        )?
        else {
            return Ok(None);
        };
        if window.window_id != expected_window_id || window.inbox_id != oldest.inbox_id().as_str() {
            return Err(ledger_corrupt());
        }
        validate_window_inbox_link(&context, &window)?;

        let outbox = load_outbox_batches(&transaction, &self.keyring, &window.window_id)?;
        let staged_anchors = load_staged_anchors(&transaction, &self.keyring, &window.window_id)?;
        let staged_ephemeral =
            load_staged_ephemeral(&transaction, &self.keyring, &window.window_id)?;
        validate_window_children_against_metadata(
            &window,
            &outbox,
            &staged_anchors,
            &staged_ephemeral,
        )?;
        validate_live_window_metadata(&window, &outbox, oldest)?;

        if window.state != "pending" {
            return Ok(None);
        }

        for stored in outbox {
            if stored.state != "pending" || stored.next_attempt_at > now {
                continue;
            }
            let request = batch::reparse_and_verify_request(stored.request.as_bytes())
                .map_err(|_| ledger_corrupt())?;
            let batch = PendingBatch::new(
                request.tenant_id,
                stored.batch_row_id.clone(),
                stored.request.as_bytes().to_vec(),
            );
            return PendingIngestionBatch::from_verified_parts(
                stored.batch_row_id,
                batch,
                stored.attempt_count,
                stored.next_attempt_at,
            )
            .map(Some)
            .map_err(|_| ledger_corrupt());
        }
        Ok(None)
    }

    /// Record one delivery attempt with a single state-qualified CAS update.
    pub fn record_ingestion_attempt(
        &mut self,
        row_id: &str,
        expected_attempt_count: u32,
        expected_next_attempt_at: DateTime<Utc>,
        attempted_at: DateTime<Utc>,
        next_attempt_at: DateTime<Utc>,
    ) -> Result<(), SafeError> {
        if !valid_batch_id(row_id)
            || expected_attempt_count > OUTBOX_ATTEMPT_COUNT_MAX as u32
            || !valid_utc_millisecond(expected_next_attempt_at)
            || !valid_utc_millisecond(attempted_at)
            || !valid_utc_millisecond(next_attempt_at)
            || attempted_at < expected_next_attempt_at
            || next_attempt_at <= attempted_at
        {
            return Err(ledger_invalid());
        }

        let transaction = self
            .connection
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(|_| ledger_corrupt())?;
        let context = load_live_context(&transaction, &self.keyring)?;
        let Some(addressed) = load_outbox_batch_by_id(&transaction, &self.keyring, row_id)? else {
            return Err(ledger_cas_mismatch());
        };
        let Some(window_id) = outbox_window_id(&transaction, row_id)? else {
            return Err(ledger_cas_mismatch());
        };
        let window = load_window_by_id(&transaction, &window_id)?.ok_or_else(ledger_corrupt)?;
        let inbox_id = validate_inbox_id(&window.inbox_id).map_err(|_| ledger_corrupt())?;
        let expected_window_id =
            derive_window_id(&self.keyring, inbox_id.as_str()).map_err(|_| ledger_corrupt())?;
        if window.window_id != expected_window_id {
            return Err(ledger_corrupt());
        }
        validate_window_inbox_link(&context, &window)?;

        if window.state != "pending" || addressed.state != "pending" {
            return Err(ledger_cas_mismatch());
        }
        let Some(oldest_index) = context.chain.first_uncommitted_index else {
            return Err(ledger_cas_mismatch());
        };
        let oldest = &context.chain.rows[oldest_index];
        if oldest.inbox_id().as_str() != window.inbox_id {
            return Err(ledger_cas_mismatch());
        }

        let outbox = load_outbox_batches(&transaction, &self.keyring, &window.window_id)?;
        let staged_anchors = load_staged_anchors(&transaction, &self.keyring, &window.window_id)?;
        let staged_ephemeral =
            load_staged_ephemeral(&transaction, &self.keyring, &window.window_id)?;
        validate_window_children_against_metadata(
            &window,
            &outbox,
            &staged_anchors,
            &staged_ephemeral,
        )?;
        validate_live_window_metadata(&window, &outbox, oldest)?;
        let Some(current) = outbox.iter().find(|row| row.batch_row_id == row_id) else {
            return Err(ledger_corrupt());
        };
        if current.attempt_count != expected_attempt_count
            || current.next_attempt_at != expected_next_attempt_at
            || current.attempt_count >= OUTBOX_ATTEMPT_COUNT_MAX as u32
        {
            return Err(ledger_cas_mismatch());
        }

        let updated = transaction
            .execute(
                "UPDATE outbox_batches
                 SET attempt_count = attempt_count + 1, next_attempt_at = ?1
                 WHERE batch_row_id = ?2 AND source_kind = 'live'
                   AND window_id = ?3 AND backfill_job_id IS NULL
                   AND state = 'pending' AND attempt_count = ?4
                   AND next_attempt_at = ?5 AND attempt_count < ?6
                   AND EXISTS (
                     SELECT 1 FROM sync_windows AS w
                     WHERE w.window_id = outbox_batches.window_id
                       AND w.state = 'pending'
                   )",
                params![
                    next_attempt_at.to_rfc3339(),
                    row_id,
                    window.window_id,
                    i64::from(expected_attempt_count),
                    current.next_attempt_at_text.as_str(),
                    OUTBOX_ATTEMPT_COUNT_MAX,
                ],
            )
            .map_err(|_| ledger_corrupt())?;
        if updated != 1 {
            return Err(ledger_cas_mismatch());
        }
        transaction.commit().map_err(|_| ledger_corrupt())?;
        Ok(())
    }

    /// Terminally quarantine one pending live ingestion row and its owner.
    pub fn quarantine_live_batch(
        &mut self,
        row_id: &str,
        terminal_code: ReasonCode,
    ) -> Result<(), SafeError> {
        if !valid_batch_id(row_id) || !valid_stored_reason_code(terminal_code.as_str()) {
            return Err(ledger_invalid());
        }

        let keyring = &self.keyring;
        let transaction = self
            .connection
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(|_| ledger_corrupt())?;
        let addressed =
            load_outbox_batch_by_id(&transaction, keyring, row_id)?.ok_or_else(ledger_not_ready)?;
        let window_id = outbox_window_id(&transaction, row_id)?.ok_or_else(ledger_not_ready)?;
        let window = load_window_by_id(&transaction, &window_id)?.ok_or_else(ledger_not_ready)?;
        let inbox_id = validate_inbox_id(&window.inbox_id).map_err(|_| ledger_corrupt())?;
        let expected_window_id =
            derive_window_id(keyring, inbox_id.as_str()).map_err(|_| ledger_corrupt())?;
        if window.window_id != expected_window_id || window.window_id != window_id {
            return Err(ledger_corrupt());
        }

        let temporarily_prepared = if window.state == "quarantined" {
            temporarily_prepare_quarantined_inboxes(&transaction)?
        } else {
            Vec::new()
        };
        let quarantined_inbox_code = temporarily_prepared
            .iter()
            .find(|(candidate, _)| candidate == inbox_id.as_str())
            .map(|(_, code)| code.clone());
        let context = load_live_context(&transaction, keyring)?;
        let inbox = context
            .chain
            .rows
            .iter()
            .find(|row| row.inbox_id().as_str() == inbox_id.as_str())
            .ok_or_else(ledger_corrupt)?;
        if window.state == "quarantined" {
            let inbox_code = quarantined_inbox_code
                .as_deref()
                .ok_or_else(ledger_corrupt)?;
            validate_quarantined_window_inbox_link(&window, inbox, inbox_code)?;
        } else {
            validate_window_inbox_link(&context, &window)?;
        }

        let outbox = load_outbox_batches(&transaction, keyring, &window_id)?;
        let staged_anchors = load_staged_anchors(&transaction, keyring, &window_id)?;
        let staged_ephemeral = load_staged_ephemeral(&transaction, keyring, &window_id)?;
        validate_window_children_against_metadata(
            &window,
            &outbox,
            &staged_anchors,
            &staged_ephemeral,
        )?;
        validate_live_window_metadata(&window, &outbox, inbox)?;
        validate_accepted_timestamps(&outbox, inbox)?;
        let current = outbox
            .iter()
            .find(|candidate| candidate.batch_row_id == row_id)
            .ok_or_else(ledger_corrupt)?;

        match window.state.as_str() {
            "pending" => {
                let oldest = oldest_target(&context, &inbox_id)?;
                validate_pending_live_target(&context, oldest)?;
                if addressed.state != "pending" || current.state != "pending" {
                    return Err(ledger_not_ready());
                }

                let updated_outbox = transaction
                    .execute(
                        "UPDATE outbox_batches
                         SET state = 'quarantined', terminal_code = ?1
                         WHERE batch_row_id = ?2 AND source_kind = 'live'
                           AND window_id = ?3 AND backfill_job_id IS NULL
                           AND state = 'pending' AND accepted_at IS NULL
                           AND terminal_code IS NULL",
                        params![terminal_code.as_str(), row_id, window_id],
                    )
                    .map_err(|_| ledger_corrupt())?;
                if updated_outbox != 1 {
                    return Err(ledger_corrupt());
                }
                let updated_window = transaction
                    .execute(
                        "UPDATE sync_windows
                         SET state = 'quarantined', terminal_code = ?1
                         WHERE window_id = ?2 AND inbox_id = ?3 AND state = 'pending'
                           AND batch_count = ?4 AND accepted_count = ?5
                           AND committed_at IS NULL AND terminal_code IS NULL",
                        params![
                            terminal_code.as_str(),
                            window_id,
                            inbox_id.as_str(),
                            window.batch_count,
                            window.accepted_count,
                        ],
                    )
                    .map_err(|_| ledger_corrupt())?;
                if updated_window != 1 {
                    return Err(ledger_corrupt());
                }
                let updated_inbox = transaction
                    .execute(
                        "UPDATE sync_inbox
                         SET state = 'quarantined', terminal_code = ?1
                         WHERE inbox_id = ?2 AND state = 'prepared' AND crypto_drained = 1
                           AND sdk_processed_at IS NOT NULL AND prepared_at IS NOT NULL
                           AND committed_at IS NULL AND terminal_code IS NULL",
                        params![terminal_code.as_str(), inbox_id.as_str()],
                    )
                    .map_err(|_| ledger_corrupt())?;
                if updated_inbox != 1 {
                    return Err(ledger_corrupt());
                }
                transaction.commit().map_err(|_| ledger_corrupt())?;
                Ok(())
            }
            "quarantined" => {
                let oldest = oldest_target(&context, &inbox_id)?;
                validate_pending_live_target(&context, oldest)?;
                validate_quarantined_live_children(&window, &outbox)?;
                if addressed.state != "quarantined" || current.state != "quarantined" {
                    return Err(ledger_not_ready());
                }
                let stored_code = current
                    .terminal_code
                    .as_deref()
                    .ok_or_else(ledger_corrupt)?;
                if terminal_code.as_str() != stored_code {
                    return Err(ledger_conflict());
                }
                drop(transaction);
                Ok(())
            }
            "collecting" | "committed" => Err(ledger_not_ready()),
            _ => Err(ledger_corrupt()),
        }
    }

    /// Atomically reopen one quarantined live window for delivery retry.
    pub fn retry_quarantined_window(
        &mut self,
        window_id: &str,
        retry_at: DateTime<Utc>,
    ) -> Result<(), SafeError> {
        if !valid_window_id(window_id) || !valid_utc_millisecond(retry_at) {
            return Err(ledger_invalid());
        }

        let keyring = &self.keyring;
        let transaction = self
            .connection
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(|_| ledger_corrupt())?;
        let window = load_window_by_id(&transaction, window_id)?.ok_or_else(ledger_not_ready)?;
        let inbox_id = validate_inbox_id(&window.inbox_id).map_err(|_| ledger_corrupt())?;
        let expected_window_id =
            derive_window_id(keyring, inbox_id.as_str()).map_err(|_| ledger_corrupt())?;
        if window.window_id != expected_window_id || window.window_id != window_id {
            return Err(ledger_corrupt());
        }

        let temporarily_prepared = if window.state == "quarantined" {
            temporarily_prepare_quarantined_inboxes(&transaction)?
        } else {
            Vec::new()
        };
        let quarantined_inbox_code = temporarily_prepared
            .iter()
            .find(|(candidate, _)| candidate == inbox_id.as_str())
            .map(|(_, code)| code.clone());
        let context = load_live_context(&transaction, keyring)?;
        let inbox = context
            .chain
            .rows
            .iter()
            .find(|row| row.inbox_id().as_str() == inbox_id.as_str())
            .ok_or_else(ledger_corrupt)?;
        if window.state == "quarantined" {
            let inbox_code = quarantined_inbox_code
                .as_deref()
                .ok_or_else(ledger_corrupt)?;
            validate_quarantined_window_inbox_link(&window, inbox, inbox_code)?;
        } else {
            validate_window_inbox_link(&context, &window)?;
        }

        let outbox = load_outbox_batches(&transaction, keyring, window_id)?;
        let staged_anchors = load_staged_anchors(&transaction, keyring, window_id)?;
        let staged_ephemeral = load_staged_ephemeral(&transaction, keyring, window_id)?;
        validate_window_children_against_metadata(
            &window,
            &outbox,
            &staged_anchors,
            &staged_ephemeral,
        )?;
        validate_live_window_metadata(&window, &outbox, inbox)?;
        validate_accepted_timestamps(&outbox, inbox)?;

        if window.state != "quarantined" {
            return Err(ledger_not_ready());
        }
        let code = window.terminal_code.as_deref().ok_or_else(ledger_corrupt)?;
        if quarantined_inbox_code.as_deref() != Some(code) {
            return Err(ledger_corrupt());
        }
        let quarantined_count = validate_quarantined_live_children(&window, &outbox)?;
        let oldest = oldest_target(&context, &inbox_id)?;
        validate_pending_live_target(&context, oldest)?;

        restore_quarantined_inboxes(&transaction, &temporarily_prepared)?;

        let updated_outbox = transaction
            .execute(
                "UPDATE outbox_batches
                 SET state = 'pending', next_attempt_at = ?1, terminal_code = NULL
                 WHERE source_kind = 'live' AND window_id = ?2
                   AND backfill_job_id IS NULL AND state = 'quarantined'
                   AND accepted_at IS NULL AND terminal_code = ?3",
                params![retry_at.to_rfc3339(), window_id, code],
            )
            .map_err(|_| ledger_corrupt())?;
        if updated_outbox != quarantined_count {
            return Err(ledger_corrupt());
        }
        let updated_window = transaction
            .execute(
                "UPDATE sync_windows
                 SET state = 'pending', terminal_code = NULL
                 WHERE window_id = ?1 AND inbox_id = ?2 AND state = 'quarantined'
                   AND batch_count = ?3 AND accepted_count = ?4
                   AND committed_at IS NULL AND terminal_code = ?5",
                params![
                    window_id,
                    inbox_id.as_str(),
                    window.batch_count,
                    window.accepted_count,
                    code,
                ],
            )
            .map_err(|_| ledger_corrupt())?;
        if updated_window != 1 {
            return Err(ledger_corrupt());
        }
        let updated_inbox = transaction
            .execute(
                "UPDATE sync_inbox
                 SET state = 'prepared', terminal_code = NULL
                 WHERE inbox_id = ?1 AND state = 'quarantined' AND crypto_drained = 1
                   AND sdk_processed_at IS NOT NULL AND prepared_at IS NOT NULL
                   AND committed_at IS NULL AND terminal_code = ?2",
                params![inbox_id.as_str(), code],
            )
            .map_err(|_| ledger_corrupt())?;
        if updated_inbox != 1 {
            return Err(ledger_corrupt());
        }
        transaction.commit().map_err(|_| ledger_corrupt())?;
        Ok(())
    }

    /// Accept one live ingestion row and commit its source window when complete.
    pub fn accept_live_batch_and_maybe_commit_window(
        &mut self,
        row_id: &str,
        accepted_at: DateTime<Utc>,
    ) -> Result<LiveCommitOutcome, SafeError> {
        if !valid_batch_id(row_id) || !valid_utc_millisecond(accepted_at) {
            return Err(ledger_invalid());
        }

        let keyring = &self.keyring;
        let transaction = self
            .connection
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(|_| ledger_corrupt())?;
        let context = load_live_context(&transaction, keyring)?;
        let Some(addressed) = load_outbox_batch_by_id(&transaction, keyring, row_id)? else {
            return Err(ledger_not_ready());
        };
        let Some(window_id) = outbox_window_id(&transaction, row_id)? else {
            return Err(ledger_not_ready());
        };
        let window = load_window_by_id(&transaction, &window_id)?.ok_or_else(ledger_corrupt)?;
        let inbox_id = validate_inbox_id(&window.inbox_id).map_err(|_| ledger_corrupt())?;
        let expected_window_id =
            derive_window_id(keyring, inbox_id.as_str()).map_err(|_| ledger_corrupt())?;
        if window.window_id != expected_window_id || window.window_id != window_id {
            return Err(ledger_corrupt());
        }
        validate_window_inbox_link(&context, &window)?;
        let inbox_index = context
            .chain
            .rows
            .iter()
            .position(|row| row.inbox_id() == &inbox_id)
            .ok_or_else(ledger_corrupt)?;
        let inbox = &context.chain.rows[inbox_index];

        let outbox = load_outbox_batches(&transaction, keyring, &window_id)?;
        let staged_anchors = load_staged_anchors(&transaction, keyring, &window_id)?;
        let staged_ephemeral = load_staged_ephemeral(&transaction, keyring, &window_id)?;
        validate_window_children_against_metadata(
            &window,
            &outbox,
            &staged_anchors,
            &staged_ephemeral,
        )?;
        validate_live_window_metadata(&window, &outbox, inbox)?;

        match window.state.as_str() {
            "committed" => {
                validate_accepted_timestamps(&outbox, inbox)?;
                let stored_accepted_at = addressed.accepted_at.ok_or_else(ledger_corrupt)?;
                if stored_accepted_at != accepted_at {
                    return Err(ledger_conflict());
                }
                validate_committed_live_state(
                    &transaction,
                    keyring,
                    &window,
                    inbox,
                    &staged_anchors,
                    &staged_ephemeral,
                )?;
                drop(transaction);
                Ok(LiveCommitOutcome::AlreadyCommitted)
            }
            "pending" => {
                let oldest = oldest_target(&context, &inbox_id)?;
                validate_pending_live_target(&context, oldest)?;
                let prepared_at = inbox.prepared_at().ok_or_else(ledger_corrupt)?;
                if accepted_at < *prepared_at {
                    return Err(ledger_invalid());
                }
                validate_accepted_timestamps(&outbox, inbox)?;

                match addressed.state.as_str() {
                    "pending" => {
                        let updated = transaction
                            .execute(
                                "UPDATE outbox_batches
                                 SET state = 'accepted', accepted_at = ?1
                                 WHERE batch_row_id = ?2 AND source_kind = 'live'
                                   AND window_id = ?3 AND backfill_job_id IS NULL
                                   AND state = 'pending' AND accepted_at IS NULL
                                   AND terminal_code IS NULL",
                                params![accepted_at.to_rfc3339(), row_id, window_id],
                            )
                            .map_err(|_| ledger_corrupt())?;
                        if updated != 1 {
                            return Err(ledger_corrupt());
                        }
                    }
                    "accepted" => {
                        if addressed.accepted_at != Some(accepted_at) {
                            return Err(ledger_conflict());
                        }
                    }
                    "quarantined" => return Err(ledger_not_ready()),
                    _ => return Err(ledger_corrupt()),
                }

                let accepted_count = persisted_accepted_count(&transaction, &window_id)?;
                if accepted_count > window.batch_count {
                    return Err(ledger_corrupt());
                }
                let updated_window = transaction
                    .execute(
                        "UPDATE sync_windows
                         SET accepted_count = ?1
                         WHERE window_id = ?2 AND inbox_id = ?3 AND state = 'pending'
                           AND batch_count = ?4 AND accepted_count = ?5
                           AND committed_at IS NULL AND terminal_code IS NULL",
                        params![
                            accepted_count,
                            window_id,
                            inbox_id.as_str(),
                            window.batch_count,
                            window.accepted_count,
                        ],
                    )
                    .map_err(|_| ledger_corrupt())?;
                if updated_window != 1 {
                    return Err(ledger_corrupt());
                }

                if accepted_count < window.batch_count {
                    transaction.commit().map_err(|_| ledger_corrupt())?;
                    return Ok(LiveCommitOutcome::BatchAccepted {
                        accepted_count: u32::try_from(accepted_count)
                            .map_err(|_| ledger_corrupt())?,
                        batch_count: u32::try_from(window.batch_count)
                            .map_err(|_| ledger_corrupt())?,
                    });
                }

                let committed_window =
                    load_window_by_id(&transaction, &window_id)?.ok_or_else(ledger_corrupt)?;
                let committed_outbox = load_outbox_batches(&transaction, keyring, &window_id)?;
                let committed_anchors = load_staged_anchors(&transaction, keyring, &window_id)?;
                let committed_ephemeral = load_staged_ephemeral(&transaction, keyring, &window_id)?;
                validate_window_children_against_metadata(
                    &committed_window,
                    &committed_outbox,
                    &committed_anchors,
                    &committed_ephemeral,
                )?;
                validate_live_window_metadata(&committed_window, &committed_outbox, inbox)?;
                validate_accepted_timestamps(&committed_outbox, inbox)?;
                apply_live_commit(
                    &transaction,
                    keyring,
                    &committed_window,
                    inbox,
                    &committed_anchors,
                    &committed_ephemeral,
                    accepted_at,
                    false,
                )?;
                transaction.commit().map_err(|_| ledger_corrupt())?;
                Ok(LiveCommitOutcome::WindowCommitted)
            }
            "collecting" | "quarantined" => Err(ledger_not_ready()),
            _ => Err(ledger_corrupt()),
        }
    }

    /// Commit a collecting live window that produced no ingestion rows.
    pub fn commit_empty_live_window(
        &mut self,
        inbox_id: &str,
        window_id: &str,
        anchors: &[RoomAnchorCandidate],
        ephemeral: &[RoomEphemeralCandidate],
        committed_at: DateTime<Utc>,
    ) -> Result<(), SafeError> {
        let inbox_id = validate_inbox_id(inbox_id)?;
        validate_window_id(window_id)?;
        validate_candidates(anchors, ephemeral)?;
        if !valid_utc_millisecond(committed_at) {
            return Err(ledger_invalid());
        }
        let expected_window_id = derive_window_id(&self.keyring, inbox_id.as_str())?;
        if window_id != expected_window_id {
            return Err(ledger_invalid());
        }

        let keyring = &self.keyring;
        let transaction = self
            .connection
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(|_| ledger_corrupt())?;
        let context = load_live_context(&transaction, keyring)?;
        let window = load_window_by_id(&transaction, window_id)?.ok_or_else(ledger_not_ready)?;
        if window.window_id != window_id || window.inbox_id != inbox_id.as_str() {
            return Err(ledger_corrupt());
        }
        validate_window_inbox_link(&context, &window)?;
        let inbox_index = context
            .chain
            .rows
            .iter()
            .position(|row| row.inbox_id() == &inbox_id)
            .ok_or_else(ledger_corrupt)?;
        let inbox = &context.chain.rows[inbox_index];

        let outbox = load_outbox_batches(&transaction, keyring, window_id)?;
        let staged_anchors = load_staged_anchors(&transaction, keyring, window_id)?;
        let staged_ephemeral = load_staged_ephemeral(&transaction, keyring, window_id)?;
        validate_window_children_against_metadata(
            &window,
            &outbox,
            &staged_anchors,
            &staged_ephemeral,
        )?;

        match window.state.as_str() {
            "committed" => {
                let stored_committed_at = window
                    .committed_at
                    .as_deref()
                    .ok_or_else(ledger_corrupt)
                    .and_then(parse_stored_timestamp)
                    .map_err(|_| ledger_corrupt())?;
                if stored_committed_at != committed_at
                    || !same_staged_candidates(
                        &staged_anchors,
                        &staged_ephemeral,
                        anchors,
                        ephemeral,
                    )?
                {
                    return Err(ledger_conflict());
                }
                validate_committed_live_state(
                    &transaction,
                    keyring,
                    &window,
                    inbox,
                    &staged_anchors,
                    &staged_ephemeral,
                )?;
                drop(transaction);
                Ok(())
            }
            "collecting" => {
                let oldest = oldest_target(&context, &inbox_id)?;
                validate_collecting_live_target(&context, oldest)?;
                if window.batch_count != 0
                    || window.accepted_count != 0
                    || !outbox.is_empty()
                    || !staged_anchors.is_empty()
                    || !staged_ephemeral.is_empty()
                {
                    return Err(ledger_corrupt());
                }
                let created_at =
                    parse_stored_timestamp(&window.created_at).map_err(|_| ledger_corrupt())?;
                if committed_at < *oldest.observed_at() || committed_at < created_at {
                    return Err(ledger_invalid());
                }

                stage_live_candidates(&transaction, keyring, window_id, anchors, ephemeral)?;
                let staged_anchors = load_staged_anchors(&transaction, keyring, window_id)?;
                let staged_ephemeral = load_staged_ephemeral(&transaction, keyring, window_id)?;
                if !same_staged_candidates(&staged_anchors, &staged_ephemeral, anchors, ephemeral)?
                {
                    return Err(ledger_corrupt());
                }
                apply_live_commit(
                    &transaction,
                    keyring,
                    &window,
                    inbox,
                    &staged_anchors,
                    &staged_ephemeral,
                    committed_at,
                    true,
                )?;
                transaction.commit().map_err(|_| ledger_corrupt())?;
                Ok(())
            }
            "pending" | "quarantined" => Err(ledger_not_ready()),
            _ => Err(ledger_corrupt()),
        }
    }

    /// Complete a running live-gap job while preparing its linked live window.
    pub fn complete_live_gap_and_finalize_window(
        &mut self,
        gap_job_id: &str,
        window: &BatchWindow,
        anchors: &[RoomAnchorCandidate],
        ephemeral: &[RoomEphemeralCandidate],
    ) -> Result<FinalizeOutcome, SafeError> {
        if !valid_job_id(gap_job_id) {
            return Err(ledger_invalid());
        }
        let window_validation = validate_batch_window(window)?;
        validate_candidates(anchors, ephemeral)?;
        if !valid_utc_millisecond(window_validation.archived_at) {
            return Err(ledger_invalid());
        }

        let keyring = &self.keyring;
        let transaction = self
            .connection
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(|_| ledger_corrupt())?;

        let job =
            load_backfill_job(&transaction, keyring, gap_job_id)?.ok_or_else(ledger_not_ready)?;
        if job.kind != "live_gap" {
            return Err(ledger_not_ready());
        }
        let live_window_id = job.live_window_id.as_deref().ok_or_else(ledger_corrupt)?;
        validate_no_backfill_outbox_for_live_gap(&transaction, gap_job_id)?;

        let context = load_live_context(&transaction, keyring)?;
        let existing =
            load_window_by_id(&transaction, live_window_id)?.ok_or_else(ledger_corrupt)?;
        let inbox_id = validate_inbox_id(&existing.inbox_id).map_err(|_| ledger_corrupt())?;
        let expected_window_id =
            derive_window_id(keyring, inbox_id.as_str()).map_err(|_| ledger_corrupt())?;
        if existing.window_id != expected_window_id || existing.window_id != live_window_id {
            return Err(ledger_corrupt());
        }
        validate_window_inbox_link(&context, &existing)?;

        let outbox = load_outbox_batches(&transaction, keyring, live_window_id)?;
        let staged_anchors = load_staged_anchors(&transaction, keyring, live_window_id)?;
        let staged_ephemeral = load_staged_ephemeral(&transaction, keyring, live_window_id)?;
        validate_window_children_against_metadata(
            &existing,
            &outbox,
            &staged_anchors,
            &staged_ephemeral,
        )?;

        let expected_ignored =
            i64::try_from(window_validation.ignored_count).map_err(|_| ledger_invalid())?;
        if existing.ignored_count != expected_ignored {
            return Err(ledger_conflict());
        }

        let target = context
            .chain
            .rows
            .iter()
            .find(|row| row.inbox_id() == &inbox_id)
            .ok_or_else(ledger_corrupt)?;
        let expected_checkpoint = SourceCheckpoint {
            kind: "matrix_sync_token_sha256".to_owned(),
            value: format!("sha256:{}", lowercase_hex(target.next_token_digest())),
        };
        if window.source_checkpoint != expected_checkpoint {
            return Err(ledger_not_ready());
        }

        let created_at =
            parse_stored_timestamp(&existing.created_at).map_err(|_| ledger_corrupt())?;
        if *target.observed_at() > created_at {
            return Err(ledger_corrupt());
        }
        if *target.observed_at() > window_validation.archived_at
            || created_at > window_validation.archived_at
        {
            return Err(ledger_invalid());
        }

        match existing.state.as_str() {
            "pending" | "committed" => {
                if job.state != BackfillState::Completed {
                    return Err(ledger_corrupt());
                }
                if !same_prepared_input(
                    &existing,
                    &outbox,
                    &staged_anchors,
                    &staged_ephemeral,
                    window,
                    anchors,
                    ephemeral,
                )? {
                    return Err(ledger_conflict());
                }
                drop(transaction);
                return Ok(FinalizeOutcome::AlreadyPrepared {
                    batch_count: window_validation.batch_count,
                });
            }
            "collecting" => {
                match job.state {
                    BackfillState::Running => {}
                    BackfillState::Completed => return Err(ledger_corrupt()),
                    BackfillState::Pending
                    | BackfillState::Cancelled
                    | BackfillState::Quarantined => return Err(ledger_not_ready()),
                }
                oldest_target(&context, &inbox_id)?;
                if target.state() != SyncInboxState::SdkProcessed || !target.crypto_drained() {
                    return Err(ledger_not_ready());
                }
                if !outbox.is_empty() || !staged_anchors.is_empty() || !staged_ephemeral.is_empty()
                {
                    return Err(ledger_corrupt());
                }
            }
            "quarantined" => return Err(ledger_not_ready()),
            _ => return Err(ledger_corrupt()),
        }

        let mut sealed_batches = Vec::with_capacity(window.batches.len());
        for batch in &window.batches {
            let request_plaintext = Zeroizing::new(batch.exact_request_bytes().to_vec());
            let sealed = keyring
                .seal(
                    "outbox_batches",
                    &batch.batch_id,
                    "request",
                    request_plaintext.as_slice(),
                )
                .map_err(|_| ledger_corrupt())?;
            sealed_batches.push(sealed);
        }
        let mut sealed_anchors = Vec::with_capacity(anchors.len());
        for candidate in anchors {
            let row_id = candidate_row_id(live_window_id, candidate.room_lookup());
            let anchor_plaintext = Zeroizing::new(candidate.anchor_event().as_bytes().to_vec());
            let sealed = keyring
                .seal(
                    "window_room_anchors",
                    &row_id,
                    "anchor_event",
                    anchor_plaintext.as_slice(),
                )
                .map_err(|_| ledger_corrupt())?;
            sealed_anchors.push((candidate, sealed));
        }
        let mut sealed_ephemeral = Vec::with_capacity(ephemeral.len());
        for candidate in ephemeral {
            let row_id = candidate_row_id(live_window_id, candidate.room_lookup());
            let typing_plaintext = Zeroizing::new(candidate.typing_set().as_bytes().to_vec());
            let sealed = keyring
                .seal(
                    "window_room_ephemeral",
                    &row_id,
                    "typing_set",
                    typing_plaintext.as_slice(),
                )
                .map_err(|_| ledger_corrupt())?;
            sealed_ephemeral.push((candidate, sealed));
        }

        for (ordinal, (batch, sealed)) in window.batches.iter().zip(sealed_batches).enumerate() {
            let inserted = transaction
                .execute(
                    "INSERT INTO outbox_batches
                     (batch_row_id, source_kind, window_id, backfill_job_id, ordinal, state,
                      request_cipher, request_nonce, request_key_version, request_sha256,
                      byte_count, attempt_count, next_attempt_at, accepted_at, terminal_code)
                     VALUES (?1, 'live', ?2, NULL, ?3, 'pending', ?4, ?5, ?6, ?7, ?8,
                             0, ?9, NULL, NULL)",
                    params![
                        batch.batch_id.as_str(),
                        live_window_id,
                        i64::try_from(ordinal).map_err(|_| ledger_corrupt())?,
                        sealed.ciphertext.as_slice(),
                        sealed.nonce.as_slice(),
                        i64::from(sealed.key_version),
                        batch_digest(batch.exact_request_bytes()).as_slice(),
                        i64::try_from(batch.exact_request_bytes().len())
                            .map_err(|_| ledger_too_large())?,
                        window.archived_at.as_str(),
                    ],
                )
                .map_err(|_| ledger_corrupt())?;
            if inserted != 1 {
                return Err(ledger_corrupt());
            }
        }

        for (candidate, sealed) in sealed_anchors {
            let inserted = transaction
                .execute(
                    "INSERT INTO window_room_anchors
                     (window_id, room_lookup, anchor_event_cipher, anchor_event_nonce, key_version)
                     VALUES (?1, ?2, ?3, ?4, ?5)",
                    params![
                        live_window_id,
                        candidate.room_lookup(),
                        sealed.ciphertext.as_slice(),
                        sealed.nonce.as_slice(),
                        i64::from(sealed.key_version),
                    ],
                )
                .map_err(|_| ledger_corrupt())?;
            if inserted != 1 {
                return Err(ledger_corrupt());
            }
        }
        for (candidate, sealed) in sealed_ephemeral {
            let inserted = transaction
                .execute(
                    "INSERT INTO window_room_ephemeral
                     (window_id, room_lookup, typing_set_cipher, typing_set_nonce, key_version,
                      typing_expires_at)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                    params![
                        live_window_id,
                        candidate.room_lookup(),
                        sealed.ciphertext.as_slice(),
                        sealed.nonce.as_slice(),
                        i64::from(sealed.key_version),
                        candidate.typing_expires_at().to_rfc3339(),
                    ],
                )
                .map_err(|_| ledger_corrupt())?;
            if inserted != 1 {
                return Err(ledger_corrupt());
            }
        }

        let completed_job = transaction
            .execute(
                "UPDATE backfill_jobs
                 SET state = 'completed', completed_at = ?1
                 WHERE job_id = ?2 AND kind = 'live_gap' AND live_window_id = ?3
                   AND state = 'running' AND completed_at IS NULL
                   AND cancelled_at IS NULL AND terminal_code IS NULL",
                params![window.archived_at.as_str(), gap_job_id, live_window_id],
            )
            .map_err(|_| ledger_corrupt())?;
        if completed_job != 1 {
            return Err(ledger_corrupt());
        }

        let updated_window = transaction
            .execute(
                "UPDATE sync_windows
                 SET state = 'pending', batch_count = ?1, accepted_count = 0,
                     committed_at = NULL, terminal_code = NULL
                 WHERE window_id = ?2 AND inbox_id = ?3 AND state = 'collecting'
                   AND batch_count = 0 AND accepted_count = 0
                   AND committed_at IS NULL AND terminal_code IS NULL
                   AND ignored_count = ?4",
                params![
                    i64::from(window_validation.batch_count),
                    live_window_id,
                    inbox_id.as_str(),
                    expected_ignored,
                ],
            )
            .map_err(|_| ledger_corrupt())?;
        if updated_window != 1 {
            return Err(ledger_corrupt());
        }
        let updated_inbox = transaction
            .execute(
                "UPDATE sync_inbox
                 SET state = 'prepared', prepared_at = ?1
                 WHERE inbox_id = ?2 AND state = 'sdk_processed' AND crypto_drained = 1
                   AND sdk_processed_at IS NOT NULL AND prepared_at IS NULL
                   AND committed_at IS NULL AND terminal_code IS NULL",
                params![window.archived_at.as_str(), inbox_id.as_str()],
            )
            .map_err(|_| ledger_corrupt())?;
        if updated_inbox != 1 {
            return Err(ledger_corrupt());
        }

        transaction.commit().map_err(|_| ledger_corrupt())?;
        Ok(FinalizeOutcome::Prepared {
            batch_count: window_validation.batch_count,
        })
    }
}

fn validate_quarantined_window_inbox_link(
    window: &StoredLiveWindow,
    inbox: &super::RawSyncInbox,
    inbox_code: &str,
) -> Result<(), SafeError> {
    if window.state != "quarantined"
        || window.committed_at.is_some()
        || window.terminal_code.as_deref() != Some(inbox_code)
        || inbox.state() != SyncInboxState::Prepared
        || !inbox.crypto_drained()
        || inbox.prepared_at().is_none()
        || inbox.committed_at().is_some()
        || inbox.terminal_code().is_some()
    {
        return Err(ledger_corrupt());
    }
    Ok(())
}

fn validate_quarantined_live_children(
    window: &StoredLiveWindow,
    outbox: &[StoredOutboxBatch],
) -> Result<usize, SafeError> {
    let window_code = window.terminal_code.as_deref().ok_or_else(ledger_corrupt)?;
    let mut quarantined_count = 0_usize;
    for row in outbox {
        if row.state == "quarantined" {
            quarantined_count = quarantined_count
                .checked_add(1)
                .ok_or_else(ledger_corrupt)?;
            if row.accepted_at.is_some() || row.terminal_code.as_deref() != Some(window_code) {
                return Err(ledger_corrupt());
            }
        }
    }
    if quarantined_count == 0 {
        return Err(ledger_corrupt());
    }
    Ok(quarantined_count)
}

fn temporarily_prepare_quarantined_inboxes(
    transaction: &Transaction<'_>,
) -> Result<Vec<(String, String)>, SafeError> {
    let max_rows =
        usize::try_from(crate::config::MAX_PENDING_REQUEST_ROWS).map_err(|_| ledger_corrupt())?;
    let limit = crate::config::MAX_PENDING_REQUEST_ROWS
        .checked_add(1)
        .and_then(|value| i64::try_from(value).ok())
        .ok_or_else(ledger_corrupt)?;
    let mut statement = transaction
        .prepare(
            "SELECT inbox_id, terminal_code
             FROM sync_inbox WHERE state = 'quarantined' ORDER BY rowid LIMIT ?1",
        )
        .map_err(|_| ledger_corrupt())?;
    let mut rows = statement
        .query(params![limit])
        .map_err(|_| ledger_corrupt())?;
    let mut quarantined = Vec::new();
    while let Some(row) = rows.next().map_err(|_| ledger_corrupt())? {
        if quarantined.len() >= max_rows {
            return Err(ledger_corrupt());
        }
        let inbox_id = read_text(row, 0, MAX_LEDGER_ID_BYTES, valid_stored_inbox_id)?;
        let terminal_code =
            read_optional_text(row, 1, 64, valid_stored_reason_code)?.ok_or_else(ledger_corrupt)?;
        quarantined.push((inbox_id, terminal_code));
    }
    drop(rows);
    drop(statement);

    for (inbox_id, terminal_code) in &quarantined {
        let updated = transaction
            .execute(
                "UPDATE sync_inbox
                 SET state = 'prepared', terminal_code = NULL
                 WHERE inbox_id = ?1 AND state = 'quarantined'
                   AND crypto_drained = 1 AND sdk_processed_at IS NOT NULL
                   AND prepared_at IS NOT NULL AND committed_at IS NULL
                   AND terminal_code = ?2",
                params![inbox_id, terminal_code],
            )
            .map_err(|_| ledger_corrupt())?;
        if updated != 1 {
            return Err(ledger_corrupt());
        }
    }
    Ok(quarantined)
}

fn restore_quarantined_inboxes(
    transaction: &Transaction<'_>,
    quarantined: &[(String, String)],
) -> Result<(), SafeError> {
    for (inbox_id, terminal_code) in quarantined {
        let updated = transaction
            .execute(
                "UPDATE sync_inbox
                 SET state = 'quarantined', terminal_code = ?1
                 WHERE inbox_id = ?2 AND state = 'prepared'
                   AND crypto_drained = 1 AND sdk_processed_at IS NOT NULL
                   AND prepared_at IS NOT NULL AND committed_at IS NULL
                   AND terminal_code IS NULL",
                params![terminal_code, inbox_id],
            )
            .map_err(|_| ledger_corrupt())?;
        if updated != 1 {
            return Err(ledger_corrupt());
        }
    }
    Ok(())
}

fn validate_pending_live_target(
    context: &super::VerifiedCryptoContext,
    target: &super::RawSyncInbox,
) -> Result<(), SafeError> {
    if target.state() != SyncInboxState::Prepared || !target.crypto_drained() {
        return Err(ledger_not_ready());
    }
    if context
        .crypto_rows
        .iter()
        .any(|row| super::is_unresolved_crypto_state(row.state))
    {
        return Err(ledger_not_ready());
    }
    Ok(())
}

fn validate_collecting_live_target(
    context: &super::VerifiedCryptoContext,
    target: &super::RawSyncInbox,
) -> Result<(), SafeError> {
    if target.state() != SyncInboxState::SdkProcessed || !target.crypto_drained() {
        return Err(ledger_not_ready());
    }
    if context
        .crypto_rows
        .iter()
        .any(|row| super::is_unresolved_crypto_state(row.state))
    {
        return Err(ledger_not_ready());
    }
    Ok(())
}

fn persisted_accepted_count(
    transaction: &Transaction<'_>,
    window_id: &str,
) -> Result<i64, SafeError> {
    transaction
        .query_row(
            "SELECT COUNT(*) FROM outbox_batches
             WHERE source_kind = 'live' AND window_id = ?1 AND backfill_job_id IS NULL
               AND state = 'accepted'",
            [window_id],
            |row| row.get(0),
        )
        .map_err(|_| ledger_corrupt())
}

fn validate_accepted_timestamps(
    outbox: &[StoredOutboxBatch],
    inbox: &super::RawSyncInbox,
) -> Result<(), SafeError> {
    let prepared_at = inbox.prepared_at();
    for row in outbox.iter().filter(|row| row.state == "accepted") {
        let accepted_at = row.accepted_at.ok_or_else(ledger_corrupt)?;
        if accepted_at < *inbox.observed_at()
            || prepared_at.is_some_and(|prepared| accepted_at < *prepared)
        {
            return Err(ledger_corrupt());
        }
    }
    Ok(())
}

fn stage_live_candidates(
    transaction: &Transaction<'_>,
    keyring: &super::Keyring,
    window_id: &str,
    anchors: &[RoomAnchorCandidate],
    ephemeral: &[RoomEphemeralCandidate],
) -> Result<(), SafeError> {
    for candidate in anchors {
        let row_id = candidate_row_id(window_id, candidate.room_lookup());
        let sealed = keyring
            .seal(
                "window_room_anchors",
                &row_id,
                "anchor_event",
                candidate.anchor_event().as_bytes(),
            )
            .map_err(|_| ledger_corrupt())?;
        let inserted = transaction
            .execute(
                "INSERT INTO window_room_anchors
                 (window_id, room_lookup, anchor_event_cipher, anchor_event_nonce, key_version)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                params![
                    window_id,
                    candidate.room_lookup(),
                    sealed.ciphertext.as_slice(),
                    sealed.nonce.as_slice(),
                    i64::from(sealed.key_version),
                ],
            )
            .map_err(|_| ledger_corrupt())?;
        if inserted != 1 {
            return Err(ledger_corrupt());
        }
    }
    for candidate in ephemeral {
        let row_id = candidate_row_id(window_id, candidate.room_lookup());
        let sealed = keyring
            .seal(
                "window_room_ephemeral",
                &row_id,
                "typing_set",
                candidate.typing_set().as_bytes(),
            )
            .map_err(|_| ledger_corrupt())?;
        let inserted = transaction
            .execute(
                "INSERT INTO window_room_ephemeral
                 (window_id, room_lookup, typing_set_cipher, typing_set_nonce, key_version,
                  typing_expires_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![
                    window_id,
                    candidate.room_lookup(),
                    sealed.ciphertext.as_slice(),
                    sealed.nonce.as_slice(),
                    i64::from(sealed.key_version),
                    candidate.typing_expires_at().to_rfc3339(),
                ],
            )
            .map_err(|_| ledger_corrupt())?;
        if inserted != 1 {
            return Err(ledger_corrupt());
        }
    }
    Ok(())
}

fn same_staged_candidates(
    stored_anchors: &[StoredAnchor],
    stored_ephemeral: &[StoredEphemeral],
    anchors: &[RoomAnchorCandidate],
    ephemeral: &[RoomEphemeralCandidate],
) -> Result<bool, SafeError> {
    if stored_anchors.len() != anchors.len() || stored_ephemeral.len() != ephemeral.len() {
        return Ok(false);
    }
    for candidate in anchors {
        let lookup: [u8; 32] = candidate
            .room_lookup()
            .try_into()
            .map_err(|_| ledger_corrupt())?;
        let Some(stored) = stored_anchors.iter().find(|row| row.room_lookup == lookup) else {
            return Ok(false);
        };
        if stored.value.as_bytes() != candidate.anchor_event().as_bytes() {
            return Ok(false);
        }
    }
    for candidate in ephemeral {
        let lookup: [u8; 32] = candidate
            .room_lookup()
            .try_into()
            .map_err(|_| ledger_corrupt())?;
        let Some(stored) = stored_ephemeral
            .iter()
            .find(|row| row.room_lookup == lookup)
        else {
            return Ok(false);
        };
        if stored.value.as_bytes() != candidate.typing_set().as_bytes()
            || stored.typing_expires_at != *candidate.typing_expires_at()
        {
            return Ok(false);
        }
    }
    Ok(true)
}

#[allow(clippy::too_many_arguments)]
fn apply_live_commit(
    transaction: &Transaction<'_>,
    keyring: &super::Keyring,
    window: &StoredLiveWindow,
    inbox: &super::RawSyncInbox,
    anchors: &[StoredAnchor],
    ephemeral: &[StoredEphemeral],
    committed_at: DateTime<Utc>,
    prepare_inbox: bool,
) -> Result<(), SafeError> {
    if !valid_utc_millisecond(committed_at)
        || committed_at < *inbox.observed_at()
        || (!prepare_inbox
            && inbox
                .prepared_at()
                .is_none_or(|prepared| committed_at < *prepared))
    {
        return Err(ledger_invalid());
    }

    for anchor in anchors {
        let lookup = anchor.room_lookup;
        let existing = load_room_progress_anchor(transaction, keyring, &lookup)?;
        let sealed = keyring
            .seal(
                "room_progress",
                &room_progress_row_id(&lookup),
                "anchor_event",
                anchor.value.as_bytes(),
            )
            .map_err(|_| ledger_corrupt())?;
        if existing.is_some() {
            let updated = transaction
                .execute(
                    "UPDATE room_progress
                     SET anchor_event_cipher = ?1, anchor_event_nonce = ?2,
                         key_version = ?3, updated_at = ?4
                     WHERE room_lookup = ?5",
                    params![
                        sealed.ciphertext.as_slice(),
                        sealed.nonce.as_slice(),
                        i64::from(sealed.key_version),
                        committed_at.to_rfc3339(),
                        lookup.as_slice(),
                    ],
                )
                .map_err(|_| ledger_corrupt())?;
            if updated != 1 {
                return Err(ledger_corrupt());
            }
        } else {
            let count: i64 = transaction
                .query_row("SELECT COUNT(*) FROM room_progress", [], |row| row.get(0))
                .map_err(|_| ledger_corrupt())?;
            if count < 0
                || usize::try_from(count).map_or(true, |value| value >= MAX_BOOTSTRAP_ROOM_ANCHORS)
            {
                return Err(ledger_too_large());
            }
            let inserted = transaction
                .execute(
                    "INSERT INTO room_progress
                     (room_lookup, anchor_event_cipher, anchor_event_nonce, key_version, updated_at)
                     VALUES (?1, ?2, ?3, ?4, ?5)",
                    params![
                        lookup.as_slice(),
                        sealed.ciphertext.as_slice(),
                        sealed.nonce.as_slice(),
                        i64::from(sealed.key_version),
                        committed_at.to_rfc3339(),
                    ],
                )
                .map_err(|_| ledger_corrupt())?;
            if inserted != 1 {
                return Err(ledger_corrupt());
            }
        }
    }

    for value in ephemeral {
        let lookup = value.room_lookup;
        let existing = load_room_ephemeral_state(transaction, keyring, &lookup)?;
        let sealed = keyring
            .seal(
                "room_ephemeral_state",
                &room_progress_row_id(&lookup),
                "typing_set",
                value.value.as_bytes(),
            )
            .map_err(|_| ledger_corrupt())?;
        if existing.is_some() {
            let updated = transaction
                .execute(
                    "UPDATE room_ephemeral_state
                     SET typing_set_cipher = ?1, typing_set_nonce = ?2,
                         typing_key_version = ?3, typing_expires_at = ?4,
                         last_committed_inbox_digest = ?5, updated_at = ?6
                     WHERE room_lookup = ?7",
                    params![
                        sealed.ciphertext.as_slice(),
                        sealed.nonce.as_slice(),
                        i64::from(sealed.key_version),
                        value.typing_expires_at.to_rfc3339(),
                        inbox.next_token_digest().as_slice(),
                        committed_at.to_rfc3339(),
                        lookup.as_slice(),
                    ],
                )
                .map_err(|_| ledger_corrupt())?;
            if updated != 1 {
                return Err(ledger_corrupt());
            }
        } else {
            let inserted = transaction
                .execute(
                    "INSERT INTO room_ephemeral_state
                     (room_lookup, typing_set_cipher, typing_set_nonce, typing_key_version,
                      typing_expires_at, last_committed_inbox_digest, updated_at)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                    params![
                        lookup.as_slice(),
                        sealed.ciphertext.as_slice(),
                        sealed.nonce.as_slice(),
                        i64::from(sealed.key_version),
                        value.typing_expires_at.to_rfc3339(),
                        inbox.next_token_digest().as_slice(),
                        committed_at.to_rfc3339(),
                    ],
                )
                .map_err(|_| ledger_corrupt())?;
            if inserted != 1 {
                return Err(ledger_corrupt());
            }
        }
    }

    let committed_token = keyring
        .seal(
            "gateway_state",
            "1",
            "committed_token",
            inbox.next_token().as_bytes(),
        )
        .map_err(|_| ledger_corrupt())?;
    let updated_gateway = transaction
        .execute(
            "UPDATE gateway_state
             SET committed_token_cipher = ?1, committed_token_nonce = ?2,
                 committed_token_key_version = ?3, updated_at = ?4
             WHERE singleton = 1",
            params![
                committed_token.ciphertext.as_slice(),
                committed_token.nonce.as_slice(),
                i64::from(committed_token.key_version),
                committed_at.to_rfc3339(),
            ],
        )
        .map_err(|_| ledger_corrupt())?;
    if updated_gateway != 1 {
        return Err(ledger_corrupt());
    }

    let updated_inbox = if prepare_inbox {
        transaction
            .execute(
                "UPDATE sync_inbox
                 SET state = 'committed', prepared_at = ?1, committed_at = ?1
                 WHERE inbox_id = ?2 AND state = 'sdk_processed' AND crypto_drained = 1
                   AND sdk_processed_at IS NOT NULL AND prepared_at IS NULL
                   AND committed_at IS NULL AND terminal_code IS NULL",
                params![committed_at.to_rfc3339(), inbox.inbox_id().as_str()],
            )
            .map_err(|_| ledger_corrupt())?
    } else {
        transaction
            .execute(
                "UPDATE sync_inbox
                 SET state = 'committed', committed_at = ?1
                 WHERE inbox_id = ?2 AND state = 'prepared' AND crypto_drained = 1
                   AND sdk_processed_at IS NOT NULL AND prepared_at IS NOT NULL
                   AND committed_at IS NULL AND terminal_code IS NULL",
                params![committed_at.to_rfc3339(), inbox.inbox_id().as_str()],
            )
            .map_err(|_| ledger_corrupt())?
    };
    if updated_inbox != 1 {
        return Err(ledger_corrupt());
    }

    let expected_state = if prepare_inbox {
        "collecting"
    } else {
        "pending"
    };
    let updated_window = transaction
        .execute(
            "UPDATE sync_windows
             SET state = 'committed', committed_at = ?1
             WHERE window_id = ?2 AND inbox_id = ?3 AND state = ?4
               AND batch_count = ?5 AND accepted_count = ?6
               AND committed_at IS NULL AND terminal_code IS NULL",
            params![
                committed_at.to_rfc3339(),
                window.window_id,
                window.inbox_id,
                expected_state,
                window.batch_count,
                window.accepted_count,
            ],
        )
        .map_err(|_| ledger_corrupt())?;
    if updated_window != 1 {
        return Err(ledger_corrupt());
    }
    Ok(())
}

fn validate_committed_live_state(
    transaction: &Transaction<'_>,
    keyring: &super::Keyring,
    window: &StoredLiveWindow,
    inbox: &super::RawSyncInbox,
    anchors: &[StoredAnchor],
    ephemeral: &[StoredEphemeral],
) -> Result<(), SafeError> {
    let committed_at = window
        .committed_at
        .as_deref()
        .ok_or_else(ledger_corrupt)
        .and_then(parse_stored_timestamp)
        .map_err(|_| ledger_corrupt())?;
    if inbox.state() != SyncInboxState::Committed || inbox.committed_at() != Some(&committed_at) {
        return Err(ledger_corrupt());
    }
    for anchor in anchors {
        let Some((current, updated_at)) =
            load_room_progress_anchor(transaction, keyring, &anchor.room_lookup)?
        else {
            return Err(ledger_corrupt());
        };
        if updated_at < committed_at
            || (updated_at == committed_at && current.as_bytes() != anchor.value.as_bytes())
        {
            return Err(ledger_corrupt());
        }
    }
    for value in ephemeral {
        let Some(current) = load_room_ephemeral_state(transaction, keyring, &value.room_lookup)?
        else {
            return Err(ledger_corrupt());
        };
        if current.updated_at < committed_at {
            return Err(ledger_corrupt());
        }
        if current.updated_at == committed_at
            && (current.value.as_bytes() != value.value.as_bytes()
                || current.typing_expires_at != value.typing_expires_at
                || current.last_committed_inbox_digest != *inbox.next_token_digest())
        {
            return Err(ledger_corrupt());
        }
    }
    Ok(())
}

struct StoredRoomEphemeralState {
    value: SecretBytes,
    typing_expires_at: DateTime<Utc>,
    last_committed_inbox_digest: [u8; 32],
    updated_at: DateTime<Utc>,
}

fn load_room_progress_anchor(
    transaction: &Transaction<'_>,
    keyring: &super::Keyring,
    room_lookup: &[u8; 32],
) -> Result<Option<(SecretBytes, DateTime<Utc>)>, SafeError> {
    let mut statement = transaction
        .prepare(
            "SELECT anchor_event_cipher, anchor_event_nonce, key_version, updated_at
             FROM room_progress WHERE room_lookup = ?1 LIMIT 2",
        )
        .map_err(|_| ledger_corrupt())?;
    let mut rows = statement
        .query(params![room_lookup.as_slice()])
        .map_err(|_| ledger_corrupt())?;
    let Some(row) = rows.next().map_err(|_| ledger_corrupt())? else {
        return Ok(None);
    };
    let ciphertext = read_blob(row, 0, AEAD_TAG_BYTES, MAX_CIPHER_ANCHOR_BYTES)?;
    let nonce = read_blob(row, 1, 24, 24)?;
    let key_version = read_integer(row, 2, 1, i64::from(u32::MAX))?;
    let updated_at = read_text(row, 3, 64, valid_stored_utc_millisecond)
        .and_then(|value| parse_stored_timestamp(&value).map_err(|_| ledger_corrupt()))?;
    let plaintext = open_stored_value(
        keyring,
        StoredValue {
            table: "room_progress",
            row_id: &room_progress_row_id(room_lookup),
            column: "anchor_event",
            ciphertext: Some(ciphertext.as_slice()),
            nonce: Some(nonce.as_slice()),
            key_version: Some(key_version),
            max_plaintext_bytes: MAX_ANCHOR_BYTES,
        },
    )
    .map_err(|_| ledger_corrupt())?;
    if rows.next().map_err(|_| ledger_corrupt())?.is_some() {
        return Err(ledger_corrupt());
    }
    Ok(Some((
        SecretBytes::new(plaintext.as_bytes().to_vec()),
        updated_at,
    )))
}

fn load_room_ephemeral_state(
    transaction: &Transaction<'_>,
    keyring: &super::Keyring,
    room_lookup: &[u8; 32],
) -> Result<Option<StoredRoomEphemeralState>, SafeError> {
    let mut statement = transaction
        .prepare(
            "SELECT typing_set_cipher, typing_set_nonce, typing_key_version,
                    typing_expires_at, last_committed_inbox_digest, updated_at
             FROM room_ephemeral_state WHERE room_lookup = ?1 LIMIT 2",
        )
        .map_err(|_| ledger_corrupt())?;
    let mut rows = statement
        .query(params![room_lookup.as_slice()])
        .map_err(|_| ledger_corrupt())?;
    let Some(row) = rows.next().map_err(|_| ledger_corrupt())? else {
        return Ok(None);
    };
    let ciphertext = read_blob(row, 0, AEAD_TAG_BYTES, MAX_CIPHER_ANCHOR_BYTES)?;
    let nonce = read_blob(row, 1, 24, 24)?;
    let key_version = read_integer(row, 2, 1, i64::from(u32::MAX))?;
    let typing_expires_at = read_text(row, 3, 64, valid_stored_utc_millisecond)
        .and_then(|value| parse_stored_timestamp(&value).map_err(|_| ledger_corrupt()))?;
    let last_committed_inbox_digest = digest_from_blob(&read_blob(row, 4, 32, 32)?)?;
    let updated_at = read_text(row, 5, 64, valid_stored_utc_millisecond)
        .and_then(|value| parse_stored_timestamp(&value).map_err(|_| ledger_corrupt()))?;
    let plaintext = open_stored_value(
        keyring,
        StoredValue {
            table: "room_ephemeral_state",
            row_id: &room_progress_row_id(room_lookup),
            column: "typing_set",
            ciphertext: Some(ciphertext.as_slice()),
            nonce: Some(nonce.as_slice()),
            key_version: Some(key_version),
            max_plaintext_bytes: MAX_ANCHOR_BYTES,
        },
    )
    .map_err(|_| ledger_corrupt())?;
    if rows.next().map_err(|_| ledger_corrupt())?.is_some() {
        return Err(ledger_corrupt());
    }
    Ok(Some(StoredRoomEphemeralState {
        value: SecretBytes::new(plaintext.as_bytes().to_vec()),
        typing_expires_at,
        last_committed_inbox_digest,
        updated_at,
    }))
}

fn validate_no_backfill_outbox_for_live_gap(
    transaction: &Transaction<'_>,
    job_id: &str,
) -> Result<(), SafeError> {
    let count: i64 = transaction
        .query_row(
            "SELECT COUNT(*) FROM outbox_batches WHERE backfill_job_id = ?1",
            [job_id],
            |row| row.get(0),
        )
        .map_err(|_| ledger_corrupt())?;
    if count != 0 {
        return Err(ledger_corrupt());
    }
    Ok(())
}

fn validate_inbox_id(value: &str) -> Result<InboxId, SafeError> {
    if !valid_stored_inbox_id(value) {
        return Err(ledger_invalid());
    }
    InboxId::new(value.to_owned()).map_err(|_| ledger_invalid())
}

fn validate_window_id(value: &str) -> Result<(), SafeError> {
    if !valid_digest_id(value, "window_") {
        return Err(ledger_invalid());
    }
    Ok(())
}

fn validate_live_gap_target(
    context: &super::VerifiedCryptoContext,
    transaction: &Transaction<'_>,
    keyring: &super::Keyring,
    window_id: &str,
    missing_is_corrupt: bool,
) -> Result<(), SafeError> {
    let window = load_window_by_id(transaction, window_id)?.ok_or_else(|| {
        if missing_is_corrupt {
            ledger_corrupt()
        } else {
            ledger_not_ready()
        }
    })?;
    let inbox_id = validate_inbox_id(&window.inbox_id).map_err(|_| ledger_corrupt())?;
    let expected_window_id =
        derive_window_id(keyring, inbox_id.as_str()).map_err(|_| ledger_corrupt())?;
    if window.window_id != expected_window_id {
        return Err(ledger_corrupt());
    }
    validate_window_inbox_link(context, &window)?;
    validate_window_children(transaction, keyring, &window)?;
    if window.state != "collecting" {
        return Err(ledger_not_ready());
    }
    let target = oldest_target(context, &inbox_id)?;
    if target.state() != SyncInboxState::SdkProcessed || !target.crypto_drained() {
        return Err(ledger_not_ready());
    }
    let created_at = parse_stored_timestamp(&window.created_at)?;
    if *target.observed_at() > created_at {
        return Err(ledger_corrupt());
    }
    Ok(())
}

fn derive_window_id(keyring: &super::Keyring, inbox_id: &str) -> Result<String, SafeError> {
    let digest = keyring
        .lookup_digest(LIVE_WINDOW_ID_DOMAIN, &[inbox_id])
        .map_err(|_| ledger_invalid())?;
    Ok(format!("window_{}", lowercase_hex(&digest)))
}

fn validate_batch_window(window: &BatchWindow) -> Result<WindowValidation, SafeError> {
    if window.batches.is_empty() {
        return Err(ledger_invalid());
    }
    if window.batches.len() > MAX_WINDOW_BATCHES {
        return Err(ledger_too_large());
    }
    if window.quarantined.len() > MAX_WINDOW_ROOM_CANDIDATES {
        return Err(ledger_too_large());
    }
    let archived_at = parse_input_timestamp(&window.archived_at)?;
    if !valid_source_checkpoint(&window.source_checkpoint) {
        return Err(ledger_invalid());
    }

    let mut ignored_count = 0_u64;
    for quarantine in &window.quarantined {
        let count = u64::try_from(quarantine.count()).map_err(|_| ledger_invalid())?;
        if count == 0 {
            return Err(ledger_invalid());
        }
        ignored_count = ignored_count
            .checked_add(count)
            .ok_or_else(ledger_invalid)?;
    }
    if i64::try_from(ignored_count).is_err() {
        return Err(ledger_invalid());
    }

    let mut batch_ids = HashSet::with_capacity(window.batches.len());
    let mut common_tenant = None;
    let mut common_route = None;
    let mut common_source = None;
    for batch in &window.batches {
        validate_built_batch(batch, &window.archived_at)?;
        if !batch_ids.insert(batch.batch_id.as_str()) {
            return Err(ledger_invalid());
        }
        if let Some(tenant) = common_tenant {
            if tenant != batch.tenant_id() {
                return Err(ledger_invalid());
            }
        } else {
            common_tenant = Some(batch.tenant_id());
        }
        if let Some(route) = common_route {
            if route != batch.gateway_route_id() {
                return Err(ledger_invalid());
            }
        } else {
            common_route = Some(batch.gateway_route_id());
        }
        if let Some(source) = common_source {
            if source != &batch.request.source_checkpoint {
                return Err(ledger_invalid());
            }
        } else {
            common_source = Some(&batch.request.source_checkpoint);
        }
        if batch.request.source_checkpoint != window.source_checkpoint {
            return Err(ledger_invalid());
        }
    }

    Ok(WindowValidation {
        archived_at,
        ignored_count,
        batch_count: u32::try_from(window.batches.len()).map_err(|_| ledger_too_large())?,
    })
}

fn validate_built_batch(batch: &batch::BuiltBatch, archived_at: &str) -> Result<(), SafeError> {
    let request_bytes = batch.exact_request_bytes();
    if request_bytes.is_empty() {
        return Err(ledger_invalid());
    }
    if request_bytes.len() > MAX_BATCH_CANONICAL_BYTES {
        return Err(ledger_too_large());
    }
    if batch.canonical_jsonl.len() > MAX_BATCH_CANONICAL_BYTES
        || batch.identity_json.len() > MAX_BATCH_CANONICAL_BYTES
    {
        return Err(ledger_too_large());
    }
    let request = batch::reparse_and_verify_request(request_bytes).map_err(|_| ledger_invalid())?;
    if request != batch.request
        || batch.events != request.events
        || batch.batch_id != request.batch_id
        || !batch.one_tenant_and_route()
        || request.archived_at != archived_at
        || request.source_checkpoint.kind != "matrix_sync_token_sha256"
    {
        return Err(ledger_invalid());
    }

    let mut offset = 0_usize;
    for event in &request.events {
        let line =
            canonical::canonical_event_json_line_bytes(event).map_err(|_| ledger_invalid())?;
        let end = offset.checked_add(line.len()).ok_or_else(ledger_invalid)?;
        if end > batch.canonical_jsonl.len()
            || batch.canonical_jsonl.get(offset..end) != Some(line.as_slice())
        {
            return Err(ledger_invalid());
        }
        offset = end;
    }
    if offset != batch.canonical_jsonl.len()
        || batch.uncompressed_bytes != batch.canonical_jsonl.len()
    {
        return Err(ledger_invalid());
    }
    let canonical_sha256 = canonical::sha256_hex(&batch.canonical_jsonl);
    if batch.canonical_sha256 != canonical_sha256 {
        return Err(ledger_invalid());
    }
    let input = CanonicalBatchInput {
        gateway_route_id: request.gateway_route_id.clone(),
        tenant_id: request.tenant_id.clone(),
        archived_at: request.archived_at.clone(),
        producer_version: request.producer_version.clone(),
        source_checkpoint: request.source_checkpoint.clone(),
        events: Vec::new(),
    };
    let identity =
        canonical::batch_identity_json(&input, &canonical_sha256).map_err(|_| ledger_invalid())?;
    let expected_batch_id =
        canonical::batch_id(&input, &canonical_sha256).map_err(|_| ledger_invalid())?;
    if batch.identity_json != identity || batch.batch_id != expected_batch_id {
        return Err(ledger_invalid());
    }
    Ok(())
}

fn validate_candidates(
    anchors: &[RoomAnchorCandidate],
    ephemeral: &[RoomEphemeralCandidate],
) -> Result<(), SafeError> {
    let total = anchors
        .len()
        .checked_add(ephemeral.len())
        .ok_or_else(ledger_too_large)?;
    if anchors.len() > MAX_WINDOW_ROOM_CANDIDATES
        || ephemeral.len() > MAX_WINDOW_ROOM_CANDIDATES
        || total > MAX_WINDOW_ROOM_CANDIDATES
    {
        return Err(ledger_too_large());
    }
    let mut anchor_lookups = HashSet::with_capacity(anchors.len());
    for candidate in anchors {
        candidate.validate()?;
        let lookup: [u8; 32] = candidate
            .room_lookup()
            .try_into()
            .map_err(|_| ledger_invalid())?;
        if !anchor_lookups.insert(lookup) {
            return Err(ledger_invalid());
        }
    }
    let mut ephemeral_lookups = HashSet::with_capacity(ephemeral.len());
    for candidate in ephemeral {
        candidate.validate()?;
        let lookup: [u8; 32] = candidate
            .room_lookup()
            .try_into()
            .map_err(|_| ledger_invalid())?;
        if !ephemeral_lookups.insert(lookup) {
            return Err(ledger_invalid());
        }
    }
    Ok(())
}

fn load_live_context(
    transaction: &Transaction<'_>,
    keyring: &super::Keyring,
) -> Result<super::VerifiedCryptoContext, SafeError> {
    let context = load_crypto_context(transaction, keyring).map_err(map_storage_error)?;
    if context.gateway.maintenance_code.is_some() {
        return Err(ledger_not_ready());
    }
    Ok(context)
}

fn oldest_target<'a>(
    context: &'a super::VerifiedCryptoContext,
    requested: &InboxId,
) -> Result<&'a super::RawSyncInbox, SafeError> {
    let Some(index) = context.chain.first_uncommitted_index else {
        return Err(ledger_not_ready());
    };
    let target = &context.chain.rows[index];
    if target.inbox_id() != requested {
        return Err(ledger_not_ready());
    }
    Ok(target)
}

fn validate_window_inbox_link(
    context: &super::VerifiedCryptoContext,
    window: &StoredLiveWindow,
) -> Result<(), SafeError> {
    let inbox_id = validate_inbox_id(&window.inbox_id).map_err(|_| ledger_corrupt())?;
    let Some(row) = context
        .chain
        .rows
        .iter()
        .find(|row| row.inbox_id() == &inbox_id)
    else {
        return Err(ledger_corrupt());
    };
    match window.state.as_str() {
        "collecting" => {
            if row.state() != SyncInboxState::SdkProcessed || !row.crypto_drained() {
                return Err(ledger_corrupt());
            }
        }
        "pending" => {
            if row.state() != SyncInboxState::Prepared
                || !row.crypto_drained()
                || row.prepared_at().is_none()
                || window.committed_at.is_some()
                || window.terminal_code.is_some()
            {
                return Err(ledger_corrupt());
            }
        }
        "committed" => {
            if row.state() != SyncInboxState::Committed
                || row.committed_at().is_none()
                || window.committed_at.is_none()
                || window.terminal_code.is_some()
            {
                return Err(ledger_corrupt());
            }
        }
        "quarantined" => {
            if row.state() != SyncInboxState::Quarantined || window.terminal_code.is_none() {
                return Err(ledger_corrupt());
            }
        }
        _ => return Err(ledger_corrupt()),
    }
    Ok(())
}

fn load_existing_window(
    transaction: &Transaction<'_>,
    window_id: &str,
    inbox_id: &str,
) -> Result<Option<StoredLiveWindow>, SafeError> {
    let mut statement = transaction
        .prepare(
            "SELECT window_id, inbox_id, state, batch_count, accepted_count, ignored_count,
                    created_at, committed_at, terminal_code
             FROM sync_windows
             WHERE window_id = ?1 OR inbox_id = ?2
             LIMIT 2",
        )
        .map_err(|_| ledger_corrupt())?;
    let mut rows = statement
        .query(params![window_id, inbox_id])
        .map_err(|_| ledger_corrupt())?;
    let mut result = None;
    while let Some(row) = rows.next().map_err(|_| ledger_corrupt())? {
        if result.is_some() {
            return Err(ledger_corrupt());
        }
        result = Some(read_stored_window(row)?);
    }
    Ok(result)
}

fn load_window_by_id(
    transaction: &Transaction<'_>,
    window_id: &str,
) -> Result<Option<StoredLiveWindow>, SafeError> {
    let mut statement = transaction
        .prepare(
            "SELECT window_id, inbox_id, state, batch_count, accepted_count, ignored_count,
                    created_at, committed_at, terminal_code
             FROM sync_windows WHERE window_id = ?1 LIMIT 2",
        )
        .map_err(|_| ledger_corrupt())?;
    let mut rows = statement.query([window_id]).map_err(|_| ledger_corrupt())?;
    let mut result = None;
    while let Some(row) = rows.next().map_err(|_| ledger_corrupt())? {
        if result.is_some() {
            return Err(ledger_corrupt());
        }
        result = Some(read_stored_window(row)?);
    }
    Ok(result)
}

fn load_backfill_job(
    transaction: &Transaction<'_>,
    keyring: &super::Keyring,
    job_id: &str,
) -> Result<Option<StoredBackfillJob>, SafeError> {
    let mut statement = transaction
        .prepare(
            "SELECT job_id, kind, live_window_id, state, parameters_cipher, parameters_nonce,
                    pagination_cipher, pagination_nonce, key_version, accepted_events, created_at,
                    completed_at, cancelled_at, terminal_code
             FROM backfill_jobs WHERE job_id = ?1 LIMIT 2",
        )
        .map_err(|_| ledger_corrupt())?;
    let mut rows = statement.query([job_id]).map_err(|_| ledger_corrupt())?;
    let mut result = None;
    while let Some(row) = rows.next().map_err(|_| ledger_corrupt())? {
        if result.is_some() {
            return Err(ledger_corrupt());
        }
        result = Some(read_stored_backfill_job(row, keyring)?);
    }
    Ok(result)
}

fn read_stored_backfill_job(
    row: &Row<'_>,
    keyring: &super::Keyring,
) -> Result<StoredBackfillJob, SafeError> {
    let job_id = read_text(row, 0, MAX_LEDGER_ID_BYTES, valid_job_id)?;
    let kind = read_text(
        row,
        1,
        "live_gap".len().max("explicit".len()),
        valid_job_kind,
    )?;
    let live_window_id = read_optional_text(row, 2, MAX_LEDGER_ID_BYTES, valid_window_id)?;
    let state_text = read_text(row, 3, "quarantined".len(), valid_backfill_state)?;
    let state = parse_backfill_state(&state_text)?;
    let parameter_cipher = read_blob(
        row,
        4,
        AEAD_TAG_BYTES,
        MAX_BACKFILL_PARAMETERS_BYTES
            .checked_add(AEAD_TAG_BYTES)
            .ok_or_else(ledger_corrupt)?,
    )?;
    let parameter_nonce = read_blob(row, 5, 24, 24)?;
    let pagination_cipher = read_optional_blob(
        row,
        6,
        AEAD_TAG_BYTES,
        MAX_BACKFILL_PAGINATION_BYTES
            .checked_add(AEAD_TAG_BYTES)
            .ok_or_else(ledger_corrupt)?,
    )?;
    let pagination_nonce = read_optional_blob(row, 7, 24, 24)?;
    if pagination_cipher.is_some() != pagination_nonce.is_some() {
        return Err(ledger_corrupt());
    }
    let key_version = read_integer(row, 8, 1, i64::from(u32::MAX))?;
    let accepted_events_i64 = read_integer(
        row,
        9,
        0,
        i64::try_from(batch::MAX_BACKFILL_EVENTS).map_err(|_| ledger_corrupt())?,
    )?;
    let accepted_events = u64::try_from(accepted_events_i64).map_err(|_| ledger_corrupt())?;
    let created_at = read_text(row, 10, 64, valid_stored_utc_millisecond)?;
    let completed_at = read_optional_text(row, 11, 64, valid_stored_utc_millisecond)?;
    let cancelled_at = read_optional_text(row, 12, 64, valid_stored_utc_millisecond)?;
    let terminal_code = read_optional_text(row, 13, 64, valid_stored_reason_code)?;

    let parameters_plaintext = open_stored_value(
        keyring,
        StoredValue {
            table: "backfill_jobs",
            row_id: &job_id,
            column: "parameters",
            ciphertext: Some(parameter_cipher.as_slice()),
            nonce: Some(parameter_nonce.as_slice()),
            key_version: Some(key_version),
            max_plaintext_bytes: MAX_BACKFILL_PARAMETERS_BYTES,
        },
    )
    .map_err(|_| ledger_corrupt())?;
    let parameters = Zeroizing::new(parameters_plaintext.as_bytes().to_vec());
    if parameters.is_empty() {
        return Err(ledger_corrupt());
    }
    let pagination = match (pagination_cipher, pagination_nonce) {
        (Some(ciphertext), Some(nonce)) => {
            let pagination_plaintext = open_stored_value(
                keyring,
                StoredValue {
                    table: "backfill_jobs",
                    row_id: &job_id,
                    column: "pagination",
                    ciphertext: Some(ciphertext.as_slice()),
                    nonce: Some(nonce.as_slice()),
                    key_version: Some(key_version),
                    max_plaintext_bytes: MAX_BACKFILL_PAGINATION_BYTES,
                },
            )
            .map_err(|_| ledger_corrupt())?;
            let pagination = Zeroizing::new(pagination_plaintext.as_bytes().to_vec());
            Some(SecretBytes::new(pagination.to_vec()))
        }
        (None, None) => None,
        _ => return Err(ledger_corrupt()),
    };
    if pagination
        .as_ref()
        .is_some_and(|value| value.as_bytes().is_empty())
    {
        return Err(ledger_corrupt());
    }
    if kind == "live_gap" && pagination.is_some() {
        return Err(ledger_corrupt());
    }
    if kind == "live_gap" && live_window_id.is_none() {
        return Err(ledger_corrupt());
    }
    if kind == "explicit" && live_window_id.is_some() {
        return Err(ledger_corrupt());
    }
    validate_backfill_job_lifecycle(
        state,
        completed_at.as_deref(),
        cancelled_at.as_deref(),
        terminal_code.as_deref(),
    )?;
    let value = StoredBackfillJob {
        job_id,
        kind,
        live_window_id,
        state,
        parameters: SecretBytes::new(parameters.to_vec()),
        accepted_events,
        created_at,
    };
    if value.kind == "live_gap" {
        StoredLiveGapJob::from_verified_parts(
            value.job_id.clone(),
            value.live_window_id.clone().ok_or_else(ledger_corrupt)?,
            value.state,
            value.parameters.as_bytes().to_vec(),
            value.accepted_events,
        )
        .map_err(|_| ledger_corrupt())?;
    }
    Ok(value)
}

fn validate_backfill_job_lifecycle(
    state: BackfillState,
    completed_at: Option<&str>,
    cancelled_at: Option<&str>,
    terminal_code: Option<&str>,
) -> Result<(), SafeError> {
    match state {
        BackfillState::Pending | BackfillState::Running
            if completed_at.is_none() && cancelled_at.is_none() && terminal_code.is_none() => {}
        BackfillState::Completed
            if completed_at.is_some() && cancelled_at.is_none() && terminal_code.is_none() => {}
        BackfillState::Cancelled
            if completed_at.is_none() && cancelled_at.is_some() && terminal_code.is_none() => {}
        BackfillState::Quarantined
            if completed_at.is_none() && cancelled_at.is_none() && terminal_code.is_some() => {}
        _ => return Err(ledger_corrupt()),
    }
    Ok(())
}

fn parse_backfill_state(value: &str) -> Result<BackfillState, SafeError> {
    match value {
        "pending" => Ok(BackfillState::Pending),
        "running" => Ok(BackfillState::Running),
        "completed" => Ok(BackfillState::Completed),
        "cancelled" => Ok(BackfillState::Cancelled),
        "quarantined" => Ok(BackfillState::Quarantined),
        _ => Err(ledger_corrupt()),
    }
}

fn read_stored_window(row: &Row<'_>) -> Result<StoredLiveWindow, SafeError> {
    let window_id = read_text(row, 0, MAX_LEDGER_ID_BYTES, valid_window_id)?;
    let inbox_id = read_text(row, 1, MAX_LEDGER_ID_BYTES, valid_stored_inbox_id)?;
    let state = read_text(row, 2, WINDOW_STATE_MAX_BYTES, valid_window_state)?;
    let batch_count = read_integer(
        row,
        3,
        0,
        i64::try_from(MAX_WINDOW_BATCHES).map_err(|_| ledger_corrupt())?,
    )?;
    let accepted_count = read_integer(row, 4, 0, batch_count)?;
    let ignored_count = read_integer(row, 5, 0, i64::MAX)?;
    let created_at = read_text(row, 6, 64, valid_stored_utc_millisecond)?;
    let committed_at = read_optional_text(row, 7, 64, valid_stored_utc_millisecond)?;
    let terminal_code = read_optional_text(row, 8, 64, valid_stored_reason_code)?;
    let value = StoredLiveWindow {
        window_id,
        inbox_id,
        state,
        batch_count,
        accepted_count,
        ignored_count,
        created_at,
        committed_at,
        terminal_code,
    };
    validate_stored_window_shape(&value)?;
    Ok(value)
}

fn validate_stored_window_shape(window: &StoredLiveWindow) -> Result<(), SafeError> {
    let created = parse_stored_timestamp(&window.created_at).map_err(|_| ledger_corrupt())?;
    if !valid_utc_millisecond(created) {
        return Err(ledger_corrupt());
    }
    match window.state.as_str() {
        "collecting"
            if window.batch_count == 0
                && window.accepted_count == 0
                && window.committed_at.is_none()
                && window.terminal_code.is_none() => {}
        "pending"
            if window.batch_count > 0
                && window.committed_at.is_none()
                && window.terminal_code.is_none() => {}
        "committed"
            if window.accepted_count == window.batch_count
                && window.committed_at.is_some()
                && window.terminal_code.is_none() => {}
        "quarantined"
            if window.batch_count > 0
                && window.committed_at.is_none()
                && window.terminal_code.is_some() => {}
        _ => return Err(ledger_corrupt()),
    }
    Ok(())
}

fn validate_existing_window_identity(
    window: &StoredLiveWindow,
    expected_window_id: &str,
    inbox_id: &str,
) -> Result<(), SafeError> {
    if window.window_id != expected_window_id || window.inbox_id != inbox_id {
        return Err(ledger_conflict());
    }
    Ok(())
}

fn validate_window_children(
    transaction: &Transaction<'_>,
    keyring: &super::Keyring,
    window: &StoredLiveWindow,
) -> Result<(), SafeError> {
    let outbox = load_outbox_batches(transaction, keyring, &window.window_id)?;
    let anchors = load_staged_anchors(transaction, keyring, &window.window_id)?;
    let ephemeral = load_staged_ephemeral(transaction, keyring, &window.window_id)?;
    validate_window_children_against_metadata(window, &outbox, &anchors, &ephemeral)
}

fn validate_window_children_against_metadata(
    window: &StoredLiveWindow,
    outbox: &[StoredOutboxBatch],
    anchors: &[StoredAnchor],
    ephemeral: &[StoredEphemeral],
) -> Result<(), SafeError> {
    if outbox.len() != usize::try_from(window.batch_count).map_err(|_| ledger_corrupt())? {
        return Err(ledger_corrupt());
    }
    if window.state == "collecting"
        && (!outbox.is_empty() || !anchors.is_empty() || !ephemeral.is_empty())
    {
        return Err(ledger_corrupt());
    }
    let accepted_count = outbox.iter().filter(|row| row.state == "accepted").count();
    if i64::try_from(accepted_count).map_err(|_| ledger_corrupt())? != window.accepted_count {
        return Err(ledger_corrupt());
    }
    match window.state.as_str() {
        "pending" if outbox.iter().any(|row| row.state == "quarantined") => {
            return Err(ledger_corrupt());
        }
        "committed" if outbox.iter().any(|row| row.state != "accepted") => {
            return Err(ledger_corrupt());
        }
        "quarantined" if !outbox.iter().any(|row| row.state == "quarantined") => {
            return Err(ledger_corrupt());
        }
        _ => {}
    }
    for (ordinal, row) in outbox.iter().enumerate() {
        if row.ordinal != i64::try_from(ordinal).map_err(|_| ledger_corrupt())? {
            return Err(ledger_corrupt());
        }
    }
    Ok(())
}

fn validate_live_window_metadata(
    window: &StoredLiveWindow,
    outbox: &[StoredOutboxBatch],
    oldest: &super::RawSyncInbox,
) -> Result<(), SafeError> {
    let expected_checkpoint = SourceCheckpoint {
        kind: "matrix_sync_token_sha256".to_owned(),
        value: format!("sha256:{}", lowercase_hex(oldest.next_token_digest())),
    };
    let created_at = parse_stored_timestamp(&window.created_at).map_err(|_| ledger_corrupt())?;
    let mut common_metadata: Option<(String, String, String, String)> = None;

    for stored in outbox {
        let request = batch::reparse_and_verify_request(stored.request.as_bytes())
            .map_err(|_| ledger_corrupt())?;
        let archived_at =
            parse_input_timestamp(&request.archived_at).map_err(|_| ledger_corrupt())?;
        if request.batch_id != stored.batch_row_id
            || request.source_checkpoint != expected_checkpoint
            || *oldest.observed_at() > archived_at
            || created_at > archived_at
        {
            return Err(ledger_corrupt());
        }

        let metadata = (
            request.tenant_id,
            request.gateway_route_id,
            request.archived_at,
            request.source_checkpoint.value,
        );
        if let Some(common) = common_metadata.as_ref() {
            if common != &metadata {
                return Err(ledger_corrupt());
            }
        } else {
            common_metadata = Some(metadata);
        }
    }
    Ok(())
}

fn load_outbox_batches(
    transaction: &Transaction<'_>,
    keyring: &super::Keyring,
    window_id: &str,
) -> Result<Vec<StoredOutboxBatch>, SafeError> {
    let limit = i64::try_from(MAX_WINDOW_BATCHES + 1).map_err(|_| ledger_corrupt())?;
    let mut statement = transaction
        .prepare(
            "SELECT batch_row_id, source_kind, window_id, backfill_job_id, ordinal, state,
                    request_cipher, request_nonce, request_key_version, request_sha256,
                    byte_count, attempt_count, next_attempt_at, accepted_at, terminal_code
             FROM outbox_batches
             WHERE window_id = ?1
             ORDER BY ordinal
             LIMIT ?2",
        )
        .map_err(|_| ledger_corrupt())?;
    let mut rows = statement
        .query(params![window_id, limit])
        .map_err(|_| ledger_corrupt())?;
    let mut result = Vec::new();
    while let Some(row) = rows.next().map_err(|_| ledger_corrupt())? {
        if result.len() >= MAX_WINDOW_BATCHES {
            return Err(ledger_corrupt());
        }
        result.push(read_and_verify_outbox(row, keyring, window_id)?);
    }
    Ok(result)
}

fn load_outbox_batch_by_id(
    transaction: &Transaction<'_>,
    keyring: &super::Keyring,
    row_id: &str,
) -> Result<Option<StoredOutboxBatch>, SafeError> {
    let mut statement = transaction
        .prepare(
            "SELECT batch_row_id, source_kind, window_id, backfill_job_id, ordinal, state,
                    request_cipher, request_nonce, request_key_version, request_sha256,
                    byte_count, attempt_count, next_attempt_at, accepted_at, terminal_code
             FROM outbox_batches WHERE batch_row_id = ?1 LIMIT 2",
        )
        .map_err(|_| ledger_corrupt())?;
    let mut rows = statement.query([row_id]).map_err(|_| ledger_corrupt())?;
    let Some(row) = rows.next().map_err(|_| ledger_corrupt())? else {
        return Ok(None);
    };
    let source_kind = read_text(row, 1, SOURCE_KIND_MAX_BYTES, |value| {
        matches!(value, "live" | "backfill")
    })?;
    if source_kind != "live" {
        return Ok(None);
    }
    let window_id = read_optional_text(row, 2, MAX_LEDGER_ID_BYTES, valid_window_id)?
        .ok_or_else(ledger_corrupt)?;
    if read_optional_text(row, 3, MAX_LEDGER_ID_BYTES, |_| true)?.is_some() {
        return Err(ledger_corrupt());
    }
    let result = read_and_verify_outbox(row, keyring, &window_id)?;
    if rows.next().map_err(|_| ledger_corrupt())?.is_some() {
        return Err(ledger_corrupt());
    }
    Ok(Some(result))
}

fn outbox_window_id(
    transaction: &Transaction<'_>,
    row_id: &str,
) -> Result<Option<String>, SafeError> {
    let mut statement = transaction
        .prepare(
            "SELECT source_kind, window_id, backfill_job_id
             FROM outbox_batches WHERE batch_row_id = ?1 LIMIT 2",
        )
        .map_err(|_| ledger_corrupt())?;
    let mut rows = statement.query([row_id]).map_err(|_| ledger_corrupt())?;
    let Some(row) = rows.next().map_err(|_| ledger_corrupt())? else {
        return Ok(None);
    };
    let source_kind = read_text(row, 0, SOURCE_KIND_MAX_BYTES, |value| {
        matches!(value, "live" | "backfill")
    })?;
    let window_id = read_optional_text(row, 1, MAX_LEDGER_ID_BYTES, valid_window_id)?;
    let backfill_job_id = read_optional_text(row, 2, MAX_LEDGER_ID_BYTES, |_| true)?;
    if rows.next().map_err(|_| ledger_corrupt())?.is_some() {
        return Err(ledger_corrupt());
    }
    if source_kind != "live" {
        return Ok(None);
    }
    if window_id.is_none() || backfill_job_id.is_some() {
        return Err(ledger_corrupt());
    }
    Ok(window_id)
}

fn read_and_verify_outbox(
    row: &Row<'_>,
    keyring: &super::Keyring,
    expected_window_id: &str,
) -> Result<StoredOutboxBatch, SafeError> {
    let batch_row_id = read_text(row, 0, MAX_LEDGER_ID_BYTES, valid_batch_id)?;
    let source_kind = read_text(row, 1, SOURCE_KIND_MAX_BYTES, |value| value == "live")?;
    let stored_window_id = read_text(row, 2, MAX_LEDGER_ID_BYTES, valid_window_id)?;
    let backfill_job_id = read_optional_text(row, 3, MAX_LEDGER_ID_BYTES, |_| true)?;
    if source_kind != "live" || stored_window_id != expected_window_id || backfill_job_id.is_some()
    {
        return Err(ledger_corrupt());
    }
    let ordinal = read_integer(row, 4, 0, i64::try_from(MAX_WINDOW_BATCHES - 1).unwrap())?;
    let state = read_text(row, 5, OUTBOX_STATE_MAX_BYTES, valid_outbox_state)?;
    let byte_count_i64 = read_integer(
        row,
        10,
        1,
        i64::try_from(MAX_BATCH_CANONICAL_BYTES).map_err(|_| ledger_corrupt())?,
    )?;
    let byte_count = usize::try_from(byte_count_i64).map_err(|_| ledger_corrupt())?;
    let ciphertext = read_blob(
        row,
        6,
        AEAD_TAG_BYTES,
        byte_count
            .checked_add(AEAD_TAG_BYTES)
            .ok_or_else(ledger_corrupt)?,
    )?;
    let nonce = read_blob(row, 7, 24, 24)?;
    let key_version = read_integer(row, 8, 1, i64::from(u32::MAX))?;
    let request_sha256 = digest_from_blob(&read_blob(row, 9, 32, 32)?)?;
    let attempt_count = read_integer(row, 11, 0, OUTBOX_ATTEMPT_COUNT_MAX)?;
    let next_attempt_at_text = read_text(row, 12, 64, valid_stored_utc_millisecond)?;
    let accepted_at = read_optional_text(row, 13, 64, valid_stored_utc_millisecond)?;
    let terminal_code = read_optional_text(row, 14, 64, valid_stored_reason_code)?;
    let next_attempt_at =
        parse_stored_timestamp(&next_attempt_at_text).map_err(|_| ledger_corrupt())?;
    if let Some(accepted_at) = accepted_at.as_deref() {
        parse_stored_timestamp(accepted_at).map_err(|_| ledger_corrupt())?;
    }
    validate_outbox_lifecycle(
        &state,
        accepted_at.is_some(),
        terminal_code.is_some(),
        attempt_count,
        &next_attempt_at_text,
    )?;
    let plaintext = open_stored_value(
        keyring,
        StoredValue {
            table: "outbox_batches",
            row_id: &batch_row_id,
            column: "request",
            ciphertext: Some(ciphertext.as_slice()),
            nonce: Some(nonce.as_slice()),
            key_version: Some(key_version),
            max_plaintext_bytes: MAX_BATCH_CANONICAL_BYTES,
        },
    )
    .map_err(|_| ledger_corrupt())?;
    if plaintext.len() != byte_count
        || sha256(plaintext.as_bytes()) != request_sha256
        || batch::reparse_and_verify_request(plaintext.as_bytes()).is_err()
    {
        return Err(ledger_corrupt());
    }
    let request =
        batch::reparse_and_verify_request(plaintext.as_bytes()).map_err(|_| ledger_corrupt())?;
    if request.batch_id != batch_row_id
        || request.source_checkpoint.kind != "matrix_sync_token_sha256"
    {
        return Err(ledger_corrupt());
    }
    Ok(StoredOutboxBatch {
        batch_row_id,
        ordinal,
        state,
        request: SecretBytes::new(plaintext.as_bytes().to_vec()),
        request_sha256,
        byte_count,
        attempt_count: u32::try_from(attempt_count).map_err(|_| ledger_corrupt())?,
        next_attempt_at,
        next_attempt_at_text,
        accepted_at: accepted_at
            .as_deref()
            .map(parse_stored_timestamp)
            .transpose()
            .map_err(|_| ledger_corrupt())?,
        terminal_code,
    })
}

fn validate_outbox_lifecycle(
    state: &str,
    accepted: bool,
    terminal: bool,
    attempt_count: i64,
    next_attempt_at: &str,
) -> Result<(), SafeError> {
    if !valid_stored_utc_millisecond(next_attempt_at) || attempt_count < 0 {
        return Err(ledger_corrupt());
    }
    match (state, accepted, terminal) {
        ("pending", false, false) | ("accepted", true, false) | ("quarantined", false, true) => {}
        _ => return Err(ledger_corrupt()),
    }
    Ok(())
}

fn load_staged_anchors(
    transaction: &Transaction<'_>,
    keyring: &super::Keyring,
    window_id: &str,
) -> Result<Vec<StoredAnchor>, SafeError> {
    let limit = i64::try_from(MAX_WINDOW_ROOM_CANDIDATES + 1).map_err(|_| ledger_corrupt())?;
    let mut statement = transaction
        .prepare(
            "SELECT room_lookup, anchor_event_cipher, anchor_event_nonce, key_version
             FROM window_room_anchors WHERE window_id = ?1 ORDER BY room_lookup LIMIT ?2",
        )
        .map_err(|_| ledger_corrupt())?;
    let mut rows = statement
        .query(params![window_id, limit])
        .map_err(|_| ledger_corrupt())?;
    let mut result = Vec::new();
    let mut lookups = HashSet::new();
    while let Some(row) = rows.next().map_err(|_| ledger_corrupt())? {
        if result.len() >= MAX_WINDOW_ROOM_CANDIDATES {
            return Err(ledger_corrupt());
        }
        let lookup = digest_from_blob(&read_blob(row, 0, 32, 32)?)?;
        if !lookups.insert(lookup) {
            return Err(ledger_corrupt());
        }
        let ciphertext = read_blob(row, 1, AEAD_TAG_BYTES, MAX_CIPHER_ANCHOR_BYTES)?;
        let nonce = read_blob(row, 2, 24, 24)?;
        let key_version = read_integer(row, 3, 1, i64::from(u32::MAX))?;
        let row_id = candidate_row_id(window_id, &lookup);
        let plaintext = open_stored_value(
            keyring,
            StoredValue {
                table: "window_room_anchors",
                row_id: &row_id,
                column: "anchor_event",
                ciphertext: Some(ciphertext.as_slice()),
                nonce: Some(nonce.as_slice()),
                key_version: Some(key_version),
                max_plaintext_bytes: MAX_ANCHOR_BYTES,
            },
        )
        .map_err(|_| ledger_corrupt())?;
        if plaintext.is_empty() || plaintext.len() > MAX_ANCHOR_BYTES {
            return Err(ledger_corrupt());
        }
        result.push(StoredAnchor {
            room_lookup: lookup,
            value: SecretBytes::new(plaintext.as_bytes().to_vec()),
        });
    }
    Ok(result)
}

fn load_staged_ephemeral(
    transaction: &Transaction<'_>,
    keyring: &super::Keyring,
    window_id: &str,
) -> Result<Vec<StoredEphemeral>, SafeError> {
    let limit = i64::try_from(MAX_WINDOW_ROOM_CANDIDATES + 1).map_err(|_| ledger_corrupt())?;
    let mut statement = transaction
        .prepare(
            "SELECT room_lookup, typing_set_cipher, typing_set_nonce, key_version,
                    typing_expires_at
             FROM window_room_ephemeral WHERE window_id = ?1 ORDER BY room_lookup LIMIT ?2",
        )
        .map_err(|_| ledger_corrupt())?;
    let mut rows = statement
        .query(params![window_id, limit])
        .map_err(|_| ledger_corrupt())?;
    let mut result = Vec::new();
    let mut lookups = HashSet::new();
    while let Some(row) = rows.next().map_err(|_| ledger_corrupt())? {
        if result.len() >= MAX_WINDOW_ROOM_CANDIDATES {
            return Err(ledger_corrupt());
        }
        let lookup = digest_from_blob(&read_blob(row, 0, 32, 32)?)?;
        if !lookups.insert(lookup) {
            return Err(ledger_corrupt());
        }
        let ciphertext = read_blob(row, 1, AEAD_TAG_BYTES, MAX_CIPHER_ANCHOR_BYTES)?;
        let nonce = read_blob(row, 2, 24, 24)?;
        let key_version = read_integer(row, 3, 1, i64::from(u32::MAX))?;
        let expires_at = read_text(row, 4, 64, valid_stored_utc_millisecond)?;
        let typing_expires_at =
            parse_stored_timestamp(&expires_at).map_err(|_| ledger_corrupt())?;
        let row_id = candidate_row_id(window_id, &lookup);
        let plaintext = open_stored_value(
            keyring,
            StoredValue {
                table: "window_room_ephemeral",
                row_id: &row_id,
                column: "typing_set",
                ciphertext: Some(ciphertext.as_slice()),
                nonce: Some(nonce.as_slice()),
                key_version: Some(key_version),
                max_plaintext_bytes: MAX_ANCHOR_BYTES,
            },
        )
        .map_err(|_| ledger_corrupt())?;
        if plaintext.is_empty() || plaintext.len() > MAX_ANCHOR_BYTES {
            return Err(ledger_corrupt());
        }
        result.push(StoredEphemeral {
            room_lookup: lookup,
            value: SecretBytes::new(plaintext.as_bytes().to_vec()),
            typing_expires_at,
        });
    }
    Ok(result)
}

fn same_prepared_input(
    existing: &StoredLiveWindow,
    outbox: &[StoredOutboxBatch],
    stored_anchors: &[StoredAnchor],
    stored_ephemeral: &[StoredEphemeral],
    window: &BatchWindow,
    anchors: &[RoomAnchorCandidate],
    ephemeral: &[RoomEphemeralCandidate],
) -> Result<bool, SafeError> {
    if existing.state != "pending" && existing.state != "committed" {
        return Ok(false);
    }
    if existing.state == "pending" && existing.committed_at.is_some() {
        return Err(ledger_corrupt());
    }
    if existing.state == "committed" && existing.committed_at.is_none() {
        return Err(ledger_corrupt());
    }
    if existing.batch_count != i64::try_from(window.batches.len()).map_err(|_| ledger_invalid())?
        || existing.accepted_count > existing.batch_count
        || outbox.len() != window.batches.len()
        || existing.created_at.is_empty()
    {
        return Ok(false);
    }
    for (ordinal, (expected, stored)) in window.batches.iter().zip(outbox).enumerate() {
        if stored.batch_row_id != expected.batch_id
            || stored.ordinal != i64::try_from(ordinal).map_err(|_| ledger_corrupt())?
            || stored.byte_count != expected.exact_request_bytes().len()
            || stored.request.as_bytes() != expected.exact_request_bytes()
            || stored.request_sha256 != batch_digest(expected.exact_request_bytes())
        {
            return Ok(false);
        }
    }
    if stored_anchors.len() != anchors.len() || stored_ephemeral.len() != ephemeral.len() {
        return Ok(false);
    }
    for candidate in anchors {
        let lookup: [u8; 32] = candidate
            .room_lookup()
            .try_into()
            .map_err(|_| ledger_corrupt())?;
        let Some(stored) = stored_anchors.iter().find(|row| row.room_lookup == lookup) else {
            return Ok(false);
        };
        if stored.value.as_bytes() != candidate.anchor_event().as_bytes() {
            return Ok(false);
        }
    }
    for candidate in ephemeral {
        let lookup: [u8; 32] = candidate
            .room_lookup()
            .try_into()
            .map_err(|_| ledger_corrupt())?;
        let Some(stored) = stored_ephemeral
            .iter()
            .find(|row| row.room_lookup == lookup)
        else {
            return Ok(false);
        };
        if stored.value.as_bytes() != candidate.typing_set().as_bytes()
            || stored.typing_expires_at != *candidate.typing_expires_at()
        {
            return Ok(false);
        }
    }
    if existing
        .committed_at
        .as_deref()
        .is_some_and(|value| !valid_stored_utc_millisecond(value))
    {
        return Err(ledger_corrupt());
    }
    Ok(true)
}

fn parse_input_timestamp(value: &str) -> Result<DateTime<Utc>, SafeError> {
    if !crate::model::valid_timestamp(value) {
        return Err(ledger_invalid());
    }
    let parsed = DateTime::parse_from_rfc3339(value).map_err(|_| ledger_invalid())?;
    if parsed.offset().local_minus_utc() != 0
        || !parsed.timestamp_subsec_nanos().is_multiple_of(1_000_000)
    {
        return Err(ledger_invalid());
    }
    Ok(parsed.with_timezone(&Utc))
}

fn valid_source_checkpoint(checkpoint: &SourceCheckpoint) -> bool {
    checkpoint.kind == "matrix_sync_token_sha256"
        && checkpoint.value.len() == "sha256:".len() + 64
        && checkpoint.value.starts_with("sha256:")
        && checkpoint.value["sha256:".len()..]
            .bytes()
            .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
}

fn valid_digest_id(value: &str, prefix: &str) -> bool {
    value.len() == prefix.len() + 64
        && value.len() <= MAX_LEDGER_ID_BYTES
        && value.starts_with(prefix)
        && value[prefix.len()..]
            .bytes()
            .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
}

fn valid_window_id(value: &str) -> bool {
    valid_digest_id(value, "window_")
}

fn valid_batch_id(value: &str) -> bool {
    valid_digest_id(value, "batch_")
}

fn valid_job_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= MAX_LEDGER_ID_BYTES
        && (crate::model::valid_resource_id(value) || valid_uuid_v7(value))
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

fn valid_job_kind(value: &str) -> bool {
    matches!(value, "live_gap" | "explicit")
}

fn valid_backfill_state(value: &str) -> bool {
    matches!(
        value,
        "pending" | "running" | "completed" | "cancelled" | "quarantined"
    )
}

fn valid_window_state(value: &str) -> bool {
    matches!(
        value,
        "collecting" | "pending" | "committed" | "quarantined"
    )
}

fn valid_outbox_state(value: &str) -> bool {
    matches!(value, "pending" | "accepted" | "quarantined")
}

fn candidate_row_id(window_id: &str, room_lookup: &[u8]) -> String {
    format!("{window_id}:{}", lowercase_hex(room_lookup))
}

fn digest_from_blob(value: &[u8]) -> Result<[u8; 32], SafeError> {
    value.try_into().map_err(|_| ledger_corrupt())
}

fn sha256(bytes: &[u8]) -> [u8; 32] {
    use sha2::{Digest, Sha256};
    Sha256::digest(bytes).into()
}

fn batch_digest(bytes: &[u8]) -> [u8; 32] {
    sha256(bytes)
}

fn read_text(
    row: &Row<'_>,
    index: usize,
    max_bytes: usize,
    validator: fn(&str) -> bool,
) -> Result<String, SafeError> {
    let bytes = row.get_ref(index).map_err(|_| ledger_corrupt())?;
    let bytes = match bytes {
        ValueRef::Text(bytes) if bytes.len() <= max_bytes => bytes,
        _ => return Err(ledger_corrupt()),
    };
    let value = std::str::from_utf8(bytes).map_err(|_| ledger_corrupt())?;
    if !validator(value) {
        return Err(ledger_corrupt());
    }
    Ok(value.to_owned())
}

fn read_optional_text(
    row: &Row<'_>,
    index: usize,
    max_bytes: usize,
    validator: fn(&str) -> bool,
) -> Result<Option<String>, SafeError> {
    let bytes = row.get_ref(index).map_err(|_| ledger_corrupt())?;
    let bytes = match bytes {
        ValueRef::Null => return Ok(None),
        ValueRef::Text(bytes) if bytes.len() <= max_bytes => bytes,
        _ => return Err(ledger_corrupt()),
    };
    let value = std::str::from_utf8(bytes).map_err(|_| ledger_corrupt())?;
    if !validator(value) {
        return Err(ledger_corrupt());
    }
    Ok(Some(value.to_owned()))
}

fn read_integer(row: &Row<'_>, index: usize, min: i64, max: i64) -> Result<i64, SafeError> {
    match row.get_ref(index).map_err(|_| ledger_corrupt())? {
        ValueRef::Integer(value) if (min..=max).contains(&value) => Ok(value),
        _ => Err(ledger_corrupt()),
    }
}

fn read_blob(
    row: &Row<'_>,
    index: usize,
    min_bytes: usize,
    max_bytes: usize,
) -> Result<Vec<u8>, SafeError> {
    match row.get_ref(index).map_err(|_| ledger_corrupt())? {
        ValueRef::Blob(bytes) if (min_bytes..=max_bytes).contains(&bytes.len()) => {
            Ok(bytes.to_vec())
        }
        _ => Err(ledger_corrupt()),
    }
}

fn read_optional_blob(
    row: &Row<'_>,
    index: usize,
    min_bytes: usize,
    max_bytes: usize,
) -> Result<Option<Vec<u8>>, SafeError> {
    match row.get_ref(index).map_err(|_| ledger_corrupt())? {
        ValueRef::Null => Ok(None),
        ValueRef::Blob(bytes) if (min_bytes..=max_bytes).contains(&bytes.len()) => {
            Ok(Some(bytes.to_vec()))
        }
        _ => Err(ledger_corrupt()),
    }
}

const MAX_ANCHOR_BYTES: usize = crate::store_types::MAX_ROOM_ANCHOR_BYTES;
const MAX_CIPHER_ANCHOR_BYTES: usize = MAX_ANCHOR_BYTES + AEAD_TAG_BYTES;

fn map_storage_error(error: SafeError) -> SafeError {
    match error.code() {
        super::STORE_NOT_BOOTSTRAPPED
        | super::STORE_CRYPTO_NOT_READY
        | super::STORE_CRYPTO_UNRESOLVED
        | super::STORE_CRYPTO_CONFLICT => ledger_not_ready(),
        super::STORE_SYNC_INVALID | super::STORE_CRYPTO_INVALID => ledger_invalid(),
        super::STORE_SYNC_CORRUPT | super::STORE_CRYPTO_CORRUPT => ledger_corrupt(),
        _ => ledger_corrupt(),
    }
}

fn ledger_invalid() -> SafeError {
    SafeError::new(STORE_LEDGER_INVALID)
}

fn ledger_too_large() -> SafeError {
    SafeError::new(STORE_LEDGER_TOO_LARGE)
}

fn ledger_conflict() -> SafeError {
    SafeError::new(STORE_LEDGER_CONFLICT)
}

fn ledger_not_ready() -> SafeError {
    SafeError::new(STORE_LEDGER_NOT_READY)
}

fn ledger_cas_mismatch() -> SafeError {
    SafeError::new(STORE_LEDGER_CAS_MISMATCH)
}

fn ledger_corrupt() -> SafeError {
    SafeError::new(STORE_LEDGER_CORRUPT)
}
