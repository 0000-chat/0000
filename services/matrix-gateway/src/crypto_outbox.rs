//! Closed, protected Matrix crypto-request values.

use std::fmt;

use serde::de::{Deserializer as _, IgnoredAny, MapAccess, Visitor};
use serde_json::Value;
use sha2::{Digest, Sha256};
use zeroize::Zeroize;

use crate::{
    canonical,
    secret::{SafeError, SecretBytes},
    store::{STORE_CRYPTO_INVALID, STORE_CRYPTO_TOO_LARGE},
};

/// Maximum bytes accepted for an SDK-generated request identifier.
pub const MAX_SDK_REQUEST_ID_BYTES: usize = 64 * 1024;
/// Maximum bytes accepted for a canonical Matrix crypto request body.
pub const MAX_MATRIX_CRYPTO_REQUEST_BYTES: usize = 4 * 1024 * 1024;
/// Maximum bytes accepted for one exact Matrix `/keys/query` response body.
pub const MAX_MATRIX_CRYPTO_RESPONSE_BYTES: usize = 64 * 1024 * 1024;
/// The only Matrix crypto request kind accepted by this gateway phase.
pub const MATRIX_CRYPTO_REQUEST_KIND: &str = "keys_query";

struct JsonObjectVisitor;

impl<'de> Visitor<'de> for JsonObjectVisitor {
    type Value = ();

    fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("a JSON object")
    }

    fn visit_map<M>(self, mut map: M) -> Result<Self::Value, M::Error>
    where
        M: MapAccess<'de>,
    {
        while map.next_key::<IgnoredAny>()?.is_some() {
            map.next_value::<IgnoredAny>()?;
        }
        Ok(())
    }
}

/// Validate one UTF-8 JSON object without materialising its values.
pub(crate) fn validate_json_object(bytes: &[u8]) -> Result<(), ()> {
    let mut deserializer = serde_json::Deserializer::from_slice(bytes);
    deserializer
        .deserialize_map(JsonObjectVisitor)
        .map_err(|_| ())?;
    deserializer.end().map_err(|_| ())
}

/// One verified pending Matrix crypto request selected for a caller to send.
///
/// The store is the only constructor. Secret request values remain owned by
/// this non-cloneable DTO until the caller finishes its one send attempt.
///
/// ```compile_fail
/// use communicator_matrix_gateway::crypto_outbox::PendingMatrixRequest;
/// fn requires_clone<T: Clone>() {}
/// requires_clone::<PendingMatrixRequest>();
/// ```
/// ```compile_fail
/// use communicator_matrix_gateway::crypto_outbox::PendingMatrixRequest;
/// fn requires_serialize<T: serde::Serialize>() {}
/// requires_serialize::<PendingMatrixRequest>();
/// ```
/// ```compile_fail
/// use communicator_matrix_gateway::crypto_outbox::PendingMatrixRequest;
/// fn requires_as_ref<T: AsRef<[u8]>>() {}
/// requires_as_ref::<PendingMatrixRequest>();
/// ```
/// ```compile_fail
/// use communicator_matrix_gateway::crypto_outbox::PendingMatrixRequest;
/// fn requires_deref<T: std::ops::Deref>() {}
/// requires_deref::<PendingMatrixRequest>();
/// ```
#[allow(dead_code)]
pub struct PendingMatrixRequest {
    row_id: String,
    sdk_request_id: SecretBytes,
    request: SecretBytes,
    request_sha256: [u8; 32],
    attempt_count: u32,
    next_attempt_at: chrono::DateTime<chrono::Utc>,
}

#[allow(dead_code)]
impl PendingMatrixRequest {
    pub(crate) fn from_verified_parts(
        row_id: String,
        sdk_request_id: SecretBytes,
        request: SecretBytes,
        request_sha256: [u8; 32],
        attempt_count: u32,
        next_attempt_at: chrono::DateTime<chrono::Utc>,
    ) -> Self {
        Self {
            row_id,
            sdk_request_id,
            request,
            request_sha256,
            attempt_count,
            next_attempt_at,
        }
    }

