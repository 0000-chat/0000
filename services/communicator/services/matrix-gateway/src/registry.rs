//! Protected Matrix-room ownership registry models.
//!
//! The registry keeps the mapping between a Matrix room and its Communicator
//! authority in an encrypted store.  These types deliberately expose no
//! secret-bearing formatting and reduce all invalid input to one stable error
//! code.

use std::fmt;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use crate::{
    crypto::Keyring,
    model::{self, Provider},
    secret::SafeError,
};

/// Stable error returned when a room binding is malformed.
pub const REGISTRY_INVALID_BINDING: &str = "registry_invalid_binding";
/// Stable error returned when a deterministic registry lookup cannot be made.
pub const REGISTRY_LOOKUP_FAILED: &str = "registry_lookup_failed";

/// The protected mapping persisted for one room binding.
///
/// `binding_id` and `created_at` are registry metadata and intentionally do
/// not belong to this payload.  The payload shape is kept strict so a
/// decrypted row cannot silently gain or lose mapping fields.
#[derive(Eq, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct RoomBindingPayload {
    schema_version: u8,
    matrix_room_id: String,
    tenant_id: String,
    identity_id: String,
    connection_id: String,
    account_id: String,
    platform: Provider,
    gateway_route_id: String,
    conversation_id: String,
    owner_matrix_user_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    session_generation: Option<String>,
}

/// A newly appended room binding, including non-secret registry metadata.
#[derive(Eq, PartialEq)]
pub struct NewRoomBinding {
    binding_id: String,
    matrix_room_id: String,
    tenant_id: String,
    identity_id: String,
    connection_id: String,
    account_id: String,
    platform: Provider,
    gateway_route_id: String,
    conversation_id: String,
    owner_matrix_user_id: String,
    session_generation: Option<String>,
    created_at: DateTime<Utc>,
}

/// Lifecycle state of a stored room binding.
#[derive(Clone, Copy, Eq, PartialEq)]
pub enum RoomBindingStatus {
    /// The mapping is currently eligible for room resolution.
    Active,
    /// The mapping is retained for history but no longer eligible for use.
    Retired,
}

impl RoomBindingStatus {
    /// Return the exact database representation of this status.
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Active => "active",
            Self::Retired => "retired",
        }
    }

    /// Parse the exact database representation of a lifecycle status.
    pub(crate) fn from_str(value: &str) -> Result<Self, SafeError> {
        match value {
            "active" => Ok(Self::Active),
            "retired" => Ok(Self::Retired),
            _ => Err(invalid_binding()),
        }
    }
}

impl fmt::Debug for RoomBindingStatus {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.as_str())
    }
}

impl fmt::Display for RoomBindingStatus {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.as_str())
    }
}

/// A verified row read from the protected room-binding registry.
pub struct RoomBinding {
    binding_id: String,
    payload: RoomBindingPayload,
    status: RoomBindingStatus,
    created_at: DateTime<Utc>,
    retired_at: Option<DateTime<Utc>>,
}

