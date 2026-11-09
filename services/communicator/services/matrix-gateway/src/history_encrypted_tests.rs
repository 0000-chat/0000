// Controlled fixtures only. Keys are generated in memory, never saved as test artifacts.
mod encrypted_history {
    use super::*;
    use crate::{
        matrix::restore_matrix_client, matrix_http::ReqwestMatrixTransport,
        store_types::NewBootstrapState,
    };
    use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
    use ctr::cipher::{KeyIvInit, StreamCipher};
    use matrix_sdk::{SessionMeta, SessionTokens, authentication::matrix::MatrixSession};
    use matrix_sdk_base::{
        DmRoomDefinition, ThreadingSupport,
        store::{RoomLoadSettings, StoreConfig},
    };
    use matrix_sdk_common::cross_process_lock::CrossProcessLockConfig;
    use matrix_sdk_crypto::{EncryptionSettings, OlmMachine};
    use matrix_sdk_sqlite::{SqliteCryptoStore, SqliteStateStore};
    use ruma::{device_id, room_id, user_id};
    use sha2::{Digest, Sha256};
    use std::time::Duration;
    use wiremock::{Mock, MockServer, ResponseTemplate, matchers};

    #[tokio::test]
    async fn restored_history_decrypts_text_media_and_resumes_exact_missing_key_page_after_restart()
    {
        history_recovery(false).await;
    }

    #[tokio::test]
    async fn oversized_missing_key_page_resumes_from_pinned_source_cursor_after_restart() {
        history_recovery(true).await;
    }

