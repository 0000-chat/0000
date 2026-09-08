use std::{borrow::Cow, collections::BTreeMap, sync::Arc};

use communicator_matrix_gateway::matrix_spike::{
    MATRIX_CRYPTO_KIND_NOT_ALLOWED, MatrixCryptoRequestKind, MatrixCryptoRequestPolicy,
    classify_crypto_request, enforce_crypto_request_policy, keys_query_body_digest,
    keys_query_rebinds_to_digest, policy_for_crypto_kind,
};
use matrix_sdk_crypto::{
    DeviceData, OlmMachine,
    store::{
        CryptoStore,
        types::{Changes, DeviceChanges},
    },
    types::requests::{AnyOutgoingRequest, KeysQueryRequest},
};
use matrix_sdk_sqlite::SqliteCryptoStore;
use ruma::{
    OneTimeKeyAlgorithm,
    api::{
        OutgoingRequest as _, SupportedVersions,
        auth_scheme::SendAccessToken,
        client::keys::{claim_keys::v3 as claim_keys, upload_keys::v3 as upload_keys},
    },
    owned_device_id, owned_user_id,
};
use tempfile::tempdir;

fn serialized_keys_upload_body(request: &upload_keys::Request) -> Vec<u8> {
    let supported = SupportedVersions::from_parts(&["v1.1".to_owned()], &Default::default());
    request
        .clone()
        .try_into_http_request::<Vec<u8>>(
            "https://example.org",
            SendAccessToken::IfRequired("test-token"),
            Cow::Owned(supported),
        )
        .unwrap()
        .body()
        .clone()
}

fn serialized_keys_claim_body(request: &claim_keys::Request) -> Vec<u8> {
    let supported = SupportedVersions::from_parts(&["v1.1".to_owned()], &Default::default());
    request
        .clone()
        .try_into_http_request::<Vec<u8>>(
            "https://example.org",
            SendAccessToken::IfRequired("test-token"),
            Cow::Owned(supported),
        )
        .unwrap()
        .body()
        .clone()
}

#[test]
fn keys_query_is_allowed() {
    let request = KeysQueryRequest {
        timeout: None,
        device_keys: BTreeMap::new(),
    };
    let request = AnyOutgoingRequest::from(request);

    assert_eq!(
        classify_crypto_request(&request),
        (
            MatrixCryptoRequestKind::KeysQuery,
            MatrixCryptoRequestPolicy::AllowKeysQuery
        )
    );
    assert_eq!(
        enforce_crypto_request_policy(&request),
        Ok(MatrixCryptoRequestKind::KeysQuery)
    );
}

#[tokio::test]
async fn keys_upload_requests_require_maintenance_and_replace_id_after_restart() {
    let directory = tempdir().unwrap();
    let passphrase = "crypto-request-policy-test";
    let user_id = owned_user_id!("@alice:example.org");
    let device_id = owned_device_id!("DEVICE");
    let store = Arc::new(
        SqliteCryptoStore::open(directory.path(), Some(passphrase))
            .await
            .unwrap(),
    );
    let machine = OlmMachine::with_store(&user_id, &device_id, Arc::clone(&store), None)
        .await
        .unwrap();

    let first = machine
        .outgoing_requests()
        .await
        .unwrap()
        .into_iter()
        .find_map(|request| match request.request() {
            AnyOutgoingRequest::KeysUpload(upload) => {
                assert_eq!(
                    classify_crypto_request(request.request()),
                    (
                        MatrixCryptoRequestKind::KeysUpload,
                        MatrixCryptoRequestPolicy::RequireMaintenance
                    )
                );
                assert_eq!(
                    enforce_crypto_request_policy(request.request()),
                    Ok(MatrixCryptoRequestKind::KeysUpload)
                );
                Some((
                    request.request_id().to_owned(),
                    serialized_keys_upload_body(upload),
                ))
            }
            _ => None,
        })
        .expect("a new OlmMachine must have a pending keys upload");

    drop(machine);
    drop(store);

    let reopened_store = Arc::new(
        SqliteCryptoStore::open(directory.path(), Some(passphrase))
            .await
            .unwrap(),
    );
    let reopened_machine =
        OlmMachine::with_store(&user_id, &device_id, Arc::clone(&reopened_store), None)
            .await
            .unwrap();
    let second = reopened_machine
        .outgoing_requests()
        .await
        .unwrap()
        .into_iter()
        .find_map(|request| match request.request() {
            AnyOutgoingRequest::KeysUpload(upload) => {
                assert_eq!(
                    classify_crypto_request(request.request()),
                    (
                        MatrixCryptoRequestKind::KeysUpload,
                        MatrixCryptoRequestPolicy::RequireMaintenance
                    )
                );
                assert_eq!(
                    enforce_crypto_request_policy(request.request()),
                    Ok(MatrixCryptoRequestKind::KeysUpload)
                );
                Some((
                    request.request_id().to_owned(),
                    serialized_keys_upload_body(upload),
                ))
            }
            _ => None,
        })
        .expect("an unacknowledged keys upload must remain pending after restart");

    assert_ne!(first.0, second.0);
    assert_eq!(first.1, second.1);
}

