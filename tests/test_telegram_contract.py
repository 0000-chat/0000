import json
import os
import pathlib
import subprocess
import tempfile
import unittest


ROOT = pathlib.Path(__file__).resolve().parents[1]
EXPECTED_IMAGE = (
    "dock.mau.dev/mautrix/telegram:v26.08@"
    "sha256:c073961f95aafca58392affcb57ea74364a2d17f018a36d29a208828db8a11e8"
)


def rendered_compose() -> dict:
    with tempfile.TemporaryDirectory(prefix="communicator-telegram-compose-") as directory:
        runtime = pathlib.Path(directory)
        secrets = runtime / "secrets"
        secrets.mkdir(mode=0o700)
        postgres_env = secrets / "postgres.env"
        postgres_env.write_text("POSTGRES_DB=synapse\nPOSTGRES_USER=synapse\nPOSTGRES_PASSWORD=fake\n")
        postgres_env.chmod(0o600)
        environment = os.environ | {"COMMUNICATOR_RUNTIME_DIR": str(runtime)}
        result = subprocess.run(
            [
                "docker",
                "compose",
                "--env-file",
                str(ROOT / "deploy/images.lock.env"),
                "config",
                "--no-interpolate",
                "--format",
                "json",
            ],
            cwd=ROOT,
            env=environment,
            check=True,
            capture_output=True,
            text=True,
        )
        return json.loads(result.stdout)


class TelegramContractTests(unittest.TestCase):
    def test_lock_entry_is_the_verified_release_digest(self):
        lock = dict(
            line.split("=", 1)
            for line in (ROOT / "deploy/images.lock.env").read_text().splitlines()
            if line and not line.startswith("#")
        )
        self.assertEqual(EXPECTED_IMAGE, lock.get("TELEGRAM_IMAGE"))

    def test_service_is_private_and_waits_for_core_dependencies(self):
        service = rendered_compose()["services"]["telegram"]
        self.assertEqual("${TELEGRAM_IMAGE}", service["image"])
        self.assertEqual(
            [{"source": "${COMMUNICATOR_RUNTIME_DIR}/telegram", "target": "/data", "type": "volume", "volume": {}}],
            service["volumes"],
        )
        self.assertEqual({"core": None}, service["networks"])
        self.assertNotIn("ports", service)
        self.assertEqual("1337:1337", service["user"])
        self.assertEqual(
            ["/usr/bin/mautrix-telegram", "--no-update", "--config", "/data/config.yaml"],
            service["command"],
        )
        self.assertEqual("service_healthy", service["depends_on"]["postgres"]["condition"])
        self.assertEqual("service_healthy", service["depends_on"]["synapse"]["condition"])
        self.assertIn("127.0.0.1:29317/_matrix/mau/ready", " ".join(service["healthcheck"]["test"]))
        self.assertEqual("unless-stopped", service["restart"])

    def test_only_caddy_publishes_host_ports(self):
        services = rendered_compose()["services"]
        published = {name for name, service in services.items() if "ports" in service}
        self.assertEqual({"caddy"}, published)


if __name__ == "__main__":
    unittest.main()
