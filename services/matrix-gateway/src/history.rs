//! Authenticated, bounded Matrix-room history pagination.
//!
//! This is the private Communicator adapter consumed by the Worker history
//! service. It resolves the complete account authority tuple through the
//! encrypted room registry, stores pagination in the existing explicit
//! backfill ledger, and delegates one page at a time to the Matrix transport.
//! WhatsApp's one-time initial history-sync capability is intentionally not
//! inferred from this Matrix-room read path.

use std::{fmt, net::SocketAddr, sync::Arc};

use chrono::{DateTime, SecondsFormat, TimeZone, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::{
    net::{TcpListener, TcpStream},
    sync::Mutex,
};

use crate::{
    batch::{self, BackfillCheckpoint, WindowSource},
    ledger::{NewBackfillJob, STORE_BACKFILL_NOT_READY},
    matrix::MatrixTransport,
    model::{self, Provider},
    provisioning::{HttpRequest, read_http_request, response, write_http_response},
    secret::{SafeError, SecretBytes},
    store::Store,
};

const MAX_ID_BYTES: usize = 512;
const MAX_RANGE_ID_BYTES: usize = 128;
const MAX_PAGE_EVENTS: u64 = 500;
const PAGE_LIMIT: u64 = MAX_PAGE_EVENTS;
const HISTORY_UNAVAILABLE: &str = "runtime_unavailable";
const HISTORY_PROVIDER_ERROR: &str = "provider_error";
const HISTORY_MALFORMED_RANGE: &str = "malformed_range";
const HISTORY_CONFLICT: &str = "history_conflict";

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct HistoryPagination {
    schema_version: u8,
    range_id: String,
    input_cursor: Option<String>,
    source_cursor: String,
    public_cursor: String,
}

/// The exact Worker owner tuple used to resolve a Matrix room.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct HistoryOwner {
    tenant_id: String,
    account_id: String,
    connection_id: String,
    identity_id: String,
    provider: Provider,
    import_id: String,
    start_at: String,
    end_at: String,
    max_events: u64,
}

impl HistoryOwner {
    fn validate(&self) -> Result<(), &'static str> {
        if !model::valid_resource_id(&self.tenant_id)
            || !model::valid_resource_id(&self.account_id)
            || !model::valid_resource_id(&self.connection_id)
            || !model::valid_resource_id(&self.identity_id)
            || !model::valid_resource_id(&self.import_id)
            || !model::valid_timestamp(&self.start_at)
            || !model::valid_timestamp(&self.end_at)
            || !(1..=batch::MAX_BACKFILL_EVENTS).contains(&self.max_events)
        {
            return Err(HISTORY_MALFORMED_RANGE);
        }
        let start = parse_utc_millis(&self.start_at).ok_or(HISTORY_MALFORMED_RANGE)?;
        let end = parse_utc_millis(&self.end_at).ok_or(HISTORY_MALFORMED_RANGE)?;
        if start >= end {
            return Err(HISTORY_MALFORMED_RANGE);
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct HistoryAdvanceRequest {
    #[serde(flatten)]
    owner: HistoryOwner,
    range_id: String,
    source_cursor: Option<String>,
}

/// Private Matrix-history server state.
pub struct HistoryGatewayServer {
    store: Arc<Mutex<Store>>,
    transport: Arc<dyn MatrixTransport>,
    gateway_token: String,
}

impl fmt::Debug for HistoryGatewayServer {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("HistoryGatewayServer([REDACTED])")
    }
}

impl HistoryGatewayServer {
    /// Construct the authenticated history adapter.
    pub fn new(
        store: Store,
        transport: Arc<dyn MatrixTransport>,
        gateway_token: impl Into<String>,
    ) -> Result<Self, SafeError> {
        let gateway_token = gateway_token.into();
        if gateway_token.len() < 16 {
            return Err(SafeError::new(HISTORY_PROVIDER_ERROR));
        }
        Ok(Self {
            store: Arc::new(Mutex::new(store)),
            transport,
            gateway_token,
        })
    }

    /// Serve history routes on a private listener.
    pub async fn serve(self, listener: TcpListener) -> Result<(), std::io::Error> {
        loop {
            let (stream, _) = listener.accept().await?;
            let server = self.clone();
            tokio::spawn(async move {
                let _ = server.handle_connection(stream).await;
            });
        }
    }

    /// Handle one private connection using the existing bounded HTTP parser.
    pub async fn handle_connection(&self, mut stream: TcpStream) -> Result<(), std::io::Error> {
        let request = read_http_request(&mut stream).await?;
        let (status, body) = self.handle_request(request).await;
        write_http_response(&mut stream, status, &body).await
    }

