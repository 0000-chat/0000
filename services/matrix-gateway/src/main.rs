use std::{
    ffi::OsString,
    fs,
    io::{self, Write},
    path::Path,
    process::ExitCode,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};

use async_trait::async_trait;
use chrono::{DateTime, TimeZone, Utc};
use rand_core::{OsRng, RngCore};

use communicator_matrix_gateway::{
    admin::{self, AdminError},
    config::{GatewayConfig, MAX_CONFIG_JSON_BYTES},
    crypto::Keyring,
    history::HistoryGatewayServer,
    ingestion::{IngestionClient, OAuthTokenProvider, SecretString},
    matrix::{
        MATRIX_SESSION_INVALID, MatrixProcessor, matrix_access_token, restore_matrix_client,
        restore_matrix_processor,
    },
    matrix_http::ReqwestMatrixTransport,
    outbound::{MatrixSdkGroupManager, MatrixSdkTextSender},
    provisioning::{
        GatewayRouteMetadata, ProvisioningGatewayServer, WhatsAppProvisioningClient,
        serve_private_gateway,
    },
    secret::{MAX_TEXT_SECRET_BYTES, SafeError, SecretKind, load_secret},
    service::{Clock, GatewayService, JitterSource, RetryPolicy, Shutdown},
    store::Store,
    store_types::ReasonCode,
};

const CONFIG_INVALID: &str = "config_invalid";
const RUNTIME_SIGNAL_INVALID: &str = "runtime_signal_invalid";
const RUNTIME_OUTPUT_INVALID: &str = "admin_output_invalid";

static PROCESS_SIGNAL_REQUESTED: AtomicBool = AtomicBool::new(false);

extern "C" fn process_signal_handler(_signal: libc::c_int) {
    PROCESS_SIGNAL_REQUESTED.store(true, Ordering::Release);
}

#[derive(Clone)]
struct SignalShutdown {
    requested: Arc<AtomicBool>,
}

impl SignalShutdown {
    fn new() -> Self {
        Self {
            requested: Arc::new(AtomicBool::new(false)),
        }
    }
}

#[async_trait]
impl Shutdown for SignalShutdown {
    fn requested(&self) -> bool {
        self.requested.load(Ordering::Acquire) || PROCESS_SIGNAL_REQUESTED.load(Ordering::Acquire)
    }

