use std::process::Command;

#[test]
fn configuration_stub_is_content_free_and_fail_closed() {
    let output = Command::new(env!("CARGO_BIN_EXE_communicator-matrix-gateway"))
        .env_clear()
        .output()
        .expect("configuration stub should execute");

    assert_eq!(output.status.code(), Some(78));
    assert!(output.stdout.is_empty());
    assert_eq!(
        output.stderr, b"gateway configuration not implemented\n",
        "stub must emit only its static diagnostic"
    );
}
