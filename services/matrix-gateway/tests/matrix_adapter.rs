use chrono::{TimeZone, Utc};
use std::{fs, os::unix::fs::PermissionsExt, path::Path};

use communicator_matrix_gateway::crypto::Keyring;
use communicator_matrix_gateway::matrix::{
    MatrixProcessor, MatrixSdkProcessor, RestartCryptoAck, bootstrap_matrix,
    restore_matrix_processor,
};
use communicator_matrix_gateway::matrix_http::ReqwestMatrixTransport;
use communicator_matrix_gateway::secret::SecretBytes;
use communicator_matrix_gateway::store::Store;
use communicator_matrix_gateway::store_types::{NewBootstrapState, NewRawSyncInbox, ReasonCode};
use http::Response as HttpResponse;
use matrix_sdk::{Client, SessionMeta, SessionTokens, authentication::matrix::MatrixSession};
use matrix_sdk::{config::SyncSettings, test_utils::mocks::MatrixMockServer};
use matrix_sdk_base::{BaseClient, DmRoomDefinition, ThreadingSupport, store::RoomLoadSettings};
use matrix_sdk_common::cross_process_lock::CrossProcessLockConfig;
use matrix_sdk_crypto::{
    DecryptionSettings, DeviceData, EncryptionSettings, OlmMachine, TrustRequirement,
    UserIdentityData,
    store::CryptoStore,
    types::{
        SelfSigningPubkey,
        events::{ToDeviceEvent, room::encrypted::ToDeviceEncryptedEventContent},
    },
};
use matrix_sdk_sqlite::{SqliteCryptoStore, SqliteStateStore};
use matrix_sdk_test::{JoinedRoomBuilder, SyncResponseBuilder, event_factory::EventFactory};
use ruma::{
    MilliSecondsSinceUnixEpoch,
    api::client::sync::sync_events::v3::Response as RumaSyncResponse,
    api::{IncomingResponse, OutgoingResponse},
    event_id,
    events::{AnySyncTimelineEvent, AnyToDeviceEvent},
    owned_device_id, owned_user_id, room_id,
    serde::Raw,
    to_device::DeviceIdOrAllDevices,
};
use rusqlite::{Connection, params};
use serde_json::Value;
use sha2::{Digest, Sha256};
use tempfile::tempdir;
use url::Url;

async fn open_test_base_client(
    state_path: &Path,
    crypto_path: &Path,
    passphrase: &str,
    session_meta: SessionMeta,
) -> Result<BaseClient, Box<dyn std::error::Error + Send + Sync>> {
    let state = SqliteStateStore::open(state_path, Some(passphrase)).await?;
    let crypto = SqliteCryptoStore::open(crypto_path, Some(passphrase)).await?;
    let base = BaseClient::new(
        matrix_sdk_base::store::StoreConfig::new(CrossProcessLockConfig::SingleProcess)
            .state_store(state)
            .crypto_store(crypto),
        ThreadingSupport::Disabled,
        DmRoomDefinition::default(),
    );
    base.activate(session_meta, RoomLoadSettings::default(), None)
        .await?;
    Ok(base)
}

#[test]
fn task3_public_bootstrap_and_restore_entrypoints_exist() {
    let _ = bootstrap_matrix;
    let _ = restore_matrix_processor;
}

#[test]
fn task4_and_task5_processor_implements_the_frozen_boundary() {
    fn assert_processor<T: MatrixProcessor>() {}
    assert_processor::<MatrixSdkProcessor>();
}

#[test]
fn public_sdk_crypto_api_proves_device_and_cross_signing_entries() {
    fn inspect_device(device: &DeviceData) {
        let _ = device.user_id();
        let _ = device.device_id();
        let _ = device.keys();
        let _ = device.signatures();
    }

    fn inspect_identity(identity: &UserIdentityData) {
        let _ = identity.user_id();
        let _ = identity.master_key().as_ref();
        let _ = identity.self_signing_key().as_ref();
        let _ = identity.user_signing_key().map(|key| key.as_ref());
    }

    let _ = inspect_device as fn(&DeviceData);
    let _ = inspect_identity as fn(&UserIdentityData);
    let verify = SelfSigningPubkey::verify_device_keys;
    let _ = verify
        as fn(
            &SelfSigningPubkey,
            &matrix_sdk_crypto::types::DeviceKeys,
        ) -> Result<(), matrix_sdk_crypto::SignatureError>;

    fn verify_cross_signing_signature(
        signer: &matrix_sdk_crypto::types::CrossSigningKey,
        signed: &matrix_sdk_crypto::types::CrossSigningKey,
    ) -> bool {
        let Some((key_id, signing_key)) = signer.get_first_key_and_id() else {
            return false;
        };
        let Ok(value) = serde_json::to_value(signed) else {
            return false;
        };
        let Ok(mut canonical) = ruma::canonical_json::to_canonical_value(value) else {
            return false;
        };
        let Some(object) = canonical.as_object_mut() else {
            return false;
        };
        object.remove("signatures");
        object.remove("unsigned");
        let Some(signature) = signed.signatures.get_signature(&signed.user_id, key_id) else {
            return false;
        };
        signing_key
            .verify(canonical.to_string().as_bytes(), &signature)
            .is_ok()
    }

    let _ = verify_cross_signing_signature
        as fn(
            &matrix_sdk_crypto::types::CrossSigningKey,
            &matrix_sdk_crypto::types::CrossSigningKey,
        ) -> bool;
}

