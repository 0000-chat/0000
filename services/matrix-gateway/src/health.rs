//! Read-only, content-free inspection of the gateway state database.

use std::{fmt, path::Path, str, time::Duration};

use chrono::{DateTime, Duration as ChronoDuration, Utc};
use rusqlite::{
    Connection, Error as SqliteError, ErrorCode, OpenFlags, Row, Transaction, TransactionBehavior,
    types::ValueRef,
};

use crate::config::{
    MAX_BATCH_CANONICAL_BYTES, MAX_PENDING_AGE_SECS, MAX_PENDING_REQUEST_ROWS, MAX_RECOVERY_BYTES,
    MAX_SYNC_RESPONSE_BYTES,
};
use crate::crypto_outbox::MAX_MATRIX_CRYPTO_REQUEST_BYTES;

/// Stable error returned when the health database cannot be opened.
pub const HEALTH_DATABASE_UNAVAILABLE: &str = "health_database_unavailable";
/// Stable error returned when the health database is busy.
pub const HEALTH_DATABASE_BUSY: &str = "health_database_busy";

const HEALTH_BUSY_TIMEOUT: Duration = Duration::from_millis(100);

/// A stable, content-free health inspection error.
#[derive(Clone, Copy, Eq, PartialEq)]
pub struct HealthError {
    code: &'static str,
}

impl HealthError {
    const fn new(code: &'static str) -> Self {
        Self { code }
    }

    /// Return the stable machine-readable error code.
    pub const fn code(self) -> &'static str {
        self.code
    }
}

impl fmt::Debug for HealthError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("HealthError")
            .field("code", &self.code)
            .finish()
    }
}

impl fmt::Display for HealthError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.code)
    }
}

impl std::error::Error for HealthError {}

/// The bounded result of one local health inspection.
pub struct HealthReport {
    session: SessionState,
    inbox_state: LimitState,
    outbox_state: LimitState,
    maintenance_code: Option<&'static str>,
    terminal_quarantine: bool,
}

impl HealthReport {
    /// Serialize the report as one compact JSON object.
    pub fn to_json(&self) -> String {
        let maintenance_code = self
            .maintenance_code
            .map_or_else(|| "null".to_owned(), |code| format!("\"{code}\""));
        format!(
            r#"{{"schema_version":1,"status":"{}","session":"{}","inbox_state":"{}","outbox_state":"{}","maintenance_code":{},"terminal_quarantine":{}}}"#,
            self.status().as_str(),
            self.session.as_str(),
            self.inbox_state.as_str(),
            self.outbox_state.as_str(),
            maintenance_code,
            self.terminal_quarantine,
        )
    }

    /// Return whether the inspected state is healthy.
    pub const fn is_healthy(&self) -> bool {
        matches!(self.status(), HealthStatus::Healthy)
    }

    /// Return the process exit code a future healthcheck command should use.
    pub const fn exit_code(&self) -> i32 {
        if self.is_healthy() { 0 } else { 1 }
    }

    const fn status(&self) -> HealthStatus {
        if self.session.is_present()
            && self.inbox_state.is_within_limits()
            && self.outbox_state.is_within_limits()
            && self.maintenance_code.is_none()
            && !self.terminal_quarantine
        {
            HealthStatus::Healthy
        } else {
            HealthStatus::Blocked
        }
    }
}

#[derive(Clone, Copy, Eq, PartialEq)]
enum HealthStatus {
    Healthy,
    Blocked,
}

impl HealthStatus {
    const fn as_str(self) -> &'static str {
        match self {
            Self::Healthy => "healthy",
            Self::Blocked => "blocked",
        }
    }
}

#[derive(Clone, Copy, Eq, PartialEq)]
enum SessionState {
    Present,
    Missing,
}

impl SessionState {
    const fn as_str(self) -> &'static str {
        match self {
            Self::Present => "present",
            Self::Missing => "missing",
        }
    }

    const fn is_present(self) -> bool {
        matches!(self, Self::Present)
    }
}

#[derive(Clone, Copy, Eq, PartialEq)]
enum LimitState {
    WithinLimits,
    RowsExceeded,
    BytesExceeded,
    AgeExceeded,
    Corrupt,
}

