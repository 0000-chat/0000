import pathlib
import stat
import subprocess
import tempfile
import unittest


ROOT = pathlib.Path(__file__).resolve().parents[1]
RENDERER = ROOT / "scripts/render-telegram-config.py"


class TelegramConfigRenderTests(unittest.TestCase):
    def write_inputs(self, directory: pathlib.Path, *, api_id="12345", api_hash="0" * 32):
        password = directory / "telegram-db.password"
        api_id_file = directory / "telegram-api-id"
        api_hash_file = directory / "telegram-api-hash"
        registration = directory / "registration.yaml"
        password.write_text("p@ss:word/with?hash#'quote\n")
        api_id_file.write_text(api_id + "\n")
        api_hash_file.write_text(api_hash + "\n")
        registration.write_text('as_token: "test-as-token"\nhs_token: "test-hs-token"\n')
        for path in (password, api_id_file, api_hash_file, registration):
            path.chmod(0o600)
        return password, api_id_file, api_hash_file, registration

    def render(self, directory, output, *extra):
        password, api_id, api_hash, registration = self.write_inputs(directory)
        return subprocess.run(
            [
                "python3",
                RENDERER,
                "--db-password-file",
                password,
                "--api-id-file",
                api_id,
                "--api-hash-file",
                api_hash,
                *extra,
                "--output",
                output,
            ],
            text=True,
            capture_output=True,
        ), registration

    def test_renders_exact_secret_safe_config(self):
        with tempfile.TemporaryDirectory() as directory:
            directory = pathlib.Path(directory)
            output = directory / "config.yaml"
            result, _ = self.render(directory, output, "--registration", directory / "registration.yaml")
            self.assertEqual(0, result.returncode, result.stderr)
            rendered = output.read_text()
            self.assertIn(
                "postgres://telegram_bridge:p%40ss%3Aword%2Fwith%3Fhash%23%27quote@postgres/telegram_bridge?sslmode=disable",
                rendered,
            )
            self.assertIn("api_id: 12345\n", rendered)
            self.assertIn('api_hash: "00000000000000000000000000000000"', rendered)
            self.assertIn('"@human:communicator.0000.gold": user', rendered)
            self.assertIn('"@platform-admin:communicator.0000.gold": admin', rendered)
            self.assertEqual(0o600, stat.S_IMODE(output.stat().st_mode))
            self.assertEqual("telegram_config=PASS\n", result.stdout)
            for secret in (
                "p@ss:word/with?hash#'quote",
                "00000000000000000000000000000000",
                "test-as-token",
                "test-hs-token",
            ):
                self.assertNotIn(secret, result.stdout)

    def test_pre_registration_uses_generate_and_final_render_uses_registration(self):
        with tempfile.TemporaryDirectory() as directory:
            directory = pathlib.Path(directory)
            output = directory / "config.yaml"
            result, registration = self.render(directory, output)
            self.assertEqual(0, result.returncode, result.stderr)
            self.assertIn("as_token: generate", output.read_text())
            self.assertIn("hs_token: generate", output.read_text())
            result = subprocess.run(
                [
                    "python3",
                    RENDERER,
                    "--db-password-file",
                    directory / "telegram-db.password",
                    "--api-id-file",
                    directory / "telegram-api-id",
                    "--api-hash-file",
                    directory / "telegram-api-hash",
                    "--registration",
                    registration,
                    "--output",
                    output,
                ],
                text=True,
                capture_output=True,
            )
            self.assertEqual(0, result.returncode, result.stderr)
            rendered = output.read_text()
            self.assertIn('as_token: "test-as-token"', rendered)
            self.assertIn('hs_token: "test-hs-token"', rendered)

    def test_existing_pickle_key_is_preserved(self):
        with tempfile.TemporaryDirectory() as directory:
            directory = pathlib.Path(directory)
            output = directory / "config.yaml"
            output.write_text('encryption:\n  pickle_key: "stable-pickle-key"\n')
            output.chmod(0o600)
            result, registration = self.render(directory, output, "--registration", directory / "registration.yaml")
            self.assertEqual(0, result.returncode, result.stderr)
            self.assertIn('pickle_key: "stable-pickle-key"', output.read_text())

    def test_rejects_unsafe_input_files(self):
        with tempfile.TemporaryDirectory() as directory:
            directory = pathlib.Path(directory)
            password, api_id, api_hash, registration = self.write_inputs(directory)
            output = directory / "config.yaml"
            for unsafe in (password, api_id, api_hash, registration):
                unsafe.chmod(0o640)
                result = subprocess.run(
                    [
                        "python3",
                        RENDERER,
                        "--db-password-file",
                        password,
                        "--api-id-file",
                        api_id,
                        "--api-hash-file",
                        api_hash,
                        "--registration",
                        registration,
                        "--output",
                        output,
                    ],
                    text=True,
                    capture_output=True,
                )
                self.assertNotEqual(0, result.returncode)
                unsafe.chmod(0o600)
            symlink = directory / "symlink"
            symlink.symlink_to(password)
            result = subprocess.run(
                [
                    "python3",
                    RENDERER,
                    "--db-password-file",
                    symlink,
                    "--api-id-file",
                    api_id,
                    "--api-hash-file",
                    api_hash,
                    "--output",
                    output,
                ],
                text=True,
                capture_output=True,
            )
            self.assertNotEqual(0, result.returncode)

    def test_rejects_invalid_api_values(self):
        for field, value in (("api_id", "not-a-number"), ("api_hash", "abcd")):
            with tempfile.TemporaryDirectory() as directory:
                directory = pathlib.Path(directory)
                password, api_id, api_hash, registration = self.write_inputs(directory)
                (api_id if field == "api_id" else api_hash).write_text(value + "\n")
                result = subprocess.run(
                    [
                        "python3",
                        RENDERER,
                        "--db-password-file",
                        password,
                        "--api-id-file",
                        api_id,
                        "--api-hash-file",
                        api_hash,
                        "--registration",
                        registration,
                        "--output",
                        directory / "config.yaml",
                    ],
                    text=True,
                    capture_output=True,
                )
                self.assertNotEqual(0, result.returncode)


if __name__ == "__main__":
    unittest.main()
