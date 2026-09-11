use std::{
    fs,
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
    time::Duration,
};

use async_trait::async_trait;
use chrono::{DateTime, TimeZone, Utc};
use communicator_matrix_gateway::{
    crypto::Keyring,
    crypto_outbox::{ExactMatrixRequest, RawMatrixResponse},
    ingestion::{BatchSink, Delivery, PendingBatch},
    ledger::NewLiveWindow,
    matrix::{
        CryptoAckProof, FetchedMatrixSync, LimitedTimelineGap, MATRIX_CRYPTO_ACK_UNRECOVERABLE,
        MatrixProcessor, MatrixTransport, ObservedMatrixEvent, ObservedRoomEvent, ProcessedSync,
        RestartCryptoAck,
    },
    secret::{SafeError, SecretBytes},
    service::{
        Clock, GatewayService, JitterSource, RetryPolicy, ServiceAction, Shutdown,
        calculate_retry_at,
    },
    store::Store,
    store_types::{NewBootstrapState, NewRawSyncInbox, RawSyncInbox, ReasonCode, SdkInboxPosition},
};
use rusqlite::{Connection, params};
use sha2::{Digest, Sha256};
use tempfile::{TempDir, tempdir};

const INITIAL_TOKEN: &[u8] = b"initial-token";
const NOW_MILLIS: i64 = 1_757_500_000_000;
const CRYPTO_ATTEMPT_COUNT_MAX: i64 = 1_000_000;

type CryptoAttempt = Arc<Mutex<Option<(u32, String)>>>;

fn timestamp(milliseconds: i64) -> DateTime<Utc> {
    Utc.timestamp_millis_opt(milliseconds)
        .single()
        .expect("valid test timestamp")
}

fn keyring() -> Keyring {
    Keyring::new([0x11; 32], 1).expect("valid test keyring")
}

struct StoreFixture {
    _directory: TempDir,
    path: PathBuf,
    store: Option<Store>,
}

fn store_fixture() -> StoreFixture {
    let directory = tempdir().expect("temporary directory");
    fs::set_permissions(directory.path(), fs::Permissions::from_mode(0o700))
        .expect("secure temporary directory");
    let path = directory.path().join("gateway.sqlite3");
    let mut store = Store::open(&path, keyring()).expect("open encrypted store");
    store
        .initialize_bootstrap_state(
            NewBootstrapState::new(
                b"encrypted-matrix-session".to_vec(),
                INITIAL_TOKEN.to_vec(),
                Vec::new(),
                timestamp(NOW_MILLIS - 1_000),
            )
            .expect("valid bootstrap state"),
        )
        .expect("persist bootstrap state");
    StoreFixture {
        _directory: directory,
        path,
        store: Some(store),
    }
}

fn fetched_sync(request_token: &[u8], next_token: &[u8], body: &[u8]) -> FetchedMatrixSync {
    FetchedMatrixSync::from_parts(
        SecretBytes::from_text(request_token, 64 * 1024).expect("request token"),
        SecretBytes::from_text(next_token, 64 * 1024).expect("next token"),
        SecretBytes::from_text(body, 64 * 1024).expect("response body"),
    )
    .expect("valid fetched response")
}

#[derive(Clone)]
struct ManualClock {
    now: Arc<Mutex<DateTime<Utc>>>,
}

impl ManualClock {
    fn new(now: DateTime<Utc>) -> Self {
        Self {
            now: Arc::new(Mutex::new(now)),
        }
    }
}

impl Clock for ManualClock {
    fn now(&self) -> DateTime<Utc> {
        *self.now.lock().expect("clock lock")
    }
}

struct DeterministicJitter {
    value: u64,
    requested_caps: Arc<Mutex<Vec<u64>>>,
}

impl DeterministicJitter {
    fn new(value: u64) -> (Self, Arc<Mutex<Vec<u64>>>) {
        let requested_caps = Arc::new(Mutex::new(Vec::new()));
        (
            Self {
                value,
                requested_caps: Arc::clone(&requested_caps),
            },
            requested_caps,
        )
    }
}

impl JitterSource for DeterministicJitter {
    fn sample_ms(&mut self, inclusive_max_ms: u64) -> u64 {
        self.requested_caps
            .lock()
            .expect("jitter lock")
            .push(inclusive_max_ms);
        self.value
    }
}

#[derive(Clone)]
struct FakeShutdown {
    requested: Arc<AtomicBool>,
}

impl FakeShutdown {
    fn new() -> Self {
        Self {
            requested: Arc::new(AtomicBool::new(false)),
        }
    }
}

impl Shutdown for FakeShutdown {
    fn requested(&self) -> bool {
        self.requested.load(Ordering::SeqCst)
    }
}

struct FakeMatrixTransport {
    next_fetch: Mutex<Option<FetchedMatrixSync>>,
    crypto_error: Option<&'static str>,
    fetch_calls: AtomicUsize,
    processor_path: Option<PathBuf>,
    observed_crypto_attempt: CryptoAttempt,
}

