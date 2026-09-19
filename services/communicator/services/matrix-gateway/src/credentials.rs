//! Startup loading for the gateway's separately scoped protected credentials.
//!
//! Each returned value is read once from its configured protected file.  The
//! loader keeps the ingestion, authority-claim, and Worker transport secrets
//! as separate values so a caller cannot accidentally substitute one for
//! another at a protocol boundary.

use crate::{
    config::{GatewayConfig, ProvisioningConfig},
    ingestion::SecretString,
    secret::{MAX_TEXT_SECRET_BYTES, SafeError, SecretKind, load_secret},
};
use std::{path::Path, str};

/// The three credentials used by the private provisioning gateway.
pub struct ProvisioningCredentials {
    authority_service: SecretString,
    bridge_shared: SecretString,
    gateway_transport: SecretString,
}

impl ProvisioningCredentials {
    /// Return the dedicated Platform-issued outbound claim credential.
    pub fn authority_service(&self) -> &SecretString {
        &self.authority_service
    }

    /// Return the bridge transport credential.
    pub fn bridge_shared(&self) -> &SecretString {
        &self.bridge_shared
    }

    /// Return the Worker-to-gateway transport credential.
    pub fn gateway_transport(&self) -> &SecretString {
        &self.gateway_transport
    }
}

/// Load the daemon's Platform-issued ingestion credential from its protected
/// file.  The value is opaque to the gateway and remains in memory until
/// process exit.
pub fn load_ingestion_service_credential(
    config: &GatewayConfig,
) -> Result<SecretString, SafeError> {
    load_text(config.ingestion_service_credential_file()).map(SecretString::new)
}

/// Load all protected credentials needed by the optional provisioning
/// listener.  The authority credential is deliberately loaded independently
/// from the gateway transport and bridge credentials.
pub fn load_provisioning_credentials(
    config: &ProvisioningConfig,
) -> Result<ProvisioningCredentials, SafeError> {
    Ok(ProvisioningCredentials {
        authority_service: load_text(config.authority_service_credential_file())
            .map(SecretString::new)?,
        bridge_shared: load_text(config.bridge_shared_secret_file()).map(SecretString::new)?,
        gateway_transport: load_text(config.gateway_shared_secret_file()).map(SecretString::new)?,
    })
}

fn load_text(path: &Path) -> Result<String, SafeError> {
    let value = load_secret(
        path,
        SecretKind::Text {
            max_bytes: MAX_TEXT_SECRET_BYTES,
        },
    )?;
    str::from_utf8(value.as_bytes())
        .map(str::to_owned)
        .map_err(|_| SafeError::new("secret_invalid"))
}
