#!/usr/bin/env python3
"""Write the non-secret layout contract for a communicator core backup.

The core backup intentionally keeps the provider databases in PostgreSQL
custom format so the existing restore test remains valid.  This sidecar
identifies the supported database contracts and records every regular file in
the staged tree.  Retention migration uses it to reject an incomplete or
unexpected restored tree before it opens a dump.
"""

from __future__ import annotations

import json
import os
import sys
import tempfile
from pathlib import Path


DATABASES = (
    ("synapse", "synapse.pgdump", "synapse-event-json-v1"),
    ("whatsapp_bridge", "whatsapp.pgdump", "mautrix-bridge-message-v1"),
    ("messenger_bridge", "messenger.pgdump", "mautrix-bridge-message-v1"),
    ("telegram_bridge", "telegram.pgdump", "mautrix-bridge-message-v1"),
)
LAYOUT_RELATIVE = Path("retention/controlled-copy-layout.json")

# The core backup is one authenticated host-wide database/media tree.  This is
# deliberately an explicit coverage contract rather than a wildcard lineage:
# the restore inventory may project the physical aggregate copy onto one exact
# removal scope only after it authenticates this metadata from the selected
# snapshot.
AGGREGATE_COVERAGE = {
    "kind": "aggregate",
    "resource_scope": "host",
    "tenant_scope": "all",
    "account_scope": "all",
}


def write_layout(root: Path) -> None:
    if not root.is_dir():
        raise SystemExit("controlled-copy staging root is missing")
    for name, relative, _contract in DATABASES:
        path = root / relative
        if not path.is_file():
            raise SystemExit(f"controlled-copy database dump is missing: {name}")

    layout_path = root / LAYOUT_RELATIVE
    files = sorted(
        path.relative_to(root).as_posix()
        for path in root.rglob("*")
        if path.is_file() and path != layout_path
    )
    document = {
        "version": 1,
        "format": "communicator-core-pgdump-v1",
        "coverage": AGGREGATE_COVERAGE,
        "databases": [
            {"name": name, "path": relative, "contract": contract}
            for name, relative, contract in DATABASES
        ],
        "files": files,
    }
    layout_path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary_name = tempfile.mkstemp(
        prefix="controlled-copy-layout-", dir=layout_path.parent
    )
    temporary = Path(temporary_name)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as output:
            output.write(json.dumps(document, indent=2) + "\n")
            output.flush()
            os.fsync(output.fileno())
        temporary.chmod(0o600)
        os.replace(temporary, layout_path)
    finally:
        temporary.unlink(missing_ok=True)


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit("usage: write-controlled-copy-layout.py <staging-root>")
    write_layout(Path(sys.argv[1]))
