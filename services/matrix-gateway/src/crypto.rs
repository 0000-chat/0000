//! Versioned encryption and key-derivation primitives for gateway data.

use std::{collections::BTreeMap, fmt};

use chacha20poly1305::{XChaCha20Poly1305, XNonce, aead::Aead, aead::KeyInit};
use rand_core::{OsRng, RngCore};
use sha2::{
    compress256,
    digest::generic_array::{GenericArray, typenum::U64},
};
use zeroize::{Zeroize, Zeroizing};

const AAD_PREFIX: &[u8] = b"communicator-matrix-gateway\0v1\0";
const HKDF_SALT: &[u8] = b"communicator-matrix-gateway\0v1\0";
const AEAD_KEY_LABEL: &[u8] = b"aead-key";
const LOOKUP_KEY_LABEL: &[u8] = b"lookup-key";
const LOOKUP_DOMAIN_LABEL: &[u8] = b"communicator-matrix-gateway\0v1\0lookup";

/// Maximum protected plaintext accepted by the gateway.
pub const MAX_PROTECTED_PLAINTEXT_BYTES: usize = 64 * 1024 * 1024;
/// Poly1305 appends a 16-byte authentication tag to every ciphertext.
pub const AEAD_TAG_BYTES: usize = 16;
/// Maximum protected ciphertext accepted by the gateway.
pub const MAX_PROTECTED_CIPHERTEXT_BYTES: usize = MAX_PROTECTED_PLAINTEXT_BYTES + AEAD_TAG_BYTES;
/// Maximum UTF-8 byte length of one AAD or lookup component.
pub const MAX_CONTEXT_COMPONENT_BYTES: usize = 4 * 1024;
/// Maximum combined UTF-8 byte length of table, row, and column components.
pub const MAX_CONTEXT_BYTES: usize = 16 * 1024;
/// Maximum number of fields in a deterministic lookup tuple.
pub const MAX_LOOKUP_FIELDS: usize = 128;
/// Maximum aggregate byte length of a deterministic lookup tuple.
pub const MAX_LOOKUP_INPUT_BYTES: usize = 64 * 1024 * 1024;

/// Zeroizing plaintext returned by a successful open operation.
pub struct Plaintext(Vec<u8>);

impl Plaintext {
    fn new(bytes: Vec<u8>) -> Self {
        Self(bytes)
    }

    /// Borrow the authenticated plaintext bytes.
    pub fn as_bytes(&self) -> &[u8] {
        &self.0
    }

    /// Return the plaintext length.
    pub fn len(&self) -> usize {
        self.0.len()
    }

    /// Return whether the plaintext is empty.
    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }

    /// Borrow the authenticated plaintext bytes as a slice.
    pub fn as_slice(&self) -> &[u8] {
        self.as_bytes()
    }
}

impl Drop for Plaintext {
    fn drop(&mut self) {
        self.0.zeroize();
    }
}

impl fmt::Debug for Plaintext {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("[REDACTED]")
    }
}

impl fmt::Display for Plaintext {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("[REDACTED]")
    }
}

/// The stable, content-free error returned by a cryptographic operation.
///
/// The error intentionally contains no upstream error, input, identifier, or
/// key material. Callers can use [`CryptoError::code`] for machine handling.
#[derive(Clone, Copy, Eq, PartialEq)]
pub struct CryptoError {
    code: &'static str,
}

impl CryptoError {
    fn new(code: &'static str) -> Self {
        Self { code }
    }

    /// Return the stable machine-readable error code.
    pub const fn code(&self) -> &'static str {
        self.code
    }
}

impl fmt::Debug for CryptoError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("CryptoError")
            .field("code", &self.code)
            .finish()
    }
}

impl fmt::Display for CryptoError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.code)
    }
}

impl std::error::Error for CryptoError {}

