import importlib.util
import json
import os
import subprocess
import tempfile
import threading
import unittest
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch


ROOT = Path(__file__).parents[1]
GATE_PATH = ROOT / "scripts" / "restore-core-gate.py"
RETENTION_PATH = ROOT / "scripts" / "controlled-copy-retention.py"


def _load(path: Path, name: str):
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"unable to load {path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


GATE = _load(GATE_PATH, "restore_core_gate")
RETENTION = _load(RETENTION_PATH, "restore_core_retention")
PG_BIN = Path("/usr/lib/postgresql/18/bin")


def _authority(
    *,
    stores=None,
    authorities=None,
    tenant="tenant_restore_gate",
    epoch=2,
):
    if stores is None:
        stores = [
            {
                "store": store,
                "generation": "generation-2",
                "status": "preserved" if store in {"session_credentials", "account_keys"} else "complete",
                "content_present": store in {"session_credentials", "account_keys"},
                "evidence_source": f"fixture-{store}",
                "detail": None,
            }
            for store in GATE.ALL_STORES
        ]
    return {
        "version": 1,
        "tenant_id": tenant,
        "deletion_epoch": epoch,
        "authorities": [] if authorities is None else authorities,
        "stores": stores,
        "archive": {
            "status": "complete",
            "generation": "archive-generation-2",
            "evidence_source": "fixture-archive",
        },
    }