impl FakeMatrixTransport {
    fn with_fetch(response: FetchedMatrixSync) -> Self {
        Self {
            next_fetch: Mutex::new(Some(response)),
            crypto_error: None,
            fetch_calls: AtomicUsize::new(0),
            processor_path: None,
            observed_crypto_attempt: Arc::new(Mutex::new(None)),
        }
    }

    fn for_crypto(path: &Path, error: &'static str) -> (Self, CryptoAttempt) {
        let observed_crypto_attempt = Arc::new(Mutex::new(None));
        (
            Self {
                next_fetch: Mutex::new(None),
                crypto_error: Some(error),
                fetch_calls: AtomicUsize::new(0),
                processor_path: Some(path.to_owned()),
                observed_crypto_attempt: Arc::clone(&observed_crypto_attempt),
            },
            observed_crypto_attempt,
        )
    }
}

#[async_trait]
impl MatrixTransport for FakeMatrixTransport {
    async fn fetch_sync(&self, _since: &SecretBytes) -> Result<FetchedMatrixSync, SafeError> {
        self.fetch_calls.fetch_add(1, Ordering::SeqCst);
        self.next_fetch
            .lock()
            .expect("fetch lock")
            .take()
            .ok_or_else(|| SafeError::new("fake_fetch_exhausted"))
    }

