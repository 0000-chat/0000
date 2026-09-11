//! Deterministic orchestration seams for the Matrix gateway service.
//!
//! The service owns the application store and selects at most one durable
//! state-machine action per tick.  Network and SDK behavior stays behind the
//! narrow traits in [`crate::matrix`], while time, jitter, and shutdown are
//! explicit inputs so the coordinator can be exercised without ambient state.

use std::{collections::BTreeMap, fmt, str, time::Duration as StdDuration};

use chrono::{DateTime, Duration as ChronoDuration, SecondsFormat, TimeZone, Utc};
use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::{
    batch::{self, RoutedEvent, WindowSource},
    ingestion::BatchSink,
    ledger::{FinalizeOutcome, NewLiveGapJob, NewLiveWindow, RoomEphemeralCandidate},
    matrix::{
        MATRIX_CRYPTO_ACK_UNRECOVERABLE, MATRIX_CRYPTO_KIND_NOT_ALLOWED,
        MATRIX_CRYPTO_MAINTENANCE_REQUIRED, MATRIX_RESPONSE_INVALID, MATRIX_RESPONSE_TOO_LARGE,
        MATRIX_ROOM_MEMBERSHIP_INVALID, MATRIX_SDK_FAILED, MatrixProcessor, MatrixTransport,
        ObservedMatrixEvent as SdkObservedMatrixEvent, ProcessedSync, RestartCryptoAck,
    },
    normalize::{
        self, KnownRelation, KnownRelations, MATRIX_MALFORMED_EVENT, MATRIX_UNKNOWN_ROOM,
        MatrixAttachment, MatrixMembership, MatrixMembershipKind, MatrixMessage, MatrixMessageKind,
        MatrixReaction, MatrixReceipt, MatrixReceiptType, MatrixRedaction, MatrixRelation,
        MatrixRoomState, MatrixRoomStateKind, MatrixTyping, NormalizeOutcome,
        ObservedMatrixEvent as NormalizedMatrixEvent, ProtectedBytes,
    },
    secret::SafeError,
    store::Store,
    store_types::{ReasonCode, SdkInboxPosition, SyncInboxState},
};

/// Stable error returned when a service is constructed without bootstrap state.
pub const SERVICE_NOT_BOOTSTRAPPED: &str = "service_not_bootstrapped";
/// Stable error returned when a tick is attempted before startup reconciliation.
pub const SERVICE_NOT_RECONCILED: &str = "service_not_reconciled";
/// Stable error returned for invalid retry configuration or arithmetic.
pub const SERVICE_RETRY_INVALID: &str = "service_retry_invalid";
/// Stable error returned when persisted maintenance blocks service progress.
pub const SERVICE_MAINTENANCE_REQUIRED: &str = "service_maintenance_required";
/// Stable error returned when a bounded receive-only recovery frontier is
/// exhausted without clearing the blocked source head.
pub const MATRIX_KEY_RECOVERY_EXHAUSTED: &str = "matrix_key_recovery_exhausted";
/// Stable error returned when an inbox observation cannot be safely ignored.
pub const SERVICE_PROJECTION_BLOCKED: &str = "service_projection_blocked";

const MAX_RETRY_EXPONENT: u32 = 63;
const MAX_RECOVERY_RESPONSES: usize = 16;
const MAX_PENDING_INBOX_ROWS: u64 = 2_000;
const MAX_PROTECTED_BYTES: u64 = 256 * 1024 * 1024;
const CRYPTO_MAINTENANCE_CODE: &str = "crypto_maintenance_required";

struct ProcessedInbox {
    inbox_id: String,
    processed: ProcessedSync,
}

#[derive(Clone)]
struct TypingSnapshot {
    members: Vec<String>,
    observed_at: DateTime<Utc>,
}

/// A source of UTC time used by the coordinator.
pub trait Clock: Send + Sync {
    /// Return the current UTC time at millisecond precision.
    fn now(&self) -> DateTime<Utc>;
}

/// A deterministic source of full-jitter delay values.
pub trait JitterSource: Send {
    /// Return a value in `0..=inclusive_max_ms`.
    fn sample_ms(&mut self, inclusive_max_ms: u64) -> u64;
}

/// A source of an externally managed shutdown request.
pub trait Shutdown: Send + Sync {
    /// Return whether the next action must be suppressed.
    fn requested(&self) -> bool;
}

/// The content-free action selected by one service tick.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ServiceAction {
    /// One exact Matrix response was appended to the encrypted inbox.
    FetchedSync,
    /// One saved crypto response was rebound to the restored SDK.
    ReboundCryptoResponse,
    /// One saved inbox response was applied and its processing record persisted.
    ProcessedInbox,
    /// One complete SDK crypto request set was persisted.
    PersistedCryptoRequests,
    /// One persisted crypto request was leased and attempted.
    AttemptedCryptoDelivery,
    /// One crypto response was acknowledged and completed locally.
    CompletedCryptoRequest,
    /// One SDK-processed inbox row was marked crypto-drained.
    MarkedCryptoDrained,
    /// One live window was prepared.
    PreparedLiveWindow,
    /// One persisted ingestion batch was attempted.
    AttemptedIngestionDelivery,
    /// One ingestion batch was accepted locally.
    AcceptedIngestionBatch,
    /// One empty live window was committed.
    CommittedEmptyWindow,
    /// One committed prefix was purged.
    PurgedCommittedPrefix,
    /// No action was eligible.
    Wait,
    /// Shutdown was requested before a new action began.
    Shutdown,
}

impl fmt::Display for ServiceAction {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let name = match self {
            Self::FetchedSync => "FetchedSync",
            Self::ReboundCryptoResponse => "ReboundCryptoResponse",
            Self::ProcessedInbox => "ProcessedInbox",
            Self::PersistedCryptoRequests => "PersistedCryptoRequests",
            Self::AttemptedCryptoDelivery => "AttemptedCryptoDelivery",
            Self::CompletedCryptoRequest => "CompletedCryptoRequest",
            Self::MarkedCryptoDrained => "MarkedCryptoDrained",
            Self::PreparedLiveWindow => "PreparedLiveWindow",
            Self::AttemptedIngestionDelivery => "AttemptedIngestionDelivery",
            Self::AcceptedIngestionBatch => "AcceptedIngestionBatch",
            Self::CommittedEmptyWindow => "CommittedEmptyWindow",
            Self::PurgedCommittedPrefix => "PurgedCommittedPrefix",
            Self::Wait => "Wait",
            Self::Shutdown => "Shutdown",
        };
        formatter.write_str(name)
    }
}

/// Validated retry settings for one delivery attempt.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct RetryPolicy {
    /// Initial exponential-backoff cap.
    pub base_delay: StdDuration,
    /// Maximum exponential-backoff cap.
    pub max_delay: StdDuration,
    /// Maximum exponent used in the exponential cap calculation.
    pub exponent_cap: u32,
}

impl RetryPolicy {
    /// Construct and synchronously validate one retry policy.
    pub fn new(
        base_delay: StdDuration,
        max_delay: StdDuration,
        exponent_cap: u32,
    ) -> Result<Self, SafeError> {
        let policy = Self {
            base_delay,
            max_delay,
            exponent_cap,
        };
        policy.validate()?;
        Ok(policy)
    }

