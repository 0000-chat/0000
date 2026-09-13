#!/usr/bin/env python3
"""Prepare or explicitly execute one pre-registered OAuth client insert."""

from __future__ import annotations

import argparse
import importlib.util
import shlex
import subprocess
from pathlib import Path

_validator_spec = importlib.util.spec_from_file_location(
    "control_plane_oauth_validator",
    Path(__file__).with_name("validate-control-plane-oauth.py"),
)
if _validator_spec is None or _validator_spec.loader is None:
    raise RuntimeError("cannot load OAuth validator")
_validator = importlib.util.module_from_spec(_validator_spec)
_validator_spec.loader.exec_module(_validator)
ConfigurationError = _validator.ConfigurationError
load_client = _validator.load_client
parse_env_file = _validator.parse_env_file
validate = _validator.validate


def sql_quote(value: str) -> str:
    return "'" + value.replace("'", "''") + "'"


def client_sql(client: dict[str, str]) -> str:
    client_id = sql_quote(client["client_id"])
    name = sql_quote(client["client_name"])
    redirect = sql_quote(client["redirect_uri"])
    return (
        "INSERT INTO oauth_clients "
        "(client_id, client_name, redirect_uri, status, created_at, updated_at) "
        f"VALUES ({client_id}, {name}, {redirect}, 'active', "
        "strftime('%Y-%m-%dT%H:%M:%fZ','now'), "
        "strftime('%Y-%m-%dT%H:%M:%fZ','now')) "
        "ON CONFLICT(client_id) DO UPDATE SET "
        "client_name=excluded.client_name, "
        "redirect_uri=excluded.redirect_uri, "
        "status='active', "
        "updated_at=excluded.updated_at;"
    )


def wrangler_command(database: str, environment: str, statement: str) -> list[str]:
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
    else:
        command.extend(("--env", environment, "--remote"))
    command.extend(("--command", statement))
    return command


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Dry-run or explicitly execute one OAuth client bootstrap"
    )
    parser.add_argument("--env-file", type=Path, required=True)
    parser.add_argument("--client-file", type=Path, required=True)
    parser.add_argument(
        "--environment",
        choices=("local", "staging", "production"),
        default="local",
    )
    parser.add_argument("--database", default="CONTROL_DB")
    parser.add_argument("--execute", action="store_true")
    parser.add_argument("--allow-placeholders", action="store_true")
    args = parser.parse_args(argv)

    if args.execute and args.allow_placeholders:
        parser.error("--execute cannot be combined with --allow-placeholders")

    try:
        values = parse_env_file(args.env_file)
        client = load_client(args.client_file)
        validate(
            values,
            client,
            args.environment,
            args.allow_placeholders,
            require_signing_secret=False,
        )
    except (OSError, ConfigurationError) as error:
        print(f"OAuth bootstrap invalid: {error}")
        return 2

    statement = client_sql(client)
    command = wrangler_command(args.database, args.environment, statement)
    if not args.execute:
        print("DRY RUN: no client registration or Cloudflare write performed")
        print(f"Would run: {shlex.join(command)}")
        print(statement)
        return 0

    return subprocess.run(command, check=False).returncode


if __name__ == "__main__":
    raise SystemExit(main())
