#![cfg(all(feature = "loopback-test", unix))]

//! Local sidecar for the Node Platform/Communicator HTTP integration proof.
//! Only Matrix is controlled here. SDK session restoration and joined-room sync
//! are fixtures, not evidence of a real Matrix login, bridge, or WhatsApp delivery.

use std::{
    fs::{self, OpenOptions},
    io::Write,
    os::unix::fs::{DirBuilderExt, OpenOptionsExt, PermissionsExt},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::Duration,
};

use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use chrono::{DateTime, Utc};
use communicator_matrix_gateway::{
    authority::AuthorityClaimClient,
    crypto::Keyring,
    history::HistoryGatewayServer,
    ingestion::SecretString,
    matrix_http::ReqwestMatrixTransport,
    model::Provider,
    provisioning::{GatewayRouteMetadata, ProvisioningGatewayServer, WhatsAppProvisioningClient},
    registry::NewRoomBinding,
    secret::{SecretKind, load_secret},
    store::Store,
    store_types::NewBootstrapState,
};
use ctr::cipher::{KeyIvInit, StreamCipher};
use matrix_sdk::{encryption::EncryptionSettings, test_utils::mocks::MatrixMockServer};
use matrix_sdk_base::{BaseClient, DmRoomDefinition, ThreadingSupport, store::StoreConfig};
use matrix_sdk_common::cross_process_lock::CrossProcessLockConfig;
use matrix_sdk_crypto::OlmMachine;
use matrix_sdk_sqlite::{SqliteCryptoStore, SqliteStateStore};
use matrix_sdk_test::{JoinedRoomBuilder, event_factory::EventFactory};
use rand_core::{OsRng, RngCore};
use ruma::{RoomVersionId, owned_device_id, owned_user_id, room_id, serde::Raw};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tokio::{net::TcpListener, task::JoinSet};
use wiremock::{Mock, Request, Respond, ResponseTemplate, matchers};

const MATRIX_USER: &str = "@t13:example.test";
const ROOM: &str = "!integrated:example.test";
const GENERATION: &str = "2026-08-29T00:00:00.000Z";
const HISTORY_TEXT_ID: &str = "$t13-encrypted-text:example.test";
const HISTORY_MEDIA_ID: &str = "$t13-encrypted-media:example.test";
const HISTORY_TEXT: &str = "controlled integrated encrypted history text";
const HISTORY_FILE: &[u8] = b"controlled integrated encrypted history media";
const GROUP_NAME: &str = "T13 controlled group";
const GROUP_SOURCE_ID: &str = "$t13-group-rename:example.test";
// This is an unused bridge fixture, never a Platform credential. The private
// transport token is separate from the caller's issued authority credential.
const BRIDGE_TOKEN: &str = "t13-local-bridge-fixture-only";

fn env(name: &str) -> String {
    std::env::var(name).unwrap_or_else(|_| panic!("missing {name}"))
}

fn digest(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn sent_event_id(transaction: &str) -> String {
    format!("$t13_{}:example.test", digest(transaction.as_bytes()))
}

#[derive(Clone)]
struct ProviderEvidenceBoundary {
    path: PathBuf,
    stats: Arc<Mutex<Stats>>,
    stats_path: PathBuf,
}

impl Respond for ProviderEvidenceBoundary {
    fn respond(&self, request: &Request) -> ResponseTemplate {
        let mut stats = self.stats.lock().expect("evidence stats lock");
        stats.evidence_requests += 1;
        write_json(&self.stats_path, &*stats);
        let input = fs::read(&self.path)
            .ok()
            .filter(|bytes| bytes.len() <= 8192)
            .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok());
        let Some(input) = input else {
            return ResponseTemplate::new(404).set_body_json(json!({"errcode":"M_NOT_FOUND"}));
        };
        let Some(transaction) = input["transaction_id"]
            .as_str()
            .filter(|id| id.len() <= 512)
        else {
            return ResponseTemplate::new(400).set_body_json(json!({"errcode":"M_BAD_JSON"}));
        };
        let kind = input["kind"].as_str().unwrap_or("pending");
        if ![
            "accepted",
            "delivered",
            "forged",
            "wrong_reference",
            "pending",
            "rejected",
        ]
        .contains(&kind)
        {
            return ResponseTemplate::new(400).set_body_json(json!({"errcode":"M_BAD_JSON"}));
        }
        let encoded_id = request
            .url
            .path_segments()
            .and_then(|mut path| path.next_back())
            .unwrap_or("");
        let query = format!("id={}", encoded_id.replace('+', "%2B"));
        let event_id = url::form_urlencoded::parse(query.as_bytes())
            .next()
            .expect("event ID segment")
            .1
            .into_owned();
        let reference = if kind == "wrong_reference" {
            "$t13-wrong-reference:example.test".to_owned()
        } else {
            sent_event_id(transaction)
        };
        ResponseTemplate::new(200).set_body_json(json!({
            "event_id": event_id, "room_id": ROOM,
            "type": "com.beeper.message_send_status",
            "sender": if kind == "forged" { "@forged:example.test" } else { "@whatsappbot:example.test" },
            "origin_server_ts": Utc::now().timestamp_millis(),
            "content": {
                "status": match kind { "pending" => "PENDING", "rejected" => "FAIL_PERMANENT", _ => "SUCCESS" },
                "m.relates_to": {"rel_type":"m.reference", "event_id":reference},
                "delivered_to_users": if kind == "delivered" { vec!["@whatsapp_lid-123:example.test"] } else { vec![] }
            }
        }))
    }
}