    fn validate(&self) -> Result<(), SafeError> {
        if self.base_delay.is_zero()
            || self.max_delay.is_zero()
            || self.base_delay.as_millis() == 0
            || self.max_delay.as_millis() == 0
            || self.base_delay > self.max_delay
            || self.exponent_cap > MAX_RETRY_EXPONENT
            || self.base_delay.as_millis() > i64::MAX as u128
            || self.max_delay.as_millis() > i64::MAX as u128
        {
            return Err(SafeError::new(SERVICE_RETRY_INVALID));
        }
        Ok(())
    }
}

impl Default for RetryPolicy {
    fn default() -> Self {
        Self {
            base_delay: StdDuration::from_millis(100),
            max_delay: StdDuration::from_secs(5),
            exponent_cap: 16,
        }
    }
}

/// Compute a capped exponential full-jitter retry timestamp.
pub fn calculate_retry_at<J: JitterSource + ?Sized>(
    now: DateTime<Utc>,
    attempt_count: u32,
    policy: &RetryPolicy,
    jitter: &mut J,
) -> Result<DateTime<Utc>, SafeError> {
    policy.validate()?;
    if !valid_millisecond(now) {
        return Err(SafeError::new(SERVICE_RETRY_INVALID));
    }

    let base_ms = u64::try_from(policy.base_delay.as_millis())
        .map_err(|_| SafeError::new(SERVICE_RETRY_INVALID))?;
    let max_ms = u64::try_from(policy.max_delay.as_millis())
        .map_err(|_| SafeError::new(SERVICE_RETRY_INVALID))?;
    let exponent = attempt_count.min(policy.exponent_cap);
    let multiplier = 1_u64
        .checked_shl(exponent)
        .ok_or_else(|| SafeError::new(SERVICE_RETRY_INVALID))?;
    let exponential_ms = base_ms.saturating_mul(multiplier);
    let cap_ms = max_ms.min(exponential_ms);
    let delay_ms = jitter.sample_ms(cap_ms).min(cap_ms);
    let delay_ms = i64::try_from(delay_ms).map_err(|_| SafeError::new(SERVICE_RETRY_INVALID))?;
    now.checked_add_signed(ChronoDuration::milliseconds(delay_ms))
        .ok_or_else(|| SafeError::new(SERVICE_RETRY_INVALID))
}

/// Alias for callers that describe the result as the next retry deadline.
pub fn next_retry_at<J: JitterSource + ?Sized>(
    now: DateTime<Utc>,
    attempt_count: u32,
    policy: &RetryPolicy,
    jitter: &mut J,
) -> Result<DateTime<Utc>, SafeError> {
    calculate_retry_at(now, attempt_count, policy, jitter)
}

/// Deterministic service coordinator over the encrypted store and four
/// external boundaries.
pub struct GatewayService<T, P, I, C, J, D>
where
    T: MatrixTransport,
    P: MatrixProcessor,
    I: BatchSink,
    C: Clock,
    J: JitterSource,
    D: Shutdown,
{
    store: Store,
    transport: T,
    processor: P,
    sink: I,
    clock: C,
    jitter: J,
    shutdown: D,
    retry_policy: RetryPolicy,
    reconciled: bool,
    sdk_position: Option<SdkInboxPosition>,
    sdk_token_digest: Option<[u8; 32]>,
    processed_inbox: Option<ProcessedInbox>,
    recovery_head: Option<String>,
    recovery_responses: usize,
    recovery_started_at: Option<DateTime<Utc>>,
    recovery_drain_target: Option<String>,
    typing_snapshots: BTreeMap<[u8; 32], TypingSnapshot>,
}