#[tokio::test]
async fn restored_processor_applies_a_journaled_sync_without_network() {
    let offline_server = MatrixMockServer::new().await;
    let app_directory = tempdir().unwrap();
    let sdk_directory = tempdir().unwrap();
    fs::set_permissions(app_directory.path(), fs::Permissions::from_mode(0o700)).unwrap();
    fs::set_permissions(sdk_directory.path(), fs::Permissions::from_mode(0o700)).unwrap();
    let app_path = app_directory.path().join("gateway.sqlite3");
    let sdk_path = sdk_directory.path().join("matrix-sdk");
    let user_id = owned_user_id!("@adapter:example.org");
    let device_id = owned_device_id!("ADAPTERDEVICE");
    let session = MatrixSession {
        meta: SessionMeta {
            user_id: user_id.clone(),
            device_id: device_id.clone(),
        },
        tokens: SessionTokens {
            access_token: "offline-access".to_owned(),
            refresh_token: None,
        },
    };
    let passphrase = "adapter-sdk-passphrase";
    let mut state_store = Store::open(
        &app_path,
        Keyring::new([0x11; 32], 1).expect("test keyring"),
    )
    .unwrap();
    let base = open_test_base_client(&sdk_path, &sdk_path, passphrase, session.meta.clone())
        .await
        .unwrap();
    let mut initial = SyncResponseBuilder::new().build_sync_response();
    initial.next_batch = "s0".to_owned();
    base.receive_sync_response(initial).await.unwrap();
    base.close_stores().await.unwrap();
    state_store
        .initialize_bootstrap_state(
            NewBootstrapState::new(
                serde_json::to_vec(&session).unwrap(),
                b"s0".to_vec(),
                Vec::new(),
                Utc.timestamp_millis_opt(1_700_000_000_000)
                    .single()
                    .unwrap(),
            )
            .unwrap(),
        )
        .unwrap();

    let room_id = room_id!("!adapter-room:example.org");
    let event = EventFactory::new()
        .room(room_id)
        .sender(&user_id)
        .text_msg("journaled")
        .event_id(event_id!("$adapter-event:example.org"));
    let mut followup = SyncResponseBuilder::new()
        .add_joined_room(JoinedRoomBuilder::new(room_id).add_timeline_event(event))
        .build_sync_response();
    followup.next_batch = "s1".to_owned();
    let body = followup.try_into_http_response().unwrap().into_body();
    state_store
        .append_fetched_sync(
            NewRawSyncInbox::new(
                b"s0".to_vec(),
                b"s1".to_vec(),
                body,
                Utc.timestamp_millis_opt(1_700_000_001_000)
                    .single()
                    .unwrap(),
            )
            .unwrap(),
        )
        .unwrap();
    let saved = state_store.oldest_uncommitted_inbox().unwrap().unwrap();

    let mut processor = restore_matrix_processor(
        &offline_server.uri(),
        user_id.as_str(),
        &sdk_path,
        &SecretBytes::from_text(passphrase.as_bytes(), 1024).unwrap(),
        &state_store,
    )
    .await
    .unwrap();
    assert_eq!(
        processor.sdk_token_digest().await.unwrap(),
        Some(Sha256::digest(b"s0").into())
    );
    assert_eq!(
        processor
            .pending_crypto_requests()
            .await
            .expect_err("a fresh account has more than one pending crypto request")
            .code(),
        "matrix_crypto_kind_not_allowed"
    );
    let recovery_error = match processor.recover_saved_sync(&saved).await {
        Ok(_) => panic!("recovery must not run before the SDK applies the row"),
        Err(error) => error,
    };
    assert_eq!(recovery_error.code(), "matrix_sdk_position_unjournaled");
    let processed = processor.apply_saved_sync(&saved).await.unwrap();
    assert_eq!(processed.event_count(), 1);
    assert_eq!(processed.gap_count(), 0);
    drop(processor);

    let mut reopened = restore_matrix_processor(
        &offline_server.uri(),
        user_id.as_str(),
        &sdk_path,
        &SecretBytes::from_text(passphrase.as_bytes(), 1024).unwrap(),
        &state_store,
    )
    .await
    .unwrap();
    let recovered = reopened.recover_saved_sync(&saved).await.unwrap();
    assert_eq!(recovered.event_count(), 1);
    assert_eq!(recovered.gap_count(), 0);
    drop(reopened);

    let wrong_passphrase = match restore_matrix_processor(
        &offline_server.uri(),
        user_id.as_str(),
        &sdk_path,
        &SecretBytes::from_text(b"wrong-passphrase", 1024).unwrap(),
        &state_store,
    )
    .await
    {
        Ok(_) => panic!("wrong SDK passphrase must fail closed"),
        Err(error) => error,
    };
    assert_eq!(wrong_passphrase.code(), "matrix_session_invalid");

    let configured_user_mismatch = match restore_matrix_processor(
        &offline_server.uri(),
        "@different-user:example.org",
        &sdk_path,
        &SecretBytes::from_text(passphrase.as_bytes(), 1024).unwrap(),
        &state_store,
    )
    .await
    {
        Ok(_) => panic!("configured/session user mismatch must fail closed"),
        Err(error) => error,
    };
    assert_eq!(configured_user_mismatch.code(), "matrix_session_invalid");

    let mismatch_app_directory = tempdir().unwrap();
    fs::set_permissions(
        mismatch_app_directory.path(),
        fs::Permissions::from_mode(0o700),
    )
    .unwrap();
    let mismatch_app_path = mismatch_app_directory.path().join("gateway.sqlite3");
    let mut mismatch_store = Store::open(
        &mismatch_app_path,
        Keyring::new([0x11; 32], 1).expect("test keyring"),
    )
    .unwrap();
    let mismatched_session = MatrixSession {
        meta: SessionMeta {
            user_id: user_id.clone(),
            device_id: owned_device_id!("DIFFERENTDEVICE"),
        },
        tokens: SessionTokens {
            access_token: "offline-access".to_owned(),
            refresh_token: None,
        },
    };
    mismatch_store
        .initialize_bootstrap_state(
            NewBootstrapState::new(
                serde_json::to_vec(&mismatched_session).unwrap(),
                b"s0".to_vec(),
                Vec::new(),
                Utc.timestamp_millis_opt(1_700_000_002_000)
                    .single()
                    .unwrap(),
            )
            .unwrap(),
        )
        .unwrap();
    let device_mismatch = match restore_matrix_processor(
        &offline_server.uri(),
        user_id.as_str(),
        &sdk_path,
        &SecretBytes::from_text(passphrase.as_bytes(), 1024).unwrap(),
        &mismatch_store,
    )
    .await
    {
        Ok(_) => panic!("SDK account/device mismatch must fail closed"),
        Err(error) => error,
    };
    assert_eq!(device_mismatch.code(), "matrix_session_invalid");

    let checkpoint_mismatch_app_directory = tempdir().unwrap();
    fs::set_permissions(
        checkpoint_mismatch_app_directory.path(),
        fs::Permissions::from_mode(0o700),
    )
    .unwrap();
    let checkpoint_mismatch_app_path = checkpoint_mismatch_app_directory
        .path()
        .join("gateway.sqlite3");
    let mut checkpoint_mismatch_store = Store::open(
        &checkpoint_mismatch_app_path,
        Keyring::new([0x11; 32], 1).expect("test keyring"),
    )
    .unwrap();
    checkpoint_mismatch_store
        .initialize_bootstrap_state(
            NewBootstrapState::new(
                serde_json::to_vec(&session).unwrap(),
                b"unrelated-checkpoint".to_vec(),
                Vec::new(),
                Utc.timestamp_millis_opt(1_700_000_003_000)
                    .single()
                    .unwrap(),
            )
            .unwrap(),
        )
        .unwrap();
    let checkpoint_mismatch = match restore_matrix_processor(
        &offline_server.uri(),
        user_id.as_str(),
        &sdk_path,
        &SecretBytes::from_text(passphrase.as_bytes(), 1024).unwrap(),
        &checkpoint_mismatch_store,
    )
    .await
    {
        Ok(_) => panic!("SDK/application checkpoint mismatch must fail closed"),
        Err(error) => error,
    };
    assert_eq!(checkpoint_mismatch.code(), "matrix_session_invalid");
    assert!(
        offline_server
            .server()
            .received_requests()
            .await
            .unwrap()
            .is_empty()
    );
}

