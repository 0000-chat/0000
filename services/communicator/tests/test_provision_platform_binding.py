from __future__ import annotations

import importlib.util
import json
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).parents[1]
SCRIPT_PATH = ROOT / "scripts" / "provision-platform-binding.py"
SPEC = importlib.util.spec_from_file_location("provision_platform_binding", SCRIPT_PATH)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError("cannot load provisioning command")
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


MANIFEST = {
    "schema_version": 1,
    "binding_id": "binding_first_owner",
    "platform": {
        "authority": "platform-test-authority",
        "kind": "human",
        "subject_id": "platform-user",
        "organization_id": "platform-org",
        "membership_id": "platform-membership",
    },
    "local": {
        "tenant_id": "tenant_first",
        "tenant_slug": "first",
        "tenant_display_name": "First Tenant",
        "principal_id": "principal_first",
        "principal_kind": "human",
        "principal_display_name": "First Owner",
        "membership_id": "membership_first",
        "role": "owner",
        "identity_id": "identity_first",
        "identity_kind": "human",
        "identity_display_name": "First Human",
        "scopes": ["conversation.read", "message.send"],
    },
}


def create_schema(path: Path, *, include_bindings: bool = True) -> None:
    connection = sqlite3.connect(path)
    connection.executescript(
        """
        PRAGMA foreign_keys = ON;
        CREATE TABLE tenants (
          id TEXT PRIMARY KEY, slug TEXT UNIQUE NOT NULL, display_name TEXT NOT NULL,
          status TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
        );
        CREATE TABLE principals (
          id TEXT PRIMARY KEY, issuer TEXT NOT NULL, subject TEXT NOT NULL,
          principal_type TEXT NOT NULL, display_name TEXT NOT NULL, status TEXT NOT NULL,
          created_at TEXT NOT NULL, updated_at TEXT NOT NULL, revoked_at TEXT,
          UNIQUE (issuer, subject)
        );
        CREATE TABLE memberships (
          id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id),
          principal_id TEXT NOT NULL REFERENCES principals(id), role TEXT NOT NULL,
          status TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
          revoked_at TEXT
        );
        CREATE TABLE identities (
          id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id),
          identity_kind TEXT NOT NULL, display_name TEXT NOT NULL, status TEXT NOT NULL,
          created_at TEXT NOT NULL, updated_at TEXT NOT NULL
        );
        CREATE TABLE identity_grants (
          tenant_id TEXT NOT NULL, membership_id TEXT NOT NULL,
          identity_id TEXT NOT NULL, operation_scope TEXT NOT NULL, created_at TEXT NOT NULL,
          PRIMARY KEY (tenant_id, membership_id, identity_id, operation_scope)
        );
        """
    )
    if include_bindings:
        connection.executescript(
            """
            CREATE TABLE platform_bindings (
              binding_id TEXT PRIMARY KEY,
              platform_authority TEXT NOT NULL, platform_kind TEXT NOT NULL,
              platform_subject_id TEXT NOT NULL, platform_organization_id TEXT NOT NULL,
              platform_membership_id TEXT, platform_grant_id TEXT,
              local_tenant_id TEXT NOT NULL REFERENCES tenants(id),
              local_principal_id TEXT NOT NULL REFERENCES principals(id),
              local_membership_id TEXT NOT NULL,
              local_identity_id TEXT, local_installation_id TEXT, local_client_id TEXT,
              status TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
              revoked_at TEXT
            );
            """
        )
    connection.close()


def create_actual_schema(path: Path) -> None:
    connection = sqlite3.connect(path)
    connection.execute("PRAGMA foreign_keys = ON")
    migrations = ROOT / "apps" / "control-plane" / "migrations"
    for migration in sorted(migrations.glob("*.sql")):
        connection.executescript(migration.read_text(encoding="utf-8"))
    connection.close()