impl NewRoomBinding {
    /// Construct and validate one new room binding.
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        binding_id: impl Into<String>,
        matrix_room_id: impl Into<String>,
        tenant_id: impl Into<String>,
        identity_id: impl Into<String>,
        connection_id: impl Into<String>,
        account_id: impl Into<String>,
        platform: Provider,
        gateway_route_id: impl Into<String>,
        conversation_id: impl Into<String>,
        owner_matrix_user_id: impl Into<String>,
        created_at: DateTime<Utc>,
    ) -> Result<Self, SafeError> {
        let session_generation = created_at.to_rfc3339();
        Self::new_with_session_generation(
            binding_id,
            matrix_room_id,
            tenant_id,
            identity_id,
            connection_id,
            account_id,
            platform,
            gateway_route_id,
            conversation_id,
            owner_matrix_user_id,
            session_generation,
            created_at,
        )
    }

    /// Construct a binding with the exact current Worker connection
    /// generation. Relink callers supply the new generation here; the value
    /// is sealed with the room authority and is never accepted from an
    /// outbound request as an authority grant.
    #[allow(clippy::too_many_arguments)]
    pub fn new_with_session_generation(
        binding_id: impl Into<String>,
        matrix_room_id: impl Into<String>,
        tenant_id: impl Into<String>,
        identity_id: impl Into<String>,
        connection_id: impl Into<String>,
        account_id: impl Into<String>,
        platform: Provider,
        gateway_route_id: impl Into<String>,
        conversation_id: impl Into<String>,
        owner_matrix_user_id: impl Into<String>,
        session_generation: impl Into<String>,
        created_at: DateTime<Utc>,
    ) -> Result<Self, SafeError> {
        let binding = Self {
            binding_id: binding_id.into(),
            matrix_room_id: matrix_room_id.into(),
            tenant_id: tenant_id.into(),
            identity_id: identity_id.into(),
            connection_id: connection_id.into(),
            account_id: account_id.into(),
            platform,
            gateway_route_id: gateway_route_id.into(),
            conversation_id: conversation_id.into(),
            owner_matrix_user_id: owner_matrix_user_id.into(),
            session_generation: Some(session_generation.into()),
            created_at,
        };
        binding.validate()?;
        Ok(binding)
    }

    /// Validate all identifiers and the creation timestamp.
    pub(crate) fn validate(&self) -> Result<(), SafeError> {
        let created_at = self.created_at.to_rfc3339();
        if !valid_binding_id(&self.binding_id)
            || !model::valid_matrix_room_id(&self.matrix_room_id)
            || !model::valid_resource_id(&self.tenant_id)
            || !model::valid_resource_id(&self.identity_id)
            || !model::valid_resource_id(&self.connection_id)
            || !model::valid_resource_id(&self.account_id)
            || !model::valid_resource_id(&self.gateway_route_id)
            || !model::valid_resource_id(&self.conversation_id)
            || !valid_matrix_user_id(&self.owner_matrix_user_id)
            || !self
                .session_generation
                .as_deref()
                .is_some_and(model::valid_timestamp)
            || !model::valid_timestamp(&created_at)
        {
            return Err(invalid_binding());
        }
        Ok(())
    }

    /// Return the metadata identifier used as the registry row key.
    pub(crate) fn binding_id(&self) -> &str {
        &self.binding_id
    }

    /// Return the Matrix room identifier.
    pub(crate) fn matrix_room_id(&self) -> &str {
        &self.matrix_room_id
    }

    /// Return the tenant authority identifier.
    pub(crate) fn tenant_id(&self) -> &str {
        &self.tenant_id
    }

    /// Return the identity authority identifier.
    pub(crate) fn identity_id(&self) -> &str {
        &self.identity_id
    }

    /// Return the connection authority identifier.
    pub(crate) fn connection_id(&self) -> &str {
        &self.connection_id
    }

    /// Return the provider account identifier.
    pub(crate) fn account_id(&self) -> &str {
        &self.account_id
    }

    /// Return the provider platform.
    pub(crate) fn platform(&self) -> Provider {
        self.platform
    }

    /// Return the gateway routing identifier.
    pub(crate) fn gateway_route_id(&self) -> &str {
        &self.gateway_route_id
    }

    /// Return the conversation identifier.
    pub(crate) fn conversation_id(&self) -> &str {
        &self.conversation_id
    }

    /// Return the Matrix user who owns the portal.
    pub(crate) fn owner_matrix_user_id(&self) -> &str {
        &self.owner_matrix_user_id
    }

    /// Return the UTC creation timestamp.
    pub(crate) fn created_at(&self) -> &DateTime<Utc> {
        &self.created_at
    }

    /// Build the exact protected mapping payload for this binding.
    pub(crate) fn payload(&self) -> RoomBindingPayload {
        RoomBindingPayload {
            schema_version: 1,
            matrix_room_id: self.matrix_room_id.clone(),
            tenant_id: self.tenant_id().to_owned(),
            identity_id: self.identity_id().to_owned(),
            connection_id: self.connection_id().to_owned(),
            account_id: self.account_id.clone(),
            platform: self.platform,
            gateway_route_id: self.gateway_route_id().to_owned(),
            conversation_id: self.conversation_id().to_owned(),
            owner_matrix_user_id: self.owner_matrix_user_id().to_owned(),
            session_generation: self.session_generation.clone(),
        }
    }

    /// Serialize the exact protected mapping payload as compact JSON bytes.
    pub(crate) fn payload_json(&self) -> Result<Vec<u8>, SafeError> {
        self.validate()?;
        serde_json::to_vec(&self.payload()).map_err(|_| invalid_binding())
    }

    /// Return the immutable authority tuple used for account ownership.
    pub(crate) fn authority_tuple(&self) -> (&str, &str, &str, &str, Provider) {
        (
            &self.tenant_id,
            &self.identity_id,
            &self.connection_id,
            &self.account_id,
            self.platform,
        )
    }
}

