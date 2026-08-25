import pathlib
import stat
import subprocess
import tempfile
import unittest
from urllib.parse import quote


ROOT = pathlib.Path(__file__).resolve().parents[1]


class WhatsAppRenderTests(unittest.TestCase):
    def test_renders_encoded_database_uri_and_boundaries_without_stdout_secret(self):
        password = "p@ss:word/with?hash#'quote"
        with tempfile.TemporaryDirectory() as directory:
            password_file = pathlib.Path(directory) / "db.password"
            output = pathlib.Path(directory) / "config.yaml"
            password_file.write_text(password + "\n")
            password_file.chmod(0o600)
            result = subprocess.run(
                [
                    "python3",
                    ROOT / "scripts/render-whatsapp-config.py",
                    "--db-password-file",
                    password_file,
                    "--output",
                    output,
                ],
                check=True,
                text=True,
                capture_output=True,
            )
            rendered = output.read_text()
            expected_uri = (
                "postgres://whatsapp_bridge:"
                + quote(password, safe="")
                + "@postgres/whatsapp_bridge?sslmode=disable"
            )
            self.assertIn(expected_uri, rendered)
            self.assertIn('"*": relay', rendered)
            self.assertIn('"@human:communicator.0000.gold": user', rendered)
            self.assertIn('"@platform-admin:communicator.0000.gold": admin', rendered)
            self.assertIn("shared_secret: disable", rendered)
            self.assertIn("max_initial_conversations: 0", rendered)
            self.assertEqual(0o600, stat.S_IMODE(output.stat().st_mode))
            self.assertNotIn(password, result.stdout)

    def test_requires_password_file(self):
        with tempfile.TemporaryDirectory() as directory:
            result = subprocess.run(
                [
                    "python3",
                    ROOT / "scripts/render-whatsapp-config.py",
                    "--db-password-file",
                    pathlib.Path(directory) / "missing",
                    "--output",
                    pathlib.Path(directory) / "config.yaml",
                ],
                text=True,
                capture_output=True,
            )
            self.assertNotEqual(0, result.returncode)
            self.assertNotIn("password", result.stdout.lower())


if __name__ == "__main__":
    unittest.main()