#[tokio::test]
async fn restore_rejects_an_unknown_sdk_token_with_the_position_error() {
    let app_directory = tempdir().unwrap();
    let sdk_directory = tempdir().unwrap();
    fs::set_permissions(app_directory.path(), fs::Permissions::from_mode(0o700)).unwrap();
    fs::set_permissions(sdk_directory.path(), fs::Permissions::from_mode(0o700)).unwrap();
    let app_path = app_directory.path().join("gateway.sqlite3");
    let sdk_path = sdk_directory.path().join("matrix-sdk");
    let user_id = owned_user_id!("@unknown-position:example.org");
    let device_id = owned_device_id!("UNKNOWNPOSITION");
    let session = MatrixSession {
        meta: SessionMeta {
            user_id: user_id.clone(),
            device_id,
        },
        tokens: SessionTokens {
            access_token: "unknown-position-token".to_owned(),
            refresh_token: None,
        },
    };
    let passphrase = "unknown-position-passphrase";
    let mut state_store = Store::open(
        &app_path,
        Keyring::new([0x11; 32], 1).expect("test keyring"),
    )
    .unwrap();
    state_store
        .initialize_bootstrap_state(
            NewBootstrapState::new(
                serde_json::to_vec(&session).unwrap(),
                b"committed-position".to_vec(),
                Vec::new(),
                Utc.timestamp_millis_opt(1_700_000_020_000)
                    .single()
                    .unwrap(),
            )
            .unwrap(),
        )
        .unwrap();

    let base = open_test_base_client(&sdk_path, &sdk_path, passphrase, session.meta.clone())
        .await
        .unwrap();
    let mut unknown = SyncResponseBuilder::new().build_sync_response();
    unknown.next_batch = "unknown-sdk-position".to_owned();
    base.receive_sync_response(unknown).await.unwrap();
    base.close_stores().await.unwrap();

    let error = match restore_matrix_processor(
        "https://matrix.example",
        user_id.as_str(),
        &sdk_path,
        &SecretBytes::from_text(passphrase.as_bytes(), 1024).unwrap(),
        &state_store,
    )
    .await
    {
        Ok(_) => panic!("an unknown SDK token must fail closed"),
        Err(error) => error,
    };
    assert_eq!(error.code(), "matrix_session_invalid");
}

fn empty_sync_body(next_batch: &str) -> Vec<u8> {
    let mut response = SyncResponseBuilder::new().build_sync_response();
    response.next_batch = next_batch.to_owned();
    response
        .try_into_http_response()
        .expect("serialize empty sync response")
        .into_body()
}

async fn create_sdk_store_at(
    sdk_path: &std::path::Path,
    passphrase: &str,
    session_meta: &SessionMeta,
    tokens: &[&str],
) {
    let base = open_test_base_client(sdk_path, sdk_path, passphrase, session_meta.clone())
        .await
        .expect("open SDK fixture store");
    for token in tokens {
        let mut response = SyncResponseBuilder::new().build_sync_response();
        response.next_batch = (*token).to_owned();
        base.receive_sync_response(response)
            .await
            .expect("advance SDK fixture token");
    }
    base.close_stores().await.expect("close SDK fixture store");
}

fn commit_sync_row_for_recovery(path: &std::path::Path, inbox_id: &str, token: &[u8]) {
    let at = Utc
        .timestamp_millis_opt(1_700_000_010_000)
        .single()
        .expect("construct recovery commit timestamp")
        .to_rfc3339();
    let connection = Connection::open(path).expect("open recovery commit fixture");
    connection
        .execute(
            "UPDATE sync_inbox
             SET state = 'committed', sdk_processed_at = ?2,
                 prepared_at = ?2, committed_at = ?2
             WHERE inbox_id = ?1",
            params![inbox_id, at],
        )
        .expect("mark recovery row committed");
    let sealed = Keyring::new([0x11; 32], 1)
        .expect("construct recovery keyring")
        .seal("gateway_state", "1", "committed_token", token)
        .expect("seal recovery committed token");
    connection
        .execute(
            "UPDATE gateway_state
             SET committed_token_cipher = ?1, committed_token_nonce = ?2,
                 committed_token_key_version = ?3",
            params![
                sealed.ciphertext,
                sealed.nonce.as_slice(),
                i64::from(sealed.key_version),
            ],
        )
        .expect("advance recovery committed token");
}