async fn mount_encrypted_history(
    matrix: &MatrixMockServer,
    context: &BaseClient,
    state_key: &[u8; 32],
    stats: Arc<Mutex<Stats>>,
    stats_path: PathBuf,
) {
    let room = room_id!("!integrated:example.test");
    let sender = OlmMachine::new(
        &owned_user_id!("@t13:example.test"),
        &owned_device_id!("T13HISTORYSENDER"),
    )
    .await;
    sender
        .share_room_key(
            room,
            std::iter::empty(),
            matrix_sdk_crypto::EncryptionSettings::default(),
        )
        .await
        .expect("generate fixture Megolm session");
    // Keep the same immutable media source descriptor across restarts. These
    // fixture-only domains derive independent material from the random private
    // state key; neither keys nor IVs are published in readiness or statistics.
    let key = Sha256::digest([b"t13-fixture-media-key:".as_slice(), state_key].concat());
    let iv_digest = Sha256::digest([b"t13-fixture-media-iv:".as_slice(), state_key].concat());
    let iv = &iv_digest[..16];
    let mut ciphertext = HISTORY_FILE.to_vec();
    ctr::Ctr128BE::<aes::Aes256>::new_from_slices(&key, iv)
        .expect("fixture AES key")
        .apply_keystream(&mut ciphertext);
    let file = json!({
        "url": "mxc://example.test/t13-history-media", "v": "v2",
        "key": {"kty":"oct", "key_ops":["encrypt","decrypt"], "alg":"A256CTR",
            "k": URL_SAFE_NO_PAD.encode(key), "ext":true},
        "iv": URL_SAFE_NO_PAD.encode(iv),
        "hashes": {"sha256": URL_SAFE_NO_PAD.encode(Sha256::digest(&ciphertext))}
    });
    let mut chunk = Vec::new();
    for (event_id, content) in [
        (
            HISTORY_TEXT_ID,
            json!({"msgtype":"m.text", "body":HISTORY_TEXT}),
        ),
        (
            HISTORY_MEDIA_ID,
            json!({"msgtype":"m.image", "body":"t13-fixture.png",
            "file":file, "info":{"mimetype":"image/png", "size":HISTORY_FILE.len()}}),
        ),
    ] {
        let encrypted = sender
            .encrypt_room_event_raw(
                room,
                "m.room.message",
                &Raw::from_json_string(content.to_string()).expect("fixture message JSON"),
            )
            .await
            .expect("encrypt actual Megolm fixture");
        let content: Value =
            serde_json::from_str(encrypted.content.json().get()).expect("ciphertext JSON");
        chunk.push(
            json!({"event_id":event_id, "room_id":room, "sender":sender.user_id(),
            "origin_server_ts":1_788_004_800_000i64, "type":"m.room.encrypted", "content":content}),
        );
    }
    let keys = sender
        .store()
        .export_room_keys(|session| session.room_id() == room)
        .await
        .expect("export generated fixture room key");
    context
        .olm_machine()
        .await
        .as_ref()
        .expect("activated shared SDK Olm machine")
        .store()
        .import_exported_room_keys(keys, |_, _| {})
        .await
        .expect("import generated fixture key");
    // Bounded rename fixture: the SDK must actually issue set_name for this
    // exact controlled snapshot before any fresh bridge success is observable.
    let group_status: Arc<Mutex<Option<Value>>> = Arc::new(Mutex::new(None));
    let rename_status = Arc::clone(&group_status);
    Mock::given(matchers::method("PUT"))
        .and(matchers::path_regex(r"^/_matrix/client/(v3|r0)/rooms/[^/]+/state/m.room.name/?$"))
        .and(matchers::body_json(json!({"name":GROUP_NAME})))
        .respond_with(move |_: &Request| {
            let mut counts = stats.lock().expect("Matrix stats lock");
            counts.rename_requests += 1;
            write_json(&stats_path, &*counts);
            *rename_status.lock().expect("controlled bridge status") = Some(json!({
                "type":"com.beeper.message_send_status", "event_id":"$t13-group-success:example.test",
                "room_id":ROOM, "sender":"@whatsappbot:example.test", "origin_server_ts":Utc::now().timestamp_millis(),
                "content":{"status":"success", "m.relates_to":{"event_id":GROUP_SOURCE_ID}}
            }));
            ResponseTemplate::new(200).set_body_json(json!({"event_id":GROUP_SOURCE_ID}))
        }).mount(matrix).await;
    Mock::given(matchers::method("GET"))
        .and(matchers::path_regex(
            r"^/_matrix/client/(v3|r0)/rooms/[^/]+/messages$",
        ))
        .respond_with(move |_: &Request| {
            let mut events = chunk.clone();
            if let Some(status) = group_status
                .lock()
                .expect("controlled bridge status")
                .as_ref()
            {
                events.push(status.clone());
            }
            ResponseTemplate::new(200).set_body_json(json!({
                "start":"t13-controlled-history-page", "chunk":events, "state":[]
            }))
        })
        .mount(matrix)
        .await;
    Mock::given(matchers::method("GET"))
        .and(matchers::path(
            "/_matrix/client/v1/media/download/example.test/t13-history-media",
        ))
        .respond_with(
            ResponseTemplate::new(200)
                .insert_header("content-type", "application/octet-stream")
                .set_body_bytes(ciphertext),
        )
        .mount(matrix)
        .await;
}

