use std::time::Duration;

use communicator_matrix_gateway::outbound::{MatrixSdkTextSender, OutboundTextSender};
use matrix_sdk::{encryption::EncryptionSettings, test_utils::mocks::MatrixMockServer};
use matrix_sdk_test::{JoinedRoomBuilder, event_factory::EventFactory};
use ruma::{RoomVersionId, event_id, owned_device_id, owned_user_id, room_id};
use serde_json::{Value, json};
use wiremock::ResponseTemplate;

#[tokio::test]
async fn sdk_sender_emits_encrypted_event_with_stable_transaction_id() {
    let mock_server = MatrixMockServer::new().await;
    mock_server.mock_crypto_endpoints_preset().await;

    let user_id = owned_user_id!("@outbound-sender:example.org");
    let device_id = owned_device_id!("OUTBOUNDDEVICE");
    let client = mock_server
        .client_builder_for_crypto_end_to_end(&user_id, &device_id)
        .on_builder(|builder| {
            builder.with_encryption_settings(EncryptionSettings {
                auto_enable_cross_signing: true,
                ..Default::default()
            })
        })
        .build()
        .await;

    let room_id = room_id!("!outbound-sdk:example.org");
    let event_factory = EventFactory::new().room(room_id).sender(&user_id);
    mock_server
        .mock_sync()
        .ok_and_run(&client, |builder| {
            builder.add_joined_room(
                JoinedRoomBuilder::new(room_id)
                    .add_state_event(event_factory.create(&user_id, RoomVersionId::V1))
                    .add_state_event(event_factory.room_encryption()),
            );
        })
        .await;

    mock_server
        .mock_get_members()
        .ok(vec![event_factory.member(&user_id).into_raw()])
        .mock_once()
        .mount()
        .await;

    let (received_event, send_mock) = mock_server
        .mock_room_send()
        .expect_access_token("TOKEN_0")
        .ok_with_capture(event_id!("$outbound-sdk:example.org"), user_id.clone());
    send_mock.mock_once().mount().await;

    let sender = MatrixSdkTextSender::new(client, Duration::from_secs(5));
    let result = sender
        .send_encrypted_text(room_id.as_str(), "outbound-txn-21", "private body")
        .await
        .expect("the pinned Matrix SDK should send the encrypted event");
    assert_eq!(result.event_id, event_id!("$outbound-sdk:example.org"));

    let captured = received_event
        .await
        .expect("the mock should capture the SDK event");
    assert_eq!(
        captured.get_field::<String>("type").unwrap().as_deref(),
        Some("m.room.encrypted")
    );
    let content = captured
        .get_field::<Value>("content")
        .unwrap()
        .expect("encrypted event content");
    assert_eq!(
        content.get("algorithm").and_then(Value::as_str),
        Some("m.megolm.v1.aes-sha2")
    );
    assert!(content.get("ciphertext").and_then(Value::as_str).is_some());
    assert!(content.get("session_id").and_then(Value::as_str).is_some());
    assert!(
        content.get("body").is_none(),
        "plaintext must never cross the send boundary"
    );

    let requests = mock_server
        .received_requests()
        .await
        .expect("request recording should be enabled");
    let send_request = requests
        .iter()
        .find(|request| request.url.path().contains("/send/"))
        .expect("the SDK should issue a room send request");
    assert_eq!(
        send_request
            .url
            .path_segments()
            .and_then(|mut segments| segments.next_back()),
        Some("outbound-txn-21")
    );
}