    /// Handle one already parsed private request.
    pub(crate) async fn handle_request(&self, request: HttpRequest) -> (u16, Vec<u8>) {
        if request.authorization.as_deref() != Some(self.gateway_token.as_str()) {
            return response(401, json!({ "error": "unauthorized" }));
        }
        if !request
            .request_id
            .as_deref()
            .is_some_and(|value| !value.is_empty() && value.len() <= MAX_ID_BYTES)
            || !request
                .idempotency_key
                .as_deref()
                .is_some_and(|value| !value.is_empty() && value.len() <= MAX_ID_BYTES)
        {
            return response(400, json!({ "error": "invalid_request" }));
        }
        match request.path.as_str() {
            "/v1/history-imports/start" => self.start(request.body).await,
            "/v1/history-imports/advance" => self.advance(request.body).await,
            _ => response(404, json!({ "error": "not_found" })),
        }
    }

    async fn start(&self, body: Vec<u8>) -> (u16, Vec<u8>) {
        let owner = match serde_json::from_slice::<HistoryOwner>(&body) {
            Ok(value) => value,
            Err(_) => return response(400, json!({ "error": "invalid_request" })),
        };
        if let Err(code) = owner.validate() {
            return response(400, json!({ "error": code }));
        }

        let binding = {
            let store = self.store.lock().await;
            match store.active_room_binding_for_history(
                &owner.tenant_id,
                &owner.account_id,
                &owner.connection_id,
                &owner.identity_id,
                owner.provider,
            ) {
                Ok(Some(binding)) => binding,
                Ok(None) => return response(403, json!({ "error": HISTORY_CONFLICT })),
                Err(error) => return response(503, json!({ "error": error.code() })),
            }
        };

        let now = utc_now();
        let job = match batch::BackfillJob::new(
            owner.import_id.clone(),
            binding.matrix_room_id(),
            &owner.start_at,
            &owner.end_at,
            owner.max_events,
        ) {
            Ok(job) => job,
            Err(_) => return response(400, json!({ "error": HISTORY_MALFORMED_RANGE })),
        };
        let parameters = match serde_json::to_vec(&owner) {
            Ok(value) => value,
            Err(_) => return response(503, json!({ "error": HISTORY_PROVIDER_ERROR })),
        };
        let stored = {
            let mut store = self.store.lock().await;
            match store.begin_or_resume_backfill_job(&owner.import_id) {
                Ok(stored) => stored,
                Err(error) if error.code() == STORE_BACKFILL_NOT_READY => {
                    let created = match NewBackfillJob::new(job, parameters, now) {
                        Ok(value) => value,
                        Err(_) => {
                            return response(400, json!({ "error": HISTORY_MALFORMED_RANGE }));
                        }
                    };
                    if let Err(error) = store.create_backfill_job(created) {
                        return response(503, json!({ "error": error.code() }));
                    }
                    match store.begin_or_resume_backfill_job(&owner.import_id) {
                        Ok(stored) => stored,
                        Err(error) => return response(503, json!({ "error": error.code() })),
                    }
                }
                Err(error) => return response(503, json!({ "error": error.code() })),
            }
        };
        if !job_matches_owner(stored.job(), &owner, binding.matrix_room_id()) {
            return response(409, json!({ "error": HISTORY_CONFLICT }));
        }

        let source_cursor = stored_pagination(stored.pagination()).map(|value| value.public_cursor);
        response(
            200,
            json!({
                "availability": "available",
                "provider_version": null,
                "proof_source": "matrix_room_messages",
                "provider_evidence": {
                    "provider_version": null,
                    "proof_source": "matrix_room_messages",
                    "summary": "The private gateway can paginate an authenticated Matrix room; this does not prove a provider-side WhatsApp history request.",
                    "observed_at": now.to_rfc3339_opts(SecondsFormat::Millis, true),
                },
                "source_start_at": owner.start_at,
                "source_end_at": owner.end_at,
                "ranges": [{
                    "start_at": owner.start_at,
                    "end_at": owner.end_at,
                    "source_cursor": source_cursor,
                }],
                "error_code": Value::Null,
            }),
        )
    }