impl RoomBinding {
    /// Construct one verified stored row from its validated registry parts.
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn new(
        binding_id: impl Into<String>,
        payload: RoomBindingPayload,
        status: RoomBindingStatus,
        created_at: DateTime<Utc>,
        retired_at: Option<DateTime<Utc>>,
    ) -> Result<Self, SafeError> {
        let binding = Self {
            binding_id: binding_id.into(),
            payload,
            status,
            created_at,
            retired_at,
        };
        binding.validate()?;
        Ok(binding)
    }

    /// Construct a row after its database metadata and protected payload have
    /// been independently read and verified.
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn from_verified_parts(
        binding_id: impl Into<String>,
        payload: RoomBindingPayload,
        status: RoomBindingStatus,
        created_at: DateTime<Utc>,
        retired_at: Option<DateTime<Utc>>,
    ) -> Result<Self, SafeError> {
        Self::new(binding_id, payload, status, created_at, retired_at)
    }

    fn validate(&self) -> Result<(), SafeError> {
        if !valid_binding_id(&self.binding_id)
            || !model::valid_timestamp(&self.created_at.to_rfc3339())
            || self.payload.validate().is_err()
        {
            return Err(invalid_binding());
        }

        match (self.status, self.retired_at) {
            (RoomBindingStatus::Active, None) => {}
            (RoomBindingStatus::Retired, Some(retired_at))
                if model::valid_timestamp(&retired_at.to_rfc3339())
                    && retired_at >= self.created_at => {}
            _ => return Err(invalid_binding()),
        }
        Ok(())
    }

    /// Return the synthetic registry row identifier.
    pub fn binding_id(&self) -> &str {
        &self.binding_id
    }

    /// Return the lifecycle state of this row.
    pub const fn status(&self) -> RoomBindingStatus {
        self.status
    }

    /// Return the Matrix room identifier from the protected mapping.
    pub fn matrix_room_id(&self) -> &str {
        &self.payload.matrix_room_id
    }

    /// Return the tenant authority identifier.
    pub fn tenant_id(&self) -> &str {
        &self.payload.tenant_id
    }

    /// Return the identity authority identifier.
    pub fn identity_id(&self) -> &str {
        &self.payload.identity_id
    }

    /// Return the connection authority identifier.
    pub fn connection_id(&self) -> &str {
        &self.payload.connection_id
    }

    /// Return the provider account identifier.
    pub fn account_id(&self) -> &str {
        &self.payload.account_id
    }

    /// Return the provider platform.
    pub fn platform(&self) -> Provider {
        self.payload.platform
    }

    /// Return the gateway routing identifier.
    pub fn gateway_route_id(&self) -> &str {
        &self.payload.gateway_route_id
    }

    /// Return the conversation identifier.
    pub fn conversation_id(&self) -> &str {
        &self.payload.conversation_id
    }

    /// Return the Matrix user who owns the portal.
    pub fn owner_matrix_user_id(&self) -> &str {
        &self.payload.owner_matrix_user_id
    }

    /// Return the server-owned connection/session generation, if this row
    /// predates the generation-bearing registry payload.
    pub fn session_generation(&self) -> Option<&str> {
        self.payload.session_generation.as_deref()
    }

    /// Return the UTC creation timestamp.
    pub fn created_at(&self) -> &DateTime<Utc> {
        &self.created_at
    }