impl<T, P, I, C, J, D> GatewayService<T, P, I, C, J, D>
where
    T: MatrixTransport,
    P: MatrixProcessor,
    I: BatchSink,
    C: Clock,
    J: JitterSource,
    D: Shutdown,
{
    /// Construct a service after validating bootstrap and retry state.
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        store: Store,
        processor: P,
        transport: T,
        sink: I,
        clock: C,
        jitter: J,
        shutdown: D,
        retry_policy: RetryPolicy,
    ) -> Result<Self, SafeError> {
        retry_policy.validate()?;
        if store
            .matrix_session()
            .map_err(|error| SafeError::new(error.code()))?
            .is_none()
        {
            return Err(SafeError::new(SERVICE_NOT_BOOTSTRAPPED));
        }
        Ok(Self {
            store,
            transport,
            processor,
            sink,
            clock,
            jitter,
            shutdown,
            retry_policy,
            reconciled: false,
            sdk_position: None,
            sdk_token_digest: None,
            processed_inbox: None,
            recovery_head: None,
            recovery_responses: 0,
            recovery_started_at: None,
            recovery_drain_target: None,
            typing_snapshots: BTreeMap::new(),
        })
    }

    /// Reconcile the restored SDK position with the authenticated inbox chain.
    pub async fn reconcile_startup(&mut self) -> Result<(), SafeError> {
        if self.reconciled {
            return Ok(());
        }
        let digest = self
            .processor
            .sdk_token_digest()
            .await?
            .ok_or_else(|| SafeError::new(crate::matrix::MATRIX_SDK_POSITION_UNJOURNALED))?;
        let position = self
            .store
            .reconcile_sdk_position(&digest)
            .map_err(|error| SafeError::new(error.code()))?;
        self.sdk_position = Some(position);
        self.sdk_token_digest = Some(digest);
        self.reconciled = true;
        Ok(())
    }

    /// Select and perform at most one top-level durable action.
    pub async fn tick(&mut self) -> Result<ServiceAction, SafeError> {
        if self.shutdown.requested() {
            return Ok(ServiceAction::Shutdown);
        }
        if !self.reconciled {
            return Err(SafeError::new(SERVICE_NOT_RECONCILED));
        }

        if self
            .store
            .crypto_maintenance_status()
            .map_err(|error| SafeError::new(error.code()))?
            .is_some()
        {
            return Err(SafeError::new(SERVICE_MAINTENANCE_REQUIRED));
        }

        let now = self.clock.now();
        if !valid_millisecond(now) {
            return Err(SafeError::new(SERVICE_RETRY_INVALID));
        }

        if let Some(saved) = self
            .store
            .saved_crypto_response()
            .map_err(|error| SafeError::new(error.code()))?
        {
            let acknowledgement = self.processor.rebind_saved_crypto_response(&saved).await?;
            let action = match &acknowledgement {
                RestartCryptoAck::Rebound(_) => ServiceAction::ReboundCryptoResponse,
                RestartCryptoAck::AlreadyApplied(_) => ServiceAction::CompletedCryptoRequest,
                RestartCryptoAck::Unrecoverable(_) => ServiceAction::Wait,
            };
            match acknowledgement {
                RestartCryptoAck::Rebound(proof) | RestartCryptoAck::AlreadyApplied(proof) => {
                    if proof.row_id() != saved.row_id()
                        || proof.response_sha256() != saved.response_sha256()
                    {
                        return Err(SafeError::new(crate::matrix::MATRIX_RESPONSE_INVALID));
                    }
                    self.store
                        .complete_crypto_request(proof.row_id(), now)
                        .map_err(|error| SafeError::new(error.code()))?;
                    return Ok(action);
                }
                RestartCryptoAck::Unrecoverable(reason) => {
                    if reason.as_str() != MATRIX_CRYPTO_ACK_UNRECOVERABLE {
                        return Err(SafeError::new(crate::matrix::MATRIX_RESPONSE_INVALID));
                    }
                    let terminal_reason = ReasonCode::new(reason.as_str().to_owned())
                        .map_err(|_| SafeError::new(crate::matrix::MATRIX_RESPONSE_INVALID))?;
                    self.store
                        .quarantine_crypto_request(saved.row_id(), terminal_reason)
                        .map_err(|error| SafeError::new(error.code()))?;
                    let maintenance_reason = ReasonCode::new(reason.as_str().to_owned())
                        .map_err(|_| SafeError::new(crate::matrix::MATRIX_RESPONSE_INVALID))?;
                    self.store
                        .set_crypto_maintenance(maintenance_reason, now)
                        .map_err(|error| SafeError::new(error.code()))?;
                    return Err(SafeError::new(SERVICE_MAINTENANCE_REQUIRED));
                }
            }
        }

        if let Some(pending) = self
            .store
            .next_pending_crypto_request(now)
            .map_err(|error| SafeError::new(error.code()))?
        {
            let next_attempt_at = calculate_retry_at(
                now,
                pending.attempt_count(),
                &self.retry_policy,
                &mut self.jitter,
            )?;
            // The existing store CAS requires a strictly future lease. Full
            // jitter still permits zero; represent that immediate retry as
            // the next millisecond without changing the pure calculation.
            let persisted_next = if next_attempt_at <= now {
                now.checked_add_signed(ChronoDuration::milliseconds(1))
                    .ok_or_else(|| SafeError::new(SERVICE_RETRY_INVALID))?
            } else {
                next_attempt_at
            };
            self.store
                .record_attempt(
                    pending.row_id(),
                    pending.attempt_count(),
                    pending.next_attempt_at(),
                    now,
                    persisted_next,
                )
                .map_err(|error| SafeError::new(error.code()))?;
            match self.transport.send_crypto(&pending).await {
                Ok(response) => {
                    self.store
                        .record_crypto_response(pending.row_id(), &response)
                        .map_err(|error| SafeError::new(error.code()))?;
                }
                Err(error)
                    if matches!(
                        error.code(),
                        MATRIX_RESPONSE_INVALID
                            | MATRIX_RESPONSE_TOO_LARGE
                            | crate::matrix::MATRIX_TRANSPORT_INVALID
                    ) =>
                {
                    self.quarantine_crypto(pending.row_id(), error.code(), now)?;
                }
                Err(_) => {}
            }
            return Ok(ServiceAction::AttemptedCryptoDelivery);
        }

        if self
            .store
            .has_pending_crypto_request()
            .map_err(|error| SafeError::new(error.code()))?
        {
            return Ok(ServiceAction::Wait);
        }

        if let Some(target) = self.recovery_drain_target.take() {
            self.store
                .mark_crypto_drained(&target)
                .map_err(|error| SafeError::new(error.code()))?;
            return Ok(ServiceAction::MarkedCryptoDrained);
        }

        if let Some(inbox) = self
            .store
            .oldest_uncommitted_inbox()
            .map_err(|error| SafeError::new(error.code()))?
        {
            match inbox.state() {
                SyncInboxState::Fetched => {
                    return self.process_fetched_inbox(inbox, now).await;
                }
                SyncInboxState::SdkProcessed => {
                    if !inbox.crypto_drained() {
                        self.store
                            .mark_crypto_drained(inbox.inbox_id().as_str())
                            .map_err(|error| SafeError::new(error.code()))?;
                        return Ok(ServiceAction::MarkedCryptoDrained);
                    }

                    if let Some(action) = self.recover_or_prepare_head(&inbox, now).await? {
                        return Ok(action);
                    }
                }
                SyncInboxState::Prepared
                | SyncInboxState::Committed
                | SyncInboxState::Quarantined => {}
            }
        }

        if let Some(batch) = self
            .store
            .next_pending_ingestion_batch(now)
            .map_err(|error| SafeError::new(error.code()))?
        {
            return self.deliver_ingestion_batch(batch, now).await;
        }

        let purge_cutoff = now
            .checked_sub_signed(ChronoDuration::days(7))
            .ok_or_else(|| SafeError::new(SERVICE_RETRY_INVALID))?;
        if let Some(digest) = self.sdk_token_digest {
            let purged = self
                .store
                .purge_committed_prefix(purge_cutoff, &digest)
                .map_err(|error| SafeError::new(error.code()))?;
            if purged.inbox_rows() > 0 {
                return Ok(ServiceAction::PurgedCommittedPrefix);
            }
        }

        if self.fetch_backpressured(now)? {
            return Ok(ServiceAction::Wait);
        }

        let fetch_token = self
            .store
            .fetch_sync_token()
            .map_err(|error| SafeError::new(error.code()))?
            .ok_or_else(|| SafeError::new(SERVICE_NOT_BOOTSTRAPPED))?;
        let fetched = self.transport.fetch_sync(&fetch_token).await?;
        let input = fetched.into_store_input(now)?;
        self.store
            .append_fetched_sync(input)
            .map_err(|error| SafeError::new(error.code()))?;
        Ok(ServiceAction::FetchedSync)
    }

    /// Run the coordinator until shutdown. Waiting is deadline-driven and
    /// periodically rechecks the synchronous shutdown seam.
    pub async fn run(&mut self) -> Result<(), SafeError> {
        self.reconcile_startup().await?;
        loop {
            match self.tick().await? {
                ServiceAction::Shutdown => return Ok(()),
                ServiceAction::Wait => {
                    let delay = self.next_wait_duration()?;
                    tokio::time::sleep(delay).await;
                }
                _ => {}
            }
        }
    }

    async fn process_fetched_inbox(
        &mut self,
        inbox: crate::store_types::RawSyncInbox,
        _now: DateTime<Utc>,
    ) -> Result<ServiceAction, SafeError> {
        let position_id = self
            .sdk_position
            .as_ref()
            .and_then(SdkInboxPosition::journaled_inbox_id);
        let use_recovery = match position_id {
            Some(position_id) if inbox.inbox_id() == position_id => true,
            Some(position_id) => inbox.predecessor_id() != Some(position_id),
            None => false,
        };
        let processed = if use_recovery {
            self.processor.recover_saved_sync(&inbox).await?
        } else {
            self.processor.apply_saved_sync(&inbox).await?
        };
        let requests = match self.processor.pending_crypto_requests().await {
            Ok(requests) => requests,
            Err(error) if error.code() == MATRIX_CRYPTO_MAINTENANCE_REQUIRED => {
                self.set_maintenance(CRYPTO_MAINTENANCE_CODE, *inbox.observed_at())?;
                return Err(SafeError::new(SERVICE_MAINTENANCE_REQUIRED));
            }
            Err(error) if error.code() == MATRIX_CRYPTO_KIND_NOT_ALLOWED => {
                self.set_maintenance(MATRIX_CRYPTO_KIND_NOT_ALLOWED, *inbox.observed_at())?;
                return Err(SafeError::new(SERVICE_MAINTENANCE_REQUIRED));
            }
            Err(error) => return Err(error),
        };
        self.store
            .record_sdk_processing(inbox.inbox_id().as_str(), &requests)
            .map_err(|error| SafeError::new(error.code()))?;
        let has_recovery_marker = processed.has_undecryptable_events();
        self.processed_inbox = Some(ProcessedInbox {
            inbox_id: inbox.inbox_id().as_str().to_owned(),
            processed,
        });
        if has_recovery_marker {
            self.recovery_head = Some(inbox.inbox_id().as_str().to_owned());
            self.recovery_started_at = Some(*inbox.observed_at());
            self.recovery_responses = 0;
        }
        let reached_position = self
            .sdk_position
            .as_ref()
            .and_then(SdkInboxPosition::journaled_inbox_id)
            .is_some_and(|position_id| position_id == inbox.inbox_id());
        if !use_recovery || reached_position {
            self.sdk_position = None;
        }
        if requests.is_empty() {
            Ok(ServiceAction::ProcessedInbox)
        } else {
            Ok(ServiceAction::PersistedCryptoRequests)
        }
    }

    async fn recover_or_prepare_head(
        &mut self,
        inbox: &crate::store_types::RawSyncInbox,
        now: DateTime<Utc>,
    ) -> Result<Option<ServiceAction>, SafeError> {
        let processed = match self.processed_inbox.take() {
            Some(value) if value.inbox_id == inbox.inbox_id().as_str() => {
                let was_undecryptable = value.processed.has_undecryptable_events();
                if was_undecryptable {
                    let recovered = self.processor.recover_saved_sync(inbox).await?;
                    if recovered.event_count() == 0 {
                        value.processed
                    } else {
                        recovered
                    }
                } else {
                    value.processed
                }
            }
            Some(value) => {
                self.processed_inbox = Some(value);
                self.processor.recover_saved_sync(inbox).await?
            }
            None => self.processor.recover_saved_sync(inbox).await?,
        };

        if processed.has_undecryptable_events() {
            let head_id = inbox.inbox_id().as_str().to_owned();
            self.processed_inbox = Some(ProcessedInbox {
                inbox_id: head_id,
                processed,
            });
            self.recovery_head
                .get_or_insert_with(|| inbox.inbox_id().as_str().to_owned());
            self.recovery_started_at.get_or_insert(*inbox.observed_at());
            let rows = self
                .store
                .uncommitted_inbox_rows()
                .map_err(|error| SafeError::new(error.code()))?;
            let start = self.recovery_started_at.unwrap_or(*inbox.observed_at());
            let elapsed = now.signed_duration_since(start);
            let later = rows.iter().skip(1).collect::<Vec<_>>();
            let persisted_later = later.len();
            self.recovery_responses = self.recovery_responses.max(persisted_later);
            if let Some(next) = later
                .iter()
                .find(|row| row.state() == SyncInboxState::Fetched)
            {
                if self.recovery_responses > MAX_RECOVERY_RESPONSES
                    || elapsed > ChronoDuration::minutes(10)
                {
                    return Err(SafeError::new(MATRIX_KEY_RECOVERY_EXHAUSTED));
                }
                let _later_processed = self.processor.apply_saved_sync(next).await?;
                let requests = self.processor.pending_crypto_requests().await?;
                self.store
                    .record_sdk_processing(next.inbox_id().as_str(), &requests)
                    .map_err(|error| SafeError::new(error.code()))?;
                self.recovery_drain_target = Some(next.inbox_id().as_str().to_owned());
                self.recovery_responses = persisted_later;
                return Ok(Some(if requests.is_empty() {
                    ServiceAction::ProcessedInbox
                } else {
                    ServiceAction::PersistedCryptoRequests
                }));
            }
            if self.recovery_responses >= MAX_RECOVERY_RESPONSES
                || elapsed > ChronoDuration::minutes(10)
            {
                return Err(SafeError::new(MATRIX_KEY_RECOVERY_EXHAUSTED));
            }
            if self.fetch_backpressured(now)? {
                return Ok(Some(ServiceAction::Wait));
            }
            let fetch_token = self
                .store
                .fetch_sync_token()
                .map_err(|error| SafeError::new(error.code()))?
                .ok_or_else(|| SafeError::new(SERVICE_NOT_BOOTSTRAPPED))?;
            let fetched = self.transport.fetch_sync(&fetch_token).await?;
            self.store
                .append_fetched_sync(fetched.into_store_input(now)?)
                .map_err(|error| SafeError::new(error.code()))?;
            self.recovery_responses = self.recovery_responses.saturating_add(1);
            return Ok(Some(ServiceAction::FetchedSync));
        }

        self.recovery_head = None;
        self.recovery_started_at = None;
        self.recovery_responses = 0;
        self.processed_inbox = Some(ProcessedInbox {
            inbox_id: inbox.inbox_id().as_str().to_owned(),
            processed,
        });
        self.prepare_live_window(inbox, now).await
    }

    async fn prepare_live_window(
        &mut self,
        inbox: &crate::store_types::RawSyncInbox,
        now: DateTime<Utc>,
    ) -> Result<Option<ServiceAction>, SafeError> {
        let processed = self
            .processed_inbox
            .take()
            .filter(|value| value.inbox_id == inbox.inbox_id().as_str())
            .map(|value| value.processed)
            .unwrap_or_else(|| ProcessedSync::new(Vec::new(), Vec::new()));
        let (routed, ignored_count, typing) = self.project_observations(&processed, inbox, now)?;
        let window_id = self
            .store
            .live_window_id_for_inbox(inbox.inbox_id().as_str())
            .map_err(|error| SafeError::new(error.code()))?;
        let archived_at = now.max(*inbox.observed_at());

        for gap in processed.gaps() {
            let room_id = str::from_utf8(gap.room_id().as_bytes())
                .map_err(|_| SafeError::new(MATRIX_MALFORMED_EVENT))?;
            let lookup = self
                .store
                .matrix_room_lookup(room_id)
                .map_err(|error| SafeError::new(error.code()))?;
            if self
                .store
                .active_room_binding(&lookup)
                .map_err(|error| SafeError::new(error.code()))?
                .is_none()
            {
                return Err(SafeError::new(MATRIX_UNKNOWN_ROOM));
            }
        }

        if let Some((prev_batch, _room_id)) = processed.gaps().first().map(|gap| {
            (
                gap.prev_batch().as_bytes().to_vec(),
                gap.room_id().as_bytes().to_vec(),
            )
        }) {
            self.store
                .create_collecting_live_window(
                    inbox.inbox_id().as_str(),
                    NewLiveWindow::new(window_id.clone(), archived_at, ignored_count)
                        .map_err(|error| SafeError::new(error.code()))?,
                )
                .map_err(|error| SafeError::new(error.code()))?;
            let mut digest_input =
                Vec::with_capacity(inbox.inbox_id().as_str().len() + prev_batch.len());
            digest_input.extend_from_slice(inbox.inbox_id().as_str().as_bytes());
            digest_input.extend_from_slice(&prev_batch);
            let digest = Sha256::digest(&digest_input);
            let job_id = format!(
                "job_{}",
                digest
                    .iter()
                    .map(|byte| format!("{byte:02x}"))
                    .collect::<String>()
            );
            self.store
                .create_live_gap_job(
                    NewLiveGapJob::new(job_id, window_id, prev_batch, archived_at)
                        .map_err(|error| SafeError::new(error.code()))?,
                )
                .map_err(|error| SafeError::new(error.code()))?;
            return Ok(Some(ServiceAction::PreparedLiveWindow));
        }

        let window = batch::build_window(
            WindowSource::live(inbox.next_token().as_bytes()),
            archived_at,
            &routed,
        )
        .map_err(|error| SafeError::new(error.code()))?;
        if window.quarantined_count() != 0 {
            return Err(SafeError::new(SERVICE_PROJECTION_BLOCKED));
        }
        self.store
            .create_collecting_live_window(
                inbox.inbox_id().as_str(),
                NewLiveWindow::new(window_id.clone(), archived_at, ignored_count)
                    .map_err(|error| SafeError::new(error.code()))?,
            )
            .map_err(|error| SafeError::new(error.code()))?;

        if window.batches.is_empty() {
            self.store
                .commit_empty_live_window(
                    inbox.inbox_id().as_str(),
                    &window_id,
                    &[],
                    &typing_candidates(&typing)?,
                    archived_at,
                )
                .map_err(|error| SafeError::new(error.code()))?;
            self.persist_typing_snapshots(typing);
            return Ok(Some(ServiceAction::CommittedEmptyWindow));
        }

        let outcome = self
            .store
            .finalize_live_window(
                inbox.inbox_id().as_str(),
                &window_id,
                &window,
                &[],
                &typing_candidates(&typing)?,
            )
            .map_err(|error| SafeError::new(error.code()))?;
        self.persist_typing_snapshots(typing);
        Ok(Some(match outcome {
            FinalizeOutcome::Prepared { .. } | FinalizeOutcome::AlreadyPrepared { .. } => {
                ServiceAction::PreparedLiveWindow
            }
        }))
    }

    fn project_observations(
        &mut self,
        processed: &ProcessedSync,
        inbox: &crate::store_types::RawSyncInbox,
        observed_at: DateTime<Utc>,
    ) -> Result<(Vec<RoutedEvent>, u64, Vec<TypingCandidate>), SafeError> {
        let raw = serde_json::from_slice::<Value>(inbox.response().as_bytes())
            .map_err(|_| SafeError::new(MATRIX_MALFORMED_EVENT))?;
        if !raw.is_object() {
            return Err(SafeError::new(MATRIX_MALFORMED_EVENT));
        }
        if let Some(rooms) = raw.get("rooms")
            && (!rooms.is_object()
                || ["join", "invite", "leave"]
                    .iter()
                    .any(|section| rooms.get(*section).is_some_and(|value| !value.is_object())))
        {
            return Err(SafeError::new(MATRIX_MALFORMED_EVENT));
        }
        if raw_has_non_joined_rooms(inbox.response().as_bytes()) {
            return Err(SafeError::new(MATRIX_UNKNOWN_ROOM));
        }
        for room_id in raw_joined_room_ids(inbox.response().as_bytes()) {
            let lookup = self
                .store
                .matrix_room_lookup(&room_id)
                .map_err(|error| SafeError::new(error.code()))?;
            if self
                .store
                .active_room_binding(&lookup)
                .map_err(|error| SafeError::new(error.code()))?
                .is_none()
            {
                return Err(SafeError::new(MATRIX_UNKNOWN_ROOM));
            }
        }
        let mut parsed = Vec::new();
        let mut known = KnownRelations::new();
        let mut bindings = BTreeMap::new();
        for event in processed.events() {
            let room_id = str::from_utf8(event.room_event().room_id().as_bytes())
                .map_err(|_| SafeError::new(MATRIX_MALFORMED_EVENT))?;
            let lookup = self
                .store
                .matrix_room_lookup(room_id)
                .map_err(|error| SafeError::new(error.code()))?;
            let binding = self
                .store
                .active_room_binding(&lookup)
                .map_err(|error| SafeError::new(error.code()))?
                .ok_or_else(|| SafeError::new(MATRIX_UNKNOWN_ROOM))?;
            let key = lookup;
            seed_known_relations(event, room_id, &binding, &mut known);
            bindings.insert(key, binding);
            if !self.typing_snapshots.contains_key(&key)
                && let Some((typing_set, expires_at)) = self
                    .store
                    .room_ephemeral_typing(&key)
                    .map_err(|error| SafeError::new(error.code()))?
            {
                let members = serde_json::from_slice::<Vec<String>>(typing_set.as_bytes())
                    .map_err(|_| SafeError::new(MATRIX_MALFORMED_EVENT))?;
                let observed = expires_at
                    .checked_sub_signed(ChronoDuration::seconds(30))
                    .ok_or_else(|| SafeError::new(normalize::MATRIX_INVALID_TIMESTAMP))?;
                self.typing_snapshots.insert(
                    key,
                    TypingSnapshot {
                        members,
                        observed_at: observed,
                    },
                );
            }
            parsed.push((event, room_id.to_owned(), key));
        }

        let mut routed = Vec::new();
        let mut ignored_count = 0_u64;
        let mut typing = Vec::new();
        for (event, room_id, lookup) in parsed {
            let binding = bindings
                .get(&lookup)
                .ok_or_else(|| SafeError::new(MATRIX_UNKNOWN_ROOM))?;
            let converted = convert_sdk_event(
                event,
                &room_id,
                lookup,
                &self.typing_snapshots,
                &format!(
                    "sha256:{}",
                    inbox
                        .next_token_digest()
                        .iter()
                        .map(|byte| format!("{byte:02x}"))
                        .collect::<String>()
                ),
                observed_at,
            )?;
            for converted in converted {
                if let Some(value) = converted.typing {
                    typing.push(value);
                }
                match normalize::normalize(converted.event, binding, &known, observed_at) {
                    NormalizeOutcome::Events(events) => {
                        for event in events {
                            routed.push(RoutedEvent::new(binding.gateway_route_id(), event));
                        }
                    }
                    NormalizeOutcome::Ignored { reason_code } if safe_ignored(reason_code) => {
                        ignored_count = ignored_count.saturating_add(1);
                    }
                    NormalizeOutcome::RetryWindow { reason_code } => {
                        return Err(SafeError::new(reason_code));
                    }
                    NormalizeOutcome::SourceGap { .. } => {
                        return Err(SafeError::new("matrix_source_gap"));
                    }
                    NormalizeOutcome::Ignored { reason_code } => {
                        return Err(SafeError::new(reason_code));
                    }
                }
            }
        }
        Ok((routed, ignored_count, typing))
    }

    async fn deliver_ingestion_batch(
        &mut self,
        pending: crate::ledger::PendingIngestionBatch,
        now: DateTime<Utc>,
    ) -> Result<ServiceAction, SafeError> {
        let next_attempt = calculate_retry_at(
            now,
            pending.attempt_count(),
            &self.retry_policy,
            &mut self.jitter,
        )?;
        let next_attempt = if next_attempt <= now {
            now.checked_add_signed(ChronoDuration::milliseconds(1))
                .ok_or_else(|| SafeError::new(SERVICE_RETRY_INVALID))?
        } else {
            next_attempt
        };
        self.store
            .record_ingestion_attempt(
                pending.row_id(),
                pending.attempt_count(),
                *pending.next_attempt_at(),
                now,
                next_attempt,
            )
            .map_err(|error| SafeError::new(error.code()))?;
        match self.sink.deliver(pending.batch()).await {
            Ok(_) => {
                let accepted = self
                    .store
                    .accept_live_batch_and_maybe_commit_window(pending.row_id(), now);
                match accepted {
                    Ok(_) => Ok(ServiceAction::AcceptedIngestionBatch),
                    Err(error) if error.code() == crate::ledger::STORE_LEDGER_NOT_READY => self
                        .store
                        .accept_backfill_batch_and_maybe_complete_job(pending.row_id(), now)
                        .map(|_| ServiceAction::AcceptedIngestionBatch)
                        .map_err(|error| SafeError::new(error.code())),
                    Err(error) => Err(SafeError::new(error.code())),
                }
            }
            Err(error) if error.class() == crate::ingestion::DeliveryErrorClass::Terminal => {
                let reason = ReasonCode::new(error.code().to_owned())
                    .map_err(|_| SafeError::new(SERVICE_PROJECTION_BLOCKED))?;
                self.store
                    .quarantine_live_batch(pending.row_id(), reason)
                    .map_err(|value| SafeError::new(value.code()))?;
                Err(SafeError::new(error.code()))
            }
            Err(_) => Ok(ServiceAction::AttemptedIngestionDelivery),
        }
    }

    fn quarantine_crypto(
        &mut self,
        row_id: &str,
        code: &'static str,
        at: DateTime<Utc>,
    ) -> Result<(), SafeError> {
        let reason = ReasonCode::new(code.to_owned())
            .map_err(|_| SafeError::new(SERVICE_MAINTENANCE_REQUIRED))?;
        self.store
            .quarantine_crypto_request(row_id, reason.clone())
            .map_err(|error| SafeError::new(error.code()))?;
        let maintenance = ReasonCode::new(CRYPTO_MAINTENANCE_CODE.to_owned())
            .map_err(|_| SafeError::new(SERVICE_MAINTENANCE_REQUIRED))?;
        self.store
            .set_crypto_maintenance(maintenance, at)
            .map_err(|error| SafeError::new(error.code()))
    }

    fn set_maintenance(&mut self, code: &'static str, at: DateTime<Utc>) -> Result<(), SafeError> {
        let reason = ReasonCode::new(code.to_owned())
            .map_err(|_| SafeError::new(SERVICE_MAINTENANCE_REQUIRED))?;
        self.store
            .set_crypto_maintenance(reason, at)
            .map_err(|error| SafeError::new(error.code()))
    }

    fn fetch_backpressured(&self, now: DateTime<Utc>) -> Result<bool, SafeError> {
        let rows = self
            .store
            .uncommitted_inbox_rows()
            .map_err(|error| SafeError::new(error.code()))?;
        let pending_bytes = rows.iter().try_fold(0_u64, |total, row| {
            total
                .checked_add(
                    u64::try_from(row.byte_count())
                        .map_err(|_| SafeError::new(SERVICE_RETRY_INVALID))?,
                )
                .ok_or_else(|| SafeError::new(SERVICE_RETRY_INVALID))
        })?;
        let oldest = rows.iter().map(|row| *row.observed_at()).min();
        let inbox_pressure = rows.len() as u64 >= MAX_PENDING_INBOX_ROWS
            || pending_bytes >= MAX_PROTECTED_BYTES
            || oldest
                .is_some_and(|value| now.signed_duration_since(value) > ChronoDuration::hours(24));
        let ledger = self
            .store
            .ledger_pressure()
            .map_err(|error| SafeError::new(error.code()))?;
        Ok(inbox_pressure
            || ledger.pending_batches() >= MAX_PENDING_INBOX_ROWS
            || ledger.pending_bytes() >= MAX_PROTECTED_BYTES
            || ledger
                .oldest_pending_at()
                .is_some_and(|value| now.signed_duration_since(*value) > ChronoDuration::hours(24)))
    }

    fn persist_typing_snapshots(&mut self, typing: Vec<TypingCandidate>) {
        for value in typing {
            self.typing_snapshots.insert(
                value.lookup,
                TypingSnapshot {
                    members: value.members,
                    observed_at: value.observed_at,
                },
            );
        }
    }

    fn next_wait_duration(&self) -> Result<StdDuration, SafeError> {
        let now = self.clock.now();
        if !valid_millisecond(now) {
            return Err(SafeError::new(SERVICE_RETRY_INVALID));
        }
        let crypto_deadline = self
            .store
            .next_crypto_retry_at()
            .map_err(|error| SafeError::new(error.code()))?;
        let ledger_deadline = self
            .store
            .ledger_pressure()
            .map_err(|error| SafeError::new(error.code()))?
            .oldest_pending_at()
            .copied();
        let deadline = [crypto_deadline, ledger_deadline]
            .into_iter()
            .flatten()
            .min();
        let Some(deadline) = deadline else {
            return Ok(StdDuration::from_millis(10));
        };
        if deadline <= now {
            return Ok(StdDuration::ZERO);
        }
        let millis = deadline.signed_duration_since(now).num_milliseconds();
        let millis = u64::try_from(millis).map_err(|_| SafeError::new(SERVICE_RETRY_INVALID))?;
        Ok(StdDuration::from_millis(millis))
    }

    #[allow(dead_code)]
    fn _keep_sink_owned(&self) -> &I {
        &self.sink
    }
}

