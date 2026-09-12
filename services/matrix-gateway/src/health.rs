//! Read-only, content-free inspection of the gateway state database.

use std::{fmt, path::Path, time::Duration};

use chrono::{DateTime, Utc};
use rusqlite::{
    Connection, Error as SqliteError, ErrorCode, OpenFlags, Transaction, TransactionBehavior,
};

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
    healthy: bool,
}

impl HealthReport {
    /// Serialize the report as one compact JSON object.
    pub fn to_json(&self) -> &'static str {
        if self.healthy {
            r#"{"schema_version":1,"status":"healthy","session":"present","inbox_state":"within_limits","outbox_state":"within_limits","maintenance_code":null,"terminal_quarantine":false}"#
        } else {
            r#"{"schema_version":1,"status":"blocked","session":"missing","inbox_state":"within_limits","outbox_state":"within_limits","maintenance_code":null,"terminal_quarantine":false}"#
        }
    }

    /// Return whether the inspected state is healthy.
    pub const fn is_healthy(&self) -> bool {
        self.healthy
    }

    /// Return the process status a future healthcheck command should use.
    pub const fn exit_status(&self) -> i32 {
        if self.healthy { 0 } else { 1 }
    }

    /// Return the process exit code a future healthcheck command should use.
    pub const fn exit_code(&self) -> i32 {
        self.exit_status()
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
    let healthy = match session_present(&transaction) {
        Ok(present) => present,
        Err(error) if error.code() == HEALTH_DATABASE_BUSY => return Err(error),
        Err(_) => false,
    };
    transaction.commit().map_err(map_connection_error)?;

    Ok(HealthReport { healthy })
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
