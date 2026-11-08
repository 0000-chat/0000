#[tokio::test]
async fn production_provider_evidence_fetches_authenticated_pinned_status_for_exact_journal_attempt()
 {
    let bridge = MockServer::start().await;
    let client = WhatsAppProvisioningClient::new_for_test(
        client_url(&bridge),
        SecretString::new(BRIDGE_SECRET),
        MATRIX_USER,
        Duration::from_secs(2),
    )
    .unwrap();
    let directory = tempdir().unwrap();
    fs::set_permissions(directory.path(), fs::Permissions::from_mode(0o700)).unwrap();
    let mut store = Store::open(
        directory.path().join("gateway.sqlite3"),
        Keyring::new([0x75; 32], 1).unwrap(),
    )
    .unwrap();
    let now = Utc
        .timestamp_millis_opt(1_700_000_000_000)
        .single()
        .unwrap();
    store
        .append_room_binding(
            NewRoomBinding::new_with_session_generation(
                "binding_75757575757575757575757575757575",
                "!evidence:example.test",
                "tenant_evidence",
                "identity_evidence",
                "connection_evidence",
                "account_evidence",
                Provider::Whatsapp,
                "gateway_route_whatsapp",
                "conversation_evidence",
                MATRIX_USER,
                "2026-09-14T00:00:00.000Z",
                now,
            )
            .unwrap(),
        )
        .unwrap();
    store
        .prepare_outbound_text(NewOutboundText {
            transaction_id: "transaction_evidence".into(),
            idempotency_key: "evidence_key".into(),
            request_digest: "a".repeat(64),
            tenant_id: "tenant_evidence".into(),
            account_id: "account_evidence".into(),
            connection_id: "connection_evidence".into(),
            identity_id: "identity_evidence".into(),
            conversation_id: "conversation_evidence".into(),
            message_id: "message_evidence".into(),
            event_id: "event_evidence".into(),
            matrix_room_id: "!evidence:example.test".into(),
            session_generation: "2026-09-14T00:00:00.000Z".into(),
            projection_generation: 1,
            body: "Never exported fixture content".into(),
            created_at: now,
        })
        .unwrap();
    store.complete_outbound_text("tenant_evidence","transaction_evidence",&"a".repeat(64),OutboundTextCompletion{
        state:"accepted".into(),matrix_stage:"confirmed".into(),bridge_stage:"unknown".into(),provider_stage:"unknown".into(),
        response:serde_json::to_vec(&json!({"evidence":[{"source":"matrix","status":"confirmed","evidence_id":"$saved-send"}]})).unwrap(),
        matrix_evidence:None,bridge_evidence:None,provider_evidence:None,updated_at:now,
    }).unwrap();
    let history = HistoryGatewayServer::new(
        store,
        Arc::new(SharedHistoryTransport {
            calls: AtomicUsize::new(0),
            event_count: 0,
        }),
        GATEWAY_SECRET,
    )
    .unwrap();
    let (matrix, matrix_client) = receipt_matrix_client("!evidence:example.test").await;
    let server = ProvisioningGatewayServer::new_with_matrix_runtime(
        client,
        SecretString::new(GATEWAY_SECRET),
        route(),
        history,
        matrix_client,
        allowing_authority(),
        Duration::from_secs(2),
    )
    .unwrap();
    let request = |observation: &str, account: &str, token: &str| {
        HttpRequest{
        path:"/v1/outbound/evidence".into(),authorization:Some(token.into()),request_id:Some("request-evidence".into()),idempotency_key:Some("key-evidence".into()),
        body:serde_json::to_vec(&json!({"schema_version":1,"tenant_id":"tenant_evidence","account_id":account,"connection_id":"connection_evidence","identity_id":"identity_evidence",
            "conversation_id":"conversation_evidence","transaction_id":"transaction_evidence","request_digest":"a".repeat(64),"projection_generation":1,"session_generation":"2026-09-14T00:00:00.000Z","observation_event_id":observation})).unwrap(),
    }
    };
    let initial_requests = matrix.received_requests().await.unwrap().len();
    let portal = json!({"type":"m.bridge","state_key":"communicator.0000.gold/whatsapp","sender":"@whatsappbot:communicator.0000.gold",
        "content":{"bridgebot":"@whatsappbot:communicator.0000.gold","protocol":{"id":"whatsapp"},"com.beeper.room_type.v2":"dm","channel":{"id":"123@lid"}}});
    let portal_state = Arc::new(StdMutex::new(json!([portal.clone()])));
    let response_state = portal_state.clone();
    Mock::given(matchers::method("GET"))
        .and(matchers::path(
            "/_matrix/client/v3/rooms/!evidence:example.test/state",
        ))
        .respond_with(move |_: &wiremock::Request| {
            ResponseTemplate::new(200).set_body_json(response_state.lock().unwrap().clone())
        })
        .mount(matrix.server())
        .await;
    assert_eq!(
        server
            .handle_request(request("$delivery", "wrong_account", GATEWAY_SECRET))
            .await
            .0,
        409
    );
    assert_eq!(
        server
            .handle_request(request("$delivery", "account_evidence", "wrong-token"))
            .await
            .0,
        401
    );
    for (field, value) in [
        ("session_generation", json!("2026-09-15T00:00:00.000Z")),
        ("request_digest", json!("b".repeat(64))),
        ("projection_generation", json!(2)),
    ] {
        let mut stale = request("$delivery", "account_evidence", GATEWAY_SECRET);
        let mut body: Value = serde_json::from_slice(&stale.body).unwrap();
        body[field] = value;
        stale.body = serde_json::to_vec(&body).unwrap();
        assert_eq!(server.handle_request(stale).await.0, 409);
    }
    assert_eq!(
        matrix.received_requests().await.unwrap().len(),
        initial_requests
    );
    for (id, status, recipients, sender, target, expected) in [
        (
            "$success",
            "SUCCESS",
            json!([]),
            "@whatsappbot:communicator.0000.gold",
            "$saved-send",
            200,
        ),
        (
            "$delivery",
            "SUCCESS",
            json!(["@whatsapp_lid-123:communicator.0000.gold"]),
            "@whatsappbot:communicator.0000.gold",
            "$saved-send",
            200,
        ),
        (
            "$pn-delivery",
            "SUCCESS",
            json!(["@whatsapp_123:communicator.0000.gold"]),
            "@whatsappbot:communicator.0000.gold",
            "$saved-send",
            200,
        ),
        (
            "$unrelated-recipient",
            "SUCCESS",
            json!(["@whatsapp_lid-999:communicator.0000.gold"]),
            "@whatsappbot:communicator.0000.gold",
            "$saved-send",
            422,
        ),
        (
            "$group-singleton",
            "SUCCESS",
            json!(["@whatsapp_lid-123:communicator.0000.gold"]),
            "@whatsappbot:communicator.0000.gold",
            "$saved-send",
            422,
        ),
        (
            "$forged-portal",
            "SUCCESS",
            json!(["@whatsapp_lid-123:communicator.0000.gold"]),
            "@whatsappbot:communicator.0000.gold",
            "$saved-send",
            422,
        ),
        (
            "$absent-portal",
            "SUCCESS",
            json!(["@whatsapp_lid-123:communicator.0000.gold"]),
            "@whatsappbot:communicator.0000.gold",
            "$saved-send",
            422,
        ),
        (
            "$pending",
            "PENDING",
            json!([]),
            "@whatsappbot:communicator.0000.gold",
            "$saved-send",
            200,
        ),
        (
            "$failure",
            "FAIL_PERMANENT",
            json!([]),
            "@whatsappbot:communicator.0000.gold",
            "$saved-send",
            200,
        ),
        (
            "$forged",
            "SUCCESS",
            json!([]),
            "@mallory:communicator.0000.gold",
            "$saved-send",
            409,
        ),
        (
            "$wrong-attempt",
            "SUCCESS",
            json!([]),
            "@whatsappbot:communicator.0000.gold",
            "$resend-send",
            409,
        ),
        (
            "$invented",
            "success",
            json!([]),
            "@whatsappbot:communicator.0000.gold",
            "$saved-send",
            422,
        ),
        (
            "$retry",
            "FAIL_RETRIABLE",
            json!([]),
            "@whatsappbot:communicator.0000.gold",
            "$saved-send",
            200,
        ),
        (
            "$bad-recipient",
            "SUCCESS",
            json!(["not-a-matrix-user"]),
            "@whatsappbot:communicator.0000.gold",
            "$saved-send",
            422,
        ),
        (
            "$group-delivery",
            "SUCCESS",
            json!(["@a:example.test", "@b:example.test"]),
            "@whatsappbot:communicator.0000.gold",
            "$saved-send",
            422,
        ),
        (
            "$wrong-transaction",
            "SUCCESS",
            json!([]),
            "@whatsappbot:communicator.0000.gold",
            "$saved-send",
            409,
        ),
    ] {
        let mut room_portal = portal.clone();
        if id == "$pn-delivery" {
            room_portal["content"]["channel"]["id"] = json!("123@s.whatsapp.net");
        } else if id == "$group-singleton" {
            room_portal["content"]["com.beeper.room_type.v2"] = json!("group_dm");
        } else if id == "$forged-portal" {
            room_portal["sender"] = json!("@mallory:communicator.0000.gold");
        }
        *portal_state.lock().unwrap() = if id == "$absent-portal" {
            json!([])
        } else {
            json!([room_portal])
        };
        Mock::given(matchers::method("GET"))
            .and(matchers::path(format!("/_matrix/client/v3/rooms/!evidence:example.test/event/{id}")))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({"type":"com.beeper.message_send_status","room_id":"!evidence:example.test","event_id":id,"sender":sender,"origin_server_ts":1700000000000_u64,
                "content":{"status":status,"m.relates_to":{"rel_type":"m.reference","event_id":target},"relates_to_txn_id":if id=="$wrong-transaction" {"another-transaction"} else {""},"delivered_to_users":recipients,"internal_error":"Never export this","message":"Never export this"}})))
            .mount(matrix.server()).await;
        let (code, bytes) = server
            .handle_request(request(id, "account_evidence", GATEWAY_SECRET))
            .await;
        assert_eq!(code, expected, "{id}: {}", String::from_utf8_lossy(&bytes));
        let value: Value = serde_json::from_slice(&bytes).unwrap();
        if code == 200 {
            assert_eq!(value["provider_read"], "unsupported");
            assert_eq!(value["transaction_id"], "transaction_evidence");
            assert_eq!(
                value["status"],
                if id == "$delivery" || id == "$pn-delivery" {
                    "delivered"
                } else if id == "$success" {
                    "accepted"
                } else {
                    "uncertain"
                }
            );
        }
        assert!(!String::from_utf8_lossy(&bytes).contains("Never export"));
    }
    Mock::given(matchers::method("GET"))
        .and(matchers::path("/_matrix/client/v3/rooms/!evidence:example.test/event/$read"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({"type":"m.read","room_id":"!evidence:example.test","event_id":"$read","sender":"@whatsappbot:communicator.0000.gold","origin_server_ts":1700000000000_u64,"content":{}})))
        .mount(matrix.server()).await;
    assert_eq!(
        server
            .handle_request(request("$read", "account_evidence", GATEWAY_SECRET))
            .await
            .0,
        422
    );
    Mock::given(matchers::method("GET"))
        .and(matchers::path(
            "/_matrix/client/v3/rooms/!evidence:example.test/event/$missing",
        ))
        .respond_with(
            ResponseTemplate::new(404)
                .set_body_json(json!({"errcode":"M_NOT_FOUND","error":"No event"})),
        )
        .mount(matrix.server())
        .await;
    assert_eq!(
        server
            .handle_request(request("$missing", "account_evidence", GATEWAY_SECRET))
            .await
            .0,
        503
    );
    for request in matrix
        .received_requests()
        .await
        .unwrap()
        .iter()
        .skip(initial_requests)
    {
        assert_eq!(request.method, "GET");
        assert!(request.headers.get("authorization").is_some());
    }
    assert!(receipt_requests(&matrix).await.is_empty());
    assert!(bridge.received_requests().await.unwrap().is_empty());
}
