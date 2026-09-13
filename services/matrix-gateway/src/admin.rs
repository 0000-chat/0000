//! Offline administration for the protected Matrix-room registry.
//!
//! Registry commands accept only bounded, protected input and use the store's
//! exclusive lock for every operation.  The summary reader holds that lock
//! while it decrypts rows, so it cannot race the daemon or expose mapping
//! payloads through a second mutating path.

use std::{
    collections::BTreeMap,
    ffi::OsString,
    fmt,
    io::{self, IsTerminal, Read},
    path::{Component, Path, PathBuf},
};

use chrono::{DateTime, TimeZone, Utc};
use rusqlite::{Connection, OpenFlags};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use uuid::Uuid;
use zeroize::Zeroizing;

use crate::{
    config::GATEWAY_SCHEMA_VERSION,
    crypto::{Keyring, Sealed},
    health,
    model::Provider,
    registry::{NewRoomBinding, RoomBindingPayload, RoomBindingStatus, valid_binding_id},
    secret::{SafeError, SecretBytes, SecretKind, load_secret},
    store::{Store, StoreError},
    store_types::ReasonCode,
};

/// Maximum encoded bytes accepted for one administrative JSON document.
pub const MAX_REGISTRY_DOCUMENT_BYTES: usize = 64 * 1024;
/// Maximum path bytes accepted by the administrative argument parser.
pub const MAX_ADMIN_PATH_BYTES: usize = 4 * 1024;
/// Maximum registry rows the summary command will inspect in one invocation.
pub const MAX_REGISTRY_ROWS: usize = 100_000;

const ADMIN_INVALID_ARGUMENTS: &str = "admin_invalid_arguments";
const ADMIN_INPUT_INVALID: &str = "admin_input_invalid";
const ADMIN_INPUT_TOO_LARGE: &str = "admin_input_too_large";
const ADMIN_STDIN_TTY: &str = "admin_stdin_tty";
const ADMIN_REGISTRY_INVALID: &str = "admin_registry_invalid";
const ADMIN_REGISTRY_TOO_LARGE: &str = "admin_registry_too_large";
const ADMIN_KEY_INVALID: &str = "admin_key_invalid";
const ADMIN_OUTPUT_INVALID: &str = "admin_output_invalid";
const ADMIN_NOW_INVALID: &str = "admin_time_invalid";

/// A stable, content-free administrative error.
#[derive(Clone, Copy, Eq, PartialEq)]
pub struct AdminError {
    code: &'static str,
}

/// Construct the stable invalid-argument error used by top-level dispatch.
pub const fn invalid_arguments() -> AdminError {
    AdminError::new(ADMIN_INVALID_ARGUMENTS)
}

impl AdminError {
    const fn new(code: &'static str) -> Self {
        Self { code }
    }

    /// Return the stable machine-readable error code.
    pub const fn code(self) -> &'static str {
        self.code
    }

    /// Map one stable administrative failure to the process-level exit class
    /// used by the command-line contract.
    pub fn exit_code(self) -> u8 {
        match self.code {
            ADMIN_INVALID_ARGUMENTS
            | ADMIN_INPUT_INVALID
            | ADMIN_INPUT_TOO_LARGE
            | ADMIN_STDIN_TTY => 64,
            ADMIN_OUTPUT_INVALID
            | ADMIN_NOW_INVALID
            | ADMIN_KEY_INVALID
            | ADMIN_REGISTRY_INVALID
            | ADMIN_REGISTRY_TOO_LARGE => 74,
            code if code.starts_with("store_") || code.starts_with("health_") => 74,
            _ => 78,
        }
    }
}

impl fmt::Debug for AdminError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("AdminError")
            .field("code", &self.code)
            .finish()
    }
}

impl fmt::Display for AdminError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.code)
    }
}

impl std::error::Error for AdminError {}

