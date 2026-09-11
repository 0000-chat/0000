//! Deterministic orchestration seams for the Matrix gateway service.
//!
//! The service owns the application store and selects at most one durable
//! state-machine action per tick.  Network and SDK behavior stays behind the
//! narrow traits in [`crate::matrix`], while time, jitter, and shutdown are
//! explicit inputs so the coordinator can be exercised without ambient state.

use std::{fmt, time::Duration as StdDuration};

use chrono::{DateTime, Duration as ChronoDuration, Utc};

use crate::{
    ingestion::BatchSink,
    matrix::{MATRIX_CRYPTO_ACK_UNRECOVERABLE, MatrixProcessor, MatrixTransport, RestartCryptoAck},
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

const MAX_RETRY_EXPONENT: u32 = 63;

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
                    return Ok(ServiceAction::ReboundCryptoResponse);
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
            if let Ok(response) = self.transport.send_crypto(&pending).await {
                self.store
                    .record_crypto_response(pending.row_id(), &response)
                    .map_err(|error| SafeError::new(error.code()))?;
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

        if let Some(inbox) = self
            .store
            .oldest_uncommitted_inbox()
            .map_err(|error| SafeError::new(error.code()))?
        {
            match inbox.state() {
                SyncInboxState::Fetched => {
                    let position_id = self
                        .sdk_position
                        .as_ref()
                        .and_then(SdkInboxPosition::journaled_inbox_id);
                    let use_recovery = match position_id {
                        Some(position_id) if inbox.inbox_id() == position_id => true,
                        Some(position_id) => inbox.predecessor_id() != Some(position_id),
                        None => false,
                    };
                    let _processed = if use_recovery {
                        self.processor.recover_saved_sync(&inbox).await?
                    } else {
                        self.processor.apply_saved_sync(&inbox).await?
                    };
                    let requests = self.processor.pending_crypto_requests().await?;
                    self.store
                        .record_sdk_processing(inbox.inbox_id().as_str(), &requests)
                        .map_err(|error| SafeError::new(error.code()))?;
                    let reached_position = self
                        .sdk_position
                        .as_ref()
                        .and_then(SdkInboxPosition::journaled_inbox_id)
                        .is_some_and(|position_id| position_id == inbox.inbox_id());
                    if !use_recovery || reached_position {
                        self.sdk_position = None;
                    }
                    return Ok(ServiceAction::ProcessedInbox);
                }
                SyncInboxState::SdkProcessed => {
                    if inbox.crypto_drained() {
                        return Ok(ServiceAction::Wait);
                    }
                    self.store
                        .mark_crypto_drained(inbox.inbox_id().as_str())
                        .map_err(|error| SafeError::new(error.code()))?;
                    return Ok(ServiceAction::MarkedCryptoDrained);
                }
                SyncInboxState::Prepared
                | SyncInboxState::Committed
                | SyncInboxState::Quarantined => return Ok(ServiceAction::Wait),
            }
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

    /// Run the Task 1 coordinator skeleton until shutdown or no action is due.
    /// Deadline waiting is added by the bounded runner task.
    pub async fn run(&mut self) -> Result<(), SafeError> {
        self.reconcile_startup().await?;
        loop {
            match self.tick().await? {
                ServiceAction::Shutdown | ServiceAction::Wait => return Ok(()),
                _ => {}
            }
        }
    }

    #[allow(dead_code)]
    fn _keep_sink_owned(&self) -> &I {
        &self.sink
    }
}

fn valid_millisecond(value: DateTime<Utc>) -> bool {
    value.timestamp_subsec_nanos().is_multiple_of(1_000_000)
}