    async fn advance(&self, body: Vec<u8>) -> (u16, Vec<u8>) {
        let request = match serde_json::from_slice::<HistoryAdvanceRequest>(&body) {
            Ok(value) => value,
            Err(_) => return response(400, json!({ "error": "invalid_request" })),
        };
        if let Err(code) = request.owner.validate() {
            return response(400, json!({ "error": code }));
        }
        if request.range_id.is_empty() || request.range_id.len() > MAX_RANGE_ID_BYTES {
            return response(400, json!({ "error": "invalid_request" }));
        }

        let (binding, stored) = {
            let mut store = self.store.lock().await;
            let binding = match store.active_room_binding_for_history(
                &request.owner.tenant_id,
                &request.owner.account_id,
                &request.owner.connection_id,
                &request.owner.identity_id,
                request.owner.provider,
            ) {
                Ok(Some(binding)) => binding,
                Ok(None) => return response(403, json!({ "error": HISTORY_CONFLICT })),
                Err(error) => return response(503, json!({ "error": error.code() })),
            };
            let stored = match store.begin_or_resume_backfill_job(&request.owner.import_id) {
                Ok(stored) => stored,
                Err(error) => return response(409, json!({ "error": error.code() })),
            };
            if !job_matches_owner(stored.job(), &request.owner, binding.matrix_room_id())
                || !cursor_matches(
                    stored.pagination(),
                    request.range_id.as_str(),
                    request.source_cursor.as_deref(),
                )
            {
                return response(409, json!({ "error": HISTORY_CONFLICT }));
            }

            if let Some(cursor) = stored_pagination(stored.pagination())
                && cursor.input_cursor.as_deref() == request.source_cursor.as_deref()
            {
                return response(
                    200,
                    json!({
                        "status": "active",
                        "events": [],
                        "next_cursor": cursor.public_cursor,
                        "gap_code": Value::Null,
                        "error_code": Value::Null,
                    }),
                );
            }
            (binding, stored)
        };

        let from = stored_pagination(stored.pagination())
            .map(|value| SecretBytes::new(value.source_cursor.into_bytes()));
        let page = match self
            .transport
            .backfill_page(binding.matrix_room_id(), from.as_ref(), PAGE_LIMIT)
            .await
        {
            Ok(page) => page,
            Err(error) => return response(502, json!({ "error": error.code() })),
        };
        if page.chunk().len() > MAX_PAGE_EVENTS as usize {
            return response(502, json!({ "error": HISTORY_PROVIDER_ERROR }));
        }
        // The first gateway checkpoint intentionally refuses to advance past
        // raw events until the shared Matrix normalizer is wired into this
        // path. Empty Matrix pages are safe to checkpoint and prove cursor
        // replay without silently dropping history.
        if !page.chunk().is_empty() || !page.state().is_empty() {
            return response(503, json!({ "error": HISTORY_UNAVAILABLE }));
        }

        let checkpoint = match BackfillCheckpoint::new(
            stored.job().job_id(),
            stored.job().room_id(),
            stored.job().start_at(),
            stored.job().end_at(),
            stored.job().max_events(),
            0,
        ) {
            Ok(value) => value,
            Err(_) => return response(503, json!({ "error": HISTORY_PROVIDER_ERROR })),
        };
        let window = match batch::build_window(WindowSource::backfill(checkpoint), utc_now(), &[]) {
            Ok(window) => window,
            Err(_) => return response(503, json!({ "error": HISTORY_PROVIDER_ERROR })),
        };
        let now = utc_now();
        let mut next_cursor = None;
        {
            let mut store = self.store.lock().await;
            let pagination = match page.end() {
                Some(source_cursor) => {
                    let public_cursor = match store.history_cursor_token(
                        &request.owner.import_id,
                        &request.range_id,
                        source_cursor,
                    ) {
                        Ok(value) => value,
                        Err(error) => return response(503, json!({ "error": error.code() })),
                    };
                    next_cursor = Some(public_cursor.clone());
                    let value = HistoryPagination {
                        schema_version: 1,
                        range_id: request.range_id.clone(),
                        input_cursor: request.source_cursor.clone(),
                        source_cursor: source_cursor.to_owned(),
                        public_cursor,
                    };
                    match serde_json::to_vec(&value) {
                        Ok(value) => Some(SecretBytes::new(value)),
                        Err(_) => return response(503, json!({ "error": HISTORY_PROVIDER_ERROR })),
                    }
                }
                None => None,
            };
            if let Err(error) = store.checkpoint_backfill_page(
                &request.owner.import_id,
                pagination.as_ref(),
                &window,
                stored.accepted_events(),
            ) {
                return response(503, json!({ "error": error.code() }));
            }
            if page.end().is_none()
                && let Err(error) = store.complete_backfill_job(&request.owner.import_id, now)
            {
                return response(503, json!({ "error": error.code() }));
            }
        }

        let completed = page.end().is_none();
        response(
            200,
            json!({
                "status": if completed { "completed" } else { "active" },
                "events": [],
                "next_cursor": next_cursor,
                "gap_code": Value::Null,
                "error_code": Value::Null,
            }),
        )
    }
}

impl Clone for HistoryGatewayServer {
    fn clone(&self) -> Self {
        Self {
            store: Arc::clone(&self.store),
            transport: Arc::clone(&self.transport),
            gateway_token: self.gateway_token.clone(),
        }
    }
}

/// Serve a history gateway on a configured private address.
pub async fn serve_history_gateway(
    server: HistoryGatewayServer,
    listen_addr: SocketAddr,
) -> Result<(), std::io::Error> {
    server.serve(TcpListener::bind(listen_addr).await?).await
}

fn job_matches_owner(job: &batch::BackfillJob, owner: &HistoryOwner, room_id: &str) -> bool {
    job.job_id() == owner.import_id
        && job.room_id() == room_id
        && job.start_at() == owner.start_at
        && job.end_at() == owner.end_at
        && job.max_events() == owner.max_events
}

fn stored_pagination(stored: Option<&SecretBytes>) -> Option<HistoryPagination> {
    let bytes = stored?.as_bytes();
    serde_json::from_slice(bytes).ok()
}

fn cursor_matches(stored: Option<&SecretBytes>, range_id: &str, requested: Option<&str>) -> bool {
    match (stored_pagination(stored), requested) {
        (None, None) => true,
        (Some(stored), Some(requested)) => {
            stored.schema_version == 1
                && stored.range_id == range_id
                && (stored.public_cursor == requested
                    || stored.input_cursor.as_deref() == Some(requested))
        }
        (Some(stored), None) => {
            stored.schema_version == 1
                && stored.range_id == range_id
                && stored.input_cursor.is_none()
        }
        (None, Some(_)) => false,
    }
}

fn parse_utc_millis(value: &str) -> Option<DateTime<Utc>> {
    let parsed = DateTime::parse_from_rfc3339(value)
        .ok()?
        .with_timezone(&Utc);
    parsed
        .timestamp_subsec_nanos()
        .is_multiple_of(1_000_000)
        .then_some(parsed)
}

fn utc_now() -> DateTime<Utc> {
    let millis = Utc::now().timestamp_millis();
    Utc.timestamp_millis_opt(millis)
        .single()
        .expect("current UTC timestamp must be representable")
}

#[cfg(test)]
mod tests {
    use std::{
        os::unix::fs::PermissionsExt,
        sync::atomic::{AtomicUsize, Ordering},
    };