impl From<SafeError> for AdminError {
    fn from(error: SafeError) -> Self {
        Self::new(error.code())
    }
}

impl From<StoreError> for AdminError {
    fn from(error: StoreError) -> Self {
        Self::new(error.code())
    }
}

#[derive(Clone, Copy)]
enum Operation {
    Add,
    Retire,
    ListSummary,
}

struct Options {
    operation: Operation,
    database: PathBuf,
    key_file: PathBuf,
    input: Option<InputSource>,
}

enum InputSource {
    File(PathBuf),
    Stdin,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct AddDocument {
    schema_version: i64,
    matrix_room_id: String,
    tenant_id: String,
    identity_id: String,
    connection_id: String,
    account_id: String,
    platform: Provider,
    gateway_route_id: String,
    conversation_id: String,
    owner_matrix_user_id: String,
    session_generation: String,
}

impl AddDocument {
    fn into_binding(
        self,
        binding_id: String,
        created_at: DateTime<Utc>,
    ) -> Result<NewRoomBinding, AdminError> {
        if self.schema_version != GATEWAY_SCHEMA_VERSION {
            return Err(AdminError::new(ADMIN_INPUT_INVALID));
        }

        NewRoomBinding::new_with_session_generation(
            binding_id,
            self.matrix_room_id,
            self.tenant_id,
            self.identity_id,
            self.connection_id,
            self.account_id,
            self.platform,
            self.gateway_route_id,
            self.conversation_id,
            self.owner_matrix_user_id,
            self.session_generation,
            created_at,
        )
        .map_err(|_| AdminError::new(ADMIN_INPUT_INVALID))
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RetireDocument {
    schema_version: i64,
    binding_id: String,
    reason_code: String,
}

#[derive(Serialize)]
struct AddResult {
    binding_id: String,
    status: &'static str,
}

#[derive(Serialize)]
struct RetireResult {
    status: &'static str,
}

#[derive(Default, Serialize)]
struct StatusCounts {
    active: u64,
    retired: u64,
}

#[derive(Serialize)]
struct RegistrySummary {
    providers: BTreeMap<String, StatusCounts>,
}

struct SummaryRow {
    binding_id: String,
    payload_cipher: Vec<u8>,
    payload_nonce: Vec<u8>,
    key_version: i64,
    status: String,
}

/// Execute one offline registry command and return its credential-free JSON
/// result.  The argument slice excludes the process name.
pub fn run(args: &[OsString]) -> Result<String, AdminError> {
    let options = parse_options(args)?;
    match options.operation {
        Operation::Add => run_add(options),
        Operation::Retire => run_retire(options),
        Operation::ListSummary => run_list_summary(options),
    }
}

/// Execute the read-only healthcheck command.  The exit class is returned
/// separately because a blocked state is a valid JSON response with a
/// non-zero health status, rather than an argument or I/O failure.
pub fn healthcheck(args: &[OsString]) -> Result<(String, u8), AdminError> {
    if args.first().and_then(|value| value.to_str()) != Some("healthcheck") {
        return Err(AdminError::new(ADMIN_INVALID_ARGUMENTS));
    }
    let database = parse_single_state_db(args, 1)?;
    let report = health::inspect_at(&database, current_timestamp()?)
        .map_err(|error| AdminError::new(error.code()))?;
    let exit_code = u8::try_from(report.exit_code()).unwrap_or(74);
    Ok((report.to_json(), exit_code))
}

/// Execute the bounded quarantine status command while holding the store's
/// exclusive lock.
pub fn quarantine_status(args: &[OsString]) -> Result<String, AdminError> {
    if args.len() < 2
        || args[0].to_str() != Some("quarantine")
        || args[1].to_str() != Some("status")
    {
        return Err(AdminError::new(ADMIN_INVALID_ARGUMENTS));
    }
    let (database, key_file) = parse_state_options(args, 2)?;
    let key = load_key_material(&key_file)?;
    let store = Store::open(&database, keyring(&key)?)?;
    let pressure = store.ledger_pressure()?;
    let status = if pressure.quarantined_windows() == 0 {
        "clear"
    } else {
        "quarantined"
    };
    Ok(format!(
        r#"{{"schema_version":1,"status":"{status}","pending_batches":{},"pending_bytes":{},"quarantined_windows":{}}}"#,
        pressure.pending_batches(),
        pressure.pending_bytes(),
        pressure.quarantined_windows(),
    ))
}

/// Reopen one explicitly named quarantined window.  The store operation is
/// atomic and leaves accepted sibling batches untouched.
pub fn quarantine_retry(args: &[OsString]) -> Result<String, AdminError> {
    if args.len() < 2 || args[0].to_str() != Some("quarantine") || args[1].to_str() != Some("retry")
    {
        return Err(AdminError::new(ADMIN_INVALID_ARGUMENTS));
    }
    let mut window_id = None;
    let mut database = None;
    let mut key_file = None;
    let mut index = 2;
    while index < args.len() {
        let argument = args[index]
            .to_str()
            .ok_or_else(|| AdminError::new(ADMIN_INVALID_ARGUMENTS))?;
        let (name, inline_value) = match argument.split_once('=') {
            Some((name, value)) => (name, Some(OsString::from(value))),
            None => (argument, None),
        };
        index += 1;
        match name {
            "--window-id" => {
                if window_id.is_some() {
                    return Err(AdminError::new(ADMIN_INVALID_ARGUMENTS));
                }
                let value = option_value(args, &mut index, inline_value)?;
                let value = value
                    .into_string()
                    .map_err(|_| AdminError::new(ADMIN_INVALID_ARGUMENTS))?;
                if !valid_window_id(&value) {
                    return Err(AdminError::new(ADMIN_INVALID_ARGUMENTS));
                }
                window_id = Some(value);
            }
            "--state-db" | "--db" | "--database" => {
                if database.is_some() {
                    return Err(AdminError::new(ADMIN_INVALID_ARGUMENTS));
                }
                database = Some(parse_path(option_value(args, &mut index, inline_value)?)?);
            }
            "--state-key-file" | "--state-key" | "--key-file" | "--key" => {
                if key_file.is_some() {
                    return Err(AdminError::new(ADMIN_INVALID_ARGUMENTS));
                }
                key_file = Some(parse_path(option_value(args, &mut index, inline_value)?)?);
            }
            _ => return Err(AdminError::new(ADMIN_INVALID_ARGUMENTS)),
        }
    }
    let window_id = window_id.ok_or_else(|| AdminError::new(ADMIN_INVALID_ARGUMENTS))?;
    let database = database.ok_or_else(|| AdminError::new(ADMIN_INVALID_ARGUMENTS))?;
    let key_file = key_file.ok_or_else(|| AdminError::new(ADMIN_INVALID_ARGUMENTS))?;
    let key = load_key_material(&key_file)?;
    let mut store = Store::open(&database, keyring(&key)?)?;
    store.retry_quarantined_window(&window_id, current_timestamp()?)?;
    Ok(r#"{"schema_version":1,"status":"retry_scheduled"}"#.to_owned())
}

/// Return bounded crypto-maintenance state without exposing protected rows.
pub fn crypto_status(args: &[OsString]) -> Result<String, AdminError> {
    if args.len() < 2 || args[0].to_str() != Some("crypto") || args[1].to_str() != Some("status") {
        return Err(AdminError::new(ADMIN_INVALID_ARGUMENTS));
    }
    let (database, key_file) = parse_state_options(args, 2)?;
    let key = load_key_material(&key_file)?;
    let store = Store::open(&database, keyring(&key)?)?;
    match store.crypto_maintenance_status()? {
        Some(status) => Ok(format!(
            r#"{{"schema_version":1,"status":"maintenance","maintenance_code":"{}"}}"#,
            status.code().as_str()
        )),
        None => Ok(r#"{"schema_version":1,"status":"clear","maintenance_code":null}"#.to_owned()),
    }
}

/// Validate and expose a path argument to the binary's run command.
pub fn absolute_path(value: OsString) -> Result<PathBuf, AdminError> {
    parse_path(value)
}

fn parse_single_state_db(args: &[OsString], start: usize) -> Result<PathBuf, AdminError> {
    let mut database = None;
    let mut index = start;
    while index < args.len() {
        let argument = args[index]
            .to_str()
            .ok_or_else(|| AdminError::new(ADMIN_INVALID_ARGUMENTS))?;
        let (name, inline_value) = match argument.split_once('=') {
            Some((name, value)) => (name, Some(OsString::from(value))),
            None => (argument, None),
        };
        index += 1;
        if name != "--state-db" {
            return Err(AdminError::new(ADMIN_INVALID_ARGUMENTS));
        }
        if database.is_some() {
            return Err(AdminError::new(ADMIN_INVALID_ARGUMENTS));
        }
        database = Some(parse_path(option_value(args, &mut index, inline_value)?)?);
    }
    database.ok_or_else(|| AdminError::new(ADMIN_INVALID_ARGUMENTS))
}

fn parse_state_options(args: &[OsString], start: usize) -> Result<(PathBuf, PathBuf), AdminError> {
    let mut database = None;
    let mut key_file = None;
    let mut index = start;
    while index < args.len() {
        let argument = args[index]
            .to_str()
            .ok_or_else(|| AdminError::new(ADMIN_INVALID_ARGUMENTS))?;
        let (name, inline_value) = match argument.split_once('=') {
            Some((name, value)) => (name, Some(OsString::from(value))),
            None => (argument, None),
        };
        index += 1;
        match name {
            "--state-db" => {
                if database.is_some() {
                    return Err(AdminError::new(ADMIN_INVALID_ARGUMENTS));
                }
                database = Some(parse_path(option_value(args, &mut index, inline_value)?)?);
            }
            "--state-key-file" => {
                if key_file.is_some() {
                    return Err(AdminError::new(ADMIN_INVALID_ARGUMENTS));
                }
                key_file = Some(parse_path(option_value(args, &mut index, inline_value)?)?);
            }
            _ => return Err(AdminError::new(ADMIN_INVALID_ARGUMENTS)),
        }
    }
    Ok((
        database.ok_or_else(|| AdminError::new(ADMIN_INVALID_ARGUMENTS))?,
        key_file.ok_or_else(|| AdminError::new(ADMIN_INVALID_ARGUMENTS))?,
    ))
}

fn valid_window_id(value: &str) -> bool {
    value.len() == "window_".len() + 64
        && value.starts_with("window_")
        && value["window_".len()..]
            .bytes()
            .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
}

fn parse_options(args: &[OsString]) -> Result<Options, AdminError> {
    if args.len() < 2 || args[0].to_str() != Some("registry") {
        return Err(AdminError::new(ADMIN_INVALID_ARGUMENTS));
    }

    let operation = match args[1].to_str() {
        Some("add") => Operation::Add,
        Some("retire") => Operation::Retire,
        Some("list-summary") => Operation::ListSummary,
        _ => return Err(AdminError::new(ADMIN_INVALID_ARGUMENTS)),
    };

    let mut database = None;
    let mut key_file = None;
    let mut input = None;
    let mut index = 2;
    while index < args.len() {
        let argument = args[index]
            .to_str()
            .ok_or_else(|| AdminError::new(ADMIN_INVALID_ARGUMENTS))?;
        let (name, inline_value) = match argument.split_once('=') {
            Some((name, value)) => (name, Some(OsString::from(value))),
            None => (argument, None),
        };
        index += 1;

        match name {
            "--state-db" | "--db" | "--database" => {
                if database.is_some() {
                    return Err(AdminError::new(ADMIN_INVALID_ARGUMENTS));
                }
                let value = option_value(args, &mut index, inline_value)?;
                database = Some(parse_path(value)?);
            }
            "--state-key-file" | "--state-key" | "--key-file" | "--key" => {
                if key_file.is_some() {
                    return Err(AdminError::new(ADMIN_INVALID_ARGUMENTS));
                }
                let value = option_value(args, &mut index, inline_value)?;
                key_file = Some(parse_path(value)?);
            }
            "--input" | "--input-file" | "--mapping-file" => {
                if input.is_some() {
                    return Err(AdminError::new(ADMIN_INVALID_ARGUMENTS));
                }
                let value = option_value(args, &mut index, inline_value)?;
                input = Some(parse_input(value)?);
            }
            _ => return Err(AdminError::new(ADMIN_INVALID_ARGUMENTS)),
        }
    }

    let database = database.ok_or_else(|| AdminError::new(ADMIN_INVALID_ARGUMENTS))?;
    let key_file = key_file.ok_or_else(|| AdminError::new(ADMIN_INVALID_ARGUMENTS))?;
    if !matches!(operation, Operation::ListSummary) && input.is_none() {
        return Err(AdminError::new(ADMIN_INVALID_ARGUMENTS));
    }
    if matches!(operation, Operation::ListSummary) && input.is_some() {
        return Err(AdminError::new(ADMIN_INVALID_ARGUMENTS));
    }

    Ok(Options {
        operation,
        database,
        key_file,
        input,
    })
}

fn option_value(
    args: &[OsString],
    index: &mut usize,
    inline_value: Option<OsString>,
) -> Result<OsString, AdminError> {
    if let Some(value) = inline_value {
        return Ok(value);
    }

    let value = args
        .get(*index)
        .cloned()
        .ok_or_else(|| AdminError::new(ADMIN_INVALID_ARGUMENTS))?;
    if value
        .to_str()
        .is_none_or(|value| value.is_empty() || value.starts_with("--"))
    {
        return Err(AdminError::new(ADMIN_INVALID_ARGUMENTS));
    }
    *index += 1;
    Ok(value)
}

fn parse_path(value: OsString) -> Result<PathBuf, AdminError> {
    let path = PathBuf::from(value);
    let text = path
        .to_str()
        .ok_or_else(|| AdminError::new(ADMIN_INVALID_ARGUMENTS))?;
    if text.len() > MAX_ADMIN_PATH_BYTES
        || !path.is_absolute()
        || path
            .components()
            .any(|component| matches!(component, Component::ParentDir))
    {
        return Err(AdminError::new(ADMIN_INVALID_ARGUMENTS));
    }
    Ok(path)
}

fn parse_input(value: OsString) -> Result<InputSource, AdminError> {
    if value.to_str() == Some("-") {
        Ok(InputSource::Stdin)
    } else {
        Ok(InputSource::File(parse_path(value)?))
    }
}

fn run_add(options: Options) -> Result<String, AdminError> {
    let input = options
        .input
        .as_ref()
        .ok_or_else(|| AdminError::new(ADMIN_INVALID_ARGUMENTS))?;
    let document = parse_document::<AddDocument>(read_document(input)?)?;
    let binding_id = format!("binding_{}", Uuid::new_v4().simple());
    let binding = document.into_binding(binding_id.clone(), current_timestamp()?)?;
    let key = load_key_material(&options.key_file)?;
    let mut store = Store::open(&options.database, keyring(&key)?)?;
    store.append_room_binding(binding)?;

    serde_json::to_string(&AddResult {
        binding_id,
        status: "active",
    })
    .map_err(|_| AdminError::new(ADMIN_OUTPUT_INVALID))
}

fn run_retire(options: Options) -> Result<String, AdminError> {
    let input = options
        .input
        .as_ref()
        .ok_or_else(|| AdminError::new(ADMIN_INVALID_ARGUMENTS))?;
    let document = parse_document::<RetireDocument>(read_document(input)?)?;
    if document.schema_version != GATEWAY_SCHEMA_VERSION {
        return Err(AdminError::new(ADMIN_INPUT_INVALID));
    }
    ReasonCode::new(document.reason_code).map_err(|_| AdminError::new(ADMIN_INPUT_INVALID))?;
    let key = load_key_material(&options.key_file)?;
    let mut store = Store::open(&options.database, keyring(&key)?)?;
    store.retire_room_binding(&document.binding_id, current_timestamp()?)?;

    serde_json::to_string(&RetireResult { status: "retired" })
        .map_err(|_| AdminError::new(ADMIN_OUTPUT_INVALID))
}

fn run_list_summary(options: Options) -> Result<String, AdminError> {
    let key = load_key_material(&options.key_file)?;
    let store = Store::open(&options.database, keyring(&key)?)?;
    let summary_keyring = keyring(&key)?;
    let summary = read_summary(&options.database, &summary_keyring);
    drop(store);
    serde_json::to_string(&summary?).map_err(|_| AdminError::new(ADMIN_OUTPUT_INVALID))
}

fn parse_document<T>(document: SecretBytes) -> Result<T, AdminError>
where
    T: DeserializeOwned,
{
    serde_json::from_slice(document.as_bytes()).map_err(|_| AdminError::new(ADMIN_INPUT_INVALID))
}

fn read_document(source: &InputSource) -> Result<SecretBytes, AdminError> {
    match source {
        InputSource::File(path) => load_secret(
            path,
            SecretKind::Document {
                max_bytes: MAX_REGISTRY_DOCUMENT_BYTES,
            },
        )
        .map_err(Into::into),
        InputSource::Stdin => {
            let stdin = io::stdin();
            if stdin.is_terminal() {
                return Err(AdminError::new(ADMIN_STDIN_TTY));
            }
            let mut bytes = Vec::new();
            let mut reader = stdin.lock().take((MAX_REGISTRY_DOCUMENT_BYTES + 1) as u64);
            reader
                .read_to_end(&mut bytes)
                .map_err(|_| AdminError::new(ADMIN_INPUT_INVALID))?;
            if bytes.len() > MAX_REGISTRY_DOCUMENT_BYTES {
                return Err(AdminError::new(ADMIN_INPUT_TOO_LARGE));
            }
            SecretBytes::from_owned_document(bytes, MAX_REGISTRY_DOCUMENT_BYTES).map_err(Into::into)
        }
    }
}

fn load_key_material(path: &Path) -> Result<Zeroizing<[u8; 32]>, AdminError> {
    let key = load_secret(path, SecretKind::StateKey)?;
    let mut material = Zeroizing::new([0_u8; 32]);
    material.copy_from_slice(key.as_bytes());
    Ok(material)
}

fn keyring(key: &[u8; 32]) -> Result<Keyring, AdminError> {
    Keyring::new(*key, 1).map_err(|_| AdminError::new(ADMIN_KEY_INVALID))
}

fn current_timestamp() -> Result<DateTime<Utc>, AdminError> {
    let milliseconds = Utc::now().timestamp_millis();
    Utc.timestamp_millis_opt(milliseconds)
        .single()
        .ok_or_else(|| AdminError::new(ADMIN_NOW_INVALID))
}

fn read_summary(path: &Path, keyring: &Keyring) -> Result<RegistrySummary, AdminError> {
    let connection = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|_| AdminError::new(ADMIN_REGISTRY_INVALID))?;
    connection
        .execute_batch("PRAGMA query_only = ON;")
        .map_err(|_| AdminError::new(ADMIN_REGISTRY_INVALID))?;
    let mut statement = connection
        .prepare(
            "SELECT binding_id, payload_cipher, payload_nonce, key_version, status
             FROM room_bindings ORDER BY binding_id",
        )
        .map_err(|_| AdminError::new(ADMIN_REGISTRY_INVALID))?;
    let mut rows = statement
        .query([])
        .map_err(|_| AdminError::new(ADMIN_REGISTRY_INVALID))?;

    let mut summary = RegistrySummary {
        providers: Provider::ALL
            .iter()
            .map(|provider| (provider.as_str().to_owned(), StatusCounts::default()))
            .collect(),
    };
    let mut row_count = 0_usize;
    while let Some(row) = rows
        .next()
        .map_err(|_| AdminError::new(ADMIN_REGISTRY_INVALID))?
    {
        row_count = row_count
            .checked_add(1)
            .ok_or_else(|| AdminError::new(ADMIN_REGISTRY_TOO_LARGE))?;
        if row_count > MAX_REGISTRY_ROWS {
            return Err(AdminError::new(ADMIN_REGISTRY_TOO_LARGE));
        }
        let stored = SummaryRow {
            binding_id: row
                .get(0)
                .map_err(|_| AdminError::new(ADMIN_REGISTRY_INVALID))?,
            payload_cipher: row
                .get(1)
                .map_err(|_| AdminError::new(ADMIN_REGISTRY_INVALID))?,
            payload_nonce: row
                .get(2)
                .map_err(|_| AdminError::new(ADMIN_REGISTRY_INVALID))?,
            key_version: row
                .get(3)
                .map_err(|_| AdminError::new(ADMIN_REGISTRY_INVALID))?,
            status: row
                .get(4)
                .map_err(|_| AdminError::new(ADMIN_REGISTRY_INVALID))?,
        };
        add_summary_row(&mut summary, keyring, stored)?;
    }

    Ok(summary)
}

fn add_summary_row(
    summary: &mut RegistrySummary,
    keyring: &Keyring,
    row: SummaryRow,
) -> Result<(), AdminError> {
    if !valid_binding_id(&row.binding_id) {
        return Err(AdminError::new(ADMIN_REGISTRY_INVALID));
    }
    let nonce: [u8; 24] = row
        .payload_nonce
        .try_into()
        .map_err(|_| AdminError::new(ADMIN_REGISTRY_INVALID))?;
    let key_version =
        u32::try_from(row.key_version).map_err(|_| AdminError::new(ADMIN_REGISTRY_INVALID))?;
    let sealed = Sealed {
        nonce,
        ciphertext: row.payload_cipher,
        key_version,
    };
    let plaintext = keyring
        .open("room_bindings", &row.binding_id, "payload", &sealed)
        .map_err(|_| AdminError::new(ADMIN_REGISTRY_INVALID))?;
    let payload = RoomBindingPayload::from_json(plaintext.as_bytes())
        .map_err(|_| AdminError::new(ADMIN_REGISTRY_INVALID))?;
    let status = RoomBindingStatus::from_str(&row.status)
        .map_err(|_| AdminError::new(ADMIN_REGISTRY_INVALID))?;
    if status.as_str() != row.status {
        return Err(AdminError::new(ADMIN_REGISTRY_INVALID));
    }
    let provider = payload.authority_tuple().4;
    let counts = summary
        .providers
        .get_mut(provider.as_str())
        .ok_or_else(|| AdminError::new(ADMIN_REGISTRY_INVALID))?;
    match status {
        RoomBindingStatus::Active => {
            counts.active = counts
                .active
                .checked_add(1)
                .ok_or_else(|| AdminError::new(ADMIN_REGISTRY_TOO_LARGE))?;
        }
        RoomBindingStatus::Retired => {
            counts.retired = counts
                .retired
                .checked_add(1)
                .ok_or_else(|| AdminError::new(ADMIN_REGISTRY_TOO_LARGE))?;
        }
    }
    Ok(())
}
