import pathlib
import stat
import subprocess
import tempfile
import unittest
from urllib.parse import quote


ROOT = pathlib.Path(__file__).resolve().parents[1]
RENDERER = ROOT / "scripts/render-messenger-config.py"


class MessengerRenderTests(unittest.TestCase):
    def test_renders_exact_policy_and_preserves_secrets_without_stdout_values(self):
        password = "p@ss:word/with?hash#'quote"
        with tempfile.TemporaryDirectory() as directory:
            password_file = pathlib.Path(directory) / "db.password"
            registration = pathlib.Path(directory) / "registration.yaml"
            output = pathlib.Path(directory) / "config.yaml"
            password_file.write_text(password + "\n")
            password_file.chmod(0o600)
            registration.write_text('as_token: "fake-as-token"\nhs_token: "fake-hs-token"\n')
            registration.chmod(0o600)
            output.write_text('encryption:\n    pickle_key: "stable-messenger-pickle"\n')

            result = subprocess.run(
                [
                    "python3",
                    RENDERER,
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
                "postgres://messenger_bridge:"
                + quote(password, safe="")
                + "@postgres/messenger_bridge?sslmode=disable"
            )
            self.assertIn(expected_uri, rendered)
            for expected in (
                "  send_presence_on_typing: false",
                "  disable_view_once: true",
                "  thread_backfill:",
                "    batch_count: 0",
                "bridge:",
                "  split_portals: true",
                "  personal_filtering_spaces: true",
                "  async_events: false",
                '    "*": relay\n    "@human:communicator.0000.gold": user\n    "@agent:communicator.0000.gold": user\n    "@platform-admin:communicator.0000.gold": admin',
                "  relay:",
                "    enabled: false",
                "    admin_only: true",
                "    default_relays: []",
                "matrix:",
                "  delivery_receipts: true",
                "  federate_rooms: false",
                "  provisioning:",
                "    shared_secret: disable",
                "    allow_matrix_auth: false",
                "    debug_endpoints: false",
                "    enable_session_transfers: false",
                "  public_media:",
                "    enabled: false",
                "  direct_media:",
                "    enabled: false",
                "backfill:",
                "  enabled: false",
                "  max_initial_messages: 0",
                "  max_catchup_messages: 0",
                "encryption:",
                "  allow: true",
                "  default: true",
                "  require: true",
                "  appservice: false",
                "  msc4190: false",
                'as_token: "fake-as-token"',
                'hs_token: "fake-hs-token"',
                'pickle_key: "stable-messenger-pickle"',
                "username_template: messenger_{{.}}",
            ):
                self.assertIn(expected, rendered)
            self.assertEqual(0o600, stat.S_IMODE(output.stat().st_mode))
            self.assertNotIn(password, result.stdout)
            self.assertNotIn("fake-as-token", result.stdout)
            self.assertNotIn("fake-hs-token", result.stdout)
            self.assertNotIn("stable-messenger-pickle", result.stdout)
            self.assertEqual([], list(pathlib.Path(directory).glob(".config.yaml.*")))

    def test_requires_password_file_and_private_mode(self):
        with tempfile.TemporaryDirectory() as directory:
            directory = pathlib.Path(directory)
            missing = subprocess.run(
                [
                    "python3",
                    RENDERER,
                    "--db-password-file",
                    directory / "missing",
                    "--output",
                    directory / "config.yaml",
                ],
                text=True,
                capture_output=True,
            )
            self.assertNotEqual(0, missing.returncode)
            password_file = directory / "db.password"
            password_file.write_text("fake-password\n")
            password_file.chmod(0o644)
            broad = subprocess.run(
                [
                    "python3",
                    RENDERER,
                    "--db-password-file",
                    password_file,
                    "--output",
                    directory / "config.yaml",
                ],
                text=True,
                capture_output=True,
            )
            self.assertNotEqual(0, broad.returncode)

    def test_rejects_missing_or_broad_registration_when_supplied(self):
        with tempfile.TemporaryDirectory() as directory:
            directory = pathlib.Path(directory)
            password_file = directory / "db.password"
            password_file.write_text("fake-password\n")
            password_file.chmod(0o600)
            missing = subprocess.run(
                [
                    "python3",
                    RENDERER,
                    "--db-password-file",
                    password_file,
                    "--registration",
                    directory / "missing-registration.yaml",
                    "--output",
                    directory / "config.yaml",
                ],
                text=True,
                capture_output=True,
            )
            self.assertNotEqual(0, missing.returncode)
            registration = directory / "registration.yaml"
            registration.write_text('as_token: "fake-as-token"\nhs_token: "fake-hs-token"\n')
            registration.chmod(0o644)
            broad = subprocess.run(
                [
                    "python3",
                    RENDERER,
                    "--db-password-file",
                    password_file,
                    "--registration",
                    registration,
                    "--output",
                    directory / "config.yaml",
                ],
                text=True,
                capture_output=True,
            )
            self.assertNotEqual(0, broad.returncode)

    def test_pre_registration_render_uses_literal_generate_tokens(self):
        with tempfile.TemporaryDirectory() as directory:
            directory = pathlib.Path(directory)
            password_file = directory / "db.password"
            output = directory / "config.yaml"
            password_file.write_text("fake-password\n")
            password_file.chmod(0o600)
            result = subprocess.run(
                [
                    "python3",
                    RENDERER,
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
            self.assertIn('as_token: "generate"', rendered)
            self.assertIn('hs_token: "generate"', rendered)
            self.assertNotIn("fake-password", result.stdout)


if __name__ == "__main__":
    unittest.main()
