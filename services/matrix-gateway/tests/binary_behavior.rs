use std::process::Command;

#[test]
fn missing_command_is_content_free_and_fail_closed() {
    let output = Command::new(env!("CARGO_BIN_EXE_communicator-matrix-gateway"))
        .env_clear()
        .output()
        .expect("configuration stub should execute");

    assert_eq!(output.status.code(), Some(64));
    assert!(output.stdout.is_empty());
    assert_eq!(
        output.stderr, b"admin_invalid_arguments\n",
        "argument failures must emit only their stable diagnostic"
    );
}