    /// Return the UTC retirement timestamp, if this row is retired.
    pub fn retired_at(&self) -> Option<&DateTime<Utc>> {
        self.retired_at.as_ref()
    }

    /// Borrow the protected mapping for internal persistence operations.
    pub(crate) fn payload(&self) -> &RoomBindingPayload {
        &self.payload
    }

    /// Return the immutable authority tuple used for account ownership.
    pub(crate) fn authority_tuple(&self) -> (&str, &str, &str, &str, Provider) {
        self.payload.authority_tuple()
    }
}

impl fmt::Debug for RoomBinding {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("RoomBinding([REDACTED])")
    }
}

impl fmt::Display for RoomBinding {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("RoomBinding([REDACTED])")
    }
}

impl RoomBindingPayload {
    /// Parse and validate one exact protected payload JSON document.
    pub(crate) fn from_json(input: impl AsRef<[u8]>) -> Result<Self, SafeError> {
        let payload =
            serde_json::from_slice::<Self>(input.as_ref()).map_err(|_| invalid_binding())?;
        payload.validate()?;
        Ok(payload)
    }

    /// Return the immutable authority tuple used for account ownership.
    pub(crate) fn authority_tuple(&self) -> (&str, &str, &str, &str, Provider) {
        (
            &self.tenant_id,
            &self.identity_id,
            &self.connection_id,
            &self.account_id,
            self.platform,
        )
    }

    /// Compare the immutable authority tuple with another payload.
    pub(crate) fn same_authority(&self, other: &Self) -> bool {
        self.authority_tuple() == other.authority_tuple()
    }

    /// Validate a decrypted payload before it is used by the store.
    pub(crate) fn validate(&self) -> Result<(), SafeError> {
        if self.schema_version != 1
            || !model::valid_matrix_room_id(&self.matrix_room_id)
            || !model::valid_resource_id(&self.tenant_id)
            || !model::valid_resource_id(&self.identity_id)
            || !model::valid_resource_id(&self.connection_id)
            || !model::valid_resource_id(&self.account_id)
            || !model::valid_resource_id(&self.gateway_route_id)
            || !model::valid_resource_id(&self.conversation_id)
            || !valid_matrix_user_id(&self.owner_matrix_user_id)
            || self
                .session_generation
                .as_deref()
                .is_some_and(|value| !model::valid_timestamp(value))
        {
            return Err(invalid_binding());
        }
        Ok(())
    }
}

fn invalid_binding() -> SafeError {
    SafeError::new(REGISTRY_INVALID_BINDING)
}

fn lookup_failed() -> SafeError {
    SafeError::new(REGISTRY_LOOKUP_FAILED)
}

/// Derive the keyed lookup for one Matrix room identifier.
pub fn room_lookup(keyring: &Keyring, matrix_room_id: &str) -> Result<[u8; 32], SafeError> {
    if !model::valid_matrix_room_id(matrix_room_id) {
        return Err(lookup_failed());
    }
    keyring
        .lookup_digest("room-binding-room-v1", &[matrix_room_id])
        .map_err(|_| lookup_failed())
}

/// Derive the keyed lookup for one provider account within its platform.
pub fn account_lookup(
    keyring: &Keyring,
    platform: Provider,
    account_id: &str,
) -> Result<[u8; 32], SafeError> {
    if !model::valid_resource_id(account_id) {
        return Err(lookup_failed());
    }
    keyring
        .lookup_digest("room-binding-account-v1", &[platform.as_str(), account_id])
        .map_err(|_| lookup_failed())
}

pub(crate) fn valid_binding_id(value: &str) -> bool {
    const PREFIX: &str = "binding_";
    value.len() == PREFIX.len() + 32
        && value.starts_with(PREFIX)
        && value[PREFIX.len()..]
            .bytes()
            .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
}

fn valid_matrix_user_id(value: &str) -> bool {
    // Keep this equivalent to config's strict text boundary before applying
    // ruma's Matrix user-ID grammar.  The local helper avoids broadening the
    // public configuration API merely to validate a protected mapping.
    !value.is_empty()
        && value.len() <= 4 * 1024
        && value.trim() == value
        && !value
            .chars()
            .any(|character| character == '\0' || character.is_control())
        && ruma::UserId::parse(value).is_ok()
}

