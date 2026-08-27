#!/usr/bin/env bash
set -euo pipefail

repo_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
runtime_dir=${COMMUNICATOR_RUNTIME_DIR:-/srv/communicator}
project=${COMPOSE_PROJECT_NAME:-communicator}
telegram_dir="${runtime_dir}/telegram"
registration="${telegram_dir}/registration.yaml"
config="${telegram_dir}/config.yaml"
synapse_registration="${runtime_dir}/synapse/telegram-registration.yaml"
api_id_file="${runtime_dir}/secrets/telegram-api-id"
api_hash_file="${runtime_dir}/secrets/telegram-api-hash"
db_password_file="${runtime_dir}/secrets/telegram-db.password"

cd "$repo_dir"
set -a
source deploy/images.lock.env
set +a
[[ "$project" == communicator ]]
[[ "$TELEGRAM_IMAGE" == dock.mau.dev/mautrix/telegram:v26.08@sha256:c073961f95aafca58392affcb57ea74364a2d17f018a36d29a208828db8a11e8 ]]

require_secret_file() {
  local file=$1
  [[ -f "$file" ]]
  [[ ! -L "$file" ]]
  [[ "$(stat -c '%a' "$file")" == 600 ]]
  [[ -s "$file" ]]
}

require_secret_file "$api_id_file"
require_secret_file "$api_hash_file"
require_secret_file "$db_password_file"
install -d -m 0700 "$telegram_dir"

if [[ ! -f "$config" ]]; then
  docker compose --env-file deploy/images.lock.env --project-name "$project" run --rm --no-deps telegram >/dev/null 2>&1
fi
python3 scripts/render-telegram-config.py \
  --db-password-file "$db_password_file" \
  --api-id-file "$api_id_file" \
  --api-hash-file "$api_hash_file" \
  --output "$config" >/dev/null

if [[ ! -f "$registration" ]]; then
  docker compose --env-file deploy/images.lock.env --project-name "$project" run --rm --no-deps telegram >/dev/null 2>&1
fi
require_secret_file "$registration"
python3 scripts/render-telegram-config.py \
  --db-password-file "$db_password_file" \
  --api-id-file "$api_id_file" \
  --api-hash-file "$api_hash_file" \
  --registration "$registration" \
  --output "$config" >/dev/null

chown 1337:1337 "$config" "$registration" "$telegram_dir"
chmod 0700 "$telegram_dir"
chmod 0600 "$config" "$registration"
install -o 991 -g 991 -m 0600 "$registration" "$synapse_registration"
echo "telegram_runtime=PASS"