fn valid_millisecond(value: DateTime<Utc>) -> bool {
    value.timestamp_subsec_nanos().is_multiple_of(1_000_000)
}

struct ConvertedObservation {
    event: NormalizedMatrixEvent,
    typing: Option<TypingCandidate>,
}

struct TypingCandidate {
    lookup: [u8; 32],
    members: Vec<String>,
    observed_at: DateTime<Utc>,
    expires_at: DateTime<Utc>,
}

fn typing_candidates(values: &[TypingCandidate]) -> Result<Vec<RoomEphemeralCandidate>, SafeError> {
    let mut latest = BTreeMap::<[u8; 32], &TypingCandidate>::new();
    for value in values {
        latest.insert(value.lookup, value);
    }
    latest
        .into_iter()
        .map(|(lookup, value)| {
            let bytes = serde_json::to_vec(&value.members)
                .map_err(|_| SafeError::new(MATRIX_SDK_FAILED))?;
            RoomEphemeralCandidate::new(lookup.to_vec(), bytes, value.expires_at)
        })
        .collect()
}

fn safe_ignored(reason_code: &str) -> bool {
    matches!(
        reason_code,
        normalize::MATRIX_UNSUPPORTED_MESSAGE_TYPE
            | normalize::MATRIX_UNSUPPORTED_STATE
            | normalize::MATRIX_UNSUPPORTED_EPHEMERAL
            | normalize::MATRIX_TYPING_UNCHANGED
    )
}

