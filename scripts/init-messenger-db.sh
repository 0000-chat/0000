#!/usr/bin/env bash
set -euo pipefail

repo_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
runtime_dir=${COMMUNICATOR_RUNTIME_DIR:-/srv/communicator}
project=${COMPOSE_PROJECT_NAME:-communicator}
password_file="${runtime_dir}/secrets/messenger-db.password"
sql_file=$(mktemp "${runtime_dir}/secrets/messenger-db-init.XXXXXX.sql")

cleanup() { rm -f -- "$sql_file"; }
trap cleanup EXIT

[[ "$project" == communicator || "$project" == communicator-restore-test ]]
[[ -f "$password_file" ]]
[[ "$(stat -c '%a' "$password_file")" == 600 ]]
chmod 0600 "$sql_file"

python3 - "$password_file" "$sql_file" <<'PY'
import pathlib
import sys

password = pathlib.Path(sys.argv[1]).read_text().strip()
if not password:
    raise SystemExit("database password is empty")
literal = password.replace("'", "''")
sql = f"""\
\set ON_ERROR_STOP on
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'messenger_bridge') THEN
    CREATE ROLE messenger_bridge LOGIN PASSWORD '{literal}';
  ELSE
    ALTER ROLE messenger_bridge LOGIN PASSWORD '{literal}';
  END IF;
END
$$;
SELECT 'CREATE DATABASE messenger_bridge OWNER messenger_bridge'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'messenger_bridge')\gexec
"""
pathlib.Path(sys.argv[2]).write_text(sql)
PY

cd "$repo_dir"
docker compose --env-file deploy/images.lock.env --project-name "$project" exec -T postgres \
  psql -U synapse -d postgres < "$sql_file" >/dev/null

check=$(docker compose --env-file deploy/images.lock.env --project-name "$project" exec -T postgres \
  psql -At -U synapse -d postgres -c \
  "SELECT (SELECT count(*) FROM pg_roles WHERE rolname='messenger_bridge') || ':' || (SELECT count(*) FROM pg_database WHERE datname='messenger_bridge')")
[[ "$check" == "1:1" ]]
echo "messenger_database=PASS"