#[tokio::test]
async fn recovery_requires_the_verified_frontier_not_token_inequality() {
    let app_directory = tempdir().unwrap();
    let sdk_first_directory = tempdir().unwrap();
    let sdk_second_directory = tempdir().unwrap();
    let sdk_third_directory = tempdir().unwrap();
    fs::set_permissions(app_directory.path(), fs::Permissions::from_mode(0o700)).unwrap();
    fs::set_permissions(
        sdk_first_directory.path(),
        fs::Permissions::from_mode(0o700),
    )
    .unwrap();
    fs::set_permissions(
        sdk_second_directory.path(),
        fs::Permissions::from_mode(0o700),
    )
    .unwrap();
    fs::set_permissions(
        sdk_third_directory.path(),
        fs::Permissions::from_mode(0o700),
    )
    .unwrap();
    let app_path = app_directory.path().join("gateway.sqlite3");
    let sdk_first_path = sdk_first_directory.path().join("matrix-sdk");
    let sdk_second_path = sdk_second_directory.path().join("matrix-sdk");
    let sdk_third_path = sdk_third_directory.path().join("matrix-sdk");
    let user_id = owned_user_id!("@recovery-frontier:example.org");
    let session = MatrixSession {
        meta: SessionMeta {
            user_id: user_id.clone(),
            device_id: owned_device_id!("RECOVERYFRONTIER"),
        },
        tokens: SessionTokens {
            access_token: "recovery-frontier-token".to_owned(),
            refresh_token: None,
        },
    };
    let passphrase = "recovery-frontier-passphrase";
    let mut state_store = Store::open(
        &app_path,
        Keyring::new([0x11; 32], 1).expect("test keyring"),
    )
    .unwrap();
    state_store
        .initialize_bootstrap_state(
            NewBootstrapState::new(
                serde_json::to_vec(&session).unwrap(),
                b"s0".to_vec(),
                Vec::new(),
                Utc.timestamp_millis_opt(1_700_000_000_000)
                    .single()
                    .unwrap(),
            )
            .unwrap(),
        )
        .unwrap();

    state_store
        .append_fetched_sync(
            NewRawSyncInbox::new(
                b"s0".to_vec(),
                b"s1".to_vec(),
                empty_sync_body("s1"),
                Utc.timestamp_millis_opt(1_700_000_001_000)
                    .single()
                    .unwrap(),
            )
            .unwrap(),
        )
        .unwrap();
    state_store
        .append_fetched_sync(
            NewRawSyncInbox::new(
                b"s1".to_vec(),
                b"s2".to_vec(),
                empty_sync_body("s2"),
                Utc.timestamp_millis_opt(1_700_000_002_000)
                    .single()
                    .unwrap(),
            )
            .unwrap(),
        )
        .unwrap();
    state_store
        .append_fetched_sync(
            NewRawSyncInbox::new(
                b"s2".to_vec(),
                b"s3".to_vec(),
                empty_sync_body("s3"),
                Utc.timestamp_millis_opt(1_700_000_003_000)
                    .single()
                    .unwrap(),
            )
            .unwrap(),
        )
        .unwrap();
    let row_one = state_store.oldest_uncommitted_inbox().unwrap().unwrap();

    create_sdk_store_at(&sdk_first_path, passphrase, &session.meta, &["s0", "s1"]).await;
    create_sdk_store_at(
        &sdk_second_path,
        passphrase,
        &session.meta,
        &["s0", "s1", "s2"],
    )
    .await;
    create_sdk_store_at(
        &sdk_third_path,
        passphrase,
        &session.meta,
        &["s0", "s1", "s2", "s3"],
    )
    .await;

    let mut at_first = restore_matrix_processor(
        "https://matrix.example",
        user_id.as_str(),
        &sdk_first_path,
        &SecretBytes::from_text(passphrase.as_bytes(), 1024).unwrap(),
        &state_store,
    )
    .await
    .unwrap();

    commit_sync_row_for_recovery(&app_path, row_one.inbox_id().as_str(), b"s1");
    let row_two = state_store.oldest_uncommitted_inbox().unwrap().unwrap();

    let mut at_second = restore_matrix_processor(
        "https://matrix.example",
        user_id.as_str(),
        &sdk_second_path,
        &SecretBytes::from_text(passphrase.as_bytes(), 1024).unwrap(),
        &state_store,
    )
    .await
    .unwrap();
    commit_sync_row_for_recovery(&app_path, row_two.inbox_id().as_str(), b"s2");
    let row_three = state_store.oldest_uncommitted_inbox().unwrap().unwrap();

    assert!(at_first.recover_saved_sync(&row_one).await.is_ok());
    assert_eq!(
        at_first
            .recover_saved_sync(&row_two)
            .await
            .expect_err("row immediately after the SDK position must fail")
            .code(),
        "matrix_sdk_position_unjournaled"
    );
    assert_eq!(
        at_first
            .recover_saved_sync(&row_three)
            .await
            .expect_err("a later row must not pass token inequality")
            .code(),
        "matrix_sdk_position_unjournaled"
    );
    drop(at_first);

    assert!(at_second.recover_saved_sync(&row_one).await.is_ok());
    assert!(at_second.recover_saved_sync(&row_two).await.is_ok());
    assert_eq!(
        at_second
            .recover_saved_sync(&row_three)
            .await
            .expect_err("row after the second SDK position must fail")
            .code(),
        "matrix_sdk_position_unjournaled"
    );
    drop(at_second);

    let mut at_committed = restore_matrix_processor(
        "https://matrix.example",
        user_id.as_str(),
        &sdk_second_path,
        &SecretBytes::from_text(passphrase.as_bytes(), 1024).unwrap(),
        &state_store,
    )
    .await
    .unwrap();
    assert_eq!(
        at_committed
            .recover_saved_sync(&row_one)
            .await
            .expect_err("committed position must not recover a journal row")
            .code(),
        "matrix_sdk_position_unjournaled"
    );
    drop(at_committed);

    let mut at_third = restore_matrix_processor(
        "https://matrix.example",
        user_id.as_str(),
        &sdk_third_path,
        &SecretBytes::from_text(passphrase.as_bytes(), 1024).unwrap(),
        &state_store,
    )
    .await
    .unwrap();
    assert!(at_third.recover_saved_sync(&row_one).await.is_ok());
    assert!(at_third.recover_saved_sync(&row_two).await.is_ok());
    assert!(at_third.recover_saved_sync(&row_three).await.is_ok());
}

#[tokio::test]
async fn apply_saved_sync_rejects_when_sdk_is_at_a_later_journaled_position() {
    let app_directory = tempdir().unwrap();
    let sdk_directory = tempdir().unwrap();
    fs::set_permissions(app_directory.path(), fs::Permissions::from_mode(0o700)).unwrap();
    fs::set_permissions(sdk_directory.path(), fs::Permissions::from_mode(0o700)).unwrap();
    let app_path = app_directory.path().join("gateway.sqlite3");
    let sdk_path = sdk_directory.path().join("matrix-sdk");
    let user_id = owned_user_id!("@later-position:example.org");
    let session = MatrixSession {
        meta: SessionMeta {
            user_id: user_id.clone(),
            device_id: owned_device_id!("LATERPOSITION"),
        },
        tokens: SessionTokens {
            access_token: "later-position-token".to_owned(),
            refresh_token: None,
        },
    };
    let passphrase = "later-position-passphrase";
    let mut state_store = Store::open(
        &app_path,
        Keyring::new([0x11; 32], 1).expect("test keyring"),
    )
    .unwrap();
    state_store
        .initialize_bootstrap_state(
            NewBootstrapState::new(
                serde_json::to_vec(&session).unwrap(),
                b"s0".to_vec(),
                Vec::new(),
                Utc.timestamp_millis_opt(1_700_000_021_000)
                    .single()
                    .unwrap(),
            )
            .unwrap(),
        )
        .unwrap();

    let base = open_test_base_client(&sdk_path, &sdk_path, passphrase, session.meta.clone())
        .await
        .unwrap();
    let mut first = SyncResponseBuilder::new().build_sync_response();
    first.next_batch = "s1".to_owned();
    let first_body: Vec<u8> = first.try_into_http_response().unwrap().into_body();
    let first_typed = RumaSyncResponse::try_from_http_response(
        HttpResponse::builder()
            .status(200)
            .header("content-type", "application/json")
            .body(first_body.clone())
            .unwrap(),
    )
    .unwrap();
    let mut second = SyncResponseBuilder::new().build_sync_response();
    second.next_batch = "s2".to_owned();
    let second_body: Vec<u8> = second.try_into_http_response().unwrap().into_body();
    let second_typed = RumaSyncResponse::try_from_http_response(
        HttpResponse::builder()
            .status(200)
            .header("content-type", "application/json")
            .body(second_body.clone())
            .unwrap(),
    )
    .unwrap();
    base.receive_sync_response(first_typed).await.unwrap();
    base.receive_sync_response(second_typed).await.unwrap();
    base.close_stores().await.unwrap();

    state_store
        .append_fetched_sync(
            NewRawSyncInbox::new(
                b"s0".to_vec(),
                b"s1".to_vec(),
                first_body,
                Utc.timestamp_millis_opt(1_700_000_021_100)
                    .single()
                    .unwrap(),
            )
            .unwrap(),
        )
        .unwrap();
    state_store
        .append_fetched_sync(
            NewRawSyncInbox::new(
                b"s1".to_vec(),
                b"s2".to_vec(),
                second_body,
                Utc.timestamp_millis_opt(1_700_000_021_200)
                    .single()
                    .unwrap(),
            )
            .unwrap(),
        )
        .unwrap();
    let saved = state_store.oldest_uncommitted_inbox().unwrap().unwrap();
    let mut processor = restore_matrix_processor(
        "https://matrix.example",
        user_id.as_str(),
        &sdk_path,
        &SecretBytes::from_text(passphrase.as_bytes(), 1024).unwrap(),
        &state_store,
    )
    .await
    .unwrap();
    let error = match processor.apply_saved_sync(&saved).await {
        Ok(_) => panic!("apply must not move the SDK backwards"),
        Err(error) => error,
    };
    assert_eq!(error.code(), "matrix_sdk_position_unjournaled");
}