    use async_trait::async_trait;
    use chrono::TimeZone;
    use tempfile::tempdir;

    use super::*;
    use crate::{
        crypto::Keyring,
        matrix::{FetchedMatrixSync, RawBackfillPage},
        provisioning::HttpRequest,
        registry::NewRoomBinding,
    };

    struct ControlledHistoryTransport {
        calls: AtomicUsize,
    }

    #[async_trait]
    impl MatrixTransport for ControlledHistoryTransport {
        async fn fetch_sync(&self, _since: &SecretBytes) -> Result<FetchedMatrixSync, SafeError> {
            Err(SafeError::new(HISTORY_PROVIDER_ERROR))
        }

        async fn backfill_page(
            &self,
            _room_id: &str,
            _from: Option<&SecretBytes>,
            _limit: u64,
        ) -> Result<RawBackfillPage, SafeError> {
            let call = self.calls.fetch_add(1, Ordering::SeqCst);
            RawBackfillPage::new(
                format!("matrix-start-{call}"),
                (call == 0).then_some("matrix-end-1".to_owned()),
                Vec::new(),
                Vec::new(),
            )
        }

        async fn send_crypto(
            &self,
            _request: &crate::crypto_outbox::PendingMatrixRequest,
        ) -> Result<crate::crypto_outbox::RawMatrixResponse, SafeError> {
            Err(SafeError::new(HISTORY_PROVIDER_ERROR))
        }
    }

    fn binding_time() -> DateTime<Utc> {
        Utc.timestamp_millis_opt(1_700_000_000_000)
            .single()
            .expect("valid timestamp")
    }

    fn owner() -> HistoryOwner {
        HistoryOwner {
            tenant_id: "tenant_demo".to_owned(),
            account_id: "account_demo".to_owned(),
            connection_id: "connection_demo".to_owned(),
            identity_id: "identity_demo".to_owned(),
            provider: Provider::Whatsapp,
            import_id: "import_demo".to_owned(),
            start_at: "2026-01-01T00:00:00.000Z".to_owned(),
            end_at: "2026-01-02T00:00:00.000Z".to_owned(),
            max_events: 100,
        }
    }

