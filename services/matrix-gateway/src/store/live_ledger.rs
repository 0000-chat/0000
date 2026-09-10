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
    ledger::{
        BackfillState, FinalizeOutcome, MAX_BACKFILL_PAGINATION_BYTES,
        MAX_BACKFILL_PARAMETERS_BYTES, MAX_LEDGER_ID_BYTES, MAX_WINDOW_BATCHES,
        MAX_WINDOW_ROOM_CANDIDATES, NewLiveGapJob, NewLiveWindow, RoomAnchorCandidate,
        RoomEphemeralCandidate, STORE_LEDGER_CONFLICT, STORE_LEDGER_CORRUPT, STORE_LEDGER_INVALID,
        STORE_LEDGER_NOT_READY, STORE_LEDGER_TOO_LARGE, StoredLiveGapJob,
    },
    secret::{SafeError, SecretBytes},
    store_types::{InboxId, SyncInboxState},
};

use super::{
    Store, StoredValue, load_crypto_context, lowercase_hex, open_stored_value,
    parse_stored_timestamp, valid_stored_inbox_id, valid_stored_reason_code,
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
            if window.batch_count > 0
                && window.accepted_count == window.batch_count
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
    let next_attempt_at = read_text(row, 12, 64, valid_stored_utc_millisecond)?;
    let accepted_at = read_optional_text(row, 13, 64, valid_stored_utc_millisecond)?;
    let terminal_code = read_optional_text(row, 14, 64, valid_stored_reason_code)?;
    validate_outbox_lifecycle(
        &state,
        accepted_at.is_some(),
        terminal_code.is_some(),
        attempt_count,
        &next_attempt_at,
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

fn ledger_corrupt() -> SafeError {
    SafeError::new(STORE_LEDGER_CORRUPT)
}
