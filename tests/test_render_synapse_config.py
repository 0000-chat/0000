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
            telegram_appservice = pathlib.Path(directory) / "telegram-registration.yaml"
            output = pathlib.Path(directory) / "homeserver.yaml"
            source.write_text("POSTGRES_DB=synapse\nPOSTGRES_USER=synapse\nPOSTGRES_PASSWORD=correct-horse-battery-staple\n")
            registration.write_text("registration-secret-value\n")
            whatsapp_appservice.write_text("id: whatsapp\n")
            messenger_appservice.write_text("id: messenger\n")
            telegram_appservice.write_text("id: telegram\n")
            for path in (whatsapp_appservice, messenger_appservice, telegram_appservice):
                path.chmod(0o600)
            result = subprocess.run(
                [
                    "python3",
                    ROOT / "scripts/render-synapse-config.py",
                    "--postgres-env", source,
                    "--registration-secret", registration,
            "--whatsapp-registration", whatsapp_appservice,
            "--messenger-registration", messenger_appservice,
                    "--telegram-registration", telegram_appservice,
                    "--output", output,
                ],
                text=True,
                capture_output=True,
            )
            self.assertEqual(0, result.returncode, result.stderr)
            rendered = output.read_text()
            self.assertIn("correct-horse-battery-staple", rendered)
            self.assertNotIn("correct-horse-battery-staple", result.stdout)
            self.assertIn("enable_registration: false", rendered)
            self.assertIn("federation_domain_whitelist: []", rendered)
            self.assertIn("app_service_config_files:", rendered)
            self.assertIn("/data/whatsapp-registration.yaml", rendered)
            self.assertIn("/data/messenger-registration.yaml", rendered)
            self.assertIn("/data/telegram-registration.yaml", rendered)
            self.assertLess(
                rendered.index("/data/whatsapp-registration.yaml"),
                rendered.index("/data/messenger-registration.yaml"),
            )
            self.assertLess(
                rendered.index("/data/messenger-registration.yaml"),
                rendered.index("/data/telegram-registration.yaml"),
            )

    def test_rejects_missing_messenger_registration(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            source = root / "postgres.env"
            secret = root / "registration-secret"
            whatsapp = root / "whatsapp-registration.yaml"
            telegram = root / "telegram-registration.yaml"
            source.write_text("POSTGRES_PASSWORD=secret\n")
            secret.write_text("registration-secret\n")
            whatsapp.write_text("id: whatsapp\n")
            telegram.write_text("id: telegram\n")
            whatsapp.chmod(0o600)
            telegram.chmod(0o600)
            result = subprocess.run(
                [
                    "python3", ROOT / "scripts/render-synapse-config.py",
                    "--postgres-env", source,
                    "--registration-secret", secret,
                    "--whatsapp-registration", whatsapp,
                    "--messenger-registration", root / "missing-messenger-registration.yaml",
                    "--telegram-registration", telegram,
                    "--output", root / "homeserver.yaml",
                ],
                text=True,
                capture_output=True,
            )
            self.assertNotEqual(0, result.returncode)
            self.assertIn("Messenger registration is missing", result.stderr)

    def test_requires_all_three_registration_arguments(self):
        with tempfile.TemporaryDirectory() as directory:
            directory = pathlib.Path(directory)
            source = directory / "postgres.env"
            registration = directory / "registration-secret"
            whatsapp = directory / "whatsapp-registration.yaml"
            source.write_text("POSTGRES_PASSWORD=fake\n")
            registration.write_text("fake\n")
            whatsapp.write_text("fake\n")
            for path in (source, registration, whatsapp):
                path.chmod(0o600)
            result = subprocess.run(
                [
                    "python3",
                    ROOT / "scripts/render-synapse-config.py",
                    "--postgres-env", source,
                    "--registration-secret", registration,
                    "--whatsapp-registration", whatsapp,
                    "--output", directory / "homeserver.yaml",
                ],
                text=True,
                capture_output=True,
            )
            self.assertNotEqual(0, result.returncode)
            self.assertIn("the following arguments are required: --messenger-registration, --telegram-registration", result.stderr)

    def test_rejects_broad_messenger_registration(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            source = root / "postgres.env"
            secret = root / "registration-secret"
            whatsapp = root / "whatsapp-registration.yaml"
            messenger = root / "messenger-registration.yaml"
            telegram = root / "telegram-registration.yaml"
            source.write_text("POSTGRES_PASSWORD=secret\n")
            secret.write_text("registration-secret\n")
            whatsapp.write_text("id: whatsapp\n")
            messenger.write_text("id: messenger\n")
            telegram.write_text("id: telegram\n")
            whatsapp.chmod(0o600)
            telegram.chmod(0o600)
            messenger.chmod(0o644)
            result = subprocess.run(
                [
                    "python3", ROOT / "scripts/render-synapse-config.py",
                    "--postgres-env", source,
                    "--registration-secret", secret,
                    "--whatsapp-registration", whatsapp,
                    "--messenger-registration", messenger,
                    "--telegram-registration", telegram,
                    "--output", root / "homeserver.yaml",
                ],
                text=True,
                capture_output=True,
            )
            self.assertNotEqual(0, result.returncode)
            self.assertIn("Messenger registration permissions are too broad", result.stderr)

    def test_rejects_missing_or_broad_telegram_registration(self):
        with tempfile.TemporaryDirectory() as directory:
            directory = pathlib.Path(directory)
            source = directory / "postgres.env"
            registration = directory / "registration-secret"
            whatsapp = directory / "whatsapp-registration.yaml"
            messenger = directory / "messenger-registration.yaml"
            telegram = directory / "telegram-registration.yaml"
            for path, content in (
                (source, "POSTGRES_PASSWORD=fake\n"),
                (registration, "fake\n"),
                (whatsapp, "fake\n"),
                (messenger, "fake\n"),
                (telegram, "fake\n"),
            ):
                path.write_text(content)
                path.chmod(0o600)
            telegram.chmod(0o640)
            result = subprocess.run(
                [
                    "python3",
                    ROOT / "scripts/render-synapse-config.py",
                    "--postgres-env", source,
                    "--registration-secret", registration,
                    "--whatsapp-registration", whatsapp,
                    "--messenger-registration", messenger,
                    "--telegram-registration", telegram,
                    "--output", directory / "homeserver.yaml",
                ],
                text=True,
                capture_output=True,
            )
            self.assertNotEqual(0, result.returncode)
            self.assertIn("Telegram registration permissions are too broad", result.stderr)


if __name__ == "__main__":
    unittest.main()
