#!/usr/bin/env python3
"""Provision one explicit Platform-to-Communicator binding.

The command is deployment-owned setup.  It validates the complete manifest
before creating anything, defaults to a SQL dry run, and uses one transaction
for SQLite execution.  No Platform credential belongs in the manifest or the
generated SQL; credentials are presented later to the Worker for verification.
"""

from __future__ import annotations

import argparse
import json
import shlex
import sqlite3
import subprocess
from pathlib import Path
from typing import Any


class ManifestError(ValueError):
    """The manifest is malformed or conflicts with local state."""


SCOPES = {
    "conversation.read",
    "conversation.create",
    "group.create",
    "group.manage",
    "message.send",
    "message.mutate",
    "receipt.send",
    "connection.read",
    "connection.manage",
    "export.create",
    "replay.run",
    "retention.manage",
    "break_glass.inspect",
}
KINDS = {"human", "agent", "service"}
LOCAL_PRINCIPAL_KINDS = {"human", "operator", "agent", "service"}
ROLES = {"owner", "admin", "member"}
IDENTITY_KINDS = {"human", "agent"}
FORBIDDEN_KEYS = {"credential", "token", "secret", "password", "private_key"}


def quote(value: str | None) -> str:
    if value is None:
        return "NULL"
    return "'" + value.replace("'", "''") + "'"


