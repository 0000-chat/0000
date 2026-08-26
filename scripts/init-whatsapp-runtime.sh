#!/usr/bin/env bash
set -euo pipefail

repo_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
runtime_dir=${COMMUNICATOR_RUNTIME_DIR:-/srv/communicator}
project=${COMPOSE_PROJECT_NAME:-communicator}
whatsapp_dir="${runtime_dir}/whatsapp"
registration="${whatsapp_dir}/registration.yaml"
config="${whatsapp_dir}/config.yaml"
synapse_registration="${runtime_dir}/synapse/whatsapp-registration.yaml"

cd "$repo_dir"
set -a
source deploy/images.lock.env
set +a
[[ "$project" == communicator ]]
[[ "$WHATSAPP_IMAGE" == dock.mau.dev/mautrix/whatsapp:v26.08@sha256:86237c4d0d33a1e08910b1f820e6c561f9b8e21dc26943caf266e01021087002 ]]
install -d -m 0700 "$whatsapp_dir"

if [[ ! -f "$config" || ! -f "$registration" ]]; then
  docker compose --env-file deploy/images.lock.env --project-name "$project" run --rm --no-deps whatsapp >/dev/null 2>&1
fi
[[ -f "$registration" ]]
python3 scripts/render-whatsapp-config.py \
  --db-password-file "$runtime_dir/secrets/whatsapp-db.password" \
  --output "$config" >/dev/null

chown 1337:1337 "$config" "$whatsapp_dir"
chmod 0600 "$config"
install -o 991 -g 991 -m 0600 "$registration" "$synapse_registration"
echo "whatsapp_runtime=PASS"