#[tokio::test]
async fn restore_missing_crypto_account_does_not_create_a_device() {
    let app_directory = tempdir().unwrap();
    let sdk_directory = tempdir().unwrap();
    fs::set_permissions(app_directory.path(), fs::Permissions::from_mode(0o700)).unwrap();
    fs::set_permissions(sdk_directory.path(), fs::Permissions::from_mode(0o700)).unwrap();
    let app_path = app_directory.path().join("gateway.sqlite3");
    let sdk_path = sdk_directory.path().join("matrix-sdk");
    fs::create_dir(&sdk_path).unwrap();
    fs::write(sdk_path.join("partial-state"), b"operator-diagnosis").unwrap();

    let user_id = owned_user_id!("@restore-no-account:example.org");
    let device_id = owned_device_id!("RESTORENOACCOUNT");
    let session = MatrixSession {
        meta: SessionMeta {
            user_id: user_id.clone(),
            device_id: device_id.clone(),
        },
        tokens: SessionTokens {
            access_token: "restore-no-account-token".to_owned(),
            refresh_token: None,
        },
    };
    let passphrase = "restore-no-account-passphrase";
    let mut state_store = Store::open(
        &app_path,
        Keyring::new([0x11; 32], 1).expect("test keyring"),
    )
    .unwrap();
    state_store
        .initialize_bootstrap_state(
            NewBootstrapState::new(
                serde_json::to_vec(&session).unwrap(),
                b"restore-no-account-next".to_vec(),
                Vec::new(),
                Utc.timestamp_millis_opt(1_700_000_010_000)
                    .single()
                    .unwrap(),
            )
            .unwrap(),
        )
        .unwrap();

    let error = match restore_matrix_processor(
        "https://matrix.example",
        user_id.as_str(),
        &sdk_path,
        &SecretBytes::from_text(passphrase.as_bytes(), 1024).unwrap(),
        &state_store,
    )
    .await
    {
        Ok(_) => panic!("an account-less SDK store must fail closed"),
        Err(error) => error,
    };
    assert_eq!(error.code(), "matrix_session_invalid");
    assert!(
        !sdk_path
            .join(matrix_sdk_sqlite::STATE_STORE_DATABASE_NAME)
            .exists()
    );
    assert!(!sdk_path.join("matrix-sdk-crypto.sqlite3").exists());

    let crypto = matrix_sdk_sqlite::SqliteCryptoStore::open(&sdk_path, Some(passphrase))
        .await
        .unwrap();
    assert!(crypto.load_account().await.unwrap().is_none());
}

#[tokio::test]
async fn restore_missing_bootstrap_and_corrupt_session_fail_closed_without_network() {
    let offline_server = MatrixMockServer::new().await;
    let app_directory = tempdir().unwrap();
    let sdk_directory = tempdir().unwrap();
    fs::set_permissions(app_directory.path(), fs::Permissions::from_mode(0o700)).unwrap();
    fs::set_permissions(sdk_directory.path(), fs::Permissions::from_mode(0o700)).unwrap();
    let app_path = app_directory.path().join("gateway.sqlite3");
    let sdk_path = sdk_directory.path().join("matrix-sdk");
    let mut empty_store = Store::open(
        &app_path,
        Keyring::new([0x11; 32], 1).expect("test keyring"),
    )
    .unwrap();
    let missing = match restore_matrix_processor(
        &offline_server.uri(),
        "@missing-bootstrap:example.org",
        &sdk_path,
        &SecretBytes::from_text(b"passphrase", 1024).unwrap(),
        &empty_store,
    )
    .await
    {
        Ok(_) => panic!("missing bootstrap must fail closed"),
        Err(error) => error,
    };
    assert_eq!(missing.code(), "matrix_session_invalid");
    assert!(!sdk_path.exists());

    let session = MatrixSession {
        meta: SessionMeta {
            user_id: owned_user_id!("@corrupt-session:example.org"),
            device_id: owned_device_id!("CORRUPTSESSION"),
        },
        tokens: SessionTokens {
            access_token: "corrupt-session-token".to_owned(),
            refresh_token: None,
        },
    };
    empty_store
        .initialize_bootstrap_state(
            NewBootstrapState::new(
                b"not-json".to_vec(),
                b"corrupt-session-next".to_vec(),
                Vec::new(),
                Utc.timestamp_millis_opt(1_700_000_014_000)
                    .single()
                    .unwrap(),
            )
            .unwrap(),
        )
        .unwrap();
    let corrupt = match restore_matrix_processor(
        &offline_server.uri(),
        session.meta.user_id.as_str(),
        &sdk_path,
        &SecretBytes::from_text(b"passphrase", 1024).unwrap(),
        &empty_store,
    )
    .await
    {
        Ok(_) => panic!("corrupt session must fail closed"),
        Err(error) => error,
    };
    assert_eq!(corrupt.code(), "matrix_session_invalid");
    assert!(
        offline_server
            .server()
            .received_requests()
            .await
            .unwrap()
            .is_empty()
    );
}

#[test]
fn public_transport_constructor_rejects_non_https_origins_and_secret_details() {
    const CANARY: &str = "matrix-adapter-transport-canary";
    let error = ReqwestMatrixTransport::new(
        "http://127.0.0.1:8080",
        SecretBytes::from_text(CANARY.as_bytes(), 1024).expect("token"),
        std::time::Duration::from_secs(1),
        std::time::Duration::from_secs(1),
    )
    .expect_err("production transport must reject loopback HTTP");
    assert_eq!(error.code(), "matrix_transport_invalid");
    assert!(!format!("{error:?}").contains(CANARY));
    assert!(!error.to_string().contains(CANARY));
    assert!(std::error::Error::source(&error).is_none());
}

