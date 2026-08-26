#!/usr/bin/env python3
import argparse
import json
import pathlib
import re
import sys


EXPECTED_PERMISSIONS = {
    "*": "relay",
    "@human:communicator.0000.gold": "user",
    "@agent:communicator.0000.gold": "user",
    "@platform-admin:communicator.0000.gold": "admin",
}
EXPECTED_RELAY = {
    "enabled": "false",
    "admin_only": "true",
    "prefer_default": "true",
    "allow_bridge": "false",
    "default_relays": "[]",
}
ALLOWED_RELAY_FIELDS = set(EXPECTED_RELAY) | {
    "user_distinguishers",
    "message_formats",
    "displayname_format",
}


def indented_block(lines: list[str], header: str, child_indent: int) -> list[str] | None:
    matches = [index for index, line in enumerate(lines) if line == header]
    if len(matches) != 1:
        return None
    block: list[str] = []
    for line in lines[matches[0] + 1 :]:
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        indent = len(line) - len(line.lstrip(" "))
        if indent < child_indent:
            break
        block.append(line)
    return block


def exact_scalar(block: list[str], key: str) -> str | None:
    indents = [
        len(line) - len(line.lstrip(" "))
        for line in block
        if line.strip() and not line.lstrip().startswith("#")
    ]
    if not indents:
        return None
    child_indent = min(indents)
    pattern = re.compile(rf"^{re.escape(' ' * child_indent)}{re.escape(key)}:\s+(.+)$")
    values = [match.group(1) for line in block if (match := pattern.fullmatch(line))]
    return values[0] if len(values) == 1 else None


def nested_block(lines: list[str], key: str) -> tuple[list[str], int] | None:
    matches = [
        (index, len(line) - len(line.lstrip(" ")))
        for index, line in enumerate(lines)
        if line.strip() == f"{key}:" and line.startswith(" ")
    ]
    if len(matches) != 1:
        return None
    index, header_indent = matches[0]
    block: list[str] = []
    for line in lines[index + 1 :]:
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        indent = len(line) - len(line.lstrip(" "))
        if indent <= header_indent:
            break
        block.append(line)
    indents = [len(line) - len(line.lstrip(" ")) for line in block]
    if not indents:
        return None
    return block, min(indents)


def parse_permissions(lines: list[str]) -> dict[str, str] | None:
    nested = nested_block(lines, "permissions")
    if nested is None:
        return None
    block, child_indent = nested
    parsed: dict[str, str] = {}
    pattern = re.compile(
        rf'^{re.escape(" " * child_indent)}("(?:[^"\\]|\\.)*"):\s+(relay|user|admin)$'
    )
    for line in block:
        if len(line) - len(line.lstrip(" ")) != child_indent:
            return None
        match = pattern.fullmatch(line)
        if not match:
            return None
        key = json.loads(match.group(1))
        if key in parsed:
            return None
        parsed[key] = match.group(2)
    return parsed


def parse_relay(lines: list[str]) -> dict[str, str] | None:
    nested = nested_block(lines, "relay")
    if nested is None:
        return None
    block, child_indent = nested
    parsed: dict[str, str] = {}
    pattern = re.compile(rf"^{re.escape(' ' * child_indent)}([a-z_]+):\s+(.+)$")
    for line in block:
        if len(line) - len(line.lstrip(" ")) != child_indent:
            continue
        match = pattern.fullmatch(line)
        if not match or match.group(1) in parsed:
            return None
        parsed[match.group(1)] = match.group(2)
    return parsed


def validate(path: pathlib.Path) -> bool:
    if not path.is_file():
        return False
    lines = path.read_text().splitlines()
    bridge = indented_block(lines, "bridge:", 2)
    if bridge is None:
        return False
    relay = parse_relay(bridge)
    return (
        parse_permissions(bridge) == EXPECTED_PERMISSIONS
        and relay is not None
        and set(relay) <= ALLOWED_RELAY_FIELDS
        and all(relay.get(key) == value for key, value in EXPECTED_RELAY.items())
        and exact_scalar(bridge, "split_portals") == "true"
    )


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("config", type=pathlib.Path)
    args = parser.parse_args()
    if not validate(args.config):
        print("Messenger policy validation failed", file=sys.stderr)
        return 1
    print("messenger_policy=PASS")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
