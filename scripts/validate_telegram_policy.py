#!/usr/bin/env python3
import argparse
import json
import pathlib
import re
import sys


class YamlSubsetError(ValueError):
    pass


def split_mapping(content: str) -> tuple[str, str]:
    quote = None
    escaped = False
    for index, character in enumerate(content):
        if quote == '"':
            if escaped:
                escaped = False
            elif character == "\\":
                escaped = True
            elif character == '"':
                quote = None
            continue
        if quote == "'":
            if character == "'":
                if index + 1 < len(content) and content[index + 1] == "'":
                    continue
                quote = None
            continue
        if character in "\"'":
            quote = character
        elif character == ":":
            if index + 1 == len(content) or content[index + 1].isspace():
                return content[:index].strip(), content[index + 1 :].strip()
    raise YamlSubsetError("mapping entry is missing a separator")


def parse_scalar(value: str):
    if value == "null":
        return None
    if value == "true":
        return True
    if value == "false":
        return False
    if value == "[]":
        return []
    if value == "{}":
        return {}
    if value.startswith('"'):
        try:
            parsed = json.loads(value)
        except json.JSONDecodeError as error:
            raise YamlSubsetError("invalid quoted scalar") from error
        if not isinstance(parsed, str):
            raise YamlSubsetError("quoted scalar is not a string")
        return parsed
    if value.startswith("'") and value.endswith("'"):
        return value[1:-1].replace("''", "'")
    if re.fullmatch(r"-?[0-9]+", value):
        return int(value)
    if not value or value.startswith(("[", "{")):
        raise YamlSubsetError("unsupported scalar")
    return value


def parse_key(value: str) -> str:
    parsed = parse_scalar(value)
    if not isinstance(parsed, str):
        raise YamlSubsetError("mapping key is not a string")
    return parsed


def parse_document(content: str):
    rows = []
    for line_number, line in enumerate(content.splitlines(), 1):
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        if "\t" in line:
            raise YamlSubsetError(f"tabs are not allowed on line {line_number}")
        indent = len(line) - len(line.lstrip(" "))
        if indent % 2:
            raise YamlSubsetError(f"indentation is not a multiple of two on line {line_number}")
        rows.append((indent, line[indent:], line_number))

    def parse_block(index: int, indent: int):
        if index >= len(rows) or rows[index][0] != indent:
            raise YamlSubsetError("invalid child indentation")
        is_list = rows[index][1].startswith("- ")
        result = [] if is_list else {}
        while index < len(rows):
            current_indent, text, line_number = rows[index]
            if current_indent < indent:
                break
            if current_indent != indent:
                raise YamlSubsetError(f"unexpected indentation on line {line_number}")
            if is_list:
                if not text.startswith("- "):
                    raise YamlSubsetError(f"mixed list and mapping on line {line_number}")
                remainder = text[2:].strip()
                if not remainder:
                    index += 1
                    if index < len(rows) and rows[index][0] > indent:
                        child_indent = rows[index][0]
                        child, index = parse_block(index, child_indent)
                    else:
                        child = None
                    result.append(child)
                    continue
                if ":" not in remainder:
                    result.append(parse_scalar(remainder))
                    index += 1
                    continue
                key_text, value_text = split_mapping(remainder)
                item = {parse_key(key_text): parse_scalar(value_text)} if value_text else {parse_key(key_text): None}
                index += 1
                if index < len(rows) and rows[index][0] > indent:
                    child_indent = rows[index][0]
                    child, index = parse_block(index, child_indent)
                    if not isinstance(child, dict):
                        raise YamlSubsetError(f"list item child is not a mapping on line {line_number}")
                    if value_text:
                        if set(item) & set(child):
                            raise YamlSubsetError(f"duplicate list item key on line {line_number}")
                        item.update(child)
                    else:
                        item[list(item)[0]] = child
                if len(item) == 1 and list(item.values())[0] is None:
                    item[list(item)[0]] = {}
                result.append(item)
            else:
                if text.startswith("- "):
                    raise YamlSubsetError(f"unexpected list item on line {line_number}")
                key_text, value_text = split_mapping(text)
                key = parse_key(key_text)
                if key in result:
                    raise YamlSubsetError(f"duplicate key on line {line_number}")
                index += 1
                if value_text:
                    result[key] = parse_scalar(value_text)
                elif index < len(rows) and rows[index][0] > indent:
                    child_indent = rows[index][0]
                    result[key], index = parse_block(index, child_indent)
                else:
                    result[key] = {}
        return result, index

    if not rows or rows[0][0] != 0:
        raise YamlSubsetError("document must start at indentation zero")
    document, index = parse_block(0, 0)
    if index != len(rows):
        raise YamlSubsetError("trailing document content")
    if not isinstance(document, dict):
        raise YamlSubsetError("document root is not a mapping")
    return document