impl LimitState {
    const fn as_str(self) -> &'static str {
        match self {
            Self::WithinLimits => "within_limits",
            Self::RowsExceeded => "rows_exceeded",
            Self::BytesExceeded => "bytes_exceeded",
            Self::AgeExceeded => "age_exceeded",
            Self::Corrupt => "corrupt",
        }
    }

    const fn is_within_limits(self) -> bool {
        matches!(self, Self::WithinLimits)
    }
}

/// Inspect the state database at a caller-supplied UTC time.
pub fn inspect_at(path: impl AsRef<Path>, now: DateTime<Utc>) -> Result<HealthReport, HealthError> {
    let mut connection = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(map_query_error)?;
    connection
        .busy_timeout(HEALTH_BUSY_TIMEOUT)
        .map_err(map_query_error)?;
    connection
        .pragma_update(None, "query_only", true)
        .map_err(map_query_error)?;

    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Deferred)
        .map_err(map_query_error)?;
    let session = match session_present(&transaction) {
        Ok(true) => SessionState::Present,
        Ok(false) => SessionState::Missing,
        Err(error) if error.code() == HEALTH_DATABASE_BUSY => return Err(error),
        Err(_) => SessionState::Missing,
    };
    let (maintenance_code, maintenance_corrupt) = match maintenance_state(&transaction) {
        Ok(code) => (code, false),
        Err(error) if error.code() == HEALTH_DATABASE_BUSY => return Err(error),
        Err(_) => (None, true),
    };
    let outbox_pressure = match pending_outbox_pressure(&transaction) {
        Ok(pressure) => Some(pressure),
        Err(error) if error.code() == HEALTH_DATABASE_BUSY => return Err(error),
        Err(_) => None,
    };
    let inbox_pressure = match inbox_crypto_pressure(&transaction) {
        Ok(pressure) => Some(pressure),
        Err(error) if error.code() == HEALTH_DATABASE_BUSY => return Err(error),
        Err(_) => None,
    };
    let (mut inbox_state, mut outbox_state) =
        combined_pressure_states(inbox_pressure.as_ref(), outbox_pressure.as_ref(), now);
    if maintenance_corrupt {
        inbox_state = LimitState::Corrupt;
        outbox_state = LimitState::Corrupt;
    }
    let terminal_quarantine = inbox_pressure
        .as_ref()
        .is_some_and(|pressure| pressure.terminal_quarantine)
        || outbox_pressure
            .as_ref()
            .is_some_and(|pressure| pressure.terminal_quarantine);
    transaction.commit().map_err(map_query_error)?;

    Ok(HealthReport {
        session,
        inbox_state,
        outbox_state,
        maintenance_code,
        terminal_quarantine,
    })
}

fn session_present(transaction: &Transaction<'_>) -> Result<bool, HealthError> {
    let row = transaction
        .query_row(
            "SELECT COUNT(*),
                    COALESCE(SUM(CASE
                        WHEN singleton = 1
                         AND typeof(session_cipher) = 'blob'
                         AND length(session_cipher) > 0
                        THEN 1 ELSE 0 END), 0)
             FROM gateway_state",
            [],
            |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?)),
        )
        .map_err(map_query_error)?;
    Ok(row.0 == 1 && row.1 == 1)
}

