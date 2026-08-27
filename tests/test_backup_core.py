from pathlib import Path
import unittest


SCRIPT = Path(__file__).parents[1] / "scripts" / "backup-core.sh"


class BackupCoreTests(unittest.TestCase):
    def test_captures_whatsapp_database_session_config_and_secrets(self):
        source = SCRIPT.read_text()

        self.assertIn("stop messenger whatsapp synapse", source)
        stop = source.index("stop messenger whatsapp synapse")
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

        self.assertIn("stop messenger whatsapp synapse", source)
        stop = source.index("stop messenger whatsapp synapse")
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
        restart = "docker compose --env-file deploy/images.lock.env up -d --wait --wait-timeout 180 synapse whatsapp messenger"
        self.assertIn("restart_core() {", source)
        self.assertIn(restart, source)
        self.assertGreaterEqual(source.count("restart_core"), 3)


if __name__ == "__main__":
    unittest.main()
