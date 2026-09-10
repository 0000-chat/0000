//! Formatting boundary for values that must never be disclosed.

use std::fmt;

/// A value whose formatting is always replaced with a fixed redaction marker.
///
/// The wrapped value is intentionally not included in either formatting
/// implementation, regardless of whether the inner type implements a
/// formatting trait.
pub struct Protected<T>(T);

impl<T> Protected<T> {
    /// Wrap a value at a protected boundary.
    pub const fn new(value: T) -> Self {
        Self(value)
    }
}

impl<T> fmt::Debug for Protected<T> {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("[REDACTED]")
    }
}

impl<T> fmt::Display for Protected<T> {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("[REDACTED]")
    }
}