    pub fn row_id(&self) -> &str {
        &self.row_id
    }

    pub fn request_kind(&self) -> &'static str {
        MATRIX_CRYPTO_REQUEST_KIND
    }

    pub fn sdk_request_id(&self) -> &SecretBytes {
        &self.sdk_request_id
    }

    pub fn request(&self) -> &SecretBytes {
        &self.request
    }

    pub fn request_sha256(&self) -> &[u8; 32] {
        &self.request_sha256
    }

    pub fn attempt_count(&self) -> u32 {
        self.attempt_count
    }

    pub fn next_attempt_at(&self) -> chrono::DateTime<chrono::Utc> {
        self.next_attempt_at
    }
}

impl fmt::Debug for PendingMatrixRequest {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("PendingMatrixRequest([REDACTED])")
    }
}

impl fmt::Display for PendingMatrixRequest {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("PendingMatrixRequest([REDACTED])")
    }
}

/// A closed, protected, exact Matrix `/keys/query` request.
///
/// The request identifier and body are intentionally held as non-cloneable
/// [`SecretBytes`].  Callers can only borrow them inside the store module.
///
/// ```compile_fail
/// use communicator_matrix_gateway::crypto_outbox::ExactMatrixRequest;
/// fn requires_clone<T: Clone>() {}
/// requires_clone::<ExactMatrixRequest>();
/// ```
/// ```compile_fail
/// use communicator_matrix_gateway::crypto_outbox::ExactMatrixRequest;
/// fn requires_serialize<T: serde::Serialize>() {}
/// requires_serialize::<ExactMatrixRequest>();
/// ```
/// ```compile_fail
/// use communicator_matrix_gateway::crypto_outbox::ExactMatrixRequest;
/// fn requires_as_ref<T: AsRef<[u8]>>() {}
/// requires_as_ref::<ExactMatrixRequest>();
/// ```
/// ```compile_fail
/// use communicator_matrix_gateway::crypto_outbox::ExactMatrixRequest;
/// fn requires_deref<T: std::ops::Deref>() {}
/// requires_deref::<ExactMatrixRequest>();
/// ```
#[allow(dead_code)]
pub struct ExactMatrixRequest {
    sdk_request_id: SecretBytes,
    request: SecretBytes,
    request_sha256: [u8; 32],
}

#[allow(dead_code)]
impl ExactMatrixRequest {
    /// Construct an exact, canonical, bounded `/keys/query` request.
    pub fn keys_query(
        mut sdk_request_id: Vec<u8>,
        mut canonical_request: Vec<u8>,
    ) -> Result<Self, SafeError> {
        if sdk_request_id.is_empty() || canonical_request.is_empty() {
            sdk_request_id.zeroize();
            canonical_request.zeroize();
            return Err(crypto_invalid());
        }
        if sdk_request_id.len() > MAX_SDK_REQUEST_ID_BYTES
            || canonical_request.len() > MAX_MATRIX_CRYPTO_REQUEST_BYTES
        {
            sdk_request_id.zeroize();
            canonical_request.zeroize();
            return Err(crypto_too_large());
        }

        let canonical_result = validate_canonical_request_bytes(&canonical_request);
        if let Err(error) = canonical_result {
            sdk_request_id.zeroize();
            canonical_request.zeroize();
            return Err(error);
        }

        let request_sha256 = Sha256::digest(&canonical_request).into();
        Ok(Self {
            sdk_request_id: SecretBytes::new(sdk_request_id),
            request: SecretBytes::new(canonical_request),
            request_sha256,
        })
    }

    /// Borrow the SHA-256 digest of the exact canonical request bytes.
    pub fn request_sha256(&self) -> &[u8; 32] {
        &self.request_sha256
    }

    /// Borrow the SDK request identifier for store encryption.
    pub(crate) fn sdk_request_id(&self) -> &SecretBytes {
        &self.sdk_request_id
    }