impl fmt::Debug for NewRoomBinding {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("NewRoomBinding([REDACTED])")
    }
}

impl fmt::Display for NewRoomBinding {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("NewRoomBinding([REDACTED])")
    }
}

#[cfg(test)]
mod tests {
    use std::{fmt::Write as _, str};

    use chrono::{Duration, TimeZone, Utc};

    use super::*;

    const BINDING_ID: &str = "binding_0123456789abcdef0123456789abcdef";
    const ROOM_ID: &str = "!room:example.test";

    fn created_at() -> DateTime<Utc> {
        Utc.timestamp_millis_opt(1_700_000_000_000)
            .single()
            .expect("valid test timestamp")
    }

    fn new_binding() -> NewRoomBinding {
        NewRoomBinding::new(
            BINDING_ID,
            ROOM_ID,
            "tenant_demo",
            "identity_demo",
            "connection_demo",
            "account_demo",
            Provider::Telegram,
            "route_demo",
            "conversation_demo",
            "@owner:example.test",
            created_at(),
        )
        .expect("valid test binding")
    }

    fn keyring() -> crate::crypto::Keyring {
        crate::crypto::Keyring::new([0x11; 32], 1).expect("valid test keyring")
    }

    #[test]
    fn validates_binding_id_timestamps_and_identifiers() {
        assert!(
            NewRoomBinding::new(
                "binding_0123456789abcdef0123456789abcdeg",
                ROOM_ID,
                "tenant_demo",
                "identity_demo",
                "connection_demo",
                "account_demo",
                Provider::Telegram,
                "route_demo",
                "conversation_demo",
                "@owner:example.test",
                created_at(),
            )
            .is_err()
        );

        assert!(
            NewRoomBinding::new(
                BINDING_ID,
                "not-a-room",
                "tenant_demo",
                "identity_demo",
                "connection_demo",
                "account_demo",
                Provider::Telegram,
                "route_demo",
                "conversation_demo",
                "@owner:example.test",
                created_at(),
            )
            .is_err()
        );

        let out_of_contract_timestamp = Utc
            .timestamp_opt(253_402_300_800, 0)
            .single()
            .expect("chrono supports the test timestamp");
        assert!(
            NewRoomBinding::new(
                BINDING_ID,
                ROOM_ID,
                "tenant_demo",
                "identity_demo",
                "connection_demo",
                "account_demo",
                Provider::Telegram,
                "route_demo",
                "conversation_demo",
                "@owner:example.test",
                out_of_contract_timestamp,
            )
            .is_err()
        );
    }

    #[test]
    fn payload_json_is_strict_and_validated() {
        let binding = new_binding();
        let json = binding.payload_json().expect("serialize payload");
        let payload = RoomBindingPayload::from_json(&json).expect("parse payload");
        assert_eq!(payload.authority_tuple(), binding.authority_tuple());

        let mut unknown = String::from_utf8(json).expect("payload is UTF-8");
        unknown.pop();
        unknown.push_str(",\"unknown\":true}");
        let unknown_error = match RoomBindingPayload::from_json(unknown.as_bytes()) {
            Ok(_) => panic!("unknown payload fields must fail"),
            Err(error) => error,
        };
        assert_eq!(unknown_error.code(), REGISTRY_INVALID_BINDING);

        assert!(RoomBindingPayload::from_json(b"not-json").is_err());
    }

    #[test]
    fn payload_json_revalidates_an_internally_malformed_binding() {
        let mut binding = new_binding();
        binding.tenant_id.clear();

        let error = binding
            .payload_json()
            .expect_err("malformed binding must not serialize");
        assert_eq!(error.code(), REGISTRY_INVALID_BINDING);
    }