fn maintenance_state(transaction: &Transaction<'_>) -> Result<Option<&'static str>, HealthError> {
    let mut statement = transaction
        .prepare("SELECT maintenance_code, maintenance_since FROM gateway_state")
        .map_err(map_query_error)?;
    let mut rows = statement.query([]).map_err(map_query_error)?;
    let mut result = None;
    while let Some(row) = rows.next().map_err(map_query_error)? {
        if result.is_some() {
            return Err(corrupt_error());
        }
        let code = optional_text_value(row, 0)?;
        let since = optional_text_value(row, 1)?;
        result = match (code, since) {
            (None, None) => Some(None),
            (Some(code), Some(since)) => {
                let code = match code {
                    "crypto_maintenance_required" => "crypto_maintenance_required",
                    "matrix_crypto_kind_not_allowed" => "matrix_crypto_kind_not_allowed",
                    "matrix_crypto_ack_unrecoverable" => "matrix_crypto_ack_unrecoverable",
                    _ => return Err(corrupt_error()),
                };
                parse_timestamp_value(since)?;
                Some(Some(code))
            }
            _ => return Err(corrupt_error()),
        };
    }
    Ok(result.flatten())
}

struct OutboxPressure {
    pending_rows: u64,
    pending_bytes: u64,
    oldest_pending_at: Option<DateTime<Utc>>,
    terminal_quarantine: bool,
}

impl OutboxPressure {
    fn state(&self, now: DateTime<Utc>) -> LimitState {
        if self.pending_rows >= MAX_PENDING_REQUEST_ROWS {
            return LimitState::RowsExceeded;
        }
        if self.pending_bytes >= MAX_RECOVERY_BYTES {
            return LimitState::BytesExceeded;
        }
        if self.oldest_pending_at.is_some_and(|oldest| {
            now.signed_duration_since(oldest) > ChronoDuration::seconds(MAX_PENDING_AGE_SECS as i64)
        }) {
            return LimitState::AgeExceeded;
        }
        LimitState::WithinLimits
    }
}

fn combined_pressure_states(
    inbox: Option<&OutboxPressure>,
    outbox: Option<&OutboxPressure>,
    now: DateTime<Utc>,
) -> (LimitState, LimitState) {
    let Some(inbox) = inbox else {
        return (
            LimitState::Corrupt,
            outbox.map_or(LimitState::Corrupt, |pressure| pressure.state(now)),
        );
    };
    let Some(outbox) = outbox else {
        return (inbox.state(now), LimitState::Corrupt);
    };

    let mut inbox_state = inbox.state(now);
    let mut outbox_state = outbox.state(now);
    let Some(combined_rows) = inbox.pending_rows.checked_add(outbox.pending_rows) else {
        return (LimitState::Corrupt, LimitState::Corrupt);
    };
    let Some(combined_bytes) = inbox.pending_bytes.checked_add(outbox.pending_bytes) else {
        return (LimitState::Corrupt, LimitState::Corrupt);
    };

    if combined_rows >= MAX_PENDING_REQUEST_ROWS
        && inbox.pending_rows < MAX_PENDING_REQUEST_ROWS
        && outbox.pending_rows < MAX_PENDING_REQUEST_ROWS
    {
        inbox_state = shared_limit_state(inbox_state, LimitState::RowsExceeded);
        outbox_state = shared_limit_state(outbox_state, LimitState::RowsExceeded);
    } else if combined_bytes >= MAX_RECOVERY_BYTES
        && inbox.pending_bytes < MAX_RECOVERY_BYTES
        && outbox.pending_bytes < MAX_RECOVERY_BYTES
    {
        inbox_state = shared_limit_state(inbox_state, LimitState::BytesExceeded);
        outbox_state = shared_limit_state(outbox_state, LimitState::BytesExceeded);
    }
    (inbox_state, outbox_state)
}

fn shared_limit_state(current: LimitState, shared: LimitState) -> LimitState {
    if current == LimitState::Corrupt {
        current
    } else {
        shared
    }
}

fn inbox_crypto_pressure(transaction: &Transaction<'_>) -> Result<OutboxPressure, HealthError> {
    let mut statement = transaction
        .prepare(
            "SELECT inbox_id, byte_count, state, observed_at, terminal_code
             FROM sync_inbox",
        )
        .map_err(map_query_error)?;
    let mut rows = statement.query([]).map_err(map_query_error)?;
    let mut pending_bytes = 0_u64;
    let mut oldest_pending_at = None;
    let mut terminal_quarantine = false;

    while let Some(row) = rows.next().map_err(map_query_error)? {
        let _inbox_id = text_value(row, 0)?;
        let byte_count = u64::try_from(bounded_integer(row, 1, 1, MAX_SYNC_RESPONSE_BYTES as i64)?)
            .map_err(|_| corrupt_error())?;
        let state = text_value(row, 2)?;
        if !matches!(
            state,
            "fetched" | "sdk_processed" | "prepared" | "committed" | "quarantined"
        ) {
            return Err(corrupt_error());
        }
        let observed_at = timestamp_value(row, 3)?;
        terminal_quarantine |= terminal_state(row, 4, state)?;
        pending_bytes = pending_bytes
            .checked_add(byte_count)
            .ok_or_else(corrupt_error)?;
        if matches!(state, "fetched" | "sdk_processed" | "prepared") {
            oldest_pending_at = Some(
                oldest_pending_at
                    .map_or(observed_at, |oldest: DateTime<Utc>| oldest.min(observed_at)),
            );
        }
    }

    let mut statement = transaction
        .prepare(
            "SELECT c.inbox_id, c.state, c.byte_count, c.next_attempt_at,
                    i.observed_at, c.terminal_code
             FROM matrix_crypto_outbox AS c
             LEFT JOIN sync_inbox AS i ON i.inbox_id = c.inbox_id",
        )
        .map_err(map_query_error)?;
    let mut rows = statement.query([]).map_err(map_query_error)?;
    let mut pending_rows = 0_u64;

    while let Some(row) = rows.next().map_err(map_query_error)? {
        let _inbox_id = text_value(row, 0)?;
        let state = text_value(row, 1)?;
        if !matches!(
            state,
            "pending" | "response_received" | "accepted" | "quarantined"
        ) {
            return Err(corrupt_error());
        }
        let byte_count = u64::try_from(bounded_integer(
            row,
            2,
            1,
            MAX_MATRIX_CRYPTO_REQUEST_BYTES as i64,
        )?)
        .map_err(|_| corrupt_error())?;
        let _next_attempt_at = timestamp_value(row, 3)?;
        let parent_observed_at = timestamp_value(row, 4)?;
        terminal_quarantine |= terminal_state(row, 5, state)?;
        if matches!(state, "pending" | "response_received") {
            pending_rows = pending_rows.checked_add(1).ok_or_else(corrupt_error)?;
            pending_bytes = pending_bytes
                .checked_add(byte_count)
                .ok_or_else(corrupt_error)?;
            oldest_pending_at = Some(
                oldest_pending_at.map_or(parent_observed_at, |oldest: DateTime<Utc>| {
                    oldest.min(parent_observed_at)
                }),
            );
        }
    }

    let mut statement = transaction
        .prepare("SELECT state, terminal_code FROM sync_windows")
        .map_err(map_query_error)?;
    let mut rows = statement.query([]).map_err(map_query_error)?;
    while let Some(row) = rows.next().map_err(map_query_error)? {
        let state = text_value(row, 0)?;
        if !matches!(
            state,
            "collecting" | "pending" | "committed" | "quarantined"
        ) {
            return Err(corrupt_error());
        }
        terminal_quarantine |= terminal_state(row, 1, state)?;
    }

    Ok(OutboxPressure {
        pending_rows,
        pending_bytes,
        oldest_pending_at,
        terminal_quarantine,
    })
}

fn pending_outbox_pressure(transaction: &Transaction<'_>) -> Result<OutboxPressure, HealthError> {
    let mut statement = transaction
        .prepare(
            "SELECT source_kind, state, byte_count, next_attempt_at, terminal_code
             FROM outbox_batches",
        )
        .map_err(map_query_error)?;
    let mut rows = statement.query([]).map_err(map_query_error)?;
    let mut pending_rows = 0_u64;
    let mut pending_bytes = 0_u64;
    let mut oldest_pending_at = None;
    let mut terminal_quarantine = false;

    while let Some(row) = rows.next().map_err(map_query_error)? {
        let source_kind = text_value(row, 0)?;
        if !matches!(source_kind, "live" | "backfill") {
            return Err(corrupt_error());
        }
        let state = text_value(row, 1)?;
        if !matches!(state, "pending" | "accepted" | "quarantined") {
            return Err(corrupt_error());
        }
        let byte_count = u64::try_from(bounded_integer(
            row,
            2,
            1,
            MAX_BATCH_CANONICAL_BYTES as i64,
        )?)
        .map_err(|_| corrupt_error())?;
        let next_attempt_at = timestamp_value(row, 3)?;
        terminal_quarantine |= terminal_state(row, 4, state)?;
        if state == "pending" {
            pending_rows = pending_rows.checked_add(1).ok_or_else(corrupt_error)?;
            pending_bytes = pending_bytes
                .checked_add(byte_count)
                .ok_or_else(corrupt_error)?;
            oldest_pending_at = Some(
                oldest_pending_at.map_or(next_attempt_at, |oldest: DateTime<Utc>| {
                    oldest.min(next_attempt_at)
                }),
            );
        }
    }

    Ok(OutboxPressure {
        pending_rows,
        pending_bytes,
        oldest_pending_at,
        terminal_quarantine,
    })
}

fn text_value<'row>(row: &'row Row<'_>, index: usize) -> Result<&'row str, HealthError> {
    match row.get_ref(index).map_err(map_query_error)? {
        ValueRef::Text(bytes) => str::from_utf8(bytes).map_err(|_| corrupt_error()),
        _ => Err(corrupt_error()),
    }
}

fn bounded_integer(
    row: &Row<'_>,
    index: usize,
    minimum: i64,
    maximum: i64,
) -> Result<i64, HealthError> {
    match row.get_ref(index).map_err(map_query_error)? {
        ValueRef::Integer(value) if (minimum..=maximum).contains(&value) => Ok(value),
        _ => Err(corrupt_error()),
    }
}

fn timestamp_value(row: &Row<'_>, index: usize) -> Result<DateTime<Utc>, HealthError> {
    let value = text_value(row, index)?;
    parse_timestamp_value(value)
}

fn parse_timestamp_value(value: &str) -> Result<DateTime<Utc>, HealthError> {
    if !crate::model::valid_timestamp(value) {
        return Err(corrupt_error());
    }
    let timestamp = DateTime::parse_from_rfc3339(value).map_err(|_| corrupt_error())?;
    if timestamp.offset().local_minus_utc() != 0
        || !timestamp.timestamp_subsec_nanos().is_multiple_of(1_000_000)
    {
        return Err(corrupt_error());
    }
    Ok(timestamp.with_timezone(&Utc))
}

fn optional_text_value<'row>(
    row: &'row Row<'_>,
    index: usize,
) -> Result<Option<&'row str>, HealthError> {
    match row.get_ref(index).map_err(map_query_error)? {
        ValueRef::Null => Ok(None),
        ValueRef::Text(bytes) => str::from_utf8(bytes).map(Some).map_err(|_| corrupt_error()),
        _ => Err(corrupt_error()),
    }
}