class RestoreGateTests(unittest.TestCase):
    def test_payload_paths_reject_nested_parent_traversal(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "payload"
            root.mkdir()
            (root / "retention").mkdir()
            (root / "retention/controlled-copy-layout.json").write_text(
                json.dumps(
                    {
                        "version": 1,
                        "format": "communicator-core-pgdump-v1",
                        "databases": [
                            {
                                "name": "synapse",
                                "path": "a/../../outside.pgdump",
                                "contract": "synapse-event-json-v1",
                            }
                        ],
                        "files": [],
                    }
                ),
                encoding="utf-8",
            )
            with self.assertRaisesRegex(Exception, "escapes"):
                GATE.validate_payload(root)

    def test_authenticated_current_endpoint_rechecks_head_before_ready(self):
        authority = _authority(epoch=0)
        authority["issued_at"] = datetime.now(timezone.utc).isoformat().replace(
            "+00:00", "Z"
        )
        authority["expires_at"] = (
            datetime.now(timezone.utc) + timedelta(seconds=60)
        ).isoformat().replace("+00:00", "Z")
        authority["ledger_head"] = GATE._sha256_json(
            {
                "tenant_id": authority["tenant_id"],
                "deletion_epoch": authority["deletion_epoch"],
                "authorities": authority["authorities"],
            }
        )
        changed_epoch = {**authority, "deletion_epoch": 1}
        changed_epoch["ledger_head"] = GATE._sha256_json(
            {
                "tenant_id": changed_epoch["tenant_id"],
                "deletion_epoch": changed_epoch["deletion_epoch"],
                "authorities": changed_epoch["authorities"],
            }
        )
        responses = [dict(authority), changed_epoch]
        seen_authorizations = []

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):  # noqa: N802 - BaseHTTPRequestHandler API
                seen_authorizations.append(self.headers.get("Authorization"))
                if self.headers.get("Authorization") != "Bearer restore-test-token":
                    self.send_response(401)
                    self.end_headers()
                    return
                document = responses[min(len(seen_authorizations) - 1, len(responses) - 1)]
                body = json.dumps(document).encode("utf-8")
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, *_args):
                return

        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            with tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                payload = root / "payload"
                (payload / "retention").mkdir(parents=True)
                for name in (
                    "synapse.pgdump",
                    "whatsapp.pgdump",
                    "messenger.pgdump",
                    "telegram.pgdump",
                ):
                    (payload / name).write_bytes(b"")
                (payload / "retention/controlled-copy-layout.json").write_text(
                    json.dumps(
                        {
                            "version": 1,
                            "format": "communicator-core-pgdump-v1",
                            "databases": [
                                {
                                    "name": database,
                                    "path": filename,
                                    "contract": contract,
                                }
                                for database, filename, contract in (
                                    ("synapse", "synapse.pgdump", "synapse-event-json-v1"),
                                    ("whatsapp_bridge", "whatsapp.pgdump", "mautrix-bridge-message-v1"),
                                    ("messenger_bridge", "messenger.pgdump", "mautrix-bridge-message-v1"),
                                    ("telegram_bridge", "telegram.pgdump", "mautrix-bridge-message-v1"),
                                )
                            ],
                            "files": [
                                "synapse.pgdump",
                                "whatsapp.pgdump",
                                "messenger.pgdump",
                                "telegram.pgdump",
                            ],
                        }
                    ),
                    encoding="utf-8",
                )
                report = root / "report.json"
                result = subprocess.run(
                    [
                        "python3",
                        str(GATE_PATH),
                        "--authority-url",
                        f"http://127.0.0.1:{server.server_address[1]}/restore-authority",
                        "--authority-token",
                        "restore-test-token",
                        "--tenant",
                        authority["tenant_id"],
                        "--payload",
                        str(payload),
                        "--report",
                        str(report),
                    ],
                    check=False,
                    capture_output=True,
                    text=True,
                    timeout=30,
                    env={**os.environ, "COMMUNICATOR_RESTORE_ALLOW_HTTP": "1"},
                )
                self.assertNotEqual(result.returncode, 0, result.stderr)
                self.assertIn("changed during sanitation", result.stderr)
                self.assertEqual("blocked", json.loads(report.read_text()) ["state"])
                self.assertEqual(
                    ["Bearer restore-test-token", "Bearer restore-test-token"],
                    seen_authorizations,
                )
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=5)

    def test_missing_authority_and_partial_store_write_blocked_reports(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            missing = root / "missing.json"
            report = root / "missing-report.json"
            result = subprocess.run(
                [
                    "python3",
                    str(GATE_PATH),
                    "--authority",
                    str(missing),
                    "--tenant",
                    "tenant_restore_gate",
                    "--report",
                    str(report),
                    "--authority-only",
                ],
                check=False,
                capture_output=True,
                text=True,
                timeout=30,
            )
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual("blocked", json.loads(report.read_text())["state"])

            authority = root / "authority.json"
            partial = _authority()
            partial["stores"] = [item for item in partial["stores"] if item["store"] != "queue"]
            authority.write_text(json.dumps(partial), encoding="utf-8")
            result = subprocess.run(
                [
                    "python3",
                    str(GATE_PATH),
                    "--authority",
                    str(authority),
                    "--tenant",
                    "tenant_restore_gate",
                    "--report",
                    str(root / "partial-report.json"),
                    "--authority-only",
                ],
                check=False,
                capture_output=True,
                text=True,
                timeout=30,
            )
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("queue", result.stderr)

    def test_duplicate_tombstone_is_idempotent_but_conflicting_target_is_blocked(self):
        authority = {
            "id": "removal_restore_gate",
            "tenant_id": "tenant_restore_gate",
            "resource_type": "message",
            "resource_id": "message_removed",
            "content_generation": "message_removed",
            "deletion_epoch": 2,
            "removed_at": "2026-09-14T00:00:00Z",
            "targets": [
                {
                    "database": "synapse",
                    "contract": "synapse-event-json-v1",
                    "room_id": "!room:example.test",
                    "event_id": "$removed:example.test",
                    "event_type": "m.room.message",
                    "media_paths": [],
                    "media_paths_complete": True,
                }
            ],
        }
        value = _authority(authorities=[authority, dict(authority)])
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "authority.json"
            source.write_text(json.dumps(value), encoding="utf-8")
            report = root / "report.json"
            result = subprocess.run(
                [
                    "python3",
                    str(GATE_PATH),
                    "--authority",
                    str(source),
                    "--tenant",
                    "tenant_restore_gate",
                    "--report",
                    str(report),
                    "--authority-only",
                ],
                check=False,
                capture_output=True,
                text=True,
                timeout=30,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(
                ["removal_restore_gate"], json.loads(report.read_text())["authority_ids"]
            )

            conflicting = dict(authority)
            conflicting["deletion_epoch"] = 1
            value["authorities"] = [authority, conflicting]
            source.write_text(json.dumps(value), encoding="utf-8")
            result = subprocess.run(
                [
                    "python3",
                    str(GATE_PATH),
                    "--authority",
                    str(source),
                    "--tenant",
                    "tenant_restore_gate",
                    "--report",
                    str(root / "conflict-report.json"),
                    "--authority-only",
                ],
                check=False,
                capture_output=True,
                text=True,
                timeout=30,
            )
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("conflicting", result.stderr)

    @unittest.skipUnless(PG_BIN.exists(), "the controlled PostgreSQL fixture is unavailable")
    def test_real_custom_dumps_are_sanitized_before_restore_report_is_ready(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            payload = root / "snapshot-root"
            payload.mkdir()
            for relative in (
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
            ):
                path = payload / relative
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text("fixture", encoding="utf-8")
            (payload / "synapse-data/media_store").mkdir(parents=True)
            (payload / "synapse-data/media_store/remove.bin").write_bytes(b"remove")
            (payload / "synapse-data/media_store/keep.bin").write_bytes(b"keep")

            socket_dir = root / "sockets"
            with patch.dict(
                os.environ,
                {
                    "COMMUNICATOR_RETENTION_PG_SOCKET_DIR": str(socket_dir),
                    "TMPDIR": str(root),
                },
                clear=False,
            ):
                with RETENTION.IsolatedPostgres(root / "source-pg") as postgres:
                    postgres.create_database("source")
                    postgres.execute(
                        "source",
                        """
                        CREATE TABLE events (room_id TEXT NOT NULL, event_id TEXT NOT NULL, type TEXT NOT NULL, PRIMARY KEY (room_id, event_id));
                        CREATE TABLE event_json (room_id TEXT NOT NULL, event_id TEXT NOT NULL, json JSONB NOT NULL, PRIMARY KEY (room_id, event_id));
                        CREATE TABLE message (bridge_id TEXT NOT NULL, id TEXT NOT NULL, part_id TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY (bridge_id, id, part_id));
                        CREATE TABLE reaction (bridge_id TEXT NOT NULL, message_id TEXT NOT NULL, message_part_id TEXT NOT NULL, emoji TEXT NOT NULL);
                        CREATE TABLE credentials (id TEXT PRIMARY KEY, secret TEXT NOT NULL);
                        CREATE TABLE account_keys (id TEXT PRIMARY KEY, key_material TEXT NOT NULL);
                        INSERT INTO events VALUES ('!room:example.test', '$removed:example.test', 'm.room.message'), ('!room:example.test', '$kept:example.test', 'm.room.message');
                        INSERT INTO event_json VALUES ('!room:example.test', '$removed:example.test', '{"event_id":"$removed:example.test","room_id":"!room:example.test","content":{"body":"remove"}}'), ('!room:example.test', '$kept:example.test', '{"event_id":"$kept:example.test","room_id":"!room:example.test","content":{"body":"keep"}}');
                        INSERT INTO message VALUES ('whatsapp', 'remote-removed', 'part-1', 'remove'), ('whatsapp', 'remote-kept', 'part-1', 'keep');
                        INSERT INTO reaction VALUES ('whatsapp', 'remote-removed', 'part-1', 'x'), ('whatsapp', 'remote-kept', 'part-1', 'y');
                        INSERT INTO credentials VALUES ('session', 'secret');
                        INSERT INTO account_keys VALUES ('account', 'key');
                        """,
                    )
                    for database, filename in (
                        ("synapse", "synapse.pgdump"),
                        ("whatsapp_bridge", "whatsapp.pgdump"),
                        ("messenger_bridge", "messenger.pgdump"),
                        ("telegram_bridge", "telegram.pgdump"),
                    ):
                        postgres.dump("source", payload / filename)
                subprocess.run(
                    ["python3", str(ROOT / "scripts/write-controlled-copy-layout.py"), str(payload)],
                    check=True,
                    capture_output=True,
                    text=True,
                    timeout=30,
                )

                removed = {
                    "id": "removal_restore_gate",
                    "tenant_id": "tenant_restore_gate",
                    "resource_type": "message",
                    "resource_id": "message_removed",
                    "content_generation": "message_removed",
                    "deletion_epoch": 2,
                    "removed_at": "2026-09-14T00:00:00Z",
                    "targets": [
                        {
                            "database": "synapse",
                            "contract": "synapse-event-json-v1",
                            "room_id": "!room:example.test",
                            "event_id": "$removed:example.test",
                            "event_type": "m.room.message",
                            "media_paths": ["synapse-data/media_store/remove.bin"],
                            "media_paths_complete": True,
                        },
                        {
                            "database": "whatsapp_bridge",
                            "contract": "mautrix-bridge-message-v1",
                            "bridge_id": "whatsapp",
                            "message_id": "remote-removed",
                            "part_id": "part-1",
                            "media_paths": [],
                            "media_paths_complete": True,
                        },
                    ],
                }
                authority_path = root / "authority.json"
                authority_path.write_text(
                    json.dumps(_authority(authorities=[removed])), encoding="utf-8"
                )
                report = root / "restore-report.json"
                result = subprocess.run(
                    [
                        "python3",
                        str(GATE_PATH),
                        "--authority",
                        str(authority_path),
                        "--tenant",
                        "tenant_restore_gate",
                        "--payload",
                        str(payload),
                        "--report",
                        str(report),
                    ],
                    check=False,
                    capture_output=True,
                    text=True,
                    timeout=900,
                    env=os.environ.copy(),
                )
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual("ready", json.loads(report.read_text())["state"])
                self.assertFalse((payload / "synapse-data/media_store/remove.bin").exists())
                self.assertTrue((payload / "synapse-data/media_store/keep.bin").exists())

                with RETENTION.IsolatedPostgres(root / "verify-pg") as verify:
                    verify.create_database("synapse")
                    verify.restore("synapse", payload / "synapse.pgdump")
                    self.assertEqual(
                        "",
                        verify.query(
                            "synapse",
                            "SELECT json->'content'->>'body' FROM event_json WHERE event_id='$removed:example.test'",
                        ),
                    )
                    self.assertEqual(
                        "keep",
                        verify.query(
                            "synapse",
                            "SELECT json->'content'->>'body' FROM event_json WHERE event_id='$kept:example.test'",
                        ),
                    )
                    self.assertEqual("secret", verify.query("synapse", "SELECT secret FROM credentials"))
                    self.assertEqual("key", verify.query("synapse", "SELECT key_material FROM account_keys"))
                    verify.create_database("bridge")
                    verify.restore("bridge", payload / "whatsapp.pgdump")
                    self.assertEqual(
                        "0",
                        verify.query(
                            "bridge",
                            "SELECT count(*) FROM message WHERE id='remote-removed'",
                        ),
                    )
                    self.assertEqual(
                        "keep",
                        verify.query(
                            "bridge",
                            "SELECT body FROM message WHERE id='remote-kept'",
                        ),
                    )


if __name__ == "__main__":
    unittest.main()