fn raw_has_non_joined_rooms(bytes: &[u8]) -> bool {
    let Ok(value) = serde_json::from_slice::<Value>(bytes) else {
        return false;
    };
    let Some(rooms) = value.get("rooms").and_then(Value::as_object) else {
        return false;
    };
    ["invite", "leave"].iter().any(|section| {
        rooms
            .get(*section)
            .and_then(Value::as_object)
            .is_some_and(|rows| !rows.is_empty())
    })
}

fn raw_joined_room_ids(bytes: &[u8]) -> Vec<String> {
    serde_json::from_slice::<Value>(bytes)
        .ok()
        .and_then(|value| value.get("rooms").cloned())
        .and_then(|rooms| rooms.get("join").cloned())
        .and_then(|join| join.as_object().cloned())
        .map(|rooms| rooms.keys().cloned().collect())
        .unwrap_or_default()
}

fn json_string<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value.get(key).and_then(Value::as_str)
}

fn event_timestamp(value: &Value, fallback: DateTime<Utc>) -> Result<DateTime<Utc>, SafeError> {
    let Some(raw) = value.get("origin_server_ts") else {
        return Ok(fallback);
    };
    let millis = raw
        .as_i64()
        .ok_or_else(|| SafeError::new(normalize::MATRIX_INVALID_TIMESTAMP))?;
    Utc.timestamp_millis_opt(millis)
        .single()
        .filter(|value| valid_millisecond(*value))
        .ok_or_else(|| SafeError::new(normalize::MATRIX_INVALID_TIMESTAMP))
}

