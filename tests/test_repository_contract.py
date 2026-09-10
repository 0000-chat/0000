import json
import pathlib
import re
import unittest


ROOT = pathlib.Path(__file__).resolve().parents[1]


def _scan_typescript(source):
    """Yield ``(index, character, state, masked_character)`` for TypeScript."""

    state = "code"
    quote = None
    index = 0
    while index < len(source):
        character = source[index]
        if state == "code":
            if source.startswith("//", index):
                yield index, character, "line_comment", " "
                yield index + 1, source[index + 1], "line_comment", " "
                state = "line_comment"
                index += 2
            elif source.startswith("/*", index):
                yield index, character, "block_comment", " "
                yield index + 1, source[index + 1], "block_comment", " "
                state = "block_comment"
                index += 2
            elif character in "'\"`":
                quote = character
                state = {"'": "single_string", '"': "double_string", "`": "template"}[quote]
                yield index, character, state, " "
                index += 1
            else:
                yield index, character, state, character
                index += 1
            continue

        if state == "line_comment":
            yield index, character, state, "\n" if character in "\r\n" else " "
            index += 1
            if character in "\r\n":
                state = "code"
            continue

        if state == "block_comment":
            if source.startswith("*/", index):
                yield index, character, state, " "
                yield index + 1, source[index + 1], state, " "
                state = "code"
                index += 2
            else:
                yield index, character, state, "\n" if character in "\r\n" else " "
                index += 1
            continue

        # String and template contents are opaque to declaration and delimiter
        # scanning.  A backslash consumes the following character, including a
        # quote or delimiter, so escaped characters cannot end the literal.
        yield index, character, state, "\n" if character in "\r\n" else " "
        if character == "\\":
            index += 1
            if index >= len(source):
                raise AssertionError("unterminated generated TypeScript string")
            escaped = source[index]
            yield index, escaped, state, "\n" if escaped in "\r\n" else " "
            index += 1
        elif character == quote:
            state = "code"
            quote = None
            index += 1
        else:
            index += 1

    if state == "block_comment":
        raise AssertionError("unterminated generated TypeScript comment")
    if state not in {"code", "line_comment"}:
        raise AssertionError("unterminated generated TypeScript string")


def _typescript_tokens(source):
    """Return significant TypeScript tokens while validating lexical trivia."""

    scanned = list(_scan_typescript(source))
    masked = "".join(record[3] for record in scanned)
    tokens = []
    index = 0
    while index < len(source):
        state = scanned[index][2]
        if state != "code":
            if state in {"single_string", "double_string", "template"}:
                start = index
                while index < len(source) and scanned[index][2] == state:
                    index += 1
                tokens.append(("string", source[start:index], start, index))
            else:
                index += 1
            continue

        character = masked[index]
        if character.isspace():
            index += 1
            continue
        if character.isalpha() or character in "_$":
            start = index
            index += 1
            while index < len(source) and scanned[index][2] == "code":
                character = masked[index]
                if not (character.isalnum() or character in "_$"):
                    break
                index += 1
            tokens.append(("identifier", source[start:index], start, index))
            continue
        tokens.append(("punctuation", character, index, index + 1))
        index += 1

    return tokens


def _consume_delimiter(tokens, index, stack):
    """Update a delimiter stack and return whether ``>`` was an arrow token."""

    token = tokens[index]
    if token[0] != "punctuation":
        return False
    value = token[1]
    previous = tokens[index - 1][1] if index else None

    if value in "{[(<":
        stack.append(value)
    elif value in "}])":
        expected = {"}": "{", "]": "[", ")": "("}[value]
        if not stack or stack[-1] != expected:
            raise AssertionError(f"unexpected generated TypeScript delimiter: {value}")
        stack.pop()
    elif value == ">":
        if previous == "=":
            return True
        if stack and stack[-1] == "<":
            stack.pop()
    return False


def _interface_body_opening(tokens, name_index):
    stack = []
    for index in range(name_index + 1, len(tokens)):
        token = tokens[index]
        if token[0] == "punctuation" and token[1] == "{" and not stack:
            return index
        if token[0] == "punctuation" and token[1] == ";" and not stack:
            break
        _consume_delimiter(tokens, index, stack)
    raise AssertionError("unterminated generated interface declaration")