class ProvisionPlatformBindingTests(unittest.TestCase):
    def write_manifest(self, directory: Path, value: dict = MANIFEST) -> Path:
        path = directory / "manifest.json"
        path.write_text(json.dumps(value), encoding="utf-8")
        return path

    def test_manifest_rejects_credential_material(self) -> None:
        value = json.loads(json.dumps(MANIFEST))
        value["platform"]["credential"] = "opaque-secret"
        with self.assertRaises(MODULE.ManifestError):
            MODULE.validate_manifest(value)

    def test_dry_run_is_explicit_and_contains_no_credential(self) -> None:
        with tempfile.TemporaryDirectory() as directory_name:
            directory = Path(directory_name)
            manifest = self.write_manifest(directory)
            result = subprocess.run(
                [sys.executable, str(SCRIPT_PATH), "--manifest", str(manifest)],
                check=False,
                capture_output=True,
                text=True,
            )
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("DRY RUN", result.stdout)
        self.assertNotIn("credential", result.stdout.lower())
        self.assertNotIn("secret", result.stdout.lower())

    def test_sqlite_execution_is_idempotent_and_revocation_is_terminal(self) -> None:
        with tempfile.TemporaryDirectory() as directory_name:
            directory = Path(directory_name)
            database = directory / "control.sqlite"
            create_actual_schema(database)
            manifest = self.write_manifest(directory)
            command = [
                sys.executable,
                str(SCRIPT_PATH),
                "--manifest",
                str(manifest),
                "--sqlite",
                str(database),
                "--execute",
            ]
            first = subprocess.run(command, check=False, capture_output=True, text=True)
            second = subprocess.run(command, check=False, capture_output=True, text=True)
            self.assertEqual(first.returncode, 0, first.stdout + first.stderr)
            self.assertEqual(second.returncode, 0, second.stdout + second.stderr)
            connection = sqlite3.connect(database)
            self.assertEqual(
                connection.execute("SELECT COUNT(*) FROM platform_bindings").fetchone()[0],
                1,
            )
            connection.execute(
                "UPDATE platform_bindings SET status = 'revoked', revoked_at = '2026-09-20T00:00:00Z' WHERE binding_id = ?",
                (MANIFEST["binding_id"],),
            )
            connection.commit()
            connection.close()
            revoked = subprocess.run(command, check=False, capture_output=True, text=True)
            self.assertEqual(revoked.returncode, 2)
            connection = sqlite3.connect(database)
            self.assertEqual(
                connection.execute(
                    "SELECT status FROM platform_bindings WHERE binding_id = ?",
                    (MANIFEST["binding_id"],),
                ).fetchone()[0],
                "revoked",
            )
            connection.close()

    def test_rendered_d1_plan_guards_replay_conflicts_before_grant_mutations(self) -> None:
        with tempfile.TemporaryDirectory() as directory_name:
            directory = Path(directory_name)
            database = directory / "control.sqlite"
            create_actual_schema(database)
            item = MODULE.validate_manifest(MANIFEST)
            statements = MODULE.sql_plan(item)
            self.assertNotIn("BEGIN", "\n".join(statements))
            self.assertNotIn("COMMIT", "\n".join(statements))
            connection = sqlite3.connect(database)
            connection.executescript("\n".join(statements))
            connection.close()

            broadened = json.loads(json.dumps(MANIFEST))
            broadened["local"]["scopes"].append("connection.manage")
            broadened_item = MODULE.validate_manifest(broadened)
            connection = sqlite3.connect(database)
            with self.assertRaises(sqlite3.IntegrityError):
                connection.executescript("\n".join(MODULE.sql_plan(broadened_item)))
            scopes = {
                row[0]
                for row in connection.execute(
                    "SELECT operation_scope FROM identity_grants"
                ).fetchall()
            }
            self.assertEqual(scopes, {"conversation.read", "message.send"})
            connection.close()

            retargeted = json.loads(json.dumps(MANIFEST))
            retargeted["platform"]["subject_id"] = "another-subject"
            retargeted_item = MODULE.validate_manifest(retargeted)
            connection = sqlite3.connect(database)
            with self.assertRaises(sqlite3.IntegrityError):
                connection.executescript("\n".join(MODULE.sql_plan(retargeted_item)))
            binding = connection.execute(
                "SELECT platform_subject_id, status FROM platform_bindings WHERE binding_id = ?",
                (MANIFEST["binding_id"],),
            ).fetchone()
            self.assertEqual(binding, ("platform-user", "active"))
            connection.close()

            partial_database = directory / "partial.sqlite"
            create_actual_schema(partial_database)
            partial = sqlite3.connect(partial_database)
            first_grant = next(
                index
                for index, statement in enumerate(statements)
                if statement.startswith("INSERT INTO identity_grants")
            )
            for statement in statements[: first_grant + 1]:
                partial.execute(statement)
            partial.commit()
            partial.close()
            partial = sqlite3.connect(partial_database)
            partial.executescript("\n".join(statements))
            self.assertEqual(
                partial.execute(
                    "SELECT status FROM platform_bindings WHERE binding_id = ?",
                    (MANIFEST["binding_id"],),
                ).fetchone()[0],
                "active",
            )
            self.assertEqual(
                partial.execute("SELECT COUNT(*) FROM identity_grants").fetchone()[0],
                2,
            )
            partial.close()

            interleaving_database = directory / "interleaving.sqlite"
            create_actual_schema(interleaving_database)
            interleaving = sqlite3.connect(interleaving_database)
            broadened_statements = MODULE.sql_plan(broadened_item)
            first_mutation = next(
                index
                for index, statement in enumerate(broadened_statements)
                if "SELECT 'tenant_first', 'first', 'First Tenant'" in statement
            )
            for statement in broadened_statements[:first_mutation]:
                interleaving.execute(statement)
            # A competing owner wins the pending binding barrier before the
            # stale plan reaches its grant statements.
            interleaving.executescript("\n".join(statements))
            with self.assertRaises(sqlite3.IntegrityError):
                for statement in broadened_statements[first_mutation:]:
                    interleaving.execute(statement)
            self.assertEqual(
                interleaving.execute(
                    "SELECT platform_subject_id, status FROM platform_bindings WHERE binding_id = ?",
                    (MANIFEST["binding_id"],),
                ).fetchone(),
                ("platform-user", "active"),
            )
            self.assertEqual(
                {
                    row[0]
                    for row in interleaving.execute(
                        "SELECT operation_scope FROM identity_grants"
                    ).fetchall()
                },
                {"conversation.read", "message.send"},
            )
            interleaving.close()

    def test_partial_execution_rolls_back_before_binding_dependency_failure(self) -> None:
        with tempfile.TemporaryDirectory() as directory_name:
            directory = Path(directory_name)
            database = directory / "control.sqlite"
            create_schema(database, include_bindings=False)
            manifest = self.write_manifest(directory)
            result = subprocess.run(
                [
                    sys.executable,
                    str(SCRIPT_PATH),
                    "--manifest",
                    str(manifest),
                    "--sqlite",
                    str(database),
                    "--execute",
                ],
                check=False,
                capture_output=True,
                text=True,
            )
            self.assertEqual(result.returncode, 2)
            connection = sqlite3.connect(database)
            self.assertEqual(
                connection.execute("SELECT COUNT(*) FROM tenants").fetchone()[0],
                0,
            )
            self.assertEqual(
                connection.execute("SELECT COUNT(*) FROM principals").fetchone()[0],
                0,
            )
            connection.close()


if __name__ == "__main__":
    unittest.main()