fn timestamp_text(value: DateTime<Utc>) -> String {
    value.to_rfc3339_opts(SecondsFormat::Millis, true)
}

fn seed_known_relations(
    event: &SdkObservedMatrixEvent,
    _room_id: &str,
    binding: &crate::registry::RoomBinding,
    known: &mut KnownRelations,
) {
    let room_event = event.room_event();
    let Ok(value) = serde_json::from_slice::<Value>(room_event.exact_json().as_bytes()) else {
        return;
    };
    let Some(event_type) = json_string(&value, "type") else {
        return;
    };
    match event_type {
        "m.room.message" => {
            if let Some(event_id) = json_string(&value, "event_id") {
                known.insert(event_id.to_owned(), KnownRelation::message(_room_id));
            }
        }
        "m.reaction" => {
            if let (Some(event_id), Some(target)) = (
                json_string(&value, "event_id"),
                value
                    .get("content")
                    .and_then(|content| content.get("m.relates_to"))
                    .and_then(|relates| relates.get("event_id"))
                    .and_then(Value::as_str),
            ) {
                known.insert(
                    event_id.to_owned(),
                    KnownRelation::reaction(_room_id, target),
                );
            }
        }
        "m.room.member" => {
            if json_string(&value, "sender") == Some(binding.owner_matrix_user_id())
                && value
                    .get("content")
                    .and_then(|content| json_string(content, "membership"))
                    == Some("join")
                && let Some(member) = json_string(&value, "state_key")
            {
                known.insert(member.to_owned(), KnownRelation::participant(_room_id));
            }
        }
        _ => {}
    }
}