fn write_json(path: &Path, value: &impl Serialize) {
    let temporary = path.with_extension("t13-tmp");
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&temporary)
        .expect("create content-free JSON temporary file");
    file.write_all(&serde_json::to_vec(value).expect("serialize content-free JSON"))
        .expect("write content-free JSON");
    file.sync_all().expect("flush JSON");
    fs::rename(temporary, path).expect("publish content-free JSON");
}

#[derive(Default, Deserialize, Serialize)]
#[serde(default)]
struct Stats {
    send_requests: u64,
    receipt_requests: u64,
    rename_requests: u64,
    send_rejections: u64,
    receipt_rejections: u64,
    evidence_requests: u64,
    send_tuples: Vec<Value>,
    receipt_tuples: Vec<Value>,
}

#[derive(Clone)]
struct MatrixBoundary {
    stats: Arc<Mutex<Stats>>,
    stats_path: PathBuf,
    reject_path: Option<PathBuf>,
    receipt: bool,
}

impl Respond for MatrixBoundary {
    fn respond(&self, request: &Request) -> ResponseTemplate {
        let reject = self.reject_path.as_ref().is_some_and(|path| path.exists());
        let mut stats = self.stats.lock().expect("Matrix stats lock");
        let segments: Vec<String> = request
            .url
            .path_segments()
            .unwrap()
            .map(|segment| {
                url::form_urlencoded::parse(format!("v={}", segment.replace('+', "%2B")).as_bytes())
                    .next()
                    .unwrap()
                    .1
                    .into_owned()
            })
            .collect();
        if self.receipt {
            stats.receipt_requests += 1;
            stats.receipt_rejections += u64::from(reject);
            let body: Value = serde_json::from_slice(&request.body).unwrap_or(Value::Null);
            let tuple = if segments.get(5).is_some_and(|part| part == "receipt") {
                json!({"room_id":segments.get(4), "kind":segments.get(6), "event_id":segments.get(7)})
            } else {
                json!({"room_id":segments.get(4), "kind":"read_markers", "body":body})
            };
            let expected = tuple
                == json!({"room_id":ROOM, "kind":"m.read", "event_id":"$inbound:example.test"});
            stats.receipt_tuples.push(tuple);
            if !expected {
                stats.receipt_rejections += 1;
                write_json(&self.stats_path, &*stats);
                return ResponseTemplate::new(400).set_body_json(json!({"errcode":"M_BAD_JSON"}));
            }
        } else {
            stats.send_requests += 1;
            stats.send_rejections += u64::from(reject);
            stats.send_tuples.push(json!({"room_id":segments.get(4), "event_type":segments.get(6), "transaction_id":segments.get(7)}));
        }
        write_json(&self.stats_path, &*stats);
        if reject {
            return ResponseTemplate::new(403).set_body_json(json!({
                "errcode": "M_FORBIDDEN", "error": "controlled Matrix rejection"
            }));
        }
        if self.receipt {
            ResponseTemplate::new(200).set_body_json(json!({}))
        } else {
            // Matrix transaction IDs are idempotent across sidecar restarts.
            let transaction = request.url.path_segments().unwrap().next_back().unwrap();
            ResponseTemplate::new(200)
                .set_body_json(json!({"event_id": sent_event_id(transaction)}))
        }
    }
}

