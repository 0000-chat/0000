//! Secret-bearing values and errors with deliberately small formatting surfaces.
//!
//! File-system policy belongs to the protected loader.  This module only owns
//! the values that cross that boundary and the byte-level validation needed to
//! construct them.

use std::{
    error::Error,
    fmt, mem,
    path::{Component, Path},
    str,
};

use base64::{Engine as _, engine::general_purpose::STANDARD};
use rustix::{
    fs::{CWD, FileType, Mode, OFlags, ResolveFlags, openat, openat2},
    io::read,
    path::DecInt,
    process::geteuid,
};
use zeroize::Zeroize;

/// Stable error code returned when secret input cannot be accepted.
pub const SECRET_INVALID: &str = "secret_invalid";

/// Stable error code returned when a secret exceeds its configured bound.
pub const SECRET_TOO_LARGE: &str = "secret_too_large";

const STATE_KEY_ENCODED_BYTES: usize = 44;

/// Maximum number of bytes accepted for any text secret.
pub const MAX_TEXT_SECRET_BYTES: usize = 1024 * 1024;

/// An error that carries only a stable, non-secret code.
///
/// The type intentionally has no source error, path, or input value.  Callers
/// should use stable reason codes rather than attaching an underlying I/O or
/// parsing error, since those errors commonly contain paths or input data.
#[derive(Clone, Copy, Eq, PartialEq)]
pub struct SafeError {
    code: &'static str,
}

impl SafeError {
    /// Construct an error from a stable, non-secret code.
    pub const fn new(code: &'static str) -> Self {
        Self { code }
    }

    /// Return the stable machine-readable error code.
    pub const fn code(&self) -> &'static str {
        self.code
    }
}

impl fmt::Debug for SafeError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("SafeError")
            .field("code", &self.code)
            .finish()
    }
}

impl fmt::Display for SafeError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.code)
    }
}

impl Error for SafeError {}

/// A secret held in a non-cloneable, zeroizing byte buffer.
///
/// There is intentionally no `Deref`, `AsRef`, `Serialize`, or `Clone` impl.
/// A caller must opt in to reading the value through [`Self::as_bytes`], which
/// makes secret use sites straightforward to audit.
pub struct SecretBytes {
    bytes: Vec<u8>,
}

impl SecretBytes {
    /// Store bytes as a secret value.
    pub(crate) fn new(bytes: Vec<u8>) -> Self {
        Self { bytes }
    }

    /// Copy bytes into a new secret value.
    #[allow(dead_code)]
    pub(crate) fn from_slice(bytes: &[u8]) -> Self {
        Self::new(bytes.to_vec())
    }

    /// Explicitly borrow the secret bytes for a narrowly scoped operation.
    pub fn as_bytes(&self) -> &[u8] {
        &self.bytes
    }

    /// Return the number of secret bytes without exposing their contents.
    pub fn len(&self) -> usize {
        self.bytes.len()
    }

    /// Return whether the secret contains no bytes.
    pub fn is_empty(&self) -> bool {
        self.bytes.is_empty()
    }

    /// Move the protected bytes to one narrowly scoped crate consumer.
    pub(crate) fn into_vec(mut self) -> Vec<u8> {
        mem::take(&mut self.bytes)
    }

    /// Parse a text secret, removing one optional final LF and nothing else.
    ///
    /// Text secrets must be non-empty UTF-8 and single-line.  A second final
    /// LF, CRLF residue, or other trailing whitespace is rejected rather than
    /// silently trimmed.  The configured limit applies to the file bytes
    /// before the optional LF is removed.
    pub fn from_text(bytes: &[u8], max_bytes: usize) -> Result<Self, SafeError> {
        if max_bytes > MAX_TEXT_SECRET_BYTES || bytes.len() > max_bytes {
            return Err(SafeError::new(SECRET_TOO_LARGE));
        }
        Self::from_owned_text(bytes.to_vec(), max_bytes)
    }

