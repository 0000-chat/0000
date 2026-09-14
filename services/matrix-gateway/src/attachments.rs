//! Private, authority-bound Matrix attachment access.
//!
//! The canonical event carries metadata only. The source MXC descriptor is
//! sealed separately and addressed by the complete owner/message/attachment
//! revision tuple, so an R2 key can never be mistaken for a Matrix media ID.

use std::{fmt, str::FromStr, sync::Arc};

use base64::{Engine as _, engine::general_purpose::STANDARD};
use chrono::{DateTime, Duration, SecondsFormat, Utc};
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};
use tokio::sync::Mutex;

use crate::{
    batch::RoutedEvent,
    matrix::{
        FetchedMatrixMedia, MATRIX_MEDIA_EMPTY, MATRIX_MEDIA_INVALID, MATRIX_MEDIA_MISSING,
        MATRIX_MEDIA_REJECTED, MATRIX_MEDIA_TIMEOUT, MATRIX_MEDIA_TOO_LARGE,
        MATRIX_MEDIA_UNAVAILABLE, MAX_MEDIA_BYTES, MatrixMediaDescriptor, MatrixTransport,
    },
    model::{
        self, CanonicalEventType, CanonicalPayload, Provider, attachment_id, durable_event_id,
        message_id,
    },
    normalize::{MatrixAttachment, MatrixMessage},
    provisioning::response,
    registry::RoomBinding,
    secret::SafeError,
    store::Store,
};

const MAX_ATTACHMENT_REQUEST_BYTES: usize = 64 * 1024;
const MAX_MIME_BYTES: usize = 255;
const UNAVAILABLE_MISSING: &str = "missing";
const UNAVAILABLE_MALFORMED: &str = "malformed";
const UNAVAILABLE_REJECTED: &str = "provider_rejected";
const UNAVAILABLE_TIMEOUT: &str = "provider_timeout";
const UNAVAILABLE_PROVIDER: &str = "provider_unavailable";

/// The protected descriptor stored for one canonical attachment revision.
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct AttachmentDescriptor {
    schema_version: u8,
    tenant_id: String,
    account_id: String,
    connection_id: String,
    identity_id: String,
    conversation_id: String,
    provider: Provider,
    message_id: String,
    attachment_id: String,
    revision: String,
    matrix_room_id: String,
    file_name: Option<String>,
    mime_type: Option<String>,
    size_bytes: Option<u64>,
    /// The hash emitted by the Matrix event when it is a canonical hex hash.
    /// For encrypted files the Matrix ciphertext hash remains private in the
    /// nested descriptor instead.
    sha256: Option<String>,
    media: MatrixMediaDescriptor,
}

impl fmt::Debug for AttachmentDescriptor {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("AttachmentDescriptor([REDACTED])")
    }
}

impl AttachmentDescriptor {
    /// Capture the source descriptor before the normalizer consumes a Matrix
    /// message. The resulting IDs are the same deterministic IDs emitted by
    /// the canonical attachment projection.
    pub(crate) fn from_source(
        binding: &RoomBinding,
        message: &MatrixMessage,
        attachment: &MatrixAttachment,
        ordinal: u32,
    ) -> Result<Option<Self>, SafeError> {
        let Some(media) = attachment.media_descriptor() else {
            return Ok(None);
        };
        let message_id = message_id(binding.matrix_room_id(), message.event_id())
            .map_err(|_| SafeError::new("matrix_attachment_invalid"))?;
        let attachment_id = attachment_id(&message_id, ordinal)
            .map_err(|_| SafeError::new("matrix_attachment_invalid"))?;
        let revision = durable_event_id(
            message.event_id(),
            CanonicalEventType::AttachmentObserved,
            ordinal,
        )
        .map_err(|_| SafeError::new("matrix_attachment_invalid"))?;
        let descriptor = Self {
            schema_version: 1,
            tenant_id: binding.tenant_id().to_owned(),
            account_id: binding.account_id().to_owned(),
            connection_id: binding.connection_id().to_owned(),
            identity_id: binding.identity_id().to_owned(),
            conversation_id: binding.conversation_id().to_owned(),
            provider: binding.platform(),
            message_id,
            attachment_id,
            revision,
            matrix_room_id: binding.matrix_room_id().to_owned(),
            file_name: attachment.file_name().map(str::to_owned),
            mime_type: attachment.mime_type().map(str::to_owned),
            size_bytes: attachment.size_bytes(),
            sha256: attachment.sha256().map(str::to_owned),
            media: media.clone(),
        };
        descriptor.validate()?;
        Ok(Some(descriptor))
    }

