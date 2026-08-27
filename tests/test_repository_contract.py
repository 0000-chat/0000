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


if __name__ == "__main__":
    unittest.main()