/// Authenticated ciphertext and its public storage metadata.
///
/// The ciphertext includes the 16-byte Poly1305 authentication tag. The
/// custom formatter intentionally omits all bytes.
#[derive(Clone, Eq, PartialEq)]
pub struct Sealed {
    /// The fresh XChaCha20 nonce.
    pub nonce: [u8; 24],
    /// Ciphertext followed by the Poly1305 authentication tag.
    pub ciphertext: Vec<u8>,
    /// Version of the key used to seal this value.
    pub key_version: u32,
}

impl fmt::Debug for Sealed {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("Sealed")
            .field("nonce", &"<redacted>")
            .field("ciphertext", &"<redacted>")
            .field("key_version", &self.key_version)
            .finish()
    }
}

/// A key-versioned application encryption keyring.
///
/// The master keys are held privately and are never serialised, cloned, or
/// formatted. A keyring owns one active, non-zero key version and may retain
/// explicitly configured older versions for decryption during rotation.
pub struct Keyring {
    master_keys: BTreeMap<u32, Zeroizing<[u8; 32]>>,
    active_key_version: u32,
}

impl fmt::Debug for Keyring {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("Keyring")
            .field("active_key_version", &self.active_key_version)
            .field("master_keys", &"<redacted>")
            .finish()
    }
}

impl Keyring {
    /// Construct a keyring from a 32-byte master key and a non-zero version.
    pub fn new(master_key: [u8; 32], key_version: u32) -> Result<Self, CryptoError> {
        let master_key = Zeroizing::new(master_key);
        if key_version == 0 {
            return Err(CryptoError::new("crypto_invalid_key_version"));
        }

        let mut master_keys = BTreeMap::new();
        master_keys.insert(key_version, master_key);
        Ok(Self {
            master_keys,
            active_key_version: key_version,
        })
    }

    /// Return the version used for all newly sealed values.
    pub const fn active_key_version(&self) -> u32 {
        self.active_key_version
    }

    /// Add an explicitly configured old key for decryption during rotation.
    ///
    /// The active key remains the only key used by [`Self::seal`].
    pub fn add_decryption_key(
        &mut self,
        key_version: u32,
        master_key: [u8; 32],
    ) -> Result<(), CryptoError> {
        let master_key = Zeroizing::new(master_key);
        if key_version == 0 {
            return Err(CryptoError::new("crypto_invalid_key_version"));
        }
        if key_version >= self.active_key_version {
            return Err(CryptoError::new("crypto_not_old_key_version"));
        }
        if self.master_keys.contains_key(&key_version) {
            return Err(CryptoError::new("crypto_duplicate_key_version"));
        }
        self.master_keys.insert(key_version, master_key);
        Ok(())
    }

    /// Add an old decryption key while constructing a rotated keyring.
    pub fn with_decryption_key(
        mut self,
        key_version: u32,
        master_key: [u8; 32],
    ) -> Result<Self, CryptoError> {
        self.add_decryption_key(key_version, master_key)?;
        Ok(self)
    }

    /// Seal non-empty plaintext with versioned authenticated associated data.
    pub fn seal(
        &self,
        table: &str,
        row_id: &str,
        column: &str,
        plaintext: &[u8],
    ) -> Result<Sealed, CryptoError> {
        validate_context(table, row_id, column, plaintext)?;

        let master_key = self
            .master_keys
            .get(&self.active_key_version)
            .ok_or_else(|| CryptoError::new("crypto_active_key_unavailable"))?;
        let mut key = Self::derive_aead_key(master_key, self.active_key_version)?;
        let cipher = XChaCha20Poly1305::new_from_slice(key.as_ref())
            .map_err(|_| CryptoError::new("crypto_key_derivation_failed"))?;
        let mut nonce = [0_u8; 24];
        if OsRng.try_fill_bytes(&mut nonce).is_err() {
            return Err(CryptoError::new("crypto_randomness_unavailable"));
        }
        let mut aad = associated_data(table, row_id, column, self.active_key_version)?;
        let encrypted = cipher
            .encrypt(
                XNonce::from_slice(&nonce),
                chacha20poly1305::aead::Payload {
                    msg: plaintext,
                    aad: &aad,
                },
            )
            .map_err(|_| CryptoError::new("crypto_seal_failed"));
        key.zeroize();
        aad.zeroize();

        encrypted.and_then(|ciphertext| {
            if ciphertext.len() > MAX_PROTECTED_CIPHERTEXT_BYTES {
                return Err(CryptoError::new("crypto_ciphertext_too_large"));
            }
            Ok(Sealed {
                nonce,
                ciphertext,
                key_version: self.active_key_version,
            })
        })
    }