    async fn history_recovery(oversized: bool) {
        let http = MockServer::start().await;
        let room = room_id!("!history:example.test");
        let sender = OlmMachine::new(user_id!("@owner:example.test"), device_id!("SENDER")).await;
        sender
            .share_room_key(room, std::iter::empty(), EncryptionSettings::default())
            .await
            .unwrap();

        let key = [7u8; 32];
        let iv = [9u8; 16];
        let plaintext = b"controlled encrypted history media";
        let mut ciphertext = plaintext.to_vec();
        ctr::Ctr128BE::<aes::Aes256>::new_from_slices(&key, &iv)
            .unwrap()
            .apply_keystream(&mut ciphertext);
        let encrypted_file = json!({
            "url": "mxc://matrix.example/history-media", "v": "v2",
            "key": {"kty":"oct", "key_ops":["encrypt","decrypt"], "alg":"A256CTR", "k":URL_SAFE_NO_PAD.encode(key), "ext":true},
            "iv": URL_SAFE_NO_PAD.encode(iv),
            "hashes": {"sha256":URL_SAFE_NO_PAD.encode(Sha256::digest(&ciphertext))},
        });
        let mut chunk = Vec::new();
        for (id, content) in [
            (
                "$encrypted-text:example.test",
                json!({"msgtype":"m.text", "body":"controlled decrypted history"}),
            ),
            (
                "$encrypted-media:example.test",
                json!({"msgtype":"m.image", "body":"photo.png", "file":encrypted_file, "info":{"mimetype":"image/png", "size":plaintext.len()}}),
            ),
        ] {
            let encrypted = sender
                .encrypt_room_event_raw(
                    room,
                    "m.room.message",
                    &Raw::from_json_string(content.to_string()).unwrap(),
                )
                .await
                .unwrap();
            let content: Value = serde_json::from_str(encrypted.content.json().get()).unwrap();
            let mut event = json!({"event_id":id, "room_id":room, "sender":sender.user_id(), "origin_server_ts":1_767_225_600_000i64, "type":"m.room.encrypted", "content":content});
            if oversized {
                event["unsigned"] = json!({"controlled_padding":"x".repeat(crate::ledger::MAX_BACKFILL_PAGINATION_BYTES)});
            }
            chunk.push(event);
        }
        Mock::given(matchers::method("GET"))
            .and(matchers::path_regex("/_matrix/client/v3/rooms/.*/messages"))
            .respond_with(
                ResponseTemplate::new(200).set_body_json(
                    json!({"start":"private-exact-page", "chunk":chunk, "state":[]}),
                ),
            )
            .expect(if oversized { 3 } else { 1 })
            .mount(&http)
            .await;
        Mock::given(matchers::method("GET"))
            .and(matchers::path(
                "/_matrix/client/v1/media/download/matrix.example/history-media",
            ))
            .respond_with(
                ResponseTemplate::new(200)
                    .insert_header("content-type", "application/octet-stream")
                    .set_body_bytes(ciphertext),
            )
            .expect(2)
            .mount(&http)
            .await;
        let transport = Arc::new(
            ReqwestMatrixTransport::new_for_test(
                &http.uri(),
                SecretBytes::new(b"controlled-access".to_vec()),
                Duration::from_secs(2),
                Duration::from_secs(1),
            )
            .unwrap(),
        );
        let (server, directory) = server_with_transport(transport.clone()).await;
        let sdk_path = directory.path().join("sdk");
        let passphrase = SecretBytes::new(b"controlled-sdk-passphrase".to_vec());
        let session = MatrixSession {
            meta: SessionMeta {
                user_id: user_id!("@receiver:example.test").to_owned(),
                device_id: device_id!("RECEIVER").to_owned(),
            },
            tokens: SessionTokens {
                access_token: "controlled-access".to_owned(),
                refresh_token: None,
            },
        };
        let base = BaseClient::new(
            StoreConfig::new(CrossProcessLockConfig::SingleProcess)
                .state_store(
                    SqliteStateStore::open(&sdk_path, Some("controlled-sdk-passphrase"))
                        .await
                        .unwrap(),
                )
                .crypto_store(
                    SqliteCryptoStore::open(&sdk_path, Some("controlled-sdk-passphrase"))
                        .await
                        .unwrap(),
                ),
            ThreadingSupport::Disabled,
            DmRoomDefinition::default(),
        );
        base.activate(session.meta.clone(), RoomLoadSettings::default(), None)
            .await
            .unwrap();
        base.close_stores().await.unwrap();
        drop(base);
        server
            .store
            .lock()
            .await
            .initialize_bootstrap_state(
                NewBootstrapState::new(
                    serde_json::to_vec(&session).unwrap(),
                    b"s0".to_vec(),
                    Vec::new(),
                    binding_time(),
                )
                .unwrap(),
            )
            .unwrap();
        let (client, context) = restore_matrix_client(
            &http.uri(),
            session.meta.user_id.as_str(),
            &sdk_path,
            &passphrase,
            &*server.store.lock().await,
        )
        .await
        .unwrap();
        let server = server.with_matrix_context(context.clone());
        let owner = owner();
        assert_eq!(
            server
                .handle_request(request("/v1/history-imports/start", &owner, None))
                .await
                .0,
            200
        );
        let blocked = server
            .handle_request(request("/v1/history-imports/advance", &owner, None))
            .await;
        assert_eq!(blocked.0, 200, "{}", String::from_utf8_lossy(&blocked.1));
        let blocked: Value = serde_json::from_slice(&blocked.1).unwrap();
        assert_eq!(blocked["status"], "partial");
        assert_eq!(blocked["gap_code"], "matrix_missing_room_key");
        assert_eq!(blocked["events"], json!([]));
        let cursor = blocked["next_cursor"].as_str().unwrap().to_owned();
        assert!(!cursor.contains("private-exact-page"));
        assert_eq!(
            server
                .store
                .lock()
                .await
                .load_backfill_job_for_history(&owner.import_id)
                .unwrap()
                .accepted_events(),
            0
        );
        drop(server);
        drop(client);
        context.close_stores().await.unwrap();
        drop(context);

        // Reopen both stores while keys are missing. Small pages are retained;
        // oversized pages must replay from the pinned token, not the live head.
        let store = Store::open(
            directory.path().join("gateway.sqlite"),
            Keyring::new([0x11; 32], 1).unwrap(),
        )
        .unwrap();
        let (client, context) = restore_matrix_client(
            &http.uri(),
            session.meta.user_id.as_str(),
            &sdk_path,
            &passphrase,
            &store,
        )
        .await
        .unwrap();
        let server = HistoryGatewayServer::new(store, transport.clone(), "history-gateway-secret")
            .unwrap()
            .with_matrix_context(context.clone());
        // A later-index key exists but cannot decrypt the older text event.
        // This is recoverable too, not a malformed-ciphertext permanent gap.
        let sessions = sender
            .store()
            .get_inbound_group_sessions_by_room_id(room)
            .await
            .unwrap();
        let later_key = sessions[0].export_at_index(1).await;
        context
            .olm_machine()
            .await
            .as_ref()
            .unwrap()
            .store()
            .import_exported_room_keys(vec![later_key], |_, _| {})
            .await
            .unwrap();
        let retry = server
            .handle_request(request(
                "/v1/history-imports/advance",
                &owner,
                Some(&cursor),
            ))
            .await;
        assert_eq!(retry.0, 200);
        let retry: Value = serde_json::from_slice(&retry.1).unwrap();
        assert_eq!(retry["gap_code"], "matrix_missing_room_key");
        assert_eq!(retry["next_cursor"], cursor);
        // Only this generated fixture's room keys are supplied, in memory.
        let keys = sender
            .store()
            .export_room_keys(|session| session.room_id() == room)
            .await
            .unwrap();
        assert_eq!(keys.len(), 1);
        context
            .olm_machine()
            .await
            .as_ref()
            .unwrap()
            .store()
            .import_exported_room_keys(keys, |_, _| {})
            .await
            .unwrap();
        drop(server);
        drop(client);
        context.close_stores().await.unwrap();
        drop(context);

        // Restart again after keys arrive; the production restore path must
        // expose exactly the same protected crypto store to history.
        let store = Store::open(
            directory.path().join("gateway.sqlite"),
            Keyring::new([0x11; 32], 1).unwrap(),
        )
        .unwrap();
        let (client, context) = restore_matrix_client(
            &http.uri(),
            session.meta.user_id.as_str(),
            &sdk_path,
            &passphrase,
            &store,
        )
        .await
        .unwrap();
        let server = HistoryGatewayServer::new(store, transport, "history-gateway-secret")
            .unwrap()
            .with_matrix_context(context.clone());
        let resumed = server
            .handle_request(request(
                "/v1/history-imports/advance",
                &owner,
                Some(&cursor),
            ))
            .await;
        assert_eq!(resumed.0, 200, "{}", String::from_utf8_lossy(&resumed.1));
        let resumed: Value = serde_json::from_slice(&resumed.1).unwrap();
        assert_eq!(resumed["status"], "completed");
        let events = resumed["events"].as_array().unwrap();
        assert!(
            events
                .iter()
                .all(|event| event["event_source"] == "backfill")
        );
        assert!(
            events
                .iter()
                .any(|event| event["payload"]["body"] == "controlled decrypted history")
        );
        let verified = events
            .iter()
            .find(|event| event["payload"]["r2_key"].is_string())
            .unwrap();
        assert_eq!(
            verified["payload"]["sha256"],
            canonical::sha256_hex(plaintext)
        );
        let serialized = serde_json::to_string(&events).unwrap();
        for forbidden in [
            URL_SAFE_NO_PAD.encode(key),
            URL_SAFE_NO_PAD.encode(iv),
            "controlled-access".to_owned(),
            "session_key".to_owned(),
            "ciphertext".to_owned(),
        ] {
            assert!(!serialized.contains(&forbidden));
        }
        let replay = server
            .handle_request(request(
                "/v1/history-imports/advance",
                &owner,
                Some(&cursor),
            ))
            .await;
        assert_eq!(serde_json::from_slice::<Value>(&replay.1).unwrap(), resumed);
        let media_key = verified["payload"]["r2_key"].as_str().unwrap();
        let media = server
            .handle_request(attachment_read_request(
                verified,
                media_key,
                verified["payload"]["sha256"].as_str(),
            ))
            .await;
        assert_eq!(media.0, 200, "{}", String::from_utf8_lossy(&media.1));
        // No sync, key query/request, receipt, or send endpoint was called.
        let requests = http.received_requests().await.unwrap();
        assert!(requests.iter().all(|request| request.method == "GET"));
        for request in requests
            .iter()
            .filter(|request| request.url.path().ends_with("/messages"))
            .skip(1)
        {
            assert!(
                request
                    .url
                    .query_pairs()
                    .any(|(key, value)| key == "from" && value == "private-exact-page")
            );
        }
        http.verify().await;
        drop(server);
        drop(client);
        context.close_stores().await.unwrap();
    }
}
