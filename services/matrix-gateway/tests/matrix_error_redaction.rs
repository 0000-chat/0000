use std::error::Error;

use communicator_matrix_gateway::matrix_spike::preserve_sync_response;
use http::{Response as HttpResponse, StatusCode, header::CONTENT_TYPE};

#[test]
fn preserve_sync_response_redacts_non_success_response_details() {
    const CANARY: &str = "matrix-upstream-error-body-canary-7d2f";
    let response = HttpResponse::builder()
        .status(StatusCode::BAD_REQUEST)
        .header(CONTENT_TYPE, "application/json")
        .body(format!(r#"{{"errcode":"M_FORBIDDEN","error":"{CANARY}"}}"#).into_bytes())
        .expect("test response should build");

    let error = match preserve_sync_response(response) {
        Ok(_) => panic!("a non-success response must be rejected"),
        Err(error) => error,
    };

    let debug = format!("{error:?}");
    let display = error.to_string();
    assert!(!debug.contains(CANARY), "Debug leaked the upstream canary");
    assert!(
        !display.contains(CANARY),
        "Display leaked the upstream canary"
    );
    assert!(
        error.source().is_none(),
        "Error::source exposed the upstream response error"
    );
}

#[test]
fn preserve_sync_response_reuses_valid_body_allocation() {
    let body = br#"{"next_batch":"allocation-identity"}"#.to_vec();
    let body_pointer = body.as_ptr();
    let response = HttpResponse::builder()
        .status(StatusCode::OK)
        .body(body)
        .expect("test response should build");

    let preserved = preserve_sync_response(response).expect("valid sync response should parse");

    assert_eq!(preserved.body.as_ptr(), body_pointer);
}
