#![cfg(feature = "loopback-test")]

use std::{fs, time::Duration};

use chrono::Utc;
use communicator_matrix_gateway::{
    authority::{
        AuthorityClaimClient, AuthorityClaimFailure, AuthorityClaimOutcome, AuthorityClaimRequest,
        MessageAuthorityClaim, OutboundAuthority, OutboundCapability,
    },
    ingestion::{
        BatchSink, Delivery, DeliveryErrorClass, IngestionClient, PendingBatch, SecretString,
    },
};
use reqwest::StatusCode;
use serde_json::Value;

fn env(name: &str) -> String {
    std::env::var(name).unwrap_or_else(|_| panic!("missing {name}"))
}

fn credential(which: &str) -> String {
    let metadata: Value =
        serde_json::from_slice(&fs::read(env("T11_ISSUED_SERVICE_PATH")).expect("issued metadata"))
            .expect("issued metadata JSON");
    metadata[which]["credential"]
        .as_str()
        .unwrap_or_else(|| panic!("missing {which} credential"))
        .to_owned()
}

fn batch(path: &str) -> PendingBatch {
    let body = fs::read(path).expect("exact ingestion request bytes");
    let value: Value = serde_json::from_slice(&body).expect("ingestion JSON");
    let batch_id = value["batch_id"].as_str().expect("ingestion batch ID");
    PendingBatch::new("tenant_t11_rust", batch_id, body)
}

fn message_claim(suffix: &str) -> AuthorityClaimRequest {
    AuthorityClaimRequest::Message(MessageAuthorityClaim {
        tenant_id: "tenant_t11_rust".to_owned(),
        membership_id: "membership_t11_rust".to_owned(),
        actor_identity_id: "identity_t11_rust".to_owned(),
        account_id: "account_t11_rust".to_owned(),
        conversation_id: "conversation_t11_rust".to_owned(),
        connection_id: "connection_t11_rust".to_owned(),
        reservation_id: format!("reservation_t11_rust_{suffix}"),
        command_id: format!("command_t11_rust_{suffix}"),
        dispatch_id: format!("dispatch_t11_rust_{suffix}"),
        transaction_id: format!("transaction_t11_rust_{suffix}"),
        request_digest: "a".repeat(64),
        body_digest: "b".repeat(64),
        capability: OutboundCapability::AccountGrant {
            grant_id: "grant_t11_rust_send".to_owned(),
            authorization_epoch: 1,
        },
    })
}

fn ingestion_client(credential: String) -> IngestionClient {
    IngestionClient::new_for_test(
        env("T11_RUST_WORKER_BASE_URL"),
        SecretString::new(credential),
        Duration::from_secs(5),
    )
    .expect("loopback ingestion client")
}

fn authority_client(credential: String) -> AuthorityClaimClient {
    AuthorityClaimClient::new_for_test(
        env("T11_RUST_WORKER_BASE_URL"),
        SecretString::new(credential),
        Duration::from_secs(5),
    )
    .expect("loopback authority client")
}

async fn direct_claim_status(credential: &str, suffix: &str) -> StatusCode {
    let now = Utc::now();
    let expires_at = now + chrono::Duration::seconds(60);
    let claim_id = format!("claim_transaction_t11_rust_{suffix}");
    let body = serde_json::json!({
        "schema_version": 1,
        "operation": "message.send",
        "tenant_id": "tenant_t11_rust",
        "membership_id": "membership_t11_rust",
        "identity_id": "identity_t11_rust",
        "account_id": "account_t11_rust",
        "conversation_id": "conversation_t11_rust",
        "connection_id": "connection_t11_rust",
        "reservation_id": format!("reservation_t11_rust_{suffix}"),
        "operation_id": format!("dispatch_t11_rust_{suffix}"),
        "request_hash": "a".repeat(64),
        "capability": {
            "kind": "account_grant",
            "grant_id": "grant_t11_rust_send",
            "authorization_epoch": 1,
        },
        "now": now.to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        "expires_at": expires_at.to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        "claim_id": claim_id.clone(),
        "command_id": format!("command_t11_rust_{suffix}"),
        "dispatch_id": format!("dispatch_t11_rust_{suffix}"),
        "transaction_id": format!("transaction_t11_rust_{suffix}"),
        "request_digest": "a".repeat(64),
        "body_digest": "b".repeat(64),
    });
    reqwest::Client::builder()
        .no_proxy()
        .build()
        .expect("direct claim client")
        .post(format!(
            "{}/internal/v1/outbound/dispatch-claims",
            env("T11_RUST_WORKER_BASE_URL")
        ))
        .bearer_auth(credential)
        .header("content-type", "application/json")
        .header("accept", "application/json")
        .header("cache-control", "no-store")
        .header("x-request-id", format!("authority_{claim_id}"))
        .header("idempotency-key", claim_id)
        .body(serde_json::to_vec(&body).expect("direct claim JSON"))
        .send()
        .await
        .expect("direct claim response")
        .status()
}

