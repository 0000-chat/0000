from pathlib import Path
import unittest


SCRIPT = Path(__file__).parents[1] / "scripts" / "backup-core.sh"


class BackupCoreTests(unittest.TestCase):
    def test_captures_whatsapp_database_session_config_and_secrets(self):
        source = SCRIPT.read_text()

        self.assertIn("stop whatsapp synapse", source)
        stop = source.index("stop whatsapp synapse")
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
        self.assertIn("start synapse whatsapp", source)


if __name__ == "__main__":
    unittest.main()
