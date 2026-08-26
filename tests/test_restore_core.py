from pathlib import Path
import unittest


SCRIPT = Path(__file__).parents[1] / "scripts" / "restore-core-test.sh"
DB_INIT = Path(__file__).parents[1] / "scripts" / "init-whatsapp-db.sh"


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

    def test_restores_and_validates_whatsapp_without_starting_live_session(self):
        source = SCRIPT.read_text()
        db_init = DB_INIT.read_text()

        self.assertIn('[[ -f "$payload/whatsapp.pgdump" ]]', source)
        self.assertIn('cp -a "$payload/whatsapp-data/." "$restore_root/runtime/whatsapp/"', source)
        self.assertIn('chown -R 1337:1337 "$restore_root/runtime/whatsapp"', source)
        self.assertIn('[[ "$(stat -c \'%a\' "$restore_root/runtime/whatsapp/config.yaml")" == 600 ]]', source)
        self.assertIn("./scripts/init-whatsapp-db.sh", source)
        self.assertIn('"$project" == communicator-restore-test', db_init)
        self.assertIn("pg_restore -U synapse -d whatsapp_bridge", source)
        self.assertIn("whatsapp_restore_tables=PASS", source)
        self.assertIn("--generate-registration", source)
        self.assertNotIn("up -d whatsapp", source)
        self.assertNotIn("start whatsapp", source)


if __name__ == "__main__":
    unittest.main()
