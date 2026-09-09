//! Validated, redacted data-transfer objects for the sync inbox store.
//!
//! The types in this module are deliberately small boundaries around the
//! values that later store transactions will persist.  Secret-bearing bytes
//! are owned by [`SecretBytes`], while all identifiers and state strings are
//! bounded before they can cross the boundary.

use std::{collections::HashSet, fmt};

use chrono::{DateTime, Utc};
use sha2::{Digest, Sha256};

use crate::{
    model,
    secret::{SafeError, SecretBytes},
    store::{STORE_BOOTSTRAP_INVALID, STORE_SYNC_INVALID, STORE_SYNC_TOO_LARGE},
};

/// Maximum serialized response bytes accepted for one raw sync inbox.
pub const MAX_SYNC_RESPONSE_BYTES: usize = 64 * 1024 * 1024;
/// Maximum bytes accepted for either sync token.
pub const MAX_SYNC_TOKEN_BYTES: usize = 64 * 1024;
/// Maximum bytes accepted for a bootstrap session secret.
pub const MAX_BOOTSTRAP_SESSION_BYTES: usize = 1024 * 1024;
/// Maximum number of room anchors in a bootstrap state.
pub const MAX_BOOTSTRAP_ROOM_ANCHORS: usize = 100_000;
/// Maximum bytes accepted for one room anchor event.
pub const MAX_ROOM_ANCHOR_BYTES: usize = 64 * 1024;

/// An encrypted room anchor associated with one keyed room lookup.
pub struct RoomAnchor {
    room_lookup: [u8; 32],
    anchor_event: SecretBytes,
}

impl RoomAnchor {
    /// Construct a room anchor after validating its bounded event bytes.
    pub fn new(room_lookup: [u8; 32], anchor_event: Vec<u8>) -> Result<Self, SafeError> {
        let anchor_event = SecretBytes::new(anchor_event);
        let value = Self {
            room_lookup,
            anchor_event,
        };
        value.validate()?;
        Ok(value)
    }

    pub(crate) fn validate(&self) -> Result<(), SafeError> {
        if self.anchor_event.is_empty() {
            return Err(bootstrap_invalid());
        }
        if self.anchor_event.len() > MAX_ROOM_ANCHOR_BYTES {
            return Err(bootstrap_invalid());
        }
        Ok(())
    }

    /// Borrow the keyed room lookup digest.
    pub fn room_lookup(&self) -> &[u8; 32] {
        &self.room_lookup
    }

    /// Borrow the encrypted anchor event.
    pub fn anchor_event(&self) -> &SecretBytes {
        &self.anchor_event
    }
}

impl fmt::Debug for RoomAnchor {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("RoomAnchor([REDACTED])")
    }
}

impl fmt::Display for RoomAnchor {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("RoomAnchor([REDACTED])")
    }
}

/// The encrypted bootstrap state received before sync inbox ingestion starts.
pub struct NewBootstrapState {
    session: SecretBytes,
    initial_token: SecretBytes,
    anchors: Vec<RoomAnchor>,
    bootstrapped_at: DateTime<Utc>,
}

impl NewBootstrapState {
    /// Construct and validate one bootstrap state.
    pub fn new(
        session: Vec<u8>,
        initial_token: Vec<u8>,
        anchors: Vec<RoomAnchor>,
        bootstrapped_at: DateTime<Utc>,
    ) -> Result<Self, SafeError> {
        let value = Self {
            session: SecretBytes::new(session),
            initial_token: SecretBytes::new(initial_token),
            anchors,
            bootstrapped_at,
        };
        value.validate()?;
        Ok(value)
    }