    /// Parse an owned text secret without making an additional copy.
    pub(crate) fn from_owned_text(mut bytes: Vec<u8>, max_bytes: usize) -> Result<Self, SafeError> {
        if max_bytes > MAX_TEXT_SECRET_BYTES || bytes.len() > max_bytes {
            bytes.zeroize();
            return Err(SafeError::new(SECRET_TOO_LARGE));
        }

        if bytes.last() == Some(&b'\n') {
            bytes.pop();
        }

        let valid = if bytes.is_empty() {
            false
        } else if let Ok(text) = str::from_utf8(&bytes) {
            !text.chars().any(is_rejected_text_char)
                && !text.chars().next_back().is_some_and(char::is_whitespace)
        } else {
            false
        };

        if !valid {
            bytes.zeroize();
            return Err(SafeError::new(SECRET_INVALID));
        }

        Ok(Self::new(bytes))
    }

    /// Parse one bounded UTF-8 document without applying the single-line text
    /// secret policy.  Structured protected inputs may contain formatting
    /// whitespace; their schema is validated by the owning boundary.
    pub(crate) fn from_owned_document(
        mut bytes: Vec<u8>,
        max_bytes: usize,
    ) -> Result<Self, SafeError> {
        if max_bytes > MAX_TEXT_SECRET_BYTES || bytes.len() > max_bytes {
            bytes.zeroize();
            return Err(SafeError::new(SECRET_TOO_LARGE));
        }
        if bytes.is_empty() || str::from_utf8(&bytes).is_err() {
            bytes.zeroize();
            return Err(SafeError::new(SECRET_INVALID));
        }
        Ok(Self::new(bytes))
    }

    /// Decode a canonical standard-base64 state key containing exactly 32
    /// decoded bytes.  The encoded value is not trimmed: no whitespace is
    /// accepted in the state-key representation.
    pub fn from_state_key_base64(bytes: &[u8]) -> Result<Self, SafeError> {
        if bytes.len() != STATE_KEY_ENCODED_BYTES {
            return Err(SafeError::new(SECRET_INVALID));
        }
        Self::from_owned_state_key_base64(bytes.to_vec())
    }

    /// Decode an owned state-key file without making an additional copy.
    pub(crate) fn from_owned_state_key_base64(mut encoded: Vec<u8>) -> Result<Self, SafeError> {
        // 32 bytes have one canonical padded STANDARD representation: 44
        // ASCII bytes.  Checking the length first also bounds decoder work.
        if encoded.len() != STATE_KEY_ENCODED_BYTES
            || encoded.iter().any(|byte| {
                !matches!(
                    *byte,
                    b'A'..=b'Z'
                        | b'a'..=b'z'
                        | b'0'..=b'9'
                        | b'+'
                        | b'/'
                        | b'='
                )
            })
        {
            encoded.zeroize();
            return Err(SafeError::new(SECRET_INVALID));
        }

        let mut decoded = match STANDARD.decode(&encoded) {
            Ok(decoded) if decoded.len() == 32 => decoded,
            Ok(mut decoded) => {
                decoded.zeroize();
                encoded.zeroize();
                return Err(SafeError::new(SECRET_INVALID));
            }
            Err(_) => {
                encoded.zeroize();
                return Err(SafeError::new(SECRET_INVALID));
            }
        };

        // Reject alternate encodings with non-zero padding bits.  This keeps
        // the state-key representation canonical instead of accepting every
        // byte sequence that a permissive decoder can map to 32 bytes.
        let mut canonical = STANDARD.encode(&decoded).into_bytes();
        let is_canonical = canonical == encoded;
        canonical.zeroize();
        if !is_canonical {
            decoded.zeroize();
            encoded.zeroize();
            return Err(SafeError::new(SECRET_INVALID));
        }

        encoded.zeroize();
        Ok(Self::new(decoded))
    }
}

impl fmt::Debug for SecretBytes {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("[REDACTED]")
    }
}

impl fmt::Display for SecretBytes {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("[REDACTED]")
    }
}