async fn sender_with_matrix_error(
    status: u16,
    body: Value,
) -> (MatrixMockServer, MatrixSdkTextSender) {
    let mock_server = MatrixMockServer::new().await;
    mock_server.mock_crypto_endpoints_preset().await;

    let user_id = owned_user_id!("@outbound-error:example.org");
    let device_id = owned_device_id!("OUTBOUNDERROR");
    let client = mock_server
        .client_builder_for_crypto_end_to_end(&user_id, &device_id)
        .on_builder(|builder| {
            builder.with_encryption_settings(EncryptionSettings {
                auto_enable_cross_signing: true,
                ..Default::default()
            })
        })
        .build()
        .await;
    let room_id = room_id!("!outbound-error:example.org");
    let event_factory = EventFactory::new().room(room_id).sender(&user_id);
    mock_server
        .mock_sync()
        .ok_and_run(&client, |builder| {
            builder.add_joined_room(
                JoinedRoomBuilder::new(room_id)
                    .add_state_event(event_factory.create(&user_id, RoomVersionId::V1))
                    .add_state_event(event_factory.room_encryption()),
            );
        })
        .await;
    mock_server
        .mock_get_members()
        .ok(vec![event_factory.member(&user_id).into_raw()])
        .mock_once()
        .mount()
        .await;
    mock_server
        .mock_room_send()
        .expect_access_token("TOKEN_0")
        .respond_with(ResponseTemplate::new(status).set_body_json(body))
        .mock_once()
        .mount()
        .await;

    (
        mock_server,
        MatrixSdkTextSender::new(client, Duration::from_secs(5)),
    )
}

#[tokio::test]
async fn sdk_sender_preserves_expired_session_transport_classification() {
    let (_mock_server, sender) = sender_with_matrix_error(
        401,
        json!({"errcode": "M_UNKNOWN_TOKEN", "error": "expired"}),
    )
    .await;
    let error = sender
        .send_encrypted_text("!outbound-error:example.org", "outbound-error-auth", "body")
        .await
        .expect_err("an expired Matrix session must be surfaced");
    assert_eq!(
        error,
        communicator_matrix_gateway::outbound::OutboundSendFailure::MatrixSessionExpired
    );

    let (_mock_server, sender) = sender_with_matrix_error(
        403,
        json!({"errcode": "M_UNKNOWN_TOKEN", "error": "expired"}),
    )
    .await;
    let error = sender
        .send_encrypted_text(
            "!outbound-error:example.org",
            "outbound-error-explicit-token",
            "body",
        )
        .await
        .expect_err("an explicit unknown-token error must remain an auth failure");
    assert_eq!(
        error,
        communicator_matrix_gateway::outbound::OutboundSendFailure::MatrixSessionExpired
    );
}

#[tokio::test]
async fn sdk_sender_preserves_rate_limit_transport_classification() {
    let (_mock_server, sender) = sender_with_matrix_error(
        429,
        json!({"errcode": "M_LIMIT_EXCEEDED", "error": "slow", "retry_after_ms": 1000}),
    )
    .await;
    let error = sender
        .send_encrypted_text("!outbound-error:example.org", "outbound-error-rate", "body")
        .await
        .expect_err("a Matrix rate limit must be surfaced");
    assert_eq!(
        error,
        communicator_matrix_gateway::outbound::OutboundSendFailure::MatrixRateLimited
    );
}

#[tokio::test]
async fn sdk_sender_preserves_definitive_rejection_but_keeps_server_failure_uncertain() {
    let (_mock_server, sender) =
        sender_with_matrix_error(403, json!({"errcode": "M_FORBIDDEN", "error": "rejected"})).await;
    let error = sender
        .send_encrypted_text(
            "!outbound-error:example.org",
            "outbound-error-rejected",
            "body",
        )
        .await
        .expect_err("a definitive Matrix client error must be surfaced");
    assert_eq!(
        error,
        communicator_matrix_gateway::outbound::OutboundSendFailure::MatrixRejected
    );

    let (_mock_server, sender) = sender_with_matrix_error(
        500,
        json!({"errcode": "M_UNKNOWN", "error": "server unavailable"}),
    )
    .await;
    let error = sender
        .send_encrypted_text(
            "!outbound-error:example.org",
            "outbound-error-server",
            "body",
        )
        .await
        .expect_err("a Matrix server error must remain uncertain");
    assert_eq!(
        error,
        communicator_matrix_gateway::outbound::OutboundSendFailure::MatrixRequest
    );
}
