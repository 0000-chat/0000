#!/usr/bin/env python3
import argparse
import json
import os
import pathlib
import re
import stat
import tempfile
from urllib.parse import quote


CONFIG_TEMPLATE = """network:
  os_name: Mautrix-WhatsApp bridge
  browser_name: unknown

appservice:
  address: http://whatsapp:29318
  public_address: null
  hostname: 0.0.0.0
  port: 29318
  id: whatsapp
  bot:
    username: whatsappbot
  as_token: {as_token}
  hs_token: {hs_token}

database:
  type: postgres
  uri: "{database_uri}"

homeserver:
  address: http://synapse:8008
  domain: communicator.0000.gold
  software: standard

bridge:
  split_portals: false
  personal_filtering_spaces: true
  permissions:
    "*": relay
    "@human:communicator.0000.gold": user
    "@agent:communicator.0000.gold": user
    "@platform-admin:communicator.0000.gold": admin

relay:
  enabled: false
  admin_only: true
  default_relays: []

provisioning:
  shared_secret: disable
  allow_matrix_auth: false
  debug_endpoints: false
  enable_session_transfers: false

public_media:
  enabled: false

direct_media:
  enabled: false

history_sync:
  max_initial_conversations: 0
  request_full_sync: false

backfill:
  enabled: false
  max_initial_messages: 0
  max_catchup_messages: 0
  queue:
    enabled: false
    manual: false

encryption:
  allow: true
  default: true
  require: true
  appservice: false
  msc4190: false
  pickle_key: {pickle_key}
"""


def read_registration_tokens(path: pathlib.Path) -> dict[str, str]:
    if not path.is_file():
        raise SystemExit("registration file is missing")
    if stat.S_IMODE(path.stat().st_mode) & 0o077:
        raise SystemExit("registration file permissions are too broad")

    tokens: dict[str, str] = {}
    token_line = re.compile(r"^(as_token|hs_token):\s*(.*?)\s*$")
    for line in path.read_text().splitlines():
        match = token_line.fullmatch(line)
        if not match:
            continue
        key, value = match.groups()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        if not value:
            raise SystemExit("registration token is empty")
        tokens[key] = value

    if set(tokens) != {"as_token", "hs_token"}:
        raise SystemExit("registration tokens are missing")
    return tokens


def read_existing_pickle_key(path: pathlib.Path) -> str:
    if not path.is_file():
        return "generate"

    in_encryption = False
    pickle_line = re.compile(r"^\s+pickle_key:\s*(.*?)\s*$")
    for line in path.read_text().splitlines():
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        if not line.startswith((" ", "\t")):
            in_encryption = line.split(":", 1)[0].strip() == "encryption"
            continue
        if not in_encryption:
            continue
        match = pickle_line.fullmatch(line)
        if not match:
            continue
        value = match.group(1)
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        if not value:
            raise SystemExit("existing encryption pickle key is empty")
        return value
    return "generate"


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--db-password-file", type=pathlib.Path, required=True)
    parser.add_argument("--registration", type=pathlib.Path, required=True)
    parser.add_argument("--output", type=pathlib.Path, required=True)
    args = parser.parse_args()

    password_path = args.db_password_file
    if not password_path.is_file():
        raise SystemExit("database password file is missing")
    if stat.S_IMODE(password_path.stat().st_mode) & 0o077:
        raise SystemExit("database password file permissions are too broad")
    password = password_path.read_text().strip()
    if not password:
        raise SystemExit("database password file is empty")
    tokens = read_registration_tokens(args.registration)
    pickle_key = read_existing_pickle_key(args.output)

    database_uri = (
        "postgres://whatsapp_bridge:"
        + quote(password, safe="")
        + "@postgres/whatsapp_bridge?sslmode=disable"
    )
    rendered = CONFIG_TEMPLATE.format(
        database_uri=database_uri,
        as_token=json.dumps(tokens["as_token"]),
        hs_token=json.dumps(tokens["hs_token"]),
        pickle_key=json.dumps(pickle_key),
    )
    args.output.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(
        prefix=f".{args.output.name}.", dir=args.output.parent
    )
    os.close(descriptor)
    temporary_path = pathlib.Path(temporary)
    try:
        temporary_path.write_text(rendered)
        os.chmod(temporary_path, 0o600)
        os.replace(temporary_path, args.output)
    finally:
        temporary_path.unlink(missing_ok=True)
    print(f"rendered {args.output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