    pub(crate) fn validate(&self) -> Result<(), SafeError> {
        if self.session.is_empty() || self.session.len() > MAX_BOOTSTRAP_SESSION_BYTES {
            return Err(bootstrap_invalid());
        }
        if self.initial_token.is_empty() || self.initial_token.len() > MAX_SYNC_TOKEN_BYTES {
            return Err(bootstrap_invalid());
        }
        if self.anchors.len() > MAX_BOOTSTRAP_ROOM_ANCHORS
            || !valid_utc_millisecond(self.bootstrapped_at)
        {
            return Err(bootstrap_invalid());
        }

        let mut lookups = HashSet::with_capacity(self.anchors.len());
        for anchor in &self.anchors {
            anchor.validate()?;
            if !lookups.insert(*anchor.room_lookup()) {
                return Err(bootstrap_invalid());
            }
        }
        Ok(())
    }

    /// Borrow the encrypted bootstrap session for store persistence.
    pub(crate) fn session(&self) -> &SecretBytes {
        &self.session
    }

    /// Borrow the encrypted initial sync token for store persistence.
    pub(crate) fn initial_token(&self) -> &SecretBytes {
        &self.initial_token
    }

    /// Borrow the validated room anchors for store persistence.
    pub(crate) fn anchors(&self) -> &[RoomAnchor] {
        &self.anchors
    }

    /// Borrow the UTC bootstrap timestamp for store persistence.
    pub(crate) fn bootstrapped_at(&self) -> &DateTime<Utc> {
        &self.bootstrapped_at
    }
}

impl fmt::Debug for NewBootstrapState {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("NewBootstrapState([REDACTED])")
    }
}

impl fmt::Display for NewBootstrapState {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("NewBootstrapState([REDACTED])")
    }
}

/// A synthetic identifier for one raw sync inbox row.
#[derive(Clone, Eq, PartialEq)]
pub struct InboxId(String);

impl InboxId {
    /// Validate and wrap a synthetic inbox identifier.
    #[allow(dead_code)]
    pub(crate) fn new(value: String) -> Result<Self, SafeError> {
        if valid_inbox_id(&value) {
            Ok(Self(value))
        } else {
            Err(sync_invalid())
        }
    }

    /// Borrow the synthetic inbox identifier.
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Debug for InboxId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl fmt::Display for InboxId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

/// A bounded terminal reason code stored with a quarantined DTO.
#[derive(Clone, Eq, PartialEq)]
pub struct ReasonCode(String);

impl ReasonCode {
    /// Validate and wrap a terminal reason code.
    pub fn new(value: impl Into<String>) -> Result<Self, SafeError> {
        let value = value.into();
        if valid_reason_code(&value) {
            Ok(Self(value))
        } else {
            Err(sync_invalid())
        }
    }

    /// Borrow the bounded reason code.
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Debug for ReasonCode {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl fmt::Display for ReasonCode {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

/// The lifecycle state of a raw sync inbox row.
#[derive(Clone, Copy, Eq, PartialEq)]
pub enum SyncInboxState {
    /// The SDK response has been fetched but not handed to the SDK.
    Fetched,
    /// The SDK has accepted and processed the response.
    SdkProcessed,
    /// The response has been converted into a pending window.
    Prepared,
    /// The pending window has been committed.
    Committed,
    /// Processing stopped and the row is terminally quarantined.
    Quarantined,
}

impl SyncInboxState {
    /// Return the exact lowercase state stored in SQLite.
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Fetched => "fetched",
            Self::SdkProcessed => "sdk_processed",
            Self::Prepared => "prepared",
            Self::Committed => "committed",
            Self::Quarantined => "quarantined",
        }
    }

    /// Parse one exact SQLite state string.
    #[allow(dead_code)]
    pub(crate) fn from_str(value: &str) -> Result<Self, SafeError> {
        match value {
            "fetched" => Ok(Self::Fetched),
            "sdk_processed" => Ok(Self::SdkProcessed),
            "prepared" => Ok(Self::Prepared),
            "committed" => Ok(Self::Committed),
            "quarantined" => Ok(Self::Quarantined),
            _ => Err(sync_invalid()),
        }
    }
}

impl fmt::Debug for SyncInboxState {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.as_str())
    }
}

