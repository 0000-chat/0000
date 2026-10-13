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
    batch::{RoutedEvent, WindowSource, build_window},
    config::GatewayConfig,
    credentials::load_ingestion_service_credential,
    crypto::Keyring,
    crypto_outbox::{ExactMatrixRequest, RawMatrixResponse},
    ingestion::{BatchSink, Delivery, IngestionClient, PendingBatch},
    ledger::NewLiveWindow,
    matrix::{
        CryptoAckProof, FetchedMatrixSync, LimitedTimelineGap, MATRIX_CRYPTO_ACK_UNRECOVERABLE,
        MatrixProcessor, MatrixTransport, ObservedMatrixEvent, ObservedRoomEvent, ProcessedSync,
        RestartCryptoAck,
    },
    model::{
        CanonicalEvent, CanonicalEventSource, CanonicalPayload, DeliveryStatus, Direction,
        MessageCreatedPayload, Provider,
    },
    registry::NewRoomBinding,
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
use tokio::sync::Notify;
use wiremock::{Mock, MockServer, Request, Respond, ResponseTemplate, matchers};

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

fn response_sequence(responses: Vec<ResponseTemplate>) -> impl Respond {
    let responses = Arc::new(responses);
    let next = Arc::new(AtomicUsize::new(0));
    move |_request: &Request| {
        let index = next.fetch_add(1, Ordering::SeqCst);
        responses[index.min(responses.len() - 1)].clone()
    }
}

fn response_for_batch(tenant_id: &str, batch_id: &str) -> ResponseTemplate {
    ResponseTemplate::new(202).set_body_raw(
        format!(
            "{{\"schema_version\":1,\"tenant_id\":\"{tenant_id}\",\"batch_id\":\"{batch_id}\",\"status\":\"accepted\",\"archive_status\":\"created\"}}"
        ),
        "application/json",
    )
}

fn request_header(request: &Request, name: &str) -> String {
    request
        .headers
        .get(name)
        .unwrap_or_else(|| panic!("missing request header {name}"))
        .to_str()
        .expect("header is valid UTF-8")
        .to_owned()
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
    notification: Arc<Notify>,
    requested_checks: Arc<Notify>,
}

impl FakeShutdown {
    fn new() -> Self {
        Self {
            requested: Arc::new(AtomicBool::new(false)),
            notification: Arc::new(Notify::new()),
            requested_checks: Arc::new(Notify::new()),
        }
    }

    fn request(&self) {
        self.requested.store(true, Ordering::SeqCst);
        self.notification.notify_one();
    }

    fn requested_check_notification(&self) -> Arc<Notify> {
        Arc::clone(&self.requested_checks)
    }
}

#[async_trait]
impl Shutdown for FakeShutdown {
    fn requested(&self) -> bool {
        self.requested_checks.notify_one();
        self.requested.load(Ordering::SeqCst)
    }

    async fn wait_requested(&self) {
        loop {
            let notified = self.notification.notified();
            if self.requested.load(Ordering::SeqCst) {
                return;
            }
            notified.await;
        }
    }
}

struct FakeMatrixTransport {
    next_fetch: Mutex<Option<FetchedMatrixSync>>,
    crypto_error: Option<&'static str>,
    fetch_calls: Arc<AtomicUsize>,
    fetch_started: Option<Arc<Notify>>,
    fetch_release: Option<Arc<Notify>>,
    processor_path: Option<PathBuf>,
    observed_crypto_attempt: CryptoAttempt,
}

impl FakeMatrixTransport {
    fn with_fetch(response: FetchedMatrixSync) -> Self {
        Self {
            next_fetch: Mutex::new(Some(response)),
            crypto_error: None,
            fetch_calls: Arc::new(AtomicUsize::new(0)),
            fetch_started: None,
            fetch_release: None,
            processor_path: None,
            observed_crypto_attempt: Arc::new(Mutex::new(None)),
        }
    }

    fn with_blocked_fetch(response: FetchedMatrixSync) -> (Self, Arc<Notify>, Arc<Notify>) {
        let fetch_started = Arc::new(Notify::new());
        let fetch_release = Arc::new(Notify::new());
        (
            Self {
                next_fetch: Mutex::new(Some(response)),
                crypto_error: None,
                fetch_calls: Arc::new(AtomicUsize::new(0)),
                fetch_started: Some(Arc::clone(&fetch_started)),
                fetch_release: Some(Arc::clone(&fetch_release)),
                processor_path: None,
                observed_crypto_attempt: Arc::new(Mutex::new(None)),
            },
            fetch_started,
            fetch_release,
        )
    }

    fn fetch_counter(&self) -> Arc<AtomicUsize> {
        Arc::clone(&self.fetch_calls)
    }