    pub(crate) fn validate(&self) -> Result<(), SafeError> {
        if self.schema_version != 1
            || !model::valid_resource_id(&self.tenant_id)
            || !model::valid_resource_id(&self.account_id)
            || !model::valid_resource_id(&self.connection_id)
            || !model::valid_resource_id(&self.identity_id)
            || !model::valid_resource_id(&self.conversation_id)
            || !model::valid_resource_id(&self.message_id)
            || !model::valid_resource_id(&self.attachment_id)
            || !model::valid_resource_id(&self.revision)
            || !model::valid_matrix_room_id(&self.matrix_room_id)
            || self
                .file_name
                .as_deref()
                .is_some_and(|value| value.len() > 255)
            || self
                .mime_type
                .as_deref()
                .is_some_and(|value| !valid_mime(value))
            || self
                .size_bytes
                .is_some_and(|value| value > MAX_MEDIA_BYTES as u64)
            || self
                .sha256
                .as_deref()
                .is_some_and(|value| !valid_hex_hash(value))
            || self.media.server_name.is_empty()
            || self.media.media_id.is_empty()
        {
            return Err(SafeError::new("matrix_attachment_invalid"));
        }
        if let Some(encrypted) = self.media.encrypted.as_ref()
            && (encrypted.algorithm != "A256CTR"
                || encrypted.key.len() != 32
                || encrypted.iv.len() != 16
                || encrypted.ciphertext_sha256.is_empty())
        {
            return Err(SafeError::new("matrix_attachment_invalid"));
        }
        Ok(())
    }

    pub(crate) fn to_json(&self) -> Result<Vec<u8>, SafeError> {
        self.validate()?;
        serde_json::to_vec(self).map_err(|_| SafeError::new("matrix_attachment_invalid"))
    }

    pub(crate) fn from_json(bytes: &[u8]) -> Result<Self, SafeError> {
        let descriptor: Self = serde_json::from_slice(bytes)
            .map_err(|_| SafeError::new("matrix_attachment_invalid"))?;
        descriptor.validate()?;
        Ok(descriptor)
    }

    pub(crate) fn lookup_fields(&self) -> [&str; 9] {
        [
            &self.tenant_id,
            &self.account_id,
            &self.connection_id,
            &self.identity_id,
            &self.conversation_id,
            &self.message_id,
            &self.attachment_id,
            &self.revision,
            self.provider.as_str(),
        ]
    }

    pub(crate) fn attachment_id(&self) -> &str {
        &self.attachment_id
    }

    pub(crate) fn tenant_id(&self) -> &str {
        &self.tenant_id
    }

    pub(crate) fn expected_size_bytes(&self) -> Option<u64> {
        self.size_bytes
    }

    pub(crate) fn expected_mime_type(&self) -> Option<&str> {
        self.mime_type.as_deref()
    }

    fn matches_request(&self, request: &AttachmentReadRequest, media_hash: &str) -> bool {
        self.tenant_id == request.tenant_id
            && self.account_id == request.account_id
            && self.connection_id == request.connection_id
            && self.identity_id == request.identity_id
            && self.conversation_id == request.conversation_id
            && self.provider == request.provider()
            && self.message_id == request.message_id
            && self.attachment_id == request.attachment_id
            && self.revision == request.revision
            && self
                .sha256
                .as_deref()
                .is_none_or(|value| value == media_hash)
    }

    fn plaintext_mime_matches(&self, expected: Option<&str>) -> bool {
        expected.is_none_or(|expected| self.mime_type.as_deref() == Some(expected))
    }

    fn plaintext_size_matches(&self, expected: Option<u64>) -> bool {
        expected.is_none_or(|expected| self.size_bytes == Some(expected))
    }
}

/// Build protected descriptor candidates from one normalized-source message.
pub(crate) fn descriptors_for_message(
    binding: &RoomBinding,
    message: &MatrixMessage,
) -> Result<Vec<AttachmentDescriptor>, SafeError> {
    message
        .attachments()
        .iter()
        .enumerate()
        .map(|(ordinal, attachment)| {
            AttachmentDescriptor::from_source(binding, message, attachment, ordinal as u32)
        })
        .collect::<Result<Vec<_>, _>>()
        .map(|values| values.into_iter().flatten().collect())
}

