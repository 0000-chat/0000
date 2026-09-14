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

# ``backup-core.sh`` uses PostgreSQL custom-format dumps.  A custom dump is a
# database image, not a file-per-message archive: one dump can contain event
# bodies, bridge rows, credentials, and unrelated tenants.  The migration
# path below therefore accepts only these explicit database contracts and
# rewrites a restored database in an isolated local PostgreSQL cluster.
CORE_BACKUP_FORMAT = "communicator-core-pgdump-v1"
CORE_DATABASE_CONTRACTS = {
    "synapse": "synapse-event-json-v1",
    "whatsapp_bridge": "mautrix-bridge-message-v1",
    "messenger_bridge": "mautrix-bridge-message-v1",
    "telegram_bridge": "mautrix-bridge-message-v1",
}
CORE_DATABASE_DUMP_PATHS = {
    "synapse": "synapse.pgdump",
    "whatsapp_bridge": "whatsapp.pgdump",
    "messenger_bridge": "messenger.pgdump",
    "telegram_bridge": "telegram.pgdump",
}
CORE_EVENT_TYPES = {"m.room.message", "m.room.encrypted"}
# Before the layout sidecar was introduced, backup-core.sh always emitted this
# fixed runtime tree.  The media store is the only subtree whose regular-file
# members are intentionally variable; every other path is part of the pinned
# backup shape and must be enumerated exactly before migration.
LEGACY_CORE_BACKUP_FORMAT = "communicator-core-pgdump-v0"
LEGACY_CORE_REQUIRED_FILES = frozenset(
    {
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
    }
)
LEGACY_CORE_OPTIONAL_FILES = frozenset({"retention/controlled-copy-manifest.json"})
LEGACY_CORE_MEDIA_PREFIX = "synapse-data/media_store/"


class RetentionError(Exception):
    """An operator-visible, secret-free backend error."""


def utc_now() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat().replace("+00:00", "Z")


