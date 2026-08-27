import json
import pathlib
import re
import unittest


ROOT = pathlib.Path(__file__).resolve().parents[1]


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
            {"POSTGRES_IMAGE", "CADDY_IMAGE", "SYNAPSE_IMAGE", "WHATSAPP_IMAGE", "MESSENGER_IMAGE"},
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


if __name__ == "__main__":
    unittest.main()