#[test]
fn restart_ack_and_secret_bearing_adapter_values_are_redacted() {
    let reason = ReasonCode::new("matrix_crypto_ack_unrecoverable").expect("reason code");
    let value = RestartCryptoAck::Unrecoverable(reason);
    assert_eq!(value.discriminant(), "unrecoverable");
    assert_eq!(format!("{value:?}"), "RestartCryptoAck([REDACTED])");
    assert_eq!(value.to_string(), "RestartCryptoAck([REDACTED])");
}

#[tokio::test]
async fn matrix_session_round_trips_and_restores_into_sqlite_store() {
    let session = MatrixSession {
        meta: SessionMeta {
            user_id: owned_user_id!("@example:localhost"),
            device_id: owned_device_id!("DEVICEID"),
        },
        tokens: SessionTokens {
            access_token: "test-access".into(),
            refresh_token: Some("test-refresh".into()),
        },
    };

    let serialized = serde_json::to_vec(&session).unwrap();
    let restored: MatrixSession = serde_json::from_slice(&serialized).unwrap();
    assert!(restored.meta.user_id == session.meta.user_id);
    assert!(restored.meta.device_id == session.meta.device_id);
    assert!(restored.tokens.access_token == session.tokens.access_token);
    assert!(restored.tokens.refresh_token == session.tokens.refresh_token);

    let directory = tempdir().unwrap();
    let path = directory.path().join("matrix-sdk");
    let passphrase = "test-passphrase".to_owned();
    let loopback_url = Url::parse("http://127.0.0.1:9").unwrap();
    let client = Client::builder()
        .homeserver_url(loopback_url)
        .sqlite_store(path, Some(passphrase.as_str()))
        .build()
        .await
        .unwrap();

    client.restore_session(restored).await.unwrap();
}

#[tokio::test]
async fn matrix_sync_suppresses_replayed_timeline_event_from_same_store() {
    let mock_server = MatrixMockServer::new().await;
    let room_id = room_id!("!replay-room:localhost");
    let user_id = owned_user_id!("@replay-user:localhost");
    let device_id = owned_device_id!("REPLAYDEVICE");
    let access_token = "replay-access-token";
    let expected_event_id = "$replay-event:localhost";
    let event_id = event_id!("$replay-event:localhost");
    let temp_dir = tempdir().unwrap();
    let store_path = temp_dir.path().join("matrix-sdk");
    let passphrase = "replay-passphrase";

    mock_server
        .mock_sync()
        .ok(|builder| {
            builder.add_joined_room(
                JoinedRoomBuilder::new(room_id).add_timeline_event(
                    EventFactory::new()
                        .room(room_id)
                        .sender(&user_id)
                        .text_msg("replay me")
                        .event_id(event_id),
                ),
            );
        })
        .expect(2)
        .mount()
        .await;

    let client_a = mock_server
        .client_builder()
        .logged_in_with_token(access_token.to_owned(), user_id.clone(), device_id.clone())
        .on_builder(|builder| builder.sqlite_store(&store_path, Some(passphrase)))
        .build()
        .await;
    let response_a = client_a
        .sync_once(SyncSettings::default().token("s0"))
        .await
        .unwrap();
    let next_batch_a = response_a.next_batch.clone();
    let timeline_a = &response_a.rooms.joined[room_id].timeline.events;
    assert_eq!(
        timeline_a.len(),
        1,
        "expected one durable timeline message in A"
    );
    let event_a = &timeline_a[0];
    let event_id_a = event_a.kind.event_id().map(|id| id.to_string());
    let body_a = event_a
        .kind
        .raw()
        .get_field::<serde_json::Value>("content")
        .unwrap()
        .and_then(|content| {
            content
                .get("body")
                .and_then(serde_json::Value::as_str)
                .map(str::to_owned)
        });

    drop(client_a);

    let client_b = mock_server
        .client_builder()
        .logged_in_with_token(access_token.to_owned(), user_id, device_id)
        .on_builder(|builder| builder.sqlite_store(&store_path, Some(passphrase)))
        .build()
        .await;
    let response_b = client_b
        .sync_once(SyncSettings::default().token("s0"))
        .await
        .unwrap();
    assert!(
        response_b
            .rooms
            .joined
            .get(room_id)
            .is_none_or(|room| room.timeline.events.is_empty()),
        "expected the already-stored timeline event to be suppressed in B"
    );
    assert_eq!(event_id_a, Some(expected_event_id.to_owned()));
    assert_eq!(body_a, Some("replay me".to_owned()));
    assert_eq!(response_b.next_batch, next_batch_a);

    let sync_requests: Vec<_> = mock_server
        .received_requests()
        .await
        .expect("request recording should be enabled")
        .into_iter()
        .filter(|request| request.url.path() == "/_matrix/client/v3/sync")
        .collect();
    assert_eq!(
        sync_requests.len(),
        2,
        "expected exactly two /sync requests"
    );
    for request in sync_requests {
        assert_eq!(request.url.path(), "/_matrix/client/v3/sync");
        let since = request
            .url
            .query_pairs()
            .find_map(|(key, value)| (key == "since").then(|| value.into_owned()));
        assert_eq!(since.as_deref(), Some("s0"));
    }
}

