use communicator_matrix_gateway::canonical::{
    CanonicalError, MAX_CANONICAL_JSON_COLLECTION_ENTRIES, MAX_CANONICAL_JSON_DEPTH,
    MAX_CANONICAL_JSON_KEY_CHARS, MAX_CANONICAL_JSON_STRING_CHARS, canonical_json,
    canonical_json_line,
};
use serde_json::{Map, Number, Value, json};

fn assert_invalid(result: Result<String, CanonicalError>) {
    let error = result.expect_err("the value must be rejected");
    assert_eq!(error.code(), "canonical_invalid");
}

#[test]
fn serializes_compact_json_recursively_and_preserves_array_order() {
    let value = json!({
        "z": 0,
        "arr": [{"b": 2, "a": 1}, 3, true, null, "text"],
        "a": {"z": 2, "a": 1}
    });

    let serialized = canonical_json(&value).expect("valid JSON value");

    assert_eq!(
        serialized,
        r#"{"a":{"a":1,"z":2},"arr":[{"a":1,"b":2},3,true,null,"text"],"z":0}"#
    );
}

#[test]
fn sorts_keys_by_ecmascript_utf16_code_units_not_rust_scalar_order() {
    let mut value = Map::new();
    value.insert("\u{e000}".to_owned(), Value::String("bmp".to_owned()));
    value.insert(
        "\u{10000}".to_owned(),
        Value::String("supplementary".to_owned()),
    );
    value.insert(
        "\u{fffd}".to_owned(),
        Value::String("replacement".to_owned()),
    );
    value.insert("😀".to_owned(), Value::String("grinning".to_owned()));

    let serialized = canonical_json(&Value::Object(value)).expect("valid JSON value");

    assert_eq!(
        serialized,
        r#"{"𐀀":"supplementary","😀":"grinning","":"bmp","�":"replacement"}"#
    );
}

#[test]
fn accepts_only_javascript_safe_integer_boundaries() {
    let value = json!({
        "negative": -9_007_199_254_740_991_i64,
        "positive": 9_007_199_254_740_991_u64,
        "string": "line\nquote\"slash\\",
        "array": [false, null, [0]],
    });

    let serialized = canonical_json(&value).expect("safe integers are valid JSON values");

    assert_eq!(
        serialized,
        r#"{"array":[false,null,[0]],"negative":-9007199254740991,"positive":9007199254740991,"string":"line\nquote\"slash\\"}"#
    );

    for number in [
        Value::Number(Number::from(9_007_199_254_740_992_u64)),
        Value::Number(Number::from(-9_007_199_254_740_992_i64)),
    ] {
        assert_invalid(canonical_json(&number));
    }
}

#[test]
fn preserves_non_ascii_non_bmp_keys_and_javascript_string_escaping() {
    let mut value = Map::new();
    value.insert(
        "é😀".to_owned(),
        Value::String("café 😀\n\"\\\u{0000}".to_owned()),
    );
    value.insert("a".to_owned(), Value::String("東京".to_owned()));

    let serialized = canonical_json(&Value::Object(value)).expect("valid Unicode JSON value");

    assert_eq!(serialized, r#"{"a":"東京","é😀":"café 😀\n\"\\\u0000"}"#);
}

#[test]
fn rejects_floating_point_numbers_at_every_depth() {
    assert_invalid(canonical_json(&json!(1.5)));
    assert_invalid(canonical_json(&json!([0, {"nested": -2.25}])));

    let mut map = Map::new();
    map.insert(
        "nested_array".to_owned(),
        Value::Array(vec![Value::Number(
            Number::from_f64(3.0).expect("finite float"),
        )]),
    );
    assert_invalid(canonical_json(&Value::Object(map)));
}

#[test]
fn rejects_prototype_sensitive_keys_at_every_depth() {
    for key in ["__proto__", "prototype", "constructor"] {
        let mut nested = Map::new();
        nested.insert(key.to_owned(), Value::String("secret payload".to_owned()));
        assert_invalid(canonical_json(&Value::Object(nested)));

        let mut root = Map::new();
        root.insert(
            "nested".to_owned(),
            Value::Array(vec![Value::Object({
                let mut object = Map::new();
                object.insert(key.to_owned(), Value::Null);
                object
            })]),
        );
        assert_invalid(canonical_json(&Value::Object(root)));
    }
}

#[test]
fn rejects_contract_overlong_keys_and_strings() {
    let mut overlong_key = Map::new();
    overlong_key.insert("k".repeat(MAX_CANONICAL_JSON_KEY_CHARS + 1), Value::Null);
    assert_invalid(canonical_json(&Value::Object(overlong_key)));

    let mut overlong_string = Map::new();
    overlong_string.insert(
        "value".to_owned(),
        Value::String("x".repeat(MAX_CANONICAL_JSON_STRING_CHARS + 1)),
    );
    assert_invalid(canonical_json(&Value::Object(overlong_string)));
}

#[test]
fn rejects_values_deeper_than_the_contract_bound() {
    let mut value = Value::Null;
    for _ in 0..=MAX_CANONICAL_JSON_DEPTH {
        value = Value::Array(vec![value]);
    }

    assert_invalid(canonical_json(&value));
}

#[test]
fn rejects_collections_larger_than_the_contract_bound() {
    let value = Value::Array(vec![Value::Null; MAX_CANONICAL_JSON_COLLECTION_ENTRIES + 1]);

    assert_invalid(canonical_json(&value));
}

#[test]
fn canonical_json_line_has_exactly_one_literal_final_lf() {
    let value = json!({"text": "embedded\nline", "nested": ["carriage\rreturn"]});

    let line = canonical_json_line(&value).expect("valid JSON value");

    assert!(line.ends_with('\n'));
    assert_eq!(line.matches('\n').count(), 1);
    assert_eq!(
        line,
        r#"{"nested":["carriage\rreturn"],"text":"embedded\nline"}
"#
    );
}

#[test]
fn invalid_errors_are_code_only_and_do_not_format_rejected_values() {
    let secret = "room-secret-event-content";
    let value = json!({"payload": secret, "number": 1.25});

    let error = canonical_json(&value).expect_err("float must be rejected");

    assert_eq!(error.code(), "canonical_invalid");
    assert_eq!(error.to_string(), "canonical_invalid");
    assert!(!format!("{error:?}").contains(secret));
    assert!(!error.to_string().contains(secret));
}
