#!/usr/bin/env python3
import argparse
import os
import pathlib
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


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--postgres-env", type=pathlib.Path, required=True)
    parser.add_argument("--registration-secret", type=pathlib.Path, required=True)
    parser.add_argument("--output", type=pathlib.Path, required=True)
    args = parser.parse_args()

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
