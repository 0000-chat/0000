#!/usr/bin/env python3
"""Serve the controlled-copy-v1 boundary for the host-side communicator stores.

The control-plane Worker cannot inspect a Postgres volume, Synapse media path,
Cloudflare queue, or restic repository.  This process is the concrete host
boundary for those stores.  It only deletes a copy when a manifest identifies
one exact resource/generation and the configured store implementation can
prove that the reference is isolated.  Unknown or mixed material is reported
as incomplete and is never guessed away.

Run this process beside the core services, with
``COMMUNICATOR_RETENTION_SERVICE_TOKEN`` and the store-specific roots or
commands configured.  It deliberately uses only the Python standard library
so it can run in the existing operations image.
"""

from __future__ import annotations

import argparse
import datetime as dt
import fcntl
import hashlib
import json
import os
import shlex
import shutil
import subprocess
import sys
import tempfile
import urllib.error
import urllib.parse
import urllib.request
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Callable, Iterable, Mapping


PROTOCOL = "controlled-copy-v1"
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
STORE_ENV_NAMES = {
    "projection_backup": "PROJECTION_BACKUP",
    "synapse": "SYNAPSE",
    "bridge_database": "BRIDGE_DATABASE",
    "media_store": "MEDIA_STORE",
    "queue": "QUEUE",
    "restic_snapshot": "RESTIC_SNAPSHOT",
    "session_credentials": "SESSION_CREDENTIALS",
    "account_keys": "ACCOUNT_KEYS",
}


class RetentionError(Exception):
    """An operator-visible, secret-free backend error."""


def utc_now() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat().replace("+00:00", "Z")


