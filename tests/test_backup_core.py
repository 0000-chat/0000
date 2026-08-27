from pathlib import Path
import unittest


SCRIPT = Path(__file__).parents[1] / "scripts" / "backup-core.sh"


class BackupCoreTests(unittest.TestCase):
    def test_captures_whatsapp_database_session_config_and_secrets(self):
        source = SCRIPT.read_text()

        self.assertIn("stop telegram messenger whatsapp synapse", source)
        stop = source.index("stop telegram messenger whatsapp synapse")
        synapse_dump = source.index("pg_dump -U synapse -d synapse", stop)
        whatsapp_dump = source.index("pg_dump -U synapse -d whatsapp_bridge", stop)
        backup = source.index('restic backup "$staging"', whatsapp_dump)

        self.assertLess(stop, synapse_dump)
        self.assertLess(synapse_dump, backup)
        self.assertLess(whatsapp_dump, backup)
        self.assertIn('"$staging/whatsapp.pgdump"', source)
        self.assertIn('"$staging/whatsapp-data"', source)
        self.assertIn('"$runtime_dir/whatsapp/config.yaml"', source)
        self.assertIn('"$runtime_dir/whatsapp/registration.yaml"', source)
        self.assertIn('"$runtime_dir/synapse/whatsapp-registration.yaml"', source)
        self.assertIn('"$runtime_dir/secrets/whatsapp-db.password"', source)
        self.assertIn('"$runtime_dir/secrets/whatsapp-db.env"', source)
        self.assertIn("restart_core() {", source)

    def test_captures_messenger_database_session_config_and_secrets(self):
        source = SCRIPT.read_text()

        self.assertIn("stop telegram messenger whatsapp synapse", source)
        stop = source.index("stop telegram messenger whatsapp synapse")
        messenger_dump = source.index("pg_dump -U synapse -d messenger_bridge", stop)
        backup = source.index('restic backup "$staging"', messenger_dump)
        self.assertLess(messenger_dump, backup)
        self.assertIn('"$staging/messenger.pgdump"', source)
        self.assertIn('"$staging/messenger-data"', source)
        self.assertIn('"$runtime_dir/messenger/config.yaml"', source)
        self.assertIn('"$runtime_dir/messenger/registration.yaml"', source)
        self.assertIn('"$runtime_dir/synapse/messenger-registration.yaml"', source)
        self.assertIn('"$runtime_dir/secrets/messenger-db.password"', source)
        self.assertIn('"$runtime_dir/secrets/messenger-db.env"', source)

    def test_restart_core_is_bounded_and_used_on_cleanup_and_success(self):
        source = SCRIPT.read_text()
        restart = "docker compose --env-file deploy/images.lock.env up -d --wait --wait-timeout 180 synapse whatsapp messenger telegram"
        self.assertIn("restart_core() {", source)
        self.assertIn(restart, source)
        self.assertGreaterEqual(source.count("restart_core"), 3)
        self.assertIn(
            "up -d --wait --wait-timeout 180 synapse whatsapp messenger telegram",
            source,
        )

    def test_captures_telegram_database_runtime_and_credentials(self):
        source = SCRIPT.read_text()

        self.assertIn("stop telegram messenger whatsapp synapse", source)
        stop = source.index("stop telegram messenger whatsapp synapse")
        telegram_dump = source.index("pg_dump -U synapse -d telegram_bridge", stop)
        backup = source.index('restic backup "$staging"', telegram_dump)
        self.assertLess(telegram_dump, backup)
        for required in (
            '"$staging/telegram.pgdump"',
            '"$staging/telegram-data"',
            '"$staging/telegram-secrets"',
            '"$runtime_dir/telegram/config.yaml"',
            '"$runtime_dir/telegram/registration.yaml"',
            '"$runtime_dir/synapse/telegram-registration.yaml"',
            '"$runtime_dir/secrets/telegram-db.password"',
            '"$runtime_dir/secrets/telegram-db.env"',
            '"$runtime_dir/secrets/telegram-api-id"',
            '"$runtime_dir/secrets/telegram-api-hash"',
            'docker compose --env-file deploy/images.lock.env up -d --wait --wait-timeout 180 synapse whatsapp messenger telegram',
        ):
            self.assertIn(required, source)
        self.assertIn("restart_core() {", source)
        self.assertGreaterEqual(source.count("restart_core"), 3)


if __name__ == "__main__":
    unittest.main()