def exact_map(value, keys: set[str]) -> bool:
    return isinstance(value, dict) and set(value) == keys


def exact_bool(value, expected: bool) -> bool:
    return type(value) is bool and value is expected


def validate(config: pathlib.Path) -> bool:
    try:
        document = parse_document(config.read_text())
    except (OSError, UnicodeError, YamlSubsetError):
        return False

    top_level = {
        "network", "bridge", "database", "homeserver", "appservice", "matrix",
        "analytics", "provisioning", "public_media", "direct_media", "backfill",
        "double_puppet", "encryption", "env_config_prefix", "logging",
    }
    if not exact_map(document, top_level):
        return False

    network = document["network"]
    if not exact_map(network, {
        "api_id", "api_hash", "member_list", "sync", "takeout",
        "contact_avatars", "contact_names", "disable_view_once", "bridge_communities",
    }):
        return False
    if type(network["api_id"]) is not int or network["api_id"] <= 0:
        return False
    if not isinstance(network["api_hash"], str) or not re.fullmatch(r"[0-9a-fA-F]{32}", network["api_hash"]):
        return False
    if not exact_map(network["member_list"], {"max_initial_sync", "sync_broadcast_channels", "skip_deleted"}):
        return False
    if network["member_list"] != {"max_initial_sync": 0, "sync_broadcast_channels": False, "skip_deleted": True}:
        return False
    if not exact_map(network["sync"], {"update_limit", "create_limit", "login_sync_limit", "direct_chats"}):
        return False
    if network["sync"] != {"update_limit": 0, "create_limit": 0, "login_sync_limit": 0, "direct_chats": True}:
        return False
    if not exact_map(network["takeout"], {"dialog_sync", "forward_backfill", "backward_backfill"}):
        return False
    if network["takeout"] != {"dialog_sync": False, "forward_backfill": False, "backward_backfill": False}:
        return False
    if not exact_bool(network["contact_avatars"], False) or not exact_bool(network["contact_names"], False):
        return False
    if not exact_bool(network["disable_view_once"], True) or not exact_bool(network["bridge_communities"], False):
        return False

    bridge = document["bridge"]
    if not exact_map(bridge, {
        "command_prefix", "personal_filtering_spaces", "private_chat_portal_meta",
        "async_events", "split_portals", "deduplicate_matrix_messages", "kick_matrix_users",
        "enable_send_state_requests", "phone_numbers_in_profile", "cleanup_on_logout",
        "relay", "permissions",
    }):
        return False
    if bridge["command_prefix"] != "!tg":
        return False
    for key in (
        "personal_filtering_spaces", "private_chat_portal_meta", "split_portals",
        "deduplicate_matrix_messages", "kick_matrix_users",
    ):
        if not exact_bool(bridge[key], True):
            return False
    for key in ("async_events", "enable_send_state_requests", "phone_numbers_in_profile"):
        if not exact_bool(bridge[key], False):
            return False
    if not exact_map(bridge["cleanup_on_logout"], {"enabled"}) or not exact_bool(bridge["cleanup_on_logout"]["enabled"], False):
        return False
    if not exact_map(bridge["relay"], {"enabled", "admin_only", "default_relays"}):
        return False
    if bridge["relay"] != {"enabled": False, "admin_only": True, "default_relays": []}:
        return False
    if bridge["permissions"] != {
        "*": "relay",
        "@human:communicator.0000.gold": "user",
        "@platform-admin:communicator.0000.gold": "admin",
    }:
        return False

    database = document["database"]
    if not exact_map(database, {"type", "uri", "max_open_conns", "max_idle_conns"}):
        return False
    if database["type"] != "postgres" or database["max_open_conns"] != 5 or database["max_idle_conns"] != 1:
        return False
    if not isinstance(database["uri"], str) or not re.fullmatch(
        r"postgres://telegram_bridge:[^@\s]+@postgres/telegram_bridge\?sslmode=disable",
        database["uri"],
    ):
        return False

    if document["homeserver"] != {
        "address": "http://synapse:8008",
        "domain": "communicator.0000.gold",
        "software": "standard",
    }:
        return False

    appservice = document["appservice"]
    if not exact_map(appservice, {
        "address", "public_address", "hostname", "port", "id", "bot",
        "as_token", "hs_token", "ephemeral_events", "async_transactions", "username_template",
    }):
        return False
    if appservice["address"] != "http://telegram:29317" or appservice["public_address"] is not None:
        return False
    if appservice["hostname"] != "0.0.0.0" or appservice["port"] != 29317 or appservice["id"] != "telegram":
        return False
    if appservice["bot"] != {"username": "telegrambot"}:
        return False
    if any(not isinstance(appservice[key], str) or not appservice[key] for key in ("as_token", "hs_token")):
        return False
    if not exact_bool(appservice["ephemeral_events"], True) or not exact_bool(appservice["async_transactions"], False):
        return False
    if appservice["username_template"] != "telegram_{{.}}":
        return False

    if document["matrix"] != {"delivery_receipts": True, "federate_rooms": False}:
        return False
    if document["analytics"] != {"token": None}:
        return False
    if document["provisioning"] != {
        "shared_secret": "disable",
        "allow_matrix_auth": False,
        "debug_endpoints": False,
        "enable_session_transfers": False,
    }:
        return False
    if document["public_media"] != {"enabled": False} or document["direct_media"] != {"enabled": False}:
        return False

    backfill = document["backfill"]
    if not exact_map(backfill, {"enabled", "max_initial_messages", "max_catchup_messages", "threads", "queue"}):
        return False
    if backfill["enabled"] is not False or backfill["max_initial_messages"] != 0 or backfill["max_catchup_messages"] != 0:
        return False
    if backfill["threads"] != {"max_initial_messages": 0} or backfill["queue"] != {"enabled": False, "manual": False}:
        return False

    if document["double_puppet"] != {"servers": {}, "allow_discovery": False, "secrets": {}}:
        return False

    encryption = document["encryption"]
    if not exact_map(encryption, {
        "allow", "default", "require", "appservice", "msc4190", "msc4392",
        "self_sign", "allow_key_sharing", "plaintext_mentions", "pickle_key",
    }):
        return False
    if encryption["allow"] is not True or encryption["default"] is not True or encryption["require"] is not True:
        return False
    for key in ("appservice", "msc4190", "msc4392", "self_sign", "plaintext_mentions"):
        if not exact_bool(encryption[key], False):
            return False
    if not exact_bool(encryption["allow_key_sharing"], True):
        return False
    if not isinstance(encryption["pickle_key"], str) or not encryption["pickle_key"]:
        return False

    if document["env_config_prefix"] is not None:
        return False
    logging = document["logging"]
    if not exact_map(logging, {"min_level", "writers"}) or logging["min_level"] != "info":
        return False
    if logging["writers"] != [{"type": "stdout", "format": "pretty-colored"}]:
        return False
    return True


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("config", type=pathlib.Path)
    args = parser.parse_args()
    if not validate(args.config):
        print("Telegram policy validation failed", file=sys.stderr)
        return 1
    print("telegram_policy=PASS")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