def required_string(value: Any, name: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise RetentionError(f"controlled-copy {name} is required")
    return value.strip()


def safe_segment(value: str, name: str) -> str:
    value = required_string(value, name)
    if value in {".", ".."} or "/" in value or "\\" in value:
        raise RetentionError(f"controlled-copy {name} is not a safe segment")
    return value


def parse_json_file(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return {"stores": {}}
    except (OSError, json.JSONDecodeError) as error:
        raise RetentionError("controlled-copy manifest is unreadable") from error
    if not isinstance(value, dict):
        raise RetentionError("controlled-copy manifest must be an object")
    return value


def manifest_path() -> Path:
    configured = os.environ.get("COMMUNICATOR_RETENTION_MANIFEST", "").strip()
    if configured:
        return Path(configured)
    runtime = os.environ.get("COMMUNICATOR_RUNTIME_DIR", "/srv/communicator")
    return Path(runtime) / "retention" / "controlled-copy-manifest.json"


def store_env(store: str, suffix: str) -> str:
    name = STORE_ENV_NAMES[store]
    return os.environ.get(f"COMMUNICATOR_RETENTION_{name}_{suffix}", "").strip()


def configured_command(store: str) -> list[str] | None:
    command = store_env(store, "COMMAND")
    if not command:
        return None
    try:
        parts = shlex.split(command)
    except ValueError as error:
        raise RetentionError(f"controlled-copy {store} command is invalid") from error
    if not parts:
        raise RetentionError(f"controlled-copy {store} command is empty")
    return parts


def run_store_command(
    store: str, operation: str, request: Mapping[str, Any]
) -> dict[str, Any] | None:
    command = configured_command(store)
    if command is None:
        return None
    try:
        result = subprocess.run(
            [*command, operation],
            input=json.dumps(request),
            text=True,
            capture_output=True,
            check=False,
            timeout=60,
        )
    except (OSError, subprocess.TimeoutExpired) as error:
        raise RetentionError(f"controlled-copy {store} command failed") from error
    if result.returncode != 0:
        raise RetentionError(f"controlled-copy {store} command returned {result.returncode}")
    try:
        value = json.loads(result.stdout)
    except json.JSONDecodeError as error:
        raise RetentionError(f"controlled-copy {store} command returned invalid JSON") from error
    if not isinstance(value, dict):
        raise RetentionError(f"controlled-copy {store} command response is invalid")
    return value


def entry_matches(entry: Mapping[str, Any], scope: Mapping[str, Any]) -> bool:
    return all(
        entry.get(key) == scope.get(key) or entry.get(key) == "*"
        for key in ("resource_id", "content_generation")
    )


def normalized_copy(entry: Mapping[str, Any]) -> dict[str, Any]:
    reference = required_string(entry.get("reference"), "copy reference")
    created = required_string(entry.get("copy_created_at"), "copy creation time")
    result: dict[str, Any] = {
        "reference": reference,
        "copy_created_at": created,
    }
    for key in (
        "resource_id",
        "content_generation",
        "content_class",
        "path",
        "room_id",
        "event_id",
        "snapshot_id",
        "exclusive_resource_id",
        "queue_ref",
        "queue_id",
        "bridge_id",
        "message_id",
        "part_id",
    ):
        if key in entry and entry[key] != "*":
            result[key] = entry[key]
    if "content_classes" in entry:
        classes = entry["content_classes"]
        if not isinstance(classes, list) or not all(isinstance(item, str) for item in classes):
            raise RetentionError("controlled-copy content classes are invalid")
        result["content_classes"] = classes
    return result


def entries_for(
    document: Mapping[str, Any], store: str, scope: Mapping[str, Any]
) -> tuple[list[dict[str, Any]], bool]:
    stores = document.get("stores", {})
    if not isinstance(stores, dict):
        raise RetentionError("controlled-copy manifest stores are invalid")
    raw_store = stores.get(store, {})
    if not isinstance(raw_store, dict):
        raise RetentionError(f"controlled-copy {store} manifest is invalid")
    raw_entries = raw_store.get("copies", [])
    if not isinstance(raw_entries, list):
        raise RetentionError(f"controlled-copy {store} copies are invalid")
    matches: list[dict[str, Any]] = []
    for raw_entry in raw_entries:
        if not isinstance(raw_entry, dict):
            raise RetentionError(f"controlled-copy {store} copy is invalid")
        if entry_matches(raw_entry, scope):
            matches.append(normalized_copy(raw_entry))
    complete = raw_store.get("enumeration_complete") is True
    return matches, complete


def file_root(store: str) -> Path | None:
    configured = store_env(store, "ROOT")
    if not configured:
        runtime = os.environ.get("COMMUNICATOR_RUNTIME_DIR", "").strip()
        if not runtime:
            return None
        defaults = {
            "projection_backup": "projection-backups",
            "media_store": "synapse/media_store",
            "session_credentials": "secrets",
            "account_keys": "secrets",
        }
        suffix = defaults.get(store)
        if suffix is None:
            return None
        configured = str(Path(runtime) / suffix)
    root = Path(configured).resolve()
    if not root.exists() or not root.is_dir():
        return None
    return root


def safe_path(root: Path, relative: str) -> Path:
    candidate = (root / relative).resolve()
    try:
        candidate.relative_to(root)
    except ValueError as error:
        raise RetentionError("controlled-copy reference escapes configured root") from error
    return candidate


def json_http_request(
    endpoint: str,
    token: str,
    body: Mapping[str, Any],
    timeout: float = 30,
) -> dict[str, Any]:
    request = urllib.request.Request(
        endpoint,
        data=json.dumps(body).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
            "Accept": "application/json",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            value = json.loads(response.read())
    except urllib.error.HTTPError as error:
        raise RetentionError(f"controlled-copy provider HTTP {error.code}") from error
    except (OSError, json.JSONDecodeError) as error:
        raise RetentionError("controlled-copy provider response is unavailable") from error
    if not isinstance(value, dict):
        raise RetentionError("controlled-copy provider response is invalid")
    return value


def synapse_api_configuration() -> tuple[str, str] | None:
    base_url = os.environ.get(
        "COMMUNICATOR_RETENTION_SYNAPSE_HOMESERVER_URL", ""
    ).strip()
    access_token = os.environ.get(
        "COMMUNICATOR_RETENTION_SYNAPSE_ACCESS_TOKEN", ""
    ).strip()
    if not any((base_url, access_token)):
        return None
    if not base_url or not access_token:
        raise RetentionError("controlled-copy Synapse API configuration is incomplete")
    return base_url.rstrip("/"), access_token


def synapse_event_endpoint(base_url: str, room_id: str, event_id: str) -> str:
    return (
        base_url
        + "/_matrix/client/v3/rooms/"
        + urllib.parse.quote(room_id, safe="")
        + "/event/"
        + urllib.parse.quote(event_id, safe="")
    )


def synapse_event_exists(
    base_url: str, access_token: str, room_id: str, event_id: str
) -> bool:
    request = urllib.request.Request(
        synapse_event_endpoint(base_url, room_id, event_id),
        headers={
            "Authorization": f"Bearer {access_token}",
            "Accept": "application/json",
        },
        method="GET",
    )
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            if response.status < 200 or response.status >= 300:
                raise RetentionError("Synapse event inventory returned an HTTP failure")
            value = json.loads(response.read())
    except urllib.error.HTTPError as error:
        if error.code == 404:
            return False
        raise RetentionError(f"Synapse event inventory HTTP {error.code}") from error
    except (OSError, json.JSONDecodeError) as error:
        raise RetentionError("Synapse event inventory is unavailable") from error
    if not isinstance(value, dict):
        raise RetentionError("Synapse event inventory response is invalid")
    return True


def inventory_synapse_from_server(scope: Mapping[str, Any]) -> dict[str, Any]:
    configuration = synapse_api_configuration()
    if configuration is None:
        return inventory_from_manifest("synapse", scope)
    base_url, access_token = configuration
    document = parse_json_file(manifest_path())
    entries, manifest_complete = entries_for(document, "synapse", scope)
    copies: list[dict[str, Any]] = []
    invalid_mapping = False
    for copy in entries:
        room_id = copy.get("room_id")
        event_id = copy.get("event_id")
        if (
            not isinstance(room_id, str)
            or not room_id.strip()
            or not isinstance(event_id, str)
            or not event_id.strip()
        ):
            invalid_mapping = True
            continue
        if synapse_event_exists(base_url, access_token, room_id, event_id):
            copies.append(copy)
    complete = manifest_complete and not invalid_mapping
    return {
        "complete": complete,
        "copies": copies,
        "evidence_source": "synapse_client_event_inventory",
        "detail": None
        if complete
        else "Synapse manifest mapping is incomplete for this resource lineage",
    }


def queue_api_configuration() -> tuple[str, str, str, str] | None:
    api_url = os.environ.get(
        "COMMUNICATOR_RETENTION_QUEUE_API_URL",
        "https://api.cloudflare.com/client/v4",
    ).strip()
    account_id = os.environ.get("COMMUNICATOR_RETENTION_QUEUE_ACCOUNT_ID", "").strip()
    queue_id = os.environ.get("COMMUNICATOR_RETENTION_QUEUE_ID", "").strip()
    token = os.environ.get("COMMUNICATOR_RETENTION_QUEUE_API_TOKEN", "").strip()
    if not any((account_id, queue_id, token)):
        return None
    if not account_id or not queue_id or not token:
        raise RetentionError("controlled-copy queue API configuration is incomplete")
    return api_url.rstrip("/"), account_id, queue_id, token


def queue_copy_from_message(
    message: Mapping[str, Any], queue_id: str, scope: Mapping[str, Any]
) -> dict[str, Any] | None:
    reference = message.get("ref")
    body = message.get("body")
    if not isinstance(reference, str) or not reference.strip():
        return None
    if isinstance(body, str):
        try:
            body = json.loads(body)
        except json.JSONDecodeError:
            return None
    if not isinstance(body, dict):
        return None
    # Cloudflare Queue only exposes an opaque peek reference.  The body must
    # carry the same immutable lineage before we can purge that reference.
    if (
        body.get("resource_id") != scope.get("resource_id")
        or str(body.get("content_generation"))
        != str(scope.get("content_generation"))
    ):
        return None
    timestamp_ms = message.get("timestamp_ms")
    if isinstance(timestamp_ms, (int, float)) and timestamp_ms > 0:
        created = dt.datetime.fromtimestamp(
            timestamp_ms / 1_000, dt.timezone.utc
        ).isoformat().replace("+00:00", "Z")
    else:
        created = utc_now()
    return {
        "reference": f"cloudflare-queue:{reference}",
        "resource_id": scope["resource_id"],
        "content_generation": scope["content_generation"],
        "copy_created_at": created,
        "content_classes": ["queue_item"],
        "queue_ref": reference,
        "queue_id": queue_id,
    }


def inventory_queue_from_cloudflare(scope: Mapping[str, Any]) -> dict[str, Any]:
    configuration = queue_api_configuration()
    if configuration is None:
        return inventory_from_manifest("queue", scope)
    api_url, account_id, queue_id, token = configuration
    endpoint = (
        f"{api_url}/accounts/{urllib.parse.quote(account_id, safe='')}/queues/"
        f"{urllib.parse.quote(queue_id, safe='')}/messages/peek"
    )
    try:
        batch_size = int(
            os.environ.get("COMMUNICATOR_RETENTION_QUEUE_BATCH_SIZE", "100")
        )
    except ValueError as error:
        raise RetentionError("controlled-copy queue batch size is invalid") from error
    if batch_size < 1 or batch_size > 100:
        raise RetentionError("controlled-copy queue batch size is outside 1..100")
    response = json_http_request(endpoint, token, {"batch_size": batch_size})
    if response.get("success") is False:
        raise RetentionError("Cloudflare Queue peek returned an API failure")
    result = response.get("result", response)
    if not isinstance(result, dict):
        raise RetentionError("controlled-copy queue response result is invalid")
    errors = [
        value
        for value in (response.get("errors"), result.get("errors"))
        if isinstance(value, list)
    ]
    if any(error_list for error_list in errors):
        raise RetentionError("Cloudflare Queue peek returned an API error")
    warnings = [
        value
        for value in (response.get("warnings"), result.get("warnings"))
        if isinstance(value, dict)
    ]
    has_warnings = any(warning_map for warning_map in warnings)
    raw_messages = result.get("messages", [])
    if not isinstance(raw_messages, list):
        raise RetentionError("controlled-copy queue messages are invalid")
    copies = [
        copy
        for raw_message in raw_messages
        if isinstance(raw_message, dict)
        for copy in [queue_copy_from_message(raw_message, queue_id, scope)]
        if copy is not None
    ]
    append_manifest_entries("queue", copies)
    # A full page can hide an older matching message.  Only a short page is a
    # complete scan, and every peeked message must carry explicit lineage.
    complete = (
        len(raw_messages) < batch_size
        and len(copies) == len(raw_messages)
        and not has_warnings
    )
    return {
        "complete": complete,
        "copies": [normalized_copy(copy) for copy in copies],
        "evidence_source": "cloudflare_queue_peek",
        "detail": None
        if complete
        else "Queue peek is bounded, warned, or contains an item without exact removal lineage",
    }


def queue_cleanup_copy(copy: Mapping[str, Any]) -> dict[str, Any]:
    configuration = queue_api_configuration()
    queue_ref = copy.get("queue_ref")
    if configuration is None or not isinstance(queue_ref, str) or not queue_ref.strip():
        return {
            "status": "unknown",
            "content_present": True,
            "evidence_source": "cloudflare_queue_configuration_missing",
            "object_reference": copy.get("reference"),
            "detail": "The exact peek reference or Cloudflare Queue credentials are unavailable",
        }
    api_url, account_id, configured_queue_id, token = configuration
    queue_id = copy.get("queue_id")
    if not isinstance(queue_id, str) or not queue_id.strip():
        queue_id = configured_queue_id
    endpoint = (
        f"{api_url}/accounts/{urllib.parse.quote(account_id, safe='')}/queues/"
        f"{urllib.parse.quote(queue_id, safe='')}/messages/purge"
    )
    try:
        response = json_http_request(endpoint, token, {"refs": [{"ref": queue_ref}]})
    except RetentionError as error:
        return {
            "status": "failed",
            "content_present": True,
            "evidence_source": "cloudflare_queue_purge",
            "object_reference": copy.get("reference"),
            "detail": str(error),
        }
    result = response.get("result", response)
    if not isinstance(result, dict):
        return {
            "status": "failed",
            "content_present": True,
            "evidence_source": "cloudflare_queue_purge",
            "object_reference": copy.get("reference"),
            "detail": "Cloudflare Queue purge response is invalid",
        }
    errors = [
        value
        for value in (response.get("errors"), result.get("errors"))
        if isinstance(value, list)
    ]
    warnings = [
        value
        for value in (response.get("warnings"), result.get("warnings"))
        if isinstance(value, dict)
    ]
    if any(error_list for error_list in errors) or any(
        warning_map for warning_map in warnings
    ):
        return {
            "status": "failed",
            "content_present": True,
            "evidence_source": "cloudflare_queue_purge",
            "object_reference": copy.get("reference"),
            "detail": "Cloudflare Queue rejected the exact message reference",
        }
    remove_manifest_entry("queue", required_string(copy.get("reference"), "copy reference"))
    return {
        "status": "deleted",
        "content_present": False,
        "evidence_source": "cloudflare_queue_purge",
        "object_reference": copy.get("reference"),
        "detail": "The exact peek reference was purged from the configured Queue",
    }


def bridge_database_configuration() -> tuple[str, str] | None:
    database_url = os.environ.get("COMMUNICATOR_RETENTION_BRIDGE_DATABASE_URL", "").strip()
    if not database_url:
        return None
    binary = os.environ.get("COMMUNICATOR_RETENTION_BRIDGE_PSQL_BIN", "psql").strip()
    if not binary:
        raise RetentionError("controlled-copy bridge psql binary is invalid")
    return database_url, binary


def run_bridge_psql(
    database_url: str, binary: str, query: str, variables: Mapping[str, str]
) -> str:
    flattened = [binary, "--no-psqlrc", "--tuples-only", "--no-align", "--quiet"]
    for name, value in variables.items():
        flattened.extend(["--set", f"{name}={value}"])
    flattened.extend([database_url, "--command", query])
    try:
        result = subprocess.run(
            flattened,
            capture_output=True,
            text=True,
            check=False,
            timeout=60,
        )
    except (OSError, subprocess.TimeoutExpired) as error:
        raise RetentionError("controlled-copy bridge database is unavailable") from error
    if result.returncode != 0:
        raise RetentionError("controlled-copy bridge database query failed")
    return result.stdout.strip()


BRIDGE_MESSAGE_EXISTS_QUERY = """
SELECT count(*) FROM message
WHERE bridge_id = :'bridge_id' AND id = :'message_id' AND part_id = :'part_id'
"""


def bridge_manifest_entries(scope: Mapping[str, Any]) -> list[dict[str, Any]]:
    document = parse_json_file(manifest_path())
    stores = document.get("stores", {})
    if not isinstance(stores, dict):
        raise RetentionError("controlled-copy manifest stores are invalid")
    raw_store = stores.get("bridge_database", {})
    if not isinstance(raw_store, dict):
        raise RetentionError("controlled-copy bridge_database manifest is invalid")
    raw_entries = raw_store.get("copies", [])
    if not isinstance(raw_entries, list):
        raise RetentionError("controlled-copy bridge_database copies are invalid")
    entries: list[dict[str, Any]] = []
    for raw_entry in raw_entries:
        if not isinstance(raw_entry, dict) or not entry_matches(raw_entry, scope):
            continue
        copy = normalized_copy(raw_entry)
        if (
            isinstance(copy.get("bridge_id"), str)
            and copy["bridge_id"].strip()
            and isinstance(copy.get("message_id"), str)
            and copy["message_id"].strip()
            and isinstance(copy.get("part_id"), str)
        ):
            entries.append(copy)
    return entries


def inventory_bridge_from_database(scope: Mapping[str, Any]) -> dict[str, Any]:
    configuration = bridge_database_configuration()
    if configuration is None:
        return inventory_from_manifest("bridge_database", scope)
    database_url, binary = configuration
    entries = bridge_manifest_entries(scope)
    copies: list[dict[str, Any]] = []
    for copy in entries:
        count_text = run_bridge_psql(
            database_url,
            binary,
            BRIDGE_MESSAGE_EXISTS_QUERY,
            {
                "bridge_id": str(copy["bridge_id"]),
                "message_id": str(copy["message_id"]),
                "part_id": str(copy["part_id"]),
            },
        )
        try:
            count = int(count_text.splitlines()[-1].strip())
        except (ValueError, IndexError) as error:
            raise RetentionError("controlled-copy bridge inventory count is invalid") from error
        if count == 1:
            copy["content_classes"] = ["bridge_mapping"]
            copies.append(copy)
        elif count > 1:
            raise RetentionError("controlled-copy bridge mapping is not unique")
    complete = bool(copies) and len(copies) == len(entries)
    return {
        "complete": complete,
        "copies": copies,
        "evidence_source": "mautrix_bridgev2_message_table",
        "detail": None
        if complete
        else "Pinned bridge message mapping is absent or no longer present",
    }


def cleanup_bridge_copy(copy: Mapping[str, Any]) -> dict[str, Any]:
    configuration = bridge_database_configuration()
    if (
        configuration is None
        or not isinstance(copy.get("bridge_id"), str)
        or not str(copy["bridge_id"]).strip()
        or not isinstance(copy.get("message_id"), str)
        or not str(copy["message_id"]).strip()
        or not isinstance(copy.get("part_id"), str)
    ):
        return {
            "status": "unknown",
            "content_present": True,
            "evidence_source": "mautrix_bridgev2_lineage_missing",
            "object_reference": copy.get("reference"),
            "detail": "Exact pinned bridge message key or database credentials are unavailable",
        }
    database_url, binary = configuration
    query = """
BEGIN;
DELETE FROM reaction
WHERE bridge_id = :'bridge_id' AND message_id = :'message_id'
  AND message_part_id = :'part_id';
WITH deleted AS (
  DELETE FROM message
  WHERE bridge_id = :'bridge_id' AND id = :'message_id' AND part_id = :'part_id'
  RETURNING id
)
SELECT count(*) FROM deleted;
COMMIT;
"""
    try:
        output = run_bridge_psql(
            database_url,
            binary,
            query,
            {
                "bridge_id": str(copy["bridge_id"]),
                "message_id": str(copy["message_id"]),
                "part_id": str(copy["part_id"]),
            },
        )
        count = int(output.splitlines()[-1].strip())
    except (RetentionError, ValueError, IndexError) as error:
        return {
            "status": "failed",
            "content_present": True,
            "evidence_source": "mautrix_bridgev2_message_delete",
            "object_reference": copy.get("reference"),
            "detail": str(error) if isinstance(error, RetentionError) else "Bridge delete count is invalid",
        }
    if count != 1:
        return {
            "status": "missing",
            "content_present": False,
            "evidence_source": "mautrix_bridgev2_message_delete",
            "object_reference": copy.get("reference"),
            "detail": "The exact bridge message mapping was already absent",
        }
    remove_manifest_entry(
        "bridge_database", required_string(copy.get("reference"), "copy reference")
    )
    return {
        "status": "deleted",
        "content_present": False,
        "evidence_source": "mautrix_bridgev2_message_delete",
        "object_reference": copy.get("reference"),
        "detail": "The exact pinned bridge-v2 message part and its reactions were deleted",
    }


def inventory_from_manifest(store: str, scope: Mapping[str, Any]) -> dict[str, Any]:
    document = parse_json_file(manifest_path())
    entries, complete = entries_for(document, store, scope)
    # An explicitly complete manifest can prove that this lineage has no
    # remaining copies.  A missing/partial store document stays incomplete;
    # an empty list must not resurrect an already-deleted operation as an
    # inventory failure on the next scheduled pass.
    return {
        "complete": complete,
        "copies": entries,
        "evidence_source": f"{store}_manifest",
        "detail": None
        if complete
        else "Store inventory is not complete for this resource lineage",
    }


def append_manifest_entries(store: str, entries: Iterable[Mapping[str, Any]]) -> None:
    """Persist provider references discovered by a non-destructive inventory."""
    additions = [dict(entry) for entry in entries]
    if not additions:
        return
    path = manifest_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    lock_path = path.with_suffix(path.suffix + ".lock")
    with lock_path.open("a+") as lock:
        fcntl.flock(lock.fileno(), fcntl.LOCK_EX)
        document = parse_json_file(path)
        stores = document.setdefault("stores", {})
        if not isinstance(stores, dict):
            raise RetentionError("controlled-copy manifest stores are invalid")
        store_document = stores.setdefault(store, {})
        if not isinstance(store_document, dict):
            raise RetentionError(f"controlled-copy {store} manifest is invalid")
        copies = store_document.setdefault("copies", [])
        if not isinstance(copies, list):
            raise RetentionError(f"controlled-copy {store} copies are invalid")
        references = {
            entry.get("reference")
            for entry in copies
            if isinstance(entry, dict)
        }
        for entry in additions:
            reference = required_string(entry.get("reference"), "copy reference")
            if reference not in references:
                copies.append(entry)
                references.add(reference)
        stores[store] = store_document
        temporary_fd, temporary_name = tempfile.mkstemp(
            prefix="controlled-copy-", dir=path.parent
        )
        os.close(temporary_fd)
        temporary = Path(temporary_name)
        try:
            temporary.write_text(json.dumps(document, indent=2) + "\n", encoding="utf-8")
            temporary.chmod(0o600)
            os.replace(temporary, path)
        finally:
            temporary.unlink(missing_ok=True)


def remove_manifest_entry(store: str, reference: str) -> None:
    path = manifest_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    lock_path = path.with_suffix(path.suffix + ".lock")
    with lock_path.open("a+") as lock:
        fcntl.flock(lock.fileno(), fcntl.LOCK_EX)
        document = parse_json_file(path)
        stores = document.setdefault("stores", {})
        if not isinstance(stores, dict):
            raise RetentionError("controlled-copy manifest stores are invalid")
        store_document = stores.get(store, {})
        if not isinstance(store_document, dict):
            raise RetentionError(f"controlled-copy {store} manifest is invalid")
        entries = store_document.get("copies", [])
        if not isinstance(entries, list):
            raise RetentionError(f"controlled-copy {store} copies are invalid")
        store_document["copies"] = [
            entry
            for entry in entries
            if not isinstance(entry, dict) or entry.get("reference") != reference
        ]
        stores[store] = store_document
        temporary_fd, temporary_name = tempfile.mkstemp(
            prefix="controlled-copy-", dir=path.parent
        )
        os.close(temporary_fd)
        temporary = Path(temporary_name)
        try:
            temporary.write_text(json.dumps(document, indent=2) + "\n", encoding="utf-8")
            temporary.chmod(0o600)
            os.replace(temporary, path)
        finally:
            temporary.unlink(missing_ok=True)


def cleanup_file_copy(store: str, copy: Mapping[str, Any]) -> dict[str, Any]:
    root = file_root(store)
    relative = copy.get("path")
    if root is None or not isinstance(relative, str) or not relative.strip():
        return {
            "status": "unknown",
            "content_present": True,
            "evidence_source": f"{store}_path_unconfigured",
            "object_reference": copy.get("reference"),
            "detail": "A manifest reference exists but no safe file root is configured",
        }
    candidate = safe_path(root, relative)
    try:
        if candidate.is_dir():
            shutil.rmtree(candidate)
        else:
            candidate.unlink(missing_ok=True)
    except OSError as error:
        return {
            "status": "failed",
            "content_present": True,
            "evidence_source": f"{store}_filesystem",
            "object_reference": copy.get("reference"),
            "detail": f"filesystem cleanup failed: {error.__class__.__name__}",
        }
    remove_manifest_entry(store, required_string(copy.get("reference"), "copy reference"))
    return {
        "status": "deleted",
        "content_present": False,
        "evidence_source": f"{store}_filesystem",
        "object_reference": copy.get("reference"),
        "detail": "The exact manifest path was removed under its configured root",
    }


def cleanup_restic_copy(copy: Mapping[str, Any]) -> dict[str, Any]:
    classes = copy.get("content_classes")
    if classes != ["message"]:
        return {
            "status": "lifecycle_pending",
            "content_present": True,
            "evidence_source": "restic_mixed_snapshot",
            "object_reference": copy.get("reference"),
            "detail": "Restic snapshot is mixed or not proven exclusive to message content",
        }
    if copy.get("exclusive_resource_id") is not True:
        return {
            "status": "lifecycle_pending",
            "content_present": True,
            "evidence_source": "restic_snapshot_not_exclusive",
            "object_reference": copy.get("reference"),
            "detail": "Deleting a shared snapshot could remove unrelated recoverable data",
        }
    repository = os.environ.get("RESTIC_REPOSITORY", "").strip()
    password_file = os.environ.get("RESTIC_PASSWORD_FILE", "").strip()
    restic_binary = os.environ.get("COMMUNICATOR_RETENTION_RESTIC_BIN", "restic").strip()
    snapshot = required_string(copy.get("snapshot_id"), "restic snapshot id")
    if not repository or not password_file or not restic_binary:
        return {
            "status": "unknown",
            "content_present": True,
            "evidence_source": "restic_configuration_missing",
            "object_reference": copy.get("reference"),
            "detail": "Restic repository credentials are not configured",
        }
    try:
        result = subprocess.run(
            [restic_binary, "forget", snapshot, "--prune"],
            env={**os.environ, "RESTIC_REPOSITORY": repository, "RESTIC_PASSWORD_FILE": password_file},
            capture_output=True,
            text=True,
            check=False,
            timeout=300,
        )
    except (OSError, subprocess.TimeoutExpired) as error:
        return {
            "status": "failed",
            "content_present": True,
            "evidence_source": "restic_forget",
            "object_reference": copy.get("reference"),
            "detail": f"restic forget failed: {error.__class__.__name__}",
        }
    if result.returncode != 0:
        return {
            "status": "failed",
            "content_present": True,
            "evidence_source": "restic_forget",
            "object_reference": copy.get("reference"),
            "detail": "restic forget returned a failure",
        }
    remove_manifest_entry("restic_snapshot", required_string(copy.get("reference"), "copy reference"))
    return {
        "status": "aged_out",
        "content_present": False,
        "evidence_source": "restic_forget",
        "object_reference": copy.get("reference"),
        "detail": "The exclusive message-only restic snapshot was forgotten and pruned",
    }


def cleanup_synapse_copy(copy: Mapping[str, Any]) -> dict[str, Any]:
    """Redact one mapped Matrix event without claiming byte deletion.

    Synapse's supported purge-history API removes a room prefix and retains
    the cutoff event. The supported exact event operation is Matrix redaction,
    which removes event content from future reads but leaves the event/DAG and
    database bytes until a safe room-level purge is possible. Preserve that
    distinction in the evidence instead of treating redaction as erasure.
    """
    room_id = copy.get("room_id")
    event_id = copy.get("event_id")
    configuration = synapse_api_configuration()
    base_url, access_token = configuration or ("", "")
    if not isinstance(room_id, str) or not room_id.strip() or not isinstance(event_id, str) or not event_id.strip():
        return {
            "status": "unknown",
            "content_present": True,
            "evidence_source": "synapse_lineage_missing",
            "object_reference": copy.get("reference"),
            "detail": "Exact Matrix room and event mapping is unavailable",
        }
    if not base_url or not access_token:
        return {
            "status": "unknown",
            "content_present": True,
            "evidence_source": "synapse_credentials_missing",
            "object_reference": copy.get("reference"),
            "detail": "Synapse redaction credentials are not configured",
        }
    transaction_id = "communicator-" + hashlib.sha256(
        required_string(copy.get("reference"), "copy reference").encode("utf-8")
    ).hexdigest()[:32]
    endpoint = (
        base_url.rstrip("/")
        + "/_matrix/client/v3/rooms/"
        + urllib.parse.quote(room_id, safe="")
        + "/redact/"
        + urllib.parse.quote(event_id, safe="")
        + "/"
        + transaction_id
    )
    request = urllib.request.Request(
        endpoint,
        data=json.dumps({"reason": "communicator removal"}).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {access_token}",
            "Content-Type": "application/json",
            "Accept": "application/json",
        },
        method="PUT",
    )
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            if response.status < 200 or response.status >= 300:
                raise RetentionError("Synapse redaction returned an HTTP failure")
            response.read()
    except urllib.error.HTTPError as error:
        status = "permission_denied" if error.code in {401, 403} else "failed"
        return {
            "status": status,
            "content_present": True,
            "evidence_source": "synapse_redaction",
            "object_reference": copy.get("reference"),
            "detail": f"Synapse redaction HTTP {error.code}",
        }
    except (OSError, RetentionError) as error:
        return {
            "status": "failed",
            "content_present": True,
            "evidence_source": "synapse_redaction",
            "object_reference": copy.get("reference"),
            "detail": f"Synapse redaction failed: {error.__class__.__name__}",
        }
    return {
        "status": "quarantined",
        "content_present": True,
        "evidence_source": "synapse_redaction",
        "object_reference": copy.get("reference"),
        "detail": "Exact event redacted; Synapse room history/DAG bytes remain until a safe purge boundary",
    }


def preserve_copy(store: str, copy: Mapping[str, Any]) -> dict[str, Any]:
    return {
        "status": "preserved",
        "content_present": True,
        "evidence_source": f"{store}_preservation",
        "object_reference": copy.get("reference"),
        "detail": "Credential/session material remains under its separate lifecycle",
    }


def process_request(operation: str, payload: Mapping[str, Any]) -> dict[str, Any]:
    if payload.get("protocol") != PROTOCOL:
        raise RetentionError("controlled-copy protocol is invalid")
    store = required_string(payload.get("store"), "store")
    if store not in ALL_STORES:
        raise RetentionError("controlled-copy store is invalid")
    if operation == "inventory":
        scope = payload.get("scope")
        if not isinstance(scope, dict):
            raise RetentionError("controlled-copy inventory scope is invalid")
        if store == "queue":
            return inventory_queue_from_cloudflare(scope)
        if store == "bridge_database":
            return inventory_bridge_from_database(scope)
        if store == "synapse" and synapse_api_configuration() is not None:
            return inventory_synapse_from_server(scope)
        command_result = run_store_command(store, "inventory", payload)
        return command_result if command_result is not None else inventory_from_manifest(store, scope)

    if operation != "cleanup":
        raise RetentionError("controlled-copy operation is invalid")
    reference = required_string(payload.get("reference"), "copy reference")
    document = parse_json_file(manifest_path())
    entries, _ = entries_for(
        document,
        store,
        {
            "resource_id": payload.get("resource_id"),
            "content_generation": payload.get("content_generation"),
        },
    )
    copy = next((entry for entry in entries if entry["reference"] == reference), None)
    if copy is None:
        return {
            "status": "missing",
            "content_present": False,
            "evidence_source": f"{store}_manifest",
            "object_reference": reference,
            "detail": "The exact lineage reference is absent from the host manifest",
        }
    if store == "bridge_database" and bridge_database_configuration() is not None:
        return cleanup_bridge_copy(copy)
    if store == "queue" and queue_api_configuration() is not None:
        return queue_cleanup_copy(copy)
    if store == "synapse" and synapse_api_configuration() is not None:
        return cleanup_synapse_copy(copy)
    # Restic has an exact repository operation with its own mixed-content
    # safety checks. Run that path before the optional command escape hatch so
    # a configured command cannot bypass the exclusive-snapshot guard.
    if store == "restic_snapshot":
        return cleanup_restic_copy(copy)
    command_result = run_store_command(store, "cleanup", payload)
    if command_result is not None:
        return command_result
    if store in AUXILIARY_STORES:
        return preserve_copy(store, copy)
    if store == "synapse":
        return cleanup_synapse_copy(copy)
    if store == "bridge_database":
        return cleanup_bridge_copy(copy)
    if store == "queue":
        return queue_cleanup_copy(copy)
    return cleanup_file_copy(store, copy)


class RetentionHandler(BaseHTTPRequestHandler):
    server_version = "communicator-controlled-copy/1"

    def log_message(self, _format: str, *_args: Any) -> None:
        # Requests contain resource references and the Authorization header;
        # avoid putting either into the service log.
        return

    def send_json(self, status: int, value: Mapping[str, Any]) -> None:
        body = json.dumps(value).encode("utf-8")
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self) -> None:  # noqa: N802 - stdlib handler API
        expected = os.environ.get("COMMUNICATOR_RETENTION_SERVICE_TOKEN", "").strip()
        authorization = self.headers.get("authorization", "")
        if not expected or authorization != f"Bearer {expected}":
            self.send_json(HTTPStatus.UNAUTHORIZED, {"error": "unauthorized"})
            return
        length = self.headers.get("content-length")
        try:
            if length is None or int(length) > 1_000_000:
                raise RetentionError("controlled-copy request body is invalid")
            body = json.loads(self.rfile.read(int(length)))
            payload = body if isinstance(body, dict) else None
            if payload is None:
                raise RetentionError("controlled-copy request body is invalid")
            operation = self.path.rstrip("/").split("/")[-1]
            response = process_request(operation, payload)
            self.send_json(HTTPStatus.OK, response)
        except RetentionError as error:
            self.send_json(HTTPStatus.BAD_REQUEST, {"error": str(error)})
        except Exception:
            self.send_json(
                HTTPStatus.INTERNAL_SERVER_ERROR,
                {"error": "controlled-copy backend failed"},
            )


def serve(host: str, port: int) -> None:
    if not os.environ.get("COMMUNICATOR_RETENTION_SERVICE_TOKEN", "").strip():
        raise SystemExit("COMMUNICATOR_RETENTION_SERVICE_TOKEN is required")
    server = ThreadingHTTPServer((host, port), RetentionHandler)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


def main(argv: Iterable[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", default=os.environ.get("COMMUNICATOR_RETENTION_HOST", "127.0.0.1"))
    parser.add_argument(
        "--port",
        type=int,
        default=int(os.environ.get("COMMUNICATOR_RETENTION_PORT", "8765")),
    )
    args = parser.parse_args(list(argv) if argv is not None else None)
    serve(args.host, args.port)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
