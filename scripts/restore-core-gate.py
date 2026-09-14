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
import importlib.util
import json
import os
import shutil
import sys
import tempfile
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
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


def _authority_fingerprint(authority: Mapping[str, Any]) -> str:
    """Return the current ledger/evidence view used at activation."""
    return json.dumps(
        {
            "tenant_id": authority["tenant_id"],
            "deletion_epoch": authority["deletion_epoch"],
            "authority_ids": [item["id"] for item in authority["authorities"]],
            "authorities": authority["authorities"],
            "ledger_head": authority["ledger_head"],
            "stores": list(authority["stores"].values()),
            "archive": authority["archive"],
        },
        sort_keys=True,
        separators=(",", ":"),
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
        _required_string(authority.get("resource_type"), "authority resource type"),
        _required_string(authority.get("resource_id"), "authority resource id"),
        _required_string(
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
        stores[store] = {
            "store": store,
            "generation": generation,
            "status": status,
            "content_present": raw["content_present"],
            "evidence_source": raw["evidence_source"],
            "detail": raw.get("detail"),
        }
    missing = set(ALL_STORES) - set(stores)
    if missing:
        raise RestoreGateError(
            "restore controlled-store evidence missing: " + ",".join(sorted(missing))
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
            "authorities": authorities,
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
            authority_resource = _required_string(
                authority.get("resource_id"), "authority resource id"
            )
            authority_generation = _required_string(
                authority.get("content_generation"), "authority content generation"
            )
            if "resource_id" in target and target.get("resource_id") != authority_resource:
                raise RestoreGateError("restore target resource does not match authority")
            if (
                "content_generation" in target
                and str(target.get("content_generation")) != authority_generation
            ):
                raise RestoreGateError("restore target generation does not match authority")
            target["resource_id"] = _required_string(
                target.get("resource_id", authority_resource),
                "target resource id",
            )
            target["content_generation"] = _required_string(
                target.get("content_generation", authority_generation),
                "target content generation",
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
    authority_sources = parser.add_mutually_exclusive_group(required=True)
    authority_sources.add_argument("--authority", type=Path)
    authority_sources.add_argument("--authority-url")
    parser.add_argument("--authority-token", default="")
    parser.add_argument("--authority-timeout", type=float, default=30.0)
    parser.add_argument("--tenant", required=True)
    parser.add_argument("--report", required=True, type=Path)
    parser.add_argument("--payload", type=Path)
    parser.add_argument("--authority-only", action="store_true")
    args = parser.parse_args(argv)
    try:
        _failpoint("authority_load", before=True)
        if args.authority_timeout <= 0 or args.authority_timeout > 300:
            raise RestoreGateError("restore authority timeout is invalid")
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
        if args.authority_only:
            result = {
                "version": 1,
                "state": "authority_ready",
                "tenant_id": authority["tenant_id"],
                "deletion_epoch": authority["deletion_epoch"],
                "authority_ids": [item["id"] for item in authority["authorities"]],
                "ledger_head": authority["ledger_head"],
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
        run_payload_gate(
            args.payload,
            authority,
            args.report,
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
