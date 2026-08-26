#!/usr/bin/env bash
set -euo pipefail

repo_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
runtime_dir=${COMMUNICATOR_RUNTIME_DIR:-/srv/communicator}
project=${COMPOSE_PROJECT_NAME:-communicator}
password_file="${runtime_dir}/secrets/telegram-db.password"
[[ "$project" == communicator || "$project" == communicator-restore-test || "$project" == communicator-restore-test-* ]]
[[ -f "$password_file" ]]
[[ "$(stat -c '%a' "$password_file")" == 600 ]]
password=$(<"$password_file")
[[ -n "$password" ]]
escaped_password=${password//\'/\'\'}
sql_file=$(mktemp)
trap 'rm -f -- "$sql_file"' EXIT
chmod 0600 "$sql_file"
cat > "$sql_file" <<SQL
SELECT 'CREATE ROLE telegram_bridge LOGIN PASSWORD ''${escaped_password}'''
WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'telegram_bridge')\gexec
ALTER ROLE telegram_bridge LOGIN PASSWORD '${escaped_password}';
SELECT 'CREATE DATABASE telegram_bridge OWNER telegram_bridge'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'telegram_bridge')\gexec
SQL
cd "$repo_dir"
docker compose --env-file deploy/images.lock.env --project-name "$project" exec -T postgres \
  psql -U synapse -d postgres < "$sql_file" >/dev/null
check=$(docker compose --env-file deploy/images.lock.env --project-name "$project" exec -T postgres \
  psql -At -U synapse -d postgres -c \
  "SELECT (SELECT count(*) FROM pg_roles WHERE rolname='telegram_bridge') || ':' || (SELECT count(*) FROM pg_database WHERE datname='telegram_bridge')")
[[ "$check" == "1:1" ]]
echo "telegram_database=PASS"
