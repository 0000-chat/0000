use std::time::Duration;

use communicator_matrix_gateway::{matrix_http::ReqwestMatrixTransport, secret::SecretBytes};

#[test]
fn production_constructor_rejects_loopback_and_nonloopback_http_with_or_without_test_feature() {
    for origin in ["http://127.0.0.1:8787", "http://matrix.example.test"] {
        assert!(
            ReqwestMatrixTransport::new(
                origin,
                SecretBytes::from_text(b"synthetic-policy-fixture", 64).unwrap(),
                Duration::from_secs(1),
                Duration::from_secs(1),
            )
            .is_err()
        );
    }
}