impl fmt::Display for SyncInboxState {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.as_str())
    }
}

/// One newly fetched raw sync response before an inbox identity is assigned.
pub struct NewRawSyncInbox {
    request_token: SecretBytes,
    next_token: SecretBytes,
    response: SecretBytes,
    observed_at: DateTime<Utc>,
}

impl NewRawSyncInbox {
    /// Construct and validate one newly fetched sync response.
    pub fn new(
        request_token: Vec<u8>,
        next_token: Vec<u8>,
        response: Vec<u8>,
        observed_at: DateTime<Utc>,
    ) -> Result<Self, SafeError> {
        let value = Self {
            request_token: SecretBytes::new(request_token),
            next_token: SecretBytes::new(next_token),
            response: SecretBytes::new(response),
            observed_at,
        };
        value.validate()?;
        Ok(value)
    }

    fn validate(&self) -> Result<(), SafeError> {
        if self.request_token.is_empty() || self.next_token.is_empty() {
            return Err(sync_invalid());
        }
        if self.request_token.len() > MAX_SYNC_TOKEN_BYTES
            || self.next_token.len() > MAX_SYNC_TOKEN_BYTES
        {
            return Err(sync_too_large());
        }
        if self.response.is_empty() {
            return Err(sync_invalid());
        }
        if self.response.len() > MAX_SYNC_RESPONSE_BYTES {
            return Err(sync_too_large());
        }
        if !valid_utc_millisecond(self.observed_at) {
            return Err(sync_invalid());
        }
        Ok(())
    }

    /// Borrow the encrypted request token for store persistence.
    #[allow(dead_code)]
    pub(crate) fn request_token(&self) -> &SecretBytes {
        &self.request_token
    }

    /// Borrow the encrypted next token for store persistence.
    #[allow(dead_code)]
    pub(crate) fn next_token(&self) -> &SecretBytes {
        &self.next_token
    }

    /// Borrow the encrypted raw response for store persistence.
    #[allow(dead_code)]
    pub(crate) fn response(&self) -> &SecretBytes {
        &self.response
    }

    /// Borrow the UTC observation timestamp for store persistence.
    #[allow(dead_code)]
    pub(crate) fn observed_at(&self) -> &DateTime<Utc> {
        &self.observed_at
    }
}

impl fmt::Debug for NewRawSyncInbox {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("NewRawSyncInbox([REDACTED])")
    }
}

impl fmt::Display for NewRawSyncInbox {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("NewRawSyncInbox([REDACTED])")
    }
}

/// One validated raw sync inbox row, including its immutable processing audit.
pub struct RawSyncInbox {
    inbox_id: InboxId,
    predecessor_id: Option<InboxId>,
    request_token: SecretBytes,
    request_token_digest: [u8; 32],
    next_token: SecretBytes,
    next_token_digest: [u8; 32],
    response: SecretBytes,
    response_sha256: [u8; 32],
    byte_count: usize,
    state: SyncInboxState,
    crypto_drained: bool,
    observed_at: DateTime<Utc>,
    created_at: DateTime<Utc>,
    sdk_processed_at: Option<DateTime<Utc>>,
    prepared_at: Option<DateTime<Utc>>,
    committed_at: Option<DateTime<Utc>>,
    terminal_code: Option<ReasonCode>,
}