/// Fetch each source descriptor through the pinned Matrix transport and fill
/// the canonical projection with verified plaintext metadata. This is the
/// ingest seam used by both live sync and explicit history; it ensures the
/// Worker can issue a readable grant even when Matrix supplied no plaintext
/// hash or supplied only an encrypted ciphertext hash.
pub(crate) async fn resolve_media_metadata(
    transport: &dyn MatrixTransport,
    routed: &mut Vec<RoutedEvent>,
    descriptors: &mut [AttachmentDescriptor],
) -> Result<(), SafeError> {
    let mut resolved_events = Vec::with_capacity(descriptors.len());
    for descriptor in descriptors.iter_mut() {
        let Some((gateway_route_id, mut resolved_event)) = routed.iter().find_map(|value| {
            let CanonicalPayload::AttachmentObserved(payload) = &value.event.payload else {
                return None;
            };
            (payload.attachment_id == descriptor.attachment_id)
                .then(|| (value.gateway_route_id().to_owned(), value.event.clone()))
        }) else {
            // The descriptor and canonical projection are created together. A
            // missing projection is an internal consistency failure rather
            // than a provider availability result.
            return Err(SafeError::new(MATRIX_MEDIA_INVALID));
        };

        // A provider-side failure leaves the original metadata-only event in
        // the page. It must not prevent unrelated messages from being
        // checkpointed, and without verified bytes there is no resolved
        // revision or readable media key to grant.
        let fetched = match transport.fetch_media(&descriptor.media).await {
            Ok(value) => value,
            Err(_) => continue,
        };
        let (bytes, mime_type) = fetched.into_parts();
        if !valid_mime(&mime_type)
            || descriptor
                .expected_size_bytes()
                .is_some_and(|expected| expected != bytes.len() as u64)
            || descriptor
                .expected_mime_type()
                .is_some_and(|expected| expected != mime_type)
        {
            continue;
        }
        let digest: [u8; 32] = Sha256::digest(bytes.as_bytes()).into();
        let digest = digest
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        if descriptor
            .sha256
            .as_deref()
            .is_some_and(|expected| expected != digest)
        {
            continue;
        }
        descriptor.size_bytes = Some(bytes.len() as u64);
        descriptor.mime_type = Some(mime_type.clone());
        descriptor.sha256 = Some(digest.clone());
        let media_key = format!("media/{}/{}", descriptor.tenant_id(), digest);
        let resolved_revision = durable_event_id(
            &format!("attachment-resolved-v1:{}", descriptor.revision),
            CanonicalEventType::AttachmentObserved,
            0_u32,
        )
        .map_err(|_| SafeError::new(MATRIX_MEDIA_INVALID))?;
        descriptor.revision = resolved_revision.clone();
        let CanonicalPayload::AttachmentObserved(payload) = &mut resolved_event.payload else {
            return Err(SafeError::new(MATRIX_MEDIA_INVALID));
        };
        if payload
            .sha256
            .as_deref()
            .is_some_and(|expected| expected != digest)
            || payload
                .size_bytes
                .is_some_and(|expected| expected != bytes.len() as u64)
            || payload
                .mime_type
                .as_deref()
                .is_some_and(|expected| expected != mime_type)
        {
            continue;
        }
        resolved_event.event_id = resolved_revision;
        let observed_at = DateTime::parse_from_rfc3339(&resolved_event.observed_at)
            .map_err(|_| SafeError::new(MATRIX_MEDIA_INVALID))?
            .with_timezone(&Utc)
            .checked_add_signed(Duration::milliseconds(1))
            .ok_or_else(|| SafeError::new(MATRIX_MEDIA_INVALID))?;
        resolved_event.observed_at = observed_at.to_rfc3339_opts(SecondsFormat::Millis, true);
        payload.size_bytes = Some(bytes.len() as u64);
        payload.mime_type = Some(mime_type.clone());
        payload.sha256 = Some(digest);
        payload.r2_key = Some(media_key);
        resolved_event
            .validate()
            .map_err(|_| SafeError::new(MATRIX_MEDIA_INVALID))?;
        resolved_events.push(RoutedEvent::new(gateway_route_id, resolved_event));
    }
    routed.extend(resolved_events);
    Ok(())
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct AttachmentReadRequest {
    tenant_id: String,
    account_id: String,
    connection_id: String,
    identity_id: String,
    conversation_id: String,
    message_id: String,
    attachment_id: String,
    revision: String,
    provider: String,
    media_key: String,
    expected_size_bytes: Option<u64>,
    expected_sha256: Option<String>,
    expected_mime_type: Option<String>,
}

impl AttachmentReadRequest {
    fn parse(body: &[u8]) -> Result<Self, SafeError> {
        if body.is_empty() || body.len() > MAX_ATTACHMENT_REQUEST_BYTES {
            return Err(SafeError::new("attachment_malformed"));
        }
        let request: Self =
            serde_json::from_slice(body).map_err(|_| SafeError::new("attachment_malformed"))?;
        request.validate()?;
        Ok(request)
    }

    fn validate(&self) -> Result<(), SafeError> {
        for value in [
            &self.tenant_id,
            &self.account_id,
            &self.connection_id,
            &self.identity_id,
            &self.conversation_id,
            &self.message_id,
            &self.attachment_id,
            &self.revision,
        ] {
            if !model::valid_resource_id(value) {
                return Err(SafeError::new("attachment_malformed"));
            }
        }
        if Provider::from_str(&self.provider).is_err()
            || self
                .expected_size_bytes
                .is_some_and(|value| value > MAX_MEDIA_BYTES as u64)
            || self
                .expected_sha256
                .as_deref()
                .is_some_and(|value| !valid_hex_hash(value))
            || self
                .expected_mime_type
                .as_deref()
                .is_some_and(|value| !valid_mime(value))
        {
            return Err(SafeError::new("attachment_malformed"));
        }
        let (tenant, digest) = parse_media_key(&self.media_key)
            .ok_or_else(|| SafeError::new("attachment_malformed"))?;
        if tenant != self.tenant_id
            || self
                .expected_sha256
                .as_deref()
                .is_some_and(|value| value != digest)
        {
            return Err(SafeError::new("attachment_malformed"));
        }
        Ok(())
    }

    fn provider(&self) -> Provider {
        Provider::from_str(&self.provider).expect("validated provider")
    }
}

/// Authenticated attachment boundary shared by the private history listener.
#[derive(Clone)]
pub(crate) struct AttachmentGateway {
    store: Arc<Mutex<Store>>,
    transport: Arc<dyn MatrixTransport>,
}

impl fmt::Debug for AttachmentGateway {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("AttachmentGateway([REDACTED])")
    }
}

