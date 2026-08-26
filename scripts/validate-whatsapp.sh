#!/usr/bin/env bash
set -euo pipefail

repo_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
runtime_dir=${COMMUNICATOR_RUNTIME_DIR:-/srv/communicator}
project=${COMPOSE_PROJECT_NAME:-communicator}
cd "$repo_dir"
export COMMUNICATOR_RUNTIME_DIR="$runtime_dir" COMPOSE_PROJECT_NAME="$project"
[[ "$runtime_dir" == /srv/communicator ]]
[[ "$project" == communicator ]]

compose=(docker compose --env-file deploy/images.lock.env --project-name "$project")
container_id=$("${compose[@]}" ps -q whatsapp)
[[ -n "$container_id" ]]
container_status=$(docker inspect --format '{{.State.Status}}' "$container_id")
health_status=$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}no-healthcheck{{end}}' "$container_id")
[[ "$container_status" == running ]]
[[ "$health_status" == healthy ]]
"${compose[@]}" exec -T whatsapp curl -fsS http://127.0.0.1:29318/_matrix/mau/live >/dev/null
"${compose[@]}" exec -T whatsapp curl -fsS http://127.0.0.1:29318/_matrix/mau/ready >/dev/null

registration="$runtime_dir/synapse/whatsapp-registration.yaml"
[[ -f "$registration" ]]
[[ "$(stat -c '%a' "$registration")" == 600 ]]
[[ "$(stat -c '%u:%g' "$registration")" == 991:991 ]]
config="$runtime_dir/whatsapp/config.yaml"
[[ -f "$config" ]]
[[ "$(stat -c '%a' "$config")" == 600 ]]
python3 scripts/validate_whatsapp_policy.py "$config"
published_ports=$(docker inspect --format '{{json .NetworkSettings.Ports}}' "$container_id")
[[ "$published_ports" == "{}" || "$published_ports" == "null" ]]
if ss -H -ltn | awk '{print $4}' | grep -Eq ':(5432|8008|8448|29318|2019)$'; then
  echo "private service port is published" >&2
  exit 1
fi

echo "whatsapp_container=running"
echo "whatsapp_health=healthy"
echo "whatsapp_ready=PASS"
echo "whatsapp_ports=NONE"
echo "whatsapp_registration=PASS"
echo "whatsapp_history_sync=DISABLED"
echo "whatsapp_provisioning=DISABLED"