    fn request(path: &str, body: &HistoryOwner, cursor: Option<&str>) -> HttpRequest {
        let value = if path.ends_with("advance") {
            json!({
                "tenant_id": body.tenant_id,
                "account_id": body.account_id,
                "connection_id": body.connection_id,
                "identity_id": body.identity_id,
                "provider": body.provider,
                "import_id": body.import_id,
                "start_at": body.start_at,
                "end_at": body.end_at,
                "max_events": body.max_events,
                "range_id": "range_demo",
                "source_cursor": cursor,
            })
        } else {
            serde_json::to_value(body).expect("owner JSON")
        };
        HttpRequest {
            path: path.to_owned(),
            authorization: Some("history-gateway-secret".to_owned()),
            request_id: Some("request-demo".to_owned()),
            idempotency_key: Some("history-import_demo-request".to_owned()),
            body: serde_json::to_vec(&value).expect("request JSON"),
        }
    }

    async fn server() -> (
        HistoryGatewayServer,
        Arc<ControlledHistoryTransport>,
        tempfile::TempDir,
    ) {
        let directory = tempdir().expect("state directory");
        let path = directory.path().join("gateway.sqlite");
        std::fs::set_permissions(directory.path(), std::fs::Permissions::from_mode(0o700))
            .expect("restrict state parent");
        let mut store = Store::open(&path, Keyring::new([0x11; 32], 1).expect("test keyring"))
            .expect("open store");
        store
            .append_room_binding(
                NewRoomBinding::new(
                    "binding_0123456789abcdef0123456789abcdef",
                    "!history:example.test",
                    "tenant_demo",
                    "identity_demo",
                    "connection_demo",
                    "account_demo",
                    Provider::Whatsapp,
                    "route_demo",
                    "conversation_demo",
                    "@owner:example.test",
                    binding_time(),
                )
                .expect("binding"),
            )
            .expect("append binding");
        let transport = Arc::new(ControlledHistoryTransport {
            calls: AtomicUsize::new(0),
        });
        let server = HistoryGatewayServer::new(
            store,
            Arc::clone(&transport) as Arc<dyn MatrixTransport>,
            "history-gateway-secret",
        )
        .expect("history server");
        (server, transport, directory)
    }

    #[tokio::test]
    async fn authenticated_page_checkpoints_and_start_replays_cursor() {
        let (server, transport, _directory) = server().await;
        let owner = owner();
        assert_eq!(owner.validate(), Ok(()));
        let started = server
            .handle_request(request("/v1/history-imports/start", &owner, None))
            .await;
        assert_eq!(started.0, 200, "{}", String::from_utf8_lossy(&started.1));
        let started: Value = serde_json::from_slice(&started.1).expect("start JSON");
        assert_eq!(started["availability"], "available");
        assert_eq!(started["ranges"][0]["source_cursor"], Value::Null);

        let first = server
            .handle_request(request("/v1/history-imports/advance", &owner, None))
            .await;
        assert_eq!(first.0, 200);
        let first: Value = serde_json::from_slice(&first.1).expect("advance JSON");
        assert_eq!(first["status"], "active");
        let public_cursor = first["next_cursor"].as_str().expect("opaque cursor");
        assert!(public_cursor.starts_with("history_"));
        assert_ne!(public_cursor, "matrix-end-1");
        assert_eq!(transport.calls.load(Ordering::SeqCst), 1);

        let retry = server
            .handle_request(request("/v1/history-imports/advance", &owner, None))
            .await;
        assert_eq!(retry.0, 200);
        let retry: Value = serde_json::from_slice(&retry.1).expect("retried advance JSON");
        assert_eq!(retry["next_cursor"], public_cursor);
        assert_eq!(transport.calls.load(Ordering::SeqCst), 1);

        let replay = server
            .handle_request(request("/v1/history-imports/start", &owner, None))
            .await;
        assert_eq!(replay.0, 200);
        let replay: Value = serde_json::from_slice(&replay.1).expect("replayed start JSON");
        assert_eq!(replay["ranges"][0]["source_cursor"], public_cursor);

        let second = server
            .handle_request(request(
                "/v1/history-imports/advance",
                &owner,
                Some(public_cursor),
            ))
            .await;
        assert_eq!(second.0, 200);
        let second: Value = serde_json::from_slice(&second.1).expect("terminal JSON");
        assert_eq!(second["status"], "completed");
        assert_eq!(second["next_cursor"], Value::Null);
        assert_eq!(transport.calls.load(Ordering::SeqCst), 2);
    }
}