    fn for_crypto(path: &Path, error: &'static str) -> (Self, CryptoAttempt) {
        let observed_crypto_attempt = Arc::new(Mutex::new(None));
        (
            Self {
                next_fetch: Mutex::new(None),
                crypto_error: Some(error),
                fetch_calls: Arc::new(AtomicUsize::new(0)),
                fetch_started: None,
                fetch_release: None,
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
        if let Some(fetch_release) = &self.fetch_release {
            self.fetch_started
                .as_ref()
                .expect("blocked fetch start notification")
                .notify_one();
            fetch_release.notified().await;
        }
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
    later_sdk_digest: Option<[u8; 32]>,
    later_sdk_digest_after: usize,
    sdk_digest_calls: AtomicUsize,
    processing_calls: Arc<AtomicUsize>,
    recovery_calls: Arc<AtomicUsize>,
    rebind_calls: Arc<AtomicUsize>,
    processing_saw_persisted_row: Option<Arc<AtomicBool>>,
    store_path: Option<PathBuf>,
    expected_body: Option<Vec<u8>>,
    pending_request: Mutex<Option<ExactMatrixRequest>>,
    pending_error: Option<&'static str>,
    rebind_unrecoverable: bool,
    processed_sync: Mutex<Option<ProcessedSync>>,
    recovered_sync: Mutex<Option<ProcessedSync>>,
    recovered_sync_factory: Option<fn() -> ProcessedSync>,
}

impl FakeProcessor {
    fn at_digest(digest: Option<[u8; 32]>) -> Self {
        Self {
            sdk_digest: digest,
            later_sdk_digest: None,
            later_sdk_digest_after: usize::MAX,
            sdk_digest_calls: AtomicUsize::new(0),
            processing_calls: Arc::new(AtomicUsize::new(0)),
            recovery_calls: Arc::new(AtomicUsize::new(0)),
            rebind_calls: Arc::new(AtomicUsize::new(0)),
            processing_saw_persisted_row: None,
            store_path: None,
            expected_body: None,
            pending_request: Mutex::new(None),
            pending_error: None,
            rebind_unrecoverable: false,
            processed_sync: Mutex::new(None),
            recovered_sync: Mutex::new(None),
            recovered_sync_factory: None,
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
                later_sdk_digest: None,
                later_sdk_digest_after: usize::MAX,
                sdk_digest_calls: AtomicUsize::new(0),
                processing_calls: Arc::clone(&processing_calls),
                recovery_calls: Arc::new(AtomicUsize::new(0)),
                rebind_calls: Arc::new(AtomicUsize::new(0)),
                processing_saw_persisted_row: Some(Arc::clone(&processing_saw_persisted_row)),
                store_path: Some(path.to_owned()),
                expected_body: Some(body.to_vec()),
                pending_request: Mutex::new(None),
                pending_error: None,
                rebind_unrecoverable: false,
                processed_sync: Mutex::new(None),
                recovered_sync: Mutex::new(None),
                recovered_sync_factory: None,
            },
            processing_calls,
            processing_saw_persisted_row,
        )
    }

    fn with_processed_sync(self, processed: ProcessedSync) -> Self {
        *self.processed_sync.lock().expect("processed sync lock") = Some(processed);
        self
    }

    fn with_recovered_sync(self, processed: ProcessedSync) -> Self {
        *self.recovered_sync.lock().expect("recovered sync lock") = Some(processed);
        self
    }

    fn with_recovered_sync_factory(mut self, factory: fn() -> ProcessedSync) -> Self {
        self.recovered_sync_factory = Some(factory);
        self
    }

    fn with_later_sdk_digest(mut self, digest: Option<[u8; 32]>) -> Self {
        self.later_sdk_digest = digest;
        self.later_sdk_digest_after = 2;
        self
    }

    fn with_pending_error(mut self, code: &'static str) -> Self {
        self.pending_error = Some(code);
        self
    }
}

#[async_trait]
impl MatrixProcessor for FakeProcessor {
    async fn sdk_token_digest(&self) -> Result<Option<[u8; 32]>, SafeError> {
        let call = self.sdk_digest_calls.fetch_add(1, Ordering::SeqCst);
        Ok(if call >= self.later_sdk_digest_after {
            self.later_sdk_digest.or(self.sdk_digest)
        } else {
            self.sdk_digest
        })
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
        Ok(self
            .processed_sync
            .lock()
            .expect("processed sync lock")
            .take()
            .unwrap_or_else(|| ProcessedSync::new(Vec::new(), Vec::new())))
    }

    async fn recover_saved_sync(
        &mut self,
        _response: &RawSyncInbox,
    ) -> Result<ProcessedSync, SafeError> {
        self.recovery_calls.fetch_add(1, Ordering::SeqCst);
        if let Some(factory) = self.recovered_sync_factory {
            return Ok(factory());
        }
        Ok(self
            .recovered_sync
            .lock()
            .expect("recovered sync lock")
            .take()
            .unwrap_or_else(|| ProcessedSync::new(Vec::new(), Vec::new())))
    }

    async fn pending_crypto_requests(&self) -> Result<Vec<ExactMatrixRequest>, SafeError> {
        if let Some(code) = self.pending_error {
            return Err(SafeError::new(code));
        }
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
    service_with_sink(
        fixture.store.take().expect("fixture store is available"),
        processor,
        transport,
        jitter,
        shutdown,
        FakeIngestionSink,
    )
}

fn service_with_sink<I: BatchSink>(
    store: Store,
    processor: FakeProcessor,
    transport: FakeMatrixTransport,
    jitter: DeterministicJitter,
    shutdown: FakeShutdown,
    sink: I,
) -> GatewayService<
    FakeMatrixTransport,
    FakeProcessor,
    I,
    ManualClock,
    DeterministicJitter,
    FakeShutdown,
> {
    service_with_sink_at(
        store,
        processor,
        transport,
        jitter,
        shutdown,
        sink,
        timestamp(NOW_MILLIS),
    )
}

fn service_with_sink_at<I: BatchSink>(
    store: Store,
    processor: FakeProcessor,
    transport: FakeMatrixTransport,
    jitter: DeterministicJitter,
    shutdown: FakeShutdown,
    sink: I,
    now: DateTime<Utc>,
) -> GatewayService<
    FakeMatrixTransport,
    FakeProcessor,
    I,
    ManualClock,
    DeterministicJitter,
    FakeShutdown,
> {
    GatewayService::new(
        store,
        processor,
        transport,
        sink,
        ManualClock::new(now),
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

fn append_pending_live_batch(fixture: &mut StoreFixture) -> (String, String, Vec<u8>) {
    let inbox_id = append_test_inbox(fixture, timestamp(NOW_MILLIS - 1_000));
    let store = fixture.store.as_mut().expect("fixture store");
    store
        .record_sdk_processing(&inbox_id, &[])
        .expect("persist empty crypto set");
    store
        .mark_crypto_drained(&inbox_id)
        .expect("drain empty crypto set");
    let window = build_window(
        WindowSource::live(b"next-token"),
        timestamp(NOW_MILLIS),
        &[RoutedEvent::new("route_demo", canonical_delivery_event())],
    )
    .expect("build deterministic delivery window");
    let batch = window.batches.first().expect("one delivery batch");
    let tenant_id = batch.tenant_id().to_owned();
    let batch_id = batch.batch_id.clone();
    let request_bytes = batch.exact_request_bytes().to_vec();
    let window_id = expected_window_id(&inbox_id);
    store
        .create_collecting_live_window(
            &inbox_id,
            NewLiveWindow::new(window_id.clone(), timestamp(NOW_MILLIS), 0)
                .expect("collecting window"),
        )
        .expect("create collecting window");
    store
        .finalize_live_window(&inbox_id, &window_id, &window, &[], &[])
        .expect("persist exact delivery bytes");
    (tenant_id, batch_id, request_bytes)
}

fn ingestion_credential_config(path: &Path) -> GatewayConfig {
    GatewayConfig::from_json(
        &serde_json::json!({
            "homeserver_url": "http://synapse:8008",
            "matrix_user_id": "@gateway:example.org",
            "matrix_store_dir": "/var/lib/communicator/matrix",
            "state_db_path": "/var/lib/communicator/state.sqlite3",
            "ingestion_base_url": "https://ingest.example.org",
            "ingestion_service_credential_file": path,
            "matrix_password_file": "/run/secrets/matrix-password",
            "matrix_store_passphrase_file": "/run/secrets/matrix-store-passphrase",
            "state_key_file": "/run/secrets/state-key",
            "request_timeout_secs": 10,
            "sync_timeout_secs": 30
        })
        .to_string(),
    )
    .expect("valid startup credential config")
}

fn write_protected_credential(path: &Path, value: &[u8]) {
    fs::write(path, value).expect("write protected credential");
    fs::set_permissions(path, fs::Permissions::from_mode(0o600)).expect("protect credential file");
}

fn observed_message_event() -> ObservedMatrixEvent {
    ObservedMatrixEvent::Timeline(
        ObservedRoomEvent::new(
            SecretBytes::from_text(b"!room:example.org", 64 * 1024).expect("room ID"),
            SecretBytes::from_text(
                br#"{"type":"m.room.message","event_id":"$event:example.org","sender":"@owner:example.org","origin_server_ts":1757500000000,"content":{"msgtype":"m.text","body":"hello"}}"#,
                64 * 1024,
            )
            .expect("event JSON"),
            false,
        )
        .expect("room event"),
    )
}

fn undecryptable_processed_sync() -> ProcessedSync {
    ProcessedSync::new(
        vec![ObservedMatrixEvent::Timeline(
            ObservedRoomEvent::new(
                SecretBytes::from_text(b"!room:example.org", 64 * 1024).expect("room ID"),
                SecretBytes::from_text(br#"{"type":"m.room.encrypted"}"#, 64 * 1024)
                    .expect("event JSON"),
                true,
            )
            .expect("undecryptable event"),
        )],
        Vec::new(),
    )
}

fn canonical_delivery_event() -> CanonicalEvent {
    CanonicalEvent::new(
        "$service_delivery:example.org",
        CanonicalEventSource::Live,
        "tenant_demo",
        "identity_demo",
        Provider::Whatsapp,
        "account_demo",
        "conversation_demo",
        Some("!room:example.org".to_owned()),
        Some("$service_delivery:example.org".to_owned()),
        None,
        "2025-09-11T00:00:00.000Z",
        "2025-09-11T00:00:00.000Z",
        CanonicalPayload::MessageCreated(MessageCreatedPayload {
            message_id: "message_0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
                .to_owned(),
            direction: Direction::Inbound,
            sender_participant_id: None,
            sender_label: "sender".to_owned(),
            body: "delivery".to_owned(),
            reply_to_message_id: None,
            delivery_status: DeliveryStatus::Unknown,
            unread: true,
        }),
    )
    .expect("valid canonical delivery event")
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

fn append_future_crypto_retry(fixture: &mut StoreFixture) {
    let inbox_id = append_test_inbox(fixture, timestamp(NOW_MILLIS + 3_600_000));
    let request = ExactMatrixRequest::keys_query(
        b"future-retry-request".to_vec(),
        br#"{"device_keys":{}}"#.to_vec(),
    )
    .expect("valid future crypto request");
    fixture
        .store
        .as_mut()
        .expect("fixture store")
        .record_sdk_processing(&inbox_id, &[request])
        .expect("persist future crypto request");
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

#[tokio::test(start_paused = true)]
async fn run_exits_when_shutdown_interrupts_a_persisted_retry_wait() {
    let mut fixture = store_fixture();
    append_future_crypto_retry(&mut fixture);
    let transport = FakeMatrixTransport::with_fetch(fetched_sync(
        INITIAL_TOKEN,
        b"next-token",
        br#"{"next_batch":"next-token"}"#,
    ));
    let fetch_calls = transport.fetch_counter();
    let shutdown = FakeShutdown::new();
    let shutdown_request = shutdown.clone();
    let requested_check = shutdown.requested_check_notification();
    let (jitter, _) = DeterministicJitter::new(0);
    let mut service = service_with(
        &mut fixture,
        FakeProcessor::at_digest(Some(Sha256::digest(INITIAL_TOKEN).into())),
        transport,
        jitter,
        shutdown,
    );
    service
        .reconcile_startup()
        .await
        .expect("startup reconcile");

    let run = tokio::spawn(async move { service.run().await });
    requested_check.notified().await;
    shutdown_request.request();

    for _ in 0..4 {
        if run.is_finished() {
            break;
        }
        tokio::task::yield_now().await;
    }
    assert!(
        run.is_finished(),
        "shutdown must wake a persisted retry wait without advancing time"
    );
    run.await
        .expect("service task must join")
        .expect("shutdown must return successfully");
    assert_eq!(fetch_calls.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn unauthorized_ingestion_stops_run_and_restart_recovers_exact_pending_batch() {
    let mut fixture = store_fixture();
    let (tenant_id, batch_id, expected_body) = append_pending_live_batch(&mut fixture);
    let credential_path = fixture._directory.path().join("ingestion-credential");
    write_protected_credential(&credential_path, b"old-ingestion-credential\n");
    let config = ingestion_credential_config(&credential_path);
    let server = MockServer::start().await;
    Mock::given(matchers::path("/internal/v1/ingestion/batches"))
        .respond_with(response_sequence(vec![
            ResponseTemplate::new(401),
            response_for_batch(&tenant_id, &batch_id),
        ]))
        .mount(&server)
        .await;

    let sink = IngestionClient::new_for_test(
        server.uri(),
        load_ingestion_service_credential(&config).expect("old ingestion credential"),
        Duration::from_secs(1),
    )
    .expect("loopback ingestion client");
    let (jitter, _) = DeterministicJitter::new(0);
    let mut service = service_with_sink(
        fixture.store.take().expect("fixture store is available"),
        FakeProcessor::at_digest(Some(Sha256::digest(INITIAL_TOKEN).into())),
        FakeMatrixTransport::with_fetch(fetched_sync(
            INITIAL_TOKEN,
            b"unused-fetch",
            br#"{"next_batch":"unused-fetch"}"#,
        )),
        jitter,
        FakeShutdown::new(),
        sink,
    );

    let error = tokio::time::timeout(Duration::from_secs(3), service.run())
        .await
        .expect("401 must stop the coordinator without a replay loop")
        .expect_err("401 must return the stable paused error");
    assert_eq!(error.code(), "ingestion_unauthorized");
    drop(service);

    let requests = server.received_requests().await.expect("401 request");
    assert_eq!(requests.len(), 1, "paused delivery must not replay in run");
    assert_eq!(
        request_header(&requests[0], "authorization"),
        "Bearer old-ingestion-credential"
    );
    assert_eq!(requests[0].body, expected_body);

    let inspection_store = Store::open(&fixture.path, keyring()).expect("reopen pending store");
    let pending = inspection_store
        .next_pending_ingestion_batch(timestamp(NOW_MILLIS + 2))
        .expect("inspect pending batch")
        .expect("401 must retain pending batch");
    assert_eq!(
        pending.batch().exact_request_bytes(),
        expected_body.as_slice()
    );
    drop(inspection_store);

    let replacement_path = credential_path.with_extension("replacement");
    write_protected_credential(&replacement_path, b"replacement-ingestion-credential\n");
    fs::rename(&replacement_path, &credential_path).expect("atomically replace credential");
    let replacement_sink = IngestionClient::new_for_test(
        server.uri(),
        load_ingestion_service_credential(&ingestion_credential_config(&credential_path))
            .expect("replacement ingestion credential"),
        Duration::from_secs(1),
    )
    .expect("replacement loopback ingestion client");
    let reopened_store = Store::open(&fixture.path, keyring()).expect("restart store");
    let (jitter, _) = DeterministicJitter::new(0);
    let mut restarted = service_with_sink_at(
        reopened_store,
        FakeProcessor::at_digest(Some(Sha256::digest(INITIAL_TOKEN).into())),
        FakeMatrixTransport::with_fetch(fetched_sync(
            INITIAL_TOKEN,
            b"unused-fetch",
            br#"{"next_batch":"unused-fetch"}"#,
        )),
        jitter,
        FakeShutdown::new(),
        replacement_sink,
        timestamp(NOW_MILLIS + 2),
    );
    restarted
        .reconcile_startup()
        .await
        .expect("explicit restart reconciliation");
    assert_eq!(
        restarted.tick().await.expect("replacement delivery"),
        ServiceAction::AcceptedIngestionBatch
    );
    drop(restarted);

    let requests = server.received_requests().await.expect("recovery requests");
    assert_eq!(requests.len(), 2);
    assert_eq!(
        request_header(&requests[1], "authorization"),
        "Bearer replacement-ingestion-credential"
    );
    assert_eq!(requests[1].body, expected_body);
}

#[tokio::test(start_paused = true)]
async fn shutdown_before_a_normal_fetch_results_in_zero_fetch_calls() {
    let mut fixture = store_fixture();
    let transport = FakeMatrixTransport::with_fetch(fetched_sync(
        INITIAL_TOKEN,
        b"next-token",
        br#"{"next_batch":"next-token"}"#,
    ));
    let fetch_calls = transport.fetch_counter();
    let shutdown = FakeShutdown::new();
    shutdown.request();
    let (jitter, _) = DeterministicJitter::new(0);
    let mut service = service_with(
        &mut fixture,
        FakeProcessor::at_digest(Some(Sha256::digest(INITIAL_TOKEN).into())),
        transport,
        jitter,
        shutdown,
    );

    service
        .run()
        .await
        .expect("shutdown must return successfully");
    assert_eq!(fetch_calls.load(Ordering::SeqCst), 0);
}

#[tokio::test(start_paused = true)]
async fn shutdown_during_fetch_allows_the_durable_append_before_exit() {
    let mut fixture = store_fixture();
    let (transport, fetch_started, fetch_release) =
        FakeMatrixTransport::with_blocked_fetch(fetched_sync(
            INITIAL_TOKEN,
            b"next-token",
            br#"{"next_batch":"next-token"}"#,
        ));
    let fetch_calls = transport.fetch_counter();
    let shutdown = FakeShutdown::new();
    let shutdown_request = shutdown.clone();
    let fetch_started_wait = fetch_started.notified();
    let (jitter, _) = DeterministicJitter::new(0);
    let mut service = service_with(
        &mut fixture,
        FakeProcessor::at_digest(Some(Sha256::digest(INITIAL_TOKEN).into())),
        transport,
        jitter,
        shutdown,
    );

    let run = tokio::spawn(async move { service.run().await });
    fetch_started_wait.await;
    shutdown_request.request();
    assert!(
        !run.is_finished(),
        "the in-flight fetch must not be cancelled"
    );
    fetch_release.notify_one();

    run.await
        .expect("service task must join")
        .expect("shutdown must return successfully");
    assert_eq!(fetch_calls.load(Ordering::SeqCst), 1);
    let inbox_count: i64 = Connection::open(&fixture.path)
        .expect("open state inspector")
        .query_row("SELECT COUNT(*) FROM sync_inbox", [], |row| row.get(0))
        .expect("count durably appended sync responses");
    assert_eq!(inbox_count, 1);
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
async fn crash_after_sdk_processing_before_window_preparation_recovers_saved_observations() {
    let mut fixture = store_fixture();
    fixture
        .store
        .as_mut()
        .expect("fixture store")
        .append_room_binding(
            NewRoomBinding::new(
                "binding_0123456789abcdef0123456789abcdef",
                "!room:example.org",
                "tenant_demo",
                "identity_demo",
                "connection_demo",
                "account_demo",
                Provider::Whatsapp,
                "route_demo",
                "conversation_demo",
                "@owner:example.org",
                timestamp(NOW_MILLIS - 1_000),
            )
            .expect("valid room binding"),
        )
        .expect("persist room binding");
    let inbox_id = append_test_inbox(&mut fixture, timestamp(NOW_MILLIS - 1_000));
    let (jitter, _) = DeterministicJitter::new(0);
    let mut first_service = service_with(
        &mut fixture,
        FakeProcessor::at_digest(Some(Sha256::digest(INITIAL_TOKEN).into())).with_processed_sync(
            ProcessedSync::new(vec![observed_message_event()], Vec::new()),
        ),
        FakeMatrixTransport::with_fetch(fetched_sync(
            INITIAL_TOKEN,
            b"later-token",
            br#"{"next_batch":"later-token"}"#,
        )),
        jitter,
        FakeShutdown::new(),
    );
    first_service
        .reconcile_startup()
        .await
        .expect("startup reconcile");
    assert_eq!(
        first_service.tick().await.expect("process inbox"),
        ServiceAction::ProcessedInbox
    );
    drop(first_service);

    fixture.store = Some(Store::open(&fixture.path, keyring()).expect("reopen store"));
    let (jitter, _) = DeterministicJitter::new(0);
    let mut restarted_service = service_with(
        &mut fixture,
        FakeProcessor::at_digest(Some(Sha256::digest(INITIAL_TOKEN).into())).with_recovered_sync(
            ProcessedSync::new(vec![observed_message_event()], Vec::new()),
        ),
        FakeMatrixTransport::with_fetch(fetched_sync(
            INITIAL_TOKEN,
            b"later-token",
            br#"{"next_batch":"later-token"}"#,
        )),
        jitter,
        FakeShutdown::new(),
    );
    restarted_service
        .reconcile_startup()
        .await
        .expect("restart reconcile");
    assert_eq!(
        restarted_service.tick().await.expect("drain crypto"),
        ServiceAction::MarkedCryptoDrained
    );
    assert_eq!(
        restarted_service.tick().await.expect("prepare live window"),
        ServiceAction::PreparedLiveWindow
    );
    drop(restarted_service);

    let reopened = Store::open(&fixture.path, keyring()).expect("inspect reopened store");
    assert_eq!(
        reopened
            .ledger_pressure()
            .expect("read ledger pressure")
            .pending_batches(),
        1
    );
    let state: String = Connection::open(&fixture.path)
        .expect("open state inspector")
        .query_row(
            "SELECT state FROM sync_inbox WHERE inbox_id = ?1",
            [inbox_id],
            |row| row.get(0),
        )
        .expect("read inbox state");
    assert_eq!(state, "prepared");
}

#[tokio::test]
async fn current_sdk_digest_protects_recovery_reconciliation_row_during_purge() {
    let mut fixture = store_fixture();
    let old = timestamp(NOW_MILLIS - 8 * 24 * 60 * 60 * 1_000);
    let first_id =
        append_and_commit_empty_inbox(&mut fixture, INITIAL_TOKEN, b"committed-token-1", old, old);
    let (jitter, _) = DeterministicJitter::new(0);
    let clock = ManualClock::new(timestamp(NOW_MILLIS - 7 * 24 * 60 * 60 * 1_000));
    let clock_now = Arc::clone(&clock.now);
    let mut service = GatewayService::new(
        fixture.store.take().expect("fixture store is available"),
        FakeProcessor::at_digest(Some(Sha256::digest(b"committed-token-1").into()))
            .with_later_sdk_digest(Some(Sha256::digest(b"recovery-token-3").into())),
        FakeMatrixTransport::with_fetch(fetched_sync(
            b"committed-token-1",
            b"recovery-token-3",
            br#"{"next_batch":"recovery-token-3"}"#,
        )),
        FakeIngestionSink,
        clock,
        jitter,
        FakeShutdown::new(),
        RetryPolicy::new(Duration::from_millis(100), Duration::from_secs(5), 10)
            .expect("valid retry policy"),
    )
    .expect("valid service");
    service
        .reconcile_startup()
        .await
        .expect("startup reconcile");
    assert_eq!(
        service.tick().await.expect("fetch later row"),
        ServiceAction::FetchedSync
    );
    assert_eq!(
        service.tick().await.expect("process later row"),
        ServiceAction::ProcessedInbox
    );
    assert_eq!(
        service.tick().await.expect("drain later row"),
        ServiceAction::MarkedCryptoDrained
    );
    let second_id: String = Connection::open(&fixture.path)
        .expect("open state inspector")
        .query_row(
            "SELECT inbox_id FROM sync_inbox WHERE predecessor_id = ?1",
            [first_id.as_str()],
            |row| row.get(0),
        )
        .expect("read later row");
    assert_eq!(
        service.tick().await.expect("prepare later row"),
        ServiceAction::CommittedEmptyWindow
    );
    *clock_now.lock().expect("clock lock") = timestamp(NOW_MILLIS);
    assert_eq!(
        service.tick().await.expect("purge tick"),
        ServiceAction::PurgedCommittedPrefix
    );
    drop(service);

    let connection = Connection::open(&fixture.path).expect("open state inspector");
    let remaining: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM sync_inbox WHERE inbox_id IN (?1, ?2)",
            params![first_id, second_id],
            |row| row.get(0),
        )
        .expect("count retained inbox rows");
    assert_eq!(remaining, 1);
    let retained_newest: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM sync_inbox WHERE inbox_id = ?1",
            [second_id],
            |row| row.get(0),
        )
        .expect("check newest committed row");
    assert_eq!(retained_newest, 1);
}

#[tokio::test]
async fn sdk_processed_message_is_prepared_from_the_verified_room_binding() {
    let mut fixture = store_fixture();
    fixture
        .store
        .as_mut()
        .expect("fixture store")
        .append_room_binding(
            NewRoomBinding::new(
                "binding_0123456789abcdef0123456789abcdef",
                "!room:example.org",
                "tenant_demo",
                "identity_demo",
                "connection_demo",
                "account_demo",
                Provider::Whatsapp,
                "route_demo",
                "conversation_demo",
                "@owner:example.org",
                timestamp(NOW_MILLIS - 1_000),
            )
            .expect("valid room binding"),
        )
        .expect("persist room binding");
    let processor = FakeProcessor::at_digest(Some(Sha256::digest(INITIAL_TOKEN).into()))
        .with_processed_sync(ProcessedSync::new(
            vec![observed_message_event()],
            Vec::new(),
        ))
        .with_recovered_sync(ProcessedSync::new(
            vec![observed_message_event()],
            Vec::new(),
        ));
    let inbox_id = append_test_inbox(&mut fixture, timestamp(NOW_MILLIS - 1_000));
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
        service.tick().await.expect("process inbox"),
        ServiceAction::ProcessedInbox
    );
    assert_eq!(
        service.tick().await.expect("drain crypto"),
        ServiceAction::MarkedCryptoDrained
    );
    assert_eq!(
        service.tick().await.expect("prepare live window"),
        ServiceAction::PreparedLiveWindow
    );
    let state: String = Connection::open(&fixture.path)
        .expect("open state inspector")
        .query_row(
            "SELECT state FROM sync_inbox WHERE inbox_id = ?1",
            [inbox_id],
            |row| row.get(0),
        )
        .expect("read inbox state");
    assert_eq!(state, "prepared");
}

#[tokio::test]
async fn keys_upload_policy_sets_persisted_crypto_maintenance_before_projection() {
    let mut fixture = store_fixture();
    let inbox_id = append_test_inbox(&mut fixture, timestamp(NOW_MILLIS - 1_000));
    let (jitter, _) = DeterministicJitter::new(0);
    let mut service = service_with(
        &mut fixture,
        FakeProcessor::at_digest(Some(Sha256::digest(INITIAL_TOKEN).into())).with_pending_error(
            communicator_matrix_gateway::matrix::MATRIX_CRYPTO_MAINTENANCE_REQUIRED,
        ),
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
        service.tick().await.expect_err("maintenance must halt"),
        SafeError::new("service_maintenance_required")
    );

    let maintenance: String = Connection::open(&fixture.path)
        .expect("open state inspector")
        .query_row(
            "SELECT maintenance_code FROM gateway_state WHERE singleton = 1",
            [],
            |row| row.get(0),
        )
        .expect("read maintenance marker");
    assert_eq!(maintenance, "crypto_maintenance_required");
    let state: String = Connection::open(&fixture.path)
        .expect("open state inspector")
        .query_row(
            "SELECT state FROM sync_inbox WHERE inbox_id = ?1",
            [inbox_id],
            |row| row.get(0),
        )
        .expect("read inbox state");
    assert_eq!(state, "fetched");
}

#[tokio::test]
async fn missing_key_recovery_stops_at_sixteen_persisted_later_responses() {
    let mut fixture = store_fixture();
    let head_id = append_test_inbox(&mut fixture, timestamp(NOW_MILLIS - 1_000));
    let mut previous = b"next-token".to_vec();
    for index in 0..16 {
        let next = format!("recovery-token-{index}").into_bytes();
        append_inbox(
            &mut fixture,
            &previous,
            &next,
            format!(r#"{{"next_batch":"recovery-token-{index}"}}"#).as_bytes(),
            timestamp(NOW_MILLIS - 1_000 + (index as i64 + 1) * 1_000),
        );
        previous = next;
    }
    let unable = ObservedRoomEvent::new(
        SecretBytes::from_text(b"!room:example.org", 64 * 1024).expect("room ID"),
        SecretBytes::from_text(br#"{"type":"m.room.encrypted"}"#, 64 * 1024).expect("event JSON"),
        true,
    )
    .expect("undecryptable event");
    let processor = FakeProcessor::at_digest(Some(Sha256::digest(INITIAL_TOKEN).into()))
        .with_processed_sync(ProcessedSync::new(
            vec![ObservedMatrixEvent::Timeline(unable)],
            Vec::new(),
        ))
        .with_recovered_sync_factory(undecryptable_processed_sync);
    let (jitter, _) = DeterministicJitter::new(0);
    let mut service = service_with(
        &mut fixture,
        processor,
        FakeMatrixTransport::with_fetch(fetched_sync(
            INITIAL_TOKEN,
            b"unused-fetch",
            br#"{"next_batch":"unused-fetch"}"#,
        )),
        jitter,
        FakeShutdown::new(),
    );
    service
        .reconcile_startup()
        .await
        .expect("startup reconcile");
    assert_eq!(
        service.tick().await.expect("process recovery head"),
        ServiceAction::ProcessedInbox
    );
    assert_eq!(
        service.tick().await.expect("drain recovery head"),
        ServiceAction::MarkedCryptoDrained
    );
    for _ in 0..16 {
        assert!(matches!(
            service.tick().await.expect("apply later recovery response"),
            ServiceAction::ProcessedInbox
        ));
        assert_eq!(
            service.tick().await.expect("drain later recovery response"),
            ServiceAction::MarkedCryptoDrained
        );
    }
    let error = service
        .tick()
        .await
        .expect_err("recovery must stop at the inclusive bound");
    assert_eq!(error.code(), "matrix_key_recovery_exhausted");
    let state: String = Connection::open(&fixture.path)
        .expect("open state inspector")
        .query_row(
            "SELECT state FROM sync_inbox WHERE inbox_id = ?1",
            [head_id],
            |row| row.get(0),
        )
        .expect("read blocked head");
    assert_eq!(state, "sdk_processed");
}

#[tokio::test]
async fn prepared_live_batch_is_delivered_and_accepted_before_fetching_again() {
    let mut fixture = store_fixture();
    let inbox_id = append_test_inbox(&mut fixture, timestamp(NOW_MILLIS - 1_000));
    let store = fixture.store.as_mut().expect("fixture store");
    store
        .record_sdk_processing(&inbox_id, &[])
        .expect("persist empty crypto set");
    store
        .mark_crypto_drained(&inbox_id)
        .expect("drain empty crypto set");
    let window = build_window(
        WindowSource::live(b"next-token"),
        timestamp(NOW_MILLIS),
        &[RoutedEvent::new("route_demo", canonical_delivery_event())],
    )
    .expect("build deterministic delivery window");
    let window_id = expected_window_id(&inbox_id);
    store
        .create_collecting_live_window(
            &inbox_id,
            NewLiveWindow::new(window_id.clone(), timestamp(NOW_MILLIS), 0)
                .expect("collecting window"),
        )
        .expect("create collecting window");
    store
        .finalize_live_window(&inbox_id, &window_id, &window, &[], &[])
        .expect("persist exact delivery bytes");

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
        service.tick().await.expect("delivery action"),
        ServiceAction::AcceptedIngestionBatch
    );

    let (state, committed): (String, i64) = Connection::open(&fixture.path)
        .expect("open state inspector")
        .query_row(
            "SELECT state, (SELECT COUNT(*) FROM outbox_batches WHERE state = 'accepted')
             FROM sync_inbox WHERE inbox_id = ?1",
            [inbox_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .expect("read accepted delivery state");
    assert_eq!(state, "committed");
    assert_eq!(committed, 1);
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
