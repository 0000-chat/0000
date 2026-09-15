import pathlib
import re
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]
EXPECTED_IMAGE = (
    "dock.mau.dev/mautrix/meta:v26.08@"
    "sha256:662f3d52249304c44c91cbc3d3552eced3e5baf93916be7c6b17a47677036de8"
)


def compose_service(name: str) -> str:
    compose = (ROOT / "compose.yaml").read_text()
    match = re.search(
        rf"(?ms)^  {re.escape(name)}:\n(?P<body>.*?)(?=^  [a-z].*:\n|^networks:\n)",
        compose,
    )
    return match.group("body") if match else ""


class MessengerContractTests(unittest.TestCase):
    def test_image_is_verified_release_digest(self):
        lock = dict(
            line.split("=", 1)
            for line in (ROOT / "deploy/images.lock.env").read_text().splitlines()
            if line and not line.startswith("#")
        )
        self.assertEqual(EXPECTED_IMAGE, lock.get("MESSENGER_IMAGE"))

    def test_service_is_private_and_persistent(self):
        service = compose_service("messenger")
        self.assertTrue(service)
        self.assertNotIn("ports:", service)
        self.assertNotIn("expose:", service)
        self.assertIn("networks: [core]", service)
        self.assertIn("${COMMUNICATOR_RUNTIME_DIR}/messenger:/data", service)

    def test_service_waits_for_postgres_and_synapse(self):
        service = compose_service("messenger")
        self.assertIn("postgres:\n        condition: service_healthy", service)
        self.assertIn("synapse:\n        condition: service_healthy", service)

    def test_healthcheck_is_internal_only(self):
        service = compose_service("messenger")
        self.assertIn("127.0.0.1:29319/_matrix/mau/ready", service)
        self.assertNotIn("0.0.0.0", service)


if __name__ == "__main__":
    unittest.main()