#[tokio::test]
async fn controlled_receipt_endpoint_rejects_wrong_room_kind_event_and_markers() {
    let directory = tempfile::tempdir().unwrap();
    let stats = Arc::new(Mutex::new(Stats::default()));
    let server = wiremock::MockServer::start().await;
    Mock::given(matchers::method("POST"))
        .respond_with(MatrixBoundary {
            stats: Arc::clone(&stats),
            stats_path: directory.path().join("stats.json"),
            reject_path: None,
            receipt: true,
        })
        .mount(&server)
        .await;
    let client = reqwest::Client::new();
    for (room, kind, event, expected) in [
        (ROOM, "m.read", "$inbound:example.test", 200),
        (
            "!wrong:example.test",
            "m.read",
            "$inbound:example.test",
            400,
        ),
        (ROOM, "m.read.private", "$inbound:example.test", 400),
        (ROOM, "m.read", "$wrong:example.test", 400),
    ] {
        let response = client
            .post(format!(
                "{}/_matrix/client/v3/rooms/{room}/receipt/{kind}/{event}",
                server.uri()
            ))
            .header("content-type", "application/json")
            .body("{}")
            .send()
            .await
            .unwrap();
        assert_eq!(response.status().as_u16(), expected);
    }
    let markers = client
        .post(format!(
            "{}/_matrix/client/v3/rooms/{ROOM}/read_markers",
            server.uri()
        ))
        .header("content-type", "application/json")
        .body(json!({"m.read":"$wrong:example.test"}).to_string())
        .send()
        .await
        .unwrap();
    assert_eq!(markers.status(), 400);
    let observed = stats.lock().unwrap();
    assert_eq!(observed.receipt_requests, 5);
    assert_eq!(observed.receipt_rejections, 4);
    assert_eq!(observed.receipt_tuples.len(), 5);
}

