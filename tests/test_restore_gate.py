import importlib.util
import json
import os
import shutil
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
RESTIC_SNAPSHOT_ID = "a" * 64


def _authority(
    *,
    stores=None,
    authorities=None,
    tenant="tenant_restore_gate",
    epoch=2,
):
    records = [] if authorities is None else authorities
    inventory_ids = list(dict.fromkeys(item["id"] for item in records)) or [tenant]
    copies_by_store = {
        store: [
            {
                "reference": (
                    "restic:fixture-snapshot"
                    if store == "restic_snapshot"
                    else f"fixture:{inventory_id}:{store}"
                ),
                "copy_created_at": "2026-09-14T00:00:00Z",
                "resource_id": inventory_id,
                "content_generation": "generation-2",
            }
            for inventory_id in inventory_ids
        ]
        for store in GATE.ALL_STORES
    }
    if stores is None:
        stores = [
            {
                "store": store,
                "generation": "generation-2",
                "status": "preserved" if store in {"session_credentials", "account_keys"} else "complete",
                "content_present": store in {"session_credentials", "account_keys"},
                "evidence_source": f"fixture-{store}",
                "detail": None,
                "references": [copy["reference"] for copy in copies_by_store[store]],
                "copies": copies_by_store[store],
            }
            for store in GATE.ALL_STORES
        ]
    inventory = [
        {
            "authority_id": inventory_id,
            "targets": next(
                (
                    [dict(target) for target in item.get("targets", [])]
                    for item in records
                    if item["id"] == inventory_id
                ),
                [],
            ) if inventory_id in {item["id"] for item in records} else [],
            "stores": [
                {
                    "store": store,
                    "complete": True,
                    "evidence_source": f"fixture-{store}",
                    "detail": None,
                    "references": [
                        copy["reference"]
                        for copy in copies_by_store[store]
                        if copy["resource_id"] == inventory_id
                    ],
                    "copies": [
                        copy
                        for copy in copies_by_store[store]
                        if copy["resource_id"] == inventory_id
                    ],
                }
                for store in GATE.ALL_STORES
            ],
        }
        for inventory_id in inventory_ids
    ]
    return {
        "version": 1,
        "tenant_id": tenant,
        "deletion_epoch": epoch,
        "authorities": records,
        "inventory": inventory,
        "stores": stores,
        "archive": {
            "status": "complete",
            "generation": "archive-generation-2",
            "evidence_source": "fixture-archive",
        },
    }


def _set_store_reference(authority: dict, store_name: str, reference: str) -> None:
    for store in authority["stores"]:
        if store["store"] == store_name:
            existing = store["copies"][0]
            copy = {**existing, "reference": reference}
            store["references"] = [reference]
            store["copies"] = [copy]
    for inventory in authority["inventory"]:
        for store in inventory["stores"]:
            if store["store"] == store_name:
                existing = store["copies"][0]
                copy = {**existing, "reference": reference}
                store["references"] = [reference]
                store["copies"] = [copy]


def _head(authority: dict) -> str:
    return GATE._sha256_json(
        {
            "tenant_id": authority["tenant_id"],
            "deletion_epoch": authority["deletion_epoch"],
            "authorities": [
                GATE._immutable_authority(item)
                for item in authority["authorities"]
            ],
            "inventory": authority["inventory"],
        }
    )


