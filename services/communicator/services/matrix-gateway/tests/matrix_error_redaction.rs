use std::error::Error;

use communicator_matrix_gateway::matrix_http::ReqwestMatrixTransport;
use communicator_matrix_gateway::secret::SecretBytes;

#[test]
fn transport_constructor_errors_do_not_retain_url_or_token_details() {
    const URL_CANARY: &str = "matrix-url-canary";
    const TOKEN_CANARY: &str = "matrix-token-canary";
    let error = ReqwestMatrixTransport::new(
        &format!("http://127.0.0.1:8080/{URL_CANARY}"),
        SecretBytes::from_text(TOKEN_CANARY.as_bytes(), 1024).expect("token"),
        std::time::Duration::from_secs(1),
        std::time::Duration::from_secs(1),
    )
    .expect_err("non-root HTTP origin must fail closed");
    let debug = format!("{error:?}");
    let display = error.to_string();
    assert!(!debug.contains(URL_CANARY));
    assert!(!debug.contains(TOKEN_CANARY));
    assert!(!display.contains(URL_CANARY));
    assert!(!display.contains(TOKEN_CANARY));
    assert!(error.source().is_none());
}