def _interface_body_end(tokens, opening_index, interface_name):
    stack = ["{"]
    for index in range(opening_index + 1, len(tokens)):
        token = tokens[index]
        _consume_delimiter(tokens, index, stack)
        if token[0] == "punctuation" and token[1] == "}" and not stack:
            return token[2]
    raise AssertionError(f"unterminated generated interface: {interface_name}")


def _interface_bodies(source, interface_name):
    tokens = _typescript_tokens(source)
    bodies = []
    for index, token in enumerate(tokens[:-1]):
        if token[0] != "identifier" or token[1] != "interface":
            continue
        name_index = index + 1
        if tokens[name_index][0] != "identifier" or tokens[name_index][1] != interface_name:
            continue
        opening_index = _interface_body_opening(tokens, name_index)
        opening = tokens[opening_index]
        closing_start = _interface_body_end(tokens, opening_index, interface_name)
        bodies.append(source[opening[3] : closing_start])
    return bodies


def _decode_typescript_string(value):
    result = []
    index = 1
    while index < len(value) - 1:
        character = value[index]
        if character != "\\":
            result.append(character)
            index += 1
            continue

        index += 1
        if index >= len(value) - 1:
            raise AssertionError("unterminated generated TypeScript string")
        escaped = value[index]
        simple_escapes = {
            "0": "\0",
            "b": "\b",
            "f": "\f",
            "n": "\n",
            "r": "\r",
            "t": "\t",
            "v": "\v",
        }
        if escaped in simple_escapes:
            result.append(simple_escapes[escaped])
            index += 1
        elif escaped in "\\'\"`/":
            result.append(escaped)
            index += 1
        elif escaped == "x" and index + 2 < len(value) - 1:
            try:
                result.append(chr(int(value[index + 1 : index + 3], 16)))
            except ValueError:
                result.append(escaped)
                index += 1
            else:
                index += 3
        elif escaped == "u":
            if index + 1 < len(value) - 1 and value[index + 1] == "{":
                closing = value.find("}", index + 2, len(value) - 1)
                if closing == -1:
                    raise AssertionError("unterminated generated TypeScript string escape")
                try:
                    result.append(chr(int(value[index + 2 : closing], 16)))
                except ValueError as error:
                    raise AssertionError("invalid generated TypeScript string escape") from error
                index = closing + 1
            elif index + 4 < len(value) - 1:
                try:
                    result.append(chr(int(value[index + 1 : index + 5], 16)))
                except ValueError:
                    result.append(escaped)
                    index += 1
                else:
                    index += 5
            else:
                result.append(escaped)
                index += 1
        elif escaped in "\r\n":
            if escaped == "\r" and index + 1 < len(value) - 1 and value[index + 1] == "\n":
                index += 1
            index += 1
        else:
            result.append(escaped)
            index += 1
    return "".join(result)


def _normalize_typescript_type(type_text):
    output = []
    pending_space = False
    for _index, character, state, _masked_character in _scan_typescript(type_text):
        in_comment = state in {"line_comment", "block_comment"}
        in_string = state in {"single_string", "double_string", "template"}
        if state == "code":
            if character == ";":
                continue
            if character.isspace():
                pending_space = True
                continue
            if pending_space and output:
                output.append(" ")
            output.append(character)
            pending_space = False
        elif in_comment or in_string:
            if pending_space and output:
                output.append(" ")
            output.append(character)
            pending_space = False
        else:
            output.append(character)
            pending_space = False
    return "".join(output).strip()


def _generated_binding_members(interface_body):
    tokens = _typescript_tokens(interface_body)
    members = []
    stack = []
    segment_start = 0
    segments = []
    for index, token in enumerate(tokens):
        if token[0] == "punctuation" and token[1] == ";" and not stack:
            segments.append((segment_start, token[2]))
            segment_start = token[3]
            continue
        _consume_delimiter(tokens, index, stack)
    if stack:
        raise AssertionError("unterminated generated TypeScript type delimiter")

    trailing_tokens = [token for token in tokens if token[2] >= segment_start]
    if trailing_tokens:
        raise AssertionError("unterminated generated TypeScript member")

    for segment_start, segment_end in segments:
        segment = interface_body[segment_start:segment_end]
        segment_tokens = _typescript_tokens(segment)
        if not segment_tokens:
            continue

        key_index = 0
        if (
            segment_tokens[0][0] == "identifier"
            and segment_tokens[0][1] in {"readonly", "declare"}
            and len(segment_tokens) > 1
        ):
            key_index = 1
        key_token = segment_tokens[key_index]
        if key_token[0] == "identifier":
            name = key_token[1]
        elif key_token[0] == "string":
            name = _decode_typescript_string(key_token[1])
        else:
            continue

        optional_index = key_index + 1
        optional = (
            optional_index < len(segment_tokens)
            and segment_tokens[optional_index][0] == "punctuation"
            and segment_tokens[optional_index][1] == "?"
        )
        colon_index = optional_index + (1 if optional else 0)
        if (
            colon_index >= len(segment_tokens)
            or segment_tokens[colon_index][0] != "punctuation"
            or segment_tokens[colon_index][1] != ":"
        ):
            continue

        type_start = segment_tokens[colon_index][3]
        type_text = interface_body[segment_start + type_start : segment_end]
        if not _typescript_tokens(type_text):
            raise AssertionError("unterminated generated TypeScript member type")
        type_name = _normalize_typescript_type(type_text)
        if not type_name:
            raise AssertionError("unterminated generated TypeScript member type")
        members.append((name, optional, type_name))
    return members