impl RawSyncInbox {
    /// Construct one row from authenticated persistence fields.
    ///
    /// This boundary is crate-private so a database decoder cannot instantiate
    /// a row by bypassing the integrity, size, timestamp, and lifecycle checks.
    /// Protected values are moved into zeroizing buffers before validation.
    #[allow(clippy::too_many_arguments)]
    #[allow(dead_code)]
    pub(crate) fn from_verified_parts(
        inbox_id: InboxId,
        predecessor_id: Option<InboxId>,
        request_token: Vec<u8>,
        request_token_digest: [u8; 32],
        next_token: Vec<u8>,
        next_token_digest: [u8; 32],
        response: Vec<u8>,
        response_sha256: [u8; 32],
        byte_count: usize,
        state: SyncInboxState,
        crypto_drained: bool,
        observed_at: DateTime<Utc>,
        created_at: DateTime<Utc>,
        sdk_processed_at: Option<DateTime<Utc>>,
        prepared_at: Option<DateTime<Utc>>,
        committed_at: Option<DateTime<Utc>>,
        terminal_code: Option<ReasonCode>,
    ) -> Result<Self, SafeError> {
        let value = Self {
            inbox_id,
            predecessor_id,
            request_token: SecretBytes::new(request_token),
            request_token_digest,
            next_token: SecretBytes::new(next_token),
            next_token_digest,
            response: SecretBytes::new(response),
            response_sha256,
            byte_count,
            state,
            crypto_drained,
            observed_at,
            created_at,
            sdk_processed_at,
            prepared_at,
            committed_at,
            terminal_code,
        };
        value.validate()?;
        Ok(value)
    }

    /// Revalidate every persisted field before a row is used or serialized.
    #[allow(dead_code)]
    pub(crate) fn validate(&self) -> Result<(), SafeError> {
        if !valid_inbox_id(self.inbox_id.as_str()) {
            return Err(sync_invalid());
        }
        if let Some(predecessor_id) = self.predecessor_id.as_ref()
            && (!valid_inbox_id(predecessor_id.as_str()) || predecessor_id == &self.inbox_id)
        {
            return Err(sync_invalid());
        }

        validate_protected_bytes(self.request_token.as_bytes(), MAX_SYNC_TOKEN_BYTES)?;
        validate_protected_bytes(self.next_token.as_bytes(), MAX_SYNC_TOKEN_BYTES)?;
        validate_protected_bytes(self.response.as_bytes(), MAX_SYNC_RESPONSE_BYTES)?;
        if self.byte_count == 0 || self.byte_count != self.response.len() {
            return Err(sync_invalid());
        }
        if self.byte_count > MAX_SYNC_RESPONSE_BYTES {
            return Err(sync_too_large());
        }

        if sha256(self.request_token.as_bytes()) != self.request_token_digest
            || sha256(self.next_token.as_bytes()) != self.next_token_digest
            || sha256(self.response.as_bytes()) != self.response_sha256
        {
            return Err(sync_invalid());
        }

        if !valid_utc_millisecond(self.observed_at)
            || !valid_utc_millisecond(self.created_at)
            || self.observed_at > self.created_at
        {
            return Err(sync_invalid());
        }
        for timestamp in [self.sdk_processed_at, self.prepared_at, self.committed_at]
            .into_iter()
            .flatten()
        {
            if !valid_utc_millisecond(timestamp) {
                return Err(sync_invalid());
            }
        }
        if self
            .sdk_processed_at
            .is_some_and(|timestamp| timestamp < self.created_at)
            || self.prepared_at.is_some_and(|timestamp| {
                timestamp < self.sdk_processed_at.unwrap_or(self.created_at)
            })
            || self.committed_at.is_some_and(|timestamp| {
                timestamp
                    < self
                        .prepared_at
                        .unwrap_or(self.sdk_processed_at.unwrap_or(self.created_at))
            })
        {
            return Err(sync_invalid());
        }

        match self.state {
            SyncInboxState::Fetched
                if self.sdk_processed_at.is_none()
                    && self.prepared_at.is_none()
                    && self.committed_at.is_none()
                    && self.terminal_code.is_none() => {}
            SyncInboxState::SdkProcessed
                if self.sdk_processed_at.is_some()
                    && self.prepared_at.is_none()
                    && self.committed_at.is_none()
                    && self.terminal_code.is_none() => {}
            SyncInboxState::Prepared
                if self.sdk_processed_at.is_some()
                    && self.prepared_at.is_some()
                    && self.committed_at.is_none()
                    && self.terminal_code.is_none() => {}
            SyncInboxState::Committed
                if self.sdk_processed_at.is_some()
                    && self.prepared_at.is_some()
                    && self.committed_at.is_some()
                    && self.terminal_code.is_none() => {}
            SyncInboxState::Quarantined
                if self.committed_at.is_none()
                    && self
                        .terminal_code
                        .as_ref()
                        .is_some_and(|code| valid_reason_code(code.as_str())) => {}
            _ => return Err(sync_invalid()),
        }
        Ok(())
    }