    #[test]
    fn lookup_helpers_are_deterministic_and_domain_separated() {
        let ring = keyring();
        let first = room_lookup(&ring, ROOM_ID).expect("room lookup");
        assert_eq!(
            first,
            ring.lookup_digest("room-binding-room-v1", &[ROOM_ID])
                .expect("direct room lookup")
        );
        assert_eq!(
            first,
            room_lookup(&ring, ROOM_ID).expect("same room lookup")
        );
        assert!(ring.lookup_digest("room-binding-room-v1", &[]).is_err());
        assert_ne!(
            first,
            ring.lookup_digest("room-binding-room-v1", &["prefix", ROOM_ID])
                .expect("room lookup with extra field")
        );
        assert_ne!(
            first,
            account_lookup(&ring, Provider::Telegram, "account_demo").expect("account lookup")
        );
        let account =
            account_lookup(&ring, Provider::Telegram, "account_demo").expect("account lookup");
        assert_eq!(
            account,
            ring.lookup_digest(
                "room-binding-account-v1",
                &[Provider::Telegram.as_str(), "account_demo"],
            )
            .expect("direct account lookup")
        );
        assert_ne!(
            account,
            ring.lookup_digest(
                "room-binding-account-v1",
                &["account_demo", Provider::Telegram.as_str()],
            )
            .expect("reversed account lookup")
        );
        assert_ne!(
            account,
            ring.lookup_digest("room-binding-account-v1", &[Provider::Telegram.as_str()])
                .expect("account lookup with omitted field")
        );
        assert_ne!(
            account_lookup(&ring, Provider::Telegram, "account_demo").expect("telegram lookup"),
            account_lookup(&ring, Provider::Whatsapp, "account_demo").expect("whatsapp lookup")
        );
        assert_ne!(
            account_lookup(&ring, Provider::Telegram, "account_demo").expect("first account"),
            account_lookup(&ring, Provider::Telegram, "account_demo_other")
                .expect("second account")
        );
    }

    #[test]
    fn room_binding_preserves_authority_and_exact_lifecycle() {
        let binding = new_binding();
        let active = RoomBinding::from_verified_parts(
            BINDING_ID,
            binding.payload(),
            RoomBindingStatus::Active,
            created_at(),
            None,
        )
        .expect("valid active row");
        assert_eq!(active.authority_tuple(), binding.authority_tuple());
        assert_eq!(active.status(), RoomBindingStatus::Active);
        assert!(active.retired_at().is_none());

        let retired = RoomBinding::from_verified_parts(
            BINDING_ID,
            new_binding().payload(),
            RoomBindingStatus::Retired,
            created_at(),
            Some(created_at() + Duration::milliseconds(1)),
        )
        .expect("valid retired row");
        assert_eq!(retired.status(), RoomBindingStatus::Retired);
        assert_eq!(
            retired.retired_at(),
            Some(&(created_at() + Duration::milliseconds(1)))
        );

        let peer = RoomBinding::from_verified_parts(
            BINDING_ID,
            new_binding().payload(),
            RoomBindingStatus::Active,
            created_at(),
            None,
        )
        .expect("valid peer row");
        assert!(active.payload().same_authority(peer.payload()));

        assert!(
            RoomBinding::from_verified_parts(
                BINDING_ID,
                new_binding().payload(),
                RoomBindingStatus::Active,
                created_at(),
                Some(created_at()),
            )
            .is_err()
        );
        assert!(
            RoomBinding::from_verified_parts(
                BINDING_ID,
                new_binding().payload(),
                RoomBindingStatus::Retired,
                created_at(),
                None,
            )
            .is_err()
        );
    }

    #[test]
    fn binding_and_payload_formatting_is_fully_redacted() {
        let new = new_binding();
        let binding = RoomBinding::from_verified_parts(
            BINDING_ID,
            new_binding().payload(),
            RoomBindingStatus::Active,
            created_at(),
            None,
        )
        .expect("valid row");
        for formatted in [
            format!("{new:?}"),
            format!("{new}"),
            format!("{binding:?}"),
            format!("{binding}"),
        ] {
            assert!(formatted.contains("REDACTED"));
            assert!(!formatted.contains(BINDING_ID));
            assert!(!formatted.contains(ROOM_ID));
            assert!(!formatted.contains("tenant_demo"));
        }

        let mut debug = String::new();
        write!(&mut debug, "{binding:?}").expect("format binding");
        assert_eq!(debug, "RoomBinding([REDACTED])");
    }
}
