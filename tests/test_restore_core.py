from pathlib import Path
import unittest


SCRIPT = Path(__file__).parents[1] / "scripts" / "restore-core-test.sh"


class RestoreCoreTests(unittest.TestCase):
    def test_waits_for_postgres_health_before_restoring_dump(self):
        source = SCRIPT.read_text()

        self.assertIn("wait_for_healthy() {", source)
        wait_start = source.index("wait_for_healthy() {")
        restore_start = source.index("pg_restore", wait_start)
        restore_section = source[wait_start:restore_start]

        self.assertIn("State.Health.Status", restore_section)
        self.assertIn("wait_for_healthy postgres", restore_section)
        self.assertIn("wait_for_healthy synapse", source)
        self.assertLess(source.index("wait_for_healthy synapse"), source.index("127.0.0.1:8008/health"))
        self.assertIn('chown -R 991:991 "$restore_root/runtime/synapse"', source)
        self.assertLess(
            source.index('chown -R 991:991 "$restore_root/runtime/synapse"'),
            source.index("docker compose --env-file deploy/images.lock.env up -d synapse"),
        )


if __name__ == "__main__":
    unittest.main()
