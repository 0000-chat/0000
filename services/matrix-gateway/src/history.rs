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
    attachments::AttachmentGateway,
    batch::{self, BackfillCheckpoint, WindowSource},
    canonical,
    ledger::{BackfillState, NewBackfillJob, STORE_BACKFILL_NOT_READY},
    matrix::{MatrixTransport, observed_backfill_state_event, observed_backfill_timeline_event},
    model::{self, Provider},
    provisioning::{HttpRequest, read_http_request, response, write_http_response},
    secret::{SafeError, SecretBytes},
    service::normalize_backfill_events,
    store::Store,
};

const MAX_ID_BYTES: usize = 512;
const MAX_RANGE_ID_BYTES: usize = 128;
const MAX_PAGE_EVENTS: u64 = 500;
// One Matrix message can project its message event plus one metadata event
// and one verified-resolution event per attachment. Keep the source page
// below the public canonical event bound even at the normalizer's maximum;
// this avoids retrying an unchanged cursor after projection expands a page.
const MAX_NORMALIZED_EVENTS_PER_SOURCE_EVENT: u64 =
    1 + (2 * crate::normalize::MAX_MESSAGE_ATTACHMENTS as u64);
const PAGE_LIMIT: u64 = MAX_PAGE_EVENTS / MAX_NORMALIZED_EVENTS_PER_SOURCE_EVENT;
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
    page_start: u64,
    page_length: u64,
    history_terminal: bool,
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
    attachments: AttachmentGateway,
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
        let store = Arc::new(Mutex::new(store));
        let attachments = AttachmentGateway::new(Arc::clone(&store), Arc::clone(&transport));
        Ok(Self {
            store,
            transport,
            gateway_token,
            attachments,
        })
    }

    /// Share the exclusively opened state store with the authenticated
    /// outbound gateway. Both routes stay inside the same process lock and
    /// therefore cannot observe an uncommitted journal mutation.
    pub(crate) fn store_handle(&self) -> Arc<Mutex<Store>> {
        Arc::clone(&self.store)
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
            "/v1/attachments/read" => self.attachments.handle_request(request.body).await,
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
                        Err(error) if error.code() == STORE_BACKFILL_NOT_READY => {
                            match store.load_backfill_job_for_history(&owner.import_id) {
                                Ok(stored) => stored,
                                Err(error) => {
                                    return response(503, json!({ "error": error.code() }));
                                }
                            }
                        }
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
                Err(error) if error.code() == STORE_BACKFILL_NOT_READY => {
                    match store.load_backfill_job_for_history(&request.owner.import_id) {
                        Ok(stored) => stored,
                        Err(error) => return response(409, json!({ "error": error.code() })),
                    }
                }
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
                let events = match store.backfill_page_events(
                    &request.owner.import_id,
                    cursor.page_start,
                    cursor.page_length,
                ) {
                    Ok(value) => value,
                    Err(error) => return response(503, json!({ "error": error.code() })),
                };
                let events = match events
                    .iter()
                    .map(serde_json::to_value)
                    .collect::<Result<Vec<_>, _>>()
                {
                    Ok(value) => value,
                    Err(_) => return response(503, json!({ "error": HISTORY_PROVIDER_ERROR })),
                };
                return response(
                    200,
                    json!({
                        "status": if cursor.history_terminal {
                            "completed"
                        } else {
                            "active"
                        },
                        "events": events,
                        "next_cursor": if cursor.history_terminal {
                            Value::Null
                        } else {
                            json!(cursor.public_cursor)
                        },
                        "gap_code": Value::Null,
                        "error_code": Value::Null,
                    }),
                );
            }
            if stored.state() == BackfillState::Completed {
                return response(409, json!({ "error": HISTORY_CONFLICT }));
            }
            if stored_pagination(stored.pagination()).is_some_and(|cursor| cursor.history_terminal)
            {
                return response(409, json!({ "error": HISTORY_CONFLICT }));
            }
            (binding, stored)
        };

        let stored_cursor = stored_pagination(stored.pagination());
        let from_source = stored_cursor
            .as_ref()
            .map(|value| value.source_cursor.clone());
        let from = from_source
            .as_ref()
            .map(|value| SecretBytes::new(value.as_bytes().to_vec()));
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
        if from_source
            .as_deref()
            .is_some_and(|value| value != page.start())
        {
            return response(502, json!({ "error": HISTORY_PROVIDER_ERROR }));
        }

        let room_lookup = {
            let store = self.store.lock().await;
            match store.matrix_room_lookup(binding.matrix_room_id()) {
                Ok(value) => value,
                Err(error) => return response(503, json!({ "error": error.code() })),
            }
        };
        let mut seed_events = Vec::with_capacity(page.state().len());
        for event in page.state() {
            match observed_backfill_state_event(binding.matrix_room_id(), event) {
                Ok(value) => seed_events.push(value),
                Err(error) => return history_partial_response(error.code()),
            }
        }
        let mut timeline_events = Vec::with_capacity(page.chunk().len());
        for event in page.chunk() {
            match observed_backfill_timeline_event(binding.matrix_room_id(), event) {
                Ok(value) => timeline_events.push(value),
                Err(error) => return history_partial_response(error.code()),
            }
        }
        let checkpoint_digest =
            format!("sha256:{}", canonical::sha256_hex(page.start().as_bytes()));
        let (routed, mut descriptors) = match normalize_backfill_events(
            &seed_events,
            &timeline_events,
            binding.matrix_room_id(),
            room_lookup,
            &binding,
            &checkpoint_digest,
            utc_now(),
        ) {
            Ok(value) => value,
            Err(error) => return history_partial_response(error.code()),
        };
        let start_at =
            parse_utc_millis(&request.owner.start_at).expect("validated history start timestamp");
        let end_at =
            parse_utc_millis(&request.owner.end_at).expect("validated history end timestamp");
        let mut routed = routed
            .into_iter()
            .filter(|value| {
                parse_utc_millis(&value.event.occurred_at)
                    .is_some_and(|occurred_at| occurred_at >= start_at && occurred_at < end_at)
            })
            .collect::<Vec<_>>();
        let emitted_attachment_ids = routed
            .iter()
            .filter_map(|value| match &value.event().payload {
                crate::model::CanonicalPayload::AttachmentObserved(payload) => {
                    Some(payload.attachment_id.as_str())
                }
                _ => None,
            })
            .collect::<std::collections::BTreeSet<_>>();
        descriptors
            .retain(|descriptor| emitted_attachment_ids.contains(descriptor.attachment_id()));
        if let Err(error) = crate::attachments::resolve_media_metadata(
            self.transport.as_ref(),
            &mut routed,
            &mut descriptors,
        )
        .await
        {
            return history_partial_response(error.code());
        }
        if routed.len() > MAX_PAGE_EVENTS as usize {
            return response(502, json!({ "error": HISTORY_PROVIDER_ERROR }));
        }
        let batch_ordinal = {
            let mut store = self.store.lock().await;
            match store.backfill_batch_count(&request.owner.import_id) {
                Ok(value) => value,
                Err(error) => return response(503, json!({ "error": error.code() })),
            }
        };
        let checkpoint = match BackfillCheckpoint::new(
            stored.job().job_id(),
            stored.job().room_id(),
            stored.job().start_at(),
            stored.job().end_at(),
            stored.job().max_events(),
            batch_ordinal,
        ) {
            Ok(value) => value,
            Err(_) => return response(503, json!({ "error": HISTORY_PROVIDER_ERROR })),
        };
        let window =
            match batch::build_window(WindowSource::backfill(checkpoint), utc_now(), &routed) {
                Ok(window) => window,
                Err(_) => return response(503, json!({ "error": HISTORY_PROVIDER_ERROR })),
            };
        if window.quarantined_count() != 0 {
            return response(503, json!({ "error": HISTORY_PROVIDER_ERROR }));
        }
        // Return the exact ordering that was checkpointed. The initial
        // projection order can differ from the deterministic batch order;
        // replaying from the stored batch must therefore produce identical
        // event bytes after a lost response.
        let events = match window
            .batches
            .iter()
            .flat_map(|batch| batch.events.iter())
            .map(serde_json::to_value)
            .collect::<Result<Vec<_>, _>>()
        {
            Ok(value) => value,
            Err(_) => return history_partial_response(HISTORY_PROVIDER_ERROR),
        };
        let accepted_events = match stored
            .accepted_events()
            .checked_add(u64::try_from(routed.len()).unwrap_or(u64::MAX))
        {
            Some(value) if value <= stored.job().max_events() => value,
            _ => return response(502, json!({ "error": HISTORY_PROVIDER_ERROR })),
        };
        let now = utc_now();
        let mut next_cursor = None;
        {
            let mut store = self.store.lock().await;
            let source_cursor = page.end().unwrap_or_else(|| page.start());
            let public_cursor = match store.history_cursor_token(
                &request.owner.import_id,
                &request.range_id,
                source_cursor,
            ) {
                Ok(value) => value,
                Err(error) => return response(503, json!({ "error": error.code() })),
            };
            if page.end().is_some() {
                next_cursor = Some(public_cursor.clone());
            }
            let value = HistoryPagination {
                schema_version: 1,
                range_id: request.range_id.clone(),
                input_cursor: request.source_cursor.clone(),
                source_cursor: source_cursor.to_owned(),
                public_cursor,
                page_start: batch_ordinal,
                page_length: u64::try_from(window.batches.len()).unwrap_or(u64::MAX),
                history_terminal: page.end().is_none(),
            };
            let pagination = match serde_json::to_vec(&value) {
                Ok(value) => Some(SecretBytes::new(value)),
                Err(_) => return response(503, json!({ "error": HISTORY_PROVIDER_ERROR })),
            };
            for descriptor in &descriptors {
                let fields = descriptor.lookup_fields();
                let payload = match descriptor.to_json() {
                    Ok(value) => value,
                    Err(_) => return response(503, json!({ "error": HISTORY_PROVIDER_ERROR })),
                };
                if let Err(error) = store.upsert_attachment_descriptor(&fields, &payload) {
                    return response(503, json!({ "error": error.code() }));
                }
            }
            if let Err(error) = store.checkpoint_backfill_page(
                &request.owner.import_id,
                pagination.as_ref(),
                &window,
                accepted_events,
            ) {
                return response(503, json!({ "error": error.code() }));
            }
            if page.end().is_none()
                && let Err(error) = store.complete_backfill_job(&request.owner.import_id, now)
                && error.code() != STORE_BACKFILL_NOT_READY
            {
                return response(503, json!({ "error": error.code() }));
            }
        }

        let completed = page.end().is_none();
        response(
            200,
            json!({
                "status": if completed { "completed" } else { "active" },
                "events": events,
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
            attachments: AttachmentGateway::new(
                Arc::clone(&self.store),
                Arc::clone(&self.transport),
            ),
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

fn history_partial_response(reason_code: &str) -> (u16, Vec<u8>) {
    response(
        200,
        json!({
            "status": "partial",
            "events": [],
            "next_cursor": Value::Null,
            "gap_code": reason_code,
            "error_code": HISTORY_PROVIDER_ERROR,
        }),
    )
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
        sync::atomic::{AtomicU64, AtomicUsize, Ordering},
    };

    use async_trait::async_trait;
    use chrono::TimeZone;
    use ruma::{events::AnyTimelineEvent, serde::Raw};
    use tempfile::tempdir;

    use super::*;
    use crate::{
        crypto::Keyring,
        matrix::{FetchedMatrixMedia, FetchedMatrixSync, MatrixMediaDescriptor, RawBackfillPage},
        provisioning::HttpRequest,
        registry::NewRoomBinding,
    };

    struct ControlledHistoryTransport {
        calls: AtomicUsize,
        nonempty: bool,
        encrypted: bool,
    }

    const HISTORY_MEDIA_BYTES: &[u8] = b"history media bytes";

    struct AttachmentHistoryTransport {
        calls: AtomicUsize,
        media_calls: AtomicUsize,
        requested_limit: AtomicU64,
        attachment_messages: usize,
        force_terminal_empty: bool,
        unavailable: bool,
    }

    #[async_trait]
    impl MatrixTransport for ControlledHistoryTransport {
        async fn fetch_sync(&self, _since: &SecretBytes) -> Result<FetchedMatrixSync, SafeError> {
            Err(SafeError::new(HISTORY_PROVIDER_ERROR))
        }

        async fn backfill_page(
            &self,
            _room_id: &str,
            from: Option<&SecretBytes>,
            _limit: u64,
        ) -> Result<RawBackfillPage, SafeError> {
            let call = self.calls.fetch_add(1, Ordering::SeqCst);
            let start = from
                .map(|value| String::from_utf8(value.as_bytes().to_vec()).expect("cursor UTF-8"))
                .unwrap_or_else(|| format!("matrix-start-{call}"));
            let chunk = if self.nonempty && call == 0 {
                vec![
                    Raw::<AnyTimelineEvent>::from_json_string(
                        json!({
                            "event_id": "$history-message:example.test",
                            "origin_server_ts": 1_767_225_600_000_i64,
                            "sender": "@owner:example.test",
                            "type": if self.encrypted { "m.room.encrypted" } else { "m.room.message" },
                            "room_id": "!history:example.test",
                            "content": if self.encrypted {
                                json!({"algorithm": "m.megolm.v1.aes-sha2", "ciphertext": "redacted"})
                            } else {
                                json!({"msgtype": "m.text", "body": "historical message"})
                            }
                        })
                        .to_string(),
                    )
                    .expect("history raw event"),
                ]
            } else {
                Vec::new()
            };
            RawBackfillPage::new(
                start,
                (call == 0).then_some("matrix-end-1".to_owned()),
                chunk,
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

    #[async_trait]
    impl MatrixTransport for AttachmentHistoryTransport {
        async fn fetch_sync(&self, _since: &SecretBytes) -> Result<FetchedMatrixSync, SafeError> {
            Err(SafeError::new(HISTORY_PROVIDER_ERROR))
        }

        async fn backfill_page(
            &self,
            _room_id: &str,
            from: Option<&SecretBytes>,
            limit: u64,
        ) -> Result<RawBackfillPage, SafeError> {
            self.requested_limit.store(limit, Ordering::SeqCst);
            let _call = self.calls.fetch_add(1, Ordering::SeqCst);
            let offset = from
                .map(|value| {
                    let value = String::from_utf8(value.as_bytes().to_vec()).expect("cursor UTF-8");
                    value
                        .strip_prefix("matrix-attachment-offset-")
                        .and_then(|value| value.parse::<usize>().ok())
                        .expect("attachment cursor offset")
                })
                .unwrap_or(0);
            let limit = usize::try_from(limit).expect("bounded page limit");
            let end_offset = offset.saturating_add(limit).min(self.attachment_messages);
            let mut chunk = Vec::with_capacity(end_offset.saturating_sub(offset) + 1);
            for index in offset..end_offset {
                chunk.push(
                    Raw::<AnyTimelineEvent>::from_json_string(
                        json!({
                            "event_id": format!("$history-attachment-{index}:example.test"),
                            "origin_server_ts": 1_767_225_600_000_i64 + (index as i64 * 1_000),
                            "sender": "@owner:example.test",
                            "type": "m.room.message",
                            "room_id": "!history:example.test",
                            "content": {
                                "msgtype": "m.image",
                                "body": format!("photo-{index}.png"),
                                "url": "mxc://matrix.example/media123",
                                "info": {
                                    "mimetype": "image/png",
                                    "size": HISTORY_MEDIA_BYTES.len(),
                                }
                            }
                        })
                        .to_string(),
                    )
                    .expect("history attachment raw event"),
                );
            }
            if offset == 0 {
                chunk.push(
                    Raw::<AnyTimelineEvent>::from_json_string(
                        json!({
                            "event_id": "$history-ordinary:example.test",
                            "origin_server_ts": 1_767_225_601_000_i64,
                            "sender": "@owner:example.test",
                            "type": "m.room.message",
                            "room_id": "!history:example.test",
                            "content": {"msgtype": "m.text", "body": "ordinary history message"}
                        })
                        .to_string(),
                    )
                    .expect("history ordinary raw event"),
                );
            }
            let has_more = end_offset < self.attachment_messages;
            let terminal_empty = self.force_terminal_empty && !has_more && offset < end_offset;
            let end = (has_more || terminal_empty)
                .then(|| format!("matrix-attachment-offset-{end_offset}"));
            let start = format!("matrix-attachment-offset-{offset}");
            RawBackfillPage::new(start, end, chunk, Vec::new())
        }

        async fn fetch_media(
            &self,
            descriptor: &MatrixMediaDescriptor,
        ) -> Result<FetchedMatrixMedia, SafeError> {
            self.media_calls.fetch_add(1, Ordering::SeqCst);
            assert_eq!(descriptor.server_name, "matrix.example");
            assert_eq!(descriptor.media_id, "media123");
            if self.unavailable {
                Err(SafeError::new(crate::matrix::MATRIX_MEDIA_MISSING))
            } else {
                FetchedMatrixMedia::new(HISTORY_MEDIA_BYTES.to_vec(), "image/png".to_owned())
            }
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

    async fn server(
        nonempty: bool,
        encrypted: bool,
    ) -> (
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
            nonempty,
            encrypted,
        });
        let server = HistoryGatewayServer::new(
            store,
            Arc::clone(&transport) as Arc<dyn MatrixTransport>,
            "history-gateway-secret",
        )
        .expect("history server");
        (server, transport, directory)
    }

    async fn server_with_transport(
        transport: Arc<dyn MatrixTransport>,
    ) -> (HistoryGatewayServer, tempfile::TempDir) {
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
        let server = HistoryGatewayServer::new(store, transport, "history-gateway-secret")
            .expect("history server");
        (server, directory)
    }

    fn attachment_read_request(
        event: &Value,
        media_key: &str,
        expected_sha256: Option<&str>,
    ) -> HttpRequest {
        let payload = &event["payload"];
        let body = json!({
            "tenant_id": "tenant_demo",
            "account_id": "account_demo",
            "connection_id": "connection_demo",
            "identity_id": "identity_demo",
            "conversation_id": "conversation_demo",
            "message_id": payload["message_id"],
            "attachment_id": payload["attachment_id"],
            "revision": event["event_id"],
            "provider": "whatsapp",
            "media_key": media_key,
            "expected_size_bytes": payload["size_bytes"],
            "expected_sha256": expected_sha256,
            "expected_mime_type": payload["mime_type"],
        });
        HttpRequest {
            path: "/v1/attachments/read".to_owned(),
            authorization: Some("history-gateway-secret".to_owned()),
            request_id: Some("attachment-read-request".to_owned()),
            idempotency_key: Some("attachment-read-idempotency".to_owned()),
            body: serde_json::to_vec(&body).expect("attachment request JSON"),
        }
    }

    #[tokio::test]
    async fn authenticated_page_checkpoints_and_start_replays_cursor() {
        let (server, transport, _directory) = server(false, false).await;
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

        let terminal_retry = server
            .handle_request(request(
                "/v1/history-imports/advance",
                &owner,
                Some(public_cursor),
            ))
            .await;
        assert_eq!(terminal_retry.0, 200);
        let terminal_retry: Value =
            serde_json::from_slice(&terminal_retry.1).expect("terminal retry JSON");
        assert_eq!(terminal_retry["status"], "completed");
        assert_eq!(terminal_retry["events"].as_array().map(Vec::len), Some(0));
        assert_eq!(terminal_retry["next_cursor"], Value::Null);
        assert_eq!(transport.calls.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn nonempty_page_normalizes_backfill_events_and_replays_without_refetch() {
        let (server, transport, _directory) = server(true, false).await;
        let owner = owner();
        let started = server
            .handle_request(request("/v1/history-imports/start", &owner, None))
            .await;
        assert_eq!(started.0, 200, "{}", String::from_utf8_lossy(&started.1));

        let first = server
            .handle_request(request("/v1/history-imports/advance", &owner, None))
            .await;
        assert_eq!(first.0, 200, "{}", String::from_utf8_lossy(&first.1));
        let first: Value = serde_json::from_slice(&first.1).expect("advance JSON");
        assert_eq!(first["status"], "active");
        assert_eq!(first["events"].as_array().map(Vec::len), Some(1));
        assert_eq!(first["events"][0]["event_source"], "backfill");
        assert_eq!(first["events"][0]["payload"]["body"], "historical message");
        let public_cursor = first["next_cursor"].as_str().expect("opaque cursor");
        assert_eq!(transport.calls.load(Ordering::SeqCst), 1);

        let retry = server
            .handle_request(request("/v1/history-imports/advance", &owner, None))
            .await;
        assert_eq!(retry.0, 200, "{}", String::from_utf8_lossy(&retry.1));
        let retry: Value = serde_json::from_slice(&retry.1).expect("retry JSON");
        assert_eq!(retry["events"], first["events"]);
        assert_eq!(retry["next_cursor"], public_cursor);
        assert_eq!(transport.calls.load(Ordering::SeqCst), 1);

        let second = server
            .handle_request(request(
                "/v1/history-imports/advance",
                &owner,
                Some(public_cursor),
            ))
            .await;
        assert_eq!(second.0, 200, "{}", String::from_utf8_lossy(&second.1));
        let second: Value = serde_json::from_slice(&second.1).expect("terminal JSON");
        assert_eq!(second["status"], "completed");
        assert_eq!(second["events"].as_array().map(Vec::len), Some(0));
        assert_eq!(second["next_cursor"], Value::Null);
        assert_eq!(transport.calls.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn normal_history_ingestion_emits_raw_and_verified_attachment_revisions() {
        let transport = Arc::new(AttachmentHistoryTransport {
            calls: AtomicUsize::new(0),
            media_calls: AtomicUsize::new(0),
            requested_limit: AtomicU64::new(0),
            attachment_messages: 1,
            force_terminal_empty: true,
            unavailable: false,
        });
        let (server, _directory) =
            server_with_transport(Arc::clone(&transport) as Arc<dyn MatrixTransport>).await;
        let owner = owner();
        let started = server
            .handle_request(request("/v1/history-imports/start", &owner, None))
            .await;
        assert_eq!(started.0, 200, "{}", String::from_utf8_lossy(&started.1));

        let first = server
            .handle_request(request("/v1/history-imports/advance", &owner, None))
            .await;
        assert_eq!(first.0, 200, "{}", String::from_utf8_lossy(&first.1));
        let first: Value = serde_json::from_slice(&first.1).expect("attachment advance JSON");
        assert_eq!(first["status"], "active");
        let events = first["events"].as_array().expect("history events");
        assert_eq!(events.len(), 4);
        assert_eq!(transport.requested_limit.load(Ordering::SeqCst), PAGE_LIMIT);
        assert!(
            events
                .iter()
                .any(|event| { event["payload"]["body"] == "ordinary history message" })
        );
        let raw = events
            .iter()
            .find(|event| {
                event["payload"]["attachment_id"].is_string()
                    && event["payload"]["r2_key"].is_null()
            })
            .expect("raw metadata-only attachment event");
        assert!(raw["payload"]["sha256"].is_null());
        let resolved = events
            .iter()
            .find(|event| {
                event["payload"]["attachment_id"].is_string()
                    && event["payload"]["r2_key"].is_string()
            })
            .expect("verified attachment revision");
        assert_eq!(resolved["event_source"], "backfill");
        assert_eq!(resolved["payload"]["mime_type"], "image/png");
        assert_eq!(resolved["payload"]["size_bytes"], HISTORY_MEDIA_BYTES.len());
        let digest = crate::canonical::sha256_hex(HISTORY_MEDIA_BYTES);
        assert_eq!(resolved["payload"]["sha256"], digest);
        assert_eq!(
            resolved["payload"]["r2_key"],
            format!("media/tenant_demo/{digest}")
        );
        assert_ne!(raw["event_id"], resolved["event_id"]);

        let media_key = resolved["payload"]["r2_key"]
            .as_str()
            .expect("resolved media key");
        let read = server
            .handle_request(attachment_read_request(
                resolved,
                media_key,
                resolved["payload"]["sha256"].as_str(),
            ))
            .await;
        assert_eq!(read.0, 200, "{}", String::from_utf8_lossy(&read.1));
        let read: Value = serde_json::from_slice(&read.1).expect("attachment read JSON");
        assert_eq!(read["status"], "available");
        assert_eq!(read["mime_type"], "image/png");
        assert_eq!(read["size_bytes"], HISTORY_MEDIA_BYTES.len());
        assert_eq!(read["sha256"], resolved["payload"]["sha256"]);
        assert_eq!(transport.media_calls.load(Ordering::SeqCst), 2);

        let public_cursor = first["next_cursor"].as_str().expect("history cursor");
        let retry = server
            .handle_request(request("/v1/history-imports/advance", &owner, None))
            .await;
        assert_eq!(retry.0, 200, "{}", String::from_utf8_lossy(&retry.1));
        let retry: Value = serde_json::from_slice(&retry.1).expect("history retry JSON");
        assert_eq!(retry["events"], first["events"]);
        assert_eq!(retry["next_cursor"], public_cursor);
        assert_eq!(transport.media_calls.load(Ordering::SeqCst), 2);

        let second = server
            .handle_request(request(
                "/v1/history-imports/advance",
                &owner,
                Some(public_cursor),
            ))
            .await;
        assert_eq!(second.0, 200, "{}", String::from_utf8_lossy(&second.1));
        let second: Value = serde_json::from_slice(&second.1).expect("terminal JSON");
        assert_eq!(second["status"], "completed");
        assert_eq!(second["events"].as_array().map(Vec::len), Some(0));
        assert_eq!(transport.calls.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn unavailable_attachment_does_not_block_ordinary_history_progress() {
        let transport = Arc::new(AttachmentHistoryTransport {
            calls: AtomicUsize::new(0),
            media_calls: AtomicUsize::new(0),
            requested_limit: AtomicU64::new(0),
            attachment_messages: 1,
            force_terminal_empty: true,
            unavailable: true,
        });
        let (server, _directory) =
            server_with_transport(Arc::clone(&transport) as Arc<dyn MatrixTransport>).await;
        let owner = owner();
        let started = server
            .handle_request(request("/v1/history-imports/start", &owner, None))
            .await;
        assert_eq!(started.0, 200, "{}", String::from_utf8_lossy(&started.1));

        let first = server
            .handle_request(request("/v1/history-imports/advance", &owner, None))
            .await;
        assert_eq!(first.0, 200, "{}", String::from_utf8_lossy(&first.1));
        let first: Value = serde_json::from_slice(&first.1).expect("unavailable advance JSON");
        assert_eq!(first["status"], "active");
        let events = first["events"].as_array().expect("history events");
        assert_eq!(events.len(), 3);
        assert!(
            events
                .iter()
                .any(|event| { event["payload"]["body"] == "ordinary history message" })
        );
        let raw = events
            .iter()
            .find(|event| event["payload"]["attachment_id"].is_string())
            .expect("unavailable raw attachment event");
        assert!(raw["payload"]["r2_key"].is_null());
        assert!(events.iter().all(|event| {
            event["payload"]["r2_key"].is_null() || !event["payload"]["attachment_id"].is_string()
        }));
        assert_eq!(transport.requested_limit.load(Ordering::SeqCst), PAGE_LIMIT);

        // The descriptor is retained for a safe unavailable response, but no
        // verified media key is emitted and no bytes cross the boundary.
        let arbitrary_key = format!("media/tenant_demo/{}", "a".repeat(64));
        let read = server
            .handle_request(attachment_read_request(raw, &arbitrary_key, None))
            .await;
        assert_eq!(read.0, 200, "{}", String::from_utf8_lossy(&read.1));
        let read: Value = serde_json::from_slice(&read.1).expect("unavailable read JSON");
        assert_eq!(read["status"], "unavailable");
        assert_eq!(read["reason"], "missing");
        assert!(read["bytes_base64"].is_null());
        assert_eq!(transport.media_calls.load(Ordering::SeqCst), 2);

        let public_cursor = first["next_cursor"].as_str().expect("history cursor");
        let second = server
            .handle_request(request(
                "/v1/history-imports/advance",
                &owner,
                Some(public_cursor),
            ))
            .await;
        assert_eq!(second.0, 200, "{}", String::from_utf8_lossy(&second.1));
        let second: Value = serde_json::from_slice(&second.1).expect("terminal JSON");
        assert_eq!(second["status"], "completed");
        assert_eq!(second["events"].as_array().map(Vec::len), Some(0));
        assert_eq!(transport.calls.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn attachment_heavy_history_page_stays_within_canonical_event_bound() {
        let transport = Arc::new(AttachmentHistoryTransport {
            calls: AtomicUsize::new(0),
            media_calls: AtomicUsize::new(0),
            requested_limit: AtomicU64::new(0),
            attachment_messages: 167,
            force_terminal_empty: false,
            unavailable: false,
        });
        let (server, _directory) =
            server_with_transport(Arc::clone(&transport) as Arc<dyn MatrixTransport>).await;
        let mut owner = owner();
        owner.max_events = 1_000;
        let started = server
            .handle_request(request("/v1/history-imports/start", &owner, None))
            .await;
        assert_eq!(started.0, 200, "{}", String::from_utf8_lossy(&started.1));

        let first = server
            .handle_request(request("/v1/history-imports/advance", &owner, None))
            .await;
        assert_eq!(first.0, 200, "{}", String::from_utf8_lossy(&first.1));
        let first: Value = serde_json::from_slice(&first.1).expect("heavy advance JSON");
        assert_eq!(first["status"], "active");
        let events = first["events"].as_array().expect("heavy history events");
        assert_eq!(events.len(), 7);
        assert!(events.len() <= MAX_PAGE_EVENTS as usize);
        assert_eq!(transport.requested_limit.load(Ordering::SeqCst), PAGE_LIMIT);
        assert_eq!(PAGE_LIMIT, 2);
        assert_eq!(transport.media_calls.load(Ordering::SeqCst), 2);

        let retry = server
            .handle_request(request("/v1/history-imports/advance", &owner, None))
            .await;
        assert_eq!(retry.0, 200, "{}", String::from_utf8_lossy(&retry.1));
        let retry: Value = serde_json::from_slice(&retry.1).expect("heavy retry JSON");
        assert_eq!(retry["events"], first["events"]);
        assert_eq!(retry["next_cursor"], first["next_cursor"]);
        assert_eq!(transport.calls.load(Ordering::SeqCst), 1);
        assert_eq!(transport.media_calls.load(Ordering::SeqCst), 2);

        let mut collected = events.to_vec();
        let mut public_cursor = first["next_cursor"]
            .as_str()
            .expect("heavy history cursor")
            .to_owned();
        loop {
            let page = server
                .handle_request(request(
                    "/v1/history-imports/advance",
                    &owner,
                    Some(&public_cursor),
                ))
                .await;
            assert_eq!(page.0, 200, "{}", String::from_utf8_lossy(&page.1));
            let page: Value = serde_json::from_slice(&page.1).expect("heavy page JSON");
            let page_events = page["events"].as_array().expect("heavy page events");
            assert!(page_events.len() <= MAX_PAGE_EVENTS as usize);
            collected.extend(page_events.iter().cloned());
            if page["status"] == "completed" {
                assert_eq!(page["next_cursor"], Value::Null);
                break;
            }
            assert_eq!(page["status"], "active");
            public_cursor = page["next_cursor"]
                .as_str()
                .expect("next heavy history cursor")
                .to_owned();
        }
        assert_eq!(collected.len(), 502);
        assert_eq!(
            collected
                .iter()
                .filter(|event| event["payload"]["body"]
                    .as_str()
                    .is_some_and(|body| body.starts_with("photo-")))
                .count(),
            167
        );
        assert_eq!(
            collected
                .iter()
                .filter(|event| {
                    event["payload"]["attachment_id"].is_string()
                        && event["payload"]["r2_key"].is_null()
                })
                .count(),
            167
        );
        assert_eq!(
            collected
                .iter()
                .filter(|event| {
                    event["payload"]["attachment_id"].is_string()
                        && event["payload"]["r2_key"].is_string()
                })
                .count(),
            167
        );
        assert_eq!(transport.media_calls.load(Ordering::SeqCst), 167);
        assert_eq!(transport.calls.load(Ordering::SeqCst), 84);
    }

    #[tokio::test]
    async fn encrypted_page_surfaces_gap_without_checkpointing() {
        let (server, transport, _directory) = server(true, true).await;
        let owner = owner();
        let started = server
            .handle_request(request("/v1/history-imports/start", &owner, None))
            .await;
        assert_eq!(started.0, 200, "{}", String::from_utf8_lossy(&started.1));

        let advance = server
            .handle_request(request("/v1/history-imports/advance", &owner, None))
            .await;
        assert_eq!(advance.0, 200, "{}", String::from_utf8_lossy(&advance.1));
        let advance: Value = serde_json::from_slice(&advance.1).expect("gap JSON");
        assert_eq!(advance["status"], "partial");
        assert_eq!(advance["events"].as_array().map(Vec::len), Some(0));
        assert_eq!(advance["next_cursor"], Value::Null);
        assert_eq!(advance["gap_code"], "matrix_unable_to_decrypt");
        assert_eq!(advance["error_code"], "provider_error");
        assert_eq!(transport.calls.load(Ordering::SeqCst), 1);

        let retry = server
            .handle_request(request("/v1/history-imports/advance", &owner, None))
            .await;
        assert_eq!(retry.0, 200, "{}", String::from_utf8_lossy(&retry.1));
        assert_eq!(transport.calls.load(Ordering::SeqCst), 2);
    }
}
