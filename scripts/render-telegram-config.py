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
  api_id: {api_id}
  api_hash: {api_hash}
  member_list:
    max_initial_sync: 0
    sync_broadcast_channels: false
    skip_deleted: true
  sync:
    update_limit: 0
    create_limit: 0
    login_sync_limit: 0
    direct_chats: true
  takeout:
    dialog_sync: false
    forward_backfill: false
    backward_backfill: false
  contact_avatars: false
  contact_names: false
  disable_view_once: true
  bridge_communities: false

bridge:
  command_prefix: "!tg"
  personal_filtering_spaces: true
  private_chat_portal_meta: true
  async_events: false
  split_portals: true
  deduplicate_matrix_messages: true
  kick_matrix_users: true
  enable_send_state_requests: false
  phone_numbers_in_profile: false
  cleanup_on_logout:
    enabled: false
  relay:
    enabled: false
    admin_only: true
    default_relays: []
  permissions:
    "*": relay
    "@human:communicator.0000.gold": user
    "@platform-admin:communicator.0000.gold": admin

database:
  type: postgres
  uri: "{database_uri}"
  max_open_conns: 5
  max_idle_conns: 1

homeserver:
  address: http://synapse:8008
  domain: communicator.0000.gold
  software: standard

appservice:
  address: http://telegram:29317
  public_address: null
  hostname: 0.0.0.0
  port: 29317
  id: telegram
  bot:
    username: telegrambot
  as_token: {as_token}
  hs_token: {hs_token}
  ephemeral_events: true
  async_transactions: false
  username_template: "telegram_{{{{.}}}}"

matrix:
  delivery_receipts: true
  federate_rooms: false

analytics:
  token: null

provisioning:
  shared_secret: disable
  allow_matrix_auth: false
  debug_endpoints: false
  enable_session_transfers: false

public_media:
  enabled: false

direct_media:
  enabled: false

backfill:
  enabled: false
  max_initial_messages: 0
  max_catchup_messages: 0
  threads:
    max_initial_messages: 0
  queue:
    enabled: false
    manual: false

double_puppet:
  servers: {{}}
  allow_discovery: false
  secrets: {{}}

encryption:
  allow: true
  default: true
  require: true
  appservice: false
  msc4190: false
  msc4392: false
  self_sign: false
  allow_key_sharing: true
  plaintext_mentions: false
  pickle_key: {pickle_key}

env_config_prefix: null

logging:
  min_level: info
  writers:
    - type: stdout
      format: pretty-colored
"""


def fail(message: str) -> "NoReturn":
    raise SystemExit(message)


def secure_regular_file(path: pathlib.Path, label: str) -> str:
    try:
        metadata = path.lstat()
    except FileNotFoundError:
        fail(f"{label} file is missing")
    except OSError as error:
        fail(f"cannot inspect {label} file: {error}")
    if stat.S_ISLNK(metadata.st_mode):
        fail(f"{label} file must not be a symlink")
    if not stat.S_ISREG(metadata.st_mode):
        fail(f"{label} file must be regular")
    if stat.S_IMODE(metadata.st_mode) & 0o077:
        fail(f"{label} file permissions are too broad")
    try:
        value = path.read_text()
    except OSError as error:
        fail(f"cannot read {label} file: {error}")
    if not value.strip():
        fail(f"{label} file is empty")
    return value.strip()


def read_registration_tokens(path: pathlib.Path) -> dict[str, str]:
    content = secure_regular_file(path, "registration")
    tokens: dict[str, str] = {}
    token_line = re.compile(r"^(as_token|hs_token):\s*(.*?)\s*$")
    for line in content.splitlines():
        match = token_line.fullmatch(line)
        if not match:
            continue
        key, value = match.groups()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        if not value:
            fail("registration token is empty")
        if key in tokens:
            fail("registration token is duplicated")
        tokens[key] = value
    if set(tokens) != {"as_token", "hs_token"}:
        fail("registration tokens are missing")
    return tokens


def read_existing_pickle_key(path: pathlib.Path) -> str:
    try:
        metadata = path.lstat()
    except FileNotFoundError:
        return "generate"
    except OSError as error:
        fail(f"cannot inspect output file: {error}")
    if stat.S_ISLNK(metadata.st_mode) or not stat.S_ISREG(metadata.st_mode):
        fail("existing output file must be regular")
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
            fail("existing encryption pickle key is empty")
        return value
    return "generate"


def yaml_string(value: str) -> str:
    return json.dumps(value, ensure_ascii=False)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--db-password-file", type=pathlib.Path, required=True)
    parser.add_argument("--api-id-file", type=pathlib.Path, required=True)
    parser.add_argument("--api-hash-file", type=pathlib.Path, required=True)
    parser.add_argument("--registration", type=pathlib.Path)
    parser.add_argument("--output", type=pathlib.Path, required=True)
    args = parser.parse_args()

    password = secure_regular_file(args.db_password_file, "database password")
    api_id_text = secure_regular_file(args.api_id_file, "API ID")
    api_hash = secure_regular_file(args.api_hash_file, "API hash")
    if not re.fullmatch(r"[0-9]+", api_id_text):
        fail("API ID must be numeric")
    if not re.fullmatch(r"[0-9a-fA-F]{32}", api_hash):
        fail("API hash has invalid format")

    if args.registration is None:
        tokens = {"as_token": "generate", "hs_token": "generate"}
    else:
        tokens = read_registration_tokens(args.registration)

    pickle_key = read_existing_pickle_key(args.output) if args.output.exists() else "generate"
    database_uri = (
        "postgres://telegram_bridge:"
        + quote(password, safe="")
        + "@postgres/telegram_bridge?sslmode=disable"
    )
    rendered = CONFIG_TEMPLATE.format(
        api_id=int(api_id_text),
        api_hash=yaml_string(api_hash),
        database_uri=database_uri,
        as_token=tokens["as_token"] if tokens["as_token"] == "generate" else yaml_string(tokens["as_token"]),
        hs_token=tokens["hs_token"] if tokens["hs_token"] == "generate" else yaml_string(tokens["hs_token"]),
        pickle_key=yaml_string(pickle_key),
    )

    args.output.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(prefix=f".{args.output.name}.", dir=args.output.parent)
    os.close(descriptor)
    temporary_path = pathlib.Path(temporary)
    try:
        temporary_path.write_text(rendered)
        os.chmod(temporary_path, 0o600)
        os.replace(temporary_path, args.output)
    finally:
        temporary_path.unlink(missing_ok=True)
    print("telegram_config=PASS")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