/// Requires a fresh Platform/Communicator fixture and a finite issued service
/// credential. The setup and revocation commands are recorded in the T11
/// adoption report; this test never prints or persists a credential value.
#[tokio::test]
#[ignore = "requires the isolated T11 Platform and Communicator fixtures"]
async fn issued_platform_credential_reaches_live_ingestion_and_claim() {
    let first = credential("first");
    let ingestion = ingestion_client(first.clone());
    let delivery = ingestion
        .deliver(&batch(&env("T11_RUST_BATCH_ONE")))
        .await
        .expect("issued credential should be accepted by Communicator ingestion");
    println!("issued Rust ingestion before revocation: Accepted");
    assert_eq!(delivery, Delivery::Accepted);

    let authority = authority_client(first);
    let outcome = authority
        .claim(message_claim("3"))
        .await
        .expect("issued credential should be accepted by Communicator claim");
    println!("issued Rust claim before revocation: Allowed");
    assert!(matches!(outcome, AuthorityClaimOutcome::Allowed { .. }));
}

/// Run after the first credential has been revoked through the Platform
/// account endpoint. The replacement must recover both independent callers.
#[tokio::test]
#[ignore = "requires the isolated T11 Platform and Communicator fixtures"]
async fn revoked_credential_pauses_and_replacement_credential_recovers_both_callers() {
    let old = credential("first");
    let old_ingestion = ingestion_client(old.clone());
    let error = old_ingestion
        .deliver(&batch(&env("T11_RUST_BATCH_TWO")))
        .await
        .expect_err("revoked issued credential must pause ingestion");
    println!(
        "issued Rust ingestion after Platform revocation: class={:?} code={}",
        error.class(),
        error.code()
    );
    assert_eq!(error.class(), DeliveryErrorClass::Paused);
    assert_eq!(error.code(), "ingestion_unauthorized");

    let old_authority = authority_client(old);
    let direct_status = direct_claim_status(&credential("first"), "4").await;
    println!(
        "revoked issued credential direct claim HTTP status: {}",
        direct_status.as_u16()
    );
    assert_eq!(direct_status, StatusCode::UNAUTHORIZED);
    let old_claim = old_authority
        .claim(message_claim("4"))
        .await
        .expect_err("revoked issued credential must fail claim authorization");
    println!("issued Rust claim after Platform revocation: Uncertain");
    assert_eq!(old_claim, AuthorityClaimFailure::Uncertain);

    let replacement = credential("second");
    let replacement_delivery = ingestion_client(replacement.clone())
        .deliver(&batch(&env("T11_RUST_BATCH_THREE")))
        .await
        .expect("replacement credential should recover ingestion");
    println!("replacement Rust ingestion: Accepted");
    assert_eq!(replacement_delivery, Delivery::Accepted);

    let replacement_claim = authority_client(replacement)
        .claim(message_claim("4"))
        .await
        .expect("replacement credential should recover claim authorization");
    println!("replacement Rust claim: Allowed");
    assert!(matches!(
        replacement_claim,
        AuthorityClaimOutcome::Allowed { .. }
    ));
}
