use communicator_matrix_gateway::matrix::{
    MAX_SYNC_RESPONSE_BYTES, PreserveSyncResponseError, RestartCryptoAck, open_base_client,
    preserve_sync_response, sync_request_to_http,
};
use communicator_matrix_gateway::matrix_http::ReqwestMatrixTransport;
use communicator_matrix_gateway::secret::SecretBytes;
use communicator_matrix_gateway::store_types::ReasonCode;
use http::Response as HttpResponse;
use matrix_sdk::{Client, SessionMeta, SessionTokens, authentication::matrix::MatrixSession};
use matrix_sdk::{config::SyncSettings, test_utils::mocks::MatrixMockServer};
use matrix_sdk_crypto::{
    DecryptionSettings, EncryptionSettings, OlmMachine, TrustRequirement,
    types::events::{ToDeviceEvent, room::encrypted::ToDeviceEncryptedEventContent},
};
use matrix_sdk_test::{JoinedRoomBuilder, SyncResponseBuilder, event_factory::EventFactory};
use ruma::{
    MilliSecondsSinceUnixEpoch,
    api::OutgoingResponse,
    event_id,
    events::{AnySyncTimelineEvent, AnyToDeviceEvent},
    owned_device_id, owned_user_id, room_id,
    serde::Raw,
    to_device::DeviceIdOrAllDevices,
};
use serde_json::Value;
use tempfile::tempdir;
use url::Url;

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

#[test]
fn sync_request_conversion_uses_v3_since_and_bearer_auth() {
    let request = sync_request_to_http(
        "https://matrix.example",
        "access-token",
        Some("since-token".to_owned()),
    )
    .unwrap();

    assert_eq!(request.uri().path(), "/_matrix/client/v3/sync");
    assert_eq!(
        request
            .uri()
            .query()
            .and_then(|query| query.strip_prefix("since=")),
        Some("since-token")
    );
    assert_eq!(
        request.headers().get("authorization").unwrap(),
        "Bearer access-token"
    );
}

#[test]
fn preserve_sync_response_keeps_body_and_parses_next_batch() {
    let expected_next_batch = "next-batch-token";
    let mut typed_response = SyncResponseBuilder::new().build_sync_response();
    typed_response.next_batch = expected_next_batch.to_owned();
    let response: HttpResponse<Vec<u8>> = typed_response.try_into_http_response().unwrap();
    let expected_body = response.body().clone();

    let preserved = preserve_sync_response(response).unwrap();

    assert_eq!(preserved.body, expected_body);
    assert_eq!(preserved.typed.next_batch, expected_next_batch);
}

#[test]
fn preserve_sync_response_rejects_empty_body_as_empty() {
    let response = HttpResponse::builder()
        .status(200)
        .body(Vec::new())
        .unwrap();

    assert!(matches!(
        preserve_sync_response(response),
        Err(PreserveSyncResponseError::Empty)
    ));
}

#[test]
fn preserve_sync_response_rejects_64_mib_plus_one_as_too_large() {
    let response = HttpResponse::builder()
        .status(200)
        .body(vec![b'x'; MAX_SYNC_RESPONSE_BYTES + 1])
        .unwrap();

    assert!(matches!(
        preserve_sync_response(response),
        Err(PreserveSyncResponseError::TooLarge)
    ));
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

    let base = open_base_client(&store_path, &store_path, passphrase, session.meta.clone())
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

    let reopened = open_base_client(&store_path, &store_path, passphrase, session.meta.clone())
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
    let saved_response =
        preserve_sync_response(typed_response.try_into_http_response().unwrap()).unwrap();
    let saved_response_body = saved_response.body.clone();
    let saved_response = saved_response.typed;
    assert!(!saved_response_body.is_empty());

    receiver.pause().await.unwrap();
    drop(receiver);

    let session_meta = SessionMeta {
        user_id: receiver_user_id.clone(),
        device_id: receiver_device_id.clone(),
    };
    let base = open_base_client(&store_path, &store_path, passphrase, session_meta.clone())
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

    let reopened = open_base_client(&store_path, &store_path, passphrase, session_meta)
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
