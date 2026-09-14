#!/usr/bin/env python3
"""Apply the removal authority before a core restore can become readable.

The restic core snapshot is deliberately mixed: it contains message-bearing
PostgreSQL dumps, media, bridge state, and protected session material.  This
gate runs while the restore is still an isolated tree.  It requires a current
authority export from the control plane, validates every controlled-store
generation, rewrites only the exact mapped rows/media, and emits a durable
report before the caller copies anything into the restore runtime.

The authority export is intentionally external to the restic snapshot.  An
authority file embedded in an old snapshot would itself be stale and could not
prevent resurrection after a later removal.
"""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import importlib.util
import json
import os
import shutil
import subprocess
import sys
import tempfile
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path, PurePosixPath
from typing import Any, Iterable, Mapping


ROOT = Path(__file__).resolve().parent
RETENTION_PATH = ROOT / "controlled-copy-retention.py"
REQUIRED_STORES = (
    "projection_backup",
    "synapse",
    "bridge_database",
    "media_store",
    "queue",
    "restic_snapshot",
)
AUXILIARY_STORES = ("session_credentials", "account_keys")
ALL_STORES = REQUIRED_STORES + AUXILIARY_STORES
STORE_STATUSES = {"complete", "preserved"}
TARGET_DATABASES = {
    "synapse": "synapse-event-json-v1",
    "whatsapp_bridge": "mautrix-bridge-message-v1",
    "messenger_bridge": "mautrix-bridge-message-v1",
    "telegram_bridge": "mautrix-bridge-message-v1",
}


class RestoreGateError(Exception):
    """An operator-visible restore gate failure without content disclosure."""


_IMMUTABLE_AUTHORITY_FIELDS = (
    "id",
    "tenant_id",
    "resource_type",
    "resource_id",
    "content_generation",
    "account_id",
    "conversation_id",
    "source_event_id",
    "source_object_key",
    "reason",
    "removed_at",
    "deletion_epoch",
    "created_at",
)