    /// Open a ciphertext after authenticating its exact context and version.
    pub fn open(
        &self,
        table: &str,
        row_id: &str,
        column: &str,
        sealed: &Sealed,
    ) -> Result<Plaintext, CryptoError> {
        validate_identifiers(table, row_id, column)?;
        if sealed.ciphertext.len() < AEAD_TAG_BYTES
            || sealed.ciphertext.len() > MAX_PROTECTED_CIPHERTEXT_BYTES
        {
            return Err(CryptoError::new("crypto_invalid_ciphertext"));
        }

        let master_key = self
            .master_keys
            .get(&sealed.key_version)
            .ok_or_else(|| CryptoError::new("crypto_unknown_key_version"))?;
        if sealed.key_version == 0 {
            return Err(CryptoError::new("crypto_unknown_key_version"));
        }

        let mut key = Self::derive_aead_key(master_key, sealed.key_version)?;
        let cipher = XChaCha20Poly1305::new_from_slice(key.as_ref())
            .map_err(|_| CryptoError::new("crypto_key_derivation_failed"))?;
        let mut aad = associated_data(table, row_id, column, sealed.key_version)?;
        let plaintext = cipher
            .decrypt(
                XNonce::from_slice(&sealed.nonce),
                chacha20poly1305::aead::Payload {
                    msg: sealed.ciphertext.as_slice(),
                    aad: &aad,
                },
            )
            .map_err(|_| CryptoError::new("crypto_authentication_failed"));
        key.zeroize();
        aad.zeroize();

        let mut plaintext = Zeroizing::new(plaintext?);
        if plaintext.is_empty() {
            return Err(CryptoError::new("crypto_empty_plaintext"));
        }

        Ok(Plaintext::new(std::mem::take(&mut *plaintext)))
    }

    /// Compute a deterministic, keyed digest for a non-empty tuple of UTF-8
    /// lookup fields. Every field is framed with a four-byte big-endian byte
    /// length, so concatenation collisions cannot change the lookup key.
    pub fn lookup_digest(&self, domain: &str, fields: &[&str]) -> Result<[u8; 32], CryptoError> {
        self.lookup_digest_at(self.active_key_version, domain, fields)
    }

    /// Compute a lookup digest with an explicitly configured key version.
    pub fn lookup_digest_at(
        &self,
        key_version: u32,
        domain: &str,
        fields: &[&str],
    ) -> Result<[u8; 32], CryptoError> {
        if domain.is_empty() || fields.is_empty() {
            return Err(CryptoError::new("crypto_empty_lookup_input"));
        }
        if fields.len() > MAX_LOOKUP_FIELDS {
            return Err(CryptoError::new("crypto_lookup_field_count_too_large"));
        }
        validate_lookup_component(domain)?;
        for field in fields {
            validate_lookup_component(field)?;
        }

        let mut total = 0_usize;
        for value in std::iter::once(LOOKUP_DOMAIN_LABEL)
            .chain(std::iter::once(domain.as_bytes()))
            .chain(fields.iter().map(|field| field.as_bytes()))
        {
            let framed_length = 4_usize
                .checked_add(value.len())
                .ok_or_else(|| CryptoError::new("crypto_lookup_input_too_large"))?;
            total = total
                .checked_add(framed_length)
                .ok_or_else(|| CryptoError::new("crypto_lookup_input_too_large"))?;
        }
        if total > MAX_LOOKUP_INPUT_BYTES {
            return Err(CryptoError::new("crypto_lookup_input_too_large"));
        }

        let mut framed = Zeroizing::new(Vec::with_capacity(total));
        append_length_prefixed(&mut framed, LOOKUP_DOMAIN_LABEL)?;
        append_length_prefixed(&mut framed, domain.as_bytes())?;
        for field in fields {
            append_length_prefixed(&mut framed, field.as_bytes())?;
        }

        let mut key = self.derive_lookup_key(key_version)?;
        let output = hmac_sha256(key.as_ref(), &framed)?;
        let mut digest = [0_u8; 32];
        digest.copy_from_slice(output.as_ref());
        key.zeroize();
        Ok(digest)
    }

