from pathlib import Path
import unittest


SCRIPT = Path(__file__).parents[1] / "scripts" / "restore-core-test.sh"
DB_INIT = Path(__file__).parents[1] / "scripts" / "init-whatsapp-db.sh"
MESSENGER_DB_INIT = Path(__file__).parents[1] / "scripts" / "init-messenger-db.sh"
TELEGRAM_DB_INIT = Path(__file__).parents[1] / "scripts" / "init-telegram-db.sh"


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
        self.assertIn('[[ -f "$payload/retention/controlled-copy-layout.json" ]]', source)
        self.assertIn('cp -a "$payload/whatsapp-data/." "$restore_root/runtime/whatsapp/"', source)
        self.assertIn('chown -R 1337:1337 "$restore_root/runtime/whatsapp"', source)
        self.assertIn('[[ "$(stat -c \'%a\' "$restore_root/runtime/whatsapp/config.yaml")" == 600 ]]', source)
        self.assertIn("./scripts/init-whatsapp-db.sh", source)
        self.assertIn('"$project" == communicator-restore-test', db_init)
        self.assertIn("pg_restore -U synapse -d whatsapp_bridge", source)
        self.assertIn("whatsapp_restore_tables=PASS", source)
        self.assertIn("--generate-registration", source)
        self.assertNotIn("-n --generate-registration", source)
        self.assertIn("-c /validation/config.yaml --generate-registration", source)
        self.assertNotIn("up -d whatsapp", source)
        self.assertNotIn("start whatsapp", source)

    def test_restores_and_validates_messenger_without_starting_live_session(self):
        source = SCRIPT.read_text()
        db_init = MESSENGER_DB_INIT.read_text()

        self.assertIn('[[ -f "$payload/messenger.pgdump" ]]', source)
        self.assertIn('cp -a "$payload/messenger-data/." "$restore_root/runtime/messenger/"', source)
        self.assertIn('chown -R 1337:1337 "$restore_root/runtime/messenger"', source)
        self.assertIn('[[ "$(stat -c \'%a\' "$restore_root/runtime/messenger/config.yaml")" == 600 ]]', source)
        self.assertIn('[[ "$(stat -c \'%a\' "$restore_root/runtime/messenger/registration.yaml")" == 600 ]]', source)
        self.assertIn('cp -a "$payload/synapse-data/." "$restore_root/runtime/synapse/"', source)
        self.assertIn('messenger-registration.yaml', source)
        self.assertIn('messenger-db.password', source)
        self.assertIn('messenger-db.env', source)
        self.assertIn("./scripts/init-messenger-db.sh", source)
        self.assertIn('"$project" == communicator-restore-test', db_init)
        self.assertIn("pg_restore -U synapse -d messenger_bridge", source)
        self.assertIn("messenger_restore_tables=PASS", source)
        self.assertIn("docker run --rm --network none", source)
        self.assertIn("/usr/bin/mautrix-meta", source)
        self.assertIn("-c /validation/config.yaml --generate-registration", source)
        self.assertIn("messenger_config=PASS", source)
        self.assertNotIn("up -d messenger", source)
        self.assertNotIn("start messenger", source)

    def test_restores_telegram_and_validates_it_offline_without_starting_client(self):
        source = SCRIPT.read_text()
        telegram_db_init = TELEGRAM_DB_INIT.read_text()

        for required in (
            '[[ -f "$payload/telegram.pgdump" ]]',
            'cp -a "$payload/telegram-data/." "$restore_root/runtime/telegram/"',
            'cp -a "$payload/telegram-secrets/." "$restore_root/runtime/secrets/"',
            'chown -R 1337:1337 "$restore_root/runtime/telegram"',
            '"$restore_root/runtime/secrets/telegram-api-id"',
            "pg_restore -U synapse -d telegram_bridge --clean --if-exists --no-owner",
            "information_schema.tables",
            "telegram_restore_tables=PASS",
            'docker run --rm --network none',
            "/usr/bin/mautrix-telegram",
            "-c /validation/config.yaml -g -r /validation/registration.yaml",
            "telegram_config=PASS",
        ):
            self.assertIn(required, source)
        self.assertIn("./scripts/init-telegram-db.sh", source)
        self.assertIn('"$project" == communicator-restore-test', telegram_db_init)
        self.assertNotIn("up -d telegram", source)
        self.assertNotIn("start telegram", source)
        self.assertNotIn("--network host", source)


if __name__ == "__main__":
    unittest.main()