impl AttachmentGateway {
    pub(crate) fn new(store: Arc<Mutex<Store>>, transport: Arc<dyn MatrixTransport>) -> Self {
        Self { store, transport }
    }

    pub(crate) async fn handle_request(&self, body: Vec<u8>) -> (u16, Vec<u8>) {
        let request = match AttachmentReadRequest::parse(&body) {
            Ok(request) => request,
            Err(_) => return response(400, json!({ "error": "attachment_malformed" })),
        };
        let (_, media_hash) = parse_media_key(&request.media_key)
            .expect("media key validated before attachment handler");
        let authority = match self.active_binding(&request).await {
            Ok(Some(binding)) => binding,
            Ok(None) => return response(403, json!({ "error": "attachment_forbidden" })),
            Err(error) => return response(503, json!({ "error": error.code() })),
        };
        let descriptor = match self.load_descriptor(&request).await {
            Ok(Some(descriptor)) => descriptor,
            Ok(None) => return unavailable(UNAVAILABLE_MISSING),
            Err(_) => return unavailable(UNAVAILABLE_MALFORMED),
        };
        if descriptor.matrix_room_id != authority.matrix_room_id()
            || !descriptor.matches_request(&request, media_hash)
            || !descriptor.plaintext_mime_matches(request.expected_mime_type.as_deref())
            || !descriptor.plaintext_size_matches(request.expected_size_bytes)
        {
            return unavailable(UNAVAILABLE_MISSING);
        }

        let fetched = match self.transport.fetch_media(&descriptor.media).await {
            Ok(value) => value,
            Err(error) => return unavailable(reason_for_media_error(error.code())),
        };

        // Recheck the room authority and the exact sealed descriptor before
        // any bytes cross the response boundary.
        let authority_after = match self.active_binding(&request).await {
            Ok(Some(binding)) => binding,
            Ok(None) => return response(403, json!({ "error": "attachment_forbidden" })),
            Err(error) => return response(503, json!({ "error": error.code() })),
        };
        let descriptor_after = match self.load_descriptor(&request).await {
            Ok(Some(value)) => value,
            Ok(None) => return unavailable(UNAVAILABLE_MISSING),
            Err(_) => return unavailable(UNAVAILABLE_MALFORMED),
        };
        if descriptor_after.matrix_room_id != authority_after.matrix_room_id()
            || descriptor_after.media != descriptor.media
            || !descriptor_after.matches_request(&request, media_hash)
        {
            return unavailable(UNAVAILABLE_MISSING);
        }
        release_checked(fetched, &request, media_hash, &descriptor_after)
    }