    /// Borrow the exact request bytes for store encryption.
    pub(crate) fn request(&self) -> &SecretBytes {
        &self.request
    }

    /// Revalidate the closed value before it crosses into a transaction.
    pub(crate) fn validate(&self) -> Result<(), SafeError> {
        if self.sdk_request_id.is_empty() || self.request.is_empty() {
            return Err(crypto_invalid());
        }
        if self.sdk_request_id.len() > MAX_SDK_REQUEST_ID_BYTES
            || self.request.len() > MAX_MATRIX_CRYPTO_REQUEST_BYTES
        {
            return Err(crypto_too_large());
        }
        if Sha256::digest(self.request.as_bytes()).as_slice() != self.request_sha256 {
            return Err(crypto_invalid());
        }
        validate_canonical_request_bytes(self.request.as_bytes()).map_err(|error| {
            if error.code() == STORE_CRYPTO_TOO_LARGE {
                crypto_too_large()
            } else {
                crypto_invalid()
            }
        })
    }
}

impl fmt::Debug for ExactMatrixRequest {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("ExactMatrixRequest([REDACTED])")
    }
}

impl fmt::Display for ExactMatrixRequest {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("ExactMatrixRequest([REDACTED])")
    }
}

/// A closed, protected, exact Matrix `/keys/query` response body.
///
/// The body is retained byte-for-byte after bounded JSON-object validation.
/// It is deliberately not exposed as a general byte container.
///
/// ```compile_fail
/// use communicator_matrix_gateway::crypto_outbox::RawMatrixResponse;
/// fn requires_clone<T: Clone>() {}
/// requires_clone::<RawMatrixResponse>();
/// ```
/// ```compile_fail
/// use communicator_matrix_gateway::crypto_outbox::RawMatrixResponse;
/// fn requires_serialize<T: serde::Serialize>() {}
/// requires_serialize::<RawMatrixResponse>();
/// ```
/// ```compile_fail
/// use communicator_matrix_gateway::crypto_outbox::RawMatrixResponse;
/// fn requires_as_ref<T: AsRef<[u8]>>() {}
/// requires_as_ref::<RawMatrixResponse>();
/// ```
/// ```compile_fail
/// use communicator_matrix_gateway::crypto_outbox::RawMatrixResponse;
/// fn requires_deref<T: std::ops::Deref>() {}
/// requires_deref::<RawMatrixResponse>();
/// ```
#[allow(dead_code)]
pub struct RawMatrixResponse {
    body: SecretBytes,
    sha256: [u8; 32],
}

#[allow(dead_code)]
impl RawMatrixResponse {
    /// Construct an exact, bounded, valid JSON-object response body.
    pub fn keys_query(mut exact_body: Vec<u8>) -> Result<Self, SafeError> {
        if exact_body.is_empty() {
            exact_body.zeroize();
            return Err(crypto_invalid());
        }
        if exact_body.len() > MAX_MATRIX_CRYPTO_RESPONSE_BYTES {
            exact_body.zeroize();
            return Err(crypto_too_large());
        }
        if std::str::from_utf8(&exact_body).is_err() {
            exact_body.zeroize();
            return Err(crypto_invalid());
        }
        if validate_json_object(&exact_body).is_err() {
            exact_body.zeroize();
            return Err(crypto_invalid());
        }

        let sha256 = Sha256::digest(&exact_body).into();
        Ok(Self {
            body: SecretBytes::new(exact_body),
            sha256,
        })
    }

    /// Borrow the SHA-256 digest of the exact response bytes.
    pub fn sha256(&self) -> &[u8; 32] {
        &self.sha256
    }

    /// Borrow the exact response bytes for store encryption.
    pub(crate) fn body(&self) -> &SecretBytes {
        &self.body
    }

