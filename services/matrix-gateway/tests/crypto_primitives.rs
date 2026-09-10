use std::fmt::Write as _;

use communicator_matrix_gateway::crypto::{Keyring, MAX_PROTECTED_PLAINTEXT_BYTES};

#[test]
fn keyring_round_trips_with_fresh_nonces_and_rejects_tampering() {
    let keyring = Keyring::new([0x42; 32], 1).expect("valid key version");
    let plaintext = b"encrypted gateway state";

    let first = keyring
        .seal("room_bindings", "row-1", "payload", plaintext)
        .expect("seal should succeed");
    let second = keyring
        .seal("room_bindings", "row-1", "payload", plaintext)
        .expect("seal should succeed");

    assert_ne!(first.nonce, second.nonce);
    assert_eq!(
        keyring
            .open("room_bindings", "row-1", "payload", &first)
            .expect("open should succeed")
            .as_slice(),
        plaintext
    );
    let opened = keyring
        .open("room_bindings", "row-1", "payload", &first)
        .expect("open should succeed");
    assert_eq!(opened.as_bytes(), plaintext);
    assert_eq!(opened.len(), plaintext.len());
    assert!(!opened.is_empty());
    assert_eq!(format!("{opened:?}"), "[REDACTED]");
    assert_eq!(format!("{opened}"), "[REDACTED]");

    let mut tampered_ciphertext = first.clone();
    tampered_ciphertext.ciphertext[0] ^= 1;
    assert!(
        keyring
            .open("room_bindings", "row-1", "payload", &tampered_ciphertext)
            .is_err()
    );

    let mut tampered_nonce = first.clone();
    tampered_nonce.nonce[0] ^= 1;
    assert!(
        keyring
            .open("room_bindings", "row-1", "payload", &tampered_nonce)
            .is_err()
    );

    let mut tampered_tag = first.clone();
    let final_byte = tampered_tag.ciphertext.len() - 1;
    tampered_tag.ciphertext[final_byte] ^= 1;
    assert!(
        keyring
            .open("room_bindings", "row-1", "payload", &tampered_tag)
            .is_err()
    );
}

#[test]
fn keyring_rejects_empty_context_and_plaintext() {
    let keyring = Keyring::new([0x42; 32], 1).expect("valid key version");

    for (table, row_id, column, plaintext) in [
        ("", "row-1", "payload", b"value".as_slice()),
        ("table", "", "payload", b"value".as_slice()),
        ("table", "row-1", "", b"value".as_slice()),
        ("table", "row-1", "payload", b"".as_slice()),
    ] {
        assert!(keyring.seal(table, row_id, column, plaintext).is_err());
    }
}

#[test]
fn keyring_authenticates_every_context_field_and_key_version() {
    let keyring = Keyring::new([0x42; 32], 1).expect("valid key version");
    let sealed = keyring
        .seal("room_bindings", "row-1", "payload", b"value")
        .expect("seal should succeed");

    assert!(
        keyring
            .open("different_table", "row-1", "payload", &sealed)
            .is_err()
    );
    assert!(
        keyring
            .open("room_bindings", "different-row", "payload", &sealed)
            .is_err()
    );
    assert!(
        keyring
            .open("room_bindings", "row-1", "different-column", &sealed)
            .is_err()
    );

    let mut different_version = sealed.clone();
    different_version.key_version = 2;
    assert!(
        keyring
            .open("room_bindings", "row-1", "payload", &different_version)
            .is_err()
    );
}

#[test]
fn keyring_rejects_control_characters_and_oversized_inputs() {
    let keyring = Keyring::new([0x42; 32], 1).expect("valid key version");
    for (table, row_id, column) in [
        ("room\0bindings", "row-1", "payload"),
        ("room_bindings", "row\n1", "payload"),
        ("room_bindings", "row-1", "payload\u{007f}"),
    ] {
        assert!(keyring.seal(table, row_id, column, b"value").is_err());
    }

    let oversized = vec![0_u8; MAX_PROTECTED_PLAINTEXT_BYTES + 1];
    assert!(
        keyring
            .seal("room_bindings", "row-1", "payload", &oversized)
            .is_err()
    );

    let oversized_table = "t".repeat(16 * 1024 + 1);
    assert!(
        keyring
            .seal(&oversized_table, "row-1", "payload", b"value")
            .is_err()
    );
}