impl Drop for SecretBytes {
    fn drop(&mut self) {
        self.bytes.zeroize();
    }
}

/// The byte-level format expected for each protected secret file.
#[derive(Clone, Copy, Eq, PartialEq)]
pub enum SecretKind {
    /// A non-empty UTF-8, single-line secret with a bounded file size.
    Text { max_bytes: usize },
    /// A bounded UTF-8 structured document whose schema is checked by its caller.
    Document { max_bytes: usize },
    /// A canonical standard-base64 encoding of a 32-byte state key.
    StateKey,
}

/// Open, validate, and parse one protected secret file.
///
/// The file is first opened through `openat2` with `O_PATH`, no-symlink, and
/// beneath-root resolution.  After its metadata is checked, it is reopened
/// through its proc-fd link and the metadata is checked again before reading.
/// This keeps the metadata check tied to the inode that is read and prevents
/// path components from being redirected during resolution.  Every filesystem
/// and parse failure is reduced to a stable code; neither the path nor an
/// operating-system error is retained.
pub fn load_secret(path: &Path, kind: SecretKind) -> Result<SecretBytes, SafeError> {
    if !path.is_absolute() {
        return Err(SafeError::new(SECRET_INVALID));
    }
    if path
        .components()
        .any(|component| matches!(component, Component::ParentDir))
    {
        return Err(SafeError::new(SECRET_INVALID));
    }

    let max_bytes = match kind {
        SecretKind::Text { max_bytes } | SecretKind::Document { max_bytes } => max_bytes,
        SecretKind::StateKey => STATE_KEY_ENCODED_BYTES,
    };
    if max_bytes > MAX_TEXT_SECRET_BYTES {
        return Err(SafeError::new(SECRET_TOO_LARGE));
    }

    let root = openat(
        CWD,
        Path::new("/"),
        OFlags::RDONLY | OFlags::CLOEXEC | OFlags::DIRECTORY,
        Mode::empty(),
    )
    .map_err(|_| SafeError::new(SECRET_INVALID))?;
    let relative_path = path
        .strip_prefix(Path::new("/"))
        .map_err(|_| SafeError::new(SECRET_INVALID))?;
    let expected_uid = geteuid().as_raw();
    let path_handle = openat2(
        &root,
        relative_path,
        OFlags::PATH | OFlags::CLOEXEC | OFlags::NOFOLLOW,
        Mode::empty(),
        ResolveFlags::BENEATH | ResolveFlags::NO_SYMLINKS,
    )
    .map_err(|_| SafeError::new(SECRET_INVALID))?;

    let metadata = rustix::fs::fstat(&path_handle).map_err(|_| SafeError::new(SECRET_INVALID))?;
    if !acceptable_metadata(&metadata, expected_uid) {
        return Err(SafeError::new(SECRET_INVALID));
    }

    let file_size = match usize::try_from(metadata.st_size) {
        Ok(size) => size,
        Err(_) => return Err(SafeError::new(SECRET_INVALID)),
    };
    if file_size > max_bytes {
        return Err(SafeError::new(SECRET_TOO_LARGE));
    }

    // `path_handle` was opened with O_PATH, so no read-capable descriptor was
    // obtained until the target had passed the type, owner, mode, and size
    // checks above.  `/proc/self/fd/N` reopens the exact inode held by this
    // descriptor; it does not resolve the caller-controlled path again.
    let proc_fd_path = Path::new("/proc/self/fd").join(DecInt::from_fd(&path_handle));
    let file = openat(
        CWD,
        proc_fd_path,
        OFlags::RDONLY | OFlags::CLOEXEC,
        Mode::empty(),
    )
    .map_err(|_| SafeError::new(SECRET_INVALID))?;
    let reopened_metadata = rustix::fs::fstat(&file).map_err(|_| SafeError::new(SECRET_INVALID))?;
    if !acceptable_metadata(&reopened_metadata, expected_uid)
        || !same_verified_metadata(&metadata, &reopened_metadata)
    {
        return Err(SafeError::new(SECRET_INVALID));
    }

    let mut bytes = read_bounded(&file, file_size)?;

    // Reject a size/metadata change while the descriptor was being read.  The
    // fd still identifies the same opened inode, so this closes the common
    // truncate/grow race without ever reopening the path.
    let final_metadata = match rustix::fs::fstat(&file) {
        Ok(metadata) => metadata,
        Err(_) => {
            bytes.zeroize();
            return Err(SafeError::new(SECRET_INVALID));
        }
    };
    if !acceptable_metadata(&final_metadata, expected_uid)
        || !same_verified_metadata(&metadata, &final_metadata)
    {
        let error = if final_metadata.st_size > metadata.st_size
            && usize::try_from(final_metadata.st_size).is_ok_and(|size| size > max_bytes)
        {
            SafeError::new(SECRET_TOO_LARGE)
        } else {
            SafeError::new(SECRET_INVALID)
        };
        bytes.zeroize();
        return Err(error);
    }

    parse_secret(bytes, kind)
}