def _generated_member_names(interface_body):
    return [name for name, _optional, _type_name in _generated_binding_members(interface_body)]


def _config_key_paths(value, key, path=()):
    if isinstance(value, dict):
        for child_key, child_value in value.items():
            child_path = (*path, str(child_key))
            if child_key == key:
                yield child_path
            yield from _config_key_paths(child_value, key, child_path)
    elif isinstance(value, list):
        for index, child_value in enumerate(value):
            yield from _config_key_paths(child_value, key, (*path, str(index)))


class RepositoryContractTests(unittest.TestCase):
    def test_generated_member_parser_handles_all_property_key_forms_and_nested_types(self):
        interface_body = r'''
            // A lowercase key and a dollar-prefixed key are valid declarations.
            lowercase: {
                nested: [string, { "quoted;": "brace } and {" }];
            };
            $binding?: Array<{ value: "semicolon; {braces}" }>;
            "quoted-key": "escaped \"quote\"; and { braces }";
        '''

        self.assertEqual(
            [
                (
                    "lowercase",
                    False,
                    '{ nested: [string, { "quoted;": "brace } and {" }] }',
                ),
                ("$binding", True, 'Array<{ value: "semicolon; {braces}" }>'),
                ("quoted-key", False, '"escaped \\\"quote\\\"; and { braces }"'),
            ],
            _generated_binding_members(interface_body),
        )

    def test_generated_member_parser_preserves_literal_escape_sequences(self):
        interface_body = r'''literal: "backslash \\\"quote";'''
        self.assertEqual(
            [("literal", False, r'"backslash \\\"quote"')],
            _generated_binding_members(interface_body),
        )

    def test_interface_body_scanner_ignores_comments_strings_and_templates(self):
        source = r'''
            /* interface Example { ignored: "}"; } */
            interface Example {
                first: "closing brace } and opening brace {";
                /* nested comment with { and } */
                second: { value: `template } {`; };
                third: "escaped \\\"brace }\\\"";
            }
        '''

        bodies = _interface_bodies(source, "Example")
        self.assertEqual(1, len(bodies))
        self.assertIn('second: { value: `template } {`; };', bodies[0])

    def test_generated_member_parser_preserves_duplicate_and_unexpected_members(self):
        self.assertEqual(
            [
                ("KNOWN", False, "R2Bucket"),
                ("KNOWN", False, "Queue"),
                ("unexpected", False, "string"),
            ],
            _generated_binding_members(
                "KNOWN: R2Bucket; KNOWN: Queue; unexpected: string;"
            ),
        )

    def test_generated_declaration_scanners_reject_unterminated_input(self):
        with self.assertRaises(AssertionError):
            _interface_bodies("interface Example { value: string;", "Example")
        with self.assertRaises(AssertionError):
            _generated_binding_members("value: { nested: string;")
        with self.assertRaises(AssertionError):
            _generated_binding_members('value: "unterminated;')

    def test_typescript_workspace_is_pinned(self):
        package = json.loads((ROOT / "package.json").read_text())
        self.assertTrue(package["private"])
        self.assertEqual("pnpm@10.14.0", package["packageManager"])
        self.assertEqual(">=24 <27", package["engines"]["node"])
        self.assertEqual("24", (ROOT / ".nvmrc").read_text().strip())
        workspace = (ROOT / "pnpm-workspace.yaml").read_text()
        for member in ("apps/*", "packages/*", "workers/*", "services/*"):
            self.assertIn(f"- '{member}'", workspace)

    def test_generated_frontend_files_are_ignored(self):
        ignored = (ROOT / ".gitignore").read_text()
        for entry in ("playwright-report/", "test-results/", ".wrangler/"):
            self.assertIn(entry, ignored)

    def test_every_image_is_digest_pinned(self):
        compose = (ROOT / "compose.yaml").read_text()
        lock = (ROOT / "deploy/images.lock.env").read_text()
        image_variables = re.findall(r"^\s*image:\s*\$\{([A-Z_]+)\}", compose, flags=re.MULTILINE)
        locked_images = dict(
            line.split("=", 1) for line in lock.splitlines() if line and not line.startswith("#")
        )
        self.assertEqual(
            {
                "POSTGRES_IMAGE",
                "CADDY_IMAGE",
                "SYNAPSE_IMAGE",
                "WHATSAPP_IMAGE",
                "MESSENGER_IMAGE",
                "TELEGRAM_IMAGE",
            },
            set(image_variables),
        )
        self.assertTrue(all("@sha256:" in locked_images[name] for name in image_variables))

    def test_only_caddy_publishes_ports(self):
        compose = (ROOT / "compose.yaml").read_text()
        self.assertEqual(1, compose.count("ports:"))
        self.assertIn('"80:80"', compose)
        self.assertIn('"443:443"', compose)
        self.assertNotIn("5432:5432", compose)
        self.assertNotIn("8008:8008", compose)
        self.assertNotIn("29318:29318", compose)
        self.assertNotIn("29319:29319", compose)
        self.assertNotIn("29317:29317", compose)
        self.assertNotIn("2019:2019", compose)

    def test_cloudflare_products_are_not_services(self):
        compose = (ROOT / "compose.yaml").read_text().lower()
        for forbidden in ("durable", "r2", "queue", "worker"):
            self.assertNotIn(forbidden, compose)

    def test_communicator_staging_configuration_is_explicit_and_secret_free(self):
        config_text = "\n".join(
            line for line in (ROOT / "apps/control-plane/wrangler.jsonc").read_text().splitlines()
            if not line.lstrip().startswith("//")
        )
        config = json.loads(config_text)
        self.assertEqual("communicator-control-plane", config["name"])
        self.assertEqual(
            "communicator-control-plane-staging",
            config["env"]["staging"]["name"],
        )
        self.assertEqual(
            "communicator-control-plane-production",
            config["env"]["production"]["name"],
        )
        self.assertEqual(
            "simulated",
            config["env"]["staging"]["vars"]["COMMUNICATOR_DATA_MODE"],
        )
        self.assertEqual(
            "live",
            config["env"]["production"]["vars"]["COMMUNICATOR_DATA_MODE"],
        )
        for environment in config["env"].values():
            self.assertNotIn("routes", environment)
            self.assertNotIn("custom_domains", environment)

        serialized = json.dumps(config)
        self.assertNotIn("matrix.communicator.0000.gold", serialized)
        self.assertNotRegex(serialized, re.compile(r"(?i)(secret|password|credential|token|cookie|session|phone|provider|account|matrix)"))
        self.assertNotRegex(serialized, re.compile(r"\b(?:\d{1,3}\.){3}\d{1,3}\b"))
        self.assertNotRegex(serialized, re.compile(r"@[A-Za-z0-9._=-]+:[A-Za-z0-9.-]+"))

    def test_communicator_staging_runbook_has_approval_gate_and_safe_order(self):
        runbook = (ROOT / "docs/runbooks/backoffice-staging.md").read_text()
        required_steps = [
            "1. Verify the intended Cloudflare account",
            "2. Verify that a Cloudflare Access application",
            "3. Verify that the Access allowed-identity list",
            "4. Run the complete local gate",
            "5. Build the simulated staging bundle",
            "6. Open the approved staging hostname",
            "7. Sign in as the pilot operator",
            "8. Inspect Worker logs",
            "9. If Access denial or the persistent simulated-data banner fails",
        ]
        positions = [runbook.index(step) for step in required_steps]
        self.assertEqual(sorted(positions), positions)
        self.assertIn("This implementation session intentionally stops before `wrangler deploy`", runbook)
        self.assertIn("No custom hostname, DNS record", runbook)
        self.assertIn("live Matrix or bridge traffic", runbook)

    def test_tenant_projection_configuration_and_generated_binding_are_stable(self):
        config_text = "\n".join(
            line
            for line in (ROOT / "apps/control-plane/wrangler.jsonc").read_text().splitlines()
            if not line.lstrip().startswith("//")
        )
        config = json.loads(config_text)
        class_name = "TenantProjectionDO"
        expected_binding = [
            {"name": "TENANT_PROJECTION", "class_name": class_name},
        ]

        self.assertEqual(
            {class_name: {"type": "durable-object", "storage": "sqlite"}},
            config["exports"],
        )
        self.assertEqual(expected_binding, config["durable_objects"]["bindings"])
        for environment in ("staging", "production"):
            self.assertEqual(
                expected_binding,
                config["env"][environment]["durable_objects"]["bindings"],
            )
        self.assertEqual([], list(_config_key_paths(config, "migrations")))

        generated = (ROOT / "apps/control-plane/worker-configuration.d.ts").read_text()
        generated_header = generated.split("// Begin runtime types", 1)[0]
        projection_namespace_type = (
            'DurableObjectNamespace<import("./worker/index").TenantProjectionDO>'
        )
        common_environment_bindings = [
            ("EVENT_ARCHIVE", False, "R2Bucket"),
            ("CONTROL_DB", False, "D1Database"),
            ("INGESTION_QUEUE", False, "Queue"),
            ("COMMUNICATOR_OIDC_ISSUER", False, '"https://auth.local.invalid/"'),
            ("COMMUNICATOR_OIDC_AUDIENCE", False, '"communicator-api"'),
            (
                "COMMUNICATOR_OIDC_JWKS_URL",
                False,
                '"https://auth.local.invalid/.well-known/jwks.json"',
            ),
            ("COMMUNICATOR_ACCESS_ISSUER", False, '"https://access.local.invalid/"'),
            ("COMMUNICATOR_ACCESS_AUDIENCE", False, '"access-audience.local.invalid"'),
            (
                "COMMUNICATOR_ACCESS_JWKS_URL",
                False,
                '"https://access.local.invalid/cdn-cgi/access/certs"',
            ),
            ("COMMUNICATOR_INGRESS_ENABLED", False, '"false"'),
            (
                "COMMUNICATOR_INGESTION_OIDC_ISSUER",
                False,
                '"https://ingestion-auth.local.invalid/"',
            ),
            (
                "COMMUNICATOR_INGESTION_OIDC_AUDIENCE",
                False,
                '"communicator-ingestion"',
            ),
            (
                "COMMUNICATOR_INGESTION_OIDC_JWKS_URL",
                False,
                '"https://ingestion-auth.local.invalid/.well-known/jwks.json"',
            ),
            ("TENANT_PROJECTION", False, projection_namespace_type),
        ]
        expected_bindings = {
            "__BaseEnv_Env": [
                *common_environment_bindings[:3],
                ("COMMUNICATOR_ENV", False, '"staging" | "production" | "development"'),
                ("COMMUNICATOR_DATA_MODE", False, '"simulated" | "live"'),
                *common_environment_bindings[3:],
            ],
            "StagingEnv": [
                *common_environment_bindings[:3],
                ("COMMUNICATOR_ENV", False, '"staging"'),
                ("COMMUNICATOR_DATA_MODE", False, '"simulated"'),
                *common_environment_bindings[3:],
            ],
            "ProductionEnv": [
                *common_environment_bindings[:3],
                ("COMMUNICATOR_ENV", False, '"production"'),
                ("COMMUNICATOR_DATA_MODE", False, '"live"'),
                *common_environment_bindings[3:],
            ],
        }
        for interface_name, expected in expected_bindings.items():
            bodies = _interface_bodies(generated_header, interface_name)
            self.assertEqual(1, len(bodies), interface_name)
            body = bodies[0]
            members = _generated_binding_members(body)
            self.assertEqual(len(members), len({member[0] for member in members}), interface_name)
            self.assertEqual(sorted(expected), sorted(members), interface_name)
            self.assertEqual(
                ["TENANT_PROJECTION"],
                sorted(
                    name
                    for name in _generated_member_names(body)
                    if "PROJECTION" in name
                ),
                interface_name,
            )

        env_bodies = _interface_bodies(generated_header, "Env")
        self.assertEqual(2, len(env_bodies))
        self.assertEqual(["", ""], sorted(body.strip() for body in env_bodies))
        env_headers = re.findall(
            r"\binterface\s+Env\b([^{}]*){", generated_header, flags=re.DOTALL
        )
        self.assertEqual(2, len(env_headers))
        self.assertTrue(
            all(
                re.fullmatch(r"\s*extends\s+__BaseEnv_Env\s*", header)
                for header in env_headers
            )
        )

        worker_index = (ROOT / "apps/control-plane/worker/index.ts").read_text()
        self.assertIn(
            'export { TenantProjectionDO } from "./projection/tenant-projection";',
            worker_index,
        )

    def test_tenant_projection_has_no_external_integration_calls_or_secret_fields(self):
        projection_dir = ROOT / "apps/control-plane/worker/projection"
        projection_sources = sorted(projection_dir.rglob("*.ts"))
        self.assertTrue(projection_sources)
        projection_text = "\n".join(
            path.read_text() for path in projection_sources
        )
        projection_code = re.sub(
            r"/\*.*?\*/|//[^\n]*",
            "",
            projection_text,
            flags=re.DOTALL,
        )

        self.assertIsNone(
            re.search(
                r"from\s+[\"'][^\"']*(?:provider|matrix|queue|r2)[^\"']*[\"']",
                projection_text,
                flags=re.IGNORECASE,
            )
        )
        side_effect_patterns = (
            r"\b(?:fetch|globalThis\s*\.\s*fetch|this\s*\??\.\s*fetch|"
            r"(?:ctx|context|env)\s*\??\.\s*fetch)\s*\(",
            r"\b(?:new\s+)?(?:WebSocket|EventSource)\s*\(",
            r"\b(?:setTimeout|setInterval|queueMicrotask|enqueue|schedule|alarm|waitUntil)\s*\(",
            r"\b(?:[A-Za-z_$][\w$]*\.)*[A-Za-z_$]*(?:queue|queues)[A-Za-z0-9_$]*\s*"
            r"(?:\?\.\s*|\.\s*)(?:send|sendBatch)\s*\(",
            r"\b(?:[A-Za-z_$][\w$]*\.)*[A-Za-z_$]*(?:queue|queues)[A-Za-z0-9_$]*\s*"
            r"\[\s*[\"'](?:send|sendBatch)[\"']\s*\]\s*\(",
            r"\b(?:[A-Za-z_$][\w$]*\.)*[A-Za-z_$]*(?:r2|bucket|archive)[A-Za-z0-9_$]*\s*"
            r"(?:\?\.\s*|\.\s*)(?:put|get|head|list|delete|createMultipartUpload)\s*\(",
            r"\b(?:[A-Za-z_$][\w$]*\.)*[A-Za-z_$]*(?:r2|bucket|archive)[A-Za-z0-9_$]*\s*"
            r"\[\s*[\"'](?:put|get|head|list|delete|createMultipartUpload)[\"']\s*\]\s*\(",
            r"\b(?:[A-Za-z_$][\w$]*\.)*[A-Za-z_$]*(?:provider|matrix|synapse|bridge)[A-Za-z0-9_$]*\s*"
            r"(?:\?\.\s*|\.\s*)(?:send|sendMessage|sendEvent|request|fetch|post|put|delete|"
            r"create|update|join|invite|leave|logout|execute)\s*\(",
            r"\b(?:[A-Za-z_$][\w$]*\.)*[A-Za-z_$]*(?:provider|matrix|synapse|bridge)[A-Za-z0-9_$]*\s*"
            r"\[\s*[\"'](?:send|sendMessage|sendEvent|request|fetch|post|put|delete|create|update|"
            r"join|invite|leave|logout|execute)[\"']\s*\]\s*\(",
            r"\b(?:sendMessage|sendEvent|createRoom|joinRoom|matrixRequest|providerRequest)\s*\(",
        )
        for pattern in side_effect_patterns:
            self.assertIsNone(re.search(pattern, projection_code, flags=re.IGNORECASE), pattern)
        self.assertIsNone(
            re.search(r"\b(?:EVENT_ARCHIVE|CONTROL_DB|R2Bucket|R2Object)\b", projection_code)
        )

        for pattern in (
            r"access[_-]?key",
            r"secret[_-]?key",
            r"BEGIN .*PRIVATE KEY",
            r"provider_cookie",
            r"matrix_access_token",
            r"e2ee_key",
        ):
            self.assertIsNone(re.search(pattern, projection_text, flags=re.IGNORECASE))


if __name__ == "__main__":
    unittest.main()
