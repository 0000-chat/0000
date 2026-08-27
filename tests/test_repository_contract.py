import pathlib
import re
import unittest


ROOT = pathlib.Path(__file__).resolve().parents[1]


class RepositoryContractTests(unittest.TestCase):
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