def required_string(value: Any, name: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise RetentionError(f"controlled-copy {name} is required")
    return value.strip()


def sql_literal(value: str, name: str = "SQL value") -> str:
    """Render one validated value without relying on psql variable expansion."""
    if "\x00" in value:
        raise RetentionError(f"controlled-copy {name} contains an invalid character")
    return "'" + value.replace("'", "''") + "'"


def render_sql_variables(query: str, variables: Mapping[str, str]) -> str:
    rendered = query
    for name, value in variables.items():
        rendered = rendered.replace(
            f":'{name}'", sql_literal(value, f"SQL variable {name}")
        )
    return rendered


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


def synapse_database_configuration() -> tuple[str, str] | None:
    database_url = os.environ.get(
        "COMMUNICATOR_RETENTION_SYNAPSE_DATABASE_URL", ""
    ).strip()
    if not database_url:
        return None
    binary = os.environ.get("COMMUNICATOR_RETENTION_SYNAPSE_PSQL_BIN", "psql").strip()
    if not binary:
        raise RetentionError("controlled-copy Synapse psql binary is invalid")
    return database_url, binary


SYNAPSE_EVENT_STATE_QUERY = """
WITH target AS (
  SELECT
    events.room_id,
    events.event_id,
    events.type,
    event_json.json::jsonb AS body
  FROM events
  INNER JOIN event_json
    ON event_json.room_id = events.room_id
   AND event_json.event_id = events.event_id
  WHERE events.room_id = :'room_id'
    AND events.event_id = :'event_id'
),
redaction AS (
  SELECT redactions.have_censored
  FROM redactions
  WHERE redactions.redacts = :'event_id'
  ORDER BY redactions.event_id DESC
  LIMIT 1
)
SELECT CASE
  WHEN NOT EXISTS (SELECT 1 FROM target) THEN 'missing'
  WHEN (SELECT type FROM target) <> :'event_type' THEN 'type_mismatch'
  WHEN (SELECT type FROM target) NOT IN ('m.room.message', 'm.room.encrypted')
    THEN 'unsupported'
  WHEN COALESCE((SELECT body FROM target)->'content', 'null'::jsonb) <> '{}'::jsonb
    THEN CASE
      WHEN EXISTS (SELECT 1 FROM redaction WHERE have_censored IS TRUE)
        THEN 'intact_censored'
      ELSE 'present'
    END
  WHEN EXISTS (SELECT 1 FROM redaction WHERE have_censored IS TRUE)
    THEN 'censored'
  ELSE 'redacted'
END;
"""


def run_synapse_psql(
    database_url: str,
    binary: str,
    room_id: str,
    event_id: str,
    event_type: str,
) -> str:
    command = [
        binary,
        "--no-psqlrc",
        "--tuples-only",
        "--no-align",
        "--quiet",
        database_url,
        "--command",
        render_sql_variables(
            SYNAPSE_EVENT_STATE_QUERY,
            {"room_id": room_id, "event_id": event_id, "event_type": event_type},
        ),
    ]
    try:
        result = subprocess.run(
            command,
            capture_output=True,
            text=True,
            check=False,
            timeout=60,
        )
    except (OSError, subprocess.TimeoutExpired) as error:
        raise RetentionError("controlled-copy Synapse database is unavailable") from error
    if result.returncode != 0:
        raise RetentionError("controlled-copy Synapse database query failed")
    state = result.stdout.strip().splitlines()
    if not state or state[-1].strip() not in {
        "censored",
        "redacted",
        "present",
        "missing",
        "intact_censored",
        "type_mismatch",
        "unsupported",
    }:
        raise RetentionError("controlled-copy Synapse event state is invalid")
    return state[-1].strip()


def synapse_event_state(
    event_id: str, room_id: str | None = None, event_type: str | None = None
) -> str | None:
    configuration = synapse_database_configuration()
    if configuration is None:
        return None
    database_url, binary = configuration
    if not isinstance(room_id, str) or not room_id.strip():
        raise RetentionError("controlled-copy Synapse room mapping is required")
    if event_type is None:
        event_type = "m.room.message"
    if event_type not in CORE_EVENT_TYPES:
        raise RetentionError("controlled-copy Synapse event type is unsupported")
    return run_synapse_psql(database_url, binary, room_id, event_id, event_type)


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
    database_configuration = synapse_database_configuration()
    if configuration is None and database_configuration is None:
        return inventory_from_manifest("synapse", scope)
    base_url, access_token = configuration or ("", "")
    document = parse_json_file(manifest_path())
    entries, manifest_complete = entries_for(document, "synapse", scope)
    copies: list[dict[str, Any]] = []
    invalid_mapping = False
    for copy in entries:
        room_id = copy.get("room_id")
        event_id = copy.get("event_id")
        event_type = copy.get("event_type", "m.room.message")
        if (
            not isinstance(room_id, str)
            or not room_id.strip()
            or not isinstance(event_id, str)
            or not event_id.strip()
            or event_type not in CORE_EVENT_TYPES
        ):
            invalid_mapping = True
            continue
        state = synapse_event_state(event_id, room_id, event_type)
        if state is None:
            state = "present" if synapse_event_exists(
                base_url, access_token, room_id, event_id
            ) else "missing"
        if state in {"present", "redacted", "intact_censored"}:
            copies.append(copy)
    complete = manifest_complete and not invalid_mapping
    return {
        "complete": complete,
        "copies": copies,
        "evidence_source": (
            "synapse_event_json_censor_inventory"
            if database_configuration is not None
            else "synapse_client_event_inventory"
        ),
        "detail": None
        if complete
        else "Synapse manifest mapping or stored event JSON is incomplete for this resource lineage",
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
    flattened.extend([database_url, "--command", render_sql_variables(query, variables)])
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


def restic_configuration() -> tuple[str, str, str] | None:
    repository = os.environ.get("RESTIC_REPOSITORY", "").strip()
    password_file = os.environ.get("RESTIC_PASSWORD_FILE", "").strip()
    restic_binary = os.environ.get("COMMUNICATOR_RETENTION_RESTIC_BIN", "restic").strip()
    if not repository and not password_file:
        return None
    if not repository or not password_file or not restic_binary:
        raise RetentionError("controlled-copy restic repository configuration is incomplete")
    return repository, password_file, restic_binary


def restic_environment(repository: str, password_file: str) -> dict[str, str]:
    return {
        **os.environ,
        "RESTIC_REPOSITORY": repository,
        "RESTIC_PASSWORD_FILE": password_file,
    }


def restic_result_snapshot_id(output: str) -> str:
    summaries: list[dict[str, Any]] = []
    for line in output.splitlines():
        if not line.strip():
            continue
        try:
            value = json.loads(line)
        except json.JSONDecodeError as error:
            raise RetentionError("restic backup returned invalid JSON") from error
        if (
            isinstance(value, dict)
            and value.get("message_type") == "summary"
            and isinstance(value.get("snapshot_id"), str)
            and value["snapshot_id"].strip()
        ):
            summaries.append(value)
    snapshot_ids = {value["snapshot_id"].strip() for value in summaries}
    if len(snapshot_ids) != 1:
        raise RetentionError("restic backup did not identify exactly one snapshot")
    return next(iter(snapshot_ids))


def restic_snapshot_inventory(
    scope: Mapping[str, Any],
    store: str = "restic_snapshot",
    allowed_tags: tuple[str, ...] = (
        "communicator-core",
        "communicator-message-migrated",
    ),
) -> dict[str, Any]:
    configuration = restic_configuration()
    if configuration is None:
        return inventory_from_manifest("restic_snapshot", scope)
    repository, password_file, binary = configuration
    try:
        result = subprocess.run(
            [binary, "snapshots", "--json"],
            env=restic_environment(repository, password_file),
            capture_output=True,
            text=True,
            check=False,
            timeout=120,
        )
    except (OSError, subprocess.TimeoutExpired) as error:
        raise RetentionError("controlled-copy restic inventory is unavailable") from error
    if result.returncode != 0:
        raise RetentionError("controlled-copy restic inventory failed")
    try:
        value = json.loads(result.stdout)
    except json.JSONDecodeError as error:
        raise RetentionError("controlled-copy restic inventory is not JSON") from error
    if not isinstance(value, list):
        raise RetentionError("controlled-copy restic inventory response is invalid")
    snapshot_ids: set[str] = set()
    for snapshot in value:
        if not isinstance(snapshot, dict):
            raise RetentionError("controlled-copy restic snapshot is invalid")
        tags = snapshot.get("tags", [])
        snapshot_id = snapshot.get("id") or snapshot.get("short_id")
        if not isinstance(tags, list) or not all(isinstance(tag, str) for tag in tags):
            raise RetentionError("controlled-copy restic snapshot tags are invalid")
        if not isinstance(snapshot_id, str) or not snapshot_id.strip():
            raise RetentionError("controlled-copy restic snapshot id is invalid")
        if any(tag == allowed or tag.startswith(allowed) for tag in tags for allowed in allowed_tags):
            snapshot_ids.add(snapshot_id.strip())

    document = parse_json_file(manifest_path())
    entries, _ = entries_for(document, store, scope)
    manifest_store = document.get("stores", {}).get(store, {})
    if not isinstance(manifest_store, dict):
        raise RetentionError(f"controlled-copy {store} manifest is invalid")
    raw_entries = manifest_store.get("copies", [])
    if not isinstance(raw_entries, list):
        raise RetentionError(f"controlled-copy {store} copies are invalid")
    manifest_ids = {
        entry.get("snapshot_id")
        for entry in raw_entries
        if isinstance(entry, dict)
        and isinstance(entry.get("snapshot_id"), str)
        and entry["snapshot_id"].strip()
    }
    # The provider-wide snapshot listing supersedes the append-only sidecar's
    # historical completeness bit.  Equality proves that every controlled
    # tagged snapshot has a sidecar entry and that no stale entry is hidden.
    complete = snapshot_ids == manifest_ids
    return {
        "complete": complete,
        "copies": [
            copy
            for copy in entries
            if isinstance(copy.get("snapshot_id"), str)
            and copy["snapshot_id"] in snapshot_ids
        ],
        "evidence_source": (
            "restic_snapshots_manifest_reconciliation"
            if store == "restic_snapshot"
            else f"restic_snapshots_{store}_manifest_reconciliation"
        ),
        "detail": None
        if complete
        else "Restic provider inventory and the controlled-copy manifest do not cover the same tagged snapshots",
    }


def restic_migration_manifest_path() -> Path | None:
    configured = os.environ.get(
        "COMMUNICATOR_RETENTION_RESTIC_MIGRATION_MANIFEST", ""
    ).strip()
    return Path(configured) if configured else None


def safe_relative_path(value: Any, name: str) -> str:
    path = required_string(value, name)
    candidate = Path(path)
    if candidate.is_absolute() or any(part in {"", ".", ".."} for part in candidate.parts):
        raise RetentionError(f"controlled-copy {name} is not a safe relative path")
    return "/".join(candidate.parts)


def read_legacy_migration_spec(
    snapshot_id: str,
) -> dict[str, Any] | None:
    path = restic_migration_manifest_path()
    if path is None:
        return None
    try:
        document = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise RetentionError("restic legacy migration manifest is unreadable") from error
    if not isinstance(document, dict) or document.get("version") != 1:
        raise RetentionError("restic legacy migration manifest version is invalid")
    snapshots = document.get("snapshots")
    if not isinstance(snapshots, dict):
        raise RetentionError("restic legacy migration snapshots are invalid")
    spec = snapshots.get(snapshot_id)
    if spec is None:
        raise RetentionError("restic legacy migration has no exact snapshot specification")
    if not isinstance(spec, dict) or spec.get("complete") is not True:
        raise RetentionError("restic legacy migration specification is not exhaustive")
    prefix = spec.get("restored_prefix", "")
    if not isinstance(prefix, str):
        raise RetentionError("restic legacy migration restored prefix is invalid")
    normalized_prefix = "" if prefix == "" else safe_relative_path(prefix, "restored prefix")

    if spec.get("format") in {CORE_BACKUP_FORMAT, LEGACY_CORE_BACKUP_FORMAT}:
        raw_databases = spec.get("databases")
        databases: list[dict[str, str]] | None = None
        if raw_databases is not None:
            if not isinstance(raw_databases, list) or not raw_databases:
                raise RetentionError("core migration database contracts are invalid")
            seen_databases: set[str] = set()
            seen_paths: set[str] = set()
            for raw_database in raw_databases:
                if not isinstance(raw_database, dict):
                    raise RetentionError("core migration database contract is invalid")
                name = required_string(raw_database.get("name"), "core database name")
                path = safe_relative_path(raw_database.get("path"), "core database dump path")
                contract = required_string(
                    raw_database.get("contract"), "core database contract"
                )
                if name not in CORE_DATABASE_CONTRACTS or CORE_DATABASE_CONTRACTS[name] != contract:
                    raise RetentionError("core migration database contract is unsupported")
                if name in seen_databases or path in seen_paths:
                    raise RetentionError("core migration database contract is duplicated")
                seen_databases.add(name)
                seen_paths.add(path)
                databases.append({"name": name, "path": path, "contract": contract})

        raw_targets = spec.get("targets")
        if not isinstance(raw_targets, list) or not raw_targets:
            raise RetentionError("core migration target rows are required")
        targets: list[dict[str, Any]] = []
        seen_target_keys: set[tuple[str, str, str]] = set()
        for raw_target in raw_targets:
            if not isinstance(raw_target, dict):
                raise RetentionError("core migration target row is invalid")
            resource_id = required_string(
                raw_target.get("resource_id"), "core target resource id"
            )
            content_generation = required_string(
                raw_target.get("content_generation"), "core target content generation"
            )
            database = required_string(raw_target.get("database"), "core target database")
            contract = required_string(
                raw_target.get("contract"), "core target contract"
            )
            if database not in CORE_DATABASE_CONTRACTS or CORE_DATABASE_CONTRACTS[database] != contract:
                raise RetentionError("core target database contract is unsupported")
            target_key = (resource_id, content_generation, database)
            if target_key in seen_target_keys:
                raise RetentionError("core migration target row is duplicated")
            seen_target_keys.add(target_key)
            target: dict[str, Any] = {
                "resource_id": resource_id,
                "content_generation": content_generation,
                "database": database,
                "contract": contract,
            }
            if contract == "synapse-event-json-v1":
                room_id = required_string(raw_target.get("room_id"), "core Synapse room id")
                event_id = required_string(raw_target.get("event_id"), "core Synapse event id")
                event_type = required_string(
                    raw_target.get("event_type"), "core Synapse event type"
                )
                if event_type not in CORE_EVENT_TYPES:
                    raise RetentionError("core Synapse event type is unsupported")
                target.update(
                    {"room_id": room_id, "event_id": event_id, "event_type": event_type}
                )
            else:
                target.update(
                    {
                        "bridge_id": required_string(
                            raw_target.get("bridge_id"), "core bridge id"
                        ),
                        "message_id": required_string(
                            raw_target.get("message_id"), "core bridge message id"
                        ),
                        "part_id": required_string(
                            raw_target.get("part_id"), "core bridge part id"
                        ),
                    }
                )
            raw_media_paths = raw_target.get("media_paths", [])
            if not isinstance(raw_media_paths, list):
                raise RetentionError("core target media paths are invalid")
            media_paths = [
                safe_relative_path(value, "core target media path")
                for value in raw_media_paths
            ]
            if len(media_paths) != len(set(media_paths)):
                raise RetentionError("core target media paths are duplicated")
            if raw_target.get("media_paths_complete") is not True:
                raise RetentionError(
                    "core target media paths must be explicitly exhaustive"
                )
            target["media_paths"] = media_paths
            targets.append(target)

        raw_files = spec.get("files")
        files: list[str] | None = None
        if raw_files is not None:
            if not isinstance(raw_files, list) or not raw_files:
                raise RetentionError("core migration file coverage is invalid")
            files = [safe_relative_path(value, "core migration file") for value in raw_files]
            if len(files) != len(set(files)):
                raise RetentionError("core migration file coverage is duplicated")
        return {
            "kind": "core",
            "format": spec.get("format"),
            "restored_prefix": normalized_prefix,
            "databases": databases,
            "targets": targets,
            "files": files,
        }

    raw_entries = spec.get("entries")
    if not isinstance(raw_entries, list) or not raw_entries:
        raise RetentionError("restic legacy migration entries are required")
    entries: list[dict[str, str]] = []
    seen_paths: set[str] = set()
    for raw_entry in raw_entries:
        if not isinstance(raw_entry, dict):
            raise RetentionError("restic legacy migration entry is invalid")
        path_value = safe_relative_path(raw_entry.get("path"), "migration entry path")
        if path_value in seen_paths:
            raise RetentionError("restic legacy migration entry path is duplicated")
        seen_paths.add(path_value)
        content_class = raw_entry.get("content_class")
        if content_class not in {"message", "session_credential", "account_key"}:
            raise RetentionError("restic legacy migration content class is invalid")
        resource_id = raw_entry.get("resource_id")
        content_generation = raw_entry.get("content_generation")
        if not isinstance(resource_id, str) or not resource_id.strip():
            raise RetentionError("restic legacy migration resource id is invalid")
        if not isinstance(content_generation, str) or not content_generation.strip():
            raise RetentionError("restic legacy migration content generation is invalid")
        if content_class == "message" and (resource_id == "*" or content_generation == "*"):
            raise RetentionError("message migration entries require exact lineage")
        entries.append(
            {
                "path": path_value,
                "content_class": content_class,
                "resource_id": resource_id,
                "content_generation": content_generation,
            }
        )
    return {"kind": "files", "restored_prefix": normalized_prefix, "entries": entries}


def copy_tree_entry(source: Path, destination_root: Path, relative: str) -> None:
    source_stat = source.lstat()
    if source_stat.st_mode & 0o170000 == 0o120000:
        raise RetentionError("restic legacy migration refuses symlink content")
    if not source.is_file():
        raise RetentionError("restic legacy migration entries must be regular files")
    destination = destination_root / relative
    destination.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(source, destination)


def exact_files_under(root: Path) -> set[str]:
    if not root.is_dir():
        raise RetentionError("restic legacy migration restored root is missing")
    found: set[str] = set()
    for current, directories, files in os.walk(root, followlinks=False):
        current_path = Path(current)
        for directory in directories:
            if (current_path / directory).is_symlink():
                raise RetentionError("restic legacy migration refuses symlink directories")
        for filename in files:
            candidate = current_path / filename
            if candidate.is_symlink():
                raise RetentionError("restic legacy migration refuses symlink content")
            found.add(candidate.relative_to(root).as_posix())
    return found


def validate_restored_prefix_coverage(
    restored_root: Path,
    restored_prefix: str,
    listed_paths: Iterable[str],
    include_layout: bool = False,
) -> Path:
    """Require the declared file set to cover the entire restored tree.

    A previous version walked only ``restored_root/restored_prefix``.  That
    allowed an unexpected sibling outside the prefix to survive a migration,
    which is unsafe for a whole restic snapshot.  The comparison below uses
    paths relative to the restore target, so both omitted files and files
    outside the declared prefix fail closed.
    """
    listed = set(listed_paths)
    prefix = f"{restored_prefix}/" if restored_prefix else ""
    expected = {prefix + path for path in listed}
    if include_layout:
        expected.add(f"{restored_prefix}/retention/controlled-copy-layout.json")
    actual = exact_files_under(restored_root)
    if actual != expected:
        raise RetentionError(
            "restic legacy migration does not enumerate the restored snapshot exactly"
        )
    restored_content = restored_root / restored_prefix
    if not restored_content.is_dir():
        raise RetentionError("restic legacy migration restored prefix is missing")
    return restored_content


def run_restic_backup(
    binary: str,
    repository: str,
    password_file: str,
    root: Path,
    tag: str,
) -> str:
    try:
        result = subprocess.run(
            [binary, "backup", "--json", "--tag", tag, str(root)],
            env=restic_environment(repository, password_file),
            capture_output=True,
            text=True,
            check=False,
            timeout=300,
        )
    except (OSError, subprocess.TimeoutExpired) as error:
        raise RetentionError("restic migration backup failed") from error
    if result.returncode != 0:
        raise RetentionError("restic migration backup returned a failure")
    return restic_result_snapshot_id(result.stdout)


def postgres_binary(name: str) -> str:
    environment_name = "COMMUNICATOR_RETENTION_" + name.upper() + "_BIN"
    configured = os.environ.get(environment_name, "").strip()
    if configured:
        return configured
    discovered = shutil.which(name)
    if discovered:
        return discovered
    for version in ("18", "17", "16", "15"):
        candidate = Path("/usr/lib/postgresql") / version / "bin" / name
        if candidate.is_file() and os.access(candidate, os.X_OK):
            return str(candidate)
    return name


def run_postgres_tool(
    command: list[str], label: str, stdout: int | Any = subprocess.PIPE
) -> subprocess.CompletedProcess[str]:
    try:
        if stdout == subprocess.PIPE:
            result = subprocess.run(
                command,
                capture_output=True,
                text=True,
                check=False,
                timeout=300,
                stdin=subprocess.DEVNULL,
            )
        else:
            result = subprocess.run(
                command,
                stdin=subprocess.DEVNULL,
                stdout=stdout,
                stderr=stdout,
                text=True,
                check=False,
                timeout=300,
            )
    except (OSError, subprocess.TimeoutExpired) as error:
        raise RetentionError(f"controlled-copy PostgreSQL {label} is unavailable") from error
    if result.returncode != 0:
        raise RetentionError(f"controlled-copy PostgreSQL {label} failed")
    return result


class IsolatedPostgres:
    """A throwaway local PostgreSQL cluster for rewriting one core backup."""

    def __init__(self, root: Path):
        self.root = root
        self.data = root / "data"
        configured_socket = os.environ.get(
            "COMMUNICATOR_RETENTION_PG_SOCKET_DIR", "/tmp"
        ).strip()
        self.socket = Path(configured_socket or "/tmp")
        self.socket.mkdir(parents=True, exist_ok=True)
        self.port = self._free_port()
        self.user = "communicator_retention"
        self.started = False

    @staticmethod
    def _free_port() -> int:
        import socket

        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
            probe.bind(("127.0.0.1", 0))
            return int(probe.getsockname()[1])

    def __enter__(self) -> "IsolatedPostgres":
        run_postgres_tool(
            [
                postgres_binary("initdb"),
                "--no-locale",
                "--encoding=UTF8",
                "--username",
                self.user,
                str(self.data),
            ],
            "initdb",
        )
        run_postgres_tool(
            [
                postgres_binary("pg_ctl"),
                "--pgdata",
                str(self.data),
                "--log",
                str(self.root / "postgres.log"),
                "--wait",
                "start",
                "--options",
                f"-F -p {self.port} -k {self.socket} -c listen_addresses=''",
            ],
            "server start",
            stdout=subprocess.DEVNULL,
        )
        self.started = True
        return self

    def __exit__(self, _exc_type: Any, _exc: Any, _traceback: Any) -> None:
        if self.started:
            try:
                run_postgres_tool(
                    [
                        postgres_binary("pg_ctl"),
                        "--pgdata",
                        str(self.data),
                        "--wait",
                        "stop",
                        "--mode",
                        "fast",
                    ],
                    "server stop",
                    stdout=subprocess.DEVNULL,
                )
            finally:
                self.started = False

    def _client(self, database: str, sql: str, variables: Mapping[str, str]) -> list[str]:
        command = [
            postgres_binary("psql"),
            "--no-psqlrc",
            "--tuples-only",
            "--no-align",
            "--quiet",
            "--host",
            str(self.socket),
            "--port",
            str(self.port),
            "--username",
            self.user,
        ]
        command.extend(
            [
                "--dbname",
                database,
                "--command",
                render_sql_variables(sql, variables),
            ]
        )
        return command

    def create_database(self, database: str) -> None:
        run_postgres_tool(
            [
                postgres_binary("createdb"),
                "--host",
                str(self.socket),
                "--port",
                str(self.port),
                "--username",
                self.user,
                database,
            ],
            "database create",
        )

    def restore(self, database: str, dump: Path) -> None:
        run_postgres_tool(
            [
                postgres_binary("pg_restore"),
                "--exit-on-error",
                "--no-owner",
                "--no-acl",
                "--host",
                str(self.socket),
                "--port",
                str(self.port),
                "--username",
                self.user,
                "--dbname",
                database,
                str(dump),
            ],
            "dump restore",
        )

    def query(self, database: str, sql: str, variables: Mapping[str, str] = {}) -> str:
        result = run_postgres_tool(self._client(database, sql, variables), "query")
        return result.stdout.strip()

    def execute(self, database: str, sql: str, variables: Mapping[str, str] = {}) -> None:
        run_postgres_tool(self._client(database, sql, variables), "mutation")

    def dump(self, database: str, destination: Path) -> None:
        run_postgres_tool(
            [
                postgres_binary("pg_dump"),
                "--format=custom",
                "--no-owner",
                "--no-acl",
                "--host",
                str(self.socket),
                "--port",
                str(self.port),
                "--username",
                self.user,
                "--dbname",
                database,
                "--file",
                str(destination),
            ],
            "dump export",
        )


def core_layout_from_tree(
    restored_content: Path, spec: Mapping[str, Any]
) -> tuple[list[dict[str, str]], list[str], bool]:
    layout_path = restored_content / "retention/controlled-copy-layout.json"
    layout: dict[str, Any] | None = None
    if layout_path.is_file():
        try:
            parsed = json.loads(layout_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as error:
            raise RetentionError("core backup layout is unreadable") from error
        if not isinstance(parsed, dict):
            raise RetentionError("core backup layout is invalid")
        layout = parsed
    if layout is not None:
        if layout.get("version") != 1 or layout.get("format") != CORE_BACKUP_FORMAT:
            raise RetentionError("core backup layout format is unsupported")
        raw_databases = layout.get("databases")
        raw_files = layout.get("files")
        if not isinstance(raw_databases, list) or not isinstance(raw_files, list):
            raise RetentionError("core backup layout coverage is invalid")
        databases = parse_core_database_contracts(raw_databases)
        files = [safe_relative_path(value, "core backup layout file") for value in raw_files]
        if len(files) != len(set(files)):
            raise RetentionError("core backup layout file coverage is duplicated")
        declared = spec.get("databases")
        if declared is not None:
            if parse_core_database_contracts(declared) != databases:
                raise RetentionError("core migration and backup database contracts differ")
        return databases, files, True

    if spec.get("format") == LEGACY_CORE_BACKUP_FORMAT:
        return legacy_core_layout_from_tree(restored_content)

    databases = parse_core_database_contracts(spec.get("databases"))
    files = spec.get("files")
    if not isinstance(files, list) or not files:
        raise RetentionError("legacy core migration requires exhaustive file coverage")
    return databases, [safe_relative_path(value, "core migration file") for value in files], False


def legacy_core_layout_from_tree(
    restored_content: Path,
) -> tuple[list[dict[str, str]], list[str], bool]:
    """Build a layout for a pre-sidecar backup-core snapshot.

    This recognizes only the exact tree emitted by the original script.  The
    four database dumps and runtime/credential files are fixed; media files
    may vary only below Synapse's media store.  An intermediate backup may
    also contain the descriptive controlled-copy manifest, but it is not
    required by the original format.  The caller still compares the resulting
    list with the entire restore target so a sibling outside the declared
    prefix cannot be silently preserved.
    """
    actual = exact_files_under(restored_content)
    missing = LEGACY_CORE_REQUIRED_FILES - actual
    if missing:
        raise RetentionError("legacy communicator core backup is missing required files")
    unexpected = {
        path
        for path in actual - LEGACY_CORE_REQUIRED_FILES - LEGACY_CORE_OPTIONAL_FILES
        if not path.startswith(LEGACY_CORE_MEDIA_PREFIX)
    }
    if unexpected:
        raise RetentionError("legacy communicator core backup contains unexpected files")

    required_directories = {
        str(Path(path).parent).replace("\\", "/")
        for path in LEGACY_CORE_REQUIRED_FILES | (actual & LEGACY_CORE_OPTIONAL_FILES)
        if "/" in path
    }
    for current, directories, _files in os.walk(restored_content, followlinks=False):
        current_path = Path(current)
        for directory in directories:
            relative = (current_path / directory).relative_to(restored_content).as_posix()
            if relative == "synapse-data/media_store" or relative.startswith(
                LEGACY_CORE_MEDIA_PREFIX
            ):
                continue
            if relative not in required_directories:
                raise RetentionError(
                    "legacy communicator core backup contains unexpected directories"
                )

    return (
        [
            {
                "name": name,
                "path": CORE_DATABASE_DUMP_PATHS[name],
                "contract": contract,
            }
            for name, contract in CORE_DATABASE_CONTRACTS.items()
        ],
        sorted(actual),
        False,
    )


def write_core_layout_sidecar(restored_content: Path) -> None:
    """Persist the validated layout on a migrated pre-sidecar replacement."""
    writer = Path(__file__).with_name("write-controlled-copy-layout.py")
    try:
        result = subprocess.run(
            [sys.executable, str(writer), str(restored_content)],
            capture_output=True,
            text=True,
            check=False,
            timeout=30,
        )
    except (OSError, subprocess.TimeoutExpired) as error:
        raise RetentionError("legacy core layout sidecar could not be written") from error
    if result.returncode != 0:
        raise RetentionError("legacy core layout sidecar could not be written")


def parse_core_database_contracts(value: Any) -> list[dict[str, str]]:
    if not isinstance(value, list) or not value:
        raise RetentionError("core database contracts are required")
    parsed: list[dict[str, str]] = []
    names: set[str] = set()
    paths: set[str] = set()
    for raw in value:
        if not isinstance(raw, dict):
            raise RetentionError("core database contract is invalid")
        name = required_string(raw.get("name"), "core database name")
        path = safe_relative_path(raw.get("path"), "core database dump path")
        contract = required_string(raw.get("contract"), "core database contract")
        if name not in CORE_DATABASE_CONTRACTS or CORE_DATABASE_CONTRACTS[name] != contract:
            raise RetentionError("core database contract is unsupported")
        if name in names or path in paths:
            raise RetentionError("core database contract is duplicated")
        names.add(name)
        paths.add(path)
        parsed.append({"name": name, "path": path, "contract": contract})
    return parsed


SYNAPSE_CORE_EVENT_QUERY = """
SELECT events.type, event_json.json::jsonb::text
FROM events
INNER JOIN event_json
  ON event_json.room_id = events.room_id
 AND event_json.event_id = events.event_id
WHERE events.room_id = :'room_id' AND events.event_id = :'event_id'
"""

BRIDGE_CORE_COLUMN_QUERY = """
SELECT count(*)
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = :'table_name'
  AND column_name = ANY(string_to_array(:'columns', ','))
"""


def one_query_line(value: str, label: str) -> str:
    lines = [line.strip() for line in value.splitlines() if line.strip()]
    if len(lines) != 1:
        raise RetentionError(f"core migration {label} is not unique")
    return lines[0]


def core_synapse_event(
    postgres: IsolatedPostgres, database: str, target: Mapping[str, Any]
) -> tuple[str, dict[str, Any]]:
    output = postgres.query(
        database,
        SYNAPSE_CORE_EVENT_QUERY,
        {
            "room_id": required_string(target.get("room_id"), "core Synapse room id"),
            "event_id": required_string(target.get("event_id"), "core Synapse event id"),
        },
    )
    line = one_query_line(output, "Synapse event mapping")
    try:
        event_type, event_json = line.split("|", 1)
        value = json.loads(event_json)
    except (ValueError, json.JSONDecodeError) as error:
        raise RetentionError("core Synapse event JSON is invalid") from error
    if not isinstance(value, dict):
        raise RetentionError("core Synapse event JSON is not an object")
    if value.get("event_id") != target.get("event_id") or value.get("room_id") != target.get("room_id"):
        raise RetentionError("core Synapse event JSON identity does not match the target")
    expected_type = required_string(target.get("event_type"), "core Synapse event type")
    if event_type != expected_type or event_type not in CORE_EVENT_TYPES:
        raise RetentionError("core Synapse event type does not match the supported contract")
    return event_type, value


def synapse_event_content_is_redacted(value: Mapping[str, Any]) -> bool:
    content = value.get("content")
    # The supported message contracts are deliberately strict.  A denylist
    # would let a provider-specific body field survive a retention pass.
    return content == {}


def rewrite_core_synapse(
    postgres: IsolatedPostgres, database: str, target: Mapping[str, Any]
) -> None:
    event_type, event_json = core_synapse_event(postgres, database, target)
    if synapse_event_content_is_redacted(event_json):
        return
    redacted = dict(event_json)
    redacted["content"] = {}
    postgres.execute(
        database,
        """
        UPDATE event_json
        SET json = :'redacted_json'
        WHERE room_id = :'room_id' AND event_id = :'event_id'
          AND EXISTS (
            SELECT 1 FROM events
            WHERE events.room_id = event_json.room_id
              AND events.event_id = event_json.event_id
              AND events.type = :'event_type'
          )
        """,
        {
            "redacted_json": json.dumps(redacted, separators=(",", ":")),
            "room_id": required_string(target.get("room_id"), "core Synapse room id"),
            "event_id": required_string(target.get("event_id"), "core Synapse event id"),
            "event_type": event_type,
        },
    )
    _event_type, updated = core_synapse_event(postgres, database, target)
    if not synapse_event_content_is_redacted(updated):
        raise RetentionError("core Synapse event JSON still contains message content")


def verify_core_synapse(
    postgres: IsolatedPostgres, database: str, target: Mapping[str, Any]
) -> None:
    _event_type, event_json = core_synapse_event(postgres, database, target)
    if not synapse_event_content_is_redacted(event_json):
        raise RetentionError("rewritten core Synapse dump still contains message content")


def bridge_column_count(
    postgres: IsolatedPostgres, database: str, table: str, columns: str
) -> int:
    output = postgres.query(
        database,
        BRIDGE_CORE_COLUMN_QUERY,
        {"table_name": table, "columns": columns},
    )
    try:
        return int(one_query_line(output, "bridge schema contract"))
    except ValueError as error:
        raise RetentionError("core bridge schema contract count is invalid") from error


def bridge_target_count(
    postgres: IsolatedPostgres, database: str, target: Mapping[str, Any]
) -> int:
    output = postgres.query(
        database,
        """
        SELECT count(*) FROM message
        WHERE bridge_id = :'bridge_id'
          AND id = :'message_id'
          AND part_id = :'part_id'
        """,
        {
            "bridge_id": required_string(target.get("bridge_id"), "core bridge id"),
            "message_id": required_string(target.get("message_id"), "core bridge message id"),
            "part_id": required_string(target.get("part_id"), "core bridge part id"),
        },
    )
    try:
        return int(one_query_line(output, "bridge target count"))
    except ValueError as error:
        raise RetentionError("core bridge target count is invalid") from error


def rewrite_core_bridge(
    postgres: IsolatedPostgres, database: str, target: Mapping[str, Any]
) -> None:
    if bridge_column_count(postgres, database, "message", "bridge_id,id,part_id") != 3:
        raise RetentionError("core bridge message schema is unsupported")
    if bridge_column_count(
        postgres, database, "reaction", "bridge_id,message_id,message_part_id"
    ) != 3:
        raise RetentionError("core bridge reaction schema is unsupported")
    if bridge_target_count(postgres, database, target) != 1:
        raise RetentionError("core bridge target mapping is not unique")
    postgres.execute(
        database,
        """
        BEGIN;
        DELETE FROM reaction
        WHERE bridge_id = :'bridge_id'
          AND message_id = :'message_id'
          AND message_part_id = :'part_id';
        DELETE FROM message
        WHERE bridge_id = :'bridge_id'
          AND id = :'message_id'
          AND part_id = :'part_id';
        COMMIT;
        """,
        {
            "bridge_id": required_string(target.get("bridge_id"), "core bridge id"),
            "message_id": required_string(target.get("message_id"), "core bridge message id"),
            "part_id": required_string(target.get("part_id"), "core bridge part id"),
        },
    )
    if bridge_target_count(postgres, database, target) != 0:
        raise RetentionError("core bridge target row remains after rewrite")


def verify_core_bridge(
    postgres: IsolatedPostgres, database: str, target: Mapping[str, Any]
) -> None:
    if bridge_target_count(postgres, database, target) != 0:
        raise RetentionError("rewritten core bridge dump still contains target row")


def rewrite_core_database(
    postgres: IsolatedPostgres,
    database: str,
    contract: str,
    targets: Iterable[Mapping[str, Any]],
) -> None:
    for target in targets:
        if target.get("contract") != contract:
            raise RetentionError("core target contract differs from dump contract")
        if contract == "synapse-event-json-v1":
            rewrite_core_synapse(postgres, database, target)
        elif contract == "mautrix-bridge-message-v1":
            rewrite_core_bridge(postgres, database, target)
        else:
            raise RetentionError("core database contract is unsupported")


def verify_core_database(
    postgres: IsolatedPostgres,
    database: str,
    contract: str,
    targets: Iterable[Mapping[str, Any]],
) -> None:
    for target in targets:
        if contract == "synapse-event-json-v1":
            verify_core_synapse(postgres, database, target)
        elif contract == "mautrix-bridge-message-v1":
            verify_core_bridge(postgres, database, target)
        else:
            raise RetentionError("core database contract is unsupported")


def remove_core_media(restored_content: Path, targets: Iterable[Mapping[str, Any]]) -> None:
    seen: set[str] = set()
    for target in targets:
        for relative in target.get("media_paths", []):
            path = safe_path(restored_content, required_string(relative, "core media path"))
            normalized = path.relative_to(restored_content).as_posix()
            if normalized in seen:
                raise RetentionError("core media path is duplicated across targets")
            seen.add(normalized)
            if not normalized.startswith("synapse-data/media_store/"):
                raise RetentionError("core media path is outside the Synapse media store")
            if not path.is_file() or path.is_symlink():
                raise RetentionError("core media path is not an ordinary file")
            path.unlink()


def verify_restic_snapshot(
    binary: str, repository: str, password_file: str, snapshot_id: str, tag: str
) -> None:
    try:
        result = subprocess.run(
            [binary, "snapshots", "--json", "--tag", tag],
            env=restic_environment(repository, password_file),
            capture_output=True,
            text=True,
            check=False,
            timeout=120,
        )
    except (OSError, subprocess.TimeoutExpired) as error:
        raise RetentionError("restic replacement inventory is unavailable") from error
    if result.returncode != 0:
        raise RetentionError("restic replacement inventory failed")
    try:
        snapshots = json.loads(result.stdout)
    except json.JSONDecodeError as error:
        raise RetentionError("restic replacement inventory is not JSON") from error
    if not isinstance(snapshots, list):
        raise RetentionError("restic replacement inventory response is invalid")
    for snapshot in snapshots:
        if not isinstance(snapshot, dict):
            continue
        candidate = snapshot.get("id")
        tags = snapshot.get("tags", [])
        if (
            isinstance(candidate, str)
            and candidate == snapshot_id
            and isinstance(tags, list)
            and tag in tags
        ):
            return
    raise RetentionError("restic replacement snapshot was not verified")


def replace_manifest_after_core_migration(
    old_reference: str, snapshot_id: str, migrated_at: str
) -> None:
    replace_manifest_after_migration(
        old_reference=old_reference,
        message_entries=[
            {
                "reference": f"restic:{snapshot_id}",
                "snapshot_id": snapshot_id,
                "resource_id": "*",
                "content_generation": "*",
                "copy_created_at": migrated_at,
                "content_classes": [
                    "message",
                    "session_credential",
                    "account_key",
                ],
                "format": CORE_BACKUP_FORMAT,
                "detail": (
                    "communicator-core custom-format databases were rewritten in an "
                    "isolated PostgreSQL cluster; credentials and unrelated rows were preserved"
                ),
            }
        ],
        auxiliary_entries={},
    )


def migrate_core_restic_copy(
    copy: Mapping[str, Any],
    target_scope: Mapping[str, Any],
    spec: Mapping[str, Any],
    restored_root: Path,
    restored_content: Path,
    repository: str,
    password_file: str,
    binary: str,
    restored_parent: Path,
) -> dict[str, Any]:
    databases, layout_files, has_layout = core_layout_from_tree(restored_content, spec)
    validate_restored_prefix_coverage(
        restored_root,
        str(spec.get("restored_prefix", "")),
        layout_files,
        include_layout=has_layout,
    )
    database_by_name = {database["name"]: database for database in databases}
    target_resource = required_string(target_scope.get("resource_id"), "migration target resource id")
    target_generation = required_string(
        target_scope.get("content_generation"), "migration target content generation"
    )
    targets = [
        target
        for target in spec["targets"]
        if target["resource_id"] == target_resource
        and target["content_generation"] == target_generation
    ]
    if not targets:
        raise RetentionError("core migration does not map the removed message lineage")
    for target in targets:
        if target["database"] not in database_by_name:
            raise RetentionError("core migration target database dump is missing")
        dump = restored_content / database_by_name[target["database"]]["path"]
        if not dump.is_file() or dump.is_symlink():
            raise RetentionError("core migration database dump is not an ordinary file")
        for media_path in target.get("media_paths", []):
            candidate = safe_path(restored_content, media_path)
            if not candidate.is_file() or candidate.is_symlink():
                raise RetentionError("core migration media mapping is incomplete")

    targets_by_database: dict[str, list[Mapping[str, Any]]] = {}
    for target in targets:
        targets_by_database.setdefault(target["database"], []).append(target)

    with IsolatedPostgres(restored_parent / "postgres") as postgres:
        for index, (database_name, database_targets) in enumerate(targets_by_database.items()):
            database_spec = database_by_name[database_name]
            database = f"retention_{index}"
            postgres.create_database(database)
            dump = restored_content / database_spec["path"]
            postgres.restore(database, dump)
            rewrite_core_database(
                postgres,
                database,
                database_spec["contract"],
                database_targets,
            )
            replacement_dump = restored_parent / database_spec["path"]
            replacement_dump.parent.mkdir(parents=True, exist_ok=True)
            postgres.dump(database, replacement_dump)

            verify_database = f"verify_{index}"
            postgres.create_database(verify_database)
            postgres.restore(verify_database, replacement_dump)
            verify_core_database(
                postgres,
                verify_database,
                database_spec["contract"],
                database_targets,
            )
            os.replace(replacement_dump, dump)

    remove_core_media(restored_content, targets)
    if not has_layout:
        write_core_layout_sidecar(restored_content)
    replacement_tag = "communicator-core-migrated"
    replacement_id = run_restic_backup(
        binary,
        repository,
        password_file,
        restored_content,
        replacement_tag,
    )
    if replacement_id == required_string(copy.get("snapshot_id"), "restic snapshot id"):
        raise RetentionError("restic migration returned the legacy snapshot id")
    verify_restic_snapshot(
        binary, repository, password_file, replacement_id, replacement_tag
    )
    snapshot_id = required_string(copy.get("snapshot_id"), "restic snapshot id")
    try:
        result = subprocess.run(
            [binary, "forget", snapshot_id, "--prune"],
            env=restic_environment(repository, password_file),
            capture_output=True,
            text=True,
            check=False,
            timeout=300,
        )
    except (OSError, subprocess.TimeoutExpired) as error:
        raise RetentionError("restic core migration forget is unavailable") from error
    if result.returncode != 0:
        raise RetentionError("restic core migration forget returned a failure")
    migrated_at = utc_now()
    replace_manifest_after_core_migration(
        required_string(copy.get("reference"), "copy reference"),
        replacement_id,
        migrated_at,
    )
    return {
        "status": "aged_out",
        "content_present": False,
        "evidence_source": "restic_core_database_rewrite",
        "object_reference": copy.get("reference"),
        "detail": (
            "Communicator core custom-format database dumps were restored, rewritten "
            "by supported row contracts, re-dumped, verified, and snapshotted before prune"
        ),
    }


def migrate_legacy_restic_copy(
    copy: Mapping[str, Any], target_scope: Mapping[str, Any]
) -> dict[str, Any] | None:
    """Split one exhaustively-described mixed snapshot before forgetting it.

    A legacy snapshot is eligible only when an operator-provided manifest maps
    every regular file to one exact message lineage or one protected class.
    Each retained message lineage gets its own new message-only snapshot; the
    protected classes get separate auxiliary snapshots.  The old mixed
    snapshot is forgotten only after every replacement backup has returned an
    exact snapshot id.
    """
    migration_path = restic_migration_manifest_path()
    if migration_path is None:
        return None
    snapshot_id = required_string(copy.get("snapshot_id"), "restic snapshot id")
    try:
        spec = read_legacy_migration_spec(snapshot_id)
        if spec is None:
            return None
        configuration = restic_configuration()
        if configuration is None:
            raise RetentionError("restic repository credentials are not configured")
        repository, password_file, binary = configuration
        restored_parent = Path(
            tempfile.mkdtemp(prefix="controlled-copy-restic-restore-")
        )
        try:
            restored_root = restored_parent / "tree"
            restored_root.mkdir()
            try:
                result = subprocess.run(
                    [binary, "restore", snapshot_id, "--target", str(restored_root)],
                    env=restic_environment(repository, password_file),
                    capture_output=True,
                    text=True,
                    check=False,
                    timeout=300,
                )
            except (OSError, subprocess.TimeoutExpired) as error:
                raise RetentionError("restic legacy restore failed") from error
            if result.returncode != 0:
                raise RetentionError("restic legacy restore returned a failure")

            restored_content = restored_root / str(spec["restored_prefix"])
            if spec.get("kind") == "core":
                return migrate_core_restic_copy(
                    copy,
                    target_scope,
                    spec,
                    restored_root,
                    restored_content,
                    repository,
                    password_file,
                    binary,
                    restored_parent,
                )

            entries = spec["entries"]
            listed_paths = {entry["path"] for entry in entries}
            validate_restored_prefix_coverage(
                restored_root,
                str(spec["restored_prefix"]),
                listed_paths,
            )

            target_resource = target_scope.get("resource_id")
            target_generation = target_scope.get("content_generation")
            if not isinstance(target_resource, str) or not isinstance(target_generation, str):
                raise RetentionError("restic legacy migration target lineage is invalid")
            target_entries = [
                entry
                for entry in entries
                if entry["content_class"] == "message"
                and entry["resource_id"] == target_resource
                and entry["content_generation"] == target_generation
            ]
            if not target_entries:
                raise RetentionError(
                    "restic legacy migration does not map the removed message lineage"
                )

            grouped: dict[tuple[str, str], list[dict[str, str]]] = {}
            protected: dict[str, list[dict[str, str]]] = {}
            for entry in entries:
                if entry["content_class"] == "message":
                    grouped.setdefault(
                        (entry["resource_id"], entry["content_generation"]), []
                    ).append(entry)
                else:
                    protected.setdefault(entry["content_class"], []).append(entry)

            replacement_ids: list[str] = []
            migrated_at = utc_now()
            migrated_messages: list[dict[str, Any]] = []
            migrated_auxiliary: dict[str, list[dict[str, Any]]] = {
                "session_credentials": [],
                "account_keys": [],
            }
            for lineage, lineage_entries in grouped.items():
                if lineage == (target_resource, target_generation):
                    continue
                output_root = restored_parent / (
                    "message-" + hashlib.sha256("\x00".join(lineage).encode()).hexdigest()[:16]
                )
                for entry in lineage_entries:
                    copy_tree_entry(
                        restored_content / entry["path"], output_root, entry["path"]
                    )
                replacement_id = run_restic_backup(
                    binary,
                    repository,
                    password_file,
                    output_root,
                    "communicator-message-migrated",
                )
                if replacement_id == snapshot_id:
                    raise RetentionError("restic migration returned the legacy snapshot id")
                replacement_ids.append(replacement_id)
                migrated_messages.append(
                    {
                        "reference": f"restic:{replacement_id}",
                        "snapshot_id": replacement_id,
                        "resource_id": lineage[0],
                        "content_generation": lineage[1],
                        "copy_created_at": migrated_at,
                        "content_classes": ["message"],
                        "exclusive_resource_id": True,
                        "detail": "message-only replacement from an exhaustively mapped legacy snapshot",
                    }
                )

            for content_class, class_entries in protected.items():
                store = (
                    "session_credentials"
                    if content_class == "session_credential"
                    else "account_keys"
                )
                output_root = restored_parent / content_class
                for entry in class_entries:
                    copy_tree_entry(
                        restored_content / entry["path"], output_root, entry["path"]
                    )
                replacement_id = run_restic_backup(
                    binary,
                    repository,
                    password_file,
                    output_root,
                    f"communicator-{store}-migrated",
                )
                if replacement_id == snapshot_id:
                    raise RetentionError("restic migration returned the legacy snapshot id")
                replacement_ids.append(replacement_id)
                migrated_auxiliary[store].append(
                    {
                        "reference": f"restic:{replacement_id}",
                        "snapshot_id": replacement_id,
                        "resource_id": "*",
                        "content_generation": "*",
                        "copy_created_at": migrated_at,
                        "content_class": content_class,
                        "detail": "protected replacement from an exhaustively mapped legacy snapshot",
                    }
                )

            if not replacement_ids:
                raise RetentionError("restic legacy migration produced no protected replacement")
            try:
                result = subprocess.run(
                    [binary, "forget", snapshot_id, "--prune"],
                    env=restic_environment(repository, password_file),
                    capture_output=True,
                    text=True,
                    check=False,
                    timeout=300,
                )
            except (OSError, subprocess.TimeoutExpired) as error:
                raise RetentionError("restic legacy forget failed") from error
            if result.returncode != 0:
                raise RetentionError("restic legacy forget returned a failure")

            replace_manifest_after_migration(
                old_reference=required_string(copy.get("reference"), "copy reference"),
                message_entries=migrated_messages,
                auxiliary_entries=migrated_auxiliary,
            )
            return {
                "status": "aged_out",
                "content_present": False,
                "evidence_source": "restic_legacy_split_migration",
                "object_reference": copy.get("reference"),
                "detail": (
                    "Mixed restic snapshot was replaced by per-lineage message snapshots "
                    "and separate protected credential snapshots before prune"
                ),
            }
        finally:
            shutil.rmtree(restored_parent, ignore_errors=True)
    except (OSError, RetentionError) as error:
        return {
            "status": "lifecycle_pending",
            "content_present": True,
            "evidence_source": "restic_legacy_split_migration",
            "object_reference": copy.get("reference"),
            "detail": str(error),
        }


def replace_manifest_after_migration(
    old_reference: str,
    message_entries: Iterable[Mapping[str, Any]],
    auxiliary_entries: Mapping[str, Iterable[Mapping[str, Any]]],
) -> None:
    path = manifest_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    lock_path = path.with_suffix(path.suffix + ".lock")
    with lock_path.open("a+") as lock:
        fcntl.flock(lock.fileno(), fcntl.LOCK_EX)
        document = parse_json_file(path)
        stores = document.setdefault("stores", {})
        if not isinstance(stores, dict):
            raise RetentionError("controlled-copy manifest stores are invalid")
        restic_store = stores.setdefault("restic_snapshot", {})
        if not isinstance(restic_store, dict):
            raise RetentionError("controlled-copy restic manifest is invalid")
        copies = restic_store.setdefault("copies", [])
        if not isinstance(copies, list):
            raise RetentionError("controlled-copy restic copies are invalid")
        restic_store["copies"] = [
            entry
            for entry in copies
            if not isinstance(entry, dict) or entry.get("reference") != old_reference
        ]
        references = {
            entry.get("reference")
            for entry in restic_store["copies"]
            if isinstance(entry, dict)
        }
        for entry in message_entries:
            reference = required_string(entry.get("reference"), "migrated restic reference")
            if reference not in references:
                restic_store["copies"].append(dict(entry))
                references.add(reference)
        # The migration knows this one snapshot exhaustively, but other
        # historical snapshots may still be outside the sidecar.  Keep the
        # aggregate inventory fail-closed until a provider-wide scan proves it.
        restic_store["enumeration_complete"] = False
        stores["restic_snapshot"] = restic_store
        for store, entries in auxiliary_entries.items():
            store_document = stores.setdefault(store, {})
            if not isinstance(store_document, dict):
                raise RetentionError(f"controlled-copy {store} manifest is invalid")
            store_copies = store_document.setdefault("copies", [])
            if not isinstance(store_copies, list):
                raise RetentionError(f"controlled-copy {store} copies are invalid")
            known = {
                entry.get("reference")
                for entry in store_copies
                if isinstance(entry, dict)
            }
            for entry in entries:
                reference = required_string(entry.get("reference"), "migrated protected reference")
                if reference not in known:
                    store_copies.append(dict(entry))
                    known.add(reference)
            store_document["enumeration_complete"] = False
            stores[store] = store_document
        temporary_fd, temporary_name = tempfile.mkstemp(
            prefix="controlled-copy-migration-", dir=path.parent
        )
        os.close(temporary_fd)
        temporary = Path(temporary_name)
        try:
            temporary.write_text(json.dumps(document, indent=2) + "\n", encoding="utf-8")
            temporary.chmod(0o600)
            os.replace(temporary, path)
        finally:
            temporary.unlink(missing_ok=True)


def cleanup_restic_copy(
    copy: Mapping[str, Any], target_scope: Mapping[str, Any] | None = None
) -> dict[str, Any]:
    classes = copy.get("content_classes")
    if classes != ["message"]:
        migrated = migrate_legacy_restic_copy(copy, target_scope or {})
        if migrated is not None:
            return migrated
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
    configuration = restic_configuration()
    snapshot = required_string(copy.get("snapshot_id"), "restic snapshot id")
    if configuration is None:
        return {
            "status": "unknown",
            "content_present": True,
            "evidence_source": "restic_configuration_missing",
            "object_reference": copy.get("reference"),
            "detail": "Restic repository credentials are not configured",
        }
    repository, password_file, restic_binary = configuration
    try:
        result = subprocess.run(
            [restic_binary, "forget", snapshot, "--prune"],
            env=restic_environment(repository, password_file),
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
    """Redact one mapped Matrix event and wait for Synapse's DB censor.

    The public Matrix event API can apply redaction virtually while the
    unredacted JSON remains in Synapse.  When the host database is configured,
    the exact room/event row and its stored JSON are inspected.  The
    ``redactions.have_censored`` bit is supporting evidence only: a censored
    bit with intact sensitive JSON remains quarantined.  Without an exact
    database observation, the adapter records only quarantine evidence and
    never claims physical removal.
    """
    room_id = copy.get("room_id")
    event_id = copy.get("event_id")
    if not isinstance(event_id, str) or not event_id.strip():
        return {
            "status": "unknown",
            "content_present": True,
            "evidence_source": "synapse_lineage_missing",
            "object_reference": copy.get("reference"),
            "detail": "Exact Matrix event mapping is unavailable",
        }

    database_configuration = synapse_database_configuration()
    event_type = copy.get("event_type", "m.room.message")
    if event_type not in CORE_EVENT_TYPES:
        return {
            "status": "unknown",
            "content_present": True,
            "evidence_source": "synapse_event_type_unsupported",
            "object_reference": copy.get("reference"),
            "detail": "The mapped Synapse event type is outside the supported message contract",
        }
    initial_state = synapse_event_state(event_id, room_id, event_type)
    if initial_state in {"censored", "redacted", "missing"}:
        remove_manifest_entry("synapse", required_string(copy.get("reference"), "copy reference"))
        return {
            "status": "expired" if initial_state in {"censored", "redacted"} else "missing",
            "content_present": False,
            "evidence_source": "synapse_event_json_censor",
            "object_reference": copy.get("reference"),
            "detail": (
                "Synapse stored event_json has no sensitive message content"
                if initial_state in {"censored", "redacted"}
                else "Synapse event_json no longer contains the mapped event"
            ),
        }
    if initial_state in {"intact_censored", "type_mismatch", "unsupported"}:
        return {
            "status": "quarantined",
            "content_present": True,
            "evidence_source": "synapse_event_json_inconsistent",
            "object_reference": copy.get("reference"),
            "detail": (
                "Synapse redactions.have_censored is set while stored event_json still "
                "contains message content"
                if initial_state == "intact_censored"
                else "Synapse stored event does not match the exact supported lineage contract"
            ),
        }

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

    if configuration is None:
        return {
            "status": "quarantined" if initial_state == "redacted" else "unknown",
            "content_present": True,
            "evidence_source": (
                "synapse_event_json_censor"
                if database_configuration is not None
                else "synapse_credentials_missing"
            ),
            "object_reference": copy.get("reference"),
            "detail": (
                "Synapse redaction is recorded; the configured database censor sweep has not completed"
                if initial_state == "redacted"
                else "Synapse redaction credentials are not configured"
            ),
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

    if database_configuration is not None:
        final_state = synapse_event_state(event_id, room_id, event_type)
        if final_state in {"censored", "redacted", "missing"}:
            remove_manifest_entry(
                "synapse", required_string(copy.get("reference"), "copy reference")
            )
            return {
                "status": "expired" if final_state in {"censored", "redacted"} else "missing",
                "content_present": False,
                "evidence_source": "synapse_event_json_censor",
                "object_reference": copy.get("reference"),
                "detail": (
                    "Synapse stored event_json has no sensitive message content"
                    if final_state in {"censored", "redacted"}
                    else "Synapse event_json no longer contains the mapped event"
                ),
            }
        if final_state in {"intact_censored", "type_mismatch", "unsupported"}:
            return {
                "status": "quarantined",
                "content_present": True,
                "evidence_source": "synapse_event_json_inconsistent",
                "object_reference": copy.get("reference"),
                "detail": (
                    "Synapse redactions.have_censored is set while stored event_json still "
                    "contains message content"
                    if final_state == "intact_censored"
                    else "Synapse stored event does not match the exact supported lineage contract"
                ),
            }
        return {
            "status": "quarantined",
            "content_present": True,
            "evidence_source": "synapse_event_json_censor",
            "object_reference": copy.get("reference"),
            "detail": "Synapse redaction accepted; the five-minute censor sweep has not completed",
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
        if store == "synapse" and synapse_database_configuration() is not None:
            return inventory_synapse_from_server(scope)
        if store == "restic_snapshot" and restic_configuration() is not None:
            return restic_snapshot_inventory(scope)
        if store == "session_credentials" and restic_configuration() is not None:
            return restic_snapshot_inventory(
                scope,
                store,
                ("communicator-session_credentials-migrated",),
            )
        if store == "account_keys" and restic_configuration() is not None:
            return restic_snapshot_inventory(
                scope,
                store,
                ("communicator-account_keys-migrated",),
            )
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
        return cleanup_restic_copy(
            copy,
            {
                "resource_id": payload.get("resource_id"),
                "content_generation": payload.get("content_generation"),
            },
        )
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
