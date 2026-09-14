import json
import subprocess
import tempfile
from pathlib import Path
import unittest


SCRIPT = Path(__file__).parents[1] / "scripts" / "backup-core.sh"
MANIFEST_MERGER = Path(__file__).parents[1] / "scripts" / "merge-controlled-copy-manifest.py"
LAYOUT_WRITER = Path(__file__).parents[1] / "scripts" / "write-controlled-copy-layout.py"


class BackupCoreTests(unittest.TestCase):
    def test_captures_whatsapp_database_session_config_and_secrets(self):
        source = SCRIPT.read_text()

        self.assertIn("stop telegram messenger whatsapp synapse", source)
        stop = source.index("stop telegram messenger whatsapp synapse")
        synapse_dump = source.index("pg_dump -U synapse -d synapse", stop)
        whatsapp_dump = source.index("pg_dump -U synapse -d whatsapp_bridge", stop)
        backup = source.index('restic backup --json --tag communicator-core "$staging"', whatsapp_dump)

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
        backup = source.index('restic backup --json --tag communicator-core "$staging"', messenger_dump)
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
        backup = source.index('restic backup --json --tag communicator-core "$staging"', telegram_dump)
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

    def test_marks_restic_snapshot_as_mixed_for_controlled_copy_cleanup(self):
        source = SCRIPT.read_text()

        self.assertIn('controlled-copy-manifest.json', source)
        self.assertIn('"content_classes": ["message", "session_credential", "account_key"]', source)
        self.assertIn('"resource_id": "communicator-core"', source)
        self.assertIn('"content_generation": "${backup_id}"', source)
        self.assertLess(
            source.index('controlled-copy-manifest.json'),
            source.index('restic backup --json --tag communicator-core "$staging"'),
        )
        self.assertIn('restic backup --json --tag communicator-core "$staging"', source)
        self.assertIn('"$repo_dir/scripts/write-controlled-copy-layout.py" "$staging"', source)
        self.assertIn('"$repo_dir/scripts/merge-controlled-copy-manifest.py"', source)
        self.assertIn('"$runtime_dir/retention/controlled-copy-manifest.json"', source)
        self.assertNotIn('unresolved-', source)

    def test_core_layout_records_all_regular_files_and_supported_dump_contracts(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            for dump in (
                "synapse.pgdump",
                "whatsapp.pgdump",
                "messenger.pgdump",
                "telegram.pgdump",
            ):
                (root / dump).write_bytes(b"custom-dump-fixture")
            (root / "secrets").mkdir()
            (root / "secrets/session.key").write_text("fixture", encoding="utf-8")
            subprocess.run(["python3", str(LAYOUT_WRITER), str(root)], check=True)

            layout_path = root / "retention/controlled-copy-layout.json"
            layout = json.loads(layout_path.read_text(encoding="utf-8"))
            self.assertEqual(1, layout["version"])
            self.assertEqual("communicator-core-pgdump-v1", layout["format"])
            self.assertEqual(
                ["synapse", "whatsapp_bridge", "messenger_bridge", "telegram_bridge"],
                [database["name"] for database in layout["databases"]],
            )
            self.assertEqual(
                [
                    "messenger.pgdump",
                    "secrets/session.key",
                    "synapse.pgdump",
                    "telegram.pgdump",
                    "whatsapp.pgdump",
                ],
                layout["files"],
            )
            self.assertNotIn("retention/controlled-copy-layout.json", layout["files"])
            self.assertEqual(0o600, layout_path.stat().st_mode & 0o777)

    def test_merges_exact_backup_result_without_losing_other_inventory(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            result = root / "restic-result.jsonl"
            manifest = root / "retention" / "controlled-copy-manifest.json"
            manifest.parent.mkdir()
            result.write_text(
                "\n".join(
                    [
                        json.dumps({"message_type": "status", "percent_done": 1}),
                        json.dumps(
                            {
                                "message_type": "summary",
                                "snapshot_id": "new-snapshot",
                                "time": "2026-09-14T00:01:00Z",
                            }
                        ),
                    ]
                )
                + "\n",
                encoding="utf-8",
            )
            manifest.write_text(
                json.dumps(
                    {
                        "version": 1,
                        "stores": {
                            "media_store": {
                                "enumeration_complete": True,
                                "copies": [
                                    {
                                        "reference": "media:one",
                                        "copy_created_at": "2026-09-13T00:00:00Z",
                                    }
                                ],
                            },
                            "restic_snapshot": {
                                "enumeration_complete": True,
                                "copies": [
                                    {
                                        "reference": "restic:old-snapshot",
                                        "snapshot_id": "old-snapshot",
                                        "resource_id": "*",
                                        "content_generation": "*",
                                        "copy_created_at": "2026-09-13T00:00:00Z",
                                        "content_classes": [
                                            "message",
                                            "session_credential",
                                            "account_key",
                                        ],
                                    }
                                ],
                            },
                        },
                    }
                ),
                encoding="utf-8",
            )
            subprocess.run(
                [
                    "python3",
                    str(MANIFEST_MERGER),
                    str(result),
                    str(manifest),
                    "2026-09-14T00:00:00Z",
                ],
                check=True,
            )
            document = json.loads(manifest.read_text(encoding="utf-8"))
            self.assertIn("media_store", document["stores"])
            restic = document["stores"]["restic_snapshot"]
            self.assertFalse(restic["enumeration_complete"])
            self.assertEqual(
                [copy["snapshot_id"] for copy in restic["copies"]],
                ["old-snapshot", "new-snapshot"],
            )
            new_copy = next(
                copy
                for copy in restic["copies"]
                if copy["snapshot_id"] == "new-snapshot"
            )
            self.assertEqual("communicator-core", new_copy["resource_id"])
            self.assertEqual("new-snapshot", new_copy["content_generation"])
            self.assertEqual(manifest.stat().st_mode & 0o777, 0o600)

            subprocess.run(
                [
                    "python3",
                    str(MANIFEST_MERGER),
                    str(result),
                    str(manifest),
                    "2026-09-14T00:00:00Z",
                ],
                check=True,
            )
            document = json.loads(manifest.read_text(encoding="utf-8"))
            self.assertEqual(
                len(document["stores"]["restic_snapshot"]["copies"]), 2
            )
            self.assertTrue(
                all(
                    not path.name.startswith("controlled-copy-manifest-")
                    for path in manifest.parent.iterdir()
                )
            )


if __name__ == "__main__":
    unittest.main()