    /// Borrow the synthetic inbox identifier.
    pub fn inbox_id(&self) -> &InboxId {
        &self.inbox_id
    }

    /// Borrow the predecessor inbox identifier, if one exists.
    pub fn predecessor_id(&self) -> Option<&InboxId> {
        self.predecessor_id.as_ref()
    }

    /// Borrow the encrypted request token.
    pub fn request_token(&self) -> &SecretBytes {
        &self.request_token
    }

    /// Borrow the keyed request-token digest.
    pub fn request_token_digest(&self) -> &[u8; 32] {
        &self.request_token_digest
    }

    /// Borrow the encrypted next token.
    pub fn next_token(&self) -> &SecretBytes {
        &self.next_token
    }

    /// Borrow the keyed next-token digest.
    pub fn next_token_digest(&self) -> &[u8; 32] {
        &self.next_token_digest
    }

    /// Borrow the encrypted raw response.
    pub fn response(&self) -> &SecretBytes {
        &self.response
    }

    /// Borrow the response SHA-256 digest.
    pub fn response_sha256(&self) -> &[u8; 32] {
        &self.response_sha256
    }

    /// Return the response byte count.
    pub const fn byte_count(&self) -> usize {
        self.byte_count
    }

    /// Return the current inbox lifecycle state.
    pub const fn state(&self) -> SyncInboxState {
        self.state
    }

    /// Return whether Matrix crypto work has drained for this inbox.
    pub const fn crypto_drained(&self) -> bool {
        self.crypto_drained
    }

    /// Borrow the upstream observation timestamp.
    pub fn observed_at(&self) -> &DateTime<Utc> {
        &self.observed_at
    }

    /// Borrow the local creation timestamp.
    pub fn created_at(&self) -> &DateTime<Utc> {
        &self.created_at
    }

    /// Borrow the SDK processing timestamp, if present.
    pub fn sdk_processed_at(&self) -> Option<&DateTime<Utc>> {
        self.sdk_processed_at.as_ref()
    }

    /// Borrow the preparation timestamp, if present.
    pub fn prepared_at(&self) -> Option<&DateTime<Utc>> {
        self.prepared_at.as_ref()
    }

    /// Borrow the commit timestamp, if present.
    pub fn committed_at(&self) -> Option<&DateTime<Utc>> {
        self.committed_at.as_ref()
    }

    /// Borrow the terminal reason code, if present.
    pub fn terminal_code(&self) -> Option<&ReasonCode> {
        self.terminal_code.as_ref()
    }
}

impl fmt::Debug for RawSyncInbox {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("RawSyncInbox([REDACTED])")
    }
}

impl fmt::Display for RawSyncInbox {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("RawSyncInbox([REDACTED])")
    }
}

/// Position of the last SDK response known to the store.
#[derive(Clone, Eq, PartialEq)]
pub enum SdkInboxPosition {
    /// No SDK response has been durably journaled yet.
    Committed,
    /// The SDK response is journaled and identified by this synthetic ID.
    Journaled { inbox_id: InboxId },
}

impl SdkInboxPosition {
    /// Borrow the journaled inbox identifier, if this position is journaled.
    pub fn journaled_inbox_id(&self) -> Option<&InboxId> {
        match self {
            Self::Committed => None,
            Self::Journaled { inbox_id } => Some(inbox_id),
        }
    }
}