def require_string(value: Any, path: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ManifestError(f"{path} must be a non-empty string")
    if len(value) > 512:
        raise ManifestError(f"{path} is too long")
    return value


def optional_string(value: Any, path: str) -> str | None:
    if value is None:
        return None
    return require_string(value, path)


def reject_sensitive_keys(value: Any, path: str = "manifest") -> None:
    if isinstance(value, dict):
        for key, child in value.items():
            normalized = str(key).lower().replace("-", "_")
            if normalized in FORBIDDEN_KEYS or any(
                fragment in normalized for fragment in FORBIDDEN_KEYS
            ):
                raise ManifestError(f"{path}.{key} is not accepted")
            reject_sensitive_keys(child, f"{path}.{key}")
    elif isinstance(value, list):
        for index, child in enumerate(value):
            reject_sensitive_keys(child, f"{path}[{index}]")


def load_manifest(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise ManifestError(f"cannot read manifest: {error}") from error
    if not isinstance(value, dict):
        raise ManifestError("manifest must be a JSON object")
    reject_sensitive_keys(value)
    return value


def validate_manifest(value: dict[str, Any]) -> dict[str, Any]:
    reject_sensitive_keys(value)
    if value.get("schema_version") != 1:
        raise ManifestError("schema_version must be 1")
    platform = value.get("platform")
    local = value.get("local")
    if not isinstance(platform, dict) or not isinstance(local, dict):
        raise ManifestError("platform and local objects are required")

    authority = require_string(platform.get("authority"), "platform.authority")
    kind = require_string(platform.get("kind"), "platform.kind")
    if kind not in KINDS:
        raise ManifestError("platform.kind must be human, agent, or service")
    subject_id = require_string(platform.get("subject_id"), "platform.subject_id")
    organization_id = require_string(
        platform.get("organization_id"), "platform.organization_id"
    )
    membership_id = optional_string(
        platform.get("membership_id"), "platform.membership_id"
    )
    grant_id = optional_string(platform.get("grant_id"), "platform.grant_id")
    if kind == "human" and (membership_id is None or grant_id is not None):
        raise ManifestError("human bindings require membership_id only")
    if kind in {"agent", "service"} and (
        grant_id is None or membership_id is not None
    ):
        raise ManifestError("agent/service bindings require grant_id only")

    tenant_id = require_string(local.get("tenant_id"), "local.tenant_id")
    tenant_slug = require_string(local.get("tenant_slug"), "local.tenant_slug")
    if len(tenant_slug) > 63 or tenant_slug != tenant_slug.lower():
        raise ManifestError("local.tenant_slug must be lowercase and at most 63 characters")
    tenant_display_name = require_string(
        local.get("tenant_display_name"), "local.tenant_display_name"
    )
    principal_id = require_string(local.get("principal_id"), "local.principal_id")
    principal_kind = require_string(
        local.get("principal_kind"), "local.principal_kind"
    )
    if principal_kind not in LOCAL_PRINCIPAL_KINDS:
        raise ManifestError("local.principal_kind is invalid")
    if kind == "human" and principal_kind not in {"human", "operator"}:
        raise ManifestError("human Platform principals require human/operator local principals")
    if kind in {"agent", "service"} and principal_kind != kind:
        raise ManifestError("agent/service Platform principals require the matching local kind")
    principal_subject = require_string(
        local.get("principal_subject", subject_id), "local.principal_subject"
    )
    principal_display_name = require_string(
        local.get("principal_display_name"), "local.principal_display_name"
    )
    membership_local_id = require_string(
        local.get("membership_id"), "local.membership_id"
    )
    role = require_string(local.get("role"), "local.role")
    if role not in ROLES:
        raise ManifestError("local.role is invalid")
    if kind == "human" and role not in {"owner", "admin", "member"}:
        raise ManifestError("human local role is invalid")

    identity_id = optional_string(local.get("identity_id"), "local.identity_id")
    identity_kind = optional_string(
        local.get("identity_kind"), "local.identity_kind"
    )
    identity_display_name = optional_string(
        local.get("identity_display_name"), "local.identity_display_name"
    )
    scopes_value = local.get("scopes", [])
    if not isinstance(scopes_value, list) or any(
        not isinstance(scope, str) or scope not in SCOPES for scope in scopes_value
    ):
        raise ManifestError("local.scopes must contain only known operation scopes")
    scopes = sorted(set(scopes_value))
    if identity_id is None and (identity_kind is not None or identity_display_name is not None or scopes):
        raise ManifestError("identity_kind/display_name/scopes require identity_id")
    if identity_id is not None:
        if identity_kind not in IDENTITY_KINDS:
            raise ManifestError("local.identity_kind is required and invalid")
        if identity_display_name is None:
            raise ManifestError("local.identity_display_name is required")
        if kind == "human" and identity_kind != "human":
            raise ManifestError("human bindings require a human identity")
        if kind in {"agent", "service"} and identity_kind != "agent":
            raise ManifestError("machine bindings require an agent identity")

    installation_id = optional_string(
        local.get("installation_id"), "local.installation_id"
    )
    client_id = optional_string(local.get("client_id"), "local.client_id")
    if (installation_id is None) != (client_id is None):
        raise ManifestError("installation_id and client_id must be supplied together")
    if kind != "agent" and installation_id is not None:
        raise ManifestError("only agent bindings may preserve an installation")
    binding_id = require_string(value.get("binding_id"), "binding_id")
    return {
        "binding_id": binding_id,
        "platform_authority": authority,
        "platform_kind": kind,
        "platform_subject_id": subject_id,
        "platform_organization_id": organization_id,
        "platform_membership_id": membership_id,
        "platform_grant_id": grant_id,
        "tenant_id": tenant_id,
        "tenant_slug": tenant_slug,
        "tenant_display_name": tenant_display_name,
        "principal_id": principal_id,
        "principal_kind": principal_kind,
        "principal_subject": principal_subject,
        "principal_display_name": principal_display_name,
        "membership_local_id": membership_local_id,
        "role": role,
        "identity_id": identity_id,
        "identity_kind": identity_kind,
        "identity_display_name": identity_display_name,
        "scopes": scopes,
        "installation_id": installation_id,
        "client_id": client_id,
    }


def timestamp_sql() -> str:
    return "strftime('%Y-%m-%dT%H:%M:%fZ','now')"


def is_sql(value: str | None, column: str) -> str:
    return f"{column} IS {quote(value)}"


def all_sql(conditions: list[str]) -> str:
    return " AND ".join(f"({condition})" for condition in conditions)


def guard_failure(condition: str) -> str:
    """Make a conditional mismatch fail on every D1/SQLite schema.

    SQLite's RAISE() is only legal inside a trigger.  A NULL primary key is a
    portable, deterministic constraint failure, so the plan can preflight all
    immutable/conflicting state before any grant or binding mutation without a
    temporary table or a transaction assumption.
    """

    return (
        "INSERT INTO tenants (id, slug, display_name, status, created_at, updated_at) "
        f"SELECT NULL, NULL, NULL, NULL, NULL, NULL WHERE ({condition});"
    )


def mismatch(existing: str, expected: dict[str, str | None]) -> str:
    return "NOT (" + all_sql(
        [is_sql(value, f"{existing}.{column}") for column, value in expected.items()]
    ) + ")"


def exact_binding(item: dict[str, Any], alias: str = "b") -> dict[str, str | None]:
    return {
        "binding_id": item["binding_id"],
        "platform_authority": item["platform_authority"],
        "platform_kind": item["platform_kind"],
        "platform_subject_id": item["platform_subject_id"],
        "platform_organization_id": item["platform_organization_id"],
        "platform_membership_id": item["platform_membership_id"],
        "platform_grant_id": item["platform_grant_id"],
        "local_tenant_id": item["tenant_id"],
        "local_principal_id": item["principal_id"],
        "local_membership_id": item["membership_local_id"],
        "local_identity_id": item["identity_id"],
        "local_installation_id": item["installation_id"],
        "local_client_id": item["client_id"],
    }


def sql_plan(item: dict[str, Any]) -> list[str]:
    """Return a retry-safe statement plan for D1's non-atomic command path.

    Every conflict check precedes every mutation.  A pending binding is the
    only intermediate authorization state; activation is the last guarded
    statement and requires the exact immutable tuple and local target.
    """

    now = timestamp_sql()
    binding = exact_binding(item)
    statements: list[str] = []

    tenant_expected = {
        "id": item["tenant_id"],
        "slug": item["tenant_slug"],
        "display_name": item["tenant_display_name"],
        "status": "active",
    }
    statements.append(
        guard_failure(
            "EXISTS (SELECT 1 FROM tenants AS t WHERE t.id = "
            + quote(item["tenant_id"])
            + " AND "
            + mismatch("t", tenant_expected)
            + ")"
        )
    )
    statements.append(
        guard_failure(
            "EXISTS (SELECT 1 FROM tenants AS t WHERE t.slug = "
            + quote(item["tenant_slug"])
            + " AND t.id <> "
            + quote(item["tenant_id"])
            + ")"
        )
    )

    principal_expected = {
        "id": item["principal_id"],
        "issuer": item["platform_authority"],
        "subject": item["principal_subject"],
        "principal_type": item["principal_kind"],
        "display_name": item["principal_display_name"],
        "status": "active",
        "revoked_at": None,
    }
    statements.append(
        guard_failure(
            "EXISTS (SELECT 1 FROM principals AS p WHERE p.id = "
            + quote(item["principal_id"])
            + " AND "
            + mismatch("p", principal_expected)
            + ")"
        )
    )
    statements.append(
        guard_failure(
            "EXISTS (SELECT 1 FROM principals AS p WHERE p.issuer = "
            + quote(item["platform_authority"])
            + " AND p.subject = "
            + quote(item["principal_subject"])
            + " AND p.id <> "
            + quote(item["principal_id"])
            + ")"
        )
    )

    membership_expected = {
        "id": item["membership_local_id"],
        "tenant_id": item["tenant_id"],
        "principal_id": item["principal_id"],
        "role": item["role"],
        "status": "active",
        "revoked_at": None,
    }
    statements.append(
        guard_failure(
            "EXISTS (SELECT 1 FROM memberships AS m WHERE m.id = "
            + quote(item["membership_local_id"])
            + " AND "
            + mismatch("m", membership_expected)
            + ")"
        )
    )

    if item["identity_id"] is not None:
        identity_expected = {
            "id": item["identity_id"],
            "tenant_id": item["tenant_id"],
            "identity_kind": item["identity_kind"],
            "display_name": item["identity_display_name"],
            "status": "active",
        }
        statements.append(
            guard_failure(
                "EXISTS (SELECT 1 FROM identities AS i WHERE i.id = "
                + quote(item["identity_id"])
                + " AND "
                + mismatch("i", identity_expected)
                + ")"
            )
        )

    binding_conditions = [
        is_sql(value, f"b.{column}") for column, value in binding.items()
    ]
    binding_id = quote(item["binding_id"])
    binding_exists = f"EXISTS (SELECT 1 FROM platform_bindings AS b WHERE b.binding_id = {binding_id})"
    statements.append(
        guard_failure(
            "EXISTS (SELECT 1 FROM platform_bindings AS b WHERE "
            + all_sql(
                [
                    f"b.binding_id = {binding_id}",
                    f"(NOT ({all_sql(binding_conditions)}) OR b.status NOT IN ('pending', 'active') OR b.revoked_at IS NOT NULL)",
                ]
            )
            + ")"
        )
    )
    tuple_conditions = [
        is_sql(item["platform_authority"], "b.platform_authority"),
        is_sql(item["platform_kind"], "b.platform_kind"),
        is_sql(item["platform_subject_id"], "b.platform_subject_id"),
        is_sql(item["platform_organization_id"], "b.platform_organization_id"),
        is_sql(item["platform_membership_id"], "b.platform_membership_id"),
        is_sql(item["platform_grant_id"], "b.platform_grant_id"),
    ]
    statements.append(
        guard_failure(
            "EXISTS (SELECT 1 FROM platform_bindings AS b WHERE "
            + all_sql(tuple_conditions + [f"b.binding_id <> {binding_id}"])
            + ")"
        )
    )
    statements.append(
        guard_failure(
            "EXISTS (SELECT 1 FROM platform_bindings AS b WHERE "
            + all_sql(
                [
                    is_sql(item["platform_authority"], "b.platform_authority"),
                    is_sql(item["platform_organization_id"], "b.platform_organization_id"),
                    f"b.local_tenant_id <> {quote(item['tenant_id'])}",
                ]
            )
            + ") OR EXISTS (SELECT 1 FROM platform_bindings AS b WHERE "
            + all_sql(
                [
                    is_sql(item["tenant_id"], "b.local_tenant_id"),
                    f"NOT ({all_sql([is_sql(item['platform_authority'], 'b.platform_authority'), is_sql(item['platform_organization_id'], 'b.platform_organization_id')])})",
                ]
            )
            + ")"
        )
    )

    if item["installation_id"] is not None:
        statements.append(
            guard_failure(
                "NOT EXISTS (SELECT 1 FROM oauth_clients AS c WHERE c.client_id = "
                + quote(item["client_id"])
                + " AND c.status = 'active')"
            )
        )
        statements.append(
            guard_failure(
                "NOT EXISTS (SELECT 1 FROM oauth_client_installations AS oi WHERE "
                + all_sql(
                    [
                        is_sql(item["installation_id"], "oi.id"),
                        is_sql(item["client_id"], "oi.client_id"),
                        is_sql(item["tenant_id"], "oi.tenant_id"),
                        is_sql(item["membership_local_id"], "oi.membership_id"),
                        is_sql(item["principal_id"], "oi.principal_id"),
                        is_sql(item["identity_id"], "oi.identity_id"),
                        "oi.status = 'active'",
                    ]
                )
                + ")"
            )
        )

    if item["identity_id"] is not None:
        requested = item["scopes"]
        target = all_sql(
            [
                is_sql(item["tenant_id"], "ig.tenant_id"),
                is_sql(item["membership_local_id"], "ig.membership_id"),
                is_sql(item["identity_id"], "ig.identity_id"),
            ]
        )
        extra = (
            "EXISTS (SELECT 1 FROM identity_grants AS extra WHERE "
            + all_sql(
                [
                    is_sql(item["tenant_id"], "extra.tenant_id"),
                    is_sql(item["membership_local_id"], "extra.membership_id"),
                    is_sql(item["identity_id"], "extra.identity_id"),
                    (
                        "extra.operation_scope NOT IN ("
                        + ", ".join(quote(scope) for scope in requested)
                        + ")"
                        if requested
                        else "1 = 1"
                    ),
                ]
            )
            + ")"
        )
        missing = " OR ".join(
            "NOT EXISTS (SELECT 1 FROM identity_grants AS missing WHERE "
            + all_sql(
                [
                    is_sql(item["tenant_id"], "missing.tenant_id"),
                    is_sql(item["membership_local_id"], "missing.membership_id"),
                    is_sql(item["identity_id"], "missing.identity_id"),
                    is_sql(scope, "missing.operation_scope"),
                ]
            )
            + ")"
            for scope in requested
        )
        stable_grants = f"EXISTS (SELECT 1 FROM identity_grants AS ig WHERE {target})"
        active_binding = f"EXISTS (SELECT 1 FROM platform_bindings AS active_binding WHERE active_binding.binding_id = {binding_id} AND active_binding.status = 'active')"
        pending_binding = f"EXISTS (SELECT 1 FROM platform_bindings AS pending_binding WHERE pending_binding.binding_id = {binding_id} AND pending_binding.status = 'pending')"
        scope_mismatch = (
            f"(({active_binding} OR (NOT ({binding_exists}) AND {stable_grants})) AND ({extra}"
            + (f" OR {missing}" if missing else "")
            + f")) OR ({pending_binding} AND {extra})"
        )
        statements.append(guard_failure(scope_mismatch))

    now_values = [quote(item["tenant_id"]), quote(item["tenant_slug"]), quote(item["tenant_display_name"])]
    statements.append(
        f"INSERT INTO tenants (id, slug, display_name, status, created_at, updated_at) "
        f"SELECT {now_values[0]}, {now_values[1]}, {now_values[2]}, 'active', {now}, {now} "
        f"WHERE NOT EXISTS (SELECT 1 FROM tenants WHERE id = {now_values[0]});"
    )
    statements.append(
        f"INSERT INTO principals (id, issuer, subject, principal_type, display_name, status, created_at, updated_at) "
        f"SELECT {quote(item['principal_id'])}, {quote(item['platform_authority'])}, {quote(item['principal_subject'])}, {quote(item['principal_kind'])}, {quote(item['principal_display_name'])}, 'active', {now}, {now} "
        f"WHERE NOT EXISTS (SELECT 1 FROM principals WHERE id = {quote(item['principal_id'])});"
    )
    statements.append(
        f"INSERT INTO memberships (id, tenant_id, principal_id, role, status, created_at, updated_at) "
        f"SELECT {quote(item['membership_local_id'])}, {quote(item['tenant_id'])}, {quote(item['principal_id'])}, {quote(item['role'])}, 'active', {now}, {now} "
        f"WHERE NOT EXISTS (SELECT 1 FROM memberships WHERE id = {quote(item['membership_local_id'])});"
    )
    if item["identity_id"] is not None:
        statements.append(
            f"INSERT INTO identities (id, tenant_id, identity_kind, display_name, status, created_at, updated_at) "
            f"SELECT {quote(item['identity_id'])}, {quote(item['tenant_id'])}, {quote(item['identity_kind'])}, {quote(item['identity_display_name'])}, 'active', {now}, {now} "
            f"WHERE NOT EXISTS (SELECT 1 FROM identities WHERE id = {quote(item['identity_id'])});"
        )
    statements.append(
        f"INSERT INTO platform_bindings (binding_id, platform_authority, platform_kind, platform_subject_id, platform_organization_id, platform_membership_id, platform_grant_id, local_tenant_id, local_principal_id, local_membership_id, local_identity_id, local_installation_id, local_client_id, status, created_at, updated_at) "
        f"SELECT {quote(item['binding_id'])}, {quote(item['platform_authority'])}, {quote(item['platform_kind'])}, {quote(item['platform_subject_id'])}, {quote(item['platform_organization_id'])}, {quote(item['platform_membership_id'])}, {quote(item['platform_grant_id'])}, {quote(item['tenant_id'])}, {quote(item['principal_id'])}, {quote(item['membership_local_id'])}, {quote(item['identity_id'])}, {quote(item['installation_id'])}, {quote(item['client_id'])}, 'pending', {now}, {now} "
        f"WHERE NOT EXISTS (SELECT 1 FROM platform_bindings WHERE binding_id = {quote(item['binding_id'])});"
    )
    if item["identity_id"] is not None:
        pending_exact = (
            "EXISTS (SELECT 1 FROM platform_bindings AS pending_binding WHERE "
            + all_sql(
                [
                    f"pending_binding.binding_id = {binding_id}",
                    "pending_binding.status = 'pending'",
                    *[
                        is_sql(value, f"pending_binding.{column}")
                        for column, value in binding.items()
                    ],
                ]
            )
            + ")"
        )
        for scope in item["scopes"]:
            statements.append(
                f"INSERT INTO identity_grants (tenant_id, membership_id, identity_id, operation_scope, created_at) "
                f"SELECT {quote(item['tenant_id'])}, {quote(item['membership_local_id'])}, {quote(item['identity_id'])}, {quote(scope)}, {now} "
                f"WHERE {pending_exact} AND NOT EXISTS (SELECT 1 FROM identity_grants WHERE tenant_id = {quote(item['tenant_id'])} AND membership_id = {quote(item['membership_local_id'])} AND identity_id = {quote(item['identity_id'])} AND operation_scope = {quote(scope)});"
            )
    activation_checks = [
        f"EXISTS (SELECT 1 FROM tenants AS t WHERE t.id = {quote(item['tenant_id'])} AND t.status = 'active')",
        f"EXISTS (SELECT 1 FROM principals AS p WHERE p.id = {quote(item['principal_id'])} AND p.status = 'active' AND p.revoked_at IS NULL AND (({quote(item['platform_kind'])} = 'human' AND p.principal_type IN ('human', 'operator')) OR ({quote(item['platform_kind'])} IN ('agent', 'service') AND p.principal_type = {quote(item['platform_kind'])})))",
        f"EXISTS (SELECT 1 FROM memberships AS m WHERE m.id = {quote(item['membership_local_id'])} AND m.tenant_id = {quote(item['tenant_id'])} AND m.principal_id = {quote(item['principal_id'])} AND m.role = {quote(item['role'])} AND m.status = 'active' AND m.revoked_at IS NULL)",
    ]
    if item["identity_id"] is not None:
        activation_checks.append(
            f"EXISTS (SELECT 1 FROM identities AS i JOIN identity_grants AS ig ON ig.tenant_id = {quote(item['tenant_id'])} AND ig.membership_id = {quote(item['membership_local_id'])} AND ig.identity_id = {quote(item['identity_id'])} WHERE i.id = {quote(item['identity_id'])} AND i.tenant_id = {quote(item['tenant_id'])} AND i.status = 'active' AND i.identity_kind = {quote(item['identity_kind'])})"
        )
        if item["scopes"]:
            activation_checks.append(
                "NOT EXISTS (SELECT 1 FROM identity_grants AS extra WHERE "
                + all_sql(
                    [
                        is_sql(item["tenant_id"], "extra.tenant_id"),
                        is_sql(item["membership_local_id"], "extra.membership_id"),
                        is_sql(item["identity_id"], "extra.identity_id"),
                        "extra.operation_scope NOT IN ("
                        + ", ".join(quote(scope) for scope in item["scopes"])
                        + ")",
                    ]
                )
                + ")"
            )
            for scope in item["scopes"]:
                activation_checks.append(
                    "EXISTS (SELECT 1 FROM identity_grants AS required WHERE "
                    + all_sql(
                        [
                            is_sql(item["tenant_id"], "required.tenant_id"),
                            is_sql(item["membership_local_id"], "required.membership_id"),
                            is_sql(item["identity_id"], "required.identity_id"),
                            is_sql(scope, "required.operation_scope"),
                        ]
                    )
                    + ")"
                )
        else:
            activation_checks.append(
                "NOT EXISTS (SELECT 1 FROM identity_grants AS extra WHERE "
                + all_sql(
                    [
                        is_sql(item["tenant_id"], "extra.tenant_id"),
                        is_sql(item["membership_local_id"], "extra.membership_id"),
                        is_sql(item["identity_id"], "extra.identity_id"),
                    ]
                )
                + ")"
            )
    if item["installation_id"] is not None:
        activation_checks.append(
            f"EXISTS (SELECT 1 FROM oauth_client_installations AS oi JOIN oauth_clients AS oc ON oc.client_id = {quote(item['client_id'])} WHERE oi.id = {quote(item['installation_id'])} AND oi.client_id = {quote(item['client_id'])} AND oi.tenant_id = {quote(item['tenant_id'])} AND oi.membership_id = {quote(item['membership_local_id'])} AND oi.principal_id = {quote(item['principal_id'])} AND oi.identity_id IS {quote(item['identity_id'])} AND oi.status = 'active' AND oc.status = 'active')"
        )
    statements.append(
        f"UPDATE platform_bindings SET status = 'active', updated_at = {now} "
        f"WHERE binding_id = {binding_id} AND status = 'pending' AND "
        + all_sql(
            [
                *[is_sql(value, f"platform_bindings.{column}") for column, value in binding.items()],
                *activation_checks,
            ]
        )
        + ";"
    )
    final_binding = "EXISTS (SELECT 1 FROM platform_bindings AS final_binding WHERE " + all_sql(
        [
            "final_binding.status = 'active'",
            "final_binding.revoked_at IS NULL",
            *[
                is_sql(value, f"final_binding.{column}")
                for column, value in binding.items()
            ],
        ]
    ) + ")"
    statements.append(
        guard_failure(
            "NOT (" + final_binding + " AND " + all_sql(activation_checks) + ")"
        )
    )
    return statements


def row_matches(row: sqlite3.Row | None, expected: dict[str, Any]) -> bool:
    if row is None:
        return False
    for key, value in expected.items():
        if row[key] != value:
            return False
    return True


def validate_existing_state(connection: sqlite3.Connection, item: dict[str, Any]) -> None:
    """Reject all replay/conflict cases before the first mutating statement."""

    tenant = connection.execute(
        "SELECT id, slug, display_name, status FROM tenants WHERE id = ?",
        (item["tenant_id"],),
    ).fetchone()
    if tenant is not None and not row_matches(
        tenant,
        {
            "id": item["tenant_id"],
            "slug": item["tenant_slug"],
            "display_name": item["tenant_display_name"],
            "status": "active",
        },
    ):
        raise ManifestError("existing tenant conflicts with manifest")
    tenant_slug = connection.execute(
        "SELECT id FROM tenants WHERE slug = ? AND id <> ?",
        (item["tenant_slug"], item["tenant_id"]),
    ).fetchone()
    if tenant_slug is not None:
        raise ManifestError("existing tenant slug conflicts with manifest")

    principal = connection.execute(
        "SELECT id, issuer, subject, principal_type, display_name, status, revoked_at FROM principals WHERE id = ?",
        (item["principal_id"],),
    ).fetchone()
    if principal is not None and not row_matches(
        principal,
        {
            "id": item["principal_id"],
            "issuer": item["platform_authority"],
            "subject": item["principal_subject"],
            "principal_type": item["principal_kind"],
            "display_name": item["principal_display_name"],
            "status": "active",
            "revoked_at": None,
        },
    ):
        raise ManifestError("existing principal conflicts with manifest")
    duplicate_principal = connection.execute(
        "SELECT id FROM principals WHERE issuer = ? AND subject = ? AND id <> ?",
        (item["platform_authority"], item["principal_subject"], item["principal_id"]),
    ).fetchone()
    if duplicate_principal is not None:
        raise ManifestError("Platform principal tuple is already bound locally")

    membership = connection.execute(
        "SELECT id, tenant_id, principal_id, role, status, revoked_at FROM memberships WHERE id = ?",
        (item["membership_local_id"],),
    ).fetchone()
    if membership is not None and not row_matches(
        membership,
        {
            "id": item["membership_local_id"],
            "tenant_id": item["tenant_id"],
            "principal_id": item["principal_id"],
            "role": item["role"],
            "status": "active",
            "revoked_at": None,
        },
    ):
        raise ManifestError("existing membership conflicts with manifest")

    if item["identity_id"] is not None:
        identity = connection.execute(
            "SELECT id, tenant_id, identity_kind, display_name, status FROM identities WHERE id = ?",
            (item["identity_id"],),
        ).fetchone()
        if identity is not None and not row_matches(
            identity,
            {
                "id": item["identity_id"],
                "tenant_id": item["tenant_id"],
                "identity_kind": item["identity_kind"],
                "display_name": item["identity_display_name"],
                "status": "active",
            },
        ):
            raise ManifestError("existing identity conflicts with manifest")

    binding = connection.execute(
        "SELECT * FROM platform_bindings WHERE binding_id = ?",
        (item["binding_id"],),
    ).fetchone()
    expected_binding = {
        "binding_id": item["binding_id"],
        "platform_authority": item["platform_authority"],
        "platform_kind": item["platform_kind"],
        "platform_subject_id": item["platform_subject_id"],
        "platform_organization_id": item["platform_organization_id"],
        "platform_membership_id": item["platform_membership_id"],
        "platform_grant_id": item["platform_grant_id"],
        "local_tenant_id": item["tenant_id"],
        "local_principal_id": item["principal_id"],
        "local_membership_id": item["membership_local_id"],
        "local_identity_id": item["identity_id"],
        "local_installation_id": item["installation_id"],
        "local_client_id": item["client_id"],
    }
    if binding is not None:
        if not row_matches(binding, expected_binding):
            raise ManifestError("existing binding conflicts with manifest")
        if binding["status"] == "revoked" or binding["revoked_at"] is not None:
            raise ManifestError("revoked binding cannot be revived")
        if binding["status"] not in {"pending", "active"}:
            raise ManifestError("existing binding has an invalid status")
    tuple_query = connection.execute(
        """SELECT binding_id FROM platform_bindings
           WHERE platform_authority = ? AND platform_kind = ?
             AND platform_subject_id = ? AND platform_organization_id = ?
             AND platform_membership_id IS ? AND platform_grant_id IS ?
             AND binding_id <> ?""",
        (
            item["platform_authority"],
            item["platform_kind"],
            item["platform_subject_id"],
            item["platform_organization_id"],
            item["platform_membership_id"],
            item["platform_grant_id"],
            item["binding_id"],
        ),
    ).fetchone()
    if tuple_query is not None:
        raise ManifestError("Platform binding tuple is already reserved")
    association = connection.execute(
        """SELECT binding_id FROM platform_bindings
           WHERE (platform_authority = ? AND platform_organization_id = ? AND local_tenant_id <> ?)
              OR (local_tenant_id = ? AND (platform_authority <> ? OR platform_organization_id <> ?))""",
        (
            item["platform_authority"],
            item["platform_organization_id"],
            item["tenant_id"],
            item["tenant_id"],
            item["platform_authority"],
            item["platform_organization_id"],
        ),
    ).fetchone()
    if association is not None:
        raise ManifestError("Platform organization and local tenant association conflicts")

    if item["installation_id"] is not None:
        client = connection.execute(
            "SELECT client_id, status FROM oauth_clients WHERE client_id = ?",
            (item["client_id"],),
        ).fetchone()
        installation = connection.execute(
            "SELECT id, client_id, tenant_id, membership_id, principal_id, identity_id, status FROM oauth_client_installations WHERE id = ?",
            (item["installation_id"],),
        ).fetchone()
        if client is None or client["status"] != "active":
            raise ManifestError("installation client is missing or inactive")
        if installation is None or not row_matches(
            installation,
            {
                "id": item["installation_id"],
                "client_id": item["client_id"],
                "tenant_id": item["tenant_id"],
                "membership_id": item["membership_local_id"],
                "principal_id": item["principal_id"],
                "identity_id": item["identity_id"],
                "status": "active",
            },
        ):
            raise ManifestError("installation provenance conflicts with manifest")

    if item["identity_id"] is not None:
        grants = {
            row["operation_scope"]
            for row in connection.execute(
                "SELECT operation_scope FROM identity_grants WHERE tenant_id = ? AND membership_id = ? AND identity_id = ?",
                (item["tenant_id"], item["membership_local_id"], item["identity_id"]),
            ).fetchall()
        }
        requested_scopes = set(item["scopes"])
        if binding is not None and binding["status"] == "active":
            if grants != requested_scopes:
                raise ManifestError("existing active identity grants differ from manifest")
        elif binding is not None and binding["status"] == "pending":
            if not grants.issubset(requested_scopes):
                raise ManifestError("pending identity grants exceed manifest")
        elif grants and grants != requested_scopes:
            raise ManifestError("existing identity grants differ from manifest")


def execute_sqlite(database: Path, item: dict[str, Any]) -> None:
    connection = sqlite3.connect(database)
    connection.row_factory = sqlite3.Row
    try:
        connection.execute("PRAGMA foreign_keys = ON")
        with connection:
            validate_existing_state(connection, item)
            tenant = connection.execute(
                "SELECT id, slug, display_name, status FROM tenants WHERE id = ?",
                (item["tenant_id"],),
            ).fetchone()
            if tenant is not None and not row_matches(
                tenant,
                {
                    "id": item["tenant_id"],
                    "slug": item["tenant_slug"],
                    "display_name": item["tenant_display_name"],
                    "status": "active",
                },
            ):
                raise ManifestError("existing tenant conflicts with manifest")
            connection.execute(
                "INSERT INTO tenants (id, slug, display_name, status, created_at, updated_at) VALUES (?, ?, ?, 'active', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')) ON CONFLICT(id) DO NOTHING",
                (item["tenant_id"], item["tenant_slug"], item["tenant_display_name"]),
            )
            principal = connection.execute(
                "SELECT id, issuer, subject, principal_type, display_name, status FROM principals WHERE id = ?",
                (item["principal_id"],),
            ).fetchone()
            if principal is not None and not row_matches(
                principal,
                {
                    "id": item["principal_id"],
                    "issuer": item["platform_authority"],
                    "subject": item["principal_subject"],
                    "principal_type": item["principal_kind"],
                    "display_name": item["principal_display_name"],
                    "status": "active",
                },
            ):
                raise ManifestError("existing principal conflicts with manifest")
            connection.execute(
                "INSERT INTO principals (id, issuer, subject, principal_type, display_name, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'active', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')) ON CONFLICT(id) DO NOTHING",
                (
                    item["principal_id"],
                    item["platform_authority"],
                    item["principal_subject"],
                    item["principal_kind"],
                    item["principal_display_name"],
                ),
            )
            membership = connection.execute(
                "SELECT id, tenant_id, principal_id, role, status FROM memberships WHERE id = ?",
                (item["membership_local_id"],),
            ).fetchone()
            if membership is not None and not row_matches(
                membership,
                {
                    "id": item["membership_local_id"],
                    "tenant_id": item["tenant_id"],
                    "principal_id": item["principal_id"],
                    "role": item["role"],
                    "status": "active",
                },
            ):
                raise ManifestError("existing membership conflicts with manifest")
            connection.execute(
                "INSERT INTO memberships (id, tenant_id, principal_id, role, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'active', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')) ON CONFLICT(id) DO NOTHING",
                (
                    item["membership_local_id"],
                    item["tenant_id"],
                    item["principal_id"],
                    item["role"],
                ),
            )
            if item["identity_id"] is not None:
                identity = connection.execute(
                    "SELECT id, tenant_id, identity_kind, display_name, status FROM identities WHERE id = ?",
                    (item["identity_id"],),
                ).fetchone()
                if identity is not None and not row_matches(
                    identity,
                    {
                        "id": item["identity_id"],
                        "tenant_id": item["tenant_id"],
                        "identity_kind": item["identity_kind"],
                        "display_name": item["identity_display_name"],
                        "status": "active",
                    },
                ):
                    raise ManifestError("existing identity conflicts with manifest")
                connection.execute(
                    "INSERT INTO identities (id, tenant_id, identity_kind, display_name, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'active', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')) ON CONFLICT(id) DO NOTHING",
                    (
                        item["identity_id"],
                        item["tenant_id"],
                        item["identity_kind"],
                        item["identity_display_name"],
                    ),
                )
            if item["installation_id"] is not None:
                client = connection.execute(
                    "SELECT client_id, status FROM oauth_clients WHERE client_id = ?",
                    (item["client_id"],),
                ).fetchone()
                installation = connection.execute(
                    "SELECT id, client_id, tenant_id, membership_id, principal_id, identity_id, status FROM oauth_client_installations WHERE id = ?",
                    (item["installation_id"],),
                ).fetchone()
                if client is None or client["status"] != "active":
                    raise ManifestError("installation client is missing or inactive")
                if installation is None or not row_matches(
                    installation,
                    {
                        "id": item["installation_id"],
                        "client_id": item["client_id"],
                        "tenant_id": item["tenant_id"],
                        "membership_id": item["membership_local_id"],
                        "principal_id": item["principal_id"],
                        "identity_id": item["identity_id"],
                        "status": "active",
                    },
                ):
                    raise ManifestError("installation provenance conflicts with manifest")
            existing = connection.execute(
                "SELECT * FROM platform_bindings WHERE binding_id = ?",
                (item["binding_id"],),
            ).fetchone()
            expected = {
                "binding_id": item["binding_id"],
                "platform_authority": item["platform_authority"],
                "platform_kind": item["platform_kind"],
                "platform_subject_id": item["platform_subject_id"],
                "platform_organization_id": item["platform_organization_id"],
                "platform_membership_id": item["platform_membership_id"],
                "platform_grant_id": item["platform_grant_id"],
                "local_tenant_id": item["tenant_id"],
                "local_principal_id": item["principal_id"],
                "local_membership_id": item["membership_local_id"],
                "local_identity_id": item["identity_id"],
                "local_installation_id": item["installation_id"],
                "local_client_id": item["client_id"],
            }
            if existing is None:
                connection.execute(
                    "INSERT INTO platform_bindings (binding_id, platform_authority, platform_kind, platform_subject_id, platform_organization_id, platform_membership_id, platform_grant_id, local_tenant_id, local_principal_id, local_membership_id, local_identity_id, local_installation_id, local_client_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'))",
                    tuple(expected.values()),
                )
            elif not row_matches(existing, expected):
                raise ManifestError("existing binding conflicts with manifest")
            elif existing["status"] == "revoked":
                raise ManifestError("revoked binding cannot be revived")
            if item["identity_id"] is not None:
                for scope in item["scopes"]:
                    connection.execute(
                        """INSERT INTO identity_grants
                           (tenant_id, membership_id, identity_id, operation_scope, created_at)
                           SELECT ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now')
                           WHERE EXISTS (
                             SELECT 1 FROM platform_bindings AS pending_binding
                              WHERE pending_binding.binding_id = ?
                                AND pending_binding.status = 'pending'
                                AND pending_binding.platform_authority IS ?
                                AND pending_binding.platform_kind IS ?
                                AND pending_binding.platform_subject_id IS ?
                                AND pending_binding.platform_organization_id IS ?
                                AND pending_binding.platform_membership_id IS ?
                                AND pending_binding.platform_grant_id IS ?
                                AND pending_binding.local_tenant_id IS ?
                                AND pending_binding.local_principal_id IS ?
                                AND pending_binding.local_membership_id IS ?
                                AND pending_binding.local_identity_id IS ?
                                AND pending_binding.local_installation_id IS ?
                                AND pending_binding.local_client_id IS ?
                           )
                             AND NOT EXISTS (
                               SELECT 1 FROM identity_grants
                                WHERE tenant_id = ? AND membership_id = ?
                                  AND identity_id = ? AND operation_scope = ?
                             )""",
                        (
                            item["tenant_id"],
                            item["membership_local_id"],
                            item["identity_id"],
                            scope,
                            item["binding_id"],
                            item["platform_authority"],
                            item["platform_kind"],
                            item["platform_subject_id"],
                            item["platform_organization_id"],
                            item["platform_membership_id"],
                            item["platform_grant_id"],
                            item["tenant_id"],
                            item["principal_id"],
                            item["membership_local_id"],
                            item["identity_id"],
                            item["installation_id"],
                            item["client_id"],
                            item["tenant_id"],
                            item["membership_local_id"],
                            item["identity_id"],
                            scope,
                        ),
                    )
            scope_activation = ""
            if item["identity_id"] is not None:
                scope_target = (
                    "ig.tenant_id = "
                    + quote(item["tenant_id"])
                    + " AND ig.membership_id = "
                    + quote(item["membership_local_id"])
                    + " AND ig.identity_id = "
                    + quote(item["identity_id"])
                )
                if item["scopes"]:
                    scope_activation = (
                        " AND NOT EXISTS (SELECT 1 FROM identity_grants AS extra WHERE "
                        + "extra.tenant_id = "
                        + quote(item["tenant_id"])
                        + " AND extra.membership_id = "
                        + quote(item["membership_local_id"])
                        + " AND extra.identity_id = "
                        + quote(item["identity_id"])
                        + " AND extra.operation_scope NOT IN ("
                        + ", ".join(quote(scope) for scope in item["scopes"])
                        + "))"
                        + " AND "
                        + " AND ".join(
                            "EXISTS (SELECT 1 FROM identity_grants AS required WHERE "
                            + scope_target.replace("ig.", "required.")
                            + " AND required.operation_scope = "
                            + quote(scope)
                            + ")"
                            for scope in item["scopes"]
                        )
                    )
                else:
                    scope_activation = (
                        " AND NOT EXISTS (SELECT 1 FROM identity_grants AS extra WHERE "
                        + "extra.tenant_id = "
                        + quote(item["tenant_id"])
                        + " AND extra.membership_id = "
                        + quote(item["membership_local_id"])
                        + " AND extra.identity_id = "
                        + quote(item["identity_id"])
                        + ")"
                    )
            activation = connection.execute(
                f"""UPDATE platform_bindings
                   SET status = 'active', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
                 WHERE binding_id = ? AND status = 'pending'
                   AND EXISTS (SELECT 1 FROM tenants AS t WHERE t.id = ? AND t.status = 'active')
                   AND EXISTS (SELECT 1 FROM principals AS p WHERE p.id = ? AND p.status = 'active' AND p.revoked_at IS NULL)
                   AND EXISTS (SELECT 1 FROM memberships AS m WHERE m.id = ? AND m.tenant_id = ? AND m.principal_id = ? AND m.role = ? AND m.status = 'active' AND m.revoked_at IS NULL)
                   AND (? IS NULL OR EXISTS (
                     SELECT 1 FROM identities AS i
                     JOIN identity_grants AS ig
                       ON ig.tenant_id = ? AND ig.membership_id = ? AND ig.identity_id = ?
                     WHERE i.id = ? AND i.tenant_id = ? AND i.identity_kind = ? AND i.status = 'active'
                   ))
                   AND (? IS NULL OR EXISTS (
                     SELECT 1 FROM oauth_client_installations AS oi
                     JOIN oauth_clients AS oc ON oc.client_id = ?
                     WHERE oi.id = ? AND oi.client_id = ? AND oi.tenant_id = ?
                       AND oi.membership_id = ? AND oi.principal_id = ? AND oi.identity_id IS ?
                       AND oi.status = 'active' AND oc.status = 'active'
                   )){scope_activation}""",
                (
                    item["binding_id"],
                    item["tenant_id"],
                    item["principal_id"],
                    item["membership_local_id"],
                    item["tenant_id"],
                    item["principal_id"],
                    item["role"],
                    item["identity_id"],
                    item["tenant_id"],
                    item["membership_local_id"],
                    item["identity_id"],
                    item["identity_id"],
                    item["tenant_id"],
                    item["identity_kind"],
                    item["installation_id"],
                    item["client_id"],
                    item["installation_id"],
                    item["client_id"],
                    item["tenant_id"],
                    item["membership_local_id"],
                    item["principal_id"],
                    item["identity_id"],
                ),
            )
            if existing is not None and existing["status"] == "pending" and activation.rowcount != 1:
                raise ManifestError("binding dependencies changed before activation")
            final = connection.execute(
                "SELECT status, revoked_at, platform_authority, platform_kind, platform_subject_id, platform_organization_id, platform_membership_id, platform_grant_id, local_tenant_id, local_principal_id, local_membership_id, local_identity_id, local_installation_id, local_client_id FROM platform_bindings WHERE binding_id = ?",
                (item["binding_id"],),
            ).fetchone()
            if final is None or not row_matches(
                final,
                {
                    "status": "active",
                    "revoked_at": None,
                    "platform_authority": item["platform_authority"],
                    "platform_kind": item["platform_kind"],
                    "platform_subject_id": item["platform_subject_id"],
                    "platform_organization_id": item["platform_organization_id"],
                    "platform_membership_id": item["platform_membership_id"],
                    "platform_grant_id": item["platform_grant_id"],
                    "local_tenant_id": item["tenant_id"],
                    "local_principal_id": item["principal_id"],
                    "local_membership_id": item["membership_local_id"],
                    "local_identity_id": item["identity_id"],
                    "local_installation_id": item["installation_id"],
                    "local_client_id": item["client_id"],
                },
            ):
                raise ManifestError("binding did not reach the requested active state")
            if item["identity_id"] is not None:
                final_scopes = {
                    row["operation_scope"]
                    for row in connection.execute(
                        "SELECT operation_scope FROM identity_grants WHERE tenant_id = ? AND membership_id = ? AND identity_id = ?",
                        (item["tenant_id"], item["membership_local_id"], item["identity_id"]),
                    ).fetchall()
                }
                if final_scopes != set(item["scopes"]):
                    raise ManifestError("active binding grants differ from manifest")
    finally:
        connection.close()


def wrangler_command(
    database: str,
    environment: str,
    sql: str,
    persist_to: Path | None = None,
) -> list[str]:
    if persist_to is not None:
        if environment != "local":
            raise ManifestError("--persist-to is only supported with --environment local")
        if not persist_to.is_absolute():
            raise ManifestError("--persist-to must be an absolute path")
    command = [
        "pnpm",
        "--filter",
        "@communicator/control-plane",
        "exec",
        "wrangler",
        "d1",
        "execute",
        database,
    ]
    if environment == "local":
        command.append("--local")
        if persist_to is not None:
            command.extend(("--persist-to", str(persist_to)))
    else:
        command.extend(("--env", environment, "--remote"))
    command.extend(("--command", sql))
    return command


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--environment", choices=("local", "staging", "production"), default="local")
    parser.add_argument("--database", default="CONTROL_DB", help="D1 database name for wrangler execution")
    parser.add_argument(
        "--persist-to",
        type=Path,
        help="absolute local Wrangler state directory/file used with --environment local",
    )
    parser.add_argument("--sqlite", type=Path, help="execute atomically against a SQLite/D1 export")
    parser.add_argument("--execute", action="store_true")
    args = parser.parse_args(argv)
    try:
        item = validate_manifest(load_manifest(args.manifest))
        statements = sql_plan(item)
        sql = "\n".join(statements)
        if not args.execute:
            print("DRY RUN: no Communicator or Cloudflare write performed")
            print(json.dumps({"binding_id": item["binding_id"], "tenant_id": item["tenant_id"], "platform_kind": item["platform_kind"]}, sort_keys=True))
            if args.sqlite is None:
                print(
                    f"Would run: {shlex.join(wrangler_command(args.database, args.environment, sql, args.persist_to))}"
                )
            else:
                print(f"Would execute atomically against SQLite: {args.sqlite}")
            print(sql)
            return 0
        if args.sqlite is not None:
            execute_sqlite(args.sqlite, item)
            print("Platform binding provisioned atomically")
            return 0
        return subprocess.run(
            wrangler_command(args.database, args.environment, sql, args.persist_to),
            check=False,
        ).returncode
    except (ManifestError, OSError, sqlite3.Error) as error:
        print(f"Platform binding provisioning failed: {error}")
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
