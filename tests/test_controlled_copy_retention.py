import importlib.util
import json
import os
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

            self.assertEqual("aged_out", evidence["status"])
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