#[tokio::test]
async fn encrypted_raw_event_can_be_decrypted_after_persistent_client_reopen() {
    let mock_server = MatrixMockServer::new().await;
    mock_server.mock_crypto_endpoints_preset().await;

    let sender_user_id = owned_user_id!("@e2ee-sender:example.org");
    let sender_device_id = owned_device_id!("SENDDEVICE");
    let sender = mock_server
        .client_builder_for_crypto_end_to_end(&sender_user_id, &sender_device_id)
        .build()
        .await;
    let receiver_user_id = owned_user_id!("@e2ee-receiver:example.org");
    let receiver_device_id = owned_device_id!("RECVDEVICE");
    let session = MatrixSession {
        meta: SessionMeta {
            user_id: receiver_user_id.clone(),
            device_id: receiver_device_id.clone(),
        },
        tokens: SessionTokens {
            access_token: "offline-access-token".to_owned(),
            refresh_token: None,
        },
    };
    let directory = tempdir().unwrap();
    let store_path = directory.path().join("matrix-sdk");
    let passphrase = "offline-e2ee-passphrase";
    let client = mock_server
        .client_builder_for_crypto_end_to_end(&receiver_user_id, &receiver_device_id)
        .on_builder(|builder| builder.sqlite_store(&store_path, Some(passphrase)))
        .build()
        .await;
    mock_server.exchange_e2ee_identities(&sender, &client).await;
    sender
        .encryption()
        .wait_for_e2ee_initialization_tasks()
        .await;
    client
        .encryption()
        .wait_for_e2ee_initialization_tasks()
        .await;

    let room_id = room_id!("!e2ee-recovery:example.org");
    let settings = DecryptionSettings {
        sender_device_trust_requirement: TrustRequirement::Untrusted,
    };
    let saved_ciphertext = {
        let sender_guard = sender.olm_machine_for_testing().await;
        let sender_machine = sender_guard.as_ref().unwrap();
        let receiver_guard = client.olm_machine_for_testing().await;
        let receiver = receiver_guard.as_ref().unwrap();

        if let Some((request_id, request)) = sender_machine
            .get_missing_sessions(std::iter::once(receiver.user_id()))
            .await
            .unwrap()
        {
            let response = sender.send(request).await.unwrap();
            sender_machine
                .mark_request_as_sent(&request_id, &response)
                .await
                .unwrap();
        }

        let room_key_requests = sender_machine
            .share_room_key(
                room_id,
                std::iter::once(receiver.user_id()),
                EncryptionSettings::default(),
            )
            .await;
        let room_key_requests = room_key_requests.unwrap();
        let room_key_event =
            room_key_event_from_requests(receiver, sender_machine, room_key_requests);

        let encrypted = sender_machine
            .encrypt_room_event(
                room_id,
                ruma::events::room::message::RoomMessageEventContent::text_plain("persist me"),
            )
            .await;
        let encrypted = encrypted.unwrap();
        let encrypted_content: Value =
            serde_json::from_str(encrypted.content.json().get()).unwrap();
        let raw_event: Raw<AnySyncTimelineEvent> = matrix_sdk_test::sync_timeline_event!({
            "event_id": "$e2ee-recovery-event:example.org",
            "origin_server_ts": MilliSecondsSinceUnixEpoch::now(),
            "sender": sender_machine.user_id(),
            "type": "m.room.encrypted",
            "content": encrypted_content,
        });

        drop(receiver_guard);
        drop(sender_guard);

        (room_key_event, raw_event)
    };

    let pause_result = client.pause().await;
    pause_result.unwrap();
    drop(client);
    drop(sender);

    let (room_key_event, saved_ciphertext) = saved_ciphertext;
    let mut response_builder = SyncResponseBuilder::new();
    response_builder
        .add_joined_room(
            JoinedRoomBuilder::new(room_id).add_timeline_event(saved_ciphertext.clone()),
        )
        .add_to_device_event(serde_json::from_str(room_key_event.json().get()).unwrap());
    let typed_response = response_builder.build_sync_response();

    let base = open_test_base_client(&store_path, &store_path, passphrase, session.meta.clone())
        .await
        .unwrap();
    let processed = base.receive_sync_response(typed_response).await.unwrap();
    let processed_metadata = decrypted_event_metadata_from_response(&processed, room_id);
    assert_eq!(
        processed_metadata.event_id,
        saved_ciphertext.get_field::<String>("event_id").unwrap()
    );
    assert_eq!(
        processed_metadata.sender,
        saved_ciphertext.get_field::<String>("sender").unwrap()
    );
    assert_eq!(processed_metadata.room_id, Some(room_id.to_string()));
    assert_eq!(
        processed_metadata.event_type,
        Some("m.room.message".to_owned())
    );
    assert_eq!(processed_metadata.body, Some("persist me".to_owned()));
    base.close_stores().await.unwrap();
    drop(base);

    let reopened =
        open_test_base_client(&store_path, &store_path, passphrase, session.meta.clone())
            .await
            .unwrap();
    let receiver_guard = reopened.olm_machine().await;
    let receiver = receiver_guard.as_ref().unwrap();
    let decrypted = receiver
        .decrypt_room_event(saved_ciphertext.cast_ref_unchecked(), room_id, &settings)
        .await;
    let decrypted = decrypted.unwrap();
    let metadata = decrypted_event_metadata(&decrypted.event);
    assert_eq!(metadata, processed_metadata);
    assert_eq!(
        metadata.event_id,
        saved_ciphertext.get_field::<String>("event_id").unwrap()
    );
    assert_eq!(
        metadata.sender,
        saved_ciphertext.get_field::<String>("sender").unwrap()
    );
    assert_eq!(metadata.room_id, Some(room_id.to_string()));
    assert_eq!(metadata.event_type, Some("m.room.message".to_owned()));
    assert_eq!(metadata.body, Some("persist me".to_owned()));
    drop(receiver_guard);
    reopened.close_stores().await.unwrap();
    drop(reopened);
}