#[test]
fn lookup_rejects_control_characters_and_bounded_field_count() {
    let keyring = Keyring::new([0x42; 32], 1).expect("valid key version");
    assert!(keyring.lookup_digest("room\0lookup", &["row"]).is_err());
    assert!(keyring.lookup_digest("room", &["row\n1"]).is_err());

    let too_many_fields = vec!["field"; 129];
    assert!(keyring.lookup_digest("room", &too_many_fields).is_err());
}

#[test]
fn keyring_rotates_by_decrypting_old_and_sealing_with_active_version() {
    let old = Keyring::new([0x11; 32], 1).expect("valid key version");
    let old_sealed = old
        .seal("room_bindings", "row-1", "payload", b"old value")
        .expect("seal should succeed");

    let mut rotated = Keyring::new([0x22; 32], 2).expect("valid key version");
    rotated
        .add_decryption_key(1, [0x11; 32])
        .expect("old key should be accepted");
    assert_eq!(
        rotated
            .open("room_bindings", "row-1", "payload", &old_sealed)
            .expect("old ciphertext should remain decryptable")
            .as_slice(),
        b"old value"
    );

    let new_sealed = rotated
        .seal("room_bindings", "row-1", "payload", b"new value")
        .expect("seal should use active key");
    assert_eq!(new_sealed.key_version, 2);
    assert!(
        old.open("room_bindings", "row-1", "payload", &new_sealed)
            .is_err()
    );
}

#[test]
fn crypto_debug_and_display_redact_protected_values() {
    let keyring = Keyring::new([0x42; 32], 1).expect("valid key version");
    let sealed = keyring
        .seal("room_bindings", "row-1", "payload", b"secret plaintext")
        .expect("seal should succeed");
    let mut debug = String::new();
    write!(&mut debug, "{sealed:?}").expect("formatting should succeed");
    assert!(!debug.contains("secret plaintext"));
    assert!(!debug.contains("room_bindings"));

    let error = keyring
        .seal("", "row-1", "payload", b"secret plaintext")
        .expect_err("empty table should fail");
    assert_eq!(error.to_string(), "crypto_empty_context");
    assert!(!format!("{error:?}").contains("secret plaintext"));
}

#[test]
fn rotated_keyring_uses_retained_versions_for_lookup_only_when_explicit() {
    let old = Keyring::new([0x11; 32], 1).expect("valid key version");
    let old_digest = old
        .lookup_digest("room", &["row-1", "payload"])
        .expect("lookup should succeed");

    let mut rotated = Keyring::new([0x22; 32], 2).expect("valid key version");
    rotated
        .add_decryption_key(1, [0x11; 32])
        .expect("old key should be accepted");
    assert_eq!(
        rotated
            .lookup_digest_at(1, "room", &["row-1", "payload"])
            .expect("old lookup should succeed"),
        old_digest
    );
    assert_ne!(
        old_digest,
        rotated
            .lookup_digest("room", &["row-1", "payload"])
            .expect("active lookup should succeed")
    );
    assert!(
        rotated
            .lookup_digest_at(9, "room", &["row-1", "payload"])
            .is_err()
    );
}

#[test]
fn lookup_digest_is_keyed_deterministic_domain_separated_and_length_framed() {
    let keyring = Keyring::new([0x42; 32], 1).expect("valid key version");

    let first = keyring
        .lookup_digest("room", &["row-1", "payload"])
        .expect("lookup should succeed");
    let second = keyring
        .lookup_digest("room", &["row-1", "payload"])
        .expect("lookup should succeed");
    assert_eq!(first, second);

    assert_ne!(
        first,
        keyring
            .lookup_digest("account", &["row-1", "payload"])
            .expect("lookup should succeed")
    );
    assert_ne!(
        first,
        keyring
            .lookup_digest("room", &["payload", "row-1"])
            .expect("lookup should succeed")
    );

    // A sequence of length-prefixed fields must not collapse into a
    // concatenation: ["ab", "c"] and ["a", "bc"] are distinct tuples.
    assert_ne!(
        keyring
            .lookup_digest("room", &["ab", "c"])
            .expect("lookup should succeed"),
        keyring
            .lookup_digest("room", &["a", "bc"])
            .expect("lookup should succeed")
    );

    let version_two = Keyring::new([0x42; 32], 2).expect("valid key version");
    assert_ne!(
        first,
        version_two
            .lookup_digest("room", &["row-1", "payload"])
            .expect("lookup should succeed")
    );
}
