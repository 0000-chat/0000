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
            output = pathlib.Path(directory) / "homeserver.yaml"
            source.write_text("POSTGRES_DB=synapse\nPOSTGRES_USER=synapse\nPOSTGRES_PASSWORD=correct-horse-battery-staple\n")
            registration.write_text("registration-secret-value\n")
            result = subprocess.run(
                [
                    "python3",
                    ROOT / "scripts/render-synapse-config.py",
                    "--postgres-env", source,
                    "--registration-secret", registration,
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


if __name__ == "__main__":
    unittest.main()
