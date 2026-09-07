import json
import pathlib
import re
import unittest


ROOT = pathlib.Path(__file__).resolve().parents[1]


def _interface_bodies(source, interface_name):
    declaration = re.compile(rf"\binterface\s+{re.escape(interface_name)}\b[^{{]*{{")
    bodies = []
    for match in declaration.finditer(source):
        opening_brace = match.end() - 1
        depth = 1
        closing_brace = None
        for index in range(opening_brace + 1, len(source)):
            if source[index] == "{":
                depth += 1
            elif source[index] == "}":
                depth -= 1
                if depth == 0:
                    closing_brace = index
                    break
        if closing_brace is None:
            raise AssertionError(f"unterminated generated interface: {interface_name}")
        bodies.append(source[opening_brace + 1 : closing_brace])
    return bodies


def _generated_binding_members(interface_body):
    member_pattern = re.compile(
        r"\b(?P<name>[A-Z][A-Z0-9_]*)\s*(?P<optional>\?)?\s*"
        r":\s*(?P<type>[^;{}]+);",
        flags=re.DOTALL,
    )
    members = []
    for match in member_pattern.finditer(interface_body):
        type_name = " ".join(match.group("type").split())
        if type_name == "D1Database" or type_name == "R2Bucket" or type_name.startswith(
            "DurableObjectNamespace<"
        ):
            members.append(
                (
                    match.group("name"),
                    match.group("optional") is not None,
                    type_name,
                )
            )
    return members


def _generated_member_names(interface_body):
    return re.findall(r"\b([A-Z][A-Z0-9_]*)\s*\??\s*:", interface_body)


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
        expected_bindings = {
            "__BaseEnv_Env": [
                ("CONTROL_DB", True, "D1Database"),
                ("EVENT_ARCHIVE", False, "R2Bucket"),
                ("TENANT_PROJECTION", False, projection_namespace_type),
            ],
            "StagingEnv": [
                ("EVENT_ARCHIVE", False, "R2Bucket"),
                ("TENANT_PROJECTION", False, projection_namespace_type),
            ],
            "ProductionEnv": [
                ("EVENT_ARCHIVE", False, "R2Bucket"),
                ("TENANT_PROJECTION", False, projection_namespace_type),
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