    fn derive_aead_key(
        master_key: &[u8; 32],
        key_version: u32,
    ) -> Result<Zeroizing<[u8; 32]>, CryptoError> {
        Self::derive_key(master_key, key_version, AEAD_KEY_LABEL)
    }

    fn derive_lookup_key(&self, key_version: u32) -> Result<Zeroizing<[u8; 32]>, CryptoError> {
        let master_key = self
            .master_keys
            .get(&key_version)
            .ok_or_else(|| CryptoError::new("crypto_unknown_key_version"))?;
        Self::derive_key(master_key, key_version, LOOKUP_KEY_LABEL)
    }

    fn derive_key(
        master_key: &[u8; 32],
        key_version: u32,
        label: &[u8],
    ) -> Result<Zeroizing<[u8; 32]>, CryptoError> {
        let mut info = Zeroizing::new(Vec::with_capacity(label.len() + 1 + 4));
        info.extend_from_slice(label);
        info.push(0);
        info.extend_from_slice(&key_version.to_be_bytes());
        let key = hkdf_derive(HKDF_SALT, master_key, &info, 32)?;
        let mut key_bytes = [0_u8; 32];
        key_bytes.copy_from_slice(&key);
        Ok(Zeroizing::new(key_bytes))
    }
}

fn validate_context(
    table: &str,
    row_id: &str,
    column: &str,
    plaintext: &[u8],
) -> Result<(), CryptoError> {
    validate_identifiers(table, row_id, column)?;
    if plaintext.is_empty() {
        return Err(CryptoError::new("crypto_empty_plaintext"));
    }
    if plaintext.len() > MAX_PROTECTED_PLAINTEXT_BYTES {
        return Err(CryptoError::new("crypto_plaintext_too_large"));
    }
    Ok(())
}

fn validate_identifiers(table: &str, row_id: &str, column: &str) -> Result<(), CryptoError> {
    let total = [table, row_id, column]
        .iter()
        .try_fold(0_usize, |total, value| {
            validate_component(value)?;
            total
                .checked_add(value.len())
                .ok_or_else(|| CryptoError::new("crypto_context_too_large"))
        })?;
    if total > MAX_CONTEXT_BYTES {
        return Err(CryptoError::new("crypto_context_too_large"));
    }
    Ok(())
}

fn validate_component(value: &str) -> Result<(), CryptoError> {
    if value.is_empty() {
        return Err(CryptoError::new("crypto_empty_context"));
    }
    if value.len() > MAX_CONTEXT_COMPONENT_BYTES || value.chars().any(char::is_control) {
        return Err(CryptoError::new("crypto_invalid_context"));
    }
    Ok(())
}

fn validate_lookup_component(value: &str) -> Result<(), CryptoError> {
    if value.is_empty() {
        return Err(CryptoError::new("crypto_empty_lookup_input"));
    }
    if value.len() > MAX_CONTEXT_COMPONENT_BYTES || value.chars().any(char::is_control) {
        return Err(CryptoError::new("crypto_invalid_lookup_input"));
    }
    Ok(())
}

