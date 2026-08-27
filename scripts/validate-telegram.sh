#!/usr/bin/env bash
set -euo pipefail

repo_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
runtime_dir=${COMMUNICATOR_RUNTIME_DIR:-/srv/communicator}
project=${COMPOSE_PROJECT_NAME:-communicator}
cd "$repo_dir"
set -a
source deploy/images.lock.env
set +a
export COMMUNICATOR_RUNTIME_DIR="$runtime_dir" COMPOSE_PROJECT_NAME="$project"
[[ "$runtime_dir" == /srv/communicator ]]
[[ "$project" == communicator ]]
[[ "$TELEGRAM_IMAGE" == dock.mau.dev/mautrix/telegram:v26.08@sha256:c073961f95aafca58392affcb57ea74364a2d17f018a36d29a208828db8a11e8 ]]
config="$runtime_dir/telegram/config.yaml"
registration="$runtime_dir/telegram/registration.yaml"

compose=(docker compose --env-file deploy/images.lock.env --project-name "$project")
container_id=$("${compose[@]}" ps -q telegram)
[[ -n "$container_id" ]]
[[ "$(docker inspect --format '{{.Name}}' "$container_id")" == /communicator-telegram-1 ]]
[[ "$(docker inspect --format '{{.Config.Image}}' "$container_id")" == "$TELEGRAM_IMAGE" ]]
[[ "$(docker inspect --format '{{.State.Status}}' "$container_id")" == running ]]
[[ "$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}no-healthcheck{{end}}' "$container_id")" == healthy ]]

runtime_dir_mode() {
  local directory=$1
  [[ -d "$directory" ]]
  [[ ! -L "$directory" ]]
  [[ "$(stat -c '%a' "$directory")" == 700 ]]
}

file_mode() {
  local file=$1
  [[ -f "$file" ]]
  [[ ! -L "$file" ]]
  [[ "$(stat -c '%a' "$file")" == 600 ]]
}

runtime_dir_mode "$runtime_dir/telegram"
for file in \
  "$config" \
  "$registration" \
  "$runtime_dir/synapse/telegram-registration.yaml" \
  "$runtime_dir/secrets/telegram-api-id" \
  "$runtime_dir/secrets/telegram-api-hash" \
  "$runtime_dir/secrets/telegram-db.password" \
  "$runtime_dir/secrets/telegram-db.env"; do
  file_mode "$file"
done

python3 scripts/validate_telegram_policy.py "$config" >/dev/null
"${compose[@]}" exec -T postgres psql -At -U synapse -d telegram_bridge -c \
  "SELECT CASE WHEN count(*) > 0 THEN 'PASS' ELSE 'FAIL' END FROM information_schema.tables WHERE table_schema='public'" \
  | grep -qx PASS
"${compose[@]}" exec -T synapse \
  python -c 'import urllib.request; urllib.request.urlopen("http://telegram:29317/_matrix/mau/ready", timeout=3)' \
  >/dev/null

published_ports=$(docker inspect --format '{{json .NetworkSettings.Ports}}' "$container_id")
[[ "$published_ports" == "{}" || "$published_ports" == "null" ]]
if ss -H -ltn | awk '{print $4}' | grep -Eq ':(5432|8008|8448|29317|29318|29319|2019)$'; then
  echo "private service port is published" >&2
  exit 1
fi
if grep -Eq 'telegram|29317' deploy/caddy/Caddyfile; then
  echo "Telegram has a public Caddy route" >&2
  exit 1
fi

echo "telegram_container=running"
echo "telegram_health=healthy"
echo "telegram_ports=NONE"
echo "telegram_public_route=NONE"
echo "telegram_validation=PASS"
