import pathlib
import subprocess
import tempfile
import unittest


ROOT = pathlib.Path(__file__).resolve().parents[1]


class RenderTests(unittest.TestCase):
    def test_renders_required_secret_without_printing_it(self):
        with tempfile.TemporaryDirectory() as directory:
            source = pathlib.Path(directory) / "postgres.env"
            registration = pathlib.Path(directory) / "registration-secret"
            whatsapp_appservice = pathlib.Path(directory) / "whatsapp-registration.yaml"
            messenger_appservice = pathlib.Path(directory) / "messenger-registration.yaml"
            output = pathlib.Path(directory) / "homeserver.yaml"
            source.write_text("POSTGRES_DB=synapse\nPOSTGRES_USER=synapse\nPOSTGRES_PASSWORD=correct-horse-battery-staple\n")
            registration.write_text("registration-secret-value\n")
            whatsapp_appservice.write_text("id: whatsapp\n")
            messenger_appservice.write_text("id: messenger\n")
            whatsapp_appservice.chmod(0o600)
            messenger_appservice.chmod(0o600)
            result = subprocess.run(
                [
                    "python3",
                    ROOT / "scripts/render-synapse-config.py",
                    "--postgres-env", source,
                    "--registration-secret", registration,
                    "--whatsapp-registration", whatsapp_appservice,
                    "--messenger-registration", messenger_appservice,
                    "--output", output,
                ],
                check=True,
                text=True,
                capture_output=True,
            )
            rendered = output.read_text()
            self.assertIn("correct-horse-battery-staple", rendered)
            self.assertNotIn("correct-horse-battery-staple", result.stdout)
            self.assertIn("enable_registration: false", rendered)
            self.assertIn("federation_domain_whitelist: []", rendered)
            self.assertIn("app_service_config_files:", rendered)
            self.assertIn("/data/whatsapp-registration.yaml", rendered)
            self.assertIn("/data/messenger-registration.yaml", rendered)

    def test_rejects_missing_messenger_registration(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            source = root / "postgres.env"
            secret = root / "registration-secret"
            whatsapp = root / "whatsapp-registration.yaml"
            source.write_text("POSTGRES_PASSWORD=secret\n")
            secret.write_text("registration-secret\n")
            whatsapp.write_text("id: whatsapp\n")
            whatsapp.chmod(0o600)
            result = subprocess.run(
                [
                    "python3", ROOT / "scripts/render-synapse-config.py",
                    "--postgres-env", source,
                    "--registration-secret", secret,
                    "--whatsapp-registration", whatsapp,
                    "--messenger-registration", root / "missing-messenger-registration.yaml",
                    "--output", root / "homeserver.yaml",
                ],
                text=True,
                capture_output=True,
            )
            self.assertNotEqual(0, result.returncode)
            self.assertIn("Messenger registration must be a regular file", result.stderr)

    def test_rejects_broad_messenger_registration(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            source = root / "postgres.env"
            secret = root / "registration-secret"
            whatsapp = root / "whatsapp-registration.yaml"
            messenger = root / "messenger-registration.yaml"
            source.write_text("POSTGRES_PASSWORD=secret\n")
            secret.write_text("registration-secret\n")
            whatsapp.write_text("id: whatsapp\n")
            messenger.write_text("id: messenger\n")
            whatsapp.chmod(0o600)
            messenger.chmod(0o644)
            result = subprocess.run(
                [
                    "python3", ROOT / "scripts/render-synapse-config.py",
                    "--postgres-env", source,
                    "--registration-secret", secret,
                    "--whatsapp-registration", whatsapp,
                    "--messenger-registration", messenger,
                    "--output", root / "homeserver.yaml",
                ],
                text=True,
                capture_output=True,
            )
            self.assertNotEqual(0, result.returncode)
            self.assertIn("Messenger registration permissions are too broad", result.stderr)


if __name__ == "__main__":
    unittest.main()
