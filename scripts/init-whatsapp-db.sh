#!/usr/bin/env bash
set -euo pipefail

repo_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
runtime_dir=${COMMUNICATOR_RUNTIME_DIR:-/srv/communicator}
project=${COMPOSE_PROJECT_NAME:-communicator}
password_file="${runtime_dir}/secrets/whatsapp-db.password"
sql_file=$(mktemp "${runtime_dir}/secrets/whatsapp-db-init.XXXXXX.sql")

cleanup() {
  rm -f -- "$sql_file"
}
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
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'whatsapp_bridge') THEN
    CREATE ROLE whatsapp_bridge LOGIN PASSWORD '{literal}';
  ELSE
    ALTER ROLE whatsapp_bridge LOGIN PASSWORD '{literal}';
  END IF;
END
$$;
SELECT 'CREATE DATABASE whatsapp_bridge OWNER whatsapp_bridge'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'whatsapp_bridge')\gexec
"""
pathlib.Path(sys.argv[2]).write_text(sql)
PY

cd "$repo_dir"
docker compose --env-file deploy/images.lock.env --project-name "$project" exec -T postgres \
  psql -U synapse -d postgres < "$sql_file" >/dev/null

check=$(docker compose --env-file deploy/images.lock.env --project-name "$project" exec -T postgres \
  psql -At -U synapse -d postgres -c \
  "SELECT (SELECT count(*) FROM pg_roles WHERE rolname='whatsapp_bridge') || ':' || (SELECT count(*) FROM pg_database WHERE datname='whatsapp_bridge')")
[[ "$check" == "1:1" ]]
echo "whatsapp_database=PASS"