def _fake_restic_environment(
    root: Path,
    source: Path,
    snapshot_id: str = RESTIC_SNAPSHOT_ID,
) -> dict[str, str]:
    password = root / "restic-password"
    password.write_text("fixture-password\n", encoding="utf-8")
    binary = root / "restic"
    binary.write_text(
        """#!/usr/bin/env python3
import json
import os
from pathlib import Path
import sys

source = Path(os.environ["FAKE_RESTIC_SOURCE"])
snapshot_id = os.environ["FAKE_RESTIC_ID"]
source_root = "/fixture-root"
args = sys.argv[1:]
if not args:
    raise SystemExit(2)
if args[0] == "ls":
    if args[-1] != snapshot_id:
        raise SystemExit(1)
    print(json.dumps({
        "message_type": "snapshot",
        "struct_type": "snapshot",
        "id": snapshot_id,
        "paths": [source_root],
    }))
    for path in sorted(source.rglob("*")):
        relative = path.relative_to(source).as_posix()
        print(json.dumps({
            "message_type": "node",
            "struct_type": "node",
            "type": "dir" if path.is_dir() else "file",
            "path": source_root + "/" + relative,
        }))
    raise SystemExit(0)
if args[0] == "dump":
    if len(args) != 3 or args[1] != snapshot_id:
        raise SystemExit(1)
    prefix = source_root + "/"
    if not args[2].startswith(prefix):
        raise SystemExit(1)
    target = source / args[2][len(prefix):]
    if not target.is_file():
        raise SystemExit(1)
    sys.stdout.buffer.write(target.read_bytes())
    raise SystemExit(0)
if args[0] == "snapshots":
    print(json.dumps([{"id": snapshot_id, "tags": ["communicator-core"]}]))
    raise SystemExit(0)
raise SystemExit(2)
""",
        encoding="utf-8",
    )
    binary.chmod(0o700)
    return {
        "COMMUNICATOR_RESTORE_RESTIC_BIN": str(binary),
        "RESTIC_REPOSITORY": "fixture-repository",
        "RESTIC_PASSWORD_FILE": str(password),
        "FAKE_RESTIC_SOURCE": str(source),
        "FAKE_RESTIC_ID": snapshot_id,
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

    def test_restore_target_must_publish_exact_lineage(self):
        authority = {
            "id": "removal_restore_gate_lineage",
            "tenant_id": "tenant_restore_gate",
            "resource_type": "message",
            "resource_id": "message_removed",
            "content_generation": "message_removed",
            "deletion_epoch": 1,
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
        with self.assertRaisesRegex(Exception, "exact resource lineage"):
            GATE._targets_for([authority])

    def test_mutable_removal_progress_does_not_change_authority_identity(self):
        record = {
            "id": "removal_restore_gate_progress",
            "tenant_id": "tenant_restore_gate",
            "resource_type": "message",
            "resource_id": "message_progress",
            "content_generation": "generation_progress",
            "account_id": None,
            "conversation_id": None,
            "source_event_id": None,
            "source_object_key": None,
            "reason": "requested",
            "removed_at": "2026-09-14T00:00:00Z",
            "deletion_epoch": 1,
            "status": "active",
            "purge_status": "pending",
            "failure_code": None,
            "completed_at": None,
            "created_at": "2026-09-14T00:00:00Z",
            "updated_at": "2026-09-14T00:00:00Z",
        }
        authority = _authority(authorities=[record], epoch=1)
        authority["ledger_head"] = _head(authority)
        normalized = GATE._validate_authority_document(
            authority, authority["tenant_id"]
        )
        before = GATE._authority_fingerprint(normalized)
        progressed = json.loads(json.dumps(authority))
        progressed["authorities"][0].update(
            {
                "status": "completed",
                "purge_status": "complete",
                "completed_at": "2026-09-14T00:02:00Z",
                "updated_at": "2026-09-14T00:02:00Z",
            }
        )
        progressed["ledger_head"] = _head(progressed)
        progressed_normalized = GATE._validate_authority_document(
            progressed, progressed["tenant_id"]
        )
        self.assertEqual(authority["ledger_head"], progressed["ledger_head"])
        self.assertEqual(
            before, GATE._authority_fingerprint(progressed_normalized)
        )

    def test_authority_rejects_wildcard_lineage(self):
        record = {
            "id": "removal_restore_gate_wildcard",
            "tenant_id": "tenant_restore_gate",
            "resource_type": "message",
            "resource_id": "*",
            "content_generation": "generation_wildcard",
            "deletion_epoch": 1,
            "removed_at": "2026-09-14T00:00:00Z",
        }
        authority = _authority(authorities=[record], epoch=1)
        with self.assertRaisesRegex(Exception, "exact resource lineage"):
            GATE._validate_authority_document(authority, authority["tenant_id"])

    def test_restored_snapshot_id_must_match_authority_generation(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            payload = root / "payload"
            (payload / "retention").mkdir(parents=True)
            for filename in (
                "synapse.pgdump",
                "whatsapp.pgdump",
                "messenger.pgdump",
                "telegram.pgdump",
            ):
                (payload / filename).write_bytes(b"")
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
            authority = _authority(epoch=0)
            _set_store_reference(
                authority,
                "restic_snapshot",
                f"restic:{RESTIC_SNAPSHOT_ID}",
            )
            authority_path = root / "authority.json"
            authority_path.write_text(json.dumps(authority), encoding="utf-8")
            report = root / "report.json"
            result = subprocess.run(
                [
                    "python3",
                    str(GATE_PATH),
                    "--authority",
                    str(authority_path),
                    "--tenant",
                    authority["tenant_id"],
                    "--payload",
                    str(payload),
                    "--restic-snapshot-id",
                    "b" * 64,
                    "--report",
                    str(report),
                ],
                check=False,
                capture_output=True,
                text=True,
                timeout=30,
            )
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("outside the current authority generation", result.stderr)
            self.assertEqual("blocked", json.loads(report.read_text())["state"])

    def test_restic_snapshot_bytes_must_match_the_selected_restored_payload(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            payload = root / "payload"
            (payload / "retention").mkdir(parents=True)
            for filename in (
                "synapse.pgdump",
                "whatsapp.pgdump",
                "messenger.pgdump",
                "telegram.pgdump",
            ):
                (payload / filename).write_bytes(b"restored-bytes")
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
            snapshot_source = root / "authenticated-snapshot"
            shutil.copytree(payload, snapshot_source)
            (snapshot_source / "synapse.pgdump").write_bytes(b"different-bytes")
            authority = _authority(epoch=0)
            _set_store_reference(
                authority,
                "restic_snapshot",
                f"restic:{RESTIC_SNAPSHOT_ID}",
            )
            authority_path = root / "authority.json"
            authority_path.write_text(json.dumps(authority), encoding="utf-8")
            report = root / "report.json"
            result = subprocess.run(
                [
                    "python3",
                    str(GATE_PATH),
                    "--authority",
                    str(authority_path),
                    "--tenant",
                    authority["tenant_id"],
                    "--payload",
                    str(payload),
                    "--restic-snapshot-id",
                    RESTIC_SNAPSHOT_ID,
                    "--report",
                    str(report),
                ],
                check=False,
                capture_output=True,
                text=True,
                timeout=60,
                env={
                    **os.environ,
                    **_fake_restic_environment(root, snapshot_source),
                },
            )
            self.assertNotEqual(result.returncode, 0)
            self.assertIn(
                "restored payload bytes do not match authenticated restic snapshot",
                result.stderr,
            )
            self.assertEqual("blocked", json.loads(report.read_text())["state"])

    def test_inventory_bound_authority_head_is_accepted(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            authority = _authority(epoch=0)
            authority["ledger_head"] = _head(authority)
            source = root / "authority.json"
            report = root / "report.json"
            source.write_text(json.dumps(authority), encoding="utf-8")
            result = subprocess.run(
                [
                    "python3",
                    str(GATE_PATH),
                    "--authority",
                    str(source),
                    "--tenant",
                    authority["tenant_id"],
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
            self.assertEqual("authority_ready", json.loads(report.read_text())["state"])

    def test_gate_accepts_projected_aggregate_reference_with_exact_logical_lineage(self):
        authority = _authority(epoch=0)
        projected = authority["stores"]
        restic_store = next(
            store for store in projected if store["store"] == "restic_snapshot"
        )
        logical_copy = {
            **restic_store["copies"][0],
            "reference": f"restic:{RESTIC_SNAPSHOT_ID}",
            "resource_id": "tenant_restore_gate",
            "content_generation": "ledger_0",
        }
        restic_store["copies"] = [logical_copy]
        restic_store["references"] = [logical_copy["reference"]]
        for inventory in authority["inventory"]:
            inventory_store = next(
                store
                for store in inventory["stores"]
                if store["store"] == "restic_snapshot"
            )
            inventory_store["copies"] = [logical_copy]
            inventory_store["references"] = [logical_copy["reference"]]
        authority["ledger_head"] = _head(authority)
        normalized = GATE._validate_authority_document(
            authority, authority["tenant_id"]
        )
        GATE.verify_restic_snapshot_reference(normalized, RESTIC_SNAPSHOT_ID)
        self.assertEqual(
            "restic:" + RESTIC_SNAPSHOT_ID,
            normalized["stores"]["restic_snapshot"]["references"][0],
        )
        self.assertEqual(
            "tenant_restore_gate",
            normalized["stores"]["restic_snapshot"]["copies"][0]["resource_id"],
        )

    def test_authenticated_current_endpoint_rechecks_head_before_ready(self):
        authority = _authority(epoch=0)
        _set_store_reference(
            authority,
            "restic_snapshot",
            f"restic:{RESTIC_SNAPSHOT_ID}",
        )
        authority["issued_at"] = datetime.now(timezone.utc).isoformat().replace(
            "+00:00", "Z"
        )
        authority["expires_at"] = (
            datetime.now(timezone.utc) + timedelta(seconds=60)
        ).isoformat().replace("+00:00", "Z")
        authority["ledger_head"] = _head(authority)
        changed_epoch = {**authority, "deletion_epoch": 1}
        changed_epoch["ledger_head"] = _head(changed_epoch)
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
                snapshot_source = root / "authenticated-snapshot"
                shutil.copytree(payload, snapshot_source)
                fake_restic_environment = _fake_restic_environment(
                    root, snapshot_source
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
                        "--restic-snapshot-id",
                        RESTIC_SNAPSHOT_ID,
                        "--report",
                        str(report),
                    ],
                    check=False,
                    capture_output=True,
                    text=True,
                    timeout=30,
                    env={
                        **os.environ,
                        "COMMUNICATOR_RESTORE_ALLOW_HTTP": "1",
                        **fake_restic_environment,
                    },
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

    def test_activation_revalidation_blocks_changed_or_unavailable_authority(self):
        base = _authority(epoch=0)
        base["issued_at"] = datetime.now(timezone.utc).isoformat().replace(
            "+00:00", "Z"
        )
        base["expires_at"] = (
            datetime.now(timezone.utc) + timedelta(seconds=60)
        ).isoformat().replace("+00:00", "Z")
        base["ledger_head"] = _head(base)
        changed = {**base, "deletion_epoch": 1}
        changed["ledger_head"] = _head(changed)
        normalized_base = GATE._validate_authority_document(
            base, base["tenant_id"], require_current=True
        )
        responses = [base, changed, None]
        request_count = 0
        seen_authorizations = []
        lease_requests = []

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):  # noqa: N802 - BaseHTTPRequestHandler API
                nonlocal request_count
                seen_authorizations.append(self.headers.get("Authorization"))
                response = responses[min(request_count, len(responses) - 1)]
                request_count += 1
                if response is None:
                    self.send_response(503)
                    self.end_headers()
                    return
                body = json.dumps(response).encode("utf-8")
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def do_POST(self):  # noqa: N802 - BaseHTTPRequestHandler API
                if self.headers.get("Authorization") != "Bearer restore-test-token":
                    self.send_response(401)
                    self.end_headers()
                    return
                length = int(self.headers.get("Content-Length", "0"))
                lease_requests.append(json.loads(self.rfile.read(length).decode("utf-8")))
                body = json.dumps(
                    {
                        "lease_id": "restore_lease_test",
                        "tenant_id": base["tenant_id"],
                        "lease_token": "t" * 40,
                        "deletion_epoch": base["deletion_epoch"],
                        "ledger_head": base["ledger_head"],
                        "expires_at": (
                            datetime.now(timezone.utc) + timedelta(minutes=10)
                        ).isoformat().replace("+00:00", "Z"),
                    }
                ).encode("utf-8")
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
                sanitized = root / "restore-gate.json"
                sanitized.write_text(
                    json.dumps(
                        {
                            "version": 1,
                            "state": "ready",
                            "tenant_id": base["tenant_id"],
                            "deletion_epoch": base["deletion_epoch"],
                            "ledger_head": base["ledger_head"],
                            "authority_fingerprint": GATE._authority_fingerprint(
                                normalized_base
                            ),
                        }
                    ),
                    encoding="utf-8",
                )
                endpoint = (
                    f"http://127.0.0.1:{server.server_address[1]}/restore-authority"
                )
                command_prefix = [
                    "python3",
                    str(GATE_PATH),
                    "--authority-url",
                    endpoint,
                    "--authority-token",
                    "restore-test-token",
                    "--tenant",
                    base["tenant_id"],
                    "--activation-report",
                    str(sanitized),
                    "--activation-lease-url",
                    f"http://127.0.0.1:{server.server_address[1]}/restore-activation-lease",
                    "--activation-lease-id",
                    "restore_lease_test",
                ]

                def command(report_path: Path):
                    return [
                        *command_prefix,
                        "--report",
                        str(report_path),
                    ]

                environment = {
                    **os.environ,
                    "COMMUNICATOR_RESTORE_ALLOW_HTTP": "1",
                }

                result = subprocess.run(
                    command(root / "activation-report.json"),
                    check=False,
                    capture_output=True,
                    text=True,
                    timeout=30,
                    env=environment,
                )
                self.assertEqual(result.returncode, 0, result.stderr)
                activation_result = json.loads(
                    (root / "activation-report.json").read_text()
                )
                self.assertEqual("activation_ready", activation_result["state"])
                self.assertEqual(
                    "restore_lease_test",
                    activation_result["activation_lease"]["lease_id"],
                )

                result = subprocess.run(
                    command(root / "changed-report.json"),
                    check=False,
                    capture_output=True,
                    text=True,
                    timeout=30,
                    env=environment,
                )
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("changed before Synapse activation", result.stderr)
                self.assertEqual(
                    "blocked",
                    json.loads((root / "changed-report.json").read_text())["state"],
                )

                result = subprocess.run(
                    command(root / "unavailable-report.json"),
                    check=False,
                    capture_output=True,
                    text=True,
                    timeout=30,
                    env=environment,
                )
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("endpoint was unavailable", result.stderr)
                self.assertEqual(
                    "blocked",
                    json.loads((root / "unavailable-report.json").read_text())["state"],
                )
                self.assertEqual(
                    ["Bearer restore-test-token"] * 3,
                    seen_authorizations,
                )
                self.assertEqual(1, len(lease_requests))
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
                    "resource_id": "message_removed",
                    "content_generation": "message_removed",
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

            # PostgreSQL Unix socket paths are capped at 107 bytes.  Keep the
            # socket directory short even when TMPDIR points at the project
            # cache, as required by the restore test runner.
            socket_dir = Path("/tmp/communicator-restore33-pg")
            socket_dir.mkdir(parents=True, exist_ok=True)
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
                snapshot_source = root / "authenticated-snapshot"
                shutil.copytree(payload, snapshot_source)
                fake_restic_environment = _fake_restic_environment(
                    root, snapshot_source
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
                            "resource_id": "message_removed",
                            "content_generation": "message_removed",
                            "room_id": "!room:example.test",
                            "event_id": "$removed:example.test",
                            "event_type": "m.room.message",
                            "media_paths": ["synapse-data/media_store/remove.bin"],
                            "media_paths_complete": True,
                        },
                        {
                            "database": "whatsapp_bridge",
                            "contract": "mautrix-bridge-message-v1",
                            "resource_id": "message_removed",
                            "content_generation": "message_removed",
                            "bridge_id": "whatsapp",
                            "message_id": "remote-removed",
                            "part_id": "part-1",
                            "media_paths": [],
                            "media_paths_complete": True,
                        },
                    ],
                }
                authority_path = root / "authority.json"
                authority_document = _authority(authorities=[removed])
                _set_store_reference(
                    authority_document,
                    "restic_snapshot",
                    f"restic:{RESTIC_SNAPSHOT_ID}",
                )
                authority_path.write_text(
                    json.dumps(authority_document), encoding="utf-8"
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
                        "--restic-snapshot-id",
                        RESTIC_SNAPSHOT_ID,
                        "--report",
                        str(report),
                    ],
                    check=False,
                    capture_output=True,
                    text=True,
                    timeout=900,
                    env={**os.environ, **fake_restic_environment},
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
