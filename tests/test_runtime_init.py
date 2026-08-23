import os
import pathlib
import stat
import subprocess
import tempfile
import unittest


ROOT = pathlib.Path(__file__).resolve().parents[1]


class RuntimeInitTests(unittest.TestCase):
    def test_creates_private_secret_files_without_printing_values(self):
        with tempfile.TemporaryDirectory() as directory:
            env = os.environ | {"COMMUNICATOR_RUNTIME_DIR": directory}
            result = subprocess.run(
                [ROOT / "scripts/init-runtime.sh"],
                env=env,
                check=True,
                text=True,
                capture_output=True,
            )
            secret = pathlib.Path(directory) / "secrets/postgres.env"
            self.assertTrue(secret.exists())
            self.assertEqual(0o600, stat.S_IMODE(secret.stat().st_mode))
            self.assertIn("POSTGRES_PASSWORD=", secret.read_text())
            self.assertNotIn(secret.read_text().split("=", 1)[1].strip(), result.stdout)

    def test_second_run_is_idempotent(self):
        with tempfile.TemporaryDirectory() as directory:
            env = os.environ | {"COMMUNICATOR_RUNTIME_DIR": directory}
            subprocess.run([ROOT / "scripts/init-runtime.sh"], env=env, check=True)
            secret = pathlib.Path(directory) / "secrets/postgres.env"
            before = secret.read_text()
            subprocess.run([ROOT / "scripts/init-runtime.sh"], env=env, check=True)
            self.assertEqual(before, secret.read_text())


if __name__ == "__main__":
    unittest.main()
