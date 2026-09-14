import importlib.util
import json
import os
import socket
import subprocess
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch


ROOT = Path(__file__).parents[1]
MODULE_PATH = ROOT / "scripts" / "controlled-copy-retention.py"
SPEC = importlib.util.spec_from_file_location("controlled_copy_retention", MODULE_PATH)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError("controlled-copy-retention module could not load")
RETENTION = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(RETENTION)


PG_BIN = Path("/usr/lib/postgresql/18/bin")
LEGACY_ORIGINAL_CORE_FILES = (
    "synapse.pgdump",
    "whatsapp.pgdump",
    "messenger.pgdump",
    "telegram.pgdump",
    "synapse-data/homeserver.yaml",
    "synapse-data/log.config",
    "synapse-data/communicator.0000.gold.signing.key",
    "synapse-data/whatsapp-registration.yaml",
    "synapse-data/messenger-registration.yaml",
    "whatsapp-data/config.yaml",
    "whatsapp-data/registration.yaml",
    "messenger-data/config.yaml",
    "messenger-data/registration.yaml",
    "telegram-data/config.yaml",
    "telegram-data/registration.yaml",
    "telegram-data/synapse-registration.yaml",
    "telegram-secrets/telegram-db.password",
    "telegram-secrets/telegram-db.env",
    "telegram-secrets/telegram-api-id",
    "telegram-secrets/telegram-api-hash",
    "secrets/postgres.env",
    "secrets/synapse_registration_shared_secret",
    "secrets/whatsapp-db.password",
    "secrets/whatsapp-db.env",
    "secrets/messenger-db.password",
    "secrets/messenger-db.env",
)


def _free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        probe.bind(("127.0.0.1", 0))
        return int(probe.getsockname()[1])


def _pg_client(socket_dir: Path, port: int, database: str, sql: str) -> str:
    result = subprocess.run(
        [
            str(PG_BIN / "psql"),
            "--no-psqlrc",
            "--tuples-only",
            "--no-align",
            "--quiet",
            "--host",
            str(socket_dir),
            "--port",
            str(port),
            "--username",
            "fixture",
            "--dbname",
            database,
            "--command",
            sql,
        ],
        check=True,
        capture_output=True,
        text=True,
    )
    return result.stdout.strip()


def _write_legacy_core_tree(root: Path, dump_bytes: bytes = b"fixture-dump") -> None:
    for relative in LEGACY_ORIGINAL_CORE_FILES:
        path = root / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(dump_bytes)
    (root / "synapse-data/media_store").mkdir(parents=True, exist_ok=True)