    async fn send_crypto(
        &self,
        request: &communicator_matrix_gateway::crypto_outbox::PendingMatrixRequest,
    ) -> Result<RawMatrixResponse, SafeError> {
        if let Some(path) = &self.processor_path {
            let (attempt_count, next_attempt_at): (i64, String) = Connection::open(path)
                .expect("inspect store while transport is called")
                .query_row(
                    "SELECT attempt_count, next_attempt_at
                     FROM matrix_crypto_outbox WHERE crypto_row_id = ?1",
                    [request.row_id()],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .expect("leased crypto row");
            *self
                .observed_crypto_attempt
                .lock()
                .expect("crypto observation lock") = Some((
                u32::try_from(attempt_count).expect("validated attempt count"),
                next_attempt_at,
            ));
        }
        match self.crypto_error {
            Some(code) => Err(SafeError::new(code)),
            None => RawMatrixResponse::keys_query(br#"{}"#.to_vec()),
        }
    }
}

struct FakeProcessor {
    sdk_digest: Option<[u8; 32]>,
    processing_calls: Arc<AtomicUsize>,
    recovery_calls: Arc<AtomicUsize>,
    rebind_calls: Arc<AtomicUsize>,
    processing_saw_persisted_row: Option<Arc<AtomicBool>>,
    store_path: Option<PathBuf>,
    expected_body: Option<Vec<u8>>,
    pending_request: Mutex<Option<ExactMatrixRequest>>,
    rebind_unrecoverable: bool,
}

impl FakeProcessor {
    fn at_digest(digest: Option<[u8; 32]>) -> Self {
        Self {
            sdk_digest: digest,
            processing_calls: Arc::new(AtomicUsize::new(0)),
            recovery_calls: Arc::new(AtomicUsize::new(0)),
            rebind_calls: Arc::new(AtomicUsize::new(0)),
            processing_saw_persisted_row: None,
            store_path: None,
            expected_body: None,
            pending_request: Mutex::new(None),
            rebind_unrecoverable: false,
        }
    }

    fn with_unrecoverable_rebind(mut self) -> Self {
        self.rebind_unrecoverable = true;
        self
    }

    fn observing_store(path: &Path, body: &[u8]) -> (Self, Arc<AtomicUsize>, Arc<AtomicBool>) {
        let processing_calls = Arc::new(AtomicUsize::new(0));
        let processing_saw_persisted_row = Arc::new(AtomicBool::new(false));
        (
            Self {
                sdk_digest: Some(Sha256::digest(INITIAL_TOKEN).into()),
                processing_calls: Arc::clone(&processing_calls),
                recovery_calls: Arc::new(AtomicUsize::new(0)),
                rebind_calls: Arc::new(AtomicUsize::new(0)),
                processing_saw_persisted_row: Some(Arc::clone(&processing_saw_persisted_row)),
                store_path: Some(path.to_owned()),
                expected_body: Some(body.to_vec()),
                pending_request: Mutex::new(None),
                rebind_unrecoverable: false,
            },
            processing_calls,
            processing_saw_persisted_row,
        )
    }
}

#[async_trait]
impl MatrixProcessor for FakeProcessor {
    async fn sdk_token_digest(&self) -> Result<Option<[u8; 32]>, SafeError> {
        Ok(self.sdk_digest)
    }

    async fn apply_saved_sync(
        &mut self,
        response: &RawSyncInbox,
    ) -> Result<ProcessedSync, SafeError> {
        self.processing_calls.fetch_add(1, Ordering::SeqCst);
        if let (Some(saw_persisted_row), Some(expected_body)) =
            (&self.processing_saw_persisted_row, &self.expected_body)
        {
            let persisted_row_count: i64 =
                Connection::open(self.store_path.as_ref().expect("processor store path"))
                    .expect("inspect store before processor invocation")
                    .query_row("SELECT COUNT(*) FROM sync_inbox", [], |row| row.get(0))
                    .expect("count persisted inbox rows");
            if persisted_row_count == 1
                && response.response().as_bytes() == expected_body.as_slice()
            {
                saw_persisted_row.store(true, Ordering::SeqCst);
            }
        }
        Ok(ProcessedSync::new(Vec::new(), Vec::new()))
    }

    async fn recover_saved_sync(
        &mut self,
        _response: &RawSyncInbox,
    ) -> Result<ProcessedSync, SafeError> {
        self.recovery_calls.fetch_add(1, Ordering::SeqCst);
        Ok(ProcessedSync::new(Vec::new(), Vec::new()))
    }

    async fn pending_crypto_requests(&self) -> Result<Vec<ExactMatrixRequest>, SafeError> {
        Ok(self
            .pending_request
            .lock()
            .expect("request lock")
            .take()
            .into_iter()
            .collect())
    }

    async fn apply_crypto_response(
        &mut self,
        request: &communicator_matrix_gateway::crypto_outbox::PendingMatrixRequest,
        response: &RawMatrixResponse,
    ) -> Result<CryptoAckProof, SafeError> {
        Ok(CryptoAckProof::new(
            request.row_id().to_owned(),
            *response.sha256(),
        ))
    }

    async fn rebind_saved_crypto_response(
        &mut self,
        saved: &communicator_matrix_gateway::crypto_outbox::SavedMatrixResponse,
    ) -> Result<RestartCryptoAck, SafeError> {
        self.rebind_calls.fetch_add(1, Ordering::SeqCst);
        if self.rebind_unrecoverable {
            return Ok(RestartCryptoAck::Unrecoverable(
                ReasonCode::new(MATRIX_CRYPTO_ACK_UNRECOVERABLE)
                    .expect("valid unrecoverable reason"),
            ));
        }
        Ok(RestartCryptoAck::Rebound(CryptoAckProof::new(
            saved.row_id().to_owned(),
            *saved.response_sha256(),
        )))
    }
}

struct FakeIngestionSink;

#[async_trait]
impl BatchSink for FakeIngestionSink {
    async fn deliver(
        &self,
        _batch: &PendingBatch,
    ) -> Result<Delivery, communicator_matrix_gateway::ingestion::DeliveryError> {
        Ok(Delivery::Accepted)
    }
}

fn service_with(
    fixture: &mut StoreFixture,
    processor: FakeProcessor,
    transport: FakeMatrixTransport,
    jitter: DeterministicJitter,
    shutdown: FakeShutdown,
) -> GatewayService<
    FakeMatrixTransport,
    FakeProcessor,
    FakeIngestionSink,
    ManualClock,
    DeterministicJitter,
    FakeShutdown,
> {
    GatewayService::new(
        fixture.store.take().expect("fixture store is available"),
        processor,
        transport,
        FakeIngestionSink,
        ManualClock::new(timestamp(NOW_MILLIS)),
        jitter,
        shutdown,
        RetryPolicy::new(Duration::from_millis(100), Duration::from_secs(5), 10)
            .expect("valid retry policy"),
    )
    .expect("valid service")
}

fn append_test_inbox(fixture: &mut StoreFixture, observed_at: DateTime<Utc>) -> String {
    append_inbox(
        fixture,
        INITIAL_TOKEN,
        b"next-token",
        br#"{"next_batch":"next-token"}"#,
        observed_at,
    )
}

fn append_inbox(
    fixture: &mut StoreFixture,
    request_token: &[u8],
    next_token: &[u8],
    response: &[u8],
    observed_at: DateTime<Utc>,
) -> String {
    fixture
        .store
        .as_mut()
        .expect("fixture store")
        .append_fetched_sync(
            NewRawSyncInbox::new(
                request_token.to_vec(),
                next_token.to_vec(),
                response.to_vec(),
                observed_at,
            )
            .expect("valid raw sync"),
        )
        .expect("append raw sync")
        .as_str()
        .to_owned()
}

fn expected_window_id(inbox_id: &str) -> String {
    let digest = keyring()
        .lookup_digest("matrix-live-window-v1", &[inbox_id])
        .expect("derive test window ID");
    format!(
        "window_{}",
        digest
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>()
    )
}

fn append_and_commit_empty_inbox(
    fixture: &mut StoreFixture,
    request_token: &[u8],
    next_token: &[u8],
    observed_at: DateTime<Utc>,
    committed_at: DateTime<Utc>,
) -> String {
    let store = fixture.store.as_mut().expect("fixture store");
    let inbox_id = store
        .append_fetched_sync(
            NewRawSyncInbox::new(
                request_token.to_vec(),
                next_token.to_vec(),
                format!(
                    r#"{{"next_batch":"{}"}}"#,
                    String::from_utf8_lossy(next_token)
                )
                .into_bytes(),
                observed_at,
            )
            .expect("valid committed raw sync"),
        )
        .expect("append committed raw sync")
        .as_str()
        .to_owned();
    store
        .record_sdk_processing(&inbox_id, &[])
        .expect("record empty SDK processing");
    store
        .mark_crypto_drained(&inbox_id)
        .expect("drain empty crypto set");
    let window_id = expected_window_id(&inbox_id);
    store
        .create_collecting_live_window(
            &inbox_id,
            NewLiveWindow::new(window_id.clone(), observed_at, 0)
                .expect("valid empty collecting window"),
        )
        .expect("create empty collecting window");
    store
        .commit_empty_live_window(&inbox_id, &window_id, &[], &[], committed_at)
        .expect("commit empty window");
    inbox_id
}

fn reorder_sync_inbox_rowids(path: &Path, first_id: &str, second_id: &str, third_id: &str) {
    let connection = Connection::open(path).expect("open row-order fixture");
    let transaction = connection
        .unchecked_transaction()
        .expect("start row-order transaction");
    transaction
        .execute("UPDATE sync_inbox SET rowid = rowid + 1000", [])
        .expect("move rows to temporary rowids");
    for (rowid, inbox_id) in [(1_i64, third_id), (2_i64, first_id), (3_i64, second_id)] {
        transaction
            .execute(
                "UPDATE sync_inbox SET rowid = ?1 WHERE inbox_id = ?2",
                params![rowid, inbox_id],
            )
            .expect("assign reordered rowid");
    }
    transaction.commit().expect("commit row-order fixture");
}

fn append_response_received_crypto(fixture: &mut StoreFixture) -> String {
    let observed_at = timestamp(NOW_MILLIS - 1_000);
    let inbox_id = append_test_inbox(fixture, observed_at);
    let request = ExactMatrixRequest::keys_query(
        b"saved-response-request".to_vec(),
        br#"{"device_keys":{}}"#.to_vec(),
    )
    .expect("valid exact keys query request");
    let store = fixture.store.as_mut().expect("fixture store");
    store
        .record_sdk_processing(&inbox_id, &[request])
        .expect("persist crypto request");
    let pending = store
        .next_pending_crypto_request(observed_at)
        .expect("select crypto request")
        .expect("pending crypto request");
    let row_id = pending.row_id().to_owned();
    store
        .record_attempt(&row_id, 0, observed_at, observed_at, timestamp(NOW_MILLIS))
        .expect("lease crypto request");
    store
        .record_crypto_response(
            &row_id,
            &RawMatrixResponse::keys_query(br#"{"saved":true}"#.to_vec())
                .expect("valid saved response"),
        )
        .expect("persist crypto response");
    row_id
}

#[tokio::test]
async fn one_tick_exposes_only_one_service_action() {
    let mut fixture = store_fixture();
    let fetched = fetched_sync(
        INITIAL_TOKEN,
        b"next-token",
        br#"{"next_batch":"next-token"}"#,
    );
    let transport = FakeMatrixTransport::with_fetch(fetched);
    let processor = FakeProcessor::at_digest(Some(Sha256::digest(INITIAL_TOKEN).into()));
    let shutdown = FakeShutdown::new();
    let (jitter, _) = DeterministicJitter::new(0);
    let mut service = service_with(&mut fixture, processor, transport, jitter, shutdown);

    service
        .reconcile_startup()
        .await
        .expect("startup reconcile");
    assert_eq!(
        service.tick().await.expect("one tick"),
        ServiceAction::FetchedSync
    );
}

#[tokio::test]
async fn startup_accepts_committed_and_contiguous_inbox_sdk_positions() {
    let mut committed_fixture = store_fixture();
    let (jitter, _) = DeterministicJitter::new(0);
    let mut committed_service = service_with(
        &mut committed_fixture,
        FakeProcessor::at_digest(Some(Sha256::digest(INITIAL_TOKEN).into())),
        FakeMatrixTransport::with_fetch(fetched_sync(
            INITIAL_TOKEN,
            b"next-token",
            br#"{"next_batch":"next-token"}"#,
        )),
        jitter,
        FakeShutdown::new(),
    );
    committed_service
        .reconcile_startup()
        .await
        .expect("committed SDK token is accepted");

    let mut contiguous_fixture = store_fixture();
    contiguous_fixture
        .store
        .as_mut()
        .expect("fixture store")
        .append_fetched_sync(
            communicator_matrix_gateway::store_types::NewRawSyncInbox::new(
                INITIAL_TOKEN.to_vec(),
                b"next-token".to_vec(),
                br#"{"next_batch":"next-token"}"#.to_vec(),
                timestamp(NOW_MILLIS),
            )
            .expect("valid raw sync"),
        )
        .expect("append contiguous raw sync");
    let (jitter, _) = DeterministicJitter::new(0);
    let mut contiguous_service = service_with(
        &mut contiguous_fixture,
        FakeProcessor::at_digest(Some(Sha256::digest(b"next-token").into())),
        FakeMatrixTransport::with_fetch(fetched_sync(
            INITIAL_TOKEN,
            b"later-token",
            br#"{"next_batch":"later-token"}"#,
        )),
        jitter,
        FakeShutdown::new(),
    );
    contiguous_service
        .reconcile_startup()
        .await
        .expect("contiguous journaled SDK token is accepted");
}

#[tokio::test]
async fn startup_rejects_an_unknown_sdk_position() {
    let mut fixture = store_fixture();
    let (jitter, _) = DeterministicJitter::new(0);
    let mut service = service_with(
        &mut fixture,
        FakeProcessor::at_digest(Some(Sha256::digest(b"unknown-sdk-token").into())),
        FakeMatrixTransport::with_fetch(fetched_sync(
            INITIAL_TOKEN,
            b"next-token",
            br#"{"next_batch":"next-token"}"#,
        )),
        jitter,
        FakeShutdown::new(),
    );

    let error = service
        .reconcile_startup()
        .await
        .expect_err("unknown SDK position must fail closed");
    assert_eq!(error.code(), "matrix_sdk_position_unjournaled");
}

#[tokio::test]
async fn fetched_bytes_are_appended_before_processor_invocation() {
    let mut fixture = store_fixture();
    let body = br#"{"next_batch":"next-token"}"#;
    let (processor, processing_calls, saw_persisted_row) =
        FakeProcessor::observing_store(&fixture.path, body);
    let (jitter, _) = DeterministicJitter::new(0);
    let mut service = service_with(
        &mut fixture,
        processor,
        FakeMatrixTransport::with_fetch(fetched_sync(INITIAL_TOKEN, b"next-token", body)),
        jitter,
        FakeShutdown::new(),
    );
    service
        .reconcile_startup()
        .await
        .expect("startup reconcile");

    assert_eq!(
        service.tick().await.expect("fetch tick"),
        ServiceAction::FetchedSync
    );
    assert_eq!(processing_calls.load(Ordering::SeqCst), 0);
    assert_eq!(
        service.tick().await.expect("processing tick"),
        ServiceAction::ProcessedInbox
    );
    assert_eq!(processing_calls.load(Ordering::SeqCst), 1);
    assert!(saw_persisted_row.load(Ordering::SeqCst));
}

#[tokio::test]
async fn retry_timestamp_is_deterministic_and_persisted_before_send() {
    let mut fixture = store_fixture();
    let inbox_id = fixture
        .store
        .as_mut()
        .expect("fixture store")
        .append_fetched_sync(
            communicator_matrix_gateway::store_types::NewRawSyncInbox::new(
                INITIAL_TOKEN.to_vec(),
                b"next-token".to_vec(),
                br#"{"next_batch":"next-token"}"#.to_vec(),
                timestamp(NOW_MILLIS - 1_000),
            )
            .expect("valid raw sync"),
        )
        .expect("append raw sync")
        .as_str()
        .to_owned();
    let request = ExactMatrixRequest::keys_query(
        b"sdk-request-id".to_vec(),
        br#"{"device_keys":{},"timeout":null}"#.to_vec(),
    )
    .expect("valid exact keys query request");
    fixture
        .store
        .as_mut()
        .expect("fixture store")
        .record_sdk_processing(&inbox_id, &[request])
        .expect("persist crypto request");
    let (transport, observed_attempt) =
        FakeMatrixTransport::for_crypto(&fixture.path, "matrix_transport_failed");
    let (jitter, requested_caps) = DeterministicJitter::new(37);
    let mut service = service_with(
        &mut fixture,
        FakeProcessor::at_digest(Some(Sha256::digest(INITIAL_TOKEN).into())),
        transport,
        jitter,
        FakeShutdown::new(),
    );
    service
        .reconcile_startup()
        .await
        .expect("startup reconcile");

    assert_eq!(
        service
            .tick()
            .await
            .expect("retry action is durably recorded"),
        ServiceAction::AttemptedCryptoDelivery
    );
    assert_eq!(
        requested_caps.lock().expect("jitter caps").as_slice(),
        &[100]
    );
    assert_eq!(
        observed_attempt
            .lock()
            .expect("attempt observation")
            .as_ref()
            .expect("send sees leased row")
            .0,
        1
    );
    assert_eq!(
        observed_attempt
            .lock()
            .expect("attempt observation")
            .as_ref()
            .expect("send sees leased row")
            .1,
        timestamp(NOW_MILLIS + 37).to_rfc3339()
    );
}

#[test]
fn high_attempt_retry_delay_saturates_at_max_delay() {
    let now = timestamp(NOW_MILLIS);
    let policy = RetryPolicy::new(Duration::from_millis(100), Duration::from_secs(5), 63)
        .expect("high exponent policy is valid");
    let (mut jitter, requested_caps) = DeterministicJitter::new(u64::MAX);

    let retry_at = calculate_retry_at(now, CRYPTO_ATTEMPT_COUNT_MAX as u32, &policy, &mut jitter)
        .expect("high attempt count must still produce a retry deadline");

    assert_eq!(
        requested_caps.lock().expect("jitter caps").as_slice(),
        &[5_000]
    );
    assert_eq!(retry_at, now + chrono::Duration::seconds(5));
    assert!(retry_at >= now && retry_at <= now + chrono::Duration::seconds(5));
}

#[test]
fn crypto_attempt_accounting_ceiling_schedules_an_exact_request_again() {
    let mut fixture = store_fixture();
    let observed_at = timestamp(NOW_MILLIS - 4_000);
    let inbox_id = append_test_inbox(&mut fixture, observed_at);
    let request_bytes = br#"{"device_keys":{}}"#;
    let request =
        ExactMatrixRequest::keys_query(b"retry-ceiling-request".to_vec(), request_bytes.to_vec())
            .expect("valid exact keys query request");
    let store = fixture.store.as_mut().expect("fixture store");
    store
        .record_sdk_processing(&inbox_id, &[request])
        .expect("persist crypto request");
    let row_id = store
        .next_pending_crypto_request(timestamp(NOW_MILLIS))
        .expect("select crypto request")
        .expect("pending crypto request")
        .row_id()
        .to_owned();
    let first_deadline = timestamp(NOW_MILLIS);
    let retry_deadline = timestamp(NOW_MILLIS + 1_000);
    let connection = Connection::open(&fixture.path).expect("open state inspector");
    let updated = connection
        .execute(
            "UPDATE matrix_crypto_outbox
             SET attempt_count = ?1, next_attempt_at = ?2
             WHERE crypto_row_id = ?3",
            params![
                CRYPTO_ATTEMPT_COUNT_MAX,
                first_deadline.to_rfc3339(),
                &row_id,
            ],
        )
        .expect("set exact attempt ceiling");
    assert_eq!(updated, 1);

    let pending = store
        .next_pending_crypto_request(first_deadline)
        .expect("select request at exact ceiling")
        .expect("request at exact ceiling remains pending");
    assert_eq!(pending.attempt_count(), CRYPTO_ATTEMPT_COUNT_MAX as u32);
    assert_eq!(pending.request().as_bytes(), request_bytes);

    store
        .record_attempt(
            &row_id,
            CRYPTO_ATTEMPT_COUNT_MAX as u32,
            first_deadline,
            first_deadline,
            retry_deadline,
        )
        .expect("schedule retry at exact attempt ceiling");

    let retry = store
        .next_pending_crypto_request(retry_deadline)
        .expect("select retry after its new deadline")
        .expect("retry remains eligible after saturation");
    assert_eq!(retry.attempt_count(), CRYPTO_ATTEMPT_COUNT_MAX as u32);
    assert_eq!(retry.request().as_bytes(), request_bytes);
    let (state, attempt_count, next_attempt_at, terminal_code): (
        String,
        i64,
        String,
        Option<String>,
    ) = connection
        .query_row(
            "SELECT state, attempt_count, next_attempt_at, terminal_code
                 FROM matrix_crypto_outbox WHERE crypto_row_id = ?1",
            [&row_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .expect("read saturated retry row");
    assert_eq!(state, "pending");
    assert_eq!(attempt_count, CRYPTO_ATTEMPT_COUNT_MAX);
    assert_eq!(next_attempt_at, retry_deadline.to_rfc3339());
    assert_eq!(terminal_code, None);

    connection
        .execute(
            "UPDATE matrix_crypto_outbox SET attempt_count = ?1 WHERE crypto_row_id = ?2",
            params![CRYPTO_ATTEMPT_COUNT_MAX + 1, &row_id],
        )
        .expect("set attempt count above validation ceiling");
    let error = store
        .next_pending_crypto_request(retry_deadline)
        .expect_err("attempt count above ceiling must fail closed");
    assert_eq!(error.code(), "store_crypto_corrupt");
}

#[tokio::test]
async fn reconcile_rejects_stale_committed_prefix_and_service_never_recovers_from_it() {
    let mut fixture = store_fixture();
    let _first_id = append_and_commit_empty_inbox(
        &mut fixture,
        INITIAL_TOKEN,
        b"committed-token-1",
        timestamp(NOW_MILLIS),
        timestamp(NOW_MILLIS + 1_000),
    );
    let _second_id = append_and_commit_empty_inbox(
        &mut fixture,
        b"committed-token-1",
        b"committed-token-2",
        timestamp(NOW_MILLIS + 2_000),
        timestamp(NOW_MILLIS + 3_000),
    );
    let later_id = append_inbox(
        &mut fixture,
        b"committed-token-2",
        b"uncommitted-token-3",
        br#"{"next_batch":"uncommitted-token-3"}"#,
        timestamp(NOW_MILLIS + 4_000),
    );
    let store = fixture.store.as_mut().expect("fixture store");

    let stale_error = store
        .reconcile_sdk_position(&Sha256::digest(b"committed-token-1"))
        .expect_err("older committed-prefix position must fail closed");
    assert_eq!(stale_error.code(), "matrix_sdk_position_unjournaled");
    assert_eq!(
        store
            .reconcile_sdk_position(&Sha256::digest(b"committed-token-2"))
            .expect("current committed position is accepted"),
        SdkInboxPosition::Committed
    );
    let uncommitted_position = store
        .reconcile_sdk_position(&Sha256::digest(b"uncommitted-token-3"))
        .expect("uncommitted frontier is accepted");
    assert_eq!(
        uncommitted_position
            .journaled_inbox_id()
            .map(|id| id.as_str()),
        Some(later_id.as_str())
    );

    let processor = FakeProcessor::at_digest(Some(Sha256::digest(b"committed-token-1").into()));
    let recovery_calls = Arc::clone(&processor.recovery_calls);
    let (jitter, _) = DeterministicJitter::new(0);
    let mut service = service_with(
        &mut fixture,
        processor,
        FakeMatrixTransport::with_fetch(fetched_sync(
            b"committed-token-2",
            b"later-token",
            br#"{"next_batch":"later-token"}"#,
        )),
        jitter,
        FakeShutdown::new(),
    );
    let error = service
        .reconcile_startup()
        .await
        .expect_err("service must reject stale committed-prefix position");
    assert_eq!(error.code(), "matrix_sdk_position_unjournaled");
    assert_eq!(recovery_calls.load(Ordering::SeqCst), 0);
}

#[test]
fn reconcile_sdk_position_uses_authenticated_chain_order_after_rowid_reordering() {
    let mut fixture = store_fixture();
    let first_id = append_and_commit_empty_inbox(
        &mut fixture,
        INITIAL_TOKEN,
        b"committed-token-1",
        timestamp(NOW_MILLIS),
        timestamp(NOW_MILLIS + 1_000),
    );
    let second_id = append_and_commit_empty_inbox(
        &mut fixture,
        b"committed-token-1",
        b"committed-token-2",
        timestamp(NOW_MILLIS + 2_000),
        timestamp(NOW_MILLIS + 3_000),
    );
    let third_id = append_inbox(
        &mut fixture,
        b"committed-token-2",
        b"uncommitted-token-3",
        br#"{"next_batch":"uncommitted-token-3"}"#,
        timestamp(NOW_MILLIS + 4_000),
    );
    reorder_sync_inbox_rowids(&fixture.path, &first_id, &second_id, &third_id);

    let store = fixture.store.as_mut().expect("fixture store");
    assert_eq!(
        store
            .reconcile_sdk_position(&Sha256::digest(b"committed-token-2"))
            .expect("current committed position is accepted"),
        SdkInboxPosition::Committed
    );
    assert_eq!(
        store
            .reconcile_sdk_position(&Sha256::digest(b"committed-token-1"))
            .expect_err("older committed-prefix position must be rejected")
            .code(),
        "matrix_sdk_position_unjournaled"
    );
    assert_eq!(
        store
            .reconcile_sdk_position(&Sha256::digest(b"uncommitted-token-3"))
            .expect("valid uncommitted position is accepted")
            .journaled_inbox_id()
            .map(|id| id.as_str()),
        Some(third_id.as_str())
    );
}

#[tokio::test]
async fn journaled_sdk_position_uses_saved_sync_recovery_for_the_head() {
    let mut fixture = store_fixture();
    append_test_inbox(&mut fixture, timestamp(NOW_MILLIS));
    let processor = FakeProcessor::at_digest(Some(Sha256::digest(b"next-token").into()));
    let apply_calls = Arc::clone(&processor.processing_calls);
    let recovery_calls = Arc::clone(&processor.recovery_calls);
    let (jitter, _) = DeterministicJitter::new(0);
    let mut service = service_with(
        &mut fixture,
        processor,
        FakeMatrixTransport::with_fetch(fetched_sync(
            INITIAL_TOKEN,
            b"later-token",
            br#"{"next_batch":"later-token"}"#,
        )),
        jitter,
        FakeShutdown::new(),
    );
    service
        .reconcile_startup()
        .await
        .expect("startup reconcile");

    assert_eq!(
        service.tick().await.expect("recover saved head"),
        ServiceAction::ProcessedInbox
    );
    assert_eq!(apply_calls.load(Ordering::SeqCst), 0);
    assert_eq!(recovery_calls.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn unrecoverable_saved_crypto_response_is_quarantined_and_pauses_service() {
    let mut fixture = store_fixture();
    let row_id = append_response_received_crypto(&mut fixture);
    let processor = FakeProcessor::at_digest(Some(Sha256::digest(INITIAL_TOKEN).into()))
        .with_unrecoverable_rebind();
    let rebind_calls = Arc::clone(&processor.rebind_calls);
    let (transport, crypto_attempt) =
        FakeMatrixTransport::for_crypto(&fixture.path, "matrix_transport_failed");
    let (jitter, _) = DeterministicJitter::new(0);
    let mut service = service_with(
        &mut fixture,
        processor,
        transport,
        jitter,
        FakeShutdown::new(),
    );
    service
        .reconcile_startup()
        .await
        .expect("startup reconcile");

    let error = service
        .tick()
        .await
        .expect_err("unrecoverable response must pause service");
    assert_eq!(error.code(), "service_maintenance_required");
    assert_eq!(error.to_string(), "service_maintenance_required");
    assert!(!error.to_string().contains(&row_id));
    assert_eq!(rebind_calls.load(Ordering::SeqCst), 1);
    assert!(
        crypto_attempt
            .lock()
            .expect("crypto attempt lock")
            .is_none()
    );

    let connection = Connection::open(&fixture.path).expect("open state inspector");
    let (state, terminal_code): (String, String) = connection
        .query_row(
            "SELECT state, terminal_code
             FROM matrix_crypto_outbox WHERE crypto_row_id = ?1",
            [row_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .expect("read quarantined crypto row");
    assert_eq!(state, "quarantined");
    assert_eq!(terminal_code, MATRIX_CRYPTO_ACK_UNRECOVERABLE);
    let maintenance_code: String = connection
        .query_row(
            "SELECT maintenance_code FROM gateway_state WHERE singleton = 1",
            [],
            |row| row.get(0),
        )
        .expect("read maintenance marker");
    assert_eq!(maintenance_code, MATRIX_CRYPTO_ACK_UNRECOVERABLE);
}

#[tokio::test]
async fn future_crypto_retry_returns_wait_without_marking_drained() {
    let mut fixture = store_fixture();
    let inbox_id = append_test_inbox(&mut fixture, timestamp(NOW_MILLIS + 1_000));
    let request = ExactMatrixRequest::keys_query(
        b"future-retry-request".to_vec(),
        br#"{"device_keys":{}}"#.to_vec(),
    )
    .expect("valid exact keys query request");
    fixture
        .store
        .as_mut()
        .expect("fixture store")
        .record_sdk_processing(&inbox_id, &[request])
        .expect("persist future crypto request");
    let (jitter, _) = DeterministicJitter::new(0);
    let mut service = service_with(
        &mut fixture,
        FakeProcessor::at_digest(Some(Sha256::digest(INITIAL_TOKEN).into())),
        FakeMatrixTransport::with_fetch(fetched_sync(
            INITIAL_TOKEN,
            b"later-token",
            br#"{"next_batch":"later-token"}"#,
        )),
        jitter,
        FakeShutdown::new(),
    );
    service
        .reconcile_startup()
        .await
        .expect("startup reconcile");

    assert_eq!(
        service.tick().await.expect("future work waits"),
        ServiceAction::Wait
    );
    let crypto_drained: i64 = Connection::open(&fixture.path)
        .expect("open state inspector")
        .query_row(
            "SELECT crypto_drained FROM sync_inbox WHERE inbox_id = ?1",
            [inbox_id],
            |row| row.get(0),
        )
        .expect("read inbox state");
    assert_eq!(crypto_drained, 0);
}

#[test]
fn all_public_and_debug_output_remains_content_free() {
    let canaries = [
        "request-token-canary",
        "next-token-canary",
        "event-json-canary",
        "proof-row-canary",
    ];
    let fetched = fetched_sync(
        canaries[0].as_bytes(),
        canaries[1].as_bytes(),
        canaries[2].as_bytes(),
    );
    let room_event = ObservedRoomEvent::new(
        SecretBytes::from_text(b"room-id-canary", 64 * 1024).expect("room ID"),
        SecretBytes::from_text(b"event-json-canary", 64 * 1024).expect("event JSON"),
        true,
    )
    .expect("room event");
    let observed = ObservedMatrixEvent::Timeline(room_event);
    let gap = LimitedTimelineGap::new(
        SecretBytes::from_text(b"gap-room-canary", 64 * 1024).expect("gap room"),
        SecretBytes::from_text(b"gap-token-canary", 64 * 1024).expect("gap token"),
    )
    .expect("timeline gap");
    let processed = ProcessedSync::new(vec![observed], vec![gap]);
    let proof = CryptoAckProof::new("proof-row-canary".to_owned(), [0xA5; 32]);
    let values = [
        format!("{fetched:?}"),
        fetched.to_string(),
        format!("{processed:?}"),
        processed.to_string(),
        format!("{proof:?}"),
        proof.to_string(),
        format!("{:?}", ServiceAction::FetchedSync),
    ];
    for value in values {
        for canary in canaries {
            assert!(!value.contains(canary), "leaked canary in {value}");
        }
    }
}
