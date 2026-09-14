#!/usr/bin/env python3
"""Validate non-secret OAuth deployment inputs without contacting Cloudflare."""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from pathlib import Path
from urllib.parse import urlsplit


REQUIRED_KEYS = (
    "COMMUNICATOR_OAUTH_ISSUER",
    "COMMUNICATOR_OAUTH_RESOURCE",
    "COMMUNICATOR_OAUTH_ACCESS_TOKEN_TTL_SECONDS",
    "COMMUNICATOR_OAUTH_HUMAN_AUTHORIZE_URL",
    "COMMUNICATOR_OAUTH_HUMAN_CLIENT_ID",
    "COMMUNICATOR_OAUTH_HUMAN_REDIRECT_URI",
    "COMMUNICATOR_OAUTH_HUMAN_TOKEN_URL",
    "COMMUNICATOR_OAUTH_HUMAN_ISSUER",
    "COMMUNICATOR_OAUTH_HUMAN_JWKS_URL",
)
SECRET_KEYS = {
    "COMMUNICATOR_OAUTH_SIGNING_SECRET",
    "COMMUNICATOR_OAUTH_HUMAN_CLIENT_SECRET",
}
KEY_PATTERN = re.compile(r"^[A-Z][A-Z0-9_]+$")


class ConfigurationError(ValueError):
    """Raised when a deployment input is incomplete or unsafe."""