#[derive(Clone, Copy)]
struct MetadataPolicyInput {
    mode: u32,
    uid: u32,
    size: i64,
}

fn acceptable_metadata(metadata: &rustix::fs::Stat, expected_uid: u32) -> bool {
    acceptable_metadata_input(
        MetadataPolicyInput {
            mode: metadata.st_mode,
            uid: metadata.st_uid,
            size: metadata.st_size,
        },
        expected_uid,
    )
}

fn acceptable_metadata_input(input: MetadataPolicyInput, expected_uid: u32) -> bool {
    FileType::from_raw_mode(input.mode) == FileType::RegularFile
        && Mode::from_raw_mode(input.mode).as_raw_mode() == 0o600
        && input.uid == expected_uid
        && input.size >= 0
}

fn same_verified_metadata(left: &rustix::fs::Stat, right: &rustix::fs::Stat) -> bool {
    left.st_dev == right.st_dev
        && left.st_ino == right.st_ino
        && left.st_mode == right.st_mode
        && left.st_uid == right.st_uid
        && left.st_gid == right.st_gid
        && left.st_size == right.st_size
}

fn read_bounded(file: &rustix::fd::OwnedFd, file_size: usize) -> Result<Vec<u8>, SafeError> {
    let mut bytes = vec![0_u8; file_size];
    let mut offset = 0;
    while offset < file_size {
        let read_count = match read(file, &mut bytes[offset..]) {
            Ok(read_count) => read_count,
            Err(_) => {
                bytes.zeroize();
                return Err(SafeError::new(SECRET_INVALID));
            }
        };
        if read_count == 0 {
            bytes.zeroize();
            return Err(SafeError::new(SECRET_INVALID));
        }
        offset += read_count;
    }
    Ok(bytes)
}

/// Parse bytes according to a protected secret's declared format.
pub(crate) fn parse_secret(bytes: Vec<u8>, kind: SecretKind) -> Result<SecretBytes, SafeError> {
    match kind {
        SecretKind::Text { max_bytes } => SecretBytes::from_owned_text(bytes, max_bytes),
        SecretKind::Document { max_bytes } => SecretBytes::from_owned_document(bytes, max_bytes),
        SecretKind::StateKey => SecretBytes::from_owned_state_key_base64(bytes),
    }
}

fn is_rejected_text_char(character: char) -> bool {
    character.is_control() || matches!(character, '\u{2028}' | '\u{2029}')
}

#[cfg(test)]
mod tests {
    use super::{MetadataPolicyInput, acceptable_metadata_input};

    #[test]
    fn metadata_policy_rejects_a_mismatched_uid() {
        let input = MetadataPolicyInput {
            mode: 0o100600,
            uid: 1001,
            size: 1,
        };

        assert!(!acceptable_metadata_input(input, 1000));
        assert!(acceptable_metadata_input(
            MetadataPolicyInput { uid: 1000, ..input },
            1000
        ));
    }
}