    async fn wait_requested(&self) {
        while !self.requested() {
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    }
}

struct SystemClock;

impl Clock for SystemClock {
    fn now(&self) -> DateTime<Utc> {
        let millis = Utc::now().timestamp_millis();
        Utc.timestamp_millis_opt(millis)
            .single()
            .expect("current UTC timestamp must be representable")
    }
}

struct SystemJitter(OsRng);

impl JitterSource for SystemJitter {
    fn sample_ms(&mut self, inclusive_max_ms: u64) -> u64 {
        if inclusive_max_ms == 0 {
            0
        } else {
            self.0.next_u64() % inclusive_max_ms.saturating_add(1)
        }
    }
}

fn read_config(path: &Path) -> Result<GatewayConfig, SafeError> {
    let bytes = fs::read(path).map_err(|_| SafeError::new(CONFIG_INVALID))?;
    if bytes.len() > MAX_CONFIG_JSON_BYTES {
        return Err(SafeError::new(CONFIG_INVALID));
    }
    let text = std::str::from_utf8(&bytes).map_err(|_| SafeError::new(CONFIG_INVALID))?;
    GatewayConfig::from_json(text).map_err(|_| SafeError::new(CONFIG_INVALID))
}

fn load_keyring(path: &Path) -> Result<Keyring, SafeError> {
    let key = load_secret(path, SecretKind::StateKey)?;
    let material: [u8; 32] = key
        .as_bytes()
        .try_into()
        .map_err(|_| SafeError::new("secret_invalid"))?;
    Keyring::new(material, 1).map_err(|_| SafeError::new("admin_key_invalid"))
}

fn load_text(path: &Path) -> Result<String, SafeError> {
    let value = load_secret(
        path,
        SecretKind::Text {
            max_bytes: MAX_TEXT_SECRET_BYTES,
        },
    )?;
    std::str::from_utf8(value.as_bytes())
        .map(str::to_owned)
        .map_err(|_| SafeError::new("secret_invalid"))
}

fn parse_config_option(
    args: &[OsString],
    expected: &[&str],
) -> Result<std::path::PathBuf, AdminError> {
    if args.len() != expected.len() + 2
        || expected
            .iter()
            .zip(args.iter())
            .any(|(expected, actual)| actual.to_str() != Some(expected))
        || args[expected.len()].to_str() != Some("--config")
    {
        return Err(admin::invalid_arguments());
    }
    admin::absolute_path(args[expected.len() + 1].clone())
}

fn install_signal_handlers() -> Result<(), SafeError> {
    #[cfg(unix)]
    {
        // The handler performs one lock-free atomic store only. The service
        // observes it through its existing async shutdown seam, so no
        // async/runtime operation occurs in signal context.
        unsafe {
            if libc::signal(
                libc::SIGTERM,
                process_signal_handler as *const () as libc::sighandler_t,
            ) == libc::SIG_ERR
                || libc::signal(
                    libc::SIGINT,
                    process_signal_handler as *const () as libc::sighandler_t,
                ) == libc::SIG_ERR
            {
                return Err(SafeError::new(RUNTIME_SIGNAL_INVALID));
            }
        }
    }
    Ok(())
}

async fn run_daemon(config_path: &Path) -> Result<(), SafeError> {
    let config = read_config(config_path)?;
    let keyring = load_keyring(config.state_key_file())?;
    let store = Store::open(config.state_db_path(), keyring)
        .map_err(|error| SafeError::new(error.code()))?;
    let session = store
        .matrix_session()?
        .ok_or_else(|| SafeError::new(MATRIX_SESSION_INVALID))?;
    let access_token = matrix_access_token(&session, config.matrix_user_id())?;
    let passphrase = load_secret(
        config.matrix_store_passphrase_file(),
        SecretKind::Text {
            max_bytes: MAX_TEXT_SECRET_BYTES,
        },
    )?;
    let processor = restore_matrix_processor(
        config.homeserver_url(),
        config.matrix_user_id(),
        config.matrix_store_dir(),
        &passphrase,
        &store,
    )
    .await?;
    let transport = ReqwestMatrixTransport::new(
        config.homeserver_url(),
        access_token,
        Duration::from_secs(config.request_timeout_secs()),
        Duration::from_secs(config.sync_timeout_secs()),
    )?;
    let oauth_secret = load_text(config.oauth_client_secret_file())?;
    let token_provider = Arc::new(OAuthTokenProvider::new(
        config.oauth_token_url(),
        config.oauth_client_id(),
        SecretString::new(oauth_secret),
        config.oauth_client_auth_method(),
        Duration::from_secs(config.request_timeout_secs()),
        Duration::from_secs(30),
    )?);
    let sink = IngestionClient::new(
        config.ingestion_base_url(),
        token_provider,
        Duration::from_secs(config.request_timeout_secs()),
    )
    .map_err(|error| SafeError::new(error.code()))?;
    let shutdown = SignalShutdown::new();
    install_signal_handlers()?;
    let mut service = GatewayService::new(
        store,
        processor,
        transport,
        sink,
        SystemClock,
        SystemJitter(OsRng),
        shutdown,
        RetryPolicy::default(),
    )?;
    service.run().await
}

async fn run_provisioning(config_path: &Path) -> Result<(), SafeError> {
    let config = read_config(config_path)?;
    let provisioning = config
        .provisioning()
        .ok_or_else(|| SafeError::new("provisioning_config_missing"))?;
    let bridge_secret = load_text(provisioning.bridge_shared_secret_file())?;
    let gateway_secret = SecretString::new(load_text(provisioning.gateway_shared_secret_file())?);
    let keyring = load_keyring(config.state_key_file())?;
    let store = Store::open(config.state_db_path(), keyring)
        .map_err(|error| SafeError::new(error.code()))?;
    let session = store
        .matrix_session()?
        .ok_or_else(|| SafeError::new(MATRIX_SESSION_INVALID))?;
    let access_token = matrix_access_token(&session, config.matrix_user_id())?;
    let passphrase = load_secret(
        config.matrix_store_passphrase_file(),
        SecretKind::Text {
            max_bytes: MAX_TEXT_SECRET_BYTES,
        },
    )?;
    let matrix_client = restore_matrix_client(
        config.homeserver_url(),
        config.matrix_user_id(),
        config.matrix_store_dir(),
        &passphrase,
        &store,
    )
    .await?;
    let transport = ReqwestMatrixTransport::new(
        config.homeserver_url(),
        access_token,
        Duration::from_secs(config.request_timeout_secs()),
        Duration::from_secs(config.sync_timeout_secs()),
    )?;
    let history = HistoryGatewayServer::new(store, Arc::new(transport), gateway_secret.as_str())?;
    let client = WhatsAppProvisioningClient::new(
        provisioning.bridge_url(),
        SecretString::new(bridge_secret),
        provisioning.matrix_user_id(),
        Duration::from_secs(config.request_timeout_secs()),
    )
    .map_err(|error| SafeError::new(error.code()))?;
    let server = ProvisioningGatewayServer::new(
        client,
        gateway_secret,
        GatewayRouteMetadata {
            gateway_route_id: provisioning.gateway_route_id().to_owned(),
            bridge_instance_id: provisioning.bridge_instance_id().to_owned(),
            matrix_user_id: provisioning.matrix_user_id().to_owned(),
            matrix_room_namespace: provisioning.matrix_room_namespace().to_owned(),
        },
    )
    .map_err(|error| SafeError::new(error.code()))?;
    let server = server
        .with_history(history)
        .with_outbound_sender(Arc::new(MatrixSdkTextSender::new(
            matrix_client.clone(),
            Duration::from_secs(config.request_timeout_secs()),
        )))
        .with_group_manager(Arc::new(MatrixSdkGroupManager::new(
            matrix_client,
            Duration::from_secs(config.request_timeout_secs()),
        )));
    serve_private_gateway(server, provisioning.listen_addr())
        .await
        .map_err(|_| SafeError::new("provisioning_listen_failed"))
}

async fn verify_clear_maintenance(config_path: &Path) -> Result<(), SafeError> {
    let config = read_config(config_path)?;
    let keyring = load_keyring(config.state_key_file())?;
    let mut store = Store::open(config.state_db_path(), keyring)
        .map_err(|error| SafeError::new(error.code()))?;
    let passphrase = load_secret(
        config.matrix_store_passphrase_file(),
        SecretKind::Text {
            max_bytes: MAX_TEXT_SECRET_BYTES,
        },
    )?;
    let processor = restore_matrix_processor(
        config.homeserver_url(),
        config.matrix_user_id(),
        config.matrix_store_dir(),
        &passphrase,
        &store,
    )
    .await?;
    if !processor.pending_crypto_requests().await?.is_empty() {
        return Err(SafeError::new("store_crypto_not_ready"));
    }
    drop(processor);
    let expected = ReasonCode::new("crypto_maintenance_required".to_owned())
        .map_err(|_| SafeError::new("store_crypto_invalid"))?;
    store.clear_crypto_maintenance(expected)
}

fn runtime_exit_code(code: &str) -> u8 {
    if code == CONFIG_INVALID
        || code.starts_with("secret_")
        || code == MATRIX_SESSION_INVALID
        || code == "matrix_transport_invalid"
        || code.starts_with("oauth_")
        || code.starts_with("ingestion_")
        || code.starts_with("provisioning_")
    {
        78
    } else {
        74
    }
}

fn write_result(output: &str, exit_code: u8) -> ExitCode {
    if writeln!(io::stdout().lock(), "{output}").is_err() {
        let _ = writeln!(io::stderr().lock(), "{RUNTIME_OUTPUT_INVALID}");
        return ExitCode::from(74);
    }
    ExitCode::from(exit_code)
}

fn write_admin_error(error: AdminError) -> ExitCode {
    let _ = writeln!(io::stderr().lock(), "{}", error.code());
    ExitCode::from(error.exit_code())
}

#[tokio::main(flavor = "multi_thread")]
async fn main() -> ExitCode {
    let args: Vec<OsString> = std::env::args_os().skip(1).collect();
    let Some(command) = args.first().and_then(|value| value.to_str()) else {
        return write_admin_error(admin::invalid_arguments());
    };

    match command {
        "registry" => match admin::run(&args) {
            Ok(output) => write_result(&output, 0),
            Err(error) => write_admin_error(error),
        },
        "healthcheck" => match admin::healthcheck(&args) {
            Ok((output, exit_code)) => write_result(&output, exit_code),
            Err(error) => write_admin_error(error),
        },
        "quarantine" if args.get(1).and_then(|value| value.to_str()) == Some("status") => {
            match admin::quarantine_status(&args) {
                Ok(output) => write_result(&output, 0),
                Err(error) => write_admin_error(error),
            }
        }
        "quarantine" if args.get(1).and_then(|value| value.to_str()) == Some("retry") => {
            match admin::quarantine_retry(&args) {
                Ok(output) => write_result(&output, 0),
                Err(error) => write_admin_error(error),
            }
        }
        "crypto" if args.get(1).and_then(|value| value.to_str()) == Some("status") => {
            match admin::crypto_status(&args) {
                Ok(output) => write_result(&output, 0),
                Err(error) => write_admin_error(error),
            }
        }
        "crypto"
            if args.get(1).and_then(|value| value.to_str()) == Some("verify-clear-maintenance") =>
        {
            let config = match parse_config_option(&args, &["crypto", "verify-clear-maintenance"]) {
                Ok(path) => path,
                Err(error) => return write_admin_error(error),
            };
            match verify_clear_maintenance(&config).await {
                Ok(()) => ExitCode::SUCCESS,
                Err(error) => {
                    let _ = writeln!(io::stderr().lock(), "{}", error.code());
                    ExitCode::from(runtime_exit_code(error.code()))
                }
            }
        }
        "run" => {
            let config = match parse_config_option(&args, &["run"]) {
                Ok(path) => path,
                Err(error) => return write_admin_error(error),
            };
            match run_daemon(&config).await {
                Ok(()) => ExitCode::SUCCESS,
                Err(error) => {
                    let _ = writeln!(io::stderr().lock(), "{}", error.code());
                    ExitCode::from(runtime_exit_code(error.code()))
                }
            }
        }
        "provisioning" => {
            let config = match parse_config_option(&args, &["provisioning"]) {
                Ok(path) => path,
                Err(error) => return write_admin_error(error),
            };
            match run_provisioning(&config).await {
                Ok(()) => ExitCode::SUCCESS,
                Err(error) => {
                    let _ = writeln!(io::stderr().lock(), "{}", error.code());
                    ExitCode::from(runtime_exit_code(error.code()))
                }
            }
        }
        _ => write_admin_error(admin::invalid_arguments()),
    }
}