#[tokio::test]
async fn keys_claim_is_forbidden_and_cannot_be_recreated_after_restart() {
    let mut one_user = BTreeMap::new();
    one_user.insert(
        owned_user_id!("@alice:example.org"),
        BTreeMap::from([(
            owned_device_id!("DEVICE"),
            OneTimeKeyAlgorithm::SignedCurve25519,
        )]),
    );
    let request = claim_keys::Request::new(one_user);
    let request = AnyOutgoingRequest::from(request);

    assert_eq!(
        classify_crypto_request(&request),
        (
            MatrixCryptoRequestKind::KeysClaim,
            MatrixCryptoRequestPolicy::Forbidden
        )
    );
    assert_eq!(
        enforce_crypto_request_policy(&request),
        Err(MATRIX_CRYPTO_KIND_NOT_ALLOWED)
    );
    assert_eq!(
        enforce_crypto_request_policy(&request),
        Err(MATRIX_CRYPTO_KIND_NOT_ALLOWED)
    );

    let directory = tempdir().unwrap();
    let passphrase = "crypto-request-policy-test";
    let receiver_user_id = owned_user_id!("@receiver:example.org");
    let receiver_device_id = owned_device_id!("RECEIVER");
    let sender_user_id = owned_user_id!("@sender:example.org");
    let sender_device_id = owned_device_id!("SENDER");
    let sender_machine = OlmMachine::new(&sender_user_id, &sender_device_id).await;
    let sender_device = DeviceData::from_machine_test_helper(&sender_machine)
        .await
        .unwrap();
    let store = Arc::new(
        SqliteCryptoStore::open(directory.path(), Some(passphrase))
            .await
            .unwrap(),
    );
    store
        .save_changes(Changes {
            devices: DeviceChanges {
                new: vec![sender_device],
                ..Default::default()
            },
            ..Default::default()
        })
        .await
        .unwrap();
    let receiver_machine = OlmMachine::with_store(
        &receiver_user_id,
        &receiver_device_id,
        Arc::clone(&store),
        None,
    )
    .await
    .unwrap();

    let (first_id, first_request) = receiver_machine
        .get_missing_sessions(std::iter::once(sender_user_id.as_ref()))
        .await
        .unwrap()
        .expect("a device without an Olm session must generate a keys claim");
    let first_body = serialized_keys_claim_body(&first_request);
    let first_request = AnyOutgoingRequest::from(first_request);
    assert_eq!(
        classify_crypto_request(&first_request),
        (
            MatrixCryptoRequestKind::KeysClaim,
            MatrixCryptoRequestPolicy::Forbidden
        )
    );
    assert_eq!(
        enforce_crypto_request_policy(&first_request),
        Err(MATRIX_CRYPTO_KIND_NOT_ALLOWED)
    );

    // Deliberately do not apply a server response. The pending claim ID lives
    // in the dropped OlmMachine, not in the persistent crypto store.
    drop(receiver_machine);
    drop(store);
    drop(sender_machine);

    let reopened_store = Arc::new(
        SqliteCryptoStore::open(directory.path(), Some(passphrase))
            .await
            .unwrap(),
    );
    let reopened_machine = OlmMachine::with_store(
        &receiver_user_id,
        &receiver_device_id,
        Arc::clone(&reopened_store),
        None,
    )
    .await
    .unwrap();
    let (second_id, second_request) = reopened_machine
        .get_missing_sessions(std::iter::once(sender_user_id.as_ref()))
        .await
        .unwrap()
        .expect("the unacknowledged missing session must remain claimable after restart");
    let second_body = serialized_keys_claim_body(&second_request);
    let second_request = AnyOutgoingRequest::from(second_request);

    assert_ne!(first_id, second_id);
    assert_eq!(first_body, second_body);
    assert_eq!(
        classify_crypto_request(&second_request),
        (
            MatrixCryptoRequestKind::KeysClaim,
            MatrixCryptoRequestPolicy::Forbidden
        )
    );
    assert_eq!(
        enforce_crypto_request_policy(&second_request),
        Err(MATRIX_CRYPTO_KIND_NOT_ALLOWED)
    );
}