impl fmt::Debug for SdkInboxPosition {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Committed => formatter.write_str("Committed"),
            Self::Journaled { inbox_id } => formatter
                .debug_struct("Journaled")
                .field("inbox_id", inbox_id)
                .finish(),
        }
    }
}

#[allow(dead_code)]
fn valid_inbox_id(value: &str) -> bool {
    const PREFIX: &str = "inbox_";
    value.len() == PREFIX.len() + 64
        && value.starts_with(PREFIX)
        && value[PREFIX.len()..]
            .bytes()
            .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
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

fn valid_utc_millisecond(value: DateTime<Utc>) -> bool {
    value.timestamp_subsec_nanos().is_multiple_of(1_000_000)
        && model::valid_timestamp(&value.to_rfc3339())
}

#[allow(dead_code)]
fn sha256(bytes: &[u8]) -> [u8; 32] {
    Sha256::digest(bytes).into()
}

#[allow(dead_code)]
fn validate_protected_bytes(bytes: &[u8], max_bytes: usize) -> Result<(), SafeError> {
    if bytes.is_empty() {
        return Err(sync_invalid());
    }
    if bytes.len() > max_bytes {
        return Err(sync_too_large());
    }
    Ok(())
}

fn bootstrap_invalid() -> SafeError {
    SafeError::new(STORE_BOOTSTRAP_INVALID)
}

fn sync_invalid() -> SafeError {
    SafeError::new(STORE_SYNC_INVALID)
}

fn sync_too_large() -> SafeError {
    SafeError::new(STORE_SYNC_TOO_LARGE)
}

#[cfg(test)]
mod tests {
    use chrono::{Duration, TimeZone};
    use sha2::{Digest, Sha256};

    use super::*;

    fn timestamp(milliseconds: i64) -> DateTime<Utc> {
        Utc.timestamp_millis_opt(milliseconds)
            .single()
            .expect("construct test timestamp")
    }

    fn digest(bytes: &[u8]) -> [u8; 32] {
        Sha256::digest(bytes).into()
    }

    #[test]
    fn bootstrap_borrowing_getters_return_original_values() {
        let room_lookup = [0x11; 32];
        let value = NewBootstrapState::new(
            vec![0x22],
            vec![0x33],
            vec![RoomAnchor::new(room_lookup, vec![0x44]).expect("anchor")],
            timestamp(1_700_000_000_000),
        )
        .expect("bootstrap");
        assert_eq!(value.session().as_bytes(), &[0x22]);
        assert_eq!(value.initial_token().as_bytes(), &[0x33]);
        assert_eq!(value.anchors().len(), 1);
        assert_eq!(value.anchors()[0].room_lookup(), &room_lookup);
        assert_eq!(value.anchors()[0].anchor_event().as_bytes(), &[0x44]);
        assert_eq!(value.bootstrapped_at(), &timestamp(1_700_000_000_000));
    }

    #[test]
    fn raw_sync_borrowing_getters_return_original_values() {
        let value = NewRawSyncInbox::new(
            vec![0x22],
            vec![0x33],
            vec![0x44],
            timestamp(1_700_000_000_000),
        )
        .expect("raw sync");
        assert_eq!(value.request_token().as_bytes(), &[0x22]);
        assert_eq!(value.next_token().as_bytes(), &[0x33]);
        assert_eq!(value.response().as_bytes(), &[0x44]);
        assert_eq!(value.observed_at(), &timestamp(1_700_000_000_000));
    }

    #[test]
    fn inbox_ids_and_states_use_exact_database_strings() {
        let id = InboxId::new(format!("inbox_{}", "ab".repeat(32))).expect("inbox ID");
        assert_eq!(id.as_str(), format!("inbox_{}", "ab".repeat(32)));
        for value in [
            "inbox_".to_owned(),
            format!("inbox_{}", "ab".repeat(31)),
            format!("inbox_{}", "ab".repeat(33)),
            format!("inbox_{}", "AB".repeat(32)),
            format!("inbox_{}", "ag".repeat(32)),
            format!("inbox-{}", "ab".repeat(32)),
            format!("inbox_{}x", "ab".repeat(32)),
        ] {
            assert_eq!(InboxId::new(value), Err(sync_invalid()));
        }
        for (state, wire) in [
            (SyncInboxState::Fetched, "fetched"),
            (SyncInboxState::SdkProcessed, "sdk_processed"),
            (SyncInboxState::Prepared, "prepared"),
            (SyncInboxState::Committed, "committed"),
            (SyncInboxState::Quarantined, "quarantined"),
        ] {
            assert_eq!(state.as_str(), wire);
            assert_eq!(SyncInboxState::from_str(wire).expect("state"), state);
        }
        assert_eq!(
            SyncInboxState::from_str("SDK_PROCESSED"),
            Err(sync_invalid())
        );
    }

    #[test]
    fn raw_sync_getters_cover_every_field_without_exposing_secrets() {
        let inbox_id = InboxId::new(format!("inbox_{}", "cd".repeat(32))).expect("inbox ID");
        let predecessor_id =
            InboxId::new(format!("inbox_{}", "ef".repeat(32))).expect("predecessor ID");
        let request_token_digest = digest(b"request-canary");
        let next_token_digest = digest(b"next-canary");
        let response_sha256 = digest(b"response-canary");
        let observed_at = timestamp(1_700_000_000_000);
        let created_at = timestamp(1_700_000_000_001);
        let sdk_processed_at = timestamp(1_700_000_000_002);
        let prepared_at = timestamp(1_700_000_000_003);
        let committed_at = timestamp(1_700_000_000_004);
        let value = RawSyncInbox::from_verified_parts(
            inbox_id,
            Some(predecessor_id),
            b"request-canary".to_vec(),
            request_token_digest,
            b"next-canary".to_vec(),
            next_token_digest,
            b"response-canary".to_vec(),
            response_sha256,
            15,
            SyncInboxState::Committed,
            true,
            observed_at,
            created_at,
            Some(sdk_processed_at),
            Some(prepared_at),
            Some(committed_at),
            None,
        )
        .expect("validated raw sync inbox");
        assert_eq!(
            value.inbox_id().as_str(),
            format!("inbox_{}", "cd".repeat(32))
        );
        assert_eq!(
            value.predecessor_id().expect("predecessor").as_str(),
            format!("inbox_{}", "ef".repeat(32))
        );
        assert_eq!(value.request_token().as_bytes(), b"request-canary");
        assert_eq!(value.request_token_digest(), &request_token_digest);
        assert_eq!(value.next_token().as_bytes(), b"next-canary");
        assert_eq!(value.next_token_digest(), &next_token_digest);
        assert_eq!(value.response().as_bytes(), b"response-canary");
        assert_eq!(value.response_sha256(), &response_sha256);
        assert_eq!(value.byte_count(), 15);
        assert_eq!(value.state(), SyncInboxState::Committed);
        assert!(value.crypto_drained());
        assert_eq!(value.observed_at(), &observed_at);
        assert_eq!(value.created_at(), &created_at);
        assert_eq!(value.sdk_processed_at(), Some(&sdk_processed_at));
        assert_eq!(value.prepared_at(), Some(&prepared_at));
        assert_eq!(value.committed_at(), Some(&committed_at));
        assert_eq!(value.terminal_code(), None);
        assert_eq!(format!("{value:?}"), "RawSyncInbox([REDACTED])");
        assert_eq!(value.to_string(), "RawSyncInbox([REDACTED])");
    }

    #[test]
    fn raw_sync_verified_constructor_rejects_tampered_integrity_and_lifecycle_fields() {
        let inbox_id = InboxId::new(format!("inbox_{}", "cd".repeat(32))).expect("inbox ID");
        let predecessor_id =
            InboxId::new(format!("inbox_{}", "ef".repeat(32))).expect("predecessor ID");
        let observed_at = timestamp(1_700_000_000_000);
        let created_at = timestamp(1_700_000_000_001);
        let request_token_digest = digest(b"request-canary");
        let next_token_digest = digest(b"next-canary");
        let response_sha256 = digest(b"response-canary");

        let error = RawSyncInbox::from_verified_parts(
            inbox_id,
            Some(predecessor_id),
            b"request-canary".to_vec(),
            [0x11; 32],
            b"next-canary".to_vec(),
            next_token_digest,
            b"response-canary".to_vec(),
            response_sha256,
            15,
            SyncInboxState::Fetched,
            false,
            observed_at,
            created_at,
            None,
            None,
            None,
            None,
        )
        .expect_err("tampered digest must fail validation");
        assert_eq!(error, sync_invalid());

        let same_id = InboxId::new(format!("inbox_{}", "cd".repeat(32))).expect("inbox ID");
        let error = RawSyncInbox::from_verified_parts(
            same_id,
            Some(InboxId::new(format!("inbox_{}", "cd".repeat(32))).expect("predecessor ID")),
            b"request-canary".to_vec(),
            request_token_digest,
            b"next-canary".to_vec(),
            next_token_digest,
            b"response-canary".to_vec(),
            response_sha256,
            15,
            SyncInboxState::Fetched,
            false,
            observed_at,
            created_at,
            None,
            None,
            None,
            None,
        )
        .expect_err("self predecessor must fail validation");
        assert_eq!(error, sync_invalid());

        let valid_id = InboxId::new(format!("inbox_{}", "cd".repeat(32))).expect("inbox ID");
        let error = RawSyncInbox::from_verified_parts(
            valid_id,
            None,
            b"request-canary".to_vec(),
            request_token_digest,
            b"next-canary".to_vec(),
            next_token_digest,
            b"response-canary".to_vec(),
            response_sha256,
            14,
            SyncInboxState::Fetched,
            false,
            observed_at,
            created_at,
            None,
            None,
            None,
            None,
        )
        .expect_err("byte count must match response length");
        assert_eq!(error, sync_invalid());

        let invalid_id = InboxId("not-an-inbox-id".to_owned());
        let error = RawSyncInbox::from_verified_parts(
            invalid_id,
            None,
            b"request-canary".to_vec(),
            request_token_digest,
            b"next-canary".to_vec(),
            next_token_digest,
            b"response-canary".to_vec(),
            response_sha256,
            15,
            SyncInboxState::Fetched,
            false,
            observed_at,
            created_at,
            None,
            None,
            None,
            None,
        )
        .expect_err("invalid inbox ID shape must fail validation");
        assert_eq!(error, sync_invalid());
    }

    #[test]
    fn sdk_position_exposes_only_the_synthetic_id() {
        let inbox_id = InboxId::new(format!("inbox_{}", "12".repeat(32))).expect("inbox ID");
        let position = SdkInboxPosition::Journaled { inbox_id };
        assert_eq!(
            position.journaled_inbox_id().expect("journaled").as_str(),
            format!("inbox_{}", "12".repeat(32))
        );
        assert!(format!("{position:?}").contains("inbox_"));
        assert!(!format!("{position:?}").contains("protected"));
        assert_eq!(SdkInboxPosition::Committed.journaled_inbox_id(), None);
    }

    #[test]
    fn timestamp_validation_rejects_sub_milliseconds_and_out_of_range_values() {
        let sub_millisecond = Utc
            .timestamp_opt(1_700_000_000, 1)
            .single()
            .expect("sub-millisecond timestamp");
        assert!(!valid_utc_millisecond(sub_millisecond));
        let out_of_range = DateTime::<Utc>::MAX_UTC - Duration::nanoseconds(999_999_999);
        assert!(!valid_utc_millisecond(out_of_range));
    }
}
