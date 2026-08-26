import pathlib
import re
import unittest


ROOT = pathlib.Path(__file__).resolve().parents[1]
EXPECTED_IMAGE = (
    "dock.mau.dev/mautrix/whatsapp:v26.08@"
    "sha256:86237c4d0d33a1e08910b1f820e6c561f9b8e21dc26943caf266e01021087002"
)


def compose_service(name: str) -> str:
    compose = (ROOT / "compose.yaml").read_text()
    match = re.search(
        rf"(?ms)^  {re.escape(name)}:\n(?P<body>.*?)(?=^  [a-z].*:\n|^networks:\n)",
        compose,
    )
    return match.group("body") if match else ""


class WhatsAppContractTests(unittest.TestCase):
    def test_image_is_the_verified_release_digest(self):
        lock = dict(
            line.split("=", 1)
            for line in (ROOT / "deploy/images.lock.env").read_text().splitlines()
            if line and not line.startswith("#")
        )
        self.assertEqual(EXPECTED_IMAGE, lock.get("WHATSAPP_IMAGE"))

    def test_whatsapp_has_no_published_ports(self):
        service = compose_service("whatsapp")
        self.assertTrue(service)
        self.assertNotIn("ports:", service)
        self.assertNotIn("expose:", service)
        self.assertIn("networks: [core]", service)

    def test_whatsapp_waits_for_postgres_and_synapse(self):
        service = compose_service("whatsapp")
        self.assertIn("postgres:\n        condition: service_healthy", service)
        self.assertIn("synapse:\n        condition: service_healthy", service)

    def test_healthcheck_is_internal_only(self):
        service = compose_service("whatsapp")
        self.assertIn("127.0.0.1:29318/_matrix/mau/ready", service)
        self.assertNotIn("0.0.0.0", service)


if __name__ == "__main__":
    unittest.main()
