#!/usr/bin/env python3
"""Merge the exact snapshot returned by a restic backup into the sidecar."""

from __future__ import annotations

import fcntl
import json
import os
import sys
import tempfile
from pathlib import Path
from typing import Any


def read_snapshot_result(path: Path, fallback_time: str) -> tuple[str, str]:
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except OSError as error:
        raise SystemExit("restic backup result is unreadable") from error

    events: list[Any] = []
    for line in lines:
        if not line.strip():
            continue
        try:
            events.append(json.loads(line))
        except json.JSONDecodeError as error:
            raise SystemExit("restic backup result is not JSON") from error

    if len(events) == 1 and isinstance(events[0], list):
        events = events[0]
    summaries = [
        event
        for event in events
        if isinstance(event, dict)
        and event.get("message_type") == "summary"
        and isinstance(event.get("snapshot_id"), str)
        and event["snapshot_id"].strip()
    ]
    snapshot_ids = {event["snapshot_id"].strip() for event in summaries}
    if len(snapshot_ids) != 1:
        raise SystemExit("restic backup did not identify exactly one snapshot")
    snapshot_id = next(iter(snapshot_ids))
    created_at = next(
        (
            event.get(key)
            for event in summaries
            for key in ("time", "backup_end", "backup_start")
            if isinstance(event.get(key), str) and event[key].strip()
        ),
        fallback_time,
    )
    return snapshot_id, created_at


def read_manifest(path: Path) -> dict[str, Any]:
    try:
        document = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return {"version": 1, "stores": {}}
    except (OSError, json.JSONDecodeError) as error:
        raise SystemExit("controlled-copy manifest is unreadable") from error
    if not isinstance(document, dict):
        raise SystemExit("controlled-copy manifest must be an object")
    stores = document.get("stores")
    if stores is None:
        document["stores"] = {}
    elif not isinstance(stores, dict):
        raise SystemExit("controlled-copy manifest stores are invalid")
    return document


def atomic_write(path: Path, document: dict[str, Any]) -> None:
    temporary_fd, temporary_name = tempfile.mkstemp(
        prefix="controlled-copy-manifest-", dir=path.parent
    )
    temporary = Path(temporary_name)
    try:
        with os.fdopen(temporary_fd, "w", encoding="utf-8") as output:
            output.write(json.dumps(document, indent=2) + "\n")
            output.flush()
            os.fsync(output.fileno())
        temporary.chmod(0o600)
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def merge_snapshot(
    snapshot_result: Path, manifest: Path, fallback_time: str
) -> None:
    snapshot_id, created_at = read_snapshot_result(snapshot_result, fallback_time)
    manifest.parent.mkdir(parents=True, exist_ok=True)
    lock_path = manifest.with_name(f"{manifest.name}.lock")
    with lock_path.open("a+") as lock:
        os.fchmod(lock.fileno(), 0o600)
        fcntl.flock(lock.fileno(), fcntl.LOCK_EX)
        document = read_manifest(manifest)
        stores = document["stores"]
        assert isinstance(stores, dict)
        raw_store = stores.setdefault("restic_snapshot", {})
        if not isinstance(raw_store, dict):
            raise SystemExit("controlled-copy restic manifest is invalid")
        raw_copies = raw_store.setdefault("copies", [])
        if not isinstance(raw_copies, list):
            raise SystemExit("controlled-copy restic copies are invalid")

        reference = f"restic:{snapshot_id}"
        if not any(
            isinstance(copy, dict) and copy.get("reference") == reference
            for copy in raw_copies
        ):
            raw_copies.append(
                {
                    "reference": reference,
                    "snapshot_id": snapshot_id,
                    "resource_id": "*",
                    "content_generation": "*",
                    "copy_created_at": created_at,
                    "content_classes": [
                        "message",
                        "session_credential",
                        "account_key",
                    ],
                    "detail": (
                        "mixed communicator-core snapshot; requires an exclusive "
                        "message-only snapshot for deletion"
                    ),
                }
            )

        # This sidecar is an append-only observation of backup results. It has
        # no authority to claim that every historical restic snapshot was
        # enumerated, especially when another backup can run concurrently.
        raw_store["enumeration_complete"] = False
        raw_store["inventory_detail"] = (
            "Observed backup results are retained; a provider inventory is "
            "required before historical completeness can be claimed"
        )
        stores["restic_snapshot"] = raw_store
        document["version"] = 1
        atomic_write(manifest, document)


def main(argv: list[str]) -> int:
    if len(argv) != 4:
        raise SystemExit(
            "usage: merge-controlled-copy-manifest.py "
            "<restic-backup-jsonl> <manifest> <fallback-time>"
        )
    merge_snapshot(Path(argv[1]), Path(argv[2]), argv[3])
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
