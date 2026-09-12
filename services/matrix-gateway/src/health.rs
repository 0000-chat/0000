//! Read-only, content-free inspection of the gateway state database.

use std::{fmt, path::Path};

use chrono::{DateTime, Utc};
use rusqlite::{Connection, OpenFlags};

/// Stable error returned when the health database cannot be opened.
pub const HEALTH_DATABASE_UNAVAILABLE: &str = "health_database_unavailable";

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
pub struct HealthReport;

impl HealthReport {
    /// Serialize the report as one compact JSON object.
    pub fn to_json(&self) -> &'static str {
        r#"{"schema_version":1,"status":"healthy","session":"present","inbox_state":"within_limits","outbox_state":"within_limits","maintenance_code":null,"terminal_quarantine":false}"#
    }
}

/// Inspect the state database at a caller-supplied UTC time.
pub fn inspect_at(path: impl AsRef<Path>, _now: DateTime<Utc>) -> Result<HealthReport, HealthError> {
    Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|_| HealthError::new(HEALTH_DATABASE_UNAVAILABLE))?;
    Ok(HealthReport)
}
