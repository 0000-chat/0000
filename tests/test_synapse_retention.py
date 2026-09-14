import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).parents[1]
RENDERER = ROOT / "scripts" / "render-synapse-config.py"
TEMPLATE = ROOT / "deploy" / "synapse" / "homeserver.yaml.template"
IMAGE_LOCK = ROOT / "deploy" / "images.lock.env"


class SynapseRetentionConfigTests(unittest.TestCase):
    def test_pinned_synapse_renders_a_bounded_event_json_censor_period(self):
        self.assertIn("SYNAPSE_IMAGE=ghcr.io/element-hq/synapse:v1.159.0@sha256:", IMAGE_LOCK.read_text())
        self.assertIn("redaction_retention_period: 7d", TEMPLATE.read_text())

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            postgres_env = root / "postgres.env"
            postgres_env.write_text("POSTGRES_PASSWORD=test-only-password\n", encoding="utf-8")
            secret = root / "registration.secret"
            secret.write_text("test-only-registration-secret\n", encoding="utf-8")
            registrations = []
            for name in ("whatsapp", "messenger", "telegram"):
                registration = root / f"{name}.yaml"
                registration.write_text(f"id: {name}\n", encoding="utf-8")
                registration.chmod(0o600)
                registrations.append(registration)
            output = root / "homeserver.yaml"
            subprocess.run(
                [
                    sys.executable,
                    str(RENDERER),
                    "--postgres-env",
                    str(postgres_env),
                    "--registration-secret",
                    str(secret),
                    "--whatsapp-registration",
                    str(registrations[0]),
                    "--messenger-registration",
                    str(registrations[1]),
                    "--telegram-registration",
                    str(registrations[2]),
                    "--output",
                    str(output),
                ],
                check=True,
                env={**os.environ, "PYTHONPATH": str(ROOT)},
                capture_output=True,
                text=True,
            )
            rendered = output.read_text(encoding="utf-8")
            self.assertIn("redaction_retention_period: 7d", rendered)
            self.assertNotIn("POSTGRES_PASSWORD", rendered)
            self.assertNotIn("REGISTRATION_SHARED_SECRET", rendered)

    def test_synapse_adapter_uses_event_json_and_have_censored_as_evidence(self):
        source = (ROOT / "scripts" / "controlled-copy-retention.py").read_text()
        self.assertIn("COMMUNICATOR_RETENTION_SYNAPSE_DATABASE_URL", source)
        self.assertIn("redactions.have_censored", source)
        self.assertIn("event_json", source)
        self.assertIn("synapse_event_json_censor", source)


if __name__ == "__main__":
    unittest.main()
