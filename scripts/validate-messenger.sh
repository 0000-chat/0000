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
container_id=$("${compose[@]}" ps -q messenger)
[[ "$container_id" =~ ^[0-9a-f]{12,64}$ ]]
container_status=$(docker inspect --format '{{.State.Status}}' "$container_id")
health_status=$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}no-healthcheck{{end}}' "$container_id")
[[ "$container_status" == running ]]
[[ "$health_status" == healthy ]]

"${compose[@]}" exec -T messenger curl -fsS http://127.0.0.1:29319/_matrix/mau/live >/dev/null
"${compose[@]}" exec -T messenger curl -fsS http://127.0.0.1:29319/_matrix/mau/ready >/dev/null

config="$runtime_dir/messenger/config.yaml"
bridge_registration="$runtime_dir/messenger/registration.yaml"
registration="$runtime_dir/synapse/messenger-registration.yaml"
[[ -f "$config" ]]
[[ "$(stat -c '%a' "$config")" == 600 ]]
[[ -f "$bridge_registration" ]]
[[ "$(stat -c '%a' "$bridge_registration")" == 600 ]]
[[ -f "$registration" ]]
[[ "$(stat -c '%a' "$registration")" == 600 ]]
python3 scripts/validate_messenger_policy.py "$config" >/dev/null

"${compose[@]}" exec -T messenger yq -e \
  '.encryption.allow == true and
   .encryption.default == true and
   .encryption.require == true and
   .matrix.federate_rooms == false and
   .matrix.provisioning.shared_secret == "disable" and
   .matrix.provisioning.allow_matrix_auth == false and
   .matrix.public_media.enabled == false and
   .matrix.direct_media.enabled == false and
   .bridge.split_portals == true and
   .bridge.relay.enabled == false and
   .backfill.enabled == false' \
  /data/config.yaml >/dev/null

if ss -H -ltn | awk '{print $4}' | grep -Eq ':(5432|8008|8448|29319|2019)$'; then
  echo "private service port is published" >&2
  exit 1
fi

echo "messenger_container=running"
echo "messenger_health=healthy"
echo "messenger_live=PASS"
echo "messenger_ready=PASS"
echo "messenger_ports=NONE"
echo "messenger_registration=PASS"
echo "messenger_policy=PASS"
echo "messenger_backfill=DISABLED"
echo "messenger_provisioning=DISABLED"