#[tokio::test]
async fn unacknowledged_keys_queries_get_new_ids_but_rebind_by_body_digest() {
    let user_id = owned_user_id!("@alice:example.org");
    let device_id = owned_device_id!("DEVICE");
    let machine = OlmMachine::new(&user_id, &device_id).await;
    let tracked_user = owned_user_id!("@bob:example.org");
    machine
        .update_tracked_users([tracked_user.as_ref()])
        .await
        .unwrap();

    let first = machine.outgoing_requests().await.unwrap();
    let second = machine.outgoing_requests().await.unwrap();
    let first = first
        .into_iter()
        .find_map(|request| match request.request() {
            AnyOutgoingRequest::KeysQuery(query) => {
                Some((request.request_id().to_owned(), query.clone()))
            }
            _ => None,
        })
        .unwrap();
    let second = second
        .into_iter()
        .find_map(|request| match request.request() {
            AnyOutgoingRequest::KeysQuery(query) => {
                Some((request.request_id().to_owned(), query.clone()))
            }
            _ => None,
        })
        .unwrap();

    assert_ne!(first.0, second.0);
    assert_eq!(
        keys_query_body_digest(&first.1),
        keys_query_body_digest(&second.1)
    );
    assert!(keys_query_rebinds_to_digest(
        keys_query_body_digest(&first.1),
        &second.1
    ));

    let changed = KeysQueryRequest {
        timeout: None,
        device_keys: BTreeMap::from([(tracked_user, vec![owned_device_id!("OTHER")])]),
    };
    assert!(!keys_query_rebinds_to_digest(
        keys_query_body_digest(&first.1),
        &changed
    ));
}

#[test]
fn policy_by_kind_matches_matrix_crypto_request_allowlist() {
    for kind in [
        MatrixCryptoRequestKind::KeysQuery,
        MatrixCryptoRequestKind::KeysUpload,
        MatrixCryptoRequestKind::KeysClaim,
        MatrixCryptoRequestKind::ToDevice,
        MatrixCryptoRequestKind::Verification,
        MatrixCryptoRequestKind::RoomMessage,
        MatrixCryptoRequestKind::SigningOrSignature,
        MatrixCryptoRequestKind::Backup,
    ] {
        let expected = match kind {
            MatrixCryptoRequestKind::KeysQuery => MatrixCryptoRequestPolicy::AllowKeysQuery,
            MatrixCryptoRequestKind::KeysUpload => MatrixCryptoRequestPolicy::RequireMaintenance,
            _ => MatrixCryptoRequestPolicy::Forbidden,
        };
        assert_eq!(policy_for_crypto_kind(kind), expected);
    }
}