fn convert_sdk_event(
    event: &SdkObservedMatrixEvent,
    room_id: &str,
    room_lookup: [u8; 32],
    typing_snapshots: &BTreeMap<[u8; 32], TypingSnapshot>,
    checkpoint_digest: &str,
    fallback_at: DateTime<Utc>,
) -> Result<Vec<ConvertedObservation>, SafeError> {
    let room_event = event.room_event();
    let exact = room_event.exact_json().as_bytes();
    if room_event.unable_to_decrypt() {
        return Ok(vec![ConvertedObservation {
            event: NormalizedMatrixEvent::UnableToDecrypt(normalize::MatrixUnableToDecrypt::new(
                ProtectedBytes::new(exact),
                normalize::MATRIX_UNABLE_TO_DECRYPT,
            )),
            typing: None,
        }]);
    }
    let value = serde_json::from_slice::<Value>(exact)
        .map_err(|_| SafeError::new(MATRIX_MALFORMED_EVENT))?;
    let event_type =
        json_string(&value, "type").ok_or_else(|| SafeError::new(MATRIX_MALFORMED_EVENT))?;
    let occurred_at = event_timestamp(&value, fallback_at)?;
    let occurred_text = timestamp_text(occurred_at);
    let sender = json_string(&value, "sender");
    let event_id = json_string(&value, "event_id");
    let content = value
        .get("content")
        .cloned()
        .unwrap_or(Value::Object(Default::default()));
    let one = |event| {
        vec![ConvertedObservation {
            event,
            typing: None,
        }]
    };
    match event {
        SdkObservedMatrixEvent::Timeline(_) => match event_type {
            "m.room.message" => {
                let sender = sender.ok_or_else(|| SafeError::new(MATRIX_MALFORMED_EVENT))?;
                let event_id = event_id.ok_or_else(|| SafeError::new(MATRIX_MALFORMED_EVENT))?;
                let msgtype = json_string(&content, "msgtype")
                    .ok_or_else(|| SafeError::new(MATRIX_MALFORMED_EVENT))?;
                let kind = match msgtype {
                    "m.text" => MatrixMessageKind::Text,
                    "m.notice" => MatrixMessageKind::Notice,
                    "m.emote" => MatrixMessageKind::Emote,
                    "m.image" => MatrixMessageKind::Image,
                    "m.file" => MatrixMessageKind::File,
                    "m.audio" => MatrixMessageKind::Audio,
                    "m.video" => MatrixMessageKind::Video,
                    _ => MatrixMessageKind::Unsupported,
                };
                let body = json_string(&content, "body").unwrap_or("");
                let sender_label = json_string(&content, "sender_name").unwrap_or(sender);
                let relation = content.get("m.relates_to").and_then(|relates| {
                    let target = relates.get("event_id")?.as_str()?;
                    match relates.get("rel_type").and_then(Value::as_str) {
                        Some("m.replace") => Some(MatrixRelation::replace(target)),
                        Some("m.in_reply_to") | None => Some(MatrixRelation::reply(target)),
                        _ => None,
                    }
                });
                let mut message = MatrixMessage::new(
                    room_id,
                    event_id,
                    sender,
                    sender_label,
                    body,
                    occurred_text.clone(),
                )
                .with_kind(kind)
                .with_attachments(parse_attachments(&content));
                if let Some(relation) = relation {
                    message = message.with_relation(relation);
                }
                if let Some(new_body) = content
                    .get("m.new_content")
                    .and_then(|new_content| new_content.get("body"))
                    .and_then(Value::as_str)
                {
                    message = MatrixMessage::new(
                        room_id,
                        event_id,
                        sender,
                        sender_label,
                        new_body,
                        occurred_text,
                    )
                    .with_kind(kind)
                    .with_relation(MatrixRelation::replace(
                        content
                            .get("m.relates_to")
                            .and_then(|relates| relates.get("event_id"))
                            .and_then(Value::as_str)
                            .unwrap_or("$missing:matrix"),
                    ));
                }
                Ok(one(NormalizedMatrixEvent::Message(message)))
            }
            "m.reaction" => {
                let sender = sender.ok_or_else(|| SafeError::new(MATRIX_MALFORMED_EVENT))?;
                let event_id = event_id.ok_or_else(|| SafeError::new(MATRIX_MALFORMED_EVENT))?;
                let relates = content
                    .get("m.relates_to")
                    .ok_or_else(|| SafeError::new(MATRIX_MALFORMED_EVENT))?;
                let target = json_string(relates, "event_id").unwrap_or("");
                let emoji = json_string(relates, "key").unwrap_or("");
                Ok(one(NormalizedMatrixEvent::Reaction(MatrixReaction::new(
                    room_id,
                    event_id,
                    sender,
                    target,
                    emoji,
                    occurred_text,
                ))))
            }
            "m.room.redaction" => {
                let sender = sender.ok_or_else(|| SafeError::new(MATRIX_MALFORMED_EVENT))?;
                let event_id = event_id.ok_or_else(|| SafeError::new(MATRIX_MALFORMED_EVENT))?;
                let target = json_string(&value, "redacts")
                    .or_else(|| json_string(&content, "redacts"))
                    .unwrap_or("");
                let reason = json_string(&content, "reason").map(str::to_owned);
                Ok(one(NormalizedMatrixEvent::Redaction(MatrixRedaction::new(
                    room_id,
                    event_id,
                    sender,
                    target,
                    reason,
                    occurred_text,
                ))))
            }
            _ => Ok(one(NormalizedMatrixEvent::Unsupported {
                reason_code: normalize::MATRIX_UNSUPPORTED_MESSAGE_TYPE,
            })),
        },
        SdkObservedMatrixEvent::State(_) => match event_type {
            "m.room.name" | "m.room.topic" | "m.room.avatar" | "m.room.avatar_url" => {
                let sender = sender.ok_or_else(|| SafeError::new(MATRIX_MALFORMED_EVENT))?;
                let event_id = event_id.ok_or_else(|| SafeError::new(MATRIX_MALFORMED_EVENT))?;
                let (kind, title) = match event_type {
                    "m.room.name" => (MatrixRoomStateKind::Name, json_string(&content, "name")),
                    "m.room.topic" => (MatrixRoomStateKind::Topic, json_string(&content, "topic")),
                    "m.room.avatar" | "m.room.avatar_url" => {
                        (MatrixRoomStateKind::Avatar, json_string(&content, "url"))
                    }
                    _ => unreachable!("event type was matched above"),
                };
                Ok(one(NormalizedMatrixEvent::RoomState(MatrixRoomState::new(
                    room_id,
                    event_id,
                    sender,
                    kind,
                    title.unwrap_or(""),
                    false,
                    false,
                    occurred_text,
                ))))
            }
            "m.room.member" => {
                let sender = sender.ok_or_else(|| SafeError::new(MATRIX_MALFORMED_EVENT))?;
                let event_id = event_id.ok_or_else(|| SafeError::new(MATRIX_MALFORMED_EVENT))?;
                let member = json_string(&value, "state_key").unwrap_or("");
                let membership = json_string(&content, "membership").unwrap_or("");
                if membership == "leave" {
                    return Err(SafeError::new(MATRIX_ROOM_MEMBERSHIP_INVALID));
                }
                let kind = match membership {
                    "join" => MatrixMembershipKind::Joined,
                    _ => MatrixMembershipKind::Unsupported,
                };
                Ok(one(NormalizedMatrixEvent::Membership(
                    MatrixMembership::new(
                        room_id,
                        event_id,
                        sender,
                        member,
                        kind,
                        json_string(&content, "displayname").unwrap_or(member),
                        json_string(&content, "remote_id").map(str::to_owned),
                        json_string(&content, "avatar_url").map(str::to_owned),
                        occurred_text,
                    ),
                )))
            }
            _ => Ok(one(NormalizedMatrixEvent::Unsupported {
                reason_code: normalize::MATRIX_UNSUPPORTED_STATE,
            })),
        },
        SdkObservedMatrixEvent::Receipt(_) => {
            let mut output = Vec::new();
            if let Some(content) = content.as_object() {
                for (target, receipt_value) in content {
                    let Some(receipts) = receipt_value.as_object() else {
                        continue;
                    };
                    for (receipt_kind, users_value) in receipts {
                        let Some(users) = users_value.as_object() else {
                            continue;
                        };
                        let receipt_type = match receipt_kind.as_str() {
                            "m.read" => MatrixReceiptType::Read,
                            "m.delivered" => MatrixReceiptType::Delivered,
                            _ => continue,
                        };
                        for user_id in users.keys() {
                            output.push(ConvertedObservation {
                                event: NormalizedMatrixEvent::Receipt(MatrixReceipt::new(
                                    room_id,
                                    target,
                                    user_id,
                                    receipt_type,
                                    occurred_text.clone(),
                                )),
                                typing: None,
                            });
                        }
                    }
                }
            }
            if output.is_empty() {
                Ok(one(NormalizedMatrixEvent::Unsupported {
                    reason_code: normalize::MATRIX_UNSUPPORTED_EPHEMERAL,
                }))
            } else {
                Ok(output)
            }
        }
        SdkObservedMatrixEvent::Typing(_) => {
            let members = content
                .get("user_ids")
                .and_then(Value::as_array)
                .map(|values| {
                    values
                        .iter()
                        .filter_map(Value::as_str)
                        .map(str::to_owned)
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            let previous = typing_snapshots
                .get(&room_lookup)
                .filter(|snapshot| now_before_expiry(fallback_at, snapshot.observed_at))
                .map(|snapshot| snapshot.members.clone())
                .unwrap_or_default();
            let expires_at = occurred_at
                .checked_add_signed(ChronoDuration::seconds(30))
                .ok_or_else(|| SafeError::new(normalize::MATRIX_INVALID_TIMESTAMP))?;
            Ok(vec![ConvertedObservation {
                event: NormalizedMatrixEvent::Typing(MatrixTyping::new(
                    room_id,
                    checkpoint_digest,
                    members.clone(),
                    previous,
                )),
                typing: Some(TypingCandidate {
                    lookup: room_lookup,
                    members,
                    observed_at: occurred_at,
                    expires_at,
                }),
            }])
        }
    }
}

fn parse_attachments(content: &Value) -> Vec<MatrixAttachment> {
    let file = content.get("file").unwrap_or(content);
    let file_name = content
        .get("filename")
        .or_else(|| file.get("name"))
        .and_then(Value::as_str)
        .map(str::to_owned);
    let mime_type = content
        .get("info")
        .and_then(|info| info.get("mimetype"))
        .or_else(|| content.get("mimetype"))
        .and_then(Value::as_str)
        .map(str::to_owned);
    let size_bytes = content
        .get("info")
        .and_then(|info| info.get("size"))
        .or_else(|| content.get("size"))
        .and_then(Value::as_u64);
    let sha256 = file
        .get("hashes")
        .and_then(|hashes| hashes.get("sha256"))
        .or_else(|| content.get("sha256"))
        .and_then(Value::as_str)
        .map(str::to_owned);
    if file_name.is_none() && mime_type.is_none() && size_bytes.is_none() && sha256.is_none() {
        Vec::new()
    } else {
        vec![MatrixAttachment::new(
            file_name, mime_type, size_bytes, sha256,
        )]
    }
}

fn now_before_expiry(now: DateTime<Utc>, observed_at: DateTime<Utc>) -> bool {
    now <= observed_at + ChronoDuration::seconds(30)
}