class ControlledCopyRetentionTests(unittest.TestCase):
    def test_media_inventory_and_cleanup_remove_only_the_exact_manifest_path(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            media = root / "media"
            media.mkdir()
            target = media / "message-one.bin"
            retained = media / "message-two.bin"
            target.write_bytes(b"removed")
            retained.write_bytes(b"retained")
            manifest = root / "manifest.json"
            manifest.write_text(
                json.dumps(
                    {
                        "version": 1,
                        "stores": {
                            "media_store": {
                                "enumeration_complete": True,
                                "copies": [
                                    {
                                        "reference": "media:message-one",
                                        "resource_id": "message_one",
                                        "content_generation": "generation_one",
                                        "copy_created_at": "2026-09-01T00:00:00Z",
                                        "content_class": "attachment",
                                        "path": "message-one.bin",
                                    },
                                    {
                                        "reference": "media:message-two",
                                        "resource_id": "message_two",
                                        "content_generation": "generation_two",
                                        "copy_created_at": "2026-09-01T00:00:00Z",
                                        "content_class": "attachment",
                                        "path": "message-two.bin",
                                    },
                                ],
                            }
                        },
                    }
                ),
                encoding="utf-8",
            )
            environment = {
                "COMMUNICATOR_RETENTION_MANIFEST": str(manifest),
                "COMMUNICATOR_RETENTION_MEDIA_STORE_ROOT": str(media),
            }
            with patch.dict(os.environ, environment, clear=False):
                inventory = RETENTION.process_request(
                    "inventory",
                    {
                        "protocol": RETENTION.PROTOCOL,
                        "store": "media_store",
                        "scope": {
                            "resource_id": "message_one",
                            "content_generation": "generation_one",
                        },
                    },
                )
                self.assertTrue(inventory["complete"])
                self.assertEqual("media:message-one", inventory["copies"][0]["reference"])
                evidence = RETENTION.process_request(
                    "cleanup",
                    {
                        "protocol": RETENTION.PROTOCOL,
                        "store": "media_store",
                        "resource_id": "message_one",
                        "content_generation": "generation_one",
                        "reference": "media:message-one",
                    },
                )
            self.assertEqual("deleted", evidence["status"])
            self.assertFalse(target.exists())
            self.assertTrue(retained.exists())
            with patch.dict(os.environ, environment, clear=False):
                after_cleanup = RETENTION.process_request(
                    "inventory",
                    {
                        "protocol": RETENTION.PROTOCOL,
                        "store": "media_store",
                        "scope": {
                            "resource_id": "message_one",
                            "content_generation": "generation_one",
                        },
                    },
                )
            self.assertTrue(after_cleanup["complete"])
            self.assertEqual([], after_cleanup["copies"])

    def test_mixed_restic_snapshot_is_visible_and_never_forgotten(self):
        with tempfile.TemporaryDirectory() as directory:
            manifest = Path(directory) / "manifest.json"
            manifest.write_text(
                json.dumps(
                    {
                        "version": 1,
                        "stores": {
                            "restic_snapshot": {
                                "enumeration_complete": True,
                                "copies": [
                                    {
                                        "reference": "restic:core-1",
                                        "snapshot_id": "core-1",
                                        "resource_id": "*",
                                        "content_generation": "*",
                                        "copy_created_at": "2026-09-01T00:00:00Z",
                                        "content_classes": [
                                            "message",
                                            "session_credential",
                                            "account_key",
                                        ],
                                    }
                                ],
                            }
                        },
                    }
                ),
                encoding="utf-8",
            )
            with patch.dict(
                os.environ,
                {"COMMUNICATOR_RETENTION_MANIFEST": str(manifest)},
                clear=False,
            ):
                inventory = RETENTION.process_request(
                    "inventory",
                    {
                        "protocol": RETENTION.PROTOCOL,
                        "store": "restic_snapshot",
                        "scope": {
                            "resource_id": "message_one",
                            "content_generation": "generation_one",
                        },
                    },
                )
                self.assertEqual(
                    ["message", "session_credential", "account_key"],
                    inventory["copies"][0]["content_classes"],
                )
                evidence = RETENTION.process_request(
                    "cleanup",
                    {
                        "protocol": RETENTION.PROTOCOL,
                        "store": "restic_snapshot",
                        "resource_id": "message_one",
                        "content_generation": "generation_one",
                        "reference": "restic:core-1",
                    },
                )
            self.assertEqual("lifecycle_pending", evidence["status"])
            self.assertTrue(evidence["content_present"])

    def test_exclusive_message_restic_snapshot_uses_the_real_snapshot_id(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            manifest = root / "manifest.json"
            manifest.write_text(
                json.dumps(
                    {
                        "version": 1,
                        "stores": {
                            "restic_snapshot": {
                                "enumeration_complete": True,
                                "copies": [
                                    {
                                        "reference": "restic:message-1",
                                        "snapshot_id": "snapshot-real-id",
                                        "resource_id": "message_one",
                                        "content_generation": "generation_one",
                                        "copy_created_at": "2026-09-01T00:00:00Z",
                                        "content_classes": ["message"],
                                        "exclusive_resource_id": True,
                                    }
                                ],
                            }
                        },
                    }
                ),
                encoding="utf-8",
            )
            invocation = root / "restic.invocation"
            fake_restic = root / "restic"
            fake_restic.write_text(
                "#!/usr/bin/env python3\n"
                "import pathlib, sys\n"
                f"pathlib.Path({str(invocation)!r}).write_text(' '.join(sys.argv))\n",
                encoding="utf-8",
            )
            fake_restic.chmod(0o700)
            with patch.dict(
                os.environ,
                {
                    "COMMUNICATOR_RETENTION_MANIFEST": str(manifest),
                    "COMMUNICATOR_RETENTION_RESTIC_BIN": str(fake_restic),
                    "RESTIC_REPOSITORY": "repo",
                    "RESTIC_PASSWORD_FILE": str(root / "password"),
                },
                clear=False,
            ):
                evidence = RETENTION.process_request(
                    "cleanup",
                    {
                        "protocol": RETENTION.PROTOCOL,
                        "store": "restic_snapshot",
                        "resource_id": "message_one",
                        "content_generation": "generation_one",
                        "reference": "restic:message-1",
                    },
                )
            self.assertEqual("aged_out", evidence["status"])
            self.assertFalse(evidence["content_present"])
            self.assertIn("snapshot-real-id", invocation.read_text(encoding="utf-8"))

    def test_restic_inventory_reconciles_provider_snapshots_with_the_manifest(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            manifest = root / "manifest.json"
            manifest.write_text(
                json.dumps(
                    {
                        "version": 1,
                        "stores": {
                            "restic_snapshot": {
                                "enumeration_complete": False,
                                "copies": [
                                    {
                                        "reference": "restic:provider-id",
                                        "snapshot_id": "provider-id",
                                        "resource_id": "message_one",
                                        "content_generation": "generation_one",
                                        "copy_created_at": "2026-09-01T00:00:00Z",
                                        "content_classes": ["message"],
                                        "exclusive_resource_id": True,
                                    }
                                ],
                            }
                        },
                    }
                ),
                encoding="utf-8",
            )
            fake_restic = root / "restic"
            fake_restic.write_text(
                "#!/usr/bin/env python3\n"
                "import json\n"
                "import sys\n"
                "if sys.argv[1:3] == ['snapshots', '--json']:\n"
                "    print(json.dumps([{'id': 'provider-id', 'tags': ['communicator-message-migrated']}]))\n",
                encoding="utf-8",
            )
            fake_restic.chmod(0o700)
            with patch.dict(
                os.environ,
                {
                    "COMMUNICATOR_RETENTION_MANIFEST": str(manifest),
                    "COMMUNICATOR_RETENTION_RESTIC_BIN": str(fake_restic),
                    "RESTIC_REPOSITORY": "repo",
                    "RESTIC_PASSWORD_FILE": str(root / "password"),
                },
                clear=False,
            ):
                inventory = RETENTION.process_request(
                    "inventory",
                    {
                        "protocol": RETENTION.PROTOCOL,
                        "store": "restic_snapshot",
                        "scope": {
                            "resource_id": "message_one",
                            "content_generation": "generation_one",
                        },
                    },
                )

            self.assertTrue(inventory["complete"])
            self.assertEqual("restic:provider-id", inventory["copies"][0]["reference"])
            self.assertEqual(
                "restic_snapshots_manifest_reconciliation",
                inventory["evidence_source"],
            )

    def test_synapse_exact_event_redaction_is_recorded_without_false_byte_deletion(self):
        seen: dict[str, str] = {}

        class SynapseHandler(BaseHTTPRequestHandler):
            def log_message(self, _format, *_args):
                return

            def do_GET(self):  # noqa: N802 - stdlib handler API
                seen["inventory_path"] = self.path
                seen["inventory_authorization"] = self.headers.get("authorization", "")
                self.send_response(200)
                self.send_header("content-type", "application/json")
                self.end_headers()
                self.wfile.write(b'{"event_id":"$event:example.test","content":{}}')

            def do_PUT(self):  # noqa: N802 - stdlib handler API
                seen["path"] = self.path
                seen["authorization"] = self.headers.get("authorization", "")
                self.send_response(200)
                self.send_header("content-type", "application/json")
                self.end_headers()
                self.wfile.write(b'{"event_id":"$redaction:example.test"}')

        with tempfile.TemporaryDirectory() as directory:
            manifest = Path(directory) / "manifest.json"
            manifest.write_text(
                json.dumps(
                    {
                        "version": 1,
                        "stores": {
                            "synapse": {
                                "enumeration_complete": True,
                                "copies": [
                                    {
                                        "reference": "synapse:message-one",
                                        "resource_id": "message_one",
                                        "content_generation": "generation_one",
                                        "copy_created_at": "2026-09-01T00:00:00Z",
                                        "content_class": "message",
                                        "room_id": "!room:example.test",
                                        "event_id": "$event:example.test",
                                    }
                                ],
                            }
                        },
                    }
                ),
                encoding="utf-8",
            )
            server = ThreadingHTTPServer(("127.0.0.1", 0), SynapseHandler)
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            try:
                with patch.dict(
                    os.environ,
                    {
                        "COMMUNICATOR_RETENTION_MANIFEST": str(manifest),
                        "COMMUNICATOR_RETENTION_SYNAPSE_HOMESERVER_URL": f"http://127.0.0.1:{server.server_port}",
                        "COMMUNICATOR_RETENTION_SYNAPSE_ACCESS_TOKEN": "synapse-admin-token",
                    },
                    clear=False,
                ):
                    inventory = RETENTION.process_request(
                        "inventory",
                        {
                            "protocol": RETENTION.PROTOCOL,
                            "store": "synapse",
                            "scope": {
                                "resource_id": "message_one",
                                "content_generation": "generation_one",
                            },
                        },
                    )
                    evidence = RETENTION.process_request(
                        "cleanup",
                        {
                            "protocol": RETENTION.PROTOCOL,
                            "store": "synapse",
                            "resource_id": "message_one",
                            "content_generation": "generation_one",
                            "reference": "synapse:message-one",
                        },
                    )
            finally:
                server.shutdown()
                server.server_close()
                thread.join(timeout=2)

            self.assertTrue(inventory["complete"])
            self.assertEqual("synapse:message-one", inventory["copies"][0]["reference"])
            self.assertIn("/_matrix/client/v3/rooms/", seen["inventory_path"])
            self.assertIn("/event/", seen["inventory_path"])
            self.assertEqual("Bearer synapse-admin-token", seen["inventory_authorization"])
            self.assertEqual("quarantined", evidence["status"])
            self.assertTrue(evidence["content_present"])
            self.assertIn("/_matrix/client/v3/rooms/", seen["path"])
            self.assertIn("/redact/", seen["path"])
            self.assertEqual("Bearer synapse-admin-token", seen["authorization"])

    def test_synapse_db_censor_is_authoritative_after_redaction(self):
        seen: dict[str, str] = {}

        class SynapseHandler(BaseHTTPRequestHandler):
            def log_message(self, _format, *_args):
                return

            def do_PUT(self):  # noqa: N802 - stdlib handler API
                seen["path"] = self.path
                self.send_response(200)
                self.send_header("content-type", "application/json")
                self.end_headers()
                self.wfile.write(b'{"event_id":"$redaction:example.test"}')

            def do_GET(self):  # noqa: N802 - DB inventory must be authoritative
                self.send_response(500)
                self.end_headers()

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            manifest = root / "manifest.json"
            manifest.write_text(
                json.dumps(
                    {
                        "version": 1,
                        "stores": {
                            "synapse": {
                                "enumeration_complete": True,
                                "copies": [
                                    {
                                        "reference": "synapse:db-censor",
                                        "resource_id": "message_one",
                                        "content_generation": "generation_one",
                                        "copy_created_at": "2026-09-01T00:00:00Z",
                                        "content_class": "message",
                                        "room_id": "!room:example.test",
                                        "event_id": "$event:example.test",
                                    }
                                ],
                            }
                        },
                    }
                ),
                encoding="utf-8",
            )
            query_log = root / "synapse-psql.log"
            fake_psql = root / "psql"
            fake_psql.write_text(
                "#!/usr/bin/env python3\n"
                "import pathlib\n"
                "import sys\n"
                f"log = pathlib.Path({str(query_log)!r})\n"
                "count = int(log.read_text().splitlines()[0]) if log.exists() else 0\n"
                "log.write_text(str(count + 1) + '\\n' + ' '.join(sys.argv))\n"
                "print('censored' if count >= 2 else 'present')\n",
                encoding="utf-8",
            )
            fake_psql.chmod(0o700)
            server = ThreadingHTTPServer(("127.0.0.1", 0), SynapseHandler)
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            try:
                with patch.dict(
                    os.environ,
                    {
                        "COMMUNICATOR_RETENTION_MANIFEST": str(manifest),
                        "COMMUNICATOR_RETENTION_SYNAPSE_HOMESERVER_URL": f"http://127.0.0.1:{server.server_port}",
                        "COMMUNICATOR_RETENTION_SYNAPSE_ACCESS_TOKEN": "synapse-admin-token",
                        "COMMUNICATOR_RETENTION_SYNAPSE_DATABASE_URL": "postgresql://synapse.invalid/db",
                        "COMMUNICATOR_RETENTION_SYNAPSE_PSQL_BIN": str(fake_psql),
                    },
                    clear=False,
                ):
                    inventory = RETENTION.process_request(
                        "inventory",
                        {
                            "protocol": RETENTION.PROTOCOL,
                            "store": "synapse",
                            "scope": {
                                "resource_id": "message_one",
                                "content_generation": "generation_one",
                            },
                        },
                    )
                    evidence = RETENTION.process_request(
                        "cleanup",
                        {
                            "protocol": RETENTION.PROTOCOL,
                            "store": "synapse",
                            "resource_id": "message_one",
                            "content_generation": "generation_one",
                            "reference": "synapse:db-censor",
                        },
                    )
            finally:
                server.shutdown()
                server.server_close()
                thread.join(timeout=2)

            self.assertTrue(inventory["complete"])
            self.assertEqual("synapse:db-censor", inventory["copies"][0]["reference"])
            self.assertEqual("expired", evidence["status"])
            self.assertFalse(evidence["content_present"])
            self.assertIn("event_json", query_log.read_text(encoding="utf-8"))
            self.assertIn("have_censored", query_log.read_text(encoding="utf-8"))
            self.assertIn("/redact/", seen["path"])

    def test_synapse_redaction_requires_an_exact_empty_content_object(self):
        self.assertTrue(RETENTION.synapse_event_content_is_redacted({"content": {}}))
        self.assertFalse(
            RETENTION.synapse_event_content_is_redacted(
                {"content": {"provider_specific_body": "still present"}}
            )
        )

    def test_synapse_have_censored_with_intact_json_stays_quarantined(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            manifest = root / "manifest.json"
            manifest.write_text(
                json.dumps(
                    {
                        "version": 1,
                        "stores": {
                            "synapse": {
                                "enumeration_complete": True,
                                "copies": [
                                    {
                                        "reference": "synapse:intact-censored",
                                        "resource_id": "message_one",
                                        "content_generation": "generation_one",
                                        "copy_created_at": "2026-09-01T00:00:00Z",
                                        "content_class": "message",
                                        "room_id": "!room:example.test",
                                        "event_id": "$event:example.test",
                                        "event_type": "m.room.message",
                                    }
                                ],
                            }
                        },
                    }
                ),
                encoding="utf-8",
            )
            fake_psql = root / "psql"
            fake_psql.write_text(
                "#!/usr/bin/env python3\nprint('intact_censored')\n", encoding="utf-8"
            )
            fake_psql.chmod(0o700)
            with patch.dict(
                os.environ,
                {
                    "COMMUNICATOR_RETENTION_MANIFEST": str(manifest),
                    "COMMUNICATOR_RETENTION_SYNAPSE_DATABASE_URL": "postgresql://fixture.invalid/db",
                    "COMMUNICATOR_RETENTION_SYNAPSE_PSQL_BIN": str(fake_psql),
                },
                clear=False,
            ):
                evidence = RETENTION.process_request(
                    "cleanup",
                    {
                        "protocol": RETENTION.PROTOCOL,
                        "store": "synapse",
                        "resource_id": "message_one",
                        "content_generation": "generation_one",
                        "reference": "synapse:intact-censored",
                    },
                )
            self.assertEqual("quarantined", evidence["status"])
            self.assertTrue(evidence["content_present"])
            self.assertIn("event_json still contains", evidence["detail"])
            persisted = json.loads(manifest.read_text(encoding="utf-8"))
            self.assertEqual(
                "synapse:intact-censored",
                persisted["stores"]["synapse"]["copies"][0]["reference"],
            )

    def test_mixed_restic_snapshot_can_be_split_only_from_an_exhaustive_fixture(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            manifest = root / "manifest.json"
            manifest.write_text(
                json.dumps(
                    {
                        "version": 1,
                        "stores": {
                            "restic_snapshot": {
                                "enumeration_complete": True,
                                "copies": [
                                    {
                                        "reference": "restic:legacy-1",
                                        "snapshot_id": "legacy-1",
                                        "resource_id": "*",
                                        "content_generation": "*",
                                        "copy_created_at": "2026-08-01T00:00:00Z",
                                        "content_classes": [
                                            "message",
                                            "session_credential",
                                            "account_key",
                                        ],
                                    }
                                ],
                            }
                        },
                    }
                ),
                encoding="utf-8",
            )
            migration_manifest = root / "migration.json"
            migration_manifest.write_text(
                json.dumps(
                    {
                        "version": 1,
                        "snapshots": {
                            "legacy-1": {
                                "complete": True,
                                "restored_prefix": "snapshot-root",
                                "entries": [
                                    {
                                        "path": "messages/removed.json",
                                        "content_class": "message",
                                        "resource_id": "message_one",
                                        "content_generation": "generation_one",
                                    },
                                    {
                                        "path": "messages/retained.json",
                                        "content_class": "message",
                                        "resource_id": "message_two",
                                        "content_generation": "generation_two",
                                    },
                                    {
                                        "path": "secrets/session.key",
                                        "content_class": "session_credential",
                                        "resource_id": "*",
                                        "content_generation": "*",
                                    },
                                    {
                                        "path": "secrets/account.key",
                                        "content_class": "account_key",
                                        "resource_id": "*",
                                        "content_generation": "*",
                                    },
                                ],
                            }
                        }
                    }
                ),
                encoding="utf-8",
            )
            invocations = root / "restic-invocations.jsonl"
            fake_restic = root / "restic"
            fake_restic.write_text(
                "#!/usr/bin/env python3\n"
                "import json\n"
                "import pathlib\n"
                "import sys\n"
                f"log = pathlib.Path({str(invocations)!r})\n"
                "command = sys.argv[1]\n"
                "if command == 'restore':\n"
                "    target = pathlib.Path(sys.argv[sys.argv.index('--target') + 1])\n"
                "    base = target / 'snapshot-root'\n"
                "    for name, value in {\n"
                "        'messages/removed.json': 'removed',\n"
                "        'messages/retained.json': 'retained',\n"
                "        'secrets/session.key': 'session',\n"
                "        'secrets/account.key': 'account',\n"
                "    }.items():\n"
                "        path = base / name\n"
                "        path.parent.mkdir(parents=True, exist_ok=True)\n"
                "        path.write_text(value)\n"
                "elif command == 'backup':\n"
                "    tag = sys.argv[sys.argv.index('--tag') + 1]\n"
                "    source = pathlib.Path(sys.argv[-1])\n"
                "    files = sorted(str(path.relative_to(source)) for path in source.rglob('*') if path.is_file())\n"
                "    with log.open('a', encoding='utf-8') as output:\n"
                "        output.write(json.dumps({'command': 'backup', 'tag': tag, 'files': files}) + '\\n')\n"
                "    print(json.dumps({'message_type': 'summary', 'snapshot_id': 'new-' + tag}))\n"
                "elif command == 'forget':\n"
                "    with log.open('a', encoding='utf-8') as output:\n"
                "        output.write(json.dumps({'command': 'forget', 'snapshot': sys.argv[2]}) + '\\n')\n",
                encoding="utf-8",
            )
            fake_restic.chmod(0o700)
            with patch.dict(
                os.environ,
                {
                    "COMMUNICATOR_RETENTION_MANIFEST": str(manifest),
                    "COMMUNICATOR_RETENTION_RESTIC_MIGRATION_MANIFEST": str(migration_manifest),
                    "COMMUNICATOR_RETENTION_RESTIC_BIN": str(fake_restic),
                    "RESTIC_REPOSITORY": "repo",
                    "RESTIC_PASSWORD_FILE": str(root / "password"),
                },
                clear=False,
            ):
                evidence = RETENTION.process_request(
                    "cleanup",
                    {
                        "protocol": RETENTION.PROTOCOL,
                        "store": "restic_snapshot",
                        "resource_id": "message_one",
                        "content_generation": "generation_one",
                        "reference": "restic:legacy-1",
                    },
                )

            self.assertEqual("aged_out", evidence["status"], evidence)
            self.assertFalse(evidence["content_present"])
            invocations = [
                json.loads(line)
                for line in invocations.read_text(encoding="utf-8").splitlines()
            ]
            self.assertEqual("forget", invocations[-1]["command"])
            self.assertEqual("legacy-1", invocations[-1]["snapshot"])
            message_backup = next(
                item
                for item in invocations
                if item.get("tag") == "communicator-message-migrated"
            )
            self.assertEqual(["messages/retained.json"], message_backup["files"])
            self.assertTrue(
                any(item.get("tag") == "communicator-session_credentials-migrated" for item in invocations)
            )
            migrated = json.loads(manifest.read_text(encoding="utf-8"))
            restic_copies = migrated["stores"]["restic_snapshot"]["copies"]
            self.assertNotIn("restic:legacy-1", {item["reference"] for item in restic_copies})
            self.assertIn("message_two", {item["resource_id"] for item in restic_copies})
            self.assertIn(
                "restic:new-communicator-session_credentials-migrated",
                {
                    item["reference"]
                    for item in migrated["stores"]["session_credentials"]["copies"]
                },
            )

    def test_mixed_restic_snapshot_rejects_files_outside_declared_prefix(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            manifest = root / "manifest.json"
            manifest.write_text(
                json.dumps(
                    {
                        "version": 1,
                        "stores": {
                            "restic_snapshot": {
                                "enumeration_complete": True,
                                "copies": [
                                    {
                                        "reference": "restic:legacy-outside",
                                        "snapshot_id": "legacy-outside",
                                        "resource_id": "*",
                                        "content_generation": "*",
                                        "copy_created_at": "2026-08-01T00:00:00Z",
                                        "content_classes": [
                                            "message",
                                            "session_credential",
                                            "account_key",
                                        ],
                                    }
                                ],
                            }
                        },
                    }
                ),
                encoding="utf-8",
            )
            migration_manifest = root / "migration.json"
            migration_manifest.write_text(
                json.dumps(
                    {
                        "version": 1,
                        "snapshots": {
                            "legacy-outside": {
                                "complete": True,
                                "restored_prefix": "snapshot-root",
                                "entries": [
                                    {
                                        "path": "messages/removed.json",
                                        "content_class": "message",
                                        "resource_id": "message_one",
                                        "content_generation": "generation_one",
                                    },
                                    {
                                        "path": "messages/retained.json",
                                        "content_class": "message",
                                        "resource_id": "message_two",
                                        "content_generation": "generation_two",
                                    },
                                    {
                                        "path": "secrets/session.key",
                                        "content_class": "session_credential",
                                        "resource_id": "*",
                                        "content_generation": "*",
                                    },
                                ],
                            }
                        },
                    }
                ),
                encoding="utf-8",
            )
            invocations = root / "invocations.jsonl"
            fake_restic = root / "restic"
            fake_restic.write_text(
                "#!/usr/bin/env python3\n"
                "import pathlib, sys\n"
                f"log = pathlib.Path({str(invocations)!r})\n"
                "command = sys.argv[1]\n"
                "if command == 'restore':\n"
                "    target = pathlib.Path(sys.argv[sys.argv.index('--target') + 1])\n"
                "    base = target / 'snapshot-root'\n"
                "    for name in ('messages/removed.json', 'messages/retained.json', 'secrets/session.key'):\n"
                "        path = base / name\n"
                "        path.parent.mkdir(parents=True, exist_ok=True)\n"
                "        path.write_text(name)\n"
                "    (target / 'outside.txt').write_text('unexpected')\n"
                "elif command == 'backup':\n"
                "    print('{\"message_type\":\"summary\",\"snapshot_id\":\"should-not-exist\"}')\n"
                "elif command == 'forget':\n"
                "    log.write_text('forget\\n')\n",
                encoding="utf-8",
            )
            fake_restic.chmod(0o700)
            password = root / "password"
            password.write_text("fixture-password", encoding="utf-8")
            with patch.dict(
                os.environ,
                {
                    "COMMUNICATOR_RETENTION_MANIFEST": str(manifest),
                    "COMMUNICATOR_RETENTION_RESTIC_MIGRATION_MANIFEST": str(migration_manifest),
                    "COMMUNICATOR_RETENTION_RESTIC_BIN": str(fake_restic),
                    "RESTIC_REPOSITORY": "fixture-repository",
                    "RESTIC_PASSWORD_FILE": str(password),
                },
                clear=False,
            ):
                evidence = RETENTION.process_request(
                    "cleanup",
                    {
                        "protocol": RETENTION.PROTOCOL,
                        "store": "restic_snapshot",
                        "resource_id": "message_one",
                        "content_generation": "generation_one",
                        "reference": "restic:legacy-outside",
                    },
                )
            self.assertEqual("lifecycle_pending", evidence["status"])
            self.assertTrue(evidence["content_present"])
            self.assertIn("enumerate", evidence["detail"])
            self.assertFalse(invocations.exists())

    @unittest.skipUnless(PG_BIN.exists(), "the controlled PostgreSQL fixture is unavailable")
    def test_core_pgdump_migration_rewrites_real_custom_dump_and_preserves_keys(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            pg_root = root / "fixture-pg"
            socket_dir = Path("/tmp")
            port = _free_port()
            subprocess.run(
                [
                    str(PG_BIN / "initdb"),
                    "--no-locale",
                    "--encoding=UTF8",
                    "--username",
                    "fixture",
                    str(pg_root / "data"),
                ],
                check=True,
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
            subprocess.run(
                [
                    str(PG_BIN / "pg_ctl"),
                    "--pgdata",
                    str(pg_root / "data"),
                    "--log",
                    str(pg_root / "postgres.log"),
                    "--wait",
                    "start",
                    "--options",
                    f"-F -p {port} -k {socket_dir} -c listen_addresses=''",
                ],
                check=True,
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
            try:
                for database in ("source",):
                    subprocess.run(
                        [
                            str(PG_BIN / "createdb"),
                            "--host",
                            str(socket_dir),
                            "--port",
                            str(port),
                            "--username",
                            "fixture",
                            database,
                        ],
                        check=True,
                        capture_output=True,
                        text=True,
                    )
                _pg_client(
                    socket_dir,
                    port,
                    "source",
                    """
                    CREATE TABLE events (
                      room_id TEXT NOT NULL,
                      event_id TEXT NOT NULL,
                      type TEXT NOT NULL,
                      PRIMARY KEY (room_id, event_id)
                    );
                    CREATE TABLE event_json (
                      room_id TEXT NOT NULL,
                      event_id TEXT NOT NULL,
                      json JSONB NOT NULL,
                      PRIMARY KEY (room_id, event_id)
                    );
                    CREATE TABLE credentials (id TEXT PRIMARY KEY, secret TEXT NOT NULL);
                    CREATE TABLE account_keys (id TEXT PRIMARY KEY, key_material TEXT NOT NULL);
                    CREATE TABLE message (
                      bridge_id TEXT NOT NULL,
                      id TEXT NOT NULL,
                      part_id TEXT NOT NULL,
                      body TEXT NOT NULL,
                      PRIMARY KEY (bridge_id, id, part_id)
                    );
                    CREATE TABLE reaction (
                      bridge_id TEXT NOT NULL,
                      message_id TEXT NOT NULL,
                      message_part_id TEXT NOT NULL,
                      emoji TEXT NOT NULL
                    );
                    INSERT INTO events VALUES
                      ('!room:example.test', '$target:example.test', 'm.room.message'),
                      ('!room:example.test', '$retained:example.test', 'm.room.message');
                    INSERT INTO event_json VALUES
                      ('!room:example.test', '$target:example.test', '{"event_id":"$target:example.test","room_id":"!room:example.test","type":"m.room.message","content":{"body":"remove me","msgtype":"m.text"}}'),
                      ('!room:example.test', '$retained:example.test', '{"event_id":"$retained:example.test","room_id":"!room:example.test","type":"m.room.message","content":{"body":"keep me","msgtype":"m.text"}}');
                    INSERT INTO credentials VALUES ('session-1', 'session-secret');
                    INSERT INTO account_keys VALUES ('account-1', 'account-key');
                    INSERT INTO message VALUES
                      ('whatsapp', 'remote-target', 'part-1', 'remove bridge content'),
                      ('whatsapp', 'remote-retained', 'part-1', 'keep bridge content');
                    INSERT INTO reaction VALUES
                      ('whatsapp', 'remote-target', 'part-1', '👍'),
                      ('whatsapp', 'remote-retained', 'part-1', '✅');
                    """,
                )
                fixture = root / "snapshot-root"
                (fixture / "retention").mkdir(parents=True)
                (fixture / "synapse-data/media_store").mkdir(parents=True)
                (fixture / "secrets").mkdir()
                (fixture / "retention/controlled-copy-manifest.json").write_text(
                    json.dumps({"version": 1, "stores": {}}), encoding="utf-8"
                )
                (fixture / "synapse-data/media_store/target.bin").write_bytes(b"remove")
                (fixture / "synapse-data/media_store/retained.bin").write_bytes(b"keep")
                (fixture / "secrets/account.key").write_text("account-key", encoding="utf-8")
                for database_name, dump_name in (
                    ("synapse", "synapse.pgdump"),
                    ("whatsapp_bridge", "whatsapp.pgdump"),
                    ("messenger_bridge", "messenger.pgdump"),
                    ("telegram_bridge", "telegram.pgdump"),
                ):
                    subprocess.run(
                        [
                            str(PG_BIN / "pg_dump"),
                            "--format=custom",
                            "--no-owner",
                            "--no-acl",
                            "--host",
                            str(socket_dir),
                            "--port",
                            str(port),
                            "--username",
                            "fixture",
                            "--dbname",
                            "source",
                            "--file",
                            str(fixture / dump_name),
                        ],
                        check=True,
                        capture_output=True,
                        text=True,
                    )
                subprocess.run(
                    ["python3", str(ROOT / "scripts/write-controlled-copy-layout.py"), str(fixture)],
                    check=True,
                )
            finally:
                subprocess.run(
                    [
                        str(PG_BIN / "pg_ctl"),
                        "--pgdata",
                        str(pg_root / "data"),
                        "--wait",
                        "stop",
                        "--mode",
                        "fast",
                    ],
                    check=True,
                    stdin=subprocess.DEVNULL,
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                )

            manifest = root / "manifest.json"
            manifest.write_text(
                json.dumps(
                    {
                        "version": 1,
                        "stores": {
                            "restic_snapshot": {
                                "enumeration_complete": True,
                                "copies": [
                                    {
                                        "reference": "restic:legacy-core",
                                        "snapshot_id": "legacy-core",
                                        "resource_id": "*",
                                        "content_generation": "*",
                                        "copy_created_at": "2026-08-01T00:00:00Z",
                                        "content_classes": [
                                            "message",
                                            "session_credential",
                                            "account_key",
                                        ],
                                    }
                                ],
                            }
                        },
                    }
                ),
                encoding="utf-8",
            )
            migration_manifest = root / "migration.json"
            migration_manifest.write_text(
                json.dumps(
                    {
                        "version": 1,
                        "snapshots": {
                            "legacy-core": {
                                "complete": True,
                                "format": "communicator-core-pgdump-v1",
                                "restored_prefix": "snapshot-root",
                                "targets": [
                                    {
                                        "resource_id": "message_one",
                                        "content_generation": "generation_one",
                                        "database": "synapse",
                                        "contract": "synapse-event-json-v1",
                                        "room_id": "!room:example.test",
                                        "event_id": "$target:example.test",
                                        "event_type": "m.room.message",
                                        "media_paths": [
                                            "synapse-data/media_store/target.bin"
                                        ],
                                        "media_paths_complete": True,
                                    },
                                    {
                                        "resource_id": "message_one",
                                        "content_generation": "generation_one",
                                        "database": "whatsapp_bridge",
                                        "contract": "mautrix-bridge-message-v1",
                                        "bridge_id": "whatsapp",
                                        "message_id": "remote-target",
                                        "part_id": "part-1",
                                        "media_paths": [],
                                        "media_paths_complete": True,
                                    }
                                ],
                            }
                        },
                    }
                ),
                encoding="utf-8",
            )
            replacements = root / "replacements"
            invocations = root / "restic-invocations.jsonl"
            state = root / "restic-state.json"
            state.write_text(
                json.dumps(
                    {
                        "snapshots": [
                            {"id": "legacy-core", "tags": ["communicator-core"]}
                        ]
                    }
                ),
                encoding="utf-8",
            )
            fake_restic = root / "restic"
            fake_restic.write_text(
                "#!/usr/bin/env python3\n"
                "import json, pathlib, shutil, sys\n"
                f"fixture = pathlib.Path({str(fixture)!r})\n"
                f"replacements = pathlib.Path({str(replacements)!r})\n"
                f"invocations = pathlib.Path({str(invocations)!r})\n"
                f"state_path = pathlib.Path({str(state)!r})\n"
                "state = json.loads(state_path.read_text())\n"
                "command = sys.argv[1]\n"
                "if command == 'restore':\n"
                "    target = pathlib.Path(sys.argv[sys.argv.index('--target') + 1])\n"
                "    shutil.copytree(fixture, target / 'snapshot-root')\n"
                "elif command == 'backup':\n"
                "    tag = sys.argv[sys.argv.index('--tag') + 1]\n"
                "    source = pathlib.Path(sys.argv[-1])\n"
                "    snapshot = 'replacement-core'\n"
                "    shutil.copytree(source, replacements / snapshot, dirs_exist_ok=True)\n"
                "    state['snapshots'].append({'id': snapshot, 'tags': [tag]})\n"
                "    state_path.write_text(json.dumps(state))\n"
                "    invocations.open('a').write(json.dumps({'command':'backup','tag':tag})+'\\n')\n"
                "    print(json.dumps({'message_type':'summary','snapshot_id':snapshot}))\n"
                "elif command == 'snapshots':\n"
                "    print(json.dumps(state['snapshots']))\n"
                "elif command == 'forget':\n"
                "    snapshot = sys.argv[2]\n"
                "    state['snapshots'] = [item for item in state['snapshots'] if item['id'] != snapshot]\n"
                "    state_path.write_text(json.dumps(state))\n"
                "    invocations.open('a').write(json.dumps({'command':'forget','snapshot':snapshot})+'\\n')\n",
                encoding="utf-8",
            )
            fake_restic.chmod(0o700)
            password = root / "password"
            password.write_text("fixture-password", encoding="utf-8")
            with patch.dict(
                os.environ,
                {
                    "COMMUNICATOR_RETENTION_MANIFEST": str(manifest),
                    "COMMUNICATOR_RETENTION_RESTIC_MIGRATION_MANIFEST": str(migration_manifest),
                    "COMMUNICATOR_RETENTION_RESTIC_BIN": str(fake_restic),
                    "RESTIC_REPOSITORY": "fixture-repository",
                    "RESTIC_PASSWORD_FILE": str(password),
                },
                clear=False,
            ):
                evidence = RETENTION.process_request(
                    "cleanup",
                    {
                        "protocol": RETENTION.PROTOCOL,
                        "store": "restic_snapshot",
                        "resource_id": "message_one",
                        "content_generation": "generation_one",
                        "reference": "restic:legacy-core",
                    },
                )

            self.assertEqual("aged_out", evidence["status"], evidence)
            self.assertFalse(evidence["content_present"])
            replacement = replacements / "replacement-core"
            self.assertFalse((replacement / "synapse-data/media_store/target.bin").exists())
            self.assertTrue((replacement / "synapse-data/media_store/retained.bin").exists())
            self.assertTrue((replacement / "secrets/account.key").exists())
            invocations_seen = [
                json.loads(line)
                for line in invocations.read_text(encoding="utf-8").splitlines()
            ]
            self.assertEqual("backup", invocations_seen[0]["command"])
            self.assertEqual("forget", invocations_seen[-1]["command"])
            self.assertEqual("legacy-core", invocations_seen[-1]["snapshot"])
            replacement_manifest = json.loads(manifest.read_text(encoding="utf-8"))
            copies = replacement_manifest["stores"]["restic_snapshot"]["copies"]
            self.assertNotIn("restic:legacy-core", {copy["reference"] for copy in copies})
            self.assertIn("restic:replacement-core", {copy["reference"] for copy in copies})

            verify_root = root / "verify-pg"
            verify_socket = Path("/tmp")
            verify_port = _free_port()
            subprocess.run(
                [
                    str(PG_BIN / "initdb"),
                    "--no-locale",
                    "--encoding=UTF8",
                    "--username",
                    "fixture",
                    str(verify_root / "data"),
                ],
                check=True,
                capture_output=True,
                text=True,
            )
            subprocess.run(
                [
                    str(PG_BIN / "pg_ctl"),
                    "--pgdata",
                    str(verify_root / "data"),
                    "--log",
                    str(verify_root / "postgres.log"),
                    "--wait",
                    "start",
                    "--options",
                    f"-F -p {verify_port} -k {verify_socket} -c listen_addresses=''",
                ],
                check=True,
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
            try:
                subprocess.run(
                    [
                        str(PG_BIN / "createdb"),
                        "--host",
                        str(verify_socket),
                        "--port",
                        str(verify_port),
                        "--username",
                        "fixture",
                        "synapse",
                    ],
                    check=True,
                    capture_output=True,
                    text=True,
                )
                subprocess.run(
                    [
                        str(PG_BIN / "pg_restore"),
                        "--exit-on-error",
                        "--no-owner",
                        "--no-acl",
                        "--host",
                        str(verify_socket),
                        "--port",
                        str(verify_port),
                        "--username",
                        "fixture",
                        "--dbname",
                        "synapse",
                        str(replacement / "synapse.pgdump"),
                    ],
                    check=True,
                    capture_output=True,
                    text=True,
                )
                target_content = _pg_client(
                    verify_socket,
                    verify_port,
                    "synapse",
                    "SELECT json->'content'->>'body' FROM event_json WHERE event_id='$target:example.test'",
                )
                retained_content = _pg_client(
                    verify_socket,
                    verify_port,
                    "synapse",
                    "SELECT json->'content'->>'body' FROM event_json WHERE event_id='$retained:example.test'",
                )
                credentials = _pg_client(
                    verify_socket,
                    verify_port,
                    "synapse",
                    "SELECT secret FROM credentials WHERE id='session-1'",
                )
                keys = _pg_client(
                    verify_socket,
                    verify_port,
                    "synapse",
                    "SELECT key_material FROM account_keys WHERE id='account-1'",
                )
                subprocess.run(
                    [
                        str(PG_BIN / "createdb"),
                        "--host",
                        str(verify_socket),
                        "--port",
                        str(verify_port),
                        "--username",
                        "fixture",
                        "bridge",
                    ],
                    check=True,
                    capture_output=True,
                    text=True,
                )
                subprocess.run(
                    [
                        str(PG_BIN / "pg_restore"),
                        "--exit-on-error",
                        "--no-owner",
                        "--no-acl",
                        "--host",
                        str(verify_socket),
                        "--port",
                        str(verify_port),
                        "--username",
                        "fixture",
                        "--dbname",
                        "bridge",
                        str(replacement / "whatsapp.pgdump"),
                    ],
                    check=True,
                    capture_output=True,
                    text=True,
                )
                bridge_target = _pg_client(
                    verify_socket,
                    verify_port,
                    "bridge",
                    "SELECT count(*) FROM message WHERE bridge_id='whatsapp' AND id='remote-target' AND part_id='part-1'",
                )
                bridge_retained = _pg_client(
                    verify_socket,
                    verify_port,
                    "bridge",
                    "SELECT body FROM message WHERE bridge_id='whatsapp' AND id='remote-retained' AND part_id='part-1'",
                )
                target_reactions = _pg_client(
                    verify_socket,
                    verify_port,
                    "bridge",
                    "SELECT count(*) FROM reaction WHERE bridge_id='whatsapp' AND message_id='remote-target' AND message_part_id='part-1'",
                )
                retained_reactions = _pg_client(
                    verify_socket,
                    verify_port,
                    "bridge",
                    "SELECT count(*) FROM reaction WHERE bridge_id='whatsapp' AND message_id='remote-retained' AND message_part_id='part-1'",
                )
            finally:
                subprocess.run(
                    [
                        str(PG_BIN / "pg_ctl"),
                        "--pgdata",
                        str(verify_root / "data"),
                        "--wait",
                        "stop",
                        "--mode",
                        "fast",
                    ],
                    check=True,
                    stdin=subprocess.DEVNULL,
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                )
            self.assertEqual("", target_content)
            self.assertEqual("keep me", retained_content)
            self.assertEqual("session-secret", credentials)
            self.assertEqual("account-key", keys)
            self.assertEqual("0", bridge_target)
            self.assertEqual("keep bridge content", bridge_retained)
            self.assertEqual("0", target_reactions)
            self.assertEqual("1", retained_reactions)

    @unittest.skipUnless(PG_BIN.exists(), "the controlled PostgreSQL fixture is unavailable")
    def test_legacy_core_pgdump_without_layout_is_sanitized_and_gets_a_replacement_layout(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            fixture = root / "snapshot-root"
            _write_legacy_core_tree(fixture)
            (fixture / "synapse-data/media_store/target.bin").write_bytes(b"remove")
            (fixture / "synapse-data/media_store/retained.bin").write_bytes(b"keep")
            self.assertFalse((fixture / "retention/controlled-copy-manifest.json").exists())
            self.assertFalse((fixture / "retention/controlled-copy-layout.json").exists())
            (fixture / "secrets/synapse_registration_shared_secret").write_text(
                "session-secret", encoding="utf-8"
            )
            (fixture / "secrets/postgres.env").write_text(
                "POSTGRES_PASSWORD=preserve", encoding="utf-8"
            )

            with RETENTION.IsolatedPostgres(root / "source-pg") as postgres:
                postgres.create_database("source")
                postgres.execute(
                    "source",
                    """
                    CREATE TABLE events (
                      room_id TEXT NOT NULL,
                      event_id TEXT NOT NULL,
                      type TEXT NOT NULL,
                      PRIMARY KEY (room_id, event_id)
                    );
                    CREATE TABLE event_json (
                      room_id TEXT NOT NULL,
                      event_id TEXT NOT NULL,
                      json JSONB NOT NULL,
                      PRIMARY KEY (room_id, event_id)
                    );
                    CREATE TABLE credentials (id TEXT PRIMARY KEY, secret TEXT NOT NULL);
                    INSERT INTO events VALUES
                      ('!legacy:example.test', '$legacy-target:example.test', 'm.room.message'),
                      ('!legacy:example.test', '$legacy-retained:example.test', 'm.room.message');
                    INSERT INTO event_json VALUES
                      ('!legacy:example.test', '$legacy-target:example.test', '{"event_id":"$legacy-target:example.test","room_id":"!legacy:example.test","type":"m.room.message","content":{"body":"remove legacy"}}'),
                      ('!legacy:example.test', '$legacy-retained:example.test', '{"event_id":"$legacy-retained:example.test","room_id":"!legacy:example.test","type":"m.room.message","content":{"body":"keep legacy"}}');
                    INSERT INTO credentials VALUES ('session-legacy', 'credential-preserved');
                    """,
                )
                for dump_path in RETENTION.CORE_DATABASE_DUMP_PATHS.values():
                    postgres.dump("source", fixture / dump_path)

            manifest = root / "manifest.json"
            manifest.write_text(
                json.dumps(
                    {
                        "version": 1,
                        "stores": {
                            "restic_snapshot": {
                                "enumeration_complete": True,
                                "copies": [
                                    {
                                        "reference": "restic:legacy-v0",
                                        "snapshot_id": "legacy-v0",
                                        "resource_id": "*",
                                        "content_generation": "*",
                                        "copy_created_at": "2026-08-01T00:00:00Z",
                                        "content_classes": [
                                            "message",
                                            "session_credential",
                                            "account_key",
                                        ],
                                    }
                                ],
                            }
                        },
                    }
                ),
                encoding="utf-8",
            )
            migration_manifest = root / "migration.json"
            migration_manifest.write_text(
                json.dumps(
                    {
                        "version": 1,
                        "snapshots": {
                            "legacy-v0": {
                                "complete": True,
                                "format": RETENTION.LEGACY_CORE_BACKUP_FORMAT,
                                "restored_prefix": "snapshot-root",
                                "targets": [
                                    {
                                        "resource_id": "message_one",
                                        "content_generation": "generation_one",
                                        "database": "synapse",
                                        "contract": "synapse-event-json-v1",
                                        "room_id": "!legacy:example.test",
                                        "event_id": "$legacy-target:example.test",
                                        "event_type": "m.room.message",
                                        "media_paths": [
                                            "synapse-data/media_store/target.bin"
                                        ],
                                        "media_paths_complete": True,
                                    }
                                ],
                            }
                        },
                    }
                ),
                encoding="utf-8",
            )
            replacements = root / "replacements"
            invocations = root / "invocations.jsonl"
            state = root / "restic-state.json"
            state.write_text(
                json.dumps({"snapshots": [{"id": "legacy-v0", "tags": ["communicator-core"]}]}),
                encoding="utf-8",
            )
            fake_restic = root / "restic"
            fake_restic.write_text(
                "#!/usr/bin/env python3\n"
                "import json, pathlib, shutil, sys\n"
                f"fixture = pathlib.Path({str(fixture)!r})\n"
                f"replacements = pathlib.Path({str(replacements)!r})\n"
                f"invocations = pathlib.Path({str(invocations)!r})\n"
                f"state_path = pathlib.Path({str(state)!r})\n"
                "state = json.loads(state_path.read_text())\n"
                "command = sys.argv[1]\n"
                "if command == 'restore':\n"
                "    target = pathlib.Path(sys.argv[sys.argv.index('--target') + 1])\n"
                "    shutil.copytree(fixture, target / 'snapshot-root')\n"
                "elif command == 'backup':\n"
                "    source = pathlib.Path(sys.argv[-1])\n"
                "    replacement = 'replacement-v0'\n"
                "    shutil.copytree(source, replacements / replacement, dirs_exist_ok=True)\n"
                "    state['snapshots'].append({'id': replacement, 'tags': ['communicator-core-migrated']})\n"
                "    state_path.write_text(json.dumps(state))\n"
                "    invocations.open('a').write(json.dumps({'command': 'backup'}) + '\\n')\n"
                "    print(json.dumps({'message_type': 'summary', 'snapshot_id': replacement}))\n"
                "elif command == 'snapshots':\n"
                "    print(json.dumps(state['snapshots']))\n"
                "elif command == 'forget':\n"
                "    state['snapshots'] = [item for item in state['snapshots'] if item['id'] != sys.argv[2]]\n"
                "    state_path.write_text(json.dumps(state))\n"
                "    invocations.open('a').write(json.dumps({'command': 'forget', 'snapshot': sys.argv[2]}) + '\\n')\n",
                encoding="utf-8",
            )
            fake_restic.chmod(0o700)
            password = root / "password"
            password.write_text("fixture-password", encoding="utf-8")
            with patch.dict(
                os.environ,
                {
                    "COMMUNICATOR_RETENTION_MANIFEST": str(manifest),
                    "COMMUNICATOR_RETENTION_RESTIC_MIGRATION_MANIFEST": str(migration_manifest),
                    "COMMUNICATOR_RETENTION_RESTIC_BIN": str(fake_restic),
                    "RESTIC_REPOSITORY": "fixture-repository",
                    "RESTIC_PASSWORD_FILE": str(password),
                },
                clear=False,
            ):
                evidence = RETENTION.process_request(
                    "cleanup",
                    {
                        "protocol": RETENTION.PROTOCOL,
                        "store": "restic_snapshot",
                        "resource_id": "message_one",
                        "content_generation": "generation_one",
                        "reference": "restic:legacy-v0",
                    },
                )

            self.assertEqual("aged_out", evidence["status"], evidence)
            replacement = replacements / "replacement-v0"
            self.assertFalse((replacement / "synapse-data/media_store/target.bin").exists())
            self.assertTrue((replacement / "synapse-data/media_store/retained.bin").exists())
            self.assertEqual(
                "session-secret",
                (replacement / "secrets/synapse_registration_shared_secret").read_text(
                    encoding="utf-8"
                ),
            )
            layout = json.loads(
                (replacement / "retention/controlled-copy-layout.json").read_text(
                    encoding="utf-8"
                )
            )
            self.assertEqual("communicator-core-pgdump-v1", layout["format"])
            calls = [json.loads(line) for line in invocations.read_text().splitlines()]
            self.assertEqual(["backup", "forget"], [call["command"] for call in calls])

            with RETENTION.IsolatedPostgres(root / "verify-pg") as postgres:
                postgres.create_database("verify")
                postgres.restore("verify", replacement / "synapse.pgdump")
                self.assertEqual(
                    "",
                    postgres.query(
                        "verify",
                        "SELECT json->'content'->>'body' FROM event_json WHERE event_id='$legacy-target:example.test'",
                    ),
                )
                self.assertEqual(
                    "keep legacy",
                    postgres.query(
                        "verify",
                        "SELECT json->'content'->>'body' FROM event_json WHERE event_id='$legacy-retained:example.test'",
                    ),
                )
                self.assertEqual(
                    "credential-preserved",
                    postgres.query(
                        "verify",
                        "SELECT secret FROM credentials WHERE id='session-legacy'",
                    ),
                )

    def test_legacy_core_pgdump_rejects_an_unexpected_file_before_database_rewrite(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            fixture = root / "snapshot-root"
            _write_legacy_core_tree(fixture)
            self.assertFalse((fixture / "retention/controlled-copy-manifest.json").exists())
            self.assertFalse((fixture / "retention/controlled-copy-layout.json").exists())
            migration_manifest = root / "migration.json"
            migration_manifest.write_text(
                json.dumps(
                    {
                        "version": 1,
                        "snapshots": {
                            "legacy-unexpected": {
                                "complete": True,
                                "format": RETENTION.LEGACY_CORE_BACKUP_FORMAT,
                                "restored_prefix": "snapshot-root",
                                "targets": [
                                    {
                                        "resource_id": "message_one",
                                        "content_generation": "generation_one",
                                        "database": "synapse",
                                        "contract": "synapse-event-json-v1",
                                        "room_id": "!legacy:example.test",
                                        "event_id": "$legacy-target:example.test",
                                        "event_type": "m.room.message",
                                        "media_paths": [],
                                        "media_paths_complete": True,
                                    }
                                ],
                            }
                        },
                    }
                ),
                encoding="utf-8",
            )
            manifest = root / "manifest.json"
            manifest.write_text(
                json.dumps(
                    {
                        "version": 1,
                        "stores": {
                            "restic_snapshot": {
                                "enumeration_complete": True,
                                "copies": [
                                    {
                                        "reference": "restic:legacy-unexpected",
                                        "snapshot_id": "legacy-unexpected",
                                        "resource_id": "*",
                                        "content_generation": "*",
                                        "copy_created_at": "2026-08-01T00:00:00Z",
                                        "content_classes": [
                                            "message",
                                            "session_credential",
                                            "account_key",
                                        ],
                                    }
                                ],
                            }
                        },
                    }
                ),
                encoding="utf-8",
            )
            invocations = root / "invocations.jsonl"
            fake_restic = root / "restic"
            fake_restic.write_text(
                "#!/usr/bin/env python3\n"
                "import pathlib, shutil, sys\n"
                f"fixture = pathlib.Path({str(fixture)!r})\n"
                f"invocations = pathlib.Path({str(invocations)!r})\n"
                "command = sys.argv[1]\n"
                "if command == 'restore':\n"
                "    target = pathlib.Path(sys.argv[sys.argv.index('--target') + 1])\n"
                "    shutil.copytree(fixture, target / 'snapshot-root')\n"
                "    (target / 'unexpected.txt').write_text('outside-prefix')\n"
                "elif command == 'backup':\n"
                "    invocations.write_text('backup\\n')\n"
                "    print('{\"message_type\":\"summary\",\"snapshot_id\":\"should-not-exist\"}')\n"
                "elif command == 'forget':\n"
                "    invocations.write_text('forget\\n')\n",
                encoding="utf-8",
            )
            fake_restic.chmod(0o700)
            password = root / "password"
            password.write_text("fixture-password", encoding="utf-8")
            with patch.dict(
                os.environ,
                {
                    "COMMUNICATOR_RETENTION_MANIFEST": str(manifest),
                    "COMMUNICATOR_RETENTION_RESTIC_MIGRATION_MANIFEST": str(migration_manifest),
                    "COMMUNICATOR_RETENTION_RESTIC_BIN": str(fake_restic),
                    "RESTIC_REPOSITORY": "fixture-repository",
                    "RESTIC_PASSWORD_FILE": str(password),
                },
                clear=False,
            ):
                evidence = RETENTION.process_request(
                    "cleanup",
                    {
                        "protocol": RETENTION.PROTOCOL,
                        "store": "restic_snapshot",
                        "resource_id": "message_one",
                        "content_generation": "generation_one",
                        "reference": "restic:legacy-unexpected",
                    },
                )

            self.assertEqual("lifecycle_pending", evidence["status"])
            self.assertTrue(evidence["content_present"])
            self.assertIn("enumerate", evidence["detail"])
            self.assertFalse(invocations.exists())

    def test_cloudflare_queue_peek_and_purge_only_use_the_exact_lineage_reference(self):
        seen: list[tuple[str, dict]] = []

        class QueueHandler(BaseHTTPRequestHandler):
            def log_message(self, _format, *_args):
                return

            def do_POST(self):  # noqa: N802 - stdlib handler API
                length = int(self.headers.get("content-length", "0"))
                body = json.loads(self.rfile.read(length))
                seen.append((self.path, body))
                if self.path.endswith("/messages/peek"):
                    value = {
                        "success": True,
                        "result": {
                            "messages": [
                                {
                                    "ref": "opaque-ref-1",
                                    "body": json.dumps(
                                        {
                                            "resource_id": "message_one",
                                            "content_generation": "generation_one",
                                        }
                                    ),
                                    "timestamp_ms": 1_788_192_000_000,
                                }
                            ]
                        },
                    }
                else:
                    value = {
                        "success": True,
                        "result": {"errors": [], "warnings": {}},
                    }
                encoded = json.dumps(value).encode()
                self.send_response(200)
                self.send_header("content-type", "application/json")
                self.send_header("content-length", str(len(encoded)))
                self.end_headers()
                self.wfile.write(encoded)

        with tempfile.TemporaryDirectory() as directory:
            manifest = Path(directory) / "manifest.json"
            manifest.write_text(json.dumps({"version": 1, "stores": {}}), encoding="utf-8")
            server = ThreadingHTTPServer(("127.0.0.1", 0), QueueHandler)
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            try:
                with patch.dict(
                    os.environ,
                    {
                        "COMMUNICATOR_RETENTION_MANIFEST": str(manifest),
                        "COMMUNICATOR_RETENTION_QUEUE_API_URL": f"http://127.0.0.1:{server.server_port}",
                        "COMMUNICATOR_RETENTION_QUEUE_ACCOUNT_ID": "account-one",
                        "COMMUNICATOR_RETENTION_QUEUE_ID": "queue-one",
                        "COMMUNICATOR_RETENTION_QUEUE_API_TOKEN": "queue-api-token",
                    },
                    clear=False,
                ):
                    inventory = RETENTION.process_request(
                        "inventory",
                        {
                            "protocol": RETENTION.PROTOCOL,
                            "store": "queue",
                            "scope": {
                                "resource_id": "message_one",
                                "content_generation": "generation_one",
                            },
                        },
                    )
                    evidence = RETENTION.process_request(
                        "cleanup",
                        {
                            "protocol": RETENTION.PROTOCOL,
                            "store": "queue",
                            "resource_id": "message_one",
                            "content_generation": "generation_one",
                            "reference": "cloudflare-queue:opaque-ref-1",
                        },
                    )
            finally:
                server.shutdown()
                server.server_close()
                thread.join(timeout=2)

            self.assertTrue(inventory["complete"])
            self.assertEqual("cloudflare-queue:opaque-ref-1", inventory["copies"][0]["reference"])
            self.assertEqual("deleted", evidence["status"])
            self.assertEqual("/accounts/account-one/queues/queue-one/messages/peek", seen[0][0])
            self.assertEqual("/accounts/account-one/queues/queue-one/messages/purge", seen[1][0])
            self.assertEqual({"refs": [{"ref": "opaque-ref-1"}]}, seen[1][1])

    def test_cloudflare_queue_peek_api_errors_cannot_become_empty_complete_inventory(self):
        with patch.dict(
            os.environ,
            {
                "COMMUNICATOR_RETENTION_QUEUE_ACCOUNT_ID": "account-one",
                "COMMUNICATOR_RETENTION_QUEUE_ID": "queue-one",
                "COMMUNICATOR_RETENTION_QUEUE_API_TOKEN": "queue-api-token",
            },
            clear=False,
        ), patch.object(
            RETENTION,
            "json_http_request",
            return_value={"success": False, "errors": [{"code": 1000}]},
        ):
            with self.assertRaises(RETENTION.RetentionError):
                RETENTION.process_request(
                    "inventory",
                    {
                        "protocol": RETENTION.PROTOCOL,
                        "store": "queue",
                        "scope": {
                            "resource_id": "message_one",
                            "content_generation": "generation_one",
                        },
                    },
                )

    def test_pinned_bridge_v2_message_mapping_is_checked_and_deleted_without_touching_other_rows(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            manifest = root / "manifest.json"
            manifest.write_text(
                json.dumps(
                    {
                        "version": 1,
                        "stores": {
                            "bridge_database": {
                                "enumeration_complete": True,
                                "copies": [
                                    {
                                        "reference": "bridge:message-one",
                                        "resource_id": "message_one",
                                        "content_generation": "generation_one",
                                        "copy_created_at": "2026-09-01T00:00:00Z",
                                        "bridge_id": "whatsapp",
                                        "message_id": "remote-message-one",
                                        "part_id": "",
                                        "content_class": "bridge_mapping",
                                    }
                                ],
                            }
                        },
                    }
                ),
                encoding="utf-8",
            )
            log = root / "psql.log"
            fake_psql = root / "psql"
            fake_psql.write_text(
                "#!/usr/bin/env python3\n"
                "import pathlib, sys\n"
                f"pathlib.Path({str(log)!r}).write_text(' '.join(sys.argv))\n"
                "print('1')\n",
                encoding="utf-8",
            )
            fake_psql.chmod(0o700)
            with patch.dict(
                os.environ,
                {
                    "COMMUNICATOR_RETENTION_MANIFEST": str(manifest),
                    "COMMUNICATOR_RETENTION_BRIDGE_DATABASE_URL": "postgresql://bridge.invalid/db",
                    "COMMUNICATOR_RETENTION_BRIDGE_PSQL_BIN": str(fake_psql),
                },
                clear=False,
            ):
                inventory = RETENTION.process_request(
                    "inventory",
                    {
                        "protocol": RETENTION.PROTOCOL,
                        "store": "bridge_database",
                        "scope": {
                            "resource_id": "message_one",
                            "content_generation": "generation_one",
                        },
                    },
                )
                evidence = RETENTION.process_request(
                    "cleanup",
                    {
                        "protocol": RETENTION.PROTOCOL,
                        "store": "bridge_database",
                        "resource_id": "message_one",
                        "content_generation": "generation_one",
                        "reference": "bridge:message-one",
                    },
                )
            self.assertTrue(inventory["complete"])
            self.assertEqual("bridge_mapping", inventory["copies"][0]["content_class"])
            self.assertEqual("deleted", evidence["status"])
            query = log.read_text(encoding="utf-8")
            self.assertIn("DELETE FROM reaction", query)
            self.assertIn("DELETE FROM message", query)
            self.assertIn("remote-message-one", query)


if __name__ == "__main__":
    unittest.main()