/// Required: T13_WORKER_URL, T13_GATEWAY_CREDENTIAL (issued Platform service
/// credential), T13_GATEWAY_TOKEN (private gateway transport only),
/// T13_GATEWAY_PORT, T13_STATE_DIR, T13_READY_PATH, T13_STOP_PATH,
/// T13_STATS_PATH. Optional: T13_REJECT_PATH (existence rejects Matrix send and
/// receipt HTTP with 403); T13_EVIDENCE_PATH holds controlled provider status
/// input {transaction_id, kind}; no status is passed directly to the Worker.
/// Paths must have existing parent directories; state
/// must be private, persistent, and exclusively owned by this sidecar.
#[tokio::test]
#[ignore = "requires the isolated Node Platform/Communicator integration driver"]
async fn integrated_local_gateway_sidecar() {
    let ready_path = PathBuf::from(env("T13_READY_PATH"));
    let stop_path = PathBuf::from(env("T13_STOP_PATH"));
    assert!(
        !ready_path.exists(),
        "remove stale readiness before starting"
    );
    assert!(
        !stop_path.exists(),
        "remove stale stop file before starting"
    );
    let stats_path = PathBuf::from(env("T13_STATS_PATH"));
    let state = PathBuf::from(env("T13_STATE_DIR"));
    if !state.exists() {
        fs::DirBuilder::new()
            .mode(0o700)
            .create(&state)
            .expect("create private state");
    }
    let metadata = fs::symlink_metadata(&state).expect("state directory metadata");
    assert!(metadata.is_dir() && !metadata.file_type().is_symlink());
    assert_eq!(metadata.permissions().mode() & 0o777, 0o700);
    let key_path = state.join("fixture-state.key");
    if !key_path.exists() {
        let mut key = [0u8; 32];
        OsRng.fill_bytes(&mut key);
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&key_path)
            .expect("create persistent fixture key");
        file.write_all(&key).expect("write persistent fixture key");
        file.sync_all().expect("flush fixture key");
    }
    let key_metadata = fs::symlink_metadata(&key_path).expect("key metadata");
    assert!(key_metadata.is_file() && !key_metadata.file_type().is_symlink());
    assert_eq!(key_metadata.permissions().mode() & 0o777, 0o600);
    let key: [u8; 32] = fs::read(&key_path)
        .expect("read fixture key")
        .try_into()
        .expect("32-byte key");
    let mut store = Store::open(
        state.join("gateway.sqlite3"),
        Keyring::new(key, 1).expect("keyring"),
    )
    .expect("open or restore protected persistent Store");
    let restored = store
        .active_room_binding_for_outbound(
            "tenant_pilot",
            "account_human",
            "connection_human_whatsapp",
            "identity_human",
            Provider::Whatsapp,
            "conversation_integrated",
        )
        .expect("resolve persistent binding");
    let restored_state = restored.is_some();
    if let Some(binding) = restored {
        assert_eq!(binding.matrix_room_id(), ROOM);
        assert_eq!(binding.gateway_route_id(), "gateway_route_human");
        assert_eq!(binding.owner_matrix_user_id(), MATRIX_USER);
        assert_eq!(binding.session_generation(), Some(GENERATION));
    } else {
        store
            .append_room_binding(
                NewRoomBinding::new_with_session_generation(
                    "binding_13131313131313131313131313131313",
                    ROOM,
                    "tenant_pilot",
                    "identity_human",
                    "connection_human_whatsapp",
                    "account_human",
                    Provider::Whatsapp,
                    "gateway_route_human",
                    "conversation_integrated",
                    MATRIX_USER,
                    GENERATION,
                    DateTime::parse_from_rfc3339(GENERATION)
                        .expect("fixture time")
                        .with_timezone(&Utc),
                )
                .expect("fixture binding"),
            )
            .expect("persist fixture binding");
    }

    let matrix = MatrixMockServer::new().await;
    matrix.mock_crypto_endpoints_preset().await;
    let user_id = owned_user_id!("@t13:example.test");
    let device_id = owned_device_id!("T13DEVICE");
    // Persist the real SDK state/crypto stores and retain the shared BaseClient
    // used by both history decryption and outbound SDK calls. Authentication
    // and joined-room sync remain synthetic fixtures, not an actual login.
    // restore_matrix_client still rejects loopback HTTP in integration builds;
    // activate this fixture through the SDK builder rather than bypass its URL policy.
    let sdk_path = state.join("sdk");
    if !sdk_path.exists() {
        fs::DirBuilder::new()
            .mode(0o700)
            .create(&sdk_path)
            .expect("private SDK directory");
    }
    let sdk_passphrase = key
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    let context = BaseClient::new(
        StoreConfig::new(CrossProcessLockConfig::SingleProcess)
            .state_store(
                SqliteStateStore::open(&sdk_path, Some(&sdk_passphrase))
                    .await
                    .expect("persistent SDK state"),
            )
            .crypto_store(
                SqliteCryptoStore::open(&sdk_path, Some(&sdk_passphrase))
                    .await
                    .expect("persistent SDK crypto"),
            ),
        ThreadingSupport::Disabled,
        DmRoomDefinition::default(),
    );
    let matrix_client = matrix
        .client_builder_for_crypto_end_to_end(&user_id, &device_id)
        .on_builder(|builder| {
            builder
                .base_client(context.clone())
                .with_encryption_settings(EncryptionSettings {
                    auto_enable_cross_signing: true,
                    ..Default::default()
                })
        })
        .build()
        .await;
    if store
        .matrix_session()
        .expect("persisted session lookup")
        .is_none()
    {
        store
            .initialize_bootstrap_state(
                NewBootstrapState::new(
                    serde_json::to_vec(
                        &matrix_client
                            .matrix_auth()
                            .session()
                            .expect("synthetic SDK session"),
                    )
                    .expect("synthetic session serialization"),
                    b"t13-fixture-bootstrap".to_vec(),
                    Vec::new(),
                    DateTime::parse_from_rfc3339(GENERATION)
                        .expect("fixture bootstrap time")
                        .with_timezone(&Utc),
                )
                .expect("fixture bootstrap state"),
            )
            .expect("persist encrypted fixture bootstrap");
    }
    let room_id = room_id!("!integrated:example.test");
    let events = EventFactory::new().room(room_id).sender(&user_id);
    matrix
        .mock_sync()
        .ok_and_run(&matrix_client, |builder| {
            builder.add_joined_room(
                JoinedRoomBuilder::new(room_id)
                    .add_state_event(events.create(&user_id, RoomVersionId::V1))
                    .add_state_event(events.room_encryption())
                    .add_state_event(Raw::<ruma::events::AnySyncStateEvent>::from_json_string(json!({
                        "type":"m.room.name", "state_key":"", "event_id":"$t13-group-name:example.test",
                        "sender":"@whatsappbot:example.test", "origin_server_ts":Utc::now().timestamp_millis(),
                        "content":{"name":GROUP_NAME}
                    }).to_string()).expect("bridge-authored controlled name state")),
            );
        })
        .await;
    matrix
        .mock_get_members()
        .ok(vec![events.member(&user_id).into_raw()])
        .mount()
        .await;
    let stats = if stats_path.exists() {
        serde_json::from_slice(&fs::read(&stats_path).expect("read previous stats"))
            .expect("previous content-free stats")
    } else {
        Stats::default()
    };
    write_json(&stats_path, &stats);
    let boundary = MatrixBoundary {
        stats: Arc::new(Mutex::new(stats)),
        stats_path,
        reject_path: std::env::var_os("T13_REJECT_PATH").map(PathBuf::from),
        receipt: false,
    };
    mount_encrypted_history(
        &matrix,
        &context,
        &key,
        Arc::clone(&boundary.stats),
        boundary.stats_path.clone(),
    )
    .await;
    if let Some(path) = std::env::var_os("T13_EVIDENCE_PATH") {
        Mock::given(matchers::method("GET"))
            .and(matchers::path_regex(r"^/_matrix/client/(v3|r0)/rooms/[^/]+/state$"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!([{
                "type":"m.bridge", "state_key":"example.test/whatsapp",
                "event_id":"$t13-dm-state:example.test", "room_id":ROOM,
                "sender":"@whatsappbot:example.test", "origin_server_ts":Utc::now().timestamp_millis(),
                "content":{"bridgebot":"@whatsappbot:example.test", "protocol":{"id":"whatsapp"},
                    "com.beeper.room_type.v2":"dm", "channel":{"id":"123@lid"}}
            }])))
            .mount(&matrix).await;
        Mock::given(matchers::method("GET"))
            .and(matchers::path_regex(
                r"^/_matrix/client/(v3|r0)/rooms/[^/]+/event/[^/]+$",
            ))
            .respond_with(ProviderEvidenceBoundary {
                path: path.into(),
                stats: Arc::clone(&boundary.stats),
                stats_path: boundary.stats_path.clone(),
            })
            .mount(&matrix)
            .await;
    }
    Mock::given(matchers::method("PUT"))
        .and(matchers::path_regex(
            r"^/_matrix/client/(v3|r0)/rooms/[^/]+/send/[^/]+/[^/]+$",
        ))
        .respond_with(boundary.clone())
        .mount(&matrix)
        .await;
    Mock::given(matchers::method("POST"))
        .and(matchers::path_regex(
            r"^/_matrix/client/(v3|r0)/rooms/[^/]+/(receipt/[^/]+/[^/]+|read_markers)$",
        ))
        .respond_with(MatrixBoundary {
            receipt: true,
            ..boundary
        })
        .mount(&matrix)
        .await;

    // The feature-gated transport relaxes only the loopback URL boundary. Raw
    // HTTP, Megolm decryption, media verification and sealed cursors are real.
    let token_path = state.join("matrix-fixture-token");
    if !token_path.exists() {
        OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&token_path)
            .expect("create synthetic Matrix token")
            .write_all(b"TOKEN_0")
            .expect("write synthetic Matrix token");
    }
    let token = load_secret(&token_path, SecretKind::Text { max_bytes: 128 })
        .expect("load synthetic Matrix token");
    let transport = ReqwestMatrixTransport::new_for_test(
        &matrix.uri(),
        token,
        Duration::from_secs(5),
        Duration::from_secs(5),
    )
    .expect("actual loopback Matrix HTTP transport");
    let gateway_token = env("T13_GATEWAY_TOKEN");
    let history = HistoryGatewayServer::new(store, Arc::new(transport), gateway_token.clone())
        .expect("production history/store composition")
        .with_matrix_context(context.clone());
    let authority = AuthorityClaimClient::new_for_test(
        env("T13_WORKER_URL"),
        SecretString::new(env("T13_GATEWAY_CREDENTIAL")),
        Duration::from_secs(5),
    )
    .expect("real loopback Worker authority client");
    let bridge = WhatsAppProvisioningClient::new_for_test(
        matrix.uri(),
        SecretString::new(BRIDGE_TOKEN),
        MATRIX_USER,
        Duration::from_secs(5),
    )
    .expect("unused provisioning fixture client");
    let server = ProvisioningGatewayServer::new_with_matrix_runtime(
        bridge,
        SecretString::new(gateway_token),
        GatewayRouteMetadata {
            gateway_route_id: "gateway_route_human".to_owned(),
            bridge_instance_id: "bridge-human".to_owned(),
            matrix_user_id: MATRIX_USER.to_owned(),
            matrix_room_namespace: "example.test".to_owned(),
        },
        history,
        matrix_client.clone(),
        Arc::new(authority),
        Duration::from_secs(5),
    )
    .expect("production SDK sender/receipt/authority composition");
    let port: u16 = env("T13_GATEWAY_PORT").parse().expect("gateway port");
    let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, port))
        .await
        .expect("bind gateway");
    let gateway_port = listener.local_addr().expect("gateway address").port();
    write_json(
        &ready_path,
        &json!({
            "ready": true, "matrix_url": matrix.uri(), "gateway_port": gateway_port,
            "room_id": ROOM, "restored_state": restored_state,
            "matrix_session_fixture": true, "actual_matrix_login": false, "history_supported": true,
            "persisted_sdk_fixture": true, "production_restore_matrix_client": false,
            "encrypted_history_fixture": true,
            "controlled_expected_text_digest": digest(HISTORY_TEXT.as_bytes()),
            "file_digest": digest(HISTORY_FILE), "file_size_bytes": HISTORY_FILE.len(),
            "history_text_event_id": HISTORY_TEXT_ID, "history_media_event_id": HISTORY_MEDIA_ID,
            "group_rename_fixture": true,
            "history_start_at": "2026-08-29T00:00:00.000Z", "history_end_at": "2026-08-30T00:00:00.000Z"
        }),
    );
    // Use the production connection handler while tracking accepted tasks so
    // shutdown drains in-flight requests and releases the Store process lock.
    let server = Arc::new(server);
    let mut connections = JoinSet::new();
    loop {
        tokio::select! {
            accepted = listener.accept() => {
                let (stream, _) = accepted.expect("accept private gateway connection");
                let server = Arc::clone(&server);
                connections.spawn(async move { server.handle_connection(stream).await });
            }
            Some(result) = connections.join_next(), if !connections.is_empty() => {
                result.expect("gateway connection task").expect("gateway connection HTTP");
            }
            _ = tokio::time::sleep(Duration::from_millis(50)) => {
                if stop_path.exists() { break; }
            }
        }
    }
    fs::remove_file(ready_path).expect("remove readiness on shutdown");
    drop(listener);
    if tokio::time::timeout(Duration::from_secs(10), async {
        while let Some(result) = connections.join_next().await {
            result
                .expect("drained gateway task")
                .expect("drained gateway HTTP");
        }
    })
    .await
    .is_err()
    {
        connections.shutdown().await;
    }
    drop(server);
    drop(matrix_client);
    context
        .close_stores()
        .await
        .expect("close persistent SDK stores");
    drop(matrix);
}