def parse_env_file(path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    for line_number, raw_line in enumerate(
        path.read_text(encoding="utf-8").splitlines(), 1
    ):
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("export "):
            line = line[7:].lstrip()
        if "=" not in line:
            raise ConfigurationError(f"{path}:{line_number}: expected KEY=VALUE")
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip()
        if not KEY_PATTERN.fullmatch(key):
            raise ConfigurationError(f"{path}:{line_number}: invalid variable name")
        if key in values:
            raise ConfigurationError(f"{path}:{line_number}: duplicate {key}")
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        values[key] = value
    return values


def is_placeholder(value: str) -> bool:
    lowered = value.lower()
    return (
        ".invalid" in lowered
        or ".example" in lowered
        or lowered.startswith("replace-with")
        or "<" in value
        or ">" in value
    )


def require_https(values: dict[str, str], key: str, errors: list[str]) -> None:
    value = values.get(key, "")
    parsed = urlsplit(value)
    if parsed.scheme != "https" or not parsed.netloc:
        errors.append(f"{key} must be an absolute HTTPS URL")
    if parsed.query or parsed.fragment:
        errors.append(f"{key} must not contain a query or fragment")


def validate_redirect(value: str, label: str, errors: list[str]) -> None:
    parsed = urlsplit(value)
    if parsed.scheme != "https" or not parsed.netloc:
        errors.append(f"{label} must be an absolute HTTPS URL")
    if parsed.query or parsed.fragment:
        errors.append(f"{label} must not contain a query or fragment")


def load_client(path: Path) -> dict[str, str]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise ConfigurationError(f"cannot read client JSON: {error}") from error
    if not isinstance(value, dict):
        raise ConfigurationError("client JSON must be an object")
    required = {"client_id", "client_name", "redirect_uri", "status"}
    if set(value) != required:
        raise ConfigurationError(
            "client JSON must contain exactly client_id, client_name, redirect_uri, and status"
        )
    if any(not isinstance(value[key], str) for key in required):
        raise ConfigurationError("client JSON fields must be strings")
    if value["status"] != "active":
        raise ConfigurationError("bootstrap client status must be active")
    return {key: value[key] for key in required}


def validate(
    values: dict[str, str],
    client: dict[str, str],
    environment: str,
    allow_placeholders: bool,
    require_signing_secret: bool,
) -> None:
    errors: list[str] = []
    for key in REQUIRED_KEYS:
        if not values.get(key):
            errors.append(f"missing {key}")

    for key in (
        "COMMUNICATOR_OAUTH_ISSUER",
        "COMMUNICATOR_OAUTH_RESOURCE",
        "COMMUNICATOR_OAUTH_HUMAN_AUTHORIZE_URL",
        "COMMUNICATOR_OAUTH_HUMAN_TOKEN_URL",
        "COMMUNICATOR_OAUTH_HUMAN_ISSUER",
        "COMMUNICATOR_OAUTH_HUMAN_JWKS_URL",
    ):
        require_https(values, key, errors)

    resource = urlsplit(values.get("COMMUNICATOR_OAUTH_RESOURCE", ""))
    if resource.path != "/mcp":
        errors.append("COMMUNICATOR_OAUTH_RESOURCE must end in /mcp")

    issuer = urlsplit(values.get("COMMUNICATOR_OAUTH_ISSUER", ""))
    if issuer.path not in ("", "/"):
        errors.append("COMMUNICATOR_OAUTH_ISSUER must not contain a path")

    redirect = urlsplit(values.get("COMMUNICATOR_OAUTH_HUMAN_REDIRECT_URI", ""))
    validate_redirect(
        values.get("COMMUNICATOR_OAUTH_HUMAN_REDIRECT_URI", ""),
        "COMMUNICATOR_OAUTH_HUMAN_REDIRECT_URI",
        errors,
    )
    if redirect.path != "/oauth/callback" or redirect.query or redirect.fragment:
        errors.append(
            "COMMUNICATOR_OAUTH_HUMAN_REDIRECT_URI must be the exact /oauth/callback URL"
        )

    ttl = values.get("COMMUNICATOR_OAUTH_ACCESS_TOKEN_TTL_SECONDS", "")
    if not ttl.isdigit() or not 60 <= int(ttl or 0) <= 3600:
        errors.append("COMMUNICATOR_OAUTH_ACCESS_TOKEN_TTL_SECONDS must be 60..3600")

    validate_redirect(client["redirect_uri"], "bootstrap client redirect_uri", errors)
    if not client["client_id"].strip() or not client["client_name"].strip():
        errors.append("bootstrap client_id and client_name must be non-empty")

    if environment in {"staging", "production"} and not allow_placeholders:
        checked = list(values.values()) + list(client.values())
        if any(is_placeholder(value) for value in checked):
            errors.append(
                f"{environment} configuration still contains a placeholder; use a reviewed external value"
            )

    for key in SECRET_KEYS:
        if key in values:
            errors.append(f"{key} must be supplied as a Wrangler secret, not in the env file")
    if require_signing_secret:
        secret = os.environ.get("COMMUNICATOR_OAUTH_SIGNING_SECRET", "")
        if len(secret) < 32 or is_placeholder(secret):
            errors.append(
                "COMMUNICATOR_OAUTH_SIGNING_SECRET must be a non-placeholder process secret of at least 32 characters"
            )

    if errors:
        raise ConfigurationError("; ".join(errors))


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Validate OAuth deployment configuration without network or Cloudflare writes"
    )
    parser.add_argument("--env-file", type=Path, required=True)
    parser.add_argument("--client-file", type=Path, required=True)
    parser.add_argument(
        "--environment",
        choices=("local", "staging", "production"),
        default="local",
    )
    parser.add_argument("--allow-placeholders", action="store_true")
    parser.add_argument("--require-signing-secret", action="store_true")
    args = parser.parse_args(argv)
    try:
        values = parse_env_file(args.env_file)
        client = load_client(args.client_file)
        validate(
            values,
            client,
            args.environment,
            args.allow_placeholders,
            args.require_signing_secret,
        )
    except (OSError, ConfigurationError) as error:
        print(f"OAuth configuration invalid: {error}", file=sys.stderr)
        return 2
    print(
        f"OAuth configuration valid for {args.environment}; "
        "no network, secret, client registration, or Cloudflare write performed"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