fn associated_data(
    table: &str,
    row_id: &str,
    column: &str,
    key_version: u32,
) -> Result<Zeroizing<Vec<u8>>, CryptoError> {
    validate_identifiers(table, row_id, column)?;
    let version = key_version.to_string();
    let total = AAD_PREFIX
        .len()
        .checked_add(table.len())
        .and_then(|value| value.checked_add(row_id.len()))
        .and_then(|value| value.checked_add(column.len()))
        .and_then(|value| value.checked_add(version.len()))
        .and_then(|value| value.checked_add(3))
        .ok_or_else(|| CryptoError::new("crypto_context_too_large"))?;
    let mut aad = Zeroizing::new(Vec::with_capacity(total));
    aad.extend_from_slice(AAD_PREFIX);
    aad.extend_from_slice(table.as_bytes());
    aad.push(0);
    aad.extend_from_slice(row_id.as_bytes());
    aad.push(0);
    aad.extend_from_slice(column.as_bytes());
    aad.push(0);
    aad.extend_from_slice(version.as_bytes());
    Ok(aad)
}

fn append_length_prefixed(frame: &mut Vec<u8>, value: &[u8]) -> Result<(), CryptoError> {
    let length = u32::try_from(value.len())
        .map_err(|_| CryptoError::new("crypto_lookup_input_too_large"))?;
    frame.extend_from_slice(&length.to_be_bytes());
    frame.extend_from_slice(value);
    Ok(())
}

const SHA256_BLOCK_BYTES: usize = 64;
const SHA256_OUTPUT_BYTES: usize = 32;
const MAX_SHA256_INPUT_BYTES: usize = MAX_LOOKUP_INPUT_BYTES + SHA256_BLOCK_BYTES * 2;
const SHA256_INITIAL_STATE: [u32; 8] = [
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
];

fn hkdf_derive(
    salt: &[u8],
    ikm: &[u8],
    info: &[u8],
    output_len: usize,
) -> Result<Zeroizing<Vec<u8>>, CryptoError> {
    if output_len == 0 || output_len > SHA256_OUTPUT_BYTES * 255 {
        return Err(CryptoError::new("crypto_key_derivation_failed"));
    }
    let salt_key = Zeroizing::new([0_u8; SHA256_OUTPUT_BYTES]);
    let salt_material = if salt.is_empty() {
        salt_key.as_slice()
    } else {
        salt
    };
    let mut prk = hmac_sha256(salt_material, ikm)?;
    let blocks = output_len.div_ceil(SHA256_OUTPUT_BYTES);
    let mut okm = Zeroizing::new(Vec::with_capacity(output_len));
    let mut previous = Zeroizing::new([0_u8; SHA256_OUTPUT_BYTES]);
    let mut previous_len = 0_usize;
    for counter in 1..=blocks {
        let capacity = previous_len
            .checked_add(info.len())
            .and_then(|value| value.checked_add(1))
            .ok_or_else(|| CryptoError::new("crypto_key_derivation_failed"))?;
        let mut message = Zeroizing::new(Vec::with_capacity(capacity));
        message.extend_from_slice(&previous[..previous_len]);
        message.extend_from_slice(info);
        message.push(
            u8::try_from(counter).map_err(|_| CryptoError::new("crypto_key_derivation_failed"))?,
        );
        let block = hmac_sha256(prk.as_ref(), &message)?;
        previous.copy_from_slice(block.as_ref());
        previous_len = SHA256_OUTPUT_BYTES;
        let remaining = output_len.saturating_sub(okm.len());
        let take = remaining.min(SHA256_OUTPUT_BYTES);
        okm.extend_from_slice(&block[..take]);
    }
    prk.zeroize();
    Ok(okm)
}

