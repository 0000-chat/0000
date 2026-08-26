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
            registration = pathlib.Path(directory) / "registration.yaml"
            output = pathlib.Path(directory) / "config.yaml"
            password_file.write_text(password + "\n")
            password_file.chmod(0o600)
            registration.write_text('as_token: "test-as-token"\nhs_token: "test-hs-token"\n')
            registration.chmod(0o600)
            output.write_text('encryption:\n    pickle_key: "stable-pickle-key"\n')
            result = subprocess.run(
                [
                    "python3",
                    ROOT / "scripts/render-whatsapp-config.py",
                    "--db-password-file",
                    password_file,
                    "--registration",
                    registration,
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
            self.assertIn('"@agent:communicator.0000.gold": user', rendered)
            permission_block = rendered.split("  permissions:\n", 1)[1].split("\n\nrelay:", 1)[0]
            self.assertEqual(
                '''    "*": relay
    "@human:communicator.0000.gold": user
    "@agent:communicator.0000.gold": user
    "@platform-admin:communicator.0000.gold": admin''',
                permission_block,
            )
            self.assertIn('"@platform-admin:communicator.0000.gold": admin', rendered)
            self.assertIn("shared_secret: disable", rendered)
            self.assertIn("max_initial_conversations: 0", rendered)
            self.assertIn('as_token: "test-as-token"', rendered)
            self.assertIn('hs_token: "test-hs-token"', rendered)
            self.assertIn('pickle_key: "stable-pickle-key"', rendered)
            self.assertEqual(0o600, stat.S_IMODE(output.stat().st_mode))
            self.assertNotIn(password, result.stdout)
            self.assertNotIn("test-as-token", result.stdout)
            self.assertNotIn("test-hs-token", result.stdout)

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