    /// Revalidate the closed value before it crosses into a transaction.
    pub(crate) fn validate(&self) -> Result<(), SafeError> {
        if self.body.is_empty() {
            return Err(crypto_invalid());
        }
        if self.body.len() > MAX_MATRIX_CRYPTO_RESPONSE_BYTES {
            return Err(crypto_too_large());
        }
        if Sha256::digest(self.body.as_bytes()).as_slice() != self.sha256 {
            return Err(crypto_invalid());
        }
        std::str::from_utf8(self.body.as_bytes()).map_err(|_| crypto_invalid())?;
        validate_json_object(self.body.as_bytes()).map_err(|_| crypto_invalid())
    }
}

impl fmt::Debug for RawMatrixResponse {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("RawMatrixResponse([REDACTED])")
    }
}

impl fmt::Display for RawMatrixResponse {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("RawMatrixResponse([REDACTED])")
    }
}

/// A deterministic synthetic identifier for one crypto outbox row.
#[derive(Clone, Eq, PartialEq)]
pub struct CryptoRowId(String);

#[allow(dead_code)]
impl CryptoRowId {
    /// Validate and wrap a synthetic crypto-row identifier.
    pub(crate) fn new(value: String) -> Result<Self, SafeError> {
        if value.len() == "crypto_".len() + 64
            && value.starts_with("crypto_")
            && value.as_bytes()["crypto_".len()..]
                .iter()
                .all(|byte| matches!(*byte, b'0'..=b'9' | b'a'..=b'f'))
        {
            Ok(Self(value))
        } else {
            Err(crypto_invalid())
        }
    }

    /// Borrow the synthetic identifier for an exact AAD context.
    pub(crate) fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Debug for CryptoRowId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl fmt::Display for CryptoRowId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

/// Validate canonical `/keys/query` bytes without retaining a parsed value.
pub(crate) fn validate_canonical_request_bytes(bytes: &[u8]) -> Result<(), SafeError> {
    if bytes.is_empty() {
        return Err(crypto_invalid());
    }
    if bytes.len() > MAX_MATRIX_CRYPTO_REQUEST_BYTES {
        return Err(crypto_too_large());
    }
    std::str::from_utf8(bytes).map_err(|_| crypto_invalid())?;
    let value: Value = serde_json::from_slice(bytes).map_err(|_| crypto_invalid())?;
    if !value.is_object() {
        return Err(crypto_invalid());
    }
    let mut canonical_bytes = canonical::canonical_json_bytes(&value).map_err(|error| {
        if error.code() == "canonical_too_large" {
            crypto_too_large()
        } else {
            crypto_invalid()
        }
    })?;
    let exact = canonical_bytes == bytes;
    canonical_bytes.zeroize();
    if !exact {
        return Err(crypto_invalid());
    }
    Ok(())
}

fn crypto_invalid() -> SafeError {
    SafeError::new(STORE_CRYPTO_INVALID)
}

fn crypto_too_large() -> SafeError {
    SafeError::new(STORE_CRYPTO_TOO_LARGE)
}

#[cfg(test)]
mod tests {
    use super::{CryptoRowId, STORE_CRYPTO_INVALID};

    #[test]
    fn crypto_row_id_shape_is_strict_and_prints_only_the_id() {
        let valid = format!("crypto_{}", "a".repeat(64));
        let row_id = CryptoRowId::new(valid.clone()).expect("valid crypto row ID");
        assert_eq!(row_id.as_str(), valid);
        assert_eq!(row_id.to_string(), valid);
        assert_eq!(format!("{row_id:?}"), valid);

        for invalid in [
            "crypto_".to_owned(),
            format!("crypto_{}", "A".repeat(64)),
            format!("crypto_{}", "a".repeat(63)),
            format!("crypto_{}", "a".repeat(65)),
            format!("row_{}", "a".repeat(64)),
        ] {
            let error = CryptoRowId::new(invalid).expect_err("invalid crypto row ID");
            assert_eq!(error.code(), STORE_CRYPTO_INVALID);
        }
    }
}