    async fn active_binding(
        &self,
        request: &AttachmentReadRequest,
    ) -> Result<Option<RoomBinding>, SafeError> {
        let store = self.store.lock().await;
        let binding = store.active_room_binding_for_history(
            &request.tenant_id,
            &request.account_id,
            &request.connection_id,
            &request.identity_id,
            request.provider(),
        )?;
        Ok(binding.filter(|binding| binding.conversation_id() == request.conversation_id))
    }

    async fn load_descriptor(
        &self,
        request: &AttachmentReadRequest,
    ) -> Result<Option<AttachmentDescriptor>, SafeError> {
        let provider = request.provider();
        let fields = [
            request.tenant_id.as_str(),
            request.account_id.as_str(),
            request.connection_id.as_str(),
            request.identity_id.as_str(),
            request.conversation_id.as_str(),
            request.message_id.as_str(),
            request.attachment_id.as_str(),
            request.revision.as_str(),
            provider.as_str(),
        ];
        let store = self.store.lock().await;
        let Some(payload) = store.load_attachment_descriptor(&fields)? else {
            return Ok(None);
        };
        AttachmentDescriptor::from_json(payload.as_bytes()).map(Some)
    }
}

fn release_checked(
    fetched: FetchedMatrixMedia,
    request: &AttachmentReadRequest,
    media_hash: &str,
    descriptor: &AttachmentDescriptor,
) -> (u16, Vec<u8>) {
    let (bytes, mime_type) = fetched.into_parts();
    if bytes.len() > MAX_MEDIA_BYTES
        || request
            .expected_size_bytes
            .is_some_and(|expected| expected != bytes.len() as u64)
        || descriptor
            .mime_type
            .as_deref()
            .is_some_and(|expected| expected != mime_type)
        || request
            .expected_mime_type
            .as_deref()
            .is_some_and(|expected| expected != mime_type)
    {
        return unavailable(UNAVAILABLE_MALFORMED);
    }
    let digest = Sha256::digest(bytes.as_bytes());
    let digest = digest
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    if digest != media_hash
        || request
            .expected_sha256
            .as_deref()
            .is_some_and(|expected| expected != digest)
    {
        return unavailable(UNAVAILABLE_MALFORMED);
    }
    let encoded = STANDARD.encode(bytes.as_bytes());
    response(
        200,
        json!({
            "status": "available",
            "bytes_base64": encoded,
            "mime_type": mime_type,
            "sha256": digest,
            "size_bytes": bytes.len(),
        }),
    )
}

fn parse_media_key(value: &str) -> Option<(&str, &str)> {
    let mut parts = value.split('/');
    let prefix = parts.next()?;
    let tenant = parts.next()?;
    let digest = parts.next()?;
    if prefix != "media"
        || parts.next().is_some()
        || !model::valid_resource_id(tenant)
        || !valid_hex_hash(digest)
    {
        return None;
    }
    Some((tenant, digest))
}

fn valid_hex_hash(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
}

fn valid_mime(value: &str) -> bool {
    if value.is_empty() || value.len() > MAX_MIME_BYTES || !value.is_ascii() {
        return false;
    }
    let (media_type, parameters) = value
        .split_once(';')
        .map_or((value, None), |(base, rest)| (base, Some(rest)));
    let mut types = media_type.split('/');
    let Some(kind) = types.next() else {
        return false;
    };
    let Some(subtype) = types.next() else {
        return false;
    };
    if types.next().is_some()
        || kind.is_empty()
        || subtype.is_empty()
        || !kind.bytes().all(valid_mime_token_byte)
        || !subtype.bytes().all(valid_mime_token_byte)
    {
        return false;
    }
    parameters.is_none_or(|value| {
        !value.is_empty() && value.bytes().all(|byte| (0x20..=0x7e).contains(&byte))
    })
}