fn terminal_state(row: &Row<'_>, index: usize, state: &str) -> Result<bool, HealthError> {
    let terminal_code = optional_text_value(row, index)?;
    match (state, terminal_code) {
        ("quarantined", Some(code)) if valid_reason_code(code) => Ok(true),
        ("quarantined", _) => Err(corrupt_error()),
        (_, None) => Ok(false),
        (_, Some(_)) => Err(corrupt_error()),
    }
}

fn valid_reason_code(value: &str) -> bool {
    let bytes = value.as_bytes();
    if !(3..=64).contains(&bytes.len()) {
        return false;
    }
    if !matches!(bytes.first(), Some(b'a'..=b'z'))
        || !matches!(bytes.last(), Some(b'a'..=b'z' | b'0'..=b'9'))
    {
        return false;
    }
    bytes.iter().enumerate().all(|(index, byte)| {
        matches!(byte, b'a'..=b'z' | b'0'..=b'9' | b'_')
            && (index == 0 || *byte != b'_' || bytes[index - 1] != b'_')
    })
}

fn corrupt_error() -> HealthError {
    HealthError::new(HEALTH_DATABASE_UNAVAILABLE)
}

fn map_query_error(error: SqliteError) -> HealthError {
    if is_busy(&error) {
        HealthError::new(HEALTH_DATABASE_BUSY)
    } else {
        HealthError::new(HEALTH_DATABASE_UNAVAILABLE)
    }
}

fn is_busy(error: &SqliteError) -> bool {
    matches!(
        error,
        SqliteError::SqliteFailure(failure, _)
            if matches!(failure.code, ErrorCode::DatabaseBusy | ErrorCode::DatabaseLocked)
    )
}
