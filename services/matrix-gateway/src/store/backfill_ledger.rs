//! Explicit backfill job creation and ownership transactions.

use std::str;

use chrono::DateTime;
use rusqlite::{Row, TransactionBehavior, params, types::ValueRef};
use zeroize::Zeroizing;

use crate::{
    batch::BackfillJob,
    crypto::{AEAD_TAG_BYTES, Sealed},
    ledger::{
        BackfillState, MAX_BACKFILL_PAGINATION_BYTES, MAX_BACKFILL_PARAMETERS_BYTES,
        MAX_LEDGER_ID_BYTES, NewBackfillJob, STORE_BACKFILL_CONFLICT, STORE_BACKFILL_CORRUPT,
        STORE_BACKFILL_INVALID, STORE_BACKFILL_NOT_READY, StoredBackfillJob,
    },
    model,
    secret::SafeError,
};

use super::Store;

const BACKFILL_KIND_EXPLICIT: &str = "explicit";
const BACKFILL_KIND_LIVE_GAP: &str = "live_gap";
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
    parameters: Zeroizing<Vec<u8>>,
    pagination: Option<Zeroizing<Vec<u8>>>,
    accepted_events: u64,
    created_at: String,
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
}

fn load_backfill_row(
    connection: &rusqlite::Connection,
    job_id: &str,
) -> Result<Option<StoredBackfillRow>, SafeError> {
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

    if state == BackfillState::Pending && (accepted_events != 0 || pagination.is_some()) {
        return Err(backfill_corrupt());
    }

    Ok(VerifiedBackfillRow {
        job,
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
    if value.len() != 36
        || ![8_usize, 13, 18, 23]
            .into_iter()
            .all(|index| value.as_bytes().get(index) == Some(&b'-'))
        || value.as_bytes().get(14) != Some(&b'7')
        || !matches!(value.as_bytes().get(19), Some(b'8'..=b'9' | b'a'..=b'b'))
        || value.as_bytes().iter().enumerate().any(|(index, byte)| {
            ![8_usize, 13, 18, 23].contains(&index) && !matches!(*byte, b'0'..=b'9' | b'a'..=b'f')
        })
    {
        return Err(backfill_invalid());
    }
    Ok(())
}

fn validate_timestamp(value: &str) -> Result<(), SafeError> {
    if !model::valid_timestamp(value)
        || DateTime::parse_from_rfc3339(value).is_err()
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