#[tokio::test]
async fn partial_crypto_commit_reapplies_saved_response_idempotently() {
    let mock_server = MatrixMockServer::new().await;
    mock_server.mock_crypto_endpoints_preset().await;

    let sender_user_id = owned_user_id!("@partial-sender:example.org");
    let sender_device_id = owned_device_id!("PARTIALSENDER");
    let sender = mock_server
        .client_builder_for_crypto_end_to_end(&sender_user_id, &sender_device_id)
        .build()
        .await;
    let receiver_user_id = owned_user_id!("@partial-receiver:example.org");
    let receiver_device_id = owned_device_id!("PARTIALRECEIVER");
    let directory = tempdir().unwrap();
    let store_path = directory.path().join("matrix-sdk");
    let passphrase = "partial-replay-passphrase";
    let receiver = mock_server
        .client_builder_for_crypto_end_to_end(&receiver_user_id, &receiver_device_id)
        .on_builder(|builder| builder.sqlite_store(&store_path, Some(passphrase)))
        .build()
        .await;
    mock_server
        .exchange_e2ee_identities(&sender, &receiver)
        .await;
    sender
        .encryption()
        .wait_for_e2ee_initialization_tasks()
        .await;
    receiver
        .encryption()
        .wait_for_e2ee_initialization_tasks()
        .await;

    let room_id = room_id!("!partial-replay:example.org");
    let sender_guard = sender.olm_machine_for_testing().await;
    let sender_machine = sender_guard.as_ref().unwrap();
    let receiver_guard = receiver.olm_machine_for_testing().await;
    let receiver_machine = receiver_guard.as_ref().unwrap();
    if let Some((request_id, request)) = sender_machine
        .get_missing_sessions(std::iter::once(receiver_machine.user_id()))
        .await
        .unwrap()
    {
        let response = sender.send(request).await.unwrap();
        sender_machine
            .mark_request_as_sent(&request_id, &response)
            .await
            .unwrap();
    }
    let room_key_requests = sender_machine
        .share_room_key(
            room_id,
            std::iter::once(receiver_machine.user_id()),
            EncryptionSettings::default(),
        )
        .await
        .unwrap();
    let room_key_event =
        room_key_event_from_requests(receiver_machine, sender_machine, room_key_requests);
    let encrypted = sender_machine
        .encrypt_room_event(
            room_id,
            ruma::events::room::message::RoomMessageEventContent::text_plain("partial replay"),
        )
        .await
        .unwrap();
    let encrypted_content: Value = serde_json::from_str(encrypted.content.json().get()).unwrap();
    let encrypted_event: Raw<AnySyncTimelineEvent> = matrix_sdk_test::sync_timeline_event!({
        "event_id": "$partial-replay-event:example.org",
        "origin_server_ts": MilliSecondsSinceUnixEpoch::now(),
        "sender": sender_machine.user_id(),
        "type": "m.room.encrypted",
        "content": encrypted_content,
    });
    let expected_event_id = encrypted_event.get_field::<String>("event_id").unwrap();
    let expected_sender = encrypted_event.get_field::<String>("sender").unwrap();
    drop(receiver_guard);
    drop(sender_guard);

    let mut response_builder = SyncResponseBuilder::new();
    response_builder
        .add_joined_room(JoinedRoomBuilder::new(room_id).add_timeline_event(encrypted_event))
        .add_to_device_event(serde_json::from_str(room_key_event.json().get()).unwrap());
    let expected_token = "partial-replay-token";
    let mut typed_response = response_builder.build_sync_response();
    typed_response.next_batch = expected_token.to_owned();
    let saved_response: HttpResponse<Vec<u8>> = typed_response
        .try_into_http_response()
        .expect("sync fixture should serialize");
    let saved_response_body = saved_response.body().clone();
    let saved_response = RumaSyncResponse::try_from_http_response(saved_response)
        .expect("sync fixture should parse");
    assert!(!saved_response_body.is_empty());

    receiver.pause().await.unwrap();
    drop(receiver);

    let session_meta = SessionMeta {
        user_id: receiver_user_id.clone(),
        device_id: receiver_device_id.clone(),
    };
    let base = open_test_base_client(&store_path, &store_path, passphrase, session_meta.clone())
        .await
        .unwrap();
    let old_token = base.sync_token().await;
    assert!(
        old_token.is_some(),
        "E2EE setup should leave an old sync token"
    );

    // `receive_sync_response` has no public commit hook: it commits crypto and
    // the sync token in one call. Cloning with an in-memory state store is the
    // closest public-API crash simulation: the clone shares the persistent
    // crypto store while the original persistent state store keeps its old
    // token. This proves replay safety after crypto-only persistence.
    let replay = base
        .clone_with_in_memory_state_store(
            matrix_sdk_common::cross_process_lock::CrossProcessLockConfig::SingleProcess,
            true,
        )
        .await
        .unwrap();
    let first = replay
        .receive_sync_response(saved_response.clone())
        .await
        .unwrap();
    assert_eq!(replay.sync_token().await.as_deref(), Some(expected_token));
    assert_eq!(base.sync_token().await, old_token);
    let first_metadata = decrypted_event_metadata_from_response(&first, room_id);
    assert_eq!(first_metadata.event_id, expected_event_id);
    assert_eq!(first_metadata.sender, expected_sender);
    assert_eq!(first_metadata.room_id, Some(room_id.to_string()));
    assert_eq!(first_metadata.event_type, Some("m.room.message".to_owned()));
    assert_eq!(first_metadata.body, Some("partial replay".to_owned()));
    drop(replay);
    base.close_stores().await.unwrap();
    drop(base);

    let reopened = open_test_base_client(&store_path, &store_path, passphrase, session_meta)
        .await
        .unwrap();
    assert_eq!(reopened.sync_token().await, old_token);
    let second = reopened
        .receive_sync_response(saved_response.clone())
        .await
        .unwrap();
    let second_metadata = decrypted_event_metadata_from_response(&second, room_id);
    assert_eq!(second_metadata, first_metadata);
    assert_eq!(second_metadata.event_id, expected_event_id);
    assert_eq!(second_metadata.sender, expected_sender);
    assert_eq!(second_metadata.room_id, Some(room_id.to_string()));
    assert_eq!(
        second_metadata.event_type,
        Some("m.room.message".to_owned())
    );
    assert_eq!(second_metadata.body, Some("partial replay".to_owned()));
    assert_eq!(reopened.sync_token().await.as_deref(), Some(expected_token));

    let duplicate = reopened
        .receive_sync_response(saved_response)
        .await
        .unwrap();
    assert!(duplicate.rooms.is_empty());
    assert_eq!(reopened.sync_token().await.as_deref(), Some(expected_token));
    reopened.close_stores().await.unwrap();
    drop(reopened);
    drop(sender);
}

fn room_key_event_from_requests(
    receiver: &OlmMachine,
    sender: &OlmMachine,
    requests: Vec<std::sync::Arc<matrix_sdk_crypto::types::requests::ToDeviceRequest>>,
) -> Raw<AnyToDeviceEvent> {
    let request = requests.into_iter().next().unwrap();
    let receiver_messages = request
        .messages
        .get(receiver.user_id())
        .expect("room-key request must target the receiver user");
    let receiver_device = DeviceIdOrAllDevices::DeviceId(receiver.device_id().to_owned());
    let content = receiver_messages
        .get(&receiver_device)
        .expect("room-key request must target the receiver device")
        .clone();
    let content: ToDeviceEncryptedEventContent = content
        .deserialize_as_unchecked()
        .expect("room-key content fixture must deserialize");
    let event = ToDeviceEvent::new(sender.user_id().to_owned(), content);
    Raw::new(&event).unwrap().cast_unchecked()
}

#[derive(Debug, Eq, PartialEq)]
struct DecryptedEventMetadata {
    event_id: Option<String>,
    sender: Option<String>,
    room_id: Option<String>,
    event_type: Option<String>,
    body: Option<String>,
}

fn decrypted_event_metadata<T>(event: &Raw<T>) -> DecryptedEventMetadata {
    let body = event
        .get_field::<Value>("content")
        .unwrap()
        .and_then(|content| {
            content
                .get("body")
                .and_then(Value::as_str)
                .map(str::to_owned)
        });
    DecryptedEventMetadata {
        event_id: event.get_field::<String>("event_id").unwrap(),
        sender: event.get_field::<String>("sender").unwrap(),
        room_id: event.get_field::<String>("room_id").unwrap(),
        event_type: event.get_field::<String>("type").unwrap(),
        body,
    }
}

fn decrypted_event_metadata_from_response(
    response: &matrix_sdk_base::sync::SyncResponse,
    room_id: &ruma::RoomId,
) -> DecryptedEventMetadata {
    let room = response
        .rooms
        .joined
        .get(room_id)
        .expect("saved response should return the joined room");
    assert_eq!(room.timeline.events.len(), 1);
    let event = &room.timeline.events[0];
    assert!(
        event.encryption_info().is_some(),
        "saved encrypted event should be decrypted by BaseClient"
    );
    decrypted_event_metadata(event.kind.raw())
}
