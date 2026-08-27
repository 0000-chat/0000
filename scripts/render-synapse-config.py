#!/usr/bin/env python3
import argparse
import os
import pathlib
import stat
import string


ROOT = pathlib.Path(__file__).resolve().parents[1]
TEMPLATE = ROOT / "deploy/synapse/homeserver.yaml.template"


def read_env(path: pathlib.Path) -> dict[str, str]:
    values = {}
    for line in path.read_text().splitlines():
        if line and not line.startswith("#"):
            key, value = line.split("=", 1)
            values[key] = value
    return values


def require_registration(path: pathlib.Path, name: str) -> None:
    try:
        metadata = path.lstat()
    except FileNotFoundError as error:
        raise SystemExit(f"{name} registration is missing") from error
    if stat.S_ISLNK(metadata.st_mode) or not stat.S_ISREG(metadata.st_mode):
        raise SystemExit(f"{name} registration must be a regular file")
    if stat.S_IMODE(metadata.st_mode) & 0o077:
        raise SystemExit(f"{name} registration permissions are too broad")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--postgres-env", type=pathlib.Path, required=True)
    parser.add_argument("--registration-secret", type=pathlib.Path, required=True)
    parser.add_argument("--whatsapp-registration", type=pathlib.Path, required=True)
    parser.add_argument("--messenger-registration", type=pathlib.Path, required=True)
    parser.add_argument("--telegram-registration", type=pathlib.Path, required=True)
    parser.add_argument("--output", type=pathlib.Path, required=True)
    args = parser.parse_args()

    require_registration(args.whatsapp_registration, "WhatsApp")
    require_registration(args.messenger_registration, "Messenger")
    require_registration(args.telegram_registration, "Telegram")

    values = read_env(args.postgres_env)
    substitutions = {
        "POSTGRES_PASSWORD": values["POSTGRES_PASSWORD"],
        "REGISTRATION_SHARED_SECRET": args.registration_secret.read_text().strip(),
    }
    rendered = string.Template(TEMPLATE.read_text()).substitute(substitutions)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(rendered)
    os.chmod(args.output, 0o600)
    print(f"rendered {args.output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