fn hmac_sha256(key: &[u8], message: &[u8]) -> Result<Zeroizing<[u8; 32]>, CryptoError> {
    let mut key_block = Zeroizing::new([0_u8; SHA256_BLOCK_BYTES]);
    if key.len() > SHA256_BLOCK_BYTES {
        let hashed_key = sha256_digest(key)?;
        key_block[..SHA256_OUTPUT_BYTES].copy_from_slice(hashed_key.as_ref());
    } else {
        key_block[..key.len()].copy_from_slice(key);
    }

    let message_capacity = SHA256_BLOCK_BYTES
        .checked_add(message.len())
        .ok_or_else(|| CryptoError::new("crypto_hmac_input_too_large"))?;
    if message_capacity > MAX_SHA256_INPUT_BYTES {
        return Err(CryptoError::new("crypto_hmac_input_too_large"));
    }
    let mut inner_message = Zeroizing::new(Vec::with_capacity(message_capacity));
    for byte in key_block.iter() {
        inner_message.push(byte ^ 0x36);
    }
    inner_message.extend_from_slice(message);
    let inner = sha256_digest(&inner_message)?;

    let mut outer_message = Zeroizing::new(Vec::with_capacity(SHA256_BLOCK_BYTES + 32));
    for byte in key_block.iter() {
        outer_message.push(byte ^ 0x5c);
    }
    outer_message.extend_from_slice(inner.as_ref());
    sha256_digest(&outer_message)
}

fn sha256_digest(input: &[u8]) -> Result<Zeroizing<[u8; 32]>, CryptoError> {
    if input.len() > MAX_SHA256_INPUT_BYTES {
        return Err(CryptoError::new("crypto_hash_input_too_large"));
    }
    let remainder = (input.len() + 1) % SHA256_BLOCK_BYTES;
    let zero_padding = (56 + SHA256_BLOCK_BYTES - remainder) % SHA256_BLOCK_BYTES;
    let total_len = input
        .len()
        .checked_add(1)
        .and_then(|value| value.checked_add(zero_padding))
        .and_then(|value| value.checked_add(8))
        .ok_or_else(|| CryptoError::new("crypto_hash_input_too_large"))?;
    let bit_length = u64::try_from(input.len())
        .ok()
        .and_then(|length| length.checked_mul(8))
        .ok_or_else(|| CryptoError::new("crypto_hash_input_too_large"))?;
    let mut padded = Zeroizing::new(Vec::with_capacity(total_len));
    padded.extend_from_slice(input);
    padded.push(0x80);
    padded.resize(input.len() + 1 + zero_padding, 0);
    padded.extend_from_slice(&bit_length.to_be_bytes());

    let block_count = total_len / SHA256_BLOCK_BYTES;
    let mut blocks = Vec::with_capacity(block_count);
    for chunk in padded.chunks_exact(SHA256_BLOCK_BYTES) {
        let mut block = GenericArray::<u8, U64>::default();
        block.copy_from_slice(chunk);
        blocks.push(block);
    }

    let mut state = Zeroizing::new(SHA256_INITIAL_STATE);
    compress256(&mut state, &blocks);
    for block in &mut blocks {
        block.as_mut_slice().zeroize();
    }
    let mut output = [0_u8; SHA256_OUTPUT_BYTES];
    for (word, destination) in state.iter().zip(output.chunks_exact_mut(4)) {
        destination.copy_from_slice(&word.to_be_bytes());
    }
    Ok(Zeroizing::new(output))
}

#[cfg(test)]
mod tests {
    use super::{hkdf_derive, hmac_sha256};

    #[test]
    fn hmac_sha256_matches_compatibility_vector() {
        let actual = hmac_sha256(b"key", b"The quick brown fox jumps over the lazy dog")
            .expect("valid HMAC input");
        assert_eq!(
            hex(actual.as_ref()),
            "f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8"
        );
    }

    #[test]
    fn hkdf_matches_rfc5869_test_case_one() {
        let ikm = [0x0b_u8; 22];
        let salt = [
            0x00_u8, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b, 0x0c,
        ];
        let info = [
            0xf0_u8, 0xf1, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8, 0xf9,
        ];
        let actual = hkdf_derive(&salt, &ikm, &info, 42).expect("valid HKDF input");
        assert_eq!(
            hex(&actual),
            "3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865"
        );
    }

    fn hex(bytes: &[u8]) -> String {
        bytes.iter().map(|byte| format!("{byte:02x}")).collect()
    }
}
