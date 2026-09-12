//! Read-only, content-free inspection of the gateway state database.

use std::{fmt, path::Path, time::Duration};

use chrono::{DateTime, Utc};
use rusqlite::{
    Connection, Error as SqliteError, ErrorCode, OpenFlags, Transaction, TransactionBehavior,
};

use crate::config::MAX_RECOVERY_BYTES;

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
        format!(
            r#"{{"schema_version":1,"status":"{}","session":"{}","inbox_state":"{}","outbox_state":"{}","maintenance_code":null,"terminal_quarantine":false}}"#,
            self.status().as_str(),
            self.session.as_str(),
            self.inbox_state.as_str(),
            self.outbox_state.as_str(),
        )
    }

    /// Return whether the inspected state is healthy.
    pub const fn is_healthy(&self) -> bool {
        matches!(self.status(), HealthStatus::Healthy)
    }

    /// Return the process status a future healthcheck command should use.
    pub const fn exit_status(&self) -> i32 {
        if self.is_healthy() { 0 } else { 1 }
    }

    /// Return the process exit code a future healthcheck command should use.
    pub const fn exit_code(&self) -> i32 {
        self.exit_status()
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
    BytesExceeded,
    Corrupt,
}

impl LimitState {
    const fn as_str(self) -> &'static str {
        match self {
            Self::WithinLimits => "within_limits",
            Self::BytesExceeded => "bytes_exceeded",
            Self::Corrupt => "corrupt",
        }
    }

    const fn is_within_limits(self) -> bool {
        matches!(self, Self::WithinLimits)
    }
}

/// Inspect the state database at a caller-supplied UTC time.
pub fn inspect_at(
    path: impl AsRef<Path>,
    _now: DateTime<Utc>,
) -> Result<HealthReport, HealthError> {
    let mut connection = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(map_open_error)?;
    connection
        .busy_timeout(HEALTH_BUSY_TIMEOUT)
        .map_err(map_connection_error)?;
    connection
        .pragma_update(None, "query_only", true)
        .map_err(map_connection_error)?;

    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Deferred)
        .map_err(map_connection_error)?;
    let session = match session_present(&transaction) {
        Ok(true) => SessionState::Present,
        Ok(false) => SessionState::Missing,
        Err(error) if error.code() == HEALTH_DATABASE_BUSY => return Err(error),
        Err(_) => SessionState::Missing,
    };
    let outbox_state = match pending_outbox_bytes(&transaction) {
        Ok(bytes) if bytes >= MAX_RECOVERY_BYTES => LimitState::BytesExceeded,
        Ok(_) => LimitState::WithinLimits,
        Err(error) if error.code() == HEALTH_DATABASE_BUSY => return Err(error),
        Err(_) => LimitState::Corrupt,
    };
    transaction.commit().map_err(map_connection_error)?;

    Ok(HealthReport {
        session,
        inbox_state: LimitState::WithinLimits,
        outbox_state,
        maintenance_code: None,
        terminal_quarantine: false,
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

fn pending_outbox_bytes(transaction: &Transaction<'_>) -> Result<u64, HealthError> {
    let mut statement = transaction
        .prepare("SELECT byte_count FROM outbox_batches WHERE state = 'pending'")
        .map_err(map_query_error)?;
    let mut rows = statement.query([]).map_err(map_query_error)?;
    let mut total = 0_u64;

    while let Some(row) = rows.next().map_err(map_query_error)? {
        let byte_count = row.get::<_, i64>(0).map_err(map_query_error)?;
        if byte_count < 0 {
            return Err(HealthError::new(HEALTH_DATABASE_UNAVAILABLE));
        }
        total = total
            .checked_add(byte_count as u64)
            .ok_or_else(|| HealthError::new(HEALTH_DATABASE_UNAVAILABLE))?;
    }

    Ok(total)
}

fn map_open_error(error: SqliteError) -> HealthError {
    if is_busy(&error) {
        HealthError::new(HEALTH_DATABASE_BUSY)
    } else {
        HealthError::new(HEALTH_DATABASE_UNAVAILABLE)
    }
}

fn map_connection_error(error: SqliteError) -> HealthError {
    if is_busy(&error) {
        HealthError::new(HEALTH_DATABASE_BUSY)
    } else {
        HealthError::new(HEALTH_DATABASE_UNAVAILABLE)
    }
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