def _load_retention_module() -> Any:
    spec = importlib.util.spec_from_file_location(
        "communicator_controlled_copy_retention", RETENTION_PATH
    )
    if spec is None or spec.loader is None:
        raise RestoreGateError("controlled-copy sanitizer is unavailable")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _required_string(value: Any, name: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise RestoreGateError(f"restore {name} is required")
    return value.strip()


def _exact_lineage_string(value: Any, name: str) -> str:
    result = _required_string(value, name)
    if "*" in result:
        raise RestoreGateError(f"restore {name} must be exact resource lineage")
    return result


def _safe_relative(value: Any, name: str) -> str:
    path = _required_string(value, name)
    candidate = Path(path)
    if "\x00" in path or candidate.is_absolute() or "\\" in path:
        raise RestoreGateError(f"restore {name} is not relative")
    # Checking only the rendered prefix misses paths such as
    # ``a/../../outside``.  Reject traversal components before normalising;
    # the resolved containment check below remains the second line of defence
    # when this value is joined to an actual payload root.
    if ".." in candidate.parts:
        raise RestoreGateError(f"restore {name} escapes the payload")
    normalized = candidate.as_posix()
    if normalized in {"", "."}:
        raise RestoreGateError(f"restore {name} escapes the payload")
    return normalized


def _payload_path(root: Path, relative: str, name: str) -> Path:
    """Resolve a validated payload path and prove it stays under ``root``."""
    payload_root = root.resolve()
    candidate = root / relative
    try:
        resolved = candidate.resolve(strict=False)
    except OSError as error:
        raise RestoreGateError(f"restore {name} cannot be resolved") from error
    if resolved != payload_root and payload_root not in resolved.parents:
        raise RestoreGateError(f"restore {name} escapes the payload")
    return candidate


def _parse_timestamp(value: Any, name: str) -> str:
    timestamp = _required_string(value, name)
    try:
        parsed = dt.datetime.fromisoformat(timestamp.replace("Z", "+00:00"))
    except ValueError as error:
        raise RestoreGateError(f"restore {name} is invalid") from error
    if parsed.tzinfo is None:
        raise RestoreGateError(f"restore {name} must include a timezone")
    return timestamp


def _immutable_authority(authority: Mapping[str, Any]) -> dict[str, Any]:
    """Keep lifecycle progress out of the suppression identity/fingerprint."""
    return {field: authority.get(field) for field in _IMMUTABLE_AUTHORITY_FIELDS}


def _authority_fingerprint(authority: Mapping[str, Any]) -> str:
    """Return the current ledger/evidence view used at activation."""
    return _sha256_json(
        {
            "tenant_id": authority["tenant_id"],
            "deletion_epoch": authority["deletion_epoch"],
            "authority_ids": [item["id"] for item in authority["authorities"]],
            "authorities": [
                _immutable_authority(item) for item in authority["authorities"]
            ],
            "ledger_head": authority["ledger_head"],
            "inventory": authority.get("inventory", []),
            "stores": list(authority["stores"].values()),
            "archive": authority["archive"],
        }
    )


def _atomic_write(path: Path, document: Mapping[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(
        prefix="restore-gate-", dir=path.parent
    )
    os.close(descriptor)
    temporary = Path(temporary_name)
    try:
        temporary.write_text(json.dumps(document, indent=2) + "\n", encoding="utf-8")
        temporary.chmod(0o600)
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def _now() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat().replace("+00:00", "Z")


def _failpoint(stage: str, *, before: bool = False) -> None:
    configured = os.environ.get("COMMUNICATOR_RESTORE_GATE_FAIL_AT", "").strip()
    prefix = "before" if before else "after"
    if configured in {stage, f"{prefix}:{stage}", f"{prefix}_{stage}"}:
        raise RestoreGateError(f"injected restore gate failure at {prefix} {stage}")


def _authority_key(authority: Mapping[str, Any]) -> tuple[str, str, str]:
    return (
        _exact_lineage_string(authority.get("resource_type"), "authority resource type"),
        _exact_lineage_string(authority.get("resource_id"), "authority resource id"),
        _exact_lineage_string(
            authority.get("content_generation"), "authority content generation"
        ),
    )


def _validate_authority_document(
    value: Any,
    tenant_id: str | None = None,
    *,
    require_current: bool = False,
) -> dict[str, Any]:
    if not isinstance(value, dict) or value.get("version") != 1:
        raise RestoreGateError("restore authority export version is unsupported")
    actual_tenant = _required_string(value.get("tenant_id"), "authority tenant id")
    if tenant_id is not None and actual_tenant != tenant_id:
        raise RestoreGateError("restore authority tenant does not match restore target")
    raw_epoch = value.get("deletion_epoch")
    if not isinstance(raw_epoch, int) or isinstance(raw_epoch, bool) or raw_epoch < 0:
        raise RestoreGateError("restore authority deletion epoch is invalid")

    raw_authorities = value.get("authorities")
    if not isinstance(raw_authorities, list):
        raise RestoreGateError("restore authority records are missing")
    authorities: list[dict[str, Any]] = []
    by_key: dict[tuple[str, str, str], dict[str, Any]] = {}
    by_id: dict[str, dict[str, Any]] = {}
    for raw in raw_authorities:
        if not isinstance(raw, dict):
            raise RestoreGateError("restore authority record is invalid")
        record = dict(raw)
        authority_id = _required_string(record.get("id"), "authority id")
        if authority_id in by_id:
            previous = by_id[authority_id]
            if previous != record:
                raise RestoreGateError("restore authority id has conflicting records")
            continue
        if _required_string(record.get("tenant_id"), "authority record tenant") != actual_tenant:
            raise RestoreGateError("restore authority record tenant is inconsistent")
        record_epoch = record.get("deletion_epoch")
        if (
            not isinstance(record_epoch, int)
            or isinstance(record_epoch, bool)
            or record_epoch < 1
            or record_epoch > raw_epoch
        ):
            raise RestoreGateError("restore authority record epoch is invalid")
        _parse_timestamp(record.get("removed_at"), "authority removed_at")
        key = _authority_key(record)
        previous = by_key.get(key)
        if previous is not None:
            # Duplicate tombstones are idempotent only when they carry the
            # same immutable epoch/lineage.  A conflicting epoch is evidence
            # of a corrupt export and must block startup.
            if (
                previous.get("deletion_epoch") != record.get("deletion_epoch")
                or previous.get("id") != record.get("id")
            ):
                raise RestoreGateError("restore authority has conflicting duplicate tombstones")
            continue
        by_key[key] = record
        by_id[authority_id] = record
        authorities.append(record)

    authorities.sort(key=lambda item: (item["deletion_epoch"], item["id"]))

    raw_inventory = value.get("inventory")
    if not isinstance(raw_inventory, list):
        raise RestoreGateError("restore store inventory is missing")
    inventory: list[dict[str, Any]] = []
    by_authority: dict[str, dict[str, Any]] = {}
    expected_authority_ids = {item["id"] for item in authorities}
    # A zero-row removal ledger still has to bind its provider inventory to
    # the current tenant ledger.  The synthetic entry is never a tombstone
    # target; it only carries the exact current copy generations.
    inventory_ids = expected_authority_ids or {actual_tenant}
    for raw_entry in raw_inventory:
        if not isinstance(raw_entry, dict):
            raise RestoreGateError("restore store inventory entry is invalid")
        authority_id = _required_string(
            raw_entry.get("authority_id"), "inventory authority id"
        )
        if authority_id not in inventory_ids or authority_id in by_authority:
            raise RestoreGateError("restore store inventory authority is duplicated or unknown")
        raw_targets = raw_entry.get("targets")
        raw_store_entries = raw_entry.get("stores")
        if not isinstance(raw_targets, list) or not isinstance(raw_store_entries, list):
            raise RestoreGateError("restore store inventory coverage is invalid")
        stores_for_authority: list[dict[str, Any]] = []
        seen_stores: set[str] = set()
        for raw_store in raw_store_entries:
            if not isinstance(raw_store, dict):
                raise RestoreGateError("restore store inventory status is invalid")
            store = _required_string(raw_store.get("store"), "inventory store")
            if store not in ALL_STORES or store in seen_stores:
                raise RestoreGateError("restore store inventory store is duplicated or unknown")
            if not isinstance(raw_store.get("complete"), bool):
                raise RestoreGateError("restore store inventory completion is invalid")
            evidence_source = _required_string(
                raw_store.get("evidence_source"), "inventory evidence source"
            )
            detail = raw_store.get("detail")
            if detail is not None and (
                not isinstance(detail, str) or not detail.strip()
            ):
                raise RestoreGateError("restore store inventory detail is invalid")
            raw_references = raw_store.get("references", [])
            if not isinstance(raw_references, list) or any(
                not isinstance(reference, str) or not reference.strip()
                for reference in raw_references
            ):
                raise RestoreGateError("restore store inventory references are invalid")
            raw_copies = raw_store.get("copies")
            if not isinstance(raw_copies, list):
                raise RestoreGateError("restore store inventory copies are missing")
            copies: list[dict[str, str]] = []
            for raw_copy in raw_copies:
                if not isinstance(raw_copy, dict):
                    raise RestoreGateError("restore store inventory copy is invalid")
                copy_reference = _required_string(
                    raw_copy.get("reference"), "inventory copy reference"
                )
                copy_created_at = _parse_timestamp(
                    raw_copy.get("copy_created_at"), "inventory copy_created_at"
                )
                copy_resource_id = _exact_lineage_string(
                    raw_copy.get("resource_id"), "inventory copy resource id"
                )
                copy_generation = _exact_lineage_string(
                    raw_copy.get("content_generation"),
                    "inventory copy content generation",
                )
                copies.append(
                    {
                        "reference": copy_reference,
                        "copy_created_at": copy_created_at,
                        "resource_id": copy_resource_id,
                        "content_generation": copy_generation,
                    }
                )
            references = [reference.strip() for reference in raw_references]
            if sorted(set(references)) != sorted(
                {copy["reference"] for copy in copies}
            ):
                raise RestoreGateError("restore store inventory references do not match copies")
            seen_stores.add(store)
            stores_for_authority.append(
                {
                    "store": store,
                    "complete": raw_store["complete"],
                    "evidence_source": evidence_source,
                    "detail": detail,
                    "references": references,
                    "copies": copies,
                }
            )
        if set(seen_stores) != set(ALL_STORES):
            raise RestoreGateError("restore store inventory is incomplete")
        by_authority[authority_id] = {
            "authority_id": authority_id,
            "targets": [dict(target) for target in raw_targets],
            "stores": [
                next(
                    entry
                    for entry in stores_for_authority
                    if entry["store"] == store
                )
                for store in ALL_STORES
            ],
        }
    if set(by_authority) != inventory_ids:
        raise RestoreGateError("restore store inventory is incomplete")
    inventory = (
        [by_authority[item["id"]] for item in authorities]
        if authorities
        else [by_authority[actual_tenant]]
    )

    raw_stores = value.get("stores")
    if not isinstance(raw_stores, list):
        raise RestoreGateError("restore controlled-store evidence is missing")
    stores: dict[str, dict[str, Any]] = {}
    for raw in raw_stores:
        if not isinstance(raw, dict):
            raise RestoreGateError("restore controlled-store evidence is invalid")
        store = _required_string(raw.get("store"), "controlled-store name")
        if store not in ALL_STORES or store in stores:
            raise RestoreGateError("restore controlled-store evidence is duplicated or unknown")
        status = _required_string(raw.get("status"), f"{store} status")
        if status not in STORE_STATUSES:
            raise RestoreGateError(f"restore {store} evidence is incomplete")
        generation = _required_string(raw.get("generation"), f"{store} generation")
        if not isinstance(raw.get("content_present"), bool):
            raise RestoreGateError(f"restore {store} content presence is invalid")
        _required_string(raw.get("evidence_source"), f"{store} evidence source")
        raw_references = raw.get("references", [])
        if not isinstance(raw_references, list) or any(
            not isinstance(reference, str) or not reference.strip()
            for reference in raw_references
        ):
            raise RestoreGateError(f"restore {store} references are invalid")
        raw_copies = raw.get("copies")
        if not isinstance(raw_copies, list):
            raise RestoreGateError(f"restore {store} copy metadata is missing")
        copies: list[dict[str, str]] = []
        for raw_copy in raw_copies:
            if not isinstance(raw_copy, dict):
                raise RestoreGateError(f"restore {store} copy metadata is invalid")
            copies.append(
                {
                    "reference": _required_string(
                        raw_copy.get("reference"), f"{store} copy reference"
                    ),
                    "copy_created_at": _parse_timestamp(
                        raw_copy.get("copy_created_at"), f"{store} copy_created_at"
                    ),
                    "resource_id": _exact_lineage_string(
                        raw_copy.get("resource_id"), f"{store} copy resource id"
                    ),
                    "content_generation": _exact_lineage_string(
                        raw_copy.get("content_generation"),
                        f"{store} copy content generation",
                    ),
                }
            )
        references = [reference.strip() for reference in raw_references]
        if sorted(set(references)) != sorted(
            {copy["reference"] for copy in copies}
        ):
            raise RestoreGateError(f"restore {store} references do not match copy metadata")
        if status in STORE_STATUSES and not references:
            raise RestoreGateError(f"restore {store} copy references are missing")
        stores[store] = {
            "store": store,
            "generation": generation,
            "status": status,
            "content_present": raw["content_present"],
            "evidence_source": raw["evidence_source"],
            "detail": raw.get("detail"),
            "references": references,
            "copies": copies,
        }
    missing = set(ALL_STORES) - set(stores)
    if missing:
        raise RestoreGateError(
            "restore controlled-store evidence missing: " + ",".join(sorted(missing))
        )
    for store in ALL_STORES:
        inventory_copies = [
            copy
            for entry in inventory
            for inventory_store in entry["stores"]
            if inventory_store["store"] == store
            for copy in inventory_store["copies"]
        ]
        if sorted(inventory_copies, key=lambda copy: json.dumps(copy, sort_keys=True)) != sorted(
            stores[store]["copies"], key=lambda copy: json.dumps(copy, sort_keys=True)
        ):
            raise RestoreGateError(
                f"restore {store} status does not match inventory copy generations"
            )
    for store in REQUIRED_STORES:
        if stores[store]["status"] != "complete" or stores[store]["content_present"]:
            raise RestoreGateError(f"restore controlled store is not complete: {store}")
    for store in AUXILIARY_STORES:
        if stores[store]["status"] != "preserved" or not stores[store]["content_present"]:
            raise RestoreGateError(f"restore protected store is not preserved: {store}")

    raw_archive = value.get("archive")
    if not isinstance(raw_archive, dict):
        raise RestoreGateError("restore archive evidence is missing")
    if _required_string(raw_archive.get("status"), "archive status") != "complete":
        raise RestoreGateError("restore archive evidence is incomplete")
    _required_string(raw_archive.get("generation"), "archive generation")

    raw_ids = value.get("authority_ids")
    expected_ids = [item["id"] for item in authorities]
    if raw_ids is not None and raw_ids != expected_ids:
        raise RestoreGateError("restore authority ids do not match the ledger records")
    raw_count = value.get("authority_count")
    if raw_count is not None and raw_count != len(expected_ids):
        raise RestoreGateError("restore authority count does not match the ledger records")

    supplied_head = value.get("ledger_head")
    if supplied_head is not None and (
        not isinstance(supplied_head, str)
        or len(supplied_head) != 64
        or any(character not in "0123456789abcdef" for character in supplied_head)
    ):
        raise RestoreGateError("restore ledger head is invalid")
    expected_head = _sha256_json(
        {
            "tenant_id": actual_tenant,
            "deletion_epoch": raw_epoch,
            "authorities": [_immutable_authority(item) for item in authorities],
            **({"inventory": inventory} if raw_inventory is not None else {}),
        }
    )
    if supplied_head is not None and supplied_head != expected_head:
        raise RestoreGateError("restore ledger head does not match authority records")
    # Static fixture files predate the authenticated endpoint and receive a
    # deterministic local fingerprint.  A production endpoint must publish a
    # server-calculated head; the second fetch compares it at activation.
    if supplied_head is None:
        supplied_head = expected_head
    issued_at = value.get("issued_at")
    expires_at = value.get("expires_at")
    if require_current:
        issued = _parse_timestamp(issued_at, "authority issued_at")
        expires = _parse_timestamp(expires_at, "authority expires_at")
        issued_ms = dt.datetime.fromisoformat(issued.replace("Z", "+00:00")).timestamp()
        expires_ms = dt.datetime.fromisoformat(expires.replace("Z", "+00:00")).timestamp()
        now_ms = dt.datetime.now(dt.timezone.utc).timestamp()
        if expires_ms <= now_ms:
            raise RestoreGateError("restore authority export has expired")
        if issued_ms > now_ms + 300:
            raise RestoreGateError("restore authority export is from the future")
        if expires_ms - issued_ms > 600:
            raise RestoreGateError("restore authority export validity window is too long")

    return {
        "version": 1,
        "tenant_id": actual_tenant,
        "deletion_epoch": raw_epoch,
        "authorities": authorities,
        "stores": stores,
        "archive": dict(raw_archive),
        "authority_ids": expected_ids,
        "authority_count": len(expected_ids),
        "ledger_head": supplied_head,
        "inventory": inventory,
        "issued_at": issued_at,
        "expires_at": expires_at,
    }


def _sha256_json(value: Any) -> str:
    import hashlib

    encoded = json.dumps(value, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def load_authority(path: Path, tenant_id: str | None = None) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise RestoreGateError("restore authority export is unreadable") from error
    return _validate_authority_document(value, tenant_id)


def verify_activation_report(
    report: Path,
    authority: Mapping[str, Any],
    tenant_id: str,
) -> None:
    """Require the freshly fetched authority to match sanitized restore state."""
    try:
        document = json.loads(report.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise RestoreGateError("sanitized restore report is unreadable") from error
    if not isinstance(document, dict) or document.get("state") != "ready":
        raise RestoreGateError("sanitized restore report is not ready")
    if document.get("tenant_id") != tenant_id:
        raise RestoreGateError("sanitized restore report tenant is inconsistent")
    if document.get("deletion_epoch") != authority["deletion_epoch"]:
        raise RestoreGateError("restore authority changed before Synapse activation")
    if document.get("ledger_head") != authority["ledger_head"]:
        raise RestoreGateError("restore authority changed before Synapse activation")
    expected_fingerprint = document.get("authority_fingerprint")
    if (
        not isinstance(expected_fingerprint, str)
        or len(expected_fingerprint) != 64
        or any(character not in "0123456789abcdef" for character in expected_fingerprint)
    ):
        raise RestoreGateError("sanitized restore report has no authority fingerprint")
    if expected_fingerprint != _authority_fingerprint(authority):
        raise RestoreGateError("restore authority changed before Synapse activation")


def verify_restic_snapshot_reference(
    authority: Mapping[str, Any], snapshot_id: str | None
) -> None:
    """Bind the bytes being restored to the inventory generation observed by D1."""
    expected = authority["stores"]["restic_snapshot"].get("references", [])
    if not expected:
        raise RestoreGateError("restore restic snapshot inventory reference is missing")
    actual = _required_string(snapshot_id, "restic snapshot id")
    if len(actual) != 64 or any(character not in "0123456789abcdef" for character in actual):
        raise RestoreGateError("restore restic snapshot id must be the full authenticated id")
    if f"restic:{actual}" not in expected:
        raise RestoreGateError("restic snapshot is outside the current authority generation")


def _restic_configuration() -> tuple[str, str, str]:
    repository = _required_string(
        os.environ.get("RESTIC_REPOSITORY"), "restic repository"
    )
    password_file = _required_string(
        os.environ.get("RESTIC_PASSWORD_FILE"), "restic password file"
    )
    binary = _required_string(
        os.environ.get("COMMUNICATOR_RESTORE_RESTIC_BIN", "restic"),
        "restic binary",
    )
    if not Path(password_file).is_file():
        raise RestoreGateError("restore restic password file is unavailable")
    return repository, password_file, binary


def _restic_environment(repository: str, password_file: str) -> dict[str, str]:
    return {
        **os.environ,
        "RESTIC_REPOSITORY": repository,
        "RESTIC_PASSWORD_FILE": password_file,
    }


def _restic_command_error(result: subprocess.CompletedProcess[bytes], action: str) -> RestoreGateError:
    detail = result.stderr.decode("utf-8", errors="replace").strip()
    if detail:
        return RestoreGateError(f"restore restic {action} failed: {detail[:240]}")
    return RestoreGateError(f"restore restic {action} failed")


def _snapshot_relative_path(
    path: str, snapshot_roots: Iterable[str]
) -> str | None:
    candidate = PurePosixPath(path)
    if not candidate.is_absolute():
        raise RestoreGateError("restore restic snapshot path is not absolute")
    normalized = candidate.as_posix().rstrip("/")
    if not normalized:
        return None
    for raw_root in snapshot_roots:
        root = PurePosixPath(raw_root)
        if not root.is_absolute():
            raise RestoreGateError("restore restic snapshot root is not absolute")
        root_text = root.as_posix().rstrip("/")
        if normalized == root_text:
            return ""
        if normalized.startswith(root_text + "/"):
            relative = normalized[len(root_text) + 1 :]
            if relative and ".." not in PurePosixPath(relative).parts:
                return relative
        if root_text.startswith(normalized + "/"):
            # Restic lists the ancestors of an absolute backup path as
            # directory nodes.  They are metadata outside the selected
            # payload root and have no corresponding restored file.
            return None
    raise RestoreGateError("restore restic snapshot contains an unbound payload path")


def verify_restic_snapshot_payload(
    payload: Path, snapshot_id: str, *, timeout_seconds: float = 300
) -> dict[str, Any]:
    """Authenticate every restored payload file against the selected snapshot.

    ``restic restore`` writes the local tree, but a path or local sidecar alone
    does not prove which encrypted snapshot supplied those bytes.  The gate
    lists the exact selected snapshot and dumps every regular file through the
    authenticated repository, then compares hashes and complete file coverage
    before any sanitization mutates the payload.
    """
    repository, password_file, binary = _restic_configuration()
    environment = _restic_environment(repository, password_file)
    listing = tempfile.TemporaryFile()
    try:
        try:
            result = subprocess.run(
                [binary, "ls", "--json", snapshot_id],
                env=environment,
                stdout=listing,
                stderr=subprocess.PIPE,
                check=False,
                timeout=timeout_seconds,
            )
        except (OSError, subprocess.TimeoutExpired) as error:
            raise RestoreGateError("restore restic snapshot listing failed") from error
        if result.returncode != 0:
            raise _restic_command_error(result, "snapshot listing")
        listing.seek(0)
        roots: list[str] = []
        snapshot_files: dict[str, str] = {}
        for raw_line in listing:
            try:
                value = json.loads(raw_line.decode("utf-8"))
            except (UnicodeDecodeError, json.JSONDecodeError) as error:
                raise RestoreGateError("restore restic snapshot listing is invalid") from error
            if not isinstance(value, dict):
                raise RestoreGateError("restore restic snapshot listing entry is invalid")
            if value.get("message_type") == "snapshot" or value.get("struct_type") == "snapshot":
                raw_paths = value.get("paths")
                if not isinstance(raw_paths, list) or not raw_paths:
                    raise RestoreGateError("restore restic snapshot roots are missing")
                roots.extend(
                    _required_string(path, "restic snapshot root")
                    for path in raw_paths
                )
                continue
            if value.get("message_type") != "node" and value.get("struct_type") != "node":
                continue
            node_path = _required_string(value.get("path"), "restic snapshot node path")
            node_type = _required_string(value.get("type"), "restic snapshot node type")
            relative = _snapshot_relative_path(node_path, roots)
            if relative is None:
                if node_type == "dir":
                    continue
                raise RestoreGateError(
                    "restore restic snapshot contains an unbound payload path"
                )
            if node_type == "dir":
                continue
            if node_type != "file":
                raise RestoreGateError("restore restic snapshot contains unsupported node type")
            if relative in snapshot_files:
                raise RestoreGateError("restore restic snapshot contains duplicate file paths")
            snapshot_files[relative] = node_path
    finally:
        listing.close()

    if not roots:
        raise RestoreGateError("restore restic snapshot roots are missing")
    local_files = _exact_payload_files(payload)
    if set(snapshot_files) != local_files:
        raise RestoreGateError(
            "restored payload file coverage does not match authenticated restic snapshot"
        )

    hashes: dict[str, dict[str, Any]] = {}
    for relative, snapshot_path in sorted(snapshot_files.items()):
        local_path = _payload_path(payload, relative, "restored payload file")
        expected_hash = hashlib.sha256()
        size = 0
        with tempfile.TemporaryFile() as dumped:
            try:
                result = subprocess.run(
                    [binary, "dump", snapshot_id, snapshot_path],
                    env=environment,
                    stdout=dumped,
                    stderr=subprocess.PIPE,
                    check=False,
                    timeout=timeout_seconds,
                )
            except (OSError, subprocess.TimeoutExpired) as error:
                raise RestoreGateError(
                    "restore restic snapshot file retrieval failed"
                ) from error
            if result.returncode != 0:
                raise _restic_command_error(result, "snapshot file retrieval")
            dumped.seek(0)
            while chunk := dumped.read(1024 * 1024):
                expected_hash.update(chunk)
                size += len(chunk)
        actual_hash = hashlib.sha256()
        actual_size = 0
        with local_path.open("rb") as local_file:
            while chunk := local_file.read(1024 * 1024):
                actual_hash.update(chunk)
                actual_size += len(chunk)
        if size != actual_size or expected_hash.hexdigest() != actual_hash.hexdigest():
            raise RestoreGateError(
                "restored payload bytes do not match authenticated restic snapshot"
            )
        hashes[relative] = {"sha256": actual_hash.hexdigest(), "size": actual_size}
    return {
        "snapshot_id": snapshot_id,
        "files": hashes,
        "payload_digest": _sha256_json(hashes),
    }


def fetch_authority(
    url: str,
    token: str,
    tenant_id: str,
    timeout_seconds: float,
) -> dict[str, Any]:
    try:
        parsed = urllib.parse.urlparse(url)
    except Exception as error:
        raise RestoreGateError("restore authority endpoint is invalid") from error
    if parsed.scheme not in {"https", "http"} or not parsed.netloc:
        raise RestoreGateError("restore authority endpoint must be HTTP(S)")
    if parsed.scheme == "http" and os.environ.get("COMMUNICATOR_RESTORE_ALLOW_HTTP") != "1":
        raise RestoreGateError("restore authority endpoint must use HTTPS")
    if not token.strip():
        raise RestoreGateError("restore authority endpoint token is required")
    request = urllib.request.Request(
        url,
        headers={
            "Accept": "application/json",
            "Authorization": f"Bearer {token}",
            "Cache-Control": "no-cache",
        },
        method="GET",
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout_seconds) as response:
            if response.status != 200:
                raise RestoreGateError("restore authority endpoint was unavailable")
            body = response.read(10_000_001)
    except RestoreGateError:
        raise
    except (OSError, urllib.error.URLError, urllib.error.HTTPError) as error:
        raise RestoreGateError("restore authority endpoint was unavailable") from error
    if len(body) > 10_000_000:
        raise RestoreGateError("restore authority endpoint response is too large")
    try:
        value = json.loads(body.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise RestoreGateError("restore authority endpoint response is invalid") from error
    if not isinstance(value, dict) or "ledger_head" not in value:
        raise RestoreGateError("restore authority endpoint did not provide a current ledger head")
    return _validate_authority_document(value, tenant_id, require_current=True)


def _post_json(
    url: str,
    token: str,
    body: Mapping[str, Any],
    timeout_seconds: float,
) -> dict[str, Any]:
    try:
        parsed = urllib.parse.urlparse(url)
    except Exception as error:
        raise RestoreGateError("restore activation lease endpoint is invalid") from error
    if parsed.scheme not in {"https", "http"} or not parsed.netloc:
        raise RestoreGateError("restore activation lease endpoint must be HTTP(S)")
    if parsed.scheme == "http" and os.environ.get("COMMUNICATOR_RESTORE_ALLOW_HTTP") != "1":
        raise RestoreGateError("restore activation lease endpoint must use HTTPS")
    if not token.strip():
        raise RestoreGateError("restore activation lease endpoint token is required")
    request = urllib.request.Request(
        url,
        data=json.dumps(dict(body), separators=(",", ":")).encode("utf-8"),
        headers={
            "Accept": "application/json",
            "Authorization": f"Bearer {token}",
            "Cache-Control": "no-cache",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout_seconds) as response:
            if response.status != 200:
                raise RestoreGateError("restore activation lease endpoint was unavailable")
            response_body = response.read(2_000_001)
    except RestoreGateError:
        raise
    except (OSError, urllib.error.URLError, urllib.error.HTTPError) as error:
        raise RestoreGateError("restore activation lease endpoint was unavailable") from error
    if len(response_body) > 2_000_000:
        raise RestoreGateError("restore activation lease response is too large")
    try:
        value = json.loads(response_body.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise RestoreGateError("restore activation lease response is invalid") from error
    if not isinstance(value, dict):
        raise RestoreGateError("restore activation lease response is invalid")
    return value


def acquire_activation_lease(
    url: str,
    token: str,
    tenant_id: str,
    lease_id: str,
    authority: Mapping[str, Any],
    timeout_seconds: float,
) -> dict[str, Any]:
    value = _post_json(
        url,
        token,
        {
            "lease_id": lease_id,
            "expected_deletion_epoch": authority["deletion_epoch"],
            "expected_ledger_head": authority["ledger_head"],
            "ttl_seconds": 600,
        },
        timeout_seconds,
    )
    if (
        value.get("tenant_id") != tenant_id
        or value.get("lease_id") != lease_id
        or value.get("deletion_epoch") != authority["deletion_epoch"]
        or value.get("ledger_head") != authority["ledger_head"]
    ):
        raise RestoreGateError("restore activation lease is bound to a different authority")
    lease_token = value.get("lease_token")
    if not isinstance(lease_token, str) or len(lease_token.strip()) < 32:
        raise RestoreGateError("restore activation lease token is invalid")
    _parse_timestamp(value.get("expires_at"), "restore activation lease expiry")
    return {
        "lease_id": lease_id,
        "tenant_id": tenant_id,
        "lease_token": lease_token,
        "deletion_epoch": authority["deletion_epoch"],
        "ledger_head": authority["ledger_head"],
        "expires_at": value["expires_at"],
    }


def release_activation_lease(
    url: str,
    token: str,
    lease_id: str,
    lease_token: str,
    timeout_seconds: float,
) -> bool:
    value = _post_json(
        url,
        token,
        {"lease_id": lease_id, "lease_token": lease_token},
        timeout_seconds,
    )
    if value.get("lease_id") != lease_id or not isinstance(value.get("released"), bool):
        raise RestoreGateError("restore activation lease release response is invalid")
    return bool(value["released"])


def _exact_payload_files(root: Path) -> set[str]:
    if not root.is_dir():
        raise RestoreGateError("restore payload is missing")
    found: set[str] = set()
    for current, directories, files in os.walk(root, followlinks=False):
        current_path = Path(current)
        for directory in directories:
            if (current_path / directory).is_symlink():
                raise RestoreGateError("restore payload contains a symlink directory")
        for filename in files:
            path = current_path / filename
            if path.is_symlink() or not path.is_file():
                raise RestoreGateError("restore payload contains a non-regular file")
            found.add(path.relative_to(root).as_posix())
    return found


def validate_payload(root: Path) -> dict[str, Any]:
    layout_path = root / "retention/controlled-copy-layout.json"
    try:
        layout = json.loads(layout_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise RestoreGateError("restore controlled-copy layout is unreadable") from error
    if not isinstance(layout, dict) or layout.get("version") != 1:
        raise RestoreGateError("restore controlled-copy layout is invalid")
    if layout.get("format") != "communicator-core-pgdump-v1":
        raise RestoreGateError("restore controlled-copy layout format is unsupported")
    raw_databases = layout.get("databases")
    raw_files = layout.get("files")
    if not isinstance(raw_databases, list) or not isinstance(raw_files, list):
        raise RestoreGateError("restore controlled-copy layout coverage is invalid")
    databases: list[dict[str, str]] = []
    database_names: set[str] = set()
    for raw in raw_databases:
        if not isinstance(raw, dict):
            raise RestoreGateError("restore database contract is invalid")
        name = _required_string(raw.get("name"), "database name")
        path = _safe_relative(raw.get("path"), "database dump path")
        contract = _required_string(raw.get("contract"), "database contract")
        if name not in TARGET_DATABASES or TARGET_DATABASES[name] != contract:
            raise RestoreGateError("restore database contract is unsupported")
        if name in database_names or any(item["path"] == path for item in databases):
            raise RestoreGateError("restore database contract is duplicated")
        database_names.add(name)
        databases.append({"name": name, "path": path, "contract": contract})
    if set(database_names) != set(TARGET_DATABASES):
        raise RestoreGateError("restore database contract is incomplete")
    listed = {_safe_relative(item, "layout file") for item in raw_files}
    if len(listed) != len(raw_files):
        raise RestoreGateError("restore layout file coverage is duplicated")
    actual = _exact_payload_files(root)
    listed.add("retention/controlled-copy-layout.json")
    if actual != listed:
        raise RestoreGateError("restore payload is not covered exactly by its layout")
    for database in databases:
        dump = _payload_path(root, database["path"], "database dump path")
        if not dump.is_file() or dump.is_symlink():
            raise RestoreGateError(f"restore database dump is missing: {database['name']}")
    return {"databases": databases, "files": sorted(listed)}


def _targets_for(authorities: Iterable[Mapping[str, Any]]) -> list[dict[str, Any]]:
    targets: list[dict[str, Any]] = []
    seen: set[tuple[str, str, str, str]] = set()
    for authority in authorities:
        raw_targets = authority.get("targets")
        if not isinstance(raw_targets, list) or not raw_targets:
            raise RestoreGateError(
                f"restore authority has no exact store targets: {authority.get('id', 'unknown')}"
            )
        for raw in raw_targets:
            if not isinstance(raw, dict):
                raise RestoreGateError("restore authority target is invalid")
            target = dict(raw)
            authority_resource = _exact_lineage_string(
                authority.get("resource_id"), "authority resource id"
            )
            authority_generation = _exact_lineage_string(
                authority.get("content_generation"), "authority content generation"
            )
            if "resource_id" in target and target.get("resource_id") != authority_resource:
                raise RestoreGateError("restore target resource does not match authority")
            if (
                "content_generation" in target
                and str(target.get("content_generation")) != authority_generation
            ):
                raise RestoreGateError("restore target generation does not match authority")
            if "resource_id" not in target or "content_generation" not in target:
                raise RestoreGateError(
                    "restore target must publish exact resource lineage"
                )
            target["resource_id"] = _exact_lineage_string(
                target.get("resource_id"), "target resource id"
            )
            target["content_generation"] = _exact_lineage_string(
                target.get("content_generation"), "target content generation"
            )
            target["authority_id"] = _required_string(authority.get("id"), "authority id")
            target["database"] = _required_string(target.get("database"), "target database")
            if target["database"] not in TARGET_DATABASES:
                raise RestoreGateError("restore target database is unsupported")
            target["contract"] = _required_string(target.get("contract"), "target contract")
            if TARGET_DATABASES[target["database"]] != target["contract"]:
                raise RestoreGateError("restore target contract does not match database")
            media_paths = target.get("media_paths")
            if not isinstance(media_paths, list) or target.get("media_paths_complete") is not True:
                raise RestoreGateError("restore target media mapping is not exhaustive")
            target["media_paths"] = [
                _safe_relative(item, "target media path") for item in media_paths
            ]
            key = (
                target["authority_id"],
                target["database"],
                target["resource_id"],
                target["content_generation"],
            )
            if key in seen:
                raise RestoreGateError("restore authority target is duplicated")
            seen.add(key)
            targets.append(target)
    return targets


def sanitize_payload(
    root: Path, layout: Mapping[str, Any], authorities: Iterable[Mapping[str, Any]], work_root: Path
) -> dict[str, Any]:
    retention = _load_retention_module()
    targets = _targets_for(authorities)
    by_database: dict[str, list[dict[str, Any]]] = {}
    for target in targets:
        by_database.setdefault(str(target["database"]), []).append(target)
        if target.get("media_paths") is not None:
            if not isinstance(target["media_paths"], list):
                raise RestoreGateError("restore target media mapping is invalid")
            for raw_path in target["media_paths"]:
                relative = _safe_relative(raw_path, "target media path")
                if not relative.startswith("synapse-data/media_store/"):
                    raise RestoreGateError("restore media target escapes Synapse media store")
                candidate = _payload_path(root, relative, "target media path")
                if not candidate.is_file() or candidate.is_symlink():
                    raise RestoreGateError("restore target media mapping is incomplete")

    changed_databases: list[str] = []
    if by_database:
        socket_dir = os.environ.get("COMMUNICATOR_RETENTION_PG_SOCKET_DIR", "").strip()
        if socket_dir:
            Path(socket_dir).mkdir(parents=True, exist_ok=True)
        try:
            with retention.IsolatedPostgres(work_root / "postgres") as postgres:
                database_by_name = {
                    str(item["name"]): item for item in layout["databases"]
                }
                for index, (database_name, database_targets) in enumerate(by_database.items()):
                    database_spec = database_by_name.get(database_name)
                    if database_spec is None:
                        raise RestoreGateError("restore target database is absent from layout")
                    database = f"restore_gate_{index}"
                    postgres.create_database(database)
                    dump = _payload_path(
                        root, str(database_spec["path"]), "database dump path"
                    )
                    postgres.restore(database, dump)
                    retention.rewrite_core_database(
                        postgres,
                        database,
                        str(database_spec["contract"]),
                        database_targets,
                    )
                    replacement = work_root / str(database_spec["path"])
                    replacement.parent.mkdir(parents=True, exist_ok=True)
                    postgres.dump(database, replacement)
                    verify_database = f"restore_gate_verify_{index}"
                    postgres.create_database(verify_database)
                    postgres.restore(verify_database, replacement)
                    retention.verify_core_database(
                        postgres,
                        verify_database,
                        str(database_spec["contract"]),
                        database_targets,
                    )
                    os.replace(replacement, dump)
                    changed_databases.append(database_name)
        except Exception as error:
            if isinstance(error, RestoreGateError):
                raise
            raise RestoreGateError("restore database sanitation failed") from error

    media_targets = [target for target in targets if target.get("media_paths")]
    if media_targets:
        try:
            retention.remove_core_media(root, media_targets)
        except Exception as error:
            if isinstance(error, RestoreGateError):
                raise
            raise RestoreGateError("restore media sanitation failed") from error
    return {
        "database_targets": len(targets),
        "changed_databases": sorted(changed_databases),
        "media_targets": sum(len(target.get("media_paths", [])) for target in media_targets),
    }


def run_payload_gate(
    payload: Path,
    authority: dict[str, Any],
    report: Path,
    restic_snapshot_id: str,
    refresh_authority: Any = None,
) -> dict[str, Any]:
    stages: list[dict[str, Any]] = []

    def stage(name: str, detail: Mapping[str, Any] | None = None) -> None:
        _failpoint(name, before=True)
        item = {"name": name, "status": "complete", "completed_at": _now()}
        if detail:
            item["detail"] = dict(detail)
        stages.append(item)
        _failpoint(name)

    stage(
        "authority_loaded",
        {"tenant_id": authority["tenant_id"], "deletion_epoch": authority["deletion_epoch"]},
    )
    layout = validate_payload(payload)
    stage("payload_validated", {"files": len(layout["files"]), "format": "communicator-core-pgdump-v1"})
    stage("store_evidence_validated", {"stores": list(ALL_STORES)})
    restic_proof = verify_restic_snapshot_payload(payload, restic_snapshot_id)
    stage(
        "restic_payload_proof",
        {
            "snapshot_id": restic_proof["snapshot_id"],
            "files": len(restic_proof["files"]),
            "payload_digest": restic_proof["payload_digest"],
        },
    )
    work_parent = Path(
        tempfile.mkdtemp(prefix="communicator-restore-gate-", dir=os.environ.get("TMPDIR") or None)
    )
    try:
        sanitation = sanitize_payload(
            payload,
            layout,
            authority["authorities"],
            work_parent,
        )
    finally:
        shutil.rmtree(work_parent, ignore_errors=True)
    stage("content_sanitized", sanitation)
    if refresh_authority is not None:
        # A removal can be recorded while restic is being restored or while
        # the isolated database is being rewritten.  Re-read the primary
        # authority immediately before declaring the payload readable and
        # fail closed if either the deletion head or store evidence moved.
        current = refresh_authority()
        if _authority_fingerprint(current) != _authority_fingerprint(authority):
            raise RestoreGateError(
                "restore authority changed during sanitation; restart from a fresh snapshot"
            )
    stage(
        "tombstones_reapplied",
        {"authority_count": len(authority["authorities"]), "duplicate_policy": "idempotent"},
    )
    stage("ready", {"readable_after": "restore-gate-report"})
    result = {
        "version": 1,
        "state": "ready",
        "tenant_id": authority["tenant_id"],
        "deletion_epoch": authority["deletion_epoch"],
        "ledger_head": authority["ledger_head"],
        "authority_fingerprint": _authority_fingerprint(authority),
        "authority_ids": [item["id"] for item in authority["authorities"]],
        "stores": list(authority["stores"].values()),
        "archive": authority["archive"],
        "stages": stages,
        "completed_at": _now(),
    }
    _atomic_write(report, result)
    return result


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    authority_sources = parser.add_mutually_exclusive_group(required=False)
    authority_sources.add_argument("--authority", type=Path)
    authority_sources.add_argument("--authority-url")
    parser.add_argument("--authority-token", default="")
    parser.add_argument("--authority-timeout", type=float, default=30.0)
    parser.add_argument("--tenant", required=True)
    parser.add_argument("--report", required=True, type=Path)
    parser.add_argument("--payload", type=Path)
    parser.add_argument("--restic-snapshot-id")
    parser.add_argument("--authority-only", action="store_true")
    parser.add_argument("--activation-lease-url")
    parser.add_argument("--activation-lease-release-url")
    parser.add_argument("--activation-lease-id")
    parser.add_argument("--activation-lease-token")
    parser.add_argument(
        "--activation-lease-action",
        choices=("release",),
        help="release a previously acquired activation lease without reading an authority export",
    )
    parser.add_argument(
        "--activation-report",
        type=Path,
        help="require the freshly fetched authority to match this sanitized report",
    )
    args = parser.parse_args(argv)
    try:
        _failpoint("authority_load", before=True)
        if args.authority_timeout <= 0 or args.authority_timeout > 300:
            raise RestoreGateError("restore authority timeout is invalid")
        if args.activation_lease_action == "release":
            if (
                not args.activation_lease_url
                and not args.activation_lease_release_url
            ):
                raise RestoreGateError("restore activation lease release endpoint is required")
            lease_id = _required_string(args.activation_lease_id, "activation lease id")
            lease_token = _required_string(
                args.activation_lease_token, "activation lease token"
            )
            release_url = args.activation_lease_release_url or (
                args.activation_lease_url.rstrip("/") + "/release"
            )
            released = release_activation_lease(
                release_url,
                args.authority_token,
                lease_id,
                lease_token,
                args.authority_timeout,
            )
            _atomic_write(
                args.report,
                {
                    "version": 1,
                    "state": "activation_lease_released",
                    "lease_id": lease_id,
                    "released": released,
                    "completed_at": _now(),
                },
            )
            return 0
        if args.authority is None and args.authority_url is None:
            raise RestoreGateError("restore authority source is required")
        if args.authority_url is not None:
            authority_loader = lambda: fetch_authority(
                args.authority_url,
                args.authority_token,
                args.tenant,
                args.authority_timeout,
            )
            authority = authority_loader()
        else:
            if args.authority is None:
                raise RestoreGateError("restore authority source is required")
            authority_loader = lambda: load_authority(args.authority, args.tenant)
            authority = authority_loader()
        _failpoint("authority_load")
        if args.activation_report is not None:
            if args.authority_url is None or args.activation_lease_url is None:
                raise RestoreGateError(
                    "restore activation requires authenticated authority and lease endpoints"
                )
            lease_id = _required_string(args.activation_lease_id, "activation lease id")
            verify_activation_report(args.activation_report, authority, args.tenant)
            lease = acquire_activation_lease(
                args.activation_lease_url,
                args.authority_token,
                args.tenant,
                lease_id,
                authority,
                args.authority_timeout,
            )
            result = {
                "version": 1,
                "state": "activation_ready",
                "tenant_id": authority["tenant_id"],
                "deletion_epoch": authority["deletion_epoch"],
                "ledger_head": authority["ledger_head"],
                "authority_fingerprint": _authority_fingerprint(authority),
                "sanitized_report": "verified",
                "activation_lease": lease,
                "completed_at": _now(),
            }
            _atomic_write(args.report, result)
            return 0
        if args.authority_only:
            result = {
                "version": 1,
                "state": "authority_ready",
                "tenant_id": authority["tenant_id"],
                "deletion_epoch": authority["deletion_epoch"],
                "authority_ids": [item["id"] for item in authority["authorities"]],
                "ledger_head": authority["ledger_head"],
                "authority_fingerprint": _authority_fingerprint(authority),
                "inventory": authority.get("inventory", []),
                "stores": list(authority["stores"].values()),
                "archive": authority["archive"],
                "issued_at": authority["issued_at"],
                "expires_at": authority["expires_at"],
                "completed_at": _now(),
            }
            _atomic_write(args.report, result)
            return 0
        if args.payload is None:
            raise RestoreGateError("restore payload is required")
        verify_restic_snapshot_reference(authority, args.restic_snapshot_id)
        run_payload_gate(
            args.payload,
            authority,
            args.report,
            args.restic_snapshot_id,
            refresh_authority=authority_loader if args.authority_url is not None else None,
        )
        return 0
    except RestoreGateError as error:
        failure = {
            "version": 1,
            "state": "blocked",
            "error": str(error),
            "completed_at": _now(),
        }
        try:
            _atomic_write(args.report, failure)
        except OSError:
            pass
        print(str(error), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