fn valid_mime_token_byte(byte: u8) -> bool {
    byte.is_ascii_alphanumeric()
        || matches!(
            byte,
            b'!' | b'#' | b'$' | b'&' | b'^' | b'.' | b'+' | b'-' | b'_'
        )
}

fn reason_for_media_error(code: &str) -> &'static str {
    match code {
        MATRIX_MEDIA_MISSING => UNAVAILABLE_MISSING,
        MATRIX_MEDIA_REJECTED => UNAVAILABLE_REJECTED,
        MATRIX_MEDIA_TIMEOUT => UNAVAILABLE_TIMEOUT,
        MATRIX_MEDIA_INVALID | MATRIX_MEDIA_EMPTY | MATRIX_MEDIA_TOO_LARGE => UNAVAILABLE_MALFORMED,
        MATRIX_MEDIA_UNAVAILABLE => UNAVAILABLE_PROVIDER,
        _ => UNAVAILABLE_PROVIDER,
    }
}

fn unavailable(reason: &str) -> (u16, Vec<u8>) {
    response(
        200,
        json!({
            "status": "unavailable",
            "reason": reason,
        }),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::batch::RoutedEvent;
    use crate::crypto::Keyring;
    use crate::crypto_outbox::{PendingMatrixRequest, RawMatrixResponse};
    use crate::matrix::{FetchedMatrixSync, MatrixMediaDescriptor};
    use crate::model::{
        AttachmentObservedPayload, CanonicalEvent, CanonicalEventSource, CanonicalPayload,
    };
    use crate::secret::SecretBytes;
    use async_trait::async_trait;
    use std::{fs, os::unix::fs::PermissionsExt};
    use tempfile::tempdir;

    struct ResolutionTransport {
        bytes: Vec<u8>,
        mime_type: String,
    }

    #[async_trait]
    impl MatrixTransport for ResolutionTransport {
        async fn fetch_sync(&self, _since: &SecretBytes) -> Result<FetchedMatrixSync, SafeError> {
            Err(SafeError::new("resolution_test_unexpected_sync"))
        }

        async fn fetch_media(
            &self,
            _descriptor: &MatrixMediaDescriptor,
        ) -> Result<FetchedMatrixMedia, SafeError> {
            FetchedMatrixMedia::new(self.bytes.clone(), self.mime_type.clone())
        }

        async fn send_crypto(
            &self,
            _request: &PendingMatrixRequest,
        ) -> Result<RawMatrixResponse, SafeError> {
            Err(SafeError::new("resolution_test_unexpected_crypto"))
        }
    }

    #[test]
    fn media_key_requires_tenant_scoped_content_hash() {
        let digest = "a".repeat(64);
        assert_eq!(
            parse_media_key(&format!("media/tenant_demo/{digest}")),
            Some(("tenant_demo", digest.as_str()))
        );
        assert!(parse_media_key("https://upstream.invalid/media").is_none());
        assert!(parse_media_key("media/tenant_demo/ABC").is_none());
    }

    #[test]
    fn request_rejects_hash_and_media_key_mismatch() {
        let digest = "a".repeat(64);
        let body = serde_json::to_vec(&serde_json::json!({
            "tenant_id": "tenant_demo",
            "account_id": "account_demo",
            "connection_id": "connection_demo",
            "identity_id": "identity_demo",
            "conversation_id": "conversation_demo",
            "message_id": "message_demo",
            "attachment_id": "attachment_demo",
            "revision": "evt_demo",
            "provider": "whatsapp",
            "media_key": format!("media/tenant_demo/{digest}"),
            "expected_sha256": "b".repeat(64),
        }))
        .expect("request JSON");
        assert_eq!(
            AttachmentReadRequest::parse(&body).unwrap_err().code(),
            "attachment_malformed"
        );
    }

    #[test]
    fn sealed_descriptor_lookup_requires_the_complete_revision_tuple() {
        let directory = tempdir().expect("descriptor tempdir");
        fs::set_permissions(directory.path(), fs::Permissions::from_mode(0o700))
            .expect("descriptor directory permissions");
        let path = directory.path().join("gateway.sqlite3");
        let mut store = Store::open(&path, Keyring::new([0x42; 32], 1).expect("keyring"))
            .expect("descriptor store");
        let fields = [
            "tenant_demo",
            "account_demo",
            "connection_demo",
            "identity_demo",
            "conversation_demo",
            "message_demo",
            "attachment_demo",
            "evt_demo",
            "whatsapp",
        ];
        store
            .upsert_attachment_descriptor(&fields, br#"{"schema_version":1}"#)
            .expect("persist descriptor");
        assert!(
            store
                .load_attachment_descriptor(&fields)
                .expect("load descriptor")
                .is_some()
        );

        let mut wrong_message = fields;
        wrong_message[5] = "message_other";
        assert!(
            store
                .load_attachment_descriptor(&wrong_message)
                .expect("wrong message lookup")
                .is_none()
        );
        let mut wrong_revision = fields;
        wrong_revision[7] = "evt_other";
        assert!(
            store
                .load_attachment_descriptor(&wrong_revision)
                .expect("wrong revision lookup")
                .is_none()
        );
    }

    #[tokio::test]
    async fn resolution_fills_plaintext_hash_key_and_missing_size_mime() {
        let bytes = b"ingest resolution fixture".to_vec();
        let descriptor = AttachmentDescriptor {
            schema_version: 1,
            tenant_id: "tenant_demo".to_owned(),
            account_id: "account_demo".to_owned(),
            connection_id: "connection_demo".to_owned(),
            identity_id: "identity_demo".to_owned(),
            conversation_id: "conversation_demo".to_owned(),
            provider: Provider::Whatsapp,
            message_id: "message_demo".to_owned(),
            attachment_id: "attachment_demo".to_owned(),
            revision: "evt_revision".to_owned(),
            matrix_room_id: "!room:example.test".to_owned(),
            file_name: None,
            mime_type: None,
            size_bytes: None,
            sha256: None,
            media: MatrixMediaDescriptor {
                server_name: "matrix.example".to_owned(),
                media_id: "media123".to_owned(),
                mime_type: None,
                source_sha256: None,
                encrypted: None,
            },
        };
        descriptor.validate().expect("fixture descriptor");
        let event = CanonicalEvent::new(
            "evt_attachment",
            CanonicalEventSource::Live,
            "tenant_demo",
            "identity_demo",
            Provider::Whatsapp,
            "account_demo",
            "conversation_demo",
            Some("!room:example.test".to_owned()),
            Some("$source:example.test".to_owned()),
            None,
            "2026-01-01T00:00:00.000Z",
            "2026-01-01T00:00:00.000Z",
            CanonicalPayload::AttachmentObserved(AttachmentObservedPayload {
                attachment_id: "attachment_demo".to_owned(),
                message_id: "message_demo".to_owned(),
                file_name: None,
                mime_type: None,
                size_bytes: None,
                sha256: None,
                r2_key: None,
            }),
        )
        .expect("canonical fixture event");
        let mut routed = vec![RoutedEvent::new("route_demo", event)];
        let transport = ResolutionTransport {
            bytes: bytes.clone(),
            mime_type: "image/png".to_owned(),
        };
        let mut descriptors = vec![descriptor];
        resolve_media_metadata(&transport, &mut routed, &mut descriptors)
            .await
            .expect("resolution succeeds");
        assert_eq!(descriptors[0].size_bytes, Some(bytes.len() as u64));
        assert_eq!(descriptors[0].mime_type.as_deref(), Some("image/png"));
        let CanonicalPayload::AttachmentObserved(raw_payload) = &routed[0].event.payload else {
            panic!("raw attachment payload expected");
        };
        assert!(raw_payload.sha256.is_none());
        assert!(raw_payload.r2_key.is_none());
        let CanonicalPayload::AttachmentObserved(payload) = &routed[1].event.payload else {
            panic!("resolved attachment payload expected");
        };
        let digest = crate::canonical::sha256_hex(&bytes);
        assert_eq!(payload.mime_type.as_deref(), Some("image/png"));
        assert_eq!(payload.size_bytes, Some(bytes.len() as u64));
        assert_eq!(payload.sha256.as_deref(), Some(digest.as_str()));
        let expected_media_key = format!("media/tenant_demo/{digest}");
        assert_eq!(payload.r2_key.as_deref(), Some(expected_media_key.as_str()));
        assert_eq!(routed[1].event.event_id, descriptors[0].revision);
        assert!(routed[1].event.observed_at > routed[0].event.observed_at);
    }
}
