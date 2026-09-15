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
    "default_relays": "[]",
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


def parse_permissions(lines: list[str]) -> dict[str, str] | None:
    candidates = []
    for header, child_indent in (("  permissions:", 4), ("    permissions:", 8)):
        block = indented_block(lines, header, child_indent)
        if block is not None:
            candidates.append((block, child_indent))
    if len(candidates) != 1:
        return None
    block, child_indent = candidates[0]
    parsed: dict[str, str] = {}
    pattern = re.compile(
        rf'^{" " * child_indent}("(?:[^"\\]|\\.)*"):\s+(relay|user|admin)$'
    )
    for line in block:
        match = pattern.fullmatch(line)
        if not match:
            return None
        key = json.loads(match.group(1))
        if key in parsed:
            return None
        parsed[key] = match.group(2)
    return parsed


def parse_relay(lines: list[str]) -> dict[str, str] | None:
    candidates = []
    for header, child_indent in (("relay:", 2), ("    relay:", 8)):
        block = indented_block(lines, header, child_indent)
        if block is not None:
            candidates.append((block, child_indent))
    if len(candidates) != 1:
        return None
    block, child_indent = candidates[0]
    parsed: dict[str, str] = {}
    pattern = re.compile(rf'^{" " * child_indent}(enabled|admin_only|default_relays):\s+(.+)$')
    for line in block:
        match = pattern.fullmatch(line)
        if not match:
            continue
        if match.group(1) in parsed:
            return None
        parsed[match.group(1)] = match.group(2)
    if set(parsed) != set(EXPECTED_RELAY):
        return None
    return parsed


def validate(path: pathlib.Path) -> bool:
    if not path.is_file():
        return False
    lines = path.read_text().splitlines()
    bridge = indented_block(lines, "bridge:", 2)
    if bridge is None:
        return False
    return (
        parse_permissions(bridge) == EXPECTED_PERMISSIONS
        and parse_relay(lines) == EXPECTED_RELAY
    )


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("config", type=pathlib.Path)
    args = parser.parse_args()
    if not validate(args.config):
        print("WhatsApp policy validation failed", file=sys.stderr)
        return 1
    print("whatsapp_permissions=PASS")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
